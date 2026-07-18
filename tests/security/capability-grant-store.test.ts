import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CapabilityGrantStore,
  CapabilityGrantStoreError,
  type CapabilityGrantIssueInput
} from '../../src/main/services/capability-grant-store.ts'

const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)

function userSkill(
  overrides: Partial<CapabilityGrantIssueInput> = {}
): CapabilityGrantIssueInput {
  return {
    ownerWebContentsId: 17,
    kind: 'skill',
    id: 'skill:user:review-helper',
    scope: 'user',
    relativePath: '.codex/skills/review-helper/SKILL.md',
    root: { device: '7', inode: '41' },
    file: {
      device: '7',
      inode: '42',
      size: 123,
      mtimeMs: 1_700_000_000_000.25,
      contentSha256: DIGEST_A
    },
    workspace: null,
    ...overrides
  } as CapabilityGrantIssueInput
}

function workspacePlugin(
  overrides: Partial<CapabilityGrantIssueInput> = {}
): CapabilityGrantIssueInput {
  return {
    ownerWebContentsId: 31,
    kind: 'plugin',
    id: 'plugin:workspace:terminal-tools',
    scope: 'workspace',
    relativePath: '.agents/plugins/terminal-tools/.codex-plugin/plugin.json',
    root: { device: '9', inode: '51' },
    file: {
      device: '9',
      inode: '52',
      size: 456,
      mtimeMs: 1_700_000_000_010,
      contentSha256: DIGEST_B
    },
    workspace: { device: '9', inode: '51' },
    ...overrides
  } as CapabilityGrantIssueInput
}

test('capability grants are opaque, owner-bound, in-memory, and renderer-safe', () => {
  let now = 10_000
  const store = new CapabilityGrantStore({ now: () => now, grantTtlMs: 5_000 })
  const grant = store.issue(userSkill())

  assert.match(grant.grantHandle, /^cap_[A-Za-z0-9_-]{43}$/u)
  assert.equal(grant.expiresAt, 15_000)
  assert.equal(JSON.stringify(grant).includes('.codex/skills'), false)
  assert.equal(store.peek(grant.grantHandle, 18), null)

  const binding = store.peek(grant.grantHandle, 17)
  assert.ok(binding)
  assert.deepEqual(Object.keys(binding).sort(), [
    'expiresAt',
    'file',
    'grantHandle',
    'id',
    'kind',
    'relativePath',
    'root',
    'scope',
    'workspace'
  ])
  assert.equal(Object.hasOwn(binding, 'ownerWebContentsId'), false)
  assert.equal(Object.isFrozen(binding), true)
  assert.equal(Object.isFrozen(binding.root), true)
  assert.equal(Object.isFrozen(binding.file), true)

  const restartedStore = new CapabilityGrantStore()
  assert.equal(restartedStore.peek(grant.grantHandle, 17), null)
  now += 1
})

test('workspace grants require and expose a frozen workspace identity', () => {
  const store = new CapabilityGrantStore()
  const grant = store.issue(workspacePlugin())
  const binding = store.peek(grant.grantHandle, 31)

  assert.ok(binding?.workspace)
  assert.equal(Object.isFrozen(binding.workspace), true)
  assert.deepEqual(binding.workspace, { device: '9', inode: '51' })

  assert.throws(
    () => store.issue({ ...workspacePlugin(), workspace: null }),
    (error: unknown) => error instanceof CapabilityGrantStoreError && error.code === 'invalid_binding'
  )
  assert.throws(
    () => store.issue({ ...userSkill(), workspace: { device: '7', inode: '41' } }),
    (error: unknown) => error instanceof CapabilityGrantStoreError && error.code === 'invalid_binding'
  )
  assert.throws(
    () => store.issue(workspacePlugin({ workspace: { device: '9', inode: '999' } })),
    (error: unknown) => error instanceof CapabilityGrantStoreError && error.code === 'invalid_binding'
  )
})

test('consume is exactly bound, successful once, and compares the content digest', () => {
  const store = new CapabilityGrantStore()
  const binding = userSkill()
  const grant = store.issue(binding)

  assert.equal(store.consume({ grantHandle: grant.grantHandle, ...binding }), true)
  assert.equal(store.consume({ grantHandle: grant.grantHandle, ...binding }), false)

  const digestMismatch = store.issue(binding)
  assert.equal(store.consume({
    grantHandle: digestMismatch.grantHandle,
    ...binding,
    file: { ...binding.file, contentSha256: DIGEST_B }
  }), false)
  assert.equal(store.consume({ grantHandle: digestMismatch.grantHandle, ...binding }), false)
})

test('every owner, kind, id, path, root, file, and workspace mismatch consumes the grant', () => {
  const original = workspacePlugin()
  const mismatches: CapabilityGrantIssueInput[] = [
    workspacePlugin({ ownerWebContentsId: 32 }),
    workspacePlugin({ kind: 'skill', id: 'skill:workspace:terminal-tools' }),
    workspacePlugin({ id: 'plugin:workspace:other-tools' }),
    workspacePlugin({ relativePath: '.agents/plugins/other/.codex-plugin/plugin.json' }),
    workspacePlugin({ root: { device: '9', inode: '53' } }),
    workspacePlugin({ file: { ...original.file, inode: '54' } }),
    workspacePlugin({ file: { ...original.file, size: original.file.size + 1 } }),
    workspacePlugin({ file: { ...original.file, mtimeMs: original.file.mtimeMs + 1 } }),
    workspacePlugin({ workspace: { device: '9', inode: '55' } })
  ]

  for (const mismatch of mismatches) {
    const store = new CapabilityGrantStore()
    const grant = store.issue(original)
    assert.equal(store.consume({ grantHandle: grant.grantHandle, ...mismatch }), false)
    assert.equal(store.consume({ grantHandle: grant.grantHandle, ...original }), false)
  }
})

test('malformed binding attempts consume known handles and errors never reflect inputs', () => {
  const store = new CapabilityGrantStore()
  const privateMarker = 'D:/private/account/token.txt'
  const binding = userSkill()
  const grant = store.issue(binding)

  assert.equal(store.consume({
    grantHandle: grant.grantHandle,
    ...binding,
    relativePath: privateMarker,
    unexpected: true
  }), false)
  assert.equal(store.consume({ grantHandle: grant.grantHandle, ...binding }), false)

  assert.throws(
    () => store.issue({ ...binding, relativePath: privateMarker }),
    (error: unknown) => {
      assert.ok(error instanceof CapabilityGrantStoreError)
      assert.equal(error.code, 'invalid_binding')
      assert.equal(error.message, 'The capability grant binding is invalid.')
      assert.equal(error.stack, `CapabilityGrantStoreError: ${error.message}`)
      assert.doesNotMatch(error.message, /private|account|token/i)
      return true
    }
  )
})

test('expiry, capacity, owner revocation, and clear fail closed', () => {
  let now = 20_000
  const store = new CapabilityGrantStore({
    now: () => now,
    grantTtlMs: 100,
    maxRecords: 2
  })
  const first = store.issue(userSkill())
  const second = store.issue(workspacePlugin())
  assert.throws(
    () => store.issue(userSkill({ id: 'skill:user:third' })),
    (error: unknown) =>
      error instanceof CapabilityGrantStoreError && error.code === 'grant_capacity_exceeded'
  )

  store.revokeOwner(17)
  assert.equal(store.peek(first.grantHandle, 17), null)
  assert.ok(store.peek(second.grantHandle, 31))

  now = 20_100
  assert.equal(store.peek(second.grantHandle, 31), null)
  const recovered = store.issue(userSkill({ id: 'skill:user:recovered' }))
  assert.ok(recovered.grantHandle)
  store.clear()
  assert.equal(store.peek(recovered.grantHandle, 17), null)
})

test('plain exact objects and canonical binding values are mandatory', () => {
  const store = new CapabilityGrantStore()
  const binding = userSkill()
  const symbolExtra = { ...binding, [Symbol('hidden')]: true }
  const hiddenExtra = { ...binding }
  Object.defineProperty(hiddenExtra, 'hidden', { enumerable: false, value: true })
  const accessorInput = { ...binding }
  Object.defineProperty(accessorInput, 'id', {
    enumerable: true,
    get: () => 'skill:user:accessor'
  })
  const invalid: unknown[] = [
    null,
    [],
    { ...binding, unexpected: true },
    { ...binding, id: 'plugin:user:wrong-kind' },
    { ...binding, relativePath: '../SKILL.md' },
    { ...binding, root: { device: '07', inode: '41' } },
    { ...binding, file: { ...binding.file, contentSha256: DIGEST_A.toUpperCase() } },
    Object.assign(Object.create({ inherited: true }), binding),
    symbolExtra,
    hiddenExtra,
    accessorInput,
    new Proxy(binding, {
      ownKeys: () => {
        throw new Error('D:/private/proxy-secret.txt')
      }
    })
  ]

  for (const input of invalid) {
    assert.throws(
      () => store.issue(input),
      (error: unknown) => error instanceof CapabilityGrantStoreError && error.code === 'invalid_binding'
    )
  }
  assert.throws(
    () => new CapabilityGrantStore({ maxRecords: 0 }),
    (error: unknown) => error instanceof CapabilityGrantStoreError && error.code === 'invalid_options'
  )
  assert.throws(
    () => new CapabilityGrantStore(new Proxy({}, {
      ownKeys: () => {
        throw new Error('private-options-marker')
      }
    })),
    (error: unknown) => {
      assert.ok(error instanceof CapabilityGrantStoreError)
      assert.equal(error.code, 'invalid_options')
      assert.doesNotMatch(error.message, /private|marker/i)
      return true
    }
  )
})
