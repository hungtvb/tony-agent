import { z } from 'zod'
import type { ServiceConsumer, ServiceDefinition, ServiceProvider } from '../seams/types.js'
import type { PluginContext } from '../plugin/context.js'
import type { Plugin } from '../plugin/registry.js'
import type { TonyTool, ToolContext, ToolResult } from '../types.js'
import type { SessionQueryEngine } from './engine.js'
import type { EventHit, SearchResult } from './types.js'

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
