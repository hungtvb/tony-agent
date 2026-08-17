import { describe, it, expect } from 'vitest'
import { PatchLayer, type PatchRow } from '../../src/plugin/patch.js'

describe('PatchLayer', () => {
  it('applies a patch row overriding config by row id', () => {
    const base: PatchRow[] = [
      { id: 'llm', plugin: 'llm', config: { model: 'gpt-4o-mini' } },
      { id: 'tools', plugin: 'tools' },
    ]
    const patch = new PatchLayer([{ id: 'llm', plugin: 'llm', config: { model: 'deepseek-v3' } }])
    const applied = patch.apply(base)
    expect(applied.get('llm')?.config).toEqual({ model: 'deepseek-v3' })
    expect(applied.get('tools')?.plugin).toBe('tools')
  })

  it('disabled row is removed', () => {
    const base: PatchRow[] = [
      { id: 'llm', plugin: 'llm' },
      { id: 'subagent', plugin: 'subagent' },
    ]
    const patch = new PatchLayer([{ id: 'subagent', plugin: 'subagent', disabled: true }])
    const applied = patch.apply(base)
    expect(applied.has('subagent')).toBe(false)
    expect(applied.has('llm')).toBe(true)
  })

  it('patch can insert a new row', () => {
    const base: PatchRow[] = [{ id: 'llm', plugin: 'llm' }]
    const patch = new PatchLayer([{ id: 'shell', plugin: 'shell', config: { timeoutMs: 30_000 } }])
    const applied = patch.apply(base)
    expect(applied.get('shell')?.plugin).toBe('shell')
    expect(applied.size).toBe(2)
  })

  it('dump returns applied rows in stable order', () => {
    const base: PatchRow[] = [
      { id: 'llm', plugin: 'llm' },
      { id: 'tools', plugin: 'tools' },
    ]
    const patch = new PatchLayer([{ id: 'tools', plugin: 'tools', config: { extra: true } }])
    const applied = patch.apply(base)
    const dumped = patch.dump(applied)
    expect(dumped.map((row) => row.id)).toEqual(['llm', 'tools'])
    expect(dumped[1]?.config).toEqual({ extra: true })
  })
})