import { PermissionPolicy } from './permissions/policy.js'
import { TonyAgent, type TonyAgentOptions } from './agent.js'
import { SessionStore } from './session/store.js'
import { deriveMessages, assertModelVisibleIsLogged } from './session/log.js'
import { ToolRegistry } from './tools/registry.js'
import type { SessionQueryEngine } from './query/engine.js'
import { createQueryTools, createGraphTools } from './query/plugin.js'
import type { GraphExtractor } from './query/extractor.js'
import type { LLMCompleter, LLMMessage, PermissionRequest, PermissionResolution, SessionInfo, AgentEvent } from './types.js'
import type { PageAdapter } from './host/adapter.js'

export interface TonyRuntimeOptions {
  store: SessionStore
  llm: LLMCompleter
  registry: ToolRegistry
  permissions?: PermissionPolicy
  systemPrompt?: string
  adapter?: PageAdapter
  resolvePermission?: (request: PermissionRequest) => Promise<PermissionResolution> | PermissionResolution
  onEvent?: (event: AgentEvent) => void
  limits?: TonyAgentOptions['limits']
  /** Session-query engine — when present, `query:search` is registered into the runtime registry. */
  queryEngine?: SessionQueryEngine
  /** Graph extractor — when present, `query:graph` is registered into the runtime registry (v0.6). */
  graphExtractor?: GraphExtractor
}

export interface TonySession {
  readonly id: string
  readonly info: SessionInfo
  readonly agent: TonyAgent
  ask(prompt: string, signal?: AbortSignal, callbacks?: { onTextDelta?: (delta: string) => void }): ReturnType<TonyAgent['run']>
  history(): LLMMessage[]
  reset(): Promise<void>
  rename(name: string): Promise<TonySession>
  branch(name?: string, parentEntryId?: string): Promise<TonySession>
  compact(summary: string, keepRecentEntries?: number): Promise<void>
}

export class TonyRuntime {
  private readonly sessions = new Map<string, TonySession>()
  private readonly permissions: PermissionPolicy

  constructor(private readonly options: TonyRuntimeOptions) {
    this.permissions = options.permissions ?? new PermissionPolicy()
    // Session-query wiring: mount `query:search` into the shared registry.
    if (options.queryEngine) {
      for (const tool of createQueryTools(options.queryEngine, 'query_search')) {
        if (!options.registry.has(tool.name)) options.registry.register(tool)
      }
    }
    // Graph wiring: mount `query:graph` into the shared registry (v0.6).
    if (options.queryEngine) {
      for (const tool of createGraphTools(options.queryEngine, 'query_graph')) {
        if (!options.registry.has(tool.name)) options.registry.register(tool)
      }
    }
  }

  async createSession(name = 'New session'): Promise<TonySession> {
    const info = await this.options.store.create(name)
    return this.hydrate(info)
  }

  async openSession(id: string): Promise<TonySession> {
    const info = await this.options.store.get(id)
    if (!info) throw new Error(`Unknown session: ${id}`)
    return this.hydrate(info)
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.options.store.list()
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id)
    await this.options.store.delete(id)
  }

  private async hydrate(info: SessionInfo): Promise<TonySession> {
    const existing = this.sessions.get(info.id)
    if (existing) return existing
    const entries = await this.options.store.readEntries(info.id)
    const history = deriveMessages(entries)
    const agent = new TonyAgent({
      llm: this.options.llm,
      registry: this.options.registry,
      permissions: this.permissions,
      sessionId: info.id,
      systemPrompt: this.options.systemPrompt,
      history,
      adapter: this.options.adapter,
      resolvePermission: this.options.resolvePermission,
      onEvent: this.options.onEvent,
      limits: this.options.limits,
    })
    const session: TonySession = {
      id: info.id,
      info,
      agent,
      ask: async (prompt, signal, callbacks) => {
        const completion = await agent.run(prompt, signal, callbacks)
        await this.persistMessages(info.id, prompt, completion.messages, history.length)
        history.splice(0, history.length, ...completion.messages)
        return completion
      },
      history: () => agent.history,
      reset: async () => {
        const current = await this.options.store.readEntries(info.id)
        await this.options.store.compact(info.id, 'Session reset by user.', current.length > 0 ? [current.at(-1)!.id] : [])
        const refreshed = await this.options.store.readEntries(info.id)
        agent.setHistory(deriveMessages(refreshed))
        history.splice(0, history.length, ...deriveMessages(refreshed))
      },
      rename: async (name) => this.hydrate(await this.options.store.rename(info.id, name)),
      branch: async (name, parentEntryId) => this.hydrate(await this.options.store.branch(info.id, parentEntryId, name)),
      compact: async (summary, keepRecentEntries = 8) => {
        const entries = await this.options.store.readEntries(info.id)
        const keep = entries.slice(-keepRecentEntries).map((entry) => entry.id)
        await this.options.store.compact(info.id, summary, keep)
        const refreshed = await this.options.store.readEntries(info.id)
        const refreshedMessages = deriveMessages(refreshed)
        agent.setHistory(refreshedMessages)
        history.splice(0, history.length, ...refreshedMessages)
      },
    }
    this.sessions.set(info.id, session)
    return session
  }

  private async persistMessages(sessionId: string, prompt: string, messages: LLMMessage[], previousLength: number): Promise<void> {
    const appended = messages.slice(previousLength)
    if (appended.length === 0) return
    for (const message of appended) {
      if (message.role === 'assistant') {
        await this.options.store.append(sessionId, { role: 'assistant', content: message.content, toolCalls: message.toolCalls })
      } else if (message.role === 'tool') {
        await this.options.store.append(sessionId, {
          role: 'tool',
          content: message.content,
          toolCallId: message.toolCallId,
          toolName: message.name,
        })
      } else if (message.role === 'system') {
        await this.options.store.append(sessionId, { role: 'system', content: message.content })
      } else if (message.role === 'user') {
        await this.options.store.append(sessionId, { role: 'user', content: message.content })
      }
    }
  }
}

