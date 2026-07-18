import type { RendererApi } from './contracts'

declare global {
  interface Window {
    onekey: RendererApi
  }
}

export {}
