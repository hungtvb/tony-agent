import { describe, expect, it } from 'vitest'
import { Agent } from '../src/harness/agent.js'
import { ApprovalProvider } from '../src/approval/provider.js'
import type { SimpleMessage, SimpleResult, ToolDefinition } from '../src/llm/model.js'
import type { AgentMessage } from '../src/harness/messages.js'

function riskyTool(name = 'bash') {
  return {
    name,
    description: 'run a command',
    risk: 'risky' as const,
    inputSchema: {} as never,
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(input: { cmd?: string }) {
      return { content: `executed: ${input?.cmd ?? ''}` }
    },
  }
}

function safeTool(name = 'read') {
  return {
    name,
    description: 'read a file',
    risk: 'read' as const,
    inputSchema: {} as never,
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      return { content: 'file content' }
    },
  }
}

function completeWith(toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>, finalText = 'done') {
  return async (_request: { messages: SimpleMessage[]; tools?: ToolDefinition[] }): Promise<SimpleResult> => {
    return { text: finalText, toolCalls, stopReason: 'stop' }
  }
}

describe('Agent approval seam', () => {
  it('denies risky tools when no approval provider is mounted (fail-closed)', async () => {
    const tools = new Map([['bash', riskyTool()] as const])
    const agent = new Agent({
      complete: completeWith([{ id: 'c1', name: 'bash', arguments: { cmd: 'rm -rf /' } }]),
      tools,
      sessionId: 's1',
    })
    const outcome = await agent.run('run it')
    expect(outcome.text).toBeTruthy()
    const transcript = agent.getTranscript()
    const denied = transcript.find((m) => m.kind === 'toolResult' && (m.data as { content?: string }).content?.includes('Permission denied'))
    expect(denied).toBeDefined()
  })

  it('allows risky tools when approval resolves allow-once', async () => {
    const tools = new Map([['bash', riskyTool()] as const])
    const approval = new ApprovalProvider({ resolver: async (): Promise<'allow-once'> => 'allow-once' })
    const agent = new Agent({
      complete: completeWith([{ id: 'c2', name: 'bash', arguments: { cmd: 'ls' } }]),
      tools,
      sessionId: 's2',
      approval,
    })
    await agent.run('run it')
    const transcript = agent.getTranscript()
    const executed = transcript.find((m) => m.kind === 'toolResult' && (m.data as { content?: string }).content?.includes('executed:'))
    expect(executed).toBeDefined()
  })

  it('allows read tools without approval (not risky)', async () => {
    const tools = new Map([['read', safeTool()] as const])
    const agent = new Agent({
      complete: completeWith([{ id: 'c3', name: 'read', arguments: {} }]),
      tools,
      sessionId: 's3',
    })
    await agent.run('read it')
    const transcript = agent.getTranscript()
    const executed = transcript.find((m) => m.kind === 'toolResult' && (m.data as { content?: string }).content === 'file content')
    expect(executed).toBeDefined()
  })

  it('does not execute the tool after a deny', async () => {
    let executions = 0
    const tool = {
      ...riskyTool('bash'),
      async execute() { executions += 1; return { content: 'x' } },
    }
    const tools = new Map([['bash', tool] as const])
    const agent = new Agent({
      complete: completeWith([{ id: 'c4', name: 'bash', arguments: {} }]),
      tools,
      sessionId: 's4',
    })
    await agent.run('run it')
    expect(executions).toBe(0)
  })
})