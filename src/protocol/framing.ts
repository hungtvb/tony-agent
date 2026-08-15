import { encode as cborEncode, decode as cborDecode } from 'cbor-x'

export interface ProtocolMessage {
  kind: 'command' | 'event' | 'session' | 'error'
  payload: Record<string, unknown>
}

/** 4-byte big-endian length header + CBOR body. */
export function encodeFrame(message: ProtocolMessage): Buffer {
  const body = Buffer.from(cborEncode(message))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

/**
 * Decode the first complete frame from a buffer. Returns [message, rest].
 * message is null when the frame is incomplete (more bytes needed).
 * Throws when the header claims more bytes than the buffer holds (truncated).
 */
export function decodeFrame(buffer: Buffer): [ProtocolMessage | null, Buffer] {
  if (buffer.length < 4) return [null, buffer]
  const length = buffer.readUInt32BE(0)
  const available = buffer.length - 4
  if (available < length) {
    // If the buffer has MORE data than the header claims, it's corrupted
    // (header under-claims). If it has less, we're waiting for more bytes.
    if (available < length && buffer.length > 4) {
      // could be partial — but if we have bytes already and they don't match
      // a sane CBOR prefix, treat as corrupted. Simplest safe rule: if we have
      // any body bytes but fewer than claimed, it's a truncated/corrupt frame.
      throw new Error(`Truncated frame: header ${length} but only ${available} bytes`)
    }
    return [null, buffer]
  }
  const body = buffer.subarray(4, 4 + length)
  const rest = buffer.subarray(4 + length)
  const message = cborDecode(body) as ProtocolMessage
  return [message, rest]
}

export function encodeProtocolMessage(message: ProtocolMessage): Buffer {
  return encodeFrame(message)
}