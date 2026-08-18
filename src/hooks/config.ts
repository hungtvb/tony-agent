import type { ToolCall } from '../types.js'

/** Raw exit contract of a hook command (Claude Code / Codex pre-tool-use hooks). */
export type HookDecision = 'allow' | 'ask' | 'deny'

/** Neutral output parsed from a hook command's stdout JSON. */
export interface HookOutput {
  decision?: HookDecision
  reason?: string
  output?: string
  exitCode: number
  stderr?: string
  timedOut?: boolean
}

/** Input written to the hook command's stdin as JSON. */
export interface HookPayload {
  sessionId: string
  toolCallId: string
  toolName: string
  toolInput: Record<string, unknown>
  cwd?: string
}

/** One executable hook rule inside a matcher group. */
export interface HookRule {
  /** Shell command to spawn. */
  command: string
  /** Timeout in seconds (default 30). */
  timeout?: number
}

/** A matcher group: applies its hooks to tool calls matching `matcher`. */
export interface HookMatcherGroup {
  /** Tool-name matcher: exact name, comma-separated names, or '*' for all. */
  matcher: string
  hooks: HookRule[]
}

/** Output a PostToolUse hook may return to mutate the tool result. */
export interface HookResultMutation {
  /** Replacement content for the tool result fed back to the agent. */
  content?: string
  /** Mark the result as an error (e.g. a validator rejected the output). */
  isError?: boolean
  /** Optional note surfaced in diagnostics. */
  note?: string
}

/** Shape of a hooks.json file (Claude Code compatible subset). */
export interface HooksConfig {
  hooks: {
    /** PreToolUse hook group list. */
    PreToolUse?: HookMatcherGroup[]
    /** PostToolUse hook group list — runs after the tool executes. */
    PostToolUse?: HookMatcherGroup[]
  }
}

/** A fully resolved hook rule bound to a specific tool call. */
export interface ResolvedHook {
  rule: HookRule
  payload: HookPayload
}

/** The merged decision produced by the HookBridge for one tool call. */
export interface HookDecisionResult {
  decision: HookDecision
  reason?: string
  /** Per-hook outputs that ran (for diagnostics). */
  runs: Array<{ command: string; output: HookOutput }>
}

const DEFAULT_HOOK_TIMEOUT_SECONDS = 30

export function defaultHookTimeout(): number {
  return DEFAULT_HOOK_TIMEOUT_SECONDS
}

/**
 * Matches a tool name against a matcher pattern: '*' matches everything,
 * otherwise exact name or comma-separated names (trimmed).
 */
export function matchesToolName(matcher: string, toolName: string): boolean {
  const pattern = matcher.trim()
  if (pattern === '*') return true
  return pattern.split(',').map((part) => part.trim()).filter(Boolean).includes(toolName)
}

/** Pick the matcher groups whose pattern matches this tool name. */
export function matchingGroups(config: HooksConfig, toolName: string, phase: 'PreToolUse' | 'PostToolUse' = 'PreToolUse'): HookMatcherGroup[] {
  const groups = config.hooks?.[phase] ?? []
  return groups.filter((group) => matchesToolName(group.matcher, toolName))
}

/** Build the stdin JSON payload for a hook command. */
export function buildHookPayload(call: ToolCall, sessionId: string, cwd?: string): HookPayload {
  let args: Record<string, unknown>
  if (typeof call.arguments === 'string') {
    try {
      args = JSON.parse(call.arguments) as Record<string, unknown>
    } catch {
      args = { raw: call.arguments }
    }
  } else {
    args = call.arguments
  }
  return {
    sessionId,
    toolCallId: call.id,
    toolName: call.name,
    toolInput: args,
    cwd,
  }
}
