import type { HookDecision, HookOutput } from './config.js'

/**
 * Tries to parse hook stdout as JSON with a `decision` field (Claude Code
 * style). Anything malformed degrades to the exit-code contract: exit 0 →
 * allow, non-zero → deny (fail-closed). The return value is a HookOutput
 * with a clamped decision and optional reason/output.
 */
export function parseHookOutput(raw: HookOutput): HookOutput {
  const result: HookOutput = { ...raw }
  const text = (raw.output ?? '').trim()

  if (text) {
    try {
      const parsed = JSON.parse(text) as { decision?: unknown; reason?: unknown; output?: unknown }
      if (parsed !== null && typeof parsed === 'object') {
        if (typeof parsed.output === 'string') result.output = parsed.output
        const decision = normalizeDecision(parsed.decision)
        if (decision) result.decision = decision
        if (typeof parsed.reason === 'string' && parsed.reason.length > 0) result.reason = parsed.reason
      }
    } catch {
      // Not JSON — keep the exit-code contract.
    }
  }

  if (result.decision === undefined) {
    result.decision = result.exitCode === 0 ? 'allow' : 'deny'
    if (result.decision === 'deny' && !result.reason) {
      result.reason = (result.output?.trim() || result.stderr?.trim() || `Hook exited with code ${result.exitCode}`).slice(0, 400)
    }
  }

  return result
}

function normalizeDecision(value: unknown): HookDecision | undefined {
  if (value === 'allow' || value === 'ask' || value === 'deny') return value
  if (value === 'allowOnce' || value === 'allow-once') return 'allow'
  return undefined
}

/** Merge a list of per-hook decisions: deny > ask > allow (most restrictive). */
export function mergeHookDecisions(results: HookOutput[]): HookDecision {
  const rank: Record<HookDecision, number> = { allow: 0, ask: 1, deny: 2 }
  let merged: HookDecision = 'allow'
  for (const result of results) {
    const decision = result.decision ?? (result.exitCode === 0 ? 'allow' : 'deny')
    if (rank[decision] > rank[merged]) merged = decision
  }
  return merged
}

/** Fail-closed: any hook that produced neither a decision nor exit 0 counts as a deny. */
export function decisionsFor(results: HookOutput[]): HookDecision[] {
  if (results.length === 0) return ['allow']
  const decisions = results.map((r) => r.decision ?? (r.exitCode === 0 ? 'allow' : 'deny'))
  return decisions
}