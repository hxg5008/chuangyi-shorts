import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chuangyi-model-defaults-'))
Object.assign(process.env, { HUOBAO_DATA_DIR: root, SQLITE_PATH: path.join(root, 'test.sqlite3'), STORAGE_PATH: path.join(root, 'static'), WORKSPACE_PATH: path.join(root, 'workspace'), MYSQL_AUTO_IMPORT: 'false', HUOBAO_PROXY_URL: 'direct', DOTENV_CONFIG_PATH: path.join(root, 'empty.env') })
await fs.writeFile(process.env.DOTENV_CONFIG_PATH!, '')
const { db, schema } = await import('../src/db/index.ts')
const { getModelChannelStore } = await import('../src/services/model-channels/store.ts')
const { getActiveConfig, getConfigById } = await import('../src/services/ai.ts')
const { initPlatformSecurity, createUser, listUsers, runAsActor } = await import('../src/services/platform-security/index.ts')
const { modelChannelAdminRoutes } = await import('../src/routes/model-channels.ts')
const episodeRoutes = (await import('../src/routes/episodes.ts')).default
const aiRoutes = (await import('../src/routes/aiConfigs.ts')).default
const store = getModelChannelStore()
initPlatformSecurity()
const admin = listUsers().find(user => user.role === 'admin')!
const a = createUser('default-a', 'synthetic-password').user
const b = createUser('default-b', 'synthetic-password').user
const channel = store.saveChannel({ name: 'Defaults fixture', base_url: 'https://default.example.invalid', api_key: 'synthetic-defaults-only' })
const bind = (name: string, type: 'text'|'image'|'video', priority: number, extra: any = {}) => store.saveBinding(channel.id, { name, model: name, type, priority, protocol_id: type === 'text' ? 'text.openai-chat' : type === 'image' ? 'image.openai' : 'video.minimax', enabled: true, access: 'all', ...extra })
const textHigh = bind('text-high', 'text', 900)
const textDefault = bind('text-default', 'text', 1)
const imageOld = bind('image-old', 'image', 50)
const imageNew = bind('image-new', 'image', 1)
const video = bind('video-default', 'video', 0)
const selected = (type: 'text'|'image'|'video', actor = a) => runAsActor(actor, () => getActiveConfig(type))

after(async () => {
  db.$client.close()
  const target = await fs.realpath(root)
  const tempRoot = await fs.realpath(os.tmpdir())
  assert.equal(path.dirname(target).toLowerCase(), tempRoot.toLowerCase())
  assert.ok(path.basename(target).startsWith('chuangyi-model-defaults-'))
  await fs.rm(target, { recursive: true, force: true })
})

test('explicit defaults override priority independently for each type without changing priority or credentials', async () => {
  assert.equal((await selected('text'))?.id, textHigh.config_id)
  const priorities = db.$client.prepare('SELECT id,priority FROM ai_service_configs ORDER BY id').all()
  const secrets = db.$client.prepare('SELECT id,secret_blob FROM platform_model_channels ORDER BY id').all()
  store.setDefaultBinding(channel.id, textDefault.id)
  store.setDefaultBinding(channel.id, imageOld.id)
  store.setDefaultBinding(channel.id, video.id)
  assert.equal((await selected('text'))?.id, textDefault.config_id)
  assert.equal((await selected('image'))?.id, imageOld.config_id)
  assert.equal((await selected('video'))?.id, video.config_id)
  assert.deepEqual(db.$client.prepare('SELECT id,priority FROM ai_service_configs ORDER BY id').all(), priorities)
  assert.deepEqual(db.$client.prepare('SELECT id,secret_blob FROM platform_model_channels ORDER BY id').all(), secrets)
  assert.equal(store.binding(textDefault.id)?.is_default, true)
  assert.equal(store.binding(textHigh.id)?.is_default, false)
})

test('model default is filtered by user permission before selection', async () => {
  const restricted = bind('restricted-default', 'text', 0, { access: 'selected', allowed_user_ids: [a.id] })
  store.setDefaultBinding(channel.id, restricted.id)
  assert.equal((await selected('text', a))?.id, restricted.config_id)
  assert.equal((await selected('text', b))?.id, textHigh.config_id)
  assert.equal(await runAsActor(b, () => getConfigById(restricted.config_id)), null)
  store.setDefaultBinding(channel.id, textDefault.id)
})

test('default endpoint requires admin and does not mutate on unauthorized access', async () => {
  const before = db.$client.prepare('SELECT id,is_default FROM ai_service_configs ORDER BY id').all()
  const denied = await runAsActor(a, () => modelChannelAdminRoutes.request(`/channels/${channel.id}/models/${textHigh.id}/default`, { method: 'POST' }))
  assert.equal(denied.status, 403)
  assert.deepEqual(db.$client.prepare('SELECT id,is_default FROM ai_service_configs ORDER BY id').all(), before)
  const accepted = await runAsActor(admin, () => modelChannelAdminRoutes.request(`/channels/${channel.id}/models/${textDefault.id}/default`, { method: 'POST' }))
  assert.equal(accepted.status, 200)
  const result = await accepted.json() as any
  assert.equal(result.data.is_default, true)
})

test('disabled, foreign and missing models cannot replace the current default', () => {
  const disabled = bind('disabled-default', 'text', 1000, { enabled: false })
  const before = db.$client.prepare('SELECT id,is_default FROM ai_service_configs ORDER BY id').all()
  assert.throws(() => store.setDefaultBinding(channel.id, disabled.id), /启用/)
  assert.throws(() => store.setDefaultBinding(channel.id + 100, textHigh.id), /不属于/)
  assert.throws(() => store.setDefaultBinding(channel.id, 99999), /不属于/)
  assert.deepEqual(db.$client.prepare('SELECT id,is_default FROM ai_service_configs ORDER BY id').all(), before)
})

test('disabled channels and unavailable protocols cannot replace the current default', () => {
  const before = db.$client.prepare('SELECT id,is_default FROM ai_service_configs ORDER BY id').all()
  store.saveChannel({ enabled: false }, channel.id)
  assert.throws(() => store.setDefaultBinding(channel.id, textHigh.id))
  store.saveChannel({ enabled: true }, channel.id)
  const originalProtocol = store.binding(textHigh.id)!.protocol_id
  db.$client.prepare('UPDATE platform_channel_models SET protocol_id=? WHERE id=?').run('fixture.missing', textHigh.id)
  try {
    assert.throws(() => store.setDefaultBinding(channel.id, textHigh.id))
    assert.deepEqual(db.$client.prepare('SELECT id,is_default FROM ai_service_configs ORDER BY id').all(), before)
  } finally {
    db.$client.prepare('UPDATE platform_channel_models SET protocol_id=? WHERE id=?').run(originalProtocol, textHigh.id)
  }
})

test('a disabled default falls back only to a currently allowed model and explicit invalid IDs stay invalid', async () => {
  store.setDefaultBinding(channel.id, textDefault.id)
  store.saveBinding(channel.id, { enabled: false }, textDefault.id)
  assert.equal((await selected('text'))?.id, textHigh.config_id)
  assert.equal(await runAsActor(a, () => getConfigById(textDefault.config_id)), null)
  store.saveBinding(channel.id, { enabled: true }, textDefault.id)
  assert.equal((await selected('text'))?.id, textDefault.config_id)
})

test('AI compatibility list reports default first while retaining original config IDs', async () => {
  const response = await runAsActor(a, () => aiRoutes.request('/?service_type=text'))
  assert.equal(response.status, 200)
  const data = (await response.json() as any).data
  assert.equal(data[0].id, textDefault.config_id)
  assert.equal(data[0].is_default, true)
  assert.ok(data.some((row: any) => row.id === textHigh.config_id))
})

test('new episodes adopt defaults but switching defaults never edits existing episode model locks', async () => {
  const at = new Date().toISOString()
  const project = db.insert(schema.dramas).values({ title: 'Default model preservation', ownerUserId: a.id, createdAt: at, updatedAt: at }).returning().get()
  store.setDefaultBinding(channel.id, imageOld.id)
  const create = async () => {
    const response = await runAsActor(a, () => episodeRoutes.request('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ drama_id: project.id }) }))
    assert.equal(response.status, 200)
    return (await response.json() as any).data
  }
  const first = await create()
  assert.equal(first.image_config_id, imageOld.config_id)
  assert.equal(first.video_config_id, video.config_id)
  store.setDefaultBinding(channel.id, imageNew.id)
  const second = await create()
  assert.equal(second.image_config_id, imageNew.config_id)
  const persisted = db.$client.prepare('SELECT image_config_id,video_config_id FROM episodes WHERE id=?').get(first.id) as any
  assert.equal(persisted.image_config_id, imageOld.config_id)
  assert.equal(persisted.video_config_id, video.config_id)
})

test('changing a default model to another type clears its flag without disturbing the target type default', () => {
  store.setDefaultBinding(channel.id, textDefault.id)
  store.setDefaultBinding(channel.id, imageNew.id)
  store.saveBinding(channel.id, { type: 'image', protocol_id: 'image.openai' }, textDefault.id)
  assert.equal(store.binding(textDefault.id)?.is_default, false)
  assert.equal(store.binding(imageNew.id)?.is_default, true)
})
