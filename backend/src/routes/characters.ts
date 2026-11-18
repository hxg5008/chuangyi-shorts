import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { and, eq, isNull } from 'drizzle-orm'
import fs from 'node:fs/promises'
import { db, getInsertId, schema } from '../db/index.js'
import { success, created, badRequest, notFound, now } from '../utils/response.js'
import { AUDIO_MAX_BYTES, AudioUploadError, saveAudioUpload } from '../utils/audio-upload.js'
import { getAbsolutePath } from '../utils/storage.js'
import { toSnakeCase } from '../utils/transform.js'
import { generateImage } from '../services/generation.js'
import { prepareAssetRedraw } from '../services/asset-image-input.js'
import { recordUploadedAssetImage } from '../services/asset-image-history.js'
import { getDramaStylePrompt } from '../services/style-preset.js'
import { ensureCharacterFinalPrompt } from '../services/final-prompt.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { serializeVoiceCard } from '../services/character-voice-card.js'
import { fillMissingVoiceCards } from '../services/extraction.js'
import { assetImagePreparationMiddleware } from '../services/asset-image-preparation.js'
import { requireActor } from '../services/platform-security/index.js'
import { characterEpisodeUsage } from '../services/character-episodes.js'

const app = new Hono()
app.use('/:id/generate-image',assetImagePreparationMiddleware('character',(path,init)=>app.request(path,init)))
const CHARACTER_IMAGE_SIZE = '1920x1080'

// GET /characters/:id/episodes — saved episode associations, never model inference.
app.get('/:id/episodes', c => {
  const actor = requireActor(), value = c.req.param('id')
  if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) return badRequest(c, '角色编号无效')
  return success(c, characterEpisodeUsage(Number(value), actor))
})

// 用户上传的角色音色样本独立于生图和 AI 提取，跨剧集复用同一个角色绑定。
app.post('/:id/voice', bodyLimit({ maxSize: AUDIO_MAX_BYTES + 64 * 1024,
  onError: c => badRequest(c, '音频文件大小不能超过 20MB'),
}), async c => {
  const id = Number(c.req.param('id'))
  if (!Number.isSafeInteger(id) || id <= 0) return badRequest(c, '角色编号无效')
  const condition = and(eq(schema.characters.id, id), isNull(schema.characters.deletedAt))
  const char = db.select({ id: schema.characters.id }).from(schema.characters).where(condition).get()
  if (!char) return notFound(c, '角色不存在')
  let uploadedPath: string | undefined
  try {
    const body = await c.req.parseBody()
    const audio = await saveAudioUpload(body.file)
    uploadedPath = audio.path
    const updated = db.update(schema.characters)
      .set({ voiceAudioUrl: audio.path, voiceAudioName: audio.name, updatedAt: now() })
      .where(condition).returning({ id: schema.characters.id }).get()
    if (!updated) {
      await fs.unlink(getAbsolutePath(audio.path))
      return notFound(c, '角色不存在')
    }
    return success(c, { voice_audio_url: audio.path, voice_audio_name: audio.name })
  } catch (error) {
    if (uploadedPath) await fs.unlink(getAbsolutePath(uploadedPath)).catch(() => {})
    if (error instanceof AudioUploadError) return badRequest(c, error.message)
    throw error
  }
})

// 只移除角色绑定，不删除可能仍被引用的媒体文件。
app.delete('/:id/voice', async c => {
  const id = Number(c.req.param('id'))
  if (!Number.isSafeInteger(id) || id <= 0) return badRequest(c, '角色编号无效')
  const updated = db.update(schema.characters)
    .set({ voiceAudioUrl: null, voiceAudioName: null, updatedAt: now() })
    .where(and(eq(schema.characters.id, id), isNull(schema.characters.deletedAt)))
    .returning({ id: schema.characters.id }).get()
  if (!updated) return notFound(c, '角色不存在')
  return success(c, { voice_audio_url: null, voice_audio_name: null })
})

// POST /characters — 手动新增角色（传入 episode_id 时关联到该集）
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.drama_id) return badRequest(c, 'drama_id 必填')
  if (!body.name?.trim()) return badRequest(c, '名称必填')
  const ts = now()
  const res = await db.insert(schema.characters).values({
    name: body.name.trim(),
    role: body.role || '',
    description: body.description || '',
    appearance: body.appearance || '',
    styling: body.styling || '',
    dramaId: body.drama_id,
    createdAt: ts,
    updatedAt: ts,
  })
  const charId = getInsertId(res)
  if (body.episode_id) {
    const existing = await db.select().from(schema.episodeCharacters)
      .where(and(eq(schema.episodeCharacters.episodeId, Number(body.episode_id)), eq(schema.episodeCharacters.characterId, charId)))
    if (!existing.length) {
      await db.insert(schema.episodeCharacters).values({ episodeId: Number(body.episode_id), characterId: charId, createdAt: ts })
    }
  }
  const [row] = await db.select().from(schema.characters).where(eq(schema.characters.id, charId))
  return created(c, toSnakeCase(row))
})

function characterImagePrompt(char: typeof schema.characters.$inferSelect, stylePrompt = '') {
  return [
    stylePrompt || '',
    char.name,
    char.appearance || char.description || '人物立绘',
    char.styling || '',
    '16:9 横版角色定妆照',
    '半身角色海报构图',
    '正面',
    '高质量',
    '白色背景',
  ].filter(Boolean).join(', ')
}

// PUT /characters/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  for (const key of ['name', 'role', 'description', 'appearance', 'styling', 'imageUrl', 'localPath']) {
    const snakeKey = key.replace(/[A-Z]/g, m => '_' + m.toLowerCase())
    if (snakeKey in body) updates[key] = body[snakeKey]
    else if (key in body) updates[key] = body[key]
  }
  // 声线卡：手动编辑以传入值为准；null/空串表示清除；格式不符直接拒绝，不静默保存。
  // 手改过的卡标记为 manual，之后的自动对齐（老年版音色统一）不会再改它。
  if ('voice_card' in body) {
    const value = body.voice_card && typeof body.voice_card === 'object' ? { ...body.voice_card, origin: 'manual' } : body.voice_card
    const serialized = serializeVoiceCard(value)
    if (serialized.error) return badRequest(c, `声线卡格式不符：${serialized.error}`)
    updates.voiceCard = serialized.value
  }
  // 手动编辑最终提示词时以传入值为准。
  // Round 3 (A4, 2026-11-08): when the look itself changes (appearance/styling) and no new prompt is supplied, the
  // saved image prompt still describes the old look; clear it so the next image is written from the new text.
  // A request that saves the same text again (the detail panel sends every field) changes nothing.
  const [before] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  const lookChanged = Boolean(before) && (['appearance', 'styling'] as const).some(key => key in updates && (updates[key] ?? '') !== (before![key] ?? ''))
  const promptGiven = body.final_prompt !== undefined || body.finalPrompt !== undefined
  const givenPrompt = body.final_prompt !== undefined ? body.final_prompt : body.finalPrompt
  if (promptGiven && !(lookChanged && (givenPrompt || null) === (before?.finalPrompt || null))) updates.finalPrompt = givenPrompt || null
  else if (lookChanged) updates.finalPrompt = null
  if (typeof updates.imageUrl === 'string' && updates.imageUrl.trim()) {
    await recordUploadedAssetImage('character', id, updates.imageUrl)
    delete updates.imageUrl
    delete updates.localPath
  }
  await db.update(schema.characters).set(updates).where(eq(schema.characters.id, id))
  return success(c, { final_prompt_cleared: lookChanged && updates.finalPrompt === null && Boolean(before?.finalPrompt) })
})

// DELETE /characters/:id
// Round 3 (A6): the storyboard bindings of a deleted character are removed too; hidden bindings otherwise blocked
// prompt regeneration with "角色绑定无效" and could not be removed in the UI.
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  db.transaction(tx => {
    tx.update(schema.characters).set({ deletedAt: now() }).where(eq(schema.characters.id, id)).run()
    tx.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.characterId, id)).run()
  })
  return success(c)
})

// POST /characters/:id/generate-image
app.post('/:id/generate-image', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [char] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  if (!char) return badRequest(c, '角色不存在')
  if (!body.episode_id) return badRequest(c, 'episode_id 必填')

  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id)))
  if (!ep) return badRequest(c, '剧集不存在')

  if (body.manual !== undefined && typeof body.manual !== 'boolean') return badRequest(c, '手动重绘标记不正确。')
  if (body.manual === true) {
    try {
      const input = await prepareAssetRedraw(body, char, ep)
      const genId = await generateImage({ characterId: id, dramaId: char.dramaId, prompt: input.prompt, model: input.model,
        configId: input.configId, size: CHARACTER_IMAGE_SIZE, referenceImages: input.referenceImages, referenceImageHashes: input.referenceImageHashes,
        referenceImageSources: input.referenceImageSources, manualAssetImage: true })
      return success(c, { image_generation_id: genId })
    } catch (error: any) { const status = [400,401,403,404,409,413].includes(error.status) ? error.status : 400; return c.json({code:status,message:error.message},status) }
  }

  const stylePrompt = await getDramaStylePrompt(char.dramaId, 'asset_image')
  const finalPrompt = await ensureCharacterFinalPrompt(char, ep.id, false, { model: body.text_model, configId: body.text_config_id ?? undefined })
  const prompt = finalPrompt || characterImagePrompt(char, stylePrompt)
  try {
    logTaskStart('CharacterImage', 'generate', { characterId: id, episodeId: ep.id, dramaId: char.dramaId })
    const genId = await generateImage({ characterId: id, dramaId: char.dramaId, prompt, model: body.model, size: CHARACTER_IMAGE_SIZE, configId: body.config_id ?? ep.imageConfigId ?? undefined })
    logTaskSuccess('CharacterImage', 'generate', { characterId: id, generationId: genId })
    return success(c, { image_generation_id: genId })
  } catch (err: any) {
    logTaskError('CharacterImage', 'generate', { characterId: id, error: err.message })
    return badRequest(c, err.message)
  }
})

// POST /characters/:id/generate-prompt — 独立生成/重新生成三视图最终提示词（不生图）
app.post('/:id/generate-prompt', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [char] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  if (!char) return badRequest(c, '角色不存在')
  if (!body.episode_id) return badRequest(c, 'episode_id 必填')

  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id)))
  if (!ep) return badRequest(c, '剧集不存在')

  logTaskStart('FinalPrompt', 'character-generate', { characterId: id, episodeId: ep.id, force: !!body.force })
  const finalPrompt = await ensureCharacterFinalPrompt(char, ep.id, !!body.force, { model: body.text_model, configId: body.text_config_id ?? undefined })
  if (!finalPrompt) {
    logTaskError('FinalPrompt', 'character-generate', { characterId: id, error: 'agent returned empty prompt' })
    return badRequest(c, '最终提示词生成失败，请重试')
  }
  logTaskSuccess('FinalPrompt', 'character-generate', { characterId: id })
  return success(c, { final_prompt: finalPrompt })
})

// POST /episodes-scoped voice cards: fill missing voice cards for this episode's characters.
// POST /characters/voice-cards/fill  { episode_id, text_model?, text_config_id? }
app.post('/voice-cards/fill', async (c) => {
  const body = await c.req.json()
  if (!body.episode_id) return badRequest(c, 'episode_id 必填')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id)))
  if (!ep || ep.deletedAt) return badRequest(c, '剧集不存在')
  try {
    const written = await fillMissingVoiceCards(ep.id, ep.dramaId, { model: body.text_model, configId: body.text_config_id ?? undefined })
    return success(c, { written })
  } catch (error: any) {
    logTaskError('Extract', 'voice-cards', { episodeId: ep.id, error: error?.message })
    return badRequest(c, error?.message || '声线卡生成失败')
  }
})

// POST /characters/batch-generate-images
app.post('/batch-generate-images', async (c) => {
  const body = await c.req.json()
  const ids: number[] = body.character_ids || []
  if (!body.episode_id) return badRequest(c, 'episode_id 必填')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id)))
  if (!ep) return badRequest(c, '剧集不存在')
  const results: number[] = []
  const stylePrompt = await getDramaStylePrompt(ep.dramaId, 'asset_image')
  for (const cid of ids) {
    const [char] = await db.select().from(schema.characters).where(eq(schema.characters.id, cid))
    if (!char) continue
    const finalPrompt = await ensureCharacterFinalPrompt(char, ep.id, false, { model: body.text_model, configId: body.text_config_id ?? undefined })
    const prompt = finalPrompt || characterImagePrompt(char, stylePrompt)
    try {
      const genId = await generateImage({ characterId: cid, dramaId: char.dramaId, prompt, model: body.model, size: CHARACTER_IMAGE_SIZE, configId: body.config_id ?? ep.imageConfigId ?? undefined })
      results.push(genId)
    } catch {}
  }
  logTaskSuccess('CharacterImage', 'batch-generate', { episodeId: ep.id, requested: ids.length, started: results.length })
  return success(c, { count: results.length, ids: results })
})

export default app
