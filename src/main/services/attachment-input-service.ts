import { constants as fsConstants, promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'

import { redactSensitiveContent } from '../security/redaction.ts'
import type { ResponsesUserContentPart } from './responses-client.ts'
import {
  SelectionTokenStore,
  type ResolvedAttachmentRecord
} from './selection-token-store.ts'

export interface PreparedAttachmentInput {
  readonly parts: readonly ResponsesUserContentPart[]
  readonly count: number
  readonly totalBytes: number
}

export interface AttachmentInputServiceOptions {
  selections: SelectionTokenStore
  maxAttachments?: number
  maxAttachmentBytes?: number
  maxTotalBytes?: number
  protectedAbsoluteRoots?: readonly string[]
}

export interface AttachmentPrepareOptions {
  signal?: AbortSignal
}

export type AttachmentInputErrorCode =
  | 'invalid_configuration'
  | 'invalid_request'
  | 'selection_invalid'
  | 'file_unavailable'
  | 'file_changed'
  | 'sensitive_path'
  | 'unsupported_type'
  | 'file_too_large'
  | 'total_too_large'
  | 'cancelled'

const ERROR_MESSAGES: Readonly<Record<AttachmentInputErrorCode, string>> = Object.freeze({
  invalid_configuration: 'The attachment input service configuration is invalid.',
  invalid_request: 'The attachment request is invalid.',
  selection_invalid: 'The attachment selection is invalid or expired.',
  file_unavailable: 'The selected attachment is unavailable.',
  file_changed: 'The selected attachment changed after approval.',
  sensitive_path: 'The selected attachment is blocked by local safety policy.',
  unsupported_type: 'The selected attachment type is not supported.',
  file_too_large: 'A selected attachment exceeds the local safety limit.',
  total_too_large: 'The selected attachments exceed the local request limit.',
  cancelled: 'Attachment preparation was cancelled.'
})

export class AttachmentInputError extends Error {
  readonly code: AttachmentInputErrorCode

  constructor(code: AttachmentInputErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'AttachmentInputError'
    this.code = code
    this.stack = `${this.name}: ${this.message}`
  }
}

const DEFAULT_MAX_ATTACHMENTS = 6
const DEFAULT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 12 * 1024 * 1024
const MAX_CONFIGURED_ATTACHMENTS = 16
const MAX_CONFIGURED_ATTACHMENT_BYTES = 16 * 1024 * 1024
const MAX_CONFIGURED_TOTAL_BYTES = 24 * 1024 * 1024
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true })
const ATTACHMENT_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

type AttachmentKind =
  | { kind: 'image'; extension: 'png' | 'jpg' | 'webp'; mimeType: string }
  | { kind: 'text'; extension: string; mimeType: string }

const TEXT_MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/plain',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.py': 'text/x-python',
  '.rs': 'text/plain',
  '.go': 'text/plain',
  '.java': 'text/plain',
  '.c': 'text/plain',
  '.h': 'text/plain',
  '.cpp': 'text/plain',
  '.hpp': 'text/plain',
  '.cs': 'text/plain',
  '.sh': 'text/plain',
  '.ps1': 'text/plain',
  '.log': 'text/plain'
})

export class AttachmentInputService {
  readonly #selections: SelectionTokenStore
  readonly #maxAttachments: number
  readonly #maxAttachmentBytes: number
  readonly #maxTotalBytes: number
  readonly #protectedAbsoluteRoots: readonly string[]

  constructor(options: AttachmentInputServiceOptions) {
    if (!isPlainRecord(options) || !(options.selections instanceof SelectionTokenStore)) {
      throw new AttachmentInputError('invalid_configuration')
    }
    this.#maxAttachments = configuredInteger(
      options.maxAttachments,
      DEFAULT_MAX_ATTACHMENTS,
      1,
      MAX_CONFIGURED_ATTACHMENTS
    )
    this.#maxAttachmentBytes = configuredInteger(
      options.maxAttachmentBytes,
      DEFAULT_MAX_ATTACHMENT_BYTES,
      1,
      MAX_CONFIGURED_ATTACHMENT_BYTES
    )
    this.#maxTotalBytes = configuredInteger(
      options.maxTotalBytes,
      DEFAULT_MAX_TOTAL_BYTES,
      1,
      MAX_CONFIGURED_TOTAL_BYTES
    )
    if (this.#maxAttachmentBytes > this.#maxTotalBytes) {
      throw new AttachmentInputError('invalid_configuration')
    }
    this.#protectedAbsoluteRoots = parseProtectedRoots(options.protectedAbsoluteRoots)
    this.#selections = options.selections
  }

  async prepare(
    attachmentTokens: readonly string[],
    ownerWebContentsId: number,
    options: AttachmentPrepareOptions = {}
  ): Promise<PreparedAttachmentInput> {
    validatePrepareRequest(
      attachmentTokens,
      ownerWebContentsId,
      options,
      this.#maxAttachments
    )
    throwIfAborted(options.signal)

    const reservation = await this.#selections.reserveAttachments(
      attachmentTokens,
      ownerWebContentsId
    )
    if (!reservation) throw new AttachmentInputError('selection_invalid')

    let committed = false
    try {
      const parts: ResponsesUserContentPart[] = []
      let totalBytes = 0
      for (let index = 0; index < reservation.attachments.length; index += 1) {
        throwIfAborted(options.signal)
        const prepared = await this.#readSelectedAttachment(
          reservation.attachments[index]!,
          index,
          options.signal
        )
        totalBytes += prepared.byteLength
        if (totalBytes > this.#maxTotalBytes) throw new AttachmentInputError('total_too_large')
        parts.push(prepared.part)
      }
      throwIfAborted(options.signal)

      const result = Object.freeze({
        parts: Object.freeze(parts),
        count: parts.length,
        totalBytes
      })
      committed = this.#selections.commitAttachmentReservation(
        reservation.reservationToken,
        ownerWebContentsId
      )
      if (!committed) throw new AttachmentInputError('selection_invalid')
      return result
    } finally {
      if (!committed) {
        this.#selections.rollbackAttachmentReservation(
          reservation.reservationToken,
          ownerWebContentsId
        )
      }
    }
  }

  async #readSelectedAttachment(
    selected: ResolvedAttachmentRecord,
    index: number,
    signal?: AbortSignal
  ): Promise<{ part: ResponsesUserContentPart; byteLength: number }> {
    if (
      isSensitiveAttachmentPath(selected.absolutePath) ||
      this.#protectedAbsoluteRoots.some((root) => isPathInside(root, selected.absolutePath))
    ) {
      throw new AttachmentInputError('sensitive_path')
    }
    const kind = attachmentKind(extname(selected.absolutePath))
    let handle: FileHandle | undefined
    let data: Buffer | undefined
    let sanitized: Buffer | undefined
    try {
      throwIfAborted(signal)
      const before = await fs.lstat(selected.absolutePath)
      assertUnchangedSelection(selected, before)
      if (before.size < 1) throw new AttachmentInputError('file_unavailable')
      if (before.size > this.#maxAttachmentBytes) throw new AttachmentInputError('file_too_large')

      handle = await fs.open(selected.absolutePath, fsConstants.O_RDONLY)
      const opened = await handle.stat()
      assertUnchangedSelection(selected, opened)
      data = await handle.readFile({ signal })
      throwIfAborted(signal)
      const after = await handle.stat()
      assertStableRead(opened, after, data.byteLength)
      sanitized = sanitizeFileContent(kind, data)

      const remoteName = `attachment-${index + 1}.${kind.extension}`
      const encoded = sanitized.toString('base64')
      const dataUrl = `data:${kind.mimeType};base64,${encoded}`
      const part: ResponsesUserContentPart = kind.kind === 'image'
        ? { type: 'input_image', image_url: dataUrl, detail: 'auto' }
        : {
            type: 'input_file',
            filename: remoteName,
            file_data: dataUrl,
            ...(kind.extension === 'pdf' ? { detail: 'auto' as const } : {})
          }
      return { part, byteLength: data.byteLength }
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw new AttachmentInputError('cancelled')
      if (error instanceof AttachmentInputError) throw error
      throw new AttachmentInputError('file_unavailable')
    } finally {
      if (sanitized && sanitized !== data) sanitized.fill(0)
      if (data) data.fill(0)
      if (handle) await handle.close().catch(() => undefined)
    }
  }
}

function attachmentKind(rawExtension: string): AttachmentKind {
  const extension = rawExtension.toLowerCase()
  if (extension === '.png') return { kind: 'image', extension: 'png', mimeType: 'image/png' }
  if (extension === '.jpg' || extension === '.jpeg') {
    return { kind: 'image', extension: 'jpg', mimeType: 'image/jpeg' }
  }
  if (extension === '.webp') return { kind: 'image', extension: 'webp', mimeType: 'image/webp' }
  const textMime = TEXT_MIME_BY_EXTENSION[extension]
  if (textMime) return { kind: 'text', extension: extension.slice(1), mimeType: textMime }
  throw new AttachmentInputError('unsupported_type')
}

function sanitizeFileContent(kind: AttachmentKind, data: Buffer): Buffer {
  if (kind.kind === 'image') {
    if (kind.extension === 'png' && !data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
      throw new AttachmentInputError('unsupported_type')
    }
    if (
      kind.extension === 'jpg' &&
      !(data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff && data.at(-2) === 0xff && data.at(-1) === 0xd9)
    ) {
      throw new AttachmentInputError('unsupported_type')
    }
    if (
      kind.extension === 'webp' &&
      !(data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP')
    ) {
      throw new AttachmentInputError('unsupported_type')
    }
    if (kind.extension === 'png') return stripPngMetadata(data)
    if (kind.extension === 'jpg') return stripJpegMetadata(data)
    return stripWebpMetadata(data)
  }
  if (data.includes(0)) throw new AttachmentInputError('unsupported_type')
  let decoded: string
  try {
    decoded = TEXT_DECODER.decode(data)
  } catch {
    throw new AttachmentInputError('unsupported_type')
  }
  const redacted = redactSensitiveContent(decoded)
  if (!redacted) throw new AttachmentInputError('unsupported_type')
  return Buffer.from(redacted, 'utf8')
}

function stripPngMetadata(data: Buffer): Buffer {
  const output: Buffer[] = [data.subarray(0, 8)]
  let offset = 8
  let sawHeader = false
  let sawImageData = false
  let sawEnd = false
  while (offset < data.length) {
    if (offset + 12 > data.length) throw new AttachmentInputError('unsupported_type')
    const length = data.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > data.length) throw new AttachmentInputError('unsupported_type')
    const type = data.subarray(offset + 4, offset + 8).toString('ascii')
    if (!/^[A-Za-z]{4}$/u.test(type)) throw new AttachmentInputError('unsupported_type')
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') {
      throw new AttachmentInputError('unsupported_type')
    }
    if (type === 'IHDR') sawHeader = true
    if (type === 'IDAT') sawImageData = true
    if (type === 'IEND') sawEnd = true
    if (['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS'].includes(type)) {
      output.push(data.subarray(offset, end))
    } else if (type[0] === type[0]?.toUpperCase()) {
      throw new AttachmentInputError('unsupported_type')
    }
    offset = end
    if (sawEnd) break
  }
  if (!sawHeader || !sawImageData || !sawEnd || offset !== data.length) {
    throw new AttachmentInputError('unsupported_type')
  }
  return Buffer.concat(output)
}

function stripJpegMetadata(data: Buffer): Buffer {
  const output: Buffer[] = [data.subarray(0, 2)]
  let offset = 2
  let sawScan = false
  while (offset < data.length - 1) {
    if (data[offset] !== 0xff) throw new AttachmentInputError('unsupported_type')
    let markerOffset = offset
    while (data[markerOffset] === 0xff) markerOffset += 1
    const marker = data[markerOffset]
    if (marker === undefined || marker === 0x00) throw new AttachmentInputError('unsupported_type')
    if (marker === 0xda) {
      if (markerOffset + 3 >= data.length) throw new AttachmentInputError('unsupported_type')
      const segmentLength = data.readUInt16BE(markerOffset + 1)
      const scanStart = markerOffset + 1 + segmentLength
      if (segmentLength < 2 || scanStart > data.length - 2) {
        throw new AttachmentInputError('unsupported_type')
      }
      output.push(data.subarray(offset, data.length))
      sawScan = true
      break
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      output.push(data.subarray(offset, markerOffset + 1))
      offset = markerOffset + 1
      continue
    }
    if (markerOffset + 3 >= data.length) throw new AttachmentInputError('unsupported_type')
    const segmentLength = data.readUInt16BE(markerOffset + 1)
    const end = markerOffset + 1 + segmentLength
    if (segmentLength < 2 || end > data.length) throw new AttachmentInputError('unsupported_type')
    const isPrivateMetadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe
    if (!isPrivateMetadata) output.push(data.subarray(offset, end))
    offset = end
  }
  if (!sawScan) throw new AttachmentInputError('unsupported_type')
  return Buffer.concat(output)
}

function stripWebpMetadata(data: Buffer): Buffer {
  if (data.length < 20) throw new AttachmentInputError('unsupported_type')
  const chunks: Buffer[] = []
  let offset = 12
  let sawImage = false
  while (offset < data.length) {
    if (offset + 8 > data.length) throw new AttachmentInputError('unsupported_type')
    const type = data.subarray(offset, offset + 4).toString('ascii')
    const length = data.readUInt32LE(offset + 4)
    const paddedLength = length + (length % 2)
    const end = offset + 8 + paddedLength
    if (end > data.length) throw new AttachmentInputError('unsupported_type')
    if (type === 'ANIM' || type === 'ANMF' || type === 'VP8X' || type === 'ALPH') {
      throw new AttachmentInputError('unsupported_type')
    }
    if (type === 'VP8 ' || type === 'VP8L') sawImage = true
    if (type === 'VP8 ' || type === 'VP8L') chunks.push(data.subarray(offset, end))
    offset = end
  }
  if (!sawImage || offset !== data.length) throw new AttachmentInputError('unsupported_type')
  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(12)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(body.length + 4, 4)
  header.write('WEBP', 8, 'ascii')
  return Buffer.concat([header, body])
}

function assertUnchangedSelection(
  selected: ResolvedAttachmentRecord,
  stats: Awaited<ReturnType<typeof fs.lstat>> | Awaited<ReturnType<FileHandle['stat']>>
): void {
  if (!stats.isFile() || stats.isSymbolicLink()) throw new AttachmentInputError('file_changed')
  if (selected.device !== 0 && stats.dev !== 0 && selected.device !== stats.dev) {
    throw new AttachmentInputError('file_changed')
  }
  if (selected.inode !== 0 && stats.ino !== 0 && selected.inode !== stats.ino) {
    throw new AttachmentInputError('file_changed')
  }
  if (selected.size !== stats.size || selected.modifiedAtMs !== stats.mtimeMs) {
    throw new AttachmentInputError('file_changed')
  }
}

function assertStableRead(
  before: Awaited<ReturnType<FileHandle['stat']>>,
  after: Awaited<ReturnType<FileHandle['stat']>>,
  bytesRead: number
): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    bytesRead !== before.size
  ) {
    throw new AttachmentInputError('file_changed')
  }
}

function validatePrepareRequest(
  tokens: readonly string[],
  ownerWebContentsId: number,
  options: AttachmentPrepareOptions,
  maxAttachments: number
): void {
  if (
    !Array.isArray(tokens) ||
    tokens.length < 1 ||
    tokens.length > maxAttachments ||
    !Number.isSafeInteger(ownerWebContentsId) ||
    ownerWebContentsId <= 0 ||
    !isPlainRecord(options) ||
    Object.keys(options).some((key) => key !== 'signal') ||
    (options.signal !== undefined && !isAbortSignal(options.signal))
  ) {
    throw new AttachmentInputError('invalid_request')
  }
  const unique = new Set<string>()
  for (const token of tokens) {
    if (typeof token !== 'string' || !ATTACHMENT_TOKEN_PATTERN.test(token) || unique.has(token)) {
      throw new AttachmentInputError('invalid_request')
    }
    unique.add(token)
  }
}

function configuredInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new AttachmentInputError('invalid_configuration')
  }
  return result
}

function parseProtectedRoots(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.length > 64) {
    throw new AttachmentInputError('invalid_configuration')
  }
  const roots = value.map((root) => {
    if (
      typeof root !== 'string' ||
      root.length < 1 ||
      root.length > 32_768 ||
      !isAbsolute(root) ||
      /[\r\n\0]/u.test(root)
    ) {
      throw new AttachmentInputError('invalid_configuration')
    }
    return resolve(root)
  })
  return Object.freeze(roots)
}

function isSensitiveAttachmentPath(absolutePath: string): boolean {
  const normalized = resolve(absolutePath).replaceAll('\\', '/').toLowerCase()
  const segments = normalized.split('/').filter(Boolean)
  const fileName = basename(normalized)
  if (segments.some((segment) => ['.ssh', '.gnupg', '.aws', '.azure', '.kube'].includes(segment))) {
    return true
  }
  if (fileName.startsWith('.env')) return true
  if (
    ['.npmrc', '.pypirc', '.netrc', 'auth.json', 'credentials', 'credentials.json'].includes(fileName)
  ) {
    return true
  }
  return /\.(?:pem|key|p12|pfx|jks|keystore)$/u.test(fileName)
}

function isPathInside(root: string, candidate: string): boolean {
  const rootKey = pathComparisonKey(root)
  const candidateKey = pathComparisonKey(candidate)
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}${sep}`)
}

function pathComparisonKey(value: string): string {
  const normalized = resolve(value).replace(/^\\\\\?\\/u, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AttachmentInputError('cancelled')
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === 'AbortError'
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<AbortSignal>
  return (
    typeof candidate.aborted === 'boolean' &&
    typeof candidate.addEventListener === 'function' &&
    typeof candidate.removeEventListener === 'function'
  )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
