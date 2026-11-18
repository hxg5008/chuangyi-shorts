import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'

// Round 4 integration: the batch's 出图 step through the REAL asset routes, preparation middleware and image generation
// code, against a local mock image server (no external call, no cost). The final prompt is preset on every asset so no
// text model is called. The mock answers the 2nd request with a 429 and later ones normally.
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'huobao-round4-real-images-'))
process.env.HUOBAO_DATA_DIR=directory;process.env.SQLITE_PATH=path.join(directory,'t.sqlite3');process.env.STORAGE_PATH=path.join(directory,'static');process.env.WORKSPACE_PATH=path.join(directory,'workspace');process.env.MYSQL_AUTO_IMPORT='false';process.env.HUOBAO_PROXY_URL='direct'
const {db,schema}=await import('../src/db/index.ts')
const security=await import('../src/services/platform-security/index.ts')
security.initPlatformSecurity()
const owner=security.createUser('r4_real_owner','R4-real-owner-password').user
const {ProductionBatchManager}=await import('../src/services/production-batches.ts')
const {getModelChannelStore}=await import('../src/services/model-channels/store.ts')
const at=new Date().toISOString()
// 1×1 PNG.
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
let posts=0,maxActive=0,active=0,refused=0,alwaysForbidden=false
const upstream=http.createServer(async(req,res)=>{
  for await(const _ of req){/* drain */}
  res.setHeader('content-type','application/json')
  if(req.url!=='/v1/images/generations'){res.statusCode=404;return res.end('{}')}
  // Decide the reply at arrival time: exactly one request (the 2nd to arrive) is refused with a 403.
  const order=++posts,refuse=alwaysForbidden||order===2&&refused===0
  if(refuse)refused++
  active++;maxActive=Math.max(maxActive,active)
  await new Promise(resolve=>setTimeout(resolve,40))
  active--
  if(refuse){res.statusCode=alwaysForbidden?403:429;return res.end(JSON.stringify({error:{message:alwaysForbidden?'invalid permission':'burst refused',type:alwaysForbidden?'forbidden':'rate_limit'}}))}
  res.end(JSON.stringify({data:[{b64_json:png}]}))
})
await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve))
const upstreamURL='http://127.0.0.1:'+(upstream.address() as any).port
after(async()=>{upstream.close();db.$client.close();await fs.rm(directory,{recursive:true,force:true})})

test('出图 through the real routes: 4 missing images generated, the 429 one retried, existing image untouched, concurrency kept', async()=>{
  const store=getModelChannelStore()
  const channel=store.saveChannel({name:'mock-images',base_url:upstreamURL,api_key:'mock-key'})
  const binding=store.saveBinding(channel.id,{name:'mock-image',model:'mock-image-model',type:'image',protocol_id:'image.openai',enabled:true})
  const drama=db.insert(schema.dramas).values({title:'r4 real',ownerUserId:owner.id,createdAt:at,updatedAt:at}).returning().get()
  const episode=db.insert(schema.episodes).values({dramaId:drama.id,episodeNumber:1,title:'E',scriptContent:'林轩：走。',imageConfigId:binding.config_id,createdAt:at,updatedAt:at} as any).returning().get()
  const add=(table:any,link:any,field:string,values:any)=>{const row=db.insert(table).values({dramaId:drama.id,finalPrompt:'preset final prompt',createdAt:at,updatedAt:at,...values}).returning().get();db.insert(link).values({episodeId:episode.id,[field]:row.id,createdAt:at} as any).run();return row}
  const c1=add(schema.characters,schema.episodeCharacters,'characterId',{name:'林轩'})
  const c2=add(schema.characters,schema.episodeCharacters,'characterId',{name:'赵天宇'})
  const s1=add(schema.scenes,schema.episodeScenes,'sceneId',{location:'会所',time:'夜',prompt:'会所'})
  const p1=add(schema.props,schema.episodeProps,'propId',{name:'托盘'})
  const kept=add(schema.props,schema.episodeProps,'propId',{name:'玉扳指',imageUrl:'static/images/kept.png'})
  const manager=new ProductionBatchManager(db.$client,{resolveChoice:async()=>({configId:7,model:'text-x',parameters:{},version:'v'}),recipeVersion:()=>'r',
    pollMs:20,retryDelaysMs:[50,50],submitGapMs:0,imageWaitMs:20_000,autoDispatch:false})
  const batch=await manager.create({drama_id:drama.id,episode_ids:[episode.id],targets:['images'],image_concurrency:2},owner)
  await manager.pump()
  for(let n=0;n<600;n++){await manager.pump();const detail=manager.get(batch.id,owner);if(detail.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,20))}
  await manager.settle()
  const step=manager.get(batch.id,owner).steps[0],result=step.result as any
  manager.close()
  assert.equal(step.status,'completed',JSON.stringify(step))
  assert.equal(result.total,5);assert.equal(result.skipped_existing,1);assert.equal(result.generated,4);assert.deepEqual(result.failed,[])
  assert.equal(posts,5,'4 images + 1 retry of the refused one')
  assert.ok(maxActive<=2,'never more than image_concurrency requests at the image service: '+maxActive)
  const image=(table:string,id:number)=>(db.$client.prepare(`SELECT image_url FROM ${table} WHERE id=?`).get(id) as any).image_url
  for(const [table,id] of [['characters',c1.id],['characters',c2.id],['scenes',s1.id],['props',p1.id]] as const)assert.match(String(image(table,id)),/^static\/images\/.+\.png$/u)
  assert.equal(image('props',kept.id),'static/images/kept.png','an existing image is never replaced')
  const tasks=db.$client.prepare("SELECT status,error_code FROM sys_task WHERE type='image' ORDER BY id").all() as any[]
  assert.deepEqual(tasks.map(t=>t.status).sort(),['completed','completed','completed','completed','failed'])
  assert.equal(tasks.find(t=>t.status==='failed').error_code,'generation_rate_limited')
})

test('a definite authentication/permission failure is shown once and does not repeatedly submit the asset',async()=>{
  alwaysForbidden=true;const before=posts
  const store=getModelChannelStore(),channel=store.saveChannel({name:'auth-test',base_url:upstreamURL,api_key:'mock-invalid-key'})
  const binding=store.saveBinding(channel.id,{name:'auth-image',model:'auth-image-model',type:'image',protocol_id:'image.openai',enabled:true})
  const drama=db.insert(schema.dramas).values({title:'auth refusal',ownerUserId:owner.id,createdAt:at,updatedAt:at}).returning().get()
  const episode=db.insert(schema.episodes).values({dramaId:drama.id,episodeNumber:1,title:'E',scriptContent:'测试',imageConfigId:binding.config_id,createdAt:at,updatedAt:at}).returning().get()
  const prop=db.insert(schema.props).values({dramaId:drama.id,name:'杯子',finalPrompt:'a cup',createdAt:at,updatedAt:at}).returning().get()
  db.insert(schema.episodeProps).values({episodeId:episode.id,propId:prop.id,createdAt:at}).run()
  const manager=new ProductionBatchManager(db.$client,{resolveChoice:async()=>({configId:7,model:'text-x',parameters:{},version:'v'}),recipeVersion:()=>'r',pollMs:20,retryDelaysMs:[10,10],submitGapMs:0,imageWaitMs:10_000,autoDispatch:false})
  const batch=await manager.create({drama_id:drama.id,episode_ids:[episode.id],targets:['images'],image_concurrency:4},owner)
  for(let n=0;n<300;n++){await manager.pump();if(manager.get(batch.id,owner).status!=='running')break;await new Promise(resolve=>setTimeout(resolve,20))}
  await manager.settle();const detail=manager.get(batch.id,owner);manager.close()
  assert.equal(detail.steps[0].status,'failed');assert.equal(posts-before,1)
  assert.equal((detail.steps[0].result as any).failed[0].error_code,'generation_auth_failed')
})
