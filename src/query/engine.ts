import { createRequire } from 'node:module'
import type { SessionMeta } from './types.js'

const SCHEMA_VERSION = 2

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
        CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
          session_id UNINDEXED,
          seq UNINDEXED,
          kind UNINDEXED,
          body,
          tokenize = 'unicode61'
        );
        CREATE INDEX IF NOT EXISTS idx_meta_updated ON session_meta(updated_at);
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
}