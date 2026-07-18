import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RelayDtoAdapterError,
  normalizeRemoteRelayUsageInput,
  toRemoteRelayBillingConfig,
  toRemoteRelayConnection,
  toRemoteRelayDeviceAuthorization,
  toRemoteRelayDeviceAuthorizationPoll,
  toRemoteRelayOverview,
  toRemoteRelayPricing,
  toRemoteRelayToken,
  toRemoteRelayTokenMutation,
  toRemoteRelayTokenPage,
  toRemoteRelayUsage
} from '../../src/main/services/relay-dto-adapter.ts'
import type {
  RelayApiTokenDto,
  RelayApiTokenPageDto,
  RelayDesktopBillingConfigV1Dto,
  RelayDesktopUsageV1Dto,
  RelayDeviceAuthorizationDto,
  RelayPricingDto,
  RelayUsageRecordDto
} from '../../src/main/services/relay-service.ts'
import type { RemoteRelayUsageInput } from '../../src/shared/contracts.ts'

const ENDPOINT = 'https://www.wzhxiaozhan.top'
const DEVICE_ID = 'desktop-device-safe-id'

test('connection state requires endpoint confirmation before exposing authentication', () => {
  assert.deepEqual(
    toRemoteRelayConnection(ENDPOINT, false, { authenticated: true, device_id: DEVICE_ID }),
    {
      endpoint: ENDPOINT,
      endpointConsent: { status: 'required', endpointLabel: ENDPOINT },
      authenticated: false,
      deviceId: null
    }
  )

  assert.deepEqual(
    toRemoteRelayConnection(ENDPOINT, true, { authenticated: false, device_id: DEVICE_ID }),
    {
      endpoint: ENDPOINT,
      endpointConsent: { status: 'confirmed', endpointLabel: ENDPOINT },
      authenticated: false,
      deviceId: null
    }
  )

  const connected = toRemoteRelayConnection(
    ENDPOINT,
    true,
    { authenticated: true, device_id: DEVICE_ID }
  )
  assert.equal(connected.authenticated, true)
  assert.equal(connected.deviceId, DEVICE_ID)
  assert.deepEqual(Object.keys(connected).sort(), [
    'authenticated',
    'deviceId',
    'endpoint',
    'endpointConsent'
  ])
  assert.doesNotMatch(JSON.stringify(connected), /authHandle|consentHandle|accessToken|refreshToken/i)
})

test('device authorization maps only the opaque session and public verification fields', () => {
  const privateCompleteUriMarker = 'complete-uri-private-marker'
  const privateDeviceCode = 'desktop-device-code-private-marker'
  const coreValue = {
    session_id: 'relay-session-1',
    user_code: 'ABCD-EFGH',
    verification_uri: `${ENDPOINT}/desktop/authorize`,
    verification_uri_complete: `${ENDPOINT}/desktop/authorize?private=${privateCompleteUriMarker}`,
    expires_in: 600,
    interval: 5,
    expires_at: 1_800_000_600,
    device_code: privateDeviceCode
  } as RelayDeviceAuthorizationDto & { device_code: string }

  const value = toRemoteRelayDeviceAuthorization(coreValue)
  assert.deepEqual(value, {
    sessionId: 'relay-session-1',
    userCode: 'ABCD-EFGH',
    verificationUri: `${ENDPOINT}/desktop/authorize`,
    expiresAt: '2027-01-15T08:10:00.000Z',
    intervalSeconds: 5
  })
  const serialized = JSON.stringify(value)
  assert.doesNotMatch(serialized, new RegExp(privateCompleteUriMarker))
  assert.doesNotMatch(serialized, new RegExp(privateDeviceCode))
  assert.doesNotMatch(serialized, /verificationUriComplete|deviceCode|device_code/i)

  assert.deepEqual(
    toRemoteRelayDeviceAuthorizationPoll({ status: 'pending', retry_after: 5 }),
    { status: 'pending', retryAfterSeconds: 5 }
  )
  assert.deepEqual(
    toRemoteRelayDeviceAuthorizationPoll({ status: 'slow_down', retry_after: 10 }),
    { status: 'slow_down', retryAfterSeconds: 10 }
  )
  assert.deepEqual(
    toRemoteRelayDeviceAuthorizationPoll({ status: 'authenticated', device_id: DEVICE_ID }),
    { status: 'authenticated', deviceId: DEVICE_ID }
  )
  assert.deepEqual(toRemoteRelayDeviceAuthorizationPoll({ status: 'expired' }), { status: 'expired' })
  assert.deepEqual(toRemoteRelayDeviceAuthorizationPoll({ status: 'denied' }), { status: 'denied' })
})

test('overview preserves real quota semantics and bounded group and model data', () => {
  const value = toRemoteRelayOverview(
    {
      id: 9,
      username: 'tester',
      display_name: 'Test User',
      email: 'test@example.test',
      group: 'default',
      quota: 500_000,
      used_quota: 20_000,
      request_count: 4,
      status: 1,
      role: 2
    },
    {
      zeta: { ratio: 'auto' },
      default: { ratio: 1, desc: 'Default group' }
    },
    ['gpt-test', 'claude-test'],
    '2026-07-16T00:00:00.000Z'
  )

  assert.deepEqual(value.account, {
    id: 9,
    username: 'tester',
    displayName: 'Test User',
    email: 'test@example.test',
    group: 'default',
    status: 1,
    role: 2
  })
  assert.deepEqual(value.quota, { total: 520_000, used: 20_000, remaining: 500_000 })
  assert.equal(value.requestCount, 4)
  assert.deepEqual(value.groups, [
    { id: 'default', ratio: 1, description: 'Default group' },
    { id: 'zeta', ratio: 'auto', description: null }
  ])
  assert.deepEqual(value.models, ['gpt-test', 'claude-test'])
  assert.equal(value.updatedAt, '2026-07-16T00:00:00.000Z')

  const missingQuota = toRemoteRelayOverview({ id: 10 }, {}, [], '2026-07-16T00:00:00.000Z')
  assert.deepEqual(missingQuota.quota, { total: null, used: null, remaining: null })
  assert.equal(missingQuota.requestCount, null)
})

test('billing config exposes only renderer-safe display fields', () => {
  const value: RelayDesktopBillingConfigV1Dto = {
    schema_version: 1,
    quota_per_unit: 500_000,
    display_in_currency: true,
    quota_display_type: 'USD',
    usd_exchange_rate: 7.3,
    custom_currency_symbol: '¤',
    custom_currency_exchange_rate: 1
  }

  const rendererValue = toRemoteRelayBillingConfig(value)
  assert.deepEqual(rendererValue, {
    quotaPerUnit: 500_000,
    displayInCurrency: true,
    quotaDisplayType: 'USD',
    usdExchangeRate: 7.3,
    customCurrencySymbol: '¤',
    customCurrencyExchangeRate: 1
  })
  assert.doesNotMatch(JSON.stringify(rendererValue), /schema_version|quota_per_unit/i)
})

test('token pages retain only core-masked keys and canonical status and timestamps', () => {
  const tokens: RelayApiTokenDto[] = [
    {
      id: 7,
      name: 'Desktop active',
      key: 'sk-********',
      status: 1,
      remain_quota: 100,
      used_quota: 20,
      unlimited_quota: false,
      group: 'default',
      model_limits: 'gpt-test',
      created_time: 1_700_000_000,
      accessed_time: 1_700_000_100,
      expired_time: -1,
      allow_ips: '127.0.0.1'
    },
    {
      id: 8,
      name: 'Desktop disabled',
      key: '',
      status: 2,
      created_time: 0,
      accessed_time: 0,
      expired_time: 0
    },
    { id: 9, name: 'Unavailable', key: 'sk-********', status: 3 }
  ]
  const pageInput: RelayApiTokenPageDto = {
    page: 2,
    page_size: 20,
    total: 3,
    items: tokens
  }

  const page = toRemoteRelayTokenPage(pageInput)
  assert.equal(page.page, 2)
  assert.equal(page.pageSize, 20)
  assert.equal(page.total, 3)
  assert.deepEqual(page.items.map((token) => token.status), ['active', 'disabled', 'unavailable'])
  assert.deepEqual(page.items[0], {
    id: 7,
    name: 'Desktop active',
    maskedKey: 'sk-********',
    status: 'active',
    remainQuota: 100,
    usedQuota: 20,
    unlimitedQuota: false,
    group: 'default',
    modelLimits: 'gpt-test',
    createdAt: '2023-11-14T22:13:20.000Z',
    lastUsedAt: '2023-11-14T22:15:00.000Z',
    expiresAt: null
  })
  assert.equal(page.items[1]?.createdAt, null)
  assert.equal(page.items[1]?.lastUsedAt, null)
  assert.equal(page.items[1]?.expiresAt, null)
  assert.doesNotMatch(JSON.stringify(page), /allow_ips|127\.0\.0\.1|user_id|cross_group/i)

  assert.deepEqual(toRemoteRelayToken(tokens[2]!), page.items[2])
})

test('usage normalization requires canonical ISO timestamps and allows exactly 30 days', () => {
  const from = '2026-06-01T00:00:00.000Z'
  const to = '2026-07-01T00:00:00.000Z'
  assert.deepEqual(normalizeRemoteRelayUsageInput({ from, to }), {
    from,
    to,
    startTimestamp: 1_780_272_000,
    endTimestamp: 1_782_864_000
  })

  for (const input of [
    { from, to: '2026-07-01T00:00:01.000Z' },
    { from: '2026-06-01T08:00:00.000+08:00', to },
    { from: to, to: from }
  ]) {
    assert.throws(
      () => normalizeRemoteRelayUsageInput(input),
      (error: unknown) => error instanceof RelayDtoAdapterError
    )
  }
})

test('usage output maps records and fails closed when safe aggregate sums overflow', () => {
  const range = {
    from: '2026-06-01T00:00:00.000Z',
    to: '2026-07-01T00:00:00.000Z'
  }
  const records: RelayUsageRecordDto[] = [
    {
      created_at: 1_780_272_000,
      count: 2,
      quota: 500_000,
      token_used: 1_200,
      model_name: 'gpt-test'
    },
    {
      created_at: 1_780_358_400,
      count: 3,
      quota: 250_000,
      token_used: 800,
      model_name: ''
    }
  ]
  const usage: RelayDesktopUsageV1Dto = {
    schema_version: 1,
    range: { start_timestamp: 1_780_272_000, end_timestamp: 1_782_864_000 },
    totals: { count: 5, quota: 750_000, token_used: 2_000 },
    records
  }
  const value = toRemoteRelayUsage(range, usage)
  assert.deepEqual(value.totals, { requests: 5, quota: 750_000, tokenUsed: 2_000 })
  assert.deepEqual(value.records[0], {
    createdAt: '2026-06-01T00:00:00.000Z',
    requests: 2,
    quota: 500_000,
    tokenUsed: 1_200,
    modelName: 'gpt-test'
  })
  assert.equal(value.records[1]?.modelName, '未提供模型')

  const overflowing: RelayUsageRecordDto[] = [
    {
      created_at: 1_780_272_000,
      count: Number.MAX_SAFE_INTEGER,
      quota: 0,
      token_used: 0,
      model_name: 'gpt-test'
    },
    {
      created_at: 1_780_358_400,
      count: 1,
      quota: 0,
      token_used: 0,
      model_name: 'gpt-test'
    }
  ]
  assert.throws(
    () => toRemoteRelayUsage(range, {
      schema_version: 1,
      range: usage.range,
      totals: { count: Number.MAX_SAFE_INTEGER, quota: 0, token_used: 0 },
      records: overflowing
    }),
    (error: unknown) => error instanceof RelayDtoAdapterError
  )
})

test('pricing exposes ratio-based fields without inventing per-token prices', () => {
  const corePricing: RelayPricingDto = {
    data: [{
      model_name: 'gpt-test',
      description: 'Test model',
      owner_by: 'openai',
      quota_type: 0,
      model_ratio: 1.25,
      model_price: 0,
      completion_ratio: 2,
      cache_ratio: 0.5,
      create_cache_ratio: 1.1,
      image_ratio: 3,
      enable_groups: ['default'],
      supported_endpoint_types: ['openai'],
      billing_mode: 'ratio',
      billing_expr: 'private server expression'
    }],
    group_ratio: { default: 1, vip: 0.8 },
    pricing_version: 'pricing-v1'
  }

  const value = toRemoteRelayPricing(corePricing)
  assert.deepEqual(value, {
    models: [{
      modelName: 'gpt-test',
      description: 'Test model',
      owner: 'openai',
      quotaType: 0,
      modelRatio: 1.25,
      modelPrice: 0,
      completionRatio: 2,
      cacheRatio: 0.5,
      imageRatio: 3,
      enabledGroups: ['default'],
      endpointTypes: ['openai'],
      billingMode: 'ratio'
    }],
    groupRatios: { default: 1, vip: 0.8 },
    pricingVersion: 'pricing-v1'
  })
  assert.doesNotMatch(JSON.stringify(value), /billing_expr|private server expression|per_million|cachedInput/i)
})

test('token mutation mapping verifies status and reports only the public mutation', () => {
  assert.deepEqual(
    toRemoteRelayTokenMutation({ id: 7, status: 1 }, 'active'),
    { tokenId: 7, status: 'active' }
  )
  assert.deepEqual(
    toRemoteRelayTokenMutation({ id: 7, status: 2 }, 'disabled'),
    { tokenId: 7, status: 'disabled' }
  )
  assert.deepEqual(
    toRemoteRelayTokenMutation({ id: 7 }, 'revoked'),
    { tokenId: 7, status: 'revoked' }
  )
  assert.throws(
    () => toRemoteRelayTokenMutation({ id: 7, status: 2 }, 'active'),
    (error: unknown) => error instanceof RelayDtoAdapterError
  )
})

test('usage input rejects extra fields and objects with non-plain prototypes', () => {
  const valid = {
    from: '2026-06-01T00:00:00.000Z',
    to: '2026-07-01T00:00:00.000Z'
  }
  const extra = { ...valid, context: { authHandle: 'must-not-cross-ipc' } }
  const inherited = Object.assign(Object.create({ context: 'inherited' }) as object, valid)
  const prototypeKey = JSON.parse(
    '{"from":"2026-06-01T00:00:00.000Z","to":"2026-07-01T00:00:00.000Z","__proto__":{}}'
  ) as unknown

  for (const input of [extra, inherited, prototypeKey]) {
    assert.throws(
      () => normalizeRemoteRelayUsageInput(input as RemoteRelayUsageInput),
      (error: unknown) => error instanceof RelayDtoAdapterError
    )
  }
})
