import {test,after} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'

const root=await fs.mkdtemp(path.join(os.tmpdir(),'huobao-provider-runtime-'))
process.env.HUOBAO_DATA_DIR=root;process.env.SQLITE_PATH=path.join(root,'fixture.sqlite3');process.env.STORAGE_PATH=path.join(root,'static');process.env.MYSQL_AUTO_IMPORT='false';process.env.HUOBAO_PROXY_URL='direct'
const runtime=await import('../src/services/provider-runtime/index.ts')
const {db}=await import('../src/db/index.ts')
const prompt='必须原文：仙女🦋 @母亲站在A(X+0.8米，Y0)\n0〜3秒：不改动。'
const plugin=(provider:any)=>({manifest:{apiVersion:'yingce.plugin/v2',id:'runtime-fixture',version:'1.0.0',name:'Runtime Fixture',contributes:{providers:[{id:'runtime-fixture',label:'Runtime Fixture',capabilities:['video'],scopes:['creation'],...provider}]}},providerId:'runtime-fixture'})
const connection={baseUrl:'https://provider.example.test/v1',apiKey:'sk-runtime-synthetic-key'}
const request={capability:'video' as const,model:'exact/model-id',prompt,duration:15,aspectRatio:'16:9',images:[{id:'parent-001',role:'reference_image',name:'母版人物',kind:'image',dataUrl:'data:image/png;base64,aGVsbG8='},{id:'look-002',role:'first_frame',name:'服装图',kind:'image',dataUrl:'data:image/png;base64,d29ybGQ='}]}
const create={method:'POST',path:'/v1/tasks',contentType:'application/json',body:{model:{$ref:'request.model'},prompt:{$ref:'request.prompt'},images:{$map:{from:{$ref:'request.images'},as:'image',in:{id:{$ref:'image.id'},role:{$ref:'image.role'},data:{$ref:'image.value'}}}},ratio:{$ref:'request.aspectRatio'},seconds:{$ref:'request.duration'}}}

test('bundled Go interpreter starts without a Go runtime, validates true v2 expressions and retains prompt/media IDs and roles',async()=>{
 const def=plugin({auth:{type:'bearer'},create,response:{taskIdPaths:['task.id'],statusPaths:['task.status']}})
 const info=await runtime.compileProvider(def);assert.equal(info.executable,true,info.reason);assert.equal(info.metadata.id,'runtime-fixture')
 const built=await runtime.buildCreate({providerDefinition:def,connection,request});assert.equal(built.url,'https://provider.example.test/v1/tasks');assert.equal(built.headers.authorization,'Bearer '+connection.apiKey)
 const body=JSON.parse(built.body as string);assert.equal(body.prompt,prompt);assert.equal(body.model,request.model);assert.deepEqual(body.images.map((x:any)=>[x.id,x.role]),request.images.map(x=>[x.id,x.role]));assert.equal(body.seconds,15)
 assert(!JSON.stringify(built.wireSummary).includes(connection.apiKey));assert.equal((await runtime.providerCatalog()).length>=10,true)
 const invalid=plugin({create:{...create,path:'https://untrusted.example/tasks'},response:{}});assert.equal((await runtime.compileProvider(invalid)).executable,false)
})

test('buildAgent/parseAgent preserve real system, tool history and schema while excluding hidden reasoning',async()=>{
 const def=plugin({capabilities:['text'],create:{method:'POST',path:'/v1/messages'},agent:{method:'POST',path:'/v1/messages',body:{model:{$ref:'request.model'},messages:{$ref:'request.extra.agent.chatCompletion.messages'},tools:{$ref:'request.extra.agent.chatCompletion.tools'},response_format:{$ref:'request.extra.agent.chatCompletion.response_format'}}},agentResponse:{textPaths:['choices.0.message.content'],reasoningPaths:['choices.0.message.reasoning_content'],toolCallsPath:'choices.0.message.tool_calls',toolCallIdPaths:['id'],toolCallNamePaths:['function.name'],toolCallArgumentsPaths:['function.arguments']},response:{}})
 const messages=[{role:'system',content:'全部系统Skill原文保持：中文😀'},{role:'assistant',tool_calls:[{id:'call-original',type:'function',function:{name:'save_script',arguments:'{"text":"旧稿"}'}}]},{role:'tool',tool_call_id:'call-original',content:'{"saved":true}'},{role:'user',content:prompt}],tools=[{type:'function',function:{name:'save_script',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']}}}],schema={type:'json_schema',json_schema:{name:'original',schema:{type:'object'},strict:true}}
 const wire=await runtime.buildAgent({providerDefinition:def,connection,model:'native-text-id',request:{chatCompletion:{messages,tools,response_format:schema}}});const body=JSON.parse(wire.body as string);assert.deepEqual(body.messages,messages);assert.deepEqual(body.tools,tools);assert.deepEqual(body.response_format,schema)
 const parsed=await runtime.parseAgent({providerDefinition:def,raw:{choices:[{message:{content:'公开回复',reasoning_content:'HIDDEN-DO-NOT-PERSIST',tool_calls:[{id:'call-kept',function:{name:'save_script',arguments:'{"text":"完整新稿"}'}}]}}]}})
 assert.equal(parsed.toolCalls[0].id,'call-kept');assert.equal(parsed.toolCalls[0].arguments,'{"text":"完整新稿"}');assert(!JSON.stringify(parsed).includes('HIDDEN'))
})

test('auth drivers use exact final bytes and stable signatures without mutating payload',()=>{
 const now=new Date('2026-11-07T00:00:00Z'),bytes=Buffer.from('{"prompt":"原文"}'),key={baseUrl:'https://bedrock-runtime.us-east-1.amazonaws.com',apiKey:'AKIDEXAMPLE',authFields:{secretKey:'synthetic-secret'}}
 for(const type of ['aws-sigv4','volcengine-v4','tc3']){const headers=new Headers({'content-type':'application/json'}),url=new URL('https://bedrock-runtime.us-east-1.amazonaws.com/v1/tasks?b=2&a=1');runtime.applyProtocolAuth(url,headers,bytes,key,{type,service:type==='tc3'?'hunyuan':'bedrock',region:'us-east-1',secretField:'secretKey'},now,'GET');assert(headers.get('authorization')?.includes('Signature='));assert(!headers.has('x-provider-method'));assert.equal(bytes.toString(),'{"prompt":"原文"}');const repeat=new Headers({'content-type':'application/json'});runtime.applyProtocolAuth(new URL(url),repeat,bytes,key,{type,service:type==='tc3'?'hunyuan':'bedrock',region:'us-east-1',secretField:'secretKey'},now,'GET');assert.equal(repeat.get('authorization'),headers.get('authorization'))}
 const url=new URL('https://example.test/task'),headers=new Headers();runtime.applyProtocolAuth(url,headers,undefined,key,{type:'query',field:'apiKey',query:'token'});assert.equal(url.searchParams.get('token'),'AKIDEXAMPLE')
 assert.throws(()=>runtime.applyProtocolAuth(url,headers,bytes,key,{type:'unknown-driver'}),/未知/u)
})
test('AWS and TC3 match the original Yingce signer and Volc V4 matches the official Go SDK fixed-time golden vectors',()=>{
 const expected:Record<string,string>={'aws-sigv4':'decba33cbf26a929d3eb8a493f8b3f1a9779f316bc69899d3b37dbf1239f4e04',tc3:'553ee23bddd3cd6cc9598b0fb1354f433cf8bda6d6c3ee9c5da3ab2dee25c94f','volcengine-v4':'967845c936143f75147e0aaed0110a38ac972077ba86fa2dcacf247a6b7653b3'}
 for(const [type,signature]of Object.entries(expected)){const headers=new Headers({'Content-Type':'application/json',Accept:'application/json'});runtime.applyProtocolAuth(new URL('https://bedrock-runtime.us-east-1.amazonaws.com/v1/tasks?b=2&a=1'),headers,Buffer.from('{"prompt":"原文"}'),{baseUrl:'https://bedrock-runtime.us-east-1.amazonaws.com',apiKey:'AKIDEXAMPLE',authFields:{secretKey:'synthetic-secret'}},{type,service:type==='tc3'?'hunyuan':'bedrock',region:'us-east-1',secretField:'secretKey'},new Date('2026-11-07T00:00:00Z'),'GET');assert(headers.get('authorization')?.endsWith('Signature='+signature),type)}
})

let uploads=0,creates=0,polls=0,cancels=0,results=0
const observed:any[]=[]
const server=http.createServer(async(req,res)=>{const parts=[];for await(const part of req)parts.push(Buffer.from(part));const bytes=Buffer.concat(parts);observed.push({url:req.url,method:req.method,headers:req.headers,body:bytes});res.setHeader('content-type','application/json');if(req.url==='/v1/uploads'){uploads++;assert(req.headers['content-type']?.startsWith('multipart/form-data'));res.end(JSON.stringify({asset:{id:'uploaded-'+uploads}}));return};if(req.url==='/v1/tasks'&&req.method==='POST'){creates++;res.end(JSON.stringify({task:{id:'upstream-id-original',status:'pending'}}));return};if(req.url==='/v1/tasks/upstream-id-original/content'){results++;res.setHeader('content-type','video/mp4');res.end(Buffer.from('VIDEO-BINARY'));return};if(req.method==='DELETE'){cancels++;res.end('{}');return};polls++;res.end(JSON.stringify({task:{id:'upstream-id-original',status:'succeeded'}}))})
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const baseUrl='http://127.0.0.1:'+(server.address() as any).port
test('pre-upload deduplicates media, multipart carries original bytes, poll/result/cancel keep upstream task ID and never recreate',async()=>{
 const def=plugin({auth:{type:'header',header:'x-synthetic-key',field:'apiKey'},upload:{method:'POST',path:'/v1/uploads',contentType:'multipart/form-data',kinds:['image'],files:[{name:'file',source:{$ref:'media'}}],id:{$ref:'response.asset.id'}},create:{...create,body:{prompt:{$ref:'request.prompt'},ids:{$map:{from:{$ref:'request.images'},as:'item',in:{$ref:'item.uploadId'}}}}},poll:{method:'GET',path:'/v1/tasks/{{taskId}}'},cancel:{method:'DELETE',path:'/v1/tasks/{{taskId}}'},result:{method:'GET',path:'/v1/tasks/{{taskId}}/content'},response:{taskIdPaths:['task.id'],statusPaths:['task.status'],resultKind:'video'}})
 const connection={baseUrl,apiKey:'synthetic-upload-key'},input={...request,inputs:request.images}
 const submitted=await runtime.submitProvider({providerDefinition:def,connection,request:input});assert.equal(submitted.taskId,'upstream-id-original');assert.equal(creates,1);assert.equal(uploads,2);assert.deepEqual(input.inputs.map(x=>x.metadata),[undefined,undefined])
 const body=JSON.parse(observed.find(x=>x.url==='/v1/tasks').body.toString());assert.deepEqual(body.ids,['uploaded-1','uploaded-2']);assert.equal(body.prompt,prompt)
 const files=observed.filter(x=>x.url==='/v1/uploads');assert(files[0].body.includes(Buffer.from('hello')));assert(files[1].body.includes(Buffer.from('world')))
 const poll=await runtime.pollProvider({providerDefinition:def,connection,request:submitted.request!,taskId:submitted.taskId});assert.equal(poll.status,'succeeded');assert.equal(poll.result?.videos?.[0].bodyBase64,Buffer.from('VIDEO-BINARY').toString('base64'));assert.equal(polls,1);assert.equal(results,1)
 await runtime.cancelProvider({providerDefinition:def,connection,request,taskId:submitted.taskId});assert.equal(cancels,1);assert.equal(creates,1);assert.equal(uploads,2)
})

test('binary payloads and wrong JSON content-type are decoded without invented media URLs',async()=>{
 const def=plugin({capabilities:['image'],create:{method:'POST',path:'/v1/image'},response:{binaryPayload:true,resultKind:'image',status:'succeeded'}})
 const raw=await runtime.decodeProviderResponse(new Response(Buffer.from('PNG-BINARY'),{headers:{'content-type':'image/png'}}));const result=await runtime.parseCreate({providerDefinition:def,raw,request:{model:'binary-model',capability:'image'}});assert.equal(result.status,'succeeded');assert.equal(result.result?.images?.[0].bodyBase64,Buffer.from('PNG-BINARY').toString('base64'))
 assert.deepEqual(await runtime.decodeProviderResponse(new Response('{"ok":true}',{headers:{'content-type':'text/plain'}})),{ok:true})
})
test('failed submissions do not auto-retry or expose the connection key',async()=>{
 const before=creates,def=plugin({auth:{type:'bearer'},create:{method:'POST',path:'/v1/tasks'},response:{}})
 const native=globalThis.fetch;let attempts=0;globalThis.fetch=async()=>{attempts++;return new Response('failed sk-runtime-failed-private',{status:503})}
 try{await assert.rejects(runtime.submitProvider({providerDefinition:def,connection:{baseUrl,apiKey:'sk-runtime-failed-private'},request}),error=>{assert(!String(error).includes('sk-runtime-failed-private'));return true});assert.equal(attempts,1);assert.equal(creates,before)}finally{globalThis.fetch=native}
})
test('interpreter idle shutdown followed by immediate concurrent restart cannot reject the new child replies',async()=>{
 for(let round=0;round<4;round++){await runtime.providerCatalog();runtime.shutdownProviderEngine();const fresh=await Promise.all(Array.from({length:6},()=>runtime.providerCatalog()));assert(fresh.every(values=>values.length>=10))}
})
test('explicit original-expression progress mappings preserve 0 and 100 while unknown or invalid progress remains absent',async()=>{
 const def=plugin({create,poll:{method:'GET',path:'/v1/tasks/{{taskId}}'},cancel:{method:'DELETE',path:'/v1/tasks/{{taskId}}'},response:{taskIdPaths:['job.id'],statusPaths:['job.status'],progress:{$ref:'response.deep.job.percent'}}})
 assert.equal((await runtime.compileProvider(def)).cancelAvailable,true)
 for(const value of [0,37.5,100]){const raw={job:{id:'original-progress-id',status:'processing'},deep:{job:{percent:value}}},result=await runtime.parsePoll({providerDefinition:def,taskId:'original-progress-id',request,raw});assert.equal(result.progress,value);assert.equal(result.taskId,'original-progress-id')}
 for(const value of [-1,101,'unknown',null]){const result=await runtime.parseCreate({providerDefinition:def,request,raw:{job:{id:'original-progress-id',status:'processing'},deep:{job:{percent:value}}}});assert.equal(result.progress,undefined)}
})
test('private references are hydrated with exact bytes or owner-bound signed URLs, and missing/foreign images never submit',async()=>{
 const security=await import('../src/services/platform-security/index.ts');security.initPlatformSecurity();const alice=security.createUser('runtime_media_a','Runtime-media-a-password').user,bob=security.createUser('runtime_media_b','Runtime-media-b-password').user
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'),relative='static/uploads/owner-original.png'
 await fs.mkdir(path.join(root,'static/uploads'),{recursive:true});await fs.writeFile(path.join(root,relative),bytes);security.runAsActor(alice,()=>security.registerPrivateMedia(relative))
 const def=plugin({create,response:{taskIdPaths:['id']}}),input={...request,images:[{id:'exact-private-id',kind:'image',role:'reference_image',url:relative}]},before=creates
 const built=await security.runAsActor(alice,()=>runtime.buildCreate({providerDefinition:def,connection,request:input})),body=JSON.parse(built.body as string);assert.equal(body.images[0].id,'exact-private-id');assert.equal(body.images[0].data,'data:image/png;base64,'+bytes.toString('base64'));assert.equal(input.images[0].url,relative)
 await assert.rejects(security.runAsActor(bob,()=>runtime.buildCreate({providerDefinition:def,connection,request:input})),/无访问权限/u)
 const absent='static/uploads/missing-owned.png';security.runAsActor(alice,()=>security.registerPrivateMedia(absent));await assert.rejects(security.runAsActor(alice,()=>runtime.buildCreate({providerDefinition:def,connection,request:{...input,images:[{...input.images[0],url:absent}]}})))
 const previous=process.env.PUBLIC_BASE_URL;process.env.PUBLIC_BASE_URL='https://workbench.example.test:5238'
 try{const publicDef=plugin({requiresPublicMediaUrls:true,create,response:{taskIdPaths:['id']}}),wire=await security.runAsActor(alice,()=>runtime.buildCreate({providerDefinition:publicDef,connection,request:input})),url=new URL(JSON.parse(wire.body as string).images[0].data);assert.equal(url.origin,process.env.PUBLIC_BASE_URL);assert.equal(url.pathname,'/'+relative);assert(url.searchParams.get('sig'));assert(url.searchParams.get('exp'));assert(!JSON.stringify(wire.wireSummary).includes(url.searchParams.get('sig')!))}finally{if(previous===undefined)delete process.env.PUBLIC_BASE_URL;else process.env.PUBLIC_BASE_URL=previous}
 assert.equal(creates,before)
})
test('authenticated binary GET follows at most five redirects and drops every custom secret header at a CDN origin',async()=>{
 const captures:any[]=[]
 const cdn=http.createServer((req,res)=>{captures.push({origin:'cdn',headers:req.headers});res.setHeader('content-type','video/mp4');res.end('BINARY-CDN-RESULT')})
 await new Promise<void>(resolve=>cdn.listen(0,'127.0.0.1',resolve));const cdnUrl='http://127.0.0.1:'+(cdn.address() as any).port
 const origin=http.createServer((req,res)=>{captures.push({origin:'source',headers:req.headers});res.writeHead(req.url==='/same-origin'?307:302,{Location:req.url==='/same-origin'?cdnUrl+'/asset':'/same-origin'}).end()})
 await new Promise<void>(resolve=>origin.listen(0,'127.0.0.1',resolve));const originUrl='http://127.0.0.1:'+(origin.address() as any).port
 const def=plugin({auth:{type:'bearer'},create,result:{method:'GET',path:'/v1/content/{{taskId}}'},response:{}}),connection={baseUrl:originUrl,apiKey:'synthetic-bearer-redirect',headers:{'X-Api-Key':'synthetic-secondary','X-Secret-Vendor':'synthetic-custom',Cookie:'session=synthetic','Proxy-Authorization':'Basic synthetic'}}
 try{const result=await runtime.executeResult({providerDefinition:def,connection,request,taskId:'original-redirect-id'});assert.equal(result.result?.videos?.[0].bodyBase64,Buffer.from('BINARY-CDN-RESULT').toString('base64'));assert.equal(captures.filter(x=>x.origin==='source').length,2);assert(captures.filter(x=>x.origin==='source').every(x=>x.headers.authorization==='Bearer '+connection.apiKey));const headers=captures.find(x=>x.origin==='cdn').headers;for(const key of ['authorization','cookie','proxy-authorization','x-api-key','x-secret-vendor'])assert.equal(headers[key],undefined,key)
  const before=captures.length;await assert.rejects(runtime.sendProviderRequest(await runtime.buildCreate({providerDefinition:def,connection,request})));assert.equal(captures.length,before+1,'model POST is not followed to the CDN')
 }finally{await new Promise<void>(resolve=>origin.close(()=>resolve()));await new Promise<void>(resolve=>cdn.close(()=>resolve()))}
 const native=globalThis.fetch;let redirects=0;globalThis.fetch=async()=>{redirects++;return new Response(null,{status:302,headers:{location:'/same-loop'}})}
 try{await assert.rejects(runtime.executeResult({providerDefinition:def,connection,request,taskId:'loop'}),/5跳/u);assert.equal(redirects,6)}finally{globalThis.fetch=native}
})
test('cancel acknowledgements are distinct from confirmed terminal cancellation and HTTP 200 business errors are rejected',async()=>{
 const def=plugin({create,cancel:{method:'POST',path:'/v1/tasks/{{taskId}}/cancel'},poll:{method:'GET',path:'/v1/tasks/{{taskId}}'},response:{statusPaths:['task.status'],errorPaths:['error.code'],messagePaths:['error.message']}}),native=globalThis.fetch
 try{for(const [body,confirmed]of [[{accepted:true},false],[{task:{status:'processing'}},false],[{task:{status:'cancelled'}},true]] as const){globalThis.fetch=async()=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});const result=await runtime.cancelProvider({providerDefinition:def,connection:{baseUrl,apiKey:'synthetic-cancel'},request,taskId:'cancel-original-id'});assert.equal(result.requested,true);assert.equal(result.confirmed,confirmed)}
  globalThis.fetch=async()=>new Response(null,{status:204});assert.equal((await runtime.cancelProvider({providerDefinition:def,connection,request,taskId:'id'})).confirmed,false)
  for(const body of [{error:{code:'CancelDenied',message:'不能取消'}},{code:403,message:'拒绝取消'},{success:false,message:'已被拒绝'}]){globalThis.fetch=async()=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});await assert.rejects(runtime.cancelProvider({providerDefinition:def,connection,request,taskId:'id'}),/取消|拒绝/u)}
 }finally{globalThis.fetch=native}
})
test('legacy stored scalar flags normalize without touching provider payloads, and invalid typed bridge requests reject immediately then recover',async()=>{
 const def=plugin({create:{...create,body:{prompt:{$ref:'request.prompt'},audio:{$ref:'request.generateAudio'},watermark:{$ref:'request.watermark'},seconds:{$ref:'request.duration'},width:{$ref:'request.output.width'},extra:{$ref:'request.extra'}}},response:{}})
 const legacy={...request,generateAudio:1,watermark:0,duration:'5',output:{generateAudio:1,watermark:0,duration:'5',width:'1024',height:768},extra:{providerSpecificFlag:1,generateAudio:1}} as any
 const built=await runtime.buildCreate({providerDefinition:def,connection,request:legacy}),body=JSON.parse(built.body as string);assert.equal(body.prompt,prompt);assert.equal(body.audio,true);assert.equal(body.watermark,false);assert.equal(body.seconds,5);assert.equal(body.width,1024);assert.deepEqual(body.extra,legacy.extra);assert.equal(legacy.generateAudio,1,'caller snapshot remains unchanged')
 const started=Date.now();await assert.rejects(runtime.buildCreate({providerDefinition:def,connection,request:{...request,generateAudio:'invalid-bool'} as any}),/generateAudio.*布尔/u);assert(Date.now()-started<2000)
 const {engineCall}=await import('../src/services/provider-runtime/bridge.ts'),before=Date.now()
 await assert.rejects(engineCall('buildCreate',{providerDefinition:def,request:{model:'unmarshal-failure',messages:[{role:123,content:'not emitted in error'}]}}),/invalid bridge JSON.*role/u)
 assert(Date.now()-before<2000,'typed decoder errors retain correlation ID instead of orphaning the pending request for 30 seconds')
 const after=await runtime.buildCreate({providerDefinition:def,connection,request});assert.equal(JSON.parse(after.body as string).prompt,prompt);assert((await runtime.providerCatalog()).length>=10);assert((await engineCall<any[]>('catalog',{id:'cannot-override-correlation',op:'cannot-override-operation'})).length>=10)
})
after(async()=>{runtime.shutdownProviderEngine();await new Promise<void>(resolve=>server.close(()=>resolve()));db.$client.close();assert(path.basename(root).startsWith('huobao-provider-runtime-'));await fs.rm(root,{recursive:true,force:true,maxRetries:3})})
