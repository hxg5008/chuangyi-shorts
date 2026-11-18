import {test,after} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {Hono} from 'hono'
import sharp from 'sharp'

const root=await fs.mkdtemp(path.join(os.tmpdir(),'huobao-platform-security-'))
process.env.HUOBAO_DATA_DIR=root
process.env.SQLITE_PATH=path.join(root,'test.sqlite3')
process.env.STORAGE_PATH=path.join(root,'static')
process.env.MYSQL_AUTO_IMPORT='false'
process.env.PUBLIC_BASE_URL='http://workbench.test'
const {db,schema}=await import('../src/db/index.ts')
const at=new Date().toISOString()
const legacy=db.insert(schema.dramas).values({title:'Legacy preserved',createdAt:at,updatedAt:at}).returning().get()
const security=await import('../src/services/platform-security/index.ts')
security.initPlatformSecurity()
const auth=(await import('../src/routes/platform-auth.ts')).default
const users=(await import('../src/routes/platform-users.ts')).default
const dramas=(await import('../src/routes/dramas.ts')).default
const upload=(await import('../src/routes/upload.ts')).default
const app=new Hono()
app.use('/api/*',security.platformSecurityMiddleware)
app.route('/api/v1/auth',auth)
app.route('/api/v1/admin/users',users)
app.route('/api/v1/dramas',dramas)
app.route('/api/v1/upload',upload)
let writes=0
app.get('/api/v1/tasks',c=>c.json({code:200,data:db.$client.prepare('SELECT * FROM sys_task').all()}))
app.get('/api/v1/tasks/:id',c=>c.json({code:200,data:db.$client.prepare('SELECT * FROM sys_task WHERE id=?').get(c.req.param('id'))}))
app.post('/api/v1/tasks/:id/recover',c=>{writes++;return c.json({code:200,data:{restored:true}})})
app.post('/api/v1/tasks',c=>{writes++;return c.json({code:201,data:{id:999}},201)})
app.post('/api/v1/storyboards',c=>{writes++;return c.json({code:201,data:{id:999}},201)})
app.get('/api/v1/agent/jobs/:id',c=>c.json({code:200,data:{id:c.req.param('id')}}))
app.get('/api/v1/ai-configs',c=>c.json({code:200,data:[{id:10,provider:'openai',model:['test-model'],is_active:true,api_key:'synthetic-private-channel-key',base_url:'https://example.invalid/private',capabilities:{image:true}},{id:99,is_active:true,api_key:'another-test-secret'},{id:11,is_active:false,api_key:'disabled'}]}))
app.get('/api/v1/models',c=>c.json({code:200,data:[{id:10,name:'Published image',type:'image'}]}))
app.post('/api/v1/ai-configs',c=>{writes++;return c.json({code:201},201)})
app.put('/api/v1/skills/test',c=>{writes++;return c.json({code:200})})
app.post('/api/v1/server-update/apply',c=>{writes++;return c.json({code:200})})
app.use('/static/*',security.privateMediaMiddleware)
app.get('/static/*',async c=>{const file=path.join(root,c.req.path);return c.body(await fs.readFile(file))})
security.registerModelAccessGuard((id,actor)=>{if(actor.role==='user'&&id===99)throw security.denied('模型未授权')})

interface Client {cookie:string;csrfToken:string;user:security.Actor}
async function call(method:string,url:string,client?:Client,body?:any,headers:Record<string,string>={}){
  const actual=new Headers({Origin:'http://workbench.test',...headers})
  if(client){actual.set('Cookie',client.cookie);if(!actual.has('X-CSRF-Token'))actual.set('X-CSRF-Token',client.csrfToken)}
  if(body!==undefined&&!(body instanceof FormData))actual.set('Content-Type','application/json')
  return app.request('http://workbench.test'+url,{method,headers:actual,...(body===undefined?{}:{body:body instanceof FormData?body:JSON.stringify(body)})})
}
async function login(username:string,password:string):Promise<Client>{const response=await call('POST','/api/v1/auth/login',undefined,{username,password});assert.equal(response.status,200);const body:any=await response.json();return{cookie:response.headers.get('set-cookie')!.split(';')[0],csrfToken:body.data.csrfToken,user:body.data.user}}
const initial=await fs.readFile(path.join(root,'admin-initial-password.txt'),'utf8')
const adminPassword=/Initial password: ([^\r\n]+)/u.exec(initial)![1]
const admin=await login('admin',adminPassword)
const aliceUser=security.createUser('creator_a','Test-user-a-password')
const bobUser=security.createUser('creator_b','Test-user-b-password')
let alice=await login('creator_a','Test-user-a-password'),bob=await login('creator_b','Test-user-b-password')
const projectA:any=(await(await call('POST','/api/v1/dramas',alice,{title:'A private project'})).json() as any).data
const projectB:any=(await(await call('POST','/api/v1/dramas',bob,{title:'B private project'})).json() as any).data
const episodeA=db.insert(schema.episodes).values({dramaId:projectA.id,episodeNumber:1,title:'A1',createdAt:at,updatedAt:at}).returning().get()
const episodeB=db.insert(schema.episodes).values({dramaId:projectB.id,episodeNumber:1,title:'B1',createdAt:at,updatedAt:at}).returning().get()
const charA=db.insert(schema.characters).values({dramaId:projectA.id,name:'A person',createdAt:at,updatedAt:at}).returning().get()
const charB=db.insert(schema.characters).values({dramaId:projectB.id,name:'B person',createdAt:at,updatedAt:at}).returning().get()
const taskA=db.insert(schema.sysTask).values({type:'image',dramaId:projectA.id,status:'failed',params:JSON.stringify({size:'1024x1024',protocolSnapshot:{headers:{secret:'synthetic-hidden-protocol'}},configBaseUrl:'https://private-channel.invalid'}),createdAt:at,updatedAt:at}).returning().get()
const taskB=db.insert(schema.sysTask).values({type:'image',characterId:charB.id,status:'failed',createdAt:at,updatedAt:at}).returning().get()

test('bootstrap is private, preserves old projects, and does not allow anonymous public API access',async()=>{
  assert(adminPassword.length>=20)
  assert.equal((db.$client.prepare('SELECT owner_user_id FROM dramas WHERE id=?').get(legacy.id) as any).owner_user_id,admin.user.id)
  assert.equal((await call('GET','/api/v1/dramas')).status,401)
  assert.equal((await call('POST','/api/v1/admin/users',undefined,{username:'attacker',password:'password-of-attacker'})).status,401)
  const me=await call('GET','/api/v1/auth/me',alice),value:any=await me.json()
  assert.equal(value.data.user.id,aliceUser.user.id);assert.equal(value.data.user.role,'user');assert(value.data.csrfToken)
  assert(!JSON.stringify(value).includes('password_hash'));assert(!JSON.stringify(value).includes(adminPassword))
})

test('project lists and stats are scoped, and changing IDs cannot read, update or delete another user project',async()=>{
  const data:any=(await(await call('GET','/api/v1/dramas',alice)).json() as any).data
  assert.deepEqual(data.items.map((x:any)=>x.id),[projectA.id]);assert.equal(data.pagination.total,1)
  const stats:any=await(await call('GET','/api/v1/dramas/stats',alice)).json();assert.equal(stats.data.total,1)
  for(const method of ['GET','PUT','DELETE'])assert.equal((await call(method,'/api/v1/dramas/'+projectB.id,alice,method==='PUT'?{title:'forged'}:undefined)).status,404)
  for(const encoded of [`0${projectB.id}`,`${projectB.id}e0`,`+${projectB.id}`,`${projectB.id}.0`,`0x${projectB.id.toString(16)}`])assert.equal((await call('GET','/api/v1/dramas/'+encoded,alice)).status,400)
  assert.equal((await call('GET','/api/v1/dramas/'+projectB.id,admin)).status,200)
  assert.equal((await call('POST','/api/v1/dramas',alice,{title:'forged owner',owner_user_id:bob.user.id})).status,403)
})

test('mixed batch IDs and forged model-tool asset IDs are rejected before any write',async()=>{
  const before=writes
  assert.equal((await call('PUT',`/api/v1/dramas/${projectA.id}/characters`,alice,{characters:[{id:charB.id,name:'cross-user mutation'}]})).status,403)
  assert.equal((await call('POST','/api/v1/storyboards',alice,{drama_id:projectA.id,episode_id:episodeA.id,character_ids:[charA.id,charB.id]})).status,404)
  for(const contentType of ['text/plain','multipart/form-data; boundary=forged','application/x-www-form-urlencoded']){
    const response=await app.request(`http://workbench.test/api/v1/dramas/${projectA.id}/characters`,{method:'PUT',headers:{Origin:'http://workbench.test',Cookie:alice.cookie,'X-CSRF-Token':alice.csrfToken,'Content-Type':contentType},body:JSON.stringify({characters:[{id:charB.id,name:'forged content type'}]})})
    assert.equal(response.status,403)
  }
  const tool={id:'unchanged-tool',inputSchema:{original:true},execute:async()=>{writes++;return'ok'}}
  const guarded=security.secureAgentTools({probe:tool}).probe
  assert.equal(guarded.inputSchema,tool.inputSchema)
  const rc={get:(key:string)=>({dramaId:projectA.id,episodeId:episodeA.id,actorId:alice.user.id} as any)[key]}
  await assert.rejects(security.runAsActor(alice.user,()=>guarded.execute({character_id:charB.id} as any,{requestContext:rc} as any)),/当前项目/u)
  const forged={get:(key:string)=>({dramaId:projectB.id,episodeId:episodeB.id,actorId:bob.user.id} as any)[key]}
  await assert.rejects(security.runAsActor(alice.user,()=>guarded.execute({} as any,{requestContext:forged} as any)),/项目不存在/u)
  assert.equal(writes,before)
})

test('task list, diagnostics and recovery follow project ownership including inferred character ownership',async()=>{
  assert.equal((await call('POST','/api/v1/tasks',alice,{character_id:charA.id})).status,201)
  const data:any=await(await call('GET','/api/v1/tasks',alice)).json();assert.deepEqual(data.data.map((x:any)=>x.id),[taskA.id])
  const publicParams=JSON.parse(data.data[0].params);assert.deepEqual(publicParams,{size:'1024x1024'})
  const stored:any=db.$client.prepare('SELECT params FROM sys_task WHERE id=?').get(taskA.id);assert(stored.params.includes('synthetic-hidden-protocol'))
  const adminParams:any=await(await call('GET','/api/v1/tasks/'+taskA.id,admin)).json();assert(adminParams.data.params.includes('synthetic-hidden-protocol'))
  assert.equal((await call('GET','/api/v1/tasks/'+taskB.id,alice)).status,404)
  assert.equal((await call('POST',`/api/v1/tasks/${taskB.id}/recover`,alice,{})).status,404)
  assert.equal((await call('POST',`/api/v1/tasks/${taskA.id}/recover`,alice,{})).status,200)
})

test('shared channel credentials and unauthorized model bindings are not exposed or callable by creators',async()=>{
  assert.equal((await call('GET','/api/v1/models',alice)).status,200)
  const response=await call('GET','/api/v1/ai-configs',alice),text=await response.text(),data=JSON.parse(text)
  assert.deepEqual(data.data.map((x:any)=>x.id),[10]);assert.deepEqual(data.data[0].capabilities,{image:true})
  assert.doesNotMatch(text,/synthetic-private|another-test|api_key|base_url|private-channel/u)
  assert.equal((await call('POST','/api/v1/ai-configs',alice,{provider:'openai'})).status,403)
  assert.equal((await call('POST','/api/v1/tasks',alice,{drama_id:projectA.id,config_id:'99'})).status,403)
  assert.equal((await call('POST','/api/v1/tasks',alice,{drama_id:projectA.id,imageConfigId:99})).status,403)
  assert.equal((await call('POST','/api/v1/tasks',alice,{drama_id:projectA.id,config_id:99,prompt:'test'})).status,403)
  assert.equal((await call('POST','/api/v1/tasks',alice,{drama_id:projectA.id,base_url:'http://127.0.0.1:1'})).status,403)
  assert.equal((await call('PUT','/api/v1/skills/test',alice,{content:'forged'})).status,403)
  assert.equal((await call('POST','/api/v1/server-update/apply',alice,{})).status,403)
})

test('CSRF and cross-origin writes fail, HTTPS public origin with a port remains supported',async()=>{
  assert.equal((await call('POST','/api/v1/tasks',alice,{drama_id:projectA.id},{'X-CSRF-Token':'wrong'})).status,403)
  assert.equal((await call('POST','/api/v1/auth/login',undefined,{username:'creator_a',password:'Test-user-a-password'},{Origin:'https://evil.invalid'})).status,403)
  process.env.HUOBAO_PUBLIC_ORIGIN='https://public.example.invalid:5238'
  const response=await call('POST','/api/v1/auth/login',undefined,{username:'creator_a',password:'Test-user-a-password'},{Origin:process.env.HUOBAO_PUBLIC_ORIGIN})
  assert.equal(response.status,200);assert.match(response.headers.get('set-cookie')!,/Secure/u)
  delete process.env.HUOBAO_PUBLIC_ORIGIN
})

let privateImage=''
test('uploaded private images and thumbnails cannot be read by another user, while scoped provider signatures work',async()=>{
  const png=await sharp({create:{width:3,height:2,channels:3,background:'#556677'}}).png().toBuffer()
  const form=new FormData();form.append('file',new File([png],'probe.png',{type:'image/png'}))
  const response=await call('POST','/api/v1/upload/image',alice,form,{'X-Project-ID':String(projectA.id)});assert.equal(response.status,200)
  const body:any=await response.json();privateImage=body.data.path
  const own=await call('GET','/'+privateImage,alice);assert.equal(own.status,200);assert.equal(own.headers.get('cache-control'),'private, no-store');assert.equal(own.headers.get('x-content-type-options'),'nosniff')
  assert.deepEqual(Buffer.from(await own.arrayBuffer()),png)
  assert.equal((await call('GET','/'+privateImage,bob)).status,404)
  assert.equal((await call('GET','/'+privateImage)).status,401)
  const thumbnail=privateImage.replace(/\.png$/u,'_thumb.webp');assert.equal((await call('GET','/'+thumbnail,alice)).status,200);assert.equal((await call('GET','/'+thumbnail,bob)).status,404)
  const signed=security.runAsActor(alice.user,()=>security.signedProviderMediaUrl(privateImage))
  const result=await app.request(signed);assert.equal(result.status,200)
  const expired=new URL(signed);expired.searchParams.set('exp','1000000000');assert.equal((await app.request(expired)).status,401)
  const swapped=new URL(signed);swapped.pathname=swapped.pathname.replace(/[^/]+$/u,'missing.png');assert.equal((await app.request(swapped)).status,401)
})

test('creator media references cannot expose another user file or arbitrary internal/network files',async()=>{
  assert.throws(()=>security.normalizePrivateMediaPath('static/uploads/%2e%2e%2fprivate.png'),/路径/u)
  const owned=await call('POST','/api/v1/tasks',alice,{drama_id:projectA.id,reference_image_urls:[privateImage]});assert.equal(owned.status,201)
  for(const source of [privateImage,'http://169.254.169.254/latest/meta-data','http://127.0.0.1:5679/static/hidden.png','https://unowned.example.invalid/image.png','C:\\Windows\\win.ini','../../secret.png']){
    const response=await call('POST','/api/v1/tasks',bob,{drama_id:projectB.id,reference_image_urls:[source]});assert([400,403,404].includes(response.status),source)
  }
  for(const alternate of [{images:[privateImage]},{input:{media:[{type:'reference_image',url:privateImage}]}},{input:{media:[{type:'reference_video',url:'http://169.254.169.254/latest/meta-data'}]}}]){
    const response=await call('POST','/api/v1/tasks',bob,{drama_id:projectB.id,...alternate});assert([400,403,404].includes(response.status),'nested or alias media reference')
  }
  const form=new FormData();form.append('file',new File(['<svg onload="alert(1)"/>'],'fake.png',{type:'image/png'}));assert.equal((await call('POST','/api/v1/upload/image',alice,form)).status,400)
})

test('administrator manages independent users; logout and disabling invalidate live session authentication',async()=>{
  assert.equal((await call('GET','/api/v1/admin/users',alice)).status,403)
  const created=await call('POST','/api/v1/admin/users',admin,{username:'creator_c'});assert.equal(created.status,201);const body:any=await created.json();assert(body.data.temporary_password.length>=10);assert.equal(body.data.user.role,'user')
  assert.equal((await call('POST','/api/v1/admin/users',admin,{username:'forged_admin',role:'admin'})).status,400)
  const request=new Request('http://workbench.test/api/v1/activity/events',{headers:{Cookie:bob.cookie}})
  assert.equal(security.authenticateRequest(request)?.id,bob.user.id)
  assert.equal((await call('PUT','/api/v1/admin/users/'+bob.user.id,admin,{enabled:false})).status,200)
  assert.equal(security.authenticateRequest(request),null);assert.equal((await call('GET','/api/v1/dramas',bob)).status,401)
  assert.equal((await call('POST','/api/v1/auth/change-password',alice,{current_password:'Test-user-a-password'})).status,400)
  const old=alice.cookie,changed=await call('POST','/api/v1/auth/change-password',alice,{current_password:'Test-user-a-password',new_password:'New-user-a-password'});assert.equal(changed.status,200)
  assert.equal(security.authenticateRequest(new Request('http://workbench.test',{headers:{Cookie:old}})),null)
  const updated:any=await changed.json();alice={cookie:changed.headers.get('set-cookie')!.split(';')[0],csrfToken:updated.data.csrfToken,user:updated.data.user}
  assert.equal((await call('POST','/api/v1/auth/logout',alice,{})).status,200);assert.equal(security.authenticateRequest(new Request('http://workbench.test',{headers:{Cookie:alice.cookie}})),null)
})

after(async()=>{db.$client.close();const target=path.resolve(root),relative=path.relative(os.tmpdir(),target);assert(relative&&!path.isAbsolute(relative)&&!relative.startsWith('..')&&path.basename(target).startsWith('huobao-platform-security-'));await fs.rm(target,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
