import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-extract-lifecycle-'))
process.env.HUOBAO_DATA_DIR = temporary
process.env.SQLITE_PATH = path.join(temporary, 'test.sqlite3')
process.env.STORAGE_PATH = path.join(temporary, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.HUOBAO_PROXY_URL = 'direct'
const { db, schema } = await import('../src/db/index.ts')
const security = await import('../src/services/platform-security/index.ts')
security.initPlatformSecurity()
const owner = security.createUser('lifecycle-owner', 'synthetic-password').user
const at = new Date().toISOString()
const project = db.insert(schema.dramas).values({ title: 'Lifecycle fixture', ownerUserId: owner.id, createdAt: at, updatedAt: at }).returning().get()
const episode = db.insert(schema.episodes).values({ dramaId: project.id, episodeNumber: 1, title: 'First', content: 'synthetic script', createdAt: at, updatedAt: at }).returning().get()
const { mastra } = await import('../src/mastra/index.ts')
const { startExtraction, getExtractionStatus } = await import('../src/services/extraction.ts')
const { withActivityContext } = await import('../src/services/activity/context.ts')
const original = mastra.getAgent
const captured: any[] = []
let rejectModel = false
let transportHttpStatus: number | undefined
let releaseModel: undefined | (() => void)
;(mastra as any).getAgent = (id: string) => {
  assert.equal(id, 'extractor')
  return { id: 'extractor', stream: async (messages: any[], options: any) => {
    captured.push({ messages: structuredClone(messages), maxSteps: options.maxSteps,
      episodeId: options.requestContext.get('episodeId'), projectId: options.requestContext.get('dramaId'),
      model: options.requestContext.get('modelOverride'), config: options.requestContext.get('textConfigId'), parameters: options.requestContext.get('modelParameters') })
    return { getFullOutput: async () => {
      if (releaseModel) await new Promise<void>(resolve => { releaseModel = resolve })
      if (rejectModel) throw new Error('synthetic model disconnect', transportHttpStatus ? { cause: { statusCode: transportHttpStatus } } : undefined)
      const tool = { toolName: 'save_dedup_props', result: { saved: 0, created: 0, merged: 0 } }
      const step = { toolCalls: [{ toolName: tool.toolName }], toolResults: [tool], text: 'synthetic reply' }
      options.onStepFinish?.(step)
      return { text: step.text, toolCalls: step.toolCalls, toolResults: step.toolResults, steps: [step] }
    } }
  } }
}
async function finished() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = getExtractionStatus(episode.id).props
    if (current && current.status !== 'running') return current
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('fixture did not settle')
}
function start(observer?: (value: any) => void) {
  return security.runAsActor(owner, () => withActivityContext({ projectId: project.id, episodeId: episode.id,
    textModelParameters: { temperature: 0.4 } }, () => startExtraction(episode.id, project.id, 'props', {
    model: 'synthetic-text-model', configId: 7, onLifecycle: observer
  })))
}

test('external lifecycle observation preserves manual extraction messages, model, tools settings and context', async () => {
  assert.equal(start(), true)
  assert.equal((await finished()).status, 'done')
  const events: any[] = []
  assert.equal(start(event => events.push(event)), true)
  assert.equal((await finished()).status, 'done')
  assert.deepEqual(captured[0], captured[1])
  assert.equal(captured[1].maxSteps, 20)
  assert.deepEqual(events.map(event => event.phase), ['started', 'step', 'done'])
  assert.equal(events.at(-1).result.toolResults[0].result.saved, 0)
  assert(events.at(-1).finishedAt)
})

test('an observer exception cannot fail or repeat the original model operation', async () => {
  const before = captured.length
  assert.equal(start(() => { throw new Error('synthetic external observer failed') }), true)
  assert.equal((await finished()).status, 'done')
  assert.equal(captured.length, before + 1)
})

test('same-episode duplicate calls stay rejected and the exact original model error is observed without retry', async () => {
  rejectModel = true
  releaseModel = () => {}
  const events: any[] = [], before = captured.length
  assert.equal(start(event => events.push(event)), true)
  assert.equal(start(), false)
  for (let attempt = 0; captured.length === before && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
  releaseModel!()
  releaseModel = undefined
  const result = await finished()
  assert.equal(result.status, 'error')
  assert.equal(result.error, 'synthetic model disconnect')
  assert.equal(events.at(-1).phase, 'error')
  assert.equal(events.at(-1).error, result.error)
  assert.equal(captured.length, before + 1)
})

test('transport status is observed as structured evidence while the original public error stays unchanged', async () => {
  rejectModel = true
  transportHttpStatus = 400
  const events: any[] = []
  assert.equal(start(event => events.push(event)), true)
  const result = await finished()
  assert.equal(result.error, 'synthetic model disconnect')
  assert.equal(events.at(-1).providerHttpStatus, 400)
  transportHttpStatus = undefined
})

after(() => { (mastra as any).getAgent = original; db.$client.close() })
