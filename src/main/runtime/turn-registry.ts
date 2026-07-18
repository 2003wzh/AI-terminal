import { randomBytes } from 'node:crypto'

export type TurnRegistryState = 'running' | 'completed' | 'failed' | 'cancelled'

export interface TurnStateSnapshot {
  readonly turnId: string
  readonly state: TurnRegistryState
}

export interface RunningTurnHandle {
  readonly turnId: string
  readonly signal: AbortSignal
}

export type TurnStateListener = (snapshot: TurnStateSnapshot) => void

export type TurnRegistryErrorCode =
  | 'invalid_options'
  | 'invalid_task_id'
  | 'duplicate_active_turn'
  | 'active_turn_capacity'
  | 'turn_id_unavailable'

const ERROR_MESSAGES: Readonly<Record<TurnRegistryErrorCode, string>> = Object.freeze({
  invalid_options: 'The turn registry options are invalid.',
  invalid_task_id: 'The task identifier is invalid.',
  duplicate_active_turn: 'A turn is already active for this task.',
  active_turn_capacity: 'The turn registry is at capacity.',
  turn_id_unavailable: 'A turn identifier could not be issued.'
})

export class TurnRegistryError extends Error {
  readonly code: TurnRegistryErrorCode

  constructor(code: TurnRegistryErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'TurnRegistryError'
    this.code = code
    this.stack = `${this.name}: ${this.message}`
  }
}

export interface TurnRegistryOptions {
  maxActiveTurns?: number
  maxRetainedTurns?: number
  onStateChange?: TurnStateListener
}

interface ActiveTurn {
  readonly turnId: string
  readonly taskId: string
  readonly controller: AbortController
}

const DEFAULT_MAX_ACTIVE_TURNS = 128
const DEFAULT_MAX_RETAINED_TURNS = 256
const MAX_CONFIGURED_TURNS = 4_096
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TURN_ID_PATTERN = /^turn_[A-Za-z0-9_-]{32}$/
const TURN_ID_ATTEMPTS = 8

function boundedOption(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > MAX_CONFIGURED_TURNS) {
    throw new TurnRegistryError('invalid_options')
  }
  return candidate
}

function snapshot(turnId: string, state: TurnRegistryState): TurnStateSnapshot {
  return Object.freeze({ turnId, state })
}

export class TurnRegistry {
  private readonly maxActiveTurns: number
  private readonly maxRetainedTurns: number
  private readonly onStateChange?: TurnStateListener
  private readonly activeByTask = new Map<string, ActiveTurn>()
  private readonly activeByTurn = new Map<string, ActiveTurn>()
  private readonly terminalByTurn = new Map<string, TurnStateSnapshot>()
  private readonly terminalOrder: string[] = []

  constructor(options: TurnRegistryOptions = {}) {
    this.maxActiveTurns = boundedOption(options.maxActiveTurns, DEFAULT_MAX_ACTIVE_TURNS)
    this.maxRetainedTurns = boundedOption(options.maxRetainedTurns, DEFAULT_MAX_RETAINED_TURNS)
    this.onStateChange = options.onStateChange
  }

  start(taskId: string): RunningTurnHandle {
    if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) {
      throw new TurnRegistryError('invalid_task_id')
    }
    if (this.activeByTask.has(taskId)) {
      throw new TurnRegistryError('duplicate_active_turn')
    }
    if (this.activeByTurn.size >= this.maxActiveTurns) {
      throw new TurnRegistryError('active_turn_capacity')
    }

    const turnId = this.issueTurnId()
    const controller = new AbortController()
    const active = { turnId, taskId, controller }
    this.activeByTask.set(taskId, active)
    this.activeByTurn.set(turnId, active)

    const handle = Object.freeze({ turnId, signal: controller.signal })
    this.emit(snapshot(turnId, 'running'))
    return handle
  }

  complete(turnId: string): TurnStateSnapshot | null {
    return this.transition(turnId, 'completed')
  }

  fail(turnId: string): TurnStateSnapshot | null {
    return this.transition(turnId, 'failed')
  }

  cancel(turnId: string): TurnStateSnapshot | null {
    return this.transition(turnId, 'cancelled')
  }

  cancelAll(): void {
    const activeTurnIds = [...this.activeByTurn.keys()]
    for (const turnId of activeTurnIds) this.transition(turnId, 'cancelled')
  }

  getSnapshot(turnId: string): TurnStateSnapshot | null {
    if (typeof turnId !== 'string' || !TURN_ID_PATTERN.test(turnId)) return null
    const terminal = this.terminalByTurn.get(turnId)
    if (terminal) return terminal
    return this.activeByTurn.has(turnId) ? snapshot(turnId, 'running') : null
  }

  getActiveSnapshotForTask(taskId: string): TurnStateSnapshot | null {
    if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) return null
    const active = this.activeByTask.get(taskId)
    return active ? snapshot(active.turnId, 'running') : null
  }

  getCounts(): Readonly<{ active: number; retainedTerminal: number }> {
    return Object.freeze({
      active: this.activeByTurn.size,
      retainedTerminal: this.terminalByTurn.size
    })
  }

  private issueTurnId(): string {
    try {
      for (let attempt = 0; attempt < TURN_ID_ATTEMPTS; attempt += 1) {
        const turnId = `turn_${randomBytes(24).toString('base64url')}`
        if (!this.activeByTurn.has(turnId) && !this.terminalByTurn.has(turnId)) return turnId
      }
    } catch {
      throw new TurnRegistryError('turn_id_unavailable')
    }
    throw new TurnRegistryError('turn_id_unavailable')
  }

  private transition(turnId: string, state: Exclude<TurnRegistryState, 'running'>): TurnStateSnapshot | null {
    if (typeof turnId !== 'string' || !TURN_ID_PATTERN.test(turnId)) return null

    const existing = this.terminalByTurn.get(turnId)
    if (existing) return existing

    const active = this.activeByTurn.get(turnId)
    if (!active) return null

    this.activeByTurn.delete(turnId)
    if (this.activeByTask.get(active.taskId)?.turnId === turnId) {
      this.activeByTask.delete(active.taskId)
    }

    const terminal = snapshot(turnId, state)
    this.terminalByTurn.set(turnId, terminal)
    this.terminalOrder.push(turnId)
    this.pruneTerminalTurns()

    // Publish the terminal state before AbortSignal listeners can race another
    // completion into the registry. No caller-provided cancellation reason is used.
    if (state === 'cancelled') active.controller.abort('turn_cancelled')
    this.emit(terminal)
    return terminal
  }

  private pruneTerminalTurns(): void {
    while (this.terminalOrder.length > this.maxRetainedTurns) {
      const oldestTurnId = this.terminalOrder.shift()
      if (oldestTurnId) this.terminalByTurn.delete(oldestTurnId)
    }
  }

  private emit(state: TurnStateSnapshot): void {
    if (!this.onStateChange) return
    try {
      this.onStateChange(state)
    } catch {
      // State transitions must not fail or expose callback diagnostics.
    }
  }
}
