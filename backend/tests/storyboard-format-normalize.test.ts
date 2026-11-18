import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSubmission } from '../src/services/storyboard-format-normalize.ts'
import { compileStoryboardVoices, type StoryboardVoiceCue } from '../src/services/storyboard-voice-cues.ts'
import { compileStoryboardReferences } from '../src/services/skill-storyboard-contract.ts'
import { skillDescriptionShots, skillSpokenTurns, validateSkillStoryboard } from '../src/services/skill-storyboard-validation.ts'

const characters = [{ id: 1, name: '阿甲' }, { id: 2, name: '阿乙' }]
const assets = { characters, scenes: [{ id: 10, location: '院落' }], props: [] }
const profileA = { age: '三十岁成年男声', register: '中低音区', timbre: '低沉略带沙哑' }
const profileB = { age: '二十岁成年女声', register: '中高音区', timbre: '清亮稍带紧涩' }
const cue = (id: string, shot: number, speaker: number, profile = speaker === 1 ? profileA : profileB): StoryboardVoiceCue => ({
  id, shot, speaker_id: speaker, kind: 'dialogue', source_name: '', profile, state: '站在原处', goal: '回应对方', volume: '适中',
  rate_cps: 3, breath: '平稳', tail: '轻收', emotion: '克制',
})
const base = (overrides: Record<string, unknown> = {}) => ({
  shot_number: 1, title: '院中回应', time: '白天', location: '[[scene:10]]的木桌旁', shot_type: '中景', angle: '平视', movement: '固定',
  description: '【镜头1】[[character:1]]站在木桌旁，抬眼，[[voice:v1]]：「回来，一起走。」【镜头2】[[character:2]]抬眼回应，[[voice:v2]]：「好。」',
  result: '两人留在木桌旁。', atmosphere: '晨光。', image_prompt: '[[scene:10]]首镜。',
  video_prompt: '出场人物：[[character:1]]、[[character:2]]；场景：[[scene:10]]。\n0-3秒：A0为门槛，X向东、Y向北。[[character:1]]站在桌旁，抬眼，[[voice:v1]]：「回来，一起走。」\n3-6秒：[[character:1]]放下手看向[[character:2]]。\n6-9秒：切到[[character:2]]近景，抬眼回应，[[voice:v2]]：「好。」',
  bgm_prompt: '无背景音乐', sound_effect: '环境声。', duration: 9, scene_id: 10, character_ids: [], prop_ids: [], source_ids: [1, 2], time_row_counts: [2, 1],
  voice_cues: [cue('v1', 1, 1), cue('v2', 2, 2)], ...overrides,
})
const passes = (raw: unknown, established = {}) => {
  const voices = compileStoryboardVoices(raw, { assets, profiles: established, language: 'zh' })
  const refs = voices.submission ? compileStoryboardReferences(voices.submission, assets) : null
  const checks = refs?.candidate ? validateSkillStoryboard(refs.candidate, assets) : []
  return { errors: [...voices.issues, ...(refs?.issues || []), ...checks].filter(issue => issue.severity === 'error').map(issue => issue.code), candidate: refs?.candidate }
}
const run = (raw: unknown, established = {}) => normalizeSubmission(raw, { established, characters })

test('a clean submission is returned untouched (same object, no notes)', () => {
  const raw = base()
  const result = run(raw)
  assert.equal(result.raw, raw)
  assert.deepEqual(result.notes, [])
  assert.deepEqual(passes(raw).errors, [])
})

test('real 第2集 g4 slip: line breaks written as the two characters \\n are restored, quotes untouched', () => {
  const good = base()
  const broken = base({ video_prompt: (good.video_prompt as string).replaceAll('\n', '\\n') })
  assert.ok(passes(broken).errors.includes('voice_cue_shot') || passes(broken).errors.length > 0, 'the slip fails as before')
  const result = run(broken)
  assert.equal((result.raw as any).video_prompt, good.video_prompt)
  assert.match(result.notes.join(''), /换行/)
  assert.deepEqual(passes(result.raw).errors, [])
  // A quoted original that literally contains \n is never rewritten.
  const quoted = base({ video_prompt: '出场人物：[[character:1]]；场景：[[scene:10]]。\\n0-3秒：[[voice:v1]]：「写着\\n两个字」' })
  assert.equal(run(quoted).raw, quoted)
})

test('real 第2集 g1 slip: description quotes without anchors get the video anchors by order, the model label is replaced', () => {
  const broken = base({ description: '【镜头1】[[character:1]]站在木桌旁，抬眼，说：「回来，一起走。」【镜头2】[[character:2]]抬眼回应，阿乙说：「好。」' })
  assert.ok(passes(broken).errors.includes('voice_cue_missing'))
  const result = run(broken)
  assert.equal((result.raw as any).description, base().description)
  assert.deepEqual(passes(result.raw).errors, [])
})

test('anchors are not copied when the description words differ from the video words in any way', () => {
  for (const description of [
    '【镜头1】[[character:1]]说：「回来，一起走吧。」【镜头2】[[character:2]]说：「好。」', // changed word
    '【镜头1】[[character:1]]说：「回来，一起走。」【镜头2】无声。', // missing quote
    '【镜头1】[[character:2]]说：「好。」【镜头2】[[character:1]]说：「回来，一起走。」', // different order
  ]) {
    const raw = base({ description })
    assert.equal((run(raw).raw as any).description, description, description)
  }
})

test('a label naming the same speaker right before the anchor is removed; a bare verb or another name is kept', () => {
  const doubled = base({
    description: '【镜头1】[[character:1]]站在木桌旁，抬眼，[[character:1]]说：[[voice:v1]]：「回来，一起走。」【镜头2】抬眼回应，[[character:2]]阿乙[[voice:v2]]：「好。」',
    video_prompt: '出场人物：[[character:1]]、[[character:2]]；场景：[[scene:10]]。\n0-3秒：A0为门槛，X向东、Y向北。[[character:1]]站在桌旁，抬眼，阿甲说：[[voice:v1]]：「回来，一起走。」\n3-6秒：[[character:1]]放下手看向[[character:2]]。\n6-9秒：切到[[character:2]]近景，[[character:2]][[voice:v2]]：「好。」',
  })
  const result = run(doubled)
  const description = (result.raw as any).description as string, video = (result.raw as any).video_prompt as string
  assert.ok(description.includes('抬眼，[[voice:v1]]：「回来'), description)
  assert.ok(description.includes('抬眼回应，[[voice:v2]]：「好'), description)
  assert.ok(video.includes('抬眼，[[voice:v1]]：「回来'), video)
  assert.ok(video.includes('近景，[[voice:v2]]：「好'), video)
  const compiled = passes(result.raw)
  assert.deepEqual(compiled.errors, [])
  assert.equal(/阿甲说[：:]\s*@?阿甲说/u.test(compiled.candidate!.description) || /@阿甲@阿甲说/u.test(compiled.candidate!.description), false)
  // Bare verb and another speaker's name stay.
  const kept = base({ description: '【镜头1】[[character:2]]看着他，[[character:1]]接着说：[[voice:v1]]：「回来，一起走。」【镜头2】阿甲看向[[character:2]][[voice:v2]]：「好。」' })
  const keptResult = (run(kept).raw as any).description as string
  assert.ok(keptResult.includes('接着说：[[voice:v1]]'), keptResult)
  assert.ok(keptResult.includes('看向[[character:2]][[voice:v2]]') === false, 'the same-speaker token before v2 is removed')
  assert.ok(keptResult.includes('阿甲看向'), 'another name in prose is untouched')
})

test('real 第5集 g1 slip: a re-worded fixed voice uses the established wording; delivery stays the model\'s', () => {
  const established = { 'character:1': profileA }
  const reworded = base({ voice_cues: [{ ...cue('v1', 1, 1, { age: '三十岁上下', register: '低沉宽厚音域', timbre: '粗粝沉实' }), emotion: '沉怒' }, cue('v2', 2, 2)] })
  assert.ok(passes(reworded, established).errors.includes('voice_profile_conflict'))
  const result = run(reworded, established)
  const fixed = (result.raw as any).voice_cues[0]
  assert.deepEqual(fixed.profile, profileA)
  assert.equal(fixed.emotion, '沉怒')
  assert.deepEqual(passes(result.raw, established).errors, [])
  // Without an established voice nothing is changed.
  assert.equal(run(reworded, {}).raw, reworded)
})

test('every original quoted word, speaker and order survives all fixes together', () => {
  const messy = base({
    description: '【镜头1】[[character:1]]站在木桌旁，抬眼，说：「回来，一起走。」【镜头2】[[character:2]]抬眼回应，阿乙说：「好。」',
    video_prompt: (base().video_prompt as string).replace('抬眼，[[voice:v1]]', '抬眼，[[character:1]]说：[[voice:v1]]').replaceAll('\n', '\\n'),
    voice_cues: [cue('v1', 1, 1, { age: '三十岁上下男声', register: '中低音', timbre: '低沉沙哑略重' }), cue('v2', 2, 2)],
  })
  const result = run(messy, { 'character:1': profileA })
  const compiled = passes(result.raw, { 'character:1': profileA })
  assert.deepEqual(compiled.errors, [])
  const speech = skillDescriptionShots(compiled.candidate!.description).flatMap(shot => skillSpokenTurns(shot.text, characters.map(c => c.name)))
  assert.deepEqual(speech.map(turn => [turn.speakerName, turn.text]), [['阿甲', '回来，一起走。'], ['阿乙', '好。']])
  assert.equal(result.notes.length, 4)
})
