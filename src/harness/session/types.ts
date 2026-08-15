import type { Usage } from '../../llm/model.js'
import type { SimpleMessage } from '../../llm/model.js'

export type EntryKind = 'message' | 'model_change' | 'thinking_level_change' | 'active_tools_change' | 'compaction' | 'branch_summary' | 'custom'

export interface EntryBase {
  seq: number
  parentId: number
  timestamp: number
}

export interface MessageEntry extends EntryBase {
  kind: 'message'
  message: SimpleMessage
}

export interface ModelChangeEntry extends EntryBase {
  kind: 'model_change'
  model: string
}

export interface ThinkingChangeEntry extends EntryBase {
  kind: 'thinking_level_change'
  level: string
}

export interface ActiveToolsChangeEntry extends EntryBase {
  kind: 'active_tools_change'
  tools: string[]
}

export interface CompactionEntry extends EntryBase {
  kind: 'compaction'
  reason: 'threshold' | 'overflow' | 'manual'
  summary: string
  retainedTail: number
  tokensBefore: number
}

export interface BranchSummaryEntry extends EntryBase {
  kind: 'branch_summary'
  summary: string
  fromSeq: number
  usage?: Usage
}

export interface CustomEntry extends EntryBase {
  kind: 'custom'
  customType: string
  payload: unknown
}

export type Entry =
  | MessageEntry
  | ModelChangeEntry
  | ThinkingChangeEntry
  | ActiveToolsChangeEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry

export type EntryInput =
  | { kind: 'message'; message: SimpleMessage }
  | { kind: 'model_change'; model: string }
  | { kind: 'thinking_level_change'; level: string }
  | { kind: 'active_tools_change'; tools: string[] }
  | { kind: 'compaction'; reason: 'threshold' | 'overflow' | 'manual'; summary: string; retainedTail: number; tokensBefore: number }
  | { kind: 'branch_summary'; summary: string; fromSeq: number; usage?: Usage }
  | { kind: 'custom'; customType: string; payload: unknown }

/** Create an entry with seq, parentId and monotonic timestamp. */
export function createEntry(input: EntryInput & { seq: number; parentId: number }): Entry {
  const base = { seq: input.seq, parentId: input.parentId, timestamp: Date.now() }
  switch (input.kind) {
    case 'message': return { ...base, kind: 'message', message: input.message } satisfies MessageEntry
    case 'model_change': return { ...base, kind: 'model_change', model: input.model } satisfies ModelChangeEntry
    case 'thinking_level_change': return { ...base, kind: 'thinking_level_change', level: input.level } satisfies ThinkingChangeEntry
    case 'active_tools_change': return { ...base, kind: 'active_tools_change', tools: input.tools } satisfies ActiveToolsChangeEntry
    case 'compaction': return { ...base, kind: 'compaction', reason: input.reason, summary: input.summary, retainedTail: input.retainedTail, tokensBefore: input.tokensBefore } satisfies CompactionEntry
    case 'branch_summary': return { ...base, kind: 'branch_summary', summary: input.summary, fromSeq: input.fromSeq, ...(input.usage ? { usage: input.usage } : {}) } satisfies BranchSummaryEntry
    case 'custom': return { ...base, kind: 'custom', customType: input.customType, payload: input.payload } satisfies CustomEntry
  }
}

/** Basic structural guard for entries. */
export function isEntry(value: unknown): value is Entry {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<Entry>
  if (typeof candidate.seq !== 'number' || typeof candidate.parentId !== 'number') return false
  return typeof candidate.kind === 'string' && ENTRY_KINDS.has(candidate.kind)
}

const ENTRY_KINDS = new Set(['message', 'model_change', 'thinking_level_change', 'active_tools_change', 'compaction', 'branch_summary', 'custom'])