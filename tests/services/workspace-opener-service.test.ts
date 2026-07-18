import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { win32 } from 'node:path'
import test from 'node:test'

import {
  WorkspaceOpenerError,
  WorkspaceOpenerService,
  type WorkspaceOpenRequest,
  type WorkspaceOpenerChildProcess,
  type WorkspaceOpenerDiscoveryCommand,
  type WorkspaceOpenerFileSystem,
  type WorkspaceOpenerSpawn,
  type WorkspaceOpenerStats,
  type WorkspaceOpenerTrustedRoots
} from '../../src/main/services/workspace-opener-service.ts'

const ROOTS: WorkspaceOpenerTrustedRoots = Object.freeze({
  localAppData: 'C:\\Users\\Alice\\AppData\\Local',
  programFiles: 'C:\\Program Files',
  programFilesX86: 'C:\\Program Files (x86)',
  windows: 'C:\\Windows'
})
const WORKSPACE_PATH = 'C:\\Users\\Alice\\source\\private-project'
const WORKSPACE = Object.freeze({
  absolutePath: WORKSPACE_PATH,
  device: '7',
  inode: '41'
})
const VSCODE_PATH = win32.join(
  ROOTS.localAppData!,
  'Programs',
  'Microsoft VS Code',
  'Code.exe'
)

class FakeFileSystem implements WorkspaceOpenerFileSystem {
  readonly files = new Set<string>()
  readonly directories = new Map<string, readonly string[]>()
  readonly fileExistsCalls: string[] = []
  readonly listDirectoryCalls: string[] = []
  readonly lstatCalls: string[] = []
  readonly statCalls: string[] = []
  readonly realpathCalls: string[] = []
  readonly lstatResults = new Map<string, WorkspaceOpenerStats>()
  readonly statResults = new Map<string, WorkspaceOpenerStats>()
  readonly realpathResults = new Map<string, string>()
  readonly hashResults = new Map<string, string>()
  readonly hashFileCalls: string[] = []
  lstatResult: WorkspaceOpenerStats = directoryStats()
  statResult: WorkspaceOpenerStats = directoryStats()
  realpathResult = WORKSPACE_PATH
  lstatError: unknown = null
  statError: unknown = null
  realpathError: unknown = null

  addFile(absolutePath: string): void {
    this.files.add(pathKey(absolutePath))
  }

  setDirectories(absolutePath: string, names: readonly string[]): void {
    this.directories.set(pathKey(absolutePath), names)
  }

  setVerifiedExecutable(absolutePath: string, dev: number, ino: number): void {
    const stats = fileStats(dev, ino)
    this.lstatResults.set(pathKey(absolutePath), stats)
    this.statResults.set(pathKey(absolutePath), stats)
    this.realpathResults.set(pathKey(absolutePath), absolutePath)
    this.hashResults.set(pathKey(absolutePath), digestForIdentity(dev, ino))
  }

  setExecutableDigest(absolutePath: string, digest: string): void {
    this.hashResults.set(pathKey(absolutePath), digest)
  }

  async fileExists(absolutePath: string): Promise<boolean> {
    this.fileExistsCalls.push(absolutePath)
    return this.files.has(pathKey(absolutePath))
  }

  async listDirectories(absolutePath: string): Promise<readonly string[]> {
    this.listDirectoryCalls.push(absolutePath)
    return this.directories.get(pathKey(absolutePath)) ?? []
  }

  async lstat(absolutePath: string): Promise<WorkspaceOpenerStats> {
    this.lstatCalls.push(absolutePath)
    if (this.lstatError !== null) throw this.lstatError
    return this.lstatResults.get(pathKey(absolutePath)) ?? this.lstatResult
  }

  async stat(absolutePath: string): Promise<WorkspaceOpenerStats> {
    this.statCalls.push(absolutePath)
    if (this.statError !== null) throw this.statError
    return this.statResults.get(pathKey(absolutePath)) ?? this.statResult
  }

  async realpath(absolutePath: string): Promise<string> {
    this.realpathCalls.push(absolutePath)
    if (this.realpathError !== null) throw this.realpathError
    return this.realpathResults.get(pathKey(absolutePath)) ?? this.realpathResult
  }

  async hashFile(absolutePath: string): Promise<string> {
    this.hashFileCalls.push(absolutePath)
    const digest = this.hashResults.get(pathKey(absolutePath))
    if (digest === undefined) throw new Error('hash unavailable')
    return digest
  }
}

class FakeChildProcess extends EventEmitter implements WorkspaceOpenerChildProcess {
  unrefCalled = false

  override once(event: 'spawn', listener: () => void): this
  override once(event: 'error', listener: (error: unknown) => void): this
  override once(event: string, listener: (...args: unknown[]) => void): this {
    return super.once(event, listener)
  }

  unref(): void {
    this.unrefCalled = true
  }
}

interface SpawnCall {
  readonly executable: string
  readonly args: readonly string[]
  readonly options: {
    readonly shell: false
    readonly detached: true
    readonly stdio: 'ignore'
    readonly env: Readonly<NodeJS.ProcessEnv>
  }
  readonly child: FakeChildProcess
}

test('detects every allowlisted Windows opener without exposing executable paths', async () => {
  const fileSystem = installedOpenersFixture()
  const verifiedPublishers: string[] = []
  const service = new WorkspaceOpenerService({
    platform: 'win32',
    roots: ROOTS,
    fileSystem,
    verifyPublisher: async (openerId) => {
      verifiedPublishers.push(openerId)
      return true
    },
    spawn: unexpectedSpawn
  })

  const detected = await service.detect()
  assert.deepEqual(detected, [
    { id: 'vscode', label: 'VS Code', kind: 'editor' },
    { id: 'visual-studio', label: 'Visual Studio', kind: 'editor' },
    { id: 'cursor', label: 'Cursor', kind: 'editor' },
    { id: 'github-desktop', label: 'GitHub Desktop', kind: 'git' },
    { id: 'explorer', label: '文件资源管理器', kind: 'file-manager' },
    { id: 'terminal', label: 'Windows Terminal', kind: 'terminal' },
    { id: 'wsl', label: 'WSL', kind: 'terminal' },
    { id: 'pycharm', label: 'PyCharm', kind: 'editor' }
  ])
  for (const opener of detected) {
    assert.deepEqual(Object.keys(opener).sort(), ['id', 'kind', 'label'])
  }
  assert.equal(JSON.stringify(detected).includes('C:\\'), false)
  assert.deepEqual(verifiedPublishers.sort(), detected.map((opener) => opener.id).sort())

  const trustedRoots = Object.values(ROOTS).map((root) => pathKey(root!))
  for (const inspectedPath of [
    ...fileSystem.fileExistsCalls,
    ...fileSystem.listDirectoryCalls
  ]) {
    assert.equal(
      trustedRoots.some((root) => isInside(root, pathKey(inspectedPath))),
      true,
      `unexpected scan path: ${inspectedPath}`
    )
  }
  assert.equal(
    fileSystem.fileExistsCalls.some((path) => path.includes('outside-allowlist')),
    false
  )
})

test('standard install candidates require an exact publisher and reject links', async () => {
  const unsignedFileSystem = installedOpenersFixture()
  let vscodePublisherChecks = 0
  const unsignedService = new WorkspaceOpenerService({
    platform: 'win32',
    roots: ROOTS,
    fileSystem: unsignedFileSystem,
    verifyPublisher: async (openerId) => {
      if (openerId === 'vscode') {
        vscodePublisherChecks += 1
        return false
      }
      return true
    },
    spawn: unexpectedSpawn
  })
  assert.equal((await unsignedService.detect()).some((opener) => opener.id === 'vscode'), false)
  assert.equal(vscodePublisherChecks, 1)

  const linkedFileSystem = installedOpenersFixture()
  linkedFileSystem.lstatResults.set(pathKey(VSCODE_PATH), fileStats(101, 1_001, true))
  let linkedPublisherChecks = 0
  const linkedService = new WorkspaceOpenerService({
    platform: 'win32',
    roots: ROOTS,
    fileSystem: linkedFileSystem,
    verifyPublisher: async (openerId) => {
      if (openerId === 'vscode') linkedPublisherChecks += 1
      return true
    },
    spawn: unexpectedSpawn
  })
  assert.equal((await linkedService.detect()).some((opener) => opener.id === 'vscode'), false)
  assert.equal(linkedPublisherChecks, 0)
})

test('default Windows root comes from loaded KnownDLLs instead of poisoned environment', {
  skip: process.platform !== 'win32'
}, async () => {
  const report = process.report.getReport() as { sharedObjects?: readonly string[] }
  const kernel32 = report.sharedObjects?.find(
    (candidate) => win32.basename(candidate).toLowerCase() === 'kernel32.dll'
  )
  const ntdll = report.sharedObjects?.find(
    (candidate) => win32.basename(candidate).toLowerCase() === 'ntdll.dll'
  )
  assert.ok(kernel32)
  assert.ok(ntdll)
  const windowsRoot = win32.resolve(win32.dirname(kernel32), '..')
  assert.equal(pathKey(windowsRoot), pathKey(win32.resolve(win32.dirname(ntdll), '..')))

  const fileSystem = new FakeFileSystem()
  fileSystem.setVerifiedExecutable(win32.join(windowsRoot, 'explorer.exe'), 301, 3_001)
  const service = new WorkspaceOpenerService({
    platform: 'win32',
    fileSystem,
    environmentSource: {
      SystemRoot: 'D:\\PoisonedWindows',
      WINDIR: 'D:\\PoisonedWindows',
      Path: 'D:\\PoisonedWindows\\System32'
    },
    verifyPublisher: async () => true,
    spawn: unexpectedSpawn
  })
  assert.equal((await service.detect()).some((opener) => opener.id === 'explorer'), true)
  assert.equal([
    ...fileSystem.fileExistsCalls,
    ...fileSystem.listDirectoryCalls,
    ...fileSystem.lstatCalls,
    ...fileSystem.statCalls,
    ...fileSystem.realpathCalls,
    ...fileSystem.hashFileCalls
  ].some((candidate) => pathKey(candidate).startsWith('d:\\poisonedwindows')), false)
})

test('concurrent detection is coalesced and cached for the application session', async () => {
  const fileSystem = installedOpenersFixture()
  const service = new WorkspaceOpenerService({
    platform: 'win32',
    roots: ROOTS,
    fileSystem,
    verifyPublisher: async () => true,
    spawn: unexpectedSpawn
  })

  const [first, concurrent] = await Promise.all([service.detect(), service.detect()])
  assert.strictEqual(concurrent, first)
  const scanCounts = {
    files: fileSystem.fileExistsCalls.length,
    directories: fileSystem.listDirectoryCalls.length
  }
  const cached = await service.detect()
  assert.strictEqual(cached, first)
  assert.equal(fileSystem.fileExistsCalls.length, scanCounts.files)
  assert.equal(fileSystem.listDirectoryCalls.length, scanCounts.directories)
})

test('detects signed custom-drive editors only through fixed where and vswhere commands', async () => {
  const fileSystem = new FakeFileSystem()
  const where = win32.join(ROOTS.windows!, 'System32', 'where.exe')
  const vswhere = win32.join(
    ROOTS.programFilesX86!,
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe'
  )
  fileSystem.addFile(where)
  fileSystem.addFile(vswhere)

  const codeShim = 'D:\\Developer Tools\\Microsoft VS Code\\bin\\code.cmd'
  const codeExecutable = 'D:\\Developer Tools\\Microsoft VS Code\\Code.exe'
  const cursorShim = 'E:\\Editors\\Cursor\\resources\\app\\bin\\cursor.cmd'
  const cursorExecutable = 'E:\\Editors\\Cursor\\Cursor.exe'
  const visualStudioExecutable =
    'F:\\Microsoft Visual Studio\\18\\Professional\\Common7\\IDE\\devenv.exe'
  fileSystem.setVerifiedExecutable(codeExecutable, 31, 101)
  fileSystem.setVerifiedExecutable(cursorExecutable, 32, 102)
  fileSystem.setVerifiedExecutable(visualStudioExecutable, 33, 103)

  const commandCalls: Array<{
    executable: string
    args: readonly string[]
    environment: Readonly<NodeJS.ProcessEnv>
  }> = []
  const runDiscoveryCommand: WorkspaceOpenerDiscoveryCommand = async (
    executable: string,
    args: readonly string[],
    _timeoutMs: number,
    environment: Readonly<NodeJS.ProcessEnv>
  ): Promise<string | null> => {
    commandCalls.push({ executable, args: [...args], environment })
    if (pathKey(executable) === pathKey(where)) {
      if (args[0] === 'code') return `${codeShim}\r\n`
      if (args[0] === 'cursor') return `${cursorShim}\r\n`
      return null
    }
    if (pathKey(executable) === pathKey(vswhere)) return `${visualStudioExecutable}\r\n`
    return null
  }
  const verified: Array<{ id: string; executable: string }> = []
  const service = new WorkspaceOpenerService({
    platform: 'win32',
    roots: ROOTS,
    fileSystem,
    runDiscoveryCommand,
    environmentSource: {
      SystemRoot: ROOTS.windows,
      WINDIR: ROOTS.windows,
      Path: 'D:\\Developer Tools\\Microsoft VS Code\\bin',
      PSModulePath: 'C:\\Users\\Alice\\Documents\\WindowsPowerShell\\Modules',
      OPENAI_API_KEY: 'must-not-reach-discovery',
      HTTPS_PROXY: 'https://user:password@example.invalid'
    },
    verifyPublisher: async (id, executable) => {
      verified.push({ id, executable })
      return true
    },
    spawn: unexpectedSpawn
  })

  assert.deepEqual((await service.detect()).map((opener) => opener.id), [
    'vscode',
    'visual-studio',
    'cursor'
  ])
  const expectedVerified = [
    { id: 'vscode', executable: codeExecutable },
    { id: 'visual-studio', executable: visualStudioExecutable },
    { id: 'cursor', executable: cursorExecutable }
  ]
  assert.deepEqual(
    [...verified].sort((left, right) => left.id.localeCompare(right.id)),
    expectedVerified.sort((left, right) => left.id.localeCompare(right.id))
  )
  const vswhereCall = commandCalls.find((call) => pathKey(call.executable) === pathKey(vswhere))
  assert.deepEqual(vswhereCall?.args, [
    '-products',
    '*',
    '-all',
    '-find',
    '**\\Common7\\IDE\\devenv.exe',
    '-utf8',
    '-nologo',
    '-prerelease'
  ])
  assert.equal(commandCalls.every((call) =>
    pathKey(call.executable) === pathKey(where) ||
    pathKey(call.executable) === pathKey(vswhere)), true)
  for (const call of commandCalls) {
    assert.equal(call.environment.OPENAI_API_KEY, undefined)
    assert.equal(call.environment.HTTPS_PROXY, undefined)
    assert.equal(
      call.environment.PSMODULEPATH,
      win32.join(ROOTS.windows!, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
    )
    assert.equal(call.environment.PATH, 'D:\\Developer Tools\\Microsoft VS Code\\bin')
  }
})

test('custom-drive discovery fails closed on links or publishers and encodes signature paths', async () => {
  const where = win32.join(ROOTS.windows!, 'System32', 'where.exe')
  const powershell = win32.join(
    ROOTS.windows!,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const codeShim = 'D:\\Private Folder\\Microsoft VS Code\\bin\\code.cmd'
  const codeExecutable = 'D:\\Private Folder\\Microsoft VS Code\\Code.exe'

  const linkedFileSystem = new FakeFileSystem()
  linkedFileSystem.addFile(where)
  linkedFileSystem.lstatResults.set(pathKey(codeExecutable), fileStats(8, 9, true))
  let linkedPublisherChecks = 0
  const linkedService = new WorkspaceOpenerService({
    platform: 'win32',
    roots: ROOTS,
    fileSystem: linkedFileSystem,
    runDiscoveryCommand: async (_executable, args) => args[0] === 'code' ? codeShim : null,
    verifyPublisher: async () => {
      linkedPublisherChecks += 1
      return true
    },
    spawn: unexpectedSpawn
  })
  assert.equal((await linkedService.detect()).some((opener) => opener.id === 'vscode'), false)
  assert.equal(linkedPublisherChecks, 0)

  const unsignedFileSystem = new FakeFileSystem()
  unsignedFileSystem.addFile(where)
  unsignedFileSystem.setVerifiedExecutable(codeExecutable, 8, 9)
  const unsignedService = new WorkspaceOpenerService({
    platform: 'win32',
    roots: ROOTS,
    fileSystem: unsignedFileSystem,
    runDiscoveryCommand: async (_executable, args) => args[0] === 'code' ? codeShim : null,
    verifyPublisher: async () => false,
    spawn: unexpectedSpawn
  })
  assert.equal((await unsignedService.detect()).some((opener) => opener.id === 'vscode'), false)

  const swappedFileSystem = new FakeFileSystem()
  swappedFileSystem.addFile(where)
  swappedFileSystem.setVerifiedExecutable(codeExecutable, 8, 9)
  const swappedService = new WorkspaceOpenerService({
    platform: 'win32',
    roots: ROOTS,
    fileSystem: swappedFileSystem,
    runDiscoveryCommand: async (_executable, args) => args[0] === 'code' ? codeShim : null,
    verifyPublisher: async () => {
      swappedFileSystem.setVerifiedExecutable(codeExecutable, 8, 10)
      return true
    },
    spawn: unexpectedSpawn
  })
  assert.equal((await swappedService.detect()).some((opener) => opener.id === 'vscode'), false)

  const overwrittenFileSystem = new FakeFileSystem()
  overwrittenFileSystem.addFile(where)
  overwrittenFileSystem.setVerifiedExecutable(codeExecutable, 8, 9)
  const overwrittenService = new WorkspaceOpenerService({
    platform: 'win32',
    roots: ROOTS,
    fileSystem: overwrittenFileSystem,
    runDiscoveryCommand: async (_executable, args) => args[0] === 'code' ? codeShim : null,
    verifyPublisher: async () => {
      overwrittenFileSystem.setExecutableDigest(codeExecutable, 'f'.repeat(64))
      return true
    },
    spawn: unexpectedSpawn
  })
  assert.equal((await overwrittenService.detect()).some((opener) => opener.id === 'vscode'), false)

  const signedFileSystem = new FakeFileSystem()
  signedFileSystem.addFile(where)
  signedFileSystem.addFile(powershell)
  signedFileSystem.setVerifiedExecutable(codeExecutable, 8, 9)
  let signatureArgs: readonly string[] | null = null
  const signedService = new WorkspaceOpenerService({
    platform: 'win32',
    roots: ROOTS,
    fileSystem: signedFileSystem,
    runDiscoveryCommand: async (executable, args) => {
      if (pathKey(executable) === pathKey(where)) return args[0] === 'code' ? codeShim : null
      if (pathKey(executable) === pathKey(powershell)) {
        signatureArgs = [...args]
        return 'Microsoft Corporation'
      }
      return null
    },
    spawn: unexpectedSpawn
  })
  assert.equal((await signedService.detect()).some((opener) => opener.id === 'vscode'), true)
  assert.ok(signatureArgs)
  assert.equal(signatureArgs.includes(codeExecutable), false)
  const encodedIndex = signatureArgs.indexOf('-EncodedCommand')
  assert.ok(encodedIndex >= 0)
  const encoded = signatureArgs[encodedIndex + 1]
  assert.equal(typeof encoded, 'string')
  assert.equal(Buffer.from(encoded!, 'base64').toString('utf16le').includes(codeExecutable), true)

  const spoofedService = new WorkspaceOpenerService({
    platform: 'win32',
    roots: ROOTS,
    fileSystem: signedFileSystem,
    runDiscoveryCommand: async (executable, args) => {
      if (pathKey(executable) === pathKey(where)) return args[0] === 'code' ? codeShim : null
      if (pathKey(executable) === pathKey(powershell)) return 'Contoso Microsoft Corporation'
      return null
    },
    spawn: unexpectedSpawn
  })
  assert.equal((await spoofedService.detect()).some((opener) => opener.id === 'vscode'), false)
})

test('open uses cached allowlisted executables, fixed arguments, and hardened spawn options', async () => {
  const fileSystem = installedOpenersFixture()
  const spawnCalls: SpawnCall[] = []
  const safeEnvironment = {
    SystemRoot: 'D:\\PoisonedWindows',
    WINDIR: 'D:\\PoisonedWindows',
    SystemDrive: 'D:',
    Path: 'C:\\Windows\\System32',
    JAVA_HOME: 'C:\\Program Files\\Java\\jdk-25',
    OPENAI_API_KEY: 'must-not-be-inherited',
    HTTPS_PROXY: 'https://user:password@example.invalid',
    NODE_OPTIONS: '--require C:\\private\\inject.js',
    PSModulePath: 'C:\\Users\\Alice\\Documents\\WindowsPowerShell\\Modules',
    PROMPT: 'sensitive prompt'
  }
  const spawn: WorkspaceOpenerSpawn = (executable, args, options) => {
    const child = new FakeChildProcess()
    spawnCalls.push({ executable, args: [...args], options: { ...options }, child })
    queueMicrotask(() => child.emit('spawn'))
    return child
  }
  const service = new WorkspaceOpenerService({
    platform: 'win32',
    roots: ROOTS,
    fileSystem,
    verifyPublisher: async () => true,
    environmentSource: safeEnvironment,
    spawn
  })
  const detected = await service.detect()
  const scanCounts = {
    files: fileSystem.fileExistsCalls.length,
    directories: fileSystem.listDirectoryCalls.length,
    lstat: fileSystem.lstatCalls.length,
    stat: fileSystem.statCalls.length,
    realpath: fileSystem.realpathCalls.length,
    hashes: fileSystem.hashFileCalls.length
  }

  for (const opener of detected) {
    await service.open({ openerId: opener.id, workspace: WORKSPACE })
  }

  assert.equal(spawnCalls.length, 8)
  for (const call of spawnCalls) {
    assert.deepEqual(call.options, {
      shell: false,
      detached: true,
      stdio: 'ignore',
      env: {
        SYSTEMROOT: 'C:\\Windows',
        WINDIR: 'C:\\Windows',
        SYSTEMDRIVE: 'C:',
        COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
        PATH: 'C:\\Windows\\System32',
        JAVA_HOME: 'C:\\Program Files\\Java\\jdk-25'
      }
    })
    assert.equal(call.child.unrefCalled, true)
    assert.equal(Object.values(ROOTS).some((root) =>
      isInside(pathKey(root!), pathKey(call.executable))), true)
  }
  assert.deepEqual(spawnCalls.map((call) => call.args), [
    [WORKSPACE_PATH],
    [WORKSPACE_PATH],
    [WORKSPACE_PATH],
    [WORKSPACE_PATH],
    [WORKSPACE_PATH],
    ['-d', WORKSPACE_PATH],
    ['--cd', WORKSPACE_PATH],
    [WORKSPACE_PATH]
  ])
  assert.equal(fileSystem.fileExistsCalls.length, scanCounts.files)
  assert.equal(fileSystem.listDirectoryCalls.length, scanCounts.directories)
  assert.equal(fileSystem.lstatCalls.length > scanCounts.lstat, true)
  assert.equal(fileSystem.statCalls.length > scanCounts.stat, true)
  assert.equal(fileSystem.realpathCalls.length > scanCounts.realpath, true)
  assert.equal(fileSystem.hashFileCalls.length > scanCounts.hashes, true)
})

test('open rejects a cached executable that is replaced and rechecks the workspace after signing', async () => {
  const replacedExecutableFileSystem = installedOpenersFixture()
  let replacedSpawnCount = 0
  const replacedExecutableService = new WorkspaceOpenerService({
    platform: 'win32',
    roots: ROOTS,
    fileSystem: replacedExecutableFileSystem,
    verifyPublisher: async () => true,
    spawn: () => {
      replacedSpawnCount += 1
      return new FakeChildProcess()
    }
  })
  await replacedExecutableService.detect()
  replacedExecutableFileSystem.lstatResults.set(
    pathKey(VSCODE_PATH),
    fileStats(101, 1_001, true)
  )
  await assert.rejects(
    replacedExecutableService.open({ openerId: 'vscode', workspace: WORKSPACE }),
    hasOpenerCode('opener_unavailable')
  )
  assert.equal(replacedSpawnCount, 0)

  const overwrittenExecutableFileSystem = installedOpenersFixture()
  let overwriteDuringSignature = false
  let overwrittenSpawnCount = 0
  const overwrittenExecutableService = new WorkspaceOpenerService({
    platform: 'win32',
    roots: ROOTS,
    fileSystem: overwrittenExecutableFileSystem,
    verifyPublisher: async (openerId) => {
      if (overwriteDuringSignature && openerId === 'vscode') {
        overwrittenExecutableFileSystem.setExecutableDigest(VSCODE_PATH, 'e'.repeat(64))
      }
      return true
    },
    spawn: () => {
      overwrittenSpawnCount += 1
      return new FakeChildProcess()
    }
  })
  await overwrittenExecutableService.detect()
  overwriteDuringSignature = true
  await assert.rejects(
    overwrittenExecutableService.open({ openerId: 'vscode', workspace: WORKSPACE }),
    hasOpenerCode('opener_unavailable')
  )
  assert.equal(overwrittenSpawnCount, 0)

  const replacedWorkspaceFileSystem = installedOpenersFixture()
  let replaceWorkspaceDuringSignature = false
  let workspaceSpawnCount = 0
  const replacedWorkspaceService = new WorkspaceOpenerService({
    platform: 'win32',
    roots: ROOTS,
    fileSystem: replacedWorkspaceFileSystem,
    verifyPublisher: async () => {
      if (replaceWorkspaceDuringSignature) {
        replacedWorkspaceFileSystem.lstatResult = directoryStats(7, 99)
      }
      return true
    },
    spawn: () => {
      workspaceSpawnCount += 1
      return new FakeChildProcess()
    }
  })
  await replacedWorkspaceService.detect()
  replaceWorkspaceDuringSignature = true
  await assert.rejects(
    replacedWorkspaceService.open({ openerId: 'vscode', workspace: WORKSPACE }),
    hasOpenerCode('workspace_changed')
  )
  assert.equal(workspaceSpawnCount, 0)
})

test('open rejects arbitrary executables, arguments, relative paths, and use before detection', async () => {
  const fileSystem = installedOpenersFixture()
  let spawnCount = 0
  const service = new WorkspaceOpenerService({
    platform: 'win32',
    roots: ROOTS,
    fileSystem,
    verifyPublisher: async () => true,
    spawn: () => {
      spawnCount += 1
      return new FakeChildProcess()
    }
  })

  await assert.rejects(
    service.open({ openerId: 'vscode', workspace: WORKSPACE }),
    hasOpenerCode('opener_unavailable')
  )
  await service.detect()

  const invalidRequests: unknown[] = [
    { openerId: 'powershell', workspace: WORKSPACE },
    { openerId: 'vscode', workspace: WORKSPACE, executable: 'C:\\private\\tool.exe' },
    { openerId: 'vscode', workspace: WORKSPACE, args: ['--unsafe'] },
    {
      openerId: 'vscode',
      workspace: { absolutePath: 'relative\\workspace', device: '7', inode: '41' }
    },
    {
      openerId: 'vscode',
      workspace: { ...WORKSPACE, absolutePath: '\\\\server\\share' }
    }
  ]
  for (const invalid of invalidRequests) {
    await assert.rejects(
      service.open(invalid as WorkspaceOpenRequest),
      hasOpenerCode('invalid_request')
    )
  }
  assert.equal(spawnCount, 0)
})

test('workspace identity is revalidated with lstat, realpath, and stat before launch', async () => {
  const cases: readonly {
    readonly name: string
    readonly configure: (fileSystem: FakeFileSystem) => void
    readonly code: 'workspace_changed' | 'workspace_unavailable'
  }[] = [
    {
      name: 'symbolic link',
      configure: (fileSystem) => { fileSystem.lstatResult = directoryStats(7, 41, true) },
      code: 'workspace_changed'
    },
    {
      name: 'replaced inode',
      configure: (fileSystem) => { fileSystem.lstatResult = directoryStats(7, 99) },
      code: 'workspace_changed'
    },
    {
      name: 'canonical path mismatch',
      configure: (fileSystem) => {
        fileSystem.realpathResult = 'C:\\Users\\Alice\\source\\replacement'
      },
      code: 'workspace_changed'
    },
    {
      name: 'canonical target is not a directory',
      configure: (fileSystem) => { fileSystem.statResult = directoryStats(7, 41, false, false) },
      code: 'workspace_changed'
    },
    {
      name: 'filesystem failure',
      configure: (fileSystem) => {
        fileSystem.lstatError = new Error(`ENOENT: ${WORKSPACE_PATH}`)
      },
      code: 'workspace_unavailable'
    }
  ]

  for (const fixture of cases) {
    const fileSystem = installedOpenersFixture()
    let spawnCount = 0
    const service = new WorkspaceOpenerService({
      platform: 'win32',
      roots: ROOTS,
      fileSystem,
      verifyPublisher: async () => true,
      spawn: () => {
        spawnCount += 1
        return new FakeChildProcess()
      }
    })
    await service.detect()
    fixture.configure(fileSystem)
    await assert.rejects(
      service.open({ openerId: 'vscode', workspace: WORKSPACE }),
      (error: unknown) => {
        assert.ok(error instanceof WorkspaceOpenerError, fixture.name)
        assert.equal(error.code, fixture.code, fixture.name)
        assert.doesNotMatch(`${error.message}\n${error.stack}`, /private-project/i)
        return true
      }
    )
    assert.equal(spawnCount, 0, fixture.name)
  }
})

test('native spawn failures are replaced with a path-free application error', async () => {
  const fileSystem = installedOpenersFixture()
  const service = new WorkspaceOpenerService({
    platform: 'win32',
    roots: ROOTS,
    fileSystem,
    verifyPublisher: async () => true,
    spawn: () => {
      const child = new FakeChildProcess()
      queueMicrotask(() => child.emit(
        'error',
        new Error(`ENOENT: C:\\Users\\Alice\\private\\Code.exe ${WORKSPACE_PATH}`)
      ))
      return child
    }
  })
  await service.detect()

  await assert.rejects(
    service.open({ openerId: 'vscode', workspace: WORKSPACE }),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceOpenerError)
      assert.equal(error.code, 'launch_failed')
      assert.doesNotMatch(`${error.message}\n${error.stack}`, /Alice|private-project|Code\.exe/i)
      return true
    }
  )
})

test('non-Windows platforms perform no detection scan and cannot launch', async () => {
  const fileSystem = installedOpenersFixture()
  const service = new WorkspaceOpenerService({
    platform: 'linux',
    roots: ROOTS,
    fileSystem,
    spawn: unexpectedSpawn
  })

  assert.deepEqual(await service.detect(), [])
  assert.equal(fileSystem.fileExistsCalls.length, 0)
  assert.equal(fileSystem.listDirectoryCalls.length, 0)
  await assert.rejects(
    service.open({ openerId: 'vscode', workspace: WORKSPACE }),
    hasOpenerCode('unsupported_platform')
  )
})

function installedOpenersFixture(): FakeFileSystem {
  const fileSystem = new FakeFileSystem()
  const executables = [
    VSCODE_PATH,
    win32.join(
      ROOTS.programFiles!,
      'Microsoft Visual Studio',
      '2022',
      'Community',
      'Common7',
      'IDE',
      'devenv.exe'
    ),
    win32.join(ROOTS.localAppData!, 'Programs', 'cursor', 'Cursor.exe'),
    win32.join(
      ROOTS.localAppData!,
      'GitHubDesktop',
      'app-3.4.5',
      'GitHubDesktop.exe'
    ),
    win32.join(ROOTS.windows!, 'explorer.exe'),
    win32.join(
      ROOTS.programFiles!,
      'WindowsApps',
      'Microsoft.WindowsTerminal_1.22.10352.0_x64__8wekyb3d8bbwe',
      'wt.exe'
    ),
    win32.join(ROOTS.windows!, 'System32', 'wsl.exe'),
    win32.join(
      ROOTS.localAppData!,
      'Programs',
      'PyCharm 2025.2',
      'bin',
      'pycharm64.exe'
    )
  ] as const
  executables.forEach((executable, index) => {
    fileSystem.setVerifiedExecutable(executable, 101 + index, 1_001 + index)
  })

  fileSystem.setDirectories(
    win32.join(ROOTS.programFiles!, 'Microsoft Visual Studio'),
    ['2022', '..\\outside-allowlist', 'untrusted-version']
  )
  fileSystem.setDirectories(
    win32.join(ROOTS.localAppData!, 'GitHubDesktop'),
    ['app-3.4.5', '..\\outside-allowlist', 'arbitrary']
  )
  fileSystem.setDirectories(
    win32.join(ROOTS.localAppData!, 'Programs'),
    ['PyCharm 2025.2', '..\\outside-allowlist', 'Unrelated App']
  )
  fileSystem.setDirectories(
    win32.join(ROOTS.programFiles!, 'WindowsApps'),
    [
      'Microsoft.WindowsTerminal_1.22.10352.0_x64__8wekyb3d8bbwe',
      '..\\outside-allowlist',
      'Untrusted.Terminal_1.0.0.0_x64__example'
    ]
  )
  return fileSystem
}

function directoryStats(
  dev: number | bigint = 7n,
  ino: number | bigint = 41n,
  symbolicLink = false,
  directory = true
): WorkspaceOpenerStats {
  return {
    dev: BigInt(dev),
    ino: BigInt(ino),
    size: 0n,
    isFile: () => !directory,
    isDirectory: () => directory,
    isSymbolicLink: () => symbolicLink
  }
}

function fileStats(
  dev: number | bigint,
  ino: number | bigint,
  symbolicLink = false,
  size: number | bigint = 1_024n
): WorkspaceOpenerStats {
  return {
    dev: BigInt(dev),
    ino: BigInt(ino),
    size: BigInt(size),
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => symbolicLink
  }
}

function digestForIdentity(dev: number | bigint, ino: number | bigint): string {
  return `${BigInt(dev).toString(16)}${BigInt(ino).toString(16)}`.padStart(64, '0').slice(-64)
}

function pathKey(value: string): string {
  return win32.resolve(value).toLowerCase()
}

function isInside(rootKey: string, candidateKey: string): boolean {
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}\\`)
}

function hasOpenerCode(code: WorkspaceOpenerError['code']): (error: unknown) => boolean {
  return (error: unknown) => error instanceof WorkspaceOpenerError && error.code === code
}

const unexpectedSpawn: WorkspaceOpenerSpawn = () => {
  throw new Error('spawn was not expected')
}
