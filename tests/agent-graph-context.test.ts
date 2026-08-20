import { describe, it, expect } from 'vitest'
import { TonyAgent } from '../src/agent.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { PermissionPolicy } from '../src/permissions/policy.js'
import type { LLMCompleter, LLMRequest, LLMResult, LLMMessage } from '../src/types.js'
import type { GraphRecallOutput } from '../src/query/graph-context.js'

function stubLlm(seen: LLMMessage[][]): LLMCompleter {
  return {
    async complete(request: LLMRequest): Promise<LLMResult> {
      seen.push(request.messages)
      return { text: 'ok', toolCalls: [] }
    },
  }
}

describe('TonyAgent graph context injection', () => {
  it('injects graph recall into the first turn when builder returns a block', async () => {
    const seen: LLMMessage[][] = []
    const agent = new TonyAgent({
      llm: stubLlm(seen),
      registry: new ToolRegistry(),
      permissions: new PermissionPolicy(),
      graphContext: {
        build: async () => ({ message: { role: 'system', content: 'Graph recall: [s1#1] xyz' }, hitCount: 1, latencyMs: 1 }),
      },
    })
    await agent.run('hello')
    expect(seen[0]!.some((m) => m.role === 'system' && m.content.startsWith('Graph recall'))).toBe(true)
  })

  it('skips injection when builder returns null', async () => {
    const seen: LLMMessage[][] = []
    const agent = new TonyAgent({
      llm: stubLlm(seen),
      registry: new ToolRegistry(),
      permissions: new PermissionPolicy(),
      graphContext: { build: async (): Promise<GraphRecallOutput | null> => null },
    })
    await agent.run('hello')
    expect(seen[0]!.some((m) => m.role === 'system' && m.content.startsWith('Graph recall'))).toBe(false)
  })

  it('does not persist the recall block to history', async () => {
    const seen: LLMMessage[][] = []
    const agent = new TonyAgent({
      llm: stubLlm(seen),
      registry: new ToolRegistry(),
      permissions: new PermissionPolicy(),
      graphContext: {
        build: async () => ({ message: { role: 'system', content: 'Graph recall: [s1#1] secret' }, hitCount: 1, latencyMs: 1 }),
      },
    })
    await agent.run('hello')
    expect(seen[0]!.some((m) => m.role === 'system' && m.content.startsWith('Graph recall'))).toBe(true)
    expect(agent.history.some((m) => m.content.startsWith('Graph recall'))).toBe(false)
    // also not persisted across turns: second run gets a fresh block but history stays clean
    await agent.run('again')
    expect(agent.history.some((m) => m.content.startsWith('Graph recall'))).toBe(false)
  })
})