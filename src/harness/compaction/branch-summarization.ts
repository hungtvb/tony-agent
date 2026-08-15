import type { Usage } from '../../llm/model.js'
import { createEntry, type Entry } from '../session/types.js'

export interface BranchSummaryOptions {
  fromSeq: number
  summary: string
  usage?: Usage
}

/**
 * Generate a branch_summary entry that records what happened on this lane
 * after `fromSeq`, so the parent lane can reference the divergence without
 * carrying the messages.
 */
export async function createBranchSummary(entries: Entry[], options: BranchSummaryOptions): Promise<Entry> {
  const materialized = options.summary && options.summary.length > 0
    ? options.summary
    : `Diverged at seq ${options.fromSeq} (${entries.length - options.fromSeq} subsequent entries)`
  return createEntry({
    seq: entries.length + 1,
    parentId: entries.at(-1)?.seq ?? 0,
    kind: 'branch_summary',
    summary: materialized,
    fromSeq: options.fromSeq,
    ...(options.usage ? { usage: options.usage } : {}),
  })
}