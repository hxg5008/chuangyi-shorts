import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildStoryboardPlanningConstraints } from '../src/services/storyboard-plan-guidance.ts'

const script = '甲'.repeat(783)
const group = (number: number, duration = 12, beat = 'narrative', source_ids = [number]) => ({ number, duration, beat, source_ids })
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`)

test('the 783-character screenshot gets exact timing bounds and actionable reduction arithmetic', () => {
  const plan = { groups: Array.from({ length: 10 }, (_, index) => group(index + 1, index ? 12 : 13)) }
  const hints = buildStoryboardPlanningConstraints({ plan, script, speechBudgets: [], issues: [] })
  close(hints.timing.target_seconds, 93.96)
  close(hints.timing.minimum_seconds, 75.168)
  close(hints.timing.maximum_seconds, 112.752)
  assert.equal(hints.timing.minimum_integer_seconds, 76)
  assert.equal(hints.timing.maximum_integer_seconds, 112)
  assert.equal(hints.timing.preferred_group_count, 8)
  assert.equal(hints.current.total_seconds, 121)
  close(hints.current.over_max_seconds, 8.248)
  assert.equal(hints.current.recommended_integer_reduction_seconds, 9)
  assert.equal(hints.current.minimum_seconds_without_regrouping, 100)
  assert.equal(hints.current.group_count_within_budget, false)
  assert.equal(hints.current.requires_regrouping, true, 'ten groups exceed the raw 7.83-group +/-20% budget')
})

test('fixed beat and exclusive speech lower bounds identify when duration-only repair cannot work', () => {
  const beatBound = buildStoryboardPlanningConstraints({ plan: { groups: Array.from({ length: 10 }, (_, index) => group(index + 1, 12, 'climax')) }, script })
  assert.equal(beatBound.current.minimum_seconds_without_regrouping, 120)
  assert.equal(beatBound.current.requires_regrouping, true)
  const speechBound = buildStoryboardPlanningConstraints({ plan: { groups: [group(1, 15)] }, script,
    speechBudgets: [{ source_id: 1, spoken_characters: 60 }] })
  close(speechBound.groups[0].minimum_seconds_for_exclusive_speech, 60 / 4.5 + 2)
  assert.equal(speechBound.groups[0].requires_source_redistribution, true)
  assert.equal(speechBound.current.requires_regrouping, true)
})

test('shared original sources are not counted as full exclusive dialogue in every group', () => {
  const conflict = { source_ids: [1], group_numbers: [1, 2], demand_characters: 100, capacity_characters: 72, deficit_characters: 28,
    units: [{ source_id: 1, spoken_characters: 100, group_numbers: [1, 2] }], groups: [{ number: 1, duration: 10, capacity_characters: 36 }, { number: 2, duration: 10, capacity_characters: 36 }] }
  const hints = buildStoryboardPlanningConstraints({ script, plan: { groups: [group(1, 10, 'narrative', [1]), group(2, 10, 'narrative', [1, 2])] },
    speechBudgets: [{ source_id: 1, spoken_characters: 100, utterances: [{ text: 'do-not-repeat-this-dialogue' }] }, { source_id: 2, spoken_characters: 9 }],
    issues: [{ code: 'constraint_conflict', capacity: conflict }, { code: 'other', message: 'do-not-copy-the-issue-message' }] })
  assert.deepEqual(hints.groups.map(row => row.exclusive_spoken_characters), [0, 9])
  assert.equal(hints.current.minimum_seconds_without_regrouping, 20)
  assert.deepEqual(hints.capacity_conflicts, [conflict])
  assert.equal(JSON.stringify(hints).includes('do-not-repeat-this-dialogue'), false)
  assert.equal(JSON.stringify(hints).includes('do-not-copy-the-issue-message'), false)
})

test('legal fractional durations are not rejected by integer convenience guidance or rounded speech needs', () => {
  const hints = buildStoryboardPlanningConstraints({ script, plan: { groups: Array.from({ length: 8 }, (_, index) => group(index + 1, 112.7 / 8)) } })
  close(hints.current.total_seconds, 112.7)
  assert.equal(hints.current.over_max_seconds, 0)
  assert.equal(hints.current.recommended_integer_reduction_seconds, 0)
  assert.equal(hints.current.requires_regrouping, false)
  const fractionalSpeech = buildStoryboardPlanningConstraints({ script, plan: { groups: [group(1, 14.9)] }, speechBudgets: [{ source_id: 1, spoken_characters: 58 }] })
  close(fractionalSpeech.groups[0].minimum_seconds_for_exclusive_speech, 14.88888888888889)
  assert.equal(fractionalSpeech.groups[0].requires_source_redistribution, false)
})

test('1153-character planning guidance exposes the enforceable group range and catches short-group overproduction', () => {
  const hints = buildStoryboardPlanningConstraints({ script: '景'.repeat(1153), plan: {
    groups: Array.from({ length: 17 }, (_, index) => group(index + 1, 8, 'transition', [1])),
  } })
  assert.equal(hints.timing.preferred_group_count, 12)
  assert.equal(hints.timing.minimum_group_count, 10)
  assert.equal(hints.timing.maximum_group_count, 13)
  assert.equal(hints.timing.group_count_tolerance, 0.2)
  assert.equal(hints.timing.group_count_integer_fallback, false)
  assert.equal(hints.current.total_seconds, 136)
  assert.equal(hints.current.over_max_seconds, 0)
  assert.equal(hints.current.under_min_seconds, 0)
  assert.equal(hints.current.group_count_within_budget, false)
  assert.equal(hints.current.requires_regrouping, true)
})

test('guidance does not mutate the plan or budgets and does not duplicate a source repeated inside one group', () => {
  const plan = { groups: [group(1, 10, 'narrative', [1, 1])] }
  const budgets = [{ source_id: 1, spoken_characters: 9 }, { source_id: 1, spoken_characters: 9 }]
  const before = JSON.stringify({ plan, budgets })
  Object.freeze(plan.groups[0].source_ids); Object.freeze(plan.groups[0]); Object.freeze(plan.groups); Object.freeze(plan)
  const hints = buildStoryboardPlanningConstraints({ script, plan, speechBudgets: budgets })
  assert.equal(hints.groups[0].exclusive_spoken_characters, 9)
  hints.groups[0].source_ids.push(99)
  assert.equal(JSON.stringify({ plan, budgets }), before)
})

test('null and malformed model output produce conservative usable guidance without throwing', () => {
  for (const input of [undefined, null, {}, { plan: null, script: null }, { plan: { groups: null } },
    { plan: { groups: [null, 'bad', { number: 1, beat: 'unknown', duration: NaN, source_ids: null }] }, speechBudgets: 'bad', issues: [null, { capacity: undefined }] }]) {
    const hints = buildStoryboardPlanningConstraints(input)
    assert.equal(hints.current.requires_regrouping, true)
    assert.ok(Number.isFinite(hints.current.total_seconds))
    assert.deepEqual(hints.groups, [])
    assert.deepEqual(hints.capacity_conflicts, [])
  }
})
