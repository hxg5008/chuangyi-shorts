import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-888api-generation-'))
process.env.SQLITE_PATH = path.join(root, 'tasks.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.FFMPEG_BIN = '/unavailable-test-ffmpeg'
process.env.FFPROBE_BIN = '/unavailable-test-ffprobe'
const { db, schema } = await import('../src/db/index.ts')
const { generateVideo, recoverVideoTask } = await import('../src/services/generation.ts')
const tasks = (await import('../src/routes/tasks.ts')).default
const { logTaskPayload, logTaskProgress } = await import('../src/utils/task-logger.ts')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
await fs.mkdir(path.join(root, 'static', 'images'), { recursive: true })
await fs.writeFile(path.join(root, 'static', 'images', 'one.png'), png)
await fs.writeFile(path.join(root, 'static', 'images', 'two.png'), png)
const movie = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)])
let submissions = 0
let queries = 0
let available = false
let form: FormData
const specialTasks = new Map<string, { id: string; httpStatus?: number; body?: unknown }>([
  ['confirmed-upstream-failure', { id: 'confirmed-failed', body: { id: 'confirmed-failed', status: 'failed', error: {
    code: 'upstream_task_failed', message: 'generation failed', cause: { code: 'reference_fetch_failed', message: 'reference fetch HTTP403 https://cdn.example.invalid/private?signature=test-only-signature' },
  } } }],
  ['query-access-401', { id: 'query-401', httpStatus: 401 }],
  ['query-access-404', { id: 'query-404', httpStatus: 404 }],
])
const cdnAuth: (string | undefined)[] = []
const contentAuth: (string | undefined)[] = []
async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${(server.address() as any).port}` }
}
const cdn = await listen((req, res) => { cdnAuth.push(req.headers.authorization); res.end(movie) })
const upstream = await listen(async (req, res) => {
  if (req.method === 'POST') {
    submissions++
    const bytes: Buffer[] = []
    for await (const chunk of req) bytes.push(Buffer.from(chunk))
    form = await new Request('http://local.test', { method: 'POST', headers: { 'content-type': req.headers['content-type']! }, body: Buffer.concat(bytes) }).formData()
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ id: specialTasks.get(String(form.get('prompt')))?.id || 'reference-task', status: 'queued' }))
    return
  }
  const special = [...specialTasks.values()].find(task => req.url === `/v1/videos/${task.id}`)
  if (special) {
    queries++
    res.setHeader('content-type', 'application/json')
    res.writeHead(special.httpStatus || 200).end(JSON.stringify(special.body || { error: { message: 'local query unavailable' } }))
    return
  }
  if (req.url === '/v1/videos/reference-task') {
    queries++
    res.end(JSON.stringify({ status: 'completed' }))
    return
  }
  contentAuth.push(req.headers.authorization)
  if (req.headers.authorization !== 'Bearer test-only-content-key') { res.writeHead(401).end(); return }
  if (!available) { res.writeHead(404).end(); return }
  if (req.url === '/v1/videos/reference-task/content') res.writeHead(302, { location: '/download-node' }).end()
  else res.writeHead(302, { location: cdn.url + '/clip' }).end()
})
const ts = new Date().toISOString()
const config = db.insert(schema.aiServiceConfigs).values({ serviceType: 'video', provider: '888api', name: 'local 888 test',
  baseUrl: upstream.url, apiKey: 'test-only-content-key', model: '["jimeng-video-seedance-2.0-fast-vip"]', createdAt: ts, updatedAt: ts }).returning().get()
const episode = db.insert(schema.episodes).values({ dramaId: 1, episodeNumber: 1, title: 'local acceptance', videoConfigId: config.id, resolution: '480p', createdAt: ts, updatedAt: ts }).returning().get()
const storyboard = db.insert(schema.storyboards).values({ episodeId: episode.id, storyboardNumber: 1, duration: 15, createdAt: ts, updatedAt: ts }).returning().get()
const row = (id: number) => db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()!
async function waitFor(id: number, status: string) {
  const end = Date.now() + 20_000
  while (Date.now() < end) {
    if (row(id).status === status) return row(id)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`Expected ${status}; actual ${row(id).status}/${row(id).errorCode}`)
}

test('canonical task keeps local reference positions and 720p, then recovers authenticated content without a second POST', async () => {
  const response = await tasks.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    type: 'video', storyboard_id: storyboard.id, model: 'jimeng-video-seedance-2.0-fast-vip', config_id: config.id,
    duration: 15, resolution: '720p', aspect_ratio: '16:9', prompt: '@图片1场景 @图片2同场景 @图片3人物 自然移动',
    reference_image_urls: ['static/images/one.png', 'static/images/one.png', 'static/images/two.png'],
  }) })
  assert.equal(response.status, 201)
  const id = (await response.json() as any).data.id
  const failed = await waitFor(id, 'failed')
  assert.equal(submissions, 1)
  assert.equal(queries, 1)
  assert.equal(form!.get('functionMode'), 'omni_reference')
  assert.equal(form!.get('duration'), '15')
  assert.equal(form!.get('resolution'), '720p')
  assert.equal(form!.get('ratio'), '16:9')
  assert.match(String(form!.get('prompt')), /@image_file_1 场景 @image_file_2 同场景 @image_file_3 人物/)
  for (let n = 1; n <= 3; n++) {
    const file = form!.get(`image_file_${n}`) as File
    assert.equal(file.type, 'image/png')
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), png)
  }
  assert.equal(failed.taskId, 'reference-task')
  assert.equal(failed.resultUrl, upstream.url + '/v1/videos/reference-task/content')
  assert.equal(failed.errorCode, 'delivery_failed')
  assert.equal(JSON.parse(failed.params!).audioControl, 'provider_default')
  assert.equal(JSON.parse(failed.params!).generateAudio, undefined)
  available = true
  await Promise.all([recoverVideoTask(id), recoverVideoTask(id)])
  const complete = await waitFor(id, 'completed')
  assert.equal(submissions, 1)
  assert.ok(contentAuth.every(value => value === 'Bearer test-only-content-key'))
  assert.deepEqual(cdnAuth, [undefined])
  assert.equal(JSON.parse(complete.params!).resultDuration, 15)
  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard.id)).get()!.videoUrl, complete.localPath)
})

test('invalid duration and missing local images never send another paid generation request', async () => {
  const before = submissions
  await assert.rejects(generateVideo({ configId: config.id, prompt: 'test', duration: 9 }), /15 秒/)
  const id = await generateVideo({ configId: config.id, prompt: '@图片1', duration: 15, referenceImageUrls: ['static/images/missing.png'] })
  const failed = await waitFor(id, 'failed')
  assert.match(failed.errorMsg!, /参考图片读取失败/)
  assert.equal(submissions, before)
})

test('unsupported explicit controls are rejected before creating a task or submitting a request', async () => {
  const before = { tasks: db.select().from(schema.sysTask).all().length, submissions }
  for (const controls of [{ generateAudio: false }, { generateAudio: true }, { seed: 0 }, { watermark: false }, { promptExtend: false }]) {
    await assert.rejects(generateVideo({ configId: config.id, prompt: 'test', duration: 15, ...controls }), /未提供|不支持|未接入/)
  }
  assert.equal(db.select().from(schema.sysTask).all().length, before.tasks)
  assert.equal(submissions, before.submissions)
})

test('expired C5 reference is persisted with safe pre-submit diagnostics and never sends a generation POST', async () => {
  const c5 = db.insert(schema.aiServiceConfigs).values({ serviceType: 'video', provider: '888api', name: 'isolated C5 expired source',
    baseUrl: upstream.url, apiKey: 'test-only-content-key', model: '["seedance2.0-933-c5-fast"]', createdAt: ts, updatedAt: ts }).returning().get()
  const timestamp = new Date(Date.now() - 60 * 60_000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  db.insert(schema.sysTask).values({ type: 'image', status: 'completed', localPath: 'static/images/one.png',
    resultUrl: `https://reference-offline.invalid/image.png?X-Amz-Date=${timestamp}&X-Amz-Expires=60&X-Amz-Signature=mock-never-real`, createdAt: ts, updatedAt: ts }).run()
  const before = { submissions, queries }
  const id = await generateVideo({ configId: c5.id, prompt: '@图1 preserve the bound reference', duration: 9, aspectRatio: '16:9', resolution: '720p', referenceImageUrls: ['static/images/one.png'] })
  const failed = await waitFor(id, 'failed')
  assert.equal(failed.errorCode, 'reference_expired')
  assert.equal(failed.taskId, null)
  assert.equal(failed.resultUrl, null)
  assert.deepEqual({ submissions, queries }, before)
  const params = JSON.parse(failed.params!)
  assert.deepEqual(params.referenceImageUrls, ['static/images/one.png'])
  assert.equal(params.duration, 9)
  assert.equal(params.referenceFailure.code, 'reference_expired')
  assert.equal(params.referenceFailure.index, 1)
  assert.equal(params.referenceFailure.host, 'reference-offline.invalid')
  assert.equal(params.referenceFailure.beforeSubmission, true)
  assert.equal(typeof params.referenceFailure.elapsedMs, 'number')
  assert.ok(Date.parse(params.referenceFailure.expiresAt) < Date.now())
  assert.doesNotMatch(JSON.stringify(params.referenceFailure), /https?:|X-Amz|mock-never-real|test-only-content-key/)
  assert.match(failed.errorMsg!, /过期/)
})

test('C5 reference transport failure keeps its cause code, reference position and existing task params without POST', async () => {
  const c5 = db.insert(schema.aiServiceConfigs).values({ serviceType: 'video', provider: '888api', name: 'isolated C5 network source',
    baseUrl: upstream.url, apiKey: 'test-only-content-key', model: '["seedance2.0-933-c5-fast"]', createdAt: ts, updatedAt: ts }).returning().get()
  db.insert(schema.sysTask).values({ type: 'image', status: 'completed', localPath: 'static/images/two.png',
    resultUrl: 'https://reference-offline.invalid/network.png?signature=mock-network-signature', createdAt: ts, updatedAt: ts }).run()
  const nativeFetch = globalThis.fetch
  let imageGetCalls = 0
  const before = submissions
  globalThis.fetch = async (input, init) => {
    const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    if (target.hostname === 'reference-offline.invalid') {
      imageGetCalls++
      assert.equal(init?.method, 'GET')
      assert.equal(new Headers(init?.headers).get('authorization'), null)
      throw new TypeError('mock request failed at signed source', { cause: Object.assign(new Error('mock socket reset'), { code: 'ECONNRESET' }) })
    }
    assert.equal(target.origin, upstream.url)
    return nativeFetch(input, init)
  }
  try {
    const id = await generateVideo({ configId: c5.id, prompt: '@图1 preserve reference', duration: 9, referenceImageUrls: ['static/images/two.png'] })
    const failed = await waitFor(id, 'failed')
    assert.equal(failed.errorCode, 'reference_network')
    assert.equal(failed.taskId, null)
    assert.equal(submissions, before)
    assert.equal(imageGetCalls, 2)
    const params = JSON.parse(failed.params!)
    assert.equal(params.referenceFailure.code, 'reference_network')
    assert.equal(params.referenceFailure.causeCode, 'ECONNRESET')
    assert.equal(params.referenceFailure.beforeSubmission, true)
    assert.equal(params.referenceFailure.index, 1)
    assert.equal(params.referenceFailure.host, 'reference-offline.invalid')
    assert.deepEqual(params.referenceImageUrls, ['static/images/two.png'])
    assert.equal(params.duration, 9)
    assert.doesNotMatch(JSON.stringify(params.referenceFailure), /signature|https?:|mock-network-signature|test-only-content-key/)
  } finally { globalThis.fetch = nativeFetch }
})

test('confirmed platform failure is distinct from query failure, keeps sanitized provider diagnostics and cannot be recovered', async () => {
  const before = submissions
  const id = await generateVideo({ configId: config.id, prompt: 'confirmed-upstream-failure', duration: 15 })
  const failed = await waitFor(id, 'failed')
  assert.equal(submissions, before + 1)
  assert.equal(failed.errorCode, 'provider_task_failed')
  assert.equal(failed.taskId, 'confirmed-failed')
  const params = JSON.parse(failed.params!)
  assert.equal(params.providerFailure.provider, '888api')
  assert.equal(params.providerFailure.taskId, 'confirmed-failed')
  assert.equal(params.providerFailure.upstreamStatus, 'failed')
  assert.equal(params.providerFailure.code, 'upstream_task_failed')
  assert.match(params.providerFailure.message, /reference fetch HTTP403/)
  assert.equal(params.lastPoll.httpStatus, 200)
  assert.equal(params.lastPoll.upstreamStatus, 'failed')
  assert.equal(params.duration, 15)
  assert.doesNotMatch(JSON.stringify(params.providerFailure), /https?:|test-only-signature|test-only-content-key/)
  await new Promise(resolve => setImmediate(resolve))
  const recovery = await recoverVideoTask(id).then(() => null, error => error)
  // If the guard regresses, drain its query before asserting so the disposable DB can close safely.
  if (!recovery) await waitFor(id, 'failed')
  assert.ok(recovery instanceof Error && /上游.*失败|无法恢复/.test(recovery.message), 'confirmed provider_task_failed must not reopen the failed task')
  assert.equal(submissions, before + 1)
})

test('query HTTP 401 and 404 preserve the original upstream task ID and stay recoverable without another POST', async () => {
  const before = submissions
  const ids = await Promise.all([401, 404].map(status => generateVideo({ configId: config.id, prompt: `query-access-${status}`, duration: 15 })))
  const failed = await Promise.all(ids.map(id => waitFor(id, 'failed')))
  assert.equal(submissions, before + 2)
  for (const [index, status] of [401, 404].entries()) {
    const record = failed[index]
    assert.equal(record.taskId, `query-${status}`)
    assert.equal(record.errorCode, status === 404 ? 'video_poll_not_found' : 'video_poll_access_failed')
    assert.match(record.errorMsg!, /生成结果待核对/)
    const params = JSON.parse(record.params!)
    assert.equal(params.lastPoll.httpStatus, status)
    assert.equal(params.lastPoll.upstreamStatus, 'query_unavailable')
    assert.equal(params.providerFailure, undefined)
    assert.equal(params.duration, 15)
  }
  await new Promise(resolve => setImmediate(resolve))
  await Promise.all(ids.map(id => recoverVideoTask(id)))
  await Promise.all(ids.map(id => waitFor(id, 'failed')))
  assert.equal(submissions, before + 2)
  assert.deepEqual(ids.map(id => row(id).taskId), ['query-401', 'query-404'])
})

test('logs redact credentials even if an upstream string echoes them', () => {
  const lines: string[] = []
  const original = console.log
  console.log = (...args) => { lines.push(args.join(' ')) }
  try {
    logTaskPayload('test', 'echo', { message: 'upstream echoed sk-test-private-key Bearer another-private-key' })
    logTaskProgress('test', 'metadata', { message: 'Bearer another-private-key sk-test-private-key' })
  } finally { console.log = original }
  assert.doesNotMatch(lines.join('\n'), /sk-test-private-key|another-private-key/)
})

test.after(async () => {
  for (const item of [upstream, cdn]) {
    item.server.closeAllConnections()
    await new Promise<void>(resolve => item.server.close(() => resolve()))
  }
  db.$client.close()
  await fs.rm(root, { recursive: true, force: true })
})
