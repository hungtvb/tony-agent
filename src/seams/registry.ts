import type { ServiceDefinition, ServiceProvider, ServiceConsumer } from './types.js'
import type { PluginContext } from '../plugin/context.js'
import type { TonyTool } from '../types.js'

export type { ServiceDefinition, ServiceProvider, ServiceConsumer } from './types.js'

interface ProviderEntry {
  provider: ServiceProvider
  instance: unknown
  created: boolean
}

/**
 * ServiceRegistry — mounts named providers per ServiceDefinition.
 *
 * - One provider active per definition; the newest mount wins (later layers
 *   override earlier ones, dsh bundle order).
 * - `resolve()` fails closed: no provider → throw, so a capability that is
 *   required but not mounted cannot silently no-op.
 * - `unregister()` reverts to the previous provider (LIFO unwind), or none.
 */
export class ServiceRegistry {
  private readonly providers = new Map<string, ProviderEntry[]>()
  private readonly consumers = new Map<string, ServiceConsumer[]>()

  register<T>(provider: ServiceProvider<T>): () => void {
    if (!provider?.definition?.id || !provider.name) throw new Error('Provider needs definition.id and name')
    const id = provider.definition.id
    const stack = this.providers.get(id) ?? []
    if (stack.length > 0) {
      throw new Error(`Provider already registered for ${id}: ${stack[stack.length - 1]!.provider.name}`)
    }
    const entry: ProviderEntry = { provider, instance: undefined, created: false }
    stack.push(entry)
    this.providers.set(id, stack)
    return () => {
      const current = this.providers.get(id)
      if (!current) return
      const index = current.indexOf(entry)
      if (index >= 0) current.splice(index, 1)
      if (current.length === 0) this.providers.delete(id)
    }
  }

  has(id: string): boolean {
    return (this.providers.get(id)?.length ?? 0) > 0
  }

  definitions(): string[] {
    return Array.from(this.providers.keys())
  }

  /** Active provider name for a definition. */
  activeProviderName(id: string): string | undefined {
    const stack = this.providers.get(id)
    return stack?.[stack.length - 1]?.provider.name
  }

  /** Resolve the active provider's instance (created lazily, cached). */
  resolve<T>(id: string, ctx?: PluginContext): T {
    const stack = this.providers.get(id)
    const entry = stack?.[stack.length - 1]
    if (!entry) throw new Error(`No provider for service: ${id}`)
    if (!entry.created) {
      entry.instance = entry.provider.create(ctx as PluginContext)
      entry.created = true
    }
    return entry.instance as T
  }

  /** Resolve then wrap via a consumer into model-facing tools. */
  consume<T>(id: string, consumer: ServiceConsumer<T>, ctx?: PluginContext): TonyTool[] {
    const service = this.resolve<T>(id, ctx)
    const list = this.consumers.get(id) ?? []
    if (!list.includes(consumer)) list.push(consumer)
    this.consumers.set(id, list)
    const tools = consumer.uses(service)
    return Array.isArray(tools) ? tools : [tools]
  }

  /** Tools every consumer for this definition produces (for registration). */
  consumerTools(id: string, ctx?: PluginContext): TonyTool[] {
    const consumers = this.consumers.get(id) ?? []
    const tools: TonyTool[] = []
    for (const consumer of consumers) {
      const produced = consumer.uses(this.resolve(id, ctx))
      tools.push(...(Array.isArray(produced) ? produced : [produced]))
    }
    return tools
  }

  /** Unregister a consumer (returns disposer semantics). */
  unconsume(id: string, consumer: ServiceConsumer): void {
    const list = this.consumers.get(id)
    if (!list) return
    const index = list.indexOf(consumer)
    if (index >= 0) list.splice(index, 1)
  }
}