import { execFile, spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { win32 } from 'node:path'

import {
  WORKSPACE_OPENER_IDS,
  type WorkspaceOpenerDescriptor,
  type WorkspaceOpenerId,
  type WorkspaceOpenerKind,
} from '../../shared/contracts.ts'

export { WORKSPACE_OPENER_IDS }
export type { WorkspaceOpenerId, WorkspaceOpenerKind }
export type DetectedWorkspaceOpener = WorkspaceOpenerDescriptor

export interface WorkspaceOpenerWorkspace {
  readonly absolutePath: string
  readonly device: string
  readonly inode: string
}

export interface WorkspaceOpenRequest {
  readonly openerId: WorkspaceOpenerId
  readonly workspace: WorkspaceOpenerWorkspace
}

export interface WorkspaceOpenerTrustedRoots {
  readonly localAppData?: string
  readonly programFiles?: string
  readonly programFilesX86?: string
  readonly windows?: string
}

export interface WorkspaceOpenerStats {
  readonly dev: bigint
  readonly ino: bigint
  readonly size: bigint
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export interface WorkspaceOpenerFileSystem {
  fileExists(absolutePath: string): Promise<boolean>
  listDirectories(absolutePath: string): Promise<readonly string[]>
  lstat(absolutePath: string): Promise<WorkspaceOpenerStats>
  stat(absolutePath: string): Promise<WorkspaceOpenerStats>
  realpath(absolutePath: string): Promise<string>
  hashFile(absolutePath: string): Promise<string>
}

export interface WorkspaceOpenerSpawnOptions {
  readonly shell: false
  readonly detached: true
  readonly stdio: 'ignore'
  readonly env: Readonly<NodeJS.ProcessEnv>
}

export interface WorkspaceOpenerChildProcess {
  once(event: 'spawn', listener: () => void): this
  once(event: 'error', listener: (error: unknown) => void): this
  unref(): void
}

export type WorkspaceOpenerSpawn = (
  executable: string,
  args: readonly string[],
  options: WorkspaceOpenerSpawnOptions
) => WorkspaceOpenerChildProcess

export type WorkspaceOpenerDiscoveryCommand = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  environment: Readonly<NodeJS.ProcessEnv>
) => Promise<string | null>

export type WorkspaceOpenerPublisherVerifier = (
  openerId: WorkspaceOpenerId,
  executable: string
) => Promise<boolean>

export interface WorkspaceOpenerServiceOptions {
  readonly platform?: NodeJS.Platform
  readonly roots?: WorkspaceOpenerTrustedRoots
  readonly fileSystem?: WorkspaceOpenerFileSystem
  readonly spawn?: WorkspaceOpenerSpawn
  readonly runDiscoveryCommand?: WorkspaceOpenerDiscoveryCommand
  readonly verifyPublisher?: WorkspaceOpenerPublisherVerifier
  readonly environmentSource?: NodeJS.ProcessEnv
}

export type WorkspaceOpenerErrorCode =
  | 'invalid_request'
  | 'unsupported_platform'
  | 'opener_unavailable'
  | 'workspace_unavailable'
  | 'workspace_changed'
  | 'launch_failed'

const ERROR_MESSAGES: Readonly<Record<WorkspaceOpenerErrorCode, string>> = Object.freeze({
  invalid_request: 'The workspace open request is invalid.',
  unsupported_platform: 'Workspace opening is unavailable on this platform.',
  opener_unavailable: 'The selected workspace application is unavailable.',
  workspace_unavailable: 'The selected workspace is unavailable.',
  workspace_changed: 'The selected workspace has changed. Select it again before opening.',
  launch_failed: 'The selected workspace application could not be started.'
})

export class WorkspaceOpenerError extends Error {
  readonly code: WorkspaceOpenerErrorCode

  constructor(code: WorkspaceOpenerErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'WorkspaceOpenerError'
    this.code = code
    this.stack = `${this.name}: ${this.message}`
  }
}

interface OpenerDefinition extends DetectedWorkspaceOpener {}

interface VerifiedExecutable {
  readonly absolutePath: string
  readonly device: bigint
  readonly inode: bigint
  readonly size: bigint
  readonly sha256: string
}

type RootName = keyof WorkspaceOpenerTrustedRoots

const DEFINITIONS: readonly OpenerDefinition[] = Object.freeze([
  Object.freeze({ id: 'vscode', label: 'VS Code', kind: 'editor' }),
  Object.freeze({ id: 'visual-studio', label: 'Visual Studio', kind: 'editor' }),
  Object.freeze({ id: 'cursor', label: 'Cursor', kind: 'editor' }),
  Object.freeze({ id: 'github-desktop', label: 'GitHub Desktop', kind: 'git' }),
  Object.freeze({ id: 'explorer', label: '文件资源管理器', kind: 'file-manager' }),
  Object.freeze({ id: 'terminal', label: 'Windows Terminal', kind: 'terminal' }),
  Object.freeze({ id: 'wsl', label: 'WSL', kind: 'terminal' }),
  Object.freeze({ id: 'pycharm', label: 'PyCharm', kind: 'editor' })
])

const DEFINITION_BY_ID = new Map(DEFINITIONS.map((definition) => [definition.id, definition]))
const MAX_PATH_CHARACTERS = 32_768
const MAX_DIRECTORY_ENTRIES = 512
const MAX_DISCOVERY_OUTPUT_BYTES = 64 * 1024
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024
const DISCOVERY_TIMEOUT_MS = 5_000
const SIGNATURE_TIMEOUT_MS = 15_000
const VISUAL_STUDIO_EDITIONS = Object.freeze([
  'Community',
  'Professional',
  'Enterprise',
  'Preview',
  'Insiders',
  'BuildTools'
])
const VISUAL_STUDIO_KNOWN_VERSIONS = Object.freeze([
  '2026',
  '2022',
  '2019',
  '2017',
  '18',
  '17',
  '16',
  '15'
])
const VISUAL_STUDIO_VERSION_PATTERN = /^(?:20\d{2}|\d{2}(?:\.\d+)?)$/u
const GITHUB_DESKTOP_VERSION_PATTERN = /^app-\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.-]+)?$/u
const PYCHARM_DIRECTORY_PATTERN =
  /^PyCharm(?: Community Edition| Professional Edition| Community| Professional)?(?: \d{4}\.\d+(?:\.\d+)*(?: EAP)?)?$/u
const TOOLBOX_PYCHARM_PATTERN = /^PyCharm-(?:P|C|E)$/u
const TOOLBOX_CHANNEL_PATTERN = /^ch-\d+$/u
const TOOLBOX_VERSION_PATTERN = /^[0-9][A-Za-z0-9._-]{0,63}$/u
const WINDOWS_TERMINAL_PACKAGE_PATTERN =
  /^Microsoft\.WindowsTerminal(?:Preview)?_[0-9.]+_[A-Za-z0-9]+__8wekyb3d8bbwe$/iu
const MAX_ENVIRONMENT_VALUE_CHARACTERS = 32_767
const SAFE_LAUNCH_ENVIRONMENT_KEYS = new Set([
  'ALLUSERSPROFILE',
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'APPDATA',
  'CARGO_HOME',
  'CMAKE_PREFIX_PATH',
  'COMSPEC',
  'DOTNET_ROOT',
  'GOPATH',
  'GOROOT',
  'HOMEDRIVE',
  'HOMEPATH',
  'JAVA_HOME',
  'JDK_HOME',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'NVM_HOME',
  'NVM_SYMLINK',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'PYENV',
  'PYENV_ROOT',
  'RUSTUP_HOME',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'VCPKG_ROOT',
  'WINDIR'
])
const SAFE_DISCOVERY_ENVIRONMENT_KEYS = new Set([
  'ALLUSERSPROFILE',
  'APPDATA',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR'
])
const EXPECTED_PUBLISHER_COMMON_NAMES: Readonly<
  Record<WorkspaceOpenerId, ReadonlySet<string>>
> = Object.freeze({
  vscode: new Set(['microsoft corporation']),
  'visual-studio': new Set(['microsoft corporation']),
  cursor: new Set([
    'anysphere, inc.',
    'cursor ai, inc.'
  ]),
  'github-desktop': new Set(['github, inc.']),
  explorer: new Set(['microsoft windows']),
  terminal: new Set(['microsoft corporation']),
  wsl: new Set(['microsoft windows']),
  pycharm: new Set(['jetbrains s.r.o.'])
})
const AUTHENTICODE_SCRIPT_BODY = [
  '$signature = Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $TargetPath;',
  "if ($signature.Status -eq 'Valid' -and $null -ne $signature.SignerCertificate) {",
  '$publisher = $signature.SignerCertificate.GetNameInfo(',
  '  [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,',
  '  $false',
  ');',
  '[Console]::Out.Write($publisher)',
  '}'
].join(' ')
const WINDOWS_TERMINAL_DISCOVERY_SCRIPT = [
  "$allowedNames = @('Microsoft.WindowsTerminal', 'Microsoft.WindowsTerminalPreview');",
  "$package = Appx\\Get-AppxPackage -Name 'Microsoft.WindowsTerminal*' | Where-Object {",
  '  $allowedNames -contains $_.Name -and',
  "  $_.PackageFamilyName -eq ($_.Name + '_8wekyb3d8bbwe') -and",
  "  $_.PublisherId -eq '8wekyb3d8bbwe' -and",
  "  @('Store', 'System') -contains [string]$_.SignatureKind",
  '} | Sort-Object Version -Descending | Select-Object -First 1;',
  'if ($null -ne $package -and $null -ne $package.InstallLocation) {',
  "[Console]::Out.Write((Microsoft.PowerShell.Management\\Join-Path $package.InstallLocation 'wt.exe'))",
  '}'
].join(' ')

const DEFAULT_FILE_SYSTEM: WorkspaceOpenerFileSystem = Object.freeze({
  async fileExists(absolutePath: string): Promise<boolean> {
    try {
      const entry = await fs.lstat(absolutePath)
      return entry.isFile() && !entry.isSymbolicLink()
    } catch {
      return false
    }
  },
  async listDirectories(absolutePath: string): Promise<readonly string[]> {
    try {
      const entries = await fs.readdir(absolutePath, { withFileTypes: true })
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return []
    }
  },
  lstat: (absolutePath: string) => fs.lstat(absolutePath, { bigint: true }),
  stat: (absolutePath: string) => fs.stat(absolutePath, { bigint: true }),
  realpath: (absolutePath: string) => fs.realpath(absolutePath),
  hashFile: hashExecutableFile
})

const DEFAULT_SPAWN: WorkspaceOpenerSpawn = (executable, args, options) =>
  nodeSpawn(executable, [...args], options)

const DEFAULT_DISCOVERY_COMMAND: WorkspaceOpenerDiscoveryCommand = (
  executable,
  args,
  timeoutMs,
  environment
) =>
  new Promise((resolveCommand) => {
    try {
      execFile(executable, [...args], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: Math.min(Math.max(timeoutMs, 1), SIGNATURE_TIMEOUT_MS),
        maxBuffer: MAX_DISCOVERY_OUTPUT_BYTES,
        shell: false,
        env: environment
      }, (error, stdout) => {
        if (error !== null || typeof stdout !== 'string') {
          resolveCommand(null)
          return
        }
        resolveCommand(stdout.slice(0, MAX_DISCOVERY_OUTPUT_BYTES))
      })
    } catch {
      resolveCommand(null)
    }
  })

export class WorkspaceOpenerService {
  readonly #platform: NodeJS.Platform
  readonly #roots: Readonly<WorkspaceOpenerTrustedRoots>
  readonly #fileSystem: WorkspaceOpenerFileSystem
  readonly #spawn: WorkspaceOpenerSpawn
  readonly #runDiscoveryCommand: WorkspaceOpenerDiscoveryCommand
  readonly #verifyPublisherOverride: WorkspaceOpenerPublisherVerifier | null
  readonly #launchEnvironment: Readonly<NodeJS.ProcessEnv>
  readonly #discoveryEnvironment: Readonly<NodeJS.ProcessEnv>
  #detectedExecutables = new Map<WorkspaceOpenerId, VerifiedExecutable>()
  #detectedOpeners: readonly DetectedWorkspaceOpener[] | null = null
  #detectionPromise: Promise<readonly DetectedWorkspaceOpener[]> | null = null

  constructor(options: WorkspaceOpenerServiceOptions = {}) {
    this.#platform = options.platform ?? process.platform
    this.#roots = normalizeRoots(options.roots ?? environmentRoots())
    this.#fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM
    this.#spawn = options.spawn ?? DEFAULT_SPAWN
    this.#runDiscoveryCommand = options.runDiscoveryCommand ?? DEFAULT_DISCOVERY_COMMAND
    this.#verifyPublisherOverride = options.verifyPublisher ?? null
    this.#launchEnvironment = sanitizeLaunchEnvironment(
      options.environmentSource ?? process.env,
      this.#roots.windows
    )
    this.#discoveryEnvironment = sanitizeDiscoveryEnvironment(
      this.#launchEnvironment,
      this.#roots.windows
    )
  }

  async detect(): Promise<readonly DetectedWorkspaceOpener[]> {
    if (this.#detectedOpeners !== null) return this.#detectedOpeners
    if (this.#detectionPromise !== null) return this.#detectionPromise
    const request = this.#detectAvailableOpeners()
    this.#detectionPromise = request
    try {
      const detected = await request
      this.#detectedOpeners = detected
      return detected
    } finally {
      if (this.#detectionPromise === request) this.#detectionPromise = null
    }
  }

  async #detectAvailableOpeners(): Promise<readonly DetectedWorkspaceOpener[]> {
    if (this.#platform !== 'win32') {
      this.#detectedExecutables = new Map()
      return Object.freeze([])
    }

    const detectedExecutables = new Map<WorkspaceOpenerId, VerifiedExecutable>()
    const detected: DetectedWorkspaceOpener[] = []
    const results = await Promise.all(DEFINITIONS.map(async (definition) => ({
      definition,
      executable: await this.#findExecutable(definition.id)
    })))
    for (const { definition, executable } of results) {
      if (executable === null) continue
      detectedExecutables.set(definition.id, executable)
      detected.push(Object.freeze({
        id: definition.id,
        label: definition.label,
        kind: definition.kind
      }))
    }
    this.#detectedExecutables = detectedExecutables
    return Object.freeze(detected)
  }

  async open(request: WorkspaceOpenRequest): Promise<void> {
    if (this.#platform !== 'win32') throw new WorkspaceOpenerError('unsupported_platform')
    const validated = validateOpenRequest(request)
    const cachedExecutable = this.#detectedExecutables.get(validated.openerId)
    if (cachedExecutable === undefined) throw new WorkspaceOpenerError('opener_unavailable')
    await this.#verifyWorkspace(validated.workspace)
    const executable = await this.#validateDiscoveredExecutable(
      validated.openerId,
      cachedExecutable.absolutePath
    )
    if (executable === null) {
      this.#detectedExecutables.delete(validated.openerId)
      this.#detectedOpeners = null
      throw new WorkspaceOpenerError('opener_unavailable')
    }
    const contentVerifiedExecutable = await this.#revalidateExecutableIdentity(executable)
    if (contentVerifiedExecutable === null) {
      this.#detectedExecutables.delete(validated.openerId)
      this.#detectedOpeners = null
      throw new WorkspaceOpenerError('opener_unavailable')
    }
    const canonicalWorkspace = await this.#verifyWorkspace(validated.workspace)
    const launchExecutable = await this.#revalidateExecutableIdentity(executable, false)
    if (launchExecutable === null) {
      this.#detectedExecutables.delete(validated.openerId)
      this.#detectedOpeners = null
      throw new WorkspaceOpenerError('opener_unavailable')
    }
    this.#detectedExecutables.set(validated.openerId, executable)
    await this.#launch(
      launchExecutable,
      launchArguments(validated.openerId, canonicalWorkspace)
    )
  }

  async #findExecutable(openerId: WorkspaceOpenerId): Promise<VerifiedExecutable | null> {
    switch (openerId) {
      case 'vscode':
        return this.#findVsCode()
      case 'visual-studio':
        return this.#findVisualStudio()
      case 'cursor':
        return this.#findCursor()
      case 'github-desktop':
        return this.#findGitHubDesktop()
      case 'explorer':
        return this.#firstVerifiedExecutable('explorer', [
          this.#candidate('windows', 'explorer.exe')
        ])
      case 'terminal':
        return this.#findWindowsTerminal()
      case 'wsl':
        return this.#firstVerifiedExecutable('wsl', [
          this.#candidate('windows', 'System32', 'wsl.exe'),
          this.#candidate('windows', 'Sysnative', 'wsl.exe')
        ])
      case 'pycharm':
        return this.#findPyCharm()
    }
  }

  async #findVsCode(): Promise<VerifiedExecutable | null> {
    const fixed = await this.#firstVerifiedExecutable('vscode', [
      this.#candidate('localAppData', 'Programs', 'Microsoft VS Code', 'Code.exe'),
      this.#candidate('programFiles', 'Microsoft VS Code', 'Code.exe'),
      this.#candidate('programFilesX86', 'Microsoft VS Code', 'Code.exe'),
      this.#candidate('localAppData', 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe'),
      this.#candidate('programFiles', 'Microsoft VS Code Insiders', 'Code - Insiders.exe'),
      this.#candidate('programFilesX86', 'Microsoft VS Code Insiders', 'Code - Insiders.exe')
    ])
    if (fixed !== null) return fixed
    return this.#discoverEditorFromWhere('vscode', ['code', 'code.cmd'])
  }

  async #findCursor(): Promise<VerifiedExecutable | null> {
    const fixed = await this.#firstVerifiedExecutable('cursor', [
      this.#candidate('localAppData', 'Programs', 'cursor', 'Cursor.exe'),
      this.#candidate('localAppData', 'Programs', 'Cursor', 'Cursor.exe'),
      this.#candidate('programFiles', 'Cursor', 'Cursor.exe'),
      this.#candidate('programFilesX86', 'Cursor', 'Cursor.exe')
    ])
    if (fixed !== null) return fixed
    return this.#discoverEditorFromWhere('cursor', ['cursor', 'cursor.exe'])
  }

  async #findVisualStudio(): Promise<VerifiedExecutable | null> {
    const candidates: Array<string | null> = []
    for (const rootName of ['programFiles', 'programFilesX86'] as const) {
      const base = this.#candidate(rootName, 'Microsoft Visual Studio')
      if (base === null) continue
      const discoveredVersions = (await this.#safeListDirectories(base))
        .filter((name) => VISUAL_STUDIO_VERSION_PATTERN.test(name))
      const versions = uniqueSortedVersions([
        ...VISUAL_STUDIO_KNOWN_VERSIONS,
        ...discoveredVersions
      ])
      for (const version of versions) {
        for (const edition of VISUAL_STUDIO_EDITIONS) {
          candidates.push(this.#containedCandidate(
            base,
            version,
            edition,
            'Common7',
            'IDE',
            'devenv.exe'
          ))
        }
      }
    }
    const fixed = await this.#firstVerifiedExecutable('visual-studio', candidates)
    if (fixed !== null) return fixed

    const fromPath = await this.#discoverDirectExecutableFromWhere(
      'visual-studio',
      ['devenv.exe', 'devenv']
    )
    if (fromPath !== null) return fromPath

    for (const rootName of ['programFilesX86', 'programFiles'] as const) {
      const vswhere = this.#candidate(
        rootName,
        'Microsoft Visual Studio',
        'Installer',
        'vswhere.exe'
      )
      if (vswhere === null || !(await this.#safeFileExists(vswhere))) continue
      const output = await this.#runDiscovery(vswhere, [
        '-products',
        '*',
        '-all',
        '-find',
        '**\\Common7\\IDE\\devenv.exe',
        '-utf8',
        '-nologo',
        '-prerelease'
      ])
      for (const line of discoveryLines(output)) {
        const validated = await this.#validateDiscoveredExecutable('visual-studio', line)
        if (validated !== null) return validated
      }
    }
    return null
  }

  async #findGitHubDesktop(): Promise<VerifiedExecutable | null> {
    const candidates: Array<string | null> = [
      this.#candidate('localAppData', 'GitHubDesktop', 'GitHubDesktop.exe'),
      this.#candidate('localAppData', 'Programs', 'GitHub Desktop', 'GitHubDesktop.exe'),
      this.#candidate('programFiles', 'GitHub Desktop', 'GitHubDesktop.exe'),
      this.#candidate('programFilesX86', 'GitHub Desktop', 'GitHubDesktop.exe')
    ]
    const base = this.#candidate('localAppData', 'GitHubDesktop')
    if (base !== null) {
      const versions = uniqueSortedVersions(
        (await this.#safeListDirectories(base))
          .filter((name) => GITHUB_DESKTOP_VERSION_PATTERN.test(name))
      )
      for (const version of versions) {
        candidates.push(this.#containedCandidate(base, version, 'GitHubDesktop.exe'))
      }
    }
    return this.#firstVerifiedExecutable('github-desktop', candidates)
  }

  async #findWindowsTerminal(): Promise<VerifiedExecutable | null> {
    const candidates: Array<string | null> = []
    const windowsApps = this.#candidate('programFiles', 'WindowsApps')
    if (windowsApps !== null) {
      const packages = uniqueSortedVersions(
        (await this.#safeListDirectories(windowsApps))
          .filter((name) => WINDOWS_TERMINAL_PACKAGE_PATTERN.test(name))
      )
      for (const packageName of packages) {
        candidates.push(this.#containedCandidate(windowsApps, packageName, 'wt.exe'))
      }
    }
    const fixed = await this.#firstVerifiedExecutable('terminal', candidates)
    if (fixed !== null) return fixed

    const powershell = this.#candidate(
      'windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
    if (powershell === null || !(await this.#safeFileExists(powershell))) return null
    const output = await this.#runDiscovery(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      powershellEncodedCommand(WINDOWS_TERMINAL_DISCOVERY_SCRIPT)
    ], SIGNATURE_TIMEOUT_MS)
    for (const line of discoveryLines(output)) {
      const validated = await this.#validateDiscoveredExecutable('terminal', line)
      if (validated !== null) return validated
    }
    return null
  }

  async #findPyCharm(): Promise<VerifiedExecutable | null> {
    const candidates: Array<string | null> = []
    const directInstallNames = [
      'PyCharm',
      'PyCharm Professional',
      'PyCharm Community',
      'PyCharm Professional Edition',
      'PyCharm Community Edition'
    ]
    for (const installName of directInstallNames) {
      candidates.push(
        this.#candidate('localAppData', 'Programs', installName, 'bin', 'pycharm64.exe'),
        this.#candidate('localAppData', 'Programs', installName, 'bin', 'pycharm.exe'),
        this.#candidate('programFiles', 'JetBrains', installName, 'bin', 'pycharm64.exe'),
        this.#candidate('programFiles', 'JetBrains', installName, 'bin', 'pycharm.exe'),
        this.#candidate('programFilesX86', 'JetBrains', installName, 'bin', 'pycharm.exe')
      )
    }

    const versionedBases = [
      this.#candidate('localAppData', 'Programs'),
      this.#candidate('localAppData', 'Programs', 'JetBrains'),
      this.#candidate('programFiles', 'JetBrains'),
      this.#candidate('programFilesX86', 'JetBrains')
    ]
    for (const base of versionedBases) {
      if (base === null) continue
      const installNames = uniqueSortedVersions(
        (await this.#safeListDirectories(base))
          .filter((name) => PYCHARM_DIRECTORY_PATTERN.test(name))
      )
      for (const installName of installNames) {
        candidates.push(
          this.#containedCandidate(base, installName, 'bin', 'pycharm64.exe'),
          this.#containedCandidate(base, installName, 'bin', 'pycharm.exe')
        )
      }
    }

    const toolboxApps = this.#candidate('localAppData', 'JetBrains', 'Toolbox', 'apps')
    if (toolboxApps !== null) {
      const products = (await this.#safeListDirectories(toolboxApps))
        .filter((name) => TOOLBOX_PYCHARM_PATTERN.test(name))
      for (const product of products) {
        const productBase = this.#containedCandidate(toolboxApps, product)
        if (productBase === null) continue
        const channels = (await this.#safeListDirectories(productBase))
          .filter((name) => TOOLBOX_CHANNEL_PATTERN.test(name))
        for (const channel of channels) {
          const channelBase = this.#containedCandidate(productBase, channel)
          if (channelBase === null) continue
          const versions = uniqueSortedVersions(
            (await this.#safeListDirectories(channelBase))
              .filter((name) => TOOLBOX_VERSION_PATTERN.test(name))
          )
          for (const version of versions) {
            candidates.push(
              this.#containedCandidate(channelBase, version, 'bin', 'pycharm64.exe'),
              this.#containedCandidate(channelBase, version, 'bin', 'pycharm.exe')
            )
          }
        }
      }
    }
    return this.#firstVerifiedExecutable('pycharm', candidates)
  }

  async #discoverEditorFromWhere(
    openerId: 'vscode' | 'cursor',
    commandNames: readonly string[]
  ): Promise<VerifiedExecutable | null> {
    const where = this.#candidate('windows', 'System32', 'where.exe')
    if (where === null || !(await this.#safeFileExists(where))) return null
    for (const commandName of commandNames) {
      const output = await this.#runDiscovery(where, [commandName])
      for (const line of discoveryLines(output)) {
        for (const candidate of deriveEditorExecutableCandidates(openerId, line)) {
          const validated = await this.#validateDiscoveredExecutable(openerId, candidate)
          if (validated !== null) return validated
        }
      }
    }
    return null
  }

  async #discoverDirectExecutableFromWhere(
    openerId: WorkspaceOpenerId,
    commandNames: readonly string[]
  ): Promise<VerifiedExecutable | null> {
    const where = this.#candidate('windows', 'System32', 'where.exe')
    if (where === null || !(await this.#safeFileExists(where))) return null
    for (const commandName of commandNames) {
      const output = await this.#runDiscovery(where, [commandName])
      for (const line of discoveryLines(output)) {
        const validated = await this.#validateDiscoveredExecutable(openerId, line)
        if (validated !== null) return validated
      }
    }
    return null
  }

  async #validateDiscoveredExecutable(
    openerId: WorkspaceOpenerId,
    candidate: string
  ): Promise<VerifiedExecutable | null> {
    if (!isLocalAbsolutePath(candidate) || !hasExpectedExecutableLayout(openerId, candidate)) {
      return null
    }
    try {
      const before = await this.#fileSystem.lstat(candidate)
      if (!isUsableExecutableStats(before)) return null
      const canonical = win32.resolve(await this.#fileSystem.realpath(candidate))
      if (windowsPathKey(canonical) !== windowsPathKey(candidate)) return null
      const canonicalStats = await this.#fileSystem.stat(canonical)
      const beforeSignature = await this.#fileSystem.lstat(candidate)
      if (
        !isUsableExecutableStats(canonicalStats) ||
        !isUsableExecutableStats(beforeSignature) ||
        !sameFileIdentity(before, canonicalStats) ||
        !sameFileIdentity(before, beforeSignature) ||
        !sameFileSize(before, canonicalStats) ||
        !sameFileSize(before, beforeSignature)
      ) {
        return null
      }
      const digestBeforeSignature = await this.#fileSystem.hashFile(canonical)
      if (!isSha256Digest(digestBeforeSignature)) return null
      if (!(await this.#verifyPublisher(openerId, canonical))) return null

      const canonicalAfterSignature = win32.resolve(
        await this.#fileSystem.realpath(candidate)
      )
      if (windowsPathKey(canonicalAfterSignature) !== windowsPathKey(canonical)) return null
      const canonicalStatsAfterSignature = await this.#fileSystem.stat(canonicalAfterSignature)
      const afterSignature = await this.#fileSystem.lstat(candidate)
      if (
        !isUsableExecutableStats(canonicalStatsAfterSignature) ||
        !isUsableExecutableStats(afterSignature) ||
        !sameFileIdentity(before, canonicalStatsAfterSignature) ||
        !sameFileIdentity(before, afterSignature) ||
        !sameFileSize(before, canonicalStatsAfterSignature) ||
        !sameFileSize(before, afterSignature)
      ) {
        return null
      }
      const digestAfterSignature = await this.#fileSystem.hashFile(canonicalAfterSignature)
      if (
        !isSha256Digest(digestAfterSignature) ||
        digestAfterSignature !== digestBeforeSignature
      ) {
        return null
      }
      const canonicalStatsAfterHash = await this.#fileSystem.stat(canonicalAfterSignature)
      const afterHash = await this.#fileSystem.lstat(candidate)
      if (
        !isUsableExecutableStats(canonicalStatsAfterHash) ||
        !isUsableExecutableStats(afterHash) ||
        !sameFileIdentity(before, canonicalStatsAfterHash) ||
        !sameFileIdentity(before, afterHash) ||
        !sameFileSize(before, canonicalStatsAfterHash) ||
        !sameFileSize(before, afterHash)
      ) {
        return null
      }
      return Object.freeze({
        absolutePath: canonicalAfterSignature,
        device: afterHash.dev,
        inode: afterHash.ino,
        size: afterHash.size,
        sha256: digestAfterSignature
      })
    } catch {
      return null
    }
  }

  async #revalidateExecutableIdentity(
    executable: VerifiedExecutable,
    verifyContent = true
  ): Promise<string | null> {
    try {
      const before = await this.#fileSystem.lstat(executable.absolutePath)
      if (!matchesVerifiedExecutable(executable, before)) return null
      const canonical = win32.resolve(
        await this.#fileSystem.realpath(executable.absolutePath)
      )
      if (windowsPathKey(canonical) !== windowsPathKey(executable.absolutePath)) return null
      const canonicalStats = await this.#fileSystem.stat(canonical)
      const after = await this.#fileSystem.lstat(executable.absolutePath)
      if (
        !matchesVerifiedExecutable(executable, canonicalStats) ||
        !matchesVerifiedExecutable(executable, after) ||
        !sameFileIdentity(before, canonicalStats) ||
        !sameFileIdentity(before, after)
      ) {
        return null
      }
      if (!verifyContent) return canonical
      const digest = await this.#fileSystem.hashFile(canonical)
      if (!isSha256Digest(digest) || digest !== executable.sha256) return null
      const canonicalStatsAfterHash = await this.#fileSystem.stat(canonical)
      const afterHash = await this.#fileSystem.lstat(executable.absolutePath)
      if (
        !matchesVerifiedExecutable(executable, canonicalStatsAfterHash) ||
        !matchesVerifiedExecutable(executable, afterHash) ||
        !sameFileIdentity(before, canonicalStatsAfterHash) ||
        !sameFileIdentity(before, afterHash)
      ) {
        return null
      }
      return canonical
    } catch {
      return null
    }
  }

  async #verifyPublisher(openerId: WorkspaceOpenerId, executable: string): Promise<boolean> {
    if (this.#verifyPublisherOverride !== null) {
      try {
        return await this.#verifyPublisherOverride(openerId, executable)
      } catch {
        return false
      }
    }
    const powershell = this.#candidate(
      'windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
    if (powershell === null || !(await this.#safeFileExists(powershell))) return false
    const subject = await this.#runDiscovery(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      authenticodeCommand(executable)
    ], SIGNATURE_TIMEOUT_MS)
    return hasExpectedPublisher(openerId, subject)
  }

  async #runDiscovery(
    executable: string,
    args: readonly string[],
    timeoutMs = DISCOVERY_TIMEOUT_MS
  ): Promise<string | null> {
    try {
      const output = await this.#runDiscoveryCommand(
        executable,
        args,
        timeoutMs,
        this.#discoveryEnvironment
      )
      if (
        typeof output !== 'string' ||
        output.length > MAX_DISCOVERY_OUTPUT_BYTES ||
        output.includes('\0')
      ) {
        return null
      }
      return output
    } catch {
      return null
    }
  }

  async #firstVerifiedExecutable(
    openerId: WorkspaceOpenerId,
    candidates: readonly (string | null)[]
  ): Promise<VerifiedExecutable | null> {
    for (const candidate of candidates) {
      if (candidate === null) continue
      const verified = await this.#validateDiscoveredExecutable(openerId, candidate)
      if (verified !== null) return verified
    }
    return null
  }

  async #safeFileExists(candidate: string): Promise<boolean> {
    if (!this.#isInsideTrustedRoot(candidate)) return false
    try {
      return await this.#fileSystem.fileExists(candidate)
    } catch {
      // Detection deliberately treats inaccessible candidates as unavailable.
      return false
    }
  }

  async #safeListDirectories(base: string): Promise<readonly string[]> {
    if (!this.#isInsideTrustedRoot(base)) return []
    try {
      const entries = await this.#fileSystem.listDirectories(base)
      if (!Array.isArray(entries)) return []
      return entries
        .slice(0, MAX_DIRECTORY_ENTRIES)
        .filter(isSafeDirectoryName)
    } catch {
      return []
    }
  }

  #candidate(rootName: RootName, ...parts: readonly string[]): string | null {
    const root = this.#roots[rootName]
    if (root === undefined) return null
    return this.#containedCandidate(root, ...parts)
  }

  #containedCandidate(base: string, ...parts: readonly string[]): string | null {
    if (parts.some((part) => !isSafeDirectoryName(part))) return null
    const candidate = win32.resolve(base, ...parts)
    return isPathInsideWindowsRoot(base, candidate) ? candidate : null
  }

  #isInsideTrustedRoot(candidate: string): boolean {
    return Object.values(this.#roots).some(
      (root) => root !== undefined && isPathInsideWindowsRoot(root, candidate)
    )
  }

  async #verifyWorkspace(workspace: WorkspaceOpenerWorkspace): Promise<string> {
    try {
      const before = await this.#fileSystem.lstat(workspace.absolutePath)
      if (!isVerifiedWorkspaceStats(workspace, before)) {
        throw new WorkspaceOpenerError('workspace_changed')
      }
      const canonical = win32.resolve(await this.#fileSystem.realpath(workspace.absolutePath))
      if (windowsPathKey(canonical) !== windowsPathKey(workspace.absolutePath)) {
        throw new WorkspaceOpenerError('workspace_changed')
      }
      const canonicalStats = await this.#fileSystem.stat(canonical)
      const after = await this.#fileSystem.lstat(workspace.absolutePath)
      if (
        !isVerifiedWorkspaceStats(workspace, canonicalStats) ||
        !isVerifiedWorkspaceStats(workspace, after) ||
        !sameFileIdentity(before, canonicalStats) ||
        !sameFileIdentity(before, after)
      ) {
        throw new WorkspaceOpenerError('workspace_changed')
      }
      return canonical
    } catch (error) {
      if (error instanceof WorkspaceOpenerError) throw error
      throw new WorkspaceOpenerError('workspace_unavailable')
    }
  }

  async #launch(executable: string, args: readonly string[]): Promise<void> {
    await new Promise<void>((resolveLaunch, rejectLaunch) => {
      let settled = false
      const settle = (callback: () => void): void => {
        if (settled) return
        settled = true
        callback()
      }
      try {
        const child = this.#spawn(executable, args, {
          shell: false,
          detached: true,
          stdio: 'ignore',
          env: this.#launchEnvironment
        })
        child.once('error', () => {
          settle(() => rejectLaunch(new WorkspaceOpenerError('launch_failed')))
        })
        child.once('spawn', () => {
          settle(() => {
            try {
              child.unref()
              resolveLaunch()
            } catch {
              rejectLaunch(new WorkspaceOpenerError('launch_failed'))
            }
          })
        })
      } catch {
        settle(() => rejectLaunch(new WorkspaceOpenerError('launch_failed')))
      }
    })
  }
}

function environmentRoots(): WorkspaceOpenerTrustedRoots {
  return {
    localAppData: process.env.LOCALAPPDATA,
    programFiles: process.env.ProgramFiles,
    programFilesX86: process.env['ProgramFiles(x86)'],
    windows: windowsRootFromLoadedKnownDlls()
  }
}

function windowsRootFromLoadedKnownDlls(): string | undefined {
  try {
    const report: unknown = process.report.getReport()
    if (typeof report !== 'object' || report === null || !('sharedObjects' in report)) {
      return undefined
    }
    const sharedObjects = (report as { sharedObjects?: unknown }).sharedObjects
    if (!Array.isArray(sharedObjects)) return undefined
    const roots = new Map<string, Map<string, string>>()
    for (const candidate of sharedObjects) {
      if (typeof candidate !== 'string' || !isLocalAbsolutePath(candidate)) continue
      const name = win32.basename(candidate).toLowerCase()
      if (name !== 'kernel32.dll' && name !== 'ntdll.dll') continue
      const system32 = win32.dirname(candidate)
      if (win32.basename(system32).toLowerCase() !== 'system32') continue
      const root = win32.resolve(system32, '..')
      if (!isTrustedRoot(root)) continue
      const candidates = roots.get(name) ?? new Map<string, string>()
      candidates.set(windowsPathKey(root), root)
      roots.set(name, candidates)
    }
    const kernel32Roots = roots.get('kernel32.dll')
    const ntdllRoots = roots.get('ntdll.dll')
    if (
      kernel32Roots?.size !== 1 ||
      ntdllRoots?.size !== 1
    ) {
      return undefined
    }
    const kernel32Root = [...kernel32Roots.values()][0]
    const ntdllRoot = [...ntdllRoots.values()][0]
    if (
      kernel32Root === undefined ||
      ntdllRoot === undefined ||
      windowsPathKey(kernel32Root) !== windowsPathKey(ntdllRoot)
    ) {
      return undefined
    }
    return kernel32Root
  } catch {
    return undefined
  }
}

function normalizeRoots(roots: WorkspaceOpenerTrustedRoots): Readonly<WorkspaceOpenerTrustedRoots> {
  const normalized: {
    localAppData?: string
    programFiles?: string
    programFilesX86?: string
    windows?: string
  } = {}
  for (const rootName of [
    'localAppData',
    'programFiles',
    'programFilesX86',
    'windows'
  ] as const) {
    const root = roots[rootName]
    if (!isTrustedRoot(root)) continue
    normalized[rootName] = win32.resolve(root)
  }
  return Object.freeze(normalized)
}

function isTrustedRoot(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 2 &&
    value.length <= MAX_PATH_CHARACTERS &&
    !/[\r\n\0]/u.test(value) &&
    /^[A-Za-z]:[\\/](?![\\/])/u.test(value) &&
    win32.isAbsolute(value)
}

function isSafeDirectoryName(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    value !== '.' &&
    value !== '..' &&
    !/[\\/\r\n\0]/u.test(value)
}

function isPathInsideWindowsRoot(root: string, candidate: string): boolean {
  const relative = win32.relative(root, candidate)
  return relative === '' || (
    !win32.isAbsolute(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${win32.sep}`)
  )
}

function uniqueSortedVersions(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) =>
    right.localeCompare(left, 'en', { numeric: true, sensitivity: 'base' })
  )
}

function discoveryLines(output: string | null): readonly string[] {
  if (output === null) return []
  return output
    .split(/\r?\n/u)
    .slice(0, 64)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.length <= MAX_PATH_CHARACTERS)
}

function deriveEditorExecutableCandidates(
  openerId: 'vscode' | 'cursor',
  commandPath: string
): readonly string[] {
  if (!isLocalAbsolutePath(commandPath)) return []
  const expectedExecutable = openerId === 'vscode' ? 'Code.exe' : 'Cursor.exe'
  const basename = win32.basename(commandPath)
  if (basename.toLowerCase() === expectedExecutable.toLowerCase()) {
    return Object.freeze([win32.resolve(commandPath)])
  }

  const expectedCommands = openerId === 'vscode'
    ? new Set(['code', 'code.cmd', 'code.bat', 'code.exe'])
    : new Set(['cursor', 'cursor.cmd', 'cursor.bat', 'cursor.exe'])
  if (!expectedCommands.has(basename.toLowerCase())) return []
  const binDirectory = win32.dirname(commandPath)
  if (win32.basename(binDirectory).toLowerCase() !== 'bin') return []

  const candidates: string[] = []
  if (openerId === 'vscode') {
    candidates.push(win32.resolve(binDirectory, '..', expectedExecutable))
  }
  const appDirectory = win32.resolve(binDirectory, '..')
  const resourcesDirectory = win32.resolve(appDirectory, '..')
  if (
    win32.basename(appDirectory).toLowerCase() === 'app' &&
    win32.basename(resourcesDirectory).toLowerCase() === 'resources'
  ) {
    candidates.unshift(win32.resolve(resourcesDirectory, '..', expectedExecutable))
  }
  return Object.freeze([...new Set(candidates)])
}

function hasExpectedExecutableLayout(openerId: WorkspaceOpenerId, candidate: string): boolean {
  const basename = win32.basename(candidate).toLowerCase()
  const parent = win32.basename(win32.dirname(candidate)).toLowerCase()
  const grandparent = win32.basename(win32.dirname(win32.dirname(candidate))).toLowerCase()
  switch (openerId) {
    case 'vscode':
      return (
        basename === 'code.exe' || basename === 'code - insiders.exe'
      ) && (
        parent === 'microsoft vs code' ||
        parent === 'microsoft vs code insiders' ||
        parent === 'vs code' ||
        parent === 'vscode'
      )
    case 'cursor':
      return basename === 'cursor.exe' && parent === 'cursor'
    case 'visual-studio':
      return basename === 'devenv.exe' &&
        parent === 'ide' &&
        grandparent === 'common7'
    case 'github-desktop':
      return basename === 'githubdesktop.exe' && (
        parent === 'githubdesktop' ||
        parent === 'github desktop' ||
        (GITHUB_DESKTOP_VERSION_PATTERN.test(parent) && grandparent === 'githubdesktop')
      )
    case 'explorer':
      return basename === 'explorer.exe'
    case 'terminal':
      return basename === 'wt.exe' && WINDOWS_TERMINAL_PACKAGE_PATTERN.test(parent)
    case 'wsl':
      return basename === 'wsl.exe' && (parent === 'system32' || parent === 'sysnative')
    case 'pycharm':
      return (basename === 'pycharm64.exe' || basename === 'pycharm.exe') &&
        win32.basename(win32.dirname(candidate)).toLowerCase() === 'bin'
  }
}

function hasExpectedPublisher(openerId: WorkspaceOpenerId, commonName: string | null): boolean {
  if (
    commonName === null ||
    commonName.length < 1 ||
    commonName.length > 256 ||
    commonName !== commonName.trim() ||
    /[\r\n\0]/u.test(commonName)
  ) {
    return false
  }
  return EXPECTED_PUBLISHER_COMMON_NAMES[openerId].has(commonName.toLowerCase())
}

function authenticodeCommand(executable: string): string {
  const escapedPath = executable.replace(/'/gu, "''")
  const script = `$TargetPath = '${escapedPath}'; ${AUTHENTICODE_SCRIPT_BODY}`
  return powershellEncodedCommand(script)
}

function powershellEncodedCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function sanitizeLaunchEnvironment(
  source: NodeJS.ProcessEnv,
  windowsRoot: string | undefined
): Readonly<NodeJS.ProcessEnv> {
  const sanitized: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = key.toUpperCase()
    if (
      !SAFE_LAUNCH_ENVIRONMENT_KEYS.has(normalizedKey) ||
      typeof value !== 'string' ||
      value.length > MAX_ENVIRONMENT_VALUE_CHARACTERS ||
      /[\r\n\0]/u.test(value)
    ) {
      continue
    }
    sanitized[normalizedKey] = value
  }
  applyTrustedWindowsEnvironment(sanitized, windowsRoot)
  return Object.freeze(sanitized)
}

function sanitizeDiscoveryEnvironment(
  launchEnvironment: Readonly<NodeJS.ProcessEnv>,
  windowsRoot: string | undefined
): Readonly<NodeJS.ProcessEnv> {
  const sanitized: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(launchEnvironment)) {
    if (SAFE_DISCOVERY_ENVIRONMENT_KEYS.has(key) && typeof value === 'string') {
      sanitized[key] = value
    }
  }
  applyTrustedWindowsEnvironment(sanitized, windowsRoot)
  if (windowsRoot !== undefined) {
    sanitized.PSMODULEPATH = win32.join(
      windowsRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'Modules'
    )
  }
  return Object.freeze(sanitized)
}

function applyTrustedWindowsEnvironment(
  environment: NodeJS.ProcessEnv,
  windowsRoot: string | undefined
): void {
  delete environment.SYSTEMROOT
  delete environment.WINDIR
  delete environment.SYSTEMDRIVE
  delete environment.COMSPEC
  if (windowsRoot === undefined) return
  environment.SYSTEMROOT = windowsRoot
  environment.WINDIR = windowsRoot
  environment.SYSTEMDRIVE = win32.parse(windowsRoot).root.slice(0, 2)
  environment.COMSPEC = win32.join(windowsRoot, 'System32', 'cmd.exe')
}

function validateOpenRequest(request: unknown): WorkspaceOpenRequest {
  if (!isPlainRecord(request) || !hasOnlyKeys(request, ['openerId', 'workspace'])) {
    throw new WorkspaceOpenerError('invalid_request')
  }
  if (!isWorkspaceOpenerId(request.openerId)) {
    throw new WorkspaceOpenerError('invalid_request')
  }
  const workspace = request.workspace
  if (!isPlainRecord(workspace) || !hasOnlyKeys(workspace, ['absolutePath', 'device', 'inode'])) {
    throw new WorkspaceOpenerError('invalid_request')
  }
  if (
    !isLocalAbsolutePath(workspace.absolutePath) ||
    !isFileIdentityText(workspace.device) ||
    !isFileIdentityText(workspace.inode)
  ) {
    throw new WorkspaceOpenerError('invalid_request')
  }
  return {
    openerId: request.openerId,
    workspace: {
      absolutePath: workspace.absolutePath,
      device: workspace.device,
      inode: workspace.inode
    }
  }
}

function isWorkspaceOpenerId(value: unknown): value is WorkspaceOpenerId {
  return typeof value === 'string' && DEFINITION_BY_ID.has(value as WorkspaceOpenerId)
}

function isLocalAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 2 &&
    value.length <= MAX_PATH_CHARACTERS &&
    !/[\r\n\0]/u.test(value) &&
    /^[A-Za-z]:[\\/](?![\\/])/u.test(value) &&
    win32.isAbsolute(value)
}

function isFileIdentityText(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,39}$/u.test(value)
}

function isVerifiedWorkspaceStats(
  workspace: WorkspaceOpenerWorkspace,
  stats: WorkspaceOpenerStats
): boolean {
  return stats.isDirectory() &&
    !stats.isSymbolicLink() &&
    sameStoredIdentity(workspace, stats)
}

function sameStoredIdentity(
  workspace: WorkspaceOpenerWorkspace,
  stats: WorkspaceOpenerStats
): boolean {
  return workspace.device !== '0' &&
    workspace.inode !== '0' &&
    stats.dev !== 0n &&
    stats.ino !== 0n &&
    workspace.device === stats.dev.toString(10) &&
    workspace.inode === stats.ino.toString(10)
}

function sameFileIdentity(left: WorkspaceOpenerStats, right: WorkspaceOpenerStats): boolean {
  return left.dev !== 0n &&
    left.ino !== 0n &&
    right.dev !== 0n &&
    right.ino !== 0n &&
    left.dev === right.dev &&
    left.ino === right.ino
}

function sameFileSize(left: WorkspaceOpenerStats, right: WorkspaceOpenerStats): boolean {
  return left.size === right.size
}

function isUsableExecutableStats(stats: WorkspaceOpenerStats): boolean {
  return stats.isFile() &&
    !stats.isSymbolicLink() &&
    stats.dev !== 0n &&
    stats.ino !== 0n &&
    stats.size > 0n &&
    stats.size <= BigInt(MAX_EXECUTABLE_BYTES)
}

function matchesVerifiedExecutable(
  executable: VerifiedExecutable,
  stats: WorkspaceOpenerStats
): boolean {
  return isUsableExecutableStats(stats) &&
    executable.device === stats.dev &&
    executable.inode === stats.ino &&
    executable.size === stats.size
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

async function hashExecutableFile(absolutePath: string): Promise<string> {
  const handle = await fs.open(absolutePath, 'r')
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(128 * 1024)
    let position = 0
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      position += bytesRead
      if (position > MAX_EXECUTABLE_BYTES) {
        throw new Error('Executable exceeds the local verification limit.')
      }
      hash.update(buffer.subarray(0, bytesRead))
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

function windowsPathKey(value: string): string {
  return win32.resolve(value).replace(/^\\\\\?\\/u, '').toLowerCase()
}

function launchArguments(openerId: WorkspaceOpenerId, workspacePath: string): readonly string[] {
  switch (openerId) {
    case 'terminal':
      return Object.freeze(['-d', workspacePath])
    case 'wsl':
      return Object.freeze(['--cd', workspacePath])
    default:
      return Object.freeze([workspacePath])
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key))
}
