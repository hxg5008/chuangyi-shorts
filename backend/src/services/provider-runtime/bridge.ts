import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {randomUUID,createHash} from 'node:crypto'
import {normalizeGenerationTypes} from './request-types.js'

const directory=path.dirname(fileURLToPath(import.meta.url))
const receiptPath=path.resolve(directory,'../../../provider-engine/engine-build.json')
let processHandle:ChildProcessWithoutNullStreams|null=null,buffer='',idle:NodeJS.Timeout|undefined
const pending=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>()
function refs(active:boolean){if(!processHandle)return;for(const value of [processHandle,processHandle.stdin,processHandle.stdout,processHandle.stderr]){const fn=(value as any)[active?'ref':'unref'];if(typeof fn==='function')fn.call(value)}}
function scheduleIdle(){if(pending.size)return;refs(false);clearTimeout(idle);idle=setTimeout(()=>shutdownProviderEngine(),30_000);idle.unref()}
function failAll(){for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error('协议解释器连接已中断；未重新提交模型请求'))};pending.clear();buffer=''}
function start(){
 if(processHandle)return processHandle
 const receipt=JSON.parse(fs.readFileSync(receiptPath,'utf8').replace(/^\uFEFF/u,'')),target=receipt.binaries?.[`${process.platform}-${process.arch}`]||(process.platform==='win32'&&process.arch==='x64'?{filename:'provider-engine-windows-amd64.exe',sha256:receipt.sha256}:null)
 if(!process.env.HUOBAO_PROVIDER_ENGINE_PATH&&!target)throw new Error('当前系统架构缺少预编译协议解释器，请使用对应平台的完整包')
 const defaultBinary=target?path.resolve(directory,'../../../provider-engine/bin',target.filename):''
 const binary=process.env.HUOBAO_PROVIDER_ENGINE_PATH||defaultBinary
 if(!fs.existsSync(binary))throw new Error('缺少随包提供的协议解释器，请完整解压更新包，无需安装Go')
 if(binary===defaultBinary){const actual=createHash('sha256').update(fs.readFileSync(binary)).digest('hex');if(actual!==target.sha256)throw new Error('协议解释器校验不一致，请恢复完整更新包');if(process.platform!=='win32'){try{fs.chmodSync(binary,0o755)}catch{/* Read-only containers must set the executable bit when building their image. */}}}
 const child=spawn(binary,[],{stdio:'pipe',windowsHide:true,env:{SYSTEMROOT:process.env.SYSTEMROOT,TEMP:process.env.TEMP,PATH:process.env.PATH}});processHandle=child
 child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk:string)=>{if(processHandle!==child)return;buffer+=chunk;if(buffer.length>180*1024*1024){failAll();child.kill();return};for(;;){const end=buffer.indexOf('\n');if(end<0)break;const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let reply:any;try{reply=JSON.parse(line)}catch{failAll();child.kill();return};if(!reply.id&&reply.error){failAll();child.kill();return};const item=pending.get(reply.id);if(!item)continue;pending.delete(reply.id);clearTimeout(item.timer);if(reply.error)item.reject(new Error(String(reply.error).slice(0,2000)));else item.resolve(reply.result)}scheduleIdle()})
 child.stderr.on('data',()=>{/* Interpreter diagnostics never disclose prompts or connection credentials. */})
 child.on('error',()=>{if(processHandle===child){processHandle=null;failAll()}});child.on('exit',()=>{if(processHandle===child){processHandle=null;failAll()}});return child
}
export function engineCall<T=any>(op:string,value:Record<string,unknown>={}):Promise<T>{
 if(value.request&&typeof value.request==='object')value={...value,request:normalizeGenerationTypes(value.request as any)}
 const child=start(),id=randomUUID();clearTimeout(idle);refs(true)
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('协议解释器处理超时，未重发模型请求'));scheduleIdle()},30_000);pending.set(id,{resolve,reject,timer});const request=JSON.stringify({...value,id,op})+'\n';if(Buffer.byteLength(request)>256*1024*1024){pending.delete(id);clearTimeout(timer);reject(new Error('协议解释请求超过256MB上限'));scheduleIdle();return};child.stdin.write(request,error=>{if(error){pending.delete(id);clearTimeout(timer);reject(new Error('无法写入协议解释器'));scheduleIdle()}})})
}
export function shutdownProviderEngine(){clearTimeout(idle);const child=processHandle;processHandle=null;if(child){child.stdin.end();child.kill()};failAll()}
