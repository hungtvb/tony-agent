import type { ZodTypeAny } from 'zod'
import type { PluginContext } from '../plugin/context.js'
import type { TonyTool } from '../types.js'

/**
 * Capability seam — the dsh three-role pattern:
 *
 *   ServiceDefinition — declares the interface contract (id + zod schema)
 *   ServiceProvider   — implements the service for one definition
 *   ServiceConsumer   — wraps a resolved service into model-facing tools
 *
 * One role alone is not a seam. Swapping a provider (local → remote) changes
 * every consumer with no consumer code changes.
 */
export interface ServiceDefinition<TSchema extends ZodTypeAny = ZodTypeAny> {
  id: string
  schema: TSchema
}

export interface ServiceProvider<T = unknown> {
  definition: ServiceDefinition<ZodTypeAny>
  /** Provider name, e.g. 'local' | 'remote' | 'in-process'. */
  name: string
  create(ctx: PluginContext): T
}

export interface ServiceConsumer<T = unknown> {
  definition: ServiceDefinition<ZodTypeAny>
  /** Wrap the resolved service into one or more tools the model can call. */
  uses(service: T): TonyTool | TonyTool[]
}