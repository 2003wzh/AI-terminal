import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SmoothTextStream,
  type SmoothTextStreamScheduler,
} from '../../src/renderer/src/smooth-text-stream.ts'

class ManualScheduler implements SmoothTextStreamScheduler {
  #nextHandle = 1
  readonly callbacks = new Map<number, () => void>()
  readonly delays = new Map<number, number>()

  schedule(callback: () => void, delayMs: number): number {
    const handle = this.#nextHandle
    this.#nextHandle += 1
    this.callbacks.set(handle, callback)
    this.delays.set(handle, delayMs)
    return handle
  }

  cancel(handle: number): void {
    this.callbacks.delete(handle)
    this.delays.delete(handle)
  }

  runNext(): void {
    const entry = this.callbacks.entries().next().value as [number, () => void] | undefined
    assert.ok(entry, 'expected a scheduled stream release')
    this.callbacks.delete(entry[0])
    this.delays.delete(entry[0])
    entry[1]()
  }
}

test('smooth stream releases complete phrases in order without losing text', () => {
  const scheduler = new ManualScheduler()
  const released: string[] = []
  const input = '第一句完整。第二句也完整！Last phrase, with detail.\n最终尾巴'
  const stream = new SmoothTextStream((text) => released.push(text), {
    scheduler,
    minimumDelayMs: 1,
    maximumDelayMs: 1,
    idleFlushDelayMs: 1,
  })

  stream.push(input)
  scheduler.runNext()
  assert.equal(released[0], '第一句完整。')
  scheduler.runNext()
  assert.equal(released[1], '第二句也完整！')
  while (scheduler.callbacks.size > 0) scheduler.runNext()

  assert.equal(released.join(''), input)
  assert.ok(released.length >= 4)
})

test('terminal flush synchronously releases every received character', () => {
  const scheduler = new ManualScheduler()
  const released: string[] = []
  const stream = new SmoothTextStream((text) => released.push(text), { scheduler })

  stream.push('已接收第一段。仍在队列中的第二段')
  stream.flush()

  assert.equal(released.join(''), '已接收第一段。仍在队列中的第二段')
  assert.equal(stream.bufferedCharacters, 0)
  assert.equal(scheduler.callbacks.size, 0)
})

test('an incomplete fragment waits for the idle delay before it is released', () => {
  const scheduler = new ManualScheduler()
  const released: string[] = []
  const stream = new SmoothTextStream((text) => released.push(text), { scheduler })

  stream.push('尚未形成完整短语')
  assert.deepEqual(released, [])
  assert.equal(stream.bufferedCharacters, 8)
  assert.deepEqual([...scheduler.delays.values()], [140])

  scheduler.runNext()
  assert.deepEqual(released, ['尚未形成完整短语'])
  assert.equal(stream.bufferedCharacters, 0)
})

test('bounded queue sheds overflow in order and never splits a surrogate pair', () => {
  const scheduler = new ManualScheduler()
  const released: string[] = []
  const input = `${'a'.repeat(300)}😀${'b'.repeat(300)}`
  const stream = new SmoothTextStream((text) => released.push(text), {
    scheduler,
    maximumBufferedCharacters: 256,
  })

  stream.push(input)
  assert.ok(stream.bufferedCharacters <= 256)
  stream.flush()

  assert.equal(released.join(''), input)
  assert.equal(released.join('').includes('\uFFFD'), false)
})

test('reduced motion bypasses progressive reveal and discard prevents cross-task delivery', () => {
  const scheduler = new ManualScheduler()
  const released: string[] = []
  const reduced = new SmoothTextStream((text) => released.push(text), {
    scheduler,
    reducedMotion: true,
  })

  reduced.push('减少动态效果时立即呈现。')
  assert.deepEqual(released, ['减少动态效果时立即呈现。'])
  assert.equal(scheduler.callbacks.size, 0)

  const ordinary = new SmoothTextStream((text) => released.push(text), { scheduler })
  ordinary.push('不能进入下一个任务的内容。')
  ordinary.discard()
  assert.equal(scheduler.callbacks.size, 0)
  assert.deepEqual(released, ['减少动态效果时立即呈现。'])
})
