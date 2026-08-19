import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServiceRegistry } from '../src/seams/registry.js'
import { createLocalShellProvider } from '../src/shell/provider-local.js'
import { createShellConsumer } from '../src/shell/consumer.js'
import { shellDefinition } from '../src/shell/definitions.js'
import type { ToolContext } from '../src/types.js'

const ctx: ToolContext = { signal: new AbortController().signal, sessionId: 'test', metadata: {} }

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tony-shell-'))
}

describe('shell service seam', () => {
  it('definition is the shell seam', () => {
    expect(shellDefinition.id).toBe('shell')
  })

  it('runs an allow-listed command inside the root', async () => {
    const root = await tempRoot()
    try {
      const reg = new ServiceRegistry()
      reg.register(createLocalShellProvider({ root }))
      const svc = reg.resolve<{ run: (cmd: string, o?: { cwd?: string }) => Promise<{ exitCode: number; stdout: string }> }>('shell')
      const result = await svc.run('pwd')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe(root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects commands outside the allow-list (fail-closed)', async () => {
    const root = await tempRoot()
    try {
      const reg = new ServiceRegistry()
      reg.register(createLocalShellProvider({ root }))
      const svc = reg.resolve<{ run: (cmd: string) => Promise<unknown> }>('shell')
      await expect(svc.run('rm -rf /')).rejects.toThrow(/not allowed/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('consumer produces shell:run tool that returns stdout', async () => {
    const root = await tempRoot()
    try {
      const reg = new ServiceRegistry()
      reg.register(createLocalShellProvider({ root }))
      const tools = reg.consume('shell', createShellConsumer())
      expect(tools).toHaveLength(1)
      expect(tools[0]!.name).toBe('shell:run')
      const result = await tools[0]!.execute({ command: 'echo hello' }, ctx)
      expect(result.isError).toBeUndefined()
      expect(result.content).toBe('hello')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('timeout kills long commands', async () => {
    const root = await tempRoot()
    try {
      const reg = new ServiceRegistry()
      reg.register(createLocalShellProvider({ root }))
      const svc = reg.resolve<{ run: (cmd: string, o?: { timeoutMs?: number }) => Promise<unknown> }>('shell')
      await expect(svc.run('node -e "setTimeout(() => {}, 5000)"', { timeoutMs: 100 })).rejects.toThrow(/timeout|failed/i)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
