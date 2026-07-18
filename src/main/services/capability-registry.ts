import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants as fsConstants, promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep, win32 } from 'node:path'

import type {
  CapabilityCatalog,
  CapabilityCommandDescriptor,
  CapabilityCommandId,
  CapabilityDiscoveryCategory,
  CapabilityExecuteResult,
  CapabilityGoalState,
  CapabilityPermission,
  CapabilitySessionState,
  PluginDescriptor,
  SkillDescriptor
} from '../../shared/contracts.ts'
import { redactSensitiveContent, redactSensitiveText } from '../security/redaction.ts'
import {
  CapabilityGrantStore,
  type CapabilityGrantPeekResult
} from './capability-grant-store.ts'

/**
 * Main-process capability discovery and command state.
 *
 * This service deliberately does not execute skill/plugin code. Discovery is
 * limited to conventional, bounded locations and returns only a redacted
 * metadata DTO. Execution of a capability that could touch the filesystem,
 * shell, network, or an MCP server remains behind the existing approval path.
 */

export type CapabilityRegistryErrorCode = 'invalid_input' | 'storage_error'

const MAX_SKILL_BYTES = 32 * 1024
const MAX_SKILL_INSTRUCTION_READ_BYTES = 64 * 1024
const MAX_SKILL_INSTRUCTION_BYTES = 12 * 1024
const MAX_PLUGIN_BYTES = 64 * 1024
const MAX_DISCOVERED_ITEMS = 64
const MAX_DIRECTORY_ENTRIES = 128
const MAX_TEXT = 240
const MAX_GOAL_TEXT = 4_000
const MAX_PLAN_STEPS = 16
const MAX_PLAN_STEP_TEXT = 240
const MAX_COMMAND_ARGUMENTS = 2_000
const SAFE_SEGMENT_PATTERN = /^[^\\/\0]{1,120}$/u
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,95}$/u

const PERMISSIONS = Object.freeze([
  'read',
  'write',
  'execute',
  'network',
  'approval'
] as const)

const BUILTIN_COMMANDS: readonly CapabilityCommandDescriptor[] = Object.freeze([
  {
    id: 'plan',
    name: '/plan',
    description: 'Enter a read-only planning mode before Agent execution.',
    aliases: ['plan'],
    scope: 'builtin',
    permissions: ['read'],
    safe: true,
    availability: 'ready'
  },
  {
    id: 'goal',
    name: '/goal',
    description: 'Create, inspect, pause, resume, or clear the current goal.',
    aliases: ['goal'],
    scope: 'builtin',
    permissions: [],
    safe: true,
    availability: 'ready'
  },
  {
    id: 'compact',
    name: '/compact',
    description: 'Request a bounded summary of the current context.',
    aliases: ['compact'],
    scope: 'builtin',
    permissions: ['read'],
    safe: true,
    availability: 'ready'
  },
  {
    id: 'memories',
    name: '/memories',
    description: 'Inspect or toggle memory read and generation behavior.',
    aliases: ['memories', 'memory'],
    scope: 'builtin',
    permissions: [],
    safe: true,
    availability: 'ready'
  },
  {
    id: 'init',
    name: '/init',
    description: 'Prepare an AGENTS.md project instruction draft.',
    aliases: ['init'],
    scope: 'builtin',
    permissions: ['read', 'write', 'approval'],
    safe: false,
    availability: 'requires-approval'
  },
  {
    id: 'review',
    name: '/review',
    description: 'Prepare a review of an authorized workspace diff.',
    aliases: ['review'],
    scope: 'builtin',
    permissions: ['read', 'execute', 'approval'],
    safe: false,
    availability: 'requires-approval'
  },
  {
    id: 'status',
    name: '/status',
    description: 'Show the current mode, goal, memory, and capability status.',
    aliases: ['status'],
    scope: 'builtin',
    permissions: [],
    safe: true,
    availability: 'ready'
  }
])

const BUILTIN_COMMAND_IDS = new Set<string>(BUILTIN_COMMANDS.map((command) => command.id))

export class CapabilityRegistryError extends Error {
  readonly code: CapabilityRegistryErrorCode

  constructor(code: CapabilityRegistryErrorCode) {
    super(code === 'invalid_input'
      ? 'The capability request is invalid.'
      : 'Capability discovery is temporarily unavailable.')
    this.name = 'CapabilityRegistryError'
    this.code = code
    this.stack = `${this.name}: ${this.message}`
  }
}

interface CapabilityRegistryState {
  planMode: boolean
  goal: CapabilityGoalState | null
  memoriesEnabled: boolean
  reviewIntent: {
    handle: string
    device: string
    inode: string
    expiresAt: number
  } | null
}

const REVIEW_HANDLE_PATTERN = /^review_[A-Za-z0-9_-]{43}$/u
const REVIEW_INTENT_TTL_MS = 2 * 60_000

export interface CapabilityListOptions {
  ownerWebContentsId: number
  /** Main sets this only after its native, category-specific consent prompt. */
  discover?: CapabilityDiscoveryCategory
  workspace?: CapabilityWorkspaceIdentity
}

export interface CapabilitySkillUseRequest {
  id: string
  scope: 'user' | 'workspace'
  relativePath: string
}

export interface CapabilityExecuteOptions {
  id: string
  args?: string
  ownerWebContentsId: number
  workspace?: CapabilityWorkspaceIdentity
  grantHandle?: string
  authorizeSkillUse?: (request: CapabilitySkillUseRequest) => Promise<boolean>
}

/**
 * The path alone is not an authorization.  Callers that hold a workspace
 * selection should pass the identity captured by SelectionTokenStore so a
 * replacement/junction cannot be silently rescanned.
 */
export interface CapabilityWorkspaceIdentity {
  absolutePath: string
  device: string
  inode: string
}

export interface CapabilityRegistryOptions {
  homeDirectory?: string
}

interface SkillMetadata {
  name: string
  description: string
  permissions: CapabilityPermission[]
  sourceSha256: string
}

interface PluginMetadata {
  name: string
  description: string
  version: string
  permissions: CapabilityPermission[]
  sourceSha256: string
}

export class CapabilityRegistry {
  readonly #homeDirectory: string
  readonly #grants = new CapabilityGrantStore()
  readonly #states = new Map<number, CapabilityRegistryState>()

  constructor(options: CapabilityRegistryOptions = {}) {
    if (!isPlainRecord(options) || !hasOnlyKeys(options, ['homeDirectory'])) {
      throw new CapabilityRegistryError('invalid_input')
    }
    const home = options.homeDirectory ?? homedir()
    if (typeof home !== 'string' || !isAbsolute(home) || home.length > 32_768) {
      throw new CapabilityRegistryError('invalid_input')
    }
    this.#homeDirectory = home
  }

  getPlanMode(ownerWebContentsId: number): boolean {
    validateOwnerWebContentsId(ownerWebContentsId)
    return this.#states.get(ownerWebContentsId)?.planMode ?? false
  }

  consumeReviewMode(
    ownerWebContentsId: number,
    workspace: CapabilityWorkspaceIdentity,
    reviewHandle: unknown
  ): boolean {
    validateOwnerWebContentsId(ownerWebContentsId)
    const verifiedWorkspace = validateWorkspaceIdentity(workspace)
    if (!verifiedWorkspace) throw new CapabilityRegistryError('invalid_input')
    if (typeof reviewHandle !== 'string' || !REVIEW_HANDLE_PATTERN.test(reviewHandle)) return false
    const state = this.#states.get(ownerWebContentsId)
    const pending = state?.reviewIntent ?? null
    if (!pending || !constantTimeEqual(pending.handle, reviewHandle)) return false
    state!.reviewIntent = null
    return pending.expiresAt > Date.now() &&
      pending.device === verifiedWorkspace.device &&
      pending.inode === verifiedWorkspace.inode
  }

  resetOwner(ownerWebContentsId: number): void {
    if (!isValidOwnerWebContentsId(ownerWebContentsId)) return
    this.#states.delete(ownerWebContentsId)
    this.#grants.revokeOwner(ownerWebContentsId)
  }

  async list(options: CapabilityListOptions): Promise<CapabilityCatalog> {
    if (
      !isPlainRecord(options) ||
      !hasOnlyKeys(options, ['ownerWebContentsId', 'discover', 'workspace'])
    ) {
      throw new CapabilityRegistryError('invalid_input')
    }
    validateOwnerWebContentsId(options.ownerWebContentsId)
    if (
      options.discover !== undefined &&
      options.discover !== 'skills' &&
      options.discover !== 'plugins'
    ) {
      throw new CapabilityRegistryError('invalid_input')
    }
    const workspace = validateWorkspaceIdentity(options.workspace)
    if (workspace !== undefined && options.discover === undefined) {
      throw new CapabilityRegistryError('invalid_input')
    }
    const skills: SkillDescriptor[] = []
    const plugins: PluginDescriptor[] = []
    const skillIds = new Set<string>()
    const pluginIds = new Set<string>()
    const session = this.#sessionSnapshot(options.ownerWebContentsId)

    // Listing built-ins is deliberately side-effect free.  Reading the home
    // directory or workspace is only allowed after an explicit discovery
    // consent has been converted into a category by the main process.
    if (options.discover === undefined) {
      return {
        commands: cloneBuiltinCommands(),
        skills,
        plugins,
        session
      }
    }

    // Validate the caller-provided workspace capability before touching the
    // user scope. An expired or replaced workspace must not trigger unrelated
    // home-directory discovery.
    const verifiedWorkspaceRoot = workspace
      ? await verifyDiscoveryRoot(workspace.absolutePath, workspace)
      : null
    if (workspace && !verifiedWorkspaceRoot) {
      throw new CapabilityRegistryError('storage_error')
    }

    const userRoot = await verifyDiscoveryRoot(this.#homeDirectory)
    if (userRoot) {
      if (options.discover === 'skills') {
        await this.#discoverSkills(
          userRoot,
          'user',
          ['.codex/skills', '.agents/skills'],
          skills,
          skillIds,
          options.ownerWebContentsId
        )
      } else {
        await this.#discoverPlugins(
          userRoot,
          'user',
          plugins,
          pluginIds,
          ['.codex-plugin/plugin.json', '.agents/plugins', '.codex/plugins'],
          options.ownerWebContentsId
        )
      }
      await assertDiscoveryRootStable(userRoot)
    }

    if (workspace && verifiedWorkspaceRoot) {
      if (options.discover === 'skills') {
        await this.#discoverSkills(
          verifiedWorkspaceRoot,
          'workspace',
          ['.agents/skills', '.codex/skills'],
          skills,
          skillIds,
          options.ownerWebContentsId
        )
      } else {
        await this.#discoverPlugins(
          verifiedWorkspaceRoot,
          'workspace',
          plugins,
          pluginIds,
          ['.codex-plugin/plugin.json', '.agents/plugins', '.codex/plugins'],
          options.ownerWebContentsId
        )
      }
      await assertDiscoveryRootStable(verifiedWorkspaceRoot)
    }

    return {
      commands: cloneBuiltinCommands(),
      skills,
      plugins,
      session
    }
  }

  async execute(options: CapabilityExecuteOptions): Promise<CapabilityExecuteResult> {
    if (
      !isPlainRecord(options) ||
      !hasOnlyKeys(options, [
        'id',
        'args',
        'ownerWebContentsId',
        'workspace',
        'grantHandle',
        'authorizeSkillUse'
      ])
    ) {
      throw new CapabilityRegistryError('invalid_input')
    }
    validateOwnerWebContentsId(options.ownerWebContentsId)
    const id = normalizeCapabilityId(options.id)
    if (!id) throw new CapabilityRegistryError('invalid_input')
    const args = validateArguments(options.args)
    const workspace = validateWorkspaceIdentity(options.workspace)
    if (
      options.grantHandle !== undefined && typeof options.grantHandle !== 'string' ||
      options.authorizeSkillUse !== undefined && typeof options.authorizeSkillUse !== 'function'
    ) {
      throw new CapabilityRegistryError('invalid_input')
    }
    const state = this.#stateFor(options.ownerWebContentsId)

    if (!BUILTIN_COMMAND_IDS.has(id)) {
      // Skill instructions may be loaded as bounded, redacted text. Plugins
      // remain metadata-only until a future executor obtains explicit approval.
      if (id.startsWith('skill:') || id.startsWith('plugin:')) {
        if (id.startsWith('skill:')) {
          if (!options.grantHandle || !options.authorizeSkillUse) {
            return {
              id,
              status: 'requires-approval',
              message: 'Selecting a skill requires a Main-process approval. No file was read.'
            }
          }
          return await this.#executeSkill(
            id,
            options.grantHandle,
            options.ownerWebContentsId,
            workspace,
            options.authorizeSkillUse
          )
        }
        return {
          id,
          status: 'not-ready',
          message: 'This skill or plugin is registered but its executor is not ready. No code was run.'
        }
      }
      return {
        id,
        status: 'not-ready',
        message: 'This capability is not registered. No operation was performed.'
      }
    }

    switch (id as CapabilityCommandId) {
      case 'plan':
        state.planMode = args.trim().toLowerCase() !== 'off'
        state.reviewIntent = null
        return {
          id,
          status: 'completed',
          message: state.planMode
            ? 'Plan mode is active. Only read, enumerate, and search operations are allowed.'
            : 'Plan mode is disabled. Agent execution can resume under the selected approval policy.',
          plan: state.planMode ? parsePlan(args) : [],
          session: this.#sessionSnapshot(options.ownerWebContentsId)
        }
      case 'goal':
        return this.#executeGoal(id, args, state, options.ownerWebContentsId)
      case 'compact':
        return {
          id,
          status: 'preview',
          message: 'Context compaction is ready to run after the current conversation snapshot is supplied.',
          session: this.#sessionSnapshot(options.ownerWebContentsId)
        }
      case 'memories':
        return this.#executeMemories(id, args, state, options.ownerWebContentsId)
      case 'init':
        return {
          id,
          status: 'requires-approval',
          message: 'Preparing AGENTS.md requires explicit workspace approval. No file was read or changed.',
          session: this.#sessionSnapshot(options.ownerWebContentsId)
        }
      case 'review':
        if (state.planMode) {
          return {
            id,
            status: 'not-ready',
            message: 'Exit plan mode before starting a Git diff review.',
            session: this.#sessionSnapshot(options.ownerWebContentsId)
          }
        }
        if (!workspace) {
          return {
            id,
            status: 'not-ready',
            message: 'Select an authorized workspace before starting a code review.',
            session: this.#sessionSnapshot(options.ownerWebContentsId)
          }
        }
        state.reviewIntent = {
          handle: issueReviewHandle(),
          device: workspace.device,
          inode: workspace.inode,
          expiresAt: Date.now() + REVIEW_INTENT_TTL_MS
        }
        return {
          id,
          status: 'preview',
          message: 'Code review is armed for the next Agent turn. Git diff access still requires exact one-time approval.',
          reviewHandle: state.reviewIntent.handle,
          session: this.#sessionSnapshot(options.ownerWebContentsId)
        }
      case 'status':
        return {
          id,
          status: 'completed',
          message: this.#statusMessage(state),
          ...(state.goal ? { goal: { ...state.goal } } : {}),
          session: this.#sessionSnapshot(options.ownerWebContentsId)
        }
    }
  }

  /*
   * The old implementation of list/execute lived here.  Keep the command
   * behavior above unchanged, but make all filesystem access flow through the
   * opt-in and identity-checked path.
   */

  #stateFor(ownerWebContentsId: number): CapabilityRegistryState {
    const existing = this.#states.get(ownerWebContentsId)
    if (existing) return existing
    const state: CapabilityRegistryState = {
      planMode: false,
      goal: null,
      memoriesEnabled: true,
      reviewIntent: null
    }
    this.#states.set(ownerWebContentsId, state)
    return state
  }

  #sessionSnapshot(ownerWebContentsId: number): CapabilitySessionState {
    const state = this.#stateFor(ownerWebContentsId)
    return {
      planMode: state.planMode,
      memoriesEnabled: state.memoriesEnabled,
      ...(state.goal ? { goal: { ...state.goal } } : {})
    }
  }

  #executeGoal(
    id: string,
    args: string,
    state: CapabilityRegistryState,
    ownerWebContentsId: number
  ): CapabilityExecuteResult {
    const command = args.trim()
    if (!command || command.toLowerCase() === 'status' || command.toLowerCase() === 'show') {
      return {
        id,
        status: 'completed',
        message: state.goal
          ? `Current goal: ${state.goal.text} (${state.goal.status}).`
          : 'No active goal is set.',
        ...(state.goal ? { goal: { ...state.goal } } : {}),
        session: this.#sessionSnapshot(ownerWebContentsId)
      }
    }
    if (command.toLowerCase() === 'clear') {
      state.goal = { text: '', status: 'cleared' }
      return {
        id,
        status: 'completed',
        message: 'The current goal was cleared.',
        goal: { ...state.goal },
        session: this.#sessionSnapshot(ownerWebContentsId)
      }
    }
    if (command.toLowerCase() === 'pause' || command.toLowerCase() === 'resume') {
      if (!state.goal || state.goal.status === 'cleared') {
        return {
          id,
          status: 'not-ready',
          message: 'There is no active goal to update.',
          session: this.#sessionSnapshot(ownerWebContentsId)
        }
      }
      state.goal.status = command.toLowerCase() === 'pause' ? 'paused' : 'active'
      return {
        id,
        status: 'completed',
        message: `The goal is now ${state.goal.status}.`,
        goal: { ...state.goal },
        session: this.#sessionSnapshot(ownerWebContentsId)
      }
    }
    const text = redactSensitiveContent(command).slice(0, MAX_GOAL_TEXT).trim()
    if (!text) {
      return {
        id,
        status: 'not-ready',
        message: 'The goal text is empty.',
        session: this.#sessionSnapshot(ownerWebContentsId)
      }
    }
    state.goal = { text, status: 'active' }
    return {
      id,
      status: 'completed',
      message: 'Goal saved for this application session.',
      goal: { ...state.goal },
      session: this.#sessionSnapshot(ownerWebContentsId)
    }
  }

  #executeMemories(
    id: string,
    args: string,
    state: CapabilityRegistryState,
    ownerWebContentsId: number
  ): CapabilityExecuteResult {
    const command = args.trim().toLowerCase()
    if (command === 'on' || command === 'enable' || command === 'enabled') state.memoriesEnabled = true
    if (command === 'off' || command === 'disable' || command === 'disabled') state.memoriesEnabled = false
    const label = state.memoriesEnabled ? 'enabled' : 'disabled'
    return {
      id,
      status: 'completed',
      message: `Memory read and generation are ${label} for this application session.`,
      session: this.#sessionSnapshot(ownerWebContentsId)
    }
  }

  #statusMessage(state: CapabilityRegistryState): string {
    const goal = state.goal?.status ?? 'none'
    const mode = state.planMode ? 'plan' : 'normal'
    const memories = state.memoriesEnabled ? 'on' : 'off'
    return `mode=${mode}; goal=${goal}; memories=${memories}; skill/plugin execution=approval-gated.`
  }

  async #executeSkill(
    id: string,
    grantHandle: string,
    ownerWebContentsId: number,
    workspace: CapabilityWorkspaceIdentity | undefined,
    authorizeSkillUse: (request: CapabilitySkillUseRequest) => Promise<boolean>
  ): Promise<CapabilityExecuteResult> {
    const binding = this.#grants.peek(grantHandle, ownerWebContentsId)
    if (!binding || binding.kind !== 'skill' || binding.id !== id) {
      return {
        id,
        status: 'not-ready',
        message: 'This skill selection is invalid or expired. Rediscover it before use. No file was read.'
      }
    }
    const workspaceMatches = binding.scope === 'workspace'
      ? workspace !== undefined &&
        binding.workspace !== null &&
        workspace.device === binding.workspace.device &&
        workspace.inode === binding.workspace.inode
      : workspace === undefined
    if (!workspaceMatches) {
      this.#burnGrant(binding, ownerWebContentsId)
      return {
        id,
        status: 'not-ready',
        message: 'This skill is not bound to the current authorized workspace. No file was read.'
      }
    }

    let approved = false
    try {
      approved = await authorizeSkillUse({
        id: binding.id,
        scope: binding.scope,
        relativePath: binding.relativePath
      })
    } catch {
      approved = false
    }
    if (!approved) {
      this.#burnGrant(binding, ownerWebContentsId)
      return {
        id,
        status: 'requires-approval',
        message: 'Skill use was not approved. No file was read.'
      }
    }

    const root = binding.scope === 'user' ? this.#homeDirectory : workspace?.absolutePath
    if (!root || !isSafeSkillRelativePath(binding.relativePath, binding.scope)) {
      this.#burnGrant(binding, ownerWebContentsId)
      return {
        id,
        status: 'not-ready',
        message: 'The registered skill path is not safe to load. No file was read.'
      }
    }
    const verifiedRoot = await verifyDiscoveryRoot(
      root,
      {
        absolutePath: root,
        device: binding.root.device,
        inode: binding.root.inode
      }
    )
    if (!verifiedRoot) {
      this.#burnGrant(binding, ownerWebContentsId)
      return {
        id,
        status: 'not-ready',
        message: 'The registered skill path is not safe to load. No file was read.'
      }
    }
    const verifiedSkill = await verifyPathWithinRoot(
      verifiedRoot,
      binding.relativePath,
      'file'
    )
    if (!verifiedSkill) {
      this.#burnGrant(binding, ownerWebContentsId)
      return {
        id,
        status: 'not-ready',
        message: 'The registered skill path is not safe to load. No file was read.'
      }
    }
    const source = await readBoundedFile(
      verifiedSkill.absolutePath,
      MAX_SKILL_INSTRUCTION_READ_BYTES,
      verifiedSkill.stats
    )
    if (source === null) {
      this.#burnGrant(binding, ownerWebContentsId)
      return {
        id,
        status: 'not-ready',
        message: 'Skill instructions are unavailable or exceed the local safety limit.'
      }
    }
    try {
      await assertDiscoveryRootStable(verifiedRoot)
    } catch {
      this.#burnGrant(binding, ownerWebContentsId)
      return {
        id,
        status: 'not-ready',
        message: 'The selected skill root changed during use. Rediscover it before use.'
      }
    }
    const currentFile = capabilityFileIdentity(verifiedSkill.stats, source)
    const consumed = this.#grants.consume({
      grantHandle,
      ownerWebContentsId,
      kind: 'skill',
      id,
      scope: binding.scope,
      relativePath: binding.relativePath,
      root: { device: verifiedRoot.device, inode: verifiedRoot.inode },
      file: currentFile,
      workspace: binding.scope === 'workspace'
        ? { device: workspace!.device, inode: workspace!.inode }
        : null
    })
    if (!consumed) {
      return {
        id,
        status: 'not-ready',
        message: 'The selected skill changed after discovery. Rediscover it before use.'
      }
    }
    const body = truncateUtf8(
      redactSensitiveContent(stripFrontmatter(source)),
      MAX_SKILL_INSTRUCTION_BYTES
    ).trim()
    if (!body) {
      return {
        id,
        status: 'preview',
        message: 'The selected skill contains no readable instructions.'
      }
    }
    return {
      id,
      status: 'completed',
      message: 'Skill instructions loaded read-only. No scripts or tools were executed.',
      instructions: body
    }
  }

  #burnGrant(binding: CapabilityGrantPeekResult, ownerWebContentsId: number): void {
    const wrongOwner = ownerWebContentsId === Number.MAX_SAFE_INTEGER
      ? ownerWebContentsId - 1
      : ownerWebContentsId + 1
    this.#grants.consume({
      grantHandle: binding.grantHandle,
      ownerWebContentsId: wrongOwner,
      kind: binding.kind,
      id: binding.id,
      scope: binding.scope,
      relativePath: binding.relativePath,
      root: binding.root,
      file: binding.file,
      workspace: binding.workspace
    })
  }

  async #discoverSkills(
    root: VerifiedDiscoveryRoot,
    scope: 'user' | 'workspace',
    relativeBases: readonly string[],
    output: SkillDescriptor[],
    ids: Set<string>,
    ownerWebContentsId: number
  ): Promise<void> {
    for (const base of relativeBases) {
      if (output.length >= MAX_DISCOVERED_ITEMS) return
      const entries = await safeReadDirectory(root, base)
      for (const entry of entries) {
        if (output.length >= MAX_DISCOVERED_ITEMS) return
        if (!safeSegment(entry.name)) continue
        const relativePath = `${base}/${entry.name}`
        if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') {
          const verified = await verifyPathWithinRoot(root, relativePath, 'file')
          const metadata = verified
            ? await readSkillMetadata(verified.absolutePath, entry.name, verified.stats)
            : null
          if (metadata && verified) {
            this.#pushSkill(
              output,
              ids,
              scope,
              `${base}/SKILL.md`,
              metadata,
              root,
              verified.stats,
              ownerWebContentsId
            )
          }
          continue
        }
        if (!entry.isDirectory()) continue
        const skillRelativePath = `${relativePath}/SKILL.md`
        const verified = await verifyPathWithinRoot(root, skillRelativePath, 'file')
        if (!verified) continue
        const metadata = await readSkillMetadata(verified.absolutePath, entry.name, verified.stats)
        if (metadata) {
          this.#pushSkill(
            output,
            ids,
            scope,
            `${base}/${entry.name}/SKILL.md`,
            metadata,
            root,
            verified.stats,
            ownerWebContentsId
          )
        }
      }
    }
  }

  #pushSkill(
    output: SkillDescriptor[],
    ids: Set<string>,
    scope: 'user' | 'workspace',
    relativePath: string,
    metadata: SkillMetadata,
    root: VerifiedDiscoveryRoot,
    stats: import('node:fs').Stats,
    ownerWebContentsId: number
  ): void {
    const baseId = `skill:${scope}:${slug(metadata.name)}`
    const id = uniqueId(baseId, ids)
    const grant = this.#grants.issue({
      ownerWebContentsId,
      kind: 'skill',
      id,
      scope,
      relativePath: safeRelativePath(relativePath),
      root: { device: root.device, inode: root.inode },
      file: capabilityFileIdentityFromDigest(stats, metadata.sourceSha256),
      workspace: scope === 'workspace'
        ? { device: root.device, inode: root.inode }
        : null
    })
    output.push({
      id,
      grantHandle: grant.grantHandle,
      name: boundedText(metadata.name, 'Unnamed skill'),
      description: boundedText(metadata.description, 'No description provided.'),
      scope,
      relativePath: safeRelativePath(relativePath),
      permissions: [...metadata.permissions]
    })
  }

  async #discoverPlugins(
    root: VerifiedDiscoveryRoot,
    scope: 'user' | 'workspace',
    output: PluginDescriptor[],
    ids: Set<string>,
    candidates: readonly string[],
    ownerWebContentsId: number
  ): Promise<void> {
    for (const candidate of candidates) {
      if (output.length >= MAX_DISCOVERED_ITEMS) return
      if (candidate.endsWith('.json')) {
        const verified = await verifyPathWithinRoot(root, candidate, 'file')
        const metadata = verified
          ? await readPluginMetadata(verified.absolutePath, verified.stats)
          : null
        if (metadata && verified) {
          this.#pushPlugin(
            output,
            ids,
            scope,
            candidate,
            metadata,
            root,
            verified.stats,
            ownerWebContentsId
          )
        }
        continue
      }
      const entries = await safeReadDirectory(root, candidate)
      for (const entry of entries) {
        if (output.length >= MAX_DISCOVERED_ITEMS) return
        if (!safeSegment(entry.name) || !entry.isDirectory()) continue
        const manifestRelativePath = `${candidate}/${entry.name}/.codex-plugin/plugin.json`
        const verified = await verifyPathWithinRoot(root, manifestRelativePath, 'file')
        const metadata = verified
          ? await readPluginMetadata(verified.absolutePath, verified.stats)
          : null
        if (metadata && verified) {
          this.#pushPlugin(
            output,
            ids,
            scope,
            manifestRelativePath,
            metadata,
            root,
            verified.stats,
            ownerWebContentsId
          )
        }
      }
    }
  }

  #pushPlugin(
    output: PluginDescriptor[],
    ids: Set<string>,
    scope: 'user' | 'workspace',
    relativePath: string,
    metadata: PluginMetadata,
    root: VerifiedDiscoveryRoot,
    stats: import('node:fs').Stats,
    ownerWebContentsId: number
  ): void {
    const baseId = `plugin:${scope}:${slug(metadata.name)}`
    const id = uniqueId(baseId, ids)
    const grant = this.#grants.issue({
      ownerWebContentsId,
      kind: 'plugin',
      id,
      scope,
      relativePath: safeRelativePath(relativePath),
      root: { device: root.device, inode: root.inode },
      file: capabilityFileIdentityFromDigest(stats, metadata.sourceSha256),
      workspace: scope === 'workspace'
        ? { device: root.device, inode: root.inode }
        : null
    })
    output.push({
      id,
      grantHandle: grant.grantHandle,
      name: boundedText(metadata.name, 'Unnamed plugin'),
      description: boundedText(metadata.description, 'No description provided.'),
      version: boundedText(metadata.version, 'unknown'),
      scope,
      relativePath: safeRelativePath(relativePath),
      permissions: [...metadata.permissions],
      enabled: false
    })
  }
}

function validateOptionalRoot(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 32_768 ||
    value.includes('\0') ||
    /[\r\n]/u.test(value) ||
    !isAbsolute(value) ||
    win32.isAbsolute(value) && process.platform !== 'win32' ||
    isDisallowedWindowsRoot(value)
  ) {
    throw new CapabilityRegistryError('invalid_input')
  }
  return resolve(value)
}

function isDisallowedWindowsRoot(value: string): boolean {
  if (process.platform !== 'win32' || !/^\\\\/u.test(value)) return false
  // Node may expose a local long path as \\?\C:\...; keep that form
  // usable while rejecting remote UNC, device, and namespaced UNC roots.
  if (/^\\\\\?[A-Za-z]:\\/u.test(value)) return false
  return /^\\\\(?:[?.]\\|[^\\])/u.test(value)
}

function validateWorkspaceIdentity(identityValue: unknown): CapabilityWorkspaceIdentity | undefined {
  if (identityValue === undefined) return undefined
  if (
    !isPlainRecord(identityValue) ||
    !hasOnlyKeys(identityValue, ['absolutePath', 'device', 'inode'])
  ) {
    throw new CapabilityRegistryError('invalid_input')
  }
  const absolutePath = validateOptionalRoot(identityValue.absolutePath)
  const device = validateIdentityPart(identityValue.device)
  const inode = validateIdentityPart(identityValue.inode)
  if (!absolutePath || device === '0' || inode === '0') {
    throw new CapabilityRegistryError('invalid_input')
  }
  return Object.freeze({ absolutePath, device, inode })
}

function isValidOwnerWebContentsId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function validateOwnerWebContentsId(value: unknown): asserts value is number {
  if (!isValidOwnerWebContentsId(value)) throw new CapabilityRegistryError('invalid_input')
}

function validateIdentityPart(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,64}$/u.test(value)) {
    throw new CapabilityRegistryError('invalid_input')
  }
  return value
}

function validateArguments(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value !== 'string' || value.length > MAX_COMMAND_ARGUMENTS) {
    throw new CapabilityRegistryError('invalid_input')
  }
  return value
}

function normalizeCapabilityId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 128) return null
  const first = value.trim().replace(/^[/@$]+/u, '').split(/\s+/u, 1)[0] ?? ''
  if (!SAFE_ID_PATTERN.test(first)) return null
  return first
}

function parsePlan(args: string): string[] {
  if (!args.trim()) return []
  return args
    .split(/[\n;,]+/u)
    .map((step) => boundedText(redactSensitiveText(step).trim(), '').trim())
    .filter(Boolean)
    .slice(0, MAX_PLAN_STEPS)
    .map((step) => step.slice(0, MAX_PLAN_STEP_TEXT))
}

function safeSegment(value: string): boolean {
  return SAFE_SEGMENT_PATTERN.test(value) &&
    value !== '.' &&
    value !== '..' &&
    !/[<>:"|?*\u0000-\u001f]/u.test(value) &&
    !value.endsWith('.') &&
    !value.endsWith(' ')
}

function safeRelativePath(value: string): string {
  const normalized = value.replaceAll(sep, '/').replaceAll('\\', '/')
  const segments = normalized.split('/').filter(Boolean)
  if (segments.length === 0 || segments.some((segment) => !safeSegment(segment))) return '<scope>'
  return segments.join('/').slice(0, 180)
}

function isSafeSkillRelativePath(value: string, scope: 'user' | 'workspace'): boolean {
  const normalized = safeRelativePath(value)
  if (normalized === '<scope>' || !normalized.toLowerCase().endsWith('/skill.md')) return false
  const segments = normalized.split('/')
  if (segments.length < 3) return false
  const expectedRoot = scope === 'user'
    ? (segments[0] === '.codex' || segments[0] === '.agents')
    : (segments[0] === '.agents' || segments[0] === '.codex')
  if (!expectedRoot) return false
  if (segments[1] !== 'skills') return false
  return segments.every(safeSegment)
}

interface VerifiedDiscoveryRoot {
  readonly absolutePath: string
  readonly device: string
  readonly inode: string
}

interface VerifiedCapabilityPath {
  readonly absolutePath: string
  readonly stats: import('node:fs').Stats
}

async function verifyDiscoveryRoot(
  root: string,
  expected?: CapabilityWorkspaceIdentity
): Promise<VerifiedDiscoveryRoot | null> {
  const absolutePath = resolve(root)
  try {
    const before = await fs.lstat(absolutePath, { bigint: true })
    if (!before.isDirectory() || before.isSymbolicLink()) return null
    const canonicalPath = resolve(await fs.realpath(absolutePath))
    if (pathComparisonKey(canonicalPath) !== pathComparisonKey(absolutePath)) return null
    const canonicalStats = await fs.lstat(canonicalPath, { bigint: true })
    if (
      !canonicalStats.isDirectory() ||
      canonicalStats.isSymbolicLink() ||
      !sameFileIdentity(before, canonicalStats)
    ) {
      return null
    }
    const device = String(canonicalStats.dev)
    const inode = String(canonicalStats.ino)
    if (
      expected !== undefined &&
      (expected.device !== '0' || expected.inode !== '0') &&
      (expected.device !== device || expected.inode !== inode)
    ) {
      return null
    }
    return Object.freeze({ absolutePath, device, inode })
  } catch {
    return null
  }
}

async function assertDiscoveryRootStable(root: VerifiedDiscoveryRoot): Promise<void> {
  const current = await verifyDiscoveryRoot(root.absolutePath, {
    absolutePath: root.absolutePath,
    device: root.device,
    inode: root.inode
  })
  if (
    !current ||
    pathComparisonKey(current.absolutePath) !== pathComparisonKey(root.absolutePath) ||
    current.device !== root.device ||
    current.inode !== root.inode
  ) {
    throw new CapabilityRegistryError('storage_error')
  }
}

async function verifyPathWithinRoot(
  root: VerifiedDiscoveryRoot,
  relativePath: string,
  expectedKind: 'file' | 'directory'
): Promise<VerifiedCapabilityPath | null> {
  const segments = relativePath.split('/').filter(Boolean)
  if (segments.length === 0 || segments.some((segment) => !safeSegment(segment))) return null
  const verifiedRoot = await verifyDiscoveryRoot(root.absolutePath, {
    absolutePath: root.absolutePath,
    device: root.device,
    inode: root.inode
  })
  if (!verifiedRoot) return null
  let current = verifiedRoot.absolutePath
  let finalStats: import('node:fs').Stats | null = null
  try {
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!
      current = join(current, segment)
      if (!isPathInsideRoot(verifiedRoot.absolutePath, current)) return null
      const stats = await fs.lstat(current)
      if (stats.isSymbolicLink()) return null
      const canonicalPath = resolve(await fs.realpath(current))
      if (
        pathComparisonKey(canonicalPath) !== pathComparisonKey(current) ||
        !isPathInsideRoot(verifiedRoot.absolutePath, canonicalPath)
      ) {
        return null
      }
      const canonicalStats = await fs.lstat(canonicalPath)
      if (canonicalStats.isSymbolicLink() || !sameFileIdentity(stats, canonicalStats)) return null
      const isFinal = index === segments.length - 1
      if (isFinal) {
        if (expectedKind === 'file' && !stats.isFile()) return null
        if (expectedKind === 'directory' && !stats.isDirectory()) return null
        finalStats = stats
      } else if (!stats.isDirectory()) {
        return null
      }
    }
  } catch {
    return null
  }
  return finalStats ? { absolutePath: current, stats: finalStats } : null
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const rootKey = pathComparisonKey(root)
  const candidateKey = pathComparisonKey(candidate)
  if (candidateKey === rootKey) return true
  const prefix = rootKey.endsWith(sep) ? rootKey : `${rootKey}${sep}`
  return candidateKey.startsWith(prefix)
}

function pathComparisonKey(value: string): string {
  const normalized = resolve(value).replace(/^\\\\\?\\/u, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function boundedText(value: unknown, fallback: string): string {
  const text = redactSensitiveText(typeof value === 'string' ? value : fallback).trim()
  return (text || fallback).slice(0, MAX_TEXT)
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return value
  return Buffer.from(value, 'utf8').subarray(0, maximumBytes).toString('utf8')
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function issueReviewHandle(): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const handle = `review_${randomBytes(32).toString('base64url')}`
    if (REVIEW_HANDLE_PATTERN.test(handle)) return handle
  }
  throw new CapabilityRegistryError('storage_error')
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function capabilityFileIdentity(
  stats: import('node:fs').Stats,
  source: string
): {
  device: string
  inode: string
  size: number
  mtimeMs: number
  contentSha256: string
} {
  return capabilityFileIdentityFromDigest(stats, sha256(source))
}

function capabilityFileIdentityFromDigest(
  stats: import('node:fs').Stats,
  contentSha256: string
): {
  device: string
  inode: string
  size: number
  mtimeMs: number
  contentSha256: string
} {
  return {
    device: String(stats.dev),
    inode: String(stats.ino),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    contentSha256
  }
}

function slug(value: string): string {
  const result = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64)
  return result || 'unnamed'
}

function uniqueId(base: string, ids: Set<string>): string {
  let candidate = base
  let suffix = 2
  while (ids.has(candidate)) candidate = `${base}-${suffix++}`
  ids.add(candidate)
  return candidate
}

async function safeReadDirectory(
  root: VerifiedDiscoveryRoot,
  relativePath: string
): Promise<readonly import('node:fs').Dirent[]> {
  const verified = await verifyPathWithinRoot(root, relativePath, 'directory')
  if (!verified) return []
  let directory: Awaited<ReturnType<typeof fs.opendir>> | null = null
  const entries: import('node:fs').Dirent[] = []
  try {
    // opendir/read bounds the number of entries consumed.  Do not call
    // readdir() first, because a user-controlled directory can be enormous.
    directory = await fs.opendir(verified.absolutePath)
    while (entries.length < MAX_DIRECTORY_ENTRIES) {
      const entry = await directory.read()
      if (!entry) break
      entries.push(entry)
    }
  } catch {
    return []
  } finally {
    await directory?.close().catch(() => undefined)
  }
  const after = await verifyPathWithinRoot(root, relativePath, 'directory')
  if (!after || !sameFileIdentity(verified.stats, after.stats)) return []
  return entries.sort((left, right) => left.name.localeCompare(right.name))
}

async function safeLstat(path: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.lstat(path)
  } catch {
    return null
  }
}

async function readBoundedFile(
  path: string,
  maximumBytes: number,
  expectedStats?: import('node:fs').Stats
): Promise<string | null> {
  const initial = expectedStats ?? await safeLstat(path)
  if (
    !initial ||
    initial.isSymbolicLink() ||
    !initial.isFile() ||
    initial.size > maximumBytes ||
    hasMultipleLinks(initial)
  ) return null

  let handle: FileHandle | null = null
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
    handle = await fs.open(path, fsConstants.O_RDONLY | noFollow)
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.size > maximumBytes ||
      !sameFileIdentity(initial, opened) ||
      hasMultipleLinks(opened)
    ) return null

    const bytes = await readFileHandleBounded(handle, maximumBytes)
    const after = await handle.stat()
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.size > maximumBytes ||
      bytes.length > maximumBytes ||
      !sameFileIdentity(opened, after)
    ) return null

    const finalPath = resolve(await fs.realpath(path))
    const finalStats = await fs.lstat(path)
    if (
      finalStats.isSymbolicLink() ||
      !finalStats.isFile() ||
      !sameFileIdentity(opened, finalStats) ||
      pathComparisonKey(finalPath) !== pathComparisonKey(path)
    ) return null
    return bytes.toString('utf8')
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function readFileHandleBounded(handle: FileHandle, maximumBytes: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maximumBytes + 1)
  let offset = 0
  while (offset < buffer.length) {
    const result = await handle.read(buffer, offset, buffer.length - offset, offset)
    if (result.bytesRead <= 0) break
    offset += result.bytesRead
  }
  return buffer.subarray(0, offset)
}

async function readSkillMetadata(
  path: string,
  fallbackName: string,
  expectedStats?: import('node:fs').Stats
): Promise<SkillMetadata | null> {
  const text = await readBoundedFile(path, MAX_SKILL_BYTES, expectedStats)
  if (text === null) return null
  const frontmatter = parseFrontmatter(text)
  const name = boundedText(frontmatter.name ?? fallbackName.replace(/\.md$/iu, ''), fallbackName)
  const description = boundedText(
    frontmatter.description ?? firstDescriptionLine(text),
    'No description provided.'
  )
  return {
    name,
    description,
    permissions: permissionsFromMetadata(frontmatter),
    sourceSha256: sha256(text)
  }
}

async function readPluginMetadata(
  path: string,
  expectedStats?: import('node:fs').Stats
): Promise<PluginMetadata | null> {
  const text = await readBoundedFile(path, MAX_PLUGIN_BYTES, expectedStats)
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isPlainRecord(parsed)) return null
  const name = boundedText(
    typeof parsed.displayName === 'string' ? parsed.displayName : parsed.name,
    'Unnamed plugin'
  )
  const description = boundedText(parsed.description, 'No description provided.')
  const version = boundedText(parsed.version, 'unknown')
  return {
    name,
    description,
    version,
    permissions: permissionsFromMetadata(parsed),
    sourceSha256: sha256(text)
  }
}

function parseFrontmatter(text: string): Record<string, unknown> {
  const normalized = text.replace(/\r\n?/gu, '\n')
  if (!normalized.startsWith('---\n')) return {}
  const endMatch = /\n---(?:\n|$)/u.exec(normalized.slice(4))
  if (!endMatch || endMatch.index === undefined) return {}
  const end = 4 + endMatch.index
  const result: Record<string, unknown> = {}
  for (const line of normalized.slice(4, end).split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]{0,48})\s*:\s*(.*)$/u.exec(line)
    if (!match) continue
    const key = match[1]!.toLowerCase()
    const raw = match[2]!.trim().replace(/^['"]|['"]$/gu, '')
    result[key] = raw
  }
  return result
}

function firstDescriptionLine(text: string): string {
  for (const line of text.replace(/\r\n?/gu, '\n').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed === '---' || trimmed.startsWith('#')) continue
    return trimmed
  }
  return 'No description provided.'
}

function stripFrontmatter(text: string): string {
  const normalized = text.replace(/\r\n?/gu, '\n')
  if (!normalized.startsWith('---\n')) return normalized
  const endMatch = /\n---(?:\n|$)/u.exec(normalized.slice(4))
  if (!endMatch || endMatch.index === undefined) return normalized
  return normalized.slice(4 + endMatch.index + endMatch[0].length)
}

function permissionsFromMetadata(value: Record<string, unknown>): CapabilityPermission[] {
  const result = new Set<CapabilityPermission>()
  const candidates: string[] = []
  let declaresScripts = false
  let declaresMcp = false
  let declaresCommands = false
  for (const key of [
    'permissions',
    'permission',
    'allowed-tools',
    'tools',
    'capabilities',
    'mcpServers',
    'commands',
    'scripts'
  ]) {
    const candidate = value[key]
    if (typeof candidate === 'string') candidates.push(candidate)
    else if (Array.isArray(candidate)) {
      for (const item of candidate) if (typeof item === 'string') candidates.push(item)
    }
    if (key === 'scripts' && candidate !== undefined) declaresScripts = true
    if (key === 'mcpServers' && candidate !== undefined) declaresMcp = true
    if (key === 'commands' && hasDeclaredValue(candidate)) declaresCommands = true
  }
  const text = candidates.join(' ').toLowerCase()
  if (/read|file|workspace|inspect/u.test(text)) result.add('read')
  if (/write|edit|create|delete/u.test(text)) result.add('write')
  if (/exec|shell|command|terminal|script/u.test(text)) result.add('execute')
  if (/network|web|http|mcp/u.test(text)) result.add('network')
  if (/approval|approve|consent/u.test(text)) result.add('approval')
  // Object-valued declarations carry the privilege even when their keys do
  // not contain a recognizable keyword. Never infer a harmless read-only
  // capability from a script or MCP server declaration.
  if (declaresScripts) result.add('execute')
  if (declaresMcp) {
    result.add('execute')
    result.add('network')
  }
  if (declaresCommands) result.add('execute')
  if (result.size > 0 && (result.has('write') || result.has('execute') || result.has('network'))) {
    result.add('approval')
  }
  if (result.size === 0) result.add('read')
  return PERMISSIONS.filter((permission) => result.has(permission))
}

function hasDeclaredValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return isPlainRecord(value) && Object.keys(value).length > 0
}

function cloneBuiltinCommands(): CapabilityCommandDescriptor[] {
  return BUILTIN_COMMANDS.map((command) => ({
    ...command,
    aliases: [...command.aliases],
    permissions: [...command.permissions]
  }))
}

function sameFileIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint }
): boolean {
  if (left.dev !== 0 && left.dev !== 0n && right.dev !== 0 && right.dev !== 0n) {
    if (String(left.dev) !== String(right.dev)) return false
  }
  if (left.ino !== 0 && left.ino !== 0n && right.ino !== 0 && right.ino !== 0n) {
    if (String(left.ino) !== String(right.ino)) return false
  }
  return true
}

function hasMultipleLinks(stats: { nlink: number | bigint }): boolean {
  return typeof stats.nlink === 'bigint' ? stats.nlink > 1n : stats.nlink > 1
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}
