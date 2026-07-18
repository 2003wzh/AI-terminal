import { isAbsolute, join, relative, resolve } from 'node:path'

export function resolveSmokeArtifactPaths(rootDirectory) {
  const root = resolve(rootDirectory)
  const directory = resolve(root, 'test-results', 'electron-smoke')
  const local = relative(root, directory)
  if (!local || local.startsWith('..') || isAbsolute(local)) {
    throw new Error('Electron smoke artifact directory must stay inside the project.')
  }

  return Object.freeze({
    directory,
    auth: join(directory, 'login-1440.png'),
    workspace: join(directory, 'workspace-1440.png'),
    openers: join(directory, 'openers-1440.png'),
    userCenter: join(directory, 'user-center-1440.png'),
    settings: join(directory, 'settings-1440.png'),
    configuration: join(directory, 'settings-configuration-1440.png')
  })
}
