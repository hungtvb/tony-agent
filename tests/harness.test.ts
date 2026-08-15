import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentHarness, type HarnessOptions } from '../src/harness/agent-harness.js'
import { Agent } from '../src/harness/agent.js'
import { JsonlSessionRepo } from '../src/harness/session/jsonl/repo.js'
import { createEntry } from '../src/harness/session/types.js'
import type { SimpleResult, SimpleStreamOptions } from '../src/llm/model.js'

const directories: string[] = []
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tony-harness-'))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function scriptedComplete(stepCount: number): (request: { messages: unknown[] }, options: SimpleStreamOptions) => Promise<SimpleResult> {
  let turn = 0
  return async () => {
    turn += 1
    if (turn < stepCount) {
      return { text: `step ${turn}`, toolCalls: [], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }, stopReason: 'stop' }
    }
    return { text: `final ${turn}`, toolCalls: [], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }, stopReason: 'stop' }
  }
}

describe('AgentHarness', () => {
  it('creates a lane and runs a prompt, persisting transcript to the session', async () => {
    const directory = await tempDir()
    const repo = new JsonlSessionRepo(directory)
    const harness = new AgentHarness({ repo, complete: scriptedComplete(1), sessionId: 'primary' })
    const outcome = await harness.run({ input: 'hello' })
    expect(outcome.text).toContain('final')
    const entries = repo.open ? await (await repo.open('primary')).getEntries() : []
    expect(entries.length).toBeGreaterThan(0)
  })

  it('replays the session after crash and resumes from the tail', async () => {
    const directory = await tempDir()
    const repo = new JsonlSessionRepo(directory)
    // simulate a crash: session already has entries
    const session = await repo.create('crashy')
    await session.append(createEntry({ seq: 1, parentId: 0, kind: 'message', message: { role: 'user', content: 'pre-crash prompt' } }))
    await session.append(createEntry({ seq: 2, parentId: 1, kind: 'message', message: { role: 'assistant', content: 'pre-crash response', usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8 } } }))

    const harness = new AgentHarness({ repo, complete: scriptedComplete(1), sessionId: 'crashy' })
    const outcome = await harness.resume('continue')
    expect(outcome.text).toContain('final')
    const reopened = await repo.open('crashy')
    const entries = reopened.getEntries()
    expect(entries.length).toBeGreaterThanOrEqual(4)
  })

  it('navigates creating a branch optionally summarizing the parent', async () => {
    const directory = await tempDir()
    const repo = new JsonlSessionRepo(directory)
    const session = await repo.create('navig8')
    await session.append(createEntry({ seq: 1, parentId: 0, kind: 'message', message: { role: 'user', content: 'a' } }))
    await session.append(createEntry({ seq: 2, parentId: 1, kind: 'message', message: { role: 'assistant', content: 'b' } }))

    const harness = new AgentHarness({ repo, complete: scriptedComplete(1), sessionId: 'navig8' })
    const branch = await harness.navigate('navig8-branch', 1, { summarize: true })
    const branchEntries = branch.getEntries()
    // head (seq 1) + branch_summary entry
    expect(branchEntries.some((entry) => entry.kind === 'branch_summary')).toBe(true)
    const parentEntries = session.getEntries()
    expect(parentEntries).toHaveLength(2)
  })

  it('compacts a session manually', async () => {
    const directory = await tempDir()
    const repo = new JsonlSessionRepo(directory)
    const session = await repo.create('compactor')
    for (let i = 1; i <= 8; i += 1) {
      await session.append(createEntry({ seq: i, parentId: i - 1, kind: 'message', message: { role: 'user', content: `m${i}` } }))
    }
    const harness = new AgentHarness({ repo, complete: scriptedComplete(1), sessionId: 'compactor' })
    const result = await harness.compact('summarized everything', { retainedTail: 2 })
    expect(result).toBeTruthy()
    const after = await repo.open('compactor')
    const entries = after.getEntries()
    expect(entries.length).toBeGreaterThanOrEqual(8)
    expect(entries.some((entry) => entry.kind === 'compaction')).toBe(true)
  })

  it('exports a session snapshot with role filtering', async () => {
    const directory = await tempDir()
    const repo = new JsonlSessionRepo(directory)
    const session = await repo.create('exporter')
    await session.append(createEntry({ seq: 1, parentId: 0, kind: 'message', message: { role: 'user', content: 'q' } }))
    await session.append(createEntry({ seq: 2, parentId: 1, kind: 'message', message: { role: 'assistant', content: 'a' } }))
    const harness = new AgentHarness({ repo, complete: scriptedComplete(1), sessionId: 'exporter' })
    const snapshot = await harness.snapshot('exporter')
    expect(snapshot).toBeDefined()
    expect(snapshot.entries.length).toBe(2)
  })
})

describe('HarnessOptions', () => {
  it('accepts an Agent factory', async () => {
    const directory = await tempDir()
    const repo = new JsonlSessionRepo(directory)
    const options: HarnessOptions = {
      repo,
      complete: scriptedComplete(1),
      sessionId: 'x',
      makeAgent: (complete) => new Agent({ complete }),
    }
    const harness = new AgentHarness(options)
    expect(harness).toBeInstanceOf(AgentHarness)
  })
})