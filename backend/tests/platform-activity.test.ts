import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-platform-activity-'))
process.env.HUOBAO_DATA_DIR = root
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.ts')
const security = await import('../src/services/platform-security/index.ts')
security.initPlatformSecurity()
const store = await import('../src/services/activity/store.ts')
const { withActivityContext, observeAgentOperation } = await import('../src/services/activity/context.ts')
const { observeLanguageModel } = await import('../src/services/activity/model-observer.ts')
const { publicActivityRequest, sanitizeActivity } = await import('../src/services/activity/sanitize.ts')
const { syncActivitySources, syncMediaActivity } = await import('../src/services/activity/source-sync.ts')
const { installActivityLogger } = await import('../src/services/activity/logger.ts')
const { logTaskPayload } = await import('../src/utils/task-logger.ts')
const app = new Hono()
app.use('/api/*', security.platformSecurityMiddleware)
app.route('/api/v1/auth', (await import('../src/routes/platform-auth.ts')).default)
app.route('/api/v1/activity', (await import('../src/routes/activity.ts')).default)
const at = new Date().toISOString()
const a = security.createUser('activity_a', 'Activity-a-test-password').user
const b = security.createUser('activity_b', 'Activity-b-test-password').user
const pa = db.insert(schema.dramas).values({ title: 'A', ownerUserId: a.id, createdAt: at, updatedAt: at }).returning().get()
const pb = db.insert(schema.dramas).values({ title: 'B', ownerUserId: b.id, createdAt: at, updatedAt: at }).returning().get()
const ta = store.createActivityTask({ kind: 'text', title: 'A rewrite', projectId: pa.id })
const tb = store.createActivityTask({ kind: 'text', title: 'B extraction', projectId: pb.id })
async function login(username: string, password: string) {
  const res = await app.request('http://workbench.test/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
  assert.equal(res.status, 200)
  const data: any = (await res.json()).data
  return { cookie: res.headers.get('set-cookie')!.split(';')[0], csrf: data.csrfToken }
}
const ca = await login('activity_a', 'Activity-a-test-password'), cb = await login('activity_b', 'Activity-b-test-password')
const initial = await fs.readFile(path.join(root, 'admin-initial-password.txt'), 'utf8')
const admin = await login('admin', /Initial password: ([^\r\n]+)/u.exec(initial)![1])
async function get(url: string, client = ca) { return app.request('http://workbench.test/api/v1/activity' + url, { headers: { Cookie: client.cookie } }) }

test('journal observes the identical native request once and does not change the public result', async () => {
  const options = { prompt: [{ role: 'system', content: 'ORIGINAL SYSTEM' }, { role: 'user', content: '中文 @人物 🦋' }], tools: [{ original: true }], providerOptions: { native: true } }
  let calls = 0
  const output = { content: [{ type: 'reasoning', text: 'HIDDEN_REASONS' }, { type: 'text', text: 'public reply' }], usage: { inputTokens: { total: 11 }, outputTokens: { total: 7 } } }
  const native = { doGenerate: async (value: any) => { calls++; assert.equal(value, options); return output } }
  const model = observeLanguageModel(native, { model: 'offline-model', provider: 'offline-channel' })
  const result = await withActivityContext({ taskId: ta }, () => model.doGenerate(options))
  assert.equal(result, output); assert.equal(calls, 1)
  const round = store.activityRounds(ta)[0]
  assert.equal(round.status, 'completed'); assert.deepEqual(round.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 })
  assert(JSON.stringify(round.input).includes('ORIGINAL SYSTEM'))
  assert(!JSON.stringify(round.public_output).includes('HIDDEN_REASONS'))
})

test('stream chunks and tool calls are forwarded unchanged while hidden reasoning is excluded from journal', async () => {
  const chunks = [{ type: 'text-delta', delta: '你好' }, { type: 'reasoning-delta', delta: 'HIDDEN_STREAM' },
    { type: 'tool-call', toolCallId: 'x', toolName: 'save_script', input: '{"text":"中文"}' },
    { type: 'finish', usage: { inputTokens: 5, outputTokens: 9, totalTokens: 14 } }]
  const native = { doStream: async (_options: any) => ({ stream: new ReadableStream({ start(c) { chunks.forEach(x => c.enqueue(x)); c.close() } }), providerMetadata: { unchanged: true } }) }
  const result = await withActivityContext({ taskId: ta }, () => observeLanguageModel(native, { model: 'stream' }).doStream({ prompt: [] }))
  const received = []; for await (const chunk of result.stream) received.push(chunk)
  assert.deepEqual(received, chunks); assert.equal(result.providerMetadata.unchanged, true)
  const round = store.activityRounds(ta).at(-1)!
  assert.equal(round.public_output.text, '你好'); assert.equal(round.public_output.tool_calls[0].name, 'save_script')
  assert(!JSON.stringify(store.activityEvents(ta)).includes('HIDDEN_STREAM'))
})

test('upstream errors are not retried and do not leak shared credentials through any logged copy', async () => {
  const secret = 'synthetic-shared-token-opaque-123456'
  let calls = 0
  const expected = new Error('upstream rejected ' + secret)
  const model = observeLanguageModel({ doGenerate: async () => { calls++; throw expected } }, { model: 'failed' }, [secret])
  await assert.rejects(withActivityContext({ taskId: ta }, () => model.doGenerate({ prompt: [] } as any)), error => error === expected)
  assert.equal(calls, 1)
  assert(!JSON.stringify(store.activityRounds(ta)).includes(secret))
  assert(!JSON.stringify(sanitizeActivity({ error: expected.message, headers: { Authorization: secret }, nested: [{ type: 'reasoning', text: 'private' }] })).includes(secret))
})

test('ordinary users only see their project rows, round prompts omit nested system/tools, and admin can audit full input', async () => {
  store.updateActivityTask(ta, { request: { messages: [{ role: 'system', content: 'PRIVATE_PROMPT' }, { role: 'user', content: 'public request' }], nested: { tools: ['PRIVATE_SCHEMA'], protocolSnapshot: { private: 'PRIVATE_PROTOCOL' } } } })
  const list: any = await (await get('/tasks')).json()
  assert(list.data.items.some((x: any) => x.id === ta)); assert(!list.data.items.some((x: any) => x.id === tb))
  assert.equal((await get('/tasks/' + tb)).status, 404)
  assert.equal((await get('/tasks?drama_id=' + pb.id)).status, 404)
  const detail = JSON.stringify(await (await get('/tasks/' + ta)).json())
  for (const privateText of ['PRIVATE_PROMPT', 'PRIVATE_SCHEMA', 'PRIVATE_PROTOCOL', 'ORIGINAL SYSTEM']) assert(!detail.includes(privateText))
  assert(detail.includes('public request'))
  assert(JSON.stringify(await (await get('/tasks/' + ta, admin)).json()).includes('ORIGINAL SYSTEM'))
  assert.equal((await get('/tasks/' + tb, cb)).status, 200)
  assert.deepEqual(publicActivityRequest({ inner: { prompt: [{ role: 'developer', content: 'private' }, { role: 'user', content: 'keep' }], tools: [1] } }), { inner: { prompt: [{ role: 'user', content: 'keep' }] } })
})

test('generic text log payloads cannot expose serialized prompt snapshots in public timeline', async () => {
  installActivityLogger()
  withActivityContext({ taskId: ta }, () => logTaskPayload('TextProvider', 'payload', { body: '{"messages":[{"role":"system","content":"EVENT_PRIVATE_SYSTEM"}]}' }))
  assert(!JSON.stringify(store.activityEvents(ta)).includes('EVENT_PRIVATE_SYSTEM'))
})

test('a returned tool error is logged as failure without changing the result or original business handling', async () => {
  const result = { text: 'public reply', toolResults: [{ payload: { toolName: 'save_script', result: '{"error":"script not saved"}' } }] }
  const returned = await observeAgentOperation({ id: 'tool-error-offline' }, [], {}, async () => result)
  assert.equal(returned, result)
  const row: any = db.$client.prepare("SELECT * FROM platform_activity_tasks WHERE title='tool-error-offline'").get()
  assert.equal(row.status, 'failed'); assert.equal(row.error, 'script not saved')
})

test('canonical media rows update in place with real failed/completed/manual-delivery status and unknown progress stays null', async () => {
  const task = db.insert(schema.sysTask).values({ type: 'video', dramaId: pa.id, status: 'processing', stage: 'polling', params: '{}', createdAt: at, updatedAt: at }).returning().get()
  const id = syncMediaActivity(task.id)!
  assert.equal(store.activityTaskView(store.activityTask(id)).progress, null)
  db.$client.prepare("UPDATE sys_task SET status='failed',stage='failed',error_msg=?,updated_at=? WHERE id=?").run('reference image refused', new Date().toISOString(), task.id)
  assert.equal(syncMediaActivity(task.id), id)
  assert.equal(store.activityTask(id).status, 'failed'); assert.equal(store.activityTask(id).error, 'reference image refused')
  db.$client.prepare("UPDATE sys_task SET status='completed',stage='ready_in_local_service',error_msg=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), task.id)
  syncMediaActivity(task.id)
  assert.equal(store.activityTaskView(store.activityTask(id)).result.delivery_mode, 'local_manual')
  assert.equal(store.activityTask(id).status, 'completed'); assert.equal(store.activityTaskView(store.activityTask(id)).progress, null)
  assert.equal(store.activityTask(id).error, null)
  const queued = store.createActivityTask({ kind: 'image', title: 'queued', projectId: pa.id }); store.updateActivityTask(queued, { status: 'queued', stage: 'queued' })
  const interrupted = store.createActivityTask({ kind: 'text', title: 'interrupted', projectId: pa.id }); store.updateActivityTask(interrupted, { status: 'interrupted', stage: 'interrupted' })
  const filtered: any = await (await get('/tasks?status=failed')).json()
  assert(filtered.data.counts.queued >= 1); assert(filtered.data.counts.completed >= 1)
  assert(filtered.data.items.some((item: any) => item.id === interrupted))
})

test('incremental history import progresses beyond a full page with identical timestamps', () => {
  const insert = db.$client.prepare("INSERT INTO sys_task(type,drama_id,status,stage,created_at,updated_at) VALUES('image',?,'completed','completed',?,?)")
  const stamp = new Date(Date.now() + 1000).toISOString()
  db.$client.transaction(() => { for (let i = 0; i < 520; i++) insert.run(pa.id, stamp, stamp) })()
  syncActivitySources(true); syncActivitySources(true); syncActivitySources(true)
  const count: any = db.$client.prepare("SELECT count(*) n FROM platform_activity_tasks WHERE source_type='media'").get()
  assert(count.n >= 521)
})

test('live public output and tool fields are visible through the real detail API before the model finishes', async () => {
  const id = store.createActivityTask({ kind: 'text', title: 'live native stream', projectId: pa.id })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const native = { doStream: async (_options: any) => ({ stream: new ReadableStream({ async start(controller) {
    controller.enqueue({ type: 'text-delta', delta: '公开增量：中文🌙' })
    controller.enqueue({ type: 'tool-input-start', id: 'live-call', toolName: 'save_script' })
    controller.enqueue({ type: 'tool-input-delta', id: 'live-call', delta: '{"text":"未结束"}' })
    await gate
    controller.enqueue({ type: 'tool-call', toolCallId: 'live-call', toolName: 'save_script', input: '{"text":"未结束"}' })
    controller.enqueue({ type: 'finish', usage: { inputTokens: 2, outputTokens: 3 } }); controller.close()
  } }) }) }
  const response = await withActivityContext({ taskId: id }, () => observeLanguageModel(native, { model: 'live' }).doStream({ prompt: [] }))
  const drained = (async () => { for await (const _chunk of response.stream) {} })()
  try {
    await new Promise(resolve => setTimeout(resolve, 350))
    const detail: any = await (await get('/tasks/' + id)).json()
    assert.equal(detail.data.rounds[0].status, 'running')
    assert.equal(detail.data.rounds[0].public_text, '公开增量：中文🌙')
    assert.equal(detail.data.rounds[0].tool_calls[0].name, 'save_script')
    assert.equal(detail.data.rounds[0].tool_calls[0].arguments, '{"text":"未结束"}')
  } finally { release(); await drained }
})

test('full export includes every event after 500 and does not truncate long prompt or public result copies', async () => {
  const long = '完整中文🦋'.repeat(85000), id = store.createActivityTask({ kind: 'text', title: 'full export', projectId: pa.id,
    request: { messages: [{ role: 'user', content: long }, { role: 'system', content: 'EXPORT_PRIVATE_SYSTEM' }] } })
  store.updateActivityTask(id, { status: 'completed', output: { text: long } })
  for (let i = 0; i < 740; i++) store.activityEvent(id, 'process', `event-${i}`, { index: i })
  const detail: any = await (await get('/tasks/' + id)).json()
  assert.equal(detail.data.events.length, 500); assert.equal(detail.data.events_page.has_more, true)
  const earlier: any = await (await get('/tasks/' + id + '/events?before=' + detail.data.events_page.next_before)).json()
  assert.equal(earlier.data.items.length + detail.data.events.length, 741)
  const exported = await get('/tasks/' + id + '/export')
  assert.match(exported.headers.get('content-disposition')!, /attachment/u)
  const full: any = await exported.json()
  assert.equal(full.events.length, 741); assert.equal(full.events.at(-1).payload.index, 739)
  assert.equal(full.request.messages[0].content, long); assert.equal(full.output.text, long)
  assert(!JSON.stringify(full).includes('EXPORT_PRIVATE_SYSTEM'))
  assert.equal((await get('/tasks/' + id + '/export', cb)).status, 404)
})

test('queue and local execution times are separately observed and historical unknown queue time is not fabricated', () => {
  const id = store.createActivityTask({ kind: 'image', title: 'observed timing', projectId: pa.id })
  store.updateActivityTask(id, { status: 'queued', stage: 'upstream_queued' })
  db.$client.prepare('UPDATE platform_activity_tasks SET created_at=?,queue_entered_at=? WHERE id=?').run(new Date(Date.now() - 12000).toISOString(), new Date(Date.now() - 9000).toISOString(), id)
  store.updateActivityTask(id, { status: 'running', stage: 'generating' })
  const view = store.activityTaskView(store.activityTask(id))
  assert(view.queue_seconds >= 9); assert(view.run_seconds >= 2); assert(view.run_seconds < view.elapsed_seconds)
  const legacy = store.createActivityTask({ kind: 'text', title: 'legacy timing', projectId: pa.id, createdAt: '2020-01-01T00:00:00Z' })
  assert.equal(store.activityTaskView(store.activityTask(legacy)).queue_seconds, null)
})

test('SSE is project scoped and logout closes an already-open stream without reconnecting or resubmitting a model', async () => {
  const client = await login('activity_a', 'Activity-a-test-password')
  const res = await get('/events?drama_id=' + pa.id + '&after=0', client)
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type')!, /text\/event-stream/u)
  const reader = res.body!.getReader(), first = await reader.read()
  const text = new TextDecoder().decode(first.value)
  assert(text.includes(ta)); assert(!text.includes(tb))
  const logout = await app.request('http://workbench.test/api/v1/auth/logout', { method: 'POST', headers: { Cookie: client.cookie, 'X-CSRF-Token': client.csrf } })
  assert.equal(logout.status, 200)
  const deadline = Date.now() + 3500
  for (;;) { const part = await reader.read(); if (part.done) break; assert(Date.now() < deadline) }
})

test('a fresh SSE subscription tails current events and sends a snapshot barrier instead of replaying long history', async () => {
  for (let i = 0; i < 610; i++) store.activityEvent(ta, 'process', `OLD_REPLAY_${i}`)
  const response = await get('/events?drama_id=' + pa.id)
  const reader = response.body!.getReader(), initial = new TextDecoder().decode((await reader.read()).value)
  assert(initial.includes('"kind":"sync"')); assert(!initial.includes('OLD_REPLAY_'))
  store.activityEvent(ta, 'public_delta', 'FRESH_ONLY', { text: '新的公开输出' })
  const fresh = new TextDecoder().decode((await reader.read()).value)
  assert(fresh.includes('FRESH_ONLY')); assert(!fresh.includes('OLD_REPLAY_')); assert(!fresh.includes(tb))
  await reader.cancel()
})

after(async () => { db.$client.close(); await fs.rm(root, { recursive: true, force: true }) })
