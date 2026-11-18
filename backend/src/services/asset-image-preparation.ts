import {randomUUID} from 'node:crypto'
import type {MiddlewareHandler} from 'hono'
import {sql,type Actor} from './platform-security/store.js'
import {requireActor,assertResourceAccess,assertProjectAccess,runAsActor,denied} from './platform-security/access.js'
import {currentActivity,withActivityContext} from './activity/context.js'
import {createActivityTask,activityTask,activitySource,bindActivitySource,activityEvent,updateActivityTask} from './activity/store.js'
import {syncMediaActivity} from './activity/source-sync.js'
import {sanitizeActivity} from './activity/sanitize.js'
import {redactRuntimeSecrets} from '../utils/secret-redaction.js'
import {getDramaStyleSnapshot,conflictingStyleSnapshots} from './style-preset.js'

export type AssetImageKind='character'|'scene'|'prop'
export type AssetImageJobStatus='preparing_prompt'|'completed'|'failed'|'interrupted'
export interface AssetImageJob {id:string;asset_kind:AssetImageKind;asset_id:number;project_id:number;episode_id:number;user_id:number;status:AssetImageJobStatus;activity_task_id:string;image_generation_id:number|null;error:string|null;error_code:string|null;created_at:string;updated_at:string;finished_at:string|null;active?:boolean;image_generation_status?:string|null}
type JobRow=AssetImageJob&{request_json:string}
type Replay=(path:string,init:RequestInit)=>Response|Promise<Response>
let initialized=false
export function initAssetImagePreparation(){if(initialized)return;sql.exec(`CREATE TABLE IF NOT EXISTS platform_asset_image_jobs (
 id TEXT PRIMARY KEY,asset_kind TEXT NOT NULL,asset_id INTEGER NOT NULL,project_id INTEGER NOT NULL,episode_id INTEGER NOT NULL,user_id INTEGER NOT NULL,
 status TEXT NOT NULL,activity_task_id TEXT NOT NULL,image_generation_id INTEGER,request_json TEXT NOT NULL,error TEXT,error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,finished_at TEXT);
 CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_image_preparing ON platform_asset_image_jobs(asset_kind,asset_id) WHERE status='preparing_prompt';
 CREATE INDEX IF NOT EXISTS idx_asset_image_project ON platform_asset_image_jobs(project_id,created_at);
 CREATE INDEX IF NOT EXISTS idx_asset_image_episode ON platform_asset_image_jobs(episode_id,created_at);`);initialized=true}
const view=(row:JobRow):AssetImageJob=>{const {request_json,...result}=row;const task=row.image_generation_id?sql.prepare('SELECT status FROM sys_task WHERE id=?').get(row.image_generation_id) as {status:string}|undefined:undefined;return{...result,image_generation_status:task?.status||null,active:row.status==='preparing_prompt'||!!task&&['processing','pending'].includes(task.status)}}
const read=(id:string)=>{initAssetImagePreparation();return sql.prepare('SELECT * FROM platform_asset_image_jobs WHERE id=?').get(id) as JobRow|undefined}
const stamp=()=>new Date().toISOString()
const errorText=(error:any)=>redactRuntimeSecrets(String(error?.message||error||'图片准备失败'))
function linkedTask(id:string){return sql.prepare("SELECT id FROM sys_task WHERE type='image' AND json_extract(CASE WHEN json_valid(params) THEN params ELSE '{}' END,'$.assetPreparationJobId')=? ORDER BY id DESC LIMIT 1").get(id) as {id:number}|undefined}
function attach(job:JobRow,id:number){
 const target=sql.prepare('SELECT * FROM sys_task WHERE id=?').get(id) as any,field=({character:'character_id',scene:'scene_id',prop:'prop_id'} as const)[job.asset_kind]
 if(!target||target.type!=='image'||target[field]!==job.asset_id||target.drama_id&&target.drama_id!==job.project_id)throw new Error('图片任务与本次素材准备不一致，未自动重新提交')
 const at=stamp();sql.prepare("UPDATE platform_asset_image_jobs SET status='completed',image_generation_id=?,error=NULL,error_code=NULL,updated_at=?,finished_at=? WHERE id=?").run(id,at,at,job.id)
 const log=activityTask(job.activity_task_id),existing=activitySource('media',String(id))
 if(log&&!log.source_type&&!existing)bindActivitySource(job.activity_task_id,'media',String(id))
 try{syncMediaActivity(id)}catch{}
 activityEvent(job.activity_task_id,'image_prepared','提示词准备已完成，已关联图片生成任务。',{asset_job_id:job.id,image_generation_id:id})
 return read(job.id)!
}
function fail(job:JobRow,error:any,code:string,status:AssetImageJobStatus='failed'){
 const anchor=linkedTask(job.id);if(anchor)return attach(job,anchor.id)
 const old=read(job.id);if(!old||old.status!=='preparing_prompt')return old
 const at=stamp(),message=errorText(error)
 sql.prepare('UPDATE platform_asset_image_jobs SET status=?,error=?,error_code=?,updated_at=?,finished_at=? WHERE id=? AND status=\'preparing_prompt\'').run(status,message,code,at,at,job.id)
 updateActivityTask(job.activity_task_id,{status:status==='interrupted'?'interrupted':'failed',stage:status==='interrupted'?'interrupted':'preparation_failed',error:message,finishedAt:at})
 activityEvent(job.activity_task_id,status==='interrupted'?'interrupted':'failed',message,{asset_job_id:job.id,error_code:code})
 return read(job.id)
}
function begin(kind:AssetImageKind,id:number,body:any,actor:Actor){
 initAssetImagePreparation();const project=assertResourceAccess(kind,id,undefined,actor)
 const episode=Number(body.episode_id);if(!Number.isSafeInteger(episode)||episode<=0)throw denied('episode_id 必须为正整数',400)
 assertResourceAccess('episode',episode,project,actor)
 const asset=sql.prepare(`SELECT * FROM ${kind==='character'?'characters':kind==='scene'?'scenes':'props'} WHERE id=?`).get(id) as any
 if(!asset||asset.deleted_at)throw denied('素材不存在或已删除',404)
 const styleSnapshot=getDramaStyleSnapshot(project)
 return sql.transaction(()=>{
  const existing=sql.prepare(`SELECT j.* FROM platform_asset_image_jobs j LEFT JOIN sys_task t ON t.id=j.image_generation_id
   WHERE j.asset_kind=? AND j.asset_id=? AND (j.status='preparing_prompt' OR t.type='image' AND t.status IN ('processing','pending')) ORDER BY j.created_at DESC LIMIT 1`).get(kind,id) as JobRow|undefined
  if(existing){
   const request=JSON.parse(existing.request_json||'{}'),task=existing.image_generation_id?sql.prepare('SELECT params FROM sys_task WHERE id=?').get(existing.image_generation_id) as any:undefined
   const params=task?JSON.parse(task.params||'{}'):undefined
   const runningStyle=params&&Object.hasOwn(params,'styleSnapshot')?params.styleSnapshot:Object.hasOwn(request,'styleSnapshot')?request.styleSnapshot:undefined
   if(conflictingStyleSnapshots(styleSnapshot,runningStyle))throw Object.assign(denied('该素材已有不同风格版本的任务执行中，请核对原任务；未重复提交图片。',409),{errorCode:'image_style_conflict'})
   return{job:existing,started:false}
  }
  const field=({character:'character_id',scene:'scene_id',prop:'prop_id'} as const)[kind]
  const legacy=sql.prepare(`SELECT id,params FROM sys_task WHERE type='image' AND ${field}=? AND status IN ('processing','pending') ORDER BY id DESC LIMIT 1`).get(id) as {id:number;params:string|null}|undefined
  if(legacy){const params=JSON.parse(legacy.params||'{}');if(Object.hasOwn(params,'styleSnapshot')&&conflictingStyleSnapshots(styleSnapshot,params.styleSnapshot))throw Object.assign(denied('该素材已有不同风格版本的任务执行中，请核对原任务；未重复提交图片。',409),{errorCode:'image_style_conflict'});throw denied('该素材已有图片生成任务，请等待原任务完成',409)}
  const at=stamp(),uuid=randomUUID(),taskId=createActivityTask({kind:'image',title:`图片生成 · ${asset.name||asset.location||'#'+id}`,projectId:project,episodeId:episode,userId:actor.id,request:{operation:'asset_image_preparation',asset_kind:kind,asset_id:id,...body}})
  updateActivityTask(taskId,{stage:'preparing_prompt',status:'running'})
  sql.prepare(`INSERT INTO platform_asset_image_jobs(id,asset_kind,asset_id,project_id,episode_id,user_id,status,activity_task_id,request_json,created_at,updated_at)
   VALUES(?,?,?,?,?,?,'preparing_prompt',?,?,?,?)`).run(uuid,kind,id,project,episode,actor.id,taskId,JSON.stringify({request:sanitizeActivity(body),styleSnapshot}),at,at)
  activityEvent(taskId,'preparing_prompt','正在准备图片提示词。',{asset_job_id:uuid,asset_kind:kind,asset_id:id})
  return{job:read(uuid)!,started:true}
 }).immediate()
}
export function assetImagePreparationMiddleware(kind:AssetImageKind,replay:Replay,options:{timeoutMs?:number}={}):MiddlewareHandler{
 return async(c,next)=>{
  if(c.req.method!=='POST')return next()
  const body=await c.req.json();if(body?.async_prepare!==true)return next()
  try{
   const actor=requireActor(),id=Number(c.req.param('id')),snapshot=structuredClone(body);delete snapshot.async_prepare;delete snapshot.styleSnapshot;delete snapshot.style_snapshot
   if(!Number.isSafeInteger(id)||id<=0)throw denied('素材编号不正确',400)
   const {job,started}=begin(kind,id,snapshot,actor)
   if(started){
    const previous=currentActivity(),styleSnapshot=JSON.parse(job.request_json).styleSnapshot,controller=new AbortController(),signal=previous?.abortSignal?AbortSignal.any([previous.abortSignal,controller.signal]):controller.signal
    const timeoutMs=options.timeoutMs??10*60_000
    const execution=runAsActor(actor,()=>withActivityContext({...previous,styleSnapshot,taskId:job.activity_task_id,projectId:job.project_id,episodeId:job.episode_id,userId:actor.id,assetPreparationJobId:job.id,abortSignal:signal},async()=>{
     signal.throwIfAborted();const response=await replay(`/${id}/generate-image`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(snapshot),signal})
     let result:any;try{result=await response.json()}catch{throw Error('图片准备未返回有效结果，未自动重试')}
     if(!response.ok||result?.code&&result.code!==200&&result.code!==201)throw Error(result?.message||'图片准备失败，未自动重试')
     const imageId=Number(result?.data?.image_generation_id||result?.data?.id)
     if(!Number.isSafeInteger(imageId)||imageId<=0)throw Error('图片准备未返回生成任务编号，未自动重试')
     return imageId
    }))
    const timer=setTimeout(()=>controller.abort(new Error('图片提示词准备达到10分钟等待上限，已停止本次准备，未自动重试')),timeoutMs);timer.unref()
    const aborted=new Promise<never>((_resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true})})
    void Promise.race([execution,aborted]).then(imageId=>{const fresh=read(job.id);if(fresh?.status==='preparing_prompt'||linkedTask(job.id))attach(job,imageId)}).catch(error=>fail(job,error,signal.aborted?'preparation_timeout':'preparation_failed')).finally(()=>clearTimeout(timer))
   }
   return c.json({code:202,data:{asset_job_id:job.id,status:job.status,activity_task_id:job.activity_task_id,image_generation_id:job.image_generation_id,reused:!started},message:'图片准备任务已接收'},202)
  }catch(error:any){const status=[400,401,403,404,409].includes(error.status)?error.status:500;return c.json({code:status,message:status===500?'图片准备暂时无法启动':errorText(error),...(error.errorCode==='image_style_conflict'?{error_code:'image_style_conflict'}:{})},status)}
 }
}
export function assetImagePreparationJob(id:string,actor:Actor=requireActor()){
 const row=read(id);if(!row)throw denied('准备任务不存在或无访问权限',404);assertProjectAccess(row.project_id,actor);return view(row)
}
export function listAssetImagePreparationJobs(filters:{episodeId?:number;projectId?:number},actor:Actor=requireActor()){
 initAssetImagePreparation();let project=filters.projectId
 if(filters.episodeId){const owning=assertResourceAccess('episode',filters.episodeId,project,actor);project=owning}
 if(!project)throw denied('请提供episode_id或project_id',400);assertProjectAccess(project,actor)
 const args:any[]=[project];let where='j.project_id=?'
 if(filters.episodeId){where+=` AND (j.episode_id=? OR j.asset_kind='character' AND j.asset_id IN(SELECT character_id FROM episode_characters WHERE episode_id=?)
  OR j.asset_kind='scene' AND j.asset_id IN(SELECT scene_id FROM episode_scenes WHERE episode_id=?) OR j.asset_kind='prop' AND j.asset_id IN(SELECT prop_id FROM episode_props WHERE episode_id=?))`;args.push(filters.episodeId,filters.episodeId,filters.episodeId,filters.episodeId)}
 return(sql.prepare(`SELECT j.* FROM platform_asset_image_jobs j WHERE ${where} ORDER BY CASE WHEN j.status='preparing_prompt' THEN 0 ELSE 1 END,j.created_at DESC LIMIT 500`).all(...args) as JobRow[]).map(view)
}
/** Startup is observation-only: an existing image-task anchor is reused; no prompt or model POST is restarted. */
export function recoverAssetImagePreparationJobs(){
 initAssetImagePreparation();let interrupted=0,linked=0
 for(const job of sql.prepare("SELECT * FROM platform_asset_image_jobs WHERE status='preparing_prompt'").all() as JobRow[]){const anchor=linkedTask(job.id);if(anchor){attach(job,anchor.id);linked++}else{fail(job,new Error('后台已重启，上次提示词准备已中断；未自动重新提交，请手动继续。'),'preparation_interrupted','interrupted');interrupted++}}
 return{interrupted,linked}
}
