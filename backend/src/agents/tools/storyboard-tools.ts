/**
 * 分镜拆解 Agent 工具
 * 模块级单例 — episodeId + dramaId 通过 RequestContext 按请求注入
 */
import { createTool } from '@mastra/core/tools'
import { videoPromptPlanInputSchema } from '../../services/source-dialogue-plan.js'
import type { ToolExecutionContext } from '@mastra/core/tools'
import { z } from 'zod'
import { db, schema } from '../../db/index.js'
import { eq } from 'drizzle-orm'
import { logTaskProgress, logTaskSuccess } from '../../utils/task-logger.js'
import { getDramaId, getEpisodeId } from '../context.js'
import { StoryboardSession } from '../../services/storyboard-session.js'
import { extractScriptDialogue } from '../../services/script-dialogue.js'
import { buildDialogueTimingGuide, buildDialogueGroupSchedule } from '../../services/first-pass-instructions.js'
import { parseVoiceCard } from '../../services/character-voice-card.js'

type ToolContext = ToolExecutionContext | undefined

function requireIds(context: ToolContext): { episodeId: number; dramaId: number } | { error: string } {
  const episodeId = getEpisodeId(context?.requestContext)
  const dramaId = getDramaId(context?.requestContext)
  if (!episodeId || !dramaId) return { error: 'Missing episodeId/dramaId in request context' }
  return { episodeId, dramaId }
}

function getSession(context: ToolContext): StoryboardSession | null {
  const session = context?.requestContext?.get('storyboardSession' as never)
  return session instanceof StoryboardSession ? session : null
}

function sessionRequired() {
  return { error: 'Storyboard Agent writes require a validation session; no data was changed', issues: [{
    field: 'session', code: 'session_required', severity: 'error', message: '当前请求未建立分镜校验会话，旧稿保持不变',
  }] }
}

const readStoryboardContext = createTool({
  id: 'read_storyboard_context',
  description: 'Read the screenplay, characters, scenes, and props for storyboard breakdown.',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const session = getSession(context)
    if (session && !session.assertScope(episodeId, dramaId)) return { error: 'Storyboard session scope mismatch', issues: session.getIssues() }
    const [ep] = await db.select().from(schema.episodes)
      .where(eq(schema.episodes.id, episodeId))
    if (!ep) return { error: 'Episode not found' }
    const script = ep.scriptContent || ep.content
    if (!script) return { error: 'Episode has no script' }

    const charLinks = await db.select().from(schema.episodeCharacters)
      .where(eq(schema.episodeCharacters.episodeId, episodeId))
    const sceneLinks = await db.select().from(schema.episodeScenes)
      .where(eq(schema.episodeScenes.episodeId, episodeId))
    const propLinks = await db.select().from(schema.episodeProps)
      .where(eq(schema.episodeProps.episodeId, episodeId))

    const linkedCharacterIds = new Set(charLinks.map(link => link.characterId))
    const linkedSceneIds = new Set(sceneLinks.map(link => link.sceneId))
    const linkedPropIds = new Set(propLinks.map(link => link.propId))

    const chars = await db.select().from(schema.characters)
      .where(eq(schema.characters.dramaId, dramaId))
    const scns = await db.select().from(schema.scenes)
      .where(eq(schema.scenes.dramaId, dramaId))
    const prps = await db.select().from(schema.props)
      .where(eq(schema.props.dramaId, dramaId))
    const existingStoryboards = await db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId))

    const characters = chars
      .filter(c => !c.deletedAt)
      .filter(c => !linkedCharacterIds.size || linkedCharacterIds.has(c.id))
      .map(c => {
        // 声线卡只在存在时加入：没有卡的项目上下文逐字不变，已有草稿仍可继续生成。
        const card = parseVoiceCard(c.voiceCard)
        return {
          id: c.id,
          name: c.name,
          role: c.role || '',
          description: c.description || '',
          appearance: c.appearance || '',
          styling: c.styling || '',
          image_url: c.imageUrl || '',
          reference_images: c.referenceImages || '',
          has_voice: Boolean(c.voiceAudioUrl?.trim()),
          voice_reference: c.voiceAudioUrl?.trim() ? `#${c.name}` : null,
          ...(card ? { voice_card: card } : {}),
        }
      })

    const scenes = scns
      .filter(s => !s.deletedAt)
      .filter(s => !linkedSceneIds.size || linkedSceneIds.has(s.id))
      .map(s => ({
        id: s.id,
        location: s.location,
        time: s.time,
        prompt: s.prompt || '',
        lighting: s.lighting || '',
        reference_image_prompt: s.finalPrompt || '',
        image_url: s.imageUrl || '',
        storyboard_count: s.storyboardCount || 0,
      }))

    const props = prps
      .filter(p => !p.deletedAt)
      .filter(p => !linkedPropIds.size || linkedPropIds.has(p.id))
      .map(p => ({
        id: p.id,
        name: p.name,
        type: p.type || '',
        description: p.description || '',
        image_url: p.imageUrl || '',
      }))

    const existingStoryboardPayload = await Promise.all(existingStoryboards
      .filter(sb => !sb.deletedAt)
      .map(async (sb) => {
        const links = await db.select().from(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, sb.id))
        const sbPropLinks = await db.select().from(schema.storyboardProps)
          .where(eq(schema.storyboardProps.storyboardId, sb.id))
        return {
          id: sb.id,
          shot_number: sb.storyboardNumber,
          title: sb.title || '',
          scene_id: sb.sceneId,
          character_ids: links.map(link => link.characterId),
          available_voice_references: characters
            .filter(c => c.has_voice && links.some(link => link.characterId === c.id))
            .map(c => ({ character_id: c.id, name: c.name, voice_reference: c.voice_reference })),
          prop_ids: sbPropLinks.map(link => link.propId),
          shot_type: sb.shotType || '',
          duration: sb.duration || 0,
          description: sb.description || '',
          atmosphere: sb.atmosphere || '',
          video_prompt: sb.videoPrompt || '',
        }
      }))

    const dialogueGuide = session?.mode === 'breakdown' ? buildDialogueTimingGuide(extractScriptDialogue(script, characters.map(character => character.name)), characters) : undefined
    const payload = {
      episode: {
        id: ep.id,
        title: ep.title,
        episode_number: ep.episodeNumber,
        description: ep.description || '',
      },
      script,
      characters,
      scenes,
      props,
      existing_storyboards: existingStoryboardPayload,
      ...(dialogueGuide ? { dialogue_timing_guide: dialogueGuide, dialogue_group_schedule: buildDialogueGroupSchedule(dialogueGuide) } : {}),
    }
    logTaskSuccess('StoryboardTool', 'read-context', {
      episodeId,
      dramaId,
      characters: characters.length,
      scenes: scenes.length,
      props: props.length,
      existingStoryboards: payload.existing_storyboards.length,
      scriptLength: script.length,
    })
    return session ? session.overlayContext(payload) : payload
  },
})

const storyboardFields = z.object({
  shot_number: z.number(),
  title: z.string().optional(),
  shot_type: z.string().optional(),
  angle: z.string().optional(),
  movement: z.string().optional(),
  location: z.string().optional(),
  time: z.string().optional(),
  description: z.string().optional(),
  result: z.string().optional(),
  atmosphere: z.string().optional(),
  image_prompt: z.string().optional(),
  video_prompt: z.string().optional(),
  video_prompt_plan: videoPromptPlanInputSchema.optional().describe('Preferred intermediate plan. For breakdown, use source_line and fragment_index from dialogue_timing_guide instead of copying spoken words; description and video_prompt are derived from the same facts.'),
  bgm_prompt: z.string().optional(),
  sound_effect: z.string().optional(),
  duration: z.number().optional(),
  scene_id: z.number().nullable().optional(),
  character_ids: z.array(z.number()).optional(),
  prop_ids: z.array(z.number()).optional(),
})

const saveStoryboards = createTool({
  id: 'save_storyboards',
  description: 'Stage one or two complete storyboard groups per call; never more than two. Prefer video_prompt_plan: establish actual face-visible/hidden/offscreen participants per shot, then write visual rows and assign source_line/fragment_index with voice details from dialogue_timing_guide; do not copy text or description. Continue batches until the whole episode is covered. First replace_existing:true; last is_final_batch:true. Old drafts remain intact until the complete episode commits atomically.',
  inputSchema: z.object({
    replace_existing: z.boolean().optional(),
    is_final_batch: z.boolean().optional(),
    storyboards: z.array(storyboardFields).min(1).max(2),
  }),
  execute: async ({ storyboards, replace_existing, is_final_batch }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const session = getSession(context)
    if (!session) return sessionRequired()
    if (!session.assertScope(ids.episodeId, ids.dramaId)) return { error: 'Storyboard session scope mismatch', issues: session.getIssues() }
    logTaskProgress('StoryboardTool', 'stage-batch', { episodeId: ids.episodeId, count: storyboards.length, finalBatch: is_final_batch === true })
    const normalized = storyboards.map(({ video_prompt_plan, ...fields }) => ({ ...fields,
      ...(video_prompt_plan === undefined ? {} : { video_prompt_plan: videoPromptPlanInputSchema.parse(video_prompt_plan) }) }))
    return session.stageSave(normalized, { replaceExisting: replace_existing, isFinalBatch: is_final_batch })
  },
})

const updateStoryboard = createTool({
  id: 'update_storyboard',
  description: 'Stage a complete video-prompt plan (preferred) or legacy video_prompt. In prompt mode pass only the requested storyboard_id and video_prompt_plan; the server renders and saves only video_prompt. Plan each shot\'s actual participants before prose. In breakdown repair use the temporary candidate ID. No real draft is replaced before validation commits.',
  inputSchema: z.object({
    storyboard_id: z.number(),
    title: z.string().optional(),
    shot_type: z.string().optional(),
    angle: z.string().optional(),
    movement: z.string().optional(),
    location: z.string().optional(),
    time: z.string().optional(),
    result: z.string().optional(),
    atmosphere: z.string().optional(),
    image_prompt: z.string().optional(),
    video_prompt: z.string().optional(),
    video_prompt_plan: videoPromptPlanInputSchema.optional(),
    bgm_prompt: z.string().optional(),
    sound_effect: z.string().optional(),
    description: z.string().optional(),
    scene_id: z.number().nullable().optional(),
    character_ids: z.array(z.number()).optional(),
    prop_ids: z.array(z.number()).optional(),
    duration: z.number().optional(),
  }),
  execute: async ({ storyboard_id, ...fields }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const session = getSession(context)
    if (!session) return sessionRequired()
    if (!session.assertScope(ids.episodeId, ids.dramaId)) return { error: 'Storyboard session scope mismatch', issues: session.getIssues() }
    logTaskProgress('StoryboardTool', 'stage-update', { episodeId: ids.episodeId, storyboardId: storyboard_id, fields: Object.keys(fields) })
    const { video_prompt_plan, ...otherFields } = fields
    return session.stageUpdate(storyboard_id, { ...otherFields,
      ...(video_prompt_plan === undefined ? {} : { video_prompt_plan: videoPromptPlanInputSchema.parse(video_prompt_plan) }) })
  },
})

export const storyboardTools = { readStoryboardContext, saveStoryboards, updateStoryboard }
