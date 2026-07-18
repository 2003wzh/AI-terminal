import assert from 'node:assert/strict'
import test from 'node:test'

import { WorkspaceLaunchTokenStore } from '../../src/main/services/workspace-launch-token-store.ts'

const WORKSPACE_A = `ws_${'a'.repeat(43)}`
const WORKSPACE_B = `ws_${'b'.repeat(43)}`

test('workspace launch capabilities are opaque, owner-bound, workspace-bound, and one-shot', () => {
  const store = new WorkspaceLaunchTokenStore()
  const token = store.issue(WORKSPACE_A, 17, ['vscode', 'terminal'])

  assert.match(token ?? '', /^wl_[A-Za-z0-9_-]{43}$/u)
  assert.equal(token?.includes(WORKSPACE_A), false)
  assert.equal(store.consume({
    launchToken: token,
    workspaceToken: WORKSPACE_A,
    openerId: 'vscode',
    ownerWebContentsId: 18
  }), 'invalid')
  assert.equal(store.consume({
    launchToken: token,
    workspaceToken: WORKSPACE_A,
    openerId: 'vscode',
    ownerWebContentsId: 17
  }), 'authorized')
  assert.equal(store.consume({
    launchToken: token,
    workspaceToken: WORKSPACE_A,
    openerId: 'vscode',
    ownerWebContentsId: 17
  }), 'invalid')
})

test('workspace and opener binding failures consume the owner token', () => {
  const store = new WorkspaceLaunchTokenStore()
  const workspaceMismatch = store.issue(WORKSPACE_A, 4, ['cursor'])
  assert.equal(store.consume({
    launchToken: workspaceMismatch,
    workspaceToken: WORKSPACE_B,
    openerId: 'cursor',
    ownerWebContentsId: 4
  }), 'invalid')
  assert.equal(store.consume({
    launchToken: workspaceMismatch,
    workspaceToken: WORKSPACE_A,
    openerId: 'cursor',
    ownerWebContentsId: 4
  }), 'invalid')

  const openerMismatch = store.issue(WORKSPACE_A, 4, ['terminal'])
  assert.equal(store.consume({
    launchToken: openerMismatch,
    workspaceToken: WORKSPACE_A,
    openerId: 'explorer',
    ownerWebContentsId: 4
  }), 'invalid')
})

test('workspace launch capabilities expire and are revoked with their owner', () => {
  let now = 1_000
  const store = new WorkspaceLaunchTokenStore({ now: () => now, tokenLifetimeMs: 100 })
  const expired = store.issue(WORKSPACE_A, 8, ['explorer'])
  now = 1_100
  assert.equal(store.consume({
    launchToken: expired,
    workspaceToken: WORKSPACE_A,
    openerId: 'explorer',
    ownerWebContentsId: 8
  }), 'invalid')

  const revoked = store.issue(WORKSPACE_A, 8, ['explorer'])
  store.revokeOwner(8)
  assert.equal(store.consume({
    launchToken: revoked,
    workspaceToken: WORKSPACE_A,
    openerId: 'explorer',
    ownerWebContentsId: 8
  }), 'invalid')
})

test('workspace launches are rate limited without making tokens reusable', () => {
  let now = 10_000
  const store = new WorkspaceLaunchTokenStore({
    now: () => now,
    launchWindowMs: 1_000,
    maxLaunchesPerWindow: 2
  })
  const consume = (launchToken: string | null) => store.consume({
    launchToken,
    workspaceToken: WORKSPACE_A,
    openerId: 'terminal',
    ownerWebContentsId: 22
  })

  assert.equal(consume(store.issue(WORKSPACE_A, 22, ['terminal'])), 'authorized')
  assert.equal(consume(store.issue(WORKSPACE_A, 22, ['terminal'])), 'authorized')
  const limited = store.issue(WORKSPACE_A, 22, ['terminal'])
  assert.equal(consume(limited), 'rate_limited')
  assert.equal(consume(limited), 'invalid')

  now = 11_001
  assert.equal(consume(store.issue(WORKSPACE_A, 22, ['terminal'])), 'authorized')
})

test('workspace launch token capacity is bounded and recovers after expiry', () => {
  let now = 50
  const store = new WorkspaceLaunchTokenStore({
    now: () => now,
    tokenLifetimeMs: 10,
    maxRecords: 1
  })
  assert.ok(store.issue(WORKSPACE_A, 1, ['explorer']))
  assert.equal(store.issue(WORKSPACE_A, 1, ['explorer']), null)
  now = 60
  assert.ok(store.issue(WORKSPACE_A, 1, ['explorer']))
})
