import { z } from 'zod'
import { videoPromptPlanSchema } from './video-prompt-plan.js'
import { cameraCuts } from './camera-cuts.js'
import { isReferencedTargetOnly } from './reference-semantics.js'
import type { buildDialogueGroupSchedule, buildDialogueTimingGuide } from './first-pass-instructions.js'
import type { StoryboardCandidate } from './storyboard-session.js'

export type ScheduledDialogueGroup = ReturnType<typeof buildDialogueGroupSchedule>[number]
export interface ScheduledSegmentAssets {
  characters: Array<{ id: number; name: string }>
  scenes: Array<{ id: number; location: string }>
  props: Array<{ id: number; name: string }>
}

interface ScheduledBindings { characterIds: readonly number[]; propIds: readonly number[]; sceneId: number | null }

/** Remove only verbatim canonical speech echoes; keep all surrounding visual facts. */
export function normalizeScheduledVisual(visual: string, canonicalSpeech: readonly string[]): string {
  const canonical = new Set(canonicalSpeech.filter(Boolean))
  const pairs: Record<string, string> = { '「': '」', '『': '』', '“': '”', '‘': '’', '"': '"', "'": "'" }
  const word = (value = '') => /[\p{L}\p{N}]/u.test(value)
  let result = '', from = 0, removed = false
  for (let index = 0; index < visual.length; index++) {
    const open = visual[index], close = pairs[open]
    if (!close || open === "'" && word(visual[index - 1])) continue
    let end = index + 1
    for (; end < visual.length; end++) {
      if (visual[end] === '\\') { end++; continue }
      if (visual[end] === close && !((close === "'" || close === '’') && word(visual[end - 1]) && word(visual[end + 1]))) break
    }
    if (end >= visual.length) continue
    const content = visual.slice(index + 1, end)
    const before = visual.slice(Math.max(0, index - 55), index)
    const after = visual.slice(end + 1)
    const heard = before.match(/(?:听见|听到|想到|想起)([^，,。；;！？\n]{0,16})$/)
    const meta = [...content].length <= 8 && /^[\p{L}\p{N}]+$/u.test(content) && heard
      && !/(?:说|问|答|喊|念|叫|[:：])/.test(heard[1])
      && /^\s*(?:(?:这|那)(?:个|两)?|一|二|两)?(?:字眼|词语|字|词)(?:时|的时候)/.test(after)
    if (meta) {
      result += visual.slice(from, index) + content; from = end + 1
    } else if (canonical.has(content)) {
      result += visual.slice(from, index).replace(/[:：]\s*$/, ''); from = end + 1; removed = true
    } else if (/(?:说道|回答|问道|喊道|说|问|答|喊|旁白|画外音|独白|言う|話す|語る|ナレーション|말한다|말했다|대답한다|내레이션|\bOS\b|\bV\.?O\.?\b|\bsays?\b|\bsaid\b|\basks?\b|\basked\b|\bnarrat(?:ion|or)\b|\bvoice[- ]?over\b)\s*[:：]?\s*$/i.test(before)) {
      throw new Error('Visual contains non-source spoken dialogue; keep speech in canonical source slots')
    }
    index = end
  }
  result += visual.slice(from)
  if (removed) result = result.replace(/[:：]\s*(?=[，,。；;！？!?]|$)/g, '')
    .replace(/[，,；;]\s*([。！？!?])/g, '$1')
    .replace(/([，,。；;！？!?])\s*\1+/g, '$1')
  return result.trim()
}

/** Infer only unique, formally named boundable assets; never infer shot visibility. */
export function collectScheduledReferenceBindings(texts: readonly string[], current: ScheduledBindings, assets: ScheduledSegmentAssets) {
  const records = new Map<string, Map<string, { kind: 'character' | 'prop' | 'scene'; id: number }>>()
  const add = (name: string, kind: 'character' | 'prop' | 'scene', id: number) => {
    if (!name || !Number.isSafeInteger(id) || id < 1) return
    const matches = records.get(name) || new Map()
    matches.set(`${kind}:${id}`, { kind, id }); records.set(name, matches)
  }
  assets.characters.forEach(value => add(value.name, 'character', value.id))
  assets.props.forEach(value => add(value.name, 'prop', value.id))
  assets.scenes.forEach(value => add(value.location, 'scene', value.id))
  const names = [...records.keys()].sort((a, b) => b.length - a.length)
  const boundary = (tail: string) => !tail || /^[\s，,。.!?！？；;：:、（）()【】\[\]“”「」『』"'…]/u.test(tail)
    || /^(?:的|在|被|正|仍|挂|放|位于|上|下|旁|边|处|前|后)/.test(tail)
  // Formal character names can precede complete staging phrases or static gaze
  // locations. Whole words avoid treating a suffix such as 方向盘 as grammar.
  const characterBoundary = (tail: string) => /^(?:方向(?=$|[\s，,。.!?！？；;：:、（）()【】\[\]“”「」『』"'…])|脸上(?=$|[\s，,。.!?！？；;：:、（）()【】\[\]“”「」『』"'…]|(?:(?:缓缓|慢慢|逐渐|轻轻|终于)\s*)*(?:移开|离开|挪开|转开|收回)(?=$|[\s，,。.!?！？；;：:、])))/u.test(tail)
    || /^(?:站在|站着|站于|立于|立在|站立于|站立在|位于|跟在|随在|坐在|坐着|坐于|仰卧|半躺|蹲在|蹲着|蹲于|倚在|倚着|倚于|靠在|靠着|躺在|躺着|平躺|侧卧)/u.test(tail)
  const characterIds = new Set(current.characterIds), propIds = new Set(current.propIds), sceneIds = new Set<number>()
  for (const text of texts) for (const mention of text.matchAll(/@/g)) {
    const rest = text.slice(mention.index! + 1)
    const name = names.find(value => rest.startsWith(value) && (boundary(rest.slice(value.length))
      || [...records.get(value)!.values()].some(asset => asset.kind === 'character') && characterBoundary(rest.slice(value.length))))
    if (!name) continue
    const matches = records.get(name)!
    if (matches.size !== 1) continue // Same-name IDs and cross-category names are ambiguous.
    const [asset] = matches.values()
    if (asset.kind === 'character') characterIds.add(asset.id)
    else if (asset.kind === 'prop') propIds.add(asset.id)
    else sceneIds.add(asset.id)
  }
  return { characterIds: [...characterIds], propIds: [...propIds],
    sceneId: current.sceneId === null && sceneIds.size === 1 ? [...sceneIds][0] : current.sceneId }
}

const shotSchema = videoPromptPlanSchema.shape.shots.element
const rowSchema = shotSchema.shape.rows.element
const legacyDialogue = rowSchema.shape.dialogue.unwrap().in.unwrap().element
const line = rowSchema.shape.visual
const requiredVoice = legacyDialogue.shape.voice.extend({ delivery: line }).strict()
const optionalVoice = requiredVoice.nullable().transform(value => value ?? undefined).optional()

export function getScheduledShotLayout(rowCount: number): number[] {
  if (rowCount === 3) return [1, 2]
  if (rowCount === 4) return [2, 2]
  if (rowCount === 5) return [2, 2, 1]
  throw new Error('Scheduled group requires exactly 3, 4 or 5 time rows')
}

function existingId(values: Array<{ id: number }>): z.ZodType<number> {
  const ids = [...new Set(values.map(value => value.id).filter(id => Number.isSafeInteger(id) && id > 0))]
  if (!ids.length) return z.number().int().positive().refine(() => false, 'No existing asset is available')
  return z.literal(ids as [number, ...number[]])
}

function groupLayout(group: ScheduledDialogueGroup) {
  const layout = getScheduledShotLayout(group.rows.length)
  if (!Number.isSafeInteger(group.source_group) || group.source_group < 1
    || !Number.isFinite(group.duration) || group.duration < 8 || group.duration > 15
    || Math.ceil(group.duration / 3) !== group.rows.length) throw new Error('Invalid canonical scheduled group identity or duration')
  for (const ref of group.rows) if (ref && (!Number.isSafeInteger(ref.source_line) || ref.source_line < 1
    || !Number.isSafeInteger(ref.fragment_index) || ref.fragment_index < 1)) throw new Error('Invalid canonical source reference')
  return layout
}

/** Add only explicitly concealed/partial people, never an inferred face or gaze target. */
export function inferScheduledHiddenParticipants(visuals: readonly string[], declared: z.output<typeof shotSchema.shape.characters>, assets: ScheduledSegmentAssets) {
  const result = [...declared]
  const names = [...new Set(assets.characters.map(character => character.name))].filter(Boolean).sort((a, b) => b.length - a.length)
  const allAssets = [...assets.characters.map(value => ({ name: value.name, key: `c:${value.id}` })),
    ...assets.props.map(value => ({ name: value.name, key: `p:${value.id}` })), ...assets.scenes.map(value => ({ name: value.location, key: `s:${value.id}` }))]
  const negativeFace = /(?:面部|脸部|五官|眼睛|神情).{0,4}(?:不可见|无法辨|不可辨|看不清)|看不到(?:脸|面部)|(?:脸|面部).{0,4}(?:被遮|遮住)|face\s+(?:is\s+)?(?:hidden|not\s+visible)/gi
  const face = /脸|面部|五官|眉眼|眼睛|眼神|嘴角|嘴唇|下颌|神情|表情|露脸|回头|转头|抬头|抬眼|\bface\b|\beyes?\b|\bexpression\b|\bblinks?\b/i
  for (const character of assets.characters) {
    if (result.some(value => value.character_id === character.id)) continue
    if (new Set(allAssets.filter(value => value.name === character.name).map(value => value.key)).size !== 1) continue
    let seenAt = false, seen = false, safe = true
    for (const text of visuals) {
      const mentions: Array<{ name: string; index: number }> = []
      for (let index = 0; index < text.length;) {
        const name = names.find(value => text.startsWith(value, index)
          && (!/^[\p{Script=Latin}\d_ ]+$/u.test(value) || !/[\p{Script=Latin}\d_]/u.test(text[index - 1] || '')
            && !/[\p{Script=Latin}\d_]/u.test(text[index + value.length] || '')))
        if (name) { mentions.push({ name, index }); index += name.length } else index++
      }
      for (const [mentionIndex, mention] of mentions.entries()) {
        if (mention.name !== character.name) continue
        seen = true; seenAt ||= text[mention.index - 1] === '@'
        const start = Math.max(0, ...['。', '；', ';', '！', '？', '!', '?', '\n'].map(mark => text.lastIndexOf(mark, mention.index - 1) + 1),
          mentionIndex > 0 ? mentions[mentionIndex - 1].index + mentions[mentionIndex - 1].name.length : 0)
        const prefix = text.slice(start, mention.index).replace(/@\s*$/, '')
        const next = mentions[mentionIndex + 1]?.index ?? text.length
        const own = text.slice(mention.index + character.name.length, next).split(/[。；;！？!?\n]/)[0]
        const target = /(?:看向|望向|望着|看着|注视|追视|盯着|凝视|瞥向|面向|面对|(?:目光|视线).{0,8}(?:投向|落在|移向|转向))[^@，,。；;！？!?\n]{0,24}$/u.test(prefix)
          || /\b(?:looks?|gazes?|stares?)\s+(?:at|towards?)\s+[^@，,。；;！？!?\n]{0,30}$/i.test(prefix)
          || /(?:对|向)[^@，,。；;！？!?\n]{0,16}$/u.test(prefix) && /^\s*(?:低声|轻声)?(?:说|问|询问|解释)/u.test(own)
        const concealed = /^(?:的)?\s*(?:背影|背面|背对镜头)|面部不可见|看不到(?:脸|面部)|(?:脸|面部).{0,4}(?:被遮|遮住)|\bback\s+view\b|\bfrom\s+behind\b|face\s+(?:is\s+)?(?:hidden|not\s+visible)/i.test(own)
          || /(?:背影|背对镜头)(?:的)?\s*$/u.test(prefix)
        const partial = /^(?:的)?(?:手|脚|足)部特写/u.test(own)
          || /^(?:仅|只)(?:露出|露|拍到|见到|见|拍).{0,5}(?:手|脚|足)/u.test(own)
          || /(?:仅|只)(?:露出|露|拍到|见到|见|拍)|画面边缘|局部|次要落点|\bonly\b|frame\s+edge/i.test(prefix)
            && /^(?:的\s*)?(?:左|右|双)?(?:手|脚|足)|^(?:撑|扶|按|握|抓|捏|攥|托|搭|伸|垂|抬|贴|抵|扣|拽|拉|放|抖|颤)[^，,。；;！？!?@\n]{0,10}的(?:手|脚|足)|^\s*(?:'s\s*)?(?:hand|foot)\b/i.test(own)
        const preposedFace = /(?:正面|侧脸|正脸|面部|五官|神情|表情)[^，,。；;！？!?@\n]{0,12}(?:的)?\s*$/u.test(prefix)
        if (target || !(concealed || partial) || preposedFace || face.test(own.replace(negativeFace, ''))) safe = false
      }
    }
    if (seen && seenAt && safe) result.push({ character_id: character.id, visibility: 'face_hidden' })
  }
  return result
}

/** Prune copied visibility only when every explicit mention is a pure target. */
function pruneCopiedGazeParticipants(visuals: readonly string[], characters: z.output<typeof shotSchema.shape.characters>, assets: ScheduledSegmentAssets) {
  const assetsByName = [...assets.characters.map(value => ({ name: value.name, key: `c:${value.id}` })),
    ...assets.props.map(value => ({ name: value.name, key: `p:${value.id}` })), ...assets.scenes.map(value => ({ name: value.location, key: `s:${value.id}` }))]
  const names = [...new Set(assetsByName.map(value => value.name))].filter(Boolean).sort((a, b) => b.length - a.length)
  const pattern = new RegExp(names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gu')
  return characters.filter(character => {
    if (character.visibility === 'offscreen') return true
    const name = assets.characters.find(value => value.id === character.character_id)?.name
    if (!name || new Set(assetsByName.filter(value => value.name === name).map(value => value.key)).size !== 1) return true
    let mentioned = false
    for (const visual of visuals) for (const match of visual.matchAll(pattern)) {
      if (match[0] !== name) continue
      const index = match.index!
      if (/^[\p{Script=Latin}\d_ ]+$/u.test(name)
        && (/[\p{Script=Latin}\d_]/u.test(visual[index - 1] || '') || /[\p{Script=Latin}\d_]/u.test(visual[index + name.length] || ''))) continue
      mentioned = true
      const markerLength = visual[index - 1] === '@' ? 1 : 0
      if (!isReferencedTargetOnly(visual, index - markerLength, name.length, markerLength)) return true
    }
    return !mentioned
  })
}

/** A single-submit schema exposes creative fields only, never canonical time or speech. */
export function buildScheduledSegmentSchema(group: ScheduledDialogueGroup, assets: ScheduledSegmentAssets) {
  const layout = groupLayout(group)
  const character = shotSchema.shape.characters.element.extend({ character_id: existingId(assets.characters) }).strict()
  const shape: Record<string, z.ZodType> = {
    title: line,
    scene_id: existingId(assets.scenes).nullable(),
    prop_ids: z.array(existingId(assets.props)),
    atmosphere: line,
    space: line,
    voice: optionalVoice,
  }
  layout.forEach((_count, index) => {
    shape[`shot_${index + 1}`] = z.object({
      characters: z.array(character),
      visuals: z.array(line).min(1).max(2),
      voice: optionalVoice,
    }).strict()
  })
  // Inspect unexpected shot fields before discarding harmless top-level notes.
  // Keep this a ZodObject so the native tool exporter retains its object shape.
  return z.object(shape).catchall(z.unknown()).superRefine((value, context) => {
    for (const key of Object.keys(value)) if (!Object.hasOwn(shape, key)) {
      if (/^shot_\d+$/.test(key)) context.addIssue({ code: 'custom', path: [key], message: 'This shot field is outside the fixed scheduled shot layout' })
      delete value[key]
    }
    let offset = 0
    layout.forEach((_count, index) => {
      const shot = value[`shot_${index + 1}`] as { voice?: unknown; visuals: string[] }
      const count = shot.visuals.length
      const hasSource = group.rows.slice(offset, offset + count).some(Boolean)
      offset += count
      if (hasSource && !shot.voice && !value.voice) context.addIssue({
        code: 'custom', path: [`shot_${index + 1}`, 'voice'],
        message: 'A voiced shot requires its complete voice or the complete group-level voice',
      })
    })
    if (offset !== group.rows.length) context.addIssue({ code: 'custom', path: ['visuals'], message: 'The total visual rows must equal the fixed scheduled row count' })
  })
}

type ResponseSchema = Record<string, unknown>

function hasNullAlternative(value: unknown): boolean {
  if (value === true) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const schema = value as ResponseSchema
  return schema.type === 'null' || Array.isArray(schema.type) && schema.type.includes('null')
    || Array.isArray(schema.enum) && schema.enum.includes(null) || Object.hasOwn(schema, 'const') && schema.const === null
    || ['anyOf', 'oneOf'].some(key => Array.isArray(schema[key]) && schema[key].some(hasNullAlternative))
}

/** Close the wire shape without changing the more permissive local input schema. */
function strictResponseSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strictResponseSchema)
  if (!value || typeof value !== 'object') return value
  const original = value as ResponseSchema
  const schema = Object.fromEntries(Object.entries(original).filter(([key]) => key !== '$schema')
    .map(([key, child]) => [key, strictResponseSchema(child)])) as ResponseSchema
  if (schema.type === 'object' || schema.properties && typeof schema.properties === 'object') {
    const properties = (schema.properties || {}) as ResponseSchema
    const originallyRequired = new Set(Array.isArray(original.required) ? original.required : [])
    for (const [key, child] of Object.entries(properties)) {
      if (!originallyRequired.has(key) && !hasNullAlternative(child)) properties[key] = { anyOf: [child, { type: 'null' }] }
    }
    schema.properties = properties
    schema.required = Object.keys(properties)
    schema.additionalProperties = false
  }
  return schema
}

/** Strict provider output only: every field is present and creative optionals may be null. */
export function buildScheduledSegmentResponseSchema(group: ScheduledDialogueGroup, assets: ScheduledSegmentAssets,
  guide: ReturnType<typeof buildDialogueTimingGuide> = []): ResponseSchema {
  const generated = z.toJSONSchema(buildScheduledSegmentSchema(group, assets), { io: 'input', target: 'draft-7' })
  const schema = strictResponseSchema(generated) as ResponseSchema
  const properties = schema.properties as Record<string, ResponseSchema>
  if (group.rows.some(ref => ref !== null)) {
    const completeVoice = (properties.voice.anyOf as ResponseSchema[]).find(branch => branch.type === 'object')
    if (!completeVoice) throw new Error('Scheduled response voice must expose its existing complete object schema')
    properties.voice = completeVoice
  }
  const speakers = new Map(guide.map(line => [line.source_line, line.character_id]))
  let offset = 0
  getScheduledShotLayout(group.rows.length).forEach((count, index) => {
    const shotProperties = properties[`shot_${index + 1}`].properties as Record<string, ResponseSchema>
    shotProperties.visuals.minItems = count
    shotProperties.visuals.maxItems = count
    const hasKnownSpeaker = group.rows.slice(offset, offset + count).some(ref => {
      const speakerId = ref && speakers.get(ref.source_line)
      return speakerId !== undefined && assets.characters.some(character => character.id === speakerId)
    })
    // A known source voice requires an explicit person declaration, which may
    // remain offscreen. Anonymous speech and silent/environment shots need none.
    shotProperties.characters.minItems = hasKnownSpeaker ? 1 : 0
    const person = shotProperties.characters.items as ResponseSchema
    const personProperties = person.properties as Record<string, ResponseSchema>
    const emotion = (personProperties.emotion.anyOf as ResponseSchema[]).find(branch => branch.type === 'object')
    if (!emotion) throw new Error('Scheduled response emotion must expose its existing object schema')
    const visible = structuredClone(person), nonVisible = structuredClone(person)
    const visibleProperties = visible.properties as Record<string, ResponseSchema>
    const nonVisibleProperties = nonVisible.properties as Record<string, ResponseSchema>
    visibleProperties.visibility = { ...visibleProperties.visibility, enum: ['face_visible'] }
    visibleProperties.emotion = structuredClone(emotion)
    nonVisibleProperties.visibility = { ...nonVisibleProperties.visibility, enum: ['face_hidden', 'offscreen', 'uncertain'] }
    nonVisibleProperties.emotion = { type: 'null' }
    shotProperties.characters.items = { anyOf: [visible, nonVisible] }
    offset += count
  })
  return schema
}

/** Zip creative visuals with trusted source slots. All canonical values remain server-owned. */
export function compileScheduledSegment(input: unknown, group: ScheduledDialogueGroup,
  guide: ReturnType<typeof buildDialogueTimingGuide>, assets: ScheduledSegmentAssets): StoryboardCandidate {
  const layout = groupLayout(group)
  const sources = new Map(guide.map(source => [source.source_line, source]))
  const canonicalSpeakerIds = new Set<number>()
  const canonicalSpeech = new Set<string>()
  const sourceIdentities = new Set<string>()
  for (const ref of group.rows) {
    if (!ref) continue
    const source = sources.get(ref.source_line)
    const fragment = source?.fragments[ref.fragment_index - 1]
    if (!source || typeof fragment !== 'string' || !fragment.trim()) throw new Error('Canonical scheduled source line or fragment does not exist')
    canonicalSpeech.add(fragment)
    canonicalSpeech.add(source.fragments.join(''))
    if (!['dialogue', 'offscreen', 'narration'].includes(source.kind)) throw new Error('Invalid canonical source kind')
    sourceIdentities.add(JSON.stringify([ref.source_line, source.character_id ?? null, source.kind]))
    if (source.character_id !== undefined) {
      if (!assets.characters.some(character => character.id === source.character_id)) throw new Error('Canonical source speaker is not an existing character')
      canonicalSpeakerIds.add(source.character_id)
    } else if (source.kind === 'dialogue') throw new Error('Canonical on-screen dialogue has no known source speaker')
  }
  const parsed = buildScheduledSegmentSchema(group, assets).parse(input)
  const groupVoice = parsed.voice as z.output<typeof requiredVoice> | undefined
  type ShotInput = {
    characters: z.output<typeof shotSchema.shape.characters>
    visuals: string[]
    voice?: z.output<typeof requiredVoice>
  }
  let offset = 0
  const characterIds = new Set<number>()
  const scheduledShots = layout.map((_count, index) => {
    const shot = parsed[`shot_${index + 1}`] as ShotInput
    const count = shot.visuals.length
    const hasSource = group.rows.slice(offset, offset + count).some(Boolean)
    if (hasSource && !shot.voice && sourceIdentities.size !== 1) throw new Error('A group-level voice cannot be reused across mixed canonical sources or speakers')
    const effectiveVoice = shot.voice ?? groupVoice
    const rows = shot.visuals.map((visual, rowIndex) => {
      const ref = group.rows[offset + rowIndex]
      // Time labels belong to the renderer. Accept an exact echo of this
      // trusted slot without producing duplicated labels or synthetic cuts.
      const time = visual.match(/^\s*(\d+(?:\.\d+)?)\s*[-–—~～至]\s*(\d+(?:\.\d+)?)\s*(?:秒|s(?:ec(?:onds?)?)?)\s*[:：]\s*/iu)
      if (time && (Number(time[1]) !== (offset + rowIndex) * 3 || Number(time[2]) !== Math.min((offset + rowIndex + 1) * 3, group.duration))) {
        throw new Error('Visual time label conflicts with the canonical scheduled time slot')
      }
      const text = time ? visual.slice(time[0].length) : visual
      return { visual: normalizeScheduledVisual(text, [...canonicalSpeech]), ...(ref ? { dialogue: [{ source_line: ref.source_line, fragment_index: ref.fragment_index, voice: { ...effectiveVoice! } }] } : {}) }
    })
    offset += count
    const characters = inferScheduledHiddenParticipants(rows.map(row => row.visual), shot.characters, assets)
    characters.forEach(character => characterIds.add(character.character_id))
    return { shot_number: index + 1, characters, rows }
  })
  // An explicit cut already written at a later slot is a real camera boundary,
  // not another row of the previous shot. Preserve every slot, source and word.
  const shots = scheduledShots.flatMap(shot => {
    const parts = [{ ...shot, rows: [] as typeof shot.rows }]
    shot.rows.forEach((row, index) => {
      const cuts = cameraCuts(row.visual)
      if (cuts.length > 1) throw new Error(`Shot ${shot.shot_number} row ${index + 1} contains multiple positive camera cuts; preserve its source slots while correcting the camera boundaries`)
      if (index > 0 && cuts.length === 1) parts.push({ ...shot, rows: [] })
      parts.at(-1)!.rows.push(row)
    })
    return parts.length === 1 ? parts : parts.map(part => ({ ...part,
      characters: pruneCopiedGazeParticipants(part.rows.map(row => row.visual), part.characters, assets) }))
  }).map((shot, index) => ({ ...shot, shot_number: index + 1 }))
  if (shots.length < 2 || shots.length > 4) throw new Error('Explicit camera cuts require 2–4 actual shots; reduce conflicting cuts without deleting any source slots')
  canonicalSpeakerIds.forEach(id => characterIds.add(id))
  const bindings = collectScheduledReferenceBindings([parsed.space as string, ...shots.flatMap(shot => shot.rows.map(row => row.visual))], {
    characterIds: [...characterIds], propIds: parsed.prop_ids as number[], sceneId: parsed.scene_id as number | null,
  }, assets)
  return {
    shot_number: group.source_group,
    duration: group.duration,
    title: parsed.title as string,
    scene_id: bindings.sceneId,
    prop_ids: bindings.propIds,
    atmosphere: parsed.atmosphere as string,
    character_ids: bindings.characterIds,
    video_prompt_plan: { space: parsed.space as string, shots },
  }
}
