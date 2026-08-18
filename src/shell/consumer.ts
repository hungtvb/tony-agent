import { z } from 'zod'
import type { ServiceConsumer } from '../seams/types.js'
import type { ShellService } from './definitions.js'
import { shellDefinition } from './definitions.js'
import type { TonyTool, ToolContext } from '../types.js'

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false }
}

const stringProp = (description: string) => ({ type: 'string', description })

/**
 * Consumer wrapping a mounted shell service into a single model-facing tool
 * (`shell_run`). Provider swap (local → remote/sandbox) never touches this
 * consumer or the model's view of the tool.
 */
export function createShellConsumer(): ServiceConsumer<ShellService> {
  return {
    definition: shellDefinition,
    uses(service: ShellService): TonyTool<any>[] {
      const tool: TonyTool<{ command: string; cwd?: string }> = {
        name: 'shell_run',
        description:
          'Run an allow-listed command inside the workspace root (ls, pwd, cat, echo, head, tail, wc, find, grep, node, npm, git). Returns stdout on success, error on failure.',
        risk: 'risky',
        inputSchema: z.object({ command: z.string(), cwd: z.string().optional() }),
        parameters: schema(
          { command: stringProp('Command line, e.g. "ls -la"'), cwd: stringProp('Optional subdirectory relative to workspace root') },
          ['command'],
        ),
        async execute(input: { command: string; cwd?: string }, _context: ToolContext): Promise<{ content: string; isError?: boolean }> {
          try {
            const result = await service.run(input.command, { cwd: input.cwd })
            return { content: result.stdout || '(no output)' }
          } catch (error) {
            return { content: `Error: ${String(error)}`, isError: true }
          }
        },
      }
      return [tool]
    },
  }
}