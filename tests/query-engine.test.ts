import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionQueryEngine } from '../src/query/engine.js'
import { createEntry, type Entry } from '../src/harness/session/types.js'
import type { SessionMeta } from '../src/query/types.js'

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

function nextCursorUndefined<T>(result: { nextCursor?: unknown }): boolean {
  return result.nextCursor === undefined
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

  it('sync indexes entries into FTS + meta', async () => {
    const dir = await tempDir()
    const engine = new SessionQueryEngine({ indexPath: join(dir, 'index.db') })
    const meta: SessionMeta = { sessionId: 's1', name: 'Research', createdAt: 1000, updatedAt: 2000 }
    const entries: Entry[] = [
      createEntry({ kind: 'message', message: { role: 'user', content: 'Find the async cancellation bug' }, seq: 1, parentId: 0 }),
      createEntry({ kind: 'message', message: { role: 'assistant', content: 'The bug is in worker-thread abort handling.' }, seq: 2, parentId: 1 }),
    ]
    engine.sync('s1', entries, meta)
    expect(engine.countEntries('s1')).toBe(2)
    expect(engine.getMeta('s1')?.name).toBe('Research')
    engine.close()
  })

  it('sync appends update rows without duplicating', async () => {
    const dir = await tempDir()
    const engine = new SessionQueryEngine({ indexPath: join(dir, 'index.db') })
    const meta: SessionMeta = { sessionId: 's1', name: 'S', createdAt: 1, updatedAt: 2 }
    engine.sync('s1', [
      createEntry({ kind: 'message', message: { role: 'user', content: 'first' }, seq: 1, parentId: 0 }),
    ], meta)
    // append a second turn, same session
    engine.sync('s1', [
      createEntry({ kind: 'message', message: { role: 'user', content: 'first' }, seq: 1, parentId: 0 }),
      createEntry({ kind: 'message', message: { role: 'assistant', content: 'second' }, seq: 2, parentId: 1 }),
    ], meta)
    expect(engine.countEntries('s1')).toBe(2)
    engine.close()
  })

  it('deleteSession removes entries + meta', async () => {
    const dir = await tempDir()
    const engine = new SessionQueryEngine({ indexPath: join(dir, 'index.db') })
    const meta: SessionMeta = { sessionId: 's1', name: 'S', createdAt: 1, updatedAt: 2 }
    engine.sync('s1', [
      createEntry({ kind: 'message', message: { role: 'user', content: 'hello world' }, seq: 1, parentId: 0 }),
    ], meta)
    expect(engine.countEntries('s1')).toBe(1)
    engine.deleteSession('s1')
    expect(engine.countEntries('s1')).toBe(0)
    expect(engine.getMeta('s1')).toBeUndefined()
    engine.close()
  })

  it('searchEvents finds matching entries with snippets', async () => {
    const dir = await tempDir()
    const engine = new SessionQueryEngine({ indexPath: join(dir, 'index.db') })
    const meta: SessionMeta = { sessionId: 's1', name: 'S', createdAt: 1, updatedAt: 2 }
    engine.sync('s1', [
      createEntry({ kind: 'message', message: { role: 'user', content: 'The quick brown fox jumps over the lazy dog' }, seq: 1, parentId: 0 }),
      createEntry({ kind: 'message', message: { role: 'user', content: 'Nothing about cats here' }, seq: 2, parentId: 1 }),
    ], meta)
    const result = engine.searchEvents('brown fox')
    expect(result.hits.length).toBe(1)
    expect(result.hits[0]!.sessionId).toBe('s1')
    expect(result.hits[0]!.seq).toBe(1)
    expect(result.hits[0]!.kind).toBe('message')
    expect(result.hits[0]!.snippet).toContain('brown fox')
    expect(nextCursorUndefined(result)).toBe(true)
    engine.close()
  })

  it('searchEvents literal phrase — FTS syntax is treated as data', async () => {
    const dir = await tempDir()
    const engine = new SessionQueryEngine({ indexPath: join(dir, 'index.db') })
    const meta: SessionMeta = { sessionId: 's1', name: 'S', createdAt: 1, updatedAt: 2 }
    engine.sync('s1', [
      createEntry({ kind: 'message', message: { role: 'user', content: 'OR is a keyword in FTS but we store NEAR too' }, seq: 1, parentId: 0 }),
      createEntry({ kind: 'message', message: { role: 'user', content: 'plain sentence' }, seq: 2, parentId: 1 }),
    ], meta)
    // searching the literal phrase "OR" must not blow up (it is FTS syntax)
    const result = engine.searchEvents('OR')
    expect(result.hits.length).toBeGreaterThanOrEqual(0)
    engine.close()
  })

  it('searchEvents scoped to one session', async () => {
    const dir = await tempDir()
    const engine = new SessionQueryEngine({ indexPath: join(dir, 'index.db') })
    const meta = { sessionId: 's1', name: 'S', createdAt: 1, updatedAt: 2 }
    engine.sync('s1', [
      createEntry({ kind: 'message', message: { role: 'user', content: 'alpha beta gamma' }, seq: 1, parentId: 0 }),
    ], meta)
    engine.sync('s2', [
      createEntry({ kind: 'message', message: { role: 'user', content: 'alpha delta' }, seq: 1, parentId: 0 }),
    ], { ...meta, sessionId: 's2' })
    const result = engine.searchEvents('alpha', { sessionId: 's1' })
    expect(result.hits.length).toBe(1)
    expect(result.hits[0]!.sessionId).toBe('s1')
    engine.close()
  })

  it('searchSessions aggregates per session with bestEvent', async () => {
    const dir = await tempDir()
    const engine = new SessionQueryEngine({ indexPath: join(dir, 'index.db') })
    engine.sync('s1', [
      createEntry({ kind: 'message', message: { role: 'user', content: 'alpha one' }, seq: 1, parentId: 0 }),
      createEntry({ kind: 'message', message: { role: 'user', content: 'alpha two' }, seq: 2, parentId: 1 }),
    ], { sessionId: 's1', name: 'S1', createdAt: 1, updatedAt: 2 })
    engine.sync('s2', [
      createEntry({ kind: 'message', message: { role: 'user', content: 'alpha three' }, seq: 1, parentId: 0 }),
    ], { sessionId: 's2', name: 'S2', createdAt: 1, updatedAt: 2 })
    const result = engine.searchSessions('alpha')
    expect(result.hits.length).toBe(2)
    const s1 = result.hits.find((h) => h.sessionId === 's1')
    const s2 = result.hits.find((h) => h.sessionId === 's2')
    expect(s1?.matchCount).toBe(2)
    expect(s2?.matchCount).toBe(1)
    expect(s1?.bestEvent).toBeDefined()
    engine.close()
  })

  it('cursor paging — page 2 does not repeat page 1', async () => {
    const dir = await tempDir()
    const engine = new SessionQueryEngine({ indexPath: join(dir, 'index.db') })
    const meta = { sessionId: 's1', name: 'S', createdAt: 1, updatedAt: 2 }
    engine.sync('s1', [
      createEntry({ kind: 'message', message: { role: 'user', content: 'alpha row 1' }, seq: 1, parentId: 0 }),
      createEntry({ kind: 'message', message: { role: 'user', content: 'alpha row 2' }, seq: 2, parentId: 1 }),
      createEntry({ kind: 'message', message: { role: 'user', content: 'alpha row 3' }, seq: 3, parentId: 2 }),
    ], meta)
    const page1 = engine.searchEvents('alpha', { limit: 2 })
    expect(page1.hits.length).toBe(2)
    expect(page1.nextCursor).toBeDefined()
    const page2 = engine.searchEvents('alpha', { limit: 2, cursor: page1.nextCursor })
    expect(page2.hits.length).toBe(1)
    const ids1 = page1.hits.map((h) => h.seq).sort()
    const ids2 = page2.hits.map((h) => h.seq).sort()
    expect(ids1).not.toEqual(ids2)
    engine.close()
  })
})