/**
 * GraphContextBuilder — automatic knowledge-graph recall inside the agent loop (v0.6.1).
 *
 * Before each LLM call, the builder derives search terms from the current user
 * message (plus a couple of recent assistant messages), queries the derived
 * index's knowledge graph (`SessionQueryEngine.searchGraph`), and formats the
 * hits into ONE model-visible block with `[sid#seq]` citations. This gives the
 * agent cross-session memory without requiring an explicit tool call.
 *
 * Design rules:
 * - The produced block is EPHEMERAL — appended to the per-turn messages, never
 *   persisted into the session log (graph recall is derived data).
 * - No engine → no-op builder (returns null): graceful degradation when the
 *   index is missing or unreadable.
 * - Overflow guard: when the conversation is already long, the block uses the
 *   `user` role instead of `system` (many providers reject a `system` message
 *   that appears after a `user` message).
 * - Fail-soft: extraction/search errors never throw out of the agent loop.
 */
import type { SessionQueryEngine } from './engine.js'
import type { GraphHit, GraphSearchOptions } from './engine.js'
import type { LLMMessage } from '../types.js'

export interface GraphContextOptions {
  mode?: 'local' | 'global' | 'naive'
  sessionId?: string
  limit?: number
  maxHops?: number
}

export interface GraphContextBuilderOptions {
  /** Search-term extractor (default heuristic below). */
  extractTerms?: (userMessage: string, recentAssistant: string[], opts?: { maxTerms?: number }) => string[]
  /** Max messages in the conversation before falling back to a plain `user` context message. */
  maxContextMessages?: number
}

/** Stopwords skipped by the default term extractor (English agent prompts). */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'but', 'with',
  'about', 'what', 'where', 'how', 'why', 'when', 'who', 'which', 'do', 'does', 'did', 'done', 'it', 'its', 'this', 'that',
  'these', 'those', 'we', 'you', 'i', 'me', 'my', 'our', 'your', 'can', 'could', 'should', 'would', 'will', 'please',
  'tell', 'me', 'know', 'remember', 'continue', 'from', 'by', 'at', 'as', 'if', 'then', 'than', 'so', 'up', 'down', 'out',
])
const MAX_TERM_LENGTH = 40

/**
 * Default term extractor: normalized unique words from the user message plus
 * up to two recent assistant messages, capped at `maxTerms` (default 6).
 * If everything is filtered out, falls back to the raw (trimmed) user message.
 */
export function extractGraphTerms(userMessage: string, recentAssistant: string[], opts: { maxTerms?: number } = {}): string[] {
  const maxTerms = opts.maxTerms ?? 6
  const words = new Set<string>()
  const add = (text: string): void => {
    for (const raw of text.toLowerCase().split(/[^a-z0-9+.#_-]+/)) {
      const word = raw.trim()
      if (word.length < 2 || word.length > MAX_TERM_LENGTH || STOPWORDS.has(word)) continue
      words.add(word)
    }
  }
  add(userMessage)
  for (const assistantText of recentAssistant.slice(0, 2)) add(assistantText)
  const result = Array.from(words).slice(0, maxTerms)
  if (result.length === 0) {
    const primary = userMessage.trim().slice(0, MAX_TERM_LENGTH)
    if (primary) result.push(primary)
  }
  return result
}

/** One deduplicated recall hit. */
export interface GraphRecallHit {
  sessionId: string
  seq: number
  snippet: string
  entity?: string
  hop: number
}

/** The formatted recall block + timing stats (for events/tests). */
export interface GraphRecallOutput {
  message: LLMMessage
  hitCount: number
  latencyMs: number
}

/**
 * Builds a per-turn graph recall block. Reads only — never writes to the
 * derived index. Query sequence per term: local → global → naive fallback;
 * stops at the first term that yields hits (breadth over depth).
 */
export class GraphContextBuilder {
  readonly engine: SessionQueryEngine | undefined
  private readonly options: GraphContextBuilderOptions

  constructor(engine: SessionQueryEngine | undefined, options: GraphContextBuilderOptions = {}) {
    this.engine = engine
    this.options = options
  }

  async build(
    userMessage: string,
    recentAssistant: string[],
    context: { sessionId?: string; maxMessages?: number } = {},
  ): Promise<GraphRecallOutput | null> {
    if (!this.engine) return null
    const started = Date.now()
    const terms = (this.options.extractTerms ?? extractGraphTerms)(userMessage, recentAssistant)
    const seen = new Map<string, GraphRecallHit>()
    let found = false

    for (const term of terms) {
      if (found) break
      const options: GraphSearchOptions = { sessionId: context.sessionId, limit: 5, maxHops: 2 }
      const local = this.engine.searchGraph(term, { ...options, mode: 'local' })
      if (local.hits.length > 0) {
        found = true
        this.push(seen, local.hits)
        continue
      }
      const globalRes = this.engine.searchGraph(term, { ...options, mode: 'global' })
      if (globalRes.hits.length > 0) {
        found = true
        this.push(seen, globalRes.hits)
        continue
      }
      const naive = this.engine.searchGraph(term, { ...options, mode: 'naive', limit: 3 })
      if (naive.hits.length > 0) {
        found = true
        this.push(seen, naive.hits)
      }
    }

    if (seen.size === 0) return null
    const hits = Array.from(seen.values()).slice(0, 8)
    const lines = hits.map(
      (h) => `[${h.sessionId}#${h.seq}] (hop ${h.hop}${h.entity ? `, ${h.entity}` : ''}) ${h.snippet}`,
    )
    const content = `Graph recall (cross-session memory):\n${lines.join('\n')}\nUse this as prior context if relevant.`
    const maxContextMessages = context.maxMessages ?? this.options.maxContextMessages ?? 60
    const tooLong = context.maxMessages !== undefined ? context.maxMessages > maxContextMessages : false
    const message: LLMMessage = tooLong
      ? { role: 'user', content }
      : { role: 'system', content }
    return { message, hitCount: hits.length, latencyMs: Date.now() - started }
  }

  private push(seen: Map<string, GraphRecallHit>, hits: ReadonlyArray<GraphHit>): void {
    for (const hit of hits) {
      const key = `${hit.sessionId}:${hit.seq}`
      const existing = seen.get(key)
      if (!existing || hit.hop < existing.hop) {
        seen.set(key, { sessionId: hit.sessionId, seq: hit.seq, snippet: hit.snippet, ...(hit.entity ? { entity: hit.entity } : {}), hop: hit.hop })
      }
    }
  }
}

/** Quick factory: no-op builder when engine is undefined. */
export function createGraphContextBuilder(engine: SessionQueryEngine | undefined, options?: GraphContextBuilderOptions): GraphContextBuilder {
  return new GraphContextBuilder(engine, options)
}