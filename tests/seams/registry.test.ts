import { describe, it, expect } from 'vitest'
import { ServiceRegistry } from '../../src/seams/registry.js'
import type { ServiceDefinition, ServiceProvider, ServiceConsumer } from '../../src/seams/types.js'
import { z } from 'zod'

const llmDef: ServiceDefinition = { id: 'llm', schema: z.any() }
const fsDef: ServiceDefinition = { id: 'fs', schema: z.any() }

const localProvider: ServiceProvider<{ kind: 'local' }> = {
  definition: llmDef,
  name: 'local',
  create: () => ({ kind: 'local' }),
}

describe('ServiceRegistry', () => {
  it('registers a provider and resolves its instance', () => {
    const reg = new ServiceRegistry()
    const unregister = reg.register(localProvider)
    expect(reg.has('llm')).toBe(true)
    expect(reg.resolve<{ kind: 'local' }>('llm').kind).toBe('local')
    expect(reg.resolve<{ kind: 'local' }>('llm').kind).toBe('local') // cached
    unregister()
    expect(reg.has('llm')).toBe(false)
  })

  it('fails closed when no provider is mounted', () => {
    const reg = new ServiceRegistry()
    expect(() => reg.resolve('llm')).toThrow(/no provider/i)
  })

  it('rejects a second provider for the same definition (one active provider)', () => {
    const reg = new ServiceRegistry()
    reg.register(localProvider)
    expect(() => reg.register({
      definition: llmDef,
      name: 'other',
      create: () => ({ kind: 'other' }),
    })).toThrow(/already/)
  })

  it('consumer wraps a resolved service into tools', () => {
    const reg = new ServiceRegistry()
    reg.register(localProvider)
    const consumer: ServiceConsumer<{ kind: 'local' }> = {
      definition: llmDef,
      uses: (svc) => ({
        name: 'llm_info',
        description: 'Describe the mounted LLM service',
        risk: 'read' as const,
        inputSchema: z.object({}),
        parameters: { type: 'object', properties: {} },
        execute: () => ({ content: `kind=${svc.kind}` }),
      }),
    }
    const tools = reg.consume('llm', consumer)
    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe('llm_info')
  })

  it('registers multiple definitions independently', () => {
    const reg = new ServiceRegistry()
    reg.register(localProvider)
    reg.register({
      definition: fsDef,
      name: 'local-fs',
      create: () => ({ kind: 'fs-local' }),
    })
    expect(reg.definitions().sort()).toEqual(['fs', 'llm'])
  })
})