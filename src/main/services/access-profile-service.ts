import { randomUUID } from 'node:crypto'

import type { PublicAccessProfile, SaveProfileInput } from '../../shared/contracts'

const DOCUMENT_FORMAT = 'ai-terminal.access-profiles'
const DOCUMENT_VERSION = 1
const MAX_DOCUMENT_CHARACTERS = 4 * 1024 * 1024
const MAX_PROFILES = 64
const MAX_NAME_CHARACTERS = 128
const MAX_DESCRIPTION_CHARACTERS = 1_024
const MAX_API_KEY_CHARACTERS = 32_768
const MAX_BASE_URL_CHARACTERS = 2_048
const PROFILE_HANDLE_PATTERN =
  /^profile:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ALLOWED_TARGETS = ['codex', 'claude-desktop', 'claude-code'] as const

type AccessTarget = PublicAccessProfile['targets'][number]

export type AccessProfileServiceErrorCode =
  | 'invalid_configuration'
  | 'invalid_input'
  | 'not_found'
  | 'missing_secret'
  | 'corrupt_data'
  | 'storage_error'

const ERROR_MESSAGES: Record<AccessProfileServiceErrorCode, string> = {
  invalid_configuration: 'Access profile storage is not configured correctly.',
  invalid_input: 'Access profile input is invalid.',
  not_found: 'Access profile was not found.',
  missing_secret: 'Access profile does not contain a credential.',
  corrupt_data: 'Stored access profiles are invalid or damaged.',
  storage_error: 'Access profiles could not be stored securely.'
}

export class AccessProfileServiceError extends Error {
  readonly code: AccessProfileServiceErrorCode

  constructor(code: AccessProfileServiceErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'AccessProfileServiceError'
    this.code = code
    this.stack = `${this.name}: ${this.message}`
  }
}

export interface AccessProfileStorage {
  read(): Promise<string | null>
  write(serializedDocument: string): Promise<void>
}

/** Main-process credential material. Never return this object through IPC or preload. */
export interface MainAccessProfileSecret {
  credentialHandle: string
  baseUrl: string
  apiKey: string
}

interface StoredAccessProfile {
  credentialHandle: string
  name: string
  description: string
  baseUrl: string
  apiKey: string | null
  targets: AccessTarget[]
}

interface AccessProfileDocument {
  format: typeof DOCUMENT_FORMAT
  version: typeof DOCUMENT_VERSION
  currentCredentialHandle: string | null
  profiles: StoredAccessProfile[]
}

interface NormalizedSaveInput {
  credentialHandle?: string
  name: string
  description: string
  baseUrl: string
  apiKey?: string
  targets: AccessTarget[]
}

export class AccessProfileService {
  readonly #storage: AccessProfileStorage
  #operationTail: Promise<void> = Promise.resolve()

  constructor(storage: AccessProfileStorage) {
    assertMainProcess()
    let validStorage = false
    try {
      validStorage =
        Boolean(storage) &&
        typeof storage === 'object' &&
        typeof storage.read === 'function' &&
        typeof storage.write === 'function'
    } catch {
      validStorage = false
    }
    if (!validStorage) {
      throw new AccessProfileServiceError('invalid_configuration')
    }
    this.#storage = storage
  }

  async listPublic(): Promise<PublicAccessProfile[]> {
    return this.#exclusive(async () => {
      const document = await this.#loadDocument()
      return document.profiles.map((profile) => toPublicProfile(profile, document.currentCredentialHandle))
    })
  }

  async save(input: SaveProfileInput): Promise<PublicAccessProfile> {
    return this.#exclusive(async () => {
      let normalized: NormalizedSaveInput
      try {
        normalized = normalizeSaveInput(input)
      } catch (error) {
        if (error instanceof AccessProfileServiceError) throw error
        throw new AccessProfileServiceError('invalid_input')
      }
      const document = await this.#loadDocument()
      const existingIndex = normalized.credentialHandle
        ? document.profiles.findIndex(
            (profile) => profile.credentialHandle === normalized.credentialHandle
          )
        : -1

      if (normalized.credentialHandle && existingIndex < 0) {
        throw new AccessProfileServiceError('not_found')
      }
      if (!normalized.credentialHandle && document.profiles.length >= MAX_PROFILES) {
        throw new AccessProfileServiceError('invalid_input')
      }

      const existing = existingIndex >= 0 ? document.profiles[existingIndex] : undefined
      const credentialHandle = existing?.credentialHandle ?? createUniqueHandle(document.profiles)
      const storedProfile: StoredAccessProfile = {
        credentialHandle,
        name: normalized.name,
        description: normalized.description,
        baseUrl: normalized.baseUrl,
        apiKey: normalized.apiKey === undefined ? (existing?.apiKey ?? null) : normalized.apiKey,
        targets: [...normalized.targets]
      }

      if (existingIndex >= 0) document.profiles[existingIndex] = storedProfile
      else document.profiles.push(storedProfile)
      if (document.currentCredentialHandle === null) {
        document.currentCredentialHandle = credentialHandle
      }

      await this.#saveDocument(document)
      return toPublicProfile(storedProfile, document.currentCredentialHandle)
    })
  }

  async delete(credentialHandle: string): Promise<void> {
    return this.#exclusive(async () => {
      assertProfileHandle(credentialHandle)
      const document = await this.#loadDocument()
      const index = document.profiles.findIndex(
        (profile) => profile.credentialHandle === credentialHandle
      )
      if (index < 0) throw new AccessProfileServiceError('not_found')

      document.profiles.splice(index, 1)
      if (document.currentCredentialHandle === credentialHandle) {
        // Endpoint changes must remain explicit; do not silently select another profile.
        document.currentCredentialHandle = null
      }
      await this.#saveDocument(document)
    })
  }

  async setCurrent(credentialHandle: string): Promise<PublicAccessProfile> {
    return this.#exclusive(async () => {
      assertProfileHandle(credentialHandle)
      const document = await this.#loadDocument()
      const profile = document.profiles.find(
        (candidate) => candidate.credentialHandle === credentialHandle
      )
      if (!profile) throw new AccessProfileServiceError('not_found')

      if (document.currentCredentialHandle !== credentialHandle) {
        document.currentCredentialHandle = credentialHandle
        await this.#saveDocument(document)
      }
      return toPublicProfile(profile, document.currentCredentialHandle)
    })
  }

  /** Main-process only. The result must be consumed directly by the trusted runtime adapter. */
  async getSecretForMain(credentialHandle: string): Promise<MainAccessProfileSecret> {
    return this.#exclusive(async () => {
      assertProfileHandle(credentialHandle)
      const document = await this.#loadDocument()
      const profile = document.profiles.find(
        (candidate) => candidate.credentialHandle === credentialHandle
      )
      if (!profile) throw new AccessProfileServiceError('not_found')
      if (profile.apiKey === null) throw new AccessProfileServiceError('missing_secret')

      return Object.freeze({
        credentialHandle: profile.credentialHandle,
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey
      })
    })
  }

  async #loadDocument(): Promise<AccessProfileDocument> {
    let serialized: string | null
    try {
      serialized = await this.#storage.read()
    } catch {
      throw new AccessProfileServiceError('storage_error')
    }

    if (serialized === null) return createEmptyDocument()
    if (
      typeof serialized !== 'string' ||
      serialized.length === 0 ||
      serialized.length > MAX_DOCUMENT_CHARACTERS
    ) {
      throw new AccessProfileServiceError('corrupt_data')
    }

    let value: unknown
    try {
      value = JSON.parse(serialized)
    } catch {
      throw new AccessProfileServiceError('corrupt_data')
    }
    return parseDocument(value)
  }

  async #saveDocument(document: AccessProfileDocument): Promise<void> {
    // Re-validate before persisting so an internal mutation cannot weaken the storage boundary.
    const strictDocument = parseDocument(document)
    const serialized = JSON.stringify(strictDocument)
    if (serialized.length > MAX_DOCUMENT_CHARACTERS) {
      throw new AccessProfileServiceError('invalid_input')
    }
    try {
      await this.#storage.write(serialized)
    } catch {
      throw new AccessProfileServiceError('storage_error')
    }
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#operationTail
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    this.#operationTail = previous.then(
      () => gate,
      () => gate
    )

    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

function createEmptyDocument(): AccessProfileDocument {
  return {
    format: DOCUMENT_FORMAT,
    version: DOCUMENT_VERSION,
    currentCredentialHandle: null,
    profiles: []
  }
}

function parseDocument(value: unknown): AccessProfileDocument {
  if (!isExactRecord(value, ['format', 'version', 'currentCredentialHandle', 'profiles'])) {
    throw new AccessProfileServiceError('corrupt_data')
  }
  if (
    value.format !== DOCUMENT_FORMAT ||
    value.version !== DOCUMENT_VERSION ||
    (value.currentCredentialHandle !== null && !isProfileHandle(value.currentCredentialHandle)) ||
    !Array.isArray(value.profiles) ||
    value.profiles.length > MAX_PROFILES
  ) {
    throw new AccessProfileServiceError('corrupt_data')
  }

  const profiles = value.profiles.map(parseStoredProfile)
  const handles = new Set(profiles.map((profile) => profile.credentialHandle))
  if (handles.size !== profiles.length) throw new AccessProfileServiceError('corrupt_data')
  if (value.currentCredentialHandle !== null && !handles.has(value.currentCredentialHandle)) {
    throw new AccessProfileServiceError('corrupt_data')
  }

  return {
    format: DOCUMENT_FORMAT,
    version: DOCUMENT_VERSION,
    currentCredentialHandle: value.currentCredentialHandle,
    profiles
  }
}

function parseStoredProfile(value: unknown): StoredAccessProfile {
  if (
    !isExactRecord(value, [
      'credentialHandle',
      'name',
      'description',
      'baseUrl',
      'apiKey',
      'targets'
    ]) ||
    !isProfileHandle(value.credentialHandle) ||
    !isValidStoredText(value.name, 1, MAX_NAME_CHARACTERS) ||
    !isValidStoredText(value.description, 0, MAX_DESCRIPTION_CHARACTERS) ||
    !isValidStoredApiKey(value.apiKey) ||
    !isValidTargets(value.targets)
  ) {
    throw new AccessProfileServiceError('corrupt_data')
  }

  const normalizedBaseUrl = normalizeBaseUrl(value.baseUrl)
  if (normalizedBaseUrl === null || normalizedBaseUrl !== value.baseUrl) {
    throw new AccessProfileServiceError('corrupt_data')
  }

  return {
    credentialHandle: value.credentialHandle,
    name: value.name,
    description: value.description,
    baseUrl: value.baseUrl,
    apiKey: value.apiKey,
    targets: [...value.targets]
  }
}

function normalizeSaveInput(input: SaveProfileInput): NormalizedSaveInput {
  if (
    !isRecord(input) ||
    !hasOnlyAllowedKeys(input, [
      'credentialHandle',
      'name',
      'description',
      'baseUrl',
      'apiKey',
      'targets'
    ]) ||
    !hasOwn(input, 'name') ||
    !hasOwn(input, 'baseUrl') ||
    !hasOwn(input, 'targets')
  ) {
    throw new AccessProfileServiceError('invalid_input')
  }

  if (
    input.credentialHandle !== undefined &&
    !isProfileHandle(input.credentialHandle)
  ) {
    throw new AccessProfileServiceError('invalid_input')
  }
  const name = normalizeBoundedText(input.name, 1, MAX_NAME_CHARACTERS)
  const description =
    input.description === undefined
      ? ''
      : normalizeBoundedText(input.description, 0, MAX_DESCRIPTION_CHARACTERS)
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  if (name === null || description === null || baseUrl === null || !isValidTargets(input.targets)) {
    throw new AccessProfileServiceError('invalid_input')
  }
  if (input.apiKey !== undefined && !isValidApiKey(input.apiKey)) {
    throw new AccessProfileServiceError('invalid_input')
  }

  return {
    credentialHandle: input.credentialHandle,
    name,
    description,
    baseUrl,
    apiKey: input.apiKey,
    targets: [...input.targets]
  }
}

function toPublicProfile(
  profile: StoredAccessProfile,
  currentCredentialHandle: string | null
): PublicAccessProfile {
  return {
    credentialHandle: profile.credentialHandle,
    name: profile.name,
    description: profile.description,
    baseUrl: profile.baseUrl,
    hasKey: profile.apiKey !== null,
    isCurrent: profile.credentialHandle === currentCredentialHandle,
    targets: [...profile.targets]
  }
}

function createUniqueHandle(profiles: readonly StoredAccessProfile[]): string {
  const existing = new Set(profiles.map((profile) => profile.credentialHandle))
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let handle: string
    try {
      handle = `profile:${randomUUID()}`
    } catch {
      throw new AccessProfileServiceError('storage_error')
    }
    if (!existing.has(handle)) return handle
  }
  throw new AccessProfileServiceError('storage_error')
}

function normalizeBaseUrl(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_BASE_URL_CHARACTERS ||
    value !== value.trim() ||
    value.includes('?') ||
    value.includes('#') ||
    (!value.startsWith('https://') && !value.startsWith('http://'))
  ) {
    return null
  }

  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    return null
  }
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:')
  ) {
    return null
  }

  if (endpoint.protocol === 'http:') {
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname.toLowerCase())
    if (!loopback || !isExactHttpLoopbackSpelling(value)) return null
  }

  const normalized = endpoint.toString()
  return normalized.length <= MAX_BASE_URL_CHARACTERS ? normalized : null
}

function isExactHttpLoopbackSpelling(value: string): boolean {
  return /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:\/|$)/.test(value)
}

function normalizeBoundedText(
  value: unknown,
  minimumLength: number,
  maximumLength: number
): string | null {
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    return null
  }
  const normalized = value.trim()
  if (normalized.length < minimumLength || normalized.length > maximumLength) return null
  return normalized
}

function isValidStoredText(value: unknown, minimumLength: number, maximumLength: number): value is string {
  if (typeof value !== 'string') return false
  return normalizeBoundedText(value, minimumLength, maximumLength) === value
}

function isValidApiKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_API_KEY_CHARACTERS &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function isValidStoredApiKey(value: unknown): value is string | null {
  return value === null || isValidApiKey(value)
}

function isValidTargets(value: unknown): value is AccessTarget[] {
  if (!Array.isArray(value) || value.length > ALLOWED_TARGETS.length) return false
  const targets = new Set<AccessTarget>()
  for (const target of value) {
    if (!ALLOWED_TARGETS.includes(target as AccessTarget) || targets.has(target as AccessTarget)) {
      return false
    }
    targets.add(target as AccessTarget)
  }
  return true
}

function assertProfileHandle(value: unknown): asserts value is string {
  if (!isProfileHandle(value)) throw new AccessProfileServiceError('invalid_input')
}

function isProfileHandle(value: unknown): value is string {
  return typeof value === 'string' && PROFILE_HANDLE_PATTERN.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExactRecord(value: unknown, expectedKeys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const actualKeys = Object.keys(value)
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  )
}

function hasOnlyAllowedKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key))
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key)
}

function assertMainProcess(): void {
  const processWithType = process as NodeJS.Process & { type?: string }
  if (processWithType.type === 'renderer') {
    throw new AccessProfileServiceError('invalid_configuration')
  }
}
