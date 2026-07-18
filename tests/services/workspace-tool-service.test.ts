import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { SelectionTokenStore } from '../../src/main/services/selection-token-store.ts'
import {
  WorkspaceToolError,
  WorkspaceToolService
} from '../../src/main/services/workspace-tool-service.ts'

const OWNER_ID = 41

test('read_file rejects traversal, absolute, device, ADS, and unsafe Windows path forms', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  const rejectedPaths = [
    '../outside.txt',
    'folder/../../outside.txt',
    'C:\\private\\file.txt',
    '\\\\server\\share\\file.txt',
    '\\\\?\\C:\\private\\file.txt',
    '\\\\.\\PhysicalDrive0',
    '/etc/passwd',
    'folder/file.txt:stream',
    'folder/CON.txt',
    'folder/trailing.',
    'folder/trailing '
  ]

  for (const relativePath of rejectedPaths) {
    await assert.rejects(
      fixture.service.readFile(
        { workspaceToken: fixture.workspaceToken, relativePath },
        OWNER_ID
      ),
      (error: unknown) => {
        assert.ok(error instanceof WorkspaceToolError)
        assert.equal(error.code, 'invalid_relative_path')
        assert.equal(error.message.includes(relativePath), false)
        return true
      }
    )
  }
})

test('read_file hard-rejects credential and private-history paths before file access', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  const sensitivePaths = [
    '.env',
    '.env.local',
    'keys/server.pem',
    'keys/server.key',
    '.npmrc',
    '.pypirc',
    'auth.json',
    'credentials',
    '.ssh/id_ed25519',
    'secure/access-profiles.json',
    'secure/conversation-history.json'
  ]

  for (const relativePath of sensitivePaths) {
    await assert.rejects(
      fixture.service.readFile(
        { workspaceToken: fixture.workspaceToken, relativePath },
        OWNER_ID
      ),
      (error: unknown) => {
        assert.ok(error instanceof WorkspaceToolError)
        assert.equal(error.code, 'sensitive_path')
        assert.equal(error.message.includes(relativePath), false)
        return true
      }
    )
  }
})

test('read_file returns bounded UTF-8 text with credentials and absolute paths redacted', async (t) => {
  const fixture = await createWorkspaceFixture(t, { maxFileBytes: 1_024, maxResultCharacters: 1_024 })
  const secret = 'workspace-service-secret-marker'
  const localPath = 'C:\\Users\\private-user\\notes.txt'
  await fs.writeFile(
    join(fixture.root, 'notes.txt'),
    `api_key=${secret}\nlocal=${localPath}\nhello workspace`,
    'utf8'
  )

  const result = await fixture.service.readFile(
    { workspaceToken: fixture.workspaceToken, relativePath: 'notes.txt' },
    OWNER_ID
  )
  assert.equal(result.relativePath, 'notes.txt')
  assert.equal(result.truncated, false)
  assert.match(result.revision, /^[a-f0-9]{64}$/)
  assert.match(result.content, /<redacted>/)
  assert.match(result.content, /<local-path>/)
  assert.equal(result.content.includes(secret), false)
  assert.equal(result.content.includes('private-user'), false)
  assert.match(result.content, /hello workspace/)

  const filenameSecret = 'read-filename-secret-marker'
  const sensitiveFilename = `token=${filenameSecret}.txt`
  await fs.writeFile(join(fixture.root, sensitiveFilename), 'safe body', 'utf8')
  const filenameResult = await fixture.service.readFile(
    { workspaceToken: fixture.workspaceToken, relativePath: sensitiveFilename },
    OWNER_ID
  )
  assert.equal(filenameResult.relativePath.includes(filenameSecret), false)
  assert.match(filenameResult.relativePath, /<redacted>/)
})

test('read_file enforces byte, UTF-8, owner, and cancellation boundaries', async (t) => {
  const fixture = await createWorkspaceFixture(t, { maxFileBytes: 16 })
  await fs.writeFile(join(fixture.root, 'large.txt'), 'x'.repeat(17), 'utf8')
  await fs.writeFile(join(fixture.root, 'binary.txt'), Buffer.from([0xff, 0xfe, 0xfd]))

  await assertWorkspaceError(
    fixture.service.readFile(
      { workspaceToken: fixture.workspaceToken, relativePath: 'large.txt' },
      OWNER_ID
    ),
    'file_too_large'
  )
  await assertWorkspaceError(
    fixture.service.readFile(
      { workspaceToken: fixture.workspaceToken, relativePath: 'binary.txt' },
      OWNER_ID
    ),
    'invalid_text_file'
  )
  await assertWorkspaceError(
    fixture.service.readFile(
      { workspaceToken: fixture.workspaceToken, relativePath: 'large.txt' },
      OWNER_ID + 1
    ),
    'workspace_unavailable'
  )

  const controller = new AbortController()
  controller.abort()
  await assertWorkspaceError(
    fixture.service.readFile(
      { workspaceToken: fixture.workspaceToken, relativePath: 'large.txt' },
      OWNER_ID,
      { signal: controller.signal }
    ),
    'cancelled'
  )
})

test('read_file rejects symlink or junction traversal out of the workspace', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  const outside = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-outside-'))
  t.after(() => fs.rm(outside, { recursive: true, force: true }))
  await fs.writeFile(join(outside, 'secret.txt'), 'must not be read', 'utf8')

  const linkPath = join(fixture.root, 'escape')
  try {
    await fs.symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (isNodeErrorCode(error, 'EPERM') || isNodeErrorCode(error, 'EACCES')) {
      t.skip('This host does not permit creating a symlink or junction fixture.')
      return
    }
    throw error
  }

  await assertWorkspaceError(
    fixture.service.readFile(
      { workspaceToken: fixture.workspaceToken, relativePath: 'escape/secret.txt' },
      OWNER_ID
    ),
    'reparse_point_rejected'
  )
})

test('read, search, write, and replace reject multiply-linked regular files', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  const outside = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-hard-link-'))
  t.after(() => fs.rm(outside, { recursive: true, force: true }))

  const contents = new Map([
    ['read-hard-link.txt', 'read hard-link marker\n'],
    ['search-hard-link.txt', 'search hard-link marker\n'],
    ['write-hard-link.txt', 'write original\n'],
    ['replace-hard-link.txt', 'replace old value\n']
  ])
  for (const [fileName, content] of contents) {
    await fs.writeFile(join(fixture.root, fileName), content, 'utf8')
  }

  const writeRevision = (
    await fixture.service.readFile(
      { workspaceToken: fixture.workspaceToken, relativePath: 'write-hard-link.txt' },
      OWNER_ID
    )
  ).revision
  const replaceRevision = (
    await fixture.service.readFile(
      { workspaceToken: fixture.workspaceToken, relativePath: 'replace-hard-link.txt' },
      OWNER_ID
    )
  ).revision

  try {
    for (const fileName of contents.keys()) {
      await fs.link(join(fixture.root, fileName), join(outside, fileName))
    }
  } catch (error) {
    if (
      isNodeErrorCode(error, 'EACCES') ||
      isNodeErrorCode(error, 'EPERM') ||
      isNodeErrorCode(error, 'ENOTSUP') ||
      isNodeErrorCode(error, 'EXDEV')
    ) {
      t.skip('This host does not permit creating a hard-link fixture.')
      return
    }
    throw error
  }

  const reportedLinkCount = (await fs.lstat(join(fixture.root, 'read-hard-link.txt'))).nlink
  if (reportedLinkCount === 0 || reportedLinkCount === 0n) {
    t.skip('This filesystem does not report hard-link counts.')
    return
  }
  assert.ok(
    typeof reportedLinkCount === 'bigint' ? reportedLinkCount > 1n : reportedLinkCount > 1
  )

  await assertHardLinkRejected(
    fixture.service.readFile(
      { workspaceToken: fixture.workspaceToken, relativePath: 'read-hard-link.txt' },
      OWNER_ID
    ),
    fixture.root,
    outside,
    'read-hard-link.txt'
  )
  await assertHardLinkRejected(
    fixture.service.searchFiles(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: 'search-hard-link.txt',
        query: 'marker',
        caseSensitive: true
      },
      OWNER_ID
    ),
    fixture.root,
    outside,
    'search-hard-link.txt'
  )
  await assertHardLinkRejected(
    fixture.service.writeFile(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: 'write-hard-link.txt',
        content: 'write modified\n',
        expectedRevision: writeRevision
      },
      OWNER_ID
    ),
    fixture.root,
    outside,
    'write-hard-link.txt'
  )
  await assertHardLinkRejected(
    fixture.service.replaceInFile(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: 'replace-hard-link.txt',
        oldText: 'old',
        newText: 'new',
        expectedRevision: replaceRevision
      },
      OWNER_ID
    ),
    fixture.root,
    outside,
    'replace-hard-link.txt'
  )

  assert.equal(await fs.readFile(join(outside, 'write-hard-link.txt'), 'utf8'), 'write original\n')
  assert.equal(
    await fs.readFile(join(outside, 'replace-hard-link.txt'), 'utf8'),
    'replace old value\n'
  )
})

test('list_directory accepts only safe relative directories and propagates cancellation', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  await fs.writeFile(join(fixture.root, 'plain.txt'), 'plain', 'utf8')
  await fs.mkdir(join(fixture.root, '.ssh'))

  for (const relativePath of [
    '../outside',
    './nested',
    'C:\\private',
    '\\\\server\\share',
    '\\\\?\\C:\\private',
    '\\\\.\\PhysicalDrive0',
    '/etc',
    'folder:stream',
    'CON',
    'trailing.',
    'trailing '
  ]) {
    await assertWorkspaceError(
      fixture.service.listDirectory(
        { workspaceToken: fixture.workspaceToken, relativePath },
        OWNER_ID
      ),
      'invalid_relative_path'
    )
  }

  await assertWorkspaceError(
    fixture.service.listDirectory(
      { workspaceToken: fixture.workspaceToken, relativePath: 'plain.txt' },
      OWNER_ID
    ),
    'path_not_directory'
  )
  await assertWorkspaceError(
    fixture.service.listDirectory(
      { workspaceToken: fixture.workspaceToken, relativePath: '.ssh' },
      OWNER_ID
    ),
    'sensitive_path'
  )
  await assertWorkspaceError(
    fixture.service.listDirectory(
      { workspaceToken: fixture.workspaceToken, relativePath: '.' },
      OWNER_ID + 1
    ),
    'workspace_unavailable'
  )

  const controller = new AbortController()
  controller.abort()
  await assertWorkspaceError(
    fixture.service.listDirectory(
      { workspaceToken: fixture.workspaceToken, relativePath: '.' },
      OWNER_ID,
      { signal: controller.signal }
    ),
    'cancelled'
  )

  const midOperationController = new AbortController()
  const originalRealpath = fs.realpath
  fs.realpath = (async (...args: Parameters<typeof fs.realpath>) => {
    const result = await originalRealpath(...args)
    if (String(args[0]).toLowerCase() === join(fixture.root, 'plain.txt').toLowerCase()) {
      midOperationController.abort()
    }
    return result
  }) as typeof fs.realpath
  t.after(() => {
    fs.realpath = originalRealpath
  })
  await assertWorkspaceError(
    fixture.service.listDirectory(
      { workspaceToken: fixture.workspaceToken, relativePath: '.' },
      OWNER_ID,
      { signal: midOperationController.signal }
    ),
    'cancelled'
  )
})

test('list_directory returns one stable layer and hides sensitive, protected, and reparse entries', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  await fs.writeFile(join(fixture.root, 'z-last.txt'), 'z', 'utf8')
  await fs.writeFile(join(fixture.root, 'a-first.txt'), 'a', 'utf8')
  await fs.mkdir(join(fixture.root, 'src'))
  await fs.writeFile(join(fixture.root, 'src', 'nested.ts'), 'nested', 'utf8')
  await fs.writeFile(join(fixture.root, '.env.local'), 'secret', 'utf8')
  await fs.writeFile(join(fixture.root, 'auth.json'), 'secret', 'utf8')
  await fs.mkdir(join(fixture.root, '.ssh'))
  await fs.writeFile(join(fixture.root, '.ssh', 'id_ed25519'), 'secret', 'utf8')
  const filenameSecret = 'directory-filename-secret-marker'
  await fs.writeFile(join(fixture.root, `token=${filenameSecret}.txt`), 'secret', 'utf8')
  const protectedRoot = join(fixture.root, 'private-runtime')
  await fs.mkdir(protectedRoot)
  await fs.writeFile(join(protectedRoot, 'private.txt'), 'private', 'utf8')

  const outside = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-list-outside-'))
  t.after(() => fs.rm(outside, { recursive: true, force: true }))
  const linkPath = join(fixture.root, 'escape-link')
  let linkCreated = false
  try {
    await fs.symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    linkCreated = true
  } catch (error) {
    if (!isNodeErrorCode(error, 'EPERM') && !isNodeErrorCode(error, 'EACCES')) throw error
  }

  const service = new WorkspaceToolService({
    selections: fixture.selections,
    protectedAbsoluteRoots: [protectedRoot]
  })
  const result = await service.listDirectory(
    { workspaceToken: fixture.workspaceToken, relativePath: '.' },
    OWNER_ID
  )
  assert.deepEqual(result.entries, [
    { relativePath: 'a-first.txt', kind: 'file' },
    { relativePath: 'src', kind: 'directory' },
    { relativePath: 'z-last.txt', kind: 'file' }
  ])
  assert.equal(result.truncated, false)
  assert.deepEqual(Object.keys(result).sort(), ['entries', 'truncated'])
  assert.ok(result.entries.every((entry) => {
    assert.deepEqual(Object.keys(entry).sort(), ['kind', 'relativePath'])
    return entry.kind === 'file' || entry.kind === 'directory'
  }))

  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes(fixture.root), false)
  assert.equal(serialized.includes(filenameSecret), false)
  assert.equal(serialized.includes('.env'), false)
  assert.equal(serialized.includes('.ssh'), false)
  assert.equal(serialized.includes('auth.json'), false)
  assert.equal(serialized.includes('private-runtime'), false)
  assert.equal(serialized.includes('escape-link'), false)
  assert.doesNotMatch(serialized, /(?:size|mtime|ctime|birthtime)/u)

  const nested = await service.listDirectory(
    { workspaceToken: fixture.workspaceToken, relativePath: 'src' },
    OWNER_ID
  )
  assert.deepEqual(nested.entries, [{ relativePath: 'src/nested.ts', kind: 'file' }])

  if (linkCreated) {
    await assertWorkspaceError(
      service.listDirectory(
        { workspaceToken: fixture.workspaceToken, relativePath: 'escape-link' },
        OWNER_ID
      ),
      'reparse_point_rejected'
    )
  }
})

test('list_directory enforces stable entry and serialized-character limits', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  for (let index = 9; index >= 0; index -= 1) {
    await fs.writeFile(
      join(fixture.root, `file-${String(index).padStart(2, '0')}-with-a-bounded-name.txt`),
      'x',
      'utf8'
    )
  }

  const entryBoundService = new WorkspaceToolService({
    selections: fixture.selections,
    maxDirectoryEntries: 3,
    maxDirectoryResultCharacters: 1_024
  })
  const entryBound = await entryBoundService.listDirectory(
    { workspaceToken: fixture.workspaceToken, relativePath: '.' },
    OWNER_ID
  )
  assert.deepEqual(
    entryBound.entries.map((entry) => entry.relativePath),
    [
      'file-00-with-a-bounded-name.txt',
      'file-01-with-a-bounded-name.txt',
      'file-02-with-a-bounded-name.txt'
    ]
  )
  assert.equal(entryBound.truncated, true)

  const characterBoundService = new WorkspaceToolService({
    selections: fixture.selections,
    maxDirectoryEntries: 20,
    maxDirectoryResultCharacters: 128
  })
  const characterBound = await characterBoundService.listDirectory(
    { workspaceToken: fixture.workspaceToken, relativePath: '.' },
    OWNER_ID
  )
  assert.ok(JSON.stringify(characterBound).length <= 128)
  assert.ok(characterBound.entries.length < 10)
  assert.equal(characterBound.truncated, true)
  assert.deepEqual(
    characterBound.entries.map((entry) => entry.relativePath),
    [...characterBound.entries.map((entry) => entry.relativePath)].sort()
  )
})

test('write_file creates and atomically replaces text with revision conflict protection', async (t) => {
  const fixture = await createWorkspaceFixture(t)

  const created = await fixture.service.writeFile(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: 'src/new-file.ts',
      content: 'export const value = 1\n'
    },
    OWNER_ID
  ).catch(async (error) => {
    if (error instanceof WorkspaceToolError && error.code === 'path_not_found') {
      await fs.mkdir(join(fixture.root, 'src'))
      return await fixture.service.writeFile(
        {
          workspaceToken: fixture.workspaceToken,
          relativePath: 'src/new-file.ts',
          content: 'export const value = 1\n'
        },
        OWNER_ID
      )
    }
    throw error
  })
  assert.equal(await fs.readFile(join(fixture.root, 'src', 'new-file.ts'), 'utf8'), 'export const value = 1\n')
  assert.match(created.revision, /^[a-f0-9]{64}$/)
  assert.equal((await fs.readdir(join(fixture.root, 'src'))).some((name) => name.startsWith('.ai-terminal-write-')), false)

  await assertWorkspaceError(
    fixture.service.writeFile(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: 'src/new-file.ts',
        content: 'unsafe overwrite\n'
      },
      OWNER_ID
    ),
    'write_conflict'
  )

  const updated = await fixture.service.writeFile(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: 'src/new-file.ts',
      content: 'export const value = 2\n',
      expectedRevision: created.revision
    },
    OWNER_ID
  )
  assert.equal(await fs.readFile(join(fixture.root, 'src', 'new-file.ts'), 'utf8'), 'export const value = 2\n')
  assert.notEqual(updated.revision, created.revision)

  await assertWorkspaceError(
    fixture.service.writeFile(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: 'src/new-file.ts',
        content: 'stale update\n',
        expectedRevision: created.revision
      },
      OWNER_ID
    ),
    'write_conflict'
  )
  assert.equal(await fs.readFile(join(fixture.root, 'src', 'new-file.ts'), 'utf8'), 'export const value = 2\n')
})

test('write_file blocks control, credential, traversal, owner, and cancelled requests', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  for (const relativePath of [
    '../outside.txt',
    '.git/config',
    '.codex/config.toml',
    '.agents/private.txt',
    'node_modules/package/index.js',
    'AGENTS.md',
    '.env.local',
    'keys/private.pem'
  ]) {
    await assert.rejects(
      fixture.service.writeFile(
        { workspaceToken: fixture.workspaceToken, relativePath, content: 'blocked' },
        OWNER_ID
      ),
      (error: unknown) => {
        assert.ok(error instanceof WorkspaceToolError)
        assert.ok(['invalid_relative_path', 'write_not_allowed'].includes(error.code))
        assert.equal(error.message.includes(relativePath), false)
        return true
      }
    )
  }

  await assertWorkspaceError(
    fixture.service.writeFile(
      { workspaceToken: fixture.workspaceToken, relativePath: 'owner.txt', content: 'blocked' },
      OWNER_ID + 1
    ),
    'workspace_unavailable'
  )
  const controller = new AbortController()
  controller.abort()
  await assertWorkspaceError(
    fixture.service.writeFile(
      { workspaceToken: fixture.workspaceToken, relativePath: 'cancelled.txt', content: 'blocked' },
      OWNER_ID,
      { signal: controller.signal }
    ),
    'cancelled'
  )
  assert.equal(await pathExists(join(fixture.root, 'cancelled.txt')), false)
})

test('write_file cancellation during final validation preserves the target and removes its temporary file', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  const targetPath = join(fixture.root, 'cancel-during-validation.txt')
  await fs.writeFile(targetPath, 'original\n', 'utf8')
  const original = await fixture.service.readFile(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: 'cancel-during-validation.txt'
    },
    OWNER_ID
  )

  const controller = new AbortController()
  const originalRealpath = fs.realpath
  let workspaceRealpathCalls = 0
  fs.realpath = (async (...args: Parameters<typeof fs.realpath>) => {
    const result = await originalRealpath(...args)
    if (
      typeof result === 'string' &&
      result.toLowerCase() === fixture.root.toLowerCase() &&
      ++workspaceRealpathCalls === 3
    ) {
      controller.abort()
    }
    return result
  }) as typeof fs.realpath
  t.after(() => {
    fs.realpath = originalRealpath
  })

  await assertWorkspaceError(
    fixture.service.writeFile(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: 'cancel-during-validation.txt',
        content: 'must not commit\n',
        expectedRevision: original.revision
      },
      OWNER_ID,
      { signal: controller.signal }
    ),
    'cancelled'
  )

  assert.equal(await fs.readFile(targetPath, 'utf8'), 'original\n')
  assert.equal(
    (await fs.readdir(fixture.root)).some((name) => name.startsWith('.ai-terminal-write-')),
    false
  )
})

test('write_file cancellation does not wait for an earlier write holding the same path lock', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  const originalRename = fs.rename
  const renameStarted = deferred<void>()
  const allowRename = deferred<void>()
  let intercepted = false
  fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
    if (!intercepted) {
      intercepted = true
      renameStarted.resolve()
      await allowRename.promise
    }
    return await originalRename(...args)
  }) as typeof fs.rename
  t.after(() => {
    fs.rename = originalRename
    allowRename.resolve()
  })

  const firstWrite = fixture.service.writeFile(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: 'queued-cancel.txt',
      content: 'first\n'
    },
    OWNER_ID
  )
  await renameStarted.promise

  const controller = new AbortController()
  const queuedWrite = fixture.service.writeFile(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: 'queued-cancel.txt',
      content: 'second\n'
    },
    OWNER_ID,
    { signal: controller.signal }
  )
  controller.abort()

  try {
    await completesWithin(assertWorkspaceError(queuedWrite, 'cancelled'), 1_000)
  } finally {
    allowRename.resolve()
  }
  await firstWrite

  assert.equal(await fs.readFile(join(fixture.root, 'queued-cancel.txt'), 'utf8'), 'first\n')
  assert.equal(
    (await fs.readdir(fixture.root)).some((name) => name.startsWith('.ai-terminal-write-')),
    false
  )
})

test('write_file flushes before rename and reports success once rename has committed', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  const controller = new AbortController()
  const originalOpen = fs.open
  const originalRename = fs.rename
  let temporaryFileSynced = false

  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args)
    if (String(args[0]).includes('.ai-terminal-write-') && args[1] === 'wx') {
      const originalSync = handle.sync.bind(handle)
      handle.sync = async (): Promise<void> => {
        await originalSync()
        temporaryFileSynced = true
      }
    }
    return handle
  }) as typeof fs.open
  fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
    assert.equal(temporaryFileSynced, true)
    await originalRename(...args)
    controller.abort()
  }) as typeof fs.rename
  t.after(() => {
    fs.open = originalOpen
    fs.rename = originalRename
  })

  const result = await fixture.service.writeFile(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: 'committed.txt',
      content: 'committed\n'
    },
    OWNER_ID,
    { signal: controller.signal }
  )

  assert.equal(controller.signal.aborted, true)
  assert.equal(result.content, 'committed\n')
  assert.equal(await fs.readFile(join(fixture.root, 'committed.txt'), 'utf8'), 'committed\n')
  assert.equal(
    (await fs.readdir(fixture.root)).some((name) => name.startsWith('.ai-terminal-write-')),
    false
  )
})

test('concurrent write_file compare-and-swap permits only one replacement', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  await fs.writeFile(join(fixture.root, 'shared.txt'), 'initial\n', 'utf8')
  const original = await fixture.service.readFile(
    { workspaceToken: fixture.workspaceToken, relativePath: 'shared.txt' },
    OWNER_ID
  )

  const writes = await Promise.allSettled([
    fixture.service.writeFile(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: 'shared.txt',
        content: 'first\n',
        expectedRevision: original.revision
      },
      OWNER_ID
    ),
    fixture.service.writeFile(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: 'shared.txt',
        content: 'second\n',
        expectedRevision: original.revision
      },
      OWNER_ID
    )
  ])
  assert.equal(writes.filter((result) => result.status === 'fulfilled').length, 1)
  const rejected = writes.find((result) => result.status === 'rejected')
  assert.ok(rejected && rejected.status === 'rejected')
  assert.ok(rejected.reason instanceof WorkspaceToolError)
  assert.equal(rejected.reason.code, 'write_conflict')
  assert.match(await fs.readFile(join(fixture.root, 'shared.txt'), 'utf8'), /^(?:first|second)\n$/)
})

test('search_files performs bounded literal search with stable redacted previews', async (t) => {
  const fixture = await createWorkspaceFixture(t, {
    maxSearchResults: 8,
    maxSearchSnippetCharacters: 80
  })
  await fs.mkdir(join(fixture.root, 'src'))
  await fs.writeFile(
    join(fixture.root, 'src', 'z-last.ts'),
    'before NEEDLE after\nsecond needle\n',
    'utf8'
  )
  await fs.writeFile(
    join(fixture.root, 'a-first.ts'),
    'api_key=search-preview-secret\nneedle here\n',
    'utf8'
  )
  await fs.writeFile(join(fixture.root, '.env.local'), 'needle secret\n', 'utf8')
  await fs.mkdir(join(fixture.root, '.git'))
  await fs.writeFile(join(fixture.root, '.git', 'config'), 'needle protected\n', 'utf8')
  await fs.writeFile(join(fixture.root, 'binary.dat'), Buffer.from([0, 1, 2, 3]))

  const result = await fixture.service.searchFiles(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: '.',
      query: 'needle',
      caseSensitive: false
    },
    OWNER_ID
  )
  assert.deepEqual(
    result.matches.map(({ relativePath, line, column }) => ({ relativePath, line, column })),
    [
      { relativePath: 'a-first.ts', line: 2, column: 1 },
      { relativePath: 'src/z-last.ts', line: 1, column: 8 },
      { relativePath: 'src/z-last.ts', line: 2, column: 8 }
    ]
  )
  assert.equal(result.truncated, false)
  assert.ok(result.matches.every((match) => match.preview.length <= 80))
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes(fixture.root), false)
  assert.equal(serialized.includes('search-preview-secret'), false)
  assert.equal(serialized.includes('.env.local'), false)
  assert.equal(serialized.includes('.git'), false)

  const bounded = await new WorkspaceToolService({
    selections: fixture.selections,
    maxSearchResults: 1
  }).searchFiles(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: '.',
      query: 'needle',
      caseSensitive: false
    },
    OWNER_ID
  )
  assert.equal(bounded.matches.length, 1)
  assert.equal(bounded.truncated, true)

  await assertWorkspaceError(
    fixture.service.searchFiles(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: '.',
        query: 'needle',
        caseSensitive: true
      },
      OWNER_ID + 1
    ),
    'workspace_unavailable'
  )
  const controller = new AbortController()
  controller.abort()
  await assertWorkspaceError(
    fixture.service.searchFiles(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: '.',
        query: 'needle',
        caseSensitive: false
      },
      OWNER_ID,
      { signal: controller.signal }
    ),
    'cancelled'
  )
})

test('replace_in_file requires one literal match and atomically commits a revisioned result', async (t) => {
  const fixture = await createWorkspaceFixture(t)
  const targetPath = join(fixture.root, 'replace.txt')
  await fs.writeFile(targetPath, 'prefix old suffix\n', 'utf8')
  const original = await fixture.service.readFile(
    { workspaceToken: fixture.workspaceToken, relativePath: 'replace.txt' },
    OWNER_ID
  )

  const result = await fixture.service.replaceInFile(
    {
      workspaceToken: fixture.workspaceToken,
      relativePath: 'replace.txt',
      oldText: 'old',
      newText: 'new',
      expectedRevision: original.revision
    },
    OWNER_ID
  )
  assert.deepEqual(Object.keys(result).sort(), ['relativePath', 'replacements', 'revision'])
  assert.equal(result.relativePath, 'replace.txt')
  assert.equal(result.replacements, 1)
  assert.match(result.revision, /^[a-f0-9]{64}$/)
  assert.equal('content' in result, false)
  assert.equal(await fs.readFile(targetPath, 'utf8'), 'prefix new suffix\n')
  assert.equal(
    (await fs.readdir(fixture.root)).some((name) => name.startsWith('.ai-terminal-write-')),
    false
  )

  for (const oldText of ['old', 'new']) {
    await assertWorkspaceError(
      fixture.service.replaceInFile(
        {
          workspaceToken: fixture.workspaceToken,
          relativePath: 'replace.txt',
          oldText,
          newText: 'other',
          expectedRevision: original.revision
        },
        OWNER_ID
      ),
      'write_conflict'
    )
  }

  const duplicatePath = join(fixture.root, 'duplicate.txt')
  await fs.writeFile(duplicatePath, 'same same\n', 'utf8')
  const duplicate = await fixture.service.readFile(
    { workspaceToken: fixture.workspaceToken, relativePath: 'duplicate.txt' },
    OWNER_ID
  )
  await assertWorkspaceError(
    fixture.service.replaceInFile(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: 'duplicate.txt',
        oldText: 'same',
        newText: 'changed',
        expectedRevision: duplicate.revision
      },
      OWNER_ID
    ),
    'write_conflict'
  )
  assert.equal(await fs.readFile(duplicatePath, 'utf8'), 'same same\n')

  await assertWorkspaceError(
    fixture.service.replaceInFile(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: 'replace.txt',
        oldText: 'new',
        newText: 'blocked',
        expectedRevision: original.revision
      },
      OWNER_ID + 1
    ),
    'workspace_unavailable'
  )
  await assertWorkspaceError(
    fixture.service.replaceInFile(
      {
        workspaceToken: fixture.workspaceToken,
        relativePath: '.env',
        oldText: 'old',
        newText: 'blocked',
        expectedRevision: original.revision
      },
      OWNER_ID
    ),
    'write_not_allowed'
  )
})

test('git.summary returns relative bounded status and redacts sensitive filenames', async (t) => {
  if (!(await gitIsAvailable())) {
    t.skip('Git is not installed on this host.')
    return
  }
  const fixture = await createWorkspaceFixture(t)
  await initializeRepository(fixture.root)

  await fs.writeFile(join(fixture.root, 'tracked.txt'), 'one changed\ntwo\nthree\n', 'utf8')
  await fs.writeFile(join(fixture.root, 'untracked.txt'), 'new\n', 'utf8')
  const filenameSecret = 'git-filename-secret-marker'
  await fs.writeFile(join(fixture.root, `token=${filenameSecret}.txt`), 'new\n', 'utf8')

  const summary = await fixture.service.gitSummary(
    { workspaceToken: fixture.workspaceToken },
    OWNER_ID
  )
  const serialized = JSON.stringify(summary)
  assert.equal(serialized.includes(fixture.root), false)
  assert.equal(serialized.includes(filenameSecret), false)
  assert.ok(summary.files.some((file) => file.relativePath === 'tracked.txt' && file.status === 'modified'))
  assert.ok(summary.files.some((file) => file.relativePath === 'untracked.txt' && file.status === 'untracked'))
  assert.ok(summary.additions >= 2)
  assert.ok(summary.deletions >= 1)
  assert.ok(summary.files.every((file) => !file.relativePath.includes(':\\')))
})

test('git.diff returns only bounded redacted patches for safe tracked paths', async (t) => {
  if (!(await gitIsAvailable())) {
    t.skip('Git is not installed on this host.')
    return
  }
  const fixture = await createWorkspaceFixture(t)
  await initializeRepository(fixture.root)
  await fs.writeFile(join(fixture.root, '.env.local'), 'TOKEN=baseline\n', 'utf8')
  await runGit(fixture.root, ['add', '--', '.env.local'])
  await runGit(fixture.root, ['commit', '-m', 'sensitive fixture'])

  const secret = 'review-diff-secret-marker'
  await fs.writeFile(join(fixture.root, 'tracked.txt'), `one staged\napi_key=${secret}\n`, 'utf8')
  await runGit(fixture.root, ['add', '--', 'tracked.txt'])
  await fs.appendFile(join(fixture.root, 'tracked.txt'), 'unstaged line\n', 'utf8')
  await fs.writeFile(join(fixture.root, '.env.local'), `TOKEN=${secret}\n`, 'utf8')
  await fs.writeFile(join(fixture.root, 'untracked.ts'), 'export const value = 1\n', 'utf8')

  const result = await fixture.service.gitDiff(
    { workspaceToken: fixture.workspaceToken },
    OWNER_ID
  )
  assert.deepEqual(result.files, ['tracked.txt'])
  assert.deepEqual(result.untrackedFiles, ['untracked.ts'])
  assert.equal(result.truncated, false)
  assert.match(result.patch, /## Unstaged changes/u)
  assert.match(result.patch, /## Staged changes/u)
  assert.match(result.patch, /tracked\.txt/u)
  assert.match(result.patch, /unstaged line/u)
  assert.match(result.patch, /<redacted>/u)
  assert.equal(result.patch.includes(secret), false)
  assert.equal(result.patch.includes('.env.local'), false)
  assert.equal(JSON.stringify(result).includes(fixture.root), false)

  await assertWorkspaceError(
    fixture.service.gitDiff({ workspaceToken: fixture.workspaceToken }, OWNER_ID + 1),
    'workspace_unavailable'
  )
  const controller = new AbortController()
  controller.abort()
  await assertWorkspaceError(
    fixture.service.gitDiff(
      { workspaceToken: fixture.workspaceToken },
      OWNER_ID,
      { signal: controller.signal }
    ),
    'cancelled'
  )
})

test('git.diff treats bracket pathspec characters literally and cannot pull a sensitive neighbor', async (t) => {
  if (!(await gitIsAvailable())) {
    t.skip('Git is not installed on this host.')
    return
  }
  const fixture = await createWorkspaceFixture(t)
  await initializeRepository(fixture.root)
  await fs.writeFile(join(fixture.root, '.env.local'), 'TOKEN=baseline\n', 'utf8')
  await fs.writeFile(join(fixture.root, '[.]env.local'), 'safe baseline\n', 'utf8')
  await runGit(fixture.root, ['add', '--', '.env.local', '[.]env.local'])
  await runGit(fixture.root, ['commit', '-m', 'literal pathspec fixture'])

  const secret = 'literal-pathspec-sensitive-marker'
  await fs.writeFile(join(fixture.root, '.env.local'), `TOKEN=${secret}\n`, 'utf8')
  await fs.writeFile(join(fixture.root, '[.]env.local'), 'safe staged change\n', 'utf8')
  await runGit(fixture.root, ['add', '--', '[.]env.local'])

  const result = await fixture.service.gitDiff(
    { workspaceToken: fixture.workspaceToken },
    OWNER_ID
  )
  assert.deepEqual(result.files, ['[.]env.local'])
  assert.match(result.patch, /\[\.\]env\.local/u)
  assert.equal(result.patch.includes(secret), false)
  assert.equal(result.patch.includes('TOKEN='), false)
})

test('git tools reject local worktree overrides, executable filters, and filter attributes', async (t) => {
  if (!(await gitIsAvailable())) {
    t.skip('Git is not installed on this host.')
    return
  }

  for (const attack of ['core-worktree', 'filter-config', 'filter-attributes'] as const) {
    const fixture = await createWorkspaceFixture(t)
    await initializeRepository(fixture.root)
    const marker = join(fixture.root, `filter-marker-${attack}.txt`)
    if (attack === 'core-worktree') {
      const outside = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-git-worktree-outside-'))
      t.after(() => fs.rm(outside, { recursive: true, force: true }))
      await runGit(fixture.root, ['config', 'core.worktree', outside])
    } else if (attack === 'filter-config') {
      const markerForShell = marker.replace(/\\/gu, '/')
      await runGit(fixture.root, [
        'config',
        'filter.review-attack.clean',
        `echo filter-ran > "${markerForShell}" && cat`
      ])
    } else {
      await fs.writeFile(join(fixture.root, '.gitattributes'), '*.txt filter=review-attack\n', 'utf8')
    }
    await fs.appendFile(join(fixture.root, 'tracked.txt'), 'changed\n', 'utf8')

    await assertWorkspaceError(
      fixture.service.gitDiff({ workspaceToken: fixture.workspaceToken }, OWNER_ID),
      'git_unavailable'
    )
    await assert.rejects(fs.access(marker))
  }
})

test('git.diff rejects tracked hard links and omits local Agent control directories', async (t) => {
  if (!(await gitIsAvailable())) {
    t.skip('Git is not installed on this host.')
    return
  }
  const fixture = await createWorkspaceFixture(t)
  await initializeRepository(fixture.root)
  await fs.mkdir(join(fixture.root, '.codex'), { recursive: true })
  await fs.mkdir(join(fixture.root, '.agents', 'skills'), { recursive: true })
  await fs.writeFile(join(fixture.root, '.codex', 'instructions.md'), 'private control text\n', 'utf8')
  await fs.writeFile(join(fixture.root, '.agents', 'skills', 'local.md'), 'private skill text\n', 'utf8')
  await fs.writeFile(join(fixture.root, 'visible-untracked.txt'), 'visible name only\n', 'utf8')

  const safeResult = await fixture.service.gitDiff(
    { workspaceToken: fixture.workspaceToken },
    OWNER_ID
  )
  assert.deepEqual(safeResult.untrackedFiles, ['visible-untracked.txt'])
  assert.doesNotMatch(JSON.stringify(safeResult), /\.codex|\.agents|private control|private skill/u)

  const outside = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-git-hard-link-outside-'))
  t.after(() => fs.rm(outside, { recursive: true, force: true }))
  try {
    await fs.link(join(fixture.root, 'tracked.txt'), join(outside, 'tracked-copy.txt'))
  } catch (error) {
    if (isLinkPrivilegeError(error)) {
      t.skip('This host does not permit creating a hard-link fixture.')
      return
    }
    throw error
  }
  const reportedLinkCount = (await fs.lstat(join(fixture.root, 'tracked.txt'))).nlink
  if (reportedLinkCount <= 1) {
    t.skip('This filesystem does not report hard-link counts.')
    return
  }
  await assertWorkspaceError(
    fixture.service.gitDiff({ workspaceToken: fixture.workspaceToken }, OWNER_ID),
    'hard_link_rejected'
  )
})

test('git.diff excludes an exact sensitive-file rename from staged review content', async (t) => {
  if (!(await gitIsAvailable())) {
    t.skip('Git is not installed on this host.')
    return
  }
  const fixture = await createWorkspaceFixture(t)
  await initializeRepository(fixture.root)
  const secret = 'sensitive-rename-review-marker'
  await fs.writeFile(join(fixture.root, '.env.local'), `PRIVATE_VALUE=${secret}\n`, 'utf8')
  await runGit(fixture.root, ['add', '--', '.env.local'])
  await runGit(fixture.root, ['commit', '-m', 'sensitive rename baseline'])
  await fs.rename(join(fixture.root, '.env.local'), join(fixture.root, 'notes.txt'))
  await runGit(fixture.root, ['add', '--', '.env.local', 'notes.txt'])

  const result = await fixture.service.gitDiff(
    { workspaceToken: fixture.workspaceToken },
    OWNER_ID
  )
  assert.equal(result.files.includes('notes.txt'), false)
  assert.equal(JSON.stringify(result).includes(secret), false)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_VALUE/u)
})

test('git.diff rejects a tracked parent replaced by a junction or symlink', async (t) => {
  if (!(await gitIsAvailable())) {
    t.skip('Git is not installed on this host.')
    return
  }
  const fixture = await createWorkspaceFixture(t)
  await initializeRepository(fixture.root)
  const trackedDirectory = join(fixture.root, 'linked')
  await fs.mkdir(trackedDirectory)
  await fs.writeFile(join(trackedDirectory, 'inside.txt'), 'inside baseline\n', 'utf8')
  await runGit(fixture.root, ['add', '--', 'linked/inside.txt'])
  await runGit(fixture.root, ['commit', '-m', 'junction baseline'])

  const outside = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-git-junction-outside-'))
  t.after(() => fs.rm(outside, { recursive: true, force: true }))
  await fs.writeFile(join(outside, 'inside.txt'), 'outside private marker\n', 'utf8')
  await fs.rm(trackedDirectory, { recursive: true, force: true })
  try {
    await fs.symlink(outside, trackedDirectory, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (isLinkPrivilegeError(error)) {
      t.skip('This host does not permit creating a junction or symlink fixture.')
      return
    }
    throw error
  }

  await assertWorkspaceError(
    fixture.service.gitDiff({ workspaceToken: fixture.workspaceToken }, OWNER_ID),
    'reparse_point_rejected'
  )
})

test('git.summary terminates and fails closed when output exceeds its cap', async (t) => {
  if (!(await gitIsAvailable())) {
    t.skip('Git is not installed on this host.')
    return
  }
  const fixture = await createWorkspaceFixture(t, { maxGitOutputBytes: 128 })
  await initializeRepository(fixture.root)
  for (let index = 0; index < 40; index += 1) {
    await fs.writeFile(
      join(fixture.root, `untracked-file-with-a-long-name-${String(index).padStart(3, '0')}.txt`),
      'x',
      'utf8'
    )
  }

  await assertWorkspaceError(
    fixture.service.gitSummary({ workspaceToken: fixture.workspaceToken }, OWNER_ID),
    'git_output_too_large'
  )
})

interface FixtureOptions {
  maxFileBytes?: number
  maxResultCharacters?: number
  maxGitOutputBytes?: number
  maxDirectoryEntries?: number
  maxDirectoryResultCharacters?: number
  maxSearchResults?: number
  maxSearchFiles?: number
  maxSearchResultCharacters?: number
  maxSearchSnippetCharacters?: number
}

async function createWorkspaceFixture(t: TestContext, options: FixtureOptions = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-workspace-tool-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const selections = new SelectionTokenStore()
  const selection = selections.issueWorkspace(root, OWNER_ID)
  const service = new WorkspaceToolService({ selections, ...options })
  return { root, selections, service, workspaceToken: selection.workspaceToken }
}

async function initializeRepository(root: string): Promise<void> {
  await runGit(root, ['init'])
  await runGit(root, ['config', 'user.name', 'AI Terminal Test'])
  await runGit(root, ['config', 'user.email', 'test@example.invalid'])
  await fs.writeFile(join(root, 'tracked.txt'), 'one\ntwo\n', 'utf8')
  await runGit(root, ['add', '--', 'tracked.txt'])
  await runGit(root, ['commit', '-m', 'initial'])
}

async function gitIsAvailable(): Promise<boolean> {
  try {
    await runGit(process.cwd(), ['--version'])
    return true
  } catch {
    return false
  }
}

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never'
      }
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error('Git fixture command failed.'))
    })
  })
}

async function assertWorkspaceError(
  promise: Promise<unknown>,
  expectedCode: WorkspaceToolError['code']
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof WorkspaceToolError)
    assert.equal(error.code, expectedCode)
    assert.equal(error.stack, `WorkspaceToolError: ${error.message}`)
    return true
  })
}

async function assertHardLinkRejected(
  promise: Promise<unknown>,
  ...forbiddenDetails: readonly string[]
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof WorkspaceToolError)
    assert.equal(error.code, 'hard_link_rejected')
    assert.equal(error.stack, `WorkspaceToolError: ${error.message}`)
    const exposedError = `${error.message}\n${error.stack}`
    for (const detail of forbiddenDetails) {
      assert.equal(exposedError.includes(detail), false)
    }
    return true
  })
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: (value?: T): void => resolvePromise(value as T)
  }
}

async function completesWithin(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Operation did not cancel promptly.')), timeoutMs)
      })
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function isNodeErrorCode(value: unknown, code: string): boolean {
  return value instanceof Error && 'code' in value && value.code === code
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path)
    return true
  } catch {
    return false
  }
}
