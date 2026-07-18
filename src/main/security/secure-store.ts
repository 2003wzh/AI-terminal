import { randomUUID } from 'node:crypto'
import {
  chmod as chmodFile,
  mkdir as makeDirectory,
  open as openFile,
  readFile,
  rename as renameFile,
  unlink as unlinkFile
} from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { TextDecoder } from 'node:util'

const ENVELOPE_FORMAT = 'ai-terminal.secure-store'
const PAYLOAD_FORMAT = 'ai-terminal.secure-store.payload'
const FORMAT_VERSION = 1
const MAX_STORED_BYTES = 16 * 1024 * 1024
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

export type SecureStoreErrorCode =
  | 'invalid_configuration'
  | 'encryption_unavailable'
  | 'read_failed'
  | 'write_failed'
  | 'corrupt_data'
  | 'purpose_mismatch'
  | 'decryption_failed'

const ERROR_MESSAGES: Record<SecureStoreErrorCode, string> = {
  invalid_configuration: 'Secure storage is not configured correctly.',
  encryption_unavailable: 'Secure storage encryption is unavailable.',
  read_failed: 'Secure data could not be read.',
  write_failed: 'Secure data could not be saved.',
  corrupt_data: 'Secure data is invalid or damaged.',
  purpose_mismatch: 'Secure data belongs to a different purpose.',
  decryption_failed: 'Secure data could not be decrypted.'
}

export class SecureStoreError extends Error {
  readonly code: SecureStoreErrorCode

  constructor(code: SecureStoreErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'SecureStoreError'
    this.code = code
    // A normal Error stack contains absolute source paths. Secure-store errors are safe to surface.
    this.stack = `${this.name}: ${this.message}`
  }
}

export interface SecureStoreCipher {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

interface ElectronSafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

interface SecureStoreFileHandle {
  writeFile(data: string, options: { encoding: 'utf8' }): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface SecureStoreIo {
  readFile(filePath: string): Promise<Buffer>
  mkdir(directoryPath: string, options: { recursive: true; mode: number }): Promise<void>
  open(filePath: string, flags: 'wx', mode: number): Promise<SecureStoreFileHandle>
  rename(sourcePath: string, destinationPath: string): Promise<void>
  chmod(filePath: string, mode: number): Promise<void>
  unlink(filePath: string): Promise<void>
}

export interface SecureStoreOptions {
  filePath: string
  purpose: string
  cipher: SecureStoreCipher
  io?: Partial<SecureStoreIo>
}

interface SecureEnvelope {
  format: typeof ENVELOPE_FORMAT
  version: typeof FORMAT_VERSION
  purpose: string
  ciphertext: string
}

interface SecurePayload {
  format: typeof PAYLOAD_FORMAT
  version: typeof FORMAT_VERSION
  purpose: string
  value: string
}

type ParsedStoredValue =
  | { kind: 'encrypted'; envelope: SecureEnvelope }
  | { kind: 'legacy'; value: string }

const DEFAULT_IO: SecureStoreIo = {
  readFile: async (filePath) => readFile(filePath),
  mkdir: async (directoryPath, options) => {
    await makeDirectory(directoryPath, options)
  },
  open: async (filePath, flags, mode) => openFile(filePath, flags, mode),
  rename: async (sourcePath, destinationPath) => {
    await renameFile(sourcePath, destinationPath)
  },
  chmod: async (filePath, mode) => {
    await chmodFile(filePath, mode)
  },
  unlink: async (filePath) => {
    await unlinkFile(filePath)
  }
}

/**
 * Loads Electron safeStorage only from the main process. On Windows, Electron safeStorage uses
 * DPAPI scoped to the current signed-in user.
 */
export async function createElectronSafeStorageCipher(): Promise<SecureStoreCipher> {
  assertMainProcess()
  if (process.platform !== 'win32') throw new SecureStoreError('encryption_unavailable')

  let safeStorage: ElectronSafeStorageLike
  try {
    const electron = await import('electron')
    safeStorage = electron.safeStorage
  } catch {
    throw new SecureStoreError('encryption_unavailable')
  }

  const encryptionAvailable = (): boolean => {
    if (process.platform !== 'win32') return false
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  return {
    isEncryptionAvailable: encryptionAvailable,
    encryptString(value) {
      if (!encryptionAvailable()) throw new SecureStoreError('encryption_unavailable')
      try {
        return safeStorage.encryptString(value)
      } catch {
        throw new SecureStoreError('encryption_unavailable')
      }
    },
    decryptString(value) {
      if (!encryptionAvailable()) throw new SecureStoreError('encryption_unavailable')
      try {
        return safeStorage.decryptString(value)
      } catch {
        throw new SecureStoreError('decryption_failed')
      }
    }
  }
}

export class SecureStore {
  readonly #filePath: string
  readonly #purpose: string
  readonly #cipher: SecureStoreCipher
  readonly #io: SecureStoreIo

  constructor(options: SecureStoreOptions) {
    assertMainProcess()
    if (!isAbsolute(options.filePath) || !isValidPurpose(options.purpose)) {
      throw new SecureStoreError('invalid_configuration')
    }

    this.#filePath = options.filePath
    this.#purpose = options.purpose
    this.#cipher = options.cipher
    this.#io = { ...DEFAULT_IO, ...options.io }
  }

  async read(): Promise<string | null> {
    let storedBytes: Buffer
    try {
      storedBytes = await this.#io.readFile(this.#filePath)
    } catch (error) {
      if (isFileNotFoundError(error)) return null
      throw new SecureStoreError('read_failed')
    }

    try {
      if (storedBytes.length === 0 || storedBytes.length > MAX_STORED_BYTES) {
        throw new SecureStoreError('corrupt_data')
      }

      let storedText: string
      try {
        storedText = UTF8_DECODER.decode(storedBytes)
      } catch {
        throw new SecureStoreError('corrupt_data')
      }

      const parsed = parseStoredValue(storedText)
      if (parsed.kind === 'encrypted') return this.#decrypt(parsed.envelope)

      // Do not release legacy plaintext unless its encrypted replacement is durable.
      await this.write(parsed.value)
      return parsed.value
    } finally {
      storedBytes.fill(0)
    }
  }

  async write(value: string): Promise<void> {
    if (typeof value !== 'string') throw new SecureStoreError('invalid_configuration')
    this.#requireEncryption()

    const payload: SecurePayload = {
      format: PAYLOAD_FORMAT,
      version: FORMAT_VERSION,
      purpose: this.#purpose,
      value
    }

    let encrypted: Buffer
    try {
      encrypted = this.#cipher.encryptString(JSON.stringify(payload))
    } catch {
      throw new SecureStoreError('write_failed')
    }
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
      throw new SecureStoreError('write_failed')
    }

    const envelope: SecureEnvelope = {
      format: ENVELOPE_FORMAT,
      version: FORMAT_VERSION,
      purpose: this.#purpose,
      ciphertext: encrypted.toString('base64')
    }

    try {
      await this.#writeAtomic(`${JSON.stringify(envelope)}\n`)
    } finally {
      encrypted.fill(0)
    }
  }

  #requireEncryption(): void {
    let available = false
    try {
      available = this.#cipher.isEncryptionAvailable()
    } catch {
      available = false
    }
    if (!available) throw new SecureStoreError('encryption_unavailable')
  }

  #decrypt(envelope: SecureEnvelope): string {
    if (envelope.purpose !== this.#purpose) {
      throw new SecureStoreError('purpose_mismatch')
    }
    this.#requireEncryption()

    const encrypted = decodeBase64(envelope.ciphertext)
    let decrypted: string
    try {
      decrypted = this.#cipher.decryptString(encrypted)
    } catch {
      throw new SecureStoreError('decryption_failed')
    } finally {
      encrypted.fill(0)
    }

    let payload: unknown
    try {
      payload = JSON.parse(decrypted)
    } catch {
      throw new SecureStoreError('corrupt_data')
    }
    if (!isSecurePayload(payload)) throw new SecureStoreError('corrupt_data')
    if (payload.purpose !== this.#purpose) throw new SecureStoreError('purpose_mismatch')
    return payload.value
  }

  async #writeAtomic(serializedEnvelope: string): Promise<void> {
    const directoryPath = dirname(this.#filePath)
    const temporaryPath = join(directoryPath, `.secure-store-${process.pid}-${randomUUID()}.tmp`)
    let handle: SecureStoreFileHandle | undefined
    let replacementComplete = false

    try {
      await this.#io.mkdir(directoryPath, { recursive: true, mode: 0o700 })
      await bestEffort(() => this.#io.chmod(directoryPath, 0o700))

      handle = await this.#io.open(temporaryPath, 'wx', 0o600)
      await handle.writeFile(serializedEnvelope, { encoding: 'utf8' })
      await handle.sync()
      await handle.close()
      handle = undefined

      await this.#io.rename(temporaryPath, this.#filePath)
      replacementComplete = true
      await bestEffort(() => this.#io.chmod(this.#filePath, 0o600))
    } catch {
      if (handle) await bestEffort(() => handle!.close())
      if (!replacementComplete) await bestEffort(() => this.#io.unlink(temporaryPath))
      throw new SecureStoreError('write_failed')
    }
  }
}

function parseStoredValue(storedText: string): ParsedStoredValue {
  const trimmed = storedText.trim()
  if (!trimmed) throw new SecureStoreError('corrupt_data')

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      throw new SecureStoreError('corrupt_data')
    }
    return { kind: 'legacy', value: storedText }
  }

  if (isRecord(parsed)) {
    if (parsed.format === ENVELOPE_FORMAT) {
      if (!isSecureEnvelope(parsed)) throw new SecureStoreError('corrupt_data')
      return { kind: 'encrypted', envelope: parsed }
    }

    const format = typeof parsed.format === 'string' ? parsed.format : ''
    if ('ciphertext' in parsed || format.startsWith(ENVELOPE_FORMAT)) {
      throw new SecureStoreError('corrupt_data')
    }
  }

  return { kind: 'legacy', value: storedText }
}

function isSecureEnvelope(value: unknown): value is SecureEnvelope {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['format', 'version', 'purpose', 'ciphertext']) &&
    value.format === ENVELOPE_FORMAT &&
    value.version === FORMAT_VERSION &&
    typeof value.purpose === 'string' &&
    isValidPurpose(value.purpose) &&
    typeof value.ciphertext === 'string' &&
    value.ciphertext.length > 0
  )
}

function isSecurePayload(value: unknown): value is SecurePayload {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['format', 'version', 'purpose', 'value']) &&
    value.format === PAYLOAD_FORMAT &&
    value.version === FORMAT_VERSION &&
    typeof value.purpose === 'string' &&
    isValidPurpose(value.purpose) &&
    typeof value.value === 'string'
  )
}

function decodeBase64(value: string): Buffer {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new SecureStoreError('corrupt_data')
  }

  const decoded = Buffer.from(value, 'base64')
  if (decoded.length === 0 || decoded.toString('base64') !== value) {
    decoded.fill(0)
    throw new SecureStoreError('corrupt_data')
  }
  return decoded
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

function isValidPurpose(purpose: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(purpose)
}

function isFileNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function assertMainProcess(): void {
  const processWithType = process as NodeJS.Process & { type?: string }
  if (processWithType.type === 'renderer') {
    throw new SecureStoreError('invalid_configuration')
  }
}

async function bestEffort(operation: () => Promise<void>): Promise<void> {
  try {
    await operation()
  } catch {
    // DPAPI provides confidentiality on Windows; restrictive modes are still applied where supported.
  }
}
