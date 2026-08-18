import { describe, expect, it, vi } from 'vitest'
import { ToolCallWaterfall, runWithWaterfall, type WaterfallDecision } from '../src/events/waterfall.js'
import type { ToolCall } from '../src/types.js'

const call: ToolCall = { id: 'c1', name: 'bash', arguments: { cmd: 'ls' } }

describe('ToolCallWaterfall', () => {
  it('runs middlewares in order and allows by default', async () => {
    const waterfall = new ToolCallWaterfall()
    const order: string[] = []
    waterfall.use(async (_ctx, next) => { order.push('a'); await next(); order.push('a-done') })
    waterfall.use(async (_ctx, next) => { order.push('b'); await next() })
    const outcome = await waterfall.run({ sessionId: 's', call })
    expect(outcome.decision).toBe('allow')
    expect(order).toEqual(['a', 'b', 'a-done'])
  })

  it('merges deny > ask > allow (most restrictive wins)', async () => {
    const waterfall = new ToolCallWaterfall()
    waterfall.use(async (ctx, next): Promise<WaterfallDecision> => { await next(); return 'allow' })
    waterfall.use(async (ctx, next): Promise<WaterfallDecision> => { await next(); return 'ask' })
    waterfall.use(async (): Promise<WaterfallDecision> => 'deny')
    const outcome = await waterfall.run({ sessionId: 's', call })
    expect(outcome.decision).toBe('deny')
    expect(outcome.reason).toBeDefined()
  })

  it('a later deny overrides an earlier allow', async () => {
    const waterfall = new ToolCallWaterfall()
    waterfall.use(async (ctx, next): Promise<WaterfallDecision> => { await next(); return 'allow' })
    waterfall.use(async (): Promise<WaterfallDecision> => 'deny')
    const outcome = await waterfall.run({ sessionId: 's', call })
    expect(outcome.decision).toBe('deny')
  })

  it('fail-closed: a throwing middleware denies', async () => {
    const waterfall = new ToolCallWaterfall()
    waterfall.use(async () => { throw new Error('mw crash') })
    const outcome = await waterfall.run({ sessionId: 's', call })
    expect(outcome.decision).toBe('deny')
  })

  it('does not fail closed when failClosed:false', async () => {
    const waterfall = new ToolCallWaterfall({ failClosed: false })
    waterfall.use(async () => { throw new Error('mw crash') })
    const outcome = await waterfall.run({ sessionId: 's', call })
    expect(outcome.decision).toBe('allow')
  })

  it('unregister removes a middleware', async () => {
    const waterfall = new ToolCallWaterfall()
    const deny = waterfall.use(async () => 'deny')
    deny()
    const outcome = await waterfall.run({ sessionId: 's', call })
    expect(outcome.decision).toBe('allow')
  })

  it('dispose denies new runs immediately', async () => {
    const waterfall = new ToolCallWaterfall()
    await waterfall.dispose()
    const outcome = await waterfall.run({ sessionId: 's', call })
    expect(outcome.decision).toBe('deny')
  })

  it('dispose waits for in-flight runs to settle (quiescence)', async () => {
    const waterfall = new ToolCallWaterfall()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    waterfall.use(async (ctx, next) => { await gate; await next() })
    const running = waterfall.run({ sessionId: 's', call })
    const disposePromise = waterfall.dispose()
    let disposed = false
    disposePromise.then(() => { disposed = true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(disposed).toBe(false)
    release()
    await disposePromise
    expect(disposed).toBe(true)
  })
})

describe('runWithWaterfall', () => {
  it('executes when allowed', async () => {
    const waterfall = new ToolCallWaterfall()
    const executed = vi.fn(async () => ({ content: 'ran' }))
    const result = await runWithWaterfall(waterfall, call, 's', executed)
    expect(executed).toHaveBeenCalledTimes(1)
    expect(result.content).toBe('ran')
  })

  it('denies without executing when middleware denies', async () => {
    const waterfall = new ToolCallWaterfall()
    waterfall.use(async () => 'deny')
    const executed = vi.fn(async () => ({ content: 'ran' }))
    const result = await runWithWaterfall(waterfall, call, 's', executed)
    expect(executed).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Permission denied')
  })
})
describe('WaterfallStepper persistence', () => {
  const call: ToolCall = { id: 'c2', name: 'read', arguments: {} }

  it('records every step into a memory sink', async () => {
    const waterfall = new ToolCallWaterfall()
    waterfall.use(async (_ctx, next) => { await next() })
    waterfall.use(async (_ctx, next) => { await next() })
    const sink = new (await import('../src/events/waterfall.js')).MemoryTrailSink()
    const stepper = new (await import('../src/events/waterfall.js')).WaterfallStepper(waterfall, sink)
    const { outcome, steps } = await stepper.run({ sessionId: 's', call })
    expect(outcome.decision).toBe('allow')
    expect(steps).toHaveLength(2)
    expect(sink.records).toHaveLength(2)
    expect(steps[0]?.toolName).toBe('read')
    expect(steps[0]?.sessionId).toBe('s')
  })

  it('persists steps into a session store sink', async () => {
    const waterfall = new ToolCallWaterfall()
    waterfall.use(async (_ctx, next) => { await next() })
    const appended: unknown[] = []
    const { SessionTrailSink, WaterfallStepper } = await import('../src/events/waterfall.js')
    const stepper = new WaterfallStepper(waterfall, new SessionTrailSink(async (entry) => { appended.push(entry) }))
    await stepper.run({ sessionId: 's', call })
    expect(appended).toHaveLength(1)
    const entry = appended[0] as { customType?: string; payload?: unknown }
    expect(entry.customType).toBe('waterfall_step')
    expect((entry.payload as { toolName?: string })?.toolName).toBe('read')
  })

  it('records deny decisions', async () => {
    const waterfall = new ToolCallWaterfall()
    waterfall.use(async () => 'deny' as WaterfallDecision)
    const sink = new (await import('../src/events/waterfall.js')).MemoryTrailSink()
    const stepper = new (await import('../src/events/waterfall.js')).WaterfallStepper(waterfall, sink)
    const { outcome } = await stepper.run({ sessionId: 's', call })
    expect(outcome.decision).toBe('deny')
    expect(sink.records[0]?.decision).toBe('deny')
  })
})
