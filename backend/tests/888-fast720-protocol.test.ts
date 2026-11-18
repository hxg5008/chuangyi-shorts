import { after, afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-888-fast720-'))
process.env.HUOBAO_DATA_DIR = root
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.HUOBAO_PROXY_URL = 'direct'
const runtime = await import('../src/services/provider-runtime/index.ts')
const { db } = await import('../src/db/index.ts')
const { engineGenerationRequest } = await import('../src/services/adapters/protocol-engine-adapter.ts')
const { normalize888Fast720References } = await import('../src/services/adapters/888-fast720-reference.ts')
const originalFetch = globalThis.fetch
const manifest = JSON.parse(await fs.readFile(new URL('../src/services/model-channels/bundled/888-seedance-fast720-local.json', import.meta.url), 'utf8'))
const providerId = '888-seedance-fast720-local'
const definition = { engine: 'yingce-v2' as const, manifest, providerId }
const connection = { baseUrl: 'https://888api.xin', apiKey: 'synthetic-888-fast720-test-key' }
const config = { id: 1, serviceType: 'video', provider: 'yingce', model: 'seedance2.0-fast-720p',
  baseUrl: connection.baseUrl, apiKey: connection.apiKey, protocolId: 'engine.' + providerId,
  protocolDefinition: definition, parameters: [], defaults: {} } as any
const request = (override: Record<string, unknown> = {}) => ({ capability: 'video' as const,
  model: 'seedance2.0-fast-720p', prompt: '按参考图保留人物与场景。', duration: 12, aspectRatio: '9:16', resolution: '720p',
  images: [{ url: 'https://images.example.test/first.png', kind: 'image', role: 'reference_image', order: 0 }],
  ...override })

afterEach(() => { globalThis.fetch = originalFetch })
after(async () => {
  globalThis.fetch = originalFetch
  runtime.shutdownProviderEngine()
  db.$client.close()
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
  assert.ok(path.basename(root).startsWith('huobao-888-fast720-'))
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 })
})

test('Fast 720p manifest compiles with the real interpreter and builds exact 888 endpoint fields', async () => {
  const compiled = await runtime.compileProvider(definition)
  assert.equal(compiled.executable, true, compiled.reason)
  assert.equal(compiled.requiresPublicMediaUrls, true)
  const input = request({ images: [
    { url: 'https://images.example.test/third.png', kind: 'image', role: 'reference_image', order: 2 },
    { url: 'https://images.example.test/first.png', kind: 'image', role: 'reference_image', order: 0 },
    { url: 'https://images.example.test/first.png', kind: 'image', role: 'reference_image', order: 1 },
  ] })
  const before = structuredClone(input)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6lrkAAAAASUVORK5CYII=', 'base64')
  const hosted = (index: number) => `https://888api.xin/creative/api/reference/${index}-${'a'.repeat(64)}-${'b'.repeat(48)}.png`
  const reads: string[] = []
  let uploads = 0
  globalThis.fetch = (async (url, init) => {
    if (init?.method === 'GET') {
      reads.push(String(url))
      assert.ok(['https://images.example.test/third.png', 'https://images.example.test/first.png'].includes(String(url)))
      return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } })
    }
    assert.equal(String(url), 'https://888api.xin/creative/api/reference')
    assert.equal(init?.method, 'POST')
    assert.equal(new Headers(init?.headers).get('Content-Type'), 'image/png')
    assert.deepEqual(Buffer.from(init?.body as Uint8Array), png)
    return Response.json({ url: hosted(++uploads) })
  }) as typeof fetch
  const built = await runtime.buildCreate({ providerDefinition: definition, connection, request: input })
  const body = JSON.parse(built.body as string)
  assert.equal(built.url, 'https://888api.xin/v1/videos')
  assert.equal(built.method, 'POST')
  assert.equal(built.headers.authorization, 'Bearer ' + connection.apiKey)
  assert.equal(body.model, input.model)
  assert.equal(body.seconds, 12)
  assert.equal(typeof body.seconds, 'number')
  assert.equal(body.ratio, '9:16')
  assert.equal(body.resolution, '720p')
  assert.equal(body.prompt, input.prompt)
  assert.deepEqual(reads, ['https://images.example.test/third.png', 'https://images.example.test/first.png'])
  assert.equal(uploads, 2)
  assert.deepEqual(body.images, [hosted(2), hosted(2), hosted(1)])
  for (const forbidden of ['input', 'image_urls', 'aspect_ratio', 'video_urls', 'audio_urls', 'content']) assert.equal(Object.hasOwn(body, forbidden), false)
  assert.deepEqual(input, before, 'building a request must not mutate the caller snapshot')
  assert.equal(JSON.stringify(built.wireSummary).includes(connection.apiKey), false)
})

test('Fast pure text omits images and the same exact protocol retains poll and result task identity', async () => {
  const built = await runtime.buildCreate({ providerDefinition: definition, connection, request: request({ images: [] }) })
  assert.equal(Object.hasOwn(JSON.parse(built.body as string), 'images'), false)
  const minimal = await runtime.buildCreate({ providerDefinition: definition, connection,
    request: { capability: 'video', model: 'seedance2.0-fast-720p', prompt: '纯文字。', duration: 4 } })
  const minimumBody = JSON.parse(minimal.body as string)
  assert.equal(minimumBody.ratio, '16:9')
  assert.equal(minimumBody.resolution, '720p')
  assert.equal(minimumBody.seconds, 4)
  const poll = await runtime.buildPoll({ providerDefinition: definition, connection, request: request(), taskId: 'task-fast-001' })
  const download = await runtime.buildResult({ providerDefinition: definition, connection, request: request(), taskId: 'task-fast-001' })
  assert.equal(poll.url, 'https://888api.xin/v1/videos/task-fast-001')
  assert.equal(download.url, 'https://888api.xin/v1/videos/task-fast-001/content')
  const pending = await runtime.parseCreate({ providerDefinition: definition, request: request(), raw: { id: 'task-fast-001', status: 'queued' } })
  assert.equal(pending.taskId, 'task-fast-001')
  assert.equal(pending.status, 'pending')
  const done = await runtime.parsePoll({ providerDefinition: definition, request: request(), taskId: 'task-fast-001',
    raw: { id: 'task-fast-001', status: 'completed', url: 'https://media.example.test/result.mp4' } })
  assert.equal(done.status, 'succeeded')
  assert.equal(done.result?.videos?.[0].url, 'https://media.example.test/result.mp4')
  const failed = await runtime.parsePoll({ providerDefinition: definition, request: request(), taskId: 'task-fast-001',
    raw: { id: 'task-fast-001', status: 'failed', error: { code: 'REFERENCE_ERROR', message: '参考图片无法读取' } } })
  assert.equal(failed.status, 'failed')
  assert.ok((failed.error || failed.message || '').includes('参考图片无法读取'))
})

test('Fast manifest rejects other models, illegal duration, too many images and unsupported reference roles', async () => {
  const invalid = [
    request({ model: 'seedance2.0-933-c5-fast' }), request({ duration: 3 }), request({ duration: 16 }), request({ duration: 4.5 }),
    request({ resolution: '1080p' }), request({ aspectRatio: '2:1' }),
    request({ images: Array.from({ length: 31 }, (_, i) => ({ url: `https://images.example.test/${i}.png`, order: i, role: 'reference_image' })) }),
    request({ images: [{ url: 'https://images.example.test/first.png', role: 'first_frame' }] }),
    request({ images: [{ url: 'https://images.example.test/last.png', role: 'last_frame' }] }),
    request({ images: [{ url: 'https://images.example.test/mask.png', role: 'mask' }] }),
    request({ videos: [{ url: 'https://media.example.test/ref.mp4', role: 'reference_video' }] }),
    request({ audios: [{ url: 'https://media.example.test/ref.mp3', role: 'reference_audio' }] }),
  ]
  for (const input of invalid) await assert.rejects(runtime.buildCreate({ providerDefinition: definition, connection, request: input }))
})

test('numbered Fast references convert outside quotes only and reject unavailable image indices', () => {
  const input = '参照@图片1人物、@图2场景与@image3道具。她说：「保留@图片9这几个字」。英文说 "@图8 is literal"。'
  const converted = normalize888Fast720References(input, 3)
  assert.match(converted, /@image1/u)
  assert.match(converted, /@image2/u)
  assert.match(converted, /@image3/u)
  assert.ok(converted.includes('她说：「保留@图片9这几个字」'))
  assert.ok(converted.includes('"@图8 is literal"'))
  assert.equal(normalize888Fast720References(converted, 3), converted, 'transport normalization must be idempotent')
  assert.equal(normalize888Fast720References('没有参考图的纯文字。', 0), '没有参考图的纯文字。')
  for (const text of ['@图片4不在本次图片里', '@图0非法', '@image31非法']) assert.throws(() => normalize888Fast720References(text, 3))
})

test('engine envelope applies Fast marker conversion only to its dedicated provider', () => {
  const record = { prompt: '保持@图片1角色外观。', model: 'seedance2.0-fast-720p', referenceImageUrls: JSON.stringify(['https://images.example.test/a.png']), duration: 12, resolution: '720p', aspectRatio: '9:16' }
  const target = engineGenerationRequest(config, record)
  assert.match(target.prompt!, /@image1/u)
  assert.deepEqual(target.images?.map(image => [image.url, image.order]), [['https://images.example.test/a.png', 0]])
  const other = engineGenerationRequest({ ...config, protocolDefinition: { ...definition, providerId: 'newapi-channel-2' } }, record)
  assert.equal(other.prompt, record.prompt)
  assert.equal(record.prompt, '保持@图片1角色外观。')
})
