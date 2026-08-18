import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteSessionRepo } from '../src/harness/session/sqlite.js'
import { createEntry } from '../src/harness/session/types.js'

const directories: string[] = []
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tony-sqlite-'))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('SqliteSessionRepo (conformance suite)', () => {
  it('sets durability + integrity pragmas on open', async () => {
    const directory = await tempDir()
    const repo = new SqliteSessionRepo(join(directory, 'sessions.db'))
    // expose internals for verification via a fresh handle
    const { createRequire } = await import('node:module')
    const Better = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
    const probe = new Better(join(directory, 'sessions.db'))
    expect(probe.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(probe.pragma('synchronous', { simple: true })).toBe(1) // NORMAL
    expect(probe.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(probe.pragma('user_version', { simple: true })).toBe(1)
    probe.close()
    repo.close()
  })

  it('rejects a database with a newer schema version', async () => {
    const directory = await tempDir()
    const dbPath = join(directory, 'sessions.db')
    const { createRequire } = await import('node:module')
    const Better = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
    const probe = new Better(dbPath)
    probe.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 0)')
    probe.pragma('user_version = 99')
    probe.close()
    expect(() => new SqliteSessionRepo(dbPath)).toThrow(/schema version 99 is newer than supported 1/)
  })

  it('throws on a corrupted database (integrity_check)', async () => {
    const directory = await tempDir()
    const dbPath = join(directory, 'sessions.db')
    const { createRequire } = await import('node:module')
    const Better = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
    const probe = new Better(dbPath)
    probe.exec('CREATE TABLE t (x INTEGER)')
    probe.exec('INSERT INTO t VALUES (1)')
    probe.close()
    // Flip bytes mid-file (page area, past the 100-byte header) so the file
    // still opens but integrity_check reports corruption.
    const { readFile, writeFile } = await import('node:fs/promises')
    const bytes = await readFile(dbPath)
    const offset = Math.min(bytes.length - 1, 4096)
    bytes[offset] = (bytes[offset] ?? 0) ^ 0xff
    await writeFile(dbPath, bytes)
    expect(() => new SqliteSessionRepo(dbPath)).toThrow(/integrity check failed/)
  })

  it('applies ON DELETE CASCADE when a session is deleted', async () => {
    const directory = await tempDir()
    const repo = new SqliteSessionRepo(join(directory, 'sessions.db'))
    const session = await repo.create('cascade')
    await session.append(createEntry({ seq: 1, parentId: 0, kind: 'message', message: { role: 'user', content: 'x' } }))
    await repo.delete('cascade')
    expect(await repo.list()).toEqual([])
    const { createRequire } = await import('node:module')
    const Better = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
    const probe = new Better(join(directory, 'sessions.db'))
    const orphans = probe.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }
    expect(orphans.n).toBe(0)
    probe.close()
    repo.close()
  })

  it('creates a session and appends entries with seq continuity', async () => {
    const directory = await tempDir()
    const repo = new SqliteSessionRepo(join(directory, 'sessions.db'))
    const session = await repo.create('s1')
    await session.append(createEntry({ seq: 1, parentId: 0, kind: 'message', message: { role: 'user', content: 'hi' } }))
    await session.append(createEntry({ seq: 2, parentId: 1, kind: 'message', message: { role: 'assistant', content: 'hello' } }))
    const entries = session.getEntries()
    expect(entries).toHaveLength(2)
    expect(entries[0]?.seq).toBe(1)
    expect(entries[1]?.seq).toBe(2)
  })

  it('reopens a session from db with all entries (WAL-safe)', async () => {
    const directory = await tempDir()
    const dbPath = join(directory, 'sessions.db')
    const repo = new SqliteSessionRepo(dbPath)
    const session = await repo.create('s2')
    await session.append(createEntry({ seq: 1, parentId: 0, kind: 'message', message: { role: 'user', content: 'persist' } }))
    await session.append(createEntry({ seq: 2, parentId: 1, kind: 'model_change', model: 'gpt-4o' }))

    const repo2 = new SqliteSessionRepo(dbPath)
    const reopened = await repo2.open('s2')
    const entries = reopened.getEntries()
    expect(entries).toHaveLength(2)
    expect(entries[1]?.kind).toBe('model_change')
  })

  it('branches from a specific entry', async () => {
    const directory = await tempDir()
    const repo = new SqliteSessionRepo(join(directory, 'sessions.db'))
    const session = await repo.create('s3')
    await session.append(createEntry({ seq: 1, parentId: 0, kind: 'message', message: { role: 'user', content: 'a' } }))
    await session.append(createEntry({ seq: 2, parentId: 1, kind: 'message', message: { role: 'user', content: 'b' } }))
    await session.append(createEntry({ seq: 3, parentId: 2, kind: 'message', message: { role: 'user', content: 'c' } }))

    const branch = await repo.branch('s3', 's3-branch', 2)
    expect(branch.getEntries()).toHaveLength(2)
    await branch.append(createEntry({ seq: 3, parentId: 2, kind: 'message', message: { role: 'user', content: 'b2' } }))
    expect(branch.getEntries()).toHaveLength(3)
    expect(session.getEntries()).toHaveLength(3)
  })

  it('lists and deletes sessions', async () => {
    const directory = await tempDir()
    const repo = new SqliteSessionRepo(join(directory, 'sessions.db'))
    await repo.create('a')
    await repo.create('b')
    const names = await repo.list()
    expect(names).toContain('a')
    expect(names).toContain('b')
    await repo.delete('a')
    expect(await repo.list()).toEqual(['b'])
  })
})