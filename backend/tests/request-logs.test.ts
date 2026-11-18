import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'huobao-request-logs-'))
process.env.HUOBAO_DATA_DIR=directory
process.env.SQLITE_PATH=path.join(directory,'business.sqlite3')
process.env.STORAGE_PATH=path.join(directory,'static')
process.env.WORKSPACE_PATH=path.join(directory,'workspace')
process.env.MYSQL_AUTO_IMPORT='false'
process.env.HUOBAO_PROXY_URL='direct'
const {default:Database}=await import('better-sqlite3')
const {RequestLogStore,setRequestLogStore}=await import('../src/services/request-logs/store.ts')
const {captureProviderRequest,describeRequestBody}=await import('../src/services/request-logs/capture.ts')
const {withRequestLogContext}=await import('../src/services/request-logs/context.ts')
const {createProviderHttp,setProviderHttpObserver}=await import('../src/utils/http.ts')
const sql=new Database(':memory:')
sql.exec(`CREATE TABLE platform_users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT);
  INSERT INTO platform_users VALUES(7,'alpha','=unsafe-display');INSERT INTO platform_users VALUES(8,'beta','Beta');
  CREATE TABLE dramas(id INTEGER PRIMARY KEY,title TEXT,owner_user_id INTEGER);
  INSERT INTO dramas VALUES(21,'Project One',8);
  CREATE TABLE episodes(id INTEGER PRIMARY KEY,episode_number INTEGER);INSERT INTO episodes VALUES(31,2);`)
const store=new RequestLogStore(sql)
setRequestLogStore(store)
after(async()=>{setProviderHttpObserver(undefined);setRequestLogStore(null);sql.close();const {db}=await import('../src/db/index.ts');db.$client.close()})
const pause=()=>new Promise(resolve=>setImmediate(resolve))
async function settle(predicate:()=>boolean){for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10))}assert.fail('log did not settle')}
const rows=()=>store.list({phase:'all',limit:100}).items as any[]
const context={taskId:'logical-1',roundId:'round-1',actorUserId:7,projectId:21,projectOwnerId:8,episodeId:31,channelId:12,channelName:'Fixture channel',configId:13,model:'fixture-text',kind:'text' as const}
const fetchObserved=(input:any,next:()=>Promise<Response>,extra:any={})=>withRequestLogContext({...context,...extra},()=>captureProviderRequest(input,next))

test('actual JSON bytes stay unchanged and credentials never enter stored copies',async()=>{
  const body=JSON.stringify({model:'fixture-text',messages:[{role:'system',content:'system fixture'},{role:'user',content:'hello'}],api_key:'fixture-secret'})
  let called=0
  const response=await fetchObserved({input:'https://fixture.invalid/v1/chat/completions?token=fixture-token',init:{method:'POST',headers:{Authorization:'Bearer fixture-secret',Cookie:'fixture-cookie'},body}},async()=>{called++;assert.equal(body,JSON.stringify(JSON.parse(body)));return new Response(JSON.stringify({choices:[{message:{content:'hello'}}]}),{headers:{'Content-Type':'application/json','X-Request-Id':'upstream-1'}})})
  assert.equal((await response.json()).choices[0].message.content,'hello')
  await settle(()=>rows()[0].status==='succeeded')
  const detail=store.detail(rows()[0].id)!
  assert.equal(called,1);assert.equal(detail.request.user_id,7);assert.equal(detail.request.project_owner_id,8);assert.equal(detail.request.episode_number,2)
  assert.equal(detail.request.upstream_request_id,'upstream-1');assert.equal((detail.request_body as any).messages[0].role,'system')
  const encoded=JSON.stringify(detail);for(const secret of ['fixture-secret','fixture-cookie','fixture-token'])assert.ok(!encoded.includes(secret),secret)
})

test('stream is pulled only by its consumer; cancellation reaches upstream and metadata survives',async()=>{
  let pulls=0,cancelled=false
  const original=new Response(new ReadableStream<Uint8Array>({pull(controller){pulls++;controller.enqueue(new TextEncoder().encode('chunk'))},cancel(){cancelled=true}},{highWaterMark:0}),{headers:{'Content-Type':'text/plain'}})
  Object.defineProperties(original,{url:{value:'https://fixture.invalid/final'},redirected:{value:true},type:{value:'cors'}})
  const response=await fetchObserved({input:'https://fixture.invalid/v1/chat/completions',init:{method:'POST',body:'{}'}},async()=>original,{taskId:'lazy-stream'})
  await pause();assert.equal(pulls,0);assert.equal(response.url,original.url);assert.equal(response.redirected,true);assert.equal(response.type,'cors')
  assert.equal(rows().find(r=>r.task_id==='lazy-stream').status,'running')
  const reader=response.body!.getReader();assert.equal(new TextDecoder().decode((await reader.read()).value),'chunk');assert.equal(pulls,1)
  await reader.cancel();assert.equal(cancelled,true)
  await settle(()=>rows().find(r=>r.task_id==='lazy-stream')?.status==='cancelled')
})

test('clone preserves URL/redirect/type and all response bytes while one request is recorded',async()=>{
  const original=new Response('αβ stream',{headers:{'Content-Type':'text/plain'}})
  Object.defineProperties(original,{url:{value:'https://fixture.invalid/redirected'},redirected:{value:true},type:{value:'cors'}})
  const response=await fetchObserved({input:'https://fixture.invalid/v1/chat/completions',init:{method:'POST'}},async()=>original,{taskId:'clone'})
  const clone=response.clone();assert.equal(clone.url,original.url);assert.equal(clone.redirected,true);assert.equal(clone.type,'cors')
  assert.deepEqual(await Promise.all([response.text(),clone.text()]),['αβ stream','αβ stream'])
  await settle(()=>rows().find(r=>r.task_id==='clone')?.status==='succeeded')
  assert.equal(rows().filter(r=>r.task_id==='clone').length,1)
})

test('SSE public frames are observable without saving hidden reasoning or changing raw stream',async()=>{
  const raw='data: {"type":"reasoning","text":"HIDDEN_REASONING"}\n\ndata: {"choices":[{"delta":{"content":"public"},"reasoning_content":"HIDDEN_OTHER"}]}\n\ndata: [DONE]\n\n'
  const response=await fetchObserved({input:'https://fixture.invalid/v1/chat/completions',init:{method:'POST',body:'{}'}},async()=>new Response(raw,{headers:{'Content-Type':'text/event-stream'}}),{taskId:'sse'})
  assert.equal(await response.text(),raw);await settle(()=>rows().find(r=>r.task_id==='sse')?.status==='succeeded')
  const saved=JSON.stringify(store.detail(rows().find(r=>r.task_id==='sse').id));assert.ok(saved.includes('public'));assert.ok(!saved.includes('HIDDEN'))
})

test('Gemini and Anthropic hidden thought parts are removed but request effort controls remain',async()=>{
  const body=JSON.stringify({model:'fixture-text',thinking:{type:'enabled',budget_tokens:1024},messages:[{role:'assistant',content:[{type:'thinking',thinking:'REQUEST_HIDDEN'},{type:'text',text:'visible context'}]}]})
  const raw=JSON.stringify({candidates:[{content:{parts:[{thought:true,text:'GEMINI_HIDDEN'},{text:'public result'}]}}],content:[{type:'thinking',thinking:'ANTHROPIC_HIDDEN'},{type:'text',text:'public content'}]})
  const response=await fetchObserved({input:'https://fixture.invalid/v1/chat/completions',init:{method:'POST',body}},async()=>new Response(raw,{headers:{'Content-Type':'application/json'}}),{taskId:'provider-thoughts'})
  assert.equal(await response.text(),raw);await settle(()=>rows().find(r=>r.task_id==='provider-thoughts')?.status==='succeeded')
  const detail=store.detail(rows().find(r=>r.task_id==='provider-thoughts').id)!,saved=JSON.stringify(detail)
  for(const hidden of ['REQUEST_HIDDEN','GEMINI_HIDDEN','ANTHROPIC_HIDDEN'])assert.ok(!saved.includes(hidden))
  assert.equal((detail.request_body as any).thinking.type,'enabled');assert.ok(saved.includes('public result'))
})

test('upstream stream error is propagated unchanged; telemetry records failure',async()=>{
  const error=new Error('fixture-body-disconnected')
  const response=await fetchObserved({input:'https://fixture.invalid/v1/chat/completions',init:{method:'POST'}},async()=>new Response(new ReadableStream({pull(controller){controller.error(error)}},{highWaterMark:0}),{headers:{'Content-Type':'text/plain'}}),{taskId:'body-error'})
  await assert.rejects(response.text(),error);await settle(()=>rows().find(r=>r.task_id==='body-error')?.status==='failed')
  assert.match(rows().find(r=>r.task_id==='body-error').error,/fixture-body/)
})

test('multipart retains every repeated image field with actual byte hashes',async()=>{
  const bytes=Buffer.from('synthetic-image-bytes'),form=new FormData()
  form.append('model','fixture-image');form.append('prompt','reference fixture');form.append('image[]',new Blob([bytes],{type:'image/png'}),'one.png');form.append('image[]',new Blob([bytes],{type:'image/png'}),'two.png')
  const response=await fetchObserved({input:'https://fixture.invalid/v1/images/edits',init:{method:'POST',body:form}},async()=>new Response('{}',{headers:{'Content-Type':'application/json'}}),{taskId:'multipart',kind:'image'})
  await response.text();await settle(()=>rows().find(r=>r.task_id==='multipart')?.request_recorded)
  const detail=store.detail(rows().find(r=>r.task_id==='multipart').id)!,images=(detail.request_body as any).multipart.filter((r:any)=>r.name==='image[]')
  assert.equal(images.length,2);assert.deepEqual(images.map((r:any)=>r.filename),['one.png','two.png']);assert.ok(images.every((r:any)=>r.sha256===createHash('sha256').update(bytes).digest('hex')))
  assert.ok(!JSON.stringify(detail).includes(bytes.toString('base64')))
})

test('many small JSON fields are bounded as a whole without modifying outgoing request',async()=>{
  const input=JSON.stringify(Object.fromEntries(Array.from({length:6000},(_,n)=>['key'+n,'x'.repeat(60)])))
  const description=await describeRequestBody(input);assert.equal(description.truncated,true);assert.ok(JSON.stringify(description.body).length<1000)
  const response=await fetchObserved({input:'https://fixture.invalid/v1/chat/completions',init:{method:'POST',body:input}},async()=>{assert.equal(input.length,JSON.stringify(JSON.parse(input)).length);return new Response('{}',{headers:{'Content-Type':'application/json'}})},{taskId:'large'})
  await response.text();await settle(()=>rows().find(r=>r.task_id==='large')?.status==='succeeded')
  const detail=store.detail(rows().find(r=>r.task_id==='large').id)!;assert.equal(detail.request.request_truncated,true);assert.ok(JSON.stringify(detail.request_body).length<1000)
})

test('truncated plain text cannot persist a partial opaque credential',async()=>{
  const secret='opaque-private-secret',body=secret+'x'.repeat(262144-secret.length-8)+secret
  const response=await fetchObserved({input:'https://fixture.invalid/v1/chat/completions',init:{method:'POST',headers:{'x-api-key':secret}}},async()=>new Response(body,{headers:{'Content-Type':'text/plain'}}),{taskId:'truncated-secret'})
  assert.equal(await response.text(),body);await settle(()=>rows().find(r=>r.task_id==='truncated-secret')?.status==='succeeded')
  const d=store.detail(rows().find(r=>r.task_id==='truncated-secret').id)!
  assert.equal(d.request.response_truncated,true);assert.ok(!JSON.stringify(d).includes('opaque-p'));assert.match(JSON.stringify(d.response_body),/omitted/)
})

test('duplicate credential query values and body-only secrets are all redacted from echoes',async()=>{
  const response=await fetchObserved({input:'https://fixture.invalid/v1/chat/completions?key=first-opaque-value&key=second-opaque-value',init:{method:'POST',body:'{"api_key":"body-only-private"}',headers:{Cookie:'first=one-cookie-private; second=two-cookie-private'}}},async()=>new Response(JSON.stringify({echo:['first-opaque-value','second-opaque-value','body-only-private','one-cookie-private','two-cookie-private']}),{headers:{'Content-Type':'application/json'}}),{taskId:'duplicate-secrets'})
  await response.text();await settle(()=>rows().find(r=>r.task_id==='duplicate-secrets')?.status==='succeeded')
  const value=JSON.stringify(store.detail(rows().find(r=>r.task_id==='duplicate-secrets').id))
  for(const secret of ['first-opaque-value','second-opaque-value','body-only-private','one-cookie-private','two-cookie-private'])assert.ok(!value.includes(secret),secret)
})

test('credential collection precedes every header and URL snapshot regardless of header ordering',async()=>{
  const secret='opaque-private-secret'
  const response=await fetchObserved({input:'https://fixture.invalid/v1/'+secret+'/chat/completions?key=query-secret',init:{method:'POST',headers:{'a-debug':secret,'x-api-key':secret,'accept':'query-secret'},body:'{"api_key":"body-private","model":"fixture-text"}'}},async()=>new Response('{"echo":"opaque-private-secret"}',{headers:{'Content-Type':'application/json','a-debug':'response-cookie','Set-Cookie':'session=response-cookie'}}),{taskId:'header-order'})
  await response.text();await settle(()=>rows().find(r=>r.task_id==='header-order')?.status==='succeeded')
  const saved=JSON.stringify(store.detail(rows().find(r=>r.task_id==='header-order').id))
  for(const value of [secret,'query-secret','body-private','response-cookie'])assert.ok(!saved.includes(value),value)
})

test('derived request and task IDs cannot echo a known credential into metadata columns',async()=>{
  const secret='opaque-derived-private'
  const response=await fetchObserved({input:'https://fixture.invalid/v1/videos',init:{method:'POST',headers:{'x-api-key':secret},body:'{}'}},async()=>new Response(JSON.stringify({task_id:secret,status:secret}),{headers:{'Content-Type':'application/json','x-request-id':secret}}),{taskId:'id-secret',kind:'video',upstreamTaskId:secret,model:secret,channelName:secret})
  await response.text();await settle(()=>rows().find(r=>r.task_id==='id-secret')?.status==='succeeded')
  const detail=store.detail(rows().find(r=>r.task_id==='id-secret').id)!
  assert.equal(detail.request.upstream_request_id,null);assert.equal(detail.request.upstream_task_id,null);assert.equal(detail.request.business_status,null);assert.equal(detail.request.model,null);assert.ok(!JSON.stringify(detail).includes(secret))
})

test('form snapshot excludes fields appended after fetch starts',async()=>{
  const form=new FormData();form.append('image[]',new Blob(['first']),'first.png')
  const promise=describeRequestBody(form);form.append('late','not-sent');const value=await promise
  assert.equal((value.body as any).multipart.length,1)
})

test('large binary form parts keep metadata without reading beyond the hash budget',async()=>{
  const form=new FormData();form.append('file',new Blob([new Uint8Array(65*1024*1024)]),'large.bin')
  const value=await describeRequestBody(form)
  assert.equal(value.truncated,true);assert.equal((value.body as any).multipart[0].size,65*1024*1024)
  assert.ok((value.body as any).multipart[0].hash_omitted);assert.equal((value.body as any).multipart[0].sha256,undefined)
  assert.ok(JSON.stringify(value).length<1000)
})

test('a network failure remains the original error and never acquires a fabricated HTTP status',async()=>{
  const error=new TypeError('network fixture failure');let calls=0
  await assert.rejects(fetchObserved({input:'https://fixture.invalid/v1/chat/completions',init:{method:'POST'}},async()=>{calls++;throw error},{taskId:'network-failed'}),error)
  assert.equal(calls,1);const row=rows().find(r=>r.task_id==='network-failed');assert.equal(row.status,'failed');assert.equal(row.http_status,null)
})

test('one bottom transport hook records one real HTTP request through text wrapper',async()=>{
  let received=0,body=''
  const server=http.createServer(async(req,res)=>{received++;for await(const chunk of req)body+=chunk;res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}')})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as any).port
  const transport=createProviderHttp({proxyUrl:null,kind:'text'})
  setProviderHttpObserver(captureProviderRequest)
  try{const response=await withRequestLogContext({...context,taskId:'one-http'},()=>transport.fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',body:'{"model":"fixture-text"}'}));assert.equal((await response.json()).ok,true);await settle(()=>rows().some(r=>r.task_id==='one-http'&&r.status==='succeeded'));assert.equal(received,1);assert.equal(body,'{"model":"fixture-text"}');assert.equal(rows().filter(r=>r.task_id==='one-http').length,1)}finally{setProviderHttpObserver(undefined);await transport.close();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})

test('poll and download phases do not inherit generation; stream Request body is not consumed for logs',async()=>{
  const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('request bytes'));c.close()}})
  const request=new Request('https://fixture.invalid/v1/tasks/123',{method:'POST',body:stream,duplex:'half'} as any)
  const response=await fetchObserved({input:request},async()=>{assert.equal(await request.text(),'request bytes');return new Response('ok',{headers:{'Content-Type':'text/plain'}})},{taskId:'stream-request',phase:'other'})
  await response.text();await settle(()=>rows().find(r=>r.task_id==='stream-request')?.status==='succeeded');assert.equal(rows().find(r=>r.task_id==='stream-request').request_recorded,false)
  for(const [url,expected]of [['https://fixture.invalid/v1/videos/123','poll'],['https://fixture.invalid/v1/videos/123/content','download']]){
    const r=await fetchObserved({input:url,init:{method:'GET'}},async()=>new Response('ok',{headers:{'Content-Type':'text/plain'}}),{taskId:'phases',phase:'generate',kind:'video'});await r.text();await pause();assert.equal(rows()[0].phase,expected)
  }
})

test('store filters all users on server and omits heavy request bodies from list',()=>{
  const result=store.list({user_id:'7',model:'fixture-text',phase:'all',q:'alpha',limit:2,offset:1})
  assert.ok(result.total>2);assert.equal(result.items.length,2);assert.ok(result.items.every((r:any)=>r.user_id===7));assert.ok(!JSON.stringify(result.items).includes('request_body_json'))
  assert.throws(()=>store.list({user_id:'7 OR 1=1'}),/筛选/)
})

test('actual serialized model name overrides only the diagnostic display alias',async()=>{
  const body='{"model":"actual-wire-model"}'
  const response=await fetchObserved({input:'https://fixture.invalid/v1/chat/completions',init:{method:'POST',body}},async()=>new Response('{}',{headers:{'Content-Type':'application/json'}}),{taskId:'model-alias',model:'configured-alias'})
  await response.text();await settle(()=>rows().find(r=>r.task_id==='model-alias')?.status==='succeeded')
  const row=rows().find(r=>r.task_id==='model-alias');assert.equal(row.model,'actual-wire-model');assert.equal((store.detail(row.id)!.request_body as any).model,'actual-wire-model')
})

test('administrator-only list/detail/export and CSV formula injection protection',async()=>{
  const security=await import('../src/services/platform-security/index.ts'),{default:app}=await import('../src/routes/request-logs.ts')
  security.initPlatformSecurity();const admin=security.listUsers().find(r=>r.role==='admin')!,user=security.createUser('request-log-user','fixture-only').user
  const id=rows()[0].id
  for(const route of ['/',`/${id}`,'/export',`/${id}/export`])assert.equal((await security.runAsActor(user,()=>app.request('http://fixture'+route))).status,403)
  const result=await security.runAsActor(admin,()=>app.request('http://fixture/?phase=all'));assert.equal(result.status,200)
  const detail=await security.runAsActor(admin,()=>app.request('http://fixture/'+id));assert.equal(detail.status,200)
  const csv=await security.runAsActor(admin,()=>app.request('http://fixture/export?phase=all'));assert.equal(csv.status,200);assert.ok((await csv.text()).includes("'=unsafe-display"))
  assert.ok([400,404].includes((await security.runAsActor(admin,()=>app.request('http://fixture/../../private'))).status))
})

test('interrupted observation is marked unknown without inventing a response or resubmitting',()=>{
  const id=store.begin({method:'POST',url:'https://fixture.invalid/video',path:'/video',kind:'video',phase:'generate',actorUserId:7})
  store.markInterrupted();const d=store.detail(id)!;assert.equal(d.request.status,'unknown');assert.equal(d.request.http_status,null);assert.equal(d.request.response_recorded,false);assert.match(d.request.error,/未核实/)
})

test('polls retain the known upstream task ID without treating completion IDs as task IDs',async()=>{
  const response=await fetchObserved({input:'https://fixture.invalid/v1/videos/task123',init:{method:'GET'}},async()=>new Response('{"data":{"status":"processing"}}',{headers:{'Content-Type':'application/json'}}),{taskId:'known-upstream',kind:'video',phase:'poll',upstreamTaskId:'task123'})
  await response.text();await settle(()=>rows().find(r=>r.task_id==='known-upstream')?.status==='succeeded')
  const row=rows().find(r=>r.task_id==='known-upstream');assert.equal(row.upstream_task_id,'task123');assert.equal(row.business_status,'processing')
  const text=await fetchObserved({input:'https://fixture.invalid/v1/chat/completions',init:{method:'POST'}},async()=>new Response('{"id":"chatcmpl-result"}',{headers:{'Content-Type':'application/json'}}),{taskId:'text-response-id',upstreamTaskId:null})
  await text.text();await settle(()=>rows().find(r=>r.task_id==='text-response-id')?.status==='succeeded');assert.equal(rows().find(r=>r.task_id==='text-response-id').upstream_task_id,null)
})

test('closed diagnostic database cannot fail the original successful fetch',async()=>{
  const broken=new Database(':memory:'),brokenStore=new RequestLogStore(broken);broken.close();setRequestLogStore(brokenStore)
  const original=new Response('safe',{headers:{'Content-Type':'text/plain'}})
  try{assert.equal(await captureProviderRequest({input:'https://fixture.invalid/v1/images/generations',init:{method:'POST'}},async()=>original),original)}finally{setRequestLogStore(store)}
})

test('diagnostic storage failure after response headers cannot corrupt response bytes',async()=>{
  const failureDb=new Database(':memory:'),failureStore=new RequestLogStore(failureDb);setRequestLogStore(failureStore)
  try{
    const response=await captureProviderRequest({input:'https://fixture.invalid/v1/images/generations',init:{method:'POST'}},async()=>new Response('original response',{headers:{'Content-Type':'text/plain'}}))
    failureDb.close();assert.equal(await response.text(),'original response');await pause()
  }finally{if(failureDb.open)failureDb.close();setRequestLogStore(store)}
})
