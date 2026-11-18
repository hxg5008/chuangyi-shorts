import {randomBytes} from 'node:crypto'
import {initPlatformSecurity,sql,revokeSessions,audit} from './store.js'

export interface ActiveUserTask {kind:string;id:string|number;project_id:number|null;episode_id?:number|null;status:string;stage?:string|null}
const fail=(message:string,errorCode:string,status=409,activeTasks?:ActiveUserTask[])=>Object.assign(Error(message),{status,errorCode,...(activeTasks?{activeTasks,activeTaskCount:activeTasks.length}:{})})
const hasTable=(name:string)=>!!sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)

/** Only canonical, locatable work blocks deletion. Historical finished jobs and
 * rows attached to an already deleted project do not become permanent blockers. */
export function activeTasksForUser(id:number):ActiveUserTask[]{
  initPlatformSecurity()
  const projects=new Map<number,number>((sql.prepare('SELECT id,owner_user_id FROM dramas WHERE deleted_at IS NULL').all() as any[]).map(row=>[row.id,row.owner_user_id]))
  const owned=(project:unknown,actor?:unknown)=>{
    const projectId=Number(project)
    return projects.get(projectId)===id || Number(actor)===id && (!projectId || projects.has(projectId))
  }
  const result:ActiveUserTask[]=[]
  if(hasTable('sys_task')){
    const tasks=sql.prepare(`SELECT t.id,t.type,t.status,t.stage,e.id episode_id,
      COALESCE(t.drama_id,e.drama_id,c.drama_id,s.drama_id,p.drama_id) project_id,
      json_extract(CASE WHEN json_valid(t.params) THEN t.params ELSE '{}' END,'$.requestLogIdentity.actorUserId') actor_id
      FROM sys_task t
      LEFT JOIN storyboards b ON b.id=t.storyboard_id
      LEFT JOIN episodes e ON e.id=b.episode_id
      LEFT JOIN characters c ON c.id=t.character_id
      LEFT JOIN scenes s ON s.id=t.scene_id
      LEFT JOIN props p ON p.id=t.prop_id
      WHERE t.status IN ('processing','pending')`).all() as any[]
    for(const row of tasks)if(owned(row.project_id,row.actor_id))result.push({kind:row.type,id:row.id,project_id:row.project_id??null,episode_id:row.episode_id??null,status:row.status,stage:row.stage})
  }
  if(hasTable('agent_jobs')){
    const rows=sql.prepare(`SELECT j.id,j.episode_id,e.drama_id,j.status FROM agent_jobs j JOIN episodes e ON e.id=j.episode_id WHERE j.status='running' AND e.deleted_at IS NULL`).all() as any[]
    for(const row of rows)if(owned(row.drama_id))result.push({kind:'text',id:row.id,project_id:row.drama_id,episode_id:row.episode_id,status:row.status})
  }
  if(hasTable('platform_asset_image_jobs')){
    const rows=sql.prepare(`SELECT j.id,j.project_id,j.episode_id,j.user_id,j.status FROM platform_asset_image_jobs j
      LEFT JOIN sys_task t ON t.id=j.image_generation_id
      WHERE j.status='preparing_prompt' AND (t.id IS NULL OR t.status IN('processing','pending'))`).all() as any[]
    for(const row of rows)if(owned(row.project_id,row.user_id))result.push({kind:'asset_preparation',id:row.id,project_id:row.project_id,episode_id:row.episode_id,status:row.status})
  }
  if(hasTable('platform_production_batches')&&hasTable('platform_production_steps')){
    const rows=sql.prepare(`SELECT DISTINCT b.id,b.drama_id,b.user_id,b.status FROM platform_production_batches b
      JOIN platform_production_steps s ON s.batch_id=b.id
      WHERE b.status IN('running','paused') AND (s.status='running' OR b.status='running' AND s.status='queued')`).all() as any[]
    for(const row of rows)if(owned(row.drama_id,row.user_id))result.push({kind:'batch',id:row.id,project_id:row.drama_id,status:row.status})
  }
  if(hasTable('video_merges')){
    const rows=sql.prepare(`SELECT m.id,m.episode_id,COALESCE(m.drama_id,e.drama_id) project_id,m.status
      FROM video_merges m LEFT JOIN episodes e ON e.id=m.episode_id WHERE m.status IN('pending','processing') AND m.deleted_at IS NULL`).all() as any[]
    for(const row of rows)if(owned(row.project_id))result.push({kind:'merge',id:row.id,project_id:row.project_id,episode_id:row.episode_id,status:row.status})
  }
  if(hasTable('platform_activity_tasks')){
    const rows=sql.prepare(`SELECT id,project_id,episode_id,user_id,status,stage FROM platform_activity_tasks
      WHERE kind='text' AND source_type IS NULL AND status IN('running','queued')`).all() as any[]
    for(const row of rows)if(owned(row.project_id,row.user_id))result.push({kind:'text_activity',id:row.id,project_id:row.project_id??null,episode_id:row.episode_id,status:row.status,stage:row.stage})
  }
  return result
}

export function deleteUser(id:number,actorId:number){
  initPlatformSecurity()
  if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(actorId)||actorId<1)throw fail('用户编号不正确。','invalid_user',400)
  return sql.transaction(()=>{
    const actor=sql.prepare("SELECT id FROM platform_users WHERE id=? AND enabled=1 AND role='admin' AND deleted_at IS NULL").get(actorId)
    if(!actor)throw fail('仅有效管理员可以删除用户。','admin_required',403)
    if(id===actorId)throw fail('不能删除当前登录的管理员账号。','cannot_delete_self')
    const user=sql.prepare('SELECT id,username,role,enabled,deleted_at FROM platform_users WHERE id=?').get(id) as any
    if(!user)throw fail('用户不存在。','user_not_found',404)
    if(user.deleted_at)return{deleted:true,user_id:id,already_deleted:true,projects_preserved:true,history_preserved:true,username_reusable:true}
    if(user.role==='admin'&&user.enabled){
      const others=sql.prepare("SELECT count(*) n FROM platform_users WHERE role='admin' AND enabled=1 AND deleted_at IS NULL AND id<>?").get(id) as any
      if(!others.n)throw fail('不能删除最后一个已启用的管理员。','last_admin')
    }
    const active=activeTasksForUser(id)
    if(active.length)throw fail(`该用户还有 ${active.length} 项正在执行或等待派发的任务，请先在任务中心处理完成后再删除；未取消任何任务。`,'user_has_active_tasks',409,active)
    const at=new Date().toISOString(),placeholder=`__deleted_user_${id}_${randomBytes(12).toString('hex')}`
    sql.prepare('UPDATE platform_users SET deleted_at=?,deleted_username=username,username=?,enabled=0,password_hash=?,updated_at=? WHERE id=? AND deleted_at IS NULL').run(at,placeholder,'',at,id)
    revokeSessions(id)
    // Keep a selected-only binding selected-only even when its final user goes
    // away. Empty permission lists must never turn into an all-users grant.
    if(hasTable('platform_channel_models')){
      const update=sql.prepare('UPDATE platform_channel_models SET allowed_user_ids_json=?,updated_at=? WHERE id=?')
      for(const row of sql.prepare('SELECT id,allowed_user_ids_json FROM platform_channel_models').all() as any[]){
        let users:unknown;try{users=JSON.parse(row.allowed_user_ids_json)}catch{continue}
        if(!Array.isArray(users))continue
        const filtered=users.filter(value=>Number(value)!==id)
        if(filtered.length!==users.length)update.run(JSON.stringify(filtered),at,row.id)
      }
    }
    audit(actorId,'user-delete',String(id))
    return{deleted:true,user_id:id,already_deleted:false,projects_preserved:true,history_preserved:true,username_reusable:true}
  }).immediate()
}
