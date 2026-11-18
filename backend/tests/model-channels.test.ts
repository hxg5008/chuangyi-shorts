import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-channels-'))
process.env.HUOBAO_DATA_DIR = root
process.env.SQLITE_PATH = path.join(root, 'channels.sqlite3')
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.HUOBAO_PROXY_URL = 'direct'
const { db } = await import('../src/db/index.ts')
const sql = db.$client,
  at = new Date().toISOString(),
  key = 'sk-synthetic-channel-one'
const legacy = sql.prepare(
  'INSERT INTO ai_service_configs(service_type,provider,name,base_url,api_key,model,priority,is_active,created_at,updated_at)VALUES(?,?,?,?,?,?,?,1,?,?)'
)
const textId = Number(
  legacy.run(
    'text',
    'openai',
    'legacy text',
    'https://example.invalid',
    key,
    '["same-model","text-b"]',
    100,
    at,
    at
  ).lastInsertRowid
)
const imageId = Number(
  legacy.run('image', 'openai', 'legacy image', 'https://example.invalid', key, '["gpt-image-2"]', 90, at, at)
    .lastInsertRowid
)
const { getModelChannelStore, ModelChannelStore } = await import('../src/services/model-channels/store.ts')
const { validateJsonProtocol } = await import('../src/services/model-channels/protocols.ts')
const { getConfiguredImageAdapter, getConfiguredVideoAdapter } =
  await import('../src/services/adapters/registry.ts')
const { getConfigById, assertConfiguredModel, assertConfigService } = await import('../src/services/ai.ts')
const { redactRuntimeSecrets } = await import('../src/utils/secret-redaction.ts')
const { initPlatformSecurity, listUsers, createUser, runAsActor } =
  await import('../src/services/platform-security/index.ts')
const { modelChannelAdminRoutes, modelCatalogRoutes } = await import('../src/routes/model-channels.ts')
const aiConfigs = (await import('../src/routes/aiConfigs.ts')).default
const store = getModelChannelStore()
initPlatformSecurity()
const admin = listUsers().find((u) => u.role === 'admin')!
const userA = createUser('channel-user-a', 'synthetic-password-a').user
const userB = createUser('channel-user-b', 'synthetic-password-b').user

test('legacy model migration preserves the original first IDs, splits stable bindings and encrypts shared credentials', () => {
  const channels = store.listChannels()
  assert.equal(channels.length, 1)
  assert.equal(store.bindingForConfig(textId)?.model, 'same-model')
  assert.equal(
    (sql.prepare('SELECT model FROM ai_service_configs WHERE id=?').get(textId) as any).model,
    '["same-model","text-b"]'
  )
  assert.equal(store.bindingForConfig(imageId)?.model, 'gpt-image-2')
  assert.equal(store.bindings().length, 3)
  assert.equal(new Set(store.bindings().map((b) => b.config_id)).size, 3)
  assert.equal(store.resolve(textId, admin)?.apiKey, key)
  assert(
    sql
      .prepare('SELECT api_key FROM ai_service_configs')
      .all()
      .every((r: any) => r.api_key === '')
  )
  assert(!JSON.stringify(sql.prepare('SELECT * FROM platform_model_channels').all()).includes(key))
  assert(!JSON.stringify(channels).includes(key))
  store.migrateLegacy()
  assert.equal(store.bindings().length, 3)
})

test('a restarted vault can resolve the same key without changing its private encryption key', () => {
  const restarted = new ModelChannelStore(sql, root)
  assert.equal(restarted.resolve(textId, admin)?.apiKey, key)
  assert.equal(restarted.listChannels().length, 1)
})

let alternateId = 0,
  restrictedConfig = 0,
  channelId = 0
test('two channels may expose the same upstream model while stable configuration IDs and authorization remain distinct', () => {
  const channel = store.saveChannel({
    name: 'Second channel',
    base_url: 'https://second.example.invalid/v1',
    api_key: 'sk-second-synthetic',
    headers: { 'X-Private-Key': 'synthetic-header-secret' }
  })
  channelId = channel.id
  const binding = store.saveBinding(channel.id, {
    name: 'Same model from second channel',
    model: 'same-model',
    type: 'text',
    protocol_id: 'text.openai-chat',
    access: 'selected',
    allowed_user_ids: [userA.id]
  })
  alternateId = binding.id
  restrictedConfig = binding.config_id
  assert.notEqual(binding.config_id, textId)
  assert(store.resolve(binding.config_id, userA))
  assert.equal(store.resolve(binding.config_id, userB), null)
  assert.equal(store.resolve(binding.config_id, userA)?.headers['X-Private-Key'], 'synthetic-header-secret')
  assert(!JSON.stringify(store.listChannels()).includes('synthetic-header-secret'))
  assert(!JSON.stringify(store.publicModels(userB)).includes('Same model from second channel'))
})

test('public model and legacy configuration responses expose no URL, Key, secret headers or unauthorized models', async () => {
  const response = await runAsActor(userA, () => aiConfigs.request('/?service_type=text'))
  assert.equal(response.status, 200)
  const value = await response.json()
  const own = value.data.find((r: any) => r.id === restrictedConfig)
  assert.equal(own.model[0], 'same-model')
  assert.equal(own.base_url, '')
  assert.equal(own.api_key, '')
  assert.equal(own.display_name, 'Same model from second channel')
  assert.equal(own.channel_name, 'Second channel')
  assert(!JSON.stringify(value).includes('second.example.invalid'))
  assert(!JSON.stringify(value).includes('sk-second-synthetic'))
  const denied = await runAsActor(userB, () => aiConfigs.request('/' + restrictedConfig))
  assert.equal(denied.status, 404)
  const directory = await runAsActor(userB, () => modelCatalogRoutes.request('/?type=text'))
  const publicValue = await directory.json()
  assert(!publicValue.data.some((r: any) => r.config_id === restrictedConfig))
  assert(!JSON.stringify(publicValue).includes('base_url'))
})

test('runtime model resolution applies the same binding permission and prevents upstream model substitution', async () => {
  assert.equal(await runAsActor(userB, () => getConfigById(restrictedConfig)), null)
  const config = await runAsActor(userA, () => getConfigById(restrictedConfig))
  assert(config)
  assert.equal(config.bindingId, alternateId)
  assert.equal(config.serviceType, 'text')
  assert.doesNotThrow(() => assertConfigService(config, 'text'))
  assert.throws(() => assertConfigService(config, 'image'), /不支持图片任务/)
  assert.equal(assertConfiguredModel(config, 'same-model'), 'same-model')
  assert.throws(() => assertConfiguredModel(config, 'not-authorized-model'), /绑定不一致/)
  const imageConfig = {
    ...config,
    serviceType: 'image' as const,
    provider: 'openai',
    model: 'gpt-image-2',
    headers: { authorization: 'Bearer synthetic-header-override' }
  }
  const imageRequest = getConfiguredImageAdapter(imageConfig).buildGenerateRequest(imageConfig, {
    id: 1,
    prompt: 'synthetic'
  })
  assert.equal(
    Object.keys(imageRequest.headers).filter((key) => key.toLowerCase() === 'authorization').length,
    1
  )
  assert.equal(imageRequest.headers.authorization, 'Bearer synthetic-header-override')
})

test('admin model endpoints reject ordinary users and never return secret channel values', async () => {
  await assert.rejects(
    runAsActor(userA, async () => {
      const response = await modelChannelAdminRoutes.request('/channels')
      if (response.status === 403 || response.status === 401) throw Error('denied')
      assert.fail('Ordinary user reached channel administration')
    }),
    /denied/
  )
  const response = await runAsActor(admin, () => modelChannelAdminRoutes.request('/channels'))
  assert.equal(response.status, 200)
  const value = await response.json()
  assert(value.data.channels.some((c: any) => c.id === channelId && c.has_key))
  assert(!JSON.stringify(value).includes('sk-second-synthetic'))
  assert(!JSON.stringify(value).includes('synthetic-header-secret'))
})

const definition = {
  type: 'image' as const,
  create: {
    method: 'POST' as const,
    path: '/jobs',
    body: {
      model: '{{model}}',
      prompt: '{{prompt}}',
      images: '{{referenceImageUrls}}',
      quality: '{{parameters.quality}}'
    }
  },
  poll: { method: 'GET' as const, path: '/jobs/{{taskId}}' },
  response: {
    task_id: 'data.id',
    status: 'data.state',
    result_url: 'data.result',
    base64: 'data.pixels',
    error: 'data.reason',
    succeeded: ['ready'],
    failed: ['rejected'],
    queued: ['waiting']
  }
}
test('declarative profiles preserve prompt and ordered duplicate references and explicitly map create, query and failures', async () => {
  store.saveProtocol({ id: 'custom.synthetic-image', name: 'Synthetic JSON image', definition })
  const b = store.saveBinding(channelId, {
    type: 'image',
    name: 'Synthetic custom image',
    model: 'custom-image',
    protocol_id: 'custom.synthetic-image',
    defaults: { quality: 'high' }
  })
  const config = store.resolve(b.config_id, admin)!,
    adapter = getConfiguredImageAdapter(config)
  const prompt = '🌙@人物从桌边走过。\n中文、emoji与换行完整。',
    refs = [
      'https://first.example.invalid/a.png',
      'https://first.example.invalid/a.png',
      'data:image/png;base64,AA=='
    ]
  const req = adapter.buildGenerateRequest(config, { id: 1, prompt, referenceImages: JSON.stringify(refs) })
  assert.equal(req.body.prompt, prompt)
  assert.deepEqual(req.body.images, refs)
  assert.equal(req.body.quality, 'high')
  assert.equal(req.headers['X-Private-Key'], 'synthetic-header-secret')
  assert.equal(
    adapter.parseGenerateResponse({ data: { id: 'original', state: 'waiting' } }).taskId,
    'original'
  )
  assert.equal(adapter.parsePollResponse({ data: { id: 'original', state: 'waiting' } }).status, 'pending')
  assert.equal(
    adapter.buildPollRequest(config, 'original/id').url,
    'https://second.example.invalid/v1/jobs/original%2Fid'
  )
  const postPoll = getConfiguredImageAdapter({
    ...config,
    protocolDefinition: {
      ...definition,
      poll: { method: 'POST', path: '/query/{{model}}', body: { id: '{{taskId}}' } }
    }
  })
  const query = postPoll.buildPollRequest({ ...config, model: 'org/image' }, 'original/id')
  assert.equal(query.url, 'https://second.example.invalid/v1/query/org%2Fimage')
  assert.deepEqual(
    query.body,
    { id: 'original/id' },
    'Only path components may be URL encoded; JSON task IDs stay exact'
  )
  const mappedProgress = getConfiguredImageAdapter({
    ...config,
    protocolDefinition: {
      ...definition,
      response: { ...definition.response, progress: 'data.metrics.percent', stage: 'data.phase' }
    }
  })
  const progress = await mappedProgress.parsePollResponse({
    data: { state: 'waiting', metrics: { percent: '42%' }, phase: 'rendering' }
  })
  assert.equal(progress.progress, 42)
  assert.equal(progress.stage, 'rendering')
  assert.equal(
    adapter.parsePollResponse({ data: { state: 'rejected', reason: 'explicit synthetic rejection' } }).error,
    'explicit synthetic rejection'
  )
  assert.deepEqual(adapter.extractImageBase64({ data: { state: 'ready', pixels: 'synthetic-pixels' } }), {
    data: 'synthetic-pixels',
    mimeType: 'image/png'
  })
  const noReferenceMapping = getConfiguredImageAdapter({
    ...config,
    protocolDefinition: {
      ...definition,
      create: { ...definition.create, body: { model: '{{model}}', prompt: '{{prompt}}' } }
    }
  })
  assert.throws(
    () =>
      noReferenceMapping.buildGenerateRequest(config, {
        id: 1,
        prompt,
        referenceImages: JSON.stringify(refs)
      }),
    /未映射参考图片/
  )
  const videoAdapter = getConfiguredVideoAdapter({
    ...config,
    serviceType: 'video',
    protocolDefinition: { ...definition, type: 'video' }
  })
  assert.throws(
    () =>
      videoAdapter.buildGenerateRequest(config, {
        id: 1,
        prompt,
        referenceAudioUrls: '["https://synthetic.invalid/audio.mp3"]'
      }),
    /未映射参考音频/
  )
})

test('unsupported script, cross-host operation, mismatched capability and credential headers are rejected', () => {
  assert.throws(
    () => validateJsonProtocol({ ...definition, upload: { method: 'POST', path: '/upload' } }),
    /不支持/
  )
  assert.throws(
    () =>
      store.saveBinding(channelId, {
        type: 'image',
        name: 'invalid bounds',
        model: 'image',
        protocol_id: 'image.openai',
        capabilities: { max_images: 'four' }
      }),
    /max_images/
  )
  assert.throws(
    () =>
      store.saveBinding(channelId, {
        type: 'video',
        name: 'invalid times',
        model: 'video',
        protocol_id: 'video.minimax',
        capabilities: { min_duration: 20, max_duration: 5 }
      }),
    /最短时长/
  )
  assert.throws(
    () =>
      validateJsonProtocol({ ...definition, create: { ...definition.create, path: '//other.invalid/run' } }),
    /安全/
  )
  assert.throws(
    () => validateJsonProtocol({ ...definition, poll: { method: 'GET', path: '/jobs/{{prompt}}' } }),
    /请求路径/
  )
  assert.throws(
    () => validateJsonProtocol({ ...definition, poll: { method: 'GET', path: '/%2e%2e/private' } }),
    /安全/
  )
  assert.throws(
    () =>
      validateJsonProtocol({
        ...definition,
        create: { ...definition.create, body: { command: '{{process.env}}' } }
      }),
    /未登记变量/
  )
  assert.throws(
    () =>
      store.saveBinding(channelId, { type: 'video', name: 'wrong', model: 'x', protocol_id: 'image.openai' }),
    /类型与协议/
  )
  assert.throws(
    () =>
      store.saveChannel({
        name: 'unsafe',
        base_url: 'https://example.invalid',
        headers: { Cookie: 'synthetic' }
      }),
    /请求头/
  )
  assert.throws(
    () => store.saveChannel({ name: 'unsafe', base_url: 'https://u:p@example.invalid' }),
    /登录信息/
  )
})

test('channel edits retain a saved secret, disabling a channel blocks new model resolution while retaining history', () => {
  store.saveChannel(
    { name: 'Second channel updated', base_url: 'https://second.example.invalid/v1', api_key: '' },
    channelId
  )
  assert.equal(store.resolve(restrictedConfig, admin)?.apiKey, 'sk-second-synthetic')
  store.saveChannel({ enabled: false }, channelId)
  assert.equal(store.resolve(restrictedConfig, userA), null)
  assert(store.binding(alternateId))
  store.saveChannel({ enabled: true }, channelId)
  assert.equal(
    redactRuntimeSecrets('sk-second-synthetic synthetic-header-secret'),
    '[凭据已隐藏] [凭据已隐藏]'
  )
})

test('legacy metadata edits preserve specialized protocols and disabled unknown providers still encrypt credentials', () => {
  const binding = store.saveBinding(channelId, {
    name: 'Official local image',
    type: 'image',
    model: 'imagegen',
    protocol_id: 'image.gpt-local'
  })
  sql.prepare('UPDATE ai_service_configs SET priority=? WHERE id=?').run(123, binding.config_id)
  store.syncLegacy(binding.config_id, { priority: 123 })
  assert.equal(store.binding(binding.id)?.protocol_id, 'image.gpt-local')
  assert.equal(store.resolve(binding.config_id, admin)?.capabilities.max_concurrency, 4)
  const unknown = Number(
    legacy.run(
      'image',
      'unknown-provider',
      'Unknown legacy',
      'https://unknown.example.invalid',
      'synthetic-unknown-key',
      '["unknown-model"]',
      1,
      at,
      at
    ).lastInsertRowid
  )
  store.migrateLegacy()
  assert.equal(
    (sql.prepare('SELECT api_key FROM ai_service_configs WHERE id=?').get(unknown) as any).api_key,
    ''
  )
  assert.equal(store.bindingForConfig(unknown)?.protocol_id, 'legacy.unavailable')
  assert.equal(store.resolve(unknown, admin), null)
})

test('public protocol/default metadata rejects embedded credential fields and keeps a resolved version stable', () => {
  assert.throws(
    () =>
      validateJsonProtocol({
        ...definition,
        create: { ...definition.create, body: { request: { apiKey: 'synthetic' } } }
      }),
    /凭据/
  )
  assert.throws(
    () =>
      store.saveBinding(channelId, {
        name: 'Invalid defaults',
        type: 'image',
        model: 'x',
        protocol_id: 'image.openai',
        defaults: { nested: { access_token: 'synthetic' } }
      }),
    /凭据/
  )
  assert.throws(
    () =>
      store.saveBinding(channelId, {
        name: 'Invalid caps',
        type: 'image',
        model: 'x',
        protocol_id: 'image.openai',
        capabilities: { secret: 'synthetic' }
      }),
    /凭据/
  )
  const binding = store.bindings(channelId).find((b) => b.protocol_id === 'custom.synthetic-image')!
  const frozen = store.resolve(binding.config_id, admin)!
  store.saveProtocol({
    id: 'custom.synthetic-image',
    name: 'Updated JSON image',
    definition: { ...definition, create: { ...definition.create, path: '/new-jobs' } }
  })
  const current = store.resolve(binding.config_id, admin)!
  assert.equal(current.protocolVersion, frozen.protocolVersion + 1)
  assert.equal(
    getConfiguredImageAdapter(frozen).buildGenerateRequest(frozen, { id: 1, prompt: 'unchanged' }).url,
    'https://second.example.invalid/v1/jobs'
  )
  assert.equal(
    getConfiguredImageAdapter(current).buildGenerateRequest(current, { id: 1, prompt: 'unchanged' }).url,
    'https://second.example.invalid/v1/new-jobs'
  )
})

test('model directory and connection checks only issue authenticated GET requests, not generation requests', async () => {
  const requests: { method: string; path: string }[] = []
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method!, path: req.url! })
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'remote-model', modality: 'image' }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const channel = store.saveChannel({
      name: 'Local synthetic catalog',
      base_url: `http://127.0.0.1:${(server.address() as any).port}`,
      api_key: 'synthetic-catalog-key'
    })
    for (const op of ['catalog', 'test']) {
      const response = await runAsActor(admin, () =>
        modelChannelAdminRoutes.request(`/channels/${channel.id}/${op}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        })
      )
      assert.equal(response.status, 200)
      const value = await response.json()
      assert.equal(value.data.ok, true)
      assert.equal(value.data.inference_submitted, false)
      assert.equal(value.data.models[0].id, 'remote-model')
    }
    assert.deepEqual(requests, [
      { method: 'GET', path: '/v1/models' },
      { method: 'GET', path: '/v1/models' }
    ])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('legacy connection checks never send generation POSTs and unsupported read-only probes remain unverified', async () => {
  const requests: { method: string; path: string; body: string }[] = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk.toString()
    requests.push({ method: req.method!, path: req.url!, body })
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ data: [{ id: 'synthetic' }], models: [{ name: 'models/synthetic' }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`
    for (const [provider, service_type] of [
      ['openai', 'text'],
      ['gemini', 'text'],
      ['volcengine', 'video'],
      ['minimax', 'video'],
      ['aliyun', 'video']
    ]) {
      const response = await runAsActor(admin, () =>
        aiConfigs.request('/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider,
            service_type,
            base_url: baseUrl,
            api_key: 'synthetic-probe-secret',
            model: ['synthetic']
          })
        })
      )
      assert.equal(response.status, 200)
      const value = await response.json()
      assert.equal(value.data.inference_submitted, false)
      if (['minimax', 'aliyun'].includes(provider)) {
        assert.equal(value.data.verified, false)
        assert.equal(value.data.ok, false)
      }
      assert(!JSON.stringify(value).includes('synthetic-probe-secret'))
    }
    assert.deepEqual(requests, [
      { method: 'GET', path: '/v1/models', body: '' },
      { method: 'GET', path: '/v1beta/models', body: '' },
      { method: 'GET', path: '/api/v3/models', body: '' }
    ])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('upgrading the native Jimeng v1 default enables nine images and preserves custom limits', () => {
  const channel=store.saveChannel({name:'native-limit-fixture',base_url:'http://127.0.0.1:5690',api_key:'synthetic-nine'})
  const binding=store.saveBinding(channel.id,{name:'native-nine',model:'jimeng-2.0-fast',type:'video',protocol_id:'video.jimeng-local'})
  const lower=store.saveBinding(channel.id,{name:'native-lower',model:'jimeng-2.0-fast',type:'video',protocol_id:'video.jimeng-local',capabilities:{max_images:5}})
  sql.prepare("UPDATE platform_model_protocols SET version=1,capabilities_json=? WHERE id='video.jimeng-local'").run(JSON.stringify({reference_images:true,max_images:8}))
  sql.prepare('UPDATE platform_channel_models SET capabilities_json=? WHERE id=?').run(JSON.stringify({max_images:8,reference_images:true}),binding.id)
  const before=sql.prepare('SELECT secret_blob FROM platform_model_channels WHERE id=?').get(channel.id)
  const reopened=new ModelChannelStore(sql,root)
  assert.equal(reopened.protocol('video.jimeng-local')!.capabilities.max_images,9)
  assert.equal(reopened.binding(binding.id)!.capabilities.max_images,9)
  assert.equal(reopened.binding(lower.id)!.capabilities.max_images,5)
  assert.deepEqual(sql.prepare('SELECT secret_blob FROM platform_model_channels WHERE id=?').get(channel.id),before)
  // A later administrator choice is not repeatedly reset at every startup.
  sql.prepare('UPDATE platform_channel_models SET capabilities_json=? WHERE id=?').run(JSON.stringify({max_images:8}),binding.id)
  assert.equal(new ModelChannelStore(sql,root).binding(binding.id)!.capabilities.max_images,8)
})

test.after(async () => {
  sql.close()
  const relative = path.relative(os.tmpdir(), root)
  assert(
    relative &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      path.basename(root).startsWith('huobao-channels-')
  )
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
