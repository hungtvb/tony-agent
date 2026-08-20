import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TonyRuntime } from '../src/runtime.js'
import { SessionStore } from '../src/session/store.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { PermissionPolicy } from '../src/permissions/policy.js'
import { SessionQueryEngine } from '../src/query/engine.js'
import { GraphExtractor } from '../src/query/extractor.js'
import type { LLMCompleter } from '../src/types.js'

const stubLlm: LLMCompleter = {
  async complete() {
    return { text: 'ok', toolCalls: [] }
  },
}

describe('TonyRuntime session close → graph extract', () => {
  let dir: string
  let engine: SessionQueryEngine
  let store: SessionStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rt-close-'))
    engine = new SessionQueryEngine({ indexPath: join(dir, 'index.db') })
    store = new SessionStore(join(dir, 'store'))
    await store.initialize()
  })

  afterEach(async () => {
    engine.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('extracts entities on close via syncGraph (best-effort)', async () => {
    const extractor = new GraphExtractor({
      async complete() {
        return {
          text: JSON.stringify({ entities: [{ name: 'FTS5', type: 'tech' }], relations: [] }),
          toolCalls: [],
        }
      },
    } as unknown as LLMCompleter)
    const runtime = new TonyRuntime({
      store,
      llm: stubLlm,
      registry: new ToolRegistry(),
      permissions: new PermissionPolicy(),
      queryEngine: engine,
      graphExtractor: extractor,
    })
    const session = await runtime.createSession('close-test')
    await store.append(session.id, { role: 'user', content: 'FTS5 search works' })
    await session.close()
    const entities = engine.getEntities(session.id)
    expect(entities.some((e) => e.name === 'FTS5')).toBe(true)
  })

  it('double close extracts exactly once (idempotent)', async () => {
    let extractCalls = 0
    const extractor = new GraphExtractor({
      async complete() {
        extractCalls += 1
        return {
          text: JSON.stringify({ entities: [{ name: 'ONCE', type: 'tech' }], relations: [] }),
          toolCalls: [],
        }
      },
    } as unknown as LLMCompleter)
    const runtime = new TonyRuntime({
      store,
      llm: stubLlm,
      registry: new ToolRegistry(),
      permissions: new PermissionPolicy(),
      queryEngine: engine,
      graphExtractor: extractor,
    })
    const session = await runtime.createSession('close-once')
    await store.append(session.id, { role: 'user', content: 'once only' })
    await session.close()
    await session.close() // second close must not re-run extraction
    expect(extractCalls).toBe(1)
  })

  it('never throws when extraction fails', async () => {
    const extractor = new GraphExtractor({
      async complete() {
        throw new Error('extractor down')
      },
    } as unknown as LLMCompleter)
    const runtime = new TonyRuntime({
      store,
      llm: stubLlm,
      registry: new ToolRegistry(),
      permissions: new PermissionPolicy(),
      queryEngine: engine,
      graphExtractor: extractor,
      onEvent: () => {},
    })
    const session = await runtime.createSession('fail-test')
    await store.append(session.id, { role: 'user', content: 'hello' })
    await expect(session.close()).resolves.toBeUndefined()
  })

  it('close is a no-op without graphExtractor/queryEngine', async () => {
    const runtime = new TonyRuntime({
      store,
      llm: stubLlm,
      registry: new ToolRegistry(),
      permissions: new PermissionPolicy(),
    })
    const session = await runtime.createSession('noop')
    await store.append(session.id, { role: 'user', content: 'hi' })
    await expect(session.close()).resolves.toBeUndefined()
    expect(engine.getEntities(session.id)).toEqual([])
  })
})