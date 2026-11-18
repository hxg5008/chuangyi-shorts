import { test, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { RequestContext } from '@mastra/core/request-context'

const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'huobao-production-batches-'))
process.env.HUOBAO_DATA_DIR=temporary;process.env.SQLITE_PATH=path.join(temporary,'batches.sqlite3');process.env.STORAGE_PATH=path.join(temporary,'static');process.env.MYSQL_AUTO_IMPORT='false';process.env.HUOBAO_PROXY_URL='direct'
const {db,schema}=await import('../src/db/index.ts')
const security=await import('../src/services/platform-security/index.ts')
security.initPlatformSecurity()
const owner=security.createUser('batch-owner','synthetic-password').user,other=security.createUser('batch-other','synthetic-password').user
const {ProductionBatchManager,extractionSaveReceipt}=await import('../src/services/production-batches.ts')
const {createProductionBatchRoutes}=await import('../src/routes/production-batches.ts')
const {currentActivity}=await import('../src/services/activity/context.ts')
const {extractTools}=await import('../src/agents/tools/extract-tools.ts')
const guarded=security.secureAgentTools(extractTools),managers:InstanceType<typeof ProductionBatchManager>[]=[]
const at=new Date().toISOString(),pause=(ms=0)=>new Promise<void>(resolve=>setTimeout(resolve,ms))
function fixture(numbers=[1,2],actor=owner){
  const drama=db.insert(schema.dramas).values({title:'Synthetic production fixture',ownerUserId:actor.id,createdAt:at,updatedAt:at}).returning().get()
  const episodes=numbers.map(episodeNumber=>db.insert(schema.episodes).values({dramaId:drama.id,episodeNumber,title:'Episode '+episodeNumber,content:'原有完整剧本 '+episodeNumber,createdAt:at,updatedAt:at}).returning().get())
  return {drama,episodes}
}
const count=(table:string)=>Number((db.$client.prepare(`SELECT count(*) n FROM ${table}`).get() as any).n)
const toolName=(target:string)=>'save_dedup_'+target
function output(target:string,created=0){return {toolName:toolName(target),toolCallId:target+'-synthetic-call',result:{created,...(target==='scenes'?{reused:0}:{merged:0})}}}
function result(target:string,created=0){const entry=output(target,created);return{text:'synthetic completed output',toolCalls:[{toolName:entry.toolName,toolCallId:entry.toolCallId}],toolResults:[entry],steps:[{toolResults:[entry]}]}}
const choice=async(input:any)=>({configId:input.config_id||7,model:input.model||'synthetic-text',parameters:input.model_parameters||{},version:JSON.stringify({config:input.config_id||7,model:input.model||'synthetic-text',parameters:input.model_parameters||{}})})
function controlled(options:any={}){
  const calls:any[]=[];let max=0
  const starter=(episodeId:number,dramaId:number,target:any,opts:any)=>{
    const activity=currentActivity(),actor=security.currentActor(),call={episodeId,dramaId,target,opts,activity,actor,settled:false}
    calls.push(call);max=Math.max(max,calls.filter(call=>!call.settled).length)
    opts.onLifecycle({phase:'started',startedAt:at,activityTaskId:activity?.taskId})
    return true
  }
  const manager=new ProductionBatchManager(db.$client,{startExtraction:starter,resolveChoice:choice,recipeVersion:()=>options.recipe?.value||'original-rules-v1',autoDispatch:false,...options})
  managers.push(manager)
  const complete=(call:any,value=result(call.target))=>{assert.equal(call.settled,false);call.settled=true;call.opts.onLifecycle({phase:'done',startedAt:at,finishedAt:at,activityTaskId:call.activity?.taskId,result:value})}
  const fail=(call:any,error:string,providerHttpStatus?:number)=>{call.settled=true;call.opts.onLifecycle({phase:'error',startedAt:at,finishedAt:at,error,providerHttpStatus})}
  return{manager,calls,complete,fail,max:()=>max}
}
async function create(h:ReturnType<typeof controlled>,f:ReturnType<typeof fixture>,extra:any={}){return h.manager.create({drama_id:f.drama.id,episode_ids:f.episodes.map(ep=>ep.id),concurrency:4,...extra},owner)}
async function drain(h:ReturnType<typeof controlled>,id:string){
  for(let n=0;n<100;n++){await h.manager.pump();for(const call of h.calls.filter(call=>!call.settled))h.complete(call);const detail=h.manager.get(id,owner);if(!detail.counts.running&&!detail.counts.queued)return detail;await pause()}
  assert.fail('synthetic batch did not settle')
}
afterEach(()=>{for(const manager of managers.splice(0))manager.close();if(db.$client.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='platform_production_batches'").get())db.$client.exec('DELETE FROM platform_production_receipts; DELETE FROM platform_production_steps; DELETE FROM platform_production_batches;')})
after(async()=>{db.$client.close();await fs.rm(temporary,{recursive:true,force:true})})

test('receipts require the actual target save output, support SDK payload/call aliases and count successful zero-item saves',()=>{
  const zero=extractionSaveReceipt('props',[],result('props'));assert.equal(zero.ok,true);assert.equal(zero.created,0);assert.equal(zero.saved_calls,1)
  assert.equal(extractionSaveReceipt('characters',[],result('props')).ok,false)
  assert.equal(extractionSaveReceipt('props',[],{text:'保存完成，共0道具'}).ok,false)
  assert.equal(extractionSaveReceipt('props',[],{toolResults:[{toolName:'save_dedup_props',result:{error:'synthetic save rejected'}}]}).failed,true)
  const partial={toolResults:[output('characters',1),{toolName:'save_voice_cards',result:{error:'synthetic voice card save failed'}}]}
  assert.equal(extractionSaveReceipt('characters',[],partial).ok,false);assert.equal(extractionSaveReceipt('characters',[],partial).failed,true)
  assert.equal(extractionSaveReceipt('characters',[],{toolResults:[output('characters',1),{toolName:'read_existing_characters',isError:true,result:'plain tool failure'}]}).failed,true)
  const payload={toolCalls:[{toolCallId:'sdk-id',toolName:'saveDedupCharacters'}],toolResults:[{payload:{toolCallId:'sdk-id',result:JSON.stringify({created:1,merged:2})}}]}
  assert.deepEqual(extractionSaveReceipt('characters',[payload],{steps:[payload]}),{ok:true,failed:false,saved_calls:1,created:1,merged:2,reused:0})
})

test('each episode keeps original target order and all batches share four text slots, including smaller per-batch limits',async()=>{
  const h=controlled(),first=fixture([1,2,3,4]),second=fixture([1,2,3,4]),a=await create(h,first,{concurrency:1}),b=await create(h,second,{concurrency:4})
  await h.manager.pump();assert.equal(h.calls.length,4);assert.equal(h.calls.filter(call=>call.dramaId===first.drama.id).length,1);assert.equal(h.max(),4)
  for(let i=0;i<60;i++){for(const call of h.calls.filter(call=>!call.settled))h.complete(call);await h.manager.pump();if(h.manager.get(a.id,owner).status==='completed'&&h.manager.get(b.id,owner).status==='completed')break}
  assert.equal(h.manager.get(a.id,owner).counts.completed,12);assert.equal(h.manager.get(b.id,owner).counts.completed,12);assert.equal(h.max(),4)
  for(const ep of [...first.episodes,...second.episodes])assert.deepEqual(h.calls.filter(call=>call.episodeId===ep.id).map(call=>call.target),['characters','scenes','props'])
  assert(h.calls.every(call=>call.actor.id===owner.id&&call.activity.taskId&&call.opts.configId===7))
})

test('pause stops only new dispatch, running steps finish, and concurrent async preflight cannot dispatch after pause',async()=>{
  const h=controlled(),f=fixture([1,2,3]),batch=await create(h,f,{concurrency:2})
  h.manager.pause(batch.id,owner);await h.manager.pump();assert.equal(h.calls.length,0)
  h.manager.resume(batch.id,owner);await h.manager.pump();assert.equal(h.calls.length,2)
  h.manager.pause(batch.id,owner);for(const call of h.calls)h.complete(call);await h.manager.pump();assert.equal(h.calls.length,2);assert.equal(h.manager.get(batch.id,owner).status,'paused')
  h.manager.resume(batch.id,owner);assert.equal((await drain(h,batch.id)).status,'completed')
  let release!:()=>void,block=false
  const gated=controlled({resolveChoice:async(input:any)=>{if(block)await new Promise<void>(resolve=>{release=resolve});return choice(input)}}),g=fixture([1]),pending=await create(gated,g)
  block=true;const pumping=gated.manager.pump();await pause();gated.manager.pause(pending.id,owner);release();await pumping;assert.equal(gated.calls.length,0)
})

test('one definite episode failure blocks only that episode; explicit retry resumes its dependent targets',async()=>{
  const h=controlled(),f=fixture(),batch=await create(h,f)
  await h.manager.pump();h.fail(h.calls.find(call=>call.episodeId===f.episodes[0].id),'synthetic invalid input',400)
  h.complete(h.calls.find(call=>!call.settled));let finished=await drain(h,batch.id)
  assert.equal(finished.counts.failed,1);assert.equal(finished.counts.blocked,2);assert.equal(finished.counts.completed,3)
  assert.deepEqual(h.calls.filter(call=>call.episodeId===f.episodes[0].id).map(call=>call.target),['characters'])
  const failed=finished.steps.find(step=>step.status==='failed')!
  const diagnostic=db.$client.prepare('SELECT result_json FROM platform_activity_tasks WHERE id=?').get(failed.activity_task_id!) as any;assert.equal(JSON.parse(diagnostic.result_json).provider_http_status,400)
  await h.manager.retry(batch.id,[failed.id],owner);finished=await drain(h,batch.id)
  assert.equal(finished.status,'completed');assert.equal(finished.counts.completed,6);assert.equal(finished.steps[0].attempt,2)
  await assert.rejects(h.manager.retry(batch.id,[failed.id],owner),/只能重试/)
})

test('successful character save plus another business-tool error keeps the step failed and writes no completion receipt',async()=>{
  const h=controlled(),f=fixture([1]),batch=await create(h,f,{targets:['characters']});await h.manager.pump()
  h.complete(h.calls[0],{text:'some output was saved',toolResults:[output('characters',1),{toolName:'save_voice_cards',result:{error:'synthetic voice card failure'}}]} as any)
  const view=h.manager.get(batch.id,owner);assert.equal(view.steps[0].status,'failed');assert.equal(view.steps[0].error,'synthetic voice card failure');assert.equal(count('platform_production_receipts'),0)
  const activity=db.$client.prepare('SELECT status FROM platform_activity_tasks WHERE id=?').get(view.steps[0].activity_task_id!) as any;assert.equal(activity.status,'failed')
})

test('concurrent identical active creations reuse the durable batch ID and changed effective inputs remain separate',async()=>{
  const h=controlled(),f=fixture([1]),[a,b]=await Promise.all([create(h,f,{skip_completed:false}),create(h,f,{skip_completed:false})])
  assert.equal(a.id,b.id);assert.equal(b.reused_batch,true);assert.equal(count('platform_production_batches'),1)
  h.manager.pause(a.id,owner);const paused=await create(h,f,{skip_completed:false});assert.equal(paused.id,a.id);assert.equal(paused.status,'paused')
  const changed=await create(h,f,{skip_completed:false,model_parameters:{temperature:0.7}});assert.notEqual(changed.id,a.id)
})

test('connection credentials and defaults are observed only through the internal input hash and invalidate unsubmitted work',async()=>{
  const {getModelChannelStore}=await import('../src/services/model-channels/store.ts'),store=getModelChannelStore()
  const channel=store.saveChannel({name:'Synthetic connection fingerprint',base_url:'http://127.0.0.1:9',api_key:'synthetic-secret-original',headers:{'X-Synthetic':'old'},enabled:true})
  const binding=store.saveBinding(channel.id,{name:'Synthetic fingerprint model',type:'text',protocol_id:'text.openai-chat',model:'synthetic-fingerprint-model',enabled:true,access:'all',defaults:{temperature:0.2}})
  const h=controlled({resolveChoice:undefined}),f=fixture([1]),batch=await create(h,f,{targets:['props'],config_id:binding.config_id,model:binding.model})
  const before=batch.steps[0].input_version
  store.saveChannel({api_key:'synthetic-secret-rotated'},channel.id)
  await h.manager.pump();assert.equal(h.calls.length,0);assert.equal(h.manager.get(batch.id,owner).steps[0].status,'input_stale')
  const again=await create(h,f,{targets:['props'],config_id:binding.config_id,model:binding.model});assert.notEqual(again.steps[0].input_version,before)
  assert.doesNotMatch(JSON.stringify(again),/synthetic-secret|X-Synthetic|127\.0\.0\.1:9/)
})

test('disconnects and done-without-save need review and cannot be retried or replayed by resume or another batch',async()=>{
  const h=controlled(),f=fixture([1]),batch=await create(h,f)
  await h.manager.pump();h.fail(h.calls[0],'Reconnecting... 2/5: body contains a counter 400, not an HTTP status');let view=h.manager.get(batch.id,owner)
  assert.equal(view.status,'needs_review');assert.equal(view.counts.needs_review,1);assert.equal(view.counts.blocked,2)
  h.manager.resume(batch.id,owner);await h.manager.pump();assert.equal(h.calls.length,1)
  await assert.rejects(h.manager.retry(batch.id,[view.steps[0].id],owner),/待核对/)
  const duplicate=await create(h,f,{skip_completed:false});await h.manager.pump();assert.equal(h.calls.length,1);assert.equal(h.manager.get(duplicate.id,owner).counts.needs_review,1)
  const otherFixture=fixture([1]),missing=await create(h,otherFixture,{targets:['props']});await h.manager.pump();h.complete(h.calls.at(-1),{text:'已完成，0道具'})
  assert.equal(h.manager.get(missing.id,owner).steps[0].error_code,'missing_save_receipt')
})

test('durable startup marks running steps for review and pauses queued dispatch without replay, including late old callbacks',async()=>{
  const h=controlled(),f=fixture(),batch=await create(h,f,{concurrency:1});await h.manager.pump();assert.equal(h.calls.length,1);h.manager.close()
  const restarted=controlled();assert.deepEqual(restarted.manager.recoverInterrupted(),{interrupted:1});await restarted.manager.pump();assert.equal(restarted.calls.length,0)
  let view=restarted.manager.get(batch.id,owner);assert.equal(view.status,'paused');assert.equal(view.steps[0].status,'needs_review')
  h.complete(h.calls[0]);assert.equal(restarted.manager.get(batch.id,owner).steps[0].status,'needs_review')
  restarted.manager.resume(batch.id,owner);view=await drain(restarted,batch.id)
  assert.equal(view.counts.needs_review,1);assert.equal(view.counts.completed,3);assert(restarted.calls.every(call=>call.episodeId===f.episodes[1].id))
})

test('matching saved receipts are reusable, including zero props; existing asset counts alone never imply completion',async()=>{
  const h=controlled(),f=fixture([1]),first=await create(h,f);const completed=await drain(h,first.id);assert.equal(completed.counts.completed,3)
  const before=h.calls.length,second=await create(h,f);assert.equal(second.status,'completed');assert.equal(second.counts.reused,3);await h.manager.pump();assert.equal(h.calls.length,before)
  assert.equal(second.steps[2].receipt?.saved_calls,1);assert.equal(second.steps[2].receipt?.created,0)
  const fresh=fixture([1]);db.insert(schema.characters).values({dramaId:fresh.drama.id,name:'already present',appearance:'existing does not prove this episode was processed',createdAt:at,updatedAt:at}).run()
  const unfinished=await create(h,fresh);assert.equal(unfinished.counts.completed,0);assert.equal(unfinished.counts.queued,3)
})

test('source/rule versions invalidate completion and changed queued inputs require explicit retry without automatic model spending',async()=>{
  const recipe={value:'rules-A'},h=controlled({recipe}),f=fixture([1]),batch=await create(h,f)
  recipe.value='rules-B';await h.manager.pump();let view=h.manager.get(batch.id,owner);assert.equal(view.steps[0].status,'input_stale');assert.equal(h.calls.length,0)
  await h.manager.retry(batch.id,[view.steps[0].id],owner);view=await drain(h,batch.id)
  // Each already-queued target carries its own original version and needs its own explicit confirmation.
  assert.equal(view.counts.completed,1);assert.equal(view.counts.input_stale,1)
  const changed=view.steps.find(step=>step.status==='input_stale')!;await h.manager.retry(batch.id,[changed.id],owner);view=await drain(h,batch.id)
  const last=view.steps.find(step=>step.status==='input_stale');if(last){await h.manager.retry(batch.id,[last.id],owner);view=await drain(h,batch.id)}
  assert.equal(view.status,'completed')
  db.update(schema.episodes).set({content:'用户更改后的剧本'}).where((await import('drizzle-orm')).eq(schema.episodes.id,f.episodes[0].id)).run()
  const next=await create(h,f);assert.equal(next.counts.reused,0);assert.equal(next.counts.queued,3)
})

test('editing input during an active call preserves saved results but does not issue a stale completion receipt',async()=>{
  const h=controlled(),f=fixture([1]),batch=await create(h,f,{targets:['props']});await h.manager.pump()
  db.$client.prepare('UPDATE episodes SET script_content=? WHERE id=?').run('新剧本正文',f.episodes[0].id)
  h.complete(h.calls[0]);const view=h.manager.get(batch.id,owner);assert.equal(view.steps[0].status,'input_stale');assert.equal(count('platform_production_receipts'),0)
  const log=db.$client.prepare('SELECT status,stage FROM platform_activity_tasks WHERE id=?').get(view.steps[0].activity_task_id!) as any
  assert.equal(log.stage,'input_stale')
})

test('manual same-type extraction waits without a fake running step/activity or a retry storm',async()=>{
  let busy=true;const h=controlled({isExtractionRunning:()=>busy}),f=fixture([1]),batch=await create(h,f,{targets:['props']});const before=count('platform_activity_tasks')
  await h.manager.pump();await h.manager.pump();assert.equal(h.calls.length,0);assert.equal(h.manager.get(batch.id,owner).steps[0].attempt,0);assert.equal(count('platform_activity_tasks'),before)
  busy=false;await pause(1550);await h.manager.pump();assert.equal(h.calls.length,1);h.complete(h.calls[0]);assert.equal(h.manager.get(batch.id,owner).status,'completed')
})

test('batch HTTP endpoints return persistent 202 IDs, enforce owner/project ACL and never expose prompts or credentials',async()=>{
  const h=controlled(),f=fixture(),app=createProductionBatchRoutes(h.manager)
  const response=await security.runAsActor(owner,()=>app.request('/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({drama_id:f.drama.id,episode_ids:f.episodes.map(ep=>ep.id),targets:['props'],concurrency:2})}))
  assert.equal(response.status,202);const body=await response.json() as any,id=body.data.id;assert.equal(body.data.steps.length,2);assert.equal(h.calls.length,0)
  const reread=await security.runAsActor(owner,()=>app.request('/'+id));assert.equal((await reread.json() as any).data.id,id)
  const unauthorized=await security.runAsActor(other,()=>app.request('/'+id));assert.equal(unauthorized.status,404)
  const list=await security.runAsActor(other,()=>app.request('/'));assert.deepEqual((await list.json() as any).data.batches,[])
  const absent=await app.request('/');assert.equal(absent.status,401)
  const bad=await security.runAsActor(owner,()=>app.request('/'+id+'/retry',{method:'POST',headers:{'content-type':'application/json'},body:'{"step_ids":{}}'}));assert.equal(bad.status,400)
  const malformed=await security.runAsActor(owner,()=>app.request('/'+id+'/retry',{method:'POST',headers:{'content-type':'application/json'},body:'{invalid json'}));assert.equal(malformed.status,400);assert.equal(h.calls.length,0)
  await assert.rejects(create(h,{...f,drama:{...f.drama,id:fixture([1],other).drama.id}}),/权限|项目/)
  const text=JSON.stringify(body);assert.doesNotMatch(text,/原有完整剧本|synthetic-password|api_key|settings_json|attempt_key/)
  const dashboard=h.manager.dashboard([f.drama.id],owner);assert.equal(dashboard.length,2);assert(dashboard.every(row=>row.activity_task_id===null));assert.doesNotMatch(JSON.stringify(dashboard),/input_version|receipt_json|model_parameters/)
})

test('actual secured original save tools retain schemas, deduplicate across episodes and persist successful empty props receipts',async()=>{
  const f=fixture([1,2,3]),schemas=Object.entries(extractTools).map(([name,tool])=>[name,tool.inputSchema]),reads:string[]=[],calls:any[]=[]
  const manager=new ProductionBatchManager(db.$client,{autoDispatch:false,resolveChoice:choice,recipeVersion:()=> 'unchanged-original-tools',startExtraction:(episodeId,dramaId,target,opts)=>{
    const rc=new RequestContext();rc.set('episodeId',episodeId);rc.set('dramaId',dramaId);rc.set('actorId',owner.id)
    calls.push({episodeId,target,activity:currentActivity()?.taskId,actor:security.currentActor()?.id,parameters:currentActivity()?.textModelParameters})
    void (async()=>{const script:any=await guarded.readScriptForExtraction.execute!({}, {requestContext:rc});reads.push(script.script)
      const tool=target==='characters'?guarded.saveDedupCharacters:target==='scenes'?guarded.saveDedupScenes:guarded.saveDedupProps
      const input=target==='characters'?{characters:[{name:'同一个角色',appearance:'原提取内容',styling:'原妆造内容'}]}:target==='scenes'?{scenes:[{location:'同一个场景',time:'夜',prompt:'原场景内容',lighting:'原光影内容'}]}:{props:[]}
      const saved=await tool.execute!(input as any,{requestContext:rc}),entry={toolName:tool.id,toolCallId:episodeId+'-'+target,result:saved},step={toolCalls:[{toolName:tool.id,toolCallId:entry.toolCallId}],toolResults:[entry]}
      opts.onLifecycle?.({phase:'step',startedAt:at,step});opts.onLifecycle?.({phase:'done',startedAt:at,finishedAt:at,result:{text:'保存完成',...step,steps:[step]}})
    })().catch(error=>opts.onLifecycle?.({phase:'error',startedAt:at,error:error.message}));return true
  }})
  managers.push(manager)
  const batch=await manager.create({drama_id:f.drama.id,episode_ids:f.episodes.map(ep=>ep.id),concurrency:4,model_parameters:{temperature:0.4}},owner)
  let done:any
  for(let n=0;n<200;n++){await manager.pump();done=manager.get(batch.id,owner);if(done.status==='completed')break;await pause(5)}
  assert.equal(done.status,'completed');assert.equal(done.counts.completed,9);assert.equal(calls.length,9)
  assert(calls.every(call=>call.actor===owner.id&&call.activity&&call.parameters.temperature===0.4));assert(reads.every(read=>read.startsWith('原有完整剧本')))
  assert.equal((db.$client.prepare('SELECT count(*) n FROM characters WHERE drama_id=?').get(f.drama.id) as any).n,1)
  assert.equal((db.$client.prepare('SELECT count(*) n FROM scenes WHERE drama_id=?').get(f.drama.id) as any).n,1)
  for(const episode of f.episodes){assert.equal((db.$client.prepare('SELECT count(*) n FROM episode_characters WHERE episode_id=?').get(episode.id) as any).n,1);assert.equal((db.$client.prepare('SELECT count(*) n FROM episode_scenes WHERE episode_id=?').get(episode.id) as any).n,1)}
  assert(done.steps.filter((step:any)=>step.target==='props').every((step:any)=>step.receipt.ok&&step.receipt.created===0&&step.receipt.saved_calls===1))
  for(const [name,original] of schemas)assert.equal((guarded as any)[name as string].inputSchema,original)
  assert.equal(count('sys_task'),0)
  const again=await manager.create({drama_id:f.drama.id,episode_ids:f.episodes.map(ep=>ep.id),concurrency:4,model_parameters:{temperature:0.4}},owner)
  // Shared rows may have been legitimately merged by later episodes; their output fingerprint is conservative.
  assert.equal(again.steps.filter(step=>step.target==='props').every(step=>step.reused),true)
})

test('default batch execution calls the original extraction lifecycle with unchanged messages/settings and the same durable activity ID',async()=>{
  const {mastra}=await import('../src/mastra/index.ts'),{startExtraction,getExtractionStatus}=await import('../src/services/extraction.ts'),{withActivityContext}=await import('../src/services/activity/context.ts')
  const original=mastra.getAgent,captured:any[]=[],f=fixture([1,2])
  ;(mastra as any).getAgent=(id:string)=>{assert.equal(id,'extractor');return{id,stream:async(messages:any[],options:any)=>{
    const rc=options.requestContext;captured.push({messages:structuredClone(messages),maxSteps:options.maxSteps,model:rc.get('modelOverride'),config:rc.get('textConfigId'),parameters:rc.get('modelParameters'),activity:currentActivity()?.taskId})
    return{getFullOutput:async()=>{
      const saved=await guarded.saveDedupProps.execute!({props:[]},{requestContext:rc}),entry={toolName:'save_dedup_props',toolCallId:rc.get('episodeId')+'-props',result:saved},step={toolResults:[entry]}
      options.onStepFinish(step);return{text:'zero props saved',toolResults:[entry],steps:[step]}
    }}
  }}}
  try{
    assert.equal(security.runAsActor(owner,()=>withActivityContext({textModelParameters:{temperature:0.4}},()=>startExtraction(f.episodes[0].id,f.drama.id,'props',{model:'synthetic-text',configId:7}))),true)
    for(let n=0;n<100&&getExtractionStatus(f.episodes[0].id).props?.status==='running';n++)await pause(5)
    const manager=new ProductionBatchManager(db.$client,{autoDispatch:false,resolveChoice:choice,recipeVersion:()=> 'original-observed-lifecycle'});managers.push(manager)
    const batch=await manager.create({drama_id:f.drama.id,episode_ids:[f.episodes[1].id],targets:['props'],model_parameters:{temperature:0.4}},owner)
    for(let n=0;n<100;n++){await manager.pump();if(manager.get(batch.id,owner).status==='completed')break;await pause(5)}
    const done=manager.get(batch.id,owner);assert.equal(done.status,'completed');assert.equal(captured.length,2)
    const {activity:manualActivity,...manual}=captured[0],{activity:batchActivity,...observed}=captured[1]
    assert.deepEqual(observed,manual);assert.equal(batchActivity,done.steps[0].activity_task_id)
    const record=db.$client.prepare('SELECT status FROM platform_activity_tasks WHERE id=?').get(batchActivity) as any;assert.equal(record.status,'completed')
  }finally{(mastra as any).getAgent=original}
})
