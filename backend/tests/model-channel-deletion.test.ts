import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-channel-deletion-'))
process.env.HUOBAO_DATA_DIR = root
process.env.SQLITE_PATH = path.join(root, 'deletion.sqlite3')
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.ts')
const { getModelChannelStore, ModelChannelStore } = await import('../src/services/model-channels/store.ts')
const { getConfigById } = await import('../src/services/ai.ts')
const { generateImage } = await import('../src/services/generation.ts')
const { initPlatformSecurity, listUsers, runAsActor, assertModelAccess } =
  await import('../src/services/platform-security/index.ts')
const { modelChannelAdminRoutes, modelCatalogRoutes } = await import('../src/routes/model-channels.ts')
const aiConfigs = (await import('../src/routes/aiConfigs.ts')).default
const { initActivityStore, ensureActivitySource, activityTask, activitySource, updateActivityTask } =
  await import('../src/services/activity/store.ts')
initPlatformSecurity()
initActivityStore()
const admin = listUsers().find((user) => user.role === 'admin')!
const store = getModelChannelStore(),
  at = new Date().toISOString()
const spec = {
  name: 'Repeated synthetic image',
  model: 'same-image',
  type: 'image',
  protocol_id: 'image.openai'
}
const channel = store.saveChannel({
  name: 'Deletion test channel',
  base_url: 'https://synthetic.invalid',
  api_key: 'synthetic-private-key'
})
const binding = store.saveBinding(channel.id, spec)
await fs.mkdir(path.join(root, 'static', 'images'), { recursive: true })
const originalFile = Buffer.from('synthetic-existing-result-do-not-delete')
const originalPath = 'static/images/old-result.png'
await fs.writeFile(path.join(root, originalPath), originalFile)
const oldTask = db
  .insert(schema.sysTask)
  .values({
    type: 'image',
    status: 'completed',
    stage: 'completed',
    provider: 'openai',
    configId: binding.config_id,
    model: binding.model,
    prompt: 'Existing prompt must not change',
    resultUrl: 'https://synthetic.invalid/existing.png',
    localPath: originalPath,
    params: '{"existing":"keep","historyVersion":7}',
    createdAt: at,
    updatedAt: at
  })
  .returning()
  .get()
const sourceId = ensureActivitySource({
  kind: 'image',
  title: 'Existing historical source',
  userId: admin.id,
  sourceType: 'sys_task',
  sourceId: String(oldTask.id),
  model: binding.model
})
updateActivityTask(sourceId, { status: 'completed', output: { local_path: originalPath } })
const oldSource = activityTask(sourceId)
const readTask = () => db.select().from(schema.sysTask).where(eq(schema.sysTask.id, oldTask.id)).get()
async function adminRequest(url: string, method = 'GET', body?: unknown) {
  return runAsActor(admin, () =>
    modelChannelAdminRoutes.request(url, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    })
  )
}
async function models() {
  const response = await adminRequest(`/channels/${channel.id}/models`)
  assert.equal(response.status, 200)
  return (await response.json()).data
}

test('disable remains visible; DELETE removes the row from all model lists and retains task history and media', async () => {
  assert.equal(
    (await adminRequest(`/channels/${channel.id}/models/${binding.id}`, 'PUT', { enabled: false })).status,
    200
  )
  assert.equal((await models()).find((row: any) => row.id === binding.id)?.enabled, false)
  const deleted = await adminRequest(`/channels/${channel.id}/models/${binding.id}`, 'DELETE')
  assert.equal(deleted.status, 200)
  assert.deepEqual((await deleted.json()).data, { deleted: true, history_retained: true })
  assert(!(await models()).some((row: any) => row.id === binding.id))
  const channelResponse = await adminRequest('/channels')
  assert.equal(
    (await channelResponse.json()).data.channels.find((row: any) => row.id === channel.id).models.length,
    0
  )
  const publicResponse = await runAsActor(admin, () => modelCatalogRoutes.request('/?type=image'))
  assert(!(await publicResponse.json()).data.some((row: any) => row.config_id === binding.config_id))
  const legacy = await runAsActor(admin, () => aiConfigs.request('/?service_type=image'))
  assert(!(await legacy.json()).data.some((row: any) => row.id === binding.config_id))
  assert.equal((await runAsActor(admin, () => aiConfigs.request('/' + binding.config_id))).status, 404)
  assert.equal(store.binding(binding.id), null)
  assert(store.bindingForConfig(binding.config_id)?.deleted_at)
  assert.deepEqual(readTask(), oldTask)
  assert.deepEqual(activitySource('sys_task', String(oldTask.id)), oldSource)
  assert.deepEqual(await fs.readFile(path.join(root, originalPath)), originalFile)
})

test('migration, metadata refresh and a new store cannot resurrect deleted IDs, and old IDs cannot generate new tasks', async () => {
  store.migrateLegacy()
  const reopened = new ModelChannelStore(db.$client, root)
  reopened.migrateLegacy()
  assert.equal(reopened.binding(binding.id), null)
  assert.equal(reopened.bindings(channel.id).length, 0)
  assert.equal(
    (
      db.$client
        .prepare('SELECT COUNT(*) count FROM platform_channel_models WHERE config_id=?')
        .get(binding.config_id) as any
    ).count,
    1
  )
  assert.equal(
    (db.$client.prepare('SELECT is_active FROM ai_service_configs WHERE id=?').get(binding.config_id) as any)
      .is_active,
    0
  )
  assert.equal(await runAsActor(admin, () => getConfigById(binding.config_id)), null)
  assert.throws(
    () => runAsActor(admin, () => assertModelAccess(binding.config_id)),
    (error) => (error as any).status === 403
  )
  const count = (db.$client.prepare('SELECT COUNT(*) count FROM sys_task').get() as any).count
  await assert.rejects(
    runAsActor(admin, () => generateImage({ configId: binding.config_id, prompt: 'Must never submit' }))
  )
  assert.equal((db.$client.prepare('SELECT COUNT(*) count FROM sys_task').get() as any).count, count)
  assert.equal(
    (await adminRequest(`/channels/${channel.id}/models/${binding.id}`, 'PUT', { enabled: true })).status,
    400
  )
  const legacyUpdate = await runAsActor(admin, () =>
    aiConfigs.request('/' + binding.config_id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{"is_active":true}'
    })
  )
  assert.equal(legacyUpdate.status, 404)
  assert.deepEqual(readTask(), oldTask)
  assert.deepEqual(activityTask(sourceId), oldSource)
})

test('adding the same channel/type/model creates fresh binding and configuration IDs while the tombstone stays deleted', async () => {
  const response = await adminRequest(`/channels/${channel.id}/models`, 'POST', spec)
  assert.equal(response.status, 201)
  const added = (await response.json()).data
  assert.notEqual(added.id, binding.id)
  assert.notEqual(added.config_id, binding.config_id)
  assert.deepEqual(
    (await models()).map((row: any) => row.id),
    [added.id]
  )
  assert.equal(await getConfigById(binding.config_id), null)
  assert.equal((await getConfigById(added.config_id))?.model, binding.model)
  store.migrateLegacy()
  const reopened = new ModelChannelStore(db.$client, root)
  assert.deepEqual(
    reopened.bindings(channel.id).map((row) => row.id),
    [added.id]
  )
  assert(reopened.bindingForConfig(binding.config_id)?.deleted_at)
  assert.deepEqual(readTask(), oldTask)
  assert.deepEqual(await fs.readFile(path.join(root, originalPath)), originalFile)
})

test('empty and populated channel deletions hide their models permanently without deleting underlying history', async () => {
  const empty = store.saveChannel({ name: 'Empty channel', base_url: 'https://empty.synthetic.invalid' })
  assert.equal((await adminRequest(`/channels/${empty.id}`, 'DELETE')).status, 200)
  assert(!store.listChannels().some((row) => row.id === empty.id))
  const active = store.bindings(channel.id)[0]
  assert.equal((await adminRequest(`/channels/${channel.id}`, 'DELETE')).status, 200)
  assert(!store.listChannels().some((row) => row.id === channel.id))
  assert.equal(store.bindings(channel.id).length, 0)
  assert(store.bindingForConfig(active.config_id)?.deleted_at)
  new ModelChannelStore(db.$client, root).migrateLegacy()
  assert.equal((await models()).length, 0)
  assert.equal(await getConfigById(active.config_id), null)
  assert.deepEqual(readTask(), oldTask)
  assert.deepEqual(activityTask(sourceId), oldSource)
  assert.deepEqual(await fs.readFile(path.join(root, originalPath)), originalFile)
})

test.after(async () => {
  db.$client.close()
  const relative = path.relative(os.tmpdir(), root)
  assert(
    relative &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      path.basename(root).startsWith('huobao-channel-deletion-')
  )
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
