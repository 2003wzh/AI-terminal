import { isAbsolute, join, relative, resolve } from 'node:path'

export const PRODUCTION_USER_DATA_DIRECTORY = 'ai-terminal'

interface UserDataPathOptions {
  appDataPath: string
  tempPath: string
  smokeRun: boolean
  requestedSmokePath?: string
  processId: number
}

export function resolveUserDataPath(options: UserDataPathOptions): string {
  if (!options.smokeRun) {
    return join(options.appDataPath, PRODUCTION_USER_DATA_DIRECTORY)
  }

  const tempRoot = resolve(options.tempPath)
  const fallback = join(tempRoot, `ai-terminal-smoke-${options.processId}`)
  const requested = options.requestedSmokePath
  if (!requested || requested.includes('\0')) return fallback

  const candidate = resolve(requested)
  const relativePath = relative(tempRoot, candidate)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) return fallback
  return candidate
}
