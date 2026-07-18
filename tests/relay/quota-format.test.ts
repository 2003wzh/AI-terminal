import assert from 'node:assert/strict'
import test from 'node:test'

import { formatQuota } from '../../src/renderer/src/quota-format.ts'
import type { RemoteRelayBillingConfigDto } from '../../src/shared/contracts.ts'

const USD_CONFIG: RemoteRelayBillingConfigDto = {
  quotaPerUnit: 500_000,
  displayInCurrency: true,
  quotaDisplayType: 'USD',
  usdExchangeRate: 7.3,
  customCurrencySymbol: '¤',
  customCurrencyExchangeRate: 1
}

test('quota formatter matches the website USD conversion and precision', () => {
  assert.equal(formatQuota(14_654_281, USD_CONFIG), '$29.31')
  assert.equal(formatQuota(500_000, USD_CONFIG), '$1')
  assert.equal(formatQuota(183, USD_CONFIG), '$0.0004')
  assert.equal(formatQuota(0, USD_CONFIG), '$0')
})

test('quota formatter applies CNY and custom exchange rates from the validated config', () => {
  assert.equal(formatQuota(14_654_281, {
    ...USD_CONFIG,
    quotaDisplayType: 'CNY'
  }), '¥213.95')
  assert.equal(formatQuota(14_654_281, {
    ...USD_CONFIG,
    quotaDisplayType: 'CUSTOM',
    customCurrencySymbol: '¤',
    customCurrencyExchangeRate: 2
  }), '¤ 58.62')
})

test('token display uses the website compact quota convention', () => {
  const tokens: RemoteRelayBillingConfigDto = {
    ...USD_CONFIG,
    displayInCurrency: false,
    quotaDisplayType: 'TOKENS'
  }
  assert.equal(formatQuota(14_654_281, tokens), '14,654.3k')
  assert.equal(formatQuota(999, tokens), '999')
})

test('quota formatter fails closed without a valid config or raw quota', () => {
  assert.equal(formatQuota(14_654_281, null), '—')
  assert.equal(formatQuota(null, USD_CONFIG), '—')
  assert.equal(formatQuota(-1, USD_CONFIG), '—')
  assert.equal(formatQuota(1, { ...USD_CONFIG, quotaPerUnit: 0 }), '—')
  assert.equal(formatQuota(1, { ...USD_CONFIG, quotaDisplayType: 'TOKENS' }), '—')
  assert.equal(formatQuota(1, {
    ...USD_CONFIG,
    quotaDisplayType: 'CUSTOM',
    customCurrencySymbol: ' symbol-with-whitespace '
  }), '—')
  assert.equal(formatQuota(1, {
    ...USD_CONFIG,
    quotaDisplayType: 'CUSTOM',
    customCurrencySymbol: '币'.repeat(22)
  }), '—')
})
