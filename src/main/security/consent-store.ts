import { randomBytes, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'

export const LOCAL_TOOL_OPERATION_CATEGORIES = [
  'read',
  'enumerate',
  'search',
  'write',
  'open',
  'execute'
] as const

export type LocalToolOperationCategory = (typeof LOCAL_TOOL_OPERATION_CATEGORIES)[number]

export interface EndpointConsentGrant {
  consentHandle: string
  endpoint: string
}

export interface LocalToolApprovalGrant {
  approvalHandle: string
  expiresAt: number
}

export type ConsentValidationErrorCode =
  | 'invalid_endpoint'
  | 'invalid_binding'
  | 'consent_capacity_exceeded'

const CONSENT_ERROR_MESSAGES: Readonly<Record<ConsentValidationErrorCode, string>> = {
  invalid_endpoint: 'Endpoint rejected by transport policy.',
  invalid_binding: 'Consent binding is invalid.',
  consent_capacity_exceeded: 'Consent capability unavailable.'
}

export class ConsentValidationError extends Error {
  readonly code: ConsentValidationErrorCode

  constructor(code: ConsentValidationErrorCode) {
    super(CONSENT_ERROR_MESSAGES[code])
    this.name = 'ConsentValidationError'
    this.code = code
    this.stack = `${this.name}: ${this.message}`
  }
}

interface EndpointConsentRecord {
  endpoint: string
}

interface LocalToolApprovalRecord {
  workspaceToken: string
  operation: LocalToolOperationCategory
  requestDigest: string
  expiresAt: number
}

export interface ConsentStoreOptions {
  now?: () => number
  localApprovalTtlMs?: number
}

const ENDPOINT_HANDLE_PREFIX = 'epc_'
const APPROVAL_HANDLE_PREFIX = 'ltc_'
const RANDOM_HANDLE_LENGTH = 43
const ENDPOINT_HANDLE_PATTERN = /^epc_[A-Za-z0-9_-]{43}$/
const APPROVAL_HANDLE_PATTERN = /^ltc_[A-Za-z0-9_-]{43}$/
const REQUEST_DIGEST_PATTERN = /^[a-f0-9]{64}$/
const WORKSPACE_TOKEN_PATTERN = /^[A-Za-z0-9._:-]{8,256}$/
const MAX_ENDPOINT_LENGTH = 2_048
const MAX_ENDPOINT_CONSENTS = 64
const MAX_LOCAL_APPROVALS = 1_024
const DEFAULT_LOCAL_APPROVAL_TTL_MS = 2 * 60_000
const MIN_LOCAL_APPROVAL_TTL_MS = 1_000
const MAX_LOCAL_APPROVAL_TTL_MS = 10 * 60_000
const SENSITIVE_QUERY_KEY =
  /key|auth|code|sig|token|credential|password|passwd|pwd|secret|cookie|session|bearer|jwt/i

const operationCategories = new Set<string>(LOCAL_TOOL_OPERATION_CATEGORIES)

export function normalizeEndpoint(rawEndpoint: unknown): string {
  if (
    typeof rawEndpoint !== 'string' ||
    rawEndpoint.length < 1 ||
    rawEndpoint.length > MAX_ENDPOINT_LENGTH ||
    rawEndpoint !== rawEndpoint.trim() ||
    /[\u0000-\u0020\u007f\\]/u.test(rawEndpoint) ||
    !/^https?:\/\//iu.test(rawEndpoint)
  ) {
    invalidEndpoint()
  }

  let endpoint: URL
  try {
    endpoint = new URL(rawEndpoint)
  } catch {
    invalidEndpoint()
  }

  if (
    !['https:', 'http:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    rawEndpoint.includes('#') ||
    endpoint.hash ||
    (endpoint.protocol === 'http:' && !isLoopbackHostname(endpoint.hostname))
  ) {
    invalidEndpoint()
  }

  for (const key of endpoint.searchParams.keys()) {
    const compactKey = key.normalize('NFKC').replace(/[^A-Za-z0-9]/g, '')
    if (!compactKey || SENSITIVE_QUERY_KEY.test(compactKey)) invalidEndpoint()
  }

  return endpoint.toString()
}

export class ConsentStore {
  readonly #endpointConsents = new Map<string, EndpointConsentRecord>()
  readonly #localApprovals = new Map<string, LocalToolApprovalRecord>()
  readonly #now: () => number
  readonly #localApprovalTtlMs: number

  constructor(options: ConsentStoreOptions = {}) {
    const candidate: unknown = options
    if (!isPlainRecord(candidate)) invalidBinding()
    const keys = Object.keys(candidate)
    if (keys.some((key) => key !== 'now' && key !== 'localApprovalTtlMs')) invalidBinding()
    const now = candidate.now
    if (now !== undefined && typeof now !== 'function') invalidBinding()

    const ttlMs = candidate.localApprovalTtlMs ?? DEFAULT_LOCAL_APPROVAL_TTL_MS
    if (
      typeof ttlMs !== 'number' ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < MIN_LOCAL_APPROVAL_TTL_MS ||
      ttlMs > MAX_LOCAL_APPROVAL_TTL_MS
    ) {
      invalidBinding()
    }

    this.#now = (now as (() => number) | undefined) ?? Date.now
    this.#localApprovalTtlMs = ttlMs
    this.#readNow()
  }

  confirmEndpoint(rawEndpoint: unknown): EndpointConsentGrant {
    const endpoint = normalizeEndpoint(rawEndpoint)
    if (this.#endpointConsents.size >= MAX_ENDPOINT_CONSENTS) capacityExceeded()

    const consentHandle = issueHandle(ENDPOINT_HANDLE_PREFIX, this.#endpointConsents)
    this.#endpointConsents.set(consentHandle, { endpoint })
    return { consentHandle, endpoint }
  }

  authorizeEndpoint(input: unknown): string | null {
    if (!hasExactKeys(input, ['consentHandle', 'endpoint'])) return null
    if (!isHandle(input.consentHandle, ENDPOINT_HANDLE_PATTERN)) return null

    let endpoint: string
    try {
      endpoint = normalizeEndpoint(input.endpoint)
    } catch {
      return null
    }

    const record = this.#endpointConsents.get(input.consentHandle)
    if (!record || !constantTimeTextEqual(record.endpoint, endpoint)) return null
    return record.endpoint
  }

  revokeEndpointConsent(consentHandle: unknown): boolean {
    if (!isHandle(consentHandle, ENDPOINT_HANDLE_PATTERN)) return false
    return this.#endpointConsents.delete(consentHandle)
  }

  issueLocalToolApproval(input: unknown): LocalToolApprovalGrant {
    const binding = parseLocalToolBinding(input)
    const now = this.#readNow()
    this.#deleteExpiredApprovals(now)
    if (this.#localApprovals.size >= MAX_LOCAL_APPROVALS) capacityExceeded()

    const approvalHandle = issueHandle(APPROVAL_HANDLE_PREFIX, this.#localApprovals)
    const expiresAt = now + this.#localApprovalTtlMs
    if (!Number.isSafeInteger(expiresAt)) invalidBinding()

    this.#localApprovals.set(approvalHandle, { ...binding, expiresAt })
    return { approvalHandle, expiresAt }
  }

  consumeLocalToolApproval(input: unknown): boolean {
    if (!hasExactKeys(input, ['approvalHandle', 'workspaceToken', 'operation', 'requestDigest'])) {
      return false
    }
    if (!isHandle(input.approvalHandle, APPROVAL_HANDLE_PATTERN)) return false

    const record = this.#localApprovals.get(input.approvalHandle)
    if (!record) return false

    // A redemption attempt consumes the capability even when its binding is wrong.
    this.#localApprovals.delete(input.approvalHandle)

    let binding: ReturnType<typeof parseLocalToolBinding>
    try {
      binding = parseLocalToolBinding({
        workspaceToken: input.workspaceToken,
        operation: input.operation,
        requestDigest: input.requestDigest
      })
    } catch {
      return false
    }

    const now = this.#readNow()
    return (
      record.expiresAt > now &&
      constantTimeTextEqual(record.workspaceToken, binding.workspaceToken) &&
      record.operation === binding.operation &&
      constantTimeTextEqual(record.requestDigest, binding.requestDigest)
    )
  }

  clear(): void {
    this.#endpointConsents.clear()
    this.#localApprovals.clear()
  }

  #deleteExpiredApprovals(now: number): void {
    for (const [handle, record] of this.#localApprovals) {
      if (record.expiresAt <= now) this.#localApprovals.delete(handle)
    }
  }

  #readNow(): number {
    const now = this.#now()
    if (!Number.isSafeInteger(now) || now < 0) invalidBinding()
    return now
  }
}

function parseLocalToolBinding(input: unknown): {
  workspaceToken: string
  operation: LocalToolOperationCategory
  requestDigest: string
} {
  if (!hasExactKeys(input, ['workspaceToken', 'operation', 'requestDigest'])) invalidBinding()
  if (typeof input.workspaceToken !== 'string' || !WORKSPACE_TOKEN_PATTERN.test(input.workspaceToken)) {
    invalidBinding()
  }
  if (typeof input.operation !== 'string' || !operationCategories.has(input.operation)) {
    invalidBinding()
  }
  if (typeof input.requestDigest !== 'string' || !REQUEST_DIGEST_PATTERN.test(input.requestDigest)) {
    invalidBinding()
  }
  return {
    workspaceToken: input.workspaceToken,
    operation: input.operation as LocalToolOperationCategory,
    requestDigest: input.requestDigest
  }
}

function isLoopbackHostname(hostname: string): boolean {
  let normalized = hostname.toLowerCase()
  if (normalized.startsWith('[') && normalized.endsWith(']')) normalized = normalized.slice(1, -1)
  if (normalized === 'localhost') return true
  const ipVersion = isIP(normalized)
  if (ipVersion === 4) return normalized.split('.')[0] === '127'
  return ipVersion === 6 && normalized === '::1'
}

function issueHandle(prefix: string, records: ReadonlyMap<string, unknown>): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const handle = `${prefix}${randomBytes(32).toString('base64url')}`
    if (handle.length === prefix.length + RANDOM_HANDLE_LENGTH && !records.has(handle)) return handle
  }
  throw new ConsentValidationError('consent_capacity_exceeded')
}

function isHandle(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && value.length <= 64 && pattern.test(value)
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys<K extends string>(value: unknown, expectedKeys: readonly K[]): value is Record<K, unknown> {
  if (!isPlainRecord(value)) return false
  const actualKeys = Object.keys(value)
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  )
}

function invalidEndpoint(): never {
  throw new ConsentValidationError('invalid_endpoint')
}

function invalidBinding(): never {
  throw new ConsentValidationError('invalid_binding')
}

function capacityExceeded(): never {
  throw new ConsentValidationError('consent_capacity_exceeded')
}
