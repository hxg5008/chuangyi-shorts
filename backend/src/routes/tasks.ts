import { Hono } from 'hono'
import { and, desc, eq } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'
import { db, schema } from '../db/index.js'
import { success, created, badRequest } from '../utils/response.js'
import { generateImage, generateVideo, isTaskActive, recoverImageTask, recoverVideoTask, cancelGenerationTask, returnJimengTasks } from '../services/generation.js'
import { safeTaskError } from '../services/video-download.js'
import { getActiveConfig, getConfigById } from '../services/ai.js'
import { composeProjectStyle } from '../services/style-preset.js'
import { resolveStoryboardVoiceReferences } from '../services/character-voice-references.js'
import { logTaskError, logTaskPayload, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { JIMENG_IMAGE_LIMIT } from '../services/adapters/jimeng-local-video.js'

const app = new Hono()
app.post('/:id/cancel', async c => {
  try { await cancelGenerationTask(Number(c.req.param('id'))); return success(c, { id: Number(c.req.param('id')), status: 'cancel_requested' }) }
  catch (error) { return badRequest(c, safeTaskError(error)) }
})

app.post('/:id/recover', async c => {
  try {
    const id = Number(c.req.param('id'))
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
    if (!task) return badRequest(c, '任务不存在')
    if (task.type === 'image') await recoverImageTask(id)
    else if (task.type === 'video') await recoverVideoTask(id)
    else return badRequest(c, '不支持恢复此任务类型')
    return success(c, { id })
  } catch (error) { return badRequest(c, safeTaskError(error)) }
})

// Round 5: 回传视频 — bring a finished Jimeng video back to its shot; only queries, never a new generation.
app.post('/:id/jimeng-return', async c => {
  try {
    const id = Number(c.req.param('id'))
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
    if (!task || task.provider !== 'jimeng_local' || task.type !== 'video') return badRequest(c, '只有即梦视频任务可以回传')
    const [result] = await returnJimengTasks([id])
    return success(c, result || { id, outcome: 'unavailable', message: '这条任务不是"已交即梦"状态，无需回传。' })
  } catch (error) { return badRequest(c, safeTaskError(error)) }
})

app.get('/:id/diagnostics', async c => {
  const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, Number(c.req.param('id'))))
  if (!task) return badRequest(c, '任务不存在')
  let params: any = {}
  try { params = JSON.parse(task.params || '{}') } catch { /* legacy task without parameters */ }
  return success(c, { id: task.id, upstreamTaskId: task.taskId, provider: task.provider, model: task.model,
    status: task.status, stage: task.stage, errorCode: task.errorCode, error: safeTaskError(task.errorMsg),
    hasResult: !!task.resultUrl, hasLocalFile: !!task.localPath, createdAt: task.createdAt, updatedAt: task.updatedAt,
    referenceFailure: params.referenceFailure, providerFailure: params.providerFailure, lastPoll: params.lastPoll,
    version: process.env.HUOBAO_VERSION || 'development' })
})

type TaskType = 'image' | 'video'

const WAN_MEDIA_TYPES = new Set([
  'first_frame',
  'last_frame',
  'reference_image',
  'reference_video',
  'reference_audio',
  'file',
  'link',
])

/**
 * 兼容项目原有扁平入参，也支持 Wan 3.0 官方 model/input/parameters 结构。
 */
function normalizeVideoRequest(body: any) {
  const input = body.input && typeof body.input === 'object' && !Array.isArray(body.input) ? body.input : {}
  const parameters = body.parameters && typeof body.parameters === 'object' && !Array.isArray(body.parameters)
    ? body.parameters
    : {}
  const media = Array.isArray(input.media) ? input.media : []

  const mediaUrls = (type: string) => media
    .filter((item: any) => item?.type === type)
    .map((item: any) => item?.url)

  return {
    ...body,
    prompt: body.prompt ?? input.prompt ?? '',
    reference_image_urls: body.reference_image_urls ?? mediaUrls('reference_image'),
    reference_video_urls: body.reference_video_urls ?? mediaUrls('reference_video'),
    reference_audio_urls: body.reference_audio_urls ?? mediaUrls('reference_audio'),
    first_frame_url: body.first_frame_url ?? mediaUrls('first_frame')[0],
    last_frame_url: body.last_frame_url ?? mediaUrls('last_frame')[0],
    file_url: body.file_url ?? mediaUrls('file')[0],
    link_url: body.link_url ?? mediaUrls('link')[0],
    generate_audio: body.generate_audio ?? parameters.audio,
    duration: body.duration ?? parameters.duration,
    aspect_ratio: body.aspect_ratio ?? parameters.ratio,
    resolution: body.resolution ?? parameters.resolution,
    seed: body.seed ?? parameters.seed,
    prompt_extend: body.prompt_extend ?? parameters.prompt_extend,
    watermark: body.watermark ?? parameters.watermark,
    official_media: media,
  }
}

const EIGHT_API_TASK_FIELDS = new Set([
  'type', 'storyboard_id', 'drama_id', 'config_id', 'model', 'prompt', 'force_new',
  'duration', 'resolution', 'aspect_ratio', 'ratio',
  'reference_image_urls', 'images', 'reference_video_urls', 'videos', 'reference_audio_urls', 'audios',
  'image_url', 'first_frame_url', 'last_frame_url', 'file_url', 'link_url',
  'model_parameters',
])

/** Local /tasks aliases for 888API only; do not reinterpret another provider's official payload. */
export function normalizeEightApiVideoRequest(body: any) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('888API 视频参数必须为对象')
  const unsupported = Object.keys(body).filter(key => !EIGHT_API_TASK_FIELDS.has(key))
  if (unsupported.length) {
    throw new Error(`888API 本地任务接口未接入参数：${unsupported.join('、')}；时长请用 duration，画幅用 aspect_ratio 或 ratio，参考图用 reference_image_urls 或 images`)
  }
  const normalized = { ...body }
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key)
  const pairs = [
    ['aspect_ratio', 'ratio'],
    ['reference_image_urls', 'images'],
    ['reference_video_urls', 'videos'],
    ['reference_audio_urls', 'audios'],
  ] as const
  const valueFor = (key: string, value: unknown) => {
    if (key === 'aspect_ratio') {
      if (typeof value !== 'string' || !value.trim()) throw new Error('aspect_ratio / ratio 必须为非空字符串')
      return value.trim()
    }
    if (!Array.isArray(value) || value.some(url => typeof url !== 'string' || !url.trim())) {
      throw new Error(`${key} 及其别名必须为非空 URL 字符串数组`)
    }
    return value.map(url => url.trim())
  }
  for (const [canonical, alias] of pairs) {
    const canonicalPresent = has(canonical)
    const aliasPresent = has(alias)
    if (!canonicalPresent && !aliasPresent) continue
    const canonicalValue = canonicalPresent ? valueFor(canonical, body[canonical]) : undefined
    const aliasValue = aliasPresent ? valueFor(canonical, body[alias]) : undefined
    if (canonicalPresent && aliasPresent && !isDeepStrictEqual(canonicalValue, aliasValue)) {
      throw new Error(`888API 参数冲突：${canonical} 与 ${alias} 同时提供了不同值，请只保留一个`)
    }
    normalized[canonical] = canonicalPresent ? canonicalValue : aliasValue
    delete normalized[alias]
  }
  return normalizeVideoRequest(normalized)
}

function validateVideoRequest(body: any, provider?: string, capabilities?: Record<string, any>): string | null {
  for (const key of ['reference_image_urls', 'reference_video_urls', 'reference_audio_urls']) {
    if (body[key] !== undefined && !Array.isArray(body[key])) return `${key} 必须为数组`
    if (Array.isArray(body[key]) && body[key].some((url: any) => typeof url !== 'string' || !url.trim())) {
      return `${key} 中的每个 URL 都必须为非空字符串`
    }
  }

  if (body.official_media.length) {
    for (const item of body.official_media) {
      if (!item || typeof item !== 'object' || !WAN_MEDIA_TYPES.has(item.type) || typeof item.url !== 'string' || !item.url.trim()) {
        return 'input.media 中的每项都必须包含官方支持的 type 和非空 url'
      }
    }
    for (const type of ['first_frame', 'last_frame', 'file', 'link']) {
      if (body.official_media.filter((item: any) => item.type === type).length > 1) {
        return `Wan 3.0 input.media 中 ${type} 最多 1 项`
      }
    }
  }

  const imgs = body.reference_image_urls.length
  const vids = body.reference_video_urls.length
  const auds = body.reference_audio_urls.length
  const first = Boolean(body.first_frame_url)
  const last = Boolean(body.last_frame_url)
  const file = Boolean(body.file_url)
  const link = Boolean(body.link_url)

  if ((provider || '').toLowerCase() === 'aliyun') {
    if (imgs > 10 || vids > 5 || auds > 5) return 'Wan 3.0 参考素材超限：图片≤10、视频≤5、音频≤5'
    if (last && !first) return 'Wan 3.0 尾帧必须与首帧同时传入'
    if (file && link) return 'Wan 3.0 file 与 link 不能同时传入'
    if ((first || last) && (imgs + vids + auds > 0 || file || link)) {
      return 'Wan 3.0 的 first_frame/last_frame 不能与 reference_image/reference_video/reference_audio/file/link 混用'
    }
    const total = imgs + vids + auds + Number(first) + Number(last) + Number(file) + Number(link)
    if (total > 20) return 'Wan 3.0 input.media 最多 20 项'
  } else if ((provider || '').toLowerCase() === 'jimeng_local') {
    if (imgs > JIMENG_IMAGE_LIMIT || vids || auds || first || last || file || link || body.image_url) return `即梦本地通道支持文字和最多${JIMENG_IMAGE_LIMIT}张参考图片，暂不支持首尾帧、视频、音频和文件引用`
    if (body.reference_image_names !== undefined && (!Array.isArray(body.reference_image_names) || body.reference_image_names.length !== imgs || body.reference_image_names.some((name:any) => typeof name !== 'string' || !name.trim()))) return '即梦参考图片名称必须与图片逐项对应'
  } else if ((provider || '').toLowerCase() === 'custom_json') {
    if (imgs > (capabilities?.max_images ?? 9) || vids > (capabilities?.max_videos ?? 3) || auds > (capabilities?.max_audios ?? 3)) return '参考素材数量超过所选渠道模型的能力配置'
  } else {
    if (imgs > 9 || vids > 3 || auds > 3) return '参考素材超限：图片≤9、视频≤3、音频≤3'
    if (auds > 0 && imgs + vids === 0) return '参考音频需要至少 1 个参考图片或视频'
  }

  if (!String(body.prompt || '').trim() && imgs + vids + auds === 0 && !first && !last && !file && !link) {
    return '视频生成需要至少一个参考素材或 prompt'
  }
  return null
}

// POST /tasks — 发起生成任务（body.type: image | video）
app.post('/', async (c) => {
  const body = await c.req.json()
  const type = body.type as TaskType
  if (type !== 'image' && type !== 'video') return badRequest(c, 'type 必须为 image 或 video')
  if (body.execution_project_route_id !== undefined && (type !== 'video' || !Number.isSafeInteger(body.execution_project_route_id) || body.execution_project_route_id < 1)) return badRequest(c, '项目执行绑定编号必须是视频任务的正整数。')

  if (type === 'image') {
    if (!body.prompt) return badRequest(c, '提示词必填')
  }

  let videoBody = type === 'video' ? normalizeVideoRequest(body) : null

  try {
    if (type === 'video' && body.storyboard_id) {
      const [latest] = await db.select().from(schema.sysTask).where(and(
        eq(schema.sysTask.type, 'video'), eq(schema.sysTask.storyboardId, Number(body.storyboard_id))
      )).orderBy(desc(schema.sysTask.id)).limit(1)
      if (latest?.status === 'processing') return badRequest(c, '该分镜已有运行中的任务，请等待结果')
      if (latest?.status === 'failed' && body.force_new !== true) {
        return badRequest(c, '请先恢复原任务；重新生成需明确确认可能再次计费')
      }
      if (latest?.provider === 'jimeng_local' && latest.status === 'completed' && latest.stage === 'handed_off' && body.force_new !== true) {
        return badRequest(c, '该分镜的视频已交即梦生成，出片后可回传；重新生成会再次计费，请确认后再提交')
      }
    }
    // 请求显式指定 config_id（工作台模型下拉跨厂商切换）时优先；
    // 未指定才回退到集锁定配置，避免锁定配置与所选模型错配（如锁定 Seedance 却传 MiniMax 模型名）
    let configId: number | undefined = body.config_id
    let episodeResolution: string | undefined
    let storyboardDramaId: number | undefined
    if (body.storyboard_id) {
      const [sb] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, Number(body.storyboard_id)))
      if (sb) {
        const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId))
        const locked = type === 'image' ? ep?.imageConfigId : ep?.videoConfigId
        if (locked != null && configId == null) configId = locked
        if (type === 'video' && ep?.resolution) episodeResolution = ep.resolution
        storyboardDramaId = ep?.dramaId ?? undefined
      }
    }

    if (type === 'video' && videoBody) {
      const effectiveConfig = configId
        ? await getConfigById(configId)
        : await getActiveConfig('video')
      if (videoBody.execution_project_route_id !== undefined && effectiveConfig?.provider !== 'jimeng_local') return badRequest(c, '项目执行绑定编号仅用于即梦本地协议，不能传给其他视频渠道。')
      if (effectiveConfig?.provider === '888api') {
        videoBody = normalizeEightApiVideoRequest(body)
        // 888API's supported channels are 720p even when an older episode stores 480p/1080p.
        episodeResolution = videoBody.resolution || '720p'
      }
      // Jimeng's native canvas receives only supported execution requirements; an old episode's API resolution is unrelated.
      if (effectiveConfig?.provider === 'jimeng_local') episodeResolution = undefined
      const validationError = validateVideoRequest(videoBody, effectiveConfig?.provider, effectiveConfig?.capabilities)
      if (validationError) return badRequest(c, validationError)
      const voices = await resolveStoryboardVoiceReferences(String(videoBody.prompt || ''), Number(body.storyboard_id) || undefined, videoBody.reference_audio_urls)
      videoBody.prompt = voices.prompt
      videoBody.reference_audio_urls = voices.audioUrls
      if (voices.hasVoiceReferences && videoBody.generate_audio === false) return badRequest(c, '引用角色音色时需要开启视频声音')
      const referenceError = validateVideoRequest(videoBody, effectiveConfig?.provider, effectiveConfig?.capabilities)
      if (referenceError) return badRequest(c, referenceError)
    }

    logTaskStart('TaskAPI', 'generate', {
      type,
      storyboardId: body.storyboard_id,
      sceneId: body.scene_id,
      characterId: body.character_id,
      dramaId: body.drama_id,
    })
    logTaskPayload('TaskAPI', 'request body', body)

    // 视频生成时把项目视觉风格词注入提示词最前方（与图片侧的自动注入保持一致口径）
    let videoPrompt = videoBody?.prompt
    let styleSnapshot: unknown
    if (type === 'video' && String(videoPrompt || '').trim()) {
      const dramaId = body.drama_id ?? storyboardDramaId ?? null
      const styled = await composeProjectStyle(dramaId, videoPrompt!, 'video')
      videoPrompt = styled.prompt
      styleSnapshot = styled.snapshot
    }

    const id = type === 'image'
      ? await generateImage({
        storyboardId: body.storyboard_id,
        dramaId: body.drama_id,
        sceneId: body.scene_id,
        characterId: body.character_id,
        prompt: body.prompt,
        model: body.model,
        size: body.size,
        referenceImages: body.reference_images,
        frameType: body.frame_type,
        configId,
      })
      : await generateVideo({
        forceNew: body.force_new === true,
        executionProjectRouteId: videoBody!.execution_project_route_id,
        storyboardId: body.storyboard_id,
        dramaId: body.drama_id,
        prompt: videoPrompt,
        styleSnapshot,
        model: videoBody!.model,
        referenceMode: 'reference',
        imageUrl: videoBody!.image_url,
        firstFrameUrl: videoBody!.first_frame_url,
        lastFrameUrl: videoBody!.last_frame_url,
        referenceImageUrls: videoBody!.reference_image_urls,
        referenceImageNames: videoBody!.reference_image_names,
        referenceVideoUrls: videoBody!.reference_video_urls,
        referenceAudioUrls: videoBody!.reference_audio_urls,
        referenceFileUrl: videoBody!.file_url,
        referenceLinkUrl: videoBody!.link_url,
        generateAudio: videoBody!.generate_audio,
        duration: videoBody!.duration,
        aspectRatio: videoBody!.aspect_ratio,
        resolution: episodeResolution || videoBody!.resolution,
        seed: videoBody!.seed,
        promptExtend: videoBody!.prompt_extend,
        watermark: videoBody!.watermark,
        configId,
      })

    const [record] = await db.select().from(schema.sysTask)
      .where(eq(schema.sysTask.id, id))
    logTaskSuccess('TaskAPI', 'generate', { taskId: id, type, provider: record?.provider })
    return created(c, record)
  } catch (err: any) {
    logTaskError('TaskAPI', 'generate', { type, error: err.message })
    return badRequest(c, err.message)
  }
})

// GET /tasks/:id — 轮询任务状态
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = await db.select().from(schema.sysTask)
    .where(eq(schema.sysTask.id, id))
  return success(c, row || null)
})

// GET /tasks — 按 type / storyboard_id / drama_id 过滤
app.get('/', async (c) => {
  const type = c.req.query('type')
  const storyboardId = c.req.query('storyboard_id')
  const dramaId = c.req.query('drama_id')

  let rows = await db.select().from(schema.sysTask)

  if (type) rows = rows.filter(r => r.type === type)
  if (storyboardId) rows = rows.filter(r => r.storyboardId === Number(storyboardId))
  if (dramaId) rows = rows.filter(r => r.dramaId === Number(dramaId))

  return success(c, rows)
})

// DELETE /tasks/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
  if (task?.status === 'processing' || isTaskActive(id)) return badRequest(c, '任务运行中，暂不能删除')
  // 与恢复入队互斥：锁检查和实际删除之间不让出执行权。
  db.delete(schema.sysTask).where(eq(schema.sysTask.id, id)).run()
  return success(c)
})

export default app
