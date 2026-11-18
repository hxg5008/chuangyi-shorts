import type { NarrativeGroup, ScriptUnit, ScriptUnitSpeechBudget } from './skill-storyboard-contract.js'

export type PackedNarrativeGroup = Pick<NarrativeGroup, 'number' | 'title' | 'beat' | 'source_ids' | 'scene_id' | 'duration'>
export interface PackingCheckpoint {
  number: number
  status: string
  candidate?: unknown
  issues?: readonly unknown[]
  attempts?: number
}
export interface StoryboardModelLimits {
  maxOutputTokens?: number
  estimatedOutputTokensPerGroup?: number
  reservedOutputTokens?: number
}
export interface StoryboardRequestPack {
  groups: PackedNarrativeGroup[]
  estimatedOutputTokens: number
  reasons: string[]
}
export interface PackingAsset { id: number; [field: string]: unknown }
export interface PackingCharacter extends PackingAsset { name: string }
export interface PackingScene extends PackingAsset { location: string }
export interface PackingProp extends PackingAsset { name: string }
export interface StoryboardPackingAssets {
  characters: readonly PackingCharacter[]
  scenes: readonly PackingScene[]
  props: readonly PackingProp[]
}
export interface PreviousStoryboardBoundary {
  id?: number
  shot_number?: number
  result?: string | null
  description?: string | null
  video_prompt?: string | null
  time_row_counts?: readonly number[] | null
  character_ids?: readonly number[] | null
  prop_ids?: readonly number[] | null
  scene_id?: number | null
}

const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
const uniqueIds = (ids: readonly number[] = []) => [...new Set(ids.filter(positive))]
const projectGroup = (group: NarrativeGroup): PackedNarrativeGroup => ({ number: group.number, title: group.title, beat: group.beat,
  scene_id: group.scene_id, duration: group.duration, source_ids: [...group.source_ids] })
const numberOr = (value: number | undefined, fallback: number) => Number.isFinite(value) && value! > 0 ? value! : fallback

/** Estimates control pairing, never invent a token guarantee or reject/cut an individual group. */
export function packStoryboardRequests(input: {
  groups: readonly NarrativeGroup[]
  checkpoints?: readonly PackingCheckpoint[]
  sourceUnits: readonly ScriptUnit[]
  speechBudgets: readonly ScriptUnitSpeechBudget[]
  modelLimits?: StoryboardModelLimits
}): StoryboardRequestPack[] {
  const limit = numberOr(input.modelLimits?.maxOutputTokens, 16_384)
  // Reasoning-capable providers may spend output tokens before returning any JSON.
  // Reserve a conservative combined thinking/visible-output estimate per group.
  const perGroup = numberOr(input.modelLimits?.estimatedOutputTokensPerGroup, 12_000)
  const requestedReserve = input.modelLimits?.reservedOutputTokens
  const reserve = Number.isFinite(requestedReserve) && requestedReserve! >= 0 ? requestedReserve! : 1_024
  const checkpoints = new Map(input.checkpoints?.map(group => [group.number, group]))
  const units = new Map(input.sourceUnits.map(unit => [unit.id, unit.text]))
  const budgets = new Map(input.speechBudgets.map(budget => [budget.source_id, budget.spoken_characters]))
  const reasons = (group: NarrativeGroup) => {
    const result: string[] = [], checkpoint = checkpoints.get(group.number)
    if (checkpoint && (checkpoint.status !== 'pending' || (checkpoint.attempts ?? 0) > 0
      || checkpoint.candidate != null || Boolean(checkpoint.issues?.length))) result.push('checkpoint_boundary')
    if (group.scene_id == null) result.push('scene_unspecified')
    // Conservative complexity heuristics, not new creative requirements.
    if (group.duration >= 15) result.push('long_duration')
    if (group.source_ids.some(id => !units.has(id) || !budgets.has(id))) result.push('source_budget_unknown')
    if (uniqueIds(group.source_ids).reduce((sum, id) => sum + (budgets.get(id) ?? 0), 0) > 45) result.push('speech_over_45_characters')
    if ([...uniqueIds(group.source_ids).map(id => units.get(id) || '').join('\n')].length > 800) result.push('source_over_800_characters')
    return result
  }
  const output: StoryboardRequestPack[] = []
  for (let index = 0; index < input.groups.length; index++) {
    const group = input.groups[index]
    if (checkpoints.get(group.number)?.status === 'ready') continue
    const groupReasons = reasons(group), next = input.groups[index + 1]
    const nextReady = next && checkpoints.get(next.number)?.status === 'ready'
    const budgetAllowsPair = perGroup * 2 + reserve <= limit
    const pair = next && !nextReady && !groupReasons.length && !reasons(next).length
      && next.number === group.number + 1 && next.scene_id === group.scene_id && budgetAllowsPair
    if (pair) {
      output.push({ groups: [projectGroup(group), projectGroup(next)], estimatedOutputTokens: perGroup * 2 + reserve, reasons: ['adjacent_same_scene'] })
      index++
    } else output.push({ groups: [projectGroup(group)], estimatedOutputTokens: perGroup + reserve,
      reasons: groupReasons.length ? groupReasons : [budgetAllowsPair ? 'unpaired_boundary' : 'output_budget_single'] })
  }
  return output
}

function cloneWithoutImages(value: unknown): any {
  if (Array.isArray(value)) return value.map(cloneWithoutImages)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:image_?url|reference_?images)$/iu.test(key))
    .map(([key, entry]) => [key, cloneWithoutImages(entry)]))
}
const legalAsset = (asset: PackingAsset, name: unknown) => positive(asset.id) && typeof name === 'string' && Boolean(name.trim())
const descriptionMark = /【\s*(?:镜头|shot|ショット|컷)\s*(\d+)\s*】/giu

/** Keep the last description shot but all video context: A0/axes and fixed voices may occur earlier. */
export function compactPreviousEnding(previous?: PreviousStoryboardBoundary | null) {
  if (!previous) return null
  const description = previous.description || '', video = previous.video_prompt || ''
  const marks = [...description.matchAll(descriptionMark)]
  const validDescription = marks.length >= 2 && marks.length <= 4 && marks.every((mark, index) => Number(mark[1]) === index + 1)
  const descriptionLast = validDescription ? description.slice(marks.at(-1)!.index!) : description
  return { ...(previous.id !== undefined ? { id: previous.id } : {}), ...(previous.shot_number !== undefined ? { shot_number: previous.shot_number } : {}),
    result: previous.result || '', description_last_shot: descriptionLast, video_context: video,
    character_ids: uniqueIds(previous.character_ids || []), prop_ids: uniqueIds(previous.prop_ids || []), scene_id: previous.scene_id ?? null,
    description_boundary: validDescription ? 'last_marked_shot' : 'full_fallback', video_boundary: 'full_for_spatial_voice_continuity' as const }
}

function literalIds(rows: readonly (PackingCharacter | PackingProp)[], units: readonly ScriptUnit[]) {
  return rows.filter(row => units.some(unit => unit.text.includes(row.name))).map(row => row.id)
}

/** Scope facts only, never infer bindings or resolve pronouns/aliases into an asset ID. */
function sourceScope(rows: readonly (PackingCharacter | PackingProp)[], units: readonly ScriptUnit[], kind: 'characters' | 'props') {
  const literal = uniqueIds(literalIds(rows, units)), names = rows.map(row => row.name)
  if (!rows.length) return { ids: [], mode: 'literal_and_previous' as const, reason: 'empty_catalog' }
  if (!units.length || units.some(unit => !names.some(name => unit.text.includes(name)))) return { ids: rows.map(row => row.id), mode: 'all_fallback' as const, reason: 'source_not_explicit_for_every_unit' }
  if (new Set(names).size !== names.length) return { ids: rows.map(row => row.id), mode: 'all_fallback' as const, reason: 'ambiguous_formal_names' }
  let remaining = units.map(unit => unit.text).join('\n')
  for (const name of [...names].sort((a, b) => b.length - a.length)) remaining = remaining.split(name).join(' ')
  const ambiguous = kind === 'characters'
    ? /他|她|他们|她们|其|对方|老人|男人|女人|孩子|众人|某人|父亲|母亲|爸爸|妈妈|妻子|丈夫|儿子|女儿|哥哥|姐姐|弟弟|妹妹|\b(?:he|she|they|him|her|his|their|someone|mother|father)\b|[ぁ-んァ-ン가-힣]/iu
    : /它|其|这个|那个|这件|那件|手中|手里|原物|东西|物件|\b(?:it|its|this|that|something)\b|[ぁ-んァ-ン가-힣]/iu
  if (ambiguous.test(remaining)) return { ids: rows.map(row => row.id), mode: 'all_fallback' as const, reason: 'unresolved_source_reference' }
  return { ids: literal, mode: 'literal_and_previous' as const, reason: 'explicit_formal_names' }
}

/** No whole-script input: each requested original source unit appears once, unchanged. */
export function buildPackedExpandContext(input: {
  plan: { groups: readonly NarrativeGroup[] }
  groups: readonly NarrativeGroup[]
  sourceUnits: readonly ScriptUnit[]
  speechBudgets: readonly ScriptUnitSpeechBudget[]
  assets: StoryboardPackingAssets
  previous?: PreviousStoryboardBoundary | null
  episode?: unknown
  projectStyle?: string
}) {
  const requested = new Set(input.groups.flatMap(group => group.source_ids))
  const sourceUnits: ScriptUnit[] = [], seen = new Set<number>()
  for (const unit of input.sourceUnits) if (requested.has(unit.id)) {
    if (seen.has(unit.id)) throw new Error(`原文来源ID ${unit.id}重复，无法无损选择。`)
    seen.add(unit.id); sourceUnits.push({ id: unit.id, text: unit.text })
  }
  for (const id of requested) if (!seen.has(id)) throw new Error(`缺少原文来源ID ${id}，不能省略原文后请求创作。`)
  const characters = input.assets.characters.filter(row => legalAsset(row, row.name))
  const scenes = input.assets.scenes.filter(row => legalAsset(row, row.location))
  const props = input.assets.props.filter(row => legalAsset(row, row.name))
  const previous = compactPreviousEnding(input.previous)
  const characterScope = sourceScope(characters, sourceUnits, 'characters'), propScope = sourceScope(props, sourceUnits, 'props')
  const characterIds = new Set([...characterScope.ids, ...(previous?.character_ids || [])])
  const propIds = new Set([...propScope.ids, ...(previous?.prop_ids || [])])
  const sceneIds = new Set(input.groups.map(group => group.scene_id).filter(positive))
  return {
    ...(input.episode !== undefined ? { episode: cloneWithoutImages(input.episode) } : {}),
    ...(input.projectStyle !== undefined ? { project_style: input.projectStyle } : {}),
    approved_plan: { groups: input.plan.groups.map(projectGroup) }, current_groups: input.groups.map(projectGroup),
    source_units: sourceUnits,
    source_speech_budgets: input.speechBudgets.filter(budget => requested.has(budget.source_id)).map(budget => ({
      source_id: budget.source_id, spoken_characters: budget.spoken_characters, minimum_speech_seconds: budget.minimum_speech_seconds,
      utterances: budget.utterances.map((utterance, index) => ({ utterance_index: index + 1, speaker: utterance.speaker, kind: utterance.kind, characters: utterance.characters })),
    })),
    asset_catalog: {
      characters: characters.map(row => ({ id: row.id, name: row.name, has_voice: typeof row.has_voice === 'boolean' ? row.has_voice : null,
        voice_reference: typeof row.voice_reference === 'string' ? row.voice_reference : typeof row.voice_ref === 'string' ? row.voice_ref : null })),
      scenes: scenes.map(row => ({ id: row.id, location: row.location, ...(row.time !== undefined ? { time: cloneWithoutImages(row.time) } : {}) })),
      props: props.map(row => ({ id: row.id, name: row.name })),
    },
    asset_facts: { characters: characters.filter(row => characterIds.has(row.id)).map(cloneWithoutImages),
      scenes: scenes.filter(row => sceneIds.has(row.id)).map(cloneWithoutImages), props: props.filter(row => propIds.has(row.id)).map(cloneWithoutImages) },
    fact_scope: { characters: characterScope.mode, props: propScope.mode, character_reason: characterScope.reason, prop_reason: propScope.reason },
    previous_ending: previous,
  }
}
