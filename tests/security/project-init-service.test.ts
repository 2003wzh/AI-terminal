import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import {
  ProjectInitError,
  ProjectInitService,
  type ProjectInitServiceOptions,
  type ProjectInitWorkspaceContext
} from '../../src/main/services/project-init-service.ts'
import {
  SelectionTokenStore,
  type ResolvedWorkspaceRecord
} from '../../src/main/services/selection-token-store.ts'

const OWNER_ID = 73
const OTHER_OWNER_ID = 74

test('prepare returns a frozen, bounded, redacted draft bound to an absent target', async (t) => {
  let summaryContext: Readonly<ProjectInitWorkspaceContext> | null = null
  const fixture = await createFixture(t, {
    summarizeWorkspace(workspace) {
      summaryContext = workspace
      return `TypeScript workspace at ${workspace.absolutePath}; api_key=private-project-init-marker; \`data\``
    }
  })

  const preview = await fixture.service.prepare({
    workspace: fixture.workspace,
    ownerWebContentsId: OWNER_ID
  })

  const inspection = await fixture.service.inspectForCommit({
    draftHandle: preview.draftHandle,
    workspace: fixture.workspace
  }, OWNER_ID)
  assert.equal(Object.isFrozen(inspection), true)
  assert.equal(Object.isFrozen(inspection.target), true)
  assert.deepEqual(inspection, {
    relativePath: 'AGENTS.md',
    contentSha256: preview.contentSha256,
    target: { state: 'absent' },
    expiresAt: preview.expiresAt
  })

  assert.match(preview.draftHandle, /^draft_[A-Za-z0-9_-]{43}$/u)
  assert.equal(preview.relativePath, 'AGENTS.md')
  assert.deepEqual(preview.target, { state: 'absent' })
  assert.equal(Object.isFrozen(preview), true)
  assert.equal(Object.isFrozen(preview.target), true)
  assert.equal(Object.isFrozen(summaryContext), true)
  assert.equal(summaryContext?.ownerWebContentsId, OWNER_ID)
  assert.match(preview.content, /^# AGENTS\.md\n/u)
  assert.match(preview.content, /## Working rules/u)
  assert.equal(Buffer.byteLength(preview.content, 'utf8') <= 32 * 1024, true)
  assert.equal(preview.content.includes(fixture.root), false)
  assert.equal(preview.content.includes('private-project-init-marker'), false)
  assert.equal(preview.content.includes('`'), false)
  assert.equal(
    preview.contentSha256,
    createHash('sha256').update(preview.content, 'utf8').digest('hex')
  )
  assert.equal(await pathExists(join(fixture.root, 'AGENTS.md')), false)
})

test('commit accepts only an opaque handle, creates fixed-root AGENTS.md atomically, and is one-shot', async (t) => {
  const fixture = await createFixture(t)
  const preview = await fixture.service.prepare({
    workspace: fixture.workspace,
    ownerWebContentsId: OWNER_ID
  })

  const result = await fixture.service.commit({
    draftHandle: preview.draftHandle,
    workspace: fixture.workspace
  }, OWNER_ID)
  assert.deepEqual(result, {
    relativePath: 'AGENTS.md',
    revision: preview.contentSha256,
    replaced: false
  })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(await fs.readFile(join(fixture.root, 'AGENTS.md'), 'utf8'), preview.content)
  assert.equal(
    (await fs.readdir(fixture.root)).some((name) => name.startsWith('.ai-terminal-init-')),
    false
  )

  await assertProjectInitError(
    fixture.service.commit({ draftHandle: preview.draftHandle, workspace: fixture.workspace }, OWNER_ID),
    'draft_unavailable'
  )

  const rejected = await fixture.service.prepare({
    workspace: fixture.workspace,
    ownerWebContentsId: OWNER_ID
  })
  await assertProjectInitError(
    fixture.service.commit({
      draftHandle: rejected.draftHandle,
      workspace: fixture.workspace,
      content: 'Renderer-controlled content must never be accepted.'
    } as never, OWNER_ID),
    'invalid_request'
  )
  await assertProjectInitError(
    fixture.service.commit({ draftHandle: rejected.draftHandle, workspace: fixture.workspace }, OWNER_ID),
    'draft_unavailable'
  )
})

test('existing AGENTS.md is revision-bound and replacement preserves stale external changes', async (t) => {
  const fixture = await createFixture(t)
  const targetPath = join(fixture.root, 'AGENTS.md')
  await fs.writeFile(targetPath, '# Existing\n', 'utf8')

  const replacement = await fixture.service.prepare({
    workspace: fixture.workspace,
    ownerWebContentsId: OWNER_ID
  })
  assert.equal(replacement.target.state, 'existing')
  if (replacement.target.state === 'existing') {
    assert.equal(
      replacement.target.revision,
      createHash('sha256').update('# Existing\n').digest('hex')
    )
  }
  const committed = await fixture.service.commit(
    { draftHandle: replacement.draftHandle, workspace: fixture.workspace },
    OWNER_ID
  )
  assert.equal(committed.replaced, true)
  assert.equal(await fs.readFile(targetPath, 'utf8'), replacement.content)

  const stale = await fixture.service.prepare({
    workspace: fixture.workspace,
    ownerWebContentsId: OWNER_ID
  })
  await fs.writeFile(targetPath, '# Changed outside the app\n', 'utf8')
  await assertProjectInitError(
    fixture.service.commit({ draftHandle: stale.draftHandle, workspace: fixture.workspace }, OWNER_ID),
    'target_changed'
  )
  assert.equal(await fs.readFile(targetPath, 'utf8'), '# Changed outside the app\n')
  await assertProjectInitError(
    fixture.service.commit({ draftHandle: stale.draftHandle, workspace: fixture.workspace }, OWNER_ID),
    'draft_unavailable'
  )
})

test('absent-target commit retries temporary hard-link cleanup and leaves no duplicate', async (t) => {
  const fixture = await createFixture(t)
  const preview = await fixture.service.prepare({
    workspace: fixture.workspace,
    ownerWebContentsId: OWNER_ID
  })
  const originalUnlink = fs.unlink
  let cleanupAttempts = 0
  fs.unlink = (async (...args: Parameters<typeof fs.unlink>) => {
    if (String(args[0]).includes('.ai-terminal-init-')) {
      cleanupAttempts += 1
      if (cleanupAttempts === 1) {
        throw Object.assign(new Error('transient cleanup failure'), { code: 'EPERM' })
      }
    }
    return await originalUnlink(...args)
  }) as typeof fs.unlink
  t.after(() => {
    fs.unlink = originalUnlink
  })

  const result = await fixture.service.commit({
    draftHandle: preview.draftHandle,
    workspace: fixture.workspace
  }, OWNER_ID)
  assert.equal(result.revision, preview.contentSha256)
  assert.equal(cleanupAttempts, 2)
  assert.equal(
    (await fs.readdir(fixture.root)).some((name) => name.startsWith('.ai-terminal-init-')),
    false
  )
})

test('permanent temporary-link cleanup failure reports that AGENTS.md was already committed', async (t) => {
  const fixture = await createFixture(t)
  const preview = await fixture.service.prepare({
    workspace: fixture.workspace,
    ownerWebContentsId: OWNER_ID
  })
  const originalUnlink = fs.unlink
  const originalRm = fs.rm
  const cleanupFailure = (): Error => Object.assign(
    new Error('D:/private/cleanup-secret.txt'),
    { code: 'EPERM' }
  )
  fs.unlink = (async (...args: Parameters<typeof fs.unlink>) => {
    if (String(args[0]).includes('.ai-terminal-init-')) throw cleanupFailure()
    return await originalUnlink(...args)
  }) as typeof fs.unlink
  fs.rm = (async (...args: Parameters<typeof fs.rm>) => {
    if (String(args[0]).includes('.ai-terminal-init-')) throw cleanupFailure()
    return await originalRm(...args)
  }) as typeof fs.rm

  let caught: unknown
  try {
    await fixture.service.commit({
      draftHandle: preview.draftHandle,
      workspace: fixture.workspace
    }, OWNER_ID)
  } catch (error) {
    caught = error
  } finally {
    fs.unlink = originalUnlink
    fs.rm = originalRm
  }

  assert.ok(caught instanceof ProjectInitError)
  assert.equal(caught.code, 'committed_cleanup_failed')
  assert.equal(caught.committed, true)
  assert.doesNotMatch(`${caught.message}\n${caught.stack}`, /private|cleanup-secret/i)
  assert.equal(await fs.readFile(join(fixture.root, 'AGENTS.md'), 'utf8'), preview.content)
  const temporaryNames = (await fs.readdir(fixture.root)).filter(
    (name) => name.startsWith('.ai-terminal-init-')
  )
  assert.equal(temporaryNames.length, 1)
  await originalUnlink(join(fixture.root, temporaryNames[0]!))
})

test('draft handles are owner and live workspace-selection bound and burn on mismatch', async (t) => {
  const fixture = await createFixture(t)
  const wrongOwner = await fixture.service.prepare({
    workspace: fixture.workspace,
    ownerWebContentsId: OWNER_ID
  })
  await assertProjectInitError(
    fixture.service.commit({ draftHandle: wrongOwner.draftHandle, workspace: fixture.workspace }, OTHER_OWNER_ID),
    'invalid_request'
  )
  await assertProjectInitError(
    fixture.service.commit({ draftHandle: wrongOwner.draftHandle, workspace: fixture.workspace }, OWNER_ID),
    'draft_unavailable'
  )
  assert.equal(await pathExists(join(fixture.root, 'AGENTS.md')), false)

  const revoked = await fixture.service.prepare({
    workspace: fixture.workspace,
    ownerWebContentsId: OWNER_ID
  })
  fixture.selections.revokeOwner(OWNER_ID)
  await assertProjectInitError(
    fixture.service.commit({ draftHandle: revoked.draftHandle, workspace: fixture.workspace }, OWNER_ID),
    'workspace_changed'
  )
  assert.equal(await pathExists(join(fixture.root, 'AGENTS.md')), false)
})

test('inspect and commit reject a different Main-resolved workspace and burn only that draft', async (t) => {
  const fixture = await createFixture(t)
  const secondRoot = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-project-init-other-'))
  t.after(() => fs.rm(secondRoot, { recursive: true, force: true }))
  const secondSelection = fixture.selections.issueWorkspace(secondRoot, OWNER_ID)
  const secondWorkspace = await fixture.selections.resolveWorkspace(
    secondSelection.workspaceToken,
    OWNER_ID
  )
  assert.ok(secondWorkspace)

  const inspectedMismatch = await fixture.service.prepare({
    workspace: fixture.workspace,
    ownerWebContentsId: OWNER_ID
  })
  await assertProjectInitError(
    fixture.service.inspectForCommit({
      draftHandle: inspectedMismatch.draftHandle,
      workspace: secondWorkspace
    }, OWNER_ID),
    'workspace_changed'
  )
  await assertProjectInitError(
    fixture.service.commit({
      draftHandle: inspectedMismatch.draftHandle,
      workspace: fixture.workspace
    }, OWNER_ID),
    'draft_unavailable'
  )

  const committedMismatch = await fixture.service.prepare({
    workspace: fixture.workspace,
    ownerWebContentsId: OWNER_ID
  })
  await assertProjectInitError(
    fixture.service.commit({
      draftHandle: committedMismatch.draftHandle,
      workspace: secondWorkspace
    }, OWNER_ID),
    'workspace_changed'
  )
  await assertProjectInitError(
    fixture.service.commit({
      draftHandle: committedMismatch.draftHandle,
      workspace: fixture.workspace
    }, OWNER_ID),
    'draft_unavailable'
  )
  assert.equal(await pathExists(join(fixture.root, 'AGENTS.md')), false)
  assert.equal(await pathExists(join(secondRoot, 'AGENTS.md')), false)
})

test('discardAttempt burns exactly one discoverable handle without reflecting hostile input', async (t) => {
  const fixture = await createFixture(t)
  const discarded = await fixture.service.prepare({
    workspace: fixture.workspace,
    ownerWebContentsId: OWNER_ID
  })
  const retained = await fixture.service.prepare({
    workspace: fixture.workspace,
    ownerWebContentsId: OWNER_ID
  })

  assert.equal(fixture.service.discardAttempt({
    draftHandle: discarded.draftHandle,
    content: 'must be ignored'
  }, OWNER_ID), true)
  assert.equal(fixture.service.discardAttempt({ draftHandle: discarded.draftHandle }, OWNER_ID), false)
  await assertProjectInitError(
    fixture.service.inspectForCommit({
      draftHandle: discarded.draftHandle,
      workspace: fixture.workspace
    }, OWNER_ID),
    'draft_unavailable'
  )
  const retainedInspection = await fixture.service.inspectForCommit({
    draftHandle: retained.draftHandle,
    workspace: fixture.workspace
  }, OWNER_ID)
  assert.equal(retainedInspection.contentSha256, retained.contentSha256)

  const hostile = new Proxy({}, {
    getOwnPropertyDescriptor() {
      throw new Error('D:/private/discard-secret.txt')
    }
  })
  assert.doesNotThrow(() => fixture.service.discardAttempt(hostile, OWNER_ID))
  assert.equal(fixture.service.discardAttempt(hostile, OWNER_ID), false)
})

test('expiry, capacity, owner revocation, and clear fail closed without persisting drafts', async (t) => {
  let now = 10_000
  const fixture = await createFixture(t, {
    now: () => now,
    draftTtlMs: 1_000,
    maxDrafts: 1
  })
  const first = await fixture.service.prepare({
    workspace: fixture.workspace,
    ownerWebContentsId: OWNER_ID
  })
  await assertProjectInitError(
    fixture.service.prepare({ workspace: fixture.workspace, ownerWebContentsId: OWNER_ID }),
    'draft_capacity_exceeded'
  )

  now = 10_999
  const expiringInspection = fixture.service.inspectForCommit({
    draftHandle: first.draftHandle,
    workspace: fixture.workspace
  }, OWNER_ID)
  now = 11_000
  await assertProjectInitError(
    expiringInspection,
    'draft_unavailable'
  )
  await assertProjectInitError(
    fixture.service.commit({ draftHandle: first.draftHandle, workspace: fixture.workspace }, OWNER_ID),
    'draft_unavailable'
  )
  const recovered = await fixture.service.prepare({
    workspace: fixture.workspace,
    ownerWebContentsId: OWNER_ID
  })
  fixture.service.revokeOwner(OWNER_ID)
  await assertProjectInitError(
    fixture.service.commit({ draftHandle: recovered.draftHandle, workspace: fixture.workspace }, OWNER_ID),
    'draft_unavailable'
  )

  const cleared = await fixture.service.prepare({
    workspace: fixture.workspace,
    ownerWebContentsId: OWNER_ID
  })
  fixture.service.clear()
  await assertProjectInitError(
    fixture.service.commit({ draftHandle: cleared.draftHandle, workspace: fixture.workspace }, OWNER_ID),
    'draft_unavailable'
  )
})

test('summary output is UTF-8 bounded and callback failures expose only fixed errors', async (t) => {
  let summary = `${'项目 '.repeat(2_000)}api_key=summary-secret-marker`
  const fixture = await createFixture(t, {
    maxSummaryBytes: 128,
    summarizeWorkspace: () => summary
  })
  const preview = await fixture.service.prepare({
    workspace: fixture.workspace,
    ownerWebContentsId: OWNER_ID
  })
  assert.match(preview.content, /\[summary truncated\]/u)
  assert.equal(Buffer.from(preview.content, 'utf8').toString('utf8'), preview.content)
  assert.equal(preview.content.includes('summary-secret-marker'), false)

  summary = '\ud800'
  await assertProjectInitError(
    fixture.service.prepare({ workspace: fixture.workspace, ownerWebContentsId: OWNER_ID }),
    'summary_failed'
  )

  const failed = await createFixture(t, {
    summarizeWorkspace() {
      throw new Error('D:\\private\\summary-secret.txt')
    }
  })
  await assertProjectInitError(
    failed.service.prepare({ workspace: failed.workspace, ownerWebContentsId: OWNER_ID }),
    'summary_failed',
    'private',
    'summary-secret'
  )
})

test('hard-linked, oversized, and protected AGENTS.md targets fail closed', async (t) => {
  const hardLinkFixture = await createFixture(t)
  const sourcePath = join(hardLinkFixture.root, 'source.txt')
  await fs.writeFile(sourcePath, 'linked\n', 'utf8')
  await fs.link(sourcePath, join(hardLinkFixture.root, 'AGENTS.md'))
  await assertProjectInitError(
    hardLinkFixture.service.prepare({
      workspace: hardLinkFixture.workspace,
      ownerWebContentsId: OWNER_ID
    }),
    'target_invalid'
  )

  const oversized = await createFixture(t, { maxExistingTargetBytes: 4 * 1024 })
  await fs.writeFile(join(oversized.root, 'AGENTS.md'), 'x'.repeat(4 * 1024 + 1), 'utf8')
  await assertProjectInitError(
    oversized.service.prepare({ workspace: oversized.workspace, ownerWebContentsId: OWNER_ID }),
    'target_invalid'
  )

  const protectedFixture = await createFixture(t, {
    protectedAbsoluteRoots: []
  })
  const protectedService = new ProjectInitService({
    selections: protectedFixture.selections,
    summarizeWorkspace: () => 'Never reached.',
    protectedAbsoluteRoots: [protectedFixture.root]
  })
  await assertProjectInitError(
    protectedService.prepare({
      workspace: protectedFixture.workspace,
      ownerWebContentsId: OWNER_ID
    }),
    'workspace_unavailable'
  )
})

test('invalid plain-data inputs fail with fixed redacted errors and cancelled work never writes', async (t) => {
  const fixture = await createFixture(t)
  const privateMarker = 'D:/private/project-init-secret.txt'
  const invalidInput = new Proxy({
    workspace: fixture.workspace,
    ownerWebContentsId: OWNER_ID
  }, {
    ownKeys() {
      throw new Error(privateMarker)
    }
  })
  await assertProjectInitError(
    fixture.service.prepare(invalidInput as never),
    'invalid_request',
    'private',
    'secret'
  )

  const controller = new AbortController()
  controller.abort()
  await assertProjectInitError(
    fixture.service.prepare(
      { workspace: fixture.workspace, ownerWebContentsId: OWNER_ID },
      { signal: controller.signal }
    ),
    'cancelled'
  )
  assert.equal(await pathExists(join(fixture.root, 'AGENTS.md')), false)

  assert.throws(
    () => new ProjectInitService({
      selections: fixture.selections,
      summarizeWorkspace: () => 'summary',
      maxDrafts: 0
    }),
    (error: unknown) => error instanceof ProjectInitError && error.code === 'invalid_options'
  )
})

interface FixtureOverrides extends Partial<Omit<ProjectInitServiceOptions, 'selections'>> {}

async function createFixture(t: TestContext, overrides: FixtureOverrides = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-project-init-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const selections = new SelectionTokenStore()
  const selection = selections.issueWorkspace(root, OWNER_ID)
  const workspace = await selections.resolveWorkspace(selection.workspaceToken, OWNER_ID)
  assert.ok(workspace)
  const service = new ProjectInitService({
    selections,
    summarizeWorkspace: () => 'Node and TypeScript desktop application.',
    ...overrides
  })
  return { root, selections, workspace, service }
}

async function assertProjectInitError(
  promise: Promise<unknown>,
  expectedCode: ProjectInitError['code'],
  ...forbidden: readonly string[]
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ProjectInitError)
    assert.equal(error.code, expectedCode)
    assert.equal(error.stack, `ProjectInitError: ${error.message}`)
    for (const marker of forbidden) {
      assert.equal(`${error.message}\n${error.stack}`.toLowerCase().includes(marker.toLowerCase()), false)
    }
    return true
  })
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path)
    return true
  } catch {
    return false
  }
}
