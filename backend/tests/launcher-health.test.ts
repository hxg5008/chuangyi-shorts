import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'

const windows=process.platform==='win32'
const scripts=fileURLToPath(new URL('../../scripts/',import.meta.url))
const dependencies=fileURLToPath(new URL('../node_modules/',import.meta.url))
const quote=(value:string)=>"'"+value.replace(/'/gu,"''")+"'"
async function listen(server:http.Server){await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return(server.address()as any).port as number}
async function freePort(){const server=http.createServer();const port=await listen(server);await new Promise<void>(resolve=>server.close(()=>resolve()));assert.notEqual(port,5679);return port}
async function json(port:number){const response=await fetch(`http://127.0.0.1:${port}/api/v1/health`,{signal:AbortSignal.timeout(2000)});return response.json()as Promise<any>}
async function createFixture(port=0){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'huobao-launcher-health-'))
 const workspace=path.join(root,'fixture 工作台'),backend=path.join(workspace,'backend'),source=path.join(backend,'src'),nodeModules=path.join(backend,'node_modules')
 await fs.mkdir(source,{recursive:true});await fs.mkdir(path.join(workspace,'scripts'));await fs.mkdir(path.join(workspace,'frontend/.output/public'),{recursive:true})
 for(const name of ['local-common.ps1','local-start.ps1','local-stop.ps1','local-active-tasks.cjs'])await fs.copyFile(path.join(scripts,name),path.join(workspace,'scripts',name))
 await fs.symlink(dependencies,nodeModules,'junction')
 await fs.writeFile(path.join(backend,'package.json'),'{"type":"module"}')
 await fs.writeFile(path.join(workspace,'frontend/.output/public/index.html'),'<!doctype html><title>Isolated launcher fixture</title>')
 await fs.writeFile(path.join(source,'index.ts'),`import http from 'node:http';import fs from 'node:fs';import path from 'node:path';const directory=process.env.HUOBAO_DATA_DIR!;fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'test-backend-actual.pid'),String(process.pid));const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',processId:Number(process.env.TEST_HEALTH_PID)||process.pid,fixture:'isolated-fake-backend'}))});server.listen(Number(process.env.PORT),process.env.HOST,()=>console.log('fixture listening '+process.pid));process.on('SIGTERM',()=>server.close(()=>process.exit()));`)
 let chosen=port||await freePort(),sequence=0
 const configure=async(value:number)=>{chosen=value;await fs.writeFile(path.join(workspace,'network.json'),JSON.stringify({host:'0.0.0.0',port:value,public_origin:''}))}
 await configure(chosen)
 const run=async(code:string,environment:Record<string,string>={})=>{
  const filename=path.join(root,`probe-${sequence++}.ps1`)
  // PowerShell 5 needs a BOM for Unicode paths; the real launcher files stay ASCII.
  await fs.writeFile(filename,'\uFEFF$ErrorActionPreference = \'Stop\'\r\nfunction global:Get-NetTCPConnection { param($LocalPort,$State,$ErrorAction) return @() }\r\n'+code,'utf8')
  const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',filename],{windowsHide:true,cwd:workspace,env:{...process.env,HUOBAO_PROXY_URL:'direct',...environment}})
  let stdout='',stderr='';child.stdout.on('data',chunk=>{stdout+=chunk.toString('utf8')});child.stderr.on('data',chunk=>{stderr+=chunk.toString('utf8')})
  return await new Promise<{status:number|null;stdout:string;stderr:string}>((resolve,reject)=>{let finished=false;const timer=setTimeout(()=>{finished=true;child.kill();reject(Error('Isolated launcher PowerShell did not exit within 35 seconds: '+stdout+stderr))},35_000);child.on('error',error=>{if(finished)return;finished=true;clearTimeout(timer);reject(error)});const done=(status:number|null)=>{if(finished)return;finished=true;clearTimeout(timer);setTimeout(()=>{child.stdout.destroy();child.stderr.destroy();child.stdin.destroy();resolve({status,stdout,stderr})},50)};child.on('exit',done);child.on('close',done)})
 }
 const start=(environment:Record<string,string>={},prefix='')=>run(prefix+`\n& ${quote(path.join(workspace,'scripts/local-start.ps1'))} -NoBrowser -TimeoutSeconds 8\nexit $LASTEXITCODE\n`,environment)
 const stop=()=>run(`& ${quote(path.join(workspace,'scripts/local-stop.ps1'))} -Force\nexit $LASTEXITCODE\n`)
 const record=async()=>JSON.parse((await fs.readFile(path.join(workspace,'data/local-runtime/backend-process.json'),'utf8')).replace(/^\uFEFF/u,''))
 const cleanup=async()=>{
  try{await stop()}catch{}
  // A failed startup may have cleared its PID record. Only stop a process whose
  // command line still identifies this exact temporary entry, never an HTTP PID.
  try{const id=Number(await fs.readFile(path.join(workspace,'data/test-backend-actual.pid'),'utf8'));if(Number.isSafeInteger(id)&&id>0)await run(`. ${quote(path.join(workspace,'scripts/local-common.ps1'))}\n$process = Get-LocalProcess -ProcessId ${id}\nif(Test-LocalProjectProcess $process){ Stop-LocalProjectProcess $process }\n`)}catch{}
  const resolved=path.resolve(root),relative=path.relative(path.resolve(os.tmpdir()),resolved)
  assert(relative&&!path.isAbsolute(relative)&&!relative.startsWith('..')&&path.basename(resolved).startsWith('huobao-launcher-health-'))
  const remove=async(target:string):Promise<void>=>{const local=path.relative(resolved,path.resolve(target));assert(local===''||!path.isAbsolute(local)&&local!=='..'&&!local.startsWith('..'+path.sep));const stat=await fs.lstat(target);if(stat.isSymbolicLink()){await fs.unlink(target);return};if(stat.isDirectory()){const real=await fs.realpath(target);assert(real===resolved||real.startsWith(resolved+path.sep));for(const name of await fs.readdir(target))await remove(path.join(target,name));await fs.rmdir(target)}else await fs.unlink(target)}
  await remove(resolved)
 }
 return{root,workspace,run,start,stop,record,configure,cleanup,get port(){return chosen}}
}

test('0.0.0.0 health probes bypass an explicitly broken process proxy and start with TCP discovery unavailable',{skip:!windows,timeout:60_000},async()=>{
 const fixture=await createFixture();let proxyCalls=0
 const proxy=http.createServer((_req,res)=>{proxyCalls++;res.writeHead(502).end('fixture broken proxy')});const proxyPort=await listen(proxy)
 try{
  const strictProxy=`Add-Type -TypeDefinition @'\nusing System; using System.Net; public sealed class LauncherFixtureProxy : IWebProxy { public Uri Target; public LauncherFixtureProxy(string target){Target=new Uri(target);} public ICredentials Credentials {get;set;} public Uri GetProxy(Uri destination){return Target;} public bool IsBypassed(Uri destination){return false;} }\n'@\n[Net.WebRequest]::DefaultWebProxy = [LauncherFixtureProxy]::new('http://127.0.0.1:${proxyPort}')\n$control=[Net.HttpWebRequest]::Create('http://launcher-control.invalid/proxy-check');$control.Timeout=2000;try{$control.GetResponse().Dispose()}catch{}\n`
  const result=await fixture.start({},strictProxy);assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/is ready/u);assert.equal(proxyCalls,1,'only the deliberate control request reaches the broken proxy')
  const record=await fixture.record(),health=await json(fixture.port);assert.equal(health.processId,record.processId);assert.equal(record.port,fixture.port);assert.equal(health.fixture,'isolated-fake-backend')
  const probe=await fixture.run(`. ${quote(path.join(fixture.workspace,'scripts/local-common.ps1'))}\n@{url=$script:LocalHealthUrl;ready=(Test-LocalHealth -ExpectedProcessId ${record.processId})}|ConvertTo-Json -Compress\n`);assert.equal(probe.status,0,probe.stderr);assert(probe.stdout.includes(`http://127.0.0.1:${fixture.port}/api/v1/health`));assert(probe.stdout.includes('"ready":true'))
 }finally{await fixture.cleanup();await new Promise<void>(resolve=>proxy.close(()=>resolve()))}
})

test('real Windows launcher starts once, reuses the exact same PID, then stops without Get-NetTCPConnection data',{skip:!windows,timeout:60_000},async()=>{
 const fixture=await createFixture()
 try{const first=await fixture.start();assert.equal(first.status,0,first.stdout+first.stderr);const original=await fixture.record();const repeated=await fixture.start();assert.equal(repeated.status,0,repeated.stdout+repeated.stderr);assert.match(repeated.stdout,/already running/u);assert.equal((await fixture.record()).processId,original.processId);const stopped=await fixture.stop();assert.equal(stopped.status,0,stopped.stdout+stopped.stderr);await assert.rejects(json(fixture.port));await assert.rejects(fs.stat(path.join(fixture.workspace,'data/local-runtime/backend-process.json')))}finally{await fixture.cleanup()}
})

test('a healthy endpoint reporting another PID is rejected and is never taken as proof of a successful startup',{skip:!windows,timeout:60_000},async()=>{
 const fixture=await createFixture()
 try{const failed=await fixture.start({TEST_HEALTH_PID:'1'});assert.equal(failed.status,1,failed.stdout+failed.stderr);assert.match((failed.stdout+failed.stderr).replace(/\r?\n/gu,''),/another or older backend process/u);await assert.rejects(json(fixture.port));await assert.rejects(fs.stat(path.join(fixture.workspace,'data/local-runtime/backend-process.json')))}finally{await fixture.cleanup()}
})

test('direct health PID mismatch returns false without killing an already healthy backend',{skip:!windows,timeout:60_000},async()=>{
 const fixture=await createFixture()
 try{const started=await fixture.start();assert.equal(started.status,0,started.stdout+started.stderr);const before=await json(fixture.port),probe=await fixture.run(`. ${quote(path.join(fixture.workspace,'scripts/local-common.ps1'))}\n@{ready=(Test-LocalHealth -ExpectedProcessId 1);error=$script:LocalHealthError}|ConvertTo-Json -Compress\n`);assert.equal(probe.status,0,probe.stderr);assert(probe.stdout.includes('"ready":false'));assert.match(probe.stdout,/another or older backend/u);assert.equal((await json(fixture.port)).processId,before.processId)}finally{await fixture.cleanup()}
})

test('changing the configured port refuses to reuse or kill the old instance; stopping still uses its verified PID record',{skip:!windows,timeout:60_000},async()=>{
 const fixture=await createFixture(),foreign=http.createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',processId:process.pid,fixture:'unrelated-test-listener'}))}),newPort=await listen(foreign)
 assert.notEqual(newPort,5679)
 try{const started=await fixture.start();assert.equal(started.status,0,started.stdout+started.stderr);const oldPort=fixture.port,old=await fixture.record();await fixture.configure(newPort);const refused=await fixture.start();assert.equal(refused.status,1,refused.stdout+refused.stderr);assert.match((refused.stdout+refused.stderr).replace(/\r?\n/gu,''),/Network configuration changed/u);assert.equal((await fixture.record()).processId,old.processId);assert.equal((await json(oldPort)).processId,old.processId);assert.equal((await json(newPort)).fixture,'unrelated-test-listener');const stopped=await fixture.stop();assert.equal(stopped.status,0,stopped.stdout+stopped.stderr);await assert.rejects(json(oldPort));assert.equal((await json(newPort)).processId,process.pid)}finally{await fixture.cleanup();await new Promise<void>(resolve=>foreign.close(()=>resolve()))}
})
