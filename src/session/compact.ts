export interface CompactEntry {
  id: string
  content: string
}

export interface CompactionPlan<T extends CompactEntry = CompactEntry> {
  source: T[]
  recent: T[]
  estimatedTokens: number
  recentTokens: number
}

export interface CompactionOptions {
  maxTokens: number
  keepRecentTokens: number
  estimate: (text: string) => number
}

/**
 * Selects an old prefix for summarization while preserving a recent suffix.
 * The helper is intentionally provider-agnostic; the caller supplies the summarizer.
 */
export function planCompaction<T extends CompactEntry>(
  entries: T[],
  options: CompactionOptions,
): CompactionPlan<T> | undefined {
  const estimatedTokens = entries.reduce((sum, entry) => sum + options.estimate(entry.content), 0)
  if (estimatedTokens <= options.maxTokens || entries.length < 2) return undefined

  const recent: T[] = []
  let recentTokens = 0
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry) continue
    const tokens = options.estimate(entry.content)
    if (recent.length > 0 && recentTokens + tokens > options.keepRecentTokens) break
    recent.unshift(entry)
    recentTokens += tokens
  }

  const sourceLength = entries.length - recent.length
  if (sourceLength <= 0) return undefined
  return {
    source: entries.slice(0, sourceLength),
    recent,
    estimatedTokens,
    recentTokens,
  }
}

export function formatCompactionSource(entries: CompactEntry[]): string {
  return entries.map((entry) => `[${entry.id}] ${entry.content}`).join('\n\n')
}

export function createSummaryEntryContent(summary: string, source: CompactEntry[]): string {
  return `Compacted ${source.length} earlier entries:\n${summary.trim()}`
}
