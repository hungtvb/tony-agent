import type { ProtocolMessage } from '../protocol/framing.js'
import type { SimpleResult, SimpleStreamOptions } from '../llm/model.js'
import type { Session } from '../harness/session/jsonl/repo.js'
import { Agent } from '../harness/agent.js'

export interface Channel {
  write(message: ProtocolMessage): void
  onMessage?(handler: (message: ProtocolMessage) => void): void
}

export interface ServerOptions {
  repo: { open(id: string): Promise<Session>; create(id: string): Promise<Session> }
  complete: (request: { messages: unknown[] }, options: SimpleStreamOptions) => Promise<SimpleResult>
  sessionId: string
}

/**
 * Remote session server: accepts framed messages over a Channel, runs them
 * against the harness, and emits events back on the same channel.
 */
export class TonyServer {
  private readonly options: ServerOptions
  private channel: Channel | null = null
  private agent: Agent | null = null

  constructor(options: ServerOptions) {
    this.options = options
  }

  attach(channel: Channel): void {
    this.channel = channel
    channel.onMessage?.((message) => this.handle(message))
  }

  handle(message: ProtocolMessage): void {
    if (message.kind !== 'command') return
    const { type } = message.payload
    switch (type) {
      case 'run': {
        void this.handleRun(String(message.payload.input ?? ''))
        break
      }
      case 'abort': {
        this.agent?.abort()
        this.emit({ kind: 'event', payload: { type: 'run_end', aborted: true } })
        break
      }
      default: {
        this.emit({ kind: 'error', payload: { type: 'unknown_command', command: type } })
      }
    }
  }

  private emit(message: ProtocolMessage): void {
    this.channel?.write(message)
  }

  private async handleRun(input: string): Promise<void> {
    const session = await this.options.repo.open(this.options.sessionId)
    if (!this.agent) {
      this.agent = new Agent({ complete: this.options.complete, sessionId: this.options.sessionId })
      this.agent.on((event) => {
        // skip internal lifecycle events the server re-emits itself
        if (event.type === 'run_end' || event.type === 'run_start' || event.type === 'agent_start' || event.type === 'agent_end') return
        this.emit({ kind: 'event', payload: { type: event.type, ...(event.text ? { text: event.text } : {}), ...(event.aborted !== undefined ? { aborted: event.aborted } : {}) } })
      })
    }
    this.emit({ kind: 'event', payload: { type: 'agent_start' } })
    const outcome = await this.agent.run(input)
    this.emit({ kind: 'event', payload: { type: 'run_end', text: outcome.text, aborted: outcome.aborted } })
    this.emit({ kind: 'session', payload: { id: session.id, entries: [] } })
  }
}