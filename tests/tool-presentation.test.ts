import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/tools/registry.js'
import type { ToolPresentation, TonyTool } from '../src/types.js'

function makeTool(name: string, presentation?: ToolPresentation): TonyTool<any> {
  return {
    name,
    description: `tool ${name}`,
    risk: 'read',
    presentation,
    inputSchema: undefined as never,
    parameters: { type: 'object' },
    execute: async () => ({ content: 'ok' }),
  }
}

describe('ToolRegistry presentation modes', () => {
  it('definitions() filters by presentation mode (native/code/both)', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('native_tool', 'native'))
    registry.register(makeTool('code_tool', 'code'))
    registry.register(makeTool('both_tool', 'both'))
    registry.register(makeTool('default_tool')) // omitted → both

    const names = (presentation: ToolPresentation) =>
      registry.definitions({ presentation }).map((definition) => definition.function.name)

    expect(names('native')).toEqual(['native_tool', 'both_tool', 'default_tool'])
    expect(names('code')).toEqual(['code_tool', 'both_tool', 'default_tool'])
    // no filter = everything
    expect(registry.definitions().map((definition) => definition.function.name)).toHaveLength(4)
  })

  it('omitted presentation defaults to both', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('plain_tool'))
    expect(registry.definitions({ presentation: 'native' }).map((d) => d.function.name)).toEqual(['plain_tool'])
    expect(registry.definitions({ presentation: 'code' }).map((d) => d.function.name)).toEqual(['plain_tool'])
    expect(registry.definitions({ presentation: 'native' })).toHaveLength(1)
  })
})