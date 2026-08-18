import { describe, it, expect } from 'vitest'
import { PROFILES, resolveProfile, applyProfile, dumpProfile, HEADLESS_PROFILE, WEB_PROFILE } from '../src/config/profiles.js'
import type { PatchRow } from '../src/plugin/patch.js'

describe('config profiles', () => {
  it('exposes headless and web profiles', () => {
    expect(Object.keys(PROFILES).sort()).toEqual(['headless', 'web'])
    expect(HEADLESS_PROFILE.name).toBe('headless')
    expect(WEB_PROFILE.name).toBe('web')
  })

  it('resolveProfile throws on unknown names (fail-closed)', () => {
    expect(() => resolveProfile('nope')).toThrow(/Unknown profile/)
  })

  it('applyProfile merges base + profile rows, later wins', () => {
    const rows = applyProfile(HEADLESS_PROFILE)
    expect(rows.size).toBe(2)
    expect(rows.get('llm')!.config).toEqual({ stream: false })
    expect(rows.get('session')!.config).toEqual({ lane: 'default' })
  })

  it('web profile adds web-ui row', () => {
    const rows = applyProfile(WEB_PROFILE)
    expect(rows.get('web')!.plugin).toBe('web-ui')
    expect(rows.get('web')!.config).toEqual({ port: 4173 })
    expect(rows.get('llm')!.config).toEqual({ stream: true })
  })

  it('overrides apply last (highest precedence) and disabled removes a row', () => {
    const overrides: PatchRow[] = [
      { id: 'llm', plugin: 'llm', config: { stream: true } },
      { id: 'session', plugin: 'session', disabled: true },
    ]
    const rows = applyProfile(HEADLESS_PROFILE, { overrides })
    expect(rows.get('llm')!.config).toEqual({ stream: true })
    expect(rows.has('session')).toBe(false)
  })

  it('per-id config merges over the resolved row', () => {
    const rows = applyProfile(HEADLESS_PROFILE, { config: { llm: { stream: true, maxRetries: 2 } } })
    expect(rows.get('llm')!.config).toEqual({ stream: true, maxRetries: 2 })
  })

  it('dumpProfile renders deterministic rows by id', () => {
    const dumped = dumpProfile(HEADLESS_PROFILE)
    expect(dumped.map((row) => row.id)).toEqual(['llm', 'session'])
  })
})
