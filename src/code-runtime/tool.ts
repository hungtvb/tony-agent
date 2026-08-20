import type { CodeRuntime } from './runtime.js'
import { codeRunSchema } from './runtime.js'
import { z } from 'zod'
import type { ToolResult } from '../types.js'

/**
 * The reserved `run_code` transport (dsh code-mode style): the only tool the
 * model may call directly when code mode is on. Computations run in the
 * configured runtime (worker-thread by default); a slow/pruned harness can
 * skip the transport by omitting the runtime.
 */
export function createRunCodeTool(runtime: CodeRuntime) {
  return {
    name: 'run_code',
    description: 'Run a code snippet in an isolated sandbox. Use for computation, data transforms, and quick checks that do not require writing files.',
    risk: 'risky' as const,
    inputSchema: z.object({
      code: z.string().min(1),
      language: z.enum(['typescript', 'javascript']).optional(),
      timeoutMs: z.number().int().positive().optional(),
    }).strict(),
    parameters: codeRunSchema(),
    async execute(input: { code: string; language?: 'typescript' | 'javascript'; timeoutMs?: number }, context: { signal?: AbortSignal; sessionId: string }): Promise<ToolResult> {
      const result = await runtime.run({
        language: input.language ?? 'typescript',
        code: input.code,
        timeoutMs: input.timeoutMs,
        signal: context.signal,
      })
      const head = result.stdout.split('\n').slice(0, 200).join('\n')
      const tail = result.stderr.split('\n').slice(0, 100).join('\n')
      if (!result.ok) {
        return {
          content: `run_code failed (${result.durationMs}ms):\n${result.error ?? 'unknown error'}\n${tail ? `stderr:\n${tail}` : ''}`,
          isError: true,
        }
      }
      return { content: `run_code ok (${result.durationMs}ms):\n${head}${tail ? `\nstderr:\n${tail}` : ''}` }
    },
  }
}