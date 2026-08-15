import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { TonyAgent } from '../src/agent.js'
import { PermissionPolicy } from '../src/permissions/policy.js'
import { ToolRegistry } from '../src/tools/registry.js'
import type { LLMCompleter, LLMResult, TonyTool } from '../src/types.js'

function tool(name: string, risk: TonyTool['risk'] = 'read'): TonyTool {
  return {
    name,
    description: `Tool ${name}`,
    risk,
    inputSchema: z.object({ value: z.string().optional() }),
    parameters: { type: 'object', properties: { value: { type: 'string' } } },
    execute: async (input) => ({ content: `executed ${name}: ${JSON.stringify(input)}` }),
  }
}

class ScriptedLLM implements LLMCompleter {
  public readonly requests: Array<{ messages: unknown[] }> = []
  private index = 0

  constructor(private readonly responses: LLMResult[]) {}

  async complete(request: { messages: any[] }, callbacks?: { onTextDelta?: (delta: string) => void }): Promise<LLMResult> {
    this.requests.push({ messages: request.messages })
    const response = this.responses[Math.min(this.index++, this.responses.length - 1)]
    if (!response) throw new Error('No scripted response')
    callbacks?.onTextDelta?.(response.text)
    return response
  }
}

describe('TonyAgent', () => {
  it('runs an LLM turn, executes a tool, and returns the follow-up answer', async () => {
    const llm = new ScriptedLLM([
      { text: 'I will inspect the page.', toolCalls: [{ id: 'call-1', name: 'inspect', arguments: {} }] },
      { text: 'The page is ready.', toolCalls: [] },
    ])
    const registry = new ToolRegistry().register(tool('inspect'))
    const events: string[] = []
    const agent = new TonyAgent({
      llm,
      registry,
      permissions: new PermissionPolicy(),
      onEvent: (event) => events.push(event.type),
    })

    const result = await agent.run('Inspect the current page')

    expect(result.text).toBe('The page is ready.')
    expect(result.turns).toBe(2)
    expect(result.toolCalls).toBe(1)
    expect(events).toEqual([
      'agent_start', 'turn_start', 'message_update', 'tool_call', 'tool_result', 'turn_end',
      'turn_start', 'message_update', 'turn_end', 'agent_end',
    ])
    expect(llm.requests[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', content: 'executed inspect: {}', toolCallId: 'call-1' }),
    ]))
  })

  it('pauses risky tools for confirmation and auto-denies without a resolver', async () => {
    const llm = new ScriptedLLM([
      { text: 'I will click it.', toolCalls: [{ id: 'call-1', name: 'click', arguments: {} }] },
      { text: 'I could not click it.', toolCalls: [] },
    ])
    const registry = new ToolRegistry().register(tool('click', 'risky'))
    const result = await new TonyAgent({
      llm,
      registry,
      permissions: new PermissionPolicy(),
    }).run('Click the button')

    expect(result.text).toBe('I could not click it.')
    expect(llm.requests[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', content: expect.stringContaining('Permission denied') }),
    ]))
  })

  it('uses an allow-session permission once granted by the host', async () => {
    const llm = new ScriptedLLM([
      { text: 'Clicking.', toolCalls: [{ id: 'call-1', name: 'click', arguments: {} }] },
      { text: 'Clicked.', toolCalls: [] },
    ])
    const registry = new ToolRegistry().register(tool('click', 'risky'))
    const permissionEvents: string[] = []
    const result = await new TonyAgent({
      llm,
      registry,
      permissions: new PermissionPolicy(),
      resolvePermission: () => 'allow-session',
      onEvent: (event) => {
        if (event.type === 'permission_request') permissionEvents.push(event.request.tool.name)
      },
    }).run('Click the button')

    expect(result.text).toBe('Clicked.')
    expect(permissionEvents).toEqual(['click'])
  })

  it('stops a repeated tool loop at the configured turn limit', async () => {
    const llm = new ScriptedLLM([
      { text: 'Again.', toolCalls: [{ id: 'call-1', name: 'inspect', arguments: {} }] },
    ])
    const result = await new TonyAgent({
      llm,
      registry: new ToolRegistry().register(tool('inspect')),
      permissions: new PermissionPolicy(),
      limits: { maxTurns: 3 },
    }).run('Keep inspecting')

    expect(result.turns).toBe(3)
    expect(result.text).toContain('turn limit')
  })
})

// Tests precede the agent implementation: the first run must fail because
// TonyAgent does not exist yet.
