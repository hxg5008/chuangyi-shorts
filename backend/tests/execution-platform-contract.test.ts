/** Cross-program contract, with the real Firebo helper + real 1.2 HTTP/stdio
 * boundary. The Python transport is an offline fixture, accounts and databases
 * live under a temporary directory, and dispatch stays paused. No model calls.
 * Set EXECUTION_PLATFORM_TEST_ROOT when the platform source is not a sibling. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
const here=path.dirname(fileURLToPath(import.meta.url))
const platformRoot=process.env.EXECUTION_PLATFORM_TEST_ROOT||path.resolve(here,'../../../chuangyi-execution-platform-1.2-work')

test('actual Firebo and 1.2 platform agree on project canvas, scoped submission, recovery and credential checks',
  {skip:!existsSync(path.join(platformRoot,'src/server.mjs'))},async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'cy-actual-execution-contract-'))
  const data=path.join(folder,'firebo'),platformData=path.join(folder,'platform')
  process.env.HUOBAO_DATA_DIR=data;process.env.SQLITE_PATH=path.join(data,'db.sqlite3')
  process.env.STORAGE_PATH=path.join(data,'static');process.env.WORKSPACE_PATH=path.join(data,'workspace')
  process.env.MYSQL_AUTO_IMPORT='false';process.env.HUOBAO_PROXY_URL='direct';process.env.HUOBAO_JIMENG_AUTO_RETURN_MINUTES='0'
  const {db,schema}=await import('../src/db/index.ts')
  const security=await import('../src/services/platform-security/index.ts')
  const routing=await import('../src/services/execution-projects.ts')
  const {getModelChannelStore}=await import('../src/services/model-channels/store.ts')
  const {getConfigById}=await import('../src/services/ai.ts')
  const {generateVideo}=await import('../src/services/generation.ts')
  const {setJimengTimings}=await import('../src/services/jimeng-local-task.ts')
  const {eq}=await import('drizzle-orm')
  const {createExecutionServer}=await import(pathToFileURL(path.join(platformRoot,'src/server.mjs')).href)
  const {createJimengEngine}=await import(pathToFileURL(path.join(platformRoot,'src/jimeng-engine.mjs')).href)
  const {JobLedger}=await import(pathToFileURL(path.join(platformRoot,'src/job-ledger.mjs')).href)
  const python=existsSync(path.join(platformRoot,'runtime/python/python.exe'))?path.join(platformRoot,'runtime/python/python.exe'):path.resolve(platformRoot,'../jimeng-local-service/runtime/python/python.exe')
  const transportPath=path.join(folder,'offline-transport.py')
  // Real canvases have unique IDs. Delay only the offline create operation to
  // exercise two independent projects reaching one native account together.
  await fs.writeFile(transportPath,[
    'import importlib.util,json,time',
    'from pathlib import Path',
    `spec=importlib.util.spec_from_file_location("base_fixture",${JSON.stringify(path.join(platformRoot,'tests/fixtures/jimeng_fake_transport.py').replaceAll('\\','/'))})`,
    'base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)',
    'class Transport(base.FakeTransport):',
    ' def create_canvas(self,account,name):',
    '  self.event("create_canvas",{"name":name});time.sleep(.10)',
    '  with self.lock:',
    '   counter=self.root/"synthetic-canvas-counter.txt"',
    '   value=int(counter.read_text())+1 if counter.exists() else 1',
    '   counter.write_text(str(value));return str(654320+value)',
    'def create_transport(root):',
    ' base.create_transport(root)',
    ' return Transport(root)',
  ].join('\n'),'utf8')
  const engine=await createJimengEngine({root:platformRoot,dataRoot:path.join(platformData,'jimeng'),pythonExecutable:python,
    testMode:true,testTransport:transportPath})
  const master='synthetic-cross-program-master-key',ledger=new JobLedger(platformData,{secrets:[master]})
  const network={root:platformRoot,dataRoot:platformData,jimengDataRoot:path.join(platformData,'jimeng'),gptDataRoot:path.join(platformData,'gpt'),
    port:0,listenHost:'127.0.0.1',allowedHosts:['127.0.0.1'],publicOrigin:'http://127.0.0.1:0'}
  const app=createExecutionServer({config:network,gptEngine:{async invoke(){return{tasks:[]}},async prepareClose(){},async close(){}},jimengEngine:engine,ledger,apiKey:master,syncMilliseconds:0})
  let projectKeyIssues=0
  app.server.on('request',(request:any)=>{if(request.method==='POST'&&/^\/hub\/jimeng\/routes\/rt_[a-f0-9]{32}\/key$/u.test(request.url||''))projectKeyIssues++})
  const address=await app.listen();network.publicOrigin='http://127.0.0.1:'+address.port
  t.after(async()=>{
    const jobs=await engine.invoke('videos.list',{limit:500,offset:0})
    for(const job of jobs.data||[])if(job.status==='queued')await engine.invoke('videos.cancel',{id:job.id})
    await new Promise(resolve=>setTimeout(resolve,120));await app.close();db.$client.close()
    const absolute=await fs.realpath(folder),temp=await fs.realpath(os.tmpdir()),relative=path.relative(temp,absolute)
    assert.ok(relative.startsWith('cy-actual-execution-contract-')&&!relative.startsWith('..'))
    await fs.rm(absolute,{recursive:true,force:true})
  })
  const api=async(url:string,{key=master,method='GET',body}:{key?:string;method?:string;body?:unknown}={})=>{
    const response=await fetch(network.publicOrigin+url,{method,headers:{Authorization:'Bearer '+key,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})})
    const text=await response.text();let value:any;try{value=JSON.parse(text)}catch{value=text}
    return{status:response.status,value}
  }
  const imported=await api('/hub/jimeng/accounts/import',{method:'POST',body:{name:'Synthetic',cookies:{sessionid:'synthetic-only',sid_tt:'synthetic-only'}}})
  const account=imported.value.id
  assert.equal((await api('/hub/jimeng/accounts/'+account+'/check',{method:'POST',body:{}})).status,200)
  await engine.invoke('canvases.select',{id:account,canvas_id:'123456'})
  await engine.invoke('settings.set',{body:{paused:true,min_free_disk_mb:0}})
  security.initPlatformSecurity()
  const admin=security.listUsers().find(user=>user.role==='admin')!,owner=security.createUser('contract-owner','synthetic-password').user,other=security.createUser('contract-other','synthetic-password').user
  const at=new Date().toISOString()
  const project=db.insert(schema.dramas).values({title:'这是一个超过二十字节的中文项目名称🌙实际接口验收',ownerUserId:owner.id,createdAt:at,updatedAt:at}).returning().get()
  const foreign=db.insert(schema.dramas).values({title:'Foreign',ownerUserId:other.id,createdAt:at,updatedAt:at}).returning().get()
  const store=getModelChannelStore(),channel=store.saveChannel({name:'Actual execution contract',base_url:network.publicOrigin,api_key:master})
  const binding=store.saveBinding(channel.id,{name:'Jimeng actual',model:'jimeng-2.0-fast',type:'video',protocol_id:'video.jimeng-local',enabled:true})
  const config=(await security.runAsActor(owner,()=>getConfigById(binding.config_id)))!
  await security.runAsActor(admin,()=>routing.saveExecutionService(config.id!,{account_id:account,enabled:true}))
  const resolved=await security.runAsActor(owner,()=>Promise.all(Array.from({length:6},()=>routing.resolveJimengProjectConfig(config,project.id))))
  const scoped=resolved[0] as any
  assert.ok(scoped.executionRouteId);assert.notEqual(scoped.apiKey,master)
  assert.ok(resolved.every(value=>(value as any).executionRouteId===scoped.executionRouteId&&value.apiKey===scoped.apiKey))
  const accountAfter=(await api('/hub/jimeng/accounts')).value.accounts.find((value:any)=>value.id===account)
  assert.equal(accountAfter.canvas_id,'123456','automatic project canvas must leave legacy selection alone')
  const routes=(await api('/hub/jimeng/routes')).value.routes
  assert.equal(routes.length,1);assert.equal(routes[0].canvas_id,'654321');assert.match(routes[0].owner_id,new RegExp(':user:'+owner.id+'$'))
  assert.equal(routes[0].project_id,'project:'+project.id)
  const status=security.runAsActor(owner,()=>routing.projectExecutionStatus(project.id))
  assert.ok(!JSON.stringify(status).includes(scoped.apiKey));assert.ok(!JSON.stringify(status).includes(master))
  assert.throws(()=>security.runAsActor(other,()=>routing.projectExecutionStatus(project.id)),/权限|不存在/u)
  const snapshot={id:scoped.executionProjectRouteId,routeId:scoped.executionRouteId}
  assert.throws(()=>security.runAsActor(other,()=>routing.restoreJimengProjectConfig(config,snapshot,foreign.id)),/不一致|权限|不存在/u)
  assert.throws(()=>security.runAsActor(owner,()=>routing.restoreJimengProjectConfig({...config,baseUrl:'http://127.0.0.1:1'},snapshot,project.id)),/不一致/u)
  const prompt='原始视频提示词🌙\n人物走进院落。保持文字、标点、顺序。'
  setJimengTimings({pollMs:15,queuedPollMs:15,lookupDelaysMs:[0,15],submitTimeoutMs:1000})
  const taskId=await security.runAsActor(owner,()=>generateVideo({configId:config.id,dramaId:project.id,prompt,model:'jimeng-2.0-fast',duration:5,aspectRatio:'16:9'}))
  let task:any
  for(let attempt=0;attempt<150;attempt++){
    task=db.select().from(schema.sysTask).where(eq(schema.sysTask.id,taskId)).get()
    if(task?.taskId||task?.status==='failed')break
    await new Promise(resolve=>setTimeout(resolve,15))
  }
  assert.ok(task.taskId,JSON.stringify({status:task.status,error:task.errorMsg}))
  const remote=await api('/v1/videos/'+task.taskId,{key:scoped.apiKey})
  assert.equal(remote.status,200);assert.equal(remote.value.route_id,scoped.executionRouteId)
  assert.equal(remote.value.prompt_sha256,createHash('sha256').update(prompt).digest('hex'))
  assert.equal(remote.value.canvas_id,'654321')
  const persisted=JSON.parse(task.params)
  assert.deepEqual(persisted.jimengProjectRoute,snapshot)
  assert.ok(!task.params.includes(scoped.apiKey));assert.ok(!task.params.includes(master))
  const library=await api('/v1/canvas-library',{key:scoped.apiKey});assert.equal(library.status,200);assert.equal(library.value.route_id,scoped.executionRouteId)
  assert.equal((await api('/v1/canvas-library?canvas_id=123456',{key:scoped.apiKey})).status,403)
  assert.equal((await api('/v1/videos/'+task.taskId+'/cancel',{method:'POST',key:scoped.apiKey,body:{}})).status,200)
  await new Promise(resolve=>setTimeout(resolve,80))
  const events=await fs.readFile(path.join(platformData,'jimeng/synthetic-transport-events.jsonl'),'utf8')
  assert.equal(events.split('\n').filter(Boolean).map(JSON.parse).filter(row=>row.kind==='send').length,0,'paused fixture must never generate')
  assert.equal(events.split('\n').filter(Boolean).map(JSON.parse).filter(row=>row.kind==='create_canvas').length,1)
  // Explicit admin checks cannot claim a stale/revoked credential is ready.
  await api('/hub/jimeng/routes/'+scoped.executionRouteId+'/key',{method:'DELETE'})
  let adminReportedReady=false
  try{await security.runAsActor(admin,()=>routing.adminProvisionProject(config.id!,project.id));adminReportedReady=true}
  catch(error){assert.match(String(error),/凭据|授权|失效|核对|HTTP|访问|未完成/u)}
  if(adminReportedReady){
    const afterCheck=await security.runAsActor(owner,()=>routing.resolveJimengProjectConfig(config,project.id))
    assert.equal((await api('/v1/status',{key:afterCheck.apiKey})).status,200,'admin check must not falsely label a revoked Key ready')
  }
  await assert.rejects(security.runAsActor(owner,()=>routing.adminReauthorizeProject(config.id!,project.id)),/管理员/u)
  const issuesBefore=projectKeyIssues
  const rekeys=await security.runAsActor(admin,()=>Promise.allSettled([
    routing.adminReauthorizeProject(config.id!,project.id),routing.adminReauthorizeProject(config.id!,project.id),
  ]))
  assert.equal(rekeys.filter(value=>value.status==='fulfilled').length,1)
  assert.equal(rekeys.filter(value=>value.status==='rejected').length,1)
  assert.equal(projectKeyIssues,issuesBefore+1,'concurrent administrators must rotate this route only once')
  const restored=security.runAsActor(owner,()=>routing.restoreJimengProjectConfig(config,snapshot,project.id)) as any
  assert.notEqual(restored.apiKey,scoped.apiKey)
  assert.equal(restored.executionRouteId,scoped.executionRouteId)
  assert.equal((await api('/v1/status',{key:restored.apiKey})).status,200)
  assert.equal((await api('/hub/jimeng/routes')).value.routes.length,1)
  const afterRepairEvents=await fs.readFile(path.join(platformData,'jimeng/synthetic-transport-events.jsonl'),'utf8')
  assert.equal(afterRepairEvents.split('\n').filter(Boolean).map(JSON.parse).filter(row=>row.kind==='create_canvas').length,1)
  assert.equal(afterRepairEvents.split('\n').filter(Boolean).map(JSON.parse).filter(row=>row.kind==='send').length,0)
  const third=db.insert(schema.dramas).values({title:'Parallel project',ownerUserId:owner.id,createdAt:at,updatedAt:at}).returning().get()
  const parallel=await Promise.allSettled([
    security.runAsActor(other,()=>routing.resolveJimengProjectConfig(config,foreign.id)),
    security.runAsActor(owner,()=>routing.resolveJimengProjectConfig(config,third.id)),
  ])
  assert.ok(parallel.every(value=>value.status==='fulfilled'),JSON.stringify(parallel.map(value=>value.status==='rejected'?String(value.reason):value.status)))
  const remoteRoutes=(await api('/hub/jimeng/routes')).value.routes
  assert.equal(remoteRoutes.length,3);assert.equal(new Set(remoteRoutes.map((row:any)=>row.canvas_id)).size,3)
  assert.equal((await api('/hub/jimeng/accounts')).value.accounts[0].canvas_id,'123456')
  assert.equal((await fs.readFile(path.join(platformData,'jimeng/synthetic-transport-events.jsonl'),'utf8')).split('\n').filter(Boolean).map(JSON.parse).filter(row=>row.kind==='send').length,0)

  await t.test('global feature grants block alternate legacy configs and preserve historical access',async()=>{
    await security.runAsActor(admin,()=>routing.saveExecutionUserAccess(config.id!,{access:'selected',user_ids:[owner.id]}))
    const denied=await security.runAsActor(other,()=>routing.projectExecutionOptions(config.id!,foreign.id))
    assert.equal(denied.feature_allowed,false);assert.deepEqual(denied.accounts,[])
    const alternate=store.saveBinding(channel.id,{name:'Alternate legacy same service',model:'jimeng-2.0-fast',type:'video',protocol_id:'video.jimeng-local',enabled:true})
    const alternateConfig=(await security.runAsActor(other,()=>getConfigById(alternate.config_id)))!
    await assert.rejects(security.runAsActor(other,()=>routing.resolveJimengProjectConfig(alternateConfig,foreign.id)),/功能权限/)
    const otherRoute=remoteRoutes.find((row:any)=>row.owner_id.endsWith(':user:'+other.id))
    const oldLocal=db.$client.prepare('SELECT id FROM platform_jimeng_project_routes WHERE remote_route_id=?').get(otherRoute.id) as any
    assert.ok(security.runAsActor(other,()=>routing.restoreJimengProjectConfig(config,{id:oldLocal.id,routeId:otherRoute.id},foreign.id)).apiKey)
    await assert.rejects(security.runAsActor(other,()=>routing.saveExecutionUserAccess(config.id!,{access:'all',user_ids:[]})),/管理员/)
  })
  await t.test('user names and renames a real platform canvas then switches without redirecting queued work',async()=>{
    const named=db.insert(schema.dramas).values({title:'User canvas workflow',ownerUserId:owner.id,createdAt:at,updatedAt:at}).returning().get()
    const initial=await security.runAsActor(owner,()=>routing.selectProjectExecution(config.id!,named.id,{account_id:account,mode:'new',canvas_name:'自定义画布🌙',expected_route_id:null}))
    const options=await security.runAsActor(owner,()=>routing.projectExecutionOptions(config.id!,named.id))
    const canvas=options.accounts.flatMap(row=>row.canvases).find(row=>row.id===initial.current!.canvas_id)!
    assert.equal(canvas.name,'自定义画布🌙');assert.equal(canvas.can_rename,true)
    const renamed=await security.runAsActor(owner,()=>routing.renameProjectCanvas(config.id!,named.id,{account_id:account,canvas_id:canvas.id,name:'继续创作',expected_name:canvas.name}))
    assert.deepEqual(renamed,{renamed:true,account_id:account,canvas_id:canvas.id,name:'继续创作'})
    await assert.rejects(security.runAsActor(owner,()=>routing.renameProjectCanvas(config.id!,named.id,{account_id:account,canvas_id:canvas.id,name:'错误旧名',expected_name:canvas.name})),/名称已变化/)
    const old=db.$client.prepare('SELECT * FROM platform_jimeng_project_routes WHERE id=?').get(initial.current!.id) as any
    const queued=db.insert(schema.sysTask).values({type:'video',provider:'jimeng_local',dramaId:named.id,status:'processing',stage:'queued',params:JSON.stringify({jimengProjectRoute:{id:old.id,routeId:old.remote_route_id}}),createdAt:at,updatedAt:at}).returning().get()
    const switched=await security.runAsActor(owner,()=>routing.selectProjectExecution(config.id!,named.id,{account_id:account,mode:'new',canvas_name:'下一张画布',expected_route_id:old.id}))
    assert.notEqual(switched.current!.canvas_id,old.canvas_id)
    const retained=security.runAsActor(owner,()=>routing.restoreJimengProjectConfig(config,{id:old.id,routeId:old.remote_route_id},named.id))
    assert.equal(retained.executionRouteId,old.remote_route_id)
    assert.deepEqual(JSON.parse((db.$client.prepare('SELECT params FROM sys_task WHERE id=?').get(queued.id) as any).params).jimengProjectRoute,{id:old.id,routeId:old.remote_route_id})
  })
  await t.test('full-feature user selects unassigned history after its old submissions settle',async()=>{
    const prompt='Legacy task remains legacy.'
    const legacy=await api('/v1/videos',{method:'POST',body:{client_request_id:crypto.randomUUID(),model:'jimeng-2.0-fast',prompt,prompt_sha256:createHash('sha256').update(prompt).digest('hex'),duration:5,aspect_ratio:'16:9',images:[],bindings:[],metadata:{}}})
    assert.equal(legacy.status,202)
    const target=db.insert(schema.dramas).values({title:'接入原画布',ownerUserId:owner.id,createdAt:at,updatedAt:at}).returning().get()
    await assert.rejects(security.runAsActor(owner,()=>routing.adminAdoptProjectCanvas(config.id!,target.id,{account_id:account,canvas_id:'123456',confirmed:true})),/管理员/)
    await assert.rejects(security.runAsActor(owner,()=>routing.selectProjectExecution(config.id!,target.id,{account_id:account,mode:'existing',canvas_id:'123456',expected_route_id:null})),/旧任务正在准备或提交/)
    assert.equal((await security.runAsActor(owner,()=>routing.projectExecutionOptions(config.id!,target.id))).pending,null)
    const database=new DatabaseSync(path.join(platformData,'jimeng/tasks.sqlite3'))
    database.prepare("UPDATE jobs SET status='processing',stage='awaiting_result',submit_id='old-accepted-receipt' WHERE id=?").run(legacy.value.id)
    database.close()
    const before=await engine.invoke('videos.detail',{id:legacy.value.id})
    const adopted=await security.runAsActor(owner,()=>routing.selectProjectExecution(config.id!,target.id,{account_id:account,mode:'existing',canvas_id:'123456',expected_route_id:null}))
    assert.equal(adopted.current!.canvas_id,'123456')
    assert.deepEqual(await engine.invoke('videos.detail',{id:legacy.value.id}),before)
    const scoped=await security.runAsActor(owner,()=>routing.resolveJimengProjectConfig(config,target.id))
    assert.equal((await api('/v1/videos/'+legacy.value.id,{key:scoped.apiKey})).status,404)
    const again=await security.runAsActor(admin,()=>routing.adminAdoptProjectCanvas(config.id!,target.id,{account_id:account,canvas_id:'123456',confirmed:true}))
    assert.equal(again.current!.id,adopted.current!.id)
  })
  await t.test('racing for one existing canvas releases only the proven losing reservation',async()=>{
    const result=await api(`/hub/jimeng/accounts/${account}/canvases`,{method:'POST',body:{name:'并发选择测试',select:false,client_request_id:crypto.randomUUID()}})
    assert.equal(result.status,200)
    const canvasId=result.value.id
    await security.runAsActor(admin,()=>routing.saveExecutionAccountPolicies(config.id!,{policies:[{account_id:account,enabled:true,access:'all',user_ids:[],allow_create:true,canvas_grants:[{canvas_id:canvasId,user_ids:[owner.id]}]}]}))
    const projects=['Race A','Race B'].map(title=>db.insert(schema.dramas).values({title,ownerUserId:owner.id,createdAt:at,updatedAt:at}).returning().get())
    const results=await Promise.allSettled(projects.map(project=>security.runAsActor(owner,()=>routing.selectProjectExecution(config.id!,project.id,{account_id:account,mode:'existing',canvas_id:canvasId,expected_route_id:null}))))
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1)
    const winner=results.findIndex(result=>result.status==='fulfilled'),loser=winner===0?1:0
    const visible=await security.runAsActor(owner,()=>routing.projectExecutionOptions(config.id!,projects[winner].id))
    assert.ok(visible.accounts.flatMap(row=>row.canvases).some(canvas=>canvas.id===canvasId))
    const failed=await security.runAsActor(owner,()=>routing.projectExecutionOptions(config.id!,projects[loser].id))
    assert.equal(failed.pending,null)
    assert.equal((db.$client.prepare('SELECT count(*) count FROM platform_jimeng_project_routes WHERE canvas_id=?').get(canvasId) as any).count,1)
    const retry=await security.runAsActor(owner,()=>routing.selectProjectExecution(config.id!,projects[loser].id,{account_id:account,mode:'new',canvas_name:'另选画布',expected_route_id:null}))
    assert.notEqual(retry.current!.canvas_id,canvasId)
  })
})
