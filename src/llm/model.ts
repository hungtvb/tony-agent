import type { ToolCall } from '../types.js'

/** Content type a model can consume. */
export type InputContentType = 'text' | 'image' | 'audio' | 'pdf' | 'video'

export interface ModelCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Static metadata about a model, mirroring the pi-ai `Model` shape. */
export interface Model {
  id: string
  name: string
  api: string
  provider: string
  baseUrl: string
  reasoning: boolean
  input: InputContentType[]
  cost: ModelCost
  contextWindow: number
  maxTokens: number
}

export type StopReason = 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'error' | 'aborted' | 'end_turn' | 'max_tokens'

export interface MessageText {
  type: 'text'
  text: string
}

export interface MessageToolCall {
  type: 'toolCall'
  id: string
  name: string
  arguments: string | Record<string, unknown>
}

export type SimpleContent = MessageText | MessageToolCall

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost?: ModelCost
  reasoning?: number
}

export type Role = 'system' | 'user' | 'assistant' | 'toolResult'

export interface SimpleMessage {
  role: Role
  content: string | SimpleContent[]
  usage?: Usage
  stopReason?: StopReason
}

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface SimpleResult {
  text: string
  toolCalls: ToolCall[]
  usage?: Usage
  stopReason?: StopReason
}

export interface SimpleStreamOptions {
  signal?: AbortSignal
  cacheRetention?: 'none' | 'short' | 'long'
  sessionId?: string
  thinking?: { level: string; budgetTokens?: number }
  onTextDelta?: (delta: string) => void
}

/** A provider adapter implementing the unified wire contract. */
export interface Api {
  complete(
    request: { messages: SimpleMessage[]; tools?: ToolDefinition[] },
    options: SimpleStreamOptions,
  ): Promise<SimpleResult>
}

export interface RegisteredModel {
  model: Model
  api: Api
}

/** Registry of models with a default fallback. */
export class Models {
  private readonly registered: RegisteredModel[] = []

  register(entry: RegisteredModel): this {
    this.registered.push(entry)
    return this
  }

  list(): Model[] {
    return this.registered.map((entry) => entry.model)
  }

  resolve(modelId?: string): RegisteredModel | undefined {
    if (!modelId) return this.registered[0]
    const exact = this.registered.find((entry) => entry.model.id === modelId)
    if (exact) return exact
    return this.registered.find((entry) => entry.model.id.startsWith(modelId))
  }

  async completeSimple(
    model: Model,
    context: { messages: SimpleMessage[]; tools?: ToolDefinition[] },
    options: SimpleStreamOptions = {},
  ): Promise<SimpleResult> {
    const entry = this.registered.find((candidate) => candidate.model.id === model.id)
    if (!entry) throw new Error(`Model not registered: ${model.id}`)
    return entry.api.complete(context, options)
  }
}

export function usageFromParts(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite }
}