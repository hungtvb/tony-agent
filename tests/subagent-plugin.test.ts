import { describe, expect, it, vi } from 'vitest'
import { PluginRegistry } from '../src/plugin/registry.js'
import { ServiceRegistry } from '../src/seams/registry.js'
import { ToolScope } from '../src/tools/scope.js'
import { createSubagentPlugin, SUBAGENT_SERVICE_ID } from '../src/subagent/plugin.js'
import type { PluginContext } from '../src/plugin/context.js'
import type { SubagentProvider } from '../src/subagent/registry.js'

function fakeContext(): PluginContext {
  const services = new ServiceRegistry()
  const tools = new ToolScope()
  return {
    services,
    tools,
    events: { on: () => () => {}, emit: () => {}, useWaterfall: () => () => {}, runWaterfall: async () => ({ decision: 'allow' as const }), dispose: async () => {} },
    store: {} as PluginContext['store'],
    llm: {} as PluginContext['llm'],
    logger: () => {},
  } as unknown as PluginContext
}

describe('subagent plugin', () => {
  it('mounts the subagent service provider behind the seam', () => {
    const ctx = fakeContext()
    const registry = new PluginRegistry()
    const complete = vi.fn(async () => ({ text: 'child done', toolCalls: [], usage: undefined, stopReason: 'stop' as const }))
    registry.mount(createSubagentPlugin({ complete }), ctx)
    expect(registry.isMounted('subagent')).toBe(true)
    expect(ctx.services.has(SUBAGENT_SERVICE_ID)).toBe(true)
    expect(ctx.services.activeProviderName(SUBAGENT_SERVICE_ID)).toBe('in-process')
  })

  it('exposes delegate_subagent tool through the scope', () => {
    const ctx = fakeContext()
    const registry = new PluginRegistry()
    const complete = vi.fn(async () => ({ text: 'ok', toolCalls: [], usage: undefined, stopReason: 'stop' as const }))
    registry.mount(createSubagentPlugin({ complete }), ctx)
    expect(ctx.tools.has('delegate_subagent')).toBe(true)
  })

  it('plugin tool delegates to an in-process provider and returns formatted result', async () => {
    const ctx = fakeContext()
    const registry = new PluginRegistry()
    const complete = vi.fn(async () => ({ text: 'findings: 42', toolCalls: [], usage: undefined, stopReason: 'stop' as const }))
    registry.mount(createSubagentPlugin({ complete }), ctx)
    const resolved = ctx.tools.resolve('delegate_subagent', () => undefined)
    const tool = (Array.isArray(resolved) ? resolved[0] : resolved) as unknown as { execute: (input: { prompt: string }, ctx: { signal: AbortSignal; sessionId: string }) => Promise<{ content: string; isError?: boolean }> }
    const result = await tool.execute({ prompt: 'analyze' }, { signal: new AbortController().signal, sessionId: 's' })
    expect(result.content).toContain('findings: 42')
    expect(complete).toHaveBeenCalled()
  })

  it('unmount disposes the provider and hides the tool', async () => {
    const ctx = fakeContext()
    const registry = new PluginRegistry()
    registry.mount(createSubagentPlugin({ complete: async () => ({ text: 'x', toolCalls: [], usage: undefined, stopReason: 'stop' as const }) }), ctx)
    await registry.unmount('subagent')
    expect(registry.isMounted('subagent')).toBe(false)
    expect(ctx.services.has(SUBAGENT_SERVICE_ID)).toBe(false)
    expect(ctx.tools.has('delegate_subagent')).toBe(false)
  })

  it('rejects delegation when no provider is mounted (fail closed)', async () => {
    const ctx = fakeContext()
    const consumerTool = (await import('../src/subagent/plugin.js')).createSubagentConsumer().uses({
      name: 'missing',
      start: async () => { throw new Error('no provider') },
    } as SubagentProvider) as unknown as { execute: (input: { prompt: string }, ctx: { signal: AbortSignal; sessionId: string }) => Promise<{ content: string; isError?: boolean }> }
    const result = await consumerTool.execute({ prompt: 'hi' }, { signal: new AbortController().signal, sessionId: 's' })
    expect(result.isError).toBe(true)
  })
})