import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

// Only a disposable database and mocked HTTP are used; the user's key and DB are never read.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-eight-api-config-'))
process.env.SQLITE_PATH = path.join(directory, 'config.sqlite3')
process.env.HUOBAO_DATA_DIR = directory
process.env.STORAGE_PATH = path.join(directory, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.ts')
const configs = (await import('../src/routes/aiConfigs.ts')).default
const { EIGHT_API_BASE_URL, EIGHT_API_DEFAULT_MODEL, EIGHT_API_VIDEO_MODELS, getActiveConfig,
  getActiveConfigId, getConfigById, isOfficialProvider } = await import('../src/services/ai.ts')
const fakeKey = 'test-only-888api-credential-never-real'
const nativeFetch = globalThis.fetch

after(async () => {
  globalThis.fetch = nativeFetch
  ;(db as any).$client.close()
  await fs.rm(directory, { recursive: true, force: true })
})

async function request(url: string, body: unknown, method = 'POST') {
  return configs.request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

async function mockFetch(action: (input: string | URL | Request, init?: RequestInit) => Promise<Response>, testAction: () => Promise<void>) {
  globalThis.fetch = action as typeof fetch
  try { await testAction() }
  finally { globalThis.fetch = nativeFetch }
}

test('888API is registered only as its own video provider with c5 as default and the VIP family retained', () => {
  assert.equal(isOfficialProvider('video', '888api'), true)
  assert.equal(isOfficialProvider('image', '888api'), false)
  assert.equal(isOfficialProvider('text', '888api'), false)
  assert.deepEqual(EIGHT_API_VIDEO_MODELS, [
    'seedance2.0-933-c5-fast',
    'jimeng-video-seedance-2.0-fast-vip',
    'jimeng-video-seedance-2.0-vip',
    'jimeng-video-seedance-2.0-mini',
  ])
  assert.equal(EIGHT_API_DEFAULT_MODEL, 'seedance2.0-933-c5-fast')
  assert.equal(EIGHT_API_DEFAULT_MODEL, EIGHT_API_VIDEO_MODELS[0])
})

test('creating a video config supplies the 888API base/model defaults and survives runtime filtering', async () => {
  const response = await request('/', { service_type: 'video', provider: '888api', api_key: fakeKey, priority: 20 })
  assert.equal(response.status, 201)
  const { data } = await response.json() as any
  assert.equal(data.base_url, EIGHT_API_BASE_URL)
  assert.deepEqual(data.model, [EIGHT_API_DEFAULT_MODEL])
  const active = await getActiveConfig('video')
  assert.equal(active!.id, data.id)
  assert.equal(active!.provider, '888api')
  assert.equal(active!.model, EIGHT_API_DEFAULT_MODEL)
  assert.equal(await getActiveConfigId('video'), data.id)
  assert.equal((await getConfigById(data.id))!.provider, '888api')
})

test('create and probe reject text/image 888API configs before any outbound request', async () => {
  await mockFetch(async () => { assert.fail('unsupported service must not call any provider') }, async () => {
    for (const service_type of ['text', 'image']) {
      const body = { service_type, provider: '888api', api_key: fakeKey, base_url: EIGHT_API_BASE_URL }
      assert.equal((await request('/', body)).status, 400)
      assert.equal((await request('/test', body)).status, 400)
    }
  })
})

test('888API config create/update/probe reject unrelated Seedance models instead of routing them as official API models', async () => {
  const body = { service_type: 'video', provider: '888api', api_key: fakeKey, base_url: EIGHT_API_BASE_URL,
    model: ['doubao-seedance-2-0-fast'] }
  await mockFetch(async () => { assert.fail('unsupported model must not call any provider') }, async () => {
    assert.equal((await request('/', body)).status, 400)
    assert.equal((await request('/test', body)).status, 400)
    const existing = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.provider, '888api')).get()!
    assert.equal((await request(`/${existing.id}`, { model: body.model }, 'PUT')).status, 400)
    assert.deepEqual(JSON.parse(db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, existing.id)).get()!.model!),
      [EIGHT_API_DEFAULT_MODEL])
  })
})

test('switching a video configuration to 888API sets independent provider defaults', async () => {
  const created = await request('/', { service_type: 'video', provider: 'volcengine', base_url: 'https://old.invalid/api/v3',
    model: ['doubao-seedance-2-0'], api_key: fakeKey })
  const { data } = await created.json() as any
  const updated = await request(`/${data.id}`, { provider: '888api' }, 'PUT')
  assert.equal(updated.status, 200)
  const row = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, data.id)).get()!
  assert.equal(row.provider, '888api')
  assert.equal(row.baseUrl, EIGHT_API_BASE_URL)
  assert.deepEqual(JSON.parse(row.model!), [EIGHT_API_DEFAULT_MODEL])
})

test('existing explicitly selected fast-vip configs are preserved when the default changes to c5', async () => {
  const fastVip = 'jimeng-video-seedance-2.0-fast-vip'
  const response = await request('/', { service_type: 'video', provider: '888api', base_url: EIGHT_API_BASE_URL,
    api_key: fakeKey, model: [fastVip] })
  assert.equal(response.status, 201)
  const { data } = await response.json() as any
  assert.equal((await request(`/${data.id}`, { name: 'retained-fast-vip' }, 'PUT')).status, 200)
  const row = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, data.id)).get()!
  assert.deepEqual(JSON.parse(row.model!), [fastVip])
  assert.equal((await getConfigById(data.id))!.model, fastVip)
})

test('connection testing without an explicit model checks the new c5 default using GET only', async () => {
  let calls = 0
  await mockFetch(async (input, init) => {
    calls++
    assert.equal(String(input), 'https://888api.xin/v1/models')
    assert.equal(init?.method, 'GET')
    assert.equal(init?.body, undefined)
    return Response.json({ data: [{ id: 'seedance2.0-933-c5-fast' }] })
  }, async () => {
    const response = await request('/test', { service_type: 'video', provider: '888api', base_url: EIGHT_API_BASE_URL, api_key: fakeKey })
    const { data } = await response.json() as any
    assert.equal(data.ok, true)
    assert.equal(data.selected_model, 'seedance2.0-933-c5-fast')
    assert.equal(data.selected_model_available, true)
    assert.equal(calls, 1)
  })
})

test('connection testing only GETs /v1/models, accepts a /v1 base once, and reports supported model visibility', async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  await mockFetch(async (input, init) => {
    calls.push({ url: String(input), method: init?.method || 'GET', body: init?.body })
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${fakeKey}`)
    return Response.json({ data: [{ id: EIGHT_API_DEFAULT_MODEL }, { id: 'unrelated-public-model' }], echoed_secret: fakeKey })
  }, async () => {
    const response = await request('/test', { service_type: 'video', provider: '888api', base_url: EIGHT_API_BASE_URL + '/v1/',
      api_key: fakeKey, model: [...EIGHT_API_VIDEO_MODELS] })
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.ok(!text.includes(fakeKey))
    const { data } = JSON.parse(text)
    assert.equal(data.ok, true)
    assert.equal(data.selected_model_available, true)
    assert.deepEqual(data.available_models, [EIGHT_API_DEFAULT_MODEL])
    assert.deepEqual(data.unavailable_models, EIGHT_API_VIDEO_MODELS.slice(1))
    assert.deepEqual(calls, [{ url: 'https://888api.xin/v1/models', method: 'GET', body: undefined }])
  })
})

test('authentication success without the selected model is reported as unavailable', async () => {
  await mockFetch(async () => Response.json({ data: [{ id: EIGHT_API_DEFAULT_MODEL }] }), async () => {
    const response = await request('/test', { service_type: 'video', provider: '888api', base_url: EIGHT_API_BASE_URL,
      api_key: fakeKey, model: [EIGHT_API_VIDEO_MODELS[1]] })
    const { data } = await response.json() as any
    assert.equal(data.reachable, true)
    assert.equal(data.ok, false)
    assert.equal(data.selected_model_available, false)
    assert.deepEqual(data.unavailable_models, [EIGHT_API_VIDEO_MODELS[1]])
  })
})

test('a 200 HTML page cannot pass the 888API connection test', async () => {
  await mockFetch(async () => new Response('<html>login</html>', { status: 200 }), async () => {
    const response = await request('/test', { service_type: 'video', provider: '888api', base_url: EIGHT_API_BASE_URL,
      api_key: fakeKey, model: [EIGHT_API_DEFAULT_MODEL] })
    const { data } = await response.json() as any
    assert.equal(data.ok, false)
    assert.equal(data.reachable, true)
    assert.equal(data.response_preview, '')
  })
})

test('upstream authentication errors cannot echo the API key into connection diagnostics', async () => {
  await mockFetch(async () => Response.json({ error: `Invalid API key ${fakeKey}` }, { status: 401 }), async () => {
    const response = await request('/test', { service_type: 'video', provider: '888api', base_url: EIGHT_API_BASE_URL,
      api_key: fakeKey, model: [EIGHT_API_DEFAULT_MODEL] })
    const text = await response.text()
    assert.ok(!text.includes(fakeKey))
    const { data } = JSON.parse(text)
    assert.equal(data.ok, false)
    assert.equal(data.status, 401)
    assert.match(data.response_preview, /redacted/)
  })
})

test('transport errors redact credentials from both returned messages and logs', async () => {
  const output: string[] = []
  const log = console.log
  console.log = (...values) => { output.push(values.join(' ')) }
  try {
    await mockFetch(async () => { throw new Error(`Fetch failed for ${fakeKey}; Authorization: Bearer ${fakeKey}`) }, async () => {
      const response = await request('/test', { service_type: 'video', provider: '888api', base_url: EIGHT_API_BASE_URL,
        api_key: fakeKey, model: [EIGHT_API_DEFAULT_MODEL] })
      const text = await response.text()
      assert.ok(!text.includes(fakeKey))
      assert.equal(JSON.parse(text).data.reachable, false)
      assert.ok(!output.join('\n').includes(fakeKey))
    })
  } finally { console.log = log }
})
