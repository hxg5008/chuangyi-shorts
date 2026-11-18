import { activityDatabase as sql } from './activity/store.js'
import { syncActivitySources } from './activity/source-sync.js'
import { sanitizeActivity } from './activity/sanitize.js'
import { assertProjectAccess, denied, requireActor } from './platform-security/index.js'
import type { Actor } from './platform-security/store.js'
import { readProductionDashboardSteps } from './production-batches.js'
import { PLATFORM_RELEASE } from '../utils/platform-release.js'

export const DASHBOARD_STALE_SECONDS = 300
sql.exec('CREATE INDEX IF NOT EXISTS idx_activity_event_progress_time ON platform_activity_events(task_id,kind,created_at)')
const statuses = ['queued', 'running', 'completed', 'failed', 'interrupted'] as const
type Status = typeof statuses[number]
export type DashboardExceptionCategory = 'local_material' | 'format' | 'channel' | 'submission_uncertain' | 'delivery' | 'program'
export interface DashboardQuery { projectId?: number; limit?: number; offset?: number; exceptionsOnly?: boolean; now?: number }
const steps = [
  ['script_rewrite', '剧本改写'], ['extract_characters', '提取角色'], ['extract_scenes', '提取场景'],
  ['extract_props', '提取道具'], ['asset_prompt', '资产提示词'], ['image_generation', '图片生成'],
  ['storyboard_breakdown', '分镜拆解'], ['video_prompt', '视频提示词'], ['video_generation', '视频生成'],
  ['merge_export', '拼接导出'],
] as const
const labels: Record<string, string> = Object.fromEntries([...steps, ['extraction', '提取资产（旧记录未区分类别）'], ['other_text', '其他文字任务']])
const stageLabels: Record<string, string> = {
  queued: '排队中', preparing: '准备中', preparing_prompt: '准备提示词', generating: '生成中', validating: '校验中',
  repairing: '修复中', submitting: '提交中', upstream_queued: '平台排队', polling: '查询结果',
  downloading: '下载中', saving: '保存中', completed: '已完成', failed: '失败', error: '失败',
  interrupted: '已中断', needs_revision: '需要修改', done: '已完成', ready_in_local_service: '请到本地服务下载',
  handed_off: '已交即梦，出片后回传', submission_checking: '提交结果核对中',
  cancelling: '等待平台确认取消',
  waiting_capacity: '等待全局任务槽', waiting_owner: '等待用户任务槽', waiting_paused: '派发已暂停',
  waiting_route: '等待项目画布', waiting_review: '原提交待核对', dispatching: '正在派发',
}
const emptyCounts = () => ({ queued: 0, running: 0, completed: 0, failed: 0, interrupted: 0 })
const time = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0
const safeId = (value: unknown): number | null => typeof value !== 'boolean' && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null
const table = (name: string) => !!sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
const channelBindingsReady = () => table('platform_channel_models') && table('platform_model_channels')
const placeholder = (values: unknown[]) => values.map(() => '?').join(',')
const projectClause = (ids: number[], unassigned = false, prefix = '') => `(${ids.length ? `${prefix}project_id IN (${placeholder(ids)})` : '0=1'}${unassigned ? ` OR ${prefix}project_id IS NULL` : ''})`

/** Diagnostics omit all URLs/paths, not merely known authentication parameters. */
export function dashboardSafeText(value: unknown, maximum = 600): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  if (/"(?:messages|system|instructions|developerInstructions|tools|outputSchema|reasoning|chain.of.thought)"\s*:|"role"\s*:\s*"(?:system|developer)"/iu.test(value)) {
    return '[诊断包含模型请求或内部推理结构，已省略；请查看受权限保护的任务实况。]'
  }
  return String(sanitizeActivity(value, [], maximum * 2))
    .replace(/https?:\/\/[^\s<>"']+/giu, '[地址已隐藏]')
    .replace(/\b[A-Za-z]:[\\/][^\r\n<>"']*/gu, '[本地路径已隐藏]')
    .replace(/(?:cookie|authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|sessionid|sid_tt)\s*[:=]\s*[^\r\n]+/giu, '[凭据已隐藏]')
    .trim().slice(0, maximum)
}

export function classifyDashboardException(input: { status?: string; stage?: string; errorCode?: string; error?: string; issueCount?: number; providerHttpStatus?: number | null }) {
  const evidence = `${input.errorCode || ''}\n${input.error || ''}\n${input.stage || ''}`
  const failed = ['failed', 'interrupted', 'needs_revision', 'error'].includes(input.status || '')
  if (!failed && !input.error && !input.errorCode) return null
  let category: DashboardExceptionCategory
  if (/submission[_ -]?(?:unknown|uncertain)|ambiguous[_ -]?(?:submission|result)|needs_review|结果待核对|提交(?:结果)?(?:未知|不确定|待确认|待核对)|多个接单|未确认唯一接单|未返回任务[号编]/iu.test(evidence)) category = 'submission_uncertain'
  else if (/delivery|download|save[_ -]?failed|交付|下载失败|保存失败|本地下载|result_unavailable|image_delivery/iu.test(evidence)) category = 'delivery'
  else if (/PUBLIC_BASE_URL|public[_ -]?origin|private[_ -]?media|input_stale|input_changed|reference[_ -]?(?:failure|invalid|missing)|missing[_ -]?(?:reference|asset)|素材|参考图|文件不存在|图片不存在|未上传/iu.test(evidence)) category = 'local_material'
  else if (/schema|validation|invalid_json|structured|格式|校验|缺少字段|unrecognized|shot_number|character_ids|source_ids|voice_cues|needs_revision/iu.test(evidence) || (input.issueCount || 0) > 0) category = 'format'
  else if (/TypeError|ReferenceError|SyntaxError|Cannot read|is not a function|程序|本地异常|interrupted|重启|中断/iu.test(evidence)) category = 'program'
  else category = 'channel'
  const categoryLabels: Record<DashboardExceptionCategory, string> = { local_material: '本地素材／访问地址', format: '输出格式／校验', channel: '模型渠道／平台', submission_uncertain: '提交待核对', delivery: '交付／下载', program: '程序／运行中断' }
  return { category, label: categoryLabels[category], summary: dashboardSafeText(input.error) || categoryLabels[category],
    count: Math.max(1, input.issueCount || 0), submission_uncertain: category === 'submission_uncertain',
    guidance: category === 'submission_uncertain' ? '先核对原任务和平台记录，避免重复提交生成。' : null,
    provider_http_status: Number.isInteger(input.providerHttpStatus) ? input.providerHttpStatus : null }
}

function projectsFor(actor: Actor, projectId?: number): any[] {
  if (projectId) assertProjectAccess(projectId, actor)
  return sql.prepare(`SELECT id,title FROM dramas WHERE deleted_at IS NULL ${actor.role === 'admin' ? '' : 'AND owner_user_id=?'} ${projectId ? 'AND id=?' : ''} ORDER BY updated_at DESC,id DESC`)
    .all(...(actor.role === 'admin' ? [] : [actor.id]), ...(projectId ? [projectId] : []))
}

function stepKey(row: any) {
  if (row.source_type === 'merge') return 'merge_export'
  if (row.kind === 'video') return 'video_generation'
  if (row.kind === 'image') return 'image_generation'
  const operation = row.operation || '', title = row.title || ''
  if (/script_rewriter|rewrite/iu.test(operation) || /剧本改写|改写剧本/u.test(title)) return 'script_rewrite'
  if (/提取角色|提取人物/u.test(title)) return 'extract_characters'
  if (/提取场景/u.test(title)) return 'extract_scenes'
  if (/提取道具/u.test(title)) return 'extract_props'
  if (/storyboard_breaker/iu.test(operation) || /分镜拆解|拆分分镜/u.test(title)) return 'storyboard_breakdown'
  if (/视频提示词/u.test(title)) return 'video_prompt'
  if (/extractor/iu.test(operation) || /提取资产/u.test(title)) return 'extraction'
  if (/prompt_generator/iu.test(operation) || /提示词/u.test(title)) return 'asset_prompt'
  return 'other_text'
}

const jsonField = (column: string, field: string) => `CASE WHEN json_valid(${column}) THEN json_extract(${column},'$.${field}') END`
function baseRows(projects: number[], includeUnassigned = false, identity?: string) {
  if (!projects.length && !includeUnassigned) return []
  // Select only diagnostic scalars; never materialize whole prompts, protocol
  // definitions, provider headers or potentially multi-megabyte model output.
  return sql.prepare(`SELECT t.id,t.user_id,t.project_id,t.episode_id,t.kind,t.title,t.source_type,t.source_id,t.status,t.stage,t.model,t.channel,
      substr(t.error,1,2000) error,t.created_at,t.started_at,t.finished_at,t.updated_at,t.stage_started_at,
      ${table('platform_asset_image_jobs') ? 'aj.asset_kind preparation_asset_kind,aj.asset_id preparation_asset_id,aj.status preparation_status,aj.created_at preparation_started_at,aj.finished_at preparation_finished_at,aj.updated_at preparation_updated_at,prepared_image.id preparation_image_id,' : 'NULL preparation_asset_kind,NULL preparation_asset_id,NULL preparation_status,NULL preparation_started_at,NULL preparation_finished_at,NULL preparation_updated_at,NULL preparation_image_id,'}
      r.id round_id,r.number round_number,
      (SELECT max(e.created_at) FROM platform_activity_events e WHERE e.task_id=t.id AND e.kind IN ('started','model_submitted','model_completed','model_failed','public_delta','tool_call','tool_input_start','tool_completed','tool_failed','phase','progress','completed','failed','interrupted','preparing_prompt')) progress_event_at
      FROM platform_activity_tasks t LEFT JOIN platform_activity_rounds r ON r.id=(SELECT rr.id FROM platform_activity_rounds rr WHERE rr.task_id=t.id ORDER BY rr.number DESC LIMIT 1)
      ${table('platform_asset_image_jobs') ? `LEFT JOIN platform_asset_image_jobs aj ON aj.activity_task_id=t.id AND aj.project_id=t.project_id
        LEFT JOIN sys_task prepared_image ON prepared_image.id=aj.image_generation_id AND prepared_image.type='image'
          AND COALESCE(prepared_image.drama_id,aj.project_id)=aj.project_id
          AND ((aj.asset_kind='character' AND prepared_image.character_id=aj.asset_id) OR (aj.asset_kind='scene' AND prepared_image.scene_id=aj.asset_id) OR (aj.asset_kind='prop' AND prepared_image.prop_id=aj.asset_id))` : ''}
      WHERE ${projectClause(projects, includeUnassigned, 't.')} ${identity ? 'AND t.id=?' : ''} ORDER BY t.created_at DESC,t.rowid DESC`).all(...projects, ...(identity ? [identity] : [])) as any[]
}

function sourceMaps(rows: any[], rich = false) {
  const mediaIds = rows.filter(row => row.source_type === 'media').map(row => safeId(row.source_id)).filter(Boolean)
  const media = new Map<number, any>()
  for (let i = 0; i < mediaIds.length; i += 500) {
    const ids = mediaIds.slice(i, i + 500)
    for (const row of sql.prepare(`SELECT t.id,t.drama_id,t.type,t.storyboard_id,t.character_id,t.scene_id,t.prop_id,t.provider,t.config_id,t.task_id,t.status,t.stage,t.error_code,
      coalesce(t.drama_id,c.drama_id,s.drama_id,p.drama_id,e.drama_id) project_id,
      substr(t.error_msg,1,2000) error_msg,t.result_url IS NOT NULL has_result,t.local_path IS NOT NULL has_local_file,t.updated_at,
      sb.episode_id,sb.storyboard_number,cfg.name config_name,
      ${rich ? `${jsonField('t.params', 'providerFailure.statusCode')} provider_http_status,${jsonField('t.params', 'providerFailure.requestId')} provider_request_id,` : ''}
      CASE WHEN cfg.id IS NULL THEN 0 ELSE 1 END config_exists,
      ${channelBindingsReady() ? 'ch.id' : 'NULL'} channel_id
      FROM sys_task t LEFT JOIN storyboards sb ON sb.id=t.storyboard_id
      LEFT JOIN episodes e ON e.id=sb.episode_id LEFT JOIN characters c ON c.id=t.character_id
      LEFT JOIN scenes s ON s.id=t.scene_id LEFT JOIN props p ON p.id=t.prop_id
      LEFT JOIN ai_service_configs cfg ON cfg.id=t.config_id
      ${channelBindingsReady() ? 'LEFT JOIN platform_channel_models bm ON bm.config_id=cfg.id AND bm.deleted_at IS NULL LEFT JOIN platform_model_channels ch ON ch.id=bm.channel_id AND ch.deleted_at IS NULL' : ''}
      WHERE t.id IN (${placeholder(ids)})`).all(...ids) as any[]) media.set(row.id, row)
  }
  const agents = new Map<string, any>()
  if (rich && table('agent_jobs')) {
    const ids = rows.filter(row => row.source_type === 'agent_jobs').map(row => row.source_id)
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500)
      for (const row of sql.prepare(`SELECT j.id,e.drama_id project_id,${jsonField('j.payload', 'agent_type')} agent_type,${jsonField('j.payload', 'error_code')} error_code,
          ${jsonField('j.payload', 'provider_http_status')} provider_http_status,${jsonField('j.payload', 'provider_request_id')} provider_request_id,
          ${jsonField('j.payload', 'draft_id')} draft_id,CASE WHEN json_valid(j.payload) THEN json_array_length(j.payload,'$.issues') END issue_count
          FROM agent_jobs j JOIN episodes e ON e.id=j.episode_id WHERE j.id IN (${placeholder(part)})`).all(...part) as any[]) agents.set(row.id, row)
    }
  }
  const links = new Map<string, Set<number>>()
  const assetIds = { character: new Set<number>(), scene: new Set<number>(), prop: new Set<number>() }
  for (const row of rows) {
    const source = media.get(Number(row.source_id))
    if (row.source_type === 'media' && source) for (const kind of ['character', 'scene', 'prop'] as const) if (source[kind + '_id']) assetIds[kind].add(source[kind + '_id'])
    if (['character', 'scene', 'prop'].includes(row.preparation_asset_kind) && safeId(row.preparation_asset_id)) assetIds[row.preparation_asset_kind as keyof typeof assetIds].add(Number(row.preparation_asset_id))
  }
  for (const kind of ['character', 'scene', 'prop'] as const) {
    const ids = [...assetIds[kind]], name = kind === 'character' ? 'episode_characters' : kind === 'scene' ? 'episode_scenes' : 'episode_props'
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500)
      for (const row of sql.prepare(`SELECT episode_id,${kind}_id asset_id FROM ${name} WHERE ${kind}_id IN (${placeholder(part)})`).all(...part) as any[]) {
        const key = `${kind}:${row.asset_id}`
        if (!links.has(key)) links.set(key, new Set())
        links.get(key)!.add(row.episode_id)
      }
    }
  }
  return { media, agents, links }
}

function taskView(row: any, sources: ReturnType<typeof sourceMaps>, actor: Actor, now: number) {
  const foundMedia = row.source_type === 'media' ? sources.media.get(Number(row.source_id)) : undefined
  const media = foundMedia?.project_id === row.project_id ? foundMedia : undefined
  const foundAgent = row.source_type === 'agent_jobs' ? sources.agents.get(row.source_id) : undefined
  const agent = foundAgent?.project_id === row.project_id ? foundAgent : undefined
  const operation = agent?.agent_type || row.operation
  const key = stepKey({ ...row, operation })
  let asset: any = null
  if (media) for (const kind of ['character', 'scene', 'prop']) if (media[kind + '_id']) { asset = { kind, id: media[kind + '_id'] }; break }
  if (!asset && ['character', 'scene', 'prop'].includes(row.preparation_asset_kind) && safeId(row.preparation_asset_id)) asset = { kind: row.preparation_asset_kind, id: Number(row.preparation_asset_id) }
  const episodeIds = new Set<number>()
  if (safeId(row.episode_id)) episodeIds.add(Number(row.episode_id))
  if (safeId(media?.episode_id)) episodeIds.add(Number(media.episode_id))
  if (asset) for (const id of sources.links.get(`${asset.kind}:${asset.id}`) || []) episodeIds.add(id)
  const progressAt = Math.max(time(row.created_at), time(row.updated_at), time(row.progress_event_at))
  const idle = Math.max(0, Math.floor((now - progressAt) / 1000))
  const active = row.status === 'running' || row.status === 'queued'
  const exception = classifyDashboardException({ status: row.status, stage: row.stage,
    errorCode: media?.error_code || agent?.error_code, error: row.error || media?.error_msg,
    issueCount: agent?.issue_count || row.issue_count || 0, providerHttpStatus: row.provider_http_status ?? agent?.provider_http_status ?? media?.provider_http_status })
  const roundId = row.round_id || null
  const links: any = { activity: { task_id: row.id, round_id: roundId }, episode: episodeIds.size === 1 ? { id: [...episodeIds][0], section: key === 'script_rewrite' ? 'rewrite' : key.includes('video') || key === 'storyboard_breakdown' ? 'video' : 'assets' } : null,
    asset, settings: actor.role === 'admin' && (media?.channel_id || row.text_channel_id) ? { section: 'channels', channel_id: media?.channel_id || row.text_channel_id, config_id: media?.channel_id ? media.config_id : row.text_config_id } : null }
  const actions: any[] = [{ type: 'view_log', label: '查看实况', href: `/tasks?task_id=${encodeURIComponent(row.id)}${roundId ? '&round_id=' + encodeURIComponent(roundId) : ''}` }]
  if (asset) actions.push({ type: 'view_asset', label: '查看素材', href: `/drama/${row.project_id}?tab=assets&asset_kind=${asset.kind}&asset_id=${asset.id}` })
  if (links.settings) actions.push({ type: 'view_settings', label: '查看渠道', href: `/admin/channels?channel_id=${links.settings.channel_id}&config_id=${links.settings.config_id}` })
  // No speculative retry/cancel button: the live task center owns provider-
  // specific operations and confirmation. Unknown submissions never regenerate.
  return { id: row.id, project_id: row.project_id, episode_id: row.episode_id || null, episode_ids: [...episodeIds], shared: episodeIds.size > 1,
    title: dashboardSafeText(row.title, 200), kind: row.kind, step_key: key, step_label: labels[key], status: row.status, stage: row.stage,
    stage_label: stageLabels[row.stage] || dashboardSafeText(row.stage, 80) || '未记录阶段',
    created_at: row.created_at, started_at: row.started_at, finished_at: row.finished_at,
    elapsed_seconds: Math.max(0, Math.round(((time(row.finished_at) || now) - time(row.created_at)) / 1000)),
    stage_started_at: row.stage_started_at || null,
    stage_elapsed_seconds: row.stage_started_at ? Math.max(0, Math.round(((time(row.finished_at) || now) - time(row.stage_started_at)) / 1000)) : null,
    last_progress_at: new Date(progressAt).toISOString(), idle_seconds: idle, stale: active && idle >= DASHBOARD_STALE_SECONDS,
    stale_after_seconds: DASHBOARD_STALE_SECONDS, model: dashboardSafeText(row.model, 160), channel: dashboardSafeText(media?.config_name || row.text_config_name || row.channel || media?.provider, 160),
    upstream_task_id: dashboardSafeText(media?.task_id || row.upstream_task_id, 200), provider_request_id: dashboardSafeText(agent?.provider_request_id || media?.provider_request_id, 200),
    provider_http_status: Number.isInteger(row.provider_http_status ?? agent?.provider_http_status ?? media?.provider_http_status) ? row.provider_http_status ?? agent?.provider_http_status ?? media?.provider_http_status : null,
    progress: typeof row.progress === 'number' && row.progress >= 0 && row.progress <= 100 ? row.progress : null,
    result_counts: typeof row.result_total === 'number' ? { total: row.result_total, completed: row.result_completed || 0 } : null,
    error_code: dashboardSafeText(media?.error_code || agent?.error_code, 160), exception, links, actions,
    source_ref: row.source_type ? { type: row.source_type, id: row.source_id } : null,
    preparation: row.preparation_status ? {
      status: row.preparation_status === 'completed' ? (row.preparation_image_id ? 'ready' : 'not_recorded') : row.preparation_status === 'preparing_prompt' ? 'running' : row.preparation_status,
      started_at: row.preparation_started_at, finished_at: row.preparation_finished_at, updated_at: row.preparation_updated_at,
      elapsed_seconds: Math.max(0,Math.round(((time(row.preparation_finished_at)||now)-time(row.preparation_started_at))/1000)),
      note: '图片任务内的提示词准备记录；可能生成新提示词或复用已有提示词。'
    } : row.preparation || null }
}

function allTasks(projects: any[], actor: Actor, now: number, includeUnassigned = false, identity?: string) {
  syncActivitySources()
  const rows = baseRows(projects.map(project => project.id), includeUnassigned, identity), sources = sourceMaps(rows)
  return rows.map(row => taskView(row, sources, actor, now))
}

function enrichTasks(tasks: any[], actor: Actor, now: number) {
  if (!tasks.length) return []
  const rows: any[] = []
  for (let i = 0; i < tasks.length; i += 100) {
    const ids = tasks.slice(i, i + 100).map(task => task.id)
    const known = new Map(tasks.map(task => [task.id, task]))
    // Large persisted JSON is touched only for the current page / exception
    // panel / explicitly opened detail, never the entire task history.
    for (const extra of sql.prepare(`SELECT t.id,${jsonField('t.request_json', 'operation')} operation,
      ${jsonField('t.result_json', 'progress')} progress,${jsonField('t.result_json', 'task_id')} upstream_task_id,
      ${jsonField('t.result_json', 'total')} result_total,${jsonField('t.result_json', 'completed')} result_completed,
      ${jsonField('t.result_json', 'provider_http_status')} provider_http_status,
      CASE WHEN json_valid(t.result_json) THEN json_array_length(t.result_json,'$.issues') END issue_count,
      cfg.id text_config_id,cfg.name text_config_name,CASE WHEN cfg.id IS NULL THEN 0 ELSE 1 END text_config_exists,
      ${channelBindingsReady() ? 'ch.id' : 'NULL'} text_channel_id
      FROM platform_activity_tasks t LEFT JOIN ai_service_configs cfg ON cfg.id=${jsonField('t.request_json', 'config_id')}
      ${channelBindingsReady() ? 'LEFT JOIN platform_channel_models bm ON bm.config_id=cfg.id AND bm.deleted_at IS NULL LEFT JOIN platform_model_channels ch ON ch.id=bm.channel_id AND ch.deleted_at IS NULL' : ''}
      WHERE t.id IN (${placeholder(ids)})`).all(...ids) as any[]) {
      const task: any = known.get(extra.id)
      rows.push({ ...task, source_type: task.source_ref?.type, source_id: task.source_ref?.id,
        round_id: task.links.activity.round_id, progress_event_at: task.last_progress_at,
        preparation_asset_kind: task.links.asset?.kind, preparation_asset_id: task.links.asset?.id,
        error: task.exception?.summary, updated_at: task.last_progress_at, ...extra })
    }
  }
  const sources = sourceMaps(rows, true)
  const enriched = new Map(rows.map(row => [row.id, taskView(row, sources, actor, now)]))
  return tasks.map(task => enriched.get(task.id) || task)
}

function aggregateSteps(tasks: any[], batchSteps: any[] = []) {
  const keys = [...steps.map(step => step[0])]
  for (const task of tasks) if (!keys.includes(task.step_key as any)) keys.push(task.step_key as any)
  return keys.map(key => {
    const relevant = tasks.flatMap(task => task.step_key === key ? [task] : key === 'asset_prompt' && task.preparation?.status && task.preparation.status !== 'not_recorded' ? [{...task,status:task.preparation.status,elapsed_seconds:task.preparation.elapsed_seconds,preparation_source:true,last_progress_at:task.preparation.updated_at,exception:task.preparation.status==='ready'?null:task.exception}] : [])
    const phase = key === 'asset_prompt' && relevant.some(task => task.preparation_source)
    const newestByAsset = new Map<string,any>()
    for(const task of relevant){const identity=task.links?.asset?`${task.links.asset.kind}:${task.links.asset.id}`:task.id;if(!newestByAsset.has(identity))newestByAsset.set(identity,task)}
    const current = phase ? [...newestByAsset.values()] : relevant
    const active = current.filter(task => ['queued', 'running'].includes(task.status)), failed = current.filter(task => ['failed', 'interrupted'].includes(task.status))
    const latest = phase ? active[0] || failed[0] || current[0] : relevant[0]
    const phaseStatus = active.length ? 'running' : failed.length ? (current.some(task=>['ready','completed'].includes(task.status))?'partial':'failed') : 'ready'
    const target = ({ extract_characters: 'characters', extract_scenes: 'scenes', extract_props: 'props' } as any)[key]
    const batch = target ? batchSteps.find(step => step.target === target) : null
    const batchWins = batch && (!latest || batch.activity_task_id === latest.id || Math.max(time(batch.started_at), time(batch.created_at)) >= time(latest.created_at))
    const batchTask = batch ? relevant.find(task => task.id === batch.activity_task_id) : null
    // Step state is the latest actual execution, not whether some project-level
    // asset happens to exist. Older failed attempts remain visible separately.
    return { key, label: labels[key], status: batchWins ? batch.status : phase ? phaseStatus : latest?.status || 'not_recorded', task_count: relevant.length,
      active_count: active.length, failed_count: failed.length, latest_task_id: batchWins ? batch.activity_task_id || null : latest?.id || null,
      last_progress_at: batchWins ? batchTask?.last_progress_at || batch.updated_at : latest?.last_progress_at || null,
      stale: active.some(task => task.stale), source: batchWins ? 'batch' : phase ? 'preparation' : latest ? 'activity' : null,
      note: phase ? `提示词已就绪 ${current.filter(task=>['ready','completed'].includes(task.status)).length} / ${current.length} 项。依据图片任务内的准备记录，可能包含复用；不会据此宣称每项都重新调用了文字模型。` : null,
      batch_id: batch?.batch_id || null, batch_step_id: batch?.id || null, batch_status: batch?.status || null,
      activity_task_id: batchWins ? batch.activity_task_id : latest?.id || null,
      elapsed_seconds: batchWins ? batchTask?.elapsed_seconds ?? null : latest?.elapsed_seconds ?? null, exception: batchWins ? classifyDashboardException({ status: ['needs_review', 'input_stale', 'blocked'].includes(batch.status) ? 'failed' : batch.status,
        stage: batch.status, errorCode: batch.error_code, error: batch.error }) : latest?.exception || null }
  })
}

export function productionDashboard(query: DashboardQuery = {}, actor: Actor = requireActor()) {
  const projects = projectsFor(actor, query.projectId), now = query.now ?? Date.now()
  const includeUnassigned = actor.role === 'admin' && !query.projectId
  const tasks = allTasks(projects, actor, now, includeUnassigned), counts = emptyCounts(), kinds = new Map<string, any>(), stages = new Map<string, any>()
  const projectIds = projects.map(project => project.id)
  const grouped = projectIds.length || includeUnassigned ? sql.prepare(`SELECT kind,status,stage,count(*) n FROM platform_activity_tasks WHERE ${projectClause(projectIds, includeUnassigned)} GROUP BY kind,status,stage`).all(...projectIds) as any[] : []
  for (const row of grouped) {
    if (statuses.includes(row.status as Status)) counts[row.status as Status] += row.n
    if (!kinds.has(row.kind)) kinds.set(row.kind, { kind: row.kind, total: 0, ...emptyCounts() })
    const kind = kinds.get(row.kind); kind.total += row.n; if (statuses.includes(row.status as Status)) kind[row.status] += row.n
    const stage = row.stage || 'not_recorded'; if (!stages.has(stage)) stages.set(stage, { stage, label: stageLabels[stage] || dashboardSafeText(stage, 80), count: 0 }); stages.get(stage).count += row.n
  }
  const ids = projects.map(project => project.id)
  const batchSteps: any[] = readProductionDashboardSteps(ids, actor)
  const batchCounts: Record<string, number> = { total: batchSteps.length, queued: 0, running: 0, completed: 0, failed: 0, input_stale: 0, needs_review: 0, blocked: 0 }
  for (const step of batchSteps) if (Object.hasOwn(batchCounts, step.status)) batchCounts[step.status]++
  const taskIds = new Set(tasks.map(task => task.id))
  const batchExceptions = batchSteps.filter(step => ['failed', 'input_stale', 'needs_review', 'blocked'].includes(step.status) && !taskIds.has(step.activity_task_id)).map(step => ({
    id: step.id, batch_id: step.batch_id, project_id: step.drama_id, episode_id: step.episode_id, episode_number: step.episode_number,
    target: step.target, status: step.status, activity_task_id: step.activity_task_id,
    error_code: dashboardSafeText(step.error_code, 160), exception: classifyDashboardException({ status: 'failed', stage: step.status, errorCode: step.error_code, error: step.error }),
    href: `/production?drama_id=${step.drama_id}&batch_id=${encodeURIComponent(step.batch_id)}`,
  }))
  // Build each relationship once. Dozens of episodes with thousands of history
  // tasks must not rescan the whole history separately for every episode.
  const tasksByEpisode = new Map<string, typeof tasks>(), batchesByEpisode = new Map<string, any[]>()
  for (const task of tasks) for (const episodeId of new Set(task.episode_ids)) {
    const key = `${task.project_id}:${episodeId}`
    if (!tasksByEpisode.has(key)) tasksByEpisode.set(key, [])
    tasksByEpisode.get(key)!.push(task)
  }
  for (const step of batchSteps) {
    const key = `${step.drama_id}:${step.episode_id}`
    if (!batchesByEpisode.has(key)) batchesByEpisode.set(key, [])
    batchesByEpisode.get(key)!.push(step)
  }
  const episodes = ids.length ? (sql.prepare(`SELECT id,drama_id project_id,episode_number,title FROM episodes WHERE deleted_at IS NULL AND drama_id IN (${placeholder(ids)}) ORDER BY drama_id,episode_number,id`).all(...ids) as any[]).map(episode => {
    const related = tasksByEpisode.get(`${episode.project_id}:${episode.id}`) || []
    const batch = batchesByEpisode.get(`${episode.project_id}:${episode.id}`) || []
    return { ...episode, steps: aggregateSteps(related, batch), task_count: related.length,
      has_exceptions: related.some(task => !!task.exception || task.stale) || batch.some(step => ['failed', 'input_stale', 'needs_review', 'blocked'].includes(step.status)), recorded: related.length > 0 || batch.length > 0 }
  }) : []
  const exceptions = tasks.filter(task => !!task.exception || task.stale)
  const filtered = query.exceptionsOnly ? exceptions : tasks
  const limit = Math.max(1, Math.min(100, query.limit ?? 50)), offset = Math.max(0, query.offset ?? 0)
  return { generated_at: new Date(now).toISOString(), scope: query.projectId ? 'project' : actor.role === 'admin' ? 'all' : 'own', selected_project_id: query.projectId || null,
    projects: query.projectId ? projectsFor(actor) : projects, summary: { tasks_total: tasks.length, episodes_total: episodes.length, episodes_recorded: episodes.filter(episode => episode.recorded).length,
      episodes_unrecorded: episodes.filter(episode => !episode.recorded).length, counts, kinds: [...kinds.values()], stages: [...stages.values()],
      exception_tasks: exceptions.length, stale_tasks: tasks.filter(task => task.stale).length, batch_steps: batchCounts, exception_steps: batchExceptions.length },
    episodes: query.exceptionsOnly ? episodes.filter(episode => episode.has_exceptions) : episodes,
    exceptions: enrichTasks(exceptions.slice(0, 100), actor, now), exceptions_total: exceptions.length,
    batch_steps: batchCounts, batch_exceptions: batchExceptions.slice(0, 100), batch_exceptions_total: batchExceptions.length,
    tasks: { items: enrichTasks(filtered.slice(offset, offset + limit), actor, now), total: filtered.length, limit, offset },
    notes: ['步骤仅依据已记录的实际执行，不按素材数量认定完成。', '长时间无新进展只标记待关注，不等于任务失败。'] }
}

export function productionDashboardTask(identity: string, actor: Actor = requireActor()) {
  const row = sql.prepare('SELECT project_id FROM platform_activity_tasks WHERE id=?').get(identity) as any
  if (!row || !row.project_id && actor.role !== 'admin') throw denied('任务不存在或无访问权限', 404)
  if (row.project_id) assertProjectAccess(row.project_id, actor)
  const task = allTasks(row.project_id ? projectsFor(actor, row.project_id) : [], actor, Date.now(), !row.project_id && actor.role === 'admin', identity).find(task => task.id === identity)
  if (!task) throw denied('任务不存在或无访问权限', 404)
  return enrichTasks([task], actor, Date.now())[0]
}

export function productionDashboardDiagnostics(identity: string, actor: Actor = requireActor()) {
  const task = productionDashboardTask(identity, actor)
  return { recorded_at: new Date().toISOString(), version: process.env.HUOBAO_VERSION || 'development', release: PLATFORM_RELEASE, task, diagnosis: task.exception,
    observation: { last_progress_at: task.last_progress_at, stale: task.stale, stale_after_seconds: DASHBOARD_STALE_SECONDS,
      status_authority: '业务任务及已持久化实况记录；不依据HTTP 200推断完成', hidden_reasoning_included: false, credentials_included: false,
      administrator_channel_link: actor.role === 'admin' && !!task.links.settings },
    guidance: task.exception?.guidance || (task.stale ? '目前没有新的进展记录，请查看原任务日志和平台状态；尚未判定失败。' : '按实况记录核查，不会自动重新提交生成。') }
}
