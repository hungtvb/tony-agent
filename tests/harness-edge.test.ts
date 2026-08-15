import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentHarness } from '../src/harness/agent-harness.js'
import { JsonlSessionRepo } from '../src/harness/session/jsonl/repo.js'
import { Agent, type AgentHooks } from '../src/harness/agent.js'
import { AgentMessage } from '../src/harness/messages.js'
import type { SimpleResult } from '../src/llm/model.js'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'harness-edge2-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})
const okComplete = async (): Promise<SimpleResult> => ({ text: 'reply', toolCalls: [], usage: undefined, stopReason: 'stop' })

describe('AgentHarness strict review regressions', () => {
  it('BUG14-HARD: transcriptFromEntries preserves ROLE (assistant stays assistant, not user)', async () => {
    const dir = await tempDir()
    const repo = new JsonlSessionRepo(dir)
    const session = await repo.create('s')
    await session.append({ seq: 1, parentId: 0, timestamp: Date.now(), kind: 'message', message: { role: 'user', content: 'hi' } })
    await session.append({ seq: 2, parentId: 1, timestamp: Date.now(), kind: 'message', message: { role: 'assistant', content: 'hello' } })
    // capture what wire messages the LLM would see after resume
    let seenMessages: unknown = null
    const agent = new Agent({
      complete: async (req) => { seenMessages = req.messages.map((m) => m.role); return { text: '', toolCalls: [], usage: undefined, stopReason: 'stop' } },
      sessionId: 's',
    })
    const harness = new AgentHarness({
      repo,
      complete: async () => ({ text: '', toolCalls: [], usage: undefined, stopReason: 'stop' }),
      sessionId: 's',
      makeAgent: (c, hooks) => agent,
    })
    await harness.resume('again')
    // the LLM must see a user + assistant + new user — not 3 flattened 'user' roles
    const roles = seenMessages as unknown[]
    expect(roles).toContain('assistant')
  })

  it('BUG13-HARD: resume replaces the agent transcript even when an agent instance already exists', async () => {
    const dir = await tempDir()
    const repo = new JsonlSessionRepo(dir)
    const captured: string[][] = []
    const agent = new Agent({
      complete: async (req) => {
        captured.push(req.messages.map((m) => `${m.role}:${typeof m.content === 'string' ? m.content : ''}`))
        return { text: '', toolCalls: [], usage: undefined, stopReason: 'stop' }
      },
      sessionId: 's',
    })
    const harness = new AgentHarness({
      repo,
      complete: async () => ({ text: '', toolCalls: [], usage: undefined, stopReason: 'stop' }),
      sessionId: 's',
      makeAgent: () => agent,
    })
    await harness.run({ input: 'first ask' })
    // same harness, resume again — transcript must carry over from the (only) persisted user msg
    await harness.resume('second ask')
    const last = captured.at(-1)!
    expect(last.some((m) => m.includes('first ask'))).toBe(true)
  })
})