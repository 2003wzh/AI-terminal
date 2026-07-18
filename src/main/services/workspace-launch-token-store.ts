import { randomBytes } from 'node:crypto'

import {
  isWorkspaceOpenerId,
  type WorkspaceOpenerId
} from '../../shared/contracts.ts'

interface WorkspaceLaunchTokenRecord {
  readonly ownerWebContentsId: number
  readonly workspaceToken: string
  readonly allowedOpeners: ReadonlySet<WorkspaceOpenerId>
  readonly expiresAt: number
}

export interface WorkspaceLaunchTokenStoreOptions {
  readonly now?: () => number
  readonly tokenLifetimeMs?: number
  readonly maxRecords?: number
  readonly launchWindowMs?: number
  readonly maxLaunchesPerWindow?: number
}

export type WorkspaceLaunchAuthorizationResult = 'authorized' | 'invalid' | 'rate_limited'

const TOKEN_PREFIX = 'wl_'
const TOKEN_PATTERN = /^wl_[A-Za-z0-9_-]{43}$/u
const WORKSPACE_TOKEN_PATTERN = /^ws_[A-Za-z0-9_-]{43}$/u
const DEFAULT_TOKEN_LIFETIME_MS = 60_000
const MAX_TOKEN_LIFETIME_MS = 5 * 60_000
const DEFAULT_MAX_RECORDS = 128
const MAX_CONFIGURED_RECORDS = 512
const DEFAULT_LAUNCH_WINDOW_MS = 10_000
const MAX_LAUNCH_WINDOW_MS = 60_000
const DEFAULT_MAX_LAUNCHES_PER_WINDOW = 8
const MAX_CONFIGURED_LAUNCHES_PER_WINDOW = 32
const TOKEN_ATTEMPTS = 8

export class WorkspaceLaunchTokenStore {
  readonly #records = new Map<string, WorkspaceLaunchTokenRecord>()
  readonly #launchesByOwner = new Map<number, number[]>()
  readonly #now: () => number
  readonly #tokenLifetimeMs: number
  readonly #maxRecords: number
  readonly #launchWindowMs: number
  readonly #maxLaunchesPerWindow: number

  constructor(options: WorkspaceLaunchTokenStoreOptions = {}) {
    if (!isPlainRecord(options)) throw new TypeError('Invalid workspace launch token options.')
    if (Object.keys(options).some((key) => ![
      'now',
      'tokenLifetimeMs',
      'maxRecords',
      'launchWindowMs',
      'maxLaunchesPerWindow'
    ].includes(key))) {
      throw new TypeError('Invalid workspace launch token options.')
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new TypeError('Invalid workspace launch token options.')
    }
    this.#now = (options.now as (() => number) | undefined) ?? Date.now
    this.#tokenLifetimeMs = configuredInteger(
      options.tokenLifetimeMs as number | undefined,
      DEFAULT_TOKEN_LIFETIME_MS,
      1,
      MAX_TOKEN_LIFETIME_MS
    )
    this.#maxRecords = configuredInteger(
      options.maxRecords as number | undefined,
      DEFAULT_MAX_RECORDS,
      1,
      MAX_CONFIGURED_RECORDS
    )
    this.#launchWindowMs = configuredInteger(
      options.launchWindowMs as number | undefined,
      DEFAULT_LAUNCH_WINDOW_MS,
      1,
      MAX_LAUNCH_WINDOW_MS
    )
    this.#maxLaunchesPerWindow = configuredInteger(
      options.maxLaunchesPerWindow as number | undefined,
      DEFAULT_MAX_LAUNCHES_PER_WINDOW,
      1,
      MAX_CONFIGURED_LAUNCHES_PER_WINDOW
    )
    this.#readNow()
  }

  issue(
    workspaceToken: unknown,
    ownerWebContentsId: unknown,
    allowedOpeners: readonly WorkspaceOpenerId[]
  ): string | null {
    if (
      typeof workspaceToken !== 'string' ||
      !WORKSPACE_TOKEN_PATTERN.test(workspaceToken) ||
      !isValidOwner(ownerWebContentsId) ||
      !Array.isArray(allowedOpeners) ||
      allowedOpeners.some((openerId) => !isWorkspaceOpenerId(openerId))
    ) {
      return null
    }
    const now = this.#readNow()
    this.#prune(now)
    if (this.#records.size >= this.#maxRecords) return null

    let launchToken: string
    try {
      launchToken = this.#issueToken()
    } catch {
      return null
    }
    const expiresAt = now + this.#tokenLifetimeMs
    if (!Number.isSafeInteger(expiresAt)) return null
    this.#records.set(launchToken, Object.freeze({
      ownerWebContentsId,
      workspaceToken,
      allowedOpeners: new Set(allowedOpeners),
      expiresAt
    }))
    return launchToken
  }

  consume(input: {
    readonly launchToken: unknown
    readonly workspaceToken: unknown
    readonly openerId: unknown
    readonly ownerWebContentsId: unknown
  }): WorkspaceLaunchAuthorizationResult {
    if (
      !isPlainRecord(input) ||
      typeof input.launchToken !== 'string' ||
      !TOKEN_PATTERN.test(input.launchToken) ||
      typeof input.workspaceToken !== 'string' ||
      !WORKSPACE_TOKEN_PATTERN.test(input.workspaceToken) ||
      !isWorkspaceOpenerId(input.openerId) ||
      !isValidOwner(input.ownerWebContentsId)
    ) {
      return 'invalid'
    }
    const record = this.#records.get(input.launchToken)
    if (!record || record.ownerWebContentsId !== input.ownerWebContentsId) return 'invalid'

    // A token presented by its owning window is one-shot even when a binding is wrong.
    this.#records.delete(input.launchToken)
    const now = this.#readNow()
    if (
      record.expiresAt <= now ||
      record.workspaceToken !== input.workspaceToken ||
      !record.allowedOpeners.has(input.openerId)
    ) {
      return 'invalid'
    }

    const launches = this.#recentLaunches(input.ownerWebContentsId, now)
    if (launches.length >= this.#maxLaunchesPerWindow) return 'rate_limited'
    launches.push(now)
    this.#launchesByOwner.set(input.ownerWebContentsId, launches)
    return 'authorized'
  }

  revokeOwner(ownerWebContentsId: unknown): void {
    if (!isValidOwner(ownerWebContentsId)) return
    for (const [token, record] of this.#records) {
      if (record.ownerWebContentsId === ownerWebContentsId) this.#records.delete(token)
    }
    this.#launchesByOwner.delete(ownerWebContentsId)
  }

  clear(): void {
    this.#records.clear()
    this.#launchesByOwner.clear()
  }

  #issueToken(): string {
    for (let attempt = 0; attempt < TOKEN_ATTEMPTS; attempt += 1) {
      const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
      if (TOKEN_PATTERN.test(token) && !this.#records.has(token)) return token
    }
    throw new Error('Workspace launch token capacity is unavailable.')
  }

  #prune(now: number): void {
    for (const [token, record] of this.#records) {
      if (record.expiresAt <= now) this.#records.delete(token)
    }
    for (const ownerWebContentsId of this.#launchesByOwner.keys()) {
      const recent = this.#recentLaunches(ownerWebContentsId, now)
      if (recent.length === 0) this.#launchesByOwner.delete(ownerWebContentsId)
      else this.#launchesByOwner.set(ownerWebContentsId, recent)
    }
  }

  #recentLaunches(ownerWebContentsId: number, now: number): number[] {
    const cutoff = now - this.#launchWindowMs
    return (this.#launchesByOwner.get(ownerWebContentsId) ?? []).filter(
      (timestamp) => timestamp > cutoff && timestamp <= now
    )
  }

  #readNow(): number {
    const now = this.#now()
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError('Invalid workspace launch token clock.')
    }
    return now
  }
}

function configuredInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const configured = value ?? fallback
  if (!Number.isSafeInteger(configured) || configured < minimum || configured > maximum) {
    throw new TypeError('Invalid workspace launch token options.')
  }
  return configured
}

function isValidOwner(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
