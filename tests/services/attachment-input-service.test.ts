import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  AttachmentInputError,
  AttachmentInputService
} from '../../src/main/services/attachment-input-service.ts'
import { SelectionTokenStore } from '../../src/main/services/selection-token-store.ts'

const OWNER = 17
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'ai-terminal-attachment-test-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function assertAttachmentError(error: unknown, code: AttachmentInputError['code']): boolean {
  assert.ok(error instanceof AttachmentInputError)
  assert.equal(error.code, code)
  assert.equal(error.stack, `AttachmentInputError: ${error.message}`)
  assert.doesNotMatch(error.message, /[A-Z]:\\|\/tmp\/|sk-|Bearer/i)
  return true
}

test('prepares redacted text with a generic remote name and consumes the owner-bound token once', async () => {
  await withTempDirectory(async (directory) => {
    const localName = 'customer-private-notes.txt'
    const localPath = join(directory, localName)
    const secret = 'sk-test-attachment-fixture'
    await writeFile(localPath, `Safe heading\nAuthorization: Bearer ${secret}\nD:\\private\\notes.txt\n`)
    const selections = new SelectionTokenStore()
    const selected = selections.issueAttachment(localPath, OWNER)
    const service = new AttachmentInputService({ selections })

    const prepared = await service.prepare([selected.attachmentToken], OWNER)
    assert.equal(prepared.count, 1)
    assert.equal(prepared.totalBytes > 0, true)
    assert.equal(prepared.parts[0]?.type, 'input_file')
    const part = prepared.parts[0]
    assert.ok(part?.type === 'input_file')
    assert.equal(part.filename, 'attachment-1.txt')
    const decoded = Buffer.from(part.file_data.slice(part.file_data.indexOf(',') + 1), 'base64').toString('utf8')
    assert.match(decoded, /Safe heading/)
    assert.match(decoded, /<redacted>/)
    assert.match(decoded, /<local-path>/)
    assert.doesNotMatch(JSON.stringify(prepared), new RegExp(localName, 'i'))
    assert.doesNotMatch(JSON.stringify(prepared), new RegExp(secret, 'i'))
    assert.doesNotMatch(JSON.stringify(prepared), /[A-Z]:\\|ai-terminal-attachment-test/i)

    await assert.rejects(
      service.prepare([selected.attachmentToken], OWNER),
      (error: unknown) => assertAttachmentError(error, 'selection_invalid')
    )
  })
})

test('removes PNG textual metadata and never sends the local image name', async () => {
  await withTempDirectory(async (directory) => {
    const marker = 'private-image-metadata-marker'
    const metadata = Buffer.concat([
      pngChunk('tEXt', Buffer.from(`Comment\0${marker}`, 'latin1')),
      pngChunk('vpAg', Buffer.from(`custom-${marker}`, 'latin1'))
    ])
    const idatOffset = PNG_1X1.indexOf(Buffer.from('IDAT', 'ascii')) - 4
    assert.ok(idatOffset > 8)
    const withMetadata = Buffer.concat([
      PNG_1X1.subarray(0, idatOffset),
      metadata,
      PNG_1X1.subarray(idatOffset)
    ])
    const localPath = join(directory, 'original-screenshot-name.png')
    await writeFile(localPath, withMetadata)
    const selections = new SelectionTokenStore()
    const selected = selections.issueAttachment(localPath, OWNER)
    const service = new AttachmentInputService({ selections })

    const prepared = await service.prepare([selected.attachmentToken], OWNER)
    const part = prepared.parts[0]
    assert.ok(part?.type === 'input_image')
    assert.equal(part.detail, 'auto')
    const decoded = Buffer.from(part.image_url.slice(part.image_url.indexOf(',') + 1), 'base64')
    assert.equal(decoded.subarray(0, 8).equals(PNG_1X1.subarray(0, 8)), true)
    assert.equal(decoded.includes(Buffer.from(marker)), false)
    assert.doesNotMatch(JSON.stringify(part), /original-screenshot-name|attachment-test/i)
  })
})

test('removes JPEG application metadata before creating the image data URL', async () => {
  await withTempDirectory(async (directory) => {
    const marker = 'jpeg-private-profile-marker'
    const appPayload = Buffer.from(marker, 'ascii')
    const appSegment = Buffer.alloc(4 + appPayload.length)
    appSegment[0] = 0xff
    appSegment[1] = 0xe2
    appSegment.writeUInt16BE(appPayload.length + 2, 2)
    appPayload.copy(appSegment, 4)
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      appSegment,
      Buffer.from([0xff, 0xda, 0x00, 0x02, 0x01, 0x02, 0xff, 0xd9])
    ])
    const localPath = join(directory, 'photo.jpg')
    await writeFile(localPath, jpeg)
    const selections = new SelectionTokenStore()
    const selected = selections.issueAttachment(localPath, OWNER)
    const service = new AttachmentInputService({ selections })

    const prepared = await service.prepare([selected.attachmentToken], OWNER)
    const part = prepared.parts[0]
    assert.ok(part?.type === 'input_image')
    const decoded = Buffer.from(part.image_url.slice(part.image_url.indexOf(',') + 1), 'base64')
    assert.equal(decoded.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), true)
    assert.equal(decoded.includes(Buffer.from(marker)), false)
  })
})

test('fails closed for sensitive names, protected roots, unsupported bytes, and changed selections', async () => {
  await withTempDirectory(async (directory) => {
    const selections = new SelectionTokenStore()
    const service = new AttachmentInputService({
      selections,
      protectedAbsoluteRoots: [join(directory, 'protected')]
    })

    const sensitivePath = join(directory, '.env.production')
    await writeFile(sensitivePath, 'API_KEY=sk-test-attachment-fixture')
    const sensitive = selections.issueAttachment(sensitivePath, OWNER)
    await assert.rejects(
      service.prepare([sensitive.attachmentToken], OWNER),
      (error: unknown) => assertAttachmentError(error, 'sensitive_path')
    )

    const protectedDirectory = join(directory, 'protected')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(protectedDirectory))
    const protectedPath = join(protectedDirectory, 'ordinary.txt')
    await writeFile(protectedPath, 'safe')
    const protectedSelection = selections.issueAttachment(protectedPath, OWNER)
    await assert.rejects(
      service.prepare([protectedSelection.attachmentToken], OWNER),
      (error: unknown) => assertAttachmentError(error, 'sensitive_path')
    )

    const fakeImagePath = join(directory, 'fake.png')
    await writeFile(fakeImagePath, 'not a png')
    const fakeImage = selections.issueAttachment(fakeImagePath, OWNER)
    await assert.rejects(
      service.prepare([fakeImage.attachmentToken], OWNER),
      (error: unknown) => assertAttachmentError(error, 'unsupported_type')
    )

    const changedPath = join(directory, 'changed.txt')
    await writeFile(changedPath, 'before')
    const changed = selections.issueAttachment(changedPath, OWNER)
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    await writeFile(changedPath, 'after with a different length')
    await assert.rejects(
      service.prepare([changed.attachmentToken], OWNER),
      (error: unknown) => assertAttachmentError(error, 'file_changed')
    )
    await assert.rejects(
      service.prepare([changed.attachmentToken], OWNER),
      (error: unknown) => assertAttachmentError(error, 'file_changed')
    )
  })
})

test('enforces owner, duplicate, size, aggregate, and cancellation limits before network use', async () => {
  await withTempDirectory(async (directory) => {
    const firstPath = join(directory, 'first.txt')
    const secondPath = join(directory, 'second.txt')
    await writeFile(firstPath, '12345678')
    await writeFile(secondPath, 'abcdefgh')
    const selections = new SelectionTokenStore()
    const first = selections.issueAttachment(firstPath, OWNER)
    const service = new AttachmentInputService({
      selections,
      maxAttachmentBytes: 8,
      maxTotalBytes: 12
    })

    await assert.rejects(
      service.prepare([first.attachmentToken], OWNER + 1),
      (error: unknown) => assertAttachmentError(error, 'selection_invalid')
    )
    await assert.rejects(
      service.prepare([first.attachmentToken, first.attachmentToken], OWNER),
      (error: unknown) => assertAttachmentError(error, 'invalid_request')
    )

    const second = selections.issueAttachment(secondPath, OWNER)
    await assert.rejects(
      service.prepare([first.attachmentToken, second.attachmentToken], OWNER),
      (error: unknown) => assertAttachmentError(error, 'total_too_large')
    )
    assert.equal((await service.prepare([first.attachmentToken], OWNER)).count, 1)
    assert.equal((await service.prepare([second.attachmentToken], OWNER)).count, 1)

    const oversizedPath = join(directory, 'oversized.txt')
    await writeFile(oversizedPath, '123456789')
    const oversized = selections.issueAttachment(oversizedPath, OWNER)
    await assert.rejects(
      service.prepare([oversized.attachmentToken], OWNER),
      (error: unknown) => assertAttachmentError(error, 'file_too_large')
    )

    const cancelledPath = join(directory, 'cancelled.txt')
    await writeFile(cancelledPath, 'safe')
    const cancelledSelection = selections.issueAttachment(cancelledPath, OWNER)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      service.prepare([cancelledSelection.attachmentToken], OWNER, { signal: controller.signal }),
      (error: unknown) => assertAttachmentError(error, 'cancelled')
    )
  })
})

test('concurrent preparation cannot share a reservation and cancellation rolls it back', async () => {
  await withTempDirectory(async (directory) => {
    const localPath = join(directory, 'retry-after-cancel.txt')
    await writeFile(localPath, 'safe retry content')

    let announceReserved: () => void = () => undefined
    const reservationObserved = new Promise<void>((resolve) => {
      announceReserved = resolve
    })
    let releaseReservation: () => void = () => undefined
    const reservationGate = new Promise<void>((resolve) => {
      releaseReservation = resolve
    })
    class GatedSelectionTokenStore extends SelectionTokenStore {
      override async reserveAttachments(tokens: readonly string[], ownerWebContentsId: number) {
        const reservation = await super.reserveAttachments(tokens, ownerWebContentsId)
        if (!reservation) return null
        announceReserved()
        await reservationGate
        return reservation
      }
    }

    const selections = new GatedSelectionTokenStore()
    const selected = selections.issueAttachment(localPath, OWNER)
    const service = new AttachmentInputService({ selections })
    const controller = new AbortController()
    const firstAttempt = service.prepare(
      [selected.attachmentToken],
      OWNER,
      { signal: controller.signal }
    )
    await reservationObserved

    await assert.rejects(
      service.prepare([selected.attachmentToken], OWNER),
      (error: unknown) => assertAttachmentError(error, 'selection_invalid')
    )
    controller.abort()
    releaseReservation()
    await assert.rejects(
      firstAttempt,
      (error: unknown) => assertAttachmentError(error, 'cancelled')
    )

    const retried = await service.prepare([selected.attachmentToken], OWNER)
    assert.equal(retried.count, 1)
    await assert.rejects(
      service.prepare([selected.attachmentToken], OWNER),
      (error: unknown) => assertAttachmentError(error, 'selection_invalid')
    )
  })
})

function pngChunk(type: string, content: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + content.length)
  chunk.writeUInt32BE(content.length, 0)
  chunk.write(type, 4, 'ascii')
  content.copy(chunk, 8)
  // The attachment sanitizer removes this chunk before model use. Its CRC is
  // intentionally opaque to the test because the parser only needs bounds.
  chunk.writeUInt32BE(0, 8 + content.length)
  return chunk
}
