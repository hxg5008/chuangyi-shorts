import {test,after} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import {randomUUID} from 'node:crypto'
import {Hono} from 'hono'
import {serve} from '@hono/node-server'

const directory=await fs.mkdtemp(path.join(os.tmpdir(),'huobao-asset-image-jobs-'))
process.env.HUOBAO_DATA_DIR=directory;process.env.SQLITE_PATH=path.join(directory,'test.sqlite3');process.env.STORAGE_PATH=path.join(directory,'static');process.env.WORKSPACE_PATH=path.join(directory,'workspace');process.env.MYSQL_AUTO_IMPORT='false';process.env.HUOBAO_PROXY_URL='direct'
const {db,schema}=await import('../src/db/index.ts'),security=await import('../src/services/platform-security/index.ts')
security.initPlatformSecurity()
const preparation=await import('../src/services/asset-image-preparation.ts'),activity=await import('../src/services/activity/store.ts'),context=await import('../src/services/activity/context.ts')
const owner=security.createUser('prepare_owner','Prepare-owner-password').user,other=security.createUser('prepare_other','Prepare-other-password').user,at=new Date().toISOString()
const project=db.insert(schema.dramas).values({title:'Preparation',ownerUserId:owner.id,createdAt:at,updatedAt:at}).returning().get(),foreign=db.insert(schema.dramas).values({title:'Other',ownerUserId:other.id,createdAt:at,updatedAt:at}).returning().get()
const episode=db.insert(schema.episodes).values({dramaId:project.id,episodeNumber:1,title:'First',createdAt:at,updatedAt:at}).returning().get(),relatedEpisode=db.insert(schema.episodes).values({dramaId:project.id,episodeNumber:2,title:'Related',createdAt:at,updatedAt:at}).returning().get()
type Target={kind:'character'|'scene'|'prop';id:number}
function asset(kind:Target['kind']):Target{const common={dramaId:project.id,createdAt:at,updatedAt:at};let value:any;if(kind==='character'){value=db.insert(schema.characters).values({...common,name:'角色'+randomUUID()}).returning().get();db.insert(schema.episodeCharacters).values({episodeId:episode.id,characterId:value.id,createdAt:at}).run()}else if(kind==='scene'){value=db.insert(schema.scenes).values({...common,location:'场景'+randomUUID(),time:'日',prompt:'fixture existing scene'}).returning().get();db.insert(schema.episodeScenes).values({episodeId:episode.id,sceneId:value.id,createdAt:at}).run()}else{value=db.insert(schema.props).values({...common,name:'道具'+randomUUID()}).returning().get();db.insert(schema.episodeProps).values({episodeId:episode.id,propId:value.id,createdAt:at}).run()};return{kind,id:value.id}}
const targets=Array.from({length:8},(_,index)=>asset((['character','scene','prop']as const)[index%3]))
const releases=new Map<string,()=>void>(),counts=new Map<string,number>(),seenBodies=new Map<string,any>()
let active=0,maximumActive=0,imagePosts=0
const upstream=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));res.setHeader('content-type','application/json');if(req.url==='/v1/images/generations'){imagePosts++;return res.end(JSON.stringify({data:[{url:upstreamURL+'/unused.png'}]}))};const body=JSON.parse(Buffer.concat(chunks).toString()||'{}'),key=body.key;counts.set(key,(counts.get(key)||0)+1);seenBodies.set(key,body.body);if(body.body?.simulate_failure){res.statusCode=500;return res.end(JSON.stringify({error:'mock preparation failed once'}))};active++;maximumActive=Math.max(maximumActive,active);await new Promise<void>(resolve=>releases.set(key,resolve));active--;res.end('{}')})
await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));const upstreamURL='http://127.0.0.1:'+(upstream.address()as any).port
const plural=(target:Target)=>({character:'characters',scene:'scenes',prop:'props'}as const)[target.kind]
const keyOf=(target:Target)=>target.kind+':'+target.id
function baseApp(){const app=new Hono();app.use('/api/*',security.platformSecurityMiddleware);app.use('/api/*',context.activityRequestContext);return app}
const app=baseApp();app.route('/api/v1/auth',(await import('../src/routes/platform-auth.ts')).default);app.route('/api/v1/asset-image-jobs',(await import('../src/routes/asset-image-jobs.ts')).default);app.route('/api/v1/activity',(await import('../src/routes/activity.ts')).default);app.get('/api/v1/health',c=>c.json({status:'ok'}));app.get('/api/v1/tasks',c=>c.json({code:200,data:db.$client.prepare('SELECT * FROM sys_task').all()}))
for(const kind of ['character','scene','prop']as const){const routes=new Hono();routes.use('/:id/generate-image',preparation.assetImagePreparationMiddleware(kind,(url,init)=>routes.request(url,init)));routes.post('/:id/generate-image',async c=>{
 const id=Number(c.req.param('id')),body=await c.req.json(),current=context.currentActivity()!,actor=security.requireActor();assert.equal(actor.id,owner.id);assert(current.assetPreparationJobId);assert(current.abortSignal)
 const response=await fetch(upstreamURL+'/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:kind+':'+id,body}),signal:current.abortSignal});if(!response.ok)return c.json({code:400,message:'mock preparation failed once'},400)
 current.abortSignal?.throwIfAborted();const field=({character:'characterId',scene:'sceneId',prop:'propId'}as const)[kind]
 const task=db.insert(schema.sysTask).values({type:'image',provider:'fixture',dramaId:project.id,[field]:id,prompt:'unchanged fixture prompt',params:JSON.stringify({assetPreparationJobId:current.assetPreparationJobId}),status:'processing',stage:'queued',createdAt:at,updatedAt:at}).returning().get()
 activity.bindActivitySource(current.taskId!,'media',String(task.id));return c.json({code:200,data:{image_generation_id:task.id}})
 });app.route('/api/v1/'+plural({kind,id:0}),routes)}
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});if(!server.listening)await new Promise<void>(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+(server.address()as any).port
const agent=new http.Agent({keepAlive:true,maxSockets:6})
type Client={cookie:string;csrf:string}
async function call(method:string,url:string,body?:any,client?:Client,origin=base){const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));return await new Promise<{status:number;data:any}>((resolve,reject)=>{const request=http.request(origin+'/api/v1'+url,{method,agent,headers:{Origin:origin,...(client?{Cookie:client.cookie,'X-CSRF-Token':client.csrf}:{}),...(bytes?{'content-type':'application/json','content-length':bytes.length}:{})}},response=>{const parts=[];response.on('data',chunk=>parts.push(Buffer.from(chunk)));response.on('end',()=>{try{const raw=JSON.parse(Buffer.concat(parts).toString());if(url==='/auth/login')raw._cookie=response.headers['set-cookie']?.[0].split(';')[0];resolve({status:response.statusCode!,data:raw})}catch(error){reject(error)}})});request.on('error',reject);if(bytes)request.end(bytes);else request.end()})}
async function login(username:string,password:string){const result=await call('POST','/auth/login',{username,password});assert.equal(result.status,200);return{cookie:result.data._cookie,csrf:result.data.data.csrfToken}}
const client=await login('prepare_owner','Prepare-owner-password'),foreignClient=await login('prepare_other','Prepare-other-password')
async function until<T>(read:()=>T|Promise<T>,accept:(value:T)=>boolean,ms=5000){const deadline=Date.now()+ms;for(;;){const value=await read();if(accept(value))return value;assert(Date.now()<deadline,'preparation fixture did not settle');await new Promise(resolve=>setTimeout(resolve,10))}}
const getJob=async(id:string)=>(await call('GET','/asset-image-jobs/'+id,undefined,client)).data.data
const accepted:any[]=[]

test('eight slow prompt preparations release HTTP/1 browser slots immediately; health, tasks and durable job polling remain fast with SSE open',async()=>{
 activity.createActivityTask({kind:'image',title:'Existing event',projectId:project.id})
 const stream=await new Promise<{request:http.ClientRequest;response:http.IncomingMessage}>((resolve,reject)=>{const request=http.get(base+'/api/v1/activity/events?drama_id='+project.id,{agent,headers:{Cookie:client.cookie,Origin:base}},response=>{response.once('data',()=>resolve({request,response}));response.on('error',reject)});request.on('error',reject)})
 try{const body={async_prepare:true,episode_id:episode.id,model:'frozen-image-model',text_model:'frozen-text-model',model_parameters:{quality:'original'},text_model_parameters:{temperature:0.25}}
  const start=Date.now(),results=await Promise.all(targets.map(target=>call('POST',`/${plural(target)}/${target.id}/generate-image`,body,client)));assert(Date.now()-start<1500);for(const result of results){assert.equal(result.status,202);assert.equal(result.data.data.status,'preparing_prompt');accepted.push(result.data.data)}
  await until(()=>active,value=>value===8);assert.equal(maximumActive,8,'there is no new global 2/4 preparation limiter')
  for(const url of ['/health','/tasks','/asset-image-jobs?episode_id='+episode.id,'/activity/tasks?drama_id='+project.id]){const at=Date.now(),result=await call('GET',url,undefined,client);assert.equal(result.status,200);assert(Date.now()-at<1000,url+' stays responsive while eight prompt HTTP calls are waiting')}
  const duplicated=await call('POST',`/${plural(targets[0])}/${targets[0].id}/generate-image`,body,client);assert.equal(duplicated.data.data.asset_job_id,accepted[0].asset_job_id);assert.equal(duplicated.data.data.reused,true);assert.equal(counts.get(keyOf(targets[0])),1)
  assert.deepEqual(seenBodies.get(keyOf(targets[0])),{episode_id:episode.id,model:'frozen-image-model',text_model:'frozen-text-model',model_parameters:{quality:'original'},text_model_parameters:{temperature:0.25}},'the original body is frozen and only async_prepare is removed')
 }finally{stream.request.destroy();stream.response.destroy();for(const release of releases.values())release();releases.clear()}
 await until(async()=>Promise.all(accepted.map(row=>getJob(row.asset_job_id))),jobs=>jobs.every(job=>job.status==='completed'&&job.image_generation_id))
})

test('duplicate submission and page reload reuse the whole active image cycle, with related-episode and project-level discovery',async()=>{
 const target=targets[0],before=counts.get(keyOf(target)),duplicate=await call('POST',`/${plural(target)}/${target.id}/generate-image`,{async_prepare:true,episode_id:episode.id},client),job=await getJob(accepted[0].asset_job_id)
 assert.equal(duplicate.data.data.asset_job_id,job.id);assert.equal(counts.get(keyOf(target)),before);assert.equal(job.active,true);assert.equal(job.image_generation_status,'processing')
 db.insert(schema.episodeCharacters).values({episodeId:relatedEpisode.id,characterId:target.id,createdAt:at}).run()
 assert((await call('GET','/asset-image-jobs?episode_id='+relatedEpisode.id,undefined,client)).data.data.items.some((row:any)=>row.id===job.id));assert((await call('GET','/asset-image-jobs?project_id='+project.id,undefined,client)).data.data.items.some((row:any)=>row.id===job.id))
 db.$client.prepare("UPDATE sys_task SET status='completed' WHERE id=?").run(job.image_generation_id)
 const next=await call('POST',`/${plural(target)}/${target.id}/generate-image`,{async_prepare:true,episode_id:episode.id},client);assert.notEqual(next.data.data.asset_job_id,job.id);await until(()=>counts.get(keyOf(target)),count=>count===Number(before)+1);releases.get(keyOf(target))!();await until(()=>getJob(next.data.data.asset_job_id),value=>value.status==='completed')
})

test('a preparation failure is visible and polling never retries the prompt; other owners cannot read jobs or enqueue foreign assets',async()=>{
 const target=asset('prop'),result=await call('POST',`/props/${target.id}/generate-image`,{async_prepare:true,episode_id:episode.id,simulate_failure:true},client),job=await until(()=>getJob(result.data.data.asset_job_id),value=>value.status==='failed')
 assert.equal(job.error,'mock preparation failed once');assert.equal(job.error_code,'preparation_failed');for(let index=0;index<3;index++)await getJob(job.id);assert.equal(counts.get(keyOf(target)),1)
 assert.equal((await call('GET','/asset-image-jobs/'+job.id,undefined,foreignClient)).status,404);assert.equal((await call('GET','/asset-image-jobs?project_id='+project.id,undefined,foreignClient)).status,404);assert.equal((await call('POST',`/props/${target.id}/generate-image`,{async_prepare:true,episode_id:episode.id},foreignClient)).status,404);assert.equal((await call('GET','/asset-image-jobs/'+job.id)).status,401)
})

test('startup recovery interrupts preparation without a task anchor and adopts an existing image task without any new HTTP POST',async()=>{
 const before=[...counts.values()].reduce((a,b)=>a+b,0),one=asset('character'),two=asset('character')
 const insert=(target:Target)=>{const id=randomUUID(),log=activity.createActivityTask({kind:'image',title:'Restart fixture',projectId:project.id});db.$client.prepare("INSERT INTO platform_asset_image_jobs(id,asset_kind,asset_id,project_id,episode_id,user_id,status,activity_task_id,request_json,created_at,updated_at)VALUES(?,?,?,?,?,?,'preparing_prompt',?,'{}',?,?)").run(id,target.kind,target.id,project.id,episode.id,owner.id,log,at,at);return id}
 const missing=insert(one),anchored=insert(two),task=db.insert(schema.sysTask).values({type:'image',dramaId:project.id,characterId:two.id,params:JSON.stringify({assetPreparationJobId:anchored}),status:'processing',createdAt:at,updatedAt:at}).returning().get()
 const result=preparation.recoverAssetImagePreparationJobs();assert.equal(result.interrupted,1);assert.equal(result.linked,1);assert.equal((await getJob(missing)).status,'interrupted');assert.equal((await getJob(anchored)).image_generation_id,task.id);preparation.recoverAssetImagePreparationJobs();assert.equal([...counts.values()].reduce((a,b)=>a+b,0),before)
})

test('the actual final-prompt route receives the deadline signal and a late model result cannot fall back into a newly billed image',async()=>{
 const target=asset('character'),realRoute=(await import('../src/routes/characters.ts')).default,{mastra}=await import('../src/mastra/index.ts'),originalGetAgent=mastra.getAgent
 const imageConfig=db.insert(schema.aiServiceConfigs).values({serviceType:'image',provider:'openai',name:'Synthetic image only',baseUrl:upstreamURL,apiKey:'synthetic-preparation-key',model:'["synthetic-image"]',isActive:true,createdAt:at,updatedAt:at}).returning().get()
 let received:AbortSignal|undefined,calls=0
 ;(mastra as any).getAgent=()=>({
  id:'prompt_generator',
  stream:async(_messages:any[],options:any)=>{
   calls++;received=options.abortSignal
   return {getFullOutput:async()=>{
    await fetch(upstreamURL+'/late-prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:'actual-late',body:{}})})
    return {text:'late result ignored',toolCalls:[],toolResults:[]}
   }}
  }
 })
 const outer=new Hono();outer.use('/:id/generate-image',preparation.assetImagePreparationMiddleware('character',(url,init)=>realRoute.request(url,init),{timeoutMs:50}));outer.post('/:id/generate-image',c=>c.json({error:'marker should have been intercepted'},500));const timeoutApp=baseApp();timeoutApp.route('/api/v1/characters',outer)
 const timeoutServer=serve({fetch:timeoutApp.fetch,hostname:'127.0.0.1',port:0});if(!timeoutServer.listening)await new Promise<void>(resolve=>timeoutServer.once('listening',resolve));const timeoutBase='http://127.0.0.1:'+(timeoutServer.address()as any).port,beforeImages=imagePosts
 try{const result=await call('POST',`/characters/${target.id}/generate-image`,{async_prepare:true,episode_id:episode.id,config_id:imageConfig.id,model:'synthetic-image'},client,timeoutBase),job=await until(()=>getJob(result.data.data.asset_job_id),value=>value.status==='failed');assert.equal(job.error_code,'preparation_timeout');assert(received);assert.equal(received!.aborted,true);assert.equal(calls,1);await until(()=>releases.has('actual-late'),Boolean);releases.get('actual-late')!();await new Promise(resolve=>setTimeout(resolve,100));assert.equal(imagePosts,beforeImages);assert.equal((db.$client.prepare("SELECT count(*) n FROM sys_task WHERE character_id=?").get(target.id)as any).n,0);assert.equal((await getJob(job.id)).status,'failed')}
 finally{(mastra as any).getAgent=originalGetAgent;timeoutServer.closeAllConnections();await new Promise<void>(resolve=>timeoutServer.close(()=>resolve()))}
})

after(async()=>{for(const release of releases.values())release();agent.destroy();server.closeAllConnections();upstream.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));db.$client.close();const target=path.resolve(directory),relative=path.relative(path.resolve(os.tmpdir()),target);assert(relative&&!path.isAbsolute(relative)&&!relative.startsWith('..')&&path.basename(target).startsWith('huobao-asset-image-jobs-'));await fs.rm(target,{recursive:true,force:true,maxRetries:3})})
