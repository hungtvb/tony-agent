import { describe, it, expect } from 'vitest'
import { validateServiceName, validateToolName } from '../src/seams/registry.js'
import { createFsConsumer } from '../src/fs/consumer.js'
import { fsDefinition } from '../src/fs/definitions.js'
import { createShellConsumer } from '../src/shell/consumer.js'
import { createSubagentConsumer } from '../src/subagent/plugin.js'

describe('service registry naming convention', () => {
  it('accepts kebab-case service ids', () => {
    expect(validateServiceName('fs')).toBe(true)
    expect(validateServiceName('shell')).toBe(true)
    expect(validateServiceName('my-service')).toBe(true)
    expect(validateServiceName('subagent')).toBe(true)
  })

  it('rejects invalid service ids', () => {
    expect(validateServiceName('MyService')).toBe(false)
    expect(validateServiceName('my_service')).toBe(false)
    expect(validateServiceName('myService')).toBe(false)
    expect(validateServiceName('')).toBe(false)
    expect(validateServiceName('my service')).toBe(false)
    expect(validateServiceName('my.service')).toBe(false)
  })

  it('accepts service:action tool names', () => {
    expect(validateToolName('fs:read')).toBe(true)
    expect(validateToolName('shell:run')).toBe(true)
    expect(validateToolName('subagent:delegate')).toBe(true)
    expect(validateToolName('my-service:do-thing')).toBe(true)
  })

  it('rejects invalid tool names', () => {
    expect(validateToolName('fs_read')).toBe(false)
    expect(validateToolName('shell_run')).toBe(false)
    expect(validateToolName('delegate_subagent')).toBe(false)
    expect(validateToolName('fs:Read')).toBe(false)
    expect(validateToolName('Fs:read')).toBe(false)
    expect(validateToolName('fs:')).toBe(false)
    expect(validateToolName(':read')).toBe(false)
    expect(validateToolName('')).toBe(false)
  })

  it('consumer tools use service:action naming', () => {
    const tools = createFsConsumer().uses({} as never)
    const names = (Array.isArray(tools) ? tools : [tools]).map((t) => t.name)
    expect(names).toEqual(['fs:read', 'fs:write', 'fs:list'])

    const shell = createShellConsumer().uses({} as never)
    const shellNames = (Array.isArray(shell) ? shell : [shell]).map((t) => t.name)
    expect(shellNames).toEqual(['shell:run'])

    const sub = createSubagentConsumer().uses({} as never)
    const subNames = (Array.isArray(sub) ? sub : [sub]).map((t) => t.name)
    expect(subNames).toEqual(['subagent:delegate'])
  })

  it('service ids are kebab-case per convention', () => {
    expect(fsDefinition.id).toMatch(/^[a-z][a-z0-9-]*$/)
    expect(fsDefinition.id).toBe('fs')
  })
})
