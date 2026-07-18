import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const require = createRequire(import.meta.url)
const legacyPublicDefaults = require('../../src/onekey/shared.js') as {
  DEFAULT_CODEX_MODEL?: unknown
}
const legacyDefaultCodexModel =
  typeof legacyPublicDefaults.DEFAULT_CODEX_MODEL === 'string'
    ? legacyPublicDefaults.DEFAULT_CODEX_MODEL
    : 'gpt-5.5'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __LEGACY_DEFAULT_CODEX_MODEL__: JSON.stringify(legacyDefaultCodexModel)
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          splash: resolve(__dirname, 'src/renderer/splash.html')
        }
      }
    }
  }
})
