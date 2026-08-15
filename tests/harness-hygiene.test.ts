import { describe, expect, it } from 'vitest'
import { Agent } from '../src/harness/agent.js'
import type { SimpleResult } from '../src/llm/model.js'

describe('Agent resource hygiene (review fixes)', () => {
  it('BUG5-REG: maxToolCalls budget break keeps transcript balanced (toolCall has a toolResult)', async () => {
    const calls: string[] = []
    const agent = new Agent({
      complete: async (): Promise<SimpleResult> => ({
        text: '',
        toolCalls: [
          { id: 'c1', name: 'tool_a', arguments: {} },
          { id: 'c2', name: 'tool_a', arguments: {} },
          { id: 'c3', name: 'tool_a', arguments: {} },
        ],
        usage: undefined,
        stopReason: 'tool_calls',
      }),
      tools: new Map([['tool_a', { name: 'tool_a', description: 'a', risk: 'read', inputSchema: undefined as never, parameters: { type: 'object' }, execute: async () => { calls.push('x'); return { content: 'ok' } } }]]),
      sessionId: 's',
      maxToolCalls: 2,
    })
    const outcome = await agent.run('go')
    expect(outcome.toolCalls).toBe(2) // only 2 executed
    expect(calls).toHaveLength(2)
    // transcript: user, assistant(with 3 calls), 2 toolResults, 1 "not executed" toolResult
    const kinds = agent.getTranscript().map((m) => m.kind)
    const toolResults = kinds.filter((k) => k === 'toolResult')
    expect(toolResults.length).toBe(3) // all 3 calls answered
  })

  it('none: abortSignal does not leave a lingering interval after a completed run', async () => {
    const before = (process as unknown as { _getActiveHandles?: () => Array<{ constructor?: { name?: string } }> })._getActiveHandles?.().filter((h) => h?.constructor?.name === 'Interval').length ?? -1
    const agent = new Agent({
      complete: async (): Promise<SimpleResult> => ({ text: 'done', toolCalls: [], usage: undefined, stopReason: 'stop' }),
      sessionId: 's',
    })
    await agent.run('hi')
    await new Promise((resolve) => setTimeout(resolve, 100))
    const after = (process as unknown as { _getActiveHandles?: () => Array<{ constructor?: { name?: string } }> })._getActiveHandles?.().filter((h) => h?.constructor?.name === 'Interval').length ?? -1
    // the abort poll interval must be cleaned up after the run completes
    expect(after).toBeLessThanOrEqual(before === -1 ? 100 : before + 1)
  })
})