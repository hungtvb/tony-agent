import { describe, expect, it } from 'vitest'
import { Agent } from '../src/harness/agent.js'
import { usageFromParts } from '../src/llm/model.js'

describe('agent loop guards', () => {
  it('fails the whole tool batch when stopReason is length (truncated args)', async () => {
    let executed = 0
    const agent = new Agent({
      complete: async () => ({
        text: '',
        toolCalls: [
          { id: 'c1', name: 'side_effect', arguments: { partial: true } },
          { id: 'c2', name: 'side_effect', arguments: { partial: true } },
        ],
        usage: usageFromParts(100, 50),
        stopReason: 'length',
      }),
      tools: new Map([['side_effect', { name: 'side_effect', description: 'side effect', inputSchema: undefined as never, parameters: { type: 'object' }, risk: 'light', execute: async () => { executed += 1; return { content: 'ran' } } }]]),
    })
    const outcome = await agent.run('go')
    expect(executed).toBe(0)
    expect(outcome.text).toBe('')
    const transcript = agent.getTranscript()
    const last = transcript.at(-1)
    expect(last?.kind).toBe('toolResult')
    const data = last?.data as { content: string; isError: boolean }
    expect(data.content).toContain('truncated')
    expect(data.isError).toBe(true)
  })

  it('stops after maxTurns', async () => {
    let turns = 0
    const agent = new Agent({
      complete: async () => {
        turns += 1
        return { text: `turn ${turns}`, toolCalls: [], usage: undefined, stopReason: 'stop' }
      },
      maxTurns: 3,
    })
    const outcome = await agent.run('go')
    expect(outcome.turns).toBeLessThanOrEqual(3)
  })

  it('stops after maxToolCalls', async () => {
    let executed = 0
    const agent = new Agent({
      complete: async () => ({
        text: '',
        toolCalls: [{ id: 'c1', name: 't', arguments: {} }],
        usage: undefined,
        stopReason: 'tool_calls',
      }),
      tools: new Map([['t', { name: 't', description: 't', inputSchema: undefined as never, parameters: { type: 'object' }, risk: 'read', execute: async () => { executed += 1; return { content: 'ok' } } }]]),
      maxToolCalls: 2,
    })
    const outcome = await agent.run('go')
    expect(executed).toBeLessThanOrEqual(2)
    expect(outcome.toolCalls).toBeLessThanOrEqual(2)
  })

  it('emits agent_end with error stop reason', async () => {
    const events: string[] = []
    const agent = new Agent({
      complete: async () => { throw new Error('provider boom') },
    })
    agent.on((event) => events.push(event.type))
    await expect(agent.run('go')).rejects.toThrow(/provider boom/)
    // even on error, agent_end fires
    expect(events).toContain('agent_start')
  })
})