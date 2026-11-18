import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { createStoryboardSession } from './storyboard-session.js'
import { runSkillStoryboardWorkflow, type WorkflowRequestStat } from './skill-storyboard-workflow.js'
import { StoryboardDraftStore } from './storyboard-draft-store.js'
import { getTextConfig, getConfigById } from './ai.js'
import { getDramaStyleSnapshot, styleContext, recordStyleTaskSnapshot, recordedStyleTaskSnapshot, type StyleSnapshot } from './style-preset.js'
import { extractTextProviderFailure } from './text-provider-http.js'
import { AgentJobStore, type AgentJob, type JobIssue } from './agent-job-store.js'
import { logTaskError, logTaskProgress, logTaskSuccess } from '../utils/task-logger.js'
import { withAgentActivity } from './activity/context.js'
import { syncAgentActivity } from './activity/source-sync.js'

export const agentJobStore = new AgentJobStore(db.$client)
export const storyboardDraftStore = new StoryboardDraftStore(db.$client)
/** Service dependency boundary, also used by offline HTTP acceptance fixtures. */
export const agentWorkflowRuntime = { execute: runSkillStoryboardWorkflow }
// A restart never resubmits model requests. Candidate writes were never committed.
agentJobStore.recoverInterrupted()
storyboardDraftStore.recoverInterrupted()

interface AgentJobInput {
  agentType: 'storyboard_breaker' | 'prompt_generator'
  episodeId: number
  dramaId: number
  message: string
  storyboardIds?: number[]
  model?: string
  configId?: number
  styleSnapshot?: StyleSnapshot | null
}
export const publicIssues = (issues: any[]): JobIssue[] => issues.map(issue => ({
  code: issue.code, message: issue.message, severity: issue.severity,
  storyboard_id: issue.storyboardId, shot_number: issue.shotNumber, field: issue.field,
})).sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'))

function providerFailureMessage(failure: ReturnType<typeof extractTextProviderFailure>) {
  return failure.statusCode ? `上游文本服务返回 HTTP ${failure.statusCode}${failure.statusCode === 504 ? '（网关超时）' : ''}：${failure.message}` : failure.message
}

export async function assertAgentEpisode(episodeId: number, dramaId?: number) {
  const episode = await db.select().from(schema.episodes).where(and(eq(schema.episodes.id, episodeId), isNull(schema.episodes.deletedAt))).get()
  if (!episode || (dramaId !== undefined && episode.dramaId !== dramaId)) throw new Error('当前集不存在或不属于此项目')
  return episode
}

export async function runValidatedAgent(input: AgentJobInput, onState?: (phase: 'generating' | 'validating' | 'repairing', attempt: number) => void,
  onProgress?: (progress: { draft_id: string; total: number; completed: number; failed: number; current_group?: number }) => void) {
  const job = agentJobStore.active(input.episodeId)
  if (job) syncAgentActivity(job)
  const recorded = job ? recordedStyleTaskSnapshot(job.id) : undefined
  const frozenInput = { ...input, styleSnapshot: recorded !== undefined ? recorded : 'styleSnapshot' in input ? input.styleSnapshot : getDramaStyleSnapshot(input.dramaId) }
  if (job) recordStyleTaskSnapshot(job.id, frozenInput.styleSnapshot || null)
  return withAgentActivity(frozenInput, job?.id, () => runWithAutomaticContinuation(frozenInput, job?.id, onState, onProgress))
}

/**
 * Round 3 R2 (2026-11-08, user-approved "按你建议来"): the user should not have to press 继续生成 for errors that are
 * not about the content. When a storyboard breakdown round ends with unfinished groups, the same job starts another
 * round exactly as the 继续生成 button does: the same saved draft is resumed (same fingerprint), finished groups are
 * kept, and each round has fresh per-group request budgets. Limits:
 *  - at most 2 extra rounds, and only while the previous round made progress (more finished groups, or a plan where
 *    there was none), so a group the model really cannot write is left for the user with its reason;
 *  - only while the job is still running (a restart marks it ended; nothing continues behind the user's back);
 *  - all rounds together stay within the workflow's 90-minute limit.
 */
export const AUTOMATIC_CONTINUATION_ROUNDS = 2
const JOB_TIME_LIMIT_MS = 90 * 60_000, MINIMUM_ROUND_MS = 5 * 60_000
/** A round that ended on an upstream/transport failure gets a short pause, so a busy relay pool can recover. */
const CONTINUATION_PAUSE_MS = 20_000
async function runWithAutomaticContinuation(input: AgentJobInput, jobId: string | undefined, onState?: (phase: 'generating' | 'validating' | 'repairing', attempt: number) => void,
  onProgress?: (progress: { draft_id: string; total: number; completed: number; failed: number; current_group?: number }) => void) {
  const startedAt = Date.now()
  let result = await runValidatedAgentOriginal(input, onState, onProgress)
  if (input.agentType !== 'storyboard_breaker' || !jobId) return result
  const stats = (value: typeof result) => ((value.result as any)?.requestStats || []) as WorkflowRequestStat[]
  const totals = { modelCalls: result.result?.modelCalls || 0, repairCalls: result.result?.repairCalls || 0,
    autoRecoveryCalls: (result.result as any)?.autoRecoveryCalls || 0, requestStats: [...stats(result)] }
  const readyCount = (draftId?: string) => {
    const draft = draftId ? storyboardDraftStore.get(draftId) : null
    return draft ? { groups: draft.groups.length, ready: draft.groups.filter(group => group.status === 'ready').length, committed: draft.status === 'committed' } : null
  }
  let before = readyCount(result.draft_id)
  for (let round = 1; round <= AUTOMATIC_CONTINUATION_ROUNDS && result.status === 'needs_revision'; round++) {
    // Nothing was planned or started (for example the script or assets are unusable): nothing to continue.
    if (!result.draft_id || !before || before.committed) break
    if (agentJobStore.get(jobId)?.status !== 'running') break
    const remaining = JOB_TIME_LIMIT_MS - (Date.now() - startedAt)
    if (remaining < MINIMUM_ROUND_MS) { logTaskProgress('AgentJob', 'automatic-continue-stopped', { episodeId: input.episodeId, round, reason: 'time-limit' }); break }
    const lastFailure = stats(result).at(-1)?.errorCode
    if (lastFailure && ['upstream_http_error', 'upstream_http_504', 'network_error', 'text_provider_error'].includes(lastFailure)) {
      await new Promise(resolve => setTimeout(resolve, Math.min(CONTINUATION_PAUSE_MS, remaining - MINIMUM_ROUND_MS)))
      if (agentJobStore.get(jobId)?.status !== 'running') break
    }
    logTaskProgress('AgentJob', 'automatic-continue', { episodeId: input.episodeId, round, ready: before.ready, groups: before.groups })
    const next = await runValidatedAgentOriginal(input, onState, onProgress, JOB_TIME_LIMIT_MS - (Date.now() - startedAt))
    totals.modelCalls += next.result?.modelCalls || 0
    totals.repairCalls += next.result?.repairCalls || 0
    totals.autoRecoveryCalls += (next.result as any)?.autoRecoveryCalls || 0
    totals.requestStats.push(...stats(next))
    const after = readyCount(next.draft_id)
    const progressed = Boolean(after && (after.committed || after.ready > before.ready || before.groups === 0 && after.groups > 0))
    result = next
    if (!progressed) { logTaskProgress('AgentJob', 'automatic-continue-stopped', { episodeId: input.episodeId, round, reason: 'no-progress' }); break }
    before = after
  }
  return { ...result, result: { ...result.result, ...totals } }
}
async function runValidatedAgentOriginal(input: AgentJobInput, onState?: (phase: 'generating' | 'validating' | 'repairing', attempt: number) => void,
  onProgress?: (progress: { draft_id: string; total: number; completed: number; failed: number; current_group?: number }) => void, timeoutMs?: number) {
  const episode = await assertAgentEpisode(input.episodeId, input.dramaId)
  if (input.agentType === 'storyboard_breaker' && !(episode.scriptContent || episode.content)?.trim()) throw new Error('当前集缺少剧本，无法拆分分镜')
  if (input.agentType === 'prompt_generator') {
    if (!input.storyboardIds?.length) throw new Error('视频提示词任务必须明确提供 storyboard_ids')
    const rows = await db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, input.episodeId))
    if (input.storyboardIds.some(id => !rows.some(row => row.id === id && !row.deletedAt))) throw new Error('待处理分镜不存在于当前集')
  }
  let currentAttempt = 0
  const requestContext = buildAgentRequestContext({ episodeId: input.episodeId, dramaId: input.dramaId, modelOverride: input.model, textConfigId: input.configId })
  const session = createStoryboardSession({
    mode: input.agentType === 'storyboard_breaker' ? 'breakdown' : 'prompt',
    episodeId: input.episodeId, dramaId: input.dramaId, storyboardIds: input.storyboardIds,
    language: requestContext.get('language'),
    validationProfile: 'skill-content',
    onPhase: () => onState?.('validating', currentAttempt),
  })
  return agentWorkflowRuntime.execute({ episodeId: input.episodeId, dramaId: input.dramaId,
    mode: input.agentType === 'storyboard_breaker' ? 'breakdown' : 'prompt', storyboardIds: input.storyboardIds,
    requestContext, session, message: input.message, onProgress,
    onState: (phase, attempt) => { currentAttempt = attempt; onState?.(phase, attempt) },
  }, { store: storyboardDraftStore, ...(timeoutMs !== undefined ? { timeoutMs } : {}), loadProjectStyle: async () => styleContext(input.styleSnapshot || null), loadModelIdentity: async () => {
    const config = (input.configId ? await getConfigById(input.configId) : null) || await getTextConfig()
    return config ? { provider: config.provider, model: input.model || config.model, baseURL: config.baseUrl, temperature: config.temperature } : null
  } })
}

export async function startValidatedAgentJob(input: AgentJobInput) {
  await assertAgentEpisode(input.episodeId, input.dramaId)
  if (input.agentType === 'prompt_generator' && !input.storyboardIds?.length) throw new Error('视频提示词任务必须明确提供 storyboard_ids')
  const { job, alreadyRunning } = agentJobStore.start({
    agent_type: input.agentType, episode_id: input.episodeId, drama_id: input.dramaId,
    scope: 'agent', storyboard_ids: input.storyboardIds || [],
  })
  if (!alreadyRunning) {
    void runValidatedAgent(input, (phase, attempt) => { agentJobStore.update(job.id, { phase, attempt }) }, progress => { agentJobStore.update(job.id, progress) })
      .then(result => {
        const current = agentJobStore.get(job.id)!
        agentJobStore.update(job.id, { status: result.status, phase: result.status, attempt: result.attempt,
          draft_id: result.draft_id, completed: result.status === 'done' ? current.total : current.completed,
          failed: result.status === 'done' ? 0 : Math.max(1, current.failed), issues: publicIssues(result.issues),
          model_calls: result.result?.modelCalls, repair_calls: result.result?.repairCalls,
          auto_recovery_calls: result.result?.autoRecoveryCalls, request_stats: result.result?.requestStats })
        logTaskSuccess('AgentJob', result.status, { jobId: job.id, episodeId: input.episodeId, saved: result.saved })
      })
      .catch(error => {
        const failure = extractTextProviderFailure(error)
        const current = agentJobStore.get(job.id)
        const elapsed = Math.max(0, (Date.now() - Date.parse(job.started_at)) / 1000)
        agentJobStore.update(job.id, { status: 'error', phase: 'error', failed: 1, error: providerFailureMessage(failure),
          error_code: failure.code, provider_http_status: failure.statusCode, provider_request_id: failure.requestId,
          failure_phase: current?.phase, elapsed_seconds: Math.round(elapsed * 10) / 10,
        })
        logTaskError('AgentJob', 'error', { jobId: job.id, error: failure.message, statusCode: failure.statusCode, requestId: failure.requestId, elapsedSeconds: Math.round(elapsed * 10) / 10 })
      })
  }
  return { job_id: job.id, already_running: alreadyRunning }
}

export async function startVideoPromptBatchJob(episodeId: number, dramaId: number, opts: { model?: string; configId?: number } = {}, storyboardIds?: number[]) {
  const episode = await assertAgentEpisode(episodeId, dramaId)
  const rows = await db.select().from(schema.storyboards).where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt))).orderBy(schema.storyboards.storyboardNumber)
  if (storyboardIds?.some(id => !rows.some(row => row.id === id))) throw new Error('所选分镜不存在于当前集')
  const pending = storyboardIds?.length ? rows.filter(row => storyboardIds.includes(row.id)) : rows.filter(row => !row.videoPrompt?.trim())
  const active = agentJobStore.active(episodeId)
  if (active?.scope === 'video_prompt_batch') {
    if (storyboardIds?.length && JSON.stringify([...new Set(storyboardIds)].sort((a, b) => a - b)) !== JSON.stringify([...active.storyboard_ids].sort((a, b) => a - b))) throw new Error('当前集已有其他分镜提示词任务执行中，请等待完成后再操作')
    return { started: false, total: -1, job_id: active.id }
  }
  if (active) throw new Error('当前集已有分镜或提示词任务执行中，请等待完成后再操作')
  if (!pending.length) return { started: false, total: 0 }
  let videoLabel = '默认'
  if (episode.videoConfigId) {
    const cfg = await db.select({ name: schema.aiServiceConfigs.name, provider: schema.aiServiceConfigs.provider, model: schema.aiServiceConfigs.model }).from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, episode.videoConfigId)).get()
    if (cfg) videoLabel = `${cfg.name} (${cfg.provider}) ${cfg.model || ''}`
  }
  const { job, alreadyRunning } = agentJobStore.start({ agent_type: 'prompt_generator', scope: 'video_prompt_batch', episode_id: episodeId, drama_id: dramaId, storyboard_ids: pending.map(row => row.id), total: pending.length })
  if (alreadyRunning) return { started: false, total: -1, job_id: job.id }
  void (async () => {
    let completed = 0, failed = 0
    const issues: JobIssue[] = []
    for (const row of pending) {
      agentJobStore.update(job.id, { current_storyboard_id: row.id, phase: 'generating', attempt: 0 })
      try {
        const result = await runValidatedAgent({
          agentType: 'prompt_generator', episodeId, dramaId, storyboardIds: [row.id], model: opts.model, configId: opts.configId,
          message: `请基于已提供的锁定分镜 #${row.storyboardNumber}(ID:${row.id})及相邻资料，按 video-prompt skill 完整生成视频提示词。视频模型：${videoLabel}。只更新 storyboard_id:${row.id} 的 video_prompt，不改其他字段；素材引用和保存由系统按本次传输协议处理。`,
        }, (phase, attempt) => { agentJobStore.update(job.id, { phase, attempt }) }, progress => { agentJobStore.update(job.id, { draft_id: progress.draft_id }) })
        issues.push(...publicIssues(result.issues))
        if (result.status === 'done') completed++
        else failed++
      } catch (error: any) {
        const failure = extractTextProviderFailure(error)
        agentJobStore.update(job.id, { error_code: failure.code, provider_http_status: failure.statusCode, provider_request_id: failure.requestId,
          failure_phase: agentJobStore.get(job.id)?.phase, elapsed_seconds: Math.round((Date.now() - Date.parse(job.started_at)) / 100) / 10 })
        failed++
        issues.push({ code: failure.code, message: providerFailureMessage(failure), severity: 'error', storyboard_id: row.id, shot_number: row.storyboardNumber ?? undefined })
      }
      agentJobStore.update(job.id, { completed, failed, issues: [...issues].sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error')).slice(0, 300) })
    }
    const status = failed ? 'needs_revision' : 'done'
    agentJobStore.update(job.id, { status, phase: status, completed, failed, current_storyboard_id: undefined, issues: [...issues].sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error')).slice(0, 300) })
  })().catch(error => {
    const failure = extractTextProviderFailure(error)
    agentJobStore.update(job.id, { status: 'error', phase: 'error', error: providerFailureMessage(failure), error_code: failure.code, provider_http_status: failure.statusCode, provider_request_id: failure.requestId,
      failure_phase: agentJobStore.get(job.id)?.phase, elapsed_seconds: Math.round((Date.now() - Date.parse(job.started_at)) / 100) / 10 })
  })
  return { started: true, total: pending.length, job_id: job.id }
}

export function latestVideoPromptBatch(episodeId: number): AgentJob | null {
  return agentJobStore.list(episodeId).find(job => job.scope === 'video_prompt_batch') ?? null
}
