import type { ZodTypeAny } from 'zod'
import type { PageAdapter } from './host/adapter.js'

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface LLMMessage {
  role: MessageRole
  content: string
  name?: string
  toolCallId?: string
  toolCalls?: ToolCall[]
}

export type JsonSchema = Record<string, unknown>

export interface LLMToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: JsonSchema
  }
}

export interface LLMRequest {
  messages: LLMMessage[]
  tools?: LLMToolDefinition[]
  signal?: AbortSignal
}

export interface LLMUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export interface LLMResult {
  text: string
  toolCalls: ToolCall[]
  usage?: LLMUsage
  finishReason?: string
}

export interface LLMConfig {
  baseUrl: string
  apiKey?: string
  model: string
  timeoutMs?: number
  maxRetries?: number
  retryDelayMs?: number
  stream?: boolean
  headers?: Record<string, string>
  systemPrompt?: string
}

export type RiskLevel = 'read' | 'light' | 'risky' | 'blocked'
export type PermissionDecision = 'allow' | 'confirm' | 'deny'
export type PermissionResolution = 'allow-once' | 'allow-session' | 'deny'
/** How a tool may be surfaced to the model: native JSON call, code-mode
 *  expression, or both. Mirrors the dsh presentation modes. */
export type ToolPresentation = 'native' | 'code' | 'both'

export interface ToolContext {
  signal: AbortSignal
  sessionId: string
  site?: string
  adapter?: PageAdapter
  metadata: Record<string, unknown>
  /** Presentation mode of the current execution (defaults to 'native'). */
  presentation?: ToolPresentation
}

export interface ToolResult {
  content: string
  isError?: boolean
  data?: unknown
}

export interface TonyTool<TInput = unknown> {
  name: string
  description: string
  risk: RiskLevel
  /** Defaults to 'both' when omitted (tools are usable from any surface). */
  presentation?: ToolPresentation
  inputSchema: ZodTypeAny
  parameters: JsonSchema
  execute: (input: TInput, context: ToolContext) => Promise<ToolResult> | ToolResult
}

export interface PermissionRule {
  tool?: string
  site?: string
  decision: PermissionDecision
}

export interface PermissionRequest {
  requestId: string
  tool: TonyTool
  arguments: Record<string, unknown>
  sessionId: string
  site?: string
}

export interface AgentLimits {
  maxTurns: number
  maxToolCalls: number
  maxToolCallsPerTurn: number
  timeoutMs: number
}

export interface TonyConfig {
  llm: LLMConfig
  systemPrompt?: string
  limits?: Partial<AgentLimits>
}

export type AgentEvent =
  | { type: 'agent_start'; sessionId: string; prompt: string; timestamp: number }
  | { type: 'turn_start'; sessionId: string; turn: number; timestamp: number }
  | { type: 'message_update'; sessionId: string; delta: string; timestamp: number }
  | { type: 'tool_call'; sessionId: string; call: ToolCall; timestamp: number }
  | { type: 'permission_request'; sessionId: string; request: PermissionRequest; timestamp: number }
  | { type: 'tool_result'; sessionId: string; call: ToolCall; result: ToolResult; timestamp: number }
  | { type: 'turn_end'; sessionId: string; turn: number; timestamp: number }
  | { type: 'agent_end'; sessionId: string; text: string; timestamp: number }
  | { type: 'error'; sessionId: string; error: string; timestamp: number }

export interface AgentRunResult {
  sessionId: string
  text: string
  turns: number
  toolCalls: number
  events: AgentEvent[]
  messages: LLMMessage[]
}

export interface BrowserTab {
  id: string
  url: string
  title: string
  active?: boolean
}

export interface SessionInfo {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  /** Optional work lane / topic tag (e.g. 'research', 'coding', 'ops'). */
  lane?: string
}

export type SessionEntryRole = 'system' | 'user' | 'assistant' | 'tool' | 'summary'

export interface SessionEntry {
  id: string
  sessionId: string
  parentId?: string
  role: SessionEntryRole
  content: string
  timestamp: number
  toolCallId?: string
  toolName?: string
  toolCalls?: ToolCall[]
  metadata?: Record<string, unknown>
}

export interface SessionSnapshot {
  info: SessionInfo
  entries: SessionEntry[]
}

export interface PermissionResolver {
  (request: PermissionRequest): Promise<PermissionResolution> | PermissionResolution
}

export interface LLMCompleter {
  complete(
    request: LLMRequest,
    callbacks?: { onTextDelta?: (delta: string) => void },
  ): Promise<LLMResult>
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>
