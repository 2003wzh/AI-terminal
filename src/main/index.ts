import { join } from 'node:path'

import { app, dialog, Menu, nativeImage, nativeTheme, Tray } from 'electron'

import {
  ApplicationShutdownCoordinator,
  createTrayMenuTemplate,
  DesktopLifecycle,
  StartupFailurePresenter
} from './desktop-lifecycle'
import { lockDownWebContents } from './security/web-contents'
import { resolveUserDataPath } from './user-data-path'
import { createMainWindow } from './window'

app.setName('AI Terminal')
const isolatedSmokeRun = !app.isPackaged && process.env.ONEKEY_SMOKE_TEST === '1'
if (isolatedSmokeRun) {
  app.on('render-process-gone', (_event, _contents, details) => {
    const allowedReasons = new Set([
      'clean-exit',
      'abnormal-exit',
      'killed',
      'crashed',
      'oom',
      'launch-failed',
      'integrity-failure'
    ])
    const diagnostics = globalThis as typeof globalThis & {
      __onekeySmokeRendererGoneReason?: string
    }
    diagnostics.__onekeySmokeRendererGoneReason = allowedReasons.has(details.reason)
      ? details.reason
      : 'unknown'
    process.stderr.write(
      `Electron smoke renderer gone reason: ${diagnostics.__onekeySmokeRendererGoneReason}.\n`
    )
  })
}
app.setPath('userData', resolveUserDataPath({
  appDataPath: app.getPath('appData'),
  tempPath: app.getPath('temp'),
  smokeRun: isolatedSmokeRun,
  requestedSmokePath: process.env.ONEKEY_SMOKE_USER_DATA,
  processId: process.pid
}))
app.enableSandbox()

const hasSingleInstanceLock = app.requestSingleInstanceLock()
let applicationTray: Tray | null = null
let mainWindowLaunch: Promise<void> | null = null
let currentWindowShutdown: (() => Promise<void>) | null = null
const applicationShutdown = new ApplicationShutdownCoordinator(
  async () => currentWindowShutdown?.(),
  () => app.quit()
)
const desktopLifecycle = new DesktopLifecycle(() => applicationShutdown.requestQuit())
const startupFailure = new StartupFailurePresenter(
  dialog,
  () => { void startDesktop() },
  () => desktopLifecycle.requestQuit()
)

function restoreMainWindow(): void {
  if (!desktopLifecycle.restoreWindow() && !startupFailure.isPresenting) void startDesktop()
}

function resolveTrayIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'app.ico')
    : join(app.getAppPath(), 'resources', 'app.ico')
}

function ensureApplicationTray(): void {
  if (applicationTray && !applicationTray.isDestroyed()) return

  const trayIcon = nativeImage.createFromPath(resolveTrayIconPath())
  if (trayIcon.isEmpty()) throw new Error('Application tray icon is unavailable.')

  const tray = new Tray(trayIcon)
  try {
    tray.setToolTip('AI 终点站')
    tray.setContextMenu(Menu.buildFromTemplate(createTrayMenuTemplate(
      restoreMainWindow,
      () => desktopLifecycle.requestQuit()
    )))
    tray.on('double-click', restoreMainWindow)
    applicationTray = tray
  } catch {
    tray.destroy()
    throw new Error('Application tray initialization failed.')
  }
}

function launchMainWindow(): Promise<void> {
  if (mainWindowLaunch) return mainWindowLaunch

  const launch = createMainWindow().then((launched) => {
    currentWindowShutdown = launched.shutdown
    launched.window.once('closed', () => {
      if (currentWindowShutdown === launched.shutdown) currentWindowShutdown = null
    })
    desktopLifecycle.attachWindow(launched.window)
  })
  mainWindowLaunch = launch
  const clearLaunch = (): void => {
    if (mainWindowLaunch === launch) mainWindowLaunch = null
  }
  void launch.then(clearLaunch, clearLaunch)
  return launch
}

async function startDesktop(): Promise<void> {
  try {
    ensureApplicationTray()
    await launchMainWindow()
  } catch {
    await startupFailure.present()
  }
}

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    restoreMainWindow()
  })

  app.on('before-quit', (event) => {
    desktopLifecycle.markQuitting()
    applicationShutdown.handleBeforeQuit(event)
  })

  app.on('will-quit', () => {
    if (applicationTray && !applicationTray.isDestroyed()) applicationTray.destroy()
    applicationTray = null
  })

  app.on('web-contents-created', (_event, contents) => lockDownWebContents(contents))

  app.on('login', (event, _webContents, _details, _authInfo, callback) => {
    event.preventDefault()
    callback()
  })

  void app
    .whenReady()
    .then(() => {
      nativeTheme.themeSource = 'dark'
      Menu.setApplicationMenu(null)
      app.setAppUserModelId('com.wzhxiaozhan.ai-terminal')
      return startDesktop()
    })
    .catch(() => startupFailure.present())

  app.on('activate', () => {
    restoreMainWindow()
  })
}
