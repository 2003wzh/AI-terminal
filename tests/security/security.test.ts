import assert from 'node:assert/strict'
import test from 'node:test'

import {
  containsSensitiveCredential,
  failure,
  redactSensitiveText
} from '../../src/main/security/redaction.ts'
import {
  validateDevelopmentRendererUrl,
  validateExternalUrl
} from '../../src/main/security/web-contents.ts'

test('development renderer accepts only credential-free HTTP loopback URLs', () => {
  assert.equal(validateDevelopmentRendererUrl('http://127.0.0.1:5173/'), 'http://127.0.0.1:5173/')
  assert.throws(() => validateDevelopmentRendererUrl('https://example.com/'))
  assert.throws(() => validateDevelopmentRendererUrl('http://user:pass@localhost:5173/'))
  assert.throws(() => validateDevelopmentRendererUrl('http://localhost:5173/?token=secret'))
})

test('external links reject insecure schemes and credential-bearing URLs', () => {
  assert.equal(validateExternalUrl('https://example.com/docs'), 'https://example.com/docs')
  assert.equal(validateExternalUrl('http://example.com/docs'), null)
  assert.equal(validateExternalUrl('https://user:pass@example.com/docs'), null)
  assert.equal(validateExternalUrl('https://example.com/docs?access_token=secret'), null)
  assert.equal(validateExternalUrl('javascript:alert(1)'), null)
})

test('redaction removes credentials and absolute Windows paths', () => {
  const redacted = redactSensitiveText(
    'Authorization: Bearer abc.def.ghi api_key=sk-example123 D:\\private\\workspace\\secret.txt',
    ['example123']
  )
  assert.doesNotMatch(redacted, /abc\.def\.ghi/)
  assert.doesNotMatch(redacted, /example123/)
  assert.doesNotMatch(redacted, /D:\\private/)
  assert.match(redacted, /<redacted>/)
  assert.match(redacted, /<local-path>/)
})

test('redaction covers authorization headers and common standalone credential shapes', () => {
  const secrets = [
    'bearer-secret-value',
    'dXNlcjpwYXNzd29yZA==',
    'sk-proj-exampleCredential123',
    'ghp_1234567890abcdefghijklmnop',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456'
  ]
  const redacted = redactSensitiveText([
    `Authorization: Bearer ${secrets[0]}`,
    `Proxy-Authorization: Basic ${secrets[1]}`,
    secrets[2],
    secrets[3],
    secrets[4],
    'https://alice:password123@example.test/v1'
  ].join('\n'))

  for (const secret of secrets) assert.doesNotMatch(redacted, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(redacted, /alice|password123/)
  assert.match(redacted, /Authorization: <redacted>/)
  assert.match(redacted, /https:\/\/<redacted>@example\.test/)
})

test('redaction masks URL query secrets and quoted JSON credential fields', () => {
  const queryRedacted = redactSensitiveText(
    'https://api.example.test/v1?api_key=querySecret123&refreshToken=refreshSecret456&client_secret=clientSecret789&code=oauthCode789&model=safe-model'
  )
  for (const secret of ['querySecret123', 'refreshSecret456', 'clientSecret789', 'oauthCode789']) {
    assert.doesNotMatch(queryRedacted, new RegExp(secret))
  }
  assert.match(queryRedacted, /model=safe-model/)

  const jsonRedacted = redactSensitiveText(JSON.stringify({
    apiKey: 'sk-jsonExample123',
    password: 'correct horse battery staple',
    client_secret: 'jsonClientSecret123',
    authorization: 'Bearer jsonBearerSecret123',
    fileName: 'private-plan.txt',
    safe: 'kept'
  }))
  const parsed = JSON.parse(jsonRedacted) as Record<string, unknown>
  assert.equal(parsed.apiKey, '<redacted>')
  assert.equal(parsed.password, '<redacted>')
  assert.equal(parsed.client_secret, '<redacted>')
  assert.equal(parsed.authorization, '<redacted>')
  assert.equal(parsed.fileName, '<redacted>')
  assert.equal(parsed.safe, 'kept')
})

test('redaction removes Windows, UNC and common POSIX absolute local paths', () => {
  const redacted = redactSensitiveText([
    'C:/Users/Alice/private plan/notes.txt',
    '\\\\fileserver\\private-share\\token.txt',
    '`\\Windows\\System32\\config\\SAM`',
    '/home/alice/workspace/secret.env',
    '/Users/alice/Library/Application Support/client.json',
    '/opt/private-service/config.json'
  ].join('\n'))

  for (const privatePart of ['Users/Alice', 'fileserver', 'Windows\\System32', '/home/alice', '/Users/alice', '/opt/private-service']) {
    assert.doesNotMatch(redacted, new RegExp(privatePart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.equal(redacted.match(/<local-path>/g)?.length, 6)
})

test('sensitive error and tool-output text is redacted without serializing request objects', () => {
  const toolOutput = redactSensitiveText(
    'tool failed at D:\\private\\repo\\script.ps1\n{"access_token":"toolAccessSecret123","path":"D:\\\\private\\\\repo\\\\input.txt"}'
  )
  assert.doesNotMatch(toolOutput, /toolAccessSecret123|D:\\private|repo|input\.txt/)
  assert.match(toolOutput, /<redacted>|<local-path>/)

  const result = failure(
    'runtime_error',
    'request failed: password=errorPassword123 at /home/alice/private/error.log',
    true
  )
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.doesNotMatch(result.error.message, /errorPassword123|\/home\/alice|error\.log/)
    assert.equal(result.error.retryable, true)
  }

  let toStringCalled = false
  const requestBody = {
    apiKey: 'objectSecret123',
    messages: ['private conversation'],
    toString() {
      toStringCalled = true
      return JSON.stringify(this)
    }
  }
  const objectText = redactSensitiveText(requestBody)
  assert.equal(toStringCalled, false)
  assert.doesNotMatch(objectText, /objectSecret123|private conversation/)
  assert.equal(objectText, '<redacted-object>')

  const errorText = redactSensitiveText(new Error('Bearer errorBearerSecret123 at C:\\Users\\Alice\\private.txt'))
  assert.doesNotMatch(errorText, /errorBearerSecret123|Users|Alice|private\.txt/)
})

test('credential detection blocks real literals while allowing placeholders and environment references', () => {
  assert.equal(containsSensitiveCredential('const apiKey = "sk-liveSecret123456"'), true)
  assert.equal(containsSensitiveCredential('Authorization: Bearer abcdefghijklmnop'), true)
  assert.equal(containsSensitiveCredential('password = "correct horse battery staple"'), true)
  assert.equal(containsSensitiveCredential('const value = "active-key"', ['active-key']), true)
  assert.equal(containsSensitiveCredential('const apiKey = "YOUR_API_KEY"'), false)
  assert.equal(containsSensitiveCredential('const token = process.env.ACCESS_TOKEN'), false)
  assert.equal(containsSensitiveCredential('const path = "src/main.ts"'), false)
})
