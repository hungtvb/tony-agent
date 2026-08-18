import { describe, it, expect } from 'vitest'
import { PatchLayer, validatePatchRows, type PatchRow } from '../../src/plugin/patch.js'

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
describe('PatchLayer schema validation', () => {
  it('rejects rows with missing plugin in strict mode', () => {
    expect(() => new PatchLayer([{ id: 'llm', plugin: '' }])).toThrow(/plugin must be a non-empty string/)
  })

  it('rejects non-plain-object config', () => {
    expect(() => new PatchLayer([{ id: 'x', plugin: 'y', config: [1, 2] as unknown as Record<string, unknown> }])).toThrow(/config must be a plain object/)
  })

  it('rejects non-boolean disabled', () => {
    expect(() => new PatchLayer([{ id: 'x', plugin: 'y', disabled: 'yes' as unknown as boolean }])).toThrow(/disabled must be a boolean/)
  })

  it('validates multiple rows and reports each row id', () => {
    const errors = validatePatchRows([
      { id: '', plugin: '' },
      { id: 'ok', plugin: 'good' },
      { id: 'bad', plugin: 'x', config: 'nope' },
    ])
    expect(errors).toHaveLength(2)
    expect(errors.map((e) => e.row)).toEqual(['', 'bad'])
  })

  it('strict=false skips validation', () => {
    expect(() => new PatchLayer([{ id: 'x', plugin: '' }], { strict: false })).not.toThrow()
  })
})
