import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_RELAY_SERVER_ORIGIN,
  RelayService,
  RelayServiceError,
  normalizeRelayServerOrigin
} from '../../src/main/services/relay-service.ts'
import type {
  RelayEncryptedCredentialStorage,
  RelayStoredCredential
} from '../../src/main/services/relay-service.ts'

const ACCESS_SECRET = 'desktop_at_access_secret_value'
const REFRESH_SECRET = 'desktop_rt_refresh_secret_value'
const ROTATED_ACCESS_SECRET = 'desktop_at_rotated_access_value'
const ROTATED_REFRESH_SECRET = 'desktop_rt_rotated_refresh_value'
const DEVICE_ID = 'desktop_device_123'

const FIXED_DESKTOP_USAGE_V1_RESPONSE = Object.freeze({
  schema_version: 1,
  range: Object.freeze({ start_timestamp: 1_699_999_000, end_timestamp: 1_700_000_000 }),
  totals: Object.freeze({ count: 2, quota: 500_000, token_used: 1_200 }),
  records: Object.freeze([Object.freeze({
    created_at: 1_700_000_000,
    count: 2,
    quota: 500_000,
    token_used: 1_200,
    model_name: 'gpt-test'
  })])
})

const FIXED_DESKTOP_BILLING_CONFIG_V1_RESPONSE = Object.freeze({
  schema_version: 1,
  quota_per_unit: 500_000,
  display_in_currency: true,
  quota_display_type: 'USD',
  usd_exchange_rate: 7.3,
  custom_currency_symbol: '¤',
  custom_currency_exchange_rate: 1
})

interface ObservedRequest {
  url: string
  init: RequestInit
  body: unknown
}

class FakeEncryptedStorage implements RelayEncryptedCredentialStorage {
  credential: unknown
  readonly saved: RelayStoredCredential[] = []
  clearCalls = 0
  beforeSave: (() => void) | null = null
  saveError: Error | null = null
  loadError: Error | null = null

  constructor(credential: unknown = null) {
    this.credential = credential
  }

  async loadCredential(): Promise<unknown> {
    if (this.loadError) throw this.loadError
    return structuredClone(this.credential)
  }

  async saveCredential(credential: RelayStoredCredential): Promise<void> {
    this.beforeSave?.()
    if (this.saveError) throw this.saveError
    const copy = structuredClone(credential)
    this.saved.push(copy)
    this.credential = copy
  }

  async clearCredential(): Promise<void> {
    this.clearCalls += 1
    this.credential = null
  }
}

function apiSuccess(data: unknown, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ success: true, message: '', data, ...extra })
}

function apiFailure(error: string, rawMessage: string, status = 400): Response {
  return jsonResponse({ success: false, error, message: rawMessage }, status)
}

function jsonResponse(payload: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders }
  })
}

function queueFetch(responses: Array<Response | ((request: ObservedRequest) => Response | Promise<Response>)>): {
  fetcher: typeof fetch
  requests: ObservedRequest[]
} {
  const requests: ObservedRequest[] = []
  const queue = [...responses]
  const fetcher = (async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : null
    const request = { url, init, body }
    requests.push(request)
    const next = queue.shift()
    assert.ok(next, `unexpected fetch: ${url}`)
    return typeof next === 'function' ? next(request) : next
  }) as typeof fetch
  return { fetcher, requests }
}

function storedCredential(nowMs: number, refreshToken = REFRESH_SECRET): RelayStoredCredential {
  return {
    version: 1,
    server_origin: DEFAULT_RELAY_SERVER_ORIGIN,
    refresh_token: refreshToken,
    device_id: DEVICE_ID,
    refresh_expires_at: Math.floor(nowMs / 1000) + 2_592_000,
    updated_at: Math.floor(nowMs / 1000) - 60
  }
}

function tokenPayload(
  accessToken = ACCESS_SECRET,
  refreshToken = REFRESH_SECRET,
  deviceId = DEVICE_ID
): Record<string, unknown> {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    device_id: deviceId,
    expires_in: 900,
    refresh_expires_in: 2_592_000,
    token_type: 'Bearer'
  }
}

function confirmedService(
  storage: RelayEncryptedCredentialStorage,
  fetcher: typeof fetch,
  options: Partial<ConstructorParameters<typeof RelayService>[0]> = {}
): RelayService {
  const service = new RelayService({ credentialStorage: storage, fetcher, ...options })
  service.confirmEndpoint(DEFAULT_RELAY_SERVER_ORIGIN)
  return service
}

function assertSafeError(error: unknown, code: string, forbidden: readonly string[] = []): boolean {
  assert.ok(error instanceof RelayServiceError)
  assert.equal(error.code, code)
  const exposed = JSON.stringify({
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code,
    retryable: error.retryable
  })
  for (const marker of forbidden) assert.doesNotMatch(exposed, new RegExp(escapeRegExp(marker), 'i'))
  return true
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test('origin requires HTTPS except exact loopback development endpoints and every request requires confirmation', async () => {
  const storage = new FakeEncryptedStorage()
  let fetchCalls = 0
  const service = new RelayService({
    credentialStorage: storage,
    fetcher: (async () => {
      fetchCalls += 1
      return apiSuccess([])
    }) as typeof fetch
  })

  assert.equal(service.serverOrigin, DEFAULT_RELAY_SERVER_ORIGIN)
  await assert.rejects(service.getPricing(), (error: unknown) => assertSafeError(error, 'endpoint_not_confirmed'))
  assert.equal(fetchCalls, 0)
  assert.throws(
    () => service.confirmEndpoint('https://other.example.test'),
    (error: unknown) => assertSafeError(error, 'invalid_endpoint', ['other.example.test'])
  )

  assert.equal(normalizeRelayServerOrigin('https://EXAMPLE.test:443'), 'https://example.test')
  assert.equal(normalizeRelayServerOrigin('http://127.0.0.1:4173'), 'http://127.0.0.1:4173')
  assert.equal(normalizeRelayServerOrigin('http://localhost:4173'), 'http://localhost:4173')
  assert.equal(normalizeRelayServerOrigin('http://[::1]:4173'), 'http://[::1]:4173')
  for (const value of [
    'http://www.wzhxiaozhan.top',
    'http://127.0.0.2:4173',
    'https://user:fixture-secret@relay.example.test',
    'https://www.wzhxiaozhan.top/api',
    'https://www.wzhxiaozhan.top?token=secret',
    ' https://www.wzhxiaozhan.top'
  ]) {
    assert.throws(
      () => normalizeRelayServerOrigin(value),
      (error: unknown) => assertSafeError(error, 'invalid_endpoint', [value])
    )
  }
})

test('device-code state machine stores the rotating refresh credential before enabling access', async () => {
  let now = 1_800_000_000_000
  const storage = new FakeEncryptedStorage()
  const queued = queueFetch([
    apiSuccess({
      device_code: 'desktop_dc_private_value',
      user_code: 'ABCD-EFGH',
      verification_uri: `${DEFAULT_RELAY_SERVER_ORIGIN}/desktop/authorize`,
      verification_uri_complete: `${DEFAULT_RELAY_SERVER_ORIGIN}/desktop/authorize?user_code=ABCD-EFGH`,
      expires_in: 600,
      interval: 5
    }),
    apiFailure('authorization_pending', 'raw pending details with desktop_dc_private_value'),
    apiSuccess(tokenPayload()),
    apiSuccess({ id: 7, username: 'tester', device_id: DEVICE_ID })
  ])
  const service = confirmedService(storage, queued.fetcher, {
    now: () => now,
    createSessionId: () => 'relay-session-1'
  })
  storage.beforeSave = () => {
    assert.equal(service.getAuthenticationState().authenticated, false)
  }

  const started = await service.startDeviceAuthorization({
    device_name: 'Test PC',
    platform: 'Windows',
    client_version: '0.3.1'
  })
  assert.equal(started.session_id, 'relay-session-1')
  assert.equal(started.user_code, 'ABCD-EFGH')
  assert.equal(
    service.getDeviceAuthorizationUrl(started.session_id),
    `${DEFAULT_RELAY_SERVER_ORIGIN}/desktop/authorize?user_code=ABCD-EFGH`
  )
  assert.throws(
    () => service.getDeviceAuthorizationUrl('unknown-session'),
    (error: unknown) => assertSafeError(error, 'invalid_input')
  )
  assert.doesNotMatch(JSON.stringify(started), /desktop_dc_private_value|access_token|refresh_token/i)
  assert.deepEqual(queued.requests[0]?.body, {
    device_name: 'Test PC',
    platform: 'Windows',
    client_version: '0.3.1'
  })
  assert.equal(queued.requests[0]?.init.redirect, 'manual')

  const early = await service.pollDeviceAuthorization(started.session_id)
  assert.deepEqual(early, { status: 'pending', retry_after: 5 })
  assert.equal(queued.requests.length, 1)

  now += 5_000
  const pending = await service.pollDeviceAuthorization(started.session_id)
  assert.deepEqual(pending, { status: 'pending', retry_after: 5 })
  assert.doesNotMatch(JSON.stringify(pending), /desktop_dc_private_value|raw pending/i)

  now += 5_000
  const completed = await service.pollDeviceAuthorization(started.session_id)
  assert.deepEqual(completed, { status: 'authenticated', device_id: DEVICE_ID })
  assert.equal(storage.saved.length, 1)
  assert.equal(storage.saved[0]?.refresh_token, REFRESH_SECRET)
  const persisted = JSON.stringify(storage.saved[0])
  assert.doesNotMatch(persisted, new RegExp(ACCESS_SECRET))
  assert.doesNotMatch(persisted, /access_token/i)
  assert.equal(service.getAuthenticationState().authenticated, true)
  assert.throws(
    () => service.getDeviceAuthorizationUrl(started.session_id),
    (error: unknown) => assertSafeError(error, 'invalid_input')
  )

  const account = await service.getSelf()
  assert.deepEqual(account, { id: 7, username: 'tester', device_id: DEVICE_ID })
  const headers = new Headers(queued.requests[3]?.init.headers)
  assert.equal(headers.get('authorization'), `Bearer ${ACCESS_SECRET}`)
  assert.doesNotMatch(JSON.stringify({ started, completed, account }), new RegExp(`${ACCESS_SECRET}|${REFRESH_SECRET}`))
})

test('complete device authorization URLs expire with their opaque Main-process session', async () => {
  let now = 1_800_000_000_000
  const queued = queueFetch([
    apiSuccess({
      device_code: 'desktop_dc_expiring_private_value',
      user_code: 'EXPIRE-1',
      verification_uri: `${DEFAULT_RELAY_SERVER_ORIGIN}/desktop/authorize`,
      verification_uri_complete: `${DEFAULT_RELAY_SERVER_ORIGIN}/desktop/authorize?user_code=EXPIRE-1`,
      expires_in: 60,
      interval: 5
    })
  ])
  const service = confirmedService(new FakeEncryptedStorage(), queued.fetcher, {
    now: () => now,
    createSessionId: () => 'relay-session-expiring'
  })
  const started = await service.startDeviceAuthorization({
    device_name: 'Test PC',
    platform: 'Windows',
    client_version: '0.3.1'
  })

  assert.equal(
    service.getDeviceAuthorizationUrl(started.session_id),
    `${DEFAULT_RELAY_SERVER_ORIGIN}/desktop/authorize?user_code=EXPIRE-1`
  )
  now += 60_000
  assert.throws(
    () => service.getDeviceAuthorizationUrl(started.session_id),
    (error: unknown) => assertSafeError(error, 'authorization_expired')
  )
  assert.throws(
    () => service.getDeviceAuthorizationUrl(started.session_id),
    (error: unknown) => assertSafeError(error, 'invalid_input')
  )
})

test('restore rotates refresh tokens atomically and rejects non-rotating responses', async () => {
  const now = 1_800_000_000_000
  const storage = new FakeEncryptedStorage(storedCredential(now))
  const queued = queueFetch([
    apiSuccess(tokenPayload(ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET))
  ])
  const service = confirmedService(storage, queued.fetcher, { now: () => now })
  const restored = await service.restoreSession()

  assert.deepEqual(restored, { authenticated: true, device_id: DEVICE_ID })
  assert.equal(storage.saved.length, 1)
  assert.equal(storage.saved[0]?.refresh_token, ROTATED_REFRESH_SECRET)
  assert.doesNotMatch(JSON.stringify(storage.saved[0]), new RegExp(ROTATED_ACCESS_SECRET))
  assert.deepEqual(queued.requests[0]?.body, { refresh_token: REFRESH_SECRET })

  const staleStorage = new FakeEncryptedStorage(storedCredential(now))
  const staleQueue = queueFetch([
    apiSuccess(tokenPayload(ROTATED_ACCESS_SECRET, REFRESH_SECRET))
  ])
  const staleService = confirmedService(staleStorage, staleQueue.fetcher, { now: () => now })
  await assert.rejects(
    staleService.restoreSession(),
    (error: unknown) => assertSafeError(error, 'invalid_response', [REFRESH_SECRET, ROTATED_ACCESS_SECRET])
  )
  assert.equal(staleStorage.saved.length, 0)
  assert.equal(staleService.getAuthenticationState().authenticated, false)
})

test('authenticated session guard restores once for concurrent protected requests and fails closed without credentials', async () => {
  const now = 1_800_000_000_000
  const storage = new FakeEncryptedStorage(storedCredential(now))
  const queued = queueFetch([
    apiSuccess(tokenPayload(ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET))
  ])
  const service = confirmedService(storage, queued.fetcher, { now: () => now })

  const [first, second] = await Promise.all([
    service.ensureAuthenticatedSession(),
    service.ensureAuthenticatedSession()
  ])

  assert.deepEqual(first, { authenticated: true, device_id: DEVICE_ID })
  assert.deepEqual(second, first)
  assert.equal(queued.requests.length, 1)
  assert.equal(storage.saved.length, 1)

  const empty = confirmedService(new FakeEncryptedStorage(), queueFetch([]).fetcher, { now: () => now })
  await assert.rejects(
    empty.ensureAuthenticatedSession(),
    (error: unknown) => assertSafeError(error, 'authentication_required')
  )
})

test('authenticated GET parsers return bounded server-shaped DTOs and never expose full API keys', async () => {
  const now = 1_800_000_000_000
  const fullApiKey = 'sk-full-api-key-must-not-leave-main'
  const storage = new FakeEncryptedStorage(storedCredential(now))
  const pricingEnvelope = {
    success: true,
    data: [{
      model_name: 'gpt-test',
      quota_type: 0,
      model_ratio: 1,
      model_price: 0,
      owner_by: 'openai',
      completion_ratio: 2,
      enable_groups: ['default'],
      supported_endpoint_types: ['openai']
    }],
    vendors: [{ id: 1, name: 'OpenAI' }],
    group_ratio: { default: 1 },
    usable_group: { default: 'Default' },
    supported_endpoint: { openai: { path: '/v1/chat/completions', method: 'POST' } },
    auto_groups: ['default'],
    pricing_version: 'a42d372ccf0b5dd13ecf71203521f9d2'
  }
  const queued = queueFetch([
    apiSuccess(tokenPayload(ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET)),
    apiSuccess({
      id: 9,
      username: 'tester',
      display_name: 'Test User',
      email: 'tester@example.test',
      group: 'default',
      quota: 500_000,
      used_quota: 20_000,
      request_count: 4,
      device_id: DEVICE_ID,
      status: 1,
      role: 1
    }),
    apiSuccess(FIXED_DESKTOP_BILLING_CONFIG_V1_RESPONSE),
    apiSuccess({ default: { ratio: 1, desc: 'Default' }, auto: { ratio: 'auto', desc: 'Auto' } }),
    apiSuccess(['gpt-test', 'claude-test']),
    apiSuccess({
      page: 2,
      page_size: 20,
      total: 1,
      items: [{
        id: 7,
        name: 'Desktop',
        key: fullApiKey,
        status: 1,
        remain_quota: 100,
        used_quota: 20,
        created_time: 1_700_000_000,
        accessed_time: 1_700_000_100,
        expired_time: -1,
        unlimited_quota: false,
        model_limits_enabled: true,
        cross_group_retry: false,
        group: 'default',
        model_limits: 'gpt-test',
        allow_ips: '127.0.0.1'
      }]
    }),
    apiSuccess(FIXED_DESKTOP_USAGE_V1_RESPONSE),
    jsonResponse(pricingEnvelope)
  ])
  const service = confirmedService(storage, queued.fetcher, { now: () => now })

  assert.equal((await service.getSelf()).display_name, 'Test User')
  assert.deepEqual(await service.getBillingConfig(), FIXED_DESKTOP_BILLING_CONFIG_V1_RESPONSE)
  assert.equal((await service.getUserGroups()).auto?.ratio, 'auto')
  assert.deepEqual(await service.getUserModels(), ['gpt-test', 'claude-test'])
  const tokens = await service.listApiTokens(2, 20)
  assert.equal(tokens.items[0]?.key, 'sk-********')
  assert.doesNotMatch(JSON.stringify(tokens), new RegExp(fullApiKey))
  const usage = await service.getUsageHistory(1_699_999_000, 1_700_000_000)
  assert.deepEqual(usage, FIXED_DESKTOP_USAGE_V1_RESPONSE)
  assert.doesNotMatch(JSON.stringify(usage), /ip|prompt|completion|request_time|request_body/i)
  const pricing = await service.getPricing()
  assert.equal(pricing.data[0]?.model_name, 'gpt-test')
  assert.equal(pricing.supported_endpoint?.openai?.method, 'POST')

  assert.equal(queued.requests[2]?.url, `${DEFAULT_RELAY_SERVER_ORIGIN}/api/desktop/billing-config`)
  assert.equal(queued.requests[5]?.url, `${DEFAULT_RELAY_SERVER_ORIGIN}/api/token/?p=2&size=20`)
  assert.equal(
    queued.requests[6]?.url,
    `${DEFAULT_RELAY_SERVER_ORIGIN}/api/desktop/usage?start_timestamp=1699999000&end_timestamp=1700000000`
  )
  assert.equal(queued.requests.some((request) => request.url.includes('/api/data/self')), false)
  assert.equal(new Headers(queued.requests[7]?.init.headers).has('authorization'), false)
  for (const request of queued.requests.slice(1, 7)) {
    assert.equal(new Headers(request.init.headers).get('authorization'), `Bearer ${ROTATED_ACCESS_SECRET}`)
  }
})

test('desktop billing config v1 rejects drift, invalid units, and inconsistent currency flags', async () => {
  const now = 1_800_000_000_000
  const valid = FIXED_DESKTOP_BILLING_CONFIG_V1_RESPONSE
  const cases: unknown[] = [
    { ...valid, schema_version: 2 },
    { ...valid, unexpected: 'not-public' },
    { ...valid, quota_per_unit: 0 },
    { ...valid, quota_per_unit: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, quota_display_type: 'EUR' },
    { ...valid, display_in_currency: false },
    { ...valid, usd_exchange_rate: 0 },
    { ...valid, quota_per_unit: Number.MIN_VALUE, usd_exchange_rate: Number.MAX_SAFE_INTEGER },
    { ...valid, quota_per_unit: Number.MAX_SAFE_INTEGER, usd_exchange_rate: Number.MIN_VALUE },
    { ...valid, custom_currency_exchange_rate: Number.POSITIVE_INFINITY },
    { ...valid, custom_currency_symbol: ' symbol ' },
    { ...valid, custom_currency_symbol: 'x'.repeat(65) },
    { ...valid, custom_currency_symbol: '币'.repeat(22) },
    {
      ...valid,
      quota_display_type: 'TOKENS',
      display_in_currency: true
    }
  ]

  for (const payload of cases) {
    const queued = queueFetch([
      apiSuccess(tokenPayload(ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET)),
      apiSuccess(payload)
    ])
    const service = confirmedService(new FakeEncryptedStorage(storedCredential(now)), queued.fetcher, {
      now: () => now
    })
    await assert.rejects(
      service.getBillingConfig(),
      (error: unknown) => assertSafeError(error, 'invalid_response', ['not-public'])
    )
  }
})

test('token pages accept the deployed compact shape and synthesize requested pagination safely', async () => {
  const now = 1_800_000_000_000
  const fullApiKey = 'sk-compact-page-secret'
  const queued = queueFetch([
    apiSuccess(tokenPayload(ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET)),
    apiSuccess({
      total: 1,
      items: [{ id: 19, name: 'Desktop', key: fullApiKey, status: 1, remain_quota: 50 }]
    })
  ])
  const service = confirmedService(new FakeEncryptedStorage(storedCredential(now)), queued.fetcher, { now: () => now })

  const page = await service.listApiTokens(1, 100)
  assert.equal(page.page, 1)
  assert.equal(page.page_size, 100)
  assert.equal(page.items[0]?.key, 'sk-********')
  assert.doesNotMatch(JSON.stringify(page), new RegExp(fullApiKey))
})

test('account model credentials use a short Main-only cache that can be cleared at a turn boundary', async () => {
  let now = 1_800_000_000_000
  const fullApiKey = 'sk-main-memory-model-secret'
  const queued = queueFetch([
    apiSuccess(tokenPayload(ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET)),
    apiSuccess({
      total: 1,
      items: [{ id: 23, name: 'AI Desktop', key: '', status: 1, remain_quota: 50 }]
    }),
    apiSuccess({ key: fullApiKey }),
    apiSuccess({
      total: 1,
      items: [{ id: 23, name: 'AI Desktop', key: '', status: 1, remain_quota: 50 }]
    }),
    apiSuccess({ key: fullApiKey }),
    apiSuccess({
      total: 1,
      items: [{ id: 23, name: 'AI Desktop', key: '', status: 1, remain_quota: 50 }]
    }),
    apiSuccess({ key: fullApiKey })
  ])
  const service = confirmedService(new FakeEncryptedStorage(storedCredential(now)), queued.fetcher, {
    now: () => now,
    modelAccessCredentialTtlMs: 1_000
  })

  const credentials = await service.getModelAccessCredentials()
  assert.deepEqual(credentials, {
    baseUrl: `${DEFAULT_RELAY_SERVER_ORIGIN}/v1`,
    apiKey: fullApiKey,
    tokenId: 23
  })
  assert.equal(await service.getModelAccessCredentials(), credentials)
  assert.equal(queued.requests.length, 3)
  assert.equal(queued.requests[2]?.url, `${DEFAULT_RELAY_SERVER_ORIGIN}/api/token/23/key`)
  assert.equal(queued.requests[2]?.init.method, 'POST')
  assert.equal(JSON.stringify(queued.requests).includes(fullApiKey), false)

  service.clearModelAccessCredentials()
  const afterTurnBoundary = await service.getModelAccessCredentials()
  assert.notEqual(afterTurnBoundary, credentials)
  assert.equal(afterTurnBoundary.apiKey, fullApiKey)
  assert.equal(queued.requests.length, 5)

  now += 1_001
  const afterTtl = await service.getModelAccessCredentials()
  assert.notEqual(afterTtl, afterTurnBoundary)
  assert.equal(afterTtl.apiKey, fullApiKey)
  assert.equal(queued.requests.length, 7)
  service.clearModelAccessCredentials()
})

test('account model credential TTL proactively clears the cached key without another access', async () => {
  const now = 1_800_000_000_000
  const fullApiKey = 'sk-proactive-expiry-secret'
  const tokenPage = () => apiSuccess({
    total: 1,
    items: [{ id: 24, name: 'Short lease', key: '', status: 1, remain_quota: 50 }]
  })
  const queued = queueFetch([
    apiSuccess(tokenPayload(ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET)),
    tokenPage(),
    apiSuccess({ key: fullApiKey }),
    tokenPage(),
    apiSuccess({ key: fullApiKey })
  ])
  const service = confirmedService(new FakeEncryptedStorage(storedCredential(now)), queued.fetcher, {
    now: () => now,
    modelAccessCredentialTtlMs: 20
  })

  const first = await service.getModelAccessCredentials()
  await new Promise((resolve) => setTimeout(resolve, 80))
  const second = await service.getModelAccessCredentials()

  assert.notEqual(second, first)
  assert.equal(second.apiKey, fullApiKey)
  assert.equal(queued.requests.length, 5)
  service.clearModelAccessCredentials()
})

test('account model credentials fail closed when no enabled token is available', async () => {
  const now = 1_800_000_000_000
  const queued = queueFetch([
    apiSuccess(tokenPayload(ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET)),
    apiSuccess({
      total: 2,
      items: [
        { id: 31, name: 'Disabled', key: '', status: 2, remain_quota: 100 },
        { id: 32, name: 'Empty', key: '', status: 1, remain_quota: 0, unlimited_quota: false }
      ]
    })
  ])
  const service = confirmedService(new FakeEncryptedStorage(storedCredential(now)), queued.fetcher, { now: () => now })

  await assert.rejects(
    service.getModelAccessCredentials(),
    (error: unknown) => assertSafeError(error, 'no_available_token')
  )
  assert.equal(queued.requests.some((request) => request.url.endsWith('/key')), false)
})

test('selected model credentials match the effective group and prefer unrestricted then newest tokens', async () => {
  const now = 1_800_000_000_000
  const fullApiKey = 'sk-selected-default-secret'
  const queued = queueFetch([
    apiSuccess(tokenPayload(ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET)),
    apiSuccess({ id: 9, group: 'default' }),
    apiSuccess({
      total: 4,
      items: [
        {
          id: 41,
          name: 'Account fallback',
          key: '',
          status: 1,
          remain_quota: 50,
          created_time: 100
        },
        {
          id: 42,
          name: 'Newest unrestricted',
          key: '',
          status: 1,
          remain_quota: 50,
          created_time: 200,
          group: 'default'
        },
        {
          id: 43,
          name: 'Newer restricted',
          key: '',
          status: 1,
          remain_quota: 50,
          created_time: 300,
          group: 'default',
          model_limits_enabled: true,
          model_limits: 'gpt-test'
        },
        {
          id: 44,
          name: 'Wrong group',
          key: '',
          status: 1,
          remain_quota: 50,
          created_time: 400,
          group: 'premium'
        }
      ]
    }),
    apiSuccess({ key: fullApiKey })
  ])
  const service = confirmedService(new FakeEncryptedStorage(storedCredential(now)), queued.fetcher, {
    now: () => now
  })

  const credentials = await service.getSelectedModelAccessCredentials({
    groupId: 'default',
    modelId: 'gpt-test'
  })

  assert.equal(credentials.tokenId, 42)
  assert.equal(credentials.apiKey, fullApiKey)
  assert.equal(queued.requests[3]?.url, `${DEFAULT_RELAY_SERVER_ORIGIN}/api/token/42/key`)
})

test('selected auto group requires an actual auto effective group', async () => {
  const now = 1_800_000_000_000
  const queued = queueFetch([
    apiSuccess(tokenPayload(ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET)),
    apiSuccess({ id: 9, group: 'default' }),
    apiSuccess({
      total: 2,
      items: [
        {
          id: 51,
          name: 'Default retry token',
          key: '',
          status: 1,
          remain_quota: 50,
          cross_group_retry: true
        },
        {
          id: 52,
          name: 'Actual auto token',
          key: '',
          status: 1,
          remain_quota: 50,
          group: 'auto'
        }
      ]
    }),
    apiSuccess({ key: 'sk-auto-selection-secret' })
  ])
  const service = confirmedService(new FakeEncryptedStorage(storedCredential(now)), queued.fetcher, {
    now: () => now
  })

  const credentials = await service.getSelectedModelAccessCredentials({ groupId: 'auto' })

  assert.equal(credentials.tokenId, 52)
  assert.equal(queued.requests[3]?.url, `${DEFAULT_RELAY_SERVER_ORIGIN}/api/token/52/key`)
})

test('selected model credentials enforce comma-separated model limits before requesting a key', async () => {
  const now = 1_800_000_000_000
  const matching = queueFetch([
    apiSuccess(tokenPayload(ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET)),
    apiSuccess({ id: 9, group: 'default' }),
    apiSuccess({
      total: 2,
      items: [
        {
          id: 61,
          name: 'Substring only',
          key: '',
          status: 1,
          remain_quota: 50,
          model_limits_enabled: true,
          model_limits: 'gpt-test-pro'
        },
        {
          id: 62,
          name: 'Exact comma match',
          key: '',
          status: 1,
          remain_quota: 50,
          model_limits_enabled: true,
          model_limits: 'claude-test, gpt-test ,image-test'
        }
      ]
    }),
    apiSuccess({ key: 'sk-limited-selection-secret' })
  ])
  const service = confirmedService(new FakeEncryptedStorage(storedCredential(now)), matching.fetcher, {
    now: () => now
  })

  const credentials = await service.getSelectedModelAccessCredentials({
    groupId: 'default',
    modelId: 'gpt-test'
  })

  assert.equal(credentials.tokenId, 62)
  assert.equal(matching.requests[3]?.url, `${DEFAULT_RELAY_SERVER_ORIGIN}/api/token/62/key`)
})

test('selected credentials can pin an exact token and clear only entries backed by that token', async () => {
  const now = 1_800_000_000_000
  const tokenPage = () => apiSuccess({
    total: 2,
    items: [
      {
        id: 71,
        name: 'Pinned older token',
        key: '',
        status: 1,
        remain_quota: 50,
        created_time: 100
      },
      {
        id: 72,
        name: 'Newer token',
        key: '',
        status: 1,
        remain_quota: 50,
        created_time: 200
      }
    ]
  })
  const queued = queueFetch([
    apiSuccess(tokenPayload(ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET)),
    apiSuccess({ id: 9, group: 'default' }),
    tokenPage(),
    apiSuccess({ key: 'sk-pinned-selection-secret' }),
    apiSuccess({ id: 9, group: 'default' }),
    tokenPage(),
    apiSuccess({ key: 'sk-pinned-selection-secret' })
  ])
  const service = confirmedService(new FakeEncryptedStorage(storedCredential(now)), queued.fetcher, {
    now: () => now
  })
  const selection = { groupId: 'default', modelId: 'gpt-test', tokenId: 71 } as const

  const first = await service.getSelectedModelAccessCredentials(selection)
  service.clearModelAccessCredentials(72)
  assert.equal(await service.getSelectedModelAccessCredentials(selection), first)

  service.clearModelAccessCredentials(71)
  const second = await service.getSelectedModelAccessCredentials(selection)

  assert.equal(first.tokenId, 71)
  assert.equal(second.tokenId, 71)
  assert.notEqual(second, first)
  assert.equal(queued.requests.filter((request) => request.url.endsWith('/api/token/71/key')).length, 2)
})

test('selected credential lookup paginates within a strict token metadata cap', async () => {
  const now = 1_800_000_000_000
  const firstPageItems = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    name: `Other ${index + 1}`,
    key: '',
    status: 1,
    remain_quota: 50,
    group: 'other'
  }))
  const queued = queueFetch([
    apiSuccess(tokenPayload(ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET)),
    apiSuccess({ id: 9, group: 'default' }),
    apiSuccess({ page: 1, page_size: 100, total: 101, items: firstPageItems }),
    apiSuccess({
      page: 2,
      page_size: 100,
      total: 101,
      items: [{ id: 101, name: 'Page two match', key: '', status: 1, remain_quota: 50 }]
    }),
    apiSuccess({ key: 'sk-page-two-selection-secret' })
  ])
  const service = confirmedService(new FakeEncryptedStorage(storedCredential(now)), queued.fetcher, {
    now: () => now
  })

  const credentials = await service.getSelectedModelAccessCredentials({ groupId: 'default' })

  assert.equal(credentials.tokenId, 101)
  assert.equal(queued.requests[3]?.url, `${DEFAULT_RELAY_SERVER_ORIGIN}/api/token/?p=2&size=100`)
  assert.equal(queued.requests[4]?.url, `${DEFAULT_RELAY_SERVER_ORIGIN}/api/token/101/key`)

  const oversized = queueFetch([
    apiSuccess(tokenPayload(ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET)),
    apiSuccess({ id: 9, group: 'default' }),
    apiSuccess({ total: 1_001, items: [] })
  ])
  const cappedService = confirmedService(new FakeEncryptedStorage(storedCredential(now)), oversized.fetcher, {
    now: () => now
  })
  await assert.rejects(
    cappedService.getSelectedModelAccessCredentials({ groupId: 'default' }),
    (error: unknown) => assertSafeError(error, 'invalid_response')
  )
  assert.equal(oversized.requests.length, 3)
  assert.equal(oversized.requests.some((request) => request.url.endsWith('/key')), false)
})

test('selected credential mismatch fails without requesting any token key', async () => {
  const now = 1_800_000_000_000
  const queued = queueFetch([
    apiSuccess(tokenPayload(ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET)),
    apiSuccess({ id: 9, group: 'default' }),
    apiSuccess({
      total: 5,
      items: [
        { id: 81, name: 'Wrong group', key: '', status: 1, remain_quota: 50, group: 'premium' },
        { id: 82, name: 'Disabled', key: '', status: 2, remain_quota: 50 },
        {
          id: 83,
          name: 'Wrong model',
          key: '',
          status: 1,
          remain_quota: 50,
          model_limits_enabled: true,
          model_limits: 'claude-test'
        },
        { id: 84, name: 'No quota', key: '', status: 1, remain_quota: 0, unlimited_quota: false },
        { id: 85, name: 'Expired', key: '', status: 1, remain_quota: 50, expired_time: 1_800_000_000 }
      ]
    })
  ])
  const service = confirmedService(new FakeEncryptedStorage(storedCredential(now)), queued.fetcher, {
    now: () => now
  })

  await assert.rejects(
    service.getSelectedModelAccessCredentials({ groupId: 'default', modelId: 'gpt-test' }),
    (error: unknown) => assertSafeError(error, 'no_compatible_token')
  )
  assert.equal(queued.requests.length, 3)
  assert.equal(queued.requests.some((request) => request.url.endsWith('/key')), false)
})

test('usage accepts the server zero-value model name but rejects invalid aggregates and ranges', async () => {
  const now = 1_800_000_000_000
  const serverRecord = {
    model_name: '',
    created_at: 1_700_000_000,
    token_used: 0,
    count: 0,
    quota: 0
  }
  const serverUsage = {
    schema_version: 1,
    range: { start_timestamp: 1_699_999_000, end_timestamp: 1_700_000_000 },
    totals: { count: 0, quota: 0, token_used: 0 },
    records: [serverRecord]
  }
  const queued = queueFetch([
    apiSuccess(tokenPayload(ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET)),
    apiSuccess(serverUsage)
  ])
  const service = confirmedService(new FakeEncryptedStorage(storedCredential(now)), queued.fetcher, {
    now: () => now
  })
  assert.deepEqual(await service.getUsageHistory(1_699_999_000, 1_700_000_000), serverUsage)

  for (const field of ['created_at', 'count', 'quota', 'token_used'] as const) {
    const invalid = queueFetch([
      apiSuccess(tokenPayload(ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET)),
      apiSuccess({ ...serverUsage, records: [{ ...serverRecord, [field]: -1 }] })
    ])
    const invalidService = confirmedService(
      new FakeEncryptedStorage(storedCredential(now)),
      invalid.fetcher,
      { now: () => now }
    )
    await assert.rejects(
      invalidService.getUsageHistory(1_699_999_000, 1_700_000_000),
      (error: unknown) => assertSafeError(error, 'invalid_response')
    )
  }

  const noRequest = queueFetch([])
  const rangeService = confirmedService(new FakeEncryptedStorage(), noRequest.fetcher)
  await assert.rejects(
    rangeService.getUsageHistory(1_700_000_000, 1_702_592_001),
    (error: unknown) => assertSafeError(error, 'invalid_input')
  )
  assert.equal(noRequest.requests.length, 0)
})

test('desktop usage v1 rejects unknown versions, surplus log fields, and inconsistent summaries', async () => {
  const now = 1_800_000_000_000
  const privateMarker = 'private-usage-log-marker'
  const valid = structuredClone(FIXED_DESKTOP_USAGE_V1_RESPONSE) as Record<string, unknown>
  const cases: unknown[] = [
    { ...valid, schema_version: 2 },
    { ...valid, unexpected: privateMarker },
    { ...valid, range: { ...(valid.range as Record<string, unknown>), ip: privateMarker } },
    { ...valid, range: { start_timestamp: 1_699_999_001, end_timestamp: 1_700_000_000 } },
    { ...valid, totals: { ...(valid.totals as Record<string, unknown>), request_body: privateMarker } },
    { ...valid, totals: { count: 3, quota: 500_000, token_used: 1_200 } },
    {
      ...valid,
      records: [{
        ...(valid.records as Array<Record<string, unknown>>)[0],
        ip: privateMarker,
        prompt: privateMarker
      }]
    },
    {
      ...valid,
      records: [{
        ...(valid.records as Array<Record<string, unknown>>)[0],
        created_at: 1_699_998_999
      }]
    }
  ]

  for (const payload of cases) {
    const queued = queueFetch([
      apiSuccess(tokenPayload(ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET)),
      apiSuccess(payload)
    ])
    const service = confirmedService(new FakeEncryptedStorage(storedCredential(now)), queued.fetcher, {
      now: () => now
    })
    await assert.rejects(
      service.getUsageHistory(1_699_999_000, 1_700_000_000),
      (error: unknown) => assertSafeError(error, 'invalid_response', [privateMarker])
    )
    assert.equal(queued.requests[1]?.url.includes('/api/desktop/usage?'), true)
  }
})

test('account and token counters reject negative values except the token expiry sentinel', async () => {
  const now = 1_800_000_000_000
  for (const field of ['quota', 'used_quota', 'request_count', 'status', 'role'] as const) {
    const storage = new FakeEncryptedStorage(storedCredential(now))
    const queued = queueFetch([
      apiSuccess(tokenPayload(ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET)),
      apiSuccess({ id: 9, [field]: -1 })
    ])
    const service = confirmedService(storage, queued.fetcher, { now: () => now })
    await assert.rejects(
      service.getSelf(),
      (error: unknown) => assertSafeError(error, 'invalid_response')
    )
  }

  for (const [field, invalid] of [
    ['remain_quota', -1],
    ['used_quota', -1],
    ['created_time', -1],
    ['accessed_time', -1],
    ['expired_time', -2]
  ] as const) {
    const storage = new FakeEncryptedStorage(storedCredential(now))
    const queued = queueFetch([
      apiSuccess(tokenPayload(ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET)),
      apiSuccess({
        page: 1,
        page_size: 100,
        total: 1,
        items: [{ id: 7, name: 'Desktop', key: '', [field]: invalid }]
      })
    ])
    const service = confirmedService(storage, queued.fetcher, { now: () => now })
    await assert.rejects(
      service.listApiTokens(),
      (error: unknown) => assertSafeError(error, 'invalid_response')
    )
  }

  const sentinelStorage = new FakeEncryptedStorage(storedCredential(now))
  const sentinelQueue = queueFetch([
    apiSuccess(tokenPayload(ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET)),
    apiSuccess({
      page: 1,
      page_size: 100,
      total: 1,
      items: [{ id: 7, name: 'Desktop', key: '', expired_time: -1 }]
    })
  ])
  const sentinelService = confirmedService(sentinelStorage, sentinelQueue.fetcher, { now: () => now })
  assert.equal((await sentinelService.listApiTokens()).items[0]?.expired_time, -1)
})

test('redeem, token status, token revoke, and device revoke use only verified contracts', async () => {
  const now = 1_800_000_000_000
  const storage = new FakeEncryptedStorage(storedCredential(now))
  const queued = queueFetch([
    apiSuccess(tokenPayload(ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET)),
    apiSuccess(500_000),
    apiSuccess({ id: 7, name: 'Desktop', status: 2, key: '' }),
    apiSuccess(null),
    apiSuccess(null)
  ])
  const service = confirmedService(storage, queued.fetcher, { now: () => now })

  assert.deepEqual(await service.redeem('REDEEM-CODE-1234'), { quota: 500_000 })
  assert.deepEqual(await service.updateApiTokenStatus(7, 2), { id: 7, status: 2 })
  assert.deepEqual(await service.revokeApiToken(7), { id: 7 })
  await service.revokeDevice()

  assert.equal(queued.requests[1]?.url, `${DEFAULT_RELAY_SERVER_ORIGIN}/api/user/topup`)
  assert.deepEqual(queued.requests[1]?.body, { key: 'REDEEM-CODE-1234' })
  assert.equal(queued.requests[2]?.url, `${DEFAULT_RELAY_SERVER_ORIGIN}/api/token/?status_only=true`)
  assert.deepEqual(queued.requests[2]?.body, { id: 7, status: 2 })
  assert.equal(queued.requests[3]?.url, `${DEFAULT_RELAY_SERVER_ORIGIN}/api/token/7`)
  assert.equal(queued.requests[3]?.init.method, 'DELETE')
  assert.equal(queued.requests[4]?.url, `${DEFAULT_RELAY_SERVER_ORIGIN}/api/desktop/devices/${DEVICE_ID}`)
  assert.equal(storage.clearCalls, 1)
  assert.deepEqual(service.getAuthenticationState(), { authenticated: false, device_id: null })
})

test('redirects, oversized bodies, and upstream details fail with fixed token-free errors', async () => {
  const rawMarker = 'raw-upstream-secret-and-private-path'
  let redirectBodyCancelled = false
  const redirectBody = new ReadableStream<Uint8Array>({
    pull() {
      throw new Error(rawMarker)
    },
    cancel() {
      redirectBodyCancelled = true
    }
  }, { highWaterMark: 0 })
  const redirect = new Response(redirectBody, {
    status: 302,
    headers: {
      location: `https://untrusted.example/${rawMarker}`,
      'content-type': 'application/json'
    }
  })
  const redirectService = confirmedService(new FakeEncryptedStorage(), queueFetch([redirect]).fetcher)
  await assert.rejects(
    redirectService.getPricing(),
    (error: unknown) => assertSafeError(error, 'redirect_rejected', [rawMarker, 'untrusted.example'])
  )
  assert.equal(redirectBodyCancelled, true)

  let oversizedCancelled = false
  const oversizedBody = new ReadableStream<Uint8Array>({
    cancel() {
      oversizedCancelled = true
    }
  }, { highWaterMark: 0 })
  const oversized = new Response(oversizedBody, {
    headers: {
      'content-type': 'application/json',
      'content-length': String(2 * 1024 * 1024 + 1)
    }
  })
  const oversizedService = confirmedService(new FakeEncryptedStorage(), queueFetch([oversized]).fetcher)
  await assert.rejects(
    oversizedService.getPricing(),
    (error: unknown) => assertSafeError(error, 'response_too_large')
  )
  assert.equal(oversizedCancelled, true)

  const rejected = apiFailure('private_server_error', `${rawMarker} ${ACCESS_SECRET}`, 500)
  const rejectedService = confirmedService(new FakeEncryptedStorage(), queueFetch([rejected]).fetcher)
  await assert.rejects(
    rejectedService.getPricing(),
    (error: unknown) => assertSafeError(error, 'remote_unavailable', [rawMarker, ACCESS_SECRET])
  )

  const notFoundService = confirmedService(
    new FakeEncryptedStorage(),
    queueFetch([apiFailure('missing_route', rawMarker, 404)]).fetcher
  )
  await assert.rejects(
    notFoundService.getPricing(),
    (error: unknown) => assertSafeError(error, 'remote_rejected', [rawMarker])
  )

  const networkService = confirmedService(new FakeEncryptedStorage(), (async () => {
    throw new Error(`${rawMarker} ${REFRESH_SECRET}`)
  }) as typeof fetch)
  await assert.rejects(
    networkService.getPricing(),
    (error: unknown) => assertSafeError(error, 'network_error', [rawMarker, REFRESH_SECRET])
  )
})

test('caller cancellation and timeout are distinct and never retain raw fetch errors', async () => {
  const pendingFetcher = (rawMarker: string): typeof fetch => (async (_input, init) => {
    await new Promise<never>((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(new Error(rawMarker))
        return
      }
      init?.signal?.addEventListener('abort', () => reject(new Error(rawMarker)), { once: true })
    })
  }) as typeof fetch

  const caller = new AbortController()
  const cancelled = confirmedService(
    new FakeEncryptedStorage(),
    pendingFetcher('cancel-raw-private-marker')
  )
  const cancelledPromise = cancelled.getPricing({ signal: caller.signal })
  queueMicrotask(() => caller.abort())
  await assert.rejects(
    cancelledPromise,
    (error: unknown) => assertSafeError(error, 'cancelled', ['cancel-raw-private-marker'])
  )

  const timedOut = confirmedService(
    new FakeEncryptedStorage(),
    pendingFetcher('timeout-raw-private-marker'),
    { timeoutMs: 100 }
  )
  await assert.rejects(
    timedOut.getPricing(),
    (error: unknown) => assertSafeError(error, 'timeout', ['timeout-raw-private-marker'])
  )

  const bodyTimeout = confirmedService(
    new FakeEncryptedStorage(),
    (async (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(new Error('body-timeout-raw-private-marker'))
          }, { once: true })
        }
      })
      return new Response(body, { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch,
    { timeoutMs: 100 }
  )
  await assert.rejects(
    bodyTimeout.getPricing(),
    (error: unknown) => assertSafeError(error, 'timeout', ['body-timeout-raw-private-marker'])
  )
})

test('shutdown cancels in-flight relay requests, waits for settlement, and rejects new work', async () => {
  let fetchCalls = 0
  let observedSignal: AbortSignal | null = null
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const fetcher = (async (_input: URL | RequestInfo, init: RequestInit = {}) => {
    fetchCalls += 1
    observedSignal = init.signal as AbortSignal
    markStarted()
    return await new Promise<Response>((_resolve, reject) => {
      const cancel = (): void => reject(new Error('private shutdown network marker'))
      if (observedSignal?.aborted) cancel()
      else observedSignal?.addEventListener('abort', cancel, { once: true })
    })
  }) as typeof fetch
  const service = confirmedService(new FakeEncryptedStorage(), fetcher)
  const request = assert.rejects(
    service.getPricing(),
    (error: unknown) => assertSafeError(error, 'cancelled', ['private shutdown network marker'])
  )
  await started
  const shutdown = service.shutdown()
  assert.equal(observedSignal?.aborted, true)
  await request
  await shutdown
  await assert.rejects(
    service.getPricing(),
    (error: unknown) => assertSafeError(error, 'cancelled')
  )
  assert.equal(fetchCalls, 1)
})

test('malformed encrypted storage and save failures fail closed without enabling access', async () => {
  const now = 1_800_000_000_000
  const malformed = new FakeEncryptedStorage({
    ...storedCredential(now),
    access_token: ACCESS_SECRET
  })
  const malformedService = confirmedService(malformed, queueFetch([]).fetcher, { now: () => now })
  await assert.rejects(
    malformedService.restoreSession(),
    (error: unknown) => assertSafeError(error, 'storage_error', [ACCESS_SECRET])
  )

  const storage = new FakeEncryptedStorage(storedCredential(now))
  storage.saveError = new Error(`disk error with ${ROTATED_REFRESH_SECRET}`)
  const queued = queueFetch([
    apiSuccess(tokenPayload(ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET))
  ])
  const service = confirmedService(storage, queued.fetcher, { now: () => now })
  await assert.rejects(
    service.restoreSession(),
    (error: unknown) => assertSafeError(error, 'storage_error', [ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET])
  )
  assert.equal(storage.saved.length, 0)
  assert.equal(service.getAuthenticationState().authenticated, false)
})

test('a completed local clear cannot be undone by an in-flight refresh save', async () => {
  const now = 1_800_000_000_000
  let persisted: unknown = storedCredential(now)
  let notifySaveStarted: (() => void) | undefined
  const saveStarted = new Promise<void>((resolve) => { notifySaveStarted = resolve })
  let releaseSave: (() => void) | undefined
  const saveRelease = new Promise<void>((resolve) => { releaseSave = resolve })
  const storage: RelayEncryptedCredentialStorage = {
    async loadCredential() {
      return structuredClone(persisted)
    },
    async saveCredential(value) {
      notifySaveStarted?.()
      await saveRelease
      persisted = structuredClone(value)
    },
    async clearCredential() {
      persisted = null
    }
  }
  const queued = queueFetch([
    apiSuccess(tokenPayload(ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET))
  ])
  const service = confirmedService(storage, queued.fetcher, { now: () => now })

  const restoring = service.restoreSession()
  await saveStarted
  const clearing = service.clearLocalSession()
  releaseSave?.()

  await assert.rejects(
    restoring,
    (error: unknown) => assertSafeError(error, 'cancelled', [ROTATED_ACCESS_SECRET, ROTATED_REFRESH_SECRET])
  )
  await clearing
  assert.equal(persisted, null)
  assert.deepEqual(service.getAuthenticationState(), { authenticated: false, device_id: null })
})
