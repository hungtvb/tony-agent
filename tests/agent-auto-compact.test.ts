import { describe, expect, it } from 'vitest'
import { compactMessages, TonyAgent } from '../src/agent.js'
import { PermissionPolicy } from '../src/permissions/policy.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { estimateMessageTokens } from '../src/llm/tokens.js'
import type { LLMCompleter, LLMMessage, LLMResult } from '../src/types.js'

class ScriptedLLM implements LLMCompleter {
  public readonly requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
  private index = 0

  constructor(private readonly responses: LLMResult[]) {}

  async complete(request: { messages: Array<{ role: string; content: string }> }): Promise<LLMResult> {
    this.requests.push({ messages: request.messages })
    const response = this.responses[Math.min(this.index++, this.responses.length - 1)]
    if (!response) throw new Error('No scripted response')
    return response
  }
}

function bigContent(label: string, chars: number): string {
  return `[${label}] ` + 'x'.repeat(chars)
}

function historyWithBigMiddle(): LLMMessage[] {
  // system + 20 large middle messages + small recent tail
  const messages: LLMMessage[] = [{ role: 'system', content: 'system prompt' }]
  for (let i = 0; i < 20; i += 1) {
    messages.push({ role: 'user', content: bigContent('u' + i, 2000) })
    messages.push({ role: 'assistant', content: bigContent('a' + i, 2000) })
  }
  for (let i = 0; i < 6; i += 1) {
    messages.push({ role: 'user', content: 'recent question ' + i })
    messages.push({ role: 'assistant', content: 'recent answer ' + i })
  }
  return messages
}

describe('compactMessages', () => {
  it('returns undefined when the request fits the budget', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]
    expect(compactMessages(messages, 10_000)).toBeUndefined()
  })

  it('keeps system head + recent tail and injects a compaction note when over budget', () => {
    const messages = historyWithBigMiddle()
    const beforeTokens = estimateMessageTokens(messages)
    const result = compactMessages(messages, Math.floor(beforeTokens / 2))
    expect(result).toBeDefined()
    const compacted = result!.messages
    // System head preserved.
    expect(compacted[0]?.role).toBe('system')
    expect(compacted[0]?.content).toBe('system prompt')
    // Exactly one synthetic note, marked as auto-compacted.
    const notes = compacted.filter((m) => m.content.includes('[context auto-compacted]'))
    expect(notes).toHaveLength(1)
    // Recent tail intact (last message survives verbatim).
    expect(compacted.at(-1)?.content).toBe(messages.at(-1)?.content)
    expect(compacted.at(-1)?.role).toBe('assistant')
    // Smaller than the original request.
    expect(estimateMessageTokens(compacted)).toBeLessThan(beforeTokens)
    // Report counts match.
    expect(result!.beforeCount).toBe(messages.length)
    expect(result!.afterCount).toBe(compacted.length)
  })

  it('reports dropped tool calls in the note', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'assistant', toolCalls: [{ id: 'c1', name: 'fs_read', arguments: { path: 'a' } }], content: '' },
      { role: 'tool', content: 'data', toolCallId: 'c1' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      ...Array.from({ length: 14 }, (_, i): LLMMessage => ({ role: 'user' as const, content: 'filler ' + i })),
      { role: 'user', content: 'final question' },
      { role: 'assistant', content: 'final answer' },
    ]
    const result = compactMessages(messages, 10)
    expect(result).toBeDefined()
    const note = result!.messages.find((m) => m.content.includes('[context auto-compacted]'))
    expect(note?.content).toContain('1 tool call(s)')
  })

  it('refuses to compact when there is no dispensable middle', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 8 }, (_, i): LLMMessage => ({ role: 'user' as const, content: bigContent('big' + i, 4000) })),
    ]
    // Over budget but only ~8 non-system messages — nothing safe to drop.
    expect(compactMessages(messages, 100, 12)).toBeUndefined()
  })
})

describe('TonyAgent auto-compact (request-shaping only)', () => {
  it('trims the request sent to the LLM but never mutates persisted conversation/history', async () => {
    const llm = new ScriptedLLM([{ text: 'done', toolCalls: [] }])
    const registry = new ToolRegistry()
    const events: string[] = []
    const agent = new TonyAgent({
      llm,
      registry,
      permissions: new PermissionPolicy(),
      history: historyWithBigMiddle(),
      compactThresholdTokens: 2000,
      onEvent: (event) => events.push(event.type),
    })

    const result = await agent.run('answer from recent context')

    // The model saw a compacted view...
    const seen = llm.requests[0]?.messages ?? []
    expect(seen.some((m) => m.content.includes('[context auto-compacted]'))).toBe(true)
    expect(seen.length).toBeLessThan(result.messages.length)
    // ...including the live user prompt as the last message.
    expect(seen.at(-1)?.role).toBe('user')
    expect(seen.at(-1)?.content).toBe('answer from recent context')
    // The full conversation is untouched — history keeps every message (+user prompt, +reply).
    expect(agent.history.length).toBe(historyWithBigMiddle().length + 2)
    expect(agent.history.some((m) => m.content === 'answer from recent context')).toBe(true)
    // A context_compact event was emitted.
    expect(events).toContain('context_compact')
    const compactEventIndex = events.indexOf('context_compact')
    expect(events.indexOf('agent_start')).toBeLessThan(compactEventIndex)
    expect(events.indexOf('agent_end')).toBeGreaterThan(compactEventIndex)
  })

  it('does not emit context_compact when under budget', async () => {
    const llm = new ScriptedLLM([{ text: 'ok', toolCalls: [] }])
    const events: string[] = []
    const agent = new TonyAgent({
      llm,
      registry: new ToolRegistry(),
      permissions: new PermissionPolicy(),
      history: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'small' },
      ],
      compactThresholdTokens: 50_000,
      onEvent: (event) => events.push(event.type),
    })
    await agent.run('tiny')
    expect(events).not.toContain('context_compact')
  })
})
