import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSubmission, normalizePlanSubmission, normalizeRepairPatch, speakerVoiceKinds } from '../src/services/storyboard-format-normalize.ts'
import { compileStoryboardVoices, type StoryboardVoiceCue } from '../src/services/storyboard-voice-cues.ts'
import { compileStoryboardReferences } from '../src/services/skill-storyboard-contract.ts'
import { validateSkillStoryboard } from '../src/services/skill-storyboard-validation.ts'

// Round 3 (2026-11-08): mechanical fields seen missing or renamed in real runs of another text model
// (27 of 47 complete answers). Only missing values are filled from the approved plan and the original lines;
// a written value that differs from the plan is never overwritten.
const characters = [{ id: 1, name: '阿甲' }, { id: 2, name: '阿乙' }, { id: 3, name: '系统' }]
const assets = { characters, scenes: [{ id: 10, location: '院落' }], props: [] }
const profileA = { age: '三十岁成年男声', register: '中低音区', timbre: '低沉略带沙哑' }
const profileB = { age: '二十岁成年女声', register: '中高音区', timbre: '清亮稍带紧涩' }
const cue = (id: string, shot: number, speaker: number, profile = speaker === 1 ? profileA : profileB): StoryboardVoiceCue => ({
  id, shot, speaker_id: speaker, kind: 'dialogue', source_name: '', profile, state: '站在原处', goal: '回应对方', volume: '适中',
  rate_cps: 3, breath: '平稳', tail: '轻收', emotion: '克制',
})
const base = (overrides: Record<string, unknown> = {}) => ({
  shot_number: 2, title: '院中回应', time: '白天', location: '[[scene:10]]的木桌旁', shot_type: '中景', angle: '平视', movement: '固定',
  description: '【镜头1】[[character:1]]站在木桌旁，抬眼，[[voice:v1]]：「回来，一起走。」【镜头2】[[character:2]]抬眼回应，[[voice:v2]]：「好。」',
  result: '两人留在木桌旁。', atmosphere: '晨光。', image_prompt: '[[scene:10]]首镜。',
  video_prompt: '出场人物：[[character:1]]、[[character:2]]；场景：[[scene:10]]。\n0-3秒：A0为门槛，X向东、Y向北。[[character:1]]站在桌旁，抬眼，[[voice:v1]]：「回来，一起走。」\n3-6秒：[[character:1]]放下手看向[[character:2]]。\n6-9秒：切到[[character:2]]近景，抬眼回应，[[voice:v2]]：「好。」',
  bgm_prompt: '无背景音乐', sound_effect: '环境声。', duration: 9, scene_id: 10, character_ids: [], prop_ids: [], source_ids: [3, 4], time_row_counts: [2, 1],
  voice_cues: [cue('v1', 1, 1), cue('v2', 2, 2)], ...overrides,
})
const plan = { number: 2, source_ids: [3, 4], duration: 9, scene_id: 10, source_lines: ['阿甲：回来，一起走。', '阿乙：好。'] }
const errorsOf = (raw: unknown) => {
  const voices = compileStoryboardVoices(raw, { assets, profiles: {}, language: 'zh' })
  const refs = voices.submission ? compileStoryboardReferences(voices.submission, assets) : null
  const checks = refs?.candidate ? validateSkillStoryboard(refs.candidate, assets, { mode: 'breakdown', expected: { number: 2, duration: 9, scene_id: 10, source_ids: [3, 4] } }) : []
  return [...voices.issues, ...(refs?.issues || []), ...checks].filter(issue => issue.severity === 'error').map(issue => issue.code)
}
const run = (raw: unknown) => normalizeSubmission(raw, { established: {}, characters, plan })

test('a clean answer is untouched (same object, no notes), also with plan facts', () => {
  const raw = base()
  const result = run(raw)
  assert.equal(result.raw, raw)
  assert.deepEqual(result.notes, [])
  assert.deepEqual(errorsOf(raw), [])
})

test('real slip: group_number instead of shot_number and source_ids left out are filled from the plan', () => {
  const { shot_number: _s, source_ids: _i, ...rest } = base()
  const raw = { group_number: 2, ...rest }
  assert.ok(errorsOf(raw).includes('storyboard_schema'), 'fails before')
  const result = run(raw)
  assert.equal((result.raw as any).shot_number, 2)
  assert.deepEqual((result.raw as any).source_ids, [3, 4])
  assert.equal(Object.hasOwn(result.raw as object, 'group_number'), false)
  assert.deepEqual(errorsOf(result.raw), [])
})

test('a written value that differs from the plan is never overwritten; the plan check still reports it', () => {
  const raw = base({ source_ids: [3], duration: 12 })
  const result = run(raw)
  assert.deepEqual((result.raw as any).source_ids, [3])
  assert.equal((result.raw as any).duration, 12)
  assert.ok(errorsOf(result.raw).length > 0)
  // A group_number that names another group is not taken as this group's number.
  const wrong = { ...base(), group_number: 5 }
  delete (wrong as any).shot_number
  const kept = run(wrong)
  assert.equal(Object.hasOwn(kept.raw as object, 'group_number'), true)
  assert.equal((kept.raw as any).shot_number, undefined)
})

test('real slip: voice cue character_id / CharacterID / [[character:N]] speaker become speaker_id; kind comes from the original line', () => {
  const raw = base({ voice_cues: [
    (({ speaker_id: _s, kind: _k, source_name: _n, ...rest }) => ({ ...rest, character_id: 1 }))(cue('v1', 1, 1)),
    (({ speaker_id: _s, kind: _k, ...rest }) => ({ ...rest, speaker: '[[character:2]]', role_name: '阿乙' }))(cue('v2', 2, 2)),
  ] })
  assert.ok(errorsOf(raw).includes('voice_cue_schema'), 'fails before')
  const result = run(raw)
  const cues = (result.raw as any).voice_cues
  assert.deepEqual(cues.map((c: any) => [c.speaker_id, c.kind, c.source_name]), [[1, 'dialogue', ''], [2, 'dialogue', '']])
  assert.equal(cues.some((c: any) => 'character_id' in c || 'speaker' in c || 'role_name' in c), false)
  assert.deepEqual(errorsOf(result.raw), [])
})

test('a kind is never guessed: an unclear note such as （电话） or （仅林轩听见） leaves it missing for repair', () => {
  assert.deepEqual([...speakerVoiceKinds(['阿甲（电话）：快回来！'], ['阿甲']).get('阿甲')!], ['unclear'])
  assert.deepEqual([...speakerVoiceKinds(['阿甲（OS）：快回来！'], ['阿甲']).get('阿甲')!], ['offscreen'])
  assert.deepEqual([...speakerVoiceKinds(['旁白：多年以后。', '阿甲（内心独白）：别慌。'], ['阿甲']).get('阿甲')!], ['narration'])
  const raw = base({ voice_cues: [(({ kind: _k, ...rest }) => rest)(cue('v1', 1, 1)), cue('v2', 2, 2)] })
  const phone = normalizeSubmission(raw, { established: {}, characters, plan: { ...plan, source_lines: ['阿甲（电话）：回来，一起走。', '阿乙：好。'] } })
  assert.equal(Object.hasOwn((phone.raw as any).voice_cues[0], 'kind'), false)
  // Mixed kinds for one speaker in the same group are not guessed either.
  const mixed = normalizeSubmission(raw, { established: {}, characters, plan: { ...plan, source_lines: ['阿甲：回来。', '阿甲（OS）：一起走。'] } })
  assert.equal(Object.hasOwn((mixed.raw as any).voice_cues[0], 'kind'), false)
  // An explicit valid kind written under another key is taken.
  const aliased = run(base({ voice_cues: [(({ kind: _k, ...rest }) => ({ ...rest, role: 'dialogue' }))(cue('v1', 1, 1)), cue('v2', 2, 2)] }))
  assert.equal((aliased.raw as any).voice_cues[0].kind, 'dialogue')
})

test('quoted original words, speakers and order are byte-identical after every round-3 fix', () => {
  const { shot_number: _s, source_ids: _i, ...rest } = base()
  const raw = { group_number: 2, ...rest, voice_cues: [(({ speaker_id: _x, kind: _k, source_name: _n, ...r }) => ({ ...r, CharacterID: 1 }))(cue('v1', 1, 1)), cue('v2', 2, 2)] }
  const result = run(raw)
  assert.equal((result.raw as any).description, base().description)
  assert.equal((result.raw as any).video_prompt, base().video_prompt)
  assert.deepEqual(errorsOf(result.raw), [])
})

// Verification run on real models (2026-11-08): gemini wrote numbers as text in 4 of 4 plan answers of one episode
// ("source_ids":["1","2"], "scene_id":"13") and in group answers ("speaker_id":"18", "character_ids":["18","20"]).
test('verification run: numbers written as text are read as numbers; any other text is left for the checks', () => {
  const raw = base({ scene_id: '10', source_ids: ['3', '4'], duration: '9', character_ids: ['1', '2'], time_row_counts: ['2', '1'],
    voice_cues: [{ ...cue('v1', 1, 1), speaker_id: '1', shot: '1', rate_cps: '3.5' }, cue('v2', 2, 2)] })
  assert.ok(errorsOf(raw).length > 0, 'fails before')
  const result = run(raw)
  const value = result.raw as any
  assert.deepEqual([value.scene_id, value.source_ids, value.duration, value.character_ids, value.time_row_counts], [10, [3, 4], 9, [1, 2], [2, 1]])
  assert.deepEqual([value.voice_cues[0].speaker_id, value.voice_cues[0].shot, value.voice_cues[0].rate_cps], [1, 1, 3.5])
  assert.deepEqual(errorsOf(result.raw), [])
  // A name, a word or a negative/decimal ID is not a number by contract and is never guessed.
  const named = run(base({ scene_id: '院落', voice_cues: [{ ...cue('v1', 1, 1), speaker_id: '阿甲' }, { ...cue('v2', 2, 2), speaker_id: '2.5' }] }))
  assert.deepEqual([(named.raw as any).scene_id, (named.raw as any).voice_cues[0].speaker_id, (named.raw as any).voice_cues[1].speaker_id], ['院落', '阿甲', '2.5'])
  assert.ok(errorsOf(named.raw).length > 0)
})

test('verification run: speaker written as speaker_character_id or "character:N" becomes speaker_id; missing binding lists are not guessed', () => {
  const raw: any = base({ voice_cues: [
    (({ speaker_id: _s, ...rest }) => ({ ...rest, speaker_character_id: 1 }))(cue('v1', 1, 1)),
    (({ speaker_id: _s, ...rest }) => ({ ...rest, speaker: 'character:2' }))(cue('v2', 2, 2)),
  ] })
  assert.ok(errorsOf(raw).length > 0, 'fails before')
  const result = run(raw)
  assert.deepEqual((result.raw as any).voice_cues.map((c: any) => c.speaker_id), [1, 2])
  assert.equal((result.raw as any).voice_cues.some((c: any) => 'speaker' in c || 'speaker_character_id' in c), false)
  assert.deepEqual(errorsOf(result.raw), [])
  // A speaker form naming an unknown character is not taken.
  const unknown = run(base({ voice_cues: [(({ speaker_id: _s, ...rest }) => ({ ...rest, speaker: 'character:99' }))(cue('v1', 1, 1)), cue('v2', 2, 2)] }))
  assert.equal(Object.hasOwn((unknown.raw as any).voice_cues[0], 'speaker_id'), false)
  // The plan does not fix the bindings: a missing character_ids / prop_ids list stays missing and goes to repair.
  const unbound: any = base(); delete unbound.character_ids; delete unbound.prop_ids
  const kept = run(unbound)
  assert.equal(Object.hasOwn(kept.raw as object, 'character_ids'), false)
  assert.equal(Object.hasOwn(kept.raw as object, 'prop_ids'), false)
  assert.ok(errorsOf(kept.raw).includes('storyboard_schema'))
})

test('verification run: a narrative plan with numbers written as text is read as numbers; a clean plan is untouched', () => {
  const written = { groups: [{ number: '1', title: '一', beat: 'narrative', source_ids: ['1', '2'], scene_id: '10', duration: '12' }] }
  const result = normalizePlanSubmission(written)
  assert.deepEqual(result.raw, { groups: [{ number: 1, title: '一', beat: 'narrative', source_ids: [1, 2], scene_id: 10, duration: 12 }] })
  assert.equal(result.notes.length, 1)
  const clean = { groups: [{ number: 1, title: '一', beat: 'narrative', source_ids: [1, 2], scene_id: 10, duration: 12 }] }
  assert.equal(normalizePlanSubmission(clean).raw, clean)
  assert.deepEqual(normalizePlanSubmission(clean).notes, [])
  assert.equal((normalizePlanSubmission({ groups: [{ number: '第一组', source_ids: ['开头'] }] }).raw as any).groups[0].number, '第一组')
  const conflict = { conflict: '原文不足', field: 'groups', source_ids: [] }
  assert.equal(normalizePlanSubmission(conflict).raw, conflict)
  // A targeted patch: only the numbers inside `changes` are read; the version and the text stay as written.
  const patch = { base_version: 'v-1', changes: { voice_cues: [{ ...cue('v1', 1, 1), speaker_id: '1' }], time_row_counts: ['2', '1'], description: '「1」' } }
  const read = normalizeRepairPatch(patch).raw as any
  assert.deepEqual([read.base_version, read.changes.voice_cues[0].speaker_id, read.changes.time_row_counts, read.changes.description], ['v-1', 1, [2, 1], '「1」'])
  const cleanPatch = { base_version: 'v-1', changes: { time_row_counts: [2, 1] } }
  assert.equal(normalizeRepairPatch(cleanPatch).raw, cleanPatch)
})
