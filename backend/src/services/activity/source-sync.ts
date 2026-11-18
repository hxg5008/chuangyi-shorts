import { createHash } from 'node:crypto'
import { activityDatabase as sql, activityTask, bindActivitySource, activitySource, ensureActivitySource, updateActivityTask, activityEvent, parseActivityJSON } from './store.js'
import { ActivitySourceJournal } from './source-journal.js'

let lastSync = 0
const journal=new ActivitySourceJournal(sql)
const diagnostics={mediaReads:0,mediaParses:0,agentReads:0,agentParses:0,mergeReads:0}
export function activitySourceSyncDiagnostics(){return {...diagnostics,...journal.counts()}}
const fingerprint = (value: any) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const tableExists = (name: string) => !!sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)

function syncMedia(row: any, sourceType: string) {
  diagnostics.mediaParses++
  const params = parseActivityJSON(row.params, {}), kind = row.type === 'image' ? 'image' : 'video'
  const name = row.character_name || row.scene_name || row.prop_name || (row.storyboard_number ? `分镜 ${row.storyboard_number}` : `#${row.id}`)
  const title = sourceType === 'merge' ? `拼接导出 · ${row.title || '#' + row.id}` : `${kind === 'image' ? '图片生成' : '视频生成'} · ${name}`
  const state = row.status === 'completed' ? 'completed' : row.status === 'cancelled' ? 'interrupted' : row.status === 'failed' ? 'failed'
    : row.stage === 'queued' || row.stage === 'upstream_queued' ? 'queued' : 'running'
  const progress = params.progress ?? params.lastPoll?.progress ?? null
  const result = { local_path: row.local_path || (row.merged_url?.startsWith('/static/') ? row.merged_url : null), result_url: row.result_url || row.merged_url, task_id: row.task_id, progress,
    queue_seconds: params.lastPoll?.queue_seconds ?? null, queue_ahead: params.lastPoll?.queue_ahead ?? null,
    upstream_started_at: params.lastPoll?.upstream_started_at ?? null,
    output_images: params.outputImages || null, output_videos: params.outputVideos || null,
    delivery_mode: params.manualDelivery || row.stage === 'ready_in_local_service' ? 'local_manual' : 'automatic',
    download_progress: params.downloadProgress || null, image_output: params.imageOutput || null,
    cancel_available: !params.cancelRequestedAt && row.status === 'processing' && !!row.task_id && !['downloading','saving'].includes(row.stage) && !!params.protocolSnapshot?.protocolDefinition?.manifest?.contributes?.providers?.find((provider: any) => provider.id === params.protocolSnapshot?.protocolDefinition?.providerId)?.cancel }
  const digest = fingerprint([state, row.stage, row.error_msg, result])
  if (params.activityTaskId && !activitySource(sourceType, String(row.id)) && activityTask(params.activityTaskId)) bindActivitySource(params.activityTaskId, sourceType, String(row.id))
  const existing = activitySource(sourceType, String(row.id))
  if (existing?.source_fingerprint === digest) return existing.id
  const id = existing?.id || ensureActivitySource({ kind, title, projectId: row.project_id || row.drama_id,
    episodeId: row.episode_id, sourceType, sourceId: String(row.id), model: row.model, channel: row.config_name || row.provider,
    createdAt: row.created_at, request: { prompt: row.prompt, parameters: params, model: row.model } })
  updateActivityTask(id, { status: state, stage: params.cancelRequestedAt && row.status === 'processing' ? 'cancelling' : row.stage || (state === 'running' ? 'generating' : state), model: row.model,
    channel: row.config_name || row.provider, result, error: row.error_msg || null, fingerprint: digest,
    finishedAt: state === 'completed' || state === 'failed' || state === 'interrupted' ? row.completed_at || row.updated_at : null })
  activityEvent(id, state === 'failed' ? 'failed' : state === 'completed' ? 'completed' : 'progress',
    state === 'failed' ? '任务未完成。' : state === 'completed' ? row.stage === 'ready_in_local_service' ? '已出片，请到服务端手动下载。' : row.stage === 'handed_off' ? '已交即梦（已接单、卡片已命名），出片后回传到分镜。' : '任务已完成。' : '任务阶段已更新。',
    { stage: row.stage, status: state, progress, error: row.error_msg || null })
  return id
}
const mediaSelect = `SELECT t.*,coalesce(t.drama_id,c.drama_id,s.drama_id,p.drama_id,e.drama_id) AS project_id,
    e.id AS episode_id,sb.storyboard_number,c.name AS character_name,s.location AS scene_name,p.name AS prop_name,cfg.name AS config_name
    FROM sys_task t LEFT JOIN characters c ON c.id=t.character_id LEFT JOIN scenes s ON s.id=t.scene_id LEFT JOIN props p ON p.id=t.prop_id
    LEFT JOIN storyboards sb ON sb.id=t.storyboard_id LEFT JOIN episodes e ON e.id=sb.episode_id LEFT JOIN ai_service_configs cfg ON cfg.id=t.config_id`
export function syncMediaActivity(id: number) {
  journal.refresh()
  if (!tableExists('sys_task')) return null
  const seen=journal.revision('media',String(id))
  diagnostics.mediaReads++
  const row = sql.prepare(`${mediaSelect} WHERE t.id=?`).get(id)
  const result=row ? syncMedia(row, 'media') : null
  if(seen)journal.acknowledge(seen)
  return result
}
export function syncAgentActivity(job: any) {
  const existing = activitySource('agent_jobs', String(job.id))
  const digest = fingerprint([job.status, job.phase, job.updated_at, job.error, job.completed, job.total, job.attempt,job.failed,job.current_group,job.issues,job.model_calls,job.repair_calls,job.finished_at])
  if (existing?.source_fingerprint === digest) return existing.id
  const id = existing?.id || ensureActivitySource({ kind: 'text', title: job.agent_type === 'storyboard_breaker' ? '分镜拆解' : '视频提示词',
    projectId: job.drama_id, episodeId: job.episode_id, sourceType: 'agent_jobs', sourceId: String(job.id), createdAt: job.started_at })
  const state = job.status === 'done' ? 'completed' : ['error', 'needs_revision'].includes(job.status) ? 'failed' : 'running'
  updateActivityTask(id, { status: state, stage: job.phase, error: job.error || (job.issues?.length && state === 'failed' ? job.issues.map((i: any) => i.message).join('\n') : undefined),
    result: { total: job.total, completed: job.completed, failed: job.failed, current_group: job.current_group, issues: job.issues,
      model_calls: job.model_calls, repair_calls: job.repair_calls }, fingerprint: digest, finishedAt: job.finished_at || null })
  activityEvent(id, state === 'failed' ? 'failed' : state === 'completed' ? 'completed' : 'phase', '文字工作流状态已更新。',
    { status: state, phase: job.phase, attempt: job.attempt, completed: job.completed, total: job.total, error: job.error })
  return id
}
export function syncActivitySources(force = false) {
  if (!force && Date.now() - lastSync < 800) return
  lastSync = Date.now()
  // Shared across SSE windows: unchanged active tasks never reload their potentially large params.
  journal.backfill(500)
  for(const seen of journal.pending(500)){
    if(!seen.deleted&&journal.hasSource(seen.source_type)){
      if(seen.source_type==='media'){
        diagnostics.mediaReads++
        const row=sql.prepare(`${mediaSelect} WHERE t.id=?`).get(seen.source_id)
        if(row)syncMedia(row,'media')
      }else if(seen.source_type==='agent_jobs'){
        diagnostics.agentReads++
        const row=sql.prepare('SELECT payload FROM agent_jobs WHERE id=?').get(seen.source_id) as any
        if(row){diagnostics.agentParses++;const job=parseActivityJSON(row.payload);if(job)syncAgentActivity(job)}
      }else{
        diagnostics.mergeReads++
        const row=sql.prepare('SELECT *,drama_id AS project_id FROM video_merges WHERE id=? AND deleted_at IS NULL').get(seen.source_id)
        if(row)syncMedia(row,'merge')
      }
    }
    // A newer revision stays dirty even if another writer updates during this observation.
    journal.acknowledge(seen)
  }
}
export function recoverActivityJournal() {
  sql.prepare("UPDATE platform_activity_tasks SET status='interrupted',stage='interrupted',error='后台重启，原日志已保留；不会自动重新生成。',finished_at=?,updated_at=? WHERE source_type IS NULL AND status IN ('running','queued')")
    .run(new Date().toISOString(), new Date().toISOString())
  sql.prepare("UPDATE platform_activity_rounds SET status='interrupted',error='后台重启，原调用已停止观察。',finished_at=? WHERE status='running'").run(new Date().toISOString())
}
