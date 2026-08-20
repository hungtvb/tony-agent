import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TonyRuntime } from '../src/runtime.js'
import { SessionStore } from '../src/session/store.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { PermissionPolicy } from '../src/permissions/policy.js'
import { SessionQueryEngine } from '../src/query/engine.js'
import { createGraphContextBuilder, type GraphContextBuilder } from '../src/query/graph-context.js'
import type { LLMCompleter, LLMRequest, LLMResult, LLMMessage } from '../src/types.js'

function stubLlm(seen: LLMMessage[][]): LLMCompleter {
  return {
    async complete(request: LLMRequest): Promise<LLMResult> {
      seen.push(request.messages)
      return { text: 'ok', toolCalls: [] }
    },
  }
}

describe('TonyRuntime graph context', () => {
  let dir: string
  let engine: SessionQueryEngine
  let store: SessionStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runtime-gc-'))
    engine = new SessionQueryEngine({ indexPath: join(dir, 'index.db') })
    // seed one graph hit for 'FTS5'
    engine.setEntities('s1', [{ name: 'FTS5', type: 'tech' }])
    engine.setRelations('s1', [])
    engine.sync('s1', [
      { kind: 'message', seq: 1, parentId: 0, timestamp: 0, message: { role: 'user', content: 'FTS5 search works' } },
    ], { sessionId: 's1', name: '', createdAt: 0, updatedAt: 0 })
    store = new SessionStore(join(dir, 'store'))
    await store.initialize()
  })

  afterEach(async () => {
    engine.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('auto-creates graph context from queryEngine and injects into agent', async () => {
    const seen: LLMMessage[][] = []
    const runtime = new TonyRuntime({
      store,
      llm: stubLlm(seen),
      registry: new ToolRegistry(),
      permissions: new PermissionPolicy(),
      queryEngine: engine,
    })
    const session = await runtime.createSession('t')
    await session.ask('tell me about FTS5')
    // recall block present (auto-derived builder uses the user message term)
    expect(seen[0]!.some((m) => m.role === 'system' && m.content.startsWith('Graph recall'))).toBe(true)
  })

  it('passes an explicit graphContext through unmodified', async () => {
    const seen: LLMMessage[][] = []
    const marker: GraphContextBuilder = {
      build: async () => ({ message: { role: 'system', content: 'EXPLICIT recall block' }, hitCount: 1, latencyMs: 0 }),
    } as unknown as GraphContextBuilder
    const runtime = new TonyRuntime({
      store,
      llm: stubLlm(seen),
      registry: new ToolRegistry(),
      permissions: new PermissionPolicy(),
      queryEngine: engine,
      graphContext: marker,
    })
    const session = await runtime.createSession('t2')
    await session.ask('hi')
    expect(seen[0]!.some((m) => m.role === 'system' && m.content === 'EXPLICIT recall block')).toBe(true)
  })

  it('does not inject recall when no queryEngine and no explicit builder', async () => {
    const seen: LLMMessage[][] = []
    const runtime = new TonyRuntime({
      store,
      llm: stubLlm(seen),
      registry: new ToolRegistry(),
      permissions: new PermissionPolicy(),
    })
    const session = await runtime.createSession('t3')
    await session.ask('hi')
    expect(seen[0]!.some((m) => m.role === 'system' && m.content.startsWith('Graph recall'))).toBe(false)
  })

  it('createGraphContextBuilder(undefined) is a no-op builder', async () => {
    const builder = createGraphContextBuilder(undefined)
    expect(builder.engine).toBeUndefined()
    const output = await builder.build('x', [])
    expect(output).toBeNull()
  })
})