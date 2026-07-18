export const API_SCHEMA_VERSION = 1 as const

export type WorkspaceMode = 'chat' | 'agent'
export type ModelWireMode = 'standard' | 'lite'
export type ApprovalMode = 'request' | 'auto' | 'full'
export type ReasoningEffort = 'auto' | 'light' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
export type RuntimeStatus = 'mock' | 'starting' | 'ready' | 'degraded' | 'stopped'

// Capability metadata is intentionally renderer-safe. Main-process discovery
// never exposes absolute paths, manifest bodies, scripts, or credentials.
export type CapabilityScope = 'builtin' | 'user' | 'workspace'
export type CapabilityPermission = 'read' | 'write' | 'execute' | 'network' | 'approval'
export type CapabilityAvailability = 'ready' | 'requires-approval' | 'not-ready'
export type CapabilityDiscoveryCategory = 'skills' | 'plugins'
export type CapabilityCommandId =
  | 'plan'
  | 'goal'
  | 'compact'
  | 'memories'
  | 'init'
  | 'review'
  | 'status'

export interface CapabilityCommandDescriptor {
  id: CapabilityCommandId
  name: string
  description: string
  aliases: string[]
  scope: 'builtin'
  permissions: CapabilityPermission[]
  safe: boolean
  availability: CapabilityAvailability
}

export interface SkillDescriptor {
  id: string
  grantHandle: string
  name: string
  description: string
  scope: 'user' | 'workspace'
  relativePath: string
  permissions: CapabilityPermission[]
}

export interface PluginDescriptor {
  id: string
  grantHandle: string
  name: string
  description: string
  version: string
  scope: 'user' | 'workspace'
  relativePath: string
  permissions: CapabilityPermission[]
  enabled: boolean
}

export interface CapabilityCatalog {
  commands: CapabilityCommandDescriptor[]
  skills: SkillDescriptor[]
  plugins: PluginDescriptor[]
  session?: CapabilitySessionState
}

export interface CapabilityListInput {
  workspaceToken?: string
  category?: CapabilityDiscoveryCategory
}

export interface CapabilityExecuteInput {
  id: string
  args?: string
  workspaceToken?: string
  grantHandle?: string
  draftHandle?: string
  projectInitAction?: 'commit' | 'discard'
}

export interface CapabilityGoalState {
  text: string
  status: 'active' | 'paused' | 'cleared'
}

export interface CapabilitySessionState {
  planMode: boolean
  memoriesEnabled: boolean
  goal?: CapabilityGoalState
}

export interface CapabilityExecuteResult {
  id: string
  status: 'completed' | 'preview' | 'requires-approval' | 'not-ready'
  message: string
  plan?: string[]
  goal?: CapabilityGoalState
  instructions?: string
  session?: CapabilitySessionState
  projectInit?: ProjectInitCapabilityResult
  reviewHandle?: string
}

export type ProjectInitCapabilityResult =
  | {
      state: 'preview'
      draftHandle: string
      relativePath: 'AGENTS.md'
      content: string
      contentSha256: string
      target: 'create' | 'replace'
      expiresAt: number
    }
  | {
      state: 'committed'
      relativePath: 'AGENTS.md'
      revision: string
      replaced: boolean
    }

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/
const RELAY_GROUP_ID_PATTERN = /^[^\u0000-\u001f\u007f]{1,64}$/u

export function isValidModelId(value: unknown): value is string {
  return typeof value === 'string' && MODEL_ID_PATTERN.test(value)
}

export function isValidRelayGroupId(value: unknown): value is string {
  return typeof value === 'string' && RELAY_GROUP_ID_PATTERN.test(value)
}

export interface SafeError {
  code:
    | 'cancelled'
    | 'conflict'
    | 'denied'
    | 'invalid_input'
    | 'not_found'
    | 'not_ready'
    | 'runtime_error'
  message: string
  retryable: boolean
}

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SafeError }

export interface PublicAccessProfile {
  credentialHandle: string
  name: string
  description: string
  baseUrl: string
  hasKey: boolean
  isCurrent: boolean
  targets: Array<'codex' | 'claude-desktop' | 'claude-code'>
}

export interface ModelCapabilities {
  attachments: boolean
  imageInput: boolean
  imageGeneration: boolean
  subagents: boolean
  toolUse: boolean
  webSearch: boolean
}

export interface ModelDescriptor {
  id: string
  label: string
  provider: 'openai-compatible' | 'anthropic-compatible'
  wireMode: ModelWireMode
  declaredWireMode?: ModelWireMode
  trustedOwner?: 'codex'
  modes: WorkspaceMode[]
  reasoning: ReasoningEffort[]
  // Remote catalogs set this only when the server explicitly publishes a
  // reasoning list. Missing means the endpoint must decide when a turn runs.
  declaredReasoning?: ReasoningEffort[]
  capabilities: ModelCapabilities
  // Remote catalogs set this to only the booleans explicitly returned by the server.
  // If this object is absent, capabilities is an authoritative local descriptor.
  declaredCapabilities?: Partial<ModelCapabilities>
  source: 'mock' | 'remote'
}

export function isModelReasoningExplicitlyUnsupported(
  model: Pick<ModelDescriptor, 'reasoning' | 'declaredReasoning'>,
  effort: ReasoningEffort
): boolean {
  const declared = model.declaredReasoning
  return declared === undefined
    ? !model.reasoning.includes(effort)
    : !declared.includes(effort)
}

export function isModelCapabilityExplicitlyUnsupported(
  model: Pick<ModelDescriptor, 'capabilities' | 'declaredCapabilities'>,
  capability: keyof ModelCapabilities
): boolean {
  return model.declaredCapabilities === undefined
    ? model.capabilities[capability] === false
    : model.declaredCapabilities[capability] === false
}

export function isModelCapabilityExplicitlySupported(
  model: Pick<ModelDescriptor, 'capabilities' | 'declaredCapabilities'>,
  capability: keyof ModelCapabilities
): boolean {
  return model.declaredCapabilities === undefined
    ? model.capabilities[capability] === true
    : model.declaredCapabilities[capability] === true
}

export interface TaskSummary {
  id: string
  projectId: string
  title: string
  mode: WorkspaceMode
  updatedAt: string
  archivedAt: string | null
  status: 'idle' | 'running' | 'waiting-approval' | 'failed'
}

export interface ProjectSummary {
  id: string
  name: string
  tasks: TaskSummary[]
}

export interface BootstrapPayload {
  schemaVersion: typeof API_SCHEMA_VERSION
  app: {
    name: string
    version: string
    platform: 'win32' | 'darwin' | 'linux'
    preview: boolean
  }
  runtime: {
    status: RuntimeStatus
    protocolVersion: number
    message: string
  }
  security: {
    rendererHasNodeAccess: false
    rendererNetworkAccess: false
    secretsExposedToRenderer: false
    endpointConsentRequired: true
    localToolConsentRequired: true
  }
  defaults: {
    mode: WorkspaceMode
    approvalMode: ApprovalMode
    reasoning: ReasoningEffort
    webSearch: boolean
    imageGeneration: boolean
    activeProfileHandle: string
    activeModelId: string
  }
  profiles: PublicAccessProfile[]
  models: ModelDescriptor[]
  projects: ProjectSummary[]
  activeTaskId: string
}

export interface WorkspaceSelection {
  workspaceToken: string
  displayName: string
}

export const WORKSPACE_OPENER_IDS = Object.freeze([
  'vscode',
  'visual-studio',
  'cursor',
  'github-desktop',
  'explorer',
  'terminal',
  'wsl',
  'pycharm'
] as const)

export type WorkspaceOpenerId = (typeof WORKSPACE_OPENER_IDS)[number]
export type WorkspaceOpenerKind = 'editor' | 'git' | 'file-manager' | 'terminal'

export function isWorkspaceOpenerId(value: unknown): value is WorkspaceOpenerId {
  return typeof value === 'string' && (WORKSPACE_OPENER_IDS as readonly string[]).includes(value)
}

export interface WorkspaceOpenerDescriptor {
  id: WorkspaceOpenerId
  label: string
  kind: WorkspaceOpenerKind
}

export interface WorkspaceOpenerListInput {
  workspaceToken: string
  confirmation: 'detect'
}

export interface WorkspaceOpenerListResult {
  openers: WorkspaceOpenerDescriptor[]
  launchToken: string
}

export interface WorkspaceOpenInput {
  workspaceToken: string
  openerId: WorkspaceOpenerId
  launchToken: string
  confirmation: 'open_once'
}

export interface WorkspaceOpenResult {
  openerId: WorkspaceOpenerId
}

export interface AttachmentSelection {
  attachmentToken: string
  displayName: string
  mediaKind: 'image' | 'document' | 'text' | 'other'
}

export interface ConversationCreateInput {
  title?: string
  mode: WorkspaceMode
  workspaceToken?: string
}

export interface ConversationRenameInput {
  taskId: string
  title: string
}

export interface ConversationRef {
  taskId: string
}

export interface ConversationSetArchivedInput extends ConversationRef {
  archived: boolean
}

export interface ConversationSnapshot {
  task: TaskSummary
  messages: ConversationMessageDto[]
  events: AgentEvent[]
}

export type ConversationMessageStatus = 'streaming' | 'complete' | 'cancelled' | 'failed'

export interface ConversationMessageDto {
  id: string
  role: 'user' | 'assistant'
  content: string
  status: ConversationMessageStatus
  createdAt: string
  updatedAt: string
}

export interface ModelListInput {
  profileHandle: string
  mode: WorkspaceMode
  groupId: string | null
}

export interface TurnStartInput {
  requestId: string
  taskId: string
  mode: WorkspaceMode
  prompt: string
  profileHandle: string
  groupId: string | null
  modelId: string
  reasoning: ReasoningEffort
  approvalMode: ApprovalMode
  workspaceToken?: string
  reviewHandle?: string
  attachmentTokens: string[]
  webSearch: boolean
  imageGeneration: boolean
  localSubagents: boolean
  contextMessageLimit?: number
}

export interface TurnStartResult {
  turnId: string
}

export interface GeneratedImageRef {
  imageToken: string
  mimeType: 'image/png'
  byteLength: number
}

export interface GeneratedImageData {
  mimeType: 'image/png'
  byteLength: number
  dataBase64: string
}

export type TurnCancelInput =
  | { requestId: string; turnId?: never }
  | { turnId: string; requestId?: never }

export interface ApprovalResolveInput {
  approvalId: string
  decision: 'allow_once' | 'deny'
}

export interface WorkspaceFileInput {
  workspaceToken: string
  relativePath: string
}

export interface WorkspaceWriteInput extends WorkspaceFileInput {
  content: string
  expectedRevision?: string
}

export interface WorkspaceFileResult {
  relativePath: string
  content: string
  revision: string
  truncated: boolean
}

export interface WorkspaceDirectoryInput {
  workspaceToken: string
  relativePath: string
}

export interface WorkspaceDirectoryEntry {
  relativePath: string
  kind: 'file' | 'directory'
}

export interface WorkspaceDirectoryResult {
  entries: WorkspaceDirectoryEntry[]
  truncated: boolean
}

export interface GitFileSummary {
  relativePath: string
  additions: number
  deletions: number
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
}

export interface GitSummary {
  branch: string
  additions: number
  deletions: number
  files: GitFileSummary[]
}

export interface TerminalStartInput {
  workspaceToken: string
  columns: number
  rows: number
}

export interface TerminalInput {
  terminalId: string
  data: string
}

export interface TerminalResizeInput {
  terminalId: string
  columns: number
  rows: number
}

export interface TerminalRef {
  terminalId: string
}

export interface SaveProfileInput {
  credentialHandle?: string
  name: string
  description?: string
  baseUrl: string
  apiKey?: string
  targets: PublicAccessProfile['targets']
}

export interface ProfileRef {
  credentialHandle: string
}

export interface IntegrationRef {
  integrationId: 'codex' | 'claude-desktop' | 'claude-code'
}

export interface IntegrationStatus {
  integrationId: IntegrationRef['integrationId']
  installed: boolean
  configured: boolean
  statusText: string
}

// The Main process maps server-shaped responses into these bounded,
// renderer-safe values before crossing the IPC boundary.
export interface RemoteRelayConnectionDto {
  endpoint: string
  endpointConsent: {
    status: 'required' | 'confirmed'
    endpointLabel: string
  }
  authenticated: boolean
  deviceId: string | null
}

export interface RemoteRelayConnectInput {
  endpoint: string
  confirmation: 'connect'
}

export interface RemoteRelayDeviceAuthorizationDto {
  sessionId: string
  userCode: string
  verificationUri: string
  expiresAt: string
  intervalSeconds: number
}

export type RemoteRelayDeviceAuthorizationPollDto =
  | { status: 'pending'; retryAfterSeconds: number }
  | { status: 'slow_down'; retryAfterSeconds: number }
  | { status: 'authenticated'; deviceId: string }
  | { status: 'expired' }
  | { status: 'denied' }

export interface RemoteRelayOverviewDto {
  account: {
    id: number
    username: string | null
    displayName: string
    email: string | null
    group: string | null
    status: number | null
    role: number | null
  }
  quota: {
    total: number | null
    used: number | null
    remaining: number | null
  }
  requestCount: number | null
  groups: Array<{
    id: string
    ratio: number | string | null
    description: string | null
  }>
  models: string[]
  updatedAt: string
}

export type RemoteRelayQuotaDisplayType = 'USD' | 'CNY' | 'TOKENS' | 'CUSTOM'

export interface RemoteRelayBillingConfigDto {
  quotaPerUnit: number
  displayInCurrency: boolean
  quotaDisplayType: RemoteRelayQuotaDisplayType
  usdExchangeRate: number
  customCurrencySymbol: string
  customCurrencyExchangeRate: number
}

export type RemoteRelayTokenStatus = 'active' | 'disabled' | 'unavailable'

export interface RemoteRelayTokenDto {
  id: number
  name: string
  maskedKey: string
  status: RemoteRelayTokenStatus
  remainQuota: number | null
  usedQuota: number | null
  unlimitedQuota: boolean | null
  group: string | null
  modelLimits: string | null
  createdAt: string | null
  lastUsedAt: string | null
  expiresAt: string | null
}

export interface RemoteRelayTokenPageDto {
  page: number
  pageSize: number
  total: number
  items: RemoteRelayTokenDto[]
}

export interface RemoteRelayUsageInput {
  from: string
  to: string
}

export interface RemoteRelayUsageRecordDto {
  createdAt: string
  requests: number
  quota: number
  tokenUsed: number
  modelName: string
}

export interface RemoteRelayUsageDto {
  range: {
    from: string
    to: string
  }
  totals: {
    requests: number
    quota: number
    tokenUsed: number
  }
  records: RemoteRelayUsageRecordDto[]
}

export interface RemoteRelayPricingModelDto {
  modelName: string
  description: string | null
  owner: string
  quotaType: number
  modelRatio: number
  modelPrice: number
  completionRatio: number
  cacheRatio: number | null
  imageRatio: number | null
  enabledGroups: string[]
  endpointTypes: string[]
  billingMode: string | null
}

export interface RemoteRelayPricingDto {
  models: RemoteRelayPricingModelDto[]
  groupRatios: Readonly<Record<string, number>>
  pricingVersion: string | null
}

export interface RemoteRelayUpdateTokenStatusInput {
  tokenId: number
  status: 'active' | 'disabled'
}

export interface RemoteRelayTokenMutationDto {
  tokenId: number
  status: 'active' | 'disabled' | 'revoked'
}

export interface RemoteRelayRevokeTokenInput {
  tokenId: number
  confirmation: 'revoke'
}

export interface RemoteRelayRedeemInput {
  code: string
}

export interface RemoteRelayRedeemResultDto {
  creditedQuota: number
}

export interface RemoteRelayPollInput {
  sessionId: string
}

export type AgentEvent =
  | {
      type: 'turn-status'
      turnId: string
      status: 'queued' | 'running' | 'waiting-approval' | 'completed' | 'failed' | 'cancelled'
      message?: string
    }
  | { type: 'assistant-delta'; turnId: string; text: string }
  | ({ type: 'image-result'; turnId: string } & GeneratedImageRef)
  | { type: 'tool-status'; turnId: string; callId: string; label: string; status: 'running' | 'completed' | 'failed' }
  | { type: 'approval-request'; turnId: string; approvalId: string; label: string; risk: 'low' | 'medium' | 'high'; expiresAt: string }
  | { type: 'terminal-output'; terminalId: string; data: string }

export interface RendererApi {
  app: {
    getBootstrap(): Promise<ApiResult<BootstrapPayload>>
  }
  window: {
    minimize(): Promise<ApiResult<null>>
    toggleMaximize(): Promise<ApiResult<null>>
    close(): Promise<ApiResult<null>>
  }
  dialog: {
    selectWorkspace(): Promise<ApiResult<WorkspaceSelection | null>>
    selectAttachments(): Promise<ApiResult<AttachmentSelection[]>>
  }
  conversation: {
    list(): Promise<ApiResult<ProjectSummary[]>>
    create(input: ConversationCreateInput): Promise<ApiResult<TaskSummary>>
    load(input: ConversationRef): Promise<ApiResult<ConversationSnapshot>>
    rename(input: ConversationRenameInput): Promise<ApiResult<TaskSummary>>
    setArchived(input: ConversationSetArchivedInput): Promise<ApiResult<TaskSummary>>
    delete(input: ConversationRef): Promise<ApiResult<null>>
  }
  models: {
    list(input: ModelListInput): Promise<ApiResult<ModelDescriptor[]>>
  }
  capabilities: {
    list(input?: CapabilityListInput): Promise<ApiResult<CapabilityCatalog>>
    execute(input: CapabilityExecuteInput): Promise<ApiResult<CapabilityExecuteResult>>
  }
  turn: {
    start(input: TurnStartInput): Promise<ApiResult<TurnStartResult>>
    cancel(input: TurnCancelInput): Promise<ApiResult<null>>
  }
  approval: {
    resolve(input: ApprovalResolveInput): Promise<ApiResult<null>>
  }
  image: {
    read(input: { imageToken: string }): Promise<ApiResult<GeneratedImageData>>
  }
  workspace: {
    listOpeners(input: WorkspaceOpenerListInput): Promise<ApiResult<WorkspaceOpenerListResult>>
    open(input: WorkspaceOpenInput): Promise<ApiResult<WorkspaceOpenResult>>
    readFile(input: WorkspaceFileInput): Promise<ApiResult<WorkspaceFileResult>>
    writeFile(input: WorkspaceWriteInput): Promise<ApiResult<WorkspaceFileResult>>
    gitSummary(input: { workspaceToken: string }): Promise<ApiResult<GitSummary>>
  }
  terminal: {
    start(input: TerminalStartInput): Promise<ApiResult<TerminalRef>>
    input(input: TerminalInput): Promise<ApiResult<null>>
    resize(input: TerminalResizeInput): Promise<ApiResult<null>>
    stop(input: TerminalRef): Promise<ApiResult<null>>
  }
  profile: {
    listPublic(): Promise<ApiResult<PublicAccessProfile[]>>
    save(input: SaveProfileInput): Promise<ApiResult<PublicAccessProfile>>
    delete(input: ProfileRef): Promise<ApiResult<null>>
    apply(input: ProfileRef & { target: PublicAccessProfile['targets'][number] }): Promise<ApiResult<null>>
    restore(input: { target: PublicAccessProfile['targets'][number] }): Promise<ApiResult<null>>
  }
  integration: {
    status(input: IntegrationRef): Promise<ApiResult<IntegrationStatus>>
    diagnose(input: IntegrationRef): Promise<ApiResult<IntegrationStatus>>
    install(input: IntegrationRef): Promise<ApiResult<IntegrationStatus>>
    relaunch(input: IntegrationRef): Promise<ApiResult<IntegrationStatus>>
    restore(input: IntegrationRef): Promise<ApiResult<IntegrationStatus>>
  }
  relay: {
    getConnection(): Promise<ApiResult<RemoteRelayConnectionDto>>
    connect(input: RemoteRelayConnectInput): Promise<ApiResult<RemoteRelayConnectionDto>>
    startDeviceAuthorization(): Promise<ApiResult<RemoteRelayDeviceAuthorizationDto>>
    openDeviceAuthorization(input: RemoteRelayPollInput): Promise<ApiResult<null>>
    pollDeviceAuthorization(input: RemoteRelayPollInput): Promise<ApiResult<RemoteRelayDeviceAuthorizationPollDto>>
    signOut(): Promise<ApiResult<null>>
    getOverview(): Promise<ApiResult<RemoteRelayOverviewDto>>
    getBillingConfig(): Promise<ApiResult<RemoteRelayBillingConfigDto>>
    listTokens(): Promise<ApiResult<RemoteRelayTokenPageDto>>
    updateTokenStatus(input: RemoteRelayUpdateTokenStatusInput): Promise<ApiResult<RemoteRelayTokenMutationDto>>
    revokeToken(input: RemoteRelayRevokeTokenInput): Promise<ApiResult<RemoteRelayTokenMutationDto>>
    listUsage(input: RemoteRelayUsageInput): Promise<ApiResult<RemoteRelayUsageDto>>
    listPricing(): Promise<ApiResult<RemoteRelayPricingDto>>
    redeem(input: RemoteRelayRedeemInput): Promise<ApiResult<RemoteRelayRedeemResultDto>>
  }
  link: {
    openExternal(url: string): Promise<ApiResult<null>>
  }
  onAgentEvent(listener: (event: AgentEvent) => void): () => void
}
