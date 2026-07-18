import type { ApiResult, SafeError } from '../../shared/contracts'

const MAX_SAFE_MESSAGE_LENGTH = 600
const REDACTED = '<redacted>'
const LOCAL_PATH = '<local-path>'
const REDACTED_OBJECT = '<redacted-object>'

const SENSITIVE_FIELD_NAME = [
  'api[_-]?key',
  'x[_-]?api[_-]?key',
  'access[_-]?token',
  'refresh[_-]?token',
  'id[_-]?token',
  'auth(?:entication)?[_-]?token',
  'session[_-]?(?:token|key|secret)',
  'token',
  'authorization',
  'proxy[_-]?authorization',
  'cookie',
  'set[_-]?cookie',
  'password',
  'passwd',
  'passphrase',
  'client[_-]?secret',
  'secret(?:[_-]?key)?',
  'private[_-]?key',
  'credential(?:s)?',
  'signature',
  '(?:absolute|workspace|file)[_-]?path',
  'path',
  'file[_-]?name'
].join('|')

const SENSITIVE_QUERY_NAME = [
  SENSITIVE_FIELD_NAME,
  'auth',
  'key',
  'sig',
  'code'
].join('|')

const sensitiveAssignmentPattern = new RegExp(
  `((?:"|')?\\b(?:${SENSITIVE_FIELD_NAME})\\b(?:"|')?\\s*[:=]\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;&#}\\]]+)`,
  'gi'
)
const sensitiveQueryPattern = new RegExp(
  `([?&](?:${SENSITIVE_QUERY_NAME})=)[^&#\\s"'<>]+`,
  'gi'
)
const credentialLiteralAssignmentPattern =
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:entication)?[_-]?token|session[_-]?(?:token|key|secret)|authorization|cookie|password|passwd|passphrase|client[_-]?secret|secret(?:[_-]?key)?|private[_-]?key|credentials?)\b\s*[:=]\s*(?:"([^"\r\n]{1,16384})"|'([^'\r\n]{1,16384})')/giu
const knownCredentialPattern =
  /\b(?:(?:sk|pk|sess|token)-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/giu

function redactAssignedValue(_match: string, prefix: string, value: string): string {
  const quote = value.startsWith('"') && value.endsWith('"')
    ? '"'
    : value.startsWith("'") && value.endsWith("'")
      ? "'"
      : ''
  return `${prefix}${quote}${REDACTED}${quote}`
}

function safeTextValue(input: unknown): string {
  if (typeof input === 'string') return input
  if (input instanceof Error) return input.message
  if (input === null || input === undefined) return ''
  if (['number', 'bigint', 'boolean', 'symbol'].includes(typeof input)) return String(input)
  return REDACTED_OBJECT
}

export function redactSensitiveContent(input: unknown, explicitSecrets: readonly string[] = []): string {
  // Never invoke an object's toString(): a request wrapper could serialize its
  // entire body there. Errors contribute only their message, never their stack.
  let text = safeTextValue(input)

  for (const secret of explicitSecrets) {
    if (secret && secret.length >= 4) text = text.replaceAll(secret, REDACTED)
  }

  text = text
    .replace(/(:\/\/)[^/\s:@]+:[^@\s/]+@/g, `$1${REDACTED}@`)
    .replace(/\b((?:proxy-)?authorization|x-api-key)\s*:\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:Bearer|Basic)\s+[^\s,;"']+|[^\s,;"']+)/gi, '$1: <redacted>')
    .replace(/\b(cookie|set-cookie)\s*:\s*[^\r\n]+/gi, '$1: <redacted>')
    .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, `$1 ${REDACTED}`)
    .replace(sensitiveQueryPattern, `$1${REDACTED}`)
    .replace(sensitiveAssignmentPattern, redactAssignedValue)
    .replace(/\b(?:sk|pk|sess|token)-[A-Za-z0-9_-]{8,}\b/gi, REDACTED)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\b[A-Za-z]:[\\/][^\r\n"'<>|,;}\]]*/g, LOCAL_PATH)
    .replace(/\\\\[^\r\n"'<>|,;}\]]+/g, LOCAL_PATH)
    .replace(/(^|[^A-Za-z0-9_\\])\\(?!\\)[^\r\n"'<>|,;}\]]*/g, `$1${LOCAL_PATH}`)
    .replace(/(^|[\s("'=:\[{])\/(?:Users|home|tmp|var|private|opt|mnt|srv|workspace|workspaces|root|data)(?:\/[^\r\n"',;)}\]<>]*)?/g, `$1${LOCAL_PATH}`)

  return text
}

export function redactSensitiveText(input: unknown, explicitSecrets: readonly string[] = []): string {
  let text = redactSensitiveContent(input, explicitSecrets)
  if (text.length > MAX_SAFE_MESSAGE_LENGTH) text = `${text.slice(0, MAX_SAFE_MESSAGE_LENGTH)}...`
  return text
}

export function containsSensitiveCredential(
  input: unknown,
  explicitSecrets: readonly string[] = []
): boolean {
  if (typeof input !== 'string') return false
  for (const secret of explicitSecrets) {
    if (secret.length >= 4 && input.includes(secret)) return true
  }
  if (/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]{8,}/iu.test(input)) return true
  knownCredentialPattern.lastIndex = 0
  if (knownCredentialPattern.test(input)) return true

  credentialLiteralAssignmentPattern.lastIndex = 0
  for (const match of input.matchAll(credentialLiteralAssignmentPattern)) {
    const literal = (match[1] ?? match[2] ?? '').trim().toLowerCase()
    if (!literal) continue
    if (
      /^(?:your[_ -]?|example|placeholder|change[_ -]?me|replace[_ -]?me|dummy|test|none|null|undefined|<)/u.test(literal)
    ) {
      continue
    }
    return true
  }
  return false
}

export function failure(
  code: SafeError['code'],
  message: string,
  retryable = false
): ApiResult<never> {
  return {
    ok: false,
    error: {
      code,
      message: redactSensitiveText(message),
      retryable
    }
  }
}

export function internalFailure(): ApiResult<never> {
  return failure('runtime_error', '操作失败。敏感诊断信息已隐藏，请重试。', true)
}
