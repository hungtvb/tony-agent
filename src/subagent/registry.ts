import { Agent } from '../harness/agent.js'
import { AgentMessage } from '../harness/messages.js'
import { deriveMessages } from '../session/log.js'
import type { TonyTool } from '../types.js'
import type { SimpleMessage, SimpleResult, SimpleStreamOptions, ToolDefinition } from '../llm/model.js'

/** One subagent delegation request. */
export interface SubagentRequest {
  /** Prompt/task for the child agent. */
  prompt: string
  /** Cap the child's tool calls. */
  maxToolCalls?: number
  /** Restrict the child to these tool names only. */
  toolFilter?: string[]
  /** Optional child session id (defaults to a fresh uuid). */
  sessionId?: string
  /** When true, try to resume an existing persisted session for sessionId. */
  resume?: boolean
}

/** Result of a finished subagent run. */
export interface SubagentResult {
  childId: string
  text: string
  toolCalls: number
  turns: number
  aborted: boolean
  /** True when the run continued an existing transcript (cold resume). */
  resumed?: boolean
}

/** A subagent provider: executes a delegation; may run in/out of process. */
export interface SubagentProvider {
  readonly name: string
  start(request: SubagentRequest): Promise<SubagentResult>
}

/** Async loader of a persisted session's entries (JSONL/SQLite adapter). */
export type SessionEntriesLoader = (sessionId: string) => Promise<unknown[]>

/** Context needed to build an in-process child agent. */
export interface InProcessSubagentOptions {
  complete: (request: { messages: SimpleMessage[]; tools?: ToolDefinition[] }, options: SimpleStreamOptions) => Promise<SimpleResult>
  tools?: Map<string, TonyTool>
  systemPrompt?: string
  /** Optional loader of persisted session entries; enables cold resume. */
  loadSessionEntries?: SessionEntriesLoader
}

/**
 * In-process subagent provider: spawns a child `Agent` in the same process
 * with an isolated transcript/session, sharing the parent's LLM completer
 * and (optionally filtered) tool set. When cold resume is enabled and the
 * session already exists, the child CONTINUES from the persisted transcript
 * (entries → deriveMessages → wire → AgentMessage[]) instead of starting
 * from scratch — the durable session log stays the single source of truth.
 */
export function createInProcessSubagentProvider(options: InProcessSubagentOptions): SubagentProvider {
  return {
    name: 'in-process',
    async start(request) {
      const tools = options.tools
        ? new Map(Array.from(options.tools).filter(([name]) => !request.toolFilter || request.toolFilter.includes(name)))
        : new Map<string, TonyTool>()
      const childSessionId = request.sessionId ?? `sub-${crypto.randomUUID()}`
      const child = new Agent({
        complete: options.complete,
        tools,
        sessionId: childSessionId,
        systemPrompt: options.systemPrompt,
        maxToolCalls: request.maxToolCalls ?? 30,
      })
      let resumed = false
      if (request.resume && options.loadSessionEntries && request.sessionId) {
        const entries = await options.loadSessionEntries(request.sessionId)
        if (entries.length > 0) {
          const wire = deriveMessages(entries as Parameters<typeof deriveMessages>[0])
          child.setTranscript(AgentMessage.fromWire(wire as SimpleMessage[]))
          resumed = true
        }
      }
      const outcome = await child.run(request.prompt)
      return {
        childId: childSessionId,
        text: outcome.text,
        toolCalls: outcome.toolCalls,
        turns: outcome.turns,
        aborted: outcome.aborted,
        ...(resumed ? { resumed: true } : {}),
      }
    },
  }
}

/**
 * Subagent registry (dsh-style seam): named providers + a single start() API.
 * A deployment mounts zero or more providers; absence of a provider for a
 * requested name rejects the delegation.
 */
export class SubagentRegistry {
  private readonly providers = new Map<string, SubagentProvider>()

  register(provider: SubagentProvider): () => void {
    if (!provider?.name) throw new Error('Subagent provider must have a name')
    if (this.providers.has(provider.name)) throw new Error(`Subagent provider already registered: ${provider.name}`)
    this.providers.set(provider.name, provider)
    return () => this.providers.delete(provider.name)
  }

  list(): string[] {
    return Array.from(this.providers.keys())
  }

  start(name: string, request: SubagentRequest): Promise<SubagentResult> {
    const provider = this.providers.get(name)
    if (!provider) throw new Error(`Unknown subagent provider: ${name} (have: ${this.list().join(', ') || 'none'})`)
    return provider.start(request)
  }
}