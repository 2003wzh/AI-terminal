import assert from 'node:assert/strict'
import test from 'node:test'

import { isAgentEvent } from '../../src/shared/agent-event-validator.ts'

const turnId = `turn_${'a'.repeat(32)}`

test('accepts every exact AgentEvent shape and bounded assistant deltas', () => {
  const events = [
    { type: 'turn-status', turnId, status: 'queued' },
    { type: 'turn-status', turnId, status: 'waiting-approval', message: 'Waiting for approval.' },
    { type: 'assistant-delta', turnId, text: 'a'.repeat(16 * 1024) },
    {
      type: 'image-result',
      turnId,
      imageToken: `img_${'a'.repeat(43)}`,
      mimeType: 'image/png',
      byteLength: 1024
    },
    { type: 'tool-status', turnId, callId: 'call_test-1', label: 'Read a file', status: 'running' },
    {
      type: 'approval-request',
      turnId,
      approvalId: 'approval_test-1',
      label: 'Run a command',
      risk: 'high',
      expiresAt: '2026-07-15T12:30:45.123Z'
    },
    { type: 'terminal-output', terminalId: 'terminal_test-1', data: 'output\n' }
  ]

  for (const event of events) assert.equal(isAgentEvent(event), true)
  assert.equal(isAgentEvent({ type: 'assistant-delta', turnId, text: 'a'.repeat(16 * 1024 + 1) }), false)
})

test('rejects missing, unknown and incorrectly typed fields for every discriminant', () => {
  const invalid = [
    { type: 'turn-status', turnId },
    { type: 'turn-status', turnId, status: 'unknown' },
    { type: 'turn-status', turnId, status: 'running', message: 42 },
    { type: 'turn-status', turnId, status: 'running', message: '' },
    { type: 'turn-status', turnId, status: 'running', extra: true },
    { type: 'assistant-delta', turnId, text: '' },
    { type: 'assistant-delta', turnId, text: 'safe', extra: 'not allowed' },
    { type: 'image-result', turnId, imageToken: 'img_bad', mimeType: 'image/png', byteLength: 10 },
    { type: 'image-result', turnId, imageToken: `img_${'a'.repeat(43)}`, mimeType: 'image/svg+xml', byteLength: 10 },
    { type: 'tool-status', turnId, callId: 'call_test', label: 'Tool', status: 'queued' },
    { type: 'tool-status', turnId, callId: 'call_test', label: 1, status: 'running' },
    {
      type: 'approval-request',
      turnId,
      approvalId: 'approval_test',
      label: 'Approve',
      risk: 'critical',
      expiresAt: '2026-07-15T12:30:45.123Z'
    },
    { type: 'terminal-output', terminalId: 'terminal_test', data: null },
    { type: 'arbitrary-event', turnId, text: 'unsafe' }
  ]

  for (const event of invalid) assert.equal(isAgentEvent(event), false)
})

test('rejects unsafe identifiers, non-canonical times and oversized small fields', () => {
  assert.equal(isAgentEvent({ type: 'assistant-delta', turnId: 'turn/path', text: 'safe' }), false)
  assert.equal(isAgentEvent({ type: 'assistant-delta', turnId: `a${'b'.repeat(128)}`, text: 'safe' }), false)
  assert.equal(isAgentEvent({
    type: 'tool-status',
    turnId,
    callId: 'call with spaces',
    label: 'Tool',
    status: 'completed'
  }), false)
  assert.equal(isAgentEvent({
    type: 'tool-status',
    turnId,
    callId: 'call_test',
    label: 'x'.repeat(1025),
    status: 'completed'
  }), false)
  assert.equal(isAgentEvent({
    type: 'approval-request',
    turnId,
    approvalId: 'approval_test',
    label: 'Approve',
    risk: 'low',
    expiresAt: '2026-02-30T12:30:45.123Z'
  }), false)
  assert.equal(isAgentEvent({
    type: 'approval-request',
    turnId,
    approvalId: 'approval_test',
    label: 'Approve',
    risk: 'low',
    expiresAt: '2026-07-15T12:30:45Z'
  }), false)
  assert.equal(isAgentEvent({ type: 'terminal-output', terminalId: 'terminal_test', data: 'x'.repeat(16 * 1024 + 1) }), false)
  assert.equal(isAgentEvent({ type: 'turn-status', turnId, status: 'failed', message: 'x'.repeat(1025) }), false)
  assert.equal(isAgentEvent({ type: 'assistant-delta', turnId, text: 'safe\0unsafe' }), false)
})

test('rejects arrays, accessors, symbols and prototype-polluted objects without throwing', () => {
  assert.equal(isAgentEvent([]), false)
  assert.equal(isAgentEvent(null), false)

  const inherited = Object.assign(Object.create({ polluted: true }), {
    type: 'assistant-delta', turnId, text: 'safe'
  })
  assert.equal(isAgentEvent(inherited), false)

  const pollutedKey = JSON.parse(
    `{"type":"assistant-delta","turnId":"${turnId}","text":"safe","__proto__":{"polluted":true}}`
  ) as unknown
  assert.equal(isAgentEvent(pollutedKey), false)

  const accessor = { type: 'assistant-delta', turnId } as Record<string, unknown>
  Object.defineProperty(accessor, 'text', {
    enumerable: true,
    get() { throw new Error('getter must not execute') }
  })
  assert.doesNotThrow(() => isAgentEvent(accessor))
  assert.equal(isAgentEvent(accessor), false)

  const symbolField = { type: 'assistant-delta', turnId, text: 'safe', [Symbol('extra')]: true }
  assert.equal(isAgentEvent(symbolField), false)

  const ownConstructor = { type: 'assistant-delta', turnId, text: 'safe' } as Record<string, unknown>
  Object.defineProperty(ownConstructor, 'constructor', { enumerable: true, value: 'polluted' })
  assert.equal(isAgentEvent(ownConstructor), false)
})

test('accepts safe null-prototype data records but not optional undefined fields', () => {
  const safe = Object.assign(Object.create(null), {
    type: 'assistant-delta',
    turnId,
    text: 'safe'
  })
  assert.equal(isAgentEvent(safe), true)
  assert.equal(isAgentEvent({ type: 'turn-status', turnId, status: 'completed', message: undefined }), false)
})
