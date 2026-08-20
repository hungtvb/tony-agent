import { describe, it, expect } from 'vitest'
import { createRouteTools, formatGraphRoute } from '../src/query/plugin.js'
import { SessionQueryEngine } from '../src/query/engine.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function seedEngine() {
  const dir = await mkdtemp(join(tmpdir(), 'route-tool-'))
  const engine = new SessionQueryEngine({ indexPath: join(dir, 'index.db') })
  engine.sync('s1', [
    { kind: 'message', seq: 1, parentId: 0, timestamp: 1, message: { role: 'user', content: 'Hermes uses FTS5 search over sessions' } },
  ], { sessionId: 's1', name: 'graph work', createdAt: 0, updatedAt: 1 })
  engine.setEntities('s1', [
    { name: 'Hermes', type: 'product' },
    { name: 'FTS5', type: 'tech' },
  ])
  engine.setRelations('s1', [{ source: 'Hermes', kind: 'uses', target: 'FTS5' }])
  engine.sync('s2', [
    { kind: 'message', seq: 1, parentId: 0, timestamp: 1, message: { role: 'user', content: 'Deploy the docker container' } },
  ], { sessionId: 's2', name: 'deploy', createdAt: 0, updatedAt: 1 })
  engine.setEntities('s2', [{ name: 'Docker', type: 'tech' }])
  return { engine, dir }
}

describe('query:route tool', () => {
  it('produces a query_route tool that returns entity + session info', async () => {
    const { engine, dir } = await seedEngine()
    try {
      const [tool] = createRouteTools(engine, 'query_route')
      expect(tool.name).toBe('query_route')
      expect(tool.risk).toBe('read')
      const result = await tool.execute({ query: 'FTS5' }, {} as never)
      expect(result.isError).toBeFalsy()
      expect(result.content).toContain('FTS5')
      expect(result.content).toContain('[s1')
      expect(result.content).toContain('Entities:')
      expect(result.content).toContain('Sessions:')
    } finally {
      engine.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns No route candidates for empty route', async () => {
    const { engine, dir } = await seedEngine()
    try {
      const [tool] = createRouteTools(engine, 'query_route')
      const result = await tool.execute({ query: 'ZzzUnknown' }, {} as never)
      expect(result.content).toContain('No route candidates')
    } finally {
      engine.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('requires a non-empty query', async () => {
    const { engine, dir } = await seedEngine()
    try {
      const [tool] = createRouteTools(engine, 'query_route')
      const result = await tool.execute({ query: ' ' }, {} as never)
      expect(result.isError).toBe(true)
    } finally {
      engine.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('formatGraphRoute shows recommendation when present', () => {
    const content = formatGraphRoute({
      query: 'FTS5',
      entities: [{ name: 'FTS5', type: 'tech', hop: 0, sessions: ['s1'] }],
      relations: [],
      sessions: [{ sessionId: 's1', matchCount: 1, preview: 'FTS5 search' }],
      recommended: { continueSessionId: 's1', reason: 'clusters top entity' },
    })
    expect(content).toContain('Recommended: continue s1')
  })
})