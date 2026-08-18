/**
 * Memory adapter seam — pluggable long-term memory for the agent.
 *
 * The core defines the `MemoryAdapter` port and ships an in-memory vector
 * store; hosts may swap in a real embedding-backed store (e.g. sqlite-vec,
 * LanceDB, pgvector) by implementing the same interface. The agent core only
 * ever talks to `MemoryAdapter`, so swapping the backend is zero-touch.
 */

/** One memory entry as stored. */
export interface MemoryEntry {
  id: string
  text: string
  /** Optional metadata for filtering (e.g. { sessionId, kind }). */
  metadata?: Record<string, unknown>
  createdAt: number
}

/** A scored retrieval hit. */
export interface MemoryHit {
  entry: MemoryEntry
  /** Similarity score in [0, 1] (1 = exact). */
  score: number
}

export interface MemoryQuery {
  text: string
  /** Maximum hits to return. */
  limit?: number
  /** Only return entries whose metadata matches every key/value. */
  filter?: Record<string, unknown>
  /** Minimum similarity threshold. */
  minScore?: number
}

/** Pluggable long-term memory backend. */
export interface MemoryAdapter {
  readonly name: string
  /** Store one entry; assigns id when the adapter owns ids. */
  add(text: string, metadata?: Record<string, unknown>): Promise<MemoryEntry>
  /** Semantic/lexical search over stored entries. */
  search(query: MemoryQuery): Promise<MemoryHit[]>
  /** Remove one entry by id. */
  remove(id: string): Promise<boolean>
  /** Total stored entries. */
  count(): Promise<number>
  /** Drop everything (used in tests and reset). */
  clear(): Promise<void>
}

/** Tokenize text into lowercase word tokens (lightweight lexical fallback). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((token) => token.length > 1) ?? []
}

/** Cosine similarity between two sparse token-frequency maps. */
export function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (const value of Array.from(a.values())) normA += value * value
  for (const value of Array.from(b.values())) normB += value * value
  if (normA === 0 || normB === 0) return 0
  const smaller = a.size < b.size ? a : b
  const larger = smaller === a ? b : a
  for (const [token, count] of Array.from(smaller)) {
    const other = larger.get(token)
    if (other !== undefined) dot += count * other
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

function tokenFrequencies(text: string): Map<string, number> {
  const frequencies = new Map<string, number>()
  for (const token of tokenize(text)) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
  }
  return frequencies
}

/** Default lexical (TF) vector store — deterministic and dependency-free. */
export class InMemoryVectorStore implements MemoryAdapter {
  readonly name = 'in-memory'
  private readonly entries = new Map<string, MemoryEntry>()
  private nextId = 1

  async add(text: string, metadata: Record<string, unknown> = {}): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: `mem-${this.nextId++}`,
      text,
      metadata,
      createdAt: Date.now(),
    }
    this.entries.set(entry.id, entry)
    return { ...entry }
  }

  async search(query: MemoryQuery): Promise<MemoryHit[]> {
    const queryVector = tokenFrequencies(query.text)
    const limit = query.limit ?? 10
    const minScore = query.minScore ?? 0
    const hits: MemoryHit[] = []
    for (const entry of Array.from(this.entries.values())) {
      if (query.filter) {
        const meta = entry.metadata ?? {}
        const matches = Object.entries(query.filter).every(
          ([key, value]) => meta[key] === value,
        )
        if (!matches) continue
      }
      const score = cosineSimilarity(queryVector, tokenFrequencies(entry.text))
      // skip zero-overlap hits unless the caller explicitly asked for minScore 0
      if (score < minScore || (query.minScore === undefined && score === 0)) continue
      hits.push({ entry: { ...entry }, score })
    }
    return hits.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id)).slice(0, limit)
  }

  async remove(id: string): Promise<boolean> {
    return this.entries.delete(id)
  }

  async count(): Promise<number> {
    return this.entries.size
  }

  async clear(): Promise<void> {
    this.entries.clear()
  }
}