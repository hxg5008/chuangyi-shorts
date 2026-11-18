import type { NarrativeGroup } from './skill-storyboard-contract.js'
import type { DraftGroup } from './storyboard-draft-store.js'

/**
 * After the narrative plan changes, keep only draft groups whose planned
 * content (original lines, duration and scene) is unchanged; every other
 * planned group starts pending and is generated again.
 *
 * A group is identified by the plan row it was generated for (`generatedWith`).
 * Without that plan, only a finished (ready) group can be identified, by its
 * own validated storyboard, which always equals its plan row.
 *
 * A kept group may get a new number when an earlier group was split or
 * merged. Only its group-number fields change; prose is never edited.
 */
export function reconcileDraftGroups(generatedWith: { groups?: unknown } | null, next: readonly NarrativeGroup[], groups: readonly DraftGroup[]) {
  const previous = Array.isArray(generatedWith?.groups) ? generatedWith!.groups as Array<Partial<NarrativeGroup>> : []
  const key = (row: { source_ids?: unknown; duration?: unknown; scene_id?: unknown }) =>
    JSON.stringify([Array.isArray(row.source_ids) ? row.source_ids : null, row.duration ?? null, row.scene_id ?? null])
  const targets = new Map<string, number[]>()
  for (const row of [...next].sort((a, b) => a.number - b.number)) targets.set(key(row), [...(targets.get(key(row)) || []), row.number])
  const moved = new Map<number, number>()
  const kept: DraftGroup[] = []
  for (const group of [...groups].sort((a, b) => a.number - b.number)) {
    const candidate = group.candidate && typeof group.candidate === 'object' ? group.candidate as Record<string, unknown> : null
    const data = candidate?.data && typeof candidate.data === 'object' && Array.isArray((candidate.data as any).source_ids) ? candidate.data as Record<string, unknown> : null
    const planned = previous.find(row => row?.number === group.number)
    const identity = planned || (group.status === 'ready' ? data : null)
    const target = identity ? targets.get(key(identity))?.shift() : undefined
    if (target === undefined) continue
    moved.set(group.number, target)
    kept.push(target === group.number ? group : renumbered(group, target))
  }
  for (const row of next) if (!kept.some(group => group.number === row.number)) kept.push({ number: row.number, status: 'pending', candidate: null, issues: [], attempts: 0 })
  return { groups: kept.sort((a, b) => a.number - b.number), moved }
}

function renumbered(group: DraftGroup, number: number): DraftGroup {
  const from = group.number
  const fix = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) && (value as any).shot_number === from
    ? { ...(value as Record<string, unknown>), shot_number: number } : value
  const candidate = group.candidate && typeof group.candidate === 'object' && !Array.isArray(group.candidate)
    ? Object.fromEntries(Object.entries(group.candidate as Record<string, unknown>)
      .map(([field, value]) => [field, ['raw', 'data', 'preview', 'previous_raw'].includes(field) ? fix(value) : value]))
    : group.candidate
  const issues = group.issues.map(issue => issue && typeof issue === 'object' && (issue as any).shotNumber === from ? { ...(issue as Record<string, unknown>), shotNumber: number } : issue)
  return { ...group, number, candidate, issues }
}

/** The plan fields a stored storyboard is validated against, in group order. */
export function planEntries(plan: { groups?: unknown } | null | undefined) {
  return JSON.stringify(Array.isArray(plan?.groups)
    ? (plan!.groups as Array<Partial<NarrativeGroup>>).map(row => [row?.number ?? null, row?.source_ids ?? null, row?.duration ?? null, row?.scene_id ?? null])
    : null)
}
