import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chuangyi-style-v4-'))
process.env.SQLITE_PATH = path.join(directory, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = directory
process.env.STORAGE_PATH = path.join(directory, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db } = await import('../src/db/index.ts')
const { initStyleCatalog, styleMetadata, saveStyleMetadata, getDramaStyleSnapshot, getDramaStylePrompt, styleContext, composeStylePrompt, composeProjectStyle, composeAssetStylePrompt, recordStyleTaskSnapshot, recordedStyleTaskSnapshot } = await import('../src/services/style-preset.ts')
const { buildSceneImagePrompt } = await import('../src/services/scene-image-contract.ts')
const at = new Date().toISOString()
const addStyle = (value: string, prompt = '旧风格') => { db.$client.prepare('INSERT INTO style_presets(name,value,prompt,is_active,created_at,updated_at) VALUES(?,?,?,1,?,?)').run(value, value, prompt, at, at) }
const project = (value: string) => Number(db.$client.prepare('INSERT INTO dramas(title,style,created_at,updated_at) VALUES(?,?,?,?)').run('test project', value, at, at).lastInsertRowid)
after(() => { db.$client.close(); fs.rmSync(directory, { recursive: true, force: true }) })

test('catalog imports original XYQ 132 complete templates and Yingce 57 without replacing existing styles', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('../resources/style-catalog.json', import.meta.url), 'utf8'))
  const collision = catalog.styles[0].value
  addStyle(collision, 'existing administrator customization')
  initStyleCatalog()
  assert.equal(styleMetadata(collision).template, 'existing administrator customization, {content}')
  assert.equal(styleMetadata(collision).source, 'custom')
  const rows = db.$client.prepare('SELECT value,prompt FROM style_presets').all() as any[]
  assert.equal(rows.filter(row => row.value.startsWith('xyq-')).length, 132)
  assert.equal(rows.filter(row => row.value.startsWith('yingce-')).length, 57)
  assert.ok(rows.some(row => row.value === '3d'))
  let withAfter = 0
  for (const row of rows.filter(row => row.value.startsWith('xyq-'))) {
    const meta = styleMetadata(row.value, row.prompt)
    assert.equal(meta.template.split('{content}').length, 2)
    if (meta.cover) assert.ok(fs.existsSync(path.resolve('..', 'frontend/app/public', meta.cover.slice(1))), meta.cover)
    if (meta.template.split('{content}')[1].trim()) withAfter++
  }
  assert.equal(withAfter, 36)
})

test('before+content+after remain original language and are composed only once', () => {
  addStyle('test-both', '中文前缀\n中文后缀')
  saveStyleMetadata('test-both', { template: '中文前缀\n{content}\n中文后缀', category: 'live' }, '中文前缀\n中文后缀')
  const id = project('test-both'), snapshot = getDramaStyleSnapshot(id)!
  const composed = composeStylePrompt('人物身体描述', snapshot, 'asset_image')
  assert.equal(composed, '中文前缀\n人物身体描述\n中文后缀')
  assert.equal(composeStylePrompt(composed, snapshot, 'asset_image'), composed)
  assert.ok(!composed.includes('{content}'))
})

test('project snapshot survives preset edit/disable/delete and changes only on explicit refresh', async () => {
  addStyle('test-freeze')
  const id = project('test-freeze'), before = getDramaStyleSnapshot(id)!
  saveStyleMetadata('test-freeze', { template: '新风格 {content} 完整尾部', stages: ['video'] }, '新风格')
  db.$client.prepare('UPDATE style_presets SET prompt=? WHERE value=?').run('新风格', 'test-freeze')
  assert.deepEqual(getDramaStyleSnapshot(id), before)
  const next = getDramaStyleSnapshot(id, true)!
  assert.notEqual(next.version, before.version)
  assert.equal(await getDramaStylePrompt(id), '')
  assert.equal((await composeProjectStyle(id, '镜头正文', 'video')).prompt, '新风格 镜头正文 完整尾部')
  db.$client.prepare('DELETE FROM style_presets WHERE value=?').run('test-freeze')
  assert.deepEqual(getDramaStyleSnapshot(id), next)
})

test('legacy cached final prompt remains byte-identical and is not prefixed twice', async () => {
  addStyle('test-legacy', 'Original English style')
  const id = project('test-legacy'), cached = 'Original English style, character layout'
  const assetId = Number(db.$client.prepare('INSERT INTO characters(drama_id,name,final_prompt,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, 'person', cached, at, at).lastInsertRowid)
  const result = await composeProjectStyle(id, cached, 'asset_image', { kind: 'character', id: assetId })
  assert.equal(result.prompt, cached)
  const video = await composeProjectStyle(id, 'unmodified video body', 'video')
  assert.equal(video.prompt, 'Original English style，\nunmodified video body')
  assert.equal(composeStylePrompt(video.prompt, video.snapshot, 'video'), video.prompt)
  saveStyleMetadata('test-legacy', { template: 'Original English style, {content}' }, 'Original English style')
  getDramaStyleSnapshot(id, true)
  assert.equal((await composeProjectStyle(id, 'explicit full template body', 'video')).prompt, 'Original English style, explicit full template body')
})

test('a pre-v4 project switching style through PUT captures old cached prompt before changing its key', async () => {
  addStyle('test-put-old', 'old original style')
  addStyle('test-put-new', 'new project style')
  const id = project('test-put-old'), cached = 'old original style, original body'
  const assetId = Number(db.$client.prepare('INSERT INTO characters(drama_id,name,final_prompt,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, 'person', cached, at, at).lastInsertRowid)
  const dramas = (await import('../src/routes/dramas.ts')).default
  const response = await dramas.request(`/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ style: 'test-put-new' }) })
  assert.equal(response.status, 200)
  const result = await composeProjectStyle(id, cached, 'asset_image', { kind: 'character', id: assetId })
  assert.equal(result.prompt, 'new project style, original body')
})

test('switching style uses raw saved asset content, keeps scene layout contract exactly once', async () => {
  addStyle('test-scene-old', 'old look')
  saveStyleMetadata('test-scene-old', { template: '\nold prefix\n{content}\nold suffix\n  ' }, 'old look')
  addStyle('test-scene-new', 'new look')
  saveStyleMetadata('test-scene-new', { template: 'new prefix\n{content}\nnew suffix' }, 'new look')
  const id = project('test-scene-old')
  const sceneId = Number(db.$client.prepare('INSERT INTO scenes(drama_id,location,time,prompt,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, '房间', '夜', '房间灯光', at, at).lastInsertRowid)
  const oldPrompt = buildSceneImagePrompt(await composeAssetStylePrompt(id, 'scene', sceneId, '房间灯光'))
  db.$client.prepare('UPDATE dramas SET style=? WHERE id=?').run('test-scene-new', id)
  const result = await composeProjectStyle(id, oldPrompt, 'asset_image', { kind: 'scene', id: sceneId })
  const sent = buildSceneImagePrompt(result.prompt)
  assert.ok(sent.startsWith('new prefix\n房间灯光\nnew suffix'))
  assert.ok(!sent.includes('old prefix') && !sent.includes('old suffix'))
  assert.equal(sent.split('【场景四视图输出要求 v1】').length - 1, 1)
})

test('invalid templates and stages are rejected without modifying existing metadata', () => {
  addStyle('test-invalid')
  const before = styleMetadata('test-invalid', '旧风格')
  assert.throws(() => saveStyleMetadata('test-invalid', { template: '{content}{content}' }, '旧风格'), /只能包含一个/)
  assert.throws(() => saveStyleMetadata('test-invalid', { template: '{content}', stages: ['extract'] }, '旧风格'), /适用步骤/)
  assert.deepEqual(styleMetadata('test-invalid', '旧风格'), before)
})

test('legacy context-only API update does not discard a complete imported suffix', () => {
  addStyle('test-context-only', '上下文')
  saveStyleMetadata('test-context-only', { template: '前 {content} 后' }, '上下文')
  saveStyleMetadata('test-context-only', { prompt: '新版上下文' }, '新版上下文')
  assert.equal(styleMetadata('test-context-only').template, '前 {content} 后')
})

test('storyboard context includes original suffix and a task keeps its first chosen style', () => {
  addStyle('test-storyboard-old', 'context')
  saveStyleMetadata('test-storyboard-old', { template: '中文前文 {content} English suffix' }, 'context')
  const id = project('test-storyboard-old'), snapshot = getDramaStyleSnapshot(id)!
  assert.equal(styleContext(snapshot), '中文前文\nEnglish suffix')
  recordStyleTaskSnapshot('job-test', snapshot)
  saveStyleMetadata('test-storyboard-old', { template: 'revised {content}' }, 'context')
  getDramaStyleSnapshot(id, true)
  recordStyleTaskSnapshot('job-test', getDramaStyleSnapshot(id))
  assert.deepEqual(recordedStyleTaskSnapshot('job-test'), snapshot)
})

test('deleting imported style remains deleted on subsequent catalog initialization', () => {
  const row = db.$client.prepare("SELECT value FROM style_presets WHERE value LIKE 'xyq-%' LIMIT 1").get() as any
  db.$client.prepare('DELETE FROM style_presets WHERE value=?').run(row.value)
  initStyleCatalog()
  assert.equal(db.$client.prepare('SELECT id FROM style_presets WHERE value=?').get(row.value), undefined)
})
