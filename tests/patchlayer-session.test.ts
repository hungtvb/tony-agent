import { describe, expect, it } from 'vitest'
import { PatchLayer, type PatchRow } from '../src/plugin/patch.js'

/**
 * Session-scoped patch overrides (ticket t_352d69ec):
 * applyForSession(sessionId, row) overrides a row for ONE session only —
 * global rows and other sessions' views are untouched; clearSession removes them.
 */

const base: PatchRow[] = [
  { id: 'model', plugin: 'llm', config: { model: 'tony-combo' } },
  { id: 'stt', plugin: 'asr', config: { lang: 'vi' } },
]

describe('PatchLayer session-scoped override', () => {
  it('applyForSession overrides a row only for that session', () => {
    const layer = new PatchLayer([])
    layer.applyForSession('sessA', { id: 'model', plugin: 'llm', config: { model: 'deepseek-v4' } })
    const globalView = layer.apply(base)
    const sessA = layer.apply(base, 'sessA')
    const sessB = layer.apply(base, 'sessB')
    expect(globalView.get('model')?.config).toEqual({ model: 'tony-combo' })
    expect(sessA.get('model')?.config).toEqual({ model: 'deepseek-v4' })
    expect(sessB.get('model')?.config).toEqual({ model: 'tony-combo' })
  })

  it('later overlays win within a session; other sessions unaffected', () => {
    const layer = new PatchLayer([])
    layer.applyForSession('sessA', { id: 'model', plugin: 'llm', config: { model: 'a' } })
    layer.applyForSession('sessA', { id: 'model', plugin: 'llm', config: { model: 'b' } })
    expect(layer.apply(base, 'sessA').get('model')?.config).toEqual({ model: 'b' })
    expect(layer.apply(base).get('model')?.config).toEqual({ model: 'tony-combo' })
  })

  it('disabled override removes the row within the session only', () => {
    const layer = new PatchLayer([])
    layer.applyForSession('sessA', { id: 'model', plugin: 'llm', config: { model: 'x' } })
    layer.applyForSession('sessA', { id: 'model', plugin: 'llm', disabled: true })
    expect(layer.apply(base, 'sessA').has('model')).toBe(false)
    expect(layer.apply(base).has('model')).toBe(true)
  })

  it('clearSession drops all overrides for that session', () => {
    const layer = new PatchLayer([])
    layer.applyForSession('sessA', { id: 'model', plugin: 'llm', config: { model: 'x' } })
    expect(layer.sessionOverrideCount).toBe(1)
    layer.clearSession('sessA')
    expect(layer.sessionOverrideCount).toBe(0)
    expect(layer.apply(base, 'sessA').get('model')?.config).toEqual({ model: 'tony-combo' })
  })

  it('strict mode rejects invalid override rows', () => {
    const layer = new PatchLayer([], { strict: true })
    expect(() => layer.applyForSession('sessA', { id: '', plugin: 'llm' })).toThrow(/non-empty/i)
  })
})