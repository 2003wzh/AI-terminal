import assert from 'node:assert/strict'
import test from 'node:test'

import {
  modelCatalogFromIds,
  ModelCatalogError,
  RemoteModelCatalogService,
  normalizeModelEndpoint
} from '../../src/main/services/model-catalog.ts'
import {
  isModelCapabilityExplicitlySupported,
  isModelCapabilityExplicitlyUnsupported,
  isModelReasoningExplicitlyUnsupported,
  isValidModelId
} from '../../src/shared/contracts.ts'

test('model endpoint accepts HTTPS and loopback HTTP but rejects credential-bearing URLs', () => {
  assert.equal(normalizeModelEndpoint('https://example.test/v1/'), 'https://example.test/v1')
  assert.equal(normalizeModelEndpoint('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1')
  assert.throws(() => normalizeModelEndpoint('http://example.test/v1'), ModelCatalogError)
  assert.throws(() => normalizeModelEndpoint('https://user:secret@example.test/v1'), ModelCatalogError)
  assert.throws(() => normalizeModelEndpoint('https://example.test/v1?token=secret'), ModelCatalogError)
  assert.throws(() => normalizeModelEndpoint('https://example.test/v1#secret'), ModelCatalogError)
})

test('model ids use the same bounded grammar as turn start requests', () => {
  assert.equal(isValidModelId('provider/model:variant_1.2-3'), true)
  assert.equal(isValidModelId('-leading-separator'), false)
  assert.equal(isValidModelId('contains space'), false)
  assert.equal(isValidModelId('\u6a21\u578b'), false)
  assert.equal(isValidModelId(`m${'x'.repeat(256)}`), false)
})

test('authenticated account model ids become a real selectable catalog without an API key round trip', () => {
  const models = modelCatalogFromIds(['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-sol'], 'agent')
  assert.deepEqual(models.map((model) => model.id), ['gpt-5.6-luna', 'gpt-5.6-sol'])
  assert.ok(models.every((model) => model.source === 'remote'))
  assert.ok(models.every((model) => model.modes.includes('chat') && model.modes.includes('agent')))
  assert.ok(models.every((model) => model.wireMode === 'lite'))
  assert.ok(models.every((model) => model.capabilities.webSearch === false))
  assert.throws(() => modelCatalogFromIds(['contains space'], 'chat'), ModelCatalogError)
})

test('wire mode uses explicit metadata before the exact Codex Responses Lite fallback', async () => {
  const service = new RemoteModelCatalogService({
    fetcher: (async () => new Response(JSON.stringify({
      data: [
        {
          id: 'gpt-5.6-sol',
          owned_by: 'custom',
          capabilities: { webSearch: true, imageGeneration: true }
        },
        { id: 'gpt-5.6-terra' },
        {
          id: 'gpt-5.6-luna',
          owned_by: 'codex',
          use_responses_lite: false,
          capabilities: { webSearch: false, imageGeneration: true }
        },
        { id: 'gpt-5.6-sol-preview', owned_by: 'codex' },
        { id: 'owner-is-not-exact', owned_by: 'Codex' },
        {
          id: 'explicit-lite',
          owned_by: 'other',
          wire_mode: 'responses_lite',
          capabilities: { webSearch: true, imageGeneration: true }
        },
        {
          id: 'metadata-lite',
          owned_by: 'other',
          metadata: { use_responses_lite: true }
        },
        { id: 'standard-codex', owned_by: 'codex', wire_mode: 'standard' },
        { id: 'unknown-owner', owned_by: 'other' }
      ]
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  })

  const models = await service.list(
    { baseUrl: 'https://example.test/v1', apiKey: 'test-key' },
    'agent'
  )
  const byId = new Map(models.map((model) => [model.id, model]))

  for (const id of ['gpt-5.6-sol', 'gpt-5.6-terra', 'explicit-lite', 'metadata-lite']) {
    assert.equal(byId.get(id)?.wireMode, 'lite')
  }
  assert.equal(byId.get('gpt-5.6-sol')?.capabilities.webSearch, false)
  assert.equal(byId.get('gpt-5.6-sol')?.capabilities.imageGeneration, false)
  assert.equal(byId.get('explicit-lite')?.capabilities.webSearch, false)
  assert.equal(byId.get('explicit-lite')?.capabilities.imageGeneration, false)

  assert.equal(byId.get('gpt-5.6-luna')?.wireMode, 'standard')
  assert.equal(byId.get('gpt-5.6-luna')?.declaredWireMode, 'standard')
  assert.equal(byId.get('gpt-5.6-luna')?.capabilities.webSearch, false)
  assert.equal(byId.get('gpt-5.6-luna')?.capabilities.imageGeneration, true)
  assert.equal(byId.get('gpt-5.6-sol-preview')?.wireMode, 'standard')
  assert.equal(byId.get('gpt-5.6-sol-preview')?.capabilities.webSearch, true)
  assert.equal(byId.get('standard-codex')?.capabilities.webSearch, true)
  assert.equal(byId.get('owner-is-not-exact')?.capabilities.webSearch, false)
  assert.equal(byId.get('unknown-owner')?.capabilities.webSearch, false)
})

test('conflicting or malformed wire mode declarations fail closed', async () => {
  const conflicting = new RemoteModelCatalogService({
    fetcher: (async () => new Response(JSON.stringify({
      data: [{
        id: 'conflicting-model',
        wire_mode: 'responses',
        use_responses_lite: true
      }]
    }), { status: 200 })) as typeof fetch
  })
  await assert.rejects(
    conflicting.list({ baseUrl: 'https://example.test/v1', apiKey: 'test-key' }, 'chat'),
    (error: unknown) => error instanceof ModelCatalogError && error.code === 'invalid_response'
  )

  const malformed = new RemoteModelCatalogService({
    fetcher: (async () => new Response(JSON.stringify({
      data: [{ id: 'malformed-model', use_responses_lite: 'true' }]
    }), { status: 200 })) as typeof fetch
  })
  await assert.rejects(
    malformed.list({ baseUrl: 'https://example.test/v1', apiKey: 'test-key' }, 'chat'),
    (error: unknown) => error instanceof ModelCatalogError && error.code === 'invalid_response'
  )
})

test('remote catalog returns only submit-safe ids and only declared capabilities', async () => {
  const marker = 'test-key-never-returned'
  let observedUrl = ''
  let observedAuthorization = ''
  let observedRedirect = ''
  const service = new RemoteModelCatalogService({
    fetcher: (async (input, init) => {
      observedUrl = String(input)
      observedAuthorization = new Headers(init?.headers).get('authorization') ?? ''
      observedRedirect = init?.redirect ?? ''
      return new Response(JSON.stringify({
        data: [
          { id: 'gpt-5.6-sol-ultra' },
          { id: 'embedding-model' },
          { id: 'gpt-5.6-sol-ultra' },
          { id: ' contains-space ' },
          {
            id: 'server-declared-model',
            reasoning: ['low', 'high', 'ultra', 'high', 'unsupported'],
            capabilities: {
              subagents: true,
              toolUse: false,
              webSearch: true,
              attachments: 'true'
            }
          },
          {
            id: 'supported-levels-model',
            supported_reasoning_levels: [
              { effort: 'low', description: 'Fast' },
              { effort: 'xhigh', description: 'Deep' },
              { effort: 'unsupported', description: 'Ignored' }
            ]
          }
        ]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
  })

  const models = await service.list(
    { baseUrl: 'https://example.test/v1', apiKey: marker },
    'agent'
  )

  assert.equal(observedUrl, 'https://example.test/v1/models')
  assert.equal(observedAuthorization, `Bearer ${marker}`)
  assert.equal(observedRedirect, 'manual')
  assert.deepEqual(models.map((model) => model.id), [
    'embedding-model',
    'gpt-5.6-sol-ultra',
    'server-declared-model',
    'supported-levels-model'
  ])
  assert.deepEqual(models[1]?.reasoning, ['auto', 'light', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  assert.equal(models[1]?.wireMode, 'standard')
  assert.equal(models[1]?.declaredReasoning, undefined)
  assert.equal(models[1]?.capabilities.subagents, false)
  assert.deepEqual(models[1]?.declaredCapabilities, {})
  assert.equal(isModelCapabilityExplicitlyUnsupported(models[1]!, 'toolUse'), false)
  assert.equal(isModelCapabilityExplicitlySupported(models[1]!, 'subagents'), false)
  assert.equal(isModelReasoningExplicitlyUnsupported(models[1]!, 'ultra'), false)
  assert.deepEqual(models[2]?.reasoning, ['auto', 'light', 'high', 'ultra'])
  assert.deepEqual(models[2]?.declaredReasoning, ['auto', 'light', 'high', 'ultra'])
  assert.equal(isModelReasoningExplicitlyUnsupported(models[2]!, 'medium'), true)
  assert.equal(models[2]?.capabilities.subagents, true)
  assert.equal(models[2]?.wireMode, 'standard')
  assert.equal(models[2]?.capabilities.toolUse, false)
  assert.equal(models[2]?.capabilities.webSearch, true)
  assert.equal(models[2]?.capabilities.attachments, false)
  assert.deepEqual(models[2]?.declaredCapabilities, {
    subagents: true,
    toolUse: false,
    webSearch: true
  })
  assert.equal(isModelCapabilityExplicitlyUnsupported(models[2]!, 'toolUse'), true)
  assert.equal(isModelCapabilityExplicitlySupported(models[2]!, 'subagents'), true)
  assert.equal(isModelCapabilityExplicitlyUnsupported(models[2]!, 'attachments'), false)
  assert.deepEqual(models[3]?.reasoning, ['auto', 'light', 'xhigh'])
  assert.deepEqual(models[3]?.declaredReasoning, ['auto', 'light', 'xhigh'])
  assert.doesNotMatch(JSON.stringify(models), new RegExp(marker))
})

test('remote errors discard bodies and never surface a key or response content', async () => {
  const marker = 'private-test-key'
  const service = new RemoteModelCatalogService({
    fetcher: (async () => new Response(
      JSON.stringify({ error: `upstream echoed ${marker}` }),
      { status: 401, headers: { 'content-type': 'application/json' } }
    )) as typeof fetch
  })

  await assert.rejects(
    service.list({ baseUrl: 'https://example.test/v1', apiKey: marker }, 'chat'),
    (error: unknown) => {
      assert.ok(error instanceof ModelCatalogError)
      assert.equal(error.code, 'remote_rejected')
      assert.doesNotMatch(error.message, new RegExp(marker))
      assert.doesNotMatch(error.message, /upstream echoed/)
      return true
    }
  )
})

test('catalog response size and shape are bounded', async () => {
  const tooLarge = new RemoteModelCatalogService({
    maxResponseBytes: 1024,
    fetcher: (async () => new Response('x'.repeat(1025), {
      status: 200,
      headers: { 'content-length': '1025' }
    })) as typeof fetch
  })
  await assert.rejects(
    tooLarge.list({ baseUrl: 'https://example.test/v1', apiKey: 'test-key' }, 'chat'),
    (error: unknown) => error instanceof ModelCatalogError && error.code === 'response_too_large'
  )

  const invalid = new RemoteModelCatalogService({
    fetcher: (async () => new Response('{not json', { status: 200 })) as typeof fetch
  })
  await assert.rejects(
    invalid.list({ baseUrl: 'https://example.test/v1', apiKey: 'test-key' }, 'chat'),
    (error: unknown) => error instanceof ModelCatalogError && error.code === 'invalid_response'
  )
})
