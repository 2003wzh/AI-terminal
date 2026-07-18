import assert from 'node:assert/strict'
import test from 'node:test'

import { ConsentStore } from '../../src/main/security/consent-store.ts'
import {
  EndpointConsentCoordinator,
  EndpointConsentCoordinatorError
} from '../../src/main/services/endpoint-consent-coordinator.ts'

test('endpoint coordinator prompts once per exact endpoint and application session', async () => {
  let prompts = 0
  const coordinator = new EndpointConsentCoordinator(new ConsentStore(), async (endpoint) => {
    prompts += 1
    assert.equal(endpoint, 'https://example.test/v1')
    return true
  })

  const [first, concurrent, later] = await Promise.all([
    coordinator.ensure('https://example.test/v1'),
    coordinator.ensure('https://example.test/v1'),
    coordinator.ensure('https://example.test/v1')
  ])
  assert.equal(prompts, 1)
  assert.equal(first.consentHandle, concurrent.consentHandle)
  assert.equal(first.consentHandle, later.consentHandle)

  const reused = await coordinator.ensure('https://example.test/v1')
  assert.equal(prompts, 1)
  assert.equal(reused.consentHandle, first.consentHandle)
})

test('changed endpoints require a new confirmation and clear permanently disposes the coordinator', async () => {
  const endpoints: string[] = []
  const coordinator = new EndpointConsentCoordinator(new ConsentStore(), async (endpoint) => {
    endpoints.push(endpoint)
    return true
  })

  await coordinator.ensure('https://example.test/v1')
  await coordinator.ensure('https://example.test/v2')
  coordinator.clear()
  coordinator.clear()
  await assert.rejects(
    coordinator.ensure('https://example.test/v1'),
    hasCoordinatorErrorCode('disposed')
  )

  assert.deepEqual(endpoints, [
    'https://example.test/v1',
    'https://example.test/v2'
  ])
})

test('clear invalidates a pending approval before it can create a grant', async () => {
  const store = new TrackingConsentStore()
  let resolvePrompt!: (approved: boolean) => void
  const promptResult = new Promise<boolean>((resolve) => {
    resolvePrompt = resolve
  })
  const coordinator = new EndpointConsentCoordinator(store, async () => promptResult)

  const pending = coordinator.ensure('https://pending.example.test/v1')
  coordinator.clear()
  resolvePrompt(true)

  await assert.rejects(pending, hasCoordinatorErrorCode('disposed'))
  assert.equal(store.confirmations, 0)
  assert.equal(store.clears, 1)
  await assert.rejects(
    coordinator.ensure('https://pending.example.test/v1'),
    hasCoordinatorErrorCode('disposed')
  )
})

test('two coordinators sharing a store can be cleared repeatedly without rebuilding consent', async () => {
  const store = new TrackingConsentStore()
  const modelCoordinator = new EndpointConsentCoordinator(store, async () => true)
  const chatCoordinator = new EndpointConsentCoordinator(store, async () => true)

  await modelCoordinator.ensure('https://shared.example.test/v1')
  await chatCoordinator.ensure('https://shared.example.test/v1')
  assert.equal(store.confirmations, 2)

  modelCoordinator.clear()
  modelCoordinator.clear()
  chatCoordinator.clear()
  chatCoordinator.clear()

  assert.equal(store.clears, 2)
  await assert.rejects(
    modelCoordinator.ensure('https://shared.example.test/v1'),
    hasCoordinatorErrorCode('disposed')
  )
  await assert.rejects(
    chatCoordinator.ensure('https://shared.example.test/v1'),
    hasCoordinatorErrorCode('disposed')
  )
  assert.equal(store.confirmations, 2)
})

test('denial is fixed, safe, and can be requested again', async () => {
  let prompts = 0
  const coordinator = new EndpointConsentCoordinator(new ConsentStore(), async () => {
    prompts += 1
    return false
  })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      coordinator.ensure('https://private-endpoint.example/v1'),
      (error: unknown) => {
        assert.ok(error instanceof EndpointConsentCoordinatorError)
        assert.equal(error.code, 'denied')
        assert.doesNotMatch(`${error.message}\n${error.stack ?? ''}`, /private-endpoint|D:\\/)
        return true
      }
    )
  }
  assert.equal(prompts, 2)
})

class TrackingConsentStore extends ConsentStore {
  confirmations = 0
  clears = 0

  override confirmEndpoint(rawEndpoint: unknown) {
    this.confirmations += 1
    return super.confirmEndpoint(rawEndpoint)
  }

  override clear(): void {
    this.clears += 1
    super.clear()
  }
}

function hasCoordinatorErrorCode(
  code: EndpointConsentCoordinatorError['code']
): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof EndpointConsentCoordinatorError)
    assert.equal(error.code, code)
    assert.equal(error.stack, `${error.name}: ${error.message}`)
    return true
  }
}
