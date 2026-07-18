import { randomBytes } from 'node:crypto'

import type {
  GeneratedImageData,
  GeneratedImageRef
} from '../../shared/contracts.ts'
import type { ResponsesGeneratedImage } from './responses-client.ts'

interface ImageResultRecord {
  ownerWebContentsId: number
  expiresAt: number
  bytes: Buffer
}

export interface ImageResultStoreOptions {
  now?: () => number
  tokenLifetimeMs?: number
  maxRecords?: number
  maxStoredBytes?: number
}

export type ImageResultStoreErrorCode =
  | 'invalid_configuration'
  | 'invalid_image'
  | 'invalid_owner'
  | 'capacity_exceeded'

const ERROR_MESSAGES: Readonly<Record<ImageResultStoreErrorCode, string>> = Object.freeze({
  invalid_configuration: 'The generated image store configuration is invalid.',
  invalid_image: 'The generated image is invalid.',
  invalid_owner: 'The generated image owner is invalid.',
  capacity_exceeded: 'Generated image memory capacity is unavailable.'
})

export class ImageResultStoreError extends Error {
  readonly code: ImageResultStoreErrorCode

  constructor(code: ImageResultStoreErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'ImageResultStoreError'
    this.code = code
    this.stack = `${this.name}: ${this.message}`
  }
}

const TOKEN_PREFIX = 'img_'
const TOKEN_PATTERN = /^img_[A-Za-z0-9_-]{43}$/u
const DEFAULT_TOKEN_LIFETIME_MS = 10 * 60_000
const MIN_TOKEN_LIFETIME_MS = 1_000
const MAX_TOKEN_LIFETIME_MS = 60 * 60_000
const DEFAULT_MAX_RECORDS = 16
const MAX_CONFIGURED_RECORDS = 64
const DEFAULT_MAX_STORED_BYTES = 32 * 1024 * 1024
const MAX_CONFIGURED_STORED_BYTES = 64 * 1024 * 1024
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_IMAGES_PER_BATCH = 4

export class ImageResultStore {
  readonly #records = new Map<string, ImageResultRecord>()
  readonly #now: () => number
  readonly #tokenLifetimeMs: number
  readonly #maxRecords: number
  readonly #maxStoredBytes: number
  #storedBytes = 0

  constructor(options: ImageResultStoreOptions = {}) {
    if (!isPlainRecord(options)) throw new ImageResultStoreError('invalid_configuration')
    if (Object.keys(options).some((key) => ![
      'now',
      'tokenLifetimeMs',
      'maxRecords',
      'maxStoredBytes'
    ].includes(key))) {
      throw new ImageResultStoreError('invalid_configuration')
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new ImageResultStoreError('invalid_configuration')
    }
    this.#now = (options.now as (() => number) | undefined) ?? Date.now
    this.#tokenLifetimeMs = configuredInteger(
      options.tokenLifetimeMs as number | undefined,
      DEFAULT_TOKEN_LIFETIME_MS,
      MIN_TOKEN_LIFETIME_MS,
      MAX_TOKEN_LIFETIME_MS
    )
    this.#maxRecords = configuredInteger(
      options.maxRecords as number | undefined,
      DEFAULT_MAX_RECORDS,
      1,
      MAX_CONFIGURED_RECORDS
    )
    this.#maxStoredBytes = configuredInteger(
      options.maxStoredBytes as number | undefined,
      DEFAULT_MAX_STORED_BYTES,
      1,
      MAX_CONFIGURED_STORED_BYTES
    )
    this.#readNow()
  }

  issueMany(
    images: readonly ResponsesGeneratedImage[],
    ownerWebContentsId: number
  ): readonly GeneratedImageRef[] {
    validateOwner(ownerWebContentsId)
    if (!Array.isArray(images) || images.length < 1 || images.length > MAX_IMAGES_PER_BATCH) {
      throw new ImageResultStoreError('invalid_image')
    }
    const decoded: Buffer[] = []
    try {
      for (const image of images) decoded.push(decodeGeneratedImage(image))
      const now = this.#readNow()
      this.#pruneExpired(now)
      const addedBytes = decoded.reduce((total, bytes) => total + bytes.length, 0)
      if (
        this.#records.size + decoded.length > this.#maxRecords ||
        this.#storedBytes + addedBytes > this.#maxStoredBytes
      ) {
        throw new ImageResultStoreError('capacity_exceeded')
      }
      const reservedTokens = new Set<string>()
      const tokens = decoded.map(() => {
        const token = this.#issueToken(reservedTokens)
        reservedTokens.add(token)
        return token
      })
      const expiresAt = now + this.#tokenLifetimeMs
      if (!Number.isSafeInteger(expiresAt)) {
        throw new ImageResultStoreError('invalid_configuration')
      }
      const refs: GeneratedImageRef[] = []
      for (let index = 0; index < decoded.length; index += 1) {
        const bytes = decoded[index]!
        const imageToken = tokens[index]!
        this.#records.set(imageToken, {
          ownerWebContentsId,
          expiresAt,
          bytes
        })
        this.#storedBytes += bytes.length
        refs.push(Object.freeze({
          imageToken,
          mimeType: 'image/png',
          byteLength: bytes.length
        }))
      }
      decoded.length = 0
      return Object.freeze(refs)
    } finally {
      for (const bytes of decoded) bytes.fill(0)
    }
  }

  consume(imageToken: unknown, ownerWebContentsId: unknown): GeneratedImageData | null {
    if (
      typeof imageToken !== 'string' ||
      !TOKEN_PATTERN.test(imageToken) ||
      !isValidOwner(ownerWebContentsId)
    ) {
      return null
    }
    const record = this.#records.get(imageToken)
    if (!record || record.ownerWebContentsId !== ownerWebContentsId) return null
    this.#deleteRecord(imageToken, record)
    if (record.expiresAt <= this.#readNow()) {
      record.bytes.fill(0)
      return null
    }
    try {
      return Object.freeze({
        mimeType: 'image/png',
        byteLength: record.bytes.length,
        dataBase64: record.bytes.toString('base64')
      })
    } finally {
      record.bytes.fill(0)
    }
  }

  revokeOwner(ownerWebContentsId: unknown): void {
    if (!isValidOwner(ownerWebContentsId)) return
    for (const [token, record] of this.#records) {
      if (record.ownerWebContentsId !== ownerWebContentsId) continue
      this.#deleteRecord(token, record)
      record.bytes.fill(0)
    }
  }

  clear(): void {
    for (const record of this.#records.values()) record.bytes.fill(0)
    this.#records.clear()
    this.#storedBytes = 0
  }

  #deleteRecord(token: string, record: ImageResultRecord): void {
    if (!this.#records.delete(token)) return
    this.#storedBytes = Math.max(0, this.#storedBytes - record.bytes.length)
  }

  #pruneExpired(now: number): void {
    for (const [token, record] of this.#records) {
      if (record.expiresAt > now) continue
      this.#deleteRecord(token, record)
      record.bytes.fill(0)
    }
  }

  #issueToken(reserved: ReadonlySet<string>): string {
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
        if (TOKEN_PATTERN.test(token) && !this.#records.has(token) && !reserved.has(token)) return token
      }
    } catch {
      throw new ImageResultStoreError('capacity_exceeded')
    }
    throw new ImageResultStoreError('capacity_exceeded')
  }

  #readNow(): number {
    const now = this.#now()
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new ImageResultStoreError('invalid_configuration')
    }
    return now
  }
}

function decodeGeneratedImage(value: unknown): Buffer {
  if (
    !isPlainRecord(value) ||
    value.mimeType !== 'image/png' ||
    typeof value.dataUrl !== 'string' ||
    !value.dataUrl.startsWith('data:image/png;base64,')
  ) {
    throw new ImageResultStoreError('invalid_image')
  }
  const base64 = value.dataUrl.slice('data:image/png;base64,'.length)
  if (
    base64.length < 12 ||
    base64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64)
  ) {
    throw new ImageResultStoreError('invalid_image')
  }
  const bytes = Buffer.from(base64, 'base64')
  if (
    bytes.length < 8 ||
    bytes.length > MAX_IMAGE_BYTES ||
    !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
    bytes.toString('base64') !== base64
  ) {
    bytes.fill(0)
    throw new ImageResultStoreError('invalid_image')
  }
  return bytes
}

function configuredInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new ImageResultStoreError('invalid_configuration')
  }
  return result
}

function validateOwner(value: unknown): asserts value is number {
  if (!isValidOwner(value)) throw new ImageResultStoreError('invalid_owner')
}

function isValidOwner(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
