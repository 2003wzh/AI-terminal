import { expect, test, type Page } from '@playwright/test'

type AuthScenario = 'locked' | 'restored' | 'restored-delayed' | 'device' | 'device-history' | 'denied' | 'open-fails-once' | 'signed-in'

async function installAuthHarness(page: Page, scenario: AuthScenario): Promise<void> {
  await page.addInitScript((selectedScenario) => {
    const calls: string[] = []
    const hasRestoredHistory = selectedScenario === 'restored'
      || selectedScenario === 'restored-delayed'
      || selectedScenario === 'device-history'
    const bootstrapResolvers: Array<() => void> = []
    let authenticated = selectedScenario === 'restored-delayed' || selectedScenario === 'signed-in'
    let endpointConfirmed = authenticated
    let openAttempts = 0
    const workspaceToken = `ws_${'a'.repeat(43)}`
    const initDraftHandle = `draft_${'b'.repeat(43)}`
    const reviewHandle = `review_${'r'.repeat(43)}`

    const connection = () => ({
      endpoint: 'https://www.wzhxiaozhan.top',
      endpointConsent: {
        status: endpointConfirmed ? 'confirmed' as const : 'required' as const,
        endpointLabel: 'https://www.wzhxiaozhan.top',
      },
      authenticated,
      deviceId: authenticated ? 'device_auth_gate_e2e' : null,
    })

    const success = <T,>(value: T) => ({ ok: true as const, value })
    const restoredTask = {
      id: 'task:11111111-1111-4111-8111-111111111111',
      projectId: 'project:local-history',
      title: '恢复的本机任务',
      mode: 'chat' as const,
      updatedAt: '2026-07-17T08:00:00.000Z',
      status: 'idle' as const,
    }
    const bootstrap = {
      schemaVersion: 1,
      app: { name: 'AI终点站', version: '0.1.0', platform: 'win32' as const, preview: false },
      runtime: { status: 'ready' as const, protocolVersion: 1, message: 'Auth gate E2E runtime.' },
      security: {
        rendererHasNodeAccess: false as const,
        rendererNetworkAccess: false as const,
        secretsExposedToRenderer: false as const,
        endpointConsentRequired: true,
        localToolConsentRequired: true,
      },
      defaults: {
        mode: 'agent' as const,
        approvalMode: 'request' as const,
        reasoning: 'auto' as const,
        webSearch: false,
        imageGeneration: false,
        activeProfileHandle: 'relay:wzh-server',
        activeModelId: '',
      },
      profiles: [{
        credentialHandle: 'relay:wzh-server',
        name: 'wzh-server',
        description: '账户会话',
        baseUrl: 'https://www.wzhxiaozhan.top/v1',
        hasKey: true,
        isCurrent: true,
        targets: ['codex' as const],
      }],
      models: [],
      projects: hasRestoredHistory ? [{
        id: 'project:local-history',
        name: '本地历史',
        tasks: [restoredTask],
      }] : [],
      activeTaskId: hasRestoredHistory ? restoredTask.id : '',
    }

    Object.defineProperty(globalThis, '__authGateE2eCalls', {
      value: calls,
      configurable: true,
    })
    Object.defineProperty(globalThis, '__resolveAuthGateBootstrap', {
      value: () => {
        for (const resolve of bootstrapResolvers.splice(0)) resolve()
      },
      configurable: true,
    })
    Object.defineProperty(window, 'onekey', {
      configurable: true,
      value: {
        app: {
          getBootstrap: async () => {
            calls.push('bootstrap')
            if (selectedScenario === 'restored-delayed') {
              await new Promise<void>((resolve) => bootstrapResolvers.push(resolve))
            }
            return success(bootstrap)
          },
        },
        models: {
          list: async (input: { profileHandle: string; mode: 'chat' | 'agent'; groupId: string | null }) => {
            calls.push(`models:${input.profileHandle}:${input.mode}:${input.groupId ?? 'direct'}`)
            return success([
              {
                id: input.groupId === 'vip' ? 'gpt-5.6-sol-vip' : 'gpt-5.6-sol-standard',
                label: input.groupId === 'vip' ? 'gpt-5.6-sol-vip' : 'gpt-5.6-sol-standard',
                provider: 'openai-compatible' as const,
                wireMode: 'standard' as const,
                modes: ['chat' as const, 'agent' as const],
                reasoning: ['auto' as const, 'high' as const, 'ultra' as const],
                capabilities: {
                  attachments: false,
                  imageInput: false,
                  imageGeneration: true,
                  subagents: false,
                  toolUse: false,
                  webSearch: true,
                },
                declaredCapabilities: { imageGeneration: true, webSearch: true },
                source: 'remote' as const,
              },
              {
                id: 'gpt-5.6-terra',
                label: 'gpt-5.6-terra',
                provider: 'openai-compatible' as const,
                wireMode: 'lite' as const,
                modes: ['chat' as const, 'agent' as const],
                reasoning: ['auto' as const, 'high' as const],
                capabilities: {
                  attachments: false,
                  imageInput: false,
                  imageGeneration: false,
                  subagents: false,
                  toolUse: false,
                  webSearch: false,
                },
                declaredCapabilities: {},
                source: 'remote' as const,
              },
            ])
          },
        },
        capabilities: {
          list: async (input?: { category?: 'skills' | 'plugins'; workspaceToken?: string }) => {
            calls.push(input?.category ? `capabilities:${input.category}` : 'capabilities:default')
            return success({
              commands: selectedScenario === 'signed-in' ? [
                {
                  id: 'init' as const,
                  name: '/init',
                  description: '生成 AGENTS.md 项目规则草稿',
                  aliases: ['setup'],
                  scope: 'builtin' as const,
                  permissions: ['read' as const, 'write' as const, 'approval' as const],
                  safe: false,
                  availability: 'requires-approval' as const,
                },
                {
                  id: 'review' as const,
                  name: '/review',
                  description: '审查当前 Git 改动',
                  aliases: ['audit'],
                  scope: 'builtin' as const,
                  permissions: ['read' as const, 'execute' as const, 'approval' as const],
                  safe: false,
                  availability: 'requires-approval' as const,
                },
              ] : [],
              skills: [],
              plugins: [],
              session: { planMode: false, memoriesEnabled: true },
            })
          },
          execute: async (input: {
            id: string
            workspaceToken?: string
            draftHandle?: string
            projectInitAction?: 'commit' | 'discard'
            content?: string
          }) => {
            calls.push(`execute:${input.id}:${input.workspaceToken ?? 'none'}:${input.draftHandle ? 'draft' : 'prepare'}`)
            if (input.id === 'review' && input.workspaceToken === workspaceToken) {
              calls.push('review:armed')
              return success({
                id: 'review',
                status: 'preview' as const,
                message: 'Code review is armed for the next Agent turn.',
                reviewHandle,
                session: { planMode: false, memoriesEnabled: true },
              })
            }
            if (input.id === 'init' && input.workspaceToken === workspaceToken) {
              if (
                input.draftHandle === initDraftHandle &&
                input.projectInitAction === 'discard' &&
                input.content === undefined
              ) {
                calls.push('init:discard:handle-only')
                return success({
                  id: 'init',
                  status: 'completed' as const,
                  message: 'The AGENTS.md draft authorization was discarded.',
                })
              }
              if (
                input.draftHandle === initDraftHandle &&
                input.projectInitAction === 'commit' &&
                input.content === undefined
              ) {
                calls.push('init:commit:handle-only')
                return success({
                  id: 'init',
                  status: 'completed' as const,
                  message: 'AGENTS.md was atomically created from the approved draft.',
                  projectInit: {
                    state: 'committed' as const,
                    relativePath: 'AGENTS.md' as const,
                    revision: 'c'.repeat(64),
                    replaced: false,
                  },
                })
              }
              calls.push('init:preview')
              return success({
                id: 'init',
                status: 'preview' as const,
                message: 'AGENTS.md draft is ready for review. No file was changed.',
                projectInit: {
                  state: 'preview' as const,
                  draftHandle: initDraftHandle,
                  relativePath: 'AGENTS.md' as const,
                  content: '# AGENTS.md\n\n## Working rules\n\n- Keep changes scoped.\n',
                  contentSha256: 'd'.repeat(64),
                  target: 'create' as const,
                  expiresAt: Date.now() + 60_000,
                },
              })
            }
            return success({
              id: input.id,
              status: 'not-ready' as const,
              message: 'Capability unavailable in the auth harness.',
              session: { planMode: false, memoriesEnabled: true },
            })
          },
        },
        dialog: {
          selectWorkspace: async () => success({ workspaceToken, displayName: 'E2E workspace' }),
          selectAttachments: async () => success([]),
        },
        workspace: {
          listOpeners: async () => success({ openers: [], launchToken: `wl_${'e'.repeat(43)}` }),
          open: async () => success({ openerId: 'explorer' as const }),
        },
        window: {
          minimize: async () => success(null),
          toggleMaximize: async () => success(null),
          close: async () => success(null),
        },
        conversation: {
          create: async (input: { title?: string; mode: 'chat' | 'agent'; workspaceToken?: string }) => {
            calls.push(`conversation:create:${input.mode}:${input.workspaceToken ?? 'none'}`)
            return success({
              id: 'task:22222222-2222-4222-8222-222222222222',
              projectId: 'project:local-history',
              title: input.title ?? 'Review task',
              mode: input.mode,
              updatedAt: '2026-07-18T08:00:00.000Z',
              status: 'idle' as const,
            })
          },
          load: async (input: { taskId: string }) => {
            calls.push(`load:${input.taskId}`)
            return success({
              task: restoredTask,
              messages: [{
                id: 'message:restored',
                role: 'assistant' as const,
                content: '本机加密历史已恢复。',
                status: 'complete' as const,
                createdAt: '2026-07-17T08:00:00.000Z',
                updatedAt: '2026-07-17T08:00:00.000Z',
              }],
              events: [],
            })
          },
        },
        turn: {
          start: async (input: {
            mode: 'chat' | 'agent'
            prompt: string
            modelId: string
            workspaceToken?: string
            reviewHandle?: string
            attachmentTokens: string[]
            webSearch: boolean
            imageGeneration: boolean
          }) => {
            calls.push(`turn:start:${input.mode}:${input.prompt}:${input.workspaceToken ?? 'none'}:${input.attachmentTokens.length}`)
            calls.push(`turn:hosted:${input.modelId}:${Number(input.webSearch)}:${Number(input.imageGeneration)}`)
            if (Object.hasOwn(input, 'wireMode')) calls.push('turn:renderer-wire-mode')
            if (input.reviewHandle) calls.push(`turn:review-handle:${input.reviewHandle}`)
            return success({ turnId: `turn_${'f'.repeat(32)}` })
          },
          cancel: async () => success(null),
        },
        relay: {
          getConnection: async () => {
            calls.push(`connection:${authenticated ? 'in' : 'out'}`)
            return success(connection())
          },
          connect: async (input: { endpoint: string; confirmation: string }) => {
            calls.push(`connect:${input.endpoint}:${input.confirmation}`)
            endpointConfirmed = true
            if (selectedScenario === 'restored') authenticated = true
            return success(connection())
          },
          startDeviceAuthorization: async () => {
            calls.push('start')
            return success({
              sessionId: 'relay-session-auth-gate-e2e',
              userCode: 'GATE-E2E',
              verificationUri: 'https://www.wzhxiaozhan.top/desktop/authorize',
              expiresAt: '2026-07-17T12:00:00.000Z',
              intervalSeconds: 1,
            })
          },
          openDeviceAuthorization: async (input: { sessionId: string }) => {
            calls.push(`open:${input.sessionId}`)
            openAttempts += 1
            if (selectedScenario === 'open-fails-once' && openAttempts === 1) {
              return {
                ok: false as const,
                error: { code: 'runtime_error' as const, message: '无法打开授权页。', retryable: true },
              }
            }
            return success(null)
          },
          pollDeviceAuthorization: async () => {
            calls.push('poll')
            if (selectedScenario === 'denied') return success({ status: 'denied' as const })
            if (selectedScenario === 'open-fails-once') {
              return success({ status: 'pending' as const, retryAfterSeconds: 1 })
            }
            authenticated = true
            return success({ status: 'authenticated' as const, deviceId: 'device_auth_gate_e2e' })
          },
          signOut: async () => {
            calls.push('signOut')
            authenticated = false
            return success(null)
          },
          getBillingConfig: async () => success({
            quotaPerUnit: 500_000,
            displayInCurrency: true,
            quotaDisplayType: 'USD' as const,
            usdExchangeRate: 7.3,
            customCurrencySymbol: '¤',
            customCurrencyExchangeRate: 1,
          }),
          getOverview: async () => {
            calls.push('overview')
            return success({
              account: { id: 7, username: 'demo-user', displayName: 'Profile Alias', email: null, group: 'default', status: 1, role: 1 },
              quota: { total: 100, used: 5, remaining: 95 },
              requestCount: 1,
              groups: [
                { id: 'default', ratio: 1, description: '默认分组' },
                { id: 'vip', ratio: 1.5, description: '高优先级分组' },
              ],
              models: [],
              updatedAt: new Date().toISOString(),
            })
          },
          listTokens: async () => success({ page: 1, pageSize: 100, total: 0, items: [] }),
          listUsage: async (input: { from: string; to: string }) => success({
            range: input,
            totals: { requests: 0, quota: 0, tokenUsed: 0 },
            records: [],
          }),
          listPricing: async () => success({ models: [], groupRatios: {}, pricingVersion: null }),
        },
        link: {
          openExternal: async () => {
            calls.push('openExternal')
            return success(null)
          },
        },
        onAgentEvent: () => {
          calls.push('subscribe')
          return () => calls.push('unsubscribe')
        },
      },
    })
  }, scenario)
}

async function authCalls(page: Page): Promise<string[]> {
  return page.evaluate(() => [...((globalThis as typeof globalThis & { __authGateE2eCalls?: string[] }).__authGateE2eCalls ?? [])])
}

test('未登录时只挂载登录门禁，不初始化工作台', async ({ page }) => {
  await page.setViewportSize({ width: 940, height: 700 })
  await installAuthHarness(page, 'locked')
  await page.goto('/')

  await expect(page.getByRole('heading', { name: '登录后继续工作' })).toBeVisible()
  await expect(page.getByText('https://www.wzhxiaozhan.top', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '登录并进入工作台' })).toBeVisible()
  await expect(page.locator('.app-shell')).toHaveCount(0)
  await expect(page.locator('.conversation-pane')).toHaveCount(0)
  await expect(page.locator('.composer')).toHaveCount(0)
  await expect(page.locator('.task-sidebar')).toHaveCount(0)
  expect(await authCalls(page)).not.toContain('bootstrap')
  expect(await authCalls(page)).not.toContain('subscribe')
  const geometry = await page.evaluate(() => {
    const login = document.querySelector<HTMLElement>('.auth-login')!.getBoundingClientRect()
    const workbench = document.querySelector<HTMLElement>('.auth-workbench')!.getBoundingClientRect()
    return {
      loginLeft: login.left,
      workbenchRight: workbench.right,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    }
  })
  expect(geometry.loginLeft).toBeGreaterThanOrEqual(0)
  expect(geometry.workbenchRight).toBeLessThanOrEqual(geometry.viewportWidth)
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth)
})

test('未登录时不存在本地解锁旁路', async ({ page }) => {
  await installAuthHarness(page, 'locked')
  await page.goto('/')

  await expect(page.getByRole('button', { name: '使用 API Key 进入工作台' })).toHaveCount(0)
  await expect(page.locator('.auth-gate')).toBeVisible()
  await expect(page.locator('.app-shell')).toHaveCount(0)
  expect(await page.evaluate(() => 'session' in window.onekey)).toBe(false)
  expect(await authCalls(page)).not.toContain('bootstrap')
})

test('设备码授权成功后自动进入工作台', async ({ page }) => {
  await installAuthHarness(page, 'device')
  await page.goto('/')

  await page.getByRole('button', { name: '登录并进入工作台' }).click()
  await expect(page.getByText('GATE-E2E', { exact: true })).toBeVisible()
  await expect.poll(async () => (await authCalls(page)).filter((entry) => entry.startsWith('open:')).length).toBe(1)
  await page.getByRole('button', { name: '重新打开授权页' }).click()
  await expect.poll(async () => (await authCalls(page)).filter((entry) => entry.startsWith('open:')).length).toBe(2)
  await expect(page.locator('.app-shell')).toBeVisible({ timeout: 5_000 })
  await expect(page.locator('.sidebar-full .account-copy strong')).toHaveText('demo-user')
  await expect(page.locator('.sidebar-full .account-copy small')).toHaveText('账户已登录 · 模型已连接')
  await expect(page.locator('.conversation-pane')).toBeVisible()
  await expect(page.locator('.auth-gate')).toHaveCount(0)

  const calls = await authCalls(page)
  const connectCall = 'connect:https://www.wzhxiaozhan.top:connect'
  const openCall = 'open:relay-session-auth-gate-e2e'
  expect(calls).toContain(connectCall)
  expect(calls).toContain('start')
  expect(calls).toContain(openCall)
  expect(calls).toContain('poll')
  expect(calls).toContain('bootstrap')
  expect(calls).toContain('overview')
  expect(calls).toContain('models:relay:wzh-server:agent:default')
  expect(calls).not.toContain('openExternal')
  expect(calls.indexOf(connectCall)).toBeLessThan(calls.indexOf('start'))
  expect(calls.indexOf('start')).toBeLessThan(calls.indexOf(openCall))
  expect(calls.indexOf(openCall)).toBeLessThan(calls.indexOf('poll'))
  expect(calls.indexOf('poll')).toBeLessThan(calls.indexOf('bootstrap'))
})

test('接入分组在 Agent 与 Chat 间共享并刷新对应模型目录', async ({ page }) => {
  await installAuthHarness(page, 'signed-in')
  await page.goto('/')

  await expect(page.locator('.app-shell')).toBeVisible()
  await expect.poll(async () => (await authCalls(page)).includes('capabilities:default')).toBe(true)
  expect((await authCalls(page)).some((entry) => entry === 'capabilities:skills' || entry === 'capabilities:plugins')).toBe(false)
  const groupButton = page.getByRole('button', { name: '接入分组：default' })
  await expect(groupButton).toBeVisible()
  await groupButton.click()
  await page.getByRole('menuitemradio', { name: /vip/ }).click()
  await expect(page.getByRole('button', { name: '接入分组：vip' })).toBeVisible()
  await expect.poll(async () => (await authCalls(page)).includes('models:relay:wzh-server:agent:vip')).toBe(true)
  await expect(page.locator('.model-button')).toContainText('5.6-sol-vip')

  await page.locator('.mode-segment').getByRole('button', { name: 'Chat' }).click()
  await expect(page.getByRole('button', { name: '接入分组：vip' })).toBeVisible()
  await expect.poll(async () => (await authCalls(page)).includes('models:relay:wzh-server:chat:vip')).toBe(true)
})

test('Responses Lite 明确关闭并禁用托管联网与图片生成', async ({ page }) => {
  await installAuthHarness(page, 'signed-in')
  await page.goto('/')

  await expect(page.locator('.app-shell')).toBeVisible()
  await page.locator('.mode-segment').getByRole('button', { name: 'Chat' }).click()
  await expect.poll(async () => (await authCalls(page)).includes('models:relay:wzh-server:chat:default')).toBe(true)
  await expect(page.locator('.model-button')).toContainText('5.6-sol-standard')

  await expect(page.getByRole('button', { name: '关闭联网' })).toBeEnabled()
  await page.getByRole('button', { name: '开启图片生成' }).click()
  await expect(page.getByRole('button', { name: '关闭图片生成' })).toBeEnabled()

  await page.locator('.model-button').click()
  await page.getByRole('button', { name: /gpt-5\.6-terra/u }).click()

  const compatibilityNotice = page.locator('.model-compatibility-notice')
  await expect(compatibilityNotice).toContainText('当前模型使用 Responses Lite')
  await expect(compatibilityNotice).toContainText('切换到支持它们的标准模型')
  const webButton = page.getByRole('button', { name: '当前模型不支持联网搜索' })
  const imageButton = page.getByRole('button', { name: '当前模型不支持图片生成' })
  await expect(webButton).toBeDisabled()
  await expect(imageButton).toBeDisabled()
  await expect(webButton).toHaveAttribute('aria-pressed', 'false')
  await expect(imageButton).toHaveAttribute('aria-pressed', 'false')

  const prompt = '验证 Lite 能力边界'
  await page.getByRole('textbox', { name: '消息' }).fill(prompt)
  await page.getByRole('button', { name: '发送' }).click()
  await expect.poll(async () => (await authCalls(page)).includes(
    'turn:hosted:gpt-5.6-terra:0:0'
  )).toBe(true)
  expect(await authCalls(page)).not.toContain('turn:renderer-wire-mode')
})

test('/init 预览只用一次性句柄提交固定 AGENTS.md 草稿', async ({ page }) => {
  await page.setViewportSize({ width: 940, height: 700 })
  await installAuthHarness(page, 'signed-in')
  await page.goto('/')

  await page.getByRole('button', { name: '选择工作区' }).click()
  await expect(page.getByTitle('E2E workspace')).toBeVisible()
  const input = page.getByRole('textbox', { name: '消息' })
  await input.fill('/init')
  await page.getByRole('listbox', { name: '命令选择' }).getByRole('option', { name: /初始化项目/u }).click()
  await input.press('Enter')
  await expect.poll(async () => (await authCalls(page)).filter((entry) => entry.startsWith('execute:'))).toEqual([
    `execute:init:ws_${'a'.repeat(43)}:prepare`,
  ])

  const preview = page.getByRole('dialog', { name: '预览 AGENTS.md' })
  await expect(preview).toBeVisible()
  await expect(preview.locator('.init-preview-content')).toContainText('# AGENTS.md')
  await expect(preview.locator('.init-preview-content')).toContainText('Keep changes scoped.')
  await expect(preview).toContainText('新建文件')
  await preview.getByRole('button', { name: '写入此草稿' }).click()

  await expect(preview).toHaveCount(0)
  await expect(input).toBeFocused()
  await expect(page.locator('.capability-state-message')).toContainText('atomically created')
  const calls = await authCalls(page)
  expect(calls.filter((entry) => entry === 'init:preview')).toHaveLength(1)
  expect(calls.filter((entry) => entry === 'init:commit:handle-only')).toHaveLength(1)
})

test('/init 取消会销毁单个草稿并恢复焦点', async ({ page }) => {
  await page.setViewportSize({ width: 940, height: 700 })
  await installAuthHarness(page, 'signed-in')
  await page.goto('/')

  await page.getByRole('button', { name: '选择工作区' }).click()
  const input = page.getByRole('textbox', { name: '消息' })
  await input.fill('/init')
  await page.getByRole('listbox', { name: '命令选择' }).getByRole('option', { name: /初始化项目/u }).click()
  await input.press('Enter')

  const preview = page.getByRole('dialog', { name: '预览 AGENTS.md' })
  await expect(preview).toBeVisible()
  const close = preview.getByRole('button', { name: '关闭草稿预览' })
  const commit = preview.getByRole('button', { name: '写入此草稿' })

  await commit.focus()
  await commit.press('Tab')
  await expect(close).toBeFocused()
  await close.press('Shift+Tab')
  await expect(commit).toBeFocused()

  await preview.locator('.init-preview-content').focus()
  await preview.locator('.init-preview-content').press('Escape')
  await expect(preview).toHaveCount(0)
  await expect(input).toBeFocused()
  await expect.poll(async () => (await authCalls(page)).filter((entry) => entry === 'init:discard:handle-only')).toHaveLength(1)
  expect((await authCalls(page)).filter((entry) => entry === 'init:commit:handle-only')).toHaveLength(0)
})

test('/review 绑定后立即以只读 Agent 轮次发送而不会落入 Chat', async ({ page }) => {
  await installAuthHarness(page, 'signed-in')
  await page.goto('/')

  await page.getByRole('button', { name: '选择工作区' }).click()
  await page.locator('.mode-segment').getByRole('button', { name: 'Chat' }).click()
  const input = page.getByRole('textbox', { name: '消息' })
  await input.fill('/review')
  await page.getByRole('listbox', { name: '命令选择' }).getByRole('option', { name: /代码审查/u }).click()
  await Promise.all([input.press('Enter'), input.press('Enter')])

  await expect.poll(async () => (await authCalls(page)).some((entry) => (
    entry.startsWith('turn:start:agent:/review:')
  ))).toBe(true)
  await expect(page.locator('.mode-segment').getByRole('button', { name: 'Agent' })).toHaveClass(/active/u)
  await expect(page.locator('.user-message-body')).toContainText('/review')
  const calls = await authCalls(page)
  expect(calls).toContain(`execute:review:ws_${'a'.repeat(43)}:prepare`)
  expect(calls).toContain('review:armed')
  expect(calls).toContain(`turn:review-handle:review_${'r'.repeat(43)}`)
  expect(calls).toContain(`conversation:create:agent:ws_${'a'.repeat(43)}`)
  expect(calls.filter((entry) => entry === `execute:review:ws_${'a'.repeat(43)}:prepare`)).toHaveLength(1)
  expect(calls.filter((entry) => entry.startsWith('turn:start:agent:/review:'))).toHaveLength(1)
  expect(calls.some((entry) => entry.startsWith('turn:start:chat:/review:'))).toBe(false)
  expect(calls.some((entry) => entry.endsWith(':0') && entry.startsWith('turn:start:agent:/review:'))).toBe(true)
})

test('授权拒绝后保持锁定并允许重试', async ({ page }) => {
  await installAuthHarness(page, 'denied')
  await page.goto('/')

  await page.getByRole('button', { name: '登录并进入工作台' }).click()
  await expect(page.getByText('GATE-E2E', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveText('设备授权已被拒绝。', { timeout: 5_000 })
  await expect(page.getByRole('button', { name: '登录并进入工作台' })).toBeEnabled()
  await expect(page.locator('.app-shell')).toHaveCount(0)
  expect(await authCalls(page)).not.toContain('bootstrap')
})

test('自动打开失败时保留同一设备码并可无弹窗重开', async ({ page }) => {
  await installAuthHarness(page, 'open-fails-once')
  await page.goto('/')

  await page.getByRole('button', { name: '登录并进入工作台' }).click()
  await expect(page.getByText('GATE-E2E', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('设备码仍然有效，可以点击重新打开。')
  await expect(page.locator('.app-shell')).toHaveCount(0)

  await page.getByRole('button', { name: '重新打开授权页' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByText('GATE-E2E', { exact: true })).toBeVisible()

  const calls = await authCalls(page)
  expect(calls.filter((entry) => entry.startsWith('open:'))).toEqual([
    'open:relay-session-auth-gate-e2e',
    'open:relay-session-auth-gate-e2e',
  ])
  expect(calls.filter((entry) => entry === 'start')).toHaveLength(1)
  expect(calls).not.toContain('openExternal')
  expect(calls).not.toContain('bootstrap')
})

test('确认 endpoint 后从 DPAPI 会话恢复本机历史', async ({ page }) => {
  await installAuthHarness(page, 'restored')
  await page.goto('/')

  await expect(page.getByRole('button', { name: '登录并进入工作台' })).toBeVisible()
  await expect(page.locator('.app-shell')).toHaveCount(0)
  await page.getByRole('button', { name: '登录并进入工作台' }).click()
  await expect(page.locator('.app-shell')).toBeVisible()
  await expect(page.locator('.sidebar-full .account-copy small')).toHaveText('账户已登录 · 模型已连接')
  await expect(page.locator('.auth-gate')).toHaveCount(0)
  await expect(page.getByText('本机加密历史已恢复。', { exact: true })).toBeVisible()
  await expect(page.getByLabel('当前任务')).toHaveText('恢复的本机任务')
  const calls = await authCalls(page)
  const connectCall = 'connect:https://www.wzhxiaozhan.top:connect'
  const loadCall = 'load:task:11111111-1111-4111-8111-111111111111'
  expect(calls).toContain(connectCall)
  expect(calls).not.toContain('start')
  expect(calls.some((entry) => entry.startsWith('open:'))).toBe(false)
  expect(calls).not.toContain('poll')
  expect(calls).toContain('bootstrap')
  expect(calls).toContain(loadCall)
  expect(calls.indexOf(connectCall)).toBeLessThan(calls.indexOf('bootstrap'))
  expect(calls.indexOf('bootstrap')).toBeLessThan(calls.indexOf(loadCall))
})

test('设备码登录成功后按 activeTaskId 恢复本机历史', async ({ page }) => {
  await installAuthHarness(page, 'device-history')
  await page.goto('/')

  await page.getByRole('button', { name: '登录并进入工作台' }).click()
  await expect(page.getByText('GATE-E2E', { exact: true })).toBeVisible()
  await expect(page.locator('.app-shell')).toBeVisible({ timeout: 5_000 })
  await expect(page.getByText('本机加密历史已恢复。', { exact: true })).toBeVisible()
  await expect(page.getByLabel('当前任务')).toHaveText('恢复的本机任务')

  const calls = await authCalls(page)
  const loadCall = 'load:task:11111111-1111-4111-8111-111111111111'
  expect(calls).toContain('start')
  expect(calls).toContain('poll')
  expect(calls).toContain('bootstrap')
  expect(calls).toContain(loadCall)
  expect(calls.indexOf('poll')).toBeLessThan(calls.indexOf('bootstrap'))
  expect(calls.indexOf('bootstrap')).toBeLessThan(calls.indexOf(loadCall))
})

test('迟到的会话恢复不会覆盖用户已新建的任务', async ({ page }) => {
  await installAuthHarness(page, 'restored-delayed')
  await page.goto('/')

  await expect(page.locator('.app-shell')).toBeVisible()
  await expect.poll(async () => (await authCalls(page)).filter((entry) => entry === 'bootstrap').length).toBeGreaterThan(0)
  await page.getByRole('button', { name: '新建 Chat', exact: true }).click()
  await expect(page.getByLabel('当前任务')).toHaveText('新 Chat')
  await page.evaluate(() => {
    const control = globalThis as typeof globalThis & { __resolveAuthGateBootstrap?: () => void }
    control.__resolveAuthGateBootstrap?.()
  })

  await expect(page.getByRole('button', { name: '本地历史 1' })).toBeVisible()
  await expect(page.getByLabel('当前任务')).toHaveText('新 Chat')
  await expect(page.getByText('本机加密历史已恢复。', { exact: true })).toHaveCount(0)
  expect(await authCalls(page)).not.toContain('load:task:11111111-1111-4111-8111-111111111111')
})

test('退出账户成功后立即卸载工作台并重新锁定', async ({ page }) => {
  await installAuthHarness(page, 'signed-in')
  await page.goto('/')
  await expect(page.locator('.app-shell')).toBeVisible()

  await page.locator('.sidebar-full .account-row').click()
  await expect(page.locator('.user-center')).toBeVisible()
  await page.getByRole('button', { name: '退出账户' }).click()

  await expect(page.getByRole('heading', { name: '登录后继续工作' })).toBeVisible()
  await expect(page.locator('.app-shell')).toHaveCount(0)
  await expect(page.locator('.user-center')).toHaveCount(0)
  const calls = await authCalls(page)
  expect(calls).toContain('signOut')
  expect(calls).toContain('unsubscribe')
})
