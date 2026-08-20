import type { SimpleMessage, SimpleResult, SimpleStreamOptions, ToolDefinition, Usage } from '../llm/model.js'
import type { GraphContextBuilder } from '../query/graph-context.js'
import type { JsonSchema, TonyTool, ToolCall } from '../types.js'
import { AgentMessage } from './messages.js'
import type { ApprovalProvider } from '../approval/provider.js'
import type { ToolScope } from '../tools/scope.js'

export type AgentEventType =
  | 'agent_start'
  | 'run_start'
  | 'turn_start'
  | 'stream_assistant'
  | 'tool_started'
  | 'tool_result'
  | 'turn_end'
  | 'agent_end'
  | 'run_end'

export interface AgentEvent {
  type: AgentEventType
  sessionId?: string
  runId?: string
  turnId?: number
  text?: string
  toolCall?: ToolCall
  toolResult?: { toolCallId: string; content: string; isError?: boolean }
  usage?: Usage
  error?: unknown
  aborted?: boolean
}

export type EventHandler = (event: AgentEvent) => void

export interface AgentHooks {
  beforeToolCall?: (call: ToolCall, context: { sessionId: string }) => Promise<void> | void
  afterToolCall?: (call: ToolCall, result: { content: string; isError?: boolean }, context: { sessionId: string }) => Promise<void> | void
  shouldStopAfterTurn?: (context: { turnId: number }) => Promise<boolean> | boolean
  prepareNextTurn?: (context: { turnId: number }) => Promise<void> | void
  transformContext?: (context: { messages: SimpleMessage[]; sessionId: string }) => Promise<SimpleMessage[]> | SimpleMessage[]
}

export type PendingMessageQueueOptions = { type: 'one-at-a-time' } | { type: 'all' }

export interface AgentOptions {
  complete: (request: { messages: SimpleMessage[]; tools?: ToolDefinition[] }, options: SimpleStreamOptions) => Promise<SimpleResult>
  tools?: Map<string, TonyTool>
  hooks?: AgentHooks
  toolBatchMode?: 'sequential' | 'parallel'
  maxTurns?: number
  maxToolCalls?: number
  sessionId?: string
  systemPrompt?: string
  stream?: (delta: string) => void
  /** Approval seam — when absent, confirm-decisions are not asked and the tool is denied. */
  approval?: ApprovalProvider
  /** Per-agent tool visibility mask — shadows the global tool map without mutating it. */
  scope?: ToolScope
  /** Graph recall builder — when present, injects a per-turn context block via transformContext (v0.6.1). */
  graphContext?: GraphContextBuilder
}

export interface RunOutcome {
  text: string
  toolCalls: number
  turns: number
  aborted: boolean
  usage?: Usage
}

interface PendingMessage {
  text: string
  message: AgentMessage
}

const EVENT_ORDER: AgentEventType[] = ['agent_start', 'run_start', 'turn_start', 'stream_assistant', 'tool_started', 'tool_result', 'turn_end', 'agent_end', 'run_end']

/**
 * Stateful agent harness mirroring pi-agent-core's `Agent`:
 * owns a transcript, emits lifecycle events, supports steering/follow-up
 * queues, hooks, sequential or parallel tool batches, and abort.
 */
export class Agent {
  private readonly complete: AgentOptions['complete']
  private readonly tools: Map<string, TonyTool>
  private readonly hooks: AgentHooks
  private readonly toolBatchMode: 'sequential' | 'parallel'
  private readonly maxTurns: number
  private readonly maxToolCalls: number
  private readonly sessionId: string
  private readonly systemPrompt?: string
  private readonly stream?: (delta: string) => void
  private readonly approval?: ApprovalProvider
  private readonly scope?: ToolScope

  private readonly handlers: EventHandler[] = []
  private transcript: AgentMessage[] = []
  private pendingQueue: PendingMessage[] = []
  private pendingMode: PendingMessageQueueOptions = { type: 'one-at-a-time' }
  private aborted = false
  private activeRun: Promise<RunOutcome> | null = null

  constructor(options: AgentOptions) {
    this.complete = options.complete
    this.tools = options.tools ?? new Map()
    this.toolBatchMode = options.toolBatchMode ?? 'sequential'
    this.maxTurns = options.maxTurns ?? 10
    this.maxToolCalls = options.maxToolCalls ?? 50
    this.sessionId = options.sessionId ?? 'session'
    this.systemPrompt = options.systemPrompt
    this.stream = options.stream
    this.approval = options.approval
    this.scope = options.scope
    // Graph recall: compose a transformContext hook that appends the recall
    // block to the final messages. Honors a caller-provided hook by running
    // it first (the recall block is appended after).
    if (options.graphContext) {
      const baseTransform = options.hooks?.transformContext
      this.hooks = {
        ...(options.hooks ?? {}),
        transformContext: async (ctx) => {
          const messages = baseTransform ? await baseTransform(ctx) : ctx.messages
          const userMessage = messages.filter((m) => m.role === 'user').at(-1)
          const userContent = userMessage ? (typeof userMessage.content === 'string' ? userMessage.content : '') : ''
          const recentAssistant = messages
            .filter((m) => m.role === 'assistant')
            .slice(-2)
            .map((m) => (typeof m.content === 'string' ? m.content : ''))
          const recall = await options.graphContext!.build(userContent, recentAssistant, {
            sessionId: ctx.sessionId,
            maxMessages: messages.length,
          })
          return recall
            ? [...messages, { role: recall.message.role, content: recall.message.content } as SimpleMessage]
            : messages
        },
      }
    } else {
      this.hooks = options.hooks ?? {}
    }
  }

  on(handler: EventHandler): void
  on(eventName: 'event', handler: EventHandler): void
  on(eventNameOrHandler: 'event' | EventHandler, maybeHandler?: EventHandler): void {
    if (typeof eventNameOrHandler === 'function') {
      this.handlers.push(eventNameOrHandler)
    } else if (maybeHandler) {
      this.handlers.push(maybeHandler)
    }
  }

  private emit(event: AgentEvent): void {
    for (const handler of this.handlers) handler(event)
  }

  getTranscript(): AgentMessage[] {
    return this.transcript
  }

  setTranscript(messages: AgentMessage[]): void {
    this.transcript = [...messages]
  }

  steer(text: string): void {
    this.pendingQueue.push({ text, message: AgentMessage.from('user', { content: text }) })
  }

  followUp(generator: () => string): void {
    this.pendingQueue.push({ text: generator(), message: AgentMessage.from('user', { content: generator() }) })
  }

  abort(): void {
    this.aborted = true
  }

  async run(userInput: string, options: PendingMessageQueueOptions = { type: 'one-at-a-time' }): Promise<RunOutcome> {
    if (this.activeRun) return this.activeRun
    this.pendingMode = options
    this.aborted = false
    this.pendingQueue = [{ text: userInput, message: AgentMessage.from('user', { content: userInput }) }]
    this.emit({ type: 'agent_start', sessionId: this.sessionId })
    this.emit({ type: 'run_start', sessionId: this.sessionId })
    const runId = crypto.randomUUID()
    this.activeRun = this.loop(runId).finally(() => {
      this.activeRun = null
      this.emit({ type: 'run_end', sessionId: this.sessionId, runId })
    })
    return this.activeRun
  }

  private async loop(runId: string): Promise<RunOutcome> {
    let turns = 0
    let toolCalls = 0
    let totalUsage: Usage | undefined
    let finalText = ''

    while (!this.aborted) {
      turns += 1
      if (turns > this.maxTurns) break
      this.emit({ type: 'turn_start', sessionId: this.sessionId, runId, turnId: turns })

      // drain one or all pending messages depending on mode
      const toProcess = this.pendingMode.type === 'all' ? this.pendingQueue.splice(0) : this.pendingQueue.splice(0, 1)
      for (const pending of toProcess) {
        this.transcript.push(pending.message)
      }
      const wireMessages = AgentMessage.toWire(this.transcript)

      const hookContext = { sessionId: this.sessionId }
      let finalMessages = wireMessages
      if (this.hooks.transformContext) {
        finalMessages = await this.hooks.transformContext({ messages: finalMessages, sessionId: this.sessionId })
      }
      if (this.systemPrompt && finalMessages[0]?.role !== 'system') {
        finalMessages = [{ role: 'system', content: this.systemPrompt }, ...finalMessages]
      }

      const visibleTools = this.scope ? this.scope.filter(Array.from(this.tools)) : Array.from(this.tools)
      // native presentation: code-only tools are hidden from the model
      const nativeTools = visibleTools.filter(([, tool]) => (tool.presentation ?? 'both') !== 'code')
      const toolDefs: ToolDefinition[] = nativeTools.map(([name, tool]) => ({
        type: 'function',
        function: { name, description: tool.description, parameters: tool.parameters },
      }))

      const streamOptions: SimpleStreamOptions = {
        sessionId: this.sessionId,
        signal: this.abortSignal(),
      }
      if (this.stream) streamOptions.onTextDelta = this.stream

      const result: SimpleResult = await this.complete({ messages: finalMessages, tools: toolDefs.length > 0 ? toolDefs : undefined }, streamOptions)
      if (result.usage) {
        totalUsage = {
          input: (totalUsage?.input ?? 0) + result.usage.input,
          output: (totalUsage?.output ?? 0) + result.usage.output,
          cacheRead: (totalUsage?.cacheRead ?? 0) + result.usage.cacheRead,
          cacheWrite: (totalUsage?.cacheWrite ?? 0) + result.usage.cacheWrite,
          totalTokens: (totalUsage?.totalTokens ?? 0) + result.usage.totalTokens,
        }
      }

      if (result.text) {
        finalText = result.text
        this.transcript.push(AgentMessage.from('assistant', { content: [{ type: 'text', text: result.text }], toolCalls: result.toolCalls ?? [], usage: result.usage, stopReason: result.stopReason }))
        this.emit({ type: 'stream_assistant', sessionId: this.sessionId, runId, turnId: turns, text: result.text, usage: result.usage })
      }

      // execute tool calls
      if (result.toolCalls && result.toolCalls.length > 0) {
        if (result.stopReason === 'length') {
          // truncated tool call — do not execute
          this.transcript.push(AgentMessage.from('toolResult', { toolCallId: result.toolCalls[0]?.id ?? 'unknown', name: result.toolCalls[0]?.name ?? 'unknown', content: 'Tool call truncated (length stop). Not executed.', isError: true }))
          break
        }
        const incoming = result.toolCalls.length
        const budgetLeft = this.maxToolCalls - toolCalls
        if (incoming > budgetLeft) {
          // execute only what fits the remaining budget; answer the rest with a
          // toolResult so the transcript stays balanced (no dangling toolCall)
          const toExecute = result.toolCalls.slice(0, budgetLeft)
          const skipped = result.toolCalls.slice(budgetLeft)
          for (const call of skipped) {
            this.transcript.push(AgentMessage.from('toolResult', { toolCallId: call.id, name: call.name, content: 'Tool call not executed: max tool calls reached.', isError: true }))
          }
          if (toExecute.length > 0) {
            toolCalls += toExecute.length
            if (this.toolBatchMode === 'parallel') {
              await this.executeParallel(toExecute, runId, turns)
            } else {
              for (const call of toExecute) {
                if (this.aborted) break
                await this.executeSingle(call, runId, turns)
              }
            }
          }
          this.emit({ type: 'turn_end', sessionId: this.sessionId, runId, turnId: turns })
          break
        }
        toolCalls += incoming

        if (this.toolBatchMode === 'parallel') {
          await this.executeParallel(result.toolCalls, runId, turns)
        } else {
          for (const call of result.toolCalls) {
            if (this.aborted) break
            await this.executeSingle(call, runId, turns)
          }
        }
      } else {
        // no tools this turn — agent turn complete unless pending
        this.emit({ type: 'turn_end', sessionId: this.sessionId, runId, turnId: turns })
        if (this.hooks.shouldStopAfterTurn && (await this.hooks.shouldStopAfterTurn({ turnId: turns }))) break
        if (this.pendingQueue.length === 0) break
      }
    }

    this.emit({ type: 'agent_end', sessionId: this.sessionId, runId, aborted: this.aborted })
    return { text: finalText, toolCalls, turns, aborted: this.aborted, usage: totalUsage }
  }

  private abortSignal(): AbortSignal {
    const controller = new AbortController()
    const poll = setInterval(() => {
      if (this.aborted) controller.abort()
    }, 50)
    // clear the poll as soon as the signal fires OR after a bounded window —
    // never leave intervals alive for the life of the process
    const cleanup = (): void => clearInterval(poll)
    controller.signal.addEventListener('abort', cleanup, { once: true })
    setTimeout(cleanup, 1000 * 60 * 2)
    return controller.signal
  }

  private async executeSingle(call: ToolCall, runId: string, turnId: number): Promise<void> {
    const tool = this.scope ? this.scope.resolve(call.name, (name) => this.tools.get(name)) : this.tools.get(call.name)
    this.emit({ type: 'tool_started', sessionId: this.sessionId, runId, turnId, toolCall: call })
    if (!tool) {
      const result = { content: `Unknown tool: ${call.name}`, isError: true }
      this.transcript.push(AgentMessage.from('toolResult', { toolCallId: call.id, name: call.name, content: result.content, isError: true }))
      this.emit({ type: 'tool_result', sessionId: this.sessionId, runId, turnId, toolResult: { toolCallId: call.id, content: result.content, isError: true } })
      return
    }
    // approval seam: confirm-decisions need a mounted provider; without one the
    // call degrades to deny (fail-closed), mirroring the dsh approval degrade.
    if (tool.risk === 'risky') {
      const resolution = this.approval
        ? await this.approval.resolve({
            requestId: `permission-${crypto.randomUUID()}`,
            tool,
            arguments: typeof call.arguments === 'string' ? (JSON.parse(call.arguments) as Record<string, unknown>) : call.arguments,
            sessionId: this.sessionId,
          })
        : 'deny'
      if (resolution !== 'allow-once' && resolution !== 'allow-session') {
        const result = { content: `Permission denied for tool ${call.name}.`, isError: true }
        this.transcript.push(AgentMessage.from('toolResult', { toolCallId: call.id, name: call.name, content: result.content, isError: true }))
        this.emit({ type: 'tool_result', sessionId: this.sessionId, runId, turnId, toolResult: { toolCallId: call.id, content: result.content, isError: true } })
        return
      }
    }
    if (this.hooks.beforeToolCall) await this.hooks.beforeToolCall(call, { sessionId: this.sessionId })
    let result: { content: string; isError?: boolean }
    try {
      const args = typeof call.arguments === 'string' ? (JSON.parse(call.arguments) as Record<string, unknown>) : call.arguments
      const toolResult = await tool.execute(args, { signal: this.abortSignal(), sessionId: this.sessionId, presentation: 'native', metadata: {} })
      result = { content: toolResult.content, isError: toolResult.isError }
    } catch (error) {
      result = { content: `Tool error: ${String(error)}`, isError: true }
    }
    if (this.hooks.afterToolCall) await this.hooks.afterToolCall(call, result, { sessionId: this.sessionId })
    this.transcript.push(AgentMessage.from('toolResult', { toolCallId: call.id, name: call.name, content: result.content, isError: result.isError }))
    this.emit({ type: 'tool_result', sessionId: this.sessionId, runId, turnId, toolResult: { toolCallId: call.id, content: result.content, isError: result.isError } })
  }

  private async executeParallel(calls: ToolCall[], runId: string, turnId: number): Promise<void> {
    await Promise.all(calls.map((call) => this.executeSingle(call, runId, turnId)))
  }
}

void EVENT_ORDER
