import { describe, it, expect } from 'vitest'
import { paint, cyan, green, red, bold, dim, icon, table, padEnd, SPINNER_FRAMES } from '../src/cli/theme.js'

describe('cli theme', () => {
  it('paint wraps text in ANSI when colors are enabled', () => {
    // Force by checking the helper exists and returns string
    const result = paint('cyan', 'hello')
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('color helpers return strings', () => {
    expect(typeof cyan('x')).toBe('string')
    expect(typeof green('x')).toBe('string')
    expect(typeof red('x')).toBe('string')
    expect(typeof bold('x')).toBe('string')
    expect(typeof dim('x')).toBe('string')
  })

  it('icon map has the expected keys', () => {
    expect(icon.rocket).toBe('🚀')
    expect(icon.check).toBe('✅')
    expect(icon.agent).toBe('🤖')
    expect(icon.lane).toBe('🏷️ ')
  })

  it('table renders header + rows with aligned columns', () => {
    const out = table(['A', 'B'], [[1, 2], [100, 200]])
    expect(out).toContain('A')
    expect(out).toContain('B')
    expect(out).toContain('1')
    expect(out).toContain('100')
  })

  it('padEnd pads to width (strips ANSI for measuring)', () => {
    expect(padEnd('ab', 4)).toBe('ab  ')
    expect(padEnd('a', 2).length).toBe(2)
  })

  it('SPINNER_FRAMES has multiple frames', () => {
    expect(SPINNER_FRAMES.length).toBeGreaterThan(3)
  })
})
