import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planEntries, reconcileDraftGroups } from '../src/services/storyboard-plan-reconcile.ts'

const row = (number: number, source_ids: number[], duration: number, scene_id = 7) => ({ number, title: `${number}`, beat: 'narrative' as const, source_ids, scene_id, duration })
const ready = (number: number, source_ids: number[], duration: number) => ({ number, status: 'ready' as const, attempts: 1, issues: [{ code: 'x', severity: 'warning', shotNumber: number }],
  candidate: { raw: { shot_number: number, description: `第${number}组正文` }, data: { shot_number: number, source_ids, duration, scene_id: 7, description: `第${number}组正文` } } })
const failed = (number: number) => ({ number, status: 'needs_revision' as const, attempts: 1, issues: [{ code: 'model_constraint_conflict', severity: 'error', field: 'duration', shotNumber: number }],
  candidate: { raw: { conflict: '装不下', field: 'duration', source_ids: [] }, data: null } })

test('groups whose lines, duration and scene are unchanged keep their storyboards; changed groups start again', () => {
  const before = { groups: [row(1, [1, 2], 12), row(2, [3, 4], 10), row(3, [5, 6], 12)] }
  const after = [row(1, [1, 2], 12), row(2, [3], 10), row(3, [4], 10), row(4, [5, 6], 12)]
  const { groups, moved } = reconcileDraftGroups(before, after, [ready(1, [1, 2], 12), failed(2), ready(3, [5, 6], 12)])
  assert.deepEqual(groups.map(group => [group.number, group.status]), [[1, 'ready'], [2, 'pending'], [3, 'pending'], [4, 'ready']])
  assert.deepEqual([...moved], [[1, 1], [3, 4]])
  const renumbered = groups.find(group => group.number === 4)! as any
  assert.equal(renumbered.candidate.data.shot_number, 4, 'only the group number of a kept storyboard changes')
  assert.equal(renumbered.candidate.raw.shot_number, 4)
  assert.equal(renumbered.candidate.data.description, '第3组正文', 'prose is not edited')
  assert.equal(renumbered.issues[0].shotNumber, 4)
})

test('without the plan a group was made for, only finished groups are kept, by their own validated storyboard', () => {
  const after = [row(1, [1, 2], 12), row(2, [3, 4], 12)]
  const { groups } = reconcileDraftGroups(null, after, [ready(1, [1, 2], 12), failed(2)])
  assert.deepEqual(groups.map(group => [group.number, group.status]), [[1, 'ready'], [2, 'pending']])
  const changed = reconcileDraftGroups(null, [row(1, [1, 2], 13), row(2, [3, 4], 11)], [ready(1, [1, 2], 12)])
  assert.deepEqual(changed.groups.map(group => [group.number, group.status]), [[1, 'pending'], [2, 'pending']], 'a different duration is a different group')
})

test('plan identity covers numbers, lines, duration and scene only', () => {
  assert.equal(planEntries({ groups: [row(1, [1], 10)] }), planEntries({ groups: [{ ...row(1, [1], 10), title: '改名' }] }))
  assert.notEqual(planEntries({ groups: [row(1, [1], 10)] }), planEntries({ groups: [row(1, [1], 11)] }))
  assert.notEqual(planEntries({ groups: [row(1, [1], 10)] }), planEntries({ groups: [row(1, [1, 2], 10)] }))
})
