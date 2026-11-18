import fs from 'node:fs'
import path from 'node:path'
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto'
import type {MiddlewareHandler} from 'hono'
import {DATA_ROOT,STORAGE_ROOT} from '../../utils/paths.js'
import {currentActor,assertProjectAccess,denied,actorForProject,resourceProject} from './access.js'
import {initPlatformSecurity,sql,userById,type Actor} from './store.js'

interface FileOwner {userId:number;projectId:number|null}
export function normalizePrivateMediaPath(value:string):string|null{
  let source=value
  if(/^https?:\/\//iu.test(source)){
    let url:URL;try{url=new URL(source)}catch{return null}
    const allowed=[process.env.PUBLIC_BASE_URL,process.env.HUOBAO_PUBLIC_ORIGIN].filter(Boolean).some(base=>{try{return new URL(base!).origin===url.origin}catch{return false}})
    if(!allowed)return null
    source=url.pathname
  }
  if(!/^\/?static\//u.test(source))return null
  source=source.replace(/^\//u,'').split('?')[0]
  const parts=source.split('/').map(part=>{try{return decodeURIComponent(part)}catch{throw denied('文件路径编码不正确',400)}})
  if(parts.some(part=>!part||part==='.'||part==='..'||/[\\/%:\x00-\x1f]/u.test(part)))throw denied('文件路径不正确',400)
  return parts.join('/')
}
function storedOwner(file:string):FileOwner|null{
  const row=sql.prepare('SELECT user_id,project_id FROM platform_resources WHERE path=?').get(file) as {user_id:number;project_id:number|null}|undefined
  return row?{userId:row.user_id,projectId:row.project_id}:null
}
export function registerPrivateMedia(value:string,projectId:number|null=null,actor:Actor|null=currentActor()){
  initPlatformSecurity();const file=normalizePrivateMediaPath(value);if(!file)throw denied('只能登记本机素材路径',400)
  if(!actor)throw denied('缺少素材所有者',401)
  if(projectId!==null)assertProjectAccess(projectId,actor)
  const old=storedOwner(file);if(old&&old.userId!==actor.id&&actor.role!=='admin')throw denied()
  const ownerId=projectId!==null?projectOwner(projectId)?.userId:actor.id
  if(!ownerId)throw denied('素材项目归属不正确',403)
  sql.prepare('INSERT INTO platform_resources(path,user_id,project_id,created_at) VALUES(?,?,?,?) ON CONFLICT(path) DO NOTHING').run(file,ownerId,projectId,new Date().toISOString())
  return file
}
function projectOwner(id:number):FileOwner|null{const row=sql.prepare('SELECT owner_user_id FROM dramas WHERE id=? AND deleted_at IS NULL').get(id) as {owner_user_id:number}|undefined;return row?.owner_user_id?{userId:row.owner_user_id,projectId:id}:null}
function referencedOwner(file:string):FileOwner|null{
  const values=[file,'/'+file]
  const statements=[
    ['SELECT drama_id FROM characters WHERE image_url IN (?,?) OR local_path IN (?,?) OR voice_audio_url IN (?,?)',values.concat(values,values)],
    ['SELECT drama_id FROM scenes WHERE image_url IN (?,?) OR local_path IN (?,?)',values.concat(values)],
    ['SELECT drama_id FROM props WHERE image_url IN (?,?) OR local_path IN (?,?)',values.concat(values)],
    ['SELECT e.drama_id FROM storyboards s JOIN episodes e ON e.id=s.episode_id WHERE s.composed_image IN (?,?) OR s.first_frame_image IN (?,?) OR s.last_frame_image IN (?,?) OR s.video_url IN (?,?) OR s.composed_video_url IN (?,?)',values.concat(values,values,values,values)],
    ['SELECT drama_id FROM episodes WHERE video_url IN (?,?) OR thumbnail IN (?,?)',values.concat(values)],
    ['SELECT id drama_id FROM dramas WHERE thumbnail IN (?,?)',values],
    ['SELECT drama_id FROM video_merges WHERE merged_url IN (?,?)',values],
  ] as const
  const owners=new Set<number>()
  for(const [query,args] of statements){for(const row of sql.prepare(query).all(...args) as {drama_id:number}[])if(row.drama_id)owners.add(row.drama_id)}
  if(sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='asset_image_versions'").get()){
    for(const [kind,table] of [['character','characters'],['scene','scenes'],['prop','props']]){
      for(const row of sql.prepare(`SELECT a.drama_id FROM asset_image_versions h JOIN ${table} a ON a.id=h.asset_id WHERE h.asset_type=? AND h.path IN (?,?) AND h.deleted_at IS NULL AND a.deleted_at IS NULL`).all(kind,...values) as {drama_id:number}[])if(row.drama_id)owners.add(row.drama_id)
    }
  }
  for(const task of sql.prepare('SELECT id FROM sys_task WHERE local_path IN (?,?)').all(...values) as {id:number}[]){const project=resourceProject('task',task.id);if(project)owners.add(project)}
  // Additional outputs belong to the same paid task/project as its primary
  // adopted image. They are retained without changing the asset's current image.
  for(const task of sql.prepare(`SELECT t.id FROM sys_task t WHERE EXISTS(
    SELECT 1 FROM json_each(CASE WHEN json_valid(t.params) THEN t.params ELSE '{}' END,'$.outputImages') o WHERE json_extract(CASE WHEN o.type='object' THEN o.value ELSE '{}' END,'$.local_path') IN (?,?)
  ) OR EXISTS(
    SELECT 1 FROM json_each(CASE WHEN json_valid(t.params) THEN t.params ELSE '{}' END,'$.outputVideos') o WHERE json_extract(CASE WHEN o.type='object' THEN o.value ELSE '{}' END,'$.local_path') IN (?,?)
  )`).all(...values,...values) as {id:number}[]){const project=resourceProject('task',task.id);if(project)owners.add(project)}
  const derived=[...owners].map(projectOwner).filter((x):x is FileOwner=>!!x)
  if(!derived.length)return null
  // Reusing one physical path across users is not permission to expose it to either.
  if(new Set(derived.map(x=>x.userId)).size!==1)return null
  return derived[0]
}
function remoteOwner(value:string):FileOwner|null{
  const projects=new Set<number>()
  for(const row of sql.prepare('SELECT id FROM sys_task WHERE result_url=?').all(value) as {id:number}[]){const id=resourceProject('task',row.id);if(id)projects.add(id)}
  for(const query of ['SELECT drama_id FROM characters WHERE image_url=? OR voice_audio_url=?','SELECT drama_id FROM scenes WHERE image_url=?','SELECT drama_id FROM props WHERE image_url=?']){
    const args=query.includes(' OR ')?[value,value]:[value]
    for(const row of sql.prepare(query).all(...args) as {drama_id:number}[])if(row.drama_id)projects.add(row.drama_id)
  }
  const owners=[...projects].map(projectOwner).filter((x):x is FileOwner=>!!x)
  return owners.length&&new Set(owners.map(x=>x.userId)).size===1?owners[0]:null
}
export function mediaOwner(value:string):FileOwner|null{
  initPlatformSecurity();const file=normalizePrivateMediaPath(value);if(!file)return null
  const registered=storedOwner(file);if(registered)return registered
  const direct=referencedOwner(file);if(direct)return direct
  if(/_thumb\.webp$/u.test(file)){for(const ext of ['png','jpg','jpeg','webp','bin']){const owner=storedOwner(file.replace(/_thumb\.webp$/u,'.'+ext))||referencedOwner(file.replace(/_thumb\.webp$/u,'.'+ext));if(owner)return owner}}
  return null
}
export function assertMediaAccess(value:string,actor:Actor|null=currentActor()){
  if(value==='')return
  const file=normalizePrivateMediaPath(value)
  if(!actor)throw denied('请先登录',401)
  if(actor.role==='admin')return
  let owner:FileOwner|null
  if(file)owner=mediaOwner(file)
  else if(value.startsWith('data:')){
    if(value.length>75*1024*1024||!/^data:(?:image\/(?:png|jpeg|webp)|audio\/(?:mpeg|mp3|wav|x-wav|mp4|aac)|video\/(?:mp4|webm));base64,[A-Za-z0-9+/]*={0,2}$/u.test(value))throw denied('内联素材格式或大小不正确',400)
    return
  }else{
    let url:URL;try{url=new URL(value)}catch{throw denied('请上传素材后引用，不接受本机文件路径',400)}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||/^(?:localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[|metadata\.)/iu.test(url.hostname)||/^172\.(?:1[6-9]|2\d|3[01])\./u.test(url.hostname))throw denied('不能引用内部网络地址',403)
    owner=remoteOwner(value)
  }
  if(!owner||owner.userId!==actor.id||!userById(actor.id)?.enabled)throw denied('素材不存在或无访问权限',404)
  if(owner.projectId!==null)assertProjectAccess(owner.projectId,actor)
}
let signingKey:Buffer|undefined
function key(){if(signingKey)return signingKey;fs.mkdirSync(path.join(DATA_ROOT,'.platform'),{recursive:true});const target=path.join(DATA_ROOT,'.platform/media-signing-key.bin');try{fs.writeFileSync(target,randomBytes(32),{mode:0o600,flag:'wx'})}catch(error:any){if(error.code!=='EEXIST')throw error}const value=fs.readFileSync(target);if(value.length!==32)throw Error('Media signing key is invalid');signingKey=value;return value}
function signature(file:string,owner:FileOwner,expires:string){return createHmac('sha256',key()).update(`${file}\n${owner.userId}\n${owner.projectId??''}\n${expires}`).digest('hex')}
function validSignature(file:string,expires:string|undefined,sig:string|undefined){
  if(!expires||!/^\d{10}$/u.test(expires)||!sig||!/^[a-f0-9]{64}$/u.test(sig))return false
  const now=Math.floor(Date.now()/1000),exp=Number(expires);if(exp<now||exp>now+3600)return false
  const owner=mediaOwner(file);if(!owner||!userById(owner.userId)?.enabled)return false
  if(owner.projectId!==null){try{assertProjectAccess(owner.projectId,actorForProject(owner.projectId))}catch{return false}}
  return timingSafeEqual(Buffer.from(sig,'hex'),Buffer.from(signature(file,owner,expires),'hex'))
}
export function signedProviderMediaUrl(value:string,ttlSeconds=900){
  const file=normalizePrivateMediaPath(value);if(!file)return value
  const owner=mediaOwner(file);if(!owner)throw denied('素材缺少可验证的项目归属',403)
  const actor=currentActor()||(owner.projectId?actorForProject(owner.projectId):null);assertMediaAccess(file,actor)
  const base=process.env.PUBLIC_BASE_URL||process.env.HUOBAO_PUBLIC_ORIGIN
  if(!base)throw denied('向外部模型提供私有素材时，请设置 PUBLIC_BASE_URL 为可访问的创一剧坊地址',400)
  const url=new URL('/'+file,base);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw denied('PUBLIC_BASE_URL不正确',400)
  const expires=String(Math.floor(Date.now()/1000)+Math.min(1800,Math.max(30,Math.round(ttlSeconds))))
  url.searchParams.set('exp',expires);url.searchParams.set('sig',signature(file,owner,expires));return url.toString()
}
export const privateMediaMiddleware:MiddlewareHandler=async(c,next)=>{
  try{
    if(!['GET','HEAD'].includes(c.req.method))throw denied('素材仅支持读取',405)
    initPlatformSecurity();const file=normalizePrivateMediaPath(c.req.path);if(!file)throw denied('素材路径不存在',404)
    if(/\.(?:part(?:\.json)?(?:\.tmp)?|tmp)$/iu.test(file)||! /\.(?:png|jpe?g|webp|gif|mp4|mov|webm|m4v|mp3|wav|m4a|aac|bin)$/iu.test(file))throw denied('素材不存在',404)
    if(!validSignature(file,c.req.query('exp'),c.req.query('sig'))){
      const {getCookie}=await import('hono/cookie');const {readSession}=await import('./store.js')
      const session=readSession(getCookie(c,'huobao_session'));if(!session)throw denied('请先登录',401)
      assertMediaAccess(file,session.user)
    }
    const root=fs.realpathSync(STORAGE_ROOT),target=fs.realpathSync(path.join(root,file.slice('static/'.length))),relative=path.relative(root,target)
    if(!relative||path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep)||!fs.statSync(target).isFile())throw denied('素材不存在',404)
    await next();c.header('Cache-Control','private, no-store');c.header('Vary','Cookie');c.header('X-Content-Type-Options','nosniff')
  }catch(error:any){return c.json({code:error.status||404,message:error.status?error.message:'素材不存在'},error.status||404)}
}
