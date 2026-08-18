import type { LLMMessage, SessionEntry, SessionEntryRole, ToolCall } from '../types.js'

/**
 * deriveMessages — project model history from the session log (dsh rule:
 * "model-visible means logged"). The session log is the ONLY source; fork,
 * resume, compact and telemetry all derive from this stream.
 */
export function deriveMessages(entries: ReadonlyArray<SessionEntry>): LLMMessage[] {
  return entries.flatMap((entry): LLMMessage[] => {
    if (entry.role === 'summary') return [{ role: 'system', content: `Earlier session summary:\n${entry.content}` }]
    if (entry.role === 'tool') return [{ role: 'tool', content: entry.content, name: entry.toolName, toolCallId: entry.toolCallId }]
    if (entry.role === 'system' || entry.role === 'user' || entry.role === 'assistant') {
      return [{ role: entry.role, content: entry.content, ...(entry.toolCalls ? { toolCalls: entry.toolCalls } : {}) }]
    }
    return []
  })
}

/**
 * assertModelVisibleIsLogged — runtime invariant: every message that reaches a
 * model request must be reconstructable from the log. Fails closed in dev/test
 * when TONY_AGENT_ASSERT_LOG=1.
 */
export function assertModelVisibleIsLogged(entries: ReadonlyArray<SessionEntry>, request: ReadonlyArray<LLMMessage>): void {
  const logged = deriveMessages(entries)
  const loggedKeys = logged.map((m) => `${m.role}:${m.content.slice(0, 64)}`)
  for (const message of request) {
    const key = `${message.role}:${message.content.slice(0, 64)}`
    if (!loggedKeys.includes(key)) {
      throw new Error(
        `assertModelVisibleIsLogged: message not present in session log (role=${message.role}). ` +
        `Model-visible means logged.`,
      )
    }
  }
}