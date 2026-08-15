import type { LLMMessage, LLMToolDefinition } from '../types.js'

/** Conservative, provider-independent token estimate used only for local budgets. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

export function estimateMessageTokens(messages: LLMMessage[]): number {
  return messages.reduce((total, message) => {
    const toolCalls = message.toolCalls?.map((call) => `${call.name}${JSON.stringify(call.arguments)}`).join('') ?? ''
    return total + 4 + estimateTokens(message.role + message.content + toolCalls)
  }, 0)
}

export function estimateToolTokens(tools: LLMToolDefinition[]): number {
  return tools.reduce((total, tool) => total + estimateTokens(JSON.stringify(tool)) + 8, 0)
}
