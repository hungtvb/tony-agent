import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseCliArgs } from '../src/cli/args.js'

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  bin?: Record<string, string>
  version?: string
}

describe('CLI packaging (install → run tony)', () => {
  it('exposes both tony-agent and tony bins', () => {
    expect(pkg.bin).toBeDefined()
    expect(pkg.bin!['tony-agent']).toBe('./dist/cli/main.js')
    expect(pkg.bin!['tony']).toBe('./dist/cli/main.js')
  })

  it('dist bin starts with node shebang', () => {
    const head = readFileSync(join(process.cwd(), 'dist/cli/main.js'), 'utf8').split('\n')[0]
    expect(head).toBe('#!/usr/bin/env node')
  })

  it('parses version as a command', () => {
    const parsed = parseCliArgs(['version'])
    expect(parsed.command).toBe('version')
  })

  it('no args still defaults to run (interactive REPL)', () => {
    const parsed = parseCliArgs([])
    expect(parsed.command).toBe('run')
    expect(parsed.prompt).toBeUndefined()
  })
})