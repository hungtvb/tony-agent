import type {
  FetchLike,
  LLMCompleter,
  LLMConfig,
  LLMMessage,
  LLMRequest,
  LLMResult,
  ToolCall,
} from '../types.js'

interface NativeToolDelta {
  id?: string
  name?: string
  arguments?: string
}

interface NativeToolAccumulator {
  id: string
  name: string
  arguments: string
}

interface JsonToolCall {
  id?: unknown
  name?: unknown
  arguments?: unknown
  tool?: unknown
  input?: unknown
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

function isToolCall(value: unknown): value is JsonToolCall {
  return isRecord(value) && (
    typeof value.name === 'string' ||
    (isRecord(value.tool) && typeof value.tool.name === 'string')
  )
}

function normalizeToolCall(value: JsonToolCall, index: number): ToolCall | undefined {
  const nested = isRecord(value.tool) ? value.tool : undefined
  const name = typeof value.name === 'string' ? value.name : nested && typeof nested.name === 'string' ? nested.name : undefined
  if (!name) return undefined
  const rawArguments = value.arguments ?? value.input ?? nested?.arguments ?? nested?.input ?? {}
  return {
    id: typeof value.id === 'string' ? value.id : `json-call-${index + 1}`,
    name,
    arguments: parseArguments(rawArguments),
  }
}

function balancedJsonCandidates(text: string): unknown[] {
  const candidates: unknown[] = []
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{' && text[start] !== '[') continue
    const stack: string[] = []
    let inString = false
    let escaped = false
    for (let end = start; end < text.length; end += 1) {
      const char = text[end]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') {
        inString = true
        continue
      }
      if (char === '{' || char === '[') stack.push(char)
      else if (char === '}' || char === ']') {
        const opening = stack.pop()
        if ((char === '}' && opening !== '{') || (char === ']' && opening !== '[')) break
        if (stack.length === 0) {
          try { candidates.push(JSON.parse(text.slice(start, end + 1))) } catch { /* keep scanning */ }
          break
        }
      }
    }
  }
  return candidates
}

/** Extracts the JSON fallback format accepted by Tony Agent. */
export function extractJsonToolCalls(text: string): ToolCall[] {
  const fenceMatches = Array.from(text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)).map((match) => match[1] ?? '')
  const candidates = [...fenceMatches, text].flatMap((candidate) => balancedJsonCandidates(candidate))
  for (const candidate of candidates) {
    const rawCalls: unknown[] = Array.isArray(candidate)
      ? candidate
      : isRecord(candidate) && Array.isArray(candidate.tool_calls)
        ? candidate.tool_calls
        : isRecord(candidate) && Array.isArray(candidate.tools)
          ? candidate.tools
          : isRecord(candidate) && isToolCall(candidate)
            ? [candidate]
            : []
    const calls = rawCalls
      .filter(isToolCall)
      .map((call, index) => normalizeToolCall(call, index))
      .filter((call): call is ToolCall => call !== undefined)
    if (calls.length > 0) return calls
  }
  return []
}

function parseJsonPayload(text: string): Record<string, unknown> | undefined {
  const candidates = balancedJsonCandidates(text)
  return candidates.find(isRecord)
}

function extractChoice(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = payload.choices
  if (!Array.isArray(choices) || !isRecord(choices[0])) return undefined
  return choices[0]
}

function extractMessageContent(message: Record<string, unknown>): string {
  return typeof message.content === 'string' ? message.content : ''
}

function extractNativeCalls(message: Record<string, unknown>): ToolCall[] {
  if (!Array.isArray(message.tool_calls)) return []
  return message.tool_calls.flatMap((raw, index) => {
    if (!isRecord(raw) || !isRecord(raw.function) || typeof raw.function.name !== 'string') return []
    return [{
      id: typeof raw.id === 'string' ? raw.id : `tool-call-${index + 1}`,
      name: raw.function.name,
      arguments: parseArguments(raw.function.arguments),
    }]
  })
}

function mergeToolDelta(accumulators: Map<number, NativeToolAccumulator>, delta: NativeToolDelta, index: number): void {
  const current = accumulators.get(index) ?? { id: `tool-call-${index + 1}`, name: '', arguments: '' }
  if (delta.id) current.id = delta.id
  if (delta.name) current.name += delta.name
  if (delta.arguments) current.arguments += delta.arguments
  accumulators.set(index, current)
}

function toToolCalls(accumulators: Map<number, NativeToolAccumulator>): ToolCall[] {
  return Array.from(accumulators.entries())
    .sort(([a], [b]) => a - b)
    .map(([index, call]) => ({
      id: call.id || `tool-call-${index + 1}`,
      name: call.name,
      arguments: parseArguments(call.arguments),
    }))
    .filter((call) => call.name.length > 0)
}

function parseUsage(payload: Record<string, unknown>): LLMResult['usage'] {
  if (!isRecord(payload.usage)) return undefined
  return {
    promptTokens: typeof payload.usage.prompt_tokens === 'number' ? payload.usage.prompt_tokens : undefined,
    completionTokens: typeof payload.usage.completion_tokens === 'number' ? payload.usage.completion_tokens : undefined,
    totalTokens: typeof payload.usage.total_tokens === 'number' ? payload.usage.total_tokens : undefined,
  }
}

function makeAbortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (!signal) return
    if (signal.aborted) {
      clearTimeout(timer)
      reject(makeAbortError())
      return
    }
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(makeAbortError())
    }, { once: true })
  })
}

export class TonyLLMClient implements LLMCompleter {
  private readonly config: Required<Pick<LLMConfig, 'baseUrl' | 'model'>> & LLMConfig
  private readonly fetcher: FetchLike

  constructor(config: LLMConfig, fetcher: FetchLike = fetch) {
    this.config = { ...config, baseUrl: config.baseUrl.replace(/\/+$/, ''), model: config.model }
    this.fetcher = fetcher
  }

  async complete(request: LLMRequest, callbacks?: { onTextDelta?: (delta: string) => void }): Promise<LLMResult> {
    const maxRetries = this.config.maxRetries ?? 2
    let attempt = 0
    while (true) {
      try {
        return await this.completeOnce(request, callbacks)
      } catch (error) {
        if (request.signal?.aborted || attempt >= maxRetries || !this.isRetryableError(error)) throw error
        attempt += 1
        await sleep((this.config.retryDelayMs ?? 250) * (2 ** (attempt - 1)), request.signal)
      }
    }
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof TonyLLMError) {
      return error.status === undefined || RETRYABLE_STATUS.has(error.status) || error.status >= 500
    }
    return error instanceof TypeError
  }

  private async completeOnce(request: LLMRequest, callbacks?: { onTextDelta?: (delta: string) => void }): Promise<LLMResult> {
    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.config.timeoutMs ?? 60_000)
    const onAbort = () => controller.abort()
    request.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const stream = this.config.stream !== false
      const body: Record<string, unknown> = {
        model: this.config.model,
        messages: messagesToOpenAI(request.messages),
        stream,
      }
      if (request.tools && request.tools.length > 0) {
        body.tools = request.tools
        body.tool_choice = 'auto'
      }
      const headers = {
        accept: stream ? 'text/event-stream, application/json' : 'application/json',
        'content-type': 'application/json',
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        ...this.config.headers,
      }
      const response = await this.fetcher(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500)
        throw new TonyLLMError(`LLM request failed with HTTP ${response.status}: ${detail}`, response.status)
      }

      const contentType = response.headers.get('content-type') ?? ''
      if (stream && contentType.includes('text/event-stream')) {
        return await this.readSse(response, callbacks)
      }
      const raw = await response.text()
      if (stream && raw.includes('\ndata:')) return this.parseSseText(raw, callbacks)
      return this.parseJsonResult(raw)
    } catch (error) {
      if (timedOut) throw new TonyLLMError(`LLM request timed out after ${(this.config.timeoutMs ?? 60_000) / 1000}s`)
      if (controller.signal.aborted && request.signal?.aborted) throw makeAbortError()
      throw error
    } finally {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', onAbort)
    }
  }

  private parseJsonResult(raw: string): LLMResult {
    const payload = parseJsonPayload(raw)
    if (!payload) throw new TonyLLMError('LLM response did not contain a JSON payload')
    const choice = extractChoice(payload)
    const message = choice && isRecord(choice.message) ? choice.message : undefined
    const text = message ? extractMessageContent(message) : ''
    const nativeCalls = message ? extractNativeCalls(message) : []
    return {
      text,
      toolCalls: nativeCalls.length > 0 ? nativeCalls : extractJsonToolCalls(text),
      usage: parseUsage(payload),
      finishReason: choice && typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined,
    }
  }

  private async readSse(response: Response, callbacks?: { onTextDelta?: (delta: string) => void }): Promise<LLMResult> {
    if (!response.body) return this.parseJsonResult(await response.text())
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let text = ''
    let finishReason: string | undefined
    let usage: LLMResult['usage']
    const accumulators = new Map<number, NativeToolAccumulator>()
    const processEvent = (payload: string) => {
      const trimmed = payload.trim()
      if (!trimmed || trimmed === '[DONE]') return
      let parsed: unknown
      try { parsed = JSON.parse(trimmed) } catch { return }
      if (!isRecord(parsed)) return
      usage = parseUsage(parsed) ?? usage
      const choice = extractChoice(parsed)
      if (!choice || !isRecord(choice.delta)) return
      const delta = choice.delta
      if (typeof delta.content === 'string') {
        text += delta.content
        callbacks?.onTextDelta?.(delta.content)
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const rawCall of delta.tool_calls) {
          if (!isRecord(rawCall)) continue
          const index = typeof rawCall.index === 'number' ? rawCall.index : 0
          const fn = isRecord(rawCall.function) ? rawCall.function : {}
          mergeToolDelta(accumulators, {
            id: typeof rawCall.id === 'string' ? rawCall.id : undefined,
            name: typeof fn.name === 'string' ? fn.name : undefined,
            arguments: typeof fn.arguments === 'string' ? fn.arguments : undefined,
          }, index)
        }
      }
      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason
    }
    const processEventBlock = (block: string) => {
      const payload = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      processEvent(payload)
    }
    const processBuffer = (flush = false) => {
      while (true) {
        const boundary = /\r?\n\r?\n/.exec(buffer)
        if (!boundary || boundary.index === undefined) break
        const block = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        processEventBlock(block)
      }
      if (flush && buffer.trim().length > 0) {
        processEventBlock(buffer)
        buffer = ''
      }
    }
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      processBuffer()
    }
    buffer += decoder.decode()
    processBuffer(true)
    const nativeCalls = toToolCalls(accumulators)
    return { text, toolCalls: nativeCalls.length > 0 ? nativeCalls : extractJsonToolCalls(text), usage, finishReason }
  }

  private parseSseText(raw: string, callbacks?: { onTextDelta?: (delta: string) => void }): LLMResult {
    const chunks = raw.split(/\r?\n\r?\n/)
    let text = ''
    let finishReason: string | undefined
    let usage: LLMResult['usage']
    const accumulators = new Map<number, NativeToolAccumulator>()
    for (const chunk of chunks) {
      const payload = chunk.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
      if (!payload || payload === '[DONE]') continue
      let parsed: unknown
      try { parsed = JSON.parse(payload) } catch { continue }
      if (!isRecord(parsed)) continue
      usage = parseUsage(parsed) ?? usage
      const choice = extractChoice(parsed)
      if (!choice || !isRecord(choice.delta)) continue
      const delta = choice.delta
      if (typeof delta.content === 'string') {
        text += delta.content
        callbacks?.onTextDelta?.(delta.content)
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const rawCall of delta.tool_calls) {
          if (!isRecord(rawCall)) continue
          const index = typeof rawCall.index === 'number' ? rawCall.index : 0
          const fn = isRecord(rawCall.function) ? rawCall.function : {}
          mergeToolDelta(accumulators, {
            id: typeof rawCall.id === 'string' ? rawCall.id : undefined,
            name: typeof fn.name === 'string' ? fn.name : undefined,
            arguments: typeof fn.arguments === 'string' ? fn.arguments : undefined,
          }, index)
        }
      }
      if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason
    }
    const nativeCalls = toToolCalls(accumulators)
    return { text, toolCalls: nativeCalls.length > 0 ? nativeCalls : extractJsonToolCalls(text), usage, finishReason }
  }
}

export class TonyLLMError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'TonyLLMError'
  }
}

export function messagesToOpenAI(messages: LLMMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    const toolCalls = message.toolCalls?.map((call) => ({
      id: call.id,
      type: 'function',
      function: {
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      },
    }))
    return {
      role: message.role,
      content: message.content,
      ...(message.name ? { name: message.name } : {}),
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    }
  })
}

export function parseProviderJson(text: string): LLMResult {
  const client = Object.create(TonyLLMClient.prototype) as TonyLLMClient
  return (client as unknown as { parseJsonResult: (raw: string) => LLMResult }).parseJsonResult(text)
}

export function parseProviderSse(text: string, onTextDelta?: (delta: string) => void): LLMResult {
  const client = Object.create(TonyLLMClient.prototype) as TonyLLMClient
  return (client as unknown as { parseSseText: (raw: string, callbacks?: { onTextDelta?: (delta: string) => void }) => LLMResult }).parseSseText(text, onTextDelta ? { onTextDelta } : undefined)
}
