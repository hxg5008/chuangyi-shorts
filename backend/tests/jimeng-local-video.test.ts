import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'

const root=await fs.mkdtemp(path.join(os.tmpdir(),'firebo-jimeng-contract-'))
process.env.SQLITE_PATH=path.join(root,'db.sqlite3');process.env.HUOBAO_DATA_DIR=root
process.env.STORAGE_PATH=path.join(root,'static');process.env.MYSQL_AUTO_IMPORT='false';process.env.HUOBAO_PROXY_URL='direct'
// The synthetic MP4 header is not a decodable movie; skip poster extraction the same way the other delivery tests do.
process.env.FFMPEG_BIN='/unavailable-test-ffmpeg'
const { db,schema }=await import('../src/db/index.ts')
const { generateVideo,recoverVideoTask,resumeInterruptedTasks,isTaskActive }=await import('../src/services/generation.ts')
const { JimengLocalVideoAdapter,buildJimengBindings,normalizeJimengBaseUrl,promptHash }=await import('../src/services/adapters/jimeng-local-video.ts')
const { parseJimengCatalog }=await import('../src/services/jimeng-local-config.ts')
const { freezeJimengReferences,prepareJimengVideoRecord }=await import('../src/services/jimeng-local-media.ts')
const tasks=(await import('../src/routes/tasks.ts')).default
const configs=(await import('../src/routes/aiConfigs.ts')).default
const adapter=new JimengLocalVideoAdapter(),ts=new Date().toISOString()
const submissions:any[]=[],received=new Map<string,any>()
let loseResponse=false,postCount=0,contentCalls=0,lookupCount=0,pollCount=0,catalogMode='native'
// Round 3 (item 9): the local service saves the original file on POST /v1/downloads; content is served afterwards.
const saved=new Set<string>(),downloadRequests:string[]=[]
let downloadMode:'ok'|'refuse'='refuse'
const video=Buffer.concat([Buffer.from([0,0,0,0x18]),Buffer.from('ftypmp42'),Buffer.alloc(64,1)])
const image=await sharp({create:{width:4,height:3,channels:4,background:'#765432'}}).png().toBuffer()
const data='data:image/png;base64,'+image.toString('base64')
const server=http.createServer(async(req,res)=>{
  let payload='';for await(const part of req)payload+=part
  res.setHeader('Content-Type','application/json')
  if(req.headers.authorization!=='Bearer test-only-key'){res.writeHead(401).end('{}');return}
  if(req.url==='/v1/models'){
    res.end(JSON.stringify(catalogMode==='mixed'?{object:'list',service:'chuangyi-local-hub',data:[{id:'gpt-6.1-sol'},{id:'jimeng-2.0-fast',service:'jimeng-local-service',protocol:'jimeng-local-video-v1',modality:'video',delivery_mode:'local_manual'}]}:{object:'list',service:'jimeng-local-service',version:'0.1.5',data:[{id:'jimeng-2.0-fast',owned_by:'local-adapter'}]}));return
  }
  if(req.url==='/v1/status'){res.end(JSON.stringify({service:'jimeng-local-service',version:'0.1.5',active:0,queued:0}));return}
  if(req.url==='/v1/videos'&&req.method==='POST'){
    postCount++;const body=JSON.parse(payload);submissions.push(body)
    const result={id:'jm_'+randomUUID().replaceAll('-',''),status:body.prompt.includes('失败测试')?'failed':'completed',stage:'ready_for_download',prompt_sha256:body.prompt_sha256,reference_count:body.images.length,delivery_mode:'local_manual',download_ready:true,
      ...(body.prompt.includes('失败测试')?{stage:'upstream_failed',error_code:'input_image_rejected',error:'参考图可能包含低俗内容，请修改后重试。 Cookie: private-session https://secret.invalid/?key=hidden'}:{})}
    received.set(body.client_request_id,result)
    if(loseResponse){res.end('{invalid');return}
    res.writeHead(202).end(JSON.stringify(result));return
  }
  if(req.url?.startsWith('/v1/videos/by-request/')){lookupCount++;const result=received.get(req.url.split('/').at(-1)!);res.writeHead(result?200:404).end(JSON.stringify(result||{}));return}
  if(req.url==='/v1/downloads'&&req.method==='POST'){
    const ids=JSON.parse(payload).ids as string[];downloadRequests.push(...ids)
    if(downloadMode==='refuse'){res.writeHead(202).end(JSON.stringify({accepted:[],skipped:ids.map(id=>({id,reason:'原账号已移除，无法刷新成片地址。'}))}));return}
    for(const id of ids)saved.add(id)
    res.writeHead(202).end(JSON.stringify({accepted:ids,skipped:[]}));return
  }
  if(req.url?.endsWith('/content')){contentCalls++;const id=req.url.split('/').at(-2)!;if(!saved.has(id)){res.writeHead(409).end('{}');return}res.setHeader('Content-Type','video/mp4');res.end(video);return}
  if(req.url?.startsWith('/v1/videos/')){pollCount++;const result=[...received.values()].find(r=>'/v1/videos/'+r.id===req.url);res.writeHead(result?200:404).end(JSON.stringify(result?{...result,has_local_file:saved.has(result.id)}:{}));return}
  res.writeHead(404).end('{}')
})
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
const base=`http://127.0.0.1:${(server.address() as any).port}`
const cfg=db.insert(schema.aiServiceConfigs).values({serviceType:'video',provider:'jimeng_local',name:'isolated',baseUrl:base,apiKey:'test-only-key',model:'["jimeng-2.0-fast"]',createdAt:ts,updatedAt:ts}).returning().get()
const row=(id:number)=>db.select().from(schema.sysTask).where(eq(schema.sysTask.id,id)).get()!
async function terminal(id:number){for(let i=0;i<1500;i++){const r=row(id);if(r.status!=='processing'&&!isTaskActive(id))return r;await new Promise(r=>setTimeout(r,10))}assert.fail('isolated task did not finish')}
const defaults={prompt:'@母亲站A处，@卧室内转身。',configId:cfg.id,duration:5,aspectRatio:'16:9',referenceImageUrls:[data,data],referenceImageNames:['母亲','卧室']}
function episodeFixture(episodeNumber:number) {
  const drama=db.insert(schema.dramas).values({title:'numbering fixture',createdAt:ts,updatedAt:ts}).returning().get()
  const episode=db.insert(schema.episodes).values({dramaId:drama.id,episodeNumber,title:'isolated episode',createdAt:ts,updatedAt:ts}).returning().get()
  return {drama,episode}
}

after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));(db as any).$client.close();await fs.rm(root,{recursive:true,force:true})})

test('base URL normalization accepts standalone or unified roots without credentials/query',()=>{
  assert.equal(normalizeJimengBaseUrl(base+'/v1'),base)
  assert.equal(normalizeJimengBaseUrl(base+'/jimeng/v1'),base+'/jimeng')
  for(const value of [base+'?key=x',base+'/other','ftp://localhost', 'https://user:pass@example.invalid'])assert.throws(()=>normalizeJimengBaseUrl(value))
})
test('bound-name parsing preserves Chinese narration, numbered mentions and emoji offsets',()=>{
  assert.deepEqual(buildJimengBindings('🙂 @母亲站A(X+0.8米，Y0)，@卧室内；@图片1母亲从桌边起身。',['母亲','卧室']),[
    {token:'@母亲',reference_id:'image_1'},{token:'@卧室',reference_id:'image_2'},{token:'@图片1母亲',reference_id:'image_1'}])
  assert.throws(()=>buildJimengBindings('@母亲。',['母亲','母亲']),/同名/)
  assert.throws(()=>buildJimengBindings('@母亲·童年。',['母亲']),/没有唯一对应/)
  assert.deepEqual(buildJimengBindings('name@example.com',[]),[])
  assert.throws(()=>buildJimengBindings('@花衬衫甲追视@愣头青亮刀。',['刀疤脸']),error=>error instanceof Error&&!error.message.includes('@愣头青'))
  assert.deepEqual(buildJimengBindings('🙂 他说：“@花衬衫甲，这是台词。” @刀疤脸站着。',['刀疤脸']),[{token:'@刀疤脸',reference_id:'image_1'}])
  assert.deepEqual(buildJimengBindings('Julian said: "@unknown is literal." @刀疤脸站着。',['刀疤脸']),[{token:'@刀疤脸',reference_id:'image_1'}])
})
test('model discovery accepts only a verified native or explicit unified Jimeng entry',()=>{
  assert.equal(parseJimengCatalog({object:'list',service:'jimeng-local-service',version:'0.1.5',data:[{id:'jimeng-2.0-fast',owned_by:'local-adapter'}]})[0].id,'jimeng-2.0-fast')
  assert.equal(parseJimengCatalog({object:'list',data:[{id:'gpt-x'},{id:'jimeng-2.0-fast',protocol:'jimeng-local-video-v1',service:'jimeng-local-service',modality:'video',delivery_mode:'local_manual'}]})[0].id,'jimeng-2.0-fast')
  assert.throws(()=>parseJimengCatalog({object:'list',data:[{id:'jimeng-2.0-fast'}]}),/未声明/)
})
test('readonly config checks and discovery do not create a video or expose service account data',async()=>{
  const before=postCount
  for(catalogMode of ['native','mixed']){
    const payload={service_type:'video',provider:'jimeng_local',base_url:base,api_key:'test-only-key',model:['jimeng-2.0-fast']}
    for(const endpoint of ['/test','/models']){
      const response=await configs.request(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
      const body=await response.json() as any;assert.equal(response.status,200);assert.equal(body.code,200)
      assert.ok(endpoint==='/test'?body.data.ok:body.data.models[0].supported)
      assert.doesNotMatch(JSON.stringify(body),/test-only-key|private-session/)
    }
  }
  assert.equal(postCount,before)
})
test('nine references reach the local service with intact bytes and image_9 binding; ten are rejected',async()=>{
  const names=Array.from({length:9},(_,i)=>`素材${i+1}`),prompt='🙂 @素材1。@素材9在最后，顺序不变。'
  const before=postCount
  const id=await generateVideo({...defaults,prompt,referenceImageUrls:names.map(()=>data),referenceImageNames:names})
  await terminal(id)
  const sent=submissions.at(-1)
  assert.equal(postCount,before+1)
  assert.equal(sent.prompt,prompt)
  assert.deepEqual(sent.images.map((item:any)=>item.name),names)
  assert.deepEqual(sent.images.map((item:any)=>item.id),names.map((_,i)=>`image_${i+1}`))
  assert.ok(sent.images.every((item:any)=>Buffer.from(item.data_base64,'base64').equals(image)))
  assert.deepEqual(sent.bindings.at(-1),{token:'@素材9',reference_id:'image_9'})
  assert.throws(()=>adapter.buildGenerateRequest(cfg as any,{model:'jimeng-2.0-fast',prompt,referenceImageUrls:Array(10).fill(data),referenceImageNames:[...names,'素材10']}),/最多9张/)
  assert.equal(postCount,before+1)
})
test('frozen originals retain duplicate positions and survive source-file changes',async()=>{
  await fs.mkdir(path.join(root,'static','test'),{recursive:true});const file=path.join(root,'static','test','asset.png');await fs.writeFile(file,image)
  const record={id:1,model:'jimeng-2.0-fast',prompt:'@母亲与@卧室。',referenceImageUrls:JSON.stringify(['static/test/asset.png','static/test/asset.png']),referenceImageNames:JSON.stringify(['母亲','卧室'])}
  const snapshots=await freezeJimengReferences(record)
  await fs.writeFile(file,'changed')
  const prepared=await prepareJimengVideoRecord(record,snapshots)
  assert.equal(prepared.jimengImages!.length,2)
  assert.equal(prepared.jimengImages![0].data_base64,image.toString('base64'))
  assert.equal(prepared.jimengImages![1].name,'卧室')
  await assert.rejects(freezeJimengReferences({...record,prompt:'@母亲。',referenceImageUrls:'["static/../escape.png"]',referenceImageNames:'["母亲"]'}),/目录跳转/)
})
test('task creation sends one immutable payload; a refused automatic fetch keeps manual delivery and never touches the storyboard',async()=>{
  const {drama,episode}=episodeFixture(1)
  const storyboard=db.insert(schema.storyboards).values({episodeId:episode.id,storyboardNumber:73,videoUrl:'static/old.mp4',createdAt:ts,updatedAt:ts}).returning().get()
  const id=await generateVideo({...defaults,storyboardId:storyboard.id,dramaId:drama.id}),done=await terminal(id),sent=submissions.at(-1)
  assert.equal(done.status,'completed');assert.equal(done.stage,'ready_in_local_service');assert.equal(done.localPath,null);assert.equal(done.resultUrl,null)
  assert.equal(done.errorCode,'auto_delivery_failed');assert.match(done.errorMsg||'',/原账号已移除/)
  assert.equal(sent.prompt,defaults.prompt);assert.equal(sent.prompt_sha256,promptHash(defaults.prompt))
  assert.match(sent.client_request_id,/^[0-9a-f-]{36}$/);assert.equal(JSON.parse(done.params!).idempotencyKey,sent.client_request_id)
  assert.deepEqual(sent.metadata,{storyboard_id:storyboard.id,drama_id:drama.id,episode_number:1,storyboard_number:1})
  assert.deepEqual(JSON.parse(done.params!).jimengMetadata,sent.metadata)
  assert.deepEqual(sent.images.map((i:any)=>i.name),['母亲','卧室']);assert.deepEqual(sent.images.map((i:any)=>i.sha256),[createHash('sha256').update(image).digest('hex'),createHash('sha256').update(image).digest('hex')])
  assert.equal(contentCalls,0);assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id,storyboard.id)).get()!.videoUrl,'static/old.mp4')
})
test('round 3: a finished video is fetched from the local service and written to its storyboard, without a new generation',async()=>{
  downloadMode='ok'
  const {drama,episode}=episodeFixture(1)
  const storyboard=db.insert(schema.storyboards).values({episodeId:episode.id,storyboardNumber:1,createdAt:ts,updatedAt:ts}).returning().get()
  const before=postCount
  const id=await generateVideo({...defaults,storyboardId:storyboard.id,dramaId:drama.id}),done=await terminal(id)
  assert.equal(done.status,'completed');assert.equal(done.stage,'completed');assert.ok(done.localPath)
  assert.equal(postCount,before+1,'exactly the one original submission')
  assert.ok(downloadRequests.includes(done.taskId!),'the local service was asked to save the original file')
  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id,storyboard.id)).get()!.videoUrl,done.localPath)
  assert.equal((await fs.readFile(path.join(root,done.localPath!.replace(/^static\//,'static/')))).subarray(4,8).toString('ascii'),'ftyp')
  downloadMode='refuse'
})
test('round 3: an earlier manually-delivered video is fetched by restore, and the storyboard is updated',async()=>{
  const {drama,episode}=episodeFixture(1)
  const storyboard=db.insert(schema.storyboards).values({episodeId:episode.id,storyboardNumber:1,createdAt:ts,updatedAt:ts}).returning().get()
  const id=await generateVideo({...defaults,storyboardId:storyboard.id,dramaId:drama.id}),manual=await terminal(id)
  assert.equal(manual.stage,'ready_in_local_service')
  downloadMode='ok';const before=postCount
  await recoverVideoTask(id);const fetched=await terminal(id)
  assert.equal(fetched.stage,'completed');assert.equal(postCount,before,'restore never submits a generation')
  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id,storyboard.id)).get()!.videoUrl,fetched.localPath)
  downloadMode='refuse'
})
test('card metadata uses actual episode number and full page rank, not non-contiguous database numbers or IDs',async()=>{
  const {drama,episode}=episodeFixture(2)
  const shots=db.insert(schema.storyboards).values([80,10,30].map(storyboardNumber=>({episodeId:episode.id,storyboardNumber,createdAt:ts,updatedAt:ts,
    ...(storyboardNumber===30?{deletedAt:ts}:{})}))).returning().all()
  const target=shots.find(shot=>shot.storyboardNumber===80)!
  const id=await generateVideo({...defaults,storyboardId:target.id,dramaId:drama.id}),done=await terminal(id),sent=submissions.at(-1)
  assert.equal(done.status,'completed')
  assert.deepEqual(sent.metadata,{storyboard_id:target.id,drama_id:drama.id,episode_number:2,storyboard_number:3})
  assert.equal(`${sent.metadata.episode_number}-${String(sent.metadata.storyboard_number).padStart(2,'0')}`,'2-03')
  assert.equal(sent.prompt,defaults.prompt);assert.equal(sent.prompt_sha256,promptHash(defaults.prompt))
  assert.deepEqual(sent.bindings,[{token:'@母亲',reference_id:'image_1'},{token:'@卧室',reference_id:'image_2'}])
})
test('page rank 100 is preserved as 1-100 and model trials do not invent episode numbering',async()=>{
  const {drama,episode}=episodeFixture(1)
  const shots=db.insert(schema.storyboards).values(Array.from({length:100},(_,i)=>({episodeId:episode.id,storyboardNumber:(i+1)*10,createdAt:ts,updatedAt:ts}))).returning().all()
  const id=await generateVideo({...defaults,storyboardId:shots[99].id,dramaId:drama.id});await terminal(id)
  const sent=submissions.at(-1)
  assert.deepEqual(sent.metadata,{storyboard_id:shots[99].id,drama_id:drama.id,episode_number:1,storyboard_number:100})
  assert.equal(`${sent.metadata.episode_number}-${String(sent.metadata.storyboard_number).padStart(2,'0')}`,'1-100')
  const trial=await generateVideo(defaults);await terminal(trial)
  assert.deepEqual(submissions.at(-1).metadata,{})
})
test('page numbering is frozen before submission and restart queries keep it after source reordering or deletion',async()=>{
  const {drama,episode}=episodeFixture(1)
  const shots=db.insert(schema.storyboards).values([10,30].map(storyboardNumber=>({episodeId:episode.id,storyboardNumber,createdAt:ts,updatedAt:ts}))).returning().all()
  const id=await generateVideo({...defaults,storyboardId:shots[1].id,dramaId:drama.id})
  const frozen={storyboard_id:shots[1].id,drama_id:drama.id,episode_number:1,storyboard_number:2}
  assert.deepEqual(JSON.parse(row(id).params!).jimengMetadata,frozen)
  db.update(schema.episodes).set({episodeNumber:9}).where(eq(schema.episodes.id,episode.id)).run()
  db.delete(schema.storyboards).where(eq(schema.storyboards.id,shots[0].id)).run()
  const done=await terminal(id),sent=submissions.at(-1)
  assert.deepEqual(sent.metadata,frozen)
  const recovery=db.insert(schema.sysTask).values({type:'video',provider:'jimeng_local',configId:cfg.id,configBaseUrl:base,
    storyboardId:shots[1].id,dramaId:drama.id,model:done.model,prompt:done.prompt,taskId:done.taskId,status:'processing',
    params:done.params,createdAt:ts,updatedAt:ts}).returning().get()
  db.delete(schema.storyboards).where(eq(schema.storyboards.id,shots[1].id)).run()
  const before=postCount
  await resumeInterruptedTasks()
  assert.equal((await terminal(recovery.id)).status,'completed');assert.equal(postCount,before)
  assert.deepEqual(JSON.parse(row(recovery.id).params!).jimengMetadata,frozen)
})
test('lost POST response looks up persisted UUID and never resends generation',async()=>{
  loseResponse=true;const before=postCount,lookupBefore=lookupCount
  const id=await generateVideo(defaults);const done=await terminal(id)
  loseResponse=false
  assert.equal(done.status,'completed');assert.equal(postCount,before+1);assert.equal(lookupCount,lookupBefore+1)
})
test('upstream moderation failure becomes terminal and preserves safe Chinese reason',async()=>{
  const id=await generateVideo({...defaults,prompt:'失败测试 @母亲。'}),failed=await terminal(id)
  assert.equal(failed.status,'failed');assert.equal(failed.errorCode,'generation_failed');assert.match(failed.errorMsg!,/低俗内容/)
  assert.doesNotMatch(failed.errorMsg!,/private-session|secret.invalid|hidden/)
  await assert.rejects(recoverVideoTask(id),/已确认生成失败/)
})
test('restart recovery queries saved receipt without waiting for or submitting another generation',async()=>{
  const prior=submissions.find(item=>item.images.length===2&&item.images[0].name==='母亲'),receipt=received.get(prior.client_request_id)
  const r=db.insert(schema.sysTask).values({type:'video',provider:'jimeng_local',configId:cfg.id,configBaseUrl:base,model:'jimeng-2.0-fast',prompt:prior.prompt,
    taskId:receipt.id,status:'processing',params:JSON.stringify({idempotencyKey:prior.client_request_id,referenceImageUrls:[data,data],referenceImageNames:['母亲','卧室']}),createdAt:ts,updatedAt:ts}).returning().get()
  const before=postCount,start=Date.now();await resumeInterruptedTasks();assert.ok(Date.now()-start<1000)
  assert.equal((await terminal(r.id)).stage,'ready_in_local_service');assert.equal(postCount,before)
})
test('unknown UUID receipt and changed service config never permit a new POST',async()=>{
  const r=db.insert(schema.sysTask).values({type:'video',provider:'jimeng_local',configId:cfg.id,configBaseUrl:base,prompt:'unknown',model:'jimeng-2.0-fast',status:'failed',errorCode:'submission_unknown',params:JSON.stringify({idempotencyKey:randomUUID(),referenceImageUrls:[]}),createdAt:ts,updatedAt:ts}).returning().get()
  const before=postCount;await recoverVideoTask(r.id);assert.equal((await terminal(r.id)).errorCode,'submission_unknown');assert.equal(postCount,before)
  db.update(schema.aiServiceConfigs).set({baseUrl:base+'/jimeng'}).where(eq(schema.aiServiceConfigs.id,cfg.id)).run()
  await assert.rejects(recoverVideoTask(r.id),/原视频服务配置/)
  db.update(schema.aiServiceConfigs).set({baseUrl:base}).where(eq(schema.aiServiceConfigs.id,cfg.id)).run()
})
test('existing task route retains original style prefix and final prompt, maps reference names without truncation',async()=>{
  db.insert(schema.stylePresets).values({value:'jimeng_test_style',name:'test',prompt:'Original style',isActive:true,sortOrder:99,createdAt:ts,updatedAt:ts}).run()
  const drama=db.insert(schema.dramas).values({title:'isolated',style:'jimeng_test_style',createdAt:ts,updatedAt:ts}).returning().get()
  const response=await tasks.request('/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'video',config_id:cfg.id,drama_id:drama.id,model:'jimeng-2.0-fast',prompt:defaults.prompt,duration:5,aspect_ratio:'16:9',reference_image_urls:[data,data],reference_image_names:['母亲','卧室']})})
  const result=await response.json() as any;assert.equal(response.status,201);await terminal(result.data.id)
  assert.equal(submissions.at(-1).prompt,'Original style，\n'+defaults.prompt)
  assert.deepEqual(submissions.at(-1).images.map((i:any)=>i.name),['母亲','卧室'])
})
test('POST tasks accepts all nine named references and rejects ten before local or upstream task creation',async()=>{
  const names=Array.from({length:9},(_,i)=>`素材${i+1}`)
  const prompt='🙂 @素材1。@素材9保持末尾位置。'
  const request={type:'video',config_id:cfg.id,model:'jimeng-2.0-fast',prompt,duration:5,aspect_ratio:'16:9',reference_image_urls:names.map(()=>data),reference_image_names:names}
  const before=postCount
  const response=await tasks.request('/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)})
  const result=await response.json() as any
  assert.equal(response.status,201,JSON.stringify(result))
  await terminal(result.data.id)
  assert.equal(postCount,before+1)
  const sent=submissions.at(-1)
  assert.equal(sent.images.length,9)
  assert.deepEqual(sent.images.map((item:any)=>item.name),names)
  assert.deepEqual(sent.images.map((item:any)=>item.id),names.map((_,i)=>`image_${i+1}`))
  assert.equal(sent.images[8].sha256,createHash('sha256').update(image).digest('hex'))
  assert.ok(Buffer.from(sent.images[8].data_base64,'base64').equals(image))
  assert.deepEqual(sent.bindings.at(-1),{token:'@素材9',reference_id:'image_9'})
  const taskCount=db.select().from(schema.sysTask).all().length
  const rejected=await tasks.request('/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...request,reference_image_urls:Array(10).fill(data),reference_image_names:[...names,'素材10']})})
  const failure=await rejected.json() as any
  assert.equal(rejected.status,400)
  assert.match(failure.message,/最多9张/)
  assert.equal(db.select().from(schema.sysTask).all().length,taskCount)
  assert.equal(postCount,before+1)
})
test('actual task submission uses selected-image projection and keeps unselected action text without a binding',async()=>{
  const { projectJimengSelectedMentions }=await import('../../frontend/app/utils/jimeng-selected-mentions.js')
  const raw='@花衬衫甲追视@愣头青亮刀动作后错开眨眼，刀疤脸拿起弹簧刀，说：“@花衬衫甲别动。”'
  const selected=['刀疤脸','弹簧刀'],known=['花衬衫甲','愣头青',...selected]
  const prompt=projectJimengSelectedMentions(raw,known,selected),before=postCount
  assert.equal(prompt,'花衬衫甲追视愣头青亮刀动作后错开眨眼，@刀疤脸拿起@弹簧刀，说：“@花衬衫甲别动。”')
  const response=await tasks.request('/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'video',config_id:cfg.id,model:'jimeng-2.0-fast',prompt,duration:12,aspect_ratio:'9:16',reference_image_urls:selected.map(()=>data),reference_image_names:selected})})
  const result=await response.json() as any;assert.equal(response.status,201,JSON.stringify(result));await terminal(result.data.id)
  const sent=submissions.at(-1);assert.equal(postCount,before+1);assert.equal(sent.prompt,prompt);assert.deepEqual(sent.images.map((item:any)=>item.name),selected)
  assert.deepEqual(sent.bindings,[{token:'@刀疤脸',reference_id:'image_1'},{token:'@弹簧刀',reference_id:'image_2'}])
  assert.ok(sent.prompt.includes('花衬衫甲追视愣头青亮刀动作后错开眨眼'))
})
test('unsupported controls, too many refs, corrupt bytes and malformed names fail before creating a remote task',async()=>{
  const before=postCount
  await assert.rejects(generateVideo({...defaults,generateAudio:false}),/结构化参数/)
  await assert.rejects(generateVideo({...defaults,referenceImageUrls:Array(10).fill(data),referenceImageNames:Array(10).fill('x')}),/最多9/)
  await assert.rejects(generateVideo({...defaults,prompt:'@母亲。',referenceImageUrls:['data:image/png;base64,YQ=='],referenceImageNames:['母亲']}),/完整/)
  await assert.rejects(generateVideo({...defaults,referenceImageNames:['@x','卧室']}),/名称/)
  assert.equal(postCount,before)
})
