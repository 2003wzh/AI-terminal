import type { AgentEvent } from './contracts'

const MAX_ID_CHARACTERS = 128
const MAX_ASSISTANT_DELTA_CHARACTERS = 16 * 1024
const MAX_TERMINAL_OUTPUT_CHARACTERS = 16 * 1024
const MAX_STATUS_MESSAGE_CHARACTERS = 1024
const MAX_LABEL_CHARACTERS = 1024
const MAX_IMAGE_BYTES = 12 * 1024 * 1024

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const TURN_STATUSES = new Set(['queued', 'running', 'waiting-approval', 'completed', 'failed', 'cancelled'])
const TOOL_STATUSES = new Set(['running', 'completed', 'failed'])
const APPROVAL_RISKS = new Set(['low', 'medium', 'high'])

type SafeRecord = Record<string, unknown>

export function isAgentEvent(value: unknown): value is AgentEvent {
  try {
    const event = toSafeRecord(value)
    if (!event || typeof event.type !== 'string') return false

    switch (event.type) {
      case 'turn-status':
        return (
          hasExactFields(event, ['type', 'turnId', 'status'], ['message']) &&
          isSafeId(event.turnId) &&
          typeof event.status === 'string' &&
          TURN_STATUSES.has(event.status) &&
          (!Object.hasOwn(event, 'message') || isBoundedText(event.message, MAX_STATUS_MESSAGE_CHARACTERS))
        )
      case 'assistant-delta':
        return (
          hasExactFields(event, ['type', 'turnId', 'text']) &&
          isSafeId(event.turnId) &&
          isBoundedText(event.text, MAX_ASSISTANT_DELTA_CHARACTERS)
        )
      case 'image-result':
        return (
          hasExactFields(event, ['type', 'turnId', 'imageToken', 'mimeType', 'byteLength']) &&
          isSafeId(event.turnId) &&
          typeof event.imageToken === 'string' &&
          /^img_[A-Za-z0-9_-]{43}$/u.test(event.imageToken) &&
          event.mimeType === 'image/png' &&
          typeof event.byteLength === 'number' &&
          Number.isSafeInteger(event.byteLength) &&
          event.byteLength >= 8 &&
          event.byteLength <= MAX_IMAGE_BYTES
        )
      case 'tool-status':
        return (
          hasExactFields(event, ['type', 'turnId', 'callId', 'label', 'status']) &&
          isSafeId(event.turnId) &&
          isSafeId(event.callId) &&
          isBoundedText(event.label, MAX_LABEL_CHARACTERS) &&
          typeof event.status === 'string' &&
          TOOL_STATUSES.has(event.status)
        )
      case 'approval-request':
        return (
          hasExactFields(event, ['type', 'turnId', 'approvalId', 'label', 'risk', 'expiresAt']) &&
          isSafeId(event.turnId) &&
          isSafeId(event.approvalId) &&
          isBoundedText(event.label, MAX_LABEL_CHARACTERS) &&
          typeof event.risk === 'string' &&
          APPROVAL_RISKS.has(event.risk) &&
          isCanonicalUtcTimestamp(event.expiresAt)
        )
      case 'terminal-output':
        return (
          hasExactFields(event, ['type', 'terminalId', 'data']) &&
          isSafeId(event.terminalId) &&
          isBoundedText(event.data, MAX_TERMINAL_OUTPUT_CHARACTERS)
        )
      default:
        return false
    }
  } catch {
    return false
  }
}

function toSafeRecord(value: unknown): SafeRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null

  const keys = Reflect.ownKeys(value)
  for (const key of keys) {
    if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key)) return null
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null
  }
  return value as SafeRecord
}

function hasExactFields(
  value: SafeRecord,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string')) return false
  const allowed = new Set([...required, ...optional])
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => typeof key === 'string' && allowed.has(key))
  )
}

function isSafeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_ID_CHARACTERS &&
    SAFE_ID_PATTERN.test(value)
  )
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maximum &&
    !value.includes('\0')
  )
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_UTC_TIMESTAMP.test(value)) return false
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
}
