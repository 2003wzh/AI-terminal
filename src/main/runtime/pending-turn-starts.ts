const DEFAULT_MAX_PENDING_STARTS = 32
const MAX_PENDING_STARTS_LIMIT = 128
const START_REQUEST_ID_PATTERN =
  /^start:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export type PendingTurnStartErrorCode =
  | 'invalid_request_id'
  | 'duplicate_request'
  | 'capacity_exceeded'
  | 'cancelled'

const ERROR_MESSAGES: Record<PendingTurnStartErrorCode, string> = {
  invalid_request_id: 'The turn start request identifier is invalid.',
  duplicate_request: 'The turn start request is already pending.',
  capacity_exceeded: 'Too many turn start requests are pending.',
  cancelled: 'The turn start request was cancelled.'
}

export class PendingTurnStartError extends Error {
  readonly code: PendingTurnStartErrorCode

  constructor(code: PendingTurnStartErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'PendingTurnStartError'
    this.code = code
    this.stack = `${this.name}: ${this.message}`
  }
}

export class PendingTurnStarts {
  readonly #controllers = new Map<string, AbortController>()
  readonly #maxPending: number

  constructor(maxPending = DEFAULT_MAX_PENDING_STARTS) {
    if (
      !Number.isSafeInteger(maxPending) ||
      maxPending < 1 ||
      maxPending > MAX_PENDING_STARTS_LIMIT
    ) {
      throw new PendingTurnStartError('capacity_exceeded')
    }
    this.#maxPending = maxPending
  }

  begin(requestId: string): AbortSignal {
    if (!isTurnStartRequestId(requestId)) {
      throw new PendingTurnStartError('invalid_request_id')
    }
    if (this.#controllers.has(requestId)) {
      throw new PendingTurnStartError('duplicate_request')
    }
    if (this.#controllers.size >= this.#maxPending) {
      throw new PendingTurnStartError('capacity_exceeded')
    }

    const controller = new AbortController()
    this.#controllers.set(requestId, controller)
    return controller.signal
  }

  cancel(requestId: unknown): boolean {
    if (!isTurnStartRequestId(requestId)) return false
    const controller = this.#controllers.get(requestId)
    if (!controller) return false
    if (!controller.signal.aborted) controller.abort('turn_start_cancelled')
    return true
  }

  assertActive(signal: AbortSignal): void {
    if (signal.aborted) throw new PendingTurnStartError('cancelled')
  }

  finish(requestId: string, signal: AbortSignal): void {
    const controller = this.#controllers.get(requestId)
    if (controller?.signal === signal) this.#controllers.delete(requestId)
  }

  abortAll(): void {
    for (const controller of this.#controllers.values()) {
      if (!controller.signal.aborted) controller.abort('turn_start_cancelled')
    }
    this.#controllers.clear()
  }

  get size(): number {
    return this.#controllers.size
  }
}

export function isTurnStartRequestId(value: unknown): value is string {
  return typeof value === 'string' && START_REQUEST_ID_PATTERN.test(value)
}
