import type { WebContents } from 'electron'

export function lockDownWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))

  contents.on('will-navigate', (event) => event.preventDefault())
  contents.on('will-redirect', (event) => event.preventDefault())
  contents.on('will-attach-webview', (event) => event.preventDefault())
}

export function validateDevelopmentRendererUrl(rawUrl: string): string {
  const url = new URL(rawUrl)
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]'])
  if (url.protocol !== 'http:' || !loopbackHosts.has(url.hostname)) {
    throw new Error('The development renderer must use an HTTP loopback URL.')
  }
  if (url.username || url.password) {
    throw new Error('Credentials are not allowed in the development renderer URL.')
  }
  if (url.search || url.hash) {
    throw new Error('Query strings and fragments are not allowed in the development renderer URL.')
  }
  return url.toString()
}

export function validateExternalUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string' || rawUrl.length < 1 || rawUrl.length > 2048) return null
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    for (const key of url.searchParams.keys()) {
      if (/(?:api.?key|auth|credential|password|secret|token)/i.test(key)) return null
    }
    return url.toString()
  } catch {
    return null
  }
}
