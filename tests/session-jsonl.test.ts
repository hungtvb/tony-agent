import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonlSessionRepo, type Session } from '../src/harness/session/jsonl/repo.js'
import { createEntry } from '../src/harness/session/types.js'

const directories: string[] = []
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tony-repo-'))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('JsonlSessionRepo conformance', () => {
  it('creates a session and appends entries with seq continuity', async () => {
    const directory = await tempDir()
    const repo = new JsonlSessionRepo(directory)
    const session = await repo.create('s1')
    await session.append(createEntry({ seq: 1, parentId: 0, kind: 'message', message: { role: 'user', content: 'hi' } }))
    await session.append(createEntry({ seq: 2, parentId: 1, kind: 'message', message: { role: 'assistant', content: 'hello' } }))
    const entries = session.getEntries()
    expect(entries).toHaveLength(2)
    expect(entries[0]?.seq).toBe(1)
    expect(entries[1]?.seq).toBe(2)
  })

  it('reopens a session from disk with all entries', async () => {
    const directory = await tempDir()
    const repo = new JsonlSessionRepo(directory)
    const session = await repo.create('s2')
    await session.append(createEntry({ seq: 1, parentId: 0, kind: 'message', message: { role: 'user', content: 'persist' } }))
    await session.append(createEntry({ seq: 2, parentId: 1, kind: 'model_change', model: 'gpt-4o' }))

    const repo2 = new JsonlSessionRepo(directory)
    const reopened = await repo2.open('s2')
    const entries = reopened.getEntries()
    expect(entries).toHaveLength(2)
    expect(entries[1]?.kind).toBe('model_change')
  })

  it('branches from a specific entry', async () => {
    const directory = await tempDir()
    const repo = new JsonlSessionRepo(directory)
    const session = await repo.create('s3')
    await session.append(createEntry({ seq: 1, parentId: 0, kind: 'message', message: { role: 'user', content: 'a' } }))
    await session.append(createEntry({ seq: 2, parentId: 1, kind: 'message', message: { role: 'user', content: 'b' } }))
    await session.append(createEntry({ seq: 3, parentId: 2, kind: 'message', message: { role: 'user', content: 'c' } }))

    const branch = await repo.branch('s3', 's3-branch', 2)
    const entries = branch.getEntries()
    expect(entries).toHaveLength(2)
    expect(entries[0]?.seq).toBe(1)
    expect(entries[1]?.seq).toBe(2)
    await branch.append(createEntry({ seq: 3, parentId: 2, kind: 'message', message: { role: 'user', content: 'b2' } }))
    expect(branch.getEntries()).toHaveLength(3)
    // original session unchanged
    expect(session.getEntries()).toHaveLength(3)
  })

  it('handles a branch from another lane (branch_summary parent)', async () => {
    const directory = await tempDir()
    const repo = new JsonlSessionRepo(directory)
    const session = await repo.create('s4')
    await session.append(createEntry({ seq: 1, parentId: 0, kind: 'message', message: { role: 'user', content: 'x' } }))
    await session.append(createEntry({ seq: 2, parentId: 1, kind: 'message', message: { role: 'user', content: 'y' } }))
    const branch = await repo.branch('s4', 's4-b', 1)
    await branch.append(createEntry({ seq: 2, parentId: 1, kind: 'branch_summary', summary: 'diverged at 1', fromSeq: 1 }))
    await branch.append(createEntry({ seq: 3, parentId: 2, kind: 'message', message: { role: 'user', content: 'branch content' } }))
    const entries = branch.getEntries()
    expect(entries[1]?.kind).toBe('branch_summary')
    expect(entries[2]?.kind).toBe('message')
  })

  it('compacts by replacing tail with a summary entry', async () => {
    const directory = await tempDir()
    const repo = new JsonlSessionRepo(directory)
    const session = await repo.create('s5')
    for (let i = 1; i <= 10; i += 1) {
      await session.append(createEntry({ seq: i, parentId: i - 1, kind: 'message', message: { role: 'user', content: `m${i}` } }))
    }
    const compaction = createEntry({ seq: 11, parentId: 10, kind: 'compaction', reason: 'manual', summary: 'summarized', retainedTail: 3, tokensBefore: 9000 })
    await session.append(compaction)
    const compacted = session.getEntries()
    expect(compacted).toHaveLength(11)
    expect(compacted[10]?.kind).toBe('compaction')
  })

  it('survives a corrupted tail line (tolerance)', async () => {
    const directory = await tempDir()
    const repo = new JsonlSessionRepo(directory)
    const session = await repo.create('s6')
    await session.append(createEntry({ seq: 1, parentId: 0, kind: 'message', message: { role: 'user', content: 'valid' } }))
    // corrupt the file with a garbage line
    const indexPath = join(directory, 's6.jsonl')
    await readFile(indexPath, 'utf8')
    const fs = await import('node:fs/promises')
    await fs.appendFile(indexPath, '{not valid json\n')
    const repo2 = new JsonlSessionRepo(directory)
    const reopened = await repo2.open('s6')
    expect(reopened.getEntries()).toHaveLength(1)
  })

  it('lists and deletes sessions', async () => {
    const directory = await tempDir()
    const repo = new JsonlSessionRepo(directory)
    await repo.create('a')
    await repo.create('b')
    const names = await repo.list()
    expect(names).toContain('a')
    expect(names).toContain('b')
    await repo.delete('a')
    expect(await repo.list()).toEqual(['b'])
  })
})

describe('Session interface', () => {
  it('exposes id, entries and seq cursor', async () => {
    const directory = await tempDir()
    const repo = new JsonlSessionRepo(directory)
    const session: Session = await repo.create('s7')
    expect(session.id).toBe('s7')
    expect(session.getNextSeq()).toBe(1)
    await session.append(createEntry({ seq: 1, parentId: 0, kind: 'message', message: { role: 'user', content: 'z' } }))
    expect(session.getNextSeq()).toBe(2)
  })
})