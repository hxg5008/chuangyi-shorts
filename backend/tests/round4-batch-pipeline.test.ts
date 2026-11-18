import { test, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

// Round 4 (2026-11-08, user-approved "按你建议来做"): one batch runs 提取 → 出图 → 拆分镜 for several episodes.
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'huobao-round4-batch-'))
process.env.HUOBAO_DATA_DIR=temporary;process.env.SQLITE_PATH=path.join(temporary,'r4.sqlite3');process.env.STORAGE_PATH=path.join(temporary,'static');process.env.MYSQL_AUTO_IMPORT='false';process.env.HUOBAO_PROXY_URL='direct'
const {db,schema}=await import('../src/db/index.ts')
const security=await import('../src/services/platform-security/index.ts')
security.initPlatformSecurity()
const owner=security.createUser('round4-owner','synthetic-password').user
const {ProductionBatchManager,storyboardBreakdownMessage}=await import('../src/services/production-batches.ts')
const {currentActivity}=await import('../src/services/activity/context.ts')
const at=new Date().toISOString(),pause=(ms=0)=>new Promise<void>(resolve=>setTimeout(resolve,ms))
const managers:InstanceType<typeof ProductionBatchManager>[]=[]
afterEach(async()=>{
  const closing=managers.splice(0);for(const manager of closing)manager.close()
  // A closed manager's step runs stop at their next check without touching the database.
  await Promise.all(closing.map(manager=>manager.settle()))
  db.$client.exec('DELETE FROM platform_production_receipts; DELETE FROM platform_production_steps; DELETE FROM platform_production_batches;')
  if(db.$client.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='platform_asset_image_jobs'").get())db.$client.exec('DELETE FROM platform_asset_image_jobs;')
})
after(async()=>{db.$client.close();await fs.rm(temporary,{recursive:true,force:true})})
let imageSequence=0

/** Two episodes; 林轩 is shared, 李玄风 only in episode 2, a narrator is linked too; one scene already has an image. */
function fixture(){
  const drama=db.insert(schema.dramas).values({title:'round4',ownerUserId:owner.id,createdAt:at,updatedAt:at}).returning().get()
  const video=db.insert(schema.aiServiceConfigs).values({serviceType:'video',provider:'openai',name:'v',baseUrl:'https://example.invalid',apiKey:'',model:JSON.stringify(['seedance-x']),isActive:true,createdAt:at,updatedAt:at} as any).returning().get()
  const episodes=[1,2].map(n=>db.insert(schema.episodes).values({dramaId:drama.id,episodeNumber:n,title:'E'+n,scriptContent:'林轩：走。',videoConfigId:video.id,createdAt:at,updatedAt:at} as any).returning().get())
  const shared=db.insert(schema.characters).values({dramaId:drama.id,name:'林轩',createdAt:at,updatedAt:at}).returning().get()
  const late=db.insert(schema.characters).values({dramaId:drama.id,name:'李玄风',createdAt:at,updatedAt:at}).returning().get()
  const voice=db.insert(schema.characters).values({dramaId:drama.id,name:'旁白',role:'旁白',createdAt:at,updatedAt:at}).returning().get()
  const drawn=db.insert(schema.scenes).values({dramaId:drama.id,location:'宿舍',time:'夜',prompt:'宿舍',imageUrl:'static/images/old.png',createdAt:at,updatedAt:at} as any).returning().get()
  const fresh=db.insert(schema.scenes).values({dramaId:drama.id,location:'会所',time:'夜',prompt:'会所',createdAt:at,updatedAt:at}).returning().get()
  const prop=db.insert(schema.props).values({dramaId:drama.id,name:'托盘',createdAt:at,updatedAt:at}).returning().get()
  const link=(table:any,episodeId:number,field:string,id:number)=>db.insert(table).values({episodeId,[field]:id,createdAt:at} as any).run()
  link(schema.episodeCharacters,episodes[0].id,'characterId',shared.id);link(schema.episodeCharacters,episodes[0].id,'characterId',voice.id)
  link(schema.episodeCharacters,episodes[1].id,'characterId',shared.id);link(schema.episodeCharacters,episodes[1].id,'characterId',late.id)
  link(schema.episodeScenes,episodes[0].id,'sceneId',drawn.id);link(schema.episodeScenes,episodes[1].id,'sceneId',fresh.id)
  link(schema.episodeProps,episodes[1].id,'propId',prop.id)
  return {drama,episodes,shared,late,voice,drawn,fresh,prop,video}
}
const choice=async(input:any)=>({configId:input.config_id||7,model:input.model||'text-x',parameters:{},version:'text-x'})
/** A controllable fake image service. Like the real route, a submission leaves a preparation-job row (so the batch can
 *  see an image that is still in progress); each one is a "job" the test resolves, and finished ones write image_url. */
function harness(options:any={}){
  const submissions:any[]=[],storyboards:any[]=[]
  let inFlight=0,maxInFlight=0
  const submitAssetImage=async(kind:string,assetId:number,body:any)=>{
    const entry={kind,assetId,body,actor:security.currentActor(),state:'pending',code:undefined as string|undefined,id:'img-'+(++imageSequence)}
    submissions.push(entry);inFlight++;maxInFlight=Math.max(maxInFlight,inFlight)
    const reply=options.reply?.(entry,submissions.length)
    if(reply?.error){inFlight--;return reply}
    const episode=db.$client.prepare('SELECT drama_id FROM episodes WHERE id=?').get(body.episode_id) as any
    db.$client.prepare("INSERT INTO platform_asset_image_jobs(id,asset_kind,asset_id,project_id,episode_id,user_id,status,activity_task_id,request_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'preparing_prompt','synthetic','{}',?,?)")
      .run(entry.id,kind,assetId,episode.drama_id,body.episode_id,owner.id,at,at)
    return {assetJobId:entry.id}
  }
  const readImageOutcome=(kind:string,assetId:number,submission:any)=>{
    const entry=submissions.find(item=>item.id===submission.assetJobId)
    if(!entry||entry.state==='pending')return {state:'pending'}
    return entry.state==='done'?{state:'done'}:{state:'failed',code:entry.code,message:'synthetic '+entry.code}
  }
  const resolveImage=(entry:any,state:'done'|'failed',code?:string)=>{
    if(entry.state!=='pending')return
    entry.state=state;entry.code=code;inFlight--
    db.$client.prepare('UPDATE platform_asset_image_jobs SET status=? WHERE id=?').run(state==='done'?'completed':'failed',entry.id)
    if(state==='done')db.$client.prepare(`UPDATE ${entry.kind==='character'?'characters':entry.kind==='scene'?'scenes':'props'} SET image_url=? WHERE id=?`).run('static/images/'+entry.id+'.png',entry.assetId)
  }
  const startStoryboard=async(input:any)=>{const id='job-'+(storyboards.length+1);storyboards.push({id,input,actor:security.currentActor(),activity:currentActivity(),status:'running',completed:0,total:5});return {job_id:id}}
  const readStoryboardJob=(id:string)=>{const job=storyboards.find(item=>item.id===id);return job?{id,status:job.status,completed:job.completed,total:job.total,draft_id:'draft-'+id,error:job.error}:null}
  const manager=new ProductionBatchManager(db.$client,{startExtraction:(episodeId:number,dramaId:number,target:any,opts:any)=>{
      // Extraction finishes at once with a valid save receipt (the extraction path itself is covered by production-batches.test.ts).
      queueMicrotask(()=>opts.onLifecycle({phase:'done',result:{toolResults:[{toolName:'save_dedup_'+target,toolCallId:target+episodeId,result:{created:0,...(target==='scenes'?{reused:0}:{merged:0})}}],toolCalls:[{toolName:'save_dedup_'+target,toolCallId:target+episodeId}]}}))
      return true
    },resolveChoice:choice,recipeVersion:()=>'r4',autoDispatch:false,submitAssetImage,readImageOutcome,startStoryboard,readStoryboardJob,
    resolveImageChoice:async(input:any)=>input.image_config_id?{configId:input.image_config_id,model:input.image_model||'img-x'}:null,
    pollMs:5,retryDelaysMs:[10,10],submitGapMs:0,imageWaitMs:5000,...options.deps})
  managers.push(manager)
  return {manager,submissions,storyboards,resolveImage,maxInFlight:()=>maxInFlight}
}
async function until(h:any,check:()=>boolean,label:string){
  for(let n=0;n<400;n++){await h.manager.pump();if(check())return;await pause(5)}
  assert.fail('did not reach: '+label)
}

test('one batch runs extraction, then images, then the storyboard of each episode, in that order', async()=>{
  const f=fixture(),h=harness()
  const batch=await h.manager.create({drama_id:f.drama.id,episode_ids:f.episodes.map(e=>e.id),targets:['characters','scenes','props','images','storyboard'],concurrency:2,image_config_id:6,image_model:'img-x',image_concurrency:2,storyboard_concurrency:1},owner)
  assert.deepEqual(batch.steps.map(s=>`${s.episode_number}:${s.target}`),['1:characters','1:scenes','1:props','1:images','1:storyboard','2:characters','2:scenes','2:props','2:images','2:storyboard'])
  await until(h,()=>h.submissions.length>0,'first image submitted')
  assert.equal(h.storyboards.length,0,'no storyboard before the images of that episode ended')
  // Finish images as they come; the storyboard of an episode starts only after its images.
  await until(h,()=>{for(const entry of h.submissions)h.resolveImage(entry,'done');return h.storyboards.length===1},'first storyboard')
  for(const job of h.storyboards)job.status='done',job.completed=5
  await until(h,()=>{for(const entry of h.submissions)h.resolveImage(entry,'done');for(const job of h.storyboards){job.status='done';job.completed=5}return h.manager.get(batch.id,owner).status==='completed'},'batch completed')
  const detail=h.manager.get(batch.id,owner)
  assert.equal(detail.counts.completed,10)
  // Shared 林轩 drawn once; narrator never; the scene that already had an image is not regenerated.
  const drawn=h.submissions.map(s=>`${s.kind}:${s.assetId}`).sort()
  assert.deepEqual(drawn,[`character:${f.shared.id}`,`character:${f.late.id}`,`prop:${f.prop.id}`,`scene:${f.fresh.id}`].sort())
  assert.ok(h.submissions.every(s=>s.body.config_id===6&&s.body.model==='img-x'&&s.body.episode_id&&s.actor.id===owner.id),'image submissions carry the batch image model and run as the batch owner')
  const images=detail.steps.filter(s=>s.target==='images').map(s=>s.result as any)
  // Episode 1: 林轩 + 宿舍 (has image) → 2 drawable, 1 skipped; the narrator is not counted. Episode 2: 林轩, 李玄风, 会所, 托盘.
  // 林轩 may be drawn by whichever episode reaches him first; the other one then finds the image (skipped) or follows the job.
  assert.equal(images[0].total,2);assert.equal(images[1].total,4)
  assert.equal(images[0].generated+images[1].generated,4,'four new images in total')
  assert.ok(images.every(r=>r.failed.length===0))
  assert.equal(h.storyboards.length,2)
  assert.ok(h.storyboards.every(job=>job.input.agentType==='storyboard_breaker'&&job.input.model==='text-x'&&job.input.configId===7&&job.actor.id===owner.id))
})

test('image concurrency is respected and temporary relay errors are retried; a content refusal is not', async()=>{
  const f=fixture(),h=harness()
  const batch=await h.manager.create({drama_id:f.drama.id,episode_ids:[f.episodes[1].id],targets:['images'],image_concurrency:2},owner)
  await until(h,()=>h.submissions.length===2,'two images in flight')
  await pause(30);await h.manager.pump()
  assert.equal(h.submissions.length,2,'never more than image_concurrency in flight')
  // First: a 429 burst limit (retried), second: a content refusal (not retried).
  h.resolveImage(h.submissions[0],'failed','generation_rate_limited');h.resolveImage(h.submissions[1],'failed','generation_rejected')
  await until(h,()=>h.submissions.length>=4,'retry and the next asset')
  for(let n=0;n<200;n++){for(const entry of h.submissions)if(entry.state==='pending')h.resolveImage(entry,'done');await h.manager.pump();if(h.manager.get(batch.id,owner).status!=='running')break;await pause(5)}
  const step=h.manager.get(batch.id,owner).steps[0],result=step.result as any
  assert.equal(h.maxInFlight(),2)
  assert.equal(step.status,'completed','some images done: the step completes with a note')
  assert.equal(step.error_code,'images_partial')
  assert.deepEqual(result.failed.map((x:any)=>x.error_code),['generation_rejected'])
  const retried=h.submissions.filter(s=>s.kind===h.submissions[0].kind&&s.assetId===h.submissions[0].assetId)
  assert.equal(retried.length,2,'the rate-limited asset was submitted again once')
  // 4 drawable assets: 1 refused for content (not retried), 3 generated (one of them on its retry).
  assert.equal(result.generated,3)
})

test('a failed image step does not block the storyboard; a failed extraction does', async()=>{
  const f=fixture(),h=harness({reply:()=>({error:'synthetic refusal',status:400})})
  const batch=await h.manager.create({drama_id:f.drama.id,episode_ids:[f.episodes[1].id],targets:['images','storyboard']},owner)
  await until(h,()=>h.storyboards.length===1,'storyboard after failed images')
  const steps=h.manager.get(batch.id,owner).steps
  assert.equal(steps[0].status,'failed');assert.equal(steps[0].error_code,'images_failed')
  h.storyboards[0].status='done';await until(h,()=>h.manager.get(batch.id,owner).steps[1].status==='completed','storyboard done')
  // A failed extraction blocks its images and storyboard.
  const g=fixture(),k=harness({deps:{startExtraction:(episodeId:number,dramaId:number,target:any,opts:any)=>{queueMicrotask(()=>opts.onLifecycle({phase:'error',error:'synthetic invalid',providerHttpStatus:400}));return true}}})
  const blocked=await k.manager.create({drama_id:g.drama.id,episode_ids:[g.episodes[0].id],targets:['characters','images','storyboard']},owner)
  await until(k,()=>k.manager.get(blocked.id,owner).status!=='running','settled')
  assert.deepEqual(k.manager.get(blocked.id,owner).steps.map(s=>s.status),['failed','blocked','blocked'])
  assert.equal(k.submissions.length+k.storyboards.length,0)
})

test('storyboard outcomes: needs_revision completes with a note, error fails, existing storyboards are not re-split', async()=>{
  const f=fixture(),h=harness()
  const batch=await h.manager.create({drama_id:f.drama.id,episode_ids:f.episodes.map(e=>e.id),targets:['storyboard'],storyboard_concurrency:2},owner)
  await until(h,()=>h.storyboards.length===2,'two storyboards at once (concurrency 2)')
  h.storyboards[0].status='needs_revision';h.storyboards[0].completed=4
  h.storyboards[1].status='error';h.storyboards[1].error='上游文本服务返回 HTTP 401'
  await until(h,()=>h.manager.get(batch.id,owner).status!=='running','settled')
  const steps=h.manager.get(batch.id,owner).steps
  assert.deepEqual(steps.map(s=>[s.status,s.error_code]),[['completed','storyboard_needs_revision'],['failed','storyboard_failed']])
  assert.match(steps[0].error!,/1组未通过/)
  // An episode that already has storyboards is not re-split.
  const g=fixture();db.insert(schema.storyboards).values({episodeId:g.episodes[0].id,storyboardNumber:1,createdAt:at,updatedAt:at} as any).run()
  const k=harness(),done=await k.manager.create({drama_id:g.drama.id,episode_ids:[g.episodes[0].id],targets:['storyboard']},owner)
  await until(k,()=>k.manager.get(done.id,owner).status!=='running','settled')
  assert.equal(k.storyboards.length,0);assert.equal(k.manager.get(done.id,owner).steps[0].error_code,'storyboard_exists')
})

test('storyboard concurrency 1 runs one episode at a time; images and storyboards do not use the extraction slots', async()=>{
  const f=fixture(),h=harness()
  const batch=await h.manager.create({drama_id:f.drama.id,episode_ids:f.episodes.map(e=>e.id),targets:['storyboard'],storyboard_concurrency:1},owner)
  await until(h,()=>h.storyboards.length===1,'first')
  await pause(20);await h.manager.pump();assert.equal(h.storyboards.length,1)
  h.storyboards[0].status='done';await until(h,()=>h.storyboards.length===2,'second after first')
  h.storyboards[1].status='done';await until(h,()=>h.manager.get(batch.id,owner).status==='completed','done')
})

test('the server builds the same storyboard message as the episode page button', ()=>{
  const f=fixture()
  const message=storyboardBreakdownMessage(f.episodes[1].id)
  assert.match(message,/^请基于当前集剧本拆分分镜，并为每个分镜段落同时生成 video_prompt（视频生成提示词）。\n本次视频模型：seedance-x，/)
  assert.ok(message.includes(`当前集已有角色：林轩(ID:${f.shared.id})、李玄风(ID:${f.late.id})`))
  assert.ok(message.includes(`当前集已有场景：会所 · 夜(ID:${f.fresh.id})`))
  assert.ok(message.includes(`当前集已有道具：托盘(ID:${f.prop.id})`))
  assert.ok(message.endsWith('- 只有纯环境空镜头才可以不绑定角色'))
})

test('restart marks running image/storyboard steps for review; they can be retried without double spending', async()=>{
  const f=fixture(),h=harness()
  const batch=await h.manager.create({drama_id:f.drama.id,episode_ids:[f.episodes[1].id],targets:['images']},owner)
  await until(h,()=>h.submissions.length>0,'submitted')
  h.manager.close()
  const restarted=new ProductionBatchManager(db.$client,{autoDispatch:false});managers.push(restarted)
  restarted.recoverInterrupted()
  const step=restarted.get(batch.id,owner).steps[0]
  assert.equal(step.status,'needs_review');assert.match(step.error!,/已提交的图片会继续完成/)
  const k=harness();await k.manager.resume(batch.id,owner)
  await k.manager.retry(batch.id,[step.id],owner)
  // Assets whose first job is still running are followed, not submitted again.
  const first=new Set(h.submissions.map(s=>`${s.kind}:${s.assetId}`))
  await until(k,()=>k.submissions.length>0||k.manager.get(batch.id,owner).steps[0].status!=='running','retry ran')
  assert.ok(k.submissions.every(s=>!first.has(`${s.kind}:${s.assetId}`)),'no second submission for an asset whose job is still running')
})

test('validation: unknown target and out-of-range concurrency are refused', async()=>{
  const f=fixture(),h=harness()
  await assert.rejects(h.manager.create({drama_id:f.drama.id,episode_ids:[f.episodes[0].id],targets:['video' as any]},owner),/target 必须是/)
  await assert.rejects(h.manager.create({drama_id:f.drama.id,episode_ids:[f.episodes[0].id],targets:['images'],image_concurrency:9},owner),/同时出图数/)
  await assert.rejects(h.manager.create({drama_id:f.drama.id,episode_ids:[f.episodes[0].id],targets:['storyboard'],storyboard_concurrency:4},owner),/同时拆分镜/)
})
