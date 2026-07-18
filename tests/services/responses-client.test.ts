import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OpenAICompatibleResponsesClient,
  ResponsesClientError,
  generateResponsesPromptCacheKey,
  normalizeResponsesBaseUrl,
  type ResponsesFunctionToolDefinition,
  type ResponsesStreamEvent,
  type ResponsesStreamRequest
} from '../../src/main/services/responses-client.ts'

const encoder = new TextEncoder()
const credentials = {
  baseUrl: 'https://relay.example.test/v1/',
  apiKey: 'sk-private-test-marker'
}
const basicRequest: ResponsesStreamRequest = {
  model: 'gpt-5.6-test',
  messages: [{ role: 'user', content: 'Hello from the test.' }]
}
const promptCacheKey = Buffer.alloc(32, 7).toString('base64url')
const readFileTool: ResponsesFunctionToolDefinition = {
  type: 'function',
  name: 'read_file',
  description: 'Read a workspace-relative UTF-8 text file.',
  parameters: {
    type: 'object',
    properties: {
      relative_path: { type: 'string' }
    },
    required: ['relative_path'],
    additionalProperties: false
  },
  strict: false
}
const gitSummaryTool: ResponsesFunctionToolDefinition = {
  type: 'function',
  name: 'git_summary',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false
  }
}

function sse(type: string, payload: unknown, lineEnding = '\n'): string {
  return `event: ${type}${lineEnding}data: ${JSON.stringify(payload)}${lineEnding}${lineEnding}`
}

function streamResponseFromBytes(chunks: readonly Uint8Array[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    }
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}

function streamResponse(text: string): Response {
  return streamResponseFromBytes([encoder.encode(text)])
}

function splitEveryByte(bytes: Uint8Array): Uint8Array[] {
  return Array.from(bytes, (_value, index) => bytes.subarray(index, index + 1))
}

function assertSafeError(error: unknown, code: ResponsesClientError['code'], markers: readonly string[] = []): boolean {
  assert.ok(error instanceof ResponsesClientError)
  assert.equal(error.code, code)
  assert.equal(error.stack, `ResponsesClientError: ${error.message}`)
  for (const marker of markers) {
    assert.doesNotMatch(error.message, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
    assert.doesNotMatch(error.stack ?? '', new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
  }
  return true
}

test('POST request is private by default and parses official SSE events across UTF-8/CRLF chunks', async () => {
  let observedUrl = ''
  let observedInit: RequestInit | undefined
  const events: ResponsesStreamEvent[] = []
  const wire = [
    sse('response.created', { type: 'response.created', response: { id: 'resp_test' } }, '\r\n'),
    sse('response.output_text.delta', { type: 'response.output_text.delta', delta: '你' }, '\r\n'),
    sse('response.output_text.done', { type: 'response.output_text.done', text: 'ignored' }, '\r\n'),
    sse('response.output_text.delta', { type: 'response.output_text.delta', delta: '好' }, '\r\n'),
    sse('response.completed', { type: 'response.completed', response: { id: 'resp_test' } }, '\r\n'),
    `data: [DONE]\r\n\r\n`
  ].join('')
  const bytes = encoder.encode(wire)
  const chunks = [
    bytes.subarray(0, 17),
    bytes.subarray(17, 91),
    bytes.subarray(91, 92),
    bytes.subarray(92, 93),
    bytes.subarray(93, 151),
    bytes.subarray(151)
  ]
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async (input, init) => {
      observedUrl = String(input)
      observedInit = init
      return streamResponseFromBytes(chunks)
    }) as typeof fetch
  })

  const result = await client.stream(credentials, {
    model: 'gpt-5.6-test',
    messages: [
      { role: 'system', content: 'Answer briefly.' },
      { role: 'user', content: 'Say hello.' },
      { role: 'assistant', content: 'Previous answer.' },
      { role: 'developer', content: 'Use plain text.' }
    ],
    reasoning: 'high',
    webSearch: true
  }, { onEvent: (event) => events.push(event) })

  assert.equal(observedUrl, 'https://relay.example.test/v1/responses')
  assert.equal(observedInit?.method, 'POST')
  assert.equal(observedInit?.redirect, 'manual')
  assert.equal(observedInit?.credentials, 'omit')
  const headers = new Headers(observedInit?.headers)
  assert.equal(headers.get('authorization'), `Bearer ${credentials.apiKey}`)
  assert.equal(headers.get('accept'), 'text/event-stream')
  const body = String(observedInit?.body)
  assert.doesNotMatch(observedUrl, /sk-private-test-marker/)
  assert.doesNotMatch(body, /sk-private-test-marker/)
  assert.deepEqual(JSON.parse(body), {
    model: 'gpt-5.6-test',
    input: [
      { role: 'system', content: 'Answer briefly.' },
      { role: 'user', content: 'Say hello.' },
      { role: 'assistant', content: 'Previous answer.' },
      { role: 'developer', content: 'Use plain text.' }
    ],
    stream: true,
    store: false,
    reasoning: { effort: 'high' },
    tools: [{ type: 'web_search', external_web_access: true }]
  })
  assert.deepEqual(result, { responseId: 'resp_test', outputText: '你好', toolCalls: [] })
  assert.deepEqual(events.map((event) => event.type), [
    'response.created',
    'response.output_text.delta',
    'response.output_text.delta',
    'response.completed'
  ])
})

test('Responses Lite serializes first-turn instructions, tools, and messages in its input contract', async () => {
  let observedInit: RequestInit | undefined
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async (_input, init) => {
      observedInit = init
      return streamResponse(sse('response.completed', {
        type: 'response.completed',
        response: { id: 'resp_lite_first', output: [] }
      }))
    }) as typeof fetch
  })

  await client.stream(credentials, {
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'Inspect this workspace.' }],
    instructions: 'Use only the declared local tools.',
    reasoning: 'auto',
    tools: [readFileTool],
    wireMode: 'lite',
    promptCacheKey
  })

  const headers = new Headers(observedInit?.headers)
  assert.equal(headers.get('x-openai-internal-codex-responses-lite'), 'true')
  assert.equal(headers.get('x-codex-turn-state'), null)
  assert.deepEqual(JSON.parse(String(observedInit?.body)), {
    model: 'gpt-5.6-sol',
    input: [
      {
        type: 'additional_tools',
        role: 'developer',
        tools: [readFileTool]
      },
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'Use only the declared local tools.' }]
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Inspect this workspace.' }]
      }
    ],
    stream: true,
    store: false,
    reasoning: { context: 'all_turns' },
    include: ['reasoning.encrypted_content'],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    prompt_cache_key: promptCacheKey
  })
})

test('display reasoning labels serialize to the Codex wire effort values', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return streamResponse(sse('response.completed', {
        type: 'response.completed',
        response: { id: 'resp_lite_reasoning', output: [] }
      }))
    }) as typeof fetch
  })

  for (const reasoning of ['light', 'ultra'] as const) {
    await client.stream(credentials, {
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'Inspect this workspace.' }],
      reasoning,
      wireMode: 'lite',
      promptCacheKey
    })
  }

  assert.deepEqual(bodies.map((body) => body.reasoning), [
    { context: 'all_turns', effort: 'low' },
    { context: 'all_turns', effort: 'max' }
  ])
})

test('Responses Lite types assistant history and strips only image detail from a serialized copy', async () => {
  let observedBody = ''
  const imageData = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')}`
  const fileData = `data:application/pdf;base64,${Buffer.from('%PDF-safe', 'utf8').toString('base64')}`
  const userContent = [
    { type: 'input_text' as const, text: 'Continue with both attachments.' },
    { type: 'input_image' as const, image_url: imageData, detail: 'original' as const },
    {
      type: 'input_file' as const,
      filename: 'attachment-2.pdf',
      file_data: fileData,
      detail: 'high' as const
    }
  ]
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async (_input, init) => {
      observedBody = String(init?.body)
      return streamResponse(sse('response.completed', {
        type: 'response.completed',
        response: { id: 'resp_lite_history', output: [] }
      }))
    }) as typeof fetch
  })

  await client.stream(credentials, {
    model: 'gpt-5.6-sol',
    messages: [
      { role: 'user', content: 'Initial question.' },
      { role: 'assistant', content: 'Initial answer.' },
      { role: 'user', content: userContent }
    ],
    wireMode: 'lite',
    promptCacheKey
  })

  const body = JSON.parse(observedBody) as { input: unknown[]; reasoning: unknown }
  assert.deepEqual(body.input, [
    { type: 'additional_tools', role: 'developer', tools: [] },
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Initial question.' }]
    },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Initial answer.' }]
    },
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'Continue with both attachments.' },
        { type: 'input_image', image_url: imageData },
        {
          type: 'input_file',
          filename: 'attachment-2.pdf',
          file_data: fileData,
          detail: 'high'
        }
      ]
    }
  ])
  assert.deepEqual(body.reasoning, { context: 'all_turns' })
  assert.equal(userContent[1]?.detail, 'original')
  assert.equal(userContent[2]?.detail, 'high')
})

test('Responses Lite rejects hosted web and image tools before contacting the endpoint', async () => {
  let fetchCalls = 0
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async () => {
      fetchCalls += 1
      return streamResponse('')
    }) as typeof fetch
  })

  for (const hostedCapability of [{ webSearch: true }, { imageGeneration: true }]) {
    await assert.rejects(client.stream(credentials, {
      ...basicRequest,
      ...hostedCapability,
      wireMode: 'lite',
      promptCacheKey
    }), (error: unknown) => assertSafeError(error, 'invalid_input'))
  }
  assert.equal(fetchCalls, 0)
})

test('prompt cache keys are random canonical 32-byte base64url values and invalid keys fail before fetch', async () => {
  const generated = Array.from({ length: 32 }, () => generateResponsesPromptCacheKey())
  assert.equal(new Set(generated).size, generated.length)
  for (const key of generated) {
    assert.match(key, /^[A-Za-z0-9_-]{43}$/u)
    assert.equal(Buffer.from(key, 'base64url').length, 32)
    assert.equal(Buffer.from(key, 'base64url').toString('base64url'), key)
  }

  let fetchCalls = 0
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async () => {
      fetchCalls += 1
      return streamResponse('')
    }) as typeof fetch
  })
  for (const invalidKey of [
    'short',
    `${'A'.repeat(42)}=`,
    `${'A'.repeat(42)}B`,
    'A'.repeat(44)
  ]) {
    await assert.rejects(
      client.stream(credentials, { ...basicRequest, promptCacheKey: invalidKey }),
      (error: unknown) => assertSafeError(error, 'invalid_input', [invalidKey])
    )
  }
  await assert.rejects(
    client.stream(credentials, { ...basicRequest, tools: [readFileTool] }),
    (error: unknown) => assertSafeError(error, 'invalid_input')
  )
  assert.equal(fetchCalls, 0)
})

test('continuation capsules are unforgeable, binding-scoped, and single use before fetch', async () => {
  let fetchCalls = 0
  const functionCall = {
    id: 'fc_binding',
    type: 'function_call',
    status: 'completed',
    call_id: 'call_binding',
    name: 'read_file',
    arguments: '{}'
  }
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async () => {
      fetchCalls += 1
      return streamResponse(sse('response.completed', {
        type: 'response.completed',
        response: {
          id: `resp_binding_${fetchCalls}`,
          output: fetchCalls === 1 ? [functionCall] : []
        }
      }))
    }) as typeof fetch
  })
  const first = await client.stream(credentials, {
    ...basicRequest,
    tools: [readFileTool],
    promptCacheKey
  })
  assert.ok(first.continuation)
  const continuation = {
    capsule: first.continuation,
    outputs: [{ type: 'function_call_output' as const, call_id: 'call_binding', output: 'done' }]
  }
  const anotherPromptCacheKey = Buffer.alloc(32, 8).toString('base64url')
  const invalidAttempts: Array<{
    credentials?: typeof credentials
    request: ResponsesStreamRequest
  }> = [
    {
      request: {
        model: 'gpt-5.6-other', continuation, tools: [readFileTool], promptCacheKey
      }
    },
    {
      credentials: { ...credentials, baseUrl: 'https://other-relay.example.test/v1' },
      request: { model: basicRequest.model, continuation, tools: [readFileTool], promptCacheKey }
    },
    {
      request: {
        model: basicRequest.model,
        continuation,
        tools: [readFileTool],
        wireMode: 'lite',
        promptCacheKey
      }
    },
    {
      request: {
        model: basicRequest.model,
        continuation,
        tools: [readFileTool],
        promptCacheKey: anotherPromptCacheKey
      }
    },
    {
      request: {
        model: basicRequest.model,
        continuation: { capsule: {} as never, outputs: continuation.outputs },
        tools: [readFileTool],
        promptCacheKey
      }
    },
    {
      request: {
        model: basicRequest.model,
        continuation: {
          capsule: first.continuation,
          outputs: [{ type: 'function_call_output', call_id: 'call_wrong', output: 'done' }]
        },
        tools: [readFileTool],
        promptCacheKey
      }
    }
  ]
  for (const attempt of invalidAttempts) {
    await assert.rejects(
      client.stream(attempt.credentials ?? credentials, attempt.request),
      (error: unknown) => assertSafeError(error, 'invalid_input')
    )
  }
  assert.equal(fetchCalls, 1)

  await client.stream(credentials, {
    model: basicRequest.model,
    continuation,
    tools: [readFileTool],
    promptCacheKey
  })
  assert.equal(fetchCalls, 2)
  await assert.rejects(
    client.stream(credentials, {
      model: basicRequest.model,
      continuation,
      tools: [readFileTool],
      promptCacheKey
    }),
    (error: unknown) => assertSafeError(error, 'invalid_input')
  )
  assert.equal(fetchCalls, 2)
})

test('reasoning continuation accepts exactly 2 MiB cumulatively and rejects the next byte', async () => {
  let fetchCalls = 0
  const fullChunk = 'R'.repeat(512 * 1024)
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async () => {
      fetchCalls += 1
      const callId = `call_reasoning_budget_${fetchCalls}`
      return streamResponse(sse('response.completed', {
        type: 'response.completed',
        response: {
          id: `resp_reasoning_budget_${fetchCalls}`,
          output: [{
            id: `rs_reasoning_budget_${fetchCalls}`,
            type: 'reasoning',
            summary: [],
            encrypted_content: fetchCalls <= 4 ? fullChunk : 'R'
          }, {
            id: `fc_reasoning_budget_${fetchCalls}`,
            type: 'function_call',
            status: 'completed',
            call_id: callId,
            name: 'read_file',
            arguments: '{}'
          }]
        }
      }))
    }) as typeof fetch,
    maxResponseBytes: 2 * 1024 * 1024,
    maxEventBytes: 1024 * 1024,
    maxOutputTextBytes: 1024 * 1024
  })

  let result = await client.stream(credentials, {
    ...basicRequest,
    tools: [readFileTool],
    promptCacheKey
  })
  for (let round = 1; round < 4; round += 1) {
    assert.ok(result.continuation)
    result = await client.stream(credentials, {
      model: basicRequest.model,
      continuation: {
        capsule: result.continuation,
        outputs: [{
          type: 'function_call_output',
          call_id: result.toolCalls[0]!.callId,
          output: 'done'
        }]
      },
      tools: [readFileTool],
      promptCacheKey
    })
  }
  assert.ok(result.continuation)
  await assert.rejects(
    client.stream(credentials, {
      model: basicRequest.model,
      continuation: {
        capsule: result.continuation,
        outputs: [{
          type: 'function_call_output',
          call_id: result.toolCalls[0]!.callId,
          output: 'done'
        }]
      },
      tools: [readFileTool],
      promptCacheKey
    }),
    (error: unknown) => assertSafeError(error, 'response_too_large')
  )
  assert.equal(fetchCalls, 5)
})

test('a continuation consumed by cancellation or network failure cannot leak into a retry', async () => {
  const functionCall = {
    id: 'fc_consumed_error',
    type: 'function_call',
    status: 'completed',
    call_id: 'call_consumed_error',
    name: 'read_file',
    arguments: '{}'
  }
  let networkFetchCalls = 0
  const networkClient = new OpenAICompatibleResponsesClient({
    fetcher: (async () => {
      networkFetchCalls += 1
      if (networkFetchCalls === 1) {
        return streamResponse(sse('response.completed', {
          type: 'response.completed',
          response: { id: 'resp_consumed_error', output: [functionCall] }
        }))
      }
      throw new Error('private-network-detail')
    }) as typeof fetch
  })
  const first = await networkClient.stream(credentials, {
    ...basicRequest,
    tools: [readFileTool],
    promptCacheKey
  })
  assert.ok(first.continuation)
  const continuationRequest: ResponsesStreamRequest = {
    model: basicRequest.model,
    continuation: {
      capsule: first.continuation,
      outputs: [{ type: 'function_call_output', call_id: 'call_consumed_error', output: 'done' }]
    },
    tools: [readFileTool],
    promptCacheKey
  }
  await assert.rejects(
    networkClient.stream(credentials, continuationRequest),
    (error: unknown) => assertSafeError(error, 'network_error', ['private-network-detail'])
  )
  await assert.rejects(
    networkClient.stream(credentials, continuationRequest),
    (error: unknown) => assertSafeError(error, 'invalid_input')
  )
  assert.equal(networkFetchCalls, 2)

  let cancelledFetchCalls = 0
  const cancelledClient = new OpenAICompatibleResponsesClient({
    fetcher: (async () => {
      cancelledFetchCalls += 1
      return streamResponse(sse('response.completed', {
        type: 'response.completed',
        response: { id: 'resp_consumed_cancel', output: [functionCall] }
      }))
    }) as typeof fetch
  })
  const cancellable = await cancelledClient.stream(credentials, {
    ...basicRequest,
    tools: [readFileTool],
    promptCacheKey
  })
  assert.ok(cancellable.continuation)
  const cancelledRequest: ResponsesStreamRequest = {
    ...continuationRequest,
    continuation: {
      capsule: cancellable.continuation,
      outputs: continuationRequest.continuation!.outputs
    }
  }
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    cancelledClient.stream(credentials, cancelledRequest, { signal: controller.signal }),
    (error: unknown) => assertSafeError(error, 'cancelled')
  )
  await assert.rejects(
    cancelledClient.stream(credentials, cancelledRequest),
    (error: unknown) => assertSafeError(error, 'invalid_input')
  )
  assert.equal(cancelledFetchCalls, 1)
})

test('turn state remains private in a single-use continuation and first value wins', async () => {
  const observedHeaders: Headers[] = []
  let call = 0
  const turnState = 'turn-state_ABC123'
  const functionCall = {
    id: 'fc_turn_state',
    type: 'function_call',
    status: 'completed',
    call_id: 'call_turn_state',
    name: 'read_file',
    arguments: '{}'
  }
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async (_input, init) => {
      observedHeaders.push(new Headers(init?.headers))
      call += 1
      return new Response(encoder.encode(sse('response.completed', {
        type: 'response.completed',
        response: { id: `resp_turn_state_${call}`, output: call === 1 ? [functionCall] : [] }
      })), {
        headers: {
          'content-type': 'text/event-stream',
          'x-codex-turn-state': call === 1 ? turnState : 'turn-state_DIFFERENT'
        }
      })
    }) as typeof fetch
  })

  const first = await client.stream(credentials, {
    ...basicRequest,
    tools: [readFileTool],
    promptCacheKey
  })
  assert.ok(first.continuation)
  assert.equal(Object.hasOwn(first, 'turnState'), false)
  assert.doesNotMatch(JSON.stringify(first), /turn-state/u)
  const second = await client.stream(credentials, {
    model: basicRequest.model,
    continuation: {
      capsule: first.continuation,
      outputs: [{ type: 'function_call_output', call_id: 'call_turn_state', output: 'done' }]
    },
    tools: [readFileTool],
    promptCacheKey
  })

  assert.equal(observedHeaders[0]?.get('x-codex-turn-state'), null)
  assert.equal(observedHeaders[1]?.get('x-codex-turn-state'), turnState)
  assert.equal(Object.hasOwn(second, 'turnState'), false)
  assert.equal(second.continuation, undefined)
})

test('turn state rejects unsafe values and rejected responses are never inspected for state', async () => {
  let fetchCalls = 0
  const validationClient = new OpenAICompatibleResponsesClient({
    fetcher: (async () => {
      fetchCalls += 1
      return streamResponse('')
    }) as typeof fetch
  })
  for (const unsafeState of [
    'contains a space',
    'line\nbreak',
    credentials.apiKey,
    'x'.repeat(4097)
  ]) {
    await assert.rejects(
      validationClient.stream(credentials, { ...basicRequest, turnState: unsafeState }),
      (error: unknown) => assertSafeError(error, 'invalid_input', [unsafeState, credentials.apiKey])
    )
  }
  assert.equal(fetchCalls, 0)

  let headerReads = 0
  let bodyCancelled = false
  const rejectedBody = new ReadableStream<Uint8Array>({
    cancel() { bodyCancelled = true }
  }, { highWaterMark: 0 })
  const rejectedResponse = {
    status: 400,
    ok: false,
    body: rejectedBody,
    get headers() {
      headerReads += 1
      throw new Error('rejected-header-must-not-be-read')
    }
  } as unknown as Response
  const rejectedClient = new OpenAICompatibleResponsesClient({
    fetcher: (async () => rejectedResponse) as typeof fetch
  })
  await assert.rejects(
    rejectedClient.stream(credentials, basicRequest),
    (error: unknown) => assertSafeError(error, 'remote_rejected', ['rejected-header-must-not-be-read'])
  )
  assert.equal(headerReads, 0)
  assert.equal(bodyCancelled, true)

  let successfulBodyCancelled = false
  const credentialStateClient = new OpenAICompatibleResponsesClient({
    fetcher: (async () => new Response(new ReadableStream<Uint8Array>({
      cancel() { successfulBodyCancelled = true }
    }, { highWaterMark: 0 }), {
      headers: {
        'content-type': 'text/event-stream',
        'x-codex-turn-state': 'sk-response-secret-marker'
      }
    })) as typeof fetch
  })
  await assert.rejects(
    credentialStateClient.stream(credentials, basicRequest),
    (error: unknown) => assertSafeError(error, 'invalid_response', ['sk-response-secret-marker'])
  )
  assert.equal(successfulBodyCancelled, true)
})

test('function tools and structured input serialize to the official Responses shape without changing private defaults', async () => {
  let observedBody = ''
  const completedCall = {
    id: 'fc_next',
    type: 'function_call',
    status: 'completed',
    call_id: 'call_next',
    name: 'read_file',
    arguments: JSON.stringify({ relative_path: 'src/main.ts' })
  }
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async (_input, init) => {
      observedBody = String(init?.body)
      return streamResponse(sse('response.completed', {
        type: 'response.completed',
        response: { id: 'resp_tool', output: [completedCall] }
      }))
    }) as typeof fetch
  })

  const result = await client.stream(credentials, {
    model: 'gpt-5.6-test',
    instructions: 'Operate only through the declared tools.',
    input: [
      { role: 'user', content: 'Continue the workspace inspection.' },
      {
        type: 'function_call',
        call_id: 'call_previous',
        name: 'read_file',
        arguments: { relative_path: 'README.md' }
      },
      {
        type: 'function_call_output',
        call_id: 'call_previous',
        output: 'safe prior tool output'
      }
    ],
    webSearch: true,
    tools: [readFileTool],
    promptCacheKey
  })

  assert.doesNotMatch(observedBody, /sk-private-test-marker/)
  assert.deepEqual(JSON.parse(observedBody), {
    model: 'gpt-5.6-test',
    instructions: 'Operate only through the declared tools.',
    input: [
      { role: 'user', content: 'Continue the workspace inspection.' },
      {
        type: 'function_call',
        call_id: 'call_previous',
        name: 'read_file',
        arguments: JSON.stringify({ relative_path: 'README.md' })
      },
      {
        type: 'function_call_output',
        call_id: 'call_previous',
        output: 'safe prior tool output'
      }
    ],
    stream: true,
    store: false,
    tools: [
      { type: 'web_search', external_web_access: true },
      readFileTool
    ],
    include: ['reasoning.encrypted_content'],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    prompt_cache_key: promptCacheKey
  })
  assert.ok(result.continuation)
  assert.deepEqual({
    responseId: result.responseId,
    outputText: result.outputText,
    toolCalls: result.toolCalls
  }, {
    responseId: 'resp_tool',
    outputText: '',
    toolCalls: [{
      callId: 'call_next',
      name: 'read_file',
      arguments: { relative_path: 'src/main.ts' }
    }]
  })
})

test('reasoning state is private, ordered, stripped of text, and replayed only by its capsule', async () => {
  const encryptedContent = 'opaque_reasoning_state_0123456789'
  const discardedSummary = 'private reasoning summary must not be replayed'
  const call = {
    id: 'fc_reasoning',
    type: 'function_call',
    status: 'completed',
    call_id: 'call_reasoning',
    name: 'read_file',
    arguments: JSON.stringify({ relative_path: 'README.md' })
  }
  const bodies: unknown[] = []
  let requestIndex = 0
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      requestIndex += 1
      if (requestIndex === 1) {
        return streamResponse(sse('response.completed', {
          type: 'response.completed',
          response: {
            id: 'resp_reasoning_tool',
            output: [{
              id: 'rs_reasoning',
              type: 'reasoning',
              summary: [{ type: 'summary_text', text: discardedSummary }],
              content: [{ type: 'reasoning_text', text: 'discarded raw reasoning' }],
              encrypted_content: encryptedContent
            }, call]
          }
        }))
      }
      return streamResponse([
        sse('response.output_text.delta', {
          type: 'response.output_text.delta',
          delta: 'Done.'
        }),
        sse('response.completed', {
          type: 'response.completed',
          response: { id: 'resp_reasoning_final', output: [] }
        })
      ].join(''))
    }) as typeof fetch
  })

  const first = await client.stream(credentials, {
    model: 'gpt-5.6-test',
    instructions: 'Use the workspace tools.',
    messages: [{ role: 'user', content: 'Inspect the project.' }],
    reasoning: 'high',
    tools: [readFileTool],
    promptCacheKey
  })
  assert.ok(first.continuation)
  assert.equal(Object.hasOwn(first, 'reasoningItems'), false)
  assert.doesNotMatch(JSON.stringify(first), new RegExp(encryptedContent))

  const second = await client.stream(credentials, {
    model: 'gpt-5.6-test',
    instructions: 'Use the workspace tools.',
    continuation: {
      capsule: first.continuation,
      outputs: [{
        type: 'function_call_output',
        call_id: first.toolCalls[0]!.callId,
        output: 'bounded tool output'
      }]
    },
    reasoning: 'high',
    tools: [readFileTool],
    promptCacheKey
  })

  assert.equal(second.outputText, 'Done.')
  assert.equal(bodies.length, 2)
  assert.deepEqual((bodies[0] as Record<string, unknown>).include, ['reasoning.encrypted_content'])
  const secondBody = JSON.stringify(bodies[1])
  assert.match(secondBody, new RegExp(encryptedContent))
  assert.doesNotMatch(secondBody, new RegExp(discardedSummary))
  assert.match(secondBody, /"type":"reasoning".*"type":"function_call".*"type":"function_call_output"/u)
})

test('output-item reasoning metadata and text content stay inside bounded continuation state', async () => {
  const bodies: unknown[] = []
  const encryptedContent = 'opaque-output-item-reasoning'
  const functionCall = {
    id: 'fc_output_item',
    type: 'function_call',
    status: 'completed',
    call_id: 'call_output_item',
    name: 'read_file',
    arguments: '{}'
  }
  let fetchIndex = 0
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      fetchIndex += 1
      if (fetchIndex === 1) {
        return streamResponse([
          sse('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'rs_output_item',
              type: 'reasoning',
              summary: [{ type: 'summary_text', text: 'discard me' }],
              content: [{ type: 'text', text: 'discard this too' }],
              encrypted_content: encryptedContent,
              internal_chat_message_metadata_passthrough: {
                turn_id: 'turn_output_item',
                provider: { trace: 'bounded-provider-metadata' },
                [credentials.apiKey]: 'credential-bearing key must be redacted'
              }
            }
          }),
          sse('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: 1,
            item: functionCall
          }),
          sse('response.completed', {
            type: 'response.completed',
            response: {
              id: 'resp_output_item',
              output: [{
                id: 'rs_output_item',
                type: 'reasoning',
                summary: [],
                encrypted_content: null
              }, functionCall]
            }
          })
        ].join(''))
      }
      return streamResponse(sse('response.completed', {
        type: 'response.completed',
        response: { id: 'resp_output_item_final', output: [] }
      }))
    }) as typeof fetch
  })

  const first = await client.stream(credentials, {
    ...basicRequest,
    tools: [readFileTool],
    promptCacheKey
  })
  assert.ok(first.continuation)
  await client.stream(credentials, {
    model: basicRequest.model,
    continuation: {
      capsule: first.continuation,
      outputs: [{ type: 'function_call_output', call_id: 'call_output_item', output: 'done' }]
    },
    tools: [readFileTool],
    promptCacheKey
  })

  const continuationBody = JSON.stringify(bodies[1])
  assert.match(continuationBody, new RegExp(encryptedContent))
  assert.match(continuationBody, /turn_output_item/u)
  assert.match(continuationBody, /bounded-provider-metadata/u)
  assert.doesNotMatch(continuationBody, new RegExp(credentials.apiKey))
  assert.doesNotMatch(continuationBody, /discard me|discard this too/u)
})

test('mixed known output replays in output-index order with assistant and web text redacted', async () => {
  const bodies: unknown[] = []
  const imageResult = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    Buffer.from('mixed-image')
  ]).toString('base64')
  const functionCall = {
    id: 'fc_mixed',
    type: 'function_call',
    status: 'completed',
    call_id: 'call_mixed',
    name: 'read_file',
    arguments: JSON.stringify({
      relative_path: 'C:\\Users\\private\\secret.txt',
      note: credentials.apiKey
    })
  }
  const output = [
    {
      id: 'rs_mixed',
      type: 'reasoning',
      summary: [],
      encrypted_content: 'opaque-mixed-reasoning'
    },
    {
      id: 'msg_mixed',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: `Do not replay ${credentials.apiKey} or C:\\Users\\private\\secret.txt`,
        annotations: []
      }]
    },
    {
      id: 'ws_mixed',
      type: 'web_search_call',
      status: 'completed',
      action: { type: 'search', query: `api_key=${credentials.apiKey}` }
    },
    {
      id: 'ig_mixed',
      type: 'image_generation_call',
      status: 'completed',
      revised_prompt: 'A bounded generated image.',
      result: imageResult
    },
    functionCall
  ]
  let fetchIndex = 0
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      fetchIndex += 1
      return fetchIndex === 1
        ? streamResponse(sse('response.completed', {
            type: 'response.completed',
            response: { id: 'resp_mixed', output }
          }))
        : streamResponse(sse('response.completed', {
            type: 'response.completed',
            response: { id: 'resp_mixed_final', output: [] }
          }))
    }) as typeof fetch
  })

  const first = await client.stream(credentials, {
    ...basicRequest,
    webSearch: true,
    imageGeneration: true,
    tools: [readFileTool],
    promptCacheKey
  })
  assert.ok(first.continuation)
  assert.equal(first.generatedImages?.length, 1)
  assert.deepEqual(first.toolCalls[0]?.arguments, {
    relative_path: 'C:\\Users\\private\\secret.txt',
    note: credentials.apiKey
  })
  await client.stream(credentials, {
    model: basicRequest.model,
    continuation: {
      capsule: first.continuation,
      outputs: [{ type: 'function_call_output', call_id: 'call_mixed', output: 'done' }]
    },
    webSearch: true,
    imageGeneration: true,
    tools: [readFileTool],
    promptCacheKey
  })

  const continuationInput = (bodies[1] as {
    input: Array<{ id?: string; type?: string; role?: string; status?: string }>
  }).input
  assert.deepEqual(continuationInput.map((item) => item.type ?? item.role), [
    'user',
    'reasoning',
    'message',
    'web_search_call',
    'image_generation_call',
    'function_call',
    'function_call_output'
  ])
  assert.ok(continuationInput.every((item) => !Object.hasOwn(item, 'id')))
  const replayedAssistant = continuationInput.find(
    (item) => item.type === 'message' && item.role === 'assistant'
  )
  assert.ok(replayedAssistant)
  assert.equal(Object.hasOwn(replayedAssistant, 'status'), false)
  const continuationBody = JSON.stringify(bodies[1])
  assert.doesNotMatch(continuationBody, new RegExp(credentials.apiKey))
  assert.doesNotMatch(continuationBody, /C:\\\\Users\\\\private/u)
  assert.match(continuationBody, /<redacted>|<local-path>/u)
})

test('unknown mixed output fails closed before a local function call can be returned', async () => {
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async () => streamResponse(sse('response.completed', {
      type: 'response.completed',
      response: {
        id: 'resp_unknown_mixed',
        output: [{ type: 'computer_call', id: 'computer_unknown' }, {
          id: 'fc_unknown_mixed',
          type: 'function_call',
          status: 'completed',
          call_id: 'call_unknown_mixed',
          name: 'read_file',
          arguments: '{}'
        }]
      }
    }))) as typeof fetch
  })
  await assert.rejects(
    client.stream(credentials, {
      ...basicRequest,
      tools: [readFileTool],
      promptCacheKey
    }),
    (error: unknown) => assertSafeError(error, 'invalid_response')
  )
})

test('streamed tool calls must also exist in the ordered completed output before return', async () => {
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async () => streamResponse([
      sse('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: 'fc_missing_completed_output',
          type: 'function_call',
          status: 'in_progress',
          call_id: 'call_missing_completed_output',
          name: 'read_file',
          arguments: ''
        }
      }),
      sse('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: 'fc_missing_completed_output',
        output_index: 0,
        arguments: '{}'
      }),
      sse('response.completed', {
        type: 'response.completed',
        response: { id: 'resp_missing_completed_output', output: [] }
      })
    ].join(''))) as typeof fetch
  })

  await assert.rejects(
    client.stream(credentials, {
      ...basicRequest,
      tools: [readFileTool],
      promptCacheKey
    }),
    (error: unknown) => assertSafeError(error, 'invalid_response')
  )
})

test('multimodal input and image generation use the bounded official Responses shapes', async () => {
  let observedBody = ''
  const generatedBytes = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    Buffer.from('bounded-generated-image')
  ])
  const generatedBase64 = generatedBytes.toString('base64')
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async (_input, init) => {
      observedBody = String(init?.body)
      return streamResponse(sse('response.completed', {
        type: 'response.completed',
        response: {
          id: 'resp_multimodal',
          output: [{
            id: 'ig_test',
            type: 'image_generation_call',
            status: 'completed',
            result: generatedBase64
          }]
        }
      }))
    }) as typeof fetch
  })
  const imageData = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
  const fileData = Buffer.from('safe redacted text', 'utf8').toString('base64')

  const result = await client.stream(credentials, {
    model: 'gpt-5.6-test',
    messages: [{
      role: 'user',
      content: [
        { type: 'input_text', text: 'Use these selected attachments.' },
        {
          type: 'input_image',
          image_url: `data:image/png;base64,${imageData}`,
          detail: 'auto'
        },
        {
          type: 'input_file',
          filename: 'attachment-2.txt',
          file_data: `data:text/plain;base64,${fileData}`
        }
      ]
    }],
    imageGeneration: true
  })

  assert.deepEqual(JSON.parse(observedBody), {
    model: 'gpt-5.6-test',
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: 'Use these selected attachments.' },
        {
          type: 'input_image',
          image_url: `data:image/png;base64,${imageData}`,
          detail: 'auto'
        },
        {
          type: 'input_file',
          filename: 'attachment-2.txt',
          file_data: `data:text/plain;base64,${fileData}`
        }
      ]
    }],
    stream: true,
    store: false,
    tools: [{ type: 'image_generation' }]
  })
  assert.deepEqual(result, {
    responseId: 'resp_multimodal',
    outputText: '',
    toolCalls: [],
    generatedImages: [{
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${generatedBase64}`
    }]
  })
  assert.doesNotMatch(observedBody, /sk-private-test-marker|[A-Z]:\\/i)
})

test('multimodal validation rejects URLs, original filenames, malformed data, and unsolicited images before exposure', async () => {
  let fetchCalls = 0
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async () => {
      fetchCalls += 1
      return streamResponse('')
    }) as typeof fetch
  })
  const invalidContents: unknown[] = [
    [
      { type: 'input_text', text: 'Inspect it.' },
      { type: 'input_image', image_url: 'https://example.test/private.png' }
    ],
    [
      { type: 'input_text', text: 'Inspect it.' },
      { type: 'input_image', image_url: 'data:image/png;base64,not-canonical' }
    ],
    [
      { type: 'input_text', text: 'Inspect it.' },
      {
        type: 'input_file',
        filename: 'customer-secret.txt',
        file_data: `data:text/plain;base64,${Buffer.from('safe').toString('base64')}`
      }
    ],
    [{ type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' }],
    [
      { type: 'input_text', text: 'first' },
      { type: 'input_text', text: 'second' }
    ]
  ]
  for (const content of invalidContents) {
    await assert.rejects(
      client.stream(credentials, {
        model: 'gpt-5.6-test',
        messages: [{ role: 'user', content } as never]
      }),
      (error: unknown) => assertSafeError(error, 'invalid_input', ['customer-secret'])
    )
  }
  assert.equal(fetchCalls, 0)

  const unsolicited = new OpenAICompatibleResponsesClient({
    fetcher: (async () => streamResponse(sse('response.completed', {
      type: 'response.completed',
      response: {
        output: [{
          type: 'image_generation_call',
          status: 'completed',
          result: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
        }]
      }
    }))) as typeof fetch
  })
  await assert.rejects(
    unsolicited.stream(credentials, basicRequest),
    (error: unknown) => assertSafeError(error, 'invalid_response')
  )
})

test('large completion events are permitted only for explicitly requested bounded image generation', async () => {
  const generated = Buffer.alloc(320 * 1024)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(generated)
  const resultBase64 = generated.toString('base64')
  const wire = sse('response.completed', {
    type: 'response.completed',
    response: {
      id: 'resp_large_image',
      output: [{
        type: 'image_generation_call',
        status: 'completed',
        result: resultBase64
      }]
    }
  })

  const imageClient = new OpenAICompatibleResponsesClient({
    fetcher: (async () => streamResponse(wire)) as typeof fetch
  })
  const imageResult = await imageClient.stream(credentials, {
    ...basicRequest,
    imageGeneration: true
  })
  assert.equal(imageResult.generatedImages?.[0]?.dataUrl.endsWith(resultBase64), true)

  const ordinaryClient = new OpenAICompatibleResponsesClient({
    fetcher: (async () => streamResponse(wire)) as typeof fetch
  })
  await assert.rejects(
    ordinaryClient.stream(credentials, basicRequest),
    (error: unknown) => assertSafeError(error, 'event_too_large')
  )

  const oversizedTextWire = sse('response.output_text.delta', {
    type: 'response.output_text.delta',
    delta: 'x'.repeat(320 * 1024)
  })
  const imageModeTextClient = new OpenAICompatibleResponsesClient({
    fetcher: (async () => streamResponse(oversizedTextWire)) as typeof fetch
  })
  await assert.rejects(
    imageModeTextClient.stream(credentials, { ...basicRequest, imageGeneration: true }),
    (error: unknown) => assertSafeError(error, 'event_too_large')
  )
})

test('official Codex indexless output items preserve commentary and tool continuation', async () => {
  const bodies: Array<Record<string, unknown>> = []
  let requestIndex = 0
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      requestIndex += 1
      if (requestIndex === 1) {
        return streamResponse([
          sse('response.output_text.delta', {
            type: 'response.output_text.delta',
            delta: 'I will inspect the workspace.'
          }),
          sse('response.output_item.done', {
            type: 'response.output_item.done',
            item: {
              type: 'message',
              role: 'assistant',
              phase: 'commentary',
              content: [{ type: 'output_text', text: 'I will inspect the workspace.' }]
            }
          }),
          sse('response.output_item.done', {
            type: 'response.output_item.done',
            item: {
              type: 'function_call',
              call_id: 'call_indexless',
              name: 'read_file',
              arguments: JSON.stringify({ relative_path: 'README.md' })
            }
          }),
          sse('response.completed', {
            type: 'response.completed',
            response: { id: 'resp_indexless' }
          })
        ].join(''))
      }
      return streamResponse(sse('response.completed', {
        type: 'response.completed',
        response: { id: 'resp_indexless_final' }
      }))
    }) as typeof fetch
  })

  const first = await client.stream(credentials, {
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'Inspect the project.' }],
    instructions: 'Use the declared workspace tools.',
    tools: [readFileTool],
    wireMode: 'lite',
    promptCacheKey
  })
  assert.equal(first.outputText, 'I will inspect the workspace.')
  assert.deepEqual(first.toolCalls, [{
    callId: 'call_indexless',
    name: 'read_file',
    arguments: { relative_path: 'README.md' }
  }])
  assert.ok(first.continuation)

  await client.stream(credentials, {
    model: 'gpt-5.6-sol',
    continuation: {
      capsule: first.continuation,
      outputs: [{
        type: 'function_call_output',
        call_id: 'call_indexless',
        output: 'bounded tool output'
      }]
    },
    instructions: 'Use the declared workspace tools.',
    tools: [readFileTool],
    wireMode: 'lite',
    promptCacheKey
  })

  const continuationInput = bodies[1]?.input as Array<{ type?: string; role?: string }>
  assert.deepEqual(continuationInput.map((item) => item.type ?? item.role), [
    'additional_tools',
    'message',
    'message',
    'message',
    'function_call',
    'function_call_output'
  ])
})

test('indexless function hints are optional and only the final item creates a tool call', async () => {
  const finalCall = {
    type: 'function_call',
    call_id: 'call_final_hint',
    name: 'read_file',
    arguments: JSON.stringify({ relative_path: 'README.md' })
  }
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async () => streamResponse([
      sse('response.output_item.added', {
        type: 'response.output_item.added',
        item: {
          type: 'function_call',
          id: 'fc_ignored_hint',
          status: 'in_progress',
          call_id: 'call_ignored_hint',
          name: 'unadvertised_hint',
          arguments: ''
        }
      }),
      sse('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_ignored_hint',
        delta: '{"ignored":true}'
      }),
      sse('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: 'fc_ignored_hint',
        arguments: '{"ignored":true}'
      }),
      sse('response.output_item.done', {
        type: 'response.output_item.done',
        item: finalCall
      }),
      sse('response.completed', {
        type: 'response.completed',
        response: { id: 'resp_indexless_hints' }
      })
    ].join(''))) as typeof fetch
  })

  const result = await client.stream(credentials, {
    ...basicRequest,
    tools: [readFileTool],
    promptCacheKey
  })
  assert.deepEqual(result.toolCalls, [{
    callId: 'call_final_hint',
    name: 'read_file',
    arguments: { relative_path: 'README.md' }
  }])
  assert.ok(result.continuation)
})

test('indexless unknown output still fails closed before returning a tool call', async () => {
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async () => streamResponse([
      sse('response.output_item.done', {
        type: 'response.output_item.done',
        item: { type: 'computer_call', id: 'computer_indexless' }
      }),
      sse('response.output_item.done', {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'call_after_unknown',
          name: 'read_file',
          arguments: '{}'
        }
      }),
      sse('response.completed', {
        type: 'response.completed',
        response: { id: 'resp_unknown_indexless' }
      })
    ].join(''))) as typeof fetch
  })

  await assert.rejects(
    client.stream(credentials, { ...basicRequest, tools: [readFileTool], promptCacheKey }),
    (error: unknown) => assertSafeError(error, 'invalid_response')
  )
})

test('duplicate call ids across indexless completed items fail closed', async () => {
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async () => streamResponse([
      sse('response.output_item.done', {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'call_duplicate_indexless',
          name: 'read_file',
          arguments: JSON.stringify({ relative_path: 'README.md' })
        }
      }),
      sse('response.output_item.done', {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'call_duplicate_indexless',
          name: 'read_file',
          arguments: JSON.stringify({ relative_path: 'TESTING.md' })
        }
      })
    ].join(''))) as typeof fetch
  })

  await assert.rejects(
    client.stream(credentials, { ...basicRequest, tools: [readFileTool], promptCacheKey }),
    (error: unknown) => assertSafeError(error, 'invalid_response')
  )
})

test('indexless completed item conflicting with final response output fails closed', async () => {
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async () => streamResponse([
      sse('response.output_item.done', {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'call_conflicting_final',
          name: 'read_file',
          arguments: JSON.stringify({ relative_path: 'README.md' })
        }
      }),
      sse('response.completed', {
        type: 'response.completed',
        response: {
          id: 'resp_conflicting_final',
          output: [{
            type: 'function_call',
            call_id: 'call_conflicting_final',
            name: 'read_file',
            arguments: JSON.stringify({ relative_path: 'TESTING.md' })
          }]
        }
      })
    ].join(''))) as typeof fetch
  })

  await assert.rejects(
    client.stream(credentials, { ...basicRequest, tools: [readFileTool], promptCacheKey }),
    (error: unknown) => assertSafeError(error, 'invalid_response')
  )
})

test('single and multiple function calls are assembled from official streaming events and completed output', async () => {
  const firstArguments = JSON.stringify({ relative_path: 'src/main.ts' })
  const firstItem = {
    id: 'fc_one',
    type: 'function_call',
    status: 'completed',
    call_id: 'call_one',
    name: 'read_file',
    arguments: firstArguments
  }
  const secondItem = {
    id: 'fc_two',
    type: 'function_call',
    status: 'completed',
    call_id: 'call_two',
    name: 'git_summary',
    arguments: '{}'
  }
  const wire = [
    sse('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...firstItem, status: 'in_progress', arguments: '' },
      sequence_number: 1
    }),
    sse('response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_one',
      output_index: 0,
      delta: firstArguments.slice(0, 12),
      sequence_number: 2
    }),
    sse('response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_one',
      output_index: 0,
      delta: firstArguments.slice(12),
      sequence_number: 3
    }),
    sse('response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      item_id: 'fc_one',
      output_index: 0,
      arguments: firstArguments,
      sequence_number: 4
    }),
    sse('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: firstItem,
      sequence_number: 5
    }),
    sse('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 1,
      item: secondItem,
      sequence_number: 6
    }),
    sse('response.completed', {
      type: 'response.completed',
      response: { id: 'resp_multiple', output: [firstItem, secondItem] }
    })
  ].join('')
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async () => streamResponse(wire)) as typeof fetch
  })

  const result = await client.stream(credentials, {
    ...basicRequest,
    tools: [readFileTool, gitSummaryTool],
    promptCacheKey
  })
  assert.deepEqual(result.toolCalls, [
    { callId: 'call_one', name: 'read_file', arguments: { relative_path: 'src/main.ts' } },
    { callId: 'call_two', name: 'git_summary', arguments: {} }
  ])
})

test('base URL normalization permits only HTTPS or loopback HTTP without query material', () => {
  assert.equal(normalizeResponsesBaseUrl('HTTPS://EXAMPLE.TEST:443/v1/'), 'https://example.test/v1')
  assert.equal(normalizeResponsesBaseUrl('http://127.0.0.1:8080/v1/'), 'http://127.0.0.1:8080/v1')
  for (const value of [
    'http://example.test/v1',
    'https://user:password@example.test/v1',
    'https://example.test/v1?region=private',
    'https://example.test/v1#private'
  ]) {
    assert.throws(
      () => normalizeResponsesBaseUrl(value),
      (error: unknown) => assertSafeError(error, 'invalid_endpoint', ['example.test', 'private', 'password'])
    )
  }
})

test('redirects and rejected HTTP responses are safely classified without reading their bodies', async () => {
  for (const [status, expectedCode, retryable, remoteFailure, hasFunctionTools] of [
    [302, 'redirect_rejected', false, undefined, false],
    [400, 'remote_rejected', false, 'request_rejected', false],
    [400, 'remote_rejected', false, 'tool_incompatible', true],
    [401, 'remote_rejected', false, 'authorization', true],
    [403, 'remote_rejected', false, 'authorization', true],
    [404, 'remote_rejected', false, 'responses_unsupported', true],
    [405, 'remote_rejected', false, 'responses_unsupported', true],
    [422, 'remote_rejected', false, 'tool_incompatible', true],
    [429, 'remote_rejected', true, 'rate_limited', true],
    [503, 'remote_rejected', true, 'server_error', true]
  ] as const) {
    let pulls = 0
    let cancelled = false
    const secret = `raw-http-body-${status}`
    const body = new ReadableStream<Uint8Array>({
      pull() {
        pulls += 1
        throw new Error(secret)
      },
      cancel() {
        cancelled = true
      }
    }, { highWaterMark: 0 })
    const client = new OpenAICompatibleResponsesClient({
      fetcher: (async () => new Response(body, {
        status,
        headers: status === 302 ? { location: `https://redirect.invalid/${secret}` } : undefined
      })) as typeof fetch
    })

    const request = hasFunctionTools
      ? { ...basicRequest, tools: [readFileTool], promptCacheKey }
      : basicRequest
    await assert.rejects(client.stream(credentials, request), (error: unknown) => {
      assertSafeError(error, expectedCode, [secret, credentials.apiKey, 'relay.example.test'])
      assert.ok(error instanceof ResponsesClientError)
      assert.equal(error.retryable, retryable)
      assert.equal(error.remoteFailure, remoteFailure)
      return true
    })
    assert.equal(pulls, 0)
    assert.equal(cancelled, true)
  }
})

test('remote failure diagnostics accept only fixed non-sensitive categories', () => {
  const rawMarker = 'raw-upstream-secret-and-private-path'
  const error = new ResponsesClientError(
    'remote_rejected',
    false,
    rawMarker as never
  )
  assert.equal(error.remoteFailure, undefined)
  assertSafeError(error, 'remote_rejected', [rawMarker])
})

test('non-SSE success responses are rejected and discarded', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    cancel() { cancelled = true }
  }, { highWaterMark: 0 })
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async () => new Response(body, {
      headers: { 'content-type': 'application/json' }
    })) as typeof fetch
  })
  await assert.rejects(
    client.stream(credentials, basicRequest),
    (error: unknown) => assertSafeError(error, 'invalid_response')
  )
  assert.equal(cancelled, true)
})

test('error, failed, and incomplete stream events expose only a generic failure', async () => {
  const rawMarker = 'upstream-secret-and-D-private-path'
  for (const type of ['error', 'response.failed', 'response.incomplete']) {
    const client = new OpenAICompatibleResponsesClient({
      fetcher: (async () => streamResponse(sse(type, {
        type,
        error: { message: rawMarker },
        response: { error: rawMarker }
      }))) as typeof fetch
    })
    await assert.rejects(
      client.stream(credentials, basicRequest),
      (error: unknown) => assertSafeError(error, 'remote_error', [rawMarker, credentials.apiKey])
    )
  }
})

test('caller cancellation is distinct from timeout and neither preserves raw fetch errors', async () => {
  const pendingFetcher = (rawMarker: string): typeof fetch => (async (_input, init) => {
    await new Promise<never>((_resolve, reject) => {
      const signal = init?.signal
      if (signal?.aborted) {
        reject(new Error(rawMarker))
        return
      }
      signal?.addEventListener('abort', () => reject(new Error(rawMarker)), { once: true })
    })
  }) as typeof fetch

  const caller = new AbortController()
  const cancelled = new OpenAICompatibleResponsesClient({ fetcher: pendingFetcher('cancel-raw-secret') })
  const cancelledPromise = cancelled.stream(credentials, basicRequest, { signal: caller.signal })
  queueMicrotask(() => caller.abort())
  await assert.rejects(
    cancelledPromise,
    (error: unknown) => assertSafeError(error, 'cancelled', ['cancel-raw-secret', credentials.apiKey])
  )

  const timedOut = new OpenAICompatibleResponsesClient({
    fetcher: pendingFetcher('timeout-raw-secret'),
    timeoutMs: 10
  })
  await assert.rejects(
    timedOut.stream(credentials, basicRequest),
    (error: unknown) => assertSafeError(error, 'timeout', ['timeout-raw-secret', credentials.apiKey])
  )

  const failed = new OpenAICompatibleResponsesClient({
    fetcher: (async () => { throw new Error('network-raw-secret https://relay.example.test/private') }) as typeof fetch
  })
  await assert.rejects(
    failed.stream(credentials, basicRequest),
    (error: unknown) => assertSafeError(error, 'network_error', ['network-raw-secret', 'relay.example.test'])
  )
})

test('total response, event, and accumulated output limits fail closed', async () => {
  const total = new OpenAICompatibleResponsesClient({
    fetcher: (async () => streamResponse('x'.repeat(400))) as typeof fetch,
    maxResponseBytes: 300,
    maxEventBytes: 256,
    maxOutputTextBytes: 256
  })
  await assert.rejects(
    total.stream(credentials, basicRequest),
    (error: unknown) => assertSafeError(error, 'response_too_large')
  )

  const oversizedEvent = new OpenAICompatibleResponsesClient({
    fetcher: (async () => streamResponse(sse('response.output_text.delta', {
      type: 'response.output_text.delta',
      delta: 'x'.repeat(180)
    }))) as typeof fetch,
    maxResponseBytes: 1024,
    maxEventBytes: 128,
    maxOutputTextBytes: 512
  })
  await assert.rejects(
    oversizedEvent.stream(credentials, basicRequest),
    (error: unknown) => assertSafeError(error, 'event_too_large')
  )

  const outputWire = [
    sse('response.output_text.delta', { type: 'response.output_text.delta', delta: 'a'.repeat(40) }),
    sse('response.output_text.delta', { type: 'response.output_text.delta', delta: 'b'.repeat(40) }),
    sse('response.completed', { type: 'response.completed', response: { id: 'resp_limit' } })
  ].join('')
  const oversizedOutput = new OpenAICompatibleResponsesClient({
    fetcher: (async () => streamResponse(outputWire)) as typeof fetch,
    maxResponseBytes: 4096,
    maxEventBytes: 1024,
    maxOutputTextBytes: 64
  })
  await assert.rejects(
    oversizedOutput.stream(credentials, basicRequest),
    (error: unknown) => assertSafeError(error, 'response_too_large')
  )
})

test('one-byte chunks preserve linear bounded parsing and split multibyte UTF-8 safely', async () => {
  const delta = `开${'x'.repeat(500)}始`
  const wire = [
    sse('response.output_text.delta', { type: 'response.output_text.delta', delta }, '\r\n'),
    sse('response.completed', { type: 'response.completed', response: { id: 'resp_tiny' } }, '\r\n')
  ].join('')
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async () => streamResponseFromBytes(splitEveryByte(encoder.encode(wire)))) as typeof fetch,
    maxResponseBytes: 4096,
    maxEventBytes: 2048,
    maxOutputTextBytes: 1024
  })
  const result = await client.stream(credentials, basicRequest)
  assert.deepEqual(result, { responseId: 'resp_tiny', outputText: delta, toolCalls: [] })
})

test('malformed, truncated, and mismatched SSE streams are rejected generically', async () => {
  const streams = [
    `event: response.output_text.delta\ndata: {not-json}\n\n`,
    sse('response.output_text.delta', { type: 'response.output_text.delta', delta: 'never completed' }),
    sse('response.completed', { type: 'response.created', response: { id: 'resp_mismatch' } })
  ]
  for (const wire of streams) {
    const client = new OpenAICompatibleResponsesClient({
      fetcher: (async () => streamResponse(wire)) as typeof fetch
    })
    await assert.rejects(
      client.stream(credentials, basicRequest),
      (error: unknown) => assertSafeError(error, 'invalid_response', ['never completed', 'resp_mismatch'])
    )
  }
})

test('malicious function calls, unknown tools, duplicate IDs, and unsafe argument objects fail closed', async () => {
  const marker = 'raw-function-secret-and-private-path'
  const baseCall = {
    id: 'fc_bad',
    type: 'function_call',
    status: 'completed',
    call_id: 'call_bad',
    name: 'read_file',
    arguments: '{}'
  }
  const maliciousOutputs: unknown[][] = [
    [{ ...baseCall, arguments: `{not-json-${marker}` }],
    [{ ...baseCall, arguments: JSON.stringify([marker]) }],
    [{ ...baseCall, arguments: JSON.stringify({ constructor: { value: marker } }) }],
    [{ ...baseCall, private_detail: marker }],
    [{ ...baseCall, name: 'unknown_tool', arguments: JSON.stringify({ marker }) }],
    [{ ...baseCall, arguments: { relative_path: marker } }],
    [{ ...baseCall, status: 'incomplete', arguments: JSON.stringify({ marker }) }],
    [
      { ...baseCall, id: 'fc_dup_one', call_id: 'call_duplicate' },
      { ...baseCall, id: 'fc_dup_two', call_id: 'call_duplicate' }
    ]
  ]

  for (const output of maliciousOutputs) {
    const client = new OpenAICompatibleResponsesClient({
      fetcher: (async () => streamResponse(sse('response.completed', {
        type: 'response.completed',
        response: { id: 'resp_bad', output }
      }))) as typeof fetch
    })
    await assert.rejects(
      client.stream(credentials, { ...basicRequest, tools: [readFileTool], promptCacheKey }),
      (error: unknown) => assertSafeError(error, 'invalid_response', [marker, credentials.apiKey])
    )
  }
})

test('function argument bytes and tool-call counts are independently bounded', async () => {
  const oversizedArguments = JSON.stringify({ text: 'x'.repeat(256 * 1024) })
  const oversizedClient = new OpenAICompatibleResponsesClient({
    fetcher: (async () => streamResponse(sse('response.completed', {
      type: 'response.completed',
      response: {
        id: 'resp_oversized_arguments',
        output: [{
          id: 'fc_oversized',
          type: 'function_call',
          status: 'completed',
          call_id: 'call_oversized',
          name: 'read_file',
          arguments: oversizedArguments
        }]
      }
    }))) as typeof fetch,
    maxResponseBytes: 1024 * 1024,
    maxEventBytes: 512 * 1024,
    maxOutputTextBytes: 64 * 1024
  })
  await assert.rejects(
    oversizedClient.stream(credentials, { ...basicRequest, tools: [readFileTool], promptCacheKey }),
    (error: unknown) => assertSafeError(error, 'response_too_large')
  )

  const tooManyCalls = Array.from({ length: 33 }, (_value, index) => ({
    id: `fc_limit_${index}`,
    type: 'function_call',
    status: 'completed',
    call_id: `call_limit_${index}`,
    name: 'read_file',
    arguments: '{}'
  }))
  const countClient = new OpenAICompatibleResponsesClient({
    fetcher: (async () => streamResponse(sse('response.completed', {
      type: 'response.completed',
      response: { id: 'resp_too_many_calls', output: tooManyCalls }
    }))) as typeof fetch
  })
  await assert.rejects(
    countClient.stream(credentials, { ...basicRequest, tools: [readFileTool], promptCacheKey }),
    (error: unknown) => assertSafeError(error, 'response_too_large')
  )
})

test('invalid tool definitions and structured input are rejected before fetch', async () => {
  let calls = 0
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async () => {
      calls += 1
      return streamResponse('')
    }) as typeof fetch
  })
  const invalidRequests: unknown[] = [
    {
      ...basicRequest,
      tools: [{ ...readFileTool, unexpected: 'private-tool-field' }]
    },
    {
      ...basicRequest,
      tools: [{ ...readFileTool, parameters: [] }]
    },
    {
      ...basicRequest,
      tools: Array.from({ length: 33 }, (_value, index) => ({
        ...readFileTool,
        name: `read_file_${index}`
      }))
    },
    {
      model: 'gpt-5.6-test',
      messages: basicRequest.messages,
      input: [{ role: 'user', content: 'ambiguous input source' }]
    },
    {
      model: 'gpt-5.6-test',
      input: [{
        type: 'function_call',
        call_id: 'call_unknown',
        name: 'unknown_tool',
        arguments: {}
      }],
      tools: [readFileTool]
    },
    {
      model: 'gpt-5.6-test',
      input: [{
        type: 'function_call_output',
        call_id: 'call_missing',
        output: 'orphan output'
      }],
      tools: [readFileTool]
    },
    {
      model: 'gpt-5.6-test',
      input: [{
        type: 'function_call',
        call_id: 'call_array',
        name: 'read_file',
        arguments: []
      }],
      tools: [readFileTool]
    },
    {
      model: 'gpt-5.6-test',
      input: [{
        type: 'reasoning',
        summary: [],
        encrypted_content: 'caller-controlled-reasoning-state'
      }]
    }
  ]

  for (const request of invalidRequests) {
    await assert.rejects(
      client.stream(credentials, request as ResponsesStreamRequest),
      (error: unknown) => assertSafeError(error, 'invalid_input', ['private-tool-field'])
    )
  }
  assert.equal(calls, 0)
})

test('attachments, images, unknown fields, unsafe keys, and oversized histories are never sent', async () => {
  let calls = 0
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async () => {
      calls += 1
      return streamResponse('')
    }) as typeof fetch
  })

  await assert.rejects(
    client.stream(credentials, { ...basicRequest, attachments: ['local-file'] } as unknown as ResponsesStreamRequest),
    (error: unknown) => assertSafeError(error, 'invalid_input', ['local-file'])
  )
  await assert.rejects(
    client.stream({ ...credentials, apiKey: 'unsafe\r\nHeader: injected' }, basicRequest),
    (error: unknown) => assertSafeError(error, 'invalid_credential', ['injected'])
  )
  await assert.rejects(
    client.stream(credentials, {
      ...basicRequest,
      messages: Array.from({ length: 129 }, () => ({ role: 'user' as const, content: 'bounded' }))
    }),
    (error: unknown) => assertSafeError(error, 'invalid_input')
  )
  assert.equal(calls, 0)
})

test('consumer callback failures are replaced with a fixed safe error', async () => {
  const wire = sse('response.output_text.delta', {
    type: 'response.output_text.delta',
    delta: 'safe output'
  })
  const client = new OpenAICompatibleResponsesClient({
    fetcher: (async () => streamResponse(wire)) as typeof fetch
  })
  await assert.rejects(
    client.stream(credentials, basicRequest, {
      onEvent: () => { throw new Error('consumer-private-path-and-secret') }
    }),
    (error: unknown) => assertSafeError(error, 'consumer_error', ['consumer-private-path-and-secret'])
  )
})
