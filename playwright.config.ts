import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from '@playwright/test'

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const rootDir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  testDir: resolve(rootDir, 'tests/e2e'),
  fullyParallel: false,
  forbidOnly: true,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    colorScheme: 'light',
    locale: 'zh-CN',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    ...(existsSync(edgePath) ? { launchOptions: { executablePath: edgePath } } : {})
  },
  webServer: {
    command: 'npx vite --config vite.renderer.config.ts --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 30_000
  }
})
