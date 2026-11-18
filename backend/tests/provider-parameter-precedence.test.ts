import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-provider-parameters-'))
process.env.HUOBAO_DATA_DIR = root
process.env.SQLITE_PATH = path.join(root, 'params.sqlite3')
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db } = await import('../src/db/index.ts')
const { engineGenerationRequest, ProtocolEngineImageAdapter } =
  await import('../src/services/adapters/protocol-engine-adapter.ts')
const { normalizeProviderParameters } = await import('../src/services/model-channels/parameters.ts')
const { shutdownProviderEngine } = await import('../src/services/provider-runtime/index.ts')
const manifest = JSON.parse(
  await fs.readFile(
    new URL('../src/services/model-channels/bundled/openai-images.json', import.meta.url),
    'utf8'
  )
)
const imageConfig: any = {
  serviceType: 'image',
  provider: 'yingce',
  baseUrl: 'https://synthetic.invalid',
  apiKey: 'synthetic',
  model: 'synthetic',
  protocolDefinition: { engine: 'yingce-v2', manifest, providerId: 'openai-image' },
  parameters: normalizeProviderParameters(manifest.contributes.providers[0])
}
test('asset flow fixed size wins plugin defaults and dynamic bindings; trial size reaches the actual serialized wire', async () => {
  const adapter = new ProtocolEngineImageAdapter(imageConfig)
  const locked = await adapter.buildGenerateRequest(imageConfig, {
    id: 1,
    model: 'synthetic',
    prompt: 'same',
    size: '1920x1080',
    flowSizeLocked: true,
    modelParameters: { size: '512x512' }
  })
  assert.equal(JSON.parse(locked.body as string).size, '1920x1080')
  const trial = await adapter.buildGenerateRequest(imageConfig, {
    id: 2,
    model: 'synthetic',
    prompt: 'same',
    size: '1920x1080',
    flowSizeLocked: false,
    modelParameters: { size: '512x512' }
  })
  assert.equal(JSON.parse(trial.body as string).size, '512x512')
  const request = engineGenerationRequest(imageConfig, {
    id: 1,
    size: '1920x1080',
    flowSizeLocked: true,
    modelParameters: { size: '512x512' }
  })
  assert.equal(request.output?.width, 1920)
  assert.equal(request.output?.height, 1080)
})
test('explicit video duration, ratio and audio flags win optional parameter and output bindings', () => {
  const config: any = {
    ...imageConfig,
    serviceType: 'video',
    parameters: [
      { key: 'duration', type: 'integer', label: 'Duration', binding: 'duration' },
      { key: 'aspectRatio', type: 'string', label: 'Ratio', binding: 'aspectRatio' },
      { key: 'generateAudio', type: 'boolean', label: 'Audio', binding: 'generateAudio' },
      { key: 'output', type: 'object', label: 'Output', binding: 'output' }
    ]
  }
  const request = engineGenerationRequest(config, {
    duration: 8,
    aspectRatio: '16:9',
    generateAudio: false,
    modelParameters: {
      duration: 15,
      aspectRatio: '9:16',
      generateAudio: true,
      output: { duration: 17, aspectRatio: '1:1', generateAudio: true }
    }
  })
  assert.equal(request.duration, 8)
  assert.equal(request.aspectRatio, '16:9')
  assert.equal(request.generateAudio, false)
  assert.equal(request.output?.duration, 8)
  assert.equal(request.output?.aspectRatio, '16:9')
  assert.equal(request.output?.generateAudio, false)
  const legacy = engineGenerationRequest(config, {
    duration: 8,
    generateAudio: 0,
    watermark: 1,
    promptExtend: 0,
    modelParameters: { generateAudio: true }
  })
  assert.equal(legacy.generateAudio, false)
  assert.equal(legacy.watermark, true)
  assert.equal(legacy.output?.generateAudio, false)
  assert.equal(legacy.output?.watermark, true)
  assert.throws(() => engineGenerationRequest(config, { generateAudio: '0' }), /必须为布尔值/)
})
test('operation and canonical output width height fps survive declared parameter binding and a saved request stays frozen', () => {
  const config: any = {
    ...imageConfig,
    parameters: [
      { key: 'operation', type: 'string', label: 'Operation' },
      { key: 'width', type: 'integer', label: 'Width', binding: 'output.width' },
      { key: 'height', type: 'integer', label: 'Height', binding: 'output.height' },
      { key: 'fps', type: 'number', label: 'FPS', binding: 'output.fps' }
    ]
  }
  const request = engineGenerationRequest(config, {
    modelParameters: { operation: 'edit', width: 1232, height: 704, fps: 24 }
  })
  assert.equal(request.operation, 'edit')
  assert.deepEqual(request.output, { width: 1232, height: 704, fps: 24 })
  assert.deepEqual(
    engineGenerationRequest(
      { ...config, model: 'new-sku' },
      { providerRequestSnapshot: request, modelParameters: { width: 512 } }
    ),
    request
  )
})
test.after(async () => {
  shutdownProviderEngine()
  db.$client.close()
  assert(path.basename(root).startsWith('huobao-provider-parameters-'))
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
