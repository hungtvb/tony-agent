import { describe, it, expect } from 'vitest'
import { GraphPlanner } from '../src/plan/planner.js'
import { SessionQueryEngine } from '../src/query/engine.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LLMCompleter } from '../src/types.js'

async function seedEngine() {
  const dir = await mkdtemp(join(tmpdir(), 'planner-'))
  const engine = new SessionQueryEngine({ indexPath: join(dir, 'index.db') })
  engine.sync('s1', [
    { kind: 'message', seq: 1, parentId: 0, timestamp: 1, message: { role: 'user', content: 'Hermes uses FTS5 to build session search' } },
    { kind: 'message', seq: 2, parentId: 0, timestamp: 2, message: { role: 'assistant', content: 'tony-agent wires FTS5 into the query engine' } },
  ], { sessionId: 's1', name: 'graph work', createdAt: 0, updatedAt: 2 })
  engine.setEntities('s1', [
    { name: 'Hermes', type: 'agent' },
    { name: 'tony-agent', type: 'project' },
    { name: 'FTS5', type: 'tech' },
  ])
  engine.setRelations('s1', [
    { source: 'Hermes', kind: 'uses', target: 'FTS5' },
    { source: 'tony-agent', kind: 'wires', target: 'FTS5' },
  ])
  return { engine, dir }
}

const failingLlm: LLMCompleter = {
  async complete() {
    throw new Error('LLM down')
  },
}

const jsonLlm: LLMCompleter = {
  async complete(req) {
    const text = req.messages[0]?.content ?? ''
    const count = (text.match(/scope/g) ?? []).length
    const tasks = Array.from({ length: Math.max(1, count - 1) }, (_, i) => ({
      id: `task-${i + 1}`,
      title: `Refined task ${i + 1}`,
      description: 'refined by LLM',
    }))
    return { text: JSON.stringify({ tasks }), toolCalls: [] }
  },
}

describe('GraphPlanner', () => {
  it('plans deterministically without an LLM', async () => {
    const { engine, dir } = await seedEngine()
    try {
      const planner = new GraphPlanner({ engine })
      const plan = await planner.plan('build search')
      expect(plan.goal).toBe('build search')
      expect(plan.tasks.length).toBeGreaterThanOrEqual(1)
      for (const task of plan.tasks) {
        expect(task.entityScope.length).toBeGreaterThan(0)
      }
      // FTS5-dependent task after its source task
      const fts5Task = plan.tasks.find((t) => t.entityScope.includes('FTS5'))
      if (fts5Task && fts5Task.dependsOn.length > 0) {
        const depIdx = plan.tasks.findIndex((t) => t.id === fts5Task.dependsOn[0])
        const fts5Idx = plan.tasks.findIndex((t) => t.id === fts5Task.id)
        expect(depIdx).toBeLessThan(fts5Idx)
      }
    } finally {
      engine.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('LLM failure → deterministic plan unchanged (fail-soft)', async () => {
    const { engine, dir } = await seedEngine()
    try {
      const planner = new GraphPlanner({ engine, llm: failingLlm })
      const plan = await planner.plan('build search')
      expect(plan.tasks.length).toBeGreaterThan(0)
      // no refinement applied — titles are defaults
      expect(plan.tasks.some((t) => t.title.startsWith('Refined'))).toBe(false)
    } finally {
      engine.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('LLM refinement upgrades titles when valid JSON', async () => {
    const { engine, dir } = await seedEngine()
    try {
      const planner = new GraphPlanner({ engine, llm: jsonLlm })
      const plan = await planner.plan('build search')
      expect(plan.tasks.length).toBeGreaterThan(0)
      expect(plan.tasks[0]!.title).toBe('Refined task 1')
    } finally {
      engine.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('respects maxTasks', async () => {
    const { engine, dir } = await seedEngine()
    try {
      const planner = new GraphPlanner({ engine, maxTasks: 1 })
      const plan = await planner.plan('build search')
      expect(plan.tasks.length).toBeLessThanOrEqual(1)
    } finally {
      engine.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})