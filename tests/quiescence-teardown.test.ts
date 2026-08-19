import { describe, expect, it } from 'vitest'
import { ServiceRegistry } from '../src/seams/registry.js'
import type { ServiceConsumer, ServiceProvider } from '../src/seams/types.js'
import { z } from 'zod'
import type { TonyTool } from '../src/types.js'

/**
 * Quiescence teardown (ticket t_99d974cd): ServiceRegistry.dispose() waits
 * for in-flight service calls (registered via withActive) to settle, bounded
 * by maxWaitMs; after dispose, new withActive calls fail closed.
 */

const def = { id: 'test-svc', schema: z.object({}) }

const provider: ServiceProvider<{ run(): Promise<string> }> = {
  definition: def,
  name: 'local',
  create: () => ({
    run: async () => 'ok',
  }),
}

describe('ServiceRegistry quiescence teardown', () => {
  it('dispose waits for in-flight calls to settle (bounded)', async () => {
    const registry = new ServiceRegistry()
    registry.register(provider)
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const call = registry.withActive(
      new Promise<string>((resolve) => {
        gate.then(() => resolve('done'))
      }),
    )
    expect(registry.pendingCount).toBe(1)
    const disposePromise = registry.dispose({ maxWaitMs: 5000 })
    let disposed = false
    disposePromise.then(() => { disposed = true })
    // give dispose a beat — it must NOT resolve while the call is pending
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(disposed).toBe(false)
    release!()
    const [result] = await Promise.all([call, disposePromise])
    expect(result).toBe('done')
    expect(disposed).toBe(true)
  })

  it('dispose gives up after maxWaitMs and resolves anyway', async () => {
    const registry = new ServiceRegistry()
    registry.register(provider)
    // a call that never settles
    registry.withActive(new Promise<string>(() => {}))
    const started = Date.now()
    await registry.dispose({ maxWaitMs: 80 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(70)
    expect(registry.pendingCount).toBe(1) // still pending — we gave up
  })

  it('after dispose, withActive fails closed', async () => {
    const registry = new ServiceRegistry()
    registry.register(provider)
    await registry.dispose()
    await expect(registry.withActive(Promise.resolve('x'))).rejects.toThrow(/disposed/i)
  })

  it('registered consumers still work through the registry after a dispose-free lifecycle', async () => {
    const registry = new ServiceRegistry()
    registry.register(provider)
    const consumer: ServiceConsumer<{ run(): Promise<string> }> = {
      definition: def,
      uses(service): TonyTool[] {
        return [{
          name: 'svc_run',
          description: 'run',
          risk: 'read',
          inputSchema: undefined as never,
          parameters: { type: 'object' },
          async execute() {
            return { content: await service.run() }
          },
        }]
      },
    }
    const tools = registry.consume('test-svc', consumer)
    expect(tools[0]?.name).toBe('svc_run')
    expect(registry.pendingCount).toBe(0)
  })
})