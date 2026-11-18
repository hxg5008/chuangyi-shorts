import { after, afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { GenerationRequest } from '../src/services/provider-runtime/types.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-888-fast720-upload-'))
process.env.HUOBAO_DATA_DIR = root
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.HUOBAO_PROXY_URL = 'direct'
const { prepare888Fast720Images } = await import('../src/services/adapters/888-fast720-upload.ts')
const { ProtocolEngineVideoAdapter } = await import('../src/services/adapters/protocol-engine-adapter.ts')
const { shutdownProviderEngine } = await import('../src/services/provider-runtime/index.ts')
const { currentRequestLogContext, withRequestLogContext } = await import('../src/services/request-logs/context.ts')
const { db } = await import('../src/db/index.ts')
const security = await import('../src/services/platform-security/index.ts')
const manifest = JSON.parse(await fs.readFile(new URL('../src/services/model-channels/bundled/888-seedance-fast720-local.json', import.meta.url), 'utf8'))
const originalFetch = globalThis.fetch
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6lrkAAAAASUVORK5CYII=', 'base64')
const source = `data:image/png;base64,${png.toString('base64')}`
const connection = {
  baseUrl: 'https://888api.example.test/some/api/v1',
  apiKey: 'synthetic-fallback-key',
  authFields: { apiKey: 'synthetic-auth-fields-key' },
  headers: { Authorization: 'Bearer synthetic-wrong-header-key', 'Content-Type': 'multipart/form-data', 'X-Custom': 'test' },
}
const uploadedURL = (index = 1) => `https://888api.example.test/creative/api/reference/${index}-${'a'.repeat(64)}-${'b'.repeat(48)}.png`
const request = (overrides: Partial<GenerationRequest> = {}): GenerationRequest => ({
  capability: 'video', model: 'seedance2.0-fast-720p', prompt: '参照 @image1 保持人物外观。',
  duration: 4, aspectRatio: '16:9', resolution: '720p', operation: 'reference_to_video',
  images: [{ dataUrl: source, kind: 'image', role: 'reference_image', order: 0, id: 'image-1' }],
  ...overrides,
})
function mockFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response) {
  globalThis.fetch = handler as typeof fetch
}
function failOnNetwork() {
  let calls = 0
  mockFetch(() => { calls++; throw new Error('Unexpected network request') })
  return () => calls
}

afterEach(() => { globalThis.fetch = originalFetch })
after(async () => {
  globalThis.fetch = originalFetch
  shutdownProviderEngine()
  db.$client.close()
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
  assert.ok(path.basename(root).startsWith('huobao-888-fast720-upload-'))
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 })
})

test('upload uses exact raw PNG bytes, root endpoint, real MIME, prioritized auth and upload log context', async () => {
  let calls = 0
  mockFetch((input, init) => {
    calls++
    assert.equal(String(input), 'https://888api.example.test/creative/api/reference')
    assert.equal(init?.method, 'POST')
    assert.equal(init?.redirect, 'error')
    assert.ok(init?.signal)
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('Content-Type'), 'image/png')
    assert.equal(headers.get('Authorization'), 'Bearer synthetic-auth-fields-key')
    assert.equal(headers.get('X-Custom'), 'test')
    assert.ok(init?.body instanceof Uint8Array)
    assert.equal(init?.body instanceof FormData, false)
    assert.deepEqual(Buffer.from(init!.body as Uint8Array), png)
    assert.deepEqual(currentRequestLogContext(), { taskId: 'synthetic-task', actorUserId: 12, phase: 'upload' })
    return Response.json({ url: uploadedURL() })
  })
  const input = request({ images: [{ dataUrl: source, mimeType: 'image/jpeg', kind: 'image', role: 'reference_image', order: 2, id: 'kept', metadata: { assetId: 7 } }] })
  const before = structuredClone(input)
  const result = await withRequestLogContext({ taskId: 'synthetic-task', actorUserId: 12, phase: 'generate' }, async () => {
    const prepared = await prepare888Fast720Images(input, connection)
    assert.equal(currentRequestLogContext()?.phase, 'generate', 'upload phase must not leak to the caller')
    return prepared
  })
  assert.equal(calls, 1)
  assert.deepEqual(input, before)
  assert.notEqual(result, input)
  assert.equal(result.images?.[0].url, uploadedURL())
  assert.equal(result.images?.[0].mimeType, 'image/png')
  assert.equal(result.images?.[0].dataUrl, undefined)
  assert.equal(result.images?.[0].order, 2)
  assert.deepEqual(result.images?.[0].metadata, { assetId: 7 })
  assert.equal(currentRequestLogContext(), null)
})

test('deduplicates only within one request while preserving duplicate slots, source order and independent calls', async () => {
  let calls = 0
  const otherSource = `data:image/png;base64,${Buffer.concat([png, Buffer.from([0])]).toString('base64')}`
  mockFetch((input, init) => {
    assert.equal(String(input), 'https://888api.example.test/creative/api/reference')
    assert.equal(init?.method, 'POST')
    return Response.json({ url: uploadedURL(++calls) })
  })
  const input = request({ images: [
    { dataUrl: source, order: 2, id: 'first-slot' },
    { dataUrl: otherSource, order: 0, id: 'second-slot' },
    { dataUrl: source, order: 1, id: 'third-slot' },
  ] })
  const before = structuredClone(input)
  const first = await prepare888Fast720Images(input, connection)
  assert.equal(calls, 2)
  assert.deepEqual(first.images?.map(ref => [ref.id, ref.order, ref.url]), [
    ['first-slot', 2, uploadedURL(1)], ['second-slot', 0, uploadedURL(2)], ['third-slot', 1, uploadedURL(1)],
  ])
  const second = await prepare888Fast720Images(input, connection)
  assert.equal(calls, 4, 'a new request must upload anew, not reuse another user/request receipt')
  assert.equal(second.images?.[0].url, uploadedURL(3))
  assert.deepEqual(input, before)
})

test('pure text returns a separate unchanged request without any upload', async () => {
  const calls = failOnNetwork()
  const input = request({ images: [], operation: 'text_to_video' })
  const result = await prepare888Fast720Images(input, connection)
  assert.deepEqual(result, input)
  assert.notEqual(result, input)
  assert.equal(calls(), 0)
})

test('rejects foreign origins and malformed uploaded URLs without a video POST', async () => {
  const invalid = [
    uploadedURL().replace('888api.example.test', 'other.example.test'),
    uploadedURL().replace('https://', 'http://'),
    uploadedURL().replace('.test/', '.test:8443/'),
    uploadedURL().replace('/creative/api/reference/', '/v1/videos/'),
    uploadedURL() + '?token=synthetic-sensitive-token', uploadedURL() + '#fragment',
    uploadedURL().replace('https://', 'https://username:password@'),
    uploadedURL().replace('.png', '.gif'), '/creative/api/reference/relative.png',
    'not-a-url', undefined,
  ]
  for (const url of invalid) {
    let calls = 0
    mockFetch((input) => {
      calls++
      assert.equal(String(input), 'https://888api.example.test/creative/api/reference')
      return Response.json({ url })
    })
    await assert.rejects(prepare888Fast720Images(request(), connection), (error: any) => {
      assert.equal(error.code, 'reference_upload_failed')
      assert.equal(error.submissionUnknown, false)
      assert.equal(error.message.includes('synthetic-sensitive-token'), false)
      assert.equal(error.message.includes('username'), false)
      return true
    })
    assert.equal(calls, 1)
  }
})

test('HTTP upload failures expose only safe status, never retry, and never submit generation', async () => {
  for (const status of [400, 401, 503]) {
    let calls = 0
    mockFetch((input) => {
      calls++
      assert.equal(String(input), 'https://888api.example.test/creative/api/reference')
      return new Response('synthetic-secret-response-token', { status })
    })
    await assert.rejects(prepare888Fast720Images(request(), connection), (error: any) => {
      assert.equal(error.statusCode, status)
      assert.equal(error.providerHttpStatus, status)
      assert.equal(error.submissionUnknown, false)
      assert.equal(error.isRetryable, false)
      assert.match(error.message, new RegExp(`HTTP ${status}`))
      assert.equal(error.message.includes('synthetic-secret-response-token'), false)
      return true
    })
    assert.equal(calls, 1)
  }
})

test('network and malformed JSON upload failures remain safe and do not retry', async () => {
  for (const mode of ['network', 'json', 'oversized-response']) {
    let calls = 0
    mockFetch(() => {
      calls++
      if (mode === 'network') throw new Error('https://secret-url.example/synthetic-secret-token')
      return new Response(mode === 'json' ? 'invalid-json synthetic-secret-token' : 'x'.repeat(65537), { status: 200 })
    })
    await assert.rejects(prepare888Fast720Images(request(), connection), (error: any) => {
      assert.equal(error.code, 'reference_upload_failed')
      assert.equal(error.message.includes('synthetic-secret-token'), false)
      assert.equal(error.submissionUnknown, false)
      return true
    })
    assert.equal(calls, 1)
  }
})

test('invalid reference count, media kind, frame role and operation reject before any network or generation', async () => {
  const calls = failOnNetwork()
  const cases: Partial<GenerationRequest>[] = [
    { images: Array.from({ length: 31 }, () => ({ dataUrl: source })) },
    { videos: [{ url: 'https://never-fetch.example/video.mp4' }] },
    { audios: [{ url: 'https://never-fetch.example/audio.mp3' }] },
    { inputs: [{ dataUrl: source }] },
    { operation: 'first_last_frame_to_video' },
    { images: [{ dataUrl: source, role: 'first_frame' }] },
    { images: [{ dataUrl: source, role: 'last_frame' }] },
    { images: [{ dataUrl: source, role: 'mask' }] },
    { images: [{ dataUrl: source, kind: 'video' }] },
    { images: [{ kind: 'image' }] },
  ]
  for (const overrides of cases) await assert.rejects(prepare888Fast720Images(request(overrides), connection))
  assert.equal(calls(), 0)
})

test('actual non-image bytes and images above 30 MiB reject without trusting declared MIME or uploading', async () => {
  const calls = failOnNetwork()
  const fakePNG = `data:image/png;base64,${Buffer.from('this is text, not an image').toString('base64')}`
  await assert.rejects(prepare888Fast720Images(request({ images: [{ dataUrl: fakePNG, mimeType: 'image/png' }] }), connection), /PNG、JPEG 或 WEBP/u)
  const oversized = Buffer.alloc(30 * 1024 * 1024 + 1)
  png.copy(oversized)
  const tooLarge = `data:image/png;base64,${oversized.toString('base64')}`
  await assert.rejects(prepare888Fast720Images(request({ images: [{ dataUrl: tooLarge }] }), connection), /30 MiB/u)
  assert.equal(calls(), 0)
})

test('video adapter preflights the real Fast manifest before uploads and builds ordered uploaded references', async () => {
  const config = {
    id: 1, serviceType: 'video', provider: 'yingce', model: 'seedance2.0-fast-720p',
    ...connection, protocolId: 'engine.888-seedance-fast720-local',
    protocolDefinition: { engine: 'yingce-v2', providerId: '888-seedance-fast720-local', manifest },
    parameters: [], defaults: {},
  } as any
  const adapter = new ProtocolEngineVideoAdapter(config)
  const otherSource = `data:image/png;base64,${Buffer.concat([png, Buffer.from([7])]).toString('base64')}`
  const record = {
    prompt: '参考@图片1人物、@图2场景和@image3道具。她说：「@图片99 保留对白」。',
    model: 'seedance2.0-fast-720p', duration: 12, resolution: '720p', aspectRatio: '9:16',
    referenceImageUrls: JSON.stringify([source, otherSource, source]),
  } as any
  const before = structuredClone(record)
  let calls = 0
  mockFetch((input, init) => {
    calls++
    assert.equal(String(input), 'https://888api.example.test/creative/api/reference', 'building the adapter must only send upload requests')
    assert.equal(init?.method, 'POST')
    assert.equal(new Headers(init?.headers).get('Content-Type'), 'image/png')
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic-auth-fields-key')
    assert.ok(init?.body instanceof Uint8Array)
    assert.deepEqual(Buffer.from(init!.body as Uint8Array), calls === 1 ? png : Buffer.concat([png, Buffer.from([7])]))
    assert.equal(currentRequestLogContext()?.phase, 'upload')
    return Response.json({ url: uploadedURL(calls) })
  })
  const built = await adapter.buildGenerateRequest(config, record)
  assert.equal(calls, 2)
  assert.equal(built.url, 'https://888api.example.test/v1/videos')
  assert.equal(built.method, 'POST')
  const body = JSON.parse(built.body as string)
  assert.deepEqual(body.images, [uploadedURL(1), uploadedURL(2), uploadedURL(1)])
  assert.equal(body.prompt, '参考@image1 人物、@image2 场景和@image3 道具。她说：「@图片99 保留对白」。')
  assert.equal(body.seconds, 12)
  assert.equal(body.ratio, '9:16')
  assert.equal(body.model, 'seedance2.0-fast-720p')
  assert.deepEqual(record, before)
  const invalidRecords = [
    { ...record, duration: 3 }, { ...record, duration: 16 }, { ...record, duration: 4.5 },
    { ...record, resolution: '1080p' }, { ...record, model: 'seedance2.0-933-c5-fast' },
    { ...record, referenceImageUrls: JSON.stringify(Array.from({ length: 31 }, () => source)) },
    { ...record, firstFrameUrl: source },
  ]
  for (const invalid of invalidRecords) await assert.rejects(adapter.buildGenerateRequest(config, invalid))
  assert.equal(calls, 2, 'all invalid controls must fail before any additional upload or generation POST')
})

test('non-admin adapter uploads owned local references without rechecking new hosted URLs as foreign assets', async () => {
  security.initPlatformSecurity()
  const owner = security.createUser('fast_upload_owner', 'Synthetic-upload-password').user
  const other = security.createUser('fast_upload_other', 'Synthetic-other-password').user
  const relative = 'static/uploads/fast-owner.png'
  await fs.mkdir(path.join(root, 'static', 'uploads'), { recursive: true })
  await fs.writeFile(path.join(root, relative), png)
  security.runAsActor(owner, () => security.registerPrivateMedia(relative))
  // The new provider-hosted URL intentionally has no local resource ownership.
  assert.throws(() => security.runAsActor(owner, () => security.assertMediaAccess(uploadedURL())), /素材不存在或无访问权限/u)
  const config = {
    id: 2, serviceType: 'video', provider: 'yingce', model: 'seedance2.0-fast-720p',
    ...connection, protocolId: 'engine.888-seedance-fast720-local',
    protocolDefinition: { engine: 'yingce-v2', providerId: '888-seedance-fast720-local', manifest },
    parameters: [], defaults: {},
  } as any
  const record = {
    prompt: '保持@图片1人物与@图2服装。', model: config.model, duration: 4, resolution: '720p', aspectRatio: '16:9',
    referenceImageUrls: JSON.stringify([relative, relative]),
  } as any
  let uploads = 0
  mockFetch((url, init) => {
    uploads++
    assert.equal(String(url), 'https://888api.example.test/creative/api/reference')
    assert.equal(init?.method, 'POST', 'local references must be read from disk, not downloaded over HTTP')
    assert.equal(security.currentActor()?.id, owner.id)
    assert.deepEqual(Buffer.from(init?.body as Uint8Array), png)
    return Response.json({ url: uploadedURL() })
  })
  const adapter = new ProtocolEngineVideoAdapter(config)
  const built = await security.runAsActor(owner, () => adapter.buildGenerateRequest(config, record))
  assert.deepEqual(JSON.parse(built.body as string).images, [uploadedURL(), uploadedURL()])
  assert.equal(uploads, 1)
  await assert.rejects(security.runAsActor(other, () => adapter.buildGenerateRequest(config, record)), /参考图读取失败/u)
  assert.equal(uploads, 1, 'a foreign user must be rejected before provider upload')
  assert.equal(record.referenceImageUrls, JSON.stringify([relative, relative]))
})
