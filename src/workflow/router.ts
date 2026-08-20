/**
 * GraphRouter — graph-informed routing decisions (v0.7).
 *
 * A pure read-only layer over `SessionQueryEngine`: route(query) maps a task
 * or question to (a) the graph entities in scope, (b) which sessions mention
 * them, and (c) an optional *recommendation* to continue a lineage-related
 * session. Advisory by design (D3) — callers (workflow scripts, the model via
 * `query:route`) stay in control.
 *
 * Heuristic-first (D2): entity match via `searchGraph` local, session
 * aggregation via `searchSessions`, lineage via `traceSession`. Zero LLM cost;
 * deterministic; lineage cycles are swallowed (never throw out of route()).
 */
import type { SessionQueryEngine } from '../query/engine.js'

export interface RouteEntityHit {
  name: string
  type: string
  hop: number
  sessions: string[]
}

export interface RouteRelation {
  source: string
  kind: string
  target: string
}

export interface RouteSession {
  sessionId: string
  matchCount: number
  preview?: string
}

export interface GraphRoute {
  query: string
  entities: RouteEntityHit[]
  relations: RouteRelation[]
  sessions: RouteSession[]
  recommended?: { continueSessionId: string; reason: string }
}

export interface GraphRouterOptions {
  /** Max entities to surface. Default 10. */
  entityLimit?: number
  /** Max sessions to surface. Default 5. */
  sessionLimit?: number
}

const DEFAULT_ENTITY_LIMIT = 10
const DEFAULT_SESSION_LIMIT = 5

export class GraphRouter {
  private readonly entityLimit: number
  private readonly sessionLimit: number

  constructor(
    private readonly engine: SessionQueryEngine,
    options: GraphRouterOptions = {},
  ) {
    this.entityLimit = options.entityLimit ?? DEFAULT_ENTITY_LIMIT
    this.sessionLimit = options.sessionLimit ?? DEFAULT_SESSION_LIMIT
  }

  route(query: string, opts: { sessionId?: string; limit?: number } = {}): GraphRoute {
    const sessionLimit = opts.limit ?? this.sessionLimit
    const result: GraphRoute = { query, entities: [], relations: [], sessions: [] }

    // 1) Graph entities + relations in scope.
    const graph = this.engine.searchGraph(query, { mode: 'local', limit: this.entityLimit })
    const seenEntities = new Set<string>()
    // entity type lookup cache per session (avoid repeated queries)
    const typeBySessionEntity = new Map<string, Map<string, string>>()
    const entityType = (sessionId: string, name: string): string => {
      let cache = typeBySessionEntity.get(sessionId)
      if (!cache) {
        cache = new Map(this.engine.getEntities(sessionId).map((e) => [e.name, e.type]))
        typeBySessionEntity.set(sessionId, cache)
      }
      return cache.get(name) ?? 'unknown'
    }
    for (const hit of graph.hits) {
      if (!hit.entity) continue
      if (!seenEntities.has(hit.entity)) {
        seenEntities.add(hit.entity)
        result.entities.push({
          name: hit.entity,
          type: entityType(hit.sessionId, hit.entity),
          hop: hit.hop,
          sessions: [hit.sessionId],
        })
      } else {
        const existing = result.entities.find((e) => e.name === hit.entity)
        if (existing && !existing.sessions.includes(hit.sessionId)) existing.sessions.push(hit.sessionId)
      }
    }
    // Relations are not part of searchGraph hits — derive from the top entity's
    // relations via getRelations on its sessions (best effort).
    const relationSeen = new Set<string>()
    for (const entity of result.entities) {
      for (const sessionId of entity.sessions.slice(0, 3)) {
        for (const rel of this.engine.getRelations(sessionId) ?? []) {
          const key = `${rel.source}|${rel.kind}|${rel.target}`
          if (!relationSeen.has(key)) {
            relationSeen.add(key)
            result.relations.push(rel)
          }
        }
      }
    }

    // 2) Session aggregation via FTS search.
    const sessionSearch = this.engine.searchSessions(query, { limit: sessionLimit })
    result.sessions = sessionSearch.hits.map((h) => ({
      sessionId: h.sessionId,
      matchCount: h.matchCount,
      preview: h.bestEvent?.snippet,
    }))

    // 3) Lineage-aware recommendation (D4): recommend continue only when the
    // current session (or its ancestors) shares the top entity with the
    // matched sessions.
    if (opts.sessionId) {
      try {
        const lineage = this.engine.traceSession(opts.sessionId)
        const lineageIds = new Set([opts.sessionId, ...lineage.ancestors, ...lineage.descendants])
        const top = result.entities[0]
        if (top) {
          // which candidate session shares the top entity AND is in lineage?
          const candidate = result.sessions.find(
            (s) => s.sessionId !== opts.sessionId && lineageIds.has(s.sessionId) && top.sessions.includes(s.sessionId),
          )
          if (candidate) {
            result.recommended = {
              continueSessionId: candidate.sessionId,
              reason: `session ${candidate.sessionId} is in the lineage of ${opts.sessionId} and clusters top entity "${top.name}" (${candidate.matchCount} match(es))`,
            }
          }
        }
      } catch {
        // SESSION_QUERY_INVALID_LINEAGE cycle — swallow, advisory only.
      }
    }

    return result
  }
}