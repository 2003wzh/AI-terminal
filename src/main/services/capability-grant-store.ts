import { randomBytes, timingSafeEqual } from 'node:crypto'

export type CapabilityGrantKind = 'skill' | 'plugin'
export type CapabilityGrantScope = 'user' | 'workspace'

export interface CapabilityGrantIdentity {
  readonly device: string
  readonly inode: string
}

export interface CapabilityGrantFileIdentity extends CapabilityGrantIdentity {
  readonly size: number
  readonly mtimeMs: number
  readonly contentSha256: string
}

interface CapabilityGrantBindingBase {
  readonly ownerWebContentsId: number
  readonly kind: CapabilityGrantKind
  readonly id: string
  readonly scope: CapabilityGrantScope
  readonly relativePath: string
  readonly root: CapabilityGrantIdentity
  readonly file: CapabilityGrantFileIdentity
}

export type CapabilityGrantIssueInput =
  | (CapabilityGrantBindingBase & {
      readonly scope: 'user'
      readonly workspace: null
    })
  | (CapabilityGrantBindingBase & {
      readonly scope: 'workspace'
      readonly workspace: CapabilityGrantIdentity
    })

export type CapabilityGrantConsumeInput = CapabilityGrantIssueInput & {
  readonly grantHandle: string
}

export interface CapabilityGrantIssueResult {
  readonly grantHandle: string
  readonly expiresAt: number
}

export interface CapabilityGrantPeekResult {
  readonly grantHandle: string
  readonly kind: CapabilityGrantKind
  readonly id: string
  readonly scope: CapabilityGrantScope
  readonly relativePath: string
  readonly root: CapabilityGrantIdentity
  readonly file: CapabilityGrantFileIdentity
  readonly workspace: CapabilityGrantIdentity | null
  readonly expiresAt: number
}

export interface CapabilityGrantStoreOptions {
  readonly now?: () => number
  readonly grantTtlMs?: number
  readonly maxRecords?: number
}

export type CapabilityGrantStoreErrorCode =
  | 'invalid_binding'
  | 'invalid_options'
  | 'grant_capacity_exceeded'

const ERROR_MESSAGES: Readonly<Record<CapabilityGrantStoreErrorCode, string>> = Object.freeze({
  invalid_binding: 'The capability grant binding is invalid.',
  invalid_options: 'The capability grant options are invalid.',
  grant_capacity_exceeded: 'The capability grant is temporarily unavailable.'
})

export class CapabilityGrantStoreError extends Error {
  readonly code: CapabilityGrantStoreErrorCode

  constructor(code: CapabilityGrantStoreErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'CapabilityGrantStoreError'
    this.code = code
    this.stack = `${this.name}: ${this.message}`
  }
}

type CapabilityGrantRecord = CapabilityGrantIssueInput & {
  readonly expiresAt: number
}

const GRANT_HANDLE_PREFIX = 'cap_'
const GRANT_HANDLE_PATTERN = /^cap_[A-Za-z0-9_-]{43}$/u
const RANDOM_HANDLE_LENGTH = 43
const HANDLE_ATTEMPTS = 8
const DEFAULT_GRANT_TTL_MS = 2 * 60_000
const MAX_GRANT_TTL_MS = 10 * 60_000
const DEFAULT_MAX_RECORDS = 1_024
const MAX_CONFIGURED_RECORDS = 4_096
const MAX_CAPABILITY_ID_LENGTH = 128
const MAX_RELATIVE_PATH_LENGTH = 512
const CAPABILITY_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/u
const IDENTITY_PATTERN = /^[1-9][0-9]{0,63}$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const ISSUE_KEYS = Object.freeze([
  'ownerWebContentsId',
  'kind',
  'id',
  'scope',
  'relativePath',
  'root',
  'file',
  'workspace'
] as const)
const CONSUME_KEYS = Object.freeze([...ISSUE_KEYS, 'grantHandle'] as const)

export class CapabilityGrantStore {
  readonly #records = new Map<string, CapabilityGrantRecord>()
  readonly #now: () => number
  readonly #grantTtlMs: number
  readonly #maxRecords: number

  constructor(options: CapabilityGrantStoreOptions = {}) {
    const parsedOptions = parseStoreOptions(options)
    this.#grantTtlMs = configuredInteger(
      parsedOptions.grantTtlMs,
      DEFAULT_GRANT_TTL_MS,
      1,
      MAX_GRANT_TTL_MS
    )
    this.#maxRecords = configuredInteger(
      parsedOptions.maxRecords,
      DEFAULT_MAX_RECORDS,
      1,
      MAX_CONFIGURED_RECORDS
    )
    this.#now = parsedOptions.now ?? Date.now
    this.#readNow('invalid_options')
  }

  issue(input: unknown): CapabilityGrantIssueResult {
    let binding: CapabilityGrantIssueInput
    try {
      binding = parseIssueBinding(input)
    } catch {
      throw new CapabilityGrantStoreError('invalid_binding')
    }
    const now = this.#readNow('invalid_binding')
    this.#pruneExpired(now)
    if (this.#records.size >= this.#maxRecords) {
      throw new CapabilityGrantStoreError('grant_capacity_exceeded')
    }

    const expiresAt = now + this.#grantTtlMs
    if (!Number.isSafeInteger(expiresAt)) {
      throw new CapabilityGrantStoreError('invalid_binding')
    }
    const grantHandle = this.#issueHandle()
    this.#records.set(grantHandle, freezeRecord(binding, expiresAt))
    return Object.freeze({ grantHandle, expiresAt })
  }

  peek(grantHandle: unknown, ownerWebContentsId: unknown): CapabilityGrantPeekResult | null {
    if (!isGrantHandle(grantHandle) || !isValidOwner(ownerWebContentsId)) return null
    const record = this.#records.get(grantHandle)
    if (!record || record.ownerWebContentsId !== ownerWebContentsId) return null
    if (record.expiresAt <= this.#readNow('invalid_binding')) {
      this.#records.delete(grantHandle)
      return null
    }
    return freezePeekResult(grantHandle, record)
  }

  consume(input: unknown): boolean {
    const grantHandle = readGrantHandle(input)
    if (!grantHandle) return false
    const record = this.#records.get(grantHandle)
    if (!record) return false

    // Every redemption attempt is one-shot, including malformed or mismatched
    // bindings. Delete before parsing any renderer-controlled binding fields.
    this.#records.delete(grantHandle)

    let binding: CapabilityGrantIssueInput
    try {
      binding = parseConsumeBinding(input)
    } catch {
      return false
    }

    const now = this.#readNow('invalid_binding')
    return record.expiresAt > now && bindingsEqual(record, binding)
  }

  revokeOwner(ownerWebContentsId: unknown): void {
    if (!isValidOwner(ownerWebContentsId)) return
    for (const [grantHandle, record] of this.#records) {
      if (record.ownerWebContentsId === ownerWebContentsId) {
        this.#records.delete(grantHandle)
      }
    }
  }

  clear(): void {
    this.#records.clear()
  }

  #issueHandle(): string {
    for (let attempt = 0; attempt < HANDLE_ATTEMPTS; attempt += 1) {
      let grantHandle: string
      try {
        grantHandle = `${GRANT_HANDLE_PREFIX}${randomBytes(32).toString('base64url')}`
      } catch {
        break
      }
      if (
        grantHandle.length === GRANT_HANDLE_PREFIX.length + RANDOM_HANDLE_LENGTH &&
        GRANT_HANDLE_PATTERN.test(grantHandle) &&
        !this.#records.has(grantHandle)
      ) {
        return grantHandle
      }
    }
    throw new CapabilityGrantStoreError('grant_capacity_exceeded')
  }

  #pruneExpired(now: number): void {
    for (const [grantHandle, record] of this.#records) {
      if (record.expiresAt <= now) this.#records.delete(grantHandle)
    }
  }

  #readNow(errorCode: 'invalid_binding' | 'invalid_options'): number {
    let now: unknown
    try {
      now = this.#now()
    } catch {
      throw new CapabilityGrantStoreError(errorCode)
    }
    if (!Number.isSafeInteger(now) || Number(now) < 0) {
      throw new CapabilityGrantStoreError(errorCode)
    }
    return Number(now)
  }
}

function parseConsumeBinding(input: unknown): CapabilityGrantIssueInput {
  if (!hasExactKeys(input, CONSUME_KEYS)) invalidBinding()
  return parseIssueBinding({
    ownerWebContentsId: input.ownerWebContentsId,
    kind: input.kind,
    id: input.id,
    scope: input.scope,
    relativePath: input.relativePath,
    root: input.root,
    file: input.file,
    workspace: input.workspace
  })
}

function parseIssueBinding(input: unknown): CapabilityGrantIssueInput {
  if (!hasExactKeys(input, ISSUE_KEYS)) invalidBinding()
  if (!isValidOwner(input.ownerWebContentsId)) invalidBinding()
  if (input.kind !== 'skill' && input.kind !== 'plugin') invalidBinding()
  if (input.scope !== 'user' && input.scope !== 'workspace') invalidBinding()
  if (
    typeof input.id !== 'string' ||
    input.id.length < 1 ||
    input.id.length > MAX_CAPABILITY_ID_LENGTH ||
    !CAPABILITY_ID_PATTERN.test(input.id) ||
    !input.id.startsWith(`${input.kind}:${input.scope}:`)
  ) {
    invalidBinding()
  }
  if (!isSafeRelativePath(input.relativePath)) invalidBinding()

  const root = parseIdentity(input.root)
  const file = parseFileIdentity(input.file)
  if (input.scope === 'workspace') {
    const workspace = parseIdentity(input.workspace)
    if (!identityEqual(root, workspace)) invalidBinding()
    return freezeBinding({
      ownerWebContentsId: input.ownerWebContentsId,
      kind: input.kind,
      id: input.id,
      scope: input.scope,
      relativePath: input.relativePath,
      root,
      file,
      workspace
    })
  }
  if (input.workspace !== null) invalidBinding()
  return freezeBinding({
    ownerWebContentsId: input.ownerWebContentsId,
    kind: input.kind,
    id: input.id,
    scope: input.scope,
    relativePath: input.relativePath,
    root,
    file,
    workspace: null
  })
}

function parseIdentity(input: unknown): CapabilityGrantIdentity {
  if (!hasExactKeys(input, ['device', 'inode'])) invalidBinding()
  if (!isIdentityPart(input.device) || !isIdentityPart(input.inode)) invalidBinding()
  return Object.freeze({ device: input.device, inode: input.inode })
}

function parseFileIdentity(input: unknown): CapabilityGrantFileIdentity {
  if (!hasExactKeys(input, ['device', 'inode', 'size', 'mtimeMs', 'contentSha256'])) {
    invalidBinding()
  }
  if (
    !isIdentityPart(input.device) ||
    !isIdentityPart(input.inode) ||
    typeof input.size !== 'number' ||
    !Number.isSafeInteger(input.size) ||
    input.size < 0 ||
    typeof input.mtimeMs !== 'number' ||
    !Number.isFinite(input.mtimeMs) ||
    input.mtimeMs < 0 ||
    input.mtimeMs > Number.MAX_SAFE_INTEGER ||
    typeof input.contentSha256 !== 'string' ||
    !SHA256_PATTERN.test(input.contentSha256)
  ) {
    invalidBinding()
  }
  return Object.freeze({
    device: input.device,
    inode: input.inode,
    size: input.size,
    mtimeMs: input.mtimeMs,
    contentSha256: input.contentSha256
  })
}

function freezeBinding(input: CapabilityGrantIssueInput): CapabilityGrantIssueInput {
  const root = Object.freeze({ ...input.root })
  const file = Object.freeze({ ...input.file })
  if (input.scope === 'workspace') {
    return Object.freeze({
      ...input,
      root,
      file,
      workspace: Object.freeze({ ...input.workspace })
    })
  }
  return Object.freeze({ ...input, root, file, workspace: null })
}

function freezeRecord(binding: CapabilityGrantIssueInput, expiresAt: number): CapabilityGrantRecord {
  return Object.freeze({ ...binding, expiresAt })
}

function freezePeekResult(
  grantHandle: string,
  record: CapabilityGrantRecord
): CapabilityGrantPeekResult {
  return Object.freeze({
    grantHandle,
    kind: record.kind,
    id: record.id,
    scope: record.scope,
    relativePath: record.relativePath,
    root: Object.freeze({ ...record.root }),
    file: Object.freeze({ ...record.file }),
    workspace: record.workspace === null
      ? null
      : Object.freeze({ ...record.workspace }),
    expiresAt: record.expiresAt
  })
}

function bindingsEqual(left: CapabilityGrantRecord, right: CapabilityGrantIssueInput): boolean {
  return left.ownerWebContentsId === right.ownerWebContentsId &&
    left.kind === right.kind &&
    constantTimeTextEqual(left.id, right.id) &&
    left.scope === right.scope &&
    constantTimeTextEqual(left.relativePath, right.relativePath) &&
    identityEqual(left.root, right.root) &&
    fileIdentityEqual(left.file, right.file) &&
    workspaceIdentityEqual(left.workspace, right.workspace)
}

function identityEqual(left: CapabilityGrantIdentity, right: CapabilityGrantIdentity): boolean {
  return constantTimeTextEqual(left.device, right.device) &&
    constantTimeTextEqual(left.inode, right.inode)
}

function fileIdentityEqual(
  left: CapabilityGrantFileIdentity,
  right: CapabilityGrantFileIdentity
): boolean {
  return identityEqual(left, right) &&
    left.size === right.size &&
    Object.is(left.mtimeMs, right.mtimeMs) &&
    constantTimeTextEqual(left.contentSha256, right.contentSha256)
}

function workspaceIdentityEqual(
  left: CapabilityGrantIdentity | null,
  right: CapabilityGrantIdentity | null
): boolean {
  if (left === null || right === null) return left === right
  return identityEqual(left, right)
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  if (leftBytes.length !== rightBytes.length) {
    // Still perform one fixed-length comparison before reporting a mismatch.
    const maximumLength = Math.max(leftBytes.length, rightBytes.length, 1)
    const paddedLeft = Buffer.alloc(maximumLength)
    const paddedRight = Buffer.alloc(maximumLength)
    leftBytes.copy(paddedLeft)
    rightBytes.copy(paddedRight)
    timingSafeEqual(paddedLeft, paddedRight)
    return false
  }
  return timingSafeEqual(leftBytes, rightBytes)
}

function isSafeRelativePath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_RELATIVE_PATH_LENGTH ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\') ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return false
  }
  const segments = value.split('/')
  return segments.every((segment) =>
    segment.length > 0 &&
    segment.length <= 120 &&
    segment !== '.' &&
    segment !== '..' &&
    !/[<>:"|?*]/u.test(segment) &&
    !segment.endsWith('.') &&
    !segment.endsWith(' ')
  )
}

function isIdentityPart(value: unknown): value is string {
  return typeof value === 'string' && IDENTITY_PATTERN.test(value)
}

function isGrantHandle(value: unknown): value is string {
  return typeof value === 'string' && value.length === 47 && GRANT_HANDLE_PATTERN.test(value)
}

function readGrantHandle(value: unknown): string | null {
  if (!isPlainRecord(value)) return null
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'grantHandle')
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value') ||
      !isGrantHandle(descriptor.value)
    ) {
      return null
    }
    return descriptor.value
  } catch {
    return null
  }
}

function isValidOwner(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function configuredInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const candidate = value ?? fallback
  if (
    typeof candidate !== 'number' ||
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw new CapabilityGrantStoreError('invalid_options')
  }
  return candidate
}

function parseStoreOptions(input: unknown): {
  readonly now?: () => number
  readonly grantTtlMs?: number
  readonly maxRecords?: number
} {
  try {
    if (!hasExactOptionalKeys(input, ['now', 'grantTtlMs', 'maxRecords'])) {
      throw new CapabilityGrantStoreError('invalid_options')
    }
    const now = input.now
    const grantTtlMs = input.grantTtlMs
    const maxRecords = input.maxRecords
    if (
      now !== undefined && typeof now !== 'function' ||
      grantTtlMs !== undefined && typeof grantTtlMs !== 'number' ||
      maxRecords !== undefined && typeof maxRecords !== 'number'
    ) {
      throw new CapabilityGrantStoreError('invalid_options')
    }
    return {
      ...(now === undefined ? {} : { now: now as () => number }),
      ...(grantTtlMs === undefined ? {} : { grantTtlMs }),
      ...(maxRecords === undefined ? {} : { maxRecords })
    }
  } catch {
    throw new CapabilityGrantStoreError('invalid_options')
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function hasExactKeys<K extends string>(
  value: unknown,
  expectedKeys: readonly K[]
): value is Record<K, unknown> {
  if (!isPlainRecord(value)) return false
  try {
    const actualKeys = Reflect.ownKeys(value)
    if (
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key) => typeof key !== 'string') ||
      !expectedKeys.every((key) => Object.hasOwn(value, key))
    ) {
      return false
    }
    return actualKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return descriptor !== undefined &&
        descriptor.enumerable &&
        Object.hasOwn(descriptor, 'value')
    })
  } catch {
    return false
  }
}

function hasExactOptionalKeys<K extends string>(
  value: unknown,
  allowedKeys: readonly K[]
): value is Partial<Record<K, unknown>> {
  if (!isPlainRecord(value)) return false
  try {
    const actualKeys = Reflect.ownKeys(value)
    if (
      actualKeys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key as K))
    ) {
      return false
    }
    return actualKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return descriptor !== undefined &&
        descriptor.enumerable &&
        Object.hasOwn(descriptor, 'value')
    })
  } catch {
    return false
  }
}

function invalidBinding(): never {
  throw new CapabilityGrantStoreError('invalid_binding')
}
