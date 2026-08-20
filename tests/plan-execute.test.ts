import { describe, it, expect } from 'vitest'
import { planToScript, executePlan, buildTaskPrompt } from '../src/plan/execute.js'
import { WorkflowEngine } from '../src/workflow/engine.js'
import { SubagentRegistry } from '../src/subagent/registry.js'
import type { Plan, TaskNode } from '../src/plan/types.js'
import type { SubagentRequest, SubagentResult } from '../src/subagent/registry.js'

function makePlan(goal: string, tasks: TaskNode[]): Plan {
  return { goal, tasks, edges: tasks.flatMap((t) => t.dependsOn.map((d) => ({ from: d, to: t.id, kind: 'dep' }))) }
}

function makeRegistry(seen: string[], failIds?: Set<string>) {
  const reg = new SubagentRegistry()
  reg.register({
    name: 'in-process',
    start: async (req: SubagentRequest): Promise<SubagentResult> => {
      seen.push(req.prompt)
      const id = req.prompt.match(/\[plan task\] (.*)/)?.[1] ?? ''
      if (failIds?.has(id)) throw new Error('task failed')
      return { childId: `child-${seen.length}`, text: `done:${id}`, toolCalls: 0, turns: 1, aborted: false }
    },
  })
  return reg
}

describe('planToScript', () => {
  it('executes tasks in topological order (deps first)', async () => {
    const seen: string[] = []
    const plan = makePlan('build', [
      { id: 't1', title: 'A', entityScope: ['a'], dependsOn: [] },
      { id: 't2', title: 'B', entityScope: ['b'], dependsOn: ['t1'] },
    ])
    const wf = new WorkflowEngine({ registry: makeRegistry(seen) })
    const run = wf.start(planToScript(plan))
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    const exec = result.value as { status: Record<string, string>; results: Record<string, unknown> }
    expect(exec.status.t1).toBe('done')
    expect(exec.status.t2).toBe('done')
    // t1 prompt before t2 prompt
    const t1Idx = seen.findIndex((p) => p.includes('A'))
    const t2Idx = seen.findIndex((p) => p.includes('B'))
    expect(t1Idx).toBeLessThan(t2Idx)
  })

  it('marks dependents skipped when a dependency fails', async () => {
    const seen: string[] = []
    const failIds = new Set(['B'])
    const plan = makePlan('build', [
      { id: 't1', title: 'A', entityScope: [], dependsOn: [] },
      { id: 't2', title: 'B', entityScope: [], dependsOn: ['t1'] },
      { id: 't3', title: 'C', entityScope: [], dependsOn: ['t2'] },
      { id: 't4', title: 'D', entityScope: [], dependsOn: [] },
    ])
    const wf = new WorkflowEngine({ registry: makeRegistry(seen, failIds) })
    const run = wf.start(planToScript(plan))
    const result = await run.result
    const exec = result.value as { status: Record<string, string> }
    expect(exec.status.t2).toBe('failed')
    expect(exec.status.t3).toBe('skipped')
    expect(exec.status.t4).toBe('done')
  })

  it('empty plan completes immediately', async () => {
    const wf = new WorkflowEngine({ registry: makeRegistry([]) })
    const run = wf.start(planToScript(makePlan('x', [])))
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.value).toEqual({ results: {}, status: {} })
  })

  it('executePlan helper runs via engine.start', async () => {
    const seen: string[] = []
    const plan = makePlan('go', [{ id: 't1', title: 'Solo', entityScope: [], dependsOn: [] }])
    const wf = new WorkflowEngine({ registry: makeRegistry(seen) })
    const run = executePlan(wf, plan)
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(seen.length).toBe(1)
  })

  it('buildTaskPrompt includes entity scope + goal', () => {
    const prompt = buildTaskPrompt({ id: 't1', title: 'Work on tech', entityScope: ['FTS5'], dependsOn: ['t0'] }, 'build search')
    expect(prompt).toContain('FTS5')
    expect(prompt).toContain('build search')
    expect(prompt).toContain('Depends on: t0')
  })
})