import { describe, it, expect } from 'vitest'
import { WorkflowEngine } from '../src/workflow/engine.js'
import { GraphRouter } from '../src/workflow/router.js'
import { SubagentRegistry } from '../src/subagent/registry.js'
import { SessionQueryEngine } from '../src/query/engine.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function seedEngine() {
  const dir = await mkdtemp(join(tmpdir(), 'engine-router-'))
  const engine = new SessionQueryEngine({ indexPath: join(dir, 'index.db') })
  engine.sync('s1', [
    { kind: 'message', seq: 1, parentId: 0, timestamp: 1, message: { role: 'user', content: 'Hermes uses FTS5 search over sessions' } },
  ], { sessionId: 's1', name: 'graph work', createdAt: 0, updatedAt: 1 })
  engine.setEntities('s1', [
    { name: 'Hermes', type: 'product' },
    { name: 'FTS5', type: 'tech' },
  ])
  engine.setRelations('s1', [{ source: 'Hermes', kind: 'uses', target: 'FTS5' }])
  return { engine, dir }
}

/** Empty registry with a dummy in-process provider so PROVIDER_UNAVAILABLE passes. */
function makeRegistry(seen?: string[]) {
  const reg = new SubagentRegistry()
  reg.register({
    name: 'in-process',
    start: async (req: { prompt: string }) => {
      seen?.push(req.prompt)
      return { ok: true, output: `done:${req.prompt}` } as never
    },
  })
  return reg
}

describe('WorkflowEngine ctx.route()', () => {
  it('routes via ctx.route when a router is present', async () => {
    const { engine, dir } = await seedEngine()
    try {
      const wf = new WorkflowEngine({ registry: makeRegistry(), router: new GraphRouter(engine) })
      const run = wf.start(async (ctx) => {
        const r = await ctx.route('FTS5')
        return r.entities.length
      })
      const result = await run.result
      expect(result.stopReason).toBe('completed')
      expect(result.value).toBe(1) // FTS5 (the query-matched entity)
      // relations should still expose Hermes→FTS5 edge
      const r = await new GraphRouter(engine).route('FTS5')
      expect(r.relations.some((rel) => rel.source === 'Hermes' && rel.target === 'FTS5')).toBe(true)
    } finally {
      engine.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('caches route per run — same object identity on second call', async () => {
    const { engine, dir } = await seedEngine()
    try {
      const wf = new WorkflowEngine({ registry: makeRegistry(), router: new GraphRouter(engine) })
      const run = wf.start(async (ctx) => {
        const a = await ctx.route('FTS5')
        const b = await ctx.route('FTS5')
        return a === b
      })
      const result = await run.result
      expect(result.value).toBe(true)
    } finally {
      engine.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('throws ROUTER_UNAVAILABLE when no router is configured', async () => {
    const wf = new WorkflowEngine({ registry: makeRegistry() })
    const run = wf.start(async (ctx) => {
      await ctx.route('x')
      return 1
    })
    const result = await run.result
    // engine wraps script errors into run.error
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('ROUTER_UNAVAILABLE')
  })

  it('routeAgents fans out one subagent per top entity', async () => {
    const { engine, dir } = await seedEngine()
    const seen: string[] = []
    try {
      const wf = new WorkflowEngine({ registry: makeRegistry(seen), router: new GraphRouter(engine) })
      const run = wf.start(async (ctx) => {
        const results = await ctx.routeAgents('FTS5', 'summarize {entity}')
        return results.length
      })
      const result = await run.result
      expect(result.stopReason).toBe('completed')
      expect(result.value).toBe(1) // FTS5 only (query-matched entity)
      expect(seen).toEqual(['summarize FTS5'])
    } finally {
      engine.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})