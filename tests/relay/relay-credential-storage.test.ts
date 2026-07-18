import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SecureStore } from '../../src/main/security/secure-store.ts'
import type { SecureStoreCipher } from '../../src/main/security/secure-store.ts'
import {
  RelayCredentialStorageError,
  SecureRelayCredentialStorage
} from '../../src/main/services/relay-credential-storage.ts'
import type {
  RelayCredentialStringStore
} from '../../src/main/services/relay-credential-storage.ts'
import type { RelayStoredCredential } from '../../src/main/services/relay-service.ts'

const XOR_MASK = 0x6d
const CIPHER_MARKER = 'relay-test-cipher-v1:'
const REFRESH_SECRET = 'desktop_rt_refresh_secret_for_storage'

function createTestCipher(available = true): SecureStoreCipher {
  return {
    isEncryptionAvailable: () => available,
    encryptString(value) {
      const bytes = Buffer.from(`${CIPHER_MARKER}${value}`, 'utf8')
      for (let index = 0; index < bytes.length; index += 1) bytes[index] ^= XOR_MASK
      return bytes
    },
    decryptString(value) {
      const bytes = Buffer.from(value)
      for (let index = 0; index < bytes.length; index += 1) bytes[index] ^= XOR_MASK
      const plaintext = bytes.toString('utf8')
      bytes.fill(0)
      if (!plaintext.startsWith(CIPHER_MARKER)) throw new Error('test decryption failed')
      return plaintext.slice(CIPHER_MARKER.length)
    }
  }
}

function credential(overrides: Partial<RelayStoredCredential> = {}): RelayStoredCredential {
  return {
    version: 1,
    server_origin: 'https://www.wzhxiaozhan.top',
    refresh_token: REFRESH_SECRET,
    device_id: 'desktop_device_123',
    refresh_expires_at: 1_802_592_000,
    updated_at: 1_800_000_000,
    ...overrides
  }
}

async function temporaryPath(): Promise<{ directory: string; filePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'ai-terminal-relay-credential-'))
  return { directory, filePath: join(directory, 'relay-device-credential.json') }
}

function assertStorageError(error: unknown, forbidden: readonly string[] = []): boolean {
  assert.ok(error instanceof RelayCredentialStorageError)
  const exposed = `${error.name}\n${error.message}\n${error.stack ?? ''}`
  for (const marker of forbidden) {
    assert.doesNotMatch(exposed, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  return true
}

test('relay credentials round-trip only through the purpose-bound encrypted SecureStore', async (context) => {
  const { directory, filePath } = await temporaryPath()
  context.after(() => rm(directory, { recursive: true, force: true }))
  const secureStore = new SecureStore({
    filePath,
    purpose: 'relay-device-credential',
    cipher: createTestCipher()
  })
  const storage = new SecureRelayCredentialStorage(secureStore)
  const value = credential()

  await storage.saveCredential(value)
  assert.deepEqual(await storage.loadCredential(), value)

  const persisted = await readFile(filePath, 'utf8')
  assert.equal((JSON.parse(persisted) as Record<string, unknown>).purpose, 'relay-device-credential')
  assert.doesNotMatch(persisted, new RegExp(REFRESH_SECRET))
  assert.doesNotMatch(persisted, /desktop_device_123|wzhxiaozhan\.top/)

  await storage.clearCredential()
  assert.equal(await storage.loadCredential(), null)
  const cleared = await readFile(filePath, 'utf8')
  assert.doesNotMatch(cleared, new RegExp(REFRESH_SECRET))
  assert.doesNotMatch(cleared, /desktop_device_123|wzhxiaozhan\.top/)
})

test('clear writes one encrypted-store tombstone through the same atomic write boundary', async () => {
  const writes: string[] = []
  const stringStore: RelayCredentialStringStore = {
    async read() {
      return writes.at(-1) ?? null
    },
    async write(value) {
      writes.push(value)
    }
  }
  const storage = new SecureRelayCredentialStorage(stringStore)

  await storage.saveCredential(credential())
  await storage.clearCredential()

  assert.equal(writes.length, 2)
  assert.deepEqual(JSON.parse(writes[1] ?? ''), {
    format: 'ai-terminal.relay-credential',
    version: 1,
    credential: null
  })
  assert.equal(await storage.loadCredential(), null)
})

test('credential documents use an exact schema and reject malformed or noncanonical values', async () => {
  const invalidCredentials: unknown[] = [
    { ...credential(), access_token: 'desktop_at_must_not_be_accepted' },
    { ...credential(), server_origin: 'https://www.wzhxiaozhan.top/' },
    { ...credential(), server_origin: 'http://www.wzhxiaozhan.top' },
    { ...credential(), refresh_token: 'unsafe\r\nheader' },
    { ...credential(), device_id: '../private-device' },
    { ...credential(), updated_at: 1_900_000_000 }
  ]

  for (const invalid of invalidCredentials) {
    const serialized = JSON.stringify({
      format: 'ai-terminal.relay-credential',
      version: 1,
      credential: invalid
    })
    const storage = new SecureRelayCredentialStorage({
      async read() { return serialized },
      async write() { throw new Error('write must not be called') }
    })
    await assert.rejects(
      storage.loadCredential(),
      (error: unknown) => assertStorageError(error, ['desktop_at_must_not_be_accepted', 'unsafe'])
    )
  }

  const unknownDocumentField = JSON.stringify({
    format: 'ai-terminal.relay-credential',
    version: 1,
    credential: credential(),
    debug: REFRESH_SECRET
  })
  const storage = new SecureRelayCredentialStorage({
    async read() { return unknownDocumentField },
    async write() { throw new Error('write must not be called') }
  })
  await assert.rejects(
    storage.loadCredential(),
    (error: unknown) => assertStorageError(error, [REFRESH_SECRET])
  )
})

test('unavailable DPAPI fails closed and never releases a legacy plaintext credential', async (context) => {
  const { directory, filePath } = await temporaryPath()
  context.after(() => rm(directory, { recursive: true, force: true }))
  const secureStore = new SecureStore({
    filePath,
    purpose: 'relay-device-credential',
    cipher: createTestCipher(false)
  })
  const storage = new SecureRelayCredentialStorage(secureStore)

  await assert.rejects(
    storage.saveCredential(credential()),
    (error: unknown) => assertStorageError(error, [REFRESH_SECRET, filePath])
  )

  const legacyPlaintext = JSON.stringify({
    format: 'ai-terminal.relay-credential',
    version: 1,
    credential: credential()
  })
  await writeFile(filePath, legacyPlaintext, 'utf8')
  await assert.rejects(
    storage.loadCredential(),
    (error: unknown) => assertStorageError(error, [REFRESH_SECRET, filePath])
  )
  assert.equal(await readFile(filePath, 'utf8'), legacyPlaintext)
})

test('underlying read and write failures are replaced with fixed credential-free errors', async () => {
  const leakingStore: RelayCredentialStringStore = {
    async read() {
      throw new Error(`read failed with ${REFRESH_SECRET}`)
    },
    async write() {
      throw new Error(`write failed with ${REFRESH_SECRET}`)
    }
  }
  const storage = new SecureRelayCredentialStorage(leakingStore)

  await assert.rejects(
    storage.loadCredential(),
    (error: unknown) => assertStorageError(error, [REFRESH_SECRET])
  )
  await assert.rejects(
    storage.saveCredential(credential()),
    (error: unknown) => assertStorageError(error, [REFRESH_SECRET])
  )
  await assert.rejects(
    storage.clearCredential(),
    (error: unknown) => assertStorageError(error, [REFRESH_SECRET])
  )
})
