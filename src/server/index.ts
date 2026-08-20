import type { ProtocolMessage } from '../protocol/framing.js'
import type { SimpleResult, SimpleStreamOptions } from '../llm/model.js'
import type { Session } from '../harness/session/jsonl/repo.js'
import { Agent } from '../harness/agent.js'
import type { GraphContextBuilder } from '../query/graph-context.js'
import { timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto'

/** Constant-time string comparison (lengths are padded to avoid leaking size). */
function timingSafeEqual(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length)
  const bufA = Buffer.alloc(max)
  const bufB = Buffer.alloc(max)
  bufA.write(a)
  bufB.write(b)
  return nodeTimingSafeEqual(bufA, bufB)
}

export interface Channel {
  write(message: ProtocolMessage): void
  onMessage?(handler: (message: ProtocolMessage) => void): void
}

export interface ServerOptions {
  repo: { open(id: string): Promise<Session>; create(id: string): Promise<Session> }
  complete: (request: { messages: unknown[] }, options: SimpleStreamOptions) => Promise<SimpleResult>
  sessionId: string
  /** Optional shared secret. When set, the first frame must be an `auth` command carrying it. */
  authToken?: string
  /** Graph recall builder — forwarded to the harness Agent (v0.6.1). */
  graphContext?: GraphContextBuilder
}

/**
 * Remote session server: accepts framed messages over a Channel, runs them
 * against the harness, and emits events back on the same channel.
 * When `authToken` is configured the server rejects all commands until an
 * `auth` frame carrying the token arrives (token compare is timing-safe).
 */
export class TonyServer {
  private readonly options: ServerOptions
  private channel: Channel | null = null
  private agent: Agent | null = null
  private authenticated = false

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

    // Auth handshake: when a token is configured, require `auth` first.
    if (this.options.authToken) {
      if (type === 'auth') {
        const token = String(message.payload.token ?? '')
        this.authenticated = timingSafeEqual(token, this.options.authToken)
        this.emit({ kind: 'event', payload: { type: 'auth_result', ok: this.authenticated } })
        return
      }
      if (!this.authenticated) {
        this.emit({ kind: 'error', payload: { type: 'unauthorized', command: type } })
        return
      }
    }

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
      this.agent = new Agent({
        complete: this.options.complete,
        sessionId: this.options.sessionId,
        ...(this.options.graphContext ? { graphContext: this.options.graphContext } : {}),
      })
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