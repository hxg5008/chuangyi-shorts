import {createHash} from 'node:crypto'
import {engineCall} from './bridge.js'
import {applyProtocolAuth} from './auth.js'
import {mediaBytes,boundedResponseBytes,normalizeMediaRequest,inferMediaMime} from './media.js'
import {fetchProvider,fetchImageProvider,fetchTextProvider} from '../../utils/http.js'
import {registerRuntimeSecrets,redactRuntimeSecrets} from '../../utils/secret-redaction.js'
import {sanitizeActivity} from '../activity/sanitize.js'
import type {ProviderDefinition,ProviderCall,ProviderConnection,RequestSpec,BuiltProviderRequest,CompiledProvider,GenerationRequest,MediaReference,ParsedProviderResult} from './types.js'
import {NATIVE_AGENT_IDS,nativeAgentBody,nativeAgentResult,aggregateAgentSSE,nativeUsage} from './native-agent.js'
import {normalizeGenerationTypes} from './request-types.js'
import {withRequestLogContext} from '../request-logs/context.js'
import {prepare888Fast720Images} from '../adapters/888-fast720-upload.js'
export * from './types.js'
export {shutdownProviderEngine} from './bridge.js'
export {applyProtocolAuth} from './auth.js'

const cache=new Map<string,Promise<CompiledProvider>>()
const definitionKey=(value:ProviderDefinition)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export async function compileProvider(providerDefinition:ProviderDefinition):Promise<CompiledProvider>{
 const key=definitionKey(providerDefinition);let result=cache.get(key)
 if(!result){result=engineCall<CompiledProvider>('compile',{providerDefinition}).catch(error=>{cache.delete(key);return{executable:false,reason:redactRuntimeSecrets(error.message),metadata:null}});if(cache.size>=512)cache.delete(cache.keys().next().value!);cache.set(key,result)}
 const compiled=structuredClone(await result)
 if(compiled.metadata?.categories?.includes('text')&&!compiled.agentAvailable&&NATIVE_AGENT_IDS.has(compiled.metadata.id)){compiled.agentAvailable=true;(compiled as any).nativeAgent=true}
 return compiled
}
export const providerCatalog=()=>engineCall<CompiledProvider[]>('catalog')
export const loadProvider=compileProvider
function requestURL(base:string,spec:RequestSpec){
 const parsed=new URL(base);if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)throw Error('渠道Base URL格式不正确')
 if(!spec.path.startsWith('/')||spec.path.startsWith('//')||/[\r\n\\]/u.test(spec.path))throw Error('协议路径必须是同域相对路径')
 const prefixes=['/api/plan/v3','/api/v3','/api/v1','/v1beta','/v1','/v2','/v3'],trimmed=base.replace(/\/+$/u,''),requestPrefix=prefixes.find(p=>spec.path===p||spec.path.startsWith(p+'/')||spec.path.startsWith(p+'?'))||'',basePrefix=prefixes.find(p=>parsed.pathname.toLowerCase().replace(/\/+$/u,'').endsWith(p))||''
 let value:string
 if(spec.originPath)value=new URL(spec.path,parsed.origin).toString()
 else if(requestPrefix)value=(basePrefix?trimmed.slice(0,-basePrefix.length):trimmed)+spec.path
 else value=trimmed+(basePrefix?'':'/v1')+spec.path
 const url=new URL(value);if(url.origin!==parsed.origin)throw Error('协议请求不可更换渠道域名')
 for(const [key,values]of Object.entries(spec.query||{}))for(const value of values)url.searchParams.append(key,value)
 return url
}
async function serialize(spec:RequestSpec,connection:ProviderConnection):Promise<BuiltProviderRequest>{
 const method=spec.method.toUpperCase();if(!['GET','POST','PUT','PATCH','DELETE','HEAD'].includes(method))throw Error('协议HTTP方法不受支持')
 const headers=new Headers({...spec.headers,...connection.headers}),url=requestURL(connection.baseUrl,spec)
 let body:string|FormData|Uint8Array|undefined,bytes:Uint8Array|undefined
 const fileReceipts:unknown[]=[]
 if(spec.contentType==='multipart/form-data'){
  const form=new FormData();for(const [key,value]of Object.entries(spec.body||{})){if(value===undefined||value===null)continue;if(Array.isArray(value)){for(const part of value)form.append(key,typeof part==='object'?JSON.stringify(part):String(part))}else form.append(key,typeof value==='object'?JSON.stringify(value):String(value))}
  for(const file of spec.files||[]){const data=await mediaBytes(file.reference),mimeType=file.mimeType||data.mimeType,filename=file.filename||file.reference.name||'reference.bin';form.append(file.name,new Blob([new Uint8Array(data.bytes)],{type:mimeType}),filename);fileReceipts.push({name:file.name,filename,mimeType,bytes:data.bytes.length,sha256:createHash('sha256').update(data.bytes).digest('hex'),referenceId:file.reference.id,role:file.reference.role,order:file.reference.order})}
  headers.delete('content-type');body=form
  if(['aws-sigv4','volcengine-v4','tc3'].includes(spec.auth?.type||'')){const response=new Response(form);headers.set('Content-Type',response.headers.get('content-type')!);body=new Uint8Array(await response.arrayBuffer());bytes=body}
 }else if(spec.body!==undefined&&spec.body!==null){
  const content=spec.contentType||'application/json';headers.set('Content-Type',content)
  body=content.includes('application/x-www-form-urlencoded')?new URLSearchParams(Object.entries(spec.body).map(([key,value])=>[key,typeof value==='object'?JSON.stringify(value):String(value)])).toString():typeof spec.body==='string'?spec.body:JSON.stringify(spec.body)
  bytes=Buffer.from(body)
 }
 if(['GET','HEAD'].includes(method)){body=undefined;bytes=undefined}
 const secrets=[connection.apiKey,...Object.values(connection.authFields||{}),...Object.values(connection.headers||{})];registerRuntimeSecrets(secrets)
 applyProtocolAuth(url,headers,bytes,connection,spec.auth,undefined,method)
 const wireSummary=sanitizeActivity({method,url:url.toString(),headers:Object.fromEntries(headers),body:body instanceof FormData?{multipart:[...body.entries()].map(([name,value])=>({name,...(typeof value==='string'?{value}:{filename:value.name,size:value.size,mimeType:value.type})})),files:fileReceipts}:typeof body==='string'?body:body?{binaryBytes:body.byteLength,sha256:createHash('sha256').update(body).digest('hex'),files:fileReceipts}:undefined},secrets,1_000_000)
 return{url:url.toString(),method,headers:Object.fromEntries(headers),body,contentType:headers.get('content-type')||undefined,isBodySerialized:true,wireSummary,responseType:'json-or-binary',authSpec:spec.auth}
}
const context=(call:ProviderCall)=>({providerDefinition:call.providerDefinition,request:call.request,baseUrl:call.connection.baseUrl,model:call.model||call.request.model,taskId:call.taskId,metadata:call.metadata})
const nativeRootPath=new Set(['aws-bedrock-converse','aws-bedrock-invoke-model','azure-openai','ollama-chat'])
async function build(op:string,call:ProviderCall,extras:Record<string,unknown>={}){const spec=await engineCall<RequestSpec>(op,{...context(call),...extras});if(nativeRootPath.has(call.providerDefinition.providerId||''))spec.originPath=true;const request=await serialize(spec,call.connection);request.diagnosticPhase=op==='buildUpload'?'upload':op==='buildPoll'?'poll':op==='buildResult'?'download':op==='buildCancel'?'other':'generate';return request}
export async function sendProviderRequest(request:BuiltProviderRequest,signal?:AbortSignal,image:boolean|'text'=false){
 const send=()=> (image==='text'?fetchTextProvider:image?fetchImageProvider:fetchProvider)(request.url,{method:request.method,headers:request.headers,body:request.body as any,signal:signal||AbortSignal.timeout(600_000),redirect:'error'})
 const response=await(request.diagnosticPhase?withRequestLogContext({phase:request.diagnosticPhase},send):send())
 if(!response.ok){const bytes=await boundedResponseBytes(response,2*1024*1024),raw=Buffer.from(bytes).toString('utf8');throw Object.assign(new Error(`模型服务HTTP ${response.status}：${redactRuntimeSecrets(raw).slice(0,1000)}`),{statusCode:response.status,providerHttpStatus:response.status,submissionUnknown:response.status>=500})}
 return response
}
export async function decodeProviderResponse(response:Response){
 const bytes=await boundedResponseBytes(response);if(!bytes.length)return{}
 try{return JSON.parse(Buffer.from(bytes).toString('utf8'))}catch{return{__providerResponse:{bodyBase64:Buffer.from(bytes).toString('base64'),contentType:response.headers.get('content-type')||'application/octet-stream',statusCode:response.status}}}
}
function rawInput(raw:any){if(raw?.__providerResponse?.bodyBase64)return{rawBase64:raw.__providerResponse.bodyBase64};return{raw:raw instanceof Uint8Array?Buffer.from(raw).toString('utf8'):raw}}
function parsed(value:any):ParsedProviderResult{
 if(value.result){delete value.result.reasoning;delete value.result.Reasoning;for(const group of ['images','videos','audios'])for(const media of value.result[group]||[]){const inline=/^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(media.dataUrl||media.url||'');if(inline){media.bodyBase64=inline[2];media.mimeType=media.mimeType||inline[1]}}}
 if(['failed','cancelled'].includes(value.status))value.error=value.message||'上游任务未完成'
 if(value.result?.usage)value.usage=value.result.usage
 return value
}
export async function parseCreate(call:{providerDefinition:ProviderDefinition;raw:any;request?:GenerationRequest}){return parsed(await engineCall('parseCreate',{providerDefinition:call.providerDefinition,request:call.request,...rawInput(call.raw)}))}
export async function parsePoll(call:{providerDefinition:ProviderDefinition;raw:any;request?:GenerationRequest;taskId?:string;model?:string;metadata?:Record<string,unknown>}){return parsed(await engineCall('parsePoll',{providerDefinition:call.providerDefinition,request:call.request,taskId:call.taskId,model:call.model,metadata:call.metadata,...rawInput(call.raw)}))}
export async function buildCreate(call:ProviderCall){
 const info=await compileProvider(call.providerDefinition);if(!info.executable)throw Error(info.reason||'协议不可执行')
 const typed=normalizeGenerationTypes(call.request)
 const is888Fast720=call.providerDefinition.providerId==='888-seedance-fast720-local'
 // Validate controls before upload. Ownership validation remains before vendor hosting;
 // newly hosted URLs are not mistaken for an unrelated user's asset afterwards.
 if(is888Fast720)await engineCall('buildCreate',{...context(call),request:typed})
 let request=is888Fast720
  ?await prepare888Fast720Images(typed,call.connection)
  :await normalizeMediaRequest(typed,!!info.requiresPublicMediaUrls)
 if(info.uploadKinds?.length){const uploaded=new Map<string,string>();for(const key of ['images','videos','audios','inputs'] as const)for(const media of request[key]||[]){if(!info.uploadKinds.includes(media.kind||'')||!(media.url||media.dataUrl))continue;const identity=`${media.kind}\n${media.url||media.dataUrl}`;let id=uploaded.get(identity);if(!id){const upload=await buildUpload({...call,request,media}),response=await sendProviderRequest(upload,call.signal),result=await parseUpload({providerDefinition:call.providerDefinition,raw:await decodeProviderResponse(response)});id=result.id;uploaded.set(identity,id)}media.metadata={...media.metadata,uploadId:id}}}
 return{...await build('buildCreate',{...call,request}),request}
}
export const buildPoll=(call:ProviderCall)=>build('buildPoll',call)
export const buildCancel=(call:ProviderCall)=>build('buildCancel',call)
export const buildResult=(call:ProviderCall)=>build('buildResult',call)
export const buildUpload=(call:ProviderCall&{media:MediaReference})=>build('buildUpload',call,{media:call.media})
export const parseUpload=(call:{providerDefinition:ProviderDefinition;raw:any})=>engineCall<{id:string}>('parseUpload',{providerDefinition:call.providerDefinition,...rawInput(call.raw)})
export async function buildAgent(call:{providerDefinition:ProviderDefinition;connection:ProviderConnection;request:any;model?:string}){
 const info=await compileProvider(call.providerDefinition),model=call.model||call.request.model
 let spec:RequestSpec
 if((info as any).nativeAgent){
  const id=info.metadata.id,routing=Object.fromEntries(Object.entries(call.connection.authFields||{}).filter(([key])=>['project','location','region','apiVersion','api_version'].includes(key))),raw={...structuredClone(call.request),providerOptions:{...call.request.providerOptions,[id]:{...routing,...call.request.providerOptions?.[id]}}}
  if(['aws-bedrock-converse','aws-bedrock-invoke-model','ollama-chat'].includes(id)){
   for(const message of raw.chatCompletion?.messages||[])for(const part of Array.isArray(message.content)?message.content:[]){const source=part.type==='image_url'?part.image_url?.url:part.type==='file'?part.file?.file_data:null;if(typeof source==='string'&&!source.startsWith('data:')){const data=await mediaBytes({url:source});const value=`data:${data.mimeType};base64,${data.bytes.toString('base64')}`;if(part.type==='image_url')part.image_url.url=value;else part.file.file_data=value}}
   if(id==='aws-bedrock-invoke-model')for(const message of raw.claude?.messages||[])for(const part of Array.isArray(message.content)?message.content:[])if(part.type==='image'&&part.source?.type==='url'){const data=await mediaBytes({url:part.source.url});part.source={type:'base64',media_type:data.mimeType,data:data.bytes.toString('base64')}}
  }
  const request:GenerationRequest={capability:'text',model,messages:raw.chatCompletion?.messages||[],providerOptions:raw.providerOptions,extra:raw.chatCompletion||{}}
  spec=await engineCall<RequestSpec>('buildCreate',{providerDefinition:call.providerDefinition,baseUrl:call.connection.baseUrl,request});spec.body=nativeAgentBody(id,model,raw);spec.contentType='application/json'
 }else spec=await engineCall<RequestSpec>('buildAgent',{providerDefinition:call.providerDefinition,baseUrl:call.connection.baseUrl,model,agent:call.request})
 if(nativeRootPath.has(info.metadata?.id||''))spec.originPath=true
 const request=await serialize(spec,call.connection);request.diagnosticPhase='generate';return request
}
export async function parseAgent(call:{providerDefinition:ProviderDefinition;raw:any}){
 const info=await compileProvider(call.providerDefinition),raw=aggregateAgentSSE(call.raw)
 const preflight=await engineCall<any>('parseCreate',{providerDefinition:call.providerDefinition,...rawInput(raw)})
 if(preflight.status==='failed'||raw?.error&&raw.error!==false)throw Object.assign(new Error(redactRuntimeSecrets(preflight.message||raw?.error?.message||'模型服务返回错误状态')),{isRetryable:false})
 if((info as any).nativeAgent){const result=nativeAgentResult(info.metadata.id,typeof raw==='string'?JSON.parse(raw):raw);return{...result,usage:nativeUsage(raw)}}
 const result=await engineCall<any>('parseAgent',{providerDefinition:call.providerDefinition,...rawInput(raw)});return{text:result.text||'',toolCalls:(result.toolCalls||[]).map((item:any)=>({id:item.ID||item.id,name:item.Name||item.name,arguments:item.Arguments??item.arguments,thoughtSignature:item.ThoughtSignature||item.thoughtSignature||undefined})),usage:nativeUsage(raw),finishReason:raw?.choices?.[0]?.finish_reason||raw?.stopReason||raw?.stop_reason}
}
async function fetchResultRequest(request:BuiltProviderRequest,call:ProviderCall):Promise<Response>{
 if(request.method!=='GET')return sendProviderRequest(request,call.signal)
 let target=new URL(request.url),headers=new Headers(request.headers),leftOrigin=false
 const origin=target.origin,signal=call.signal||AbortSignal.timeout(600_000)
 for(let redirects=0;redirects<=5;redirects++){
  const response=await withRequestLogContext({phase:'download'},()=>fetchProvider(target,{method:'GET',headers,signal,redirect:'manual'}))
  if(![301,302,303,307,308].includes(response.status)){
   if(!response.ok){const bytes=await boundedResponseBytes(response,2*1024*1024);throw Object.assign(new Error(`模型结果下载HTTP ${response.status}：${redactRuntimeSecrets(Buffer.from(bytes).toString('utf8')).slice(0,1000)}`),{statusCode:response.status})}
   return response
  }
  const location=response.headers.get('location');await response.body?.cancel()
  if(!location||redirects===5)throw Error('模型结果下载重定向无效或超过5跳')
  const next=new URL(location,target);if(!['http:','https:'].includes(next.protocol)||next.username||next.password)throw Error('模型结果下载重定向地址不正确')
  if(next.origin!==target.origin){headers=new Headers();leftOrigin=true}
  else if(!leftOrigin&&next.origin===origin)applyProtocolAuth(next,headers,undefined,call.connection,request.authSpec,undefined,'GET')
  target=next
 }
 throw Error('模型结果下载重定向超过5跳')
}
export async function executeResult(call:ProviderCall):Promise<ParsedProviderResult>{const request=await buildResult(call),response=await fetchResultRequest(request,call),bytes=await boundedResponseBytes(response),mimeType=inferMediaMime(bytes,response.headers.get('content-type')||'application/octet-stream'),kind=mimeType.startsWith('image/')?'images':mimeType.startsWith('audio/')?'audios':mimeType.startsWith('video/')?'videos':call.request.capability==='image'?'images':call.request.capability==='audio'?'audios':'videos';return{status:'succeeded',taskId:call.taskId,result:{[kind]:[{bodyBase64:Buffer.from(bytes).toString('base64'),mimeType}]}}}
export async function submitProvider(call:ProviderCall){const request=await buildCreate(call),response=await sendProviderRequest(request,call.signal,call.request.capability==='text'?'text':call.request.capability==='image');return{...await parseCreate({providerDefinition:call.providerDefinition,request:request.request,raw:await decodeProviderResponse(response)}),request:request.request,wireSummary:request.wireSummary}}
export async function pollProvider(call:ProviderCall){const request=await buildPoll(call),response=await sendProviderRequest(request,call.signal);let result=await parsePoll({...call,raw:await decodeProviderResponse(response)});if(result.status==='succeeded'&&!result.result&&(await compileProvider(call.providerDefinition)).resultAvailable)result=await executeResult(call);return result}
export async function cancelProvider(call:ProviderCall){
 const request=await buildCancel(call),response=await sendProviderRequest(request,call.signal),httpStatus=response.status,raw=await decodeProviderResponse(response)
 const error=raw?.error,code=raw?.code??raw?.error_code??raw?.errorCode??raw?.base_resp?.status_code
 const successCodes=['0','200','202','204','ok','success','succeeded','accepted'],failedCode=(value:any)=>value!==undefined&&value!==null&&!successCodes.includes(String(value).toLowerCase())
 const errorFailure=typeof error==='string'?!!error.trim():error&&((error.code===undefined&&!!error.message)||failedCode(error.code))
 if(raw?.success===false||raw?.ok===false||errorFailure||failedCode(code))throw Object.assign(new Error(redactRuntimeSecrets(raw?.message||raw?.msg||error?.message||(typeof error==='string'?error:'上游拒绝取消任务'))),{isRetryable:false})
 let result:ParsedProviderResult|undefined
 if(httpStatus!==204){try{result=await parsePoll({...call,raw})}catch{/* A plain acknowledgement is accepted, never treated as a confirmed cancellation. */}}
 if(result?.status==='failed')throw Object.assign(new Error(redactRuntimeSecrets(result.error||result.message||'上游拒绝取消任务')),{isRetryable:false})
 return{requested:true,confirmed:result?.status==='cancelled',taskId:call.taskId,status:result?.status,httpStatus}
}
