import { z } from 'zod'
import type { ValidationIssue } from './storyboard-validation.js'
import { cameraCuts } from './camera-cuts.js'
import { isReferencedTargetOnly } from './reference-semantics.js'

const line = z.string().min(1).max(3600).refine(value => Boolean(value.trim()) && !/[\r\n]/.test(value), 'Must contain one non-empty natural-language line')
const optionalLine = line.nullable().transform(value => value ?? undefined).optional()
const optionalVoiceReference = z.union([line, z.literal('')]).nullable().transform(value => value == null || value === '' ? undefined : value).optional()
const voiceSchema = z.object({ age: line, register: line, timbre: line, delivery: optionalLine }).strict()

/** Internal tool input only. This structure is never sent to a video provider. */
export const videoPromptPlanSchema = z.object({
  space: line,
  shots: z.array(z.object({
    shot_number: z.number().int().min(1).max(4),
    characters: z.array(z.object({
      character_id: z.number().int().positive(),
      visibility: z.enum(['face_visible', 'face_hidden', 'offscreen', 'uncertain']),
      emotion: z.object({ expression: line, intensity: z.number().min(0).max(100) }).strict().nullable().transform(value => value ?? undefined).optional(),
    }).strict()),
    rows: z.array(z.object({
      visual: line,
      dialogue: z.array(z.object({
        speaker_id: z.number().int().positive().nullable().transform(value => value ?? undefined).optional(),
        kind: z.enum(['dialogue', 'offscreen', 'narration']),
        text: line,
        voice: voiceSchema,
        voice_reference: optionalVoiceReference.describe('Optional exact available #CharacterName token for this speaker. The server normally supplies it from speaker_id; null or an empty string means omitted.'),
        spoken_seconds: z.number().finite().positive().nullable().transform(value => value ?? undefined).optional(),
      }).strict()).max(12).nullable().transform(value => value ?? undefined).optional(),
    }).strict()).min(1).max(2),
  }).strict()).min(2).max(4),
}).strict()

export type VideoPromptPlan = z.infer<typeof videoPromptPlanSchema>
type Visibility = VideoPromptPlan['shots'][number]['characters'][number]['visibility']

export interface VideoPromptPlanContext {
  duration: number
  characters: Array<{ id: number; name: string; voiceReference?: string | null }>
  scenes: Array<{ id: number; location: string }>
  props: Array<{ id: number; name: string }>
  characterIds: number[]
  sceneId?: number | null
  propIds: number[]
  language?: string | null
  /** Server-resolved source dialogue only; row/dialogue indices are zero-based. */
  trustedSourceDialogueSlots?: ReadonlyArray<{ shotNumber: number; rowIndex: number; dialogueIndex: number }>
}

export interface VideoPromptPlanParticipant { shotNumber: number; characterId: number; visibility: Visibility }
export interface VideoPromptPlanResult { prompt: string; participants: VideoPromptPlanParticipant[]; issues: ValidationIssue[] }

const wording = {
  zh: {
    cast: '出场人物', scene: '场景', props: '道具', none: '无', unboundScene: '未绑定场景，沿用下述空间描述',
    globals: '无字幕、无背景音乐，保留对白和必要音效；同一现实空间每名人物唯一，不出现克隆人或复制人；不越轴，动作流畅，五官与眼神清晰。',
    cut: '切到', seconds: '秒', colon: '：', stop: '。',
    expression: (name: string, expression: string, intensity: number) => `@${name}呈现${expression}的神情（情绪${intensity}%）`,
    hidden: (name: string) => `@${name}在画面内，面部不可见`,
    uncertain: (name: string) => `@${name}的实际可见范围以本镜描述为准`,
    speech: (name: string) => `${name}说`, offscreen: (name: string) => name ? `${name}的画外音` : '画外音', narration: (name: string) => name ? `旁白（${name}）` : '旁白',
    trustedDialogue: (name: string) => `画外音（同场对白）：${name}说`,
    voice: (age: string, register: string, timbre: string) => `听感年龄${age}，音域${register}，音色${timbre}`,
    rate: (value: string) => `约每秒${value}字`,
  },
  en: {
    cast: 'Characters', scene: 'Scene', props: 'Props', none: 'none', unboundScene: 'unbound; use the spatial description below',
    globals: 'No subtitles, no background music; retain dialogue and necessary sound effects. Each person is unique in the same physical space, no clones or duplicate people; do not cross the axis, keep motion smooth and faces and eyes clear.',
    cut: 'Cut to', seconds: 's', colon: ': ', stop: '.',
    expression: (name: string, expression: string, intensity: number) => `@${name} shows ${expression} (emotion ${intensity}%)`,
    hidden: (name: string) => `@${name} is in frame, with the face not visible`,
    uncertain: (name: string) => `@${name} is in frame; face visibility follows this shot's description`,
    speech: (name: string) => `${name} says`, offscreen: (name: string) => name ? `${name} offscreen voice` : 'Offscreen voice', narration: (name: string) => name ? `Narration (${name})` : 'Narration',
    trustedDialogue: (name: string) => `Offscreen voice (same-scene dialogue): ${name} says`,
    voice: (age: string, register: string, timbre: string) => `age impression ${age}, vocal register ${register}, timbre ${timbre}`,
    rate: (value: string, unit = 'characters') => `about ${value} ${unit} per second`,
  },
  ja: {
    cast: '登場人物', scene: 'シーン', props: '小道具', none: 'なし', unboundScene: '未設定、以下の空間描写に従う',
    globals: '字幕なし、BGMなし、会話と必要な効果音を保つ。同じ現実空間の各人物は一人だけ、クローンなし、軸を越えない。動作を滑らかにし、顔と目を鮮明に保つ。',
    cut: 'カットを切り替え', seconds: '秒', colon: '：', stop: '。',
    expression: (name: string, expression: string, intensity: number) => `@${name}は${expression}の表情（感情${intensity}%）`,
    hidden: (name: string) => `@${name}は画面内にいるが顔は見えない`,
    uncertain: (name: string) => `@${name}は画面内におり、顔の見え方はこのカットの描写に従う`,
    speech: (name: string) => `${name}は言う`, offscreen: (name: string) => name ? `${name}の画外音` : '画外音', narration: (name: string) => name ? `ナレーション（${name}）` : 'ナレーション',
    trustedDialogue: (name: string) => `画外音（同一シーンの会話）：${name}は言う`,
    voice: (age: string, register: string, timbre: string) => `声の年齢感${age}、音域${register}、音色${timbre}`,
    rate: (value: string) => `毎秒${value}文字`,
  },
  ko: {
    cast: '등장인물', scene: '장면', props: '소품', none: '없음', unboundScene: '미지정, 아래 공간 묘사를 따른다',
    globals: '자막 없음, 배경음악 없음, 대사와 필요한 효과음을 유지한다. 같은 현실 공간에서 각 인물은 한 명이며 복제인간 금지, 축을 넘지 않는다. 동작을 부드럽게 하고 얼굴과 눈을 선명하게 유지한다.',
    cut: '컷 전환', seconds: '초', colon: ': ', stop: '.',
    expression: (name: string, expression: string, intensity: number) => `@${name}의 표정은 ${expression} (감정 ${intensity}%)`,
    hidden: (name: string) => `@${name}는 화면 안에 있지만 얼굴은 보이지 않는다`,
    uncertain: (name: string) => `@${name}는 화면 안에 있으며 얼굴의 가시성은 이 컷의 묘사를 따른다`,
    speech: (name: string) => `${name} 말한다`, offscreen: (name: string) => name ? `${name}의 화면 밖 목소리` : '화면 밖 목소리', narration: (name: string) => name ? `내레이션（${name}）` : '내레이션',
    trustedDialogue: (name: string) => `화면 밖 목소리（같은 장면의 대사）：${name} 말한다`,
    voice: (age: string, register: string, timbre: string) => `목소리 나이감 ${age}, 음역 ${register}, 음색 ${timbre}`,
    rate: (value: string) => `초당${value}글자`,
  },
} as const

const characterCount = (value: string) => [...value].filter(character => /[\p{L}\p{N}]/u.test(character)).length
const wordCount = (value: string) => value.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length || 0
// Template language never changes the language of the original spoken words.
const chineseSpeech = (value: string) => /\p{Script=Han}/u.test(value) && !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)
const numberText = (value: number) => String(Math.round(value * 100) / 100)
const finishSentence = (value: string, stop: string) => /[。.!！?？]$/.test(value.trim()) ? value.trim() : value.trim() + stop

function quoted(value: string): string {
  for (const [open, close] of [['「', '」'], ['“', '”'], ['"', '"']]) if (!value.includes(open) && !value.includes(close)) return `${open}${value}${close}`
  return `「${value}」`
}

function isDepictedCharacterReference(text: string, nameIndex: number, nameLength: number): boolean {
  const prefix = text.slice(0, nameIndex).split(/[，,。！？!?；;\n@]/).at(-1)!.slice(-60)
  const suffix = text.slice(nameIndex + nameLength).split(/[。！？!?；;\n@]/)[0].trimStart()
  const depiction = '(?:照片|相片|合照|全家福|画像|画作|油画|壁画|肖像|相框|画框)'
  if (new RegExp(`${depiction}(?:里|中|内|上)?(?:的|中人|里的人)?\\s*$`, 'u').test(prefix)
    || /(?:画中人|画中|回忆|记忆|想象|幻想|梦境|脑海)(?:里|中|内)?的?\s*$/u.test(prefix)
    || /\b(?:photo(?:graph)?|portrait|painting|picture)\s+(?:of\s+)?$/iu.test(prefix)) return true
  return new RegExp(`^(?:的)?(?:(?:背影|正脸|侧脸|全身|半身)的?)?${depiction}`, 'u').test(suffix)
    || new RegExp(`^在${depiction}(?:里|中|内|上)`, 'u').test(suffix)
}

function hasUnmarkedVisibleCharacter(text: string, nameIndex: number, name: string, knownNames: string[]): boolean {
  if (text[nameIndex - 1] === '@') return false
  // A shorter asset name inside a longer formal name is not an exact mention.
  if (knownNames.some(longer => longer.length > name.length && [...longer.matchAll(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gu'))]
    .some(match => text.slice(nameIndex - match.index!, nameIndex - match.index! + longer.length) === longer))) return false
  const prefix = text.slice(0, nameIndex)
  const previous = prefix.at(-1)
  if (previous && /[\p{L}\p{N}_]/u.test(previous)
    && !/(?:画面[中内里]|镜头(?:拍摄|拍到|对准|呈现|定格于|推向|聚焦|跟随)|看向|望向|望着|看着|注视|追视|盯着|凝视|瞥向|面向|面对|询问|问向|告诉|回答|回应|跟随|拍到|看到|见到|从|离开|移开|转回|停在|的|和|与|及|对|向)$/u.test(prefix)) return false
  if (isDepictedCharacterReference(text, nameIndex, name.length) || isReferencedTargetOnly(text, nameIndex, name.length, 0)) return false
  const suffix = text.slice(nameIndex + name.length).split(/[。！？!?；;\n@]/)[0].trimStart().replace(/^[（(]\s*/, '')
  if (/^(?:的|其)?(?:背影|(?:正面|侧面|背面)(?:中景|近景|特写)|(?:正脸|侧脸|面部|脸部|五官|眉眼|眼睛|双眼|眼眸).{0,16}(?:清晰|可见|可辨|入镜|特写))/u.test(suffix)) return true
  if (/^(?:的|其)?(?:(?:正在|缓缓|慢慢|轻轻|突然|仍然|继续|猛地|随后|正|仍)\s*)*(?:站在|站立|站着|坐在|坐着|蹲在|躺在|躺着|走向|走到|走进|抬手|抬起|抬头|抬眼|点头|转头|转身|起身|伸手|迈步|握住|拿起|攥紧|放下|眨眼|轻眨|微笑|皱眉|表情.{0,4}(?:变化|改变)|嘴角.{0,4}(?:上扬|收紧)|眉眼.{0,4}(?:变化|收紧))/u.test(suffix)) return true
  if (/^(?:(?:is|was|still|slowly)\s+)*(?:stands?|standing|sits?|sitting|raises?|raising|lifts?|lifting|turns?|turning|walks?|walking|nods?|nodding|blinks?|blinking|smiles?|smiling)\b/iu.test(suffix)) return true
  return /^(?:$|[，,:：\s])/u.test(suffix) && /(?:画面[中内里]|镜头(?:拍摄|拍到|对准|呈现|定格于|推向|聚焦|跟随))\s*$/u.test(prefix)
}

/** A deterministic renderer: it supplies format, never invents acting, coordinates, or voice identity. */
export function renderVideoPromptPlan(plan: VideoPromptPlan, context: VideoPromptPlanContext): VideoPromptPlanResult {
  const issues: ValidationIssue[] = []
  const participants: VideoPromptPlanParticipant[] = []
  const issue = (field: string, code: string, message: string, shotNumber?: number, severity: 'error' | 'warning' = 'error') => {
    issues.push({ field, code, message, severity, ...(shotNumber !== undefined ? { shotNumber } : {}) })
  }
  const parsed = videoPromptPlanSchema.safeParse(plan)
  if (!parsed.success) {
    for (const error of parsed.error.issues) issue(`video_prompt_plan.${error.path.join('.')}`, 'plan_schema', `结构化视频计划缺少有效必需项或含无效字段：${error.path.join('.')} (${error.message})`)
    return { prompt: '', participants, issues }
  }
  const value = parsed.data
  const language = context.language && context.language in wording ? context.language as keyof typeof wording : 'zh'
  const words = wording[language]
  const trustedSourceDialogueSlots = new Set(context.trustedSourceDialogueSlots?.map(slot => `${slot.shotNumber}:${slot.rowIndex}:${slot.dialogueIndex}`))
  if (context.language && !(context.language in wording)) issue('video_prompt_plan', 'plan_language_fallback', '该语言尚无渲染模板，当前使用中文格式标签；不翻译资产名或台词。', undefined, 'warning')
  if (!Number.isFinite(context.duration) || context.duration < 8 || context.duration > 15) issue('duration', 'plan_duration', '分镜总时长必须为8–15秒；渲染器不会擅自改动时长。')
  if (!/A\s*0/i.test(value.space) || !/X/i.test(value.space) || !/Y/i.test(value.space)) issue('video_prompt_plan.space', 'plan_space_origin', 'space必须提供真实的A0原点及X、Y轴方向，渲染器不会编造坐标。')
  const boundCharacters = context.characters.filter(character => context.characterIds.includes(character.id))
  const boundProps = context.props.filter(prop => context.propIds.includes(prop.id))
  const scene = context.scenes.find(scene => scene.id === context.sceneId)
  if (context.characterIds.some(id => !context.characters.some(character => character.id === id))) issue('character_ids', 'plan_character_binding', '绑定角色中存在无效ID。')
  if (context.propIds.some(id => !context.props.some(prop => prop.id === id))) issue('prop_ids', 'plan_prop_binding', '绑定道具中存在无效ID。')
  if (context.sceneId != null && !scene) issue('scene_id', 'plan_scene_binding', '绑定场景ID无效。')
  const knownNames = [...new Set([...context.characters.map(character => character.name), ...context.scenes.map(scene => scene.location), ...context.props.map(prop => prop.name)])].sort((a, b) => b.length - a.length)
  const boundNames = [...boundCharacters.map(character => character.name), ...boundProps.map(prop => prop.name), ...(scene ? [scene.location] : [])]
  const unambiguousCharacters = boundCharacters.filter(character => character.name.length > 0
    && new Set(context.characters.filter(candidate => candidate.name === character.name).map(candidate => candidate.id)).size === 1
    && !context.scenes.some(scene => scene.location === character.name) && !context.props.some(prop => prop.name === character.name))
  const checkReferences = (text: string, field: string, shotNumber?: number, visibleCharacterIds?: number[]) => {
    let count = 0
    const missingParticipants = new Set<number>()
    const reportMissingParticipant = (character: { id: number; name: string }) => {
      if (missingParticipants.has(character.id)) return
      missingParticipants.add(character.id)
      const charactersPath = `video_prompt_plan.shots.${(shotNumber ?? 1) - 1}.characters`
      issue(field, 'plan_visual_participant', `子镜头 ${shotNumber} 的实际入镜角色 @${character.name}（ID ${character.id}）未在 ${charactersPath} 声明为画内人物；该角色当前缺失或仅标为 offscreen。请依据本镜实际可见性补齐此角色声明；纯视线或对话目标不需要补入画面。`, shotNumber)
    }
    for (const match of text.matchAll(/@/g)) {
      const rest = text.slice(match.index! + 1)
      const exactName = knownNames.find(name => rest.startsWith(name))
      if (!exactName || !boundNames.includes(exactName)) issue(field, 'plan_reference', '只能引用当前分镜已绑定资产的正式@名称，不使用编号、别名或未绑定素材。', shotNumber)
      else {
        const character = boundCharacters.find(character => character.name === exactName)
        const undeclared = character && visibleCharacterIds && !visibleCharacterIds.includes(character.id)
        const targetOnly = undeclared && field.endsWith('.visual') && isReferencedTargetOnly(text, match.index!, exactName.length)
        if (undeclared && !targetOnly) reportMissingParticipant(character)
        if (!targetOnly) count++
      }
    }
    if (field.endsWith('.visual') && visibleCharacterIds) for (const character of unambiguousCharacters) {
      if (visibleCharacterIds.includes(character.id)) continue
      let index = text.indexOf(character.name)
      while (index !== -1) {
        if (hasUnmarkedVisibleCharacter(text, index, character.name, knownNames)) {
          reportMissingParticipant(character)
          break
        }
        index = text.indexOf(character.name, index + character.name.length)
      }
    }
    return count
  }
  checkReferences(value.space, 'video_prompt_plan.space')
  const rowCount = value.shots.reduce((sum, shot) => sum + shot.rows.length, 0)
  if (rowCount !== Math.ceil(context.duration / 3)) issue('video_prompt_plan.shots', 'plan_time_rows', `该时长需要${Math.ceil(context.duration / 3)}个时间行，每镜1–2行；实际为${rowCount}行。`)
  if (value.shots.some((shot, index) => shot.shot_number !== index + 1)) issue('video_prompt_plan.shots', 'plan_shot_order', 'shot_number必须从1连续递增并保持description子镜头顺序。')

  const visibleIds = new Set<number>()
  const referencedProps = new Set<string>()
  let rowIndex = 0
  let totalChineseCharacters = 0
  const rows: string[] = []
  for (const shot of value.shots) {
    const field = `video_prompt_plan.shots.${shot.shot_number - 1}`
    const ids = shot.characters.map(character => character.character_id)
    if (new Set(ids).size !== ids.length) issue(`${field}.characters`, 'plan_duplicate_character', '同一子镜头的角色只能声明一次可见性。', shot.shot_number)
    const actualCharacters = shot.characters.filter(character => character.visibility !== 'offscreen')
    for (const character of shot.characters) {
      if (!boundCharacters.some(bound => bound.id === character.character_id)) issue(`${field}.characters`, 'plan_character', '子镜头角色必须来自当前分镜绑定的角色ID。', shot.shot_number)
      if (character.visibility === 'face_visible' && !character.emotion) issue(`${field}.characters`, 'plan_emotion', 'face_visible角色必须提供神情expression及0–100的intensity，不能由渲染器猜测。', shot.shot_number)
      participants.push({ shotNumber: shot.shot_number, characterId: character.character_id, visibility: character.visibility })
      if (character.visibility !== 'offscreen') visibleIds.add(character.character_id)
      if (character.emotion) checkReferences(character.emotion.expression, `${field}.characters.emotion`, shot.shot_number, actualCharacters.map(character => character.character_id))
    }
    for (const [index, row] of shot.rows.entries()) {
      const rowField = `${field}.rows.${index}`
      const start = rowIndex * 3
      const end = Math.min(start + 3, context.duration)
      const seconds = end - start
      rowIndex++
      const pieces: string[] = []
      if (rows.length === 0) pieces.push(finishSentence(value.space, words.stop))
      let visual = row.visual.trim()
      const cuts = cameraCuts(visual)
      if (cuts.length === 1 && cuts[0].index > 0 && /同一机位|同焦段|继续推近|继续固定/u.test(visual.slice(0, cuts[0].index))) {
        issue(`${rowField}.visual`, 'camera_continuity_review', '本时间行同时保留连续摄影前缀与实际切镜，请看稿确认采用连续镜头还是切回；原画面描述未改动。', shot.shot_number, 'warning')
      }
      if (index === 0 && shot.shot_number > 1 && cuts.length === 0) visual = `${words.cut}${language === 'zh' || language === 'ja' ? '，' : ', '}${visual}`
      const references = checkReferences(visual, `${rowField}.visual`, shot.shot_number, actualCharacters.map(character => character.character_id))
      if (!references) {
        const actual = actualCharacters.map(character => boundCharacters.find(bound => bound.id === character.character_id)).find(Boolean)
        const anchor = scene?.location || actual?.name
        if (anchor) visual = `@${anchor}${language === 'zh' || language === 'ja' ? '，' : ', '}${visual}`
        else issue(`${rowField}.visual`, 'plan_anchor_missing', '该时间行没有可用场景或实际画面角色锚点；不会用画外人物或不存在的资产补引用。', shot.shot_number)
      }
      pieces.push(finishSentence(visual, words.stop))
      for (const prop of boundProps) if (row.visual.includes(`@${prop.name}`)) referencedProps.add(prop.name)
      if (index === 0) for (const character of actualCharacters) {
        const name = boundCharacters.find(bound => bound.id === character.character_id)?.name
        if (!name) continue
        if (character.visibility === 'face_visible' && character.emotion) pieces.push(finishSentence(words.expression(name, character.emotion.expression.trim(), character.emotion.intensity), words.stop))
        else if (character.visibility === 'face_hidden') pieces.push(finishSentence(words.hidden(name), words.stop))
        else if (character.visibility === 'uncertain') pieces.push(finishSentence(words.uncertain(name), words.stop))
      }
      const speeches = row.dialogue || []
      const explicitSeconds = speeches.reduce((sum, speech) => sum + (speech.spoken_seconds || 0), 0)
      if (explicitSeconds > seconds + 0.001) issue(`${rowField}.dialogue`, 'plan_spoken_seconds', '本行显式分配的口播时间超过真实时间行长度，请重新安排而非提速。', shot.shot_number)
      if (speeches.length > 1 && speeches.some(speech => speech.spoken_seconds == null)) issue(`${rowField}.dialogue`, 'plan_speech_allocation', '同一行有多轮发声时，请逐轮提供spoken_seconds，避免把整行时长重复分配给多人。', shot.shot_number)
      let rowChineseCharacters = 0
      for (const [dialogueIndex, speech] of speeches.entries()) {
        const speaker = speech.speaker_id != null ? boundCharacters.find(character => character.id === speech.speaker_id) : undefined
        if (speech.speaker_id != null && !speaker) issue(`${rowField}.dialogue`, 'plan_speaker', '发声者ID必须属于当前分镜绑定角色。', shot.shot_number)
        const trustedSourceDialogue = speech.kind === 'dialogue' && Boolean(speaker)
          && !actualCharacters.some(character => character.character_id === speaker!.id)
          && trustedSourceDialogueSlots.has(`${shot.shot_number}:${index}:${dialogueIndex}`)
        const availableVoice = speaker?.voiceReference?.trim() ? speaker.voiceReference : undefined
        if (availableVoice && availableVoice !== `#${speaker!.name}`) issue(`${rowField}.dialogue.voice_reference`, 'plan_voice_reference', '后端提供的可用音色引用与说话者正式姓名不一致，不能使用。', shot.shot_number)
        if (speech.voice_reference !== undefined && (!availableVoice || speech.voice_reference !== availableVoice)) issue(`${rowField}.dialogue.voice_reference`, 'plan_voice_reference', 'voice_reference必须与该绑定说话者当前可用的音色token完全一致；不能虚构、借用或引用已移除的音色。', shot.shot_number)
        if (speech.kind === 'dialogue' && !trustedSourceDialogue && (!speaker || !actualCharacters.some(character => character.character_id === speech.speaker_id))) issue(`${rowField}.dialogue`, 'plan_speaker_visibility', '画内对白必须注明实际在本子镜头画面内的speaker_id；画外声音请使用offscreen或narration。', shot.shot_number)
        if (speaker && !trustedSourceDialogue && !shot.characters.some(character => character.character_id === speaker.id)) participants.push({ shotNumber: shot.shot_number, characterId: speaker.id, visibility: 'offscreen' })
        const spokenSeconds = speech.spoken_seconds ?? seconds
        if (spokenSeconds > seconds + 0.001) issue(`${rowField}.dialogue.spoken_seconds`, 'plan_spoken_seconds', '单轮口播时长超过本时间行的实际余量。', shot.shot_number)
        const isChinese = chineseSpeech(speech.text)
        const useWords = language === 'en' && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(speech.text)
        const length = useWords ? wordCount(speech.text) : characterCount(speech.text)
        const rate = numberText(length / spokenSeconds)
        if (isChinese) {
          rowChineseCharacters += characterCount(speech.text)
          totalChineseCharacters += characterCount(speech.text)
          if (characterCount(speech.text) > spokenSeconds * 4.5 + 0.001) issue(`${rowField}.dialogue`, 'plan_dialogue_capacity', '原文台词超出口播时间的4.5字/秒容量，请调整分配或拆分；不会自动提速、删改台词。', shot.shot_number)
        }
        const speakerLabel = availableVoice || speaker?.name || ''
        const label = trustedSourceDialogue
          ? words.trustedDialogue(`@${speaker!.name}${availableVoice ? `（${availableVoice}）` : ''}`)
          : speech.kind === 'dialogue' ? words.speech(speakerLabel) : speech.kind === 'offscreen' ? words.offscreen(speakerLabel) : words.narration(speakerLabel)
        const voice = words.voice(speech.voice.age.trim(), speech.voice.register.trim(), speech.voice.timbre.trim())
        const delivery = speech.voice.delivery?.trim()
        const rateDescription = language === 'en' ? wording.en.rate(rate, useWords ? 'words' : 'characters') : words.rate(rate)
        pieces.push(`${label}${words.colon}${quoted(speech.text)} ${voice}${delivery ? `，${delivery}` : ''}，${rateDescription}${words.stop}`)
      }
      if (rowChineseCharacters > seconds * 4.5 + 0.001) issue(`${rowField}.dialogue`, 'plan_dialogue_capacity', '本时间行的多轮中文台词总量超出4.5字/秒容量，不能以重叠对白或提速隐藏冲突。', shot.shot_number)
      rows.push(`${numberText(start)}-${numberText(end)}${words.seconds}${words.colon}${pieces.join(' ')}`)
    }
  }
  if (totalChineseCharacters / 4.5 + 2 > context.duration + 0.001) issue('duration', 'plan_dialogue_budget', '整段中文台词按4.5字/秒加2秒表演余量后超过既定时长，请拆分或重新分配，不得删词或提速。')
  const names = [...visibleIds].map(id => boundCharacters.find(character => character.id === id)?.name).filter((name): name is string => Boolean(name))
  const header = `${words.cast}${words.colon}${names.length ? names.map(name => `@${name}`).join('、') : words.none}；${words.scene}${words.colon}${scene ? `@${scene.location}` : words.unboundScene}${referencedProps.size ? `；${words.props}${words.colon}${[...referencedProps].map(name => `@${name}`).join('、')}` : ''}${words.stop}${words.globals}`
  const prompt = [header, ...rows].join('\n')
  if ([...prompt].length > 3600) issue('video_prompt', 'plan_prompt_length', '组装后的提示词超过3600字符；请精简计划中的重复描写，渲染器不会裁剪台词或关键内容。')
  issue('video_prompt_plan', 'plan_semantic_review', '结构化渲染只保证可检查的格式与字段；剧情忠实、空间真实性、表演适用性及跨组承接仍需校验。', undefined, 'warning')
  const uniqueParticipants = [...new Map(participants.map(participant => [`${participant.shotNumber}:${participant.characterId}`, participant])).values()]
  return { prompt: issues.some(issue => issue.severity === 'error') ? '' : prompt, participants: uniqueParticipants, issues }
}
