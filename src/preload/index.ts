import { contextBridge, ipcRenderer } from 'electron'

import type { AgentEvent, RendererApi } from '../shared/contracts'
import { isAgentEvent } from '../shared/agent-event-validator'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import type { IpcChannel } from '../shared/ipc-channels'

// Electron's invoke boundary is dynamically typed; the objects below are checked
// against RendererApi before they are exposed to the untrusted renderer.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const invoke = (channel: IpcChannel, ...args: unknown[]): Promise<any> =>
  ipcRenderer.invoke(channel, ...args)

const appApi: RendererApi['app'] = {
  getBootstrap: () => invoke(IPC_CHANNELS.appGetBootstrap)
}

const windowApi: RendererApi['window'] = {
  minimize: () => invoke(IPC_CHANNELS.windowMinimize),
  toggleMaximize: () => invoke(IPC_CHANNELS.windowToggleMaximize),
  close: () => invoke(IPC_CHANNELS.windowClose)
}

const dialogApi: RendererApi['dialog'] = {
  selectWorkspace: () => invoke(IPC_CHANNELS.dialogSelectWorkspace),
  selectAttachments: () => invoke(IPC_CHANNELS.dialogSelectAttachments)
}

const conversationApi: RendererApi['conversation'] = {
  list: () => invoke(IPC_CHANNELS.conversationList),
  create: (input) => invoke(IPC_CHANNELS.conversationCreate, input),
  load: (input) => invoke(IPC_CHANNELS.conversationLoad, input),
  rename: (input) => invoke(IPC_CHANNELS.conversationRename, input),
  setArchived: (input) => invoke(IPC_CHANNELS.conversationSetArchived, input),
  delete: (input) => invoke(IPC_CHANNELS.conversationDelete, input)
}

const modelsApi: RendererApi['models'] = {
  list: (input) => invoke(IPC_CHANNELS.modelsList, input)
}

const capabilitiesApi: RendererApi['capabilities'] = {
  list: (input) => input === undefined
    ? invoke(IPC_CHANNELS.capabilityList)
    : invoke(IPC_CHANNELS.capabilityList, input),
  execute: (input) => invoke(IPC_CHANNELS.capabilityExecute, input)
}

const turnApi: RendererApi['turn'] = {
  start: (input) => invoke(IPC_CHANNELS.turnStart, input),
  cancel: (input) => invoke(IPC_CHANNELS.turnCancel, input)
}

const approvalApi: RendererApi['approval'] = {
  resolve: (input) => invoke(IPC_CHANNELS.approvalResolve, input)
}

const imageApi: RendererApi['image'] = {
  read: (input) => invoke(IPC_CHANNELS.imageRead, input)
}

const workspaceApi: RendererApi['workspace'] = {
  listOpeners: (input) => invoke(IPC_CHANNELS.workspaceListOpeners, input),
  open: (input) => invoke(IPC_CHANNELS.workspaceOpen, input),
  readFile: (input) => invoke(IPC_CHANNELS.workspaceReadFile, input),
  writeFile: (input) => invoke(IPC_CHANNELS.workspaceWriteFile, input),
  gitSummary: (input) => invoke(IPC_CHANNELS.workspaceGitSummary, input)
}

const terminalApi: RendererApi['terminal'] = {
  start: (input) => invoke(IPC_CHANNELS.terminalStart, input),
  input: (input) => invoke(IPC_CHANNELS.terminalInput, input),
  resize: (input) => invoke(IPC_CHANNELS.terminalResize, input),
  stop: (input) => invoke(IPC_CHANNELS.terminalStop, input)
}

const profileApi: RendererApi['profile'] = {
  listPublic: () => invoke(IPC_CHANNELS.profileListPublic),
  save: (input) => invoke(IPC_CHANNELS.profileSave, input),
  delete: (input) => invoke(IPC_CHANNELS.profileDelete, input),
  apply: (input) => invoke(IPC_CHANNELS.profileApply, input),
  restore: (input) => invoke(IPC_CHANNELS.profileRestore, input)
}

const integrationApi: RendererApi['integration'] = {
  status: (input) => invoke(IPC_CHANNELS.integrationStatus, input),
  diagnose: (input) => invoke(IPC_CHANNELS.integrationDiagnose, input),
  install: (input) => invoke(IPC_CHANNELS.integrationInstall, input),
  relaunch: (input) => invoke(IPC_CHANNELS.integrationRelaunch, input),
  restore: (input) => invoke(IPC_CHANNELS.integrationRestore, input)
}

const relayApi: RendererApi['relay'] = {
  getConnection: () => invoke(IPC_CHANNELS.relayGetConnection),
  connect: (input) => invoke(IPC_CHANNELS.relayConnect, input),
  startDeviceAuthorization: () => invoke(IPC_CHANNELS.relayStartDeviceAuthorization),
  openDeviceAuthorization: (input) => invoke(IPC_CHANNELS.relayOpenDeviceAuthorization, input),
  pollDeviceAuthorization: (input) => invoke(IPC_CHANNELS.relayPollDeviceAuthorization, input),
  signOut: () => invoke(IPC_CHANNELS.relaySignOut),
  getOverview: () => invoke(IPC_CHANNELS.relayGetOverview),
  getBillingConfig: () => invoke(IPC_CHANNELS.relayGetBillingConfig),
  listTokens: () => invoke(IPC_CHANNELS.relayListTokens),
  updateTokenStatus: (input) => invoke(IPC_CHANNELS.relayUpdateTokenStatus, input),
  revokeToken: (input) => invoke(IPC_CHANNELS.relayRevokeToken, input),
  listUsage: (input) => invoke(IPC_CHANNELS.relayListUsage, input),
  listPricing: () => invoke(IPC_CHANNELS.relayListPricing),
  redeem: (input) => invoke(IPC_CHANNELS.relayRedeem, input)
}

const linkApi: RendererApi['link'] = {
  openExternal: (url) => invoke(IPC_CHANNELS.linkOpenExternal, url)
}

const api: RendererApi = {
  app: appApi,
  window: windowApi,
  dialog: dialogApi,
  conversation: conversationApi,
  models: modelsApi,
  capabilities: capabilitiesApi,
  turn: turnApi,
  approval: approvalApi,
  image: imageApi,
  workspace: workspaceApi,
  terminal: terminalApi,
  profile: profileApi,
  integration: integrationApi,
  relay: relayApi,
  link: linkApi,
  onAgentEvent: (listener: (event: AgentEvent) => void) => {
    if (typeof listener !== 'function') return () => undefined
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      if (isAgentEvent(payload)) listener(payload)
    }
    ipcRenderer.on(IPC_CHANNELS.agentEvent, wrapped)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.agentEvent, wrapped)
    }
  }
}

Object.freeze(appApi)
Object.freeze(windowApi)
Object.freeze(dialogApi)
Object.freeze(conversationApi)
Object.freeze(modelsApi)
Object.freeze(capabilitiesApi)
Object.freeze(turnApi)
Object.freeze(approvalApi)
Object.freeze(imageApi)
Object.freeze(workspaceApi)
Object.freeze(terminalApi)
Object.freeze(profileApi)
Object.freeze(integrationApi)
Object.freeze(relayApi)
Object.freeze(linkApi)
Object.freeze(api)

contextBridge.exposeInMainWorld('onekey', api)
