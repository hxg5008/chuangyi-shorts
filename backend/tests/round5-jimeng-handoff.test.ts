// Round 5 (2026-11-09, user-approved): Jimeng hand-off ("accepted + card named = done"), 回传视频 (manual and automatic),
// the longer submit wait with by-request lookups, and the force-new guard. All against an isolated fake local service;
// nothing here can reach a real Jimeng account.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chuangyi-round5-'))
process.env.SQLITE_PATH = path.join(root, 'db.sqlite3'); process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static'); process.env.MYSQL_AUTO_IMPORT = 'false'; process.env.HUOBAO_PROXY_URL = 'direct'
process.env.FFMPEG_BIN = '/unavailable-test-ffmpeg'
process.env.HUOBAO_JIMENG_AUTO_RETURN_MINUTES = '0'
const { db, schema } = await import('../src/db/index.ts')
const { generateVideo, recoverVideoTask, resumeInterruptedTasks, isTaskActive, returnJimengTasks, returnJimengEpisode } = await import('../src/services/generation.ts')
const { setJimengTimings } = await import('../src/services/jimeng-local-task.ts')
const { jimengCanvasVideoId } = await import('../src/services/jimeng-local-delivery.ts')
const { sweepHandedOffJimengVideos, autoReturnMinutes } = await import('../src/services/jimeng-return.ts')
const tasks = (await import('../src/routes/tasks.ts')).default
const episodes = (await import('../src/routes/episodes.ts')).default
setJimengTimings({ lookupDelaysMs: [0, 30, 30, 30], pollMs: 20, queuedPollMs: 20, namingGraceMs: 60_000 })

const ts = new Date().toISOString()
const ACCOUNT = 'acc_test', CANVAS = '24283744771340'
const video = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(64, 7)])
const image = await sharp({ create: { width: 4, height: 3, channels: 4, background: '#765432' } }).png().toBuffer()
const data = 'data:image/png;base64,' + image.toString('base64')

/** The fake service: a job store (by id), the canvas library (by cv id) and counters. */
interface Job { id: string; client: string; status: string; stage: string; submit?: string; name_status: string; title?: string; error?: string; error_code?: string; saved?: boolean; prompt_sha256: string; reference_count: number; unknown?: boolean }
const jobs = new Map<string, Job>(), library = new Map<string, any>()
const counters = { posts: 0, lookups: 0, refreshes: 0, downloads: [] as string[], content: [] as string[], lists: 0 }
let postDelayMs = 0, storeAfterMs = 0, lookupStatus = 0, libraryRefreshing = false, lastRefreshed = 0
let nextName = 'completed', nextStatus = 'processing', nextSubmit = true
let refuseContent = new Set<string>()
const publicJob = (job: Job) => ({ id: job.id, status: job.status, stage: job.stage, prompt_sha256: job.prompt_sha256, reference_count: job.reference_count,
  upstream_task_id: job.submit ?? null, account_id: ACCOUNT, canvas_id: CANVAS, title: job.title ?? null, name_status: job.name_status,
  error: job.error ?? null, error_code: job.error_code ?? null, unknown: job.unknown === true,
  delivery_mode: 'local_manual', download_ready: job.status === 'completed', has_local_file: !!job.saved })
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const part of req) body += part
  res.setHeader('Content-Type', 'application/json')
  if (req.headers.authorization !== 'Bearer round5-key') { res.writeHead(401).end('{}'); return }
  const url = new URL(req.url!, 'http://fake')
  if (url.pathname === '/v1/videos' && req.method === 'POST') {
    counters.posts++
    const payload = JSON.parse(body)
    const job: Job = { id: 'jm_' + randomUUID().replaceAll('-', ''), client: payload.client_request_id, status: nextStatus, stage: nextStatus === 'queued' ? 'queued' : 'awaiting_result',
      submit: nextSubmit ? 'sub-' + randomUUID().slice(0, 8) : undefined, name_status: nextName, title: '1-01', prompt_sha256: payload.prompt_sha256, reference_count: payload.images.length }
    const store = () => jobs.set(job.id, job)
    if (storeAfterMs) setTimeout(store, storeAfterMs); else store()
    if (postDelayMs) await new Promise(resolve => setTimeout(resolve, postDelayMs))
    if (res.destroyed) return
    res.writeHead(202).end(JSON.stringify(publicJob(job))); return
  }
  if (url.pathname === '/v1/videos' && req.method === 'GET') { counters.lists++; res.end(JSON.stringify({ data: [...jobs.values()].map(publicJob), total: jobs.size })); return }
  if (url.pathname.startsWith('/v1/videos/by-request/')) {
    counters.lookups++
    if (lookupStatus) { res.writeHead(lookupStatus).end('{}'); return }
    const job = [...jobs.values()].find(item => item.client === url.pathname.split('/').at(-1))
    res.writeHead(job ? 200 : 404).end(JSON.stringify(job ? publicJob(job) : {})); return
  }
  if (url.pathname === '/v1/downloads' && req.method === 'POST') {
    const ids = JSON.parse(body).ids as string[]; counters.downloads.push(...ids)
    for (const id of ids) { const job = jobs.get(id); if (job) job.saved = true; const item = library.get(id); if (item) item.has_local_file = true }
    res.writeHead(202).end(JSON.stringify({ accepted: ids, skipped: [] })); return
  }
  if (url.pathname === '/v1/canvas-library' && req.method === 'GET') {
    res.end(JSON.stringify({ data: [...library.values()], refreshing: libraryRefreshing, last_refreshed: lastRefreshed })); return
  }
  if (url.pathname === '/v1/canvas-library/refresh' && req.method === 'POST') {
    counters.refreshes++; lastRefreshed = Date.now() / 1000
    res.writeHead(202).end(JSON.stringify({ refreshing: true, generation_submitted: false })); return
  }
  const canvasItem = /^\/v1\/canvas-library\/(cv_[a-f0-9]{32})(\/content)?$/u.exec(url.pathname)
  if (canvasItem) {
    const item = library.get(canvasItem[1])
    if (!item) { res.writeHead(404).end('{}'); return }
    if (canvasItem[2]) { counters.content.push(canvasItem[1]); if (!item.has_local_file) { res.writeHead(409).end('{}'); return } res.setHeader('Content-Type', 'video/mp4'); res.end(video); return }
    res.end(JSON.stringify(item)); return
  }
  const jobPath = /^\/v1\/videos\/(jm_[A-Za-z0-9]+)(\/content)?$/u.exec(url.pathname)
  if (jobPath) {
    const job = jobs.get(jobPath[1])
    if (!job) { res.writeHead(404).end('{}'); return }
    if (jobPath[2]) { counters.content.push(job.id); if (!job.saved || refuseContent.has(job.id)) { res.writeHead(409).end('{}'); return } res.setHeader('Content-Type', 'video/mp4'); res.end(video); return }
    res.end(JSON.stringify(publicJob(job))); return
  }
  res.writeHead(404).end('{}')
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as any).port}`
const cfg = db.insert(schema.aiServiceConfigs).values({ serviceType: 'video', provider: 'jimeng_local', name: 'round5', baseUrl: base, apiKey: 'round5-key', model: '["jimeng-2.0-fast"]', createdAt: ts, updatedAt: ts }).returning().get()
const row = (id: number) => db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()!
const params = (id: number) => JSON.parse(row(id).params || '{}')
async function settled(id: number) { for (let i = 0; i < 1500; i++) { const r = row(id); if (r.status !== 'processing' && !isTaskActive(id)) return r; await new Promise(r => setTimeout(r, 10)) } assert.fail('task did not settle') }
function shot(n = 1) {
  const drama = db.insert(schema.dramas).values({ title: 'round5', createdAt: ts, updatedAt: ts }).returning().get()
  const episode = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: n, title: 'e', createdAt: ts, updatedAt: ts }).returning().get()
  const storyboard = db.insert(schema.storyboards).values({ episodeId: episode.id, storyboardNumber: 1, videoUrl: 'static/old.mp4', createdAt: ts, updatedAt: ts }).returning().get()
  return { drama, episode, storyboard }
}
const request = { prompt: '@母亲站A处，@卧室内转身。', configId: cfg.id, duration: 5, aspectRatio: '16:9', referenceImageUrls: [data, data], referenceImageNames: ['母亲', '卧室'] }
const jobOf = (id: number) => jobs.get(row(id).taskId!)!
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); (db as any).$client.close(); await fs.rm(root, { recursive: true, force: true }) })

test('accepted + card named = handed off: the platform stops polling, keeps the receipt and the old shot video', async () => {
  const { drama, storyboard } = shot()
  const id = await generateVideo({ ...request, storyboardId: storyboard.id, dramaId: drama.id }), done = await settled(id)
  assert.equal(done.status, 'completed'); assert.equal(done.stage, 'handed_off'); assert.equal(done.localPath, null)
  const handoff = params(id).jimengHandoff
  assert.equal(handoff.submitId, jobOf(id).submit); assert.equal(handoff.accountId, ACCOUNT); assert.equal(handoff.canvasId, CANVAS); assert.equal(handoff.title, '1-01')
  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard.id)).get()!.videoUrl, 'static/old.mp4')
  assert.equal(counters.posts, 1)
})

test('accepted but the card is still being named → keeps waiting; hands off once naming settles (failed naming also counts)', async () => {
  nextName = 'pending'
  const id = await generateVideo(request)
  for (let i = 0; i < 50 && !params(id).jimengAcceptedSeenAt; i++) await new Promise(r => setTimeout(r, 10))
  assert.equal(row(id).status, 'processing'); assert.ok(params(id).jimengAcceptedSeenAt)
  jobOf(id).name_status = 'failed'
  const done = await settled(id)
  assert.equal(done.stage, 'handed_off'); assert.equal(params(id).jimengHandoff.nameStatus, 'failed')
  nextName = 'completed'
})

test('a job without a Jimeng receipt yet (still in the service queue) is not handed off', async () => {
  nextSubmit = false; nextStatus = 'queued'
  const id = await generateVideo(request)
  await new Promise(r => setTimeout(r, 120))
  assert.equal(row(id).status, 'processing'); assert.notEqual(row(id).stage, 'handed_off')
  const job = jobOf(id); job.submit = 'sub-late'; job.status = 'processing'; job.stage = 'awaiting_result'
  assert.equal((await settled(id)).stage, 'handed_off')
  nextSubmit = true; nextStatus = 'processing'
})

test('a finished job is still fetched at once (round-3 automatic delivery is unchanged)', async () => {
  nextStatus = 'completed'
  const { drama, storyboard } = shot()
  const id = await generateVideo({ ...request, storyboardId: storyboard.id, dramaId: drama.id })
  // the fake reports completed immediately; the platform saves the original file and writes the shot.
  const done = await settled(id)
  assert.equal(done.stage, 'completed'); assert.ok(done.localPath)
  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard.id)).get()!.videoUrl, done.localPath)
  nextStatus = 'processing'
})

test('回传 (job finished in the service): saves the original file to the shot; never posts a generation', async () => {
  const { drama, storyboard } = shot()
  const id = await generateVideo({ ...request, storyboardId: storyboard.id, dramaId: drama.id }); await settled(id)
  const before = counters.posts
  jobOf(id).status = 'completed'; jobOf(id).stage = 'ready_for_download'
  const [result] = await returnJimengTasks([id], { wait: true })
  assert.equal(result.outcome, 'returned', result.message)
  const done = row(id)
  assert.equal(done.stage, 'completed'); assert.ok(done.localPath)
  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard.id)).get()!.videoUrl, done.localPath)
  assert.equal(counters.posts, before, '回传 never submits')
  assert.ok(counters.downloads.includes(done.taskId!))
})

test('回传 (only the canvas shows the finished video): refreshes the canvas, saves the cv entry and fetches it', async () => {
  const { drama, storyboard } = shot()
  const id = await generateVideo({ ...request, storyboardId: storyboard.id, dramaId: drama.id }); await settled(id)
  const cv = jimengCanvasVideoId(ACCOUNT, CANVAS, jobOf(id).submit!)
  assert.match(cv, /^cv_[a-f0-9]{32}$/u)
  assert.equal(cv, 'cv_' + sha(`${ACCOUNT}\0${CANVAS}\0${jobOf(id).submit}`).slice(0, 32), 'same formula as the service')
  library.set(cv, { id: cv, status: 'completed', download_ready: true, has_local_file: false, title: '1-01' })
  lastRefreshed = 0
  const refreshes = counters.refreshes, before = counters.posts
  const [result] = await returnJimengTasks([id], { wait: true })
  assert.equal(result.outcome, 'returned', result.message)
  assert.equal(counters.refreshes, refreshes + 1, 'an old canvas cache is refreshed once')
  assert.ok(counters.downloads.includes(cv)); assert.ok(counters.content.includes(cv))
  assert.equal(row(id).stage, 'completed'); assert.equal(counters.posts, before)
  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard.id)).get()!.videoUrl, row(id).localPath)
})

test('回传 when nothing is finished: nothing changes and the check is noted; a recent canvas cache is not refreshed again', async () => {
  const id = await generateVideo(request); await settled(id)
  lastRefreshed = Date.now() / 1000
  const refreshes = counters.refreshes
  const [result] = await returnJimengTasks([id], { wait: true })
  assert.equal(result.outcome, 'not_ready'); assert.equal(row(id).stage, 'handed_off')
  assert.equal(params(id).jimengReturn.result, 'not_ready'); assert.equal(counters.refreshes, refreshes)
})

test('回传 reports a failure shown by the service or the canvas, and marks the task failed with the reason', async () => {
  const a = await generateVideo(request); await settled(a)
  Object.assign(jobOf(a), { status: 'failed', stage: 'upstream_failed', error_code: 'content_policy_violation', error: '内容审核未通过' })
  const b = await generateVideo(request); await settled(b)
  const cv = jimengCanvasVideoId(ACCOUNT, CANVAS, jobOf(b).submit!)
  library.set(cv, { id: cv, status: 'failed', download_ready: false, error: '即梦生成失败：参考图问题', error_code: 'upstream_failed' })
  const results = await returnJimengTasks([a, b], { wait: true })
  assert.deepEqual(results.map(r => r.outcome), ['failed', 'failed'])
  assert.equal(row(a).status, 'failed'); assert.equal(row(a).errorCode, 'generation_failed'); assert.match(row(a).errorMsg!, /内容审核/)
  assert.equal(row(b).status, 'failed'); assert.match(row(b).errorMsg!, /参考图问题/)
})

test('a newer video task on the same shot is never overwritten by 回传 of the older one', async () => {
  const { drama, storyboard } = shot()
  const older = await generateVideo({ ...request, storyboardId: storyboard.id, dramaId: drama.id }); await settled(older)
  const newer = await generateVideo({ ...request, storyboardId: storyboard.id, dramaId: drama.id, forceNew: true }); await settled(newer)
  jobOf(older).status = 'completed'
  const [result] = await returnJimengTasks([older], { wait: true })
  assert.equal(result.outcome, 'returned')
  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard.id)).get()!.videoUrl, 'static/old.mp4', 'the shot keeps waiting for its newest task')
})

test('a failed download keeps the task handed off so it can be returned again', async () => {
  const id = await generateVideo(request); await settled(id)
  jobOf(id).status = 'completed'
  refuseContent.add(row(id).taskId!)
  const [result] = await returnJimengTasks([id], { wait: true })
  assert.notEqual(result.outcome, 'returned')
  assert.equal(row(id).status, 'completed'); assert.equal(row(id).stage, 'handed_off'); assert.ok(params(id).jimengReturn.lastError)
  refuseContent = new Set()
  const [retry] = await returnJimengTasks([id], { wait: true })
  assert.equal(retry.outcome, 'returned', retry.message)
})

test('episode 回传 takes only the newest task per shot; the automatic sweep returns finished ones', async () => {
  const { drama, episode, storyboard } = shot()
  const second = db.insert(schema.storyboards).values({ episodeId: episode.id, storyboardNumber: 2, createdAt: ts, updatedAt: ts }).returning().get()
  const a = await generateVideo({ ...request, storyboardId: storyboard.id, dramaId: drama.id }); await settled(a)
  const b = await generateVideo({ ...request, storyboardId: second.id, dramaId: drama.id }); await settled(b)
  jobOf(b).status = 'completed'
  const results = await returnJimengEpisode(episode.id, { wait: true })
  assert.deepEqual(results.map(r => [r.id, r.outcome]), [[a, 'not_ready'], [b, 'returned']])
  jobOf(a).status = 'completed'
  const { getConfigById } = await import('../src/services/ai.ts')
  const swept = await sweepHandedOffJimengVideos({ resolveConfig: async () => (await getConfigById(cfg.id))! })
  assert.ok(swept.some(r => r.id === a && r.outcome === 'returned'), JSON.stringify(swept))
  assert.equal(row(a).stage, 'completed')
  assert.equal(autoReturnMinutes(), 0, 'HUOBAO_JIMENG_AUTO_RETURN_MINUTES=0 turns the timer off')
})

test('the HTTP routes: shot and episode 回传, and a handed-off shot needs force_new to generate again', async () => {
  const { drama, episode, storyboard } = shot()
  const id = await generateVideo({ ...request, storyboardId: storyboard.id, dramaId: drama.id }); await settled(id)
  const one = await (await tasks.request(`/${id}/jimeng-return`, { method: 'POST' })).json() as any
  assert.equal(one.data.outcome, 'not_ready')
  const all = await (await episodes.request(`/${episode.id}/jimeng-return`, { method: 'POST' })).json() as any
  assert.equal(all.data.total, 1); assert.equal(all.data.not_ready, 1)
  await assert.rejects(generateVideo({ ...request, storyboardId: storyboard.id, dramaId: drama.id }), /已交即梦/)
  const before = counters.posts
  const again = await generateVideo({ ...request, storyboardId: storyboard.id, dramaId: drama.id, forceNew: true }); await settled(again)
  assert.equal(counters.posts, before + 1, 'a confirmed regeneration submits exactly once')
})

test('submit answer slower than the wait: looked up by the request id, never sent twice', async () => {
  setJimengTimings({ submitTimeoutMs: 80 }); postDelayMs = 400
  const before = counters.posts
  const id = await generateVideo(request), done = await settled(id)
  postDelayMs = 0; setJimengTimings({ submitTimeoutMs: 120_000 })
  assert.equal(counters.posts, before + 1); assert.equal(done.stage, 'handed_off')
  assert.ok(counters.lookups >= 1)
})

test('submit answer lost and the record appears late: later lookups find it (no false 待核对)', async () => {
  setJimengTimings({ submitTimeoutMs: 60 }); postDelayMs = 300; storeAfterMs = 80
  const before = counters.posts, lookups = counters.lookups
  const id = await generateVideo(request), done = await settled(id)
  postDelayMs = 0; storeAfterMs = 0; setJimengTimings({ submitTimeoutMs: 120_000 })
  assert.equal(counters.posts, before + 1); assert.equal(done.stage, 'handed_off'); assert.ok(counters.lookups - lookups >= 2)
})

test('never stored: all lookups miss → 待核对 with the original request id kept; a refused key says so', async () => {
  setJimengTimings({ submitTimeoutMs: 60 }); postDelayMs = 300; storeAfterMs = 10_000
  const id = await generateVideo(request), done = await settled(id)
  assert.equal(done.status, 'failed'); assert.equal(done.errorCode, 'submission_unknown'); assert.match(done.errorMsg!, /待核对/)
  assert.ok(params(id).idempotencyKey)
  lookupStatus = 401
  const r = db.insert(schema.sysTask).values({ type: 'video', provider: 'jimeng_local', configId: cfg.id, configBaseUrl: base, prompt: 'x', model: 'jimeng-2.0-fast', status: 'failed', errorCode: 'submission_unknown',
    params: JSON.stringify({ idempotencyKey: randomUUID(), referenceImageUrls: [] }), createdAt: ts, updatedAt: ts }).returning().get()
  await recoverVideoTask(r.id); const refused = await settled(r.id)
  assert.equal(refused.errorCode, 'submission_unknown'); assert.match(refused.errorMsg!, /拒绝了访问 Key/)
  lookupStatus = 0; postDelayMs = 0; storeAfterMs = 0; setJimengTimings({ submitTimeoutMs: 120_000 })
})

test('a handed-off task is not "running": restart recovery leaves it alone and does not poll it', async () => {
  const id = await generateVideo(request); await settled(id)
  const lists = counters.lists, posts = counters.posts
  await resumeInterruptedTasks()
  assert.equal(row(id).stage, 'handed_off'); assert.equal(counters.posts, posts); assert.equal(counters.lists, lists)
})
