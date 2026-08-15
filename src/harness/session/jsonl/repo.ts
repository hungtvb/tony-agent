import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createEntry, isEntry, type Entry } from '../types.js'

export interface Session {
  id: string
  getEntries(): Entry[]
  append(entry: Entry): Promise<void>
  getNextSeq(): number
}

const SAFE_ID = /^[a-z0-9_-]{1,128}$/

function safeId(id: string): void {
  if (!SAFE_ID.test(id)) throw new Error(`Invalid session id: ${id}`)
}

/**
 * Append-only JSONL session repository with atomic writes, branching from a
 * specific entry (including from another lane), and corruption tolerance on
 * reopen. One file per session: {dir}/{id}.jsonl.
 */
export class JsonlSessionRepo {
  readonly directory: string

  constructor(directory: string) {
    this.directory = directory
  }

  private path(id: string): string { return join(this.directory, `${id}.jsonl`) }

  private async readEntries(id: string): Promise<Entry[]> {
    const entries: Entry[] = []
    try {
      const raw = await readFile(this.path(id), 'utf8')
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        try {
          const parsed = JSON.parse(trimmed) as unknown
          if (isEntry(parsed)) entries.push(parsed)
        } catch {
          // tolerate a corrupted line
        }
      }
    } catch {
      // no file yet
    }
    return entries
  }

  async create(id: string): Promise<Session> {
    safeId(id)
    await mkdir(this.directory, { recursive: true })
    const entries: Entry[] = []
    // materialize the file so list() sees the session
    await this.writeAtomically(id, entries)
    const repo = this
    return {
      id,
      getEntries: () => entries,
      async append(entry: Entry) {
        if (entry.seq !== entries.length + 1) {
          // allow out-of-order only if it continues the chain
          if (entry.seq <= entries.length) throw new Error(`Duplicate seq ${entry.seq}`)
        }
        entries.push(entry)
        await repo.writeAtomically(id, entries)
      },
      getNextSeq: () => entries.length + 1,
    }
  }

  async open(id: string): Promise<Session> {
    safeId(id)
    const entries = await this.readEntries(id)
    const repo = this
    return {
      id,
      getEntries: () => entries,
      async append(entry: Entry) {
        entries.push(entry)
        await repo.writeAtomically(id, entries)
      },
      getNextSeq: () => entries.length + 1,
    }
  }

  async branch(id: string, newId: string, fromSeq: number): Promise<Session> {
    safeId(id)
    safeId(newId)
    const source = await this.readEntries(id)
    const head = source.filter((entry) => entry.seq <= fromSeq)
    const branchEntries = [...head]
    await this.writeAtomically(newId, branchEntries)
    const repo = this
    return {
      id: newId,
      getEntries: () => branchEntries,
      async append(entry: Entry) {
        branchEntries.push(entry)
        await repo.writeAtomically(newId, branchEntries)
      },
      getNextSeq: () => branchEntries.length + 1,
    }
  }

  async list(): Promise<string[]> {
    try {
      const files = await readdir(this.directory)
      return files.filter((file) => file.endsWith('.jsonl')).map((file) => file.replace(/\.jsonl$/, '')).sort()
    } catch {
      return []
    }
  }

  async delete(id: string): Promise<void> {
    safeId(id)
    await rm(this.path(id), { force: true })
  }

  async writeAtomically(id: string, entries: Entry[]): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const temp = `${this.path(id)}.tmp`
    const lines = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
    await writeFile(temp, lines, 'utf8')
    await rename(temp, this.path(id))
  }
}

export { createEntry }
export type { Entry }