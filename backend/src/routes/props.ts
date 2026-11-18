import { Hono } from 'hono'
import { assetImagePreparationMiddleware } from '../services/asset-image-preparation.js'
import { and, eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, created, badRequest, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { generateImage } from '../services/generation.js'
import { prepareAssetRedraw } from '../services/asset-image-input.js'
import { recordUploadedAssetImage } from '../services/asset-image-history.js'
import { getDramaStylePrompt } from '../services/style-preset.js'
import { ensurePropFinalPrompt } from '../services/final-prompt.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()
app.use('/:id/generate-image',assetImagePreparationMiddleware('prop',(path,init)=>app.request(path,init)))
// 道具图：白底单品静物，方形画布
const PROP_IMAGE_SIZE = '1024x1024'

// POST /props — 手动新增道具（传入 episode_id 时关联到该集）
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.drama_id) return badRequest(c, 'drama_id 必填')
  if (!body.name?.trim()) return badRequest(c, '名称必填')
  const ts = now()
  const res = await db.insert(schema.props).values({
    name: body.name.trim(),
    type: body.type || '',
    description: body.description || '',
    dramaId: body.drama_id,
    createdAt: ts,
    updatedAt: ts,
  })
  const propId = getInsertId(res)
  if (body.episode_id) {
    const existing = await db.select().from(schema.episodeProps)
      .where(and(eq(schema.episodeProps.episodeId, Number(body.episode_id)), eq(schema.episodeProps.propId, propId)))
    if (!existing.length) {
      await db.insert(schema.episodeProps).values({ episodeId: Number(body.episode_id), propId, createdAt: ts })
    }
  }
  const [row] = await db.select().from(schema.props).where(eq(schema.props.id, propId))
  return created(c, toSnakeCase(row))
})

// DELETE /props/:id — 软删除；round 3 (A6): its storyboard bindings are removed in the same transaction
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  db.transaction(tx => {
    tx.update(schema.props).set({ deletedAt: now(), updatedAt: now() }).where(eq(schema.props.id, id)).run()
    tx.delete(schema.storyboardProps).where(eq(schema.storyboardProps.propId, id)).run()
  })
  return success(c)
})

// PUT /props/:id — 更新道具（物品外貌/类型/最终提示词）
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  if (body.name !== undefined) updates.name = body.name
  if (body.type !== undefined) updates.type = body.type
  if (body.description !== undefined) updates.description = body.description
  // 用户上传道具图：直接写入图片地址与本地路径
  if (body.image_url !== undefined) updates.imageUrl = body.image_url
  else if (body.imageUrl !== undefined) updates.imageUrl = body.imageUrl
  if (body.local_path !== undefined) updates.localPath = body.local_path
  else if (body.localPath !== undefined) updates.localPath = body.localPath
  // 手动编辑最终提示词时以传入值为准。
  // Round 3 (A4): a changed name or appearance makes the saved product-shot prompt stale; clear it unless a new
  // prompt is supplied. Saving the same text again changes nothing.
  const [before] = await db.select().from(schema.props).where(eq(schema.props.id, id))
  const lookChanged = Boolean(before) && (['name', 'description'] as const).some(key => key in updates && (updates[key] ?? '') !== (before![key] ?? ''))
  const promptGiven = body.final_prompt !== undefined || body.finalPrompt !== undefined
  const givenPrompt = body.final_prompt !== undefined ? body.final_prompt : body.finalPrompt
  if (promptGiven && !(lookChanged && (givenPrompt || null) === (before?.finalPrompt || null))) updates.finalPrompt = givenPrompt || null
  else if (lookChanged) updates.finalPrompt = null
  if (typeof updates.imageUrl === 'string' && updates.imageUrl.trim()) {
    await recordUploadedAssetImage('prop', id, updates.imageUrl)
    delete updates.imageUrl
    delete updates.localPath
  }
  await db.update(schema.props).set(updates).where(eq(schema.props.id, id))
  return success(c, { final_prompt_cleared: lookChanged && updates.finalPrompt === null && Boolean(before?.finalPrompt) })
})

/** 本地兜底提示词：白底单品，不掺杂其他元素 */
function propImagePrompt(prop: typeof schema.props.$inferSelect, stylePrompt = '') {
  return [
    stylePrompt || '',
    `single product photo of ${prop.name}`,
    prop.description || '',
    'isolated on a pure white background',
    'no other objects, no people, no scenery',
    'soft even studio lighting',
    'high detail',
    'no text, no watermark',
  ].filter(Boolean).join(', ')
}

// POST /props/:id/generate-prompt — 独立生成/重新生成白底单品最终提示词（不生图）
app.post('/:id/generate-prompt', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, id))
  if (!prop) return badRequest(c, '道具不存在')
  if (!body.episode_id) return badRequest(c, 'episode_id 必填')

  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id)))
  if (!ep) return badRequest(c, '剧集不存在')

  logTaskStart('FinalPrompt', 'prop-generate', { propId: id, episodeId: ep.id, force: !!body.force })
  const finalPrompt = await ensurePropFinalPrompt(prop, ep.id, !!body.force, { model: body.text_model, configId: body.text_config_id ?? undefined })
  if (!finalPrompt) {
    logTaskError('FinalPrompt', 'prop-generate', { propId: id, error: 'agent returned empty prompt' })
    return badRequest(c, '最终提示词生成失败，请重试')
  }
  logTaskSuccess('FinalPrompt', 'prop-generate', { propId: id })
  return success(c, { final_prompt: finalPrompt })
})

// POST /props/:id/generate-image — 生成道具白底单品图
app.post('/:id/generate-image', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, id))
  if (!prop) return badRequest(c, '道具不存在')
  if (!body.episode_id) return badRequest(c, 'episode_id 必填')

  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id)))
  if (!ep) return badRequest(c, '剧集不存在')

  if (body.manual !== undefined && typeof body.manual !== 'boolean') return badRequest(c, '手动重绘标记不正确。')
  if (body.manual === true) {
    try {
      const input = await prepareAssetRedraw(body, prop, ep)
      const genId = await generateImage({ propId: id, dramaId: prop.dramaId, prompt: input.prompt, model: input.model,
        configId: input.configId, size: PROP_IMAGE_SIZE, referenceImages: input.referenceImages, referenceImageHashes: input.referenceImageHashes,
        referenceImageSources: input.referenceImageSources, manualAssetImage: true })
      return success(c, { image_generation_id: genId })
    } catch (error: any) { const status = [400,401,403,404,409,413].includes(error.status) ? error.status : 400; return c.json({code:status,message:error.message},status) }
  }

  const stylePrompt = await getDramaStylePrompt(prop.dramaId, 'asset_image')
  const finalPrompt = await ensurePropFinalPrompt(prop, ep.id, false, { model: body.text_model, configId: body.text_config_id ?? undefined })
  const prompt = finalPrompt || propImagePrompt(prop, stylePrompt)
  try {
    logTaskStart('PropImage', 'generate', { propId: id, episodeId: ep.id, dramaId: prop.dramaId })
    const genId = await generateImage({ propId: id, dramaId: prop.dramaId, prompt, model: body.model, size: PROP_IMAGE_SIZE, configId: body.config_id ?? ep.imageConfigId ?? undefined })
    logTaskSuccess('PropImage', 'generate', { propId: id, generationId: genId })
    return success(c, { image_generation_id: genId })
  } catch (err: any) {
    logTaskError('PropImage', 'generate', { propId: id, error: err.message })
    return badRequest(c, err.message)
  }
})

export default app
