import { expect, test, type Page } from '@playwright/test'

const centerViews = [
  '账户概览',
  '中转站',
  '访问令牌',
  '用量明细',
  '模型价格',
  '充值兑换',
  '偏好设置',
] as const

async function loadLocalWorkspace(page: Page): Promise<void> {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      await route.continue()
      return
    }
    await route.abort('blockedbyclient')
  })
  await page.goto('/')
}

async function openUserCenter(page: Page, width: number): Promise<void> {
  if (width > 1039) {
    await page.locator('.sidebar-full .account-row').click()
  } else {
    await page.locator('.sidebar-rail').getByRole('button', { name: '用户中心' }).click()
  }
  await expect(page.locator('.user-center-header').getByText('用户中心', { exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: '用户中心导航' })).toBeVisible()
}

async function selectCenterView(page: Page, label: typeof centerViews[number]): Promise<void> {
  const navigation = page.getByRole('navigation', { name: '用户中心导航' })
  const button = navigation.locator(`button[title="${label}"]`)
  await button.click()
  await expect(button).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.user-center-main').getByRole('heading', { level: 1, name: label, exact: true })).toBeVisible()
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  )).toBe(true)
}

test.describe('用户中心安全离线状态', () => {
  test('头像进入、七个页面导航并返回保留工作区状态', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loadLocalWorkspace(page)

    const selectedTask = page.getByRole('treeitem', { name: '接入动态模型目录', exact: true })
    await selectedTask.click()
    await expect(selectedTask).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.mode-segment').getByRole('button', { name: 'Chat' })).toHaveClass(/active/)

    await openUserCenter(page, 1440)
    await selectCenterView(page, '账户概览')
    await expect(page.getByText('当前用户 DPAPI · 原子写入 · 旧明文仅在加密迁移成功后读取', { exact: true })).toBeVisible()
    await expect(page.getByText('已启用', { exact: true })).toBeVisible()
    for (const view of centerViews) await selectCenterView(page, view)

    await page.locator('.uc-back').click()
    await expect(page.locator('.conversation-pane')).toBeVisible()
    await expect(page.getByRole('treeitem', { name: '接入动态模型目录', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.mode-segment').getByRole('button', { name: 'Chat' })).toHaveClass(/active/)
    await expect(page.locator('.titlebar-task')).toContainText('接入动态模型目录')
  })

  test('访问令牌离线状态不伪造凭据或本地变更', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loadLocalWorkspace(page)
    await openUserCenter(page, 1440)
    await selectCenterView(page, '访问令牌')

    await expect(page.getByText('登录后读取令牌列表', { exact: true })).toBeVisible()
    await expect(page.locator('.token-table tbody tr')).toHaveCount(0)
    await page.getByRole('button', { name: '在网站新建' }).click()
    await expect(page.getByText('访问令牌页面只会在 Electron 中经过确认后由系统浏览器打开。', { exact: true })).toBeVisible()
    await expect(page.locator('.masked-token')).toHaveCount(0)
  })

  test('模型价格、兑换与偏好不使用伪造服务端数据', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loadLocalWorkspace(page)
    await openUserCenter(page, 1440)

    await selectCenterView(page, '模型价格')
    await page.getByPlaceholder('搜索模型或能力').fill('__NO_MATCHING_MODEL_E2E__')
    await expect(page.getByText('共 0 个模型', { exact: true })).toBeVisible()
    await expect(page.getByText('尚未读取价格目录', { exact: true })).toBeVisible()

    await selectCenterView(page, '充值兑换')
    const code = page.getByRole('textbox', { name: '兑换码' })
    await code.fill('INVALID-E2E-CODE')
    await page.getByRole('button', { name: '立即兑换' }).click()
    await expect(page.getByText('请先完成中转站设备登录。', { exact: true })).toBeVisible()
    await expect(page.locator('.redeem-section .uc-inline-notice.success')).toHaveCount(0)

    await selectCenterView(page, '偏好设置')
    await expect(page.getByText('余额预警、邮件摘要、显示币种和预算不会在客户端伪造或写入未知字段；请在网站账户设置中管理。', { exact: true })).toBeVisible()
    await expect(page.getByRole('combobox', { name: '显示币种' })).toHaveCount(0)
    const compactTables = page.getByRole('switch', { name: '紧凑数据表' })
    await expect(compactTables).toBeChecked()
    await compactTables.click()
    await expect(compactTables).not.toBeChecked()
    await expect(page.locator('.user-center')).not.toHaveClass(/compact-tables/)
  })

  test('设备码登录轮询后加载真实形状数据并可安全退出', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loadLocalWorkspace(page)
    await page.evaluate(() => {
      let endpointConfirmed = false
      let authenticated = false
      const calls: string[] = []
      const connection = () => ({
        endpoint: 'https://www.wzhxiaozhan.top',
        endpointConsent: {
          status: endpointConfirmed ? 'confirmed' as const : 'required' as const,
          endpointLabel: 'https://www.wzhxiaozhan.top',
        },
        authenticated,
        deviceId: authenticated ? 'device_e2e' : null,
      })
      Object.defineProperty(globalThis, '__relayE2eCalls', { value: calls, configurable: true })
      Object.defineProperty(window, 'onekey', {
        configurable: true,
        value: {
          relay: {
            getConnection: async () => ({ ok: true, value: connection() }),
            connect: async (input: { endpoint: string; confirmation: string }) => {
              calls.push('connect')
              calls.push(`${input.endpoint}:${input.confirmation}`)
              endpointConfirmed = true
              return { ok: true, value: connection() }
            },
            startDeviceAuthorization: async () => {
              calls.push('start')
              return { ok: true, value: {
                sessionId: 'relay-session-e2e',
                userCode: 'E2E-CODE',
                verificationUri: 'https://www.wzhxiaozhan.top/desktop/authorize',
                expiresAt: '2026-07-16T12:00:00.000Z',
                intervalSeconds: 1,
              } }
            },
            openDeviceAuthorization: async (input: { sessionId: string }) => {
              calls.push(`openAuthorization:${input.sessionId}`)
              return { ok: true, value: null }
            },
            pollDeviceAuthorization: async () => {
              calls.push('poll')
              authenticated = true
              return { ok: true, value: { status: 'authenticated' as const, deviceId: 'device_e2e' } }
            },
            signOut: async () => {
              calls.push('signOut')
              authenticated = false
              return { ok: true, value: null }
            },
            getBillingConfig: async () => ({ ok: true, value: {
              quotaPerUnit: 500_000,
              displayInCurrency: true,
              quotaDisplayType: 'USD' as const,
              usdExchangeRate: 7.3,
              customCurrencySymbol: '¤',
              customCurrencyExchangeRate: 1,
            } }),
            getOverview: async () => {
              calls.push('overview')
              return { ok: true, value: {
                account: { id: 7, username: 'e2e', displayName: 'E2E 用户', email: null, group: 'default', status: 1, role: 1 },
                quota: { total: 525, used: 25, remaining: 500 },
                requestCount: 3,
                groups: [{ id: 'default', ratio: 1, description: 'Default' }],
                models: ['gpt-e2e', 'image-e2e'],
                updatedAt: new Date().toISOString(),
              } }
            },
            listTokens: async () => ({ ok: true, value: {
              page: 1,
              pageSize: 100,
              total: 1,
              items: [{
                id: 9,
                name: 'E2E Token',
                maskedKey: 'sk-********',
                status: 'active' as const,
                remainQuota: 100,
                usedQuota: 5,
                unlimitedQuota: false,
                group: 'default',
                modelLimits: 'gpt-e2e',
                createdAt: '2026-07-01T00:00:00.000Z',
                lastUsedAt: null,
                expiresAt: null,
              }],
            } }),
            listUsage: async (input: { from: string; to: string }) => {
              calls.push(Object.keys(input).sort().join(','))
              return { ok: true, value: {
                range: input,
                totals: { requests: 2, quota: 40, tokenUsed: 1200 },
                records: [{ createdAt: new Date().toISOString(), requests: 2, quota: 40, tokenUsed: 1200, modelName: 'gpt-e2e' }],
              } }
            },
            listPricing: async () => ({ ok: true, value: {
              models: [{ modelName: 'gpt-e2e', description: null, owner: 'openai', quotaType: 0, modelRatio: 1, modelPrice: 0, completionRatio: 2, cacheRatio: 0.5, imageRatio: null, enabledGroups: ['default'], endpointTypes: ['openai'], billingMode: 'ratio' }],
              groupRatios: { default: 1 },
              pricingVersion: 'e2e-v1',
            } }),
          },
          link: {
            openExternal: async () => {
              calls.push('openAuthorization')
              return { ok: true, value: null }
            },
          },
        },
      })
    })

    await openUserCenter(page, 1440)
    await page.getByRole('button', { name: '连接并登录' }).click()
    await expect(page.getByText('E2E-CODE', { exact: true })).toBeVisible()
    await expect.poll(async () => page.evaluate(() => (
      globalThis as typeof globalThis & { __relayE2eCalls: string[] }
    ).__relayE2eCalls.filter((entry) => entry.startsWith('openAuthorization:')).length)).toBe(1)
    await page.getByRole('button', { name: '重新打开' }).click()
    await expect(page.getByText('HTTPS 已确认连接', { exact: true })).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('.uc-account-menu')).toContainText('e2e')
    await expect(page.locator('.uc-profile strong')).toHaveText('e2e')
    await expect(page.locator('.relay-identity strong')).toHaveText('wzh-server')
    await expect(page.locator('.metric-strip > div').nth(0).getByText('$0.001', { exact: true })).toBeVisible()
    await expect(page.locator('.metric-strip > div').nth(3).getByText('2', { exact: true })).toBeVisible()

    const calls = await page.evaluate(() => (
      globalThis as typeof globalThis & { __relayE2eCalls: string[] }
    ).__relayE2eCalls)
    expect(calls).toEqual(expect.arrayContaining([
      'connect',
      'https://www.wzhxiaozhan.top:connect',
      'start',
      'openAuthorization:relay-session-e2e',
      'poll',
      'overview',
      'from,to',
    ]))
    expect(calls).not.toContain('openAuthorization')

    await page.getByRole('button', { name: '退出账户' }).click()
    await expect(page.getByText('本机中转站登录凭据已使用 DPAPI 加密 tombstone 清除。', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '连接并登录' })).toBeVisible()
  })

  test('已登录后的局部读取失败不会覆盖其他用户中心数据', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loadLocalWorkspace(page)
    await page.evaluate(() => {
      let usageCalls = 0
      Object.defineProperty(window, 'onekey', {
        configurable: true,
        value: {
          relay: {
            getConnection: async () => ({ ok: true, value: {
              endpoint: 'https://www.wzhxiaozhan.top',
              endpointConsent: { status: 'confirmed' as const, endpointLabel: 'https://www.wzhxiaozhan.top' },
              authenticated: true,
              deviceId: 'device_partial_e2e',
            } }),
            getBillingConfig: async () => ({ ok: true, value: {
              quotaPerUnit: 500_000,
              displayInCurrency: true,
              quotaDisplayType: 'USD' as const,
              usdExchangeRate: 7.3,
              customCurrencySymbol: '¤',
              customCurrencyExchangeRate: 1,
            } }),
            getOverview: async () => ({ ok: true, value: {
              account: { id: 7, username: 'e2e', displayName: '局部成功用户', email: null, group: 'default', status: 1, role: 1 },
              quota: { total: 525, used: 25, remaining: 500 },
              requestCount: 3,
              groups: [{ id: 'default', ratio: 1, description: 'Default' }],
              models: ['gpt-e2e'],
              updatedAt: new Date().toISOString(),
            } }),
            listTokens: async () => {
              throw new Error('private rejected promise marker')
            },
            listUsage: async (input: { from: string; to: string }) => {
              usageCalls += 1
              if (usageCalls === 1) {
                return {
                  ok: false as const,
                  error: { code: 'runtime_error' as const, message: '用量响应未通过安全校验。', retryable: false },
                }
              }
              return { ok: true as const, value: {
                range: input,
                totals: { requests: 1, quota: 20, tokenUsed: 600 },
                records: [{
                  createdAt: new Date().toISOString(),
                  requests: 1,
                  quota: 20,
                  tokenUsed: 600,
                  modelName: 'gpt-retry-e2e',
                }],
              } }
            },
            listPricing: async () => ({ ok: true, value: {
              models: [{ modelName: 'gpt-e2e', description: null, owner: 'openai', quotaType: 0, modelRatio: 1, modelPrice: 0, completionRatio: 2, cacheRatio: null, imageRatio: null, enabledGroups: ['default'], endpointTypes: ['openai'], billingMode: 'ratio' }],
              groupRatios: { default: 1 },
              pricingVersion: 'partial-e2e-v1',
            } }),
          },
        },
      })
    })

    await openUserCenter(page, 1440)
    await expect(page.getByText('HTTPS 已确认连接', { exact: true })).toBeVisible()
    await expect(page.locator('.metric-strip > div').nth(0).getByText('$0.001', { exact: true })).toBeVisible()
    await expect(page.getByText('用量明细：用量响应未通过安全校验。', { exact: true })).toBeVisible()
    await expect(page.getByText('访问令牌：访问令牌读取失败，请重试。', { exact: true })).toBeVisible()
    await expect(page.getByText('private rejected promise marker')).toHaveCount(0)

    await selectCenterView(page, '用量明细')
    await expect(page.getByText('用量明细：用量响应未通过安全校验。', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '近 7 天' }).click()
    await expect(page.locator('.usage-table tbody').getByText('gpt-retry-e2e', { exact: true })).toBeVisible()
    await expect(page.getByText('用量明细：用量响应未通过安全校验。', { exact: true })).toHaveCount(0)

    await selectCenterView(page, '访问令牌')
    await expect(page.getByText('访问令牌：访问令牌读取失败，请重试。', { exact: true })).toBeVisible()
    await selectCenterView(page, '模型价格')
    await expect(page.getByText('gpt-e2e', { exact: true })).toBeVisible()
    await expect(page.getByText('模型价格：', { exact: false })).toHaveCount(0)
  })

  test('账户摘要与价格错误独立显示且不清空令牌和用量', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loadLocalWorkspace(page)
    await page.evaluate(() => {
      Object.defineProperty(window, 'onekey', {
        configurable: true,
        value: {
          relay: {
            getConnection: async () => ({ ok: true, value: {
              endpoint: 'https://www.wzhxiaozhan.top',
              endpointConsent: { status: 'confirmed' as const, endpointLabel: 'https://www.wzhxiaozhan.top' },
              authenticated: true,
              deviceId: 'device_split_errors_e2e',
            } }),
            getBillingConfig: async () => ({ ok: true, value: {
              quotaPerUnit: 500_000,
              displayInCurrency: true,
              quotaDisplayType: 'USD' as const,
              usdExchangeRate: 7.3,
              customCurrencySymbol: '¤',
              customCurrencyExchangeRate: 1,
            } }),
            getOverview: async () => ({
              ok: false,
              error: { code: 'runtime_error' as const, message: '账户摘要版本不受支持。', retryable: false },
            }),
            listTokens: async () => ({ ok: true, value: {
              page: 1,
              pageSize: 100,
              total: 1,
              items: [{
                id: 12,
                name: 'Split Error Token',
                maskedKey: 'sk-********',
                status: 'active' as const,
                remainQuota: 80,
                usedQuota: 20,
                unlimitedQuota: false,
                group: 'default',
                modelLimits: null,
                createdAt: null,
                lastUsedAt: null,
                expiresAt: null,
              }],
            } }),
            listUsage: async (input: { from: string; to: string }) => ({ ok: true, value: {
              range: input,
              totals: { requests: 4, quota: 40, tokenUsed: 900 },
              records: [{
                createdAt: new Date().toISOString(),
                requests: 4,
                quota: 40,
                tokenUsed: 900,
                modelName: 'gpt-usage-success',
              }],
            } }),
            listPricing: async () => {
              throw new Error('private pricing rejection marker')
            },
          },
        },
      })
    })

    await openUserCenter(page, 1440)
    await expect(page.getByText('账户摘要：账户摘要版本不受支持。', { exact: true })).toBeVisible()
    await expect(page.getByText('模型价格：模型价格读取失败，请重试。', { exact: true })).toBeVisible()
    await expect(page.getByText('private pricing rejection marker')).toHaveCount(0)
    await expect(page.getByText('访问令牌：', { exact: false })).toHaveCount(0)
    await expect(page.getByText('用量明细：', { exact: false })).toHaveCount(0)

    await selectCenterView(page, '访问令牌')
    await expect(page.getByText('Split Error Token', { exact: true })).toBeVisible()
    await selectCenterView(page, '用量明细')
    await expect(page.locator('.usage-table tbody').getByText('gpt-usage-success', { exact: true })).toBeVisible()
    await selectCenterView(page, '模型价格')
    await expect(page.getByText('模型价格：模型价格读取失败，请重试。', { exact: true })).toBeVisible()
  })

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 940, height: 760 },
  ]) {
    test(`${viewport.width}px 用户中心各页面无横向溢出`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await loadLocalWorkspace(page)
      await openUserCenter(page, viewport.width)

      for (const view of centerViews) {
        await selectCenterView(page, view)
        await expectNoHorizontalOverflow(page)
      }
    })
  }
})
