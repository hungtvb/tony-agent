import { describe, expect, it } from 'vitest'
import { createWorkerThreadRuntime } from '../src/code-runtime/worker-thread.js'
import { createRunCodeTool } from '../src/code-runtime/tool.js'
import { validateCodePolicy } from '../src/code-runtime/runtime.js'

describe('worker-thread code runtime', () => {
  it('executes a simple script and captures stdout', async () => {
    const runtime = createWorkerThreadRuntime()
    const result = await runtime.run({ language: 'typescript', code: "console.log('hello from vm')" })
    expect(result.ok).toBe(true)
    expect(result.stdout).toContain('hello from vm')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('reports syntax/runtime errors with a message', async () => {
    const runtime = createWorkerThreadRuntime()
    const result = await runtime.run({ language: 'typescript', code: 'throw new Error("boom")' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('boom')
  })

  it('isolates the sandbox (no process.cwd in sandbox env)', async () => {
    const runtime = createWorkerThreadRuntime()
    const result = await runtime.run({ language: 'typescript', code: 'process.cwd()' })
    // process is provided but minimal — either it throws or it is undefined-ish
    expect(result.ok).toBe(false)
  })

  it('reuses the worker across runs', async () => {
    const runtime = createWorkerThreadRuntime()
    const first = await runtime.run({ language: 'typescript', code: '1 + 1' })
    expect(first.ok).toBe(true)
    const second = await runtime.run({ language: 'typescript', code: '2 + 2' })
    expect(second.ok).toBe(true)
  })
})

describe('run_code tool', () => {
  it('returns structured content on success', async () => {
    const runtime = createWorkerThreadRuntime()
    const tool = createRunCodeTool(runtime)
    const result = await tool.execute({ code: "console.log('hi')" }, { signal: new AbortController().signal, sessionId: 's' })
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('run_code ok')
    expect(result.content).toContain('hi')
  })

  it('returns an error result on failure', async () => {
    const runtime = createWorkerThreadRuntime()
    const tool = createRunCodeTool(runtime)
    const result = await tool.execute({ code: 'syntax error here(' }, { signal: new AbortController().signal, sessionId: 's' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('run_code failed')
  })

  it('has the reserved transport schema', () => {
    const runtime = createWorkerThreadRuntime()
    const tool = createRunCodeTool(runtime)
    expect(tool.name).toBe('run_code')
    expect(tool.risk).toBe('risky')
    expect(tool.parameters.required).toContain('code')
  })
})
describe('sandbox policy', () => {
  it('validateCodePolicy blocks require/eval/child_process by default', () => {
    const requireIssues = validateCodePolicy('const x = require("fs")')
    expect(requireIssues.some((issue) => issue.startsWith('require is disabled'))).toBe(true)
    expect(validateCodePolicy('eval("1+1")')).toHaveLength(1)
    expect(validateCodePolicy('const { exec } = require("child_process")').length).toBeGreaterThanOrEqual(2)
    expect(validateCodePolicy('console.log(1+1)')).toEqual([])
  })

  it('allowRequire relaxes the require rule', () => {
    expect(validateCodePolicy('require("fs")', { allowRequire: true })).toEqual([])
  })

  it('extra deny patterns are honored', () => {
    expect(validateCodePolicy('process.env.SECRET', { denyPatterns: [/process\.env/] })).toHaveLength(1)
  })

  it('worker runtime rejects policy violations without executing', async () => {
    const runtime = createWorkerThreadRuntime()
    const result = await runtime.run({ language: 'typescript', code: 'require("fs")' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Blocked by sandbox policy')
  })

  it('worker runtime runs allowed code', async () => {
    const runtime = createWorkerThreadRuntime()
    const result = await runtime.run({ language: 'typescript', code: 'console.log(40+2)' })
    expect(result.ok).toBe(true)
    expect(result.stdout).toContain('42')
  })
})
