import { describe, expect, it } from 'vitest'
import type { Api } from '../src/llm/model.js'
import { createOpenAiCompletionsApi, createAnthropicMessagesApi, createOpenRouterApi, createVercelGatewayApi } from '../src/llm/providers/index.js'

interface FetchCallRecord {
  url: string
  init: RequestInit
  body: Record<string, unknown>
}

function capturedFetch(bodies: unknown[]): typeof fetch & { calls: FetchCallRecord[] } {
  const calls: FetchCallRecord[] = []
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({ url, init: init ?? {}, body })
    const next = bodies.shift()
    if (next === undefined) return new Response('{}', { status: 200 })
    if (typeof next === 'string') return new Response(next, { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch & { calls: FetchCallRecord[] }
  fetcher.calls = calls
  return fetcher
}

describe('OpenAI Completions adapter', () => {
  it('posts /chat/completions with native tools and normalizes usage', async () => {
    const fetchMock = capturedFetch([
      { choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ])
    const api: Api = createOpenAiCompletionsApi({ baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o-mini', fetcher: fetchMock as typeof fetch })

    const result = await api.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'f', description: '', parameters: { type: 'object' } } }] }, {})

    expect(result.text).toBe('ok')
    expect(result.usage?.input).toBe(10)
    expect(result.usage?.totalTokens).toBe(15)
    expect(result.stopReason).toBe('stop')
    const call = fetchMock.calls[0]!
    expect(call.url).toContain('/chat/completions')
    expect(call.body.tools).toHaveLength(1)
    expect(call.body.model).toBe('gpt-4o-mini')
    expect(call.init.headers).toMatchObject({ Authorization: 'Bearer k' })
  })

  it('extracts native tool calls from the response', async () => {
    const fetchMock = capturedFetch([
      { choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'browser_snapshot', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
    ])
    const api: Api = createOpenAiCompletionsApi({ baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o-mini', fetcher: fetchMock as typeof fetch })

    const result = await api.complete({ messages: [{ role: 'user', content: 'go' }] }, {})
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]?.name).toBe('browser_snapshot')
    expect(result.stopReason).toBe('tool_calls')
  })
})

describe('Anthropic Messages adapter', () => {
  it('posts /v1/messages with tool_use format', async () => {
    const fetchMock = capturedFetch([
      { content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 8, output_tokens: 4 } },
    ])
    const api: Api = createAnthropicMessagesApi({ baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'claude-3-5-sonnet', fetcher: fetchMock as typeof fetch })

    const result = await api.complete({ messages: [{ role: 'user', content: 'hey' }], tools: [{ type: 'function', function: { name: 'f', description: '', parameters: { type: 'object' } } }] }, {})

    expect(result.text).toBe('hi')
    expect(result.usage?.input).toBe(8)
    expect(result.stopReason).toBe('end_turn')
    const call = fetchMock.calls[0]!
    expect(call.url).toContain('/v1/messages')
    expect(call.body.tools?.[0]).toMatchObject({ name: 'f' })
    expect(call.init.headers).toMatchObject({ 'x-api-key': 'k', 'anthropic-version': '2023-06-01' })
  })
})

describe('OpenRouter adapter', () => {
  it('uses OpenAI-compatible chat/completions and includes the http header', async () => {
    const fetchMock = capturedFetch([
      { choices: [{ message: { content: 'openrouter ok', tool_calls: [] }, finish_reason: 'stop' }] },
    ])
    const api: Api = createOpenRouterApi({ apiKey: 'k', model: 'openai/gpt-4o-mini', fetcher: fetchMock as typeof fetch })

    const result = await api.complete({ messages: [{ role: 'user', content: 'hi' }] }, {})
    expect(result.text).toBe('openrouter ok')
    const call = fetchMock.calls[0]!
    expect(call.url).toContain('openrouter.ai')
    expect(call.init.headers).toMatchObject({ Authorization: 'Bearer k', 'HTTP-Referer': expect.stringContaining('github.com') })
  })
})

describe('Vercel AI Gateway adapter', () => {
  it('posts to the gateway base URL with OpenAI-compatible shape', async () => {
    const fetchMock = capturedFetch([
      { choices: [{ message: { content: 'vercel ok', tool_calls: [] }, finish_reason: 'stop' }] },
    ])
    const api: Api = createVercelGatewayApi({ baseUrl: 'https://gateway.example.com/v1', apiKey: 'k', model: 'gpt-4o', fetcher: fetchMock as typeof fetch })

    const result = await api.complete({ messages: [{ role: 'user', content: 'hi' }] }, {})
    expect(result.text).toBe('vercel ok')
    const call = fetchMock.calls[0]!
    expect(call.url).toContain('gateway.example.com')
  })
})