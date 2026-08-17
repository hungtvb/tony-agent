import type { ServiceRegistry } from '../seams/registry.js'
import type { EventBus } from './events.js'
import type { PluginContext } from './context.js'
import type { ToolScope } from '../tools/scope.js'
import type { SessionStore } from '../session/store.js'
import type { LLMCompleter } from '../types.js'

/** A reversible effect: unmount calls dispose() to unwind registrations. */
export interface PluginEffect {
  dispose(): void | Promise<void>
}

/** A plugin contributing registrations to the context (dsh "everything is a plugin"). */
export interface Plugin {
  name: string
  version?: string
  setup?(ctx: PluginContext): PluginEffect | void
}

/** One mounted plugin instance. */
export interface MountedPlugin {
  plugin: Plugin
  effect?: PluginEffect
}

/**
 * PluginRegistry — mount/unmount plugins with reversible effects.
 * Unmount unwinds in reverse mount order (LIFO) and awaits async disposers,
 * so a context can reach quiescence before it dies (dsh dispose rule).
 */
export class PluginRegistry {
  private readonly mounted = new Map<string, MountedPlugin>()
  private readonly order: string[] = []

  mount(plugin: Plugin, ctx: PluginContext): void {
    if (!plugin?.name) throw new Error('Plugin must have a name')
    if (this.mounted.has(plugin.name)) throw new Error(`Plugin already mounted: ${plugin.name}`)
    const effect = plugin.setup?.(ctx)
    this.mounted.set(plugin.name, { plugin, effect: effect ?? undefined })
    this.order.push(plugin.name)
  }

  isMounted(name: string): boolean {
    return this.mounted.has(name)
  }

  list(): string[] {
    return Array.from(this.order)
  }

  /** Get the plugin's setup effect (for tests/teardown). */
  effectOf(name: string): PluginEffect | undefined {
    return this.mounted.get(name)?.effect
  }

  async unmount(name: string): Promise<void> {
    const entry = this.mounted.get(name)
    if (!entry) throw new Error(`Plugin not mounted: ${name}`)
    await entry.effect?.dispose()
    this.mounted.delete(name)
    const index = this.order.indexOf(name)
    if (index >= 0) this.order.splice(index, 1)
  }

  /** Unmount everything in reverse mount order. */
  async unmountAll(): Promise<void> {
    for (const name of [...this.order].reverse()) {
      await this.unmount(name)
    }
  }
}