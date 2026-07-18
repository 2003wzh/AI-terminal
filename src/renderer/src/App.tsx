import {
  AlertCircle,
  Archive,
  ArrowUp,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  CircleUserRound,
  Code2,
  Copy,
  ExternalLink,
  FileCode2,
  FileDiff,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  GitCompareArrows,
  Globe2,
  HardDrive,
  HelpCircle,
  ImagePlus,
  Link2,
  ListChecks,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  Minus,
  MoreHorizontal,
  PanelLeftOpen,
  PanelRight,
  Paperclip,
  Pin,
  Plus,
  RotateCcw,
  ScanSearch,
  Search,
  Server,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Square,
  SquareTerminal,
  Sparkles,
  PlugZap,
  Target,
  Users,
  WandSparkles,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'

import type {
  AgentEvent,
  BootstrapPayload,
  CapabilityCatalog,
  CapabilityCommandId,
  ProjectInitCapabilityResult,
  PluginDescriptor,
  SkillDescriptor,
  ConversationMessageDto,
  GeneratedImageData,
  ModelDescriptor,
  ModelWireMode,
  ProjectSummary,
  PublicAccessProfile,
  TaskSummary,
  TurnStartInput,
  WorkspaceOpenerDescriptor,
  WorkspaceOpenerId,
} from '../../shared/contracts'
import { WZH_MODEL_BASE_URL, WZH_RELAY_PROFILE_HANDLE } from '../../shared/server-config'
import CapabilityPalette from './CapabilityPalette'
import UserCenter from './UserCenter'
import { relayAccountName } from './relay-identity'
import SettingsPage, { DEFAULT_SETTINGS_PREFERENCES, type SettingsPreferences, type SettingsView } from './Settings'
import { SmoothTextStream } from './smooth-text-stream'
import TaskHistoryActions from './TaskHistoryActions'

type WorkspaceMode = 'chat' | 'agent'
type Permission = 'ask' | 'auto' | 'full'
type DockTab = 'terminal' | 'diff' | 'files'
type OpenMenu = 'group' | 'model' | 'reasoning' | 'permission' | null
type AppSurface = 'workspace' | 'user-center' | 'settings'
type DesktopMenuId = 'file' | 'edit' | 'view' | 'help'
type ApprovalRequestEvent = Extract<AgentEvent, { type: 'approval-request' }>
type ProjectInitPreview = Extract<ProjectInitCapabilityResult, { state: 'preview' }>
type TurnActivityPhase = 'preparing' | 'queued' | 'thinking' | 'tool' | 'approval' | 'stopping'
type TurnActivityState = {
  startedAt: number
  phase: TurnActivityPhase
  detail: string
}

function hasCapabilityMention(value: string, trigger: '$' | '@', id: string): boolean {
  const mention = `${trigger}${id}`
  return value.split(/\s+/u).some((token) => token === mention)
}

type ModelOption = {
  id: string
  name: string
  detail: string
  wireMode: ModelWireMode
  reasoning: string[]
  subagents: boolean
  localSubagentsAllowed: boolean
  webSearchAllowed: boolean
  imageGenerationAllowed: boolean
}

type RelayGroupOption = {
  id: string
  ratio: number | string | null
  description: string | null
}

type Task = {
  id: string
  title: string
  mode: WorkspaceMode
  archivedAt?: string | null
  status?: 'running' | 'failed' | 'unread'
  pinned?: boolean
}

type TaskGroup = {
  id: string
  name: string
  path: string
  tasks: Task[]
}

const previewTaskGroups: TaskGroup[] = [
  {
    id: 'terminal',
    name: 'AI终点站',
    path: 'desktop/OneKeyElectron',
    tasks: [
      {
        id: 'workspace-redesign',
        title: '完善 React 工作区',
        mode: 'agent',
        pinned: true,
      },
      {
        id: 'security-boundary',
        title: '核对桌面端安全边界',
        mode: 'agent',
        status: 'unread',
      },
      {
        id: 'model-catalog',
        title: '接入动态模型目录',
        mode: 'chat',
      },
    ],
  },
  {
    id: 'server',
    name: 'wzh-server',
    path: 'services/new-api',
    tasks: [
      {
        id: 'endpoint-audit',
        title: '检查 Responses 与 Images',
        mode: 'agent',
        status: 'running',
      },
      {
        id: 'channel-config',
        title: '梳理模型通道配置',
        mode: 'chat',
      },
    ],
  },
  {
    id: 'notes',
    name: '产品笔记',
    path: 'design',
    tasks: [
      {
        id: 'release-plan',
        title: 'Electron 并行发布计划',
        mode: 'chat',
      },
    ],
  },
]

function toHistoryTaskGroups(projects: readonly ProjectSummary[]): TaskGroup[] {
  return projects
    .filter((project) => project.tasks.length > 0)
    .map((project) => ({
      id: project.id,
      name: project.name,
      path: '本机 DPAPI 加密历史',
      tasks: project.tasks.map(toUiTask),
    }))
}

function toUiTask(task: TaskSummary): Task {
  return {
    id: task.id,
    title: task.title,
    mode: task.mode,
    archivedAt: task.archivedAt,
    status: task.status === 'running' || task.status === 'waiting-approval'
      ? 'running'
      : task.status === 'failed'
        ? 'failed'
        : undefined,
  }
}

function isHistoryTaskId(taskId: string): boolean {
  return /^task:[0-9a-f-]{36}$/.test(taskId)
}

function createTurnStartRequestId(): string {
  return `start:${globalThis.crypto.randomUUID()}`
}

const fallbackModels: ModelOption[] = [
  { id: 'gpt-5.6-sol-ultra', name: 'GPT-5.6 Sol Ultra', detail: '本地子任务 · 视觉 · 工具', wireMode: 'standard', reasoning: ['auto', 'light', 'medium', 'high', 'xhigh', 'max', 'ultra'], subagents: true, localSubagentsAllowed: true, webSearchAllowed: true, imageGenerationAllowed: true },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', detail: '编程与长任务', wireMode: 'lite', reasoning: ['auto', 'light', 'medium', 'high', 'xhigh'], subagents: false, localSubagentsAllowed: false, webSearchAllowed: false, imageGenerationAllowed: false },
  { id: 'gpt-5.5-codex', name: 'GPT-5.5 Codex', detail: '软件工程', wireMode: 'standard', reasoning: ['auto', 'light', 'medium', 'high', 'xhigh'], subagents: false, localSubagentsAllowed: false, webSearchAllowed: true, imageGenerationAllowed: false },
  { id: 'gpt-5.4', name: 'GPT-5.4', detail: '通用推理', wireMode: 'standard', reasoning: ['auto', 'light', 'medium', 'high'], subagents: false, localSubagentsAllowed: false, webSearchAllowed: false, imageGenerationAllowed: false },
  { id: 'o4-mini', name: 'o4-mini', detail: '快速推理', wireMode: 'standard', reasoning: ['auto', 'light', 'medium', 'high'], subagents: false, localSubagentsAllowed: false, webSearchAllowed: false, imageGenerationAllowed: false },
]

const previewCapabilityCatalog: CapabilityCatalog = {
  commands: [
    { id: 'plan', name: '计划模式', description: '先收集上下文并输出执行计划', aliases: ['p'], scope: 'builtin', permissions: ['read'], safe: true, availability: 'ready' },
    { id: 'goal', name: '目标', description: '设置或查看当前任务的持久目标', aliases: ['objective'], scope: 'builtin', permissions: ['read'], safe: true, availability: 'ready' },
    { id: 'compact', name: '压缩上下文', description: '总结当前对话并释放上下文空间', aliases: ['summarize'], scope: 'builtin', permissions: ['read'], safe: true, availability: 'ready' },
    { id: 'memories', name: '记忆', description: '控制记忆读取和生成', aliases: ['memory'], scope: 'builtin', permissions: ['read', 'write'], safe: false, availability: 'requires-approval' },
    { id: 'init', name: '初始化项目', description: '生成 AGENTS.md 项目规则草稿', aliases: ['setup'], scope: 'builtin', permissions: ['read', 'write', 'approval'], safe: false, availability: 'requires-approval' },
    { id: 'review', name: '代码审查', description: '审查当前 Git 改动并按严重度排序', aliases: ['audit'], scope: 'builtin', permissions: ['read'], safe: true, availability: 'ready' },
    { id: 'status', name: '会话状态', description: '查看模型、目标、权限和上下文状态', aliases: ['info'], scope: 'builtin', permissions: ['read'], safe: true, availability: 'ready' },
  ],
  skills: [],
  plugins: [],
}

const previewRelayGroups: RelayGroupOption[] = [
  { id: 'auto', ratio: '自动', description: '自动选择可用渠道' },
  { id: 'default', ratio: 1, description: '默认分组' },
]

const previewWorkspaceOpeners: WorkspaceOpenerDescriptor[] = [
  { id: 'vscode', label: 'VS Code', kind: 'editor' },
  { id: 'visual-studio', label: 'Visual Studio', kind: 'editor' },
  { id: 'cursor', label: 'Cursor', kind: 'editor' },
  { id: 'github-desktop', label: 'GitHub Desktop', kind: 'git' },
  { id: 'explorer', label: '文件资源管理器', kind: 'file-manager' },
  { id: 'terminal', label: 'Windows Terminal', kind: 'terminal' },
  { id: 'wsl', label: 'WSL', kind: 'terminal' },
  { id: 'pycharm', label: 'PyCharm', kind: 'editor' },
]

const workspaceOpenerVisuals: Record<WorkspaceOpenerId, { icon: LucideIcon; tone: string }> = {
  vscode: { icon: Code2, tone: 'vscode' },
  'visual-studio': { icon: WandSparkles, tone: 'visual-studio' },
  cursor: { icon: ScanSearch, tone: 'cursor' },
  'github-desktop': { icon: GitBranch, tone: 'github' },
  explorer: { icon: FolderOpen, tone: 'explorer' },
  terminal: { icon: SquareTerminal, tone: 'terminal' },
  wsl: { icon: HardDrive, tone: 'wsl' },
  pycharm: { icon: FileCode2, tone: 'pycharm' },
}

const workspaceOpenerKindLabels: Record<WorkspaceOpenerDescriptor['kind'], string> = {
  editor: '编辑器',
  git: '版本控制',
  'file-manager': '文件',
  terminal: '终端',
}

type WorkspaceOpenerOperation =
  | { kind: 'detecting' }
  | { kind: 'opening'; openerId: WorkspaceOpenerId }

function toModelOptions(models: readonly ModelDescriptor[]): ModelOption[] {
  return models.map((entry) => ({
    id: entry.id,
    name: entry.label,
    detail: [
      entry.wireMode === 'lite' ? 'Responses Lite' : '',
      entry.capabilities.subagents ? '子智能体' : '',
      entry.capabilities.imageInput ? '视觉' : '',
      entry.capabilities.toolUse ? '工具' : '',
      entry.capabilities.webSearch ? '联网' : '',
    ].filter(Boolean).join(' · ') || (
      entry.source === 'remote' && entry.declaredCapabilities !== undefined
        ? '能力由 endpoint 在请求时验证'
        : '对话'
    ),
    wireMode: entry.wireMode,
    reasoning: [...entry.reasoning],
    subagents: entry.capabilities.subagents,
    localSubagentsAllowed: entry.source === 'remote'
      ? entry.declaredCapabilities?.subagents !== false
      : entry.capabilities.subagents,
    webSearchAllowed: entry.capabilities.webSearch,
    imageGenerationAllowed: entry.capabilities.imageGeneration,
  }))
}

const reasoningLevels = ['Auto', 'Light', 'Medium', 'High', 'Extra High', 'Max', 'Ultra']

const reasoningKeys: Record<string, string> = {
  Auto: 'auto',
  Light: 'light',
  Medium: 'medium',
  High: 'high',
  'Extra High': 'xhigh',
  Max: 'max',
  Ultra: 'ultra',
}

const reasoningLabels: Record<string, string> = Object.fromEntries(
  Object.entries(reasoningKeys).map(([label, key]) => [key, label]),
)

const permissionOptions: Array<{
  id: Permission
  name: string
  detail: string
  icon: LucideIcon
}> = [
  { id: 'ask', name: '请求批准', detail: '文件工具逐次确认', icon: Shield },
  { id: 'auto', name: '替我审批', detail: '自动批准低风险只读工具', icon: ShieldCheck },
  { id: 'full', name: '完全访问', detail: '减少工作区文件工具确认', icon: ShieldAlert },
]

const previewRuntime: BootstrapPayload['runtime'] = {
  status: 'mock',
  protocolVersion: 1,
  message: '浏览器界面预览未连接 Electron Main。',
}

const runtimeStatusLabels: Record<BootstrapPayload['runtime']['status'], string> = {
  mock: '本地界面预览',
  starting: '运行时启动中',
  ready: '运行时已就绪',
  degraded: '运行时受限',
  stopped: '运行时已停止',
}

const agentMarkdown = `
工作区已经从“配置表单”重组为连续的工作面：对话是第一层，执行证据和环境状态在需要时展开。

核心实现位于 [App.tsx](#file:src/renderer/src/App.tsx) 和 [styles.css](#file:src/renderer/src/styles.css)。渲染层不接触密钥，也不会获得任意文件或命令接口。

\
\`\`\`tsx
const windowOptions = {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
}
\`\`\`

- Chat 已接入 Markdown 对话与联网搜索；附件读取和图片生成仍待接入。
- Agent 已接入审批链、工作区目录浏览、文件读写与 Git 摘要；命令和终端仍待接入。
- 模式、模型与权限变更只影响下一轮，运行快照保持不变。
`

const chatMarkdown = `
可以。我已阅读你附加的工作区规范，并把内容整理成一条清晰的对话流。

Chat 模式已支持 **Markdown 对话和联网搜索**。附件内容读取与图片生成尚未接入；它不会读取工作区、执行命令或修改本地文件，需要文件工具时再切换到 Agent。

当前引用：[electron-workspace-spec.md](#file:design/electron-workspace-spec.md) · [Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)
`

function IconButton({
  label,
  icon: Icon,
  onClick,
  className = '',
  pressed,
  disabled,
}: {
  label: string
  icon: LucideIcon
  onClick?: () => void
  className?: string
  pressed?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      aria-pressed={pressed}
      data-tooltip={label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
    </button>
  )
}

function ProductMark() {
  return (
    <span className="product-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  )
}

type DesktopMenuItem = {
  label: string
  shortcut?: string
  disabled?: boolean
  separatorBefore?: boolean
  action: () => void
}

function Titlebar({
  title,
  running,
  surface,
  onNewTask,
  onSelectWorkspace,
  onOpenSettings,
  onOpenUserCenter,
  onReturnWorkspace,
  onToggleTasks,
  onToggleContext,
  onOpenDock,
  onCloseDock,
  dockOpen,
}: {
  title: string
  running: boolean
  surface: AppSurface
  onNewTask: (mode: WorkspaceMode) => void
  onSelectWorkspace: () => void
  onOpenSettings: (view: SettingsView) => void
  onOpenUserCenter: () => void
  onReturnWorkspace: () => void
  onToggleTasks: () => void
  onToggleContext: () => void
  onOpenDock: (tab: DockTab) => void
  onCloseDock: () => void
  dockOpen: boolean
}) {
  const [openMenu, setOpenMenu] = useState<DesktopMenuId | null>(null)
  const menuBarRef = useRef<HTMLElement>(null)
  const triggerRefs = useRef<Record<DesktopMenuId, HTMLButtonElement | null>>({
    file: null,
    edit: null,
    view: null,
    help: null,
  })

  const invokeWindow = (action: 'minimize' | 'toggleMaximize' | 'close') => {
    if (!('onekey' in window)) return
    void window.onekey.window[action]()
  }

  const runEditCommand = (command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'delete' | 'selectAll') => {
    try {
      document.execCommand(command)
    } catch {
      // The focused control decides whether the local edit command is available.
    }
  }

  useEffect(() => {
    if (!openMenu) return
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!menuBarRef.current?.contains(event.target as Node)) setOpenMenu(null)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const activeMenu = openMenu
      setOpenMenu(null)
      window.requestAnimationFrame(() => triggerRefs.current[activeMenu]?.focus())
    }
    document.addEventListener('pointerdown', closeOnPointerDown)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [openMenu])

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.altKey && event.code === 'ArrowLeft' && surface !== 'workspace') {
        event.preventDefault()
        setOpenMenu(null)
        onReturnWorkspace()
        return
      }

      const commandKey = event.ctrlKey || event.metaKey
      if (!commandKey) return
      let action: (() => void) | null = null

      if (event.shiftKey && event.code === 'KeyN') action = () => onNewTask('agent')
      else if (!event.shiftKey && event.code === 'KeyN') action = () => onNewTask('chat')
      else if (!event.shiftKey && event.code === 'KeyO') action = onSelectWorkspace
      else if (!event.shiftKey && event.code === 'Comma') action = () => onOpenSettings('general')
      else if (!event.shiftKey && !event.altKey && event.code === 'KeyB') action = onToggleTasks
      else if (event.altKey && event.code === 'KeyB') action = onToggleContext
      else if (!event.shiftKey && event.code === 'Backquote') action = () => onOpenDock('terminal')
      else if (event.shiftKey && event.code === 'KeyE') action = () => onOpenDock('files')
      else if (!event.shiftKey && event.code === 'KeyJ' && dockOpen) action = onCloseDock
      else if (event.shiftKey && event.code === 'Slash') action = () => onOpenSettings('shortcuts')
      else if (!event.shiftKey && event.code === 'KeyQ') action = () => invokeWindow('close')

      if (!action) return
      event.preventDefault()
      setOpenMenu(null)
      action()
    }

    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [dockOpen, onCloseDock, onNewTask, onOpenDock, onOpenSettings, onReturnWorkspace, onSelectWorkspace, onToggleContext, onToggleTasks, surface])

  const menus: Array<{ id: DesktopMenuId; label: string; items: DesktopMenuItem[] }> = [
    {
      id: 'file',
      label: '文件',
      items: [
        { label: '新建 Chat', shortcut: 'Ctrl+N', action: () => onNewTask('chat') },
        { label: '新建 Agent', shortcut: 'Ctrl+Shift+N', action: () => onNewTask('agent') },
        { label: '打开工作区…', shortcut: 'Ctrl+O', action: onSelectWorkspace },
        { label: '返回工作区', shortcut: 'Alt+←', disabled: surface === 'workspace', separatorBefore: true, action: onReturnWorkspace },
        { label: '设置…', shortcut: 'Ctrl+,', action: () => onOpenSettings('general') },
        { label: '退出 AI终点站', shortcut: 'Ctrl+Q', separatorBefore: true, action: () => invokeWindow('close') },
      ],
    },
    {
      id: 'edit',
      label: '编辑',
      items: [
        { label: '撤销', shortcut: 'Ctrl+Z', action: () => runEditCommand('undo') },
        { label: '重做', shortcut: 'Ctrl+Y', action: () => runEditCommand('redo') },
        { label: '剪切', shortcut: 'Ctrl+X', separatorBefore: true, action: () => runEditCommand('cut') },
        { label: '复制', shortcut: 'Ctrl+C', action: () => runEditCommand('copy') },
        { label: '粘贴', shortcut: 'Ctrl+V', action: () => runEditCommand('paste') },
        { label: '删除', action: () => runEditCommand('delete') },
        { label: '全选', shortcut: 'Ctrl+A', separatorBefore: true, action: () => runEditCommand('selectAll') },
      ],
    },
    {
      id: 'view',
      label: '视图',
      items: [
        { label: '切换任务面板', shortcut: 'Ctrl+B', action: onToggleTasks },
        { label: '切换环境卡片', shortcut: 'Alt+Ctrl+B', action: onToggleContext },
        { label: '打开终端', shortcut: 'Ctrl+`', separatorBefore: true, action: () => onOpenDock('terminal') },
        { label: '打开 Diff', action: () => onOpenDock('diff') },
        { label: '打开文件面板', shortcut: 'Ctrl+Shift+E', action: () => onOpenDock('files') },
        { label: '关闭底部面板', shortcut: 'Ctrl+J', disabled: !dockOpen, separatorBefore: true, action: onCloseDock },
      ],
    },
    {
      id: 'help',
      label: '帮助',
      items: [
        { label: '键盘快捷键', shortcut: 'Ctrl+Shift+/', action: () => onOpenSettings('shortcuts') },
        { label: '环境与故障排查', action: () => onOpenSettings('environment') },
        { label: '账户与中转站', separatorBefore: true, action: onOpenUserCenter },
      ],
    },
  ]

  const runMenuItem = (item: DesktopMenuItem) => {
    if (item.disabled) return
    setOpenMenu(null)
    item.action()
  }

  return (
    <header className="titlebar" aria-label="应用标题栏">
      <div className="titlebar-brand">
        <ProductMark />
        <span>AI终点站</span>
        <ChevronDown size={13} aria-hidden="true" />
      </div>
      <div className="titlebar-center">
        <nav className="app-menu-bar" role="menubar" aria-label="应用菜单" ref={menuBarRef}>
          {menus.map((menu) => (
            <div className="app-menu-root" key={menu.id}>
              <button
                type="button"
                className={`app-menu-trigger ${openMenu === menu.id ? 'is-open' : ''}`}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={openMenu === menu.id}
                ref={(node) => { triggerRefs.current[menu.id] = node }}
                onClick={() => setOpenMenu((current) => current === menu.id ? null : menu.id)}
              >
                {menu.label}
              </button>
              {openMenu === menu.id && (
                <div className="app-menu-popover" data-menu={menu.id} role="menu" aria-label={`${menu.label}菜单`}>
                  {menu.items.map((item) => (
                    <div key={item.label}>
                      {item.separatorBefore && <div className="app-menu-separator" role="separator" />}
                      <button
                        type="button"
                        role="menuitem"
                        disabled={item.disabled}
                        onClick={() => runMenuItem(item)}
                      >
                        <span>{item.label}</span>
                        {item.shortcut && <kbd>{item.shortcut}</kbd>}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>
        <div className="titlebar-task" aria-label="当前任务" title={title}>
          {running && <span className="running-dot" aria-label="正在运行" />}
          <span>{title}</span>
        </div>
      </div>
      <div className="window-controls" aria-label="窗口控制">
        <IconButton label="最小化" icon={Minus} className="window-button" onClick={() => invokeWindow('minimize')} />
        <IconButton label="最大化" icon={Maximize2} className="window-button" onClick={() => invokeWindow('toggleMaximize')} />
        <IconButton label="关闭" icon={X} className="window-button close-window" onClick={() => invokeWindow('close')} />
      </div>
    </header>
  )
}

function SidebarContents({
  groups,
  selectedTask,
  onSelectTask,
  onNewTask,
  onArchiveTask,
  onDeleteTask,
  onOpenSettings,
  onOpenUserCenter,
  accountName,
  connectionLabel,
  modelConnected,
  currentTaskRunning,
  historyActionTaskId,
  drawer = false,
  onClose,
}: {
  groups: TaskGroup[]
  selectedTask: string
  onSelectTask: (task: Task) => void
  onNewTask: (mode: WorkspaceMode) => void
  onArchiveTask: (task: Task, archived: boolean) => void
  onDeleteTask: (task: Task) => void
  onOpenSettings: () => void
  onOpenUserCenter: () => void
  accountName: string
  connectionLabel: string
  modelConnected: boolean
  currentTaskRunning: boolean
  historyActionTaskId: string
  drawer?: boolean
  onClose?: () => void
}) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    terminal: true,
    server: true,
    notes: false,
    'archive:local-history': false,
  })

  const displayGroups = useMemo(() => {
    const activeGroups = groups
      .map((group) => ({
        ...group,
        tasks: group.tasks.filter((task) => !task.archivedAt),
      }))
      .filter((group) => group.tasks.length > 0)
    const archivedTasks = groups.flatMap((group) => group.tasks.filter((task) => Boolean(task.archivedAt)))
    if (archivedTasks.length === 0) return activeGroups
    return [...activeGroups, {
      id: 'archive:local-history',
      name: '已归档',
      path: '本机 DPAPI 加密历史',
      tasks: archivedTasks,
    }]
  }, [groups])

  const filteredGroups = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return displayGroups
    return displayGroups
      .map((group) => {
        const groupMatches = group.name.toLocaleLowerCase().includes(normalized)
        return {
          ...group,
          tasks: groupMatches
            ? group.tasks
            : group.tasks.filter((task) => task.title.toLocaleLowerCase().includes(normalized)),
        }
      })
      .filter((group) => group.tasks.length > 0 || group.name.toLocaleLowerCase().includes(normalized))
  }, [displayGroups, query])

  return (
    <div className="sidebar-contents">
      <div className="sidebar-heading">
        <div>
          <span className="eyebrow">PROJECTS</span>
          <strong>项目与任务</strong>
        </div>
        {drawer && onClose && <IconButton label="关闭任务面板" icon={X} onClick={onClose} />}
      </div>

      <div className="sidebar-search">
        <Search size={15} aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索任务"
          aria-label="搜索任务"
        />
      </div>

      <div className="new-task-row">
        <button type="button" className="new-task-main" onClick={() => onNewTask('chat')}>
          <Plus size={16} aria-hidden="true" />
          <span>新建 Chat</span>
        </button>
        <IconButton label="新建 Agent" icon={Bot} onClick={() => onNewTask('agent')} />
      </div>

      <div className="task-tree" role="tree" aria-label="任务树">
        {filteredGroups.map((group) => {
          const isExpanded = query ? true : expanded[group.id]
          return (
            <section className="task-group" key={group.id}>
              <button
                type="button"
                className="task-group-heading"
                aria-expanded={isExpanded}
                onClick={() => setExpanded((current) => ({ ...current, [group.id]: !current[group.id] }))}
              >
                {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <Folder size={14} />
                <span>{group.name}</span>
                <span className="task-count">{group.tasks.length}</span>
              </button>
              {isExpanded && (
                <div role="group">
                  {group.tasks.map((task) => {
                    const TaskIcon = task.mode === 'agent' ? Bot : MessageSquare
                    return (
                      <div className="task-row-shell" key={task.id}>
                        <button
                          type="button"
                          role="treeitem"
                          aria-selected={task.id === selectedTask}
                          className={`task-row ${task.id === selectedTask ? 'selected' : ''}`}
                          title={`${task.title}\n${group.path}`}
                          onClick={() => onSelectTask(task)}
                        >
                          <TaskIcon size={14} aria-hidden="true" />
                          <span>{task.title}</span>
                          {task.pinned && <Pin size={12} className="task-pin" aria-label="已固定" />}
                          {task.status === 'running' && <span className="task-status running" aria-label="正在运行" />}
                          {task.status === 'unread' && <span className="task-status unread" aria-label="未读" />}
                          {task.status === 'failed' && <AlertCircle size={13} className="task-failed" aria-label="失败" />}
                        </button>
                        <TaskHistoryActions
                          title={task.title}
                          archived={Boolean(task.archivedAt)}
                          disabled={
                            task.status === 'running'
                            || Boolean(historyActionTaskId)
                            || (currentTaskRunning && selectedTask === task.id)
                          }
                          onArchiveChange={(archived) => onArchiveTask(task, archived)}
                          onDelete={() => onDeleteTask(task)}
                        />
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          )
        })}
        {filteredGroups.length === 0 && <p className="sidebar-empty">没有匹配的任务</p>}
      </div>

      <footer className="sidebar-footer">
        <button type="button" className="sidebar-footer-row" onClick={onOpenSettings}>
          <Settings size={16} aria-hidden="true" />
          <span>设置</span>
        </button>
        <button type="button" className="sidebar-footer-row">
          <HelpCircle size={16} aria-hidden="true" />
          <span>帮助与反馈</span>
        </button>
        <button type="button" className="account-row" onClick={onOpenUserCenter}>
          <span className="account-avatar">W</span>
          <span className="account-copy">
            <strong>{accountName}</strong>
            <small><span className={`connection-dot ${modelConnected ? '' : 'preview'}`} /> {connectionLabel}</small>
          </span>
          <MoreHorizontal size={15} aria-hidden="true" />
        </button>
      </footer>
    </div>
  )
}

function TaskSidebar({
  groups,
  selectedTask,
  onSelectTask,
  onNewTask,
  onArchiveTask,
  onDeleteTask,
  onOpenDrawer,
  onOpenSettings,
  onOpenUserCenter,
  accountName,
  connectionLabel,
  modelConnected,
  currentTaskRunning,
  historyActionTaskId,
}: {
  groups: TaskGroup[]
  selectedTask: string
  onSelectTask: (task: Task) => void
  onNewTask: (mode: WorkspaceMode) => void
  onArchiveTask: (task: Task, archived: boolean) => void
  onDeleteTask: (task: Task) => void
  onOpenDrawer: () => void
  onOpenSettings: () => void
  onOpenUserCenter: () => void
  accountName: string
  connectionLabel: string
  modelConnected: boolean
  currentTaskRunning: boolean
  historyActionTaskId: string
}) {
  return (
    <aside className="task-sidebar">
      <div className="sidebar-full">
        <SidebarContents
          groups={groups}
          selectedTask={selectedTask}
          onSelectTask={onSelectTask}
          onNewTask={onNewTask}
          onArchiveTask={onArchiveTask}
          onDeleteTask={onDeleteTask}
          onOpenSettings={onOpenSettings}
          onOpenUserCenter={onOpenUserCenter}
          accountName={accountName}
          connectionLabel={connectionLabel}
          modelConnected={modelConnected}
          currentTaskRunning={currentTaskRunning}
          historyActionTaskId={historyActionTaskId}
        />
      </div>
      <nav className="sidebar-rail" aria-label="任务栏">
        <button type="button" className="rail-brand" onClick={onOpenDrawer} aria-label="打开任务">
          <ProductMark />
        </button>
        <IconButton label="打开任务" icon={PanelLeftOpen} onClick={onOpenDrawer} />
        <IconButton label="新建 Chat" icon={Plus} onClick={() => onNewTask('chat')} />
        <IconButton label="新建 Agent" icon={Bot} onClick={() => onNewTask('agent')} />
        <IconButton label="搜索任务" icon={Search} onClick={onOpenDrawer} />
        <span className="rail-spacer" />
        <IconButton label="设置" icon={Settings} onClick={onOpenSettings} />
        <IconButton label="用户中心" icon={CircleUserRound} onClick={onOpenUserCenter} />
      </nav>
    </aside>
  )
}

function WorkspaceOpenControl({
  enabled,
  workspaceSelected,
  openers,
  defaultOpener,
  notice,
  onSelectWorkspace,
  onDetectOpeners,
  onOpenWorkspace,
}: {
  enabled: boolean
  workspaceSelected: boolean
  openers: readonly WorkspaceOpenerDescriptor[]
  defaultOpener: SettingsPreferences['defaultOpener']
  notice: string
  onSelectWorkspace: () => void
  onDetectOpeners: () => Promise<WorkspaceOpenerDescriptor[]>
  onOpenWorkspace: (openerId: WorkspaceOpenerId) => Promise<boolean>
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [operation, setOperation] = useState<WorkspaceOpenerOperation | null>(null)
  const [visibleOpeners, setVisibleOpeners] = useState<WorkspaceOpenerDescriptor[]>([...openers])
  const [localNotice, setLocalNotice] = useState('')
  const operationRef = useRef<WorkspaceOpenerOperation | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)

  const detecting = operation?.kind === 'detecting'
  const openingId = operation?.kind === 'opening' ? operation.openerId : null
  const busy = operation !== null

  useEffect(() => setVisibleOpeners([...openers]), [openers])

  useEffect(() => {
    if (!menuOpen) return
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setMenuOpen(false)
      window.requestAnimationFrame(() => menuTriggerRef.current?.focus())
    }
    document.addEventListener('pointerdown', closeOnPointerDown)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuOpen])

  useEffect(() => {
    setMenuOpen(false)
    setLocalNotice('')
  }, [enabled, workspaceSelected])

  const beginOperation = (next: WorkspaceOpenerOperation): boolean => {
    if (operationRef.current) return false
    operationRef.current = next
    setOperation(next)
    return true
  }

  const finishOperation = (current: WorkspaceOpenerOperation): void => {
    if (operationRef.current !== current) return
    operationRef.current = null
    setOperation(null)
  }

  const detect = async (focusFirst: boolean): Promise<WorkspaceOpenerDescriptor[] | null> => {
    const current: WorkspaceOpenerOperation = { kind: 'detecting' }
    if (!beginOperation(current)) return null
    setLocalNotice('')
    try {
      const detected = await onDetectOpeners()
      setVisibleOpeners(detected)
      if (detected.length === 0) setLocalNotice('没有检测到可用的本机打开方式。')
      if (focusFirst && detected.length > 0) {
        window.requestAnimationFrame(() => {
          menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
        })
      }
      return detected
    } finally {
      finishOperation(current)
    }
  }

  const showMenu = async (focusFirst = false) => {
    if (!enabled || !workspaceSelected || operationRef.current) return
    setMenuOpen(true)
    await detect(focusFirst)
  }

  const openWith = async (openerId: WorkspaceOpenerId) => {
    const current: WorkspaceOpenerOperation = { kind: 'opening', openerId }
    if (!beginOperation(current)) return
    setLocalNotice('')
    try {
      if (await onOpenWorkspace(openerId)) setMenuOpen(false)
    } finally {
      finishOperation(current)
    }
  }

  const runPrimaryAction = async () => {
    if (!enabled || operationRef.current) return
    if (!workspaceSelected) {
      onSelectWorkspace()
      return
    }
    if (defaultOpener === 'none') {
      await showMenu(true)
      return
    }
    const detected = await detect(false)
    if (!detected) return
    if (detected.length === 0) {
      setMenuOpen(true)
      return
    }
    if (!detected.some((entry) => entry.id === defaultOpener)) {
      setLocalNotice('默认打开方式在当前电脑上不可用，请选择其他目标。')
      setMenuOpen(true)
      return
    }
    await openWith(defaultOpener)
  }

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
    if (items.length === 0) return
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
    let nextIndex: number | null = null
    if (event.key === 'ArrowDown') nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length
    else if (event.key === 'ArrowUp') nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = items.length - 1
    else if (event.key === 'Tab') setMenuOpen(false)
    if (nextIndex === null) return
    event.preventDefault()
    items[nextIndex]?.focus()
  }

  const preferred = defaultOpener === 'none'
    ? null
    : visibleOpeners.find((entry) => entry.id === defaultOpener) ?? null
  const displayNotice = notice || localNotice
  const openingTarget = openingId ? visibleOpeners.find((entry) => entry.id === openingId) : null
  const primaryAriaLabel = !workspaceSelected
    ? '选择工作区'
    : detecting
      ? '正在检测本机打开方式'
      : openingId
        ? `正在使用 ${openingTarget?.label ?? '所选应用'} 打开当前工作区`
        : defaultOpener === 'none'
          ? '打开位置菜单'
          : preferred
            ? `使用 ${preferred.label} 打开当前工作区`
            : '使用默认方式打开当前工作区'
  const primaryLabel = detecting
    ? '正在检测'
    : openingId
      ? '正在打开'
      : workspaceSelected
        ? '打开位置'
        : '选择工作区'
  const PrimaryIcon = busy
    ? LoaderCircle
    : preferred
      ? workspaceOpenerVisuals[preferred.id].icon
      : FolderOpen

  return (
    <div className={`workspace-launcher ${menuOpen ? 'is-open' : ''}`} ref={rootRef}>
      <div className="workspace-launcher-control">
        <button
          type="button"
          className="workspace-launcher-main"
          disabled={!enabled || busy}
          aria-label={primaryAriaLabel}
          aria-haspopup={workspaceSelected && defaultOpener === 'none' ? 'menu' : undefined}
          aria-expanded={workspaceSelected && defaultOpener === 'none' ? menuOpen : undefined}
          onClick={() => { void runPrimaryAction() }}
        >
          <PrimaryIcon className={busy ? 'spin' : ''} size={15} aria-hidden="true" />
          <span>{primaryLabel}</span>
        </button>
        {workspaceSelected && (
          <button
            type="button"
            className="workspace-launcher-menu-trigger"
            aria-label="选择打开位置"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            ref={menuTriggerRef}
            disabled={!enabled || busy}
            onClick={() => {
              if (menuOpen) setMenuOpen(false)
              else void showMenu(false)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown') return
              event.preventDefault()
              void showMenu(true)
            }}
          >
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {menuOpen && (
        <div
          className="workspace-opener-menu"
          role="menu"
          aria-label="打开位置"
          aria-busy={busy}
          ref={menuRef}
          onKeyDown={handleMenuKeyDown}
        >
          <div className="workspace-opener-heading">
            <span>打开当前工作区</span>
            <small>{detecting ? '正在检测' : `本机可用 ${visibleOpeners.length} 项`}</small>
          </div>
          <div className="workspace-opener-list">
            {detecting && visibleOpeners.length === 0 && (
              <div className="workspace-opener-loading"><LoaderCircle className="spin" size={16} />正在检测本机应用</div>
            )}
            {visibleOpeners.map((opener) => {
              const visual = workspaceOpenerVisuals[opener.id]
              const OpenerIcon = visual.icon
              const selected = opener.id === defaultOpener
              return (
                <button
                  type="button"
                  role="menuitem"
                  className="workspace-opener-item"
                  key={opener.id}
                  disabled={busy}
                  onClick={() => { void openWith(opener.id) }}
                >
                  <span className={`workspace-opener-icon ${visual.tone}`}><OpenerIcon size={18} aria-hidden="true" /></span>
                  <span className="workspace-opener-copy"><strong>{opener.label}</strong><small>{workspaceOpenerKindLabels[opener.kind]}</small></span>
                  {openingId === opener.id ? <LoaderCircle className="spin" size={14} aria-label="正在打开" /> : selected && <Check size={14} aria-label="默认" />}
                </button>
              )
            })}
          </div>
          {displayNotice && <p className="workspace-opener-notice" role="status">{displayNotice}</p>}
          <div className="workspace-opener-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="workspace-opener-item workspace-opener-change"
            disabled={busy}
            onClick={() => {
              setMenuOpen(false)
              onSelectWorkspace()
            }}
          >
            <span className="workspace-opener-icon change"><FolderOpen size={18} aria-hidden="true" /></span>
            <span className="workspace-opener-copy"><strong>选择其他工作区</strong><small>更改当前本地目录</small></span>
          </button>
        </div>
      )}
    </div>
  )
}

function TaskHeader({
  title,
  mode,
  planMode,
  goal,
  workspaceName,
  workspaceSelected,
  workspaceIdentity,
  workspaceOpeners,
  defaultOpener,
  openerNotice,
  onSelectWorkspace,
  onDetectOpeners,
  onOpenWorkspace,
  onOpenContext,
  onOpenDock,
}: {
  title: string
  mode: WorkspaceMode
  planMode: boolean
  goal: string
  workspaceName: string
  workspaceSelected: boolean
  workspaceIdentity: string
  workspaceOpeners: readonly WorkspaceOpenerDescriptor[]
  defaultOpener: SettingsPreferences['defaultOpener']
  openerNotice: string
  onSelectWorkspace: () => void
  onDetectOpeners: () => Promise<WorkspaceOpenerDescriptor[]>
  onOpenWorkspace: (openerId: WorkspaceOpenerId) => Promise<boolean>
  onOpenContext: () => void
  onOpenDock: (tab: DockTab) => void
}) {
  return (
    <header className="task-header">
      <div className="task-breadcrumb">
        <span className="workspace-name" title={workspaceName || title}>
          {mode === 'agent' ? (workspaceName || '未选择工作区') : 'Chat'}
        </span>
        <span className="breadcrumb-divider">/</span>
        <GitBranch size={14} aria-hidden="true" />
        <span>{mode === 'agent' ? '本地工作区' : '仅对话'}</span>
        {mode === 'agent' && <span className="dirty-dot" aria-label="工作区已隔离" />}
      </div>
      <div className="task-state-badges">
        {planMode && <span className="task-mode-badge"><ListChecks size={12} />计划</span>}
        {goal && <span className="task-goal-badge" title={goal}><Target size={12} />目标</span>}
      </div>
      <div className="task-header-actions">
        <WorkspaceOpenControl
          key={workspaceIdentity || mode}
          enabled={mode === 'agent'}
          workspaceSelected={workspaceSelected}
          openers={workspaceOpeners}
          defaultOpener={defaultOpener}
          notice={openerNotice}
          onSelectWorkspace={onSelectWorkspace}
          onDetectOpeners={onDetectOpeners}
          onOpenWorkspace={onOpenWorkspace}
        />
        <IconButton label="在任务中搜索" icon={Search} />
        <IconButton label="打开终端" icon={SquareTerminal} onClick={() => onOpenDock('terminal')} />
        <IconButton label="环境信息" icon={PanelRight} onClick={onOpenContext} />
        <IconButton label="更多" icon={MoreHorizontal} />
      </div>
    </header>
  )
}

function UserMessage({ children }: { children: ReactNode }) {
  return (
    <div className="user-message">
      <div className="message-label">你</div>
      <div className="user-message-body">{children}</div>
    </div>
  )
}

function CodeBlock({
  language,
  code,
  onOpen,
}: {
  language: string
  code: string
  onOpen: () => void
}) {
  const [copied, setCopied] = useState(false)

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{language || 'text'}</span>
        <span className="code-file">src/main/windows/create-window.ts</span>
        <div>
          <IconButton label={copied ? '已复制' : '复制代码'} icon={copied ? Check : Copy} onClick={copyCode} />
          <IconButton label="在编辑器中打开" icon={Code2} onClick={onOpen} />
          <IconButton label="更多" icon={MoreHorizontal} />
        </div>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  )
}

function MarkdownMessage({
  markdown,
  onOpenFile,
}: {
  markdown: string
  onOpenFile: () => void
}) {
  const components: Components = {
    pre({ children }) {
      return <>{children}</>
    },
    code({ className, children }) {
      const code = String(children).replace(/\n$/, '')
      const language = /language-(\w+)/.exec(className ?? '')?.[1] ?? ''
      const isBlock = Boolean(className) || code.includes('\n')
      return isBlock ? (
        <CodeBlock language={language} code={code} onOpen={onOpenFile} />
      ) : (
        <code className="inline-code">{children}</code>
      )
    },
    a({ href = '', children }) {
      const isFile = href.startsWith('#file:')
      const isExternal = /^https?:\/\//.test(href)
      if (isFile) {
        return (
          <button type="button" className="file-link" onClick={onOpenFile} title={href.slice(6)}>
            <FileCode2 size={13} aria-hidden="true" />
            <span>{children}</span>
          </button>
        )
      }
      return (
        <a
          href={href}
          className="external-link"
          onClick={(event) => {
            if (!isExternal) return
            event.preventDefault()
            if ('onekey' in window) void window.onekey.link.openExternal(href)
          }}
        >
          {children}
          {isExternal && <ExternalLink size={12} aria-hidden="true" />}
        </a>
      )
    },
  }

  return (
    <div className="markdown-message">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={components}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  )
}

type TrackEvent = {
  id: string
  label: string
  target: string
  status: 'succeeded' | 'running' | 'approval'
  duration: string
  icon: LucideIcon
  detail?: ReactNode
}

const trackEvents: TrackEvent[] = [
  {
    id: 'plan',
    label: '整理实现计划',
    target: 'React 工作区',
    status: 'succeeded',
    duration: '0.8s',
    icon: ListChecks,
  },
  {
    id: 'inspect',
    label: '读取设计规范',
    target: 'design/electron-workspace-spec.md',
    status: 'succeeded',
    duration: '1.2s',
    icon: ScanSearch,
  },
  {
    id: 'subagents',
    label: '并行校验',
    target: '响应式与安全契约',
    status: 'succeeded',
    duration: '18.4s',
    icon: Users,
    detail: (
      <div className="branch-list">
        <div><span className="branch-line" /><CheckCircle2 size={13} />布局校验 <small>4 个视口</small></div>
        <div><span className="branch-line" /><CheckCircle2 size={13} />安全契约 <small>renderer 无密钥</small></div>
        <div><span className="branch-line" /><CheckCircle2 size={13} />交互清单 <small>23 项</small></div>
      </div>
    ),
  },
  {
    id: 'write',
    label: '写入工作区界面',
    target: 'src/renderer',
    status: 'succeeded',
    duration: '12.6s',
    icon: Wrench,
    detail: (
      <div className="event-summary">
        <span>范围</span><code>src/renderer/**</code>
        <span>策略</span><span>仅工作区内相对路径</span>
      </div>
    ),
  },
  {
    id: 'verify',
    label: '验证渲染构建',
    target: 'renderer typecheck',
    status: 'succeeded',
    duration: '4.1s',
    icon: CheckCircle2,
  },
]

function ExecutionTrack({ running = false }: { running?: boolean }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ subagents: true })

  return (
    <div className="execution-track" aria-label="Agent 执行轨迹">
      <div className="track-spine" aria-hidden="true" />
      {trackEvents.map((event, index) => {
        const Icon = event.icon
        const eventRunning = running && index === trackEvents.length - 1
        return (
          <div className={`track-event ${eventRunning ? 'is-running' : event.status}`} key={event.id}>
            <button
              type="button"
              className="track-node"
              aria-label={`${event.label}，${eventRunning ? '正在运行' : '已完成'}`}
              onClick={() => setExpanded((current) => ({ ...current, [event.id]: !current[event.id] }))}
            >
              <span />
            </button>
            <div className="track-event-content">
              <button
                type="button"
                className="track-event-row"
                aria-expanded={Boolean(expanded[event.id])}
                onClick={() => setExpanded((current) => ({ ...current, [event.id]: !current[event.id] }))}
              >
                <Icon size={14} aria-hidden="true" />
                <strong>{event.label}</strong>
                <code>{event.target}</code>
                <span className={`event-status ${eventRunning ? 'running' : event.status}`}>
                  {eventRunning ? '运行中' : event.status === 'approval' ? '待批准' : '完成'}
                </span>
                <span className="event-duration">{eventRunning ? '2.8s' : event.duration}</span>
                {event.detail ? (expanded[event.id] ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : <span className="event-chevron-space" />}
              </button>
              {event.detail && expanded[event.id] && <div className="track-event-detail">{event.detail}</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

const diffFiles = [
  { path: 'src/renderer/src/App.tsx', add: 684, remove: 0 },
  { path: 'src/renderer/src/styles.css', add: 912, remove: 0 },
  { path: 'src/renderer/src/main.tsx', add: 12, remove: 0 },
  { path: 'src/renderer/index.html', add: 16, remove: 0 },
  { path: 'design/electron-workspace-spec.md', add: 34, remove: 8 },
  { path: '.gitignore', add: 7, remove: 0 },
]

function DiffArtifact({ onOpenDock }: { onOpenDock: (tab: DockTab) => void }) {
  const [showAll, setShowAll] = useState(false)
  const visibleFiles = showAll ? diffFiles : diffFiles.slice(0, 4)

  return (
    <section className="diff-artifact" aria-labelledby="diff-heading">
      <header className="diff-header">
        <div className="diff-title-icon"><FileDiff size={17} aria-hidden="true" /></div>
        <div>
          <strong id="diff-heading">已编辑 {diffFiles.length} 个文件</strong>
          <span><b>+1,665</b> <em>-8</em></span>
        </div>
        <div className="diff-actions">
          <button type="button" className="quiet-command"><RotateCcw size={14} />撤销</button>
          <button type="button" className="review-command" onClick={() => onOpenDock('diff')}>
            <ScanSearch size={14} />审查
          </button>
        </div>
      </header>
      <div className="diff-files">
        {visibleFiles.map((file) => (
          <button type="button" className="diff-file-row" key={file.path} onClick={() => onOpenDock('diff')}>
            <FileCode2 size={14} aria-hidden="true" />
            <span title={file.path}>{file.path}</span>
            <span className="file-stats"><b>+{file.add}</b> <em>-{file.remove}</em></span>
          </button>
        ))}
      </div>
      {diffFiles.length > 4 && (
        <button type="button" className="show-more" onClick={() => setShowAll((value) => !value)}>
          {showAll ? '收起文件' : `再显示 ${diffFiles.length - 4} 个文件`}
          {showAll ? <ChevronDown className="rotate-180" size={14} /> : <ChevronDown size={14} />}
        </button>
      )}
    </section>
  )
}

function MessageActions() {
  const [copied, setCopied] = useState(false)
  return (
    <div className="message-actions">
      <IconButton
        label={copied ? '已复制' : '复制回答'}
        icon={copied ? Check : Copy}
        onClick={() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1200)
        }}
      />
      <IconButton label="在新任务中继续" icon={ExternalLink} />
    </div>
  )
}

function generatedImageObjectUrl(value: GeneratedImageData): string | null {
  if (
    !value ||
    typeof value !== 'object' ||
    value.mimeType !== 'image/png' ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 8 ||
    value.byteLength > 12 * 1024 * 1024 ||
    typeof value.dataBase64 !== 'string' ||
    value.dataBase64.length < 12 ||
    value.dataBase64.length > 16 * 1024 * 1024 ||
    value.dataBase64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.dataBase64)
  ) {
    return null
  }
  try {
    const binary = atob(value.dataBase64)
    if (binary.length !== value.byteLength) return null
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    if (!pngSignature.every((byte, index) => bytes[index] === byte)) return null
    return URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
  } catch {
    return null
  }
}

function TurnActivityLine({
  activity,
  elapsedSeconds,
  fallback,
}: {
  activity: TurnActivityState | null
  elapsedSeconds: number
  fallback: string
}) {
  const detail = activity?.detail || fallback
  return (
    <div
      className={`turn-activity phase-${activity?.phase ?? 'thinking'}`}
      role="status"
      aria-label={`${detail}，仍在处理`}
    >
      <span className="turn-activity-breath" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="turn-activity-detail">{detail}</span>
      <span className="turn-activity-separator" aria-hidden="true">·</span>
      <span className="turn-activity-elapsed" aria-hidden="true">已处理 {elapsedSeconds} 秒</span>
    </div>
  )
}

function Transcript({
  mode,
  running,
  activity,
  elapsedSeconds,
  messages,
  generatedImages,
  turnMessage,
  previewExample,
  onOpenDock,
}: {
  mode: WorkspaceMode
  running: boolean
  activity: TurnActivityState | null
  elapsedSeconds: number
  messages: ConversationMessageDto[]
  generatedImages: Readonly<Record<string, readonly string[]>>
  turnMessage: string
  previewExample: boolean
  onOpenDock: (tab: DockTab) => void
}) {
  const hasConversation = messages.length > 0
  return (
    <div className="transcript" role="log" aria-live="polite">
      <div className="reading-column">
        {!hasConversation && previewExample && (
          <article className="conversation-turn">
            <UserMessage>
              {mode === 'agent'
                ? '把旧版工作区改成 React 风格，保留任务树、Markdown、Diff、环境面板、终端和可靠的 Agent 权限。'
                : '阅读我附加的工作区规范，告诉我 Chat 模式可以处理哪些内容。'}
            </UserMessage>

            <div className="assistant-message-body">
              {mode === 'agent' ? (
                <>
                <p className="assistant-lead">我先确认现有能力和安全边界，再把界面重组为可持续工作的桌面工作台。</p>
                <ExecutionTrack />
                <MarkdownMessage markdown={agentMarkdown} onOpenFile={() => onOpenDock('files')} />
                <DiffArtifact onOpenDock={onOpenDock} />
                </>
              ) : (
                <>
                <MarkdownMessage markdown={chatMarkdown} onOpenFile={() => onOpenDock('files')} />
                <div className="source-strip">
                  <Link2 size={14} />
                  <span>2 个来源</span>
                  <button type="button">查看引用</button>
                </div>
                </>
              )}
              <MessageActions />
            </div>
          </article>
        )}

        {!hasConversation && !previewExample && (
          <div className="transcript-empty" role="status">
            {mode === 'agent' ? <Bot size={20} /> : <MessageSquare size={20} />}
            <strong>{mode === 'agent' ? '新 Agent 任务' : '新 Chat'}</strong>
            <span>尚无消息</span>
          </div>
        )}

        {messages.map((message) => message.role === 'user' ? (
          <article className="conversation-turn latest-turn" key={message.id}>
            <UserMessage>{message.content}</UserMessage>
          </article>
        ) : (
          <article className="conversation-turn assistant-turn" key={message.id}>
            <div className="assistant-message-body">
              {message.content && <MarkdownMessage markdown={message.content} onOpenFile={() => onOpenDock('files')} />}
              {(generatedImages[message.id]?.length ?? 0) > 0 && (
                <div className="generated-image-grid">
                  {generatedImages[message.id]!.map((source, index) => (
                    <img
                      key={source}
                      src={source}
                      alt={`生成图片 ${index + 1}`}
                      className="generated-image"
                    />
                  ))}
                </div>
              )}
              {message.status === 'streaming' && (
                <TurnActivityLine
                  activity={activity}
                  elapsedSeconds={elapsedSeconds}
                  fallback={running ? '正在分析并生成回答' : '正在恢复流式状态'}
                />
              )}
              {message.status === 'cancelled' && <p className="stopped-line"><Circle size={12} />本轮已停止，已接收内容已加密保存。</p>}
              {message.status === 'failed' && <p className="stopped-line error"><AlertCircle size={13} />{turnMessage || '本轮未完成，请重试。'}</p>}
              {message.status === 'complete' && <MessageActions />}
            </div>
          </article>
        ))}
        {running && messages.at(-1)?.status !== 'streaming' && (
          <div className="standalone-turn-activity">
            <TurnActivityLine
              activity={activity}
              elapsedSeconds={elapsedSeconds}
              fallback="正在安全准备请求"
            />
          </div>
        )}
        {turnMessage && !running && messages.at(-1)?.status !== 'failed' && (
          <p className="stopped-line error standalone"><AlertCircle size={13} />{turnMessage}</p>
        )}
      </div>
    </div>
  )
}

function ContextInspector({
  open,
  mode,
  subagentsEnabled,
  previewExample,
  workspaceName,
  runtime,
  onOpenDock,
  onClose,
}: {
  open: boolean
  mode: WorkspaceMode
  subagentsEnabled: boolean
  previewExample: boolean
  workspaceName: string
  runtime: BootstrapPayload['runtime']
  onOpenDock: (tab: DockTab) => void
  onClose: () => void
}) {
  const subagentsActive = mode === 'agent' && subagentsEnabled
  return (
    <aside className={`context-inspector ${open ? 'is-open' : ''}`} aria-label="环境信息">
      <div className="inspector-panel">
        <header className="inspector-header">
          <div className="inspector-title">
            <strong>环境信息</strong>
            <span className={`environment-status-dot ${runtime.status}`} title={runtime.message} aria-label={runtimeStatusLabels[runtime.status]} />
          </div>
          <div className="inspector-header-actions">
            {previewExample && <IconButton label="添加来源" icon={Plus} onClick={() => onOpenDock('files')} />}
            <IconButton label="关闭环境信息" icon={X} onClick={onClose} className="drawer-close" />
          </div>
        </header>

        <div className="inspector-scroll">
          <section className="environment-card-section environment-git-section">
            <div className="change-summary">
              <span><GitCompareArrows size={15} />变更</span>
              {previewExample ? <strong><b>+1,665</b> <em>-8</em></strong> : <small>未读取</small>}
            </div>
            <dl className="info-list">
              <div><dt><HardDrive size={14} />位置</dt><dd>{previewExample ? '本地工作区' : workspaceName || '未选择'}</dd></div>
              <div><dt><GitBranch size={14} />分支</dt><dd>{previewExample ? 'codex/react-workspace' : '未读取'}</dd></div>
              <div><dt><CircleDot size={14} />状态</dt><dd title={runtime.message}>{runtimeStatusLabels[runtime.status]}</dd></div>
            </dl>
            {previewExample && <div className="inspector-commands">
              <button type="button" onClick={() => onOpenDock('terminal')}><GitBranch size={14} />提交或推送</button>
              <button type="button" onClick={() => onOpenDock('diff')}><GitCompareArrows size={14} />比较分支</button>
            </div>}
          </section>

          <section className="environment-card-section">
            <div className="environment-section-title">
              <span><Users size={15} />子智能体</span>
              <small>{subagentsActive ? '已开启' : '未开启'}</small>
            </div>
            <p className="compact-empty">
              {mode === 'chat'
                ? 'Chat 模式未启用本地编排'
                : subagentsActive
                  ? '最多 3 个只读子任务；继承本轮批准与取消边界'
                  : '本轮未开启本地子任务'}
            </p>
          </section>

          <section className="environment-card-section environment-sources-section">
            <div className="environment-section-title">
              <span><Link2 size={15} />来源</span>
              <small>{previewExample ? '3' : '0'}</small>
            </div>
            {previewExample ? <div className="source-list">
              <button type="button" onClick={() => onOpenDock('files')}><FileText size={15} /><span><strong>electron-workspace-spec.md</strong><small>界面示例 · 未读取</small></span></button>
              <button type="button" onClick={() => onOpenDock('files')}><FileCode2 size={15} /><span><strong>window_workspace.py</strong><small>界面示例 · 未读取</small></span></button>
              <button type="button" onClick={() => onOpenDock('files')}><Globe2 size={15} /><span><strong>Electron Security</strong><small>链接示例 · 未访问</small></span></button>
            </div> : <p className="compact-empty">本轮尚无来源</p>}
            {previewExample && <button type="button" className="view-all-sources" onClick={() => onOpenDock('files')}>
              <Link2 size={14} />
              <span>查看全部</span>
              <ChevronRight size={14} />
            </button>}
          </section>
        </div>
      </div>
    </aside>
  )
}

function TerminalPane() {
  return (
    <div className="terminal-pane terminal-unavailable">
      <div className="terminal-output" role="status">
        <div className="terminal-command">可信终端尚未接通</div>
        <div>当前运行时不会启动未隔离的 PowerShell 或 CMD。</div>
      </div>
      <label className="terminal-input-row">
        <span>PS</span>
        <input value="" disabled aria-label="终端不可用" placeholder="等待隔离运行时" />
      </label>
    </div>
  )
}

function DiffPane({ previewExample }: { previewExample: boolean }) {
  if (!previewExample) return <div className="dock-empty-state">尚未读取工作区 Diff</div>
  return (
    <div className="dock-code diff-code" aria-label="Diff 预览">
      <div><span className="line-no">42</span><span>  .workspace-grid {'{'}</span></div>
      <div className="removed"><span className="line-no">43</span><span>-   grid-template-columns: 300px 1fr 340px;</span></div>
      <div className="added"><span className="line-no">43</span><span>+   grid-template-columns: 240px minmax(0, 1fr) 288px;</span></div>
      <div className="added"><span className="line-no">44</span><span>+   min-width: 0;</span></div>
      <div><span className="line-no">45</span><span>{'}'}</span></div>
      <div className="hunk"><span className="line-no">···</span><span>@@ media (max-width: 1039px) @@</span></div>
      <div className="added"><span className="line-no">86</span><span>+   grid-template-columns: 52px minmax(0, 1fr);</span></div>
    </div>
  )
}

function FilePane({ previewExample }: { previewExample: boolean }) {
  if (!previewExample) return <div className="dock-empty-state">尚未打开工作区文件</div>
  return (
    <div className="editor-pane">
      <div className="editor-gutter">1<br />2<br />3<br />4<br />5<br />6<br />7</div>
      <pre><span className="syntax-keyword">import</span> {'{'} useState {'}'} <span className="syntax-keyword">from</span> <span className="syntax-string">'react'</span>{'\n'}
<span className="syntax-keyword">import</span> {'{'} Bot, MessageSquare {'}'} <span className="syntax-keyword">from</span> <span className="syntax-string">'lucide-react'</span>{'\n\n'}
<span className="syntax-keyword">export default function</span> <span className="syntax-function">WorkspaceShell</span>() {'{'}{'\n'}
  <span className="syntax-keyword">const</span> [mode, setMode] = useState(<span className="syntax-string">'agent'</span>){'\n'}
  <span className="syntax-keyword">return</span> &lt;main data-mode={'{'}mode{'}'} /&gt;{'\n'}
{'}'}</pre>
    </div>
  )
}

function WorkbenchDock({
  active,
  previewExample,
  onChange,
  onClose,
}: {
  active: DockTab
  previewExample: boolean
  onChange: (tab: DockTab) => void
  onClose: () => void
}) {
  const tabs: Array<{ id: DockTab; label: string; icon: LucideIcon }> = [
    { id: 'terminal', label: '终端', icon: SquareTerminal },
    { id: 'diff', label: 'Diff', icon: FileDiff },
    { id: 'files', label: 'App.tsx', icon: FileCode2 },
  ]
  return (
    <section className="workbench-dock" aria-label="工作台">
      <header className="dock-header">
        <div className="dock-tabs" role="tablist">
          {tabs.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                type="button"
                role="tab"
                aria-selected={active === tab.id}
                className={active === tab.id ? 'active' : ''}
                key={tab.id}
                onClick={() => onChange(tab.id)}
              >
                <Icon size={14} aria-hidden="true" />{tab.label}
              </button>
            )
          })}
        </div>
        <div className="dock-actions">
          {active === 'terminal' && <span className="dock-runtime-state">未接通</span>}
          <IconButton label="关闭工作台" icon={X} onClick={onClose} />
        </div>
      </header>
      <div className="dock-body">
        {active === 'terminal' && <TerminalPane />}
        {active === 'diff' && <DiffPane previewExample={previewExample} />}
        {active === 'files' && <FilePane previewExample={previewExample} />}
      </div>
    </section>
  )
}

function GroupMenu({
  selected,
  groups,
  onSelect,
}: {
  selected: string
  groups: RelayGroupOption[]
  onSelect: (groupId: string) => void
}) {
  return (
    <div className="popover group-popover" role="menu" aria-label="接入分组">
      <div className="popover-heading"><span>接入分组</span><small>{groups.length} 个可用</small></div>
      <div className="menu-list group-list">
        {groups.map((group) => (
          <button
            type="button"
            role="menuitemradio"
            aria-checked={group.id === selected}
            key={group.id}
            onClick={() => onSelect(group.id)}
            className={group.id === selected ? 'selected' : ''}
          >
            <GitBranch size={14} />
            <span>
              <strong>{group.id}</strong>
              <small>{group.description || (group.id === 'auto' ? '自动选择渠道' : '可用接入分组')}</small>
            </span>
            {group.id === selected && <Check size={14} />}
          </button>
        ))}
      </div>
    </div>
  )
}

function ModelMenu({
  selected,
  catalog,
  groupId,
  onSelect,
}: {
  selected: string
  catalog: ModelOption[]
  groupId: string
  onSelect: (model: string) => void
}) {
  const [query, setQuery] = useState('')
  const filtered = catalog.filter((model) => `${model.name} ${model.detail}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  return (
    <div className="popover model-popover" role="dialog" aria-label="选择模型">
      <div className="popover-search"><Search size={14} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 API 模型" /></div>
      <div className="model-catalog-meta"><span>可用模型</span><small>{groupId || '直连渠道'} · {catalog.length} 个</small></div>
      <div className="menu-list">
        {filtered.map((model) => (
          <button type="button" key={model.id} onClick={() => onSelect(model.name)} className={model.name === selected ? 'selected' : ''}>
            <span><strong>{model.name}</strong><small>{model.detail}</small></span>
            {model.name === selected && <Check size={15} />}
          </button>
        ))}
      </div>
      {filtered.length === 0 && <p className="popover-empty">没有匹配的模型</p>}
    </div>
  )
}

function ReasoningMenu({
  selected,
  supported,
  onSelect,
}: {
  selected: string
  supported: string[]
  onSelect: (reasoning: string) => void
}) {
  return (
    <div className="popover compact-popover reasoning-popover" role="menu" aria-label="推理强度">
      <div className="popover-heading"><span>推理强度</span><small>用于下一轮</small></div>
      <div className="menu-list dense">
        {reasoningLevels.map((level) => {
          const available = supported.includes(reasoningKeys[level] ?? level.toLowerCase())
          return (
            <button type="button" role="menuitemradio" aria-checked={selected === level} key={level} disabled={!available} onClick={() => onSelect(level)} className={selected === level ? 'selected' : ''}>
              <span>{level}{!available && <small>当前模型不可用</small>}</span>{selected === level && <Check size={14} />}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function PermissionMenu({ selected, onSelect }: { selected: Permission; onSelect: (permission: Permission) => void }) {
  return (
    <div className="popover permission-popover" role="menu" aria-label="操作权限">
      <div className="popover-heading"><span>批准操作</span><small>只影响下一轮 Agent</small></div>
      <div className="menu-list permission-list">
        {permissionOptions.map((option) => {
          const Icon = option.icon
          return (
            <button type="button" role="menuitemradio" aria-checked={selected === option.id} key={option.id} onClick={() => onSelect(option.id)} className={`${selected === option.id ? 'selected' : ''} ${option.id === 'full' ? 'full-access' : ''}`}>
              <Icon size={16} />
              <span><strong>{option.name}</strong><small>{option.detail}</small></span>
              {selected === option.id && <Check size={14} />}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Composer({
  mode,
  onModeChange,
  groupId,
  groups,
  onGroupChange,
  model,
  modelCatalog,
  onModelChange,
  reasoning,
  supportedReasoning,
  reasoningNotice,
  onReasoningChange,
  permission,
  onPermissionChange,
  web,
  onWebChange,
  webAvailable,
  image,
  onImageChange,
  imageAvailable,
  modelCompatibilityNotice,
  localSubagents,
  onLocalSubagentsChange,
  localSubagentsAvailable,
  endpoint,
  endpointConfirmed,
  capabilityCatalog,
  onCapabilityCommand,
  onCapabilitySkill,
  onCapabilityPlugin,
  onCapabilityDiscover,
  capabilityDiscoveryLoading,
  capabilityDiscoveryLoadingTriggers,
  capabilityDiscoveryScopeKey,
  onCapabilityNotice,
  onCapabilityDraftChange,
  capabilitySkillLoading,
  readOnly,
  running,
  onSend,
  onStop,
}: {
  mode: WorkspaceMode
  onModeChange: (mode: WorkspaceMode) => void
  groupId: string
  groups: RelayGroupOption[]
  onGroupChange: (groupId: string) => void
  model: string
  modelCatalog: ModelOption[]
  onModelChange: (model: string) => void
  reasoning: string
  supportedReasoning: string[]
  reasoningNotice: string
  onReasoningChange: (reasoning: string) => void
  permission: Permission
  onPermissionChange: (permission: Permission) => void
  web: boolean
  onWebChange: (value: boolean) => void
  webAvailable: boolean
  image: boolean
  onImageChange: (value: boolean) => void
  imageAvailable: boolean
  modelCompatibilityNotice: string
  localSubagents: boolean
  onLocalSubagentsChange: (value: boolean) => void
  localSubagentsAvailable: boolean
  endpoint: string
  endpointConfirmed: boolean
  capabilityCatalog: CapabilityCatalog
  onCapabilityCommand: (id: CapabilityCommandId, args?: string) => Promise<boolean> | boolean
  onCapabilitySkill: (skill: SkillDescriptor) => Promise<void> | void
  onCapabilityPlugin: (plugin: PluginDescriptor) => void
  onCapabilityDiscover: (trigger: '$' | '@') => void
  capabilityDiscoveryLoading: boolean
  capabilityDiscoveryLoadingTriggers: readonly ('$' | '@')[]
  capabilityDiscoveryScopeKey: string
  onCapabilityNotice: (message: string) => void
  onCapabilityDraftChange: (value: string) => void
  capabilitySkillLoading: boolean
  readOnly: boolean
  running: boolean
  onSend: (
    value: string,
    attachmentTokens: string[],
    modeOverride?: WorkspaceMode
  ) => Promise<boolean>
  onStop: () => Promise<void>
}) {
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<Array<{
    token: string
    name: string
    size: string
    image: boolean
  }>>([])
  const [menu, setMenu] = useState<OpenMenu>(null)
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)
  const [capabilityPaletteState, setCapabilityPaletteState] = useState<{
    expanded: boolean
    activeDescendant?: string
  }>({ expanded: false })
  const capabilityPaletteId = useId()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const composingRef = useRef(false)
  const submitInFlightRef = useRef(false)

  useEffect(() => {
    const close = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [])

  const permissionOption = permissionOptions.find((item) => item.id === permission) ?? permissionOptions[0]!
  const PermissionIcon = permissionOption.icon
  const shortGroup = groupId || '接入分组'
  const shortModel = model.replace('GPT-', '').replace('gpt-', '') || '选择模型'

  const submit = async () => {
    const value = draft.trim() || (attachments.length ? `请阅读并处理附件：${attachments.map((item) => item.name).join('、')}` : '')
    if (!value || running || readOnly || submitInFlightRef.current) return
    submitInFlightRef.current = true
    try {
    if (capabilitySkillLoading) {
      onCapabilityNotice('技能正在加载，请稍候再发送。')
      return
    }
    const unavailablePlugin = capabilityCatalog.plugins.find(
      (entry) => !entry.enabled && hasCapabilityMention(value, '@', entry.id)
    )
    if (unavailablePlugin) {
      onCapabilityNotice(`插件 ${unavailablePlugin.name} 尚未启用，无法加入本轮请求。`)
      return
    }
    const mentionOnly = /^[$@][^\s]*$/u.test(value)
    if (
      mentionOnly &&
      (capabilityDiscoveryLoading ||
        (value.startsWith('$') && !capabilityCatalog.skills.some((entry) => `$${entry.id}` === value)) ||
        (value.startsWith('@') && !capabilityCatalog.plugins.some((entry) => `@${entry.id}` === value && entry.enabled)))
    ) {
      onCapabilityNotice('请先从能力菜单选择一个已加载的技能或插件。')
      return
    }
    const command = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/u.exec(value)
    const commandDescriptor = command
      ? capabilityCatalog.commands.find((entry) => entry.id === command[1] || entry.aliases.includes(command[1]!))
      : undefined
    if (command && commandDescriptor) {
      const commandReady = await onCapabilityCommand(commandDescriptor.id, command[2]?.trim())
      if (commandDescriptor.id === 'review') {
        if (!commandReady) return
        const accepted = await onSend(value, [], 'agent')
        if (!accepted) return
      }
      setDraft('')
      setAttachments([])
      setMenu(null)
      return
    }
    const accepted = await onSend(
      value,
      attachments.map((attachment) => attachment.token).filter(Boolean)
    )
    if (!accepted) return
    setDraft('')
    setAttachments([])
    setMenu(null)
    } finally {
      submitInFlightRef.current = false
    }
  }

  const updateDraft = (value: string): void => {
    setDraft(value)
    onCapabilityDraftChange(value)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !composingRef.current) {
      event.preventDefault()
      void submit()
    }
  }

  const addFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []).map((file) => ({
      token: '',
      name: file.name,
      size: file.size > 1024 * 1024 ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`,
      image: file.type.startsWith('image/'),
    }))
    setAttachments((current) => [...current, ...selected].slice(0, 6))
    event.target.value = ''
  }

  const selectAttachments = async () => {
    if (!('onekey' in window)) {
      fileInputRef.current?.click()
      return
    }
    try {
      const result = await window.onekey.dialog.selectAttachments()
      if (!result.ok) return
      const selected = result.value.map((attachment) => ({
        token: attachment.attachmentToken,
        name: attachment.displayName,
        size: '一次性授权',
        image: attachment.mediaKind === 'image',
      }))
      setAttachments((current) => [...current, ...selected].slice(0, 6))
    } catch {
      // The draft remains unchanged when the native picker cannot complete.
    }
  }

  return (
    <div className="composer-wrap">
      <div className="composer">
        <div className="composer-input-surface">
          {readOnly && (
            <div className="archived-composer-notice" role="status">
              <Archive size={14} aria-hidden="true" />
              <span>该会话已归档；移出归档后才能继续发送。</span>
            </div>
          )}
          {attachments.length > 0 && (
            <div className="attachment-list">
              {attachments.map((attachment, index) => (
                <div className="attachment-row" key={attachment.token || `${attachment.name}-${index}`}>
                  <span className="attachment-icon">{attachment.image ? <ImagePlus size={16} /> : <FileText size={16} />}</span>
                  <span><strong>{attachment.name}</strong><small>{attachment.image ? '图片' : '本地文件'} · {attachment.size}</small></span>
                  <IconButton label={`移除 ${attachment.name}`} icon={X} onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))} />
                </div>
              ))}
            </div>
          )}

          <div className="composer-input-row">
            <textarea
              value={draft}
              onChange={(event) => updateDraft(event.target.value)}
              onKeyDown={onKeyDown}
              onCompositionStart={() => { composingRef.current = true }}
              onCompositionEnd={() => { composingRef.current = false }}
              placeholder={readOnly
                ? '该会话已归档'
                : mode === 'agent'
                  ? '描述要在当前工作区完成的任务…'
                  : '发送消息，或添加文件和图片…'}
              rows={3}
              disabled={readOnly}
              data-capability-input="true"
              aria-autocomplete="list"
              aria-controls={capabilityPaletteId}
              aria-expanded={capabilityPaletteState.expanded}
              aria-haspopup="listbox"
              aria-activedescendant={capabilityPaletteState.activeDescendant}
              aria-label="消息"
            />
            <CapabilityPalette
              draft={draft}
              onDraftChange={updateDraft}
              catalog={capabilityCatalog}
              listId={capabilityPaletteId}
              onCommand={() => undefined}
              onSkill={(skill) => { void onCapabilitySkill(skill) }}
              onPlugin={onCapabilityPlugin}
              onStateChange={setCapabilityPaletteState}
              onDiscover={onCapabilityDiscover}
              discoveryScopeKey={capabilityDiscoveryScopeKey}
              discoveryLoading={capabilityDiscoveryLoading}
              discoveryLoadingTriggers={capabilityDiscoveryLoadingTriggers}
              disabled={running || readOnly}
            />
            <button
              type="button"
              className={`send-button ${running ? 'is-running' : ''}`}
              aria-label={running ? '停止生成' : '发送'}
              data-tooltip={running ? '停止生成' : '发送'}
              onClick={running ? () => void onStop() : () => void submit()}
              disabled={readOnly || (!running && !draft.trim() && attachments.length === 0)}
            >
              {running ? <Square size={14} fill="currentColor" /> : <ArrowUp size={18} />}
            </button>
          </div>

          <div className={`endpoint-row ${endpointConfirmed ? 'confirmed' : ''}`} title={endpoint}>
            <Server size={12} aria-hidden="true" />
            <span>{endpoint}</span>
            {endpointConfirmed ? <ShieldCheck size={12} aria-hidden="true" /> : <ShieldAlert size={12} aria-hidden="true" />}
            <small>{endpointConfirmed ? '本次会话已确认' : '未确认 · 未发送'}</small>
          </div>
        </div>

        {modelCompatibilityNotice && (
          <div className="model-compatibility-notice" role="status">
            <ShieldAlert size={13} aria-hidden="true" />
            <span>{modelCompatibilityNotice}</span>
          </div>
        )}

        <div className="composer-toolbar composer-meta-bar">
          <div className="composer-tools">
            <input ref={fileInputRef} type="file" multiple hidden onChange={addFiles} accept="image/png,image/jpeg,image/webp,.txt,.md,.csv,.json,.js,.jsx,.ts,.tsx,.py,.rs" />
            <IconButton label="添加文件或图片" icon={Paperclip} disabled={readOnly} onClick={() => void selectAttachments()} />
            <IconButton
              label={webAvailable
                ? web ? '关闭联网' : '开启联网'
                : '当前模型不支持联网搜索'}
              icon={Globe2}
              pressed={web}
              disabled={readOnly || !webAvailable}
              onClick={() => onWebChange(!web)}
            />
            <IconButton
              label={imageAvailable
                ? image ? '关闭图片生成' : '开启图片生成'
                : '当前模型不支持图片生成'}
              icon={ImagePlus}
              pressed={image}
              disabled={readOnly || !imageAvailable}
              onClick={() => onImageChange(!image)}
            />
            {mode === 'agent' && (
              <IconButton
                label={localSubagents ? '关闭本地子任务' : '开启本地子任务'}
                icon={Users}
                pressed={localSubagents}
                disabled={!localSubagentsAvailable}
                onClick={() => onLocalSubagentsChange(!localSubagents)}
              />
            )}
          </div>

          <div className="mode-segment" aria-label="工作模式">
            <button type="button" className={mode === 'chat' ? 'active' : ''} onClick={() => onModeChange('chat')}><MessageSquare size={13} />Chat</button>
            <button type="button" className={mode === 'agent' ? 'active' : ''} onClick={() => onModeChange('agent')}><Bot size={13} />Agent</button>
          </div>

          <div className="composer-selectors">
            {mode === 'agent' && (
              <div className="selector-anchor permission-anchor">
                <button
                  type="button"
                  className={`selector-button permission-button ${permission === 'full' ? 'warning' : ''}`}
                  onClick={() => setMenu((current) => current === 'permission' ? null : 'permission')}
                  aria-expanded={menu === 'permission'}
                >
                  <PermissionIcon size={14} />
                  <span>{permissionOption.name}</span>
                  <ChevronDown size={12} />
                </button>
                {menu === 'permission' && (
                  <PermissionMenu
                    selected={permission}
                    onSelect={(value) => {
                      setMenu(null)
                      if (value === 'full') setConfirmFullAccess(true)
                      else onPermissionChange(value)
                    }}
                  />
                )}
              </div>
            )}

            {groups.length > 0 && (
              <div className="selector-anchor group-anchor">
                <button
                  type="button"
                  className="selector-button group-button"
                  onClick={() => setMenu((current) => current === 'group' ? null : 'group')}
                  aria-expanded={menu === 'group'}
                  aria-label={`接入分组：${shortGroup}`}
                  title={`接入分组：${shortGroup}`}
                  disabled={running}
                >
                  <GitBranch size={14} />
                  <span>{shortGroup}</span>
                  <ChevronDown size={12} />
                </button>
                {menu === 'group' && (
                  <GroupMenu
                    selected={groupId}
                    groups={groups}
                    onSelect={(value) => {
                      onGroupChange(value)
                      setMenu(null)
                    }}
                  />
                )}
              </div>
            )}

            <div className="selector-anchor model-anchor">
              <button type="button" className="selector-button model-button" onClick={() => setMenu((current) => current === 'model' ? null : 'model')} aria-expanded={menu === 'model'} title={model || '选择模型'}>
                <span>{shortModel}</span><ChevronDown size={12} />
              </button>
              {menu === 'model' && <ModelMenu selected={model} catalog={modelCatalog} groupId={groupId} onSelect={(value) => { onModelChange(value); setMenu(null) }} />}
            </div>

            <div className="selector-anchor reasoning-anchor">
              {reasoningNotice && <span className="degraded-indicator" title={reasoningNotice}>已降级</span>}
              <button type="button" className="selector-button reasoning-button" onClick={() => setMenu((current) => current === 'reasoning' ? null : 'reasoning')} aria-expanded={menu === 'reasoning'}>
                <WandSparkles size={14} /><span>{reasoning}</span><ChevronDown size={12} />
              </button>
              {menu === 'reasoning' && <ReasoningMenu selected={reasoning} supported={supportedReasoning} onSelect={(value) => { onReasoningChange(value); setMenu(null) }} />}
            </div>

          </div>
        </div>

        {confirmFullAccess && (
          <div className="modal-scrim" role="presentation" onMouseDown={() => setConfirmFullAccess(false)}>
            <div
              className="access-confirm"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="full-access-title"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="access-confirm-icon"><ShieldAlert size={18} /></div>
              <div>
                <strong id="full-access-title">为下一轮开启完全访问？</strong>
                <p>Agent 可在所选工作区内读取和写入普通文件而减少确认，但 endpoint 确认、路径与敏感文件边界、凭据保护仍然有效。命令和终端尚未接入；应用重启后会恢复为“请求批准”。</p>
              </div>
              <div className="access-confirm-actions">
                <button type="button" onClick={() => setConfirmFullAccess(false)}>取消</button>
                <button
                  type="button"
                  className="confirm-full"
                  onClick={() => {
                    onPermissionChange('full')
                    setConfirmFullAccess(false)
                  }}
                >
                  开启完全访问
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default function App() {
  const [electronRenderer] = useState(() => 'onekey' in window)
  const [surface, setSurface] = useState<AppSurface>('workspace')
  const [userCenterReturnSurface, setUserCenterReturnSurface] = useState<'workspace' | 'settings'>('workspace')
  const [taskGroups, setTaskGroups] = useState<TaskGroup[]>(electronRenderer ? [] : previewTaskGroups)
  const [mode, setMode] = useState<WorkspaceMode>('agent')
  const [selectedTask, setSelectedTask] = useState(electronRenderer ? '' : 'workspace-redesign')
  const [title, setTitle] = useState(electronRenderer ? '新 Agent 任务' : '完善 React 工作区')
  const [relayGroups, setRelayGroups] = useState<RelayGroupOption[]>(electronRenderer ? [] : previewRelayGroups)
  const [selectedRelayGroupId, setSelectedRelayGroupId] = useState(electronRenderer ? '' : 'auto')
  const [model, setModel] = useState(electronRenderer ? '' : 'GPT-5.6 Sol Ultra')
  const [modelCatalog, setModelCatalog] = useState<ModelOption[]>(electronRenderer ? [] : fallbackModels)
  const [profileHandle, setProfileHandle] = useState('')
  const [profileHasKey, setProfileHasKey] = useState(false)
  const [relayProfileName, setRelayProfileName] = useState('wzh-server')
  const [relayAccountNameValue, setRelayAccountNameValue] = useState('')
  const [relayEndpoint, setRelayEndpoint] = useState<string>(WZH_MODEL_BASE_URL)
  const [modelCatalogState, setModelCatalogState] = useState<'preview' | 'idle' | 'loading' | 'remote' | 'error'>(electronRenderer ? 'idle' : 'preview')
  const [confirmedCatalogMode, setConfirmedCatalogMode] = useState<WorkspaceMode | null>(null)
  const [confirmedCatalogGroupId, setConfirmedCatalogGroupId] = useState<string | null | undefined>(undefined)
  const [modelCatalogMessage, setModelCatalogMessage] = useState(
    electronRenderer
      ? '尚未读取已确认 endpoint 的模型目录。'
      : '当前为内置预览目录；尚未访问远程 endpoint。'
  )
  const [capabilityCatalog, setCapabilityCatalog] = useState<CapabilityCatalog>(previewCapabilityCatalog)
  const [planMode, setPlanMode] = useState(false)
  const [taskGoal, setTaskGoal] = useState('')
  const [memoryUseEnabled, setMemoryUseEnabled] = useState(true)
  const [memoryGenerationEnabled, setMemoryGenerationEnabled] = useState(true)
  const [contextSummary, setContextSummary] = useState('')
  const [capabilityNotice, setCapabilityNotice] = useState('')
  const [projectInitPreview, setProjectInitPreview] = useState<ProjectInitPreview | null>(null)
  const [projectInitCommitting, setProjectInitCommitting] = useState(false)
  const [capabilityDiscoveryLoadingTriggers, setCapabilityDiscoveryLoadingTriggers] = useState<Array<'$' | '@'>>([])
  const [selectedSkillMention, setSelectedSkillMention] = useState<{ id: string; name: string } | null>(null)
  const [selectedSkillInstructions, setSelectedSkillInstructions] = useState('')
  const [capabilitySkillLoading, setCapabilitySkillLoading] = useState(false)
  const [selectedPluginMention, setSelectedPluginMention] = useState<PluginDescriptor | null>(null)
  const [runtime, setRuntime] = useState<BootstrapPayload['runtime']>(previewRuntime)
  const [reasoning, setReasoning] = useState(electronRenderer ? 'Auto' : 'Ultra')
  const [reasoningNotice, setReasoningNotice] = useState('')
  const [permission, setPermission] = useState<Permission>('ask')
  const [web, setWeb] = useState(true)
  const [image, setImage] = useState(false)
  const [localSubagents, setLocalSubagents] = useState(false)
  const [settingsPreferences, setSettingsPreferences] = useState<SettingsPreferences>(DEFAULT_SETTINGS_PREFERENCES)
  const [settingsView, setSettingsView] = useState<SettingsView>('general')
  const [contextOpen, setContextOpen] = useState(false)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [dock, setDock] = useState<DockTab | null>(null)
  const [running, setRunning] = useState(false)
  const [turnActivity, setTurnActivity] = useState<TurnActivityState | null>(null)
  const [turnElapsedSeconds, setTurnElapsedSeconds] = useState(0)
  const [backendTaskId, setBackendTaskId] = useState('')
  const [workspaceToken, setWorkspaceToken] = useState('')
  const [workspaceName, setWorkspaceName] = useState('')
  const [workspaceOpeners, setWorkspaceOpeners] = useState<WorkspaceOpenerDescriptor[]>([])
  const [workspaceOpenersDetected, setWorkspaceOpenersDetected] = useState(false)
  const [workspaceOpenerNotice, setWorkspaceOpenerNotice] = useState('')
  const [conversationMessages, setConversationMessages] = useState<ConversationMessageDto[]>([])
  const [generatedImages, setGeneratedImages] = useState<Record<string, string[]>>({})
  const [turnMessage, setTurnMessage] = useState('')
  const [chatEndpointConfirmed, setChatEndpointConfirmed] = useState(false)
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequestEvent | null>(null)
  const [resolvingApproval, setResolvingApproval] = useState(false)
  const [pendingDeleteTask, setPendingDeleteTask] = useState<Task | null>(null)
  const [historyDeleteError, setHistoryDeleteError] = useState('')
  const [historyActionTaskId, setHistoryActionTaskId] = useState('')
  const selectedTaskArchived = useMemo(
    () => taskGroups.some((group) => group.tasks.some(
      (task) => task.id === selectedTask && Boolean(task.archivedAt),
    )),
    [selectedTask, taskGroups],
  )
  const capabilityDiscoveryLoading = capabilityDiscoveryLoadingTriggers.length > 0
  const activeTurnIdRef = useRef('')
  const activeAssistantIdRef = useRef('')
  const cancellingTurnIdRef = useRef('')
  const pendingStartRequestIdRef = useRef('')
  const pendingStartCancelRequestedRef = useRef(false)
  const pendingReviewHandleRef = useRef('')
  const pendingAgentEventsRef = useRef<AgentEvent[]>([])
  const smoothTextStreamRef = useRef<{ assistantId: string; stream: SmoothTextStream } | null>(null)
  const capabilityDiscoveryRef = useRef(new Set<string>())
  const capabilityDiscoverySequenceRef = useRef(0)
  const capabilitySelectionSequenceRef = useRef(0)
  const messageSequenceRef = useRef(0)
  const taskLoadSequenceRef = useRef(0)
  const taskLoadMountedRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const generatedImageUrlsRef = useRef(new Set<string>())
  const generatedImageGenerationRef = useRef(0)
  const modelRefreshSequenceRef = useRef(0)
  const workspaceOpenerDetectionRef = useRef<Promise<WorkspaceOpenerDescriptor[]> | null>(null)
  const workspaceLaunchTokenRef = useRef<string | null>(null)
  const projectInitReturnFocusRef = useRef<HTMLElement | null>(null)
  const activeWorkspaceTokenRef = useRef(workspaceToken)

  useEffect(() => {
    activeWorkspaceTokenRef.current = workspaceToken
    pendingReviewHandleRef.current = ''
    workspaceLaunchTokenRef.current = null
    workspaceOpenerDetectionRef.current = null
  }, [workspaceToken])

  useEffect(() => {
    if (!running || turnActivity === null) {
      setTurnElapsedSeconds(0)
      return
    }
    const updateElapsed = (): void => {
      setTurnElapsedSeconds(Math.max(0, Math.floor((Date.now() - turnActivity.startedAt) / 1000)))
    }
    updateElapsed()
    const interval = window.setInterval(updateElapsed, 1000)
    return () => window.clearInterval(interval)
  }, [running, turnActivity?.startedAt])

  const clearGeneratedImages = useCallback(() => {
    generatedImageGenerationRef.current += 1
    for (const url of generatedImageUrlsRef.current) URL.revokeObjectURL(url)
    generatedImageUrlsRef.current.clear()
    setGeneratedImages({})
  }, [])

  const clearCapabilitySelection = useCallback(() => {
    capabilitySelectionSequenceRef.current += 1
    setSelectedSkillMention(null)
    setSelectedSkillInstructions('')
    setCapabilitySkillLoading(false)
    setSelectedPluginMention(null)
  }, [])

  const discardSmoothTextStream = useCallback((): void => {
    smoothTextStreamRef.current?.stream.discard()
    smoothTextStreamRef.current = null
  }, [])

  const beginSmoothTextStream = useCallback((assistantId: string): void => {
    discardSmoothTextStream()
    const reducedMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const stream = new SmoothTextStream((text) => {
      setConversationMessages((current) => current.map((message) => message.id === assistantId
        ? { ...message, content: `${message.content}${text}`, updatedAt: new Date().toISOString() }
        : message))
    }, { reducedMotion })
    smoothTextStreamRef.current = { assistantId, stream }
  }, [discardSmoothTextStream])

  const flushSmoothTextStream = useCallback((assistantId: string): void => {
    const active = smoothTextStreamRef.current
    if (!active || active.assistantId !== assistantId) return
    active.stream.flush()
    smoothTextStreamRef.current = null
  }, [])

  const setTurnActivityPhase = useCallback((phase: TurnActivityPhase, detail: string): void => {
    setTurnActivity((current) => ({
      startedAt: current?.startedAt ?? Date.now(),
      phase,
      detail,
    }))
  }, [])

  const applyCapabilitySession = useCallback((session: CapabilityCatalog['session']): void => {
    if (!session) return
    setPlanMode(session.planMode)
    setMemoryUseEnabled(session.memoriesEnabled)
    setMemoryGenerationEnabled(session.memoriesEnabled)
    setTaskGoal(
      session.goal && session.goal.status !== 'cleared'
        ? session.goal.text
        : ''
    )
  }, [])

  useEffect(() => {
    taskLoadMountedRef.current = true
    return () => {
      taskLoadMountedRef.current = false
      taskLoadSequenceRef.current += 1
      discardSmoothTextStream()
      for (const url of generatedImageUrlsRef.current) URL.revokeObjectURL(url)
      generatedImageUrlsRef.current.clear()
    }
  }, [discardSmoothTextStream])

  const loadConversationTask = useCallback((task: Task): void => {
    discardSmoothTextStream()
    clearGeneratedImages()
    clearCapabilitySelection()
    taskLoadSequenceRef.current += 1
    const loadSequence = taskLoadSequenceRef.current
    setSelectedTask(task.id)
    setTitle(task.title)
    setMode(task.mode)
    setContextSummary('')
    setTurnMessage('')
    setTurnActivity(null)
    setConversationMessages([])
    setBackendTaskId(isHistoryTaskId(task.id) ? task.id : '')
    setPendingApproval(null)
    setTasksOpen(false)
    if (!isHistoryTaskId(task.id) || !('onekey' in window)) return
    void window.onekey.conversation.load({ taskId: task.id }).then((result) => {
      if (!taskLoadMountedRef.current || loadSequence !== taskLoadSequenceRef.current) return
      if (!result.ok) {
        setTurnMessage(result.error.message)
        return
      }
      setConversationMessages(result.value.messages)
    }).catch(() => {
      if (taskLoadMountedRef.current && loadSequence === taskLoadSequenceRef.current) {
        setTurnMessage('无法加载加密对话历史，请重试。')
      }
    })
  }, [clearCapabilitySelection, clearGeneratedImages, discardSmoothTextStream])

  useEffect(() => {
    if (!('onekey' in window)) return
    let disposed = false
    const restoreSequence = taskLoadSequenceRef.current
    void window.onekey.app.getBootstrap().then((result) => {
      if (disposed) return
      if (!result.ok) {
        setRuntime({ ...previewRuntime, status: 'degraded', message: '无法读取 Electron Main 运行状态。' })
        setModelCatalogState('error')
        setModelCatalogMessage(result.error.message)
        return
      }
      setRuntime(result.value.runtime)
      const options = toModelOptions(result.value.models)
      setModelCatalog(options)
      setTaskGroups(toHistoryTaskGroups(result.value.projects))
      const activeTask = result.value.projects
        .flatMap((project) => project.tasks)
        .find((task) => task.id === result.value.activeTaskId)
      if (activeTask && restoreSequence === taskLoadSequenceRef.current) {
        loadConversationTask(toUiTask(activeTask))
      }
      const active = options.find((entry) => entry.id === result.value.defaults.activeModelId)
      setModel(active?.name ?? options[0]?.name ?? '')
      setReasoning(reasoningLabels[result.value.defaults.reasoning] ?? 'Auto')
      setProfileHandle(result.value.defaults.activeProfileHandle)
      const activeProfile = result.value.profiles.find((entry) => entry.credentialHandle === result.value.defaults.activeProfileHandle)
      if (activeProfile) {
        setRelayProfileName(activeProfile.name)
        setRelayEndpoint(activeProfile.baseUrl)
        setProfileHasKey(activeProfile.hasKey)
        if (activeProfile.hasKey) {
          setModelCatalogState('idle')
          setModelCatalogMessage(activeProfile.credentialHandle === WZH_RELAY_PROFILE_HANDLE
            ? '账户已登录，正在读取可用模型。'
            : 'API Key 已安全保存；点击刷新后会确认精确 endpoint 并读取 /models。')
        }
      } else {
        setModelCatalogState('idle')
        setModelCatalogMessage('请先安全保存渠道，再读取已确认 endpoint 的模型目录。')
      }
    }).catch(() => {
      if (disposed) return
      setRuntime({ ...previewRuntime, status: 'degraded', message: 'Electron Main 初始化未完成。' })
      setModelCatalogState('error')
      setModelCatalogMessage('安全后端初始化未完成，请重启应用后重试。')
    })
    return () => { disposed = true }
  }, [loadConversationTask])

  useEffect(() => {
    if (!electronRenderer || !('onekey' in window)) {
      setCapabilityCatalog(previewCapabilityCatalog)
      return
    }
    let disposed = false
    void window.onekey.capabilities.list().then((result) => {
      if (disposed) return
      if (!result.ok) {
        setCapabilityNotice(result.error.message)
        return
      }
      setCapabilityCatalog(result.value)
      applyCapabilitySession(result.value.session)
      setCapabilityNotice('')
    }).catch(() => {
      if (!disposed) setCapabilityNotice('能力目录暂时不可用。')
    })
    return () => { disposed = true }
  }, [applyCapabilitySession, electronRenderer])

  const refreshModelCatalog = async (): Promise<{ ok: boolean; message: string }> => {
    if (!profileHandle || !profileHasKey) {
      const message = '请先安全保存 API Key，再读取远程模型目录。'
      setModelCatalogState('error')
      setModelCatalogMessage(message)
      return { ok: false, message }
    }
    const relayProfile = profileHandle === WZH_RELAY_PROFILE_HANDLE
    const requestGroupId = relayProfile ? selectedRelayGroupId : null
    if (relayProfile && !requestGroupId) {
      const message = '尚未读取可用接入分组，请稍后重试。'
      setModelCatalogState('error')
      setModelCatalogMessage(message)
      return { ok: false, message }
    }
    if (!('onekey' in window)) {
      const message = '浏览器预览不允许访问模型 endpoint。'
      setModelCatalogState('preview')
      setModelCatalogMessage(message)
      return { ok: false, message }
    }

    const refreshSequence = ++modelRefreshSequenceRef.current
    const requestMode = mode
    const requestProfileHandle = profileHandle
    setModelCatalogState('loading')
    setConfirmedCatalogMode(null)
    setConfirmedCatalogGroupId(undefined)
    setModelCatalogMessage('等待 endpoint 批准并读取模型目录...')
    try {
      const result = await window.onekey.models.list({
        profileHandle: requestProfileHandle,
        mode: requestMode,
        groupId: requestGroupId
      })
      if (refreshSequence !== modelRefreshSequenceRef.current) {
        return { ok: false, message: '模型目录选择已变化。' }
      }
      if (!result.ok) {
        setModelCatalogState('error')
        setModelCatalogMessage(result.error.message)
        return { ok: false, message: result.error.message }
      }
      const options = toModelOptions(result.value)
      if (options.length === 0) {
        const message = '远程模型目录为空，已保留当前目录。'
        setModelCatalogState('error')
        setModelCatalogMessage(message)
        return { ok: false, message }
      }
      setModelCatalog(options)
      setConfirmedCatalogMode(requestMode)
      setConfirmedCatalogGroupId(requestGroupId)
      if (!options.some((entry) => entry.name === model)) setModel(options[0]!.name)
      const message = requestGroupId
        ? `已读取 ${requestGroupId} 分组的 ${options.length} 个模型。`
        : `已从确认的 endpoint 读取 ${options.length} 个模型。`
      setModelCatalogState('remote')
      setModelCatalogMessage(message)
      return { ok: true, message }
    } catch {
      if (refreshSequence !== modelRefreshSequenceRef.current) {
        return { ok: false, message: '模型目录选择已变化。' }
      }
      const message = '模型目录请求未完成，请重试。'
      setModelCatalogState('error')
      setModelCatalogMessage(message)
      return { ok: false, message }
    }
  }

  useEffect(() => {
    if (
      !electronRenderer ||
      profileHandle !== WZH_RELAY_PROFILE_HANDLE ||
      !profileHasKey ||
      !selectedRelayGroupId ||
      (confirmedCatalogMode === mode && confirmedCatalogGroupId === selectedRelayGroupId) ||
      (modelCatalogState !== 'idle' && modelCatalogState !== 'remote')
    ) {
      return
    }
    void refreshModelCatalog()
  }, [confirmedCatalogGroupId, confirmedCatalogMode, electronRenderer, mode, modelCatalogState, profileHandle, profileHasKey, selectedRelayGroupId])

  useEffect(() => {
    if (
      !electronRenderer
      || profileHandle !== WZH_RELAY_PROFILE_HANDLE
      || !profileHasKey
      || !('onekey' in window)
    ) {
      setRelayAccountNameValue('')
      return
    }

    let disposed = false
    void window.onekey.relay.getOverview().then((result) => {
      if (disposed) return
      if (!result.ok) {
        setModelCatalogState('error')
        setModelCatalogMessage(result.error.message)
        return
      }
      setRelayAccountNameValue(relayAccountName(result.value.account))
      const accountGroup = result.value.account.group
      const groups = [...result.value.groups].sort((left, right) => {
        const priority = (id: string): number => id === accountGroup ? 0 : id === 'auto' ? 1 : 2
        return priority(left.id) - priority(right.id) || left.id.localeCompare(right.id)
      })
      setRelayGroups(groups)
      setSelectedRelayGroupId((current) => {
        if (groups.some((group) => group.id === current)) return current
        if (accountGroup && groups.some((group) => group.id === accountGroup)) return accountGroup
        if (groups.some((group) => group.id === 'auto')) return 'auto'
        return groups[0]?.id ?? ''
      })
      if (groups.length === 0) {
        setModelCatalogState('error')
        setModelCatalogMessage('当前账户没有可用的接入分组。')
      }
    }).catch(() => undefined)
    return () => { disposed = true }
  }, [electronRenderer, profileHandle, profileHasKey])

  const handleProfileSaved = (profile: PublicAccessProfile) => {
    setProfileHandle(profile.credentialHandle)
    setProfileHasKey(profile.hasKey)
    setRelayProfileName(profile.name)
    setRelayAccountNameValue('')
    setRelayEndpoint(profile.baseUrl)
    setChatEndpointConfirmed(false)
    modelRefreshSequenceRef.current += 1
    setConfirmedCatalogMode(null)
    setConfirmedCatalogGroupId(undefined)
    setRelayGroups([])
    setSelectedRelayGroupId('')
    setModelCatalogState('idle')
    setModelCatalogMessage('渠道已安全保存；尚未访问远程 endpoint。')
  }

  const selectedModel = modelCatalog.find((entry) => entry.name === model)
  const relayAccountProfile = profileHandle === WZH_RELAY_PROFILE_HANDLE
  const accountDisplayName = relayAccountProfile
    ? relayAccountNameValue || '已登录用户'
    : relayProfileName
  const activeCatalogGroupId = relayAccountProfile ? selectedRelayGroupId : null
  const modelConnected = modelCatalogState === 'remote' &&
    confirmedCatalogMode === mode &&
    confirmedCatalogGroupId === activeCatalogGroupId
  const connectionLabel = !electronRenderer
    ? '本地预览 · 未联网'
    : modelConnected
      ? relayAccountProfile ? '账户已登录 · 模型已连接' : 'API Key · 模型已连接'
      : modelCatalogState === 'loading'
        ? '正在读取可用模型'
        : modelCatalogState === 'error'
          ? '模型服务暂不可用'
          : relayAccountProfile
            ? '账户已登录 · 模型未就绪'
            : '本地配置 · 模型未就绪'
  const supportedReasoning = selectedModel?.reasoning ?? ['auto']
  const localSubagentsAvailable = selectedModel?.localSubagentsAllowed ?? false
  const webSearchAvailable = selectedModel?.webSearchAllowed ?? false
  const imageGenerationAvailable = selectedModel?.imageGenerationAllowed ?? false
  const modelCompatibilityNotice = selectedModel?.wireMode === 'lite'
    ? '当前模型使用 Responses Lite，已关闭联网搜索和图片生成。需要这些能力时，请切换到支持它们的标准模型。'
    : ''

  useEffect(() => {
    if (!localSubagentsAvailable && localSubagents) setLocalSubagents(false)
  }, [localSubagents, localSubagentsAvailable])

  useEffect(() => {
    if (!selectedModel) return
    if (!webSearchAvailable && web) setWeb(false)
    if (!imageGenerationAvailable && image) setImage(false)
  }, [image, imageGenerationAvailable, selectedModel, web, webSearchAvailable])

  useEffect(() => {
    const key = reasoningKeys[reasoning] ?? reasoning.toLowerCase()
    if (supportedReasoning.includes(key)) return
    setReasoningNotice(`${model} 不支持 ${reasoning}，已改用 Auto。`)
    setReasoning('Auto')
  }, [model, reasoning, supportedReasoning])

  const createUiMessage = (
    role: ConversationMessageDto['role'],
    content: string,
    status: ConversationMessageDto['status']
  ): ConversationMessageDto => {
    messageSequenceRef.current += 1
    const timestamp = new Date().toISOString()
    return {
      id: `ui-message:${messageSequenceRef.current}`,
      role,
      content,
      status,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
  }

  const applyAgentEvent = (event: AgentEvent) => {
    if (!('turnId' in event) || event.turnId !== activeTurnIdRef.current) return
    if (event.type === 'approval-request') {
      setPendingApproval(event)
      setRunning(true)
      setTurnActivityPhase('approval', '等待你确认受控操作')
      return
    }
    if (event.type === 'image-result') {
      if (!('onekey' in window)) return
      const assistantId = activeAssistantIdRef.current
      const generation = generatedImageGenerationRef.current
      void window.onekey.image.read({ imageToken: event.imageToken }).then((result) => {
        if (!result.ok) {
          setTurnMessage(result.error.message)
          return
        }
        const source = generatedImageObjectUrl(result.value)
        if (!source) {
          setTurnMessage('生成图片未通过本地显示校验。')
          return
        }
        if (generation !== generatedImageGenerationRef.current) {
          URL.revokeObjectURL(source)
          return
        }
        generatedImageUrlsRef.current.add(source)
        setGeneratedImages((current) => ({
          ...current,
          [assistantId]: [...(current[assistantId] ?? []), source]
        }))
      }).catch(() => {
        setTurnMessage('生成图片读取未完成，请重试。')
      })
      return
    }
    if (event.type === 'assistant-delta') {
      const assistantId = activeAssistantIdRef.current
      if (!assistantId) return
      if (smoothTextStreamRef.current?.assistantId !== assistantId) beginSmoothTextStream(assistantId)
      smoothTextStreamRef.current?.stream.push(event.text)
      return
    }
    if (event.type === 'tool-status') {
      if (event.status !== 'running') setPendingApproval(null)
      setTurnActivityPhase(
        event.status === 'running' ? 'tool' : 'thinking',
        event.status === 'running' ? `正在执行：${event.label}` : '工具步骤已结束，正在整理结果',
      )
      return
    }
    if (event.type !== 'turn-status') return
    if (event.status === 'queued' || event.status === 'running' || event.status === 'waiting-approval') {
      setRunning(true)
      const phase: TurnActivityPhase = event.status === 'queued'
        ? 'queued'
        : event.status === 'waiting-approval'
          ? 'approval'
          : 'thinking'
      const detail = event.message ?? (event.status === 'queued'
        ? '请求已发送，等待模型响应'
        : event.status === 'waiting-approval'
          ? '等待你批准下一步操作'
          : '正在分析并生成回答')
      setTurnActivityPhase(phase, detail)
      setTurnMessage('')
      if (event.status !== 'waiting-approval') setPendingApproval(null)
      return
    }

    const assistantId = activeAssistantIdRef.current
    const status: ConversationMessageDto['status'] = event.status === 'completed'
      ? 'complete'
      : event.status === 'cancelled'
        ? 'cancelled'
        : 'failed'
    flushSmoothTextStream(assistantId)
    setConversationMessages((current) => current.map((message) => message.id === assistantId
      ? { ...message, status, updatedAt: new Date().toISOString() }
      : message))
    setTurnMessage(event.message ?? '')
    setRunning(false)
    setTurnActivity(null)
    setPendingApproval(null)
    cancellingTurnIdRef.current = ''
    activeTurnIdRef.current = ''
    activeAssistantIdRef.current = ''
  }

  useEffect(() => {
    if (!('onekey' in window)) return
    return window.onekey.onAgentEvent((event) => {
      if (!activeTurnIdRef.current) {
        pendingAgentEventsRef.current = [...pendingAgentEventsRef.current.slice(-63), event]
        return
      }
      applyAgentEvent(event)
    })
  }, [])

  const closeDrawers = () => {
    setContextOpen(false)
    setTasksOpen(false)
  }

  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeDrawers()
    }
    window.addEventListener('keydown', handleEscape)
    return () => {
      window.removeEventListener('keydown', handleEscape)
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
  }, [])

  const selectTask = (task: Task) => {
    if (running) return
    loadConversationTask(task)
  }

  const newTask = (nextMode: WorkspaceMode) => {
    if (running) return
    discardSmoothTextStream()
    clearGeneratedImages()
    clearCapabilitySelection()
    taskLoadSequenceRef.current += 1
    setSelectedTask('')
    setTitle(nextMode === 'agent' ? '新 Agent 任务' : '新 Chat')
    setMode(nextMode)
    setContextSummary('')
    setBackendTaskId('')
    setPendingApproval(null)
    setConversationMessages([])
    setTurnMessage('')
    setTurnActivity(null)
    setTasksOpen(false)
  }

  const changeMode = (nextMode: WorkspaceMode) => {
    if (nextMode === mode || running) return
    newTask(nextMode)
  }

  const changeRelayGroup = (nextGroupId: string) => {
    if (
      running ||
      nextGroupId === selectedRelayGroupId ||
      !relayGroups.some((group) => group.id === nextGroupId)
    ) {
      return
    }
    setSelectedRelayGroupId(nextGroupId)
    setTurnMessage('')
    if (!electronRenderer) return
    modelRefreshSequenceRef.current += 1
    setConfirmedCatalogMode(null)
    setConfirmedCatalogGroupId(undefined)
    setModelCatalog([])
    setModel('')
    setModelCatalogState('idle')
    setModelCatalogMessage(`正在读取 ${nextGroupId} 分组的可用模型。`)
  }

  async function revokeProjectInitDraft(
    preview: ProjectInitPreview,
    authorizedWorkspaceToken: string,
  ): Promise<boolean> {
    if (!('onekey' in window)) return true
    try {
      const result = await window.onekey.capabilities.execute({
        id: 'init',
        workspaceToken: authorizedWorkspaceToken,
        draftHandle: preview.draftHandle,
        projectInitAction: 'discard',
      })
      return result.ok
    } catch {
      return false
    }
  }

  function restoreProjectInitFocus(): void {
    const target = projectInitReturnFocusRef.current
    projectInitReturnFocusRef.current = null
    window.setTimeout(() => target?.focus(), 0)
  }

  const selectWorkspace = async (): Promise<{ token: string; name: string } | null> => {
    if (!('onekey' in window)) {
      const previewSelection = { token: 'preview-workspace', name: 'OneKeyElectron' }
      setWorkspaceToken(previewSelection.token)
      setWorkspaceName(previewSelection.name)
      setProjectInitPreview(null)
      setWorkspaceOpenerNotice('')
      return previewSelection
    }
    try {
      const result = await window.onekey.dialog.selectWorkspace()
      if (!result.ok) {
        setTurnMessage(result.error.message)
        return null
      }
      if (!result.value) return null
      if (result.value.workspaceToken !== workspaceToken) {
        discardSmoothTextStream()
        if (projectInitPreview && workspaceToken) {
          await revokeProjectInitDraft(projectInitPreview, workspaceToken)
        }
        capabilityDiscoveryRef.current.clear()
        capabilityDiscoverySequenceRef.current += 1
        clearCapabilitySelection()
        setCapabilityCatalog(previewCapabilityCatalog)
        setCapabilityDiscoveryLoadingTriggers([])
        setProjectInitPreview(null)
        setBackendTaskId('')
        setSelectedTask('')
        setConversationMessages([])
        setTurnActivity(null)
        clearGeneratedImages()
        setTitle('新任务')
        setCapabilityNotice('工作区已切换，已清除先前选择的能力。')
      }
      setWorkspaceToken(result.value.workspaceToken)
      setWorkspaceName(result.value.displayName)
      setWorkspaceOpenerNotice('')
      setTurnMessage('')
      return { token: result.value.workspaceToken, name: result.value.displayName }
    } catch {
      setTurnMessage('工作区选择未完成，请重试。')
      return null
    }
  }

  const detectWorkspaceOpeners = async (): Promise<WorkspaceOpenerDescriptor[]> => {
    if (workspaceOpenerDetectionRef.current) return workspaceOpenerDetectionRef.current
    workspaceLaunchTokenRef.current = null
    if (!workspaceToken) {
      setWorkspaceOpenerNotice('请先选择一个本地工作区。')
      return []
    }
    const requestedWorkspaceToken = workspaceToken
    const request = (async (): Promise<WorkspaceOpenerDescriptor[]> => {
      if (!('onekey' in window)) {
        setWorkspaceOpeners(previewWorkspaceOpeners)
        setWorkspaceOpenersDetected(true)
        setWorkspaceOpenerNotice('浏览器预览仅展示菜单，不会打开本机应用。')
        return previewWorkspaceOpeners
      }
      setWorkspaceOpenerNotice('')
      try {
        const result = await window.onekey.workspace.listOpeners({
          workspaceToken: requestedWorkspaceToken,
          confirmation: 'detect',
        })
        if (activeWorkspaceTokenRef.current !== requestedWorkspaceToken) return []
        if (!result.ok) {
          setWorkspaceOpeners([])
          setWorkspaceOpenersDetected(true)
          setWorkspaceOpenerNotice(result.error.message)
          return []
        }
        workspaceLaunchTokenRef.current = result.value.launchToken
        setWorkspaceOpeners(result.value.openers)
        setWorkspaceOpenersDetected(true)
        return result.value.openers
      } catch {
        if (activeWorkspaceTokenRef.current !== requestedWorkspaceToken) return []
        setWorkspaceOpeners([])
        setWorkspaceOpenersDetected(true)
        setWorkspaceOpenerNotice('本机打开方式检测未完成，请重试。')
        return []
      }
    })()
    workspaceOpenerDetectionRef.current = request
    try {
      return await request
    } finally {
      if (workspaceOpenerDetectionRef.current === request) workspaceOpenerDetectionRef.current = null
    }
  }

  const openWorkspaceWith = async (openerId: WorkspaceOpenerId): Promise<boolean> => {
    if (!workspaceToken || mode !== 'agent') {
      workspaceLaunchTokenRef.current = null
      setWorkspaceOpenerNotice('请先选择一个本地工作区。')
      return false
    }
    if (!('onekey' in window)) {
      workspaceLaunchTokenRef.current = null
      const label = previewWorkspaceOpeners.find((entry) => entry.id === openerId)?.label ?? '所选应用'
      setWorkspaceOpenerNotice(`浏览器预览不会启动 ${label}。`)
      return false
    }
    const launchToken = workspaceLaunchTokenRef.current
    workspaceLaunchTokenRef.current = null
    if (!launchToken) {
      setWorkspaceOpenerNotice('打开授权已失效，请重新展开“打开位置”菜单后重试。')
      return false
    }
    setWorkspaceOpenerNotice('')
    try {
      const result = await window.onekey.workspace.open({
        workspaceToken,
        openerId,
        launchToken,
        confirmation: 'open_once',
      })
      if (!result.ok) {
        setWorkspaceOpenerNotice(result.error.message)
        return false
      }
      return true
    } catch {
      setWorkspaceOpenerNotice('未能打开所选本机应用，请重新检测后再试。')
      return false
    }
  }

  const resolveApproval = async (decision: 'allow_once' | 'deny'): Promise<void> => {
    const approval = pendingApproval
    if (!approval || !('onekey' in window) || resolvingApproval) return
    setResolvingApproval(true)
    try {
      const result = await window.onekey.approval.resolve({ approvalId: approval.approvalId, decision })
      if (!result.ok) {
        setTurnMessage(result.error.message)
        return
      }
      setPendingApproval(null)
    } catch {
      setTurnMessage('批准请求未能安全提交，请重试。')
    } finally {
      setResolvingApproval(false)
    }
  }

  const upsertHistoryTask = (task: TaskSummary) => {
    setTaskGroups((current) => {
      const nextTask = toUiTask(task)
      const containingGroupIndex = current.findIndex((group) =>
        group.tasks.some((item) => item.id === task.id)
      )
      const projectGroupIndex = current.findIndex((group) => group.id === task.projectId)
      const groupIndex = containingGroupIndex >= 0 ? containingGroupIndex : projectGroupIndex
      if (groupIndex < 0) {
        return [...current, {
          id: task.projectId,
          name: '本地历史',
          path: '本机 DPAPI 加密历史',
          tasks: [nextTask],
        }]
      }
      return current
        .map((group, index) => index === groupIndex
          ? { ...group, tasks: [nextTask, ...group.tasks.filter((item) => item.id !== task.id)] }
          : { ...group, tasks: group.tasks.filter((item) => item.id !== task.id) })
        .filter((group) => group.tasks.length > 0)
    })
  }

  const updatePreviewTaskArchived = (taskId: string, archived: boolean): void => {
    setTaskGroups((current) => current.map((group) => ({
      ...group,
      tasks: group.tasks.map((task) => task.id === taskId
        ? { ...task, archivedAt: archived ? new Date().toISOString() : null }
        : task),
    })))
  }

  const setHistoryTaskArchived = async (task: Task, archived: boolean): Promise<void> => {
    if (
      historyActionTaskId
      || task.status === 'running'
      || (running && selectedTask === task.id)
    ) {
      return
    }
    setHistoryActionTaskId(task.id)
    setCapabilityNotice('')
    try {
      if (electronRenderer && isHistoryTaskId(task.id) && 'onekey' in window) {
        const result = await window.onekey.conversation.setArchived({ taskId: task.id, archived })
        if (!result.ok) {
          setCapabilityNotice(result.error.message)
          return
        }
        upsertHistoryTask(result.value)
      } else {
        updatePreviewTaskArchived(task.id, archived)
      }
      if (archived && selectedTask === task.id) newTask(task.mode)
      setCapabilityNotice(archived ? '会话已归档。' : '会话已移出归档。')
    } catch {
      setCapabilityNotice(archived ? '归档未完成，请重试。' : '移出归档未完成，请重试。')
    } finally {
      setHistoryActionTaskId('')
    }
  }

  const requestHistoryTaskDelete = (task: Task): void => {
    if (task.status === 'running' || (running && selectedTask === task.id)) return
    setHistoryDeleteError('')
    setPendingDeleteTask(task)
  }

  const confirmHistoryTaskDelete = async (): Promise<void> => {
    const task = pendingDeleteTask
    if (!task || historyActionTaskId) return
    if (running && selectedTask === task.id) {
      setHistoryDeleteError('请先停止当前回答，再删除该会话。')
      return
    }
    setHistoryDeleteError('')
    setHistoryActionTaskId(task.id)
    try {
      if (electronRenderer && isHistoryTaskId(task.id) && 'onekey' in window) {
        const result = await window.onekey.conversation.delete({ taskId: task.id })
        if (!result.ok) {
          setHistoryDeleteError(result.error.message)
          return
        }
      }
      setTaskGroups((current) => current
        .map((group) => ({
          ...group,
          tasks: group.tasks.filter((item) => item.id !== task.id),
        }))
        .filter((group) => group.tasks.length > 0))
      if (selectedTask === task.id) newTask(task.mode)
      setPendingDeleteTask(null)
      setCapabilityNotice('会话已删除。')
    } catch {
      setHistoryDeleteError('删除未完成，请重试。')
    } finally {
      setHistoryActionTaskId('')
    }
  }

  const executeCapabilityCommand = async (
    id: CapabilityCommandId,
    args?: string,
  ): Promise<boolean> => {
    setCapabilityNotice('')
    if (id === 'review') pendingReviewHandleRef.current = ''
    const normalizedArgs = args?.trim() || undefined
    const compactConversation = (): void => {
      const complete = conversationMessages.filter((message) => message.status === 'complete' && message.content.trim())
      if (complete.length <= 4) {
        const message = '当前对话还很短，不需要压缩。'
        setCapabilityNotice(message)
        return
      }
      const preserved = conversationMessages.slice(-4)
      const excerpts = complete
        .slice(0, Math.max(0, complete.length - 4))
        .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.content.replace(/\s+/gu, ' ').trim()}`)
        .join('\n')
        .slice(0, 2_400)
      const summary = `上下文摘要\n${excerpts}`
      setContextSummary(summary)
      setConversationMessages([createUiMessage('assistant', summary, 'complete'), ...preserved])
      setCapabilityNotice('上下文已压缩，最近消息和未完成状态已保留。')
    }
    if (!('onekey' in window)) {
      if (id === 'plan') setPlanMode(normalizedArgs?.toLowerCase() !== 'off')
      else if (id === 'goal') {
        if (normalizedArgs) setTaskGoal(normalizedArgs)
        else setCapabilityNotice(taskGoal || '当前还没有设置任务目标。')
      } else if (id === 'compact') {
        compactConversation()
      } else if (id === 'memories') {
        setMemoryUseEnabled((current) => {
          setMemoryGenerationEnabled(!current)
          return !current
        })
      } else if (id === 'review') {
        setCapabilityNotice('预览模式不会读取 Git 改动。')
      } else if (id === 'init') {
        setCapabilityNotice('初始化会在确认后生成 AGENTS.md 草稿。')
      } else if (id === 'status') {
        setCapabilityNotice(`模式：${mode === 'agent' ? 'Agent' : 'Chat'} · 目标：${taskGoal ? '已设置' : '未设置'}`)
      }
      return false
    }
    try {
      const result = await window.onekey.capabilities.execute({
        id,
        ...(normalizedArgs ? { args: normalizedArgs } : {}),
        ...(workspaceToken ? { workspaceToken } : {}),
      })
      if (!result.ok) {
        setCapabilityNotice(result.error.message)
        return false
      }
      const value = result.value
      applyCapabilitySession(value.session)
      if (value.goal && typeof value.goal.text === 'string') {
        setTaskGoal(value.goal.status === 'cleared' ? '' : value.goal.text)
      }
      if (id === 'init' && value.projectInit?.state === 'preview') {
        projectInitReturnFocusRef.current = document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null
        setProjectInitPreview(value.projectInit)
      }
      if (id === 'compact') compactConversation()
      if (id === 'review' && value.status === 'preview') {
        if (!/^review_[A-Za-z0-9_-]{43}$/u.test(value.reviewHandle ?? '')) {
          setCapabilityNotice('Code review authorization was not issued safely. Select /review again.')
          return false
        }
        pendingReviewHandleRef.current = value.reviewHandle!
        setMode('agent')
      }
      setCapabilityNotice(value.message)
      return id === 'review' && value.status === 'preview'
    } catch {
      setCapabilityNotice('能力操作未完成，请重试。')
      return false
    }
  }

  const commitProjectInit = async (): Promise<void> => {
    const preview = projectInitPreview
    if (!preview || !workspaceToken || !('onekey' in window) || projectInitCommitting) return
    setProjectInitCommitting(true)
    try {
      const result = await window.onekey.capabilities.execute({
        id: 'init',
        workspaceToken,
        draftHandle: preview.draftHandle,
        projectInitAction: 'commit',
      })
      setProjectInitPreview(null)
      restoreProjectInitFocus()
      if (!result.ok) {
        setCapabilityNotice(result.error.message)
        return
      }
      setCapabilityNotice(result.value.message)
    } catch {
      setProjectInitPreview(null)
      restoreProjectInitFocus()
      setCapabilityNotice('AGENTS.md 写入未完成，请重新生成草稿。')
    } finally {
      setProjectInitCommitting(false)
    }
  }

  const dismissProjectInit = async (): Promise<void> => {
    const preview = projectInitPreview
    const authorizedWorkspaceToken = workspaceToken
    if (!preview || projectInitCommitting) return
    setProjectInitPreview(null)
    restoreProjectInitFocus()
    if (!authorizedWorkspaceToken) return
    const revoked = await revokeProjectInitDraft(preview, authorizedWorkspaceToken)
    if (!revoked) {
      setCapabilityNotice('草稿授权未能立即撤销，将按本次应用会话的短期时限自动失效。')
    }
  }

  const legacyCapabilitySkill = (id: string, name: string): void => {
    setSelectedSkillMention({ id, name })
    setCapabilityNotice(`已选择技能 ${name}`)
  }

  const onCapabilityPlugin = (plugin: PluginDescriptor): void => {
    if (!plugin.enabled) {
      setCapabilityNotice(`插件 ${plugin.name} 尚未启用。`)
      return
    }
    setSelectedPluginMention(plugin)
    setCapabilityNotice(`已选择插件 ${plugin.name}`)
  }

  const onCapabilityDraftChange = (value: string): void => {
    if (selectedSkillMention && !hasCapabilityMention(value, '$', selectedSkillMention.id)) {
      capabilitySelectionSequenceRef.current += 1
      setSelectedSkillMention(null)
      setSelectedSkillInstructions('')
      setCapabilitySkillLoading(false)
    }
    if (selectedPluginMention && !hasCapabilityMention(value, '@', selectedPluginMention.id)) {
      setSelectedPluginMention(null)
    }
  }

  const onCapabilitySkill = async (skill: SkillDescriptor): Promise<void> => {
    const sequence = ++capabilitySelectionSequenceRef.current
    const selectionWorkspace = workspaceToken
    setSelectedSkillMention({ id: skill.id, name: skill.name })
    setSelectedSkillInstructions('')
    setCapabilitySkillLoading(true)
    setCapabilityNotice(`正在加载技能 ${skill.name}`)
    if (!('onekey' in window)) {
      setCapabilitySkillLoading(false)
      setCapabilityNotice(`已选择技能 ${skill.name}`)
      return
    }
    try {
      const result = await window.onekey.capabilities.execute({
        id: skill.id,
        grantHandle: skill.grantHandle,
        ...(skill.scope === 'workspace' && workspaceToken ? { workspaceToken } : {}),
      })
      capabilityDiscoveryRef.current.delete(`$:${selectionWorkspace || 'user'}`)
      setCapabilityCatalog((current) => ({
        ...current,
        skills: current.skills.filter((entry) => entry.grantHandle !== skill.grantHandle)
      }))
      if (sequence !== capabilitySelectionSequenceRef.current || activeWorkspaceTokenRef.current !== selectionWorkspace) return
      setCapabilitySkillLoading(false)
      if (!result.ok) {
        setSelectedSkillMention(null)
        setCapabilityNotice(result.error.message)
        return
      }
      if (result.value.status === 'requires-approval' || result.value.status === 'not-ready') {
        setSelectedSkillMention(null)
        setCapabilityNotice(result.value.message)
        return
      }
      if (result.value.instructions) setSelectedSkillInstructions(result.value.instructions)
      setCapabilityNotice(result.value.message)
    } catch {
      capabilityDiscoveryRef.current.delete(`$:${selectionWorkspace || 'user'}`)
      setCapabilityCatalog((current) => ({
        ...current,
        skills: current.skills.filter((entry) => entry.grantHandle !== skill.grantHandle)
      }))
      if (sequence !== capabilitySelectionSequenceRef.current || activeWorkspaceTokenRef.current !== selectionWorkspace) return
      setCapabilitySkillLoading(false)
      setCapabilityNotice('技能说明未能加载，请重试。')
    }
  }

  const requestCapabilityDiscovery = (trigger: '$' | '@'): void => {
    const key = `${trigger}:${workspaceToken || 'user'}`
    if (capabilityDiscoveryRef.current.has(key)) return
    capabilityDiscoveryRef.current.add(key)
    if (!('onekey' in window)) return
    const sequence = capabilityDiscoverySequenceRef.current
    setCapabilityDiscoveryLoadingTriggers((current) => current.includes(trigger) ? current : [...current, trigger])
    void window.onekey.capabilities.list({
      category: trigger === '$' ? 'skills' : 'plugins',
      ...(workspaceToken ? { workspaceToken } : {}),
    }).then((result) => {
      if (sequence !== capabilityDiscoverySequenceRef.current) {
        capabilityDiscoveryRef.current.delete(key)
        return
      }
      setCapabilityDiscoveryLoadingTriggers((current) => current.filter((entry) => entry !== trigger))
      if (!result.ok) {
        capabilityDiscoveryRef.current.delete(key)
        setCapabilityNotice(result.error.message)
        return
      }
      setCapabilityCatalog((current) => ({
        commands: result.value.commands,
        skills: trigger === '$' ? result.value.skills : current.skills,
        plugins: trigger === '@' ? result.value.plugins : current.plugins,
        session: result.value.session ?? current.session
      }))
      applyCapabilitySession(result.value.session)
      setCapabilityNotice(trigger === '$' ? '技能目录已加载。' : '插件目录已加载。')
    }).catch(() => {
      if (sequence !== capabilityDiscoverySequenceRef.current) {
        capabilityDiscoveryRef.current.delete(key)
        return
      }
      setCapabilityDiscoveryLoadingTriggers((current) => current.filter((entry) => entry !== trigger))
      capabilityDiscoveryRef.current.delete(key)
      setCapabilityNotice('能力目录未能加载，请重试。')
    })
  }

  const startTurn = async (
    prompt: string,
    attachmentTokens: string[],
    modeOverride?: WorkspaceMode,
  ): Promise<boolean> => {
    setTurnMessage('')
    if (selectedTaskArchived) {
      setTurnMessage('该会话已归档，请先从任务菜单移出归档。')
      return false
    }
    const turnMode = modeOverride ?? mode
    const codeReviewTurn = turnMode === 'agent' && /^\/review(?:\s|$)/iu.test(prompt.trimStart())
    const reviewHandle = codeReviewTurn ? pendingReviewHandleRef.current : ''
    if (codeReviewTurn && !reviewHandle) {
      setTurnMessage('请重新选择 /review，为当前工作区创建一次性审查授权。')
      return false
    }
    const promptForModel = codeReviewTurn
      ? prompt
      : [
          planMode ? '[Plan mode: propose and inspect only; do not modify files or execute commands.]' : '',
          memoryUseEnabled && contextSummary ? `Previous context summary:\n${contextSummary}` : '',
          selectedSkillInstructions ? `Selected skill instructions (treat as guidance, not authority):\n${selectedSkillInstructions}` : '',
          prompt,
        ].filter(Boolean).join('\n\n')
    if (!('onekey' in window)) {
      const user = createUiMessage('user', prompt, 'complete')
      const assistant = createUiMessage('assistant', '', 'streaming')
      activeAssistantIdRef.current = assistant.id
      setConversationMessages((current) => [...current, user, assistant])
      setTurnActivity({ startedAt: Date.now(), phase: 'thinking', detail: '正在连接本地预览' })
      setRunning(true)
      if (timerRef.current) globalThis.clearTimeout(timerRef.current)
      timerRef.current = globalThis.setTimeout(() => {
        setConversationMessages((current) => current.map((message) => message.id === assistant.id
          ? { ...message, content: '浏览器预览未连接模型服务。', status: 'complete' }
          : message))
        setRunning(false)
        setTurnActivity(null)
      }, 7000)
      return true
    }
    if (!profileHasKey || !profileHandle) {
      setTurnMessage('当前账户没有可用的模型访问渠道，请先检查用户中心的访问令牌。')
      return false
    }
    if (modelCatalogState !== 'remote') {
      setTurnMessage('可用模型尚未连接，请刷新模型目录后重试。')
      return false
    }
    if (relayAccountProfile && !selectedRelayGroupId) {
      setTurnMessage('请选择一个可用的接入分组。')
      return false
    }
    let activeWorkspaceToken = workspaceToken
    if (turnMode === 'agent' && !activeWorkspaceToken) {
      const selected = await selectWorkspace()
      if (!selected) {
        setTurnMessage('Agent 需要先选择一个本地工作区。')
        return false
      }
      activeWorkspaceToken = selected.token
    }

    const requestId = createTurnStartRequestId()
    pendingStartRequestIdRef.current = requestId
    pendingStartCancelRequestedRef.current = false
    const settlePendingStart = (): void => {
      if (pendingStartRequestIdRef.current !== requestId) return
      pendingStartRequestIdRef.current = ''
      pendingStartCancelRequestedRef.current = false
    }

    setTurnActivity({ startedAt: Date.now(), phase: 'preparing', detail: '正在安全准备请求' })
    setRunning(true)
    try {
      let taskId = turnMode === mode ? backendTaskId : ''
      if (!taskId) {
        const created = await window.onekey.conversation.create({
          title: prompt.slice(0, 80),
          mode: turnMode,
          ...(turnMode === 'agent' ? { workspaceToken: activeWorkspaceToken } : {}),
        })
        if (!created.ok) {
          settlePendingStart()
          setTurnMessage(created.error.message)
          setRunning(false)
          setTurnActivity(null)
          return false
        }
        taskId = created.value.id
        setBackendTaskId(taskId)
        setSelectedTask(taskId)
        setTitle(created.value.title)
        upsertHistoryTask(created.value)
      }

      if (pendingStartCancelRequestedRef.current) {
        settlePendingStart()
        setTurnMessage('发送已取消，草稿已保留。')
        setRunning(false)
        setTurnActivity(null)
        return false
      }

      const modelId = selectedModel?.id
      if (!modelId) {
        settlePendingStart()
        setTurnMessage('请选择一个可用模型。')
        setRunning(false)
        setTurnActivity(null)
        return false
      }
      const reasoningKey = (reasoningKeys[reasoning] ?? reasoning.toLowerCase()) as TurnStartInput['reasoning']
      if (codeReviewTurn) pendingReviewHandleRef.current = ''
      const started = await window.onekey.turn.start({
        requestId,
        taskId,
        mode: turnMode,
        prompt: promptForModel,
        profileHandle,
        groupId: relayAccountProfile ? selectedRelayGroupId : null,
        modelId,
        reasoning: reasoningKey,
        approvalMode: permission === 'ask' ? 'request' : permission,
        ...(turnMode === 'agent' ? { workspaceToken: activeWorkspaceToken } : {}),
        ...(codeReviewTurn ? { reviewHandle } : {}),
        attachmentTokens,
        webSearch: web && webSearchAvailable,
        imageGeneration: image && imageGenerationAvailable,
        localSubagents: turnMode === 'agent' && localSubagents,
        ...(memoryUseEnabled && contextSummary ? { contextMessageLimit: 6 } : {}),
      })
      if (!started.ok) {
        settlePendingStart()
        setTurnMessage(started.error.message)
        setRunning(false)
        setTurnActivity(null)
        return false
      }

      const cancellationRequested = pendingStartCancelRequestedRef.current
      settlePendingStart()
      const user = createUiMessage('user', prompt, 'complete')
      const assistant = createUiMessage('assistant', '', 'streaming')
      activeTurnIdRef.current = started.value.turnId
      activeAssistantIdRef.current = assistant.id
      beginSmoothTextStream(assistant.id)
      setConversationMessages((current) => [...current, user, assistant])
      setSelectedSkillInstructions('')
      setSelectedSkillMention(null)
      setSelectedPluginMention(null)
      setChatEndpointConfirmed(true)

      const pending = pendingAgentEventsRef.current
      pendingAgentEventsRef.current = []
      for (const event of pending) applyAgentEvent(event)
      if (cancellationRequested && activeTurnIdRef.current === started.value.turnId) {
        try {
          await window.onekey.turn.cancel({ turnId: started.value.turnId })
        } catch {
          setTurnMessage('请求已经启动，但停止操作未完成，请再次停止。')
        }
      }
      return true
    } catch {
      settlePendingStart()
      setTurnMessage('发送请求未完成，草稿未清除，请重试。')
      setRunning(false)
      setTurnActivity(null)
      return false
    }
  }

  const stopTurn = async (): Promise<void> => {
    const pendingRequestId = pendingStartRequestIdRef.current
    if ('onekey' in window && pendingRequestId && !activeTurnIdRef.current) {
      if (pendingStartCancelRequestedRef.current) return
      pendingStartCancelRequestedRef.current = true
      setTurnMessage('正在取消发送，等待启动流程安全结束…')
      setTurnActivityPhase('stopping', '正在取消发送并安全收尾')
      try {
        await window.onekey.turn.cancel({ requestId: pendingRequestId })
      } catch {
        setTurnMessage('已记录取消请求，正在等待启动流程结束…')
      }
      return
    }
    if (!('onekey' in window) || !activeTurnIdRef.current) {
      if (timerRef.current) window.clearTimeout(timerRef.current)
      const assistantId = activeAssistantIdRef.current
      flushSmoothTextStream(assistantId)
      setConversationMessages((current) => current.map((message) => message.id === assistantId
        ? { ...message, status: 'cancelled', updatedAt: new Date().toISOString() }
        : message))
      setRunning(false)
      setTurnActivity(null)
      activeAssistantIdRef.current = ''
      return
    }

    const turnId = activeTurnIdRef.current
    if (cancellingTurnIdRef.current === turnId) return
    cancellingTurnIdRef.current = turnId
    setTurnActivityPhase('stopping', '正在停止并保存已接收内容')
    try {
      const result = await window.onekey.turn.cancel({ turnId })
      if (!result.ok) {
        if (activeTurnIdRef.current !== turnId) return
        cancellingTurnIdRef.current = ''
        setTurnMessage(result.error.message)
        setTurnActivityPhase('thinking', '停止未完成，仍在等待模型响应')
        return
      }
      if (activeTurnIdRef.current === turnId) {
        setTurnMessage('正在停止并保存已接收内容…')
        setTurnActivityPhase('stopping', '正在停止并保存已接收内容')
      }
    } catch {
      cancellingTurnIdRef.current = ''
      setTurnMessage('停止请求未完成，请再次点击停止。')
      setTurnActivityPhase('thinking', '停止未完成，仍在等待模型响应')
    }
  }

  const toggleContext = () => {
    setContextOpen((current) => !current)
    setTasksOpen(false)
  }

  const openTasks = () => {
    setTasksOpen(true)
    setContextOpen(false)
  }

  const openUserCenter = () => {
    closeDrawers()
    setUserCenterReturnSurface('workspace')
    setSurface('user-center')
  }

  const openSettings = () => {
    closeDrawers()
    setSurface('settings')
  }

  const openSettingsView = (view: SettingsView) => {
    setSettingsView(view)
    openSettings()
  }

  const openDock = (tab: DockTab) => {
    setDock(tab)
    setSettingsPreferences((current) => current.showBottomPanel ? current : { ...current, showBottomPanel: true })
  }

  useEffect(() => {
    if (!settingsPreferences.showBottomPanel) setDock(null)
  }, [settingsPreferences.showBottomPanel])

  const surfaceTitle = surface === 'user-center' ? '用户中心' : surface === 'settings' ? '设置' : title

  return (
    <div className={`app-shell ${surface === 'settings' ? 'settings-active' : ''}`}>
      <Titlebar
        title={surfaceTitle}
        running={surface === 'workspace' && running}
        surface={surface}
        onNewTask={(nextMode) => {
          closeDrawers()
          setSurface('workspace')
          newTask(nextMode)
        }}
        onSelectWorkspace={() => {
          closeDrawers()
          setSurface('workspace')
          void selectWorkspace()
        }}
        onOpenSettings={openSettingsView}
        onOpenUserCenter={() => {
          closeDrawers()
          setUserCenterReturnSurface(surface === 'settings' ? 'settings' : 'workspace')
          setSurface('user-center')
        }}
        onReturnWorkspace={() => {
          closeDrawers()
          setSurface('workspace')
        }}
        onToggleTasks={() => {
          setSurface('workspace')
          if (surface === 'workspace' && tasksOpen) setTasksOpen(false)
          else openTasks()
        }}
        onToggleContext={() => {
          setSurface('workspace')
          toggleContext()
        }}
        onOpenDock={(tab) => {
          setSurface('workspace')
          openDock(tab)
        }}
        onCloseDock={() => {
          setSurface('workspace')
          setDock(null)
        }}
        dockOpen={Boolean(dock)}
      />
      {surface === 'user-center' ? (
        <UserCenter
          onBack={() => setSurface(userCenterReturnSurface)}
          accountDisplayName={accountDisplayName}
          connectionName={relayProfileName}
          endpoint={relayEndpoint}
          onAccountIdentityChange={setRelayAccountNameValue}
        />
      ) : surface === 'settings' ? (
        <SettingsPage
          onBack={() => setSurface('workspace')}
          onOpenUserCenter={() => {
            setUserCenterReturnSurface('settings')
            setSurface('user-center')
          }}
          activeView={settingsView}
          onActiveViewChange={setSettingsView}
          permission={permission}
          onPermissionChange={setPermission}
          webSearch={web}
          onWebSearchChange={(enabled) => {
            if (!enabled || webSearchAvailable) setWeb(enabled)
          }}
          webSearchAvailable={webSearchAvailable}
          imageGeneration={image}
          onImageGenerationChange={(enabled) => {
            if (!enabled || imageGenerationAvailable) setImage(enabled)
          }}
          imageGenerationAvailable={imageGenerationAvailable}
          modelCompatibilityNotice={modelCompatibilityNotice}
          preferences={settingsPreferences}
          onPreferencesChange={(patch) => setSettingsPreferences((current) => ({ ...current, ...patch }))}
          workspaceOpeners={workspaceOpeners}
          workspaceOpenersDetected={workspaceOpenersDetected}
          displayName={relayProfileName}
          endpoint={relayEndpoint}
          profileHandle={profileHandle}
          profileHasKey={profileHasKey}
          onProfileSaved={handleProfileSaved}
          modelCount={modelCatalog.length}
          modelCatalogState={modelCatalogState}
          modelCatalogMessage={modelCatalogMessage}
          onRefreshModels={refreshModelCatalog}
        />
      ) : (
        <>
          <div className="workspace-grid">
        <TaskSidebar
          groups={taskGroups}
          selectedTask={selectedTask}
          onSelectTask={selectTask}
          onNewTask={newTask}
          onArchiveTask={(task, archived) => { void setHistoryTaskArchived(task, archived) }}
          onDeleteTask={requestHistoryTaskDelete}
          onOpenDrawer={openTasks}
          onOpenSettings={openSettings}
          onOpenUserCenter={openUserCenter}
          accountName={accountDisplayName}
          connectionLabel={connectionLabel}
          modelConnected={modelConnected}
          currentTaskRunning={running}
          historyActionTaskId={historyActionTaskId}
        />

        <main className="conversation-pane">
          <TaskHeader
            title={title}
            mode={mode}
            planMode={planMode}
            goal={taskGoal}
            workspaceName={workspaceName}
            workspaceSelected={Boolean(workspaceToken)}
            workspaceIdentity={workspaceToken}
            workspaceOpeners={workspaceOpeners}
            defaultOpener={settingsPreferences.defaultOpener}
            openerNotice={workspaceOpenerNotice}
            onSelectWorkspace={() => { void selectWorkspace() }}
            onDetectOpeners={detectWorkspaceOpeners}
            onOpenWorkspace={openWorkspaceWith}
            onOpenContext={toggleContext}
            onOpenDock={openDock}
          />
          {(planMode || taskGoal || capabilityNotice || selectedSkillMention || selectedPluginMention || contextSummary) && (
            <div className="capability-status-strip" role="status">
              {planMode && <span className="capability-state-pill plan"><ListChecks size={13} />计划模式</span>}
              {taskGoal && <span className="capability-state-pill goal" title={taskGoal}><Target size={13} />{taskGoal}</span>}
              {selectedSkillMention && <span className="capability-state-pill skill"><Sparkles size={13} />${selectedSkillMention.name}</span>}
              {selectedPluginMention && <span className="capability-state-pill plugin"><PlugZap size={13} />@{selectedPluginMention.name}</span>}
              {contextSummary && <span className="capability-state-pill context"><ScanSearch size={13} />上下文已压缩</span>}
              {capabilityNotice && <span className="capability-state-message">{capabilityNotice}</span>}
            </div>
          )}
          <Transcript
            mode={mode}
            running={running}
            activity={turnActivity}
            elapsedSeconds={turnElapsedSeconds}
            messages={conversationMessages}
            generatedImages={generatedImages}
            turnMessage={turnMessage}
            previewExample={!electronRenderer}
            onOpenDock={openDock}
          />
          {dock && <WorkbenchDock active={dock} previewExample={!electronRenderer} onChange={setDock} onClose={() => setDock(null)} />}
          <Composer
            mode={mode}
            onModeChange={changeMode}
            groupId={selectedRelayGroupId}
            groups={relayAccountProfile || !electronRenderer ? relayGroups : []}
            onGroupChange={changeRelayGroup}
            model={model}
            modelCatalog={modelCatalog}
            onModelChange={setModel}
            reasoning={reasoning}
            supportedReasoning={supportedReasoning}
            reasoningNotice={reasoningNotice}
            onReasoningChange={(value) => { setReasoning(value); setReasoningNotice('') }}
            permission={permission}
            onPermissionChange={setPermission}
            web={web}
            onWebChange={setWeb}
            webAvailable={webSearchAvailable}
            image={image}
            onImageChange={setImage}
            imageAvailable={imageGenerationAvailable}
            modelCompatibilityNotice={modelCompatibilityNotice}
            localSubagents={localSubagents}
            onLocalSubagentsChange={setLocalSubagents}
            localSubagentsAvailable={localSubagentsAvailable}
            endpoint={relayEndpoint}
            endpointConfirmed={chatEndpointConfirmed}
            capabilityCatalog={capabilityCatalog}
            onCapabilityCommand={executeCapabilityCommand}
            onCapabilitySkill={onCapabilitySkill}
            onCapabilityPlugin={onCapabilityPlugin}
            onCapabilityDiscover={requestCapabilityDiscovery}
            capabilityDiscoveryLoading={capabilityDiscoveryLoading}
            capabilityDiscoveryLoadingTriggers={capabilityDiscoveryLoadingTriggers}
            capabilityDiscoveryScopeKey={workspaceToken || 'user'}
            onCapabilityNotice={setCapabilityNotice}
            onCapabilityDraftChange={onCapabilityDraftChange}
            capabilitySkillLoading={capabilitySkillLoading}
            readOnly={selectedTaskArchived}
            running={running}
            onSend={startTurn}
            onStop={stopTurn}
          />
        </main>

        <ContextInspector
          open={contextOpen}
          mode={mode}
          subagentsEnabled={localSubagents}
          previewExample={!electronRenderer}
          workspaceName={workspaceName}
          runtime={runtime}
          onOpenDock={openDock}
          onClose={() => setContextOpen(false)}
        />
          </div>

          <div className={`drawer-scrim ${tasksOpen || contextOpen ? 'visible' : ''}`} onClick={closeDrawers} aria-hidden="true" />
          <aside className={`task-drawer ${tasksOpen ? 'is-open' : ''}`} aria-label="任务面板">
            <SidebarContents
              groups={taskGroups}
              selectedTask={selectedTask}
              onSelectTask={selectTask}
              onNewTask={newTask}
              onArchiveTask={(task, archived) => { void setHistoryTaskArchived(task, archived) }}
              onDeleteTask={requestHistoryTaskDelete}
              onOpenSettings={openSettings}
              onOpenUserCenter={openUserCenter}
              accountName={accountDisplayName}
              connectionLabel={connectionLabel}
              modelConnected={modelConnected}
              currentTaskRunning={running}
              historyActionTaskId={historyActionTaskId}
              drawer
              onClose={() => setTasksOpen(false)}
            />
          </aside>

          {pendingDeleteTask && (
            <div className="modal-scrim" role="presentation">
              <div
                className="access-confirm approval-confirm delete-conversation-confirm"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="delete-conversation-title"
                aria-describedby="delete-conversation-description"
                onKeyDown={(event) => {
                  const busy = historyActionTaskId === pendingDeleteTask.id
                  if (event.key === 'Escape' && !busy) {
                    event.preventDefault()
                    setPendingDeleteTask(null)
                    setHistoryDeleteError('')
                    return
                  }
                  if (event.key !== 'Tab') return
                  const focusable = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    'button:not(:disabled)'
                  )]
                  if (focusable.length === 0) return
                  const first = focusable[0]!
                  const last = focusable.at(-1)!
                  if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault()
                    last.focus()
                  } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault()
                    first.focus()
                  }
                }}
              >
                <div className="access-confirm-icon delete-confirm-icon"><AlertCircle size={18} /></div>
                <div>
                  <strong id="delete-conversation-title">
                    删除{pendingDeleteTask.mode === 'agent' ? ' Agent 任务' : ' Chat 对话'}？
                  </strong>
                  <p className="delete-conversation-name">{pendingDeleteTask.title}</p>
                  <small id="delete-conversation-description">
                    这会永久删除本机 DPAPI 加密历史中的该会话，操作无法恢复。
                  </small>
                  {historyDeleteError && <small className="delete-dialog-error" role="alert">{historyDeleteError}</small>}
                </div>
                <div className="access-confirm-actions">
                  <button
                    type="button"
                    autoFocus
                    disabled={historyActionTaskId === pendingDeleteTask.id}
                    onClick={() => {
                      setPendingDeleteTask(null)
                      setHistoryDeleteError('')
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="confirm-delete"
                    disabled={
                      historyActionTaskId === pendingDeleteTask.id
                      || (running && selectedTask === pendingDeleteTask.id)
                    }
                    onClick={() => { void confirmHistoryTaskDelete() }}
                  >
                    {historyActionTaskId === pendingDeleteTask.id ? '正在删除…' : '删除会话'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {projectInitPreview && (
            <div className="modal-scrim" role="presentation">
              <div
                className="access-confirm init-preview-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="project-init-preview-title"
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && !projectInitCommitting) {
                    event.preventDefault()
                    void dismissProjectInit()
                    return
                  }
                  if (event.key !== 'Tab') return
                  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
                    'button:not(:disabled), [tabindex="0"]'
                  )]
                  if (focusable.length === 0) return
                  const first = focusable[0]!
                  const last = focusable.at(-1)!
                  if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault()
                    last.focus()
                  } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault()
                    first.focus()
                  }
                }}
              >
                <header className="init-preview-header">
                  <span className="access-confirm-icon"><FileText size={18} /></span>
                  <div>
                    <strong id="project-init-preview-title">预览 AGENTS.md</strong>
                    <small>{projectInitPreview.target === 'create' ? '新建文件' : '原子替换现有文件'}</small>
                  </div>
                  <button
                    type="button"
                    className="init-preview-close"
                    aria-label="关闭草稿预览"
                    disabled={projectInitCommitting}
                    onClick={() => { void dismissProjectInit() }}
                  >
                    <X size={16} />
                  </button>
                </header>
                <div className="init-preview-meta">
                  <span>AGENTS.md</span>
                  <code>{projectInitPreview.contentSha256.slice(0, 12)}</code>
                </div>
                <pre className="init-preview-content" tabIndex={0} aria-label="AGENTS.md 草稿内容">{projectInitPreview.content}</pre>
                <div className="access-confirm-actions init-preview-actions">
                  <button
                    type="button"
                    autoFocus
                    disabled={projectInitCommitting}
                    onClick={() => { void dismissProjectInit() }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="confirm-approval"
                    disabled={projectInitCommitting}
                    onClick={() => { void commitProjectInit() }}
                  >
                    {projectInitCommitting ? <LoaderCircle className="spin" size={14} /> : <FileText size={14} />}
                    {projectInitCommitting ? '正在确认' : '写入此草稿'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {pendingApproval && (
            <div className="modal-scrim" role="presentation">
              <div
                className="access-confirm approval-confirm"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="agent-approval-title"
              >
                <div className="access-confirm-icon"><Shield size={18} /></div>
                <div>
                  <strong id="agent-approval-title">批准这一次本地操作？</strong>
                  <p>{pendingApproval.label}</p>
                  <small>授权只绑定当前 Agent 回合、工具调用和已选择工作区，提交后立即失效。</small>
                </div>
                <div className="access-confirm-actions">
                  <button type="button" disabled={resolvingApproval} onClick={() => { void resolveApproval('deny') }}>拒绝</button>
                  <button type="button" className="confirm-approval" disabled={resolvingApproval} onClick={() => { void resolveApproval('allow_once') }}>
                    {resolvingApproval ? '正在提交…' : '仅允许这一次'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
