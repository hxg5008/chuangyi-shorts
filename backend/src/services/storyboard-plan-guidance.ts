import { scriptTimingBudget, storyboardGroupBudget, splitScriptUnits, TOTAL_DURATION_TOLERANCE_SECONDS } from './skill-storyboard-contract.js'
import { allowedBeatMinimum, groupContentSeconds, productionNoteIds } from './storyboard-rhythm.js'
import { analyzeScriptBody } from './script-body-budget.js'

const beatLimits = { transition: [8, 10], narrative: [10, 15], climax: [12, 15] } as const
const epsilon = 1e-8
type Beat = keyof typeof beatLimits
interface PlanningGuidanceInput {
  plan?: unknown
  script?: unknown
  speechBudgets?: unknown
  issues?: unknown
}
interface GuidanceGroup {
  number: number
  beat: Beat
  duration: number
  source_ids: number[]
  beat_minimum_seconds: number
  beat_maximum_seconds: number
  exclusive_spoken_characters: number
  minimum_seconds_for_exclusive_speech: number
  minimum_seconds_without_regrouping: number
  requires_source_redistribution: boolean
}
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const finiteNonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** Arithmetic for model replanning only: does not select groups, split words, or change the validator. */
export function buildStoryboardPlanningConstraints(input?: PlanningGuidanceInput | null) {
  const script = typeof input?.script === 'string' ? input.script : ''
  const timing = scriptTimingBudget(script)
  const groupBudget = storyboardGroupBudget(script)
  const rawGroups = input?.plan && typeof input.plan === 'object' && Array.isArray((input.plan as any).groups)
    ? (input.plan as any).groups as unknown[] : []
  let malformed = !rawGroups.length
  const groups: Array<{ number: number; beat: Beat; duration: number; source_ids: number[] }> = []
  for (const raw of rawGroups) {
    const group = raw as Record<string, unknown> | null
    if (!group || typeof group !== 'object' || !positiveInteger(group.number)
      || typeof group.beat !== 'string' || !Object.hasOwn(beatLimits, group.beat)
      || !finiteNonnegative(group.duration) || !Array.isArray(group.source_ids)) {
      malformed = true; continue
    }
    const sourceIds = group.source_ids.filter(positiveInteger)
    if (sourceIds.length !== group.source_ids.length || !sourceIds.length) malformed = true
    groups.push({ number: group.number, beat: group.beat as Beat, duration: group.duration, source_ids: sourceIds })
  }
  // An ID repeated inside a group is still owned by only that one group. Shared
  // sources have no invented per-group allocation; min-cut diagnostics carry them.
  const owners = new Map<number, Set<number>>()
  groups.forEach((group, index) => {
    for (const id of new Set(group.source_ids)) {
      const indexes = owners.get(id) || new Set<number>()
      indexes.add(index); owners.set(id, indexes)
    }
  })
  const spokenBySource = new Map<number, number>()
  for (const raw of Array.isArray(input?.speechBudgets) ? input.speechBudgets : []) {
    if (!raw || typeof raw !== 'object' || !positiveInteger(raw.source_id) || !finiteNonnegative(raw.spoken_characters)) continue
    // Duplicate malformed budget rows must not multiply the same original words.
    spokenBySource.set(raw.source_id, Math.max(spokenBySource.get(raw.source_id) || 0, raw.spoken_characters))
  }
  // Same arithmetic as the plan validator: light groups may go 2 s below the beat minimum (never below 8 s).
  const scriptUnits = splitScriptUnits(script), bodyAnalysis = analyzeScriptBody(script)
  const notes = new Set([...productionNoteIds(scriptUnits), ...bodyAnalysis.excludedSourceIds])
  const unitText = new Map(scriptUnits.map(unit => [unit.id, unit.text]))
  const source = (id: number) => ({ text: unitText.get(id), spoken: spokenBySource.has(id) ? spokenBySource.get(id) : undefined, unperformed: notes.has(id) })
  const hints: GuidanceGroup[] = groups.map(group => {
    const [, maximum] = beatLimits[group.beat]
    const minimum = allowedBeatMinimum(group.beat, groupContentSeconds(group.source_ids, source))
    const exclusive = [...new Set(group.source_ids)].filter(id => owners.get(id)?.size === 1)
      .reduce((sum, id) => sum + (spokenBySource.get(id) || 0), 0)
    const speechMinimum = exclusive > 0 ? exclusive / 4.5 + 2 : 0
    const necessaryMinimum = Math.max(minimum, speechMinimum)
    return {
      ...group, source_ids: [...group.source_ids], beat_minimum_seconds: minimum, beat_maximum_seconds: maximum,
      exclusive_spoken_characters: exclusive, minimum_seconds_for_exclusive_speech: speechMinimum,
      minimum_seconds_without_regrouping: necessaryMinimum,
      requires_source_redistribution: necessaryMinimum > maximum + epsilon,
    }
  })
  const total = groups.reduce((sum, group) => sum + group.duration, 0)
  const minimumWithoutRegrouping = hints.reduce((sum, group) => sum + group.minimum_seconds_without_regrouping, 0)
  // The validator accepts a total less than 1 s over the upper bound (round 3); the hints use the same limit.
  const hardMaximum = timing.maximumSeconds + TOTAL_DURATION_TOLERANCE_SECONDS
  const over = total > hardMaximum - epsilon ? total - timing.maximumSeconds : 0
  const under = total < timing.minimumSeconds - epsilon ? timing.minimumSeconds - total : 0
  const capacityConflicts: unknown[] = []
  for (const raw of Array.isArray(input?.issues) ? input.issues : []) {
    if (!raw || typeof raw !== 'object') continue
    const capacity = raw.capacity
    if (!capacity || typeof capacity !== 'object' || Array.isArray(capacity)) continue
    try { capacityConflicts.push(JSON.parse(JSON.stringify(capacity))) } catch { /* Ignore malformed diagnostic objects. */ }
  }
  return {
    timing: {
      counting_scope: bodyAnalysis.scope,
      body_characters: bodyAnalysis.characters,
      excluded_characters: bodyAnalysis.excludedCharacters,
      target_seconds: timing.targetSeconds,
      minimum_seconds: timing.minimumSeconds, maximum_seconds: timing.maximumSeconds,
      // Convenience options for integer choices, never replacement hard bounds.
      minimum_integer_seconds: Math.ceil(timing.minimumSeconds), maximum_integer_seconds: Math.floor(timing.maximumSeconds),
      estimated_group_count: groupBudget.estimatedGroups,
      preferred_group_count: groupBudget.preferredGroupCount,
      minimum_group_count: groupBudget.minimumGroups, maximum_group_count: groupBudget.maximumGroups,
      group_count_tolerance: 0.2,
      group_count_integer_fallback: groupBudget.integerFallback,
    },
    current: {
      group_count: rawGroups.length, total_seconds: total, over_max_seconds: over, under_min_seconds: under,
      group_count_within_budget: rawGroups.length >= groupBudget.minimumGroups && rawGroups.length <= groupBudget.maximumGroups,
      recommended_integer_reduction_seconds: over > 0 ? Math.ceil(over - epsilon) : 0,
      recommended_integer_increase_seconds: under > 0 ? Math.ceil(under - epsilon) : 0,
      minimum_seconds_without_regrouping: minimumWithoutRegrouping,
      requires_regrouping: malformed || rawGroups.length < groupBudget.minimumGroups || rawGroups.length > groupBudget.maximumGroups
        || minimumWithoutRegrouping > hardMaximum - epsilon
        || hints.some(group => group.requires_source_redistribution),
    },
    groups: hints,
    capacity_conflicts: capacityConflicts,
  }
}
