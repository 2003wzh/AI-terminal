import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AccessProfileService,
  AccessProfileServiceError,
  type AccessProfileStorage
} from '../../src/main/services/access-profile-service.ts'
import type { SaveProfileInput } from '../../src/shared/contracts.ts'

class MemorySecureStorage implements AccessProfileStorage {
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

function profileInput(overrides: Partial<SaveProfileInput> = {}): SaveProfileInput {
  return {
    name: 'Primary endpoint',
    description: 'Main model access',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-private-profile-key',
    targets: ['codex'],
    ...overrides
  }
}

test('persists one strict versioned document and returns only public DTO fields', async () => {
  const storage = new MemorySecureStorage()
  const service = new AccessProfileService(storage)
  const created = await service.save(profileInput())

  assert.deepEqual(Object.keys(created).sort(), [
    'baseUrl',
    'credentialHandle',
    'description',
    'hasKey',
    'isCurrent',
    'name',
    'targets'
  ])
  assert.equal(created.hasKey, true)
  assert.equal(created.isCurrent, true)
  assert.doesNotMatch(JSON.stringify(created), /sk-private-profile-key|apiKey/)

  assert.equal(storage.writes.length, 1)
  const stored = JSON.parse(storage.writes[0]!) as Record<string, unknown>
  assert.deepEqual(Object.keys(stored).sort(), [
    'currentCredentialHandle',
    'format',
    'profiles',
    'version'
  ])
  assert.equal(stored.format, 'ai-terminal.access-profiles')
  assert.equal(stored.version, 1)

  const listed = await service.listPublic()
  assert.deepEqual(listed, [created])
  assert.doesNotMatch(JSON.stringify(listed), /sk-private-profile-key|apiKey/)

  const secret = await service.getSecretForMain(created.credentialHandle)
  assert.deepEqual(secret, {
    credentialHandle: created.credentialHandle,
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-private-profile-key'
  })
})

test('updates preserve an existing key when apiKey is omitted', async () => {
  const storage = new MemorySecureStorage()
  const service = new AccessProfileService(storage)
  const created = await service.save(profileInput())

  const updated = await service.save({
    credentialHandle: created.credentialHandle,
    name: 'Renamed endpoint',
    baseUrl: 'https://api.example.com/v2',
    targets: ['codex', 'claude-code']
  })

  assert.equal(updated.name, 'Renamed endpoint')
  assert.equal(updated.description, '')
  assert.equal(updated.hasKey, true)
  assert.equal((await service.getSecretForMain(created.credentialHandle)).apiKey, 'sk-private-profile-key')
})

test('accepts HTTPS and exact loopback HTTP while rejecting unsafe endpoint forms', async () => {
  const accepted = [
    'https://api.example.com/v1',
    'http://localhost:11434/v1',
    'http://127.0.0.1:8080/v1',
    'http://[::1]:3000/v1'
  ]
  for (const [index, baseUrl] of accepted.entries()) {
    const service = new AccessProfileService(new MemorySecureStorage())
    const result = await service.save(profileInput({ name: `Accepted ${index}`, baseUrl }))
    assert.equal(result.baseUrl, baseUrl)
  }

  const rejected = [
    'http://api.example.com/v1',
    'http://localhost.evil.example/v1',
    'http://2130706433/v1',
    'https://user:password@api.example.com/v1',
    'https://api.example.com/v1?token=private',
    'https://api.example.com/v1#fragment',
    ' https://api.example.com/v1',
    'HTTPS://api.example.com/v1',
    'https:\\api.example.com\\v1'
  ]
  for (const baseUrl of rejected) {
    const storage = new MemorySecureStorage()
    const service = new AccessProfileService(storage)
    await assert.rejects(service.save(profileInput({ baseUrl })), hasErrorCode('invalid_input'))
    assert.equal(storage.writes.length, 0)
  }
})

test('creates opaque random handles and rejects caller-selected unknown handles', async () => {
  const service = new AccessProfileService(new MemorySecureStorage())
  const first = await service.save(profileInput({ name: 'First' }))
  const second = await service.save(
    profileInput({ name: 'Second', baseUrl: 'https://second.example.com/v1' })
  )

  assert.match(
    first.credentialHandle,
    /^profile:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  )
  assert.notEqual(first.credentialHandle, second.credentialHandle)
  assert.doesNotMatch(first.credentialHandle, /First|example/i)

  await assert.rejects(
    service.save(profileInput({ credentialHandle: 'profile:00000000-0000-4000-8000-000000000000' })),
    hasErrorCode('not_found')
  )
})

test('setCurrent and delete keep endpoint selection explicit', async () => {
  const service = new AccessProfileService(new MemorySecureStorage())
  const first = await service.save(profileInput({ name: 'First' }))
  const second = await service.save(
    profileInput({ name: 'Second', baseUrl: 'https://second.example.com/v1' })
  )

  assert.equal((await service.setCurrent(second.credentialHandle)).isCurrent, true)
  let listed = await service.listPublic()
  assert.equal(listed.find((profile) => profile.credentialHandle === first.credentialHandle)?.isCurrent, false)
  assert.equal(listed.find((profile) => profile.credentialHandle === second.credentialHandle)?.isCurrent, true)

  await service.delete(second.credentialHandle)
  listed = await service.listPublic()
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.isCurrent, false)
  await assert.rejects(service.getSecretForMain(second.credentialHandle), hasErrorCode('not_found'))
  await assert.rejects(service.delete(second.credentialHandle), hasErrorCode('not_found'))
})

test('profiles without keys remain public-only and cannot resolve a secret', async () => {
  const service = new AccessProfileService(new MemorySecureStorage())
  const created = await service.save({
    name: 'Credential pending',
    baseUrl: 'https://pending.example.com/v1',
    targets: []
  })

  assert.equal(created.hasKey, false)
  await assert.rejects(service.getSecretForMain(created.credentialHandle), hasErrorCode('missing_secret'))
})

test('corrupt, unknown-version and structurally ambiguous documents fail closed', async () => {
  const storage = new MemorySecureStorage()
  const service = new AccessProfileService(storage)
  const corruptDocuments: unknown[] = [
    '{not-json',
    JSON.stringify({
      format: 'ai-terminal.access-profiles',
      version: 2,
      currentCredentialHandle: null,
      profiles: []
    }),
    JSON.stringify({
      format: 'ai-terminal.access-profiles',
      version: 1,
      currentCredentialHandle: null,
      profiles: [],
      apiKey: 'unexpected-secret-field'
    }),
    JSON.stringify({
      format: 'ai-terminal.access-profiles',
      version: 1,
      currentCredentialHandle: 'profile:00000000-0000-4000-8000-000000000000',
      profiles: []
    })
  ]

  for (const document of corruptDocuments) {
    storage.value = String(document)
    await assert.rejects(service.listPublic(), hasErrorCode('corrupt_data'))
  }
})

test('concurrent saves are serialized without dropping profiles', async () => {
  const storage = new MemorySecureStorage()
  const service = new AccessProfileService(storage)

  await Promise.all([
    service.save(profileInput({ name: 'One', baseUrl: 'https://one.example.com/v1' })),
    service.save(profileInput({ name: 'Two', baseUrl: 'https://two.example.com/v1' })),
    service.save(profileInput({ name: 'Three', baseUrl: 'https://three.example.com/v1' }))
  ])

  assert.deepEqual(
    (await service.listPublic()).map((profile) => profile.name),
    ['One', 'Two', 'Three']
  )
})

test('storage errors do not expose credentials or absolute paths', async () => {
  const secret = 'sk-provider-error-secret'
  const localPath = 'D:\\private\\access-profiles.json'
  const storage: AccessProfileStorage = {
    read: async () => null,
    write: async () => {
      throw new Error(`failed for ${secret} at ${localPath}`)
    }
  }
  const service = new AccessProfileService(storage)

  await assert.rejects(service.save(profileInput({ apiKey: secret })), (error: unknown) => {
    assert(error instanceof AccessProfileServiceError)
    const exposed = `${String(error)}\n${error.stack ?? ''}`
    assert.doesNotMatch(exposed, new RegExp(secret))
    assert.doesNotMatch(exposed, /D:\\private/)
    return true
  })
})

function hasErrorCode(code: AccessProfileServiceError['code']): (error: unknown) => boolean {
  return (error: unknown) => {
    assert(error instanceof AccessProfileServiceError)
    assert.equal(error.code, code)
    return true
  }
}
