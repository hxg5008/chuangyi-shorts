import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import sharp from 'sharp'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chuangyi-redraw-history-'))
process.env.HUOBAO_DATA_DIR = root; process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.STORAGE_PATH = path.join(root, 'static'); process.env.WORKSPACE_PATH = path.join(root, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'; process.env.HUOBAO_PROXY_URL = 'direct'
const { db, schema } = await import('../src/db/index.ts')
const security = await import('../src/services/platform-security/index.ts')
const { getAssetImageHistoryService } = await import('../src/services/asset-image-history.ts')
const { prepareAssetRedraw } = await import('../src/services/asset-image-input.ts')
const { resolveFrozenAssetReferences } = await import('../src/services/asset-image-files.ts')
const { generateImage, recoverImageTask, isTaskActive } = await import('../src/services/generation.ts')
const { httpErrorHandler } = await import('../src/middleware/logger.ts')
const characters = (await import('../src/routes/characters.ts')).default
const scenes = (await import('../src/routes/scenes.ts')).default
const props = (await import('../src/routes/props.ts')).default
const histories = (await import('../src/routes/asset-images.ts')).default
security.initPlatformSecurity()
const owner = security.createUser('redraw-owner', 'test-password').user
const foreign = security.createUser('redraw-other', 'test-password').user
const session = security.createSession(owner), foreignSession = security.createSession(foreign)
const stamp = { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
const project = db.insert(schema.dramas).values({ title: 'Redraw', style: '3d', ownerUserId: owner.id, ...stamp }).returning().get()
const other = db.insert(schema.dramas).values({ title: 'Other', ownerUserId: foreign.id, ...stamp }).returning().get()
const ep = db.insert(schema.episodes).values({ dramaId: project.id, episodeNumber: 1, title: 'Episode 1', ...stamp }).returning().get()
const otherEp = db.insert(schema.episodes).values({ dramaId: other.id, episodeNumber: 1, title: 'Other episode', ...stamp }).returning().get()
const image = await sharp({ create: { width: 9, height: 5, channels: 3, background: '#123456' } }).png().toBuffer()
const different = await sharp({ create: { width: 11, height: 6, channels: 3, background: '#abcdef' } }).png().toBuffer()
await fs.mkdir(path.join(root, 'static/uploads'), { recursive: true })
let fileSequence = 0
async function upload(bytes = image, actor = owner) {
  const value = `static/uploads/reference-${++fileSequence}.png`
  await fs.writeFile(path.join(root, value), bytes)
  security.runAsActor(actor, () => security.registerPrivateMedia(value, actor.id === owner.id ? project.id : other.id))
  return value
}
const reference = await upload(), otherReference = await upload(image, foreign)
const captured: { prompt: string; references: Buffer[]; path: string }[] = []
let gate: http.ServerResponse[] | null = null
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(404).end(); return }
  const pieces: Buffer[] = []; for await (const value of req) pieces.push(Buffer.from(value))
  const bytes = Buffer.concat(pieces)
  if (req.headers['content-type']?.startsWith('multipart/form-data')) {
    const form = await new Response(bytes, { headers: { 'Content-Type': req.headers['content-type'] } }).formData()
    captured.push({ path: req.url!, prompt: String(form.get('prompt')), references: await Promise.all(form.getAll('image[]').map(async file => Buffer.from(await (file as File).arrayBuffer()))) })
  } else {
    const body = JSON.parse(bytes.toString()); captured.push({ path: req.url!, prompt: body.prompt, references: [] })
  }
  if (gate) { gate.push(res); return }
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }))
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as any).port}`
const config = db.insert(schema.aiServiceConfigs).values({ serviceType: 'image', provider: 'openai', name: 'Synthetic local image', baseUrl: base, apiKey: 'synthetic-only', model: '["gpt-image-2"]', ...stamp }).returning().get()
const app = new Hono(); app.onError(httpErrorHandler); app.use('/api/*', security.platformSecurityMiddleware)
app.route('/api/v1/characters', characters); app.route('/api/v1/scenes', scenes); app.route('/api/v1/props', props); app.route('/api/v1/asset-images', histories)
const bare = new Hono(); bare.onError(httpErrorHandler); bare.route('/asset-images', histories)
async function request(route: string, method = 'GET', body?: any, auth = session, csrf = true) {
  return app.request('http://localhost/api/v1' + route, { method, headers: {
    Cookie: `huobao_session=${auth.token}`, Origin: 'http://localhost', 'Content-Type': 'application/json',
    ...(csrf && method !== 'GET' ? { 'x-csrf-token': auth.csrfToken } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
function asset(kind: 'character' | 'scene' | 'prop', current: string | null = null) {
  if (kind === 'character') return db.insert(schema.characters).values({ dramaId: project.id, name: 'Character', imageUrl: current, ...stamp }).returning().get()
  if (kind === 'scene') return db.insert(schema.scenes).values({ dramaId: project.id, episodeId: ep.id, location: 'Room', time: 'Day', prompt: 'room', imageUrl: current, ...stamp }).returning().get()
  return db.insert(schema.props).values({ dramaId: project.id, name: 'Object', imageUrl: current, ...stamp }).returning().get()
}
async function condition(read: () => boolean, timeout = 10000) {
  const until = Date.now() + timeout
  while (!read()) { if (Date.now() > until) assert.fail('Isolated task did not settle'); await new Promise(resolve => setTimeout(resolve, 10)) }
}
const task = (id: number) => db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()!
async function settled(id: number) {
  await condition(() => ['failed', 'completed'].includes(task(id).status) && !isTaskActive(id))
  assert.equal(task(id).status, 'completed', task(id).errorMsg || 'generation did not complete')
  return task(id)
}
const history = await getAssetImageHistoryService()
after(async () => {
  for (const response of gate || []) response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }))
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  db.$client.close()
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('chuangyi-redraw-history-'))
  await fs.rm(root, { recursive: true, force: true })
})

for (const kind of ['character', 'scene', 'prop'] as const) test(`${kind}: exact final prompt and actual reference bytes reach edits; existing adopted image stays current`, async () => {
  const previous = await upload(), row = asset(kind, previous), prompt = `  手动${kind}最终提示词\n不追加风格或构图  `
  const endpoint = kind === 'character' ? 'characters' : kind === 'scene' ? 'scenes' : 'props'
  const count = captured.length
  const response = await request(`/${endpoint}/${row.id}/generate-image`, 'POST', { episode_id: ep.id, config_id: config.id, model: 'gpt-image-2', manual: true, prompt, reference_images: [reference], async_prepare: false })
  assert.equal(response.status, 200, await response.clone().text())
  const id = (await response.json() as any).data.image_generation_id; await settled(id)
  assert.equal(captured.length, count + 1)
  // HTML multipart fields standardize line breaks to CRLF on the wire. The
  // stored task keeps the exact editor text; no creative text is added.
  assert.equal(task(id).prompt, prompt); assert.equal(captured.at(-1)!.prompt.replaceAll('\r\n','\n'), prompt)
  const table = kind === 'character' ? 'characters' : kind === 'scene' ? 'scenes' : 'props'
  assert.equal((db.$client.prepare(`SELECT final_prompt FROM ${table} WHERE id=?`).get(row.id) as any).final_prompt,prompt)
  assert.equal(captured.at(-1)!.path, '/v1/images/edits'); assert.deepEqual(captured.at(-1)!.references, [image])
  const result = await request(`/asset-images/${kind}/${row.id}`)
  assert.equal(result.status, 200, await result.clone().text())
  const versions = (await result.json() as any).data.versions
  assert.equal(versions.length, 2); assert.equal(versions.find((v: any) => v.is_current).image_url, '/' + previous)
  const fresh = versions.find((v: any) => !v.is_current)
  assert.equal(fresh.width, 9); assert.equal(fresh.height, 5); assert.ok(fresh.created_at)
  const adopted = await request(`/asset-images/${kind}/${row.id}/${fresh.id}/adopt`, 'POST', {})
  assert.equal(adopted.status, 200); assert.equal((await adopted.json() as any).data.versions.find((v: any) => v.is_current).id, fresh.id)
  const refused = await request(`/asset-images/${kind}/${row.id}/${fresh.id}`, 'DELETE')
  assert.equal(refused.status, 409)
})

test('manual redraw without reference stays explicit text-to-image and the first image can become current', async () => {
  const row = asset('character'), prompt = 'explicit no-reference final prompt'
  const response = await request(`/characters/${row.id}/generate-image`, 'POST', { episode_id: ep.id, config_id: config.id, manual: true, prompt, reference_images: [], async_prepare: false })
  assert.equal(response.status, 200)
  const result = await settled((await response.json() as any).data.image_generation_id)
  assert.equal(captured.at(-1)!.path, '/v1/images/generations'); assert.equal(captured.at(-1)!.prompt, prompt); assert.deepEqual(captured.at(-1)!.references, [])
  assert.equal(db.select().from(schema.characters).where(eq(schema.characters.id, row.id)).get()!.imageUrl, result.localPath)
})

test('freezing occurs before queue submission; a later source overwrite cannot change upstream image bytes', async () => {
  const row = asset('character'), mutable = await upload()
  const input = await security.runAsActor(owner, () => prepareAssetRedraw({ manual: true, prompt: 'frozen', config_id: config.id, reference_images: [mutable] }, row, ep))
  await fs.writeFile(path.join(root, mutable), different)
  const id = await security.runAsActor(owner, () => generateImage({ characterId: row.id, dramaId: row.dramaId, ...input, manualAssetImage: true }))
  await settled(id)
  assert.deepEqual(captured.at(-1)!.references, [image])
  const params = JSON.parse(task(id).params!)
  assert.deepEqual(params.referenceImageHashes, input.referenceImageHashes)
  assert.match(params.referenceImages[0], /^static\/asset-reference-snapshots\/project-\d+\/[a-f0-9]{64}\.png$/u)
  assert.ok(JSON.stringify(params).length < 10000, 'SQLite must keep paths and checksums rather than large image base64 copies')
})

test('ordinary automatic image generation keeps its original replacement behavior while both images enter history', async () => {
  const old = await upload(), row = asset('character', old)
  const id = await security.runAsActor(owner, () => generateImage({ characterId: row.id, dramaId: project.id, configId: config.id, prompt: 'ordinary automatic image' }))
  const result = await settled(id)
  assert.equal(db.select().from(schema.characters).where(eq(schema.characters.id, row.id)).get()!.imageUrl, result.localPath)
  assert.equal((await history.list('character', row.id)).versions.length, 2)
})

test('history ownership, route-level ownership, project headers and CSRF remain enforced', async () => {
  const row = asset('character', await upload()), versions = (await history.list('character', row.id)).versions
  assert.equal((await request(`/asset-images/character/${row.id}`, 'GET', undefined, foreignSession)).status, 404)
  assert.equal((await request(`/asset-images/character/${row.id}/${versions[0].id}/adopt`, 'POST', {}, session, false)).status, 403)
  assert.equal((await security.runAsActor(foreign, () => bare.request(`/asset-images/character/${row.id}`))).status, 404)
  assert.equal((await bare.request(`/asset-images/character/${row.id}`)).status, 401)
  const before = captured.length
  const cross = await request(`/characters/${row.id}/generate-image`, 'POST', { episode_id: otherEp.id, config_id: config.id, manual: true, prompt: 'cross-project', reference_images: [] })
  assert.equal(cross.status, 403); assert.equal(captured.length, before)
  const wrongReference = await request(`/characters/${row.id}/generate-image`, 'POST', { episode_id: ep.id, config_id: config.id, manual: true, prompt: 'foreign ref', reference_images: [otherReference] })
  assert.equal(wrongReference.status, 404); assert.equal(captured.length, before)
})

test('missing, corrupt, remote, excessive or directory-traversal references do not silently become text-only generations', async () => {
  const row = asset('character'), broken = await upload(Buffer.from('not an image')), before = captured.length
  for (const refs of [[broken], ['static/uploads/missing.png'], ['https://example.com/image.png'], ['static/uploads/../outside.png'], Array(7).fill(reference)]) {
    const response = await request(`/characters/${row.id}/generate-image`, 'POST', { episode_id: ep.id, config_id: config.id, manual: true, prompt: 'must fail before paid request', reference_images: refs, async_prepare: false })
    assert.ok(response.status >= 400, await response.text())
  }
  assert.equal(captured.length, before)
})

test('a later adoption wins over a completing redraw; deleting a noncurrent history entry only tombstones the entry', async () => {
  const previous = await upload(), alternate = await upload(different), row = asset('character', previous)
  await history.recordUploaded('character', row.id, alternate, { adopt: false })
  let versions = (await history.list('character', row.id)).versions
  const alternative = versions.find(v => v.image_url === '/' + alternate)!
  gate = []
  const response = await request(`/characters/${row.id}/generate-image`, 'POST', { episode_id: ep.id, config_id: config.id, manual: true, prompt: 'late manual result', reference_images: [], async_prepare: false })
  assert.equal(response.status, 200); const id = (await response.json() as any).data.image_generation_id
  await condition(() => !!gate?.length)
  await history.adopt('character', row.id, alternative.id)
  const oldVersion = versions.find(v => v.image_url === '/' + previous)!
  await history.remove('character', row.id, oldVersion.id)
  const responses = gate!; gate = null
  for (const res of responses) res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }))
  await settled(id)
  versions = (await history.list('character', row.id)).versions
  assert.equal(versions.find(v => v.is_current)!.id, alternative.id)
  assert.ok(!versions.some(v => v.id === oldVersion.id)); assert.ok((await fs.stat(path.join(root, previous))).isFile())
})

test('deleting an asset while its paid image is running never resurrects it at completion', async () => {
  const row = asset('character')
  gate = []
  const response = await request(`/characters/${row.id}/generate-image`, 'POST', { episode_id: ep.id, config_id: config.id, manual: true, prompt: 'deleted target', reference_images: [], async_prepare: false })
  assert.equal(response.status, 200); const id = (await response.json() as any).data.image_generation_id
  await condition(() => !!gate?.length)
  assert.equal((await request(`/characters/${row.id}`, 'DELETE')).status, 200)
  const responses = gate!; gate = null
  for (const res of responses) res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }))
  await settled(id)
  const actual = db.select().from(schema.characters).where(eq(schema.characters.id, row.id)).get()!
  assert.ok(actual.deletedAt); assert.equal(actual.imageUrl, null)
  assert.equal((await request(`/asset-images/character/${row.id}`)).status, 404)
})

test('legacy task images backfill once, deleted versions stay deleted, and missing/changed files cannot be adopted', async () => {
  const current = await upload(), candidate = await upload(different), row = asset('character', current)
  db.insert(schema.sysTask).values({ type: 'image', characterId: row.id, dramaId: project.id, status: 'completed', localPath: candidate, completedAt: stamp.createdAt, ...stamp }).run()
  const first = await history.list('character', row.id), next = await history.list('character', row.id)
  assert.equal(first.versions.length, 2); assert.deepEqual(next.versions.map(v => v.id), first.versions.map(v => v.id))
  const version = first.versions.find(v => v.image_url === '/' + candidate)!
  await fs.writeFile(path.join(root, candidate), image)
  await assert.rejects(history.adopt('character', row.id, version.id), /替换|不一致/)
  await fs.unlink(path.join(root, candidate))
  assert.equal((await history.list('character', row.id)).versions.find(v => v.id === version.id)!.missing, true)
  await assert.rejects(history.adopt('character', row.id, version.id), /缺失|不可读取/)
  await history.remove('character', row.id, version.id)
  assert.equal((await history.list('character', row.id)).versions.length, 1)
})

test('old local_path-only current pictures stay visible, protected from deletion and unchanged by a manual redraw', async () => {
  const old = await upload(), row = asset('character')
  db.update(schema.characters).set({ imageUrl: null, localPath: old }).where(eq(schema.characters.id, row.id)).run()
  const first = await request(`/asset-images/character/${row.id}`)
  assert.equal(first.status, 200)
  const original = (await first.json() as any).data
  assert.equal(original.current_url, '/' + old); assert.equal(original.versions.length, 1); assert.equal(original.versions[0].is_current, true)
  assert.equal((await request(`/asset-images/character/${row.id}/${original.versions[0].id}`, 'DELETE')).status, 409)
  const response = await request(`/characters/${row.id}/generate-image`, 'POST', { episode_id: ep.id, config_id: config.id, manual: true, prompt: 'preserve legacy pointer', reference_images: [], async_prepare: false })
  assert.equal(response.status, 200); await settled((await response.json() as any).data.image_generation_id)
  const next = await history.list('character', row.id)
  assert.equal(next.current_url, '/' + old); assert.equal(next.versions.find(v => v.is_current)!.id, original.versions[0].id)
  const fresh = next.versions.find(v => !v.is_current)!
  await history.adopt('character', row.id, fresh.id)
  const updated = db.select().from(schema.characters).where(eq(schema.characters.id, row.id)).get()!
  assert.equal(updated.imageUrl, fresh.image_url.slice(1)); assert.equal(updated.localPath, updated.imageUrl)
})

test('uploaded replacements record both pictures and explicitly adopt the upload for all three asset types', async () => {
  const before = captured.length
  for (const kind of ['character', 'scene', 'prop'] as const) {
    const old = await upload(), replacement = await upload(different), row = asset(kind, old)
    const endpoint = kind === 'character' ? 'characters' : kind === 'scene' ? 'scenes' : 'props'
    const response = await request(`/${endpoint}/${row.id}`, 'PUT', { image_url: '/' + replacement, local_path: replacement })
    assert.equal(response.status, 200, await response.clone().text())
    const list = await history.list(kind, row.id)
    assert.equal(list.versions.length, 2); assert.equal(list.current_url, '/' + replacement)
    assert.ok(list.versions.some(v => v.image_url === '/' + old))
  }
  assert.equal(captured.length, before)
})

test('several actual pictures returned by one task stay as separate versions rather than sharing one task-unique history entry', async () => {
  const row = asset('character'), first = await upload(), second = await upload(different)
  const params = JSON.stringify({ outputImages: [{ index: 1, local_path: first }, { index: 2, local_path: second }] })
  const paid = db.insert(schema.sysTask).values({ type: 'image', characterId: row.id, dramaId: project.id, status: 'processing', params, ...stamp }).returning().get()
  await history.recordGenerated({ ...paid, params }, first, { adopt: false })
  const list = await history.list('character', row.id)
  assert.equal(list.versions.length, 2); assert.ok(list.versions.every(v => v.task_id === paid.id))
  assert.deepEqual(new Set(list.versions.map(v => v.image_url)), new Set(['/' + first, '/' + second]))
  assert.equal(list.current_url, null)
})

test('same-reference concurrent preparation publishes one complete frozen file; another user cannot read or submit it', async () => {
  const bytes = await sharp({ create: { width: 13, height: 8, channels: 3, background: '#f01020' } }).png().toBuffer()
  const source = await upload(bytes), row = asset('character')
  const before = captured.length
  const inputs = await Promise.all(Array.from({length:8}, () => security.runAsActor(owner, () => prepareAssetRedraw({ manual:true, prompt:'concurrent frozen bytes', config_id:config.id, reference_images:[source] }, row, ep))))
  assert.ok(inputs.every(value => value.referenceImages[0] === inputs[0].referenceImages[0]))
  const snapshot = inputs[0].referenceImages[0]
  assert.deepEqual(await fs.readFile(path.join(root,snapshot)), bytes)
  assert.deepEqual((await resolveFrozenAssetReferences(inputs[0].referenceImages,inputs[0].referenceImageHashes))[0], `data:image/png;base64,${bytes.toString('base64')}`)
  assert.ok(!(await fs.readdir(path.dirname(path.join(root,snapshot)))).some(name=>name.endsWith('.part')))
  assert.throws(() => security.runAsActor(foreign, () => security.assertMediaAccess(snapshot)), (error:any) => error.status === 404)
  const foreignAsset=db.insert(schema.characters).values({dramaId:other.id,name:'Other owner',...stamp}).returning().get()
  const response=await request(`/characters/${foreignAsset.id}/generate-image`,'POST',{episode_id:otherEp.id,config_id:config.id,manual:true,prompt:'foreign snapshot',reference_images:[snapshot],async_prepare:false},foreignSession)
  assert.equal(response.status,404); assert.equal(captured.length,before)
  // Bad content-addressed cache entries are rejected; the caller must not
  // overwrite a file that an already-submitted request might be using.
  await fs.writeFile(path.join(root,snapshot),different)
  await assert.rejects(resolveFrozenAssetReferences(inputs[0].referenceImages,inputs[0].referenceImageHashes),/修改/)
  await assert.rejects(security.runAsActor(owner,()=>prepareAssetRedraw({manual:true,prompt:'bad cache',config_id:config.id,reference_images:[source]},row,ep)),/修改/)
  assert.equal(captured.length,before)
})

test('editing appearance invalidates the old prompt normally; explicit manual redraw restores and persists that exact confirmed text', async () => {
  const row=asset('character'), prompt='  deliberately retained final prompt\nwith exact spacing  '
  db.update(schema.characters).set({appearance:'old appearance',finalPrompt:prompt}).where(eq(schema.characters.id,row.id)).run()
  const saved=await request(`/characters/${row.id}`,'PUT',{appearance:'new appearance',final_prompt:prompt})
  assert.equal(saved.status,200); assert.equal((await saved.json() as any).data.final_prompt_cleared,true)
  assert.equal(db.select().from(schema.characters).where(eq(schema.characters.id,row.id)).get()!.finalPrompt,null)
  const response=await request(`/characters/${row.id}/generate-image`,'POST',{episode_id:ep.id,config_id:config.id,manual:true,prompt,reference_images:[],async_prepare:false})
  assert.equal(response.status,200); await settled((await response.json() as any).data.image_generation_id)
  const reopened=db.select().from(schema.characters).where(eq(schema.characters.id,row.id)).get()!
  assert.equal(reopened.appearance,'new appearance'); assert.equal(reopened.finalPrompt,prompt)
})

test('simultaneous manual clicks for one asset submit one paid request and reject a duplicate without replacing its saved prompt', async () => {
  const row=asset('character'), before=captured.length
  gate=[]
  const make=(prompt:string)=>request(`/characters/${row.id}/generate-image`,'POST',{episode_id:ep.id,config_id:config.id,manual:true,prompt,reference_images:[reference],async_prepare:false})
  const responses=await Promise.all([make('first explicit prompt'),make('second explicit prompt')])
  const accepted=responses.find(response=>response.status===200)!,rejected=responses.find(response=>response.status===409)!
  assert.ok(accepted);assert.ok(rejected)
  const id=(await accepted.json() as any).data.image_generation_id
  await condition(()=>!!gate?.length)
  assert.equal(captured.length,before+1)
  assert.equal(db.select().from(schema.characters).where(eq(schema.characters.id,row.id)).get()!.finalPrompt,task(id).prompt)
  const pending=gate!;gate=null
  for(const res of pending)res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({data:[{b64_json:image.toString('base64')}]}))
  await settled(id)
})

test('a preexisting snapshot-parent junction is refused before creating anything outside storage', async () => {
  const snapshots=path.join(root,'static/asset-reference-snapshots'), saved=path.join(root,'saved-snapshots'), outside=path.join(root,'outside-storage')
  await fs.mkdir(outside)
  await fs.rename(snapshots,saved)
  let linked=false
  try {
    await fs.symlink(outside,snapshots,process.platform==='win32'?'junction':'dir');linked=true
    const row=asset('character'), before=captured.length
    await assert.rejects(security.runAsActor(owner,()=>prepareAssetRedraw({manual:true,prompt:'no external mkdir',config_id:config.id,reference_images:[reference]},row,ep)),/链接/)
    assert.deepEqual(await fs.readdir(outside),[]);assert.equal(captured.length,before)
  } finally {
    // Remove only the exact synthetic junction, never recursively follow it.
    if(linked){if(process.platform==='win32')await fs.rmdir(snapshots);else await fs.unlink(snapshots)}
    await fs.rename(saved,snapshots)
  }
})

test('recovering an existing paid result does not resurrect a removed history version or replace a newer adoption', async () => {
  const row=asset('character'), response=await request(`/characters/${row.id}/generate-image`,'POST',{episode_id:ep.id,config_id:config.id,manual:true,prompt:'one paid result',reference_images:[],async_prepare:false})
  assert.equal(response.status,200);const id=(await response.json() as any).data.image_generation_id;const paid=await settled(id)
  const version=(await history.list('character',row.id)).versions[0]
  const chosen=await upload(different)
  await history.recordUploaded('character',row.id,chosen)
  await history.remove('character',row.id,version.id)
  db.update(schema.sysTask).set({status:'failed',resultUrl:base+'/already-downloaded',errorCode:'image_delivery_failed'}).where(eq(schema.sysTask.id,id)).run()
  const before=captured.length
  await security.runAsActor(owner,()=>recoverImageTask(id));await settled(id)
  assert.equal(captured.length,before);assert.equal(task(id).localPath,paid.localPath)
  const final=await history.list('character',row.id)
  assert.equal(final.current_url,'/'+chosen);assert.ok(!final.versions.some(value=>value.id===version.id))
})
