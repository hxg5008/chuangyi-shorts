/** Isolated integration smoke: Firebo HTTP -> real Hub -> real Python service.
 * Only the native upstream transport is fake. No account/config is read and no
 * billable operation is allowed. Run with Node after backend npm ci.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {createRequire} from 'node:module'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createHash,randomBytes} from 'node:crypto'

const script=fileURLToPath(import.meta.url),source=path.resolve(path.dirname(script),'..'),workspace=path.dirname(source)
const backend=path.join(source,'backend'),jmRoot=process.env.JIMENG_SMOKE_SERVICE_ROOT||path.join(workspace,'jimeng-local-service')
const hubRoot=process.env.JIMENG_SMOKE_HUB_ROOT||path.join(workspace,'chuangyi-local-hub')
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))
function safeEnvironment(extra={}){
 const result={}
 for(const [name,value] of Object.entries(process.env))if(/^(?:PATH|SystemRoot|WINDIR|TEMP|TMP|ComSpec|PATHEXT)$/iu.test(name))result[name]=value
 return {...result,...extra}
}
async function condition(read,accept,{timeout=45000,label='fixture condition'}={}){
 const deadline=Date.now()+timeout
 while(Date.now()<deadline){const value=await read();if(accept(value))return value;await wait(100)}
 throw Error(label+' timed out')
}
async function api(base,route,{method='GET',body,key}={}){
 const response=await fetch(base+route,{method,headers:{...(key?{Authorization:'Bearer '+key}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000),redirect:'error'})
 const value=await response.json()
 return {status:response.status,value}
}
async function closeServer(server){if(!server)return;server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve))}
const running=child=>child?.pid&&child.exitCode===null&&child.signalCode===null

async function fireboChild(){
 const directory=path.resolve(process.env.HUOBAO_SMOKE_DIR||'')
 assert(directory.startsWith(path.resolve(os.tmpdir())+path.sep),'Smoke child requires an isolated temp directory')
 process.env.DOTENV_CONFIG_PATH=path.join(directory,'empty.env')
 process.env.SQLITE_PATH=path.join(directory,'firebo.sqlite3')
 process.env.HUOBAO_DATA_DIR=directory
 process.env.STORAGE_PATH=path.join(directory,'static')
 process.env.MYSQL_AUTO_IMPORT='false'
 process.env.HUOBAO_PROXY_URL='direct'
 // Fail closed if any unexpected code attempts a non-fixture model request.
 const originalFetch=globalThis.fetch
 globalThis.fetch=(input,init)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input:input.url)
  assert.equal(url.origin,process.env.HUOBAO_SMOKE_HUB,'Only the isolated hub may be contacted')
  return originalFetch(input,init)
 }
 const require=createRequire(path.join(backend,'package.json'))
 require('tsx/esm/api').register()
 const {Hono}=require('hono'),{serve}=require('@hono/node-server')
 const {db,schema,getInsertId}=await import(pathToFileURL(path.join(backend,'src/db/index.ts')).href)
 const {default:tasks}=await import(pathToFileURL(path.join(backend,'src/routes/tasks.ts')).href)
 const {default:configs}=await import(pathToFileURL(path.join(backend,'src/routes/aiConfigs.ts')).href)
 const at=new Date().toISOString(),style='Synthetic historical texture，柔和自然光。'
 await db.insert(schema.stylePresets).values({name:'Synthetic smoke',value:'jimeng_smoke',prompt:style,isActive:true,createdAt:at,updatedAt:at})
 const dramaId=getInsertId(await db.insert(schema.dramas).values({title:'Synthetic integration only',style:'jimeng_smoke',createdAt:at,updatedAt:at}))
 const episodeId=getInsertId(await db.insert(schema.episodes).values({dramaId,episodeNumber:1,title:'Synthetic episode',resolution:'480p',createdAt:at,updatedAt:at}))
 const storyboardIds=[]
 for(let i=0;i<2;i++)storyboardIds.push(getInsertId(await db.insert(schema.storyboards).values({episodeId,storyboardNumber:i+1,videoUrl:'/static/synthetic-previous.mp4',createdAt:at,updatedAt:at})))
 const app=new Hono();app.route('/api/v1/tasks',tasks);app.route('/api/v1/ai-configs',configs)
 app.get('/fixture/state',async c=>c.json({storyboards:await db.select().from(schema.storyboards),tasks:await db.select().from(schema.sysTask)}))
 const server=serve({fetch:app.fetch,port:0,hostname:'127.0.0.1'})
 await once(server,'listening')
 process.send?.({ready:true,url:`http://127.0.0.1:${server.address().port}`,dramaId,storyboardIds,style})
 process.on('message',async value=>{if(value?.stop){await closeServer(server);process.exit(0)}})
}

const pythonFixture=String.raw`
import base64, json, os, socket, sys, threading
from pathlib import Path
from http.server import ThreadingHTTPServer
sys.path.insert(0, sys.argv[1])
from app.core import atomic_json, plan_bindings, sha
from app.server import Service, Handler
from vendor.jimeng_native.reference_mentions import content_parts

root=Path(sys.argv[2]).resolve()
capture=root/'capture.json'
class FakeNativeTransport:
    def __init__(self):
        self.lock=threading.RLock()
        self.sent=[]
        self.polled=[]
        self.downloads=[]
        self.requests=[]
    def save(self):
        with self.lock:
            atomic_json(capture, {'sent':self.sent,'polled':self.polled,'downloads':self.downloads,'requests':self.requests})
    def send(self, account, job, payload, message, accepted, stage):
        plans=plan_bindings(message,payload['images'],payload['bindings'])
        files=[{'uri':'synthetic/'+image['id'],'name':image['name']} for image in payload['images']]
        sequence=iter('synthetic-file-'+str(i) for i in range(len(files)))
        parts=content_parts(message,files,plans,lambda:next(sequence))
        with self.lock:
            self.sent.append({'job_id':job['id'],'payload':payload,'message':message,'native_parts':parts})
            self.save()
        stage('submitting','Synthetic native acceptance only')
        accepted('synthetic-submit-'+job['id'])
        return {'submit_id':'synthetic-submit-'+job['id'],'text':'Synthetic accepted','complete':True}
    def discover_submit(self, account, job):
        raise AssertionError('Unexpected native recovery in success/failure fixture')
    def poll(self, account, job):
        with self.lock:
            self.polled.append(job['id'])
            self.save()
        if '【审核失败】' in json.loads(job['request_json'])['prompt']:
            return {'state':'failed','error_code':'input_image_rejected','error':'参考图可能包含低俗内容，请修改后重试。'}
        return {'state':'completed','url':'https://must-never-download.invalid/synthetic.mp4','duration':5}
    def download(self,*args):
        with self.lock:
            self.downloads.append('unexpected')
            self.save()
        raise AssertionError('No automatic download is permitted')

# Prevent any accidental native HTTP call, even if a future production branch changes.
original_connect=socket.socket.connect
def local_only_connect(sock,address):
    if not isinstance(address,tuple) or address[0] not in ('127.0.0.1','::1'):
        raise AssertionError('The smoke fixture forbids external network calls')
    return original_connect(sock,address)
socket.socket.connect=local_only_connect
transport=FakeNativeTransport()
app=Service(root/'service-data',transport)
account=app.store.add_account({'sessionid':'synthetic-not-a-real-cookie','sid_tt':'synthetic-tt'},'Synthetic account')
app.store.update_account(account,canvas_id='123456',state='ready')
app.worker.poll_seconds=.02
class RecordingHandler(Handler):
    def dispatch(self,method):
        with transport.lock:
            transport.requests.append({'method':method,'path':self.path})
            transport.save()
        return super().dispatch(method)
server=ThreadingHTTPServer(('127.0.0.1',0),RecordingHandler)
server.app=app
app.httpd=server
thread=threading.Thread(target=server.serve_forever,daemon=True)
thread.start()
app.worker.start()
transport.save()
print(json.dumps({'ready':True,'port':server.server_port,'key':app.config['api_key']}),flush=True)
try:
    sys.stdin.readline()
finally:
    server.shutdown()
    app.worker.draining=True
    app.worker.stop.set()
    app.worker.wake.set()
    app.worker.poll_wake.set()
    if not app.worker.join(5): raise AssertionError('Synthetic workers failed to stop')
    app.downloads.pool.shutdown(wait=True)
    server.server_close()
    thread.join(2)
    app.store.db.close()
`

async function run(){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'huobao-jimeng-service-smoke-'))
 let python,firebo,hub,gpt,pythonError='',fireboError='',diagnostics=''
 try{
  await fs.writeFile(path.join(directory,'empty.env'),'')
  const pythonCandidates=[process.env.JIMENG_SMOKE_PYTHON,path.join(jmRoot,'.venv/Scripts/python.exe'),path.join(jmRoot,'runtime/python/python.exe')].filter(Boolean)
  let pythonExe
  for(const file of pythonCandidates)if(await fs.stat(file).then(s=>s.isFile(),()=>false)){pythonExe=file;break}
  if(!pythonExe)throw Error('Set JIMENG_SMOKE_PYTHON to the isolated service Python interpreter')
  python=spawn(pythonExe,['-I','-X','utf8','-B','-c',pythonFixture,jmRoot,directory],{cwd:directory,env:safeEnvironment({PYTHONIOENCODING:'utf-8'}),windowsHide:true,stdio:['pipe','pipe','pipe']})
  python.stderr.on('data',chunk=>{pythonError+=chunk.toString();pythonError=pythonError.slice(-8000)})
  let pythonReady
  const native=await new Promise((resolve,reject)=>{
   let buffer='';const timer=setTimeout(()=>reject(Error('Python fixture did not become ready')),15000)
   python.stdout.on('data',chunk=>{buffer+=chunk.toString();const end=buffer.indexOf('\n');if(end>=0&&!pythonReady){try{pythonReady=JSON.parse(buffer.slice(0,end));clearTimeout(timer);resolve(pythonReady)}catch{clearTimeout(timer);reject(Error('Invalid synthetic Python readiness'))}}})
   python.once('error',reject);python.once('exit',code=>{if(!pythonReady){clearTimeout(timer);reject(Error('Python fixture exited '+code))}})
  })
  assert.equal(native.ready,true);assert(Number.isSafeInteger(native.port)&&native.port>0&&native.port<65536)
  const jmUrl=`http://127.0.0.1:${native.port}`,requests=[]
  gpt=http.createServer((req,res)=>{requests.push(req.url);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({object:'list',data:[{id:'synthetic-text'},{id:'imagegen'}]}))})
  gpt.listen(0,'127.0.0.1');await once(gpt,'listening')
  const reservation=http.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await closeServer(reservation)
  const {createHub}=await import(pathToFileURL(path.join(hubRoot,'server.mjs')).href)
  const hubUrl=`http://127.0.0.1:${port}`,hubKey='synthetic-'+randomBytes(32).toString('base64url')
  hub=createHub({config:{ip:'127.0.0.1',port,listenHost:'127.0.0.1',publicOrigin:hubUrl,engines:{gpt:{url:`http://127.0.0.1:${gpt.address().port}`},jimeng:{url:jmUrl}}},key:hubKey,credentials:{gpt:{api:'synthetic-gpt-api',admin:'synthetic-admin'},jimeng:{api:native.key}}})
  hub.listen(port,'127.0.0.1');await once(hub,'listening')
  firebo=spawn(process.execPath,[script,'--firebo-child'],{cwd:directory,env:safeEnvironment({HUOBAO_SMOKE_DIR:directory,HUOBAO_SMOKE_HUB:hubUrl}),windowsHide:true,stdio:['ignore','pipe','pipe','ipc']})
  firebo.stdout.on('data',chunk=>{diagnostics+=chunk.toString();diagnostics=diagnostics.slice(-12000)})
  firebo.stderr.on('data',chunk=>{fireboError+=chunk.toString();fireboError=fireboError.slice(-8000)})
  const fixture=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Firebo fixture did not become ready')),30000)
   firebo.once('message',message=>{clearTimeout(timer);resolve(message)});firebo.once('error',reject);firebo.once('exit',code=>{clearTimeout(timer);reject(Error('Firebo fixture exited '+code))})
  })
  assert.equal(fixture.ready,true)
  const config={service_type:'video',provider:'jimeng_local',name:'Synthetic isolated Jimeng',base_url:hubUrl,api_key:hubKey,model:['jimeng-2.0-fast'],is_active:true}
  const modelCheck=await api(fixture.url,'/api/v1/ai-configs/models',{method:'POST',body:config});assert.equal(modelCheck.status,200,JSON.stringify(modelCheck.value));assert(JSON.stringify(modelCheck.value).includes('jimeng-2.0-fast'))
  const connection=await api(fixture.url,'/api/v1/ai-configs/test',{method:'POST',body:config});assert.equal(connection.status,200,JSON.stringify(connection.value))
  const capture=()=>fs.readFile(path.join(directory,'capture.json'),'utf8').then(JSON.parse)
  assert.equal((await capture()).sent.length,0,'Model directory/connection check generated video')
  const saved=await api(fixture.url,'/api/v1/ai-configs',{method:'POST',body:config});assert.equal(saved.status,201,JSON.stringify(saved.value));const configId=saved.value.data.id
  const require=createRequire(path.join(backend,'package.json')),sharp=require('sharp')
  const images=[]
  for(const color of ['#b35d6a','#526d7d','#a5a25d'])images.push(await sharp({create:{width:4,height:3,channels:3,background:color}}).png().toBuffer())
  const names=['母亲','周启卧室','青铜宫灯'],referenceImages=images.map(bytes=>'data:image/png;base64,'+bytes.toString('base64'))
  const prompts=['🌙@母亲站A(X+0.8米，Y0)，在 @周启卧室拿起 @青铜宫灯。\n原文【特殊符号】与换行，禁止字幕。','【审核失败】🌙@母亲从桌边拿起空杯。场景：@周启卧室，道具：@青铜宫灯。']
  const finalTasks=[]
  for(let index=0;index<2;index++){
   const request={type:'video',config_id:configId,storyboard_id:fixture.storyboardIds[index],drama_id:fixture.dramaId,prompt:prompts[index],model:'jimeng-2.0-fast',duration:5,aspect_ratio:'16:9',reference_image_urls:referenceImages,reference_image_names:names}
   const accepted=await api(fixture.url,'/api/v1/tasks',{method:'POST',body:request});assert.equal(accepted.status,201,JSON.stringify(accepted.value));const id=accepted.value.data.id
   finalTasks.push(await condition(async()=>(await api(fixture.url,'/api/v1/tasks/'+id)).value.data,row=>row?.status!=='processing',{label:'Firebo terminal task '+id}))
  }
  const nativeCapture=await capture();assert.equal(nativeCapture.sent.length,2,'A model operation was duplicated')
  for(let i=0;i<2;i++){
   const sent=nativeCapture.sent[i],expected=fixture.style+'，\n'+prompts[i]
   assert.equal(sent.payload.prompt,expected,'Existing Firebo style assembly or prompt text changed')
   assert.equal(sent.payload.prompt_sha256,sha(Buffer.from(expected,'utf8')))
   assert.deepEqual(sent.payload.images.map(image=>image.name),names)
   assert.deepEqual(sent.payload.images.map(image=>Buffer.from(image.data_base64,'base64')),images)
   assert.deepEqual(sent.payload.images.map(image=>image.sha256),images.map(sha))
   assert.deepEqual(sent.payload.bindings.map(binding=>binding.token),['@母亲','@周启卧室','@青铜宫灯'])
   assert.equal(sent.message.endsWith(expected),true)
   const nativeText=sent.native_parts.map(part=>part.text||('mention' in part?'@':'')).join('')
   assert.equal(nativeText,sent.message,'Native reference compilation lost narration or Unicode')
   const attachments=sent.native_parts.filter(part=>part.file).map(part=>part.file),mentions=sent.native_parts.filter(part=>part.mention).map(part=>part.mention)
   assert.equal(attachments.length,3);assert.equal(mentions.length,3)
   assert.deepEqual(mentions.map(mention=>mention.file_id),attachments.map(file=>file.id))
   assert.deepEqual(mentions.map(mention=>mention.material.image_info.image_uri),attachments.map(file=>file.uri))
  }
  assert.equal(finalTasks[0].status,'completed');assert.equal(finalTasks[0].stage,'ready_in_local_service');assert.equal(JSON.parse(finalTasks[0].params).manualDelivery,true)
  assert.equal(finalTasks[0].resultUrl,null);assert.equal(finalTasks[0].localPath,null)
  assert.equal(finalTasks[1].status,'failed');assert.match(finalTasks[1].errorMsg,/参考图可能包含低俗内容/)
  const state=(await api(fixture.url,'/fixture/state')).value
  assert(state.storyboards.every(sb=>sb.videoUrl==='/static/synthetic-previous.mp4'),'Manual delivery or failure overwrote an existing preview')
  assert.equal(nativeCapture.downloads.length,0);assert.equal(nativeCapture.requests.filter(item=>item.path.endsWith('/content')).length,0)
  assert.equal(nativeCapture.requests.filter(item=>item.method==='POST'&&item.path==='/v1/videos').length,2)
  assert(requests.every(route=>route==='/v1/models'),'The GPT engine received a generation request')
  console.log(JSON.stringify({success:true,scope:'Firebo HTTP -> unified Hub -> Python Service -> synthetic native transport',billableRequests:0,realAccountsRead:false,createdNativeSubmissions:2,manualDelivery:true,explicitRejection:true,styleAndPromptExact:true,orderedOriginalImages:3,nativeMentionsVerified:true,modelAndConnectionChecksReadOnly:true},null,2))
 }catch(error){
  // These streams contain only synthetic fixtures, never user credentials.
  if(pythonError)console.error('Synthetic Python:',pythonError)
  if(fireboError)console.error('Synthetic Firebo:',fireboError)
  if(diagnostics)console.error('Synthetic route diagnostics:',diagnostics)
  throw error
 }finally{
  if(firebo?.connected)firebo.send({stop:true})
  if(running(firebo))await Promise.race([once(firebo,'exit'),wait(2500)])
  if(running(firebo)){firebo.kill();await once(firebo,'exit').catch(()=>{})}
  await closeServer(hub);await closeServer(gpt)
  if(running(python)){python.stdin.end('\n');await Promise.race([once(python,'exit'),wait(6000)])}
  if(running(python)){python.kill();await once(python,'exit').catch(()=>{})}
  const resolved=path.resolve(directory),temp=path.resolve(os.tmpdir())+path.sep
  assert(resolved.startsWith(temp)&&path.basename(resolved).startsWith('huobao-jimeng-service-smoke-'))
  await fs.rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200})
 }
}

if(process.argv.includes('--firebo-child'))await fireboChild()
else await run()
