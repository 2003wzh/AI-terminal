import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentEvent } from '../../src/shared/contracts.ts'
import { ConsentStore } from '../../src/main/security/consent-store.ts'
import {
  AgentApprovalError,
  AgentApprovalService,
  type AgentToolApprovalRequest
} from '../../src/main/services/agent-approval-service.ts'

const workspaceToken = `ws_${'a'.repeat(43)}`
const turnId = `turn_${'b'.repeat(32)}`

function request(
  signal: AbortSignal,
  overrides: Partial<AgentToolApprovalRequest> = {}
): AgentToolApprovalRequest {
  return {
    turnId,
    callId: 'call_read_1',
    workspaceToken,
    operation: 'read',
    toolName: 'read_file',
    arguments: { relative_path: 'src/main.ts' },
    label: 'Read src/main.ts',
    risk: 'low',
    mode: 'request',
    signal,
    ...overrides
  }
}

function harness(): { service: AgentApprovalService; events: AgentEvent[] } {
  const events: AgentEvent[] = []
  const service = new AgentApprovalService({
    consents: new ConsentStore(),
    onEvent: (event) => events.push(event)
  })
  return { service, events }
}

test('manual approval is opaque, exact, single-use and bound before local execution', async () => {
  const { service, events } = harness()
  const controller = new AbortController()
  const pending = service.authorize(request(controller.signal))
  await new Promise<void>((resolve) => setImmediate(resolve))

  const approval = events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  assert.match(approval.approvalId, /^approval_[A-Za-z0-9_-]{24}$/)
  assert.equal(service.resolve('approval_missing', 'allow_once'), false)
  assert.equal(service.resolve(approval.approvalId, 'allow_once'), true)

  const authorization = await pending
  assert.ok(authorization)
  assert.equal(authorization.decisionSource, 'user')
  assert.equal(service.consume(authorization), true)
  assert.equal(service.consume(authorization), false)
  assert.equal(service.resolve(approval.approvalId, 'allow_once'), false)
})

test('deny and cancellation never issue a consumable local capability', async () => {
  const deniedHarness = harness()
  const denied = deniedHarness.service.authorize(request(new AbortController().signal))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const approval = deniedHarness.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  assert.equal(deniedHarness.service.resolve(approval.approvalId, 'deny'), true)
  assert.equal(await denied, null)

  const cancelledHarness = harness()
  const controller = new AbortController()
  const cancelled = cancelledHarness.service.authorize(request(controller.signal))
  await new Promise<void>((resolve) => setImmediate(resolve))
  controller.abort()
  assert.equal(await cancelled, null)
})

test('auto mode permits only low-risk read categories while full mode still produces a one-time grant', async () => {
  const { service, events } = harness()
  const signal = new AbortController().signal

  const autoRead = await service.authorize(request(signal, { mode: 'auto' }))
  assert.ok(autoRead)
  assert.equal(autoRead.decisionSource, 'policy')
  assert.equal(service.consume(autoRead), true)

  const autoWrite = await service.authorize(request(signal, {
    mode: 'auto',
    operation: 'write',
    toolName: 'write_file',
    risk: 'medium'
  }))
  assert.equal(autoWrite, null)

  const fullExecute = await service.authorize(request(signal, {
    mode: 'full',
    operation: 'execute',
    toolName: 'run_command',
    risk: 'high'
  }))
  assert.ok(fullExecute)
  assert.equal(fullExecute.decisionSource, 'full')
  assert.equal(service.consume(fullExecute), true)
  assert.equal(events.some((event) => event.type === 'approval-request'), false)
})

test('turn cancellation and disposal revoke pending approval requests', async () => {
  const { service } = harness()
  const first = service.authorize(request(new AbortController().signal))
  await new Promise<void>((resolve) => setImmediate(resolve))
  service.cancelTurn(turnId)
  assert.equal(await first, null)

  const second = service.authorize(request(new AbortController().signal, {
    turnId: `turn_${'c'.repeat(32)}`,
    callId: 'call_read_2'
  }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  service.dispose()
  assert.equal(await second, null)
  await assert.rejects(
    service.authorize(request(new AbortController().signal)),
    (error: unknown) => error instanceof AgentApprovalError && error.code === 'disposed'
  )
})

test('invalid bindings fail with fixed errors and emitted labels are redacted', async () => {
  const { service, events } = harness()
  await assert.rejects(
    service.authorize(request(new AbortController().signal, { workspaceToken: 'D:\\private\\workspace' })),
    (error: unknown) => {
      assert.ok(error instanceof AgentApprovalError)
      assert.equal(error.code, 'invalid_request')
      assert.doesNotMatch(error.message, /private|workspace|D:\\/i)
      return true
    }
  )

  const pending = service.authorize(request(new AbortController().signal, {
    label: 'Read D:\\private\\secret.txt with Bearer sk-test-private-marker-redaction-fixture'
  }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const serialized = JSON.stringify(events)
  assert.doesNotMatch(serialized, /D:\\|private|secret\.txt|sk-test-private-marker/i)
  const approval = events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  service.resolve(approval.approvalId, 'deny')
  assert.equal(await pending, null)
})
