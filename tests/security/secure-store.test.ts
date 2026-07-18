import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  SecureStore,
  SecureStoreError,
  type SecureStoreCipher
} from '../../src/main/security/secure-store.ts'

const XOR_MASK = 0xa7
const CIPHER_MARKER = 'test-cipher-v1:'

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

async function createTemporaryStorePath(): Promise<{ directory: string; filePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'ai-terminal-secure-store-'))
  return { directory, filePath: join(directory, 'private-data.json') }
}

test('secure store round-trips text through a versioned purpose-bound envelope', async (context) => {
  const { directory, filePath } = await createTemporaryStorePath()
  context.after(() => rm(directory, { recursive: true, force: true }))
  const secret = 'sk-test-secure-store-fixture'
  const store = new SecureStore({ filePath, purpose: 'api-credentials', cipher: createTestCipher() })

  await store.write(secret)

  assert.equal(await store.read(), secret)
  const persisted = await readFile(filePath, 'utf8')
  const envelope = JSON.parse(persisted) as Record<string, unknown>
  assert.equal(envelope.format, 'ai-terminal.secure-store')
  assert.equal(envelope.version, 1)
  assert.equal(envelope.purpose, 'api-credentials')
  assert.doesNotMatch(persisted, new RegExp(secret))
})

test('corrupt envelopes and purpose mismatches fail closed', async (context) => {
  const { directory, filePath } = await createTemporaryStorePath()
  context.after(() => rm(directory, { recursive: true, force: true }))
  const cipher = createTestCipher()

  await writeFile(
    filePath,
    JSON.stringify({
      format: 'ai-terminal.secure-store',
      version: 1,
      purpose: 'api-credentials',
      ciphertext: '%%%invalid%%%'
    }),
    'utf8'
  )
  const corruptStore = new SecureStore({ filePath, purpose: 'api-credentials', cipher })
  await assert.rejects(corruptStore.read(), hasErrorCode('corrupt_data'))

  const sourceStore = new SecureStore({ filePath, purpose: 'api-credentials', cipher })
  await sourceStore.write('purpose-bound-value')
  const otherStore = new SecureStore({ filePath, purpose: 'conversation-history', cipher })
  await assert.rejects(otherStore.read(), hasErrorCode('purpose_mismatch'))
})

test('unavailable encryption blocks new writes and legacy reads', async (context) => {
  const { directory, filePath } = await createTemporaryStorePath()
  context.after(() => rm(directory, { recursive: true, force: true }))
  const legacySecret = 'legacy-plaintext-must-remain-unreleased'
  const store = new SecureStore({
    filePath,
    purpose: 'api-credentials',
    cipher: createTestCipher(false)
  })

  await assert.rejects(store.write('new-secret'), hasErrorCode('encryption_unavailable'))
  await writeFile(filePath, legacySecret, 'utf8')
  await assert.rejects(store.read(), hasErrorCode('encryption_unavailable'))
  assert.equal(await readFile(filePath, 'utf8'), legacySecret)
})

test('legacy plaintext is returned only after an encrypted in-place migration', async (context) => {
  const { directory, filePath } = await createTemporaryStorePath()
  context.after(() => rm(directory, { recursive: true, force: true }))
  const legacySecret = 'sk-test-secure-store-fixture'
  await writeFile(filePath, legacySecret, 'utf8')
  const store = new SecureStore({ filePath, purpose: 'api-credentials', cipher: createTestCipher() })

  assert.equal(await store.read(), legacySecret)

  const migrated = await readFile(filePath, 'utf8')
  assert.doesNotMatch(migrated, new RegExp(legacySecret))
  assert.equal((JSON.parse(migrated) as Record<string, unknown>).format, 'ai-terminal.secure-store')
  assert.equal(await store.read(), legacySecret)
})

test('failed atomic replacement leaves the previous encrypted file intact', async (context) => {
  const { directory, filePath } = await createTemporaryStorePath()
  context.after(() => rm(directory, { recursive: true, force: true }))
  const cipher = createTestCipher()
  const originalStore = new SecureStore({ filePath, purpose: 'api-credentials', cipher })
  await originalStore.write('old-secret')
  const before = await readFile(filePath)

  const failingStore = new SecureStore({
    filePath,
    purpose: 'api-credentials',
    cipher,
    io: {
      rename: async () => {
        throw new Error(`rename failed for ${filePath} with new-secret`)
      }
    }
  })

  await assert.rejects(failingStore.write('new-secret'), hasErrorCode('write_failed'))
  assert.deepEqual(await readFile(filePath), before)
  assert.equal(await originalStore.read(), 'old-secret')
  assert.deepEqual(await readdir(directory), ['private-data.json'])
})

test('cipher and filesystem failures do not expose values or absolute paths', async (context) => {
  const { directory, filePath } = await createTemporaryStorePath()
  context.after(() => rm(directory, { recursive: true, force: true }))
  const secret = 'sk-test-secure-store-fixture'
  const leakingCipher: SecureStoreCipher = {
    isEncryptionAvailable: () => true,
    encryptString: () => {
      throw new Error(`provider failed for ${secret} at ${filePath}`)
    },
    decryptString: () => {
      throw new Error(`provider failed for ${secret} at ${filePath}`)
    }
  }
  const store = new SecureStore({ filePath, purpose: 'api-credentials', cipher: leakingCipher })

  await assert.rejects(store.write(secret), (error: unknown) => {
    assert(error instanceof SecureStoreError)
    const exposed = `${String(error)}\n${error.stack ?? ''}`
    assert.doesNotMatch(exposed, new RegExp(secret))
    assert.doesNotMatch(exposed, new RegExp(escapeForRegExp(filePath)))
    return true
  })
})

function hasErrorCode(code: SecureStoreError['code']): (error: unknown) => boolean {
  return (error: unknown) => {
    assert(error instanceof SecureStoreError)
    assert.equal(error.code, code)
    return true
  }
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
