import type {
  ModelCapabilities,
  ModelDescriptor,
  ModelWireMode,
  ReasoningEffort,
  WorkspaceMode
} from '../../shared/contracts.ts'
import { isValidModelId } from '../../shared/contracts.ts'

const MAX_ENDPOINT_LENGTH = 2_048
const MAX_API_KEY_LENGTH = 32_768
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_MODEL_ROWS = 2_048
const DEFAULT_TIMEOUT_MS = 15_000
const UNVERIFIED_REASONING: readonly ReasoningEffort[] = Object.freeze([
  'auto',
  'light',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
])
const RESPONSES_LITE_CODEX_MODELS = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna'
])

type CatalogErrorCode =
  | 'invalid_endpoint'
  | 'invalid_credential'
  | 'network_error'
  | 'timeout'
  | 'remote_rejected'
  | 'response_too_large'
  | 'invalid_response'

export class ModelCatalogError extends Error {
  readonly code: CatalogErrorCode
  readonly retryable: boolean

  constructor(code: CatalogErrorCode, message: string, retryable = false) {
    super(message)
    this.name = 'ModelCatalogError'
    this.code = code
    this.retryable = retryable
  }
}

export interface ModelCatalogCredentials {
  baseUrl: string
  apiKey: string
}

export interface ModelCatalogOptions {
  fetcher?: typeof fetch
  timeoutMs?: number
  maxResponseBytes?: number
}

export class RemoteModelCatalogService {
  private readonly fetcher: typeof fetch
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number

  constructor(options: ModelCatalogOptions = {}) {
    this.fetcher = options.fetcher ?? globalThis.fetch
    this.timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 60_000)
    this.maxResponseBytes = boundedInteger(
      options.maxResponseBytes,
      MAX_RESPONSE_BYTES,
      1_024,
      MAX_RESPONSE_BYTES
    )
  }

  async list(
    credentials: ModelCatalogCredentials,
    mode: WorkspaceMode
  ): Promise<ModelDescriptor[]> {
    const baseUrl = normalizeModelEndpoint(credentials.baseUrl)
    const apiKey = validateApiKey(credentials.apiKey)
    const requestUrl = `${baseUrl}/models`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    timer.unref?.()

    try {
      const response = await this.fetcher(requestUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        redirect: 'manual',
        signal: controller.signal
      })

      if (response.status >= 300 && response.status < 400) {
        await discardResponseBody(response)
        throw new ModelCatalogError(
          'remote_rejected',
          '模型服务尝试重定向。请直接配置并确认最终 HTTPS endpoint。'
        )
      }
      if (!response.ok) {
        await discardResponseBody(response)
        throw remoteStatusError(response.status)
      }

      const payload = await readJsonResponse(response, this.maxResponseBytes)
      return parseModelCatalog(payload, mode)
    } catch (error) {
      if (error instanceof ModelCatalogError) throw error
      if (controller.signal.aborted) {
        throw new ModelCatalogError('timeout', '读取模型目录超时，请重试。', true)
      }
      // Raw fetch failures can contain a URL, local path, or request metadata.
      throw new ModelCatalogError('network_error', '无法连接已确认的模型 endpoint。', true)
    } finally {
      clearTimeout(timer)
    }
  }
}

export function modelCatalogFromIds(
  ids: readonly string[],
  mode: WorkspaceMode
): ModelDescriptor[] {
  if (!Array.isArray(ids) || ids.length > MAX_MODEL_ROWS) {
    throw new ModelCatalogError('invalid_response', '账户模型目录条目超过安全数量限制。')
  }
  return parseModelCatalog([...ids], mode)
}

export function normalizeModelEndpoint(value: unknown): string {
  if (typeof value !== 'string') invalidEndpoint()
  const text = value.trim()
  if (!text || text.length > MAX_ENDPOINT_LENGTH || /[\r\n\0]/.test(text)) invalidEndpoint()

  let endpoint: URL
  try {
    endpoint = new URL(text)
  } catch {
    invalidEndpoint()
  }

  const hostname = endpoint.hostname.toLowerCase()
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  if (
    (endpoint.protocol !== 'https:' && !(loopback && endpoint.protocol === 'http:')) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    invalidEndpoint()
  }

  const pathname = endpoint.pathname.replace(/\/+$/, '')
  endpoint.pathname = pathname || '/'
  return endpoint.toString().replace(/\/$/, '')
}

function invalidEndpoint(): never {
  throw new ModelCatalogError(
    'invalid_endpoint',
    '模型 endpoint 必须是无凭据、查询参数和片段的 HTTPS 地址；本机开发可使用 loopback HTTP。'
  )
}

function validateApiKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_API_KEY_LENGTH ||
    /[\r\n\0]/.test(value)
  ) {
    throw new ModelCatalogError('invalid_credential', 'API Key 无效。')
  }
  return value
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.floor(value)))
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The response is already rejected; body disposal is best-effort.
  }
}

function remoteStatusError(status: number): ModelCatalogError {
  if (status === 401 || status === 403) {
    return new ModelCatalogError('remote_rejected', 'API Key 无效或无权读取模型目录。')
  }
  if (status === 429 || status >= 500) {
    return new ModelCatalogError('remote_rejected', `模型服务暂时不可用（HTTP ${status}）。`, true)
  }
  return new ModelCatalogError('remote_rejected', `模型服务拒绝了目录请求（HTTP ${status}）。`)
}

async function readJsonResponse(response: Response, maxBytes: number): Promise<unknown> {
  const contentLength = response.headers.get('content-length')
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    await discardResponseBody(response)
    throw new ModelCatalogError('response_too_large', '模型目录响应超过安全大小限制。')
  }

  let bytes = 0
  const chunks: Uint8Array[] = []
  if (response.body) {
    const reader = response.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > maxBytes) {
          await reader.cancel().catch(() => undefined)
          throw new ModelCatalogError('response_too_large', '模型目录响应超过安全大小限制。')
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
  }

  const body = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
    return JSON.parse(text)
  } catch (error) {
    if (error instanceof ModelCatalogError) throw error
    throw new ModelCatalogError('invalid_response', '模型目录响应不是有效 JSON。')
  }
}

function parseModelCatalog(payload: unknown, mode: WorkspaceMode): ModelDescriptor[] {
  const rows = modelRows(payload)
  if (rows.length > MAX_MODEL_ROWS) {
    throw new ModelCatalogError('invalid_response', '模型目录条目超过安全数量限制。')
  }

  const seen = new Set<string>()
  const models: ModelDescriptor[] = []
  for (const row of rows) {
    const id = modelId(row)
    if (!id || seen.has(id)) continue
    seen.add(id)
    models.push(toDescriptor(id, row, mode))
  }
  if (models.length === 0) {
    throw new ModelCatalogError('invalid_response', '模型目录没有包含可用的模型 ID。')
  }
  return models.sort((left, right) => left.id.localeCompare(right.id))
}

function modelRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (!isObject(payload)) {
    throw new ModelCatalogError('invalid_response', '模型目录响应结构无效。')
  }
  if (Array.isArray(payload.data)) return payload.data
  if (Array.isArray(payload.models)) return payload.models
  throw new ModelCatalogError('invalid_response', '模型目录响应结构无效。')
}

function modelId(row: unknown): string | null {
  const raw = typeof row === 'string'
    ? row
    : isObject(row)
      ? row.id ?? row.name ?? row.model
      : null
  return isValidModelId(raw) ? raw : null
}

function toDescriptor(id: string, row: unknown, mode: WorkspaceMode): ModelDescriptor {
  const declaredCapabilities = readDeclaredCapabilities(row)
  const declaredReasoning = readDeclaredReasoning(row)
  const declaredWireMode = readDeclaredWireMode(row)
  const trustedOwner = readTrustedOwner(row)
  const wireMode = declaredWireMode ?? (
    RESPONSES_LITE_CODEX_MODELS.has(id) ? 'lite' : 'standard'
  )
  return {
    id,
    label: id,
    provider: 'openai-compatible',
    wireMode,
    ...(declaredWireMode === undefined ? {} : { declaredWireMode }),
    ...(trustedOwner === undefined ? {} : { trustedOwner }),
    // The remote /models schema does not reliably declare mode restrictions.
    // Keep every returned model selectable and expose inferred capabilities separately.
    modes: mode === 'chat' ? ['chat', 'agent'] : ['chat', 'agent'],
    reasoning: declaredReasoning ?? [...UNVERIFIED_REASONING],
    ...(declaredReasoning === undefined ? {} : { declaredReasoning }),
    capabilities: displayCapabilities(declaredCapabilities, wireMode, trustedOwner),
    declaredCapabilities,
    source: 'remote'
  }
}

function readTrustedOwner(row: unknown): 'codex' | undefined {
  if (!isObject(row)) return undefined
  return row.owned_by === 'codex' ? 'codex' : undefined
}

function readDeclaredWireMode(row: unknown): ModelWireMode | undefined {
  if (!isObject(row)) return undefined
  const sources = [row, isObject(row.metadata) ? row.metadata : null]
  let declared: ModelWireMode | undefined

  const merge = (candidate: ModelWireMode): void => {
    if (declared !== undefined && declared !== candidate) {
      throw new ModelCatalogError(
        'invalid_response',
        'The model catalog contains conflicting wire mode declarations.'
      )
    }
    declared = candidate
  }

  for (const source of sources) {
    if (!source) continue
    for (const field of ['wire_mode', 'wireMode'] as const) {
      if (!Object.hasOwn(source, field)) continue
      const value = source[field]
      const normalized = normalizeDeclaredWireMode(value)
      if (!normalized) {
        throw new ModelCatalogError(
          'invalid_response',
          'The model catalog contains an invalid wire mode declaration.'
        )
      }
      merge(normalized)
    }
    for (const field of ['use_responses_lite', 'useResponsesLite'] as const) {
      if (!Object.hasOwn(source, field)) continue
      const value = source[field]
      if (typeof value !== 'boolean') {
        throw new ModelCatalogError(
          'invalid_response',
          'The model catalog contains an invalid Responses Lite declaration.'
        )
      }
      merge(value ? 'lite' : 'standard')
    }
  }
  return declared
}

function normalizeDeclaredWireMode(value: unknown): ModelWireMode | null {
  if (value === 'lite' || value === 'responses_lite') return 'lite'
  if (value === 'standard' || value === 'responses') return 'standard'
  return null
}

function readDeclaredReasoning(row: unknown): ReasoningEffort[] | undefined {
  if (!isObject(row)) return undefined
  const candidates: unknown[] = []
  let declared = false
  if (Array.isArray(row.reasoning)) {
    declared = true
    candidates.push(...row.reasoning)
  }
  if (Array.isArray(row.supported_reasoning_levels)) {
    declared = true
    for (const level of row.supported_reasoning_levels) {
      if (isObject(level) && Object.hasOwn(level, 'effort')) candidates.push(level.effort)
    }
  }
  if (!declared) return undefined
  const explicit = candidates
    .map(normalizeReasoningEffort)
    .filter((value): value is ReasoningEffort => value !== null)
  return uniqueReasoning(['auto', ...explicit])
}

function uniqueReasoning(values: ReasoningEffort[]): ReasoningEffort[] {
  return [...new Set(values)]
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | null {
  if (value === 'low') return 'light'
  return (
    value === 'auto' ||
    value === 'light' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'ultra'
  ) ? value : null
}

function readDeclaredCapabilities(row: unknown): Partial<ModelCapabilities> {
  const explicit = isObject(row) && isObject(row.capabilities) ? row.capabilities : null
  const declared: Partial<ModelCapabilities> = {}
  const names: Array<keyof ModelCapabilities> = [
    'attachments',
    'imageInput',
    'imageGeneration',
    'subagents',
    'toolUse',
    'webSearch'
  ]
  for (const name of names) {
    if (!explicit || !Object.hasOwn(explicit, name)) continue
    const value = explicit?.[name]
    if (typeof value === 'boolean') declared[name] = value
  }
  return declared
}

function displayCapabilities(
  declared: Partial<ModelCapabilities>,
  wireMode: ModelWireMode,
  trustedOwner: 'codex' | undefined
): ModelCapabilities {
  const liteTransport = wireMode === 'lite'
  return {
    attachments: declared.attachments === true,
    imageInput: declared.imageInput === true,
    imageGeneration: !liteTransport && declared.imageGeneration === true,
    subagents: declared.subagents === true,
    toolUse: declared.toolUse === true,
    webSearch: !liteTransport && (
      declared.webSearch ?? trustedOwner === 'codex'
    )
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
