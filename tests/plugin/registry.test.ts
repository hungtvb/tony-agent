import { describe, it, expect, vi } from 'vitest'
import { PluginRegistry, type Plugin } from '../../src/plugin/registry.js'
import type { PluginContext } from '../../src/plugin/context.js'

function makeCtx(): PluginContext {
  return {
    services: {} as never,
    events: {} as never,
    tools: {} as never,
    store: {} as never,
    llm: {} as never,
    logger: vi.fn(),
  }
}

describe('PluginRegistry', () => {
  it('mounts a plugin and calls setup with ctx', () => {
    const registry = new PluginRegistry()
    const ctx = makeCtx()
    const setup = vi.fn((c: PluginContext) => {
      expect(c).toBe(ctx)
    })
    const plugin: Plugin = { name: 'core', setup }
    registry.mount(plugin, ctx)
    expect(setup).toHaveBeenCalledTimes(1)
    expect(registry.list()).toEqual(['core'])
  })

  it('unmount calls effect.dispose (reverse order)', async () => {
    const registry = new PluginRegistry()
    const ctx = makeCtx()
    const order: string[] = []
    const a: Plugin = { name: 'a', setup: () => ({ dispose: () => { order.push('a') } }) }
    const b: Plugin = { name: 'b', setup: () => ({ dispose: () => { order.push('b') } }) }
    registry.mount(a, ctx)
    registry.mount(b, ctx)
    await registry.unmount('a')
    expect(order).toEqual(['a'])
    order.length = 0
    registry.mount(a, ctx)
    await registry.unmountAll()
    // mount order after remount: b, a → LIFO unwind: a then b
    expect(order).toEqual(['a', 'b'])
  })

  it('rejects duplicate mount and unknown unmount', async () => {
    const registry = new PluginRegistry()
    const ctx = makeCtx()
    const plugin: Plugin = { name: 'p', setup: () => undefined }
    registry.mount(plugin, ctx)
    expect(() => registry.mount(plugin, ctx)).toThrow(/already mounted/)
    await expect(registry.unmount('nope')).rejects.toThrow(/not mounted/)
  })

  it('mount with no setup is a no-op that still unmounts cleanly', async () => {
    const registry = new PluginRegistry()
    const ctx = makeCtx()
    registry.mount({ name: 'empty' }, ctx)
    expect(registry.list()).toEqual(['empty'])
    await registry.unmount('empty')
    expect(registry.list()).toEqual([])
  })
})