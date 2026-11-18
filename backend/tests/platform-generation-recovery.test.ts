import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { eq } from 'drizzle-orm'

// These tests use an isolated database and a local HTTP provider, never a production service or account.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-platform-generation-'))
process.env.HUOBAO_DATA_DIR = root
process.env.SQLITE_PATH = path.join(root, 'generation.sqlite3')
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.HUOBAO_PROXY_URL = 'direct'
const { db, schema } = await import('../src/db/index.ts')
const { getModelChannelStore } = await import('../src/services/model-channels/store.ts')
const { generateImage, recoverImageTask, resumeInterruptedTasks, isTaskActive } =
  await import('../src/services/generation.ts')

const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)
const requests: { method: string; path: string; body: any }[] = []
const server = http.createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk.toString()
  const body = raw ? JSON.parse(raw) : null
  requests.push({ method: req.method!, path: req.url!, body })
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/query-original/original-image' && req.method === 'POST') {
    res.end(JSON.stringify({ data: { id: body.id, state: 'ready', pixels: image.toString('base64') } }))
  } else if (req.url === '/create-edited' && req.method === 'POST') {
    res.end(JSON.stringify({ payload: { state: 'ready', pixels: image.toString('base64') } }))
  } else {
    res.writeHead(400).end(JSON.stringify({ error: 'Unexpected mock provider request' }))
  }
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`
const store = getModelChannelStore()
const channel = store.saveChannel({
  name: 'Isolated image provider',
  base_url: baseUrl,
  api_key: 'synthetic-only-key'
})
const originalDefinition = {
  type: 'image' as const,
  create: {
    method: 'POST' as const,
    path: '/create-original',
    body: { model: '{{model}}', prompt: '{{prompt}}', images: '{{referenceImageUrls}}' }
  },
  poll: {
    method: 'POST' as const,
    path: '/query-original/{{model}}',
    body: { id: '{{taskId}}', model: '{{model}}', quality: '{{parameters.quality}}' }
  },
  response: {
    task_id: 'data.id',
    status: 'data.state',
    base64: 'data.pixels',
    succeeded: ['ready'],
    failed: ['rejected']
  }
}
store.saveProtocol({
  id: 'custom.recovery-image',
  name: 'Original image protocol',
  definition: originalDefinition
})
const binding = store.saveBinding(channel.id, {
  name: 'Original image binding',
  type: 'image',
  model: 'original-image',
  protocol_id: 'custom.recovery-image',
  capabilities: { max_images: 12 },
  defaults: { quality: 'original-quality' }
})
const originalConfig = store.resolve(binding.config_id)!
const originalSnapshot = {
  protocolId: originalConfig.protocolId,
  protocolVersion: originalConfig.protocolVersion,
  protocolDefinition: originalConfig.protocolDefinition,
  bindingId: originalConfig.bindingId,
  channelId: originalConfig.channelId,
  capabilities: originalConfig.capabilities,
  defaults: originalConfig.defaults
}
// Simulate an administrator editing the same binding and protocol after the upstream task was accepted.
store.saveProtocol({
  id: 'custom.recovery-image',
  name: 'Edited image protocol',
  definition: {
    ...originalDefinition,
    create: { ...originalDefinition.create, path: '/create-edited' },
    poll: { ...originalDefinition.poll, path: '/query-edited/{{model}}' },
    response: {
      task_id: 'payload.id',
      status: 'payload.state',
      base64: 'payload.pixels',
      succeeded: ['ready']
    }
  }
})
store.saveBinding(channel.id, { model: 'edited-image', defaults: { quality: 'edited-quality' } }, binding.id)
const timestamp = new Date().toISOString()
const row = (id: number) => db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()!
function savedAsyncImage(taskId: string, status: 'failed' | 'processing') {
  return db
    .insert(schema.sysTask)
    .values({
      type: 'image',
      provider: 'custom_json',
      configId: binding.config_id,
      configBaseUrl: baseUrl,
      model: 'original-image',
      prompt: 'The already accepted prompt must never be submitted again',
      taskId,
      params: JSON.stringify({ protocolSnapshot: originalSnapshot }),
      status,
      stage: 'polling',
      createdAt: timestamp,
      updatedAt: timestamp
    })
    .returning()
    .get()
}
async function waitFor(id: number, status: string) {
  const deadline = Date.now() + 14_000
  while (Date.now() < deadline) {
    if (row(id).status === status && !isTaskActive(id)) return row(id)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`Task ${id} expected ${status}; actual ${row(id).status}: ${row(id).errorMsg}`)
}

test('saved asynchronous image recovery only queries once and freezes the original model, POST body and protocol response map', async () => {
  const task = savedAsyncImage('original/task/🌙', 'failed')
  const before = requests.length
  await Promise.all([recoverImageTask(task.id), recoverImageTask(task.id), recoverImageTask(task.id)])
  const completed = await waitFor(task.id, 'completed')
  assert.deepEqual(requests.slice(before), [
    {
      method: 'POST',
      path: '/query-original/original-image',
      body: {
        id: 'original/task/🌙',
        model: 'original-image',
        quality: 'original-quality'
      }
    }
  ])
  assert.equal(completed.taskId, task.taskId)
  assert.equal(completed.stage, 'completed')
  assert.equal(completed.errorCode, null)
  assert(completed.localPath)
  assert.deepEqual(await fs.readFile(path.join(root, completed.localPath!)), image)
})

test('restart restoration resumes a saved image task ID without replaying generation', async () => {
  const task = savedAsyncImage('restart/task', 'processing')
  const before = requests.length
  await resumeInterruptedTasks()
  await waitFor(task.id, 'completed')
  assert.deepEqual(requests.slice(before), [
    {
      method: 'POST',
      path: '/query-original/original-image',
      body: {
        id: 'restart/task',
        model: 'original-image',
        quality: 'original-quality'
      }
    }
  ])
  assert(!requests.slice(before).some((request) => request.path.startsWith('/create-')))
})

test('custom JSON image generation forwards more than six references with input order and duplicates intact', async () => {
  const references = Array.from(
    { length: 8 },
    (_, index) =>
      `data:image/png;base64,${Buffer.concat([image, Buffer.from(String(index))]).toString('base64')}`
  )
  references.splice(3, 0, references[0])
  const prompt = '原文🌙@角色\n这次是带九张参考图的请求。'
  const before = requests.length
  const id = await generateImage({ configId: binding.config_id, prompt, referenceImages: references })
  await waitFor(id, 'completed')
  assert.deepEqual(requests.slice(before), [
    {
      method: 'POST',
      path: '/create-edited',
      body: {
        model: 'edited-image',
        prompt,
        images: references
      }
    }
  ])
})

test('an unreadable explicitly requested custom-image reference fails before any generation request', async () => {
  const before = requests.length
  const id = await generateImage({
    configId: binding.config_id,
    prompt: 'Do not silently turn this into text-to-image',
    referenceImages: ['static/images/missing-synthetic-reference.png']
  })
  const failed = await waitFor(id, 'failed')
  assert.match(failed.errorMsg!, /参考图片读取失败/)
  assert.equal(requests.length, before)
  assert.equal(failed.taskId, null)
  assert.equal(failed.resultUrl, null)
})

test('a custom protocol without a reference mapping rejects a reference request before generation', async () => {
  store.saveProtocol({
    id: 'custom.no-reference-mapping',
    name: 'Text-only image template',
    definition: {
      type: 'image',
      create: { method: 'POST', path: '/create-edited', body: { model: '{{model}}', prompt: '{{prompt}}' } },
      response: { base64: 'payload.pixels' }
    }
  })
  const textOnlyBinding = store.saveBinding(channel.id, {
    name: 'No reference mapping',
    type: 'image',
    model: 'text-image',
    protocol_id: 'custom.no-reference-mapping'
  })
  const before = requests.length
  const id = await generateImage({
    configId: textOnlyBinding.config_id,
    prompt: 'Reference must not disappear',
    referenceImages: [`data:image/png;base64,${image.toString('base64')}`]
  })
  const failed = await waitFor(id, 'failed')
  assert.match(failed.errorMsg!, /未映射参考图片/)
  assert.equal(requests.length, before)
})

test.after(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  db.$client.close()
  const relative = path.relative(os.tmpdir(), root)
  assert(
    relative &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      path.basename(root).startsWith('huobao-platform-generation-')
  )
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
