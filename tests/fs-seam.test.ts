import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServiceRegistry } from '../src/seams/registry.js'
import { createLocalFsProvider } from '../src/fs/provider-local.js'
import { createFsConsumer } from '../src/fs/consumer.js'
import { fsDefinition } from '../src/fs/definitions.js'
import type { ToolContext } from '../src/types.js'

const ctx: ToolContext = { signal: new AbortController().signal, sessionId: 'test', metadata: {} }

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tony-fs-'))
  return dir
}

describe('fs service seam', () => {
  it('provider definition is the fs seam', () => {
    expect(fsDefinition.id).toBe('fs')
  })

  it('local provider resolves/reads/writes/lists inside workspace', async () => {
    const root = await tempRoot()
    try {
      const reg = new ServiceRegistry()
      reg.register(createLocalFsProvider({ root }))
      const svc = reg.resolve<{ kind: string; root: string; read: (p: string) => Promise<string>; write: (p: string, c: string) => Promise<void>; list: (p: string) => Promise<string[]> }>('fs')
      await svc.write('hello.txt', 'hi')
      expect(await svc.read('hello.txt')).toBe('hi')
      expect(await svc.list('.')).toContain('hello.txt')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('consumer produces fs_read/fs_write/fs_list tools', () => {
    const reg = new ServiceRegistry()
    reg.register(createLocalFsProvider({ root: tmpdir() }))
    const tools = reg.consume('fs', createFsConsumer())
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['fs_list', 'fs_read', 'fs_write'])
  })

  it('fs_read returns isError on escape attempt (fail-closed)', async () => {
    const root = await tempRoot()
    try {
      const reg = new ServiceRegistry()
      reg.register(createLocalFsProvider({ root }))
      const svc = reg.resolve<FsSvcLike>('fs')
      const readTool = reg.consume('fs', createFsConsumer())[1]!
      const result = await readTool.execute({ path: '../etc/passwd' }, ctx)
      expect(result.isError).toBe(true)
      expect(result.content).toMatch(/escapes/i)
      void svc
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

type FsSvcLike = {
  kind: string
  root: string
  read: (p: string) => Promise<string>
  write: (p: string, c: string) => Promise<void>
  list: (p: string) => Promise<string[]>
  resolve: (p: string) => Promise<string>
  exists: (p: string) => Promise<boolean>
}
