import type { PatchRow } from '../plugin/patch.js'
import { PatchLayer } from '../plugin/patch.js'

/**
 * Profile system — named config bundles (dsh bundle concept). Each profile is
 * a stack of patch layers: base rows < profile rows < override rows. Later
 * layers win; `disabled` removes a row from earlier layers.
 */

export interface Profile {
  name: string
  description: string
  /** Base entry list (defaults). */
  base: PatchRow[]
  /** Profile-specific rows applied over the base. */
  rows: PatchRow[]
}

export const HEADLESS_PROFILE: Profile = {
  name: 'headless',
  description: 'Agent CLI/daemon without a web UI — default profile.',
  base: [
    { id: 'llm', plugin: 'llm' },
    { id: 'session', plugin: 'session' },
  ],
  rows: [
    { id: 'llm', plugin: 'llm', config: { stream: false } },
    { id: 'session', plugin: 'session', config: { lane: 'default' } },
  ],
}

export const WEB_PROFILE: Profile = {
  name: 'web',
  description: 'Agent with a web dashboard attached (needs a browser host).',
  base: [
    { id: 'llm', plugin: 'llm' },
    { id: 'session', plugin: 'session' },
    { id: 'web', plugin: 'web-ui' },
  ],
  rows: [
    { id: 'llm', plugin: 'llm', config: { stream: true } },
    { id: 'web', plugin: 'web-ui', config: { port: 4173 } },
  ],
}

export const PROFILES: Record<string, Profile> = {
  headless: HEADLESS_PROFILE,
  web: WEB_PROFILE,
}

/** Resolve a named profile; throws on unknown names (fail-closed). */
export function resolveProfile(name: string): Profile {
  const profile = PROFILES[name]
  if (!profile) throw new Error(`Unknown profile: ${name} (available: ${Object.keys(PROFILES).join(', ')})`)
  return profile
}

export interface ProfileOptions {
  /** Override rows applied last — highest precedence. */
  overrides?: PatchRow[]
  /** Per row id config merged over the resolved row. */
  config?: Record<string, unknown>
}

/** Apply overrides + per-id config over the profile's layers. */
export function applyProfile(profile: Profile, options: ProfileOptions = {}): Map<string, PatchRow> {
  const merged = new PatchLayer(profile.base).apply([])
  const rowsLayer = new PatchLayer(profile.rows).apply(merged)
  const overrideLayer = new PatchLayer(options.overrides ?? []).apply(rowsLayer)
  if (options.config) {
    for (const [id, config] of Object.entries(options.config)) {
      const existing = overrideLayer.get(id)
      if (!existing) continue
      overrideLayer.set(id, { ...existing, config: { ...(existing.config as Record<string, unknown> | undefined), ...(config as Record<string, unknown>) } })
    }
  }
  return overrideLayer
}

/** Render a profile's applied rows (deterministic by id, for --dump-config). */
export function dumpProfile(profile: Profile, options: ProfileOptions = {}): PatchRow[] {
  return new PatchLayer([]).dump(applyProfile(profile, options))
}