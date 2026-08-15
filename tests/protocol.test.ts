import { describe, expect, it } from 'vitest'
import { encodeFrame, decodeFrame, encodeProtocolMessage, type ProtocolMessage } from '../src/protocol/framing.js'

describe('framed CBOR protocol', () => {
  it('encodes and decodes a message round-trip', () => {
    const message: ProtocolMessage = { kind: 'command', payload: { type: 'run', input: 'hello' } }
    const frame = encodeFrame(message)
    const [decoded, rest] = decodeFrame(frame)
    expect(decoded).toEqual(message)
    expect(rest).toHaveLength(0)
  })

  it('length-prefixes frames so multiple messages on one stream decode independently', () => {
    const messages: ProtocolMessage[] = [
      { kind: 'event', payload: { type: 'agent_start' } },
      { kind: 'command', payload: { type: 'steer', input: 'more' } },
    ]
    const stream = Buffer.concat(messages.map((message) => encodeFrame(message)))
    const decoded: ProtocolMessage[] = []
    let buffer: Buffer = stream
    for (let i = 0; i < 2; i += 1) {
      const [message, rest] = decodeFrame(buffer)
      decoded.push(message!)
      buffer = rest as Buffer
    }
    expect(decoded).toHaveLength(2)
    expect(decoded[0]?.kind).toBe('event')
    expect(decoded[1]?.payload).toMatchObject({ type: 'steer' })
  })

  it('returns null for an incomplete frame', () => {
    const frame = encodeFrame({ kind: 'command', payload: { type: 'run', input: 'x' } })
    const partial = frame.subarray(0, 4)
    const [decoded] = decodeFrame(partial)
    expect(decoded).toBeNull()
  })

  it('returns null for an incomplete body (length claims more than available) — waits for more bytes, does not throw', () => {
    const frame = encodeFrame({ kind: 'command', payload: { type: 'abort' } })
    // keep the 4-byte length header, corrupt the body to be too short
    const broken = Buffer.concat([frame.subarray(0, 4), Buffer.from([0x01])])
    const [decoded, rest] = decodeFrame(broken)
    expect(decoded).toBeNull()
    expect(rest.length).toBe(broken.length)
  })

  it('round-trips through encodeProtocolMessage helper', () => {
    const message: ProtocolMessage = { kind: 'session', payload: { id: 's1', entries: [] } }
    const encoded = encodeProtocolMessage(message)
    const [decoded] = decodeFrame(encoded)
    expect(decoded).toEqual(message)
  })
})