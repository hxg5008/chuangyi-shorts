import { z } from 'zod'
import type { VoiceProfile, VoiceProfiles } from './storyboard-voice-cues.js'

/**
 * Per-character voice card (声线卡), user decisions of 2026-11-06:
 * - fixed: the base voice (age feel / register / core timbre), 15–30 characters
 *   combined, the same text the storyboard voice contract already uses. It is
 *   used verbatim in every episode, so a character sounds the same everywhere.
 * - guidance: speaking habits and how emotion changes delivery (free length);
 *   given to the model as direction for each line, never pasted as fixed text.
 * - linked_character_id: an aged/young version of the same person shares the
 *   core timbre with the linked character; age feel and register follow its
 *   own age.
 * The card never enters the video prompt header and no VoiceID is invented.
 */
export interface VoiceCard {
  fixed: VoiceProfile
  guidance: string
  linked_character_id: number | null
  /** 'manual' once the user edited the card; automatic alignment never changes a manual card. */
  origin: 'auto' | 'manual'
}

const plain = (max: number) => z.string().trim().min(1).max(max)
  .refine(value => !/[\r\n「」『』“”"【】]/u.test(value) && !/\[\[|\]\]|[@#]/u.test(value), 'Plain voice wording only')
export const voiceCardSchema = z.object({
  fixed: z.object({ age: plain(30), register: plain(30), timbre: plain(30) }).strict()
    .refine(profile => { const length = [...`${profile.age}、${profile.register}、${profile.timbre}`].length; return length >= 15 && length <= 30 },
      'Combined age, register and timbre must be 15–30 characters (the skill’s fixed voice description)'),
  guidance: z.string().trim().max(400).refine(value => !/[「」『』“”"]/u.test(value) && !/\[\[|\]\]|[@#]/u.test(value), 'Plain direction only').default(''),
  linked_character_id: z.number().int().positive().nullable().default(null),
  origin: z.enum(['auto', 'manual']).default('auto'),
}).strict()

export const fixedVoiceText = (profile: VoiceProfile) => `${profile.age}、${profile.register}、${profile.timbre}`

/** "老年高大山" → "高大山": the base (younger) person of an age variant, or null. */
const AGE_PREFIX = /^(?:老年|晚年|暮年|中年|青年|少年|幼年|童年|年轻时(?:的)?|年轻的?|小时候(?:的)?)/u
export function baseNameOf(name: string) {
  const stripped = name.replace(AGE_PREFIX, '').trim()
  return stripped && stripped !== name ? stripped : null
}

/** The same person at another age shares the core timbre; age feel and register stay its own. Keeps the 15–30 rule. */
export function withSharedTimbre(card: VoiceCard, source: VoiceCard): VoiceCard {
  if (card.fixed.timbre === source.fixed.timbre) return card
  const next = { ...card, fixed: { ...card.fixed, timbre: source.fixed.timbre } }
  const length = [...fixedVoiceText(next.fixed)].length
  return length >= 15 && length <= 30 ? next : card
}

/** Parse a stored card (JSON text from the database, or the object the storyboard context carries); anything malformed is "no card". */
export function parseVoiceCard(stored: unknown): VoiceCard | null {
  if (stored === null || stored === undefined || stored === '') return null
  try {
    const value = typeof stored === 'string' ? JSON.parse(stored) : stored
    const checked = voiceCardSchema.safeParse(value)
    return checked.success ? checked.data as VoiceCard : null
  } catch { return null }
}

export function serializeVoiceCard(card: unknown): { value: string | null; error?: string } {
  if (card === null || card === undefined || card === '') return { value: null }
  const checked = voiceCardSchema.safeParse(typeof card === 'string' ? (() => { try { return JSON.parse(card) } catch { return card } })() : card)
  if (!checked.success) return { value: null, error: checked.error.issues.map(issue => `${issue.path.join('.') || 'voice_card'}: ${issue.message}`).join('; ') }
  return { value: JSON.stringify(checked.data) }
}

/**
 * Fixed voices of the episode's characters, keyed like the storyboard voice
 * registry ("character:ID"). Seeded before any group is generated, so every
 * episode starts from the same fixed voices.
 */
export function voiceCardProfiles(characters: ReadonlyArray<{ id: number; voice_card?: unknown; voiceCard?: unknown }>): VoiceProfiles {
  const profiles: VoiceProfiles = {}
  for (const character of characters) {
    const card = parseVoiceCard(character.voice_card ?? character.voiceCard)
    if (card) profiles[`character:${character.id}`] = { ...card.fixed }
  }
  return profiles
}

/** Voice cards shown to the model with the episode's characters (fixed text + guidance). */
export function voiceCardFacts(characters: ReadonlyArray<{ id: number; name: string; voice_card?: unknown; voiceCard?: unknown }>) {
  return characters.flatMap(character => {
    const card = parseVoiceCard(character.voice_card ?? character.voiceCard)
    if (!card) return []
    const linked = card.linked_character_id ? characters.find(other => other.id === card.linked_character_id) : undefined
    return [{ character_id: character.id, name: character.name, fixed_voice: fixedVoiceText(card.fixed), delivery_guidance: card.guidance,
      ...(linked ? { same_person_as: linked.name } : {}) }]
  })
}

/** Added to the generation request when voice cards exist (not part of the draft fingerprint). */
export const VOICE_CARD_NOTE = '声线卡：voice_profiles已预置本集角色声线卡中的固定声线（年龄感、音域、核心音色），所有组、所有集原样使用，voice_cues.profile逐字照抄，不改写措辞。voice_cards中的delivery_guidance是该角色的说话习惯和情绪变化方式，用来决定每句台词的state、goal、volume、rate_cps、breath、tail、emotion；同一个人可以有不同情绪，但固定声线不变。same_person_as表示同一人的不同年龄版本，核心音色保持一致。'

/** Voice-card generation instructions for the character extraction step. */
export const VOICE_CARD_EXTRACTION_NOTE = '声线卡（voice_card）：为每个有台词或画外声音的角色写一张声线卡，没有台词的角色可以不写。fixed是固定声线，三项合计15—30字：age听感年龄（如“三十岁上下北方汉子”）、register音域（如“中低音区”）、timbre核心音色（如“粗粝沉实”）；只写声音本身，不写外貌、情绪或台词。guidance写说话习惯和情绪变化方式，例如语速、停顿、紧张或冲突时声音怎么变（如“平时语速稳、音量不高；冲突时不喊叫，只放慢语速、加重咬字”），不超过120字。同一人的老年/幼年版本（如“老年高大山”与“高大山”）分别写卡，核心音色保持一致，linked_character_name填另一版本的名字。项目里已有声线卡的角色保持原卡不变，不重写。'

/**
 * Round 3 (2026-11-08, user-approved item 10): clothing colours. Without a rule the model wrote "深色/朴素/…或…" and
 * later characters drifted to the same blue-grey; images follow the prompt exactly. Appended by the program to the
 * character extraction message; SKILL.md and the prompt files are unchanged.
 */
export const STYLING_COLOR_EXTRACTION_NOTE = '妆造颜色：styling里写出主要衣物的具体颜色（如“枣红色斜襟棉袄、藏青长裤”），不要只写“深色”“浅色”“颜色朴素”，也不要用“…或…”给出两种选择；剧本写明的服装和颜色照写。新角色先看read_existing_characters里已有角色的妆造，主要角色之间的主色要能一眼区分，避免大家都是同一种蓝灰；同一单位的制服、干部装等按身份本来就相同的可以相同。项目里已有的角色保持原有妆造，不改写。只被提及、本集没有出镜的人物，styling可以留空，不要把剧情简介写进styling。'
