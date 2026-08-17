import type { ServiceRegistry } from '../seams/registry.js'
import type { EventBus } from './events.js'
import type { ToolScope } from '../tools/scope.js'
import type { SessionStore } from '../session/store.js'
import type { LLMCompleter } from '../types.js'

/**
 * PluginContext (ctx) — the shared object every plugin receives in setup().
 * Mirrors dsh's ctx: services (seam registry), events (broadcast + waterfall),
 * tools (scoped), store (append-only session log), llm.
 */
export interface PluginContext {
  services: ServiceRegistry
  events: EventBus
  tools: ToolScope
  store: SessionStore
  llm: LLMCompleter
  logger: (msg: string) => void
}