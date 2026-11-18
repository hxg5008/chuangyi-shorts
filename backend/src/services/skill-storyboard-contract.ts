import { z } from 'zod'
import { extractScriptDialogue } from './script-dialogue.js'
import type { ValidationIssue } from './storyboard-validation.js'
import { sharedLineSplitConflict } from './storyboard-shared-lines.js'
import { allowedBeatMinimum, groupContentSeconds, productionNoteIds } from './storyboard-rhythm.js'
import { analyzeScriptBody } from './script-body-budget.js'

export interface StoryboardContractAssets {
  characters: Array<{ id: number; name: string }>
  scenes: Array<{ id: number; location: string; time?: string | null }>
  props: Array<{ id: number; name: string }>
}
export interface ScriptUnit { id: number; text: string }
export interface NarrativeGroup {
  number: number
  title: string
  beat: 'transition' | 'narrative' | 'climax'
  source_ids: number[]
  scene_id: number | null
  duration: number
  /** Historical advisory input only; a new narrative plan never locks this value. */
  shot_count?: number
}
export interface NarrativePlan { groups: NarrativeGroup[] }
export interface ScriptUnitSpeechBudget {
  source_id: number
  spoken_characters: number
  minimum_speech_seconds: number
  utterances: Array<{ speaker: string | null; kind: 'dialogue' | 'offscreen' | 'narration'; text: string; characters: number }>
}
export interface SpeechCapacityConflict {
  source_ids: number[]
  group_numbers: number[]
  demand_characters: number
  capacity_characters: number
  deficit_characters: number
  units: Array<{ source_id: number; spoken_characters: number; group_numbers: number[] }>
  groups: Array<{ number: number; duration: number; capacity_characters: number }>
}
export interface SpeechCapacityAnalysis {
  feasible: boolean
  total_demand_characters: number
  assigned_characters: number
  conflicts: SpeechCapacityConflict[]
}
export interface NarrativePlanIssue extends ValidationIssue { capacity?: SpeechCapacityConflict }

const text = z.string().min(1).refine(value => Boolean(value.trim()), 'Must contain meaningful text')
const beatLimits = { transition: [8, 10], narrative: [10, 15], climax: [12, 15] } as const
const proseFields = ['title', 'time', 'location', 'shot_type', 'angle', 'movement', 'description', 'result', 'atmosphere', 'image_prompt', 'video_prompt', 'bgm_prompt', 'sound_effect'] as const
const issue = (field: string, code: string, message: string, severity: 'error' | 'warning' = 'error'): ValidationIssue => ({ field, code, message, severity })
const distinct = (ids: number[]) => [...new Set(ids)]

/** Lines are source units, not program-chosen narrative groups or dialogue fragments. */
export function splitScriptUnits(script: string): ScriptUnit[] {
  return script.split(/\r\n|\n|\r/).filter(line => Boolean(line.trim())).map((line, index) => ({ id: index + 1, text: line }))
}

export function scriptTimingBudget(script: string) {
  // 2026-11-16: count screenplay body only, keeping the established Unicode
  // letter/number convention. Source text and its line IDs remain untouched.
  const { characters } = analyzeScriptBody(script)
  const targetSeconds = characters / 500 * 60
  return { characters, charactersPerMinute: 500, targetSeconds, minimumSeconds: targetSeconds * 0.8, maximumSeconds: targetSeconds * 1.2 }
}

/**
 * The skill constrains both total seconds and the number of narrative groups.
 * Keep the unrounded estimate as the tolerance anchor: rounding it first can
 * accidentally admit a group outside the requested +/-20% interval.
 * Very short scripts can have no positive integer inside that interval. Only
 * in that case use the nearest positive integer; duration/source checks still
 * decide whether that one group is actually feasible.
 */
export function storyboardGroupBudget(script: string) {
  const estimatedGroups = scriptTimingBudget(script).targetSeconds / 12
  const preferredGroupCount = Math.max(1, Math.round(estimatedGroups))
  const rawMinimumGroups = estimatedGroups * 0.8, rawMaximumGroups = estimatedGroups * 1.2
  const minimum = Math.max(1, Math.ceil(rawMinimumGroups - 1e-8))
  const maximum = Math.floor(rawMaximumGroups + 1e-8)
  const integerFallback = minimum > maximum
  return {
    estimatedGroups, preferredGroupCount, rawMinimumGroups, rawMaximumGroups,
    minimumGroups: integerFallback ? preferredGroupCount : minimum,
    maximumGroups: integerFallback ? preferredGroupCount : maximum,
    integerFallback,
  }
}
/**
 * Round 3 (2026-11-08, user-approved): a whole-episode total may exceed the ±20% upper bound by less than one second
 * (real case: the shortest legal grouping needed 62.45 s against 62.06 s). Every group still obeys 8–15 s and its own
 * speech budget; this only stops a run over a fraction of a second.
 */
export const TOTAL_DURATION_TOLERANCE_SECONDS = 1
export function scriptTimingTarget(script: string): number { return scriptTimingBudget(script).targetSeconds }

/** Original recognizable utterances and arithmetic only; never split or group speech. */
export function buildScriptUnitSpeechBudgets(units: readonly ScriptUnit[], assets: Pick<StoryboardContractAssets, 'characters'>): ScriptUnitSpeechBudget[] {
  const names = assets.characters.map(character => character.name)
  const excluded = new Set(analyzeScriptBody(units.map(unit => unit.text).join('\n')).excludedSourceIds)
  return units.map((unit, index) => {
    const utterances = (excluded.has(index + 1) ? [] : extractScriptDialogue(unit.text, names)).map(speech => ({
      speaker: speech.speakerName ?? null, kind: speech.kind, text: speech.text,
      characters: [...speech.text].filter(character => /[\p{L}\p{N}]/u.test(character)).length,
    }))
    const spoken_characters = utterances.reduce((sum, speech) => sum + speech.characters, 0)
    return { source_id: unit.id, spoken_characters, minimum_speech_seconds: spoken_characters / 4.5, utterances }
  })
}

function idSchema(values: Array<{ id: number }>): z.ZodType<number> {
  const ids = distinct(values.map(value => value.id).filter(id => Number.isSafeInteger(id) && id > 0))
  return ids.length ? z.literal(ids as [number, ...number[]]) : z.number().int().positive().refine(() => false, 'No available asset ID')
}
function sceneSchema(assets: StoryboardContractAssets): z.ZodType<number | null> {
  return assets.scenes.length ? idSchema(assets.scenes).nullable() : z.null()
}
function assetIdArray(values: Array<{ id: number }>) {
  return values.some(value => Number.isSafeInteger(value.id) && value.id > 0)
    ? z.array(idSchema(values)) : z.array(z.number().int().positive()).max(0)
}

/** Invalid catalog data blocks execution; names become ambiguous only within a used scope. */
export function validateStoryboardAssets(assets: StoryboardContractAssets): ValidationIssue[] {
  const issues: ValidationIssue[] = [], names = new Map<string, string>()
  const catalogs = [
    ['characters', assets.characters.map(value => ({ id: value.id, name: value.name, time: undefined }))],
    ['scenes', assets.scenes.map(value => ({ id: value.id, name: value.location, time: value.time }))],
    ['props', assets.props.map(value => ({ id: value.id, name: value.name, time: undefined }))],
  ] as const
  for (const [kind, rows] of catalogs) {
    const ids = new Set<number>()
    for (const [index, row] of rows.entries()) {
      const field = `assets.${kind}.${index}`
      if (!Number.isSafeInteger(row.id) || row.id < 1) issues.push(issue(`${field}.id`, 'asset_invalid_id', '素材ID必须是正整数。'))
      else if (ids.has(row.id)) issues.push(issue(`${field}.id`, 'asset_id_ambiguous', `${kind} 中ID ${row.id}重复，须先整理素材目录。`))
      ids.add(row.id)
      if (typeof row.name !== 'string' || !row.name.trim()) { issues.push(issue(`${field}.name`, 'asset_name_missing', '素材缺少正式名称。')); continue }
      if (row.name !== row.name.trim() || /[@\r\n]|\[\[|\]\]/u.test(row.name)) issues.push(issue(`${field}.name`, 'asset_name_invalid', '正式素材名不能有首尾空白、换行或引用协议标记。'))
      const label = `${kind} ID ${row.id}${row.time ? `（time ${row.time}）` : ''}`
      const previous = names.get(row.name)
      if (previous) issues.push(issue(`${field}.name`, 'asset_name_ambiguous', `目录正式名“${row.name}”由 ${previous} 与 ${label} 共用；可按typed ID选择其一，同组实际使用重名的不同素材时才需处理歧义。`, 'warning'))
      else names.set(row.name, label)
    }
  }
  return issues
}

export function buildNarrativePlanSchema(assets: StoryboardContractAssets, sourceUnits: ScriptUnit[]) {
  const sourceId = idSchema(sourceUnits)
  return z.object({ groups: z.array(z.object({
    number: z.number().int().positive(), title: text,
    beat: z.enum(['transition', 'narrative', 'climax']),
    source_ids: z.array(sourceId).min(1), scene_id: sceneSchema(assets),
    duration: z.number().min(8).max(15),
  }).strip()).min(1) }).strict()
}

/** Full prose is required; this contract never truncates or renders creative content. */
export function buildCompleteStoryboardSchema(assets: StoryboardContractAssets) {
  return z.object({
    shot_number: z.number().int().positive(), title: text, time: text, location: text,
    shot_type: text, angle: text, movement: text, description: text, result: text,
    atmosphere: text, image_prompt: text, video_prompt: text.max(3600), bgm_prompt: text, sound_effect: text,
    duration: z.number().min(8).max(15), scene_id: sceneSchema(assets),
    character_ids: assetIdArray(assets.characters), prop_ids: assetIdArray(assets.props),
    source_ids: z.array(z.number().int().positive()).min(1),
    time_row_counts: z.array(z.union([z.literal(1), z.literal(2)])).min(2).max(4),
  }).strict().superRefine((value, context) => {
    if (value.time_row_counts.reduce((sum, count) => sum + count, 0) !== Math.ceil(value.duration / 3)) context.addIssue({
      code: 'custom', path: ['time_row_counts'], message: 'Time-row counts must sum to ceil(duration / 3); the program does not change the shot layout',
    })
  })
}
export type CompleteStoryboard = z.output<ReturnType<typeof buildCompleteStoryboardSchema>>
export interface CompiledStoryboardReferences {
  candidate: CompleteStoryboard | null
  preview?: CompleteStoryboard | null
  issues: ValidationIssue[]
}

interface ProseSegment { text: string; quoted: boolean; offset: number }
function quotedSegments(value: string, field: string, issues: ValidationIssue[]): ProseSegment[] {
  const pairs: Record<string, string> = { '「': '」', '『': '』', '“': '”', '‘': '’', '"': '"', "'": "'" }
  const word = (character = '') => /[\p{Script=Latin}\p{N}]/u.test(character)
  const segments: ProseSegment[] = []
  let from = 0
  for (let index = 0; index < value.length; index++) {
    const close = pairs[value[index]]
    if (!close || value[index] === "'" && word(value[index - 1]) && word(value[index + 1])) continue
    let end = index + 1
    for (; end < value.length; end++) {
      if (value[end] === '\\') { end++; continue }
      if (value[end] === close && !(close === "'" && word(value[end - 1]) && word(value[end + 1]))) break
    }
    if (end === value.length) {
      issues.push(issue(field, 'reference_quote_unclosed', `${field} 第${index + 1}字符处引号未闭合；未解释或修改引号后原文。`))
      if (index > from) segments.push({ text: value.slice(from, index), quoted: false, offset: from })
      segments.push({ text: value.slice(index), quoted: true, offset: index })
      from = value.length
      break
    }
    if (index > from) segments.push({ text: value.slice(from, index), quoted: false, offset: from })
    segments.push({ text: value.slice(index, end + 1), quoted: true, offset: index })
    from = end + 1; index = end
  }
  if (from < value.length) segments.push({ text: value.slice(from), quoted: false, offset: from })
  return segments
}

/** Compile exact typed references only. Quoted original words remain byte-for-byte intact. */
export function compileStoryboardReferences(input: unknown, assets: StoryboardContractAssets): CompiledStoryboardReferences {
  const issues = validateStoryboardAssets(assets)
  if (input && typeof input === 'object') {
    const selected = input as Record<string, unknown>
    for (const [field, catalog] of [['character_ids', assets.characters], ['prop_ids', assets.props]] as const) {
      const values = selected[field]
      if (Array.isArray(values)) values.forEach((id, index) => {
        if (Number.isSafeInteger(id) && !catalog.some(asset => asset.id === id)) issues.push(issue(`${field}.${index}`, 'reference_unknown_id', `${field}.${index} 的素材ID ${id} 不在可用列表中。`))
      })
    }
    if (Number.isSafeInteger(selected.scene_id) && !assets.scenes.some(asset => asset.id === selected.scene_id)) issues.push(issue('scene_id', 'reference_unknown_id', `scene_id 的素材ID ${selected.scene_id} 不在可用场景列表中。`))
  }
  const parsed = buildCompleteStoryboardSchema(assets).safeParse(input)
  if (!parsed.success) {
    for (const error of parsed.error.issues) issues.push(issue(error.path.join('.'), 'storyboard_schema', `完整分镜字段无效：${error.path.join('.')} (${error.message})`))
    return { candidate: null, preview: null, issues }
  }
  if (issues.some(value => value.severity === 'error')) return { candidate: null, preview: structuredClone(parsed.data), issues }
  const candidate = structuredClone(parsed.data)
  const catalogs = {
    character: new Map(assets.characters.map(value => [value.id, value.name])),
    scene: new Map(assets.scenes.map(value => [value.id, value.location])),
    prop: new Map(assets.props.map(value => [value.id, value.name])),
  }
  const characterIds = new Set(candidate.character_ids), propIds = new Set(candidate.prop_ids), sceneIds = new Set<number>()
  for (const field of proseFields) candidate[field] = quotedSegments(candidate[field], field, issues).map(segment => {
    if (segment.quoted) return segment.text
    for (const match of segment.text.matchAll(/@/g)) issues.push(issue(field, 'reference_token_required', `${field} 第${segment.offset + match.index! + 1}字符有自由@引用；请使用精确[[character:ID]]、[[scene:ID]]或[[prop:ID]]，不要手写素材名。`))
    const transformed = segment.text.replace(/\[\[([\s\S]*?)\]\]/g, (raw: string, body: string, offset: number) => {
      const token = /^(character|scene|prop):([1-9]\d*)$/.exec(body)
      if (!token || !Number.isSafeInteger(Number(token[2]))) { issues.push(issue(field, 'reference_token_invalid', `${field} 第${segment.offset + offset + 1}字符的素材token格式无效。`)); return raw }
      const kind = token[1] as keyof typeof catalogs, id = Number(token[2]), name = catalogs[kind].get(id)
      if (!name) { issues.push(issue(field, 'reference_unknown_id', `${field} 的 [[${kind}:${id}]] 不在可用${kind}素材ID列表中。`)); return raw }
      if (kind === 'character') characterIds.add(id)
      else if (kind === 'prop') propIds.add(id)
      else sceneIds.add(id)
      return `@${name}`
    })
    const withoutTokens = segment.text.replace(/\[\[[\s\S]*?\]\]/g, '')
    if (/\[\[|\]\]/.test(withoutTokens)) issues.push(issue(field, 'reference_token_invalid', `${field} 含未闭合或多余的素材token括号。`))
    return transformed
  }).join('')
  if (sceneIds.size > 1) issues.push(issue('scene_id', 'reference_scene_conflict', `同组正文引用多个场景ID：${[...sceneIds].join(', ')}；必须分组，程序不会替换计划场景。`))
  else if (sceneIds.size === 1 && !sceneIds.has(candidate.scene_id!)) issues.push(issue('scene_id', 'reference_scene_conflict', `正文场景token ID ${[...sceneIds][0]} 与已选scene_id ${candidate.scene_id === null ? 'null' : candidate.scene_id}不一致；程序不会悄悄更换。`))
  const usedNames = new Map<string, string>()
  const register = (kind: keyof typeof catalogs, id: number, field: string) => {
    const name = catalogs[kind].get(id)
    if (!name) return
    const identity = `${kind}:${id}`, previous = usedNames.get(name)
    if (previous && previous !== identity) issues.push(issue(field, 'reference_name_ambiguous', `本组实际使用的 ${previous} 与 ${identity} 均编译为 @${name}，无法唯一匹配参考素材；请只绑定所需ID或先区分正式名称。`))
    else usedNames.set(name, identity)
  }
  characterIds.forEach(id => register('character', id, 'character_ids'))
  propIds.forEach(id => register('prop', id, 'prop_ids'))
  const usedScenes = new Set(sceneIds)
  if (candidate.scene_id !== null) usedScenes.add(candidate.scene_id)
  usedScenes.forEach(id => register('scene', id, 'scene_id'))
  if (candidate.video_prompt.length > 3600) issues.push(issue('video_prompt', 'storyboard_prompt_length', '正式素材名编译后video_prompt超过3600字符；须精简重复正文，程序不会裁剪原词或画面。'))
  candidate.character_ids = [...characterIds]; candidate.prop_ids = [...propIds]
  return { candidate: issues.some(value => value.severity === 'error') ? null : candidate, preview: structuredClone(candidate), issues }
}

/** Necessary capacity feasibility and residual bottlenecks; never choose dialogue splits. */
export function analyzeNarrativeSpeechCapacity(groups: readonly NarrativeGroup[], budgets: readonly ScriptUnitSpeechBudget[]): SpeechCapacityAnalysis {
  const demands = budgets.map(unit => unit.spoken_characters)
  const totalDemand = demands.reduce((sum, demand) => sum + demand, 0)
  const capacities = groups.map(group => Number.isFinite(group.duration) ? Math.max(0, Math.floor((group.duration - 2) * 4.5 + 1e-8)) : 0)
  const source = 0, unitStart = 1, groupStart = unitStart + demands.length, sink = groupStart + groups.length
  const edges: Array<Array<{ to: number; capacity: number; reverse: number }>> = Array.from({ length: sink + 1 }, () => [])
  const add = (from: number, to: number, capacity: number) => {
    edges[from].push({ to, capacity, reverse: edges[to].length })
    edges[to].push({ to: from, capacity: 0, reverse: edges[from].length - 1 })
  }
  demands.forEach((demand, index) => {
    add(source, unitStart + index, demand)
    // Above the total flow, so a residual cut cannot arbitrarily isolate an
    // allowed group from its source-unit set and misstate shared capacity.
    groups.forEach((group, groupIndex) => { if (group.source_ids.includes(budgets[index].source_id)) add(unitStart + index, groupStart + groupIndex, totalDemand + 1) })
  })
  groups.forEach((_group, index) => add(groupStart + index, sink, capacities[index]))
  let flow = 0
  for (;;) {
    const previous: Array<{ node: number; edge: number } | undefined> = Array(sink + 1), queue = [source]
    previous[source] = { node: -1, edge: -1 }
    for (let cursor = 0; cursor < queue.length && !previous[sink]; cursor++) {
      const node = queue[cursor]
      edges[node].forEach((edge, edgeIndex) => { if (edge.capacity > 0 && !previous[edge.to]) { previous[edge.to] = { node, edge: edgeIndex }; queue.push(edge.to) } })
    }
    if (!previous[sink]) break
    let amount = Infinity
    for (let node = sink; node !== source;) { const prior = previous[node]!; amount = Math.min(amount, edges[prior.node][prior.edge].capacity); node = prior.node }
    for (let node = sink; node !== source;) { const prior = previous[node]!, edge = edges[prior.node][prior.edge]; edge.capacity -= amount; edges[node][edge.reverse].capacity += amount; node = prior.node }
    flow += amount
  }
  const reachable = new Set([source]), queue = [source]
  for (let cursor = 0; cursor < queue.length; cursor++) for (const edge of edges[queue[cursor]]) {
    if (edge.capacity > 0 && !reachable.has(edge.to)) { reachable.add(edge.to); queue.push(edge.to) }
  }
  const pending = new Set(demands.map((_demand, index) => index).filter(index => reachable.has(unitStart + index)))
  const conflicts: SpeechCapacityConflict[] = []
  while (pending.size) {
    const first = pending.values().next().value!
    const unitIndexes = new Set([first]), groupIndexes = new Set<number>(), unitsToVisit = [first]
    pending.delete(first)
    for (let cursor = 0; cursor < unitsToVisit.length; cursor++) {
      const unitIndex = unitsToVisit[cursor]
      groups.forEach((group, groupIndex) => {
        if (!group.source_ids.includes(budgets[unitIndex].source_id) || groupIndexes.has(groupIndex)) return
        groupIndexes.add(groupIndex)
        for (const next of [...pending]) if (group.source_ids.includes(budgets[next].source_id)) {
          pending.delete(next); unitIndexes.add(next); unitsToVisit.push(next)
        }
      })
    }
    const selectedUnits = [...unitIndexes].sort((a, b) => a - b), selectedGroups = [...groupIndexes].sort((a, b) => a - b)
    const demand = selectedUnits.reduce((sum, index) => sum + demands[index], 0), capacity = selectedGroups.reduce((sum, index) => sum + capacities[index], 0)
    if (demand > capacity) conflicts.push({
      source_ids: selectedUnits.map(index => budgets[index].source_id), group_numbers: selectedGroups.map(index => groups[index].number),
      demand_characters: demand, capacity_characters: capacity, deficit_characters: demand - capacity,
      units: selectedUnits.map(index => ({ source_id: budgets[index].source_id, spoken_characters: demands[index],
        group_numbers: groups.filter(group => group.source_ids.includes(budgets[index].source_id)).map(group => group.number) })),
      groups: selectedGroups.map(index => ({ number: groups[index].number, duration: groups[index].duration, capacity_characters: capacities[index] })),
    })
  }
  return { feasible: flow >= totalDemand, total_demand_characters: totalDemand, assigned_characters: flow, conflicts }
}

/** Source coverage proves attribution and order, not semantic completeness of the prose. */
export function validateNarrativePlan(input: unknown, units: ScriptUnit[], assets: StoryboardContractAssets, script: string): NarrativePlanIssue[] {
  const issues: NarrativePlanIssue[] = validateStoryboardAssets(assets)
  if (!units.length) issues.push(issue('source_ids', 'script_missing', '没有可规划的原文单元，不能生成分镜。'))
  if (JSON.stringify(units) !== JSON.stringify(splitScriptUnits(script))) issues.push(issue('source_ids', 'source_units_conflict', '原文单元与当前剧本不一致，请重新读取；程序不会丢弃或重写原文。'))
  const parsed = buildNarrativePlanSchema(assets, units).safeParse(input)
  if (!parsed.success) {
    for (const error of parsed.error.issues) issues.push(issue(error.path.join('.'), 'narrative_plan_schema', `叙事规划字段无效：${error.path.join('.')} (${error.message})`))
    return issues
  }
  const groups = parsed.data.groups
  const covered = new Set<number>()
  let lastSource = 0
  const speechBudgets = buildScriptUnitSpeechBudgets(units, assets)
  const notes = new Set([...productionNoteIds(units), ...analyzeScriptBody(script).excludedSourceIds])
  const sourceOf = (id: number) => ({ text: units.find(unit => unit.id === id)?.text, spoken: speechBudgets.find(budget => budget.source_id === id)?.spoken_characters, unperformed: notes.has(id) })
  for (const [index, group] of groups.entries()) {
    const field = `groups.${index}`
    if (group.number !== index + 1) issues.push(issue(`${field}.number`, 'narrative_group_order', '分组编号须从1连续递增，不自动补组或重排。'))
    const [nominal, maximum] = beatLimits[group.beat]
    // Light groups may be up to 2 s shorter than the beat minimum (never below 8 s); see storyboard-rhythm.ts.
    const minimum = allowedBeatMinimum(group.beat, groupContentSeconds(group.source_ids, sourceOf))
    if (group.duration < minimum || group.duration > maximum) issues.push(issue(`${field}.duration`, 'constraint_conflict', `${group.beat}节拍要求${minimum}–${maximum}秒${minimum < nominal ? `（本组台词与动作少，已比节拍下限${nominal}秒放宽2秒）` : ''}，当前${group.duration}秒；应由创作者调整节拍或分组。`))
    if (new Set(group.source_ids).size !== group.source_ids.length) issues.push(issue(`${field}.source_ids`, 'source_duplicate', '同一组的原文ID不得重复；长段跨连续组时可重复引用该原文ID。'))
    for (const id of group.source_ids) {
      if (id < lastSource) issues.push(issue(`${field}.source_ids`, 'source_order', `原文ID ${id}逆序，不能把较晚内容移到前面。`))
      lastSource = id; covered.add(id)
    }
  }
  const missing = units.filter(unit => !covered.has(unit.id)).map(unit => unit.id)
  if (missing.length) issues.push(issue('groups', 'source_coverage', `未覆盖原文单元ID：${missing.join(', ')}；动作、无台词段和收尾同样必须规划。`))
  const budget = scriptTimingBudget(script), total = groups.reduce((sum, group) => sum + group.duration, 0)
  const groupBudget = storyboardGroupBudget(script)
  if (groups.length < groupBudget.minimumGroups || groups.length > groupBudget.maximumGroups) {
    issues.push(issue('groups', 'narrative_group_count', `按剧本正文${budget.characters}字、500字/分钟估算，目标${budget.targetSeconds.toFixed(2)}秒，预计${groupBudget.estimatedGroups.toFixed(2)}组，建议${groupBudget.preferredGroupCount}组，允许${groupBudget.minimumGroups}–${groupBudget.maximumGroups}组；当前${groups.length}组。总时长合格不能代替组数检查。请保留全部原文动作与台词重新规划；不能通过删词、提速或遗漏内容凑组数。`))
  }
  // Same message as the original; the tolerance only changes the verdict for a total less than 1 s over the upper bound.
  if (total < budget.minimumSeconds - 1e-8 || total > budget.maximumSeconds + TOTAL_DURATION_TOLERANCE_SECONDS - 1e-8) issues.push(issue('groups', 'constraint_conflict', `按剧本正文${budget.characters}字、500字/分钟估算，目标${budget.targetSeconds.toFixed(2)}秒，允许${budget.minimumSeconds.toFixed(2)}–${budget.maximumSeconds.toFixed(2)}秒；当前${total}秒。不能为通过检查删台词或动作。`))
  const capacity = analyzeNarrativeSpeechCapacity(groups, speechBudgets)
  for (const conflict of capacity.conflicts) issues.push({
    ...issue('groups', 'constraint_conflict', `原文来源集合[${conflict.source_ids.join(', ')}]的可识别对白共${conflict.demand_characters}字，只能分配到组[${conflict.group_numbers.join(', ') || '无'}]；这些组按4.5字/秒、每组2秒表演余量合计容纳${conflict.capacity_characters}字，缺${conflict.deficit_characters}字。请调整该集合的组归属、时长或自然分句；这是共享容量缺口，不表示每条原句分别超限，程序不会切片、提速或删词。`),
    capacity: conflict,
  })
  // A capacity that only works by cutting a shared line mid-word is not usable:
  // shared lines are split only at punctuation that already exists in the original.
  // A shared line without any usable punctuation keeps the original behaviour.
  if (capacity.feasible && sharedLineSplitConflict(groups, speechBudgets)) {
    issues.push(issue('groups', 'constraint_conflict', `相邻组共享的原文对白无法在原有标点处切分后放进各组容量（4.5字/秒、每组2秒表演余量）。请调整共享原文的组归属或各组时长，使每段共享对白能在原有句号、问号、逗号等处分给相邻两组；程序不会在词语中间切分、提速或删词。`))
  }
  issues.push(issue('groups', 'semantic_review_required', '原文ID覆盖和容量可行不证明正文完整：主要动作、因果链、台词自然分句、人物表演及结尾结果仍须按skill审稿。', 'warning'))
  return issues
}
