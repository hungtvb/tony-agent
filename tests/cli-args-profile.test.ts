import { describe, it, expect } from 'vitest'
import { parseCliArgs } from '../src/cli/args.js'

describe('cli args — profile flags', () => {
  it('parses --profile value', () => {
    const parsed = parseCliArgs(['run', '--profile', 'web', '-p', 'hi'])
    expect(parsed.profile).toBe('web')
    expect(parsed.command).toBe('run')
  })

  it('parses dump-config command with --profile', () => {
    const parsed = parseCliArgs(['dump-config', '--profile', 'headless'])
    expect(parsed.command).toBe('dump-config')
    expect(parsed.profile).toBe('headless')
  })

  it('parses profile positional command', () => {
    const parsed = parseCliArgs(['profile', 'web'])
    expect(parsed.command).toBe('profile')
    expect(parsed.target).toBe('web')
  })

  it('defaults have no profile and no dump', () => {
    const parsed = parseCliArgs(['run', '-p', 'hi'])
    expect(parsed.profile).toBeUndefined()
    expect(parsed.dumpConfig).toBe(false)
  })
})
