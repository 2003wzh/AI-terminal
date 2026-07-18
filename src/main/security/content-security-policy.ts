import type { Session } from 'electron'

const lockedSessions = new WeakSet<Session>()

export const RENDERER_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'none'"
].join('; ')

export function lockDownSession(targetSession: Session): void {
  if (lockedSessions.has(targetSession)) return
  lockedSessions.add(targetSession)

  targetSession.setPermissionCheckHandler(() => false)
  targetSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  targetSession.setDevicePermissionHandler(() => false)

  targetSession.on('will-download', (event) => event.preventDefault())

  targetSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...(details.responseHeaders ?? {}) }
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === 'content-security-policy') delete headers[name]
    }
    headers['Content-Security-Policy'] = [RENDERER_CSP]
    callback({ responseHeaders: headers })
  })
}
