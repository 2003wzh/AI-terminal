import { randomBytes } from 'node:crypto'

import { normalizeEndpoint } from '../security/consent-store.ts'
import { containsSensitiveCredential, redactSensitiveContent } from '../security/redaction.ts'
import type { ModelWireMode } from '../../shared/contracts.ts'

export type ResponsesMessageRole = 'system' | 'developer' | 'user' | 'assistant'

export interface ResponsesInputTextContent {
  type: 'input_text'
  text: string
}

export interface ResponsesInputImageContent {
  type: 'input_image'
  image_url: string
  detail?: 'auto' | 'low' | 'high' | 'original'
}

export interface ResponsesInputFileContent {
  type: 'input_file'
  filename: string
  file_data: string
  detail?: 'auto' | 'low' | 'high'
}

export type ResponsesUserContentPart =
  | ResponsesInputTextContent
  | ResponsesInputImageContent
  | ResponsesInputFileContent

export interface ResponsesMessage {
  role: ResponsesMessageRole
  content: string | readonly ResponsesUserContentPart[]
}

export type ResponsesJsonPrimitive = string | number | boolean | null
export type ResponsesJsonValue = ResponsesJsonPrimitive | ResponsesJsonObject | ResponsesJsonValue[]
export interface ResponsesJsonObject {
  [key: string]: ResponsesJsonValue
}

export interface ResponsesFunctionCallInput {
  type: 'function_call'
  call_id: string
  name: string
  arguments: ResponsesJsonObject
}

export interface ResponsesFunctionCallOutputInput {
  type: 'function_call_output'
  call_id: string
  output: string
}

declare const responsesContinuationCapsuleBrand: unique symbol

export interface ResponsesContinuationCapsule {
  readonly [responsesContinuationCapsuleBrand]: true
}

export interface ResponsesContinuationInput {
  capsule: ResponsesContinuationCapsule
  outputs: readonly ResponsesFunctionCallOutputInput[]
}

export type ResponsesInputItem =
  | ResponsesMessage
  | ResponsesFunctionCallInput
  | ResponsesFunctionCallOutputInput

export interface ResponsesFunctionToolDefinition {
  type: 'function'
  name: string
  description?: string
  parameters: ResponsesJsonObject
  strict?: boolean
}

export interface ResponsesToolCall {
  callId: string
  name: string
  arguments: ResponsesJsonObject
}

export type ResponsesFunctionToolCall = ResponsesToolCall

export interface ResponsesCredentials {
  baseUrl: string
  apiKey: string
}

export interface ResponsesStreamRequest {
  model: string
  messages?: readonly ResponsesInputItem[]
  input?: readonly ResponsesInputItem[]
  continuation?: ResponsesContinuationInput
  instructions?: string
  reasoning?: string
  webSearch?: boolean
  imageGeneration?: boolean
  tools?: readonly ResponsesFunctionToolDefinition[]
  wireMode?: ModelWireMode
  promptCacheKey?: string
}

export type ResponsesStreamEvent =
  | { type: 'response.created'; responseId: string | null }
  | { type: 'response.output_text.delta'; delta: string }
  | { type: 'response.completed'; responseId: string | null }

export interface ResponsesStreamResult {
  responseId: string | null
  outputText: string
  toolCalls: ResponsesToolCall[]
  generatedImages?: readonly ResponsesGeneratedImage[]
  continuation?: ResponsesContinuationCapsule
}

export interface ResponsesGeneratedImage {
  mimeType: 'image/png'
  dataUrl: string
}

export interface ResponsesStreamOptions {
  signal?: AbortSignal
  onEvent?: (event: ResponsesStreamEvent) => void | Promise<void>
}

export interface ResponsesClientOptions {
  fetcher?: typeof fetch
  timeoutMs?: number
  maxResponseBytes?: number
  maxEventBytes?: number
  maxOutputTextBytes?: number
}

export type ResponsesClientErrorCode =
  | 'invalid_configuration'
  | 'invalid_endpoint'
  | 'invalid_credential'
  | 'invalid_input'
  | 'cancelled'
  | 'timeout'
  | 'network_error'
  | 'redirect_rejected'
  | 'remote_rejected'
  | 'response_too_large'
  | 'event_too_large'
  | 'invalid_response'
  | 'remote_error'
  | 'consumer_error'

export type ResponsesRemoteFailure =
  | 'authorization'
  | 'tool_incompatible'
  | 'responses_unsupported'
  | 'rate_limited'
  | 'server_error'
  | 'request_rejected'

const ERROR_DETAILS: Readonly<Record<ResponsesClientErrorCode, {
  message: string
  retryable: boolean
}>> = {
  invalid_configuration: { message: 'The Responses client configuration is invalid.', retryable: false },
  invalid_endpoint: { message: 'The confirmed model endpoint is invalid.', retryable: false },
  invalid_credential: { message: 'The model credential is invalid.', retryable: false },
  invalid_input: { message: 'The model request is invalid.', retryable: false },
  cancelled: { message: 'The model request was cancelled.', retryable: false },
  timeout: { message: 'The model request timed out.', retryable: true },
  network_error: { message: 'The confirmed model endpoint could not be reached.', retryable: true },
  redirect_rejected: { message: 'The model endpoint attempted a redirect.', retryable: false },
  remote_rejected: { message: 'The model endpoint rejected the request.', retryable: false },
  response_too_large: { message: 'The model response exceeded the safety limit.', retryable: false },
  event_too_large: { message: 'A model stream event exceeded the safety limit.', retryable: false },
  invalid_response: { message: 'The model endpoint returned an invalid stream.', retryable: false },
  remote_error: { message: 'The model endpoint reported a stream failure.', retryable: true },
  consumer_error: { message: 'The model stream could not be delivered safely.', retryable: false }
}

export class ResponsesClientError extends Error {
  readonly code: ResponsesClientErrorCode
  readonly retryable: boolean
  readonly remoteFailure?: ResponsesRemoteFailure

  constructor(
    code: ResponsesClientErrorCode,
    retryable?: boolean,
    remoteFailure?: ResponsesRemoteFailure
  ) {
    const detail = ERROR_DETAILS[code]
    super(detail.message)
    this.name = 'ResponsesClientError'
    this.code = code
    this.retryable = retryable ?? detail.retryable
    this.remoteFailure = code === 'remote_rejected' && isResponsesRemoteFailure(remoteFailure)
      ? remoteFailure
      : undefined
    this.stack = `${this.name}: ${this.message}`
  }
}

interface NormalizedRequest {
  model: string
  input: NormalizedInputItem[]
  instructions?: string
  reasoning?: string
  webSearch: boolean
  imageGeneration: boolean
  tools: NormalizedFunctionToolDefinition[]
  wireMode: ModelWireMode
  promptCacheKey?: string
  turnState?: string
  cumulativeReasoningBytes: number
}

type NormalizedInputItem =
  | ResponsesMessage
  | NormalizedReasoningInput
  | {
      type: 'function_call'
      id?: string
      call_id: string
      name: string
      arguments: string
      internal_chat_message_metadata_passthrough?: PassthroughMetadata
    }
  | ResponsesFunctionCallOutputInput
  | NormalizedAssistantMessageInput
  | NormalizedWebSearchCallInput
  | NormalizedImageGenerationCallInput

type PassthroughMetadata = ResponsesJsonObject

interface NormalizedReasoningInput {
  type: 'reasoning'
  summary: readonly []
  encrypted_content: string
  id?: string
  internal_chat_message_metadata_passthrough?: PassthroughMetadata
}

interface NormalizedAssistantMessageInput {
  type: 'message'
  id?: string
  role: 'assistant'
  status: 'completed'
  content: readonly { type: 'output_text'; text: string }[]
  phase?: 'commentary' | 'final_answer'
  internal_chat_message_metadata_passthrough?: PassthroughMetadata
}

interface NormalizedWebSearchCallInput {
  type: 'web_search_call'
  id?: string
  status: 'completed'
  action?: ResponsesJsonObject
  internal_chat_message_metadata_passthrough?: PassthroughMetadata
}

interface NormalizedImageGenerationCallInput {
  type: 'image_generation_call'
  id?: string
  status: 'completed'
  revised_prompt?: string
  result: string
  internal_chat_message_metadata_passthrough?: PassthroughMetadata
}

type NormalizedContinuationOutputItem =
  | NormalizedReasoningInput
  | Extract<NormalizedInputItem, { type: 'function_call' }>
  | NormalizedAssistantMessageInput
  | NormalizedWebSearchCallInput
  | NormalizedImageGenerationCallInput

interface ContinuationBinding {
  baseUrl: string
  model: string
  wireMode: ModelWireMode
  promptCacheKey?: string
}

interface ContinuationCapsuleState {
  binding: ContinuationBinding
  input: readonly NormalizedInputItem[]
  expectedCallIds: readonly string[]
  turnState?: string
  cumulativeReasoningBytes: number
  used: boolean
}

interface ConsumedResponseStreamResult {
  result: ResponsesStreamResult
  continuationOutput: readonly NormalizedContinuationOutputItem[]
  responseReasoningBytes: number
}

interface NormalizedFunctionToolDefinition {
  type: 'function'
  name: string
  description?: string
  parameters: ResponsesJsonObject
  strict: boolean
}

interface RawSseEvent {
  event: string
  data: string
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000
const DEFAULT_MAX_RESPONSE_BYTES = 24 * 1024 * 1024
const DEFAULT_MAX_EVENT_BYTES = 256 * 1024
const DEFAULT_MAX_OUTPUT_TEXT_BYTES = 8 * 1024 * 1024
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_EVENT_BYTES = 1024 * 1024
const MAX_IMAGE_GENERATION_EVENT_BYTES = 18 * 1024 * 1024
const MAX_OUTPUT_TEXT_BYTES = 16 * 1024 * 1024
const MAX_API_KEY_LENGTH = 32_768
const MAX_MODEL_LENGTH = 256
const MAX_INSTRUCTIONS_CHARACTERS = 256 * 1024
const MAX_REASONING_LENGTH = 64
const MAX_REASONING_ENCRYPTED_CHARACTERS = 512 * 1024
const MAX_REASONING_ITEMS = 8
const MAX_REASONING_PARTS = 64
const MAX_CUMULATIVE_REASONING_BYTES = 2 * 1024 * 1024
const MAX_MESSAGES = 128
const MAX_CONTINUATION_INPUT_ITEMS = 1024
const MAX_MESSAGE_CHARACTERS = 256 * 1024
const MAX_MULTIMODAL_PARTS = 17
const MAX_INPUT_BYTES = 18 * 1024 * 1024
const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024
const MAX_DATA_URL_CHARACTERS = 17 * 1024 * 1024
const MAX_GENERATED_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_GENERATED_IMAGE_BASE64_CHARACTERS = 16 * 1024 * 1024
const MAX_RESPONSE_ID_LENGTH = 256
const MAX_FUNCTION_TOOLS = 32
const MAX_FUNCTION_TOOL_CALLS = 32
const MAX_RESPONSE_OUTPUT_ITEMS = 256
const MAX_FUNCTION_NAME_LENGTH = 64
const MAX_FUNCTION_DESCRIPTION_CHARACTERS = 4 * 1024
const MAX_FUNCTION_SCHEMA_BYTES = 128 * 1024
const MAX_FUNCTION_ARGUMENT_BYTES = 256 * 1024
const MAX_FUNCTION_OUTPUT_CHARACTERS = 512 * 1024
const MAX_CALL_ID_LENGTH = 256
const PROMPT_CACHE_KEY_BYTES = 32
const PROMPT_CACHE_KEY_CHARACTERS = 43
const MAX_TURN_STATE_CHARACTERS = 4 * 1024
const MAX_PASSTHROUGH_METADATA_BYTES = 4 * 1024
const MAX_WEB_ACTION_STRINGS = 16
const MAX_JSON_DEPTH = 16
const MAX_JSON_NODES = 20_000
const MAX_JSON_KEY_LENGTH = 128
const MAX_JSON_STRING_CHARACTERS = 256 * 1024
const MESSAGE_ROLES = new Set<ResponsesMessageRole>(['system', 'developer', 'user', 'assistant'])
const FUNCTION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u
const CALL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u
const PROMPT_CACHE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/u
const TURN_STATE_PATTERN = /^[\x21-\x7e]+$/u
const REMOTE_ATTACHMENT_NAME_PATTERN =
  /^attachment-[1-9][0-9]?\.(?:png|jpg|webp|pdf|txt|md|csv|json|html|xml|yaml|yml|toml|js|jsx|ts|tsx|py|rs|go|java|c|h|cpp|hpp|cs|sh|ps1|log)$/u
const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const FILE_MIME_TYPES = new Set([
  'application/json',
  'application/pdf',
  'application/xml',
  'text/csv',
  'text/html',
  'text/javascript',
  'text/markdown',
  'text/plain',
  'text/x-python',
  'text/yaml'
])
const continuationCapsules = new WeakMap<object, ContinuationCapsuleState>()

export class OpenAICompatibleResponsesClient {
  readonly #fetcher: typeof fetch
  readonly #timeoutMs: number
  readonly #maxResponseBytes: number
  readonly #maxEventBytes: number
  readonly #maxOutputTextBytes: number

  constructor(options: ResponsesClientOptions = {}) {
    const candidate: unknown = options
    if (!hasOnlyKeys(candidate, [
      'fetcher',
      'timeoutMs',
      'maxResponseBytes',
      'maxEventBytes',
      'maxOutputTextBytes'
    ])) {
      throw new ResponsesClientError('invalid_configuration')
    }
    if (candidate.fetcher !== undefined && typeof candidate.fetcher !== 'function') {
      throw new ResponsesClientError('invalid_configuration')
    }

    this.#timeoutMs = configurationInteger(candidate.timeoutMs, DEFAULT_TIMEOUT_MS, 10, 10 * 60_000)
    this.#maxResponseBytes = configurationInteger(
      candidate.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      256,
      MAX_RESPONSE_BYTES
    )
    this.#maxEventBytes = configurationInteger(
      candidate.maxEventBytes,
      DEFAULT_MAX_EVENT_BYTES,
      64,
      MAX_EVENT_BYTES
    )
    this.#maxOutputTextBytes = configurationInteger(
      candidate.maxOutputTextBytes,
      DEFAULT_MAX_OUTPUT_TEXT_BYTES,
      64,
      MAX_OUTPUT_TEXT_BYTES
    )
    if (
      this.#maxEventBytes > this.#maxResponseBytes ||
      this.#maxOutputTextBytes > this.#maxResponseBytes
    ) {
      throw new ResponsesClientError('invalid_configuration')
    }
    this.#fetcher = (candidate.fetcher as typeof fetch | undefined) ?? globalThis.fetch
    if (typeof this.#fetcher !== 'function') {
      throw new ResponsesClientError('invalid_configuration')
    }
  }

  async stream(
    credentials: ResponsesCredentials,
    request: ResponsesStreamRequest,
    options: ResponsesStreamOptions = {}
  ): Promise<ResponsesStreamResult> {
    const normalizedCredentials = normalizeCredentials(credentials)
    const normalizedRequest = normalizeRequest(request, normalizedCredentials.baseUrl)
    if (normalizedRequest.input.some((item) =>
      !('role' in item) &&
      item.type === 'reasoning' &&
      containsSensitiveCredential(item.encrypted_content, [normalizedCredentials.apiKey])
    )) {
      throw new ResponsesClientError('invalid_input')
    }
    if (
      normalizedRequest.turnState !== undefined &&
      containsSensitiveCredential(normalizedRequest.turnState, [normalizedCredentials.apiKey])
    ) {
      throw new ResponsesClientError('invalid_input')
    }
    const normalizedOptions = normalizeStreamOptions(options)
    if (normalizedOptions.signal?.aborted) throw new ResponsesClientError('cancelled')

    const requestUrl = `${normalizedCredentials.baseUrl}/responses`
    const requestBody = serializeRequest(normalizedRequest)
    const controller = new AbortController()
    let timedOut = false
    const abortFromCaller = (): void => controller.abort()
    normalizedOptions.signal?.addEventListener('abort', abortFromCaller, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.#timeoutMs)

    try {
      const response = await this.#fetcher(requestUrl, {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${normalizedCredentials.apiKey}`,
          'Content-Type': 'application/json',
          ...(normalizedRequest.wireMode === 'lite'
            ? { 'X-OpenAI-Internal-Codex-Responses-Lite': 'true' }
            : {}),
          ...(normalizedRequest.turnState === undefined
            ? {}
            : { 'X-Codex-Turn-State': normalizedRequest.turnState })
        },
        body: requestBody,
        redirect: 'manual',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      })

      if (response.status >= 300 && response.status < 400) {
        await discardResponseBody(response)
        throw new ResponsesClientError('redirect_rejected')
      }
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500
        const remoteFailure = classifyRemoteFailure(
          response.status,
          normalizedRequest.tools.length > 0
        )
        await discardResponseBody(response)
        throw new ResponsesClientError('remote_rejected', retryable, remoteFailure)
      }

      let responseTurnState: string | undefined
      try {
        const rawTurnState = response.headers.get('x-codex-turn-state')
        responseTurnState = normalizeTurnState(
          rawTurnState === null ? undefined : rawTurnState,
          'invalid_response'
        )
        if (
          responseTurnState !== undefined &&
          containsSensitiveCredential(responseTurnState, [normalizedCredentials.apiKey])
        ) {
          throw new ResponsesClientError('invalid_response')
        }
      } catch {
        await discardResponseBody(response)
        throw new ResponsesClientError('invalid_response')
      }

      const contentLength = response.headers.get('content-length')
      if (
        contentLength !== null &&
        /^\d+$/.test(contentLength) &&
        Number(contentLength) > this.#maxResponseBytes
      ) {
        await discardResponseBody(response)
        throw new ResponsesClientError('response_too_large')
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'text/event-stream' || !response.body) {
        await discardResponseBody(response)
        throw new ResponsesClientError('invalid_response')
      }

      const consumed = await consumeResponseStream(response.body, {
        maxResponseBytes: this.#maxResponseBytes,
        maxEventBytes: this.#maxEventBytes,
        maxImageCompletionEventBytes: normalizedRequest.imageGeneration
          ? Math.max(this.#maxEventBytes, Math.min(
              this.#maxResponseBytes,
              MAX_IMAGE_GENERATION_EVENT_BYTES
            ))
          : this.#maxEventBytes,
        maxOutputTextBytes: this.#maxOutputTextBytes,
        allowedFunctionNames: new Set(normalizedRequest.tools.map((tool) => tool.name)),
        allowWebSearch: normalizedRequest.webSearch,
        allowImageGeneration: normalizedRequest.imageGeneration,
        explicitSecrets: [normalizedCredentials.apiKey],
        onEvent: normalizedOptions.onEvent
      })
      const effectiveTurnState = normalizedRequest.turnState ?? responseTurnState
      const cumulativeReasoningBytes = normalizedRequest.cumulativeReasoningBytes +
        consumed.responseReasoningBytes
      if (cumulativeReasoningBytes > MAX_CUMULATIVE_REASONING_BYTES) responseTooLarge()

      if (consumed.result.toolCalls.length === 0) return consumed.result
      const continuationInput = Object.freeze([
        ...normalizedRequest.input,
        ...consumed.continuationOutput
      ])
      assertContinuationInputBudget(continuationInput)
      const continuation = createContinuationCapsule({
        binding: {
          baseUrl: normalizedCredentials.baseUrl,
          model: normalizedRequest.model,
          wireMode: normalizedRequest.wireMode,
          promptCacheKey: normalizedRequest.promptCacheKey
        },
        input: continuationInput,
        expectedCallIds: Object.freeze(consumed.result.toolCalls.map((call) => call.callId)),
        ...(effectiveTurnState === undefined ? {} : { turnState: effectiveTurnState }),
        cumulativeReasoningBytes,
        used: false
      })
      return { ...consumed.result, continuation }
    } catch (error) {
      if (normalizedOptions.signal?.aborted) throw new ResponsesClientError('cancelled')
      if (timedOut) throw new ResponsesClientError('timeout')
      if (error instanceof ResponsesClientError) throw error
      // Fetch and stream errors may contain the endpoint, local paths, headers,
      // or response details. Never preserve the raw error or its stack.
      throw new ResponsesClientError('network_error')
    } finally {
      clearTimeout(timeout)
      normalizedOptions.signal?.removeEventListener('abort', abortFromCaller)
    }
  }
}

export function normalizeResponsesBaseUrl(value: unknown): string {
  let normalized: string
  try {
    normalized = normalizeEndpoint(value)
  } catch {
    throw new ResponsesClientError('invalid_endpoint')
  }
  const endpoint = new URL(normalized)
  if (endpoint.search || endpoint.hash) throw new ResponsesClientError('invalid_endpoint')
  return normalized.replace(/\/+$/, '')
}

export function generateResponsesPromptCacheKey(): string {
  return randomBytes(PROMPT_CACHE_KEY_BYTES).toString('base64url')
}

function normalizeCredentials(value: unknown): { baseUrl: string; apiKey: string } {
  try {
    if (!hasExactKeys(value, ['baseUrl', 'apiKey'])) {
      throw new ResponsesClientError('invalid_credential')
    }
    const baseUrl = normalizeResponsesBaseUrl(value.baseUrl)
    if (
      typeof value.apiKey !== 'string' ||
      value.apiKey.length < 1 ||
      value.apiKey.length > MAX_API_KEY_LENGTH ||
      /[^\x21-\x7e]/u.test(value.apiKey)
    ) {
      throw new ResponsesClientError('invalid_credential')
    }
    return { baseUrl, apiKey: value.apiKey }
  } catch (error) {
    if (error instanceof ResponsesClientError) throw error
    throw new ResponsesClientError('invalid_credential')
  }
}

function normalizeRequest(value: unknown, baseUrl: string): NormalizedRequest {
  try {
    if (!hasOnlyKeys(value, [
      'model',
      'messages',
      'input',
      'continuation',
      'instructions',
      'reasoning',
      'webSearch',
      'imageGeneration',
      'tools',
      'wireMode',
      'promptCacheKey'
    ])) invalidInput()
    if (!Object.hasOwn(value, 'model')) invalidInput()
    if (
      typeof value.model !== 'string' ||
      value.model.length < 1 ||
      value.model.length > MAX_MODEL_LENGTH ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value.model)
    ) {
      invalidInput()
    }
    let instructions: string | undefined
    if (value.instructions !== undefined) {
      if (
        typeof value.instructions !== 'string' ||
        value.instructions.length < 1 ||
        value.instructions.length > MAX_INSTRUCTIONS_CHARACTERS ||
        value.instructions.includes('\0')
      ) {
        invalidInput()
      }
      instructions = value.instructions
    }

    let reasoning: string | undefined
    if (value.reasoning !== undefined) {
      if (
        typeof value.reasoning !== 'string' ||
        value.reasoning.length < 1 ||
        value.reasoning.length > MAX_REASONING_LENGTH ||
        !/^[A-Za-z0-9_-]+$/u.test(value.reasoning)
      ) {
        invalidInput()
      }
      reasoning = value.reasoning
    }
    if (value.webSearch !== undefined && typeof value.webSearch !== 'boolean') invalidInput()
    if (value.imageGeneration !== undefined && typeof value.imageGeneration !== 'boolean') invalidInput()

    const wireMode = normalizeWireMode(value.wireMode)
    const promptCacheKey = normalizePromptCacheKey(value.promptCacheKey)
    const tools = normalizeFunctionTools(value.tools)
    if (tools.length > 0 && promptCacheKey === undefined) invalidInput()
    if (wireMode === 'lite') {
      if (promptCacheKey === undefined || value.webSearch === true || value.imageGeneration === true) {
        invalidInput()
      }
    }

    const hasMessages = Object.hasOwn(value, 'messages')
    const hasInput = Object.hasOwn(value, 'input')
    const hasContinuation = Object.hasOwn(value, 'continuation')
    if (Number(hasMessages) + Number(hasInput) + Number(hasContinuation) !== 1) invalidInput()

    let input: NormalizedInputItem[]
    let turnState: string | undefined
    let cumulativeReasoningBytes = 0
    let consumedCapsuleState: ContinuationCapsuleState | undefined
    if (hasContinuation) {
      const continuation = normalizeContinuationInput(value.continuation, {
        baseUrl,
        model: value.model,
        wireMode,
        promptCacheKey
      })
      input = continuation.input
      turnState = continuation.state.turnState
      cumulativeReasoningBytes = continuation.state.cumulativeReasoningBytes
      consumedCapsuleState = continuation.state
    } else {
      const sourceItems = hasMessages ? value.messages : value.input
      if (!Array.isArray(sourceItems) || sourceItems.length < 1 || sourceItems.length > MAX_MESSAGES) {
        invalidInput()
      }
      input = sourceItems.map((item) => normalizeInputItem(item))
      cumulativeReasoningBytes = reasoningBytesInInput(input)
      if (cumulativeReasoningBytes > MAX_CUMULATIVE_REASONING_BYTES) invalidInput()
    }
    assertInputBudget(input, 'invalid_input')
    validateStructuredInput(input, tools)
    if (consumedCapsuleState) consumedCapsuleState.used = true

    return {
      model: value.model,
      input,
      instructions,
      reasoning,
      webSearch: value.webSearch ?? false,
      imageGeneration: value.imageGeneration ?? false,
      tools,
      wireMode,
      promptCacheKey,
      turnState,
      cumulativeReasoningBytes
    }
  } catch (error) {
    if (error instanceof ResponsesClientError) throw error
    throw new ResponsesClientError('invalid_input')
  }
}

function normalizeWireMode(value: unknown): ModelWireMode {
  if (value === undefined) return 'standard'
  if (value !== 'standard' && value !== 'lite') invalidInput()
  return value
}

function normalizePromptCacheKey(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    value.length !== PROMPT_CACHE_KEY_CHARACTERS ||
    !PROMPT_CACHE_KEY_PATTERN.test(value)
  ) {
    invalidInput()
  }
  const decoded = Buffer.from(value, 'base64url')
  if (
    decoded.length !== PROMPT_CACHE_KEY_BYTES ||
    decoded.toString('base64url') !== value
  ) {
    invalidInput()
  }
  return value
}

function normalizeTurnState(
  value: unknown,
  errorCode: 'invalid_input' | 'invalid_response'
): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_TURN_STATE_CHARACTERS ||
    !TURN_STATE_PATTERN.test(value)
  ) {
    throw new ResponsesClientError(errorCode)
  }
  return value
}

function normalizeContinuationInput(
  value: unknown,
  binding: ContinuationBinding
): { input: NormalizedInputItem[]; state: ContinuationCapsuleState } {
  if (!hasExactKeys(value, ['capsule', 'outputs']) || !isPlainRecordLike(value.capsule)) invalidInput()
  const state = continuationCapsules.get(value.capsule)
  if (!state || state.used || !sameContinuationBinding(state.binding, binding)) invalidInput()
  if (!Array.isArray(value.outputs) || value.outputs.length !== state.expectedCallIds.length) invalidInput()

  const outputs = value.outputs.map((output, index): ResponsesFunctionCallOutputInput => {
    const normalized = normalizeInputItem(output)
    if ('role' in normalized || normalized.type !== 'function_call_output') invalidInput()
    if (normalized.call_id !== state.expectedCallIds[index]) invalidInput()
    return normalized
  })
  const input = [...state.input, ...outputs]
  if (input.length > MAX_CONTINUATION_INPUT_ITEMS) invalidInput()
  return { input, state }
}

function sameContinuationBinding(left: ContinuationBinding, right: ContinuationBinding): boolean {
  return left.baseUrl === right.baseUrl &&
    left.model === right.model &&
    left.wireMode === right.wireMode &&
    left.promptCacheKey === right.promptCacheKey
}

function createContinuationCapsule(state: ContinuationCapsuleState): ResponsesContinuationCapsule {
  const capsule = Object.freeze(Object.create(null)) as ResponsesContinuationCapsule
  continuationCapsules.set(capsule, state)
  return capsule
}

function reasoningBytesInInput(input: readonly NormalizedInputItem[]): number {
  let bytes = 0
  for (const item of input) {
    if (!('role' in item) && item.type === 'reasoning') {
      bytes += Buffer.byteLength(item.encrypted_content, 'utf8')
    }
  }
  return bytes
}

function assertInputBudget(
  input: readonly NormalizedInputItem[],
  errorCode: 'invalid_input' | 'response_too_large'
): void {
  let bytes = 0
  for (const item of input) {
    bytes += inputItemBytes(item)
    if (bytes > MAX_INPUT_BYTES) {
      if (errorCode === 'response_too_large') responseTooLarge()
      invalidInput()
    }
  }
}

function assertContinuationInputBudget(input: readonly NormalizedInputItem[]): void {
  if (input.length > MAX_CONTINUATION_INPUT_ITEMS) responseTooLarge()
  assertInputBudget(input, 'response_too_large')
}

function normalizeInputItem(value: unknown): NormalizedInputItem {
  if (!isPlainRecord(value)) invalidInput()

  if (!Object.hasOwn(value, 'type')) {
    if (!hasExactKeys(value, ['role', 'content'])) invalidInput()
    if (typeof value.role !== 'string' || !MESSAGE_ROLES.has(value.role as ResponsesMessageRole)) {
      invalidInput()
    }
    const role = value.role as ResponsesMessageRole
    if (typeof value.content === 'string') {
      if (
        value.content.length < 1 ||
        value.content.length > MAX_MESSAGE_CHARACTERS ||
        value.content.includes('\0')
      ) {
        invalidInput()
      }
      return { role, content: value.content }
    }
    if (role !== 'user' || !Array.isArray(value.content)) invalidInput()
    return { role, content: normalizeUserContent(value.content) }
  }

  if (value.type === 'function_call') {
    if (!hasExactKeys(value, ['type', 'call_id', 'name', 'arguments'])) invalidInput()
    const callId = normalizeCallId(value.call_id, 'invalid_input')
    const name = normalizeFunctionName(value.name, 'invalid_input')
    const argumentsObject = normalizeBoundedJsonObject(
      value.arguments,
      'invalid_input',
      MAX_FUNCTION_ARGUMENT_BYTES
    )
    return {
      type: 'function_call',
      call_id: callId,
      name,
      arguments: JSON.stringify(argumentsObject)
    }
  }

  if (value.type === 'function_call_output') {
    if (!hasExactKeys(value, ['type', 'call_id', 'output'])) invalidInput()
    const callId = normalizeCallId(value.call_id, 'invalid_input')
    if (
      typeof value.output !== 'string' ||
      value.output.length > MAX_FUNCTION_OUTPUT_CHARACTERS ||
      value.output.includes('\0')
    ) {
      invalidInput()
    }
    return { type: 'function_call_output', call_id: callId, output: value.output }
  }

  invalidInput()
}

function normalizeUserContent(value: readonly unknown[]): ResponsesUserContentPart[] {
  if (value.length < 1 || value.length > MAX_MULTIMODAL_PARTS) invalidInput()
  let textParts = 0
  const normalized = value.map((part): ResponsesUserContentPart => {
    if (!isPlainRecord(part) || typeof part.type !== 'string') invalidInput()
    if (part.type === 'input_text') {
      if (!hasExactKeys(part, ['type', 'text'])) invalidInput()
      if (
        typeof part.text !== 'string' ||
        part.text.length < 1 ||
        part.text.length > MAX_MESSAGE_CHARACTERS ||
        part.text.includes('\0')
      ) {
        invalidInput()
      }
      textParts += 1
      return { type: 'input_text', text: part.text }
    }
    if (part.type === 'input_image') {
      if (!hasOnlyKeys(part, ['type', 'image_url', 'detail'])) invalidInput()
      if (!Object.hasOwn(part, 'image_url') || typeof part.image_url !== 'string') invalidInput()
      const imageUrl = part.image_url
      const mimeType = validateDataUrl(imageUrl, IMAGE_MIME_TYPES)
      if (!IMAGE_MIME_TYPES.has(mimeType)) invalidInput()
      if (
        part.detail !== undefined &&
        !['auto', 'low', 'high', 'original'].includes(String(part.detail))
      ) {
        invalidInput()
      }
      return {
        type: 'input_image',
        image_url: imageUrl,
        ...(part.detail === undefined
          ? {}
          : { detail: part.detail as ResponsesInputImageContent['detail'] })
      }
    }
    if (part.type === 'input_file') {
      if (!hasOnlyKeys(part, ['type', 'filename', 'file_data', 'detail'])) invalidInput()
      if (
        !Object.hasOwn(part, 'filename') ||
        !Object.hasOwn(part, 'file_data') ||
        typeof part.file_data !== 'string'
      ) invalidInput()
      if (
        typeof part.filename !== 'string' ||
        !REMOTE_ATTACHMENT_NAME_PATTERN.test(part.filename)
      ) {
        invalidInput()
      }
      const fileData = part.file_data
      const mimeType = validateDataUrl(fileData, FILE_MIME_TYPES)
      if (mimeType !== expectedFileMimeType(part.filename)) invalidInput()
      const isPdf = part.filename.endsWith('.pdf')
      if (
        (part.detail !== undefined && !isPdf) ||
        (part.detail !== undefined && !['auto', 'low', 'high'].includes(String(part.detail)))
      ) {
        invalidInput()
      }
      return {
        type: 'input_file',
        filename: part.filename,
        file_data: fileData,
        ...(part.detail === undefined
          ? {}
          : { detail: part.detail as ResponsesInputFileContent['detail'] })
      }
    }
    invalidInput()
  })
  if (textParts !== 1) invalidInput()
  return normalized
}

function validateDataUrl(value: unknown, allowedMimeTypes: ReadonlySet<string>): string {
  if (
    typeof value !== 'string' ||
    value.length < 32 ||
    value.length > MAX_DATA_URL_CHARACTERS ||
    !value.startsWith('data:')
  ) {
    invalidInput()
  }
  const separator = value.indexOf(';base64,')
  if (separator < 6) invalidInput()
  const mimeType = value.slice(5, separator).toLowerCase()
  if (!allowedMimeTypes.has(mimeType) || value.slice(5, separator) !== mimeType) invalidInput()
  const base64 = value.slice(separator + 8)
  if (!isCanonicalBase64(base64)) invalidInput()
  return mimeType
}

function expectedFileMimeType(filename: string): string {
  const extension = filename.slice(filename.lastIndexOf('.') + 1)
  switch (extension) {
    case 'pdf': return 'application/pdf'
    case 'json': return 'application/json'
    case 'xml': return 'application/xml'
    case 'csv': return 'text/csv'
    case 'html': return 'text/html'
    case 'js':
    case 'jsx': return 'text/javascript'
    case 'md': return 'text/markdown'
    case 'py': return 'text/x-python'
    case 'yaml':
    case 'yml': return 'text/yaml'
    default: return 'text/plain'
  }
}

function isCanonicalBase64(value: string): boolean {
  return (
    value.length >= 4 &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  )
}

function inputItemBytes(item: NormalizedInputItem): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8')
}

function normalizeFunctionTools(value: unknown): NormalizedFunctionToolDefinition[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_FUNCTION_TOOLS) invalidInput()

  const names = new Set<string>()
  return value.map((tool) => {
    if (
      !hasOnlyKeys(tool, ['type', 'name', 'description', 'parameters', 'strict']) ||
      !Object.hasOwn(tool, 'type') ||
      !Object.hasOwn(tool, 'name') ||
      !Object.hasOwn(tool, 'parameters') ||
      tool.type !== 'function'
    ) {
      invalidInput()
    }
    const name = normalizeFunctionName(tool.name, 'invalid_input')
    if (names.has(name)) invalidInput()
    names.add(name)

    let description: string | undefined
    if (tool.description !== undefined) {
      if (
        typeof tool.description !== 'string' ||
        tool.description.length < 1 ||
        tool.description.length > MAX_FUNCTION_DESCRIPTION_CHARACTERS ||
        tool.description.includes('\0')
      ) {
        invalidInput()
      }
      description = tool.description
    }
    if (tool.strict !== undefined && typeof tool.strict !== 'boolean') invalidInput()

    const parameters = normalizeBoundedJsonObject(
      tool.parameters,
      'invalid_input',
      MAX_FUNCTION_SCHEMA_BYTES
    )
    if (parameters.type !== 'object') invalidInput()

    return {
      type: 'function',
      name,
      ...(description === undefined ? {} : { description }),
      parameters,
      strict: tool.strict ?? true
    }
  })
}

function validateStructuredInput(
  input: readonly NormalizedInputItem[],
  tools: readonly NormalizedFunctionToolDefinition[]
): void {
  const allowedNames = new Set(tools.map((tool) => tool.name))
  const functionCalls = new Set<string>()
  const functionOutputs = new Set<string>()

  for (const item of input) {
    if ('role' in item) continue
    if (item.type === 'reasoning' || item.type === 'web_search_call' || item.type === 'image_generation_call') {
      continue
    }
    if (item.type === 'function_call') {
      if (!allowedNames.has(item.name) || functionCalls.has(item.call_id)) invalidInput()
      functionCalls.add(item.call_id)
      continue
    }
    if (item.type !== 'function_call_output') continue
    if (!functionCalls.has(item.call_id) || functionOutputs.has(item.call_id)) invalidInput()
    functionOutputs.add(item.call_id)
  }
}

function normalizeStreamOptions(value: unknown): ResponsesStreamOptions {
  try {
    if (!hasOnlyKeys(value, ['signal', 'onEvent'])) invalidInput()
    if (value.onEvent !== undefined && typeof value.onEvent !== 'function') invalidInput()
    if (value.signal !== undefined && !isAbortSignal(value.signal)) invalidInput()
    return {
      signal: value.signal as AbortSignal | undefined,
      onEvent: value.onEvent as ResponsesStreamOptions['onEvent']
    }
  } catch (error) {
    if (error instanceof ResponsesClientError) throw error
    throw new ResponsesClientError('invalid_input')
  }
}

function serializeRequest(request: NormalizedRequest): string {
  if (request.wireMode === 'lite') return serializeLiteRequest(request)

  const payload: Record<string, unknown> = {
    model: request.model,
    input: request.input.map((item) => serializeInputItem(item, false)),
    stream: true,
    store: false
  }
  if (request.instructions !== undefined) payload.instructions = request.instructions
  const reasoningEffort = reasoningEffortForWire(request.reasoning)
  if (reasoningEffort !== undefined) {
    payload.reasoning = { effort: reasoningEffort }
  }
  if (request.webSearch || request.imageGeneration || request.tools.length > 0) {
    payload.tools = [
      ...(request.webSearch ? [{ type: 'web_search', external_web_access: true }] : []),
      ...(request.imageGeneration ? [{ type: 'image_generation' }] : []),
      ...request.tools
    ]
  }
  if (request.tools.length > 0) {
    payload.include = ['reasoning.encrypted_content']
    payload.tool_choice = 'auto'
    payload.parallel_tool_calls = false
  }
  if (request.promptCacheKey !== undefined) payload.prompt_cache_key = request.promptCacheKey
  return stringifyBoundedRequest(payload)
}

function serializeLiteRequest(request: NormalizedRequest): string {
  const input = request.input.map((item) => serializeInputItem(item, true))
  const prefix: unknown[] = [{
    type: 'additional_tools',
    role: 'developer',
    tools: structuredClone(request.tools)
  }]
  if (request.instructions !== undefined) {
    prefix.push({
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: request.instructions }]
    })
  }

  const reasoning: Record<string, string> = { context: 'all_turns' }
  const reasoningEffort = reasoningEffortForWire(request.reasoning)
  if (reasoningEffort !== undefined) reasoning.effort = reasoningEffort
  return stringifyBoundedRequest({
    model: request.model,
    input: [...prefix, ...input],
    stream: true,
    store: false,
    reasoning,
    include: ['reasoning.encrypted_content'],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    prompt_cache_key: request.promptCacheKey
  })
}

function serializeInputItem(item: NormalizedInputItem, lite: boolean): unknown {
  let serialized: Record<string, unknown>
  if (lite && 'role' in item && !('type' in item && item.type === 'message')) {
    const content = typeof item.content === 'string'
      ? [{
          type: item.role === 'assistant' ? 'output_text' : 'input_text',
          text: item.content
        }]
      : item.content.map((part) => part.type === 'input_image'
        ? { type: part.type, image_url: part.image_url }
        : structuredClone(part))
    serialized = { type: 'message', role: item.role, content }
  } else {
    serialized = structuredClone(item) as unknown as Record<string, unknown>
  }
  delete serialized.id
  if (serialized.type === 'message' && serialized.role === 'assistant') delete serialized.status
  return serialized
}

function reasoningEffortForWire(value: string | undefined): string | undefined {
  if (value === undefined || value === 'auto') return undefined
  if (value === 'light') return 'low'
  if (value === 'ultra') return 'max'
  return value
}

function stringifyBoundedRequest(payload: Record<string, unknown>): string {
  const serialized = JSON.stringify(payload)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BODY_BYTES) invalidInput()
  return serialized
}

async function consumeResponseStream(
  body: ReadableStream<Uint8Array>,
  options: {
    maxResponseBytes: number
    maxEventBytes: number
    maxImageCompletionEventBytes: number
    maxOutputTextBytes: number
    allowedFunctionNames: ReadonlySet<string>
    allowWebSearch: boolean
    allowImageGeneration: boolean
    explicitSecrets: readonly string[]
    onEvent?: ResponsesStreamOptions['onEvent']
  }
): Promise<ConsumedResponseStreamResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const parser = new BoundedSseParser(
    options.maxEventBytes,
    options.maxImageCompletionEventBytes
  )
  const output: string[] = []
  const toolCalls = new FunctionCallCollector(options.allowedFunctionNames)
  const orderedOutput = new OrderedOutputCollector({
    allowedFunctionNames: options.allowedFunctionNames,
    allowWebSearch: options.allowWebSearch,
    allowImageGeneration: options.allowImageGeneration,
    explicitSecrets: options.explicitSecrets
  })
  const outputIndexes = new CompletedOutputIndexAllocator()
  let responseBytes = 0
  let outputBytes = 0
  let responseId: string | null = null
  let generatedImages: readonly ResponsesGeneratedImage[] = []
  let completed = false

  const processEvent = async (raw: RawSseEvent): Promise<void> => {
    if (raw.data === '[DONE]') {
      if (!completed) throw new ResponsesClientError('invalid_response')
      return
    }

    let payload: unknown
    try {
      payload = JSON.parse(raw.data) as unknown
    } catch {
      throw new ResponsesClientError('invalid_response')
    }
    if (!isPlainRecord(payload)) throw new ResponsesClientError('invalid_response')

    if (raw.event === 'error') throw new ResponsesClientError('remote_error')
    if (typeof payload.type !== 'string' || payload.type.length > 128) {
      throw new ResponsesClientError('invalid_response')
    }
    if (raw.event !== 'message' && raw.event !== payload.type) {
      throw new ResponsesClientError('invalid_response')
    }
    if (payload.type === 'error' || payload.type === 'response.failed' || payload.type === 'response.incomplete') {
      throw new ResponsesClientError('remote_error')
    }
    if (completed) throw new ResponsesClientError('invalid_response')

    if (payload.type === 'response.created') {
      responseId = safeResponseId(payload.response) ?? responseId
      await deliverEvent(options.onEvent, { type: 'response.created', responseId })
      return
    }
    if (payload.type === 'response.output_text.delta') {
      if (typeof payload.delta !== 'string') throw new ResponsesClientError('invalid_response')
      const deltaBytes = Buffer.byteLength(payload.delta, 'utf8')
      if (deltaBytes > options.maxEventBytes) throw new ResponsesClientError('event_too_large')
      outputBytes += deltaBytes
      if (outputBytes > options.maxOutputTextBytes) throw new ResponsesClientError('response_too_large')
      output.push(payload.delta)
      await deliverEvent(options.onEvent, { type: 'response.output_text.delta', delta: payload.delta })
      return
    }
    if (payload.type === 'response.output_item.added') {
      toolCalls.addOutputItem(payload)
      return
    }
    if (payload.type === 'response.function_call_arguments.delta') {
      toolCalls.addArgumentsDelta(payload)
      return
    }
    if (payload.type === 'response.function_call_arguments.done') {
      toolCalls.completeArguments(payload)
      return
    }
    if (payload.type === 'response.output_item.done') {
      const outputIndex = outputIndexes.resolve(payload.output_index)
      toolCalls.completeOutputItem(payload, outputIndex)
      orderedOutput.completeOutputItem(payload, outputIndex)
      return
    }
    if (payload.type === 'response.completed') {
      responseId = safeResponseId(payload.response) ?? responseId
      toolCalls.completeResponse(payload.response)
      orderedOutput.completeResponse(payload.response)
      generatedImages = extractGeneratedImages(payload.response, options.allowImageGeneration)
      completed = true
      await deliverEvent(options.onEvent, { type: 'response.completed', responseId })
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      responseBytes += value.byteLength
      if (responseBytes > options.maxResponseBytes) {
        throw new ResponsesClientError('response_too_large')
      }
      let text: string
      try {
        text = decoder.decode(value, { stream: true })
      } catch {
        throw new ResponsesClientError('invalid_response')
      }
      for (const event of parser.push(text, value.byteLength)) await processEvent(event)
    }

    let tail: string
    try {
      tail = decoder.decode()
    } catch {
      throw new ResponsesClientError('invalid_response')
    }
    for (const event of parser.finish(tail)) await processEvent(event)
    if (!completed) throw new ResponsesClientError('invalid_response')
    const completedToolCalls = toolCalls.finish()
    const continuation = orderedOutput.finish(completedToolCalls)
    const result: ResponsesStreamResult = {
      responseId,
      outputText: output.join(''),
      toolCalls: completedToolCalls
    }
    if (generatedImages.length > 0) result.generatedImages = generatedImages
    return {
      result,
      continuationOutput: continuation.items,
      responseReasoningBytes: continuation.reasoningBytes
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
}

function extractGeneratedImages(
  response: unknown,
  allowImageGeneration: boolean
): readonly ResponsesGeneratedImage[] {
  if (!isPlainRecord(response) || !Object.hasOwn(response, 'output')) return []
  if (!Array.isArray(response.output)) invalidResponse()
  if (response.output.length > MAX_RESPONSE_OUTPUT_ITEMS) responseTooLarge()

  const generated: ResponsesGeneratedImage[] = []
  for (const item of response.output) {
    if (!isPlainRecord(item) || typeof item.type !== 'string') invalidResponse()
    if (item.type !== 'image_generation_call') continue
    if (!allowImageGeneration) invalidResponse()
    if (
      item.status !== 'completed' ||
      typeof item.result !== 'string' ||
      item.result.length > MAX_GENERATED_IMAGE_BASE64_CHARACTERS ||
      !isCanonicalBase64(item.result)
    ) {
      invalidResponse()
    }
    if (generated.length >= 4) responseTooLarge()
    const bytes = Buffer.from(item.result, 'base64')
    try {
      if (
        bytes.length < 8 ||
        bytes.length > MAX_GENERATED_IMAGE_BYTES ||
        !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
        bytes.toString('base64') !== item.result
      ) {
        invalidResponse()
      }
      generated.push(Object.freeze({
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${item.result}`
      }))
    } finally {
      bytes.fill(0)
    }
  }
  return Object.freeze(generated)
}

interface OrderedOutputCollectorOptions {
  allowedFunctionNames: ReadonlySet<string>
  allowWebSearch: boolean
  allowImageGeneration: boolean
  explicitSecrets: readonly string[]
}

class CompletedOutputIndexAllocator {
  readonly #used = new Set<number>()
  #next = 0

  resolve(value: unknown): number {
    let outputIndex: number
    if (value === undefined) {
      while (this.#used.has(this.#next)) this.#next += 1
      if (this.#next >= MAX_RESPONSE_OUTPUT_ITEMS) responseTooLarge()
      outputIndex = this.#next
    } else {
      outputIndex = normalizeOutputIndex(value)
    }
    this.#used.add(outputIndex)
    while (this.#used.has(this.#next)) this.#next += 1
    return outputIndex
  }
}

class OrderedOutputCollector {
  readonly #options: OrderedOutputCollectorOptions
  readonly #completed = new Map<number, NormalizedContinuationOutputItem>()
  readonly #missingEncryptedContent = new Set<number>()
  readonly #unknown = new Set<number>()

  constructor(options: OrderedOutputCollectorOptions) {
    this.#options = options
  }

  completeOutputItem(event: Record<string, unknown>, outputIndex: number): void {
    assertToolEventKeys(event, ['type', 'response_id', 'output_index', 'item', 'sequence_number'])
    if (!Object.hasOwn(event, 'item')) invalidResponse()
    const item = event.item
    if (!isPlainRecord(item) || typeof item.type !== 'string') invalidResponse()
    this.#complete(outputIndex, item)
  }

  completeResponse(response: unknown): void {
    if (!isPlainRecord(response) || !Object.hasOwn(response, 'output')) return
    if (!Array.isArray(response.output)) invalidResponse()
    if (response.output.length > MAX_RESPONSE_OUTPUT_ITEMS) responseTooLarge()
    for (let outputIndex = 0; outputIndex < response.output.length; outputIndex += 1) {
      const item = response.output[outputIndex]
      if (!isPlainRecord(item) || typeof item.type !== 'string') invalidResponse()
      this.#complete(outputIndex, item)
    }
  }

  finish(expectedToolCalls: readonly ResponsesToolCall[]): {
    items: readonly NormalizedContinuationOutputItem[]
    reasoningBytes: number
  } {
    const requiredForContinuation = expectedToolCalls.length > 0
    if (requiredForContinuation && (this.#missingEncryptedContent.size > 0 || this.#unknown.size > 0)) {
      invalidResponse()
    }
    const entries = [...this.#completed.entries()].sort(([left], [right]) => left - right)
    if (requiredForContinuation) {
      for (let index = 0; index < entries.length; index += 1) {
        if (entries[index]?.[0] !== index) invalidResponse()
      }
    }
    const continuationToolCalls = entries
      .map(([, item]) => item)
      .filter((item): item is Extract<NormalizedContinuationOutputItem, { type: 'function_call' }> =>
        item.type === 'function_call'
      )
    if (continuationToolCalls.length !== expectedToolCalls.length) invalidResponse()
    for (let index = 0; index < expectedToolCalls.length; index += 1) {
      const continuationCall = continuationToolCalls[index]
      const expectedCall = expectedToolCalls[index]
      if (
        continuationCall?.call_id !== expectedCall?.callId ||
        continuationCall?.name !== expectedCall?.name
      ) {
        invalidResponse()
      }
    }
    let reasoningBytes = 0
    for (const [, item] of entries) {
      if (item.type === 'reasoning') {
        reasoningBytes += Buffer.byteLength(item.encrypted_content, 'utf8')
        if (reasoningBytes > MAX_CUMULATIVE_REASONING_BYTES) responseTooLarge()
      }
    }
    return {
      items: Object.freeze(entries.map(([, item]) => item)),
      reasoningBytes
    }
  }

  #complete(outputIndex: number, wire: Record<string, unknown>): void {
    let item: NormalizedContinuationOutputItem | null | undefined
    switch (wire.type) {
      case 'reasoning':
        item = parseReasoningWireItem(wire, this.#options.explicitSecrets)
        break
      case 'function_call': {
        const parsed = parseFunctionCallWireItem(wire, this.#options.explicitSecrets)
        if (!this.#options.allowedFunctionNames.has(parsed.name)) invalidResponse()
        if (parsed.status !== null && parsed.status !== 'completed') invalidResponse()
        item = {
          type: 'function_call',
          call_id: parsed.callId,
          name: parsed.name,
          arguments: redactFunctionArgumentsForContinuation(
            parsed.argumentsText,
            this.#options.explicitSecrets
          ),
          ...(parsed.metadata === undefined
            ? {}
            : { internal_chat_message_metadata_passthrough: parsed.metadata })
        }
        break
      }
      case 'message':
        item = parseAssistantMessageWireItem(wire, this.#options.explicitSecrets)
        break
      case 'web_search_call':
        if (!this.#options.allowWebSearch) invalidResponse()
        item = parseWebSearchCallWireItem(wire, this.#options.explicitSecrets)
        break
      case 'image_generation_call':
        if (!this.#options.allowImageGeneration) invalidResponse()
        item = parseImageGenerationCallWireItem(wire, this.#options.explicitSecrets)
        break
      default:
        if (this.#completed.has(outputIndex) || this.#missingEncryptedContent.has(outputIndex)) {
          invalidResponse()
        }
        this.#unknown.add(outputIndex)
        return
    }

    if (item === null) {
      if (!this.#completed.has(outputIndex)) this.#missingEncryptedContent.add(outputIndex)
      return
    }
    const existing = this.#completed.get(outputIndex)
    if (this.#unknown.has(outputIndex)) invalidResponse()
    if (existing && JSON.stringify(existing) !== JSON.stringify(item)) invalidResponse()
    if (!existing && this.#completed.size >= MAX_RESPONSE_OUTPUT_ITEMS) responseTooLarge()
    if (
      !existing &&
      item.type === 'reasoning' &&
      [...this.#completed.values()].filter((candidate) => candidate.type === 'reasoning').length >=
        MAX_REASONING_ITEMS
    ) {
      responseTooLarge()
    }
    this.#completed.set(outputIndex, item)
    this.#missingEncryptedContent.delete(outputIndex)
  }
}

function parseReasoningWireItem(
  value: Record<string, unknown>,
  explicitSecrets: readonly string[]
): NormalizedReasoningInput | null {
  if (
    !hasOnlyKeys(value, [
      'id',
      'type',
      'status',
      'summary',
      'content',
      'encrypted_content',
      'internal_chat_message_metadata_passthrough'
    ]) ||
    value.type !== 'reasoning' ||
    !Object.hasOwn(value, 'summary') ||
    !Array.isArray(value.summary) ||
    value.summary.length > MAX_REASONING_PARTS
  ) {
    invalidResponse()
  }
  if (value.id !== undefined) normalizeOpaqueId(value.id, 'invalid_response')
  if (value.status !== undefined && value.status !== 'completed') invalidResponse()
  validateDiscardedReasoningParts(value.summary, 'summary_text')
  if (value.content !== undefined && value.content !== null) {
    if (!Array.isArray(value.content) || value.content.length > MAX_REASONING_PARTS) invalidResponse()
    validateDiscardedReasoningParts(value.content, ['reasoning_text', 'text'])
  }
  if (value.encrypted_content === undefined || value.encrypted_content === null) return null
  if (!isBoundedOpaqueReasoning(value.encrypted_content)) invalidResponse()
  if (containsSensitiveCredential(value.encrypted_content, explicitSecrets)) invalidResponse()
  const metadata = normalizePassthroughMetadata(
    value.internal_chat_message_metadata_passthrough,
    explicitSecrets
  )
  return Object.freeze({
    type: 'reasoning',
    summary: [] as const,
    encrypted_content: value.encrypted_content,
    ...(metadata === undefined
      ? {}
      : { internal_chat_message_metadata_passthrough: metadata })
  })
}

function validateDiscardedReasoningParts(value: readonly unknown[], expectedTypes: string | readonly string[]): void {
  const allowedTypes = typeof expectedTypes === 'string' ? [expectedTypes] : expectedTypes
  for (const part of value) {
    if (
      !hasExactKeys(part, ['type', 'text']) ||
      typeof part.type !== 'string' ||
      !allowedTypes.includes(part.type) ||
      typeof part.text !== 'string' ||
      part.text.length > MAX_MESSAGE_CHARACTERS ||
      part.text.includes('\0')
    ) {
      invalidResponse()
    }
  }
}

function normalizePassthroughMetadata(
  value: unknown,
  explicitSecrets: readonly string[]
): PassthroughMetadata | undefined {
  if (value === undefined || value === null) return undefined
  const normalized = normalizeBoundedJsonObject(
    value,
    'invalid_response',
    MAX_PASSTHROUGH_METADATA_BYTES
  )
  const metadata = redactJsonValue(normalized, explicitSecrets)
  if (!isPlainRecord(metadata)) invalidResponse()
  if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > MAX_PASSTHROUGH_METADATA_BYTES) {
    responseTooLarge()
  }
  return Object.freeze(metadata as ResponsesJsonObject)
}

function redactFunctionArgumentsForContinuation(
  value: string,
  explicitSecrets: readonly string[]
): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    invalidResponse()
  }
  const normalized = normalizeBoundedJsonObject(
    parsed,
    'invalid_response',
    MAX_FUNCTION_ARGUMENT_BYTES
  )
  const redacted = redactJsonValue(normalized, explicitSecrets)
  if (!isPlainRecord(redacted)) invalidResponse()
  const serialized = JSON.stringify(redacted)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_FUNCTION_ARGUMENT_BYTES) responseTooLarge()
  return serialized
}

function redactJsonValue(
  item: ResponsesJsonValue,
  explicitSecrets: readonly string[]
): ResponsesJsonValue {
  if (typeof item === 'string') return redactSensitiveContent(item, explicitSecrets)
  if (item === null || typeof item !== 'object') return item
  if (Array.isArray(item)) return item.map((child) => redactJsonValue(child, explicitSecrets))
  const output: ResponsesJsonObject = {}
  for (const [key, child] of Object.entries(item)) {
    const safeKey = redactSensitiveContent(key, explicitSecrets)
    if (Object.hasOwn(output, safeKey)) invalidResponse()
    output[safeKey] = redactJsonValue(child, explicitSecrets)
  }
  return output
}

function parseAssistantMessageWireItem(
  value: Record<string, unknown>,
  explicitSecrets: readonly string[]
): NormalizedAssistantMessageInput {
  if (
    !hasOnlyKeys(value, [
      'id',
      'type',
      'status',
      'role',
      'content',
      'phase',
      'internal_chat_message_metadata_passthrough'
    ]) ||
    value.type !== 'message' ||
    value.role !== 'assistant' ||
    !Array.isArray(value.content) ||
    value.content.length > MAX_REASONING_PARTS ||
    (value.status !== undefined && value.status !== 'completed') ||
    (value.phase !== undefined && value.phase !== 'commentary' && value.phase !== 'final_answer')
  ) {
    invalidResponse()
  }
  let textBytes = 0
  const content = value.content.map((part): { type: 'output_text'; text: string } => {
    if (
      !hasOnlyKeys(part, ['type', 'text', 'annotations', 'logprobs']) ||
      part.type !== 'output_text' ||
      typeof part.text !== 'string' ||
      part.text.includes('\0')
    ) {
      invalidResponse()
    }
    if (part.annotations !== undefined) {
      normalizeBoundedJsonObject({ value: part.annotations }, 'invalid_response', MAX_MESSAGE_CHARACTERS)
    }
    if (part.logprobs !== undefined) {
      normalizeBoundedJsonObject({ value: part.logprobs }, 'invalid_response', MAX_MESSAGE_CHARACTERS)
    }
    const text = redactSensitiveContent(part.text, explicitSecrets)
    textBytes += Buffer.byteLength(text, 'utf8')
    if (textBytes > MAX_MESSAGE_CHARACTERS) responseTooLarge()
    return Object.freeze({ type: 'output_text', text })
  })
  const metadata = normalizePassthroughMetadata(
    value.internal_chat_message_metadata_passthrough,
    explicitSecrets
  )
  return Object.freeze({
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: Object.freeze(content),
    ...(value.phase === undefined
      ? {}
      : { phase: value.phase as NormalizedAssistantMessageInput['phase'] }),
    ...(metadata === undefined
      ? {}
      : { internal_chat_message_metadata_passthrough: metadata })
  })
}

function parseWebSearchCallWireItem(
  value: Record<string, unknown>,
  explicitSecrets: readonly string[]
): NormalizedWebSearchCallInput {
  if (
    !hasOnlyKeys(value, [
      'id',
      'type',
      'status',
      'action',
      'internal_chat_message_metadata_passthrough'
    ]) ||
    value.type !== 'web_search_call' ||
    (value.status !== undefined && value.status !== 'completed')
  ) {
    invalidResponse()
  }
  const action = value.action === undefined
    ? undefined
    : normalizeWebSearchAction(value.action, explicitSecrets)
  const metadata = normalizePassthroughMetadata(
    value.internal_chat_message_metadata_passthrough,
    explicitSecrets
  )
  return Object.freeze({
    type: 'web_search_call',
    status: 'completed',
    ...(action === undefined ? {} : { action }),
    ...(metadata === undefined
      ? {}
      : { internal_chat_message_metadata_passthrough: metadata })
  })
}

function normalizeWebSearchAction(
  value: unknown,
  explicitSecrets: readonly string[]
): ResponsesJsonObject {
  if (!isPlainRecord(value) || typeof value.type !== 'string') invalidResponse()
  const redact = (text: unknown): string => {
    if (typeof text !== 'string' || text.length > MAX_MESSAGE_CHARACTERS || text.includes('\0')) {
      invalidResponse()
    }
    return redactSensitiveContent(text, explicitSecrets)
  }
  if (value.type === 'search') {
    if (!hasOnlyKeys(value, ['type', 'query', 'queries'])) invalidResponse()
    if (value.query === undefined && value.queries === undefined) invalidResponse()
    let queries: string[] | undefined
    if (value.queries !== undefined) {
      if (!Array.isArray(value.queries) || value.queries.length > MAX_WEB_ACTION_STRINGS) invalidResponse()
      queries = value.queries.map(redact)
    }
    return Object.freeze({
      type: 'search',
      ...(value.query === undefined ? {} : { query: redact(value.query) }),
      ...(queries === undefined ? {} : { queries })
    })
  }
  if (value.type === 'open_page') {
    if (!hasOnlyKeys(value, ['type', 'url']) || value.url === undefined) invalidResponse()
    return Object.freeze({ type: 'open_page', url: redact(value.url) })
  }
  if (value.type === 'find_in_page') {
    if (
      !hasOnlyKeys(value, ['type', 'url', 'pattern']) ||
      value.url === undefined ||
      value.pattern === undefined
    ) {
      invalidResponse()
    }
    return Object.freeze({
      type: 'find_in_page',
      url: redact(value.url),
      pattern: redact(value.pattern)
    })
  }
  invalidResponse()
}

function parseImageGenerationCallWireItem(
  value: Record<string, unknown>,
  explicitSecrets: readonly string[]
): NormalizedImageGenerationCallInput {
  if (
    !hasOnlyKeys(value, [
      'id',
      'type',
      'status',
      'revised_prompt',
      'result',
      'internal_chat_message_metadata_passthrough'
    ]) ||
    value.type !== 'image_generation_call' ||
    value.status !== 'completed' ||
    typeof value.result !== 'string' ||
    value.result.length > MAX_GENERATED_IMAGE_BASE64_CHARACTERS ||
    !isCanonicalBase64(value.result)
  ) {
    invalidResponse()
  }
  let revisedPrompt: string | undefined
  if (value.revised_prompt !== undefined) {
    if (
      typeof value.revised_prompt !== 'string' ||
      value.revised_prompt.length > MAX_MESSAGE_CHARACTERS ||
      value.revised_prompt.includes('\0')
    ) {
      invalidResponse()
    }
    revisedPrompt = redactSensitiveContent(value.revised_prompt, explicitSecrets)
  }
  const metadata = normalizePassthroughMetadata(
    value.internal_chat_message_metadata_passthrough,
    explicitSecrets
  )
  return Object.freeze({
    type: 'image_generation_call',
    status: 'completed',
    ...(revisedPrompt === undefined ? {} : { revised_prompt: revisedPrompt }),
    result: value.result,
    ...(metadata === undefined
      ? {}
      : { internal_chat_message_metadata_passthrough: metadata })
  })
}

function isBoundedOpaqueReasoning(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_REASONING_ENCRYPTED_CHARACTERS &&
    value.trim().length > 0 &&
    !/[^\x20-\x7e]/u.test(value)
}

interface FunctionCallWireItem {
  itemId: string | null
  callId: string
  name: string
  argumentsText: string
  status: 'in_progress' | 'completed' | 'incomplete' | null
  metadata?: PassthroughMetadata
}

interface PendingFunctionCall {
  outputIndex: number
  itemId: string | null
  callId: string
  name: string
  initialArguments: string
  argumentDeltas: string[]
  argumentBytes: number
}

interface CompletedFunctionCall {
  outputIndex: number
  call: ResponsesToolCall
  canonicalArguments: string
}

class FunctionCallCollector {
  readonly #allowedNames: ReadonlySet<string>
  readonly #pending = new Map<number, PendingFunctionCall>()
  readonly #completed = new Map<number, CompletedFunctionCall>()
  readonly #callIds = new Map<string, number>()

  constructor(allowedNames: ReadonlySet<string>) {
    this.#allowedNames = allowedNames
  }

  addOutputItem(event: Record<string, unknown>): void {
    assertToolEventKeys(event, ['type', 'response_id', 'output_index', 'item', 'sequence_number'])
    const item = event.item
    if (!isPlainRecord(item) || typeof item.type !== 'string') invalidResponse()
    if (item.type !== 'function_call') return
    if (event.output_index === undefined) return
    const outputIndex = normalizeOutputIndex(event.output_index)

    const wire = parseFunctionCallWireItem(item)
    if (!this.#allowedNames.has(wire.name)) invalidResponse()
    if (this.#pending.has(outputIndex) || this.#completed.has(outputIndex)) invalidResponse()
    if (this.#pending.size + this.#completed.size >= MAX_FUNCTION_TOOL_CALLS) responseTooLarge()
    this.#reserveCallId(wire.callId, outputIndex)
    this.#pending.set(outputIndex, {
      outputIndex,
      itemId: wire.itemId,
      callId: wire.callId,
      name: wire.name,
      initialArguments: wire.argumentsText,
      argumentDeltas: [],
      argumentBytes: Buffer.byteLength(wire.argumentsText, 'utf8')
    })
  }

  addArgumentsDelta(event: Record<string, unknown>): void {
    assertToolEventKeys(event, [
      'type',
      'response_id',
      'item_id',
      'output_index',
      'delta',
      'sequence_number',
      'obfuscation'
    ])
    if (typeof event.delta !== 'string' || event.delta.includes('\0')) invalidResponse()
    assertOptionalObfuscation(event.obfuscation)
    if (event.output_index === undefined) {
      assertOptionalEventId(event.item_id, null)
      return
    }
    const outputIndex = normalizeOutputIndex(event.output_index)
    const pending = this.#pending.get(outputIndex)
    if (!pending) {
      assertOptionalEventId(event.item_id, null)
      return
    }
    assertOptionalEventId(event.item_id, pending.itemId)

    const deltaBytes = Buffer.byteLength(event.delta, 'utf8')
    pending.argumentBytes += deltaBytes
    if (pending.argumentBytes > MAX_FUNCTION_ARGUMENT_BYTES) responseTooLarge()
    pending.argumentDeltas.push(event.delta)
  }

  completeArguments(event: Record<string, unknown>): void {
    assertToolEventKeys(event, [
      'type',
      'response_id',
      'item_id',
      'output_index',
      'arguments',
      'item',
      'sequence_number'
    ])
    const hasArguments = Object.hasOwn(event, 'arguments')
    const hasItem = Object.hasOwn(event, 'item')
    if (hasArguments === hasItem) invalidResponse()
    if (hasArguments && (typeof event.arguments !== 'string' || event.arguments.includes('\0'))) {
      invalidResponse()
    }
    if (hasArguments && Buffer.byteLength(event.arguments as string, 'utf8') > MAX_FUNCTION_ARGUMENT_BYTES) {
      responseTooLarge()
    }
    if (hasItem && (!isPlainRecord(event.item) || event.item.type !== 'function_call')) invalidResponse()
    if (event.output_index === undefined) return
    const outputIndex = normalizeOutputIndex(event.output_index)

    if (hasItem) {
      this.#complete(outputIndex, parseFunctionCallWireItem(event.item as Record<string, unknown>))
      return
    }

    const pending = this.#pending.get(outputIndex)
    if (!pending) {
      assertOptionalEventId(event.item_id, null)
      return
    }
    assertOptionalEventId(event.item_id, pending.itemId)
    this.#complete(outputIndex, {
      itemId: pending.itemId,
      callId: pending.callId,
      name: pending.name,
      argumentsText: event.arguments as string,
      status: null
    })
  }

  completeOutputItem(event: Record<string, unknown>, outputIndex: number): void {
    assertToolEventKeys(event, ['type', 'response_id', 'output_index', 'item', 'sequence_number'])
    const item = event.item
    if (!isPlainRecord(item) || typeof item.type !== 'string') invalidResponse()
    if (item.type !== 'function_call') return
    this.#complete(outputIndex, parseFunctionCallWireItem(item))
  }

  completeResponse(response: unknown): void {
    if (!isPlainRecord(response) || !Object.hasOwn(response, 'output')) return
    if (!Array.isArray(response.output)) invalidResponse()
    if (response.output.length > MAX_RESPONSE_OUTPUT_ITEMS) responseTooLarge()
    for (let outputIndex = 0; outputIndex < response.output.length; outputIndex += 1) {
      const item = response.output[outputIndex]
      if (!isPlainRecord(item) || typeof item.type !== 'string') invalidResponse()
      if (item.type === 'function_call') this.#complete(outputIndex, parseFunctionCallWireItem(item))
    }
  }

  finish(): ResponsesToolCall[] {
    if (this.#pending.size > 0) invalidResponse()
    return [...this.#completed.values()]
      .sort((left, right) => left.outputIndex - right.outputIndex)
      .map((entry) => ({
        callId: entry.call.callId,
        name: entry.call.name,
        arguments: structuredClone(entry.call.arguments)
      }))
  }

  #complete(outputIndex: number, wire: FunctionCallWireItem): void {
    if (!this.#allowedNames.has(wire.name)) invalidResponse()
    if (wire.status !== null && wire.status !== 'completed') invalidResponse()
    const pending = this.#pending.get(outputIndex)
    if (pending) {
      if (
        pending.callId !== wire.callId ||
        pending.name !== wire.name ||
        (pending.itemId !== null && wire.itemId !== null && pending.itemId !== wire.itemId)
      ) {
        invalidResponse()
      }
      const accumulated = `${pending.initialArguments}${pending.argumentDeltas.join('')}`
      if (accumulated.length > 0 && accumulated !== wire.argumentsText) invalidResponse()
    }

    const call = parseCompletedFunctionCall(wire)
    const canonicalArguments = canonicalJson(call.arguments)
    const existing = this.#completed.get(outputIndex)
    if (existing) {
      if (
        existing.call.callId !== call.callId ||
        existing.call.name !== call.name ||
        existing.canonicalArguments !== canonicalArguments
      ) {
        invalidResponse()
      }
      this.#pending.delete(outputIndex)
      return
    }

    if (this.#completed.size >= MAX_FUNCTION_TOOL_CALLS) responseTooLarge()
    this.#reserveCallId(call.callId, outputIndex)
    this.#completed.set(outputIndex, { outputIndex, call, canonicalArguments })
    this.#pending.delete(outputIndex)
  }

  #reserveCallId(callId: string, outputIndex: number): void {
    const existingIndex = this.#callIds.get(callId)
    if (existingIndex !== undefined && existingIndex !== outputIndex) invalidResponse()
    this.#callIds.set(callId, outputIndex)
  }
}

function assertToolEventKeys(event: Record<string, unknown>, allowedKeys: readonly string[]): void {
  if (!hasOnlyKeys(event, allowedKeys)) invalidResponse()
  if (event.response_id !== undefined) normalizeOpaqueId(event.response_id, 'invalid_response')
  if (
    event.sequence_number !== undefined &&
    (!Number.isSafeInteger(event.sequence_number) || Number(event.sequence_number) < 0)
  ) {
    invalidResponse()
  }
}

function assertOptionalEventId(value: unknown, expected: string | null): void {
  if (value === undefined) return
  const itemId = normalizeOpaqueId(value, 'invalid_response')
  if (expected !== null && itemId !== expected) invalidResponse()
}

function assertOptionalObfuscation(value: unknown): void {
  if (value === undefined) return
  if (typeof value !== 'string' || value.length > MAX_FUNCTION_ARGUMENT_BYTES || value.includes('\0')) {
    invalidResponse()
  }
}

function normalizeOutputIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= MAX_RESPONSE_OUTPUT_ITEMS) {
    invalidResponse()
  }
  return Number(value)
}

function parseFunctionCallWireItem(
  value: Record<string, unknown>,
  explicitSecrets: readonly string[] = []
): FunctionCallWireItem {
  if (
    !hasOnlyKeys(value, [
      'id',
      'type',
      'status',
      'call_id',
      'name',
      'arguments',
      'internal_chat_message_metadata_passthrough'
    ]) ||
    value.type !== 'function_call' ||
    !Object.hasOwn(value, 'call_id') ||
    !Object.hasOwn(value, 'name') ||
    !Object.hasOwn(value, 'arguments')
  ) {
    invalidResponse()
  }
  if (value.status !== undefined && !['in_progress', 'completed', 'incomplete'].includes(String(value.status))) {
    invalidResponse()
  }
  const itemId = value.id === undefined ? null : normalizeOpaqueId(value.id, 'invalid_response')
  const callId = normalizeCallId(value.call_id, 'invalid_response')
  const name = normalizeFunctionName(value.name, 'invalid_response')
  if (typeof value.arguments !== 'string' || value.arguments.includes('\0')) invalidResponse()
  if (Buffer.byteLength(value.arguments, 'utf8') > MAX_FUNCTION_ARGUMENT_BYTES) responseTooLarge()
  return {
    itemId,
    callId,
    name,
    argumentsText: value.arguments,
    status: value.status === undefined
      ? null
      : value.status as FunctionCallWireItem['status'],
    metadata: normalizePassthroughMetadata(
      value.internal_chat_message_metadata_passthrough,
      explicitSecrets
    )
  }
}

function parseCompletedFunctionCall(wire: FunctionCallWireItem): ResponsesToolCall {
  let parsed: unknown
  try {
    parsed = JSON.parse(wire.argumentsText) as unknown
  } catch {
    invalidResponse()
  }
  return {
    callId: wire.callId,
    name: wire.name,
    arguments: normalizeBoundedJsonObject(parsed, 'invalid_response', MAX_FUNCTION_ARGUMENT_BYTES)
  }
}

class BoundedSseParser {
  readonly #maxEventBytes: number
  readonly #maxImageCompletionEventBytes: number
  #buffer = ''
  #bufferBytes = 0
  #scanOffset = 0
  #eventName = 'message'
  #dataLines: string[] = []
  #eventBytes = 0

  constructor(maxEventBytes: number, maxImageCompletionEventBytes: number) {
    this.#maxEventBytes = maxEventBytes
    this.#maxImageCompletionEventBytes = maxImageCompletionEventBytes
  }

  push(text: string, sourceBytes: number): RawSseEvent[] {
    this.#buffer += text
    this.#bufferBytes += sourceBytes
    return this.#drain(false)
  }

  finish(text: string): RawSseEvent[] {
    this.#buffer += text
    return this.#drain(true)
  }

  #drain(final: boolean): RawSseEvent[] {
    const events: RawSseEvent[] = []
    let consumedCharacters = 0
    let scanOffset = this.#scanOffset
    while (true) {
      const lineEnd = firstLineEnding(this.#buffer, scanOffset)
      if (lineEnd < 0) {
        scanOffset = this.#buffer.length
        break
      }
      if (!final && this.#buffer[lineEnd] === '\r' && lineEnd === this.#buffer.length - 1) {
        scanOffset = lineEnd
        break
      }
      const delimiterLength = this.#buffer[lineEnd] === '\r' && this.#buffer[lineEnd + 1] === '\n' ? 2 : 1
      const line = this.#buffer.slice(consumedCharacters, lineEnd)
      const consumedBytes = Buffer.byteLength(line, 'utf8') + delimiterLength
      this.#bufferBytes = Math.max(0, this.#bufferBytes - consumedBytes)
      this.#processLine(line, consumedBytes, events)
      consumedCharacters = lineEnd + delimiterLength
      scanOffset = consumedCharacters
    }

    if (consumedCharacters > 0) {
      this.#buffer = this.#buffer.slice(consumedCharacters)
      scanOffset -= consumedCharacters
    }
    this.#scanOffset = scanOffset

    if (final && this.#buffer.length > 0) {
      const line = this.#buffer
      const consumedBytes = Buffer.byteLength(line, 'utf8')
      this.#buffer = ''
      this.#bufferBytes = Math.max(0, this.#bufferBytes - consumedBytes)
      this.#scanOffset = 0
      this.#processLine(line, consumedBytes, events)
    }
    this.#assertBounded()
    if (final) this.#dispatch(events)
    return events
  }

  #processLine(line: string, consumedBytes: number, events: RawSseEvent[]): void {
    this.#eventBytes += consumedBytes
    if (this.#eventBytes > this.#currentEventLimit()) {
      throw new ResponsesClientError('event_too_large')
    }
    if (line === '') {
      this.#dispatch(events)
      return
    }
    if (line.startsWith(':')) return
    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    let value = separator < 0 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') this.#eventName = value || 'message'
    else if (field === 'data') this.#dataLines.push(value)
  }

  #dispatch(events: RawSseEvent[]): void {
    if (this.#dataLines.length > 0) {
      events.push({ event: this.#eventName, data: this.#dataLines.join('\n') })
    }
    this.#eventName = 'message'
    this.#dataLines = []
    this.#eventBytes = 0
  }

  #assertBounded(): void {
    if (this.#eventBytes + this.#bufferBytes > this.#currentEventLimit()) {
      throw new ResponsesClientError('event_too_large')
    }
  }

  #currentEventLimit(): number {
    return this.#eventName === 'response.completed'
      ? this.#maxImageCompletionEventBytes
      : this.#maxEventBytes
  }
}

async function deliverEvent(
  consumer: ResponsesStreamOptions['onEvent'],
  event: ResponsesStreamEvent
): Promise<void> {
  if (!consumer) return
  try {
    await consumer(event)
  } catch {
    throw new ResponsesClientError('consumer_error')
  }
}

function safeResponseId(response: unknown): string | null {
  if (!isPlainRecord(response) || typeof response.id !== 'string') return null
  if (
    response.id.length < 1 ||
    response.id.length > MAX_RESPONSE_ID_LENGTH ||
    !/^[A-Za-z0-9._:-]+$/u.test(response.id)
  ) {
    return null
  }
  return response.id
}

function firstLineEnding(text: string, start: number): number {
  const carriageReturn = text.indexOf('\r', start)
  const lineFeed = text.indexOf('\n', start)
  if (carriageReturn < 0) return lineFeed
  if (lineFeed < 0) return carriageReturn
  return Math.min(carriageReturn, lineFeed)
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Rejected response bodies are intentionally discarded without inspection.
  }
}

function classifyRemoteFailure(
  status: number,
  hasFunctionTools: boolean
): ResponsesRemoteFailure {
  if (status === 401 || status === 403) return 'authorization'
  if ((status === 400 || status === 422) && hasFunctionTools) return 'tool_incompatible'
  if (status === 404 || status === 405) return 'responses_unsupported'
  if (status === 429) return 'rate_limited'
  if (status >= 500 && status <= 599) return 'server_error'
  return 'request_rejected'
}

function isResponsesRemoteFailure(value: unknown): value is ResponsesRemoteFailure {
  return value === 'authorization' ||
    value === 'tool_incompatible' ||
    value === 'responses_unsupported' ||
    value === 'rate_limited' ||
    value === 'server_error' ||
    value === 'request_rejected'
}

function configurationInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ResponsesClientError('invalid_configuration')
  }
  return value
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    isPlainRecordLike(value) &&
    typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function' &&
    typeof value.removeEventListener === 'function'
  )
}

function isPlainRecordLike(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecordLike(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys<K extends string>(value: unknown, allowedKeys: readonly K[]): value is Record<K, unknown> {
  if (!isPlainRecord(value)) return false
  const allowed = new Set<string>(allowedKeys)
  return Object.keys(value).every((key) => allowed.has(key))
}

function hasExactKeys<K extends string>(value: unknown, expectedKeys: readonly K[]): value is Record<K, unknown> {
  if (!hasOnlyKeys(value, expectedKeys)) return false
  const actualKeys = Object.keys(value)
  return actualKeys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key))
}

function normalizeCallId(
  value: unknown,
  errorCode: 'invalid_input' | 'invalid_response'
): string {
  return normalizeOpaqueId(value, errorCode)
}

function normalizeOpaqueId(
  value: unknown,
  errorCode: 'invalid_input' | 'invalid_response'
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_CALL_ID_LENGTH ||
    !CALL_ID_PATTERN.test(value)
  ) {
    throw new ResponsesClientError(errorCode)
  }
  return value
}

function normalizeFunctionName(
  value: unknown,
  errorCode: 'invalid_input' | 'invalid_response'
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_FUNCTION_NAME_LENGTH ||
    !FUNCTION_NAME_PATTERN.test(value)
  ) {
    throw new ResponsesClientError(errorCode)
  }
  return value
}

function normalizeBoundedJsonObject(
  value: unknown,
  errorCode: 'invalid_input' | 'invalid_response',
  maxBytes: number
): ResponsesJsonObject {
  const budget = { nodes: 0 }

  const fail = (oversized = false): never => {
    if (oversized && errorCode === 'invalid_response') responseTooLarge()
    throw new ResponsesClientError(errorCode)
  }

  const visit = (item: unknown, depth: number): ResponsesJsonValue => {
    budget.nodes += 1
    if (depth > MAX_JSON_DEPTH || budget.nodes > MAX_JSON_NODES) fail(true)
    if (item === null || typeof item === 'boolean') return item
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail()
      return item
    }
    if (typeof item === 'string') {
      if (item.length > MAX_JSON_STRING_CHARACTERS) fail(true)
      if (item.includes('\0')) fail()
      return item
    }
    if (Array.isArray(item)) return item.map((child) => visit(child, depth + 1))
    if (!isPlainRecord(item)) fail()
    const record = item as Record<string, unknown>

    const output: ResponsesJsonObject = {}
    for (const ownKey of Reflect.ownKeys(record)) {
      if (typeof ownKey !== 'string') fail()
      const key = ownKey as string
      if (key.length > MAX_JSON_KEY_LENGTH || FORBIDDEN_JSON_KEYS.has(key)) fail()
      const descriptor = Object.getOwnPropertyDescriptor(record, key)
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail()
      output[key] = visit((descriptor as PropertyDescriptor & { value: unknown }).value, depth + 1)
    }
    return output
  }

  const normalized = visit(value, 0)
  if (!isPlainRecord(normalized)) fail()
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > maxBytes) fail(true)
  return normalized as ResponsesJsonObject
}

function canonicalJson(value: ResponsesJsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(',')}}`
}

function invalidResponse(): never {
  throw new ResponsesClientError('invalid_response')
}

function responseTooLarge(): never {
  throw new ResponsesClientError('response_too_large')
}

function invalidInput(): never {
  throw new ResponsesClientError('invalid_input')
}
