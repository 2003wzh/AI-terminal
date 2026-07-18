import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TurnRegistry,
  TurnRegistryError,
  type TurnStateSnapshot
} from '../../src/main/runtime/turn-registry.ts'

test('starts one opaque AbortController-backed turn per task', () => {
  const states: TurnStateSnapshot[] = []
  const registry = new TurnRegistry({ onStateChange: (state) => states.push(state) })
  const handle = registry.start('task:alpha')

  assert.match(handle.turnId, /^turn_[A-Za-z0-9_-]{32}$/)
  assert.equal(handle.signal.aborted, false)
  assert.deepEqual(registry.getSnapshot(handle.turnId), { turnId: handle.turnId, state: 'running' })
  assert.deepEqual(registry.getActiveSnapshotForTask('task:alpha'), {
    turnId: handle.turnId,
    state: 'running'
  })
  assert.equal(registry.getActiveSnapshotForTask('not a task id'), null)
  assert.deepEqual(states, [{ turnId: handle.turnId, state: 'running' }])
  assert.equal(Object.isFrozen(handle), true)
  assert.equal(Object.isFrozen(states[0]), true)

  assert.throws(
    () => registry.start('task:alpha'),
    (error) => error instanceof TurnRegistryError && error.code === 'duplicate_active_turn'
  )
  assert.deepEqual(registry.getCounts(), { active: 1, retainedTerminal: 0 })
})

test('complete and fail use first-terminal-transition-wins semantics', () => {
  const states: TurnStateSnapshot[] = []
  const registry = new TurnRegistry({ onStateChange: (state) => states.push(state) })

  const completed = registry.start('task:complete')
  assert.equal(registry.complete(completed.turnId)?.state, 'completed')
  assert.equal(registry.fail(completed.turnId)?.state, 'completed')
  assert.equal(registry.cancel(completed.turnId)?.state, 'completed')
  assert.equal(completed.signal.aborted, false)

  const restarted = registry.start('task:complete')
  assert.notEqual(restarted.turnId, completed.turnId)
  assert.equal(registry.fail(restarted.turnId)?.state, 'failed')
  assert.equal(registry.complete(restarted.turnId)?.state, 'failed')

  assert.deepEqual(states.map((state) => state.state), [
    'running',
    'completed',
    'running',
    'failed'
  ])
  assert.deepEqual(registry.getCounts(), { active: 0, retainedTerminal: 2 })
})

test('cancel is exact, aborts once and remains idempotent while retained', () => {
  const states: TurnStateSnapshot[] = []
  const registry = new TurnRegistry({ onStateChange: (state) => states.push(state) })
  const first = registry.start('task:first')
  const second = registry.start('task:second')
  let abortEvents = 0
  first.signal.addEventListener('abort', () => { abortEvents += 1 })

  assert.equal(registry.cancel('turn_00000000000000000000000000000000'), null)
  assert.equal(first.signal.aborted, false)
  assert.equal(second.signal.aborted, false)

  const cancelled = registry.cancel(first.turnId)
  assert.deepEqual(cancelled, { turnId: first.turnId, state: 'cancelled' })
  assert.equal(first.signal.aborted, true)
  assert.equal(first.signal.reason, 'turn_cancelled')
  assert.equal(second.signal.aborted, false)
  assert.equal(abortEvents, 1)

  assert.strictEqual(registry.cancel(first.turnId), cancelled)
  assert.strictEqual(registry.complete(first.turnId), cancelled)
  assert.strictEqual(registry.fail(first.turnId), cancelled)
  assert.equal(abortEvents, 1)
  assert.equal(states.filter((state) => state.turnId === first.turnId && state.state === 'cancelled').length, 1)

  assert.equal(registry.complete(second.turnId)?.state, 'completed')
  assert.equal(registry.getActiveSnapshotForTask('task:second'), null)
})

test('cancelAll aborts every active signal exactly once without returning task data', () => {
  const states: TurnStateSnapshot[] = []
  const registry = new TurnRegistry({ onStateChange: (state) => states.push(state) })
  const handles = [
    registry.start('task:cancel-all-one'),
    registry.start('task:cancel-all-two'),
    registry.start('task:cancel-all-three')
  ]
  const abortCounts = [0, 0, 0]
  handles.forEach((handle, index) => {
    handle.signal.addEventListener('abort', () => { abortCounts[index] += 1 })
  })

  assert.equal(registry.cancelAll(), undefined)
  assert.deepEqual(abortCounts, [1, 1, 1])
  assert.equal(handles.every((handle) => handle.signal.aborted), true)
  assert.equal(handles.every((handle) => handle.signal.reason === 'turn_cancelled'), true)
  assert.deepEqual(registry.getCounts(), { active: 0, retainedTerminal: 3 })
  assert.equal(states.filter((state) => state.state === 'cancelled').length, 3)

  registry.cancelAll()
  assert.deepEqual(abortCounts, [1, 1, 1])
  assert.deepEqual(registry.getCounts(), { active: 0, retainedTerminal: 3 })
})

test('cancel, complete and fail races settle on the first terminal transition', async () => {
  const registry = new TurnRegistry()

  const cancelFirst = registry.start('task:cancel-race')
  const cancelled = await Promise.all([
    Promise.resolve().then(() => registry.cancel(cancelFirst.turnId)),
    Promise.resolve().then(() => registry.complete(cancelFirst.turnId)),
    Promise.resolve().then(() => registry.fail(cancelFirst.turnId))
  ])
  assert.deepEqual(cancelled.map((state) => state?.state), ['cancelled', 'cancelled', 'cancelled'])
  assert.equal(cancelFirst.signal.aborted, true)

  const completeFirst = registry.start('task:complete-race')
  const completed = await Promise.all([
    Promise.resolve().then(() => registry.complete(completeFirst.turnId)),
    Promise.resolve().then(() => registry.cancel(completeFirst.turnId)),
    Promise.resolve().then(() => registry.fail(completeFirst.turnId))
  ])
  assert.deepEqual(completed.map((state) => state?.state), ['completed', 'completed', 'completed'])
  assert.equal(completeFirst.signal.aborted, false)

  const failFirst = registry.start('task:fail-race')
  const failed = await Promise.all([
    Promise.resolve().then(() => registry.fail(failFirst.turnId)),
    Promise.resolve().then(() => registry.cancel(failFirst.turnId)),
    Promise.resolve().then(() => registry.complete(failFirst.turnId))
  ])
  assert.deepEqual(failed.map((state) => state?.state), ['failed', 'failed', 'failed'])
  assert.equal(failFirst.signal.aborted, false)
})

test('terminal cleanup is bounded and safe surfaces never expose task or secret data', () => {
  const callbackPayloads: TurnStateSnapshot[] = []
  const registry = new TurnRegistry({
    maxActiveTurns: 2,
    maxRetainedTurns: 2,
    onStateChange: (state) => callbackPayloads.push(state)
  })
  const first = registry.start('task:safe-one')
  registry.complete(first.turnId)
  const second = registry.start('task:safe-two')
  registry.fail(second.turnId)
  const third = registry.start('task:safe-three')
  registry.cancel(third.turnId)

  assert.equal(registry.getSnapshot(first.turnId), null)
  assert.equal(registry.getSnapshot(second.turnId)?.state, 'failed')
  assert.equal(registry.getSnapshot(third.turnId)?.state, 'cancelled')
  assert.deepEqual(registry.getCounts(), { active: 0, retainedTerminal: 2 })

  const serialized = JSON.stringify({ callbackPayloads, handle: third, counts: registry.getCounts() })
  for (const sensitive of [
    'sk-exampleSecret123',
    'Bearer exampleAuthorization123',
    'D:\\private\\workspace\\secret.txt',
    '/home/alice/private.txt',
    'private prompt content'
  ]) {
    assert.doesNotMatch(serialized, new RegExp(sensitive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.deepEqual(Object.keys(callbackPayloads[0] ?? {}).sort(), ['state', 'turnId'])

  let invalidError: unknown
  try {
    registry.start('D:\\private\\workspace\\sk-exampleSecret123')
  } catch (error) {
    invalidError = error
  }
  assert.ok(invalidError instanceof TurnRegistryError)
  assert.equal(invalidError.code, 'invalid_task_id')
  assert.doesNotMatch(invalidError.message, /private|workspace|exampleSecret/)
  assert.equal(invalidError.stack, 'TurnRegistryError: The task identifier is invalid.')
})

test('active capacity and callback failures use fixed safe behavior', () => {
  const registry = new TurnRegistry({
    maxActiveTurns: 1,
    onStateChange: () => { throw new Error('callback diagnostics must not escape') }
  })
  const active = registry.start('task:capacity-one')
  assert.equal(registry.getSnapshot(active.turnId)?.state, 'running')

  assert.throws(
    () => registry.start('task:capacity-two'),
    (error) => error instanceof TurnRegistryError && error.code === 'active_turn_capacity'
  )
  assert.equal(registry.cancel(active.turnId)?.state, 'cancelled')
})
