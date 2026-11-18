/** Immutable original-byte reference snapshots, strictly inside approved roots.
 * No arbitrary URLs, filesystem paths, compression or image substitution. */
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import sharp from 'sharp'
import {DATA_ROOT,STORAGE_ROOT} from '../utils/paths.js'
import {jimengError,validateJimengVideoRecord,type JimengImage,type JimengPreparedRecord} from './adapters/jimeng-local-video.js'
import type {VideoGenerationRecord} from './adapters/types.js'

const MAX_IMAGE=10*1024*1024,MAX_TOTAL=35*1024*1024
const snapshotRoot=()=>path.join(DATA_ROOT,'jimeng-reference-snapshots')
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
const snapshotWrites=new Map<string,Promise<void>>()
function contained(root:string,target:string){const rel=path.relative(root,target);return rel!==''&&!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep)}
export interface JimengSnapshot {id:string;name:string;sha256:string;mime_type:string}

async function privateSnapshotRoot():Promise<string>{
  await fs.mkdir(snapshotRoot(),{recursive:true,mode:0o700})
  const data=await fs.realpath(DATA_ROOT),root=await fs.realpath(snapshotRoot())
  if(!contained(data,root))throw jimengError('参考图快照目录超出私有数据目录，未提交。','reference_mismatch')
  return root
}
async function snapshotMatches(root:string,file:string,sha256:string,size:number):Promise<boolean>{
  try{
    const stat=await fs.lstat(file)
    if(stat.isSymbolicLink()||!stat.isFile()||!contained(root,await fs.realpath(file)))throw jimengError('参考图快照路径异常，未读取或提交。','reference_mismatch')
    if(stat.size!==size)return false
    return digest(await fs.readFile(file))===sha256
  }catch(error:any){if(error.code==='ENOENT')return false;throw error}
}
async function replaceSnapshot(root:string,temporary:string,file:string,sha256:string,size:number){
  for(let attempt=0;attempt<8;attempt++){
    if(await snapshotMatches(root,file,sha256,size))return
    try{await fs.rename(temporary,file);return}catch(error:any){
      if(!['EPERM','EACCES','EBUSY'].includes(error.code))throw error
      if(await snapshotMatches(root,file,sha256,size))return
      if(attempt===7)throw jimengError('本地参考图快照被占用，未提交即梦；请稍后重试这条任务。','snapshot_write_busy')
      await new Promise(resolve=>setTimeout(resolve,10*Math.min(16,2**attempt)))
    }
  }
}
/** Only complete, verified original bytes become visible at a hash address.
 * `wx` directly on the final name exposes a zero/partial file to another video
 * before writeFile finishes. Publish a flushed same-directory temporary file
 * instead, including across processes. Never delete a shared final snapshot. */
async function publishSnapshot(root:string,sha256:string,bytes:Buffer):Promise<void>{
  const file=path.join(root,sha256+'.image')
  if(await snapshotMatches(root,file,sha256,bytes.length))return
  const temporary=path.join(root,sha256+'.'+randomUUID()+'.tmp')
  let owned=false
  try{
    const handle=await fs.open(temporary,'wx',0o600);owned=true
    try{await handle.writeFile(bytes);await handle.sync()}finally{await handle.close()}
    try{
      // Hard-link publication cannot expose a partial file or replace a valid
      // snapshot published by another process. Both paths are on the same disk.
      await fs.link(temporary,file)
    }catch(error:any){
      if(await snapshotMatches(root,file,sha256,bytes.length))return
      if(!['EEXIST','EPERM','EACCES','ENOTSUP','EOPNOTSUPP','EINVAL','EXDEV','ENOSYS'].includes(error.code))throw error
      // A pre-existing interrupted snapshot can only be repaired here, using
      // source bytes already decoded and hashed for this exact address. The
      // prepare/recovery path below never rereads or substitutes source images.
      await replaceSnapshot(root,temporary,file,sha256,bytes.length)
    }
    if(!await snapshotMatches(root,file,sha256,bytes.length))throw jimengError('参考图快照未完整保存，未提交即梦。','reference_mismatch')
  // Antivirus may briefly hold our temporary name on Windows. Cleanup must not
  // turn an already committed correct snapshot into a failed video request.
  }finally{if(owned)await fs.unlink(temporary).catch(()=>{})}
}
async function saveSnapshot(root:string,sha256:string,bytes:Buffer){
  const key=root+'\0'+sha256
  let work=snapshotWrites.get(key)
  if(!work){work=publishSnapshot(root,sha256,bytes).finally(()=>{if(snapshotWrites.get(key)===work)snapshotWrites.delete(key)});snapshotWrites.set(key,work)}
  await work
}

export async function readJimengSourceImage(source:string):Promise<Buffer>{
  if(source.startsWith('data:')){
    const match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(source)
    if(!match||match[2].length>Math.ceil(MAX_IMAGE/3)*4)throw jimengError('参考图data URI不正确或超过10MB。','invalid_reference')
    const bytes=Buffer.from(match[2],'base64')
    if(bytes.toString('base64')!==match[2])throw jimengError('参考图base64不完整。','invalid_reference')
    return bytes
  }
  if(!/^\/?static\//u.test(source)||/[?#\\\x00-\x1f]/u.test(source))throw jimengError('即梦参考图请从项目素材库选择或上传；当前不接受任意远程URL或本机文件路径。','invalid_reference')
  const relative=source.replace(/^\/?static\//u,'').split('/').map(segment=>{
    let value:string;try{value=decodeURIComponent(segment)}catch{throw jimengError('参考图路径编码不正确。','invalid_reference')}
    if(!value||value==='.'||value==='..'||/[%/\\:\x00-\x1f]/u.test(value))throw jimengError('参考图路径不允许目录跳转。','invalid_reference')
    return value
  }).join(path.sep)
  const root=await fs.realpath(STORAGE_ROOT),candidate=await fs.realpath(path.join(root,relative))
  if(!contained(root,candidate))throw jimengError('参考图超出素材库目录。','invalid_reference')
  const stat=await fs.stat(candidate)
  if(!stat.isFile()||stat.size>MAX_IMAGE)throw jimengError('参考图片不存在或超过10MB保护上限。','reference_too_large')
  return fs.readFile(candidate)
}
async function mime(bytes:Buffer):Promise<string>{
  if(!bytes.length||bytes.length>MAX_IMAGE)throw jimengError('参考图片为空或超过10MB。','reference_too_large')
  try{
    const image=sharp(bytes,{limitInputPixels:40_000_000}),meta=await image.metadata()
    if(!meta.width||!meta.height||!['png','jpeg','webp'].includes(meta.format||'')||(meta.pages||1)>1)throw Error('format')
    // Decode the original once to reject truncated/corrupt images. Bytes sent stay unchanged.
    await image.stats()
    return 'image/'+(meta.format==='jpeg'?'jpeg':meta.format)
  }catch{throw jimengError('参考图不是完整的PNG、JPG或WEBP静态图片，未提交。','invalid_reference')}
}
export async function freezeJimengReferences(record:VideoGenerationRecord):Promise<JimengSnapshot[]>{
  const request=validateJimengVideoRecord(record),snapshots:JimengSnapshot[]=[]
  let total=0
  const root=await privateSnapshotRoot()
  for(let i=0;i<request.images.length;i++){
    const bytes=await readJimengSourceImage(request.images[i]);total+=bytes.length
    if(total>MAX_TOTAL)throw jimengError('即梦参考图片合计超过35MB，未截断或提交。','reference_too_large')
    const mime_type=await mime(bytes),sha256=digest(bytes)
    await saveSnapshot(root,sha256,bytes)
    snapshots.push({id:`image_${i+1}`,name:request.names[i],sha256,mime_type})
  }
  return snapshots
}
export async function prepareJimengVideoRecord(record:VideoGenerationRecord,snapshots:JimengSnapshot[],metadata?:JimengPreparedRecord['metadata']):Promise<JimengPreparedRecord>{
  const request=validateJimengVideoRecord(record)
  if(!Array.isArray(snapshots)||snapshots.length!==request.images.length)throw jimengError('缺少本轮参考图片快照，未重新读取其它图片。','reference_mismatch')
  const images:JimengImage[]=[];let total=0
  const root=await fs.realpath(snapshotRoot())
  for(let i=0;i<snapshots.length;i++){
    const entry=snapshots[i]
    if(!entry||entry.id!==`image_${i+1}`||entry.name!==request.names[i]||!/^[a-f0-9]{64}$/u.test(entry.sha256))throw jimengError('本轮参考图快照清单不一致。','reference_mismatch')
    const file=await fs.realpath(path.join(root,entry.sha256+'.image'))
    if(!contained(root,file))throw jimengError('快照文件超出私有目录。','reference_mismatch')
    const stat=await fs.stat(file);if(!stat.isFile()||stat.size>MAX_IMAGE)throw jimengError('参考图快照过大。','reference_too_large')
    const bytes=await fs.readFile(file);total+=bytes.length
    if(total>MAX_TOTAL||digest(bytes)!==entry.sha256||await mime(bytes)!==entry.mime_type)throw jimengError('参考图快照内容发生变化，未提交。','reference_mismatch')
    images.push({...entry,data_base64:bytes.toString('base64')})
  }
  return {...record,jimengImages:images,metadata}
}
