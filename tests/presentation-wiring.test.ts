import { describe, expect, it } from 'vitest'
import { Agent } from '../src/harness/agent.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { usageFromParts } from '../src/llm/model.js'

/**
 * Presentation wiring (ticket t_f6d995d8): ToolPresentation values are now
 * plumbed at runtime — the legacy agent loop passes 'native' into the tool
 * context, and the harness surface projects code-only tools out of the
 * model-visible definitions.
 */

describe('presentation wiring', () => {
  it('registry.definitions({presentation}) filters presentation-aware registries', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'code_tool',
      description: 'code only',
      risk: 'read',
      presentation: 'code' as const,
      inputSchema: undefined as never,
      parameters: { type: 'object' },
      execute: async () => ({ content: 'code' }),
    })
    registry.register({
      name: 'plain_tool',
      description: 'plain',
      risk: 'read',
      inputSchema: undefined as never,
      parameters: { type: 'object' },
      execute: async () => ({ content: 'plain' }),
    })
    const names = (mode: 'native' | 'code') =>
      registry.definitions({ presentation: mode }).map((definition) => definition.function.name)
    expect(names('native')).toEqual(['plain_tool'])
    expect(names('code')).toEqual(['code_tool', 'plain_tool'])
  })

  it('harness Agent hides code-only tools from the model but still executes them', async () => {
    const codes: string[] = []
    const complete = async (request: { tools?: Array<{ function: { name: string } }> }) => {
      const names = request.tools?.map((t) => t.function.name) ?? []
      codes.push(names.join(','))
      return {
        text: 'done',
        toolCalls: [{ id: 'c1', name: 'run_code_hidden', arguments: { code: '1' } }],
        usage: usageFromParts(5, 5),
        stopReason: 'tool_calls',
      }
    }
    const agent = new Agent({
      complete: complete as never,
      tools: new Map([
        ['visible_tool', {
          name: 'visible_tool',
          description: 'visible',
          risk: 'read',
          inputSchema: undefined as never,
          parameters: { type: 'object' },
          execute: async () => ({ content: 'visible' }),
        }],
        ['run_code_hidden', {
          name: 'run_code_hidden',
          description: 'code only',
          risk: 'risky',
          inputSchema: undefined as never,
          parameters: { type: 'object' },
          presentation: 'code' as const,
          execute: async () => ({ content: 'runcode' }),
        }],
      ]),
    })
    const outcome = await agent.run('go')
    expect(outcome.text).toBe('done')
    expect(codes[0]).toBe('visible_tool')
  })

  it('legacy TonyAgent passes presentation native into tool context', async () => {
    const { TonyAgent } = await import('../src/agent.js')
    const { z } = await import('zod')
    const seen: Array<Record<string, unknown>> = []
    const registry = new ToolRegistry()
    registry.register({
      name: 'probe',
      description: 'probe',
      risk: 'read',
      inputSchema: z.object({}),
      parameters: { type: 'object' },
      execute: async (_input: unknown, context: { presentation?: unknown }) => {
        seen.push(context as unknown as Record<string, unknown>)
        return { content: 'ok' }
      },
    })
    const agent = new TonyAgent({
      registry,
      llm: {
        complete: async () => ({
          text: '',
          toolCalls: [{ id: 'c1', name: 'probe', arguments: {} }],
        }),
      },
      permissions: { check: () => 'allow' as const },
    } as never)
    const outcome = agent.run('go')
    const text = await outcome
    expect(text).toBeDefined()
    expect(seen.length).toBe(1)
    expect(seen[0]?.presentation).toBe('native')
  })
})