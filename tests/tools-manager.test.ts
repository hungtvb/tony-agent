import { describe, expect, it } from 'vitest'
import { ToolsManager } from '../src/tools/manager.js'
import { createCodingTools } from '../src/tools/coding/index.js'

function sampleTools(): Map<string, { name: string }> {
  const tools = createCodingTools('/tmp/tony-agent-work')
  return new Map(tools.map((tool) => [tool.name, tool]))
}

describe('ToolsManager', () => {
  it('lists all builtin tools by default', () => {
    const manager = new ToolsManager(sampleTools())
    const names = manager.list().map((tool) => tool.name)
    expect(names).toContain('write')
    expect(names).toContain('read')
    expect(names).toContain('ls')
  })

  it('excludes tools via exclude list', () => {
    const manager = new ToolsManager(sampleTools(), { exclude: ['write'] })
    const names = manager.list().map((tool) => tool.name)
    expect(names).not.toContain('write')
    expect(names).toContain('read')
  })

  it('enables only the allowlist when provided', () => {
    const manager = new ToolsManager(sampleTools(), { allowlist: ['read', 'ls'] })
    const names = manager.list().map((tool) => tool.name)
    expect(names).toEqual(['read', 'ls'])
  })

  it('preserves extension tools when builtins are excluded', () => {
    const extensionTool = { name: 'custom_do', description: 'custom', risk: 'read' as const, inputSchema: undefined as never, parameters: { type: 'object' }, execute: async () => ({ content: 'done' }) }
    const tools = sampleTools()
    tools.set('custom_do', extensionTool)
    const manager = new ToolsManager(tools, { exclude: ['write'], keepExtensions: true })
    const names = manager.list().map((tool) => tool.name)
    expect(names).toContain('custom_do')
  })

  it('resolves a single tool by name', () => {
    const manager = new ToolsManager(sampleTools())
    expect(manager.get('read')).toBeDefined()
    expect(manager.get('nope')).toBeUndefined()
  })
})