import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chuangyi-import-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3'); process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static'); process.env.MYSQL_AUTO_IMPORT = 'false'; process.env.HUOBAO_PROXY_URL = 'direct'
const { db, schema } = await import('../src/db/index.ts')
const security = await import('../src/services/platform-security/index.ts')
security.initPlatformSecurity()
const owner = security.createUser('import-owner', 'synthetic-password').user, other = security.createUser('import-other', 'synthetic-password').user
const { splitImportText, decodeImportBytes, importHeadingNumber, previewDocumentImport, commitDocumentImport, listDocumentImports, getDocumentImportSource } = await import('../src/services/document-import.ts')
const importRoutes = (await import('../src/routes/document-import.ts')).default
const at = new Date().toISOString(), sql = db.$client
const project = () => db.insert(schema.dramas).values({ title: 'Import test', ownerUserId: owner.id, createdAt: at, updatedAt: at }).returning().get()
after(async () => { sql.close(); await fs.rm(root, { recursive: true, force: true }) })

test('novel headings without spaces split while preserving preface, dialogue, blank lines and CRLF exactly', () => {
  const source = '书名前言\r\n首发：这句话也是剧情\r\n\r\n第一章重生\r\n甲：免费阅读？\r\n第二章 新世界\r\nPS：原文保留\r\n'
  const parts = splitImportText(source, 'novel')
  assert.equal(parts.length, 2); assert.equal(parts.map(p => p.content).join(''), source)
  assert.deepEqual(parts.map(p => p.source_number), [1,2]); assert.match(parts[0].content, /书名前言/); assert.match(parts[1].content, /PS：原文保留/)
})
test('script episode headings do not treat scenes or acts as episodes; all source numbers remain visible', () => {
  const source = '# 第12集开端\n第一幕 室内\n## S01 内景\n#### 1-01 客厅 夜 内\n甲：走。\n第14集\n第1场 追逐\n乙：停。'
  const parts = splitImportText(source, 'script', 7)
  assert.equal(parts.length, 2); assert.deepEqual(parts.map(p => p.source_number), [12,14]); assert.deepEqual(parts.map(p => p.episode_number), [7,8]); assert.equal(parts.map(p => p.content).join(''), source)
  assert.equal(splitImportText('第一幕\n正文\n第二幕\n正文', 'script').length, 1)
})
test('mixed Chinese numeric headings and English headings are recognized only in their chosen mode', () => {
  for (const [label, n] of [['十',10],['十一',11],['一百零二',102],['一〇二',102],['两百零三',203]] as const) assert.equal(importHeadingNumber(label), n)
  assert.equal(splitImportText('Chapter 1 Start\nx\nChapter 2 End\ny', 'novel').length, 2)
  assert.equal(splitImportText('EP01 Start\nx\nEpisode 2 End\ny', 'script').length, 2)
  assert.equal(splitImportText('第一章开端\nx\n第二章结尾\ny', 'script').length, 1)
})
test('UTF-8 BOM, UTF-16 LE/BE and GB18030 decode without changing the source bytes', () => {
  const text = '第一集你好\n甲：回家。'
  const utf8 = Buffer.concat([Buffer.from([0xef,0xbb,0xbf]), Buffer.from(text)])
  assert.equal(decodeImportBytes(utf8).text, text)
  const le = Buffer.from(text,'utf16le'), be = Buffer.from(le); be.swap16()
  assert.equal(decodeImportBytes(Buffer.concat([Buffer.from([0xff,0xfe]),le])).text,text)
  assert.equal(decodeImportBytes(Buffer.concat([Buffer.from([0xfe,0xff]),be])).text,text)
  assert.equal(decodeImportBytes(Buffer.from([0xc4,0xe3,0xba,0xc3])).text,'你好')
  assert.throws(() => decodeImportBytes(Buffer.from([0,1,2])), /空字符/)
})
test('preview keeps original file privately and does not create episodes or call models', () => {
  const p = project(), source = Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('第一集开端\r\n甲：回家。\r\n第二集结尾\r\n乙：好。')])
  const preview = previewDocumentImport(p.id,{kind:'script',filename:'原剧本.md',file_base64:source.toString('base64')},owner)
  assert.equal(preview.sections.length,2); assert.equal(sql.prepare('SELECT count(*) n FROM episodes WHERE drama_id=?').get(p.id) && (sql.prepare('SELECT count(*) n FROM episodes WHERE drama_id=?').get(p.id) as any).n,0)
  assert.deepEqual(getDocumentImportSource(p.id,preview.id,owner).bytes,source)
  assert.equal(previewDocumentImport(p.id,{kind:'script',filename:'原剧本.md',file_base64:source.toString('base64')},owner).id,preview.id,'identical draft preview is reused')
  assert.throws(()=>getDocumentImportSource(p.id,preview.id,other),/无访问权限/)
  assert.throws(()=>listDocumentImports(p.id,other),/无访问权限/)
})
test('finished scripts import atomically into content + script_content, replay is idempotent, mappings retained', () => {
  const p=project(), preview=previewDocumentImport(p.id,{kind:'script',text:'第11集开端\n甲：走。\n第12集结尾\n乙：好。'},owner)
  const input={sections:preview.sections.map((part,i)=>({...part,episode_number:21+i}))}
  const first=commitDocumentImport(p.id,preview.id,input,owner),again=commitDocumentImport(p.id,preview.id,input,owner)
  assert.equal(first.created,2);assert.equal(first.models_submitted,0);assert.equal(again.replayed,true);assert.deepEqual(again.episodes,first.episodes)
  const episodes=sql.prepare('SELECT * FROM episodes WHERE drama_id=? ORDER BY episode_number').all(p.id) as any[]
  assert.equal(episodes.length,2);assert.equal(episodes[0].content,episodes[0].script_content);assert.equal(episodes[0].episode_number,21)
  const mappings=sql.prepare('SELECT source_number,target_number FROM platform_document_import_episodes WHERE import_id=? ORDER BY ordinal').all(preview.id)
  assert.deepEqual(mappings,[{source_number:11,target_number:21},{source_number:12,target_number:22}])
  assert.throws(()=>commitDocumentImport(p.id,preview.id,{sections:[{...input.sections[0],title:'changed'}]},owner),/已经导入/)
  assert.throws(()=>commitDocumentImport(p.id,preview.id,input,other),/无访问权限/)
})
test('novels preserve full content and leave script_content empty',()=>{
  const p=project(), preview=previewDocumentImport(p.id,{kind:'novel',text:'第一章出发\n甲想：首发是我的名字。\n第二章回家\n免费阅读是台词。'},owner)
  const receipt=commitDocumentImport(p.id,preview.id,{sections:preview.sections},owner)
  const rows=sql.prepare('SELECT content,script_content FROM episodes WHERE drama_id=? ORDER BY episode_number').all(p.id) as any[]
  assert.equal(receipt.created,2);assert.ok(rows.every(row=>row.script_content===null));assert.equal(rows.map(row=>row.content).join(''),preview.sections.map(p=>p.content).join(''))
})
test('the same original cannot silently create a second set of episodes through another preview',()=>{
  const p=project(),input={kind:'script' as const,text:'第1集\n原文。'}
  const first=previewDocumentImport(p.id,input,owner);commitDocumentImport(p.id,first.id,{sections:first.sections},owner)
  const next=previewDocumentImport(p.id,input,owner)
  assert.equal(next.previous_imports.length,1);assert.throws(()=>commitDocumentImport(p.id,next.id,{sections:next.sections},owner),/已经导入过/)
  assert.equal(commitDocumentImport(p.id,next.id,{sections:next.sections,allow_duplicate_source:true},owner).created,1)
})
test('duplicate target numbers and conflicts never leave a partial import',()=>{
  const p=project(),a=previewDocumentImport(p.id,{kind:'script',text:'第1集\n甲。\n第2集\n乙。'},owner)
  db.insert(schema.episodes).values({dramaId:p.id,episodeNumber:2,title:'kept',createdAt:at,updatedAt:at}).run()
  assert.throws(()=>commitDocumentImport(p.id,a.id,{sections:a.sections},owner),/第 2 集已存在/)
  assert.equal((sql.prepare('SELECT count(*) n FROM episodes WHERE drama_id=?').get(p.id) as any).n,1)
  assert.throws(()=>commitDocumentImport(p.id,a.id,{sections:a.sections.map(s=>({...s,episode_number:5}))},owner),/重复/)
  assert.equal((sql.prepare('SELECT count(*) n FROM episodes WHERE drama_id=?').get(p.id) as any).n,1)
})
test('unexpected database failure rolls back every inserted episode and retains the source preview',()=>{
  const p=project(),a=previewDocumentImport(p.id,{kind:'script',text:'第1集\n甲。\n第2集\n乙。'},owner)
  sql.exec(`CREATE TEMP TRIGGER import_test_abort BEFORE INSERT ON episodes WHEN NEW.drama_id=${p.id} AND NEW.episode_number=2 BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END`)
  try{assert.throws(()=>commitDocumentImport(p.id,a.id,{sections:a.sections},owner),/synthetic rollback/)}finally{sql.exec('DROP TRIGGER import_test_abort')}
  assert.equal((sql.prepare('SELECT count(*) n FROM episodes WHERE drama_id=?').get(p.id) as any).n,0)
  assert.equal((sql.prepare('SELECT committed_at FROM platform_document_imports WHERE id=?').get(a.id) as any).committed_at,null)
})
test('long unbroken source is kept for manual split and never silently truncated',()=>{
  const p=project(), text='甲'.repeat(200001),a=previewDocumentImport(p.id,{kind:'script',text},owner)
  assert.equal(a.sections[0].content.length,200001);assert.ok(a.warnings.some(w=>w.includes('未截断')))
  assert.throws(()=>commitDocumentImport(p.id,a.id,{sections:a.sections},owner),/没有截断/)
  const left={...a.sections[0],content:text.slice(0,100000)},right={...a.sections[0],title:'续',episode_number:2,content:text.slice(100000)}
  assert.equal(commitDocumentImport(p.id,a.id,{sections:[left,right]},owner).created,2)
})
test('import HTTP routes enforce project access and return exact source bytes without public storage URLs',async()=>{
  const p=project(), app=new Hono()
  app.onError((error,c)=>c.json({message:error.message},(error as any).status||500))
  app.use('*',(c,next)=>security.runAsActor(c.req.header('x-test-other')?other:owner,next))
  app.route('/dramas',importRoutes)
  const body={kind:'script',text:'第1集\n甲：回家。'},headers={'Content-Type':'application/json'}
  const response=await app.request(`/dramas/${p.id}/imports/preview`,{method:'POST',headers,body:JSON.stringify(body)})
  assert.equal(response.status,200);const result=(await response.json() as any).data
  const source=await app.request(`/dramas/${p.id}/imports/${result.id}/source`)
  assert.equal(await source.text(),body.text);assert.equal(source.headers.get('cache-control'),'private, no-store')
  assert.equal((await app.request(`/dramas/${p.id}/imports/${result.id}/source`,{headers:{'x-test-other':'1'}})).status,404)
  const imported=await app.request(`/dramas/${p.id}/imports/${result.id}/commit`,{method:'POST',headers,body:JSON.stringify({sections:result.sections})})
  assert.equal(imported.status,200);assert.equal((await imported.json() as any).data.models_submitted,0)
})
