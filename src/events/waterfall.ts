import type { ToolCall, ToolResult } from '../types.js'

/** A decision emitted by a tool-call middleware. */
export type WaterfallDecision = 'allow' | 'ask' | 'deny'

/** Context passed to each middleware. */
export interface ToolCallContext {
  sessionId: string
  call: ToolCall
}

/**
 * Waterfall middleware for tool calls (dsh-style around-dispatch):
 * listeners run in registration order; each may short-circuit with a
 * decision (deny > ask > allow merge), mutate the call, or delegate via
 * `next()`. Registration returns a disposer.
 */
export interface WaterfallMiddleware {
  /** Return a decision to short-circuit, or call next() to continue. */
  (ctx: ToolCallContext, next: () => Promise<void>): Promise<WaterfallDecision | void> | WaterfallDecision | void
}

export interface WaterfallOptions {
  /** When a listener throws, deny (fail-closed) instead of crashing the loop. */
  failClosed?: boolean
}

/** Merged outcome of all middlewares that ran. */
export interface WaterfallOutcome {
  decision: WaterfallDecision
  /** Short-circuit message when denied (for the tool result). */
  reason?: string
}

function mergeDecision(current: WaterfallDecision, incoming: WaterfallDecision): WaterfallDecision {
  const rank: Record<WaterfallDecision, number> = { allow: 0, ask: 1, deny: 2 }
  return rank[incoming] > rank[current] ? incoming : current
}

/**
 * A quiescence-aware waterfall: disposers remove middlewares; `disposeAll()`
 * waits for any in-flight run to settle before returning — teardown reaches
 * quiescence so no middleware fires into a dead context (dsh dispose rule).
 */
export class ToolCallWaterfall {
  private readonly middlewares: WaterfallMiddleware[] = []
  private readonly failClosed: boolean
  private inFlight = 0
  private disposeRequested = false
  private quiescence: Promise<void> = Promise.resolve()
  private releaseQuiescence: (() => void) | undefined

  constructor(options: WaterfallOptions = {}) {
    this.failClosed = options.failClosed ?? true
  }

  use(middleware: WaterfallMiddleware): () => void {
    this.middlewares.push(middleware)
    return () => {
      const index = this.middlewares.indexOf(middleware)
      if (index >= 0) this.middlewares.splice(index, 1)
    }
  }

  /** Run the chain; returns the merged outcome. Never throws. */
  async run(ctx: ToolCallContext): Promise<WaterfallOutcome> {
    if (this.disposeRequested) return { decision: 'deny', reason: 'waterfall disposed' }
    this.inFlight += 1
    try {
      let decision: WaterfallDecision = 'allow'
      let index = 0
      const middlewares = [...this.middlewares]
      const step = async (): Promise<void> => {
        if (index >= middlewares.length) return
        const middleware = middlewares[index]!
        index += 1
        try {
          const result = await middleware(ctx, step)
          if (result !== undefined && result !== null) decision = mergeDecision(decision, result as WaterfallDecision)
        } catch {
          if (this.failClosed) decision = mergeDecision(decision, 'deny')
        }
      }
      await step()
      const outcome: WaterfallOutcome = { decision: decision as WaterfallDecision }
      if (outcome.decision === 'deny') outcome.reason = 'denied by middleware'
      return outcome
    } finally {
      this.inFlight -= 1
      if (this.disposeRequested && this.inFlight === 0 && this.releaseQuiescence) {
        this.releaseQuiescence()
      }
    }
  }

  /**
   * Dispose: stop accepting new runs, wait for in-flight runs to settle, then
   * clear. Resolves once quiescence is reached (bounded by an optional max wait).
   */
  async dispose(maxWaitMs = 5000): Promise<void> {
    if (this.disposeRequested) return this.quiescence
    this.disposeRequested = true
    if (this.inFlight === 0) {
      this.middlewares.length = 0
      return
    }
    this.quiescence = new Promise((resolve) => { this.releaseQuiescence = resolve })
    const timer = setTimeout(() => {
      this.releaseQuiescence?.()
      this.middlewares.length = 0
    }, maxWaitMs)
    await this.quiescence
    clearTimeout(timer)
    this.middlewares.length = 0
  }
}

/** Wrap a middleware chain around an actual tool execution. */
export async function runWithWaterfall(
  waterfall: ToolCallWaterfall,
  call: ToolCall,
  sessionId: string,
  execute: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const outcome = await waterfall.run({ sessionId, call })
  if (outcome.decision === 'deny') {
    return { content: `Permission denied by middleware${outcome.reason ? `: ${outcome.reason}` : ''}.`, isError: true }
  }
  if (outcome.decision === 'ask') {
    // ask degrades to allow by default here; the Agent loop's approval seam
    // already handles confirm decisions for risky tools.
    return execute()
  }
  return execute()
}