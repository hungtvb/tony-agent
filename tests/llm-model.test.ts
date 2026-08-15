import { describe, expect, it } from 'vitest'
import { Models, type Api, type Model, type SimpleResult, type SimpleStreamOptions, type ToolDefinition } from '../src/llm/model.js'

const sampleModel: Model = {
  id: 'gpt-4o-mini',
  name: 'GPT-4o Mini',
  api: 'openai-completions',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  reasoning: false,
  contextWindow: 128_000,
  maxTokens: 16_384,
  input: ['text', 'image'],
  cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
}

function fakeApi(): Api {
  return {
    async complete(request, options) {
      void options
      const last = request.messages.at(-1)
      return {
        text: `echo:${last?.content ?? ''}`,
        toolCalls: [],
        usage: { input: 10, output: 5, totalTokens: 15 },
        stopReason: 'end_turn',
      }
    },
  }
}

describe('Models', () => {
  it('registers models and resolves by id or prefix', () => {
    const models = new Models()
    models.register({ model: sampleModel, api: fakeApi() })

    expect(models.list()).toHaveLength(1)
    expect(models.resolve('gpt-4o-mini')?.model.id).toBe('gpt-4o-mini')
    expect(models.resolve('gpt-4o')?.model.id).toBe('gpt-4o-mini')
    expect(models.resolve('claude-3')).toBeUndefined()
  })

  it('completeSimple routes to the registered api and reports usage', async () => {
    const models = new Models()
    models.register({ model: sampleModel, api: fakeApi() })

    const result = await models.completeSimple(sampleModel, { messages: [{ role: 'user', content: 'hi' }] })
    expect(result.text).toBe('echo:hi')
    expect(result.usage?.totalTokens).toBe(15)
    expect(result.stopReason).toBe('end_turn')
  })

  it('completeSimple throws when the model is not registered', async () => {
    const models = new Models()
    await expect(models.completeSimple({ ...sampleModel, id: 'ghost' }, { messages: [] })).rejects.toThrow(/not registered/)
  })

  it('falls back to the default model when none is registered', async () => {
    const models = new Models()
    models.register({ model: sampleModel, api: fakeApi() })
    expect(models.resolve(undefined)?.model.id).toBe('gpt-4o-mini')
    expect(models.resolve('')?.model.id).toBe('gpt-4o-mini')
  })

  it('completeSimple forwards stream options and tools', async () => {
    const calls: Array<{ options: SimpleStreamOptions; tools?: ToolDefinition[] }> = []
    const api: Api = {
      async complete(request, options) {
        calls.push({ options, tools: request.tools })
        void request
        return { text: '', toolCalls: [], usage: undefined, stopReason: 'stop' }
      },
    }
    const models = new Models()
    models.register({ model: sampleModel, api })
    const tools: ToolDefinition[] = [{ type: 'function', function: { name: 'f', description: '', parameters: { type: 'object' } } }]

    await models.completeSimple(sampleModel, { messages: [], tools }, { signal: undefined, cacheRetention: 'none', sessionId: 's1' })
    expect(calls[0]?.options.sessionId).toBe('s1')
    expect(calls[0]?.tools).toHaveLength(1)
  })
})

describe('Model metadata', () => {
  it('exposes cost structure and reasoning capability', () => {
    expect(sampleModel.cost.input).toBe(0.15)
    expect(sampleModel.reasoning).toBe(false)
    expect(sampleModel.input).toContain('text')
  })
})

describe('SimpleResult', () => {
  it('carries optional usage and stop reason', () => {
    const result: SimpleResult = { text: 'x', toolCalls: [], usage: { input: 1 }, stopReason: 'stop' }
    expect(result.usage?.input).toBe(1)
    expect(result.stopReason).toBe('stop')
  })
})