import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractStoryboardDialogue, validateStoryboard, type StoryboardValidationInput } from '../src/services/storyboard-validation.ts'
import { buildDialogueTimingGuide, buildDialogueGroupSchedule } from '../src/services/first-pass-instructions.ts'
import { compileScheduledSegment } from '../src/services/scheduled-storyboard-segment.ts'
import { resolveSourceDialoguePlan } from '../src/services/source-dialogue-plan.ts'
import { renderVideoPromptPlan } from '../src/services/video-prompt-plan.ts'

const header = '出场人物：@阿甲；场景：@院落。无字幕、无背景音乐，保留对白和必要音效；同一现实空间每名人物唯一，不出现克隆人或复制人；不越轴，动作流畅，五官与眼神清晰。'
const first = '0-3秒：@院落以门槛为固定原点A0，X轴向东为正，Y轴向北为正。@阿甲站在A(X+1米，Y+1米)，正面中景，神情平静（情绪60%），抬眼望向院门，固定镜头保持3秒。'
const second = '3-6秒：切到@阿甲正面近景，神情笃定（情绪70%），轻眨后点头，左手随呼吸松开。'
const third = '6-9秒：@阿甲延续点头末态，左手放下，面向院门准备迈步，日光方向保持。'
const fixture = (overrides: Partial<StoryboardValidationInput> = {}): StoryboardValidationInput => ({
  storyboardId: 11, shotNumber: 1, duration: 9,
  description: '【镜头1】阿甲正面中景，站在院内抬眼。【镜头2】阿甲正面近景，点头后放下手。',
  videoPrompt: [header, first, second, third].join('\n'),
  characters: [{ id: 1, name: '阿甲' }], scenes: [{ id: 1, location: '院落' }], props: [],
  characterIds: [1], sceneId: 1, propIds: [], ...overrides,
})
const errors = (input: StoryboardValidationInput) => validateStoryboard(input).filter(issue => issue.severity === 'error')
const codes = (input: StoryboardValidationInput) => errors(input).map(issue => issue.code)

test('a valid candidate passes structural checks and explicitly retains semantic review warning', () => {
  assert.deepEqual(errors(fixture()), [])
  const issues = validateStoryboard(fixture())
  assert.ok(issues.some(issue => issue.code === 'semantic_review_required' && issue.severity === 'warning'))
  assert.ok(issues.every(issue => issue.storyboardId === 11 && issue.shotNumber === 1 && issue.field))
})

test('duration and description shot count/order are validated independently of prompt text', () => {
  for (const duration of [0, 7, 16, NaN, Infinity]) assert.ok(codes(fixture({ duration })).includes('duration_range'))
  assert.ok(codes(fixture({ description: '没有编号的描述' })).includes('shot_count'))
  assert.ok(codes(fixture({ description: '【镜头1】正面。【镜头3】近景。' })).includes('shot_order'))
  assert.ok(codes(fixture({ description: '【镜头1】【镜头2】近景。' })).includes('shot_order'))
})

test('dialogue budget counts quoted Chinese dialogue and unquoted narration without charging visual prose', () => {
  assert.ok(codes(fixture({ description: `【镜头1】阿甲说：「${'好'.repeat(40)}」。【镜头2】阿甲点头。` })).includes('dialogue_budget'))
  assert.ok(codes(fixture({ description: `【镜头1】旁白：${'好'.repeat(40)}。【镜头2】阿甲点头。` })).includes('dialogue_budget'))
  assert.equal(codes(fixture({ description: `【镜头1】阿甲正面中景，${'看向院门'.repeat(60)}。【镜头2】阿甲正面近景。` })).includes('dialogue_budget'), false)
})

test('empty and oversized prompts, missing information header and global constraints are hard errors', () => {
  assert.ok(codes(fixture({ videoPrompt: '  ' })).includes('prompt_empty'))
  assert.ok(codes(fixture({ videoPrompt: fixture().videoPrompt + '。'.repeat(3601) })).includes('prompt_length'))
  assert.ok(codes(fixture({ videoPrompt: [first, second, third].join('\n') })).includes('information_header'))
  assert.ok(codes(fixture({ videoPrompt: ['出场人物：@阿甲；场景：@院落。', first, second, third].join('\n') })).includes('global_constraints'))
})

test('three-second timeline is contiguous, complete and keeps the final actual remainder', () => {
  const eight = fixture({ duration: 8, videoPrompt: [header, first, second, third.replace('6-9秒', '6-8秒')].join('\n') })
  assert.deepEqual(errors(eight), [])
  assert.ok(codes(fixture({ videoPrompt: [header, first, second.replace('3-6秒', '4-6秒'), third].join('\n') })).includes('time_axis'))
  assert.ok(codes(fixture({ videoPrompt: [header, first, second].join('\n') })).includes('time_row_count'))
  assert.ok(codes(fixture({ videoPrompt: [header, '额外制作说明', first, second, third].join('\n') })).includes('time_row_format'))
  assert.ok(codes(fixture({ duration: 8 })).includes('time_axis'))
})

test('shot mapping requires a clear cut boundary, preserves one or two time rows per description shot', () => {
  assert.ok(codes(fixture({ videoPrompt: [header, first, second.replace('切到', ''), third].join('\n') })).includes('shot_time_mapping'))
  assert.ok(codes(fixture({ videoPrompt: [header, first, second, third.replace('：', '：切回')].join('\n') })).includes('shot_time_mapping'))
  assert.ok(codes(fixture({ videoPrompt: [header, first, second + '切回院门。', third].join('\n') })).includes('multiple_cuts_in_row'))
})

test('synonymous leading cuts and quoted, negated or metaphorical mentions do not introduce extra shot boundaries', () => {
  const row = second.replace('切到', '切到，切换至') + '话锋切至旧事，纸上的字是「切回门口」。'
  for (const continuation of ['不切回门口。', 'Do not cut back to the door.', 'カットバックはしない。', '컷 전환하지 않는다.']) {
    assert.deepEqual(errors(fixture({ videoPrompt: [header, first, row, third + continuation].join('\n') })), [], continuation)
  }
})

test('ignoring non-cuts neither bypasses required mapping nor hides a real later cut', () => {
  const missingBoundary = [header, first, second.replace('切到', '不切回'), third].join('\n')
  assert.ok(codes(fixture({ videoPrompt: missingBoundary })).includes('shot_time_mapping'))
  const secondCut = second + '不要切回门口；话锋切至旧事，随后切回@阿甲中景。'
  assert.ok(codes(fixture({ videoPrompt: [header, first, secondCut, third].join('\n') })).includes('multiple_cuts_in_row'))
  const thirdShot = third.replace('：', '：切回')
  assert.ok(codes(fixture({ videoPrompt: [header, first, second, thirdShot].join('\n') })).includes('shot_time_mapping'), 'a genuine third shot still cannot fit a two-shot description')
})

test('references must name bound assets on every time row, while names with shared prefixes remain usable', () => {
  assert.ok(codes(fixture({ videoPrompt: [header, first, second.replace('@阿甲', '@陌生人'), third].join('\n') })).includes('unknown_reference'))
  assert.ok(codes(fixture({ videoPrompt: [header, first, second, third.replace('@阿甲', '阿甲')].join('\n') })).includes('missing_reference'))
  assert.ok(codes(fixture({ characterIds: [] })).includes('unknown_reference'))
  assert.ok(codes(fixture({ videoPrompt: [header.replace('@阿甲', '@图片1'), first, second, third].join('\n') })).includes('unknown_reference'))
  const prefix = fixture({ characters: [{ id: 1, name: '阿' }, { id: 2, name: '阿甲' }], characterIds: [2] })
  assert.deepEqual(errors(prefix), [])
  assert.ok(codes({ ...prefix, characterIds: [1] }).includes('unknown_reference'))
  assert.ok(codes(fixture({ sceneId: undefined })).includes('unknown_reference'))
})

test('the first time row needs A0, X and Y, not a separate coordinate table or an ungrounded continuation', () => {
  assert.ok(codes(fixture({ videoPrompt: [header, first.replace('A0', '门边'), second, third].join('\n') })).includes('spatial_origin'))
  assert.ok(codes(fixture({ videoPrompt: [header, first.replaceAll('Y', '纵深'), second, third].join('\n') })).includes('spatial_origin'))
})

test('visible close-up characters need their own emotion percentages rather than borrowing another character percentage', () => {
  assert.ok(codes(fixture({ videoPrompt: [header, first, second.replace('（情绪70%）', ''), third].join('\n') })).includes('emotion_percentage'))
  const two = fixture({
    characters: [{ id: 1, name: '阿甲' }, { id: 2, name: '阿乙' }], characterIds: [1, 2],
    description: '【镜头1】阿甲与阿乙正面中景，二人抬眼。【镜头2】阿甲正面近景，点头。',
    videoPrompt: [header, first + '@阿乙正面入镜，低头看手。', second, third].join('\n'),
  })
  assert.ok(validateStoryboard(two).some(issue => issue.code === 'emotion_percentage' && issue.message.includes('阿乙') && issue.severity === 'error'))
})

test('a gaze target does not inherit another character close-up and force a visible expression', () => {
  const gaze = fixture({
    characters: [{ id: 1, name: '陈默' }, { id: 2, name: '林小雨' }], characterIds: [1, 2],
    description: '【镜头1】陈默正面中景，林小雨正面中景，二人抬眼。【镜头2】陈默正面近景，点头。',
    videoPrompt: [
      header.replace('@阿甲', '@陈默、@林小雨'),
      first.replaceAll('@阿甲', '@陈默') + '@林小雨正面中景，神情平静（情绪55%），看向院门。',
      '3-6秒：切到@陈默正面近景，平静（情绪65%），追视林小雨后点头。',
      third.replaceAll('@阿甲', '@陈默'),
    ].join('\n'),
  })
  assert.deepEqual(errors(gaze), [])
})

function bedsideGazeCandidate(visual: string): StoryboardValidationInput {
  const observer = '老年高大山', target = '老年张晓茹'
  return fixture({
    characters: [{ id: 1, name: observer }, { id: 2, name: target }], characterIds: [1, 2],
    description: `【镜头1】${observer}正面近景。${visual}【镜头2】${observer}正面近景，点头后放下手。`,
    videoPrompt: [
      header.replace('@阿甲', `@${observer}`),
      `0-3秒：@院落以门槛为固定原点A0，X轴向东为正，Y轴向北为正。@${observer}正面近景。${visual} @${observer}神情紧张（情绪90%）。`,
      second.replaceAll('@阿甲', `@${observer}`), third.replaceAll('@阿甲', `@${observer}`),
    ].join('\n'),
    shotParticipants: [{ shotNumber: 1, characterId: 1, visibility: 'face_visible' }, { shotNumber: 2, characterId: 1, visibility: 'face_visible' }],
  })
}

test('a qualified bedside gaze target does not inherit the observer following eyelid or brow actions', () => {
  for (const visual of [
    '他先追视床侧的@老年张晓茹，眼睑一颤，眉心拧紧后缓缓吐气。',
    '他先追视床侧的老年张晓茹，眼睑一颤，眉心拧紧后缓缓吐气。',
    '他视线从@老年张晓茹脸上移开，眼睑一颤，眉心拧紧。',
    '他视线从水杯转回@老年张晓茹方向。',
    '他视线停在@老年张晓茹脸上。',
  ]) {
    const candidate = bedsideGazeCandidate(visual)
    assert.deepEqual(errors(candidate), [], visual)
    assert.equal(validateStoryboard(candidate).some(issue => issue.code === 'emotion_percentage'
      && issue.message.includes('老年张晓茹') && issue.severity === 'error'), false, visual)
  }
})

test('legacy text-only gaze target own acting or visible framing still requires its own emotion percentage', () => {
  for (const visual of [
    '他先追视床侧的@老年张晓茹正眨眼。',
    '他先追视床侧的@老年张晓茹表情变化。',
    '他先追视床侧的@老年张晓茹的眼睑一颤。',
    '他先追视床侧的@老年张晓茹的双眼正眨动。',
    '他先追视床侧的@老年张晓茹抬手，正脸清晰入镜。',
    '他先追视床侧的@老年张晓茹的正脸特写。',
    '他先追视床侧的老年张晓茹正眨眼。',
  ]) {
    const candidate = bedsideGazeCandidate(visual)
    candidate.shotParticipants = undefined
    assert.ok(validateStoryboard(candidate).some(issue => issue.code === 'emotion_percentage'
      && issue.message.includes('老年张晓茹') && issue.severity === 'error'), visual)
  }
})

test('conjunctions cannot exempt another visible person and planned visible targets still need an emotion', () => {
  for (const join of ['与', '和', '跟']) {
    const candidate = bedsideGazeCandidate(`他${join}@老年张晓茹正面近景，眼睑一颤。`)
    candidate.shotParticipants = undefined
    assert.ok(validateStoryboard(candidate).some(issue => issue.code === 'emotion_percentage'
      && issue.message.includes('老年张晓茹') && issue.severity === 'error'), join)
  }
  const candidate = bedsideGazeCandidate('他先追视床侧的@老年张晓茹，眼睑一颤，眉心拧紧。')
  candidate.shotParticipants!.push({ shotNumber: 1, characterId: 2, visibility: 'face_visible' })
  assert.ok(validateStoryboard(candidate).some(issue => issue.code === 'emotion_percentage'
    && issue.message.includes('老年张晓茹') && issue.severity === 'error'))
})

test('explicit participant metadata never invents an unlisted facial subject from gaze-adjacent prose, including an empty list', () => {
  // This wording exercises metadata authority independently of gaze synonyms.
  const candidate = bedsideGazeCandidate('他直视床侧的@老年张晓茹，眼睑一颤，眉心拧紧。')
  for (const shotParticipants of [candidate.shotParticipants, []]) {
    const issues = validateStoryboard({ ...candidate, shotParticipants })
    assert.equal(issues.some(issue => issue.code === 'emotion_percentage' && issue.message.includes('老年张晓茹')), false)
    assert.deepEqual(issues.filter(issue => issue.severity === 'error'), [])
  }
  const legacy = validateStoryboard({ ...candidate, shotParticipants: undefined })
  assert.ok(legacy.some(issue => issue.code === 'emotion_percentage' && issue.message.includes('老年张晓茹') && issue.severity === 'error'))
})

test('authoritative participant metadata only scopes emotion checks and preserves reference and timeline gates', () => {
  const candidate = { ...bedsideGazeCandidate('他追视床侧的@老年张晓茹，眼睑一颤。'), shotParticipants: [] }
  assert.ok(codes({ ...candidate, videoPrompt: candidate.videoPrompt.replace('0-3秒', '1-3秒') }).includes('time_axis'))
  assert.ok(codes({ ...candidate, videoPrompt: candidate.videoPrompt.replace('@老年张晓茹', '@未知人物') }).includes('unknown_reference'))
})

test('back views, off-screen speakers and pure environment shots do not require fabricated visible facial emotion', () => {
  const back = fixture({
    description: '【镜头1】阿甲背影，站在院内。【镜头2】院门空镜，阿甲画外发声但本镜无台词。',
    videoPrompt: [header, first.replace('正面中景，神情平静（情绪60%）', '仅见背影'), second.replace('正面近景，神情笃定（情绪70%）', '背影远景'), third].join('\n'),
  })
  assert.equal(codes(back).includes('emotion_percentage'), false)
  const environment = fixture({
    description: '【镜头1】院门空镜。【镜头2】门槛特写。', characterIds: [], characters: [],
    videoPrompt: [header.replace('@阿甲', '无'), first.replace(/@阿甲.*$/, '固定镜头拍摄@院落门槛3秒。'), '3-6秒：切到@院落门槛特写。', '6-9秒：@院落光向不变。'].join('\n'),
  })
  assert.deepEqual(errors(environment), [])
})

test('speaking shots require voice age, register, timbre and a numeric delivery rate, including OS', () => {
  const speaking = fixture({ description: '【镜头1】阿甲正面中景说：「你好。」【镜头2】阿甲正面近景点头。' })
  assert.ok(codes(speaking).includes('voice_description'))
  assert.ok(codes(speaking).includes('speech_rate'))
  const voice = '阿甲说：「你好。」听感中年，低音区、温润音色，气息平稳，约每秒3字。'
  assert.deepEqual(errors({ ...speaking, videoPrompt: [header, first + voice, second, third].join('\n') }), [])
  const offscreen = fixture({ description: '【镜头1】院门空镜，旁白：「你好。」【镜头2】阿甲正面近景点头。', videoPrompt: [header, first + '旁白为中年低音区、温润音色，每秒3字。', second, third].join('\n') })
  assert.equal(codes(offscreen).includes('voice_description'), false)
})

test('explicit Chinese numeric ages and common childhood or mature voice ages are recognized without guessing', () => {
  for (const age of ['三十岁上下壮年男性', '三十五岁男性', '二十多岁', '二十来岁', '〇六岁', '一百岁', '二十歳', '三十代', '30代', '二十出头', '壮年', '幼年', '幼童', '儿童', '幼儿', '婴儿']) {
    const speaking = fixture({ description: '【镜头1】阿甲正面中景说：「你好。」【镜头2】阿甲正面近景点头。',
      videoPrompt: [header, first + `阿甲说：「你好。」听感年龄${age}，音域中低音域，音色厚实沙哑硬朗嗓音，气息平稳，每秒3字。`, second, third].join('\n') })
    assert.deepEqual(errors(speaking), [], age)
  }
})

test('coordinates, bare numbers, generations and missing-age placeholders do not satisfy voice age', () => {
  for (const age of ['', '未知', '未填写年龄', '年龄未填写', '年龄未知', '无法判断', '三十米', '三十出头米', '三十', '三十年代', '第十代', '两代人']) {
    const speaking = fixture({ description: '【镜头1】阿甲正面中景，阿甲说：「你好。」【镜头2】阿甲正面近景点头。',
      videoPrompt: [header, first + `阿甲说：「你好。」听感年龄${age}，音域中低音域，音色厚实沙哑硬朗嗓音，每秒3字。`, second, third].join('\n') })
    assert.ok(codes(speaking).includes('voice_description'), age)
    assert.ok(codes(speaking).includes('speaker_voice_description'), age)
  }
  const ageInDialogue = fixture({ description: '【镜头1】阿甲正面中景说：「他三十岁了。」【镜头2】阿甲正面近景点头。',
    videoPrompt: [header, first + '阿甲说：「他三十岁了。」中低音域，厚实沙哑嗓音，每秒3字。', second, third].join('\n') })
  assert.ok(codes(ageInDialogue).includes('voice_description'), 'original spoken words cannot replace an age profile')
})

test('a speaker cannot borrow another speakers newly supported Chinese age expression', () => {
  const two = fixture({ characters: [{ id: 1, name: '阿甲' }, { id: 2, name: '阿乙' }], characterIds: [1, 2],
    description: '【镜头1】阿甲说：「你好。」阿乙说：「再见。」【镜头2】阿甲正面近景点头。',
    videoPrompt: [header, first + '阿甲说：「你好。」听感年龄三十岁，低音域、温润音色，每秒3字。阿乙说：「再见。」听感年龄未知，高音域、清亮音色，每秒3字。', second, third].join('\n') })
  const issues = errors(two)
  assert.ok(issues.some(issue => issue.code === 'speaker_voice_description' && issue.message.includes('阿乙')))
  assert.equal(issues.some(issue => issue.code === 'speaker_voice_description' && issue.message.includes('阿甲')), false)
  assert.deepEqual(errors({ ...two, videoPrompt: two.videoPrompt.replace('年龄未知', '年龄幼年') }), [])
})

test('an age word inside a formal character name cannot replace the actual voice age profile', () => {
  const name = '老年高大山'
  const candidate = fixture({ characters: [{ id: 1, name }],
    description: `【镜头1】${name}正面中景，${name}说：「你好。」【镜头2】${name}点头。`,
    videoPrompt: [header.replaceAll('阿甲', name), first.replaceAll('阿甲', name) + `${name}说：「你好。」中低音域，厚实沙哑嗓音，每秒3字。`,
      second.replaceAll('阿甲', name), third.replaceAll('阿甲', name)].join('\n') })
  assert.ok(codes(candidate).includes('voice_description'))
  assert.ok(codes(candidate).includes('speaker_voice_description'))
  assert.deepEqual(errors({ ...candidate, videoPrompt: candidate.videoPrompt.replace('中低音域，', '听感年龄老年，中低音域，') }), [])
})

test('the actual scheduled shared profile with a Chinese written age survives compile, render and validation', () => {
  const assets = { characters: [{ id: 1, name: '阿甲' }], scenes: [{ id: 1, location: '院落' }], props: [] }
  const guide = buildDialogueTimingGuide([{ speakerName: '阿甲', kind: 'dialogue', text: '你好。' }], assets.characters)
  const group = buildDialogueGroupSchedule(guide)[0]
  const characters = [{ character_id: 1, visibility: 'face_visible' as const, emotion: { expression: '平静', intensity: 60 } }]
  const candidate = compileScheduledSegment({ title: '院内回应', scene_id: 1, prop_ids: [], atmosphere: '现有日光',
    space: '以门槛为固定原点A0，X轴向东为正，Y轴向北为正。',
    voice: { age: '三十岁上下壮年男性', register: '中低音域', timbre: '厚实沙哑硬朗嗓音', delivery: '气息平稳，压低声音，尾音坚定' },
    shot_1: { characters, visuals: ['@阿甲正面中景，抬眼后缓缓放下左手，晨光方向保持。'] },
    shot_2: { characters, visuals: ['@阿甲正面近景，轻眨后点头。', '@阿甲继续放松左手，原坐标和朝向不变。'] },
  }, group, guide, assets)
  const resolved = resolveSourceDialoguePlan(candidate.video_prompt_plan, guide)
  assert.deepEqual(resolved.issues, [])
  const rendered = renderVideoPromptPlan(resolved.plan!, { duration: candidate.duration!, ...assets, characterIds: [1], sceneId: 1, propIds: [], language: 'zh' })
  assert.equal(rendered.issues.some(issue => issue.severity === 'error'), false)
  const checked = fixture({ duration: candidate.duration!, description: '【镜头1】阿甲正面中景，抬眼后说：「你好。」【镜头2】阿甲正面近景，点头后放下手。', videoPrompt: rendered.prompt,
    shotParticipants: rendered.participants })
  assert.deepEqual(errors(checked), [])
  assert.ok(rendered.prompt.includes('三十岁上下壮年男性'))
})

test('English headers, shot markers, time units, cuts and voice structure are accepted', () => {
  const english = fixture({
    description: '[Shot 1] A close-up, A says: "Hello." [Shot 2] A close-up, nodding.',
    characters: [{ id: 1, name: 'A' }], scenes: [{ id: 1, location: 'Yard' }],
    videoPrompt: [
      'Characters: @A; Scene: @Yard. No subtitles, no background music, no clones; do not cross the axis.',
      '0-3s: @Yard has A0 at the threshold, X east and Y north. @A close-up, calm emotion 60%. A says: "Hello." Adult baritone, warm timbre, 3 words per second.',
      '3-6 seconds: Cut to @A close-up, thoughtful emotion 70%.',
      '6-9s: @A lowers the left hand and prepares to walk.',
    ].join('\n'),
  })
  assert.deepEqual(errors(english), [])
  assert.ok(validateStoryboard(english).some(issue => issue.code === 'dialogue_budget_language_review'))
})

test('Japanese headers, cut boundaries, speech details and rate are accepted', () => {
  const japanese = fixture({
    description: '【ショット1】太郎の顔を映す。太郎は言う：「こんにちは。」【ショット2】太郎が頷く。',
    characters: [{ id: 1, name: '太郎' }], scenes: [{ id: 1, location: '庭' }],
    videoPrompt: [
      '登場人物：@太郎。シーン：@庭。字幕なし、BGMなし、クローンなし、軸を越えない。',
      '0-3秒：@庭の敷居を原点A0、Xは東、Yは北とする。@太郎は頷き、落ち着いた表情60%。太郎は言う：「こんにちは。」30歳の低音域、温かい音色、毎秒3文字。',
      '3-6秒：@太郎の近景に切り替わり、表情70%、左手を下ろす。',
      '6-9秒：@太郎は同じ姿勢から歩く準備をする。',
    ].join('\n'),
  })
  assert.deepEqual(errors(japanese), [])
  assert.ok(codes({ ...japanese, videoPrompt: japanese.videoPrompt.replace('毎秒3文字', '') }).includes('speech_rate'))
})

test('Korean headers, seconds, cut boundaries and speech controls are accepted without a Chinese speech budget', () => {
  const korean = fixture({
    description: '【컷1】민수의 얼굴을 비춘다. 민수가 말한다: 「안녕하세요.」【컷2】민수가 고개를 끄덕인다.',
    characters: [{ id: 1, name: '민수' }], scenes: [{ id: 1, location: '마당' }],
    videoPrompt: [
      '등장인물: @민수; 장면: @마당. 자막 없음, 배경음악 없음, 복제인간 금지, 축을 넘지 않는다.',
      '0-3초: @마당의 문턱은 원점A0, X는 동쪽, Y는 북쪽이다. @민수가 눈을 깜박인다. 민수가 말한다: 「안녕하세요.」중년 저음역의 따뜻한 음색, 초당3글자.',
      '3-6초: @민수의 근경으로 전환, 왼손을 내린다.',
      '6-9초: @민수가 다음 걸음을 준비한다.',
    ].join('\n'),
  })
  assert.deepEqual(errors(korean), [])
  assert.ok(validateStoryboard(korean).some(issue => issue.code === 'dialogue_budget_language_review'))
  assert.ok(codes({ ...korean, videoPrompt: korean.videoPrompt.replace('초당3글자', '') }).includes('speech_rate'))
})

test('dialogue words, turn order and occurrence count must be preserved while one utterance may span time rows', () => {
  const speaking = fixture({
    description: '【镜头1】阿甲正面中景说：「你好世界。」【镜头2】阿甲正面近景，点头。',
    videoPrompt: [header, first + '阿甲说：「你好，」中年低音、温润音色，每秒3字。',
      '3-6秒：@阿甲继续本人台词：「世界。」呼吸平稳。',
      '6-9秒：切到@阿甲正面近景，神情笃定（情绪70%），左手放下。'].join('\n'),
  })
  assert.deepEqual(errors(speaking), [])
  for (const prompt of [speaking.videoPrompt.replace('世界。', '世间。'), speaking.videoPrompt.replace('「世界。」', ''), speaking.videoPrompt + '阿甲说：「你好世界。」']) {
    assert.ok(codes({ ...speaking, videoPrompt: prompt }).includes('dialogue_preservation'))
  }
  const turns = { ...speaking, description: '【镜头1】阿甲说：「你好。」阿甲说：「再见。」【镜头2】阿甲正面近景，点头。' }
  assert.ok(codes({ ...turns, videoPrompt: speaking.videoPrompt.replace('你好，', '再见。').replace('世界。', '你好。') }).includes('dialogue_preservation'))
  assert.ok(codes({ ...turns, videoPrompt: speaking.videoPrompt.replace('你好，', '你好再见。').replace('「世界。」', '') }).includes('dialogue_preservation'))
})

test('multiple identifiable speakers cannot borrow one shared voice description and rate', () => {
  const two = fixture({
    characters: [{ id: 1, name: '阿甲' }, { id: 2, name: '阿乙' }], characterIds: [1, 2],
    description: '【镜头1】阿甲说：「你好。」阿乙说：「再见。」【镜头2】阿甲正面近景，点头。',
    videoPrompt: [header, first + '阿甲说：「你好。」中年低音、温润音色，每秒3字。阿乙说：「再见。」', second, third].join('\n'),
  })
  assert.ok(codes(two).includes('speaker_voice_description'))
  assert.ok(codes(two).includes('speaker_speech_rate'))
  assert.deepEqual(errors({ ...two, videoPrompt: two.videoPrompt.replace('阿乙说：「再见。」', '阿乙说：「再见。」青年高音、清亮音色，每秒3字。') }), [])
})

test('the bedroom profile shot does not promote the man on the bed or its coordinate list into a facial subject', () => {
  const bedroom = fixture({
    characters: [{ id: 1, name: '高大山' }, { id: 2, name: '张晓茹' }], characterIds: [1, 2],
    description: '【镜头1】高大山正面中景，站在床边抬眼。【镜头2】高大山坐在床沿A(X+1米，Y+1米)，张晓茹位于门边A(X+2米，Y+1米)。侧面中景拍摄张晓茹，她看向高大山。',
    videoPrompt: [
      header.replace('@阿甲', '@高大山、@张晓茹'), first.replaceAll('@阿甲', '@高大山'),
      '3-6秒：切到侧面中景，@张晓茹站在门边，冷淡克制70%，看向坐在床沿的@高大山。',
      '6-9秒：@张晓茹轻眨后收紧嘴角，继续看向@高大山，后者保持床沿坐姿。',
    ].join('\n'),
  })
  assert.deepEqual(errors(bedroom), [])
  assert.ok(validateStoryboard(bedroom).some(issue => issue.code === 'emotion_percentage' && issue.message.includes('子镜头 2 的 高大山') && issue.severity === 'warning'))
})

test('a preposed camera clause belongs to its named subject rather than the preceding person on the bed', () => {
  const candidate = fixture({
    characters: [{ id: 1, name: '阿甲' }, { id: 2, name: '阿乙' }], characterIds: [1, 2],
    description: '【镜头1】阿甲正面中景。【镜头2】阿甲坐在床沿，侧面中景的阿乙站在门边。',
    videoPrompt: [header, first, '3-6秒：切到@阿甲坐着的床沿，侧面中景的@阿乙冷淡克制70%，站在门边。', '6-9秒：@阿乙保持站姿，看向@阿甲。'].join('\n'),
  })
  assert.deepEqual(errors(candidate), [])
  assert.ok(validateStoryboard(candidate).some(issue => issue.code === 'emotion_percentage' && issue.message.includes('子镜头 2 的 阿甲') && issue.severity === 'warning'))
  assert.ok(codes({ ...candidate, videoPrompt: candidate.videoPrompt.replace('冷淡克制70%', '站姿稳定') }).includes('emotion_percentage'), 'the actual profile subject still needs a percentage')
})

test('medium framing, coordinates, gaze and dialogue targets alone are not proof of a clearly visible face', () => {
  const candidate = fixture({
    description: '【镜头1】阿甲正面中景。【镜头2】阿甲坐在A(X+1米，Y+1米)，面向门口，中景固定拍摄。',
    videoPrompt: [header, first, '3-6秒：切到@阿甲坐在床沿，中景固定，望向她的嘴角。', third].join('\n'),
  })
  const issues = validateStoryboard(candidate)
  assert.deepEqual(errors(candidate), [])
  assert.ok(issues.some(issue => issue.code === 'emotion_percentage' && issue.severity === 'warning'))
  const pronounTarget = { ...candidate, videoPrompt: candidate.videoPrompt.replace('望向她的嘴角', '看着她平静的表情') }
  assert.deepEqual(errors(pronounTarget), [])
})

test('an unrelated offscreen source in the same sentence does not exempt a real facial subject', () => {
  const candidate = fixture({
    characters: [{ id: 1, name: '阿甲' }, { id: 2, name: '阿乙' }], characterIds: [1, 2],
    description: '【镜头1】阿甲正面中景。【镜头2】阿甲正面近景，阿乙在画外。',
    videoPrompt: [header, first, '3-6秒：切到@阿甲正脸清晰的近景，画外@阿乙（OS）只有呼吸声，阿甲缓慢眨眼。', third].join('\n'),
  })
  assert.ok(validateStoryboard(candidate).some(issue => issue.code === 'emotion_percentage' && issue.message.includes('子镜头 2 的 阿甲') && issue.severity === 'error'))
  assert.equal(validateStoryboard(candidate).some(issue => issue.code === 'emotion_percentage' && issue.message.includes('子镜头 2 的 阿乙') && issue.severity === 'error'), false)
})

test('pure hand shots, hidden faces and OS participants do not require a fabricated expression', () => {
  for (const [description, row] of [
    ['阿甲手部特写，面部不可见。', '@阿甲手部特写，右手松开衣摆。'],
    ['阿甲仅见背影。', '@阿甲仅见背影，保持坐姿。'],
    ['阿甲（OS）画外呼吸。', '@阿甲（OS）画外只有呼吸声，镜头固定。'],
    ['阿甲在画外。', '@阿甲在画外，只有门声入画。'],
  ]) {
    const candidate = fixture({ description: `【镜头1】阿甲正面中景。【镜头2】${description}`, videoPrompt: [header, first, `3-6秒：切到${row}`, third].join('\n') })
    assert.equal(validateStoryboard(candidate).some(issue => issue.code === 'emotion_percentage'), false)
  }
})

test('an explicit participant plan can confirm a face without relying on a framing keyword', () => {
  const candidate = fixture({
    description: '【镜头1】阿甲正面中景。【镜头2】阿甲放下左手。',
    videoPrompt: [header, first, '3-6秒：切到@阿甲点头后放下左手。', third].join('\n'),
  })
  assert.equal(codes(candidate).includes('emotion_percentage'), false)
  assert.ok(codes({ ...candidate, shotParticipants: [{ shotNumber: 2, characterId: 1, visibility: 'face_visible' }] }).includes('emotion_percentage'))
  for (const visibility of ['face_hidden', 'offscreen', 'uncertain'] as const) {
    assert.equal(codes({ ...candidate, shotParticipants: [{ shotNumber: 2, characterId: 1, visibility }] }).includes('emotion_percentage'), false)
  }
  assert.equal(codes({ ...candidate, shotParticipants: [{ shotNumber: 1, characterId: 999, visibility: 'face_visible' }] }).includes('emotion_percentage'), false, 'plans are scoped to the exact shot and character')
})

test('visibility conflicts request review without removing the emotion requirement of a declared visible face', () => {
  const visible = fixture({ videoPrompt: [header, first, second.replace('（情绪70%）', ''), third].join('\n') })
  for (const visibility of ['face_hidden', 'offscreen'] as const) {
    const issues = validateStoryboard({ ...visible, shotParticipants: [{ shotNumber: 2, characterId: 1, visibility }] })
    assert.ok(issues.some(issue => issue.code === 'face_visibility_review' && issue.severity === 'warning'))
    assert.equal(issues.some(issue => issue.code.startsWith('emotion_percentage') && issue.severity === 'error'), false)
  }
  const back = fixture({
    description: '【镜头1】阿甲正面中景。【镜头2】阿甲仅见背影。',
    videoPrompt: [header, first, '3-6秒：切到@阿甲背影，面部不可见。', third].join('\n'),
    shotParticipants: [{ shotNumber: 2, characterId: 1, visibility: 'face_visible' }],
  })
  assert.ok(validateStoryboard(back).some(issue => issue.code === 'face_visibility_review' && issue.severity === 'warning'))
  assert.equal(codes(back).includes('emotion_percentage'), true)
  const contradictoryText = { ...back, shotParticipants: undefined, videoPrompt: visible.videoPrompt }
  assert.equal(codes(contradictoryText).includes('emotion_percentage'), false)
})

test('emotion percentages may be plain prose or a neighboring unnamed emotion sentence, but never another persons percentage', () => {
  for (const row of [
    '切到@阿甲正面近景，冷淡克制70%，放下手。',
    '切到@阿甲正面近景，冷淡克制。情绪70%。',
    '冷淡克制70%。切到@阿甲正面近景，放下手。',
  ]) assert.deepEqual(errors(fixture({ videoPrompt: [header, first, `3-6秒：${row}`, third].join('\n') })), [])
  const other = fixture({
    characters: [{ id: 1, name: '阿甲' }, { id: 2, name: '阿乙' }], characterIds: [1, 2],
    videoPrompt: [header, first, '3-6秒：切到@阿乙冷淡克制70%。@阿甲正面近景，点头后放下手。', third].join('\n'),
  })
  assert.ok(validateStoryboard(other).some(issue => issue.code === 'emotion_percentage' && issue.message.includes('子镜头 2 的 阿甲') && issue.severity === 'error'))
  assert.ok(codes({ ...other, characterIds: [1], videoPrompt: other.videoPrompt.replace('@阿乙', '阿乙') }).includes('emotion_percentage'), 'even an unbound known person cannot donate their percentage')
})

test('invalid percentages only block when facial visibility is confirmed, without weakening other hard checks', () => {
  const uncertain = fixture({ description: '【镜头1】阿甲正面中景。【镜头2】阿甲坐在床边。', videoPrompt: [header, first, '3-6秒：切到@阿甲坐在床边，克制130%。', third].join('\n') })
  assert.ok(validateStoryboard(uncertain).some(issue => issue.code === 'emotion_percentage_range' && issue.severity === 'warning'))
  assert.ok(codes({ ...uncertain, shotParticipants: [{ shotNumber: 2, characterId: 1, visibility: 'face_visible' }] }).includes('emotion_percentage_range'))
  assert.ok(codes({ ...uncertain, videoPrompt: uncertain.videoPrompt.replace('3-6秒', '4-6秒') }).includes('time_axis'))
  assert.ok(codes({ ...uncertain, videoPrompt: uncertain.videoPrompt.replace('@阿甲坐在床边', '@未知人物坐在床边') }).includes('unknown_reference'))
})

test('dialogue extraction retains ordered fragments across shots and unmarked descriptions without visual prose', () => {
  assert.deepEqual(extractStoryboardDialogue('【镜头1】阿甲抬手说：「先去门口，」随后站起。【镜头2】阿甲放下手说：「等我回来。」旁白：天色渐暗。镜头拍向门口。'), ['先去门口，', '等我回来。', '天色渐暗'])
  assert.deepEqual(extractStoryboardDialogue('阿甲走到窗边说：「你好。」旁白：雨还在下。窗框上水珠滑落。'), ['你好。', '雨还在下'])
  assert.deepEqual(extractStoryboardDialogue('【镜头1】阿甲站在门边。【镜头2】空镜拍窗。'), [])
})
