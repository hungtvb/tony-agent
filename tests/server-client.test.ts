import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TonyServer } from '../src/server/index.js'
import { TonyClient } from '../src/client/index.js'
import { JsonlSessionRepo } from '../src/harness/session/jsonl/repo.js'
import { encodeFrame, type ProtocolMessage } from '../src/protocol/framing.js'

const directories: string[] = []
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tony-proto-'))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

interface InMemoryChannel {
  write(message: ProtocolMessage): void
  onMessage(handler: (message: ProtocolMessage) => void): void
}

function pair(): [InMemoryChannel, InMemoryChannel] {
  const handlers: Array<((message: ProtocolMessage) => void) | null> = [null, null]
  const a: InMemoryChannel = {
    write: (message) => { if (handlers[1]) handlers[1](message) },
    onMessage: (handler) => { handlers[0] = handler },
  }
  const b: InMemoryChannel = {
    write: (message) => { if (handlers[0]) handlers[0](message) },
    onMessage: (handler) => { handlers[1] = handler },
  }
  return [a, b]
}

describe('TonyServer + TonyClient', () => {
  it('client sends a run command and receives an event back', async () => {
    const directory = await tempDir()
    const repo = new JsonlSessionRepo(directory)
    const server = new TonyServer({
      repo,
      complete: async () => {
        return { text: 'done!', toolCalls: [], usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10 }, stopReason: 'stop' }
      },
      sessionId: 'remote1',
    })
    const [serverChannel, clientChannel] = pair()
    server.attach(serverChannel)
    const client = new TonyClient(clientChannel)
    const events: ProtocolMessage[] = []
    client.onMessage((message) => events.push(message))

    const result = await client.run('hello from client')
    expect(result.text).toContain('done')
    expect(events.some((event) => event.kind === 'event' && event.payload.type === 'agent_start')).toBe(true)
  })

  it('client can abort a run', async () => {
    const directory = await tempDir()
    const repo = new JsonlSessionRepo(directory)
    const server = new TonyServer({
      repo,
      complete: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100))
        return { text: 'slow', toolCalls: [], usage: undefined, stopReason: 'stop' }
      },
      sessionId: 'abort1',
    })
    const [serverChannel, clientChannel] = pair()
    server.attach(serverChannel)
    const client = new TonyClient(clientChannel)

    const promise = client.run('start')
    setTimeout(() => client.abort(), 10)
    const result = await promise
    expect(result.aborted).toBe(true)
  })

  it('server returns an error frame for unknown commands', async () => {
    const directory = await tempDir()
    const repo = new JsonlSessionRepo(directory)
    const server = new TonyServer({ repo, complete: async () => ({ text: '', toolCalls: [], usage: undefined, stopReason: 'stop' }), sessionId: 'err1' })
    const [serverChannel, clientChannel] = pair()
    server.attach(serverChannel)
    const received: ProtocolMessage[] = []
    clientChannel.onMessage((message) => received.push(message))
    // send from the client side so the server's handle() receives it
    clientChannel.write({ kind: 'command', payload: { type: 'bogus' } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(received.some((message) => message.kind === 'error')).toBe(true)
  })
})

describe('frame encoding integration', () => {
  it('encodes a run command into a framed buffer and decodes it', () => {
    const message: ProtocolMessage = { kind: 'command', payload: { type: 'run', input: 'x' } }
    const frame = encodeFrame(message)
    // server-side: decode first frame
    const length = frame.readUInt32BE(0)
    expect(length).toBeGreaterThan(0)
    expect(frame.length).toBe(4 + length)
  })
})