import { describe, expect, it } from 'vitest'
import { createWorkerThreadRuntime } from '../src/code-runtime/worker-thread.js'

/**
 * Regression tests for the sandbox escape (t_b63de554). The worker runtime
 * must NOT allow the snippet to reach host filesystem / process / require.
 * Boundary = empty vm context (intrinsics only); regex policy is only
 * defense-in-depth, so these tests assert the runtime itself fails closed.
 */
describe('code-runtime sandbox escapes (FIX-CRITICAL t_b63de554)', () => {
  const runtime = createWorkerThreadRuntime()

  it('(0, require)("node:fs") cannot read host files', async () => {
    const result = await runtime.run({
      language: 'typescript',
      code: `const fs = (0, require)('node:fs'); console.log(fs.readFileSync('/etc/hostname', 'utf8'))`,
      timeoutMs: 10_000,
    })
    expect(result.ok).toBe(false)
  })

  it('require?.("node:os") cannot reach host modules', async () => {
    const result = await runtime.run({
      language: 'typescript',
      code: `const os = require?.('node:os'); console.log(os ? os.hostname() : 'no-require')`,
      timeoutMs: 10_000,
    })
    expect(result.ok).toBe(false)
  })

  it('constructor-based process escape cannot read env', async () => {
    const result = await runtime.run({
      language: 'typescript',
      code: `const proc = ({}).constructor.constructor('return process')(); console.log(proc.env.HOME)`,
      timeoutMs: 10_000,
    })
    expect(result.ok).toBe(false)
  })

  it('globalThis.require is not exposed', async () => {
    const result = await runtime.run({
      language: 'typescript',
      code: `console.log(typeof globalThis.require)`,
      timeoutMs: 10_000,
    })
    expect(result.ok).toBe(true)
    expect(result.stdout).toContain('undefined')
  })

  it('process is not exposed to the sandbox', async () => {
    const result = await runtime.run({
      language: 'typescript',
      code: `console.log(typeof process)`,
      timeoutMs: 10_000,
    })
    expect(result.ok).toBe(true)
    expect(result.stdout).toContain('undefined')
  })
})
