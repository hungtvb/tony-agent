import { SubagentRegistry, SubagentRequest, SubagentResult, createInProcessSubagentProvider } from '../subagent/registry.js'
import type { GraphRouter, GraphRoute } from './router.js'

/** Thrown when a script violates workflow limits/contracts. */
export class WorkflowError extends Error {
  readonly code: string
  readonly fatal: boolean
  constructor(code: string, message: string, fatal = true) {
    super(message)
    this.name = 'WorkflowError'
    this.code = code
    this.fatal = fatal
  }
}

/** Context handed to a workflow script. */
export interface WorkflowContext {
  agent(request: SubagentRequest): Promise<SubagentResult>
  /** Graph routing (v0.7): advisory entity/session/recommendation info. Cached per run. */
  route(query: string, opts?: { sessionId?: string; limit?: number }): Promise<GraphRoute>
  /** Route-informed fan-out (v0.7): one subagent per top entity, prompt template uses {entity}. */
  routeAgents(query: string, template: string, opts?: { sessionId?: string; limit?: number }): Promise<SubagentResult[]>
  log(message: string): void
}

export type WorkflowScript = (ctx: WorkflowContext) => Promise<unknown> | unknown

export interface WorkflowRun {
  /** Promise that never rejects: resolves with result. */
  result: Promise<WorkflowResult>
  cancel(reason?: string): void
}

export interface WorkflowResult {
  value: unknown
  stopReason: 'completed' | 'error' | 'cancelled'
  agentsStarted: number
  error?: string
}

export interface WorkflowEngineOptions {
  /** Subagent registry used to spawn children. */
  registry: SubagentRegistry
  /** Default provider name. */
  provider?: string
  /** Max child agents a single run may start. */
  maxTotalAgents?: number
  /** Optional GraphRouter — enables ctx.route() (v0.7). */
  router?: GraphRouter
  /** Session id for lineage-aware routing. */
  sessionId?: string
  /** Log sink for ctx.log() (default: console.log). */
  log?: (message: string) => void
}

/**
 * Workflow engine (dsh-style `ctx.workflowEngine`): executes a model-written
 * orchestration script that can fan out subagents via `ctx.agent(...)`.
 * `WorkflowRun.result` never rejects — failures resolve with `stopReason:
 * 'error'`, cancellation with `'cancelled'`.
 */
export class WorkflowEngine {
  private readonly registry: SubagentRegistry
  private readonly provider: string
  private readonly maxTotalAgents: number
  private readonly router: GraphRouter | undefined
  private readonly sessionId: string | undefined
  private readonly log: (message: string) => void

  constructor(options: WorkflowEngineOptions) {
    this.registry = options.registry
    this.provider = options.provider ?? 'in-process'
    this.maxTotalAgents = options.maxTotalAgents ?? 10
    this.router = options.router
    this.sessionId = options.sessionId
    this.log = options.log ?? ((message) => console.log(message))
    if (!this.registry.list().includes(this.provider)) {
      throw new WorkflowError('PROVIDER_UNAVAILABLE', `Workflow provider not registered: ${this.provider}`)
    }
  }

  start(script: WorkflowScript | string, meta: { args?: unknown } = {}): WorkflowRun {
    let cancelled = false
    let cancelReason = ''
    let agentsStarted = 0
    const routeCache = new Map<string, GraphRoute>()

    const runPromise = (async (): Promise<WorkflowResult> => {
      try {
        let fn: WorkflowScript
        if (typeof script === 'string') {
          fn = this.compileScript(script)
        } else {
          fn = script
        }
        const ctx: WorkflowContext = {
          agent: async (request) => {
            if (cancelled) throw new WorkflowError('CANCELLED', cancelReason || 'workflow cancelled')
            if (agentsStarted >= this.maxTotalAgents) {
              throw new WorkflowError('AGENT_CAP', `AGENT_CAP: maxTotalAgents (${this.maxTotalAgents}) exceeded`)
            }
            agentsStarted += 1
            return this.registry.start(this.provider, request)
          },
          route: async (query, routeOpts) => {
            if (!this.router) throw new WorkflowError('ROUTER_UNAVAILABLE', 'ROUTER_UNAVAILABLE: no GraphRouter configured')
            const key = `${query}|${routeOpts?.sessionId ?? this.sessionId ?? ''}`
            const cached = routeCache.get(key)
            if (cached) return cached
            const route = this.router.route(query, {
              sessionId: routeOpts?.sessionId ?? this.sessionId,
              ...(routeOpts?.limit ? { limit: routeOpts.limit } : {}),
            })
            routeCache.set(key, route)
            return route
          },
          routeAgents: async (query, template, routeOpts) => {
            const route = await ctx.route(query, routeOpts)
            const results: SubagentResult[] = []
            for (const entity of route.entities.slice(0, 3)) {
              const prompt = template.split('{entity}').join(entity.name)
              const result = await ctx.agent({ prompt })
              results.push(result)
            }
            return results
          },
          log: (message) => this.log(message),
        }
        const value = await fn(ctx)
        return { value, stopReason: 'completed', agentsStarted }
      } catch (error) {
        if (error instanceof WorkflowError && error.code === 'CANCELLED') {
          return { value: null, stopReason: 'cancelled', agentsStarted, error: error.message }
        }
        const message = error instanceof Error ? error.message : String(error)
        return { value: null, stopReason: 'error', agentsStarted, error: message }
      }
    })()

    return {
      result: runPromise,
      cancel: (reason = 'cancelled by caller') => {
        cancelled = true
        cancelReason = reason
      },
    }
  }

  private compileScript(source: string): WorkflowScript {
    // The script is expected to be a JS function body; wrap in a function to
    // keep it serializable. It runs in this process with access to the ctx.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function('ctx', `"use strict"; return (async (ctx) => { ${source} })(ctx)`) as unknown as (ctx: WorkflowContext) => Promise<unknown>
    return (ctx) => factory(ctx)
  }
}

/** Quick helper to create a subagent + workflow engine in one shot. */
export function createSubagentWorkflow(options: {
  complete: (request: { messages: import('../llm/model.js').SimpleMessage[]; tools?: import('../llm/model.js').ToolDefinition[] }, opts: import('../llm/model.js').SimpleStreamOptions) => Promise<import('../llm/model.js').SimpleResult>
  tools?: Map<string, import('../types.js').TonyTool>
  systemPrompt?: string
  maxTotalAgents?: number
  log?: (message: string) => void
}) {
  const registry = new SubagentRegistry()
  registry.register(createInProcessSubagentProvider({
    complete: options.complete,
    tools: options.tools,
    systemPrompt: options.systemPrompt,
  }))
  const engine = new WorkflowEngine({ registry, provider: 'in-process', maxTotalAgents: options.maxTotalAgents, ...(options.log ? { log: options.log } : {}) })
  return { registry, engine }
}