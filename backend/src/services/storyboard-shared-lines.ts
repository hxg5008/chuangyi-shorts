import type { NarrativeGroup, ScriptUnitSpeechBudget } from './skill-storyboard-contract.js'
import { skillDescriptionShots, skillSpokenTurns, type SkillCandidate } from './skill-storyboard-validation.js'
import type { ValidationIssue } from './storyboard-validation.js'

/**
 * A narrative plan may let one long original line continue across adjacent
 * groups. Each group then needs to know exactly which original words it speaks;
 * otherwise every group counts the whole line against its own speech budget.
 *
 * This module only chooses a cut at punctuation that already exists in the
 * original words. It never changes, drops, repeats or reorders a character.
 */

export interface SharedLinePiece {
  source_id: number
  utterance_index: number
  speaker: string | null
  kind: 'dialogue' | 'offscreen' | 'narration'
  text: string
  characters: number
  part: 'whole' | 'head' | 'tail'
}
export interface GroupSpeechAssignment {
  group_number: number
  pieces: SharedLinePiece[]
  spoken_characters: number
  capacity_characters: number
}
export interface SharedLineAssignment {
  shared_source_ids: number[]
  /** Planned owner groups of every shared line, in group order. */
  line_owners: Array<{ source_id: number; groups: number[] }>
  groups: GroupSpeechAssignment[]
}
export interface SharedLineSearchOptions {
  /** Only complete assignments this predicate accepts are returned (e.g. ones that agree with finished groups). */
  accept?: (assignment: SharedLineAssignment) => boolean
  /** Upper bound on search steps. A search cut short returns the best assignment found so far. */
  maxSteps?: number
}

const spoken = (text: string) => [...text].filter(character => /[\p{L}\p{N}]/u.test(character)).length
const compact = (text: string) => text.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '')
const SENTENCE = /[。！？；!?;…]/u
const CLAUSE = /[，、,：:]/u
export const groupSpeechCapacity = (duration: number) => Number.isFinite(duration) ? Math.max(0, Math.floor((duration - 2) * 4.5 + 1e-8)) : 0

/** Cut positions after existing punctuation; sentence ends are preferred over clause commas. */
function cutPositions(text: string) {
  const positions: Array<{ at: number; strength: 2 | 1 }> = []
  for (let index = 0; index < text.length - 1; index++) {
    const strength = SENTENCE.test(text[index]) ? 2 : CLAUSE.test(text[index]) ? 1 : 0
    // Keep closing quotes/brackets attached to the clause they close.
    if (strength && !/[」』”’）)]/u.test(text[index + 1])) positions.push({ at: index + 1, strength: strength as 2 | 1 })
  }
  return positions
}

/** Lines whose spoken content belongs to more than one planned group. */
export function sharedSpokenSourceIds(groups: readonly NarrativeGroup[], budgets: readonly ScriptUnitSpeechBudget[]) {
  const owners = new Map<number, number[]>()
  for (const group of groups) for (const id of new Set(group.source_ids)) owners.set(id, [...(owners.get(id) || []), group.number])
  return [...owners].filter(([id, numbers]) => numbers.length > 1
    && (budgets.find(budget => budget.source_id === id)?.spoken_characters || 0) > 0).map(([id]) => id).sort((a, b) => a - b)
}

/**
 * Assign every spoken utterance of every shared line to the planned groups in
 * order. A shared utterance is either whole in one group or cut once at an
 * existing punctuation mark between two consecutive owners. Among the
 * assignments that fit every group capacity, the one with the fewest comma
 * cuts, then the fewest cuts, is chosen. `complete` is false only when the
 * step bound stopped the search early.
 */
export function searchSharedLineSpeech(groups: readonly NarrativeGroup[], budgets: readonly ScriptUnitSpeechBudget[],
  options: SharedLineSearchOptions = {}): { assignment: SharedLineAssignment | null; complete: boolean } {
  const shared = sharedSpokenSourceIds(groups, budgets)
  if (!shared.length) return { assignment: null, complete: true }
  const ordered = [...groups].sort((a, b) => a.number - b.number)
  const budgetOf = (id: number) => budgets.find(budget => budget.source_id === id)
  const exclusive = (group: NarrativeGroup) => [...new Set(group.source_ids)].filter(id => !shared.includes(id))
    .reduce((sum, id) => sum + (budgetOf(id)?.spoken_characters || 0), 0)
  const lineOwners = shared.map(id => ({ source_id: id, groups: ordered.filter(group => group.source_ids.includes(id)).map(group => group.number) }))
  // Units of work in original order: each shared utterance, with its owner groups.
  const units = shared.flatMap(id => (budgetOf(id)?.utterances || []).map((utterance, index) => ({
    source_id: id, utterance_index: index + 1, speaker: utterance.speaker, kind: utterance.kind, text: utterance.text,
    owners: lineOwners.find(line => line.source_id === id)!.groups,
  }))).filter(unit => spoken(unit.text) > 0)
  // Only consecutive owners can share one line; anything else needs a new plan.
  for (const unit of units) if (unit.owners.some((number, index) => index && number !== unit.owners[index - 1] + 1)) return { assignment: null, complete: true }
  const capacity = new Map(ordered.map(group => [group.number, groupSpeechCapacity(group.duration)]))
  const used = new Map(ordered.map(group => [group.number, exclusive(group)]))
  if (ordered.some(group => used.get(group.number)! > capacity.get(group.number)!)) return { assignment: null, complete: true }
  type Choice = { group: number; text: string; part: SharedLinePiece['part'] }[]
  const build = (choices: Choice[], usage: Map<number, number>): SharedLineAssignment => {
    const pieces = new Map<number, SharedLinePiece[]>(ordered.map(group => [group.number, []]))
    choices.forEach((choice, index) => {
      const unit = units[index]
      for (const piece of choice) pieces.get(piece.group)!.push({ source_id: unit.source_id, utterance_index: unit.utterance_index,
        speaker: unit.speaker, kind: unit.kind, text: piece.text, characters: spoken(piece.text), part: piece.part })
    })
    return {
      shared_source_ids: shared, line_owners: lineOwners,
      groups: ordered.filter(group => group.source_ids.some(id => shared.includes(id))).map(group => ({
        group_number: group.number, pieces: pieces.get(group.number)!,
        spoken_characters: usage.get(group.number)!, capacity_characters: capacity.get(group.number)!,
      })),
    }
  }
  // Exhaustive search (shared lines are few), bounded for safety.
  const choices: Choice[] = []
  let best: { assignment: SharedLineAssignment; cost: [number, number] } | null = null
  let steps = 0, complete = true
  const maxSteps = options.maxSteps ?? 200_000
  const better = (a: [number, number], b: [number, number]) => a[0] < b[0] || a[0] === b[0] && a[1] < b[1]
  const search = (index: number, clauseCuts: number, cuts: number) => {
    if (++steps > maxSteps) { complete = false; return }
    if (best && !better([clauseCuts, cuts], best.cost)) return
    if (index === units.length) {
      const assignment = build(choices, used)
      if (!options.accept || options.accept(assignment)) best = { assignment, cost: [clauseCuts, cuts] }
      return
    }
    const unit = units[index]
    const candidates: Array<{ pieces: Choice; clause: number; cut: number }> = []
    for (const owner of unit.owners) candidates.push({ pieces: [{ group: owner, text: unit.text, part: 'whole' }], clause: 0, cut: 0 })
    for (let ownerIndex = 0; ownerIndex + 1 < unit.owners.length; ownerIndex++) {
      for (const cut of cutPositions(unit.text)) {
        const head = unit.text.slice(0, cut.at), tail = unit.text.slice(cut.at)
        if (!spoken(head) || !spoken(tail)) continue
        candidates.push({ pieces: [
          { group: unit.owners[ownerIndex], text: head, part: 'head' },
          { group: unit.owners[ownerIndex + 1], text: tail, part: 'tail' },
        ], clause: cut.strength === 1 ? 1 : 0, cut: 1 })
      }
    }
    for (const candidate of candidates) {
      if (!complete) return
      const fits = candidate.pieces.every(piece => used.get(piece.group)! + spoken(piece.text) <= capacity.get(piece.group)!)
      // Original order across groups: a later utterance may not start in an earlier group than its predecessor ended in.
      const previousEnd = choices.at(-1)?.at(-1)?.group ?? -Infinity
      if (!fits || candidate.pieces[0].group < previousEnd) continue
      for (const piece of candidate.pieces) used.set(piece.group, used.get(piece.group)! + spoken(piece.text))
      choices.push(candidate.pieces)
      search(index + 1, clauseCuts + candidate.clause, cuts + candidate.cut)
      choices.pop()
      for (const piece of candidate.pieces) used.set(piece.group, used.get(piece.group)! - spoken(piece.text))
    }
  }
  search(0, 0, 0)
  return { assignment: best ? (best as { assignment: SharedLineAssignment }).assignment : null, complete }
}

/** The chosen punctuation split, or null when none fits (or the plan shares no spoken line). */
export function assignSharedLineSpeech(groups: readonly NarrativeGroup[], budgets: readonly ScriptUnitSpeechBudget[], options: SharedLineSearchOptions = {}) {
  return searchSharedLineSpeech(groups, budgets, options).assignment
}

/**
 * Plan-stage check: true only when the plan shares spoken lines, every shared
 * utterance could be placed by this module (it has an existing punctuation cut
 * or fits whole in one of its groups), the search finished, and still no
 * assignment fits.
 *
 * A shared utterance with no internal punctuation that is longer than every
 * owning group's capacity can only be divided at a point the program cannot
 * choose. The original skill leaves that division to the model, so such a plan
 * is not rejected here and the workflow keeps the original behaviour for it.
 * Non-adjacent owners are left to the existing source-order validation.
 */
export function sharedLineSplitConflict(groups: readonly NarrativeGroup[], budgets: readonly ScriptUnitSpeechBudget[]): boolean {
  const shared = sharedSpokenSourceIds(groups, budgets)
  if (!shared.length) return false
  const { assignment, complete } = searchSharedLineSpeech(groups, budgets)
  if (assignment || !complete) return false
  const ordered = [...groups].sort((a, b) => a.number - b.number)
  for (const id of shared) {
    const owners = ordered.filter(group => group.source_ids.includes(id))
    if (owners.some((group, index) => index && group.number !== owners[index - 1].number + 1)) return false
    for (const utterance of budgets.find(budget => budget.source_id === id)?.utterances || []) {
      const length = spoken(utterance.text)
      if (!length) continue
      const cuttable = cutPositions(utterance.text).some(cut => spoken(utterance.text.slice(0, cut.at)) && spoken(utterance.text.slice(cut.at)))
      if (!cuttable && owners.every(group => length > groupSpeechCapacity(group.duration))) return false
    }
  }
  return true
}

/** The compacted spoken words of a candidate's description, in order (parse once, check many assignments). */
export function assignmentSpeech(candidate: SkillCandidate, names: string[]) {
  return skillDescriptionShots(candidate.description || '').flatMap(shot => skillSpokenTurns(shot.text, names)).map(turn => compact(turn.text)).join('')
}

/**
 * A group sharing an original line must speak exactly its assigned words of
 * that line: not the whole line, not another group's part. Text-only check on
 * the description speech; the existing complete-episode coverage review still
 * verifies order, speakers and that every word is spoken exactly once.
 *
 * Source order makes a shared line the last line of the earlier group and the
 * first line of the later group. So a piece the next group continues must end
 * this group's speech, and a piece continuing the previous group's words must
 * start it.
 */
export function speechAssignmentIssues(said: string, assignment: SharedLineAssignment, groupNumber: number): ValidationIssue[] {
  const owned = assignment.line_owners.filter(line => line.groups.includes(groupNumber)).map(line => line.source_id)
  if (!owned.length) return []
  const all = assignment.groups.flatMap(group => group.pieces.map(piece => ({ ...piece, group: group.group_number })))
  const issues: ValidationIssue[] = []
  const push = (sourceId: number, message: string) => issues.push({ code: 'speech_assignment', field: `source_ids.${sourceId}`, severity: 'error', shotNumber: groupNumber, message })
  for (const id of owned) {
    const line = all.filter(piece => piece.source_id === id).sort((a, b) => a.utterance_index - b.utterance_index || a.group - b.group)
    const mine = line.filter(piece => piece.group === groupNumber)
    if (!mine.length) {
      // A planned owner without words of this line must not speak the other groups' parts.
      for (const other of line) if (compact(other.text).length >= 4 && said.includes(compact(other.text))) push(id,
        `原文第${id}行的「${other.text}」由第${other.group}组负责，本组不说这一行的原词。`)
      continue
    }
    for (const piece of mine) {
      const text = compact(piece.text), index = line.indexOf(piece)
      if (!text || !said.includes(text)) {
        push(id, `原文第${id}行由相邻组按原有标点分说，本组负责「${piece.text}」，正文缺少这部分原词；请逐字写出本组这部分，不写其他组负责的部分。`)
        continue
      }
      const next = line[index + 1], previous = line[index - 1]
      if (next && next.group > groupNumber && !said.endsWith(text)) push(id,
        `原文第${id}行后面的「${next.text}」由第${next.group}组接着说，本组只说到「${piece.text}」为止，之后不再发声。`)
      if (previous && previous.group < groupNumber && !said.startsWith(text)) push(id,
        `原文第${id}行前面的「${previous.text}」已由第${previous.group}组说过，本组从「${piece.text}」接着说，前面不重复、不另加发声。`)
    }
  }
  return issues
}

export function validateSpeechAssignment(candidate: SkillCandidate, assignment: SharedLineAssignment, groupNumber: number, names: string[]): ValidationIssue[] {
  if (!assignment.line_owners.some(line => line.groups.includes(groupNumber))) return []
  return speechAssignmentIssues(assignmentSpeech(candidate, names), assignment, groupNumber)
}

/**
 * Choose the punctuation split that contradicts the fewest finished groups
 * (`said` = assignmentSpeech of each finished storyboard), then the most
 * natural cuts. Returns the finished groups the chosen split still
 * contradicts; those cannot be part of a complete episode and must be redone.
 */
export function chooseSharedLineSpeech(groups: readonly NarrativeGroup[], budgets: readonly ScriptUnitSpeechBudget[],
  finished: ReadonlyArray<{ number: number; said: string }>): { assignment: SharedLineAssignment | null; contradicted: number[] } {
  const base = assignSharedLineSpeech(groups, budgets)
  if (!base) return { assignment: null, contradicted: [] }
  const contradicted = (assignment: SharedLineAssignment) => finished
    .filter(entry => speechAssignmentIssues(entry.said, assignment, entry.number).length).map(entry => entry.number)
  for (let allowed = 0; allowed < finished.length; allowed++) {
    const assignment = assignSharedLineSpeech(groups, budgets, { accept: candidate => contradicted(candidate).length <= allowed })
    if (assignment) return { assignment, contradicted: contradicted(assignment) }
  }
  return { assignment: base, contradicted: contradicted(base) }
}

/** What a generation request tells one group about the shared lines it owns; null when it owns none. */
export function speechAssignmentPayload(assignment: SharedLineAssignment, groupNumber: number) {
  const owned = assignment.line_owners.filter(line => line.groups.includes(groupNumber))
  if (!owned.length) return null
  const all = assignment.groups.flatMap(group => group.pieces.map(piece => ({ ...piece, group: group.group_number })))
  const own = assignment.groups.find(group => group.group_number === groupNumber)
  return {
    rule: '下列原文行由相邻组在原有标点处分说。本组只逐字说this_group_speaks中的原词，说话者和声音类型不变；other_groups中的原词由对应组说，本组不说、不复述、不提前说。part为head的部分是本组最后的发声，下一组接着说后半；part为tail的部分是本组开头的发声，接上一组已说的前半。本组对白容量只按本组实际负责的原词计算（4.5字/秒＋2秒表演余量）。',
    group_speech_characters: own?.spoken_characters ?? 0,
    group_speech_capacity: own?.capacity_characters ?? 0,
    lines: owned.map(line => ({
      source_id: line.source_id,
      this_group_speaks: all.filter(piece => piece.source_id === line.source_id && piece.group === groupNumber)
        .map(piece => ({ utterance_index: piece.utterance_index, speaker: piece.speaker, kind: piece.kind, text: piece.text, characters: piece.characters, part: piece.part })),
      other_groups: all.filter(piece => piece.source_id === line.source_id && piece.group !== groupNumber)
        .map(piece => ({ group_number: piece.group, utterance_index: piece.utterance_index, speaker: piece.speaker, text: piece.text, part: piece.part })),
    })),
  }
}
