import assert from 'node:assert/strict'
import test from 'node:test'

import { relayAccountName } from '../../src/renderer/src/relay-identity.ts'
import type { RemoteRelayOverviewDto } from '../../src/shared/contracts.ts'

function account(
  overrides: Partial<RemoteRelayOverviewDto['account']> = {},
): RemoteRelayOverviewDto['account'] {
  return {
    id: 7,
    username: null,
    displayName: '已登录用户',
    email: null,
    group: null,
    status: 1,
    role: 1,
    ...overrides,
  }
}

test('authenticated relay identity prefers the validated server username', () => {
  assert.equal(
    relayAccountName(account({ username: 'demo-user', displayName: 'Profile Alias' })),
    'demo-user',
  )
})

test('authenticated relay identity falls back only to the validated server display name', () => {
  assert.equal(relayAccountName(account({ displayName: 'WZH User' })), 'WZH User')
})
