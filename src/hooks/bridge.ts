import type { WaterfallOutcome } from '../events/waterfall.js'
import type { ToolCall } from '../types.js'
import type { HooksConfig, HookDecisionResult, ResolvedHook } from './config.js'
import { buildHookPayload, matchingGroups } from './config.js'
import { runHookCommand } from './runner.js'
import { mergeHookDecisions, parseHookOutput } from './parse.js'

export interface HookBridgeOptions {
  cwd?: string
}

/**
 * Executes the PreToolUse hooks from a hooks.json config for a tool call and
 * merges their decisions (deny > ask > allow). Pure runner — it does NOT
 * attach to anything; use `asWaterfallMiddleware` to wire it into the
 * ToolCallWaterfall chain (the dsh-style around-dispatch used across TA).
 */
export class HookBridge {
  private readonly config: HooksConfig
  private readonly cwd?: string

  constructor(config: HooksConfig, options: HookBridgeOptions = {}) {
    this.config = config
    this.cwd = options.cwd
  }

  /** All hooks that apply to this tool call, already bound to the payload. */
  resolve(call: ToolCall, sessionId: string): ResolvedHook[] {
    const payload = buildHookPayload(call, sessionId, this.cwd)
    const groups = matchingGroups(this.config, call.name)
    const rules = groups.flatMap((group) => group.hooks)
    return rules.map((rule) => ({ rule, payload }))
  }

  /** Run every applicable hook and merge the outcome. Never throws. */
  async runFor(call: ToolCall, sessionId: string): Promise<HookDecisionResult> {
    const resolved = this.resolve(call, sessionId)
    const runs: HookDecisionResult['runs'] = []
    for (const hook of resolved) {
      const raw = await runHookCommand(hook.rule, hook.payload)
      const parsed = parseHookOutput(raw)
      runs.push({ command: hook.rule.command, output: parsed })
    }
    const decision = mergeHookDecisions(runs.map((r) => r.output))
    const deniedRun = runs.find((r) => r.output.decision === 'deny' || (r.output.decision === undefined && r.output.exitCode !== 0))
    const reason = deniedRun?.output.reason ?? (decision === 'deny' ? 'Denied by pre-tool-use hook' : undefined)
    return { decision, reason, runs }
  }
}

/**
 * Wrap a HookBridge as a ToolCallWaterfall middleware: any hook decision
 * other than allow short-circuits the chain with the merged decision.
 */
export function asWaterfallMiddleware(bridge: HookBridge): (ctx: { sessionId: string; call: ToolCall }, next: () => Promise<void>) => Promise<WaterfallOutcome['decision'] | void> {
  return async (ctx, next) => {
    const result = await bridge.runFor(ctx.call, ctx.sessionId)
    if (result.decision !== 'allow') {
      return result.decision
    }
    await next()
  }
}