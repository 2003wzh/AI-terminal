import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  PRODUCTION_USER_DATA_DIRECTORY,
  resolveUserDataPath
} from '../../src/main/user-data-path.ts'

test('packaged runs use a production-only user data directory', () => {
  const appDataPath = resolve('test-app-data')
  const result = resolveUserDataPath({
    appDataPath,
    tempPath: resolve('test-temp'),
    smokeRun: false,
    processId: 42
  })

  assert.equal(result, join(appDataPath, PRODUCTION_USER_DATA_DIRECTORY))
  assert.doesNotMatch(result, /preview/i)
})

test('smoke runs remain isolated beneath the supplied temp directory', () => {
  const tempPath = resolve('test-temp')
  const accepted = join(tempPath, 'accepted-smoke-run')

  assert.equal(resolveUserDataPath({
    appDataPath: resolve('test-app-data'),
    tempPath,
    smokeRun: true,
    requestedSmokePath: accepted,
    processId: 42
  }), accepted)

  const fallback = join(tempPath, 'ai-terminal-smoke-42')
  assert.equal(resolveUserDataPath({
    appDataPath: resolve('test-app-data'),
    tempPath,
    smokeRun: true,
    requestedSmokePath: resolve(tempPath, '..', 'outside'),
    processId: 42
  }), fallback)
})
