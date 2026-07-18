import {
  SIDECAR_MAX_MESSAGE_BYTES,
  SidecarProtocolError,
  assertSidecarRequest,
  parseSidecarEnvelope,
  type SidecarEnvelope,
  type SidecarRequestEnvelope
} from './protocol.js'

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

function decodeLine(line: Buffer): SidecarEnvelope | null {
  let content = line
  if (content.length > 0 && content[content.length - 1] === 0x0d) {
    content = content.subarray(0, content.length - 1)
  }
  if (content.length === 0) return null
  let text: string
  try {
    text = utf8Decoder.decode(content)
  } catch {
    throw new SidecarProtocolError('invalid_utf8', 'The sidecar emitted invalid UTF-8.')
  }
  return parseSidecarEnvelope(text)
}

export class BoundedNdjsonDecoder {
  readonly maxMessageBytes: number
  private pending = Buffer.alloc(0)

  constructor(maxMessageBytes = SIDECAR_MAX_MESSAGE_BYTES) {
    if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1_024) {
      throw new SidecarProtocolError('invalid_limit', 'The NDJSON byte limit is invalid.')
    }
    this.maxMessageBytes = maxMessageBytes
  }

  push(chunk: Buffer | Uint8Array | string): SidecarEnvelope[] {
    const input = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
    const envelopes: SidecarEnvelope[] = []
    let start = 0

    for (let index = 0; index < input.length; index += 1) {
      if (input[index] !== 0x0a) continue
      const segment = input.subarray(start, index)
      if (this.pending.length + segment.length > this.maxMessageBytes) {
        this.pending = Buffer.alloc(0)
        throw new SidecarProtocolError('message_too_large', 'A sidecar message exceeded the byte limit.')
      }
      const line = this.pending.length === 0
        ? segment
        : Buffer.concat([this.pending, segment], this.pending.length + segment.length)
      this.pending = Buffer.alloc(0)
      const envelope = decodeLine(line)
      if (envelope !== null) envelopes.push(envelope)
      start = index + 1
    }

    const tail = input.subarray(start)
    if (tail.length > 0) {
      if (this.pending.length + tail.length > this.maxMessageBytes) {
        this.pending = Buffer.alloc(0)
        throw new SidecarProtocolError('message_too_large', 'A sidecar message exceeded the byte limit.')
      }
      this.pending = this.pending.length === 0
        ? Buffer.from(tail)
        : Buffer.concat([this.pending, tail], this.pending.length + tail.length)
    }
    return envelopes
  }

  finish(): SidecarEnvelope[] {
    if (this.pending.length === 0) return []
    const line = this.pending
    this.pending = Buffer.alloc(0)
    const envelope = decodeLine(line)
    return envelope === null ? [] : [envelope]
  }

  reset(): void {
    this.pending = Buffer.alloc(0)
  }
}

export function encodeSidecarRequest(request: SidecarRequestEnvelope): Buffer {
  assertSidecarRequest(request)
  let encoded: Buffer
  try {
    encoded = Buffer.from(`${JSON.stringify(request)}\n`, 'utf8')
  } catch {
    throw new SidecarProtocolError('invalid_json', 'The sidecar request could not be encoded.')
  }
  if (encoded.length - 1 > SIDECAR_MAX_MESSAGE_BYTES) {
    throw new SidecarProtocolError('message_too_large', 'The sidecar request exceeded the byte limit.')
  }
  return encoded
}
