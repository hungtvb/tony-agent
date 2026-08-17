import { describe, expect, it, vi } from 'vitest'
import { ApprovalProvider } from '../src/approval/provider.js'
import type { PermissionRequest, PermissionResolution, TonyTool } from '../src/types.js'

const tool: TonyTool = {
  name: 'bash',
  description: 'run a command',
  risk: 'risky',
  inputSchema: {} as never,
  parameters: { type: 'object', properties: {} },
  async execute() { return { content: '' } },
}

function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: 'req-1',
    tool,
    arguments: { cmd: 'ls' },
    sessionId: 's1',
    ...overrides,
  }
}

describe('ApprovalProvider', () => {
  it('degrades to deny when no resolver is mounted (fail-closed)', async () => {
    const provider = new ApprovalProvider()
    expect(await provider.resolve(request())).toBe('deny')
  })

  it('uses a custom fallback when no resolver is mounted', async () => {
    const provider = new ApprovalProvider({ fallback: 'allow-once' })
    expect(await provider.resolve(request())).toBe('allow-once')
  })

  it('passes the request through to the resolver', async () => {
    const resolver = vi.fn(async (): Promise<PermissionResolution> => 'allow-session')
    const provider = new ApprovalProvider({ resolver })
    expect(await provider.resolve(request())).toBe('allow-session')
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid resolver outputs with the fallback', async () => {
    const resolver = vi.fn(async () => 'maybe' as never)
    const provider = new ApprovalProvider({ resolver })
    expect(await provider.resolve(request())).toBe('deny')
  })

  it('falls back to deny when the resolver throws', async () => {
    const resolver = vi.fn(async () => { throw new Error('approval ui crashed') })
    const provider = new ApprovalProvider({ resolver })
    expect(await provider.resolve(request())).toBe('deny')
  })

  it('falls back to a configured fallback on resolver error', async () => {
    const resolver = vi.fn(async () => { throw new Error('boom') })
    const provider = new ApprovalProvider({ resolver, fallback: 'allow-once', failClosed: false })
    expect(await provider.resolve(request())).toBe('allow-once')
  })
})