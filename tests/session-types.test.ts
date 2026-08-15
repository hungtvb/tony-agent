import { describe, expect, it } from 'vitest'
import { createEntry, isEntry, type Entry } from '../src/harness/session/types.js'

describe('session entry model', () => {
  it('creates a message entry with seq and parentId', () => {
    const entry: Entry = createEntry({ seq: 5, parentId: 4, kind: 'message', message: { role: 'user', content: 'hello' } })
    expect(entry.seq).toBe(5)
    expect(entry.parentId).toBe(4)
    expect(isEntry(entry)).toBe(true)
    expect(entry.timestamp).toBeGreaterThan(0)
  })

  it('creates a model_change entry', () => {
    const entry = createEntry({ seq: 2, parentId: 1, kind: 'model_change', model: 'gpt-4o' })
    expect(entry.kind).toBe('model_change')
    if (entry.kind === 'model_change') expect(entry.model).toBe('gpt-4o')
  })

  it('creates a compaction entry with threshold reason', () => {
    const entry = createEntry({ seq: 10, parentId: 9, kind: 'compaction', reason: 'threshold', summary: 'sum', retainedTail: 3, tokensBefore: 5000 })
    expect(entry.kind).toBe('compaction')
    if (entry.kind === 'compaction') {
      expect(entry.reason).toBe('threshold')
      expect(entry.retainedTail).toBe(3)
      expect(entry.tokensBefore).toBe(5000)
    }
  })

  it('creates a branch_summary entry', () => {
    const entry = createEntry({ seq: 7, parentId: 3, kind: 'branch_summary', summary: 'branch diverged', fromSeq: 3, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 } })
    expect(entry.kind).toBe('branch_summary')
    if (entry.kind === 'branch_summary') expect(entry.fromSeq).toBe(3)
  })

  it('creates custom entries', () => {
    const entry = createEntry({ seq: 8, parentId: 7, kind: 'custom', customType: 'user_meta', payload: { anything: true } })
    expect(entry.kind).toBe('custom')
    if (entry.kind === 'custom') expect(entry.customType).toBe('user_meta')
  })

  it('supports query by kind and order', () => {
    const entries: Entry[] = [
      createEntry({ seq: 1, parentId: 0, kind: 'message', message: { role: 'user', content: 'a' } }),
      createEntry({ seq: 2, parentId: 1, kind: 'model_change', model: 'gpt-4o' }),
      createEntry({ seq: 3, parentId: 2, kind: 'message', message: { role: 'assistant', content: 'b' } }),
      createEntry({ seq: 4, parentId: 3, kind: 'compaction', reason: 'manual', summary: 's', retainedTail: 2, tokensBefore: 100 }),
    ]
    const messages = entries.filter((entry) => entry.kind === 'message')
    expect(messages).toHaveLength(2)
    const ordered = [...entries].sort((a, b) => a.seq - b.seq)
    expect(ordered[0]?.seq).toBe(1)
    expect(ordered[3]?.seq).toBe(4)
  })

  it('rejects invalid entries', () => {
    expect(isEntry(null)).toBe(false)
    expect(isEntry({ seq: 'x' })).toBe(false)
    expect(isEntry({ seq: 1, parentId: 0 })).toBe(false)
  })
})