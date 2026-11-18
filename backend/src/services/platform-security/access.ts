import {AsyncLocalStorage} from 'node:async_hooks'
import type {Actor} from './store.js'
import {initPlatformSecurity,publicUser,sql,userById} from './store.js'

const scope=new AsyncLocalStorage<Actor>()
export const currentActor=()=>scope.getStore()||null
export const runAsActor=<T>(actor:Actor,fn:()=>T):T=>scope.run(actor,fn)
export const denied=(message='无权访问此资源',status=403)=>Object.assign(new Error(message),{status})
export function requireActor(){const actor=currentActor();if(!actor||!userById(actor.id)?.enabled)throw denied('请先登录',401);return actor}
export function requireAdmin(){const actor=requireActor();if(actor.role!=='admin')throw denied('仅管理员可执行此操作');return actor}
export function assertProjectAccess(id:number,actor:Actor|null=currentActor()){
  initPlatformSecurity();if(!actor)throw denied('缺少用户权限上下文',401)
  const row=sql.prepare('SELECT id,owner_user_id,deleted_at FROM dramas WHERE id=?').get(id) as {id:number;owner_user_id:number;deleted_at:string|null}|undefined
  if(!row||row.deleted_at||actor.role!=='admin'&&row.owner_user_id!==actor.id)throw denied('项目不存在或无访问权限',404)
  if(!userById(actor.id)?.enabled)throw denied('用户已停用',401)
  return row
}
export function actorForProject(id:number){initPlatformSecurity();const row=sql.prepare('SELECT owner_user_id FROM dramas WHERE id=? AND deleted_at IS NULL').get(id) as {owner_user_id:number}|undefined;const user=row&&userById(row.owner_user_id);if(!user||!user.enabled)throw denied('项目归属或账号状态不可用',403);return publicUser(user)}
export type ResourceKind='project'|'episode'|'character'|'scene'|'prop'|'storyboard'|'task'|'merge'|'agentJob'|'draft'
function existsTable(table:string){return!!sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)}
export function resourceProject(kind:ResourceKind,id:number|string):number|null{
  initPlatformSecurity();let row:any
  if(kind==='project')return Number.isSafeInteger(Number(id))?Number(id):null
  if(kind==='episode')row=sql.prepare('SELECT drama_id FROM episodes WHERE id=? AND deleted_at IS NULL').get(id)
  else if(kind==='character')row=sql.prepare('SELECT drama_id FROM characters WHERE id=? AND deleted_at IS NULL').get(id)
  else if(kind==='scene')row=sql.prepare('SELECT drama_id FROM scenes WHERE id=?').get(id)
  else if(kind==='prop')row=sql.prepare('SELECT drama_id FROM props WHERE id=? AND deleted_at IS NULL').get(id)
  else if(kind==='storyboard')row=sql.prepare('SELECT e.drama_id FROM storyboards s JOIN episodes e ON e.id=s.episode_id WHERE s.id=? AND s.deleted_at IS NULL AND e.deleted_at IS NULL').get(id)
  else if(kind==='task'){
    const task=sql.prepare('SELECT * FROM sys_task WHERE id=?').get(id) as any;if(!task)return null
    return task.drama_id||task.storyboard_id&&resourceProject('storyboard',task.storyboard_id)||task.character_id&&resourceProject('character',task.character_id)||task.scene_id&&resourceProject('scene',task.scene_id)||task.prop_id&&resourceProject('prop',task.prop_id)||null
  }else if(kind==='merge')row=sql.prepare('SELECT COALESCE(v.drama_id,e.drama_id) drama_id FROM video_merges v LEFT JOIN episodes e ON e.id=v.episode_id WHERE v.id=?').get(id)
  else if(kind==='agentJob'&&existsTable('agent_jobs')){const job=sql.prepare('SELECT payload FROM agent_jobs WHERE id=?').get(id) as any;row=job?JSON.parse(job.payload):null}
  else if(kind==='draft'&&existsTable('storyboard_drafts'))row=sql.prepare('SELECT drama_id FROM storyboard_drafts WHERE id=?').get(id)
  return row?.drama_id||null
}
export function assertResourceAccess(kind:ResourceKind,id:number|string,expectedProject?:number,actor:Actor|null=currentActor()){
  const project=resourceProject(kind,id);if(!project)throw denied('资源不存在或无访问权限',404)
  if(expectedProject!==undefined&&project!==expectedProject)throw denied('资源不属于当前项目',403)
  assertProjectAccess(project,actor);return project
}
export function canAccessProject(id:number,actor:Actor|null=currentActor()){try{assertProjectAccess(id,actor);return true}catch{return false}}
let modelAccessGuard:((id:number,actor:Actor)=>void)|undefined
export const registerModelAccessGuard=(guard:(id:number,actor:Actor)=>void)=>{modelAccessGuard=guard}
export function assertModelAccess(id:number,actor:Actor=requireActor()){if(modelAccessGuard)modelAccessGuard(id,actor)}
