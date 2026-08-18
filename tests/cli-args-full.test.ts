import { describe, it, expect } from 'vitest'
import { parseCliArgs } from '../src/cli/args.js'

describe('cli args — full flag coverage', () => {
  it('parses -p prompt for run', () => {
    const parsed = parseCliArgs(['run', '-p', 'summarize'])
    expect(parsed.command).toBe('run')
    expect(parsed.prompt).toBe('summarize')
  })

  it('parses --prompt long form', () => {
    const parsed = parseCliArgs(['run', '--prompt', 'do it'])
    expect(parsed.prompt).toBe('do it')
  })

  it('parses --offline + --json + --no-stream together', () => {
    const parsed = parseCliArgs(['run', '--offline', '--json', '--no-stream', '-p', 'x'])
    expect(parsed.offline).toBe(true)
    expect(parsed.json).toBe(true)
    expect(parsed.stream).toBe(false)
  })

  it('parses provider flags', () => {
    const parsed = parseCliArgs(['run', '--base-url', 'http://x', '--api-key', 'k', '--model', 'm1', '--max-turns', '5'])
    expect(parsed.baseUrl).toBe('http://x')
    expect(parsed.apiKey).toBe('k')
    expect(parsed.model).toBe('m1')
    expect(parsed.maxTurns).toBe(5)
  })

  it('parses --help as help command', () => {
    expect(parseCliArgs(['--help']).command).toBe('help')
    expect(parseCliArgs(['-h']).command).toBe('help')
  })

  it('parses client positional input', () => {
    const parsed = parseCliArgs(['client', 'hello remote'])
    expect(parsed.command).toBe('client')
    expect(parsed.prompt).toBe('hello remote')
  })

  it('parses clone positional', () => {
    const parsed = parseCliArgs(['clone', 'session-abc'])
    expect(parsed.command).toBe('clone')
    expect(parsed.target).toBe('session-abc')
  })

  it('parses steer positional text', () => {
    const parsed = parseCliArgs(['steer', 'more detail please'])
    expect(parsed.command).toBe('steer')
    expect(parsed.prompt).toBe('more detail please')
  })

  it('defaults: stream on, no flags', () => {
    const parsed = parseCliArgs(['run'])
    expect(parsed.stream).toBe(true)
    expect(parsed.offline).toBe(false)
    expect(parsed.json).toBe(false)
  })
})
