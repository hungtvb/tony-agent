import { describe, expect, it } from 'vitest'
import { encodeFrame, decodeFrame, type ProtocolMessage } from '../src/protocol/framing.js'

describe('protocol framing regression (review)', () => {
  it('BUG15-HARD: partial frame body returns null (waits for more bytes), does NOT throw', () => {
    const frame = encodeFrame({ kind: 'command', payload: { type: 'run', input: 'x'.repeat(50) } })
    const length = frame.readUInt32BE(0)
    expect(length).toBeGreaterThan(16)
    // feed only a slice mid-body — a normal TCP chunk boundary, not corruption
    const partial = frame.subarray(0, 4 + 10)
    const [decoded, rest] = decodeFrame(partial)
    expect(decoded).toBeNull() // must NOT throw; wait for the rest
    expect(rest.length).toBe(partial.length) // buffer retained for continuation
  })

  it('BUG15-HARD: feeding the remainder completes the frame', () => {
    const frame = encodeFrame({ kind: 'command', payload: { type: 'run', input: 'payload'.repeat(9) } })
    const partial = frame.subarray(0, 4 + 8)
    const remain = frame.subarray(4 + 8)
    const [d1] = decodeFrame(partial)
    expect(d1).toBeNull()
    // feed the original partial buffer again + the remainder
    const [d2, rest] = decodeFrame(Buffer.concat([partial, remain]))
    expect(d2).not.toBeNull()
    expect(d2?.kind).toBe('command')
    expect(rest).toHaveLength(0)
  })

  it('only throws when the header claims more than the sanity cap (truly corrupt)', () => {
    // 4-byte header claiming 100 MB (> 64 MiB cap) with a tiny body
    const corrupt = Buffer.alloc(5)
    corrupt.writeUInt32BE(100 * 1024 * 1024, 0)
    corrupt[4] = 0x01
    expect(() => decodeFrame(corrupt)).toThrow(/over \d+ cap/)
  })
})