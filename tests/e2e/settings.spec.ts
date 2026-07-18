import { expect, test, type Page } from '@playwright/test'

const settingsViews = [
  '常规',
  '外观',
  '语音',
  '配置',
  '个性化',
  '键盘快捷键',
  '账户',
  '插件',
  '浏览器',
  '电脑操控',
  '钩子',
  '连接',
  'Git',
  '环境',
  '工作树',
  '已归档任务',
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

async function openSettings(page: Page, width: number): Promise<void> {
  if (width > 1039) {
    await page.locator('.sidebar-full').getByRole('button', { name: '设置', exact: true }).click()
  } else {
    await expect(page.locator('.sidebar-rail')).toBeVisible()
    await page.locator('.sidebar-rail').getByRole('button', { name: '设置', exact: true }).click()
  }

  await expect(page.locator('.settings-shell')).toBeVisible()
  await expect(page.getByRole('navigation', { name: '设置导航' })).toBeVisible()
}

async function selectSettingsView(page: Page, label: typeof settingsViews[number]): Promise<void> {
  const navigation = page.getByRole('navigation', { name: '设置导航' })
  const button = navigation.locator(`button[title="${label}"]`)
  await button.click()
  await expect(button).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.settings-content').getByRole('heading', { level: 1, name: label, exact: true })).toBeVisible()
}

async function expectNoDocumentHorizontalOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  )).toBe(true)
}

test.describe('设置本地预览', () => {
  test('1440 完整侧栏入口、搜索和分类导航保持正确的当前页', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loadLocalWorkspace(page)

    await expect(page.locator('.sidebar-full')).toBeVisible()
    await openSettings(page, 1440)
    await expect(page.locator('.settings-sidebar')).toBeVisible()

    const navigation = page.getByRole('navigation', { name: '设置导航' })
    await expect(navigation.locator('button[title="常规"]')).toHaveAttribute('aria-current', 'page')

    const search = page.getByRole('textbox', { name: '搜索设置' })
    await search.fill('Git')
    const git = navigation.locator('button[title="Git"]')
    await expect(git).toBeVisible()
    await expect(git).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('.settings-content').getByRole('heading', { level: 1, name: 'Git', exact: true })).toBeVisible()

    await search.clear()
    await selectSettingsView(page, '环境')
    await expect(page.getByText('Agent 文件工具', { exact: true })).toBeVisible()
    await expect(page.getByText('list_directory、read_file、write_file 与 git_summary 仅经审批链访问已选择的工作区', { exact: true })).toBeVisible()
    await expect(page.getByText('命令与终端', { exact: true })).toBeVisible()
    await selectSettingsView(page, '外观')
    await expect(git).not.toHaveAttribute('aria-current', 'page')
  })

  test('批准模式确认流程同步到工作区并保留原任务状态', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loadLocalWorkspace(page)

    const originalTask = page.getByRole('treeitem', { name: /核对桌面端安全边界/ })
    await originalTask.click()
    await expect(originalTask).toHaveAttribute('aria-selected', 'true')
    await expect(originalTask.getByLabel('未读')).toBeVisible()

    await openSettings(page, 1440)
    const approvalModes = page.getByRole('radiogroup', { name: '默认批准模式' })
    const ask = approvalModes.getByRole('radio', { name: /请求批准/ })
    const auto = approvalModes.getByRole('radio', { name: /替我审批/ })
    const full = approvalModes.getByRole('radio', { name: /完全访问/ })

    await expect(ask).toBeChecked()
    await auto.click()
    await expect(auto).toBeChecked()

    await full.click()
    let dialog = page.getByRole('alertdialog', { name: '将默认批准模式设为完全访问？' })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(auto).toBeChecked()

    await full.click()
    dialog = page.getByRole('alertdialog', { name: '将默认批准模式设为完全访问？' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('读取和写入普通文件')
    await expect(dialog).toContainText('命令和终端尚未接入')
    await dialog.getByRole('button', { name: '确认完全访问' }).click()
    await expect(full).toBeChecked()

    await page.getByRole('button', { name: '返回应用' }).click()
    const restoredTask = page.getByRole('treeitem', { name: /核对桌面端安全边界/ })
    await expect(restoredTask).toHaveAttribute('aria-selected', 'true')
    await expect(restoredTask.getByLabel('未读')).toBeVisible()
    await expect(page.locator('.titlebar-task')).toContainText('核对桌面端安全边界')
    await expect(page.locator('.mode-segment').getByRole('button', { name: 'Agent' })).toHaveClass(/active/)
    await expect(page.locator('.permission-button')).toContainText('完全访问')
  })

  test('常规、外观、浏览器和配置偏好在本次应用会话中保留', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loadLocalWorkspace(page)
    await openSettings(page, 1440)

    const shell = page.getByRole('combobox', { name: '集成终端 Shell' })
    await shell.selectOption('cmd')
    await expect(shell).toHaveValue('cmd')

    await selectSettingsView(page, '外观')
    const density = page.getByRole('combobox', { name: '界面密度' })
    await density.selectOption('compact')
    await expect(page.locator('.settings-shell')).toHaveClass(/density-compact/)

    await selectSettingsView(page, '浏览器')
    const webSearch = page.getByRole('switch', { name: '新任务启用 Web 搜索' })
    await expect(webSearch).toBeChecked()
    await webSearch.click()
    await expect(webSearch).not.toBeChecked()

    await selectSettingsView(page, '配置')
    const imageGeneration = page.getByRole('switch', { name: '图片生成' })
    await expect(imageGeneration).not.toBeChecked()
    await imageGeneration.click()
    await expect(imageGeneration).toBeChecked()

    await page.getByRole('button', { name: '返回应用' }).click()
    await expect(page.locator('.composer-tools').getByRole('button', { name: '开启联网' })).toBeVisible()
    await expect(page.locator('.composer-tools').getByRole('button', { name: '关闭图片生成' })).toBeVisible()

    await openSettings(page, 1440)
    await selectSettingsView(page, '常规')
    await expect(page.getByRole('combobox', { name: '集成终端 Shell' })).toHaveValue('cmd')
    await expect(page.locator('.settings-shell')).toHaveClass(/density-compact/)

    await selectSettingsView(page, '外观')
    await expect(page.getByRole('combobox', { name: '界面密度' })).toHaveValue('compact')
    await selectSettingsView(page, '浏览器')
    await expect(page.getByRole('switch', { name: '新任务启用 Web 搜索' })).not.toBeChecked()
    await selectSettingsView(page, '配置')
    await expect(page.getByRole('switch', { name: '图片生成' })).toBeChecked()
  })

  test('账户页进入用户中心后返回设置', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loadLocalWorkspace(page)
    await openSettings(page, 1440)

    await selectSettingsView(page, '账户')
    await page.getByRole('button', { name: '进入用户中心' }).click()
    await expect(page.locator('.user-center-header').getByText('用户中心', { exact: true })).toBeVisible()
    await expect(page.getByRole('navigation', { name: '用户中心导航' })).toBeVisible()

    await page.locator('.uc-back').click()
    await expect(page.locator('.settings-shell')).toBeVisible()
    const settingsNavigation = page.getByRole('navigation', { name: '设置导航' })
    await expect(settingsNavigation).toBeVisible()
    await expect(settingsNavigation.locator('button[title="账户"]')).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('.settings-content').getByRole('heading', { level: 1, name: '账户', exact: true })).toBeVisible()
  })

  test('浏览器预览拒绝保存 API Key 并立即清空输入', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loadLocalWorkspace(page)
    await openSettings(page, 1440)
    await selectSettingsView(page, '配置')

    const apiKey = page.getByLabel('API Key')
    await expect(apiKey).toHaveAttribute('type', 'password')
    await apiKey.fill('preview-only-secret-value')
    await page.getByRole('button', { name: '安全保存' }).click()

    await expect(apiKey).toHaveValue('')
    await expect(page.getByRole('status')).toContainText('浏览器预览不会接收或保存 API Key')
  })

  for (const viewport of [
    { width: 2048, height: 1152 },
    { width: 1440, height: 900 },
    { width: 940, height: 760 },
  ]) {
    test(`${viewport.width}px 设置各页面无文档横向溢出`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await loadLocalWorkspace(page)

      if (viewport.width === 940) {
        await expect(page.locator('.sidebar-full')).toBeHidden()
        await expect(page.locator('.sidebar-rail').getByRole('button', { name: '设置', exact: true })).toBeVisible()
      }
      await openSettings(page, viewport.width)

      for (const view of settingsViews) {
        await selectSettingsView(page, view)
        await expectNoDocumentHorizontalOverflow(page)
      }
    })
  }
})
