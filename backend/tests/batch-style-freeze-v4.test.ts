import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chuangyi-batch-style-'))
process.env.SQLITE_PATH = path.join(directory, 'db.sqlite3')
process.env.HUOBAO_DATA_DIR = directory
process.env.STORAGE_PATH = path.join(directory, 'static')
process.env.WORKSPACE_PATH = path.join(directory, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.HUOBAO_PROXY_URL = 'direct'
const { db, schema } = await import('../src/db/index.ts')
const security = await import('../src/services/platform-security/index.ts')
security.initPlatformSecurity()
const owner = security.createUser('style-batch-owner', 'synthetic-password').user
const { ProductionBatchManager } = await import('../src/services/production-batches.ts')
const { getModelChannelStore } = await import('../src/services/model-channels/store.ts')
const { getDramaStyleSnapshot, getDramaStylePrompt } = await import('../src/services/style-preset.ts')
const { currentActivity } = await import('../src/services/activity/context.ts')
const at = new Date().toISOString(), png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const prompts: string[] = [], storyboardStyles: any[] = []
let projectId = 0
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk
  res.setHeader('content-type', 'application/json')
  if (req.url !== '/v1/images/generations') { res.statusCode = 404; res.end('{}'); return }
  prompts.push(JSON.parse(raw).prompt)
  // A user changes the project between the first and later actual submissions.
  db.$client.prepare('UPDATE dramas SET style=? WHERE id=?').run('test-style-b', projectId)
  res.end(JSON.stringify({ data: [{ b64_json: png }] }))
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
let manager: InstanceType<typeof ProductionBatchManager> | undefined
after(async () => { manager?.close(); await manager?.settle(); await new Promise<void>(resolve => server.close(() => resolve())); db.$client.close(); await fs.rm(directory, { recursive: true, force: true }) })

test('one batch retains its server-captured style through async preparation, image submissions and later storyboard jobs', async () => {
  for (const [value, prompt] of [['test-style-a', '原定风格A'], ['test-style-b', '后来选择B']]) db.$client.prepare('INSERT INTO style_presets(name,value,prompt,is_active,created_at,updated_at) VALUES(?,?,?,1,?,?)').run(value, value, prompt, at, at)
  const store = getModelChannelStore(), url = `http://127.0.0.1:${(server.address() as any).port}`
  const channel = store.saveChannel({ name: 'local-style-image-fixture', base_url: url, api_key: 'mock-style-key' })
  const binding = store.saveBinding(channel.id, { name: 'style-image', model: 'style-fixture', type: 'image', protocol_id: 'image.openai', enabled: true })
  const project = db.insert(schema.dramas).values({ ownerUserId: owner.id, title: 'batch style', style: 'test-style-a', createdAt: at, updatedAt: at }).returning().get()
  projectId = project.id
  const episodes = [1, 2].map(episodeNumber => db.insert(schema.episodes).values({ dramaId: projectId, episodeNumber, title: `Episode ${episodeNumber}`, scriptContent: '人物走入房间。', imageConfigId: binding.config_id, createdAt: at, updatedAt: at } as any).returning().get())
  for (const ep of episodes) {
    const row = db.insert(schema.characters).values({ dramaId: projectId, name: `人物${ep.episodeNumber}`, finalPrompt: `原定风格A, 人物正文${ep.episodeNumber}`, createdAt: at, updatedAt: at }).returning().get()
    db.insert(schema.episodeCharacters).values({ episodeId: ep.id, characterId: row.id, createdAt: at }).run()
  }
  manager = new ProductionBatchManager(db.$client, { resolveChoice: async () => ({ configId: 7, model: 'text-fixture', parameters: {}, version: 'fixed' }), recipeVersion: () => 'fixed', pollMs: 10, submitGapMs: 0, autoDispatch: false,
    startStoryboard: async input => { storyboardStyles.push({ snapshot: structuredClone(currentActivity()?.styleSnapshot), context: await getDramaStylePrompt(input.dramaId) }); return { job_id: `mock-job-${input.episodeId}` } },
    readStoryboardJob: () => ({ id: 'mock', status: 'done', completed: 1, total: 1 }) })
  const batch = await manager.create({ drama_id: projectId, episode_ids: episodes.map(ep => ep.id), targets: ['images', 'storyboard'], image_concurrency: 1, styleSnapshot: { prompt: 'forged' }, style_snapshot: { prompt: 'forged' } } as any, owner)
  const captured = JSON.parse((db.$client.prepare('SELECT settings_json FROM platform_production_batches WHERE id=?').get(batch.id) as any).settings_json).style_snapshot
  assert.equal(captured.value, 'test-style-a')
  // Changing the project even before dispatch must not alter this accepted batch.
  db.$client.prepare('UPDATE dramas SET style=? WHERE id=?').run('test-style-b', projectId)
  for (let n = 0; n < 500; n++) { await manager.pump(); if (manager.get(batch.id, owner).status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 10)) }
  await manager.settle()
  assert.equal(manager.get(batch.id, owner).status, 'completed', JSON.stringify(manager.get(batch.id, owner)))
  assert.equal(prompts.length, 2)
  assert.ok(prompts.every(prompt => prompt.startsWith('原定风格A, ') && !prompt.includes('后来选择B') && !prompt.includes('forged')))
  const tasks = db.$client.prepare("SELECT params FROM sys_task WHERE type='image' AND drama_id=?").all(projectId) as any[]
  assert.equal(tasks.length, 2)
  assert.ok(tasks.every(row => JSON.parse(row.params).styleSnapshot.version === captured.version))
  const preparations = db.$client.prepare('SELECT request_json FROM platform_asset_image_jobs WHERE project_id=?').all(projectId) as any[]
  assert.ok(preparations.every(row => JSON.parse(row.request_json).styleSnapshot.version === captured.version))
  assert.equal(storyboardStyles.length, 2)
  assert.ok(storyboardStyles.every(row => row.snapshot.version === captured.version && row.context === '原定风格A'))
  assert.equal(getDramaStyleSnapshot(projectId)?.value, 'test-style-b')
})

test('an HTTP image request cannot supply the internal frozen style field', async () => {
  const episode = db.$client.prepare('SELECT id FROM episodes WHERE drama_id=? LIMIT 1').get(projectId) as any
  const asset = db.insert(schema.characters).values({ dramaId: projectId, name: 'manual', finalPrompt: '手动图片正文', createdAt: at, updatedAt: at }).returning().get()
  const routes = (await import('../src/routes/characters.ts')).default
  const response = await security.runAsActor(owner, () => routes.request(`/${asset.id}/generate-image`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ episode_id: episode.id, async_prepare: true, styleSnapshot: { value: 'test-style-a', template: 'forged {content}' }, style_snapshot: { value: 'forged' } }) }))
  assert.equal(response.status, 202)
  const data = (await response.json()).data
  let job: any
  for (let n = 0; n < 300; n++) { job = db.$client.prepare('SELECT * FROM platform_asset_image_jobs WHERE id=?').get(data.asset_job_id); if (job.status !== 'preparing_prompt') break; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.equal(job.status, 'completed', JSON.stringify(job))
  const saved = JSON.parse(job.request_json)
  assert.equal(saved.styleSnapshot.value, 'test-style-b')
  assert.equal(saved.request.styleSnapshot, undefined)
  assert.equal(saved.request.style_snapshot, undefined)
  const task = db.$client.prepare('SELECT prompt,params FROM sys_task WHERE id=?').get(job.image_generation_id) as any
  assert.equal(task.prompt, '后来选择B, 手动图片正文')
  assert.equal(JSON.parse(task.params).styleSnapshot.value, 'test-style-b')
  // Leave no real asynchronous image task running after this isolated fixture closes its database.
  for (let n = 0; n < 300; n++) { const state = db.$client.prepare('SELECT status FROM sys_task WHERE id=?').get(job.image_generation_id) as any; if (state.status === 'completed' || state.status === 'failed') break; await new Promise(resolve => setTimeout(resolve, 10)) }
})

test('two batches with different frozen styles do not share the same running asset or submit twice', async () => {
  manager?.close(); await manager?.settle()
  const project = db.insert(schema.dramas).values({ ownerUserId: owner.id, title: 'conflict project', style: 'test-style-a', createdAt: at, updatedAt: at }).returning().get()
  const episode = db.insert(schema.episodes).values({ dramaId: project.id, episodeNumber: 1, title: 'shared', scriptContent: '原文', createdAt: at, updatedAt: at }).returning().get()
  const secondEpisode = db.insert(schema.episodes).values({ dramaId: project.id, episodeNumber: 2, title: 'also shared', scriptContent: '第二集原文', createdAt: at, updatedAt: at }).returning().get()
  const asset = db.insert(schema.characters).values({ dramaId: project.id, name: 'shared person', finalPrompt: 'body', createdAt: at, updatedAt: at }).returning().get()
  db.insert(schema.episodeCharacters).values({ episodeId: episode.id, characterId: asset.id, createdAt: at }).run()
  db.insert(schema.episodeCharacters).values({ episodeId: secondEpisode.id, characterId: asset.id, createdAt: at }).run()
  let submissions = 0, finishFirst = false
  manager = new ProductionBatchManager(db.$client, { autoDispatch: false, pollMs: 5, submitGapMs: 0, recipeVersion: () => 'same', resolveChoice: async () => ({ configId: 7, model: 'text', parameters: {}, version: 'same' }),
    submitAssetImage: async (_kind, id) => {
      submissions++
      db.$client.prepare("INSERT INTO platform_asset_image_jobs(id,asset_kind,asset_id,project_id,episode_id,user_id,status,activity_task_id,request_json,created_at,updated_at) VALUES('style-conflict-job','character',?,?,?,?,'preparing_prompt','fixture',?,?,?)")
        .run(id, project.id, episode.id, owner.id, JSON.stringify({ request: {}, styleSnapshot: currentActivity()?.styleSnapshot }), at, at)
      return { assetJobId: 'style-conflict-job' }
    }, readImageOutcome: () => ({ state: finishFirst ? 'done' : 'pending' }) })
  const first = await manager.create({ drama_id: project.id, episode_ids: [episode.id], targets: ['images'] }, owner)
  for (let n = 0; n < 100 && !submissions; n++) { await manager.pump(); await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.equal(submissions, 1)
  db.$client.prepare('UPDATE dramas SET style=? WHERE id=?').run('test-style-b', project.id)
  const second = await manager.create({ drama_id: project.id, episode_ids: [secondEpisode.id], targets: ['images'] }, owner)
  for (let n = 0; n < 100; n++) { await manager.pump(); if (manager.get(second.id, owner).status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 5)) }
  const conflicting = manager.get(second.id, owner)
  assert.equal(conflicting.status, 'needs_review', JSON.stringify(conflicting))
  assert.equal(conflicting.steps[0].error_code, 'image_style_conflict')
  assert.equal(manager.get(first.id, owner).status, 'running', 'the original task continues untouched')
  assert.equal(submissions, 1, 'the second batch does not create a duplicate billed image')
  const routes = (await import('../src/routes/characters.ts')).default
  const response = await security.runAsActor(owner, () => routes.request(`/${asset.id}/generate-image`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ episode_id: episode.id, async_prepare: true }) }))
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error_code, 'image_style_conflict', 'preparation rechecks the race at the unique-asset boundary')
  finishFirst = true
  db.$client.prepare("UPDATE platform_asset_image_jobs SET status='completed' WHERE id='style-conflict-job'").run()
  for (let n = 0; n < 100 && manager.get(first.id, owner).status === 'running'; n++) { await manager.pump(); await new Promise(resolve => setTimeout(resolve, 5)) }
  await manager.settle()
  assert.equal(manager.get(first.id, owner).status, 'completed')
})
