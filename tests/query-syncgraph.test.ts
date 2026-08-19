import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionQueryEngine } from '../src/query/engine.js'
import { GraphExtractor } from '../src/query/extractor.js'
import type { LLMCompleter, LLMRequest, LLMResult } from '../src/types.js'
import type { Entry } from '../src/harness/session/types.js'
import type { SessionMeta } from '../src/query/types.js'

function entry(text: string, seq = 1): Entry {
  return {
    kind: 'message',
    seq,
    parentId: seq - 1,
    timestamp: 0,
    message: { role: 'user', content: text },
  } as unknown as Entry
}
const meta: SessionMeta = { sessionId: 's1', name: '', createdAt: 0, updatedAt: 0 }

function llmWith(content: string): LLMCompleter {
  return { complete: async (_req: LLMRequest): Promise<LLMResult> => ({ text: content, toolCalls: [] }) }
}

describe('syncGraph', () => {
  let dir: string
  let engine: SessionQueryEngine
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'syncgraph-'))
    engine = new SessionQueryEngine({ indexPath: join(dir, 'index.db') })
  })
  afterEach(async () => {
    engine.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('extracts and persists graph for a session', async () => {
    const extractor = new GraphExtractor(
      llmWith(JSON.stringify({ entities: [{ name: 'Hermes', type: 'agent' }], relations: [{ source: 'Hermes', target: 'tony-agent', kind: 'builds' }] })),
    )
    const result = await engine.syncGraph('s1', [entry('Hermes builds tony-agent')], meta, extractor)
    expect(result.warnings).toBeUndefined()
    expect(engine.getEntities('s1')).toEqual([{ name: 'Hermes', type: 'agent' }])
    expect(engine.getRelations('s1').length).toBe(1)
  })

  it('returns warnings when extraction fails, does not throw', async () => {
    const extractor = new GraphExtractor({
      complete: async () => {
        throw new Error('LLM down')
      },
    } as LLMCompleter)
    const result = await engine.syncGraph('s1', [entry('x')], meta, extractor)
    expect(result.warnings?.length).toBeGreaterThan(0)
    expect(engine.getEntities('s1')).toEqual([])
  })

  it('re-extraction replaces previous graph (incremental)', async () => {
    const extractor = new GraphExtractor(llmWith(JSON.stringify({ entities: [{ name: 'A', type: 't' }], relations: [] })))
    await engine.syncGraph('s1', [entry('A')], meta, extractor)
    const extractor2 = new GraphExtractor(llmWith(JSON.stringify({ entities: [{ name: 'B', type: 't' }], relations: [] })))
    await engine.syncGraph('s1', [entry('B')], meta, extractor2)
    expect(engine.getEntities('s1')).toEqual([{ name: 'B', type: 't' }])
  })
})