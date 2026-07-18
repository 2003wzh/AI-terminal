import {
  Archive,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  Cloud,
  GitBranch,
  GitFork,
  Globe2,
  Keyboard,
  KeyRound,
  Link2,
  LoaderCircle,
  Mic,
  Monitor,
  Plug,
  RefreshCw,
  Search,
  Save,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  Sun,
  Webhook,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'

import type {
  PublicAccessProfile,
  WorkspaceOpenerDescriptor,
  WorkspaceOpenerId,
} from '../../shared/contracts'

import './settings.css'

export type SettingsPermission = 'ask' | 'auto' | 'full'

export type SettingsView =
  | 'general'
  | 'appearance'
  | 'voice'
  | 'configuration'
  | 'personalization'
  | 'shortcuts'
  | 'account'
  | 'plugins'
  | 'browser'
  | 'computer'
  | 'hooks'
  | 'connections'
  | 'git'
  | 'environment'
  | 'worktrees'
  | 'archived'

export type SettingsPreferences = {
  defaultOpener: WorkspaceOpenerId | 'none'
  agentEnvironment: 'windows' | 'wsl'
  shell: 'powershell' | 'cmd'
  density: 'compact' | 'comfortable'
  reduceMotion: boolean
  showBottomPanel: boolean
  suggestions: boolean
  customInstructions: string
  responseLanguage: 'zh-CN' | 'auto'
  gitBase: 'current' | 'main'
  worktreeMode: 'ask' | 'always' | 'never'
}

export const DEFAULT_SETTINGS_PREFERENCES: SettingsPreferences = {
  defaultOpener: 'vscode',
  agentEnvironment: 'windows',
  shell: 'powershell',
  density: 'comfortable',
  reduceMotion: false,
  showBottomPanel: true,
  suggestions: true,
  customInstructions: '',
  responseLanguage: 'zh-CN',
  gitBase: 'current',
  worktreeMode: 'ask',
}

const knownWorkspaceOpeners: WorkspaceOpenerDescriptor[] = [
  { id: 'vscode', label: 'VS Code', kind: 'editor' },
  { id: 'visual-studio', label: 'Visual Studio', kind: 'editor' },
  { id: 'cursor', label: 'Cursor', kind: 'editor' },
  { id: 'github-desktop', label: 'GitHub Desktop', kind: 'git' },
  { id: 'explorer', label: '文件资源管理器', kind: 'file-manager' },
  { id: 'terminal', label: 'Windows Terminal', kind: 'terminal' },
  { id: 'wsl', label: 'WSL', kind: 'terminal' },
  { id: 'pycharm', label: 'PyCharm', kind: 'editor' },
]

export type SettingsProps = {
  onBack: () => void
  onOpenUserCenter: () => void
  activeView: SettingsView
  onActiveViewChange: (view: SettingsView) => void
  permission: SettingsPermission
  onPermissionChange: (permission: SettingsPermission) => void
  webSearch: boolean
  onWebSearchChange: (enabled: boolean) => void
  webSearchAvailable: boolean
  imageGeneration: boolean
  onImageGenerationChange: (enabled: boolean) => void
  imageGenerationAvailable: boolean
  modelCompatibilityNotice: string
  preferences: SettingsPreferences
  onPreferencesChange: (patch: Partial<SettingsPreferences>) => void
  workspaceOpeners: readonly WorkspaceOpenerDescriptor[]
  workspaceOpenersDetected: boolean
  displayName: string
  endpoint: string
  profileHandle: string
  profileHasKey: boolean
  onProfileSaved: (profile: PublicAccessProfile) => void
  modelCount: number
  modelCatalogState: 'preview' | 'idle' | 'loading' | 'remote' | 'error'
  modelCatalogMessage: string
  onRefreshModels: () => Promise<{ ok: boolean; message: string }>
}

type NavigationItem = {
  id: SettingsView
  label: string
  icon: LucideIcon
  keywords: string
}

const navigationGroups: Array<{ id: string; label: string; items: NavigationItem[] }> = [
  {
    id: 'personal',
    label: '个人',
    items: [
      { id: 'general', label: '常规', icon: Settings2, keywords: '权限 审批 文件 终端 语言' },
      { id: 'appearance', label: '外观', icon: Sun, keywords: '主题 密度 动画 面板' },
      { id: 'voice', label: '语音', icon: Mic, keywords: '麦克风 输入 听写' },
      { id: 'configuration', label: '配置', icon: SlidersHorizontal, keywords: '模型 渠道 API key' },
      { id: 'personalization', label: '个性化', icon: Sparkles, keywords: '自定义 指令 回复 语言' },
      { id: 'shortcuts', label: '键盘快捷键', icon: Keyboard, keywords: '快捷键 命令 键盘' },
      { id: 'account', label: '账户', icon: CircleUserRound, keywords: '用户 中转站 余额 令牌' },
    ],
  },
  {
    id: 'integrations',
    label: '集成',
    items: [
      { id: 'plugins', label: '插件', icon: Plug, keywords: 'MCP 扩展 skill' },
      { id: 'browser', label: '浏览器', icon: Globe2, keywords: '联网 搜索 web browser' },
      { id: 'computer', label: '电脑操控', icon: Monitor, keywords: '桌面 控制 屏幕 自动化' },
    ],
  },
  {
    id: 'coding',
    label: '编码',
    items: [
      { id: 'hooks', label: '钩子', icon: Webhook, keywords: 'hook 生命周期 脚本' },
      { id: 'connections', label: '连接', icon: Link2, keywords: 'endpoint server 中转站' },
      { id: 'git', label: 'Git', icon: GitBranch, keywords: '分支 diff 提交' },
      { id: 'environment', label: '环境', icon: SquareTerminal, keywords: 'shell PowerShell Windows WSL' },
      { id: 'worktrees', label: '工作树', icon: GitFork, keywords: 'worktree 分支 隔离' },
    ],
  },
  {
    id: 'archive',
    label: '已归档',
    items: [
      { id: 'archived', label: '已归档任务', icon: Archive, keywords: '历史 任务 恢复' },
    ],
  },
]

type Notice = { tone: 'neutral' | 'success' | 'warning'; text: string }

function SettingsSwitch({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      className={`settings-switch ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}

function SettingsSelect({
  label,
  value,
  disabled = false,
  className = '',
  title,
  children,
  onChange,
}: {
  label: string
  value: string
  disabled?: boolean
  className?: string
  title?: string
  children: ReactNode
  onChange: (value: string) => void
}) {
  return (
    <label className={`settings-select${className ? ` ${className}` : ''}`} title={title}>
      <select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
      <ChevronDown size={14} aria-hidden="true" />
    </label>
  )
}

function SettingsRow({
  title,
  description,
  control,
}: {
  title: string
  description: string
  control: ReactNode
}) {
  return (
    <div className="settings-row">
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <div className="settings-row-control">{control}</div>
    </div>
  )
}

function SettingsSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <div className="settings-section-heading">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      <div className="settings-group-card">{children}</div>
    </section>
  )
}

function StatusPill({ tone = 'neutral', children }: { tone?: 'neutral' | 'success' | 'warning'; children: ReactNode }) {
  return <span className={`settings-status ${tone}`}>{children}</span>
}

function ActionButton({ children, onClick, disabled = false }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button type="button" className="settings-action" disabled={disabled} onClick={onClick}>{children}</button>
}

function PageTitle({ title, description }: { title: string; description?: string }) {
  return (
    <div className="settings-page-title">
      <h1>{title}</h1>
      {description && <p>{description}</p>}
    </div>
  )
}

const permissionOptions: Array<{ id: SettingsPermission; title: string; description: string; note: string }> = [
  {
    id: 'ask',
    title: '请求批准',
    description: 'Agent 的目录枚举、文件读取、写入与 Git 摘要逐次请求批准；远端 endpoint 在每次应用会话中另行确认。',
    note: '推荐',
  },
  {
    id: 'auto',
    title: '替我审批',
    description: '自动批准工作区内低风险读取；写入仍需人工确认，endpoint 与路径边界不会放宽。',
    note: '受保护',
  },
  {
    id: 'full',
    title: '完全访问',
    description: '允许在所选工作区内减少目录和文件工具确认；凭据保护、敏感文件与路径边界始终有效，命令和终端尚未开放。',
    note: '重启后重置',
  },
]

export default function SettingsPage({
  onBack,
  onOpenUserCenter,
  activeView,
  onActiveViewChange,
  permission,
  onPermissionChange,
  webSearch,
  onWebSearchChange,
  webSearchAvailable,
  imageGeneration,
  onImageGenerationChange,
  imageGenerationAvailable,
  modelCompatibilityNotice,
  preferences,
  onPreferencesChange,
  workspaceOpeners,
  workspaceOpenersDetected,
  displayName,
  endpoint,
  profileHandle,
  profileHasKey,
  onProfileSaved,
  modelCount,
  modelCatalogState,
  modelCatalogMessage,
  onRefreshModels,
}: SettingsProps) {
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)
  const [connectionName, setConnectionName] = useState(displayName)
  const [connectionEndpoint, setConnectionEndpoint] = useState(endpoint)
  const [connectionApiKey, setConnectionApiKey] = useState('')
  const [savingConnection, setSavingConnection] = useState(false)

  const defaultOpenerOptions = useMemo(() => {
    if (!workspaceOpenersDetected) return []
    if (preferences.defaultOpener === 'none' || workspaceOpeners.some((entry) => entry.id === preferences.defaultOpener)) {
      return [...workspaceOpeners]
    }
    const selected = knownWorkspaceOpeners.find((entry) => entry.id === preferences.defaultOpener)
    return selected ? [...workspaceOpeners, { ...selected, label: `${selected.label}（当前不可用）` }] : [...workspaceOpeners]
  }, [preferences.defaultOpener, workspaceOpeners, workspaceOpenersDetected])

  const pendingDefaultOpener = !workspaceOpenersDetected && preferences.defaultOpener !== 'none'
    ? knownWorkspaceOpeners.find((entry) => entry.id === preferences.defaultOpener) ?? null
    : null
  const selectedDefaultOpenerLabel = pendingDefaultOpener
    ? `${pendingDefaultOpener.label}（尚未检测）`
    : preferences.defaultOpener === 'none'
      ? '每次显示菜单'
      : defaultOpenerOptions.find((entry) => entry.id === preferences.defaultOpener)?.label

  const filteredGroups = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return navigationGroups
    return navigationGroups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => `${item.label} ${item.keywords}`.toLocaleLowerCase().includes(normalized)),
      }))
      .filter((group) => group.items.length > 0)
  }, [query])

  useEffect(() => {
    const visibleItems = filteredGroups.flatMap((group) => group.items)
    const firstVisible = visibleItems[0]
    if (firstVisible && !visibleItems.some((item) => item.id === activeView)) onActiveViewChange(firstVisible.id)
  }, [activeView, filteredGroups, onActiveViewChange])

  useEffect(() => {
    if (!confirmFullAccess) return
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setConfirmFullAccess(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [confirmFullAccess])

  useEffect(() => {
    setConnectionName(displayName)
    setConnectionEndpoint(endpoint)
    setConnectionApiKey('')
  }, [displayName, endpoint, profileHandle])

  const selectPermission = (next: SettingsPermission) => {
    if (next === 'full' && permission !== 'full') {
      setConfirmFullAccess(true)
      return
    }
    onPermissionChange(next)
    setNotice({ tone: next === 'ask' ? 'success' : 'warning', text: `默认批准模式已切换为“${permissionOptions.find((option) => option.id === next)?.title}”。` })
  }

  const sessionOnlyNotice = (label: string) => {
    setNotice({ tone: 'neutral', text: `${label}仅保留在当前应用会话，设置偏好持久化接入前不会写入磁盘。` })
  }

  const saveConnection = async () => {
    const name = connectionName.trim()
    const baseUrl = connectionEndpoint.trim()
    const apiKey = connectionApiKey.trim()
    if (!name || !baseUrl || (!profileHasKey && !apiKey)) {
      setNotice({ tone: 'warning', text: '请填写渠道名称、endpoint 和 API Key。' })
      return
    }
    if (!('onekey' in window)) {
      setConnectionApiKey('')
      setNotice({ tone: 'warning', text: '浏览器预览不会接收或保存 API Key，请在 Electron 客户端中配置。' })
      return
    }

    setSavingConnection(true)
    try {
      const result = await window.onekey.profile.save({
        ...(profileHandle.startsWith('profile:') ? { credentialHandle: profileHandle } : {}),
        name,
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
        targets: ['codex'],
      })
      if (!result.ok) {
        setNotice({ tone: 'warning', text: result.error.message })
        return
      }
      onProfileSaved(result.value)
      setNotice({ tone: 'success', text: '渠道已使用 Windows 当前用户加密安全保存；尚未发起网络请求。' })
    } catch {
      setNotice({ tone: 'warning', text: '渠道保存未完成，API Key 已从页面清除，请重试。' })
    } finally {
      setConnectionApiKey('')
      setSavingConnection(false)
    }
  }

  const refreshModels = async () => {
    try {
      const result = await onRefreshModels()
      setNotice({ tone: result.ok ? 'success' : 'warning', text: result.message })
    } catch {
      setNotice({ tone: 'warning', text: '模型目录请求未完成，请重试。' })
    }
  }

  const generalPage = (
    <>
      <PageTitle title="常规" />
      <section className="settings-section permission-section">
        <div className="settings-section-heading"><h2>权限</h2></div>
        <div className="permission-choice-list" role="radiogroup" aria-label="默认批准模式">
          {permissionOptions.map((option) => (
            <button
              type="button"
              role="radio"
              aria-checked={permission === option.id}
              className={`permission-choice ${permission === option.id ? 'selected' : ''}`}
              key={option.id}
              onClick={() => selectPermission(option.id)}
            >
              <span><strong>{option.title}</strong><small>{option.description}</small></span>
              <span className="permission-choice-meta"><em>{option.note}</em><i>{permission === option.id && <Check size={14} />}</i></span>
            </button>
          ))}
        </div>
      </section>

      <SettingsSection title="常规" description="用于下一次工作区操作的会话默认值">
        <SettingsRow title="默认文件打开目标" description={workspaceOpenersDetected ? '仅列出这台电脑当前可用的打开方式' : '尚未检测本机应用；展开工作区的打开位置菜单后同步'} control={
          <SettingsSelect className="workspace-opener-select" label="默认文件打开目标" title={selectedDefaultOpenerLabel} value={preferences.defaultOpener} onChange={(value) => { onPreferencesChange({ defaultOpener: value as SettingsPreferences['defaultOpener'] }); sessionOnlyNotice('文件打开目标') }}>
            <option value="none">每次显示菜单</option>
            {pendingDefaultOpener && (
              <option value={pendingDefaultOpener.id} disabled>{pendingDefaultOpener.label}（尚未检测）</option>
            )}
            {defaultOpenerOptions.map((opener) => (
              <option
                key={opener.id}
                value={opener.id}
                disabled={workspaceOpenersDetected && !workspaceOpeners.some((entry) => entry.id === opener.id)}
              >
                {opener.label}
              </option>
            ))}
          </SettingsSelect>
        } />
        <SettingsRow title="智能体环境" description="当前只保存会话选择；Agent 文件工具由 Electron Main 限定在所选 Windows 工作区内" control={
          <SettingsSelect label="智能体环境" value={preferences.agentEnvironment} onChange={(value) => { onPreferencesChange({ agentEnvironment: value as SettingsPreferences['agentEnvironment'] }); sessionOnlyNotice('智能体环境') }}>
            <option value="windows">Windows 原生</option><option value="wsl">WSL（待接入）</option>
          </SettingsSelect>
        } />
        <SettingsRow title="集成终端 Shell" description="终端运行时尚未连接，当前仅保存会话选择" control={
          <SettingsSelect label="集成终端 Shell" value={preferences.shell} onChange={(value) => { onPreferencesChange({ shell: value as SettingsPreferences['shell'] }); sessionOnlyNotice('终端 Shell') }}>
            <option value="powershell">PowerShell</option><option value="cmd">Command Prompt</option>
          </SettingsSelect>
        } />
        <SettingsRow title="界面语言" description="英文资源尚未完成，当前固定为简体中文" control={
          <SettingsSelect label="界面语言" value="zh-CN" disabled onChange={() => undefined}><option value="zh-CN">简体中文</option></SettingsSelect>
        } />
        <SettingsRow title="底部面板" description="保留终端、Diff 和文件面板的当前打开状态" control={
          <SettingsSwitch label="底部面板" checked={preferences.showBottomPanel} onChange={(checked) => onPreferencesChange({ showBottomPanel: checked })} />
        } />
        <SettingsRow title="建议提示" description="在空任务和待处理结果中显示下一步建议" control={
          <SettingsSwitch label="建议提示" checked={preferences.suggestions} onChange={(checked) => onPreferencesChange({ suggestions: checked })} />
        } />
      </SettingsSection>

      <SettingsSection title="应用" description="导入、许可与更新状态">
        <SettingsRow title="导入的智能体设置" description="导入需要一次性文件批准；当前没有读取本地配置" control={<ActionButton onClick={() => setNotice({ tone: 'neutral', text: '设置导入会在加密存储和一次性文件批准接入后开放。' })}>再次导入</ActionButton>} />
        <SettingsRow title="开源许可证" description="Electron、React 与运行时依赖许可" control={<ActionButton onClick={() => setNotice({ tone: 'neutral', text: '许可清单会随正式安装包一并提供。' })}>查看</ActionButton>} />
        <SettingsRow title="应用更新" description="当前预览版不会静默联网检查更新" control={<ActionButton onClick={() => setNotice({ tone: 'neutral', text: '自动更新尚未接入；未发起网络请求。' })}><RefreshCw size={14} />检查更新</ActionButton>} />
      </SettingsSection>
    </>
  )

  const appearancePage = (
    <>
      <PageTitle title="外观" description="调整当前应用会话的视觉密度和动效。" />
      <SettingsSection title="界面">
        <SettingsRow title="主题" description="当前采用 AI终点站玻璃深色工作台" control={<SettingsSelect label="主题" value="glass-dark" disabled onChange={() => undefined}><option value="glass-dark">玻璃深色</option></SettingsSelect>} />
        <SettingsRow title="界面密度" description="控制设置列表和工具面的行高" control={<SettingsSelect label="界面密度" value={preferences.density} onChange={(value) => onPreferencesChange({ density: value as SettingsPreferences['density'] })}><option value="compact">紧凑</option><option value="comfortable">舒适</option></SettingsSelect>} />
        <SettingsRow title="减少动画" description="停用非必要的过渡和旋转动画" control={<SettingsSwitch label="减少动画" checked={preferences.reduceMotion} onChange={(checked) => onPreferencesChange({ reduceMotion: checked })} />} />
        <SettingsRow title="品牌强调色" description="工作区使用赤陶红，连接和成功状态使用绿色" control={<div className="settings-swatches" aria-label="品牌强调色"><span className="brand" /><span className="success" /><span className="focus" /></div>} />
      </SettingsSection>
    </>
  )

  const voicePage = (
    <>
      <PageTitle title="语音" description="语音输入需要独立的设备批准和本地转写策略。" />
      <SettingsSection title="语音输入">
        <SettingsRow title="启用语音输入" description="麦克风授权和转写运行时尚未接入" control={<SettingsSwitch label="启用语音输入" checked={false} disabled onChange={() => undefined} />} />
        <SettingsRow title="输入设备" description="未读取系统设备列表" control={<SettingsSelect label="输入设备" value="none" disabled onChange={() => undefined}><option value="none">未配置</option></SettingsSelect>} />
        <SettingsRow title="转写位置" description="默认要求本地处理；不会把音频上传到未知 endpoint" control={<StatusPill tone="warning">待接入</StatusPill>} />
      </SettingsSection>
    </>
  )

  const configurationPage = (
    <>
      <PageTitle title="配置" description="管理公开渠道信息、模型目录和本机凭据状态。" />
      <SettingsSection title="模型与渠道">
        <SettingsRow title="当前渠道" description={`${displayName} · ${endpoint}`} control={<ActionButton onClick={onOpenUserCenter}>打开用户中心<ChevronRight size={14} /></ActionButton>} />
        <SettingsRow title="模型目录" description={modelCatalogMessage} control={<div className="settings-inline-actions"><StatusPill tone={modelCatalogState === 'remote' ? 'success' : modelCatalogState === 'error' ? 'warning' : 'neutral'}>{modelCount} 个</StatusPill><ActionButton disabled={modelCatalogState === 'loading' || !profileHasKey} onClick={() => void refreshModels()}>{modelCatalogState === 'loading' ? <LoaderCircle className="settings-spin" size={14} /> : <RefreshCw size={14} />}刷新</ActionButton></div>} />
        <SettingsRow
          title="图片生成"
          description={imageGenerationAvailable
            ? '作为新任务的默认能力开关'
            : modelCompatibilityNotice || '当前模型未声明图片生成能力，请切换到支持该能力的模型。'}
          control={<SettingsSwitch label="图片生成" checked={imageGeneration} disabled={!imageGenerationAvailable} onChange={onImageGenerationChange} />}
        />
        <SettingsRow title="API 密钥存储" description="Windows 当前用户 DPAPI · 原子写入 · 旧明文仅在加密迁移成功后读取" control={<StatusPill tone={profileHasKey ? 'success' : 'warning'}>{profileHasKey ? '已加密' : '未配置'}</StatusPill>} />
      </SettingsSection>
      <SettingsSection title="安全连接" description="保存只写入本机密文；读取远程目录时会确认精确 endpoint。">
        <form className="settings-connection-form" onSubmit={(event) => { event.preventDefault(); void saveConnection() }}>
          <div className="settings-connection-fields">
            <label><span>渠道名称</span><input aria-label="渠道名称" value={connectionName} maxLength={128} onChange={(event) => setConnectionName(event.target.value)} /></label>
            <label><span>API Base URL</span><input aria-label="API Base URL" value={connectionEndpoint} maxLength={2048} inputMode="url" spellCheck={false} onChange={(event) => setConnectionEndpoint(event.target.value)} /></label>
            <label className="settings-secret-field"><span>API Key</span><div><KeyRound size={15} /><input aria-label="API Key" type="password" value={connectionApiKey} maxLength={32768} autoComplete="off" spellCheck={false} placeholder={profileHasKey ? '已保存；留空则保持不变' : '输入后仅提交到 Electron Main'} onChange={(event) => setConnectionApiKey(event.target.value)} /></div></label>
          </div>
          <div className="settings-connection-footer"><span><ShieldCheck size={14} />Key 不会回显到页面、日志或错误信息</span><button type="submit" className="settings-action primary" disabled={savingConnection}>{savingConnection ? <LoaderCircle className="settings-spin" size={14} /> : <Save size={14} />}{savingConnection ? '正在加密' : '安全保存'}</button></div>
        </form>
      </SettingsSection>
    </>
  )

  const personalizationPage = (
    <>
      <PageTitle title="个性化" description="自定义内容只保留在内存中，不写入磁盘，也不会自动发送。" />
      <SettingsSection title="回答偏好">
        <div className="settings-textarea-row">
          <label htmlFor="custom-instructions"><strong>自定义指令</strong><span>仅供后续可信运行时接入；当前不会加入模型上下文</span></label>
          <textarea id="custom-instructions" value={preferences.customInstructions} maxLength={2000} placeholder="例如：默认使用中文回答，修改代码前先说明影响范围" onChange={(event) => onPreferencesChange({ customInstructions: event.target.value })} />
          <div><small>{preferences.customInstructions.length} / 2000</small><ActionButton onClick={() => { sessionOnlyNotice('自定义指令'); setNotice({ tone: 'success', text: '自定义指令已保留在当前应用内存中，未写入磁盘或发送。' }) }}>保留到本次会话</ActionButton></div>
        </div>
        <SettingsRow title="回答语言" description="新对话的默认回答语言偏好" control={<SettingsSelect label="回答语言" value={preferences.responseLanguage} onChange={(value) => onPreferencesChange({ responseLanguage: value as SettingsPreferences['responseLanguage'] })}><option value="zh-CN">简体中文</option><option value="auto">自动检测</option></SettingsSelect>} />
      </SettingsSection>
    </>
  )

  const shortcutsPage = (
    <>
      <PageTitle title="键盘快捷键" description="当前已接入的输入与导航快捷键。" />
      <SettingsSection title="工作区">
        <SettingsRow title="发送消息" description="在输入框中提交当前消息" control={<kbd>Enter</kbd>} />
        <SettingsRow title="消息换行" description="在不发送的情况下插入新行" control={<kbd>Shift Enter</kbd>} />
        <SettingsRow title="关闭菜单或抽屉" description="关闭当前弹出菜单、任务抽屉或环境抽屉" control={<kbd>Esc</kbd>} />
        <SettingsRow title="执行终端输入" description="在底部终端预览中提交当前命令" control={<kbd>Enter</kbd>} />
      </SettingsSection>
    </>
  )

  const accountPage = (
    <>
      <PageTitle title="账户" description="账户与中转站功能在用户中心统一管理。" />
      <SettingsSection title="当前账户">
        <SettingsRow title={displayName} description="当前为离线预览，不包含远程登录会话" control={<StatusPill tone="warning">未联网</StatusPill>} />
        <SettingsRow title="账户、用量与令牌" description="查看中转站余额、模型价格、访问令牌和兑换" control={<ActionButton onClick={onOpenUserCenter}>进入用户中心<ChevronRight size={14} /></ActionButton>} />
      </SettingsSection>
    </>
  )

  const pluginsPage = (
    <>
      <PageTitle title="插件" description="插件将通过签名清单和明确权限边界加载。" />
      <SettingsSection title="插件运行时">
        <SettingsRow title="已启用插件" description="当前桌面端尚未加载第三方插件" control={<StatusPill>0</StatusPill>} />
        <SettingsRow title="插件目录" description="安装和本地目录枚举需要一次性用户批准" control={<ActionButton disabled onClick={() => undefined}>尚未开放</ActionButton>} />
      </SettingsSection>
    </>
  )

  const browserPage = (
    <>
      <PageTitle title="浏览器" description="管理联网搜索默认值；Renderer 自身仍禁止直接联网。" />
      <SettingsSection title="联网能力">
        <SettingsRow
          title="新任务启用 Web 搜索"
          description={webSearchAvailable
            ? '仅决定任务默认值；实际请求前仍需确认精确 endpoint'
            : modelCompatibilityNotice || '当前模型未声明联网搜索能力，请切换到支持该能力的模型。'}
          control={<SettingsSwitch label="新任务启用 Web 搜索" checked={webSearch} disabled={!webSearchAvailable} onChange={onWebSearchChange} />}
        />
        <SettingsRow title="Renderer 网络访问" description="页面脚本不能直接 fetch 外部地址" control={<StatusPill tone="success">已阻止</StatusPill>} />
        <SettingsRow title="外部链接" description="只允许无凭据的 HTTPS，并由系统浏览器确认打开" control={<StatusPill>逐次确认</StatusPill>} />
      </SettingsSection>
    </>
  )

  const computerPage = (
    <>
      <PageTitle title="电脑操控" description="桌面控制属于高风险能力，默认关闭。" />
      <SettingsSection title="本地控制">
        <SettingsRow title="允许电脑操控" description="需要独立运行时、可视化操作计划和逐次批准" control={<SettingsSwitch label="允许电脑操控" checked={false} disabled onChange={() => undefined} />} />
        <SettingsRow title="屏幕读取" description="当前没有请求或持有屏幕捕获权限" control={<StatusPill tone="success">未授权</StatusPill>} />
      </SettingsSection>
    </>
  )

  const hooksPage = (
    <>
      <PageTitle title="钩子" description="在任务生命周期中运行受限脚本。" />
      <SettingsSection title="任务钩子">
        <SettingsRow title="启动前钩子" description="命令执行尚未接入；Agent 的工作区文件授权不会开放给钩子" control={<StatusPill tone="warning">待接入</StatusPill>} />
        <SettingsRow title="完成后钩子" description="默认关闭，不会执行本地命令" control={<SettingsSwitch label="完成后钩子" checked={false} disabled onChange={() => undefined} />} />
      </SettingsSection>
    </>
  )

  const connectionsPage = (
    <>
      <PageTitle title="连接" description="远程地址必须是 HTTPS，并在每次应用会话中确认。" />
      <SettingsSection title="中转站">
        <SettingsRow title={displayName} description={endpoint} control={<StatusPill tone="warning">未确认 · 未发送</StatusPill>} />
        <SettingsRow title="连接与账户详情" description="在用户中心查看当前安全摘要" control={<ActionButton onClick={onOpenUserCenter}>查看详情<ChevronRight size={14} /></ActionButton>} />
      </SettingsSection>
    </>
  )

  const gitPage = (
    <>
      <PageTitle title="Git" description="配置 Diff 与分支建议；不会自动提交或推送。" />
      <SettingsSection title="版本控制">
        <SettingsRow title="比较基准" description="Diff 面板的默认比较分支" control={<SettingsSelect label="Git 比较基准" value={preferences.gitBase} onChange={(value) => onPreferencesChange({ gitBase: value as SettingsPreferences['gitBase'] })}><option value="current">当前分支</option><option value="main">main</option></SettingsSelect>} />
        <SettingsRow title="提交建议" description="分析完成后显示可选的提交建议，不会自动提交" control={<SettingsSwitch label="提交建议" checked={preferences.suggestions} onChange={(checked) => onPreferencesChange({ suggestions: checked })} />} />
        <SettingsRow title="Git 写操作" description="提交、切换分支和推送仍需明确批准" control={<StatusPill>逐次确认</StatusPill>} />
      </SettingsSection>
    </>
  )

  const environmentPage = (
    <>
      <PageTitle title="环境" description="查看 Agent 文件工具与本地执行能力的实际接入状态。" />
      <SettingsSection title="运行环境">
        <SettingsRow title="智能体环境" description="当前 Windows 设备上的运行位置" control={<SettingsSelect label="环境页智能体环境" value={preferences.agentEnvironment} onChange={(value) => onPreferencesChange({ agentEnvironment: value as SettingsPreferences['agentEnvironment'] })}><option value="windows">Windows 原生</option><option value="wsl">WSL（待接入）</option></SettingsSelect>} />
        <SettingsRow title="终端 Shell" description="当前仅保存集成终端的会话选择，尚未启动 Shell" control={<SettingsSelect label="环境页终端 Shell" value={preferences.shell} onChange={(value) => onPreferencesChange({ shell: value as SettingsPreferences['shell'] })}><option value="powershell">PowerShell</option><option value="cmd">Command Prompt</option></SettingsSelect>} />
        <SettingsRow title="Agent 文件工具" description="list_directory、read_file、write_file 与 git_summary 仅经审批链访问已选择的工作区" control={<StatusPill tone="success">已接通</StatusPill>} />
        <SettingsRow title="命令与终端" description="命令执行、集成终端及 Renderer 直连终端 IPC 仍保持 fail-closed" control={<StatusPill tone="warning">待接入</StatusPill>} />
      </SettingsSection>
    </>
  )

  const worktreesPage = (
    <>
      <PageTitle title="工作树" description="为并行 Agent 任务选择 Git worktree 策略。" />
      <SettingsSection title="创建策略">
        <SettingsRow title="新 Agent 任务" description="创建隔离工作树前的默认行为" control={<SettingsSelect label="工作树创建策略" value={preferences.worktreeMode} onChange={(value) => onPreferencesChange({ worktreeMode: value as SettingsPreferences['worktreeMode'] })}><option value="ask">每次询问</option><option value="always">始终创建</option><option value="never">不自动创建</option></SettingsSelect>} />
        <SettingsRow title="本地路径" description="绝对工作区路径不会进入模型上下文" control={<StatusPill tone="success">仅 Main 可见</StatusPill>} />
      </SettingsSection>
    </>
  )

  const archivedPage = (
    <>
      <PageTitle title="已归档任务" description="任务与消息使用本机 DPAPI 加密历史保存；归档管理尚未接入。" />
      <div className="settings-empty-state"><Archive size={22} /><strong>暂无已归档任务</strong><p>当前没有归档记录；现有对话仍保存在本机加密历史中。</p></div>
    </>
  )

  const pages: Record<SettingsView, ReactNode> = {
    general: generalPage,
    appearance: appearancePage,
    voice: voicePage,
    configuration: configurationPage,
    personalization: personalizationPage,
    shortcuts: shortcutsPage,
    account: accountPage,
    plugins: pluginsPage,
    browser: browserPage,
    computer: computerPage,
    hooks: hooksPage,
    connections: connectionsPage,
    git: gitPage,
    environment: environmentPage,
    worktrees: worktreesPage,
    archived: archivedPage,
  }

  return (
    <div className={`settings-shell density-${preferences.density} ${preferences.reduceMotion ? 'reduce-motion' : ''}`}>
      <aside className="settings-sidebar">
        <button type="button" className="settings-back" onClick={onBack}><ArrowLeft size={16} /><span>返回应用</span></button>
        <div className="settings-all"><SlidersHorizontal size={16} /><span>所有设置</span><ChevronDown size={14} /></div>
        <label className="settings-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索设置..." aria-label="搜索设置" /></label>
        <nav className="settings-navigation" aria-label="设置导航">
          {filteredGroups.map((group) => (
            <section key={group.id}>
              <h2>{group.label}</h2>
              {group.items.map((item) => {
                const Icon = item.icon
                return (
                  <button type="button" key={item.id} title={item.label} aria-current={activeView === item.id ? 'page' : undefined} className={activeView === item.id ? 'active' : ''} onClick={() => { onActiveViewChange(item.id); setNotice(null) }}>
                    <Icon size={16} strokeWidth={1.8} /><span>{item.label}</span>
                  </button>
                )
              })}
            </section>
          ))}
          {filteredGroups.length === 0 && <div className="settings-search-empty">没有匹配的设置</div>}
        </nav>
      </aside>

      <section className="settings-main">
        <div className="settings-main-strip" aria-hidden="true" />
        <main className="settings-scroll" tabIndex={-1}>
          <div className="settings-content">
            {notice && <div className={`settings-notice ${notice.tone}`} role="status">{notice.tone === 'warning' ? <ShieldAlert size={15} /> : notice.tone === 'success' ? <ShieldCheck size={15} /> : <Cloud size={15} />}<span>{notice.text}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}><X size={14} /></button></div>}
            {pages[activeView]}
          </div>
        </main>
      </section>

      {confirmFullAccess && (
        <div className="settings-dialog-layer" role="presentation" onMouseDown={() => setConfirmFullAccess(false)}>
          <div className="settings-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="settings-full-access-title" onMouseDown={(event) => event.stopPropagation()}>
            <span><ShieldAlert size={19} /></span>
            <div><h2 id="settings-full-access-title">将默认批准模式设为完全访问？</h2><p>Agent 可在所选工作区内读取和写入普通文件而减少确认，但 endpoint、路径与敏感文件边界、凭据保护仍然有效。命令和终端尚未接入；应用重启后恢复“请求批准”。</p></div>
            <div><button autoFocus type="button" onClick={() => setConfirmFullAccess(false)}>取消</button><button type="button" className="danger" onClick={() => { onPermissionChange('full'); setConfirmFullAccess(false); setNotice({ tone: 'warning', text: '本次应用会话已选择完全访问；安全边界仍然有效。' }) }}>确认完全访问</button></div>
          </div>
        </div>
      )}
    </div>
  )
}
