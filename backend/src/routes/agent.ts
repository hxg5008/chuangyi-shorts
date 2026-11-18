/**
 * Agent 聊天路由 — 非流式版本
 */
import { Hono } from 'hono'
import { validAgentTypes } from '../agents/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { mastra } from '../mastra/index.js'
import { runAgentText } from '../services/agent-text-stream.js'
import { success, badRequest, notFound } from '../utils/response.js'
import { agentJobStore, assertAgentEpisode, startValidatedAgentJob } from '../services/agent-jobs.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

// Background jobs return immediately. Refreshing a page only observes the existing job.
app.get('/jobs', async (c) => {
  const episodeId = Number(c.req.query('episode_id'))
  if (!Number.isSafeInteger(episodeId) || episodeId <= 0) return badRequest(c, 'episode_id 必须为正整数')
  try {
    await assertAgentEpisode(episodeId)
    return success(c, agentJobStore.list(episodeId))
  } catch (error: any) { return badRequest(c, error.message) }
})

app.get('/jobs/:id', (c) => {
  const job = agentJobStore.get(c.req.param('id'))
  return job ? success(c, job) : notFound(c, '任务不存在')
})

app.post('/:type/jobs', async (c) => {
  const type = c.req.param('type')
  if (type !== 'storyboard_breaker' && type !== 'prompt_generator') return badRequest(c, '当前后台任务仅支持分镜拆解和视频提示词')
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 100_000) return badRequest(c, 'message 必须为有效任务说明')
  if (![body.episode_id, body.drama_id].every(value => Number.isSafeInteger(value) && value > 0)) return badRequest(c, '需要有效的 drama_id 与 episode_id')
  if (body.storyboard_ids !== undefined && (!Array.isArray(body.storyboard_ids) || !body.storyboard_ids.length || body.storyboard_ids.some((id: any) => !Number.isSafeInteger(id) || id <= 0))) return badRequest(c, 'storyboard_ids 必须为有效分镜 ID 数组')
  if (type === 'prompt_generator' && !body.storyboard_ids?.length) return badRequest(c, '视频提示词任务必须明确提供 storyboard_ids')
  try {
    return success(c, await startValidatedAgentJob({ agentType: type, episodeId: body.episode_id, dramaId: body.drama_id, message: body.message, storyboardIds: body.storyboard_ids ? [...new Set<number>(body.storyboard_ids)] : undefined, model: body.model, configId: body.config_id }))
  } catch (error: any) {
    if (String(error.message).includes('任务执行中')) return c.json({ code: 409, message: error.message }, 409)
    return badRequest(c, error.message)
  }
})

// Mastra v1.17 的 ToolCallChunk / ToolResultChunk 结构：
// { type: 'tool-call', payload: { toolCallId, toolName, args } }
// { type: 'tool-result', payload: { toolCallId, toolName, result, isError } }
function normalizeToolName(entry: any) {
  return entry?.payload?.toolName
    || entry?.toolName
    || entry?.tool?.toolName
    || entry?.tool?.id
    || entry?.name
    || entry?.type
    || null
}

function normalizeToolResult(entry: any) {
  const result = entry?.payload?.result ?? entry?.result ?? entry?.payload?.output ?? entry?.output ?? entry?.data ?? null
  return typeof result === 'string' ? result : JSON.stringify(result)
}

// POST /agent/:type/chat — 非流式 Agent 对话
app.post('/:type/chat', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) {
    return badRequest(c, `无效的 Agent 类型：${agentType}`)
  }

  const body = await c.req.json()
  const { message, drama_id, episode_id } = body
  if (typeof message !== 'string' || !message.trim()) return badRequest(c, 'message 必填')
  if (agentType === 'prompt_generator' && !body.storyboard_ids?.length && /video_prompt|视频提示词|分镜\s*#|storyboard[_ ]?id/i.test(message)) return badRequest(c, '视频提示词任务需要明确的 storyboard_ids，请刷新页面后重试')

  logTaskStart('Agent', agentType, {
    dramaId: drama_id,
    episodeId: episode_id,
    message,
  })
  logTaskPayload('Agent', `${agentType} input`, body)

  if (!episode_id || !drama_id) {
    logTaskError('Agent', agentType, { reason: 'missing drama_id or episode_id' })
    return badRequest(c, '需要 drama_id 与 episode_id')
  }

  // Backward-compatible callers also use the same staged validation path.
  if (agentType === 'storyboard_breaker' || (agentType === 'prompt_generator' && body.storyboard_ids?.length)) {
    try {
      if (agentJobStore.active(episode_id)) return c.json({ code: 409, message: '当前集已有分镜或提示词任务执行中，请等待完成后再操作' }, 409)
      // Legacy clients receive the job handle too, so no HTTP connection waits on a model.
      return success(c, await startValidatedAgentJob({ agentType, episodeId: episode_id, dramaId: drama_id, message, storyboardIds: body.storyboard_ids, model: body.model, configId: body.config_id }))
    } catch (error: any) { return badRequest(c, error.message) }
  }

  const agent = mastra.getAgent(agentType)
  if (!agent) {
    logTaskError('Agent', agentType, { reason: 'agent not found' })
    return badRequest(c, 'Agent 不存在')
  }

  const requestContext = buildAgentRequestContext({
    episodeId: episode_id,
    dramaId: drama_id,
    modelOverride: body.model || undefined,
    textConfigId: body.config_id || undefined,
  })

  const startTime = performance.now()

  try {
    const result = await runAgentText(agent,
      [{ role: 'user', content: message }],
      { maxSteps: 20, requestContext },
    )

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskSuccess('Agent', agentType, { elapsedSeconds: elapsed })

    // 收集所有 tool calls 和 results
    const toolCalls = result.toolCalls || []
    const toolResults = result.toolResults || []
    const normalizedToolCalls = toolCalls.map((tc: any) => ({
      toolName: normalizeToolName(tc),
      args: tc?.payload?.args ?? tc?.args ?? tc?.input ?? null,
    }))
    const normalizedToolResults = toolResults.map((tr: any) => ({
      toolName: normalizeToolName(tr),
      result: normalizeToolResult(tr),
    }))
    const toolError = normalizedToolResults.map((entry: { result: string | null }) => {
      try { return JSON.parse(entry.result || 'null')?.error } catch { return null }
    }).find(Boolean)
    if (toolError) return badRequest(c, `生成工具未完成：${toolError}`)

    logTaskProgress('Agent', 'tool-summary', {
      agentType,
      toolCalls: normalizedToolCalls.map((tc: any) => tc.toolName),
      toolResults: normalizedToolResults.map((tr: any) => tr.toolName),
    })
    logTaskPayload('Agent', `${agentType} tool-results`, normalizedToolResults)

    return success(c, {
      type: 'done',
      text: result.text || '',
      toolCalls: normalizedToolCalls,
      toolResults: normalizedToolResults,
    })
  } catch (err: any) {
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskError('Agent', agentType, { elapsedSeconds: elapsed, error: err.message })
    console.error(err.stack || err)
    return badRequest(c, err.message || 'Agent 执行失败')
  }
})

// GET /agent/:type/debug
app.get('/:type/debug', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) return badRequest(c, '无效的 Agent 类型')
  return success(c, { agent_type: agentType, valid: true })
})

export default app
