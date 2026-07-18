import type { RemoteRelayBillingConfigDto } from '../../shared/contracts'

const UNAVAILABLE_QUOTA = '—'

export function formatQuota(
  rawQuota: number | null | undefined,
  config: RemoteRelayBillingConfigDto | null | undefined,
): string {
  if (!Number.isSafeInteger(rawQuota) || Number(rawQuota) < 0 || !isValidBillingConfig(config)) {
    return UNAVAILABLE_QUOTA
  }

  if (config.quotaDisplayType === 'TOKENS') {
    return formatTokenQuota(Number(rawQuota))
  }

  let amount = Number(rawQuota) / config.quotaPerUnit
  if (config.quotaDisplayType === 'CNY') amount *= config.usdExchangeRate
  if (config.quotaDisplayType === 'CUSTOM') amount *= config.customCurrencyExchangeRate
  if (!Number.isFinite(amount)) return UNAVAILABLE_QUOTA

  const maximumFractionDigits = Math.abs(amount) >= 1 ? 2 : 4
  if (config.quotaDisplayType === 'CUSTOM') {
    return `${config.customCurrencySymbol} ${formatAmount(amount, maximumFractionDigits)}`
  }

  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: config.quotaDisplayType,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(amount)
}

function formatTokenQuota(value: number): string {
  if (Math.abs(value) >= 1_000) {
    return `${new Intl.NumberFormat('zh-CN', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
    }).format(value / 1_000)}k`
  }
  return formatAmount(value, Math.abs(value) >= 1 ? 0 : 4)
}

function formatAmount(value: number, maximumFractionDigits: number): string {
  return new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(value)
}

function isValidBillingConfig(
  value: RemoteRelayBillingConfigDto | null | undefined,
): value is RemoteRelayBillingConfigDto {
  if (!value) return false
  if (
    value.quotaDisplayType !== 'USD'
    && value.quotaDisplayType !== 'CNY'
    && value.quotaDisplayType !== 'TOKENS'
    && value.quotaDisplayType !== 'CUSTOM'
  ) return false
  const expectedCurrencyFlag = value.quotaDisplayType !== 'TOKENS'
  return Number.isFinite(value.quotaPerUnit)
    && value.quotaPerUnit > 0
    && value.quotaPerUnit <= Number.MAX_SAFE_INTEGER
    && Number.isFinite(value.usdExchangeRate)
    && value.usdExchangeRate > 0
    && value.usdExchangeRate <= Number.MAX_SAFE_INTEGER
    && Number.isFinite(value.customCurrencyExchangeRate)
    && value.customCurrencyExchangeRate > 0
    && value.customCurrencyExchangeRate <= Number.MAX_SAFE_INTEGER
    && Number.isFinite(value.usdExchangeRate / value.quotaPerUnit)
    && value.usdExchangeRate / value.quotaPerUnit > 0
    && Number.isFinite(value.customCurrencyExchangeRate / value.quotaPerUnit)
    && value.customCurrencyExchangeRate / value.quotaPerUnit > 0
    && value.customCurrencySymbol.length >= 1
    && value.customCurrencySymbol.length <= 64
    && new TextEncoder().encode(value.customCurrencySymbol).byteLength <= 64
    && value.customCurrencySymbol === value.customCurrencySymbol.trim()
    && value.displayInCurrency === expectedCurrencyFlag
}
