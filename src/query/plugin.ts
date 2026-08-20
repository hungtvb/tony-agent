import { z } from 'zod'
import type { ServiceConsumer, ServiceDefinition, ServiceProvider } from '../seams/types.js'
import type { PluginContext } from '../plugin/context.js'
import type { Plugin } from '../plugin/registry.js'
import type { TonyTool, ToolContext, ToolResult } from '../types.js'
import type { SessionQueryEngine } from './engine.js'
import type { EventHit, SearchResult } from './types.js'
import type { GraphSearchOptions, GraphSearchResult } from './engine.js'
import { GraphRouter, type GraphRoute } from '../workflow/router.js'

/** Capability seam id for knowledge-graph retrieval (v0.6). */
export const GRAPH_SERVICE_ID = 'query:graph'

/** The graph service definition: request/result contract. */
export const graphServiceDefinition: ServiceDefinition = {
  id: GRAPH_SERVICE_ID,
  schema: z.object({
    query: z.string().min(1),
    mode: z.enum(['local', 'global', 'naive']).optional(),
    sessionId: z.string().optional(),
    limit: z.number().int().positive().max(50).optional(),
  }),
}

export interface GraphRequest {
  query: string
  mode?: 'local' | 'global' | 'naive'
  sessionId?: string
  limit?: number
}

/** Wrap an existing SessionQueryEngine into a graph ServiceProvider (swap backend zero-touch). */
export function createGraphServiceProvider(engine: SessionQueryEngine): ServiceProvider<SessionQueryEngine> {
  return {
    definition: graphServiceDefinition,
    name: 'local',
    create() {
      return engine
    },
  }
}

/** Model-facing consumer: turns the resolved graph service into a tool. */
export function createGraphConsumer(): ServiceConsumer<SessionQueryEngine> {
  return {
    definition: graphServiceDefinition,
    uses(service: SessionQueryEngine): TonyTool {
      return {
        name: GRAPH_SERVICE_ID,
        description:
          'Knowledge-graph retrieval over session history (entities/relations): local (entity-centric, related facts), global (theme-level), naive (FTS5 passthrough). Use it for multi-hop recall across sessions.',
        risk: 'read' as const,
        inputSchema: undefined as never,
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Entity name or theme' },
            mode: { type: 'string', enum: ['local', 'global', 'naive'], description: 'Retrieval mode (default local)' },
            sessionId: { type: 'string', description: 'Scope to one session id (default: all sessions)' },
            limit: { type: 'number', description: 'Max hits (default 10, max 50)' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
          try {
            const request = (input ?? {}) as GraphRequest
            if (typeof request.query !== 'string' || request.query.trim() === '') {
              return { content: 'query:graph requires a non-empty query', isError: true }
            }
            const options: GraphSearchOptions = { mode: request.mode, limit: request.limit, sessionId: request.sessionId }
            const result: GraphSearchResult = service.searchGraph(request.query, options)
            if (result.hits.length === 0) return { content: `No graph hits for "${request.query}"` }
            const lines = result.hits.map(
              (hit) => `[${hit.sessionId}#${hit.seq}] (hop ${hit.hop}${hit.entity ? `, ${hit.entity}` : ''}) ${hit.snippet}`,
            )
            return { content: `Found ${result.hits.length} graph hits:\n${lines.join('\n')}` }
          } catch (error) {
            return {
              content: `query:graph failed: ${error instanceof Error ? error.message : String(error)}`,
              isError: true,
            }
          }
        },
      }
    },
  }
}

/** Build the model-facing graph tools for an engine (direct wiring, no plugin ctx). */
export function createGraphTools(engine: SessionQueryEngine, toolName = GRAPH_SERVICE_ID): TonyTool[] {
  const produced = createGraphConsumer().uses(engine)
  const tools = (Array.isArray(produced) ? produced : [produced]) as TonyTool[]
  for (const tool of tools) {
    if (toolName !== tool.name) {
      tool.name = toolName
    }
  }
  return tools
}

/** Capability seam id for session query. */
export const QUERY_SERVICE_ID = 'query'

/** The query service definition: request/result contract. */
export const queryServiceDefinition: ServiceDefinition = {
  id: QUERY_SERVICE_ID,
  schema: z.object({
    query: z.string().min(1),
    sessionId: z.string().optional(),
    limit: z.number().int().positive().max(50).optional(),
  }),
}

export interface QueryRequest {
  query: string
  sessionId?: string
  limit?: number
}

export interface QueryResult {
  scope: 'sessions' | 'events'
  hits: Array<{ sessionId: string; seq?: number; kind?: string; snippet: string; matchCount?: number }>
}

/** Wrap an existing SessionQueryEngine into a ServiceProvider (swap backend zero-touch). */
export function createQueryServiceProvider(engine: SessionQueryEngine): ServiceProvider<SessionQueryEngine> {
  return {
    definition: queryServiceDefinition,
    name: 'local',
    create() {
      return engine
    },
  }
}

/** Model-facing consumer: turns the resolved query service into a tool. */
export function createQueryConsumer(): ServiceConsumer<SessionQueryEngine> {
  return {
    definition: queryServiceDefinition,
    uses(service: SessionQueryEngine): TonyTool {
      return {
        name: 'query:search',
        description:
          'Full-text search over past session history (FTS5). Finds entries and sessions that mention the query — use it to recall decisions, context, and lineage from earlier work. Literal phrase semantics: keywords are treated as data.',
        risk: 'read' as const,
        inputSchema: undefined as never,
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search text (phrase or keywords)' },
            sessionId: { type: 'string', description: 'Scope to one session id (default: all sessions)' },
            limit: { type: 'number', description: 'Max hits (default 10, max 50)' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
          try {
            const request = (input ?? {}) as QueryRequest
            if (typeof request.query !== 'string' || request.query.trim() === '') {
              return { content: 'query:search requires a non-empty query', isError: true }
            }
            const limit = request.limit ?? 10
            if (request.sessionId) {
              const result: SearchResult<EventHit> = service.searchEvents(request.query, { sessionId: request.sessionId, limit })
              return { content: formatEventHits(result, request.query) }
            }
            const result = service.searchSessions(request.query, { limit })
            return { content: formatSessionHits(result) }
          } catch (error) {
            return {
              content: `query:search failed: ${error instanceof Error ? error.message : String(error)}`,
              isError: true,
            }
          }
        },
      }
    },
  }
}

/** Build the model-facing tools for an engine (direct wiring, no plugin ctx). */
export function createQueryTools(engine: SessionQueryEngine, toolName = 'query:search'): TonyTool[] {
  const produced = createQueryConsumer().uses(engine)
  const tools = (Array.isArray(produced) ? produced : [produced]) as TonyTool[]
  // Runtime ToolRegistry names use `snake_case`; seam defaults use `service:action`.
  for (const tool of tools) {
    if (toolName !== tool.name) {
      tool.name = toolName
    }
  }
  return tools
}

function formatEventHits(result: SearchResult<EventHit>, query: string): string {
  if (result.hits.length === 0) return `No entries match "${query}"`
  const lines = result.hits.map(
    (hit) => `[${hit.sessionId}#${hit.seq} ${hit.kind}] ${hit.snippet}`,
  )
  return `Found ${result.hits.length} matching entr${result.hits.length === 1 ? 'y' : 'ies'}:\n${lines.join('\n')}`
}

function formatSessionHits(result: SearchResult<{ sessionId: string; matchCount: number; bestEvent?: EventHit }>): string {
  if (result.hits.length === 0) return 'No sessions match'
  const lines = result.hits.map(
    (hit) => `[${hit.sessionId} x${hit.matchCount}] ${hit.bestEvent?.snippet ?? ''}`,
  )
  return `Found ${result.hits.length} matching session${result.hits.length === 1 ? '' : 's'}:\n${lines.join('\n')}`
}

/** Route tool (v0.7): graph-informed routing for the model. */
export function createRouteTools(engine: SessionQueryEngine, toolName = 'query:route'): TonyTool[] {
  const router = new GraphRouter(engine)
  const tool: TonyTool = {
    name: toolName,
    description:
      'Graph routing over session history: maps a task/question to the graph entities in scope, the sessions that mention them, and an optional recommended session to continue (lineage-aware). Advisory — use it to decide which session/context to continue or which subagents to fan out.',
    risk: 'read' as const,
    inputSchema: undefined as never,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Task or question to route' },
        sessionId: { type: 'string', description: 'Current session id (enables lineage-aware recommendation)' },
        limit: { type: 'number', description: 'Max sessions to surface (default 5, max 20)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(input: unknown): Promise<ToolResult> {
      try {
        const request = (input ?? {}) as { query?: string; sessionId?: string; limit?: number }
        if (typeof request.query !== 'string' || request.query.trim() === '') {
          return { content: 'query:route requires a non-empty query', isError: true }
        }
        const route = router.route(request.query, {
          sessionId: request.sessionId,
          ...(request.limit ? { limit: request.limit } : {}),
        })
        return { content: formatGraphRoute(route) }
      } catch (error) {
        return {
          content: `query:route failed: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        }
      }
    },
  }
  return [tool]
}

/** Shared formatter: entities + sessions + recommendation (used by tool + CLI). */
export function formatGraphRoute(route: GraphRoute): string {
  if (route.entities.length === 0 && route.sessions.length === 0) {
    return `No route candidates for "${route.query}"`
  }
  const parts: string[] = []
  if (route.entities.length > 0) {
    parts.push(
      `Entities: ${route.entities.map((e) => `${e.name} (${e.type}, hop ${e.hop}, ${e.sessions.length} session${e.sessions.length === 1 ? '' : 's'})`).join(', ')}`,
    )
  }
  if (route.relations.length > 0) {
    parts.push(
      `Relations: ${route.relations.map((rel) => `${rel.source} -${rel.kind}-> ${rel.target}`).join(', ')}`,
    )
  }
  if (route.sessions.length > 0) {
    parts.push(
      `Sessions: ${route.sessions.map((s) => `[${s.sessionId} x${s.matchCount}]${s.preview ? ` ${s.preview}` : ''}`).join('\n')}`,
    )
  }
  if (route.recommended) {
    parts.push(`Recommended: continue ${route.recommended.continueSessionId} — ${route.recommended.reason}`)
  } else {
    parts.push('Recommended: none')
  }
  return parts.join('\n')
}

/** The query plugin: mounts the session-query service provider + consumer. */
export function createQueryPlugin(engine: SessionQueryEngine): Plugin {
  return {
    name: 'query',
    version: '1.0.0',
    setup(ctx: PluginContext) {
      const unregister = ctx.services.register(createQueryServiceProvider(engine))
      const consumer = createQueryConsumer()
      const produced = consumer.uses(ctx.services.resolve<SessionQueryEngine>(QUERY_SERVICE_ID, ctx))
      const tool = (Array.isArray(produced) ? produced[0] : produced) as TonyTool
      ctx.tools.shadow('query:search', tool)
      return {
        dispose() {
          unregister()
          ctx.tools.deny('query:search')
        },
      }
    },
  }
}
