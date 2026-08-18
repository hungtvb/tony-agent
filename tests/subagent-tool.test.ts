import { describe, it, expect } from 'vitest'
import { SubagentRegistry, createInProcessSubagentProvider } from '../src/subagent/registry.js'
import { createSubagentTool } from '../src/subagent/tool.js'
import type { ToolContext } from '../src/types.js'
import type { SimpleMessage, SimpleResult, SimpleStreamOptions, ToolDefinition } from '../src/llm/model.js'

const ctx: ToolContext = { signal: new AbortController().signal, sessionId: 'parent', metadata: {} }

/** Scripted completer: answers the child in one shot (no tool calls). */
function scriptedComplete(text: string) {
  return async (_req: { messages: SimpleMessage[]; tools?: ToolDefinition[] }, _opts: SimpleStreamOptions): Promise<SimpleResult> => {
    return { text, toolCalls: [], stopReason: 'stop' }
  }
}

describe('delegate_subagent tool', () => {
  it('delegates to the in-process provider and returns child text', async () => {
    const registry = new SubagentRegistry()
    registry.register(createInProcessSubagentProvider({ complete: scriptedComplete('child answer 42') }))
    const tool = createSubagentTool(registry)
    const result = await tool.execute({ prompt: 'Do the math' }, ctx)
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('child answer 42')
    expect(result.content).toMatch(/turns=1/)
  })

  it('returns isError when the provider is unknown (fail-closed)', async () => {
    const registry = new SubagentRegistry()
    const tool = createSubagentTool(registry)
    const result = await tool.execute({ prompt: 'hi', provider: 'missing' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/Unknown subagent provider/)
  })

  it('passes toolFilter to the child', async () => {
    const registry = new SubagentRegistry()
    const provider = createInProcessSubagentProvider({
      complete: scriptedComplete('filtered ok'),
      tools: new Map([
        ['allowed_tool', { name: 'allowed_tool', description: '', risk: 'read' as const, inputSchema: undefined as never, parameters: {}, execute: async () => ({ content: 'ok' }) }],
        ['blocked_tool', { name: 'blocked_tool', description: '', risk: 'read' as const, inputSchema: undefined as never, parameters: {}, execute: async () => ({ content: 'blocked' }) }],
      ]),
    })
    registry.register(provider)
    const tool = createSubagentTool(registry)
    const result = await tool.execute({ prompt: 'use only allowed', toolFilter: ['allowed_tool'] }, ctx)
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('filtered ok')
  })

  it('supports a default provider override', async () => {
    const registry = new SubagentRegistry()
    registry.register({ name: 'custom', start: async () => ({ childId: 'c1', text: 'from custom', toolCalls: 0, turns: 1, aborted: false }) })
    const tool = createSubagentTool(registry, { provider: 'custom' })
    const result = await tool.execute({ prompt: 'x' }, ctx)
    expect(result.content).toContain('from custom')
  })
})
