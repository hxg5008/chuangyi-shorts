import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTargetedRepair, feasibleShotCounts } from '../src/services/storyboard-targeted-repair.ts'
import type { ValidationIssue } from '../src/services/storyboard-validation.ts'

// Regression from the real 第2集 group 6: duration 10 s (4 time rows: 3+3+3+1 s)
// with 4 described shots. Each shot needs 2–6 s, so no row layout exists for
// four shots; a time_row_counts-only patch can never succeed. Repair must be a
// complete group rewrite that may redesign the shots (2–4), keeping the planned duration.
const issue = (code: string, field: string, message = code): ValidationIssue => ({ code, field, message, severity: 'error', shotNumber: 6 })
const fourShotsInTenSeconds = () => ({
  shot_number: 6, title: '摆钱问心', time: '日', location: '里屋', shot_type: '中景', angle: '平视', movement: '固定',
  description: '【镜头1】甲推门。【镜头2】乙抬眼。【镜头3】甲放钱。【镜头4】乙攥包带。',
  result: '末态。', atmosphere: '天光。', image_prompt: '首镜。', bgm_prompt: '无背景音乐', sound_effect: '衣料声。',
  video_prompt: '出场人物：甲；场景：里屋。\n0-3秒：A0为门槛，X向东，Y向北，甲推门。\n3-6秒：乙抬眼。\n6-9秒：甲放钱。\n9-10秒：乙攥包带。',
  duration: 10, scene_id: 2, character_ids: [1], prop_ids: [], source_ids: [16, 17], time_row_counts: [1, 1, 1, 1],
})

test('the feasible shot counts for a duration follow the 2–6 s per shot and 3 s row rules', () => {
  // 10 s = rows 3+3+3+1: four shots would leave a 1 s shot, so only 2 or 3 shots fit.
  assert.deepEqual(feasibleShotCounts(10), [2, 3])
  assert.deepEqual(feasibleShotCounts(12), [2, 3, 4])
  assert.deepEqual(feasibleShotCounts(9), [2, 3])
  // 8 s = rows 3+3+2: three shots of 3/3/2 s are valid.
  assert.deepEqual(feasibleShotCounts(8), [2, 3])
  // 13 s = 5 rows: two shots can cover at most 4 rows, so at least three shots.
  assert.deepEqual(feasibleShotCounts(13), [3, 4])
})

test('a shot count that no row layout can satisfy is not offered a counts-only patch', () => {
  const plan = createTargetedRepair({ prior: fourShotsInTenSeconds(), issues: [issue('shot_duration', 'time_row_counts', '子镜头4实际分配1秒')], mode: 'breakdown' })
  assert.equal(plan, null, 'escalate to a complete group repair that may change the shot design')
})

test('a fixable mapping with a feasible shot count still uses the small counts-only patch', () => {
  const value = { ...fourShotsInTenSeconds(), description: '【镜头1】甲推门。【镜头2】乙抬眼。【镜头3】甲放钱。', time_row_counts: [1, 1, 1] }
  const plan = createTargetedRepair({ prior: value, issues: [issue('shot_time_mapping', 'time_row_counts')], mode: 'breakdown' })
  assert.ok(plan)
  assert.deepEqual(plan!.fields, ['time_row_counts'])
})

test('prompt mode keeps the locked shot design and does not escalate into a shot rewrite', () => {
  const value = { video_prompt: fourShotsInTenSeconds().video_prompt, time_row_counts: [1, 1, 1, 1], description: fourShotsInTenSeconds().description, duration: 10 }
  const plan = createTargetedRepair({ prior: value, issues: [issue('shot_duration', 'time_row_counts')], mode: 'prompt' })
  assert.ok(plan, 'prompt mode has a locked description; its existing behaviour is unchanged')
})
