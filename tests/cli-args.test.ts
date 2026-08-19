import { describe, expect, it } from 'vitest'
import { parseCliArgs, type ParsedCli } from '../src/cli/args.js'

describe('CLI argument parsing (pi-parity commands)', () => {
  it('parses new command with a session name', () => {
    const parsed: ParsedCli = parseCliArgs(['new', 'my-session'])
    expect(parsed.command).toBe('new')
    expect(parsed.target).toBe('my-session')
  })

  it('parses prompt/run with inline prompt', () => {
    const parsed: ParsedCli = parseCliArgs(['prompt', 'summarize this'])
    expect(parsed.command).toBe('prompt')
    expect(parsed.prompt).toBe('summarize this')
  })

  it('parses steer with session and text', () => {
    const parsed: ParsedCli = parseCliArgs(['steer', '-s', 'abc', 'keep going'])
    expect(parsed.command).toBe('steer')
    expect(parsed.session).toBe('abc')
    expect(parsed.prompt).toBe('keep going')
  })

  it('parses abort / fork / compact / export standalone', () => {
    expect(parseCliArgs(['abort', '-s', 'x']).command).toBe('abort')
    expect(parseCliArgs(['fork', 'my-branch']).command).toBe('fork')
    expect(parseCliArgs(['compact', '-s', 'x']).command).toBe('compact')
    expect(parseCliArgs(['export', '-s', 'x']).command).toBe('export')
  })

  it('parses switch / get with target', () => {
    const parsed: ParsedCli = parseCliArgs(['switch', 'other'])
    expect(parsed.command).toBe('switch')
    expect(parsed.target).toBe('other')
    expect(parseCliArgs(['get', 'abc']).command).toBe('get')
  })

  it('parses server and client subcommands', () => {
    expect(parseCliArgs(['server']).command).toBe('server')
    expect(parseCliArgs(['client']).command).toBe('client')
  })

  it('parses search with query and session flag', () => {
    const parsed: ParsedCli = parseCliArgs(['search', 'FTS5', '--session', 'abc', '--json'])
    expect(parsed.command).toBe('search')
    expect(parsed.prompt).toBe('FTS5')
    expect(parsed.session).toBe('abc')
    expect(parsed.json).toBe(true)
  })

  it('parses models with json flag', () => {
    const parsed: ParsedCli = parseCliArgs(['models', '--json'])
    expect(parsed.command).toBe('models')
    expect(parsed.json).toBe(true)
  })

  it('handles --offline and --non-interactive flags', () => {
    const parsed: ParsedCli = parseCliArgs(['prompt', 'x', '--offline', '--non-interactive'])
    expect(parsed.offline).toBe(true)
    expect(parsed.nonInteractive).toBe(true)
  })

  it('defaults to run when no command given', () => {
    const parsed: ParsedCli = parseCliArgs([])
    expect(parsed.command).toBe('run')
  })
})