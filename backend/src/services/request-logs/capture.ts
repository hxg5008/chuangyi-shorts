import { createHash } from 'node:crypto'
import { currentRequestLogContext, type RequestLogContext } from './context.js'
import { RequestLogStore, requestLogStore, setRequestLogStore } from './store.js'
import { sanitizeActivity } from '../activity/sanitize.js'
import { currentActivity } from '../activity/context.js'
import { currentActor } from '../platform-security/access.js'
import { setProviderHttpObserver, type ProviderHttpObservation } from '../../utils/http.js'
import type Database from 'better-sqlite3'

const LIMIT=256*1024
const sensitive=/authorization|cookie|password|api.?key|access.?token|refresh.?token|credential|signature|secret|^key$|^token$|^sig$|^auth$/iu
const safeId=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/u.test(value)&&!/^sk-/iu.test(value)?value:undefined
const safeLogId=(value:unknown,secrets:string[])=>typeof value==='string'&&!secrets.some(secret=>secret&&(value===secret||secret.length>3&&value.includes(secret)))&&sanitizeActivity(value,secrets,2000)===value?safeId(value):undefined
const safely=(run:()=>void)=>{try{run()}catch{/* Recording must not replace a model result/error. */}}
function collectSecret(value:string,secrets:string[]){if(value)secrets.push(value);for(const part of value.split(/[,;]\s*/u)){const auth=/^(?:Bearer|Basic)\s+(.+)$/iu.exec(part);if(auth)secrets.push(auth[1]);const cookie=/^[^=\s]+=([^;]+)$/u.exec(part);if(cookie)secrets.push(cookie[1])}}
function collectBodySecrets(value:any,secrets:string[],depth=0,parentSecret=false){if(depth>16)return;if(typeof value==='string'){if(parentSecret)collectSecret(value,secrets);return}if(!value||typeof value!=='object')return;for(const [key,part]of Object.entries(value))collectBodySecrets(part,secrets,depth+1,parentSecret||sensitive.test(key))}
const publicHeader=/^(?:accept(?:-encoding|-language)?|content-type|content-length|cache-control|user-agent|date|server|retry-after|x-request-id|request-id|x-oneapi-request-id|trace-id|traceparent|cf-ray|x-ratelimit-[a-z-]+)$/iu
function collectHeaderSecrets(value:HeadersInit|undefined,secrets:string[]){new Headers(value).forEach((v,k)=>{if(sensitive.test(k)||!publicHeader.test(k))collectSecret(v,secrets)})}
function headers(value:HeadersInit|undefined,secrets:string[]){const result:Record<string,string>={};const values=new Headers(value);collectHeaderSecrets(values,secrets);values.forEach((v,k)=>{result[k]=sensitive.test(k)||!publicHeader.test(k)?'[凭据已隐藏]':String(sanitizeActivity(v,secrets,2000))});return result}
function endpoint(value:string,secrets:string[]){try{const url=new URL(value);if(url.username)secrets.push(url.username);if(url.password)secrets.push(url.password);url.username='';url.password='';const entries=[...url.searchParams];for(const[k,v]of entries)if(sensitive.test(k))collectSecret(v,secrets);for(const[k]of entries)if(sensitive.test(k))url.searchParams.set(k,'[已隐藏]');return{url:String(sanitizeActivity(url.href,secrets,4000)),path:String(sanitizeActivity(url.pathname,secrets,2000)),origin:url.origin}}catch{return{url:'[无效地址]',path:'[无效地址]',origin:''}}}
function jsonValue(raw:string,secrets:string[]){try{return sanitizeActivity(responseSafe(JSON.parse(raw),secrets,true),secrets,LIMIT)}catch{return sanitizeActivity(raw,secrets,LIMIT)}}
function responseSafe(value:any,secrets:string[],request=false):any{
  if(Array.isArray(value))return value.map(item=>responseSafe(item,secrets,request)).filter(item=>item!==undefined)
  if(value&&typeof value==='object'){
    if(value.thought===true||typeof value.type==='string'&&/reasoning|thinking|hidden.thought|chain.of.thought/iu.test(value.type))return undefined
    return Object.fromEntries(Object.entries(value).filter(([key,item])=>{const k=key.replace(/[_-]/gu,'').toLowerCase();if(['reasoningcontent','reasoningtext','reasoningdelta','chainofthought','hiddenthought','thoughtsignature'].includes(k))return false;return !['reasoning','thinking','analysis'].includes(k)||request&&typeof item==='object'}).map(([key,item])=>[key,responseSafe(item,secrets,request)]))
  }
  return sanitizeActivity(value,secrets,LIMIT)
}
export async function describeRequestBody(body:BodyInit|null|undefined,secrets:string[]=[]):Promise<{body:unknown;recorded:boolean;truncated:boolean;model?:string}>{
  if(body==null)return{body:null,recorded:true,truncated:false}
  if(typeof body==='string'){
    if(Buffer.byteLength(body)<=LIMIT){try{collectBodySecrets(JSON.parse(body),secrets)}catch{}}
    const truncated=Buffer.byteLength(body)>LIMIT
    if(truncated)return{body:{omitted:'请求正文超过日志上限，原请求未改动',bytes:Buffer.byteLength(body)},recorded:true,truncated:true,model:safeId(/"model"\s*:\s*"([^"\r\n]{1,160})"/u.exec(body.slice(0,4000))?.[1])}
    // Parse bounded JSON before redaction; raw media-bearing JSON must not leak
    // a truncated base64 prefix when parsing is no longer possible.
    if(truncated && /base64|b64_json|inlineData|data:image|data:audio|data:video/iu.test(body))return{body:{omitted:'含媒体字节的大型请求已省略',bytes:Buffer.byteLength(body)},recorded:true,truncated:true}
    const value=jsonValue(body,secrets),model=typeof value==='object'&&value&&'model'in value?safeId((value as any).model):undefined
    return{body:value,recorded:true,truncated,model:safeLogId(model,secrets)}
  }
  if(body instanceof URLSearchParams){const values:Record<string,string[]>={};let size=0,n=0,truncated=false;for(const[k,v]of body){size+=Buffer.byteLength(k)+Buffer.byteLength(v);if(++n>100||size>LIMIT){truncated=true;break}if(sensitive.test(k))collectSecret(v,secrets);(values[k]??=[]).push(sensitive.test(k)?'[凭据已隐藏]':String(sanitizeActivity(v,secrets,LIMIT)))}return{body:values,recorded:true,truncated,model:safeLogId(body.get('model'),secrets)}}
  if(body instanceof FormData){
    // Freeze the field sequence synchronously, before the first hash await.
    const snapshot:Array<[string,FormDataEntryValue]>=[];let overflow=false
    for(const entry of body){if(snapshot.length>=100){overflow=true;break}snapshot.push(entry)}
    for(const[name,value]of snapshot)if(typeof value==='string'&&sensitive.test(name))collectSecret(value,secrets)
    const entries:any[]=[];let size=0,hashBytes=0,truncated=overflow,model:string|undefined
    for(const[name,value]of snapshot){
      if(typeof value==='string'){size+=Buffer.byteLength(value);if(size>LIMIT){truncated=true;entries.push({name,omitted:'字段超长'});continue}entries.push({name,value:sensitive.test(name)?'[凭据已隐藏]':jsonValue(value,secrets)});if(name==='model')model=safeLogId(value,secrets)}
      else{const receipt:any={name,filename:String(sanitizeActivity(value.name,secrets,300)),mime_type:value.type,size:value.size};if(value.size+hashBytes<=64*1024*1024){hashBytes+=value.size;const digest=createHash('sha256');for await(const part of value.stream())digest.update(part);receipt.sha256=digest.digest('hex')}else{receipt.hash_omitted='超过日志哈希预算';truncated=true}entries.push(receipt)}
    }
    return{body:{multipart:entries,media_bytes_omitted:true},recorded:true,truncated,model}
  }
  if(body instanceof Blob)return{body:{binary_bytes:body.size,mime_type:body.type},recorded:true,truncated:false}
  if(ArrayBuffer.isView(body))return{body:{binary_bytes:body.byteLength},recorded:true,truncated:false}
  if(body instanceof ArrayBuffer)return{body:{binary_bytes:body.byteLength},recorded:true,truncated:false}
  return{body:{omitted:'流式请求体未额外读取'},recorded:false,truncated:false}
}
function responseBody(bytes:Buffer,mime:string,secrets:string[],truncated:boolean){
  if(!/json|text|event-stream|xml|javascript/iu.test(mime))return{body:{binary_bytes_captured:bytes.length,mime_type:mime,omitted:'媒体字节未记录'},recorded:true}
  const text=bytes.toString('utf8')
  if(/event-stream/iu.test(mime)){
    const frames:any[]=[]
    for(const line of text.split(/\r?\n/u))if(line.startsWith('data:')){
      const data=line.slice(5).trim();if(data==='[DONE]'){frames.push('[DONE]');continue}
      try{const clean=responseSafe(JSON.parse(data),secrets);if(clean!==undefined)frames.push(clean)}catch{if(!truncated)frames.push({unparsed_omitted:true})}
    }
    return{body:{event_stream:frames,truncated},recorded:true}
  }
  // A clipped non-structured response can end in a credential prefix which
  // cannot be matched by the full-secret redactor. Do not persist that prefix.
  if(truncated)return{body:{omitted:'响应超过日志采样上限，未保存不完整正文',captured_bytes:bytes.length},recorded:true}
  if(truncated&&/base64|b64_json|inlineData|data:image|data:audio|data:video/iu.test(text))return{body:{omitted:'含媒体字节的大型响应已省略',captured_bytes:bytes.length},recorded:true}
  if(truncated&&/json/iu.test(mime)){try{JSON.parse(text)}catch{return{body:{omitted:'超长JSON响应未完整采样，不展示不完整敏感字段',captured_bytes:bytes.length},recorded:true}}}
  try{return{body:responseSafe(JSON.parse(text),secrets),recorded:true}}catch{return{body:jsonValue(text,secrets),recorded:true}}
}
function infer(input:ProviderHttpObservation,url:string,body:unknown,context:RequestLogContext){
  const method=(input.init?.method||(input.input instanceof Request?input.input.method:'GET')).toUpperCase()
  const path=(()=>{try{return new URL(url).pathname}catch{return''}})()
  const obvious=/upload|files$/iu.test(path)?'upload':/content$|download|\.(?:png|jpg|jpeg|webp|mp4|mp3|wav|m4a)(?:$|\?)/iu.test(path)?'download':method==='GET'&&/task|prediction|video|generation/iu.test(path)?'poll':null
  const phase=obvious||(context.phase==='generate'&&method==='GET'?'download':context.phase)||(method==='POST'&&/chat|completion|response|generate|image|video|invoke|converse/iu.test(path)?'generate':'other')
  const kind=context.kind||input.kind||(/image/iu.test(path)?'image':/video/iu.test(path)?'video':/chat|completion|response|generateContent|converse/iu.test(path)?'text':'unknown')
  return{method,phase,kind,model:context.model||((body as any)?.model)}
}
function enrich(store:RequestLogStore,context:RequestLogContext,origin:string,model?:string|null){
  const sql=store.sql,exists=(name:string)=>!!sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
  const result={...context}
  if(result.projectId&&result.projectOwnerId==null&&exists('dramas'))result.projectOwnerId=(sql.prepare('SELECT owner_user_id FROM dramas WHERE id=?').get(result.projectId) as any)?.owner_user_id??null
  if(result.configId&&(!result.channelId||!result.channelName)&&exists('platform_channel_models')&&exists('platform_model_channels')){
    const binding=sql.prepare('SELECT m.channel_id,c.name FROM platform_channel_models m JOIN platform_model_channels c ON c.id=m.channel_id WHERE m.config_id=?').get(result.configId) as any
    if(binding){result.channelId??=binding.channel_id;result.channelName||=binding.name}
  }
  if(!result.configId&&model&&exists('platform_channel_models')&&exists('platform_model_channels')){
    const candidates=(sql.prepare('SELECT m.config_id,m.channel_id,c.name,c.base_url FROM platform_channel_models m JOIN platform_model_channels c ON c.id=m.channel_id WHERE m.model=? AND m.deleted_at IS NULL AND c.deleted_at IS NULL').all(model) as any[]).filter(r=>{try{return new URL(r.base_url).origin===origin}catch{return false}})
    if(candidates.length===1){result.configId=candidates[0].config_id;result.channelId=candidates[0].channel_id;result.channelName=candidates[0].name}
  }
  return result
}
/** Observe a single fetch. No response clone, eager drain, retry or global fetch replacement. */
export async function captureProviderRequest(input:ProviderHttpObservation,next:()=>Promise<Response>):Promise<Response>{
  const store=requestLogStore();if(!store)return next()
  const activity=currentActivity(),context=currentRequestLogContext()||{},actor=currentActor()
  const inherited:RequestLogContext={taskId:activity?.taskId,projectId:activity?.projectId,episodeId:activity?.episodeId,actorUserId:actor?.id??activity?.userId,...context}
  const rawUrl=input.input instanceof Request?input.input.url:String(input.input),secrets:string[]=[]
  const headerInput=input.init?.headers||(input.input instanceof Request?input.input.headers:undefined)
  collectHeaderSecrets(headerInput,secrets)
  const requestBody=input.init?.body
  if(typeof requestBody==='string'&&Buffer.byteLength(requestBody)<=LIMIT){try{collectBodySecrets(JSON.parse(requestBody),secrets)}catch{}}
  else if(requestBody instanceof FormData||requestBody instanceof URLSearchParams){let count=0;for(const[k,v]of requestBody){if(++count>100)break;if(typeof v==='string'&&sensitive.test(k))collectSecret(v,secrets)}}
  const target=endpoint(rawUrl,secrets),requestHeaders=headers(headerInput,secrets)
  const classified=infer(input,rawUrl,undefined,inherited),started=performance.now()
  let id:string|undefined
  safely(()=>{const metadata=enrich(store,inherited,target.origin,inherited.model);id=store.begin({...metadata,...classified,model:safeLogId(classified.model,secrets),upstreamTaskId:safeLogId(metadata.upstreamTaskId,secrets),channelName:metadata.channelName?String(sanitizeActivity(metadata.channelName,secrets,1000)):undefined,url:target.url,path:target.path,parentId:inherited.parentId||store.correlate(inherited.taskId,classified.phase)},secrets)})
  if(!id)return next()
  const logId=id
  const body=input.init&&Object.hasOwn(input.init,'body')?input.init.body:input.input instanceof Request?input.input.body:undefined
  void describeRequestBody(body,secrets).then(snapshot=>safely(()=>{store.request(logId,requestHeaders,snapshot.body,snapshot.recorded,snapshot.truncated);if(snapshot.model){const metadata=enrich(store,inherited,target.origin,snapshot.model);store.metadata(logId,{...metadata,model:snapshot.model},secrets)}})).catch(()=>{})
  let response:Response
  try{response=await next()}catch(error:any){safely(()=>store.finish(logId,{status:error?.name==='AbortError'?'cancelled':'failed',elapsed:performance.now()-started,error:String(sanitizeActivity(error?.message||error,secrets,2000))},secrets));throw error}
  const responseHeaders=headers(response.headers,secrets),upstream=safeLogId(response.headers.get('x-request-id')||response.headers.get('request-id')||response.headers.get('x-oneapi-request-id')||response.headers.get('trace-id'),secrets)
  safely(()=>store.headers(logId,response.status,responseHeaders,performance.now()-started,upstream,secrets))
  const mime=response.headers.get('content-type')||'',parts:Buffer[]=[],binary=!/json|text|event-stream|xml|javascript/iu.test(mime)
  let captured=0,total=0,ended=false,first=false
  const finish=(state:string,error?:unknown)=>{
    if(ended)return;ended=true
    const elapsed=performance.now()-started,truncated=total>captured&&!binary
    // Snapshot preparation/storage runs after consumer completion, never before
    // delivering its final chunk or replacing an upstream error.
    setImmediate(()=>safely(()=>{
      const snapshot=responseBody(Buffer.concat(parts),mime,secrets,truncated),obj=snapshot.body as any
      if(binary&&obj)obj.binary_bytes=total
      const providerError=typeof obj?.error==='string'?obj.error:typeof obj?.error?.message==='string'?obj.error.message:undefined
      const businessStatus=providerError?'failed':safeId(obj?.status||obj?.state||obj?.data?.status||obj?.data?.state)
      const taskId=safeId(obj?.task_id||obj?.taskId||obj?.data?.task_id||obj?.data?.taskId||(['image','video'].includes(classified.kind)?obj?.id:undefined))
      store.finish(logId,{status:response.ok?state:'failed',elapsed,body:snapshot.body,recorded:snapshot.recorded,truncated,bytes:total,error:error?String(sanitizeActivity((error as any)?.message||error,secrets,2000)):response.ok?providerError:`HTTP ${response.status}`,upstreamTaskId:taskId,businessStatus},secrets)
    }))
  }
  if(!response.body){finish('succeeded');return response}
  const reader=response.body.getReader()
  const stream=new ReadableStream<Uint8Array>({
    async pull(controller){try{
      const value=await reader.read()
      if(value.done){finish('succeeded');controller.close();return}
      if(!first){first=true;safely(()=>store.firstByte(logId,performance.now()-started))}
      total+=value.value.byteLength
      if(!binary&&captured<LIMIT){const piece=Buffer.from(value.value.subarray(0,LIMIT-captured));parts.push(piece);captured+=piece.length}
      controller.enqueue(value.value)
    }catch(error){finish('failed',error);controller.error(error)}},
    async cancel(reason){finish('cancelled',reason);return reader.cancel(reason)},
  },{highWaterMark:0})
  const wrapped=new Response(stream,{status:response.status,statusText:response.statusText,headers:response.headers})
  function preserve<T extends Response>(value:T):T{
    for(const key of ['url','redirected','type'] as const)Object.defineProperty(value,key,{value:response[key],configurable:true})
    const clone=value.clone.bind(value);Object.defineProperty(value,'clone',{value:()=>preserve(clone()),configurable:true})
    return value
  }
  return preserve(wrapped)
}
export function installRequestLogging(sql:Database.Database){const store=new RequestLogStore(sql);store.markInterrupted();setRequestLogStore(store);setProviderHttpObserver(captureProviderRequest);return store}
