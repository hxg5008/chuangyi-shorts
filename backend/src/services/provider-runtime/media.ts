import fs from 'node:fs/promises'
import path from 'node:path'
import {STORAGE_ROOT} from '../../utils/paths.js'
import {saveUploadedFile} from '../../utils/storage.js'
import {fetchProvider} from '../../utils/http.js'
import {currentActor,assertMediaAccess,normalizePrivateMediaPath,registerPrivateMedia,signedProviderMediaUrl} from '../platform-security/index.js'
import type {GenerationRequest,MediaReference} from './types.js'

const maximum=75*1024*1024
export function inferMediaMime(bytes:Uint8Array,fallback='application/octet-stream'){
 const value=Buffer.from(bytes.buffer,bytes.byteOffset,Math.min(bytes.byteLength,32))
 if(value.length>=8&&value.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return'image/png'
 if(value[0]===255&&value[1]===216&&value[2]===255)return'image/jpeg'
 if(value.subarray(0,4).toString()==='RIFF'&&value.subarray(8,12).toString()==='WEBP')return'image/webp'
 if(/^GIF8[79]a/u.test(value.toString('ascii',0,6)))return'image/gif'
 if(value.subarray(4,8).toString()==='ftyp')return'video/mp4'
 if(value.subarray(0,4).equals(Buffer.from([26,69,223,163])))return'video/webm'
 if(value.subarray(0,3).toString()==='ID3'||value[0]===255&&(value[1]&224)===224)return'audio/mpeg'
 if(value.subarray(0,4).toString()==='RIFF'&&value.subarray(8,12).toString()==='WAVE')return'audio/wav'
 return fallback.split(';')[0]||'application/octet-stream'
}
export async function mediaBytes(reference:MediaReference):Promise<{bytes:Buffer;mimeType:string}>{
 const source=reference.dataUrl||reference.url||'';if(currentActor())assertMediaAccess(source)
 const inline=/^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(source)
 if(inline){const bytes=Buffer.from(inline[2],'base64');if(bytes.length>maximum)throw Error('参考素材超过75MB');return{bytes,mimeType:reference.mimeType||inline[1]}}
 const relative=normalizePrivateMediaPath(source)
 if(relative){const root=await fs.realpath(STORAGE_ROOT),target=await fs.realpath(path.join(root,relative.slice(7))),rest=path.relative(root,target);if(!rest||path.isAbsolute(rest)||rest==='..'||rest.startsWith('..'+path.sep))throw Error('素材路径越界');const stat=await fs.stat(target);if(!stat.isFile()||stat.size>maximum)throw Error('素材不存在或超过75MB');const ext=path.extname(target).toLowerCase();return{bytes:await fs.readFile(target),mimeType:reference.mimeType||({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.mp4':'video/mp4','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4'} as Record<string,string>)[ext]||'application/octet-stream'}}
 const url=new URL(source);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw Error('不支持的素材地址')
 const response=await fetchProvider(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(60_000)});if(!response.ok){await response.body?.cancel();throw Error(`参考素材读取失败（HTTP ${response.status}）`)}
 const bytes=Buffer.from(await boundedResponseBytes(response,maximum));return{bytes,mimeType:inferMediaMime(bytes,reference.mimeType||response.headers.get('content-type')||'application/octet-stream')}
}
export async function boundedResponseBytes(response:Response,maximum=128*1024*1024){
 if(Number(response.headers.get('content-length'))>maximum){await response.body?.cancel();throw Error('上游响应超过大小上限')};const reader=response.body?.getReader();if(!reader)return new Uint8Array();const parts:Uint8Array[]=[];let size=0
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>maximum)throw Error('上游响应超过大小上限');parts.push(part.value)}}finally{await reader.cancel().catch(()=>{})}
 return Buffer.concat(parts,size)
}
export async function normalizeMediaRequest(input:GenerationRequest,publicURLs:boolean):Promise<GenerationRequest>{
 const request=structuredClone(input),cache=new Map<string,Promise<MediaReference>>()
 const normalize=(ref:MediaReference,kind:string)=>{
  const source=ref.dataUrl||ref.url;if(!source)return Promise.resolve({...ref,kind:ref.kind||kind})
  const key=`${source}\n${kind}`;let value=cache.get(key)
  if(!value){value=(async()=>{if(currentActor())assertMediaAccess(source);const relative=normalizePrivateMediaPath(source)
   if(publicURLs){if(relative)return{...ref,url:signedProviderMediaUrl(source),dataUrl:undefined};if(source.startsWith('data:')){const data=await mediaBytes(ref),ext=data.mimeType.split('/')[1]?.replace(/[^a-z0-9]/giu,'')||'bin',file=await saveUploadedFile(data.bytes.buffer.slice(data.bytes.byteOffset,data.bytes.byteOffset+data.bytes.byteLength) as ArrayBuffer,'provider-references','reference.'+ext);registerPrivateMedia(file);return{...ref,url:signedProviderMediaUrl(file),dataUrl:undefined}};return{...ref,url:source,dataUrl:undefined}}
   if(relative){const data=await mediaBytes(ref);return{...ref,url:undefined,dataUrl:`data:${data.mimeType};base64,${data.bytes.toString('base64')}`,mimeType:data.mimeType}}
   return{...ref}
  })();cache.set(key,value)}
  return value.then(normalized=>({...normalized,...ref,...(normalized.dataUrl?{url:undefined,dataUrl:normalized.dataUrl}:{url:normalized.url,dataUrl:undefined}),kind:ref.kind||kind,mimeType:normalized.mimeType||ref.mimeType}))
 }
 for(const field of ['images','videos','audios','inputs'] as const)if(request[field])request[field]=await Promise.all(request[field]!.map(ref=>normalize(ref,field==='images'?'image':field==='videos'?'video':field==='audios'?'audio':ref.kind||'image')))
 return request
}
