import { createHash, randomUUID } from 'node:crypto'

export const SIDECAR_PROTOCOL_VERSION = 1 as const
export const SIDECAR_MAX_MESSAGE_BYTES = 1024 * 1024
export const SIDECAR_MAX_ID_CHARS = 64
export const SIDECAR_MAX_ACTION_CHARS = 80
export const SIDECAR_MAX_JSON_DEPTH = 32
export const SIDECAR_MAX_JSON_NODES = 100_000
export const SIDECAR_MAX_STRING_CHARS = 512_000

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject {
  [key: string]: JsonValue
}

export const SIDECAR_REQUEST_ACTIONS = [
  'session.initialize',
  'workspace.bind',
  'endpoint.bind',
  'attachment.import',
  'turn.start',
  'turn.cancel',
  'approval.resolve',
  'file.read',
  'file.write',
  'git.summary',
  'terminal.start',
  'terminal.input',
  'terminal.resize',
  'terminal.stop',
  'session.shutdown'
] as const

export type SidecarRequestAction = (typeof SIDECAR_REQUEST_ACTIONS)[number]

export const SIDECAR_EVENT_NAMES = [
  'ready',
  'assistant.delta',
  'citation.added',
  'tool.proposed',
  'approval.required',
  'tool.started',
  'tool.completed',
  'subagent.started',
  'subagent.completed',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.cancelled'
] as const

export type SidecarEventName = (typeof SIDECAR_EVENT_NAMES)[number]
export type ApprovalDecision = 'allow_once' | 'deny'
export type WorkspaceMode = 'chat' | 'agent'
export type PermissionMode = 'ask' | 'auto' | 'full'
export type SubagentMode = 'off' | 'request' | 'auto'

export interface SidecarRequestEnvelope {
  v: typeof SIDECAR_PROTOCOL_VERSION
  kind: 'request'
  id: string
  action: SidecarRequestAction
  payload: JsonObject
}

export interface SidecarError {
  code: string
  message: string
  retryable?: boolean
}

export interface SidecarResponseEnvelope {
  v: typeof SIDECAR_PROTOCOL_VERSION
  kind: 'response'
  id: string
  ok: boolean
  result?: JsonValue
  error?: SidecarError
}

export interface SidecarEventEnvelope {
  v: typeof SIDECAR_PROTOCOL_VERSION
  kind: 'event'
  event: SidecarEventName
  seq: number
  requestId?: string
  turnId?: string
  payload: JsonObject
}

export type SidecarEnvelope =
  | SidecarRequestEnvelope
  | SidecarResponseEnvelope
  | SidecarEventEnvelope

export interface ApprovalBinding {
  approvalId: string
  turnId: string
  toolCallId: string
  callDigest: string
  expiresAt: number
}

export interface ToolCallForApproval {
  name: string
  arguments: JsonObject
}

export interface TurnCancelPayload {
  turnId: string
  reason?: string
}

export interface ApprovalResolvePayload {
  binding: ApprovalBinding
  decision: ApprovalDecision
}

export class SidecarProtocolError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SidecarProtocolError'
    this.code = code
  }
}

const requestActionSet = new Set<string>(SIDECAR_REQUEST_ACTIONS)
const eventNameSet = new Set<string>(SIDECAR_EVENT_NAMES)
const forbiddenObjectKeys = new Set(['__proto__', 'prototype', 'constructor'])
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const digestPattern = /^[a-f0-9]{64}$/

function protocolError(code: string, message: string): never {
  throw new SidecarProtocolError(code, message)
}

export function isJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertBoundedString(
  value: unknown,
  field: string,
  options: { min?: number; max?: number } = {}
): asserts value is string {
  const min = options.min ?? 0
  const max = options.max ?? SIDECAR_MAX_STRING_CHARS
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    protocolError('invalid_field', `${field} is invalid.`)
  }
}

export function assertProtocolId(value: unknown, field = 'id'): asserts value is string {
  if (typeof value !== 'string' || value.length > SIDECAR_MAX_ID_CHARS || !idPattern.test(value)) {
    protocolError('invalid_id', `${field} is invalid.`)
  }
}

function assertAllowedKeys(value: JsonObject, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) protocolError('unexpected_field', 'The payload contains an unexpected field.')
  }
}

export function assertJsonValue(value: unknown): asserts value is JsonValue {
  const budget = { nodes: 0 }

  const visit = (item: unknown, depth: number): void => {
    budget.nodes += 1
    if (budget.nodes > SIDECAR_MAX_JSON_NODES || depth > SIDECAR_MAX_JSON_DEPTH) {
      protocolError('json_too_complex', 'The JSON payload is too complex.')
    }
    if (item === null || typeof item === 'boolean') return
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) protocolError('invalid_number', 'The JSON payload contains an invalid number.')
      return
    }
    if (typeof item === 'string') {
      if (item.length > SIDECAR_MAX_STRING_CHARS) {
        protocolError('string_too_large', 'The JSON payload contains an oversized string.')
      }
      return
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1)
      return
    }
    if (isJsonObject(item)) {
      for (const [key, child] of Object.entries(item)) {
        if (key.length > 128 || forbiddenObjectKeys.has(key)) {
          protocolError('invalid_object_key', 'The JSON payload contains an invalid object key.')
        }
        visit(child, depth + 1)
      }
      return
    }
    protocolError('invalid_json_value', 'The payload contains a non-JSON value.')
  }

  visit(value, 0)
}

function assertHttpsEndpoint(value: unknown): asserts value is string {
  assertBoundedString(value, 'baseUrl', { min: 1, max: 2_048 })
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    protocolError('invalid_endpoint', 'The endpoint is invalid.')
  }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(endpoint.hostname.toLowerCase())
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    (!loopback && endpoint.protocol !== 'https:') ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    protocolError('invalid_endpoint', 'The endpoint does not satisfy the transport policy.')
  }
}

export function assertApprovalBinding(value: unknown): asserts value is ApprovalBinding {
  if (!isJsonObject(value)) protocolError('invalid_approval_binding', 'The approval binding is invalid.')
  assertAllowedKeys(value, ['approvalId', 'turnId', 'toolCallId', 'callDigest', 'expiresAt'])
  assertProtocolId(value.approvalId, 'approvalId')
  assertProtocolId(value.turnId, 'turnId')
  assertProtocolId(value.toolCallId, 'toolCallId')
  if (typeof value.callDigest !== 'string' || !digestPattern.test(value.callDigest)) {
    protocolError('invalid_approval_binding', 'The approval digest is invalid.')
  }
  if (!Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= 0) {
    protocolError('invalid_approval_binding', 'The approval expiry is invalid.')
  }
}

function assertRequestPayload(action: SidecarRequestAction, payload: JsonObject): void {
  if (action === 'session.initialize') {
    assertAllowedKeys(payload, ['appSessionId', 'clientVersion'])
    assertProtocolId(payload.appSessionId, 'appSessionId')
    if (payload.clientVersion !== undefined) assertBoundedString(payload.clientVersion, 'clientVersion', { max: 128 })
    return
  }
  if (action === 'workspace.bind') {
    assertAllowedKeys(payload, ['workspaceId', 'absolutePath'])
    assertProtocolId(payload.workspaceId, 'workspaceId')
    assertBoundedString(payload.absolutePath, 'absolutePath', { min: 1, max: 32_768 })
    return
  }
  if (action === 'endpoint.bind') {
    assertAllowedKeys(payload, ['endpointId', 'consentId', 'baseUrl', 'apiKey'])
    assertProtocolId(payload.endpointId, 'endpointId')
    assertProtocolId(payload.consentId, 'consentId')
    assertHttpsEndpoint(payload.baseUrl)
    assertBoundedString(payload.apiKey, 'apiKey', { min: 1, max: 32_768 })
    return
  }
  if (action === 'attachment.import') {
    assertAllowedKeys(payload, ['attachmentId', 'absolutePath'])
    assertProtocolId(payload.attachmentId, 'attachmentId')
    assertBoundedString(payload.absolutePath, 'absolutePath', { min: 1, max: 32_768 })
    return
  }
  if (action === 'turn.start') {
    assertAllowedKeys(payload, [
      'turnId',
      'workspaceId',
      'endpointId',
      'mode',
      'model',
      'reasoning',
      'permissionMode',
      'subagentMode',
      'webSearch',
      'messages',
      'attachmentIds'
    ])
    assertProtocolId(payload.turnId, 'turnId')
    if (payload.workspaceId !== undefined) assertProtocolId(payload.workspaceId, 'workspaceId')
    assertProtocolId(payload.endpointId, 'endpointId')
    if (payload.mode !== 'chat' && payload.mode !== 'agent') {
      protocolError('invalid_mode', 'The workspace mode is invalid.')
    }
    assertBoundedString(payload.model, 'model', { min: 1, max: 256 })
    if (payload.reasoning !== undefined) assertBoundedString(payload.reasoning, 'reasoning', { max: 32 })
    if (!['ask', 'auto', 'full'].includes(String(payload.permissionMode))) {
      protocolError('invalid_permission_mode', 'The permission mode is invalid.')
    }
    if (!['off', 'request', 'auto'].includes(String(payload.subagentMode))) {
      protocolError('invalid_subagent_mode', 'The subagent mode is invalid.')
    }
    if (!Array.isArray(payload.messages)) protocolError('invalid_messages', 'The message list is invalid.')
    if (payload.attachmentIds !== undefined && !Array.isArray(payload.attachmentIds)) {
      protocolError('invalid_attachments', 'The attachment identifier list is invalid.')
    }
    if (payload.webSearch !== undefined && typeof payload.webSearch !== 'boolean') {
      protocolError('invalid_web_search', 'The web search flag is invalid.')
    }
    return
  }
  if (action === 'turn.cancel') {
    assertAllowedKeys(payload, ['turnId', 'reason'])
    assertProtocolId(payload.turnId, 'turnId')
    if (payload.reason !== undefined) assertBoundedString(payload.reason, 'reason', { max: 256 })
    return
  }
  if (action === 'approval.resolve') {
    assertAllowedKeys(payload, ['binding', 'decision'])
    assertApprovalBinding(payload.binding)
    if (payload.decision !== 'allow_once' && payload.decision !== 'deny') {
      protocolError('invalid_approval_decision', 'The approval decision is invalid.')
    }
    return
  }
  if (action === 'session.shutdown') {
    assertAllowedKeys(payload, [])
    return
  }

  // File, Git, and terminal actions are intentionally whitelisted now but will
  // receive operation-specific schemas before their handlers are enabled.
  protocolError('action_not_enabled', 'The requested sidecar action is not enabled.')
}

export function assertSidecarRequest(value: unknown): asserts value is SidecarRequestEnvelope {
  if (!isJsonObject(value)) protocolError('invalid_envelope', 'The sidecar request must be an object.')
  assertAllowedKeys(value, ['v', 'kind', 'id', 'action', 'payload'])
  if (value.v !== SIDECAR_PROTOCOL_VERSION || value.kind !== 'request') {
    protocolError('unsupported_protocol', 'The sidecar request uses an unsupported protocol.')
  }
  assertProtocolId(value.id)
  if (typeof value.action !== 'string' || !requestActionSet.has(value.action)) {
    protocolError('unknown_action', 'The sidecar request action is not allowed.')
  }
  if (value.action.length > SIDECAR_MAX_ACTION_CHARS || !isJsonObject(value.payload)) {
    protocolError('invalid_envelope', 'The sidecar request payload is invalid.')
  }
  assertJsonValue(value.payload)
  assertRequestPayload(value.action as SidecarRequestAction, value.payload)
}

function assertSidecarError(value: unknown): asserts value is SidecarError {
  if (!isJsonObject(value)) protocolError('invalid_error', 'The sidecar error is invalid.')
  assertAllowedKeys(value, ['code', 'message', 'retryable'])
  assertBoundedString(value.code, 'error.code', { min: 1, max: 64 })
  assertBoundedString(value.message, 'error.message', { min: 1, max: 2_048 })
  if (value.retryable !== undefined && typeof value.retryable !== 'boolean') {
    protocolError('invalid_error', 'The sidecar retry flag is invalid.')
  }
}

export function assertSidecarEnvelope(value: unknown): asserts value is SidecarEnvelope {
  if (!isJsonObject(value)) protocolError('invalid_envelope', 'The sidecar message must be an object.')
  if (value.v !== SIDECAR_PROTOCOL_VERSION) {
    protocolError('unsupported_protocol', 'The sidecar message uses an unsupported protocol version.')
  }
  if (value.kind === 'request') {
    assertSidecarRequest(value)
    return
  }
  if (value.kind === 'response') {
    assertAllowedKeys(value, ['v', 'kind', 'id', 'ok', 'result', 'error'])
    assertProtocolId(value.id)
    if (typeof value.ok !== 'boolean') protocolError('invalid_response', 'The sidecar response is invalid.')
    if (value.result !== undefined) assertJsonValue(value.result)
    if (value.error !== undefined) assertSidecarError(value.error)
    if (value.ok && value.error !== undefined) {
      protocolError('invalid_response', 'A successful response cannot contain an error.')
    }
    if (!value.ok && value.error === undefined) {
      protocolError('invalid_response', 'A failed response must contain a safe error.')
    }
    return
  }
  if (value.kind === 'event') {
    assertAllowedKeys(value, ['v', 'kind', 'event', 'seq', 'requestId', 'turnId', 'payload'])
    if (typeof value.event !== 'string' || !eventNameSet.has(value.event)) {
      protocolError('unknown_event', 'The sidecar event is not allowed.')
    }
    if (!Number.isSafeInteger(value.seq) || Number(value.seq) < 0) {
      protocolError('invalid_sequence', 'The sidecar event sequence is invalid.')
    }
    if (value.requestId !== undefined) assertProtocolId(value.requestId, 'requestId')
    if (value.turnId !== undefined) assertProtocolId(value.turnId, 'turnId')
    if (!isJsonObject(value.payload)) protocolError('invalid_event', 'The sidecar event payload is invalid.')
    assertJsonValue(value.payload)
    if (value.event === 'approval.required') assertApprovalBinding(value.payload.binding)
    return
  }
  protocolError('invalid_envelope', 'The sidecar message kind is invalid.')
}

export function parseSidecarEnvelope(jsonText: string): SidecarEnvelope {
  let value: unknown
  try {
    value = JSON.parse(jsonText) as unknown
  } catch {
    protocolError('invalid_json', 'The sidecar emitted malformed JSON.')
  }
  assertSidecarEnvelope(value)
  return value
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(',')}}`
}

export function toolCallDigest(toolCall: ToolCallForApproval): string {
  assertBoundedString(toolCall.name, 'tool.name', { min: 1, max: 128 })
  assertJsonValue(toolCall.arguments)
  return createHash('sha256')
    .update(canonicalJson({ name: toolCall.name, arguments: toolCall.arguments }))
    .digest('hex')
}

export function createApprovalBinding(
  turnId: string,
  toolCallId: string,
  toolCall: ToolCallForApproval,
  options: { now?: number; ttlMs?: number; approvalId?: string } = {}
): ApprovalBinding {
  assertProtocolId(turnId, 'turnId')
  assertProtocolId(toolCallId, 'toolCallId')
  const now = options.now ?? Date.now()
  const ttlMs = Math.min(10 * 60_000, Math.max(1_000, options.ttlMs ?? 2 * 60_000))
  const binding: ApprovalBinding = {
    approvalId: options.approvalId ?? `approval_${randomUUID()}`,
    turnId,
    toolCallId,
    callDigest: toolCallDigest(toolCall),
    expiresAt: now + ttlMs
  }
  assertApprovalBinding(binding)
  return binding
}

export function approvalBindingsEqual(left: ApprovalBinding, right: ApprovalBinding): boolean {
  return (
    left.approvalId === right.approvalId &&
    left.turnId === right.turnId &&
    left.toolCallId === right.toolCallId &&
    left.callDigest === right.callDigest &&
    left.expiresAt === right.expiresAt
  )
}
