import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { SessionEntry, SessionInfo, SessionSnapshot, SessionEntryRole, ToolCall } from '../types.js'

interface StoredIndex {
  sessions: SessionInfo[]
}

export interface AppendEntry {
  role: SessionEntryRole
  content: string
  parentId?: string
  toolCallId?: string
  toolName?: string
  toolCalls?: ToolCall[]
  metadata?: Record<string, unknown>
}

function isSafeSessionId(id: string): boolean {
  return /^session-[0-9a-f-]{36}$/.test(id)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Append-only JSONL session store with safe paths, atomic index writes, and branching. */
export class SessionStore {
  private initialized = false
  private index: StoredIndex = { sessions: [] }

  constructor(private readonly directory: string) {}

  async initialize(): Promise<void> {
    if (this.initialized) return
    await mkdir(this.directory, { recursive: true })
    try {
      const raw = await readFile(this.indexPath(), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (isStoredIndex(parsed)) this.index = parsed
    } catch {
      this.index = { sessions: [] }
    }
    this.initialized = true
  }

  async create(name = 'New session'): Promise<SessionInfo> {
    await this.initialize()
    const now = Date.now()
    const info: SessionInfo = {
      id: `session-${randomUUID()}`,
      name: name.trim() || 'New session',
      createdAt: now,
      updatedAt: now,
    }
    await writeFile(this.sessionPath(info.id), '', 'utf8')
    this.index.sessions.unshift(info)
    await this.persistIndex()
    return clone(info)
  }

  async list(): Promise<SessionInfo[]> {
    await this.initialize()
    return this.index.sessions.map(clone)
  }

  async get(sessionId: string): Promise<SessionInfo | undefined> {
    await this.initialize()
    const info = this.index.sessions.find((item) => item.id === sessionId)
    return info ? clone(info) : undefined
  }

  async rename(sessionId: string, name: string): Promise<SessionInfo> {
    await this.initialize()
    const info = this.requireInfo(sessionId)
    info.name = name.trim() || 'New session'
    info.updatedAt = Date.now()
    await this.persistIndex()
    return clone(info)
  }

  async setLane(sessionId: string, lane?: string): Promise<SessionInfo> {
    await this.initialize()
    const info = this.requireInfo(sessionId)
    const trimmed = lane?.trim()
    if (trimmed) info.lane = trimmed.slice(0, 64)
    else delete info.lane
    info.updatedAt = Date.now()
    await this.persistIndex()
    return clone(info)
  }

  /** List sessions in a lane, newest first. */
  async listByLane(lane: string): Promise<SessionInfo[]> {
    await this.initialize()
    return this.index.sessions
      .filter((item) => item.lane === lane)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(clone)
  }

  async append(sessionId: string, entry: AppendEntry): Promise<SessionEntry> {
    await this.initialize()
    const info = this.requireInfo(sessionId)
    const existing = await this.readEntries(sessionId)
    const item: SessionEntry = {
      id: `entry-${randomUUID()}`,
      sessionId,
      ...(entry.parentId ? { parentId: entry.parentId } : existing.at(-1) ? { parentId: existing.at(-1)?.id } : {}),
      role: entry.role,
      content: entry.content,
      timestamp: Date.now(),
      ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
      ...(entry.toolName ? { toolName: entry.toolName } : {}),
      ...(entry.toolCalls ? { toolCalls: clone(entry.toolCalls) } : {}),
      ...(entry.metadata ? { metadata: clone(entry.metadata) } : {}),
    }
    await appendFile(this.sessionPath(sessionId), `${JSON.stringify(item)}\n`, 'utf8')
    info.updatedAt = item.timestamp
    await this.persistIndex()
    return clone(item)
  }

  async readEntries(sessionId: string): Promise<SessionEntry[]> {
    await this.initialize()
    this.requireInfo(sessionId)
    try {
      const raw = await readFile(this.sessionPath(sessionId), 'utf8')
      return raw.split(/\r?\n/).filter(Boolean).flatMap((line) => {
        try {
          const parsed: unknown = JSON.parse(line)
          return isSessionEntry(parsed) ? [parsed] : []
        } catch {
          return []
        }
      }).map(clone)
    } catch {
      return []
    }
  }

  async branch(sessionId: string, parentEntryId?: string, name?: string): Promise<SessionInfo> {
    await this.initialize()
    const source = await this.readEntries(sessionId)
    const cutoff = parentEntryId ? source.findIndex((entry) => entry.id === parentEntryId) : source.length - 1
    const inherited = cutoff < 0 ? [] : source.slice(0, cutoff + 1)
    const branch = await this.create(name ?? `${this.requireInfo(sessionId).name} (branch)`)
    if (inherited.length > 0) {
      const mapping = new Map<string, string>()
      const clonedEntries = inherited.map((entry) => {
        const id = `entry-${randomUUID()}`
        mapping.set(entry.id, id)
        return {
          ...clone(entry),
          id,
          sessionId: branch.id,
          parentId: entry.parentId ? mapping.get(entry.parentId) : undefined,
        }
      })
      const lines = clonedEntries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
      await writeFile(this.sessionPath(branch.id), lines, 'utf8')
      const latest = clonedEntries.at(-1)
      const info = this.requireInfo(branch.id)
      info.updatedAt = latest?.timestamp ?? info.updatedAt
      await this.persistIndex()
    }
    return clone(this.requireInfo(branch.id))
  }

  /** Replace old history with one summary entry plus a preserved recent suffix. */
  async compact(sessionId: string, summary: string, keepEntryIds: string[]): Promise<SessionEntry> {
    await this.initialize()
    const info = this.requireInfo(sessionId)
    const entries = await this.readEntries(sessionId)
    const keep = new Set(keepEntryIds)
    const recent = entries.filter((entry) => keep.has(entry.id))
    const summaryEntry: SessionEntry = {
      id: `entry-${randomUUID()}`,
      sessionId,
      role: 'summary',
      content: summary.trim(),
      timestamp: Date.now(),
      metadata: { compactedEntryIds: entries.filter((entry) => !keep.has(entry.id)).map((entry) => entry.id) },
    }
    const rewritten = [summaryEntry]
    let parentId = summaryEntry.id
    for (const entry of recent) {
      const next = { ...entry, parentId }
      rewritten.push(next)
      parentId = next.id
    }
    const temp = `${this.sessionPath(sessionId)}.tmp`
    await writeFile(temp, `${rewritten.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8')
    await rename(temp, this.sessionPath(sessionId))
    info.updatedAt = summaryEntry.timestamp
    await this.persistIndex()
    return clone(summaryEntry)
  }

  async delete(sessionId: string): Promise<void> {
    await this.initialize()
    this.requireInfo(sessionId)
    await rm(this.sessionPath(sessionId), { force: true })
    this.index.sessions = this.index.sessions.filter((item) => item.id !== sessionId)
    await this.persistIndex()
  }

  async export(sessionId: string): Promise<SessionSnapshot> {
    await this.initialize()
    const info = this.requireInfo(sessionId)
    return { info: clone(info), entries: await this.readEntries(sessionId) }
  }

  private requireInfo(sessionId: string): SessionInfo {
    if (!isSafeSessionId(sessionId)) throw new Error(`Invalid session id: ${sessionId}`)
    const info = this.index.sessions.find((item) => item.id === sessionId)
    if (!info) throw new Error(`Unknown session: ${sessionId}`)
    return info
  }

  private indexPath(): string { return join(this.directory, 'index.json') }

  private sessionPath(sessionId: string): string {
    if (!isSafeSessionId(sessionId)) throw new Error(`Invalid session id: ${sessionId}`)
    return join(this.directory, `${sessionId}.jsonl`)
  }

  private async persistIndex(): Promise<void> {
    const temp = `${this.indexPath()}.tmp`
    await mkdir(dirname(this.indexPath()), { recursive: true })
    await writeFile(temp, JSON.stringify(this.index, null, 2), 'utf8')
    await rename(temp, this.indexPath())
  }
}

function isStoredIndex(value: unknown): value is StoredIndex {
  return typeof value === 'object' && value !== null && Array.isArray((value as { sessions?: unknown }).sessions)
    && (value as { sessions: unknown[] }).sessions.every(isSessionInfo)
}

function isSessionInfo(value: unknown): value is SessionInfo {
  if (typeof value !== 'object' || value === null) return false
  const info = value as Partial<SessionInfo>
  return typeof info.id === 'string' && isSafeSessionId(info.id)
    && typeof info.name === 'string' && typeof info.createdAt === 'number' && typeof info.updatedAt === 'number'
    && (info.lane === undefined || typeof info.lane === 'string')
}

function isSessionEntry(value: unknown): value is SessionEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<SessionEntry>
  return typeof entry.id === 'string' && typeof entry.sessionId === 'string' && isSafeSessionId(entry.sessionId)
    && typeof entry.role === 'string' && typeof entry.content === 'string' && typeof entry.timestamp === 'number'
}

export { isSafeSessionId }
export default SessionStore
