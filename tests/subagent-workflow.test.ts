import { describe, expect, it } from 'vitest'
import { SubagentRegistry, createInProcessSubagentProvider } from '../src/subagent/registry.js'
import { WorkflowEngine, WorkflowError, createSubagentWorkflow } from '../src/workflow/engine.js'
import type { SimpleMessage, SimpleResult, ToolDefinition } from '../src/llm/model.js'

function simpleComplete(text: string) {
  return async (_req: { messages: SimpleMessage[]; tools?: ToolDefinition[] }): Promise<SimpleResult> => {
    return { text, toolCalls: [], stopReason: 'stop' }
  }
}

describe('SubagentRegistry', () => {
  it('rejects duplicate provider names', () => {
    const registry = new SubagentRegistry()
    registry.register({ name: 'dup', start: async () => ({ childId: 'x', text: '', toolCalls: 0, turns: 1, aborted: false }) })
    expect(() => registry.register({ name: 'dup', start: async () => ({ childId: 'x', text: '', toolCalls: 0, turns: 1, aborted: false }) })).toThrow(/already registered/)
  })

  it('starts a delegation through a registered provider', async () => {
    const registry = new SubagentRegistry()
    registry.register({ name: 'mock', start: async (req) => ({ childId: 'c', text: `done: ${req.prompt}`, toolCalls: 0, turns: 1, aborted: false }) })
    const result = await registry.start('mock', { prompt: 'hi' })
    expect(result.text).toBe('done: hi')
  })

  it('rejects unknown providers with available names', () => {
    const registry = new SubagentRegistry()
    registry.register({ name: 'ok', start: async () => ({ childId: 'c', text: '', toolCalls: 0, turns: 1, aborted: false }) })
    expect(() => registry.start('missing', { prompt: 'x' })).toThrow(/Unknown subagent provider: missing/)
  })
})

describe('in-process subagent provider', () => {
  it('runs a child agent against the shared completer with filtered tools', async () => {
    const registry = new SubagentRegistry()
    registry.register(createInProcessSubagentProvider({
      complete: simpleComplete('child answer'),
    }))
    const result = await registry.start('in-process', { prompt: 'solve', maxToolCalls: 5 })
    expect(result.childId).toMatch(/^sub-/)
    expect(result.text).toBe('child answer')
    expect(result.turns).toBeGreaterThanOrEqual(1)
    expect(result.aborted).toBe(false)
  })
})

describe('WorkflowEngine', () => {
  it('executes a script that fans out a subagent', async () => {
    const { engine } = createSubagentWorkflow({ complete: simpleComplete('sub ok') })
    const run = engine.start(async (ctx) => {
      const a = await ctx.agent({ prompt: 'task 1' })
      const b = await ctx.agent({ prompt: 'task 2' })
      return { a: a.text, b: b.text }
    })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.agentsStarted).toBe(2)
    expect((result.value as { a: string }).a).toBe('sub ok')
  })

  it('enforces the agent cap', async () => {
    const { engine } = createSubagentWorkflow({ complete: simpleComplete('x'), maxTotalAgents: 1 })
    const run = engine.start(async (ctx) => {
      await ctx.agent({ prompt: '1' })
      await ctx.agent({ prompt: '2' })
      return 'never'
    })
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('AGENT_CAP')
  })

  it('resolves cancelled runs with stopReason cancelled', async () => {
    const { engine } = createSubagentWorkflow({ complete: simpleComplete('x') })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const run = engine.start(async (ctx) => {
      await gate
      await ctx.agent({ prompt: 'fast' })
      return 'late'
    })
    run.cancel('caller stopped')
    release()
    const result = await run.result
    expect(result.stopReason).toBe('cancelled')
  })

  it('never rejects: script throw resolves with stopReason error', async () => {
    const { engine } = createSubagentWorkflow({ complete: simpleComplete('x') })
    const run = engine.start(async () => {
      throw new Error('script bug')
    })
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.error).toContain('script bug')
  })

  it('rejects an engine with no provider mounted', () => {
    const registry = new SubagentRegistry()
    expect(() => new WorkflowEngine({ registry, provider: 'in-process' })).toThrow(WorkflowError)
  })
})