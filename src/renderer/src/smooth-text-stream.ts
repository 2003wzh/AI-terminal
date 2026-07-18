export interface SmoothTextStreamScheduler {
  schedule(callback: () => void, delayMs: number): number
  cancel(handle: number): void
}

export interface SmoothTextStreamOptions {
  scheduler?: SmoothTextStreamScheduler
  reducedMotion?: boolean
  minimumDelayMs?: number
  maximumDelayMs?: number
  idleFlushDelayMs?: number
  targetPhraseCharacters?: number
  maximumBufferedCharacters?: number
}

const DEFAULT_MINIMUM_DELAY_MS = 28
const DEFAULT_MAXIMUM_DELAY_MS = 92
const DEFAULT_IDLE_FLUSH_DELAY_MS = 140
const DEFAULT_TARGET_PHRASE_CHARACTERS = 96
const DEFAULT_MAXIMUM_BUFFERED_CHARACTERS = 32 * 1024
const MINIMUM_BUFFER_LIMIT = 256

const strongBoundaries = new Set(['\n', '。', '！', '？', '!', '?', '；', ';'])
const softBoundaries = new Set(['，', ',', '、', '：', ':'])
const trailingClosers = new Set(['"', "'", '”', '’', ')', '）', ']', '】', '}', '》', '」', '』'])

const defaultScheduler: SmoothTextStreamScheduler = {
  schedule(callback, delayMs) {
    return globalThis.setTimeout(callback, delayMs)
  },
  cancel(handle) {
    globalThis.clearTimeout(handle)
  },
}

/**
 * Smooths already-redacted Renderer text without becoming a second source of truth.
 * Main remains responsible for validation, redaction, cancellation, and persistence.
 */
export class SmoothTextStream {
  readonly #deliver: (text: string) => void
  readonly #scheduler: SmoothTextStreamScheduler
  readonly #reducedMotion: boolean
  readonly #minimumDelayMs: number
  readonly #maximumDelayMs: number
  readonly #idleFlushDelayMs: number
  readonly #targetPhraseCharacters: number
  readonly #maximumBufferedCharacters: number
  #pending = ''
  #timer: number | null = null
  #timerIsIdle = false

  constructor(deliver: (text: string) => void, options: SmoothTextStreamOptions = {}) {
    this.#deliver = deliver
    this.#scheduler = options.scheduler ?? defaultScheduler
    this.#reducedMotion = options.reducedMotion === true
    this.#minimumDelayMs = normalizeInteger(options.minimumDelayMs, DEFAULT_MINIMUM_DELAY_MS, 0)
    this.#maximumDelayMs = Math.max(
      this.#minimumDelayMs,
      normalizeInteger(options.maximumDelayMs, DEFAULT_MAXIMUM_DELAY_MS, 0),
    )
    this.#idleFlushDelayMs = normalizeInteger(options.idleFlushDelayMs, DEFAULT_IDLE_FLUSH_DELAY_MS, 0)
    this.#targetPhraseCharacters = normalizeInteger(
      options.targetPhraseCharacters,
      DEFAULT_TARGET_PHRASE_CHARACTERS,
      16,
    )
    this.#maximumBufferedCharacters = normalizeInteger(
      options.maximumBufferedCharacters,
      DEFAULT_MAXIMUM_BUFFERED_CHARACTERS,
      MINIMUM_BUFFER_LIMIT,
    )
  }

  get bufferedCharacters(): number {
    return this.#pending.length
  }

  push(text: string): void {
    if (!text) return
    this.#pending += text
    this.#releaseOverflow()

    if (this.#reducedMotion) {
      this.flush()
      return
    }

    const hasPhrase = nextPhraseBoundary(this.#pending, this.#targetPhraseCharacters, false) > 0
    if (hasPhrase && this.#timerIsIdle) this.#cancelTimer()
    if (this.#timer === null) {
      this.#schedule(hasPhrase ? this.#minimumDelayMs : this.#idleFlushDelayMs, !hasPhrase)
    }
  }

  flush(): void {
    this.#cancelTimer()
    if (!this.#pending) return
    const text = this.#pending
    this.#pending = ''
    this.#deliver(text)
  }

  discard(): void {
    this.#cancelTimer()
    this.#pending = ''
  }

  #drain(force: boolean): void {
    this.#timer = null
    this.#timerIsIdle = false
    if (!this.#pending) return

    const boundary = nextPhraseBoundary(this.#pending, this.#targetPhraseCharacters, force)
    if (boundary === 0) {
      this.#schedule(this.#idleFlushDelayMs, true)
      return
    }

    const phrase = this.#pending.slice(0, boundary)
    this.#pending = this.#pending.slice(boundary)
    this.#deliver(phrase)
    if (!this.#pending) return

    const nextBoundary = nextPhraseBoundary(this.#pending, this.#targetPhraseCharacters, false)
    if (nextBoundary === 0) {
      this.#schedule(this.#idleFlushDelayMs, true)
      return
    }
    this.#schedule(this.#delayFor(phrase.length), false)
  }

  #delayFor(releasedCharacters: number): number {
    if (this.#pending.length > this.#targetPhraseCharacters * 6) return this.#minimumDelayMs
    const readingDelay = this.#minimumDelayMs + Math.round(Math.min(releasedCharacters, 120) * 0.48)
    return Math.min(this.#maximumDelayMs, readingDelay)
  }

  #schedule(delayMs: number, idle: boolean): void {
    this.#timerIsIdle = idle
    this.#timer = this.#scheduler.schedule(() => this.#drain(idle), delayMs)
  }

  #cancelTimer(): void {
    if (this.#timer !== null) this.#scheduler.cancel(this.#timer)
    this.#timer = null
    this.#timerIsIdle = false
  }

  #releaseOverflow(): void {
    if (this.#pending.length <= this.#maximumBufferedCharacters) return
    const overflow = this.#pending.length - this.#maximumBufferedCharacters
    const boundary = safeBoundaryAtOrAfter(this.#pending, overflow)
    const text = this.#pending.slice(0, boundary)
    this.#pending = this.#pending.slice(boundary)
    this.#deliver(text)
  }
}

function normalizeInteger(value: number | undefined, fallback: number, minimum: number): number {
  return Number.isSafeInteger(value) && value! >= minimum ? value! : fallback
}

function nextPhraseBoundary(value: string, targetCharacters: number, force: boolean): number {
  let softBoundary = 0
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!
    if (strongBoundaries.has(character)) return includeTrailingSyntax(value, index + 1)
    if (softBoundary === 0 && softBoundaries.has(character)) {
      softBoundary = includeTrailingSyntax(value, index + 1)
    }
    if (index + 1 >= targetCharacters) break
  }
  if (softBoundary > 0) return softBoundary

  if (value.length > targetCharacters) {
    const lowerBound = Math.max(1, Math.floor(targetCharacters * 0.55))
    for (let index = targetCharacters; index >= lowerBound; index -= 1) {
      if (/\s/u.test(value[index - 1]!)) return safeBoundaryAtOrBefore(value, index)
    }
    return safeBoundaryAtOrBefore(value, targetCharacters)
  }
  return force ? value.length : 0
}

function includeTrailingSyntax(value: string, initialBoundary: number): number {
  let boundary = initialBoundary
  while (boundary < value.length && trailingClosers.has(value[boundary]!)) boundary += 1
  while (boundary < value.length && value[boundary] !== '\n' && /[\t ]/u.test(value[boundary]!)) boundary += 1
  return safeBoundaryAtOrBefore(value, boundary)
}

function safeBoundaryAtOrBefore(value: string, requested: number): number {
  let boundary = Math.min(value.length, Math.max(0, requested))
  if (
    boundary > 0 &&
    boundary < value.length &&
    isHighSurrogate(value.charCodeAt(boundary - 1)) &&
    isLowSurrogate(value.charCodeAt(boundary))
  ) {
    boundary -= 1
  }
  return boundary
}

function safeBoundaryAtOrAfter(value: string, requested: number): number {
  let boundary = Math.min(value.length, Math.max(0, requested))
  if (
    boundary > 0 &&
    boundary < value.length &&
    isHighSurrogate(value.charCodeAt(boundary - 1)) &&
    isLowSurrogate(value.charCodeAt(boundary))
  ) {
    boundary += 1
  }
  return boundary
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff
}
