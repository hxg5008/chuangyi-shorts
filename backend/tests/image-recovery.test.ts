import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { eq } from 'drizzle-orm'

// Every generation request is served locally; production DB and services are never used.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-image-recovery-'))
process.env.SQLITE_PATH = path.join(root, 'tasks.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.ts')
const { generateImage, recoverImageTask, resumeInterruptedTasks } = await import('../src/services/generation.ts')
const tasksRoute = (await import('../src/routes/tasks.ts')).default
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
let available = false
let brokenSubmission = false
let submissions = 0
let downloads = 0
const server = http.createServer((req, res) => {
  if (req.method === 'POST') {
    submissions++
    if (brokenSubmission) { req.socket.destroy(); return }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ data: [{ url: base + '/image.png?signature=test-only' }] }))
    return
  }
  downloads++
  if (!available) { res.writeHead(404).end(); return }
  res.setHeader('Content-Type', 'image/png')
  res.end(image)
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as any).port}`
const ts = new Date().toISOString()
const config = db.insert(schema.aiServiceConfigs).values({ serviceType: 'image', provider: 'openai', name: 'local test',
  baseUrl: base, apiKey: 'test-only', model: '["gpt-image-2"]', createdAt: ts, updatedAt: ts }).returning().get()
const character = db.insert(schema.characters).values({ dramaId: 1, name: 'test character', createdAt: ts, updatedAt: ts }).returning().get()
const row = (id: number) => db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()!
async function waitFor(id: number, status: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (row(id).status === status) return row(id)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`Task ${id} did not reach ${status}; actual ${row(id).status}`)
}
function insertTask(values: Partial<typeof schema.sysTask.$inferInsert> = {}) {
  return db.insert(schema.sysTask).values({ type: 'image', status: 'failed', createdAt: ts, updatedAt: ts, ...values }).returning().get()
}

test('generated result survives a failed download; concurrent API recovery only downloads once', async () => {
  const id = await generateImage({ prompt: 'local test', characterId: character.id, configId: config.id })
  const failed = await waitFor(id, 'failed')
  assert.equal(failed.resultUrl, base + '/image.png?signature=test-only')
  assert.equal(failed.errorCode, 'image_delivery_failed')
  assert.equal(failed.stage, 'downloading')
  assert.match(failed.errorMsg!, /图片已生成.*下载保存失败/)
  assert.doesNotMatch(failed.errorMsg!, /signature=test-only|127\.0\.0\.1/)
  assert.equal(submissions, 1)
  assert.equal(downloads, 1)
  assert.equal(db.select().from(schema.characters).where(eq(schema.characters.id, character.id)).get()!.imageUrl, null)
  available = true
  const responses = await Promise.all([0, 1, 2].map(() => tasksRoute.request(`/${id}/recover`, { method: 'POST' })))
  assert.ok(responses.every(response => response.status === 200))
  const completed = await waitFor(id, 'completed')
  assert.equal(submissions, 1)
  assert.equal(downloads, 2)
  assert.equal(completed.stage, 'completed')
  assert.equal(completed.errorCode, null)
  assert.equal(completed.errorMsg, null)
  assert.equal(db.select().from(schema.characters).where(eq(schema.characters.id, character.id)).get()!.imageUrl, completed.localPath)
  const diagnosticText = await (await tasksRoute.request(`/${id}/diagnostics`)).text()
  assert.doesNotMatch(diagnosticText, /signature=test-only|127\.0\.0\.1/)
})

test('restart recovers saved results, reuses existing local files, and leaves unknown submissions for review', async () => {
  const result = insertTask({ status: 'processing', resultUrl: base + '/image.png' })
  const cached = path.join(root, 'static', 'images', 'cached.png')
  await fs.writeFile(cached, image)
  const local = insertTask({ status: 'processing', resultUrl: base + '/must-not-download', localPath: 'static/images/cached.png' })
  const unknown = insertTask({ status: 'processing' })
  const queued = insertTask({ status: 'processing', stage: 'queued' })
  const before = { submissions, downloads }
  await resumeInterruptedTasks()
  await waitFor(result.id, 'completed')
  await waitFor(local.id, 'completed')
  assert.equal(downloads, before.downloads + 1)
  assert.equal(submissions, before.submissions)
  assert.equal(row(unknown.id).errorCode, 'submission_unknown')
  assert.equal(row(queued.id).errorCode, 'queue_interrupted')
  await assert.rejects(recoverImageTask(unknown.id), /未保存图片结果地址/)
  const refused = await tasksRoute.request(`/${unknown.id}/recover`, { method: 'POST' })
  assert.equal(refused.status, 400)
  assert.equal(submissions, before.submissions)
})

test('asset write failure cannot commit completed status; retry reuses the downloaded file', async () => {
  const task = insertTask({ resultUrl: base + '/image.png', characterId: character.id })
  db.$client.exec(`CREATE TRIGGER reject_image_update BEFORE UPDATE OF image_url ON characters BEGIN SELECT RAISE(ABORT, 'test write failure'); END`)
  const previousImage = db.select().from(schema.characters).where(eq(schema.characters.id, character.id)).get()!.imageUrl
  const before = downloads
  await recoverImageTask(task.id)
  const failed = await waitFor(task.id, 'failed')
  assert.equal(failed.errorCode, 'image_delivery_failed')
  assert.equal(failed.stage, 'saving')
  assert.equal(failed.completedAt, null)
  assert.ok(failed.localPath)
  assert.equal(db.select().from(schema.characters).where(eq(schema.characters.id, character.id)).get()!.imageUrl, previousImage)
  db.$client.exec('DROP TRIGGER reject_image_update')
  // Let the previous recovery release its in-memory lock after recording failure.
  await new Promise(resolve => setTimeout(resolve, 0))
  await recoverImageTask(task.id)
  await waitFor(task.id, 'completed')
  assert.equal(downloads, before + 1)
})

test('submission network failure records uncertainty and a cause code without retrying POST', async () => {
  brokenSubmission = true
  const before = submissions
  const id = await generateImage({ prompt: 'local test', configId: config.id })
  const failed = await waitFor(id, 'failed')
  assert.equal(submissions, before + 1)
  assert.equal(failed.errorCode, 'submission_unknown')
  assert.equal(failed.resultUrl, null)
  assert.match(failed.errorMsg!, /模型平台记录/)
  assert.match(failed.errorMsg!, /UND_ERR_SOCKET/)
  await assert.rejects(recoverImageTask(id), /未保存图片结果地址/)
  assert.equal(submissions, before + 1)
})

test('recovering an older image preserves newer asset selection and compares storyboard frame types', async () => {
  const before = submissions
  const older = insertTask({ characterId: character.id, resultUrl: base + '/image.png' })
  insertTask({ characterId: character.id, status: 'completed' })
  db.update(schema.characters).set({ imageUrl: 'static/images/newer.png' }).where(eq(schema.characters.id, character.id)).run()
  const storyboard = db.insert(schema.storyboards).values({ episodeId: 1, storyboardNumber: 1, createdAt: ts, updatedAt: ts }).returning().get()
  const firstFrame = insertTask({ storyboardId: storyboard.id, params: '{"frameType":"first_frame"}', resultUrl: base + '/image.png' })
  insertTask({ storyboardId: storyboard.id, params: '{"frameType":"last_frame"}', status: 'completed' })
  await recoverImageTask(older.id)
  await recoverImageTask(firstFrame.id)
  await waitFor(older.id, 'completed')
  const firstDone = await waitFor(firstFrame.id, 'completed')
  assert.equal(db.select().from(schema.characters).where(eq(schema.characters.id, character.id)).get()!.imageUrl, 'static/images/newer.png')
  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard.id)).get()!.firstFrameImage, firstDone.localPath)
  assert.equal(submissions, before)
})

test.after(async () => {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.$client.close()
  await fs.rm(root, { recursive: true, force: true })
})
