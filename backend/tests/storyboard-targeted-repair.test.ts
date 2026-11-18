import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyTargetedRepair, createTargetedRepair, targetedRepairVersion,
} from '../src/services/storyboard-targeted-repair.ts'
import type { ValidationIssue } from '../src/services/storyboard-validation.ts'
import { buildVoiceCueSchema, type StoryboardVoiceCue } from '../src/services/storyboard-voice-cues.ts'

const issue = (code: string, field: string, message = code): ValidationIssue => ({ code, field, message, severity: 'error', shotNumber: 4 })
const prior = () => ({
  shot_number: 4, title: '原始标题', time: '1980年日', location: '原有院落', shot_type: '中近景', angle: '平视', movement: '固定',
  description: '【镜头1】[[character:1]]说：「回来。」【镜头2】[[character:2]]说：「我在。」',
  result: '原有末态，手中木杯仍在，不提前完成后组动作。', atmosphere: '原有天光与环境声。',
  image_prompt: '首镜构图，原有[[character:1]]。', bgm_prompt: '无背景音乐', sound_effect: '原有衣料声。',
  video_prompt: '出场人物：[[character:1]]、[[character:2]]；场景：[[scene:10]]。\r\n'
    + '0-3秒：门槛为A0，X向东，Y向北，[[character:1]]说：「回来。」\r\n\r\n'
    + '3-6秒：[[character:2]]说：「我在。」\r\n'
    + '6-8秒：[[character:2]]保持原有末态，门外写着「@原字 #原字」。\r\n',
  duration: 8, scene_id: 10, character_ids: [1, 2], prop_ids: [20], source_ids: [5, 6], time_row_counts: [1, 2],
})
const build = (value = prior(), issues = [issue('shot_time_mapping', 'time_row_counts')], mode: 'breakdown' | 'prompt' = 'breakdown') => {
  const plan = createTargetedRepair({ prior: value, issues, mode })
  assert.ok(plan)
  return plan
}

const voice = (id = 'v1', shot = 1, speaker_id = 1): StoryboardVoiceCue => ({
  id, shot, speaker_id, kind: 'dialogue', source_name: '',
  profile: { age: '三十岁成年男声', register: '中低音区', timbre: '低沉略带沙哑' },
  state: '站在原木桌旁', goal: '回应对方', volume: '适中', rate_cps: 2.5, breath: '平稳', tail: '短收', emotion: '克制',
})
const voiceSchema = buildVoiceCueSchema({ characters: [{ id: 1, name: '阿甲' }, { id: 2, name: '阿乙' }] })

test('voice profile or delivery metadata can be repaired alone while every prose field and cue identity stays locked', () => {
  const cue: Partial<StoryboardVoiceCue> = voice(); delete cue.breath
  const value = { ...prior(), voice_cues: [cue] }, before = structuredClone(value)
  const errors = [issue('voice_cue_schema', 'voice_cues.0.breath')]
  assert.equal(createTargetedRepair({ prior: value, issues: errors, mode: 'breakdown' }), null, 'Legacy callers without the acoustic schema keep their old escalation behavior')
  const plan = createTargetedRepair({ prior: value, issues: errors, mode: 'breakdown', voiceCueSchema: voiceSchema })!
  assert.ok(plan)
  assert.deepEqual(plan.fields, ['voice_cues'])
  assert.deepEqual(plan.payload.allowed_changes, ['voice_cues'])
  const fixed = voice()
  const merged = applyTargetedRepair(value, { base_version: plan.baseVersion, changes: { voice_cues: [fixed] } }, plan)
  assert.equal(merged.ok, true)
  if (merged.ok) assert.deepEqual(merged.value, { ...before, voice_cues: [fixed] })
  assert.deepEqual(value, before)
  const conflicting = createTargetedRepair({ prior: { ...prior(), voice_cues: [voice()] },
    issues: [issue('voice_profile_conflict', 'voice_cues.v1.profile')], mode: 'prompt', voiceCueSchema: voiceSchema })
  assert.ok(conflicting)
  assert.deepEqual(conflicting.fields, ['voice_cues'])
  for (const field of ['id', 'shot', 'speaker_id', 'kind', 'source_name']) assert.equal(createTargetedRepair({ prior: value,
    issues: [issue('voice_cue_schema', `voice_cues.0.${field}`)], mode: 'breakdown', voiceCueSchema: voiceSchema }), null, field)
  assert.equal(createTargetedRepair({ prior: value, issues: [...errors, issue('time_axis', 'video_prompt')], mode: 'breakdown', voiceCueSchema: voiceSchema }), null)
})

test('voice metadata patches cannot change speaker identity, source, kind, child, ordering or cue count', () => {
  const value = { ...prior(), voice_cues: [voice(), voice('v2', 2, 2)] }, before = structuredClone(value)
  const plan = createTargetedRepair({ prior: value, issues: [issue('voice_profile_conflict', 'voice_cues.v1.profile')], mode: 'breakdown', voiceCueSchema: voiceSchema })!
  assert.ok(plan)
  const variants = [
    [{ ...voice(), id: 'changed' }, voice('v2', 2, 2)], [{ ...voice(), shot: 2 }, voice('v2', 2, 2)],
    [{ ...voice(), speaker_id: 2 }, voice('v2', 2, 2)], [{ ...voice(), kind: 'offscreen' }, voice('v2', 2, 2)],
    [{ ...voice(), source_name: '别名' }, voice('v2', 2, 2)], [voice('v2', 2, 2), voice()],
    [voice()], [voice(), voice('v2', 2, 2), voice('v3', 2, 2)],
  ]
  for (const cues of variants) {
    const merged = applyTargetedRepair(value, { base_version: plan.baseVersion, changes: { voice_cues: cues } }, plan)
    assert.equal(merged.ok, false, JSON.stringify(cues))
    if (!merged.ok) assert.equal(merged.code, 'targeted_repair_voice_identity')
  }
  assert.equal(applyTargetedRepair(value, { base_version: plan.baseVersion, changes: { voice_cues: [voice(), voice('v2', 2, 2)], video_prompt: '越权正文' } }, plan).ok, false)
  assert.deepEqual(value, before)
})

test('a mapping-only correction returns only the requested field and preserves all other raw bytes and identity data', () => {
  const value = prior(), before = structuredClone(value), plan = build(value)
  assert.deepEqual(plan.fields, ['time_row_counts'])
  assert.equal(plan.scope, 'fields')
  const response = { base_version: plan.baseVersion, changes: { time_row_counts: [2, 1] } }
  const result = applyTargetedRepair(value, response, plan)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.value, { ...before, time_row_counts: [2, 1] })
  assert.deepEqual(value, before)
  assert.notEqual(result.value, value)
  assert.notEqual(result.value.character_ids, value.character_ids, 'The merged snapshot has no mutable aliases')
  assert.deepEqual(response, { base_version: plan.baseVersion, changes: { time_row_counts: [2, 1] } })
})

test('a mapping patch cannot modify descriptions, bound identities, duration or append an unrequested change', () => {
  const value = prior(), plan = build(value), before = structuredClone(value)
  for (const changes of [
    { time_row_counts: [2, 1], description: '越权改写' },
    { time_row_counts: [2, 1], duration: 12 },
    { time_row_counts: [2, 1], character_ids: [9] },
    { time_row_counts: [2, 1], source_ids: [9] },
    { time_row_counts: [2, 1], result: '越权末态' },
    { time_row_counts: [2, 1], unknown: true },
    {},
  ]) {
    const result = applyTargetedRepair(value, { base_version: plan.baseVersion, changes }, plan)
    assert.equal(result.ok, false, JSON.stringify(changes))
    if (!result.ok) assert.equal(result.code, 'targeted_repair_schema')
  }
  assert.deepEqual(value, before)
})

test('unknown, structural and explicit conflicts escalate rather than guessing a local repair', () => {
  for (const [code, field] of [
    ['dialogue_coverage', 'source_ids.5'], ['dialogue_budget', 'duration'], ['shot_order', 'description'],
    ['plan_changed', 'plan'], ['scene_binding', 'scene_id'], ['character_binding', 'character_ids'],
    ['prop_binding', 'prop_ids'], ['reference_scene_conflict', 'scene_id'],
    ['model_constraint_conflict', 'video_prompt'], ['new_unrecognized_error', 'video_prompt'],
    ['response_schema', 'shot_number'], ['storyboard_schema', 'source_ids.0'],
  ]) assert.equal(createTargetedRepair({ prior: prior(), issues: [issue(code, field)], mode: 'breakdown' }), null, code)
  assert.equal(createTargetedRepair({ prior: prior(), issues: [issue('shot_time_mapping', 'time_row_counts'), issue('dialogue_budget', 'duration')], mode: 'breakdown' }), null)
  assert.equal(createTargetedRepair({ prior: { incomplete_response: 'unfinished' }, issues: [issue('skill_field_missing', 'video_prompt')], mode: 'breakdown' }), null)
  assert.equal(createTargetedRepair({ prior: null, issues: [issue('skill_field_missing', 'title')], mode: 'breakdown' }), null)
  assert.equal(createTargetedRepair({ prior: prior(), issues: [], mode: 'breakdown' }), null)
  assert.equal(createTargetedRepair({ prior: prior(), issues: [{ ...issue('prompt_header', 'video_prompt.header'), severity: 'warning' }], mode: 'breakdown' }), null)
})

test('prompt mode only permits video fields even when other candidate errors name a local prose field', () => {
  for (const field of ['description', 'atmosphere', 'title', 'result', 'image_prompt']) {
    assert.equal(createTargetedRepair({ prior: prior(), issues: [issue('skill_field_missing', field)], mode: 'prompt' }), null)
  }
  const value = { video_prompt: prior().video_prompt, time_row_counts: [1, 2] }
  assert.ok(createTargetedRepair({ prior: value, issues: [issue('shot_time_mapping', 'time_row_counts')], mode: 'prompt' }))
})

test('version guards reject a late patch after any current raw prose or binding change', () => {
  const value = prior(), plan = build(value), response = { base_version: plan.baseVersion, changes: { time_row_counts: [2, 1] } }
  for (const changed of [{ ...value, description: `${value.description}追加` }, { ...value, character_ids: [1] }, { ...value, result: '新末态' }]) {
    const result = applyTargetedRepair(changed, response, plan)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'targeted_repair_version')
  }
  const wrongVersion = applyTargetedRepair(value, { ...response, base_version: 'wrong' }, plan)
  assert.equal(wrongVersion.ok, false)
  assert.equal(targetedRepairVersion(value), plan.baseVersion)
  assert.notEqual(targetedRepairVersion({ ...value, video_prompt: value.video_prompt.replace('\r\n', '\n') }), plan.baseVersion, 'Raw line delimiters are part of the snapshot')
})

test('a precise row-reference issue replaces only that existing full row and retains CRLF and blank lines', () => {
  const value = prior(), before = structuredClone(value), plan = build(value, [issue('time_row_reference', 'video_prompt.rows.2')])
  assert.equal(plan.scope, 'video_rows')
  assert.deepEqual(plan.rowTargets, [2])
  assert.deepEqual(plan.payload.target_rows, [{ row: 2, text: '3-6秒：[[character:2]]说：「我在。」' }])
  const replacement = '3-6秒：[[character:2]]在原位置，低声说：「我在。」'
  const result = applyTargetedRepair(value, { base_version: plan.baseVersion, changes: { video_prompt_rows: { '2': replacement } } }, plan)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.value, { ...before, video_prompt: before.video_prompt.replace('3-6秒：[[character:2]]说：「我在。」', replacement) })
  assert.ok((result.value.video_prompt as string).endsWith('\r\n'))
  assert.deepEqual(value, before)
})

test('row patches cannot change intervals, add lines, omit a requested row or include an unrequested row', () => {
  const value = prior(), plan = build(value, [issue('time_row_reference', 'video_prompt.rows.2')])
  for (const rows of [
    {}, { '1': '0-3秒：不该改这一行。', '2': '3-6秒：完整改词。' },
    { '2': '3-7秒：擅改时长。' }, { '2': '3-6秒：一行。\n6-8秒：多一行。' },
    { '2': '没有时间范围。' }, { '2': '' },
  ]) {
    assert.equal(applyTargetedRepair(value, { base_version: plan.baseVersion, changes: { video_prompt_rows: rows } }, plan).ok, false)
  }
  assert.equal(applyTargetedRepair(value, { base_version: plan.baseVersion, changes: { video_prompt: '越权整个字段' } }, plan).ok, false)
})

test('a dialogue mismatch fixes exactly the existing one-or-two rows belonging to that child without cutting words', () => {
  const value = prior(), plan = build(value, [issue('dialogue_preservation', 'video_prompt', '子镜头2的台词与视频不一致；对应时间行2—3。')])
  assert.deepEqual(plan.rowTargets, [2, 3])
  const rows = { '2': '3-6秒：[[character:2]]低声说：「我在。」', '3': '6-8秒：[[character:2]]保持原有末态。' }
  const merged = applyTargetedRepair(value, { base_version: plan.baseVersion, changes: { video_prompt_rows: rows } }, plan)
  assert.equal(merged.ok, true)
  if (!merged.ok) return
  assert.equal(merged.value.description, value.description)
  assert.equal((merged.value.video_prompt as string).split('\r\n')[1], value.video_prompt.split('\r\n')[1])
  assert.equal(merged.value.duration, value.duration)
  assert.deepEqual(merged.value.time_row_counts, value.time_row_counts)
  assert.equal(applyTargetedRepair(value, { base_version: plan.baseVersion, changes: { video_prompt_rows: { '2': rows['2'] } } }, plan).ok, false)
})

test('a header plus first-row space-basis correction leaves all subsequent time rows and content untouched', () => {
  const value = prior(), plan = build(value, [issue('prompt_header', 'video_prompt.header'), issue('space_basis_missing', 'video_prompt')])
  assert.deepEqual(plan.rowTargets, [1])
  assert.equal(plan.headerLine, 0)
  const header = '出场人物：[[character:1]]、[[character:2]]；场景：[[scene:10]]；道具：[[prop:20]]。'
  const first = '0-3秒：A0为原门槛，X向东、Y向北，[[character:1]]说：「回来。」'
  const merged = applyTargetedRepair(value, { base_version: plan.baseVersion, changes: { video_prompt_header: header, video_prompt_rows: { '1': first } } }, plan)
  assert.equal(merged.ok, true)
  if (!merged.ok) return
  const expected = value.video_prompt.split(/(\r\n|\n|\r)/)
  expected[0] = header; expected[2] = first
  assert.equal(merged.value.video_prompt, expected.join(''))
  assert.equal(applyTargetedRepair(value, { base_version: plan.baseVersion, changes: { video_prompt_header: `${header}\n多一行`, video_prompt_rows: { '1': first } } }, plan).ok, false)
})

test('a header-only patch is a single independent line and never requests the remaining prompt', () => {
  const value = prior(), plan = build(value, [issue('prompt_header', 'video_prompt.header')])
  assert.deepEqual(plan.payload.allowed_changes, ['video_prompt_header'])
  assert.equal(applyTargetedRepair(value, { base_version: plan.baseVersion, changes: { video_prompt_header: '0-3秒：不能把时间行当信息头。' } }, plan).ok, false)
})

test('an invalid axis, unknown row location or unstable mapping uses a full video-field patch', () => {
  const value = prior()
  for (const errors of [
    [issue('time_axis', 'video_prompt')], [issue('prompt_length', 'video_prompt')],
    [issue('time_row_reference', 'video_prompt.rows.99')],
    [issue('dialogue_preservation', 'video_prompt', '未给出子镜号')],
    [issue('reference_token_invalid', 'video_prompt')],
    [issue('dialogue_preservation', 'video_prompt', '子镜头2发声不同'), issue('shot_time_mapping', 'time_row_counts')],
  ]) {
    const plan = build(value, errors)
    assert.equal(plan.scope, 'fields')
    assert.ok(plan.payload.allowed_changes.includes('video_prompt'))
    assert.equal(plan.rowTargets, undefined)
  }
  const changed = { ...value, time_row_counts: [1, 1] }
  assert.equal(build(changed, [issue('dialogue_preservation', 'video_prompt', '子镜头2发声不同')]).scope, 'fields')
})

test('missing metadata fields can be supplied together without rewriting the creative fields', () => {
  const value = prior(); delete (value as Partial<typeof value>).image_prompt
  const plan = build(value, [issue('skill_field_missing', 'image_prompt'), issue('skill_field_missing', 'sound_effect')])
  assert.deepEqual(plan.fields, ['image_prompt', 'sound_effect'])
  const merged = applyTargetedRepair(value, { base_version: plan.baseVersion, changes: { image_prompt: '原首镜单帧内容。', sound_effect: '原有木杯轻响。' } }, plan)
  assert.equal(merged.ok, true)
  if (merged.ok) {
    assert.equal(merged.value.description, value.description)
    assert.equal(merged.value.video_prompt, value.video_prompt)
    assert.equal(merged.value.result, value.result)
    assert.deepEqual(merged.value.source_ids, value.source_ids)
  }
})

test('schema-local failures select only their named field and blank output is rejected', () => {
  const value = prior(), plan = build(value, [issue('storyboard_schema', 'time_row_counts.0')])
  assert.deepEqual(plan.fields, ['time_row_counts'])
  const words = build(value, [issue('reference_quote_unclosed', 'description')])
  assert.deepEqual(words.fields, ['description'])
  assert.equal(applyTargetedRepair(value, { base_version: words.baseVersion, changes: { description: '  ' } }, words).ok, false)
})
