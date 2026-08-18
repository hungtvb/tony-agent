import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ToolRegistry } from '../src/tools/registry.js'
import { PermissionPolicy } from '../src/permissions/policy.js'
import type { TonyTool } from '../src/types.js'

function makeTool(name: string, risk: TonyTool['risk'] = 'read'): TonyTool {
  return {
    name,
    description: `${name} description`,
    risk,
    inputSchema: z.object({ value: z.string().optional() }),
    parameters: { type: 'object', properties: { value: { type: 'string' } } },
    execute: async (input) => ({ content: JSON.stringify(input) }),
  }
}

describe('ToolRegistry', () => {
  it('validates input before executing a registered tool', async () => {
    const registry = new ToolRegistry()
    const tool = makeTool('echo')
    registry.register(tool)

    await expect(registry.execute('echo', { value: 'ok' }, {
      signal: new AbortController().signal,
      sessionId: 's1',
      metadata: {},
    })).resolves.toEqual({ content: '{"value":"ok"}' })

    await expect(registry.execute('echo', { value: 42 }, {
      signal: new AbortController().signal,
      sessionId: 's1',
      metadata: {},
    })).resolves.toMatchObject({ isError: true })
  })

  it('rejects unknown tools without invoking a handler', async () => {
    const registry = new ToolRegistry()
    await expect(registry.execute('missing', {}, {
      signal: new AbortController().signal,
      sessionId: 's1',
      metadata: {},
    })).resolves.toMatchObject({ isError: true })
  })
})

describe('PermissionPolicy', () => {
  it('allows read tools, confirms risky tools, and denies blocked tools by default', () => {
    const policy = new PermissionPolicy()
    expect(policy.check(makeTool('read', 'read'), 'example.com', 's1')).toBe('allow')
    expect(policy.check(makeTool('click', 'risky'), 'example.com', 's1')).toBe('confirm')
    expect(policy.check(makeTool('script', 'blocked'), 'example.com', 's1')).toBe('deny')
  })

  it('applies specific site and tool overrides over risk defaults', () => {
    const policy = new PermissionPolicy([
      { tool: 'click', decision: 'deny' },
      { tool: 'click', site: 'trusted.example', decision: 'allow' },
    ])
    expect(policy.check(makeTool('click', 'risky'), 'example.com', 's1')).toBe('deny')
    expect(policy.check(makeTool('click', 'risky'), 'trusted.example', 's1')).toBe('allow')
  })

  it('remembers an allow-session resolution and does not ask again', () => {
    const policy = new PermissionPolicy()
    const tool = makeTool('click', 'risky')
    expect(policy.check(tool, 'example.com', 's1')).toBe('confirm')
    policy.remember('s1', tool.name, 'example.com', 'allow-session')
    expect(policy.check(tool, 'example.com', 's1')).toBe('allow')
  })
})

describe('ToolRegistry dynamic registration', () => {
  const mk = (name: string) => ({
    name,
    description: `Tool ${name}`,
    risk: 'read' as const,
    inputSchema: { safeParse: () => ({ success: true as const, data: {} }) },
    parameters: { type: 'object' },
    execute: async () => ({ content: `executed ${name}` }),
  })

  it('unregisters a tool at runtime', () => {
    const registry = new ToolRegistry().register(mk('alpha'))
    expect(registry.has('alpha')).toBe(true)
    expect(registry.unregister('alpha')).toBe(true)
    expect(registry.has('alpha')).toBe(false)
    expect(registry.unregister('alpha')).toBe(false)
  })

  it('replaces a tool implementation under the same name', async () => {
    const registry = new ToolRegistry().register(mk('alpha'))
    const v2 = { ...mk('alpha'), execute: async () => ({ content: 'v2' }) }
    registry.replace(v2)
    expect(registry.get('alpha')).toBe(v2)
    expect(await registry.execute('alpha', {}, { signal: new AbortController().signal, sessionId: 's' })).toEqual({ content: 'v2' })
  })

  it('emits change events and unsubscribes', () => {
    const registry = new ToolRegistry()
    const seen: string[] = []
    const unsubscribe = registry.subscribe((change) => seen.push(change.type))
    registry.register(mk('a'))
    registry.replace(mk('a'))
    registry.unregister('a')
    expect(seen).toEqual(['registered', 'replaced', 'unregistered'])
    unsubscribe()
    registry.register(mk('b'))
    expect(seen).toEqual(['registered', 'replaced', 'unregistered'])
  })

  it('prevents duplicate registration and rejects bad names', () => {
    const registry = new ToolRegistry().register(mk('a'))
    expect(() => registry.register(mk('a'))).toThrow(/already registered/)
    expect(() => registry.register(mk('Bad Name'))).toThrow(/Invalid tool name/)
  })
})
