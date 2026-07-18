import { Buffer } from 'node:buffer'

import type { RelayEncryptedCredentialStorage, RelayStoredCredential } from './relay-service.ts'
import { normalizeRelayServerOrigin } from './relay-service.ts'

const DOCUMENT_FORMAT = 'ai-terminal.relay-credential'
const DOCUMENT_VERSION = 1
const MAX_DOCUMENT_BYTES = 64 * 1024
const MAX_CREDENTIAL_LENGTH = 16 * 1024
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u

export interface RelayCredentialStringStore {
  read(): Promise<string | null>
  write(value: string): Promise<void>
}

export class RelayCredentialStorageError extends Error {
  constructor() {
    super('Encrypted relay credential storage is unavailable.')
    this.name = 'RelayCredentialStorageError'
    this.stack = `${this.name}: ${this.message}`
  }
}

interface RelayCredentialDocument {
  format: typeof DOCUMENT_FORMAT
  version: typeof DOCUMENT_VERSION
  credential: RelayStoredCredential | null
}

/**
 * Serializes the relay credential inside a SecureStore-compatible string store.
 * The underlying store owns DPAPI encryption and atomic replacement.
 */
export class SecureRelayCredentialStorage implements RelayEncryptedCredentialStorage {
  readonly #store: RelayCredentialStringStore

  constructor(store: RelayCredentialStringStore) {
    if (!isStringStore(store)) throw new RelayCredentialStorageError()
    this.#store = store
  }

  async loadCredential(): Promise<RelayStoredCredential | null> {
    let serialized: string | null
    try {
      serialized = await this.#store.read()
    } catch {
      throw new RelayCredentialStorageError()
    }
    if (serialized === null) return null
    if (
      typeof serialized !== 'string' ||
      serialized.length === 0 ||
      Buffer.byteLength(serialized, 'utf8') > MAX_DOCUMENT_BYTES
    ) {
      throw new RelayCredentialStorageError()
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(serialized)
    } catch {
      throw new RelayCredentialStorageError()
    }
    if (
      !hasExactKeys(parsed, ['format', 'version', 'credential']) ||
      parsed.format !== DOCUMENT_FORMAT ||
      parsed.version !== DOCUMENT_VERSION
    ) {
      throw new RelayCredentialStorageError()
    }
    if (parsed.credential === null) return null
    try {
      return parseCredential(parsed.credential)
    } catch {
      throw new RelayCredentialStorageError()
    }
  }

  async saveCredential(credential: RelayStoredCredential): Promise<void> {
    let normalized: RelayStoredCredential
    try {
      normalized = parseCredential(credential)
    } catch {
      throw new RelayCredentialStorageError()
    }
    await this.#writeDocument({
      format: DOCUMENT_FORMAT,
      version: DOCUMENT_VERSION,
      credential: normalized
    })
  }

  async clearCredential(): Promise<void> {
    // An encrypted tombstone uses the same atomic replacement path as writes;
    // deleting first could expose a crash window with stale credentials.
    await this.#writeDocument({
      format: DOCUMENT_FORMAT,
      version: DOCUMENT_VERSION,
      credential: null
    })
  }

  async #writeDocument(document: RelayCredentialDocument): Promise<void> {
    const serialized = JSON.stringify(document)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_DOCUMENT_BYTES) {
      throw new RelayCredentialStorageError()
    }
    try {
      await this.#store.write(serialized)
    } catch {
      throw new RelayCredentialStorageError()
    }
  }
}

function parseCredential(value: unknown): RelayStoredCredential {
  if (!hasExactKeys(value, [
    'version',
    'server_origin',
    'refresh_token',
    'device_id',
    'refresh_expires_at',
    'updated_at'
  ]) || value.version !== 1) {
    throw new RelayCredentialStorageError()
  }
  if (typeof value.server_origin !== 'string') throw new RelayCredentialStorageError()
  const serverOrigin = normalizeRelayServerOrigin(value.server_origin)
  if (serverOrigin !== value.server_origin) throw new RelayCredentialStorageError()
  if (
    typeof value.refresh_token !== 'string' ||
    value.refresh_token.length < 1 ||
    value.refresh_token.length > MAX_CREDENTIAL_LENGTH ||
    value.refresh_token !== value.refresh_token.trim() ||
    /[\u0000-\u0020\u007f]/u.test(value.refresh_token)
  ) {
    throw new RelayCredentialStorageError()
  }
  if (typeof value.device_id !== 'string' || !OPAQUE_ID_PATTERN.test(value.device_id)) {
    throw new RelayCredentialStorageError()
  }
  if (
    !Number.isSafeInteger(value.refresh_expires_at) ||
    Number(value.refresh_expires_at) <= 0 ||
    !Number.isSafeInteger(value.updated_at) ||
    Number(value.updated_at) < 0 ||
    Number(value.updated_at) > Number(value.refresh_expires_at)
  ) {
    throw new RelayCredentialStorageError()
  }
  return Object.freeze({
    version: 1,
    server_origin: serverOrigin,
    refresh_token: value.refresh_token,
    device_id: value.device_id,
    refresh_expires_at: Number(value.refresh_expires_at),
    updated_at: Number(value.updated_at)
  })
}

function isStringStore(value: unknown): value is RelayCredentialStringStore {
  return isRecordLike(value) && typeof value.read === 'function' && typeof value.write === 'function'
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecordLike(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys<K extends string>(
  value: unknown,
  expectedKeys: readonly K[]
): value is Record<K, unknown> {
  if (!isPlainRecord(value)) return false
  const keys = Object.keys(value)
  return keys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key))
}
