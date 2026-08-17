import { ToolCallWaterfall, type WaterfallDecision, type ToolCallContext } from '../events/waterfall.js'
import type { ToolCall, ToolResult } from '../types.js'

/** A durable fact broadcast to every listener (dsh `session/event`). */
export type BroadcastEvent =
  | { type: 'turn_start'; sessionId: string; turn: number }
  | { type: 'turn_end'; sessionId: string; turn: number }
  | { type: 'tool_result'; sessionId: string; call: ToolCall; result: ToolResult }
  | { type: string; [key: string]: unknown }

export type EventListener = (event: BroadcastEvent) => void

/**
 * EventBus — two dispatch kinds mirroring dsh:
 *
 * - `emit()`  broadcast: sync fan-out to every listener; a throwing listener
 *   does not stop the others (fail-open broadcast, like dsh telemetry).
 * - `waterfall()` around-dispatch chain with `next()` delegation and
 *   deny > ask > allow merge — for interception (agent/pre-step,
 *   tools/pre-execute). Reuses ToolCallWaterfall.
 *
 * Disposers are returned per listener/middleware; `dispose()` waits for
 * in-flight waterfall runs (quiescence) before clearing.
 */
export class EventBus {
  private readonly listeners = new Set<EventListener>()
  private readonly waterfall = new ToolCallWaterfall()

  on(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: BroadcastEvent): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event)
      } catch {
        // broadcast is fail-open: one bad listener must not break the rest
      }
    }
  }

  /** Register a waterfall middleware around tool calls (deny > ask > allow). */
  useWaterfall(middleware: (ctx: ToolCallContext, next: () => Promise<void>) => Promise<WaterfallDecision | void> | WaterfallDecision | void): () => void {
    return this.waterfall.use(middleware)
  }

  /** Run the waterfall chain for a tool call. */
  runWaterfall(ctx: ToolCallContext): Promise<{ decision: WaterfallDecision; reason?: string }> {
    return this.waterfall.run(ctx)
  }

  async dispose(maxWaitMs = 5000): Promise<void> {
    this.listeners.clear()
    await this.waterfall.dispose(maxWaitMs)
  }
}