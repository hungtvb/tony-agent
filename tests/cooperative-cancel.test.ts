import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Agent } from '../src/harness/agent.js'
import { usageFromParts } from '../src/llm/model.js'

/**
 * Cooperative cancellation: ToolContext.signal is created per agent run;
 * agent.abort() aborts mid-tool-call, and a tool listening to its signal
 * returns promptly — no hang, no lingering run.
 */

function makeHangingTool(detachDeadline = 2_500): { tool: Parameters<ConstructorParameters<typeof Agent>[0]['complete']>; wake: () => void } {
  return { tool: undefined as never, wake: () => {} }
}

describe('cooperative cancellation', () => {
  it('abort mid-run aborts the run signal and reports aborted outcome', async () => {
    let toolSignal: AbortSignal | undefined
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const complete = async (): Promise<{ text: string; stopReason: 'tool_calls'; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }> => {
      return { text: '', stopReason: 'tool_calls', toolCalls: [{ id: 'c1', name: 'slow_tool', arguments: {} }] }
    }
    const agent = new Agent({
      complete,
      tools: new Map([[
        'slow_tool',
        {
          name: 'slow_tool',
          description: 'slow',
          risk: 'read',
          inputSchema: undefined as never,
          parameters: { type: 'object' },
          async execute(_input: unknown, context: { signal?: AbortSignal }) {
            toolSignal = context.signal
            await gate
            return { content: 'slow done' }
          },
        },
      ]]),
    })
    const outcomePromise = agent.run('go')
    // wait for the tool call to start
    await new Promise((resolve) => setTimeout(resolve, 30))
    agent.abort()
    // abortSignal() polls this.aborted every 50ms — give it a tick to fire
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(toolSignal?.aborted).toBe(true)
    await release!()
    const outcome = await outcomePromise
    expect(outcome.aborted).toBe(true)
  })

  it('registry.execute passes the run signal into the tool context', async () => {
    const { ToolRegistry } = await import('../src/tools/registry.js')
    const registry = new ToolRegistry()
    let contextSignal: AbortSignal | undefined
    registry.register({
      name: 'probe',
      description: 'probe signal',
      risk: 'read',
      inputSchema: z.object({}),
      parameters: { type: 'object' },
      async execute(_input: unknown, context: { signal?: AbortSignal }) {
        contextSignal = context.signal
        return { content: 'probed' }
      },
    })
    const controller = new AbortController()
    await registry.execute('probe', {}, { signal: controller.signal, sessionId: 's1', metadata: {} })
    expect(contextSignal).toBe(controller.signal)
  })

  it('run_code tool aborts promptly when the context signal fires', async () => {
    const { createWorkerThreadRuntime } = await import('../src/code-runtime/worker-thread.js')
    const { createRunCodeTool } = await import('../src/code-runtime/tool.js')
    const tool = createRunCodeTool(createWorkerThreadRuntime())
    const controller = new AbortController()
    const started = Date.now()
    const pending = tool.execute(
      { code: 'while(true) {}', timeoutMs: 60_000 },
      { signal: controller.signal, sessionId: 's2' },
    )
    // abort after the worker has started the infinite loop
    await new Promise((resolve) => setTimeout(resolve, 60))
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Aborted')
    expect(Date.now() - started).toBeLessThan(2_500)
  })
})