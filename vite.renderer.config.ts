import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: resolve(rootDir, 'src/renderer'),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  }
})
