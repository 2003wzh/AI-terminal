import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants, promises as fs } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32
} from 'node:path'

import type {
  GitFileSummary,
  GitSummary,
  WorkspaceDirectoryEntry,
  WorkspaceDirectoryInput,
  WorkspaceDirectoryResult,
  WorkspaceFileInput,
  WorkspaceFileResult,
  WorkspaceWriteInput
} from '../../shared/contracts'
import { redactSensitiveContent } from '../security/redaction.ts'
import {
  SelectionTokenStore,
  type ResolvedWorkspaceRecord
} from './selection-token-store.ts'

export type WorkspaceToolErrorCode =
  | 'invalid_request'
  | 'workspace_unavailable'
  | 'workspace_changed'
  | 'invalid_relative_path'
  | 'sensitive_path'
  | 'path_not_found'
  | 'path_not_file'
  | 'path_not_directory'
  | 'path_outside_workspace'
  | 'reparse_point_rejected'
  | 'hard_link_rejected'
  | 'file_too_large'
  | 'invalid_text_file'
  | 'write_conflict'
  | 'write_not_allowed'
  | 'write_failed'
  | 'cancelled'
  | 'git_unavailable'
  | 'git_timeout'
  | 'git_failed'
  | 'git_output_too_large'
  | 'git_invalid_output'

const WORKSPACE_TOOL_ERROR_MESSAGES: Readonly<Record<WorkspaceToolErrorCode, string>> = Object.freeze({
  invalid_request: 'The workspace tool request is invalid.',
  workspace_unavailable: 'The selected workspace is unavailable.',
  workspace_changed: 'The selected workspace changed during the operation.',
  invalid_relative_path: 'The workspace-relative path is invalid.',
  sensitive_path: 'Reading this protected local file is not allowed.',
  path_not_found: 'The requested workspace file was not found.',
  path_not_file: 'The requested workspace path is not a regular file.',
  path_not_directory: 'The requested workspace path is not a directory.',
  path_outside_workspace: 'The requested path is outside the selected workspace.',
  reparse_point_rejected: 'Symbolic links and junctions are not allowed for this operation.',
  hard_link_rejected: 'Files with multiple hard links are not allowed for this operation.',
  file_too_large: 'The requested file exceeds the safe read limit.',
  invalid_text_file: 'The requested file is not bounded UTF-8 text.',
  write_conflict: 'The workspace file changed; the write was not applied.',
  write_not_allowed: 'Writing this protected workspace path is not allowed.',
  write_failed: 'The workspace file could not be written safely.',
  cancelled: 'The workspace tool operation was cancelled.',
  git_unavailable: 'Git is unavailable for this workspace.',
  git_timeout: 'Git did not finish within the safe time limit.',
  git_failed: 'Git could not summarize this workspace.',
  git_output_too_large: 'Git output exceeded the safe size limit.',
  git_invalid_output: 'Git returned an invalid bounded result.'
})

export class WorkspaceToolError extends Error {
  readonly code: WorkspaceToolErrorCode
  readonly retryable: boolean

  constructor(code: WorkspaceToolErrorCode, retryable = false) {
    super(WORKSPACE_TOOL_ERROR_MESSAGES[code])
    this.name = 'WorkspaceToolError'
    this.code = code
    this.retryable = retryable
    this.stack = `${this.name}: ${this.message}`
  }
}

export interface WorkspaceToolExecutionOptions {
  signal?: AbortSignal
}

export interface WorkspaceSearchInput {
  workspaceToken: string
  relativePath: string
  query: string
  caseSensitive: boolean
}

export interface WorkspaceSearchMatch {
  relativePath: string
  line: number
  column: number
  preview: string
}

export interface WorkspaceSearchResult {
  matches: WorkspaceSearchMatch[]
  truncated: boolean
}

export interface WorkspaceGitDiffResult {
  patch: string
  files: readonly string[]
  untrackedFiles: readonly string[]
  truncated: boolean
}

export interface WorkspaceReplaceInput {
  workspaceToken: string
  relativePath: string
  oldText: string
  newText: string
  expectedRevision: string
}

export interface WorkspaceReplaceResult {
  relativePath: string
  revision: string
  replacements: 1
}

export interface WorkspaceToolServiceOptions {
  selections: SelectionTokenStore
  maxFileBytes?: number
  maxResultCharacters?: number
  maxWriteBytes?: number
  maxDirectoryEntries?: number
  maxDirectoryResultCharacters?: number
  gitExecutable?: string
  gitTimeoutMs?: number
  maxGitOutputBytes?: number
  maxGitFiles?: number
  maxSearchResults?: number
  maxSearchFiles?: number
  maxSearchResultCharacters?: number
  maxSearchSnippetCharacters?: number
  environmentSource?: NodeJS.ProcessEnv
  protectedAbsoluteRoots?: readonly string[]
}

interface ResolvedWorkspacePath {
  absolutePath: string
  stats: Awaited<ReturnType<typeof fs.lstat>>
}

interface GitStatusEntry {
  relativePath: string
  originalRelativePath?: string
  status: GitFileSummary['status']
}

interface GitDiffStat {
  additions: number
  deletions: number
}

interface MutableGitSummary extends GitDiffStat {
  status: GitFileSummary['status']
}

interface BoundedProcessOptions {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  maxOutputBytes: number
  signal?: AbortSignal
}

interface GitIndexEntry {
  readonly oid: string
  readonly mode: string
}

interface SafeGitContext {
  readonly common: Omit<BoundedProcessOptions, 'args'>
  readonly repositoryArguments: readonly string[]
  readonly indexEntries: ReadonlyMap<string, GitIndexEntry>
  readonly headEntries: ReadonlyMap<string, GitIndexEntry>
  readonly branch: string
  readonly objectFormat: 'sha1' | 'sha256'
  readonly untrackedEntries: readonly GitStatusEntry[]
  readonly untrackedTruncated: boolean
}

interface SafeGitWorktreeChange {
  readonly content: Buffer | null
  readonly omitted: boolean
}

interface SafeGitSnapshot {
  readonly entries: readonly GitStatusEntry[]
  readonly worktreeChanges: ReadonlyMap<string, SafeGitWorktreeChange>
  readonly truncated: boolean
}

interface WriteLockState {
  tail: Promise<void>
  pending: number
}

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024
const MAX_CONFIGURED_FILE_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_DIRECTORY_ENTRIES = 512
const MAX_CONFIGURED_DIRECTORY_ENTRIES = 4_096
const DEFAULT_MAX_DIRECTORY_RESULT_CHARACTERS = 64 * 1024
const MAX_CONFIGURED_DIRECTORY_RESULT_CHARACTERS = 1024 * 1024
const DEFAULT_GIT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_GIT_OUTPUT_BYTES = 1024 * 1024
const MAX_CONFIGURED_GIT_OUTPUT_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_GIT_FILES = 10_000
const MAX_CONFIGURED_GIT_FILES = 20_000
const MAX_REVIEW_DIFF_FILES = 128
const MAX_REVIEW_PATH_ARGUMENT_CHARACTERS = 16 * 1024
const MAX_REVIEW_PATCH_CHARACTERS = 384 * 1024
const MAX_REVIEW_ATTRIBUTE_BYTES = 256 * 1024
const MAX_REVIEW_UNTRACKED_SCAN_ENTRIES = 20_000
const MAX_REVIEW_WORKTREE_SCAN_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_SEARCH_RESULTS = 256
const MAX_CONFIGURED_SEARCH_RESULTS = 4_096
const DEFAULT_MAX_SEARCH_FILES = 2_048
const MAX_CONFIGURED_SEARCH_FILES = 20_000
const DEFAULT_MAX_SEARCH_RESULT_CHARACTERS = 64 * 1024
const MAX_CONFIGURED_SEARCH_RESULT_CHARACTERS = 512 * 1024
const DEFAULT_MAX_SEARCH_SNIPPET_CHARACTERS = 240
const MAX_CONFIGURED_SEARCH_SNIPPET_CHARACTERS = 2_048
const MAX_SEARCH_QUERY_CHARACTERS = 4_096
const SEARCH_DIRECTORY_ENTRY_CAP = 4_096
const SEARCH_CONTEXT_CHARACTERS = 96
const MAX_RELATIVE_PATH_CHARACTERS = 4_096
const MAX_PATH_SEGMENT_CHARACTERS = 255
const MAX_GIT_BRANCH_CHARACTERS = 256
const MAX_DIFF_LINES = 1_000_000_000
const GIT_METADATA_FILE_LIMIT = 4_096
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu
const INVALID_WINDOWS_SEGMENT_CHARACTER = /[<>:"|?*\u0000-\u001f]/u
const WORKSPACE_TOKEN_PATTERN = /^ws_[A-Za-z0-9_-]{43}$/u
const SENSITIVE_EXACT_FILE_NAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  'auth.json',
  'credentials',
  'credentials.json',
  'access-profiles.json',
  'conversation-history.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519'
])
const SENSITIVE_DIRECTORY_NAMES = new Set(['.ssh'])
const SENSITIVE_FILE_EXTENSION = /\.(?:pem|key|p12|pfx)$/iu
const PROTECTED_WRITE_DIRECTORY_NAMES = new Set(['.git', '.codex', '.agents', 'node_modules'])
const PROTECTED_WRITE_FILE_NAMES = new Set(['agents.md'])

export class WorkspaceToolService {
  readonly #selections: SelectionTokenStore
  readonly #maxFileBytes: number
  readonly #maxResultCharacters: number
  readonly #maxWriteBytes: number
  readonly #maxDirectoryEntries: number
  readonly #maxDirectoryResultCharacters: number
  readonly #gitExecutable: string
  readonly #gitTimeoutMs: number
  readonly #maxGitOutputBytes: number
  readonly #maxGitFiles: number
  readonly #maxSearchResults: number
  readonly #maxSearchFiles: number
  readonly #maxSearchResultCharacters: number
  readonly #maxSearchSnippetCharacters: number
  readonly #environmentSource: NodeJS.ProcessEnv
  readonly #protectedAbsoluteRoots: string[]
  readonly #writeLocks = new Map<string, WriteLockState>()

  constructor(options: WorkspaceToolServiceOptions) {
    if (!isPlainRecord(options) || !(options.selections instanceof SelectionTokenStore)) {
      throw new WorkspaceToolError('invalid_request')
    }
    this.#selections = options.selections
    this.#maxFileBytes = boundedInteger(
      options.maxFileBytes,
      DEFAULT_MAX_FILE_BYTES,
      1,
      MAX_CONFIGURED_FILE_BYTES
    )
    this.#maxResultCharacters = boundedInteger(
      options.maxResultCharacters,
      this.#maxFileBytes,
      1,
      MAX_CONFIGURED_FILE_BYTES
    )
    this.#maxWriteBytes = boundedInteger(
      options.maxWriteBytes,
      2 * 1024 * 1024,
      1,
      MAX_CONFIGURED_FILE_BYTES
    )
    this.#maxDirectoryEntries = boundedInteger(
      options.maxDirectoryEntries,
      DEFAULT_MAX_DIRECTORY_ENTRIES,
      1,
      MAX_CONFIGURED_DIRECTORY_ENTRIES
    )
    this.#maxDirectoryResultCharacters = boundedInteger(
      options.maxDirectoryResultCharacters,
      DEFAULT_MAX_DIRECTORY_RESULT_CHARACTERS,
      64,
      MAX_CONFIGURED_DIRECTORY_RESULT_CHARACTERS
    )
    this.#gitExecutable = validateGitExecutable(options.gitExecutable ?? 'git')
    this.#gitTimeoutMs = boundedInteger(options.gitTimeoutMs, DEFAULT_GIT_TIMEOUT_MS, 100, 60_000)
    this.#maxGitOutputBytes = boundedInteger(
      options.maxGitOutputBytes,
      DEFAULT_MAX_GIT_OUTPUT_BYTES,
      128,
      MAX_CONFIGURED_GIT_OUTPUT_BYTES
    )
    this.#maxGitFiles = boundedInteger(
      options.maxGitFiles,
      DEFAULT_MAX_GIT_FILES,
      1,
      MAX_CONFIGURED_GIT_FILES
    )
    this.#maxSearchResults = boundedInteger(
      options.maxSearchResults,
      DEFAULT_MAX_SEARCH_RESULTS,
      1,
      MAX_CONFIGURED_SEARCH_RESULTS
    )
    this.#maxSearchFiles = boundedInteger(
      options.maxSearchFiles,
      DEFAULT_MAX_SEARCH_FILES,
      1,
      MAX_CONFIGURED_SEARCH_FILES
    )
    this.#maxSearchResultCharacters = boundedInteger(
      options.maxSearchResultCharacters,
      DEFAULT_MAX_SEARCH_RESULT_CHARACTERS,
      128,
      MAX_CONFIGURED_SEARCH_RESULT_CHARACTERS
    )
    this.#maxSearchSnippetCharacters = boundedInteger(
      options.maxSearchSnippetCharacters,
      DEFAULT_MAX_SEARCH_SNIPPET_CHARACTERS,
      32,
      MAX_CONFIGURED_SEARCH_SNIPPET_CHARACTERS
    )
    this.#environmentSource = options.environmentSource ?? process.env
    this.#protectedAbsoluteRoots = parseProtectedRoots(options.protectedAbsoluteRoots)
  }

  async readFile(
    input: WorkspaceFileInput,
    ownerWebContentsId: number,
    options: WorkspaceToolExecutionOptions = {}
  ): Promise<WorkspaceFileResult> {
    assertReadFileInput(input)
    assertOwner(ownerWebContentsId)
    assertSignal(options.signal)
    throwIfAborted(options.signal)

    const relativePath = normalizeWorkspaceRelativePath(input.relativePath)
    if (isSensitiveRelativePath(relativePath)) throw new WorkspaceToolError('sensitive_path')

    const workspace = await this.#resolveWorkspace(input.workspaceToken, ownerWebContentsId)
    await verifyWorkspaceRoot(workspace, options.signal)
    const resolvedPath = await resolveExistingWorkspacePath(workspace, relativePath, options.signal)
    if (this.#isProtectedAbsolutePath(resolvedPath.absolutePath)) {
      throw new WorkspaceToolError('sensitive_path')
    }
    if (!resolvedPath.stats.isFile()) throw new WorkspaceToolError('path_not_file')
    assertSingleLinkRegularFile(resolvedPath.stats)
    if (resolvedPath.stats.size > this.#maxFileBytes) {
      throw new WorkspaceToolError('file_too_large')
    }

    throwIfAborted(options.signal)
    let handle: FileHandle | null = null
    try {
      handle = await fs.open(resolvedPath.absolutePath, 'r')
      const openedStats = await handle.stat()
      if (!openedStats.isFile()) throw new WorkspaceToolError('path_not_file')
      assertSingleLinkRegularFile(openedStats)
      if (!sameFileIdentity(resolvedPath.stats, openedStats)) {
        throw new WorkspaceToolError('workspace_changed', true)
      }
      const bytes = await readBoundedFile(handle, this.#maxFileBytes, options.signal)
      const finalRealPath = resolve(await fs.realpath(resolvedPath.absolutePath))
      if (
        !isPathInsideWorkspace(workspace.absolutePath, finalRealPath) ||
        pathComparisonKey(finalRealPath) !== pathComparisonKey(resolvedPath.absolutePath)
      ) {
        throw new WorkspaceToolError('workspace_changed', true)
      }

      let text: string
      try {
        if (bytes.includes(0)) throw new Error('binary')
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        throw new WorkspaceToolError('invalid_text_file')
      }

      const redacted = redactSensitiveContent(text)
      const bounded = truncateText(redacted, this.#maxResultCharacters)
      return Object.freeze({
        relativePath: safeWorkspaceResultPath(relativePath),
        content: bounded.text,
        revision: createHash('sha256').update(bytes).digest('hex'),
        truncated: bounded.truncated
      })
    } catch (error) {
      if (error instanceof WorkspaceToolError) throw error
      if (options.signal?.aborted) throw new WorkspaceToolError('cancelled')
      throw fixedFileSystemError(error)
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  async listDirectory(
    input: WorkspaceDirectoryInput,
    ownerWebContentsId: number,
    options: WorkspaceToolExecutionOptions = {}
  ): Promise<WorkspaceDirectoryResult> {
    assertListDirectoryInput(input)
    assertOwner(ownerWebContentsId)
    assertSignal(options.signal)
    throwIfAborted(options.signal)

    const relativePath = normalizeWorkspaceDirectoryPath(input.relativePath)
    if (relativePath !== '.' && isSensitiveRelativePath(relativePath)) {
      throw new WorkspaceToolError('sensitive_path')
    }

    const workspace = await this.#resolveWorkspace(input.workspaceToken, ownerWebContentsId)
    await verifyWorkspaceRoot(workspace, options.signal)
    let resolvedPath: ResolvedWorkspacePath
    if (relativePath === '.') {
      try {
        resolvedPath = {
          absolutePath: workspace.absolutePath,
          stats: await fs.lstat(workspace.absolutePath)
        }
      } catch {
        if (options.signal?.aborted) throw new WorkspaceToolError('cancelled')
        throw new WorkspaceToolError('workspace_changed', true)
      }
    } else {
      resolvedPath = await resolveExistingWorkspacePath(workspace, relativePath, options.signal)
    }
    throwIfAborted(options.signal)
    if (this.#isProtectedAbsolutePath(resolvedPath.absolutePath)) {
      throw new WorkspaceToolError('sensitive_path')
    }
    if (!resolvedPath.stats.isDirectory()) throw new WorkspaceToolError('path_not_directory')

    const candidates: WorkspaceDirectoryEntry[] = []
    let eligibleEntryCount = 0
    let directory: Awaited<ReturnType<typeof fs.opendir>> | null = null
    try {
      directory = await fs.opendir(resolvedPath.absolutePath)
      while (true) {
        throwIfAborted(options.signal)
        const dirent = await directory.read()
        throwIfAborted(options.signal)
        if (!dirent) break

        let entryRelativePath: string
        try {
          entryRelativePath = normalizeWorkspaceRelativePath(
            relativePath === '.' ? dirent.name : `${relativePath}/${dirent.name}`
          )
        } catch {
          continue
        }
        if (isSensitiveRelativePath(entryRelativePath)) continue

        const candidatePath = resolve(resolvedPath.absolutePath, dirent.name)
        if (
          !isPathInsideWorkspace(workspace.absolutePath, candidatePath) ||
          this.#isProtectedAbsolutePath(candidatePath)
        ) {
          continue
        }

        let entryStats: Awaited<ReturnType<typeof fs.lstat>>
        let canonicalPath: string
        try {
          entryStats = await fs.lstat(candidatePath)
          throwIfAborted(options.signal)
          if (entryStats.isSymbolicLink()) continue
          if (!entryStats.isFile() && !entryStats.isDirectory()) continue
          canonicalPath = resolve(await fs.realpath(candidatePath))
          throwIfAborted(options.signal)
        } catch (error) {
          if (error instanceof WorkspaceToolError) throw error
          if (options.signal?.aborted) throw new WorkspaceToolError('cancelled')
          if (isNodeErrorCode(error, 'ENOENT') || isNodeErrorCode(error, 'ENOTDIR')) continue
          throw new WorkspaceToolError('workspace_unavailable', true)
        }
        if (
          !isPathInsideWorkspace(workspace.absolutePath, canonicalPath) ||
          pathComparisonKey(canonicalPath) !== pathComparisonKey(candidatePath) ||
          this.#isProtectedAbsolutePath(canonicalPath)
        ) {
          continue
        }

        const safeRelativePath = safeWorkspaceResultPath(entryRelativePath)
        if (safeRelativePath !== entryRelativePath) continue
        eligibleEntryCount = Math.min(Number.MAX_SAFE_INTEGER, eligibleEntryCount + 1)
        insertBoundedDirectoryEntry(
          candidates,
          Object.freeze({
            relativePath: safeRelativePath,
            kind: entryStats.isDirectory() ? 'directory' : 'file'
          }),
          this.#maxDirectoryEntries
        )
      }

      throwIfAborted(options.signal)
      const finalStats = await fs.lstat(resolvedPath.absolutePath)
      const finalCanonicalPath = resolve(await fs.realpath(resolvedPath.absolutePath))
      throwIfAborted(options.signal)
      if (
        finalStats.isSymbolicLink() ||
        !finalStats.isDirectory() ||
        !sameFileIdentity(resolvedPath.stats, finalStats) ||
        pathComparisonKey(finalCanonicalPath) !== pathComparisonKey(resolvedPath.absolutePath)
      ) {
        throw new WorkspaceToolError('workspace_changed', true)
      }

      return buildBoundedDirectoryResult(
        candidates,
        eligibleEntryCount,
        this.#maxDirectoryResultCharacters
      )
    } catch (error) {
      if (error instanceof WorkspaceToolError) throw error
      if (options.signal?.aborted) throw new WorkspaceToolError('cancelled')
      throw fixedDirectorySystemError(error)
    } finally {
      await directory?.close().catch(() => undefined)
    }
  }

  async searchFiles(
    input: WorkspaceSearchInput,
    ownerWebContentsId: number,
    options: WorkspaceToolExecutionOptions = {}
  ): Promise<WorkspaceSearchResult> {
    assertSearchFilesInput(input)
    assertOwner(ownerWebContentsId)
    assertSignal(options.signal)
    throwIfAborted(options.signal)

    const relativePath = normalizeWorkspaceDirectoryPath(input.relativePath)
    if (relativePath !== '.' && isSensitiveRelativePath(relativePath)) {
      throw new WorkspaceToolError('sensitive_path')
    }
    if (isSearchExcludedRelativePath(relativePath)) {
      throw new WorkspaceToolError('sensitive_path')
    }

    const workspace = await this.#resolveWorkspace(input.workspaceToken, ownerWebContentsId)
    await verifyWorkspaceRoot(workspace, options.signal)
    if (this.#isProtectedAbsolutePath(workspace.absolutePath)) {
      throw new WorkspaceToolError('sensitive_path')
    }

    let root: ResolvedWorkspacePath
    if (relativePath === '.') {
      try {
        root = {
          absolutePath: workspace.absolutePath,
          stats: await fs.lstat(workspace.absolutePath)
        }
      } catch (error) {
        if (options.signal?.aborted) throw new WorkspaceToolError('cancelled')
        throw fixedDirectorySystemError(error)
      }
    } else {
      root = await resolveExistingWorkspacePath(workspace, relativePath, options.signal)
    }
    throwIfAborted(options.signal)
    if (this.#isProtectedAbsolutePath(root.absolutePath)) {
      throw new WorkspaceToolError('sensitive_path')
    }
    if (!root.stats.isFile() && !root.stats.isDirectory()) {
      throw new WorkspaceToolError('path_not_directory')
    }

    const needle = input.caseSensitive ? input.query : input.query.toLowerCase()
    const matches: WorkspaceSearchMatch[] = []
    let truncated = false
    let visitedFiles = 0
    let visitedEntries = 0

    const visit = async (candidate: ResolvedWorkspacePath, candidateRelativePath: string): Promise<void> => {
      throwIfAborted(options.signal)
      if (truncated) return
      if (isSearchExcludedRelativePath(candidateRelativePath)) return
      if (this.#isProtectedAbsolutePath(candidate.absolutePath)) return

      if (candidate.stats.isDirectory()) {
        const names: string[] = []
        let directory: Awaited<ReturnType<typeof fs.opendir>> | null = null
        try {
          directory = await fs.opendir(candidate.absolutePath)
          while (true) {
            throwIfAborted(options.signal)
            const dirent = await directory.read()
            if (!dirent) break
            if (++visitedEntries > this.#maxSearchFiles * 4) {
              truncated = true
              break
            }
            if (names.length >= SEARCH_DIRECTORY_ENTRY_CAP) {
              truncated = true
              break
            }
            if (!isSafeSearchEntryName(dirent.name)) continue
            names.push(dirent.name)
          }
        } catch (error) {
          if (error instanceof WorkspaceToolError) throw error
          if (options.signal?.aborted) throw new WorkspaceToolError('cancelled')
          // A directory which disappears or becomes inaccessible is skipped.
          return
        } finally {
          await directory?.close().catch(() => undefined)
        }
        names.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
        for (const name of names) {
          throwIfAborted(options.signal)
          if (truncated) return
          let childRelativePath: string
          try {
            childRelativePath = normalizeWorkspaceRelativePath(
              candidateRelativePath === '.' ? name : `${candidateRelativePath}/${name}`
            )
          } catch {
            continue
          }
          if (isSearchExcludedRelativePath(childRelativePath)) continue
          const childPath = resolve(candidate.absolutePath, name)
          if (!isPathInsideWorkspace(workspace.absolutePath, childPath)) continue

          let childStats: Awaited<ReturnType<typeof fs.lstat>>
          let canonicalPath: string
          try {
            childStats = await fs.lstat(childPath)
            throwIfAborted(options.signal)
            if (childStats.isSymbolicLink()) continue
            if (!childStats.isFile() && !childStats.isDirectory()) continue
            canonicalPath = resolve(await fs.realpath(childPath))
            throwIfAborted(options.signal)
          } catch (error) {
            if (error instanceof WorkspaceToolError) throw error
            if (options.signal?.aborted) throw new WorkspaceToolError('cancelled')
            continue
          }
          if (
            !isPathInsideWorkspace(workspace.absolutePath, canonicalPath) ||
            pathComparisonKey(canonicalPath) !== pathComparisonKey(childPath) ||
            this.#isProtectedAbsolutePath(canonicalPath)
          ) {
            continue
          }
          await visit(
            { absolutePath: canonicalPath, stats: childStats },
            childRelativePath
          )
        }
        return
      }

      if (!candidate.stats.isFile()) return
      assertSingleLinkRegularFile(candidate.stats)
      if (++visitedFiles > this.#maxSearchFiles) {
        truncated = true
        return
      }
      if (candidate.stats.size > this.#maxFileBytes) return

      let handle: FileHandle | null = null
      try {
        handle = await fs.open(candidate.absolutePath, 'r')
        const openedStats = await handle.stat()
        if (!openedStats.isFile() || !sameFileIdentity(candidate.stats, openedStats)) return
        assertSingleLinkRegularFile(openedStats)
        const bytes = await readBoundedFile(handle, this.#maxFileBytes, options.signal)
        const finalRealPath = resolve(await fs.realpath(candidate.absolutePath))
        if (
          !isPathInsideWorkspace(workspace.absolutePath, finalRealPath) ||
          pathComparisonKey(finalRealPath) !== pathComparisonKey(candidate.absolutePath)
        ) {
          return
        }
        let text: string
        try {
          if (bytes.includes(0) || containsUnsafeControlCharacters(bytes)) throw new Error('binary')
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        } catch {
          return
        }

        const searchText = input.caseSensitive ? text : text.toLowerCase()
        const lines = text.split(/\r?\n/u)
        const searchLines = searchText.split(/\r?\n/u)
        for (let lineIndex = 0; lineIndex < searchLines.length; lineIndex += 1) {
          throwIfAborted(options.signal)
          const line = searchLines[lineIndex]!
          let offset = 0
          while (offset <= line.length - needle.length) {
            const matchOffset = line.indexOf(needle, offset)
            if (matchOffset < 0) break
            const originalLine = lines[lineIndex] ?? ''
            const preview = buildSearchPreview(
              originalLine,
              matchOffset,
              input.query.length,
              this.#maxSearchSnippetCharacters
            )
            const match = Object.freeze({
              relativePath: safeWorkspaceResultPath(candidateRelativePath),
              line: lineIndex + 1,
              column: matchOffset + 1,
              preview
            })
            const nextMatches = [...matches, match]
            if (
              nextMatches.length > this.#maxSearchResults ||
              JSON.stringify({ matches: nextMatches, truncated: true }).length >
                this.#maxSearchResultCharacters
            ) {
              truncated = true
              return
            }
            matches.push(match)
            offset = matchOffset + Math.max(needle.length, 1)
          }
        }
      } catch (error) {
        if (error instanceof WorkspaceToolError) throw error
        if (options.signal?.aborted) throw new WorkspaceToolError('cancelled')
        // Files which disappear or cannot be decoded are ignored safely.
      } finally {
        await handle?.close().catch(() => undefined)
      }
    }

    await visit(root, relativePath)
    throwIfAborted(options.signal)
    try {
      const finalRootStats = await fs.lstat(root.absolutePath)
      if (!sameFileIdentity(root.stats, finalRootStats)) {
        throw new WorkspaceToolError('workspace_changed', true)
      }
    } catch (error) {
      if (error instanceof WorkspaceToolError) throw error
      if (options.signal?.aborted) throw new WorkspaceToolError('cancelled')
      throw new WorkspaceToolError('workspace_changed', true)
    }

    return Object.freeze({
      matches: Object.freeze(matches) as unknown as WorkspaceSearchMatch[],
      truncated
    })
  }

  async replaceInFile(
    input: WorkspaceReplaceInput,
    ownerWebContentsId: number,
    options: WorkspaceToolExecutionOptions = {}
  ): Promise<WorkspaceReplaceResult> {
    assertReplaceInFileInput(input)
    assertOwner(ownerWebContentsId)
    assertSignal(options.signal)
    throwIfAborted(options.signal)

    const relativePath = normalizeWorkspaceRelativePath(input.relativePath)
    if (isSensitiveRelativePath(relativePath) || isProtectedWriteRelativePath(relativePath)) {
      throw new WorkspaceToolError('write_not_allowed')
    }
    if (
      Buffer.byteLength(input.oldText, 'utf8') > this.#maxWriteBytes ||
      Buffer.byteLength(input.newText, 'utf8') > this.#maxWriteBytes
    ) {
      throw new WorkspaceToolError('file_too_large')
    }

    const releaseWriteLock = await this.#acquireWriteLock(
      `${input.workspaceToken}\0${relativePath}`,
      options.signal
    )
    try {
      throwIfAborted(options.signal)
      const workspace = await this.#resolveWorkspace(input.workspaceToken, ownerWebContentsId)
      await verifyWorkspaceRoot(workspace, options.signal)
      const resolvedPath = await resolveExistingWorkspacePath(workspace, relativePath, options.signal)
      throwIfAborted(options.signal)
      if (this.#isProtectedAbsolutePath(resolvedPath.absolutePath)) {
        throw new WorkspaceToolError('write_not_allowed')
      }
      if (!resolvedPath.stats.isFile()) throw new WorkspaceToolError('path_not_file')
      assertSingleLinkRegularFile(resolvedPath.stats)
      if (resolvedPath.stats.size > this.#maxWriteBytes) {
        throw new WorkspaceToolError('file_too_large')
      }

      let handle: FileHandle | null = null
      let bytes!: Buffer
      try {
        handle = await fs.open(resolvedPath.absolutePath, 'r')
        const openedStats = await handle.stat()
        if (!openedStats.isFile() || !sameFileIdentity(resolvedPath.stats, openedStats)) {
          throw new WorkspaceToolError('write_conflict')
        }
        assertSingleLinkRegularFile(openedStats)
        bytes = await readBoundedFile(handle, this.#maxWriteBytes, options.signal)
        const finalRealPath = resolve(await fs.realpath(resolvedPath.absolutePath))
        if (
          !isPathInsideWorkspace(workspace.absolutePath, finalRealPath) ||
          pathComparisonKey(finalRealPath) !== pathComparisonKey(resolvedPath.absolutePath)
        ) {
          throw new WorkspaceToolError('workspace_changed', true)
        }
      } catch (error) {
        if (error instanceof WorkspaceToolError) throw error
        if (options.signal?.aborted) throw new WorkspaceToolError('cancelled')
        throw new WorkspaceToolError('write_conflict')
      } finally {
        await handle?.close().catch(() => undefined)
      }

      throwIfAborted(options.signal)
      const currentRevision = createHash('sha256').update(bytes).digest('hex')
      if (currentRevision !== input.expectedRevision) {
        throw new WorkspaceToolError('write_conflict')
      }
      let text: string
      try {
        if (bytes.includes(0)) throw new Error('binary')
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      } catch {
        throw new WorkspaceToolError('invalid_text_file')
      }
      const matchCount = countLiteralMatches(text, input.oldText)
      if (matchCount !== 1) throw new WorkspaceToolError('write_conflict')
      const matchOffset = text.indexOf(input.oldText)
      const replacementText =
        text.slice(0, matchOffset) + input.newText + text.slice(matchOffset + input.oldText.length)
      const replacementBytes = Buffer.from(replacementText, 'utf8')
      if (replacementBytes.byteLength > this.#maxWriteBytes) {
        throw new WorkspaceToolError('file_too_large')
      }
      const result = Object.freeze({
        relativePath: safeWorkspaceResultPath(relativePath),
        revision: createHash('sha256').update(replacementBytes).digest('hex'),
        replacements: 1 as const
      })

      const parentPath = dirname(resolvedPath.absolutePath)
      let temporaryPath = ''
      let temporaryHandle: FileHandle | null = null
      let committed = false
      try {
        throwIfAborted(options.signal)
        const temporary = await createTemporaryWriteFile(parentPath)
        temporaryPath = temporary.path
        temporaryHandle = temporary.handle
        throwIfAborted(options.signal)
        await temporaryHandle.chmod(Number(resolvedPath.stats.mode) & 0o777).catch(() => undefined)
        await temporaryHandle.writeFile(replacementBytes)
        throwIfAborted(options.signal)
        await temporaryHandle.sync()
        throwIfAborted(options.signal)
        await temporaryHandle.close()
        temporaryHandle = null

        await verifyWorkspaceRoot(workspace, options.signal)
        const verifiedParent = resolve(await fs.realpath(parentPath))
        throwIfAborted(options.signal)
        if (pathComparisonKey(verifiedParent) !== pathComparisonKey(parentPath)) {
          throw new WorkspaceToolError('workspace_changed', true)
        }
        await revalidateWriteTarget(
          resolvedPath.absolutePath,
          workspace,
          resolvedPath.stats,
          input.expectedRevision,
          this.#maxWriteBytes,
          options.signal
        )
        throwIfAborted(options.signal)
        await fs.rename(temporaryPath, resolvedPath.absolutePath)
        committed = true
      } catch (error) {
        if (error instanceof WorkspaceToolError) throw error
        if (options.signal?.aborted && !committed) throw new WorkspaceToolError('cancelled')
        throw new WorkspaceToolError('write_failed', true)
      } finally {
        let cleanupFailed = false
        if (temporaryHandle) {
          try {
            await temporaryHandle.close()
          } catch {
            cleanupFailed = true
          }
        }
        if (!committed && temporaryPath) {
          try {
            await fs.rm(temporaryPath, { force: true })
          } catch {
            cleanupFailed = true
          }
        }
        if (!committed && cleanupFailed) throw new WorkspaceToolError('write_failed', true)
      }
      return result
    } finally {
      releaseWriteLock()
    }
  }

  async writeFile(
    input: WorkspaceWriteInput,
    ownerWebContentsId: number,
    options: WorkspaceToolExecutionOptions = {}
  ): Promise<WorkspaceFileResult> {
    assertWriteFileInput(input)
    assertOwner(ownerWebContentsId)
    assertSignal(options.signal)
    throwIfAborted(options.signal)

    const relativePath = normalizeWorkspaceRelativePath(input.relativePath)
    if (isSensitiveRelativePath(relativePath) || isProtectedWriteRelativePath(relativePath)) {
      throw new WorkspaceToolError('write_not_allowed')
    }
    const contentBytes = Buffer.from(input.content, 'utf8')
    if (contentBytes.byteLength > this.#maxWriteBytes) {
      throw new WorkspaceToolError('file_too_large')
    }
    const releaseWriteLock = await this.#acquireWriteLock(
      `${input.workspaceToken}\0${relativePath}`,
      options.signal
    )
    try {
      throwIfAborted(options.signal)

      const workspace = await this.#resolveWorkspace(input.workspaceToken, ownerWebContentsId)
      await verifyWorkspaceRoot(workspace, options.signal)
      const segments = relativePath.split('/')
      const fileName = segments.at(-1)!
      const parentRelativePath = segments.slice(0, -1).join('/')
      const parent = parentRelativePath
        ? await resolveExistingWorkspacePath(workspace, parentRelativePath, options.signal)
        : { absolutePath: workspace.absolutePath, stats: await fs.lstat(workspace.absolutePath) }
      throwIfAborted(options.signal)
      if (!parent.stats.isDirectory()) throw new WorkspaceToolError('path_not_found')
      if (this.#isProtectedAbsolutePath(parent.absolutePath)) {
        throw new WorkspaceToolError('write_not_allowed')
      }

      const targetPath = resolve(parent.absolutePath, fileName)
      if (!isPathInsideWorkspace(workspace.absolutePath, targetPath)) {
        throw new WorkspaceToolError('path_outside_workspace')
      }
      const existing = await inspectWriteTarget(targetPath, workspace, options.signal)
      if (existing) {
        if (!input.expectedRevision) throw new WorkspaceToolError('write_conflict')
        const currentRevision = await revisionForExistingFile(
          targetPath,
          existing,
          this.#maxWriteBytes,
          options.signal
        )
        if (currentRevision !== input.expectedRevision) {
          throw new WorkspaceToolError('write_conflict')
        }
      } else if (input.expectedRevision !== undefined) {
        throw new WorkspaceToolError('write_conflict')
      }

      const redacted = redactSensitiveContent(input.content)
      const bounded = truncateText(redacted, this.#maxResultCharacters)
      const result = Object.freeze({
        relativePath: safeWorkspaceResultPath(relativePath),
        content: bounded.text,
        revision: createHash('sha256').update(contentBytes).digest('hex'),
        truncated: bounded.truncated
      })
      throwIfAborted(options.signal)

      let temporaryPath = ''
      let temporaryHandle: FileHandle | null = null
      let committed = false
      try {
        throwIfAborted(options.signal)
        const temporary = await createTemporaryWriteFile(parent.absolutePath)
        temporaryPath = temporary.path
        temporaryHandle = temporary.handle
        throwIfAborted(options.signal)
        if (existing) {
          await temporaryHandle.chmod(Number(existing.mode) & 0o777).catch(() => undefined)
        }
        throwIfAborted(options.signal)
        await temporaryHandle.writeFile(contentBytes)
        throwIfAborted(options.signal)
        await temporaryHandle.sync()
        throwIfAborted(options.signal)
        await temporaryHandle.close()
        temporaryHandle = null

        throwIfAborted(options.signal)
        await verifyWorkspaceRoot(workspace, options.signal)
        const verifiedParent = resolve(await fs.realpath(parent.absolutePath))
        throwIfAborted(options.signal)
        if (pathComparisonKey(verifiedParent) !== pathComparisonKey(parent.absolutePath)) {
          throw new WorkspaceToolError('workspace_changed', true)
        }
        await revalidateWriteTarget(
          targetPath,
          workspace,
          existing,
          input.expectedRevision,
          this.#maxWriteBytes,
          options.signal
        )
        throwIfAborted(options.signal)
        await fs.rename(temporaryPath, targetPath)
        committed = true
      } catch (error) {
        if (error instanceof WorkspaceToolError) throw error
        if (options.signal?.aborted && !committed) throw new WorkspaceToolError('cancelled')
        throw new WorkspaceToolError('write_failed', true)
      } finally {
        let cleanupFailed = false
        if (temporaryHandle) {
          try {
            await temporaryHandle.close()
          } catch {
            cleanupFailed = true
          }
        }
        if (!committed && temporaryPath) {
          try {
            await fs.rm(temporaryPath, { force: true })
          } catch {
            cleanupFailed = true
          }
        }
        if (!committed && cleanupFailed) throw new WorkspaceToolError('write_failed', true)
      }

      return result
    } finally {
      releaseWriteLock()
    }
  }

  async gitSummary(
    input: { workspaceToken: string },
    ownerWebContentsId: number,
    options: WorkspaceToolExecutionOptions = {}
  ): Promise<GitSummary> {
    assertGitSummaryInput(input)
    assertOwner(ownerWebContentsId)
    assertSignal(options.signal)
    throwIfAborted(options.signal)

    const workspace = await this.#resolveWorkspace(input.workspaceToken, ownerWebContentsId)
    await verifyWorkspaceRoot(workspace, options.signal)
    if (this.#isProtectedAbsolutePath(workspace.absolutePath)) {
      throw new WorkspaceToolError('sensitive_path')
    }
    const gitContext = await this.#prepareSafeGitContext(workspace, options.signal)
    const snapshot = await this.#inspectSafeGitSnapshot(workspace, gitContext, options.signal)
    const selection = selectReviewDiffPaths(snapshot.entries)
    const patches = await this.#buildSafeRepositoryPatches(
      selection.paths,
      gitContext,
      snapshot,
      options.signal
    )
    await verifyWorkspaceRoot(workspace, options.signal)
    return buildGitSummary(
      gitContext.branch,
      snapshot.entries,
      patches.stats,
      this.#maxGitFiles
    )
  }

  async gitDiff(
    input: { workspaceToken: string },
    ownerWebContentsId: number,
    options: WorkspaceToolExecutionOptions = {}
  ): Promise<WorkspaceGitDiffResult> {
    assertGitSummaryInput(input)
    assertOwner(ownerWebContentsId)
    assertSignal(options.signal)
    throwIfAborted(options.signal)

    const workspace = await this.#resolveWorkspace(input.workspaceToken, ownerWebContentsId)
    await verifyWorkspaceRoot(workspace, options.signal)
    if (this.#isProtectedAbsolutePath(workspace.absolutePath)) {
      throw new WorkspaceToolError('sensitive_path')
    }
    const gitContext = await this.#prepareSafeGitContext(workspace, options.signal)
    const snapshot = await this.#inspectSafeGitSnapshot(workspace, gitContext, options.signal)
    const selection = selectReviewDiffPaths(snapshot.entries)
    if (selection.files.length === 0) {
      await verifyWorkspaceRoot(workspace, options.signal)
      return Object.freeze({
        patch: '',
        files: Object.freeze([]),
        untrackedFiles: Object.freeze([...selection.untrackedFiles]),
        truncated: selection.truncated || snapshot.truncated
      })
    }

    const patches = await this.#buildSafeRepositoryPatches(
      selection.paths,
      gitContext,
      snapshot,
      options.signal
    )
    throwIfAborted(options.signal)
    await verifyWorkspaceRoot(workspace, options.signal)

    const combined = [
      patches.worktreePatch ? '## Unstaged changes\n' + patches.worktreePatch : '',
      patches.stagedPatch ? '## Staged changes\n' + patches.stagedPatch : ''
    ].filter(Boolean).join('\n\n')
    const bounded = truncateText(combined, MAX_REVIEW_PATCH_CHARACTERS)
    return Object.freeze({
      patch: bounded.text,
      files: Object.freeze([...selection.files]),
      untrackedFiles: Object.freeze([...selection.untrackedFiles]),
      truncated:
        selection.truncated ||
        snapshot.truncated ||
        patches.truncated ||
        bounded.truncated
    })
  }

  async #prepareSafeGitContext(
    workspace: ResolvedWorkspaceRecord,
    signal?: AbortSignal
  ): Promise<SafeGitContext> {
    const gitDirectory = await verifyGitMetadataLocation(workspace, signal)
    const environment = sanitizedGitEnvironment(this.#environmentSource)
    const gitExecutable = await resolveGitExecutable(
      this.#gitExecutable,
      this.#environmentSource,
      workspace.absolutePath
    )
    const common: Omit<BoundedProcessOptions, 'args'> = {
      command: gitExecutable,
      cwd: workspace.absolutePath,
      env: environment,
      timeoutMs: this.#gitTimeoutMs,
      maxOutputBytes: this.#maxGitOutputBytes,
      signal
    }
    const repositoryArguments = safeGitRepositoryArguments(
      gitDirectory,
      workspace.absolutePath
    )
    await verifySafeGitConfiguration(
      common,
      repositoryArguments,
      workspace.absolutePath,
      gitDirectory,
      signal
    )
    const indexOutput = await runBoundedProcess({
      ...common,
      args: [...repositoryArguments, 'ls-files', '--stage', '-z']
    })
    const indexEntries = parseGitIndexEntries(indexOutput, this.#maxGitFiles)
    let headEntries: Map<string, GitIndexEntry>
    try {
      const headOutput = await runBoundedProcess({
        ...common,
        args: [...repositoryArguments, 'ls-tree', '-r', '-z', '--full-tree', 'HEAD']
      })
      headEntries = parseGitTreeEntries(headOutput, this.#maxGitFiles)
    } catch (error) {
      if (!(error instanceof WorkspaceToolError) || error.code !== 'git_failed') throw error
      headEntries = new Map()
    }
    const objectFormat = inferGitObjectFormat(indexEntries, headEntries)
    let branch = 'HEAD'
    try {
      const branchOutput = await runBoundedProcess({
        ...common,
        args: [...repositoryArguments, 'symbolic-ref', '--quiet', '--short', 'HEAD']
      })
      branch = safeGitBranchName(branchOutput)
    } catch (error) {
      if (!(error instanceof WorkspaceToolError) || error.code !== 'git_failed') throw error
    }
    await verifyReviewWorktreePreflight(
      workspace,
      [...indexEntries.keys()],
      this.#protectedAbsoluteRoots,
      signal
    )
    const untracked = await enumerateSafeUntrackedFiles(
      workspace,
      new Set(indexEntries.keys()),
      this.#maxGitFiles,
      this.#protectedAbsoluteRoots,
      signal
    )
    return {
      common,
      repositoryArguments,
      indexEntries,
      headEntries,
      branch,
      objectFormat,
      untrackedEntries: untracked.entries,
      untrackedTruncated: untracked.truncated
    }
  }

  async #inspectSafeGitSnapshot(
    workspace: ResolvedWorkspaceRecord,
    context: SafeGitContext,
    signal?: AbortSignal
  ): Promise<SafeGitSnapshot> {
    const entries: GitStatusEntry[] = []
    const worktreeChanges = new Map<string, SafeGitWorktreeChange>()
    let scannedBytes = 0
    let truncated = context.untrackedTruncated
    const sensitiveHeadOids = new Set(
      [...context.headEntries]
        .filter(([relativePath]) => isReviewSensitiveRelativePath(relativePath))
        .map(([, entry]) => entry.oid)
    )

    const repositoryPaths = new Set([
      ...context.headEntries.keys(),
      ...context.indexEntries.keys()
    ])
    for (const relativePath of repositoryPaths) {
      if (isReviewSensitiveRelativePath(relativePath)) continue
      const head = context.headEntries.get(relativePath)
      const index = context.indexEntries.get(relativePath)
      if (index && sensitiveHeadOids.has(index.oid) && !head) continue
      if (!head && index) entries.push({ relativePath, status: 'added' })
      else if (head && !index) entries.push({ relativePath, status: 'deleted' })
      else if (head && index && (head.oid !== index.oid || head.mode !== index.mode)) {
        entries.push({ relativePath, status: 'modified' })
      }
    }

    for (const [relativePath, indexEntry] of context.indexEntries) {
      throwIfAborted(signal)
      if (
        isReviewSensitiveRelativePath(relativePath) ||
        sensitiveHeadOids.has(indexEntry.oid) && !context.headEntries.has(relativePath)
      ) {
        continue
      }
      let current: Buffer | null
      try {
        current = await readStableWorkspaceFileIfExists(
          workspace,
          relativePath,
          this.#maxFileBytes,
          this.#protectedAbsoluteRoots,
          signal
        )
      } catch (error) {
        if (error instanceof WorkspaceToolError && error.code === 'file_too_large') {
          worktreeChanges.set(relativePath, { content: null, omitted: true })
          entries.push({ relativePath, status: 'modified' })
          truncated = true
          continue
        }
        throw error
      }
      if (current) {
        scannedBytes += current.byteLength
        if (scannedBytes > MAX_REVIEW_WORKTREE_SCAN_BYTES) {
          throw new WorkspaceToolError('git_output_too_large')
        }
      }
      const currentOid = current === null
        ? null
        : gitBlobOid(current, context.objectFormat)
      if (currentOid !== indexEntry.oid) {
        worktreeChanges.set(relativePath, { content: current, omitted: false })
        entries.push({
          relativePath,
          status: current === null ? 'deleted' : 'modified'
        })
      }
    }
    entries.push(...context.untrackedEntries)
    return { entries, worktreeChanges, truncated }
  }

  async #buildSafeRepositoryPatches(
    paths: readonly string[],
    context: SafeGitContext,
    snapshot: SafeGitSnapshot,
    signal?: AbortSignal
  ): Promise<{
    worktreePatch: string
    stagedPatch: string
    stats: Map<string, GitDiffStat>
    truncated: boolean
  }> {
    const worktreePatches: string[] = []
    const stagedPatches: string[] = []
    const stats = new Map<string, GitDiffStat>()
    const blobCache = new Map<string, { text: string | null; omitted: boolean }>()
    let truncated = false

    const loadBlob = async (entry: GitIndexEntry | undefined): Promise<{
      text: string | null
      omitted: boolean
    }> => {
      if (!entry) return { text: null, omitted: false }
      const cached = blobCache.get(entry.oid)
      if (cached) return cached
      if (!entry.mode.startsWith('100')) {
        const omitted = { text: null, omitted: true }
        blobCache.set(entry.oid, omitted)
        return omitted
      }
      try {
        const bytes = await runBoundedProcess({
          ...context.common,
          args: [...context.repositoryArguments, 'cat-file', 'blob', entry.oid]
        })
        const decoded = decodeReviewText(bytes)
        const value = decoded === null
          ? { text: null, omitted: true }
          : { text: redactSensitiveContent(decoded), omitted: false }
        blobCache.set(entry.oid, value)
        return value
      } catch (error) {
        if (error instanceof WorkspaceToolError && error.code === 'git_output_too_large') {
          const omitted = { text: null, omitted: true }
          blobCache.set(entry.oid, omitted)
          return omitted
        }
        throw error
      }
    }

    for (const relativePath of paths) {
      throwIfAborted(signal)
      const headEntry = context.headEntries.get(relativePath)
      const indexEntry = context.indexEntries.get(relativePath)
      if (
        (!headEntry && indexEntry) ||
        (headEntry && !indexEntry) ||
        (headEntry && indexEntry && (headEntry.oid !== indexEntry.oid || headEntry.mode !== indexEntry.mode))
      ) {
        const [head, index] = await Promise.all([loadBlob(headEntry), loadBlob(indexEntry)])
        if (head.omitted || index.omitted) {
          stagedPatches.push(formatOmittedReviewPatch(relativePath, 'staged content is not bounded UTF-8 text'))
          truncated = true
        } else {
          const patch = buildBoundedUnifiedDiff(relativePath, head.text, index.text)
          if (patch) stagedPatches.push(patch)
          addGitDiffStat(stats, relativePath, diffStatForTexts(head.text, index.text))
        }
      }

      const worktree = snapshot.worktreeChanges.get(relativePath)
      if (worktree) {
        const index = await loadBlob(indexEntry)
        const currentText = worktree.content === null ? null : decodeReviewText(worktree.content)
        if (worktree.omitted || index.omitted || (worktree.content !== null && currentText === null)) {
          worktreePatches.push(formatOmittedReviewPatch(relativePath, 'worktree content is not bounded UTF-8 text'))
          truncated = true
        } else {
          const safeCurrent = currentText === null ? null : redactSensitiveContent(currentText)
          const patch = buildBoundedUnifiedDiff(relativePath, index.text, safeCurrent)
          if (patch) worktreePatches.push(patch)
          addGitDiffStat(stats, relativePath, diffStatForTexts(index.text, safeCurrent))
        }
      }

      if (
        worktreePatches.join('\n\n').length + stagedPatches.join('\n\n').length >
        MAX_REVIEW_PATCH_CHARACTERS
      ) {
        truncated = true
        break
      }
    }

    const worktreeBounded = truncateText(worktreePatches.join('\n\n'), MAX_REVIEW_PATCH_CHARACTERS)
    const stagedBounded = truncateText(stagedPatches.join('\n\n'), MAX_REVIEW_PATCH_CHARACTERS)
    return {
      worktreePatch: sanitizeGeneratedPatch(worktreeBounded.text),
      stagedPatch: sanitizeGeneratedPatch(stagedBounded.text),
      stats,
      truncated: truncated || worktreeBounded.truncated || stagedBounded.truncated
    }
  }

  async #resolveWorkspace(
    workspaceToken: string,
    ownerWebContentsId: number
  ): Promise<ResolvedWorkspaceRecord> {
    if (!WORKSPACE_TOKEN_PATTERN.test(workspaceToken)) {
      throw new WorkspaceToolError('workspace_unavailable')
    }
    const workspace = await this.#selections.resolveWorkspace(workspaceToken, ownerWebContentsId)
    if (!workspace) throw new WorkspaceToolError('workspace_unavailable')
    return workspace
  }

  #isProtectedAbsolutePath(candidate: string): boolean {
    return this.#protectedAbsoluteRoots.some((root) => isPathInsideWorkspace(root, candidate))
  }

  async #acquireWriteLock(key: string, signal?: AbortSignal): Promise<() => void> {
    let state = this.#writeLocks.get(key)
    if (!state) {
      state = { tail: Promise.resolve(), pending: 0 }
      this.#writeLocks.set(key, state)
    }
    const previous = state.tail
    let releaseGate!: () => void
    const gate = new Promise<void>((resolveGate) => {
      releaseGate = resolveGate
    })
    state.tail = previous.then(() => gate, () => gate)
    state.pending += 1

    let released = false
    const release = (): void => {
      if (released) return
      released = true
      releaseGate()
      state!.pending -= 1
      if (state!.pending === 0 && this.#writeLocks.get(key) === state) {
        this.#writeLocks.delete(key)
      }
    }
    try {
      await waitForWriteLock(previous, signal)
      return release
    } catch (error) {
      release()
      throw error
    }
  }
}

async function waitForWriteLock(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  if (!signal) {
    await previous.catch(() => undefined)
    return
  }

  await new Promise<void>((resolveWait, rejectWait) => {
    let settled = false
    let onAbort = (): void => undefined
    const settle = (callback: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    onAbort = (): void => {
      settle(() => rejectWait(new WorkspaceToolError('cancelled')))
    }

    signal.addEventListener('abort', onAbort, { once: true })
    previous.then(
      () => settle(resolveWait),
      () => settle(resolveWait)
    )
    if (signal.aborted) onAbort()
  })
}

async function verifyWorkspaceRoot(
  workspace: ResolvedWorkspaceRecord,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal)
  try {
    const rootStats = await fs.lstat(workspace.absolutePath, { bigint: true })
    const canonical = resolve(await fs.realpath(workspace.absolutePath))
    throwIfAborted(signal)
    if (
      !rootStats.isDirectory() ||
      rootStats.isSymbolicLink() ||
      pathComparisonKey(canonical) !== pathComparisonKey(workspace.absolutePath) ||
      !sameStoredIdentity(workspace, rootStats)
    ) {
      throw new WorkspaceToolError('workspace_changed', true)
    }
  } catch (error) {
    if (error instanceof WorkspaceToolError) throw error
    if (signal?.aborted) throw new WorkspaceToolError('cancelled')
    throw new WorkspaceToolError('workspace_unavailable', true)
  }
}

async function resolveExistingWorkspacePath(
  workspace: ResolvedWorkspaceRecord,
  relativePath: string,
  signal?: AbortSignal
): Promise<ResolvedWorkspacePath> {
  const segments = relativePath.split('/')
  let currentPath = workspace.absolutePath
  let finalStats: Awaited<ReturnType<typeof fs.lstat>> | null = null

  for (let index = 0; index < segments.length; index += 1) {
    throwIfAborted(signal)
    currentPath = join(currentPath, segments[index]!)
    if (!isPathInsideWorkspace(workspace.absolutePath, currentPath)) {
      throw new WorkspaceToolError('path_outside_workspace')
    }

    let stats: Awaited<ReturnType<typeof fs.lstat>>
    let canonical: string
    try {
      stats = await fs.lstat(currentPath)
      if (stats.isSymbolicLink()) throw new WorkspaceToolError('reparse_point_rejected')
      canonical = resolve(await fs.realpath(currentPath))
    } catch (error) {
      if (error instanceof WorkspaceToolError) throw error
      if (signal?.aborted) throw new WorkspaceToolError('cancelled')
      if (isNodeErrorCode(error, 'ENOENT') || isNodeErrorCode(error, 'ENOTDIR')) {
        throw new WorkspaceToolError('path_not_found')
      }
      throw new WorkspaceToolError('workspace_unavailable', true)
    }

    if (!isPathInsideWorkspace(workspace.absolutePath, canonical)) {
      throw new WorkspaceToolError('path_outside_workspace')
    }
    if (pathComparisonKey(canonical) !== pathComparisonKey(resolve(currentPath))) {
      throw new WorkspaceToolError('reparse_point_rejected')
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new WorkspaceToolError('path_not_found')
    }
    currentPath = canonical
    finalStats = stats
  }

  if (!finalStats) throw new WorkspaceToolError('path_not_found')
  return { absolutePath: currentPath, stats: finalStats }
}

async function inspectWriteTarget(
  targetPath: string,
  workspace: ResolvedWorkspaceRecord,
  signal?: AbortSignal
): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  throwIfAborted(signal)
  let stats: Awaited<ReturnType<typeof fs.lstat>>
  try {
    stats = await fs.lstat(targetPath)
  } catch (error) {
    if (signal?.aborted) throw new WorkspaceToolError('cancelled')
    if (isNodeErrorCode(error, 'ENOENT')) return null
    throw new WorkspaceToolError('write_failed', true)
  }
  throwIfAborted(signal)
  if (stats.isSymbolicLink()) throw new WorkspaceToolError('reparse_point_rejected')
  if (!stats.isFile()) throw new WorkspaceToolError('path_not_file')
  assertSingleLinkRegularFile(stats)
  let canonical: string
  try {
    canonical = resolve(await fs.realpath(targetPath))
  } catch {
    if (signal?.aborted) throw new WorkspaceToolError('cancelled')
    throw new WorkspaceToolError('write_failed', true)
  }
  throwIfAborted(signal)
  if (
    !isPathInsideWorkspace(workspace.absolutePath, canonical) ||
    pathComparisonKey(canonical) !== pathComparisonKey(targetPath)
  ) {
    throw new WorkspaceToolError('reparse_point_rejected')
  }
  return stats
}

async function revisionForExistingFile(
  targetPath: string,
  expectedStats: Awaited<ReturnType<typeof fs.lstat>>,
  maxBytes: number,
  signal?: AbortSignal
): Promise<string> {
  throwIfAborted(signal)
  if (expectedStats.size > maxBytes) throw new WorkspaceToolError('file_too_large')
  let handle: FileHandle | null = null
  try {
    handle = await fs.open(targetPath, 'r')
    throwIfAborted(signal)
    const openedStats = await handle.stat()
    throwIfAborted(signal)
    if (!openedStats.isFile() || !sameFileIdentity(expectedStats, openedStats)) {
      throw new WorkspaceToolError('write_conflict')
    }
    assertSingleLinkRegularFile(openedStats)
    const bytes = await readBoundedFile(handle, maxBytes, signal)
    return createHash('sha256').update(bytes).digest('hex')
  } catch (error) {
    if (error instanceof WorkspaceToolError) throw error
    if (signal?.aborted) throw new WorkspaceToolError('cancelled')
    throw new WorkspaceToolError('write_conflict')
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function revalidateWriteTarget(
  targetPath: string,
  workspace: ResolvedWorkspaceRecord,
  previousStats: Awaited<ReturnType<typeof fs.lstat>> | null,
  expectedRevision: string | undefined,
  maxBytes: number,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal)
  const currentStats = await inspectWriteTarget(targetPath, workspace, signal)
  if (!previousStats) {
    if (currentStats) throw new WorkspaceToolError('write_conflict')
    return
  }
  if (!currentStats || !sameFileIdentity(previousStats, currentStats)) {
    throw new WorkspaceToolError('write_conflict')
  }
  if (!expectedRevision) throw new WorkspaceToolError('write_conflict')
  const currentRevision = await revisionForExistingFile(targetPath, currentStats, maxBytes, signal)
  if (currentRevision !== expectedRevision) throw new WorkspaceToolError('write_conflict')
  throwIfAborted(signal)
}

async function createTemporaryWriteFile(
  parentPath: string
): Promise<{ path: string; handle: FileHandle }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const path = join(parentPath, `.ai-terminal-write-${randomBytes(18).toString('base64url')}.tmp`)
    try {
      const handle = await fs.open(path, 'wx', 0o600)
      return { path, handle }
    } catch (error) {
      if (isNodeErrorCode(error, 'EEXIST')) continue
      throw new WorkspaceToolError('write_failed', true)
    }
  }
  throw new WorkspaceToolError('write_failed', true)
}

async function verifyGitMetadataLocation(
  workspace: ResolvedWorkspaceRecord,
  signal?: AbortSignal
): Promise<string> {
  throwIfAborted(signal)
  const dotGitPath = join(workspace.absolutePath, '.git')
  let stats: Awaited<ReturnType<typeof fs.lstat>>
  try {
    stats = await fs.lstat(dotGitPath)
  } catch (error) {
    if (signal?.aborted) throw new WorkspaceToolError('cancelled')
    if (isNodeErrorCode(error, 'ENOENT')) throw new WorkspaceToolError('git_unavailable')
    throw new WorkspaceToolError('git_unavailable', true)
  }
  if (stats.isSymbolicLink()) throw new WorkspaceToolError('reparse_point_rejected')

  if (stats.isDirectory()) {
    const canonical = resolve(await fs.realpath(dotGitPath).catch(() => ''))
    if (
      !canonical ||
      !isPathInsideWorkspace(workspace.absolutePath, canonical) ||
      pathComparisonKey(canonical) !== pathComparisonKey(resolve(dotGitPath))
    ) {
      throw new WorkspaceToolError('path_outside_workspace')
    }
    return canonical
  }
  if (!stats.isFile() || stats.size > GIT_METADATA_FILE_LIMIT) {
    throw new WorkspaceToolError('git_unavailable')
  }

  let metadata: string
  try {
    const bytes = await fs.readFile(dotGitPath)
    metadata = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new WorkspaceToolError('git_unavailable')
  }
  const match = /^gitdir:\s*(.+?)\s*$/iu.exec(metadata)
  if (!match?.[1] || /[\r\n\0]/u.test(match[1])) throw new WorkspaceToolError('git_unavailable')
  const gitDirectory = resolve(workspace.absolutePath, match[1])
  if (!isPathInsideWorkspace(workspace.absolutePath, gitDirectory)) {
    throw new WorkspaceToolError('path_outside_workspace')
  }
  try {
    const gitDirectoryStats = await fs.lstat(gitDirectory)
    const canonical = resolve(await fs.realpath(gitDirectory))
    if (
      !gitDirectoryStats.isDirectory() ||
      gitDirectoryStats.isSymbolicLink() ||
      !isPathInsideWorkspace(workspace.absolutePath, canonical) ||
      pathComparisonKey(canonical) !== pathComparisonKey(gitDirectory)
    ) {
      throw new WorkspaceToolError('reparse_point_rejected')
    }
    return canonical
  } catch (error) {
    if (error instanceof WorkspaceToolError) throw error
    throw new WorkspaceToolError('git_unavailable')
  }
}

function safeGitRepositoryArguments(gitDirectory: string, workspacePath: string): string[] {
  return [
    '--no-pager',
    `--git-dir=${gitDirectory}`,
    `--work-tree=${workspacePath}`,
    '-c',
    `core.worktree=${workspacePath}`,
    '-c',
    'core.fsmonitor=false',
    '-c',
    `core.hooksPath=${nullDevicePath()}`,
    '-c',
    `core.attributesFile=${nullDevicePath()}`,
    '-c',
    `core.excludesFile=${nullDevicePath()}`,
    '-c',
    'core.sparseCheckout=false',
    '-c',
    'core.sparseCheckoutCone=false',
    '-c',
    'status.renames=false',
    '-c',
    'diff.renames=false'
  ]
}

async function verifySafeGitConfiguration(
  common: Omit<BoundedProcessOptions, 'args'>,
  repositoryArguments: readonly string[],
  workspaceRoot: string,
  gitDirectory: string,
  signal?: AbortSignal
): Promise<void> {
  const configPath = join(gitDirectory, 'config')
  const config = await readStableInternalFileIfExists(
    workspaceRoot,
    configPath,
    MAX_REVIEW_ATTRIBUTE_BYTES,
    signal
  )
  if (!config) throw new WorkspaceToolError('git_unavailable')

  for (const relativeMetadataPath of [
    'commondir',
    'config.worktree',
    'objects/info/alternates',
    'objects/info/http-alternates'
  ]) {
    const unsafeMetadata = await readStableInternalFileIfExists(
      workspaceRoot,
      join(gitDirectory, ...relativeMetadataPath.split('/')),
      MAX_REVIEW_ATTRIBUTE_BYTES,
      signal
    )
    if (unsafeMetadata) throw new WorkspaceToolError('git_unavailable')
  }

  const localConfig = await runBoundedProcess({
    ...common,
    args: [
      ...repositoryArguments,
      'config',
      '--local',
      '--null',
      '--list',
      '--no-includes'
    ]
  })
  for (const record of decodeGitOutput(localConfig).split('\0')) {
    if (!record) continue
    const separator = record.indexOf('\n')
    const key = (separator < 0 ? record : record.slice(0, separator)).trim().toLowerCase()
    if (!key || isDangerousLocalGitConfigKey(key)) {
      throw new WorkspaceToolError('git_unavailable')
    }
  }

  const infoAttributes = await readStableInternalFileIfExists(
    workspaceRoot,
    join(gitDirectory, 'info', 'attributes'),
    MAX_REVIEW_ATTRIBUTE_BYTES,
    signal
  )
  if (infoAttributes && containsGitFilterAttribute(infoAttributes)) {
    throw new WorkspaceToolError('git_unavailable')
  }
}

function isDangerousLocalGitConfigKey(key: string): boolean {
  return key === 'core.worktree' ||
    key === 'extensions.worktreeconfig' ||
    key === 'extensions.partialclone' ||
    key.startsWith('include.') ||
    key.startsWith('includeif.') ||
    key.startsWith('filter.') ||
    key.startsWith('feature.') ||
    /(?:command|textconv|external|helper|program|hook|hookspath|fsmonitor)$/u.test(key) ||
    /^(?:remote\..*\.(?:promisor|partialclonefilter)|core\.(?:attributesfile|excludesfile|alternateRefsCommand))$/iu.test(key)
}

async function readStableInternalFileIfExists(
  root: string,
  absolutePath: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Buffer | null> {
  throwIfAborted(signal)
  if (!isPathInsideWorkspace(root, absolutePath)) {
    throw new WorkspaceToolError('path_outside_workspace')
  }
  const relativePath = relative(root, absolutePath)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new WorkspaceToolError('path_outside_workspace')
  }
  const segments = relativePath.split(/[\\/]+/u).filter(Boolean)
  let current = root
  let finalStats: Awaited<ReturnType<typeof fs.lstat>> | null = null
  for (const segment of segments) {
    current = join(current, segment)
    try {
      const stats = await fs.lstat(current)
      const canonical = resolve(await fs.realpath(current))
      if (
        stats.isSymbolicLink() ||
        !isPathInsideWorkspace(root, canonical) ||
        pathComparisonKey(canonical) !== pathComparisonKey(current)
      ) {
        throw new WorkspaceToolError('reparse_point_rejected')
      }
      finalStats = stats
    } catch (error) {
      if (error instanceof WorkspaceToolError) throw error
      if (signal?.aborted) throw new WorkspaceToolError('cancelled')
      if (isNodeErrorCode(error, 'ENOENT') || isNodeErrorCode(error, 'ENOTDIR')) return null
      throw new WorkspaceToolError('git_unavailable', true)
    }
  }
  if (!finalStats?.isFile()) throw new WorkspaceToolError('git_unavailable')
  assertSingleLinkRegularFile(finalStats)
  if (finalStats.size > maxBytes) throw new WorkspaceToolError('git_output_too_large')

  let handle: FileHandle | null = null
  try {
    handle = await fs.open(absolutePath, 'r')
    const openedStats = await handle.stat()
    if (!openedStats.isFile() || !sameFileIdentity(finalStats, openedStats)) {
      throw new WorkspaceToolError('workspace_changed', true)
    }
    assertSingleLinkRegularFile(openedStats)
    const bytes = await readBoundedFile(handle, maxBytes, signal)
    const finalCanonical = resolve(await fs.realpath(absolutePath))
    if (pathComparisonKey(finalCanonical) !== pathComparisonKey(absolutePath)) {
      throw new WorkspaceToolError('workspace_changed', true)
    }
    return bytes
  } catch (error) {
    if (error instanceof WorkspaceToolError) throw error
    if (signal?.aborted) throw new WorkspaceToolError('cancelled')
    throw new WorkspaceToolError('git_unavailable', true)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function parseGitIndexEntries(output: Buffer, maxFiles: number): Map<string, GitIndexEntry> {
  const entries = new Map<string, GitIndexEntry>()
  let records = 0
  for (const record of decodeGitOutput(output).split('\0')) {
    if (!record) continue
    records += 1
    if (records > maxFiles) throw new WorkspaceToolError('git_invalid_output')
    const match = /^([0-7]{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t([\s\S]+)$/iu.exec(record)
    if (!match) throw new WorkspaceToolError('git_invalid_output')
    const relativePath = normalizeGitRelativePath(match[4])
    const stage = Number(match[3])
    if (stage !== 0) continue
    if (entries.has(relativePath)) throw new WorkspaceToolError('git_invalid_output')
    entries.set(relativePath, Object.freeze({
      mode: match[1]!,
      oid: match[2]!.toLowerCase()
    }))
  }
  return entries
}

function parseGitTreeEntries(output: Buffer, maxFiles: number): Map<string, GitIndexEntry> {
  const entries = new Map<string, GitIndexEntry>()
  let records = 0
  for (const record of decodeGitOutput(output).split('\0')) {
    if (!record) continue
    records += 1
    if (records > maxFiles) throw new WorkspaceToolError('git_invalid_output')
    const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/iu.exec(record)
    if (!match) throw new WorkspaceToolError('git_invalid_output')
    const relativePath = normalizeGitRelativePath(match[4])
    if (entries.has(relativePath)) throw new WorkspaceToolError('git_invalid_output')
    entries.set(relativePath, Object.freeze({
      mode: match[1]!,
      oid: match[3]!.toLowerCase()
    }))
  }
  return entries
}

function inferGitObjectFormat(
  indexEntries: ReadonlyMap<string, GitIndexEntry>,
  headEntries: ReadonlyMap<string, GitIndexEntry>
): 'sha1' | 'sha256' {
  let format: 'sha1' | 'sha256' | null = null
  for (const entry of [...indexEntries.values(), ...headEntries.values()]) {
    const candidate = entry.oid.length === 40 ? 'sha1' : entry.oid.length === 64 ? 'sha256' : null
    if (!candidate || (format !== null && format !== candidate)) {
      throw new WorkspaceToolError('git_invalid_output')
    }
    format = candidate
  }
  return format ?? 'sha1'
}

function safeGitBranchName(output: Buffer): string {
  const candidate = decodeGitOutput(output).trim()
  if (
    !candidate ||
    candidate.length > MAX_GIT_BRANCH_CHARACTERS ||
    /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    throw new WorkspaceToolError('git_invalid_output')
  }
  return redactSensitiveContent(candidate)
}

async function readStableWorkspaceFileIfExists(
  workspace: ResolvedWorkspaceRecord,
  relativePath: string,
  maxBytes: number,
  protectedRoots: readonly string[],
  signal?: AbortSignal
): Promise<Buffer | null> {
  let resolvedPath: ResolvedWorkspacePath
  try {
    resolvedPath = await resolveExistingWorkspacePath(workspace, relativePath, signal)
  } catch (error) {
    if (error instanceof WorkspaceToolError && error.code === 'path_not_found') return null
    throw error
  }
  if (protectedRoots.some((root) => isPathInsideWorkspace(root, resolvedPath.absolutePath))) {
    throw new WorkspaceToolError('sensitive_path')
  }
  if (!resolvedPath.stats.isFile()) throw new WorkspaceToolError('path_not_file')
  assertSingleLinkRegularFile(resolvedPath.stats)
  if (resolvedPath.stats.size > maxBytes) throw new WorkspaceToolError('file_too_large')

  let handle: FileHandle | null = null
  try {
    handle = await fs.open(resolvedPath.absolutePath, 'r')
    const openedStats = await handle.stat()
    if (!openedStats.isFile() || !sameFileIdentity(resolvedPath.stats, openedStats)) {
      throw new WorkspaceToolError('workspace_changed', true)
    }
    assertSingleLinkRegularFile(openedStats)
    const bytes = await readBoundedFile(handle, maxBytes, signal)
    const finalCanonical = resolve(await fs.realpath(resolvedPath.absolutePath))
    if (
      !isPathInsideWorkspace(workspace.absolutePath, finalCanonical) ||
      pathComparisonKey(finalCanonical) !== pathComparisonKey(resolvedPath.absolutePath)
    ) {
      throw new WorkspaceToolError('workspace_changed', true)
    }
    return bytes
  } catch (error) {
    if (error instanceof WorkspaceToolError) throw error
    if (signal?.aborted) throw new WorkspaceToolError('cancelled')
    throw new WorkspaceToolError('workspace_changed', true)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function gitBlobOid(bytes: Buffer, format: 'sha1' | 'sha256'): string {
  return createHash(format)
    .update(`blob ${bytes.byteLength}\0`, 'utf8')
    .update(bytes)
    .digest('hex')
}

function decodeReviewText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

async function verifyReviewWorktreePreflight(
  workspace: ResolvedWorkspaceRecord,
  trackedPaths: readonly string[],
  protectedRoots: readonly string[],
  signal?: AbortSignal
): Promise<void> {
  const attributePaths = new Set<string>([join(workspace.absolutePath, '.gitattributes')])
  for (const relativePath of trackedPaths) {
    throwIfAborted(signal)
    try {
      const resolvedPath = await resolveExistingWorkspacePath(workspace, relativePath, signal)
      if (!resolvedPath.stats.isFile()) throw new WorkspaceToolError('path_not_file')
      assertSingleLinkRegularFile(resolvedPath.stats)
      if (protectedRoots.some((root) => isPathInsideWorkspace(root, resolvedPath.absolutePath))) {
        throw new WorkspaceToolError('sensitive_path')
      }
    } catch (error) {
      if (error instanceof WorkspaceToolError && error.code === 'path_not_found') {
        // Deleted tracked paths are valid review inputs.
      } else {
        throw error
      }
    }
    const segments = relativePath.split('/')
    for (let index = 0; index < segments.length; index += 1) {
      attributePaths.add(join(workspace.absolutePath, ...segments.slice(0, index), '.gitattributes'))
    }
  }

  for (const attributePath of attributePaths) {
    const attributes = await readStableInternalFileIfExists(
      workspace.absolutePath,
      attributePath,
      MAX_REVIEW_ATTRIBUTE_BYTES,
      signal
    )
    if (attributes && containsGitFilterAttribute(attributes)) {
      throw new WorkspaceToolError('git_unavailable')
    }
  }
}

function containsGitFilterAttribute(bytes: Buffer): boolean {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new WorkspaceToolError('git_unavailable')
  }
  return /(?:^|[\t ])(?:-?!?filter|filter=[^\t ]*)(?=$|[\t ])/imu.test(text)
}

async function enumerateSafeUntrackedFiles(
  workspace: ResolvedWorkspaceRecord,
  trackedPaths: ReadonlySet<string>,
  maxFiles: number,
  protectedRoots: readonly string[],
  signal?: AbortSignal
): Promise<{ entries: GitStatusEntry[]; truncated: boolean }> {
  const entries: GitStatusEntry[] = []
  const queue: Array<{ absolutePath: string; relativePath: string }> = [{
    absolutePath: workspace.absolutePath,
    relativePath: '.'
  }]
  let scanned = 0
  let truncated = false
  while (queue.length > 0) {
    const directory = queue.shift()!
    let handle: Awaited<ReturnType<typeof fs.opendir>> | null = null
    try {
      handle = await fs.opendir(directory.absolutePath)
      while (true) {
        throwIfAborted(signal)
        const dirent = await handle.read()
        if (!dirent) break
        scanned += 1
        if (scanned > MAX_REVIEW_UNTRACKED_SCAN_ENTRIES) {
          truncated = true
          queue.length = 0
          break
        }
        let relativePath: string
        try {
          relativePath = normalizeWorkspaceRelativePath(
            directory.relativePath === '.'
              ? dirent.name
              : `${directory.relativePath}/${dirent.name}`
          )
        } catch {
          continue
        }
        if (isReviewSensitiveRelativePath(relativePath)) continue
        const absolutePath = join(directory.absolutePath, dirent.name)
        if (protectedRoots.some((root) => isPathInsideWorkspace(root, absolutePath))) continue
        let stats: Awaited<ReturnType<typeof fs.lstat>>
        let canonical: string
        try {
          stats = await fs.lstat(absolutePath)
          if (stats.isSymbolicLink()) continue
          canonical = resolve(await fs.realpath(absolutePath))
        } catch {
          if (signal?.aborted) throw new WorkspaceToolError('cancelled')
          continue
        }
        if (
          !isPathInsideWorkspace(workspace.absolutePath, canonical) ||
          pathComparisonKey(canonical) !== pathComparisonKey(absolutePath)
        ) {
          continue
        }
        if (stats.isDirectory()) {
          queue.push({ absolutePath: canonical, relativePath })
        } else if (stats.isFile() && !trackedPaths.has(relativePath)) {
          if (entries.length < maxFiles) {
            entries.push({ relativePath, status: 'untracked' })
          } else {
            truncated = true
          }
        }
      }
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }
  return { entries, truncated }
}

async function readBoundedFile(
  handle: FileHandle,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1)
  let offset = 0
  while (offset < buffer.length) {
    throwIfAborted(signal)
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  throwIfAborted(signal)
  if (offset > maxBytes) throw new WorkspaceToolError('file_too_large')
  return buffer.subarray(0, offset)
}

async function runBoundedProcess(options: BoundedProcessOptions): Promise<Buffer> {
  throwIfAborted(options.signal)
  return new Promise<Buffer>((resolvePromise, rejectPromise) => {
    let settled = false
    let terminalError: WorkspaceToolError | null = null
    let treeTermination: Promise<void> | null = null
    let stdoutBytes = 0
    let totalOutputBytes = 0
    const stdoutChunks: Buffer[] = []
    let child: ReturnType<typeof spawn>

    const finish = (error: WorkspaceToolError | null, output?: Buffer): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (error) rejectPromise(error)
      else resolvePromise(output ?? Buffer.alloc(0))
    }
    const terminate = (error: WorkspaceToolError): void => {
      if (!terminalError) terminalError = error
      treeTermination ??= terminateChildProcessTree(child, options.env)
    }
    const onAbort = (): void => terminate(new WorkspaceToolError('cancelled'))
    const timer = setTimeout(
      () => terminate(new WorkspaceToolError('git_timeout', true)),
      options.timeoutMs
    )
    timer.unref?.()

    try {
      child = spawn(options.command, [...options.args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      finish(new WorkspaceToolError('git_unavailable', true))
      return
    }

    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    const stdout = child.stdout
    const stderr = child.stderr
    if (!stdout || !stderr) {
      terminate(new WorkspaceToolError('git_unavailable', true))
      void (treeTermination ?? Promise.resolve()).finally(() => {
        finish(new WorkspaceToolError('git_unavailable', true))
      })
      return
    }
    stdout.on('data', (chunk: Buffer) => {
      const value = Buffer.from(chunk)
      stdoutBytes += value.byteLength
      totalOutputBytes += value.byteLength
      if (totalOutputBytes > options.maxOutputBytes) {
        terminate(new WorkspaceToolError('git_output_too_large'))
        return
      }
      stdoutChunks.push(value)
    })
    stderr.on('data', (chunk: Buffer) => {
      totalOutputBytes += chunk.byteLength
      if (totalOutputBytes > options.maxOutputBytes) {
        terminate(new WorkspaceToolError('git_output_too_large'))
      }
    })
    child.once('error', () => {
      terminalError = terminalError ?? new WorkspaceToolError('git_unavailable', true)
    })
    child.once('close', (code) => {
      if (terminalError) {
        void (treeTermination ?? Promise.resolve()).finally(() => finish(terminalError))
        return
      }
      if (code !== 0) {
        finish(new WorkspaceToolError('git_failed', true))
        return
      }
      if (stdoutBytes > options.maxOutputBytes) {
        finish(new WorkspaceToolError('git_output_too_large'))
        return
      }
      finish(null, Buffer.concat(stdoutChunks, stdoutBytes))
    })
  })
}

function terminateChildProcessTree(
  child: ReturnType<typeof spawn>,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  const pid = child.pid
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    return Promise.resolve()
  }
  if (process.platform === 'win32') {
    const systemRoot = environment.SYSTEMROOT ?? environment.WINDIR
    if (
      typeof systemRoot === 'string' &&
      isAbsolute(systemRoot) &&
      !/[\r\n\0]/u.test(systemRoot)
    ) {
      try {
        const killer = spawn(
          join(systemRoot, 'System32', 'taskkill.exe'),
          ['/PID', String(pid), '/T', '/F'],
          { shell: false, windowsHide: true, stdio: 'ignore' }
        )
        return new Promise<void>((resolveTermination) => {
          let settled = false
          const finishTermination = (): void => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            resolveTermination()
          }
          const timeout = setTimeout(() => {
            try {
              killer.kill('SIGKILL')
            } catch {
              // The bounded wait is authoritative.
            }
            finishTermination()
          }, 2_000)
          timeout.unref?.()
          killer.once('error', finishTermination)
          killer.once('close', finishTermination)
        })
      } catch {
        // The direct kill below remains as the fixed fallback.
      }
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
      return Promise.resolve()
    } catch {
      // Fall through to the direct child handle.
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // The caller's fixed terminal error remains authoritative.
  }
  return Promise.resolve()
}

function selectReviewDiffPaths(entries: readonly GitStatusEntry[]): {
  readonly paths: readonly string[]
  readonly files: readonly string[]
  readonly untrackedFiles: readonly string[]
  readonly truncated: boolean
} {
  const tracked = new Set<string>()
  const untracked = new Set<string>()
  for (const entry of entries) {
    if (
      isReviewSensitiveRelativePath(entry.relativePath) ||
      (entry.originalRelativePath !== undefined &&
        isReviewSensitiveRelativePath(entry.originalRelativePath))
    ) {
      continue
    }
    if (entry.status === 'untracked') untracked.add(entry.relativePath)
    else tracked.add(entry.relativePath)
  }

  const paths: string[] = []
  let pathCharacters = 0
  let truncated = false
  for (const relativePath of [...tracked].sort((left, right) => left.localeCompare(right))) {
    const nextCharacters = pathCharacters + relativePath.length + 1
    if (
      paths.length >= MAX_REVIEW_DIFF_FILES ||
      nextCharacters > MAX_REVIEW_PATH_ARGUMENT_CHARACTERS
    ) {
      truncated = true
      continue
    }
    paths.push(relativePath)
    pathCharacters = nextCharacters
  }

  const untrackedFiles = [...untracked]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MAX_REVIEW_DIFF_FILES)
    .map(safeWorkspaceResultPath)
  if (untracked.size > untrackedFiles.length) truncated = true
  return Object.freeze({
    paths: Object.freeze(paths),
    files: Object.freeze(paths.map(safeWorkspaceResultPath)),
    untrackedFiles: Object.freeze(untrackedFiles),
    truncated
  })
}

function sanitizeGeneratedPatch(value: string): string {
  return redactSensitiveContent(
    value
      .replace(/\r\n/gu, '\n')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
  ).trim()
}

function buildBoundedUnifiedDiff(
  relativePath: string,
  baselineText: string | null,
  currentText: string | null
): string {
  if (baselineText === null && currentText === null) return ''
  const oldLines = baselineText === null ? [] : normalizedPatchLines(baselineText)
  const newLines = currentText === null ? [] : normalizedPatchLines(currentText)
  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  ) {
    suffix += 1
  }
  if (prefix === oldLines.length && prefix === newLines.length) return ''

  const contextStart = Math.max(0, prefix - 3)
  const oldChangeEnd = oldLines.length - suffix
  const newChangeEnd = newLines.length - suffix
  const oldEnd = Math.min(oldLines.length, oldChangeEnd + 3)
  const newEnd = Math.min(newLines.length, newChangeEnd + 3)
  const lines = [
    `diff --git a/${relativePath} b/${relativePath}`,
    baselineText === null ? '--- /dev/null' : `--- a/${relativePath}`,
    currentText === null ? '+++ /dev/null' : `+++ b/${relativePath}`,
    `@@ -${contextStart + 1},${oldEnd - contextStart} +${contextStart + 1},${newEnd - contextStart} @@`
  ]
  for (let index = contextStart; index < prefix; index += 1) {
    lines.push(` ${oldLines[index] ?? ''}`)
  }
  for (let index = prefix; index < oldChangeEnd; index += 1) {
    lines.push(`-${oldLines[index] ?? ''}`)
  }
  for (let index = prefix; index < newChangeEnd; index += 1) {
    lines.push(`+${newLines[index] ?? ''}`)
  }
  for (let index = 0; index < Math.min(3, suffix); index += 1) {
    lines.push(` ${oldLines[oldChangeEnd + index] ?? ''}`)
  }
  return lines.join('\n')
}

function diffStatForTexts(
  baselineText: string | null,
  currentText: string | null
): GitDiffStat {
  const oldLines = baselineText === null ? [] : normalizedPatchLines(baselineText)
  const newLines = currentText === null ? [] : normalizedPatchLines(currentText)
  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  ) {
    suffix += 1
  }
  return {
    additions: Math.min(MAX_DIFF_LINES, newLines.length - prefix - suffix),
    deletions: Math.min(MAX_DIFF_LINES, oldLines.length - prefix - suffix)
  }
}

function addGitDiffStat(
  stats: Map<string, GitDiffStat>,
  relativePath: string,
  addition: GitDiffStat
): void {
  const current = stats.get(relativePath) ?? { additions: 0, deletions: 0 }
  stats.set(relativePath, {
    additions: Math.min(MAX_DIFF_LINES, current.additions + addition.additions),
    deletions: Math.min(MAX_DIFF_LINES, current.deletions + addition.deletions)
  })
}

function normalizedPatchLines(value: string): string[] {
  const normalized = value.replace(/\r\n?/gu, '\n')
  const lines = normalized.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function formatOmittedReviewPatch(relativePath: string, reason: string): string {
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    `Review content omitted: ${reason}.`
  ].join('\n')
}

function buildGitSummary(
  branch: string,
  statusEntries: readonly GitStatusEntry[],
  diffStats: ReadonlyMap<string, GitDiffStat>,
  maxFiles: number
): GitSummary {
  const remainingStats = new Map(diffStats)
  const internal = new Map<string, MutableGitSummary>()

  for (const entry of statusEntries) {
    const current = remainingStats.get(entry.relativePath) ?? { additions: 0, deletions: 0 }
    remainingStats.delete(entry.relativePath)
    let additions = current.additions
    let deletions = current.deletions
    if (entry.originalRelativePath) {
      const original = remainingStats.get(entry.originalRelativePath)
      if (original) {
        additions = safeLineTotal(additions, original.additions)
        deletions = safeLineTotal(deletions, original.deletions)
        remainingStats.delete(entry.originalRelativePath)
      }
    }
    internal.set(entry.relativePath, { additions, deletions, status: entry.status })
  }
  for (const [relativePath, stat] of remainingStats) {
    internal.set(relativePath, { ...stat, status: 'modified' })
  }
  if (internal.size > maxFiles) throw new WorkspaceToolError('git_output_too_large')

  let additions = 0
  let deletions = 0
  const safeFiles = new Map<string, MutableGitSummary>()
  for (const [relativePath, summary] of internal) {
    additions = safeLineTotal(additions, summary.additions)
    deletions = safeLineTotal(deletions, summary.deletions)
    const safeRelativePath = safeWorkspaceResultPath(relativePath)
    const existing = safeFiles.get(safeRelativePath)
    if (!existing) {
      safeFiles.set(safeRelativePath, { ...summary })
      continue
    }
    existing.additions = safeLineTotal(existing.additions, summary.additions)
    existing.deletions = safeLineTotal(existing.deletions, summary.deletions)
    existing.status = mergeGitStatus(existing.status, summary.status)
  }

  const files: GitFileSummary[] = [...safeFiles.entries()]
    .map(([relativePath, summary]) => Object.freeze({ relativePath, ...summary }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))

  return Object.freeze({ branch, additions, deletions, files })
}

function normalizeWorkspaceRelativePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_RELATIVE_PATH_CHARACTERS ||
    value !== value.trim() ||
    /[\r\n\0]/u.test(value) ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.startsWith('//') ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    posix.isAbsolute(value) ||
    /^\\\\[?.]\\/u.test(value)
  ) {
    throw new WorkspaceToolError('invalid_relative_path')
  }

  const segments = value.replaceAll('\\', '/').split('/')
  if (segments.length === 0) throw new WorkspaceToolError('invalid_relative_path')
  for (const segment of segments) {
    if (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      segment.length > MAX_PATH_SEGMENT_CHARACTERS ||
      segment.endsWith('.') ||
      segment.endsWith(' ') ||
      INVALID_WINDOWS_SEGMENT_CHARACTER.test(segment) ||
      WINDOWS_RESERVED_NAME.test(segment)
    ) {
      throw new WorkspaceToolError('invalid_relative_path')
    }
  }
  return segments.join('/')
}

function normalizeWorkspaceDirectoryPath(value: unknown): string {
  if (value === '.') return '.'
  return normalizeWorkspaceRelativePath(value)
}

function insertBoundedDirectoryEntry(
  entries: WorkspaceDirectoryEntry[],
  entry: WorkspaceDirectoryEntry,
  maximumEntries: number
): void {
  let low = 0
  let high = entries.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (compareDirectoryEntries(entries[middle]!, entry) <= 0) low = middle + 1
    else high = middle
  }
  if (low >= maximumEntries) return
  entries.splice(low, 0, entry)
  if (entries.length > maximumEntries) entries.pop()
}

function compareDirectoryEntries(
  left: WorkspaceDirectoryEntry,
  right: WorkspaceDirectoryEntry
): number {
  if (left.relativePath < right.relativePath) return -1
  if (left.relativePath > right.relativePath) return 1
  if (left.kind < right.kind) return -1
  if (left.kind > right.kind) return 1
  return 0
}

function buildBoundedDirectoryResult(
  candidates: readonly WorkspaceDirectoryEntry[],
  eligibleEntryCount: number,
  maximumCharacters: number
): WorkspaceDirectoryResult {
  const entries: WorkspaceDirectoryEntry[] = []
  for (const candidate of candidates) {
    const nextEntries = [...entries, candidate]
    const truncated = eligibleEntryCount > nextEntries.length
    if (JSON.stringify({ entries: nextEntries, truncated }).length > maximumCharacters) break
    entries.push(candidate)
  }
  return Object.freeze({
    entries,
    truncated: eligibleEntryCount > entries.length
  })
}

function normalizeGitRelativePath(value: unknown): string {
  try {
    return normalizeWorkspaceRelativePath(value)
  } catch {
    throw new WorkspaceToolError('git_invalid_output')
  }
}

function isSensitiveRelativePath(relativePath: string): boolean {
  const segments = relativePath.toLowerCase().split('/')
  const fileName = segments.at(-1) ?? ''
  if (segments.some((segment) => SENSITIVE_DIRECTORY_NAMES.has(segment))) return true
  if (fileName.startsWith('.env')) return true
  if (SENSITIVE_EXACT_FILE_NAMES.has(fileName)) return true
  if (SENSITIVE_FILE_EXTENSION.test(fileName)) return true
  if (
    segments.includes('secure') &&
    (fileName === 'access-profiles.json' || fileName === 'conversation-history.json')
  ) {
    return true
  }
  return false
}

function isReviewSensitiveRelativePath(relativePath: string): boolean {
  const segments = relativePath.toLowerCase().split('/')
  return isSensitiveRelativePath(relativePath) ||
    segments.some((segment) =>
      segment === '.git' ||
      segment === '.codex' ||
      segment === '.agents' ||
      segment === 'node_modules'
    )
}

function isProtectedWriteRelativePath(relativePath: string): boolean {
  const segments = relativePath.toLowerCase().split('/')
  const fileName = segments.at(-1) ?? ''
  return segments.some((segment) => PROTECTED_WRITE_DIRECTORY_NAMES.has(segment)) ||
    PROTECTED_WRITE_FILE_NAMES.has(fileName) ||
    fileName.startsWith('.ai-terminal-write-')
}

function isSearchExcludedRelativePath(relativePath: string): boolean {
  return relativePath !== '.' &&
    (isSensitiveRelativePath(relativePath) || isProtectedWriteRelativePath(relativePath))
}

function isSafeSearchEntryName(value: string): boolean {
  return value.length > 0 &&
    value.length <= MAX_PATH_SEGMENT_CHARACTERS &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    value !== '.' &&
    value !== '..'
}

function containsUnsafeControlCharacters(value: Uint8Array): boolean {
  for (const byte of value) {
    if ((byte >= 0 && byte <= 8) || byte === 11 || byte === 12 || (byte >= 14 && byte <= 31) || byte === 127) {
      return true
    }
  }
  return false
}

function buildSearchPreview(
  line: string,
  matchOffset: number,
  matchLength: number,
  maximumCharacters: number
): string {
  const start = Math.max(0, matchOffset - SEARCH_CONTEXT_CHARACTERS)
  const end = Math.min(line.length, matchOffset + matchLength + SEARCH_CONTEXT_CHARACTERS)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < line.length ? '...' : ''
  const redacted = redactSensitiveContent(`${prefix}${line.slice(start, end)}${suffix}`)
  return truncateText(redacted, maximumCharacters).text
}

function countLiteralMatches(value: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let offset = 0
  while (offset <= value.length - needle.length) {
    const match = value.indexOf(needle, offset)
    if (match < 0) break
    count += 1
    if (count > 1) return count
    offset = match + needle.length
  }
  return count
}

function safeWorkspaceResultPath(relativePath: string): string {
  if (isSensitiveRelativePath(relativePath)) return '<sensitive-file>'
  const redacted = redactSensitiveContent(relativePath)
  const bounded = truncateText(redacted, MAX_RELATIVE_PATH_CHARACTERS).text
  return bounded || '<redacted-file>'
}

function mergeGitStatus(
  left: GitFileSummary['status'],
  right: GitFileSummary['status']
): GitFileSummary['status'] {
  const priority: Readonly<Record<GitFileSummary['status'], number>> = {
    modified: 1,
    untracked: 2,
    added: 3,
    renamed: 4,
    deleted: 5
  }
  return priority[right] > priority[left] ? right : left
}

function safeLineTotal(left: number, right: number): number {
  const total = left + right
  if (!Number.isSafeInteger(total) || total > MAX_DIFF_LINES) {
    throw new WorkspaceToolError('git_invalid_output')
  }
  return total
}

function decodeGitOutput(output: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(output)
  } catch {
    throw new WorkspaceToolError('git_invalid_output')
  }
}

function sanitizedGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    LANG: 'C',
    LC_ALL: 'C'
  }
  for (const name of ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP']) {
    const value = source[name]
    if (value !== undefined) environment[name] = value
  }
  return environment
}

function parseProtectedRoots(value: readonly string[] | undefined): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 64) throw new WorkspaceToolError('invalid_request')
  return value.map((root) => {
    if (
      typeof root !== 'string' ||
      root.length < 1 ||
      root.length > 32_768 ||
      !isAbsolute(root) ||
      /[\r\n\0]/u.test(root)
    ) {
      throw new WorkspaceToolError('invalid_request')
    }
    return resolve(root)
  })
}

function isPathInsideWorkspace(root: string, candidate: string): boolean {
  const rootKey = pathComparisonKey(resolve(root))
  const candidateKey = pathComparisonKey(resolve(candidate))
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}${sep}`)
}

function pathComparisonKey(value: string): string {
  const normalized = resolve(value).replace(/^\\\\\?\\/u, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function sameStoredIdentity(
  workspace: ResolvedWorkspaceRecord,
  stats: BigIntStats
): boolean {
  return workspace.device !== '0' &&
    workspace.inode !== '0' &&
    stats.dev !== 0n &&
    stats.ino !== 0n &&
    workspace.device === stats.dev.toString(10) &&
    workspace.inode === stats.ino.toString(10)
}

function sameFileIdentity(
  expected: Awaited<ReturnType<typeof fs.lstat>>,
  actual: Awaited<ReturnType<FileHandle['stat']>>
): boolean {
  if (expected.dev !== 0 && actual.dev !== 0 && expected.dev !== actual.dev) return false
  if (expected.ino !== 0 && actual.ino !== 0 && expected.ino !== actual.ino) return false
  return true
}

function assertSingleLinkRegularFile(stats: { isFile(): boolean; nlink: number | bigint }): void {
  // Some filesystems report zero when a reliable link count is unavailable.
  const hasMultipleLinks =
    typeof stats.nlink === 'bigint' ? stats.nlink > 1n : stats.nlink > 1
  if (stats.isFile() && hasMultipleLinks) {
    throw new WorkspaceToolError('hard_link_rejected')
  }
}

function truncateText(value: string, maximumCharacters: number): { text: string; truncated: boolean } {
  if (value.length <= maximumCharacters) return { text: value, truncated: false }
  let text = value.slice(0, maximumCharacters)
  const finalCodeUnit = text.charCodeAt(text.length - 1)
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) text = text.slice(0, -1)
  return { text, truncated: true }
}

function validateGitExecutable(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 32_768 ||
    /[\r\n\0]/u.test(value)
  ) {
    throw new WorkspaceToolError('invalid_request')
  }
  return value
}

async function resolveGitExecutable(
  configured: string,
  environment: NodeJS.ProcessEnv,
  workspaceRoot: string
): Promise<string> {
  if (isAbsolute(configured)) return await validateResolvedExecutable(configured, workspaceRoot)
  if (configured.includes('/') || configured.includes('\\')) {
    throw new WorkspaceToolError('git_unavailable')
  }

  const pathValue = environment.PATH
  if (!pathValue) throw new WorkspaceToolError('git_unavailable')
  const names = process.platform === 'win32' && !/\.[A-Za-z0-9]+$/u.test(configured)
    ? [`${configured}.exe`]
    : [configured]

  for (const rawDirectory of pathValue.split(delimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/gu, '')
    if (!directory || !isAbsolute(directory) || /[\r\n\0]/u.test(directory)) continue
    for (const name of names) {
      try {
        return await validateResolvedExecutable(join(directory, name), workspaceRoot)
      } catch (error) {
        if (error instanceof WorkspaceToolError && error.code === 'git_unavailable') continue
        throw error
      }
    }
  }
  throw new WorkspaceToolError('git_unavailable')
}

async function validateResolvedExecutable(candidate: string, workspaceRoot: string): Promise<string> {
  try {
    const resolvedExecutable = resolve(await fs.realpath(candidate))
    const stats = await fs.stat(resolvedExecutable)
    if (!stats.isFile() || isPathInsideWorkspace(workspaceRoot, resolvedExecutable)) {
      throw new WorkspaceToolError('git_unavailable')
    }
    return resolvedExecutable
  } catch (error) {
    if (error instanceof WorkspaceToolError) throw error
    throw new WorkspaceToolError('git_unavailable')
  }
}

function nullDevicePath(): string {
  return process.platform === 'win32' ? 'NUL' : '/dev/null'
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const candidate = value ?? fallback
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new WorkspaceToolError('invalid_request')
  }
  return candidate
}

function assertReadFileInput(value: unknown): asserts value is WorkspaceFileInput {
  if (
    !hasExactKeys(value, ['workspaceToken', 'relativePath']) ||
    typeof value.workspaceToken !== 'string' ||
    typeof value.relativePath !== 'string'
  ) {
    throw new WorkspaceToolError('invalid_request')
  }
}

function assertListDirectoryInput(value: unknown): asserts value is WorkspaceDirectoryInput {
  if (
    !hasExactKeys(value, ['workspaceToken', 'relativePath']) ||
    typeof value.workspaceToken !== 'string' ||
    typeof value.relativePath !== 'string'
  ) {
    throw new WorkspaceToolError('invalid_request')
  }
}

function assertWriteFileInput(value: unknown): asserts value is WorkspaceWriteInput {
  if (!isPlainRecord(value)) throw new WorkspaceToolError('invalid_request')
  const keys = Object.keys(value)
  const hasExpectedRevision = Object.hasOwn(value, 'expectedRevision')
  if (
    keys.length !== (hasExpectedRevision ? 4 : 3) ||
    !['workspaceToken', 'relativePath', 'content', 'expectedRevision'].every(
      (key) => key === 'expectedRevision' || Object.hasOwn(value, key)
    ) ||
    keys.some((key) => !['workspaceToken', 'relativePath', 'content', 'expectedRevision'].includes(key)) ||
    typeof value.workspaceToken !== 'string' ||
    typeof value.relativePath !== 'string' ||
    typeof value.content !== 'string' ||
    value.content.includes('\0') ||
    (value.expectedRevision !== undefined &&
      (typeof value.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(value.expectedRevision)))
  ) {
    throw new WorkspaceToolError('invalid_request')
  }
}

function assertSearchFilesInput(value: unknown): asserts value is WorkspaceSearchInput {
  if (
    !hasExactKeys(value, ['workspaceToken', 'relativePath', 'query', 'caseSensitive']) ||
    typeof value.workspaceToken !== 'string' ||
    typeof value.relativePath !== 'string' ||
    typeof value.query !== 'string' ||
    value.query.length < 1 ||
    value.query.length > MAX_SEARCH_QUERY_CHARACTERS ||
    value.query.includes('\0') ||
    /[\r\n\u0000-\u001f\u007f]/u.test(value.query) ||
    typeof value.caseSensitive !== 'boolean'
  ) {
    throw new WorkspaceToolError('invalid_request')
  }
}

function assertReplaceInFileInput(value: unknown): asserts value is WorkspaceReplaceInput {
  if (
    !hasExactKeys(value, ['workspaceToken', 'relativePath', 'oldText', 'newText', 'expectedRevision']) ||
    typeof value.workspaceToken !== 'string' ||
    typeof value.relativePath !== 'string' ||
    typeof value.oldText !== 'string' ||
    typeof value.newText !== 'string' ||
    typeof value.expectedRevision !== 'string' ||
    value.oldText.length < 1 ||
    value.oldText.includes('\0') ||
    value.newText.includes('\0') ||
    !/^[a-f0-9]{64}$/u.test(value.expectedRevision)
  ) {
    throw new WorkspaceToolError('invalid_request')
  }
}

function assertGitSummaryInput(value: unknown): asserts value is { workspaceToken: string } {
  if (!hasExactKeys(value, ['workspaceToken']) || typeof value.workspaceToken !== 'string') {
    throw new WorkspaceToolError('invalid_request')
  }
}

function assertOwner(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new WorkspaceToolError('invalid_request')
  }
}

function assertSignal(value: unknown): asserts value is AbortSignal | undefined {
  if (value === undefined) return
  if (typeof value !== 'object' || value === null) {
    throw new WorkspaceToolError('invalid_request')
  }
  const candidate = value as {
    aborted?: unknown
    addEventListener?: unknown
    removeEventListener?: unknown
  }
  if (
    typeof candidate.aborted !== 'boolean' ||
    typeof candidate.addEventListener !== 'function' ||
    typeof candidate.removeEventListener !== 'function'
  ) {
    throw new WorkspaceToolError('invalid_request')
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WorkspaceToolError('cancelled')
}

function fixedFileSystemError(error: unknown): WorkspaceToolError {
  if (isNodeErrorCode(error, 'ENOENT') || isNodeErrorCode(error, 'ENOTDIR')) {
    return new WorkspaceToolError('path_not_found')
  }
  if (isNodeErrorCode(error, 'EISDIR')) return new WorkspaceToolError('path_not_file')
  return new WorkspaceToolError('workspace_unavailable', true)
}

function fixedDirectorySystemError(error: unknown): WorkspaceToolError {
  if (isNodeErrorCode(error, 'ENOENT') || isNodeErrorCode(error, 'ENOTDIR')) {
    return new WorkspaceToolError('path_not_found')
  }
  return new WorkspaceToolError('workspace_unavailable', true)
}

function isNodeErrorCode(value: unknown, code: string): boolean {
  return value instanceof Error && 'code' in value && value.code === code
}

function hasExactKeys<K extends string>(
  value: unknown,
  expectedKeys: readonly K[]
): value is Record<K, unknown> {
  if (!isPlainRecord(value)) return false
  const keys = Object.keys(value)
  return keys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key))
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
