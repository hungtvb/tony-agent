import { z } from 'zod'
import type { ServiceConsumer } from '../seams/types.js'
import type { FsService } from './definitions.js'
import { fsDefinition } from './definitions.js'
import type { TonyTool, ToolContext } from '../types.js'

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false }
}

const stringProp = (description: string) => ({ type: 'string', description })

/**
 * Consumer that wraps a mounted fs service into model-facing tools
 * (fs_read / fs_write / fs_list). Swapping the provider (local → remote)
 * changes the service, never these tools.
 */
export function createFsConsumer(): ServiceConsumer<FsService> {
  return {
    definition: fsDefinition,
    uses(service: FsService): TonyTool[] {
      const read: TonyTool<{ path: string }> = {
        name: 'fs_read',
        description: 'Read a file inside the workspace.',
        risk: 'read',
        inputSchema: z.object({ path: z.string() }),
        parameters: schema({ path: stringProp('Relative path inside workspace') }, ['path']),
        async execute(input: { path: string }): Promise<{ content: string; isError?: boolean }> {
          try {
            return { content: await service.read(input.path) }
          } catch (error) {
            return { content: `Error: ${String(error)}`, isError: true }
          }
        },
      }

      const write: TonyTool<{ path: string; content: string }> = {
        name: 'fs_write',
        description: 'Write content to a file inside the workspace (creates or overwrites).',
        risk: 'risky',
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        parameters: schema(
          { path: stringProp('Relative path inside workspace'), content: stringProp('Full file content') },
          ['path', 'content'],
        ),
        async execute(input: { path: string; content: string }): Promise<{ content: string; isError?: boolean }> {
          try {
            await service.write(input.path, input.content)
            return { content: `Wrote ${input.path} (${input.content.length} chars)` }
          } catch (error) {
            return { content: `Error: ${String(error)}`, isError: true }
          }
        },
      }

      const list: TonyTool<{ path: string }> = {
        name: 'fs_list',
        description: 'List directory contents inside the workspace.',
        risk: 'read',
        inputSchema: z.object({ path: z.string() }),
        parameters: schema({ path: stringProp('Relative path (default .)') }, ['path']),
        async execute(input: { path: string }, _context: ToolContext): Promise<{ content: string; isError?: boolean }> {
          try {
            const entries = await service.list(input.path)
            return { content: entries.length > 0 ? entries.join('\n') : '(empty)' }
          } catch (error) {
            return { content: `Error: ${String(error)}`, isError: true }
          }
        },
      }

      const tools: TonyTool<any>[] = [read, write, list]
      return tools
    },
  }
}
