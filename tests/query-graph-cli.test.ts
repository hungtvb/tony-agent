import { describe, it, expect } from 'vitest'
import { parseCliArgs } from '../src/cli/args.js'

describe('graph CLI command', () => {
  it('parses graph with mode', () => {
    const parsed = parseCliArgs(['graph', 'Hermes', '--mode', 'local'])
    expect(parsed.command).toBe('graph')
    expect(parsed.target).toBe('Hermes')
    expect(parsed.mode).toBe('local')
  })
  it('parses graph with json flag', () => {
    const parsed = parseCliArgs(['graph', 'FTS5', '--json'])
    expect(parsed.command).toBe('graph')
    expect(parsed.target).toBe('FTS5')
    expect(parsed.json).toBe(true)
  })
  it('parses graph without positional as prompt fallback', () => {
    const parsed = parseCliArgs(['graph', '--mode', 'global'])
    expect(parsed.command).toBe('graph')
    expect(parsed.mode).toBe('global')
  })
  it('does not let query tokens override the command (search "graph")', () => {
    const parsed = parseCliArgs(['search', 'graph'])
    expect(parsed.command).toBe('search')
    expect(parsed.prompt).toBe('graph')
    expect(parsed.target).toBe('graph')
  })
  it('parses graph recall with secondary query', () => {
    const parsed = parseCliArgs(['graph', 'recall', 'FTS5'])
    expect(parsed.command).toBe('graph')
    expect(parsed.target).toBe('recall')
    expect(parsed.secondary).toBe('FTS5')
  })
})