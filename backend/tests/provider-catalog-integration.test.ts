import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-provider-catalog-'))
process.env.HUOBAO_DATA_DIR = root
process.env.SQLITE_PATH = path.join(root, 'catalog.sqlite3')
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db } = await import('../src/db/index.ts')
const { getModelChannelStore } = await import('../src/services/model-channels/store.ts')
const { initializeProviderCatalog } = await import('../src/services/model-channels/plugin-catalog.ts')
const { shutdownProviderEngine } = await import('../src/services/provider-runtime/index.ts')
const { getConfiguredImageAdapter, getConfiguredVideoAdapter } =
  await import('../src/services/adapters/registry.ts')
const store = getModelChannelStore()
test('every bundled v2 generation provider is compiled and published with an executable capability contract', async () => {
  await initializeProviderCatalog(store)
  const directory = fileURLToPath(new URL('../src/services/model-channels/bundled/', import.meta.url)),
    expected = new Set<string>()
  for (const name of (await fs.readdir(directory)).filter((name) => name.endsWith('.json'))) {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'))
    for (const provider of manifest.contributes?.providers || []) expected.add('engine.' + provider.id)
  }
  const records = store.protocols().filter((protocol) => protocol.id.startsWith('engine.'))
  assert.deepEqual(new Set(records.map((record) => record.id)), expected)
  const unavailable = records.filter((record) => record.type !== 'audio' && !record.executable)
  assert.deepEqual(
    unavailable.map((record) => ({ id: record.id, reason: record.unavailable_reason })),
    []
  )
  for (const record of records) {
    assert(Array.isArray(record.parameters))
    assert(Array.isArray(record.auth_fields))
    assert.equal(record.definition.engine, 'yingce-v2')
    if (record.type === 'audio') {
      assert.equal(record.executable, false)
      assert(record.unavailable_reason)
    }
  }
  const before = records.map((record) => [record.id, record.version])
  for (const record of records) store.saveEngineProtocol(record)
  assert.deepEqual(
    store
      .protocols()
      .filter((record) => record.id.startsWith('engine.'))
      .map((record) => [record.id, record.version]),
    before,
    'Reimporting unchanged manifests must not create false protocol versions'
  )
})
test('engine image and video adapters preserve every returned item instead of dropping secondary outputs', async () => {
  const image = store.protocol('engine.openai-image')!,
    video = store.protocol('engine.replicate-prediction-video')!
  const imageConfig: any = {
    serviceType: 'image',
    provider: 'yingce',
    baseUrl: 'https://synthetic.invalid',
    apiKey: 'synthetic',
    model: 'synthetic',
    protocolDefinition: image.definition,
    parameters: image.parameters
  }
  const imageResponse = await getConfiguredImageAdapter(imageConfig).parseGenerateResponse({
    data: [{ url: 'https://synthetic.invalid/one.png' }, { url: 'https://synthetic.invalid/two.png' }]
  })
  assert.deepEqual(imageResponse.imageUrls, [
    'https://synthetic.invalid/one.png',
    'https://synthetic.invalid/two.png'
  ])
  assert.equal(imageResponse.imageUrl, imageResponse.imageUrls![0])
  const videoConfig: any = {
    ...imageConfig,
    serviceType: 'video',
    protocolDefinition: video.definition,
    parameters: video.parameters,
    generationRequest: { model: 'synthetic', taskId: 'existing' }
  }
  const videoResponse = await getConfiguredVideoAdapter(videoConfig).parsePollResponse({
    id: 'existing',
    status: 'succeeded',
    output: ['https://synthetic.invalid/one.mp4', 'https://synthetic.invalid/two.mp4']
  })
  assert.deepEqual(videoResponse.videoUrls, [
    'https://synthetic.invalid/one.mp4',
    'https://synthetic.invalid/two.mp4'
  ])
  assert.equal(videoResponse.videoUrl, videoResponse.videoUrls![0])
})
test.after(async () => {
  shutdownProviderEngine()
  db.$client.close()
  assert(path.basename(root).startsWith('huobao-provider-catalog-'))
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
