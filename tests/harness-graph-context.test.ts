import { describe, it, expect } from 'vitest'
import { Agent } from '../src/harness/agent.js'
import { usageFromParts } from '../src/llm/model.js'
import type { SimpleMessage } from '../src/llm/model.js'
import type { GraphRecallOutput } from '../src/query/graph-context.js'

function capturingComplete(captured: Array<{ messages: SimpleMessage[] }>) {
  return async (request: { messages: SimpleMessage[] }) => {
    captured.push(request)
    return {
      text: 'done',
      toolCalls: [],
      usage: usageFromParts(10, 5),
      stopReason: 'stop' as const,
    }
  }
}

describe('harness Agent graph context via transformContext', () => {
  it('injects recall block into finalMessages when graphContext set', async () => {
    const captured: Array<{ messages: SimpleMessage[] }> = []
    const agent = new Agent({
      complete: capturingComplete(captured),
      maxTurns: 1,
      graphContext: {
        build: async () => ({ message: { role: 'user', content: 'Graph recall: [s1#1] xyz' }, hitCount: 1, latencyMs: 1 } as GraphRecallOutput),
      },
    })
    await agent.run('hi')
    expect(captured.length).toBe(1)
    expect(captured[0]!.messages.some((m) => m.role === 'user' && String(m.content).startsWith('Graph recall'))).toBe(true)
  })

  it('skips injection when graphContext returns null', async () => {
    const captured: Array<{ messages: SimpleMessage[] }> = []
    const agent = new Agent({
      complete: capturingComplete(captured),
      maxTurns: 1,
      graphContext: { build: async (): Promise<GraphRecallOutput | null> => null },
    })
    await agent.run('hi')
    expect(captured[0]!.messages.some((m) => String(m.content).startsWith('Graph recall'))).toBe(false)
  })

  it('composes with an existing transformContext hook', async () => {
    const captured: Array<{ messages: SimpleMessage[] }> = []
    const agent = new Agent({
      complete: capturingComplete(captured),
      maxTurns: 1,
      hooks: {
        transformContext: async (ctx) => {
          // existing hook appends a marker user message
          return [...ctx.messages, { role: 'user' as const, content: 'existing-hook-marker' }]
        },
      },
      graphContext: {
        build: async () => ({ message: { role: 'system', content: 'Graph recall: block' }, hitCount: 1, latencyMs: 1 } as GraphRecallOutput),
      },
    })
    await agent.run('hi')
    const contents = captured[0]!.messages.map((m) => String(m.content))
    expect(contents).toContain('existing-hook-marker')
    expect(contents).toContain('Graph recall: block')
  })
})