import { SubagentRegistry, SubagentRequest, SubagentResult, createInProcessSubagentProvider } from '../subagent/registry.js'

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

  constructor(options: WorkflowEngineOptions) {
    this.registry = options.registry
    this.provider = options.provider ?? 'in-process'
    this.maxTotalAgents = options.maxTotalAgents ?? 10
    if (!this.registry.list().includes(this.provider)) {
      throw new WorkflowError('PROVIDER_UNAVAILABLE', `Workflow provider not registered: ${this.provider}`)
    }
  }

  start(script: WorkflowScript | string, meta: { args?: unknown } = {}): WorkflowRun {
    let cancelled = false
    let cancelReason = ''
    let agentsStarted = 0

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
          log: () => {},
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
}) {
  const registry = new SubagentRegistry()
  registry.register(createInProcessSubagentProvider({
    complete: options.complete,
    tools: options.tools,
    systemPrompt: options.systemPrompt,
  }))
  const engine = new WorkflowEngine({ registry, provider: 'in-process', maxTotalAgents: options.maxTotalAgents })
  return { registry, engine }
}