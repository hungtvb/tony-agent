import { describe, expect, it } from 'vitest'
import { createInProcessSubagentProvider } from '../src/subagent/registry.js'
import { AgentMessage } from '../src/harness/messages.js'
import { usageFromParts } from '../src/llm/model.js'
import type { SimpleMessage } from '../src/llm/model.js'

/**
 * Subagent cold resume (ticket t_323e5751): a child continues from a
 * persisted session transcript (entries → deriveMessages → fromWire) instead
 * of starting from scratch — the session log stays the single source of truth.
 */

function sessionEntries(lines: Array<{ role: 'user' | 'assistant'; content: string }>) {
  return lines.map((line, index) => ({
    id: `e${index}`,
    seq: index + 1,
    role: line.role,
    content: line.content,
    timestamp: Date.now() + index,
  }))
}

function makeComplete(seen: Array<{ messages: SimpleMessage[] }>) {
  return async (request: { messages: SimpleMessage[] }) => {
    seen.push(request)
    return {
      text: 'ack',
      toolCalls: [],
      usage: usageFromParts(20, 5),
      stopReason: 'stop' as const,
    }
  }
}

describe('subagent cold resume', () => {
  it('resume:true with persisted entries continues from the stored transcript', async () => {
    const seen: Array<{ messages: SimpleMessage[] }> = []
    const entries = sessionEntries([
      { role: 'user', content: 'step 1: init' },
      { role: 'assistant', content: 'started' },
    ])
    const provider = createInProcessSubagentProvider({
      complete: makeComplete(seen) as never,
      loadSessionEntries: async () => entries,
    })
    const result = await provider.start({
      prompt: 'continue the work',
      sessionId: 'child-abc',
      resume: true,
    })
    expect(result.childId).toBe('child-abc')
    expect(result.resumed).toBe(true)
    // the resumed run's first LLM request must include the persisted transcript
    const firstRequest = seen[0]?.messages ?? []
    const textParts = firstRequest
      .map((m) => (Array.isArray(m.content) ? m.content.map((p) => (p.type === 'text' ? p.text : '')).join('') : String(m.content)))
      .join(' ')
    expect(textParts).toContain('step 1: init')
    expect(textParts).toContain('started')
    expect(textParts).toContain('continue the work')
  })

  it('resume:false (no loader/entries) starts fresh', async () => {
    const seen: Array<{ messages: SimpleMessage[] }> = []
    const provider = createInProcessSubagentProvider({
      complete: makeComplete(seen) as never,
    })
    const result = await provider.start({ prompt: 'hello fresh', sessionId: 'child-fresh' })
    expect(result.resumed).toBeUndefined()
    const textParts = (seen[0]?.messages ?? [])
      .map((m) => (Array.isArray(m.content) ? m.content.map((p) => (p.type === 'text' ? p.text : '')).join('') : String(m.content)))
      .join(' ')
    expect(textParts).toContain('hello fresh')
    expect(textParts).not.toContain('step 1: init')
  })

  it('fromWire round-trips a transcript with tool calls and results', () => {
    const wire: SimpleMessage[] = [
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking' },
          { type: 'toolCall', id: 'c9', name: 'ls', arguments: { path: '.' } },
        ],
      },
      { role: 'toolResult', content: JSON.stringify({ toolCallId: 'c9', name: 'ls', content: 'a.txt', isError: false }) },
    ]
    const transcript = AgentMessage.fromWire(wire)
    expect(transcript).toHaveLength(3)
    expect(transcript[0]?.kind).toBe('user')
    expect(transcript[1]?.kind).toBe('assistant')
    const assistantData = transcript[1]!.data as { toolCalls: Array<{ id: string; name: string }> }
    expect(assistantData.toolCalls?.[0]?.id).toBe('c9')
    expect(transcript[2]?.kind).toBe('toolResult')
    const toolData = transcript[2]!.data as { toolCallId: string; name: string; content: string }
    expect(toolData.toolCallId).toBe('c9')
    expect(toolData.content).toBe('a.txt')
  })
})