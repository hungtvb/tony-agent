import { describe, it, expect } from 'vitest'
import { GroupPlanner } from '../src/plan/group.js'
import type { GraphEntity, GraphRelation } from '../src/query/graph-types.js'

const e = (name: string, type: string): GraphEntity => ({ name, type })
const r = (source: string, kind: string, target: string): GraphRelation => ({ source, kind, target })

describe('GroupPlanner', () => {
  it('clusters entities by type and derives dependency edges from relations', () => {
    const planner = new GroupPlanner()
    const plan = planner.plan('build search', [
      e('App', 'project'),
      e('FTS5', 'tech'),
    ], [
      r('App', 'uses', 'FTS5'),
    ])
    expect(plan.tasks.length).toBe(2)
    const projectTask = plan.tasks.find((t) => t.entityScope.includes('App'))
    const techTask = plan.tasks.find((t) => t.entityScope.includes('FTS5'))
    expect(projectTask).toBeDefined()
    expect(techTask).toBeDefined()
    // edge: project task → tech task (builder before user)
    expect(techTask!.dependsOn).toContain(projectTask!.id)
    // topological order: project before tech
    const ids = plan.tasks.map((t) => t.id)
    expect(ids.indexOf(projectTask!.id)).toBeLessThan(ids.indexOf(techTask!.id))
    expect(plan.edges.some((ed) => ed.from === projectTask!.id && ed.to === techTask!.id && ed.kind === 'uses')).toBe(true)
  })

  it('chain of relations produces topological order', () => {
    const planner = new GroupPlanner()
    const plan = planner.plan('ship', [
      e('Design', 'project'),
      e('Build', 'project'),
      e('Test', 'project'),
    ], [
      r('Design', 'builds', 'Build'),
      r('Build', 'builds', 'Test'),
    ])
    // all same type → one task group, no edges
    expect(plan.tasks.length).toBe(1)
    expect(plan.edges.length).toBe(0)
  })

  it('different types with chain produce order', () => {
    const planner = new GroupPlanner()
    const plan = planner.plan('ship', [
      e('Design', 'design'),
      e('Build', 'build'),
      e('Test', 'test'),
    ], [
      r('Design', 'builds', 'Build'),
      r('Build', 'builds', 'Test'),
    ])
    const ids = plan.tasks.map((t) => t.id)
    const designId = plan.tasks.find((t) => t.entityScope.includes('Design'))!.id
    const buildId = plan.tasks.find((t) => t.entityScope.includes('Build'))!.id
    const testId = plan.tasks.find((t) => t.entityScope.includes('Test'))!.id
    expect(ids.indexOf(designId)).toBeLessThan(ids.indexOf(buildId))
    expect(ids.indexOf(buildId)).toBeLessThan(ids.indexOf(testId))
  })

  it('caps tasks via maxTasks; isolated entities become standalone tasks', () => {
    const planner = new GroupPlanner({ maxTasks: 1 })
    const plan = planner.plan('x', [
      e('A', 'alpha'),
      e('B', 'beta'),
    ], [])
    expect(plan.tasks.length).toBe(1)
    const planner2 = new GroupPlanner()
    const plan2 = planner2.plan('x', [e('A', 'alpha'), e('B', 'beta')], [])
    expect(plan2.tasks.length).toBe(2)
    expect(plan2.tasks.every((t) => t.dependsOn.length === 0)).toBe(true)
    // deterministic name order
    expect(plan2.tasks[0]!.entityScope).toEqual(['A'])
  })

  it('empty input → empty plan', () => {
    const planner = new GroupPlanner()
    expect(planner.plan('nothing', [], [])).toEqual({ goal: 'nothing', tasks: [], edges: [] })
  })
})