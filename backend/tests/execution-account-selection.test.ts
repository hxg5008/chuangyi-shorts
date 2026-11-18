import test, {after} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import {randomUUID} from 'node:crypto'
import Database from 'better-sqlite3'
import {ensureExecutionRoutingSchema} from '../src/services/execution-routing-schema.ts'
import {Hono} from 'hono'

const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cy-execution-choice-'))
Object.assign(process.env,{HUOBAO_DATA_DIR:directory,SQLITE_PATH:path.join(directory,'db.sqlite3'),STORAGE_PATH:path.join(directory,'static'),WORKSPACE_PATH:path.join(directory,'workspace'),MYSQL_AUTO_IMPORT:'false',HUOBAO_PROXY_URL:'direct'})
const {db,schema}=await import('../src/db/index.ts'),security=await import('../src/services/platform-security/index.ts'),routing=await import('../src/services/execution-projects.ts')
const {getModelChannelStore}=await import('../src/services/model-channels/store.ts'),{getConfigById}=await import('../src/services/ai.ts')
security.initPlatformSecurity()
const admin=security.listUsers().find(user=>user.role==='admin')!,alice=security.createUser('alice-routing','test').user,bob=security.createUser('bob-routing','test').user
const now=new Date().toISOString(),addProject=(owner:number,title:string)=>db.insert(schema.dramas).values({ownerUserId:owner,title,createdAt:now,updatedAt:now}).returning().get()
const a=addProject(alice.id,'A'),b=addProject(bob.id,'B'),a2=addProject(alice.id,'A2'),b2=addProject(bob.id,'B2')
const run=(actor:any,fn:()=>any)=>security.runAsActor(actor,fn)
const accounts=[{id:'acc_a',name:'Shared',state:'ready',projects:[{id:'101',name:'Explicit grant'},{id:'102',name:'Private canvas'},{id:'103',name:'Legacy history'}]}, {id:'acc_b',name:'Second',state:'ready',projects:[]}]
const routes:any[]=[],created=new Map<string,any>(),videoJobs=new Map<string,any>(),routeLists:string[]=[];let posts=0,lost=false,choiceCap=true,healthStatus=200,failNextKey=false
const master='offline-master',server=http.createServer(async(req,res)=>{
  let text='';for await(const part of req)text+=part;const body=text?JSON.parse(text):{},url=req.url!
  res.setHeader('Content-Type','application/json')
  if(url.startsWith('/v1/videos')){
    if(req.method==='POST'){
      const route=routes.find(row=>row.id===body.route_id);assert.ok(route);assert.equal(req.headers.authorization,'Bearer sk-cy-route-offline-'+route.id)
      const record={id:'jm_'+randomUUID().replaceAll('-',''),status:'processing',stage:'generating',upstream_task_id:'synthetic-upstream',name_status:'completed',prompt_sha256:body.prompt_sha256,reference_count:body.images.length,account_id:route.account_id,canvas_id:route.canvas_id,body}
      videoJobs.set(record.id,record);res.statusCode=202;return res.end(JSON.stringify(record))
    }
    const record=videoJobs.get(url.split('/').at(-1)!);assert.ok(record);assert.equal(req.headers.authorization,'Bearer sk-cy-route-offline-'+record.body.route_id);return res.end(JSON.stringify(record))
  }
  assert.equal(req.headers.authorization,'Bearer '+master)
  if(url==='/health'){res.statusCode=healthStatus;return res.end(JSON.stringify({capabilities:{project_routes:true,scoped_canvas_library:true,scoped_downloads:true,canvas_create_idempotent:true,canvas_assignment_status:choiceCap,route_soft_delete:true,canvas_rename:true,legacy_canvas_adoption:true,safe_legacy_adoption:true,user_canvas_management:true}}))}
  if(url==='/hub/jimeng/accounts')return res.end(JSON.stringify({accounts}))
  const rename=/^\/hub\/jimeng\/accounts\/(acc_[ab])\/canvases\/(\d+)\/rename$/u.exec(url)
  if(rename){const canvas=accounts.find(account=>account.id===rename[1])!.projects.find(canvas=>canvas.id===rename[2])!;const changed=canvas.name!==body.name;canvas.name=body.name;return res.end(JSON.stringify({id:canvas.id,account_id:rename[1],name:body.name,renamed:changed,generation_submitted:false}))}
  const acc=/^\/hub\/jimeng\/accounts\/(acc_[ab])\/canvases$/u.exec(url)
  if(acc&&req.method==='GET')return res.end(JSON.stringify({account_id:acc[1],canvases:accounts.find(a=>a.id===acc[1])!.projects.map(p=>{const route=routes.find(r=>r.account_id===acc[1]&&r.canvas_id===p.id);return{...p,availability:route?'route_bound':['103','104','105'].includes(p.id)?'legacy_history':'available',...(route?{route_id:route.id}:{})}})}))
  if(acc){posts++;if(!created.has(body.client_request_id)){const canvas={id:String(1000+created.size),name:body.name,account_id:acc[1],selected:false};created.set(body.client_request_id,canvas);accounts.find(a=>a.id===acc[1])!.projects.push(canvas)}if(lost){lost=false;res.statusCode=502;return res.end('{}')}return res.end(JSON.stringify(created.get(body.client_request_id)))}
  if(url.startsWith('/hub/jimeng/routes')&&req.method==='GET'&&!/^\/hub\/jimeng\/routes\/rt_/u.test(url)){routeLists.push(url);return res.end(JSON.stringify({routes:url.includes('include_deleted=true')?routes:routes.filter(route=>route.deleted_at==null)}))}
  if(url==='/hub/jimeng/routes'&&req.method==='POST'){assert.ok(!routes.some(r=>r.account_id===body.account_id&&r.canvas_id===body.canvas_id));const row={...body,id:'rt_'+randomUUID().replaceAll('-',''),enabled:true};routes.push(row);return res.end(JSON.stringify(row))}
  const route=routes.find(r=>url.includes(r.id));if(route&&url.endsWith('/key')){if(failNextKey){failNextKey=false;res.statusCode=502;return res.end('{}')}return res.end(JSON.stringify({route_id:route.id,key:'sk-cy-route-offline-'+route.id}))}if(route)return res.end(JSON.stringify(route))
  res.statusCode=404;res.end('{}')
})
await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes))
const store=getModelChannelStore(),channel=store.saveChannel({name:'Routing fixture',base_url:'http://127.0.0.1:'+(server.address() as any).port,api_key:master}),binding=store.saveBinding(channel.id,{name:'Video',model:'jimeng-2.0-fast',type:'video',protocol_id:'video.jimeng-local',enabled:true,access:'all'})
const config=(await run(alice,()=>getConfigById(binding.config_id)))!
await run(admin,()=>routing.saveExecutionService(config.id!,{account_id:'acc_a',enabled:true}))
const {executionAdminRoutes,executionProjectRoutes}=await import('../src/routes/execution-projects.ts')
const app=new Hono();app.use('/api/v1/*',security.platformSecurityMiddleware);app.route('/api/v1/admin/execution',executionAdminRoutes);app.route('/api/v1/dramas',executionProjectRoutes)
app.route('/api/v1/tasks',(await import('../src/routes/tasks.ts')).default)
app.onError((error:any,c)=>c.json({code:error.status||500,message:error.message},error.status||500))
const sessions=new Map([admin,alice,bob].map(actor=>[actor.id,security.createSession(actor)]))
const request=(actor:any,url:string,method='GET',body?:any,csrf=true)=>{const session=sessions.get(actor.id)!;return app.request('/api/v1'+url,{method,headers:{Cookie:'huobao_session='+session.token,...(csrf?{'X-CSRF-Token':session.csrfToken}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})})}
const policies=(secondAlice=false)=>({policies:[{account_id:'acc_a',enabled:true,access:'selected',user_ids:[alice.id,bob.id],allow_create:true,canvas_grants:[{canvas_id:'101',user_ids:[alice.id]},{canvas_id:'103',user_ids:[alice.id]}]},{account_id:'acc_b',enabled:true,access:'selected',user_ids:secondAlice?[alice.id,bob.id]:[bob.id],allow_create:true,canvas_grants:[]}]})
after(async()=>{await new Promise<void>(yes=>server.close(()=>yes()));db.$client.close();await fs.rm(directory,{recursive:true,force:true})})
let first:any,second:any
test('migration keeps legacy numeric route IDs, encrypted bytes and unique active bindings',()=>{
  const sql=new Database(':memory:');sql.exec("CREATE TABLE platform_jimeng_project_routes(id INTEGER PRIMARY KEY AUTOINCREMENT,drama_id INTEGER NOT NULL,owner_id INTEGER NOT NULL,server_origin TEXT NOT NULL,account_id TEXT NOT NULL,canvas_id TEXT,remote_route_id TEXT,key_blob TEXT,canvas_request_id TEXT NOT NULL,state TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(drama_id,server_origin)); INSERT INTO platform_jimeng_project_routes VALUES(77,1,2,'http://example.invalid','old','33','route-old','ciphertext','request-old','ready','original')")
  sql.prepare("UPDATE sqlite_sequence SET seq=99 WHERE name='platform_jimeng_project_routes'").run()
  ensureExecutionRoutingSchema(sql);ensureExecutionRoutingSchema(sql)
  const row=sql.prepare('SELECT * FROM platform_jimeng_project_routes').get() as any;assert.equal(row.id,77);assert.equal(row.key_blob,'ciphertext');assert.equal(row.is_current,1);assert.equal(row.version,1);assert.equal(row.remote_project_id,'project:1');assert.equal((sql.prepare("SELECT seq FROM sqlite_sequence WHERE name='platform_jimeng_project_routes'").get() as any).seq,99);sql.close()
})
test('migration refuses unknown foreign-key extensions without cascading away their rows',()=>{
  const sql=new Database(':memory:');sql.pragma('foreign_keys=ON')
  sql.exec("CREATE TABLE platform_jimeng_project_routes(id INTEGER PRIMARY KEY);INSERT INTO platform_jimeng_project_routes VALUES(77);CREATE TABLE extension_history(id INTEGER PRIMARY KEY,route_id INTEGER REFERENCES platform_jimeng_project_routes(id) ON DELETE CASCADE);INSERT INTO extension_history VALUES(1,77)")
  assert.throws(()=>ensureExecutionRoutingSchema(sql),/外部外键/u);assert.equal((sql.prepare('SELECT count(*) count FROM extension_history').get() as any).count,1);assert.equal((sql.prepare('SELECT id FROM platform_jimeng_project_routes').get() as any).id,77);sql.close()
})
test('only administrator can configure account grants',async()=>{
  await assert.rejects(run(alice,()=>routing.saveExecutionAccountPolicies(config.id!,policies())),/管理员/u)
  await run(admin,()=>routing.saveExecutionAccountPolicies(config.id!,policies()))
})
test('ordinary user sees only permitted accounts and explicitly granted empty canvases',async()=>{
  const options=await run(alice,()=>routing.projectExecutionOptions(config.id!,a.id))
  assert.deepEqual(options.accounts.map((x:any)=>x.id),['acc_a']);assert.deepEqual(options.accounts[0].canvases.map((x:any)=>x.id),['101'])
  assert.ok(!JSON.stringify(options).includes(master));assert.ok(!JSON.stringify(options).includes('Private canvas'))
  await assert.rejects(run(bob,()=>routing.projectExecutionOptions(config.id!,a.id)),/权限/u)
})
test('same account supports separate owner projects and independent immutable routes',async()=>{
  first=await run(alice,()=>routing.selectProjectExecution(config.id!,a.id,{account_id:'acc_a',mode:'new',expected_route_id:null}))
  second=await run(bob,()=>routing.selectProjectExecution(config.id!,b.id,{account_id:'acc_a',mode:'new',expected_route_id:null}))
  assert.notEqual(first.current.canvas_id,second.current.canvas_id);assert.notEqual(first.current.id,second.current.id)
  assert.equal(routes.length,2);assert.notEqual(routes[0].owner_id,routes[1].owner_id)
})
test('forbidden account and foreign canvas do not create upstream state',async()=>{
  const count=posts
  await assert.rejects(run(alice,()=>routing.selectProjectExecution(config.id!,a.id,{account_id:'acc_b',mode:'new',expected_route_id:first.current.id})),/未获准/u)
  await assert.rejects(run(bob,()=>routing.selectProjectExecution(config.id!,b2.id,{account_id:'acc_a',mode:'existing',canvas_id:first.current.canvas_id,expected_route_id:null})),/未授权/u)
  assert.equal(posts,count)
})
test('explicit canvas grant binds without creating a canvas and cannot be reused by another project',async()=>{
  const count=posts
  await run(alice,()=>routing.selectProjectExecution(config.id!,a2.id,{account_id:'acc_a',mode:'existing',canvas_id:'101',expected_route_id:null}))
  assert.equal(posts,count)
  await assert.rejects(run(alice,()=>routing.selectProjectExecution(config.id!,a.id,{account_id:'acc_a',mode:'existing',canvas_id:'101',expected_route_id:first.current.id})),/未授权/u)
})
test('stale expected binding and pending local submissions block switching',async()=>{
  await assert.rejects(run(alice,()=>routing.selectProjectExecution(config.id!,a.id,{account_id:'acc_a',mode:'new',expected_route_id:null})),/发生变化/u)
  const task=db.insert(schema.sysTask).values({type:'video',provider:'jimeng_local',dramaId:a.id,status:'processing',stage:'submitting',createdAt:now,updatedAt:now}).returning().get()
  await assert.rejects(run(alice,()=>routing.selectProjectExecution(config.id!,a.id,{account_id:'acc_a',mode:'new',expected_route_id:first.current.id})),/尚未接单/u)
  db.$client.prepare("UPDATE sys_task SET task_id='upstream-existing' WHERE id=?").run(task.id)
})
test('switching account makes a new revision and old snapshot keeps its original secret',async()=>{
  await run(admin,()=>routing.saveExecutionAccountPolicies(config.id!,policies(true)))
  const oldConfig=run(alice,()=>routing.restoreJimengProjectConfig(config,{id:first.current.id,routeId:routes.find(r=>r.project_id==='project:'+a.id).id},a.id))
  const changed=await run(alice,()=>routing.selectProjectExecution(config.id!,a.id,{account_id:'acc_b',mode:'new',expected_route_id:first.current.id}))
  assert.equal(changed.current.version,2);assert.equal(changed.current.account_id,'acc_b')
  const restored=run(alice,()=>routing.restoreJimengProjectConfig(config,{id:first.current.id,routeId:oldConfig.executionRouteId},a.id));assert.equal(restored.apiKey,oldConfig.apiKey)
  const pinned=await run(alice,()=>routing.resolveJimengProjectConfig(config,a.id,first.current.id));assert.equal(pinned.apiKey,oldConfig.apiKey)
  first=changed
})
test('lost creation response resumes its same durable idempotency key, leaving current unchanged',async()=>{
  lost=true;const count=created.size
  await assert.rejects(run(alice,()=>routing.selectProjectExecution(config.id!,a.id,{account_id:'acc_a',mode:'new',expected_route_id:first.current.id})),/HTTP 502/u)
  const pending=await run(alice,()=>routing.projectExecutionOptions(config.id!,a.id));assert.equal(pending.current!.id,first.current.id);assert.equal(pending.pending!.mode,'new')
  assert.equal(created.size,count+1)
  const resumed=await run(alice,()=>routing.selectProjectExecution(config.id!,a.id,{account_id:'acc_a',mode:'new',expected_route_id:first.current.id}))
  assert.equal(created.size,count+1);assert.equal(resumed.current!.version,3);first=resumed
})
test('revoking account blocks new submissions but leaves old result recovery',async()=>{
  const snapshot={id:first.current.id,routeId:routes.find(r=>r.canvas_id===first.current.canvas_id)!.id}
  await run(admin,()=>routing.saveExecutionAccountPolicies(config.id!,{policies:[]}))
  const options=await run(alice,()=>routing.projectExecutionOptions(config.id!,a.id));assert.equal(options.accounts.length,0);assert.equal(options.current!.permitted,false)
  await assert.rejects(run(alice,()=>routing.resolveJimengProjectConfig(config,a.id)),/未获准/u)
  assert.ok(run(alice,()=>routing.restoreJimengProjectConfig(config,snapshot,a.id)).apiKey)
})
test('older platforms retain a ready project route without exposing new canvas choices',async()=>{
  choiceCap=false
  const value=await run(alice,()=>routing.projectExecutionOptions(config.id!,a.id))
  assert.equal(value.managed,true);assert.equal(value.selection_available,false);assert.equal(value.current!.id,first.current.id);assert.deepEqual(value.accounts,[])
  const empty=addProject(alice.id,'Old platform automatic binding')
  const automatic=await run(alice,()=>routing.projectExecutionOptions(config.id!,empty.id))
  assert.equal(automatic.managed,false);assert.equal(automatic.legacy_autobind,true);assert.equal(automatic.selection_available,false)
  choiceCap=true
})
test('restoring a historical canvas activates its own route without creating or changing history',async()=>{
  await run(admin,()=>routing.saveExecutionAccountPolicies(config.id!,policies(true)))
  const old=routes.find(r=>r.project_id==='project:'+a.id),count=posts
  const back=await run(alice,()=>routing.selectProjectExecution(config.id!,a.id,{account_id:old.account_id,mode:'existing',canvas_id:old.canvas_id,expected_route_id:first.current.id}))
  assert.equal(back.current!.version,1);assert.equal(posts,count)
  const rows=db.$client.prepare('SELECT id,is_current,remote_route_id FROM platform_jimeng_project_routes WHERE drama_id=?').all(a.id) as any[]
  assert.equal(rows.filter(row=>row.is_current).length,1);assert.equal(rows.length,3)
})
test('two simultaneous binding writes cannot create two canvases or activate competing routes',async()=>{
  const project=addProject(alice.id,'Concurrent'),count=posts
  const results=await run(alice,()=>Promise.allSettled([1,2].map(()=>routing.selectProjectExecution(config.id!,project.id,{account_id:'acc_a',mode:'new',expected_route_id:null}))))
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal(posts,count+1)
})
test('caller supplied owner and foreign history bindings cannot bypass project isolation',async()=>{
  await assert.rejects(run(alice,()=>routing.selectProjectExecution(config.id!,a.id,{account_id:'acc_a',mode:'new',expected_route_id:null,owner_id:bob.id})),/格式错误/u)
  await assert.rejects(run(alice,()=>routing.resolveJimengProjectConfig(config,a.id,second.current.id)),/不属于/u)
})
test('HTTP endpoints enforce login, project ownership, admin-only grants and CSRF',async()=>{
  assert.equal((await app.request(`/api/v1/dramas/${a.id}/execution-options?config_id=${config.id}`)).status,401)
  assert.equal((await request(bob,`/dramas/${a.id}/execution-options?config_id=${config.id}`)).status,404)
  assert.equal((await request(alice,`/admin/execution/services/${config.id}/account-policies`)).status,403)
  assert.equal((await request(alice,`/dramas/${a.id}/execution-route`,'POST',{config_id:config.id,account_id:'acc_a',mode:'new',expected_route_id:null},false)).status,403)
  const options=await request(alice,`/dramas/${a.id}/execution-options?config_id=${config.id}`)
  assert.equal(options.status,200);assert.equal(options.headers.get('cache-control'),'private, no-store')
  const body=await options.json();assert.ok(!JSON.stringify(body).includes(master));assert.ok(!JSON.stringify(body).includes('key_blob'));assert.ok(!JSON.stringify(body).includes('sk-cy-route-'))
})
test('single-flight route creation preserves each concurrent callers selected model and parameters',async()=>{
  const p=addProject(alice.id,'Two model selections')
  const alternate={...config,model:'jimeng-alternate-test',defaults:{duration:7}}
  const [one,two]=await run(alice,()=>Promise.all([routing.resolveJimengProjectConfig(config,p.id),routing.resolveJimengProjectConfig(alternate,p.id)]))
  assert.equal(one.executionRouteId,two.executionRouteId);assert.equal(one.model,config.model);assert.equal(two.model,alternate.model);assert.deepEqual(two.defaults,{duration:7})
})
test('real tasks HTTP submission freezes the chosen historical route through generation and handoff',async()=>{
  const old=db.$client.prepare('SELECT id,remote_route_id,account_id,canvas_id FROM platform_jimeng_project_routes WHERE drama_id=? AND version=2').get(a.id) as any
  assert.equal(old.account_id,'acc_b')
  const response=await request(alice,'/tasks','POST',{type:'video',config_id:config.id,drama_id:a.id,model:'jimeng-2.0-fast',prompt:'Synthetic exact video prompt.',duration:5,aspect_ratio:'16:9',execution_project_route_id:old.id})
  assert.equal(response.status,201,JSON.stringify(await response.clone().json()))
  const {data}=await response.json()
  let record:any
  for(let i=0;i<150;i++){record=db.$client.prepare('SELECT * FROM sys_task WHERE id=?').get(data.id);if(record.status==='completed'||record.status==='failed')break;await new Promise(yes=>setTimeout(yes,20))}
  assert.equal(record.status,'completed',record.error_msg);assert.equal(record.stage,'handed_off')
  const params=JSON.parse(record.params);assert.deepEqual(params.jimengProjectRoute,{id:old.id,routeId:old.remote_route_id})
  const job=videoJobs.get(record.task_id);assert.ok(job);assert.equal(job.body.route_id,old.remote_route_id);assert.equal(job.account_id,'acc_b');assert.equal(job.canvas_id,old.canvas_id);assert.equal(job.body.prompt,record.prompt)
  assert.equal(videoJobs.size,1)
})
test('tasks HTTP rejects invalid binding IDs and binding metadata for non-Jimeng models before any submit',async()=>{
  for(const value of [0,-1,1.5,'1',null]){
    const response=await request(alice,'/tasks','POST',{type:'video',config_id:config.id,drama_id:a.id,prompt:'Synthetic',execution_project_route_id:value})
    assert.equal(response.status,400)
  }
  assert.equal((await request(alice,'/tasks','POST',{type:'image',config_id:config.id,drama_id:a.id,prompt:'Synthetic',execution_project_route_id:1})).status,400)
  const other=store.saveBinding(channel.id,{name:'Other video',model:'test-model',type:'video',protocol_id:'video.minimax',enabled:true,access:'all'})
  const response=await request(alice,'/tasks','POST',{type:'video',config_id:other.config_id,drama_id:a.id,prompt:'Synthetic',execution_project_route_id:first.current.id})
  assert.equal(response.status,400);assert.match((await response.json()).message,/仅用于即梦/u);assert.equal(videoJobs.size,1)
})
test('legacy unconfigured services explicitly bypass selection after project and model permission checks',async()=>{
  const legacy=store.saveBinding(channel.id,{name:'Legacy unconfigured',model:'jimeng-2.0-fast',type:'video',protocol_id:'video.jimeng-local',enabled:true,access:'all'})
  const value=await run(alice,()=>routing.projectExecutionOptions(legacy.config_id,a.id))
  assert.equal(value.managed,false);assert.equal(value.legacy,true);assert.equal(value.selection_available,false)
  await assert.rejects(run(bob,()=>routing.projectExecutionOptions(legacy.config_id,a.id)),/权限/u)
  const privateModel=store.saveBinding(channel.id,{name:'Private model',model:'jimeng-2.0-fast',type:'video',protocol_id:'video.jimeng-local',enabled:true,access:'selected',allowed_user_ids:[bob.id]})
  await assert.rejects(run(alice,()=>routing.projectExecutionOptions(privateModel.config_id,a.id)),/请选择/u)
})
test('disabled configured service remains blocked instead of downgrading to legacy behavior',async()=>{
  const disabled=store.saveBinding(channel.id,{name:'Paused service',model:'jimeng-2.0-fast',type:'video',protocol_id:'video.jimeng-local',enabled:true,access:'all'})
  await run(admin,()=>routing.saveExecutionService(disabled.config_id,{account_id:'acc_a',enabled:false}))
  await assert.rejects(run(alice,()=>routing.projectExecutionOptions(disabled.config_id,a.id)),/尚未启用/u)
})
test('configured service auth and network errors are not treated as legacy compatibility',async()=>{
  for(const status of [401,503]){healthStatus=status;await assert.rejects(run(alice,()=>routing.projectExecutionOptions(config.id!,a.id)),new RegExp('HTTP '+status))}
  healthStatus=200
})
test('deleted current remote route blocks new tasks before persistence, but historic recovery stays available',async()=>{
  const p=addProject(alice.id,'Deleted upstream route')
  const selected=await run(alice,()=>routing.selectProjectExecution(config.id!,p.id,{account_id:'acc_a',mode:'new',expected_route_id:null}))
  const row=db.$client.prepare('SELECT * FROM platform_jimeng_project_routes WHERE id=?').get(selected.current.id) as any
  const remote=routes.find(route=>route.id===row.remote_route_id);remote.enabled=false;remote.deleted_at=1234
  const count=(db.$client.prepare('SELECT count(*) count FROM sys_task').get() as any).count,postsBefore=videoJobs.size
  await assert.rejects(run(alice,()=>routing.resolveJimengProjectConfig(config,p.id)),/绑定已删除/u)
  await assert.rejects(run(alice,()=>routing.resolveJimengProjectConfig(config,p.id,row.id)),/绑定已删除/u)
  const response=await request(alice,'/tasks','POST',{type:'video',config_id:config.id,drama_id:p.id,model:'jimeng-2.0-fast',prompt:'Retained prompt.',duration:5,aspect_ratio:'16:9',execution_project_route_id:row.id})
  assert.equal(response.status,400);assert.match((await response.json()).message,/绑定已删除/u)
  assert.equal((db.$client.prepare('SELECT count(*) count FROM sys_task').get() as any).count,count);assert.equal(videoJobs.size,postsBefore)
  const options=await run(alice,()=>routing.projectExecutionOptions(config.id!,p.id))
  assert.equal(options.current!.permitted,false);assert.match(options.current!.unavailable_reason!,/已删除/u)
  assert.ok(!options.accounts.flatMap(account=>account.canvases).some(canvas=>canvas.id===row.canvas_id));assert.ok(options.can_switch)
  assert.ok(routeLists.some(url=>url.endsWith('?include_deleted=true')))
  const old=run(alice,()=>routing.restoreJimengProjectConfig(config,{id:row.id,routeId:row.remote_route_id},p.id))
  assert.equal(old.apiKey,'sk-cy-route-offline-'+row.remote_route_id)
  const switched=await run(alice,()=>routing.selectProjectExecution(config.id!,p.id,{account_id:'acc_a',mode:'new',expected_route_id:row.id}))
  assert.equal(switched.current.version,2);assert.notEqual(switched.current.id,row.id);assert.notEqual(switched.current.canvas_id,row.canvas_id)
})
test('disabled cached remote route is unavailable while immutable historic credentials still resolve',async()=>{
  const p=addProject(alice.id,'Disabled upstream route')
  const selected=await run(alice,()=>routing.selectProjectExecution(config.id!,p.id,{account_id:'acc_a',mode:'new',expected_route_id:null}))
  const row=db.$client.prepare('SELECT * FROM platform_jimeng_project_routes WHERE id=?').get(selected.current.id) as any
  const remote=routes.find(route=>route.id===row.remote_route_id);remote.enabled=false
  await assert.rejects(run(alice,()=>routing.resolveJimengProjectConfig(config,p.id,row.id)),/已停用/u)
  const options=await run(alice,()=>routing.projectExecutionOptions(config.id!,p.id))
  assert.equal(options.current!.permitted,false);assert.match(options.current!.unavailable_reason!,/已停用/u)
  assert.equal(run(alice,()=>routing.restoreJimengProjectConfig(config,{id:row.id,routeId:row.remote_route_id},p.id)).executionRouteId,row.remote_route_id)
})
test('reconciliation includes tombstones and never recreates a deleted upstream binding',async()=>{
  const p=addProject(alice.id,'Deleted pending binding'),owner=routes.find(route=>route.owner_id.endsWith(':user:'+alice.id)).owner_id
  db.$client.prepare("INSERT INTO platform_jimeng_project_routes(drama_id,owner_id,server_origin,account_id,canvas_request_id,state,updated_at,version,is_current,selection_mode,remote_project_id) VALUES(?,?,?,?,?,'preparing',?,1,0,'new',?)").run(p.id,alice.id,new URL(config.baseUrl).origin,'acc_a',randomUUID(),now,'project:'+p.id)
  routes.push({id:'rt_'+randomUUID().replaceAll('-',''),owner_id:owner,project_id:'project:'+p.id,account_id:'acc_a',canvas_id:'99000',enabled:false,deleted_at:1234})
  const before=posts,count=routes.length
  await assert.rejects(run(alice,()=>routing.selectProjectExecution(config.id!,p.id,{account_id:'acc_a',mode:'new',expected_route_id:null})),/绑定已删除/u)
  assert.equal(posts,before);assert.equal(routes.length,count)
  assert.equal((db.$client.prepare('SELECT state FROM platform_jimeng_project_routes WHERE drama_id=?').get(p.id) as any).state,'preparing')
})

test('custom name remains immutable across a lost create response and reload',async()=>{
  const p=addProject(alice.id,'Persistent custom name'),count=created.size
  lost=true
  await assert.rejects(run(alice,()=>routing.selectProjectExecution(config.id!,p.id,{account_id:'acc_a',mode:'new',canvas_name:'第一季画布🌙',expected_route_id:null})),/HTTP 502/)
  const pending=await run(alice,()=>routing.projectExecutionOptions(config.id!,p.id))
  assert.equal(pending.pending!.requested_canvas_name,'第一季画布🌙')
  await assert.rejects(run(alice,()=>routing.selectProjectExecution(config.id!,p.id,{account_id:'acc_a',mode:'new',canvas_name:'第二个名称',expected_route_id:null})),/不能更换名称/)
  const done=await run(alice,()=>routing.selectProjectExecution(config.id!,p.id,{account_id:'acc_a',mode:'new',expected_route_id:null}))
  assert.equal(created.size,count+1)
  assert.equal(done.current!.requested_canvas_name,'第一季画布🌙')
})
test('adoption resumes its own saved route after key response failure without another route',async()=>{
  const p=addProject(alice.id,'Adopt legacy canvas'),count=routes.length
  failNextKey=true
  await assert.rejects(run(admin,()=>routing.adminAdoptProjectCanvas(config.id!,p.id,{account_id:'acc_a',canvas_id:'103',confirmed:true})),/HTTP 502/)
  const pending=await run(alice,()=>routing.projectExecutionOptions(config.id!,p.id))
  assert.equal(pending.pending!.canvas_id,'103')
  const adopted=await run(admin,()=>routing.adminAdoptProjectCanvas(config.id!,p.id,{account_id:'acc_a',canvas_id:'103',confirmed:true}))
  assert.equal(adopted.current!.id,pending.pending!.id)
  assert.equal(routes.length,count+1)
  await assert.rejects(run(bob,()=>routing.adminAdoptProjectCanvas(config.id!,b.id,{account_id:'acc_a',canvas_id:'103',confirmed:true})),/管理员/)
})
test('retrying an already-applied rename confirms the same name without reporting a false failure',async()=>{
  const p=addProject(alice.id,'Rename retry'),created=await run(alice,()=>routing.selectProjectExecution(config.id!,p.id,{account_id:'acc_a',mode:'new',canvas_name:'原名称',expected_route_id:null}))
  const body={account_id:'acc_a',canvas_id:created.current!.canvas_id,name:'新名称',expected_name:'原名称'}
  assert.equal((await run(alice,()=>routing.renameProjectCanvas(config.id!,p.id,body))).renamed,true)
  const same=await run(alice,()=>routing.renameProjectCanvas(config.id!,p.id,body))
  assert.equal(same.renamed,true);assert.equal(same.unchanged,true)
})
test('one full-feature grant replaces old account restrictions and unassigned history resumes after a lost key response',async()=>{
  accounts[0].projects.push({id:'104',name:'Unassigned old canvas'})
  await run(admin,()=>routing.saveExecutionAccountPolicies(config.id!,{policies:[]}))
  await run(admin,()=>routing.saveExecutionUserAccess(config.id!,{access:'selected',user_ids:[alice.id]}))
  const p=addProject(alice.id,'Full feature only'),view=await run(alice,()=>routing.projectExecutionOptions(config.id!,p.id))
  assert.equal(view.accounts.length,2)
  assert.ok(view.accounts[0].allow_create)
  assert.equal(view.accounts[0].canvases.find(canvas=>canvas.id==='104')!.history_unassigned,true)
  assert.equal((await run(bob,()=>routing.projectExecutionOptions(config.id!,b.id))).feature_allowed,false)
  const count=routes.length,createdCount=posts
  failNextKey=true
  await assert.rejects(run(alice,()=>routing.selectProjectExecution(config.id!,p.id,{account_id:'acc_a',mode:'existing',canvas_id:'104',expected_route_id:null})),/HTTP 502/)
  const pending=await run(alice,()=>routing.projectExecutionOptions(config.id!,p.id))
  assert.ok(pending.pending)
  assert.ok(pending.accounts[0].canvases.some(canvas=>canvas.id==='104'))
  const resumed=await run(alice,()=>routing.selectProjectExecution(config.id!,p.id,{account_id:'acc_a',mode:'existing',canvas_id:'104',expected_route_id:null}))
  assert.equal(resumed.current!.id,pending.pending!.id)
  assert.equal(routes.length,count+1);assert.equal(posts,createdCount)
  assert.equal(routes.find(route=>route.canvas_id==='104')!.adopt_legacy,true)
})
test('resuming a pre-upgrade unassigned selection enables safe legacy adoption without another reservation',async()=>{
  const p=addProject(alice.id,'Upgrade old pending choice')
  accounts[0].projects.push({id:'105',name:'Old pending canvas'})
  const id=Number(db.$client.prepare("INSERT INTO platform_jimeng_project_routes(drama_id,owner_id,server_origin,account_id,canvas_id,canvas_request_id,state,updated_at,version,is_current,remote_project_id,selection_mode,adopt_legacy) VALUES(?,?,?,?,?,?,'preparing',?,1,0,?,'existing',0)").run(p.id,alice.id,new URL(config.baseUrl).origin,'acc_a','105',randomUUID(),now,'project:'+p.id).lastInsertRowid)
  const chosen=await run(alice,()=>routing.selectProjectExecution(config.id!,p.id,{account_id:'acc_a',mode:'existing',canvas_id:'105',expected_route_id:null}))
  assert.equal(chosen.current!.id,id)
  assert.equal(routes.find(route=>route.canvas_id==='105')!.adopt_legacy,true)
})
