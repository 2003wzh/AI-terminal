import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SIDECAR_PROTOCOL_VERSION,
  SidecarProtocolError,
  approvalBindingsEqual,
  createApprovalBinding,
  parseSidecarEnvelope,
  toolCallDigest
} from '../../src/main/runtime/protocol.ts'

test('tool call digests are canonical and approval bindings are exact', () => {
  const left = toolCallDigest({
    name: 'read_file',
    arguments: { path: 'README.md', end_line: 40 }
  })
  const right = toolCallDigest({
    name: 'read_file',
    arguments: { end_line: 40, path: 'README.md' }
  })
  assert.equal(left, right)

  const binding = createApprovalBinding(
    'turn_test',
    'call_test',
    { name: 'read_file', arguments: { path: 'README.md' } },
    { now: 1_000, ttlMs: 5_000, approvalId: 'approval_test' }
  )
  assert.equal(binding.expiresAt, 6_000)
  assert.equal(approvalBindingsEqual(binding, { ...binding }), true)
  assert.equal(
    approvalBindingsEqual(binding, { ...binding, callDigest: '0'.repeat(64) }),
    false
  )
})

test('protocol parsing rejects unknown events and invalid versions', () => {
  const response = parseSidecarEnvelope(
    JSON.stringify({
      v: SIDECAR_PROTOCOL_VERSION,
      kind: 'response',
      id: 'request_test',
      ok: true,
      result: { accepted: true }
    })
  )
  assert.equal(response.kind, 'response')

  assert.throws(
    () => parseSidecarEnvelope(JSON.stringify({
      v: 99,
      kind: 'event',
      event: 'ready',
      seq: 0,
      payload: {}
    })),
    SidecarProtocolError
  )
  assert.throws(
    () => parseSidecarEnvelope(JSON.stringify({
      v: SIDECAR_PROTOCOL_VERSION,
      kind: 'event',
      event: 'arbitrary.event',
      seq: 0,
      payload: {}
    })),
    SidecarProtocolError
  )
})

test('approval-required events must contain a valid binding', () => {
  assert.throws(
    () => parseSidecarEnvelope(JSON.stringify({
      v: SIDECAR_PROTOCOL_VERSION,
      kind: 'event',
      event: 'approval.required',
      seq: 2,
      turnId: 'turn_test',
      payload: { binding: { approvalId: 'approval_test' } }
    })),
    SidecarProtocolError
  )
})
