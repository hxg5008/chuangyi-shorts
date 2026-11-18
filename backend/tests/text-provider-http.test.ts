import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTextProviderFetch, extractTextProviderFailure } from '../src/services/text-provider-http.ts'

interface CapturedRequest { input: RequestInfo | URL; init?: RequestInit & { dispatcher?: unknown } }
async function mockFetch<T>(run: (requests: CapturedRequest[]) => Promise<T>, responder: (request: CapturedRequest) => Response | Promise<Response> = () => new Response('{}', { status: 200 })) {
  const original = globalThis.fetch
  const requests: CapturedRequest[] = []
  globalThis.fetch = (async (input, init) => {
    const request = { input, init }
    requests.push(request)
    return responder(request)
  }) as typeof fetch
  try { return await run(requests) } finally { globalThis.fetch = original }
}
const relay = { provider: 'openai', baseURL: 'https://relay.invalid/v1', model: 'local-text-model' }
const bodyOf = (request: CapturedRequest) => JSON.parse(String(request.init?.body))
const assertDispatcher = (request: CapturedRequest) => {
  assert.ok(request.init?.dispatcher)
  assert.equal(typeof (request.init!.dispatcher as { dispatch?: unknown }).dispatch, 'function')
}

test('a relay request really uses fetchProvider and preserves the SDK stream flag and abort signal', { concurrency: false }, async () => {
  await mockFetch(async requests => {
    const controller = new AbortController()
    const fetcher = createTextProviderFetch(relay)
    await fetcher('https://relay.invalid/v1/chat/completions', { method: 'POST', signal: controller.signal,
      headers: { Authorization: 'Bearer local-test-only' }, body: JSON.stringify({ model: relay.model, messages: [{ role: 'user', content: 'fixture' }], stream: true }) })
    assert.equal(requests.length, 1)
    assertDispatcher(requests[0])
    assert.equal(requests[0].init?.signal, controller.signal)
    const body = bodyOf(requests[0])
    assert.equal(body.stream, true)
    assert.deepEqual(body.thinking, { type: 'disabled' })
    assert.equal(body.enable_thinking, false)
    assert.equal(body.reasoning_effort, 'none')
    assert.equal(body.max_tokens, 16384)
    assert.equal(new Headers(requests[0].init?.headers).get('authorization'), 'Bearer local-test-only')
  })
})

test('ordinary JSON completion keeps stream absent or false instead of forcing SSE', { concurrency: false }, async () => {
  await mockFetch(async requests => {
    const fetcher = createTextProviderFetch(relay)
    await fetcher('https://relay.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [], stream: false }) })
    await fetcher('https://relay.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [] }) })
    assert.equal(bodyOf(requests[0]).stream, false)
    assert.equal(Object.hasOwn(bodyOf(requests[1]), 'stream'), false)
    requests.forEach(assertDispatcher)
  })
})

test('explicit JSON object output reaches the compatible provider wire without changing messages or stream', { concurrency: false }, async () => {
  await mockFetch(async requests => {
    const messages = [{ role: 'user', content: 'private-json-mode-fixture' }]
    const controller = new AbortController()
    const fetcher = createTextProviderFetch({ ...relay, jsonObjectOutput: true })
    for (const stream of [false, true]) {
      await fetcher('https://relay.invalid/v1/chat/completions', { method: 'POST', signal: controller.signal,
        body: JSON.stringify({ messages, stream, response_format: { type: 'text' } }),
      })
      const request = requests.at(-1)!
      const body = bodyOf(request)
      assert.deepEqual(body.response_format, { type: 'json_object' })
      assert.deepEqual(body.messages, messages)
      assert.equal(body.stream, stream)
      assert.equal(request.init?.signal, controller.signal)
      assertDispatcher(request)
    }
    assert.equal(requests.length, 2)
  })
})

test('JSON object mode is opt-in and only changes compatible messages requests', { concurrency: false }, async () => {
  await mockFetch(async requests => {
    const sdkFormat = { type: 'json_schema', json_schema: { name: 'fixture', schema: { type: 'object' } } }
    for (const jsonObjectOutput of [undefined, false]) {
      const fetcher = createTextProviderFetch({ ...relay, jsonObjectOutput })
      await fetcher('https://relay.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [] }) })
      assert.equal(Object.hasOwn(bodyOf(requests.at(-1)!), 'response_format'), false)
      await fetcher('https://relay.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [], response_format: sdkFormat }) })
      assert.deepEqual(bodyOf(requests.at(-1)!).response_format, sdkFormat)
    }
    await createTextProviderFetch({ ...relay, jsonObjectOutput: true })('https://relay.invalid/v1/responses', {
      method: 'POST', body: JSON.stringify({ input: 'fixture' }),
    })
    assert.equal(Object.hasOwn(bodyOf(requests.at(-1)!), 'response_format'), false)
    await createTextProviderFetch({ provider: 'gemini', baseURL: 'https://relay.invalid/v1beta', jsonObjectOutput: true })(
      'https://relay.invalid/v1beta/models/gemini-3-flash:generateContent', { method: 'POST', body: JSON.stringify({ contents: [] }) },
    )
    assert.equal(Object.hasOwn(bodyOf(requests.at(-1)!), 'response_format'), false)
    requests.forEach(assertDispatcher)
  })
})

test('JSON object mode preserves provider refusal without fallback and keeps contents out of request metadata', { concurrency: false }, async () => {
  const metadata: unknown[] = []
  const response = new Response('private-json-mode-provider-response', { status: 400, headers: { 'x-request-id': 'req_json_mode' } })
  await mockFetch(async requests => {
    const result = await createTextProviderFetch({ ...relay, jsonObjectOutput: true, onRequest: value => metadata.push(value) })(
      'https://relay.invalid/v1/chat/completions?api_key=sk-json-mode-fixture', {
        method: 'POST', headers: { Authorization: 'Bearer sk-json-mode-fixture' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'private-json-mode-prompt' }], stream: false }),
      },
    )
    assert.equal(requests.length, 1)
    assert.deepEqual(bodyOf(requests[0]).response_format, { type: 'json_object' })
    assert.equal(result, response)
    assert.equal(result.bodyUsed, false)
    assert.ok(metadata.length > 0)
    const serialized = JSON.stringify(metadata)
    for (const privateValue of ['sk-json-mode-fixture', 'private-json-mode-prompt', 'private-json-mode-provider-response', 'Bearer', 'api_key']) {
      assert.equal(serialized.includes(privateValue), false)
    }
    assert.ok(metadata.some((value: any) => value.status === 400 && value.stream === false))
  }, () => response)
})

test('explicit strict JSON schema output takes priority over JSON object mode on the provider wire', { concurrency: false }, async () => {
  await mockFetch(async requests => {
    const jsonSchemaOutput = { name: 'scheduled_fixture', schema: {
      type: 'object', properties: { value: { type: 'integer', enum: [7] } }, required: ['value'], additionalProperties: false,
    } }
    const originalSchema = structuredClone(jsonSchemaOutput)
    const messages = [{ role: 'user', content: 'private-schema-prompt' }]
    const controller = new AbortController()
    const fetcher = createTextProviderFetch({ ...relay, jsonObjectOutput: true, jsonSchemaOutput })
    for (const stream of [false, true]) {
      await fetcher('https://relay.invalid/v1/chat/completions', { method: 'POST', signal: controller.signal,
        body: JSON.stringify({ messages, stream, response_format: { type: 'json_object' } }),
      })
      const request = requests.at(-1)!, body = bodyOf(request)
      assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { ...jsonSchemaOutput, strict: true } })
      assert.deepEqual(body.messages, messages)
      assert.equal(body.stream, stream)
      assert.equal(request.init?.signal, controller.signal)
      assertDispatcher(request)
    }
    assert.deepEqual(jsonSchemaOutput, originalSchema, 'The configured schema is never mutated')
    assert.equal(requests.length, 2)
  })
})

test('JSON schema output leaves requests outside the compatible messages protocol unchanged', { concurrency: false }, async () => {
  await mockFetch(async requests => {
    const jsonSchemaOutput = { name: 'fixture', schema: { type: 'object' } }
    const sdkFormat = { type: 'text' }
    await createTextProviderFetch({ ...relay, jsonObjectOutput: true, jsonSchemaOutput })('https://relay.invalid/v1/responses', {
      method: 'POST', body: JSON.stringify({ input: 'fixture', response_format: sdkFormat }),
    })
    assert.deepEqual(bodyOf(requests[0]).response_format, sdkFormat)
    await createTextProviderFetch({ provider: 'gemini', baseURL: 'https://relay.invalid/v1beta', jsonObjectOutput: true, jsonSchemaOutput })(
      'https://relay.invalid/v1beta/models/gemini-3-flash:generateContent', { method: 'POST', body: JSON.stringify({ contents: [] }) },
    )
    assert.equal(Object.hasOwn(bodyOf(requests[1]), 'response_format'), false)
    requests.forEach(assertDispatcher)
  })
})

test('a strict JSON schema refusal returns once without JSON object fallback or logging private contents', { concurrency: false }, async () => {
  const metadata: unknown[] = []
  const jsonSchemaOutput = { name: 'private-schema-name', schema: { type: 'object', description: 'private-schema-description' } }
  const response = new Response('private-schema-provider-response', { status: 400 })
  await mockFetch(async requests => {
    const result = await createTextProviderFetch({ ...relay, jsonObjectOutput: true, jsonSchemaOutput, onRequest: value => metadata.push(value) })(
      'https://relay.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'private-schema-prompt' }] }) },
    )
    assert.equal(requests.length, 1)
    assert.deepEqual(bodyOf(requests[0]).response_format, { type: 'json_schema', json_schema: { ...jsonSchemaOutput, strict: true } })
    assert.equal(result, response)
    assert.equal(result.bodyUsed, false)
    assert.ok(metadata.some((value: any) => value.status === 400))
    for (const privateValue of ['private-schema-name', 'private-schema-description', 'private-schema-prompt', 'private-schema-provider-response']) {
      assert.equal(JSON.stringify(metadata).includes(privateValue), false)
    }
  }, () => response)
})

test('configured temperature including zero and token limit are applied without changing messages', { concurrency: false }, async () => {
  await mockFetch(async requests => {
    const messages = [{ role: 'user', content: 'unchanged local fixture' }]
    await createTextProviderFetch({ ...relay, temperature: 0, maxTokens: 8192 })('https://relay.invalid/v1/chat/completions', {
      method: 'POST', body: JSON.stringify({ messages, temperature: 0.9, max_tokens: 32 }),
    })
    const body = bodyOf(requests[0])
    assert.equal(body.temperature, 0)
    assert.equal(body.max_tokens, 8192)
    assert.deepEqual(body.messages, messages)
  })
})

test('thinking disable can be turned off, and an explicit patch replaces default thinking fields', { concurrency: false }, async () => {
  await mockFetch(async requests => {
    await createTextProviderFetch({ ...relay, disableThinking: false, temperature: null })('https://relay.invalid/v1/chat/completions', {
      method: 'POST', body: JSON.stringify({ messages: [], temperature: 0.8 }),
    })
    const unchanged = bodyOf(requests[0])
    assert.equal(unchanged.temperature, 0.8)
    for (const key of ['thinking', 'enable_thinking', 'reasoning_effort']) assert.equal(Object.hasOwn(unchanged, key), false)
    await createTextProviderFetch({ ...relay, thinkingOffPatch: { custom_thinking: 'off' } })('https://relay.invalid/v1/chat/completions', {
      method: 'POST', body: JSON.stringify({ messages: [] }),
    })
    const custom = bodyOf(requests[1])
    assert.equal(custom.custom_thinking, 'off')
    for (const key of ['thinking', 'enable_thinking', 'reasoning_effort']) assert.equal(Object.hasOwn(custom, key), false)
  })
})

test('DeepSeek low thinking enables its documented control without conflicting relay switches or changing later requests', { concurrency: false }, async () => {
  await mockFetch(async requests => {
    for (const model of ['deepseek-v4.1-flash', 'deepseek/deepseek-v4-pro']) {
      const messages = [{ role: 'user', content: 'unchanged complete skill output fixture' }]
      const original = { model, messages, stream: true, thinking: { type: 'disabled' }, enable_thinking: false, reasoning_effort: 'none', thinking_budget: 0, reasoning_budget: 0 }
      await createTextProviderFetch({ ...relay, model, disableThinking: true, thinkingPolicy: 'low', maxTokens: 32768,
        thinkingOffPatch: { thinking: { type: 'disabled' }, enable_thinking: false, reasoning_effort: 'none' } })('https://relay.invalid/v1/chat/completions', {
        method: 'POST', body: JSON.stringify(original),
      })
      const low = bodyOf(requests.at(-1)!)
      assert.deepEqual(low.thinking, { type: 'enabled' })
      assert.equal(low.reasoning_effort, 'low')
      assert.equal(low.max_tokens, 32768)
      assert.deepEqual(low.messages, messages)
      assert.equal(low.stream, true)
      for (const key of ['enable_thinking', 'thinking_budget', 'reasoning_budget']) assert.equal(Object.hasOwn(low, key), false)
      assert.equal(original.enable_thinking, false)
      assert.equal(original.reasoning_effort, 'none')
      await createTextProviderFetch({ ...relay, model })('https://relay.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model, messages }) })
      const next = bodyOf(requests.at(-1)!)
      assert.deepEqual(next.thinking, { type: 'disabled' })
      assert.equal(next.enable_thinking, false)
      assert.equal(next.reasoning_effort, 'none')
      assert.equal(next.max_tokens, 16384)
    }
    assert.equal(requests.length, 4)
  })
})

test('low thinking does not alter other models, official endpoints, or Gemini native requests', { concurrency: false }, async () => {
  await mockFetch(async requests => {
    const cases = [
      { options: { ...relay, disableThinking: false }, url: 'https://relay.invalid/v1/chat/completions', body: { model: 'gpt-5', messages: [] } },
      { options: { ...relay, disableThinking: false }, url: 'https://relay.invalid/v1/chat/completions', body: { model: 'notdeepseek-v4.1-flash', messages: [] } },
      { options: { ...relay, disableThinking: false }, url: 'https://api.openai.com/v1/chat/completions', body: { model: 'deepseek-v4.1-flash', messages: [] } },
      { options: { ...relay, baseURL: 'https://api.openai.com/v1', disableThinking: false }, url: 'https://api.openai.com/v1/chat/completions', body: { model: 'gpt-5', messages: [] } },
      { options: { provider: 'gemini', baseURL: 'https://relay.invalid/v1beta', disableThinking: false }, url: 'https://relay.invalid/v1beta/models/gemini-3-flash:generateContent', body: { contents: [], generationConfig: { thinkingConfig: { thinkingLevel: 'high' } } } },
      { options: { provider: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta', disableThinking: false }, url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent', body: { contents: [], generationConfig: { thinkingConfig: { thinkingLevel: 'high' } } } },
    ]
    for (const probe of cases) {
      await createTextProviderFetch(probe.options)(probe.url, { method: 'POST', body: JSON.stringify(probe.body) })
      const before = bodyOf(requests.at(-1)!)
      await createTextProviderFetch({ ...probe.options, thinkingPolicy: 'low' })(probe.url, { method: 'POST', body: JSON.stringify(probe.body) })
      assert.deepEqual(bodyOf(requests.at(-1)!), before)
    }
  })
})

test('official OpenAI still uses the long-budget dispatcher but receives no unknown thinking or max_tokens fields', { concurrency: false }, async () => {
  await mockFetch(async requests => {
    await createTextProviderFetch({ provider: 'openai', baseURL: 'https://api.openai.com/v1', model: 'gpt-5', temperature: 0.4 })('https://api.openai.com/v1/chat/completions', {
      method: 'POST', body: JSON.stringify({ messages: [], max_completion_tokens: 1234 }),
    })
    assertDispatcher(requests[0])
    const body = bodyOf(requests[0])
    for (const key of ['thinking', 'enable_thinking', 'reasoning_effort', 'max_tokens']) assert.equal(Object.hasOwn(body, key), false)
    assert.equal(body.max_completion_tokens, 1234)
    assert.equal(body.temperature, 0.4)
  })
})

test('a relay host containing an official hostname is not accidentally treated as official', { concurrency: false }, async () => {
  await mockFetch(async requests => {
    const url = 'https://api.openai.com.evil.invalid/v1'
    await createTextProviderFetch({ ...relay, baseURL: url })(`${url}/chat/completions`, { method: 'POST', body: JSON.stringify({ messages: [] }) })
    assert.equal(bodyOf(requests[0]).enable_thinking, false)
    assert.equal(bodyOf(requests[0]).max_tokens, 16384)
  })
})

test('Gemini 3 relay uses low thinking level and Gemini 2 relay uses zero thinking budget', { concurrency: false }, async () => {
  await mockFetch(async requests => {
    for (const model of ['gemini-3-flash-preview', 'gemini-2.5-flash']) {
      await createTextProviderFetch({ provider: 'gemini', baseURL: 'https://relay.invalid/v1beta', model, temperature: 0.2, maxTokens: 4096 })(`https://relay.invalid/v1beta/models/${model}:generateContent`, {
        method: 'POST', body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'fixture' }] }], generationConfig: { topP: 0.7 } }),
      })
    }
    const third = bodyOf(requests[0]).generationConfig
    assert.equal(third.thinkingConfig.thinkingLevel, 'low')
    assert.equal(third.thinkingConfig.thinkingBudget, undefined)
    const second = bodyOf(requests[1]).generationConfig
    assert.equal(second.thinkingConfig.thinkingBudget, 0)
    assert.equal(second.thinkingConfig.includeThoughts, false)
    for (const config of [third, second]) {
      assert.equal(config.temperature, 0.2)
      assert.equal(config.maxOutputTokens, 4096)
      assert.equal(config.topP, 0.7)
    }
    requests.forEach(assertDispatcher)
  })
})

test('official Gemini preserves SDK thinking settings while applying configured temperature and output tokens', { concurrency: false }, async () => {
  await mockFetch(async requests => {
    const fetcher = createTextProviderFetch({ provider: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash', temperature: 0, maxTokens: 2048 })
    await fetcher('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', { method: 'POST', body: JSON.stringify({
      contents: [], generationConfig: { thinkingConfig: { thinkingBudget: 1024 } },
    }) })
    assertDispatcher(requests[0])
    const body = bodyOf(requests[0])
    assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 1024 })
    assert.equal(body.generationConfig.temperature, 0)
    assert.equal(body.generationConfig.maxOutputTokens, 2048)
    for (const key of ['thinking', 'enable_thinking', 'reasoning_effort', 'max_tokens']) assert.equal(Object.hasOwn(body, key), false)
  })
})

test('Gemini native SSE URL is logged as streaming without injecting an OpenAI stream field', { concurrency: false }, async () => {
  const metadata: any[] = []
  const response = new Response('data: {"candidates":[]}\n\n', { headers: { 'content-type': 'text/event-stream' } })
  await mockFetch(async requests => {
    const fetcher = createTextProviderFetch({ provider: 'gemini', baseURL: 'https://relay.invalid/v1beta', model: 'gemini-3-flash-preview', onRequest: value => metadata.push(value) })
    const result = await fetcher('https://relay.invalid/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse&key=local-test-only', {
      method: 'POST', body: JSON.stringify({ contents: [] }),
    })
    assert.equal(result, response)
    assert.equal(result.bodyUsed, false)
    assertDispatcher(requests[0])
    assert.equal(Object.hasOwn(bodyOf(requests[0]), 'stream'), false)
    assert.ok(metadata.some(value => value.stream === true && value.status === 200))
    assert.ok(!JSON.stringify(metadata).includes('local-test-only'))
  }, () => response)
})

test('malformed JSON and requests without model bodies pass through the same dispatcher unchanged', { concurrency: false }, async () => {
  await mockFetch(async requests => {
    const fetcher = createTextProviderFetch(relay)
    await fetcher('https://relay.invalid/v1/chat/completions', { method: 'POST', body: '{not-json' })
    await fetcher('https://relay.invalid/v1/models', { method: 'GET' })
    assert.equal(requests[0].init?.body, '{not-json')
    assert.equal(requests[1].init?.method, 'GET')
    assert.equal(requests[1].init?.body, undefined)
    requests.forEach(assertDispatcher)
  })
})

test('SSE response identity and body remain untouched and safe request metadata excludes secrets', { concurrency: false }, async () => {
  const metadata: unknown[] = []
  const response = new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_local_123', authorization: 'Bearer response-test-only' } })
  await mockFetch(async requests => {
    const fetcher = createTextProviderFetch({ ...relay, onRequest: value => metadata.push(value) })
    const result = await fetcher('https://relay.invalid/v1/chat/completions?api_key=sk-local-secret&signed=local-signature', {
      method: 'POST', headers: { Authorization: 'Bearer sk-local-secret' }, body: JSON.stringify({ model: relay.model, messages: [{ role: 'user', content: 'private-prompt-fixture' }], stream: true }),
    })
    assert.equal(result, response)
    assert.equal(result.bodyUsed, false)
    assertDispatcher(requests[0])
    assert.ok(metadata.length >= 1)
    const serialized = JSON.stringify(metadata)
    for (const secret of ['sk-local-secret', 'local-signature', 'private-prompt-fixture', 'Bearer', 'api_key', 'authorization']) assert.ok(!serialized.includes(secret))
    const final: any = metadata.find((value: any) => value.status === 200)
    assert.ok(final)
    assert.equal(final.origin, 'https://relay.invalid')
    assert.equal(final.path, '/v1/chat/completions')
    assert.equal(final.model, relay.model)
    assert.equal(final.stream, true)
    assert.equal(final.requestId, 'req_local_123')
    assert.equal(typeof final.elapsedMs, 'number')
    assert.ok(final.elapsedMs >= 0)
    const allowed = new Set(['origin', 'path', 'model', 'stream', 'status', 'elapsedMs', 'requestId', 'errorCode'])
    metadata.forEach((value: any) => Object.keys(value).forEach(key => assert.ok(allowed.has(key), key)))
  }, () => response)
})

test('non-success provider responses are returned intact once, leaving error parsing to the SDK', { concurrency: false }, async () => {
  const response = new Response('Gateway Timeout', { status: 504, headers: { 'x-request-id': 'req_timeout_1' } })
  await mockFetch(async requests => {
    const result = await createTextProviderFetch(relay)('https://relay.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [] }) })
    assert.equal(result, response)
    assert.equal(result.status, 504)
    assert.equal(result.bodyUsed, false)
    assert.equal(requests.length, 1)
  }, () => response)
})

test('network failures are not automatically retried and use safe failure metadata', { concurrency: false }, async () => {
  const metadata: unknown[] = []
  const failure = new TypeError('fetch failed', { cause: Object.assign(new Error('connect failed'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) })
  await mockFetch(async requests => {
    await assert.rejects(createTextProviderFetch({ ...relay, onRequest: value => metadata.push(value) })('https://relay.invalid/v1/chat/completions?secret=fixture', {
      method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'private-network-fixture' }] }),
    }), error => error === failure)
    assert.equal(requests.length, 1)
    assertDispatcher(requests[0])
    assert.ok(!JSON.stringify(metadata).includes('private-network-fixture'))
    assert.ok(!JSON.stringify(metadata).includes('secret='))
  }, () => { throw failure })
})

test('real nested HTTP status and whitelisted request IDs are classified without exposing credentials or signed URLs', { concurrency: false }, () => {
  const inner = Object.assign(new Error('Gateway Timeout: Bearer sk-local-secret at https://relay.invalid/private?api_key=sk-local-secret'), {
    statusCode: 504, responseHeaders: { 'x-request-id': 'req_http_504', authorization: 'Bearer should-not-log' },
  })
  const failure = extractTextProviderFailure(new Error('Agent wrapper', { cause: inner }))
  assert.equal(failure.code, 'upstream_http_504')
  assert.equal(failure.statusCode, 504)
  assert.equal(failure.requestId, 'req_http_504')
  assert.match(failure.message, /Gateway Timeout/)
  for (const secret of ['sk-local-secret', 'https://relay.invalid/private', 'Bearer sk-local-secret', 'should-not-log']) assert.ok(!JSON.stringify(failure).includes(secret))
})

test('other real HTTP failures retain their status while Gateway Timeout wording alone cannot manufacture 504', { concurrency: false }, () => {
  for (const status of [400, 429, 502]) {
    const failure = extractTextProviderFailure(Object.assign(new Error('provider error'), { status }))
    assert.equal(failure.code, 'upstream_http_error')
    assert.equal(failure.statusCode, status)
  }
  const unknown = extractTextProviderFailure(new Error('Gateway Timeout'))
  assert.notEqual(unknown.code, 'upstream_http_504')
  assert.equal(unknown.statusCode, undefined)
})

test('network cause codes and aborts are classified separately from provider HTTP errors', { concurrency: false }, () => {
  const network = extractTextProviderFailure(new TypeError('fetch failed', { cause: Object.assign(new Error('socket failed'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }))
  assert.equal(network.code, 'network_error')
  assert.equal(network.causeCode, 'UND_ERR_CONNECT_TIMEOUT')
  assert.equal(network.statusCode, undefined)
  const aborted = extractTextProviderFailure(new DOMException('The operation was aborted', 'AbortError'))
  assert.equal(aborted.code, 'aborted')
  assert.equal(aborted.statusCode, undefined)
  assert.equal(extractTextProviderFailure(new Error('本次分镜处理超时，旧稿已保留')).code, 'aborted')
})

test('cause traversal is bounded and circular errors cannot loop or invent a deep HTTP status', { concurrency: false }, () => {
  const root: any = new Error('outer')
  let current = root
  for (let depth = 0; depth < 8; depth++) { current.cause = new Error(`wrapper ${depth}`); current = current.cause }
  current.statusCode = 504
  assert.equal(extractTextProviderFailure(root).statusCode, undefined)
  const circular: any = new Error('circular')
  circular.cause = circular
  const failure = extractTextProviderFailure(circular)
  assert.equal(failure.statusCode, undefined)
  assert.equal(typeof failure.message, 'string')
})

test('request IDs from arbitrary headers or unsafe response values are rejected', { concurrency: false }, () => {
  for (const headers of [
    { authorization: 'Bearer local-test-only', 'x-unrelated-id': 'req_not_whitelisted' },
    { 'x-request-id': 'https://relay.invalid/leak?key=fixture' },
    { 'x-request-id': 'Bearer local-test-only' },
    { 'x-request-id': 'x'.repeat(1000) },
  ]) {
    const failure = extractTextProviderFailure(Object.assign(new Error('Gateway Timeout'), { statusCode: 504, responseHeaders: headers }))
    assert.equal(failure.requestId, undefined)
    assert.ok(!JSON.stringify(failure).includes('local-test-only'))
  }
})
