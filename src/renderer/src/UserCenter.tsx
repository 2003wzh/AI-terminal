import {
  AlertCircle,
  ArrowLeft,
  BarChart3,
  Bell,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  Copy,
  CreditCard,
  Download,
  ExternalLink,
  EyeOff,
  FileClock,
  Gift,
  KeyRound,
  Languages,
  LogOut,
  Power,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserRound,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  ApiResult,
  RemoteRelayBillingConfigDto,
  RemoteRelayConnectionDto,
  RemoteRelayDeviceAuthorizationDto,
  RemoteRelayOverviewDto,
  RemoteRelayPricingDto,
  RemoteRelayTokenDto,
  RemoteRelayTokenPageDto,
  RemoteRelayUsageDto,
} from '../../shared/contracts'
import { WZH_MODEL_BASE_URL } from '../../shared/server-config'
import { useDesktopSession } from './AuthGate'
import { formatQuota } from './quota-format'
import { relayAccountName } from './relay-identity'

import './user-center.css'

type CenterView =
  | 'account'
  | 'relay'
  | 'tokens'
  | 'usage'
  | 'pricing'
  | 'redeem'
  | 'preferences'

type TokenStatus = 'active' | 'disabled' | 'unavailable' | 'revoked'

type SafeToken = {
  id: number
  name: string
  maskedKey: string
  createdAt: string
  lastUsed: string
  status: TokenStatus
}

type InlineNotice = {
  tone: 'success' | 'error' | 'neutral'
  text: string
}

export type UserCenterProps = {
  onBack: () => void
  accountDisplayName?: string
  connectionName?: string
  endpoint?: string
  onAccountIdentityChange?: (accountName: string) => void
}

const navigation: Array<{ id: CenterView; label: string; icon: LucideIcon }> = [
  { id: 'account', label: '账户概览', icon: UserRound },
  { id: 'relay', label: '中转站', icon: Server },
  { id: 'tokens', label: '访问令牌', icon: KeyRound },
  { id: 'usage', label: '用量明细', icon: BarChart3 },
  { id: 'pricing', label: '模型价格', icon: CircleDollarSign },
  { id: 'redeem', label: '充值兑换', icon: Gift },
  { id: 'preferences', label: '偏好设置', icon: Settings2 },
]

type RelayDataState = {
  connection: RemoteRelayConnectionDto | null
  authorization: RemoteRelayDeviceAuthorizationDto | null
  billing: RemoteRelayBillingConfigDto | null
  overview: RemoteRelayOverviewDto | null
  tokens: RemoteRelayTokenPageDto | null
  usage: RemoteRelayUsageDto | null
  pricing: RemoteRelayPricingDto | null
  loading: boolean
  error: string
  dataErrors: RelayDataErrors
}

type RelayDataErrors = {
  billing: string
  overview: string
  tokens: string
  usage: string
  pricing: string
}

function emptyRelayDataErrors(): RelayDataErrors {
  return { billing: '', overview: '', tokens: '', usage: '', pricing: '' }
}

async function readRelayValue<T>(
  operation: () => Promise<ApiResult<T>>,
  rejectedMessage: string,
): Promise<{ value: T | null; error: string }> {
  try {
    const result = await operation()
    return result.ok
      ? { value: result.value, error: '' }
      : { value: null, error: result.error.message }
  } catch {
    return { value: null, error: rejectedMessage }
  }
}

function useRelayData(): RelayDataState & {
  refresh: () => Promise<void>
  connect: () => Promise<void>
  signOut: () => Promise<boolean>
} {
  const requestId = useRef(0)
  const mounted = useRef(true)
  const [state, setState] = useState<RelayDataState>({
    connection: null,
    authorization: null,
    billing: null,
    overview: null,
    tokens: null,
    usage: null,
    pricing: null,
    loading: 'onekey' in window,
    error: '',
    dataErrors: emptyRelayDataErrors(),
  })
  const relayEndpoint = state.connection?.endpoint

  const refresh = useCallback(async () => {
    const currentRequest = ++requestId.current
    if (!('onekey' in window)) {
      setState((current) => ({ ...current, loading: false }))
      return
    }

    setState((current) => ({
      ...current,
      loading: true,
      error: '',
      dataErrors: emptyRelayDataErrors(),
    }))
    const connection = await readRelayValue(
      () => window.onekey.relay.getConnection(),
      '无法读取中转站连接状态，请重试。',
    )
    if (!mounted.current || currentRequest !== requestId.current) return
    if (!connection.value) {
      setState((current) => ({ ...current, loading: false, error: connection.error }))
      return
    }

    if (!connection.value.authenticated || connection.value.endpointConsent.status !== 'confirmed') {
      setState({
        connection: connection.value,
        authorization: null,
        billing: null,
        overview: null,
        tokens: null,
        usage: null,
        pricing: null,
        loading: false,
        error: '',
        dataErrors: emptyRelayDataErrors(),
      })
      return
    }

    const now = new Date()
    const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const to = now.toISOString()
    const [billing, overview, tokens, usage, pricing] = await Promise.all([
      readRelayValue(() => window.onekey.relay.getBillingConfig(), '计费配置读取失败，请重试。'),
      readRelayValue(() => window.onekey.relay.getOverview(), '账户摘要读取失败，请重试。'),
      readRelayValue(() => window.onekey.relay.listTokens(), '访问令牌读取失败，请重试。'),
      readRelayValue(() => window.onekey.relay.listUsage({ from, to }), '用量明细读取失败，请重试。'),
      readRelayValue(() => window.onekey.relay.listPricing(), '模型价格读取失败，请重试。'),
    ])
    if (!mounted.current || currentRequest !== requestId.current) return

    setState({
      connection: connection.value,
      authorization: null,
      billing: billing.value,
      overview: overview.value,
      tokens: tokens.value,
      usage: usage.value,
      pricing: pricing.value,
      loading: false,
      error: '',
      dataErrors: {
        billing: billing.error,
        overview: overview.error,
        tokens: tokens.error,
        usage: usage.error,
        pricing: pricing.error,
      },
    })
  }, [])

  const connect = useCallback(async () => {
    if (!('onekey' in window)) return
    if (!relayEndpoint) {
      setState((current) => ({ ...current, loading: false, error: '无法确认中转站连接地址，请刷新后重试。' }))
      return
    }
    const currentRequest = ++requestId.current
    setState((current) => ({ ...current, loading: true, error: '', authorization: null }))
    const connection = await window.onekey.relay.connect({ endpoint: relayEndpoint, confirmation: 'connect' })
    if (!mounted.current || currentRequest !== requestId.current) return
    if (!connection.ok) {
      setState((current) => ({ ...current, loading: false, error: connection.error.message }))
      return
    }
    if (connection.value.authenticated) {
      setState((current) => ({ ...current, connection: connection.value, loading: false }))
      await refresh()
      return
    }
    const authorization = await window.onekey.relay.startDeviceAuthorization()
    if (!mounted.current || currentRequest !== requestId.current) return
    if (!authorization.ok) {
      setState((current) => ({
        ...current,
        connection: connection.value,
        loading: false,
        error: authorization.error.message,
      }))
      return
    }
    setState((current) => ({
      ...current,
      connection: connection.value,
      authorization: authorization.value,
      loading: false,
      error: '',
    }))
    const opened = await window.onekey.relay.openDeviceAuthorization({
      sessionId: authorization.value.sessionId,
    })
    if (!mounted.current || currentRequest !== requestId.current || opened.ok) return
    setState((current) => current.authorization?.sessionId === authorization.value.sessionId
      ? { ...current, error: `${opened.error.message} 设备码仍然有效，可以点击重新打开。` }
      : current)
  }, [refresh, relayEndpoint])

  const signOut = useCallback(async () => {
    if (!('onekey' in window)) return false
    const currentRequest = ++requestId.current
    setState((current) => ({ ...current, loading: true, error: '' }))
    const result = await window.onekey.relay.signOut()
    if (!mounted.current || currentRequest !== requestId.current) return false
    if (!result.ok) {
      setState((current) => ({ ...current, loading: false, error: result.error.message }))
      return false
    }
    const connection = await window.onekey.relay.getConnection()
    if (!mounted.current || currentRequest !== requestId.current) return false
    setState({
      connection: connection.ok ? connection.value : null,
      authorization: null,
      billing: null,
      overview: null,
      tokens: null,
      usage: null,
      pricing: null,
      loading: false,
      error: connection.ok ? '' : connection.error.message,
      dataErrors: emptyRelayDataErrors(),
    })
    return connection.ok && !connection.value.authenticated
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
      requestId.current += 1
    }
  }, [refresh])

  useEffect(() => {
    const authorization = state.authorization
    if (!authorization || !('onekey' in window)) return
    let cancelled = false
    let timer = 0
    const poll = async () => {
      const result = await window.onekey.relay.pollDeviceAuthorization({
        sessionId: authorization.sessionId,
      })
      if (cancelled || !mounted.current) return
      if (!result.ok) {
        setState((current) => ({ ...current, authorization: null, error: result.error.message }))
        return
      }
      if (result.value.status === 'authenticated') {
        setState((current) => ({ ...current, authorization: null, error: '' }))
        await refresh()
        return
      }
      if (result.value.status === 'expired' || result.value.status === 'denied') {
        setState((current) => ({
          ...current,
          authorization: null,
          error: result.value.status === 'expired' ? '设备授权已过期，请重新登录。' : '设备授权已被拒绝。',
        }))
        return
      }
      timer = window.setTimeout(
        () => void poll(),
        Math.max(1, result.value.retryAfterSeconds) * 1000,
      )
    }
    timer = window.setTimeout(() => void poll(), Math.max(1, authorization.intervalSeconds) * 1000)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [state.authorization, refresh])

  return { ...state, refresh, connect, signOut }
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function relayPublicUrl(endpoint: string, pathname: string): string | null {
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    return new URL(pathname, url.origin).toString()
  } catch {
    return null
  }
}

function tokenToSafeRow(token: RemoteRelayTokenDto): SafeToken {
  return {
    id: token.id,
    name: token.name,
    maskedKey: token.maskedKey,
    createdAt: token.createdAt ? new Date(token.createdAt).toLocaleDateString('zh-CN') : '未返回',
    lastUsed: token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString('zh-CN') : '从未使用',
    status: token.status,
  }
}

function CenterHeader({ onBack, displayName, onOpenAccount }: { onBack: () => void; displayName: string; onOpenAccount: () => void }) {
  return (
    <header className="user-center-header">
      <button type="button" className="uc-back" onClick={onBack}>
        <ArrowLeft size={16} aria-hidden="true" />
        <span>返回工作区</span>
      </button>
      <div className="uc-header-title">
        <span>用户中心</span>
        <small>账户、用量与中转站</small>
      </div>
      <button type="button" className="uc-account-menu" onClick={onOpenAccount}>
        <span className="uc-avatar">W</span>
        <span>{displayName}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
    </header>
  )
}

function CenterSidebar({
  active,
  connection,
  accountName,
  loading,
  onChange,
  onOpenDocs,
  onSignOut,
}: {
  active: CenterView
  connection: RemoteRelayConnectionDto | null
  accountName: string
  loading: boolean
  onChange: (view: CenterView) => void
  onOpenDocs: () => void
  onSignOut: () => void
}) {
  const connected = Boolean(connection?.authenticated
    && connection.endpointConsent.status === 'confirmed'
  )
  const statusText = loading ? '读取状态' : connected ? '安全连接' : '等待登录'
  return (
    <aside className="user-center-sidebar">
      <div className="uc-profile">
        <span className="uc-avatar large">W</span>
        <span>
          <strong>{accountName}</strong>
          <small><span className={`uc-online-dot ${connected ? '' : 'preview'}`} /> {statusText}</small>
        </span>
      </div>
      <nav className="uc-navigation" aria-label="用户中心导航">
        {navigation.map((item) => {
          const Icon = item.icon
          return (
            <button
              type="button"
              key={item.id}
              className={active === item.id ? 'active' : ''}
              aria-current={active === item.id ? 'page' : undefined}
              title={item.label}
              onClick={() => onChange(item.id)}
            >
              <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          )
        })}
      </nav>
      <div className="uc-sidebar-footer">
        <button type="button" onClick={onOpenDocs}><ExternalLink size={15} /><span>服务文档</span></button>
        <button type="button" onClick={onSignOut}><LogOut size={15} /><span>退出账户</span></button>
      </div>
    </aside>
  )
}

function PageHeading({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="uc-page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action && <div className="uc-page-action">{action}</div>}
    </div>
  )
}

function RelayDataNotice({ label, error }: { label: string; error: string }) {
  if (!error) return null
  return <div className="uc-inline-notice error" role="alert"><AlertCircle size={15} /><span>{label}：{error}</span></div>
}

function RelayOverview({
  endpoint,
  connectionName,
  connection,
  authorization,
  billing,
  overview,
  usage,
  pricing,
  loading,
  error,
  dataErrors,
  onConnect,
  onRefresh,
  onNavigate,
}: {
  endpoint: string
  connectionName: string
  connection: RemoteRelayConnectionDto | null
  authorization: RemoteRelayDeviceAuthorizationDto | null
  billing: RemoteRelayBillingConfigDto | null
  overview: RemoteRelayOverviewDto | null
  usage: RemoteRelayUsageDto | null
  pricing: RemoteRelayPricingDto | null
  loading: boolean
  error: string
  dataErrors: RelayDataErrors
  onConnect: () => Promise<void>
  onRefresh: () => Promise<void>
  onNavigate: (view: CenterView) => void
}) {
  const [period, setPeriod] = useState<'today' | 'month'>('today')
  const [authorizationNotice, setAuthorizationNotice] = useState('')
  const connected = Boolean(connection?.authenticated
    && connection.endpointConsent.status === 'confirmed')
  const visibleEndpoint = connection?.endpoint ?? endpoint
  const records = usage?.records ?? []
  const today = new Date().toDateString()
  const selectedRecords = period === 'today'
    ? records.filter((record) => new Date(record.createdAt).toDateString() === today)
    : records
  const selectedRequests = selectedRecords.reduce((sum, record) => sum + record.requests, 0)
  const selectedTokens = selectedRecords.reduce((sum, record) => sum + record.tokenUsed, 0)
  const selectedQuota = selectedRecords.reduce((sum, record) => sum + record.quota, 0)
  const recentUsage = records.slice(-5).reverse()

  const openAuthorization = async () => {
    if (!authorization || !('onekey' in window)) return
    const result = await window.onekey.relay.openDeviceAuthorization({
      sessionId: authorization.sessionId,
    })
    if (!result.ok) setAuthorizationNotice(result.error.message)
  }

  const copyAuthorizationCode = async () => {
    if (!authorization) return
    try {
      await navigator.clipboard.writeText(authorization.userCode)
      setAuthorizationNotice('授权码已复制。')
    } catch {
      setAuthorizationNotice('系统拒绝了剪贴板访问，请手动输入授权码。')
    }
  }
  return (
    <div className="uc-page">
      <PageHeading
        title="中转站"
        description="集中查看额度、模型目录、令牌掩码和服务端用量元数据。"
        action={connected
          ? <button type="button" className="uc-secondary-button" onClick={() => void onRefresh()} disabled={loading}><RefreshCw size={14} className={loading ? 'uc-spin' : ''} />{loading ? '读取中' : '刷新'}</button>
          : <button type="button" className="uc-primary-button" onClick={() => void onConnect()} disabled={loading || Boolean(authorization)}><KeyRound size={14} />{loading ? '连接中' : authorization ? '等待授权' : '连接并登录'}</button>}
      />

      {error && <div className="uc-inline-notice error" role="alert"><AlertCircle size={15} /><span>{error}</span></div>}
      <RelayDataNotice label="账户摘要" error={dataErrors.overview} />
      <RelayDataNotice label="计费配置" error={dataErrors.billing} />
      <RelayDataNotice label="访问令牌" error={dataErrors.tokens} />
      <RelayDataNotice label="用量明细" error={dataErrors.usage} />
      <RelayDataNotice label="模型价格" error={dataErrors.pricing} />
      {loading && !overview && <div className="uc-inline-notice neutral" role="status"><RefreshCw className="uc-spin" size={15} /><span>正在从 Main 进程读取安全摘要...</span></div>}
      {authorization && <div className="uc-inline-notice neutral" role="status"><KeyRound size={15} /><span>授权页已自动打开，设备码 <strong className="uc-mono">{authorization.userCode}</strong>；客户端正在等待结果。</span><button type="button" onClick={() => void copyAuthorizationCode()}><Copy size={13} />复制</button><button type="button" onClick={() => void openAuthorization()}><ExternalLink size={13} />重新打开</button></div>}
      {authorizationNotice && <div className="uc-inline-notice neutral" role="status"><EyeOff size={15} /><span>{authorizationNotice}</span><button type="button" onClick={() => setAuthorizationNotice('')}><Check size={13} />知道了</button></div>}

      <section className="relay-status-band" aria-label="中转站状态">
        <div className="relay-identity">
          <span className="relay-icon"><Server size={19} /></span>
          <div><strong>{connectionName}</strong><small title={visibleEndpoint}>{connection?.endpointConsent.endpointLabel ?? visibleEndpoint}</small></div>
        </div>
        <div className={`relay-state ${connected ? '' : 'preview'}`}>{connected ? <CheckCircle2 size={15} /> : <EyeOff size={15} />}<span>{connected ? 'HTTPS 已确认连接' : connection?.endpointConsent.status === 'confirmed' ? 'endpoint 已确认 · 等待登录' : '等待 endpoint 确认'}</span></div>
        <div className="relay-updated">{overview ? new Date(overview.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + ' 更新' : '等待连接'}</div>
      </section>

      <section className="uc-section">
        <div className="uc-section-heading">
          <div><h2>使用概览</h2><p>金额按网站计费配置换算，Token 使用服务端统计口径</p></div>
          <div className="uc-segmented" aria-label="统计周期">
            <button type="button" className={period === 'today' ? 'active' : ''} onClick={() => setPeriod('today')}>今日</button>
            <button type="button" className={period === 'month' ? 'active' : ''} onClick={() => setPeriod('month')}>近 30 天</button>
          </div>
        </div>
        <div className="metric-strip">
          <div><span>可用额度</span><strong>{formatQuota(overview?.quota.remaining, billing)}</strong><small>{overview?.quota.used === null || overview?.quota.used === undefined ? '服务端未返回累计已用额度' : `累计已用 ${formatQuota(overview.quota.used, billing)}`}</small></div>
          <div><span>{period === 'today' ? '今日计费额度' : '近 30 天计费额度'}</span><strong>{connected ? formatQuota(selectedQuota, billing) : '—'}</strong><small>按网站当前计费配置换算</small></div>
          <div><span>调用量</span><strong>{connected ? compactNumber(selectedRequests) : '—'}</strong><small>{connected ? `${compactNumber(selectedTokens)} Tokens` : '登录后读取真实统计'}</small></div>
          <div><span>可用模型</span><strong>{overview ? overview.models.length : pricing ? pricing.models.length : '—'}</strong><small>{overview ? `${overview.groups.length} 个可用分组` : '登录后读取模型目录'}</small></div>
        </div>
      </section>

      <section className="uc-section request-section">
        <div className="uc-section-heading">
          <div><h2>最近用量摘要</h2><p>仅显示服务端汇总；不读取提示词、路径、文件名或完整凭据</p></div>
          <button type="button" className="uc-text-button" onClick={() => onNavigate('usage')}>查看全部<ArrowLeft className="uc-arrow-right" size={14} /></button>
        </div>
        <div className="uc-table-wrap">
          <table className="uc-table requests-table">
            <thead><tr><th>日期</th><th>模型</th><th>请求</th><th>Tokens</th><th>计费额度</th></tr></thead>
            <tbody>
              {recentUsage.map((record) => (
                <tr key={`${record.createdAt}-${record.modelName}`}>
                  <td><span className="uc-mono">{new Date(record.createdAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}</span></td>
                  <td><strong>{record.modelName}</strong></td>
                  <td>{formatInteger(record.requests)}</td>
                  <td>{formatInteger(record.tokenUsed)}</td>
                  <td>{formatQuota(record.quota, billing)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {recentUsage.length === 0 && <div className="uc-table-empty">登录后显示真实用量摘要</div>}
        </div>
      </section>
    </div>
  )
}

function AccountOverview({
  accountName,
  connectionName,
  overview,
  error,
  onNavigate,
}: {
  accountName: string
  connectionName: string
  overview: RemoteRelayOverviewDto | null
  error: string
  onNavigate: (view: CenterView) => void
}) {
  const [notice, setNotice] = useState('')
  const preview = !overview
  const accountStatus = !overview
    ? '等待登录'
    : overview.account.status === null
      ? '服务端未返回状态'
      : overview.account.status === 1
        ? '状态正常'
        : `状态代码 ${overview.account.status}`
  return (
    <div className="uc-page">
      <PageHeading title="账户概览" description="管理公开资料、登录状态和账户安全。" />
      <RelayDataNotice label="账户摘要" error={error} />
      {notice && <div className="uc-inline-notice success"><CheckCircle2 size={15} /><span>{notice}</span><button type="button" onClick={() => setNotice('')}><Check size={13} />知道了</button></div>}
      <section className="uc-section account-summary">
        <div className="account-primary">
          <span className="uc-avatar xlarge">W</span>
          <div><h2>{accountName}</h2><p>{overview?.account.group ?? '未返回用户组'} · {accountStatus}</p></div>
          <button type="button" className="uc-secondary-button" onClick={() => setNotice('服务端当前未提供桌面端资料编辑契约，未发送任何账户修改。')}>编辑资料</button>
        </div>
        <dl className="account-details">
          <div><dt>账户标识</dt><dd className="uc-mono">{overview ? `#${overview.account.id}` : '由 Main 安全管理'}</dd></div>
          <div><dt>登录凭据</dt><dd>不暴露给 Renderer</dd></div>
          <div><dt>账户状态</dt><dd><span className={`uc-status ${preview ? 'warning' : overview?.account.status === 1 ? 'success' : 'warning'}`}>{accountStatus}</span></dd></div>
          <div><dt>默认渠道</dt><dd>{connectionName}</dd></div>
        </dl>
      </section>
      <section className="uc-section">
        <div className="uc-section-heading"><div><h2>账户安全</h2><p>本机凭据与私有历史由 Electron Main 安全管理</p></div></div>
        <div className="security-rows">
          <div><span className="security-icon"><ShieldCheck size={16} /></span><span><strong>本机安全存储</strong><small>当前用户 DPAPI · 原子写入 · 旧明文仅在加密迁移成功后读取</small></span><span className="uc-status success">已启用</span></div>
          <div><span className="security-icon"><KeyRound size={16} /></span><span><strong>访问令牌</strong><small>{overview ? '令牌仅以固定掩码进入 Renderer' : '登录后读取令牌掩码'}</small></span><button type="button" className="uc-text-button" onClick={() => onNavigate('tokens')}>管理</button></div>
          <div><span className="security-icon pending"><FileClock size={16} /></span><span><strong>最近登录</strong><small>服务端当前未提供桌面端登录记录契约</small></span><button type="button" className="uc-text-button" onClick={() => setNotice('未调用未核实的登录记录接口。')}>详情</button></div>
        </div>
      </section>
    </div>
  )
}

function TokensPage({
  authenticated,
  relayTokens,
  error,
  onChanged,
  onOpenTokenConsole,
}: {
  authenticated: boolean
  relayTokens: RemoteRelayTokenPageDto | null
  error: string
  onChanged: () => Promise<void>
  onOpenTokenConsole: () => void
}) {
  const [tokens, setTokens] = useState<SafeToken[]>(relayTokens?.items.map(tokenToSafeRow) ?? [])
  const [notice, setNotice] = useState<InlineNotice | null>(null)
  const [busyToken, setBusyToken] = useState<number | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState<SafeToken | null>(null)

  useEffect(() => {
    setTokens(relayTokens?.items.map(tokenToSafeRow) ?? [])
  }, [relayTokens])

  useEffect(() => {
    if (!confirmRevoke) return
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setConfirmRevoke(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [confirmRevoke])

  const updateTokenStatus = async (token: SafeToken, status: 'active' | 'disabled') => {
    if (!authenticated || !('onekey' in window)) {
      setNotice({ tone: 'error', text: '请先完成中转站设备登录。' })
      return
    }
    setBusyToken(token.id)
    const result = await window.onekey.relay.updateTokenStatus({ tokenId: token.id, status })
    setBusyToken(null)
    if (!result.ok) {
      setNotice({ tone: 'error', text: result.error.message })
      return
    }
    setTokens((current) => current.map((item) => item.id === result.value.tokenId ? { ...item, status: result.value.status } : item))
    await onChanged()
  }

  const revokeToken = async (token: SafeToken) => {
    setConfirmRevoke(null)
    if (!authenticated || !('onekey' in window)) {
      setNotice({ tone: 'error', text: '请先完成中转站设备登录。' })
      return
    }
    setBusyToken(token.id)
    const result = await window.onekey.relay.revokeToken({ tokenId: token.id, confirmation: 'revoke' })
    setBusyToken(null)
    if (!result.ok) {
      setNotice({ tone: 'error', text: result.error.message })
      return
    }
    setTokens((current) => current.filter((item) => item.id !== result.value.tokenId))
    setNotice({ tone: 'success', text: '访问令牌已撤销。' })
    await onChanged()
  }

  const copyMaskedToken = async (token: SafeToken) => {
    try {
      await navigator.clipboard.writeText(token.maskedKey)
      setNotice({ tone: 'success', text: '已复制显示掩码，不包含任何完整凭据。' })
    } catch {
      setNotice({ tone: 'error', text: '系统拒绝了剪贴板访问，请手动选择掩码文本。' })
    }
  }

  return (
    <div className="uc-page">
      <PageHeading
        title="访问令牌"
        description="查看真实令牌掩码，并在不再使用时停用或撤销。"
        action={<button type="button" className="uc-primary-button" onClick={onOpenTokenConsole}><ExternalLink size={14} />在网站新建</button>}
      />
      <RelayDataNotice label="访问令牌" error={error} />
      {notice && <div className={`uc-inline-notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.tone === 'error' ? <AlertCircle size={15} /> : notice.tone === 'success' ? <CheckCircle2 size={15} /> : <EyeOff size={15} />}<span>{notice.text}</span><button type="button" onClick={() => setNotice(null)}><Check size={13} />知道了</button></div>}
      <section className="uc-section">
        <div className="uc-section-heading"><div><h2>令牌列表</h2><p><EyeOff size={13} /> 所有凭据均为不可还原的显示掩码</p></div></div>
        <div className="uc-table-wrap">
          <table className="uc-table token-table">
            <thead><tr><th>名称</th><th>令牌</th><th>创建时间</th><th>最后使用</th><th>状态</th><th aria-label="操作" /></tr></thead>
            <tbody>{tokens.map((token) => (
              <tr key={token.id}>
                <td><strong>{token.name}</strong></td>
                <td><span className="masked-token"><EyeOff size={13} />{token.maskedKey}</span></td>
                <td>{token.createdAt}</td><td>{token.lastUsed}</td>
                <td><span className={`uc-status ${token.status === 'active' ? 'success' : token.status === 'disabled' ? 'warning' : 'muted'}`}>{token.status === 'active' ? '有效' : token.status === 'disabled' ? '已停用' : token.status === 'unavailable' ? '状态不可用' : '已撤销'}</span></td>
                <td className="table-actions">
                  <button type="button" aria-label="复制掩码" title="复制掩码" onClick={() => void copyMaskedToken(token)}><Copy size={14} /></button>
                  {(token.status === 'active' || token.status === 'disabled') && <button type="button" aria-label={token.status === 'active' ? '停用令牌' : '启用令牌'} title={token.status === 'active' ? '停用令牌' : '启用令牌'} disabled={busyToken === token.id} onClick={() => void updateTokenStatus(token, token.status === 'active' ? 'disabled' : 'active')}><Power size={14} /></button>}
                  {token.status !== 'revoked' && <button type="button" className="danger-action" aria-label="撤销令牌" title="撤销令牌" disabled={busyToken === token.id} onClick={() => setConfirmRevoke(token)}><Trash2 size={14} /></button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
          {tokens.length === 0 && <div className="uc-table-empty">{authenticated ? '当前账户没有可显示的访问令牌' : '登录后读取令牌列表'}</div>}
        </div>
      </section>
      {confirmRevoke && (
        <div className="uc-dialog-layer" role="presentation" onMouseDown={() => setConfirmRevoke(null)}>
          <div className="uc-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="revoke-title" onMouseDown={(event) => event.stopPropagation()}>
            <span className="uc-confirm-icon"><Trash2 size={18} /></span>
            <div><h2 id="revoke-title">撤销“{confirmRevoke.name}”？</h2><p>撤销后无法恢复。已使用该令牌的客户端会立即失去访问权限。</p></div>
            <div className="uc-confirm-actions"><button autoFocus type="button" className="uc-secondary-button" onClick={() => setConfirmRevoke(null)}>取消</button><button type="button" className="uc-danger-button" onClick={() => void revokeToken(confirmRevoke)}>确认撤销</button></div>
          </div>
        </div>
      )}
    </div>
  )
}

type UsagePeriod = '7d' | '30d'

function usageRange(period: UsagePeriod): { from: string; to: string } {
  const now = new Date()
  const to = now.toISOString()
  const days = period === '7d' ? 7 : 30
  return { from: new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString(), to }
}

function UsagePage({
  authenticated,
  relayUsage,
  pricing,
  billing,
  usageError,
  pricingError,
  billingError,
}: {
  authenticated: boolean
  relayUsage: RemoteRelayUsageDto | null
  pricing: RemoteRelayPricingDto | null
  billing: RemoteRelayBillingConfigDto | null
  usageError: string
  pricingError: string
  billingError: string
}) {
  const [period, setPeriod] = useState<UsagePeriod>('30d')
  const [model, setModel] = useState('all')
  const [currentUsage, setCurrentUsage] = useState<RemoteRelayUsageDto | null>(relayUsage)
  const [currentUsageError, setCurrentUsageError] = useState(usageError)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<InlineNotice | null>(null)

  useEffect(() => setCurrentUsage(relayUsage), [relayUsage])
  useEffect(() => setCurrentUsageError(usageError), [usageError])

  const modelNames = useMemo(() => new Set([
    ...(pricing?.models.map((entry) => entry.modelName) ?? []),
    ...(currentUsage?.records.map((entry) => entry.modelName) ?? []),
  ]), [pricing, currentUsage])

  const selectPeriod = async (nextPeriod: UsagePeriod) => {
    setPeriod(nextPeriod)
    setNotice(null)
    if (!authenticated || !('onekey' in window)) {
      setNotice({ tone: 'error', text: '请先完成中转站设备登录。' })
      return
    }
    setBusy(true)
    const range = usageRange(nextPeriod)
    const result = await readRelayValue(
      () => window.onekey.relay.listUsage(range),
      '用量明细读取失败，请重试。',
    )
    setBusy(false)
    if (!result.value) {
      setCurrentUsageError(result.error)
      setNotice({ tone: 'error', text: result.error })
      return
    }
    setCurrentUsage(result.value)
    setCurrentUsageError('')
  }

  const rows = useMemo(() => {
    const records = currentUsage?.records ?? []
    return records
      .filter((record) => model === 'all' || record.modelName === model)
      .map((record, index) => ({
        key: `${record.createdAt}-${record.modelName}-${index}`,
        date: new Date(record.createdAt).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }),
        model: record.modelName,
        requests: record.requests,
        tokens: record.tokenUsed,
        quota: record.quota,
      }))
  }, [currentUsage, model])

  const total = rows.reduce((summary, row) => ({
    requests: summary.requests + row.requests,
    tokens: summary.tokens + row.tokens,
    quota: summary.quota + row.quota,
  }), { requests: 0, tokens: 0, quota: 0 })

  return (
    <div className="uc-page">
      <PageHeading title="用量明细" description="按服务端记录核对请求、总 Token 与计费额度；不读取提示词、文件名或本地路径。" action={<button type="button" className="uc-secondary-button" onClick={() => setNotice({ tone: 'neutral', text: 'CSV 导出需要先接入经过用户确认的保存位置，当前保持关闭。' })}><Download size={14} />导出 CSV</button>} />
      <RelayDataNotice label="用量明细" error={currentUsageError} />
      <RelayDataNotice label="模型目录" error={pricingError} />
      <RelayDataNotice label="计费配置" error={billingError} />
      {notice && <div className={`uc-inline-notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.tone === 'error' ? <AlertCircle size={15} /> : <EyeOff size={15} />}<span>{notice.text}</span><button type="button" onClick={() => setNotice(null)}><Check size={13} />知道了</button></div>}
      <div className="uc-filterbar">
        <div className="uc-segmented" aria-label="用量周期"><button type="button" className={period === '7d' ? 'active' : ''} disabled={busy} onClick={() => void selectPeriod('7d')}>近 7 天</button><button type="button" className={period === '30d' ? 'active' : ''} disabled={busy} onClick={() => void selectPeriod('30d')}>近 30 天</button></div>
        <label className="uc-select"><SlidersHorizontal size={14} /><select value={model} onChange={(event) => setModel(event.target.value)}><option value="all">全部模型</option>{[...modelNames].sort().map((entry) => <option key={entry} value={entry}>{entry}</option>)}</select><ChevronDown size={13} /></label>
      </div>
      <section className="uc-section">
        <div className="uc-table-wrap"><table className="uc-table usage-table"><thead><tr><th>日期</th><th>模型</th><th>请求</th><th>总 Token</th><th>计费额度</th></tr></thead><tbody>{rows.map((row) => <tr key={row.key}><td>{row.date}</td><td><strong>{row.model}</strong></td><td>{formatInteger(row.requests)}</td><td>{formatInteger(row.tokens)}</td><td><strong>{formatQuota(row.quota, billing)}</strong></td></tr>)}</tbody><tfoot><tr><td colSpan={2}>{busy ? '读取中...' : '当前筛选合计'}</td><td>{formatInteger(total.requests)}</td><td>{formatInteger(total.tokens)}</td><td>{formatQuota(total.quota, billing)}</td></tr></tfoot></table>{rows.length === 0 && <div className="uc-table-empty">{authenticated ? '当前筛选没有用量记录' : '登录后读取真实用量记录'}</div>}</div>
      </section>
    </div>
  )
}

function PricingPage({ pricing, error }: { pricing: RemoteRelayPricingDto | null; error: string }) {
  const [query, setQuery] = useState('')
  const rows = useMemo(() => pricing?.models.map((entry) => ({
    model: entry.modelName,
    owner: entry.owner || '未返回',
    billing: entry.billingMode || (entry.quotaType === 1 ? '固定价格' : '倍率计费'),
    base: entry.quotaType === 1 ? String(entry.modelPrice) : `${entry.modelRatio}x`,
    completion: `${entry.completionRatio}x`,
    cache: entry.cacheRatio === null ? '—' : `${entry.cacheRatio}x`,
    groups: entry.enabledGroups.join(', ') || '—',
  })) ?? [], [pricing])
  const filtered = useMemo(() => rows.filter((row) => `${row.model} ${row.owner} ${row.groups}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [query, rows])
  const pricingDescription = pricing
    ? `显示服务端原始计费倍率与固定价格字段${pricing.pricingVersion ? `；版本 ${pricing.pricingVersion}` : ''}。`
    : '连接并登录后读取服务端实时价格目录，不使用本地推测价格。'
  return (
    <div className="uc-page">
      <PageHeading title="模型价格" description={pricingDescription} />
      <RelayDataNotice label="模型价格" error={error} />
      <div className="uc-filterbar pricing-filter"><label className="uc-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型或能力" /></label><span>共 {filtered.length} 个模型</span></div>
      <section className="uc-section"><div className="uc-table-wrap"><table className="uc-table pricing-table"><thead><tr><th>模型</th><th>提供方</th><th>计费模式</th><th>基础字段</th><th>补全倍率</th><th>缓存倍率</th><th>可用分组</th></tr></thead><tbody>{filtered.map((row) => <tr key={`${row.model}-${row.owner}`}><td><strong>{row.model}</strong></td><td><span className="uc-mono muted">{row.owner}</span></td><td>{row.billing}</td><td>{row.base}</td><td>{row.completion}</td><td>{row.cache}</td><td>{row.groups}</td></tr>)}</tbody></table>{filtered.length === 0 && <div className="uc-table-empty">{pricing ? '没有匹配的模型' : '尚未读取价格目录'}</div>}</div></section>
    </div>
  )
}

function RedeemPage({
  authenticated,
  billing,
  overview,
  billingError,
  overviewError,
  onRefresh,
  onOpenTopup,
}: {
  authenticated: boolean
  billing: RemoteRelayBillingConfigDto | null
  overview: RemoteRelayOverviewDto | null
  billingError: string
  overviewError: string
  onRefresh: () => Promise<void>
  onOpenTopup: () => void
}) {
  const [code, setCode] = useState('')
  const [result, setResult] = useState<InlineNotice | null>(null)
  const [busy, setBusy] = useState(false)
  const [balance, setBalance] = useState(overview?.quota.remaining ?? null)

  useEffect(() => setBalance(overview?.quota.remaining ?? null), [overview])

  const redeem = async () => {
    if (!code.trim()) return
    setResult(null)
    if (!authenticated || !('onekey' in window)) {
      setResult({ tone: 'error', text: '请先完成中转站设备登录。' })
      return
    }
    setBusy(true)
    const response = await window.onekey.relay.redeem({ code: code.trim() })
    setBusy(false)
    if (!response.ok) {
      setResult({ tone: 'error', text: response.error.message })
      return
    }
    setCode('')
    const creditedQuota = formatQuota(response.value.creditedQuota, billing)
    setResult({
      tone: 'success',
      text: creditedQuota === '—'
        ? '兑换成功，账户余额已更新。'
        : `兑换成功，账户增加 ${creditedQuota}。`,
    })
    await onRefresh()
  }
  return (
    <div className="uc-page">
      <PageHeading title="充值兑换" description="使用兑换码增加服务端账户额度。" />
      <RelayDataNotice label="账户余额" error={overviewError} />
      <RelayDataNotice label="计费配置" error={billingError} />
      <section className="balance-band"><div><span>当前可用额度</span><strong>{formatQuota(balance, billing)}</strong><small>{authenticated ? '按网站当前计费配置换算' : '登录后读取真实额度'}</small></div><button type="button" className="uc-secondary-button" onClick={onOpenTopup}><CreditCard size={14} />充值方式</button></section>
      <section className="uc-section redeem-section">
        <div className="uc-section-heading"><div><h2>兑换码</h2><p>兑换成功后余额会立即更新</p></div></div>
        <div className="redeem-form"><Gift size={18} /><input value={code} onChange={(event) => { setCode(event.target.value); setResult(null) }} placeholder="输入兑换码" aria-label="兑换码" autoComplete="off" /><button type="button" className="uc-primary-button" onClick={() => void redeem()} disabled={!code.trim() || busy}>{busy ? '兑换中' : '立即兑换'}</button></div>
        {result && <div className={`uc-inline-notice ${result.tone}`} role={result.tone === 'error' ? 'alert' : 'status'}>{result.tone === 'error' ? <AlertCircle size={15} /> : <CheckCircle2 size={15} />}<span>{result.text}</span></div>}
      </section>
      <section className="uc-section"><div className="uc-section-heading"><div><h2>入账记录</h2><p>服务端当前未提供已核实的桌面端入账记录契约</p></div></div><div className="privacy-note"><Wallet size={15} /><span>这里不会显示示例账单。完整充值与兑换记录请通过上方“充值方式”进入网站后查看。</span></div></section>
    </div>
  )
}

function PreferenceToggle({
  label,
  detail,
  value,
  disabled = false,
  onChange,
}: {
  label: string
  detail: string
  value: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
}) {
  return <div className="preference-row"><span><strong>{label}</strong><small>{detail}</small></span><button type="button" role="switch" aria-label={label} aria-checked={value} disabled={disabled} className={`uc-switch ${value ? 'on' : ''}`} onClick={() => onChange(!value)}><span /></button></div>
}

function PreferencesPage({
  compact,
  onCompactChange,
}: {
  compact: boolean
  onCompactChange: (value: boolean) => void
}) {
  const [notice, setNotice] = useState<InlineNotice | null>(null)
  return (
    <div className="uc-page">
      <PageHeading title="偏好设置" description="调整当前用户中心显示，不改变 Agent 或中转站的安全边界。" />
      {notice && <div className={`uc-inline-notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.tone === 'error' ? <AlertCircle size={15} /> : notice.tone === 'success' ? <CheckCircle2 size={15} /> : <EyeOff size={15} />}<span>{notice.text}</span><button type="button" onClick={() => setNotice(null)}><Check size={13} />知道了</button></div>}
      <section className="uc-section preference-section"><div className="uc-section-heading"><div><h2><SlidersHorizontal size={15} /> 显示</h2><p>当前会话的用户中心显示</p></div></div><PreferenceToggle label="紧凑数据表" detail="在相同高度内显示更多行" value={compact} onChange={(value) => { onCompactChange(value); setNotice({ tone: 'neutral', text: '显示密度已应用到当前用户中心会话。' }) }} /><div className="preference-row"><span><strong>界面语言</strong><small>英文资源尚未完成，当前固定为简体中文</small></span><label className="uc-select"><Languages size={14} /><select aria-label="界面语言" value="zh-CN" disabled><option value="zh-CN">简体中文</option></select><ChevronDown size={13} /></label></div></section>
      <section className="uc-section preference-section"><div className="uc-section-heading"><div><h2><Bell size={15} /> 中转站偏好</h2><p>当前服务端没有与旧预览字段对应的桌面端契约</p></div></div><div className="privacy-note"><AlertCircle size={15} /><span>余额预警、邮件摘要、显示币种和预算不会在客户端伪造或写入未知字段；请在网站账户设置中管理。</span></div></section>
      <section className="uc-section preference-section"><div className="uc-section-heading"><div><h2><ShieldCheck size={15} /> 隐私</h2><p>诊断上传尚未接入并保持关闭</p></div></div><PreferenceToggle label="匿名性能诊断" detail="等待统一脱敏、用户确认与可审计上传实现" value={false} disabled onChange={() => undefined} /><div className="privacy-note"><EyeOff size={15} /><span>API 密钥与本地对话历史使用当前用户 DPAPI 加密并原子写入。匿名诊断保持关闭；对话内容只会在确认精确模型 endpoint 后发送。</span></div></section>
    </div>
  )
}

export default function UserCenter({
  onBack,
  accountDisplayName = '已登录用户',
  connectionName = 'wzh-server',
  endpoint = WZH_MODEL_BASE_URL,
  onAccountIdentityChange,
}: UserCenterProps) {
  const { lockAfterSignOut } = useDesktopSession()
  const [active, setActive] = useState<CenterView>('relay')
  const [globalNotice, setGlobalNotice] = useState<InlineNotice | null>(null)
  const [compactTables, setCompactTables] = useState(true)
  const relay = useRelayData()
  const relayOrigin = relay.connection?.endpoint ?? endpoint
  const accountName = relay.overview
    ? relayAccountName(relay.overview.account)
    : accountDisplayName

  useEffect(() => {
    if (!relay.overview) return
    onAccountIdentityChange?.(relayAccountName(relay.overview.account))
  }, [onAccountIdentityChange, relay.overview])

  const openExternal = async (pathname: string, fallbackMessage: string) => {
    const url = relayPublicUrl(relayOrigin, pathname)
    if (!url) {
      setGlobalNotice({ tone: 'error', text: '中转站公开地址无效，未打开外部链接。' })
      return
    }
    if (!('onekey' in window)) {
      setGlobalNotice({ tone: 'neutral', text: fallbackMessage })
      return
    }
    const result = await window.onekey.link.openExternal(url)
    if (!result.ok) {
      setGlobalNotice({ tone: result.error.code === 'cancelled' ? 'neutral' : 'error', text: result.error.message })
    }
  }

  const signOut = async () => {
    const cleared = await relay.signOut()
    if (cleared) {
      if (lockAfterSignOut()) return
      setGlobalNotice({ tone: 'success', text: '本机中转站登录凭据已使用 DPAPI 加密 tombstone 清除。' })
      return
    }
    setGlobalNotice({ tone: 'error', text: '无法安全清除本机中转站登录凭据。' })
  }

  return (
    <div className={`user-center ${compactTables ? 'compact-tables' : ''}`}>
      <CenterHeader onBack={onBack} displayName={accountName} onOpenAccount={() => setActive('account')} />
      <div className="user-center-layout">
        <CenterSidebar
          active={active}
          connection={relay.connection}
          accountName={accountName}
          loading={relay.loading}
          onChange={setActive}
          onOpenDocs={() => void openExternal('/docs', '服务文档只会在 Electron 中经过确认后由系统浏览器打开。')}
          onSignOut={() => void signOut()}
        />
        <main className="user-center-main">
          {globalNotice && <div className={`uc-global-notice ${globalNotice.tone}`} role={globalNotice.tone === 'error' ? 'alert' : 'status'}>{globalNotice.tone === 'error' ? <AlertCircle size={15} /> : <EyeOff size={15} />}<span>{globalNotice.text}</span><button type="button" aria-label="关闭提示" onClick={() => setGlobalNotice(null)}><Check size={14} /></button></div>}
          {active === 'account' && <AccountOverview accountName={accountName} connectionName={connectionName} overview={relay.overview} error={relay.dataErrors.overview} onNavigate={setActive} />}
          {active === 'relay' && <RelayOverview endpoint={relayOrigin} connectionName={connectionName} connection={relay.connection} authorization={relay.authorization} billing={relay.billing} overview={relay.overview} usage={relay.usage} pricing={relay.pricing} loading={relay.loading} error={relay.error} dataErrors={relay.dataErrors} onConnect={relay.connect} onRefresh={relay.refresh} onNavigate={setActive} />}
          {active === 'tokens' && <TokensPage authenticated={Boolean(relay.connection?.authenticated)} relayTokens={relay.tokens} error={relay.dataErrors.tokens} onChanged={relay.refresh} onOpenTokenConsole={() => void openExternal('/console/token', '访问令牌页面只会在 Electron 中经过确认后由系统浏览器打开。')} />}
          {active === 'usage' && <UsagePage authenticated={Boolean(relay.connection?.authenticated)} relayUsage={relay.usage} pricing={relay.pricing} billing={relay.billing} usageError={relay.dataErrors.usage} pricingError={relay.dataErrors.pricing} billingError={relay.dataErrors.billing} />}
          {active === 'pricing' && <PricingPage pricing={relay.pricing} error={relay.dataErrors.pricing} />}
          {active === 'redeem' && <RedeemPage authenticated={Boolean(relay.connection?.authenticated)} billing={relay.billing} overview={relay.overview} billingError={relay.dataErrors.billing} overviewError={relay.dataErrors.overview} onRefresh={relay.refresh} onOpenTopup={() => void openExternal('/console/topup', '充值页面只会在 Electron 中经过确认后由系统浏览器打开。')} />}
          {active === 'preferences' && <PreferencesPage compact={compactTables} onCompactChange={setCompactTables} />}
        </main>
      </div>
    </div>
  )
}
