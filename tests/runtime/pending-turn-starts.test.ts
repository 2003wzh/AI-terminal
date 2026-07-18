import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PendingTurnStartError,
  PendingTurnStarts,
  isTurnStartRequestId
} from '../../src/main/runtime/pending-turn-starts.ts'

const FIRST_REQUEST = 'start:00000000-0000-4000-8000-000000000001'
const SECOND_REQUEST = 'start:00000000-0000-4000-8000-000000000002'

test('request IDs are exact and cancellation aborts only the selected pending start', () => {
  const pending = new PendingTurnStarts()
  const first = pending.begin(FIRST_REQUEST)
  const second = pending.begin(SECOND_REQUEST)

  assert.equal(isTurnStartRequestId(FIRST_REQUEST), true)
  assert.equal(isTurnStartRequestId('start:not-a-uuid'), false)
  assert.equal(pending.cancel('start:not-a-uuid'), false)
  assert.equal(pending.cancel(FIRST_REQUEST), true)
  assert.equal(first.aborted, true)
  assert.equal(first.reason, 'turn_start_cancelled')
  assert.equal(second.aborted, false)
  assert.throws(() => pending.assertActive(first), hasErrorCode('cancelled'))
  assert.doesNotThrow(() => pending.assertActive(second))

  pending.finish(FIRST_REQUEST, first)
  assert.equal(pending.size, 1)
  pending.finish(SECOND_REQUEST, second)
  assert.equal(pending.size, 0)
})

test('pending starts reject duplicate IDs and enforce capacity', () => {
  const pending = new PendingTurnStarts(1)
  const first = pending.begin(FIRST_REQUEST)

  assert.throws(() => pending.begin(FIRST_REQUEST), hasErrorCode('duplicate_request'))
  assert.throws(() => pending.begin(SECOND_REQUEST), hasErrorCode('capacity_exceeded'))
  pending.finish(FIRST_REQUEST, first)
  assert.doesNotThrow(() => pending.begin(SECOND_REQUEST))
})

test('abortAll cancels every request and remains idempotent', () => {
  const pending = new PendingTurnStarts()
  const first = pending.begin(FIRST_REQUEST)
  const second = pending.begin(SECOND_REQUEST)

  pending.abortAll()
  pending.abortAll()

  assert.equal(first.aborted, true)
  assert.equal(second.aborted, true)
  assert.equal(first.reason, 'turn_start_cancelled')
  assert.equal(second.reason, 'turn_start_cancelled')
  assert.equal(pending.size, 0)
  assert.equal(pending.cancel(FIRST_REQUEST), false)
})

function hasErrorCode(code: PendingTurnStartError['code']): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof PendingTurnStartError)
    assert.equal(error.code, code)
    assert.equal(error.stack, `${error.name}: ${error.message}`)
    return true
  }
}
