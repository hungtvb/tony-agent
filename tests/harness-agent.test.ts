import { describe, expect, it } from 'vitest'
import { Agent, type AgentEventType, type PendingMessageQueueOptions } from '../src/harness/agent.js'
import { AgentMessage } from '../src/harness/messages.js'
import { usageFromParts } from '../src/llm/model.js'

function scriptedSteps(steps: Array<{ text?: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; stopReason?: string }>): Record<string, unknown> {
  // returns options for the test agent: a queue of assistant turns
  let queue = [...steps]
  return {
    complete(context: { messages: unknown[] }) {
      void context
      const next = queue.shift() ?? { text: 'done', toolCalls: [], stopReason: 'stop' }
      return Promise.resolve({
        text: next.text ?? '',
        toolCalls: next.toolCalls ?? [],
        usage: usageFromParts(10, 5),
        stopReason: next.stopReason ?? 'stop',
      })
    },
  }
}

describe('Agent', () => {
  it('emits lifecycle events for a simple run (no tools)', async () => {
    const agent = new Agent({ complete: scriptedSteps([{ text: 'hello world', stopReason: 'stop' }]).complete })
    const events: AgentEventType[] = []
    agent.on('event', (event) => events.push(event.type))

    const outcome = await agent.run('say hi')

    expect(outcome.text).toBe('hello world')
    expect(events).toContain('agent_start')
    expect(events).toContain('turn_start')
    expect(events).toContain('turn_end')
    expect(events).toContain('agent_end')
  })

  it('executes tool calls and feeds results back until stop', async () => {
    const complete = scriptedSteps([
      { text: 'let me check', toolCalls: [{ id: 'c1', name: 'echo_tool', arguments: { value: 'x' } }], stopReason: 'tool_calls' },
      { text: 'result is x', stopReason: 'stop' },
    ]).complete
    const agent = new Agent({
      complete,
      tools: new Map([['echo_tool', { name: 'echo_tool', description: 'echo', inputSchema: undefined as never, parameters: { type: 'object', properties: { value: { type: 'string' } } }, risk: 'read', execute: async (args: { value: string }) => ({ content: `echo:${args.value}` }) }]]),
    })
    const events: AgentEventType[] = []
    agent.on('event', (event) => events.push(event.type))

    const outcome = await agent.run('run it')
    expect(outcome.text).toBe('result is x')
    expect(outcome.toolCalls).toBeGreaterThanOrEqual(1)
    expect(events).toContain('tool_started')
    expect(events).toContain('tool_result')
  })

  it('supports steering: queued steering messages drain before finish', async () => {
    const complete = scriptedSteps([
      { text: 'first', stopReason: 'stop' },
      { text: 'steered', stopReason: 'stop' },
    ]).complete
    const agent = new Agent({ complete })
    const outcomePromise = agent.run('initial')
    // steer while running
    setTimeout(() => agent.steer('follow up please'), 0)
    const outcome = await outcomePromise
    expect(['first', 'steered']).toContain(outcome.text)
  })

  it('supports follow-up with one-at-a-time mode', async () => {
    const complete = scriptedSteps([
      { text: 'a', stopReason: 'stop' },
      { text: 'b', stopReason: 'stop' },
    ]).complete
    const agent = new Agent({ complete })
    const options: PendingMessageQueueOptions = { type: 'one-at-a-time' }
    const outcomePromise = agent.run('go', options)
    agent.followUp(() => '\n[follow up]')
    const outcome = await outcomePromise
    expect(outcome.text).toBe('b')
  })

  it('fires hooks: beforeToolCall and afterToolCall in order', async () => {
    const order: string[] = []
    const complete = scriptedSteps([
      { text: '', toolCalls: [{ id: 'c1', name: 'echo_tool', arguments: { value: 'x' } }], stopReason: 'tool_calls' },
      { text: 'done', stopReason: 'stop' },
    ]).complete
    const agent = new Agent({
      complete,
      tools: new Map([['echo_tool', { name: 'echo_tool', description: 'echo', inputSchema: undefined as never, parameters: { type: 'object' }, risk: 'read', execute: async () => ({ content: 'ok' }) }]]),
      hooks: {
        beforeToolCall: async () => { order.push('before') },
        afterToolCall: async () => { order.push('after') },
      },
    })
    await agent.run('go')
    expect(order).toEqual(['before', 'after'])
  })

  it('supports abort mid-turn and reports run_end', async () => {
    const complete = scriptedSteps([{ text: 'slow', stopReason: 'stop' }]).complete
    const agent = new Agent({ complete })
    const outcomePromise = agent.run('do it')
    agent.abort()
    const outcome = await outcomePromise
    expect(outcome.aborted).toBe(true)
  })

  it('respects shouldStopAfterTurn hook', async () => {
    const complete = scriptedSteps([
      { text: 'first', stopReason: 'stop' },
      { text: 'second', stopReason: 'stop' },
    ]).complete
    let calls = 0
    const agent = new Agent({ complete, hooks: { shouldStopAfterTurn: async () => { calls += 1; return calls >= 1 } } })
    const outcome = await agent.run('go')
    expect(outcome.text).toBe('first')
  })

  it('supports parallel tool batch mode', async () => {
    const complete = scriptedSteps([
      { text: '', toolCalls: [
        { id: 'c1', name: 'slow_tool', arguments: {} },
        { id: 'c2', name: 'fast_tool', arguments: {} },
      ], stopReason: 'tool_calls' },
      { text: 'parallel done', stopReason: 'stop' },
    ]).complete
    let fastStarted = 0
    const agent = new Agent({
      complete,
      tools: new Map([
        ['slow_tool', { name: 'slow_tool', description: 'slow', inputSchema: undefined as never, parameters: { type: 'object' }, risk: 'read', execute: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return { content: 'slow' } } }],
        ['fast_tool', { name: 'fast_tool', description: 'fast', inputSchema: undefined as never, parameters: { type: 'object' }, risk: 'read', execute: async () => { fastStarted += 1; return { content: 'fast' } } }],
      ]),
      toolBatchMode: 'parallel',
    })
    const outcome = await agent.run('go')
    expect(outcome.text).toBe('parallel done')
    expect(fastStarted).toBeGreaterThanOrEqual(1)
  })
})