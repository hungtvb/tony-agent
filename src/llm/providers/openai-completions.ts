import type { Api, SimpleMessage, SimpleResult, SimpleStreamOptions, ToolDefinition, Usage, StopReason } from '../model.js'
import type { FetchLike } from '../../types.js'

export interface ProviderOptions {
  baseUrl: string
  apiKey?: string
  model: string
  fetcher?: FetchLike
  headers?: Record<string, string>
}

function defaultFetcher(): FetchLike {
  return (input, init) => fetch(input, init)
}

function toOpenAiMessages(messages: SimpleMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'user') return { role: 'user', content: message.content }
    if (message.role === 'assistant') {
      const text = typeof message.content === 'string' ? message.content : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
      return { role: 'assistant', content: text }
    }
    const toolCall = message.content as unknown as { toolCallId: string; name: string; content: string }
    return { role: 'tool', tool_call_id: toolCall.toolCallId ?? '', name: toolCall.name ?? '', content: typeof message.content === 'string' ? message.content : '' }
  })
}

function toOpenAiTools(tools?: ToolDefinition[]): unknown[] | undefined {
  return tools?.map((tool) => ({ type: 'function', function: tool.function }))
}

function parseOpenAiResult(json: Record<string, unknown>): SimpleResult {
  const choices = Array.isArray(json.choices) ? json.choices : []
  const choice = choices[0] as Record<string, unknown> | undefined
  const message = (choice?.message ?? {}) as Record<string, unknown>
  const usage = json.usage as Record<string, unknown> | undefined
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  const toolCalls = rawCalls.flatMap((raw) => {
    const call = raw as Record<string, unknown>
    const fn = (call.function ?? {}) as Record<string, unknown>
    if (typeof call.id !== 'string' || typeof fn.name !== 'string') return []
    let args: Record<string, unknown> = {}
    try { args = typeof fn.arguments === 'string' ? (JSON.parse(fn.arguments) as Record<string, unknown>) : (fn.arguments as Record<string, unknown> ?? {}) } catch { args = {} }
    return [{ id: call.id, name: fn.name, arguments: args }]
  })
  const finish = typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'stop'
  const resultUsage: Usage | undefined = usage
    ? {
        input: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
        output: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : 0,
      }
    : undefined
  return {
    text: typeof message.content === 'string' ? message.content : '',
    toolCalls,
    usage: resultUsage,
    stopReason: mapStopReason(finish),
  }
}

function mapStopReason(finish: string): StopReason {
  switch (finish) {
    case 'tool_calls': return 'tool_calls'
    case 'length': return 'length'
    case 'content_filter': return 'content_filter'
    case 'end_turn': return 'end_turn'
    case 'stop': return 'stop'
    default: return 'stop'
  }
}

export interface OpenAiCompletionsOptions extends ProviderOptions { stream?: boolean }

/** OpenAI-compatible `/chat/completions` provider adapter. */
export function createOpenAiCompletionsApi(options: OpenAiCompletionsOptions): Api {
  const fetcher = options.fetcher ?? defaultFetcher()
  return {
    async complete(request: { messages: SimpleMessage[]; tools?: ToolDefinition[] }, streamOptions: SimpleStreamOptions): Promise<SimpleResult> {
      const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`
      const body: Record<string, unknown> = {
        model: options.model,
        messages: toOpenAiMessages(request.messages),
        ...(request.tools && request.tools.length > 0 ? { tools: toOpenAiTools(request.tools) } : {}),
      }
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
        ...options.headers,
      }
      const response = await fetcher(url, { method: 'POST', headers, body: JSON.stringify(body), signal: streamOptions.signal })
      if (!response.ok) throw new Error(`OpenAI Completions HTTP ${response.status}: ${await response.text()}`)
      const json = await response.json() as Record<string, unknown>
      return parseOpenAiResult(json)
    },
  }
}

/** Anthropic Messages API adapter (native tool_use/tool_result). */
export function createAnthropicMessagesApi(options: ProviderOptions): Api {
  const fetcher = options.fetcher ?? defaultFetcher()
  return {
    async complete(request: { messages: SimpleMessage[]; tools?: ToolDefinition[] }, streamOptions: SimpleStreamOptions): Promise<SimpleResult> {
      const url = `${options.baseUrl.replace(/\/+$/, '')}/v1/messages`
      const messages = request.messages.flatMap((message): unknown[] => {
        if (message.role === 'user') return [{ role: 'user', content: typeof message.content === 'string' ? message.content : message.content.map((part) => ({ type: 'text', text: part.type === 'text' ? part.text : '' })) }]
        if (message.role === 'assistant') return [{ role: 'assistant', content: typeof message.content === 'string' ? message.content : message.content.map((part) => part.type === 'text' ? { type: 'text', text: part.text } : { type: 'tool_use', id: part.id, name: part.name, input: typeof part.arguments === 'string' ? JSON.parse(part.arguments) : part.arguments }) }]
        const tool = message.content as unknown as { toolCallId: string; name: string; content: string }
        return [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.toolCallId ?? '', content: typeof message.content === 'string' ? message.content : '' }] }]
      })
      const body: Record<string, unknown> = {
        model: options.model,
        messages,
        max_tokens: 4096,
        ...(request.tools && request.tools.length > 0 ? { tools: request.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters })) } : {}),
      }
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...(options.apiKey ? { 'x-api-key': options.apiKey } : {}),
        ...options.headers,
      }
      const response = await fetcher(url, { method: 'POST', headers, body: JSON.stringify(body), signal: streamOptions.signal })
      if (!response.ok) throw new Error(`Anthropic Messages HTTP ${response.status}: ${await response.text()}`)
      const json = await response.json() as Record<string, unknown>
      const content = Array.isArray(json.content) ? json.content : []
      const text = content.filter((part) => (part as Record<string, unknown>).type === 'text').map((part) => String((part as Record<string, unknown>).text ?? '')).join('')
      const toolBlocks = content.filter((part) => (part as Record<string, unknown>).type === 'tool_use')
      const toolCalls = toolBlocks.flatMap((raw) => {
        const block = raw as Record<string, unknown>
        if (typeof block.id !== 'string' || typeof block.name !== 'string') return []
        return [{ id: block.id, name: block.name, arguments: (block.input as Record<string, unknown>) ?? {} }]
      })
      const usage = json.usage as Record<string, unknown> | undefined
      return {
        text,
        toolCalls,
        usage: usage
          ? { input: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0, output: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0, cacheRead: typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0, cacheWrite: 0, totalTokens: (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0) + (typeof usage.output_tokens === 'number' ? usage.output_tokens : 0) }
          : undefined,
        stopReason: json.stop_reason === 'end_turn' ? 'end_turn' : json.stop_reason === 'max_tokens' ? 'max_tokens' : json.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
      }
    },
  }
}

/** OpenRouter adapter (OpenAI-compatible wire + provider headers). */
export function createOpenRouterApi(options: Omit<ProviderOptions, 'baseUrl'>): Api {
  const base = 'https://openrouter.ai/api/v1'
  const headers: Record<string, string> = { 'HTTP-Referer': 'https://github.com/hungtvb/tony-agent', 'X-Title': 'Tony Agent' }
  return createOpenAiCompletionsApi({ ...options, baseUrl: base, headers })
}

/** Vercel AI Gateway adapter (OpenAI-compatible). */
export function createVercelGatewayApi(options: ProviderOptions): Api {
  return createOpenAiCompletionsApi(options)
}
