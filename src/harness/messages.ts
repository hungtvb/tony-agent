import type { SimpleContent, SimpleMessage, SimpleStreamOptions, Usage } from '../llm/model.js'
import type { ToolCall } from '../types.js'
export type AgentMessageKind = 'user' | 'assistant' | 'toolResult' | 'summary' | 'branchSummary'

export interface ToolResultContent {
  toolCallId: string
  name: string
  content: string
  isError?: boolean
}

export interface SummaryContent {
  content: string
  usage?: Usage
}

export type AgentMessageData =
  | { content: string | SimpleContent[] }
  | { content: string | SimpleContent[]; toolCalls: ToolCall[]; usage?: Usage; stopReason?: string }
  | ToolResultContent
  | SummaryContent
  | BranchSummaryContent

export interface BranchSummaryContent {
  content: string
  fromSeq?: number
  usage?: Usage
}

export interface AgentMessage {
  kind: AgentMessageKind
  data: AgentMessageData
}

function isToolResult(data: AgentMessageData): data is ToolResultContent {
  return (data as ToolResultContent).toolCallId !== undefined && (data as ToolResultContent).content !== undefined && (data as ToolResultContent).name !== undefined
}

function isSummary(data: AgentMessageData): data is SummaryContent {
  return (data as SummaryContent).content !== undefined && (data as ToolResultContent).toolCallId === undefined && !Array.isArray((data as { content?: unknown }).content) && typeof (data as { content?: unknown }).content === 'string' && (data as SummaryContent).usage !== undefined
}

function isBranchSummary(data: AgentMessageData): data is BranchSummaryContent {
  return (data as BranchSummaryContent).fromSeq !== undefined && (data as BranchSummaryContent).content !== undefined
}

/**
 * Stateful agent message model mirroring pi-agent-core Entry semantics:
 * user / assistant / toolResult / summary (compaction) / branchSummary (branch).
 */
export const AgentMessage = {
  from(kind: AgentMessageKind, data: AgentMessageData): AgentMessage {
    return { kind, data }
  },

  fromJSON(value: unknown): AgentMessage {
    const parsed = value as Partial<AgentMessage>
    if (parsed && typeof parsed.kind === 'string' && parsed.data !== undefined) {
      return { kind: parsed.kind as AgentMessageKind, data: parsed.data as AgentMessageData }
    }
    throw new Error('Invalid AgentMessage JSON')
  },

  toWire(messages: AgentMessage[]): SimpleMessage[] {
    const wire: SimpleMessage[] = []
    for (const message of messages) {
      switch (message.kind) {
        case 'user': {
          wire.push({ role: 'user', content: (message.data as { content: string | SimpleContent[] }).content })
          break
        }
        case 'assistant': {
          const data = message.data as { content: string | SimpleContent[]; toolCalls: ToolCall[]; usage?: Usage; stopReason?: string }
          const contentParts: SimpleContent[] = []
          if (typeof data.content === 'string') {
            if (data.content.length > 0) contentParts.push({ type: 'text', text: data.content })
          } else {
            contentParts.push(...data.content)
          }
          for (const call of data.toolCalls ?? []) {
            contentParts.push({ type: 'toolCall', id: call.id, name: call.name, arguments: call.arguments })
          }
          const wireMessage: SimpleMessage = { role: 'assistant', content: contentParts }
          if (data.usage) wireMessage.usage = data.usage
          if (data.stopReason) wireMessage.stopReason = data.stopReason as SimpleMessage['stopReason']
          wire.push(wireMessage)
          break
        }
        case 'toolResult': {
          const data = message.data as ToolResultContent
          wire.push({ role: 'toolResult', content: JSON.stringify({ toolCallId: data.toolCallId, name: data.name, content: data.content, isError: data.isError }) })
          break
        }
        case 'summary':
        case 'branchSummary': {
          // summaries are context metadata, not sent to the LLM as conversation turns
          break
        }
      }
    }
    return wire
  },
}
