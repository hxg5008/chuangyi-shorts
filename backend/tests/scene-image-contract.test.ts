import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'

// Use only temporary data and a local HTTP image provider, never production services.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-scene-contract-'))
process.env.SQLITE_PATH = path.join(root, 'tasks.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.HUOBAO_IMAGE_CONCURRENCY = '2'
const { buildSceneImagePrompt, SCENE_IMAGE_SIZE, sceneImageOutput } = await import('../src/services/scene-image-contract.ts')
const { db, schema } = await import('../src/db/index.ts')
const { generateImage } = await import('../src/services/generation.ts')
const labels = ['正向视图', '45度斜侧视图', '反向视图', '90度垂直俯视图']
const sourcePrompt = '旧木家具与磨损墙面，暖色台灯从右侧投射，保留暗部、材质细节和冷暖反差，电影摄影质感。只生成单幅场景，不出现文字。'
const squareImage = await sharp({ create: { width: 1312, height: 1199, channels: 3, background: '#6b543d' } }).png().toBuffer()
const landscapeImage = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#6b543d' } }).png().toBuffer()
let currentImage = squareImage
let responseMode: 'url' | 'base64' = 'url'
const requests: { prompt: string; size: string; model: string }[] = []
let downloads = 0
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST') {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ data: [responseMode === 'base64'
      ? { b64_json: currentImage.toString('base64') }
      : { url: base + '/image.png' }] }))
    return
  }
  downloads++
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': currentImage.length })
  res.end(currentImage)
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as any).port}`
const ts = new Date().toISOString()
const config = db.insert(schema.aiServiceConfigs).values({ serviceType: 'image', provider: 'openai', name: 'local scene test',
  baseUrl: base, apiKey: 'test-only', model: '["gpt-image-2"]', createdAt: ts, updatedAt: ts }).returning().get()
const scene = db.insert(schema.scenes).values({ dramaId: 1, location: 'test scene', time: 'night', prompt: 'test scene',
  finalPrompt: sourcePrompt, createdAt: ts, updatedAt: ts }).returning().get()
const character = db.insert(schema.characters).values({ dramaId: 1, name: 'test character', createdAt: ts, updatedAt: ts }).returning().get()
const storyboard = db.insert(schema.storyboards).values({ episodeId: 1, storyboardNumber: 1, createdAt: ts, updatedAt: ts }).returning().get()
const row = (id: number) => db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()!
async function completed(id: number) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const task = row(id)
    if (task.status === 'completed') return task
    if (task.status === 'failed') assert.fail(`Local scene task ${id} failed: ${task.errorCode}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`Local scene task ${id} did not settle`)
}

test('scene contract preserves the original art and lighting, is idempotent and names all labels', () => {
  assert.equal(SCENE_IMAGE_SIZE, '1920x1080')
  const prompt = buildSceneImagePrompt(sourcePrompt)
  assert.ok(prompt.startsWith(sourcePrompt))
  assert.equal(buildSceneImagePrompt(prompt), prompt)
  for (const label of labels) assert.ok(prompt.includes(`“${label}”`), `Missing exact label ${label}`)
  assert.match(prompt, /16:9.*横向|横向.*16:9/)
  assert.match(prompt, /左上角/)
  assert.match(prompt, /黑色半透明.*白色文字/)
  assert.match(prompt, /保留.*光源|保留.*明暗/)
  assert.match(prompt, /冲突/)
})

test('ratio checks accept provider resolution changes and identify square or portrait boards', () => {
  assert.equal(sceneImageOutput(1659, 948).aspectRatioMatches, true)
  assert.equal(sceneImageOutput(1920, 1088).aspectRatioMatches, true)
  assert.equal(sceneImageOutput(1024, 1024).aspectRatioMatches, false)
  assert.equal(sceneImageOutput(900, 1600).aspectRatioMatches, false)
})

test('cached scene prompt gains the contract in the real request; near-square delivery stays completed with metadata', async () => {
  const before = requests.length
  const id = await generateImage({ sceneId: scene.id, prompt: sourcePrompt, size: '1024x1024', configId: config.id })
  const task = await completed(id)
  assert.equal(requests.length, before + 1)
  assert.equal(requests[before].model, 'gpt-image-2')
  assert.equal(requests[before].size, '1920x1088')
  assert.equal(requests[before].prompt, buildSceneImagePrompt(sourcePrompt))
  const params = JSON.parse(task.params!)
  assert.equal(params.size, SCENE_IMAGE_SIZE)
  assert.equal(params.sceneImageLayout, 'four-view-v1')
  assert.deepEqual(params.imageOutput, { width: 1312, height: 1199, expectedAspectRatio: '16:9', aspectRatioMatches: false })
  assert.equal(params.downloadProgress.receivedBytes, squareImage.length)
  assert.equal(task.status, 'completed')
  assert.equal(task.errorCode, null)
  assert.ok(task.localPath)
  // Central output requirements must not rewrite the cached user prompt.
  assert.equal(db.select().from(schema.scenes).where(eq(schema.scenes.id, scene.id)).get()!.finalPrompt, sourcePrompt)
})

test('character images and storyboard frames preserve their own prompt and size', async () => {
  currentImage = landscapeImage
  const originalSize = '1600x960'
  const examples = [
    { characterId: character.id },
    { sceneId: scene.id, storyboardId: storyboard.id, frameType: 'first_frame' },
    { sceneId: scene.id, frameType: 'last_frame' },
    { sceneId: scene.id, characterId: character.id },
    { sceneId: scene.id, propId: 99 },
  ]
  for (const target of examples) {
    const before = requests.length
    const prompt = 'local single image'
    const id = await generateImage({ ...target, prompt, size: originalSize, configId: config.id })
    const task = await completed(id)
    assert.equal(requests.length, before + 1)
    assert.equal(requests[before].prompt, prompt)
    assert.equal(requests[before].size, originalSize)
    const params = JSON.parse(task.params!)
    assert.equal(params.size, originalSize)
    assert.equal(params.sceneImageLayout, undefined)
  }
})

test('landscape base64 output records matching ratio without a download or another generation', async () => {
  responseMode = 'base64'
  currentImage = landscapeImage
  const before = { requests: requests.length, downloads }
  const id = await generateImage({ sceneId: scene.id, prompt: sourcePrompt, configId: config.id })
  const task = await completed(id)
  assert.equal(requests.length, before.requests + 1)
  assert.equal(downloads, before.downloads)
  assert.deepEqual(JSON.parse(task.params!).imageOutput, {
    width: 1600, height: 900, expectedAspectRatio: '16:9', aspectRatioMatches: true,
  })
  assert.equal(task.errorCode, null)
})

test.after(async () => {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.$client.close()
  await fs.rm(root, { recursive: true, force: true })
})
