import { createHmac, randomBytes } from 'node:crypto'

import type { AgentEvent, ApprovalMode } from '../../shared/contracts.ts'
import {
  ConsentStore,
  type LocalToolOperationCategory
} from '../security/consent-store.ts'
import { redactSensitiveText } from '../security/redaction.ts'

export interface AgentToolApprovalRequest {
  turnId: string
  callId: string
  workspaceToken: string
  operation: LocalToolOperationCategory
  toolName: string
  arguments: Readonly<Record<string, unknown>>
  label: string
  risk: 'low' | 'medium' | 'high'
  mode: ApprovalMode
  signal: AbortSignal
}

export interface AgentToolAuthorization {
  approvalHandle: string
  workspaceToken: string
  operation: LocalToolOperationCategory
  requestDigest: string
  decisionSource: 'user' | 'policy' | 'full'
}

export interface AgentApprovalServiceOptions {
  consents: ConsentStore
  onEvent: (event: AgentEvent) => void
  now?: () => number
  approvalTtlMs?: number
}

interface PendingApproval {
  turnId: string
  expiresAt: number
  timer: NodeJS.Timeout
  abort: () => void
  settle: (decision: 'allow_once' | 'deny') => void
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const WORKSPACE_TOKEN_PATTERN = /^ws_[A-Za-z0-9_-]{43}$/u
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u
const DEFAULT_APPROVAL_TTL_MS = 2 * 60_000
const MIN_APPROVAL_TTL_MS = 1_000
const MAX_APPROVAL_TTL_MS = 10 * 60_000
const MAX_PENDING_APPROVALS = 256

export class AgentApprovalError extends Error {
  readonly code: 'invalid_configuration' | 'invalid_request' | 'capacity_exceeded' | 'disposed'

  constructor(code: AgentApprovalError['code']) {
    super({
      invalid_configuration: 'The Agent approval service configuration is invalid.',
      invalid_request: 'The Agent approval request is invalid.',
      capacity_exceeded: 'Too many Agent approvals are pending.',
      disposed: 'The Agent approval service is no longer available.'
    }[code])
    this.name = 'AgentApprovalError'
    this.code = code
    this.stack = `${this.name}: ${this.message}`
  }
}

export class AgentApprovalService {
  readonly #consents: ConsentStore
  readonly #onEvent: AgentApprovalServiceOptions['onEvent']
  readonly #now: () => number
  readonly #approvalTtlMs: number
  readonly #digestKey: Buffer
  readonly #pending = new Map<string, PendingApproval>()
  #disposed = false

  constructor(options: AgentApprovalServiceOptions) {
    if (
      !isPlainRecord(options) ||
      !(options.consents instanceof ConsentStore) ||
      typeof options.onEvent !== 'function' ||
      (options.now !== undefined && typeof options.now !== 'function') ||
      (options.approvalTtlMs !== undefined && !isBoundedTtl(options.approvalTtlMs))
    ) {
      throw new AgentApprovalError('invalid_configuration')
    }
    this.#consents = options.consents
    this.#onEvent = options.onEvent
    this.#now = options.now ?? Date.now
    this.#approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS
    try {
      this.#digestKey = randomBytes(32)
    } catch {
      throw new AgentApprovalError('invalid_configuration')
    }
  }

  async authorize(request: AgentToolApprovalRequest): Promise<AgentToolAuthorization | null> {
    if (this.#disposed) throw new AgentApprovalError('disposed')
    const normalized = normalizeApprovalRequest(request)
    if (normalized.signal.aborted) return null

    const requestDigest = createHmac('sha256', this.#digestKey)
      .update(canonicalJson({
        v: 1,
        turnId: normalized.turnId,
        callId: normalized.callId,
        workspaceToken: normalized.workspaceToken,
        operation: normalized.operation,
        toolName: normalized.toolName,
        arguments: normalized.arguments
      }))
      .digest('hex')

    let decisionSource: AgentToolAuthorization['decisionSource']
    if (normalized.mode === 'request') {
      const approved = await this.#requestUserDecision(normalized)
      if (!approved) return null
      decisionSource = 'user'
    } else if (normalized.mode === 'auto') {
      if (!isPolicyAutoApprovable(normalized.operation, normalized.risk)) return null
      decisionSource = 'policy'
    } else {
      decisionSource = 'full'
    }

    if (normalized.signal.aborted || this.#disposed) return null
    const grant = this.#consents.issueLocalToolApproval({
      workspaceToken: normalized.workspaceToken,
      operation: normalized.operation,
      requestDigest
    })
    return Object.freeze({
      approvalHandle: grant.approvalHandle,
      workspaceToken: normalized.workspaceToken,
      operation: normalized.operation,
      requestDigest,
      decisionSource
    })
  }

  consume(authorization: AgentToolAuthorization): boolean {
    if (this.#disposed || !isAuthorization(authorization)) return false
    return this.#consents.consumeLocalToolApproval({
      approvalHandle: authorization.approvalHandle,
      workspaceToken: authorization.workspaceToken,
      operation: authorization.operation,
      requestDigest: authorization.requestDigest
    })
  }

  resolve(approvalId: unknown, decision: unknown): boolean {
    if (
      this.#disposed ||
      typeof approvalId !== 'string' ||
      !SAFE_ID_PATTERN.test(approvalId) ||
      (decision !== 'allow_once' && decision !== 'deny')
    ) {
      return false
    }
    const pending = this.#pending.get(approvalId)
    if (!pending) return false
    this.#pending.delete(approvalId)
    clearTimeout(pending.timer)
    pending.abort()
    pending.settle(decision)
    return true
  }

  cancelTurn(turnId: string): void {
    for (const [approvalId, pending] of this.#pending) {
      if (pending.turnId !== turnId) continue
      this.#pending.delete(approvalId)
      clearTimeout(pending.timer)
      pending.abort()
      pending.settle('deny')
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.abort()
      pending.settle('deny')
    }
    this.#pending.clear()
  }

  async #requestUserDecision(
    request: ReturnType<typeof normalizeApprovalRequest>
  ): Promise<boolean> {
    if (this.#pending.size >= MAX_PENDING_APPROVALS) {
      throw new AgentApprovalError('capacity_exceeded')
    }
    const approvalId = issueApprovalId(this.#pending)
    const now = this.#readNow()
    const expiresAt = now + this.#approvalTtlMs

    return await new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (decision: 'allow_once' | 'deny'): void => {
        if (settled) return
        settled = true
        request.signal.removeEventListener('abort', onAbort)
        resolve(decision === 'allow_once')
      }
      const onAbort = (): void => {
        const pending = this.#pending.get(approvalId)
        if (pending) {
          this.#pending.delete(approvalId)
          clearTimeout(pending.timer)
        }
        finish('deny')
      }
      const timer = setTimeout(() => {
        this.#pending.delete(approvalId)
        request.signal.removeEventListener('abort', onAbort)
        finish('deny')
      }, this.#approvalTtlMs)
      timer.unref()

      this.#pending.set(approvalId, {
        turnId: request.turnId,
        expiresAt,
        timer,
        abort: () => request.signal.removeEventListener('abort', onAbort),
        settle: finish
      })
      request.signal.addEventListener('abort', onAbort, { once: true })
      this.#emit({
        type: 'turn-status',
        turnId: request.turnId,
        status: 'waiting-approval',
        message: 'Agent 正在等待本次本地操作批准。'
      })
      this.#emit({
        type: 'approval-request',
        turnId: request.turnId,
        approvalId,
        label: redactSensitiveText(request.label),
        risk: request.risk,
        expiresAt: new Date(expiresAt).toISOString()
      })
    })
  }

  #readNow(): number {
    const now = this.#now()
    if (!Number.isSafeInteger(now) || now < 0) throw new AgentApprovalError('invalid_configuration')
    return now
  }

  #emit(event: AgentEvent): void {
    try {
      this.#onEvent(event)
    } catch {
      // Approval state is authoritative even if Renderer delivery fails.
    }
  }
}

function normalizeApprovalRequest(request: AgentToolApprovalRequest): AgentToolApprovalRequest {
  if (
    !isPlainRecord(request) ||
    !SAFE_ID_PATTERN.test(String(request.turnId)) ||
    !SAFE_ID_PATTERN.test(String(request.callId)) ||
    !WORKSPACE_TOKEN_PATTERN.test(String(request.workspaceToken)) ||
    !['read', 'enumerate', 'search', 'write', 'open', 'execute'].includes(String(request.operation)) ||
    !TOOL_NAME_PATTERN.test(String(request.toolName)) ||
    !isPlainRecord(request.arguments) ||
    typeof request.label !== 'string' ||
    request.label.length < 1 ||
    request.label.length > 1_024 ||
    !['low', 'medium', 'high'].includes(String(request.risk)) ||
    !['request', 'auto', 'full'].includes(String(request.mode)) ||
    !isAbortSignal(request.signal)
  ) {
    throw new AgentApprovalError('invalid_request')
  }
  assertJsonValue(request.arguments, 0, { nodes: 0 })
  return request
}

function isAuthorization(value: unknown): value is AgentToolAuthorization {
  return isPlainRecord(value) &&
    typeof value.approvalHandle === 'string' &&
    WORKSPACE_TOKEN_PATTERN.test(String(value.workspaceToken)) &&
    typeof value.requestDigest === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.requestDigest) &&
    ['read', 'enumerate', 'search', 'write', 'open', 'execute'].includes(String(value.operation)) &&
    ['user', 'policy', 'full'].includes(String(value.decisionSource))
}

function isPolicyAutoApprovable(
  operation: LocalToolOperationCategory,
  risk: AgentToolApprovalRequest['risk']
): boolean {
  return risk === 'low' && ['read', 'enumerate', 'search'].includes(operation)
}

function issueApprovalId(records: ReadonlyMap<string, unknown>): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = `approval_${randomBytes(18).toString('base64url')}`
    if (!records.has(id)) return id
  }
  throw new AgentApprovalError('capacity_exceeded')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function assertJsonValue(value: unknown, depth: number, budget: { nodes: number }): void {
  budget.nodes += 1
  if (depth > 16 || budget.nodes > 4_096) throw new AgentApprovalError('invalid_request')
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AgentApprovalError('invalid_request')
    return
  }
  if (typeof value === 'string') {
    if (value.length > 64 * 1024 || value.includes('\0')) throw new AgentApprovalError('invalid_request')
    return
  }
  if (Array.isArray(value)) {
    for (const child of value) assertJsonValue(child, depth + 1, budget)
    return
  }
  if (!isPlainRecord(value)) throw new AgentApprovalError('invalid_request')
  for (const [key, child] of Object.entries(value)) {
    if (key.length > 128 || ['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw new AgentApprovalError('invalid_request')
    }
    assertJsonValue(child, depth + 1, budget)
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (value === null || typeof value !== 'object') return false
  const signal = value as AbortSignal
  return typeof signal.aborted === 'boolean' &&
    typeof signal.addEventListener === 'function' &&
    typeof signal.removeEventListener === 'function'
}

function isBoundedTtl(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_APPROVAL_TTL_MS &&
    value <= MAX_APPROVAL_TTL_MS
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
