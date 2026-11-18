import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { eq } from 'drizzle-orm'
import { TaskQueue } from '../src/services/task-queue.ts'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-image-queue-'))
process.env.SQLITE_PATH = path.join(root, 'tasks.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.HUOBAO_PROXY_URL = 'direct'
// Old deployments may still carry this variable; it must no longer throttle generation requests.
process.env.HUOBAO_IMAGE_CONCURRENCY = '2'
const { db, schema } = await import('../src/db/index.ts')
const { generateImage, recoverImageTask } = await import('../src/services/generation.ts')
const tasksRoute = (await import('../src/routes/tasks.ts')).default
const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)
let submissions = 0
let downloads = 0
let liveDownloads = 0
let maxLiveDownloads = 0
let failureStatus: number | null = null
let failureBody: unknown = null
let submissionGate: http.ServerResponse[] | null = null
const generationRequests: {
  path: string
  authorization: string | undefined
  model: string
  prompt: string
  size: string
  references: Buffer[]
}[] = []
const pending: { res: http.ServerResponse; offset: number }[] = []
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST') {
    submissions++
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const bytes = Buffer.concat(chunks)
    if (req.headers['content-type']?.startsWith('multipart/form-data')) {
      const form = await new Response(bytes, {
        headers: { 'Content-Type': req.headers['content-type'] }
      }).formData()
      const refs = await Promise.all(
        form.getAll('image[]').map(async (file) => Buffer.from(await (file as File).arrayBuffer()))
      )
      generationRequests.push({
        path: req.url!,
        authorization: req.headers.authorization,
        model: String(form.get('model')),
        prompt: String(form.get('prompt')),
        size: String(form.get('size')),
        references: refs
      })
    } else {
      const body = JSON.parse(bytes.toString())
      generationRequests.push({
        path: req.url!,
        authorization: req.headers.authorization,
        model: body.model,
        prompt: body.prompt,
        size: body.size,
        references: []
      })
    }
    res.setHeader('Content-Type', 'application/json')
    if (failureStatus !== null) {
      res.writeHead(failureStatus).end(JSON.stringify(failureBody))
      return
    }
    if (submissionGate) {
      submissionGate.push(res)
      return
    }
    res.end(JSON.stringify({ data: [{ url: base + '/image.png' }] }))
    return
  }
  downloads++
  liveDownloads++
  maxLiveDownloads = Math.max(maxLiveDownloads, liveDownloads)
  res.on('finish', () => {
    liveDownloads--
  })
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': image.length })
  res.write(image.subarray(0, 8))
  pending.push({ res, offset: 8 })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as any).port}`
const ts = new Date().toISOString()
const config = db
  .insert(schema.aiServiceConfigs)
  .values({
    serviceType: 'image',
    provider: 'openai',
    name: 'local test',
    baseUrl: base,
    apiKey: 'test-only',
    model: '["gpt-image-2"]',
    createdAt: ts,
    updatedAt: ts
  })
  .returning()
  .get()
const row = (id: number) => db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()!
async function waitUntil(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(message)
}
function finishOne() {
  const item = pending.shift()!
  item.res.end(image.subarray(item.offset))
}

test('more than four synchronous image generations submit together while downloads and recovery retain a separate two-slot limit', async () => {
  const prompt = '中文@人物 · 🌙\n原始最终提示词、空格和换行完整。'
  const refs = [image, Buffer.concat([image, Buffer.from('second-reference')])]
  submissionGate = []
  const ids = await Promise.all(
    [0, 1, 2, 3, 4, 5].map((i) =>
      generateImage({
        prompt,
        size: '1024x1024',
        configId: config.id,
        referenceImages:
          i % 2 ? refs.map((ref) => `data:image/png;base64,${ref.toString('base64')}`) : undefined
      })
    )
  )
  await waitUntil(
    () => submissionGate!.length === 6,
    'All six requests must reach the provider before any synchronous response is released'
  )
  assert.equal(submissions, 6)
  assert.equal(downloads, 0)
  assert.equal(generationRequests.length, 6)
  assert.equal(generationRequests.filter((req) => req.path === '/v1/images/generations').length, 3)
  assert.equal(generationRequests.filter((req) => req.path === '/v1/images/edits').length, 3)
  for (const request of generationRequests) {
    assert.equal(request.authorization, 'Bearer test-only')
    assert.equal(request.model, 'gpt-image-2')
    // Native multipart serializes text line endings as CRLF; it preserves the actual prompt lines.
    assert.equal(request.prompt.replace(/\r\n/gu, '\n'), prompt)
    assert.equal(request.size, '1024x1024')
    if (request.references.length)
      assert.deepEqual(
        request.references,
        refs,
        'Distinct references must retain their input order and bytes'
      )
  }
  const gated = submissionGate
  submissionGate = null
  for (const response of gated) response.end(JSON.stringify({ data: [{ url: base + '/image.png' }] }))
  await waitUntil(
    () => pending.length === 2 && ids.every((id) => row(id).resultUrl),
    'Generated results should persist independently of waiting downloads'
  )
  const recovery = db
    .insert(schema.sysTask)
    .values({ type: 'image', resultUrl: base + '/image.png', status: 'failed', createdAt: ts, updatedAt: ts })
    .returning()
    .get()
  await Promise.all([recoverImageTask(recovery.id), recoverImageTask(recovery.id)])
  await waitUntil(() => pending.length === 2, 'First two image downloads did not start')
  assert.equal(submissions, 6)
  assert.equal(row(ids[2]).stage, 'downloading')
  assert.equal(row(recovery.id).stage, 'downloading')
  assert.equal((await tasksRoute.request(`/${ids[2]}`, { method: 'DELETE' })).status, 400)
  assert.equal((await tasksRoute.request(`/${recovery.id}`, { method: 'DELETE' })).status, 400)
  await recoverImageTask(recovery.id)

  // Progress must become observable before the body is complete, while the queue slot is held.
  await new Promise((resolve) => setTimeout(resolve, 1_100))
  const first = pending[0]
  first.res.write(image.subarray(first.offset, first.offset + 8))
  first.offset += 8
  await waitUntil(
    () => ids.some((id) => JSON.parse(row(id).params!).downloadProgress?.receivedBytes > 0),
    'Download byte progress was not persisted'
  )
  const progressId = ids.find((id) => JSON.parse(row(id).params!).downloadProgress?.receivedBytes > 0)!
  const progress = JSON.parse(row(progressId).params!).downloadProgress
  assert.equal(progress.totalBytes, image.length)
  assert.equal(progress.attempt, 1)
  assert.ok(progress.updatedAt)
  assert.doesNotMatch(JSON.stringify(progress), /https?:|signature|test-only/)
  assert.equal(submissions, 6)

  for (let i = 0; i < 7; i++) {
    await waitUntil(() => pending.length > 0, 'A waiting image download did not acquire a released slot')
    finishOne()
  }
  await waitUntil(
    () => [...ids, recovery.id].every((id) => row(id).status === 'completed'),
    'Image queue did not finish'
  )
  assert.equal(maxLiveDownloads, 2)
  assert.equal(downloads, 7)
  assert.equal(submissions, 6, 'Delivery recovery must not repeat a generation POST')
  assert.ok([...ids, recovery.id].every((id) => row(id).stage === 'completed'))
})

test('HTTP policy rejection is a generation rejection with safe diagnostics and no POST retry', async () => {
  failureStatus = 400
  failureBody = {
    error: {
      code: 'upstream_policy_refusal_text',
      message: 'content policy rejection sk-test-only https://example.invalid?signature=test'
    }
  }
  const before = submissions
  const id = await generateImage({ prompt: 'local rejection test', configId: config.id })
  await waitUntil(() => row(id).status === 'failed', 'Rejected generation did not fail')
  assert.equal(submissions, before + 1)
  assert.equal(row(id).errorCode, 'generation_rejected')
  assert.equal(row(id).resultUrl, null)
  assert.match(row(id).errorMsg!, /模型平台拒绝.*HTTP 400/)
  assert.doesNotMatch(row(id).errorMsg!, /sk-test-only|https?:|signature|local rejection test/)
})

test('provider parameter, authentication, limit, availability and format errors keep distinct codes', async () => {
  for (const [status, body, code] of [
    [
      400,
      { error: { message: 'invalid size' }, prompt: 'content policy terms in echoed user input' },
      'generation_invalid_request'
    ],
    [401, { error: { message: 'invalid key' } }, 'generation_auth_failed'],
    [429, { error: { message: 'too many requests' } }, 'generation_rate_limited'],
    [503, { error: { message: 'policy service unavailable' } }, 'generation_provider_error'],
    [200, { data: [] }, 'generation_invalid_response']
  ] as const) {
    failureStatus = status
    failureBody = body
    const before = submissions
    const id = await generateImage({ prompt: 'local error classification', configId: config.id })
    await waitUntil(() => row(id).status === 'failed', 'Provider failure did not settle')
    assert.equal(row(id).errorCode, code)
    assert.equal(submissions, before + 1)
  }
})

test('a rejected queued job releases its slot and never runs twice', async () => {
  const queue = new TaskQueue(1)
  const calls: number[] = []
  const results = await Promise.allSettled([
    queue.run(async () => {
      calls.push(1)
      throw new Error('expected')
    }),
    queue.run(async () => {
      calls.push(2)
      return 2
    })
  ])
  assert.deepEqual(calls, [1, 2])
  assert.equal(results[0].status, 'rejected')
  assert.deepEqual(results[1], { status: 'fulfilled', value: 2 })
})

test('concurrent recovery and deletion cannot both claim an unfinished image task', async () => {
  const task = db
    .insert(schema.sysTask)
    .values({ type: 'image', resultUrl: base + '/image.png', status: 'failed', createdAt: ts, updatedAt: ts })
    .returning()
    .get()
  const [recovered, deleted] = await Promise.all([
    tasksRoute.request(`/${task.id}/recover`, { method: 'POST' }),
    tasksRoute.request(`/${task.id}`, { method: 'DELETE' })
  ])
  if (recovered.status === 200) {
    assert.equal(deleted.status, 400)
    await waitUntil(() => pending.length === 1, 'Recovered image did not start downloading')
    finishOne()
    await waitUntil(() => row(task.id).status === 'completed', 'Recovered image did not complete')
  } else {
    assert.equal(recovered.status, 400)
    assert.equal(deleted.status, 200)
    assert.equal(row(task.id), undefined)
  }
})

test.after(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  db.$client.close()
  await fs.rm(root, { recursive: true, force: true })
})
