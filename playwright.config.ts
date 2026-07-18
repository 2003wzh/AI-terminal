import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from '@playwright/test'

const rootDir = fileURLToPath(new URL('.', import.meta.url))
const browserChannel = process.env.PLAYWRIGHT_BROWSER_CHANNEL?.trim() ||
  (process.platform === 'win32' ? 'msedge' : undefined)

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
    ...(browserChannel ? { channel: browserChannel } : {})
  },
  webServer: {
    command: 'npx vite --config vite.renderer.config.ts --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 30_000
  }
})
