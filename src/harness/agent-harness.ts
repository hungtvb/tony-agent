import type { SimpleResult, SimpleStreamOptions } from '../llm/model.js'
import type { Session } from './session/jsonl/repo.js'
import { Agent, type AgentHooks, type PendingMessageQueueOptions, type RunOutcome } from './agent.js'
import { AgentMessage } from './messages.js'
import { createBranchSummary } from './compaction/branch-summarization.js'
import { createCompaction, type CompactionOptions } from './compaction/compaction.js'
import { createEntry, type Entry } from './session/types.js'

export interface HarnessOptions {
  repo: { create(id: string): Promise<Session>; open(id: string): Promise<Session>; branch(id: string, newId: string, fromSeq: number): Promise<Session> }
  complete: (request: { messages: unknown[] }, options: SimpleStreamOptions) => Promise<SimpleResult>
  sessionId: string
  makeAgent?: (complete: HarnessOptions['complete'], hooks?: AgentHooks) => Agent
  compaction?: CompactionOptions
}

export interface HarnessSnapshot {
  id: string
  entries: Entry[]
}

/**
 * Ties the stateful Agent to a persistent session repo with compaction and
 * branching. `run` persists every turn; `resume` replays the tail after a
 * crash; `navigate` creates a branch (optionally summarizing the parent);
 * `compact` writes a compaction entry.
 */
export class AgentHarness {
  private readonly repo: HarnessOptions['repo']
  private readonly complete: HarnessOptions['complete']
  private readonly sessionId: string
  private readonly makeAgent: NonNullable<HarnessOptions['makeAgent']>
  private readonly compaction: CompactionOptions | undefined
  private agent: Agent | null = null

  constructor(options: HarnessOptions) {
    this.repo = options.repo
    this.complete = options.complete
    this.sessionId = options.sessionId
    this.compaction = options.compaction
    this.makeAgent = options.makeAgent ?? ((complete) => new Agent({ complete, sessionId: this.sessionId }))
  }

  private async ensureAgent(history: AgentMessage[] = []): Promise<Agent> {
    if (!this.agent) {
      this.agent = this.makeAgent(this.complete)
      if (history.length > 0) this.agent.setTranscript(history)
    }
    return this.agent
  }

  private async persistTranscript(session: Session, messages: AgentMessage[]): Promise<void> {
    const entries = session.getEntries()
    const existingSeq = entries.length
    for (let i = existingSeq; i < messages.length; i += 1) {
      const message = messages[i]
      if (message && message.kind !== 'summary' && message.kind !== 'branchSummary') {
        await session.append(createEntry({
          seq: i + 1,
          parentId: i,
          kind: 'message',
          message: AgentMessage.toWire([message])[0] ?? {
            role: 'user',
            content: typeof message.data === 'object' && 'content' in message.data ? (message.data as { content: string }).content : '',
          },
        }))
      }
    }
  }

  async run(options: { input: string; steerMode?: PendingMessageQueueOptions }): Promise<RunOutcome> {
    const session = await this.repo.open(this.sessionId)
    const agent = await this.ensureAgent()
    agent.setTranscript(this.transcriptFromEntries(session.getEntries()))
    const outcome = await agent.run(options.input, options.steerMode ?? { type: 'one-at-a-time' })
    await this.persistTranscript(session, agent.getTranscript())
    return outcome
  }

  async resume(input: string): Promise<RunOutcome> {
    const session = await this.repo.open(this.sessionId)
    const transcript = this.transcriptFromEntries(session.getEntries())
    const agent = await this.ensureAgent(transcript)
    const outcome = await agent.run(input)
    await this.persistTranscript(session, agent.getTranscript())
    return outcome
  }

  async navigate(newSessionId: string, fromSeq: number, options: { summarize?: boolean } = {}): Promise<Session> {
    const session = await this.repo.open(this.sessionId)
    const branch = await this.repo.branch(this.sessionId, newSessionId, fromSeq)
    if (options.summarize) {
      const summary = await createBranchSummary(session.getEntries(), { fromSeq, summary: this.summarizeEntries(session.getEntries(), fromSeq) })
      await branch.append(createEntry({ ...summary, parentId: fromSeq }))
    }
    return branch
  }

  async compact(summary: string, options: { retainedTail?: number } = {}): Promise<Entry | null> {
    const session = await this.repo.open(this.sessionId)
    const entries = session.getEntries()
    const retainedTail = options.retainedTail ?? this.compaction?.retainedTail ?? 3
    const thresholdTokens = this.compaction?.thresholdTokens ?? 100_000
    const result = await createCompaction(entries, {
      tokensBefore: entries.length * 100,
      summary,
      options: { thresholdTokens, retainedTail },
      reason: 'manual',
    })
    if (result.compaction) {
      await session.append(result.compaction)
    }
    return result.compaction
  }

  async snapshot(id: string): Promise<HarnessSnapshot> {
    const session = await this.repo.open(id)
    return { id, entries: session.getEntries() }
  }

  private transcriptFromEntries(entries: Entry[]): AgentMessage[] {
    const messages: AgentMessage[] = []
    for (const entry of entries) {
      if (entry.kind === 'message') {
        messages.push(AgentMessage.from('user', { content: entry.message.content }))
      }
    }
    return messages
  }

  private summarizeEntries(entries: Entry[], fromSeq: number): string {
    const after = entries.filter((entry) => entry.seq > fromSeq)
    return `Branch from seq ${fromSeq}: ${after.length} subsequent entries (${after.map((entry) => entry.kind).join(', ')})`
  }
}