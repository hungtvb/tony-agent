import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionStore } from '../src/session/store.js'
import { planCompaction } from '../src/session/compact.js'

const directories: string[] = []

async function createStore(): Promise<SessionStore> {
  const directory = await mkdtemp(join(tmpdir(), 'tony-agent-session-'))
  directories.push(directory)
  const store = new SessionStore(directory)
  await store.initialize()
  return store
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('SessionStore', () => {
  it('persists append-only entries and lists the created session', async () => {
    const store = await createStore()
    const session = await store.create('Research')
    await store.append(session.id, { role: 'user', content: 'Inspect this page' })
    await store.append(session.id, { role: 'assistant', content: 'I will inspect it.' })

    expect(await store.list()).toHaveLength(1)
    expect((await store.readEntries(session.id)).map((entry) => entry.content)).toEqual([
      'Inspect this page',
      'I will inspect it.',
    ])
  })

  it('branches from a selected parent entry and inherits only that history', async () => {
    const store = await createStore()
    const original = await store.create('Original')
    const first = await store.append(original.id, { role: 'user', content: 'first' })
    await store.append(original.id, { role: 'assistant', content: 'second' })

    const branch = await store.branch(original.id, first.id, 'Alternative')
    await store.append(branch.id, { role: 'assistant', content: 'branch answer' })

    expect((await store.readEntries(branch.id)).map((entry) => entry.content)).toEqual([
      'first',
      'branch answer',
    ])
  })

  it('exports a self-contained snapshot', async () => {
    const store = await createStore()
    const session = await store.create('Export')
    await store.append(session.id, { role: 'user', content: 'hello' })

    const snapshot = await store.export(session.id)
    expect(snapshot.info.name).toBe('Export')
    expect(snapshot.entries).toHaveLength(1)
  })
})

describe('planCompaction', () => {
  it('keeps recent entries intact and selects the oldest entries for summary', () => {
    const entries = [
      { id: '1', content: 'a'.repeat(100) },
      { id: '2', content: 'b'.repeat(100) },
      { id: '3', content: 'c'.repeat(100) },
    ]
    const plan = planCompaction(entries, {
      maxTokens: 20,
      keepRecentTokens: 10,
      estimate: (text) => Math.ceil(text.length / 10),
    })

    expect(plan?.source.map((entry) => entry.id)).toEqual(['1', '2'])
    expect(plan?.recent.map((entry) => entry.id)).toEqual(['3'])
  })

  it('does not compact a context that fits the token budget', () => {
    expect(planCompaction([{ id: '1', content: 'tiny' }], {
      maxTokens: 10,
      keepRecentTokens: 5,
      estimate: () => 1,
    })).toBeUndefined()
  })
})

describe('SessionStore lanes', () => {
  it('tags a session with a lane and lists by lane (newest first)', async () => {
    const store = await createStore()
    const a = await store.create('Alpha')
    const b = await store.create('Beta')
    const c = await store.create('Gamma')
    await store.setLane(a.id, 'research')
    await store.setLane(c.id, 'research')
    await store.setLane(b.id, 'coding')

    expect((await store.listByLane('research')).map((s) => s.id)).toEqual([c.id, a.id])
    expect((await store.listByLane('coding')).map((s) => s.id)).toEqual([b.id])
    expect(await store.listByLane('ops')).toEqual([])
  })

  it('clears a lane when set to empty / undefined', async () => {
    const store = await createStore()
    const session = await store.create('S')
    await store.setLane(session.id, 'ops')
    expect((await store.get(session.id))?.lane).toBe('ops')
    await store.setLane(session.id)
    expect((await store.get(session.id))?.lane).toBeUndefined()
  })

  it('survives index reload and guards long lane values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tony-agent-lane-'))
    directories.push(directory)
    const store = new SessionStore(directory)
    await store.initialize()
    const session = await store.create('Persist')
    await store.setLane(session.id, 'x'.repeat(200))
    const reloaded = new SessionStore(directory)
    await reloaded.initialize()
    expect((await reloaded.get(session.id))?.lane).toHaveLength(64)
  })
})
