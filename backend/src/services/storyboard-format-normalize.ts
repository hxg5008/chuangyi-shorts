import { splitQuotedText } from '../utils/quoted-text.js'
import type { VoiceProfiles } from './storyboard-voice-cues.js'

/**
 * Deterministic format normalisation of one model submission, applied before
 * any validation. Each rule fixes a writing slip that has exactly one correct
 * reading; none of them changes an original word inside quotes, a speaker, an
 * order or a time. Anything ambiguous is left untouched so the normal checks
 * still report it.
 *
 * 1. A field written with the two characters "\" "n" instead of line breaks
 *    (and with no real line break at all) gets real line breaks.
 * 2. description quotes identical, in the same order, to the anchored
 *    video_prompt quotes, while description has no voice anchor at all: the
 *    same anchors are written in front of the same quotes (a speaking label the
 *    model wrote right there, such as "秦翠花说：", is replaced by the anchor).
 * 3. A label naming the SAME speaker as the anchor right in front of it
 *    ("[[character:N]]", "[[character:N]]说：", "[[character:N]]Name",
 *    "Name说：", "Name") is removed: the anchor renders "@Name说" itself.
 *    A bare verb ("接着说：") or any other person's name is left alone.
 * 4. A speaker's fixed voice (age/register/timbre) worded differently from the
 *    one already established for that speaker uses the established wording.
 *    Per-line delivery (state, goal, volume, rate, breath, tail, emotion) stays.
 * 5. (round 3) Mechanical fields fixed by the approved plan or the original
 *    script: missing shot_number/source_ids/duration/scene_id, group_number,
 *    and voice-cue key aliases (character_id → speaker_id, a missing kind that
 *    the speaker's own original lines state explicitly). See fillPlannedFields.
 */
export interface NormalizedSubmission {
  raw: unknown
  notes: string[]
}

const isObject = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const quoteOpen = /^[「『“"]/u
const anchorAtEnd = /\[\[voice:([^\]\r\n]+)\]\][ \t]*[:：]?[ \t]*$/u

/** Quoted original words in order, with the anchor (if any) written right before each. */
function quoteSlots(text: string) {
  const parts = splitQuotedText(text)
  const slots: Array<{ index: number; text: string; anchor: string | null }> = []
  let offset = 0
  for (const [position, part] of parts.entries()) {
    if (part.quoted && quoteOpen.test(part.text)) {
      const previous = position > 0 && !parts[position - 1].quoted ? parts[position - 1].text : ''
      slots.push({ index: offset, text: part.text, anchor: previous.match(anchorAtEnd)?.[1] ?? null })
    }
    offset += part.text.length
  }
  return slots
}

/** Apply a replacement only to the text outside quoted original words. */
function outsideQuotes(text: string, replace: (chunk: string) => string) {
  return splitQuotedText(text).map(part => part.quoted ? part.text : replace(part.text)).join('')
}

function fixLiteralNewlines(value: Record<string, any>, notes: string[]) {
  for (const field of ['video_prompt', 'description']) {
    const text = value[field]
    if (typeof text !== 'string' || /\r|\n/u.test(text) || !text.includes('\\n')) continue
    if (splitQuotedText(text).some(part => part.quoted && part.text.includes('\\n'))) continue
    value[field] = outsideQuotes(text, chunk => chunk.replace(/\\r\\n|\\n/gu, '\n'))
    notes.push(`${field}：字面"\\n"已还原为换行`)
  }
}

/** A speaking label written right before a quote, e.g. "秦翠花说：" or "[[character:7]]说：". */
const labelBeforeQuote = /(?:\[\[character:\d+\]\][ \t]*)?(?:[\p{Script=Han}]{1,8}[ \t]*)?(?:说|道)[ \t]*[:：][ \t]*$/u

function copyDescriptionAnchors(value: Record<string, any>, notes: string[]) {
  const description = value.description, video = value.video_prompt
  if (typeof description !== 'string' || typeof video !== 'string') return
  if (/\[\[voice:/u.test(description) || !/\[\[voice:/u.test(video)) return
  const want = quoteSlots(video), have = quoteSlots(description)
  if (!want.length || want.length !== have.length || want.some(slot => !slot.anchor)) return
  if (want.some((slot, index) => slot.text !== have[index].text)) return
  let result = '', cursor = 0
  for (const [index, slot] of have.entries()) {
    const before = description.slice(cursor, slot.index)
    const label = before.match(labelBeforeQuote)
    result += `${label ? before.slice(0, before.length - label[0].length) : before}[[voice:${want[index].anchor}]]：`
    cursor = slot.index
  }
  value.description = result + description.slice(cursor)
  notes.push(`description：按视频提示词同顺序台词补上声音标记 ${have.length} 处`)
}

function removeSameSpeakerLabels(value: Record<string, any>, names: ReadonlyMap<number, string>, notes: string[]) {
  if (!Array.isArray(value.voice_cues)) return
  const speakers = new Map<string, number>()
  for (const cue of value.voice_cues) if (isObject(cue) && typeof cue.id === 'string' && Number.isSafeInteger(cue.speaker_id)) speakers.set(cue.id, cue.speaker_id)
  let removed = 0
  for (const field of ['description', 'video_prompt']) {
    if (typeof value[field] !== 'string' || !/\[\[voice:/u.test(value[field])) continue
    value[field] = outsideQuotes(value[field], chunk => chunk.replace(
      /(\[\[character:(\d+)\]\])?([ \t]*)([\p{Script=Han}]{1,8})?[ \t]*([:：])?[ \t]*(\[\[voice:([^\]\r\n]+)\]\])/gu,
      (match: string, token: string | undefined, tokenId: string | undefined, _space: string, word: string | undefined, _colon: string | undefined, anchor: string, id: string) => {
        const speaker = speakers.get(id)
        if (speaker === undefined) return match
        const name = names.get(speaker)
        const sameToken = token !== undefined && Number(tokenId) === speaker
        // The word right before the anchor: the speaker's own name, optionally followed by 说/道,
        // or just 说/道 after the speaker's own token.
        const wordIsName = word !== undefined && name !== undefined && (word === name || word === `${name}说` || word === `${name}道`)
        const wordIsVerb = word === '说' || word === '道'
        const remove = sameToken ? (word === undefined || wordIsName || wordIsVerb) : (token === undefined && wordIsName)
        if (!remove) return match
        removed++
        return anchor
      }))
  }
  if (removed) notes.push(`去掉声音标记前同一说话人的重复标签 ${removed} 处`)
}

function unifyProfiles(value: Record<string, any>, established: VoiceProfiles, notes: string[]) {
  if (!Array.isArray(value.voice_cues)) return
  for (const cue of value.voice_cues) {
    if (!isObject(cue) || !isObject(cue.profile)) continue
    const key = cue.speaker_id === null || cue.speaker_id === undefined ? `source:${cue.kind}:${cue.source_name}` : `character:${cue.speaker_id}`
    const saved = established[key]
    if (!saved || JSON.stringify(saved) === JSON.stringify(cue.profile)) continue
    notes.push(`${cue.id}：固定声线「${[cue.profile.age, cue.profile.register, cue.profile.timbre].join('、')}」统一为已定的「${[saved.age, saved.register, saved.timbre].join('、')}」`)
    cue.profile = structuredClone(saved)
  }
}

/**
 * Round 3 (2026-11-08, user-approved): mechanical fields whose only correct value is already fixed by the approved
 * narrative plan or by the original script. Seen in real runs of another text model (27 of 47 complete answers):
 * group_number instead of shot_number, source_ids left out, character_id instead of speaker_id, kind left out.
 * Only MISSING values are filled and only exact aliases are renamed; a written value that differs from the plan is
 * never overwritten (the plan check still reports it). Creative content — description, video_prompt, quoted words,
 * timing, bindings — is never touched here.
 */
export interface PlannedGroupFacts {
  number: number
  source_ids: readonly number[]
  duration: number
  scene_id: number | null
  /** This group's own original source lines (used only to read each speaker's explicit voice kind). */
  source_lines?: readonly string[]
}

function fillPlannedFields(value: Record<string, any>, plan: PlannedGroupFacts, notes: string[]) {
  // Only complete-group answers carry these fields; a targeted patch ({base_version, changes}) is left alone.
  if (typeof value.description !== 'string' || typeof value.video_prompt !== 'string') return
  if (Object.hasOwn(value, 'group_number') && value.group_number === plan.number && (value.shot_number === undefined || value.shot_number === plan.number)) {
    delete value.group_number
    if (value.shot_number === undefined) { value.shot_number = plan.number; notes.push(`group_number改为shot_number（${plan.number}）`) }
    else notes.push('去掉与shot_number重复的group_number')
  }
  if (value.shot_number === undefined && !Object.hasOwn(value, 'group_number')) { value.shot_number = plan.number; notes.push(`shot_number按本组规划补为${plan.number}`) }
  if (value.source_ids === undefined) { value.source_ids = [...plan.source_ids]; notes.push(`source_ids按本组规划补为[${plan.source_ids.join(',')}]`) }
  if (value.duration === undefined) { value.duration = plan.duration; notes.push(`duration按本组规划补为${plan.duration}`) }
  if (!Object.hasOwn(value, 'scene_id')) { value.scene_id = plan.scene_id; notes.push(`scene_id按本组规划补为${plan.scene_id}`) }
  // character_ids / prop_ids are NOT filled: the plan does not fix them, so a missing binding list goes to repair.
}

/**
 * Verification run (2026-11-08): one relay/model writes numbers as text ("18", ["1","2"], "13") although the request
 * schema asks for numbers. Only plain decimal digits are read as numbers (IDs as positive integers); a name, a word or
 * anything else stays exactly as written for the normal checks.
 */
const INTEGER_TEXT = /^\s*[1-9]\d*\s*$/u
const NUMBER_TEXT = /^\s*(?:0|[1-9]\d*)(?:\.\d+)?\s*$/u
const asInteger = (input: unknown) => typeof input === 'string' && INTEGER_TEXT.test(input) ? Number(input) : input
const asNumber = (input: unknown) => typeof input === 'string' && NUMBER_TEXT.test(input) ? Number(input) : input
function readNumbers(target: Record<string, any>, singles: Record<string, (input: unknown) => unknown>, lists: readonly string[] = []) {
  const changed: string[] = []
  for (const [key, convert] of Object.entries(singles)) {
    if (!Object.hasOwn(target, key)) continue
    const next = convert(target[key])
    if (next !== target[key]) { target[key] = next; changed.push(key) }
  }
  for (const key of lists) {
    if (!Array.isArray(target[key])) continue
    const next = target[key].map(asInteger)
    if (next.some((entry: unknown, index: number) => entry !== target[key][index])) { target[key] = next; changed.push(key) }
  }
  return changed
}
const CUE_SPEAKER_ALIASES = ['character_id', 'characterId', 'CharacterID', 'speaker_character_id', 'speakerId'] as const
function coerceNumbers(value: Record<string, any>, notes: string[]) {
  const changed = readNumbers(value, { shot_number: asInteger, group_number: asInteger, scene_id: asInteger, duration: asNumber },
    ['character_ids', 'prop_ids', 'source_ids', 'time_row_counts'])
  if (Array.isArray(value.voice_cues)) for (const cue of value.voice_cues) {
    if (!isObject(cue)) continue
    const cueChanged = readNumbers(cue, { speaker_id: asInteger, shot: asInteger, rate_cps: asNumber, ...Object.fromEntries(CUE_SPEAKER_ALIASES.map(key => [key, asInteger])) })
    changed.push(...cueChanged.map(key => `${typeof cue.id === 'string' ? cue.id : '声音'}.${key}`))
  }
  if (changed.length) notes.push(`数字写成了文字，按数字读取：${changed.join('、')}`)
}

/** The narrative plan answer: numbers written as text are read as numbers (same rule as above). */
export function normalizePlanSubmission(raw: unknown): NormalizedSubmission {
  if (!isObject(raw) || typeof raw.conflict === 'string' || !Array.isArray(raw.groups)) return { raw, notes: [] }
  let changed = 0
  const groups = raw.groups.map((group: unknown) => {
    if (!isObject(group)) return group
    const next = { ...group }
    if (readNumbers(next, { number: asInteger, scene_id: asInteger, duration: asNumber }, ['source_ids']).length) { changed++; return next }
    return group
  })
  return changed ? { raw: { ...raw, groups }, notes: [`规划中${changed}组的数字写成了文字，已按数字读取`] } : { raw, notes: [] }
}

/** A targeted repair answer ({base_version, changes}): numbers written as text inside `changes` are read as numbers. */
export function normalizeRepairPatch(raw: unknown): NormalizedSubmission {
  if (!isObject(raw) || !isObject(raw.changes)) return { raw, notes: [] }
  const changes = structuredClone(raw.changes), notes: string[] = []
  coerceNumbers(changes, notes)
  return notes.length ? { raw: { ...raw, changes }, notes } : { raw, notes: [] }
}

type VoiceKind = 'dialogue' | 'offscreen' | 'narration'
/**
 * Each speaker's voice kind as written in the original lines: "名字：…" is in-scene dialogue; "名字（画外音/OS…）："
 * is off-screen; "名字（旁白/独白…）：" is narration. Any other note before the colon ("（电话）", "（仅林轩听见）")
 * is unclear and never guessed.
 */
export function speakerVoiceKinds(lines: readonly string[], names: readonly string[]) {
  const sorted = [...new Set(names)].filter(Boolean).sort((a, b) => b.length - a.length)
  const kinds = new Map<string, Set<VoiceKind | 'unclear'>>()
  for (const raw of lines) {
    const line = raw.trim()
    const name = sorted.find(candidate => line.startsWith(candidate))
    if (!name) continue
    const rest = line.slice(name.length)
    const annotated = /^[（(]([^）)]*)[）)]\s*[:：]/u.exec(rest)
    const plain = /^\s*[:：]/u.test(rest)
    if (!annotated && !plain) continue
    const note = annotated?.[1] || ''
    const kind: VoiceKind | 'unclear' = !annotated ? 'dialogue'
      : /旁白|内心独白|独白|narrat/iu.test(note) ? 'narration'
        : /画外|(?:^|[^a-z])(?:OS|O\.S\.|VO|V\.O\.)(?:$|[^a-z])|off[- ]?screen|voice[- ]?over/iu.test(note) ? 'offscreen' : 'unclear'
    if (!kinds.has(name)) kinds.set(name, new Set())
    kinds.get(name)!.add(kind)
  }
  return kinds
}

const VALID_KINDS: readonly string[] = ['dialogue', 'offscreen', 'narration']
/** "[[character:N]]" or (verification run) "character:N", with N a positive integer; anything else is not a speaker ID. */
const tokenId = (value: unknown) => typeof value === 'string' ? Number(/^\s*(?:\[\[character:([1-9]\d*)\]\]|character:([1-9]\d*))\s*$/u.exec(value)?.slice(1).find(Boolean)) : NaN
function normalizeCueFields(value: Record<string, any>, characters: ReadonlyArray<{ id: number; name: string }>, plan: PlannedGroupFacts | undefined, notes: string[]) {
  if (!Array.isArray(value.voice_cues)) return
  const nameOf = new Map(characters.map(character => [character.id, character.name]))
  const known = (id: unknown): id is number => Number.isSafeInteger(id) && nameOf.has(id as number)
  const quotes = new Set([value.description, value.video_prompt].filter(text => typeof text === 'string')
    .flatMap(text => splitQuotedText(text as string).filter(part => part.quoted).map(part => part.text.slice(1, -1))))
  const scriptKinds = plan?.source_lines ? speakerVoiceKinds(plan.source_lines, characters.map(character => character.name)) : null
  for (const cue of value.voice_cues) {
    if (!isObject(cue)) continue
    const label = typeof cue.id === 'string' ? cue.id : '声音'
    // The speaker written under another key: only an exact registered character ID (or its [[character:ID]] token).
    if (!Object.hasOwn(cue, 'speaker_id')) {
      const alias = CUE_SPEAKER_ALIASES.find(key => known(cue[key])) || (known(tokenId(cue.speaker)) ? 'speaker' : undefined)
      if (alias) {
        cue.speaker_id = alias === 'speaker' ? tokenId(cue.speaker) : cue[alias]
        delete cue[alias]
        notes.push(`${label}：${alias}改为speaker_id`)
      }
    }
    for (const key of CUE_SPEAKER_ALIASES) if (Object.hasOwn(cue, key) && cue[key] === cue.speaker_id) { delete cue[key]; notes.push(`${label}：去掉与speaker_id重复的${key}`) }
    if (Object.hasOwn(cue, 'speaker') && known(cue.speaker_id) && tokenId(cue.speaker) === cue.speaker_id) { delete cue.speaker; notes.push(`${label}：去掉与speaker_id重复的speaker`) }
    if (Object.hasOwn(cue, 'role_name') && known(cue.speaker_id) && nameOf.get(cue.speaker_id) === cue.role_name) { delete cue.role_name; notes.push(`${label}：去掉与说话人重复的role_name`) }
    if (Object.hasOwn(cue, 'text') && typeof cue.text === 'string' && quotes.has(cue.text)) { delete cue.text; notes.push(`${label}：去掉重复正文原词的text`) }
    // Voice kind: an explicit valid value under another key, otherwise the original lines of this speaker in this
    // group when all of them say the same kind explicitly. Anything else stays as it is and is repaired as before.
    if (!Object.hasOwn(cue, 'kind')) {
      const alias = ['role', 'speaker_kind', 'voice_kind'].find(key => typeof cue[key] === 'string' && VALID_KINDS.includes(cue[key]))
      if (alias) { cue.kind = cue[alias]; delete cue[alias]; notes.push(`${label}：${alias}改为kind`) }
      else if (scriptKinds && known(cue.speaker_id)) {
        const found = scriptKinds.get(nameOf.get(cue.speaker_id)!)
        const only = found && found.size === 1 ? [...found][0] : null
        if (only && only !== 'unclear') { cue.kind = only; notes.push(`${label}：按本组原文中${nameOf.get(cue.speaker_id)}的写法补kind=${only}`) }
      }
    }
    for (const key of ['role', 'speaker_kind']) if (Object.hasOwn(cue, key) && (cue[key] === cue.kind || cue[key] === 'character' && known(cue.speaker_id))) { delete cue[key]; notes.push(`${label}：去掉与kind重复的${key}`) }
    if (!Object.hasOwn(cue, 'source_name') && known(cue.speaker_id)) { cue.source_name = ''; notes.push(`${label}：已绑定角色，source_name补为空`) }
  }
}

export function normalizeSubmission(raw: unknown, options: { established: VoiceProfiles; characters: ReadonlyArray<{ id: number; name: string }>; plan?: PlannedGroupFacts }): NormalizedSubmission {
  if (!isObject(raw) || typeof raw.conflict === 'string') return { raw, notes: [] }
  const value = structuredClone(raw)
  const notes: string[] = []
  const names = new Map(options.characters.map(character => [character.id, character.name]))
  coerceNumbers(value, notes)
  if (options.plan) fillPlannedFields(value, options.plan, notes)
  normalizeCueFields(value, options.characters, options.plan, notes)
  fixLiteralNewlines(value, notes)
  copyDescriptionAnchors(value, notes)
  removeSameSpeakerLabels(value, names, notes)
  unifyProfiles(value, options.established, notes)
  return { raw: notes.length ? value : raw, notes }
}
