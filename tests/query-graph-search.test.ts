import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionQueryEngine } from '../src/query/engine.js'
import type { Entry } from '../src/harness/session/types.js'
import type { GraphEntity, GraphRelation } from '../src/query/graph-types.js'
import type { SessionMeta } from '../src/query/types.js'

function entry(text: string, seq = 1): Entry {
  return {
    kind: 'message',
    seq,
    parentId: seq - 1,
    timestamp: 0,
    message: { role: 'user', content: text },
  } as unknown as Entry
}
const meta: SessionMeta = { sessionId: 's1', name: '', createdAt: 0, updatedAt: 0 }

function seeded(dir: string, entities: GraphEntity[], relations: GraphRelation[], entries: Array<[string, number]>): SessionQueryEngine {
  const engine = new SessionQueryEngine({ indexPath: join(dir, 'index.db') })
  engine.setEntities('s1', entities)
  engine.setRelations('s1', relations)
  engine.sync(
    's1',
    entries.map(([text, seq]) => entry(text, seq)),
    meta,
  )
  return engine
}

describe('searchGraph local', () => {
  let dir: string
  let engine: SessionQueryEngine
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'graph-search-'))
    engine = seeded(
      dir,
      [
        { name: 'Hermes', type: 'agent', description: 'assistant' },
        { name: 'tony-agent', type: 'project', description: 'harness' },
        { name: 'FTS5', type: 'tech', description: 'full text search' },
      ],
      [
        { source: 'Hermes', target: 'tony-agent', kind: 'builds' },
        { source: 'tony-agent', target: 'FTS5', kind: 'uses' },
      ],
      [
        ['Hermes builds tony-agent', 1],
        ['tony-agent uses FTS5', 2],
      ],
    )
  })
  afterEach(async () => {
    engine.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('returns events connected to seed entities (1 hop)', () => {
    const result = engine.searchGraph('Hermes', { mode: 'local' })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits.some((h) => h.seq === 1)).toBe(true)
  })

  it('expands through relations (2 hops) to related entities', () => {
    const result = engine.searchGraph('Hermes', { mode: 'local', maxHops: 2 })
    const seqs = result.hits.map((h) => h.seq)
    expect(seqs).toContain(2) // FTS5 event via tony-agent
  })

  it('returns empty when no entity matches', () => {
    const result = engine.searchGraph('zqzx', { mode: 'local' })
    expect(result.hits).toEqual([])
  })

  it('supports sessionId filter', () => {
    const result = engine.searchGraph('Hermes', { mode: 'local', sessionId: 's2' })
    expect(result.hits).toEqual([])
  })
})