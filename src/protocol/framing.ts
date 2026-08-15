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
 * message is null when the frame is incomplete (more bytes needed) — callers
 * should retain the buffer and feed it more bytes. A stream decoder CANNOT
 * distinguish a partial frame from corruption until it has the full body, so
 * we never throw on short reads; corruption surfaces either as an absurd
 * header length (over the 64 MiB sanity cap) or as a CBOR decode failure once
 * the body is complete.
 */
export function decodeFrame(buffer: Buffer): [ProtocolMessage | null, Buffer] {
  if (buffer.length < 4) return [null, buffer]
  const length = buffer.readUInt32BE(0)
  if (length > MAX_FRAME_BYTES) {
    throw new Error(`Invalid frame: header claims ${length} bytes (over ${MAX_FRAME_BYTES} cap)`)
  }
  const available = buffer.length - 4
  if (available < length) return [null, buffer] // wait for more bytes
  const body = buffer.subarray(4, 4 + length)
  const rest = buffer.subarray(4 + length)
  const message = cborDecode(body) as ProtocolMessage
  return [message, rest]
}

/** 64 MiB — frames beyond this are corrupt, not real. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024

export function encodeProtocolMessage(message: ProtocolMessage): Buffer {
  return encodeFrame(message)
}