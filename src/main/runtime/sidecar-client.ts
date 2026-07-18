import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

import { BoundedNdjsonDecoder, encodeSidecarRequest } from './ndjson.js'
import {
  SIDECAR_MAX_MESSAGE_BYTES,
  SIDECAR_PROTOCOL_VERSION,
  SidecarProtocolError,
  assertApprovalBinding,
  assertJsonValue,
  assertProtocolId,
  type ApprovalBinding,
  type ApprovalDecision,
  type JsonObject,
  type JsonValue,
  type SidecarEnvelope,
  type SidecarEventEnvelope,
  type SidecarRequestAction,
  type SidecarRequestEnvelope,
  type SidecarResponseEnvelope
} from './protocol.js'

export interface SidecarLaunchOptions {
  executablePath: string
  /** Static, app-owned bootstrap arguments such as a development mock script path. */
  bootstrapArgs?: readonly string[]
  cwd?: string
  environmentSource?: NodeJS.ProcessEnv
  maxMessageBytes?: number
  startupTimeoutMs?: number
  requestTimeoutMs?: number
}

export interface EndpointBindingInput {
  endpointId: string
  consentId: string
  baseUrl: string
  apiKey: string
}

export interface TurnStartInput {
  turnId: string
  workspaceId?: string
  endpointId: string
  mode: 'chat' | 'agent'
  model: string
  reasoning?: string
  permissionMode: 'ask' | 'auto' | 'full'
  subagentMode: 'off' | 'request' | 'auto'
  webSearch?: boolean
  messages: JsonValue[]
  attachmentIds?: string[]
}

export type SidecarEventListener = (event: SidecarEventEnvelope) => void

interface PendingRequest {
  action: SidecarRequestAction
  resolve: (value: JsonValue | undefined) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const allowedEnvironmentNames = new Set([
  'ALLUSERSPROFILE',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMSPEC',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'WINDIR'
])

const sensitiveArgumentName = /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|credential|password|secret)/i
const credentialUrl = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/i

function safeTimeout(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const candidate = value ?? fallback
  if (!Number.isFinite(candidate)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.floor(candidate)))
}

function validateLaunchOptions(options: SidecarLaunchOptions): void {
  if (!options.executablePath || !isAbsolute(options.executablePath) || options.executablePath.includes('\0')) {
    throw new SidecarProtocolError('invalid_sidecar_path', 'The sidecar executable path is invalid.')
  }
  if (options.cwd !== undefined && (!isAbsolute(options.cwd) || options.cwd.includes('\0'))) {
    throw new SidecarProtocolError('invalid_sidecar_cwd', 'The sidecar working directory is invalid.')
  }
  for (const argument of options.bootstrapArgs ?? []) {
    if (
      typeof argument !== 'string' ||
      argument.length > 32_768 ||
      argument.includes('\0') ||
      argument.includes('\r') ||
      argument.includes('\n') ||
      (argument.startsWith('-') && sensitiveArgumentName.test(argument)) ||
      credentialUrl.test(argument)
    ) {
      throw new SidecarProtocolError(
        'unsafe_sidecar_argument',
        'Sidecar bootstrap arguments cannot contain credentials or unsafe values.'
      )
    }
  }
}

export function sanitizedSidecarEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {
    PYTHONIOENCODING: 'utf-8',
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUTF8: '1'
  }
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || !allowedEnvironmentNames.has(name.toUpperCase())) continue
    output[name] = value
  }
  return output
}

export class SidecarRemoteError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, retryable = false) {
    super(`The sidecar request failed (${code}).`)
    this.name = 'SidecarRemoteError'
    this.code = code
    this.retryable = retryable
  }
}

export class SidecarClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly decoder: BoundedNdjsonDecoder
  private readonly requestTimeoutMs: number
  private readonly pending = new Map<string, PendingRequest>()
  private readonly listeners = new Set<SidecarEventListener>()
  private readonly readyPromise: Promise<void>
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  private startupTimer: NodeJS.Timeout | null = null
  private lastEventSequence = -1
  private ready = false
  private stopping = false
  private failed = false

  private constructor(options: SidecarLaunchOptions) {
    validateLaunchOptions(options)
    this.decoder = new BoundedNdjsonDecoder(options.maxMessageBytes ?? SIDECAR_MAX_MESSAGE_BYTES)
    this.requestTimeoutMs = safeTimeout(options.requestTimeoutMs, 120_000, 1_000, 10 * 60_000)
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })

    const bootstrapArgs = [...(options.bootstrapArgs ?? []), '--stdio']
    this.child = spawn(options.executablePath, bootstrapArgs, {
      cwd: options.cwd,
      env: sanitizedSidecarEnvironment(options.environmentSource),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })

    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        for (const envelope of this.decoder.push(chunk)) this.handleEnvelope(envelope)
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('The sidecar protocol failed.'))
      }
    })
    this.child.stdout.on('end', () => {
      try {
        for (const envelope of this.decoder.finish()) this.handleEnvelope(envelope)
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('The sidecar protocol failed.'))
      }
    })
    // Sidecar stderr is intentionally drained but never logged or surfaced. All
    // user-facing failures must arrive as bounded, redacted protocol messages.
    this.child.stderr.on('data', () => undefined)
    this.child.on('error', () => this.fail(new Error('The sidecar process could not be started.')))
    this.child.on('exit', (code) => {
      if (!this.stopping && !this.failed) {
        this.fail(new Error(code === 0 ? 'The sidecar exited unexpectedly.' : 'The sidecar process failed.'))
      }
    })

    const startupTimeout = safeTimeout(options.startupTimeoutMs, 15_000, 1_000, 60_000)
    this.startupTimer = setTimeout(() => {
      this.fail(new Error('The sidecar did not complete its protocol handshake.'))
    }, startupTimeout)
    this.startupTimer.unref()
  }

  static async launch(options: SidecarLaunchOptions): Promise<SidecarClient> {
    const client = new SidecarClient(options)
    await client.readyPromise
    return client
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  onEvent(listener: SidecarEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async initialize(appSessionId: string, clientVersion?: string): Promise<JsonValue | undefined> {
    const payload: JsonObject = { appSessionId }
    if (clientVersion) payload.clientVersion = clientVersion
    return this.request('session.initialize', payload)
  }

  async bindWorkspace(workspaceId: string, absolutePath: string): Promise<JsonValue | undefined> {
    return this.request('workspace.bind', { workspaceId, absolutePath })
  }

  async bindEndpoint(input: EndpointBindingInput): Promise<JsonValue | undefined> {
    // The credential is serialized only into the child stdin pipe. It is never
    // placed in argv, environment variables, pending-request metadata, or errors.
    return this.request('endpoint.bind', {
      endpointId: input.endpointId,
      consentId: input.consentId,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey
    })
  }

  async startTurn(input: TurnStartInput): Promise<JsonValue | undefined> {
    return this.request('turn.start', input as unknown as JsonObject)
  }

  async cancelTurn(turnId: string, reason?: string): Promise<JsonValue | undefined> {
    const payload: JsonObject = { turnId }
    if (reason) payload.reason = reason
    return this.request('turn.cancel', payload, 10_000)
  }

  async resolveApproval(
    binding: ApprovalBinding,
    decision: ApprovalDecision
  ): Promise<JsonValue | undefined> {
    assertApprovalBinding(binding)
    return this.request(
      'approval.resolve',
      { binding: binding as unknown as JsonObject, decision },
      10_000
    )
  }

  async request(
    action: SidecarRequestAction,
    payload: JsonObject,
    timeoutMs = this.requestTimeoutMs
  ): Promise<JsonValue | undefined> {
    if (!this.ready || this.stopping || this.failed) {
      throw new Error('The sidecar is not available.')
    }
    assertJsonValue(payload)
    const id = `request_${randomUUID()}`
    const envelope: SidecarRequestEnvelope = {
      v: SIDECAR_PROTOCOL_VERSION,
      kind: 'request',
      id,
      action,
      payload
    }
    const encoded = encodeSidecarRequest(envelope)
    const boundedTimeout = safeTimeout(timeoutMs, this.requestTimeoutMs, 1_000, 10 * 60_000)

    return new Promise<JsonValue | undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`The sidecar ${action} request timed out.`))
      }, boundedTimeout)
      timer.unref()
      this.pending.set(id, { action, resolve, reject, timer })
      this.child.stdin.write(encoded, (error) => {
        if (!error) return
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(id)
        pending.reject(new Error('The sidecar request could not be written.'))
      })
    })
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
    if (this.ready && !this.failed && this.child.exitCode === null) {
      try {
        await this.requestDuringShutdown()
      } catch {
        // Shutdown is best-effort; the bounded process wait below is authoritative.
      }
    }
    this.child.stdin.end()
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        this.child.kill()
        resolve()
      }, 2_000)
      timer.unref()
      this.child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.rejectPending(new Error('The sidecar has shut down.'))
  }

  private async requestDuringShutdown(): Promise<void> {
    const id = `request_${randomUUID()}`
    const envelope: SidecarRequestEnvelope = {
      v: SIDECAR_PROTOCOL_VERSION,
      kind: 'request',
      id,
      action: 'session.shutdown',
      payload: {}
    }
    const encoded = encodeSidecarRequest(envelope)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('The sidecar shutdown request timed out.'))
      }, 1_500)
      timer.unref()
      this.pending.set(id, {
        action: 'session.shutdown',
        timer,
        resolve: () => resolve(),
        reject
      })
      this.child.stdin.write(encoded, (error) => {
        if (error) reject(new Error('The sidecar shutdown request could not be written.'))
      })
    })
  }

  private handleEnvelope(envelope: SidecarEnvelope): void {
    if (envelope.kind === 'request') {
      throw new SidecarProtocolError('unexpected_request', 'The sidecar cannot issue requests to its parent.')
    }
    if (envelope.kind === 'response') {
      this.handleResponse(envelope)
      return
    }
    if (envelope.seq <= this.lastEventSequence) {
      throw new SidecarProtocolError('event_replay', 'The sidecar emitted an out-of-order event.')
    }
    this.lastEventSequence = envelope.seq
    if (envelope.event === 'ready') {
      if (this.ready || envelope.payload.protocol !== SIDECAR_PROTOCOL_VERSION) {
        throw new SidecarProtocolError('invalid_handshake', 'The sidecar handshake is invalid.')
      }
      this.ready = true
      if (this.startupTimer) clearTimeout(this.startupTimer)
      this.startupTimer = null
      this.readyResolve()
    }
    for (const listener of this.listeners) listener(envelope)
  }

  private handleResponse(response: SidecarResponseEnvelope): void {
    const pending = this.pending.get(response.id)
    if (!pending) {
      throw new SidecarProtocolError('unexpected_response', 'The sidecar returned an unknown response identifier.')
    }
    clearTimeout(pending.timer)
    this.pending.delete(response.id)
    if (response.ok) {
      pending.resolve(response.result)
      return
    }
    pending.reject(new SidecarRemoteError(response.error?.code ?? 'unknown', response.error?.retryable ?? false))
  }

  private fail(error: Error): void {
    if (this.failed) return
    this.failed = true
    this.ready = false
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.startupTimer = null
    this.readyReject(error)
    this.rejectPending(error)
    this.decoder.reset()
    if (this.child.exitCode === null) this.child.kill()
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

export interface RegisteredRuntime {
  client: SidecarClient
  dispose: () => Promise<void>
}

export async function registerRuntime(options: SidecarLaunchOptions): Promise<RegisteredRuntime> {
  const client = await SidecarClient.launch(options)
  return {
    client,
    dispose: () => client.shutdown()
  }
}
