/**
 * GroupPlanner — deterministic task DAG from graph entities/relations (v0.8).
 *
 * Pure function of the graph: entities of the same `type` cluster into one
 * task (entityScope), relations map to dependency edges (`dependsOn`),
 * then a topological sort fixes execution order. Zero LLM — the plan is
 * explainable and testable; LLM refinement is an optional upgrade layered
 * on top by `GraphPlanner` (see planner.ts).
 */
import type { GraphEntity, GraphRelation } from '../query/graph-types.js'
import type { Plan, TaskEdge, TaskNode } from './types.js'

/** GraphEntity/GraphRelation from the query layer may lack description — widen here. */
type PlanEntity = Pick<GraphEntity, 'name' | 'type'>
type PlanRelation = Pick<GraphRelation, 'source' | 'kind' | 'target'>

export interface GroupPlannerOptions {
  maxTasks?: number
}

const DEFAULT_MAX_TASKS = 8

export class GroupPlanner {
  private readonly maxTasks: number

  constructor(options: GroupPlannerOptions = {}) {
    this.maxTasks = options.maxTasks ?? DEFAULT_MAX_TASKS
  }

  plan(goal: string, entities: GraphEntity[], relations: GraphRelation[], opts: GroupPlannerOptions = {}): Plan {
    const maxTasks = opts.maxTasks ?? this.maxTasks
    if (entities.length === 0) return { goal, tasks: [], edges: [] }

    // 1) Cluster entities by type.
    const byType = new Map<string, string[]>()
    for (const entity of entities) {
      const type = entity.type || 'unknown'
      const list = byType.get(type) ?? []
      list.push(entity.name)
      byType.set(type, list)
    }

    // 2) Build task nodes: one per type cluster.
    const tasks: TaskNode[] = []
    const taskIdByType = new Map<string, string>()
    for (const [type, names] of Array.from(byType.entries())) {
      if (tasks.length >= maxTasks) break
      const id = `task-${tasks.length + 1}`
      taskIdByType.set(type, id)
      tasks.push({
        id,
        title: `Work on ${type}`,
        entityScope: names,
        dependsOn: [],
      })
    }

    // 3) Derive dependency edges from relations: source-type task → target-type task.
    const edges: TaskEdge[] = []
    const edgeKeys = new Set<string>()
    for (const rel of relations) {
      const fromType = entities.find((e) => e.name === rel.source)?.type
      const toType = entities.find((e) => e.name === rel.target)?.type
      if (!fromType || !toType) continue
      const fromTask = taskIdByType.get(fromType)
      const toTask = taskIdByType.get(toType)
      if (!fromTask || !toTask || fromTask === toTask) continue
      const key = `${fromTask}|${toTask}`
      if (edgeKeys.has(key)) continue
      edgeKeys.add(key)
      edges.push({ from: fromTask, to: toTask, kind: rel.kind })
      const target = tasks.find((t) => t.id === toTask)
      if (target && !target.dependsOn.includes(fromTask)) target.dependsOn.push(fromTask)
    }

    // 4) Topological sort (Kahn). Cycle → fall back to name order (planner
    //    input is a DAG by construction; guard defensively).
    const order = topoSort(tasks)
    const byId = new Map(tasks.map((t) => [t.id, t]))
    const sorted = order.map((id) => byId.get(id)!).filter(Boolean)

    return { goal, tasks: sorted, edges }
  }
}

/** Kahn topological sort. Returns ids in execution order; cycles broken by id order. */
function topoSort(tasks: TaskNode[]): string[] {
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const t of tasks) {
    indegree.set(t.id, t.dependsOn.length)
    for (const d of t.dependsOn) {
      const list = dependents.get(d) ?? []
      list.push(t.id)
      dependents.set(d, list)
    }
  }
  const queue = tasks.filter((t) => (indegree.get(t.id) ?? 0) === 0).map((t) => t.id).sort()
  const out: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    out.push(id)
    for (const next of dependents.get(id) ?? []) {
      const deg = (indegree.get(next) ?? 1) - 1
      indegree.set(next, deg)
      if (deg === 0) queue.push(next)
    }
    queue.sort()
  }
  if (out.length !== tasks.length) {
    // Cycle: append remaining in id order.
    const remaining = tasks.filter((t) => !out.includes(t.id)).map((t) => t.id).sort()
    out.push(...remaining)
  }
  return out
}
