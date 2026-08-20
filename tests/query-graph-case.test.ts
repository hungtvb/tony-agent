import { describe, it, expect } from 'vitest'
import { SessionQueryEngine } from '../src/query/engine.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function seed() {
  const dir = await mkdtemp(join(tmpdir(), 'case-'))
  const engine = new SessionQueryEngine({ indexPath: join(dir, 'index.db') })
  engine.sync('s1', [
    { kind: 'message', seq: 1, parentId: 0, timestamp: 1, message: { role: 'user', content: 'A builds the B system' } },
    { kind: 'message', seq: 2, parentId: 0, timestamp: 2, message: { role: 'user', content: 'B uses C library for queries' } },
  ], { sessionId: 's1', name: 'c', createdAt: 0, updatedAt: 2 })
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

describe('graph search case-sensitivity (LIKE false-positive fix)', () => {
  it('searchGraph local does not match entity A to the word "library"', async () => {
    const { engine, dir } = await seed()
    try {
      const res = engine.searchGraph('A', { mode: 'local', maxHops: 2 })
      // No hit for entity A may point at a snippet lacking the token A
      // (LIKE would have matched "library" via its lowercase 'a').
      for (const hit of res.hits) {
        if (hit.entity === 'A') {
          expect(hit.snippet).toMatch(/\bA\b/)
        }
      }
      // B is reached through the relation edge (expansion works)
      const ids = res.hits.map((h) => h.entity)
      expect(ids).toContain('B')
    } finally {
      engine.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('searchGraph global does not cross-match case', async () => {
    const { engine, dir } = await seed()
    try {
      const res = engine.searchGraph('A', { mode: 'global' })
      for (const hit of res.hits) {
        if (hit.entity === 'A') {
          expect(hit.snippet).not.toMatch(/\blibrary\b/)
        }
      }
    } finally {
      engine.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})