import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolveSmokeArtifactPaths } from '../electron/smoke-paths.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.mjs', '.ts', '.tsx'])
const MODULE_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/gu,
  /\bimport\s*['"]([^'"]+)['"]/gu,
  /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/gu
]

test('project module references never escape the standalone repository', async () => {
  const files = [
    resolve(ROOT, 'electron.vite.config.ts'),
    resolve(ROOT, 'playwright.config.ts'),
    resolve(ROOT, 'vite.renderer.config.ts'),
    ...await collectSourceFiles(resolve(ROOT, 'src')),
    ...await collectSourceFiles(resolve(ROOT, 'tests'))
  ]

  for (const filePath of files) {
    const source = await readFile(filePath, 'utf8')
    for (const pattern of MODULE_PATTERNS) {
      pattern.lastIndex = 0
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1]
        if (!specifier?.startsWith('.')) continue
        assertInsideRoot(resolve(dirname(filePath), specifier), filePath, specifier)
      }
    }
  }
})

test('Electron smoke artifacts remain under the ignored local test-results directory', () => {
  const artifacts = resolveSmokeArtifactPaths(ROOT)
  for (const artifactPath of Object.values(artifacts)) {
    assertInsideRoot(artifactPath, 'tests/electron/smoke-paths.mjs', artifactPath)
  }
  assert.equal(relative(ROOT, artifacts.directory).replaceAll('\\', '/'), 'test-results/electron-smoke')
})

async function collectSourceFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(child))
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      files.push(child)
    }
  }
  return files
}

function assertInsideRoot(candidate: string, source: string, specifier: string): void {
  const local = relative(ROOT, candidate)
  assert.equal(
    local.startsWith('..') || isAbsolute(local),
    false,
    `${relative(ROOT, source)} references a path outside the project: ${specifier}`
  )
}
