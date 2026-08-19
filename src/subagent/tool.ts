import { z } from 'zod'
import type { SubagentRegistry } from './registry.js'
import type { TonyTool } from '../types.js'

export interface CreateSubagentToolOptions {
  /** Provider name to use for delegations (must be registered). */
  provider?: string
}

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false }
}

const stringProp = (description: string) => ({ type: 'string', description })
const numberProp = (description: string) => ({ type: 'number', description })

/**
 * Model-facing `subagent:delegate` tool — fan-out a subtask to a registered
 * subagent provider (defaults to 'in-process'). The child gets its own
 * transcript/session and an optional tool filter; the parent blocks until the
 * child settles. Returns the child's final text.
 */
export function createSubagentTool(registry: SubagentRegistry, options: CreateSubagentToolOptions = {}): TonyTool<any> {
  return {
    name: 'subagent:delegate',
    description:
      'Delegate a self-contained subtask to a subagent with its own session. Returns the subagent final answer. Use for reasoning-heavy, isolatable work that would flood the main context.',
    risk: 'risky',
    inputSchema: z.object({
      prompt: z.string(),
      maxToolCalls: z.number().optional(),
      toolFilter: z.array(z.string()).optional(),
      provider: z.string().optional(),
    }),
    parameters: schema(
      {
        prompt: stringProp('The full self-contained task for the subagent'),
        maxToolCalls: numberProp('Optional cap on the child tool calls (default 30)'),
        toolFilter: { type: 'array', items: { type: 'string' }, description: 'Optional tool names the child may use' },
        provider: stringProp(`Optional provider name (default: ${options.provider ?? 'in-process'})`),
      },
      ['prompt'],
    ),
    async execute(input: { prompt: string; maxToolCalls?: number; toolFilter?: string[]; provider?: string }): Promise<{ content: string; isError?: boolean }> {
      try {
        const provider = input.provider ?? options.provider ?? 'in-process'
        const result = await registry.start(provider, {
          prompt: input.prompt,
          maxToolCalls: input.maxToolCalls,
          toolFilter: input.toolFilter,
        })
        return {
          content: `Subagent ${result.childId}: ${result.text}\n(turns=${result.turns}, toolCalls=${result.toolCalls}${result.aborted ? ', ABORTED' : ''})`,
        }
      } catch (error) {
        return { content: `Error: ${String(error)}`, isError: true }
      }
    },
  }
}