import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ConsentStore,
  ConsentValidationError,
  normalizeEndpoint
} from '../../src/main/security/consent-store.ts'

const workspaceA = '3fca4ae7-d4cf-4c5b-bac3-56cf86cf3402'
const workspaceB = '93a2fda7-1860-4895-ae70-f5c023626311'
const digestA = 'a'.repeat(64)
const digestB = 'b'.repeat(64)

test('endpoint confirmation binds canonical equivalent URLs but not distinct endpoints', () => {
  const store = new ConsentStore()
  const grant = store.confirmEndpoint('HTTPS://EXAMPLE.COM:443/v1/./models?region=cn')

  assert.equal(grant.endpoint, 'https://example.com/v1/models?region=cn')
  assert.match(grant.consentHandle, /^epc_[A-Za-z0-9_-]{43}$/)
  assert.ok(grant.consentHandle.length <= 64)
  assert.equal(
    store.authorizeEndpoint({
      consentHandle: grant.consentHandle,
      endpoint: 'https://example.com/v1/models?region=cn'
    }),
    grant.endpoint
  )
  assert.equal(
    store.authorizeEndpoint({
      consentHandle: grant.consentHandle,
      endpoint: 'https://example.com/v1/models?region=us'
    }),
    null
  )
  assert.equal(
    store.authorizeEndpoint({
      consentHandle: grant.consentHandle,
      endpoint: 'https://example.com/v2/models?region=cn'
    }),
    null
  )
  assert.equal(
    store.authorizeEndpoint({
      consentHandle: grant.consentHandle,
      endpoint: grant.endpoint,
      unexpected: true
    }),
    null
  )
})

test('HTTP is limited to loopback and dangerous URL forms are rejected safely', () => {
  assert.equal(normalizeEndpoint('http://127.0.0.2:8080/v1'), 'http://127.0.0.2:8080/v1')
  assert.equal(normalizeEndpoint('http://localhost:8080/v1'), 'http://localhost:8080/v1')
  assert.equal(normalizeEndpoint('http://[::1]:8080/v1'), 'http://[::1]:8080/v1')

  const dangerous = [
    'http://example.com/v1',
    'http://localhost.example.com/v1',
    'ftp://example.com/v1',
    'javascript:alert(1)',
    'https://user:password@example.com/v1',
    'https://example.com/v1#account',
    'https://example.com/v1#',
    'https://example.com/v1?access_token=value',
    'https://example.com/v1?%74oken=value',
    'https://example.com/v1?api-key=value',
    'https://example.com/v1?key=value',
    'https://example.com/v1?auth=value',
    'https://example.com/v1?oauthCode=value',
    'https://example.com/v1?sig=value',
    ' https://example.com/v1',
    'https:\\example.com\\v1'
  ]

  for (const endpoint of dangerous) {
    assert.throws(
      () => normalizeEndpoint(endpoint),
      (error: unknown) => {
        assert.ok(error instanceof ConsentValidationError)
        assert.equal(error.code, 'invalid_endpoint')
        assert.doesNotMatch(error.message, /example\.com|password|value|account/i)
        assert.equal(error.stack, `ConsentValidationError: ${error.message}`)
        return true
      }
    )
  }
})

test('endpoint consent exists only in the issuing application-session store', () => {
  const firstSession = new ConsentStore()
  const grant = firstSession.confirmEndpoint('https://example.com/v1')
  const restartedSession = new ConsentStore()

  assert.equal(
    restartedSession.authorizeEndpoint({
      consentHandle: grant.consentHandle,
      endpoint: grant.endpoint
    }),
    null
  )
  assert.equal(firstSession.revokeEndpointConsent(grant.consentHandle), true)
  assert.equal(
    firstSession.authorizeEndpoint({
      consentHandle: grant.consentHandle,
      endpoint: grant.endpoint
    }),
    null
  )
})

test('local tool approval is single-use and exactly bound', () => {
  let now = 10_000
  const store = new ConsentStore({ now: () => now, localApprovalTtlMs: 5_000 })
  const grant = store.issueLocalToolApproval({
    workspaceToken: workspaceA,
    operation: 'write',
    requestDigest: digestA
  })

  assert.equal(grant.expiresAt, 15_000)
  assert.match(grant.approvalHandle, /^ltc_[A-Za-z0-9_-]{43}$/)
  assert.equal(
    store.consumeLocalToolApproval({
      approvalHandle: grant.approvalHandle,
      workspaceToken: workspaceA,
      operation: 'write',
      requestDigest: digestA
    }),
    true
  )
  assert.equal(
    store.consumeLocalToolApproval({
      approvalHandle: grant.approvalHandle,
      workspaceToken: workspaceA,
      operation: 'write',
      requestDigest: digestA
    }),
    false
  )

  now += 1
})

test('wrong bindings consume local approvals and expired approvals fail closed', () => {
  let now = 20_000
  const store = new ConsentStore({ now: () => now, localApprovalTtlMs: 1_000 })

  for (const wrongBinding of [
    { workspaceToken: workspaceB, operation: 'read', requestDigest: digestA },
    { workspaceToken: workspaceA, operation: 'write', requestDigest: digestA },
    { workspaceToken: workspaceA, operation: 'read', requestDigest: digestB }
  ] as const) {
    const grant = store.issueLocalToolApproval({
      workspaceToken: workspaceA,
      operation: 'read',
      requestDigest: digestA
    })
    assert.equal(
      store.consumeLocalToolApproval({ approvalHandle: grant.approvalHandle, ...wrongBinding }),
      false
    )
    assert.equal(
      store.consumeLocalToolApproval({
        approvalHandle: grant.approvalHandle,
        workspaceToken: workspaceA,
        operation: 'read',
        requestDigest: digestA
      }),
      false
    )
  }

  const expired = store.issueLocalToolApproval({
    workspaceToken: workspaceA,
    operation: 'execute',
    requestDigest: digestA
  })
  now = expired.expiresAt
  assert.equal(
    store.consumeLocalToolApproval({
      approvalHandle: expired.approvalHandle,
      workspaceToken: workspaceA,
      operation: 'execute',
      requestDigest: digestA
    }),
    false
  )
})

test('invalid approval input is rejected without reflecting sensitive values', () => {
  const store = new ConsentStore()
  assert.throws(
    () => store.issueLocalToolApproval({
      workspaceToken: 'D:\\private\\workspace',
      operation: 'execute',
      requestDigest: digestA
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConsentValidationError)
      assert.equal(error.code, 'invalid_binding')
      assert.doesNotMatch(error.message, /private|workspace|D:\\/i)
      return true
    }
  )
  assert.equal(
    store.consumeLocalToolApproval({
      approvalHandle: 'ltc_invalid',
      workspaceToken: workspaceA,
      operation: 'execute',
      requestDigest: digestA
    }),
    false
  )
})
