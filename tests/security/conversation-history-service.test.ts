import assert from 'node:assert/strict'
import {
  mkdtemp,
  open as openFile,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { redactSensitiveContent, redactSensitiveText } from '../../src/main/security/redaction.ts'
import {
  SecureStore,
  type SecureStoreCipher,
  type SecureStoreIo
} from '../../src/main/security/secure-store.ts'
import {
  ConversationHistoryError,
  ConversationHistoryService,
  type ConversationHistoryStorage,
  type ConversationMessageAppendInput
} from '../../src/main/services/conversation-history-service.ts'

class MemoryHistoryStorage implements ConversationHistoryStorage {
  value: string | null = null
  readonly writes: string[] = []

  async read(): Promise<string | null> {
    return this.value
  }

  async write(serializedDocument: string): Promise<void> {
    this.writes.push(serializedDocument)
    this.value = serializedDocument
  }
}

const MIGRATION_XOR_MASK = 0x6d
const MIGRATION_CIPHER_MARKER = 'conversation-history-test-v1:'
const LEGACY_TASK_ID = 'task:6c7a92de-3ea1-4ba9-a00f-b406d820c19f'
const LEGACY_MESSAGE_ID = 'message:b461d315-1714-426f-88e0-d57f5595b867'
const LEGACY_PRIVATE_CONTENT = 'Private legacy conversation that must be released only after migration.'

function createMigrationCipher(): SecureStoreCipher {
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const bytes = Buffer.from(`${MIGRATION_CIPHER_MARKER}${value}`, 'utf8')
      for (let index = 0; index < bytes.length; index += 1) bytes[index] ^= MIGRATION_XOR_MASK
      return bytes
    },
    decryptString(value) {
      const bytes = Buffer.from(value)
      for (let index = 0; index < bytes.length; index += 1) bytes[index] ^= MIGRATION_XOR_MASK
      const plaintext = bytes.toString('utf8')
      bytes.fill(0)
      if (!plaintext.startsWith(MIGRATION_CIPHER_MARKER)) {
        throw new Error('test decryption failed')
      }
      return plaintext.slice(MIGRATION_CIPHER_MARKER.length)
    }
  }
}

function createLegacyConversationDocument(): string {
  const timestamp = '2026-01-02T03:04:05.000Z'
  return JSON.stringify({
    format: 'ai-terminal.conversation-history',
    version: 1,
    tasks: [
      {
        id: LEGACY_TASK_ID,
        projectId: 'project:legacy',
        title: 'Legacy conversation',
        mode: 'chat',
        status: 'idle',
        createdAt: timestamp,
        updatedAt: timestamp,
        messages: [
          {
            id: LEGACY_MESSAGE_ID,
            role: 'user',
            content: LEGACY_PRIVATE_CONTENT,
            status: 'complete',
            createdAt: timestamp,
            updatedAt: timestamp
          }
        ]
      }
    ]
  })
}

async function createTemporaryHistoryPath(): Promise<{ directory: string; filePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'ai-terminal-history-migration-'))
  return { directory, filePath: join(directory, 'conversation-history.json') }
}

test('task CRUD keeps content private until explicit load and redacts credentials and paths', async () => {
  const storage = new MemoryHistoryStorage()
  const service = new ConversationHistoryService(storage)
  const task = await service.create({
    projectId: 'project:main',
    title: 'Review D:\\private\\workspace\\settings.json',
    mode: 'agent'
  })
  assert.match(task.id, /^task:[0-9a-f-]{36}$/)
  assert.doesNotMatch(task.title, /D:\\private/i)
  assert.match(task.title, /<local-path>/)

  const privateConversation =
    'Keep this design note private. Authorization: Bearer secretTokenValue D:\\private\\workspace\\app.ts'
  const receipt = await service.appendMessage({
    taskId: task.id,
    role: 'user',
    content: privateConversation
  })
  assert.deepEqual(Object.keys(receipt).sort(), [
    'createdAt',
    'id',
    'role',
    'status',
    'taskId',
    'updatedAt'
  ])
  assert.doesNotMatch(JSON.stringify(receipt), /design note|secretTokenValue|D:\\private/i)

  const listed = await service.list()
  assert.equal(listed.length, 1)
  assert.doesNotMatch(JSON.stringify(listed), /design note|secretTokenValue|D:\\private/i)
  assert.match(storage.value ?? '', /Keep this design note private/)
  assert.doesNotMatch(storage.value ?? '', /secretTokenValue|D:\\private/i)

  const loaded = await service.load(task.id)
  assert.equal(loaded.events.length, 0)
  assert.equal(loaded.messages.length, 1)
  assert.match(loaded.messages[0]?.content ?? '', /Keep this design note private/)
  assert.match(loaded.messages[0]?.content ?? '', /Authorization: (?:Bearer )?<redacted>/)
  assert.match(loaded.messages[0]?.content ?? '', /<local-path>/)
  assert.doesNotMatch(JSON.stringify(loaded), /secretTokenValue|D:\\private/i)

  const renamed = await service.rename(task.id, 'Renamed conversation')
  assert.equal(renamed.title, 'Renamed conversation')
  await service.delete(task.id)
  assert.deepEqual(await service.list(), [])
  await assert.rejects(service.load(task.id), hasErrorCode('not_found'))
})

test('Chat and Agent tasks archive idempotently and archived tasks remain read-only', async () => {
  const storage = new MemoryHistoryStorage()
  const service = new ConversationHistoryService(storage)
  const chatTask = await service.create({ projectId: 'project:main', mode: 'chat' })
  const agentTask = await service.create({ projectId: 'project:agent', mode: 'agent' })
  await service.appendMessage({
    taskId: chatTask.id,
    role: 'user',
    content: 'Conversation content remains available after archiving.'
  })

  const archivedChat = await service.setArchived(chatTask.id, true)
  assert.notEqual(archivedChat.archivedAt, null)
  assert.equal(new Date(archivedChat.archivedAt!).toISOString(), archivedChat.archivedAt)
  const writesAfterArchive = storage.writes.length
  assert.deepEqual(await service.setArchived(chatTask.id, true), archivedChat)
  assert.equal(storage.writes.length, writesAfterArchive)
  assert.equal((await service.list()).find((task) => task.id === chatTask.id)?.archivedAt, archivedChat.archivedAt)
  assert.equal((await service.load(chatTask.id)).messages[0]?.content, 'Conversation content remains available after archiving.')
  await assert.rejects(
    service.appendMessage({ taskId: chatTask.id, role: 'user', content: 'Must not append.' }),
    hasErrorCode('conflict')
  )

  const renamedArchived = await service.rename(chatTask.id, 'Archived conversation')
  assert.equal(renamedArchived.archivedAt, archivedChat.archivedAt)
  assert.equal(renamedArchived.title, 'Archived conversation')

  const runningMessage = await service.appendMessage({
    taskId: agentTask.id,
    role: 'assistant',
    content: 'Agent turn is still running.',
    status: 'streaming'
  })
  await assert.rejects(service.setArchived(agentTask.id, true), hasErrorCode('conflict'))
  await service.updateMessageStatus({
    taskId: agentTask.id,
    messageId: runningMessage.id,
    status: 'complete'
  })
  assert.notEqual((await service.setArchived(agentTask.id, true)).archivedAt, null)
  await service.delete(agentTask.id)
  await assert.rejects(service.load(agentTask.id), hasErrorCode('not_found'))

  const restored = await service.setArchived(chatTask.id, false)
  assert.equal(restored.archivedAt, null)
  const writesAfterRestore = storage.writes.length
  assert.deepEqual(await service.setArchived(chatTask.id, false), restored)
  assert.equal(storage.writes.length, writesAfterRestore)
  await service.appendMessage({ taskId: chatTask.id, role: 'user', content: 'Restored.' })
  assert.equal((await service.load(chatTask.id)).messages.at(-1)?.content, 'Restored.')

  await assert.rejects(
    service.setArchived(chatTask.id, 'yes' as unknown as boolean),
    hasErrorCode('invalid_input')
  )
})

test('v1 schema migration is durable before history is returned and writes only v2', async () => {
  const storage = new MemoryHistoryStorage()
  storage.value = createLegacyConversationDocument()
  const service = new ConversationHistoryService(storage)

  const loaded = await service.load(LEGACY_TASK_ID)
  assert.equal(loaded.messages[0]?.content, LEGACY_PRIVATE_CONTENT)
  assert.equal(loaded.task.archivedAt, null)
  assert.equal(storage.writes.length, 1)
  const migrated = JSON.parse(storage.value!) as {
    version: number
    tasks: Array<{ archivedAt: string | null }>
  }
  assert.equal(migrated.version, 2)
  assert.equal(migrated.tasks[0]?.archivedAt, null)

  const restarted = new ConversationHistoryService(storage)
  assert.equal((await restarted.load(LEGACY_TASK_ID)).messages[0]?.content, LEGACY_PRIVATE_CONTENT)
  assert.equal(storage.writes.length, 1)
})

test('v1 schema migration failures do not release history or expose storage details', async () => {
  const legacyDocument = createLegacyConversationDocument()
  const privatePath = 'D:\\private\\conversation-history.json'
  const injectedSecret = 'schema-migration-private-value'
  const storage: ConversationHistoryStorage = {
    read: async () => legacyDocument,
    write: async () => {
      throw new Error(`${injectedSecret} ${privatePath}`)
    }
  }
  const service = new ConversationHistoryService(storage)
  let historyReleased = false

  try {
    const loaded = await service.load(LEGACY_TASK_ID)
    historyReleased = loaded.messages.some((message) => message.content === LEGACY_PRIVATE_CONTENT)
    assert.fail('schema migration unexpectedly succeeded')
  } catch (error) {
    assert(error instanceof ConversationHistoryError)
    assert.equal(error.code, 'storage_error')
    const exposed = `${String(error)}\n${error.stack ?? ''}`
    assert.doesNotMatch(exposed, new RegExp(escapeForRegExp(LEGACY_PRIVATE_CONTENT)))
    assert.doesNotMatch(exposed, new RegExp(escapeForRegExp(injectedSecret)))
    assert.doesNotMatch(exposed, new RegExp(escapeForRegExp(privatePath)))
  }
  assert.equal(historyReleased, false)
})

test('a real legacy history document is returned only after migration to a secure envelope', async (context) => {
  const { directory, filePath } = await createTemporaryHistoryPath()
  context.after(() => rm(directory, { recursive: true, force: true }))
  const legacyDocument = createLegacyConversationDocument()
  const cipher = createMigrationCipher()
  await writeFile(filePath, legacyDocument, 'utf8')

  const service = new ConversationHistoryService(
    new SecureStore({ filePath, purpose: 'conversation-history', cipher })
  )
  const loaded = await service.load(LEGACY_TASK_ID)
  assert.equal(loaded.messages[0]?.content, LEGACY_PRIVATE_CONTENT)

  const persisted = await readFile(filePath, 'utf8')
  assert.doesNotMatch(persisted, new RegExp(escapeForRegExp(LEGACY_PRIVATE_CONTENT)))
  const envelope = JSON.parse(persisted) as Record<string, unknown>
  assert.deepEqual(Object.keys(envelope).sort(), ['ciphertext', 'format', 'purpose', 'version'])
  assert.equal(envelope.format, 'ai-terminal.secure-store')
  assert.equal(envelope.version, 1)
  assert.equal(envelope.purpose, 'conversation-history')

  const migratedDocumentText = await new SecureStore({
    filePath,
    purpose: 'conversation-history',
    cipher
  }).read()
  assert.notEqual(migratedDocumentText, null)
  const migratedDocument = JSON.parse(migratedDocumentText!) as {
    version: number
    tasks: Array<{ archivedAt: string | null }>
  }
  assert.equal(migratedDocument.version, 2)
  assert.equal(migratedDocument.tasks[0]?.archivedAt, null)

  const restartedService = new ConversationHistoryService(
    new SecureStore({ filePath, purpose: 'conversation-history', cipher })
  )
  assert.equal(
    (await restartedService.load(LEGACY_TASK_ID)).messages[0]?.content,
    LEGACY_PRIVATE_CONTENT
  )
})

test('legacy history migration failures never release plaintext or damage the source file', async () => {
  const legacyDocument = createLegacyConversationDocument()
  const injectedSecret = 'migration-provider-private-value'
  const stages = ['write', 'sync', 'rename'] as const

  for (const stage of stages) {
    const { directory, filePath } = await createTemporaryHistoryPath()
    try {
      await writeFile(filePath, legacyDocument, 'utf8')
      const io = createFailingMigrationIo(stage, filePath, injectedSecret)
      const service = new ConversationHistoryService(
        new SecureStore({
          filePath,
          purpose: 'conversation-history',
          cipher: createMigrationCipher(),
          io
        })
      )

      let plaintextReleased = false
      try {
        const loaded = await service.load(LEGACY_TASK_ID)
        plaintextReleased = loaded.messages.some(
          (message) => message.content === LEGACY_PRIVATE_CONTENT
        )
        assert.fail(`migration ${stage} unexpectedly succeeded`)
      } catch (error) {
        assert(error instanceof ConversationHistoryError)
        assert.equal(error.code, 'storage_error')
        const exposed = `${String(error)}\n${error.stack ?? ''}`
        assert.doesNotMatch(exposed, new RegExp(escapeForRegExp(LEGACY_PRIVATE_CONTENT)))
        assert.doesNotMatch(exposed, new RegExp(escapeForRegExp(injectedSecret)))
        assert.doesNotMatch(exposed, new RegExp(escapeForRegExp(filePath)))
      }
      assert.equal(plaintextReleased, false)
      assert.equal(await readFile(filePath, 'utf8'), legacyDocument)
      assert.deepEqual(await readdir(directory), ['conversation-history.json'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
})

test('long normal conversation content is not truncated by shared content redaction', async () => {
  const longContent = `Long response: ${'a'.repeat(5_000)}`
  assert.equal(redactSensitiveContent(longContent), longContent)
  assert.ok(redactSensitiveText(longContent).length < longContent.length)

  const service = new ConversationHistoryService(new MemoryHistoryStorage())
  const task = await service.create({ projectId: 'project:main', mode: 'chat' })
  await service.appendMessage({ taskId: task.id, role: 'assistant', content: longContent })
  assert.equal((await service.load(task.id)).messages[0]?.content, longContent)
})

test('message status transitions update task state without returning content', async () => {
  const service = new ConversationHistoryService(new MemoryHistoryStorage())
  const task = await service.create({ projectId: 'project:main', mode: 'agent' })
  const streaming = await service.appendMessage({
    taskId: task.id,
    role: 'assistant',
    content: 'Partial response',
    status: 'streaming'
  })
  assert.equal((await service.list())[0]?.status, 'running')

  const completed = await service.updateMessageStatus({
    taskId: task.id,
    messageId: streaming.id,
    status: 'complete'
  })
  assert.equal(completed.status, 'complete')
  assert.equal((await service.list())[0]?.status, 'idle')

  await assert.rejects(
    service.updateMessageStatus({
      taskId: task.id,
      messageId: streaming.id,
      status: 'failed'
    }),
    hasErrorCode('conflict')
  )
  const cancelled = await service.updateMessageStatus({
    taskId: task.id,
    messageId: streaming.id,
    status: 'cancelled'
  })
  assert.equal(cancelled.status, 'cancelled')
  await assert.rejects(
    service.updateMessageStatus({
      taskId: task.id,
      messageId: streaming.id,
      status: 'complete'
    }),
    hasErrorCode('conflict')
  )
  await assert.rejects(
    service.appendMessage({
      taskId: task.id,
      role: 'user',
      content: 'User messages are complete immediately',
      status: 'cancelled'
    }),
    hasErrorCode('invalid_input')
  )
})

test('a user-only task remains idle after service restart', async () => {
  const storage = new MemoryHistoryStorage()
  const firstService = new ConversationHistoryService(storage)
  const task = await firstService.create({ projectId: 'project:main', mode: 'chat' })
  await firstService.appendMessage({
    taskId: task.id,
    role: 'user',
    content: 'Persist this prompt before the runtime starts.'
  })
  assert.equal((await firstService.list())[0]?.status, 'idle')

  const restartedService = new ConversationHistoryService(storage)
  assert.equal((await restartedService.list())[0]?.status, 'idle')
  assert.equal((await restartedService.load(task.id)).messages[0]?.status, 'complete')
})

test('concurrent appends are serialized without dropping messages', async () => {
  const storage = new MemoryHistoryStorage()
  const service = new ConversationHistoryService(storage)
  const task = await service.create({ projectId: 'project:main', mode: 'chat' })
  const inputs: ConversationMessageAppendInput[] = Array.from({ length: 30 }, (_, index) => ({
    taskId: task.id,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `Concurrent message ${index}`
  }))

  const receipts = await Promise.all(inputs.map((input) => service.appendMessage(input)))
  const loaded = await service.load(task.id)
  assert.equal(loaded.messages.length, inputs.length)
  assert.equal(new Set(receipts.map((receipt) => receipt.id)).size, inputs.length)
  assert.deepEqual(
    loaded.messages.map((message) => message.content),
    inputs.map((input) => input.content)
  )
  assert.equal(storage.writes.length, inputs.length + 1)
})

test('unknown, malformed, unsafe and inconsistent stored documents fail closed', async () => {
  const storage = new MemoryHistoryStorage()
  const service = new ConversationHistoryService(storage)
  const task = await service.create({ projectId: 'project:main', mode: 'chat' })
  await service.appendMessage({ taskId: task.id, role: 'user', content: 'Safe content' })
  const validDocument = storage.value!

  const documents: string[] = [
    '{not-json',
    JSON.stringify({ format: 'ai-terminal.conversation-history', version: 3, tasks: [] }),
    JSON.stringify({
      format: 'ai-terminal.conversation-history',
      version: 1,
      tasks: [],
      workspacePath: 'D:\\private\\workspace'
    })
  ]

  const unsafe = JSON.parse(validDocument) as {
    tasks: Array<{ messages: Array<{ content: string }> }>
  }
  unsafe.tasks[0]!.messages[0]!.content = 'Bearer rawCredentialValue D:\\private\\workspace\\file.txt'
  documents.push(JSON.stringify(unsafe))

  const inconsistent = JSON.parse(validDocument) as {
    tasks: Array<{ status: string }>
  }
  inconsistent.tasks[0]!.status = 'running'
  documents.push(JSON.stringify(inconsistent))

  const invalidArchive = JSON.parse(validDocument) as {
    tasks: Array<{ archivedAt: string | null }>
  }
  invalidArchive.tasks[0]!.archivedAt = 'not-a-timestamp'
  documents.push(JSON.stringify(invalidArchive))

  for (const document of documents) {
    storage.value = document
    await assert.rejects(service.list(), hasErrorCode('corrupt_data'))
  }
})

test('message, title and encrypted-document bounds are enforced', async () => {
  const storage = new MemoryHistoryStorage()
  const service = new ConversationHistoryService(storage)
  await assert.rejects(
    service.create({ projectId: 'project:main', title: 'x'.repeat(201), mode: 'chat' }),
    hasErrorCode('invalid_input')
  )

  const task = await service.create({ projectId: 'project:main', mode: 'chat' })
  await assert.rejects(
    service.appendMessage({
      taskId: task.id,
      role: 'user',
      content: 'x'.repeat(256 * 1024 + 1)
    }),
    hasErrorCode('invalid_input')
  )

  storage.value = 'x'.repeat(4 * 1024 * 1024 + 1)
  await assert.rejects(service.list(), hasErrorCode('corrupt_data'))
})

test('unknown input fields and storage failures never expose text, keys or paths', async () => {
  const privateText = 'private-conversation-body'
  const secret = 'sk-storage-provider-secret'
  const absolutePath = 'D:\\private\\history.json'
  const storage: ConversationHistoryStorage = {
    read: async () => null,
    write: async () => {
      throw new Error(`${privateText} ${secret} ${absolutePath}`)
    }
  }
  const service = new ConversationHistoryService(storage)

  await assert.rejects(
    service.create({ projectId: 'project:main', mode: 'chat' }),
    (error: unknown) => {
      assert(error instanceof ConversationHistoryError)
      const exposed = `${String(error)}\n${error.stack ?? ''}`
      assert.doesNotMatch(exposed, /private-conversation-body|sk-storage-provider-secret|D:\\private/)
      return true
    }
  )

  const workingService = new ConversationHistoryService(new MemoryHistoryStorage())
  const task = await workingService.create({ projectId: 'project:main', mode: 'chat' })
  await assert.rejects(
    workingService.appendMessage({
      taskId: task.id,
      role: 'user',
      content: privateText,
      workspacePath: absolutePath
    } as unknown as ConversationMessageAppendInput),
    hasErrorCode('invalid_input')
  )
})

function hasErrorCode(code: ConversationHistoryError['code']): (error: unknown) => boolean {
  return (error: unknown) => {
    assert(error instanceof ConversationHistoryError)
    assert.equal(error.code, code)
    return true
  }
}

function createFailingMigrationIo(
  stage: 'write' | 'sync' | 'rename',
  privatePath: string,
  privateText: string
): Partial<SecureStoreIo> {
  const failure = (): Error => new Error(`${stage} failed for ${privateText} at ${privatePath}`)
  if (stage === 'rename') {
    return {
      rename: async () => {
        throw failure()
      }
    }
  }

  return {
    open: async (temporaryPath, flags, mode) => {
      const handle = await openFile(temporaryPath, flags, mode)
      return {
        async writeFile(data, options) {
          if (stage === 'write') {
            await handle.writeFile(data.slice(0, 12), options)
            throw failure()
          }
          await handle.writeFile(data, options)
        },
        async sync() {
          if (stage === 'sync') throw failure()
          await handle.sync()
        },
        async close() {
          await handle.close()
        }
      }
    }
  }
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
