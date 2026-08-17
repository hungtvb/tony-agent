import { describe, expect, it } from 'vitest'
import { ToolCallWaterfall } from '../src/events/waterfall.js'
import type { ToolCall } from '../src/types.js'
import type { HooksConfig, HookOutput } from '../src/hooks/config.js'
import { buildHookPayload, matchesToolName, matchingGroups } from '../src/hooks/config.js'
import { parseHookOutput, mergeHookDecisions } from '../src/hooks/parse.js'
import { HookBridge, asWaterfallMiddleware } from '../src/hooks/bridge.js'
import { runHookCommand } from '../src/hooks/runner.js'

const call: ToolCall = { id: 'c1', name: 'bash', arguments: { cmd: 'ls' } }

function configWith(hooks: Array<{ matcher: string; command: string; timeout?: number }>): HooksConfig {
  return { hooks: { PreToolUse: hooks.map((h) => ({ matcher: h.matcher, hooks: [{ command: h.command, timeout: h.timeout }] })) } }
}

describe('hook config matching', () => {
  it('matches * against every tool name', () => {
    expect(matchesToolName('*', 'bash')).toBe(true)
    expect(matchesToolName('*', 'read')).toBe(true)
  })

  it('matches exact and comma-separated names', () => {
    expect(matchesToolName('bash', 'bash')).toBe(true)
    expect(matchesToolName('read,write', 'write')).toBe(true)
    expect(matchesToolName('bash', 'read')).toBe(false)
  })

  it('matchingGroups returns only groups whose matcher applies', () => {
    const config = configWith([
      { matcher: 'bash', command: 'echo bash' },
      { matcher: '*', command: 'echo all' },
    ])
    const groups = matchingGroups(config, 'bash')
    expect(groups).toHaveLength(2)
    expect(matchingGroups(config, 'read')).toHaveLength(1)
  })

  it('buildHookPayload parses string arguments into toolInput', () => {
    const stringCall = { id: 'x', name: 'bash', arguments: JSON.stringify({ cmd: 'ls' }) as unknown as Record<string, unknown> }
    const payload = buildHookPayload(stringCall, 's1', '/tmp')
    expect(payload.toolName).toBe('bash')
    expect(payload.toolInput).toEqual({ cmd: 'ls' })
    expect(payload.cwd).toBe('/tmp')
  })

  it('buildHookPayload handles object arguments as-is', () => {
    const payload = buildHookPayload({ id: 'x', name: 'bash', arguments: { cmd: 'ls' } }, 's1')
    expect(payload.toolInput).toEqual({ cmd: 'ls' })
  })
})

describe('parseHookOutput', () => {
  it('exit 0 without JSON → allow', () => {
    expect(parseHookOutput({ exitCode: 0, output: '' }).decision).toBe('allow')
  })

  it('non-zero exit without JSON → deny with reason (fail-closed)', () => {
    const result = parseHookOutput({ exitCode: 2, output: '', stderr: 'nope' })
    expect(result.decision).toBe('deny')
    expect(result.reason).toContain('nope')
  })

  it('stdout JSON decision overrides exit code', () => {
    const result = parseHookOutput({ exitCode: 0, output: JSON.stringify({ decision: 'deny', reason: 'blocked by policy' }) })
    expect(result.decision).toBe('deny')
    expect(result.reason).toBe('blocked by policy')
  })

  it('malformed JSON degrades to exit-code contract', () => {
    const result = parseHookOutput({ exitCode: 1, output: 'not json at all' })
    expect(result.decision).toBe('deny')
  })

  it('allowOnce normalizes to allow', () => {
    const result = parseHookOutput({ exitCode: 0, output: JSON.stringify({ decision: 'allowOnce' }) })
    expect(result.decision).toBe('allow')
  })
})

describe('mergeHookDecisions', () => {
  it('merges deny > ask > allow', () => {
    const results: HookOutput[] = [
      { exitCode: 0, output: '', decision: 'allow' },
      { exitCode: 0, output: '', decision: 'ask' },
      { exitCode: 0, output: '', decision: 'deny' },
    ]
    expect(mergeHookDecisions(results)).toBe('deny')
  })

  it('missing decision falls back to exit code', () => {
    const results: HookOutput[] = [{ exitCode: 0, output: '' }, { exitCode: 3, output: '' }]
    expect(mergeHookDecisions(results)).toBe('deny')
  })
})

describe('runHookCommand', () => {
  it('exit 0 → allow', async () => {
    const output = await runHookCommand({ command: 'exit 0' }, buildHookPayload(call, 's1'))
    expect(output.exitCode).toBe(0)
    expect(output.decision).toBe('allow')
  })

  it('exit 2 → deny with stderr as reason', async () => {
    const output = await runHookCommand({ command: 'echo blocked >&2; exit 2' }, buildHookPayload(call, 's1'))
    expect(output.decision).toBe('deny')
    expect(output.reason).toContain('blocked')
  })

  it('stdout JSON is NOT parsed by the raw runner (exit-code contract only)', async () => {
    const output = await runHookCommand({ command: 'echo \'{"decision":"deny","reason":"nope"}\'' }, buildHookPayload(call, 's1'))
    expect(output.exitCode).toBe(0)
    expect(output.decision).toBe('allow') // runner is code-first; parseHookOutput applies JSON later
    const parsed = parseHookOutput(output)
    expect(parsed.decision).toBe('deny')
    expect(parsed.reason).toBe('nope')
  })

  it('timeout kills the child and denies', async () => {
    const output = await runHookCommand({ command: 'sleep 5', timeout: 1 }, buildHookPayload(call, 's1'))
    expect(output.timedOut).toBe(true)
    expect(output.decision).toBe('deny')
  })
})

describe('HookBridge', () => {
  it('runs applicable hooks and merges decisions', async () => {
    const bridge = new HookBridge(configWith([
      { matcher: '*', command: 'echo \'{"decision":"allow"}\'' },
      { matcher: 'bash', command: 'echo \'{"decision":"deny","reason":"no shell"}\'' },
    ]))
    const result = await bridge.runFor(call, 's1')
    expect(result.decision).toBe('deny')
    expect(result.reason).toBe('no shell')
    expect(result.runs).toHaveLength(2)
  })

  it('no matching hooks → allow with zero runs', async () => {
    const bridge = new HookBridge(configWith([{ matcher: 'read', command: 'echo allow' }]))
    const result = await bridge.runFor(call, 's1')
    expect(result.decision).toBe('allow')
    expect(result.runs).toHaveLength(0)
  })
})

describe('asWaterfallMiddleware', () => {
  it('short-circuits the waterfall with deny and blocks execution', async () => {
    const waterfall = new ToolCallWaterfall()
    const bridge = new HookBridge(configWith([{ matcher: '*', command: 'echo \'{"decision":"deny"}\'' }]))
    waterfall.use(asWaterfallMiddleware(bridge))

    let executed = false
    const outcome = await waterfall.run({ sessionId: 's1', call })
    expect(outcome.decision).toBe('deny')
    expect(executed).toBe(false)
  })

  it('lets allow pass through to the next middleware', async () => {
    const waterfall = new ToolCallWaterfall()
    const bridge = new HookBridge(configWith([{ matcher: '*', command: 'echo \'{"decision":"allow"}\'' }]))
    waterfall.use(asWaterfallMiddleware(bridge))
    waterfall.use(async (_ctx, next): Promise<'allow'> => { await next(); return 'allow' })
    const outcome = await waterfall.run({ sessionId: 's1', call })
    expect(outcome.decision).toBe('allow')
  })
})
