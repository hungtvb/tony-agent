import { describe, expect, it, vi } from 'vitest'
import { ToolScope } from '../src/tools/scope.js'
import { Agent } from '../src/harness/agent.js'
import type { SimpleMessage, SimpleResult, ToolDefinition } from '../src/llm/model.js'
import type { ToolCall, TonyTool, RiskLevel } from '../src/types.js'
import type { ToolResultContent } from '../src/harness/messages.js'

function makeTool(name: string, risk: RiskLevel = 'read'): TonyTool {
  return {
    name,
    description: `tool ${name}`,
    risk,
    inputSchema: {} as never,
    parameters: { type: 'object', properties: {} },
    async execute() {
      return { content: `ran ${name}` }
    },
  }
}

describe('ToolScope', () => {
  const globalTools = new Map<string, TonyTool>([
    ['bash', makeTool('bash', 'risky')],
    ['read', makeTool('read')],
    ['write', makeTool('write')],
  ])

  it('hides everything by default (fail-closed: nothing visible unless allowed)', () => {
    const scope = new ToolScope()
    const filtered = scope.filter(Array.from(globalTools))
    expect(filtered).toEqual([])
    expect(scope.has('bash')).toBe(false)
    expect(scope.resolve('bash', (n) => globalTools.get(n))).toBeUndefined()
  })

  it('allow exposes a specific tool from the global map', () => {
    const scope = new ToolScope().allow('read')
    const filtered = scope.filter(Array.from(globalTools))
    expect(filtered.map(([name]) => name)).toEqual(['read'])
    expect(scope.resolve('read', (n) => globalTools.get(n))).toBe(globalTools.get('read'))
  })

  it('deny wins over allow (most-restrictive merge)', () => {
    const scope = new ToolScope().allow('bash').deny('bash')
    expect(scope.has('bash')).toBe(false)
    expect(scope.filter(Array.from(globalTools))).toEqual([])
  })

  it('shadow replaces the implementation under the same name', () => {
    const fake = makeTool('bash', 'risky')
    const scope = new ToolScope().allow('bash').shadow('bash', fake)
    const filtered = scope.filter(Array.from(globalTools))
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.[0]).toBe('bash')
    expect(filtered[0]?.[1]).toBe(fake)
    expect(scope.resolve('bash', (n) => globalTools.get(n))).toBe(fake)
  })

  it('does not mutate the global map', () => {
    const scope = new ToolScope().deny('bash')
    expect(globalTools.has('bash')).toBe(true)
    expect(scope.has('bash')).toBe(false)
  })
})

describe('Agent with ToolScope', () => {
  const bash = makeTool('bash', 'risky')
  const read = makeTool('read')
  const tools = new Map<string, TonyTool>([
    ['bash', bash],
    ['read', read],
  ])

  /** Returns toolCalls on the FIRST completion, then a plain text turn so the loop terminates. */
  function completerOnce(calls: ToolCall[]): ReturnType<typeof vi.fn> {
    let first = true
    return vi.fn(async (req: { messages: SimpleMessage[]; tools?: ToolDefinition[] }, _opts: unknown): Promise<SimpleResult> => {
      if (first) {
        first = false
        return { text: '', toolCalls: calls, stopReason: 'tool_calls' }
      }
      return { text: 'done', toolCalls: [], stopReason: 'end_turn' }
    })
  }

  function lastToolResult(agent: Agent): ToolResultContent | undefined {
    const msgs = agent.getTranscript()
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m?.kind === 'toolResult') return m.data as ToolResultContent
    }
    return undefined
  }

  it('hides denied tools from the LLM (not in tool definitions)', async () => {
    const scope = new ToolScope().allow('read')
    const complete = completerOnce([{ id: 'c1', name: 'read', arguments: {} }])
    const agent = new Agent({ complete, tools, scope })
    await agent.run('go')
    const req = complete.mock.calls[0]?.[0]
    expect(req.tools?.map((t) => t.function.name)).toEqual(['read'])
  })

  it('denies execution of a hidden tool with Unknown tool error', async () => {
    const scope = new ToolScope().allow('read')
    const complete = completerOnce([{ id: 'c1', name: 'bash', arguments: {} }])
    const agent = new Agent({ complete, tools, scope })
    await agent.run('go')
    const result = lastToolResult(agent)
    expect(result?.content).toContain('Unknown tool: bash')
  })

  it('runs the shadowed implementation instead of the global one', async () => {
    const fakeBash = makeTool('bash', 'light')
    const fakeExecute = vi.fn(async () => ({ content: 'shadowed bash' }))
    fakeBash.execute = fakeExecute
    const scope = new ToolScope().allow('bash').shadow('bash', fakeBash)
    const complete = completerOnce([{ id: 'c1', name: 'bash', arguments: {} }])
    const agent = new Agent({ complete, tools, scope })
    await agent.run('go')
    expect(fakeExecute).toHaveBeenCalledTimes(1)
    expect(lastToolResult(agent)?.content).toBe('shadowed bash')
  })

  it('without a scope the agent sees and runs all tools (backward compat)', async () => {
    const complete = completerOnce([{ id: 'c1', name: 'read', arguments: {} }])
    const agent = new Agent({ complete, tools })
    await agent.run('go')
    const req = complete.mock.calls[0]?.[0]
    expect(req.tools?.map((t) => t.function.name)).toEqual(['bash', 'read'])
  })
})
