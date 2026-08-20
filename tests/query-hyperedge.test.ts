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

  it('sessionId filter must apply to BOTH relation endpoints (SQL precedence — dogfood finding 1)', async () => {
    const { engine, dir } = await seedEngine()
    try {
      // s2: A builds X — an unrelated session whose entity name collides with s1's A.
      engine.sync('s2', [
        { kind: 'message', seq: 1, parentId: 0, timestamp: 1, message: { role: 'user', content: 'A builds the X system in another session' } },
      ], { sessionId: 's2', name: 'other', createdAt: 0, updatedAt: 1 })
      engine.setEntities('s2', [{ name: 'A', type: 'project' }])
      engine.setRelations('s2', [{ source: 'A', kind: 'builds', target: 'X' }])

      // Scoped search in s1: relation rows must ONLY come from s1.
      const related = engine.searchRelated('A', { sessionId: 's1', maxHops: 2 })
      const xHit = related.hits.find((h) => h.entity === 'X')
      // X lives in s2 — a leak would surface it because source A matches without the sid guard.
      expect(xHit).toBeUndefined()
      // sanity: scoped still surfaces s1 transitive hits (B hop1, C hop2)
      expect(related.hits.some((h) => h.entity === 'B')).toBe(true)
      expect(related.hits.some((h) => h.entity === 'C')).toBe(true)
      // and every hit row must belong to s1
      expect(related.hits.every((h) => h.sessionId === 's1')).toBe(true)
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