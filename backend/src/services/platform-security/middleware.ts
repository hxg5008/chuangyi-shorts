import type {MiddlewareHandler,Context} from 'hono'
import {getCookie} from 'hono/cookie'
import {readSession,initPlatformSecurity} from './store.js'
import {runAsActor,currentActor,requireActor,requireAdmin,assertProjectAccess,assertResourceAccess,canAccessProject,resourceProject,assertModelAccess,denied,type ResourceKind} from './access.js'
import {assertMediaAccess} from './media.js'

export function assertRequestOrigin(c:Context){
  const origin=c.req.header('origin');if(!origin)return
  let supplied:URL;try{supplied=new URL(origin)}catch{throw denied('请求来源不正确',403)}
  if(origin!==supplied.origin)throw denied('请求来源不正确',403)
  const target=new URL(c.req.url),host=c.req.header('host')||target.host
  const configured=[process.env.HUOBAO_PUBLIC_ORIGIN].filter(Boolean).some(value=>{try{return new URL(value!).origin===origin}catch{return false}})
  if(!configured&&!(supplied.host===host&&['http:','https:'].includes(supplied.protocol)))throw denied('请从本工作台页面发起请求',403)
  if(c.req.header('sec-fetch-site')==='cross-site')throw denied('不接受跨站请求',403)
}
export function secureCookie(c:Context){const origin=c.req.header('origin');return new URL(c.req.url).protocol==='https:'||!!origin&&origin.startsWith('https://')}
const idFields:Record<string,ResourceKind>={drama_id:'project',dramaId:'project',project_id:'project',projectId:'project',episode_id:'episode',episodeId:'episode',character_id:'character',characterId:'character',linked_character_id:'character',scene_id:'scene',sceneId:'scene',prop_id:'prop',propId:'prop',storyboard_id:'storyboard',storyboardId:'storyboard',task_id:'task'}
const pluralFields:Record<string,ResourceKind>={character_ids:'character',scene_ids:'scene',prop_ids:'prop',storyboard_ids:'storyboard',episode_ids:'episode'}
const containers:Record<string,ResourceKind>={characters:'character',scenes:'scene',props:'prop',storyboards:'storyboard',episodes:'episode'}
const mediaKeys=new Set(['image_url','imageUrl','local_path','localPath','video_url','videoUrl','voice_audio_url','thumbnail','thumbnail_url','first_frame_image','last_frame_image','composed_image','reference_images','referenceImages','reference_image_urls','first_frame_url','last_frame_url','reference_video_urls','reference_audio_urls','file_url','link_url','url','images','videos','audios'])
/** Response-only copy; persisted task parameters and upstream requests stay exact. */
export function publicTaskResult(value:any,field=''):any{
  if(typeof value==='string'&&/^(?:params|parameters)$/iu.test(field)){
    try{return JSON.stringify(publicTaskResult(JSON.parse(value)))}catch{return value}
  }
  if(Array.isArray(value))return value.map(item=>publicTaskResult(item))
  if(!value||typeof value!=='object')return value
  return Object.fromEntries(Object.entries(value).filter(([key])=>! /^(?:protocol_?snapshot|config_?base_?url)$/iu.test(key)).map(([key,item])=>[key,publicTaskResult(item,key)]))
}
export function validateOwnedInput(value:any,projectId?:number,kind?:ResourceKind){
  const actor=requireActor()
  const visit=(entry:any,family?:ResourceKind,key='')=>{
    if(Array.isArray(entry)){for(const item of entry)visit(item,family,key);return}
    if(!entry||typeof entry!=='object'){
      if(typeof entry==='string'&&mediaKeys.has(key)){if(entry.startsWith('[')){try{visit(JSON.parse(entry),undefined,key)}catch(error:any){if(error.status)throw error}}else assertMediaAccess(entry,actor)}
      return
    }
    for(const [field,item]of Object.entries(entry)){
      if(['owner_user_id','ownerUserId','created_by_user_id'].includes(field)&&actor.role!=='admin')throw denied('不能修改资源所有者')
      if(field==='id'&&family&&item!=null&&item!==0&&item!=='')assertResourceAccess(family,item as any,projectId,actor)
      else if(idFields[field]&&item!=null&&item!==0&&item!==''){
        if(idFields[field]==='project'&&projectId!==undefined&&Number(item)!==projectId)throw denied('资源不属于当前项目')
        // A remote provider's string task_id is not a local resource identifier.
        if(field!=='task_id'||typeof item==='number')assertResourceAccess(idFields[field],item as any,idFields[field]==='project'?undefined:projectId,actor)
      }else if(pluralFields[field]&&Array.isArray(item)){for(const id of item)if(id!=null&&id!==0)assertResourceAccess(pluralFields[field],id as any,projectId,actor)}
      else if(['config_id','text_config_id','image_config_id','video_config_id','configId','textConfigId','imageConfigId','videoConfigId','model_binding_id'].includes(field)&&item!==undefined&&item!==null){if(!/^[1-9]\d*$/u.test(String(item))||!Number.isSafeInteger(Number(item)))throw denied('模型配置编号不正确',400);assertModelAccess(Number(item),actor)}
      if(mediaKeys.has(field)){if(typeof item==='string')visit(item,undefined,field);else if(Array.isArray(item))for(const media of item)if(typeof media==='string')assertMediaAccess(media,actor)}
      else visit(item,containers[field]||family,field)
    }
  }
  visit(value,kind)
}
function projectFromHeader(c:Context){const value=c.req.header('x-project-id');if(value===undefined||value==='')return undefined;if(!/^[1-9]\d*$/u.test(value))throw denied('项目编号不正确',400);return Number(value)}
function inputProject(value:Record<string,unknown>){for(const field of ['drama_id','dramaId','project_id','projectId','episode_id','episodeId','storyboard_id','storyboardId','character_id','characterId','scene_id','sceneId','prop_id','propId'])if(value[field]!=null&&value[field]!==''){const project=resourceProject(idFields[field],value[field] as number|string);if(project)return project};return undefined}
function pathProject(route:string){
  const numericId=(value:string)=>{if(!/^[1-9]\d*$/u.test(value)||!Number.isSafeInteger(Number(value)))throw denied('资源编号不正确',400);return Number(value)}
  let match=/^\/(dramas|episodes|characters|scenes|props|storyboards|tasks)\/([^/]+)(?:\/|$)/u.exec(route)
  const imageHistory=/^\/asset-images\/(character|scene|prop)\/([^/]+)(?:\/|$)/u.exec(route)
  if(imageHistory)return assertResourceAccess(imageHistory[1] as 'character'|'scene'|'prop',numericId(imageHistory[2]))
  if(match){
    // Reserved collection actions are the only non-ID segments. Number() in the
    // original handlers also accepts 1e0/+1/0x1, which must never bypass ACLs.
    if(match[1]==='dramas'&&route==='/dramas/stats'||match[1]==='characters'&&['/characters/voice-cards/fill','/characters/batch-generate-images'].includes(route))return undefined
    const kind=({dramas:'project',episodes:'episode',characters:'character',scenes:'scene',props:'prop',storyboards:'storyboard',tasks:'task'} as Record<string,ResourceKind>)[match[1]]
    return assertResourceAccess(kind,numericId(match[2]))
  }
  match=/^\/merge\/episodes\/([^/]+)(?:\/|$)/u.exec(route);if(match)return assertResourceAccess('episode',numericId(match[1]))
  match=/^\/agent\/jobs\/([^/]+)$/u.exec(route);if(match)return assertResourceAccess('agentJob',match[1])
  return undefined
}
function allowedUserRoute(route:string,method:string){
  if(/^\/asset-images\/(?:character|scene|prop)\/[1-9]\d*(?:\/[1-9]\d*(?:\/adopt)?)?$/u.test(route)&&['GET','POST','DELETE'].includes(method))return true
  if(/^\/production-batches(?:\/|$)/u.test(route)&&['GET','POST'].includes(method))return true
  if(/^\/production-dashboard(?:\/|$)/u.test(route)&&method==='GET')return true
  if(/^\/asset-image-jobs(?:\/[^/]+)?$/u.test(route)&&method==='GET')return true
  if(/^\/(?:dramas|episodes|characters|scenes|props|storyboards|tasks|merge|upload|activity)(?:\/|$)/u.test(route))return true
  if(/^\/agent(?:\/|$)/u.test(route))return !/\/debug$/u.test(route)
  if(/^\/ai-configs(?:\/\d+)?\/?$/u.test(route)&&method==='GET')return true
  if(route==='/models'&&method==='GET')return true
  if(route==='/style-presets'&&method==='GET')return true
  if(['/settings/content-language','/settings/tours-seen'].includes(route)&&method==='GET')return true
  if(route.startsWith('/auth/'))return true
  return false
}
export const platformSecurityMiddleware:MiddlewareHandler=async(c,next)=>{
  try{
    initPlatformSecurity();const route=c.req.path.replace(/^\/api\/v1/u,'').replace(/\/$/u,'')||'/'
    if(route==='/health')return await next()
    if(route==='/auth/login'||route==='/auth/register'&&c.req.method==='POST'){assertRequestOrigin(c);return await next()}
    const session=readSession(getCookie(c,'huobao_session'));if(!session)throw denied('请先登录工作台',401)
    assertRequestOrigin(c)
    if(!['GET','HEAD','OPTIONS'].includes(c.req.method)&&c.req.header('x-csrf-token')!==session.csrfToken)throw denied('页面验证已失效，请重新登录或刷新页面',403)
    return await runAsActor(session.user,async()=>{
      const actor=requireActor()
      if(actor.role!=='admin'&&!allowedUserRoute(route,c.req.method))throw denied('仅管理员可访问此设置',403)
      if(route.startsWith('/admin/'))requireAdmin()
      if(route.startsWith('/auth/'))return await next()
      let project=pathProject(route)
      const header=projectFromHeader(c);if(header!==undefined){assertProjectAccess(header);if(project!==undefined&&project!==header)throw denied('页面与资源项目不一致',403);project=header}
      const query=Object.fromEntries(new URL(c.req.url).searchParams)
      validateOwnedInput(query,project)
      project??=inputProject(query)
      if(project!==undefined)validateOwnedInput(query,project)
      let input:any={}
      const multipartUpload=(/^\/upload\/(?:image|audio|video)$/u.test(route)||/^\/characters\/[1-9]\d*\/voice$/u.test(route)||actor.role==='admin'&&route==='/admin/protocols/import')&&/^multipart\/form-data(?:;|$)/iu.test(c.req.header('content-type')||'')
      // Original handlers use req.json() regardless of Content-Type. Inspect their
      // actual JSON body too; merely claiming text/plain/multipart must not skip ACLs.
      if(!['GET','HEAD'].includes(c.req.method)&&!multipartUpload){
        const raw=await c.req.text()
        if(raw.trim()){try{input=JSON.parse(raw)}catch{throw denied('请求正文必须为JSON对象',400)};if(!input||typeof input!=='object'||Array.isArray(input))throw denied('请求正文必须为JSON对象',400)}
        if(actor.role!=='admin'&&Object.keys(input).some(k=>['api_key','apiKey','base_url','baseUrl','headers','provider','protocol','protocolId','endpoint','query_endpoint'].includes(k)))throw denied('模型连接由管理员配置')
        validateOwnedInput(input,project);project??=inputProject(input)
      }
      if(project!==undefined)validateOwnedInput(input,project)
      if(actor.role!=='admin'&&!['GET','HEAD'].includes(c.req.method)&&/^\/(?:episodes|characters|scenes|props|storyboards|tasks)\/?$/u.test(route)&&project===undefined)throw denied('操作必须关联自己的项目',400)
      if(project!==undefined){assertProjectAccess(project);c.set('platformProjectId',project)}
      await next()
      if(actor.role==='admin'||!c.res.headers.get('content-type')?.includes('application/json'))return
      // Activity routes already apply per-row ownership and administrator-only
      // projections. Do not buffer a streaming full-log export into one JSON
      // object in this generic compatibility scrubber.
      if(route.startsWith('/activity/'))return
      let response:any;try{response=await c.res.clone().json()}catch{return}
      if(route==='/tasks'&&Array.isArray(response.data))response.data=response.data.filter((row:any)=>{const id=resourceProject('task',row.id);return id!==null&&canAccessProject(id,actor)})
      if(/^\/ai-configs(?:\/|$)/u.test(route)){
        const scrub=(row:any)=>{if(!row||typeof row!=='object')return row;const value={...row};delete value.api_key;delete value.apiKey;delete value.base_url;delete value.baseUrl;delete value.headers;delete value.settings;return value}
        if(Array.isArray(response.data))response.data=response.data.filter((row:any)=>row.is_active!==false&&row.isActive!==false).filter((row:any)=>{try{assertModelAccess(row.id,actor);return true}catch{return false}}).map(scrub)
        else if(response.data){assertModelAccess(response.data.id,actor);response.data=scrub(response.data)}
      }
      if(route==='/style-presets'&&Array.isArray(response.data))response.data=response.data.map(({prompt,...row}:any)=>row)
      response=publicTaskResult(response)
      const headers=new Headers(c.res.headers);headers.delete('content-length');c.res=new Response(JSON.stringify(response),{status:c.res.status,headers})
    })
  }catch(error:any){const status=error.name==='BodyLimitError'?413:[400,401,403,404,409,413,429].includes(error.status)?error.status:500;return c.json({code:status,message:status===500?'权限校验暂时不可用':status===413?'请求内容超过通用HTTP大小上限，请减少本次提交内容':error.message},status)}
}
