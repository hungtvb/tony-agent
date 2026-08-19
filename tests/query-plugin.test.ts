import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionQueryEngine } from '../src/query/engine.js'
import { createQueryConsumer, createQueryPlugin, QUERY_SERVICE_ID } from '../src/query/plugin.js'
import { ServiceRegistry } from '../src/seams/registry.js'
import { createEntry } from '../src/harness/session/types.js'

const directories: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tony-query-plugin-'))
  directories.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true })))
  directories.length = 0
})

describe('query plugin (service seam)', () => {
  it('consumer wraps the engine into query:search tool', async () => {
    const dir = await tempDir()
    const engine = new SessionQueryEngine({ indexPath: join(dir, 'index.db') })
    const consumer = createQueryConsumer()
    const tools = consumer.uses(engine)
    const tool = Array.isArray(tools) ? tools[0]! : tools
    expect(tool.name).toBe('query:search')
    expect(tool.risk).toBe('read')

    engine.sync('s1', [
      createEntry({ kind: 'message', message: { role: 'user', content: 'discussed FTS5 session query design' }, seq: 1, parentId: 0 }),
    ], { sessionId: 's1', name: 'S1', createdAt: 1, updatedAt: 2 })

    const result = await tool.execute({ query: 'FTS5' }, {} as never)
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('s1')
    expect(result.content).toContain('discussed')
    engine.close()
  })

  it('plugin mounts provider + tool via registry', async () => {
    const dir = await tempDir()
    const engine = new SessionQueryEngine({ indexPath: join(dir, 'index.db') })
    // minimal plugin ctx: services registry + tools shadow/deny
    const registry = new ServiceRegistry()
    const shadows = new Map<string, unknown>()
    const denied = new Set<string>()
    const ctx = {
      services: registry,
      tools: {
        shadow: (name: string, tool: unknown) => { shadows.set(name, tool) },
        deny: (name: string) => { denied.add(name) },
      },
    }
    const plugin = createQueryPlugin(engine)
    const setupResult = plugin.setup(ctx as never) as { dispose(): void } | undefined
    expect(registry.has(QUERY_SERVICE_ID)).toBe(true)
    expect(shadows.has('query:search')).toBe(true)
    setupResult?.dispose()
    expect(registry.has(QUERY_SERVICE_ID)).toBe(false)
    expect(denied.has('query:search')).toBe(true)
    engine.close()
  })
})