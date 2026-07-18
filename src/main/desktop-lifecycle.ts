import type { BrowserWindow, MenuItemConstructorOptions, MessageBoxOptions } from 'electron'

export const TRAY_OPEN_LABEL = '打开 AI 终点站'
export const TRAY_QUIT_LABEL = '退出'
export const STARTUP_FAILURE_TITLE = 'AI终点站无法启动'
export const STARTUP_FAILURE_MESSAGE = '工作区初始化失败'
export const STARTUP_FAILURE_DETAIL = '请检查系统可用磁盘空间并确认安装文件完整，然后选择“重试”。如果问题持续，请完全退出应用后重新启动。'
export const STARTUP_RETRY_LABEL = '重试'
export const STARTUP_EXIT_LABEL = '退出'

export interface StartupFailureDialog {
  showMessageBox(options: MessageBoxOptions): Promise<{ response: number }>
  showErrorBox(title: string, content: string): void
}

export interface BeforeQuitEvent {
  preventDefault(): void
}

export type ShutdownState = 'running' | 'draining' | 'ready'

export function createStartupFailureDialogOptions(): MessageBoxOptions {
  return {
    type: 'error',
    title: STARTUP_FAILURE_TITLE,
    message: STARTUP_FAILURE_MESSAGE,
    detail: STARTUP_FAILURE_DETAIL,
    buttons: [STARTUP_RETRY_LABEL, STARTUP_EXIT_LABEL],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  }
}

/**
 * Presents only app-owned copy. The triggering exception is deliberately not
 * accepted, so paths, credentials, and other sensitive context cannot reach UI.
 */
export class StartupFailurePresenter {
  readonly #dialog: StartupFailureDialog
  readonly #retry: () => void
  readonly #quitApplication: () => void
  #activePrompt: Promise<void> | null = null

  constructor(
    dialog: StartupFailureDialog,
    retry: () => void,
    quitApplication: () => void
  ) {
    this.#dialog = dialog
    this.#retry = retry
    this.#quitApplication = quitApplication
  }

  get isPresenting(): boolean {
    return this.#activePrompt !== null
  }

  present(): Promise<void> {
    if (this.#activePrompt) return this.#activePrompt

    const prompt = this.#presentOnce()
    this.#activePrompt = prompt
    const clearPrompt = (): void => {
      if (this.#activePrompt === prompt) this.#activePrompt = null
    }
    void prompt.then(clearPrompt, clearPrompt)
    return prompt
  }

  async #presentOnce(): Promise<void> {
    let response: number
    try {
      response = (await this.#dialog.showMessageBox(createStartupFailureDialogOptions())).response
    } catch {
      this.#showFallbackAndQuit()
      return
    }

    // Clear before retrying so an immediate second failure can open a new prompt.
    this.#activePrompt = null
    if (response === 0) {
      try {
        this.#retry()
      } catch {
        this.#showFallbackAndQuit()
      }
      return
    }
    this.#quitApplication()
  }

  #showFallbackAndQuit(): void {
    try {
      this.#dialog.showErrorBox(
        STARTUP_FAILURE_TITLE,
        `${STARTUP_FAILURE_MESSAGE}\n\n${STARTUP_FAILURE_DETAIL}`
      )
    } catch {
      // A native dialog can be unavailable during a broken Electron startup.
    }
    this.#quitApplication()
  }
}

export class ApplicationShutdownCoordinator {
  readonly #drain: () => Promise<void>
  readonly #quitApplication: () => void
  readonly #timeoutMs: number
  #state: ShutdownState = 'running'

  constructor(drain: () => Promise<void>, quitApplication: () => void, timeoutMs = 5_000) {
    if (typeof drain !== 'function' || typeof quitApplication !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error('Invalid shutdown coordinator configuration.')
    }
    this.#drain = drain
    this.#quitApplication = quitApplication
    this.#timeoutMs = timeoutMs
  }

  get state(): ShutdownState {
    return this.#state
  }

  handleBeforeQuit(event: BeforeQuitEvent): void {
    if (this.#state === 'ready') return
    event.preventDefault()
    this.requestQuit()
  }

  requestQuit(): void {
    if (this.#state !== 'running') return
    this.#state = 'draining'
    void this.#finishShutdown()
  }

  async #finishShutdown(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#timeoutMs)
    })
    try {
      await Promise.race([
        Promise.resolve().then(this.#drain).catch(() => undefined),
        timeout
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      this.#state = 'ready'
      this.#quitApplication()
    }
  }
}

export class DesktopLifecycle {
  private mainWindow: BrowserWindow | null = null
  private quitting = false
  private readonly quitApplication: () => void

  constructor(quitApplication: () => void) {
    this.quitApplication = quitApplication
  }

  attachWindow(window: BrowserWindow): void {
    if (this.mainWindow === window) return

    this.mainWindow = window
    window.on('close', (event) => {
      if (this.quitting || window.isDestroyed()) return
      event.preventDefault()
      window.hide()
    })
    window.once('closed', () => {
      if (this.mainWindow === window) this.mainWindow = null
    })
    window.once('session-end', () => this.markQuitting())
  }

  restoreWindow(): boolean {
    const window = this.mainWindow
    if (!window || window.isDestroyed()) return false

    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    return true
  }

  markQuitting(): void {
    this.quitting = true
  }

  requestQuit(): void {
    if (this.quitting) return
    this.quitting = true
    this.quitApplication()
  }
}

export function createTrayMenuTemplate(
  openWindow: () => void,
  quitApplication: () => void
): MenuItemConstructorOptions[] {
  return [
    { label: TRAY_OPEN_LABEL, click: openWindow },
    { type: 'separator' },
    { label: TRAY_QUIT_LABEL, click: quitApplication }
  ]
}
