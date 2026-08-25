import { describe, expect, it } from 'vitest'
import { parseCliArgs } from '../src/cli/args.js'

describe('CLI --task-file / compact flags parsing', () => {
  it('parses --task-file with a value', () => {
    const parsed = parseCliArgs(['--task-file', '/tmp/TASK.md'])
    expect(parsed.taskFile).toBe('/tmp/TASK.md')
  })

  it('keeps --task-file compatible with -p (both retained)', () => {
    const parsed = parseCliArgs(['-p', 'Follow the brief carefully', '--task-file', '/tmp/TASK.md', '--allow-risky'])
    expect(parsed.prompt).toBe('Follow the brief carefully')
    expect(parsed.taskFile).toBe('/tmp/TASK.md')
    expect(parsed.allowRisky).toBe(true)
  })

  it('task-file path is not mistaken for a positional command token', () => {
    // A path containing a command-looking segment must survive intact.
    const parsed = parseCliArgs(['run', '--task-file', '/tmp/graph/search.md'])
    expect(parsed.taskFile).toBe('/tmp/graph/search.md')
    expect(parsed.command).toBe('run')
  })

  it('parses --compact-tokens as a positive integer', () => {
    expect(parseCliArgs(['--compact-tokens', '48000']).compactThresholdTokens).toBe(48_000)
  })

  it('ignores invalid --compact-tokens values', () => {
    expect(parseCliArgs(['--compact-tokens', 'abc']).compactThresholdTokens).toBeUndefined()
    expect(parseCliArgs(['--compact-tokens', '-5']).compactThresholdTokens).toBeUndefined()
  })

  it('parses --no-compact', () => {
    expect(parseCliArgs(['--no-compact']).noCompact).toBe(true)
    expect(parseCliArgs([]).noCompact).toBe(false)
  })
})
