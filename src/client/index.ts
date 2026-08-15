import type { ProtocolMessage } from '../protocol/framing.js'

export interface ClientOptions {
  channel: {
    write(message: ProtocolMessage): void
    onMessage?(handler: (message: ProtocolMessage) => void): void
  }
}

export interface ClientRunResult {
  text: string
  aborted: boolean
}

/**
 * Remote session client: relays run/steer/abort commands to the server and
 * forwards events. Waits for the matching run_end/session response.
 */
export class TonyClient {
  private readonly channel: ClientOptions['channel']
  private readonly handlers: Array<(message: ProtocolMessage) => void> = []
  private pending: Array<{ resolve: (result: ClientRunResult) => void }> = []

  constructor(channel: ClientOptions['channel']) {
    this.channel = channel
    // subscribe to incoming messages so dispatch receives server responses
    channel.onMessage?.((message) => this.dispatch(message))
  }

  onMessage(handler: (message: ProtocolMessage) => void): void {
    this.handlers.push(handler)
  }

  private dispatch(message: ProtocolMessage): void {
    for (const handler of this.handlers) handler(message)
    if (message.kind === 'event' && message.payload.type === 'run_end') {
      // resolve the oldest pending run with the final outcome
      const target = this.pending.shift()
      if (target) {
        target.resolve({ text: String(message.payload.text ?? ''), aborted: Boolean(message.payload.aborted) })
      }
    }
  }

  run(input: string): Promise<ClientRunResult> {
    return new Promise((resolve) => {
      this.pending.push({ resolve })
      this.channel.write({ kind: 'command', payload: { type: 'run', input } })
    })
  }

  abort(): void {
    this.channel.write({ kind: 'command', payload: { type: 'abort' } })
  }

  steer(input: string): void {
    this.channel.write({ kind: 'command', payload: { type: 'steer', input } })
  }
}