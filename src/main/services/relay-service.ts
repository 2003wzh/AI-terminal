import { randomUUID } from 'node:crypto'

import { WZH_SERVER_ORIGIN } from '../../shared/server-config.ts'

export const DEFAULT_RELAY_SERVER_ORIGIN = WZH_SERVER_ORIGIN

export type RelayServiceErrorCode =
  | 'invalid_configuration'
  | 'invalid_endpoint'
  | 'endpoint_not_confirmed'
  | 'invalid_input'
  | 'cancelled'
  | 'timeout'
  | 'network_error'
  | 'redirect_rejected'
  | 'remote_unavailable'
  | 'remote_rejected'
  | 'response_too_large'
  | 'invalid_response'
  | 'authentication_required'
  | 'no_available_token'
  | 'no_compatible_token'
  | 'authorization_pending'
  | 'authorization_slow_down'
  | 'authorization_expired'
  | 'authorization_denied'
  | 'storage_error'
  | 'too_many_sessions'

const ERROR_DETAILS: Readonly<Record<RelayServiceErrorCode, {
  message: string
  retryable: boolean
}>> = Object.freeze({
  invalid_configuration: { message: 'The relay client configuration is invalid.', retryable: false },
  invalid_endpoint: { message: 'The relay endpoint is invalid.', retryable: false },
  endpoint_not_confirmed: { message: 'The exact relay endpoint has not been confirmed for this session.', retryable: false },
  invalid_input: { message: 'The relay request is invalid.', retryable: false },
  cancelled: { message: 'The relay request was cancelled.', retryable: false },
  timeout: { message: 'The relay request timed out.', retryable: true },
  network_error: { message: 'The confirmed relay endpoint could not be reached.', retryable: true },
  redirect_rejected: { message: 'The relay endpoint attempted a redirect.', retryable: false },
  remote_unavailable: { message: 'The relay endpoint is temporarily unavailable.', retryable: true },
  remote_rejected: { message: 'The relay endpoint rejected the request.', retryable: false },
  response_too_large: { message: 'The relay response exceeded the safety limit.', retryable: false },
  invalid_response: { message: 'The relay endpoint returned an invalid response.', retryable: false },
  authentication_required: { message: 'Relay authentication is required.', retryable: false },
  no_available_token: { message: 'No active relay API token is available.', retryable: false },
  no_compatible_token: { message: 'No active relay API token matches the selected group and model.', retryable: false },
  authorization_pending: { message: 'Device authorization is still pending.', retryable: true },
  authorization_slow_down: { message: 'Device authorization polling must slow down.', retryable: true },
  authorization_expired: { message: 'Device authorization expired.', retryable: false },
  authorization_denied: { message: 'Device authorization was denied.', retryable: false },
  storage_error: { message: 'The encrypted relay credential store is unavailable.', retryable: false },
  too_many_sessions: { message: 'Too many device authorization sessions are active.', retryable: false }
})

export class RelayServiceError extends Error {
  readonly code: RelayServiceErrorCode
  readonly retryable: boolean

  constructor(code: RelayServiceErrorCode, retryable?: boolean) {
    const detail = ERROR_DETAILS[code]
    super(detail.message)
    this.name = 'RelayServiceError'
    this.code = code
    this.retryable = retryable ?? detail.retryable
    this.stack = `${this.name}: ${this.message}`
  }
}

/**
 * Implementations must encrypt values for the current OS user and replace them
 * atomically. The service deliberately gives this boundary only the rotating
 * refresh credential and non-secret device metadata; access tokens never cross it.
 */
export interface RelayEncryptedCredentialStorage {
  loadCredential(): Promise<unknown>
  saveCredential(credential: RelayStoredCredential): Promise<void>
  clearCredential(): Promise<void>
}

export interface RelayStoredCredential {
  version: 1
  server_origin: string
  refresh_token: string
  device_id: string
  refresh_expires_at: number
  updated_at: number
}

export interface RelayRequestOptions {
  signal?: AbortSignal
}

export interface RelayDeviceAuthorizationInput {
  device_name: string
  platform: string
  client_version: string
}

export interface RelayDeviceAuthorizationDto {
  session_id: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
  expires_at: number
}

export type RelayDeviceAuthorizationPollDto =
  | { status: 'pending'; retry_after: number }
  | { status: 'slow_down'; retry_after: number }
  | { status: 'authenticated'; device_id: string }
  | { status: 'expired' }
  | { status: 'denied' }

export interface RelayAuthenticationStateDto {
  authenticated: boolean
  device_id: string | null
}

export interface RelayAccountDto {
  id: number
  username?: string
  display_name?: string
  email?: string
  group?: string
  quota?: number
  used_quota?: number
  request_count?: number
  device_id?: string
  status?: number
  role?: number
}

export type RelayQuotaDisplayType = 'USD' | 'CNY' | 'TOKENS' | 'CUSTOM'

export interface RelayDesktopBillingConfigV1Dto {
  schema_version: 1
  quota_per_unit: number
  display_in_currency: boolean
  quota_display_type: RelayQuotaDisplayType
  usd_exchange_rate: number
  custom_currency_symbol: string
  custom_currency_exchange_rate: number
}

export interface RelayGroupInfoDto {
  ratio?: number | string
  desc?: string
}

export type RelayGroupsDto = Readonly<Record<string, Readonly<RelayGroupInfoDto>>>

export interface RelayApiTokenDto {
  id: number
  user_id?: number
  name: string
  key: string
  status?: 1 | 2 | 3 | 4
  remain_quota?: number
  used_quota?: number
  created_time?: number
  accessed_time?: number
  expired_time?: number
  unlimited_quota?: boolean
  model_limits_enabled?: boolean
  cross_group_retry?: boolean
  group?: string
  model_limits?: string
  allow_ips?: string
}

export interface RelayApiTokenPageDto {
  page: number
  page_size: number
  total: number
  items: readonly Readonly<RelayApiTokenDto>[]
}

/** Main-process only. The API key must never cross IPC or enter persisted history. */
export interface RelayModelAccessCredentials {
  baseUrl: string
  apiKey: string
  tokenId: number
}

/** Main-process only. Selection values must be revalidated before a token key is requested. */
export interface RelayModelAccessSelection {
  groupId: string
  modelId?: string
  tokenId?: number
}

export interface RelayUsageRecordDto {
  created_at: number
  count: number
  quota: number
  token_used: number
  model_name: string
}

export interface RelayDesktopUsageV1Dto {
  schema_version: 1
  range: {
    start_timestamp: number
    end_timestamp: number
  }
  totals: {
    count: number
    quota: number
    token_used: number
  }
  records: readonly Readonly<RelayUsageRecordDto>[]
}

export interface RelayPricingModelDto {
  model_name: string
  description?: string
  icon?: string
  tags?: string
  vendor_id?: number
  quota_type: number
  model_ratio: number
  model_price: number
  owner_by: string
  completion_ratio: number
  cache_ratio?: number
  create_cache_ratio?: number
  image_ratio?: number
  audio_ratio?: number
  audio_completion_ratio?: number
  enable_groups: readonly string[]
  supported_endpoint_types: readonly string[]
  billing_mode?: string
  billing_expr?: string
  pricing_version?: string
}

export interface RelayPricingVendorDto {
  id: number
  name: string
  description?: string
  icon?: string
}

export interface RelaySupportedEndpointDto {
  path: string
  method: string
}

export interface RelayPricingDto {
  data: readonly Readonly<RelayPricingModelDto>[]
  vendors?: readonly Readonly<RelayPricingVendorDto>[]
  group_ratio?: Readonly<Record<string, number>>
  usable_group?: Readonly<Record<string, string>>
  supported_endpoint?: Readonly<Record<string, Readonly<RelaySupportedEndpointDto>>>
  auto_groups?: readonly string[]
  pricing_version?: string
}

export interface RelayRedeemResultDto {
  quota: number
}

export interface RelayTokenMutationResultDto {
  id: number
  status?: 1 | 2
}

export interface RelayServiceOptions {
  credentialStorage: RelayEncryptedCredentialStorage
  serverOrigin?: string
  fetcher?: typeof fetch
  timeoutMs?: number
  maxResponseBytes?: number
  modelAccessCredentialTtlMs?: number
  now?: () => number
  createSessionId?: () => string
}

interface AccessCredential {
  value: string
  expiresAt: number
}

interface NormalizedModelAccessSelection {
  groupId: string
  modelId?: string
  tokenId?: number
}

interface ModelAccessCredentialCacheEntry {
  credentials: Readonly<RelayModelAccessCredentials>
  expiresAt: number
}

interface DeviceSession {
  deviceCode: string
  deviceIdHint: string | null
  verificationUriComplete: string
  expiresAt: number
  intervalSeconds: number
  nextPollAt: number
}

interface ActiveRelayRequest {
  controller: AbortController
  settled: Promise<void>
  settle(): void
}

interface TokenResponse {
  accessToken: string
  refreshToken: string
  deviceId: string
  expiresIn: number
  refreshExpiresIn: number
}

interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  body?: Readonly<Record<string, unknown>>
  authorization?: string
  maxResponseBytes?: number
  allowEmpty?: boolean
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_USAGE_RESPONSE_BYTES = 512 * 1024
const MAX_PRICING_RESPONSE_BYTES = 2 * 1024 * 1024
const DEFAULT_MODEL_ACCESS_CREDENTIAL_TTL_MS = 15_000
const MAX_MODEL_ACCESS_CREDENTIAL_TTL_MS = 60_000
const MODEL_ACCESS_TOKEN_PAGE_SIZE = 100
const MAX_MODEL_ACCESS_TOKEN_PAGES = 10
const LEGACY_MODEL_ACCESS_CACHE_KEY = 'legacy'
const MAX_REQUEST_BODY_BYTES = 64 * 1024
const MAX_ACTIVE_DEVICE_SESSIONS = 4
const MAX_ACCESS_TOKEN_SECONDS = 60 * 60
const MAX_REFRESH_TOKEN_SECONDS = 366 * 24 * 60 * 60
const MAX_TOKEN_LENGTH = 16 * 1024
const MAX_MODELS = 1024
const MAX_GROUPS = 256
const MAX_PRICING_MODELS = 4096
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const USER_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u
const GROUP_NAME_PATTERN = /^[^\u0000-\u001f\u007f]{1,64}$/u
const MODEL_NAME_PATTERN = /^[^\u0000-\u001f\u007f]{1,256}$/u
const PRICING_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u
const REDEMPTION_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u

export class RelayService {
  readonly #origin: string
  readonly #storage: RelayEncryptedCredentialStorage
  readonly #fetcher: typeof fetch
  readonly #timeoutMs: number
  readonly #maxResponseBytes: number
  readonly #modelAccessCredentialTtlMs: number
  readonly #now: () => number
  readonly #createSessionId: () => string
  readonly #deviceSessions = new Map<string, DeviceSession>()
  readonly #activeRequests = new Set<ActiveRelayRequest>()

  #endpointConfirmed = false
  #disposed = false
  #credentialLoaded = false
  #credential: RelayStoredCredential | null = null
  #accessCredential: AccessCredential | null = null
  readonly #modelAccessCredentialCache = new Map<string, ModelAccessCredentialCacheEntry>()
  readonly #modelAccessCredentialPromises = new Map<string, Promise<Readonly<RelayModelAccessCredentials>>>()
  readonly #modelAccessCredentialPromiseSelections = new Map<string, Readonly<NormalizedModelAccessSelection> | null>()
  readonly #modelAccessCredentialTimers = new Map<string, ReturnType<typeof setTimeout>>()
  readonly #modelAccessCredentialTokenEpochs = new Map<number, number>()
  #modelAccessCredentialEpoch = 0
  #refreshPromise: Promise<void> | null = null
  #credentialEpoch = 0
  #storageMutation = Promise.resolve()

  constructor(options: RelayServiceOptions) {
    if (!isPlainRecordLike(options) || !isCredentialStorage(options.credentialStorage)) {
      throw new RelayServiceError('invalid_configuration')
    }
    this.#origin = normalizeRelayServerOrigin(options.serverOrigin ?? DEFAULT_RELAY_SERVER_ORIGIN)
    this.#storage = options.credentialStorage
    this.#fetcher = options.fetcher ?? fetch
    if (typeof this.#fetcher !== 'function') throw new RelayServiceError('invalid_configuration')
    this.#timeoutMs = configurationInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 100, 120_000)
    this.#maxResponseBytes = configurationInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      1024,
      MAX_RESPONSE_BYTES
    )
    this.#modelAccessCredentialTtlMs = configurationInteger(
      options.modelAccessCredentialTtlMs,
      DEFAULT_MODEL_ACCESS_CREDENTIAL_TTL_MS,
      10,
      MAX_MODEL_ACCESS_CREDENTIAL_TTL_MS
    )
    this.#now = options.now ?? Date.now
    this.#createSessionId = options.createSessionId ?? randomUUID
    if (typeof this.#now !== 'function' || typeof this.#createSessionId !== 'function') {
      throw new RelayServiceError('invalid_configuration')
    }
  }

  get serverOrigin(): string {
    return this.#origin
  }

  confirmEndpoint(serverOrigin: string): void {
    let normalized: string
    try {
      normalized = normalizeRelayServerOrigin(serverOrigin)
    } catch {
      throw new RelayServiceError('invalid_endpoint')
    }
    if (normalized !== this.#origin) throw new RelayServiceError('invalid_endpoint')
    this.#endpointConfirmed = true
  }

  revokeEndpointConfirmation(): void {
    this.#endpointConfirmed = false
    this.#accessCredential = null
    this.clearModelAccessCredentials()
    this.#deviceSessions.clear()
  }

  async shutdown(): Promise<void> {
    if (!this.#disposed) {
      this.#disposed = true
      this.#endpointConfirmed = false
      this.#accessCredential = null
      this.clearModelAccessCredentials()
      this.#deviceSessions.clear()
      for (const request of this.#activeRequests) request.controller.abort()
    }
    await Promise.all([...this.#activeRequests].map((request) => request.settled))
    await Promise.allSettled([
      this.#refreshPromise ?? Promise.resolve(),
      this.#storageMutation
    ])
  }

  async startDeviceAuthorization(
    input: RelayDeviceAuthorizationInput,
    options: RelayRequestOptions = {}
  ): Promise<RelayDeviceAuthorizationDto> {
    this.#assertEndpointConfirmed()
    const normalizedInput = normalizeDeviceAuthorizationInput(input)
    this.#pruneDeviceSessions()
    if (this.#deviceSessions.size >= MAX_ACTIVE_DEVICE_SESSIONS) {
      throw new RelayServiceError('too_many_sessions')
    }

    const data = await this.#requestData({
      method: 'POST',
      path: '/api/desktop/auth/code',
      body: normalizedInput
    }, options)
    const parsed = parseDeviceAuthorization(data, this.#origin)
    const now = this.#safeNow()
    const sessionId = normalizeGeneratedSessionId(this.#createSessionId())
    const expiresAt = now + parsed.expiresIn * 1000
    this.#deviceSessions.set(sessionId, {
      deviceCode: parsed.deviceCode,
      deviceIdHint: null,
      verificationUriComplete: parsed.verificationUriComplete,
      expiresAt,
      intervalSeconds: parsed.interval,
      nextPollAt: now + parsed.interval * 1000
    })

    return Object.freeze({
      session_id: sessionId,
      user_code: parsed.userCode,
      verification_uri: parsed.verificationUri,
      verification_uri_complete: parsed.verificationUriComplete,
      expires_in: parsed.expiresIn,
      interval: parsed.interval,
      expires_at: Math.floor(expiresAt / 1000)
    })
  }

  getDeviceAuthorizationUrl(sessionId: string): string {
    this.#assertEndpointConfirmed()
    const safeSessionId = normalizeSessionId(sessionId)
    const session = this.#deviceSessions.get(safeSessionId)
    if (!session) throw new RelayServiceError('invalid_input')
    if (this.#safeNow() >= session.expiresAt) {
      this.#deviceSessions.delete(safeSessionId)
      throw new RelayServiceError('authorization_expired')
    }
    return session.verificationUriComplete
  }

  async pollDeviceAuthorization(
    sessionId: string,
    options: RelayRequestOptions = {}
  ): Promise<RelayDeviceAuthorizationPollDto> {
    this.#assertEndpointConfirmed()
    const safeSessionId = normalizeSessionId(sessionId)
    const session = this.#deviceSessions.get(safeSessionId)
    if (!session) throw new RelayServiceError('invalid_input')
    const now = this.#safeNow()
    if (now >= session.expiresAt) {
      this.#deviceSessions.delete(safeSessionId)
      return Object.freeze({ status: 'expired' })
    }
    if (now < session.nextPollAt) {
      return Object.freeze({
        status: 'pending',
        retry_after: Math.max(1, Math.ceil((session.nextPollAt - now) / 1000))
      })
    }

    session.nextPollAt = now + session.intervalSeconds * 1000
    try {
      const credentialEpoch = this.#credentialEpoch
      const data = await this.#requestData({
        method: 'POST',
        path: '/api/desktop/auth/token',
        body: { device_code: session.deviceCode }
      }, options)
      const tokens = parseTokenResponse(data)
      session.deviceIdHint = tokens.deviceId
      await this.#commitRotatedCredential(tokens, null, credentialEpoch)
      this.#deviceSessions.delete(safeSessionId)
      return Object.freeze({ status: 'authenticated', device_id: tokens.deviceId })
    } catch (error) {
      if (!(error instanceof RelayServiceError)) throw new RelayServiceError('invalid_response')
      if (error.code === 'authorization_pending') {
        return Object.freeze({ status: 'pending', retry_after: session.intervalSeconds })
      }
      if (error.code === 'authorization_slow_down') {
        session.intervalSeconds = Math.min(60, session.intervalSeconds + 5)
        session.nextPollAt = this.#safeNow() + session.intervalSeconds * 1000
        return Object.freeze({ status: 'slow_down', retry_after: session.intervalSeconds })
      }
      if (error.code === 'authorization_expired') {
        this.#deviceSessions.delete(safeSessionId)
        return Object.freeze({ status: 'expired' })
      }
      if (error.code === 'authorization_denied') {
        this.#deviceSessions.delete(safeSessionId)
        return Object.freeze({ status: 'denied' })
      }
      throw error
    }
  }

  async restoreSession(options: RelayRequestOptions = {}): Promise<RelayAuthenticationStateDto> {
    this.#assertEndpointConfirmed()
    await this.#loadCredential()
    if (!this.#credential) return Object.freeze({ authenticated: false, device_id: null })
    try {
      await this.#ensureAccessCredential(options, true)
      return Object.freeze({ authenticated: true, device_id: this.#credential?.device_id ?? null })
    } catch (error) {
      if (error instanceof RelayServiceError && error.code === 'authentication_required') {
        await this.#clearCredential()
        return Object.freeze({ authenticated: false, device_id: null })
      }
      throw error
    }
  }

  getAuthenticationState(): RelayAuthenticationStateDto {
    const authenticated = this.#credential !== null && this.#accessCredential !== null && !this.#accessIsExpired()
    return Object.freeze({
      authenticated,
      device_id: authenticated ? this.#credential?.device_id ?? null : null
    })
  }

  async ensureAuthenticatedSession(
    options: RelayRequestOptions = {}
  ): Promise<RelayAuthenticationStateDto> {
    this.#assertEndpointConfirmed()
    await this.#ensureAccessCredential(options)
    const authentication = this.getAuthenticationState()
    if (!authentication.authenticated) throw new RelayServiceError('authentication_required')
    return authentication
  }

  async clearLocalSession(): Promise<void> {
    this.#accessCredential = null
    this.clearModelAccessCredentials()
    this.#deviceSessions.clear()
    await this.#clearCredential()
  }

  clearModelAccessCredentials(tokenId?: number): void {
    if (tokenId === undefined) {
      this.#modelAccessCredentialEpoch += 1
      for (const timer of this.#modelAccessCredentialTimers.values()) clearTimeout(timer)
      this.#modelAccessCredentialCache.clear()
      this.#modelAccessCredentialTimers.clear()
      this.#modelAccessCredentialPromises.clear()
      this.#modelAccessCredentialPromiseSelections.clear()
      this.#modelAccessCredentialTokenEpochs.clear()
      return
    }

    const safeTokenId = boundedInteger(tokenId, 1, Number.MAX_SAFE_INTEGER, 'invalid_input')
    this.#modelAccessCredentialTokenEpochs.set(
      safeTokenId,
      (this.#modelAccessCredentialTokenEpochs.get(safeTokenId) ?? 0) + 1
    )
    for (const [cacheKey, entry] of this.#modelAccessCredentialCache) {
      if (entry.credentials.tokenId === safeTokenId) this.#clearModelAccessCredentialCacheKey(cacheKey)
    }
    for (const [cacheKey, selection] of this.#modelAccessCredentialPromiseSelections) {
      if (selection?.tokenId === safeTokenId) {
        this.#modelAccessCredentialPromises.delete(cacheKey)
        this.#modelAccessCredentialPromiseSelections.delete(cacheKey)
      }
    }
  }

  async getSelf(options: RelayRequestOptions = {}): Promise<RelayAccountDto> {
    const data = await this.#authenticatedGet('/api/desktop/self', options)
    return parseAccount(data)
  }

  async getBillingConfig(
    options: RelayRequestOptions = {}
  ): Promise<RelayDesktopBillingConfigV1Dto> {
    const data = await this.#authenticatedGet('/api/desktop/billing-config', options)
    return parseDesktopBillingConfigV1(data)
  }

  async getUserGroups(options: RelayRequestOptions = {}): Promise<RelayGroupsDto> {
    const data = await this.#authenticatedGet('/api/user/self/groups', options)
    return parseGroups(data)
  }

  async getUserModels(options: RelayRequestOptions = {}): Promise<readonly string[]> {
    const data = await this.#authenticatedGet('/api/user/models', options)
    return parseModels(data)
  }

  async listApiTokens(
    page = 1,
    pageSize = 100,
    options: RelayRequestOptions = {}
  ): Promise<RelayApiTokenPageDto> {
    const safePage = boundedInteger(page, 1, 1_000_000, 'invalid_input')
    const safePageSize = boundedInteger(pageSize, 1, 100, 'invalid_input')
    const query = new URLSearchParams({ p: String(safePage), size: String(safePageSize) })
    const data = await this.#authenticatedGet(`/api/token/?${query.toString()}`, options)
    return parseTokenPage(data, safePage, safePageSize)
  }

  async getModelAccessCredentials(
    options: RelayRequestOptions = {}
  ): Promise<Readonly<RelayModelAccessCredentials>> {
    return await this.#getModelAccessCredentials(null, options)
  }

  async getSelectedModelAccessCredentials(
    selection: RelayModelAccessSelection,
    options: RelayRequestOptions = {}
  ): Promise<Readonly<RelayModelAccessCredentials>> {
    return await this.#getModelAccessCredentials(normalizeModelAccessSelection(selection), options)
  }

  async #getModelAccessCredentials(
    selection: Readonly<NormalizedModelAccessSelection> | null,
    options: RelayRequestOptions
  ): Promise<Readonly<RelayModelAccessCredentials>> {
    this.#assertEndpointConfirmed()
    await this.#ensureAccessCredential(options)
    const cacheKey = modelAccessSelectionCacheKey(selection)
    const now = this.#safeNow()
    const cached = this.#modelAccessCredentialCache.get(cacheKey)
    if (cached && now < cached.expiresAt) {
      return cached.credentials
    }
    if (cached) this.#clearModelAccessCredentialCacheKey(cacheKey)
    const pending = this.#modelAccessCredentialPromises.get(cacheKey)
    if (pending) return await pending

    const credentialEpoch = this.#credentialEpoch
    const modelAccessCredentialEpoch = this.#modelAccessCredentialEpoch
    let tracked: Promise<Readonly<RelayModelAccessCredentials>>
    tracked = this.#fetchModelAccessCredentials(
      selection,
      cacheKey,
      options,
      credentialEpoch,
      modelAccessCredentialEpoch
    ).finally(() => {
      if (this.#modelAccessCredentialPromises.get(cacheKey) === tracked) {
        this.#modelAccessCredentialPromises.delete(cacheKey)
        this.#modelAccessCredentialPromiseSelections.delete(cacheKey)
      }
    })
    this.#modelAccessCredentialPromises.set(cacheKey, tracked)
    this.#modelAccessCredentialPromiseSelections.set(cacheKey, selection)
    return await tracked
  }

  async #fetchModelAccessCredentials(
    selection: Readonly<NormalizedModelAccessSelection> | null,
    cacheKey: string,
    options: RelayRequestOptions,
    credentialEpoch: number,
    modelAccessCredentialEpoch: number
  ): Promise<Readonly<RelayModelAccessCredentials>> {
    const token = selection
      ? await this.#selectModelAccessToken(selection, options)
      : await this.#selectLegacyModelAccessToken(options)
    const tokenEpoch = this.#modelAccessCredentialTokenEpochs.get(token.id) ?? 0

    const accessToken = await this.#accessToken(options)
    const data = await this.#requestData({
      method: 'POST',
      path: `/api/token/${token.id}/key`,
      authorization: accessToken,
      maxResponseBytes: 64 * 1024
    }, options)
    const apiKey = parseApiTokenKey(data)
    this.#assertEndpointConfirmed()
    if (
      credentialEpoch !== this.#credentialEpoch ||
      modelAccessCredentialEpoch !== this.#modelAccessCredentialEpoch ||
      tokenEpoch !== (this.#modelAccessCredentialTokenEpochs.get(token.id) ?? 0)
    ) {
      throw new RelayServiceError('cancelled')
    }

    const credentials = Object.freeze({
      baseUrl: `${this.#origin}/v1`,
      apiKey,
      tokenId: token.id
    })
    this.#modelAccessCredentialCache.set(cacheKey, {
      credentials,
      expiresAt: this.#safeNow() + this.#modelAccessCredentialTtlMs
    })
    this.#scheduleModelAccessCredentialExpiry(cacheKey)
    return credentials
  }

  async #selectLegacyModelAccessToken(
    options: RelayRequestOptions
  ): Promise<Readonly<RelayApiTokenDto>> {
    const page = await this.listApiTokens(1, MODEL_ACCESS_TOKEN_PAGE_SIZE, options)
    const nowSeconds = Math.floor(this.#safeNow() / 1000)
    const token = page.items.find((candidate) => isUsableModelAccessToken(candidate, nowSeconds))
    if (!token) throw new RelayServiceError('no_available_token')
    return token
  }

  async #selectModelAccessToken(
    selection: Readonly<NormalizedModelAccessSelection>,
    options: RelayRequestOptions
  ): Promise<Readonly<RelayApiTokenDto>> {
    const account = await this.getSelf(options)
    const firstPage = await this.listApiTokens(1, MODEL_ACCESS_TOKEN_PAGE_SIZE, options)
    if (firstPage.total > MODEL_ACCESS_TOKEN_PAGE_SIZE * MAX_MODEL_ACCESS_TOKEN_PAGES) {
      throw new RelayServiceError('invalid_response')
    }

    const tokens: Readonly<RelayApiTokenDto>[] = [...firstPage.items]
    const tokenIds = new Set(tokens.map((token) => token.id))
    const pageCount = Math.ceil(firstPage.total / MODEL_ACCESS_TOKEN_PAGE_SIZE)
    for (let pageNumber = 2; pageNumber <= pageCount; pageNumber += 1) {
      const page = await this.listApiTokens(pageNumber, MODEL_ACCESS_TOKEN_PAGE_SIZE, options)
      if (page.total !== firstPage.total) throw new RelayServiceError('invalid_response')
      for (const token of page.items) {
        if (tokenIds.has(token.id)) throw new RelayServiceError('invalid_response')
        tokenIds.add(token.id)
        tokens.push(token)
      }
    }
    if (tokens.length !== firstPage.total) throw new RelayServiceError('invalid_response')

    const nowSeconds = Math.floor(this.#safeNow() / 1000)
    const candidates = tokens.filter((token) => (
      (selection.tokenId === undefined || token.id === selection.tokenId) &&
      isUsableSelectedModelAccessToken(token, nowSeconds) &&
      (token.group || account.group) === selection.groupId &&
      tokenAllowsModel(token, selection.modelId)
    ))
    candidates.sort(compareModelAccessTokens)
    const token = candidates[0]
    if (!token) throw new RelayServiceError('no_compatible_token')
    return token
  }

  async getUsageHistory(
    startTimestamp: number,
    endTimestamp: number,
    options: RelayRequestOptions = {}
  ): Promise<RelayDesktopUsageV1Dto> {
    const start = boundedInteger(startTimestamp, 1, Number.MAX_SAFE_INTEGER, 'invalid_input')
    const end = boundedInteger(endTimestamp, start, Number.MAX_SAFE_INTEGER, 'invalid_input')
    if (end - start > 2_592_000) throw new RelayServiceError('invalid_input')
    const query = new URLSearchParams({
      start_timestamp: String(start),
      end_timestamp: String(end)
    })
    const data = await this.#authenticatedGet(
      `/api/desktop/usage?${query.toString()}`,
      options,
      MAX_USAGE_RESPONSE_BYTES
    )
    return parseDesktopUsageV1(data, start, end)
  }

  async getPricing(options: RelayRequestOptions = {}): Promise<RelayPricingDto> {
    this.#assertEndpointConfirmed()
    const envelope = await this.#requestEnvelope({
      method: 'GET',
      path: '/api/pricing',
      maxResponseBytes: MAX_PRICING_RESPONSE_BYTES
    }, options)
    return parsePricingEnvelope(envelope)
  }

  async redeem(
    code: string,
    options: RelayRequestOptions = {}
  ): Promise<RelayRedeemResultDto> {
    const safeCode = normalizeRedemptionCode(code)
    const accessToken = await this.#accessToken(options)
    const data = await this.#requestData({
      method: 'POST',
      path: '/api/user/topup',
      body: { key: safeCode },
      authorization: accessToken,
      maxResponseBytes: 64 * 1024
    }, options)
    if (!Number.isSafeInteger(data) || Number(data) <= 0) throw new RelayServiceError('invalid_response')
    return Object.freeze({ quota: Number(data) })
  }

  async updateApiTokenStatus(
    id: number,
    status: 1 | 2,
    options: RelayRequestOptions = {}
  ): Promise<RelayTokenMutationResultDto> {
    const safeId = boundedInteger(id, 1, Number.MAX_SAFE_INTEGER, 'invalid_input')
    if (status !== 1 && status !== 2) throw new RelayServiceError('invalid_input')
    const accessToken = await this.#accessToken(options)
    const data = await this.#requestData({
      method: 'PUT',
      path: '/api/token/?status_only=true',
      body: { id: safeId, status },
      authorization: accessToken
    }, options)
    if (isPlainRecord(data) && Object.keys(data).length > 0) {
      const token = parseApiToken(data)
      if (token.id !== safeId || token.status !== status) throw new RelayServiceError('invalid_response')
    }
    if (status === 2) this.clearModelAccessCredentials(safeId)
    return Object.freeze({ id: safeId, status })
  }

  async revokeApiToken(
    id: number,
    options: RelayRequestOptions = {}
  ): Promise<RelayTokenMutationResultDto> {
    const safeId = boundedInteger(id, 1, Number.MAX_SAFE_INTEGER, 'invalid_input')
    const accessToken = await this.#accessToken(options)
    await this.#requestData({
      method: 'DELETE',
      path: `/api/token/${safeId}`,
      authorization: accessToken,
      allowEmpty: true
    }, options)
    this.clearModelAccessCredentials(safeId)
    return Object.freeze({ id: safeId })
  }

  async revokeDevice(options: RelayRequestOptions = {}): Promise<void> {
    await this.#loadCredential()
    if (!this.#credential) throw new RelayServiceError('authentication_required')
    const deviceId = normalizeOpaqueId(this.#credential.device_id, 'invalid_response')
    const accessToken = await this.#accessToken(options)
    await this.#requestData({
      method: 'DELETE',
      path: `/api/desktop/devices/${encodeURIComponent(deviceId)}`,
      authorization: accessToken,
      allowEmpty: true
    }, options)
    this.#accessCredential = null
    await this.#clearCredential()
  }

  async #authenticatedGet(
    path: string,
    options: RelayRequestOptions,
    maxResponseBytes?: number
  ): Promise<unknown> {
    const accessToken = await this.#accessToken(options)
    try {
      return await this.#requestData({
        method: 'GET',
        path,
        authorization: accessToken,
        maxResponseBytes
      }, options)
    } catch (error) {
      if (!(error instanceof RelayServiceError) || error.code !== 'authentication_required') throw error
      this.#accessCredential = null
      const refreshedToken = await this.#accessToken(options, true)
      return this.#requestData({
        method: 'GET',
        path,
        authorization: refreshedToken,
        maxResponseBytes
      }, options)
    }
  }

  async #accessToken(options: RelayRequestOptions, forceRefresh = false): Promise<string> {
    this.#assertEndpointConfirmed()
    await this.#ensureAccessCredential(options, forceRefresh)
    if (!this.#accessCredential) throw new RelayServiceError('authentication_required')
    return this.#accessCredential.value
  }

  async #ensureAccessCredential(options: RelayRequestOptions, forceRefresh = false): Promise<void> {
    if (!forceRefresh && this.#accessCredential && !this.#accessIsExpired()) return
    await this.#loadCredential()
    if (!this.#credential) throw new RelayServiceError('authentication_required')
    if (this.#credential.refresh_expires_at <= Math.floor(this.#safeNow() / 1000)) {
      await this.#clearCredential()
      throw new RelayServiceError('authentication_required')
    }
    if (!this.#refreshPromise) {
      this.#refreshPromise = this.#refreshAccess(options).finally(() => {
        this.#refreshPromise = null
      })
    }
    await this.#refreshPromise
  }

  async #refreshAccess(options: RelayRequestOptions): Promise<void> {
    const credential = this.#credential
    if (!credential) throw new RelayServiceError('authentication_required')
    const credentialEpoch = this.#credentialEpoch
    let data: unknown
    try {
      data = await this.#requestData({
        method: 'POST',
        path: '/api/desktop/auth/refresh',
        body: { refresh_token: credential.refresh_token }
      }, options)
    } catch (error) {
      if (error instanceof RelayServiceError && error.code === 'authentication_required') {
        this.#accessCredential = null
        this.clearModelAccessCredentials()
      }
      throw error
    }
    const tokens = parseTokenResponse(data)
    if (tokens.refreshToken === credential.refresh_token || tokens.deviceId !== credential.device_id) {
      throw new RelayServiceError('invalid_response')
    }
    await this.#commitRotatedCredential(tokens, credential.refresh_token, credentialEpoch)
  }

  async #commitRotatedCredential(
    tokens: TokenResponse,
    previousRefreshToken: string | null,
    credentialEpoch: number
  ): Promise<void> {
    if (previousRefreshToken !== null && tokens.refreshToken === previousRefreshToken) {
      throw new RelayServiceError('invalid_response')
    }
    if (credentialEpoch !== this.#credentialEpoch) throw new RelayServiceError('cancelled')
    const now = this.#safeNow()
    const stored: RelayStoredCredential = Object.freeze({
      version: 1,
      server_origin: this.#origin,
      refresh_token: tokens.refreshToken,
      device_id: tokens.deviceId,
      refresh_expires_at: Math.floor((now + tokens.refreshExpiresIn * 1000) / 1000),
      updated_at: Math.floor(now / 1000)
    })
    try {
      await this.#runStorageMutation(async () => {
        if (credentialEpoch !== this.#credentialEpoch) throw new RelayServiceError('cancelled')
        await this.#storage.saveCredential(stored)
      })
    } catch {
      this.#accessCredential = null
      if (credentialEpoch !== this.#credentialEpoch) throw new RelayServiceError('cancelled')
      throw new RelayServiceError('storage_error')
    }
    if (credentialEpoch !== this.#credentialEpoch) throw new RelayServiceError('cancelled')
    this.#credential = stored
    this.#credentialLoaded = true
    this.clearModelAccessCredentials()
    this.#accessCredential = {
      value: tokens.accessToken,
      expiresAt: now + tokens.expiresIn * 1000
    }
  }

  async #loadCredential(): Promise<void> {
    if (this.#credentialLoaded) return
    let raw: unknown
    try {
      await this.#storageMutation
      raw = await this.#storage.loadCredential()
    } catch {
      throw new RelayServiceError('storage_error')
    }
    this.#credentialLoaded = true
    if (raw === null || raw === undefined) {
      this.#credential = null
      return
    }
    try {
      this.#credential = parseStoredCredential(raw, this.#origin)
    } catch {
      this.#credential = null
      throw new RelayServiceError('storage_error')
    }
  }

  async #clearCredential(): Promise<void> {
    this.#credentialEpoch += 1
    this.#accessCredential = null
    this.clearModelAccessCredentials()
    this.#credential = null
    this.#credentialLoaded = true
    try {
      await this.#runStorageMutation(() => this.#storage.clearCredential())
    } catch {
      throw new RelayServiceError('storage_error')
    }
  }

  async #runStorageMutation(operation: () => Promise<void>): Promise<void> {
    const pending = this.#storageMutation.then(operation)
    this.#storageMutation = pending.catch(() => undefined)
    await pending
  }

  #accessIsExpired(): boolean {
    const access = this.#accessCredential
    if (!access) return true
    const lifetimeRemaining = access.expiresAt - this.#safeNow()
    return lifetimeRemaining <= 30_000
  }

  #scheduleModelAccessCredentialExpiry(cacheKey: string): void {
    const existing = this.#modelAccessCredentialTimers.get(cacheKey)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.#clearModelAccessCredentialCacheKey(cacheKey)
    }, this.#modelAccessCredentialTtlMs)
    timer.unref?.()
    this.#modelAccessCredentialTimers.set(cacheKey, timer)
  }

  #clearModelAccessCredentialCacheKey(cacheKey: string): void {
    this.#modelAccessCredentialCache.delete(cacheKey)
    const timer = this.#modelAccessCredentialTimers.get(cacheKey)
    if (timer) clearTimeout(timer)
    this.#modelAccessCredentialTimers.delete(cacheKey)
  }

  #pruneDeviceSessions(): void {
    const now = this.#safeNow()
    for (const [id, session] of this.#deviceSessions) {
      if (session.expiresAt <= now) this.#deviceSessions.delete(id)
    }
  }

  #assertEndpointConfirmed(): void {
    if (this.#disposed) throw new RelayServiceError('cancelled')
    if (!this.#endpointConfirmed) throw new RelayServiceError('endpoint_not_confirmed')
  }

  #safeNow(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) throw new RelayServiceError('invalid_configuration')
    return value
  }

  async #requestData(request: HttpRequest, options: RelayRequestOptions): Promise<unknown> {
    const envelope = await this.#requestEnvelope(request, options)
    if (!Object.hasOwn(envelope, 'data')) {
      if (request.allowEmpty) return {}
      throw new RelayServiceError('invalid_response')
    }
    if ((envelope.data === null || envelope.data === undefined) && request.allowEmpty) return {}
    return envelope.data
  }

  async #requestEnvelope(
    request: HttpRequest,
    options: RelayRequestOptions
  ): Promise<Record<string, unknown>> {
    this.#assertEndpointConfirmed()
    validateRequestOptions(options)
    const responseLimit = Math.min(
      this.#maxResponseBytes,
      request.maxResponseBytes ?? this.#maxResponseBytes
    )
    const url = this.#urlForPath(request.path)
    let payload: string | undefined
    if (request.body !== undefined) {
      if (!isPlainRecord(request.body)) throw new RelayServiceError('invalid_input')
      payload = JSON.stringify(request.body)
      if (Buffer.byteLength(payload, 'utf8') > MAX_REQUEST_BODY_BYTES) {
        throw new RelayServiceError('invalid_input')
      }
    }

    const callerSignal = options.signal
    if (callerSignal?.aborted) throw new RelayServiceError('cancelled')
    const controller = new AbortController()
    let settleRequest!: () => void
    const settled = new Promise<void>((resolve) => { settleRequest = resolve })
    const activeRequest: ActiveRelayRequest = {
      controller,
      settled,
      settle: settleRequest
    }
    this.#activeRequests.add(activeRequest)
    let timedOut = false
    const abortFromCaller = (): void => controller.abort()
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.#timeoutMs)

    try {
      let response: Response
      try {
        const headers: Record<string, string> = {
          Accept: 'application/json',
          'Cache-Control': 'no-store'
        }
        if (payload !== undefined) headers['Content-Type'] = 'application/json'
        if (request.authorization !== undefined) {
          validateCredential(request.authorization)
          headers.Authorization = `Bearer ${request.authorization}`
        }
        response = await this.#fetcher(url, {
          method: request.method,
          headers,
          body: payload,
          redirect: 'manual',
          cache: 'no-store',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: controller.signal
        })
      } catch {
        if (this.#disposed) throw new RelayServiceError('cancelled')
        if (callerSignal?.aborted) throw new RelayServiceError('cancelled')
        if (timedOut) throw new RelayServiceError('timeout')
        throw new RelayServiceError('network_error')
      }

      if (callerSignal?.aborted) {
        await discardResponseBody(response)
        throw new RelayServiceError('cancelled')
      }
      if (timedOut) {
        await discardResponseBody(response)
        throw new RelayServiceError('timeout')
      }
      if (
        response.redirected ||
        response.type === 'opaqueredirect' ||
        (response.status >= 300 && response.status < 400)
      ) {
        await discardResponseBody(response)
        throw new RelayServiceError('redirect_rejected')
      }

      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'application/json') {
        await discardResponseBody(response)
        throw new RelayServiceError('invalid_response')
      }
      const raw = await readBoundedResponse(response, responseLimit)
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new RelayServiceError('invalid_response')
      }
      if (!isPlainRecord(parsed) || !hasSafeJsonKeys(parsed)) {
        throw new RelayServiceError('invalid_response')
      }

      if (!response.ok || parsed.success !== true) {
        throw mapRemoteFailure(response.status, parsed.error)
      }
      if (!hasOnlyKeys(parsed, [
        'success',
        'message',
        'data',
        'vendors',
        'group_ratio',
        'usable_group',
        'supported_endpoint',
        'auto_groups',
        'pricing_version'
      ])) {
        throw new RelayServiceError('invalid_response')
      }
      return parsed
    } catch (error) {
      // Cancellation can arrive while a bounded response body is being read.
      // Preserve caller-vs-timeout semantics instead of leaking a stream error.
      if (this.#disposed) throw new RelayServiceError('cancelled')
      if (callerSignal?.aborted) throw new RelayServiceError('cancelled')
      if (timedOut) throw new RelayServiceError('timeout')
      if (error instanceof RelayServiceError) throw error
      throw new RelayServiceError('invalid_response')
    } finally {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', abortFromCaller)
      this.#activeRequests.delete(activeRequest)
      activeRequest.settle()
    }
  }

  #urlForPath(path: string): string {
    if (
      typeof path !== 'string' ||
      !path.startsWith('/') ||
      path.startsWith('//') ||
      path.includes('#') ||
      path.includes('\\') ||
      /[\u0000-\u001f\u007f]/u.test(path)
    ) {
      throw new RelayServiceError('invalid_configuration')
    }
    let url: URL
    try {
      url = new URL(path, `${this.#origin}/`)
    } catch {
      throw new RelayServiceError('invalid_configuration')
    }
    if (url.origin !== this.#origin) throw new RelayServiceError('invalid_configuration')
    return url.href
  }
}

export function normalizeRelayServerOrigin(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048 || value !== value.trim()) {
    throw new RelayServiceError('invalid_endpoint')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new RelayServiceError('invalid_endpoint')
  }
  const insecureLoopback = url.protocol === 'http:' && isExactLoopbackHost(url.hostname)
  if (
    (url.protocol !== 'https:' && !insecureLoopback) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new RelayServiceError('invalid_endpoint')
  }
  return url.origin
}

function isExactLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]'
}

function normalizeDeviceAuthorizationInput(
  value: RelayDeviceAuthorizationInput
): Readonly<Record<string, string>> {
  if (!hasExactKeys(value, ['device_name', 'platform', 'client_version'])) {
    throw new RelayServiceError('invalid_input')
  }
  return Object.freeze({
    device_name: boundedText(value.device_name, 1, 100, 'invalid_input', true),
    platform: boundedText(value.platform, 1, 32, 'invalid_input', true),
    client_version: boundedText(value.client_version, 1, 32, 'invalid_input', true)
  })
}

function normalizeModelAccessSelection(
  value: RelayModelAccessSelection
): Readonly<NormalizedModelAccessSelection> {
  if (!hasOnlyKeys(value, ['groupId', 'modelId', 'tokenId']) || !Object.hasOwn(value, 'groupId')) {
    throw new RelayServiceError('invalid_input')
  }
  const groupId = boundedText(value.groupId, 1, 64, 'invalid_input', true)
  if (!GROUP_NAME_PATTERN.test(groupId)) throw new RelayServiceError('invalid_input')

  const output: NormalizedModelAccessSelection = { groupId }
  if (value.modelId !== undefined) {
    const modelId = boundedText(value.modelId, 1, 256, 'invalid_input', true)
    if (!MODEL_NAME_PATTERN.test(modelId)) throw new RelayServiceError('invalid_input')
    output.modelId = modelId
  }
  if (value.tokenId !== undefined) {
    output.tokenId = boundedInteger(value.tokenId, 1, Number.MAX_SAFE_INTEGER, 'invalid_input')
  }
  return Object.freeze(output)
}

function modelAccessSelectionCacheKey(
  selection: Readonly<NormalizedModelAccessSelection> | null
): string {
  if (!selection) return LEGACY_MODEL_ACCESS_CACHE_KEY
  return `selected:${JSON.stringify([selection.groupId, selection.modelId ?? null, selection.tokenId ?? null])}`
}

function isUsableModelAccessToken(token: Readonly<RelayApiTokenDto>, nowSeconds: number): boolean {
  return token.status === 1 &&
    (token.unlimited_quota === true || token.remain_quota === undefined || token.remain_quota > 0) &&
    (token.expired_time === undefined || token.expired_time <= 0 || token.expired_time > nowSeconds)
}

function isUsableSelectedModelAccessToken(
  token: Readonly<RelayApiTokenDto>,
  nowSeconds: number
): boolean {
  return token.status === 1 &&
    (token.unlimited_quota === true || (token.remain_quota !== undefined && token.remain_quota > 0)) &&
    (token.expired_time === undefined || token.expired_time <= 0 || token.expired_time > nowSeconds)
}

function tokenAllowsModel(token: Readonly<RelayApiTokenDto>, modelId: string | undefined): boolean {
  if (token.model_limits_enabled !== true) return true
  if (!modelId || token.model_limits === undefined) return false
  return token.model_limits.split(',').some((candidate) => candidate.trim() === modelId)
}

function compareModelAccessTokens(
  left: Readonly<RelayApiTokenDto>,
  right: Readonly<RelayApiTokenDto>
): number {
  const leftRestricted = left.model_limits_enabled === true
  const rightRestricted = right.model_limits_enabled === true
  if (leftRestricted !== rightRestricted) return leftRestricted ? 1 : -1

  const leftCreatedAt = left.created_time ?? 0
  const rightCreatedAt = right.created_time ?? 0
  if (leftCreatedAt !== rightCreatedAt) return rightCreatedAt > leftCreatedAt ? 1 : -1
  if (left.id !== right.id) return right.id > left.id ? 1 : -1
  return 0
}

function parseDeviceAuthorization(value: unknown, origin: string): {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
} {
  if (!hasExactKeys(value, [
    'device_code',
    'user_code',
    'verification_uri',
    'verification_uri_complete',
    'expires_in',
    'interval'
  ])) {
    throw new RelayServiceError('invalid_response')
  }
  const deviceCode = boundedText(value.device_code, 1, 2048, 'invalid_response')
  const userCode = boundedText(value.user_code, 1, 64, 'invalid_response')
  if (!USER_CODE_PATTERN.test(userCode)) throw new RelayServiceError('invalid_response')
  const verificationUri = trustedAuthorizationUrl(value.verification_uri, origin, userCode, false)
  const verificationUriComplete = trustedAuthorizationUrl(
    value.verification_uri_complete,
    origin,
    userCode,
    true
  )
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresIn: boundedInteger(value.expires_in, 1, 1800, 'invalid_response'),
    interval: boundedInteger(value.interval, 1, 60, 'invalid_response')
  }
}

function trustedAuthorizationUrl(
  value: unknown,
  origin: string,
  userCode: string,
  complete: boolean
): string {
  const text = boundedText(value, 1, 2048, 'invalid_response')
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new RelayServiceError('invalid_response')
  }
  if (
    url.origin !== origin ||
    url.pathname !== '/desktop/authorize' ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new RelayServiceError('invalid_response')
  }
  if (complete) {
    if ([...url.searchParams.keys()].length !== 1 || url.searchParams.get('user_code') !== userCode) {
      throw new RelayServiceError('invalid_response')
    }
  } else if (url.search) {
    throw new RelayServiceError('invalid_response')
  }
  return url.href
}

function parseTokenResponse(value: unknown): TokenResponse {
  if (!hasOnlyKeys(value, [
    'access_token',
    'refresh_token',
    'device_id',
    'expires_in',
    'refresh_expires_in',
    'token_type'
  ]) || !isPlainRecord(value)) {
    throw new RelayServiceError('invalid_response')
  }
  for (const key of ['access_token', 'refresh_token', 'device_id', 'expires_in', 'refresh_expires_in']) {
    if (!Object.hasOwn(value, key)) throw new RelayServiceError('invalid_response')
  }
  if (value.token_type !== undefined && value.token_type !== 'Bearer') {
    throw new RelayServiceError('invalid_response')
  }
  return {
    accessToken: validateCredential(value.access_token),
    refreshToken: validateCredential(value.refresh_token),
    deviceId: normalizeOpaqueId(value.device_id, 'invalid_response'),
    expiresIn: boundedInteger(value.expires_in, 60, MAX_ACCESS_TOKEN_SECONDS, 'invalid_response'),
    refreshExpiresIn: boundedInteger(
      value.refresh_expires_in,
      60,
      MAX_REFRESH_TOKEN_SECONDS,
      'invalid_response'
    )
  }
}

function parseStoredCredential(value: unknown, origin: string): RelayStoredCredential {
  if (!hasExactKeys(value, [
    'version',
    'server_origin',
    'refresh_token',
    'device_id',
    'refresh_expires_at',
    'updated_at'
  ]) || value.version !== 1 || value.server_origin !== origin) {
    throw new RelayServiceError('storage_error')
  }
  return Object.freeze({
    version: 1,
    server_origin: origin,
    refresh_token: validateCredential(value.refresh_token),
    device_id: normalizeOpaqueId(value.device_id, 'invalid_response'),
    refresh_expires_at: boundedInteger(value.refresh_expires_at, 1, Number.MAX_SAFE_INTEGER, 'invalid_response'),
    updated_at: boundedInteger(value.updated_at, 0, Number.MAX_SAFE_INTEGER, 'invalid_response')
  })
}

function parseAccount(value: unknown): RelayAccountDto {
  const allowed = [
    'id',
    'username',
    'display_name',
    'email',
    'group',
    'quota',
    'used_quota',
    'request_count',
    'device_id',
    'status',
    'role'
  ] as const
  if (!hasOnlyKeys(value, allowed) || !Object.hasOwn(value, 'id')) {
    throw new RelayServiceError('invalid_response')
  }
  const output: RelayAccountDto = { id: boundedInteger(value.id, 1, Number.MAX_SAFE_INTEGER, 'invalid_response') }
  copyOptionalText(value, output, 'username', 100)
  copyOptionalText(value, output, 'display_name', 100)
  copyOptionalText(value, output, 'email', 320)
  copyOptionalText(value, output, 'group', 64)
  copyOptionalText(value, output, 'device_id', 256)
  copyOptionalInteger(value, output, 'quota', 0)
  copyOptionalInteger(value, output, 'used_quota', 0)
  copyOptionalInteger(value, output, 'request_count', 0)
  copyOptionalInteger(value, output, 'status', 0)
  copyOptionalInteger(value, output, 'role', 0)
  return Object.freeze(output)
}

function parseDesktopBillingConfigV1(value: unknown): RelayDesktopBillingConfigV1Dto {
  if (!hasExactKeys(value, [
    'schema_version',
    'quota_per_unit',
    'display_in_currency',
    'quota_display_type',
    'usd_exchange_rate',
    'custom_currency_symbol',
    'custom_currency_exchange_rate'
  ]) || value.schema_version !== 1) {
    throw new RelayServiceError('invalid_response')
  }

  const displayType = boundedText(value.quota_display_type, 3, 6, 'invalid_response')
  if (displayType !== 'USD' && displayType !== 'CNY' && displayType !== 'TOKENS' && displayType !== 'CUSTOM') {
    throw new RelayServiceError('invalid_response')
  }
  if (typeof value.display_in_currency !== 'boolean') {
    throw new RelayServiceError('invalid_response')
  }
  if (value.display_in_currency !== (displayType !== 'TOKENS')) {
    throw new RelayServiceError('invalid_response')
  }

  const quotaPerUnit = boundedBillingNumber(value.quota_per_unit, 0)
  const usdExchangeRate = boundedBillingNumber(value.usd_exchange_rate, 0)
  const customCurrencyExchangeRate = boundedBillingNumber(
    value.custom_currency_exchange_rate,
    0
  )
  if (
    quotaPerUnit <= 0
    || usdExchangeRate <= 0
    || customCurrencyExchangeRate <= 0
    || !validBillingScale(quotaPerUnit, usdExchangeRate)
    || !validBillingScale(quotaPerUnit, customCurrencyExchangeRate)
  ) {
    throw new RelayServiceError('invalid_response')
  }

  const customCurrencySymbol = boundedText(
    value.custom_currency_symbol,
    1,
    64,
    'invalid_response',
    true
  )
  if (Buffer.byteLength(customCurrencySymbol, 'utf8') > 64) {
    throw new RelayServiceError('invalid_response')
  }

  return Object.freeze({
    schema_version: 1,
    quota_per_unit: quotaPerUnit,
    display_in_currency: value.display_in_currency,
    quota_display_type: displayType,
    usd_exchange_rate: usdExchangeRate,
    custom_currency_symbol: customCurrencySymbol,
    custom_currency_exchange_rate: customCurrencyExchangeRate
  })
}

function parseGroups(value: unknown): RelayGroupsDto {
  if (!isPlainRecord(value) || Object.keys(value).length > MAX_GROUPS) {
    throw new RelayServiceError('invalid_response')
  }
  const output: Record<string, Readonly<RelayGroupInfoDto>> = Object.create(null) as Record<string, Readonly<RelayGroupInfoDto>>
  for (const [name, rawInfo] of Object.entries(value)) {
    if (!GROUP_NAME_PATTERN.test(name) || !hasOnlyKeys(rawInfo, ['ratio', 'desc'])) {
      throw new RelayServiceError('invalid_response')
    }
    const info: RelayGroupInfoDto = {}
    if (rawInfo.ratio !== undefined) {
      if (typeof rawInfo.ratio === 'number') {
        if (!Number.isFinite(rawInfo.ratio) || rawInfo.ratio < 0 || rawInfo.ratio > 1_000_000) {
          throw new RelayServiceError('invalid_response')
        }
        info.ratio = rawInfo.ratio
      } else {
        info.ratio = boundedText(rawInfo.ratio, 1, 64, 'invalid_response')
      }
    }
    if (rawInfo.desc !== undefined) info.desc = boundedText(rawInfo.desc, 0, 512, 'invalid_response')
    output[name] = Object.freeze(info)
  }
  return Object.freeze(output)
}

function parseModels(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_MODELS) throw new RelayServiceError('invalid_response')
  const output: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const model = boundedText(item, 1, 256, 'invalid_response')
    if (!MODEL_NAME_PATTERN.test(model) || seen.has(model)) throw new RelayServiceError('invalid_response')
    seen.add(model)
    output.push(model)
  }
  return Object.freeze(output)
}

function parseTokenPage(value: unknown, page: number, pageSize: number): RelayApiTokenPageDto {
  if (
    !hasOnlyKeys(value, ['page', 'page_size', 'total', 'items']) ||
    !Object.hasOwn(value, 'total') ||
    !Object.hasOwn(value, 'items')
  ) {
    throw new RelayServiceError('invalid_response')
  }
  if (
    (value.page !== undefined && value.page !== page) ||
    (value.page_size !== undefined && value.page_size !== pageSize)
  ) {
    throw new RelayServiceError('invalid_response')
  }
  const total = boundedInteger(value.total, 0, Number.MAX_SAFE_INTEGER, 'invalid_response')
  if (!Array.isArray(value.items) || value.items.length > pageSize || total < value.items.length) {
    throw new RelayServiceError('invalid_response')
  }
  const ids = new Set<number>()
  const items = value.items.map((item) => {
    const parsed = parseApiToken(item)
    if (ids.has(parsed.id)) throw new RelayServiceError('invalid_response')
    ids.add(parsed.id)
    return parsed
  })
  return Object.freeze({ page, page_size: pageSize, total, items: Object.freeze(items) })
}

function parseApiTokenKey(value: unknown): string {
  if (!hasExactKeys(value, ['key'])) throw new RelayServiceError('invalid_response')
  const key = boundedText(value.key, 1, 16_384, 'invalid_response')
  if (key.includes('*') || /[\u0000-\u001f\u007f]/u.test(key)) {
    throw new RelayServiceError('invalid_response')
  }
  return key.startsWith('sk-') ? key : `sk-${key}`
}

function parseApiToken(value: unknown): Readonly<RelayApiTokenDto> {
  const allowed = [
    'id',
    'user_id',
    'name',
    'key',
    'status',
    'remain_quota',
    'used_quota',
    'created_time',
    'accessed_time',
    'expired_time',
    'unlimited_quota',
    'model_limits_enabled',
    'cross_group_retry',
    'group',
    'model_limits',
    'allow_ips',
    'DeletedAt',
    'deleted_at'
  ] as const
  if (!hasOnlyKeys(value, allowed) || !Object.hasOwn(value, 'id') || !Object.hasOwn(value, 'name')) {
    throw new RelayServiceError('invalid_response')
  }
  const output: RelayApiTokenDto = {
    id: boundedInteger(value.id, 1, Number.MAX_SAFE_INTEGER, 'invalid_response'),
    name: boundedText(value.name, 1, 50, 'invalid_response'),
    key: ''
  }
  if (value.user_id !== undefined) {
    output.user_id = boundedInteger(value.user_id, 1, Number.MAX_SAFE_INTEGER, 'invalid_response')
  }
  for (const deletedAtField of ['DeletedAt', 'deleted_at'] as const) {
    if (value[deletedAtField] !== undefined && value[deletedAtField] !== null) {
      // Active-token list responses should not carry soft-delete metadata.
      throw new RelayServiceError('invalid_response')
    }
  }
  if (value.key !== undefined) {
    const key = boundedText(value.key, 0, 256, 'invalid_response')
    output.key = key ? 'sk-********' : ''
  }
  if (value.status !== undefined) {
    const status = boundedInteger(value.status, 1, 4, 'invalid_response')
    output.status = status as 1 | 2 | 3 | 4
  }
  for (const field of ['remain_quota', 'used_quota', 'created_time', 'accessed_time'] as const) {
    copyOptionalInteger(value, output, field, 0)
  }
  copyOptionalInteger(value, output, 'expired_time', -1)
  for (const field of ['unlimited_quota', 'model_limits_enabled', 'cross_group_retry'] as const) {
    if (value[field] !== undefined) {
      if (typeof value[field] !== 'boolean') throw new RelayServiceError('invalid_response')
      output[field] = value[field]
    }
  }
  copyOptionalText(value, output, 'group', 64)
  copyOptionalText(value, output, 'model_limits', 16_384)
  if (value.allow_ips !== undefined) {
    const allowIps = boundedText(value.allow_ips, 0, 4096, 'invalid_response', false, true)
    output.allow_ips = allowIps
  }
  return Object.freeze(output)
}

function parseDesktopUsageV1(
  value: unknown,
  expectedStart: number,
  expectedEnd: number
): RelayDesktopUsageV1Dto {
  if (!hasExactKeys(value, ['schema_version', 'range', 'totals', 'records']) || value.schema_version !== 1) {
    throw new RelayServiceError('invalid_response')
  }
  if (!hasExactKeys(value.range, ['start_timestamp', 'end_timestamp'])) {
    throw new RelayServiceError('invalid_response')
  }
  const start = boundedInteger(value.range.start_timestamp, 1, Number.MAX_SAFE_INTEGER, 'invalid_response')
  const end = boundedInteger(value.range.end_timestamp, start, Number.MAX_SAFE_INTEGER, 'invalid_response')
  if (start !== expectedStart || end !== expectedEnd) throw new RelayServiceError('invalid_response')

  if (!hasExactKeys(value.totals, ['count', 'quota', 'token_used'])) {
    throw new RelayServiceError('invalid_response')
  }
  const totals = Object.freeze({
    count: boundedInteger(value.totals.count, 0, Number.MAX_SAFE_INTEGER, 'invalid_response'),
    quota: boundedInteger(value.totals.quota, 0, Number.MAX_SAFE_INTEGER, 'invalid_response'),
    token_used: boundedInteger(value.totals.token_used, 0, Number.MAX_SAFE_INTEGER, 'invalid_response')
  })

  if (!Array.isArray(value.records) || value.records.length > 4096) {
    throw new RelayServiceError('invalid_response')
  }
  const records = value.records.map((item): Readonly<RelayUsageRecordDto> => {
    if (!hasExactKeys(item, ['created_at', 'count', 'quota', 'token_used', 'model_name'])) {
      throw new RelayServiceError('invalid_response')
    }
    const createdAt = boundedInteger(item.created_at, start, end, 'invalid_response')
    return Object.freeze({
      created_at: createdAt,
      count: boundedInteger(item.count, 0, Number.MAX_SAFE_INTEGER, 'invalid_response'),
      quota: boundedInteger(item.quota, 0, Number.MAX_SAFE_INTEGER, 'invalid_response'),
      token_used: boundedInteger(item.token_used, 0, Number.MAX_SAFE_INTEGER, 'invalid_response'),
      model_name: boundedText(item.model_name, 0, 256, 'invalid_response')
    })
  })
  if (
    totals.count !== sumSafeUsageField(records, 'count') ||
    totals.quota !== sumSafeUsageField(records, 'quota') ||
    totals.token_used !== sumSafeUsageField(records, 'token_used')
  ) {
    throw new RelayServiceError('invalid_response')
  }
  return Object.freeze({
    schema_version: 1,
    range: Object.freeze({ start_timestamp: start, end_timestamp: end }),
    totals,
    records: Object.freeze(records)
  })
}

function sumSafeUsageField(
  records: readonly Readonly<RelayUsageRecordDto>[],
  field: 'count' | 'quota' | 'token_used'
): number {
  let total = 0
  for (const record of records) {
    total += record[field]
    if (!Number.isSafeInteger(total)) throw new RelayServiceError('invalid_response')
  }
  return total
}

function parsePricingEnvelope(value: Record<string, unknown>): RelayPricingDto {
  if (!Array.isArray(value.data) || value.data.length > MAX_PRICING_MODELS) {
    throw new RelayServiceError('invalid_response')
  }
  const models = value.data.map(parsePricingModel)
  const output: RelayPricingDto = { data: Object.freeze(models) }
  if (value.vendors !== undefined) output.vendors = parsePricingVendors(value.vendors)
  if (value.group_ratio !== undefined) output.group_ratio = parseNumberMap(value.group_ratio)
  if (value.usable_group !== undefined) output.usable_group = parseStringMap(value.usable_group)
  if (value.supported_endpoint !== undefined) {
    output.supported_endpoint = parseSupportedEndpoints(value.supported_endpoint)
  }
  if (value.auto_groups !== undefined) output.auto_groups = parseBoundedStringArray(value.auto_groups, 256, 64)
  if (value.pricing_version !== undefined) {
    const version = boundedText(value.pricing_version, 1, 128, 'invalid_response')
    if (!PRICING_VERSION_PATTERN.test(version)) throw new RelayServiceError('invalid_response')
    output.pricing_version = version
  }
  return Object.freeze(output)
}

function parsePricingModel(value: unknown): Readonly<RelayPricingModelDto> {
  const allowed = [
    'model_name',
    'description',
    'icon',
    'tags',
    'vendor_id',
    'quota_type',
    'model_ratio',
    'model_price',
    'owner_by',
    'completion_ratio',
    'cache_ratio',
    'create_cache_ratio',
    'image_ratio',
    'audio_ratio',
    'audio_completion_ratio',
    'enable_groups',
    'supported_endpoint_types',
    'billing_mode',
    'billing_expr',
    'pricing_version'
  ] as const
  if (!hasOnlyKeys(value, allowed)) throw new RelayServiceError('invalid_response')
  for (const required of [
    'model_name',
    'quota_type',
    'model_ratio',
    'model_price',
    'owner_by',
    'completion_ratio',
    'enable_groups',
    'supported_endpoint_types'
  ]) {
    if (!Object.hasOwn(value, required)) throw new RelayServiceError('invalid_response')
  }
  const output: RelayPricingModelDto = {
    model_name: boundedText(value.model_name, 1, 256, 'invalid_response'),
    quota_type: boundedInteger(value.quota_type, 0, 16, 'invalid_response'),
    model_ratio: boundedFiniteNumber(value.model_ratio),
    model_price: boundedFiniteNumber(value.model_price),
    owner_by: boundedText(value.owner_by, 0, 128, 'invalid_response'),
    completion_ratio: boundedFiniteNumber(value.completion_ratio),
    enable_groups: parseBoundedStringArray(value.enable_groups, 256, 64),
    supported_endpoint_types: parseBoundedStringArray(value.supported_endpoint_types, 64, 64)
  }
  copyOptionalText(value, output, 'description', 4096)
  copyOptionalText(value, output, 'icon', 2048)
  copyOptionalText(value, output, 'tags', 2048)
  copyOptionalText(value, output, 'billing_mode', 64)
  copyOptionalText(value, output, 'billing_expr', 8192)
  copyOptionalText(value, output, 'pricing_version', 128)
  if (value.vendor_id !== undefined) {
    output.vendor_id = boundedInteger(value.vendor_id, 0, Number.MAX_SAFE_INTEGER, 'invalid_response')
  }
  for (const field of [
    'cache_ratio',
    'create_cache_ratio',
    'image_ratio',
    'audio_ratio',
    'audio_completion_ratio'
  ] as const) {
    if (value[field] !== undefined) output[field] = boundedFiniteNumber(value[field])
  }
  return Object.freeze(output)
}

function parsePricingVendors(value: unknown): readonly Readonly<RelayPricingVendorDto>[] {
  if (!Array.isArray(value) || value.length > 512) throw new RelayServiceError('invalid_response')
  return Object.freeze(value.map((item): Readonly<RelayPricingVendorDto> => {
    if (!hasOnlyKeys(item, ['id', 'name', 'description', 'icon']) || !Object.hasOwn(item, 'id') || !Object.hasOwn(item, 'name')) {
      throw new RelayServiceError('invalid_response')
    }
    const output: RelayPricingVendorDto = {
      id: boundedInteger(item.id, 0, Number.MAX_SAFE_INTEGER, 'invalid_response'),
      name: boundedText(item.name, 1, 128, 'invalid_response')
    }
    copyOptionalText(item, output, 'description', 2048)
    copyOptionalText(item, output, 'icon', 2048)
    return Object.freeze(output)
  }))
}

function parseNumberMap(value: unknown): Readonly<Record<string, number>> {
  if (!isPlainRecord(value) || Object.keys(value).length > MAX_GROUPS) throw new RelayServiceError('invalid_response')
  const output: Record<string, number> = Object.create(null) as Record<string, number>
  for (const [key, item] of Object.entries(value)) {
    if (!GROUP_NAME_PATTERN.test(key)) throw new RelayServiceError('invalid_response')
    output[key] = boundedFiniteNumber(item)
  }
  return Object.freeze(output)
}

function parseStringMap(value: unknown): Readonly<Record<string, string>> {
  if (!isPlainRecord(value) || Object.keys(value).length > MAX_GROUPS) throw new RelayServiceError('invalid_response')
  const output: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, item] of Object.entries(value)) {
    if (!GROUP_NAME_PATTERN.test(key)) throw new RelayServiceError('invalid_response')
    output[key] = boundedText(item, 0, 256, 'invalid_response')
  }
  return Object.freeze(output)
}

function parseSupportedEndpoints(
  value: unknown
): Readonly<Record<string, Readonly<RelaySupportedEndpointDto>>> {
  if (!isPlainRecord(value) || Object.keys(value).length > 256) throw new RelayServiceError('invalid_response')
  const output: Record<string, Readonly<RelaySupportedEndpointDto>> = Object.create(null) as Record<string, Readonly<RelaySupportedEndpointDto>>
  for (const [key, item] of Object.entries(value)) {
    if (!MODEL_NAME_PATTERN.test(key) || !hasExactKeys(item, ['path', 'method'])) {
      throw new RelayServiceError('invalid_response')
    }
    const path = boundedText(item.path, 1, 512, 'invalid_response')
    const method = boundedText(item.method, 1, 16, 'invalid_response')
    if (!path.startsWith('/') || !/^[A-Z]+$/u.test(method)) throw new RelayServiceError('invalid_response')
    output[key] = Object.freeze({ path, method })
  }
  return Object.freeze(output)
}

function parseBoundedStringArray(value: unknown, maximumItems: number, maximumLength: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new RelayServiceError('invalid_response')
  const output: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const text = boundedText(item, 1, maximumLength, 'invalid_response')
    if (seen.has(text)) throw new RelayServiceError('invalid_response')
    seen.add(text)
    output.push(text)
  }
  return Object.freeze(output)
}

function normalizeRedemptionCode(value: string): string {
  if (typeof value !== 'string') throw new RelayServiceError('invalid_input')
  const normalized = value.trim()
  if (normalized !== value || !REDEMPTION_CODE_PATTERN.test(normalized)) {
    throw new RelayServiceError('invalid_input')
  }
  return normalized
}

function normalizeSessionId(value: unknown): string {
  return normalizeOpaqueId(value, 'invalid_input')
}

function normalizeGeneratedSessionId(value: unknown): string {
  return normalizeOpaqueId(value, 'invalid_configuration')
}

function normalizeOpaqueId(
  value: unknown,
  code: 'invalid_input' | 'invalid_response' | 'invalid_configuration'
): string {
  if (typeof value !== 'string' || !OPAQUE_ID_PATTERN.test(value)) throw new RelayServiceError(code)
  return value
}

function validateCredential(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_TOKEN_LENGTH ||
    value !== value.trim() ||
    /[\u0000-\u0020\u007f]/u.test(value)
  ) {
    throw new RelayServiceError('invalid_response')
  }
  return value
}

function copyOptionalText<T extends object, K extends keyof T & string>(
  source: Record<string, unknown>,
  target: T,
  key: K,
  maximumLength: number
): void {
  if (source[key] === undefined) return
  target[key] = boundedText(source[key], 0, maximumLength, 'invalid_response') as T[K]
}

function copyOptionalInteger<T extends object, K extends keyof T & string>(
  source: Record<string, unknown>,
  target: T,
  key: K,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER
): void {
  if (source[key] === undefined) return
  if (
    !Number.isSafeInteger(source[key]) ||
    Number(source[key]) < minimum ||
    Number(source[key]) > maximum
  ) {
    throw new RelayServiceError('invalid_response')
  }
  target[key] = Number(source[key]) as T[K]
}

function boundedText(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
  code: 'invalid_input' | 'invalid_response',
  requireTrimmed = false,
  allowWhitespaceControls = false
): string {
  if (
    typeof value !== 'string' ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    (requireTrimmed && value !== value.trim()) ||
    (allowWhitespaceControls
      ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
      : /[\u0000-\u001f\u007f]/u.test(value))
  ) {
    throw new RelayServiceError(code)
  }
  return value
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  code: 'invalid_input' | 'invalid_response'
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new RelayServiceError(code)
  }
  return Number(value)
}

function boundedFiniteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000_000_000) {
    throw new RelayServiceError('invalid_response')
  }
  return value
}

function boundedBillingNumber(value: unknown, minimum: number): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < minimum
    || value > Number.MAX_SAFE_INTEGER
  ) {
    throw new RelayServiceError('invalid_response')
  }
  return value
}

function validBillingScale(quotaPerUnit: number, exchangeRate: number): boolean {
  const scale = exchangeRate / quotaPerUnit
  return Number.isFinite(scale) && scale > 0
}

function mapRemoteFailure(status: number, remoteCode: unknown): RelayServiceError {
  if (remoteCode === 'authorization_pending') return new RelayServiceError('authorization_pending')
  if (remoteCode === 'slow_down') return new RelayServiceError('authorization_slow_down')
  if (remoteCode === 'expired_token' || remoteCode === 'device_code_expired') {
    return new RelayServiceError('authorization_expired')
  }
  if (remoteCode === 'access_denied' || remoteCode === 'authorization_denied') {
    return new RelayServiceError('authorization_denied')
  }
  if (
    status === 401 ||
    remoteCode === 'invalid_token' ||
    remoteCode === 'invalid_grant' ||
    remoteCode === 'refresh_token_expired'
  ) {
    return new RelayServiceError('authentication_required')
  }
  if (status === 408 || status === 429 || status >= 500) {
    return new RelayServiceError('remote_unavailable')
  }
  return new RelayServiceError('remote_rejected')
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  const contentLengthText = response.headers.get('content-length')
  if (contentLengthText !== null) {
    if (!/^[0-9]+$/u.test(contentLengthText) || Number(contentLengthText) > maximumBytes) {
      await discardResponseBody(response)
      throw new RelayServiceError('response_too_large')
    }
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maximumBytes) {
        await reader.cancel()
        throw new RelayServiceError('response_too_large')
      }
      chunks.push(next.value)
    }
  } catch (error) {
    if (error instanceof RelayServiceError) throw error
    throw new RelayServiceError('invalid_response')
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new RelayServiceError('invalid_response')
  } finally {
    bytes.fill(0)
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Rejected response bodies are intentionally discarded without inspection.
  }
}

function validateRequestOptions(value: RelayRequestOptions): void {
  if (!hasOnlyKeys(value, ['signal'])) throw new RelayServiceError('invalid_input')
  if (value.signal !== undefined && !isAbortSignal(value.signal)) throw new RelayServiceError('invalid_input')
}

function configurationInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new RelayServiceError('invalid_configuration')
  }
  return Number(value)
}

function isCredentialStorage(value: unknown): value is RelayEncryptedCredentialStorage {
  return isPlainRecordLike(value) &&
    typeof value.loadCredential === 'function' &&
    typeof value.saveCredential === 'function' &&
    typeof value.clearCredential === 'function'
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return isPlainRecordLike(value) &&
    typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function' &&
    typeof value.removeEventListener === 'function'
}

function isPlainRecordLike(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecordLike(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys<K extends string>(
  value: unknown,
  allowedKeys: readonly K[]
): value is Record<K, unknown> {
  if (!isPlainRecord(value)) return false
  const allowed = new Set<string>(allowedKeys)
  return Object.keys(value).every((key) => allowed.has(key))
}

function hasExactKeys<K extends string>(
  value: unknown,
  expectedKeys: readonly K[]
): value is Record<K, unknown> {
  if (!hasOnlyKeys(value, expectedKeys)) return false
  return Object.keys(value).length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key))
}

function hasSafeJsonKeys(value: unknown, depth = 0, budget = { count: 0 }): boolean {
  budget.count += 1
  if (depth > 16 || budget.count > 50_000) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((item) => hasSafeJsonKeys(item, depth + 1, budget))
  if (!isPlainRecord(value)) return false
  return Object.entries(value).every(([key, item]) =>
    key.length <= 128 && !FORBIDDEN_KEYS.has(key) && hasSafeJsonKeys(item, depth + 1, budget)
  )
}
