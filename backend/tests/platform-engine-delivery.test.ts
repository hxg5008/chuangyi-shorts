import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import sharp from 'sharp'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-engine-delivery-'))
process.env.HUOBAO_DATA_DIR = root; process.env.SQLITE_PATH = path.join(root, 'test.sqlite3'); process.env.STORAGE_PATH = path.join(root, 'static'); process.env.MYSQL_AUTO_IMPORT = 'false'; process.env.HUOBAO_PROXY_URL = 'direct'
const { db, schema } = await import('../src/db/index.ts')
const security = await import('../src/services/platform-security/index.ts')
security.initPlatformSecurity()
const admin = security.listUsers().find(user => user.role === 'admin')!, owner = security.createUser('delivery-owner', 'Synthetic-owner-password').user, other = security.createUser('delivery-other', 'Synthetic-other-password').user
const at = new Date().toISOString()
const project = db.insert(schema.dramas).values({ title: 'Delivery fixture', ownerUserId: owner.id, createdAt: at, updatedAt: at }).returning().get()
const character = db.insert(schema.characters).values({ dramaId: project.id, name: 'Original character', imageUrl: 'static/images/original.png', createdAt: at, updatedAt: at }).returning().get()
const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#af7645' } }).png().toBuffer()
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom000000000000')])
let secondImageAvailable = false, imagePosts = 0, videoPosts = 0, cancelPosts = 0, cancels = 0, secondDownloads = 0, remoteState = 'pending'
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
  res.setHeader('content-type', 'application/json')
  if (req.url === '/v1/images' && req.method === 'POST') { imagePosts++; return res.end(JSON.stringify({ images: [{ url: base + '/one.png' }, { url: base + '/two.png' }] })) }
  if (req.url === '/v1/videos' && req.method === 'POST') { videoPosts++; return res.end(JSON.stringify({ videos: [{ url: base + '/one.mp4' }, { url: base + '/two.mp4' }] })) }
  if (req.url === '/v1/cancelable' && req.method === 'POST') { cancelPosts++; return res.end(JSON.stringify({ id: 'original-upstream-id', status: 'pending' })) }
  if (req.url === '/v1/cancelable/original-upstream-id' && req.method === 'DELETE') { cancels++; res.statusCode = 204; return res.end() }
  if (req.url === '/v1/cancelable/original-upstream-id') return res.end(JSON.stringify({ id: 'original-upstream-id', status: remoteState }))
  if (req.url === '/two.png') { secondDownloads++; if (!secondImageAvailable) { res.statusCode = 404; return res.end('{}') } }
  if (req.url === '/one.png' || req.url === '/two.png') { res.setHeader('content-type', 'image/png'); return res.end(png) }
  if (req.url === '/one.mp4' || req.url === '/two.mp4') { res.setHeader('content-type', 'video/mp4'); return res.end(mp4) }
  res.statusCode = 404; res.end('{}')
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + (server.address() as any).port
const { importProviderManifest } = await import('../src/services/model-channels/plugin-catalog.ts')
const { getModelChannelStore } = await import('../src/services/model-channels/store.ts')
const manifest = { apiVersion: 'yingce.plugin/v2', id: 'delivery-fixture', name: 'Delivery fixture', version: '1', contributes: { providers: [
  { id: 'delivery-image', label: 'Delivery image', capabilities: ['image'], scopes: ['creation'], auth: { type: 'bearer' }, create: { method: 'POST', path: '/v1/images', contentType: 'application/json', body: { prompt: { $ref: 'request.prompt' } } }, response: { status: 'succeeded', images: { $ref: 'response.images' } } },
  { id: 'delivery-video', label: 'Delivery video', capabilities: ['video'], scopes: ['creation'], auth: { type: 'bearer' }, create: { method: 'POST', path: '/v1/videos', contentType: 'application/json', body: { prompt: { $ref: 'request.prompt' } } }, response: { status: 'succeeded', videos: { $ref: 'response.videos' } } },
  { id: 'delivery-cancel', label: 'Delivery cancel', capabilities: ['video'], scopes: ['creation'], auth: { type: 'bearer' }, create: { method: 'POST', path: '/v1/cancelable', contentType: 'application/json', body: { prompt: { $ref: 'request.prompt' } } }, poll: { method: 'GET', path: '/v1/cancelable/{{taskId}}' }, cancel: { method: 'DELETE', path: '/v1/cancelable/{{taskId}}' }, response: { taskIdPaths: ['id'], statusPaths: ['status'] } },
] } }
await importProviderManifest(manifest)
const store = getModelChannelStore(), channel = store.saveChannel({ name: 'Local delivery', base_url: base, api_key: 'synthetic-delivery-key' })
const binding = (type: string, suffix: string) => store.saveBinding(channel.id, { type, name: suffix, model: 'native-' + suffix, protocol_id: 'engine.delivery-' + suffix, enabled: true })
const image = binding('image', 'image'), video = binding('video', 'video'), cancel = binding('video', 'cancel')
const generation = await import('../src/services/generation.ts')
const { syncMediaActivity } = await import('../src/services/activity/source-sync.ts')
const { activityTask, activityTaskView } = await import('../src/services/activity/store.ts')
const row = (id: number): any => db.$client.prepare('SELECT * FROM sys_task WHERE id=?').get(id)
async function until<T>(read: () => T, valid: (value: T) => boolean, ms = 20000) { const deadline = Date.now() + ms; for (;;) { const value = read(); if (valid(value)) return value; assert(Date.now() < deadline, 'Local delivery did not settle'); await new Promise(resolve => setTimeout(resolve, 25)) } }

test('all generated image results survive partial download and recovery; only the primary result is adopted, with per-user file access', async () => {
  const id = await security.runAsActor(owner, () => generation.generateImage({ dramaId: project.id, characterId: character.id, configId: image.config_id, prompt: '原始人物提示词 @人物 🌙' }))
  let record = await until(() => row(id), value => value.status === 'failed')
  let outputs = JSON.parse(record.params).outputImages
  assert.equal(outputs.length, 2); assert(outputs[0].local_path); assert(outputs[1].error)
  assert.equal((db.$client.prepare('SELECT image_url FROM characters WHERE id=?').get(character.id) as any).image_url, 'static/images/original.png')
  secondImageAvailable = true
  await security.runAsActor(owner, () => generation.recoverImageTask(id))
  record = await until(() => row(id), value => value.status === 'completed')
  outputs = JSON.parse(record.params).outputImages
  assert.equal(imagePosts, 1); assert.equal(secondDownloads, 2); assert(outputs.every((output: any) => output.local_path && !output.error))
  assert.equal(record.local_path, outputs[0].local_path)
  assert.equal((db.$client.prepare('SELECT image_url FROM characters WHERE id=?').get(character.id) as any).image_url, outputs[0].local_path)
  for (const output of outputs) { assert.deepEqual(await fs.readFile(path.join(root, output.local_path)), png); security.assertMediaAccess(output.local_path, owner); assert.throws(() => security.assertMediaAccess(output.local_path, other), /访问权限/u) }
  const activity = activityTaskView(activityTask(syncMediaActivity(id)!)); assert.equal(activity.result.output_images.length, 2)
})

test('multiple videos are all retained under unique names without extra generation or overwriting the first result', async () => {
  const id = await security.runAsActor(owner, () => generation.generateVideo({ dramaId: project.id, configId: video.config_id, prompt: '原始视频提示词' }))
  const record = await until(() => row(id), value => value.status === 'completed')
  const outputs = JSON.parse(record.params).outputVideos
  assert.equal(videoPosts, 1); assert.equal(outputs.length, 2); assert.notEqual(outputs[0].local_path, outputs[1].local_path); assert.equal(record.local_path, outputs[0].local_path)
  for (const output of outputs) { assert.deepEqual(await fs.readFile(path.join(root, output.local_path)), mp4); security.assertMediaAccess(output.local_path, owner) }
})

test('accepted cancellation remains pending until original upstream polling confirms it, without resubmitting generation', async () => {
  const id = await security.runAsActor(owner, () => generation.generateVideo({ dramaId: project.id, configId: cancel.config_id, prompt: 'Cancellation fixture' }))
  await until(() => row(id), value => value.task_id === 'original-upstream-id')
  await security.runAsActor(owner, () => generation.cancelGenerationTask(id))
  assert.equal(row(id).status, 'processing'); assert.equal(row(id).stage, 'cancelling'); assert.equal(cancels, 1)
  await security.runAsActor(owner, () => generation.cancelGenerationTask(id)); assert.equal(cancels, 1)
  remoteState = 'cancelled'
  const record = await until(() => row(id), value => value.status === 'cancelled')
  assert.equal(record.error_code, 'user_cancelled'); assert.equal(cancelPosts, 1); assert.equal(cancels, 1)
})

after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); const { shutdownProviderEngine } = await import('../src/services/provider-runtime/index.ts'); shutdownProviderEngine(); db.$client.close(); assert(path.basename(root).startsWith('huobao-engine-delivery-')); await fs.rm(root, { recursive: true, force: true }) })
