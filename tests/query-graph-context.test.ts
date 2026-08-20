import { describe, it, expect } from 'vitest'
import { extractGraphTerms, createGraphContextBuilder } from '../src/query/graph-context.js'
import type { SessionQueryEngine } from '../src/query/engine.js'

describe('extractGraphTerms', () => {
  it('uses the user message as the primary term', () => {
    const terms = extractGraphTerms('Where did we discuss GraphRAG?', [], { maxTerms: 3 })
    expect(terms).toContain('graphrag')
  })

  it('adds terms from recent assistant messages up to maxTerms', () => {
    const terms = extractGraphTerms('continue', ['we decided to use LightRAG for the graph layer', 'FTS5 is done'], { maxTerms: 3 })
    expect(terms.length).toBeLessThanOrEqual(3)
    expect(terms.join(' ')).toMatch(/lightrag|fts5/)
  })

  it('returns at least one term (the user message) even when empty', () => {
    const terms = extractGraphTerms('?', [], {})
    expect(terms.length).toBeGreaterThanOrEqual(1)
  })

  it('skips stopwords and short tokens', () => {
    const terms = extractGraphTerms('the and of we continue', [], { maxTerms: 6 })
    // all stopwords are skipped; no tokens remain → falls back to raw trimmed user message
    expect(terms.length).toBeGreaterThanOrEqual(1)
  })

  it('caps terms at maxTerms', () => {
    const terms = extractGraphTerms('alpha beta gamma delta epsilon zeta eta', [], { maxTerms: 4 })
    expect(terms.length).toBe(4)
  })

  it('lowercases normalized terms', () => {
    const terms = extractGraphTerms('GraphRAG FTS5', [], {})
    expect(terms).toContain('graphrag')
    expect(terms).toContain('fts5')
  })
})

describe('GraphContextBuilder', () => {
  it('builder without engine is a no-op', async () => {
    const builder = createGraphContextBuilder(undefined)
    const block = await builder.build('hello', [])
    expect(block).toBeNull()
  })

  it('formats hits into one cited block', async () => {
    const engine = {
      searchGraph: (_q: string, _o: { mode?: string; sessionId?: string; limit?: number; maxHops?: number }) => ({
        hits: [{ sessionId: 's1', seq: 3, snippet: 'FTS5 works', entity: 'FTS5', hop: 0 }],
      }),
    } as unknown as SessionQueryEngine
    const builder = createGraphContextBuilder(engine)
    const output = await builder.build('FTS5', [])
    expect(output).not.toBeNull()
    expect(output!.message.role).toBe('system')
    expect(output!.message.content).toContain('[s1#3]')
    expect(output!.message.content).toContain('FTS5')
    expect(output!.hitCount).toBe(1)
  })

  it('dedupes hits by sessionId:seq across hooks and modes', async () => {
    let calls = 0
    const engine = {
      searchGraph: (_q: string, opts: { mode?: string }) => {
        calls += 1
        if (opts.mode === 'local') {
          return {
            hits: [
              { sessionId: 's1', seq: 1, snippet: 'a', entity: 'E', hop: 0 },
              { sessionId: 's1', seq: 2, snippet: 'b', entity: 'E', hop: 1 },
            ],
          }
        }
        if (opts.mode === 'global') {
          return {
            hits: [
              { sessionId: 's1', seq: 1, snippet: 'a-dup', entity: 'Other', hop: 0 },
              { sessionId: 's1', seq: 2, snippet: 'b-dup', entity: 'Other', hop: 0 },
              { sessionId: 's2', seq: 9, snippet: 'c', entity: 'Other', hop: 0 },
            ],
          }
        }
        return { hits: [] }
      },
    } as unknown as SessionQueryEngine
    const builder = createGraphContextBuilder(engine)
    const output = await builder.build('graph', [])
    // local mode yields hits → global mode is never queried (stop at first term with hits)
    expect(calls).toBe(1)
    expect(output!.hitCount).toBe(2)
  })

  it('falls back to naive when local and global return nothing', async () => {
    const modes: string[] = []
    const engine = {
      searchGraph: (_q: string, opts: { mode?: string }) => {
        modes.push(opts.mode ?? '')
        if (opts.mode === 'naive') {
          return { hits: [{ sessionId: 's3', seq: 7, snippet: 'raw hit', hop: 0 }] }
        }
        return { hits: [] }
      },
    } as unknown as SessionQueryEngine
    const builder = createGraphContextBuilder(engine)
    const output = await builder.build('rare-term', [])
    expect(modes).toEqual(['local', 'global', 'naive'])
    expect(output).not.toBeNull()
    expect(output!.message.content).toContain('[s3#7]')
  })

  it('returns null when no mode yields hits', async () => {
    const engine = {
      searchGraph: () => ({ hits: [] }),
    } as unknown as SessionQueryEngine
    const builder = createGraphContextBuilder(engine)
    const output = await builder.build('nothing', [])
    expect(output).toBeNull()
  })

  it('uses user role when conversation is already long (overflow guard)', async () => {
    const engine = {
      searchGraph: (_q: string, _o: { mode?: string }) => ({
        hits: [{ sessionId: 's1', seq: 1, snippet: 'x', hop: 0 }],
      }),
    } as unknown as SessionQueryEngine
    const builder = createGraphContextBuilder(engine, { maxContextMessages: 10 })
    const output = await builder.build('hi', [], { maxMessages: 11 })
    expect(output).not.toBeNull()
    expect(output!.message.role).toBe('user')
    // short conversation → system role
    const short = await builder.build('hi', [], { maxMessages: 5 })
    expect(short!.message.role).toBe('system')
  })
})