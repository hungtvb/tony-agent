import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionQueryEngine } from '../src/query/engine.js'

describe('graph schema', () => {
  let dir: string
  let engine: SessionQueryEngine
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'graph-schema-'))
    engine = new SessionQueryEngine({ indexPath: join(dir, 'index.db') })
  })
  afterEach(async () => {
    engine.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('creates entities and relations tables', () => {
    const tables = engine.listTables()
    expect(tables).toContain('entities')
    expect(tables).toContain('relations')
  })

  it('rejects a newer schema version', () => {
    engine.close()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3')
    const db = new BetterSqlite3(join(dir, 'index.db'))
    db.pragma('user_version = 99')
    db.close()
    expect(() => new SessionQueryEngine({ indexPath: join(dir, 'index.db') })).toThrow(/newer than supported/)
  })
})
