import { Agent } from '../harness/agent.js'
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
}

/** Result of a finished subagent run. */
export interface SubagentResult {
  childId: string
  text: string
  toolCalls: number
  turns: number
  aborted: boolean
}

/** A subagent provider: executes a delegation; may run in/out of process. */
export interface SubagentProvider {
  readonly name: string
  start(request: SubagentRequest): Promise<SubagentResult>
}

/** Context needed to build an in-process child agent. */
export interface InProcessSubagentOptions {
  complete: (request: { messages: SimpleMessage[]; tools?: ToolDefinition[] }, options: SimpleStreamOptions) => Promise<SimpleResult>
  tools?: Map<string, TonyTool>
  systemPrompt?: string
}

/**
 * In-process subagent provider: spawns a child `Agent` in the same process
 * with an isolated transcript/session, sharing the parent's LLM completer
 * and (optionally filtered) tool set.
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
      const outcome = await child.run(request.prompt)
      return {
        childId: childSessionId,
        text: outcome.text,
        toolCalls: outcome.toolCalls,
        turns: outcome.turns,
        aborted: outcome.aborted,
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