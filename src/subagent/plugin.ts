import { z } from 'zod'
import type { ServiceConsumer, ServiceDefinition, ServiceProvider } from '../seams/types.js'
import type { PluginContext } from '../plugin/context.js'
import type { Plugin } from '../plugin/registry.js'
import type { TonyTool, ToolResult } from '../types.js'
import {
  createInProcessSubagentProvider,
  type InProcessSubagentOptions,
  type SubagentProvider,
  type SubagentRequest,
  type SubagentResult,
} from './registry.js'

/** Capability seam id for subagent delegation. */
export const SUBAGENT_SERVICE_ID = 'subagent'

/** The subagent service definition: request/result contract. */
export const subagentServiceDefinition: ServiceDefinition = {
  id: SUBAGENT_SERVICE_ID,
  schema: z.object({
    prompt: z.string().min(1),
    maxToolCalls: z.number().int().positive().optional(),
    toolFilter: z.array(z.string()).optional(),
    sessionId: z.string().optional(),
  }),
}

/** Wrap an existing SubagentProvider into a ServiceProvider (swap backend zero-touch). */
export function createSubagentServiceProvider(provider: SubagentProvider): ServiceProvider<SubagentProvider> {
  return {
    definition: subagentServiceDefinition,
    name: provider.name,
    create() {
      return provider
    },
  }
}

/** Build the in-process provider as a ServiceProvider (default for the plugin). */
export function createInProcessSubagentServiceProvider(
  options: InProcessSubagentOptions,
): ServiceProvider<SubagentProvider> {
  return createSubagentServiceProvider(createInProcessSubagentProvider(options))
}

/** Model-facing consumer: turns the resolved subagent service into a tool. */
export function createSubagentConsumer(): ServiceConsumer<SubagentProvider> {
  return {
    definition: subagentServiceDefinition,
    uses(service: SubagentProvider): TonyTool {
      return {
        name: 'delegate_subagent',
        description:
          'Delegate a task to a subagent with an isolated session. Use for reasoning-heavy subtasks or parallelizable work; the subagent returns its final text outcome. Requires a subagent provider to be mounted.',
        risk: 'risky' as const,
        inputSchema: undefined as never,
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Task for the child agent' },
            maxToolCalls: { type: 'number', description: 'Cap on child tool calls (default 30)' },
          },
          required: ['prompt'],
          additionalProperties: false,
        },
        async execute(input: unknown): Promise<ToolResult> {
          try {
            const request = (input ?? {}) as SubagentRequest
            if (typeof request.prompt !== 'string' || request.prompt.trim() === '') {
              return { content: 'subagent delegation requires a non-empty prompt', isError: true }
            }
            const result: SubagentResult = await service.start(request)
            return {
              content: `subagent ${result.childId}: ${result.text} (${result.toolCalls} tool calls, ${result.turns} turns${result.aborted ? ', aborted' : ''})`,
            }
          } catch (error) {
            return {
              content: `subagent delegation failed: ${error instanceof Error ? error.message : String(error)}`,
              isError: true,
            }
          }
        },
      }
    },
  }
}

/**
 * The subagent plugin: mounts the subagent service provider + consumer into
 * the plugin context. Mounting requires the plugin host to have built a
 * context with `services`, `tools`, and the LLM completer; the provider is
 * registered and a `delegate_subagent` tool is exposed through the tool scope.
 */
export function createSubagentPlugin(options: InProcessSubagentOptions): Plugin {
  return {
    name: 'subagent',
    version: '1.0.0',
    setup(ctx: PluginContext) {
      // 1. register the in-process provider behind the seam
      const unregister = ctx.services.register(createInProcessSubagentServiceProvider(options))
      // 2. expose the consumer tool through the tool scope
      const consumer = createSubagentConsumer()
      const produced = consumer.uses(ctx.services.resolve<SubagentProvider>(SUBAGENT_SERVICE_ID, ctx))
      const tool = (Array.isArray(produced) ? produced[0] : produced) as TonyTool
      ctx.tools.shadow('delegate_subagent', tool)
      return {
        dispose() {
          unregister()
          ctx.tools.deny('delegate_subagent')
        },
      }
    },
  }
}