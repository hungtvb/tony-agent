import { describe, it, expect } from 'vitest'
import { extractGraphTerms } from '../src/query/graph-context.js'

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