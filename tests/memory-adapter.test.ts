import { describe, expect, it } from 'vitest'
import {
  InMemoryVectorStore,
  cosineSimilarity,
  tokenize,
  type MemoryAdapter,
} from '../src/memory/adapter.js'

describe('memory adapter', () => {
  it('tokenizes text into lowercase word tokens', () => {
    expect(tokenize('Hello World 42')).toEqual(['hello', 'world', '42'])
    expect(tokenize('a b c')).toEqual([])
  })

  it('cosine similarity ranks shared tokens', () => {
    const a = new Map([['cat', 1], ['sit', 1]])
    const b = new Map([['cat', 1], ['hat', 1]])
    const same = new Map([['cat', 1], ['sit', 1]])
    expect(cosineSimilarity(a, same)).toBeCloseTo(1)
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.5)
    expect(cosineSimilarity(new Map(), b)).toBe(0)
  })

  it('stores and retrieves entries by relevance', async () => {
    const store: MemoryAdapter = new InMemoryVectorStore()
    await store.add('red fish blue fish')
    await store.add('one red fish')
    await store.add('green tree tall tree')
    const hits = await store.search({ text: 'red fish', limit: 3 })
    // exact-match ties are broken by insertion order (mem-1 before mem-2);
    // the unrelated tree entry is dropped (zero overlap, default minScore)
    expect(hits).toHaveLength(2)
    expect(hits[0]?.entry.text).toBe('red fish blue fish')
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0)
    expect(hits[1]?.entry.text).toBe('one red fish')
    expect(hits[1]?.score).toBeGreaterThan(0.8)
    expect(hits[1]?.score).toBeLessThan(1)
  })

  it('filters by metadata and respects minScore', async () => {
    const store = new InMemoryVectorStore()
    await store.add('Alpha content', { kind: 'note', sessionId: 's1' })
    await store.add('Beta content', { kind: 'note', sessionId: 's2' })
    await store.add('Gamma content', { kind: 'fact', sessionId: 's1' })
    const filtered = await store.search({ text: 'content', filter: { sessionId: 's1' } })
    expect(filtered).toHaveLength(2)
    const kindFiltered = await store.search({ text: 'content', filter: { kind: 'fact' } })
    expect(kindFiltered).toHaveLength(1)
    const strict = await store.search({ text: 'content', minScore: 0.99 })
    expect(strict).toHaveLength(0)
  })

  it('removes, counts and clears', async () => {
    const store = new InMemoryVectorStore()
    const entry = await store.add('Something')
    expect(await store.count()).toBe(1)
    expect(await store.remove(entry.id)).toBe(true)
    expect(await store.count()).toBe(0)
    await store.add('A')
    await store.add('B')
    await store.clear()
    expect(await store.count()).toBe(0)
  })

  it('is swappable behind the MemoryAdapter port', async () => {
    const custom: MemoryAdapter = {
      name: 'custom',
      async add(text) { return { id: 'x', text, createdAt: 0 } },
      async search() { return [] },
      async remove() { return true },
      async count() { return 1 },
      async clear() {},
    }
    expect(custom.name).toBe('custom')
    expect(await custom.count()).toBe(1)
  })
})