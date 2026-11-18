import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as vue from 'vue'
import ts from 'typescript'

const compiled = ts.transpileModule(readFileSync(new URL('../app/composables/useAgent.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const settle = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const job = (extra = {}) => ({ id: 8, episode_id: 2, agent_type: 'prompt_generator', scope: 'agent', storyboard_ids: [11], status: 'running', phase: 'generating', issues: [], ...extra })

function harness({ get = async () => job(), post = async () => ({ job_id: 8 }) } = {}) {
  const notices = [], requests = [], timers = new Map()
  let timerId = 0
  const route = vue.ref('1:1')
  const exports = {}
  runInNewContext(compiled, {
    exports,
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id },
    clearTimeout(id) { timers.delete(id) },
    require(name) {
      if (name === 'vue') return vue
      if (name === 'vue-sonner') return { toast: Object.fromEntries(['success', 'warning'].map(kind => [kind, message => notices.push([kind, message])])) }
      if (name === './useApi') return { api: {
        get: async path => { requests.push(['get', path]); return get(path) },
        post: async (path, body) => { requests.push(['post', path, body]); return post(path, body) },
      } }
      if (name === './useToast') return { toastError: error => notices.push(['error', String(error)]) }
      if (name === './i18n') return { i18n: { global: { t: key => key } } }
      throw new Error(name)
    },
  })
  const scope = vue.effectScope()
  const agent = scope.run(() => exports.useAgent({ getIdentity: () => route.value }))
  return { agent, notices, requests, timers, route, dispose: () => scope.stop(), async tick() {
    const pending = [...timers.values()]; timers.clear()
    for (const callback of pending) callback()
    await settle()
  } }
}

test('durable text jobs keep busy through generating, validating, repairing and final refresh', async t => {
  let state = job()
  const refresh = deferred()
  const h = harness({ get: async () => ({ ...state }) })
  t.after(h.dispose)
  let done = 0
  const result = h.agent.runJob('prompt_generator', 'test', 1, 2, { storyboardIds: [11], onSettled: () => refresh.promise, onDone: () => { done++ } }, 'text-model', 3)
  await settle()
  assert.equal(h.agent.running.value, true)
  assert.deepEqual([...h.requests[0][2].storyboard_ids], [11])
  assert.equal(h.requests[0][1], '/agent/prompt_generator/jobs')
  for (const phase of ['validating', 'repairing']) {
    state = job({ phase })
    await h.tick()
    assert.equal(h.agent.phase.value, phase)
    assert.equal(h.agent.running.value, true)
  }
  state = job({ status: 'done', phase: 'done' })
  await h.tick()
  assert.equal(h.agent.running.value, true)
  assert.equal(done, 0)
  assert.deepEqual(h.notices, [])
  refresh.resolve()
  assert.equal((await result).status, 'done')
  assert.equal(done, 1)
  assert.equal(h.agent.running.value, false)
  assert.equal(h.notices[0][0], 'success')
  assert.equal(h.timers.size, 0)
})

test('needs_revision refreshes partial results and reports the concrete issue without success', async t => {
  const h = harness({ get: async () => job({ status: 'needs_revision', phase: 'needs_revision', issues: [{ code: 'coordinates', message: '缺少空间原点', storyboard_id: 11 }] }) })
  t.after(h.dispose)
  let refreshed = 0, done = 0
  await h.agent.runJob('prompt_generator', 'test', 1, 2, { onSettled: () => { refreshed++ }, onDone: () => { done++ } })
  assert.equal(refreshed, 1)
  assert.equal(done, 0)
  assert.match(h.notices[0][1], /缺少空间原点/)
  assert.equal(h.notices[0][0], 'warning')
  assert.equal(h.agent.running.value, false)
  assert.equal(h.agent.lastResult.value.status, 'needs_revision')
})

test('resume only observes the current episode agent scope and never submits a generation', async t => {
  const h = harness({ get: async path => path.includes('?') ? [job({ phase: 'validating' }), job({ id: 9, scope: 'video_prompt_batch' }), job({ id: 10, episode_id: 3 })] : job({ phase: 'validating' }) })
  t.after(h.dispose)
  await h.agent.resume(2)
  await settle()
  assert.equal(h.agent.phase.value, 'validating')
  assert.deepEqual([...h.agent.activeJobs.value].map(item => item.id), [8])
  assert.ok(h.requests.every(([method]) => method === 'get'))
  const duplicate = h.agent.wait(8)
  assert.equal(h.requests.filter(([, path]) => path === '/agent/jobs/8').length, 1)
  h.dispose()
  assert.equal(await duplicate, undefined)
  assert.equal(h.timers.size, 0)
})

test('read-only reconciliation replaces an obsolete failure with a newer terminal result and refreshes it once without notifications or generation', async t => {
  const old = job({ id: 'old', status: 'needs_revision', phase: 'needs_revision', started_at: '2026-11-04T09:17:00Z', finished_at: '2026-11-04T09:18:00Z', issues: [{ code: 'capacity', message: 'old capacity failure' }] })
  const latest = job({ id: 'new', status: 'done', phase: 'done', started_at: '2026-11-04T09:37:00Z', finished_at: '2026-11-04T09:50:00Z' })
  let state = [old], refreshed = 0, followUp = 0
  const h = harness({ get: async () => state })
  t.after(h.dispose)
  await h.agent.resume(2)
  assert.equal(h.agent.lastResult.value.id, 'old')
  state = [latest, old]
  const options = { onSettled: () => { refreshed++ }, onDone: () => { followUp++ } }
  await h.agent.reconcile(2, options)
  await h.agent.reconcile(2, options)
  assert.equal(h.agent.lastResult.value.id, 'new')
  assert.equal(h.agent.lastResult.value.status, 'done')
  assert.equal(refreshed, 1)
  assert.equal(followUp, 0)
  assert.deepEqual(h.notices, [])
  assert.ok(h.requests.every(([method]) => method === 'get'))
})

test('a revised draft on the same completed job refreshes business data once per revision without replaying completion', async t => {
  const original = job({ id: 'same-done', status: 'done', phase: 'done', started_at: '2026-11-04T12:31:00Z',
    finished_at: '2026-11-04T12:45:00Z', updated_at: '2026-11-04T12:45:00Z', draft_id: 'original-draft' })
  let state = [original], followedUp = 0
  const refreshed = []
  const h = harness({ get: async () => state })
  t.after(h.dispose)
  const options = { onSettled: value => { refreshed.push({ updated_at: value.updated_at, draft_id: value.draft_id }) }, onDone: () => { followedUp++ } }
  await h.agent.reconcile(2, options)
  await h.agent.reconcile(2, options)
  assert.equal(refreshed.length, 1)

  const updated = { ...original, updated_at: '2026-11-04T15:45:00Z', draft_id: 'voice-corrected-draft' }
  state = [updated]
  await h.agent.reconcile(2, options)
  await h.agent.reconcile(2, options)
  assert.equal(refreshed.length, 2, 'The same ID, status and finished_at do not hide a newly delivered draft')
  assert.equal(h.agent.lastResult.value.finished_at, original.finished_at)
  assert.equal(h.agent.lastResult.value.draft_id, updated.draft_id)

  state = [{ ...updated, updated_at: '2026-11-04T15:46:00Z' }]
  await h.agent.reconcile(2, options)
  await h.agent.reconcile(2, options)
  assert.equal(refreshed.length, 3, 'An updated current draft also gets exactly one refresh')

  state = [{ ...updated, updated_at: '2026-11-04T15:46:00Z', draft_id: 'same-time-new-draft' }]
  await h.agent.reconcile(2, options)
  await h.agent.reconcile(2, options)
  assert.equal(refreshed.length, 4, 'The draft identity itself participates in terminal versioning')

  state = [original]
  await h.agent.reconcile(2, options)
  assert.equal(refreshed.length, 4, 'A late history snapshot cannot revert the corrected result')
  assert.equal(h.agent.lastResult.value.draft_id, 'same-time-new-draft')
  assert.equal(followedUp, 0)
  assert.deepEqual(h.notices, [])
  assert.ok(h.requests.every(([method]) => method === 'get'))
})

test('a genuinely newer failure remains visible while reconciliation read failures and empty snapshots keep the last known result', async t => {
  const failed = job({ id: 'failed-new', status: 'error', phase: 'error', started_at: '2026-11-04T10:00:00Z', error: 'latest service failure' })
  let state = [failed], reject = false, refreshed = 0
  const h = harness({ get: async () => { if (reject) throw new Error('temporary read failure'); return state } })
  t.after(h.dispose)
  await h.agent.reconcile(2, { onSettled: () => { refreshed++ } })
  reject = true
  await h.agent.reconcile(2)
  reject = false; state = []
  await h.agent.reconcile(2)
  assert.equal(h.agent.lastResult.value.id, 'failed-new')
  assert.equal(h.agent.lastResult.value.error, 'latest service failure')
  assert.equal(h.agent.journalJobs.value[0].id, 'failed-new')
  assert.equal(refreshed, 1)
  assert.deepEqual(h.notices, [])
})

test('an externally superseded old job cannot replay its failure toast when its terminal poll arrives late', async t => {
  const old = job({ id: 'old-active', started_at: '2026-11-04T09:10:00Z' })
  const latest = job({ id: 'new-done', status: 'done', phase: 'done', started_at: '2026-11-04T09:20:00Z', finished_at: '2026-11-04T09:21:00Z' })
  let listed = [old], current = old, refreshed = []
  const h = harness({ get: async path => path.includes('?') ? listed : current })
  t.after(h.dispose)
  await h.agent.resume(2, { onSettled: value => { refreshed.push(value.id) } })
  await settle()
  listed = [latest, old]
  await h.agent.reconcile(2, { onSettled: value => { refreshed.push(value.id) } })
  assert.equal(h.agent.running.value, true, 'the selected running job stays authoritative until its terminal poll')
  current = { ...old, status: 'error', phase: 'error', error: 'obsolete error' }
  await h.tick()
  await settle()
  assert.equal(h.agent.lastResult.value.id, 'new-done')
  assert.equal(h.agent.running.value, false)
  assert.deepEqual(refreshed, ['new-done'])
  assert.deepEqual(h.notices, [])
  assert.ok(h.requests.every(([method]) => method === 'get'))
})

test('stale reconciliation cannot downgrade a completed job or cross a route boundary', async t => {
  const latest = job({ id: 'new-done', status: 'done', phase: 'done', started_at: '2026-11-04T10:00:00Z', finished_at: '2026-11-04T10:01:00Z' })
  let state = [latest]
  const snapshot = deferred()
  const h = harness({ get: async () => state })
  t.after(h.dispose)
  await h.agent.reconcile(2)
  state = [{ ...latest, status: 'running', phase: 'generating', finished_at: undefined }]
  await h.agent.reconcile(2)
  assert.equal(h.agent.lastResult.value.status, 'done')
  assert.equal(h.agent.running.value, false)
  state = snapshot.promise
  let refreshed = 0
  const reconciling = h.agent.reconcile(2, { onSettled: () => { refreshed++ } })
  h.route.value = '1:2'
  snapshot.resolve([job({ id: 'later', status: 'error', phase: 'error', started_at: '2026-11-04T11:00:00Z' })])
  await reconciling
  assert.equal(h.agent.lastResult.value, null)
  assert.equal(refreshed, 0)
  assert.deepEqual(h.notices, [])
})

test('reconciliation retries the business refresh after failure instead of acknowledging a stale view', async t => {
  const h = harness({ get: async () => [job({ status: 'done', phase: 'done' })] })
  t.after(h.dispose)
  let attempts = 0
  const options = { onSettled: () => { if (++attempts === 1) throw new Error('business refresh failed') } }
  await h.agent.reconcile(2, options)
  await h.agent.reconcile(2, options)
  await h.agent.reconcile(2, options)
  assert.equal(attempts, 2)
  assert.deepEqual(h.notices, [])
})

test('a late history snapshot cannot overwrite a newly submitted running job', async t => {
  const snapshot = deferred()
  const h = harness({ get: path => path.includes('?') ? snapshot.promise : job() })
  t.after(h.dispose)
  const restoring = h.agent.resume(2)
  const running = h.agent.runJob('prompt_generator', 'new request', 1, 2, { storyboardIds: [11] })
  await settle()
  snapshot.resolve([job({ id: '6dc-old', status: 'error', phase: 'error', error: 'old timeout' })])
  await restoring
  assert.equal(h.agent.running.value, true)
  assert.deepEqual([...h.agent.activeJobs.value].map(item => item.id), [8])
  assert.equal(h.agent.lastResult.value, null)
  assert.equal(h.agent.lastResultIsHistory.value, false)
  assert.deepEqual(h.notices, [])
  h.dispose()
  await running
})

test('a late history snapshot cannot replace the terminal result of a newer request', async t => {
  const snapshot = deferred()
  const h = harness({ get: path => path.includes('?') ? snapshot.promise : job({ status: 'done', phase: 'done' }) })
  t.after(h.dispose)
  const restoring = h.agent.resume(2)
  await h.agent.runJob('prompt_generator', 'new request', 1, 2)
  snapshot.resolve([job({ id: '6dc-old', status: 'error', phase: 'error', error: 'old timeout' })])
  await restoring
  assert.equal(h.agent.lastResult.value.id, 8)
  assert.equal(h.agent.lastResult.value.status, 'done')
  assert.equal(h.agent.lastResultIsHistory.value, false)
})

test('restoring while a selected job is active never presents an older failure as its current outcome', async t => {
  const h = harness({ get: async path => path.includes('?') ? [job({ id: '6dc-old', status: 'error', phase: 'error' })] : job() })
  t.after(h.dispose)
  const running = h.agent.runJob('prompt_generator', 'new request', 1, 2)
  await settle()
  await h.agent.resume(2)
  assert.equal(h.agent.lastResult.value, null)
  assert.equal(h.agent.lastResultIsHistory.value, false)
  assert.deepEqual([...h.agent.activeJobs.value].map(item => item.id), [8])
  h.dispose()
  await running
})

test('a newer episode selection discards an older episode history response even without a route change', async t => {
  const snapshot = deferred()
  const h = harness({ get: path => path.endsWith('episode_id=2') ? snapshot.promise : Promise.resolve([
    job({ id: 'episode-3', episode_id: 3, status: 'error', phase: 'error' }),
    job({ id: 'wrong-episode', episode_id: 2, status: 'error', phase: 'error' }),
  ]) })
  t.after(h.dispose)
  const oldRestore = h.agent.resume(2)
  await h.agent.resume(3)
  snapshot.resolve([job({ id: '6dc-old', status: 'error', phase: 'error' })])
  await oldRestore
  assert.equal(h.agent.lastResult.value.id, 'episode-3')
  assert.equal(h.agent.lastResult.value.episode_id, 3)
  assert.equal(h.agent.lastResultIsHistory.value, true)
  assert.ok(h.requests.every(([method]) => method === 'get'))
})

test('a poll response from a different episode is ignored rather than invoking the current completion callback', async t => {
  let reads = 0, refreshed = 0
  const h = harness({ get: async () => ++reads === 1 ? job({ episode_id: 99, status: 'error', phase: 'error', error: 'foreign failure' }) : job({ status: 'done', phase: 'done' }) })
  t.after(h.dispose)
  const running = h.agent.runJob('prompt_generator', 'new request', 1, 2, { onSettled: () => { refreshed++ } })
  await settle()
  assert.equal(h.agent.running.value, true)
  assert.equal(h.agent.lastResult.value, null)
  assert.equal(refreshed, 0)
  assert.deepEqual(h.notices, [])
  await h.tick()
  await running
  assert.equal(refreshed, 1)
  assert.equal(h.agent.lastResult.value.episode_id, 2)
})

test('terminal history retains its timing metadata without resubmitting or showing a fresh error toast', async t => {
  const historical = job({ status: 'error', phase: 'error', error: 'timeout', started_at: '2026-11-03T14:05:00Z', finished_at: '2026-11-03T14:15:00Z' })
  const h = harness({ get: async () => [historical] })
  t.after(h.dispose)
  await h.agent.resume(2)
  assert.equal(h.agent.lastResultIsHistory.value, true)
  assert.equal(h.agent.lastResult.value.started_at, historical.started_at)
  assert.equal(h.agent.lastResult.value.finished_at, historical.finished_at)
  assert.equal(h.agent.running.value, false)
  assert.deepEqual(h.notices, [])
  assert.ok(h.requests.every(([method]) => method === 'get'))
})

test('transient polling failure retries observation; a server restart error releases busy state', async t => {
  let reads = 0
  const h = harness({ get: async () => {
    if (++reads === 1) throw new Error('offline')
    return job({ status: 'error', phase: 'error', error: '服务重启，任务已中止' })
  } })
  t.after(h.dispose)
  let refreshed = 0
  const result = h.agent.runJob('prompt_generator', 'test', 1, 2, { onSettled: () => { refreshed++ } })
  await settle()
  assert.equal(h.agent.running.value, true)
  await h.tick()
  assert.equal((await result).status, 'error')
  assert.equal(refreshed, 1)
  assert.equal(h.agent.running.value, false)
  assert.equal(h.requests.filter(([method]) => method === 'post').length, 1)
  assert.equal(h.notices[0][0], 'error')
})

test('unmount and route identity changes discard late terminal callbacks without canceling server jobs', async () => {
  for (const leave of ['unmount', 'route']) {
    const response = deferred()
    const h = harness({ get: () => response.promise })
    let refreshed = 0
    const result = h.agent.runJob('prompt_generator', 'test', 1, 2, { onSettled: () => { refreshed++ } })
    await settle()
    if (leave === 'unmount') h.dispose()
    else h.route.value = '1:2'
    await result
    response.resolve(job({ status: 'done', phase: 'done' }))
    await settle()
    assert.equal(refreshed, 0)
    assert.equal(h.agent.running.value, false)
    assert.equal(h.timers.size, 0)
    assert.deepEqual(h.notices, [])
    assert.equal(h.requests.filter(([method]) => method === 'post').length, 1)
    h.dispose()
  }
})

test('a rejected submission clears its temporary job and never falls back to chat', async t => {
  const h = harness({ post: async () => { throw new Error('another job is running') } })
  t.after(h.dispose)
  await h.agent.run('storyboard_breaker', 'test', 1, 2)
  assert.equal(h.agent.running.value, false)
  assert.equal(h.agent.activeJobs.value.length, 0)
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0][1], '/agent/storyboard_breaker/jobs')
  assert.equal(h.notices[0][0], 'error')
})

test('all four interface languages include distinct short generation, validation and repair phases', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const { agent } = JSON.parse(readFileSync(new URL(`../app/locales/${lang}.json`, import.meta.url))).composables
    assert.equal(new Set(Object.values(agent.phase)).size, 3)
    assert.ok(agent.needsRevision)
    assert.ok(agent.failed)
    assert.ok(agent.draftSaved)
    assert.ok(agent.previousTask)
    assert.match(agent.startedAt, /\{time\}/)
    assert.match(agent.finishedAt, /\{time\}/)
  }
})

test('partial draft completion reports saved progress while preserving the needs-revision outcome', async t => {
  const terminal = job({ status: 'needs_revision', phase: 'needs_revision', draft_id: 'draft-1', issues: [{ message: '第二组声音需补齐' }] })
  const h = harness({ get: async () => terminal })
  t.after(h.dispose)
  let done = 0
  const result = await h.agent.runJob('storyboard_breaker', 'continue draft', 1, 2, { onDone: () => { done++ } })
  assert.equal(result.status, 'needs_revision')
  assert.equal(h.agent.lastResult.value.draft_id, 'draft-1')
  assert.equal(done, 0, 'A saved partial draft is not a completed applied storyboard')
  assert.ok(h.notices.some(([kind, message]) => kind === 'warning' && message.startsWith('composables.agent.draftSaved')))
  assert.equal(h.notices.some(([kind]) => kind === 'success'), false)
  assert.equal(h.requests.filter(([method]) => method === 'post').length, 1)
})

test('all four interface languages distinguish draft readiness from applying it to the shot list', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const { episode } = JSON.parse(readFileSync(new URL(`../app/locales/${lang}.json`, import.meta.url)))
    assert.ok(episode.sb.draft.continue)
    assert.notEqual(episode.sb.draft.status.ready, episode.sb.draft.status.committed)
    assert.notEqual(episode.sb.draft.saved, episode.sb.draft.applied)
    for (const field of ['description', 'video_prompt', 'result', 'time', 'location', 'shot_type', 'angle', 'movement', 'atmosphere', 'image_prompt', 'bgm_prompt', 'sound_effect']) assert.ok(episode.sb.draft.fields[field], `${lang}:${field}`)
  }
})
