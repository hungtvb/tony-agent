import { describe, it, expect } from 'vitest'
import { ToolRegistry } from '../src/tools/registry.js'
import { z } from 'zod'

describe('ToolRegistry inputSchema hardening (safeParse crash fix)', () => {
  const ctx = { sessionId: 's', metadata: {}, signal: undefined as AbortSignal | undefined }

  it('executing a tool with a missing inputSchema fails cleanly, not crash', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'broken',
      description: 'tool with no schema',
      risk: 'read',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { content: 'should not run' }
      },
    } as never)
    const result = await registry.execute('broken', {}, { ...ctx, signal: undefined })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('not configured')
  })

  it('tools with zod schemas validate input before execution', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'echo',
      description: 'echo',
      risk: 'read',
      inputSchema: z.object({ text: z.string().min(1) }).strict(),
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      async execute(input: { text: string }) {
        return { content: input.text }
      },
    })
    const ok = await registry.execute('echo', { text: 'hi' }, { ...ctx, signal: undefined })
    expect(ok.content).toBe('hi')
    expect(ok.isError).not.toBe(true)
    const bad = await registry.execute('echo', { text: 42 }, { ...ctx, signal: undefined })
    expect(bad.isError).toBe(true)
    expect(bad.content).toContain('Invalid arguments')
  })
})