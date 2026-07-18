import {
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  FileCode2,
  FolderClosed,
  KeyRound,
  LockKeyhole,
  Maximize2,
  MessageSquare,
  Minus,
  Server,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  X,
} from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import type {
  RemoteRelayConnectionDto,
  RemoteRelayDeviceAuthorizationDto,
} from '../../shared/contracts'
import { WZH_SERVER_ORIGIN } from '../../shared/server-config'

import './auth-gate.css'

type AuthPhase = 'checking' | 'signed-out' | 'connecting' | 'authorizing' | 'authenticated'

type DesktopSessionContextValue = {
  lockAfterSignOut: () => boolean
}

const DEFAULT_RELAY_ENDPOINT = WZH_SERVER_ORIGIN
const NOOP_SESSION: DesktopSessionContextValue = { lockAfterSignOut: () => false }
const DesktopSessionContext = createContext<DesktopSessionContextValue>(NOOP_SESSION)

export function useDesktopSession(): DesktopSessionContextValue {
  return useContext(DesktopSessionContext)
}

export default function DesktopAuthBoundary({ children }: { children: ReactNode }) {
  const desktopRenderer = 'onekey' in window
  const [phase, setPhase] = useState<AuthPhase>(desktopRenderer ? 'checking' : 'authenticated')
  const [connection, setConnection] = useState<RemoteRelayConnectionDto | null>(null)
  const [authorization, setAuthorization] = useState<RemoteRelayDeviceAuthorizationDto | null>(null)
  const [error, setError] = useState('')
  const [copyNotice, setCopyNotice] = useState('')
  const [openingAuthorization, setOpeningAuthorization] = useState(false)
  const requestSequence = useRef(0)
  const endpoint = connection?.endpointConsent.endpointLabel
    ?? connection?.endpoint
    ?? DEFAULT_RELAY_ENDPOINT

  const enterWorkspace = useCallback((nextConnection: RemoteRelayConnectionDto): boolean => {
    setConnection(nextConnection)
    if (
      !nextConnection.authenticated ||
      nextConnection.endpointConsent.status !== 'confirmed'
    ) {
      return false
    }
    setAuthorization(null)
    setError('')
    setPhase('authenticated')
    return true
  }, [])

  useEffect(() => {
    if (!desktopRenderer) return
    const sequence = ++requestSequence.current
    let disposed = false

    void window.onekey.relay.getConnection().then((result) => {
      if (disposed || sequence !== requestSequence.current) return
      if (!result.ok) {
        setError(result.error.message)
        setPhase('signed-out')
        return
      }
      if (!enterWorkspace(result.value)) setPhase('signed-out')
    }).catch(() => {
      if (disposed || sequence !== requestSequence.current) return
      setError('无法读取本机登录状态，请重试。')
      setPhase('signed-out')
    })

    return () => {
      disposed = true
      requestSequence.current += 1
    }
  }, [desktopRenderer, enterWorkspace])

  const requestAuthorizationOpen = useCallback(async (sessionId: string): Promise<boolean> => {
    if (!desktopRenderer || openingAuthorization) return false
    setOpeningAuthorization(true)
    try {
      const result = await window.onekey.relay.openDeviceAuthorization({ sessionId })
      if (!result.ok) {
        setError(`${result.error.message} 设备码仍然有效，可以点击重新打开。`)
        return false
      }
      setError('')
      return true
    } catch {
      setError('无法自动打开授权页，设备码仍然有效，可以点击重新打开。')
      return false
    } finally {
      setOpeningAuthorization(false)
    }
  }, [desktopRenderer, openingAuthorization])

  const beginLogin = useCallback(async () => {
    if (!desktopRenderer || phase === 'checking' || phase === 'connecting') return
    const sequence = ++requestSequence.current
    setError('')
    setCopyNotice('')
    setAuthorization(null)
    setPhase('connecting')

    try {
      let confirmedEndpoint = connection?.endpoint
      if (!confirmedEndpoint) {
        const currentConnection = await window.onekey.relay.getConnection()
        if (sequence !== requestSequence.current) return
        if (!currentConnection.ok) {
          setError(currentConnection.error.message)
          setPhase('signed-out')
          return
        }
        setConnection(currentConnection.value)
        confirmedEndpoint = currentConnection.value.endpoint
      }
      const connected = await window.onekey.relay.connect({
        endpoint: confirmedEndpoint,
        confirmation: 'connect',
      })
      if (sequence !== requestSequence.current) return
      if (!connected.ok) {
        setError(connected.error.message)
        setPhase('signed-out')
        return
      }
      setConnection(connected.value)
      if (enterWorkspace(connected.value)) return

      const started = await window.onekey.relay.startDeviceAuthorization()
      if (sequence !== requestSequence.current) return
      if (!started.ok) {
        setError(started.error.message)
        setPhase('signed-out')
        return
      }
      setAuthorization(started.value)
      setPhase('authorizing')
      await requestAuthorizationOpen(started.value.sessionId)
    } catch {
      if (sequence !== requestSequence.current) return
      setError('登录请求未完成，请检查网络后重试。')
      setPhase('signed-out')
    }
  }, [connection?.endpoint, desktopRenderer, enterWorkspace, phase, requestAuthorizationOpen])

  useEffect(() => {
    if (!desktopRenderer || phase !== 'authorizing' || !authorization) return
    const sequence = requestSequence.current
    let cancelled = false
    let timer = 0

    const poll = async (): Promise<void> => {
      try {
        const result = await window.onekey.relay.pollDeviceAuthorization({
          sessionId: authorization.sessionId,
        })
        if (cancelled || sequence !== requestSequence.current) return
        if (!result.ok) {
          setAuthorization(null)
          setError(result.error.message)
          setPhase('signed-out')
          return
        }
        if (result.value.status === 'authenticated') {
          const confirmed = await window.onekey.relay.getConnection()
          if (cancelled || sequence !== requestSequence.current) return
          if (!confirmed.ok || !enterWorkspace(confirmed.value)) {
            setAuthorization(null)
            setError(confirmed.ok ? '登录状态未通过本地校验，请重试。' : confirmed.error.message)
            setPhase('signed-out')
          }
          return
        }
        if (result.value.status === 'expired' || result.value.status === 'denied') {
          setAuthorization(null)
          setError(result.value.status === 'expired' ? '设备授权已过期，请重新登录。' : '设备授权已被拒绝。')
          setPhase('signed-out')
          return
        }
        timer = window.setTimeout(
          () => void poll(),
          Math.max(1, result.value.retryAfterSeconds) * 1000,
        )
      } catch {
        if (cancelled || sequence !== requestSequence.current) return
        setAuthorization(null)
        setError('设备授权轮询未完成，请重新登录。')
        setPhase('signed-out')
      }
    }

    timer = window.setTimeout(
      () => void poll(),
      Math.max(1, authorization.intervalSeconds) * 1000,
    )
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [authorization, desktopRenderer, enterWorkspace, phase])

  const lockAfterSignOut = useCallback((): boolean => {
    requestSequence.current += 1
    setConnection((current) => current ? {
      ...current,
      authenticated: false,
      deviceId: null,
    } : current)
    setAuthorization(null)
    setCopyNotice('')
    setError('')
    setPhase('signed-out')
    return true
  }, [])

  const session = useMemo<DesktopSessionContextValue>(
    () => ({ lockAfterSignOut }),
    [lockAfterSignOut],
  )

  if (!desktopRenderer || phase === 'authenticated') {
    return (
      <DesktopSessionContext.Provider value={desktopRenderer ? session : NOOP_SESSION}>
        {children}
      </DesktopSessionContext.Provider>
    )
  }

  const busy = phase === 'checking' || phase === 'connecting'

  const copyUserCode = async (): Promise<void> => {
    if (!authorization) return
    try {
      await navigator.clipboard.writeText(authorization.userCode)
      setCopyNotice('设备码已复制')
    } catch {
      setCopyNotice('无法写入剪贴板，请手动输入设备码')
    }
  }

  const openAuthorization = async (): Promise<void> => {
    if (!authorization) return
    await requestAuthorizationOpen(authorization.sessionId)
  }

  return (
    <div className="auth-gate">
      <AuthTitlebar />
      <main className="auth-stage">
        <section className="auth-login" aria-labelledby="auth-title">
          <div className="auth-kicker"><span /> AI终点站</div>
          <h1 id="auth-title">登录后继续工作</h1>
          <p className="auth-lead">连接你的中转站账户，完成验证后直接进入 AI 工作台。</p>

          <div className="auth-login-surface">
            <div className="auth-login-heading">
              <span className="auth-login-icon"><KeyRound size={19} /></span>
              <div>
                <strong>{authorization ? '完成设备授权' : phase === 'checking' ? '检查本机会话' : '账户登录'}</strong>
                <small>{authorization ? '在浏览器确认后，工作台会自动解锁' : '点击登录即确认下方连接地址'}</small>
              </div>
            </div>

            <div className="auth-endpoint">
              <Server size={14} />
              <span>连接地址</span>
              <code>{endpoint}</code>
            </div>

            {authorization ? (
              <div className="auth-device-flow">
                <div className="auth-code-label">设备码</div>
                <div className="auth-device-code" aria-label={`设备码 ${authorization.userCode}`}>
                  <code>{authorization.userCode}</code>
                  <button type="button" onClick={() => void copyUserCode()} title="复制设备码" aria-label="复制设备码">
                    {copyNotice === '设备码已复制' ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                </div>
                {copyNotice && <div className="auth-copy-notice" role="status">{copyNotice}</div>}
                <button
                  type="button"
                  className="auth-primary"
                  disabled={openingAuthorization}
                  onClick={() => void openAuthorization()}
                >
                  <ExternalLink size={16} />
                {openingAuthorization ? '正在打开…' : '重新打开授权页'}
              </button>
              <div className="auth-waiting" role="status">
                <span className="auth-pulse" />
                  授权页已交给默认浏览器，正在等待账户确认
              </div>
              </div>
            ) : (
              <>
                <div className="auth-login-consent">
                  <ShieldCheck size={14} />
                  <span>首次登录会发送客户端名称、Windows 平台和版本；登录后读取账户可用模型，并仅在 Main 内存中使用一个已启用的访问令牌。</span>
                </div>
                <button
                  type="button"
                  className="auth-primary"
                  disabled={busy}
                  onClick={() => void beginLogin()}
                >
                  {busy ? <span className="auth-spinner" aria-hidden="true" /> : <ArrowRight size={17} />}
                  {phase === 'checking' ? '正在检查…' : phase === 'connecting' ? '正在连接…' : '登录并进入工作台'}
                </button>
              </>
            )}

            {error && <div className="auth-error" role="alert">{error}</div>}
          </div>

          <div className="auth-trust-row">
            <ShieldCheck size={16} />
            <span>登录凭据由 Windows 当前用户加密保管，并在退出时安全清除。</span>
          </div>
        </section>

        <aside className="auth-workbench" aria-label="已锁定的 AI 工作台预览">
          <div className="auth-workbench-top">
            <span><Sparkles size={15} /> AI 工作台</span>
            <span className="auth-locked-status"><LockKeyhole size={13} /> 已锁定</span>
          </div>
          <div className="auth-workbench-body">
            <nav aria-label="工作台区域">
              <span className="active"><MessageSquare size={16} /></span>
              <span><FolderClosed size={16} /></span>
              <span><FileCode2 size={16} /></span>
              <span><SquareTerminal size={16} /></span>
            </nav>
            <div className="auth-workbench-canvas">
              <div className="auth-canvas-toolbar">
                <span className="auth-tab active">Chat</span>
                <span className="auth-tab">Agent</span>
              </div>
              <div className="auth-canvas-lock">
                <span><LockKeyhole size={22} /></span>
                <strong>工作区等待登录</strong>
                <small>验证完成后恢复本机工作台</small>
              </div>
              <div className="auth-composer-ghost"><span /><i /></div>
            </div>
          </div>
        </aside>
      </main>
    </div>
  )
}

function AuthTitlebar() {
  const invokeWindow = (action: 'minimize' | 'toggleMaximize' | 'close'): void => {
    if (!('onekey' in window)) return
    void window.onekey.window[action]().catch(() => undefined)
  }

  return (
    <header className="auth-titlebar">
      <div className="auth-titlebar-brand">
        <span className="auth-product-mark"><span /></span>
        <strong>AI终点站</strong>
      </div>
      <div className="auth-titlebar-state"><LockKeyhole size={12} /> 安全登录</div>
      <div className="auth-window-controls">
        <button type="button" aria-label="最小化" title="最小化" onClick={() => invokeWindow('minimize')}><Minus size={15} /></button>
        <button type="button" aria-label="最大化或还原" title="最大化或还原" onClick={() => invokeWindow('toggleMaximize')}><Maximize2 size={13} /></button>
        <button type="button" className="close" aria-label="关闭" title="关闭" onClick={() => invokeWindow('close')}><X size={15} /></button>
      </div>
    </header>
  )
}
