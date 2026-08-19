import { describe, it, expect } from 'vitest'
import { GraphExtractor, parseExtraction } from '../src/query/extractor.js'
import type { LLMCompleter, LLMRequest, LLMResult } from '../src/types.js'
import type { Entry } from '../src/harness/session/types.js'

function mockLlm(content: string): LLMCompleter {
  return {
    complete: async (_request: LLMRequest): Promise<LLMResult> => ({
      text: content,
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    }),
  }
}
function entry(text: string, seq = 1): Entry {
  return {
    kind: 'message',
    seq,
    parentId: seq - 1,
    timestamp: 0,
    message: { role: 'user', content: text },
  } as unknown as Entry
}

describe('GraphExtractor', () => {
  it('extracts entities and relations from LLM JSON', async () => {
    const llm = mockLlm(
      JSON.stringify({
        entities: [{ name: 'Hermes', type: 'agent', description: 'assistant' }],
        relations: [{ source: 'Hermes', target: 'tony-agent', kind: 'builds' }],
      }),
    )
    const extractor = new GraphExtractor(llm)
    const result = await extractor.extract([entry('Hermes builds tony-agent')])
    expect(result.entities).toEqual([{ name: 'Hermes', type: 'agent', description: 'assistant' }])
    expect(result.relations).toEqual([{ source: 'Hermes', target: 'tony-agent', kind: 'builds' }])
  })

  it('handles malformed LLM output by returning empty (fail-soft)', async () => {
    const llm = mockLlm('not json at all')
    const extractor = new GraphExtractor(llm)
    const result = await extractor.extract([entry('anything')])
    expect(result.entities).toEqual([])
    expect(result.relations).toEqual([])
    expect(result.warnings?.length ?? 0).toBeGreaterThan(0)
  })

  it('passes modelName through to the LLM request options', async () => {
    let calledWith: unknown = null
    const llm = {
      complete: async (request: LLMRequest): Promise<LLMResult> => {
        calledWith = request
        return { text: '{"entities":[],"relations":[]}', toolCalls: [] }
      },
    } as LLMCompleter
    const extractor = new GraphExtractor(llm, 'deepseek-v4-flash')
    await extractor.extract([entry('x')])
    const request = calledWith as LLMRequest & { options?: { model?: string } }
    expect(request.options?.model).toBe('deepseek-v4-flash')
  })

  it('parseExtraction strips markdown fences', () => {
    const result = parseExtraction('```json\n{"entities":[{"name":"A","type":"t"}],"relations":[]}\n```')
    expect(result.entities).toEqual([{ name: 'A', type: 't' }])
  })
})
