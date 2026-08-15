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
