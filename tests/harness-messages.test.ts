import { describe, expect, it } from 'vitest'
import { AgentMessage, type AgentMessageData } from '../src/harness/messages.js'
import { usageFromParts } from '../src/llm/model.js'

describe('AgentMessage', () => {
  it('wraps a user message and can convert to wire format', () => {
    const message = AgentMessage.from('user', { content: 'hello' }) as { kind: 'user'; data: { content: string } }
    expect(message.kind).toBe('user')
    const wire = AgentMessage.toWire([message])
    expect(wire[0]).toEqual({ role: 'user', content: 'hello' })
  })

  it('wraps an assistant message with text, tool calls, usage, stop reason', () => {
    const data: AgentMessageData = {
      content: [{ type: 'text', text: 'thinking' }],
      toolCalls: [{ id: 'c1', name: 'browser_snapshot', arguments: {} }],
      usage: usageFromParts(10, 5),
      stopReason: 'tool_calls',
    }
    const message = AgentMessage.from('assistant', data)
    expect(message.kind).toBe('assistant')
    const wire = AgentMessage.toWire([message])
    expect(wire[0]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'thinking' }, { type: 'toolCall', id: 'c1', name: 'browser_snapshot', arguments: {} }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }, stopReason: 'tool_calls' })
  })

  it('wraps a toolResult message', () => {
    const message = AgentMessage.from('toolResult', { toolCallId: 'c1', name: 'browser_snapshot', content: 'ok', isError: false })
    expect(message.kind).toBe('toolResult')
    const wire = AgentMessage.toWire([message])
    expect(wire[0].content).toContain('ok')
  })

  it('wraps a summary message (compaction)', () => {
    const message = AgentMessage.from('summary', { content: 'previous conversation summarized', usage: usageFromParts(0, 0) })
    expect(message.kind).toBe('summary')
    const wire = AgentMessage.toWire([message])
    // summary messages are not sent to the LLM in wire form by default
    expect(wire).toEqual([])
  })

  it('wraps a branchSummary message', () => {
    const message = AgentMessage.from('branchSummary', { content: 'branch divergence summarized', usage: usageFromParts(0, 0) })
    expect(message.kind).toBe('branchSummary')
  })

  it('round-trips through JSON serialization', () => {
    const original = AgentMessage.from('assistant', { content: [{ type: 'text', text: 'hi' }], toolCalls: [], usage: usageFromParts(1, 2), stopReason: 'stop' })
    const parsed = AgentMessage.fromJSON(JSON.parse(JSON.stringify(original)))
    expect(parsed.kind).toBe('assistant')
    const wire = AgentMessage.toWire([parsed])
    expect(wire[0].content).toEqual([{ type: 'text', text: 'hi' }])
  })
})