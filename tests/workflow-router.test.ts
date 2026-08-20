import { describe, it, expect } from 'vitest'
import { GraphRouter } from '../src/workflow/router.js'
import { SessionQueryEngine } from '../src/query/engine.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Seed a small graph: s1 (Hermes→tony-agent→FTS5), s2 (other topic). */
async function seedEngine() {
  const dir = await mkdtemp(join(tmpdir(), 'router-'))
  const engine = new SessionQueryEngine({ indexPath: join(dir, 'index.db') })
  // s1 entries mentioning FTS5 + Hermes
  engine.sync('s1', [
    { kind: 'message', seq: 1, parentId: 0, timestamp: 1, message: { role: 'user', content: 'Hermes uses FTS5 search over sessions' } },
    { kind: 'message', seq: 2, parentId: 0, timestamp: 2, message: { role: 'assistant', content: 'tony-agent wires FTS5 into the query engine' } },
  ], { sessionId: 's1', name: 'graph work', createdAt: 0, updatedAt: 2 })
  engine.setEntities('s1', [
    { name: 'Hermes', type: 'product' },
    { name: 'tony-agent', type: 'project' },
    { name: 'FTS5', type: 'tech' },
  ])
  engine.setRelations('s1', [
    { source: 'Hermes', kind: 'uses', target: 'FTS5' },
    { source: 'tony-agent', kind: 'wires', target: 'FTS5' },
  ])
  // s2 unrelated
  engine.sync('s2', [
    { kind: 'message', seq: 1, parentId: 0, timestamp: 1, message: { role: 'user', content: 'Deploy the docker container' } },
  ], { sessionId: 's2', name: 'deploy', createdAt: 0, updatedAt: 1 })
  engine.setEntities('s2', [{ name: 'Docker', type: 'tech' }])
  engine.setRelations('s2', [])
  return { engine, dir }
}

describe('GraphRouter', () => {
  it('routes a query to the top entity + matching session', async () => {
    const { engine, dir } = await seedEngine()
    try {
      const router = new GraphRouter(engine)
      const route = router.route('FTS5')
      expect(route.query).toBe('FTS5')
      expect(route.entities.length).toBeGreaterThan(0)
      const fts = route.entities.find((e) => e.name === 'FTS5')
      expect(fts).toBeDefined()
      expect(fts!.type).toBe('tech')
      expect(fts!.hop).toBe(0)
      expect(fts!.sessions).toContain('s1')
      expect(route.sessions.length).toBeGreaterThan(0)
      expect(route.sessions.some((s) => s.sessionId === 's1' && s.matchCount >= 1)).toBe(true)
    } finally {
      engine.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('recommends the lineage parent when it shares the top entity', async () => {
    const { engine, dir } = await seedEngine()
    try {
      // s1 branches from parent p1 which also mentions FTS5
      engine.setBranchParent('s1', 'p1')
      engine.sync('p1', [
        { kind: 'message', seq: 1, parentId: 0, timestamp: 0, message: { role: 'user', content: 'FTS5 experiments start here' } },
      ], { sessionId: 'p1', name: 'parent', createdAt: 0, updatedAt: 0 })
      engine.setEntities('p1', [{ name: 'FTS5', type: 'tech' }])
      engine.setRelations('p1', [])

      const router = new GraphRouter(engine)
      const route = router.route('FTS5', { sessionId: 's1' })
      expect(route.recommended?.continueSessionId).toBe('p1')
    } finally {
      engine.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns empty route for unknown query (no throw)', async () => {
    const { engine, dir } = await seedEngine()
    try {
      const router = new GraphRouter(engine)
      const route = router.route('ZzzUnknown')
      expect(route.entities).toEqual([])
      expect(route.sessions).toEqual([])
      expect(route.recommended).toBeUndefined()
    } finally {
      engine.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('swallows lineage cycles instead of throwing', async () => {
    const { engine, dir } = await seedEngine()
    try {
      // p1 → s1, s1 → p1 (cycle)
      engine.sync('p1', [
        { kind: 'message', seq: 1, parentId: 0, timestamp: 0, message: { role: 'user', content: 'FTS5 cycle test' } },
      ], { sessionId: 'p1', name: 'cycle', createdAt: 0, updatedAt: 0 })
      engine.setEntities('p1', [{ name: 'FTS5', type: 'tech' }])
      engine.setBranchParent('s1', 'p1')
      engine.setBranchParent('p1', 's1')
      const router = new GraphRouter(engine)
      const route = router.route('FTS5', { sessionId: 's1' })
      // entities still found; no recommendation, no throw
      expect(route.entities.some((e) => e.name === 'FTS5')).toBe(true)
      expect(route.recommended).toBeUndefined()
    } finally {
      engine.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('limits sessions via limit option', async () => {
    const { engine, dir } = await seedEngine()
    try {
      const router = new GraphRouter(engine)
      const route = router.route('FTS5', { limit: 1 })
      expect(route.sessions.length).toBeLessThanOrEqual(1)
    } finally {
      engine.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})