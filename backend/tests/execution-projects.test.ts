import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cy-project-routes-'))
process.env.HUOBAO_DATA_DIR=temporary;process.env.SQLITE_PATH=path.join(temporary,'test.sqlite3');process.env.STORAGE_PATH=path.join(temporary,'static');process.env.MYSQL_AUTO_IMPORT='false';process.env.HUOBAO_PROXY_URL='direct'
const {db,schema}=await import('../src/db/index.ts')
const security=await import('../src/services/platform-security/index.ts')
const routing=await import('../src/services/execution-projects.ts')
const {getModelChannelStore}=await import('../src/services/model-channels/store.ts')
const {getConfigById}=await import('../src/services/ai.ts')
security.initPlatformSecurity()
const admin=security.listUsers().find(user=>user.role==='admin')!,owner=security.createUser('project-owner','test-password').user,other=security.createUser('other-owner','test-password').user
const at=new Date().toISOString(),project=db.insert(schema.dramas).values({title:'Project A',ownerUserId:owner.id,createdAt:at,updatedAt:at}).returning().get()
let canvasPosts=0,keyPosts=0,routePosts=0,capable=true,firstCanvasLost=false
const routes:any[]=[],canvases=new Map<string,any>()
const master='test-master-only',projectKey='sk-cy-route-test-private'
const server=http.createServer(async(req,res)=>{
  let body='';for await(const part of req)body+=part
  assert.equal(req.headers.authorization,'Bearer '+master)
  const value=body?JSON.parse(body):{},url=req.url!
  res.setHeader('Content-Type','application/json')
  if(url==='/health')return res.end(JSON.stringify({capabilities:capable?{project_routes:true,scoped_canvas_library:true,scoped_downloads:true,canvas_create_idempotent:true}:{}}))
  if(url==='/hub/jimeng/accounts')return res.end(JSON.stringify({accounts:[{id:'acc_one',name:'Test account',state:'ready',projects:[]},{id:'acc_two',name:'Second',state:'ready',projects:[]}]}))
  if(url.endsWith('/canvases')){
    canvasPosts++;assert.equal(value.select,false)
    if(!canvases.has(value.client_request_id))canvases.set(value.client_request_id,{id:'242000'+canvases.size,name:value.name,account_id:'acc_one',selected:false,client_request_id:value.client_request_id})
    if(firstCanvasLost){firstCanvasLost=false;res.statusCode=502;return res.end('{}')}
    return res.end(JSON.stringify(canvases.get(value.client_request_id)))
  }
  if(url==='/hub/jimeng/routes'&&req.method==='GET')return res.end(JSON.stringify({routes}))
  if(url==='/hub/jimeng/routes'&&req.method==='POST'){routePosts++;const route={...value,id:'rt_'+randomUUID().replaceAll('-',''),enabled:true};routes.push(route);res.statusCode=201;return res.end(JSON.stringify(route))}
  if(url.endsWith('/key')){keyPosts++;return res.end(JSON.stringify({route_id:url.split('/').at(-2),key:projectKey}))}
  const route=routes.find(row=>url==='/hub/jimeng/routes/'+row.id)
  if(route&&req.method==='GET')return res.end(JSON.stringify(route))
  res.statusCode=404;res.end('{}')
})
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
const baseUrl='http://127.0.0.1:'+(server.address() as any).port
const store=getModelChannelStore(),channel=store.saveChannel({name:'Test execution',base_url:baseUrl,api_key:master}),binding=store.saveBinding(channel.id,{name:'Jimeng',model:'jimeng-2.0-fast',type:'video',protocol_id:'video.jimeng-local',enabled:true})
const config=(await security.runAsActor(owner,()=>getConfigById(binding.config_id)))!
after(async()=>{server.close();db.$client.close();await fs.rm(temporary,{recursive:true,force:true})})

test('legacy configuration is unchanged until an administrator opts it into project isolation',async()=>{
  const value=await security.runAsActor(owner,()=>routing.resolveJimengProjectConfig(config,project.id))
  assert.equal(value.apiKey,master);assert.equal(canvasPosts,0)
})
test('ordinary users cannot configure credentials, accounts or another project',async()=>{
  await assert.rejects(security.runAsActor(owner,()=>routing.saveExecutionService(config.id!,{account_id:'acc_one',enabled:true})),/管理员/u)
  const foreign=db.insert(schema.dramas).values({title:'Other',ownerUserId:other.id,createdAt:at,updatedAt:at}).returning().get()
  assert.throws(()=>security.runAsActor(owner,()=>routing.projectExecutionStatus(foreign.id)),/权限/u)
})
test('enable checks full return capabilities before creating or using any canvas',async()=>{
  capable=false
  await assert.rejects(security.runAsActor(admin,()=>routing.saveExecutionService(config.id!,{account_id:'acc_one',enabled:true})),/更新/u)
  assert.equal(canvasPosts,0)
  capable=true
  await security.runAsActor(admin,()=>routing.saveExecutionService(config.id!,{account_id:'acc_one',enabled:true}))
})
let scoped:any
test('concurrent first requests share one canvas and route, with server-derived identity and an encrypted project Key',async()=>{
  const values=await security.runAsActor(owner,()=>Promise.all(Array.from({length:6},()=>routing.resolveJimengProjectConfig(config,project.id))))
  scoped=values[0];assert.equal(canvasPosts,1);assert.equal(keyPosts,1);assert.equal(routePosts,1)
  assert.ok(values.every(value=>value.executionRouteId===scoped.executionRouteId&&value.apiKey===projectKey))
  assert.equal(routes[0].project_id,'project:'+project.id);assert.match(routes[0].owner_id,new RegExp(':user:'+owner.id+'$'))
  const row=db.$client.prepare('SELECT * FROM platform_jimeng_project_routes WHERE id=?').get(scoped.executionProjectRouteId) as any
  assert.ok(row.key_blob);assert.ok(!JSON.stringify(row).includes(projectKey))
  const publicStatus=security.runAsActor(owner,()=>routing.projectExecutionStatus(project.id))
  assert.ok(!JSON.stringify(publicStatus).includes(projectKey));assert.ok(!JSON.stringify(publicStatus).includes(master));assert.ok(!JSON.stringify(publicStatus).includes('account_id'))
})
test('recovery follows the original binding; changing the default account never moves an existing project',async()=>{
  const snapshot={id:scoped.executionProjectRouteId,routeId:scoped.executionRouteId}
  const restored=security.runAsActor(owner,()=>routing.restoreJimengProjectConfig(config,snapshot,project.id))
  assert.equal(restored.apiKey,projectKey)
  assert.throws(()=>security.runAsActor(owner,()=>routing.restoreJimengProjectConfig(config,{...snapshot,routeId:'rt_'+'f'.repeat(32)},project.id)),/不一致/u)
  await security.runAsActor(admin,()=>routing.saveExecutionService(config.id!,{account_id:'acc_two',enabled:true}))
  const stillOriginal=await security.runAsActor(owner,()=>routing.resolveJimengProjectConfig(config,project.id))
  assert.equal(stillOriginal.executionRouteId,scoped.executionRouteId)
  assert.equal(routes[0].account_id,'acc_one')
  assert.equal(canvasPosts,1)
  await security.runAsActor(admin,()=>routing.saveExecutionService(config.id!,{account_id:'acc_one',enabled:true}))
})
test('a lost canvas answer keeps its durable request id and does not create a second canvas on reconciliation',async()=>{
  const second=db.insert(schema.dramas).values({title:'Pending',ownerUserId:owner.id,createdAt:at,updatedAt:at}).returning().get()
  firstCanvasLost=true
  await assert.rejects(security.runAsActor(owner,()=>routing.resolveJimengProjectConfig(config,second.id)),/HTTP 502/u)
  assert.equal(canvases.size,2)
  const recovered=await security.runAsActor(owner,()=>routing.resolveJimengProjectConfig(config,second.id))
  assert.ok(recovered.executionRouteId);assert.equal(canvases.size,2)
  assert.equal(keyPosts,2)
})
