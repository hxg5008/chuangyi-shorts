import { z } from 'zod'
import { splitQuotedText } from '../utils/quoted-text.js'
import { skillSpokenTurns } from './skill-storyboard-validation.js'
import type { ValidationIssue } from './storyboard-validation.js'

export interface VoiceAssets { characters: readonly { id: number; name: string }[] }
export interface VoiceProfile { age: string; register: string; timbre: string }
export type VoiceProfiles = Record<string, VoiceProfile>
export interface StoryboardVoiceCue {
  id: string
  shot: number
  speaker_id: number | null
  kind: 'dialogue' | 'offscreen' | 'narration'
  source_name: string
  profile: VoiceProfile
  state: string
  goal: string
  volume: string
  rate_cps: number
  breath: string
  tail: string
  emotion: string
}

const clean = (max: number) => z.string().trim().min(1).max(max).refine(value =>
  !/[\r\n「」『』“”"【】]/u.test(value) && !/\[\[|\]\]|[@#]|(?:说|旁白|画外音)\s*[:：]/u.test(value),
  'Voice data is plain acoustic/delivery prose, without new quoted speech, markup or asset references').refine(value =>
  !/^(?:待定|待绑定|未提供|未指定|未知|同上|同前|照旧|n\/a|tbd|unknown|unspecified|same as (?:above|before))$/iu.test(value),
  'Give an actual conservative voice design, never an empty placeholder or a same-as-above reference')
const profileSchema = z.object({ age: clean(30), register: clean(30), timbre: clean(30) }).strict()
const profileText = (profile: VoiceProfile) => `${profile.age}、${profile.register}、${profile.timbre}`
const cueKey = (cue: StoryboardVoiceCue) => cue.speaker_id === null
  ? `source:${cue.kind}:${cue.source_name}` : `character:${cue.speaker_id}`
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const marks = /【\s*(?:镜头|shot|ショット|컷)\s*(\d+)\s*】/giu
const row = /^\s*(\d+(?:\.\d+)?)\s*[-–—~～至]\s*(\d+(?:\.\d+)?)\s*(?:秒|s|초)\s*[:：]\s*(.+)$/iu
const anchorPattern = /\[\[voice:([^\]\r\n]+)\]\]/gu

/** A transport-only acoustic contract; the existing creative prose stays whole. */
export function buildVoiceCueSchema(assets: VoiceAssets) {
  const ids = [...new Set(assets.characters.map(character => character.id).filter(id => Number.isSafeInteger(id) && id > 0))]
  const speaker = ids.length ? z.literal(ids as [number, ...number[]]).nullable() : z.null()
  return z.array(z.object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/u), shot: z.number().int().min(1).max(4),
    speaker_id: speaker, kind: z.enum(['dialogue', 'offscreen', 'narration']), source_name: z.string().trim().max(80),
    profile: profileSchema, state: clean(120), goal: clean(120), volume: clean(60), rate_cps: z.number().finite().positive(),
    breath: clean(60), tail: clean(60), emotion: clean(100),
  }).strict()).superRefine((cues, context) => {
    const seen = new Set<string>()
    for (const [index, cue] of cues.entries()) {
      if (seen.has(cue.id)) context.addIssue({ code: 'custom', path: [index, 'id'], message: 'Voice cue IDs must be unique' })
      seen.add(cue.id)
      if (cue.speaker_id === null && !cue.source_name) context.addIssue({ code: 'custom', path: [index, 'source_name'], message: 'An unbound voice needs an explicit source name' })
      if (cue.speaker_id === null && cue.kind === 'dialogue') context.addIssue({ code: 'custom', path: [index, 'speaker_id'], message: 'In-scene dialogue needs an explicit available character ID; an unbound visible speaker must be reported as a conflict, never guessed' })
      if (cue.speaker_id === null && assets.characters.some(character => character.name === cue.source_name)) context.addIssue({ code: 'custom', path: [index, 'speaker_id'], message: 'This exact formal voice source is a registered character; supply its explicit ID rather than bypassing the stable character profile registry' })
      if (cue.speaker_id === null && /^(?:他|她|它|他们|她们|某人|有人|he|she|they|someone|somebody|彼|彼女|誰か|그|그녀|누군가)$/iu.test(cue.source_name)) context.addIssue({ code: 'custom', path: [index, 'source_name'], message: 'A pronoun or unspecified person is not an explicit voice source; provide the known source or report a conflict' })
      if (/[\r\n「」『』“”"【】]/u.test(cue.source_name) || /\[\[|\]\]|[@#]/u.test(cue.source_name)) context.addIssue({ code: 'custom', path: [index, 'source_name'], message: 'Voice source is a plain name, never markup or new speech' })
      const length = [...profileText(cue.profile)].length
      if (length < 15 || length > 30) context.addIssue({ code: 'custom', path: [index, 'profile'], message: 'Combined age, range and timbre must form the original skill’s 15–30 character fixed voice description' })
    }
  })
}

interface Part { text: string; quoted: boolean; start: number; end: number }
interface Anchor { id: string; start: number; end: number; quoteStart: number; shot: number | null }
function parts(text: string): Part[] {
  let offset = 0
  return splitQuotedText(text).map(part => {
    const start = offset; offset += part.text.length
    return { ...part, start, end: offset }
  })
}
function childAtDescription(text: string, at: number) {
  return [...text.matchAll(marks)].filter(mark => mark.index! < at).at(-1)?.[1]
}
function childAtVideo(text: string, at: number, counts: unknown) {
  if (!Array.isArray(counts) || !counts.length || counts.some(count => count !== 1 && count !== 2)) return null
  let offset = 0, index = 0
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/gu)) {
    if (!match[0]) continue
    const body = match[0].replace(/(?:\r\n|\r|\n)$/u, '')
    if (body.match(row)) {
      if (at >= offset && at < offset + body.length) {
        let limit = 0
        for (const [child, length] of counts.entries()) { limit += length; if (index < limit) return child + 1 }
        return null
      }
      index++
    }
    offset += match[0].length
  }
  return null
}
function anchors(text: string, field: 'description' | 'video_prompt', counts: unknown, issues: ValidationIssue[]): Anchor[] {
  const entries = parts(text), result: Anchor[] = []
  for (const [index, part] of entries.entries()) {
    if (part.quoted) continue
    for (const match of part.text.matchAll(anchorPattern)) {
      const start = part.start + match.index!, end = start + match[0].length
      const next = entries[index + 1]
      const after = part.text.slice(match.index! + match[0].length)
      const before = part.text.slice(0, match.index!)
      if (/(?:写着|写有|刻着|刻有|印着|印有|标注为|字幕为|牌匾为|标牌为)[ \t]*[:：]?[ \t]*$/u.test(before)) {
        issues.push({ code: 'voice_anchor_visual_quote', field, severity: 'error', message: `声音锚点${match[1]}不能把明确的牌面、字幕或书写文字转换成发声。` })
        continue
      }
      if (!/^[ \t]*[:：]?[ \t]*$/u.test(after) || !next?.quoted || !next.text.trim()) {
        issues.push({ code: 'voice_anchor_position', field, severity: 'error', message: `声音锚点${match[1]}必须紧邻该句原词引号，不跨行或引用视觉文字。` })
        continue
      }
      const shot = field === 'description' ? Number(childAtDescription(text, start)) || null : childAtVideo(text, start, counts)
      result.push({ id: match[1], start, end, quoteStart: next.start, shot })
    }
    const remainder = part.text.replace(anchorPattern, '')
    if (/\[\[voice(?::|\])/u.test(remainder)) issues.push({ code: 'voice_anchor_invalid', field, severity: 'error', message: '正文含未闭合或格式错误的声音锚点。' })
  }
  return result
}

function label(cue: StoryboardVoiceCue, language: string) {
  const token = cue.speaker_id === null ? '' : `[[character:${cue.speaker_id}]]`
  if (language.startsWith('en')) return cue.kind === 'dialogue' ? `${token || cue.source_name} says`
    : cue.kind === 'offscreen' ? token ? `${token} (OS) says` : `off-screen voice (${cue.source_name})`
      : token ? `${token} narration` : `narration (${cue.source_name})`
  if (language.startsWith('ja')) return cue.kind === 'dialogue' ? `${token || cue.source_name}が言う`
    : cue.kind === 'offscreen' ? token ? `${token}（OS）が言う` : `OS（${cue.source_name}）`
      : token ? `${token}のナレーション` : `ナレーション（${cue.source_name}）`
  if (language.startsWith('ko')) return cue.kind === 'dialogue' ? `${token || cue.source_name}는 말한다`
    : cue.kind === 'offscreen' ? token ? `${token}(OS)는 말한다` : `OS（${cue.source_name}）`
      : token ? `${token} 내레이션` : `내레이션（${cue.source_name}）`
  return cue.kind === 'dialogue' ? `${token || cue.source_name}说`
    : cue.kind === 'offscreen' ? token ? `${token}（画外音）说` : `画外音（${cue.source_name}）`
      : token ? `${token}的旁白` : cue.source_name === '旁白' ? '旁白' : `旁白（${cue.source_name}）`
}
function delivery(cue: StoryboardVoiceCue, language: string) {
  const profile = profileText(cue.profile)
  if (language.startsWith('en')) return `${profile}; ${cue.state}; aims to ${cue.goal}; volume ${cue.volume}, about ${cue.rate_cps} characters per second, breath ${cue.breath}, endings ${cue.tail}, emotion ${cue.emotion}; ${label(cue, language)}`
  if (language.startsWith('ja')) return `${profile}、${cue.state}、${cue.goal}を目的に、声量${cue.volume}、毎秒約${cue.rate_cps}文字、呼吸${cue.breath}、語尾${cue.tail}、感情${cue.emotion}で、${label(cue, language)}`
  if (language.startsWith('ko')) return `${profile}, ${cue.state}, ${cue.goal}을 목표로, 음량${cue.volume}, 초당 약${cue.rate_cps}자, 호흡${cue.breath}, 말끝${cue.tail}, 감정${cue.emotion}로 ${label(cue, language)}`
  return `${profile}，当前${cue.state}，以${cue.goal}为发声目标，音量${cue.volume}、语速约每秒${cue.rate_cps}字、气息${cue.breath}、尾音${cue.tail}，情绪${cue.emotion}，${label(cue, language)}`
}

export interface CompiledStoryboardVoices {
  submission: Record<string, unknown> | null
  issues: ValidationIssue[]
  profiles: VoiceProfiles
  metadata?: StoryboardVoiceCue[]
  /** Deterministic transport-only aliases, never guessed or inserted into prose. */
  referenceAliases?: Array<{ field: 'description' | 'video_prompt'; from: string; to: string; shot: number }>
}

/** Materialize only explicitly declared acoustic cues; never infer a nearby actor. */
export function compileStoryboardVoices(raw: unknown, options: {
  assets: VoiceAssets; profiles?: VoiceProfiles; language?: string
}): CompiledStoryboardVoices {
  const profiles: VoiceProfiles = structuredClone(options.profiles || {}), issues: ValidationIssue[] = []
  if (!isObject(raw)) return { submission: null, profiles, issues: [{ code: 'voice_submission', field: 'voice_cues', severity: 'error', message: '声音编译需要完整对象。' }] }
  if (!Object.hasOwn(raw, 'voice_cues')) return { submission: structuredClone(raw), profiles, issues }
  const checked = buildVoiceCueSchema(options.assets).safeParse(raw.voice_cues)
  if (!checked.success) return { submission: null, profiles, issues: checked.error.issues.map(issue => ({
    code: 'voice_cue_schema', field: `voice_cues.${issue.path.join('.')}`, severity: 'error', message: `声音资料不完整：${issue.path.join('.')} ${issue.message}`,
  })) }
  const cues = checked.data, byId = new Map(cues.map(cue => [cue.id, cue]))
  const referenceAliases: NonNullable<CompiledStoryboardVoices['referenceAliases']> = []
  const all = new Map<'description' | 'video_prompt', Anchor[]>()
  const fields = ['description', 'video_prompt'].filter(field => typeof raw[field] === 'string') as Array<'description' | 'video_prompt'>
  if (!fields.includes('video_prompt')) issues.push({ code: 'voice_field_missing', field: 'video_prompt', severity: 'error', message: '声音资料缺少对应的视频正文。' })
  const language = options.language || 'zh'
  for (const cue of cues) {
    const key = cueKey(cue), prior = profiles[key]
    if (prior && JSON.stringify(prior) !== JSON.stringify(cue.profile)) issues.push({ code: 'voice_profile_conflict', field: `voice_cues.${cue.id}.profile`, severity: 'error', message: `声音${key}的固定年龄感、音域或核心音色与已保存设定不一致，不能随镜头改变。` })
    else profiles[key] = structuredClone(cue.profile)
  }
  for (const field of fields) {
    const text = raw[field] as string, found = anchors(text, field, raw.time_row_counts, issues)
    all.set(field, found)
    for (const anchor of found) {
      const cue = byId.get(anchor.id)
      if (!cue) issues.push({ code: 'voice_cue_unknown', field, severity: 'error', message: `声音锚点${anchor.id}没有对应的声音资料。` })
      else if (anchor.shot !== cue.shot) {
        // Internal cue IDs are transport references, not story facts. A typo may
        // name another child's cue for the exact same explicit voice. Correct
        // only when this child declares exactly one cue and its stable identity
        // and fixed acoustic profile are identical. Delivery remains the data
        // already declared for the actual child; no nearby actor is inferred.
        const targets = cues.filter(target => target.shot === anchor.shot)
        const target = targets.length === 1 ? targets[0] : undefined
        if (target && target.speaker_id === cue.speaker_id && target.kind === cue.kind && target.source_name === cue.source_name
          && JSON.stringify(target.profile) === JSON.stringify(cue.profile)) {
          referenceAliases.push({ field, from: anchor.id, to: target.id, shot: target.shot })
          anchor.id = target.id
        } else issues.push({ code: 'voice_cue_shot', field, severity: 'error', message: `声音${cue.id}声明子镜头${cue.shot}，实际锚点位于${anchor.shot ?? '未知位置'}，不得串镜。` })
      }
    }
    // Establish explicit speech before recognizing references such as “孩子”时.
    // The raw anchor is intentionally not itself a speaking verb, so parsing raw
    // prose would lose that earlier utterance and misclassify a delivery quote.
    // Map quote ordinals, never shifted offsets or fuzzy text matches, back to
    // the raw anchors. Labels must leave all original quotes byte-identical.
    let cursor = 0, provisional = ''
    for (const anchor of found) {
      const cue = byId.get(anchor.id)
      provisional += text.slice(cursor, anchor.start) + (cue ? label(cue, language) : text.slice(anchor.start, anchor.end))
      cursor = anchor.end
    }
    provisional += text.slice(cursor)
    const rawQuotes = parts(text).filter(part => part.quoted), parsedQuotes = parts(provisional).filter(part => part.quoted)
    if (rawQuotes.length !== parsedQuotes.length || rawQuotes.some((quote, index) => quote.text !== parsedQuotes[index]?.text)) {
      issues.push({ code: 'voice_label_quote', field, severity: 'error', message: '声音来源标签改变了原词引号结构，未作归属推断或合并。' })
      continue
    }
    const anchoredOrdinals = new Set(found.map(anchor => rawQuotes.findIndex(quote => quote.start === anchor.quoteStart)))
    for (const turn of skillSpokenTurns(provisional, options.assets.characters.map(character => character.name))) {
      const ordinal = parsedQuotes.findIndex(quote => quote.start === turn.start)
      if (ordinal < 0 || !anchoredOrdinals.has(ordinal)) issues.push({
        code: 'voice_cue_missing', field, severity: 'error', message: `发声原词${JSON.stringify(turn.text)}缺少明确声音锚点，不能从附近人物猜归属。`,
      })
    }
  }
  for (const cue of cues) for (const field of fields) if (!all.get(field)?.some(anchor => anchor.id === cue.id)) issues.push({
    code: 'voice_cue_unused', field: `voice_cues.${cue.id}`, severity: 'error', message: `子镜头${cue.shot}的声音${cue.id}未在${field}的对应发声位置使用。`,
  })
  if (issues.length) return { submission: null, issues, profiles: structuredClone(options.profiles || {}), metadata: cues }
  const submission = structuredClone(raw)
  delete submission.voice_cues
  for (const field of fields) {
    const original = raw[field] as string, seen = new Set<string>()
    let cursor = 0, compiled = ''
    for (const anchor of all.get(field) || []) {
      const cue = byId.get(anchor.id)!
      compiled += original.slice(cursor, anchor.start) + (field === 'video_prompt' && !seen.has(cue.id) ? delivery(cue, language) : label(cue, language))
      seen.add(cue.id); cursor = anchor.end
    }
    submission[field] = compiled + original.slice(cursor)
  }
  return { submission, issues, profiles, metadata: cues, ...(referenceAliases.length ? { referenceAliases } : {}) }
}
