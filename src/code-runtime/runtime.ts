import type { JsonSchema } from '../types.js'

/** Result of one code execution. */
export interface CodeRunResult {
  ok: boolean
  stdout: string
  stderr: string
  error?: string
  /** Millisecond wall time. */
  durationMs: number
}

export interface CodeRunRequest {
  language: 'typescript' | 'javascript'
  /** Code to execute. */
  code: string
  /** Optional working directory. */
  cwd?: string
  /** Milliseconds before the run is killed. */
  timeoutMs?: number
}

/** A code runtime: executes a snippet and returns structured output. */
export interface CodeRuntime {
  readonly language: string
  run(request: CodeRunRequest): Promise<CodeRunResult>
}

export function codeRunSchema(): JsonSchema {
  return {
    type: 'object',
    properties: {
      language: {
        type: 'string',
        enum: ['typescript', 'javascript'],
        description: 'Language of the snippet (default: typescript)',
      },
      code: { type: 'string', description: 'Code to execute' },
      timeoutMs: { type: 'number', description: 'Optional timeout in ms (default 30000)' },
    },
    required: ['code'],
    additionalProperties: false,
  }
}
