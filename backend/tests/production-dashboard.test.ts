import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'chuangyi-production-dashboard-'))
process.env.HUOBAO_DATA_DIR = folder
process.env.SQLITE_PATH = path.join(folder, 'test.sqlite3')
process.env.STORAGE_PATH = path.join(folder, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.ts')
const security = await import('../src/services/platform-security/index.ts')
security.initPlatformSecurity()
const activity = await import('../src/services/activity/store.ts')
const { syncActivitySources, syncMediaActivity, syncAgentActivity } = await import('../src/services/activity/source-sync.ts')
const { AgentJobStore } = await import('../src/services/agent-job-store.ts')
const { initProductionBatches } = await import('../src/services/production-batches.ts')
const dashboard = await import('../src/services/production-dashboard.ts')
const { PLATFORM_RELEASE } = await import('../src/utils/platform-release.ts')
const sql = db.$client
const at = new Date().toISOString()
const a = security.createUser('dashboard_a', 'a').user
const b = security.createUser('dashboard_b', 'b').user
const pa = db.insert(schema.dramas).values({ title: 'A project', ownerUserId: a.id, createdAt: at, updatedAt: at }).returning().get()
const pb = db.insert(schema.dramas).values({ title: 'B PRIVATE PROJECT', ownerUserId: b.id, createdAt: at, updatedAt: at }).returning().get()
const ea = db.insert(schema.episodes).values({ dramaId: pa.id, episodeNumber: 1, title: 'A episode', createdAt: at, updatedAt: at }).returning().get()
const ea2 = db.insert(schema.episodes).values({ dramaId: pa.id, episodeNumber: 2, title: 'Shared character episode', createdAt: at, updatedAt: at }).returning().get()
const ea3 = db.insert(schema.episodes).values({ dramaId: pa.id, episodeNumber: 3, title: 'No execution record', createdAt: at, updatedAt: at }).returning().get()
const eb = db.insert(schema.episodes).values({ dramaId: pb.id, episodeNumber: 1, title: 'B PRIVATE EPISODE', createdAt: at, updatedAt: at }).returning().get()
const cfg = db.insert(schema.aiServiceConfigs).values({ serviceType: 'image', provider: 'offline', name: 'Safe channel name', baseUrl: 'https://private-provider.invalid/api', apiKey: 'sk-SYNTHETIC-PRIVATE-CREDENTIAL-987654', model: 'offline-image', createdAt: at, updatedAt: at }).returning().get()
const { getModelChannelStore } = await import('../src/services/model-channels/store.ts')
const channels = getModelChannelStore()
channels.migrateLegacy()
const binding = channels.bindingForConfig(cfg.id)!
const character = db.insert(schema.characters).values({ dramaId: pa.id, name: 'A character', createdAt: at, updatedAt: at }).returning().get()
db.insert(schema.episodeCharacters).values([{ episodeId: ea.id, characterId: character.id, createdAt: at }, { episodeId: ea2.id, characterId: character.id, createdAt: at }]).run()
const media = db.insert(schema.sysTask).values({ type: 'image', dramaId: pa.id, characterId: character.id, configId: cfg.id, taskId: 'actual-upstream-image-123', provider: 'offline', model: 'offline-image', status: 'failed', stage: 'submitting', errorCode: 'submission_unknown', errorMsg: 'HTTP 503，提交结果待确认；请核对原任务。', params: JSON.stringify({ secret: 'DO_NOT_COPY_PARAMS', protocolSnapshot: { private: true } }), createdAt: at, updatedAt: at }).returning().get()
const imageActivity = syncMediaActivity(media.id)!
const ta = activity.createActivityTask({ kind: 'text', title: '提取角色', projectId: pa.id, episodeId: ea.id, request: { operation: 'extractor', config_id: cfg.id, messages: [{ role: 'system', content: 'DO_NOT_COPY_SYSTEM' }], protocolSnapshot: { private: 'DO_NOT_COPY_PROTOCOL' } } })
const textRound = activity.startActivityRound(ta, { model: 'offline-text', provider: 'offline', stage: 'generating' }, { messages: [{ role: 'system', content: 'DO_NOT_COPY_ROUND_SYSTEM' }] })
activity.endActivityRound(textRound, ta, { text: 'public response' })
activity.updateActivityTask(ta, { status: 'completed', stage: 'completed' })
const tb = activity.createActivityTask({ kind: 'text', title: 'B PRIVATE TASK', projectId: pb.id, episodeId: eb.id })
const globalTask = activity.createActivityTask({ kind: 'text', title: 'Administrator model test' })
const agentStore = new AgentJobStore(sql)
const agent = agentStore.start({ agent_type: 'storyboard_breaker', episode_id: ea.id, drama_id: pa.id, scope: 'agent', storyboard_ids: [] }).job
const agentFailed = agentStore.update(agent.id, { status: 'needs_revision', phase: 'needs_revision', issues: Array.from({ length: 100 }, (_, index) => ({ code: 'schema_error', message: `shot_number schema field ${index}`, severity: 'error' as const })), failed: 1 })
const schemaActivity = syncAgentActivity(agentFailed)!
initProductionBatches()
const app = new Hono()
app.use('/api/*', security.platformSecurityMiddleware)
app.route('/api/v1/auth', (await import('../src/routes/platform-auth.ts')).default)
app.route('/api/v1/production-dashboard', (await import('../src/routes/production-dashboard.ts')).default)
async function login(username: string, password: string) {
  const response = await app.request('http://dashboard.test/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
  assert.equal(response.status, 200)
  return response.headers.get('set-cookie')!.split(';')[0]
}
const ca = await login('dashboard_a', 'a'), cb = await login('dashboard_b', 'b')
const initial = await fs.readFile(path.join(folder, 'admin-initial-password.txt'), 'utf8')
const adminCookie = await login('admin', /Initial password: ([^\r\n]+)/u.exec(initial)![1])
const adminActor = security.readSession(adminCookie.split('=')[1])!.user
async function get(suffix = '', cookie = ca) { return app.request('http://dashboard.test/api/v1/production-dashboard' + suffix, { headers: { Cookie: cookie } }) }
async function result(suffix = '', cookie = ca) {
  const response = await get(suffix, cookie)
  assert.equal(response.status, 200, await response.clone().text())
  return (await response.json() as any).data
}

test('real authenticated HTTP enforces project, task and diagnostics ownership in every view', async () => {
  const data = await result()
  assert.equal(data.scope, 'own')
  const serialized = JSON.stringify(data)
  for (const privateValue of ['B PRIVATE', tb, globalTask, 'DO_NOT_COPY_SYSTEM', 'DO_NOT_COPY_PROTOCOL', 'DO_NOT_COPY_PARAMS', cfg.apiKey, cfg.baseUrl]) assert(!serialized.includes(privateValue))
  assert.equal((await get('?project_id=' + pb.id)).status, 404)
  assert.equal((await get('/tasks/' + tb)).status, 404)
  assert.equal((await get('/diagnostics/' + tb)).status, 404)
  assert.equal((await get('/tasks/' + tb, cb)).status, 200)
  const all = await result('', adminCookie)
  assert.equal(all.scope, 'all')
  assert(all.tasks.items.some((task: any) => task.id === globalTask))
  assert.equal((await get('/tasks/' + globalTask, adminCookie)).status, 200)
})

test('shared image task counts once globally while its real episode associations remain visible', async () => {
  const data = await result('?project_id=' + pa.id)
  assert.equal(data.summary.kinds.find((kind: any) => kind.kind === 'image').total, 1)
  const task = data.tasks.items.find((row: any) => row.id === imageActivity)
  assert.equal(task.shared, true)
  assert.deepEqual(task.episode_ids.sort(), [ea.id, ea2.id].sort())
  assert.equal(task.upstream_task_id, 'actual-upstream-image-123')
  assert.equal(task.links.asset.id, character.id)
  assert.equal(task.links.settings, null)
  const admin = await result('/tasks/' + imageActivity, adminCookie)
  assert.equal(admin.task.links.settings.config_id, cfg.id)
  assert.equal(admin.task.links.settings.channel_id, binding.channel_id)
  const href = admin.task.actions.find((action: any) => action.type === 'view_settings').href
  const target = new URL(href, 'http://dashboard.test')
  assert.equal(target.pathname, '/admin/channels')
  assert.equal(target.searchParams.get('channel_id'), String(binding.channel_id))
  assert.equal(target.searchParams.get('config_id'), String(cfg.id))
  assert(sql.prepare('SELECT 1 FROM platform_channel_models b JOIN platform_model_channels c ON c.id=b.channel_id WHERE b.config_id=? AND b.channel_id=? AND b.deleted_at IS NULL AND c.deleted_at IS NULL').get(cfg.id, binding.channel_id))
  const textAdmin = await result('/tasks/' + ta, adminCookie)
  assert.equal(textAdmin.task.links.settings.config_id, cfg.id)
  assert.equal(textAdmin.task.links.activity.round_id, textRound)
  assert(textAdmin.task.actions.find((action: any) => action.type === 'view_log').href.includes('round_id=' + textRound))
})

test('project assets do not claim an unexecuted episode or step is completed', async () => {
  const data = await result('?project_id=' + pa.id)
  const episode = data.episodes.find((row: any) => row.id === ea3.id)
  assert.equal(episode.recorded, false)
  assert(episode.steps.every((step: any) => step.status === 'not_recorded'))
  const first = data.episodes.find((row: any) => row.id === ea.id)
  assert.equal(first.steps.find((step: any) => step.key === 'extract_characters').status, 'completed')
  assert.equal(first.steps.find((step: any) => step.key === 'extract_scenes').status, 'not_recorded')
})

test('many schema errors remain one task with a count and exact real task-round links', async () => {
  const data = await result('?project_id=' + pa.id + '&exceptions_only=1&limit=1')
  assert(data.tasks.items.every((task: any) => task.exception || task.stale))
  const task = (await result('/tasks/' + schemaActivity)).task
  assert.equal(task.exception.category, 'format')
  assert.equal(task.exception.count, 100)
  assert.equal(task.links.activity.task_id, schemaActivity)
  assert.equal(data.exceptions.filter((row: any) => row.id === schemaActivity).length, 1)
  assert.equal(data.summary.kinds.find((kind: any) => kind.kind === 'text').failed, 1)
})

test('stale is only an observation flag, GETs do not update progress or declare failure', async () => {
  const old = new Date(Date.now() - 900_000).toISOString()
  const id = activity.createActivityTask({ kind: 'video', title: 'Quiet upstream', projectId: pa.id, episodeId: ea.id })
  sql.prepare('UPDATE platform_activity_tasks SET created_at=?,started_at=?,updated_at=?,stage_started_at=? WHERE id=?').run(old, old, old, old, id)
  sql.prepare('UPDATE platform_activity_events SET created_at=? WHERE task_id=?').run(old, id)
  const before = activity.activityTask(id)
  const first = (await result('/tasks/' + id)).task
  const second = (await result('/tasks/' + id)).task
  assert.equal(first.status, 'running')
  assert.equal(first.stale, true)
  assert.equal(first.exception, null)
  assert.equal(second.last_progress_at, first.last_progress_at)
  assert.equal(activity.activityTask(id).updated_at, before.updated_at)
  activity.activityEvent(id, 'process', 'Unchanged poll heartbeat')
  assert.equal((await result('/tasks/' + id)).task.stale, true)
  activity.activityEvent(id, 'public_delta', 'Actual new output')
  assert.equal((await result('/tasks/' + id)).task.stale, false)
})

test('stage duration uses a real transition boundary; output updates do not reset it, legacy stays null', async () => {
  const id = activity.createActivityTask({ kind: 'text', title: 'Stage timing', projectId: pa.id, episodeId: ea.id })
  activity.updateActivityTask(id, { stage: 'generating' })
  const start = new Date(Date.now() - 80_000).toISOString()
  sql.prepare('UPDATE platform_activity_tasks SET stage_started_at=? WHERE id=?').run(start, id)
  activity.updateActivityTask(id, { stage: 'generating', output: { text: 'stream update' } })
  let task = (await result('/tasks/' + id)).task
  assert.equal(task.stage_started_at, start)
  assert(task.stage_elapsed_seconds >= 80)
  activity.updateActivityTask(id, { stage: 'validating' })
  task = (await result('/tasks/' + id)).task
  assert(task.stage_elapsed_seconds < 3)
  sql.prepare('UPDATE platform_activity_tasks SET stage_started_at=NULL WHERE id=?').run(id)
  assert.equal((await result('/tasks/' + id)).task.stage_elapsed_seconds, null)
  assert.equal(activity.activityTaskView(activity.activityTask(id)).stage_elapsed_seconds, null)
})

test('uncertain submissions take priority and no speculative generation action is offered', async () => {
  const task = (await result('/tasks/' + imageActivity)).task
  assert.equal(task.exception.category, 'submission_uncertain')
  assert.equal(task.exception.submission_uncertain, true)
  assert.match(task.exception.guidance, /避免重复/u)
  assert(task.actions.every((action: any) => /^view_/u.test(action.type)))
  const business = dashboard.classifyDashboardException({ status: 'failed', errorCode: 'business_error', error: 'HTTP 200 but task was rejected' })!
  assert.equal(business.category, 'channel')
  assert.equal(dashboard.classifyDashboardException({ status: 'interrupted', stage: 'needs_review', error: 'upstream returned a generic error without a status' })!.category, 'submission_uncertain')
  for (const [errorCode, error, category] of [
    ['private_media', 'PUBLIC_BASE_URL missing', 'local_material'], ['schema_error', 'invalid schema', 'format'],
    ['delivery_failed', 'download failed', 'delivery'], ['local_error', 'TypeError: not callable', 'program'],
  ]) assert.equal(dashboard.classifyDashboardException({ status: 'failed', errorCode, error })!.category, category)
})

test('diagnostics redact credentials, signed URLs and local paths; admin sees only legitimate config links', async () => {
  const id = activity.createActivityTask({ kind: 'text', title: 'Safe diagnostic', projectId: pa.id, episodeId: ea.id })
  activity.updateActivityTask(id, { status: 'failed', error: 'sk-SYNTHETIC-CREDENTIAL-123456 https://provider.invalid/result?token=secret C:\\private\\secret.png' })
  const data = await result('/diagnostics/' + id)
  const output = JSON.stringify(data)
  for (const forbidden of ['sk-SYNTHETIC', 'https://provider.invalid', 'C:\\private', 'token=secret']) assert(!output.includes(forbidden))
  assert.equal(data.observation.credentials_included, false)
  assert.equal(data.observation.hidden_reasoning_included, false)
  assert.equal(data.version, process.env.HUOBAO_VERSION || 'development')
  assert.equal(data.release, PLATFORM_RELEASE)
  const echoed = activity.createActivityTask({ kind: 'text', title: 'Provider echoed request', projectId: pa.id })
  activity.updateActivityTask(echoed, { status: 'failed', error: 'Upstream error: {"messages":[{"role":"system","content":"ECHOED_SYSTEM_MUST_STAY_PRIVATE"}]}' })
  assert(!JSON.stringify(await result('/diagnostics/' + echoed)).includes('ECHOED_SYSTEM_MUST_STAY_PRIVATE'))
})

test('only recorded provider HTTP status is returned and tombstoned bindings never produce fake settings links', async () => {
  const id = activity.createActivityTask({ kind: 'text', title: 'Observed SDK failure', projectId: pa.id, episodeId: ea.id, request: { config_id: cfg.id } })
  activity.updateActivityTask(id, { status: 'failed', error: 'Provider rejected request', result: { provider_http_status: 400 } })
  const task = (await result('/tasks/' + id)).task
  assert.equal(task.provider_http_status, 400)
  assert.equal(task.exception.provider_http_status, 400)
  const unknown = activity.createActivityTask({ kind: 'text', title: 'Unknown HTTP response', projectId: pa.id })
  activity.updateActivityTask(unknown, { status: 'failed', error: 'HTTP 429 appears in an unstructured message' })
  assert.equal((await result('/tasks/' + unknown)).task.provider_http_status, null)
  sql.prepare('UPDATE platform_channel_models SET deleted_at=? WHERE id=?').run(at, binding.id)
  try {
    const admin = (await result('/tasks/' + id, adminCookie)).task
    assert.equal(admin.links.settings, null)
    assert(admin.actions.every((action: any) => action.type !== 'view_settings'))
    assert.equal((await result('/tasks/' + imageActivity, adminCookie)).task.links.settings, null)
  } finally { sql.prepare('UPDATE platform_channel_models SET deleted_at=NULL WHERE id=?').run(binding.id) }
})

test('queued or blocked batch steps without activity are recorded honestly and counted separately', async () => {
  const batchId = 'dashboard-offline-batch'
  sql.prepare(`INSERT INTO platform_production_batches(id,drama_id,user_id,status,concurrency,config_id,model,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(batchId, pa.id, a.id, 'paused', 2, cfg.id, 'offline', '{}', at, at)
  for (const [id, target, status, error, code] of [['queued-step', 'characters', 'queued', null, null], ['blocked-step', 'scenes', 'blocked', '上一次结果待核对，未重新提交', 'needs_review']]) {
    sql.prepare(`INSERT INTO platform_production_steps(id,batch_id,drama_id,episode_id,episode_number,target,order_index,status,attempt,input_version,reused,error,error_code,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, batchId, pa.id, ea3.id, 3, target, 1, status, 0, 'unchanged-source', 0, error, code, at, at)
  }
  const before = Number((sql.prepare('SELECT count(*) n FROM platform_activity_tasks').get() as any).n)
  const data = await result('?project_id=' + pa.id)
  assert.equal(data.summary.batch_steps.queued, 1)
  assert.equal(data.summary.batch_steps.blocked, 1)
  assert.equal(Number((sql.prepare('SELECT count(*) n FROM platform_activity_tasks').get() as any).n), before)
  const episode = data.episodes.find((row: any) => row.id === ea3.id)
  assert.equal(episode.recorded, true)
  const queued = episode.steps.find((step: any) => step.key === 'extract_characters')
  assert.equal(queued.status, 'queued')
  assert.equal(queued.latest_task_id, null)
  assert.equal(queued.source, 'batch')
  assert.equal(data.batch_exceptions.length, 1)
  assert.match(data.batch_exceptions[0].href, /batch_id=dashboard-offline-batch/u)
  assert.equal(data.batch_exceptions[0].exception.category, 'submission_uncertain')
  const filtered = await result('?project_id=' + pa.id + '&exceptions_only=1')
  assert(filtered.episodes.some((row: any) => row.id === ea3.id))
})

test('lightweight history aggregation never sends large prompt/result snapshots or duplicates counts across pages', async () => {
  const huge = 'HUGE_DIAGNOSTIC_BODY_'.repeat(100_000)
  const id = activity.createActivityTask({ kind: 'text', title: 'Large historic snapshot', projectId: pa.id, request: { messages: [{ role: 'system', content: huge }] } })
  sql.prepare('UPDATE platform_activity_tasks SET output_json=?,result_json=? WHERE id=?').run(JSON.stringify({ text: huge }), JSON.stringify({ private: huge }), id)
  const one = await result('?project_id=' + pa.id + '&limit=1')
  const two = await result('?project_id=' + pa.id + '&limit=1&offset=1')
  assert.equal(one.summary.tasks_total, two.summary.tasks_total)
  assert.notEqual(one.tasks.items[0].id, two.tasks.items[0].id)
  assert(!JSON.stringify(one).includes('HUGE_DIAGNOSTIC_BODY_'))
  assert(JSON.stringify(one).length < 100_000)
})

test('prompt preparation is projected from its own persisted phase even when image generation fails', async () => {
  const {initAssetImagePreparation}=await import('../src/services/asset-image-preparation.ts');initAssetImagePreparation()
  const task=activity.createActivityTask({kind:'image',title:'Image with prompt preparation',projectId:pa.id,episodeId:ea.id})
  sql.prepare(`INSERT INTO platform_asset_image_jobs(id,asset_kind,asset_id,project_id,episode_id,user_id,status,activity_task_id,request_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'preparing_prompt',?,'{}',?,?)`).run('prompt-proof', 'character',character.id,pa.id,ea.id,a.id,task,at,at)
  let value=await result('?project_id='+pa.id)
  let step=value.episodes.find((e:any)=>e.id===ea.id).steps.find((s:any)=>s.key==='asset_prompt')
  assert.equal(step.status,'running');assert.equal(step.latest_task_id,task)
  const anchor=db.insert(schema.sysTask).values({type:'image',dramaId:pa.id,characterId:character.id,status:'failed',stage:'failed',createdAt:at,updatedAt:at}).returning().get()
  sql.prepare("UPDATE platform_asset_image_jobs SET status='completed',image_generation_id=?,finished_at=? WHERE id='prompt-proof'").run(anchor.id,at)
  activity.bindActivitySource(task,'media',String(anchor.id));syncMediaActivity(anchor.id)
  value=await result('?project_id='+pa.id)
  step=value.episodes.find((e:any)=>e.id===ea.id).steps.find((s:any)=>s.key==='asset_prompt')
  assert.equal(step.status,'ready');assert.equal(step.source,'preparation');assert.match(step.note,/复用/u)
  assert.equal(value.episodes.find((e:any)=>e.id===ea2.id).steps.find((s:any)=>s.key==='asset_prompt').status,'ready')
  const detail=await result('/tasks/'+task);assert.equal(detail.task.preparation.status,'ready')
  assert.equal(value.summary.tasks_total,sql.prepare('SELECT count(*) n FROM platform_activity_tasks WHERE project_id=?').get(pa.id)?.n)
})
test('image existence alone never synthesizes a prompt-preparation success', async () => {
  const only=db.insert(schema.sysTask).values({type:'image',dramaId:pa.id,status:'completed',stage:'completed',createdAt:at,updatedAt:at}).returning().get()
  const id=syncMediaActivity(only.id)!
  const detail=await result('/tasks/'+id);assert.equal(detail.task.preparation,null)
  assert.equal((await result('?project_id='+pa.id)).episodes.find((e:any)=>e.id===ea3.id).steps.find((s:any)=>s.key==='asset_prompt').status,'not_recorded')
})
after(async () => { initProductionBatches().close(); db.$client.close(); await fs.rm(folder, { recursive: true, force: true }) })
