import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  AgentEvent,
  ConversationMessageDto,
  ConversationSnapshot,
  GitSummary,
  TaskSummary,
  WorkspaceDirectoryResult,
  WorkspaceFileResult
} from '../../src/shared/contracts.ts'
import { ConsentStore } from '../../src/main/security/consent-store.ts'
import { AgentApprovalService } from '../../src/main/services/agent-approval-service.ts'
import {
  AgentTurnError,
  AgentTurnService,
  type AgentTurnServiceOptions,
  type AgentTurnStartInput,
  type AgentWorkspaceToolService
} from '../../src/main/services/agent-turn-service.ts'
import type {
  ConversationMessageAppendInput,
  ConversationMessageReceipt
} from '../../src/main/services/conversation-history-service.ts'
import { WorkspaceToolError } from '../../src/main/services/workspace-tool-service.ts'
import { ResponsesClientError } from '../../src/main/services/responses-client.ts'
import type {
  ResponsesContinuationCapsule,
  ResponsesCredentials,
  ResponsesInputItem,
  ResponsesJsonObject,
  ResponsesRemoteFailure,
  ResponsesStreamOptions,
  ResponsesStreamRequest,
  ResponsesStreamResult
} from '../../src/main/services/responses-client.ts'
import type {
  WorkspaceGitDiffResult,
  WorkspaceReplaceResult,
  WorkspaceSearchResult
} from '../../src/main/services/workspace-tool-service.ts'

const FIXED_TIME = '2026-07-15T00:00:00.000Z'
const workspaceToken = `ws_${'w'.repeat(43)}`
const workspaceProjectId = `project:workspace:${'p'.repeat(43)}`
const credentials: ResponsesCredentials = {
  baseUrl: 'https://example.test/v1',
  apiKey: 'sk-agent-test-secret-123456'
}

class FakeHistory {
  readonly task: TaskSummary = {
    id: 'task:agent-test',
    projectId: workspaceProjectId,
    title: 'Agent test',
    mode: 'agent',
    updatedAt: FIXED_TIME,
    archivedAt: null,
    status: 'idle'
  }
  readonly messages: ConversationMessageDto[] = []
  readonly appended: ConversationMessageAppendInput[] = []
  loadCalls = 0
  #sequence = 0

  async load(taskId: string): Promise<ConversationSnapshot> {
    this.loadCalls += 1
    assert.equal(taskId, this.task.id)
    return {
      task: { ...this.task },
      messages: this.messages.map((message) => ({ ...message })),
      events: []
    }
  }

  async appendMessage(input: ConversationMessageAppendInput): Promise<ConversationMessageReceipt> {
    this.appended.push({ ...input })
    const message: ConversationMessageDto = {
      id: `message:test-${++this.#sequence}`,
      role: input.role,
      content: input.content,
      status: input.status ?? 'complete',
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME
    }
    this.messages.push(message)
    return { ...message, taskId: input.taskId }
  }

  async updateMessageStatus(input: {
    taskId: string
    messageId: string
    status: ConversationMessageDto['status']
  }): Promise<ConversationMessageReceipt> {
    const message = this.messages.find((candidate) => candidate.id === input.messageId)
    if (!message) throw new Error('fixed missing message')
    message.status = input.status
    return { ...message, taskId: input.taskId }
  }
}

class ManualScheduler {
  readonly pending: Array<() => void> = []
  readonly schedule = (operation: () => void): void => {
    this.pending.push(operation)
  }
  runAll(): void {
    for (const operation of this.pending.splice(0)) operation()
  }
}

class RecordingApprovalService extends AgentApprovalService {
  readonly authorizeRequests: Array<Parameters<AgentApprovalService['authorize']>[0]> = []

  override authorize(
    request: Parameters<AgentApprovalService['authorize']>[0]
  ): ReturnType<AgentApprovalService['authorize']> {
    this.authorizeRequests.push(request)
    return super.authorize(request)
  }
}

interface ResponseCall {
  credentials: ResponsesCredentials
  request: ResponsesStreamRequest
  options: ResponsesStreamOptions
}

class SequencedResponses {
  readonly calls: ResponseCall[] = []
  readonly #results: Array<(options: ResponsesStreamOptions) => Promise<ResponsesStreamResult>>
  readonly #autoContinuation: boolean

  constructor(
    results: Array<(options: ResponsesStreamOptions) => Promise<ResponsesStreamResult>>,
    autoContinuation = true
  ) {
    this.#results = results
    this.#autoContinuation = autoContinuation
  }

  async stream(
    callCredentials: ResponsesCredentials,
    request: ResponsesStreamRequest,
    options: ResponsesStreamOptions = {}
  ): Promise<ResponsesStreamResult> {
    this.calls.push({ credentials: callCredentials, request, options })
    const next = this.#results.shift()
    if (!next) throw new Error('unexpected fake response call')
    const result = await next(options)
    if (this.#autoContinuation) return withTestContinuation(result)
    return result
  }
}

class FakeWorkspaceTools implements AgentWorkspaceToolService {
  listCalls = 0
  readCalls = 0
  gitCalls = 0
  gitDiffCalls = 0
  writeCalls = 0
  searchCalls = 0
  replaceCalls = 0
  readError: unknown = null
  listSignal: AbortSignal | undefined
  searchSignal: AbortSignal | undefined
  replaceSignal: AbortSignal | undefined
  gitDiffSignal: AbortSignal | undefined
  readonly gitDiffInputs: Array<{ workspaceToken: string; ownerWebContentsId: number }> = []
  readonly searchInputs: Array<{
    workspaceToken: string
    relativePath: string
    query: string
    caseSensitive: boolean
  }> = []
  readonly replaceInputs: Array<{
    workspaceToken: string
    relativePath: string
    oldText: string
    newText: string
    expectedRevision: string
  }> = []
  readonly directoryResult: WorkspaceDirectoryResult = {
    entries: [
      { relativePath: 'README.md', kind: 'file' },
      { relativePath: 'src', kind: 'directory' }
    ],
    truncated: false
  }
  readonly fileResult: WorkspaceFileResult = {
    relativePath: 'src/main.ts',
    content: 'const apiKey = "sk-file-secret-123456";\nexport const safe = true;\n',
    revision: 'a'.repeat(64),
    truncated: false
  }
  readonly gitResult: GitSummary = {
    branch: 'test',
    additions: 1,
    deletions: 0,
    files: [{ relativePath: 'src/main.ts', additions: 1, deletions: 0, status: 'modified' }]
  }
  readonly gitDiffResult: WorkspaceGitDiffResult = {
    patch: '@@ -1 +1 @@\n-export const safe = false;\n+export const safe = true;\n',
    files: ['src/main.ts'],
    untrackedFiles: ['notes.txt'],
    truncated: false
  }
  readonly searchResult: WorkspaceSearchResult = {
    matches: [{ relativePath: 'src/main.ts', line: 1, column: 1, preview: 'const safe = true;' }],
    truncated: false
  }
  readonly replaceResult: WorkspaceReplaceResult = {
    relativePath: 'src/main.ts',
    revision: 'b'.repeat(64),
    replacements: 1
  }

  async listDirectory(
    _input: { relativePath: string },
    _ownerWebContentsId: number,
    options?: { signal?: AbortSignal }
  ): Promise<WorkspaceDirectoryResult> {
    this.listCalls += 1
    this.listSignal = options?.signal
    return this.directoryResult
  }

  async readFile(): Promise<WorkspaceFileResult> {
    this.readCalls += 1
    if (this.readError) throw this.readError
    return this.fileResult
  }

  async gitSummary(): Promise<GitSummary> {
    this.gitCalls += 1
    return this.gitResult
  }

  async gitDiff(
    input: { workspaceToken: string },
    ownerWebContentsId: number,
    options?: { signal?: AbortSignal }
  ): Promise<WorkspaceGitDiffResult> {
    this.gitDiffCalls += 1
    this.gitDiffInputs.push({ workspaceToken: input.workspaceToken, ownerWebContentsId })
    this.gitDiffSignal = options?.signal
    return this.gitDiffResult
  }

  async writeFile(input: { relativePath: string; content: string }): Promise<WorkspaceFileResult> {
    this.writeCalls += 1
    return {
      relativePath: input.relativePath,
      content: input.content,
      revision: 'b'.repeat(64),
      truncated: false
    }
  }

  async searchFiles(
    input: {
      workspaceToken: string
      relativePath: string
      query: string
      caseSensitive: boolean
    },
    _ownerWebContentsId: number,
    options?: { signal?: AbortSignal }
  ): Promise<WorkspaceSearchResult> {
    this.searchCalls += 1
    this.searchInputs.push({ ...input })
    this.searchSignal = options?.signal
    return this.searchResult
  }

  async replaceInFile(
    input: {
      workspaceToken: string
      relativePath: string
      oldText: string
      newText: string
      expectedRevision: string
    },
    _ownerWebContentsId: number,
    options?: { signal?: AbortSignal }
  ): Promise<WorkspaceReplaceResult> {
    this.replaceCalls += 1
    this.replaceInputs.push({ ...input })
    this.replaceSignal = options?.signal
    return this.replaceResult
  }
}

function startInput(overrides: Partial<AgentTurnStartInput> = {}): AgentTurnStartInput {
  return {
    taskId: 'task:agent-test',
    prompt: 'Inspect src/main.ts and summarize it.',
    credentials,
    model: 'gpt-agent-test',
    wireMode: 'standard',
    modelCapabilities: {
      attachments: true,
      imageInput: true,
      imageGeneration: true,
      subagents: true,
      toolUse: true,
      webSearch: true
    },
    reasoning: 'high',
    webSearch: false,
    imageGeneration: false,
    subagentsEnabled: false,
    attachments: [],
    approvalMode: 'request',
    planMode: false,
    reviewMode: false,
    workspaceToken,
    workspaceProjectId,
    ownerWebContentsId: 7,
    ...overrides
  }
}

function requestItems(request: ResponsesStreamRequest | undefined): readonly ResponsesInputItem[] {
  return request?.messages ?? request?.continuation?.outputs ?? []
}

function withTestContinuation(result: ResponsesStreamResult): ResponsesStreamResult {
  if (result.toolCalls.length === 0 || result.continuation) return result
  return {
    ...result,
    continuation: Object.freeze({}) as ResponsesContinuationCapsule
  }
}

function priorMessages(count: number): ConversationMessageDto[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message:prior-${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `encrypted history ${index + 1}`,
    status: 'complete',
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME
  }))
}

function createHarness(
  responses: AgentTurnServiceOptions['responses'],
  options: { imageResults?: AgentTurnServiceOptions['imageResults'] } = {}
): {
  service: AgentTurnService
  approvals: RecordingApprovalService
  history: FakeHistory
  tools: FakeWorkspaceTools
  scheduler: ManualScheduler
  events: AgentEvent[]
} {
  const history = new FakeHistory()
  const tools = new FakeWorkspaceTools()
  const scheduler = new ManualScheduler()
  const events: AgentEvent[] = []
  const approvals = new RecordingApprovalService({
    consents: new ConsentStore(),
    onEvent: (event) => events.push(event)
  })
  const service = new AgentTurnService({
    history,
    responses,
    approvals,
    workspaceTools: tools,
    imageResults: options.imageResults,
    schedule: scheduler.schedule,
    onEvent: (event) => events.push(event)
  })
  return { service, approvals, history, tools, scheduler, events }
}

test('Agent reports fixed safe diagnostics for classified endpoint rejections', async () => {
  const cases: ReadonlyArray<readonly [ResponsesRemoteFailure, string]> = [
    ['authorization', 'Agent 请求未获模型 endpoint 授权，请检查 API Key 权限和渠道配置。'],
    ['tool_incompatible', '当前渠道或模型可能不兼容 Agent 工具调用，请改用支持 Responses 工具的模型。'],
    ['responses_unsupported', '当前渠道未提供 Agent 所需的 Responses 接口，请检查中转站兼容性。'],
    ['rate_limited', 'Agent 请求受到频率或额度限制，请稍后重试。'],
    ['server_error', '模型 endpoint 服务暂时异常，请稍后重试 Agent。'],
    ['request_rejected', '模型 endpoint 拒绝了 Agent 请求，请检查渠道和模型。']
  ]

  for (const [remoteFailure, expectedMessage] of cases) {
    const rawMarker = `raw-${remoteFailure}-body-secret-D-private-path`
    const error = new ResponsesClientError('remote_rejected', false, remoteFailure) as
      ResponsesClientError & { raw?: string }
    error.raw = rawMarker
    const responses = new SequencedResponses([
      async () => { throw error }
    ])
    const harness = createHarness(responses)

    await harness.service.start(startInput())
    harness.scheduler.runAll()
    await waitFor(
      () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
      `${remoteFailure} Agent diagnostic`
    )

    const failed = harness.events.find(
      (event): event is Extract<AgentEvent, { type: 'turn-status' }> =>
        event.type === 'turn-status' && event.status === 'failed'
    )
    assert.equal(failed?.message, expectedMessage)
    const serialized = JSON.stringify({ events: harness.events, appended: harness.history.appended })
    assert.doesNotMatch(serialized, new RegExp(rawMarker))
    assert.doesNotMatch(serialized, /sk-agent-test-secret|example\.test|D-private-path/u)
  }
})

test('Agent sends current attachments as untrusted multimodal input without persisting their bytes', async () => {
  const responses = new SequencedResponses([
    async (options) => await finalResult(options, 'Attachment inspected safely.\n')
  ])
  const harness = createHarness(responses)
  const fileData = Buffer.from('safe attachment bytes').toString('base64')
  await harness.service.start(startInput({
    attachments: [{
      type: 'input_file',
      filename: 'attachment-1.txt',
      file_data: `data:text/plain;base64,${fileData}`
    }]
  }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'Agent attachment completion'
  )

  const messages = requestItems(responses.calls[0]?.request)
  assert.ok(messages)
  const current = messages.at(-1)
  assert.ok(current && 'role' in current && current.role === 'user' && Array.isArray(current.content))
  assert.equal(current.content[1]?.type, 'input_file')
  assert.doesNotMatch(JSON.stringify(harness.history.appended), new RegExp(fileData))
})

test('Agent contextMessageLimit keeps the current prompt and attachments while excluding older encrypted history', async () => {
  const encryptedHistory = priorMessages(8)
  const responses = new SequencedResponses([
    async (options) => await finalResult(options, 'Limited Agent context handled.\n')
  ])
  const harness = createHarness(responses)
  harness.history.messages.push(...encryptedHistory)
  const fileData = Buffer.from('current Agent context attachment').toString('base64')

  await harness.service.start(startInput({
    prompt: 'current limited Agent prompt',
    contextMessageLimit: 6,
    attachments: [{
      type: 'input_file',
      filename: 'current-agent.txt',
      file_data: `data:text/plain;base64,${fileData}`
    }]
  }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'limited Agent context completion'
  )

  const conversationMessages = requestItems(responses.calls[0]?.request).filter(
    (message): message is Extract<typeof message, { role: 'user' | 'assistant' }> =>
      'role' in message && (message.role === 'user' || message.role === 'assistant')
  )
  assert.ok(conversationMessages)
  assert.equal(conversationMessages.length, 6)
  assert.deepEqual(
    conversationMessages.slice(0, -1),
    encryptedHistory.slice(-5).map((message) => ({ role: message.role, content: message.content }))
  )
  assert.deepEqual(conversationMessages.at(-1), {
    role: 'user',
    content: [
      { type: 'input_text', text: 'current limited Agent prompt' },
      {
        type: 'input_file',
        filename: 'current-agent.txt',
        file_data: `data:text/plain;base64,${fileData}`
      }
    ]
  })
  const serializedRequest = JSON.stringify(responses.calls[0]?.request)
  assert.doesNotMatch(serializedRequest, /encrypted history [123](?:\D|$)/u)
  assert.match(serializedRequest, /encrypted history 4/u)
  assert.deepEqual(harness.history.appended[0], {
    taskId: 'task:agent-test',
    role: 'user',
    content: 'current limited Agent prompt',
    status: 'complete'
  })
  assert.doesNotMatch(JSON.stringify(harness.history.appended), new RegExp(fileData))
})

test('Agent without contextMessageLimit preserves the existing full-history request behavior', async () => {
  const encryptedHistory = priorMessages(8)
  const responses = new SequencedResponses([
    async (options) => await finalResult(options, 'Full Agent context handled.\n')
  ])
  const harness = createHarness(responses)
  harness.history.messages.push(...encryptedHistory)

  await harness.service.start(startInput({ prompt: 'current default Agent prompt' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'default Agent context completion'
  )

  const conversationMessages = requestItems(responses.calls[0]?.request).filter(
    (message) => 'role' in message && (message.role === 'user' || message.role === 'assistant')
  )
  assert.deepEqual(conversationMessages, [
    ...encryptedHistory.map((message) => ({ role: message.role, content: message.content })),
    { role: 'user', content: 'current default Agent prompt' }
  ])
})

test('Agent rejects invalid contextMessageLimit bounds and non-integers before preflight work', async () => {
  const responses = new SequencedResponses([])
  const harness = createHarness(responses)

  for (const contextMessageLimit of [1, 25, 6.5]) {
    await assert.rejects(
      harness.service.start(startInput({ contextMessageLimit })),
      (error: unknown) => error instanceof AgentTurnError && error.code === 'invalid_configuration'
    )
  }

  assert.deepEqual(harness.history.appended, [])
  assert.equal(harness.history.loadCalls, 0)
  assert.equal(responses.calls.length, 0)
  assert.equal(harness.scheduler.pending.length, 0)
})

test('Agent rejects unsupported hosted capabilities and Lite hosted tools before preflight work', async () => {
  const responses = new SequencedResponses([])
  const harness = createHarness(responses)
  const capabilities = startInput().modelCapabilities
  const invalidInputs: AgentTurnStartInput[] = [
    startInput({
      webSearch: true,
      modelCapabilities: { ...capabilities, webSearch: false }
    }),
    startInput({
      imageGeneration: true,
      modelCapabilities: { ...capabilities, imageGeneration: false }
    }),
    startInput({ wireMode: 'lite', webSearch: true }),
    startInput({ wireMode: 'lite', imageGeneration: true })
  ]

  for (const input of invalidInputs) {
    await assert.rejects(
      harness.service.start(input),
      (error: unknown) => error instanceof AgentTurnError && error.code === 'invalid_configuration'
    )
  }

  assert.equal(harness.history.loadCalls, 0)
  assert.equal(responses.calls.length, 0)
  assert.equal(harness.scheduler.pending.length, 0)
})

test('Agent image-only completion publishes an opaque token without entering tool approval or history bytes', async () => {
  const dataUrl = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')}`
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_agent_image',
      outputText: '',
      toolCalls: [],
      generatedImages: [{ mimeType: 'image/png', dataUrl }]
    })
  ])
  const issued: unknown[] = []
  const harness = createHarness(responses, {
    imageResults: {
      issueMany(images, ownerWebContentsId) {
        issued.push({ images, ownerWebContentsId })
        return [{
          imageToken: `img_${'a'.repeat(43)}`,
          mimeType: 'image/png',
          byteLength: 8
        }]
      }
    }
  })
  await harness.service.start(startInput({ imageGeneration: true }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'Agent image completion'
  )

  assert.equal(issued.length, 1)
  assert.equal(harness.events.some((event) => event.type === 'image-result'), true)
  assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
  assert.match(harness.history.appended.at(-1)?.content ?? '', /图片已生成/)
  assert.doesNotMatch(JSON.stringify(harness.history.appended), /data:image|iVBOR/)
})

test('Agent rejects a tool result without a verified continuation before local dispatch', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_unverified_tool_result',
      outputText: '',
      toolCalls: [{
        callId: 'call_unverified_read',
        name: 'read_file',
        arguments: { relative_path: 'src/main.ts' }
      }]
    })
  ], false)
  const harness = createHarness(responses)

  await harness.service.start(startInput({ approvalMode: 'full' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
    'unverified continuation rejection'
  )

  assert.equal(harness.tools.readCalls, 0)
  assert.equal(harness.approvals.authorizeRequests.length, 0)
  assert.equal(responses.calls.length, 1)
})

test('credential-bearing writes are denied before approval and never reach the workspace', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_credential_write',
      outputText: '',
      toolCalls: [{
        callId: 'call_write_credential',
        name: 'write_file',
        arguments: {
          relative_path: 'src/secret.ts',
          content: `export const apiKey = "${credentials.apiKey}";`
        }
      }]
    }),
    async (options) => await finalResult(options, 'The local credential policy blocked the write.\n')
  ])
  const harness = createHarness(responses)
  await harness.service.start(startInput())
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'credential write denial'
  )

  assert.equal(harness.tools.writeCalls, 0)
  assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
  const toolOutput = requestItems(responses.calls[1]?.request).find(
    (item) => 'type' in item && item.type === 'function_call_output'
  )
  assert.ok(toolOutput && 'output' in toolOutput)
  assert.match(toolOutput.output, /credential policy denied/i)
  assert.doesNotMatch(JSON.stringify(harness.events), new RegExp(credentials.apiKey))
})

test('plan mode rejects every write tool before approval or workspace dispatch for all approval modes', async () => {
  const denial = 'Plan mode blocks file writes and command execution. No local operation was performed.'
  for (const approvalMode of ['request', 'auto', 'full'] as const) {
    for (const toolName of ['write_file', 'replace_in_file'] as const) {
      const toolArguments = toolName === 'write_file'
        ? {
            relative_path: `src/plan-${approvalMode}.ts`,
            content: 'export const planned = true\n'
          }
        : {
            relative_path: 'src/main.ts',
            old_text: 'export const safe = true;',
            new_text: 'export const safe = false;',
            expected_revision: 'a'.repeat(64)
          }
      const responses = new SequencedResponses([
        async () => ({
          responseId: `response_plan_${approvalMode}_${toolName}`,
          outputText: '',
          toolCalls: [{
            callId: `call_plan_${approvalMode}_${toolName}`,
            name: toolName,
            arguments: toolArguments
          }]
        }),
        async (options) => await finalResult(options, 'The plan remains read-only.\n')
      ])
      const harness = createHarness(responses)

      await harness.service.start(startInput({ approvalMode, planMode: true }))
      harness.scheduler.runAll()
      await waitFor(
        () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
        `${approvalMode} plan-mode ${toolName} denial`
      )

      assert.equal(harness.tools.writeCalls, 0, `${approvalMode} ${toolName} write dispatch`)
      assert.equal(harness.tools.replaceCalls, 0, `${approvalMode} ${toolName} replacement dispatch`)
      assert.equal(
        harness.events.some((event) => event.type === 'approval-request'),
        false,
        `${approvalMode} ${toolName} approval`
      )
      const toolOutput = requestItems(responses.calls[1]?.request).find(
        (item) => 'type' in item && item.type === 'function_call_output'
      )
      assert.ok(toolOutput && 'output' in toolOutput, `${approvalMode} ${toolName} result`)
      assert.equal(toolOutput.output, denial, `${approvalMode} ${toolName} fixed denial`)
    }
  }
})

test('plan mode still routes read_file through request approval and dispatches it after consent', async () => {
  const responses = new SequencedResponses([
    async () => toolResult(),
    async (options) => await finalResult(options, 'The planned read completed.\n')
  ])
  const harness = createHarness(responses)

  await harness.service.start(startInput({ planMode: true, approvalMode: 'request' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'plan-mode read approval request'
  )

  assert.equal(harness.tools.readCalls, 0)
  const approval = harness.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  assert.equal(approval.risk, 'low')
  assert.equal(harness.approvals.resolve(approval.approvalId, 'allow_once'), true)

  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'plan-mode approved read completion'
  )
  assert.equal(harness.tools.readCalls, 1)
  assert.equal(responses.calls.length, 2)
  assert.match(JSON.stringify(requestItems(responses.calls[1]?.request)), /function_call_output/)
})

test('non-boolean planMode fails validation before the model is called', async () => {
  const responses = new SequencedResponses([])
  const harness = createHarness(responses)

  await assert.rejects(
    harness.service.start(startInput({ planMode: 'true' as unknown as boolean })),
    (error: unknown) => error instanceof AgentTurnError && error.code === 'invalid_configuration'
  )
  assert.equal(responses.calls.length, 0)
})

test('Agent rejects a task bound to another workspace before persisting or sampling', async () => {
  const responses = new SequencedResponses([])
  const harness = createHarness(responses)

  await assert.rejects(
    harness.service.start(startInput({
      workspaceProjectId: `project:workspace:${'q'.repeat(43)}`
    })),
    (error: unknown) => error instanceof AgentTurnError && error.code === 'workspace_mismatch'
  )
  assert.equal(harness.history.loadCalls, 1)
  assert.equal(harness.history.appended.length, 0)
  assert.equal(responses.calls.length, 0)
})

test('review mode advertises only bounded review tools and disables remote and delegated features', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_review_tools',
      outputText: '',
      toolCalls: [{ callId: 'call_review_tools', name: 'git_diff', arguments: {} }]
    })
  ])
  const harness = createHarness(responses)

  const started = await harness.service.start(startInput({
    reviewMode: true,
    webSearch: true,
    imageGeneration: true,
    subagentsEnabled: true,
    approvalMode: 'full'
  }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'review-mode capability advertisement'
  )

  const request = responses.calls[0]?.request
  assert.ok(request)
  assert.deepEqual(
    request.tools?.map((tool) => tool.name).sort(),
    ['git_diff', 'git_summary', 'list_directory', 'read_file', 'search_files']
  )
  assert.equal(request.webSearch, false)
  assert.notEqual(request.imageGeneration, true)
  assert.match(request.instructions ?? '', /Code review mode is active/u)
  assert.equal(requestItems(request).some((item) => 'role' in item && item.role === 'developer'), false)
  assert.equal(responses.calls.length, 1)
  assert.equal(harness.approvals.authorizeRequests.length, 1)
  assert.equal(harness.service.cancel(started.turnId), true)
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'cancelled'),
    'review-mode advertisement cancellation'
  )
})

test('review mode cannot complete before an approved Git diff is loaded', async () => {
  const responses = new SequencedResponses([
    async (options) => await finalResult(options, 'Unsupported review conclusion.\n')
  ])
  const harness = createHarness(responses)

  await harness.service.start(startInput({ reviewMode: true }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
    'review mode missing diff failure'
  )
  assert.equal(harness.events.some(
    (event) => event.type === 'turn-status' && event.status === 'completed'
  ), false)
  assert.equal(harness.tools.gitDiffCalls, 0)
  assert.equal(harness.events.some((event) => event.type === 'assistant-delta'), false)
  assert.deepEqual(
    harness.history.appended.map((message) => [message.role, message.content]),
    [['user', 'Inspect src/main.ts and summarize it.']]
  )
})

test('review mode excludes prior task history from the model context', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_review_isolated_context',
      outputText: '',
      toolCalls: [{ callId: 'call_review_isolated_context', name: 'git_diff', arguments: {} }]
    })
  ])
  const harness = createHarness(responses)
  harness.history.messages.push(...priorMessages(2))
  harness.history.messages[0]!.content = 'old-workspace-private-context'

  const started = await harness.service.start(startInput({
    reviewMode: true,
    prompt: '/review inspect only the current authorized workspace'
  }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'isolated review context'
  )

  const firstRequest = JSON.stringify(requestItems(responses.calls[0]?.request))
  assert.match(firstRequest, /inspect only the current authorized workspace/u)
  assert.doesNotMatch(firstRequest, /old-workspace-private-context|encrypted history/u)
  assert.equal(harness.service.cancel(started.turnId), true)
})

test('review discards model text emitted before Git diff approval and activation', async () => {
  const forged = 'Forged finding emitted before any diff was loaded.\n'
  const verified = 'Verified finding based on the approved bounded diff.\n'
  const responses = new SequencedResponses([
    async (options) => {
      await options.onEvent?.({ type: 'response.output_text.delta', delta: forged })
      return {
        responseId: 'response_review_preface',
        outputText: forged,
        toolCalls: [{ callId: 'call_review_preface', name: 'git_diff', arguments: {} }]
      }
    },
    async (options) => await finalResult(options, verified)
  ])
  const harness = createHarness(responses)

  await harness.service.start(startInput({ reviewMode: true }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'review diff activation approval'
  )
  const approval = harness.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  assert.equal(harness.approvals.resolve(approval.approvalId, 'allow_once'), true)
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'review diff activation completion'
  )

  const rendererText = harness.events
    .filter((event): event is Extract<AgentEvent, { type: 'assistant-delta' }> =>
      event.type === 'assistant-delta')
    .map((event) => event.text)
    .join('')
  assert.equal(rendererText, verified)
  assert.doesNotMatch(rendererText, /Forged finding/u)
  assert.doesNotMatch(JSON.stringify(requestItems(responses.calls[1]?.request)), /Forged finding/u)
  assert.equal(harness.history.appended.at(-1)?.role, 'assistant')
  assert.equal(harness.history.appended.at(-1)?.content, verified)
})

test('review git_diff always requires one exact Renderer approval in auto and full modes', async () => {
  for (const approvalMode of ['auto', 'full'] as const) {
    const callId = `call_review_diff_${approvalMode}`
    const responses = new SequencedResponses([
      async () => ({
        responseId: `response_review_diff_${approvalMode}`,
        outputText: '',
        toolCalls: [{ callId, name: 'git_diff', arguments: {} }]
      }),
      async (options) => await finalResult(options, 'The bounded diff was reviewed.\n')
    ])
    const harness = createHarness(responses)

    await harness.service.start(startInput({ reviewMode: true, approvalMode }))
    harness.scheduler.runAll()
    await waitFor(
      () => harness.events.some((event) => event.type === 'approval-request'),
      `${approvalMode} review diff approval`
    )

    const approvalEvents = harness.events.filter(
      (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
        event.type === 'approval-request'
    )
    assert.equal(approvalEvents.length, 1)
    assert.equal(approvalEvents[0]?.risk, 'medium')
    assert.match(approvalEvents[0]?.label ?? '', /bounded Git diff/u)
    assert.equal(harness.approvals.authorizeRequests.length, 1)
    const exactRequest = harness.approvals.authorizeRequests[0]
    assert.ok(exactRequest)
    assert.equal(exactRequest.callId, callId)
    assert.equal(exactRequest.workspaceToken, workspaceToken)
    assert.equal(exactRequest.operation, 'execute')
    assert.equal(exactRequest.toolName, 'git_diff')
    assert.deepEqual(exactRequest.arguments, {})
    assert.equal(exactRequest.risk, 'medium')
    assert.equal(exactRequest.mode, 'request')
    assertNoWorkspaceDispatch(harness.tools)

    assert.equal(harness.approvals.resolve(approvalEvents[0]!.approvalId, 'allow_once'), true)
    assert.equal(harness.approvals.resolve(approvalEvents[0]!.approvalId, 'allow_once'), false)
    await waitFor(
      () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
      `${approvalMode} approved review diff completion`
    )

    assert.equal(harness.events.filter((event) => event.type === 'approval-request').length, 1)
    assert.equal(harness.tools.gitDiffCalls, 1)
    assert.deepEqual(harness.tools.gitDiffInputs, [{ workspaceToken, ownerWebContentsId: 7 }])
    assert.ok(harness.tools.gitDiffSignal instanceof AbortSignal)
    assert.equal(harness.tools.listCalls, 0)
    assert.equal(harness.tools.searchCalls, 0)
    assert.equal(harness.tools.readCalls, 0)
    assert.equal(harness.tools.gitCalls, 0)
    assert.equal(harness.tools.writeCalls, 0)
    assert.equal(harness.tools.replaceCalls, 0)
    const followUp = JSON.stringify(requestItems(responses.calls[1]?.request))
    assert.match(followUp, /begin untrusted redacted git patch/u)
    assert.match(followUp, /src\/main\.ts/u)
  }
})

test('review mode rejects a forged write before approval and local dispatch', async () => {
  const denial = 'Code review mode blocks file writes and delegation. No local operation was performed.'
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_review_forged_write',
      outputText: '',
      toolCalls: [{
        callId: 'call_review_forged_write',
        name: 'write_file',
        arguments: {
          relative_path: 'src/review-bypass.ts',
          content: 'export const bypassed = true\n'
        }
      }]
    }),
    async (options) => await finalResult(options, 'The review remained read-only.\n')
  ])
  const harness = createHarness(responses)

  await harness.service.start(startInput({ reviewMode: true, approvalMode: 'full' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
    'review forged-write rejection'
  )

  assert.equal(harness.approvals.authorizeRequests.length, 0)
  assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
  assertNoWorkspaceDispatch(harness.tools)
  const toolOutput = requestItems(responses.calls[1]?.request).find(
    (item) => 'type' in item && item.type === 'function_call_output'
  )
  assert.ok(toolOutput && 'output' in toolOutput)
  assert.equal(toolOutput.output, denial)
})

test('review mode conflicts and non-boolean values fail closed before history or model access', async () => {
  for (const overrides of [
    { reviewMode: true, planMode: true },
    {
      reviewMode: true,
      attachments: [{
        type: 'input_file' as const,
        filename: 'review-attachment.txt',
        file_data: 'data:text/plain;base64,YQ=='
      }]
    },
    { reviewMode: 'true' as unknown as boolean }
  ]) {
    const responses = new SequencedResponses([])
    const harness = createHarness(responses)
    await assert.rejects(
      harness.service.start(startInput(overrides)),
      (error: unknown) => error instanceof AgentTurnError && error.code === 'invalid_configuration'
    )
    assert.equal(harness.history.loadCalls, 0)
    assert.equal(responses.calls.length, 0)
    assert.equal(harness.approvals.authorizeRequests.length, 0)
    assertNoWorkspaceDispatch(harness.tools)
  }
})

function toolResult(): ResponsesStreamResult {
  return {
    responseId: 'response_tool',
    outputText: '',
    toolCalls: [{
      callId: 'call_read_1',
      name: 'read_file',
      arguments: { relative_path: 'src/main.ts' }
    }]
  }
}

async function finalResult(options: ResponsesStreamOptions, text: string): Promise<ResponsesStreamResult> {
  await options.onEvent?.({ type: 'response.output_text.delta', delta: text })
  return { responseId: 'response_final', outputText: text, toolCalls: [] }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

function assertNoWorkspaceDispatch(tools: FakeWorkspaceTools): void {
  assert.equal(tools.listCalls, 0)
  assert.equal(tools.searchCalls, 0)
  assert.equal(tools.readCalls, 0)
  assert.equal(tools.gitCalls, 0)
  assert.equal(tools.gitDiffCalls, 0)
  assert.equal(tools.writeCalls, 0)
  assert.equal(tools.replaceCalls, 0)
}

test('Agent advertises the bounded search and replacement tools to Responses', async () => {
  const responses = new SequencedResponses([
    async (options) => await finalResult(options, 'Ready for a workspace task.\n')
  ])
  const harness = createHarness(responses)
  await harness.service.start(startInput())
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'tool schema completion'
  )

  const advertised = responses.calls[0]?.request.tools
  assert.ok(advertised)
  assert.equal(advertised.every((tool) => tool.strict === false), true)
  const byName = new Map(advertised.map((tool) => [tool.name, tool]))
  assert.ok(byName.has('search_files'))
  assert.ok(byName.has('replace_in_file'))

  const search = byName.get('search_files')
  assert.ok(search)
  assert.equal(search.type, 'function')
  assert.equal(search.strict, false)
  const searchParameters = search.parameters as Record<string, unknown>
  assert.deepEqual(
    Object.keys(searchParameters.properties as Record<string, unknown>).sort(),
    ['case_sensitive', 'query', 'relative_path']
  )
  assert.deepEqual(searchParameters.required, ['relative_path', 'query', 'case_sensitive'])
  assert.equal(searchParameters.additionalProperties, false)

  const replace = byName.get('replace_in_file')
  assert.ok(replace)
  assert.equal(replace.type, 'function')
  assert.equal(replace.strict, false)
  const replaceParameters = replace.parameters as Record<string, unknown>
  assert.deepEqual(
    Object.keys(replaceParameters.properties as Record<string, unknown>).sort(),
    ['expected_revision', 'new_text', 'old_text', 'relative_path']
  )
  assert.deepEqual(
    replaceParameters.required,
    ['relative_path', 'old_text', 'new_text', 'expected_revision']
  )
  assert.equal(replaceParameters.additionalProperties, false)
})

test('Agent uses top-level instructions and an opaque continuation capsule across tool rounds', async () => {
  const encryptedContent = 'opaque_agent_reasoning_state_0123456789'
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_reasoning_tool',
      outputText: '',
      toolCalls: [{
        callId: 'call_reasoning_read',
        name: 'read_file',
        arguments: { relative_path: 'src/main.ts' }
      }]
    }),
    async (options) => await finalResult(options, 'The reasoning continuation completed.\n')
  ])
  const harness = createHarness(responses)

  await harness.service.start(startInput({ approvalMode: 'auto', reasoning: 'high' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'reasoning continuation completion'
  )

  assert.equal(responses.calls.length, 2)
  assert.match(responses.calls[0]?.request.instructions ?? '', /workspace-relative paths/u)
  assert.equal(
    requestItems(responses.calls[0]?.request).some((item) => 'role' in item && item.role === 'developer'),
    false
  )
  const firstRequest = responses.calls[0]?.request
  const continuationRequest = responses.calls[1]?.request
  assert.ok(continuationRequest?.continuation)
  assert.equal(continuationRequest.messages, undefined)
  assert.match(firstRequest?.promptCacheKey ?? '', /^[A-Za-z0-9_-]{43}$/u)
  assert.equal(continuationRequest.promptCacheKey, firstRequest?.promptCacheKey)
  assert.deepEqual(continuationRequest.continuation.outputs.map((item) => item.type), [
    'function_call_output'
  ])
  assert.equal(continuationRequest.continuation.outputs[0]?.call_id, 'call_reasoning_read')
  assert.doesNotMatch(JSON.stringify(continuationRequest), new RegExp(encryptedContent))
  assert.doesNotMatch(
    JSON.stringify({ events: harness.events, history: harness.history.appended }),
    new RegExp(encryptedContent)
  )
})

test('Lite Agent keeps wire mode and one cache key across its opaque tool continuation', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_lite_tool',
      outputText: '',
      toolCalls: [{
        callId: 'call_lite_read',
        name: 'read_file',
        arguments: { relative_path: 'src/main.ts' }
      }]
    }),
    async (options) => await finalResult(options, 'Lite Agent continuation completed.\n')
  ])
  const harness = createHarness(responses)

  await harness.service.start(startInput({ wireMode: 'lite', approvalMode: 'auto' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'Lite Agent continuation completion'
  )

  const first = responses.calls[0]?.request
  const second = responses.calls[1]?.request
  assert.equal(first?.wireMode, 'lite')
  assert.equal(second?.wireMode, 'lite')
  assert.match(first?.promptCacheKey ?? '', /^[A-Za-z0-9_-]{43}$/u)
  assert.equal(second?.promptCacheKey, first?.promptCacheKey)
  assert.ok(second?.continuation)
  assert.equal(second?.messages, undefined)
  assert.equal(first?.webSearch, false)
  assert.notEqual(first?.imageGeneration, true)
})

test('Agent freezes a credential copy before asynchronous preflight and uses a fresh key per turn', async () => {
  const responses = new SequencedResponses([
    async (options) => await finalResult(options, 'First frozen turn completed.\n'),
    async (options) => await finalResult(options, 'Second frozen turn completed.\n')
  ])
  const harness = createHarness(responses)
  const mutableCredentials = { ...credentials }

  await harness.service.start(startInput({ credentials: mutableCredentials }))
  mutableCredentials.baseUrl = 'https://mutated.example.test/v1'
  mutableCredentials.apiKey = 'sk-mutated-after-start-123456'
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.filter(
      (event) => event.type === 'turn-status' && event.status === 'completed'
    ).length === 1,
    'first frozen Agent turn'
  )

  await harness.service.start(startInput())
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.filter(
      (event) => event.type === 'turn-status' && event.status === 'completed'
    ).length === 2,
    'second frozen Agent turn'
  )

  assert.deepEqual(responses.calls[0]?.credentials, credentials)
  assert.equal(Object.isFrozen(responses.calls[0]?.credentials), true)
  const firstKey = responses.calls[0]?.request.promptCacheKey ?? ''
  const secondKey = responses.calls[1]?.request.promptCacheKey ?? ''
  assert.match(firstKey, /^[A-Za-z0-9_-]{43}$/u)
  assert.match(secondKey, /^[A-Za-z0-9_-]{43}$/u)
  assert.notEqual(firstKey, secondKey)
})

test('Agent redacts the current API key across SSE deltas, tool-loop context, and encrypted history', async () => {
  const apiKey = '!~%'
  const firstOutput = `Endpoint echoed [${apiKey}] before requesting a read.\n`
  const finalOutput = `Final answer omitted [${apiKey}] and remained safe.\n`
  const responses = new SequencedResponses([
    async (options) => {
      await options.onEvent?.({ type: 'response.output_text.delta', delta: 'Endpoint echoed [!' })
      await options.onEvent?.({ type: 'response.output_text.delta', delta: '~' })
      await options.onEvent?.({
        type: 'response.output_text.delta',
        delta: '%] before requesting a read.\n'
      })
      return {
        responseId: 'response_explicit_key_tool',
        outputText: firstOutput,
        toolCalls: [{
          callId: 'call_explicit_key_read',
          name: 'read_file',
          arguments: { relative_path: 'src/main.ts' }
        }]
      }
    },
    async (options) => {
      await options.onEvent?.({ type: 'response.output_text.delta', delta: 'Final answer omitted [!' })
      await options.onEvent?.({ type: 'response.output_text.delta', delta: '~%] and remained safe.\n' })
      return { responseId: 'response_explicit_key_final', outputText: finalOutput, toolCalls: [] }
    }
  ])
  const harness = createHarness(responses)

  await harness.service.start(startInput({
    credentials: { baseUrl: credentials.baseUrl, apiKey },
    approvalMode: 'auto'
  }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'Agent explicit API key redaction completion'
  )

  assert.equal(responses.calls.length, 2)
  const toolLoopContext = JSON.stringify(responses.calls[1]?.request)
  const rendererOutput = harness.events
    .filter((event): event is Extract<AgentEvent, { type: 'assistant-delta' }> =>
      event.type === 'assistant-delta'
    )
    .map((event) => event.text)
    .join('')
  const persistedHistory = JSON.stringify(harness.history.appended)
  for (const value of [toolLoopContext, rendererOutput, persistedHistory]) {
    assert.equal(value.includes(apiKey), false)
    assert.match(value, /<redacted>/u)
  }
  for (const event of harness.events) {
    if (event.type === 'assistant-delta') assert.doesNotMatch(event.text, /[!~%]/u)
  }
  assert.doesNotMatch(toolLoopContext, /before requesting a read/u)
  assert.match(rendererOutput, /before requesting a read/u)
  assert.match(persistedHistory, /remained safe/u)
})

test('Agent keeps the redaction tail across tool rounds before emitting or persisting text', async () => {
  const apiKey = '!~%'
  const responses = new SequencedResponses([
    async (options) => {
      await options.onEvent?.({
        type: 'response.output_text.delta',
        delta: 'Cross-round credential [!'
      })
      return {
        responseId: 'response_cross_round_key_tool',
        outputText: 'Cross-round credential [!',
        toolCalls: [{
          callId: 'call_cross_round_key_read',
          name: 'read_file',
          arguments: { relative_path: 'src/main.ts' }
        }]
      }
    },
    async (options) => {
      await options.onEvent?.({
        type: 'response.output_text.delta',
        delta: '~%] was removed.\n'
      })
      return {
        responseId: 'response_cross_round_key_final',
        outputText: '~%] was removed.\n',
        toolCalls: []
      }
    }
  ])
  const harness = createHarness(responses)

  await harness.service.start(startInput({
    credentials: { baseUrl: credentials.baseUrl, apiKey },
    approvalMode: 'auto'
  }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'cross-round API key redaction completion'
  )

  const rendererOutput = harness.events
    .filter((event): event is Extract<AgentEvent, { type: 'assistant-delta' }> =>
      event.type === 'assistant-delta'
    )
    .map((event) => event.text)
    .join('')
  const persistedHistory = JSON.stringify(harness.history.appended)
  for (const value of [rendererOutput, persistedHistory]) {
    assert.equal(value.includes(apiKey), false)
    assert.match(value, /Cross-round credential \[<redacted>\] was removed/u)
  }
})

test('request mode gates low-risk search_files and dispatches only after approval', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_search_request',
      outputText: '',
      toolCalls: [{
        callId: 'call_search_request',
        name: 'search_files',
        arguments: {
          relative_path: '.',
          query: 'safe',
          case_sensitive: true
        }
      }]
    }),
    async (options) => await finalResult(options, 'The literal search completed.\n')
  ])
  const harness = createHarness(responses)
  await harness.service.start(startInput({ prompt: 'Find the safe marker.' }))
  harness.scheduler.runAll()

  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'search approval request'
  )
  assert.equal(harness.tools.searchCalls, 0)
  const approval = harness.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  assert.equal(approval.risk, 'low')
  assert.equal(harness.approvals.resolve(approval.approvalId, 'allow_once'), true)

  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'search approval completion'
  )
  assert.equal(harness.tools.searchCalls, 1)
  assert.deepEqual(harness.tools.searchInputs[0], {
    workspaceToken,
    relativePath: '.',
    query: 'safe',
    caseSensitive: true
  })
  assert.ok(harness.tools.searchSignal instanceof AbortSignal)
  assert.match(JSON.stringify(requestItems(responses.calls[1]?.request)), /src\/main\.ts/u)
})

test('auto mode executes low-risk search_files without a Renderer approval event', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_search_auto',
      outputText: '',
      toolCalls: [{
        callId: 'call_search_auto',
        name: 'search_files',
        arguments: {
          relative_path: 'src',
          query: 'safe',
          case_sensitive: false
        }
      }]
    }),
    async (options) => await finalResult(options, 'Auto search completed.\n')
  ])
  const harness = createHarness(responses)
  await harness.service.start(startInput({ approvalMode: 'auto' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'auto search completion'
  )

  assert.equal(harness.tools.searchCalls, 1)
  assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
  assert.deepEqual(harness.tools.searchInputs[0], {
    workspaceToken,
    relativePath: 'src',
    query: 'safe',
    caseSensitive: false
  })
})

test('replace_in_file is medium risk and dispatches the exact revisioned edit after approval', async () => {
  const expectedRevision = 'a'.repeat(64)
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_replace_request',
      outputText: '',
      toolCalls: [{
        callId: 'call_replace_request',
        name: 'replace_in_file',
        arguments: {
          relative_path: 'src/main.ts',
          old_text: 'export const safe = true;',
          new_text: 'export const safe = false;',
          expected_revision: expectedRevision
        }
      }]
    }),
    async (options) => await finalResult(options, 'The revisioned edit was applied.\n')
  ])
  const harness = createHarness(responses)
  await harness.service.start(startInput({ prompt: 'Disable the safe marker.' }))
  harness.scheduler.runAll()

  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'replacement approval request'
  )
  assert.equal(harness.tools.replaceCalls, 0)
  const approval = harness.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  assert.equal(approval.risk, 'medium')
  assert.equal(harness.approvals.resolve(approval.approvalId, 'allow_once'), true)

  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'replacement completion'
  )
  assert.equal(harness.tools.replaceCalls, 1)
  assert.deepEqual(harness.tools.replaceInputs[0], {
    workspaceToken,
    relativePath: 'src/main.ts',
    oldText: 'export const safe = true;',
    newText: 'export const safe = false;',
    expectedRevision
  })
  assert.ok(harness.tools.replaceSignal instanceof AbortSignal)
  assert.match(JSON.stringify(requestItems(responses.calls[1]?.request)), /New revision/u)
  assert.match(JSON.stringify(requestItems(responses.calls[1]?.request)), /b{64}/u)
})

test('replace_in_file rejects credential-bearing new_text before approval and local dispatch', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_replace_credential',
      outputText: '',
      toolCalls: [{
        callId: 'call_replace_credential',
        name: 'replace_in_file',
        arguments: {
          relative_path: 'src/main.ts',
          old_text: 'export const safe = true;',
          new_text: `export const apiKey = "${credentials.apiKey}";`,
          expected_revision: 'a'.repeat(64)
        }
      }]
    }),
    async (options) => await finalResult(options, 'The local credential policy blocked the replacement.\n')
  ])
  const harness = createHarness(responses)
  await harness.service.start(startInput())
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'credential replacement completion'
  )

  assert.equal(harness.tools.replaceCalls, 0)
  assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
  const toolOutput = requestItems(responses.calls[1]?.request).find(
    (item) => 'type' in item && item.type === 'function_call_output'
  )
  assert.ok(toolOutput && 'output' in toolOutput)
  assert.match(toolOutput.output, /credential policy denied/i)
  assert.doesNotMatch(JSON.stringify(harness.events), new RegExp(credentials.apiKey))
})

test('invalid replacement revision, path, and extra fields fail before approval or dispatch', async () => {
  const invalidCalls: Array<{ label: string; arguments: ResponsesJsonObject }> = [
    {
      label: 'revision',
      arguments: {
        relative_path: 'src/main.ts',
        old_text: 'safe',
        new_text: 'unsafe',
        expected_revision: 'not-a-sha'
      }
    },
    {
      label: 'path',
      arguments: {
        relative_path: '../outside.ts',
        old_text: 'safe',
        new_text: 'unsafe',
        expected_revision: 'a'.repeat(64)
      }
    },
    {
      label: 'extra-field',
      arguments: {
        relative_path: 'src/main.ts',
        old_text: 'safe',
        new_text: 'unsafe',
        expected_revision: 'a'.repeat(64),
        unexpected: true
      }
    }
  ]

  for (const invalidCall of invalidCalls) {
    const responses = new SequencedResponses([
      async () => ({
        responseId: `response_invalid_replace_${invalidCall.label}`,
        outputText: '',
        toolCalls: [{
          callId: `call_invalid_replace_${invalidCall.label}`,
          name: 'replace_in_file',
          arguments: invalidCall.arguments
        }]
      })
    ])
    const harness = createHarness(responses)
    await harness.service.start(startInput())
    harness.scheduler.runAll()
    await waitFor(
      () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
      `invalid replacement ${invalidCall.label}`
    )
    assert.equal(harness.tools.replaceCalls, 0, invalidCall.label)
    assert.equal(harness.events.some((event) => event.type === 'approval-request'), false, invalidCall.label)
  }
})

test('cancelling while search approval is pending revokes the approval and never searches', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_search_cancel',
      outputText: '',
      toolCalls: [{
        callId: 'call_search_cancel',
        name: 'search_files',
        arguments: {
          relative_path: '.',
          query: 'safe',
          case_sensitive: true
        }
      }]
    })
  ])
  const harness = createHarness(responses)
  const started = await harness.service.start(startInput())
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'search cancellation approval request'
  )

  assert.equal(harness.service.cancel(started.turnId), true)
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'cancelled'),
    'search cancellation completion'
  )
  assert.equal(harness.tools.searchCalls, 0)
  const approval = harness.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  assert.equal(harness.approvals.resolve(approval.approvalId, 'allow_once'), false)
})

test('manual approval gates the exact read and feeds a redacted tool result into the next sampling', async () => {
  const responses = new SequencedResponses([
    async () => toolResult(),
    async (options) => await finalResult(options, 'The file exports a safe boolean.\n')
  ])
  const harness = createHarness(responses)
  const started = await harness.service.start(startInput())
  harness.scheduler.runAll()

  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'approval request'
  )
  assert.equal(harness.tools.readCalls, 0)
  const approval = harness.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  assert.equal(harness.approvals.resolve(approval.approvalId, 'allow_once'), true)

  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'completed turn'
  )
  assert.match(started.turnId, /^turn_[A-Za-z0-9_-]{32}$/)
  assert.equal(harness.tools.readCalls, 1)
  assert.equal(responses.calls.length, 2)
  const followUp = JSON.stringify(requestItems(responses.calls[1]?.request))
  assert.match(followUp, /function_call_output/)
  assert.match(followUp, /src\/main\.ts/)
  assert.doesNotMatch(followUp, /sk-agent-test-secret|sk-file-secret/)
  assert.equal(harness.history.appended.at(-1)?.content, 'The file exports a safe boolean.\n')
  assert.equal(harness.history.appended.at(-1)?.status, 'complete')
})

test('denial produces a bounded tool output and never touches the workspace', async () => {
  const responses = new SequencedResponses([
    async () => toolResult(),
    async (options) => await finalResult(options, 'I could not read the file because approval was denied.\n')
  ])
  const harness = createHarness(responses)
  await harness.service.start(startInput())
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'approval request'
  )
  const approval = harness.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  harness.approvals.resolve(approval.approvalId, 'deny')
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'completed denial turn'
  )
  assert.equal(harness.tools.readCalls, 0)
  assert.match(JSON.stringify(requestItems(responses.calls[1]?.request)), /denied this exact local tool call/)
})

test('auto mode executes the low-risk read without a Renderer approval event', async () => {
  const responses = new SequencedResponses([
    async () => toolResult(),
    async (options) => await finalResult(options, 'Auto-reviewed read completed.\n')
  ])
  const harness = createHarness(responses)
  await harness.service.start(startInput({ approvalMode: 'auto' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'auto completed turn'
  )
  assert.equal(harness.tools.readCalls, 1)
  assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
})

test('list_directory uses the exact approval broker and returns only bounded relative entry metadata', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_list',
      outputText: '',
      toolCalls: [{
        callId: 'call_list_1',
        name: 'list_directory',
        arguments: { relative_path: '.' }
      }]
    }),
    async (options) => await finalResult(options, 'The workspace contains README.md and src.\n')
  ])
  const harness = createHarness(responses)
  await harness.service.start(startInput({ prompt: 'List the workspace root.' }))
  harness.scheduler.runAll()

  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'directory approval request'
  )
  assert.equal(harness.tools.listCalls, 0)
  const approval = harness.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  assert.equal(approval.risk, 'low')
  assert.match(approval.label, /directory/u)
  harness.approvals.resolve(approval.approvalId, 'allow_once')

  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'directory completed turn'
  )
  assert.equal(harness.tools.listCalls, 1)
  assert.ok(harness.tools.listSignal instanceof AbortSignal)
  assert.ok(responses.calls[0]?.request.tools?.some((tool) => tool.name === 'list_directory'))
  const followUp = JSON.stringify(requestItems(responses.calls[1]?.request))
  assert.match(followUp, /README\.md/u)
  assert.match(followUp, /directory\\tsrc/u)
  assert.match(followUp, /Truncated: no/u)
  assert.doesNotMatch(followUp, /(?:size|mtime|ctime|birthtime|[A-Za-z]:\\\\)/u)
})

test('list_directory follows auto and full approval policy without Renderer approval prompts', async () => {
  for (const approvalMode of ['auto', 'full'] as const) {
    const responses = new SequencedResponses([
      async () => ({
        responseId: `response_list_${approvalMode}`,
        outputText: '',
        toolCalls: [{
          callId: `call_list_${approvalMode}`,
          name: 'list_directory',
          arguments: { relative_path: 'src' }
        }]
      }),
      async (options) => await finalResult(options, 'Directory inspected.\n')
    ])
    const harness = createHarness(responses)
    await harness.service.start(startInput({ approvalMode }))
    harness.scheduler.runAll()
    await waitFor(
      () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
      `${approvalMode} directory completion`
    )
    assert.equal(harness.tools.listCalls, 1)
    assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
  }
})

test('invalid list_directory paths fail before approval or workspace enumeration', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_invalid_list',
      outputText: '',
      toolCalls: [{
        callId: 'call_invalid_list',
        name: 'list_directory',
        arguments: { relative_path: './src' }
      }]
    })
  ])
  const harness = createHarness(responses)
  await harness.service.start(startInput())
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
    'invalid directory tool failure'
  )
  assert.equal(harness.tools.listCalls, 0)
  assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
  assert.doesNotMatch(JSON.stringify(harness.events), /\.\/src/u)
})

test('write_file uses the same exact approval broker and reports the committed revision', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_write',
      outputText: '',
      toolCalls: [{
        callId: 'call_write_1',
        name: 'write_file',
        arguments: {
          relative_path: 'src/generated.ts',
          content: 'export const generated = true\n'
        }
      }]
    }),
    async (options) => await finalResult(options, 'The workspace file was created.\n')
  ])
  const harness = createHarness(responses)
  await harness.service.start(startInput({ prompt: 'Create src/generated.ts.' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'write approval request'
  )
  assert.equal(harness.tools.writeCalls, 0)
  const approval = harness.events.find(
    (event): event is Extract<AgentEvent, { type: 'approval-request' }> =>
      event.type === 'approval-request'
  )
  assert.ok(approval)
  assert.equal(approval.risk, 'medium')
  harness.approvals.resolve(approval.approvalId, 'allow_once')
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'write completed turn'
  )
  assert.equal(harness.tools.writeCalls, 1)
  assert.match(JSON.stringify(requestItems(responses.calls[1]?.request)), /New revision/)
})

test('auto mode does not silently approve write_file without an eligible reviewer decision', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_auto_write',
      outputText: '',
      toolCalls: [{
        callId: 'call_write_auto',
        name: 'write_file',
        arguments: { relative_path: 'src/blocked.ts', content: 'blocked\n' }
      }]
    }),
    async (options) => await finalResult(options, 'The write was not approved by policy.\n')
  ])
  const harness = createHarness(responses)
  await harness.service.start(startInput({ approvalMode: 'auto' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'auto write denial completion'
  )
  assert.equal(harness.tools.writeCalls, 0)
  assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
})

test('invalid model paths fail closed before approval or filesystem access', async () => {
  const responses = new SequencedResponses([
    async () => ({
      responseId: 'response_invalid',
      outputText: '',
      toolCalls: [{
        callId: 'call_invalid_1',
        name: 'read_file',
        arguments: { relative_path: '../outside.txt' }
      }]
    })
  ])
  const harness = createHarness(responses)
  await harness.service.start(startInput())
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
    'invalid tool failure'
  )
  assert.equal(harness.tools.readCalls, 0)
  assert.equal(harness.events.some((event) => event.type === 'approval-request'), false)
  assert.doesNotMatch(JSON.stringify(harness.events), /outside\.txt|\.\./)
})

test('cancelling while approval is pending revokes it and produces one terminal state', async () => {
  const responses = new SequencedResponses([async () => toolResult()])
  const harness = createHarness(responses)
  const started = await harness.service.start(startInput())
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'approval-request'),
    'approval request'
  )
  assert.equal(harness.service.cancel(started.turnId), true)
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'cancelled'),
    'cancelled turn'
  )
  assert.equal(harness.tools.readCalls, 0)
  const terminal = harness.events.filter(
    (event) => event.type === 'turn-status' && ['completed', 'failed', 'cancelled'].includes(event.status)
  )
  assert.deepEqual(terminal.map((event) => event.type === 'turn-status' ? event.status : ''), ['cancelled'])
})

function delegationResult(
  tasks: readonly Array<{ task: string; paths?: readonly string[] }>,
  callId = 'call_delegate_1'
): ResponsesStreamResult {
  return {
    responseId: 'response_delegate',
    outputText: '',
    toolCalls: [{
      callId,
      name: 'delegate_tasks',
      arguments: {
        tasks: tasks.map((task) => task.paths
          ? { task: task.task, paths: [...task.paths] }
          : { task: task.task })
      }
    }]
  }
}

test('delegate_tasks is absent when disabled and an unadvertised call fails closed', async () => {
  const responses = new SequencedResponses([
    async () => delegationResult([{ task: 'Inspect the workspace structure.' }])
  ])
  const harness = createHarness(responses)
  await harness.service.start(startInput({ subagentsEnabled: false, approvalMode: 'auto' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
    'disabled delegation rejection'
  )

  assert.equal(responses.calls[0]?.request.tools?.some((tool) => tool.name === 'delegate_tasks'), false)
  assert.equal(responses.calls.length, 1)
  assert.equal(harness.tools.listCalls + harness.tools.searchCalls + harness.tools.readCalls, 0)
})

test('delegate_tasks advertises a bounded non-strict schema and rejects a four-task batch locally', async () => {
  const responses = new SequencedResponses([
    async () => delegationResult([
      { task: 'Inspect module one.' },
      { task: 'Inspect module two.' },
      { task: 'Inspect module three.' },
      { task: 'Inspect module four.' }
    ])
  ])
  const harness = createHarness(responses)
  await harness.service.start(startInput({ subagentsEnabled: true, approvalMode: 'auto' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
    'oversized delegation rejection'
  )

  const delegate = responses.calls[0]?.request.tools?.find((tool) => tool.name === 'delegate_tasks')
  assert.ok(delegate)
  assert.equal(delegate.strict, false)
  const properties = delegate.parameters.properties as Record<string, Record<string, unknown>>
  assert.equal(properties.tasks?.minItems, 1)
  assert.equal(properties.tasks?.maxItems, 3)
  assert.equal(responses.calls.length, 1)
})

test('delegate_tasks rejects Windows root-relative paths before starting a child request', async () => {
  const responses = new SequencedResponses([
    async () => delegationResult([{
      task: 'Inspect `\\Windows\\System32\\config\\SAM` for configuration details.'
    }])
  ])
  const harness = createHarness(responses)
  await harness.service.start(startInput({ subagentsEnabled: true, approvalMode: 'auto' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
    'Windows root-relative delegation rejection'
  )

  assert.equal(responses.calls.length, 1)
  assert.equal(harness.tools.listCalls + harness.tools.searchCalls + harness.tools.readCalls, 0)
  assert.doesNotMatch(JSON.stringify(harness.events), /Windows|System32|SAM/u)
})

test('subagents expose only read tools and reject a malicious write without local dispatch', async () => {
  const responses = new SequencedResponses([
    async () => delegationResult([{ task: 'Inspect generated source files.', paths: ['src'] }]),
    async () => ({
      responseId: 'response_subagent_write',
      outputText: '',
      toolCalls: [{
        callId: 'child_write_call',
        name: 'write_file',
        arguments: { relative_path: 'src/blocked.ts', content: 'blocked\n' }
      }]
    }),
    async (options) => await finalResult(options, 'The read-only delegation could not perform a write.\n')
  ])
  const harness = createHarness(responses)
  await harness.service.start(startInput({ subagentsEnabled: true, approvalMode: 'full' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'read-only subagent write rejection'
  )

  assert.deepEqual(
    responses.calls[1]?.request.tools?.map((tool) => tool.name).sort(),
    ['list_directory', 'read_file', 'search_files']
  )
  assert.equal(responses.calls[1]?.request.webSearch, false)
  assert.equal(responses.calls[1]?.request.imageGeneration, false)
  assert.equal(harness.tools.writeCalls, 0)
  assert.doesNotMatch(JSON.stringify(harness.events), /blocked\.ts|blocked\\n/u)
})

test('delegation returns bounded partial results and redacts child output and raw failures', async () => {
  const apiKey = '!~%'
  const responses = new SequencedResponses([
    async () => delegationResult([
      { task: 'Summarize the first module.', paths: ['src'] },
      { task: 'Summarize the second module.', paths: ['tests'] }
    ], 'call_delegate_partial'),
    async (options) => {
      await options.onEvent?.({ type: 'response.output_text.delta', delta: 'Evidence [!' })
      await options.onEvent?.({
        type: 'response.output_text.delta',
        delta: '~%] referenced C:\\private\\secret.ts but the safe result remained useful.\n'
      })
      return {
        responseId: 'response_subagent_safe',
        outputText: `Evidence [${apiKey}] referenced C:\\private\\secret.ts but the safe result remained useful.\n`,
        toolCalls: []
      }
    },
    async () => {
      throw new Error(`raw child failure ${apiKey} at C:\\private\\failure.log`)
    },
    async (options) => await finalResult(options, 'One investigation completed and one failed safely.\n')
  ])
  const harness = createHarness(responses)
  await harness.service.start(startInput({
    credentials: { baseUrl: credentials.baseUrl, apiKey },
    subagentsEnabled: true,
    approvalMode: 'auto'
  }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'partial delegation completion'
  )

  const parentFollowUp = requestItems(responses.calls.at(-1)?.request)
  const batchOutput = parentFollowUp.find(
    (item) => 'type' in item && item.type === 'function_call_output' && item.call_id === 'call_delegate_partial'
  )
  assert.ok(batchOutput && 'output' in batchOutput)
  assert.match(batchOutput.output, /"ok":false/u)
  assert.match(batchOutput.output, /"code":"completed"/u)
  assert.match(batchOutput.output, /"code":"failed"/u)
  assert.match(batchOutput.output, /<redacted>|<local-path>/u)
  for (const value of [batchOutput.output, JSON.stringify(harness.events), JSON.stringify(harness.history.appended)]) {
    assert.equal(value.includes(apiKey), false)
    assert.doesNotMatch(value, /C:\\private|raw child failure|failure\.log/u)
  }
  const taskStatuses = harness.events.filter(
    (event): event is Extract<AgentEvent, { type: 'tool-status' }> =>
      event.type === 'tool-status' && event.callId.startsWith('subagent:task:')
  )
  assert.equal(taskStatuses.some((event) => event.callId === 'subagent:task:1' && event.status === 'completed'), true)
  assert.equal(taskStatuses.some((event) => event.callId === 'subagent:task:2' && event.status === 'failed'), true)
})

test('subagent cancellation aborts the active child stream and produces one cancelled parent state', async () => {
  let childSignal: AbortSignal | undefined
  const responses = new SequencedResponses([
    async () => delegationResult([{ task: 'Inspect the workspace until cancelled.' }]),
    async (options) => await new Promise<ResponsesStreamResult>((_resolve, reject) => {
      childSignal = options.signal
      if (options.signal?.aborted) {
        reject(new Error('cancelled child stream'))
        return
      }
      options.signal?.addEventListener('abort', () => reject(new Error('cancelled child stream')), {
        once: true
      })
    })
  ])
  const harness = createHarness(responses)
  const started = await harness.service.start(startInput({
    subagentsEnabled: true,
    approvalMode: 'auto'
  }))
  harness.scheduler.runAll()
  await waitFor(() => responses.calls.length === 2, 'active child stream')
  assert.equal(harness.service.cancel(started.turnId), true)
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'cancelled'),
    'cancelled delegated turn'
  )

  assert.equal(childSignal?.aborted, true)
  const terminal = harness.events.filter(
    (event) => event.type === 'turn-status' && ['completed', 'failed', 'cancelled'].includes(event.status)
  )
  assert.deepEqual(terminal.map((event) => event.type === 'turn-status' ? event.status : ''), ['cancelled'])
})

test('request mode serializes subagents while auto mode runs at most three concurrently', async () => {
  for (const [approvalMode, expectedMaximum] of [['request', 1], ['auto', 3]] as const) {
    const calls: ResponseCall[] = []
    let parentCalls = 0
    let activeChildren = 0
    let maximumChildren = 0
    const responses: AgentTurnServiceOptions['responses'] = {
      async stream(callCredentials, request, options = {}) {
        calls.push({ credentials: callCredentials, request, options })
        const isParent = request.tools?.some((tool) => tool.name === 'delegate_tasks') ?? false
        if (isParent) {
          parentCalls += 1
          if (parentCalls === 1) {
            return withTestContinuation(delegationResult([
              { task: 'Inspect module one.' },
              { task: 'Inspect module two.' },
              { task: 'Inspect module three.' }
            ]))
          }
          return await finalResult(options, 'Delegated investigations completed.\n')
        }
        activeChildren += 1
        maximumChildren = Math.max(maximumChildren, activeChildren)
        await new Promise<void>((resolve) => setTimeout(resolve, 15))
        activeChildren -= 1
        return await finalResult(options, 'Bounded child result.\n')
      }
    }
    const harness = createHarness(responses)
    await harness.service.start(startInput({ subagentsEnabled: true, approvalMode }))
    harness.scheduler.runAll()
    await waitFor(
      () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
      `${approvalMode} delegated concurrency completion`
    )
    assert.equal(maximumChildren, expectedMaximum)
    assert.equal(calls.filter((call) => !call.request.tools?.some((tool) => tool.name === 'delegate_tasks')).length, 3)
  }
})

test('workspace failures are folded into fixed whitelist result codes without raw diagnostics', async () => {
  for (const [workspaceCode, expectedCode] of [
    ['path_not_found', 'not_found'],
    ['file_too_large', 'too_large']
  ] as const) {
    const responses = new SequencedResponses([
      async () => toolResult(),
      async (options) => await finalResult(options, 'The workspace read failed safely.\n')
    ])
    const harness = createHarness(responses)
    harness.tools.readError = new WorkspaceToolError(workspaceCode)
    await harness.service.start(startInput({ approvalMode: 'auto' }))
    harness.scheduler.runAll()
    await waitFor(
      () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
      `${workspaceCode} fixed result completion`
    )
    const output = requestItems(responses.calls[1]?.request).find(
      (item) => 'type' in item && item.type === 'function_call_output'
    )
    assert.ok(output && 'output' in output)
    assert.equal(output.output, `{"ok":false,"code":"${expectedCode}"}`)
    assert.doesNotMatch(output.output, /workspace|src\/main|requested|diagnostic/i)
  }
})

test('subagent read failures reuse the same fixed workspace result code', async () => {
  const responses = new SequencedResponses([
    async () => delegationResult([{ task: 'Inspect the requested source file.', paths: ['src/main.ts'] }]),
    async () => toolResult(),
    async (options) => await finalResult(options, 'The requested read was unavailable.\n'),
    async (options) => await finalResult(options, 'The delegated read failed safely.\n')
  ])
  const harness = createHarness(responses)
  harness.tools.readError = new WorkspaceToolError('path_not_found')
  await harness.service.start(startInput({ subagentsEnabled: true, approvalMode: 'auto' }))
  harness.scheduler.runAll()
  await waitFor(
    () => harness.events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'subagent fixed workspace failure completion'
  )

  const childToolOutput = requestItems(responses.calls[2]?.request).find(
    (item) => 'type' in item && item.type === 'function_call_output'
  )
  assert.ok(childToolOutput && 'output' in childToolOutput)
  assert.equal(childToolOutput.output, '{"ok":false,"code":"not_found"}')
  const batchOutput = requestItems(responses.calls[3]?.request).find(
    (item) => 'type' in item && item.type === 'function_call_output'
  )
  assert.ok(batchOutput && 'output' in batchOutput)
  assert.doesNotMatch(batchOutput.output, /requested workspace file|src\/main\.ts/u)
  const parentKey = responses.calls[0]?.request.promptCacheKey
  const childKey = responses.calls[1]?.request.promptCacheKey
  assert.match(parentKey ?? '', /^[A-Za-z0-9_-]{43}$/u)
  assert.match(childKey ?? '', /^[A-Za-z0-9_-]{43}$/u)
  assert.notEqual(parentKey, childKey)
  assert.equal(responses.calls[2]?.request.promptCacheKey, childKey)
  assert.equal(responses.calls[3]?.request.promptCacheKey, parentKey)
  assert.ok(responses.calls[2]?.request.continuation)
  assert.ok(responses.calls[3]?.request.continuation)
  assert.equal(responses.calls[2]?.request.messages, undefined)
  assert.equal(responses.calls[3]?.request.messages, undefined)
})

test('shutdown waits for an active Agent stream to settle and rejects new turns', async () => {
  let observedSignal: AbortSignal | undefined
  const responses = {
    async stream(
      _credentials: ResponsesCredentials,
      _request: ResponsesStreamRequest,
      options: ResponsesStreamOptions = {}
    ): Promise<ResponsesStreamResult> {
      observedSignal = options.signal
      return await new Promise<ResponsesStreamResult>((_resolve, reject) => {
        const cancel = (): void => reject(new Error('private agent shutdown marker'))
        if (options.signal?.aborted) cancel()
        else options.signal?.addEventListener('abort', cancel, { once: true })
      })
    }
  }
  const harness = createHarness(responses)
  await harness.service.start(startInput())
  harness.scheduler.runAll()
  await waitFor(() => observedSignal !== undefined, 'active Agent shutdown stream')

  const shutdown = harness.service.shutdown()
  assert.equal(observedSignal?.aborted, true)
  await shutdown
  assert.equal(harness.events.filter(
    (event) => event.type === 'turn-status' && event.status === 'cancelled'
  ).length, 1)
  assert.doesNotMatch(JSON.stringify(harness.events), /private agent shutdown marker/)
  await assert.rejects(
    harness.service.start(startInput()),
    (error: unknown) => error instanceof AgentTurnError && error.code === 'disposed'
  )
})
