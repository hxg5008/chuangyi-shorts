import { Hono } from 'hono'
import { Agent } from '@mastra/core/agent'
import { requireAdmin } from '../services/platform-security/index.js'
import { getConfigById, assertConfigService, assertConfiguredModel, validateModelParameters } from '../services/ai.js'
import { createModelTestTextModel } from '../agents/index.js'
import { generateImage, generateVideo } from '../services/generation.js'
import { runAgentText } from '../services/agent-text-stream.js'
import { createActivityTask, updateActivityTask, activityEvent, activityTask, activityTaskView, parseActivityJSON } from '../services/activity/store.js'
import { withActivityContext } from '../services/activity/context.js'
import { syncActivitySources } from '../services/activity/source-sync.js'
import { activityUsage } from '../services/activity/sanitize.js'
import { created, success, badRequest } from '../utils/response.js'

const app = new Hono()
app.use('*', async (_c, next) => { requireAdmin(); await next() })
const references = (value: any, name: string) => {
  if (value === undefined) return [] as string[]
  if (!Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== 'string' || !item.trim())) throw new Error(`${name} 必须为素材地址数组`)
  return value as string[]
}

// Only this explicit POST creates a billable test. Listing, opening, refreshing
// and connection probes never reach this handler or resubmit a previous test.
app.post('/', async c => {
  try {
    const actor = requireAdmin(), body = await c.req.json()
    const configId = Number(body.config_id)
    if (!Number.isSafeInteger(configId) || configId < 1) return badRequest(c, '请选择已保存的渠道模型')
    const config = await getConfigById(configId)
    if (!config) return badRequest(c, '模型不存在、已停用或未获授权')
    const kind = body.kind
    if (!['text', 'image', 'video'].includes(kind)) return badRequest(c, '请选择文字、图片或视频测试')
    assertConfigService(config, kind)
    assertConfiguredModel(config, body.model)
    if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 1_000_000) return badRequest(c, '测试提示词不能为空或超过100万字符')
    const parameters = validateModelParameters(config, body.parameters)
    const images = references(body.reference_images, '参考图片'), videos = references(body.reference_videos, '参考视频'), audios = references(body.reference_audios, '参考音频')
    if (kind !== 'video' && (videos.length || audios.length)) return badRequest(c, '当前测试入口仅视频任务可携带参考视频和音频')
    if (kind === 'text' && images.length) return badRequest(c, '当前文字测试入口使用纯文本；多模态素材请在图片或视频测试中提交')
    const id = createActivityTask({ kind, title: `${kind === 'text' ? '文字' : kind === 'image' ? '图片' : '视频'}模型试用 · ${config.model}`,
      userId: actor.id, model: config.model, channel: config.channelName || config.provider,
      request: { prompt: body.prompt, parameters, reference_images: images, reference_videos: videos, reference_audios: audios, config_id: configId, explicit_model_test: true } })
    void withActivityContext({ taskId: id, userId: actor.id, modelParameters: parameters, textModelParameters: parameters }, async () => {
      try {
        if (kind === 'text') {
          const model = await createModelTestTextModel(configId, parameters)
          const agent = new Agent({ id: `model-test-${id}`, name: 'Administrator model test', instructions: '', model })
          const result = await runAgentText(agent, [{ role: 'user', content: body.prompt }], { maxSteps: 1, abortSignal: AbortSignal.timeout(600_000) })
          const usage = activityUsage(result.totalUsage || result.usage), output = { text: result.text || '', usage }
          updateActivityTask(id, { status: 'completed', stage: 'completed', output, result: output, usage })
          activityEvent(id, 'completed', '文字模型试用已完成。')
        } else if (kind === 'image') {
          await generateImage({ configId, prompt: body.prompt, referenceImages: images, modelParameters: parameters, activityTaskId: id,
            size: typeof parameters.size === 'string' ? parameters.size : undefined })
        } else {
          await generateVideo({ configId, prompt: body.prompt, referenceImageUrls: images, referenceVideoUrls: videos, referenceAudioUrls: audios,
            modelParameters: parameters, activityTaskId: id,
            duration: typeof parameters.duration === 'number' ? parameters.duration : undefined,
            resolution: typeof parameters.resolution === 'string' ? parameters.resolution : undefined,
            aspectRatio: typeof parameters.aspectRatio === 'string' ? parameters.aspectRatio : undefined })
        }
      } catch (error: any) {
        updateActivityTask(id, { status: 'failed', stage: 'failed', error: String(error?.message || error) })
        activityEvent(id, 'failed', '模型试用未完成；不会自动重新提交。', { error: String(error?.message || error) })
      }
    })
    return created(c, { ...activityTaskView(activityTask(id)), activity_task_id: id })
  } catch (error: any) { return badRequest(c, String(error?.message || error)) }
})
app.get('/:id', c => {
  requireAdmin(); syncActivitySources()
  const row = activityTask(c.req.param('id'))
  if (!row) return c.json({ code: 404, message: '测试任务不存在' }, 404)
  return success(c, { ...activityTaskView(row), activity_task_id: row.id, result: parseActivityJSON(row.result_json) })
})
export default app
