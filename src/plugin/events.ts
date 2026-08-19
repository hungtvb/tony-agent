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
 * EventMap — the typed event-names surface. Extend via declaration merging:
 *
 * ```ts
 * declare module '../src/plugin/events.js' {
 *   interface EventMap {
 *     'user:greet': { name: string }
 *   }
 * }
 * ```
 *
 * `emit<K>` is type-checked against this map; `on<K>` narrows the payload.
 * Default entries are the built-in broadcast events without a name.
 */
export interface EventMap {
  [name: string]: unknown
}

/**
 * Map a string-keyed event to its typed payload:
 * - explicit EventMap key (e.g. 'user:greet') → the declared payload type
 * - anything else → the plain BroadcastEvent (backward compatible)
 */
export type TypedEvent<E extends EventMap, Name extends string> = Name extends keyof E
  ? E[Name] extends unknown
    ? { type: Name } & E[Name]
    : { type: Name } & E[Name]
  : BroadcastEvent

export type TypedListener<E extends EventMap, Name extends string> = (event: TypedEvent<E, Name>) => void

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
export class EventBus<E extends EventMap = EventMap> {
  private readonly listeners = new Set<EventListener>()
  private readonly waterfall = new ToolCallWaterfall()

  on<Name extends keyof E & string>(event: Name, listener: (event: TypedEvent<E, Name>) => void): () => void
  on(listener: EventListener): () => void
  on(...args: [string, (event: never) => void] | [EventListener]): () => void {
    const [first, second] = args
    if (typeof first === 'string') {
      const name = first
      const listener = (second ?? ((_event: never) => {})) as EventListener
      const wrapped: EventListener = (broadcast) => {
        if (broadcast.type !== name) return
        listener(broadcast)
      }
      this.listeners.add(wrapped)
      return () => this.listeners.delete(wrapped)
    }
    this.listeners.add(first)
    return () => this.listeners.delete(first)
  }

  emit<Name extends keyof E & string>(event: Name, payload: E[Name]): void
  emit(event: BroadcastEvent): void
  emit(event: string | BroadcastEvent, payload?: unknown): void {
    const broadcast: BroadcastEvent = typeof event === 'string' ? { type: event, ...(payload as Record<string, unknown>) } : event
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(broadcast)
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