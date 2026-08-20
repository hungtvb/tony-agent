import { describe, it, expect } from 'vitest'
import { SessionQueryEngine } from '../src/query/engine.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function seedEngine() {
  const dir = await mkdtemp(join(tmpdir(), 'hyper-'))
  const engine = new SessionQueryEngine({ indexPath: join(dir, 'index.db') })
  // s1: A builds B (no direct A↔C mention); B uses C (transitive A→C)
  engine.sync('s1', [
    { kind: 'message', seq: 1, parentId: 0, timestamp: 1, message: { role: 'user', content: 'A builds the B system' } },
    { kind: 'message', seq: 2, parentId: 0, timestamp: 2, message: { role: 'user', content: 'B uses C library for queries' } },
  ], { sessionId: 's1', name: 'chain', createdAt: 0, updatedAt: 2 })
  engine.setEntities('s1', [
    { name: 'A', type: 'project' },
    { name: 'B', type: 'system' },
    { name: 'C', type: 'library' },
  ])
  engine.setRelations('s1', [
    { source: 'A', kind: 'builds', target: 'B' },
    { source: 'B', kind: 'uses', target: 'C' },
  ])
  return { engine, dir }
}

describe('searchRelated (SAG-style hyperedge)', () => {
  it('finds transitive hits beyond direct searchGraph local', async () => {
    const { engine, dir } = await seedEngine()
    try {
      // local with maxHops 2: seeds A, expands B (hop1), C (hop2)
      const local = engine.searchGraph('A', { mode: 'local', maxHops: 2 })
      const related = engine.searchRelated('A', { maxHops: 2 })
      // related surfaces the C event (hop 2) — transitive recall
      const cHit = related.hits.find((h) => h.entity === 'C')
      expect(cHit).toBeDefined()
      expect(cHit!.hop).toBe(2)
      // and the direct A/B hits
      const aHit = related.hits.find((h) => h.entity === 'A')
      expect(aHit).toBeDefined()
      // at least as many hits as local (equal or superset)
      expect(related.hits.length).toBeGreaterThanOrEqual(local.hits.length)
    } finally {
      engine.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('empty seed → no hits', async () => {
    const { engine, dir } = await seedEngine()
    try {
      const related = engine.searchRelated('ZzzNothing')
      expect(related.hits).toEqual([])
    } finally {
      engine.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('respects limit and maxHops bounds', async () => {
    const { engine, dir } = await seedEngine()
    try {
      const related = engine.searchRelated('A', { maxHops: 1, limit: 1 })
      expect(related.hits.length).toBeLessThanOrEqual(1)
      // maxHops 1 → C not reached (needs hop 2)
      expect(related.hits.every((h) => h.hop <= 1)).toBe(true)
    } finally {
      engine.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})