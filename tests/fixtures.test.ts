import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadFixture, recordFixture, fixturePath } from '../src/llm/fixtures.js'

describe('LLM snapshot fixtures', () => {
  it('recordFixture writes JSON snapshot to fixtures dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fixtures-'))
    const name = 'roundtrip-test'
    const steps = [{ text: 'hello', stopReason: 'stop' as const }]
    const file = recordFixture(name, steps, dir)
    expect(file).toBe(join(dir, `${name}.json`))
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(parsed).toEqual({ steps })
  })

  it('loadFixture reads and validates a snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fixtures-'))
    const name = 'load-test'
    const steps = [
      { text: 'a', toolCalls: [{ id: 'c1', name: 'echo_tool', arguments: { value: 'x' } }], stopReason: 'tool_calls' as const },
      { text: 'done', stopReason: 'stop' as const },
    ]
    recordFixture(name, steps, dir)
    const loaded = loadFixture(name, dir)
    expect(loaded).toEqual(steps)
  })

  it('loadFixture throws on missing fixture (fail fast offline)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fixtures-'))
    expect(() => loadFixture('does-not-exist', dir)).toThrow(/fixture.*does-not-exist/i)
  })

  it('loadFixture validates shape — rejects malformed snapshots', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fixtures-'))
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ steps: [{ noText: true }] }))
    expect(() => loadFixture('bad', dir)).toThrow()
  })

  it('fixturePath resolves under the fixtures directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fixtures-'))
    expect(fixturePath('x', dir)).toBe(join(dir, 'x.json'))
    rmSync(dir, { recursive: true, force: true })
  })
})
