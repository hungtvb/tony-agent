import type { Usage } from '../../llm/model.js'
import { createEntry, type Entry } from '../session/types.js'

export interface CompactionOptions {
  thresholdTokens: number
  retainedTail: number
}

export interface CompactionInput {
  tokensBefore: number
  summary: string
  options: CompactionOptions
  usage?: Usage
  reason?: 'threshold' | 'overflow' | 'manual'
}

export interface CompactionResult {
  compaction: Entry | null
  retained: Entry[]
  summarized: Entry[]
}

export function shouldCompact(entries: Entry[], tokensBefore: number, options: CompactionOptions): boolean {
  if (entries.length <= options.retainedTail) return false
  return tokensBefore > options.thresholdTokens
}

/**
 * Create a compaction entry summarizing all but the retained tail.
 * Returns { compaction: null } when under threshold (unless reason=manual).
 */
export async function createCompaction(entries: Entry[], input: CompactionInput): Promise<CompactionResult> {
  const { tokensBefore, summary, options, usage, reason } = input
  const overThreshold = shouldCompact(entries, tokensBefore, options)
  if (!overThreshold && reason !== 'manual') {
    return { compaction: null, retained: entries, summarized: [] }
  }
  const retained = entries.slice(-options.retainedTail)
  const summarized = entries.slice(0, Math.max(0, entries.length - options.retainedTail))
  const compaction = createEntry({
    seq: entries.length + 1,
    parentId: entries.at(-1)?.seq ?? 0,
    kind: 'compaction',
    reason: reason ?? (overThreshold ? 'threshold' : 'manual'),
    summary,
    retainedTail: options.retainedTail,
    tokensBefore,
    ...(usage ? { usage } : {}),
  })
  return { compaction, retained, summarized }
}