import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import type { StoryboardCandidate, ValidationIssue } from '../src/services/storyboard-session.ts'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-agent-jobs-'))
process.env.SQLITE_PATH = path.join(temporary, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = temporary
process.env.STORAGE_PATH = path.join(temporary, 'static')
process.env.WORKSPACE_PATH = path.join(temporary, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'
await fs.cp(new URL('../workspace/', import.meta.url), process.env.WORKSPACE_PATH, { recursive: true })
const { db, schema } = await import('../src/db/index.ts')
const fixtureOwner=await (await import('./helpers/platform-fixture.ts')).platformFixtureOwner()
const { AgentJobStore } = await import('../src/services/agent-job-store.ts')
const { StoryboardDraftStore } = await import('../src/services/storyboard-draft-store.ts')
const { agentJobStore, storyboardDraftStore, agentWorkflowRuntime } = await import('../src/services/agent-jobs.ts')
const agentRoute = (await import('../src/routes/agent.ts')).default
const episodesRoute = (await import('../src/routes/episodes.ts')).default
const app = new Hono().route('/agent', agentRoute).route('/episodes', episodesRoute)
const originalExecute = agentWorkflowRuntime.execute
type Execute = typeof originalExecute
type WorkflowOptions = Parameters<Execute>[0]
const timestamps = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }

after(async () => {
  agentWorkflowRuntime.execute = originalExecute
  db.$client.close()
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(temporary).startsWith('huobao-agent-jobs-'))
  await fs.rm(temporary, { recursive: true, force: true })
})

function fixture() {
  const drama = db.insert(schema.dramas).values({ ownerUserId:fixtureOwner.id, title: 'Offline HTTP workflow', ...timestamps }).returning().get()
  // 150 counted characters => an 18-second target. This is action-only source,
  // so the fixture never invents dialogue merely to satisfy the coverage check.
  const episode = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: '离线验收', scriptContent: `动作：${'静'.repeat(148)}`, ...timestamps }).returning().get()
  const scene = db.insert(schema.scenes).values({ dramaId: drama.id, location: '院落', time: '清晨', prompt: '原有院墙与门槛', ...timestamps }).returning().get()
  const candidate = (number: number): StoryboardCandidate => ({ shot_number: number, title: `院落第${number}组`, time: '清晨', location: '@院落原门槛',
    shot_type: '空镜中景与特写', angle: '平视', movement: '固定后缓推',
    description: '【镜头1】原有门窗空镜，积水缓缓退去。【镜头2】原石阶边缘雨滴落下，原有光线连续。',
    result: '积水回落，原门窗与石阶位置不变。', atmosphere: '既有晨光照亮湿润门框。', image_prompt: '@院落原门槛与积水同框。',
    video_prompt: ['出场人物：无；场景：@院落。无背景音乐，保留原环境声。',
      '0-3秒：@院落 A0为原门槛，X向东、Y向北。门窗空镜，积水缓缓退去。',
      '3-6秒：切到@院落 原石阶特写，雨滴沿边缘落下。',
      '6-9秒：@院落 延续同一物件特写，原有晨光与石阶状态保持。'].join('\n'),
    bgm_prompt: '无背景音乐', sound_effect: '原有雨滴与环境声。', duration: 9,
    scene_id: scene.id, character_ids: [], prop_ids: [], source_ids: [1], time_row_counts: [1, 2],
  })
  const old = [1, 2].map(number => {
    const value = candidate(number)
    return db.insert(schema.storyboards).values({ episodeId: episode.id, storyboardNumber: number,
      title: value.title, time: value.time, location: value.location, shotType: value.shot_type, angle: value.angle, movement: value.movement,
      description: value.description, result: value.result, atmosphere: value.atmosphere, imagePrompt: value.image_prompt,
      videoPrompt: `old saved prompt ${number}`, bgmPrompt: value.bgm_prompt, soundEffect: value.sound_effect,
      duration: value.duration, sceneId: scene.id, composedImage: 'original-local-image', videoUrl: 'original-local-video', ...timestamps }).returning().get()
  })
  const rows = () => db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episode.id)).all().sort((a, b) => a.storyboardNumber - b.storyboardNumber)
  return { drama, episode, scene, old, candidate, rows }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function post(url: string, body: unknown) {
  return app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}
async function data(url: string) { return (await (await app.request(url)).json()).data }
async function eventually<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = read()
    if (value !== undefined) return value
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('Offline workflow did not settle')
}
const waitForJob = (id: string) => eventually(() => { const job = agentJobStore.get(id); return job && job.status !== 'running' ? job : undefined })
async function immediateResponse(request: Promise<Response>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([request, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('HTTP waited for the workflow instead of returning a job')), 1000) })]) }
  finally { if (timer) clearTimeout(timer) }
}
async function withWorkflow(execute: Execute, run: () => Promise<void>, cleanup = () => {}) {
  const pending: Array<ReturnType<Execute>> = []
  agentWorkflowRuntime.execute = ((...args: Parameters<Execute>) => {
    const task = Promise.resolve().then(() => execute(...args)); pending.push(task); return task
  }) as Execute
  try { await run() }
  finally { cleanup(); await Promise.allSettled(pending); agentWorkflowRuntime.execute = originalExecute }
}
function resultFor(options: WorkflowOptions, status: 'done' | 'needs_revision', saved: number, issues: ValidationIssue[], draftId?: string) {
  return { status, saved, issues, attempt: 0, draft_id: draftId, result: { modelCalls: 0, repairCalls: 0 }, candidateReport: options.session.getReport() }
}
const promptRequest = (f: ReturnType<typeof fixture>, ids = [f.old[0].id]) => ({ message: '生成video_prompt', drama_id: f.drama.id, episode_id: f.episode.id, storyboard_ids: ids })

test('HTTP jobs return while the workflow is pending, deduplicate clicks and never mistake old text for a new success', { concurrency: false }, async () => {
  const f = fixture(), before = f.rows(), gate = deferred(); let calls = 0
  await withWorkflow(async options => {
    calls++; await gate.promise
    const finished = await options.session.finish()
    return resultFor(options, 'needs_revision', finished.saved, finished.issues)
  }, async () => {
    const first = await immediateResponse(post('/agent/prompt_generator/jobs', promptRequest(f)))
    assert.equal(first.status, 200)
    const id = (await first.json()).data.job_id
    await eventually(() => calls === 1 ? true : undefined)
    const second = await post('/agent/prompt_generator/jobs', promptRequest(f))
    const duplicate = (await second.json()).data
    assert.equal(duplicate.job_id, id)
    assert.equal(duplicate.already_running, true)
    assert.equal(calls, 1)
    const conflict = await post('/agent/storyboard_breaker/jobs', { ...promptRequest(f), storyboard_ids: undefined })
    assert.equal(conflict.status, 409)
    assert.equal((await data(`/agent/jobs/${id}`)).status, 'running')
    assert.equal((await data(`/agent/jobs?episode_id=${f.episode.id}`)).length, 1)
    gate.resolve()
    const job = await waitForJob(id)
    assert.equal(job.status, 'needs_revision')
    assert.ok(job.issues.some(issue => issue.code === 'no_candidates'))
    assert.equal(calls, 1)
    assert.deepEqual(f.rows(), before)
  }, gate.resolve)
})

test('workflow progress and a needs-revision draft persist through HTTP without replacing the live storyboards', { concurrency: false }, async () => {
  const f = fixture(), before = f.rows(), gate = deferred(); let draftId = ''
  await withWorkflow(async (options, { store }) => {
    const started = store.startOrResume({ episodeId: f.episode.id, dramaId: f.drama.id, mode: 'breakdown', scope: [], fingerprint: 'offline-http-draft' })
    draftId = started.draft.id
    try {
      const good = f.candidate(1), bad = { ...f.candidate(2), sound_effect: '' }
      store.savePlan(draftId, { raw: { marker: 'private-plan-raw-marker' }, data: { groups: [1, 2].map(number => ({ number, source_ids: [1], duration: 9, shot_count: 2 })) }, issues: [] }, started.leaseToken)
      store.saveGroup(draftId, { number: 1, status: 'ready', candidate: { raw: { marker: 'private-raw-draft-marker' }, data: good }, issues: [], attempts: 1 }, started.leaseToken)
      store.saveGroup(draftId, { number: 2, status: 'generating', candidate: null, issues: [], attempts: 1 }, started.leaseToken)
      options.onState?.('generating', 0)
      options.onProgress?.({ draft_id: draftId, total: 2, completed: 1, failed: 0, current_group: 2 })
      await gate.promise
      const staged = options.session.stageSave([good, bad], { replaceExisting: true, isFinalBatch: true })
      assert.ok(staged.issues.some(issue => issue.code === 'skill_field_missing' && issue.field === 'sound_effect'))
      store.saveGroup(draftId, { number: 2, status: 'needs_revision', candidate: { raw: bad, data: bad }, issues: staged.issues, attempts: 1 }, started.leaseToken)
      store.setStatus(draftId, 'needs_revision', started.leaseToken)
      options.onState?.('validating', 0)
      options.onProgress?.({ draft_id: draftId, total: 2, completed: 1, failed: 1, current_group: 2 })
      const finished = await options.session.finish()
      assert.equal(finished.saved, 0)
      return resultFor(options, 'needs_revision', finished.saved, finished.issues, draftId)
    } finally { store.release(draftId, started.leaseToken) }
  }, async () => {
    const response = await immediateResponse(post('/agent/storyboard_breaker/jobs', { message: '拆解完整剧本', drama_id: f.drama.id, episode_id: f.episode.id }))
    const id = (await response.json()).data.job_id
    await eventually(() => draftId ? true : undefined)
    const running = await data(`/agent/jobs/${id}`)
    assert.deepEqual([running.status, running.total, running.completed, running.failed, running.draft_id, running.current_group], ['running', 2, 1, 0, draftId, 2])
    const preview = await data(`/episodes/${f.episode.id}/storyboard-draft`)
    assert.equal(preview.id, draftId); assert.equal(preview.status, 'generating')
    assert.deepEqual([preview.total, preview.readyCount, preview.needsRevisionCount], [2, 1, 0])
    assert.deepEqual(preview.groups[0].candidate, f.candidate(1))
    assert.equal(JSON.stringify(preview).includes('private-raw-draft-marker'), false)
    assert.equal(JSON.stringify(preview).includes('private-plan-raw-marker'), false)
    assert.deepEqual(f.rows(), before)
    gate.resolve()
    const job = await waitForJob(id)
    assert.deepEqual([job.status, job.total, job.completed, job.failed, job.draft_id, job.current_group], ['needs_revision', 2, 1, 1, draftId, 2])
    assert.ok(job.issues.some(issue => issue.code === 'skill_field_missing' && issue.field === 'sound_effect' && issue.shot_number === 2))
    const finalDraft = await data(`/episodes/${f.episode.id}/storyboard-draft`)
    assert.deepEqual([finalDraft.status, finalDraft.readyCount, finalDraft.needsRevisionCount], ['needs_revision', 1, 1])
    assert.equal(finalDraft.groups[1].candidate.sound_effect, '')
    assert.deepEqual(f.rows(), before)
  }, gate.resolve)
})

test('an explicit prompt batch runs once, replaces only target video_prompt and rejects concurrent cross-scope requests', { concurrency: false }, async () => {
  const f = fixture(), before = f.rows(), gate = deferred(); let calls = 0
  await withWorkflow(async (options, { store }) => {
    calls++
    assert.equal(options.mode, 'prompt')
    assert.deepEqual(options.storyboardIds, [f.old[0].id])
    await gate.promise
    const started = store.startOrResume({ episodeId: f.episode.id, dramaId: f.drama.id, mode: 'prompt', scope: options.storyboardIds!, fingerprint: 'offline-prompt-target' })
    try {
      const staged = options.session.stageUpdate(f.old[0].id, { video_prompt: f.candidate(1).video_prompt, time_row_counts: [1, 2] })
      assert.equal('error' in staged, false, JSON.stringify(staged.issues))
      store.saveGroup(started.draft.id, { number: 1, status: 'ready', candidate: { data: options.session.getReport().candidates[0] }, issues: [], attempts: 1 }, started.leaseToken)
      options.onProgress?.({ draft_id: started.draft.id, total: 1, completed: 1, failed: 0, current_group: 1 })
      store.setStatus(started.draft.id, 'ready', started.leaseToken)
      const finished = await options.session.finish()
      assert.equal(finished.saved, 1, 'The HTTP mock uses the real skill-content session rather than manufacturing business success')
      store.setStatus(started.draft.id, 'committed', started.leaseToken)
      return resultFor(options, 'done', finished.saved, finished.issues, started.draft.id)
    } finally { store.release(started.draft.id, started.leaseToken) }
  }, async () => {
    const [first, second] = await Promise.all([post(`/episodes/${f.episode.id}/generate-video-prompts`, { storyboard_ids: [f.old[0].id] }), post(`/episodes/${f.episode.id}/generate-video-prompts`, { storyboard_ids: [f.old[0].id] })])
    assert.equal(first.status, 200); assert.equal(second.status, 200)
    const starts = [(await first.json()).data, (await second.json()).data]
    assert.equal(new Set(starts.map(start => start.job_id)).size, 1)
    assert.equal(starts.filter(start => start.already_running === true).length, 1)
    const id = starts[0].job_id
    await eventually(() => calls === 1 ? true : undefined)
    assert.equal((await post(`/episodes/${f.episode.id}/generate-video-prompts`, { storyboard_ids: [f.old[1].id] })).status, 409)
    assert.equal((await post('/agent/prompt_generator/jobs', promptRequest(f))).status, 409)
    assert.equal((await post('/agent/storyboard_breaker/jobs', { ...promptRequest(f), storyboard_ids: undefined })).status, 409)
    assert.deepEqual(f.rows(), before)
    gate.resolve()
    const job = await waitForJob(id)
    assert.deepEqual([job.status, job.total, job.completed, job.failed, calls], ['done', 1, 1, 0, 1], JSON.stringify(job.issues))
    assert.ok(job.draft_id)
    const after = f.rows(), { videoPrompt: _beforePrompt, updatedAt: _beforeTime, ...beforeTarget } = before[0]
    const { videoPrompt: _afterPrompt, updatedAt: _afterTime, ...afterTarget } = after[0]
    assert.equal(after[0].videoPrompt, f.candidate(1).video_prompt)
    assert.deepEqual(afterTarget, beforeTarget)
    assert.deepEqual(after[1], before[1])
    const status = await data(`/episodes/${f.episode.id}/video-prompts-status`)
    assert.deepEqual([status.id, status.status, status.completed, status.failed], [id, 'done', 1, 0])
    assert.equal((await data(`/episodes/${f.episode.id}/storyboard-draft?mode=prompt`)).status, 'committed')
  }, gate.resolve)
})

test('restart recovery preserves ready draft progress, never auto-generates and cannot be overwritten by late job callbacks', { concurrency: false }, async () => {
  const f = fixture(), before = f.rows(), gate = deferred(); let calls = 0, draftId = ''
  await withWorkflow(async (options, { store }) => {
    calls++
    const started = store.startOrResume({ episodeId: f.episode.id, dramaId: f.drama.id, mode: 'breakdown', scope: [], fingerprint: 'offline-restart' })
    draftId = started.draft.id
    try {
      store.saveGroup(draftId, { number: 1, status: 'ready', candidate: { data: f.candidate(1) }, issues: [], attempts: 1 }, started.leaseToken)
      options.onProgress?.({ draft_id: draftId, total: 2, completed: 1, failed: 0, current_group: 2 })
      await gate.promise
      options.onProgress?.({ draft_id: draftId, total: 2, completed: 2, failed: 0, current_group: 2 })
      const finished = await options.session.finish()
      return resultFor(options, 'needs_revision', finished.saved, finished.issues, draftId)
    } finally { store.release(draftId, started.leaseToken) }
  }, async () => {
    const response = await post('/agent/storyboard_breaker/jobs', { message: '拆解整集', drama_id: f.drama.id, episode_id: f.episode.id })
    const id = (await response.json()).data.job_id
    await eventually(() => draftId ? true : undefined)
    const restartedJobs = new AgentJobStore(db.$client), restartedDrafts = new StoryboardDraftStore(db.$client)
    assert.equal(restartedJobs.recoverInterrupted(), 1)
    assert.equal(restartedDrafts.recoverInterrupted(), 1)
    const terminal = restartedJobs.get(id)!
    assert.equal(terminal.status, 'error')
    assert.ok(terminal.finished_at)
    assert.equal(restartedJobs.recoverInterrupted(), 0)
    assert.equal(calls, 1)
    const draft = await data(`/episodes/${f.episode.id}/storyboard-draft`)
    assert.equal(draft.status, 'interrupted')
    assert.equal(draft.readyCount, 1)
    assert.deepEqual(draft.groups[0].candidate, f.candidate(1))
    assert.equal((await data(`/agent/jobs/${id}`)).status, 'error')
    assert.equal((await data(`/agent/jobs?episode_id=${f.episode.id}`))[0].id, id)
    gate.resolve()
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(agentJobStore.get(id), terminal)
    assert.equal(calls, 1, 'Neither recovery nor read-only status endpoints submit a workflow')
    assert.deepEqual(f.rows(), before)
  }, gate.resolve)
})

test('invalid or missing explicit targets fail preflight without executing a workflow', { concurrency: false }, async () => {
  const f = fixture(), foreign = fixture(), before = f.rows(); let calls = 0
  await withWorkflow(async () => { calls++; throw new Error('Preflight must reject before workflow execution') }, async () => {
    const body = { message: '生成video_prompt', drama_id: f.drama.id, episode_id: f.episode.id }
    for (const request of [post('/agent/prompt_generator/jobs', body), post('/agent/prompt_generator/chat', body),
      post('/agent/prompt_generator/jobs', { ...body, storyboard_ids: [0] }),
      post(`/episodes/${f.episode.id}/generate-video-prompts`, { storyboard_ids: ['bad'] }),
      post(`/episodes/${f.episode.id}/generate-video-prompts`, { storyboard_ids: [] }),
      post(`/episodes/${f.episode.id}/generate-video-prompts`, { storyboard_ids: [foreign.old[0].id] }),
      post(`/episodes/${f.episode.id}/generate-video-prompts`, { storyboard_ids: [999999] })]) assert.equal((await request).status, 400)
    assert.equal(agentJobStore.list(f.episode.id).length, 0, 'Batch preflight cannot leave a worker for an unknown target')
    const response = await post('/agent/prompt_generator/jobs', { ...body, storyboard_ids: [999999] })
    assert.equal(response.status, 200, 'The single-job API records its asynchronous target-preflight failure')
    const job = await waitForJob((await response.json()).data.job_id)
    assert.equal(job.status, 'error')
    assert.match(job.error || '', /分镜不存在/)
    assert.equal(calls, 0)
    assert.deepEqual(f.rows(), before)
  })
})

test('a workflow provider failure retains HTTP status and phase without fallback, repair or live writes', { concurrency: false }, async () => {
  const f = fixture(), before = f.rows(); let calls = 0
  await withWorkflow(async options => {
    calls++; options.onState?.('generating', 0)
    throw Object.assign(new Error('Gateway Timeout'), { statusCode: 504, responseHeaders: { 'x-request-id': 'offline-request-id' } })
  }, async () => {
    const response = await post('/agent/prompt_generator/jobs', promptRequest(f))
    const job = await waitForJob((await response.json()).data.job_id)
    assert.deepEqual([job.status, job.provider_http_status, job.provider_request_id, job.failure_phase, job.error_code, job.attempt, calls], ['error', 504, 'offline-request-id', 'generating', 'upstream_http_504', 0, 1])
    assert.match(job.error || '', /HTTP 504/)
    assert.deepEqual(f.rows(), before)
  })
})

test('job and draft read endpoints validate identity and do not create work', { concurrency: false }, async () => {
  const f = fixture(); let calls = 0
  await withWorkflow(async () => { calls++; throw new Error('Reads cannot execute a workflow') }, async () => {
    assert.deepEqual(await data(`/agent/jobs?episode_id=${f.episode.id}`), [])
    assert.equal(await data(`/episodes/${f.episode.id}/storyboard-draft`), null)
    assert.equal((await app.request('/agent/jobs?episode_id=bad')).status, 400)
    assert.equal((await app.request('/agent/jobs/not-a-job')).status, 404)
    assert.equal((await app.request(`/episodes/${f.episode.id}/storyboard-draft?mode=invalid`)).status, 400)
    assert.equal((await app.request('/episodes/999999/storyboard-draft')).status, 404)
    assert.equal(calls, 0)
  })
})

// Round 3 R2 (2026-11-08): the job continues the same draft by itself (what 继续生成 does), at most 2 extra rounds,
// and only while each round finishes more groups.
function roundWorkflow(f: ReturnType<typeof fixture>, readyAfter: number[], seen: { calls: number; drafts: Set<string> }): Execute {
  return async (options, { store }) => {
    const round = seen.calls++
    const started = store.startOrResume({ episodeId: f.episode.id, dramaId: f.drama.id, mode: 'breakdown', scope: [], fingerprint: 'offline-continue' })
    seen.drafts.add(started.draft.id)
    try {
      const ready = readyAfter[Math.min(round, readyAfter.length - 1)]
      for (let number = 1; number <= 3; number++) store.saveGroup(started.draft.id, { number, status: number <= ready ? 'ready' : 'needs_revision',
        candidate: { data: f.candidate(number) }, issues: [], attempts: round + 1 }, started.leaseToken)
      options.onProgress?.({ draft_id: started.draft.id, total: 3, completed: ready, failed: 3 - ready })
      store.setStatus(started.draft.id, ready === 3 ? 'ready' : 'needs_revision', started.leaseToken)
      return { ...resultFor(options, ready === 3 ? 'done' : 'needs_revision', 0, [], started.draft.id), result: { modelCalls: 2, repairCalls: 1, requestStats: [{ stage: 'expand' }, { stage: 'expand' }] } }
    } finally { store.release(started.draft.id, started.leaseToken) }
  }
}

test('R2: an unfinished breakdown continues the same draft automatically, and the job reports the totals of all rounds', { concurrency: false }, async () => {
  const f = fixture(), seen = { calls: 0, drafts: new Set<string>() }
  await withWorkflow(roundWorkflow(f, [1, 2, 3], seen), async () => {
    const response = await post('/agent/storyboard_breaker/jobs', { message: '拆解整集', drama_id: f.drama.id, episode_id: f.episode.id })
    const job = await waitForJob((await response.json()).data.job_id)
    assert.equal(job.status, 'done', 'finished without a second click')
    assert.equal(seen.calls, 3, 'first round plus two automatic rounds')
    assert.equal(seen.drafts.size, 1, 'every round resumed the same draft')
    assert.deepEqual([job.model_calls, job.repair_calls, (job.request_stats || []).length], [6, 3, 6])
  })
})

test('R2: no automatic round after a round without progress, and never more than two extra rounds', { concurrency: false }, async () => {
  const stuck = fixture(), stuckSeen = { calls: 0, drafts: new Set<string>() }
  await withWorkflow(roundWorkflow(stuck, [1, 1], stuckSeen), async () => {
    const response = await post('/agent/storyboard_breaker/jobs', { message: '拆解整集', drama_id: stuck.drama.id, episode_id: stuck.episode.id })
    const job = await waitForJob((await response.json()).data.job_id)
    assert.equal(job.status, 'needs_revision')
    assert.equal(stuckSeen.calls, 2, 'one automatic round, which made no progress, then the job stops for the user')
  })
  const slow = fixture(), slowSeen = { calls: 0, drafts: new Set<string>() }
  await withWorkflow(roundWorkflow(slow, [0, 1, 2, 3], slowSeen), async () => {
    const response = await post('/agent/storyboard_breaker/jobs', { message: '拆解整集', drama_id: slow.drama.id, episode_id: slow.episode.id })
    const job = await waitForJob((await response.json()).data.job_id)
    assert.equal(job.status, 'needs_revision')
    assert.equal(slowSeen.calls, 3, 'at most two automatic rounds even while progressing')
  })
})

test('R2: a video-prompt job is not continued automatically', { concurrency: false }, async () => {
  const f = fixture(); let calls = 0
  await withWorkflow(async options => {
    calls++
    const finished = await options.session.finish()
    return resultFor(options, 'needs_revision', finished.saved, finished.issues)
  }, async () => {
    const job = await waitForJob((await (await post('/agent/prompt_generator/jobs', promptRequest(f))).json()).data.job_id)
    assert.equal(job.status, 'needs_revision')
    assert.equal(calls, 1)
  })
})
