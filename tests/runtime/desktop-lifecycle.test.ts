import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import type { BrowserWindow } from 'electron'

import {
  ApplicationShutdownCoordinator,
  createStartupFailureDialogOptions,
  createTrayMenuTemplate,
  DesktopLifecycle,
  STARTUP_EXIT_LABEL,
  STARTUP_FAILURE_DETAIL,
  STARTUP_FAILURE_MESSAGE,
  STARTUP_FAILURE_TITLE,
  STARTUP_RETRY_LABEL,
  StartupFailurePresenter,
  TRAY_OPEN_LABEL,
  TRAY_QUIT_LABEL
} from '../../src/main/desktop-lifecycle.ts'

class MockWindow extends EventEmitter {
  destroyed = false
  minimized = false
  hideCalls = 0
  restoreCalls = 0
  showCalls = 0
  focusCalls = 0

  isDestroyed(): boolean { return this.destroyed }
  isMinimized(): boolean { return this.minimized }
  hide(): void { this.hideCalls += 1 }
  restore(): void { this.restoreCalls += 1; this.minimized = false }
  show(): void { this.showCalls += 1 }
  focus(): void { this.focusCalls += 1 }
}

function asBrowserWindow(window: MockWindow): BrowserWindow {
  return window as unknown as BrowserWindow
}

function emitClose(window: MockWindow): number {
  let prevented = 0
  window.emit('close', { preventDefault: () => { prevented += 1 } })
  return prevented
}

test('window close hides the app without destroying its background session', () => {
  const window = new MockWindow()
  let quitCalls = 0
  const lifecycle = new DesktopLifecycle(() => { quitCalls += 1 })
  lifecycle.attachWindow(asBrowserWindow(window))

  assert.equal(emitClose(window), 1)
  assert.equal(window.hideCalls, 1)
  assert.equal(window.destroyed, false)
  assert.equal(quitCalls, 0)
})

test('restore handles minimized and hidden windows and ignores destroyed windows', () => {
  const window = new MockWindow()
  window.minimized = true
  const lifecycle = new DesktopLifecycle(() => {})
  lifecycle.attachWindow(asBrowserWindow(window))

  assert.equal(lifecycle.restoreWindow(), true)
  assert.equal(window.restoreCalls, 1)
  assert.equal(window.showCalls, 1)
  assert.equal(window.focusCalls, 1)

  window.destroyed = true
  assert.equal(lifecycle.restoreWindow(), false)
  assert.equal(window.showCalls, 1)
})

test('explicit quit calls app.quit and does not intercept window closure', () => {
  const window = new MockWindow()
  let quitCalls = 0
  const lifecycle = new DesktopLifecycle(() => { quitCalls += 1 })
  lifecycle.attachWindow(asBrowserWindow(window))

  lifecycle.requestQuit()
  assert.equal(quitCalls, 1)
  assert.equal(emitClose(window), 0)
  assert.equal(window.hideCalls, 0)
})

test('final Windows session end does not intercept window closure or call app.quit', () => {
  const window = new MockWindow()
  let quitCalls = 0
  const lifecycle = new DesktopLifecycle(() => { quitCalls += 1 })
  lifecycle.attachWindow(asBrowserWindow(window))

  window.emit('session-end', {})
  assert.equal(emitClose(window), 0)
  assert.equal(window.hideCalls, 0)
  assert.equal(quitCalls, 0)
})

test('quit requests are idempotent and tray commands call the intended actions', () => {
  let openCalls = 0
  let quitCalls = 0
  const lifecycle = new DesktopLifecycle(() => { quitCalls += 1 })
  lifecycle.requestQuit()
  lifecycle.requestQuit()
  assert.equal(quitCalls, 1)

  const template = createTrayMenuTemplate(
    () => { openCalls += 1 },
    () => { quitCalls += 1 }
  )
  assert.deepEqual(template.map(({ label, type }) => ({ label, type })), [
    { label: TRAY_OPEN_LABEL, type: undefined },
    { label: undefined, type: 'separator' },
    { label: TRAY_QUIT_LABEL, type: undefined }
  ])
  template[0]?.click?.({} as never, {} as never, {} as never)
  template[2]?.click?.({} as never, {} as never, {} as never)
  assert.equal(openCalls, 1)
  assert.equal(quitCalls, 2)
})

test('closed and duplicate window registration leave no stale or duplicate behavior', () => {
  const window = new MockWindow()
  const lifecycle = new DesktopLifecycle(() => {})
  lifecycle.attachWindow(asBrowserWindow(window))
  lifecycle.attachWindow(asBrowserWindow(window))

  assert.equal(emitClose(window), 1)
  assert.equal(window.hideCalls, 1)
  window.emit('closed')
  assert.equal(lifecycle.restoreWindow(), false)
})

test('application quit drains once before allowing the final quit event', async () => {
  let finishDrain!: () => void
  const drainGate = new Promise<void>((resolve) => { finishDrain = resolve })
  let drainCalls = 0
  let quitCalls = 0
  const coordinator = new ApplicationShutdownCoordinator(async () => {
    drainCalls += 1
    await drainGate
  }, () => { quitCalls += 1 }, 1_000)
  let prevented = 0
  const event = { preventDefault: () => { prevented += 1 } }

  coordinator.handleBeforeQuit(event)
  coordinator.handleBeforeQuit(event)
  coordinator.requestQuit()
  assert.equal(coordinator.state, 'draining')
  assert.equal(prevented, 2)
  assert.equal(drainCalls, 0)
  assert.equal(quitCalls, 0)

  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(drainCalls, 1)
  finishDrain()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(coordinator.state, 'ready')
  assert.equal(quitCalls, 1)

  coordinator.handleBeforeQuit(event)
  assert.equal(prevented, 2)
})

test('application quit has a bounded drain timeout', async () => {
  let quitCalls = 0
  const coordinator = new ApplicationShutdownCoordinator(
    async () => await new Promise<void>(() => undefined),
    () => { quitCalls += 1 },
    5
  )
  coordinator.requestQuit()
  await new Promise<void>((resolve) => setTimeout(resolve, 25))
  assert.equal(coordinator.state, 'ready')
  assert.equal(quitCalls, 1)
})

test('startup failure dialog uses fixed actionable copy only', () => {
  assert.deepEqual(createStartupFailureDialogOptions(), {
    type: 'error',
    title: STARTUP_FAILURE_TITLE,
    message: STARTUP_FAILURE_MESSAGE,
    detail: STARTUP_FAILURE_DETAIL,
    buttons: [STARTUP_RETRY_LABEL, STARTUP_EXIT_LABEL],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
})

test('startup failure prompt is deduplicated and retry permits a fresh prompt', async () => {
  let finishPrompt!: (value: { response: number }) => void
  let dialogCalls = 0
  let retryCalls = 0
  const presenter = new StartupFailurePresenter({
    showMessageBox: async () => {
      dialogCalls += 1
      return await new Promise<{ response: number }>((resolve) => { finishPrompt = resolve })
    },
    showErrorBox: () => assert.fail('fallback dialog should not be used')
  }, () => { retryCalls += 1 }, () => assert.fail('quit should not be called'))

  const first = presenter.present()
  const duplicate = presenter.present()
  assert.equal(first, duplicate)
  assert.equal(presenter.isPresenting, true)
  assert.equal(dialogCalls, 1)

  finishPrompt({ response: 0 })
  await first
  assert.equal(retryCalls, 1)
  assert.equal(presenter.isPresenting, false)

  const second = presenter.present()
  assert.equal(dialogCalls, 2)
  finishPrompt({ response: 0 })
  await second
  assert.equal(retryCalls, 2)
})

test('startup failure cancel quits and dialog errors use a fixed fallback', async () => {
  let quitCalls = 0
  const fallbackCalls: Array<[string, string]> = []
  const cancelPresenter = new StartupFailurePresenter({
    showMessageBox: async () => ({ response: 1 }),
    showErrorBox: () => assert.fail('fallback dialog should not be used')
  }, () => assert.fail('retry should not be called'), () => { quitCalls += 1 })
  await cancelPresenter.present()
  assert.equal(quitCalls, 1)

  const failingPresenter = new StartupFailurePresenter({
    showMessageBox: async () => { throw new Error('secret=C:\\private\\token.txt') },
    showErrorBox: (title, content) => { fallbackCalls.push([title, content]) }
  }, () => assert.fail('retry should not be called'), () => { quitCalls += 1 })
  await failingPresenter.present()

  assert.equal(quitCalls, 2)
  assert.deepEqual(fallbackCalls, [[
    STARTUP_FAILURE_TITLE,
    `${STARTUP_FAILURE_MESSAGE}\n\n${STARTUP_FAILURE_DETAIL}`
  ]])
  assert.doesNotMatch(JSON.stringify(fallbackCalls), /secret|private|token\.txt/i)
})
