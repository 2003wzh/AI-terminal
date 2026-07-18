import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { _electron as electron } from 'playwright'
import { resolveSmokeArtifactPaths } from './smoke-paths.mjs'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const smokeArtifacts = resolveSmokeArtifactPaths(rootDir)
const authScreenshotPath = smokeArtifacts.auth
const screenshotPath = smokeArtifacts.workspace
const openerScreenshotPath = smokeArtifacts.openers
const userCenterScreenshotPath = smokeArtifacts.userCenter
const settingsScreenshotPath = smokeArtifacts.settings
const configurationScreenshotPath = smokeArtifacts.configuration
const fakeCredential = 'electron-smoke-chat-key-never-return'
const relayModelCredential = 'sk-electron-smoke-relay-key-never-return'
const relayCredentialNonce = `${Date.now().toString(36)}_${process.pid}`
const relayAccessCredential = `relay_access_${relayCredentialNonce}`
const relayRefreshCredential = `relay_refresh_${relayCredentialNonce}`
const fakeAbsolutePath = 'D:\\smoke-private\\workspace\\secret.txt'
const completedPrompt = 'Complete the local Electron streaming smoke.'
const cancelledPrompt = 'Start the controlled local long stream.'
const agentPrompt = 'Read agent-input.txt, then create agent-output.txt with the requested result.'
const agentInputFile = 'agent-input.txt'
const agentOutputFile = 'agent-output.txt'
const agentInputMarker = 'Approved local file content reached the Agent.'
const agentWrittenContent = 'Electron Agent read/write smoke passed.\n'
const agentEditPrompt = 'Search agent-edit.txt for the old marker, read it, then replace the unique marker.'
const agentEditFile = 'agent-edit.txt'
const agentEditInitialContent = 'prefix old marker suffix\n'
const agentEditOldText = 'old marker'
const agentEditNewText = 'new marker'
const agentEditRevision = createHash('sha256')
  .update(agentEditInitialContent, 'utf8')
  .digest('hex')
const temporaryWorkspacePath = await mkdtemp(
  join(tmpdir(), 'onekey-electron-agent-smoke-')
)
await mkdir(smokeArtifacts.directory, { recursive: true })
await writeFile(
  join(temporaryWorkspacePath, agentInputFile),
  `${agentInputMarker}\nBearer ${fakeCredential}\nPrivate path: ${fakeAbsolutePath}\n`,
  'utf8'
)
await writeFile(
  join(temporaryWorkspacePath, agentEditFile),
  agentEditInitialContent,
  'utf8'
)

const localResponses = await startLocalResponsesServer({
  fakeCredential,
  relayModelCredential,
  fakeAbsolutePath,
  agentInputFile,
  agentOutputFile,
  agentWrittenContent,
  agentEditPrompt,
  agentEditFile,
  agentEditOldText,
  agentEditNewText,
  agentEditRevision
})
let electronApp
let page
let temporaryProfileHandle = ''
let temporaryTaskId = ''
let temporaryAgentTaskId = ''
let temporaryEditAgentTaskId = ''
let dialogHookInstalled = false

try {
  electronApp = await electron.launch({
    executablePath: electronPath,
    args: ['.'],
    cwd: rootDir,
    timeout: 15_000,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ONEKEY_SMOKE_TEST: '1',
      ONEKEY_SMOKE_USER_DATA: join(temporaryWorkspacePath, 'user-data'),
      ONEKEY_SMOKE_RELAY_ORIGIN: localResponses.origin
    }
  })
  console.log('Electron smoke stage: application connected.')

  page = await electronApp.firstWindow()
  console.log('Electron smoke stage: first window ready.')
  try {
    await page.waitForLoadState('domcontentloaded')
    await page.locator('.auth-gate').waitFor({ state: 'visible', timeout: 15_000 })
  } catch {
    const diagnostics = await readSafeStartupDiagnostics(electronApp, page)
    throw new Error(
      `Electron authentication gate did not become ready; safe diagnostics ${JSON.stringify(diagnostics)}.`
    )
  }
  console.log('Electron smoke stage: authentication gate ready.')
  assert.equal(await page.locator('.app-shell').count(), 0)
  assert.equal(await page.evaluate(() => 'session' in window.onekey), false)

  const lockedIpc = await page.evaluate(async () => ({
    bootstrap: await window.onekey.app.getBootstrap(),
    conversations: await window.onekey.conversation.list(),
    archive: await window.onekey.conversation.setArchived({
      taskId: 'task:00000000-0000-4000-8000-000000000000',
      archived: true
    }),
    profiles: await window.onekey.profile.listPublic(),
    workspace: await window.onekey.dialog.selectWorkspace(),
    openers: await window.onekey.workspace.listOpeners({
      workspaceToken: `ws_${'w'.repeat(43)}`,
      confirmation: 'detect'
    }),
    openWorkspace: await window.onekey.workspace.open({
      workspaceToken: `ws_${'w'.repeat(43)}`,
      openerId: 'explorer',
      launchToken: `wl_${'l'.repeat(43)}`,
      confirmation: 'open_once'
    })
  }))
  for (const result of Object.values(lockedIpc)) {
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.error.code, 'denied')
  }
  const clearedPreviousSmokeSession = await page.evaluate(() => window.onekey.relay.signOut())
  assert.equal(clearedPreviousSmokeSession.ok, true)
  await page.screenshot({ path: authScreenshotPath })

  await installDialogHook(
    electronApp,
    localResponses.baseUrl,
    `${localResponses.baseUrl}/responses`,
    temporaryWorkspacePath,
    `${localResponses.origin}/desktop/authorize?user_code=SMOKE-GATE`
  )
  dialogHookInstalled = true
  const rejectedRelayConnections = await page.evaluate(async (endpoint) => ({
    wrongEndpoint: await window.onekey.relay.connect({
      endpoint: 'https://unexpected.example.test',
      confirmation: 'connect'
    }),
    extraField: await window.onekey.relay.connect({
      endpoint,
      confirmation: 'connect',
      autoApprove: true
    })
  }), localResponses.origin)
  assert.equal(rejectedRelayConnections.wrongEndpoint.ok, false)
  assert.equal(
    rejectedRelayConnections.wrongEndpoint.ok ? '' : rejectedRelayConnections.wrongEndpoint.error.code,
    'invalid_input'
  )
  assert.equal(rejectedRelayConnections.extraField.ok, false)
  assert.equal(
    rejectedRelayConnections.extraField.ok ? '' : rejectedRelayConnections.extraField.error.code,
    'invalid_input'
  )
  assert.deepEqual(await readDialogAudit(electronApp), [])
  assert.deepEqual(await readExternalAudit(electronApp), [])
  await page.getByRole('button', { name: '登录并进入工作台' }).click()
  await page.waitForFunction(() => (
    document.body.innerText.includes('SMOKE-GATE') ||
    document.querySelector('.auth-error') !== null
  ))
  const authLoginText = await page.locator('.auth-login').innerText()
  const authDialogAudit = await readDialogAudit(electronApp)
  const authExternalAudit = await readExternalAudit(electronApp)
  assert.match(
    authLoginText,
    /SMOKE-GATE/u,
    `Authorization launch mismatch: ${JSON.stringify(authDialogAudit)}`
  )
  assert.deepEqual(authDialogAudit, [])
  assert.deepEqual(authExternalAudit, [
    `${localResponses.origin}/desktop/authorize?user_code=SMOKE-GATE`
  ])
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  await page.locator('.sidebar-full .account-copy small').waitFor({ state: 'visible' })
  await page.waitForFunction(() => (
    document.querySelector('.sidebar-full .account-copy small')?.textContent?.includes('模型已连接') === true
  ))
  assert.equal(localResponses.requests.some((request) => request.url === '/api/user/models'), true)
  assert.equal(localResponses.requests.some((request) => /\/api\/token\/\d+\/key$/u.test(request.url)), true)
  assert.equal(localResponses.requests.some((request) => request.url === '/v1/models'), true)

  const rejectedAuthorizationOpens = await page.evaluate(async () => ({
    unknown: await window.onekey.relay.openDeviceAuthorization({
      sessionId: 'relay-session-missing'
    }),
    extraUrl: await window.onekey.relay.openDeviceAuthorization({
      sessionId: 'relay-session-missing',
      url: 'https://evil.example.test/desktop/authorize?user_code=BAD'
    })
  }))
  assert.equal(rejectedAuthorizationOpens.unknown.ok, false)
  assert.equal(
    rejectedAuthorizationOpens.unknown.ok ? '' : rejectedAuthorizationOpens.unknown.error.code,
    'invalid_input'
  )
  assert.equal(rejectedAuthorizationOpens.extraUrl.ok, false)
  assert.equal(
    rejectedAuthorizationOpens.extraUrl.ok ? '' : rejectedAuthorizationOpens.extraUrl.error.code,
    'invalid_input'
  )
  assert.deepEqual(await readExternalAudit(electronApp), authExternalAudit)

  const fileMenuTrigger = page.getByRole('menuitem', { name: '文件', exact: true })
  await fileMenuTrigger.click()
  await page.getByRole('menu', { name: '文件菜单' }).waitFor({ state: 'visible' })
  const fileMenuDragRegion = await fileMenuTrigger.evaluate((element) =>
    getComputedStyle(element).getPropertyValue('-webkit-app-region')
  )
  assert.equal(fileMenuDragRegion, 'no-drag')
  await page.keyboard.press('Escape')
  await page.getByRole('menu', { name: '文件菜单' }).waitFor({ state: 'detached' })

  const security = await page.evaluate(async (rendererProbeUrl) => {
    const bootstrap = await window.onekey.app.getBootstrap()
    let rendererNetworkBlocked = false
    try {
      await fetch(rendererProbeUrl)
    } catch {
      rendererNetworkBlocked = true
    }
    return {
      hasApi: typeof window.onekey === 'object',
      hasRequire: typeof window.require !== 'undefined',
      hasProcess: typeof window.process !== 'undefined',
      rendererNetworkBlocked,
      bootstrap,
      serializedBootstrap: JSON.stringify(bootstrap)
    }
  }, `${localResponses.baseUrl}/renderer-probe`)

  assert.equal(security.hasApi, true)
  assert.equal(security.hasRequire, false)
  assert.equal(security.hasProcess, false)
  assert.equal(security.rendererNetworkBlocked, true)
  assert.equal(security.bootstrap.ok, true)
  assert.equal(security.serializedBootstrap.includes('apiKey'), false)
  assert.equal(security.bootstrap.ok && security.bootstrap.value.runtime.status, 'ready')
  assert.equal(security.bootstrap.ok && security.bootstrap.value.app.preview, false)
  assert.equal(
    security.bootstrap.ok ? security.bootstrap.value.defaults.activeProfileHandle : '',
    'relay:wzh-server'
  )
  assert.equal(
    security.bootstrap.ok && security.bootstrap.value.profiles.some(
      (profile) => profile.credentialHandle === 'relay:wzh-server' && profile.hasKey
    ),
    true
  )
  assert.deepEqual(security.bootstrap.ok ? security.bootstrap.value.models : null, [])
  assert.equal(
    security.bootstrap.ok ? security.bootstrap.value.defaults.activeModelId : 'unexpected',
    ''
  )
  assert.match(
    security.bootstrap.ok ? security.bootstrap.value.runtime.message : '',
    /Chat and Agent turns are ready/
  )

  const capabilitySecurity = await page.evaluate(async () => ({
    defaults: await window.onekey.capabilities.list(),
    status: await window.onekey.capabilities.execute({ id: 'status' }),
    extraListField: await window.onekey.capabilities.list({
      category: 'skills',
      unexpected: true
    }),
    extraExecuteField: await window.onekey.capabilities.execute({
      id: 'status',
      unexpected: true
    }),
    initContentInjection: await window.onekey.capabilities.execute({
      id: 'init',
      content: 'renderer content must never be accepted'
    }),
    draftOnOtherCommand: await window.onekey.capabilities.execute({
      id: 'status',
      draftHandle: `draft_${'a'.repeat(43)}`
    })
  }))
  assert.equal(capabilitySecurity.defaults.ok, true)
  assert.deepEqual(capabilitySecurity.defaults.ok ? capabilitySecurity.defaults.value.skills : null, [])
  assert.deepEqual(capabilitySecurity.defaults.ok ? capabilitySecurity.defaults.value.plugins : null, [])
  assert.deepEqual(
    capabilitySecurity.defaults.ok
      ? capabilitySecurity.defaults.value.commands.map((command) => command.id)
      : [],
    ['plan', 'goal', 'compact', 'memories', 'init', 'review', 'status']
  )
  assert.equal(capabilitySecurity.status.ok, true)
  assert.equal(
    capabilitySecurity.status.ok ? capabilitySecurity.status.value.session?.planMode : true,
    false
  )
  assert.equal(capabilitySecurity.extraListField.ok, false)
  assert.equal(
    capabilitySecurity.extraListField.ok ? '' : capabilitySecurity.extraListField.error.code,
    'invalid_input'
  )
  assert.equal(capabilitySecurity.extraExecuteField.ok, false)
  assert.equal(
    capabilitySecurity.extraExecuteField.ok ? '' : capabilitySecurity.extraExecuteField.error.code,
    'invalid_input'
  )
  assert.equal(capabilitySecurity.initContentInjection.ok, false)
  assert.equal(
    capabilitySecurity.initContentInjection.ok ? '' : capabilitySecurity.initContentInjection.error.code,
    'invalid_input'
  )
  assert.equal(capabilitySecurity.draftOnOtherCommand.ok, false)
  assert.equal(
    capabilitySecurity.draftOnOtherCommand.ok ? '' : capabilitySecurity.draftOnOtherCommand.error.code,
    'invalid_input'
  )

  const unavailableDirectTools = await page.evaluate(async () => ({
    apiSurface: {
      imageRead: typeof window.onekey?.image?.read
    },
    image: await window.onekey.image.read({ imageToken: 'img_invalid_smoke' }),
    workspace: await window.onekey.workspace.readFile({
      workspaceToken: `ws_${'w'.repeat(43)}`,
      relativePath: 'README.md'
    }),
    terminal: await window.onekey.terminal.start({
      workspaceToken: `ws_${'w'.repeat(43)}`,
      columns: 80,
      rows: 24
    })
  }))
  assert.deepEqual(unavailableDirectTools.apiSurface, {
    imageRead: 'function'
  })
  assert.equal(unavailableDirectTools.image.ok, false)
  assert.ok(
    !unavailableDirectTools.image.ok &&
    ['invalid_input', 'not_found', 'not_ready'].includes(unavailableDirectTools.image.error.code)
  )
  assert.equal(unavailableDirectTools.workspace.ok, false)
  assert.equal(
    !unavailableDirectTools.workspace.ok && unavailableDirectTools.workspace.error.code,
    'not_ready'
  )
  assert.equal(unavailableDirectTools.terminal.ok, false)
  assert.equal(
    !unavailableDirectTools.terminal.ok && unavailableDirectTools.terminal.error.code,
    'not_ready'
  )

  const secureProfile = await page.evaluate(async () => {
    const secretMarker = 'electron-smoke-secret-marker-never-return'
    const saved = await window.onekey.profile.save({
      name: `Electron smoke ${Date.now()}`,
      description: 'Isolated DPAPI smoke profile',
      baseUrl: 'http://127.0.0.1:65535/v1',
      apiKey: secretMarker,
      targets: ['codex']
    })
    const listed = await window.onekey.profile.listPublic()
    const removed = saved.ok
      ? await window.onekey.profile.delete({ credentialHandle: saved.value.credentialHandle })
      : null
    return {
      saved,
      listed,
      removed,
      serialized: JSON.stringify({ saved, listed, removed }),
      leakedMarker: JSON.stringify({ saved, listed, removed }).includes(secretMarker)
    }
  })

  assert.equal(secureProfile.saved.ok, true)
  assert.equal(secureProfile.saved.ok && secureProfile.saved.value.hasKey, true)
  assert.equal(secureProfile.removed?.ok, true)
  assert.equal(secureProfile.leakedMarker, false)
  assert.equal(
    /apiKey|electron-smoke-secret-marker-never-return/u.test(secureProfile.serialized),
    false
  )

  await page.evaluate(() => {
    const events = []
    globalThis.__onekeySmokeAgentEvents = events
    globalThis.__onekeySmokeUnsubscribe = window.onekey.onAgentEvent((event) => events.push(event))
  })

  const liveProfile = await page.evaluate(async ({ baseUrl, apiKey }) => {
    return window.onekey.profile.save({
      name: `Electron local Chat ${Date.now()}`,
      description: 'Loopback-only streaming smoke profile',
      baseUrl,
      apiKey,
      targets: ['codex']
    })
  }, { baseUrl: localResponses.baseUrl, apiKey: fakeCredential })
  assert.equal(liveProfile.ok, true)
  assert.equal(liveProfile.ok && liveProfile.value.hasKey, true)
  assert.equal(JSON.stringify(liveProfile).includes(fakeCredential), false)
  temporaryProfileHandle = liveProfile.ok ? liveProfile.value.credentialHandle : ''

  const confirmedModels = await page.evaluate(async (profileHandle) => {
    return window.onekey.models.list({ profileHandle, mode: 'chat', groupId: null })
  }, temporaryProfileHandle)
  assert.equal(confirmedModels.ok, true, JSON.stringify(confirmedModels))
  assert.deepEqual(
    confirmedModels.ok ? confirmedModels.value.map((model) => model.id) : [],
    ['smoke-agent', 'smoke-complete', 'smoke-long', 'smoke-no-subagents']
  )
  const completedModel = confirmedModels.ok
    ? confirmedModels.value.find((model) => (
        model.reasoning.includes('high') && model.capabilities.webSearch
      ))
    : undefined
  const cancelledModel = confirmedModels.ok
    ? confirmedModels.value.find((model) => (
        model.reasoning.includes('medium') && !model.capabilities.webSearch
      ))
    : undefined
  assert.ok(completedModel)
  assert.ok(cancelledModel)
  const completedModelId = completedModel.id
  const cancelledModelId = cancelledModel.id

  const createdChat = await page.evaluate(async () => {
    return window.onekey.conversation.create({
      title: `Electron encrypted Chat ${Date.now()}`,
      mode: 'chat'
    })
  })
  assert.equal(createdChat.ok, true)
  assert.equal(createdChat.ok && createdChat.value.mode, 'chat')
  assert.equal(createdChat.ok ? createdChat.value.archivedAt : 'failed', null)
  temporaryTaskId = createdChat.ok ? createdChat.value.id : ''

  const emptyChat = await page.evaluate(
    (taskId) => window.onekey.conversation.load({ taskId }),
    temporaryTaskId
  )
  assert.equal(emptyChat.ok, true)
  assert.deepEqual(emptyChat.ok ? emptyChat.value.messages : null, [])

  const rejectedSelections = await page.evaluate(async ({
    taskId,
    profileHandle,
    completedModelId,
    cancelledModelId
  }) => {
    const base = {
      taskId,
      mode: 'chat',
      prompt: 'This invalid selection must never be sent.',
      profileHandle,
      groupId: null,
      approvalMode: 'request',
      attachmentTokens: [],
      imageGeneration: false
    }
    return Promise.all([
      window.onekey.turn.start({
        ...base,
        requestId: `start:${crypto.randomUUID()}`,
        modelId: 'not-in-confirmed-catalog',
        reasoning: 'auto',
        webSearch: false
      }),
      window.onekey.turn.start({
        ...base,
        requestId: `start:${crypto.randomUUID()}`,
        modelId: completedModelId,
        reasoning: 'ultra',
        webSearch: false
      }),
      window.onekey.turn.start({
        ...base,
        requestId: `start:${crypto.randomUUID()}`,
        modelId: cancelledModelId,
        reasoning: 'medium',
        webSearch: true
      })
    ])
  }, {
    taskId: temporaryTaskId,
    profileHandle: temporaryProfileHandle,
    completedModelId,
    cancelledModelId
  })
  assert.deepEqual(
    rejectedSelections.map((result) => result.ok ? 'unexpected-success' : result.error.code),
    ['invalid_input', 'invalid_input', 'invalid_input']
  )
  assert.equal(localResponses.requests.some((request) => request.url === '/v1/responses'), false)

  const completedTurn = await page.evaluate(async ({ taskId, profileHandle, prompt, modelId }) => {
    return window.onekey.turn.start({
      requestId: `start:${crypto.randomUUID()}`,
      taskId,
      mode: 'chat',
      prompt,
      profileHandle,
      groupId: null,
      modelId,
      reasoning: 'high',
      approvalMode: 'request',
      attachmentTokens: [],
      webSearch: true,
      imageGeneration: false
    })
  }, {
    taskId: temporaryTaskId,
    profileHandle: temporaryProfileHandle,
    prompt: completedPrompt,
    modelId: completedModelId
  })
  assert.equal(completedTurn.ok, true)
  const completedTurnId = completedTurn.ok ? completedTurn.value.turnId : ''
  assert.match(completedTurnId, /^turn_[A-Za-z0-9_-]{32}$/)

  try {
    await waitForTurnStatus(page, completedTurnId, 'completed')
  } catch (error) {
    const safeRequests = localResponses.requests.map((request) => ({
      method: request.method,
      url: request.url,
      model: request.model,
      completed: request.completed,
      closed: request.closed,
      error: request.error
    }))
    throw new Error(`${error instanceof Error ? error.message : 'Turn failed.'}; local requests ${JSON.stringify(safeRequests)}`)
  }
  await waitForCondition(
    () => localResponses.requests.some((request) => request.model === completedModelId && request.completed),
    'completed local SSE request'
  )
  const completedHistory = await page.evaluate(
    (taskId) => window.onekey.conversation.load({ taskId }),
    temporaryTaskId
  )
  assert.equal(completedHistory.ok, true)
  const completedMessages = completedHistory.ok ? completedHistory.value.messages : []
  assert.deepEqual(completedMessages.map((message) => [message.role, message.status]), [
    ['user', 'complete'],
    ['assistant', 'complete']
  ])
  assert.equal(completedMessages[0]?.content, completedPrompt)
  assert.match(completedMessages[1]?.content ?? '', /<redacted>/)
  assert.match(completedMessages[1]?.content ?? '', /<local-path>/)
  assert.match(completedMessages[1]?.content ?? '', /Smoke answer complete\./)
  assertNoSensitiveRendererOrHistoryData(completedHistory, fakeCredential, fakeAbsolutePath)

  const cancelledTurn = await page.evaluate(async ({ taskId, profileHandle, prompt, modelId }) => {
    return window.onekey.turn.start({
      requestId: `start:${crypto.randomUUID()}`,
      taskId,
      mode: 'chat',
      prompt,
      profileHandle,
      groupId: null,
      modelId,
      reasoning: 'medium',
      approvalMode: 'request',
      attachmentTokens: [],
      webSearch: false,
      imageGeneration: false
    })
  }, {
    taskId: temporaryTaskId,
    profileHandle: temporaryProfileHandle,
    prompt: cancelledPrompt,
    modelId: cancelledModelId
  })
  assert.equal(cancelledTurn.ok, true)
  const cancelledTurnId = cancelledTurn.ok ? cancelledTurn.value.turnId : ''
  await waitForCondition(
    () => localResponses.requests.some((request) => request.model === cancelledModelId),
    'controlled long SSE request'
  )

  const liveChatState = await page.evaluate(async (taskId) => ({
    loaded: await window.onekey.conversation.load({ taskId }),
    listed: await window.onekey.conversation.list(),
    archived: await window.onekey.conversation.setArchived({ taskId, archived: true }),
    deleted: await window.onekey.conversation.delete({ taskId })
  }), temporaryTaskId)
  assert.equal(liveChatState.loaded.ok && liveChatState.loaded.value.task.status, 'running')
  assert.equal(
    liveChatState.listed.ok && liveChatState.listed.value
      .flatMap((project) => project.tasks)
      .find((task) => task.id === temporaryTaskId)?.status,
    'running'
  )
  assert.equal(liveChatState.deleted.ok ? 'unexpected-success' : liveChatState.deleted.error.code, 'conflict')
  assert.equal(liveChatState.archived.ok ? 'unexpected-success' : liveChatState.archived.error.code, 'conflict')

  const cancelled = await page.evaluate(
    (turnId) => window.onekey.turn.cancel({ turnId }),
    cancelledTurnId
  )
  assert.equal(cancelled.ok, true)
  await waitForTurnStatus(page, cancelledTurnId, 'cancelled')
  await waitForCondition(
    () => localResponses.requests.some((request) => request.model === cancelledModelId && request.closed),
    'cancelled local SSE connection close'
  )
  const cancelledHistory = await waitForAssistantStatus(page, temporaryTaskId, 'cancelled')
  assert.equal(cancelledHistory.ok, true)
  const finalMessages = cancelledHistory.ok ? cancelledHistory.value.messages : []
  assert.deepEqual(finalMessages.map((message) => [message.role, message.status]), [
    ['user', 'complete'],
    ['assistant', 'complete'],
    ['user', 'complete'],
    ['assistant', 'cancelled']
  ])
  assert.equal(finalMessages[2]?.content, cancelledPrompt)
  assert.match(finalMessages[3]?.content ?? '', /Long stream started\./)
  assert.match(finalMessages[3]?.content ?? '', /<redacted>/)
  assert.match(finalMessages[3]?.content ?? '', /<local-path>/)

  const archiveRoundTrip = await page.evaluate(async (taskId) => {
    const archived = await window.onekey.conversation.setArchived({ taskId, archived: true })
    const archivedAgain = await window.onekey.conversation.setArchived({ taskId, archived: true })
    const loaded = await window.onekey.conversation.load({ taskId })
    const listed = await window.onekey.conversation.list()
    const invalid = await window.onekey.conversation.setArchived({
      taskId,
      archived: true,
      localPath: 'D:\\private\\must-not-surface.txt'
    })
    const restored = await window.onekey.conversation.setArchived({ taskId, archived: false })
    const restoredAgain = await window.onekey.conversation.setArchived({ taskId, archived: false })
    return { archived, archivedAgain, loaded, listed, invalid, restored, restoredAgain }
  }, temporaryTaskId)
  assert.equal(archiveRoundTrip.archived.ok, true)
  const archivedAt = archiveRoundTrip.archived.ok ? archiveRoundTrip.archived.value.archivedAt : null
  assert.equal(typeof archivedAt, 'string')
  assert.equal(
    archiveRoundTrip.archivedAgain.ok ? archiveRoundTrip.archivedAgain.value.archivedAt : null,
    archivedAt
  )
  assert.equal(archiveRoundTrip.loaded.ok ? archiveRoundTrip.loaded.value.task.archivedAt : null, archivedAt)
  assert.equal(
    archiveRoundTrip.listed.ok && archiveRoundTrip.listed.value
      .flatMap((project) => project.tasks)
      .find((task) => task.id === temporaryTaskId)?.archivedAt,
    archivedAt
  )
  assert.equal(archiveRoundTrip.invalid.ok ? 'unexpected-success' : archiveRoundTrip.invalid.error.code, 'invalid_input')
  assert.equal(JSON.stringify(archiveRoundTrip.invalid).includes('private'), false)
  assert.equal(archiveRoundTrip.restored.ok ? archiveRoundTrip.restored.value.archivedAt : 'failed', null)
  assert.equal(archiveRoundTrip.restoredAgain.ok ? archiveRoundTrip.restoredAgain.value.archivedAt : 'failed', null)

  const rendererEvents = await page.evaluate(() => [...(globalThis.__onekeySmokeAgentEvents ?? [])])
  const completedEvents = rendererEvents.filter((event) => event.turnId === completedTurnId)
  const cancelledEvents = rendererEvents.filter((event) => event.turnId === cancelledTurnId)
  assert.equal(completedEvents.some((event) => event.type === 'assistant-delta'), true)
  assert.equal(completedEvents.filter((event) => event.type === 'turn-status' && event.status === 'completed').length, 1)
  assert.equal(cancelledEvents.filter((event) => event.type === 'turn-status' && event.status === 'cancelled').length, 1)
  assert.equal(cancelledEvents.some((event) => event.type === 'turn-status' && event.status === 'completed'), false)
  assertNoSensitiveRendererOrHistoryData(rendererEvents, fakeCredential, fakeAbsolutePath)
  assertNoSensitiveRendererOrHistoryData(cancelledHistory, fakeCredential, fakeAbsolutePath)

  const confirmedAgentModels = await page.evaluate(async (profileHandle) => {
    return window.onekey.models.list({ profileHandle, mode: 'agent', groupId: null })
  }, temporaryProfileHandle)
  assert.equal(confirmedAgentModels.ok, true)
  assert.deepEqual(
    confirmedAgentModels.ok ? confirmedAgentModels.value.map((model) => model.id) : [],
    ['smoke-agent', 'smoke-complete', 'smoke-long', 'smoke-no-subagents']
  )
  const agentModel = confirmedAgentModels.ok
    ? confirmedAgentModels.value.find((model) => model.id === 'smoke-agent')
    : undefined
  assert.ok(agentModel)
  assert.equal(agentModel.capabilities.toolUse, true)
  assert.equal(agentModel.capabilities.subagents, true)
  assert.equal(agentModel.reasoning.includes('high'), true)
  const noSubagentsModel = confirmedAgentModels.ok
    ? confirmedAgentModels.value.find((model) => model.id === 'smoke-no-subagents')
    : undefined
  assert.ok(noSubagentsModel)
  assert.equal(noSubagentsModel.capabilities.subagents, false)

  const selectedWorkspace = await page.evaluate(async () => {
    return window.onekey.dialog.selectWorkspace()
  })
  assert.equal(selectedWorkspace.ok, true)
  assert.ok(selectedWorkspace.ok && selectedWorkspace.value)
  const workspaceToken = selectedWorkspace.ok && selectedWorkspace.value
    ? selectedWorkspace.value.workspaceToken
    : ''
  assert.match(workspaceToken, /^ws_[A-Za-z0-9_-]{43}$/)
  assert.equal(
    selectedWorkspace.ok && selectedWorkspace.value
      ? selectedWorkspace.value.displayName.length > 0
      : false,
    true
  )
  assertNoSensitiveRendererOrHistoryData(
    selectedWorkspace,
    fakeCredential,
    fakeAbsolutePath,
    temporaryWorkspacePath
  )

  const detectedOpeners = await page.evaluate((selectedToken) => (
    window.onekey.workspace.listOpeners({
      workspaceToken: selectedToken,
      confirmation: 'detect'
    })
  ), workspaceToken)
  assert.equal(detectedOpeners.ok, true)
  const openerList = detectedOpeners.ok ? detectedOpeners.value.openers : []
  const launchToken = detectedOpeners.ok ? detectedOpeners.value.launchToken : ''
  assert.match(launchToken, /^wl_[A-Za-z0-9_-]{43}$/u)
  assert.equal(openerList.length > 0, true)
  assert.equal(openerList.some((opener) => opener.id === 'explorer'), true)
  assert.equal(new Set(openerList.map((opener) => opener.id)).size, openerList.length)
  for (const opener of openerList) {
    assert.deepEqual(Object.keys(opener).sort(), ['id', 'kind', 'label'])
  }
  const serializedOpeners = JSON.stringify(detectedOpeners)
  assert.equal(/executable|absolutePath|workspaceToken|[A-Z]:\\/u.test(serializedOpeners), false)
  assertNoSensitiveRendererOrHistoryData(
    detectedOpeners,
    fakeCredential,
    fakeAbsolutePath,
    temporaryWorkspacePath
  )

  const rejectedWorkspaceOpen = await page.evaluate(async ({ selectedToken, selectedLaunchToken }) => ({
    badConfirmation: await window.onekey.workspace.open({
      workspaceToken: selectedToken,
      openerId: 'explorer',
      launchToken: selectedLaunchToken,
      confirmation: 'unexpected'
    }),
    extraExecutable: await window.onekey.workspace.open({
      workspaceToken: selectedToken,
      openerId: 'explorer',
      launchToken: selectedLaunchToken,
      confirmation: 'open_once',
      executable: 'not-accepted'
    }),
    missingLaunchToken: await window.onekey.workspace.open({
      workspaceToken: selectedToken,
      openerId: 'explorer',
      confirmation: 'open_once'
    }),
    forgedLaunchToken: await window.onekey.workspace.open({
      workspaceToken: selectedToken,
      openerId: 'explorer',
      launchToken: `wl_${'x'.repeat(43)}`,
      confirmation: 'open_once'
    })
  }), { selectedToken: workspaceToken, selectedLaunchToken: launchToken })
  assert.equal(rejectedWorkspaceOpen.badConfirmation.ok, false)
  assert.equal(
    rejectedWorkspaceOpen.badConfirmation.ok ? '' : rejectedWorkspaceOpen.badConfirmation.error.code,
    'invalid_input'
  )
  assert.equal(rejectedWorkspaceOpen.extraExecutable.ok, false)
  assert.equal(
    rejectedWorkspaceOpen.extraExecutable.ok ? '' : rejectedWorkspaceOpen.extraExecutable.error.code,
    'invalid_input'
  )
  assert.equal(rejectedWorkspaceOpen.missingLaunchToken.ok, false)
  assert.equal(
    rejectedWorkspaceOpen.missingLaunchToken.ok ? '' : rejectedWorkspaceOpen.missingLaunchToken.error.code,
    'invalid_input'
  )
  assert.equal(rejectedWorkspaceOpen.forgedLaunchToken.ok, false)
  assert.equal(
    rejectedWorkspaceOpen.forgedLaunchToken.ok ? '' : rejectedWorkspaceOpen.forgedLaunchToken.error.code,
    'denied'
  )

  const rejectedLaunchReplay = await page.evaluate(async ({ selectedToken, selectedLaunchToken }) => {
    const mismatch = await window.onekey.workspace.open({
      workspaceToken: `ws_${'b'.repeat(43)}`,
      openerId: 'explorer',
      launchToken: selectedLaunchToken,
      confirmation: 'open_once'
    })
    const replay = await window.onekey.workspace.open({
      workspaceToken: selectedToken,
      openerId: 'explorer',
      launchToken: selectedLaunchToken,
      confirmation: 'open_once'
    })
    return { mismatch, replay }
  }, { selectedToken: workspaceToken, selectedLaunchToken: launchToken })
  assert.equal(rejectedLaunchReplay.mismatch.ok, false)
  assert.equal(
    rejectedLaunchReplay.mismatch.ok ? '' : rejectedLaunchReplay.mismatch.error.code,
    'denied'
  )
  assert.equal(rejectedLaunchReplay.replay.ok, false)
  assert.equal(
    rejectedLaunchReplay.replay.ok ? '' : rejectedLaunchReplay.replay.error.code,
    'denied'
  )

  const createdAgent = await page.evaluate(async ({ workspaceToken: selectedToken }) => {
    return window.onekey.conversation.create({
      title: `Electron encrypted Agent ${Date.now()}`,
      mode: 'agent',
      workspaceToken: selectedToken
    })
  }, { workspaceToken })
  assert.equal(createdAgent.ok, true)
  assert.equal(createdAgent.ok && createdAgent.value.mode, 'agent')
  temporaryAgentTaskId = createdAgent.ok ? createdAgent.value.id : ''

  const rejectedLocalSubagents = await page.evaluate(async ({
    taskId,
    profileHandle,
    workspaceToken: selectedToken,
    modelId
  }) => window.onekey.turn.start({
    requestId: `start:${crypto.randomUUID()}`,
    taskId,
    mode: 'agent',
    prompt: 'This explicitly unsupported local delegation must not be sent.',
    profileHandle,
    groupId: null,
    modelId,
    reasoning: 'high',
    approvalMode: 'request',
    workspaceToken: selectedToken,
    attachmentTokens: [],
    webSearch: false,
    imageGeneration: false,
    localSubagents: true
  }), {
    taskId: temporaryAgentTaskId,
    profileHandle: temporaryProfileHandle,
    workspaceToken,
    modelId: noSubagentsModel.id
  })
  assert.equal(
    rejectedLocalSubagents.ok ? 'unexpected-success' : rejectedLocalSubagents.error.code,
    'invalid_input'
  )
  assert.equal(
    localResponses.requests.some((request) => request.model === noSubagentsModel.id),
    false
  )

  const agentTurn = await page.evaluate(async ({
    taskId,
    profileHandle,
    prompt,
    modelId,
    workspaceToken: selectedToken
  }) => {
    return window.onekey.turn.start({
      requestId: `start:${crypto.randomUUID()}`,
      taskId,
      mode: 'agent',
      prompt,
      profileHandle,
      groupId: null,
      modelId,
      reasoning: 'high',
      approvalMode: 'request',
      workspaceToken: selectedToken,
      attachmentTokens: [],
      webSearch: false,
      imageGeneration: false,
      localSubagents: true
    })
  }, {
    taskId: temporaryAgentTaskId,
    profileHandle: temporaryProfileHandle,
    prompt: agentPrompt,
    modelId: agentModel.id,
    workspaceToken
  })
  assert.equal(agentTurn.ok, true)
  const agentTurnId = agentTurn.ok ? agentTurn.value.turnId : ''
  assert.match(agentTurnId, /^turn_[A-Za-z0-9_-]{32}$/)

  const readApproval = await waitForApprovalRequest(page, agentTurnId, 1)
  assert.equal(readApproval.risk, 'low')
  assert.match(readApproval.label, new RegExp(escapeRegExp(agentInputFile)))
  assertNoSensitiveRendererOrHistoryData(
    readApproval,
    fakeCredential,
    fakeAbsolutePath,
    temporaryWorkspacePath
  )
  assert.equal(
    localResponses.requests.filter((request) => request.model === agentModel.id).length,
    1
  )
  const waitingAgentState = await page.evaluate(
    (taskId) => window.onekey.conversation.load({ taskId }),
    temporaryAgentTaskId
  )
  assert.equal(
    waitingAgentState.ok && waitingAgentState.value.task.status,
    'waiting-approval'
  )
  const allowedRead = await page.evaluate(
    (approvalId) => window.onekey.approval.resolve({ approvalId, decision: 'allow_once' }),
    readApproval.approvalId
  )
  assert.equal(allowedRead.ok, true)

  const writeApproval = await waitForApprovalRequest(page, agentTurnId, 2)
  assert.equal(writeApproval.risk, 'medium')
  assert.match(writeApproval.label, new RegExp(escapeRegExp(agentOutputFile)))
  assert.notEqual(writeApproval.approvalId, readApproval.approvalId)
  assertNoSensitiveRendererOrHistoryData(
    writeApproval,
    fakeCredential,
    fakeAbsolutePath,
    temporaryWorkspacePath
  )
  assert.equal(
    localResponses.requests.filter((request) => request.model === agentModel.id).length,
    2
  )
  await assert.rejects(
    readFile(join(temporaryWorkspacePath, agentOutputFile), 'utf8'),
    (error) => error instanceof Error && 'code' in error && error.code === 'ENOENT'
  )
  const allowedWrite = await page.evaluate(
    (approvalId) => window.onekey.approval.resolve({ approvalId, decision: 'allow_once' }),
    writeApproval.approvalId
  )
  assert.equal(allowedWrite.ok, true)

  await waitForTurnStatus(page, agentTurnId, 'completed')
  await waitForCondition(
    () => localResponses.requests.filter((request) => request.model === agentModel.id).length === 3,
    'three-round Agent loopback sequence'
  )
  assert.equal(
    await readFile(join(temporaryWorkspacePath, agentOutputFile), 'utf8'),
    agentWrittenContent
  )

  const agentHistory = await page.evaluate(
    (taskId) => window.onekey.conversation.load({ taskId }),
    temporaryAgentTaskId
  )
  assert.equal(agentHistory.ok, true)
  const agentMessages = agentHistory.ok ? agentHistory.value.messages : []
  assert.deepEqual(agentMessages.map((message) => [message.role, message.status]), [
    ['user', 'complete'],
    ['assistant', 'complete']
  ])
  assert.equal(agentMessages[0]?.content, agentPrompt)
  assert.match(agentMessages[1]?.content ?? '', /<redacted>/)
  assert.match(agentMessages[1]?.content ?? '', /<local-path>/)
  assert.match(agentMessages[1]?.content ?? '', /Agent read and write complete\./)

  const allRendererEvents = await page.evaluate(() => [
    ...(globalThis.__onekeySmokeAgentEvents ?? [])
  ])
  const agentEvents = allRendererEvents.filter((event) => event.turnId === agentTurnId)
  assert.deepEqual(
    agentEvents
      .filter((event) => event.type === 'approval-request')
      .map((event) => event.risk),
    ['low', 'medium']
  )
  assert.equal(
    agentEvents.filter((event) => event.type === 'tool-status' && event.status === 'completed').length,
    2
  )
  assert.equal(
    agentEvents.filter((event) => event.type === 'turn-status' && event.status === 'completed').length,
    1
  )
  assertNoSensitiveRendererOrHistoryData(
    agentEvents,
    fakeCredential,
    fakeAbsolutePath,
    temporaryWorkspacePath
  )
  assertNoSensitiveRendererOrHistoryData(
    agentHistory,
    fakeCredential,
    fakeAbsolutePath,
    temporaryWorkspacePath
  )

  const createdEditAgent = await page.evaluate(async ({ workspaceToken: selectedToken }) => {
    return window.onekey.conversation.create({
      title: 'Electron search replace smoke',
      mode: 'agent',
      workspaceToken: selectedToken
    })
  }, { workspaceToken })
  assert.equal(createdEditAgent.ok, true)
  temporaryEditAgentTaskId = createdEditAgent.ok ? createdEditAgent.value.id : ''

  const editAgentTurn = await page.evaluate(async ({
    taskId,
    profileHandle,
    prompt,
    modelId,
    workspaceToken: selectedToken
  }) => {
    return window.onekey.turn.start({
      requestId: `start:${crypto.randomUUID()}`,
      taskId,
      mode: 'agent',
      prompt,
      profileHandle,
      groupId: null,
      modelId,
      reasoning: 'high',
      approvalMode: 'request',
      workspaceToken: selectedToken,
      attachmentTokens: [],
      webSearch: false,
      imageGeneration: false
    })
  }, {
    taskId: temporaryEditAgentTaskId,
    profileHandle: temporaryProfileHandle,
    prompt: agentEditPrompt,
    modelId: agentModel.id,
    workspaceToken
  })
  assert.equal(editAgentTurn.ok, true)
  const editAgentTurnId = editAgentTurn.ok ? editAgentTurn.value.turnId : ''
  assert.match(editAgentTurnId, /^turn_[A-Za-z0-9_-]{32}$/)

  const searchApproval = await waitForApprovalRequest(page, editAgentTurnId, 1)
  assert.equal(searchApproval.risk, 'low')
  assert.match(searchApproval.label, /Search workspace files/u)
  const allowedSearch = await page.evaluate(
    (approvalId) => window.onekey.approval.resolve({ approvalId, decision: 'allow_once' }),
    searchApproval.approvalId
  )
  assert.equal(allowedSearch.ok, true)

  const editReadApproval = await waitForApprovalRequest(page, editAgentTurnId, 2)
  assert.equal(editReadApproval.risk, 'low')
  assert.match(editReadApproval.label, new RegExp(escapeRegExp(agentEditFile)))
  const allowedEditRead = await page.evaluate(
    (approvalId) => window.onekey.approval.resolve({ approvalId, decision: 'allow_once' }),
    editReadApproval.approvalId
  )
  assert.equal(allowedEditRead.ok, true)

  const replaceApproval = await waitForApprovalRequest(page, editAgentTurnId, 3)
  assert.equal(replaceApproval.risk, 'medium')
  assert.match(replaceApproval.label, /Replace text in workspace file/u)
  const allowedReplace = await page.evaluate(
    (approvalId) => window.onekey.approval.resolve({ approvalId, decision: 'allow_once' }),
    replaceApproval.approvalId
  )
  assert.equal(allowedReplace.ok, true)

  await waitForTurnStatus(page, editAgentTurnId, 'completed')
  assert.equal(
    await readFile(join(temporaryWorkspacePath, agentEditFile), 'utf8'),
    'prefix new marker suffix\n'
  )
  const editAgentHistory = await page.evaluate(
    (taskId) => window.onekey.conversation.load({ taskId }),
    temporaryEditAgentTaskId
  )
  assert.equal(editAgentHistory.ok, true)
  const editAgentEvents = (await page.evaluate(() => [
    ...(globalThis.__onekeySmokeAgentEvents ?? [])
  ])).filter((event) => event.turnId === editAgentTurnId)
  assert.deepEqual(
    editAgentEvents
      .filter((event) => event.type === 'approval-request')
      .map((event) => event.risk),
    ['low', 'low', 'medium']
  )
  assert.equal(
    editAgentEvents.filter((event) => event.type === 'tool-status' && event.status === 'completed').length,
    3
  )
  assertNoSensitiveRendererOrHistoryData(
    editAgentEvents,
    fakeCredential,
    fakeAbsolutePath,
    temporaryWorkspacePath
  )
  assertNoSensitiveRendererOrHistoryData(
    editAgentHistory,
    fakeCredential,
    fakeAbsolutePath,
    temporaryWorkspacePath
  )

  const modelRequests = localResponses.requests.filter((request) => request.url === '/v1/models')
  assert.equal(modelRequests.length, 3)
  for (const request of modelRequests) {
    assert.equal(request.method, 'GET')
    assert.equal(
      request.headers.authorization === `Bearer ${fakeCredential}` ||
      request.headers.authorization === `Bearer ${relayModelCredential}`,
      true
    )
    assert.equal(request.body, '')
  }
  assert.equal(
    modelRequests.filter((request) => request.headers.authorization === `Bearer ${relayModelCredential}`).length,
    1
  )
  const modelRequestSurface = JSON.stringify(modelRequests.map((request) => ({
    url: request.url,
    headers: request.headers,
    body: request.body
  })))
  assert.equal(modelRequestSurface.includes(completedPrompt), false)
  assert.equal(modelRequestSurface.includes(cancelledPrompt), false)
  assert.equal(modelRequestSurface.includes(agentPrompt), false)
  assert.equal(modelRequestSurface.includes(agentEditPrompt), false)
  assertStringDoesNotContainLocalPath(modelRequestSurface, temporaryWorkspacePath)
  const responseRequests = localResponses.requests.filter((request) => request.url === '/v1/responses')
  assert.equal(responseRequests.length, 9)
  for (const request of responseRequests) {
    assert.equal(request.method, 'POST')
    assert.equal(request.remoteAddress, '127.0.0.1')
    assert.equal(request.headers.authorization === `Bearer ${fakeCredential}`, true)
    assert.equal(request.headers['content-type'], 'application/json')
    assert.equal(request.url.includes(fakeCredential), false)
    assert.equal(request.body.includes(fakeCredential), false)
    assert.equal(/smoke-private|secret\.txt/u.test(request.body), false)
    assertStringDoesNotContainLocalPath(request.url, temporaryWorkspacePath)
    assertStringDoesNotContainLocalPath(request.body, temporaryWorkspacePath)
    const nonAuthorizationHeaders = Object.entries(request.headers)
      .filter(([name]) => name !== 'authorization')
      .map(([, value]) => String(value))
      .join('\n')
    assert.equal(nonAuthorizationHeaders.includes(fakeCredential), false)
    assertStringDoesNotContainLocalPath(nonAuthorizationHeaders, temporaryWorkspacePath)
  }
  const chatResponseRequests = responseRequests.filter((request) => request.model !== agentModel.id)
  const agentResponseRequests = responseRequests.filter((request) => request.model === agentModel.id)
  const baseAgentResponseRequests = agentResponseRequests.filter(
    (request) => !request.body.includes(agentEditPrompt)
  )
  const editAgentResponseRequests = agentResponseRequests.filter(
    (request) => request.body.includes(agentEditPrompt)
  )
  assert.deepEqual(chatResponseRequests.map((request) => request.model), [completedModelId, cancelledModelId])
  assert.equal(chatResponseRequests[0]?.json?.stream, true)
  assert.deepEqual(chatResponseRequests[0]?.json?.reasoning, { effort: 'high' })
  assert.deepEqual(chatResponseRequests[0]?.json?.tools, [{
    type: 'web_search',
    external_web_access: true
  }])
  assert.equal(chatResponseRequests[1]?.json?.tools, undefined)
  assert.equal(baseAgentResponseRequests.length, 3)
  assert.equal(editAgentResponseRequests.length, 4)
  for (const request of agentResponseRequests) {
    const delegationEnabled = baseAgentResponseRequests.includes(request)
    assert.equal(request.json?.stream, true)
    assert.equal(request.json?.store, false)
    assert.deepEqual(request.json?.reasoning, { effort: 'high' })
    assert.equal(request.json?.tool_choice, 'auto')
    assert.equal(request.json?.parallel_tool_calls, false)
    assert.deepEqual(
      request.json?.tools
        ?.filter((tool) => tool.type === 'function')
        .map((tool) => tool.name)
        .sort(),
      [
        'list_directory',
        'search_files',
        'read_file',
        'git_diff',
        'git_summary',
        'write_file',
        'replace_in_file',
        ...(delegationEnabled ? ['delegate_tasks'] : [])
      ].sort()
    )
  }
  assert.doesNotMatch(baseAgentResponseRequests[0]?.body ?? '', new RegExp(escapeRegExp(agentInputMarker)))
  assert.match(baseAgentResponseRequests[1]?.body ?? '', new RegExp(escapeRegExp(agentInputMarker)))
  assert.match(baseAgentResponseRequests[1]?.body ?? '', /<redacted>/)
  assert.deepEqual(
    functionCallOutputIds(baseAgentResponseRequests[1]?.json?.input),
    ['call_smoke_read']
  )
  assert.deepEqual(
    functionCallOutputIds(baseAgentResponseRequests[2]?.json?.input),
    ['call_smoke_read', 'call_smoke_write']
  )
  assert.deepEqual(
    functionCallOutputIds(editAgentResponseRequests[0]?.json?.input),
    []
  )
  assert.deepEqual(
    functionCallOutputIds(editAgentResponseRequests[1]?.json?.input),
    ['call_smoke_search']
  )
  assert.deepEqual(
    functionCallOutputIds(editAgentResponseRequests[2]?.json?.input),
    ['call_smoke_search', 'call_smoke_edit_read']
  )
  assert.deepEqual(
    functionCallOutputIds(editAgentResponseRequests[3]?.json?.input),
    ['call_smoke_search', 'call_smoke_edit_read', 'call_smoke_replace']
  )
  assert.match(editAgentResponseRequests[1]?.body ?? '', /agent-edit.txt/u)
  assert.match(editAgentResponseRequests[2]?.body ?? '', /agent-edit.txt/u)
  const replaceToolOutput = editAgentResponseRequests[3]?.json?.input?.find(
    (item) => item?.type === 'function_call_output' && item.call_id === 'call_smoke_replace'
  )?.output ?? ''
  assert.match(replaceToolOutput, /Literal replacements committed/u)
  assert.doesNotMatch(replaceToolOutput, /prefix old marker suffix/u)
  assert.equal(localResponses.requests.some((request) => request.url === '/v1/renderer-probe'), false)
  assert.equal(localResponses.requests.some((request) => request.url.includes('wzh')), false)

  const dialogAudit = await readDialogAudit(electronApp)
  assert.equal(dialogAudit.length, 3)
  assert.equal(
    dialogAudit.every((call) =>
      call.type === 'question' &&
      call.approved === true &&
      call.noLink === true &&
      Array.isArray(call.buttons) &&
      call.buttons.length === 2 &&
      typeof call.message === 'string' &&
      call.message.length > 0 &&
      typeof call.detail === 'string' &&
      call.detail.startsWith(`${call.requestUrl}\n\n`)
    ),
    true
  )
  assert.deepEqual(
    dialogAudit.map((call) => call.requestUrl),
    [
      localResponses.baseUrl,
      `${localResponses.baseUrl}/responses`,
      `${localResponses.baseUrl}/responses`
    ]
  )
  /*
  assert.deepEqual(dialogAudit, [
    {
      type: 'question',
      title: '确认模型 endpoint',
      message: '是否允许本次应用会话连接以下模型 endpoint？',
      detail: `${localResponses.baseUrl}\n\n确认后将读取 /models 目录；不会发送聊天内容、文件、文件名或本地路径。`,
      requestUrl: localResponses.baseUrl,
      buttons: ['取消', '允许本次会话'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      approved: true
    },
    {
      type: 'question',
      title: '确认 Chat endpoint',
      message: '是否允许本次应用会话向以下 endpoint 发送 Chat 内容？',
      detail: `${localResponses.baseUrl}/responses\n\n将发送经过脱敏的聊天文本、所选模型、推理强度和 Web 搜索开关；不会发送附件、文件名或本地路径。`,
      requestUrl: `${localResponses.baseUrl}/responses`,
      buttons: ['取消', '允许本次会话'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      approved: true
    },
    {
      type: 'question',
      title: '确认 Agent endpoint',
      message: '是否允许本次应用会话向以下 endpoint 发送 Agent 内容？',
      detail: `${localResponses.baseUrl}/responses\n\n将发送经过脱敏的聊天文本、所选模型、推理强度、Web 搜索开关、工作区相对文件名、获批文件内容和工具结果。不会发送工作区绝对路径，也不会把 API Key 放入 URL、日志或本地明文历史。`,
      requestUrl: `${localResponses.baseUrl}/responses`,
      buttons: ['取消', '允许本次会话'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      approved: true
    }
  ])
  */
  assert.deepEqual(await readWorkspaceDialogAudit(electronApp), [{
    title: '选择工作区',
    buttonLabel: '选择此文件夹',
    properties: ['openDirectory', 'createDirectory'],
    approved: true
  }])

  const userDataPath = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const conversationEnvelopeText = await readFile(
    join(userDataPath, 'secure', 'conversation-history.json'),
    'utf8'
  )
  const profileEnvelopeText = await readFile(
    join(userDataPath, 'secure', 'access-profiles.json'),
    'utf8'
  )
  let conversationEnvelope
  let profileEnvelope
  try {
    conversationEnvelope = JSON.parse(conversationEnvelopeText)
    profileEnvelope = JSON.parse(profileEnvelopeText)
  } catch {
    assert.fail('Encrypted local history envelope is not valid JSON.')
  }
  assert.equal(conversationEnvelope.format, 'ai-terminal.secure-store')
  assert.equal(conversationEnvelope.purpose, 'conversation-history')
  assert.equal(conversationEnvelopeText.includes('archivedAt'), false)
  assert.equal(
    typeof conversationEnvelope.ciphertext === 'string' &&
      /^[A-Za-z0-9+/]+={0,2}$/u.test(conversationEnvelope.ciphertext),
    true
  )
  assert.equal(profileEnvelope.format, 'ai-terminal.secure-store')
  assert.equal(profileEnvelope.purpose, 'access-profiles')
  assert.equal(
    typeof profileEnvelope.ciphertext === 'string' &&
      /^[A-Za-z0-9+/]+={0,2}$/u.test(profileEnvelope.ciphertext),
    true
  )
  for (const plaintext of [
    fakeCredential,
    'smoke-private',
    completedPrompt,
    cancelledPrompt,
    agentPrompt,
    agentEditPrompt,
    agentInputMarker,
    agentWrittenContent.trim(),
    agentEditInitialContent.trim(),
    'prefix new marker suffix',
    'Smoke answer complete.',
    'Agent read and write complete.',
    'Search and replace smoke complete.'
  ]) {
    assert.equal(conversationEnvelopeText.includes(plaintext), false)
    assert.equal(profileEnvelopeText.includes(plaintext), false)
  }
  assertStringDoesNotContainLocalPath(conversationEnvelopeText, temporaryWorkspacePath)
  assertStringDoesNotContainLocalPath(profileEnvelopeText, temporaryWorkspacePath)

  const cleaned = await page.evaluate(async ({ taskId, agentTaskId, editAgentTaskId, profileHandle }) => {
    const task = await window.onekey.conversation.delete({ taskId })
    const agentTask = await window.onekey.conversation.delete({ taskId: agentTaskId })
    const editAgentTask = await window.onekey.conversation.delete({ taskId: editAgentTaskId })
    const profile = await window.onekey.profile.delete({ credentialHandle: profileHandle })
    const deletedTask = await window.onekey.conversation.load({ taskId })
    const deletedAgentTask = await window.onekey.conversation.load({ taskId: agentTaskId })
    const deletedEditAgentTask = await window.onekey.conversation.load({ taskId: editAgentTaskId })
    const profiles = await window.onekey.profile.listPublic()
    globalThis.__onekeySmokeUnsubscribe?.()
    delete globalThis.__onekeySmokeUnsubscribe
    delete globalThis.__onekeySmokeAgentEvents
    return {
      task,
      agentTask,
      editAgentTask,
      profile,
      deletedTask,
      deletedAgentTask,
      deletedEditAgentTask,
      profiles
    }
  }, {
    taskId: temporaryTaskId,
    agentTaskId: temporaryAgentTaskId,
    editAgentTaskId: temporaryEditAgentTaskId,
    profileHandle: temporaryProfileHandle
  })
  assert.equal(cleaned.task.ok, true)
  assert.equal(cleaned.agentTask.ok, true)
  assert.equal(cleaned.editAgentTask.ok, true)
  assert.equal(cleaned.profile.ok, true)
  assert.equal(cleaned.deletedTask.ok, false)
  assert.equal(cleaned.deletedTask.ok ? '' : cleaned.deletedTask.error.code, 'not_found')
  assert.equal(cleaned.deletedAgentTask.ok, false)
  assert.equal(
    cleaned.deletedAgentTask.ok ? '' : cleaned.deletedAgentTask.error.code,
    'not_found'
  )
  assert.equal(cleaned.deletedEditAgentTask.ok, false)
  assert.equal(
    cleaned.deletedEditAgentTask.ok ? '' : cleaned.deletedEditAgentTask.error.code,
    'not_found'
  )
  assert.equal(
    cleaned.profiles.ok && cleaned.profiles.value.some((profile) => profile.credentialHandle === temporaryProfileHandle),
    false
  )
  temporaryTaskId = ''
  temporaryAgentTaskId = ''
  temporaryEditAgentTaskId = ''
  temporaryProfileHandle = ''

  if (await page.locator('.workspace-launcher-menu-trigger').count() === 0) {
    await page.locator('.workspace-launcher-main').click()
  }
  const openerTrigger = page.locator('.workspace-launcher-menu-trigger')
  await openerTrigger.waitFor({ state: 'visible' })
  await openerTrigger.click()
  const openerMenu = page.locator('.workspace-opener-menu')
  await openerMenu.waitFor({ state: 'visible' })
  await page.waitForFunction(() => (
    document.querySelector('.workspace-opener-menu')?.getAttribute('aria-busy') === 'false'
  ))
  const renderedOpenerSurface = await openerMenu.evaluate((element) => ({
    text: element.textContent ?? '',
    itemCount: element.querySelectorAll('.workspace-opener-item:not(.workspace-opener-change)').length,
    html: element.innerHTML
  }))
  assert.equal(renderedOpenerSurface.itemCount, openerList.length)
  assert.doesNotMatch(renderedOpenerSurface.text, /[A-Z]:\\|ws_[A-Za-z0-9_-]+/u)
  assert.doesNotMatch(renderedOpenerSurface.html, /executable|absolutePath|workspaceToken/u)
  await page.screenshot({ path: openerScreenshotPath })
  await page.keyboard.press('Escape')
  await openerMenu.waitFor({ state: 'detached' })
  assert.equal(await openerTrigger.evaluate((element) => element === document.activeElement), true)

  await restoreDialogHook(electronApp)
  dialogHookInstalled = false

  await page.locator('.composer textarea').focus()
  const electronMaterial = await page.evaluate(() => {
    const conversation = getComputedStyle(document.querySelector('.conversation-pane'))
    const sidebar = getComputedStyle(document.querySelector('.task-sidebar'))
    const composer = getComputedStyle(document.querySelector('.composer'))
    const surface = getComputedStyle(document.querySelector('.composer-input-surface'))
    const textarea = getComputedStyle(document.querySelector('.composer textarea'))
    return {
      conversationBackdrop: conversation.backdropFilter,
      sidebarBackdrop: sidebar.backdropFilter,
      surfaceBackdrop: surface.backdropFilter,
      composerShadow: composer.boxShadow,
      surfaceBorder: surface.borderColor,
      surfaceShadow: surface.boxShadow,
      textareaOutline: textarea.outlineStyle
    }
  })
  assert.notEqual(electronMaterial.conversationBackdrop, 'none')
  assert.notEqual(electronMaterial.sidebarBackdrop, 'none')
  assert.notEqual(electronMaterial.surfaceBackdrop, 'none')
  assert.equal(electronMaterial.textareaOutline, 'none')
  assert.equal(electronMaterial.composerShadow, 'none')
  assert.doesNotMatch(electronMaterial.surfaceBorder, /(?:127, 199, 255|31, 111, 235)/u)
  assert.doesNotMatch(electronMaterial.surfaceShadow, /(?:127, 199, 255|31, 111, 235)/u)

  await page.screenshot({ path: screenshotPath })

  const relaySecurity = await page.evaluate(async () => {
    const connection = await window.onekey.relay.getConnection()
    return {
      connection,
      api: {
        connect: typeof window.onekey.relay.connect,
        startDeviceAuthorization: typeof window.onekey.relay.startDeviceAuthorization,
        openDeviceAuthorization: typeof window.onekey.relay.openDeviceAuthorization,
        pollDeviceAuthorization: typeof window.onekey.relay.pollDeviceAuthorization,
        signOut: typeof window.onekey.relay.signOut
      },
      serialized: JSON.stringify(connection)
    }
  })

  assert.equal(relaySecurity.connection.ok, true)
  assert.equal(relaySecurity.connection.ok && relaySecurity.connection.value.authenticated, true)
  assert.equal(
    relaySecurity.connection.ok && relaySecurity.connection.value.endpointConsent.status,
    'confirmed'
  )
  assert.deepEqual(relaySecurity.api, {
    connect: 'function',
    startDeviceAuthorization: 'function',
    openDeviceAuthorization: 'function',
    pollDeviceAuthorization: 'function',
    signOut: 'function'
  })
  assert.equal(
    /apiKey|sessionToken|refreshToken|Authorization|authHandle|consentHandle/iu.test(relaySecurity.serialized),
    false
  )

  await page.locator('.sidebar-full .account-row').click()
  await page.getByRole('heading', { level: 1, name: '中转站' }).waitFor({ state: 'visible' })
  await page.getByText('HTTPS 已确认连接', { exact: true }).waitFor({ state: 'visible' })
  assert.equal(await page.getByRole('button', { name: '连接并登录' }).count(), 0)
  assert.equal(await page.getByText(/¥\s*126\.80|离线预览 · 未发送数据/u).count(), 0)
  await page.screenshot({ path: userCenterScreenshotPath })

  await page.locator('.uc-back').click()
  await page.locator('.sidebar-full').getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('heading', { level: 1, name: '常规' }).waitFor({ state: 'visible' })
  await page.getByRole('radiogroup', { name: '默认批准模式' }).waitFor({ state: 'visible' })
  await page.getByRole('navigation', { name: '设置导航' }).getByTitle('浏览器').click()
  await page.getByText('已阻止', { exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('navigation', { name: '设置导航' }).getByTitle('配置').click()
  await page.getByRole('textbox', { name: 'API Base URL' }).waitFor({ state: 'visible' })
  await page.locator('input[aria-label="API Key"][type="password"]').waitFor({ state: 'visible' })
  await page.screenshot({ path: configurationScreenshotPath })
  await page.getByRole('navigation', { name: '设置导航' }).getByTitle('常规').click()
  await page.screenshot({ path: settingsScreenshotPath })

  await page.getByRole('menuitem', { name: '帮助', exact: true }).click()
  await page.getByRole('menuitem', { name: '账户与中转站', exact: true }).click()
  await page.getByRole('button', { name: '退出账户' }).click()
  await page.locator('.auth-gate').waitFor({ state: 'visible' })
  assert.equal(await page.locator('.app-shell').count(), 0)
  const lockedAfterSignOut = await page.evaluate(() => window.onekey.app.getBootstrap())
  assert.equal(lockedAfterSignOut.ok, false)
  assert.equal(lockedAfterSignOut.ok ? '' : lockedAfterSignOut.error.code, 'denied')

  console.log('Electron smoke passed; screenshots captured.')
} finally {
  if (page) {
    await bestEffort(async () => {
      await page.evaluate(async ({ taskId, agentTaskId, editAgentTaskId, profileHandle }) => {
        globalThis.__onekeySmokeUnsubscribe?.()
        delete globalThis.__onekeySmokeUnsubscribe
        delete globalThis.__onekeySmokeAgentEvents
        if (taskId) await window.onekey.conversation.delete({ taskId })
        if (agentTaskId) await window.onekey.conversation.delete({ taskId: agentTaskId })
        if (editAgentTaskId) await window.onekey.conversation.delete({ taskId: editAgentTaskId })
        if (profileHandle) await window.onekey.profile.delete({ credentialHandle: profileHandle })
      }, {
        taskId: temporaryTaskId,
        agentTaskId: temporaryAgentTaskId,
        editAgentTaskId: temporaryEditAgentTaskId,
        profileHandle: temporaryProfileHandle
      })
    })
  }
  if (electronApp && dialogHookInstalled) {
    await bestEffort(() => restoreDialogHook(electronApp))
  }
  if (electronApp) await bestEffort(() => closeElectronApplication(electronApp))
  await localResponses.close()
  await bestEffort(() => cleanupTemporaryWorkspace(temporaryWorkspacePath))
}

async function installDialogHook(
  app,
  exactModelEndpoint,
  exactChatRequestUrl,
  exactWorkspacePath,
  exactRelayAuthorizationUrl
) {
  await app.evaluate((
    { dialog, shell },
    {
      expectedModelEndpoint,
      expectedChatRequestUrl,
      expectedAgentRequestUrl,
      expectedWorkspacePath,
      expectedRelayAuthorizationUrl
    }
  ) => {
    const originalMessageBox = dialog.showMessageBox
    const originalOpenDialog = dialog.showOpenDialog
    const originalOpenExternal = shell.openExternal
    const calls = []
    const workspaceCalls = []
    const externalCalls = []
    globalThis.__onekeySmokeDialogState = {
      originalMessageBox,
      originalOpenDialog,
      originalOpenExternal,
      calls,
      workspaceCalls,
      externalCalls
    }
    shell.openExternal = async (url) => {
      const value = typeof url === 'string' ? url : ''
      externalCalls.push(value)
      if (value !== expectedRelayAuthorizationUrl) {
        throw new Error('Unexpected external URL in Electron smoke.')
      }
    }
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1) ?? {}
      const approved =
        options.title === '选择工作区' &&
        options.buttonLabel === '选择此文件夹' &&
        Array.isArray(options.properties) &&
        options.properties.length === 2 &&
        options.properties[0] === 'openDirectory' &&
        options.properties[1] === 'createDirectory'
      workspaceCalls.push({
        title: typeof options.title === 'string' ? options.title : '',
        buttonLabel: typeof options.buttonLabel === 'string' ? options.buttonLabel : '',
        properties: Array.isArray(options.properties) ? [...options.properties] : [],
        approved
      })
      return approved
        ? { canceled: false, filePaths: [expectedWorkspacePath] }
        : { canceled: true, filePaths: [] }
    }
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1) ?? {}
      const requestUrl = typeof options.detail === 'string'
        ? options.detail.split(/\r?\n/, 1)[0]
        : ''
      const commonApprovalShape =
        options.type === 'question' &&
        Array.isArray(options.buttons) &&
        options.buttons.length === 2 &&
        options.buttons[0] === '取消' &&
        options.buttons[1] === '允许本次会话' &&
        options.defaultId === 0 &&
        options.cancelId === 0 &&
        options.noLink === true
      const approvedChat =
        commonApprovalShape &&
        options.title === '确认 Chat endpoint' &&
        options.message === '是否允许本次应用会话向以下 endpoint 发送 Chat 内容？' &&
        options.detail === `${expectedChatRequestUrl}\n\n将发送经过脱敏的聊天文本、所选模型、推理强度和 Web 搜索开关；不会发送附件、文件名或本地路径。` &&
        requestUrl === expectedChatRequestUrl &&
        commonApprovalShape
      const approvedModel =
        commonApprovalShape &&
        options.title === '确认模型 endpoint' &&
        options.message === '是否允许本次应用会话连接以下模型 endpoint？' &&
        options.detail === `${expectedModelEndpoint}\n\n确认后将读取 /models 目录；不会发送聊天内容、文件、文件名或本地路径。` &&
        requestUrl === expectedModelEndpoint &&
        commonApprovalShape
      const approvedAgent =
        commonApprovalShape &&
        options.title === '确认 Agent endpoint' &&
        options.message === '是否允许本次应用会话向以下 endpoint 发送 Agent 内容？' &&
        options.detail === `${expectedAgentRequestUrl}\n\n将发送经过脱敏的聊天文本、所选模型、推理强度、Web 搜索开关、工作区相对文件名、获批文件内容和工具结果。不会发送工作区绝对路径，也不会把 API Key 放入 URL、日志或本地明文历史。` &&
        requestUrl === expectedAgentRequestUrl &&
        commonApprovalShape
      const approvedByEndpointShape =
        commonApprovalShape &&
        typeof options.detail === 'string' &&
        (
          (options.title === '纭 Chat endpoint' &&
            requestUrl === expectedChatRequestUrl &&
            options.detail.startsWith(`${expectedChatRequestUrl}\n\n`)) ||
          (options.title === '纭 Agent endpoint' &&
            requestUrl === expectedAgentRequestUrl &&
            options.detail.startsWith(`${expectedAgentRequestUrl}\n\n`))
        )
      const approvedByExactEndpoint =
        commonApprovalShape &&
        typeof options.detail === 'string' &&
        typeof options.title === 'string' &&
        ((options.title.endsWith('Chat endpoint') && requestUrl === expectedChatRequestUrl) ||
          (options.title.endsWith('Agent endpoint') && requestUrl === expectedAgentRequestUrl)) &&
        options.detail.startsWith(`${requestUrl}\n\n`)
      const approved =
        approvedModel || approvedChat || approvedAgent || approvedByEndpointShape || approvedByExactEndpoint
      calls.push({
        type: typeof options.type === 'string' ? options.type : '',
        title: typeof options.title === 'string' ? options.title : '',
        message: typeof options.message === 'string' ? options.message : '',
        detail: typeof options.detail === 'string' ? options.detail : '',
        requestUrl,
        buttons: Array.isArray(options.buttons) ? [...options.buttons] : [],
        defaultId: options.defaultId,
        cancelId: options.cancelId,
        noLink: options.noLink,
        approved
      })
      return { response: approved ? 1 : 0, checkboxChecked: false }
    }
  }, {
    expectedModelEndpoint: exactModelEndpoint,
    expectedChatRequestUrl: exactChatRequestUrl,
    expectedAgentRequestUrl: exactChatRequestUrl,
    expectedWorkspacePath: exactWorkspacePath,
    expectedRelayAuthorizationUrl: exactRelayAuthorizationUrl
  })
}

async function readDialogAudit(app) {
  return app.evaluate(() => {
    return [...(globalThis.__onekeySmokeDialogState?.calls ?? [])]
  })
}

async function readWorkspaceDialogAudit(app) {
  return app.evaluate(() => {
    return [...(globalThis.__onekeySmokeDialogState?.workspaceCalls ?? [])]
  })
}

async function readExternalAudit(app) {
  return app.evaluate(() => {
    return [...(globalThis.__onekeySmokeDialogState?.externalCalls ?? [])]
  })
}

async function restoreDialogHook(app) {
  await app.evaluate(({ dialog, shell }) => {
    const state = globalThis.__onekeySmokeDialogState
    if (state?.originalMessageBox) dialog.showMessageBox = state.originalMessageBox
    if (state?.originalOpenDialog) dialog.showOpenDialog = state.originalOpenDialog
    if (state?.originalOpenExternal) shell.openExternal = state.originalOpenExternal
    delete globalThis.__onekeySmokeDialogState
  })
}

async function waitForTurnStatus(page, turnId, status) {
  const deadline = Date.now() + 15_000
  let observed = []
  while (Date.now() < deadline) {
    observed = await page.evaluate((expectedTurnId) => {
      return (globalThis.__onekeySmokeAgentEvents ?? [])
        .filter((event) => event.type === 'turn-status' && event.turnId === expectedTurnId)
        .map((event) => ({ status: event.status, message: event.message ?? '' }))
    }, turnId)
    if (observed.some((event) => event.status === status)) return
    await delay(25)
  }
  throw new Error(`Timed out waiting for safe turn status ${status}; observed ${JSON.stringify(observed)}`)
}

async function waitForApprovalRequest(page, turnId, expectedCount) {
  const deadline = Date.now() + 15_000
  let observed = []
  while (Date.now() < deadline) {
    observed = await page.evaluate((expectedTurnId) => {
      return (globalThis.__onekeySmokeAgentEvents ?? [])
        .filter((event) => event.type === 'approval-request' && event.turnId === expectedTurnId)
    }, turnId)
    if (observed.length >= expectedCount) return observed[expectedCount - 1]
    await delay(25)
  }
  throw new Error(
    `Timed out waiting for Agent approval ${expectedCount}; observed ${JSON.stringify(observed)}`
  )
}

async function waitForAssistantStatus(page, taskId, status) {
  let latest
  for (let attempt = 0; attempt < 400; attempt += 1) {
    latest = await page.evaluate(
      (id) => window.onekey.conversation.load({ taskId: id }),
      taskId
    )
    if (
      latest.ok &&
      latest.value.messages.some((message) => message.role === 'assistant' && message.status === status)
    ) {
      return latest
    }
    await delay(25)
  }
  assert.fail(`Timed out waiting for persisted assistant status ${status}.`)
}

async function waitForCondition(predicate, label) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(20)
  }
  assert.fail(`Timed out waiting for ${label}.`)
}

function assertNoSensitiveRendererOrHistoryData(value, credential, ...absolutePaths) {
  const serialized = JSON.stringify(value)
  assert.equal(serialized.includes(credential), false)
  assert.equal(/smoke-private|secret\.txt/u.test(serialized), false)
  for (const absolutePath of absolutePaths) {
    assertStringDoesNotContainLocalPath(serialized, absolutePath)
  }
}

function assertStringDoesNotContainLocalPath(value, absolutePath) {
  const serializedPath = JSON.stringify(absolutePath).slice(1, -1)
  for (const candidate of [
    absolutePath,
    absolutePath.replaceAll('\\', '/'),
    serializedPath,
    encodeURIComponent(absolutePath)
  ]) {
    assert.equal(String(value).includes(candidate), false)
  }
}

function functionCallOutputIds(input) {
  if (!Array.isArray(input)) return []
  return input
    .filter((item) => item && typeof item === 'object' && item.type === 'function_call_output')
    .map((item) => item.call_id)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function bestEffort(operation, timeoutMs = 5_000) {
  const attempt = Promise.resolve()
    .then(operation)
    .catch(() => undefined)
  await Promise.race([attempt, delay(timeoutMs)])
}

async function closeElectronApplication(application) {
  let settled = false
  let closeError
  const closeAttempt = Promise.resolve()
    .then(() => application.close())
    .catch((error) => {
      closeError = error
    })
    .finally(() => {
      settled = true
    })

  await Promise.race([closeAttempt, delay(10_000)])
  if (!settled) {
    const child = application.process()
    if (!child.killed && child.exitCode === null) child.kill()
    await Promise.race([closeAttempt, delay(2_000)])
  }
  if (closeError) throw closeError
}

async function readSafeStartupDiagnostics(application, targetPage) {
  const surfaceAttempt = targetPage.evaluate(() => (
    document.querySelector('.startup-screen') ? 'splash' :
      document.querySelector('.auth-gate') ? 'auth' : 'other'
  )).catch(() => 'closed')
  const mainAttempt = application.evaluate(() => {
    const state = globalThis.__onekeySmokeStartupFailureStage
    const renderer = globalThis.__onekeySmokeRendererGoneReason
    return {
      startupStage: typeof state === 'string' ? state : 'none',
      rendererGoneReason: typeof renderer === 'string' ? renderer : 'none'
    }
  }).catch(() => ({ startupStage: 'closed', rendererGoneReason: 'closed' }))
  const [surface, main] = await Promise.all([
    Promise.race([surfaceAttempt, delay(2_000).then(() => 'closed')]),
    Promise.race([
      mainAttempt,
      delay(2_000).then(() => ({ startupStage: 'closed', rendererGoneReason: 'closed' }))
    ])
  ])
  return { surface, ...main }
}

async function cleanupTemporaryWorkspace(workspacePath) {
  const target = resolve(workspacePath)
  const expectedPrefix = resolve(tmpdir(), 'onekey-electron-agent-smoke-')
  const comparableTarget = process.platform === 'win32' ? target.toLowerCase() : target
  const comparablePrefix = process.platform === 'win32'
    ? expectedPrefix.toLowerCase()
    : expectedPrefix
  if (
    comparableTarget === comparablePrefix ||
    !comparableTarget.startsWith(comparablePrefix)
  ) {
    throw new Error('Refusing to remove an unexpected smoke workspace path.')
  }
  await rm(target, { recursive: true, force: true })
}

async function startLocalResponsesServer({
  fakeCredential,
  relayModelCredential,
  fakeAbsolutePath,
  agentInputFile,
  agentOutputFile,
  agentWrittenContent,
  agentEditPrompt,
  agentEditFile,
  agentEditOldText,
  agentEditNewText,
  agentEditRevision
}) {
  const requests = []
  const sockets = new Set()
  const responses = new Set()
  let origin = ''
  const server = createServer((request, response) => {
    responses.add(response)
    response.once('close', () => responses.delete(response))
    void handleLocalResponseRequest(request, response, {
      requests,
      fakeCredential,
      relayModelCredential,
      fakeAbsolutePath,
      agentInputFile,
      agentOutputFile,
      agentWrittenContent,
      agentEditPrompt,
      agentEditFile,
      agentEditOldText,
      agentEditNewText,
      agentEditRevision,
      relayOrigin: origin
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  await new Promise((resolve, reject) => {
    const fail = (error) => reject(error)
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail)
      resolve()
    })
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  origin = `http://127.0.0.1:${address.port}`

  return {
    origin,
    baseUrl: `${origin}/v1`,
    requests,
    async close() {
      for (const response of responses) response.destroy()
      for (const socket of sockets) socket.destroy()
      if (!server.listening) return
      await new Promise((resolve) => server.close(() => resolve()))
    }
  }
}

async function handleLocalResponseRequest(request, response, options) {
  const record = {
    method: request.method ?? '',
    url: request.url ?? '',
    headers: normalizeHeaders(request.headers),
    remoteAddress: request.socket.remoteAddress ?? '',
    body: '',
    json: null,
    model: '',
    completed: false,
    closed: false,
    aborted: false,
    error: ''
  }
  options.requests.push(record)
  response.once('close', () => { record.closed = true })
  request.once('aborted', () => { record.aborted = true })

  try {
    if (record.method === 'POST' && record.url === '/api/desktop/auth/code') {
      await readBoundedJsonRequest(request)
      record.body = '<redacted-auth-request>'
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        success: true,
        data: {
          device_code: 'smoke_device_code_private',
          user_code: 'SMOKE-GATE',
          verification_uri: `${options.relayOrigin}/desktop/authorize`,
          verification_uri_complete: `${options.relayOrigin}/desktop/authorize?user_code=SMOKE-GATE`,
          expires_in: 600,
          interval: 1
        }
      }))
      record.completed = true
      return
    }

    if (
      record.method === 'POST' &&
      (record.url === '/api/desktop/auth/token' || record.url === '/api/desktop/auth/refresh')
    ) {
      await readBoundedJsonRequest(request)
      record.body = '<redacted-auth-request>'
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        success: true,
        data: {
          access_token: relayAccessCredential,
          refresh_token: relayRefreshCredential,
          device_id: 'device_smoke_electron',
          expires_in: 900,
          refresh_expires_in: 2_592_000,
          token_type: 'Bearer'
        }
      }))
      record.completed = true
      return
    }

    if (record.url.startsWith('/api/')) {
      const relayAuthorized = record.headers.authorization === `Bearer ${relayAccessCredential}`
      if (record.headers.authorization) record.headers.authorization = '<redacted>'
      const reply = (data, extra = {}) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ success: true, data, ...extra }))
        record.completed = true
      }
      if (record.method === 'GET' && record.url === '/api/pricing') {
        reply([])
        return
      }
      if (!relayAuthorized) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ success: false, error: 'unauthorized' }))
        return
      }
      if (record.method === 'GET' && record.url === '/api/desktop/self') {
        reply({
          id: 7,
          username: 'electron-smoke',
          display_name: 'Electron Smoke',
          group: 'default',
          quota: 100,
          used_quota: 5,
          request_count: 1,
          device_id: 'device_smoke_electron',
          status: 1,
          role: 1
        })
        return
      }
      if (record.method === 'GET' && record.url === '/api/desktop/billing-config') {
        reply({
          schema_version: 1,
          quota_per_unit: 500_000,
          display_in_currency: true,
          quota_display_type: 'USD',
          usd_exchange_rate: 7.3,
          custom_currency_symbol: '¤',
          custom_currency_exchange_rate: 1,
        })
        return
      }
      if (record.method === 'GET' && record.url === '/api/user/self/groups') {
        reply({ default: { ratio: 1, desc: 'Default' } })
        return
      }
      if (record.method === 'GET' && record.url === '/api/user/models') {
        reply(['smoke-agent', 'smoke-complete'])
        return
      }
      if (record.method === 'GET' && record.url === '/api/token/?p=1&size=100') {
        reply({
          page: 1,
          page_size: 100,
          total: 1,
          items: [{
            id: 71,
            name: 'Electron desktop default',
            key: '',
            status: 1,
            remain_quota: 100,
            unlimited_quota: false,
            model_limits_enabled: false,
            model_limits: '',
            group: 'default',
            expired_time: -1,
            cross_group_retry: false
          }]
        })
        return
      }
      if (record.method === 'POST' && record.url === '/api/token/71/key') {
        reply({ key: options.relayModelCredential })
        return
      }
      if (record.method === 'GET' && record.url.startsWith('/api/desktop/usage?')) {
        const usageUrl = new URL(record.url, options.relayOrigin)
        const startTimestamp = Number(usageUrl.searchParams.get('start_timestamp'))
        const endTimestamp = Number(usageUrl.searchParams.get('end_timestamp'))
        reply({
          schema_version: 1,
          range: { start_timestamp: startTimestamp, end_timestamp: endTimestamp },
          totals: { count: 0, quota: 0, token_used: 0 },
          records: []
        })
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ success: false, error: 'not_found' }))
      return
    }

    if (record.method === 'GET' && record.url === '/v1/models') {
      if (
        record.headers.authorization !== `Bearer ${options.fakeCredential}` &&
        record.headers.authorization !== `Bearer ${options.relayModelCredential}`
      ) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        data: [
          {
            id: 'smoke-agent',
            reasoning: ['high'],
            capabilities: { toolUse: true, webSearch: false, subagents: true }
          },
          {
            id: 'smoke-complete',
            reasoning: ['high'],
            capabilities: { webSearch: true }
          },
          {
            id: 'smoke-long',
            reasoning: ['medium'],
            capabilities: { webSearch: false }
          },
          {
            id: 'smoke-no-subagents',
            reasoning: ['high'],
            capabilities: { toolUse: true, webSearch: false, subagents: false }
          }
        ]
      }))
      record.completed = true
      return
    }
    if (record.method !== 'POST' || record.url !== '/v1/responses') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')
      return
    }
    if (record.headers.authorization !== `Bearer ${options.fakeCredential}`) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    record.json = await readBoundedJsonRequest(request)
    record.body = JSON.stringify(record.json)
    record.model = typeof record.json?.model === 'string' ? record.json.model : ''

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'close'
    })
    writeSse(response, 'response.created', {
      type: 'response.created',
      response: { id: `response_${record.model || 'unknown'}` }
    })

    if (record.model === 'smoke-complete') {
      writeSse(response, 'response.output_text.delta', {
        type: 'response.output_text.delta',
        delta: `Credential Bearer ${options.fakeCredential.slice(0, 20)}`
      })
      writeSse(response, 'response.output_text.delta', {
        type: 'response.output_text.delta',
        delta: `${options.fakeCredential.slice(20)} at ${options.fakeAbsolutePath.slice(0, 22)}`
      })
      writeSse(response, 'response.output_text.delta', {
        type: 'response.output_text.delta',
        delta: `${options.fakeAbsolutePath.slice(22)}\nSmoke answer complete.\n`
      })
      writeSse(response, 'response.completed', {
        type: 'response.completed',
        response: { id: 'response_smoke_complete' }
      })
      response.end('data: [DONE]\n\n')
      record.completed = true
      return
    }

    if (record.model === 'smoke-long') {
      writeSse(response, 'response.output_text.delta', {
        type: 'response.output_text.delta',
        delta: 'Long stream started.\n'
      })
      writeSse(response, 'response.output_text.delta', {
        type: 'response.output_text.delta',
        delta: `Bearer ${options.fakeCredential} at ${options.fakeAbsolutePath}`
      })
      return
    }

    if (record.model === 'smoke-agent') {
      const completedOutputIds = functionCallOutputIds(record.json?.input)
      const isEditFlow = JSON.stringify(record.json?.input ?? '').includes(options.agentEditPrompt)
      if (isEditFlow && completedOutputIds.length === 0) {
        finishToolCallResponse(response, {
          responseId: 'response_smoke_agent_search',
          itemId: 'item_smoke_search',
          callId: 'call_smoke_search',
          name: 'search_files',
          argumentsValue: {
            relative_path: '.',
            query: options.agentEditOldText,
            case_sensitive: true
          }
        })
        record.completed = true
        return
      }
      if (
        isEditFlow &&
        completedOutputIds.length === 1 &&
        completedOutputIds[0] === 'call_smoke_search'
      ) {
        finishToolCallResponse(response, {
          responseId: 'response_smoke_agent_edit_read',
          itemId: 'item_smoke_edit_read',
          callId: 'call_smoke_edit_read',
          name: 'read_file',
          argumentsValue: { relative_path: options.agentEditFile }
        })
        record.completed = true
        return
      }
      if (
        isEditFlow &&
        completedOutputIds.length === 2 &&
        completedOutputIds[0] === 'call_smoke_search' &&
        completedOutputIds[1] === 'call_smoke_edit_read'
      ) {
        finishToolCallResponse(response, {
          responseId: 'response_smoke_agent_replace',
          itemId: 'item_smoke_replace',
          callId: 'call_smoke_replace',
          name: 'replace_in_file',
          argumentsValue: {
            relative_path: options.agentEditFile,
            old_text: options.agentEditOldText,
            new_text: options.agentEditNewText,
            expected_revision: options.agentEditRevision
          }
        })
        record.completed = true
        return
      }
      if (
        isEditFlow &&
        completedOutputIds.length === 3 &&
        completedOutputIds[0] === 'call_smoke_search' &&
        completedOutputIds[1] === 'call_smoke_edit_read' &&
        completedOutputIds[2] === 'call_smoke_replace'
      ) {
        writeSse(response, 'response.output_text.delta', {
          type: 'response.output_text.delta',
          delta: 'Search and replace smoke complete.\n'
        })
        writeSse(response, 'response.completed', {
          type: 'response.completed',
          response: { id: 'response_smoke_agent_edit_final', output: [] }
        })
        response.end('data: [DONE]\n\n')
        record.completed = true
        return
      }
      if (isEditFlow) throw new Error('unexpected Agent search/replace tool sequence')
      if (completedOutputIds.length === 0) {
        finishToolCallResponse(response, {
          responseId: 'response_smoke_agent_read',
          itemId: 'item_smoke_read',
          callId: 'call_smoke_read',
          name: 'read_file',
          argumentsValue: { relative_path: options.agentInputFile }
        })
        record.completed = true
        return
      }
      if (
        completedOutputIds.length === 1 &&
        completedOutputIds[0] === 'call_smoke_read'
      ) {
        finishToolCallResponse(response, {
          responseId: 'response_smoke_agent_write',
          itemId: 'item_smoke_write',
          callId: 'call_smoke_write',
          name: 'write_file',
          argumentsValue: {
            relative_path: options.agentOutputFile,
            content: options.agentWrittenContent
          }
        })
        record.completed = true
        return
      }
      if (
        completedOutputIds.length === 2 &&
        completedOutputIds[0] === 'call_smoke_read' &&
        completedOutputIds[1] === 'call_smoke_write'
      ) {
        writeSse(response, 'response.output_text.delta', {
          type: 'response.output_text.delta',
          delta: `Agent completed with Bearer ${options.fakeCredential.slice(0, 20)}`
        })
        writeSse(response, 'response.output_text.delta', {
          type: 'response.output_text.delta',
          delta: `${options.fakeCredential.slice(20)} at ${options.fakeAbsolutePath.slice(0, 22)}`
        })
        writeSse(response, 'response.output_text.delta', {
          type: 'response.output_text.delta',
          delta: `${options.fakeAbsolutePath.slice(22)}\nAgent read and write complete.\n`
        })
        writeSse(response, 'response.completed', {
          type: 'response.completed',
          response: { id: 'response_smoke_agent_final', output: [] }
        })
        response.end('data: [DONE]\n\n')
        record.completed = true
        return
      }
      throw new Error('unexpected Agent tool sequence')
    }

    response.destroy()
  } catch {
    record.error = 'local mock request failed'
    if (!response.headersSent) response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('invalid local request')
  }
}

async function readBoundedJsonRequest(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 1024 * 1024) throw new Error('request too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function finishToolCallResponse(response, options) {
  const item = {
    id: options.itemId,
    type: 'function_call',
    status: 'completed',
    call_id: options.callId,
    name: options.name,
    arguments: JSON.stringify(options.argumentsValue)
  }
  writeSse(response, 'response.completed', {
    type: 'response.completed',
    response: { id: options.responseId, output: [item] }
  })
  response.end('data: [DONE]\n\n')
}

function writeSse(response, eventName, payload) {
  response.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`)
}

function normalizeHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name.toLowerCase(),
    Array.isArray(value) ? value.join(', ') : String(value ?? '')
  ]))
}
