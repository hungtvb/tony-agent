import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionQueryEngine } from '../src/query/engine.js'

const SCHEMA_VERSION = 2

const directories: string[] = []
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'query-engine-'))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function openProbe(path: string) {
  const { createRequire } = await import('node:module')
  const Better = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
  return new Better(path)
}

describe('SessionQueryEngine skeleton', () => {
  it('creates a derived index DB with durability pragmas', async () => {
    const dir = await tempDir()
    const engine = new SessionQueryEngine({ indexPath: join(dir, 'index.db') })
    expect(engine).toBeDefined()
    engine.close()
  })

  it('applies WAL + foreign_keys + user_version on open', async () => {
    const dir = await tempDir()
    const path = join(dir, 'index.db')
    const engine = new SessionQueryEngine({ indexPath: path })
    engine.close()
    const probe = await openProbe(path)
    expect(probe.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(probe.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    probe.close()
  })

  it('throws on newer schema version (fail fast)', async () => {
    const dir = await tempDir()
    const path = join(dir, 'index.db')
    const probe = await openProbe(path)
    probe.pragma(`user_version = ${SCHEMA_VERSION + 1}`)
    probe.close()
    expect(() => new SessionQueryEngine({ indexPath: path })).toThrow(/newer than supported/)
  })

  it('rebuilds schema when the DB is older (migration)', async () => {
    const dir = await tempDir()
    const path = join(dir, 'index.db')
    const probe = await openProbe(path)
    probe.pragma('user_version = 1')
    probe.exec('CREATE TABLE old_table (x INTEGER)')
    probe.close()
    const engine = new SessionQueryEngine({ indexPath: path })
    expect(engine).toBeDefined()
    engine.close()
  })

  it('is isolated from the persistence DB (derived index)', async () => {
    const dir = await tempDir()
    const engine = new SessionQueryEngine({ indexPath: join(dir, 'index.db') })
    const tables = engine.listTables()
    expect(tables).not.toContain('entries')
    expect(tables.some((t) => t.includes('session'))).toBe(true)
    engine.close()
  })
})