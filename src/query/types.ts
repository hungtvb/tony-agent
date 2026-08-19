/** Session query engine types (v0.5 — FTS5 session search). */

/** A single indexed search hit (entry-level). */
export interface EventHit {
  sessionId: string
  seq: number
  kind: string
  /** Lexical snippet around the best match. */
  snippet: string
  /** FTS5 bm25 relevance score (lower is better). */
  score: number
}

/** Session-level aggregation: the session + its best matching event. */
export interface SessionHit {
  sessionId: string
  /** Best-matching event inside this session (for preview). */
  bestEvent?: EventHit
  /** Number of matching events in this session. */
  matchCount: number
}

/** Opaque cursor for stable paging. */
export interface SearchCursor {
  /** Last seen rowid (exclusive next page). */
  lastRowid: number
  /** Last seen score (tiebreak). */
  lastScore: number
}

export interface SearchOptions {
  limit?: number
  cursor?: SearchCursor
  /** Restrict search to one session. */
  sessionId?: string
}

export interface SearchResult<T> {
  hits: T[]
  /** Set when there are more pages. */
  nextCursor?: SearchCursor
}

/** Lineage of a session: parent (ancestors) + children (descendants). */
export interface LineageResult {
  sessionId: string
  /** Direct parent session id (from the entry chain), if any. */
  parentId?: string
  /** All ancestor session ids, nearest first. */
  ancestors: string[]
  /** All descendant session ids, nearest first. */
  descendants: string[]
}

export interface SessionMeta {
  sessionId: string
  name: string
  createdAt: number
  updatedAt: number
}