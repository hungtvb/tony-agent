import { randomUUID } from 'node:crypto'
import { PermissionPolicy } from './permissions/policy.js'
import { ToolRegistry } from './tools/registry.js'
import type {
  AgentEvent,
  AgentLimits,
  AgentRunResult,
  BrowserTab,
  LLMCompleter,
  LLMMessage,
  PermissionRequest,
  PermissionResolution,
  ToolCall,
  ToolContext,
} from './types.js'
import { getSiteFromUrl, type PageAdapter } from './host/adapter.js'
import type { GraphContextBuilder } from './query/graph-context.js'

const DEFAULT_LIMITS: AgentLimits = {
  maxTurns: 24,
  maxToolCalls: 64,
  maxToolCallsPerTurn: 8,
  timeoutMs: 180_000,
}

export interface TonyAgentOptions {
  llm: LLMCompleter
  registry: ToolRegistry
  permissions: PermissionPolicy
  sessionId?: string
  systemPrompt?: string
  limits?: Partial<AgentLimits>
  adapter?: PageAdapter
  site?: string
  history?: LLMMessage[]
  resolvePermission?: (request: PermissionRequest) => Promise<PermissionResolution> | PermissionResolution
  onEvent?: (event: AgentEvent) => void
  /** Graph recall builder — when present, injects a per-turn context block (v0.6.1). */
  graphContext?: GraphContextBuilder
}

function now(): number { return Date.now() }

function toToolMessage(call: ToolCall, content: string, isError?: boolean): LLMMessage {
  return {
    role: 'tool',
    content: isError ? `ERROR: ${content}` : content,
    name: call.name,
    toolCallId: call.id,
  }
}

function actionKey(call: ToolCall): string {
  return `${call.name}:${JSON.stringify(call.arguments)}`
}

function abortError(): Error {
  return new DOMException('The agent run was aborted', 'AbortError')
}

export type AgentCompletion = AgentRunResult

/** Self-built bounded agent loop with streaming callbacks. No agent harness dependency. */
export class TonyAgent {
  private readonly llm: LLMCompleter
  private readonly registry: ToolRegistry
  private readonly permissions: PermissionPolicy
  private readonly sessionId: string
  private readonly systemPrompt?: string
  private readonly limits: AgentLimits
  private readonly adapter?: PageAdapter
  private readonly site?: string
  private readonly resolvePermission?: TonyAgentOptions['resolvePermission']
  private readonly onEvent?: TonyAgentOptions['onEvent']
  private readonly graphContext?: GraphContextBuilder
  private readonly steering: string[] = []
  private activeAbort?: AbortController
  private conversation: LLMMessage[]
  private running = false

  constructor(options: TonyAgentOptions) {
    this.llm = options.llm
    this.registry = options.registry
    this.permissions = options.permissions
    this.sessionId = options.sessionId ?? `session-${randomUUID()}`
    this.systemPrompt = options.systemPrompt
    this.limits = { ...DEFAULT_LIMITS, ...options.limits }
    this.adapter = options.adapter
    this.site = options.site
    this.resolvePermission = options.resolvePermission
    this.onEvent = options.onEvent
    this.graphContext = options.graphContext
    this.conversation = withSystemPrompt(options.history ?? [], this.systemPrompt)
  }

  get id(): string { return this.sessionId }

  get history(): LLMMessage[] { return cloneMessages(this.conversation) }

  setHistory(history: LLMMessage[]): void {
    if (this.running) throw new Error('Cannot replace history while Tony Agent is running')
    this.conversation = withSystemPrompt(history, this.systemPrompt)
  }

  reset(): void {
    this.conversation = withSystemPrompt([], this.systemPrompt)
    this.steering.length = 0
  }

  steer(message: string): void {
    const trimmed = message.trim()
    if (trimmed) this.steering.push(trimmed)
  }

  abort(): void {
    this.activeAbort?.abort()
  }

  get activeTab(): Promise<BrowserTab | undefined> {
    return this.adapter?.getActiveTab() ?? Promise.resolve(undefined)
  }

  async run(
    prompt: string,
    signal?: AbortSignal,
    callbacks?: { onTextDelta?: (delta: string) => void },
  ): Promise<AgentCompletion> {
    if (this.running) throw new Error('Tony Agent is already running a turn')
    this.running = true
    const events: AgentEvent[] = []
    const emit = (event: AgentEvent) => { events.push(event); this.onEvent?.(event) }
    const controller = new AbortController()
    this.activeAbort = controller
    const relayAbort = () => controller.abort()
    signal?.addEventListener('abort', relayAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(), this.limits.timeoutMs)
    const messages = cloneMessages(this.conversation)
    messages.push({ role: 'user', content: prompt })
    let turns = 0
    let totalToolCalls = 0
    let finalText = ''
    const seenActions = new Map<string, number>()

    emit({ type: 'agent_start', sessionId: this.sessionId, prompt, timestamp: now() })
    try {
      while (turns < this.limits.maxTurns) {
        if (controller.signal.aborted) throw abortError()
        turns += 1
        emit({ type: 'turn_start', sessionId: this.sessionId, turn: turns, timestamp: now() })
        while (this.steering.length > 0) {
          const steering = this.steering.shift()
          if (steering) messages.push({ role: 'user', content: steering })
        }

        // Graph recall (v0.6.1): inject a per-turn context block when the
        // builder is present. Ephemeral — the block is passed to the LLM via
        // a SEPARATE request array so it never lands in the persisted
        // conversation/history.
        let requestMessages = messages
        if (this.graphContext) {
          const recentAssistant = messages.filter((m) => m.role === 'assistant').slice(-2).map((m) => m.content)
          const recall = await this.graphContext.build(prompt, recentAssistant, {
            // NOTE: no sessionId — auto-recall searches ACROSS sessions so a
            // newly created session can still retrieve prior knowledge.
            maxMessages: messages.length,
          })
          if (recall) requestMessages = [...messages, recall.message]
        }

        const response = await this.llm.complete({
          messages: requestMessages,
          tools: this.registry.definitions({ presentation: 'native' }),
          signal: controller.signal,
        }, {
          onTextDelta: (delta) => {
            callbacks?.onTextDelta?.(delta)
            emit({ type: 'message_update', sessionId: this.sessionId, delta, timestamp: now() })
          },
        })
        finalText = response.text
        messages.push({ role: 'assistant', content: response.text, ...(response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}) })

        if (response.toolCalls.length === 0) {
          emit({ type: 'turn_end', sessionId: this.sessionId, turn: turns, timestamp: now() })
          emit({ type: 'agent_end', sessionId: this.sessionId, text: finalText, timestamp: now() })
          const result = { sessionId: this.sessionId, text: finalText, turns, toolCalls: totalToolCalls, events, messages: cloneMessages(messages) }
          this.conversation = cloneMessages(messages)
          return result
        }

        if (response.toolCalls.length > this.limits.maxToolCallsPerTurn) {
          const message = `Stopped: tool-call limit per turn (${this.limits.maxToolCallsPerTurn}) exceeded.`
          messages.push(toToolMessage({ id: 'guard', name: 'tony_guard', arguments: {} }, message, true))
          finalText = message
          emit({ type: 'turn_end', sessionId: this.sessionId, turn: turns, timestamp: now() })
          continue
        }

        for (const call of response.toolCalls) {
          if (controller.signal.aborted) throw abortError()
          totalToolCalls += 1
          emit({ type: 'tool_call', sessionId: this.sessionId, call, timestamp: now() })
          if (totalToolCalls > this.limits.maxToolCalls) {
            const message = `Stopped: total tool-call limit (${this.limits.maxToolCalls}) exceeded.`
            messages.push(toToolMessage(call, message, true))
            finalText = message
            break
          }

          const tool = this.registry.get(call.name)
          if (!tool) {
            const result = { content: `Unknown tool: ${call.name}`, isError: true }
            messages.push(toToolMessage(call, result.content, true))
            emit({ type: 'tool_result', sessionId: this.sessionId, call, result, timestamp: now() })
            continue
          }
          const site = this.site ?? (await this.resolveSite(call.name))
          const decision = this.permissions.check(tool, site, this.sessionId)
          let allowed = decision === 'allow'
          if (decision === 'confirm') {
            const request: PermissionRequest = {
              requestId: `permission-${randomUUID()}`,
              tool,
              arguments: call.arguments,
              sessionId: this.sessionId,
              ...(site ? { site } : {}),
            }
            emit({ type: 'permission_request', sessionId: this.sessionId, request, timestamp: now() })
            const resolution = this.resolvePermission ? await this.resolvePermission(request) : 'deny'
            allowed = resolution === 'allow-once' || resolution === 'allow-session'
            if (resolution === 'allow-session' || resolution === 'deny') this.permissions.remember(this.sessionId, tool.name, site, resolution)
          }

          let result
          if (!allowed) {
            result = { content: `Permission denied for tool ${call.name}.`, isError: true }
          } else if (seenActions.has(actionKey(call))) {
            result = { content: `Repeated tool call detected for ${call.name}; stopped to prevent a loop.`, isError: true }
          } else {
            seenActions.set(actionKey(call), turns)
            const context: ToolContext = {
              signal: controller.signal,
              sessionId: this.sessionId,
              presentation: 'native',
              ...(site ? { site } : {}),
              adapter: this.adapter,
              metadata: {},
            }
            result = await this.registry.execute(call.name, call.arguments, context)
          }
          messages.push(toToolMessage(call, result.content, result.isError))
          emit({ type: 'tool_result', sessionId: this.sessionId, call, result, timestamp: now() })
        }
        emit({ type: 'turn_end', sessionId: this.sessionId, turn: turns, timestamp: now() })
      }

      finalText = `Stopped: maximum turn limit (${this.limits.maxTurns}) reached.`
      emit({ type: 'agent_end', sessionId: this.sessionId, text: finalText, timestamp: now() })
      const result = { sessionId: this.sessionId, text: finalText, turns, toolCalls: totalToolCalls, events, messages: cloneMessages(messages) }
      this.conversation = cloneMessages(messages)
      return result
    } catch (error) {
      this.conversation = cloneMessages(messages)
      const message = error instanceof Error ? error.message : String(error)
      emit({ type: 'error', sessionId: this.sessionId, error: message, timestamp: now() })
      throw error
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', relayAbort)
      if (this.activeAbort === controller) this.activeAbort = undefined
      this.running = false
    }
  }

  private async resolveSite(_toolName: string): Promise<string | undefined> {
    if (this.site) return this.site
    if (!this.adapter) return undefined
    return getSiteFromUrl(await this.adapter.getCurrentUrl())
  }
}

export function defaultAgentLimits(): AgentLimits {
  return { ...DEFAULT_LIMITS }
}

function cloneMessages(messages: LLMMessage[]): LLMMessage[] {
  return messages.map((message) => ({
    ...message,
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map((call) => ({ ...call, arguments: { ...call.arguments } })) } : {}),
  }))
}

function withSystemPrompt(history: LLMMessage[], systemPrompt: string | undefined): LLMMessage[] {
  const messages = cloneMessages(history)
  if (!systemPrompt) return messages
  if (messages[0]?.role === 'system' && messages[0].content === systemPrompt) return messages
  return [{ role: 'system', content: systemPrompt }, ...messages]
}
