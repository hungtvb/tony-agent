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

/** Sandbox policy for code runs. */
export interface SandboxPolicy {
  /** Allow `require` inside the sandbox (default false — blocks VM escapes). */
  allowRequire?: boolean
  /** Extra deny patterns matched against the source before execution. */
  denyPatterns?: RegExp[]
}

export interface CodeRunRequest {
  language: 'typescript' | 'javascript'
  /** Code to execute. */
  code: string
  /** Optional working directory. */
  cwd?: string
  /** Milliseconds before the run is killed. */
  timeoutMs?: number
  /** Sandbox policy applied to this run (default: deny require + dangerous APIs). */
  policy?: SandboxPolicy
}

const DEFAULT_DENY_PATTERNS: RegExp[] = [
  /\brequire\s*\(/,
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\bprocess\s*\.\s*binding\s*\(/,
  /\bchild_process\b/,
  /\bnode:child_process\b/,
]

/** Static pre-flight check of a snippet against a policy. Returns issues (empty = allowed). */
export function validateCodePolicy(code: string, policy?: SandboxPolicy): string[] {
  const issues: string[] = []
  const denies = policy?.denyPatterns ?? []
  for (const pattern of denies) {
    if (pattern.test(code)) issues.push(`blocked by deny pattern ${pattern}`)
  }
  if (!policy?.allowRequire && /\brequire\s*\(/.test(code)) {
    issues.push('require is disabled by default (set policy.allowRequire to enable)')
  }
  for (const pattern of DEFAULT_DENY_PATTERNS) {
    if (pattern === DEFAULT_DENY_PATTERNS[0]) continue // require handled above
    if (pattern.test(code)) issues.push(`blocked by default deny pattern ${pattern}`)
  }
  return issues
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
