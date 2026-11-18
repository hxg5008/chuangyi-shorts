import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { buildVoiceCueSchema, compileStoryboardVoices, type StoryboardVoiceCue } from '../src/services/storyboard-voice-cues.ts'
import { compileStoryboardReferences } from '../src/services/skill-storyboard-contract.ts'
import { skillDescriptionShots, skillSpokenTurns, validateSkillStoryboard } from '../src/services/skill-storyboard-validation.ts'

const assets = { characters: [{ id: 1, name: '阿甲' }, { id: 2, name: '阿乙' }], scenes: [{ id: 10, location: '院落' }], props: [{ id: 20, name: '木杯' }] }
const cue = (id = 'v1', shot = 1, overrides: Partial<StoryboardVoiceCue> = {}): StoryboardVoiceCue => ({
  id, shot, speaker_id: 1, kind: 'dialogue', source_name: '', profile: { age: '三十岁成年男声', register: '中低音区', timbre: '低沉略带沙哑' },
  state: '站在桌旁保持原姿态', goal: '平静回应对方', volume: '适中', rate_cps: 2.5, breath: '平稳', tail: '轻收', emotion: '克制温和', ...overrides,
})
const raw = (overrides: Record<string, unknown> = {}) => ({
  shot_number: 1, title: '院中回应', time: '白天', location: '[[scene:10]]的木桌旁', shot_type: '中景＋近景', angle: '平视', movement: '固定后轻推',
  description: '【镜头1】[[character:1]]站在木桌旁，抬眼，[[voice:v1]]：「回来，」随后放下手，[[voice:v1]]：「一起走。」【镜头2】[[character:2]]抬眼回应，[[voice:v2]]：「好。」',
  result: '两人留在原木桌旁，木杯原位。', atmosphere: '既有晨光及雨后环境声。', image_prompt: '[[scene:10]]首镜单帧，[[character:1]]站在木桌旁。',
  video_prompt: '出场人物：[[character:1]]、[[character:2]]；场景：[[scene:10]]。\r\n0-3秒：A0为门槛，X向东、Y向北。[[character:1]]站在桌旁，抬眼，[[voice:v1]]：「回来，」\r\n3-6秒：[[character:1]]放下手，[[voice:v1]]：「一起走。」\r\n6-9秒：切到[[character:2]]平视近景，抬眼回应，[[voice:v2]]：「好。」',
  bgm_prompt: '无背景音乐', sound_effect: '原有环境声与脚步声。', duration: 9, scene_id: 10, character_ids: [], prop_ids: [], source_ids: [1, 2], time_row_counts: [2, 1],
  voice_cues: [cue(), cue('v2', 2, { speaker_id: 2, profile: { age: '二十岁成年女声', register: '中高音区', timbre: '清亮稍带紧涩' }, state: '站在原位抬头', goal: '答应同行', emotion: '谨慎轻松' })],
  ...overrides,
})
const compile = (value = raw(), options: Partial<Parameters<typeof compileStoryboardVoices>[1]> = {}) => compileStoryboardVoices(value, { assets, ...options })
const errorCodes = (value: ReturnType<typeof compile>) => value.issues.map(issue => issue.code)

test('one cue per speaking child renders complete voice data once, keeps every original word and makes attribution explicit', () => {
  const original = raw(), snapshot = structuredClone(original), compiled = compile(original)
  assert.deepEqual(compiled.issues, [])
  assert.ok(compiled.submission)
  assert.deepEqual(original, snapshot)
  assert.equal(Object.hasOwn(compiled.submission, 'voice_cues'), false)
  const result = compileStoryboardReferences(compiled.submission, assets)
  assert.deepEqual(result.issues, [])
  assert.ok(result.candidate)
  assert.deepEqual(validateSkillStoryboard(result.candidate, assets).filter(issue => issue.severity === 'error'), [])
  const speech = skillDescriptionShots(result.candidate.description).flatMap(shot => skillSpokenTurns(shot.text, assets.characters.map(row => row.name)))
  assert.deepEqual(speech.map(({ speakerName, kind, text }) => ({ speakerName, kind, text })), [
    { speakerName: '阿甲', kind: 'dialogue', text: '回来，' }, { speakerName: '阿甲', kind: 'dialogue', text: '一起走。' }, { speakerName: '阿乙', kind: 'dialogue', text: '好。' },
  ])
  assert.equal(result.candidate.video_prompt.split('三十岁成年男声、中低音区、低沉略带沙哑').length - 1, 1)
  for (const detail of ['站在桌旁保持原姿态', '平静回应对方', '音量适中', '每秒2.5字', '气息平稳', '尾音轻收', '情绪克制温和']) assert.ok(result.candidate.video_prompt.includes(detail), detail)
  assert.ok(result.candidate.video_prompt.includes('\r\n3-6秒'))
  for (const field of ['result', 'duration', 'scene_id', 'time_row_counts', 'image_prompt']) assert.deepEqual(compiled.submission[field], original[field as keyof typeof original])
  assert.deepEqual(result.candidate.character_ids, [1, 2])
})

test('legacy drafts remain unchanged and empty silent scenes do not manufacture a voice', () => {
  const legacy = raw(); delete (legacy as any).voice_cues
  assert.deepEqual(compile(legacy).submission, legacy)
  const silent = raw({ voice_cues: [], description: '【镜头1】木杯留在桌面。【镜头2】原有晨光静止。',
    video_prompt: '出场人物：无；场景：[[scene:10]]。\n0-3秒：A0为门槛，X向东Y向北，[[prop:20]]留在桌面。\n3-6秒：[[prop:20]]原位。\n6-9秒：[[scene:10]]原有晨光。' })
  const compiled = compile(silent)
  assert.deepEqual(compiled.issues, [])
  assert.equal((compiled.submission!.video_prompt as string).includes('音量'), false)
})

test('all acoustic and delivery properties are required and the wire schema stays strict', () => {
  const fields = ['profile', 'state', 'goal', 'volume', 'rate_cps', 'breath', 'tail', 'emotion']
  for (const field of fields) {
    const item: any = cue(); delete item[field]
    assert.equal(buildVoiceCueSchema(assets).safeParse([item]).success, false, field)
  }
  for (const field of ['age', 'register', 'timbre']) {
    const item: any = cue(); delete item.profile[field]
    assert.equal(buildVoiceCueSchema(assets).safeParse([item]).success, false, field)
  }
  assert.equal(buildVoiceCueSchema(assets).safeParse([cue('v1', 1, { speaker_id: 99 })]).success, false)
  assert.equal(buildVoiceCueSchema(assets).safeParse([cue(), cue()]).success, false)
  assert.equal(buildVoiceCueSchema(assets).safeParse([cue('v1', 1, { profile: { age: '男', register: '低', timbre: '哑' } })]).success, false)
  assert.equal(buildVoiceCueSchema(assets).safeParse([{ ...cue(), VoiceID: 'invented' }]).success, false)
  for (const value of ['待定', '待绑定', '同上', 'unknown']) assert.equal(buildVoiceCueSchema(assets).safeParse([cue('v1', 1, { breath: value })]).success, false, value)
  const wire: any = z.toJSONSchema(buildVoiceCueSchema(assets), { io: 'input' })
  assert.equal(wire.items.additionalProperties, false)
  for (const field of fields) assert.ok(wire.items.required.includes(field), field)
})

test('same-person profiles are stable across children, presentation kinds and later groups', () => {
  const one = compile()
  assert.deepEqual(one.profiles['character:1'], cue().profile)
  const changed = raw({ voice_cues: [cue('v1', 1, { kind: 'offscreen', profile: { ...cue().profile, timbre: '清亮略带气声' } }), cue('v2', 2, { speaker_id: 2 })] })
  const output = compile(changed, { profiles: one.profiles })
  assert.ok(errorCodes(output).includes('voice_profile_conflict'))
  assert.equal(output.submission, null)
  assert.deepEqual(output.profiles, one.profiles, 'A rejected response cannot poison the registry')
})

test('an in-scene voice requires an explicit ID and null sources cannot bypass a registered character or use pronouns', () => {
  const schema = buildVoiceCueSchema(assets)
  const unnamedVisible = cue('v1', 1, { speaker_id: null, source_name: '门边顾客', kind: 'dialogue' })
  assert.equal(schema.safeParse([unnamedVisible]).success, false)
  for (const kind of ['offscreen', 'narration'] as const) {
    const registered = cue('v1', 1, { speaker_id: null, source_name: '阿甲', kind })
    const checked = schema.safeParse([registered])
    assert.equal(checked.success, false, kind)
    if (!checked.success) assert.ok(checked.error.issues.some(issue => issue.path.at(-1) === 'speaker_id'))
    for (const name of ['他', '她', '某人', '有人', 'someone']) assert.equal(schema.safeParse([cue('v1', 1, { speaker_id: null, source_name: name, kind })]).success, false, `${kind}: ${name}`)
  }
  const external = cue('v1', 1, { speaker_id: null, source_name: '院外广播', kind: 'offscreen' })
  assert.equal(schema.safeParse([external]).success, true)
  const before = structuredClone(unnamedVisible)
  const rejected = compile(raw({ voice_cues: [unnamedVisible, cue('v2', 2, { speaker_id: 2 })] }))
  assert.equal(rejected.submission, null)
  assert.deepEqual(unnamedVisible, before)
  assert.deepEqual(rejected.profiles, {}, 'Rejected identities neither infer an ID nor add a profile')
})

test('explicit offscreen and narration sources stay distinct and do not invent a character binding or VoiceID', () => {
  const value = raw({ voice_cues: [cue('v1', 1, { kind: 'offscreen' }), cue('v2', 2, { speaker_id: null, kind: 'narration', source_name: '旁白' })] })
  const result = compile(value), assetResult = compileStoryboardReferences(result.submission, assets)
  assert.deepEqual(result.issues, [])
  const turns = skillDescriptionShots(assetResult.candidate!.description).flatMap(shot => skillSpokenTurns(shot.text, assets.characters.map(row => row.name)))
  assert.deepEqual(turns.map(turn => turn.kind), ['offscreen', 'offscreen', 'narration'])
  assert.equal(turns[0].speakerName, '阿甲')
  assert.equal(turns[2].speakerName, undefined)
  assert.equal(JSON.stringify(result.submission).includes('VoiceID'), false)
  assert.equal(buildVoiceCueSchema(assets).safeParse([cue('x', 1, { speaker_id: null, source_name: '' })]).success, false)
})

test('cue identity never comes from nearby visual actors, expected words or a different child', () => {
  const value = raw({ description: '【镜头1】[[character:2]]在门边，[[voice:v1]]：「回来，」[[voice:v1]]：「一起走。」【镜头2】[[voice:v2]]：「好。」' })
  const result = compile(value), assetResult = compileStoryboardReferences(result.submission, assets)
  const turns = skillDescriptionShots(assetResult.candidate!.description).flatMap(shot => skillSpokenTurns(shot.text, ['阿甲', '阿乙']))
  assert.equal(turns[0].speakerName, '阿甲', 'The declared cue, not the nearest visual name, controls attribution')
  value.voice_cues = [cue('v1', 2), cue('v2', 2, { speaker_id: 2 })]
  assert.ok(errorCodes(compile(value)).includes('voice_cue_shot'))
})

test('a cross-child cue ID typo aliases only to the unique identical voice already declared for that actual child', () => {
  const second = cue('v2', 2, { state: '留在原位指向道路', goal: '说明后续方向', tail: '平稳收束', emotion: '坚定' })
  const correct = raw({
    voice_cues: [cue(), second],
    description: '【镜头1】[[character:1]]抬眼，[[voice:v1]]：「回来，」随后说完，[[voice:v1]]：「一起走。」【镜头2】[[character:1]]前指道路，[[voice:v2]]：「路就在前面。」',
  })
  correct.video_prompt = correct.video_prompt.replaceAll('[[character:2]]', '[[character:1]]').replace('「好。」', '「路就在前面。」')
  const typo = structuredClone(correct)
  typo.description = typo.description.replace('[[voice:v2]]', '[[voice:v1]]')
  typo.video_prompt = typo.video_prompt.replace('[[voice:v2]]', '[[voice:v1]]')
  const before = structuredClone(typo)
  const actual = compile(typo), expected = compile(correct)
  assert.deepEqual(actual.issues, [])
  assert.deepEqual(actual.submission, expected.submission)
  assert.deepEqual(actual.profiles, expected.profiles)
  assert.deepEqual(actual.metadata, expected.metadata)
  assert.deepEqual(actual.referenceAliases, [
    { field: 'description', from: 'v1', to: 'v2', shot: 2 }, { field: 'video_prompt', from: 'v1', to: 'v2', shot: 2 },
  ])
  assert.ok((actual.submission!.video_prompt as string).includes('留在原位指向道路'))
  assert.deepEqual(typo, before, 'The raw transport and every declared voice property remain unchanged')
  assert.deepEqual(compile(typo), actual, 'Recompiling the unchanged raw typo is deterministic and idempotent')
})

test('cue aliasing never resolves a different actor, type, source, profile or a child with multiple declared cues', () => {
  const shared = raw({ voice_cues: [cue(), cue('v2', 2)] })
  shared.description = shared.description.replace('[[voice:v2]]', '[[voice:v1]]')
  shared.video_prompt = shared.video_prompt.replace('[[voice:v2]]', '[[voice:v1]]')
  const variants = [
    [cue(), cue('v2', 2, { speaker_id: 2 })],
    [cue(), cue('v2', 2, { kind: 'offscreen' })],
    [cue(), cue('v2', 2, { source_name: '另一来源' })],
    [cue(), cue('v2', 2, { profile: { ...cue().profile, timbre: '清亮略带气声' } })],
    [cue(), cue('v2', 2), cue('v3', 2, { speaker_id: 2 })],
    [cue()],
  ]
  for (const cues of variants) {
    const value = { ...shared, voice_cues: cues }, before = structuredClone(value), result = compile(value)
    assert.equal(result.submission, null)
    assert.ok(errorCodes(result).includes('voice_cue_shot'))
    assert.equal(result.referenceAliases, undefined)
    assert.deepEqual(value, before)
  }
  const unknown = { ...shared, description: shared.description.replace('[[voice:v1]]', '[[voice:missing]]') }
  assert.ok(errorCodes(compile(unknown)).includes('voice_cue_unknown'))
})

test('unknown, unused, misplaced or cross-line anchors fail without rewriting any original field', () => {
  for (const transform of [
    (value: ReturnType<typeof raw>) => { value.description = value.description.replace('[[voice:v1]]', '[[voice:unknown]]') },
    (value: ReturnType<typeof raw>) => { value.video_prompt = value.video_prompt.replaceAll('[[voice:v2]]', '阿乙说') },
    (value: ReturnType<typeof raw>) => { value.video_prompt = value.video_prompt.replace('[[voice:v1]]：', '[[voice:v1]]：\n') },
    (value: ReturnType<typeof raw>) => { value.description = value.description.replace('[[voice:v1]]', '[[voice:v1]') },
  ]) {
    const value = raw(); transform(value); const before = structuredClone(value), result = compile(value)
    assert.equal(result.submission, null)
    assert.ok(result.issues.length)
    assert.deepEqual(value, before)
  }
})

test('spoken quotes without a cue cannot pass by matching words or leaving the speaker unknown', () => {
  const value = raw({ description: '【镜头1】阿甲抬眼，以低沉沙哑的声音缓缓地说：「回来，」她接着说：「一起走。」【镜头2】[[voice:v2]]：「好。」' })
  const result = compile(value)
  assert.ok(errorCodes(result).includes('voice_cue_missing'))
  assert.equal(result.submission, null)
})

test('visual quotes and literal anchor syntax inside original speech stay literal, never become more dialogue', () => {
  const value = raw()
  value.description = value.description.replace('抬眼，', '抬眼，木牌写着「回家」，').replace('回来，', '原词含[[voice:not-a-cue]]，')
  value.video_prompt = value.video_prompt.replace('回来，', '原词含[[voice:not-a-cue]]，')
  const result = compile(value)
  assert.deepEqual(result.issues, [])
  assert.ok((result.submission!.description as string).includes('木牌写着「回家」'))
  assert.ok((result.submission!.video_prompt as string).includes('「原词含[[voice:not-a-cue]]，」'))
  const visual = raw({ description: '【镜头1】木牌写着[[voice:v1]]：「回来，」[[voice:v1]]：「一起走。」【镜头2】[[voice:v2]]：「好。」' })
  assert.ok(errorCodes(compile(visual)).includes('voice_anchor_visual_quote'))
})

test('anchored prior speech provides context for a quoted delivery reference without altering that reference', () => {
  const value = raw()
  const phrase = '孩子就留在这里，'
  value.description = value.description.replace('回来，', phrase).replace('随后放下手，', '随后她说“孩子”时下颌轻压，听到“英子”后目光移向门边，放下手，')
  value.video_prompt = value.video_prompt.replace('回来，', phrase).replace('[[character:1]]放下手，', '她说“孩子”时下颌轻压，听到“英子”后目光移向门边，[[character:1]]放下手，')
  const before = structuredClone(value), result = compile(value)
  assert.deepEqual(result.issues, [])
  for (const field of ['description', 'video_prompt'] as const) {
    assert.ok((result.submission![field] as string).includes('她说“孩子”时下颌轻压'))
    assert.ok((result.submission![field] as string).includes('听到“英子”后目光移向门边'))
  }
  assert.deepEqual(value, before)
  const mapped = compileStoryboardReferences(result.submission, assets)
  assert.deepEqual(mapped.issues, [])
  const turns = skillDescriptionShots(mapped.candidate!.description).flatMap(shot => skillSpokenTurns(shot.text, ['阿甲', '阿乙']))
  assert.deepEqual(turns.map(turn => turn.text), [phrase, '一起走。', '好。'])
})

test('a new unanchored line or real duplicate still fails even after an anchored utterance is provisionally recognized', () => {
  for (const inserted of ['她说“孩子”。', '她说“别走”时手停住。', '阿甲说：「孩子就留在这里，」']) {
    const value = raw()
    value.description = value.description.replace('回来，', '孩子就留在这里，').replace('随后放下手，', `${inserted}随后放下手，`)
    value.video_prompt = value.video_prompt.replace('回来，', '孩子就留在这里，')
    const before = structuredClone(value), result = compile(value)
    assert.ok(errorCodes(result).includes('voice_cue_missing'), inserted)
    assert.equal(result.submission, null, inserted)
    assert.deepEqual(value, before)
  }
})

test('prompt-only submissions compile their declared video cues while a locked description is not required as output', () => {
  const value = raw(), prompt = { video_prompt: value.video_prompt, time_row_counts: value.time_row_counts, voice_cues: value.voice_cues }
  const result = compileStoryboardVoices(prompt, { assets })
  assert.deepEqual(result.issues, [])
  assert.deepEqual(Object.keys(result.submission!).sort(), ['time_row_counts', 'video_prompt'])
})

test('localized explicit voice labels retain exact formal names and presentation kinds without introducing apostrophe quotes', () => {
  for (const language of ['en', 'ja', 'ko']) {
    const value = raw({ voice_cues: [cue('v1', 1, { kind: 'offscreen' }), cue('v2', 2, { speaker_id: 2, kind: 'narration' })] })
    const result = compile(value, { language })
    assert.deepEqual(result.issues, [], language)
    const mapped = compileStoryboardReferences(result.submission, assets)
    assert.deepEqual(mapped.issues, [], language)
    const turns = skillDescriptionShots(mapped.candidate!.description).flatMap(shot => skillSpokenTurns(shot.text, ['阿甲', '阿乙']))
    assert.deepEqual(turns.map(turn => ({ speaker: turn.speakerName, kind: turn.kind })), [
      { speaker: '阿甲', kind: 'offscreen' }, { speaker: '阿甲', kind: 'offscreen' }, { speaker: '阿乙', kind: 'narration' },
    ], language)
  }
})
