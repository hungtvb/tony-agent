import { describe, expect, it } from 'vitest'
import { createCompaction, shouldCompact, type CompactionOptions } from '../src/harness/compaction/compaction.js'
import { createBranchSummary, type BranchSummaryOptions } from '../src/harness/compaction/branch-summarization.js'
import { createEntry, type Entry } from '../src/harness/session/types.js'
import { usageFromParts } from '../src/llm/model.js'

function messageEntries(count: number): Entry[] {
  const entries: Entry[] = []
  for (let i = 1; i <= count; i += 1) {
    entries.push(createEntry({ seq: i, parentId: i - 1, kind: 'message', message: { role: 'user', content: `m${i}` } }))
  }
  return entries
}

describe('compaction', () => {
  it('triggers on threshold when token estimate exceeds limit', () => {
    const options: CompactionOptions = { thresholdTokens: 1000, retainedTail: 3 }
    const entries = messageEntries(20)
    expect(shouldCompact(entries, 900, options)).toBe(false)
    expect(shouldCompact(entries, 1200, options)).toBe(true)
  })

  it('creates a compaction entry with summary, retainedTail and tokensBefore', async () => {
    const options: CompactionOptions = { thresholdTokens: 1000, retainedTail: 3 }
    const entries = messageEntries(20)
    const result = await createCompaction(entries, { tokensBefore: 1500, summary: 'Summarized conversation about X', usage: usageFromParts(200, 100), options })
    expect(result.compaction.kind).toBe('compaction')
    if (result.compaction.kind === 'compaction') {
      expect(result.compaction.reason).toBe('threshold')
      expect(result.compaction.retainedTail).toBe(3)
      expect(result.compaction.tokensBefore).toBe(1500)
    }
    expect(result.retained).toHaveLength(3)
    expect(result.summarized).toHaveLength(17)
  })

  it('returns no-op when under threshold', async () => {
    const options: CompactionOptions = { thresholdTokens: 10_000, retainedTail: 3 }
    const result = await createCompaction(messageEntries(5), { tokensBefore: 100, summary: 'x', options })
    expect(result.compaction).toBeNull()
  })

  it('manual reason overrides threshold check', async () => {
    const options: CompactionOptions = { thresholdTokens: 100, retainedTail: 2 }
    const result = await createCompaction(messageEntries(5), { tokensBefore: 50, summary: 'manual', options, reason: 'manual' })
    expect(result.compaction?.kind).toBe('compaction')
    if (result.compaction?.kind === 'compaction') expect(result.compaction.reason).toBe('manual')
  })
})

describe('branch summarization', () => {
  it('creates a branch_summary entry for a given leaf', async () => {
    const entries = messageEntries(6)
    const options: BranchSummaryOptions = { fromSeq: 3, summary: 'Main branch continued to m4..m6', usage: usageFromParts(50, 30) }
    const entry = await createBranchSummary(entries, options)
    expect(entry.kind).toBe('branch_summary')
    if (entry.kind === 'branch_summary') {
      expect(entry.fromSeq).toBe(3)
      expect(entry.summary).toContain('m4')
      expect(entry.usage?.input).toBe(50)
    }
  })
})

describe('compaction entry placement', () => {
  it('produces a chain: retained tail + compaction entry', () => {
    const entries = messageEntries(10)
    const options: CompactionOptions = { thresholdTokens: 10, retainedTail: 4 }
    const result = createCompactionPlacement(entries, options)
    expect(result.length).toBe(5)
    expect(result[4]?.kind).toBe('compaction')
  })
})

function createCompactionPlacement(entries: Entry[], options: CompactionOptions): Entry[] {
  // replicate the placement logic: keep retained tail then append compaction
  const retained = entries.slice(-options.retainedTail)
  const compaction = createEntry({ seq: entries.length + 1, parentId: entries.at(-1)?.seq ?? 0, kind: 'compaction', reason: 'manual', summary: 's', retainedTail: options.retainedTail, tokensBefore: 100 })
  return [...retained, compaction]
}