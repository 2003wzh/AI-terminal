import type {
  AgentEvent,
  ConversationMessageDto,
  ModelCapabilities,
  ModelWireMode,
  ReasoningEffort
} from '../../shared/contracts'
import { TurnRegistry } from '../runtime/turn-registry.ts'
import { redactSensitiveContent } from '../security/redaction.ts'
import type {
  ConversationHistoryService,
  ConversationMessageAppendInput,
  ConversationMessageReceipt
} from './conversation-history-service.ts'
import type { ImageResultStore } from './image-result-store.ts'
import {
  generateResponsesPromptCacheKey,
  OpenAICompatibleResponsesClient,
  ResponsesClientError,
  type ResponsesCredentials,
  type ResponsesMessage,
  type ResponsesStreamEvent,
  type ResponsesUserContentPart
} from './responses-client.ts'

const MAX_CONTEXT_MESSAGES = 128
const MAX_CONTEXT_BYTES = 1536 * 1024
const MAX_RENDERER_DELTA_CHARACTERS = 16 * 1024

export interface ChatTurnStartInput {
  taskId: string
  prompt: string
  credentials: ResponsesCredentials
  model: string
  wireMode: ModelWireMode
  modelCapabilities: Readonly<ModelCapabilities>
  reasoning: ReasoningEffort
  webSearch: boolean
  imageGeneration: boolean
  attachments: readonly ResponsesUserContentPart[]
  ownerWebContentsId: number
  contextMessageLimit?: number
}

export interface ChatTurnServiceOptions {
  history: Pick<ConversationHistoryService, 'load' | 'appendMessage' | 'updateMessageStatus'>
  responses: Pick<OpenAICompatibleResponsesClient, 'stream'>
  imageResults?: Pick<ImageResultStore, 'issueMany'>
  registry?: TurnRegistry
  onEvent: (event: AgentEvent) => void
  schedule?: (operation: () => void) => void
}

export interface ChatTurnStartOptions {
  signal?: AbortSignal
}

export type ChatTurnErrorCode =
  | 'invalid_configuration'
  | 'invalid_task_mode'
  | 'empty_response'
  | 'disposed'

const CHAT_TURN_ERROR_MESSAGES: Record<ChatTurnErrorCode, string> = {
  invalid_configuration: 'The chat runtime configuration is invalid.',
  invalid_task_mode: 'The selected task does not support chat turns.',
  empty_response: 'The model completed without text output.',
  disposed: 'The chat runtime is no longer available.'
}

export class ChatTurnError extends Error {
  readonly code: ChatTurnErrorCode

  constructor(code: ChatTurnErrorCode) {
    super(CHAT_TURN_ERROR_MESSAGES[code])
    this.name = 'ChatTurnError'
    this.code = code
    this.stack = `${this.name}: ${this.message}`
  }
}

export class ChatTurnService {
  readonly #history: ChatTurnServiceOptions['history']
  readonly #responses: ChatTurnServiceOptions['responses']
  readonly #registry: TurnRegistry
  readonly #imageResults: ChatTurnServiceOptions['imageResults']
  readonly #onEvent: ChatTurnServiceOptions['onEvent']
  readonly #schedule: NonNullable<ChatTurnServiceOptions['schedule']>
  readonly #starts = new Set<Promise<{ turnId: string }>>()
  readonly #operations = new Set<Promise<void>>()
  #disposed = false

  constructor(options: ChatTurnServiceOptions) {
    if (
      !options ||
      typeof options !== 'object' ||
      typeof options.history?.load !== 'function' ||
      typeof options.history?.appendMessage !== 'function' ||
      typeof options.history?.updateMessageStatus !== 'function' ||
      typeof options.responses?.stream !== 'function' ||
      (options.imageResults !== undefined && typeof options.imageResults.issueMany !== 'function') ||
      typeof options.onEvent !== 'function' ||
      (options.schedule !== undefined && typeof options.schedule !== 'function')
    ) {
      throw new ChatTurnError('invalid_configuration')
    }
    this.#history = options.history
    this.#responses = options.responses
    this.#imageResults = options.imageResults
    this.#registry = options.registry ?? new TurnRegistry({ maxActiveTurns: 8, maxRetainedTurns: 128 })
    this.#onEvent = options.onEvent
    this.#schedule = options.schedule ?? ((operation) => setImmediate(operation))
  }

  async start(
    input: ChatTurnStartInput,
    options: ChatTurnStartOptions = {}
  ): Promise<{ turnId: string }> {
    if (this.#disposed) throw new ChatTurnError('disposed')
    if (!isChatTurnStartOptions(options) || !isChatTurnStartInput(input)) {
      throw new ChatTurnError('invalid_configuration')
    }
    const starting = this.#startValidated(input, options)
    this.#starts.add(starting)
    try {
      return await starting
    } finally {
      this.#starts.delete(starting)
    }
  }

  async #startValidated(
    input: ChatTurnStartInput,
    options: ChatTurnStartOptions
  ): Promise<{ turnId: string }> {
    const handle = this.#registry.start(input.taskId)
    const cancelFromCaller = (): void => {
      this.cancel(handle.turnId)
    }
    if (options.signal?.aborted) cancelFromCaller()
    else options.signal?.addEventListener('abort', cancelFromCaller, { once: true })

    try {
      const existing = await this.#history.load(input.taskId)
      if (existing.task.mode !== 'chat') throw new ChatTurnError('invalid_task_mode')
      await this.#history.appendMessage({
        taskId: input.taskId,
        role: 'user',
        content: input.prompt,
        status: 'complete'
      })
      const snapshot = await this.#history.load(input.taskId)
      const messages = selectModelContext(
        snapshot.messages,
        input.attachments,
        input.contextMessageLimit ?? MAX_CONTEXT_MESSAGES
      )
      if (this.#disposed) throw new ChatTurnError('disposed')
      this.#emit({ type: 'turn-status', turnId: handle.turnId, status: 'queued' })
      this.#trackScheduled(() => this.#execute(handle.turnId, handle.signal, input, messages))
      return { turnId: handle.turnId }
    } catch (error) {
      this.#registry.fail(handle.turnId)
      throw error
    }
  }

  cancel(turnId: string): boolean {
    const before = this.#registry.getSnapshot(turnId)
    if (before?.state !== 'running') return false
    const after = this.#registry.cancel(turnId)
    return after?.state === 'cancelled'
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#registry.cancelAll()
  }

  async shutdown(): Promise<void> {
    this.dispose()
    while (this.#starts.size > 0) {
      await Promise.allSettled([...this.#starts])
    }
    while (this.#operations.size > 0) {
      await Promise.all([...this.#operations])
    }
  }

  #trackScheduled(operation: () => Promise<void>): void {
    let tracked: Promise<void>
    tracked = new Promise<void>((resolve) => {
      this.#schedule(() => {
        void operation().then(resolve, resolve)
      })
    })
    this.#operations.add(tracked)
    void tracked.then(() => this.#operations.delete(tracked))
  }

  async #execute(
    turnId: string,
    signal: AbortSignal,
    input: ChatTurnStartInput,
    messages: ResponsesMessage[]
  ): Promise<void> {
    const initialState = this.#registry.getSnapshot(turnId)?.state
    if (initialState === 'cancelled') {
      this.#emitCancelled(turnId)
      return
    }
    if (initialState !== 'running') return
    this.#emit({ type: 'turn-status', turnId, status: 'running', message: '正在接收模型回答。' })
    const stream = new SafeLineStream(
      (text) => {
        this.#emit({ type: 'assistant-delta', turnId, text })
      },
      input.credentials.apiKey
    )
    let assistantReceipt: ConversationMessageReceipt | null = null
    const promptCacheKey = input.wireMode === 'lite'
      ? generateResponsesPromptCacheKey()
      : undefined

    try {
      const result = await this.#responses.stream(
        input.credentials,
        {
          model: input.model,
          messages,
          wireMode: input.wireMode,
          ...(promptCacheKey === undefined ? {} : { promptCacheKey }),
          reasoning: input.reasoning === 'auto' ? undefined : input.reasoning,
          webSearch: input.webSearch,
          ...(input.imageGeneration ? { imageGeneration: true } : {})
        },
        {
          signal,
          onEvent: (event) => consumeResponseEvent(event, stream)
        }
      )
      stream.flush()
      if ((result.generatedImages?.length ?? 0) > 0) {
        if (!this.#imageResults) throw new ChatTurnError('invalid_configuration')
        const refs = this.#imageResults.issueMany(result.generatedImages!, input.ownerWebContentsId)
        for (const ref of refs) this.#emit({ type: 'image-result', turnId, ...ref })
        if (!stream.output) {
          stream.push('图片已生成。\n')
          stream.flush()
        }
      }
      if (!stream.output) throw new ChatTurnError('empty_response')

      assistantReceipt = await this.#appendAssistant(input.taskId, stream.output, 'complete')
      const terminal = this.#registry.complete(turnId)
      if (terminal?.state === 'completed') {
        this.#emit({ type: 'turn-status', turnId, status: 'completed' })
      } else if (terminal?.state === 'cancelled') {
        const saved = await this.#tryMarkCancelled(assistantReceipt)
        this.#emitCancelled(turnId, saved)
      }
    } catch (error) {
      if (isCancellation(error) && this.#registry.getSnapshot(turnId)?.state === 'running') {
        this.#registry.cancel(turnId)
      }
      let current = this.#registry.getSnapshot(turnId)
      let cancelled = current?.state === 'cancelled'
      stream.flush(!cancelled)
      let persistenceFailed = false
      if (stream.output) {
        if (!assistantReceipt) {
          try {
            assistantReceipt = await this.#appendAssistant(
              input.taskId,
              stream.output,
              cancelled ? 'cancelled' : 'failed'
            )
          } catch {
            persistenceFailed = true
          }
        }

        current = this.#registry.getSnapshot(turnId)
        cancelled = current?.state === 'cancelled'
        if (cancelled && assistantReceipt && assistantReceipt.status !== 'cancelled') {
          persistenceFailed = !(await this.#tryMarkCancelled(assistantReceipt)) || persistenceFailed
        }
      }
      if (cancelled) {
        this.#emitCancelled(turnId, !persistenceFailed)
        return
      }

      const terminal = this.#registry.fail(turnId)
      if (terminal?.state === 'failed') {
        this.#emit({
          type: 'turn-status',
          turnId,
          status: 'failed',
          message: persistenceFailed ? '模型请求未完成，请重试。' : safeTurnFailureMessage(error)
        })
      } else if (terminal?.state === 'cancelled') {
        const saved = assistantReceipt
          ? await this.#tryMarkCancelled(assistantReceipt)
          : !stream.output
        this.#emitCancelled(turnId, saved && !persistenceFailed)
      }
    }
  }

  async #appendAssistant(
    taskId: string,
    content: string,
    status: ConversationMessageAppendInput['status']
  ): Promise<ConversationMessageReceipt> {
    return await this.#history.appendMessage({ taskId, role: 'assistant', content, status })
  }

  async #tryMarkCancelled(receipt: ConversationMessageReceipt): Promise<boolean> {
    if (receipt.status === 'cancelled') return true
    try {
      await this.#history.updateMessageStatus({
        taskId: receipt.taskId,
        messageId: receipt.id,
        status: 'cancelled'
      })
      return true
    } catch {
      return false
    }
  }

  #emitCancelled(turnId: string, persisted = true): void {
    this.#emit({
      type: 'turn-status',
      turnId,
      status: 'cancelled',
      message: persisted ? '已停止生成。' : '已停止生成，但部分回答未能安全保存。'
    })
  }

  #emit(event: AgentEvent): void {
    try {
      this.#onEvent(event)
    } catch {
      // Renderer delivery must not affect persistence or cancellation semantics.
    }
  }
}

class SafeLineStream {
  #pending = ''
  #output = ''
  readonly #deliver: (text: string) => void
  readonly #apiKey: string

  constructor(deliver: (text: string) => void, apiKey: string) {
    this.#deliver = deliver
    this.#apiKey = apiKey
  }

  get output(): string {
    return this.#output
  }

  push(delta: string): void {
    this.#pending += delta
    const boundary = this.#pending.lastIndexOf('\n')
    if (boundary < 0) return
    this.#release(this.#pending.slice(0, boundary + 1))
    this.#pending = this.#pending.slice(boundary + 1)
  }

  flush(deliver = true): void {
    if (!this.#pending) return
    this.#release(this.#pending, deliver)
    this.#pending = ''
  }

  #release(raw: string, deliver = true): void {
    const safe = redactTurnContent(raw, this.#apiKey)
    if (!safe) return
    this.#output += safe
    if (!deliver) return
    for (let offset = 0; offset < safe.length; offset += MAX_RENDERER_DELTA_CHARACTERS) {
      this.#deliver(safe.slice(offset, offset + MAX_RENDERER_DELTA_CHARACTERS))
    }
  }
}

function redactTurnContent(raw: string, apiKey: string): string {
  const withoutCurrentApiKey = apiKey ? raw.replaceAll(apiKey, '<redacted>') : raw
  let safe = redactSensitiveContent(withoutCurrentApiKey)
  while (apiKey && safe.includes(apiKey)) safe = safe.replaceAll(apiKey, '')
  return safe
}

function consumeResponseEvent(event: ResponsesStreamEvent, stream: SafeLineStream): void {
  if (event.type === 'response.output_text.delta') stream.push(event.delta)
}

function selectModelContext(
  messages: readonly ConversationMessageDto[],
  attachments: readonly ResponsesUserContentPart[],
  maximumMessages: number
): ResponsesMessage[] {
  const selected: ResponsesMessage[] = []
  let bytes = 0
  for (let index = messages.length - 1; index >= 0 && selected.length < maximumMessages; index -= 1) {
    const message = messages[index]!
    if (message.role === 'assistant' && message.status !== 'complete') continue
    if (message.role === 'user' && message.status !== 'complete') continue
    const messageBytes = Buffer.byteLength(message.content, 'utf8')
    if (bytes + messageBytes > MAX_CONTEXT_BYTES) break
    selected.unshift({ role: message.role, content: message.content })
    bytes += messageBytes
  }
  if (attachments.length > 0) {
    const current = selected.at(-1)
    if (!current || current.role !== 'user' || typeof current.content !== 'string') {
      throw new ChatTurnError('invalid_configuration')
    }
    selected[selected.length - 1] = {
      role: 'user',
      content: [
        { type: 'input_text', text: current.content },
        ...attachments
      ]
    }
  }
  return selected
}

function isCancellation(error: unknown): boolean {
  return error instanceof ResponsesClientError && error.code === 'cancelled'
}

function isChatTurnStartOptions(value: unknown): value is ChatTurnStartOptions {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.some((key) => key !== 'signal')) return false
  const signal = (value as { signal?: unknown }).signal
  return signal === undefined || (
    signal !== null &&
    typeof signal === 'object' &&
    typeof (signal as AbortSignal).aborted === 'boolean' &&
    typeof (signal as AbortSignal).addEventListener === 'function'
  )
}

function isChatTurnStartInput(value: unknown): value is ChatTurnStartInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const input = value as Partial<ChatTurnStartInput>
  return (
    typeof input.taskId === 'string' &&
    typeof input.prompt === 'string' &&
    typeof input.model === 'string' &&
    (input.wireMode === 'standard' || input.wireMode === 'lite') &&
    isModelCapabilities(input.modelCapabilities) &&
    typeof input.reasoning === 'string' &&
    typeof input.webSearch === 'boolean' &&
    typeof input.imageGeneration === 'boolean' &&
    (!input.webSearch || input.modelCapabilities.webSearch) &&
    (!input.imageGeneration || input.modelCapabilities.imageGeneration) &&
    (input.wireMode !== 'lite' || (!input.webSearch && !input.imageGeneration)) &&
    Array.isArray(input.attachments) &&
    input.attachments.length <= 6 &&
    Number.isSafeInteger(input.ownerWebContentsId) &&
    Number(input.ownerWebContentsId) > 0 &&
    (input.contextMessageLimit === undefined || (
      Number.isSafeInteger(input.contextMessageLimit) &&
      input.contextMessageLimit >= 2 &&
      input.contextMessageLimit <= 24
    )) &&
    typeof input.credentials?.baseUrl === 'string' &&
    typeof input.credentials?.apiKey === 'string'
  )
}

function isModelCapabilities(value: unknown): value is Readonly<ModelCapabilities> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const capabilities = value as Partial<ModelCapabilities>
  const keys: Array<keyof ModelCapabilities> = [
    'attachments',
    'imageInput',
    'imageGeneration',
    'subagents',
    'toolUse',
    'webSearch'
  ]
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key) && typeof capabilities[key] === 'boolean')
}

function safeTurnFailureMessage(error: unknown): string {
  if (error instanceof ResponsesClientError) {
    switch (error.code) {
      case 'timeout':
        return '模型响应超时，请重试。'
      case 'remote_rejected':
      case 'redirect_rejected':
        return '模型 endpoint 拒绝了请求，请检查渠道和模型。'
      case 'network_error':
        return '无法连接已确认的模型 endpoint。'
      case 'response_too_large':
      case 'event_too_large':
        return '模型响应超过安全大小限制。'
      case 'invalid_response':
      case 'remote_error':
        return '模型 endpoint 返回了无效或失败的流。'
      case 'invalid_configuration':
      case 'invalid_endpoint':
      case 'invalid_credential':
      case 'invalid_input':
      case 'consumer_error':
        return '模型请求未能安全完成。'
      case 'cancelled':
        return '已停止生成。'
    }
  }
  if (error instanceof ChatTurnError && error.code === 'empty_response') {
    return '模型没有返回文本内容。'
  }
  return '模型请求未完成，请重试。'
}
