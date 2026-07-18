import { expect, test, type Page } from '@playwright/test'

function messageInput(page: Page) {
  return page.getByRole('textbox', { name: '消息' })
}

test('slash palette exposes stable combobox state and supports aliases', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')

  const input = await messageInput(page)
  await expect(input).toHaveAttribute('aria-expanded', 'false')
  await input.fill('/objective')

  const palette = page.getByRole('listbox', { name: '命令选择' })
  await expect(palette).toBeVisible()
  await expect(input).toHaveAttribute('aria-expanded', 'true')
  await expect(palette.getByRole('option')).toHaveCount(1)
  await expect(palette.getByRole('option')).toContainText('目标')

  const listId = await palette.getAttribute('id')
  const activeId = await input.getAttribute('aria-activedescendant')
  expect(listId).toBeTruthy()
  expect(activeId).toBeTruthy()
  await expect(page.locator(`[id=${JSON.stringify(activeId)}]`)).toHaveAttribute('aria-selected', 'true')

  await input.press('Enter')
  await expect(input).toHaveValue('/goal ')
  await expect(input).toHaveAttribute('aria-expanded', 'false')
  await expect(input).not.toHaveAttribute('aria-activedescendant', /.+/u)

  await input.fill('/plan')
  await input.press('Enter')
  await input.press('Enter')
  await expect(page.locator('.capability-state-pill.plan')).toContainText('计划模式')
  const gridRows = await page.locator('.conversation-pane').evaluate((element) => (
    getComputedStyle(element).gridTemplateRows.split(' ').filter(Boolean).length
  ))
  expect(gridRows).toBe(5)
})

test('palette dismisses on escape and focus changes, then reopens on input focus', async ({ page }) => {
  await page.goto('/')
  const input = await messageInput(page)

  await input.fill('/')
  await expect(page.getByRole('listbox', { name: '命令选择' })).toBeVisible()
  await input.press('Escape')
  await expect(page.getByRole('listbox', { name: '命令选择' })).toHaveCount(0)
  await expect(input).toHaveValue('/')
  await expect(input).toHaveAttribute('aria-expanded', 'false')

  await input.press('p')
  await expect(page.getByRole('listbox', { name: '命令选择' })).toBeVisible()
  await page.getByRole('button', { name: '添加文件或图片' }).focus()
  await expect(page.getByRole('listbox', { name: '命令选择' })).toHaveCount(0)
  await expect(input).toHaveAttribute('aria-expanded', 'false')

  await input.focus()
  await expect(page.getByRole('listbox', { name: '命令选择' })).toBeVisible()
  await expect(input).toHaveAttribute('aria-expanded', 'true')
})

test('IME and an unavailable plugin cannot be selected or submitted with Enter', async ({ page }) => {
  await page.goto('/')
  const input = await messageInput(page)

  await input.fill('/')
  await input.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    }))
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  })
  await expect(input).toHaveValue('/')
  await expect(page.getByRole('listbox', { name: '命令选择' })).toBeVisible()

  await input.fill('@')
  await expect(page.getByRole('listbox', { name: '插件选择' })).toBeVisible()
  await expect(page.getByRole('listbox', { name: '插件选择' }).getByRole('option')).toHaveCount(0)
  await input.press('Enter')
  await expect(input).toHaveValue('@')
  await expect(page.locator('.user-message-body').filter({ hasText: /^@$/u })).toHaveCount(0)
})

for (const viewport of [
  { width: 375, height: 667 },
  { width: 320, height: 568 },
  { width: 240, height: 480 },
]) {
  test(`palette stays inside ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto('/')
    await (await messageInput(page)).fill('/')

    const geometry = await page.getByRole('listbox', { name: '命令选择' }).evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }
    })
    expect(geometry.left).toBeGreaterThanOrEqual(0)
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth)
    expect(geometry.top).toBeGreaterThanOrEqual(0)
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight)
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth)
  })
}
