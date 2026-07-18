import { app, dialog, ipcMain, shell } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { createHash } from 'node:crypto'

import type {
  AgentEvent,
  ApiResult,
  BootstrapPayload,
  CapabilityCatalog,
  CapabilityExecuteResult,
  ConversationCreateInput,
  ConversationSnapshot,
  GeneratedImageData,
  ModelDescriptor,
  ProjectSummary,
  PublicAccessProfile,
  SaveProfileInput,
  TaskSummary,
  TurnStartInput,
  TurnStartResult,
  RemoteRelayBillingConfigDto,
  RemoteRelayConnectionDto,
  RemoteRelayDeviceAuthorizationDto,
  RemoteRelayDeviceAuthorizationPollDto,
  RemoteRelayOverviewDto,
  RemoteRelayPricingDto,
  RemoteRelayRedeemResultDto,
  RemoteRelayTokenMutationDto,
  RemoteRelayTokenPageDto,
  RemoteRelayUsageDto,
  WorkspaceOpenerListResult,
  WorkspaceOpenResult
} from '../../shared/contracts.ts'
import {
  isModelCapabilityExplicitlyUnsupported,
  isModelReasoningExplicitlyUnsupported,
  isValidModelId,
  isValidRelayGroupId,
  isWorkspaceOpenerId
} from '../../shared/contracts.ts'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { WZH_MODEL_BASE_URL, WZH_RELAY_PROFILE_HANDLE } from '../../shared/server-config'
import { ConsentValidationError } from '../security/consent-store'
import { failure, internalFailure, redactSensitiveContent, redactSensitiveText } from '../security/redaction'
import { validateExternalUrl } from '../security/web-contents'
import {
  PendingTurnStartError,
  PendingTurnStarts,
  isTurnStartRequestId
} from '../runtime/pending-turn-starts'
import { TurnRegistry, TurnRegistryError } from '../runtime/turn-registry'
import { AccessProfileServiceError } from '../services/access-profile-service'
import {
  AttachmentInputError,
  AttachmentInputService
} from '../services/attachment-input-service'
import type { MainBackendServices } from '../services/backend-services'
import { getBootstrapPayload } from '../services/bootstrap'
import { ChatTurnError, ChatTurnService } from '../services/chat-turn-service'
import {
  CapabilityRegistryError,
  type CapabilitySkillUseRequest
} from '../services/capability-registry'
import { CapabilityGrantStoreError } from '../services/capability-grant-store'
import { AgentApprovalError, AgentApprovalService } from '../services/agent-approval-service'
import { AgentTurnError, AgentTurnService } from '../services/agent-turn-service'
import { ConversationHistoryError } from '../services/conversation-history-service'
import {
  EndpointConsentCoordinator,
  EndpointConsentCoordinatorError
} from '../services/endpoint-consent-coordinator'
import { ModelCatalogError } from '../services/model-catalog'
import { ImageResultStore, ImageResultStoreError } from '../services/image-result-store'
import {
  ProjectInitError,
  ProjectInitService,
  type ProjectInitCommitInspection
} from '../services/project-init-service'
import {
  RelayDtoAdapterError,
  normalizeRemoteRelayUsageInput,
  toRemoteRelayBillingConfig,
  toRemoteRelayConnection,
  toRemoteRelayDeviceAuthorization,
  toRemoteRelayDeviceAuthorizationPoll,
  toRemoteRelayOverview,
  toRemoteRelayPricing,
  toRemoteRelayTokenMutation,
  toRemoteRelayTokenPage,
  toRemoteRelayUsage
} from '../services/relay-dto-adapter'
import { RelayServiceError } from '../services/relay-service'
import {
  SelectionTokenError,
  SelectionTokenStore,
  type ResolvedWorkspaceRecord
} from '../services/selection-token-store'
import { WorkspaceLaunchTokenStore } from '../services/workspace-launch-token-store'
import { WorkspaceOpenerError, WorkspaceOpenerService } from '../services/workspace-opener-service'
import { WorkspaceToolError, WorkspaceToolService } from '../services/workspace-tool-service'

type Handler<T> = (...args: unknown[]) => ApiResult<T> | Promise<ApiResult<T>>

export interface IpcHandlerRegistration {
  tokenStore: SelectionTokenStore
  shutdown(): Promise<void>
}

const REGISTERED_CHANNELS = Object.values(IPC_CHANNELS).filter(
  (channel) => channel !== IPC_CHANNELS.agentEvent
)

export function registerIpcHandlers(
  window: BrowserWindow,
  backend: MainBackendServices
): IpcHandlerRegistration {
  for (const channel of REGISTERED_CHANNELS) ipcMain.removeHandler(channel)

  const tokenStore = new SelectionTokenStore()
  const workspaceLaunchTokens = new WorkspaceLaunchTokenStore()
  const workspaceOpeners = new WorkspaceOpenerService()
  const attachmentInputs = new AttachmentInputService({
    selections: tokenStore,
    protectedAbsoluteRoots: [app.getPath('userData')]
  })
  const imageResults = new ImageResultStore()
  const ownerWebContentsId = window.webContents.id
  let shuttingDown = false
  let localSessionUnlocked = false
  const publicSecure = <T>(handler: Handler<T>) => secureHandler(window, (...args: unknown[]) => {
    if (shuttingDown) return failure('cancelled', '应用正在安全退出。')
    return handler(...args)
  })
  const localSecure = <T>(handler: Handler<T>) => publicSecure<T>(async (...args: unknown[]) => {
    if (!localSessionUnlocked) {
      return failure('denied', '请先登录 AI终点站账户。')
    }
    return handler(...args)
  })
  const modelEndpointConsent = new EndpointConsentCoordinator(
    backend.consents,
    (endpoint) => requestModelEndpointConsent(window, endpoint)
  )
  const chatEndpointConsent = new EndpointConsentCoordinator(
    backend.consents,
    (endpoint) => requestChatEndpointConsent(window, endpoint)
  )
  const agentEndpointConsent = new EndpointConsentCoordinator(
    backend.consents,
    (endpoint) => requestAgentEndpointConsent(window, endpoint)
  )
  let relayEndpointConfirmed = false
  const currentRelayConnection = (): RemoteRelayConnectionDto =>
    toRemoteRelayConnection(
      backend.relay.serverOrigin,
      relayEndpointConfirmed,
      backend.relay.getAuthenticationState()
    )
  const relayProfileAvailable = (): boolean => (
    relayEndpointConfirmed && backend.relay.getAuthenticationState().authenticated
  )
  const listPublicProfiles = async (): Promise<PublicAccessProfile[]> => {
    const stored = await backend.profiles.listPublic()
    return relayProfileAvailable()
      ? [createRelayPublicProfile(), ...stored.filter((profile) => profile.credentialHandle !== WZH_RELAY_PROFILE_HANDLE)]
      : stored
  }
  const resolveModelCredentials = async (
    profileHandle: string,
    groupId: string | null,
    modelId: string,
    relayTokenId: number | null
  ) => {
    if (profileHandle === WZH_RELAY_PROFILE_HANDLE) {
      if (groupId === null || relayTokenId === null) throw new RelayServiceError('invalid_input')
      return backend.relay.getSelectedModelAccessCredentials({
        groupId,
        modelId,
        tokenId: relayTokenId
      })
    }
    if (groupId !== null || relayTokenId !== null) throw new RelayServiceError('invalid_input')
    return backend.profiles.getSecretForMain(profileHandle)
  }
  const secure = <T>(handler: Handler<T>) => publicSecure<T>(async (...args: unknown[]) => {
    if (!relayEndpointConfirmed) {
      return failure('denied', '请先登录 AI终点站账户。')
    }
    await backend.relay.ensureAuthenticatedSession()
    localSessionUnlocked = true
    return handler(...args)
  })
  const chatTurnRegistry = new TurnRegistry({ maxActiveTurns: 8, maxRetainedTurns: 128 })
  const agentTurnRegistry = new TurnRegistry({ maxActiveTurns: 8, maxRetainedTurns: 128 })
  const waitingAgentTurns = new Set<string>()
  const publishAgentEvent = (event: AgentEvent): void => {
    if (event.type === 'turn-status') {
      if (event.status === 'waiting-approval') waitingAgentTurns.add(event.turnId)
      else waitingAgentTurns.delete(event.turnId)
    } else if (event.type === 'approval-request') {
      waitingAgentTurns.add(event.turnId)
    } else if (event.type === 'tool-status') {
      waitingAgentTurns.delete(event.turnId)
    }
    sendAgentEvent(window, event)
  }
  const withLiveTaskStatus = (task: TaskSummary): TaskSummary => {
    const agentTurn = agentTurnRegistry.getActiveSnapshotForTask(task.id)
    if (agentTurn) {
      return {
        ...task,
        status: waitingAgentTurns.has(agentTurn.turnId) ? 'waiting-approval' : 'running'
      }
    }
    if (chatTurnRegistry.getActiveSnapshotForTask(task.id)) return { ...task, status: 'running' }
    return task
  }
  const chatTurns = new ChatTurnService({
    history: backend.conversations,
    responses: backend.responses,
    imageResults,
    registry: chatTurnRegistry,
    onEvent: publishAgentEvent
  })
  const agentApprovals = new AgentApprovalService({
    consents: backend.consents,
    onEvent: publishAgentEvent
  })
  const workspaceTools = new WorkspaceToolService({
    selections: tokenStore,
    protectedAbsoluteRoots: [app.getPath('userData')]
  })
  const projectInit = new ProjectInitService({
    selections: tokenStore,
    protectedAbsoluteRoots: [app.getPath('userData')],
    summarizeWorkspace: async (workspace, options) => {
      const result = await workspaceTools.listDirectory(
        { workspaceToken: workspace.workspaceToken, relativePath: '.' },
        workspace.ownerWebContentsId,
        options
      )
      const entries = result.entries.map((entry) => `${entry.kind}: ${entry.relativePath}`)
      return [
        'Top-level workspace entries:',
        ...entries,
        result.truncated ? 'Additional top-level entries were omitted by the local safety limit.' : ''
      ].filter(Boolean).join('\n')
    }
  })
  const agentTurns = new AgentTurnService({
    history: backend.conversations,
    responses: backend.responses,
    approvals: agentApprovals,
    workspaceTools,
    imageResults,
    registry: agentTurnRegistry,
    onEvent: publishAgentEvent
  })
  const pendingTurnStarts = new PendingTurnStarts()
  type ConfirmedModelCatalog = {
    profileHandle: string
    mode: 'chat' | 'agent'
    groupId: string | null
    relayTokenId: number | null
    generation: number
    models: ModelDescriptor[]
  }
  const confirmedModelCatalogs = new Map<string, ConfirmedModelCatalog>()
  const profileCatalogGenerations = new Map<string, number>()
  const catalogKey = (
    profileHandle: string,
    mode: 'chat' | 'agent',
    groupId: string | null
  ): string => JSON.stringify([profileHandle, mode, groupId])
  const profileGeneration = (profileHandle: string): number =>
    profileCatalogGenerations.get(profileHandle) ?? 0
  const invalidateProfileCatalog = (profileHandle: string): void => {
    profileCatalogGenerations.set(profileHandle, profileGeneration(profileHandle) + 1)
    for (const [key, catalog] of confirmedModelCatalogs) {
      if (catalog.profileHandle === profileHandle) confirmedModelCatalogs.delete(key)
    }
  }

  ipcMain.handle(
    IPC_CHANNELS.appGetBootstrap,
    localSecure<BootstrapPayload>(async () => success(await getBackendBootstrapPayload(
      backend,
      relayProfileAvailable()
    )))
  )

  ipcMain.handle(
    IPC_CHANNELS.windowMinimize,
    publicSecure(() => {
      window.minimize()
      return success(null)
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.windowToggleMaximize,
    publicSecure(() => {
      if (window.isMaximized()) window.unmaximize()
      else window.maximize()
      return success(null)
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.windowClose,
    publicSecure(() => {
      window.close()
      return success(null)
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.dialogSelectWorkspace,
    localSecure(async () => {
      const result = await dialog.showOpenDialog(window, {
        title: '选择工作区',
        buttonLabel: '选择此文件夹',
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || !result.filePaths[0]) return success(null)
      return success(tokenStore.issueWorkspace(result.filePaths[0], ownerWebContentsId))
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.dialogSelectAttachments,
    localSecure(async () => {
      const result = await dialog.showOpenDialog(window, {
        title: '添加附件',
        buttonLabel: '添加',
        properties: ['openFile', 'multiSelections'],
        filters: [{
          name: '支持的图片与文本文件',
          extensions: [
            'png', 'jpg', 'jpeg', 'webp', 'txt', 'md', 'csv', 'json', 'html', 'xml',
            'yaml', 'yml', 'toml', 'js', 'jsx', 'ts', 'tsx', 'py', 'rs', 'go',
            'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'sh', 'ps1', 'log'
          ]
        }]
      })
      if (result.canceled) return success([])
      if (result.filePaths.length > 6) {
        return failure('invalid_input', '一次最多选择 6 个附件。')
      }
      return success(
        result.filePaths.map((filePath) => tokenStore.issueAttachment(filePath, ownerWebContentsId))
      )
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.conversationList,
    localSecure<ProjectSummary[]>(async () => success(groupConversationTasks(
      (await backend.conversations.list()).map(withLiveTaskStatus)
    )))
  )
  ipcMain.handle(
    IPC_CHANNELS.conversationCreate,
    localSecure(async (input: unknown) => {
      if (
        !hasOnlyAllowedKeys(input, ['title', 'mode', 'workspaceToken']) ||
        !Object.hasOwn(input, 'mode') ||
        (input.mode !== 'chat' && input.mode !== 'agent') ||
        (input.title !== undefined && typeof input.title !== 'string') ||
        (input.workspaceToken !== undefined && typeof input.workspaceToken !== 'string')
      ) {
        return failure('invalid_input', '新建任务请求无效。')
      }
      if (input.mode === 'chat' && input.workspaceToken !== undefined) {
        return failure('invalid_input', 'Chat 模式不能绑定本地工作区。')
      }
      let projectId = 'project:local-history'
      if (input.mode === 'agent') {
        if (typeof input.workspaceToken !== 'string') {
          return failure('invalid_input', 'Agent 任务需要选择一个本地工作区。')
        }
        const workspace = await tokenStore.resolveWorkspace(input.workspaceToken, ownerWebContentsId)
        if (!workspace) return failure('denied', '所选工作区授权无效或已过期，请重新选择。')
        projectId = projectIdForWorkspace(workspace)
      }
      return success(await backend.conversations.create({
        projectId,
        title: input.title,
        mode: input.mode
      } satisfies ConversationCreateInput & { projectId: string }))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.conversationLoad,
    localSecure<ConversationSnapshot>(async (input: unknown) => {
      if (!hasExactStringField(input, 'taskId')) return failure('invalid_input', '任务请求无效。')
      const snapshot = await backend.conversations.load(input.taskId)
      return success({ ...snapshot, task: withLiveTaskStatus(snapshot.task) })
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.conversationRename,
    localSecure(async (input: unknown) => {
      if (
        !hasExactKeys(input, ['taskId', 'title']) ||
        typeof input.taskId !== 'string' ||
        typeof input.title !== 'string'
      ) {
        return failure('invalid_input', '重命名请求无效。')
      }
      return success(withLiveTaskStatus(await backend.conversations.rename(input.taskId, input.title)))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.conversationSetArchived,
    localSecure<TaskSummary>(async (input: unknown) => {
      if (
        !hasExactKeys(input, ['taskId', 'archived']) ||
        typeof input.taskId !== 'string' ||
        typeof input.archived !== 'boolean'
      ) {
        return failure('invalid_input', '归档请求无效。')
      }
      if (
        input.archived &&
        (agentTurnRegistry.getActiveSnapshotForTask(input.taskId) ||
          chatTurnRegistry.getActiveSnapshotForTask(input.taskId))
      ) {
        return failure('conflict', '请先停止当前回答，再归档该会话。')
      }
      return success(withLiveTaskStatus(
        await backend.conversations.setArchived(input.taskId, input.archived)
      ))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.conversationDelete,
    localSecure<null>(async (input: unknown) => {
      if (!hasExactStringField(input, 'taskId')) return failure('invalid_input', '删除任务请求无效。')
      if (
        agentTurnRegistry.getActiveSnapshotForTask(input.taskId) ||
        chatTurnRegistry.getActiveSnapshotForTask(input.taskId)
      ) {
        return failure('conflict', '正在运行的任务不能删除，请先停止当前请求。')
      }
      await backend.conversations.delete(input.taskId)
      return success(null)
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.modelsList,
    localSecure<ModelDescriptor[]>(async (input: unknown) => {
      if (!hasExactKeys(input, ['profileHandle', 'mode', 'groupId'])) {
        return failure('invalid_input', '模型请求无效。')
      }
      const mode = input.mode
      if (mode !== 'chat' && mode !== 'agent') return failure('invalid_input', '模型请求无效。')
      if (typeof input.profileHandle !== 'string') {
        return failure('invalid_input', '模型请求无效。')
      }
      const profileHandle = input.profileHandle
      const relayProfile = profileHandle === WZH_RELAY_PROFILE_HANDLE
      const groupId = input.groupId
      if (
        (groupId !== null && !isValidRelayGroupId(groupId)) ||
        (relayProfile && groupId === null) ||
        (!relayProfile && groupId !== null)
      ) {
        return failure('invalid_input', '接入分组请求无效。')
      }
      const refreshGeneration = profileGeneration(profileHandle)
      let relayTokenId: number | null = null
      let models: ModelDescriptor[]
      if (relayProfile) {
        const relayGroupId = groupId as string
        const groups = await backend.relay.getUserGroups()
        if (!Object.hasOwn(groups, relayGroupId)) throw new RelayServiceError('invalid_input')
        const secret = await backend.relay.getSelectedModelAccessCredentials({ groupId: relayGroupId })
        relayTokenId = secret.tokenId
        models = await backend.modelCatalog.list(
          { baseUrl: secret.baseUrl, apiKey: secret.apiKey },
          mode
        )
      } else {
        const secret = await backend.profiles.getSecretForMain(profileHandle)
        await modelEndpointConsent.ensure(secret.baseUrl)
        models = await backend.modelCatalog.list(
          { baseUrl: secret.baseUrl, apiKey: secret.apiKey },
          mode
        )
      }
      if (profileGeneration(profileHandle) !== refreshGeneration) {
        return failure('conflict', 'The access profile changed while models were loading. Refresh again.')
      }
      confirmedModelCatalogs.set(catalogKey(profileHandle, mode, groupId), {
        profileHandle,
        mode,
        groupId,
        relayTokenId,
        generation: refreshGeneration,
        models: structuredClone(models)
      })
      return success(models)
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.capabilityList,
    localSecure<CapabilityCatalog>(async (...args: unknown[]) => {
      if (args.length > 1) return failure('invalid_input', 'Capability list input is invalid.')
      const input = args[0]
      if (input !== undefined && !hasOnlyAllowedKeys(input, ['workspaceToken', 'category'])) {
        return failure('invalid_input', 'Capability list input is invalid.')
      }
      if (
        input !== undefined &&
        input.category !== undefined &&
        input.category !== 'skills' &&
        input.category !== 'plugins'
      ) {
        return failure('invalid_input', 'Capability discovery category is invalid.')
      }
      const category: 'skills' | 'plugins' | undefined = input?.category === 'skills' || input?.category === 'plugins'
        ? input.category
        : undefined
      let workspaceSelection: { absolutePath: string; device: string; inode: string } | undefined
      if (input !== undefined && Object.hasOwn(input, 'workspaceToken')) {
        if (category === undefined) {
          return failure('denied', 'A category-specific capability discovery request is required.')
        }
        if (typeof input.workspaceToken !== 'string' || input.workspaceToken.length > 256) {
          return failure('invalid_input', 'Capability workspace selection is invalid.')
        }
        const workspace = await tokenStore.resolveWorkspace(input.workspaceToken, ownerWebContentsId)
        if (!workspace) return failure('denied', 'The selected workspace authorization is invalid or expired.')
        workspaceSelection = workspace
      }
      if (category !== undefined) {
        const approved = await requestCapabilityDiscoveryConsent(
          window,
          category,
          workspaceSelection?.absolutePath
        )
        if (!approved) {
          return failure('cancelled', '能力目录读取已取消；未读取任何本地能力文件。')
        }
      }
      return success(await backend.capabilities.list({
        ownerWebContentsId,
        ...(workspaceSelection === undefined ? {} : {
          workspace: {
            absolutePath: workspaceSelection.absolutePath,
            device: workspaceSelection.device,
            inode: workspaceSelection.inode
          }
        }),
        ...(category === undefined ? {} : { discover: category })
      }))
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.capabilityExecute,
    localSecure<CapabilityExecuteResult>(async (...args: unknown[]) => {
      const draftAttempt = args[0]
      const discardDraftAttempt = (): void => {
        projectInit.discardAttempt(draftAttempt, ownerWebContentsId)
      }
      if (
        args.length !== 1 ||
        !hasOnlyAllowedKeys(args[0], [
          'id',
          'args',
          'workspaceToken',
          'grantHandle',
          'draftHandle',
          'projectInitAction'
        ])
      ) {
        discardDraftAttempt()
        return failure('invalid_input', 'Capability execution input is invalid.')
      }
      const input = args[0]
      if (
        typeof input.id !== 'string' ||
        input.id.length === 0 ||
        input.id.length > 128 ||
        (input.args !== undefined &&
          (typeof input.args !== 'string' || input.args.length > 2_000)) ||
        (input.workspaceToken !== undefined &&
          (typeof input.workspaceToken !== 'string' || input.workspaceToken.length > 256)) ||
        (input.grantHandle !== undefined &&
          (typeof input.grantHandle !== 'string' || input.grantHandle.length > 64)) ||
        (input.draftHandle !== undefined &&
          (typeof input.draftHandle !== 'string' || !/^draft_[A-Za-z0-9_-]{43}$/u.test(input.draftHandle))) ||
        (input.projectInitAction !== undefined &&
          input.projectInitAction !== 'commit' &&
          input.projectInitAction !== 'discard') ||
        (input.grantHandle !== undefined && input.draftHandle !== undefined) ||
        (input.grantHandle !== undefined && input.projectInitAction !== undefined) ||
        (input.projectInitAction !== undefined && input.draftHandle === undefined)
      ) {
        discardDraftAttempt()
        return failure('invalid_input', 'Capability execution input is invalid.')
      }
      let workspaceSelection: ResolvedWorkspaceRecord | undefined
      if (input.workspaceToken !== undefined) {
        const workspace = await tokenStore.resolveWorkspace(input.workspaceToken, ownerWebContentsId)
        if (!workspace) {
          discardDraftAttempt()
          return failure('denied', 'The selected workspace authorization is invalid or expired.')
        }
        workspaceSelection = workspace
      }
      const normalizedCapabilityId = input.id.trim().replace(/^[/@$]+/u, '').split(/\s+/u, 1)[0]
      if (
        (input.draftHandle !== undefined || input.projectInitAction !== undefined) &&
        normalizedCapabilityId !== 'init'
      ) {
        discardDraftAttempt()
        return failure('invalid_input', 'Capability execution input is invalid.')
      }
      if (normalizedCapabilityId === 'init') {
        if (
          input.args !== undefined ||
          input.grantHandle !== undefined ||
          workspaceSelection === undefined
        ) {
          discardDraftAttempt()
          return failure('invalid_input', 'Project initialization requires one authorized workspace.')
        }
        if (input.draftHandle === undefined && input.projectInitAction === undefined) {
          const approved = await requestProjectInitPrepareConsent(
            window,
            workspaceSelection.absolutePath
          )
          if (!approved) {
            return failure('cancelled', 'Project initialization preview was cancelled. No workspace file was read.')
          }
          const preview = await projectInit.prepare({
            workspace: workspaceSelection,
            ownerWebContentsId
          })
          return success({
            id: 'init',
            status: 'preview',
            message: 'AGENTS.md draft is ready for review. No file was changed.',
            projectInit: {
              state: 'preview',
              draftHandle: preview.draftHandle,
              relativePath: preview.relativePath,
              content: preview.content,
              contentSha256: preview.contentSha256,
              target: preview.target.state === 'absent' ? 'create' : 'replace',
              expiresAt: preview.expiresAt
            }
          })
        }
        if (input.draftHandle === undefined || input.projectInitAction === undefined) {
          discardDraftAttempt()
          return failure('invalid_input', 'Project initialization draft action is invalid.')
        }
        if (input.projectInitAction === 'discard') {
          projectInit.discardAttempt({ draftHandle: input.draftHandle }, ownerWebContentsId)
          return success({
            id: 'init',
            status: 'completed',
            message: 'The AGENTS.md draft authorization was discarded.'
          })
        }
        if (backend.capabilities.getPlanMode(ownerWebContentsId)) {
          projectInit.discardAttempt({ draftHandle: input.draftHandle }, ownerWebContentsId)
          return failure('denied', 'Plan mode blocks AGENTS.md writes. Exit plan mode before committing the draft.')
        }
        const commitInput = {
          draftHandle: input.draftHandle,
          workspace: workspaceSelection
        }
        const inspection = await projectInit.inspectForCommit(commitInput, ownerWebContentsId)
        const approved = await requestProjectInitCommitConsent(
          window,
          workspaceSelection.absolutePath,
          inspection
        )
        if (!approved) {
          projectInit.discardAttempt({ draftHandle: input.draftHandle }, ownerWebContentsId)
          return failure('cancelled', 'AGENTS.md write was cancelled. This draft authorization was revoked.')
        }
        const committed = await projectInit.commit(
          commitInput,
          ownerWebContentsId
        )
        return success({
          id: 'init',
          status: 'completed',
          message: committed.replaced
            ? 'AGENTS.md was atomically replaced with the approved draft.'
            : 'AGENTS.md was atomically created from the approved draft.',
          projectInit: { state: 'committed', ...committed }
        })
      }
      if (
        normalizedCapabilityId === 'plan' &&
        typeof input.args === 'string' &&
        input.args.trim().toLowerCase() === 'off' &&
        backend.capabilities.getPlanMode(ownerWebContentsId)
      ) {
        const approved = await requestPlanModeExitConsent(window)
        if (!approved) return failure('cancelled', '计划模式仍保持启用。')
      }
      return success(await backend.capabilities.execute({
        id: input.id,
        ownerWebContentsId,
        ...(input.args === undefined ? {} : { args: input.args }),
        ...(input.grantHandle === undefined ? {} : { grantHandle: input.grantHandle }),
        ...(input.id.startsWith('skill:')
          ? {
              authorizeSkillUse: async (request: CapabilitySkillUseRequest) =>
                await requestCapabilitySkillUseConsent(window, request)
            }
          : {}),
        ...(workspaceSelection === undefined ? {} : {
          workspace: {
            absolutePath: workspaceSelection.absolutePath,
            device: workspaceSelection.device,
            inode: workspaceSelection.inode
          }
        })
      }))
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.turnStart,
    localSecure<TurnStartResult>(async (input: unknown) => {
      const turn = validateChatTurnInput(input)
      if (!turn.ok) return turn.result
      const reviewRequested = turn.value.mode === 'agent' && isCodeReviewPrompt(turn.value.prompt)
      if (
        reviewRequested &&
        (
          turn.value.reviewHandle === undefined ||
          turn.value.attachmentTokens.length > 0 ||
          turn.value.webSearch ||
          turn.value.imageGeneration ||
          turn.value.localSubagents
        )
      ) {
        return failure('invalid_input', 'Code review requires its exact one-time authorization and cannot use attachments, web, images, or subagents.')
      }
      if (!reviewRequested && turn.value.reviewHandle !== undefined) {
        return failure('invalid_input', 'A code review authorization can only be used with /review in Agent mode.')
      }

      const relayProfile = turn.value.profileHandle === WZH_RELAY_PROFILE_HANDLE
      if (
        (relayProfile && turn.value.groupId === null) ||
        (!relayProfile && turn.value.groupId !== null)
      ) {
        return failure('invalid_input', '接入分组与模型渠道不匹配。')
      }
      const confirmedCatalogKey = catalogKey(
        turn.value.profileHandle,
        turn.value.mode,
        turn.value.groupId
      )
      const confirmedCatalog = confirmedModelCatalogs.get(confirmedCatalogKey)
      if (!confirmedCatalog) {
        return failure('denied', `Refresh the confirmed model catalog before starting ${turn.value.mode === 'agent' ? 'Agent' : 'Chat'}.`)
      }
      const confirmedModel = confirmedCatalog.models.find(
        (model) => model.id === turn.value.modelId && model.modes.includes(turn.value.mode)
      )
      const attachmentKinds = turn.value.attachmentTokens.map((token) =>
        tokenStore.describeAttachment(token, ownerWebContentsId)?.mediaKind ?? null
      )
      if (attachmentKinds.some((kind) => kind === null)) {
        return failure('denied', '所选附件授权无效或已过期，请重新选择。')
      }
      if (
        confirmedModel?.wireMode === 'lite' &&
        (turn.value.webSearch || turn.value.imageGeneration)
      ) {
        return failure(
          'invalid_input',
          'Responses Lite 模型暂不支持托管联网搜索或图片生成。请关闭这些能力，或切换到支持它们的标准模型。'
        )
      }
      if (
        !confirmedModel ||
        isModelReasoningExplicitlyUnsupported(confirmedModel, turn.value.reasoning) ||
        (turn.value.webSearch && !confirmedModel.capabilities.webSearch) ||
        (turn.value.attachmentTokens.length > 0 && isModelCapabilityExplicitlyUnsupported(confirmedModel, 'attachments')) ||
        (attachmentKinds.includes('image') && isModelCapabilityExplicitlyUnsupported(confirmedModel, 'imageInput')) ||
        (turn.value.imageGeneration && !confirmedModel.capabilities.imageGeneration) ||
        (turn.value.localSubagents && isModelCapabilityExplicitlyUnsupported(confirmedModel, 'subagents')) ||
        (turn.value.mode === 'agent' && isModelCapabilityExplicitlyUnsupported(confirmedModel, 'toolUse'))
      ) {
        return failure('invalid_input', 'The selected model capabilities are not in the confirmed catalog.')
      }
      const confirmedModelCapabilities = Object.freeze({ ...confirmedModel.capabilities })
      const catalogStillCurrent = (): boolean =>
        confirmedModelCatalogs.get(confirmedCatalogKey) === confirmedCatalog &&
        profileGeneration(turn.value.profileHandle) === confirmedCatalog.generation

      const signal = pendingTurnStarts.begin(turn.value.requestId)
      try {
        let workspaceToken: string | undefined
        let workspaceSelection: { absolutePath: string; device: string; inode: string } | undefined
        if (turn.value.mode === 'agent') {
          if (!turn.value.workspaceToken) {
            return failure('invalid_input', 'Agent 请求需要选择一个本地工作区。')
          }
          const workspace = await tokenStore.resolveWorkspace(
            turn.value.workspaceToken,
            ownerWebContentsId
          )
          pendingTurnStarts.assertActive(signal)
          if (!workspace) {
            return failure('denied', '所选工作区授权无效或已过期，请重新选择。')
          }
          workspaceToken = workspace.workspaceToken
          workspaceSelection = {
            absolutePath: workspace.absolutePath,
            device: workspace.device,
            inode: workspace.inode
          }
          if (turn.value.approvalMode !== 'request') {
            const approved = await requestAgentPermissionMode(
              window,
              turn.value.approvalMode
            )
            pendingTurnStarts.assertActive(signal)
            if (!approved) return failure('cancelled', '本轮 Agent 权限升级已取消。')
          }
        }

        const secret = await resolveModelCredentials(
          turn.value.profileHandle,
          turn.value.groupId,
          turn.value.modelId,
          confirmedCatalog.relayTokenId
        )
        pendingTurnStarts.assertActive(signal)
        if (!catalogStillCurrent()) {
          return failure('conflict', 'The confirmed model catalog changed. Refresh before retrying.')
        }
        if (turn.value.mode === 'agent') await agentEndpointConsent.ensure(secret.baseUrl)
        else await chatEndpointConsent.ensure(secret.baseUrl)
        pendingTurnStarts.assertActive(signal)
        if (!catalogStillCurrent()) {
          return failure('conflict', 'The confirmed model catalog changed. Refresh before retrying.')
        }
        const preparedAttachments = turn.value.attachmentTokens.length > 0
          ? await attachmentInputs.prepare(
              turn.value.attachmentTokens,
              ownerWebContentsId,
              { signal }
            )
          : { parts: [] as const, count: 0, totalBytes: 0 }
        pendingTurnStarts.assertActive(signal)
        if (!catalogStillCurrent()) {
          return failure('conflict', 'The confirmed model catalog changed. Refresh before retrying.')
        }
        const pendingReview = reviewRequested && workspaceSelection !== undefined
          ? backend.capabilities.consumeReviewMode(
              ownerWebContentsId,
              workspaceSelection,
              turn.value.reviewHandle
            )
          : false
        const reviewMode = reviewRequested && pendingReview
        if (reviewRequested && !reviewMode) {
          return failure('denied', 'Select /review again for this authorized workspace before starting review.')
        }
        const started = turn.value.mode === 'agent'
          ? await agentTurns.start({
              taskId: turn.value.taskId,
              prompt: reviewMode
                ? codeReviewPrompt(turn.value.prompt)
                : turn.value.prompt,
              credentials: { baseUrl: secret.baseUrl, apiKey: secret.apiKey },
              model: turn.value.modelId,
              wireMode: confirmedModel.wireMode,
              modelCapabilities: confirmedModelCapabilities,
              reasoning: turn.value.reasoning,
              webSearch: turn.value.webSearch,
              imageGeneration: turn.value.imageGeneration,
              attachments: preparedAttachments.parts,
              approvalMode: turn.value.approvalMode,
              subagentsEnabled:
                turn.value.localSubagents &&
                !isModelCapabilityExplicitlyUnsupported(confirmedModel, 'subagents') &&
                !isModelCapabilityExplicitlyUnsupported(confirmedModel, 'toolUse'),
              workspaceToken: workspaceToken!,
              workspaceProjectId: projectIdForWorkspace(workspaceSelection!),
              ownerWebContentsId,
              planMode: backend.capabilities.getPlanMode(ownerWebContentsId),
              reviewMode,
              ...(turn.value.contextMessageLimit === undefined
                ? {}
                : { contextMessageLimit: turn.value.contextMessageLimit })
            }, { signal })
          : await chatTurns.start({
              taskId: turn.value.taskId,
              prompt: turn.value.prompt,
              credentials: { baseUrl: secret.baseUrl, apiKey: secret.apiKey },
              model: turn.value.modelId,
              wireMode: confirmedModel.wireMode,
              modelCapabilities: confirmedModelCapabilities,
              reasoning: turn.value.reasoning,
              webSearch: turn.value.webSearch,
              imageGeneration: turn.value.imageGeneration,
              attachments: preparedAttachments.parts,
              ownerWebContentsId,
              ...(turn.value.contextMessageLimit === undefined
                ? {}
                : { contextMessageLimit: turn.value.contextMessageLimit })
            }, { signal })
        if (signal.aborted) {
          if (turn.value.mode === 'agent') agentTurns.cancel(started.turnId)
          else chatTurns.cancel(started.turnId)
          return failure('cancelled', 'Turn start was cancelled.')
        }
        return success(started)
      } catch (error) {
        if (signal.aborted) return failure('cancelled', 'Turn start was cancelled.')
        throw error
      } finally {
        pendingTurnStarts.finish(turn.value.requestId, signal)
        if (confirmedCatalog.relayTokenId !== null) {
          backend.relay.clearModelAccessCredentials(confirmedCatalog.relayTokenId)
        }
      }
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.turnCancel,
    localSecure<null>((input: unknown) => {
      if (hasExactStringField(input, 'requestId')) {
        if (!isTurnStartRequestId(input.requestId)) {
          return failure('invalid_input', 'Turn cancellation input is invalid.')
        }
        if (!pendingTurnStarts.cancel(input.requestId)) {
          return failure('not_found', 'No pending turn start was found.')
        }
        return success(null)
      }
      if (hasExactStringField(input, 'turnId') && !/^turn_[A-Za-z0-9_-]{32}$/.test(input.turnId)) {
        return failure('invalid_input', 'Turn cancellation input is invalid.')
      }
      if (!hasExactStringField(input, 'turnId')) return failure('invalid_input', '停止请求无效。')
      const agentCancelled = agentTurns.cancel(input.turnId)
      const chatCancelled = chatTurns.cancel(input.turnId)
      if (!agentCancelled && !chatCancelled) return failure('not_found', '没有找到正在运行的请求。')
      return success(null)
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.approvalResolve,
    localSecure<null>((input: unknown) => {
      if (
        !hasExactKeys(input, ['approvalId', 'decision']) ||
        typeof input.approvalId !== 'string' ||
        (input.decision !== 'allow_once' && input.decision !== 'deny')
      ) {
        return failure('invalid_input', '批准请求无效。')
      }
      if (!agentApprovals.resolve(input.approvalId, input.decision)) {
        return failure('not_found', '批准请求不存在、已过期或已经处理。')
      }
      return success(null)
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.imageRead,
    localSecure<GeneratedImageData>((input: unknown) => {
      if (!hasExactStringField(input, 'imageToken')) {
        return failure('invalid_input', '图片读取请求无效。')
      }
      const image = imageResults.consume(input.imageToken, ownerWebContentsId)
      return image
        ? success(image)
        : failure('not_found', '图片已读取、已过期或不属于当前窗口。')
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.workspaceListOpeners,
    localSecure<WorkspaceOpenerListResult>(async (input: unknown, ...extra: unknown[]) => {
      if (
        extra.length !== 0 ||
        !hasExactKeys(input, ['workspaceToken', 'confirmation']) ||
        typeof input.workspaceToken !== 'string' ||
        input.confirmation !== 'detect'
      ) {
        return failure('invalid_input', '本机打开方式检测请求无效。')
      }
      const workspace = await tokenStore.resolveWorkspace(input.workspaceToken, ownerWebContentsId)
      if (!workspace) {
        return failure('denied', '工作区授权无效或已过期，请重新选择。')
      }
      const openers = [...(await workspaceOpeners.detect())]
      const launchToken = workspaceLaunchTokens.issue(
        input.workspaceToken,
        ownerWebContentsId,
        openers.map((opener) => opener.id)
      )
      if (!launchToken) {
        return failure('not_ready', '本机应用启动授权暂不可用，请稍后重试。', true)
      }
      return success({ openers, launchToken })
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.workspaceOpen,
    localSecure<WorkspaceOpenResult>(async (input: unknown, ...extra: unknown[]) => {
      if (
        extra.length !== 0 ||
        !hasExactKeys(input, ['workspaceToken', 'openerId', 'launchToken', 'confirmation']) ||
        typeof input.workspaceToken !== 'string' ||
        !isWorkspaceOpenerId(input.openerId) ||
        typeof input.launchToken !== 'string' ||
        input.confirmation !== 'open_once'
      ) {
        return failure('invalid_input', '工作区打开请求无效。')
      }
      const launchAuthorization = workspaceLaunchTokens.consume({
        launchToken: input.launchToken,
        workspaceToken: input.workspaceToken,
        openerId: input.openerId,
        ownerWebContentsId
      })
      if (launchAuthorization === 'rate_limited') {
        return failure('conflict', '本机应用启动过于频繁，请稍后重试。', true)
      }
      if (launchAuthorization !== 'authorized') {
        return failure('denied', '本次本机应用启动授权无效或已使用，请重新打开菜单。')
      }
      const workspace = await tokenStore.resolveWorkspace(input.workspaceToken, ownerWebContentsId)
      if (!workspace) {
        return failure('denied', '工作区授权无效或已过期，请重新选择。')
      }
      await workspaceOpeners.open({
        openerId: input.openerId,
        workspace: {
          absolutePath: workspace.absolutePath,
          device: workspace.device,
          inode: workspace.inode,
        },
      })
      return success({ openerId: input.openerId })
    })
  )
  ipcMain.handle(IPC_CHANNELS.workspaceReadFile, localSecure(() => runtimeNotReady()))
  ipcMain.handle(IPC_CHANNELS.workspaceWriteFile, localSecure(() => runtimeNotReady()))
  ipcMain.handle(IPC_CHANNELS.workspaceGitSummary, localSecure(() => runtimeNotReady()))
  ipcMain.handle(IPC_CHANNELS.terminalStart, localSecure(() => runtimeNotReady()))
  ipcMain.handle(IPC_CHANNELS.terminalInput, localSecure(() => runtimeNotReady()))
  ipcMain.handle(IPC_CHANNELS.terminalResize, localSecure(() => runtimeNotReady()))
  ipcMain.handle(IPC_CHANNELS.terminalStop, localSecure(() => runtimeNotReady()))

  ipcMain.handle(
    IPC_CHANNELS.profileListPublic,
    localSecure<PublicAccessProfile[]>(async () => success(await listPublicProfiles()))
  )
  ipcMain.handle(
    IPC_CHANNELS.profileSave,
    localSecure<PublicAccessProfile>(async (input: unknown) => {
      if (!isObject(input)) return failure('invalid_input', '渠道配置无效。')
      if (input.credentialHandle === WZH_RELAY_PROFILE_HANDLE) {
        return failure('denied', '账户会话渠道由登录状态管理，不能覆盖。')
      }
      const saved = await backend.profiles.save(input as unknown as SaveProfileInput)
      invalidateProfileCatalog(saved.credentialHandle)
      return success(saved)
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.profileDelete,
    localSecure<null>(async (input: unknown) => {
      if (
        !hasExactKeys(input, ['credentialHandle']) ||
        typeof input.credentialHandle !== 'string' ||
        input.credentialHandle === WZH_RELAY_PROFILE_HANDLE
      ) {
        return failure('invalid_input', '渠道配置无效。')
      }
      await backend.profiles.delete(input.credentialHandle)
      invalidateProfileCatalog(input.credentialHandle)
      return success(null)
    })
  )
  ipcMain.handle(IPC_CHANNELS.profileApply, localSecure(() => localConsentRequired()))
  ipcMain.handle(IPC_CHANNELS.profileRestore, localSecure(() => localConsentRequired()))

  ipcMain.handle(IPC_CHANNELS.integrationStatus, localSecure(() => localConsentRequired()))
  ipcMain.handle(IPC_CHANNELS.integrationDiagnose, localSecure(() => localConsentRequired()))
  ipcMain.handle(IPC_CHANNELS.integrationInstall, localSecure(() => localConsentRequired()))
  ipcMain.handle(IPC_CHANNELS.integrationRelaunch, localSecure(() => localConsentRequired()))
  ipcMain.handle(IPC_CHANNELS.integrationRestore, localSecure(() => localConsentRequired()))

  ipcMain.handle(
    IPC_CHANNELS.relayGetConnection,
    publicSecure<RemoteRelayConnectionDto>((...args: unknown[]) =>
      args.length === 0
        ? success(currentRelayConnection())
        : failure('invalid_input', '中转站连接请求无效。'))
  )
  ipcMain.handle(
    IPC_CHANNELS.relayConnect,
    publicSecure<RemoteRelayConnectionDto>(async (input: unknown, ...extra: unknown[]) => {
      if (
        extra.length !== 0 ||
        !hasExactKeys(input, ['endpoint', 'confirmation']) ||
        typeof input.endpoint !== 'string' ||
        input.confirmation !== 'connect'
      ) {
        return failure('invalid_input', '中转站连接确认无效。')
      }
      backend.relay.confirmEndpoint(input.endpoint)
      relayEndpointConfirmed = true
      const restored = await backend.relay.restoreSession()
      if (restored.authenticated) localSessionUnlocked = true
      return success(currentRelayConnection())
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.relayStartDeviceAuthorization,
    publicSecure<RemoteRelayDeviceAuthorizationDto>(async (...args: unknown[]) => {
      if (args.length !== 0) return failure('invalid_input', '设备登录请求无效。')
      if (!relayEndpointConfirmed) {
        return failure('denied', '请先确认中转站 endpoint。')
      }
      const authorization = await backend.relay.startDeviceAuthorization({
        device_name: 'AI终点站 Electron',
        platform: 'Windows',
        client_version: app.getVersion()
      })
      return success(toRemoteRelayDeviceAuthorization(authorization))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.relayOpenDeviceAuthorization,
    publicSecure<null>(async (input: unknown, ...extra: unknown[]) => {
      if (
        extra.length !== 0 ||
        !hasExactKeys(input, ['sessionId']) ||
        typeof input.sessionId !== 'string'
      ) {
        return failure('invalid_input', '设备授权页请求无效。')
      }
      await shell.openExternal(backend.relay.getDeviceAuthorizationUrl(input.sessionId))
      return success(null)
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.relayPollDeviceAuthorization,
    publicSecure<RemoteRelayDeviceAuthorizationPollDto>(async (input: unknown, ...extra: unknown[]) => {
      if (
        extra.length !== 0 ||
        !hasExactKeys(input, ['sessionId']) ||
        typeof input.sessionId !== 'string'
      ) {
        return failure('invalid_input', '设备登录轮询请求无效。')
      }
      const poll = await backend.relay.pollDeviceAuthorization(input.sessionId)
      if (poll.status === 'authenticated') localSessionUnlocked = true
      return success(toRemoteRelayDeviceAuthorizationPoll(poll))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.relaySignOut,
    publicSecure<null>(async (...args: unknown[]) => {
      if (args.length !== 0) return failure('invalid_input', '退出登录请求无效。')
      pendingTurnStarts.abortAll()
      chatTurnRegistry.cancelAll()
      agentTurnRegistry.cancelAll()
      confirmedModelCatalogs.clear()
      profileCatalogGenerations.clear()
      tokenStore.revokeOwner(ownerWebContentsId)
      workspaceLaunchTokens.revokeOwner(ownerWebContentsId)
      imageResults.revokeOwner(ownerWebContentsId)
      projectInit.revokeOwner(ownerWebContentsId)
      backend.capabilities.resetOwner(ownerWebContentsId)
      waitingAgentTurns.clear()
      localSessionUnlocked = false
      await backend.relay.clearLocalSession()
      return success(null)
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.relayGetOverview,
    secure<RemoteRelayOverviewDto>(async (...args: unknown[]) => {
      if (args.length !== 0) return failure('invalid_input', '账户概览请求无效。')
      const [account, groups, models] = await Promise.all([
        backend.relay.getSelf(),
        backend.relay.getUserGroups(),
        backend.relay.getUserModels()
      ])
      return success(toRemoteRelayOverview(account, groups, models))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.relayGetBillingConfig,
    secure<RemoteRelayBillingConfigDto>(async (...args: unknown[]) => {
      if (args.length !== 0) return failure('invalid_input', '计费配置请求无效。')
      return success(toRemoteRelayBillingConfig(await backend.relay.getBillingConfig()))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.relayListTokens,
    secure<RemoteRelayTokenPageDto>(async (...args: unknown[]) => {
      if (args.length !== 0) return failure('invalid_input', '访问令牌列表请求无效。')
      return success(toRemoteRelayTokenPage(await backend.relay.listApiTokens(1, 100)))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.relayUpdateTokenStatus,
    secure<RemoteRelayTokenMutationDto>(async (input: unknown, ...extra: unknown[]) => {
      if (
        extra.length !== 0 ||
        !hasExactKeys(input, ['tokenId', 'status']) ||
        !Number.isSafeInteger(input.tokenId) ||
        Number(input.tokenId) <= 0 ||
        (input.status !== 'active' && input.status !== 'disabled')
      ) {
        return failure('invalid_input', '访问令牌状态请求无效。')
      }
      const statusCode = input.status === 'active' ? 1 : 2
      const result = await backend.relay.updateApiTokenStatus(Number(input.tokenId), statusCode)
      return success(toRemoteRelayTokenMutation(result, input.status))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.relayRevokeToken,
    secure<RemoteRelayTokenMutationDto>(async (input: unknown, ...extra: unknown[]) => {
      if (
        extra.length !== 0 ||
        !hasExactKeys(input, ['tokenId', 'confirmation']) ||
        !Number.isSafeInteger(input.tokenId) ||
        Number(input.tokenId) <= 0 ||
        input.confirmation !== 'revoke'
      ) {
        return failure('invalid_input', '访问令牌撤销请求无效。')
      }
      const result = await backend.relay.revokeApiToken(Number(input.tokenId))
      return success(toRemoteRelayTokenMutation(result, 'revoked'))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.relayListUsage,
    secure<RemoteRelayUsageDto>(async (input: unknown, ...extra: unknown[]) => {
      if (extra.length !== 0) return failure('invalid_input', '用量请求无效。')
      const range = normalizeRemoteRelayUsageInput(input)
      const usage = await backend.relay.getUsageHistory(range.startTimestamp, range.endTimestamp)
      return success(toRemoteRelayUsage(range, usage))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.relayListPricing,
    secure<RemoteRelayPricingDto>(async (...args: unknown[]) => {
      if (args.length !== 0) return failure('invalid_input', '价格目录请求无效。')
      return success(toRemoteRelayPricing(await backend.relay.getPricing()))
    })
  )
  ipcMain.handle(
    IPC_CHANNELS.relayRedeem,
    secure<RemoteRelayRedeemResultDto>(async (input: unknown, ...extra: unknown[]) => {
      if (
        extra.length !== 0 ||
        !hasExactKeys(input, ['code']) ||
        typeof input.code !== 'string'
      ) {
        return failure('invalid_input', '兑换请求无效。')
      }
      const result = await backend.relay.redeem(input.code)
      return success({ creditedQuota: result.quota })
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.linkOpenExternal,
    publicSecure(async (rawUrl: unknown) => {
      const url = validateExternalUrl(rawUrl)
      if (!url) return failure('invalid_input', '只允许打开不含凭据的 HTTPS 链接。')
      const approval = await dialog.showMessageBox(window, {
        type: 'question',
        title: '打开外部链接',
        message: '是否在系统浏览器中打开此地址？',
        detail: url,
        buttons: ['取消', '打开'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      if (approval.response !== 1) return failure('cancelled', '已取消打开外部链接。')
      await shell.openExternal(url)
      return success(null)
    })
  )

  let cleanupStarted = false
  const beginCleanup = (): void => {
    if (cleanupStarted) return
    cleanupStarted = true
    shuttingDown = true
    pendingTurnStarts.abortAll()
    confirmedModelCatalogs.clear()
    profileCatalogGenerations.clear()
    chatTurns.dispose()
    agentTurns.dispose()
    modelEndpointConsent.clear()
    chatEndpointConsent.clear()
    agentEndpointConsent.clear()
    relayEndpointConfirmed = false
    localSessionUnlocked = false
    backend.relay.revokeEndpointConfirmation()
    tokenStore.revokeOwner(ownerWebContentsId)
    workspaceLaunchTokens.revokeOwner(ownerWebContentsId)
    imageResults.revokeOwner(ownerWebContentsId)
    projectInit.revokeOwner(ownerWebContentsId)
    backend.capabilities.resetOwner(ownerWebContentsId)
    waitingAgentTurns.clear()
  }
  let shutdownPromise: Promise<void> | null = null
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise
    beginCleanup()
    shutdownPromise = Promise.allSettled([
      chatTurns.shutdown(),
      agentTurns.shutdown(),
      backend.relay.shutdown()
    ]).then(() => undefined)
    return shutdownPromise
  }
  window.webContents.once('destroyed', () => {
    void shutdown()
  })
  return { tokenStore, shutdown }
}

export function sendAgentEvent(window: BrowserWindow, event: AgentEvent): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return
  window.webContents.send(IPC_CHANNELS.agentEvent, redactAgentEvent(event))
}

function secureHandler<T>(window: BrowserWindow, handler: Handler<T>) {
  return async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<ApiResult<T>> => {
    if (!isTrustedRenderer(window, event)) {
      return failure('denied', '请求来源未获授权。')
    }
    try {
      return await handler(...args)
    } catch (error) {
      return knownFailure(error)
    }
  }
}

function isTrustedRenderer(window: BrowserWindow, event: IpcMainInvokeEvent): boolean {
  return (
    !window.isDestroyed() &&
    event.sender.id === window.webContents.id &&
    event.senderFrame === window.webContents.mainFrame
  )
}

function success<T>(value: T): ApiResult<T> {
  return { ok: true, value }
}

function runtimeNotReady(message = '可信 Agent 运行时尚未连接。'): ApiResult<never> {
  return failure('not_ready', message, true)
}

function localConsentRequired(): ApiResult<never> {
  return failure('denied', '请先明确批准本次本地环境检查。')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys<K extends string>(
  value: unknown,
  expectedKeys: readonly K[]
): value is Record<K, unknown> {
  if (!isObject(value)) return false
  const actualKeys = Object.keys(value)
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  )
}

function hasOnlyAllowedKeys<K extends string>(
  value: unknown,
  allowedKeys: readonly K[]
): value is Record<K, unknown> {
  return isObject(value) && Object.keys(value).every((key) => allowedKeys.includes(key as K))
}

function hasExactStringField<K extends string>(
  value: unknown,
  field: K
): value is Record<K, string> {
  return hasExactKeys(value, [field]) && typeof value[field] === 'string'
}

function validateChatTurnInput(input: unknown):
  | { ok: true; value: TurnStartInput }
  | { ok: false; result: ApiResult<never> } {
  const allowedKeys = [
    'requestId',
    'taskId',
    'mode',
    'prompt',
    'profileHandle',
    'groupId',
    'modelId',
    'reasoning',
    'approvalMode',
    'workspaceToken',
    'reviewHandle',
    'attachmentTokens',
    'webSearch',
    'imageGeneration',
    'localSubagents',
    'contextMessageLimit'
  ] as const
  const requiredKeys = allowedKeys.filter(
    (key) =>
      key !== 'workspaceToken' &&
      key !== 'reviewHandle' &&
      key !== 'localSubagents' &&
      key !== 'contextMessageLimit'
  )
  if (
    !hasOnlyAllowedKeys(input, allowedKeys) ||
    !requiredKeys.every((key) => Object.hasOwn(input, key)) ||
    !isTurnStartRequestId(input.requestId) ||
    typeof input.taskId !== 'string' ||
    typeof input.prompt !== 'string' ||
    input.prompt.length < 1 ||
    input.prompt.length > 256 * 1024 ||
    Buffer.byteLength(input.prompt, 'utf8') > 256 * 1024 ||
    input.prompt.includes('\0') ||
    typeof input.profileHandle !== 'string' ||
    input.profileHandle.length > 128 ||
    (input.groupId !== null && !isValidRelayGroupId(input.groupId)) ||
    !isValidModelId(input.modelId) ||
    (input.mode !== 'chat' && input.mode !== 'agent') ||
    !['auto', 'light', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(String(input.reasoning)) ||
    !['request', 'auto', 'full'].includes(String(input.approvalMode)) ||
    typeof input.webSearch !== 'boolean' ||
    typeof input.imageGeneration !== 'boolean' ||
    (input.localSubagents !== undefined && typeof input.localSubagents !== 'boolean') ||
    (input.contextMessageLimit !== undefined &&
      (!Number.isSafeInteger(input.contextMessageLimit) ||
        Number(input.contextMessageLimit) < 2 ||
        Number(input.contextMessageLimit) > 24)) ||
    (input.workspaceToken !== undefined && typeof input.workspaceToken !== 'string') ||
    (input.reviewHandle !== undefined &&
      (typeof input.reviewHandle !== 'string' || !/^review_[A-Za-z0-9_-]{43}$/u.test(input.reviewHandle))) ||
    !Array.isArray(input.attachmentTokens) ||
    input.attachmentTokens.length > 16 ||
    input.attachmentTokens.some((token) => typeof token !== 'string' || token.length > 256)
  ) {
    return { ok: false, result: failure('invalid_input', 'Chat 请求无效。') }
  }
  if (input.mode === 'chat' && input.workspaceToken !== undefined) {
    return { ok: false, result: failure('invalid_input', 'Chat 模式不能绑定本地工作区。') }
  }
  if (input.mode === 'chat' && input.reviewHandle !== undefined) {
    return { ok: false, result: failure('invalid_input', 'Chat mode cannot consume a code review authorization.') }
  }
  if (input.mode === 'chat' && input.localSubagents === true) {
    return { ok: false, result: failure('invalid_input', 'Chat 模式不能启动本地子任务。') }
  }

  return {
    ok: true,
    value: {
      requestId: input.requestId,
      taskId: input.taskId,
      mode: input.mode,
      prompt: input.prompt,
      profileHandle: input.profileHandle,
      groupId: input.groupId,
      modelId: input.modelId,
      reasoning: input.reasoning as TurnStartInput['reasoning'],
      approvalMode: input.approvalMode as TurnStartInput['approvalMode'],
      ...(input.workspaceToken === undefined ? {} : { workspaceToken: input.workspaceToken }),
      ...(input.reviewHandle === undefined ? {} : { reviewHandle: input.reviewHandle }),
      attachmentTokens: [...input.attachmentTokens] as string[],
      webSearch: input.webSearch,
      imageGeneration: input.imageGeneration,
      localSubagents: input.localSubagents === true,
      ...(input.contextMessageLimit === undefined
        ? {}
        : { contextMessageLimit: Number(input.contextMessageLimit) })
    }
  }
}

function groupConversationTasks(tasks: Awaited<ReturnType<MainBackendServices['conversations']['list']>>): ProjectSummary[] {
  if (tasks.length === 0) return []
  return [{
    id: 'project:local-history',
    name: '本地历史',
    tasks
  }]
}

async function getBackendBootstrapPayload(
  backend: MainBackendServices,
  relayProfileAvailable: boolean
): Promise<BootstrapPayload> {
  const payload = getBootstrapPayload()
  const storedProfiles = await backend.profiles.listPublic()
  const storedTasks = await backend.conversations.list()
  const relayProfile = relayProfileAvailable ? createRelayPublicProfile() : null
  payload.profiles = relayProfile
    ? [relayProfile, ...storedProfiles.filter((profile) => profile.credentialHandle !== WZH_RELAY_PROFILE_HANDLE)]
    : storedProfiles
  payload.projects = groupConversationTasks(storedTasks)
  payload.activeTaskId = storedTasks.find((task) => task.archivedAt === null)?.id ?? ''
  const current = relayProfile ?? storedProfiles.find((profile) => profile.isCurrent)
  payload.defaults.activeProfileHandle = current?.credentialHandle ?? ''
  return payload
}

function createRelayPublicProfile(): PublicAccessProfile {
  return {
    credentialHandle: WZH_RELAY_PROFILE_HANDLE,
    name: 'wzh-server',
    description: '当前账户会话提供的安全模型访问',
    baseUrl: WZH_MODEL_BASE_URL,
    hasKey: true,
    isCurrent: true,
    targets: ['codex']
  }
}

async function requestModelEndpointConsent(
  window: BrowserWindow,
  endpoint: string
): Promise<boolean> {
  const approval = await dialog.showMessageBox(window, {
    type: 'question',
    title: '确认模型 endpoint',
    message: '是否允许本次应用会话连接以下模型 endpoint？',
    detail: `${endpoint}\n\n确认后将读取 /models 目录；不会发送聊天内容、文件、文件名或本地路径。`,
    buttons: ['取消', '允许本次会话'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return approval.response === 1
}

async function requestCapabilityDiscoveryConsent(
  window: BrowserWindow,
  category: 'skills' | 'plugins',
  workspacePath?: string
): Promise<boolean> {
  const categoryLabel = category === 'skills' ? '技能' : '插件'
  const locations = category === 'skills'
    ? '~/.codex/skills、~/.agents/skills'
    : '~/.codex-plugin、~/.codex/plugins、~/.agents/plugins'
  const workspaceDetail = workspacePath
    ? `\n并检查当前已选择工作区内对应的 ${categoryLabel} 目录：\n${workspacePath}`
    : ''
  const approval = await dialog.showMessageBox(window, {
    type: 'question',
    title: `读取本地${categoryLabel}目录`,
    message: `是否允许本次读取已知的本地${categoryLabel}目录？`,
    detail: [
      `将有界扫描 ${locations}${workspaceDetail}。`,
      '只返回经过脱敏的名称、说明、权限和工作区相对路径；不会运行脚本、命令或插件。',
      '本次批准只用于这一次目录读取，不会持久化。'
    ].join('\n\n'),
    buttons: ['取消', '允许本次读取'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return approval.response === 1
}

async function requestCapabilitySkillUseConsent(
  window: BrowserWindow,
  request: CapabilitySkillUseRequest
): Promise<boolean> {
  const scope = request.scope === 'workspace' ? '当前工作区' : '当前用户'
  const approval = await dialog.showMessageBox(window, {
    type: 'question',
    title: '读取技能说明',
    message: '是否允许本次读取所选技能的说明文件？',
    detail: [
      `技能：${request.id}`,
      `范围：${scope}`,
      `相对路径：${request.relativePath}`,
      '文件必须与目录发现时的设备、文件标识和内容摘要完全一致，否则会拒绝。',
      '说明会先脱敏并限制长度；只有你随后发送消息且确认精确模型 endpoint 时，才会进入模型上下文。'
    ].join('\n'),
    buttons: ['取消', '允许本次读取'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return approval.response === 1
}

async function requestProjectInitPrepareConsent(
  window: BrowserWindow,
  workspacePath: string
): Promise<boolean> {
  const approval = await dialog.showMessageBox(window, {
    type: 'question',
    title: '准备 AGENTS.md 草稿',
    message: '是否允许本次读取当前工作区以准备项目规则草稿？',
    detail: [
      workspacePath,
      '将只枚举工作区根目录的一层安全条目，并检查现有 AGENTS.md 的受限内容与修订摘要。',
      '本步骤不会写入文件、运行任意命令、连接网络或把内容发送给模型。',
      '批准仅用于这一次草稿准备；生成后还需要单独确认才能写入。'
    ].join('\n\n'),
    buttons: ['取消', '允许本次读取并预览'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return approval.response === 1
}

async function requestProjectInitCommitConsent(
  window: BrowserWindow,
  workspacePath: string,
  inspection: ProjectInitCommitInspection
): Promise<boolean> {
  const targetAction = inspection.target.state === 'absent'
    ? 'create a new file'
    : 'atomically replace the existing file'
  const approval = await dialog.showMessageBox(window, {
    type: 'warning',
    title: '写入 AGENTS.md',
    message: '是否将刚才预览的固定草稿写入当前工作区？',
    detail: [
      workspacePath,
      `Bound action: ${targetAction}`,
      `Approved draft SHA-256: ${inspection.contentSha256}`,
      '目标文件：AGENTS.md',
      'Main 进程只会使用内存中的一次性草稿，不接受 Renderer 回传正文。',
      '写入前会再次核对工作区、目标文件和草稿摘要；任何变化都会拒绝写入。',
      '文件通过同目录临时文件同步后原子提交。'
    ].join('\n\n'),
    buttons: ['取消并撤销草稿', '写入已预览草稿'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return approval.response === 1
}

async function requestPlanModeExitConsent(window: BrowserWindow): Promise<boolean> {
  const approval = await dialog.showMessageBox(window, {
    type: 'warning',
    title: '退出计划模式',
    message: '是否退出当前应用会话的只读计划模式？',
    detail: '退出后，后续 Agent 轮次可再次按所选批准策略请求文件写入。工作区边界、逐项批准和脱敏规则仍然有效。',
    buttons: ['保持计划模式', '退出计划模式'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return approval.response === 1
}

async function requestChatEndpointConsent(
  window: BrowserWindow,
  endpoint: string
): Promise<boolean> {
  const requestUrl = `${endpoint.replace(/\/+$/, '')}/responses`
  const approval = await dialog.showMessageBox(window, {
    type: 'question',
    title: '确认 Chat endpoint',
    message: '是否允许本次应用会话向以下 endpoint 发送 Chat 内容？',
    detail: `${requestUrl}\n\n将发送经过脱敏的聊天文本、所选模型、推理强度和工具开关。仅当本轮明确选择附件时，才会读取并发送经过本地校验、文本脱敏和通用重命名的图片或文本内容；启用图片生成时，会向该 endpoint 请求生成图片并接收结果。不会发送附件绝对路径、原始文件名或 API Key。图片结果只进入当前应用会话的受限内存。`,
    buttons: ['取消', '允许本次会话'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return approval.response === 1
}

async function requestAgentEndpointConsent(
  window: BrowserWindow,
  endpoint: string
): Promise<boolean> {
  const requestUrl = `${endpoint.replace(/\/+$/, '')}/responses`
  const approval = await dialog.showMessageBox(window, {
    type: 'question',
    title: '确认 Agent endpoint',
    message: '是否允许本次应用会话向以下 endpoint 发送 Agent 内容？',
    detail: `${requestUrl}\n\n将发送经过脱敏的聊天文本、所选模型、推理强度、工具开关、工作区相对文件名、获批文件内容和工具结果。若你为本轮开启本地子任务且模型目录未明确禁用该能力，同一 endpoint 还可能收到最多三个受限只读子任务；它们继承相同工作区、批准、取消与脱敏边界，不能写文件、运行命令或启用 Web Search。仅当本轮明确选择附件时，才会发送经过本地校验、文本脱敏和通用重命名的图片或文本内容；启用图片生成时，会向该 endpoint 请求生成图片并接收结果。不会发送工作区或附件绝对路径、附件原始文件名，也不会把 API Key 放入 URL、日志或本地明文历史。`,
    buttons: ['取消', '允许本次会话'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return approval.response === 1
}

async function requestAgentPermissionMode(
  window: BrowserWindow,
  mode: 'auto' | 'full'
): Promise<boolean> {
  const auto = mode === 'auto'
  const approval = await dialog.showMessageBox(window, {
    type: auto ? 'question' : 'warning',
    title: auto ? '启用“替我审批”' : '启用“完全访问”',
    message: auto
      ? '是否仅为下一轮 Agent 启用策略自动审批？'
      : '是否仅为下一轮 Agent 减少工作区内的逐项批准？',
    detail: auto
      ? '当前阶段只会自动批准经过严格路径校验的低风险只读操作；敏感文件、工作区外路径、写入、命令、网络和提权不会因此获准。授权不持久化，应用重启后失效。'
      : '本轮将自动批准已注册的工作区工具，包括单层目录枚举、Git 状态读取、普通文本文件读取，以及普通文本文件的创建或原子覆盖。它不是 Windows 系统级全盘访问；工作区边界、敏感文件和控制目录保护、覆盖版本校验、endpoint 确认、脱敏及工具白名单仍然有效。命令和终端尚未开放。授权只绑定下一轮，且不持久化。',
    buttons: ['取消', auto ? '启用替我审批' : '启用当前工作区完全访问'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return approval.response === 1
}

function projectIdForWorkspace(workspace: { device: string; inode: string }): string {
  const digest = createHash('sha256')
    .update('ai-terminal.workspace-project.v1\0', 'utf8')
    .update(workspace.device, 'utf8')
    .update('\0', 'utf8')
    .update(workspace.inode, 'utf8')
    .digest('base64url')
  return `project:workspace:${digest}`
}

function isCodeReviewPrompt(value: string): boolean {
  return /^\/review(?:\s|$)/iu.test(value.trimStart())
}

function codeReviewPrompt(value: string): string {
  const focus = value.trimStart().replace(/^\/review(?:\s+|$)/iu, '').trim()
  return [
    'Review the current authorized workspace changes.',
    'Start by requesting the bounded Git diff, then inspect only the minimum additional files needed.',
    focus ? `User focus: ${focus}` : ''
  ].filter(Boolean).join('\n')
}

function knownFailure(error: unknown): ApiResult<never> {
  if (error instanceof EndpointConsentCoordinatorError) {
    if (error.code === 'denied') return failure('denied', '本次会话未批准该 endpoint。')
    return failure('runtime_error', '无法显示 endpoint 批准请求，请重试。', true)
  }
  if (error instanceof RelayDtoAdapterError) {
    return error.code === 'invalid_input'
      ? failure('invalid_input', '中转站请求无效。')
      : failure('runtime_error', '中转站数据未通过本地安全校验。')
  }
  if (error instanceof RelayServiceError) {
    switch (error.code) {
      case 'invalid_configuration':
      case 'storage_error':
        return failure('runtime_error', '中转站安全存储不可用，请检查 Windows DPAPI 后重试。')
      case 'invalid_endpoint':
      case 'invalid_input':
        return failure('invalid_input', '中转站请求无效。')
      case 'endpoint_not_confirmed':
        return failure('denied', '请先确认精确的中转站 endpoint。')
      case 'cancelled':
        return failure('cancelled', '中转站请求已取消。')
      case 'timeout':
        return failure('runtime_error', '中转站请求超时，请重试。', true)
      case 'network_error':
        return failure('runtime_error', '无法连接已确认的中转站。', true)
      case 'authentication_required':
      case 'authorization_expired':
      case 'authorization_denied':
        return failure('denied', '中转站登录已失效，请重新进行设备授权。')
      case 'no_available_token':
        return failure('not_ready', '账户中没有可用的访问令牌，请先在用户中心创建或启用一个令牌。')
      case 'no_compatible_token':
        return failure('not_ready', '所选接入分组没有可用于该模型的令牌，请在用户中心检查令牌分组和模型限制。')
      case 'authorization_pending':
      case 'authorization_slow_down':
        return failure('not_ready', '设备授权尚未完成，请稍后重试。', true)
      case 'too_many_sessions':
        return failure('conflict', '待处理的设备登录过多，请等待现有登录过期。')
      case 'remote_unavailable':
        return failure('runtime_error', '中转站服务暂时不可用，请稍后重试。', true)
      case 'remote_rejected':
        return failure('runtime_error', '中转站拒绝了本次请求，请确认客户端与服务器版本一致。')
      case 'redirect_rejected':
        return failure('denied', '中转站返回了不允许的跳转，已阻止本次请求。')
      case 'response_too_large':
        return failure('runtime_error', '中转站响应超过本地安全上限。')
      case 'invalid_response':
        return failure('runtime_error', '中转站响应结构未通过本地安全校验。')
    }
  }
  if (error instanceof ConsentValidationError) {
    return error.code === 'invalid_endpoint'
      ? failure('invalid_input', '模型 endpoint 不符合安全传输策略。')
      : failure('runtime_error', '本次会话授权状态无效，请重试。', true)
  }
  if (error instanceof AccessProfileServiceError) {
    switch (error.code) {
      case 'invalid_input':
        return failure('invalid_input', '渠道配置无效。')
      case 'not_found':
        return failure('not_found', '没有找到所选渠道。')
      case 'missing_secret':
        return failure('denied', '请先为所选渠道安全保存 API Key。')
      case 'corrupt_data':
        return failure('runtime_error', '加密渠道配置已损坏，未读取其中内容。')
      case 'invalid_configuration':
      case 'storage_error':
        return failure('runtime_error', '无法安全读取或保存渠道配置。', true)
    }
  }
  if (error instanceof ConversationHistoryError) {
    switch (error.code) {
      case 'invalid_input':
        return failure('invalid_input', '对话历史请求无效。')
      case 'not_found':
        return failure('not_found', '没有找到所选本地任务。')
      case 'conflict':
        return failure('conflict', '对话状态已变化，请重新加载。')
      case 'limit_exceeded':
        return failure('conflict', '加密对话历史已达到安全容量上限。')
      case 'corrupt_data':
        return failure('runtime_error', '加密对话历史已损坏，未读取其中内容。')
      case 'invalid_configuration':
      case 'storage_error':
        return failure('runtime_error', '无法安全读取或保存加密对话历史。', true)
    }
  }
  if (error instanceof ChatTurnError) {
    return error.code === 'invalid_task_mode'
      ? failure('conflict', '所选任务不是 Chat 模式。')
      : failure('runtime_error', 'Chat 请求未能安全启动。', true)
  }
  if (error instanceof AgentTurnError) {
    return error.code === 'invalid_task_mode' || error.code === 'workspace_mismatch'
      ? failure(
          'conflict',
          error.code === 'workspace_mismatch'
            ? '所选 Agent 任务属于另一个工作区，请为当前工作区新建任务。'
            : '所选任务不是 Agent 模式。'
        )
      : error.code === 'invalid_tool_call'
        ? failure('denied', '模型提出了不符合本地工具契约的请求。')
        : failure('runtime_error', 'Agent 请求未能安全启动。', true)
  }
  if (error instanceof AgentApprovalError) {
    return error.code === 'capacity_exceeded'
      ? failure('not_ready', '待处理的 Agent 批准请求过多，请稍后重试。', true)
      : failure('runtime_error', 'Agent 批准状态无效，请重试。', true)
  }
  if (error instanceof AttachmentInputError) {
    switch (error.code) {
      case 'cancelled':
        return failure('cancelled', '附件读取已取消。')
      case 'invalid_request':
        return failure('invalid_input', '附件请求无效，请重新选择。')
      case 'selection_invalid':
        return failure('denied', '附件授权无效、已使用或已过期，请重新选择。')
      case 'unsupported_type':
        return failure('invalid_input', '附件类型、编码或图片格式不受支持。')
      case 'sensitive_path':
        return failure('denied', '本地安全策略禁止发送该附件。')
      case 'file_too_large':
      case 'total_too_large':
        return failure('invalid_input', '附件超过本地安全大小限制。')
      case 'file_unavailable':
      case 'file_changed':
        return failure('conflict', '附件不可用或在选择后发生变化，请重新选择。')
      case 'invalid_configuration':
        return failure('runtime_error', '附件读取服务不可用，请重试。', true)
    }
  }
  if (error instanceof ImageResultStoreError) {
    return error.code === 'invalid_image'
      ? failure('runtime_error', '模型返回的图片未通过本地安全校验。')
      : failure('not_ready', '图片临时存储容量不可用，请稍后重试。', true)
  }
  if (error instanceof ProjectInitError) {
    switch (error.code) {
      case 'invalid_request':
        return failure('invalid_input', 'Project initialization request is invalid.')
      case 'draft_capacity_exceeded':
        return failure('not_ready', 'Too many project drafts are pending. Try again later.', true)
      case 'draft_unavailable':
        return failure('denied', 'The project draft is invalid or expired. Prepare it again.')
      case 'workspace_unavailable':
        return failure('not_found', 'The authorized workspace is unavailable. Select it again.')
      case 'workspace_changed':
      case 'target_changed':
        return failure('conflict', 'The workspace or AGENTS.md changed after preview. Prepare a new draft.')
      case 'target_invalid':
        return failure('denied', 'The existing AGENTS.md target does not meet local safety requirements.')
      case 'cancelled':
        return failure('cancelled', 'Project initialization was cancelled.')
      case 'committed_cleanup_failed':
        return failure(
          'runtime_error',
          'AGENTS.md was committed, but temporary cleanup did not finish safely. Do not retry this draft; inspect the file before preparing another draft.'
        )
      case 'summary_failed':
      case 'write_failed':
      case 'invalid_options':
        return failure('runtime_error', 'Project initialization could not be completed safely.', true)
    }
  }
  if (error instanceof SelectionTokenError) {
    return error.code === 'invalid_selection' || error.code === 'invalid_owner'
      ? failure('invalid_input', '本地选择无效，请重新选择。')
      : failure('runtime_error', '无法创建安全的本地选择授权。', true)
  }
  if (error instanceof WorkspaceOpenerError) {
    switch (error.code) {
      case 'invalid_request':
        return failure('invalid_input', '工作区打开请求无效。')
      case 'unsupported_platform':
        return failure('not_ready', '当前系统暂不支持打开本机应用。')
      case 'opener_unavailable':
        return failure('not_found', '所选本机应用不可用，请重新检测。')
      case 'workspace_unavailable':
        return failure('not_found', '工作区目录当前不可用，请重新选择。')
      case 'workspace_changed':
        return failure('conflict', '工作区在选择后发生变化，请重新选择。')
      case 'launch_failed':
        return failure('runtime_error', '本机应用未能启动，请重新检测后再试。', true)
    }
  }
  if (error instanceof WorkspaceToolError) {
    if (error.code === 'cancelled') return failure('cancelled', '本地工作区操作已取消。')
    if (['invalid_request', 'invalid_relative_path'].includes(error.code)) {
      return failure('invalid_input', '工作区工具请求无效。')
    }
    if (['workspace_unavailable', 'path_not_found'].includes(error.code)) {
      return failure('not_found', '工作区或目标文件不可用。')
    }
    if (
      [
        'sensitive_path',
        'path_outside_workspace',
        'reparse_point_rejected',
        'hard_link_rejected'
      ].includes(error.code)
    ) {
      return failure('denied', '工作区安全策略拒绝了该路径。')
    }
    return failure('runtime_error', '工作区工具未能安全完成。', error.retryable)
  }
  if (error instanceof PendingTurnStartError) {
    switch (error.code) {
      case 'invalid_request_id':
        return failure('invalid_input', 'Turn start request is invalid.')
      case 'duplicate_request':
        return failure('conflict', 'This turn start request is already pending.')
      case 'capacity_exceeded':
        return failure('not_ready', 'Too many turn starts are pending.', true)
      case 'cancelled':
        return failure('cancelled', 'Turn start was cancelled.')
    }
  }
  if (error instanceof TurnRegistryError) {
    switch (error.code) {
      case 'duplicate_active_turn':
        return failure('conflict', '该任务已有一个正在运行的请求。')
      case 'active_turn_capacity':
        return failure('not_ready', '并发请求已达到安全上限，请稍后重试。', true)
      case 'invalid_task_id':
        return failure('invalid_input', '任务标识无效。')
      case 'invalid_options':
      case 'turn_id_unavailable':
        return failure('runtime_error', '无法创建安全的请求标识，请重试。', true)
    }
  }
  if (error instanceof ModelCatalogError) {
    switch (error.code) {
      case 'invalid_endpoint':
      case 'invalid_credential':
        return failure('invalid_input', '模型 endpoint 或 API Key 无效。')
      case 'timeout':
        return failure('runtime_error', '读取模型目录超时，请重试。', true)
      case 'network_error':
        return failure('runtime_error', '无法连接已确认的模型 endpoint。', true)
      case 'remote_rejected':
        return failure('runtime_error', '模型 endpoint 拒绝了目录请求，请检查 API Key 和服务状态。', true)
      case 'response_too_large':
      case 'invalid_response':
        return failure('runtime_error', '模型目录响应不符合安全格式。')
    }
  }
  if (error instanceof CapabilityRegistryError) {
    return error.code === 'invalid_input'
      ? failure('invalid_input', 'Capability request is invalid.')
      : failure('runtime_error', 'Capability discovery is temporarily unavailable.', true)
  }
  if (error instanceof CapabilityGrantStoreError) {
    return error.code === 'invalid_binding' || error.code === 'invalid_options'
      ? failure('invalid_input', 'Capability authorization is invalid.')
      : failure('runtime_error', 'Capability authorization is temporarily unavailable.', true)
  }
  return internalFailure()
}

function redactAgentEvent(event: AgentEvent): AgentEvent {
  switch (event.type) {
    case 'assistant-delta':
      return { ...event, text: redactSensitiveContent(event.text) }
    case 'image-result':
      return event
    case 'terminal-output':
      return { ...event, data: redactSensitiveText(event.data) }
    case 'turn-status':
      return event.message ? { ...event, message: redactSensitiveText(event.message) } : event
    case 'tool-status':
    case 'approval-request':
      return { ...event, label: redactSensitiveText(event.label) }
  }
}
