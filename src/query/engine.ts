import { createRequire } from 'node:module'
import type { Entry } from '../harness/session/types.js'
import type { EventHit, LineageResult, SearchCursor, SearchOptions, SearchResult, SessionHit, SessionMeta } from './types.js'

const SCHEMA_VERSION = 4

const require = createRequire(import.meta.url)
// better-sqlite3 is a CJS native addon; require() avoids esModuleInterop concerns
// eslint-disable-next-line @typescript-eslint/no-require-imports
const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3')
type SqliteDatabase = InstanceType<typeof BetterSqlite3>

export interface SessionQueryEngineOptions {
  /** Path to the derived index DB (separate from the persistence DB). */
  indexPath: string
}

/**
 * SessionQueryEngine — FTS5 full-text search over the session log (v0.5).
 *
 * Derived index DB RIÊNG (không trỏ vào session-persistence DB, dsh rule):
 * the index can be dropped/rebuild without touching session data. Same
 * durability/integrity setup as SqliteSessionRepo (WAL, synchronous NORMAL,
 * foreign_keys ON, busy_timeout, journal_size_limit, user_version guard,
 * integrity_check fail-fast).
 *
 * Live-preferred surface (dsh): durable rows are the base; a live owner
 * (open session) shadows them via TEMP tables until closed.
 */
export class SessionQueryEngine {
  private readonly db: SqliteDatabase
  private readonly liveTables = new Map<string, string>()

  constructor(options: SessionQueryEngineOptions) {
    const db = new BetterSqlite3(options.indexPath)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')
    db.pragma('journal_size_limit = 67108864') // 64 MB
    const integrity = db.pragma('integrity_check', { simple: true }) as unknown as string
    if (integrity !== 'ok') {
      db.close()
      throw new Error(`SQLite integrity check failed: ${integrity}`)
    }
    const version = db.pragma('user_version', { simple: true }) as number
    if (version > SCHEMA_VERSION) {
      db.close()
      throw new Error(`SQLite schema version ${version} is newer than supported ${SCHEMA_VERSION}`)
    }
    if (version < SCHEMA_VERSION) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_meta (
          session_id TEXT PRIMARY KEY,
          name TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS session_parent (
          session_id TEXT PRIMARY KEY,
          parent_id TEXT NOT NULL,
          FOREIGN KEY (session_id) REFERENCES session_meta(session_id) ON DELETE CASCADE
        );
        DROP TABLE IF EXISTS entries_fts;
        CREATE VIRTUAL TABLE entries_fts USING fts5(
          session_id UNINDEXED,
          seq UNINDEXED,
          kind UNINDEXED,
          parent_id UNINDEXED,
          body,
          tokenize = 'unicode61'
        );
        CREATE INDEX IF NOT EXISTS idx_meta_updated ON session_meta(updated_at);
        CREATE TABLE IF NOT EXISTS entities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          name TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'entity',
          description TEXT NOT NULL DEFAULT '',
          UNIQUE(session_id, name)
        );
        CREATE TABLE IF NOT EXISTS relations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          source TEXT NOT NULL,
          target TEXT NOT NULL,
          kind TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          UNIQUE(session_id, source, target, kind)
        );
        CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
        CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source);
        CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target);
      `)
      db.pragma(`user_version = ${SCHEMA_VERSION}`)
    }
    this.db = db
  }

  close(): void {
    this.db.close()
  }

  /** List table names (diagnostics/tests — proves derived DB isolation). */
  listTables(): string[] {
    const rows = this.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name").all() as Array<{ name: string }>
    return rows.map((row) => row.name)
  }

  /** Upsert session metadata (used by sync). */
  upsertMeta(meta: SessionMeta): void {
    this.db
      .prepare(
        'INSERT INTO session_meta (session_id, name, created_at, updated_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(session_id) DO UPDATE SET name = excluded.name, created_at = excluded.created_at, updated_at = excluded.updated_at',
      )
      .run(meta.sessionId, meta.name, meta.createdAt, meta.updatedAt)
  }

  /** Remove a session from the index (entries + meta). */
  deleteSession(sessionId: string): void {
    this.db.prepare('DELETE FROM entries_fts WHERE session_id = ?').run(sessionId)
    this.db.prepare('DELETE FROM session_meta WHERE session_id = ?').run(sessionId)
  }

  /** Number of indexed entries for a session (diagnostics/tests). */
  countEntries(sessionId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM entries_fts WHERE session_id = ?').get(sessionId) as { n: number }
    return row.n
  }

  /** Read session metadata back (undefined when not indexed). */
  getMeta(sessionId: string): SessionMeta | undefined {
    const row = this.db.prepare('SELECT session_id, name, created_at, updated_at FROM session_meta WHERE session_id = ?').get(sessionId) as
      | { session_id: string; name: string; created_at: number; updated_at: number }
      | undefined
    if (!row) return undefined
    return { sessionId: row.session_id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at }
  }

  /**
   * Sync a session's entries into the derived index. Atomic per session:
   * deletes existing rows for the session then re-inserts (no duplicates on
   * append). Extracts the searchable body per entry kind.
   */
  sync(sessionId: string, entries: ReadonlyArray<Entry>, meta: SessionMeta): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM entries_fts WHERE session_id = ?').run(sessionId)
      const insert = this.db.prepare('INSERT INTO entries_fts (session_id, seq, kind, parent_id, body) VALUES (?, ?, ?, ?, ?)')
      for (const entry of entries) {
        insert.run(sessionId, entry.seq, entry.kind, entry.parentId, bodyFromEntry(entry))
      }
      this.upsertMeta(meta)
    })
    transaction()
  }

  /**
   * Full-text search over entry bodies. Literal phrase semantics: the query
   * is quoted so FTS keywords (OR/NEAR/*) are treated as data, not syntax.
   */
  searchEvents(query: string, options: SearchOptions = {}): SearchResult<EventHit> {
    const limit = options.limit ?? 10
    const matcher = escapeFtsLiteral(query)
    const sessionFilter = options.sessionId ? 'AND session_id = @sid' : ''
    const cursorFilter = options.cursor ? 'AND (score > @lastScore OR (score = @lastScore AND rowid > @lastRowid))' : ''
    const sql = `
      SELECT rowid, session_id, seq, kind, body, bm25(entries_fts) AS score
      FROM entries_fts
      WHERE entries_fts MATCH @matcher ${sessionFilter} ${cursorFilter}
      ORDER BY score, rowid
      LIMIT @limit
    `
    const rows = this.db
      .prepare(sql)
      .all({
        matcher,
        sid: options.sessionId ?? '',
        lastRowid: options.cursor?.lastRowid ?? 0,
        lastScore: options.cursor?.lastScore ?? 0,
        limit: limit + 1, // fetch one extra to know if there is a next page
      }) as Array<{ rowid: number; session_id: string; seq: number; kind: string; body: string; score: number }>
    // Surface fold: live TEMP shadow replaces durable rows for open sessions.
    const liveSids = new Set(this.liveTables.keys())
    const hits = rows
      .filter((row) => !(options.sessionId && liveSids.has(options.sessionId)) && !(liveSids.has(row.session_id) && this.liveHasSeq(row.session_id, row.seq, row.body)))
      .slice(0, limit)
      .map((row) => ({
        sessionId: row.session_id,
        seq: row.seq,
        kind: row.kind,
        snippet: makeSnippet(row.body, query),
        score: row.score,
      }))
    // append live shadow rows that match
    if (!options.sessionId || liveSids.has(options.sessionId)) {
      for (const [sid, table] of Array.from(this.liveTables)) {
        if (options.sessionId && sid !== options.sessionId) continue
        const liveRows = this.db
          .prepare(`SELECT rowid, session_id, seq, kind, body FROM ${table} WHERE ${table} MATCH ?`)
          .all(matcher) as Array<{ rowid: number; session_id: string; seq: number; kind: string; body: string }>
        for (const liveRow of liveRows) {
          const dup = hits.find((h) => h.sessionId === liveRow.session_id && h.seq === liveRow.seq)
          if (!dup) {
            hits.push({
              sessionId: liveRow.session_id,
              seq: liveRow.seq,
              kind: liveRow.kind,
              snippet: makeSnippet(liveRow.body, query),
              score: liveRow.rowid, // live ordering by rowid is fine
            })
          }
        }
      }
      hits.sort((a, b) => a.score - b.score)
    }
    const hasMore = rows.length > limit
    const nextCursor: SearchCursor | undefined = hasMore
      ? { lastRowid: rows[limit - 1]!.rowid, lastScore: rows[limit - 1]!.score }
      : undefined
    return { hits: hits.slice(0, limit), ...(nextCursor ? { nextCursor } : {}) }
  }

  /** True when a live shadow holds the same (session, seq, body) row. */
  private liveHasSeq(sessionId: string, seq: number, body: string): boolean {
    const table = this.liveTables.get(sessionId)
    if (!table) return false
    const row = this.db.prepare(`SELECT 1 AS x FROM ${table} WHERE session_id = ? AND seq = ? AND body = ?`).get(sessionId, seq, body) as { x: number } | undefined
    return row !== undefined
  }

  /** Session-level aggregation: distinct sessions + match count + best event. */
  searchSessions(query: string, options: SearchOptions = {}): SearchResult<SessionHit> {
    const eventResult = this.searchEvents(query, { ...options, limit: (options.limit ?? 10) * 10 })
    const bySession = new Map<string, { count: number; bestScore: number; best?: EventHit }>()
    for (const hit of eventResult.hits) {
      const existing = bySession.get(hit.sessionId)
      if (!existing) {
        bySession.set(hit.sessionId, { count: 1, bestScore: hit.score, best: hit })
      } else {
        existing.count += 1
        if (hit.score < existing.bestScore) {
          existing.bestScore = hit.score
          existing.best = hit
        }
      }
    }
    const hits = Array.from(bySession.entries())
      .sort((a, b) => a[1].bestScore - b[1].bestScore)
      .slice(0, options.limit ?? 10)
      .map(([sessionId, agg]) => ({
        sessionId,
        matchCount: agg.count,
        ...(agg.best ? { bestEvent: agg.best } : {}),
      }))
    return { hits }
  }

  /**
   * Open a session as "live": shadow the durable rows with a TEMP copy so
   * search prefers the live (newer) state. Returns a closer.
   */
  openLive(sessionId: string, entries: ReadonlyArray<Entry>): () => void {
    // TEMP FTS5 table shadows the durable rows; searchEvents folds live in.
    const live = `entries_fts_live_${sessionId.replace(/[^a-zA-Z0-9_]/g, '_')}`
    this.db.exec(`DROP TABLE IF EXISTS temp.${live}`)
    this.db.exec(
      `CREATE VIRTUAL TABLE temp.${live} USING fts5(session_id UNINDEXED, seq UNINDEXED, kind UNINDEXED, parent_id UNINDEXED, body, tokenize = 'unicode61')`,
    )
    const insert = this.db.prepare(`INSERT INTO ${live} (session_id, seq, kind, parent_id, body) VALUES (?, ?, ?, ?, ?)`)
    for (const entry of entries) {
      insert.run(sessionId, entry.seq, entry.kind, entry.parentId, bodyFromEntry(entry))
    }
    this.liveTables.set(sessionId, live)
    return () => {
      this.liveTables.delete(sessionId)
      this.db.exec(`DROP TABLE IF EXISTS temp.${live}`)
    }
  }

  /** Record a branch parent link (session_id → parent_id). */
  setBranchParent(sessionId: string, parentId: string): void {
    this.db
      .prepare('INSERT INTO session_parent (session_id, parent_id) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET parent_id = excluded.parent_id')
      .run(sessionId, parentId)
  }

  /** Parent session id, if any (branch lineage). */
  getBranchParent(sessionId: string): string | undefined {
    const row = this.db.prepare('SELECT parent_id FROM session_parent WHERE session_id = ?').get(sessionId) as { parent_id: string } | undefined
    return row?.parent_id
  }

  /**
   * Trace session lineage: ancestors (via branch parent links, nearest first)
   * and descendants (recursive children, nearest first). Cycle → throws
   * INVALID_LINEAGE (dsh semantics).
   */
  traceSession(sessionId: string): LineageResult {
    const ancestors: string[] = []
    const seen = new Set<string>([sessionId])
    let current = this.getBranchParent(sessionId)
    while (current) {
      if (seen.has(current)) throw new Error(`SESSION_QUERY_INVALID_LINEAGE: cycle at ${current}`)
      seen.add(current)
      ancestors.push(current)
      current = this.getBranchParent(current)
    }
    // descendants: BFS over child links
    const descendants: string[] = []
    const queue = [sessionId]
    const visited = new Set<string>([sessionId])
    while (queue.length > 0) {
      const node = queue.shift()!
      const children = this.db.prepare('SELECT session_id FROM session_parent WHERE parent_id = ?').all(node) as Array<{ session_id: string }>
      for (const child of children) {
        if (visited.has(child.session_id)) throw new Error(`SESSION_QUERY_INVALID_LINEAGE: cycle at ${child.session_id}`)
        visited.add(child.session_id)
        descendants.push(child.session_id)
        queue.push(child.session_id)
      }
    }
    return {
      sessionId,
      ...(ancestors.length > 0 ? { parentId: ancestors[0] } : {}),
      ancestors,
      descendants,
    }
  }

  /**
   * Trace a single event's lineage within its session: the event itself +
   * ancestor chain (by parentId, nearest first). Cycle → INVALID_LINEAGE.
   */
  traceEvent(sessionId: string, seq: number): { event: EventHit; ancestors: EventHit[] } {
    const rows = this.db
      .prepare('SELECT rowid, session_id, seq, kind, body, parent_id FROM entries_fts WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as Array<{ rowid: number; session_id: string; seq: number; kind: string; body: string; parent_id: number }>
    const bySeq = new Map(rows.map((row) => [row.seq, row]))
    const target = bySeq.get(seq)
    if (!target) throw new Error(`Event ${seq} not found in session ${sessionId}`)
    const toHit = (row: (typeof rows)[number]): EventHit => ({
      sessionId: row.session_id,
      seq: row.seq,
      kind: row.kind,
      snippet: row.body.slice(0, 120),
      score: 0,
    })
    const ancestors: EventHit[] = []
    const seen = new Set<number>([seq])
    let parentSeq = target.parent_id
    while (parentSeq > 0) {
      if (seen.has(parentSeq)) throw new Error(`SESSION_QUERY_INVALID_LINEAGE: event cycle at ${parentSeq}`)
      seen.add(parentSeq)
      const parent = bySeq.get(parentSeq)
      if (!parent) break
      ancestors.push(toHit(parent))
      parentSeq = parent.parent_id
    }
    return { event: toHit(target), ancestors }
  }
}

/** Quote a user query as an FTS5 literal phrase (syntax treated as data). */
export function escapeFtsLiteral(query: string): string {
  // FTS5 double-quoted strings: escape embedded quotes by doubling them.
  return `"${query.replace(/"/g, '""')}"`
}

/** Build a compact snippet around the first occurrence of the query. */
export function makeSnippet(body: string, query: string, radius = 60): string {
  const lower = body.toLowerCase()
  const needle = query.toLowerCase()
  const index = lower.indexOf(needle)
  if (index < 0) return body.slice(0, radius * 2)
  const start = Math.max(0, index - radius)
  const end = Math.min(body.length, index + needle.length + radius)
  return (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '')
}

/** Extract the searchable text body from a session entry by kind. */
export function bodyFromEntry(entry: Entry): string {
  switch (entry.kind) {
    case 'message': {
      const content = entry.message.content
      if (typeof content === 'string') return content
      return content
        .map((part) => (part.type === 'text' ? part.text : `tool call: ${part.name} ${typeof part.arguments === 'string' ? part.arguments : JSON.stringify(part.arguments)}`))
        .join(' ')
    }
    case 'model_change':
      return `model change: ${entry.model}`
    case 'thinking_level_change':
      return `thinking level: ${entry.level}`
    case 'active_tools_change':
      return `active tools: ${entry.tools.join(', ')}`
    case 'compaction':
      return `compaction (${entry.reason}): ${entry.summary}`
    case 'branch_summary':
      return `branch summary: ${entry.summary}`
    case 'custom':
      return typeof entry.payload === 'string' ? entry.payload : JSON.stringify(entry.payload)
  }
}