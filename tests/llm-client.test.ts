import { describe, expect, it } from 'vitest'
import { extractJsonToolCalls, TonyLLMClient } from '../src/llm/client.js'

describe('extractJsonToolCalls', () => {
  it('extracts tool calls from a fenced JSON array with surrounding prose', () => {
    const calls = extractJsonToolCalls(
      'I will inspect the page.```json\n[{"name":"browser_snapshot","arguments":{}}]\n```',
    )

    expect(calls).toEqual([
      { id: expect.any(String), name: 'browser_snapshot', arguments: {} },
    ])
  })

  it('accepts an object containing tool_calls and string arguments', () => {
    const calls = extractJsonToolCalls(
      '{"tool_calls":[{"name":"browser_scroll","arguments":"{\\"amount\\":400}"}]}',
    )

    expect(calls[0]?.name).toBe('browser_scroll')
    expect(calls[0]?.arguments).toEqual({ amount: 400 })
  })

  it('returns no calls for ordinary assistant text', () => {
    expect(extractJsonToolCalls('The page is about browser privacy.')).toEqual([])
  })
})

describe('TonyLLMClient', () => {
  it('parses streamed text and native tool-call deltas', async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"I will inspect "}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"the page.","tool_calls":[{"index":0,"id":"call_1","function":{"name":"browser_snapshot","arguments":"{}"}}]}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const seen: string[] = []
    const fetcher = async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    const client = new TonyLLMClient({
      baseUrl: 'https://llm.test/v1',
      apiKey: 'secret',
      model: 'demo',
      maxRetries: 0,
    }, fetcher)

    const result = await client.complete({ messages: [{ role: 'user', content: 'Inspect' }] }, {
      onTextDelta: (delta) => seen.push(delta),
    })

    expect(seen.join('')).toBe('I will inspect the page.')
    expect(result.text).toBe('I will inspect the page.')
    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'browser_snapshot', arguments: {} },
    ])
  })

  it('emits text deltas while an SSE body is still arriving', async () => {
    const encoder = new TextEncoder()
    let firstDeltaResolve: (() => void) | undefined
    const firstDelta = new Promise<void>((resolve) => { firstDeltaResolve = resolve })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"early"}}]}\n\n'))
        setTimeout(() => {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" late"}}]}\n\ndata: [DONE]\n\n'))
          controller.close()
        }, 25)
      },
    })
    const fetcher = async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    const deltas: string[] = []
    const client = new TonyLLMClient({
      baseUrl: 'https://llm.test/v1',
      apiKey: 'secret',
      model: 'demo',
      maxRetries: 0,
    }, fetcher)

    const resultPromise = client.complete({ messages: [{ role: 'user', content: 'Hi' }] }, {
      onTextDelta: (delta) => { deltas.push(delta); firstDeltaResolve?.() },
    })
    await firstDelta
    expect(deltas).toEqual(['early'])
    await expect(resultPromise).resolves.toMatchObject({ text: 'early late' })
    expect(deltas).toEqual(['early', ' late'])
  })

  it('reassembles an SSE event whose data line is split across network chunks', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"split'))
        setTimeout(() => {
          controller.enqueue(encoder.encode(' event"}}]}\n\ndata: [DONE]\n\n'))
          controller.close()
        }, 5)
      },
    })
    const client = new TonyLLMClient({ baseUrl: 'https://llm.test/v1', model: 'demo', maxRetries: 0 }, async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))

    await expect(client.complete({ messages: [{ role: 'user', content: 'Hi' }] })).resolves.toMatchObject({ text: 'split event' })
  })

  it('supports non-streaming JSON mode for providers without SSE', async () => {
    let requestBody: Record<string, unknown> | undefined
    const fetcher = async (_input: string | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(
        '{"choices":[{"message":{"role":"assistant","content":"plain response"}}]}',
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const client = new TonyLLMClient({
      baseUrl: 'https://llm.test/v1',
      apiKey: 'secret',
      model: 'demo',
      stream: false,
      maxRetries: 0,
    }, fetcher)

    await expect(client.complete({ messages: [{ role: 'user', content: 'Hi' }] })).resolves.toMatchObject({ text: 'plain response' })
    expect(requestBody?.stream).toBe(false)
  })

  it('retries transient network failures but not authentication failures', async () => {
    let attempts = 0
    const fetcher = async () => {
      attempts += 1
      if (attempts === 1) throw new TypeError('socket reset')
      return new Response('{"choices":[{"message":{"content":"recovered"}}]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const client = new TonyLLMClient({
      baseUrl: 'https://llm.test/v1',
      model: 'demo',
      maxRetries: 1,
      retryDelayMs: 1,
    }, fetcher)
    await expect(client.complete({ messages: [{ role: 'user', content: 'Hi' }] })).resolves.toMatchObject({ text: 'recovered' })
    expect(attempts).toBe(2)

    const unauthorized = new TonyLLMClient({ baseUrl: 'https://llm.test/v1', model: 'demo', maxRetries: 2, retryDelayMs: 1 }, async () => new Response('nope', { status: 401 }))
    await expect(unauthorized.complete({ messages: [{ role: 'user', content: 'Hi' }] })).rejects.toThrow('HTTP 401')
  })

  it('tolerates a JSON response followed by an SSE done marker', async () => {
    const fetcher = async () => new Response(
      '{"choices":[{"message":{"role":"assistant","content":"done"}}]}data: [DONE]data: [DONE]',
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
    const client = new TonyLLMClient({
      baseUrl: 'https://llm.test/v1',
      apiKey: 'secret',
      model: 'demo',
      maxRetries: 0,
    }, fetcher)

    const result = await client.complete({ messages: [{ role: 'user', content: 'Hi' }] })
    expect(result.text).toBe('done')
  })
})
