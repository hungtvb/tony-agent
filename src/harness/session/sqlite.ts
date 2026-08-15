import { createRequire } from 'node:module'
import type { Entry } from './types.js'
import type { Session } from './jsonl/repo.js'

const SAFE_ID = /^[a-z0-9_-]{1,128}$/

const require = createRequire(import.meta.url)
// better-sqlite3 is a CJS native addon; require() avoids esModuleInterop concerns
// eslint-disable-next-line @typescript-eslint/no-require-imports
const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3')
type SqliteDatabase = InstanceType<typeof BetterSqlite3>

function safeId(id: string): void {
  if (!SAFE_ID.test(id)) throw new Error(`Invalid session id: ${id}`)
}

/**
 * SQLite session backend (better-sqlite3, WAL mode). Same Session interface as
 * the JSONL repo so the conformance suite runs against both. One `sessions`
 * table with entries keyed by session id; branch copies the head entries.
 */
export class SqliteSessionRepo {
  readonly directory: string
  private readonly db: SqliteDatabase

  constructor(dbPath: string) {
    this.directory = dbPath
    const db = new BetterSqlite3(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 5000')
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS entries (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        parent_id INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        kind TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_entries_session ON entries(session_id);
    `)
    this.db = db
  }

  close(): void {
    this.db.close()
  }

  private readEntries(id: string): Entry[] {
    const rows = this.db.prepare('SELECT kind, data FROM entries WHERE session_id = ? ORDER BY seq').all(id) as Array<{ kind: string; data: string }>
    return rows.map((row) => JSON.parse(row.data) as Entry)
  }

  private writeEntries(id: string, entries: Entry[]): void {
    const insert = this.db.prepare('INSERT OR REPLACE INTO entries (session_id, seq, parent_id, timestamp, kind, data) VALUES (?, ?, ?, ?, ?, ?)')
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM entries WHERE session_id = ?').run(id)
      for (const entry of entries) {
        insert.run(id, entry.seq, entry.parentId, entry.timestamp, entry.kind, JSON.stringify(entry))
      }
      this.db.prepare('INSERT OR REPLACE INTO sessions (id, seq) VALUES (?, ?)').run(id, entries.length)
    })()
  }

  private makeSession(id: string): Session {
    const repo = this
    let entries = this.readEntries(id)
    return {
      id,
      getEntries: () => entries,
      async append(entry: Entry) {
        entries = [...entries, entry]
        repo.writeEntries(id, entries)
      },
      getNextSeq: () => entries.length + 1,
    }
  }

  async create(id: string): Promise<Session> {
    safeId(id)
    const session = this.makeSession(id)
    // materialize the row so list() sees it
    this.db.prepare('INSERT OR IGNORE INTO sessions (id, seq) VALUES (?, 0)').run(id)
    return session
  }

  async open(id: string): Promise<Session> {
    safeId(id)
    return this.makeSession(id)
  }

  async branch(id: string, newId: string, fromSeq: number): Promise<Session> {
    safeId(id)
    safeId(newId)
    const source = this.readEntries(id)
    const head = source.filter((entry) => entry.seq <= fromSeq)
    this.writeEntries(newId, head)
    return this.makeSession(newId)
  }

  async list(): Promise<string[]> {
    const rows = this.db.prepare('SELECT id FROM sessions ORDER BY id').all() as Array<{ id: string }>
    return rows.map((row) => row.id)
  }

  async delete(id: string): Promise<void> {
    safeId(id)
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM entries WHERE session_id = ?').run(id)
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    })()
  }
}