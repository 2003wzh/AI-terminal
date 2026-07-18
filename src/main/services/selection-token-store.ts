import { randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, extname, isAbsolute, resolve } from 'node:path'

import type { AttachmentSelection, WorkspaceSelection } from '../../shared/contracts'

type SelectionKind = 'workspace' | 'attachment'

interface SelectionRecordBase {
  kind: SelectionKind
  ownerWebContentsId: number
  expiresAt: number
}

interface CanonicalWorkspace {
  absolutePath: string
  device: string
  inode: string
}

interface CanonicalAttachment {
  absolutePath: string
  device: number
  inode: number
  size: number
  modifiedAtMs: number
}

interface WorkspaceSelectionRecord extends SelectionRecordBase {
  kind: 'workspace'
  resolution: Promise<CanonicalWorkspace | null>
}

interface AttachmentSelectionRecord extends SelectionRecordBase {
  kind: 'attachment'
  absolutePath: string
  mediaKind: AttachmentSelection['mediaKind']
  resolution: Promise<CanonicalAttachment | null>
  reservationToken?: string
}

type SelectionRecord = WorkspaceSelectionRecord | AttachmentSelectionRecord

interface AttachmentReservationRecord {
  readonly ownerWebContentsId: number
  readonly attachmentTokens: readonly string[]
  readonly records: readonly AttachmentSelectionRecord[]
}

export interface ResolvedWorkspaceRecord {
  readonly workspaceToken: string
  readonly absolutePath: string
  readonly ownerWebContentsId: number
  readonly expiresAt: number
  readonly device: string
  readonly inode: string
}

export interface ResolvedAttachmentRecord {
  readonly absolutePath: string
  readonly ownerWebContentsId: number
  readonly device: number
  readonly inode: number
  readonly size: number
  readonly modifiedAtMs: number
}

export interface AttachmentSelectionReservation {
  readonly reservationToken: string
  readonly attachments: readonly ResolvedAttachmentRecord[]
}

export interface SelectionTokenStoreOptions {
  now?: () => number
  tokenLifetimeMs?: number
}

export type SelectionTokenErrorCode =
  | 'invalid_selection'
  | 'invalid_owner'
  | 'invalid_options'
  | 'selection_capacity_exceeded'

const SELECTION_ERROR_MESSAGES: Readonly<Record<SelectionTokenErrorCode, string>> = Object.freeze({
  invalid_selection: 'The local selection is invalid.',
  invalid_owner: 'The selection owner is invalid.',
  invalid_options: 'The selection token options are invalid.',
  selection_capacity_exceeded: 'The local selection capability is unavailable.'
})

export class SelectionTokenError extends Error {
  readonly code: SelectionTokenErrorCode

  constructor(code: SelectionTokenErrorCode) {
    super(SELECTION_ERROR_MESSAGES[code])
    this.name = 'SelectionTokenError'
    this.code = code
    this.stack = `${this.name}: ${this.message}`
  }
}

const TOKEN_LIFETIME_MS = 60 * 60 * 1000
const MIN_TOKEN_LIFETIME_MS = 1
const MAX_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000
const MAX_SELECTION_RECORDS = 2_048
const WORKSPACE_TOKEN_PREFIX = 'ws_'
const WORKSPACE_TOKEN_PATTERN = /^ws_[A-Za-z0-9_-]{43}$/u
const WORKSPACE_TOKEN_ATTEMPTS = 8
const ATTACHMENT_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const ATTACHMENT_RESERVATION_TOKEN_PREFIX = 'ar_'
const ATTACHMENT_RESERVATION_TOKEN_PATTERN = /^ar_[A-Za-z0-9_-]{43}$/u
const ATTACHMENT_RESERVATION_TOKEN_ATTEMPTS = 8
const MAX_ATTACHMENT_RESERVATION_SIZE = 16
const MAX_LOCAL_PATH_CHARACTERS = 32_768

export class SelectionTokenStore {
  readonly #records = new Map<string, SelectionRecord>()
  readonly #attachmentReservations = new Map<string, AttachmentReservationRecord>()
  readonly #now: () => number
  readonly #tokenLifetimeMs: number

  constructor(options: SelectionTokenStoreOptions = {}) {
    const candidate: unknown = options
    if (!isPlainRecord(candidate)) throw new SelectionTokenError('invalid_options')
    const keys = Object.keys(candidate)
    if (keys.some((key) => key !== 'now' && key !== 'tokenLifetimeMs')) {
      throw new SelectionTokenError('invalid_options')
    }
    const now = candidate.now
    if (now !== undefined && typeof now !== 'function') {
      throw new SelectionTokenError('invalid_options')
    }
    const tokenLifetimeMs = candidate.tokenLifetimeMs ?? TOKEN_LIFETIME_MS
    if (
      typeof tokenLifetimeMs !== 'number' ||
      !Number.isSafeInteger(tokenLifetimeMs) ||
      tokenLifetimeMs < MIN_TOKEN_LIFETIME_MS ||
      tokenLifetimeMs > MAX_TOKEN_LIFETIME_MS
    ) {
      throw new SelectionTokenError('invalid_options')
    }
    this.#now = (now as (() => number) | undefined) ?? Date.now
    this.#tokenLifetimeMs = tokenLifetimeMs
    this.#readNow()
  }

  issueWorkspace(absolutePath: string, ownerWebContentsId: number): WorkspaceSelection {
    validateOwner(ownerWebContentsId)
    validateWorkspaceCandidate(absolutePath)
    const now = this.#readNow()
    this.#pruneExpired(now)
    this.#assertCapacity()

    const workspaceToken = this.#issueWorkspaceToken()
    const expiresAt = safeExpiry(now, this.#tokenLifetimeMs)
    // Canonicalization intentionally happens asynchronously. The opaque token
    // can be returned to the Renderer immediately, but no Main-process caller
    // can resolve it until realpath and directory validation have completed.
    const resolution = canonicalizeWorkspace(absolutePath).catch(() => null)
    this.#records.set(workspaceToken, {
      kind: 'workspace',
      ownerWebContentsId,
      expiresAt,
      resolution
    })
    return {
      workspaceToken,
      displayName: safeDisplayName(absolutePath, 'Workspace')
    }
  }

  issueAttachment(absolutePath: string, ownerWebContentsId: number): AttachmentSelection {
    validateOwner(ownerWebContentsId)
    validateAttachmentCandidate(absolutePath)
    const now = this.#readNow()
    this.#pruneExpired(now)
    this.#assertCapacity()

    let attachmentToken: string
    try {
      attachmentToken = randomUUID()
    } catch {
      throw new SelectionTokenError('selection_capacity_exceeded')
    }
    const mediaKind = mediaKindForExtension(extname(absolutePath))
    const resolution = canonicalizeAttachment(absolutePath).catch(() => null)
    this.#records.set(attachmentToken, {
      absolutePath,
      kind: 'attachment',
      mediaKind,
      ownerWebContentsId,
      expiresAt: safeExpiry(now, this.#tokenLifetimeMs),
      resolution
    })
    return {
      attachmentToken,
      displayName: safeDisplayName(absolutePath, 'Attachment'),
      mediaKind
    }
  }

  resolve(token: string, kind: 'attachment', ownerWebContentsId: number): string | null
  resolve(token: string, kind: 'workspace', ownerWebContentsId: number): Promise<string | null>
  resolve(
    token: string,
    kind: SelectionKind,
    ownerWebContentsId: number
  ): string | null | Promise<string | null> {
    if (kind === 'workspace') {
      return this.resolveWorkspace(token, ownerWebContentsId).then(
        (record) => record?.absolutePath ?? null
      )
    }
    return this.#resolveAttachment(token, ownerWebContentsId)
  }

  async resolveWorkspace(
    workspaceToken: string,
    ownerWebContentsId: number
  ): Promise<ResolvedWorkspaceRecord | null> {
    if (!WORKSPACE_TOKEN_PATTERN.test(workspaceToken) || !isValidOwner(ownerWebContentsId)) {
      return null
    }
    const record = this.#records.get(workspaceToken)
    if (!record || record.kind !== 'workspace' || record.ownerWebContentsId !== ownerWebContentsId) {
      return null
    }
    if (record.expiresAt <= this.#readNow()) {
      this.#records.delete(workspaceToken)
      return null
    }

    const canonical = await record.resolution
    const current = this.#records.get(workspaceToken)
    if (
      !canonical ||
      current !== record ||
      record.ownerWebContentsId !== ownerWebContentsId ||
      record.expiresAt <= this.#readNow()
    ) {
      if (current === record) this.#records.delete(workspaceToken)
      return null
    }

    return Object.freeze({
      workspaceToken,
      absolutePath: canonical.absolutePath,
      ownerWebContentsId,
      expiresAt: record.expiresAt,
      device: canonical.device,
      inode: canonical.inode
    })
  }

  async consumeAttachment(
    attachmentToken: string,
    ownerWebContentsId: number
  ): Promise<ResolvedAttachmentRecord | null> {
    const reservation = await this.reserveAttachments([attachmentToken], ownerWebContentsId)
    if (!reservation) return null
    if (!this.commitAttachmentReservation(reservation.reservationToken, ownerWebContentsId)) {
      this.rollbackAttachmentReservation(reservation.reservationToken, ownerWebContentsId)
      return null
    }
    return reservation.attachments[0] ?? null
  }

  async reserveAttachments(
    attachmentTokens: readonly string[],
    ownerWebContentsId: number
  ): Promise<AttachmentSelectionReservation | null> {
    if (
      !isValidOwner(ownerWebContentsId) ||
      !Array.isArray(attachmentTokens) ||
      attachmentTokens.length < 1 ||
      attachmentTokens.length > MAX_ATTACHMENT_RESERVATION_SIZE
    ) {
      return null
    }
    const uniqueTokens = new Set<string>()
    for (const token of attachmentTokens) {
      if (
        typeof token !== 'string' ||
        !ATTACHMENT_TOKEN_PATTERN.test(token) ||
        uniqueTokens.has(token)
      ) {
        return null
      }
      uniqueTokens.add(token)
    }

    const now = this.#readNow()
    this.#pruneExpired(now)
    const records: AttachmentSelectionRecord[] = []
    for (const token of attachmentTokens) {
      const record = this.#records.get(token)
      if (
        !record ||
        record.kind !== 'attachment' ||
        record.ownerWebContentsId !== ownerWebContentsId ||
        record.reservationToken !== undefined
      ) {
        return null
      }
      records.push(record)
    }

    const reservationToken = this.#issueAttachmentReservationToken()
    const reservation: AttachmentReservationRecord = Object.freeze({
      ownerWebContentsId,
      attachmentTokens: Object.freeze([...attachmentTokens]),
      records: Object.freeze(records)
    })
    this.#attachmentReservations.set(reservationToken, reservation)
    for (const record of records) record.reservationToken = reservationToken

    let canonicalAttachments: readonly (CanonicalAttachment | null)[]
    let resolvedAt: number
    try {
      canonicalAttachments = await Promise.all(records.map((record) => record.resolution))
      resolvedAt = this.#readNow()
    } catch (error) {
      this.#releaseAttachmentReservation(reservationToken, false)
      throw error
    }
    const stillReserved =
      this.#attachmentReservations.get(reservationToken) === reservation &&
      records.every((record, index) =>
        this.#records.get(attachmentTokens[index]!) === record &&
        record.reservationToken === reservationToken &&
        record.expiresAt > resolvedAt &&
        canonicalAttachments[index] !== null
      )
    if (!stillReserved) {
      this.#releaseAttachmentReservation(reservationToken, false)
      for (let index = 0; index < records.length; index += 1) {
        const token = attachmentTokens[index]!
        const record = records[index]!
        if (
          this.#records.get(token) === record &&
          (record.expiresAt <= resolvedAt || canonicalAttachments[index] === null)
        ) {
          this.#records.delete(token)
        }
      }
      return null
    }

    const attachments = canonicalAttachments.map((canonical) => {
      const value = canonical!
      return Object.freeze({
        absolutePath: value.absolutePath,
        ownerWebContentsId,
        device: value.device,
        inode: value.inode,
        size: value.size,
        modifiedAtMs: value.modifiedAtMs
      })
    })
    return Object.freeze({
      reservationToken,
      attachments: Object.freeze(attachments)
    })
  }

  commitAttachmentReservation(
    reservationToken: string,
    ownerWebContentsId: number
  ): boolean {
    if (
      typeof reservationToken !== 'string' ||
      !ATTACHMENT_RESERVATION_TOKEN_PATTERN.test(reservationToken) ||
      !isValidOwner(ownerWebContentsId)
    ) {
      return false
    }
    const reservation = this.#attachmentReservations.get(reservationToken)
    if (!reservation || reservation.ownerWebContentsId !== ownerWebContentsId) return false

    const now = this.#readNow()
    this.#pruneExpired(now)
    if (this.#attachmentReservations.get(reservationToken) !== reservation) return false
    const isCurrent = reservation.records.every((record, index) =>
      this.#records.get(reservation.attachmentTokens[index]!) === record &&
      record.reservationToken === reservationToken &&
      record.ownerWebContentsId === ownerWebContentsId &&
      record.expiresAt > now
    )
    if (!isCurrent) {
      this.#releaseAttachmentReservation(reservationToken, false)
      return false
    }
    return this.#releaseAttachmentReservation(reservationToken, true)
  }

  rollbackAttachmentReservation(
    reservationToken: string,
    ownerWebContentsId: number
  ): boolean {
    if (
      typeof reservationToken !== 'string' ||
      !ATTACHMENT_RESERVATION_TOKEN_PATTERN.test(reservationToken) ||
      !isValidOwner(ownerWebContentsId)
    ) {
      return false
    }
    const reservation = this.#attachmentReservations.get(reservationToken)
    if (!reservation || reservation.ownerWebContentsId !== ownerWebContentsId) return false
    const released = this.#releaseAttachmentReservation(reservationToken, false)
    return released
  }

  describeAttachment(
    attachmentToken: string,
    ownerWebContentsId: number
  ): Pick<AttachmentSelection, 'mediaKind'> | null {
    if (!ATTACHMENT_TOKEN_PATTERN.test(attachmentToken) || !isValidOwner(ownerWebContentsId)) {
      return null
    }
    const record = this.#records.get(attachmentToken)
    if (
      !record ||
      record.kind !== 'attachment' ||
      record.ownerWebContentsId !== ownerWebContentsId
    ) {
      return null
    }
    if (record.expiresAt <= this.#readNow()) {
      if (record.reservationToken !== undefined) {
        this.#releaseAttachmentReservation(record.reservationToken, false)
      }
      if (this.#records.get(attachmentToken) === record) this.#records.delete(attachmentToken)
      return null
    }
    return Object.freeze({ mediaKind: record.mediaKind })
  }

  revokeOwner(ownerWebContentsId: number): void {
    if (!isValidOwner(ownerWebContentsId)) return
    for (const [reservationToken, reservation] of this.#attachmentReservations) {
      if (reservation.ownerWebContentsId === ownerWebContentsId) {
        this.#releaseAttachmentReservation(reservationToken, true)
      }
    }
    for (const [token, record] of this.#records) {
      if (record.ownerWebContentsId === ownerWebContentsId) this.#records.delete(token)
    }
  }

  clear(): void {
    this.#attachmentReservations.clear()
    this.#records.clear()
  }

  #resolveAttachment(token: string, ownerWebContentsId: number): string | null {
    if (typeof token !== 'string' || !isValidOwner(ownerWebContentsId)) return null
    const record = this.#records.get(token)
    if (!record || record.kind !== 'attachment') return null
    if (record.expiresAt <= this.#readNow()) {
      if (record.reservationToken !== undefined) {
        this.#releaseAttachmentReservation(record.reservationToken, false)
      }
      if (this.#records.get(token) === record) this.#records.delete(token)
      return null
    }
    if (record.ownerWebContentsId !== ownerWebContentsId) return null
    if (record.reservationToken !== undefined) return null
    return record.absolutePath
  }

  #issueWorkspaceToken(): string {
    try {
      for (let attempt = 0; attempt < WORKSPACE_TOKEN_ATTEMPTS; attempt += 1) {
        const token = `${WORKSPACE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
        if (WORKSPACE_TOKEN_PATTERN.test(token) && !this.#records.has(token)) return token
      }
    } catch {
      throw new SelectionTokenError('selection_capacity_exceeded')
    }
    throw new SelectionTokenError('selection_capacity_exceeded')
  }

  #issueAttachmentReservationToken(): string {
    try {
      for (let attempt = 0; attempt < ATTACHMENT_RESERVATION_TOKEN_ATTEMPTS; attempt += 1) {
        const token = `${ATTACHMENT_RESERVATION_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
        if (
          ATTACHMENT_RESERVATION_TOKEN_PATTERN.test(token) &&
          !this.#attachmentReservations.has(token)
        ) {
          return token
        }
      }
    } catch {
      throw new SelectionTokenError('selection_capacity_exceeded')
    }
    throw new SelectionTokenError('selection_capacity_exceeded')
  }

  #releaseAttachmentReservation(reservationToken: string, consume: boolean): boolean {
    const reservation = this.#attachmentReservations.get(reservationToken)
    if (!reservation) return false
    this.#attachmentReservations.delete(reservationToken)
    for (let index = 0; index < reservation.records.length; index += 1) {
      const token = reservation.attachmentTokens[index]!
      const record = reservation.records[index]!
      if (
        this.#records.get(token) !== record ||
        record.reservationToken !== reservationToken
      ) {
        continue
      }
      if (consume) this.#records.delete(token)
      else delete record.reservationToken
    }
    return true
  }

  #assertCapacity(): void {
    if (this.#records.size >= MAX_SELECTION_RECORDS) {
      throw new SelectionTokenError('selection_capacity_exceeded')
    }
  }

  #pruneExpired(now: number): void {
    for (const [token, record] of this.#records) {
      if (record.expiresAt > now) continue
      if (record.kind === 'attachment' && record.reservationToken !== undefined) {
        this.#releaseAttachmentReservation(record.reservationToken, false)
      }
      if (this.#records.get(token) === record) this.#records.delete(token)
    }
  }

  #readNow(): number {
    const now = this.#now()
    if (!Number.isSafeInteger(now) || now < 0) throw new SelectionTokenError('invalid_options')
    return now
  }
}

async function canonicalizeWorkspace(absolutePath: string): Promise<CanonicalWorkspace | null> {
  try {
    const canonicalPath = resolve(await fs.realpath(absolutePath))
    const stats = await fs.lstat(canonicalPath, { bigint: true })
    if (!stats.isDirectory() || stats.isSymbolicLink() || stats.dev === 0n || stats.ino === 0n) return null
    return Object.freeze({
      absolutePath: canonicalPath,
      device: stats.dev.toString(10),
      inode: stats.ino.toString(10)
    })
  } catch {
    return null
  }
}

async function canonicalizeAttachment(absolutePath: string): Promise<CanonicalAttachment | null> {
  try {
    const selectedPath = resolve(absolutePath)
    const selectedStats = await fs.lstat(selectedPath)
    if (!selectedStats.isFile() || selectedStats.isSymbolicLink()) return null
    const canonicalPath = resolve(await fs.realpath(selectedPath))
    const canonicalStats = await fs.lstat(canonicalPath)
    if (!canonicalStats.isFile() || canonicalStats.isSymbolicLink()) return null
    if (!sameFileIdentity(selectedStats, canonicalStats)) return null
    return Object.freeze({
      absolutePath: canonicalPath,
      device: canonicalStats.dev,
      inode: canonicalStats.ino,
      size: canonicalStats.size,
      modifiedAtMs: canonicalStats.mtimeMs
    })
  } catch {
    return null
  }
}

function sameFileIdentity(
  left: Awaited<ReturnType<typeof fs.lstat>>,
  right: Awaited<ReturnType<typeof fs.lstat>>
): boolean {
  if (left.dev !== 0 && right.dev !== 0 && left.dev !== right.dev) return false
  if (left.ino !== 0 && right.ino !== 0 && left.ino !== right.ino) return false
  return true
}

function validateWorkspaceCandidate(absolutePath: unknown): asserts absolutePath is string {
  validateLocalPathText(absolutePath)
  if (!isAbsolute(absolutePath)) throw new SelectionTokenError('invalid_selection')
}

function validateAttachmentCandidate(absolutePath: unknown): asserts absolutePath is string {
  validateLocalPathText(absolutePath)
  if (!isAbsolute(absolutePath)) throw new SelectionTokenError('invalid_selection')
}

function validateLocalPathText(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_LOCAL_PATH_CHARACTERS ||
    value.includes('\0') ||
    /[\r\n]/u.test(value)
  ) {
    throw new SelectionTokenError('invalid_selection')
  }
}

function safeDisplayName(absolutePath: string, fallback: string): string {
  const value = basename(absolutePath).replace(/[\u0000-\u001f\u007f]/gu, '').trim()
  return value ? value.slice(0, 255) : fallback
}

function safeExpiry(now: number, lifetimeMs: number): number {
  const expiresAt = now + lifetimeMs
  if (!Number.isSafeInteger(expiresAt)) throw new SelectionTokenError('invalid_options')
  return expiresAt
}

function validateOwner(value: unknown): asserts value is number {
  if (!isValidOwner(value)) throw new SelectionTokenError('invalid_owner')
}

function isValidOwner(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function mediaKindForExtension(extension: string): AttachmentSelection['mediaKind'] {
  const ext = extension.toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'].includes(ext)) return 'image'
  if (['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx'].includes(ext)) return 'document'
  if (['.txt', '.md', '.json', '.yaml', '.yml', '.toml', '.csv', '.log'].includes(ext)) return 'text'
  return 'other'
}
