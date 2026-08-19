import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LLM snapshot fixtures — record ScriptedLLM response steps to JSON files and
 * replay them deterministically. Keeps agent-loop tests offline and immune to
 * provider drift: `recordFixture` writes `tests/fixtures/<name>.json`,
 * `loadFixture` reads + validates the shape back.
 */

export interface FixtureStep {
  text?: string
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  stopReason?: string
}

/** Resolve the JSON path for a fixture name (safe: fixed dir, `.json` suffix). */
export function fixturePath(name: string, dir = 'tests/fixtures'): string {
  if (!/^[a-z0-9-]+$/i.test(name)) throw new Error(`Invalid fixture name: ${name}`)
  return join(dir, `${name}.json`)
}

/** Write a fixture snapshot; returns the written path. */
export function recordFixture(name: string, steps: FixtureStep[], dir = 'tests/fixtures'): string {
  mkdirSync(dir, { recursive: true })
  const file = fixturePath(name, dir)
  writeFileSync(file, JSON.stringify({ steps }, null, 2) + '\n', 'utf8')
  return file
}

/** Load + validate a fixture snapshot. Throws when missing or malformed. */
export function loadFixture(name: string, dir = 'tests/fixtures'): FixtureStep[] {
  const file = fixturePath(name, dir)
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`Fixture not found: ${name} (${file}) — run recordFixture or create the snapshot`)
  }
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { steps?: unknown }).steps)) {
    throw new Error(`Malformed fixture ${name}: expected { steps: [...] }`)
  }
  const steps = (parsed as { steps: unknown[] }).steps
  for (const step of steps) {
    if (!step || typeof step !== 'object') throw new Error(`Malformed fixture ${name}: non-object step`)
    const candidate = step as FixtureStep
    if (typeof candidate.text !== 'string' && !Array.isArray(candidate.toolCalls)) {
      throw new Error(`Malformed fixture ${name}: step needs text and/or toolCalls`)
    }
  }
  return steps as FixtureStep[]
}