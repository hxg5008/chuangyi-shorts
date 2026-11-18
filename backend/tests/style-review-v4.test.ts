/** Independent preservation review: only synthetic styles and temporary data; no model requests. */
import {test,after} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {Hono} from 'hono'
const root=fs.mkdtempSync(path.join(os.tmpdir(),'chuangyi-style-review-'))
process.env.SQLITE_PATH=path.join(root,'test.sqlite3');process.env.HUOBAO_DATA_DIR=root;process.env.STORAGE_PATH=path.join(root,'static');process.env.MYSQL_AUTO_IMPORT='false'
const {db}=await import('../src/db/index.ts')
const security=await import('../src/services/platform-security/index.ts')
security.initPlatformSecurity();const owner=security.createUser('style-review-owner','synthetic-password').user
const styles=await import('../src/services/style-preset.ts')
const dramas=(await import('../src/routes/dramas.ts')).default
const at=new Date().toISOString(),sql=db.$client
const seed=(value:string,prompt:string)=>sql.prepare('INSERT INTO style_presets(name,value,prompt,is_active,created_at,updated_at) VALUES(?,?,?,1,?,?)').run(value,value,prompt,at,at)
const project=(value:string)=>Number(sql.prepare('INSERT INTO dramas(title,style,owner_user_id,created_at,updated_at) VALUES(?,?,?,?,?)').run('review',value,owner.id,at,at).lastInsertRowid)
after(()=>{sql.close();fs.rmSync(root,{recursive:true,force:true})})

test('an imported catalog value cannot replace a pre-existing custom style template',()=>{
  const catalog=JSON.parse(fs.readFileSync(new URL('../resources/style-catalog.json',import.meta.url),'utf8'))
  const existingValue=catalog.styles[0].value
  seed(existingValue,'MY EXISTING CUSTOM ART DIRECTION')
  styles.initStyleCatalog()
  const id=project(existingValue),snapshot=styles.getDramaStyleSnapshot(id)!
  assert.equal(snapshot.prompt,'MY EXISTING CUSTOM ART DIRECTION')
  assert.equal(styles.composeStylePrompt('actual character',snapshot,'asset_image'),'MY EXISTING CUSTOM ART DIRECTION, actual character')
})

test('switching an unmigrated legacy project captures the old cached asset style before selecting the new style',async()=>{
  seed('review-old','OLD VISUAL');seed('review-new','NEW VISUAL')
  const id=project('review-old'),cached='OLD VISUAL, character body'
  const characterId=Number(sql.prepare('INSERT INTO characters(drama_id,name,final_prompt,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,'person',cached,at,at).lastInsertRowid)
  assert.equal(sql.prepare('SELECT drama_id FROM platform_project_styles WHERE drama_id=?').get(id),undefined)
  const app=new Hono();app.use('*',(_c,next)=>security.runAsActor(owner,next));app.route('/dramas',dramas)
  const response=await app.request(`/dramas/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({style:'review-new'})})
  assert.equal(response.status,200)
  const result=await styles.composeProjectStyle(id,cached,'asset_image',{kind:'character',id:characterId})
  assert.equal(result.prompt,'NEW VISUAL, character body')
})

test('importing finished scripts into a styled project leaves the project style and source text unchanged',async()=>{
  const imports=await import('../src/services/document-import.ts')
  seed('review-import','Original aesthetic')
  const id=project('review-import'),before=styles.getDramaStyleSnapshot(id),text='第十二集\r\n甲：免费阅读是台词。\r\n'
  const preview=imports.previewDocumentImport(id,{kind:'script',text},owner)
  imports.commitDocumentImport(id,preview.id,{sections:preview.sections},owner)
  assert.deepEqual(styles.getDramaStyleSnapshot(id),before)
  const episode=sql.prepare('SELECT content,script_content FROM episodes WHERE drama_id=?').get(id) as any
  assert.equal(episode.content,text);assert.equal(episode.script_content,text)
  assert.equal((await styles.composeProjectStyle(id,'视频正文','video')).prompt,'Original aesthetic，\n视频正文')
})
test('scene layout trimming does not lose provenance when raw content or the style template ends with a newline',async()=>{
  const {buildSceneImagePrompt}=await import('../src/services/scene-image-contract.ts')
  seed('review-scene-a','old-context');seed('review-scene-b','new-context')
  styles.saveStyleMetadata('review-scene-a',{template:'OLD\n{content}\nOLD-END\n'},'old-context')
  styles.saveStyleMetadata('review-scene-b',{template:'NEW\n{content}\nNEW-END'},'new-context')
  const id=project('review-scene-a')
  const sceneId=Number(sql.prepare('INSERT INTO scenes(drama_id,location,time,prompt,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,'房间','夜','房间',at,at).lastInsertRowid)
  const cached=buildSceneImagePrompt(await styles.composeAssetStylePrompt(id,'scene',sceneId,'房间灯光\n'))
  sql.prepare('UPDATE dramas SET style=? WHERE id=?').run('review-scene-b',id)
  const result=await styles.composeProjectStyle(id,cached,'asset_image',{kind:'scene',id:sceneId})
  assert.ok(!result.prompt.includes('OLD'),result.prompt)
  assert.equal(result.prompt,'NEW\n房间灯光\n\nNEW-END','the raw prompt newline remains intact; only the previous style is removed')
})
