import { randomUUID } from 'node:crypto'

import type {
  ConversationMessageDto,
  ConversationMessageStatus,
  ConversationSnapshot,
  TaskSummary,
  WorkspaceMode
} from '../../shared/contracts'
import { redactSensitiveContent } from '../security/redaction.ts'

const DOCUMENT_FORMAT = 'ai-terminal.conversation-history'
const DOCUMENT_VERSION = 2
const LEGACY_DOCUMENT_VERSION = 1
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024
const MAX_TASKS = 256
const MAX_MESSAGES_PER_TASK = 2_000
const MAX_TOTAL_MESSAGES = 10_000
const MAX_TITLE_CHARACTERS = 200
const MAX_PROJECT_ID_CHARACTERS = 128
const MAX_MESSAGE_BYTES = 256 * 1024
const TASK_ID_PATTERN =
  /^task:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MESSAGE_ID_PATTERN =
  /^message:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export type ConversationHistoryErrorCode =
  | 'invalid_configuration'
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'limit_exceeded'
  | 'corrupt_data'
  | 'storage_error'

const ERROR_MESSAGES: Record<ConversationHistoryErrorCode, string> = {
  invalid_configuration: 'Conversation history storage is not configured correctly.',
  invalid_input: 'Conversation history input is invalid.',
  not_found: 'Conversation history item was not found.',
  conflict: 'Conversation state cannot be changed.',
  limit_exceeded: 'Conversation history has reached a storage limit.',
  corrupt_data: 'Stored conversation history is invalid or damaged.',
  storage_error: 'Conversation history could not be stored securely.'
}

export class ConversationHistoryError extends Error {
  readonly code: ConversationHistoryErrorCode

  constructor(code: ConversationHistoryErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'ConversationHistoryError'
    this.code = code
    this.stack = `${this.name}: ${this.message}`
  }
}

export interface ConversationHistoryStorage {
  read(): Promise<string | null>
  write(serializedDocument: string): Promise<void>
}

export interface ConversationTaskCreateInput {
  projectId: string
  title?: string
  mode: WorkspaceMode
}

export interface ConversationMessageAppendInput {
  taskId: string
  role: ConversationMessageDto['role']
  content: string
  status?: ConversationMessageStatus
}

export interface ConversationMessageStatusInput {
  taskId: string
  messageId: string
  status: ConversationMessageStatus
}

export interface ConversationMessageReceipt {
  id: string
  taskId: string
  role: ConversationMessageDto['role']
  status: ConversationMessageStatus
  createdAt: string
  updatedAt: string
}

interface StoredConversationTask {
  id: string
  projectId: string
  title: string
  mode: WorkspaceMode
  status: TaskSummary['status']
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  messages: ConversationMessageDto[]
}

interface ConversationHistoryDocument {
  format: typeof DOCUMENT_FORMAT
  version: typeof DOCUMENT_VERSION
  tasks: StoredConversationTask[]
}

export class ConversationHistoryService {
  readonly #storage: ConversationHistoryStorage
  #operationTail: Promise<void> = Promise.resolve()

  constructor(storage: ConversationHistoryStorage) {
    assertMainProcess()
    let validStorage = false
    try {
      validStorage =
        Boolean(storage) &&
        typeof storage === 'object' &&
        typeof storage.read === 'function' &&
        typeof storage.write === 'function'
    } catch {
      validStorage = false
    }
    if (!validStorage) throw new ConversationHistoryError('invalid_configuration')
    this.#storage = storage
  }

  async list(): Promise<TaskSummary[]> {
    return this.#exclusive(async () => {
      const document = await this.#loadDocument()
      return document.tasks
        .map(toTaskSummary)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    })
  }

  async create(input: ConversationTaskCreateInput): Promise<TaskSummary> {
    return this.#exclusive(async () => {
      const normalized = normalizeCreateInputSafely(input)
      const document = await this.#loadDocument()
      if (document.tasks.length >= MAX_TASKS) {
        throw new ConversationHistoryError('limit_exceeded')
      }

      const timestamp = nextTimestamp(document)
      const task: StoredConversationTask = {
        id: createOpaqueId('task', document.tasks.map((candidate) => candidate.id)),
        projectId: normalized.projectId,
        title: normalized.title,
        mode: normalized.mode,
        status: 'idle',
        createdAt: timestamp,
        updatedAt: timestamp,
        archivedAt: null,
        messages: []
      }
      document.tasks.push(task)
      await this.#saveDocument(document)
      return toTaskSummary(task)
    })
  }

  /** The only service call that returns persisted conversation content. */
  async load(taskId: string): Promise<ConversationSnapshot> {
    return this.#exclusive(async () => {
      assertTaskId(taskId)
      const document = await this.#loadDocument()
      const task = findTask(document, taskId)
      return {
        task: toTaskSummary(task),
        messages: task.messages.map(toPublicMessage),
        events: []
      }
    })
  }

  async rename(taskId: string, title: string): Promise<TaskSummary> {
    return this.#exclusive(async () => {
      assertTaskId(taskId)
      const normalizedTitle = normalizeTitleSafely(title)
      const document = await this.#loadDocument()
      const task = findTask(document, taskId)
      if (task.title !== normalizedTitle) {
        task.title = normalizedTitle
        task.updatedAt = nextTimestamp(document)
        await this.#saveDocument(document)
      }
      return toTaskSummary(task)
    })
  }

  async setArchived(taskId: string, archived: boolean): Promise<TaskSummary> {
    return this.#exclusive(async () => {
      assertTaskId(taskId)
      if (typeof archived !== 'boolean') throw new ConversationHistoryError('invalid_input')
      const document = await this.#loadDocument()
      const task = findTask(document, taskId)

      if (archived) {
        if (task.archivedAt !== null) return toTaskSummary(task)
        if (task.status === 'running' || task.status === 'waiting-approval') {
          throw new ConversationHistoryError('conflict')
        }
        task.archivedAt = nextTimestamp(document)
      } else {
        if (task.archivedAt === null) return toTaskSummary(task)
        task.archivedAt = null
      }

      await this.#saveDocument(document)
      return toTaskSummary(task)
    })
  }

  async delete(taskId: string): Promise<void> {
    return this.#exclusive(async () => {
      assertTaskId(taskId)
      const document = await this.#loadDocument()
      const index = document.tasks.findIndex((task) => task.id === taskId)
      if (index < 0) throw new ConversationHistoryError('not_found')
      document.tasks.splice(index, 1)
      await this.#saveDocument(document)
    })
  }

  async appendMessage(input: ConversationMessageAppendInput): Promise<ConversationMessageReceipt> {
    return this.#exclusive(async () => {
      const normalized = normalizeAppendInputSafely(input)
      const document = await this.#loadDocument()
      const task = findTask(document, normalized.taskId)
      if (task.archivedAt !== null) throw new ConversationHistoryError('conflict')
      if (task.messages.length >= MAX_MESSAGES_PER_TASK || countMessages(document) >= MAX_TOTAL_MESSAGES) {
        throw new ConversationHistoryError('limit_exceeded')
      }

      const timestamp = nextTimestamp(document)
      const message: ConversationMessageDto = {
        id: createOpaqueId(
          'message',
          document.tasks.flatMap((candidate) => candidate.messages.map((item) => item.id))
        ),
        role: normalized.role,
        content: normalized.content,
        status: normalized.status,
        createdAt: timestamp,
        updatedAt: timestamp
      }
      task.messages.push(message)
      task.status = deriveTaskStatus(task.messages)
      task.updatedAt = timestamp
      await this.#saveDocument(document)
      return toMessageReceipt(task.id, message)
    })
  }

  async updateMessageStatus(
    input: ConversationMessageStatusInput
  ): Promise<ConversationMessageReceipt> {
    return this.#exclusive(async () => {
      const normalized = normalizeStatusInputSafely(input)
      const document = await this.#loadDocument()
      const task = findTask(document, normalized.taskId)
      if (task.archivedAt !== null) throw new ConversationHistoryError('conflict')
      const message = task.messages.find((candidate) => candidate.id === normalized.messageId)
      if (!message) throw new ConversationHistoryError('not_found')
      if (!canTransitionMessageStatus(message, normalized.status)) {
        throw new ConversationHistoryError('conflict')
      }

      if (message.status !== normalized.status) {
        const timestamp = nextTimestamp(document)
        message.status = normalized.status
        message.updatedAt = timestamp
        task.status = deriveTaskStatus(task.messages)
        task.updatedAt = timestamp
        await this.#saveDocument(document)
      }
      return toMessageReceipt(task.id, message)
    })
  }

  async #loadDocument(): Promise<ConversationHistoryDocument> {
    let serialized: string | null
    try {
      serialized = await this.#storage.read()
    } catch {
      throw new ConversationHistoryError('storage_error')
    }

    if (serialized === null) return createEmptyDocument()
    if (
      typeof serialized !== 'string' ||
      serialized.length === 0 ||
      Buffer.byteLength(serialized, 'utf8') > MAX_DOCUMENT_BYTES
    ) {
      throw new ConversationHistoryError('corrupt_data')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(serialized)
    } catch {
      throw new ConversationHistoryError('corrupt_data')
    }
    const loaded = parseDocumentForLoad(parsed)
    if (loaded.requiresMigration) {
      // Do not release decrypted v1 history unless its v2 encrypted replacement is durable.
      await this.#saveDocument(loaded.document)
    }
    return loaded.document
  }

  async #saveDocument(document: ConversationHistoryDocument): Promise<void> {
    const strictDocument = parseDocument(document)
    const serialized = JSON.stringify(strictDocument)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_DOCUMENT_BYTES) {
      throw new ConversationHistoryError('limit_exceeded')
    }
    try {
      await this.#storage.write(serialized)
    } catch {
      throw new ConversationHistoryError('storage_error')
    }
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#operationTail
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    this.#operationTail = previous.then(
      () => gate,
      () => gate
    )

    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

function createEmptyDocument(): ConversationHistoryDocument {
  return { format: DOCUMENT_FORMAT, version: DOCUMENT_VERSION, tasks: [] }
}

function parseDocument(value: unknown): ConversationHistoryDocument {
  if (!isExactRecord(value, ['format', 'version', 'tasks'])) {
    throw new ConversationHistoryError('corrupt_data')
  }
  if (
    value.format !== DOCUMENT_FORMAT ||
    value.version !== DOCUMENT_VERSION ||
    !Array.isArray(value.tasks) ||
    value.tasks.length > MAX_TASKS
  ) {
    throw new ConversationHistoryError('corrupt_data')
  }

  const tasks = value.tasks.map(parseStoredTask)
  const taskIds = new Set(tasks.map((task) => task.id))
  if (taskIds.size !== tasks.length) throw new ConversationHistoryError('corrupt_data')

  const messageIds = new Set<string>()
  let totalMessages = 0
  for (const task of tasks) {
    totalMessages += task.messages.length
    for (const message of task.messages) {
      if (messageIds.has(message.id)) throw new ConversationHistoryError('corrupt_data')
      messageIds.add(message.id)
    }
  }
  if (totalMessages > MAX_TOTAL_MESSAGES) throw new ConversationHistoryError('corrupt_data')

  return { format: DOCUMENT_FORMAT, version: DOCUMENT_VERSION, tasks }
}

function parseDocumentForLoad(value: unknown): {
  document: ConversationHistoryDocument
  requiresMigration: boolean
} {
  if (!isExactRecord(value, ['format', 'version', 'tasks']) || value.format !== DOCUMENT_FORMAT) {
    throw new ConversationHistoryError('corrupt_data')
  }
  if (value.version === DOCUMENT_VERSION) {
    return { document: parseDocument(value), requiresMigration: false }
  }
  if (
    value.version !== LEGACY_DOCUMENT_VERSION ||
    !Array.isArray(value.tasks) ||
    value.tasks.length > MAX_TASKS
  ) {
    throw new ConversationHistoryError('corrupt_data')
  }

  const tasks = value.tasks.map(parseLegacyStoredTask)
  const document = parseDocument({
    format: DOCUMENT_FORMAT,
    version: DOCUMENT_VERSION,
    tasks
  })
  return { document, requiresMigration: true }
}

function parseStoredTask(value: unknown): StoredConversationTask {
  if (
    !isExactRecord(value, [
      'id',
      'projectId',
      'title',
      'mode',
      'status',
      'createdAt',
      'updatedAt',
      'archivedAt',
      'messages'
    ]) ||
    !isTaskId(value.id) ||
    !isProjectId(value.projectId) ||
    !isSafeStoredTitle(value.title) ||
    !isWorkspaceMode(value.mode) ||
    !isTaskStatus(value.status) ||
    !isCanonicalTimestamp(value.createdAt) ||
    !isCanonicalTimestamp(value.updatedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt) ||
    (value.archivedAt !== null &&
      (!isCanonicalTimestamp(value.archivedAt) ||
        Date.parse(value.archivedAt) < Date.parse(value.createdAt))) ||
    !Array.isArray(value.messages) ||
    value.messages.length > MAX_MESSAGES_PER_TASK
  ) {
    throw new ConversationHistoryError('corrupt_data')
  }

  const messages = value.messages.map(parseStoredMessage)
  const taskUpdatedAt = value.updatedAt
  if (value.status !== deriveTaskStatus(messages)) {
    throw new ConversationHistoryError('corrupt_data')
  }
  if (messages.some((message) => Date.parse(message.updatedAt) > Date.parse(taskUpdatedAt))) {
    throw new ConversationHistoryError('corrupt_data')
  }
  if (value.archivedAt !== null && value.status === 'running') {
    throw new ConversationHistoryError('corrupt_data')
  }

  return {
    id: value.id,
    projectId: value.projectId,
    title: value.title,
    mode: value.mode,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    archivedAt: value.archivedAt,
    messages
  }
}

function parseLegacyStoredTask(value: unknown): StoredConversationTask {
  if (
    !isExactRecord(value, [
      'id',
      'projectId',
      'title',
      'mode',
      'status',
      'createdAt',
      'updatedAt',
      'messages'
    ])
  ) {
    throw new ConversationHistoryError('corrupt_data')
  }
  return parseStoredTask({ ...value, archivedAt: null })
}

function parseStoredMessage(value: unknown): ConversationMessageDto {
  if (
    !isExactRecord(value, ['id', 'role', 'content', 'status', 'createdAt', 'updatedAt']) ||
    !isMessageId(value.id) ||
    (value.role !== 'user' && value.role !== 'assistant') ||
    !isMessageStatus(value.status) ||
    !isValidMessageContent(value.content) ||
    redactSensitiveContent(value.content) !== value.content ||
    !isCanonicalTimestamp(value.createdAt) ||
    !isCanonicalTimestamp(value.updatedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt) ||
    (value.role === 'user' && value.status !== 'complete')
  ) {
    throw new ConversationHistoryError('corrupt_data')
  }

  return {
    id: value.id,
    role: value.role,
    content: value.content,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  }
}

function normalizeCreateInputSafely(input: ConversationTaskCreateInput): {
  projectId: string
  title: string
  mode: WorkspaceMode
} {
  try {
    if (
      !isExactRecord(input, ['projectId', 'mode']) &&
      !isExactRecord(input, ['projectId', 'title', 'mode'])
    ) {
      throw new ConversationHistoryError('invalid_input')
    }
    if (!isProjectId(input.projectId) || !isWorkspaceMode(input.mode)) {
      throw new ConversationHistoryError('invalid_input')
    }
    const title = input.title === undefined ? 'New conversation' : normalizeTitle(input.title)
    if (title === null) throw new ConversationHistoryError('invalid_input')
    return { projectId: input.projectId, title, mode: input.mode }
  } catch (error) {
    if (error instanceof ConversationHistoryError) throw error
    throw new ConversationHistoryError('invalid_input')
  }
}

function normalizeAppendInputSafely(input: ConversationMessageAppendInput): {
  taskId: string
  role: ConversationMessageDto['role']
  content: string
  status: ConversationMessageStatus
} {
  try {
    if (
      !isExactRecord(input, ['taskId', 'role', 'content']) &&
      !isExactRecord(input, ['taskId', 'role', 'content', 'status'])
    ) {
      throw new ConversationHistoryError('invalid_input')
    }
    assertTaskId(input.taskId)
    if (input.role !== 'user' && input.role !== 'assistant') {
      throw new ConversationHistoryError('invalid_input')
    }
    const content = normalizeMessageContent(input.content)
    if (content === null) throw new ConversationHistoryError('invalid_input')
    const status = input.status ?? 'complete'
    if (!isMessageStatus(status) || (input.role === 'user' && status !== 'complete')) {
      throw new ConversationHistoryError('invalid_input')
    }
    return { taskId: input.taskId, role: input.role, content, status }
  } catch (error) {
    if (error instanceof ConversationHistoryError) throw error
    throw new ConversationHistoryError('invalid_input')
  }
}

function normalizeStatusInputSafely(input: ConversationMessageStatusInput): ConversationMessageStatusInput {
  try {
    if (!isExactRecord(input, ['taskId', 'messageId', 'status'])) {
      throw new ConversationHistoryError('invalid_input')
    }
    assertTaskId(input.taskId)
    if (!isMessageId(input.messageId) || !isMessageStatus(input.status)) {
      throw new ConversationHistoryError('invalid_input')
    }
    return { taskId: input.taskId, messageId: input.messageId, status: input.status }
  } catch (error) {
    if (error instanceof ConversationHistoryError) throw error
    throw new ConversationHistoryError('invalid_input')
  }
}

function normalizeTitleSafely(value: string): string {
  try {
    const normalized = normalizeTitle(value)
    if (normalized === null) throw new ConversationHistoryError('invalid_input')
    return normalized
  } catch (error) {
    if (error instanceof ConversationHistoryError) throw error
    throw new ConversationHistoryError('invalid_input')
  }
}

function normalizeTitle(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    return null
  }
  const redacted = redactSensitiveContent(value).trim()
  if (redacted.length === 0 || redacted.length > MAX_TITLE_CHARACTERS) return null
  return redacted
}

function normalizeMessageContent(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_MESSAGE_BYTES ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    return null
  }
  const redacted = redactSensitiveContent(value)
  return Buffer.byteLength(redacted, 'utf8') <= MAX_MESSAGE_BYTES ? redacted : null
}

function isSafeStoredTitle(value: unknown): value is string {
  return typeof value === 'string' && normalizeTitle(value) === value
}

function isValidMessageContent(value: unknown): value is string {
  return typeof value === 'string' && normalizeMessageContent(value) === value
}

function deriveTaskStatus(messages: readonly ConversationMessageDto[]): TaskSummary['status'] {
  const latest = messages.at(-1)
  if (!latest) return 'idle'
  if (latest.status === 'streaming') return 'running'
  if (latest.status === 'failed') return 'failed'
  return 'idle'
}

function canTransitionMessageStatus(
  message: ConversationMessageDto,
  nextStatus: ConversationMessageStatus
): boolean {
  if (message.status === nextStatus) return true
  if (message.role === 'user') return false
  if (nextStatus === 'cancelled' && (message.status === 'complete' || message.status === 'failed')) {
    return true
  }
  return message.status === 'streaming' && ['complete', 'cancelled', 'failed'].includes(nextStatus)
}

function toTaskSummary(task: StoredConversationTask): TaskSummary {
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    mode: task.mode,
    updatedAt: task.updatedAt,
    archivedAt: task.archivedAt,
    status: task.status
  }
}

function toPublicMessage(message: ConversationMessageDto): ConversationMessageDto {
  return {
    id: message.id,
    role: message.role,
    content: redactSensitiveContent(message.content),
    status: message.status,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt
  }
}

function toMessageReceipt(
  taskId: string,
  message: ConversationMessageDto
): ConversationMessageReceipt {
  return {
    id: message.id,
    taskId,
    role: message.role,
    status: message.status,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt
  }
}

function findTask(
  document: ConversationHistoryDocument,
  taskId: string
): StoredConversationTask {
  const task = document.tasks.find((candidate) => candidate.id === taskId)
  if (!task) throw new ConversationHistoryError('not_found')
  return task
}

function createOpaqueId(prefix: 'task' | 'message', existingIds: readonly string[]): string {
  const existing = new Set(existingIds)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let id: string
    try {
      id = `${prefix}:${randomUUID()}`
    } catch {
      throw new ConversationHistoryError('storage_error')
    }
    if (!existing.has(id)) return id
  }
  throw new ConversationHistoryError('storage_error')
}

function nextTimestamp(document: ConversationHistoryDocument): string {
  let latest = 0
  for (const task of document.tasks) {
    latest = Math.max(latest, Date.parse(task.updatedAt))
    if (task.archivedAt !== null) latest = Math.max(latest, Date.parse(task.archivedAt))
  }
  try {
    return new Date(Math.max(Date.now(), latest + 1)).toISOString()
  } catch {
    throw new ConversationHistoryError('storage_error')
  }
}

function countMessages(document: ConversationHistoryDocument): number {
  return document.tasks.reduce((total, task) => total + task.messages.length, 0)
}

function assertTaskId(value: unknown): asserts value is string {
  if (!isTaskId(value)) throw new ConversationHistoryError('invalid_input')
}

function isTaskId(value: unknown): value is string {
  return typeof value === 'string' && TASK_ID_PATTERN.test(value)
}

function isMessageId(value: unknown): value is string {
  return typeof value === 'string' && MESSAGE_ID_PATTERN.test(value)
}

function isProjectId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 3 &&
    value.length <= MAX_PROJECT_ID_CHARACTERS &&
    /^[A-Za-z][A-Za-z0-9._:-]*$/.test(value) &&
    redactSensitiveContent(value) === value
  )
}

function isWorkspaceMode(value: unknown): value is WorkspaceMode {
  return value === 'chat' || value === 'agent'
}

function isMessageStatus(value: unknown): value is ConversationMessageStatus {
  return value === 'streaming' || value === 'complete' || value === 'cancelled' || value === 'failed'
}

function isTaskStatus(value: unknown): value is TaskSummary['status'] {
  return value === 'idle' || value === 'running' || value === 'waiting-approval' || value === 'failed'
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 40) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExactRecord(value: unknown, expectedKeys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const actualKeys = Object.keys(value)
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  )
}

function assertMainProcess(): void {
  const processWithType = process as NodeJS.Process & { type?: string }
  if (processWithType.type === 'renderer') {
    throw new ConversationHistoryError('invalid_configuration')
  }
}
