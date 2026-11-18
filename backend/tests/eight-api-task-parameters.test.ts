import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

// Disposable SQLite and a fetch stub only. No real key, production DB, or network is used.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-eight-api-task-parameters-'))
process.env.SQLITE_PATH = path.join(directory, 'tasks.sqlite3')
process.env.HUOBAO_DATA_DIR = directory
process.env.STORAGE_PATH = path.join(directory, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.PUBLIC_BASE_URL = ''
const { db, schema } = await import('../src/db/index.ts')
const { default: tasks, normalizeEightApiVideoRequest } = await import('../src/routes/tasks.ts')
const nativeFetch = globalThis.fetch
const originalLog = console.log
const originalError = console.error
const output: string[] = []
console.log = (...values) => { output.push(values.join(' ')) }
console.error = (...values) => { output.push(values.join(' ')) }

const base = 'https://provider.888api.test'
const pictureA = 'https://assets.example.test/first.png'
const pictureB = 'https://assets.example.test/second.png'
const calls: Array<{ method: string; url: string }> = []
const submissions: Array<{ url: string; body: any }> = []
globalThis.fetch = (async (input, init) => {
  const url = String(input)
  const method = init?.method || 'GET'
  calls.push({ method, url })
  if (method === 'GET' && [pictureA, pictureB].includes(url)) {
    assert.equal(new Headers(init?.headers).get('authorization'), null)
    return new Response(new Uint8Array([0x89]), { status: 206, headers: { 'Content-Type': 'image/png' } })
  }
  if (method === 'POST' && url.startsWith(base + '/')) {
    assert.equal(typeof init?.body, 'string')
    submissions.push({ url, body: JSON.parse(init!.body as string) })
    // A deterministic mock failure ends the local background task without polling or downloading.
    return Response.json({ error: { message: 'local mock stop, no task was generated' } }, { status: 400 })
  }
  throw new Error('Unexpected request in offline task-parameter test')
}) as typeof fetch

after(async () => {
  globalThis.fetch = nativeFetch
  console.log = originalLog
  console.error = originalError
  ;(db as any).$client.close()
  await fs.rm(directory, { recursive: true, force: true })
})

const timestamp = new Date().toISOString()
const config = db.insert(schema.aiServiceConfigs).values({ serviceType: 'video', provider: '888api', name: 'offline C5',
  baseUrl: base, apiKey: 'offline-test-placeholder', model: '["seedance2.0-933-c5-fast"]',
  createdAt: timestamp, updatedAt: timestamp }).returning().get()
const episode = db.insert(schema.episodes).values({ dramaId: 99, episodeNumber: 1, title: 'offline test',
  videoConfigId: config.id, resolution: '480p', createdAt: timestamp, updatedAt: timestamp }).returning().get()
const boards = [1, 2].map(storyboardNumber => db.insert(schema.storyboards).values({ episodeId: episode.id,
  storyboardNumber, duration: 5, createdAt: timestamp, updatedAt: timestamp }).returning().get())
const row = (id: number) => db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()!
const taskCount = () => db.select().from(schema.sysTask).all().length
const valid = () => ({ type: 'video', config_id: config.id, model: 'seedance2.0-933-c5-fast',
  prompt: 'Keep the reference appearance and move slowly.', duration: 5, resolution: '720p' })

async function send(body: unknown) {
  return tasks.request('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}
async function waitForFailure(id: number) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (row(id).status === 'failed') return row(id)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('Offline background task did not terminate')
}

test('888API native image/ratio aliases normalize identically to canonical local task fields', () => {
  const canonical = normalizeEightApiVideoRequest({ ...valid(), aspect_ratio: '16:9', reference_image_urls: [pictureA, pictureB, pictureA] })
  const aliased = normalizeEightApiVideoRequest({ ...valid(), ratio: '16:9', images: [pictureA, pictureB, pictureA] })
  assert.deepEqual(aliased, canonical)
  assert.deepEqual(aliased.reference_image_urls, [pictureA, pictureB, pictureA])
  assert.equal('images' in aliased, false)
  assert.equal('ratio' in aliased, false)
})

test('video/audio aliases are preserved for the existing unsupported-media guard', () => {
  const normalized = normalizeEightApiVideoRequest({ ...valid(), videos: ['https://assets.example.test/ref.mp4'],
    audios: ['https://assets.example.test/ref.wav'] })
  assert.deepEqual(normalized.reference_video_urls, ['https://assets.example.test/ref.mp4'])
  assert.deepEqual(normalized.reference_audio_urls, ['https://assets.example.test/ref.wav'])
})

test('equal duplicate fields are accepted without reordering or deduplicating references', () => {
  const pictures = Object.freeze([pictureA, pictureA, pictureB])
  const normalized = normalizeEightApiVideoRequest(Object.freeze({ ...valid(), ratio: ' 16:9 ', aspect_ratio: '16:9',
    images: pictures, reference_image_urls: pictures }))
  assert.equal(normalized.aspect_ratio, '16:9')
  assert.deepEqual(normalized.reference_image_urls, pictures)
  assert.deepEqual(pictures, [pictureA, pictureA, pictureB])
})

test('different canonical and alias values produce explicit conflicts, including reference order', () => {
  for (const [canonical, alias, left, right] of [
    ['aspect_ratio', 'ratio', '16:9', '9:16'],
    ['reference_image_urls', 'images', [pictureA], [pictureB]],
    ['reference_video_urls', 'videos', ['https://a.test/a.mp4'], ['https://a.test/b.mp4']],
    ['reference_audio_urls', 'audios', ['https://a.test/a.wav'], ['https://a.test/b.wav']],
    ['reference_image_urls', 'images', [pictureA, pictureB], [pictureB, pictureA]],
  ] as const) {
    assert.throws(() => normalizeEightApiVideoRequest({ ...valid(), [canonical]: left, [alias]: right }), /参数冲突/)
  }
})

test('invalid alias values never become empty arrays or a text-only request', () => {
  for (const images of [null, pictureA, [null], [''], [1], {}]) {
    assert.throws(() => normalizeEightApiVideoRequest({ ...valid(), images }), /URL 字符串数组/)
  }
  for (const ratio of [null, 16, '', {}, []]) {
    assert.throws(() => normalizeEightApiVideoRequest({ ...valid(), ratio }), /非空字符串/)
  }
})

test('the API submits equivalent mocked JSON for aliases and canonical fields and keeps explicit 720p over an old episode setting', async () => {
  const start = submissions.length
  const canonicalResponse = await send({ ...valid(), storyboard_id: boards[0].id, aspect_ratio: '16:9',
    reference_image_urls: [pictureA, pictureB, pictureA] })
  assert.equal(canonicalResponse.status, 201)
  const canonicalId = (await canonicalResponse.json() as any).data.id
  await waitForFailure(canonicalId)
  const aliasResponse = await send({ ...valid(), storyboard_id: boards[1].id, ratio: '16:9', images: [pictureA, pictureB, pictureA] })
  assert.equal(aliasResponse.status, 201)
  const aliasId = (await aliasResponse.json() as any).data.id
  await waitForFailure(aliasId)
  assert.equal(submissions.length, start + 2)
  assert.deepEqual(submissions[start].body, submissions[start + 1].body)
  assert.equal(submissions[start].url, base + '/v1/videos')
  assert.equal(submissions[start].body.resolution, '720p')
  assert.equal(submissions[start].body.ratio, '16:9')
  assert.deepEqual(submissions[start].body.images, [pictureA, pictureB, pictureA])
  for (const id of [canonicalId, aliasId]) {
    const params = JSON.parse(row(id).params!)
    assert.equal(params.resolution, '720p')
    assert.equal(params.aspectRatio, '16:9')
    assert.deepEqual(params.referenceImageUrls, [pictureA, pictureB, pictureA])
  }
})

test('the API rejects conflicts before any task row or outbound fetch is created', async () => {
  const before = { tasks: taskCount(), calls: calls.length }
  const response = await send({ ...valid(), ratio: '9:16', aspect_ratio: '16:9', images: [pictureA] })
  assert.equal(response.status, 400)
  assert.match((await response.json() as any).message, /参数冲突/)
  assert.equal(taskCount(), before.tasks)
  assert.equal(calls.length, before.calls)
})

test('foreign documentation fields and unknown controls fail before queueing instead of silently dropping references', async () => {
  const before = { tasks: taskCount(), calls: calls.length }
  for (const key of ['seconds', 'functionMode', 'file_paths', 'referenceImages', 'image_urls', 'content',
    'image_file_1', 'video_file_2', 'audio_file_1', 'input', 'parameters', 'size',
    'generate_audio', 'watermark', 'seed', 'prompt_extend', 'misspelled_option']) {
    const response = await send({ ...valid(), images: [pictureA], [key]: 'unsupported-test-value' })
    assert.equal(response.status, 400)
    assert.ok((await response.json() as any).message.includes(key))
  }
  assert.equal(taskCount(), before.tasks)
  assert.equal(calls.length, before.calls)
})

test('invalid native reference values are rejected by the API before queueing or fetching', async () => {
  const before = { tasks: taskCount(), calls: calls.length }
  for (const images of [null, pictureA, ['']]) {
    const response = await send({ ...valid(), images })
    assert.equal(response.status, 400)
  }
  assert.equal(taskCount(), before.tasks)
  assert.equal(calls.length, before.calls)
})

test('native video/audio aliases reach the unsupported-media guard rather than becoming text-only submissions', async () => {
  const before = { tasks: taskCount(), calls: calls.length }
  for (const extra of [{ videos: ['https://assets.example.test/video.mp4'] }, { audios: ['https://assets.example.test/audio.wav'] }]) {
    const response = await send({ ...valid(), images: [pictureA], ...extra })
    assert.equal(response.status, 400)
    assert.match((await response.json() as any).message, /仅接入文字和多张参考图片/)
  }
  assert.equal(taskCount(), before.tasks)
  assert.equal(calls.length, before.calls)
})

test('non-888 providers retain the existing Wan input/media/parameters normalization', async () => {
  const wan = db.insert(schema.aiServiceConfigs).values({ serviceType: 'video', provider: 'aliyun', name: 'offline Wan',
    baseUrl: base, apiKey: 'offline-placeholder', model: '["wan3.0-video-prime"]',
    createdAt: timestamp, updatedAt: timestamp }).returning().get()
  const start = submissions.length
  const response = await send({ type: 'video', config_id: wan.id, model: 'wan3.0-video-prime',
    input: { prompt: 'offline Wan request', media: [{ type: 'reference_image', url: pictureA }] },
    parameters: { duration: 15, ratio: '16:9', resolution: '1080p', audio: false } })
  assert.equal(response.status, 201)
  await waitForFailure((await response.json() as any).data.id)
  assert.equal(submissions.length, start + 1)
  assert.deepEqual(submissions[start].body.input, { prompt: 'offline Wan request', media: [{ type: 'reference_image', url: pictureA }] })
  assert.equal(submissions[start].body.parameters.duration, 15)
  assert.equal(submissions[start].body.parameters.resolution, '1080P')
  assert.equal(submissions[start].body.parameters.audio, false)
})
