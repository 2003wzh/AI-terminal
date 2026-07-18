import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  SelectionTokenError,
  SelectionTokenStore
} from '../../src/main/services/selection-token-store.ts'

test('workspace capabilities are opaque, owner-bound, canonical, and expire in memory', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-selection-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  let now = 10_000
  const store = new SelectionTokenStore({ now: () => now, tokenLifetimeMs: 1_000 })
  const selection = store.issueWorkspace(root, 17)

  assert.match(selection.workspaceToken, /^ws_[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(Object.keys(selection).sort(), ['displayName', 'workspaceToken'])
  assert.equal(JSON.stringify(selection).includes(root), false)
  assert.equal(await store.resolveWorkspace(selection.workspaceToken, 18), null)

  const resolved = await store.resolveWorkspace(selection.workspaceToken, 17)
  assert.ok(resolved)
  assert.equal(resolved.absolutePath, await fs.realpath(root))
  assert.equal(resolved.ownerWebContentsId, 17)
  const exactStats = await fs.lstat(resolved.absolutePath, { bigint: true })
  assert.equal(resolved.device, exactStats.dev.toString(10))
  assert.equal(resolved.inode, exactStats.ino.toString(10))
  assert.equal(await store.resolve(selection.workspaceToken, 'workspace', 17), resolved.absolutePath)

  now = 11_000
  assert.equal(await store.resolveWorkspace(selection.workspaceToken, 17), null)
  assert.equal(await store.resolve(selection.workspaceToken, 'workspace', 17), null)
})

test('invalid workspace selections fail closed without reflecting local paths', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-selection-invalid-'))
  const filePath = join(root, 'not-a-directory.txt')
  await fs.writeFile(filePath, 'text', 'utf8')
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const store = new SelectionTokenStore()
  const fileSelection = store.issueWorkspace(filePath, 3)
  assert.equal(await store.resolveWorkspace(fileSelection.workspaceToken, 3), null)

  assert.throws(
    () => store.issueWorkspace('relative-workspace', 3),
    (error: unknown) => {
      assert.ok(error instanceof SelectionTokenError)
      assert.equal(error.code, 'invalid_selection')
      assert.doesNotMatch(error.message, /relative-workspace/i)
      return true
    }
  )
  assert.throws(
    () => store.issueWorkspace(root, 0),
    (error: unknown) => {
      assert.ok(error instanceof SelectionTokenError)
      assert.equal(error.code, 'invalid_owner')
      assert.doesNotMatch(error.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      return true
    }
  )
})

test('relative attachment paths are rejected before any capability is issued', () => {
  const store = new SelectionTokenStore()
  assert.throws(
    () => store.issueAttachment('relative/private.txt', 1),
    (error: unknown) => error instanceof SelectionTokenError && error.code === 'invalid_selection'
  )
})

test('attachment selection and synchronous attachment resolution remain compatible', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-attachment-'))
  const filePath = join(root, 'diagram.png')
  await fs.writeFile(filePath, Buffer.from([1, 2, 3]))
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const store = new SelectionTokenStore()
  const selection = store.issueAttachment(filePath, 9)
  assert.match(selection.attachmentToken, /^[0-9a-f-]{36}$/i)
  assert.equal(selection.mediaKind, 'image')
  assert.equal(store.resolve(selection.attachmentToken, 'attachment', 9), filePath)
  assert.equal(store.resolve(selection.attachmentToken, 'attachment', 10), null)

  store.revokeOwner(9)
  assert.equal(store.resolve(selection.attachmentToken, 'attachment', 9), null)
})

test('attachment reservations are atomic, owner-bound, retryable, and one-shot', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-attachment-reservation-'))
  const firstPath = join(root, 'first.txt')
  const secondPath = join(root, 'second.txt')
  await fs.writeFile(firstPath, 'first', 'utf8')
  await fs.writeFile(secondPath, 'second', 'utf8')
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const store = new SelectionTokenStore()
  const first = store.issueAttachment(firstPath, 31)
  const second = store.issueAttachment(secondPath, 31)
  const tokens = [first.attachmentToken, second.attachmentToken]

  assert.equal(await store.reserveAttachments(tokens, 32), null)
  const reservation = await store.reserveAttachments(tokens, 31)
  assert.ok(reservation)
  assert.match(reservation.reservationToken, /^ar_[A-Za-z0-9_-]{43}$/)
  assert.equal(reservation.attachments.length, 2)
  assert.equal(store.resolve(first.attachmentToken, 'attachment', 31), null)
  assert.equal(await store.reserveAttachments(tokens, 31), null)
  assert.equal(store.commitAttachmentReservation(reservation.reservationToken, 32), false)
  assert.equal(store.rollbackAttachmentReservation(reservation.reservationToken, 32), false)

  assert.equal(store.rollbackAttachmentReservation(reservation.reservationToken, 31), true)
  assert.equal(store.rollbackAttachmentReservation(reservation.reservationToken, 31), false)
  assert.equal(store.resolve(first.attachmentToken, 'attachment', 31), firstPath)

  const retry = await store.reserveAttachments(tokens, 31)
  assert.ok(retry)
  assert.equal(store.commitAttachmentReservation(retry.reservationToken, 31), true)
  assert.equal(store.commitAttachmentReservation(retry.reservationToken, 31), false)
  assert.equal(store.rollbackAttachmentReservation(retry.reservationToken, 31), false)
  assert.equal(await store.reserveAttachments(tokens, 31), null)
  assert.equal(store.resolve(first.attachmentToken, 'attachment', 31), null)
  assert.equal(store.resolve(second.attachmentToken, 'attachment', 31), null)
})

test('attachment reservation expiry invalidates the whole capability without allowing commit', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-attachment-reservation-expiry-'))
  const filePath = join(root, 'expires.txt')
  await fs.writeFile(filePath, 'expires', 'utf8')
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  let now = 5_000
  const store = new SelectionTokenStore({ now: () => now, tokenLifetimeMs: 100 })
  const selected = store.issueAttachment(filePath, 44)
  const reservation = await store.reserveAttachments([selected.attachmentToken], 44)
  assert.ok(reservation)

  now = 5_100
  assert.equal(store.commitAttachmentReservation(reservation.reservationToken, 44), false)
  assert.equal(store.rollbackAttachmentReservation(reservation.reservationToken, 44), false)
  assert.equal(await store.reserveAttachments([selected.attachmentToken], 44), null)
})

test('attachment reservation batches are bounded without partially locking tokens', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'ai-terminal-attachment-reservation-bound-'))
  const filePath = join(root, 'bounded.txt')
  await fs.writeFile(filePath, 'bounded', 'utf8')
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const store = new SelectionTokenStore()
  const tokens = Array.from(
    { length: 17 },
    () => store.issueAttachment(filePath, 55).attachmentToken
  )
  assert.equal(await store.reserveAttachments(tokens, 55), null)

  const reservation = await store.reserveAttachments([tokens[0]!], 55)
  assert.ok(reservation)
  assert.equal(store.rollbackAttachmentReservation(reservation.reservationToken, 55), true)
})
