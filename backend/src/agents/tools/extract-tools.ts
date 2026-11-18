/**
 * 角色/场景提取 Agent 工具
 * 模块级单例 — episodeId + dramaId 通过 RequestContext 按请求注入
 *
 * 单 Agent 一步流程：
 * 1. 读取剧本内容
 * 2. 读取项目中已存在的角色/场景（用于去重）
 * 3. 提取角色/场景并智能去重后直接保存
 */
import { createTool } from '@mastra/core/tools'
import type { ToolExecutionContext } from '@mastra/core/tools'
import { z } from 'zod'
import { db, getInsertId, schema } from '../../db/index.js'
import { eq, and } from 'drizzle-orm'
import { now } from '../../utils/response.js'
import { logTaskProgress, logTaskSuccess } from '../../utils/task-logger.js'
import { getDramaId, getEpisodeId } from '../context.js'
import { parseVoiceCard, serializeVoiceCard } from '../../services/character-voice-card.js'

// ─── 关联辅助 ────────────────────────────────────────────────
async function linkCharToEpisode(episodeId: number, characterId: number) {
  const ts = now()
  const existing = await db.select().from(schema.episodeCharacters)
    .where(and(eq(schema.episodeCharacters.episodeId, episodeId), eq(schema.episodeCharacters.characterId, characterId)))

  if (!existing.length) {
    await db.insert(schema.episodeCharacters).values({ episodeId, characterId, createdAt: ts })
  }
}

async function linkSceneToEpisode(episodeId: number, sceneId: number) {
  const ts = now()
  const existing = await db.select().from(schema.episodeScenes)
    .where(and(eq(schema.episodeScenes.episodeId, episodeId), eq(schema.episodeScenes.sceneId, sceneId)))

  if (!existing.length) {
    await db.insert(schema.episodeScenes).values({ episodeId, sceneId, createdAt: ts })
  }
}

async function linkPropToEpisode(episodeId: number, propId: number) {
  const ts = now()
  const existing = await db.select().from(schema.episodeProps)
    .where(and(eq(schema.episodeProps.episodeId, episodeId), eq(schema.episodeProps.propId, propId)))

  if (!existing.length) {
    await db.insert(schema.episodeProps).values({ episodeId, propId, createdAt: ts })
  }
}

// ─── 名字归一化（近名去重） ───────────────────────────────────
// 提取时同一角色/道具可能出现不同书写形式（如「林小雨」与「林小雨（主角）」、
// 「林小雨(女主)」、「林小雨 」）。归一化后做精确比较，命中即复用已有，不重复创建。
function normalizeName(name: string): string {
  return (name || '')
    .replace(/[（(][^（()）]*[）)]/g, '') // 去掉成对的中/英文括号内容（角色定位/别名）
    .replace(/[（(].*$/, '')              // 兜底：未闭合括号从首个括号截断
    .replace(/[\s　]+/g, '')          // 去空白与全角空格
    .toLowerCase()
    .trim()
}

// 场景地点只做空白归一化（不删括号：如「火车站（候车厅）」与「火车站（站台）」是不同场景）
function normalizeLocation(loc: string): string {
  return (loc || '').replace(/[\s　]+/g, '').toLowerCase().trim()
}

type ToolContext = ToolExecutionContext | undefined

function requireIds(context: ToolContext): { episodeId: number; dramaId: number } | { error: string } {
  const episodeId = getEpisodeId(context?.requestContext)
  const dramaId = getDramaId(context?.requestContext)
  if (!episodeId || !dramaId) return { error: 'Missing episodeId/dramaId in request context' }
  return { episodeId, dramaId }
}

// 1. 读取剧本内容
const readScriptForExtraction = createTool({
  id: 'read_script_for_extraction',
  description: 'Read the formatted screenplay for character/scene extraction.',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const [ep] = await db.select().from(schema.episodes)
      .where(eq(schema.episodes.id, episodeId))
    if (!ep) return { error: 'Episode not found' }
    const content = ep.scriptContent || ep.content
    if (!content) return { error: 'Episode has no script content' }
    logTaskSuccess('ExtractTool', 'read-script', { episodeId, dramaId, scriptLength: content.length })
    return { script: content }
  },
})

// 2. 读取项目中已存在的角色（用于去重判断）
const readExistingCharacters = createTool({
  id: 'read_existing_characters',
  description: 'Read all characters already existing in this drama project (for deduplication).',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const links = await db.select().from(schema.episodeCharacters)
      .where(eq(schema.episodeCharacters.episodeId, episodeId))
    const linkedIds = new Set(links.map(link => link.characterId))
    const chars = (await db.select().from(schema.characters)
      .where(eq(schema.characters.dramaId, dramaId)))
      .filter(c => !c.deletedAt)
    const visibleChars = chars.map(c => ({
      id: c.id,
      name: c.name,
      role: c.role || '',
      appearance: c.appearance || '',
      styling: c.styling || '',
      has_voice_card: Boolean(parseVoiceCard(c.voiceCard)),
      normalized_name: normalizeName(c.name), // 用于判断近名复用：括号定位/别名视为同名
    }))
    const payload = {
      count: visibleChars.length,
      characters: visibleChars,
      current_episode_characters: visibleChars.filter(c => linkedIds.has(c.id)),
    }
    logTaskSuccess('ExtractTool', 'read-characters', {
      episodeId,
      dramaId,
      projectCharacters: payload.count,
      episodeCharacters: payload.current_episode_characters.length,
    })
    return payload
  },
})

// 3. 读取项目中已存在的场景（用于去重判断）
const readExistingScenes = createTool({
  id: 'read_existing_scenes',
  description: 'Read all scenes already existing in this drama project (for deduplication).',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const links = await db.select().from(schema.episodeScenes)
      .where(eq(schema.episodeScenes.episodeId, episodeId))
    const linkedIds = new Set(links.map(link => link.sceneId))
    const scenes = (await db.select().from(schema.scenes)
      .where(eq(schema.scenes.dramaId, dramaId)))
      .filter(s => !s.deletedAt)
    const visibleScenes = scenes.map(s => ({
      id: s.id,
      location: s.location,
      time: s.time || '',
      prompt: s.prompt || '',
      lighting: s.lighting || '',
      normalized_location: normalizeLocation(s.location), // 用于判断近名复用（仅空白/大小写）
    }))
    const payload = {
      count: visibleScenes.length,
      scenes: visibleScenes,
      current_episode_scenes: visibleScenes.filter(s => linkedIds.has(s.id)),
    }
    logTaskSuccess('ExtractTool', 'read-scenes', {
      episodeId,
      dramaId,
      projectScenes: payload.count,
      episodeScenes: payload.current_episode_scenes.length,
    })
    return payload
  },
})

// 4. 智能保存角色（按名字去重，与现有数据合并）
// Round 3 (2026-11-08, user-approved "8a"): a character already in the project keeps its appearance, styling,
// role and description; a later episode's extraction only fills fields that are still empty. Before this, every
// extraction rewrote shared characters (one character was saved 9 times with 7 different looks), which changed
// the storyboard draft fingerprint and the image prompt. A deliberate change is made in the asset panel.
// Styling is never filled from the plot description any more (A7): a character only mentioned in passing keeps an
// empty styling instead of a plot summary that image generation would draw.
const keepOrFill = (current: string | null | undefined, extracted: string | undefined) => current && current.trim() ? current : (extracted || current || '')
const saveDedupCharacters = createTool({
  id: 'save_dedup_characters',
  description: 'Save extracted characters with deduplication. A character that already exists (same name) keeps its saved appearance, styling, role and description; only empty fields are filled. New characters are created. All are linked to the current episode. voice_card is kept once set (a later extraction never overwrites an existing card).',
  inputSchema: z.object({
    characters: z.array(z.object({
      name: z.string(),
      role: z.string().optional(),
      description: z.string().optional(),
      appearance: z.string().optional(),
      styling: z.string().optional(),
      voice_card: z.object({
        fixed: z.object({ age: z.string(), register: z.string(), timbre: z.string() }),
        guidance: z.string().optional(),
        linked_character_name: z.string().optional(),
      }).optional(),
    })),
  }),
  execute: async ({ characters }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const ts = now()
    const results = { created: 0, merged: 0, voice_cards: 0, voice_card_rejected: [] as string[] }
    logTaskProgress('ExtractTool', 'save-characters-begin', {
      episodeId,
      dramaId,
      names: characters.map(char => char.name).join(','),
    })
    const savedIds = new Map<string, number>()

    for (const char of characters) {
      const charsInProject = (await db.select().from(schema.characters)
        .where(eq(schema.characters.dramaId, dramaId)))
        .filter(c => !c.deletedAt)
      const exact = charsInProject.find(c => c.name === char.name)
      const normName = normalizeName(char.name)
      const existing = exact || (normName ? charsInProject.find(c => c.name && normalizeName(c.name) === normName) : undefined)
      const matchedViaNorm = !!existing && existing !== exact

      if (existing) {
        // 归一化命中：括号定位/别名等近名视作同一角色复用，避免重复创建
        if (matchedViaNorm) logTaskProgress('ExtractTool', 'save-characters-reuse', { episodeId, dramaId, extracted: char.name, reused: existing.name })
        // 已存在：保留已有的形象与资料，只补空白字段，保留 ID
        const next = {
          role: keepOrFill(existing.role, char.role),
          description: keepOrFill(existing.description, char.description),
          appearance: keepOrFill(existing.appearance, char.appearance),
          styling: keepOrFill(existing.styling, char.styling),
        }
        const changed = (Object.keys(next) as Array<keyof typeof next>).some(key => (existing[key] || '') !== next[key])
        if (changed) {
          // Filling an empty look makes any earlier image prompt stale; an unchanged look keeps it.
          const lookFilled = (existing.appearance || '') !== next.appearance || (existing.styling || '') !== next.styling
          await db.update(schema.characters).set({ ...next, ...(lookFilled ? { finalPrompt: null } : {}), updatedAt: ts }).where(eq(schema.characters.id, existing.id))
        }
        await linkCharToEpisode(episodeId, existing.id)
        savedIds.set(char.name, existing.id)
        results.merged++
      } else {
        // 新增角色（妆造不再用人物简介代替）
        const res = await db.insert(schema.characters).values({
          name: char.name,
          role: char.role || '',
          description: char.description || '',
          appearance: char.appearance || '',
          styling: char.styling || '',
          dramaId,
          createdAt: ts,
          updatedAt: ts,
        })
        const charId = getInsertId(res)
        await linkCharToEpisode(episodeId, charId)
        savedIds.set(char.name, charId)
        results.created++
      }
    }

    // 声线卡：只写给还没有卡的角色；已有卡（含用户手改）保持不变，保证跨集声音一致。
    const project = (await db.select().from(schema.characters).where(eq(schema.characters.dramaId, dramaId))).filter(c => !c.deletedAt)
    for (const char of characters) {
      if (!char.voice_card) continue
      const id = savedIds.get(char.name)
      const row = project.find(c => c.id === id)
      if (!row || parseVoiceCard(row.voiceCard)) continue
      const linkedName = char.voice_card.linked_character_name?.trim()
      const linked = linkedName ? project.find(c => c.name === linkedName || normalizeName(c.name) === normalizeName(linkedName)) : undefined
      const serialized = serializeVoiceCard({ fixed: char.voice_card.fixed, guidance: char.voice_card.guidance || '', linked_character_id: linked && linked.id !== row.id ? linked.id : null })
      if (!serialized.value) { results.voice_card_rejected.push(`${char.name}: ${serialized.error}`); continue }
      await db.update(schema.characters).set({ voiceCard: serialized.value, updatedAt: ts }).where(eq(schema.characters.id, row.id))
      results.voice_cards++
    }

    const payload = {
      message: `角色保存完成：新增 ${results.created}，合并更新 ${results.merged}，新写声线卡 ${results.voice_cards}${results.voice_card_rejected.length ? `；以下声线卡格式不符未保存，请按要求重写后再保存：${results.voice_card_rejected.join('；')}` : ''}`,
      ...results,
    }
    logTaskSuccess('ExtractTool', 'save-characters-complete', { episodeId, created: results.created, merged: results.merged, voiceCards: results.voice_cards, voiceCardRejected: results.voice_card_rejected.length })
    return payload
  },
})

// 5. 智能保存场景（按地点+时间段去重，与现有数据合并）
const saveDedupScenes = createTool({
  id: 'save_dedup_scenes',
  description: 'Save extracted scenes with deduplication. Existing scenes (same location+time) are reused and keep their saved description and lighting (only empty fields are filled); new ones are created. All are linked to the current episode.',
  inputSchema: z.object({
    scenes: z.array(z.object({
      location: z.string(),
      time: z.string().optional(),
      prompt: z.string().optional(),
      description: z.string().optional(),
      lighting: z.string().optional(),
    })),
  }),
  execute: async ({ scenes }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const ts = now()
    const results = { created: 0, reused: 0 }
    logTaskProgress('ExtractTool', 'save-scenes-begin', {
      episodeId,
      dramaId,
      scenes: scenes.map(scene => `${scene.location}@${scene.time || ''}`).join(','),
    })

    for (const scene of scenes) {
      // 按地点+时间段精确匹配；地点仅做空白/大小写归一化（不删括号，避免误合并）
      const scenesInProject = (await db.select().from(schema.scenes)
        .where(eq(schema.scenes.dramaId, dramaId)))
        .filter(s => !s.deletedAt)
      const normLocation = normalizeLocation(scene.location)
      const existing = scenesInProject.find(s => s.location === scene.location && s.time === (scene.time || ''))
        || (normLocation ? scenesInProject.find(s => normalizeLocation(s.location) === normLocation && s.time === (scene.time || '')) : undefined)

      if (existing) {
        // 已存在完全匹配的场景：关联，并只补齐空白的描述/光影（已有内容保持不变，round 3 "8a"）
        const next = { prompt: keepOrFill(existing.prompt, scene.prompt || scene.description), lighting: keepOrFill(existing.lighting, scene.lighting) }
        if ((existing.prompt || '') !== next.prompt || (existing.lighting || '') !== next.lighting) {
          await db.update(schema.scenes).set({ ...next, finalPrompt: null, updatedAt: ts }).where(eq(schema.scenes.id, existing.id))
        }
        await linkSceneToEpisode(episodeId, existing.id)
        results.reused++
      } else {
        const res = await db.insert(schema.scenes).values({
          dramaId,
          location: scene.location,
          time: scene.time || '',
          prompt: scene.prompt || scene.description || scene.location,
          lighting: scene.lighting || '',
          createdAt: ts,
          updatedAt: ts,
        })
        const sceneId = getInsertId(res)
        await linkSceneToEpisode(episodeId, sceneId)
        results.created++
      }
    }

    const payload = {
      message: `场景保存完成：新增 ${results.created}，复用已有 ${results.reused}`,
      ...results,
    }
    logTaskSuccess('ExtractTool', 'save-scenes-complete', { episodeId, ...results })
    return payload
  },
})

// 6. 读取项目中已存在的道具（用于去重判断）
const readExistingProps = createTool({
  id: 'read_existing_props',
  description: 'Read all props already existing in this drama project (for deduplication).',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const links = await db.select().from(schema.episodeProps)
      .where(eq(schema.episodeProps.episodeId, episodeId))
    const linkedIds = new Set(links.map(link => link.propId))
    const props = (await db.select().from(schema.props)
      .where(eq(schema.props.dramaId, dramaId)))
      .filter(p => !p.deletedAt)
    const visibleProps = props.map(p => ({
      id: p.id,
      name: p.name,
      type: p.type || '',
      description: p.description || '',
      normalized_name: normalizeName(p.name), // 用于判断近名复用：括号定位/别名视为同名
    }))
    const payload = {
      count: visibleProps.length,
      props: visibleProps,
      current_episode_props: visibleProps.filter(p => linkedIds.has(p.id)),
    }
    logTaskSuccess('ExtractTool', 'read-props', {
      episodeId,
      dramaId,
      projectProps: payload.count,
      episodeProps: payload.current_episode_props.length,
    })
    return payload
  },
})

// 7. 智能保存道具（按名字去重，与现有数据合并）
const saveDedupProps = createTool({
  id: 'save_dedup_props',
  description: 'Save extracted props with deduplication. Existing props (same name) keep their saved type and appearance description (only empty fields are filled); new ones are created. All are linked to the current episode.',
  inputSchema: z.object({
    props: z.array(z.object({
      name: z.string(),
      type: z.string().optional(),
      description: z.string().optional(),
    })),
  }),
  execute: async ({ props }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const ts = now()
    const results = { created: 0, merged: 0 }
    logTaskProgress('ExtractTool', 'save-props-begin', {
      episodeId,
      dramaId,
      names: props.map(prop => prop.name).join(','),
    })

    for (const prop of props) {
      const propsInProject = (await db.select().from(schema.props)
        .where(eq(schema.props.dramaId, dramaId)))
        .filter(p => !p.deletedAt)
      const exact = propsInProject.find(p => p.name === prop.name)
      const normName = normalizeName(prop.name)
      const existing = exact || (normName ? propsInProject.find(p => p.name && normalizeName(p.name) === normName) : undefined)
      const matchedViaNorm = !!existing && existing !== exact

      if (existing) {
        // 归一化命中：括号定位/别名等近名视作同一道具复用
        if (matchedViaNorm) logTaskProgress('ExtractTool', 'save-props-reuse', { episodeId, dramaId, extracted: prop.name, reused: existing.name })
        // 已存在：保留已有类型与外貌，只补空白字段，保留 ID；外貌真的变化（由空补上）时旧的最终提示词失效
        const next = { type: keepOrFill(existing.type, prop.type), description: keepOrFill(existing.description, prop.description) }
        const descriptionChanged = (existing.description || '') !== next.description
        if (descriptionChanged || (existing.type || '') !== next.type) {
          await db.update(schema.props).set({ ...next, ...(descriptionChanged ? { finalPrompt: null } : {}), updatedAt: ts }).where(eq(schema.props.id, existing.id))
        }
        await linkPropToEpisode(episodeId, existing.id)
        results.merged++
      } else {
        const res = await db.insert(schema.props).values({
          name: prop.name,
          type: prop.type || '',
          description: prop.description || '',
          dramaId,
          createdAt: ts,
          updatedAt: ts,
        })
        const propId = getInsertId(res)
        await linkPropToEpisode(episodeId, propId)
        results.created++
      }
    }

    const payload = {
      message: `道具保存完成：新增 ${results.created}，合并更新 ${results.merged}`,
      ...results,
    }
    logTaskSuccess('ExtractTool', 'save-props-complete', { episodeId, ...results })
    return payload
  },
})

// 7. 只补写声线卡：不新建角色、不改名、不改外貌/妆造等任何其他字段；已有卡的角色不动。
const saveVoiceCards = createTool({
  id: 'save_voice_cards',
  description: 'Write voice cards for existing characters of the current episode that do not have one yet. Never creates characters and never changes any other character field.',
  inputSchema: z.object({
    cards: z.array(z.object({
      character_id: z.number().int().positive(),
      fixed: z.object({ age: z.string(), register: z.string(), timbre: z.string() }),
      guidance: z.string().optional(),
      linked_character_name: z.string().optional(),
    })),
  }),
  execute: async ({ cards }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const linked = new Set((await db.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, episodeId))).map(link => link.characterId))
    const project = (await db.select().from(schema.characters).where(eq(schema.characters.dramaId, dramaId))).filter(c => !c.deletedAt)
    const results = { voice_cards: 0, skipped: [] as string[], voice_card_rejected: [] as string[] }
    for (const entry of cards) {
      const row = project.find(c => c.id === entry.character_id)
      if (!row || !linked.has(row.id)) { results.skipped.push(`${entry.character_id}: 不是本集角色`); continue }
      if (parseVoiceCard(row.voiceCard)) { results.skipped.push(`${row.name}: 已有声线卡`); continue }
      const linkedName = entry.linked_character_name?.trim()
      const other = linkedName ? project.find(c => c.name === linkedName || normalizeName(c.name) === normalizeName(linkedName)) : undefined
      const serialized = serializeVoiceCard({ fixed: entry.fixed, guidance: entry.guidance || '', linked_character_id: other && other.id !== row.id ? other.id : null })
      if (!serialized.value) { results.voice_card_rejected.push(`${row.name}: ${serialized.error}`); continue }
      await db.update(schema.characters).set({ voiceCard: serialized.value, updatedAt: now() }).where(eq(schema.characters.id, row.id))
      results.voice_cards++
    }
    logTaskSuccess('ExtractTool', 'save-voice-cards', { episodeId, written: results.voice_cards, skipped: results.skipped.length, rejected: results.voice_card_rejected.length })
    return { message: `声线卡新写 ${results.voice_cards}${results.voice_card_rejected.length ? `；以下格式不符未保存，请按要求重写后再保存：${results.voice_card_rejected.join('；')}` : ''}`, ...results }
  },
})

export const extractTools = {
  readScriptForExtraction,
  readExistingCharacters,
  readExistingScenes,
  readExistingProps,
  saveDedupCharacters,
  saveDedupScenes,
  saveDedupProps,
  saveVoiceCards,
}
