import { AsyncLocalStorage } from 'node:async_hooks'
import { currentActor } from '../platform-security/index.js'
import { activityProjectForEpisode, createActivityTask, activityEvent, updateActivityTask, ensureActivitySource } from './store.js'
import { sanitizeActivity } from './sanitize.js'
import type { StyleSnapshot } from '../style-preset.js'

export interface ActivityContext { taskId?: string; projectId?: number; episodeId?: number; userId?: number; title?: string; modelParameters?: Record<string, unknown>; textModelParameters?: Record<string, unknown>; assetPreparationJobId?: string; abortSignal?: AbortSignal; styleSnapshot?: StyleSnapshot | null }
const context = new AsyncLocalStorage<ActivityContext>()
export const currentActivity = () => context.getStore() || null
export const withActivityContext = <T>(value: ActivityContext, callback: () => T): T => context.run(value, callback)
const labels: Record<string, string> = { script_rewriter: '剧本改写', extractor: '提取资产', storyboard_breaker: '分镜拆解', prompt_generator: '生成提示词' }
export function activityTitle(agent: any) { const id = String(agent?.id || agent?.name || 'text'); return labels[id] || id || '文字任务' }

/** Existing durable jobs remain authoritative; this only supplies their correlation ID. */
export function withAgentActivity<T>(input: { episodeId: number; dramaId: number; agentType: string }, sourceId: string | undefined, callback: () => T): T {
  const taskId = sourceId ? ensureActivitySource({ kind: 'text', title: labels[input.agentType] || input.agentType, projectId: input.dramaId,
    episodeId: input.episodeId, userId: currentActor()?.id, sourceType: 'agent_jobs', sourceId }) : currentActivity()?.taskId
  return withActivityContext({ ...currentActivity(), taskId, projectId: input.dramaId, episodeId: input.episodeId, userId: currentActor()?.id }, callback)
}
export async function observeAgentOperation<T>(agent: any, messages: any[], options: any, callback: () => Promise<T>): Promise<T> {
  const old = currentActivity(), rc = options.requestContext
  const episodeId = Number(rc?.get?.('episodeId')) || old?.episodeId
  const projectId = Number(rc?.get?.('dramaId')) || old?.projectId || activityProjectForEpisode(episodeId)
  if (old?.taskId) return callback()
  let id: string | undefined
  try { id = createActivityTask({ kind: 'text', title: old?.title || activityTitle(agent), projectId, episodeId,
    userId: currentActor()?.id || old?.userId, request: { messages: sanitizeActivity(messages), operation: agent?.id || agent?.name } }) } catch { /* Diagnostics do not alter model behavior. */ }
  if (!id) return callback()
  return withActivityContext({ ...old, taskId: id, projectId, episodeId, userId: currentActor()?.id || old?.userId }, async () => {
    try {
      const result: any = await callback()
      try {
        let failure: string | undefined
        for (const tool of result?.toolResults || []) {
          let value = tool?.payload?.result ?? tool?.result ?? tool?.payload?.output ?? tool?.output ?? tool?.data
          if (typeof value === 'string') { try { value = JSON.parse(value) } catch {} }
          if (value?.error || tool?.isError || tool?.payload?.isError) { failure = String(value?.error || '业务工具返回失败。'); break }
        }
        updateActivityTask(id!, { status: failure ? 'failed' : 'completed', stage: failure ? 'failed' : 'completed', error: failure || null,
          output: { text: result?.text || '', toolCalls: result?.toolCalls || [], toolResults: result?.toolResults || [] }, usage: result?.totalUsage || result?.usage })
        activityEvent(id!, failure ? 'failed' : 'completed', failure ? '业务工具未完成。' : '文字任务已完成。', failure ? { error: failure } : undefined)
      } catch {}
      return result
    } catch (error: any) {
      try { updateActivityTask(id!, { status: 'failed', stage: 'failed', error: String(error?.message || error) }); activityEvent(id!, 'failed', '文字任务未完成。', { error: String(error?.message || error) }) } catch {}
      throw error
    }
  })
}

/** Read metadata without keeping or modifying the request body. */
export async function activityRequestContext(c: any, next: () => Promise<void>) {
  let body: any = {}
  if (/application\/json/iu.test(c.req.header('content-type') || '') && !/\/auth\//u.test(c.req.path)) {
    try { body = await c.req.json() } catch { /* The actual handler owns input errors. */ }
  }
  const parts = c.req.path.split('/').filter(Boolean), position = parts.indexOf('episodes')
  const episodeId = Number(body.episode_id) || (position >= 0 ? Number(parts[position + 1]) : undefined)
  const projectPosition = parts.indexOf('dramas')
  const projectId = Number(body.drama_id || body.project_id || c.req.query('drama_id') || c.req.header('x-project-id'))
    || (projectPosition >= 0 ? Number(parts[projectPosition + 1]) : undefined) || activityProjectForEpisode(episodeId)
  const title = c.req.path.endsWith('/extract') ? ({ characters: '提取角色', scenes: '提取场景', props: '提取道具' } as any)[body.target] : undefined
  const mediaRoute = ['image', 'video'].includes(body.type) || /generate-(?:images?|videos?|first-frame|last-frame|composed)/u.test(c.req.path)
  const modelParameters = mediaRoute ? body.model_parameters : undefined
  const textModelParameters = body.text_model_parameters ?? (!mediaRoute ? body.model_parameters : undefined)
  return withActivityContext({ projectId, episodeId, userId: currentActor()?.id, title, modelParameters, textModelParameters }, next)
}
