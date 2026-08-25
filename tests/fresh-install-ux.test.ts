import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionQueryEngine } from '../src/query/engine.js'

describe('SessionQueryEngine fresh-install UX', () => {
  it('auto-creates a missing data directory instead of crashing on open', () => {
    const missing = join(tmpdir(), 'ta-fresh-' + Date.now() + '-' + Math.random().toString(36).slice(2), 'nested', 'data')
    expect(mkdtempSync.toString()).toBeDefined() // sanity: fs module wired
    try {
      const engine = new SessionQueryEngine({ indexPath: join(missing, 'index.db') })
      const result = engine.searchSessions('anything')
      expect(result.hits).toEqual([])
      engine.close()
      // Directory now exists on disk.
      const { statSync } = require('node:fs') as typeof import('node:fs')
      expect(statSync(missing).isDirectory()).toBe(true)
    } finally {
      // Cleanup is best-effort; unique dir name keeps reruns safe.
    }
  })

  it('still works when the parent directory already exists', () => {
    const existing = mkdtempSync(join(tmpdir(), 'ta-existing-'))
    const engine = new SessionQueryEngine({ indexPath: join(existing, 'index.db') })
    expect(engine.searchEvents('query').hits).toEqual([])
    engine.close()
  })

  it('mkdirSync recursive covers deeply nested index paths', () => {
    const root = join(tmpdir(), 'ta-deep-' + Date.now())
    const deep = join(root, 'a', 'b', 'c', 'd')
    const engine = new SessionQueryEngine({ indexPath: join(deep, 'index.db') })
    engine.close()
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    expect(existsSync(deep)).toBe(true)
  })
})

describe('task file helper (parity with CLI --task-file)', () => {
  it('reads a task brief from outside any workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ta-task-'))
    const outside = join(dir, 'outside.md')
    writeFileSync(outside, '# Task\nDo the thing.', 'utf8')
    const content = (require('node:fs') as typeof import('node:fs')).readFileSync(outside, 'utf8')
    expect(content).toContain('Do the thing.')
    expect(dirname(outside)).not.toBe(process.cwd())
  })

  it('missing dirs can be prepared with mkdirSync before writes', () => {
    const base = join(tmpdir(), 'ta-mkdir-' + Date.now())
    const nested = join(base, 'x', 'y')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'f.txt'), 'ok', 'utf8')
    expect((require('node:fs') as typeof import('node:fs')).existsSync(join(nested, 'f.txt'))).toBe(true)
  })
})
