/**
 * GraphPlanner — engine-backed plan synthesis (v0.8).
 *
 * Retrieves the subgraph around the goal via `GraphRouter` (v0.7), builds a
 * deterministic task DAG with `GroupPlanner`, then optionally refines task
 * titles/descriptions with one strict-JSON LLM call (fail-soft: any error or
 * malformed JSON → the deterministic plan is returned unchanged).
 */
import type { SessionQueryEngine } from '../query/engine.js'
import { GraphRouter } from '../workflow/router.js'
import { GroupPlanner } from './group.js'
import type { Plan, TaskNode } from './types.js'
import type { LLMCompleter } from '../types.js'

export interface GraphPlannerOptions {
  engine: SessionQueryEngine
  /** Refinement only — optional; when absent plan() never calls an LLM. */
  llm?: LLMCompleter
  maxTasks?: number
  sessionId?: string
}

export class GraphPlanner {
  private readonly engine: SessionQueryEngine
  private readonly llm: LLMCompleter | undefined
  private readonly maxTasks: number
  private readonly sessionId: string | undefined
  private readonly router: GraphRouter

  constructor(options: GraphPlannerOptions) {
    this.engine = options.engine
    this.llm = options.llm
    this.maxTasks = options.maxTasks ?? 8
    this.sessionId = options.sessionId
    this.router = new GraphRouter(this.engine, { entityLimit: 12 })
  }

  async plan(goal: string, opts: { topEntities?: number; topRelations?: number } = {}): Promise<Plan> {
    const limit = opts.topEntities ?? 12
    const route = this.router.route(goal, { sessionId: this.sessionId, limit: 5 })
    let entities = route.entities.slice(0, limit).map((e) => ({ name: e.name, type: e.type }))
    const relationCap = opts.topRelations ?? 20
    let relations = route.relations.slice(0, relationCap).map((rel) => ({ source: rel.source, kind: rel.kind, target: rel.target }))

    // Fallback for free-form goals: the graph query may not match any entity
    // name. Pull entities from sessions that FTS-match the goal instead.
    if (entities.length === 0) {
      // FTS is AND/literal-phrase — fall back to individual terms so a
      // free-form goal still reaches the sessions that mention its pieces.
      const sessionHits = new Map<string, number>()
      const terms = goal.split(/\s+/).filter((t) => t.length >= 2)
      const searchTerms = terms.length > 0 ? terms : [goal]
      for (const term of searchTerms) {
        for (const hit of this.engine.searchSessions(term, { limit: 3 }).hits) {
          sessionHits.set(hit.sessionId, (sessionHits.get(hit.sessionId) ?? 0) + hit.matchCount)
        }
      }
      const ranked = Array.from(sessionHits.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3)
      const seenEntities = new Map<string, string>() // name → type
      const seenRelations = new Map<string, { source: string; kind: string; target: string }>()
      for (const [sessionId] of ranked) {
        for (const entity of this.engine.getEntities(sessionId)) {
          if (seenEntities.size < limit) seenEntities.set(entity.name, entity.type)
        }
        for (const rel of this.engine.getRelations(sessionId) ?? []) {
          if (seenRelations.size >= relationCap) break
          const key = `${rel.source}|${rel.kind}|${rel.target}`
          if (!seenRelations.has(key)) seenRelations.set(key, { source: rel.source, kind: rel.kind, target: rel.target })
        }
      }
      entities = Array.from(seenEntities.entries()).map(([name, type]) => ({ name, type }))
      relations = Array.from(seenRelations.values())
    }

    let plan = new GroupPlanner({ maxTasks: this.maxTasks }).plan(goal, entities, relations)
    if (this.llm) {
      plan = await this.refine(plan).catch(() => plan) // fail-soft
    }
    return plan
  }

  /** One batched strict-JSON call (≤ 8 tasks) to name/describe tasks. Malformed → original. */
  private async refine(plan: Plan): Promise<Plan> {
    const prompt = `You are a planning assistant. Given a goal and entity scopes, produce a task list.
Goal: ${plan.goal}
Tasks (scope: [entities]):
${plan.tasks.map((t, i) => `${i}: scope ${JSON.stringify(t.entityScope)} dependsOn ${JSON.stringify(t.dependsOn)}`).join('\n')}

Respond with strict JSON only:
{"tasks":[{"id":"task-1","title":"...","description":"..."}]}
`
    const completion = await this.llm!.complete(
      { messages: [{ role: 'user', content: prompt }] },
      {},
    ) as unknown as { text?: string }
    const text = typeof completion === 'string' ? completion : (completion?.text ?? '')
    const parsed = this.parseRefine(text)
    if (!parsed) return plan
    const tasks: TaskNode[] = plan.tasks.map((t, i) => {
      const refined = parsed[i]
      return refined
        ? { ...t, title: refined.title ?? t.title, description: refined.description ?? t.description }
        : t
    })
    return { ...plan, tasks }
  }

  private parseRefine(text: string): Array<{ title?: string; description?: string }> | null {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      const data = JSON.parse(match[0]) as { tasks?: Array<{ id?: string; title?: string; description?: string }> }
      if (!Array.isArray(data.tasks)) return null
      return data.tasks
    } catch {
      return null
    }
  }
}