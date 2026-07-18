import type {
  RemoteRelayBillingConfigDto,
  RemoteRelayConnectionDto,
  RemoteRelayDeviceAuthorizationDto,
  RemoteRelayDeviceAuthorizationPollDto,
  RemoteRelayOverviewDto,
  RemoteRelayPricingDto,
  RemoteRelayTokenDto,
  RemoteRelayTokenMutationDto,
  RemoteRelayTokenPageDto,
  RemoteRelayUsageDto
} from '../../shared/contracts.ts'
import type {
  RelayAccountDto,
  RelayApiTokenDto,
  RelayApiTokenPageDto,
  RelayAuthenticationStateDto,
  RelayDesktopBillingConfigV1Dto,
  RelayDesktopUsageV1Dto,
  RelayDeviceAuthorizationDto,
  RelayDeviceAuthorizationPollDto,
  RelayGroupsDto,
  RelayPricingDto,
  RelayTokenMutationResultDto
} from './relay-service.ts'

export class RelayDtoAdapterError extends Error {
  readonly code: 'invalid_input' | 'invalid_data'

  constructor(code: 'invalid_input' | 'invalid_data' = 'invalid_data') {
    super(code === 'invalid_input'
      ? 'The relay renderer request is invalid.'
      : 'Relay data could not be converted to a renderer-safe response.')
    this.name = 'RelayDtoAdapterError'
    this.code = code
    this.stack = `${this.name}: ${this.message}`
  }
}

export interface NormalizedRelayUsageRange {
  from: string
  to: string
  startTimestamp: number
  endTimestamp: number
}

const MAX_USAGE_RANGE_SECONDS = 2_592_000

export function toRemoteRelayConnection(
  endpoint: string,
  endpointConfirmed: boolean,
  authentication: RelayAuthenticationStateDto
): RemoteRelayConnectionDto {
  return {
    endpoint,
    endpointConsent: {
      status: endpointConfirmed ? 'confirmed' : 'required',
      endpointLabel: endpoint
    },
    authenticated: endpointConfirmed && authentication.authenticated,
    deviceId: endpointConfirmed && authentication.authenticated
      ? authentication.device_id
      : null
  }
}

export function toRemoteRelayDeviceAuthorization(
  value: RelayDeviceAuthorizationDto
): RemoteRelayDeviceAuthorizationDto {
  return {
    sessionId: value.session_id,
    userCode: value.user_code,
    verificationUri: value.verification_uri,
    expiresAt: unixSecondsToIso(value.expires_at, false)!,
    intervalSeconds: value.interval
  }
}

export function toRemoteRelayDeviceAuthorizationPoll(
  value: RelayDeviceAuthorizationPollDto
): RemoteRelayDeviceAuthorizationPollDto {
  switch (value.status) {
    case 'pending':
    case 'slow_down':
      return { status: value.status, retryAfterSeconds: value.retry_after }
    case 'authenticated':
      return { status: 'authenticated', deviceId: value.device_id }
    case 'expired':
    case 'denied':
      return { status: value.status }
  }
}

export function toRemoteRelayOverview(
  account: RelayAccountDto,
  groups: RelayGroupsDto,
  models: readonly string[],
  updatedAt = new Date().toISOString()
): RemoteRelayOverviewDto {
  const remaining = optionalNonNegativeInteger(account.quota)
  const used = optionalNonNegativeInteger(account.used_quota)
  const total = remaining === null || used === null ? null : safeSum([remaining, used])
  return {
    account: {
      id: account.id,
      username: account.username ?? null,
      displayName: account.display_name || account.username || '已登录用户',
      email: account.email ?? null,
      group: account.group ?? null,
      status: optionalNonNegativeInteger(account.status),
      role: optionalNonNegativeInteger(account.role)
    },
    quota: { total, used, remaining },
    requestCount: optionalNonNegativeInteger(account.request_count),
    groups: Object.entries(groups)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([id, info]) => ({
        id,
        ratio: info.ratio ?? null,
        description: info.desc ?? null
      })),
    models: [...models],
    updatedAt: canonicalIsoTimestamp(updatedAt)
  }
}

export function toRemoteRelayBillingConfig(
  value: RelayDesktopBillingConfigV1Dto
): RemoteRelayBillingConfigDto {
  return {
    quotaPerUnit: value.quota_per_unit,
    displayInCurrency: value.display_in_currency,
    quotaDisplayType: value.quota_display_type,
    usdExchangeRate: value.usd_exchange_rate,
    customCurrencySymbol: value.custom_currency_symbol,
    customCurrencyExchangeRate: value.custom_currency_exchange_rate
  }
}

export function toRemoteRelayTokenPage(value: RelayApiTokenPageDto): RemoteRelayTokenPageDto {
  return {
    page: value.page,
    pageSize: value.page_size,
    total: value.total,
    items: value.items.map(toRemoteRelayToken)
  }
}

export function toRemoteRelayToken(value: Readonly<RelayApiTokenDto>): RemoteRelayTokenDto {
  return {
    id: value.id,
    name: value.name,
    maskedKey: value.key,
    status: value.status === 1 ? 'active' : value.status === 2 ? 'disabled' : 'unavailable',
    remainQuota: optionalNonNegativeInteger(value.remain_quota),
    usedQuota: optionalNonNegativeInteger(value.used_quota),
    unlimitedQuota: value.unlimited_quota ?? null,
    group: value.group ?? null,
    modelLimits: value.model_limits ?? null,
    createdAt: unixSecondsToIso(value.created_time, true),
    lastUsedAt: unixSecondsToIso(value.accessed_time, true),
    expiresAt: unixSecondsToIso(value.expired_time, true)
  }
}

export function toRemoteRelayTokenMutation(
  value: RelayTokenMutationResultDto,
  status: RemoteRelayTokenMutationDto['status']
): RemoteRelayTokenMutationDto {
  if (status !== 'revoked') {
    const expected = status === 'active' ? 1 : 2
    if (value.status !== undefined && value.status !== expected) throw new RelayDtoAdapterError()
  }
  return { tokenId: value.id, status }
}

export function normalizeRemoteRelayUsageInput(input: unknown): NormalizedRelayUsageRange {
  if (!hasExactKeys(input, ['from', 'to']) || typeof input.from !== 'string' || typeof input.to !== 'string') {
    throw new RelayDtoAdapterError('invalid_input')
  }
  let from: string
  let to: string
  try {
    from = canonicalIsoTimestamp(input.from)
    to = canonicalIsoTimestamp(input.to)
  } catch {
    throw new RelayDtoAdapterError('invalid_input')
  }
  const startTimestamp = Math.floor(Date.parse(from) / 1000)
  const endTimestamp = Math.floor(Date.parse(to) / 1000)
  if (
    startTimestamp < 1 ||
    endTimestamp < startTimestamp ||
    endTimestamp - startTimestamp > MAX_USAGE_RANGE_SECONDS
  ) {
    throw new RelayDtoAdapterError('invalid_input')
  }
  return { from, to, startTimestamp, endTimestamp }
}

export function toRemoteRelayUsage(
  range: Pick<NormalizedRelayUsageRange, 'from' | 'to'>,
  usage: RelayDesktopUsageV1Dto
): RemoteRelayUsageDto {
  const requests = safeSum(usage.records.map((record) => record.count))
  const quota = safeSum(usage.records.map((record) => record.quota))
  const tokenUsed = safeSum(usage.records.map((record) => record.token_used))
  if (
    usage.totals.count !== requests ||
    usage.totals.quota !== quota ||
    usage.totals.token_used !== tokenUsed
  ) {
    throw new RelayDtoAdapterError()
  }
  return {
    range: { from: range.from, to: range.to },
    totals: { requests, quota, tokenUsed },
    records: usage.records.map((record) => ({
      createdAt: unixSecondsToIso(record.created_at, false)!,
      requests: record.count,
      quota: record.quota,
      tokenUsed: record.token_used,
      modelName: record.model_name || '未提供模型'
    }))
  }
}

export function toRemoteRelayPricing(value: RelayPricingDto): RemoteRelayPricingDto {
  return {
    models: value.data.map((model) => ({
      modelName: model.model_name,
      description: model.description ?? null,
      owner: model.owner_by,
      quotaType: model.quota_type,
      modelRatio: model.model_ratio,
      modelPrice: model.model_price,
      completionRatio: model.completion_ratio,
      cacheRatio: model.cache_ratio ?? null,
      imageRatio: model.image_ratio ?? null,
      enabledGroups: [...model.enable_groups],
      endpointTypes: [...model.supported_endpoint_types],
      billingMode: model.billing_mode ?? null
    })),
    groupRatios: { ...(value.group_ratio ?? {}) },
    pricingVersion: value.pricing_version ?? null
  }
}

function optionalNonNegativeInteger(value: number | undefined): number | null {
  if (value === undefined) return null
  if (!Number.isSafeInteger(value) || value < 0) throw new RelayDtoAdapterError()
  return value
}

function safeSum(values: readonly number[]): number {
  let total = 0
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(total + value)) {
      throw new RelayDtoAdapterError()
    }
    total += value
  }
  return total
}

function unixSecondsToIso(value: number | undefined, allowUnset: boolean): string | null {
  if (value === undefined || (allowUnset && value <= 0)) return null
  if (!Number.isSafeInteger(value) || value < 0) throw new RelayDtoAdapterError()
  try {
    return canonicalIsoTimestamp(new Date(value * 1000).toISOString())
  } catch {
    throw new RelayDtoAdapterError()
  }
}

function canonicalIsoTimestamp(value: string): string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 32) {
    throw new RelayDtoAdapterError()
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new RelayDtoAdapterError()
  const canonical = new Date(timestamp).toISOString()
  if (canonical !== value) throw new RelayDtoAdapterError()
  return canonical
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys<K extends string>(
  value: unknown,
  keys: readonly K[]
): value is Record<K, unknown> {
  if (!isPlainRecord(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
