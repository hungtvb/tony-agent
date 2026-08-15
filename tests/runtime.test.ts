import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { TonyRuntime } from '../src/runtime.js'
import { SessionStore } from '../src/session/store.js'
import { PermissionPolicy } from '../src/permissions/policy.js'
import { ToolRegistry } from '../src/tools/registry.js'
import type { LLMCompleter, LLMResult, TonyTool } from '../src/types.js'

const directories: string[] = []

class ScriptedLLM implements LLMCompleter {
  readonly requests: Array<{ messages: Array<{ role: string; content: string }> }> = []
  private index = 0

  constructor(private readonly responses: LLMResult[]) {}

  async complete(request: { messages: Array<{ role: string; content: string }> }): Promise<LLMResult> {
    this.requests.push({ messages: request.messages })
    const response = this.responses[Math.min(this.index++, this.responses.length - 1)]
    if (!response) throw new Error('No scripted response')
    return response
  }
}

function inspectTool(): TonyTool {
  return {
    name: 'inspect',
    description: 'Inspect the current context.',
    risk: 'read',
    inputSchema: z.object({}).strict(),
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: 'inspection complete' }),
  }
}

async function createStore(): Promise<SessionStore> {
  const directory = await mkdtemp(join(tmpdir(), 'tony-runtime-'))
  directories.push(directory)
  const store = new SessionStore(directory)
  await store.initialize()
  return store
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('TonyRuntime', () => {
  it('persists a complete user/tool/assistant turn and restores it', async () => {
    const store = await createStore()
    const llm = new ScriptedLLM([
      { text: 'Inspecting.', toolCalls: [{ id: 'call-1', name: 'inspect', arguments: {} }] },
      { text: 'Inspection complete.', toolCalls: [] },
    ])
    const registry = new ToolRegistry().register(inspectTool())
    const runtime = new TonyRuntime({ store, llm, registry, permissions: new PermissionPolicy() })
    const session = await runtime.createSession('Research')

    const result = await session.ask('Inspect this')
    const entries = await store.readEntries(session.id)

    expect(result.text).toBe('Inspection complete.')
    expect(entries.map((entry) => entry.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(entries[2]?.content).toBe('inspection complete')

    const restored = await runtime.openSession(session.id)
    expect(restored.history().map((message) => message.content)).toContain('Inspect this')
    await restored.ask('Continue')
    expect(llm.requests.at(-1)?.messages.map((message) => message.content)).toContain('Inspect this')
  })

  it('creates an independent branch with the selected conversation history', async () => {
    const store = await createStore()
    const llm = new ScriptedLLM([{ text: 'Done.', toolCalls: [] }])
    const runtime = new TonyRuntime({ store, llm, registry: new ToolRegistry(), permissions: new PermissionPolicy() })
    const session = await runtime.createSession('Main')
    await session.ask('First question')
    const branch = await session.branch('Alternative')

    expect(branch.id).not.toBe(session.id)
    expect(branch.history().map((message) => message.content)).toContain('First question')
    await branch.ask('Second question')
    expect((await store.readEntries(session.id)).map((entry) => entry.content)).not.toContain('Second question')
  })
})
