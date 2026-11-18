import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { errorHandler, httpErrorHandler, requestLogger } from '../src/middleware/logger.ts'

// No database, network, real credentials or production logs are used.
async function capture(action: () => Promise<void>): Promise<string> {
  const log = console.log
  const error = console.error
  const output: string[] = []
  console.log = (...values) => { output.push(values.join(' ')) }
  console.error = (...values) => { output.push(values.join(' ')) }
  try { await action() }
  finally { console.log = log; console.error = error }
  return output.join('\n')
}

function app() {
  const server = new Hono()
  server.onError(httpErrorHandler)
  server.use('*', requestLogger)
  server.use('*', errorHandler)
  server.post('/ai-configs', async c => { await c.req.json(); return c.json({ ok: true }) })
  server.post('/ai-configs/test', async c => { await c.req.json(); return c.json({ ok: true }) })
  server.post('/plain', async c => { await c.req.text(); return c.text('ok') })
  return server
}

test('HTTP config and test logs recursively redact credential aliases before output', async () => {
  const secretValues = Array.from({ length: 11 }, (_, i) => `fake-local-credential-${i}-not-real`)
  const body = {
    service_type: 'video', provider: '888api', model: ['example-video'], api_key: secretValues[0],
    nested: { apiKey: secretValues[1], authorization: `Bearer ${secretValues[2]}`, 'X-API-Key': secretValues[3],
      access_token: secretValues[4], clientSecret: secretValues[5], password: secretValues[6] },
    items: [{ refreshToken: secretValues[7] }, { private_key: secretValues[8] }],
    credentials: { username: secretValues[9], password: secretValues[10] },
  }
  const server = app()
  const output = await capture(async () => {
    for (const url of ['/ai-configs', '/ai-configs/test']) {
      const response = await server.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      assert.equal(response.status, 200)
    }
  })
  for (const value of secretValues) assert.ok(!output.includes(value))
  assert.match(output, /888api/)
  assert.match(output, /example-video/)
  assert.match(output, /redacted/)
})

test('serialized nested JSON and arbitrary string sk/Bearer credentials are redacted', async () => {
  const nestedSecret = 'nested-setting-value-not-real'
  const skSecret = 'sk-fake-local-test-never-real'
  const bearerSecret = 'fake-bearer-note-value'
  const basicSecret = 'ZmFrZTpwd2Q='
  const output = await capture(async () => {
    const response = await app().request('/ai-configs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: JSON.stringify({ headers: [{ API_KEY: nestedSecret }] }),
        note: `Debug ${skSecret}, Bearer ${bearerSecret}; Basic ${basicSecret}` }) })
    assert.equal(response.status, 200)
  })
  for (const value of [nestedSecret, skSecret, bearerSecret, basicSecret]) assert.ok(!output.includes(value))
})

test('known credentials declared after the logging limit are also removed from earlier string copies', async () => {
  const secret = 'arbitrary-copy-value-without-sk-prefix'
  const output = await capture(async () => {
    await app().request('/ai-configs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: `upstream echoed ${secret}`, padding: 'x'.repeat(1_000), api_key: secret }) })
  })
  assert.ok(!output.includes(secret))
  assert.match(output, /upstream echoed \[redacted\]/)
  assert.match(output, /\.\.\./)
})

test('dynamic plugin auth containers redact arbitrary secret field names and copied values before vault resolution', async () => {
  const secret = 'arbitrary-plugin-credential-synthetic-value'
  const output = await capture(async () => {
    await app().request('/admin/channels', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: `upstream echoed ${secret}`, auth_fields: { customField: secret, secretAccessKey: secret } }) })
  })
  assert(!output.includes(secret)); assert.match(output, /upstream echoed \[redacted\]/u)
})

test('a key spanning byte 500 cannot leak even its prefix through truncation', async () => {
  const secret = 'fake-long-value-' + 'a'.repeat(300)
  const output = await capture(async () => {
    await app().request('/ai-configs/test', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(450), api_key: secret }) })
  })
  assert.ok(!output.includes(secret.slice(0, 24)))
  assert.match(output, /redacted/)
})

test('malformed JSON and unstructured request bodies are omitted rather than logged raw', async () => {
  const secret = 'fake-invalid-json-password'
  const output = await capture(async () => {
    for (const body of [`{"api_key":"${secret}"} broken`, `password=${secret}`]) {
      await app().request('/plain', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body })
    }
  })
  assert.ok(!output.includes(secret))
  assert.match(output, /non-JSON request body omitted/)
})

test('URL credentials in free text are redacted without hiding the request route', async () => {
  const output = await capture(async () => {
    await app().request('/ai-configs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'https://fakeuser:fakepass@local.invalid/path?api_key=fakequery&mode=test' }) })
  })
  assert.ok(!output.includes('fakepass'))
  assert.ok(!output.includes('fakequery'))
  assert.match(output, /\/ai-configs/)
})

test('logger does not mutate or consume the JSON body received by the actual handler', async () => {
  const expected = { api_key: 'fake-value-for-route-handler', provider: '888api' }
  const server = app()
  server.post('/preserve', async c => { assert.deepEqual(await c.req.json(), expected); return c.json({ ok: true }) })
  const output = await capture(async () => {
    const response = await server.request('/preserve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(expected) })
    assert.equal(response.status, 200)
  })
  assert.ok(!output.includes(expected.api_key))
})

test('request credentials cannot escape through error stacks or error responses', async () => {
  const secret = 'fake-arbitrary-error-credential'
  const server = app()
  server.post('/throws', async c => { const body = await c.req.json(); throw new Error(`Provider rejected ${body.api_key}`) })
  const output = await capture(async () => {
    const response = await server.request('/throws', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: secret }) })
    assert.equal(response.status, 500)
    assert.ok(!(await response.text()).includes(secret))
  })
  assert.ok(!output.includes(secret))
  assert.match(output, /Provider rejected \[redacted\]/)
})

test('credentials from Authorization headers and repeated form fields are hidden in error messages', async () => {
  const bearer = 'fake-header-only-value'
  const formFirst = 'fake-first-form-value'
  const formSecond = 'fake-second-form-value'
  const server = app()
  server.post('/form-error', async c => { await c.req.text(); throw new Error(`${formFirst} ${formSecond} ${bearer}`) })
  const output = await capture(async () => {
    const response = await server.request('/form-error', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${bearer}` },
      body: new URLSearchParams([['api_key', formFirst], ['api_key', formSecond]]) })
    assert.equal(response.status, 500)
    const body = await response.text()
    for (const secret of [bearer, formFirst, formSecond]) assert.ok(!body.includes(secret))
  })
  for (const secret of [bearer, formFirst, formSecond]) assert.ok(!output.includes(secret))
})

test('multipart uploads remain unread by the logger and retain their contents for the route', async () => {
  const secret = 'fake-upload-form-credential'
  const server = app()
  server.post('/upload', async c => {
    const form = await c.req.formData()
    assert.equal(form.get('api_key'), secret)
    assert.equal((form.get('file') as File).size, 8)
    return c.text('ok')
  })
  const output = await capture(async () => {
    const form = new FormData()
    form.append('api_key', secret)
    form.append('file', new Blob(['12345678']), 'reference.png')
    assert.equal((await server.request('/upload', { method: 'POST', body: form })).status, 200)
  })
  assert.ok(!output.includes(secret))
  assert.doesNotMatch(output, /body:/)
})
