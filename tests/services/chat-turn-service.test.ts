import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  AgentEvent,
  ConversationMessageDto,
  ConversationSnapshot,
  TaskSummary,
  WorkspaceMode
} from '../../src/shared/contracts.ts'
import { TurnRegistry, TurnRegistryError } from '../../src/main/runtime/turn-registry.ts'
import {
  ChatTurnError,
  ChatTurnService,
  type ChatTurnServiceOptions,
  type ChatTurnStartInput
} from '../../src/main/services/chat-turn-service.ts'
import type { ConversationMessageAppendInput } from '../../src/main/services/conversation-history-service.ts'
import {
  ResponsesClientError,
  type ResponsesCredentials,
  type ResponsesMessage,
  type ResponsesStreamEvent,
  type ResponsesStreamOptions,
  type ResponsesStreamRequest,
  type ResponsesStreamResult
} from '../../src/main/services/responses-client.ts'

const FIXED_TIME = '2026-07-15T00:00:00.000Z'
const SAFE_CREDENTIALS: ResponsesCredentials = {
  baseUrl: 'https://example.test/v1',
  apiKey: 'sk-testCredentialNeverExposed123'
}

class FakeHistory {
  readonly tasks = new Map<string, { task: TaskSummary; messages: ConversationMessageDto[] }>()
  readonly appended: ConversationMessageAppendInput[] = []
  loadCalls = 0
  #messageSequence = 0

  addTask(taskId: string, mode: WorkspaceMode = 'chat', messages: ConversationMessageDto[] = []): void {
    this.tasks.set(taskId, {
      task: {
        id: taskId,
        projectId: 'project:test',
        title: 'Test task',
        mode,
        updatedAt: FIXED_TIME,
        archivedAt: null,
        status: 'idle'
      },
      messages: messages.map((message) => ({ ...message }))
    })
  }

  async load(taskId: string): Promise<ConversationSnapshot> {
    this.loadCalls += 1
    const stored = this.tasks.get(taskId)
    if (!stored) throw new Error('fixed fake not found')
    return {
      task: { ...stored.task },
      messages: stored.messages.map((message) => ({ ...message })),
      events: []
    }
  }

  async appendMessage(input: ConversationMessageAppendInput): Promise<{
    id: string
    taskId: string
    role: ConversationMessageDto['role']
    status: ConversationMessageDto['status']
    createdAt: string
    updatedAt: string
  }> {
    const stored = this.tasks.get(input.taskId)
    if (!stored) throw new Error('fixed fake not found')
    this.appended.push({ ...input })
    const message: ConversationMessageDto = {
      id: `message:test-${++this.#messageSequence}`,
      role: input.role,
      content: input.content,
      status: input.status ?? 'complete',
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME
    }
    stored.messages.push(message)
    return {
      id: message.id,
      taskId: input.taskId,
      role: message.role,
      status: message.status,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt
    }
  }

  async updateMessageStatus(input: {
    taskId: string
    messageId: string
    status: ConversationMessageDto['status']
  }): Promise<{
    id: string
    taskId: string
    role: ConversationMessageDto['role']
    status: ConversationMessageDto['status']
    createdAt: string
    updatedAt: string
  }> {
    const stored = this.tasks.get(input.taskId)
    const message = stored?.messages.find((candidate) => candidate.id === input.messageId)
    if (!message) throw new Error('fixed fake not found')
    message.status = input.status
    message.updatedAt = FIXED_TIME
    return {
      id: message.id,
      taskId: input.taskId,
      role: message.role,
      status: message.status,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt
    }
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

interface StreamCall {
  credentials: ResponsesCredentials
  request: ResponsesStreamRequest
  options: ResponsesStreamOptions
}

type StreamImplementation = (
  credentials: ResponsesCredentials,
  request: ResponsesStreamRequest,
  options: ResponsesStreamOptions
) => Promise<ResponsesStreamResult>

class FakeResponses {
  readonly calls: StreamCall[] = []
  readonly #implementation: StreamImplementation

  constructor(implementation: StreamImplementation) {
    this.#implementation = implementation
  }

  async stream(
    credentials: ResponsesCredentials,
    request: ResponsesStreamRequest,
    options: ResponsesStreamOptions = {}
  ): Promise<ResponsesStreamResult> {
    this.calls.push({ credentials, request, options })
    return this.#implementation(credentials, request, options)
  }
}

function startInput(taskId: string, prompt = 'new user prompt'): ChatTurnStartInput {
  return {
    taskId,
    prompt,
    credentials: SAFE_CREDENTIALS,
    model: 'gpt-test',
    wireMode: 'standard',
    modelCapabilities: {
      attachments: true,
      imageInput: true,
      imageGeneration: true,
      subagents: false,
      toolUse: false,
      webSearch: true
    },
    reasoning: 'high',
    webSearch: true,
    imageGeneration: false,
    attachments: [],
    ownerWebContentsId: 7
  }
}

function priorMessage(role: ConversationMessageDto['role'], content: string): ConversationMessageDto {
  return {
    id: `message:prior-${role}`,
    role,
    content,
    status: 'complete',
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME
  }
}

function priorMessages(count: number): ConversationMessageDto[] {
  return Array.from({ length: count }, (_, index) => {
    const role: ConversationMessageDto['role'] = index % 2 === 0 ? 'user' : 'assistant'
    return {
      ...priorMessage(role, `encrypted history ${index + 1}`),
      id: `message:prior-${index + 1}`
    }
  })
}

async function deliver(options: ResponsesStreamOptions, event: ResponsesStreamEvent): Promise<void> {
  await options.onEvent?.(event)
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.fail(`Timed out waiting for ${label}.`)
}

function serviceHarness(
  history: ChatTurnServiceOptions['history'],
  responses: FakeResponses,
  scheduler: ManualScheduler,
  options: {
    registry?: TurnRegistry
    events?: AgentEvent[]
    imageResults?: ChatTurnServiceOptions['imageResults']
  } = {}
): { service: ChatTurnService; events: AgentEvent[] } {
  const events = options.events ?? []
  const serviceOptions: ChatTurnServiceOptions = {
    history,
    responses,
    imageResults: options.imageResults,
    registry: options.registry,
    onEvent: (event) => events.push(event),
    schedule: scheduler.schedule
  }
  return { service: new ChatTurnService(serviceOptions), events }
}

test('current-turn attachments reach the model as multimodal parts without entering encrypted text history', async () => {
  const taskId = 'task:chat-attachments'
  const history = new FakeHistory()
  history.addTask(taskId)
  const scheduler = new ManualScheduler()
  const responses = new FakeResponses(async (_credentials, _request, options) => {
    await deliver(options, { type: 'response.output_text.delta', delta: 'Attachment handled.\n' })
    return { responseId: 'response_attachment', outputText: 'Attachment handled.\n', toolCalls: [] }
  })
  const { service, events } = serviceHarness(history, responses, scheduler)
  const fileData = Buffer.from('safe redacted attachment').toString('base64')

  await service.start({
    ...startInput(taskId),
    attachments: [{
      type: 'input_file',
      filename: 'attachment-1.txt',
      file_data: `data:text/plain;base64,${fileData}`
    }]
  })
  scheduler.runAll()
  await waitFor(
    () => events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'attachment completion'
  )

  assert.deepEqual(responses.calls[0]?.request.messages, [{
    role: 'user',
    content: [
      { type: 'input_text', text: 'new user prompt' },
      {
        type: 'input_file',
        filename: 'attachment-1.txt',
        file_data: `data:text/plain;base64,${fileData}`
      }
    ]
  }])
  assert.deepEqual(history.appended[0], {
    taskId,
    role: 'user',
    content: 'new user prompt',
    status: 'complete'
  })
  assert.doesNotMatch(JSON.stringify(history.appended), new RegExp(fileData))
})

test('contextMessageLimit keeps the current prompt and attachments while excluding older encrypted history', async () => {
  const taskId = 'task:chat-context-limit'
  const encryptedHistory = priorMessages(8)
  const history = new FakeHistory()
  history.addTask(taskId, 'chat', encryptedHistory)
  const scheduler = new ManualScheduler()
  const responses = new FakeResponses(async (_credentials, _request, options) => {
    await deliver(options, { type: 'response.output_text.delta', delta: 'Limited context handled.\n' })
    return { responseId: 'response_context_limit', outputText: 'Limited context handled.\n', toolCalls: [] }
  })
  const { service, events } = serviceHarness(history, responses, scheduler)
  const fileData = Buffer.from('current context attachment').toString('base64')

  await service.start({
    ...startInput(taskId, 'current limited prompt'),
    contextMessageLimit: 6,
    attachments: [{
      type: 'input_file',
      filename: 'current.txt',
      file_data: `data:text/plain;base64,${fileData}`
    }]
  })
  scheduler.runAll()
  await waitFor(
    () => events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'limited context completion'
  )

  const modelMessages = responses.calls[0]?.request.messages
  assert.ok(modelMessages)
  assert.equal(modelMessages.length, 6)
  assert.deepEqual(
    modelMessages.slice(0, -1),
    encryptedHistory.slice(-5).map((message) => ({ role: message.role, content: message.content }))
  )
  assert.deepEqual(modelMessages.at(-1), {
    role: 'user',
    content: [
      { type: 'input_text', text: 'current limited prompt' },
      {
        type: 'input_file',
        filename: 'current.txt',
        file_data: `data:text/plain;base64,${fileData}`
      }
    ]
  })
  const serializedRequest = JSON.stringify(responses.calls[0]?.request)
  assert.doesNotMatch(serializedRequest, /encrypted history [123](?:\D|$)/u)
  assert.match(serializedRequest, /encrypted history 4/u)
  assert.deepEqual(history.appended[0], {
    taskId,
    role: 'user',
    content: 'current limited prompt',
    status: 'complete'
  })
  assert.doesNotMatch(JSON.stringify(history.appended), new RegExp(fileData))
})

test('omitting contextMessageLimit preserves the existing full-history request behavior', async () => {
  const taskId = 'task:chat-context-default'
  const encryptedHistory = priorMessages(8)
  const history = new FakeHistory()
  history.addTask(taskId, 'chat', encryptedHistory)
  const scheduler = new ManualScheduler()
  const responses = new FakeResponses(async (_credentials, _request, options) => {
    await deliver(options, { type: 'response.output_text.delta', delta: 'Full context handled.\n' })
    return { responseId: 'response_context_default', outputText: 'Full context handled.\n', toolCalls: [] }
  })
  const { service, events } = serviceHarness(history, responses, scheduler)

  await service.start(startInput(taskId, 'current default prompt'))
  scheduler.runAll()
  await waitFor(
    () => events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'default context completion'
  )

  assert.deepEqual(responses.calls[0]?.request.messages, [
    ...encryptedHistory.map((message) => ({ role: message.role, content: message.content })),
    { role: 'user', content: 'current default prompt' }
  ])
})

test('Responses Lite Chat uses a fresh opaque cache key and never forwards capability metadata', async () => {
  const taskId = 'task:chat-lite'
  const history = new FakeHistory()
  history.addTask(taskId)
  const scheduler = new ManualScheduler()
  const responses = new FakeResponses(async (_credentials, _request, options) => {
    await deliver(options, { type: 'response.output_text.delta', delta: 'Lite complete.\n' })
    return { responseId: 'response_lite', outputText: 'Lite complete.\n', toolCalls: [] }
  })
  const { service, events } = serviceHarness(history, responses, scheduler)

  await service.start({
    ...startInput(taskId),
    wireMode: 'lite',
    modelCapabilities: {
      attachments: true,
      imageInput: true,
      imageGeneration: false,
      subagents: true,
      toolUse: true,
      webSearch: false
    },
    webSearch: false
  })
  scheduler.runAll()
  await waitFor(
    () => events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'Lite Chat completion'
  )

  const request = responses.calls[0]?.request
  assert.equal(request?.wireMode, 'lite')
  assert.match(request?.promptCacheKey ?? '', /^[A-Za-z0-9_-]{43}$/u)
  assert.equal(request?.webSearch, false)
  assert.equal('modelCapabilities' in (request ?? {}), false)
  assert.doesNotMatch(request?.promptCacheKey ?? '', /chat-lite|Lite complete|new user prompt/u)
})

test('Chat rejects hosted capabilities inconsistent with the Main-confirmed model before history or network', async () => {
  const taskId = 'task:chat-capability-mismatch'
  const history = new FakeHistory()
  history.addTask(taskId)
  const scheduler = new ManualScheduler()
  const responses = new FakeResponses(async () => ({
    responseId: 'unexpected',
    outputText: 'unexpected',
    toolCalls: []
  }))
  const { service } = serviceHarness(history, responses, scheduler)

  await assert.rejects(
    service.start({
      ...startInput(taskId),
      modelCapabilities: {
        ...startInput(taskId).modelCapabilities,
        webSearch: false
      }
    }),
    (error: unknown) => error instanceof ChatTurnError && error.code === 'invalid_configuration'
  )
  assert.equal(history.appended.length, 0)
  assert.equal(responses.calls.length, 0)
})

test('invalid contextMessageLimit bounds and non-integers fail before history or network work', async () => {
  const taskId = 'task:chat-context-invalid'
  const history = new FakeHistory()
  history.addTask(taskId)
  const scheduler = new ManualScheduler()
  const responses = new FakeResponses(async () => ({
    responseId: 'response_unreachable',
    outputText: 'unreachable',
    toolCalls: []
  }))
  const { service } = serviceHarness(history, responses, scheduler)

  for (const contextMessageLimit of [1, 25, 6.5]) {
    await assert.rejects(
      service.start({ ...startInput(taskId), contextMessageLimit }),
      (error: unknown) => error instanceof ChatTurnError && error.code === 'invalid_configuration'
    )
  }

  assert.deepEqual(history.appended, [])
  assert.equal(history.loadCalls, 0)
  assert.equal(responses.calls.length, 0)
  assert.equal(scheduler.pending.length, 0)
})

test('image-only responses publish an opaque image token and complete with a fixed history marker', async () => {
  const taskId = 'task:chat-image-only'
  const history = new FakeHistory()
  history.addTask(taskId)
  const scheduler = new ManualScheduler()
  const generatedDataUrl = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')}`
  const responses = new FakeResponses(async () => ({
    responseId: 'response_image',
    outputText: '',
    toolCalls: [],
    generatedImages: [{ mimeType: 'image/png', dataUrl: generatedDataUrl }]
  }))
  const issued: unknown[] = []
  const imageResults: NonNullable<ChatTurnServiceOptions['imageResults']> = {
    issueMany(images, ownerWebContentsId) {
      issued.push({ images, ownerWebContentsId })
      return [{
        imageToken: `img_${'i'.repeat(43)}`,
        mimeType: 'image/png',
        byteLength: 8
      }]
    }
  }
  const { service, events } = serviceHarness(history, responses, scheduler, { imageResults })

  await service.start({ ...startInput(taskId), imageGeneration: true })
  scheduler.runAll()
  await waitFor(
    () => events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'image-only completion'
  )

  assert.equal(responses.calls[0]?.request.imageGeneration, true)
  assert.equal(issued.length, 1)
  assert.equal((issued[0] as { ownerWebContentsId: number }).ownerWebContentsId, 7)
  assert.equal(events.some((event) => event.type === 'image-result'), true)
  const assistant = history.appended.at(-1)
  assert.equal(assistant?.role, 'assistant')
  assert.equal(assistant?.status, 'complete')
  assert.match(assistant?.content ?? '', /图片已生成/)
  assert.doesNotMatch(JSON.stringify(history.appended), /data:image|iVBOR/)
})

test('start returns before scheduled network and success emits ordered deltas before durable completion', async () => {
  const taskId = 'task:chat-success'
  const history = new FakeHistory()
  history.addTask(taskId, 'chat', [priorMessage('assistant', 'prior answer')])
  const scheduler = new ManualScheduler()
  const responses = new FakeResponses(async (_credentials, _request, options) => {
    await deliver(options, { type: 'response.output_text.delta', delta: 'Hello ' })
    await deliver(options, { type: 'response.output_text.delta', delta: 'world\n' })
    await deliver(options, { type: 'response.output_text.delta', delta: 'Done.' })
    await deliver(options, { type: 'response.completed', responseId: 'response_test' })
    return { responseId: 'response_test', outputText: 'Hello world\nDone.' }
  })
  const { service, events } = serviceHarness(history, responses, scheduler)

  const started = await service.start(startInput(taskId))
  assert.match(started.turnId, /^turn_[A-Za-z0-9_-]{32}$/)
  assert.equal(responses.calls.length, 0)
  assert.equal(scheduler.pending.length, 1)
  assert.deepEqual(history.appended, [{
    taskId,
    role: 'user',
    content: 'new user prompt',
    status: 'complete'
  }])
  assert.deepEqual(events.map((event) => event.type === 'turn-status' ? event.status : event.type), ['queued'])

  scheduler.runAll()
  await waitFor(
    () => events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'completed event'
  )

  assert.equal(responses.calls.length, 1)
  assert.deepEqual(responses.calls[0]?.request, {
    model: 'gpt-test',
    messages: [
      { role: 'assistant', content: 'prior answer' },
      { role: 'user', content: 'new user prompt' }
    ],
    wireMode: 'standard',
    reasoning: 'high',
    webSearch: true
  })
  assert.deepEqual(events.map((event) => {
    if (event.type === 'turn-status') return event.status
    if (event.type === 'assistant-delta') return `delta:${event.text}`
    return event.type
  }), ['queued', 'running', 'delta:Hello world\n', 'delta:Done.', 'completed'])
  assert.deepEqual(history.appended.at(-1), {
    taskId,
    role: 'assistant',
    content: 'Hello world\nDone.',
    status: 'complete'
  })
})

test('line buffering redacts credentials and local paths split across stream deltas', async () => {
  const taskId = 'task:chat-redaction'
  const history = new FakeHistory()
  history.addTask(taskId)
  const scheduler = new ManualScheduler()
  const responses = new FakeResponses(async (_credentials, _request, options) => {
    await deliver(options, { type: 'response.output_text.delta', delta: 'Authorization: Bearer sk-spl' })
    await deliver(options, { type: 'response.output_text.delta', delta: 'itSecret123 D:\\private\\wor' })
    await deliver(options, { type: 'response.output_text.delta', delta: 'kspace\\secret.txt\nSafe line\n' })
    return { responseId: 'response_redaction', outputText: '' }
  })
  const { service, events } = serviceHarness(history, responses, scheduler)

  await service.start(startInput(taskId))
  scheduler.runAll()
  await waitFor(
    () => events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'redacted completion'
  )

  const deltas = events
    .filter((event): event is Extract<AgentEvent, { type: 'assistant-delta' }> => event.type === 'assistant-delta')
    .map((event) => event.text)
  const emitted = deltas.join('')
  const persisted = history.appended.at(-1)?.content ?? ''
  for (const value of [emitted, persisted, JSON.stringify(events)]) {
    assert.doesNotMatch(value, /sk-spl|itSecret123|D:\\|private|workspace|secret\.txt/)
    assert.match(value, /<redacted>/)
    assert.match(value, /<local-path>/)
    assert.match(value, /Safe line/)
  }
  assert.equal(deltas.length, 1)
})

test('current API key is redacted across SSE deltas even without a recognizable credential pattern', async () => {
  const taskId = 'task:chat-explicit-key-redaction'
  const apiKey = '!~%'
  const history = new FakeHistory()
  history.addTask(taskId)
  const scheduler = new ManualScheduler()
  const responses = new FakeResponses(async (_credentials, _request, options) => {
    await deliver(options, { type: 'response.output_text.delta', delta: 'Endpoint echoed [!' })
    await deliver(options, { type: 'response.output_text.delta', delta: '~' })
    await deliver(options, { type: 'response.output_text.delta', delta: '%] but continued safely.\n' })
    return {
      responseId: 'response_explicit_key_redaction',
      outputText: `Endpoint echoed [${apiKey}] but continued safely.\n`,
      toolCalls: []
    }
  })
  const { service, events } = serviceHarness(history, responses, scheduler)

  await service.start({
    ...startInput(taskId),
    credentials: { baseUrl: SAFE_CREDENTIALS.baseUrl, apiKey }
  })
  scheduler.runAll()
  await waitFor(
    () => events.some((event) => event.type === 'turn-status' && event.status === 'completed'),
    'explicit API key redaction completion'
  )

  const rendererOutput = events
    .filter((event): event is Extract<AgentEvent, { type: 'assistant-delta' }> =>
      event.type === 'assistant-delta'
    )
    .map((event) => event.text)
    .join('')
  const persisted = history.appended.at(-1)?.content ?? ''
  for (const value of [rendererOutput, persisted, JSON.stringify(events), JSON.stringify(history.appended)]) {
    assert.equal(value.includes(apiKey), false)
    assert.match(value, /<redacted>/u)
    assert.match(value, /continued safely/u)
  }
  for (const event of events) {
    if (event.type === 'assistant-delta') assert.doesNotMatch(event.text, /[!~%]/u)
  }
})

test('cancellation aborts the stream and persists one safe partial without duplicate terminal events', async () => {
  const taskId = 'task:chat-cancel'
  const history = new FakeHistory()
  history.addTask(taskId)
  const scheduler = new ManualScheduler()
  const responses = new FakeResponses(async (_credentials, _request, options) => {
    await deliver(options, {
      type: 'response.output_text.delta',
      delta: 'Partial answer with Bearer cancelSecret123 at D:\\private\\cancel.txt'
    })
    return await new Promise<ResponsesStreamResult>((_resolve, reject) => {
      const cancel = (): void => reject(new ResponsesClientError('cancelled'))
      if (options.signal?.aborted) cancel()
      else options.signal?.addEventListener('abort', cancel, { once: true })
    })
  })
  const { service, events } = serviceHarness(history, responses, scheduler)

  const { turnId } = await service.start(startInput(taskId))
  scheduler.runAll()
  await waitFor(() => responses.calls.length === 1, 'stream start')
  const signal = responses.calls[0]?.options.signal
  assert.ok(signal)
  assert.equal(service.cancel(turnId), true)
  assert.equal(signal.aborted, true)
  assert.equal(signal.reason, 'turn_cancelled')

  await waitFor(
    () => history.appended.some((message) => message.role === 'assistant' && message.status === 'cancelled'),
    'cancelled partial persistence'
  )
  const assistant = history.appended.filter((message) => message.role === 'assistant')
  assert.equal(assistant.length, 1)
  assert.equal(assistant[0]?.status, 'cancelled')
  assert.doesNotMatch(assistant[0]?.content ?? '', /cancelSecret123|D:\\|private|cancel\.txt/)
  assert.match(assistant[0]?.content ?? '', /<redacted>/)
  assert.match(assistant[0]?.content ?? '', /<local-path>/)

  const terminalStatuses = (): string[] => events
    .filter(
      (event): event is Extract<AgentEvent, { type: 'turn-status' }> =>
        event.type === 'turn-status' && ['completed', 'failed', 'cancelled'].includes(event.status)
    )
    .map((event) => event.status)
  assert.deepEqual(terminalStatuses(), ['cancelled'])
  const cancelledIndex = events.findIndex(
    (event) => event.type === 'turn-status' && event.status === 'cancelled'
  )
  assert.equal(events.slice(cancelledIndex + 1).some((event) => event.type === 'assistant-delta'), false)
  assert.equal(service.cancel(turnId), false)
  assert.deepEqual(terminalStatuses(), ['cancelled'])
})

test('caller cancellation while secure history is pending prevents the network request', async () => {
  const taskId = 'task:chat-pending-start-cancel'
  const backingHistory = new FakeHistory()
  backingHistory.addTask(taskId)
  let releaseUserWrite!: () => void
  let userWriteStarted = false
  const userWriteGate = new Promise<void>((resolve) => {
    releaseUserWrite = resolve
  })
  const history: ChatTurnServiceOptions['history'] = {
    load: (id) => backingHistory.load(id),
    updateMessageStatus: (input) => backingHistory.updateMessageStatus(input),
    appendMessage: async (input) => {
      if (input.role === 'user') {
        userWriteStarted = true
        await userWriteGate
      }
      return backingHistory.appendMessage(input)
    }
  }
  const scheduler = new ManualScheduler()
  const responses = new FakeResponses(async () => ({ responseId: null, outputText: 'unreachable' }))
  const { service, events } = serviceHarness(history, responses, scheduler)
  const controller = new AbortController()

  const started = service.start(startInput(taskId), { signal: controller.signal })
  await waitFor(() => userWriteStarted, 'pending secure user write')
  controller.abort('turn_start_cancelled')
  releaseUserWrite()
  const { turnId } = await started
  scheduler.runAll()
  await waitFor(
    () => events.some((event) => event.type === 'turn-status' && event.status === 'cancelled'),
    'pending-start cancelled event'
  )

  assert.equal(responses.calls.length, 0)
  assert.equal(backingHistory.appended.filter((message) => message.role === 'user').length, 1)
  assert.equal(service.cancel(turnId), false)
})

test('cancel that wins during completed assistant persistence reconciles encrypted history to cancelled', async () => {
  const taskId = 'task:chat-complete-cancel-race'
  const backingHistory = new FakeHistory()
  backingHistory.addTask(taskId)
  let releaseAssistantWrite!: () => void
  let assistantWriteCompleted = false
  const assistantWriteGate = new Promise<void>((resolve) => {
    releaseAssistantWrite = resolve
  })
  const history: ChatTurnServiceOptions['history'] = {
    load: (id) => backingHistory.load(id),
    updateMessageStatus: (input) => backingHistory.updateMessageStatus(input),
    appendMessage: async (input) => {
      const receipt = await backingHistory.appendMessage(input)
      if (input.role === 'assistant') {
        assistantWriteCompleted = true
        await assistantWriteGate
      }
      return receipt
    }
  }
  const scheduler = new ManualScheduler()
  const responses = new FakeResponses(async (_credentials, _request, options) => {
    await deliver(options, { type: 'response.output_text.delta', delta: 'Durable answer.\n' })
    return { responseId: 'response_race', outputText: 'Durable answer.\n' }
  })
  const { service, events } = serviceHarness(history, responses, scheduler)

  const { turnId } = await service.start(startInput(taskId))
  scheduler.runAll()
  await waitFor(() => assistantWriteCompleted, 'assistant persistence race')
  assert.equal(service.cancel(turnId), true)
  assert.equal(events.some((event) => event.type === 'turn-status' && event.status === 'cancelled'), false)
  releaseAssistantWrite()
  await waitFor(
    () => events.some((event) => event.type === 'turn-status' && event.status === 'cancelled'),
    'reconciled cancelled event'
  )

  const assistant = backingHistory.tasks.get(taskId)?.messages.at(-1)
  assert.equal(assistant?.role, 'assistant')
  assert.equal(assistant?.status, 'cancelled')
  assert.equal(events.some((event) => event.type === 'turn-status' && event.status === 'completed'), false)
})

test('remote failure emits a fixed message and never reflects raw errors or partial secrets', async () => {
  const taskId = 'task:chat-failure'
  const history = new FakeHistory()
  history.addTask(taskId)
  const scheduler = new ManualScheduler()
  const rawSecret = 'sk-remoteFailureSecret123'
  const responses = new FakeResponses(async (_credentials, _request, options) => {
    await deliver(options, {
      type: 'response.output_text.delta',
      delta: `upstream partial Bearer ${rawSecret} at /home/alice/private.txt\n`
    })
    const error = new ResponsesClientError('remote_error') as ResponsesClientError & { raw?: string }
    error.raw = `Authorization: Bearer ${rawSecret}`
    throw error
  })
  const { service, events } = serviceHarness(history, responses, scheduler)

  await service.start(startInput(taskId))
  scheduler.runAll()
  await waitFor(
    () => events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
    'failed event'
  )

  const failed = events.find(
    (event): event is Extract<AgentEvent, { type: 'turn-status' }> =>
      event.type === 'turn-status' && event.status === 'failed'
  )
  assert.equal(failed?.message, '模型 endpoint 返回了无效或失败的流。')
  const serialized = JSON.stringify({ events, appended: history.appended })
  assert.doesNotMatch(serialized, new RegExp(rawSecret))
  assert.doesNotMatch(serialized, /\/home\/alice|private\.txt|Authorization: Bearer sk-/)
  assert.equal(history.appended.at(-1)?.status, 'failed')
})

test('assistant persistence failure emits only a fixed safe terminal error', async () => {
  const taskId = 'task:chat-persistence-failure'
  const backingHistory = new FakeHistory()
  backingHistory.addTask(taskId)
  let assistantWriteAttempts = 0
  const history: ChatTurnServiceOptions['history'] = {
    load: (id) => backingHistory.load(id),
    updateMessageStatus: (input) => backingHistory.updateMessageStatus(input),
    appendMessage: async (input) => {
      if (input.role === 'assistant') {
        assistantWriteAttempts += 1
        throw new Error('storage failed for sk-persistenceSecret123 at D:\\private\\history.json')
      }
      return backingHistory.appendMessage(input)
    }
  }
  const scheduler = new ManualScheduler()
  const responses = new FakeResponses(async (_credentials, _request, options) => {
    await deliver(options, { type: 'response.output_text.delta', delta: 'Safe answer.\n' })
    return { responseId: 'response_persistence', outputText: 'Safe answer.\n' }
  })
  const { service, events } = serviceHarness(history, responses, scheduler)

  await service.start(startInput(taskId))
  scheduler.runAll()
  await waitFor(
    () => events.some((event) => event.type === 'turn-status' && event.status === 'failed'),
    'persistence failure event'
  )

  assert.equal(assistantWriteAttempts, 2)
  const failed = events.find(
    (event): event is Extract<AgentEvent, { type: 'turn-status' }> =>
      event.type === 'turn-status' && event.status === 'failed'
  )
  assert.equal(failed?.message, '模型请求未完成，请重试。')
  assert.doesNotMatch(JSON.stringify(events), /persistenceSecret|D:\\|private|history\.json/)
  assert.deepEqual(backingHistory.appended.map((message) => message.role), ['user'])
})

test('duplicate task turns fail with a fixed conflict before a second prompt is persisted', async () => {
  const taskId = 'task:chat-duplicate'
  const history = new FakeHistory()
  history.addTask(taskId)
  const scheduler = new ManualScheduler()
  const responses = new FakeResponses(async () => ({ responseId: null, outputText: '' }))
  const { service } = serviceHarness(history, responses, scheduler)

  await service.start(startInput(taskId, 'first prompt'))
  await assert.rejects(
    service.start(startInput(taskId, 'second prompt with sk-duplicateSecret123')),
    (error: unknown) => {
      assert.ok(error instanceof TurnRegistryError)
      assert.equal(error.code, 'duplicate_active_turn')
      assert.equal(error.message, 'A turn is already active for this task.')
      assert.doesNotMatch(error.message, /second prompt|duplicateSecret/)
      return true
    }
  )
  assert.deepEqual(history.appended.map((message) => message.content), ['first prompt'])
  assert.equal(scheduler.pending.length, 1)
  service.dispose()
})

test('dispose aborts every active scheduled stream', async () => {
  const history = new FakeHistory()
  history.addTask('task:chat-dispose-one')
  history.addTask('task:chat-dispose-two')
  const scheduler = new ManualScheduler()
  const registry = new TurnRegistry()
  const responses = new FakeResponses(async (_credentials, _request, options) => {
    return await new Promise<ResponsesStreamResult>((_resolve, reject) => {
      const cancel = (): void => reject(new ResponsesClientError('cancelled'))
      if (options.signal?.aborted) cancel()
      else options.signal?.addEventListener('abort', cancel, { once: true })
    })
  })
  const { service, events } = serviceHarness(history, responses, scheduler, { registry })

  await service.start(startInput('task:chat-dispose-one'))
  await service.start(startInput('task:chat-dispose-two'))
  scheduler.runAll()
  await waitFor(() => responses.calls.length === 2, 'both streams')

  const signals = responses.calls.map((call) => call.options.signal)
  assert.equal(signals.every((signal) => signal?.aborted === false), true)
  const shutdown = service.shutdown()
  assert.equal(signals.every((signal) => signal?.aborted === true), true)
  assert.equal(signals.every((signal) => signal?.reason === 'turn_cancelled'), true)
  await shutdown
  assert.equal(events.filter(
    (event) => event.type === 'turn-status' && event.status === 'cancelled'
  ).length, 2)
  assert.deepEqual(registry.getCounts(), { active: 0, retainedTerminal: 2 })

  await service.shutdown()
  assert.deepEqual(registry.getCounts(), { active: 0, retainedTerminal: 2 })

  await assert.rejects(
    service.start(startInput('task:chat-dispose-one')),
    (error: unknown) => error instanceof ChatTurnError && error.code === 'disposed'
  )
})

test('shutdown waits for a pending start and prevents post-drain scheduling', async () => {
  let releaseLoad!: () => void
  let markLoadStarted!: () => void
  const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve })
  const loadStarted = new Promise<void>((resolve) => { markLoadStarted = resolve })
  class SlowHistory extends FakeHistory {
    #blocked = true

    override async load(taskId: string): Promise<ConversationSnapshot> {
      if (this.#blocked) {
        this.#blocked = false
        markLoadStarted()
        await loadGate
      }
      return await super.load(taskId)
    }
  }

  const history = new SlowHistory()
  history.addTask('task:chat-shutdown-start')
  const scheduler = new ManualScheduler()
  const responses = new FakeResponses(async () => ({ responseId: null, outputText: 'unexpected' }))
  const { service } = serviceHarness(history, responses, scheduler)
  const starting = assert.rejects(
    service.start(startInput('task:chat-shutdown-start')),
    (error: unknown) => error instanceof ChatTurnError && error.code === 'disposed'
  )
  await loadStarted
  const shutdown = service.shutdown()
  releaseLoad()
  await starting
  await shutdown

  assert.equal(scheduler.pending.length, 0)
  assert.equal(responses.calls.length, 0)
})
