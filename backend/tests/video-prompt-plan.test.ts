import { test } from 'node:test'
import assert from 'node:assert/strict'
import { videoPromptPlanSchema, renderVideoPromptPlan, type VideoPromptPlan } from '../src/services/video-prompt-plan.ts'
import { validateStoryboard } from '../src/services/storyboard-validation.ts'
import { cameraCuts } from '../src/services/camera-cuts.ts'

type Context = Parameters<typeof renderVideoPromptPlan>[1]
const space = '以门槛为固定原点A0，X轴向东为正，Y轴向北为正。'
const voice = { age: '中年', register: '低音区', timbre: '温润音色', delivery: '气息平稳，尾音自然落下' }
const context = (overrides: Partial<Context> = {}): Context => ({
  duration: 9, characters: [{ id: 1, name: '阿甲' }, { id: 2, name: '阿乙' }],
  scenes: [{ id: 3, location: '院落' }, { id: 4, location: '屋内' }], props: [{ id: 5, name: '信封' }],
  characterIds: [1, 2], sceneId: 3, propIds: [5], language: 'zh', ...overrides,
})
const plan = (overrides: Partial<VideoPromptPlan> = {}): VideoPromptPlan => ({
  space,
  shots: [
    { shot_number: 1, characters: [{ character_id: 1, visibility: 'face_visible', emotion: { expression: '平静', intensity: 60 } }],
      rows: [{ visual: '@阿甲站在A(X+1米，Y+1米)，正面中景，抬眼看向院门。' }] },
    { shot_number: 2, characters: [{ character_id: 1, visibility: 'face_visible', emotion: { expression: '笃定', intensity: 70 } }],
      rows: [{ visual: '@阿甲正面近景，点头后左手逐渐放松。' }, { visual: '@阿甲左手放下，准备迈步，光向保持。' }] },
  ], ...overrides,
})
const render = (value: VideoPromptPlan = plan(), ctx: Context = context()) => renderVideoPromptPlan(value, ctx)
const hard = (result: ReturnType<typeof render>) => result.issues.filter(issue => issue.severity === 'error')
const rejected = (value: unknown, ctx = context()) => {
  const parsed = videoPromptPlanSchema.safeParse(value)
  return !parsed.success || hard(render(parsed.data, ctx)).length > 0
}

const trustedDialoguePlan = (): VideoPromptPlan => {
  const value = plan()
  value.shots[0].rows[0].visual = '@阿甲正面近景，目光投向门边的@阿乙，自己缓缓吐气。'
  value.shots[0].rows[0].dialogue = [{ speaker_id: 2, kind: 'dialogue', text: '你先别停。', voice }]
  return value
}
const trustedDialogueContext = (overrides: Partial<Context> = {}): Context => context({
  characters: [{ id: 1, name: '阿甲' }, { id: 2, name: '阿乙', voiceReference: '#阿乙' }],
  trustedSourceDialogueSlots: [{ shotNumber: 1, rowIndex: 0, dialogueIndex: 0 }], ...overrides,
})

test('a trusted source dialogue slot stays same-scene offscreen without adding pictured participants', () => {
  const value = trustedDialoguePlan()
  const before = JSON.stringify(value)
  const result = render(value, trustedDialogueContext())
  assert.deepEqual(hard(result), [])
  assert.ok(result.prompt.includes('画外音（同场对白）：@阿乙（#阿乙）说：「你先别停。」'))
  assert.ok(result.prompt.includes('听感年龄中年，音域低音区，音色温润音色'))
  assert.ok(!result.prompt.split('\n')[0].includes('@阿乙'))
  assert.ok(!result.participants.some(participant => participant.characterId === 2))
  assert.equal(value.shots[0].rows[0].dialogue![0].kind, 'dialogue')
  assert.equal(JSON.stringify(value), before)
})

test('legacy dialogue and slots with another shot, row or dialogue index still require pictured speakers', () => {
  for (const trustedSourceDialogueSlots of [undefined,
    [{ shotNumber: 2, rowIndex: 0, dialogueIndex: 0 }],
    [{ shotNumber: 1, rowIndex: 1, dialogueIndex: 0 }],
    [{ shotNumber: 1, rowIndex: 0, dialogueIndex: 1 }],
  ]) {
    const result = render(trustedDialoguePlan(), trustedDialogueContext({ trustedSourceDialogueSlots }))
    assert.equal(result.prompt, '')
    assert.ok(hard(result).some(issue => issue.code === 'plan_speaker_visibility'))
  }
})

test('a speaker declared only offscreen accepts a trusted source slot while legacy dialogue still fails', () => {
  const value = trustedDialoguePlan()
  value.shots[0].characters.push({ character_id: 2, visibility: 'offscreen' })
  const result = render(value, trustedDialogueContext())
  assert.deepEqual(hard(result), [])
  assert.ok(result.prompt.includes('画外音（同场对白）：@阿乙（#阿乙）说：「你先别停。」'))
  assert.ok(!result.prompt.split('\n')[0].includes('@阿乙'))
  assert.deepEqual(result.participants.filter(participant => participant.characterId === 2), [
    { shotNumber: 1, characterId: 2, visibility: 'offscreen' },
  ])
  const legacy = render(value, trustedDialogueContext({ trustedSourceDialogueSlots: undefined }))
  assert.equal(legacy.prompt, '')
  assert.ok(hard(legacy).some(issue => issue.code === 'plan_speaker_visibility'))
  value.shots[0].rows[0].visual = '@阿乙抬手，正脸清晰。'
  const contradictory = render(value, trustedDialogueContext())
  assert.equal(contradictory.prompt, '')
  assert.ok(hard(contradictory).some(issue => issue.code === 'plan_visual_participant'))
})

test('a trusted source slot never permits an unknown, missing or unbound speaker', () => {
  for (const speakerId of [undefined, 999, 2]) {
    const value = trustedDialoguePlan()
    value.shots[0].rows[0].visual = '@阿甲正面近景，自己缓缓吐气。'
    value.shots[0].rows[0].dialogue![0].speaker_id = speakerId
    const result = render(value, trustedDialogueContext({ characterIds: [1] }))
    assert.equal(result.prompt, '')
    assert.ok(hard(result).some(issue => issue.code === 'plan_speaker_visibility'))
    if (speakerId !== undefined) assert.ok(hard(result).some(issue => issue.code === 'plan_speaker'))
  }
})

test('trusted offscreen source dialogue does not excuse an undeclared visible action or clear face', () => {
  for (const visual of ['@阿甲看向@阿乙站在门边。', '@阿乙抬手，正脸清晰。']) {
    const value = trustedDialoguePlan()
    value.shots[0].rows[0].visual = visual
    const result = render(value, trustedDialogueContext())
    assert.equal(result.prompt, '')
    assert.ok(hard(result).some(issue => issue.code === 'plan_visual_participant'), visual)
    assert.ok(!hard(result).some(issue => issue.code === 'plan_speaker_visibility'), visual)
  }
})

test('trusted source dialogue labels support all app languages without translating words or adding cast', () => {
  const labels = { zh: '画外音（同场对白）', en: 'Offscreen voice (same-scene dialogue)', ja: '画外音（同一シーンの会話）', ko: '화면 밖 목소리（같은 장면의 대사）' }
  for (const language of ['zh', 'en', 'ja', 'ko'] as const) {
    const result = render(trustedDialoguePlan(), trustedDialogueContext({ language }))
    assert.deepEqual(hard(result), [], language)
    assert.ok(result.prompt.includes(labels[language]), language)
    assert.ok(result.prompt.includes('@阿乙（#阿乙）'), language)
    assert.ok(result.prompt.includes('「你先别停。」'), language)
    assert.ok(!result.prompt.split('\n')[0].includes('@阿乙'), language)
    assert.ok(!result.participants.some(participant => participant.characterId === 2), language)
  }
})

test('source slot flags leave ordinary onscreen, offscreen and narration rendering unchanged', () => {
  for (const kind of ['dialogue', 'offscreen', 'narration'] as const) {
    const value = trustedDialoguePlan()
    if (kind === 'dialogue') value.shots[0].characters.push({ character_id: 2, visibility: 'face_hidden' })
    value.shots[0].rows[0].dialogue![0].kind = kind
    const withFlag = render(value, trustedDialogueContext())
    const withoutFlag = render(value, trustedDialogueContext({ trustedSourceDialogueSlots: undefined }))
    assert.deepEqual(hard(withFlag), [])
    assert.deepEqual(withFlag, withoutFlag)
  }
})

test('optional wire nulls normalize to undefined without changing required plan facts', () => {
  const input: any = plan()
  input.shots[0].characters[0].visibility = 'face_hidden'
  input.shots[0].characters[0].emotion = null
  input.shots[0].rows[0].dialogue = [{ speaker_id: null, kind: 'narration', text: '天亮了。',
    voice: { ...voice, delivery: null }, voice_reference: null, spoken_seconds: null }]
  input.shots[1].rows[0].dialogue = null
  const before = JSON.stringify(input)
  const normalized: VideoPromptPlan = videoPromptPlanSchema.parse(input)
  assert.equal(normalized.shots[0].characters[0].emotion, undefined)
  assert.equal(normalized.shots[1].rows[0].dialogue, undefined)
  const speech = normalized.shots[0].rows[0].dialogue![0]
  assert.equal(speech.speaker_id, undefined)
  assert.equal(speech.voice_reference, undefined)
  assert.equal(speech.spoken_seconds, undefined)
  assert.equal(speech.voice.delivery, undefined)
  assert.equal(speech.text, '天亮了。')
  assert.deepEqual(hard(render(normalized)), [])
  assert.equal(JSON.stringify(input), before)
})

test('null or empty optional voice tokens still allow the server to supply the actual bound voice', () => {
  for (const voiceReference of [null, '']) {
    const input: any = plan()
    input.shots[0].rows[0].dialogue = [{ speaker_id: 1, kind: 'dialogue', text: '你好。', voice,
      voice_reference: voiceReference, spoken_seconds: null }]
    const normalized = videoPromptPlanSchema.parse(input)
    assert.equal(normalized.shots[0].rows[0].dialogue![0].voice_reference, undefined)
    const result = render(normalized, context({ characters: [{ id: 1, name: '阿甲', voiceReference: '#阿甲' }, { id: 2, name: '阿乙' }] }))
    assert.deepEqual(hard(result), [])
    assert.match(result.prompt, /#阿甲说[：:]/)
    assert.ok(result.prompt.includes('「你好。」'))
    const withoutUploadedVoice = render(normalized)
    assert.deepEqual(hard(withoutUploadedVoice), [])
    assert.doesNotMatch(withoutUploadedVoice.prompt, /#/)
  }
})

test('normalizing optional nulls cannot invent a visible emotion, speech source or voice binding', () => {
  const missingEmotion: any = plan()
  missingEmotion.shots[0].characters[0].emotion = null
  assert.ok(hard(render(videoPromptPlanSchema.parse(missingEmotion))).some(issue => issue.code === 'plan_emotion'))
  const missingSpeaker: any = plan()
  missingSpeaker.shots[0].rows[0].dialogue = [{ speaker_id: null, kind: 'dialogue', text: '你好。', voice, voice_reference: '' }]
  assert.ok(hard(render(videoPromptPlanSchema.parse(missingSpeaker))).some(issue => issue.code === 'plan_speaker_visibility'))
  const inventedVoice: any = plan()
  inventedVoice.shots[0].rows[0].dialogue = [{ speaker_id: 1, kind: 'dialogue', text: '你好。', voice, voice_reference: '#虚构' }]
  assert.ok(hard(render(videoPromptPlanSchema.parse(inventedVoice))).some(issue => issue.code === 'plan_voice_reference'))
})

test('required text and voice fields, invalid optional IDs or timing, and excess rows remain rejected', () => {
  for (const invalid of [
    { text: null, voice },
    { text: '你好。', voice: null },
    { text: '你好。', voice: { ...voice, age: null } },
    { text: '你好。', voice, speaker_id: 0 },
    { text: '你好。', voice, spoken_seconds: 0 },
    { text: '你好。', voice, spoken_seconds: -1 },
  ]) {
    const input: any = plan()
    input.shots[0].rows[0].dialogue = [{ speaker_id: 1, kind: 'dialogue', ...invalid }]
    assert.equal(videoPromptPlanSchema.safeParse(input).success, false)
  }
  const excessiveRows: any = plan()
  excessiveRows.shots[0].rows.push({ visual: '@阿甲抬头。' }, { visual: '@阿甲点头。' })
  assert.equal(videoPromptPlanSchema.safeParse(excessiveRows).success, false)
})

test('a valid Chinese plan renders deterministic header, global rules, time rows and cut boundaries', () => {
  const value = plan()
  const before = JSON.stringify(value)
  const result = render(value)
  assert.deepEqual(hard(result), [])
  const lines = result.prompt.split(/\r?\n/).filter(Boolean)
  assert.match(lines[0], /出场人物.*@阿甲/)
  assert.match(lines[0], /场景.*@院落/)
  for (const token of ['无字幕', '无背景音乐', '不越轴']) assert.ok(lines[0].includes(token))
  assert.match(lines[0], /克隆|复制人/)
  assert.match(lines[1], /^0[-–]3秒[:：]/)
  assert.match(lines[2], /^3[-–]6秒[:：]/)
  assert.match(lines[3], /^6[-–]9秒[:：]/)
  assert.ok(lines[1].includes(space))
  assert.equal(result.prompt.match(/A0/g)?.length, 1)
  assert.doesNotMatch(lines[1], /切到|切回/)
  assert.match(lines[2], /切到|切回/)
  assert.doesNotMatch(lines[3], /切到|切回/)
  assert.ok(result.prompt.includes('60%') && result.prompt.includes('70%'))
  assert.equal(JSON.stringify(value), before)
  assert.deepEqual(result.participants.map(p => ({ shot: p.shotNumber, id: p.characterId, visibility: p.visibility })), [
    { shot: 1, id: 1, visibility: 'face_visible' }, { shot: 2, id: 1, visibility: 'face_visible' },
  ])
})

test('Chinese output also passes the existing deterministic storyboard validator', () => {
  const result = render()
  const issues = validateStoryboard({ ...context(), storyboardId: 1, shotNumber: 1,
    description: '【镜头1】阿甲正面中景，站在院内抬眼。【镜头2】阿甲正面近景，点头后放下手。', videoPrompt: result.prompt })
  assert.deepEqual(issues.filter(issue => issue.severity === 'error'), [])
})

test('an existing positive cut prefix is preserved without another renderer prefix in all four languages', () => {
  for (const [language, prefix] of [['zh', '切回，'], ['en', 'Cut back, '], ['ja', 'カットを切り替え、'], ['ko', '컷 전환, ']]) {
    const value = plan()
    const visual = prefix + value.shots[1].rows[0].visual
    value.shots[1].rows[0].visual = visual
    const before = JSON.stringify(value)
    const result = render(value, context({ language }))
    assert.deepEqual(hard(result), [], language)
    const line = result.prompt.split('\n')[2]
    const body = line.replace(/^3-6(?:秒|s|초)[:：]\s*/, '')
    assert.ok(body.startsWith(visual), `${language}: a renderer prefix must not precede the supplied one`)
    assert.equal(cameraCuts(body).length, 1, language)
    assert.equal(JSON.stringify(value), before)
    const issues = validateStoryboard({ ...context(), description: '【镜头1】阿甲正面中景。【镜头2】阿甲正面近景，点头后放下手。', videoPrompt: result.prompt, shotParticipants: result.participants })
    assert.deepEqual(issues.filter(issue => issue.severity === 'error'), [], language)
  }
})

test('one positive cut inside a shot opening row is preserved without an additional leading cut', () => {
  const value = plan()
  const visual = '@阿甲先松开左手，随后切到@阿甲正面近景，点头后缓缓吐气。'
  value.shots[1].rows[0].visual = visual
  const before = JSON.stringify(value)
  const result = render(value)
  assert.deepEqual(hard(result), [])
  const line = result.prompt.split('\n')[2]
  assert.ok(line.startsWith(`3-6秒：${visual}`))
  assert.equal(cameraCuts(line).length, 1)
  assert.equal(JSON.stringify(value), before)
  const issues = validateStoryboard({ ...context(), description: '【镜头1】阿甲正面中景。【镜头2】阿甲正面近景，点头后放下手。', videoPrompt: result.prompt, shotParticipants: result.participants })
  assert.deepEqual(issues.filter(issue => issue.severity === 'error'), [])
})

test('quoted cut words cannot replace the actual boundary added by the renderer', () => {
  const value = plan()
  const visual = '@阿甲正面近景，门上纸条写着“切回”，点头后放下左手。'
  value.shots[1].rows[0].visual = visual
  const result = render(value)
  assert.deepEqual(hard(result), [])
  const line = result.prompt.split('\n')[2]
  assert.ok(line.startsWith(`3-6秒：切到，${visual}`))
  assert.equal(cameraCuts(line).length, 1)
})

test('explicit continuity prose before one real inline cut produces a review warning without changing its wording', () => {
  for (const prefix of ['同一机位', '同焦段', '继续推近', '继续固定']) {
    const value = plan()
    const visual = `${prefix}，@阿甲先松开左手，随后切回@阿甲正面近景。`
    value.shots[1].rows[0].visual = visual
    const result = render(value)
    assert.deepEqual(hard(result), [])
    assert.ok(result.prompt.split('\n')[2].startsWith(`3-6秒：${visual}`))
    assert.ok(result.issues.some(issue => issue.code === 'camera_continuity_review' && issue.severity === 'warning'
      && issue.field === 'video_prompt_plan.shots.1.rows.0.visual'))
  }
  const ordinary = plan()
  ordinary.shots[1].rows[0].visual = '@阿甲先松开左手，随后切回@阿甲正面近景。'
  assert.equal(render(ordinary).issues.some(issue => issue.code === 'camera_continuity_review'), false)
})

test('three-shot screenshot regression keeps existing row-two and row-three cut prefixes without false multiple-cut errors', () => {
  const value = plan()
  value.shots[1].rows = [{ visual: '切到@阿甲正面近景，点头后左手逐渐放松。' }]
  value.shots.push({ shot_number: 3, characters: [{ character_id: 1, visibility: 'face_visible', emotion: { expression: '平静', intensity: 65 } }], rows: [{ visual: '切回@阿甲正面中景，放下手并准备迈步。' }] })
  const before = JSON.stringify(value)
  const result = render(value)
  assert.deepEqual(hard(result), [])
  assert.match(result.prompt, /3-6秒：切到@阿甲/)
  assert.match(result.prompt, /6-9秒：切回@阿甲/)
  assert.doesNotMatch(result.prompt, /切到，切(?:到|回)/)
  assert.deepEqual(validateStoryboard({ ...context(), description: '【镜头1】阿甲正面中景，抬眼。【镜头2】阿甲正面近景，点头。【镜头3】阿甲正面中景，放下手准备迈步。', videoPrompt: result.prompt, shotParticipants: result.participants }).filter(issue => issue.severity === 'error'), [])
  assert.equal(JSON.stringify(value), before)
})

test('negative cut instructions remain verbatim and do not replace the required shot boundary or split a continuation row', () => {
  const value = plan()
  const visual = '不切回@院落门口，@阿甲正面近景，点头后左手逐渐放松。'
  value.shots[1].rows[0].visual = visual
  value.shots[1].rows[1].visual += '不要切回门口。'
  const result = render(value)
  assert.deepEqual(hard(result), [])
  assert.ok(result.prompt.includes(`3-6秒：切到，${visual}`))
  assert.ok(result.prompt.includes('不要切回门口。'))
  assert.deepEqual(validateStoryboard({ ...context(), description: '【镜头1】阿甲正面中景。【镜头2】阿甲正面近景，点头后放下手。', videoPrompt: result.prompt, shotParticipants: result.participants }).filter(issue => issue.severity === 'error'), [])
})

test('a real second cut inside visual prose is preserved by rendering and remains a hard validation error', () => {
  for (const visual of ['切到@阿甲正面近景，点头后随即切回@院落门口的中景。',
    '@阿甲先松手，随后切到@阿甲正面近景，点头后随即切回@院落门口的中景。']) {
    const value = plan()
    value.shots[1].rows[0].visual = visual
    const result = render(value)
    assert.ok(result.prompt.includes(visual), 'camera actions must never be deleted to pass validation')
    assert.equal(cameraCuts(result.prompt.split('\n')[2]).length, 2)
    const issues = validateStoryboard({ ...context(), description: '【镜头1】阿甲正面中景。【镜头2】阿甲正面近景，点头后放下手。', videoPrompt: result.prompt, shotParticipants: result.participants })
    assert.ok(issues.some(issue => issue.code === 'multiple_cuts_in_row' && issue.severity === 'error'))
  }
})

test('eight seconds renders an exact two-second remainder without adding an extra row', () => {
  const result = render(plan(), context({ duration: 8 }))
  assert.deepEqual(hard(result), [])
  assert.match(result.prompt, /6[-–]8秒[:：]/)
  assert.doesNotMatch(result.prompt, /6[-–]9秒/)
  assert.equal(result.prompt.split(/\r?\n/).filter(line => /^\d+[-–]\d+/.test(line)).length, 3)
})

test('all four app languages render compatible headers, cuts, voices and numeric speech rates', () => {
  const expectations = {
    zh: { header: /出场人物/, scene: /场景/, unit: /0[-–]3秒/, cut: /切到|切回/, rate: /每秒\s*[\d.]+\s*字/ },
    en: { header: /characters?|cast/i, scene: /scene/i, unit: /0[-–]3(?:s|\s*seconds)/i, cut: /cut\s+(?:to|back)/i, rate: /[\d.]+\s*(?:characters?|words?)\s*(?:per\s+second|\/s)/i },
    ja: { header: /登場人物/, scene: /シーン|場面/, unit: /0[-–]3秒/, cut: /切り替|カット|戻る/, rate: /毎秒\s*[\d.]+\s*(?:字|文字)|[\d.]+\s*(?:字|文字)\s*[/／]秒/ },
    ko: { header: /등장\s*인물|출연\s*인물/, scene: /장면/, unit: /0[-–]3초/, cut: /전환|되돌아|컷/, rate: /초당\s*[\d.]+\s*(?:글자|자|단어)|[\d.]+\s*(?:글자|자)\s*[/／]초/ },
  }
  for (const language of ['zh', 'en', 'ja', 'ko'] as const) {
    const value = plan()
    value.shots[0].rows[0].dialogue = [{ speaker_id: 1, kind: 'dialogue', text: '你好。', voice }]
    const result = render(value, context({ language }))
    assert.deepEqual(hard(result), [], language)
    const lines = result.prompt.split(/\r?\n/).filter(Boolean)
    const expected = expectations[language]
    assert.match(lines[0], expected.header)
    assert.match(lines[0], expected.scene)
    assert.match(lines[1], expected.unit)
    assert.match(lines[2], expected.cut)
    assert.match(result.prompt, expected.rate)
    const issues = validateStoryboard({ ...context(), description: '【镜头1】阿甲正面中景说：「你好。」【镜头2】阿甲正面近景点头。', videoPrompt: result.prompt })
    assert.deepEqual(issues.filter(issue => issue.severity === 'error'), [], `${language} validator compatibility`)
  }
})

test('only on-screen participants enter the header; offscreen voice stays outside the header and retains source', () => {
  const value = plan()
  value.shots[0].characters.push({ character_id: 2, visibility: 'offscreen' })
  value.shots[0].rows[0].dialogue = [{ speaker_id: 2, kind: 'offscreen', text: '阿甲，等一下。', voice }]
  const result = render(value)
  assert.deepEqual(hard(result), [])
  const [header, ...body] = result.prompt.split(/\r?\n/)
  assert.ok(header.includes('阿甲'))
  assert.ok(!header.includes('阿乙'))
  assert.match(body.join('\n'), /阿乙.*(?:画外|OS)|(?:画外|OS).*阿乙/)
  assert.ok(result.prompt.includes('「阿甲，等一下。」'))
  assert.doesNotMatch(result.prompt, /「[^」]*@/)
  assert.ok(result.participants.some(p => p.characterId === 2 && p.visibility === 'offscreen'))
})

test('hidden faces do not receive invented visible emotion, while visible faces require an explicit valid emotion', () => {
  const value = plan()
  value.shots[0].characters = [{ character_id: 1, visibility: 'face_hidden' }]
  value.shots[0].rows[0].visual = '@阿甲仅见背影，抬手触碰院门。'
  const result = render(value)
  assert.deepEqual(hard(result), [])
  assert.doesNotMatch(result.prompt.split(/\r?\n/)[1], /60%/)
  const missing = plan()
  delete missing.shots[0].characters[0].emotion
  assert.equal(rejected(missing), true)
  const excessive = plan()
  excessive.shots[0].characters[0].emotion!.intensity = 101
  assert.equal(rejected(excessive), true)
})

test('a row without references uses only an existing bound scene or an actual visible participant', () => {
  const value = plan()
  value.shots[0].rows[0].visual = '抬眼看向院门。'
  const result = render(value)
  assert.deepEqual(hard(result), [])
  assert.match(result.prompt.split(/\r?\n/)[1], /@院落|@阿甲/)
  const characterOnly = render(value, context({ sceneId: null }))
  assert.deepEqual(hard(characterOnly), [])
  assert.ok(characterOnly.prompt.split(/\r?\n/)[1].includes('@阿甲'))
  assert.ok(!characterOnly.prompt.includes('@院落'))
  const offscreenOnly = plan()
  offscreenOnly.shots.forEach(shot => { shot.characters = [{ character_id: 2, visibility: 'offscreen' }]; shot.rows.forEach(row => { row.visual = '门槛空镜，保持固定机位。' }) })
  const impossible = render(offscreenOnly, context({ sceneId: null }))
  assert.ok(hard(impossible).length > 0)
  assert.ok(!impossible.prompt.includes('@阿乙'))
})

test('unknown, unbound or fabricated image-number references are rejected', () => {
  for (const visual of ['@陌生人站在门口。', '@屋内光线保持。', '@图片1阿甲站在门口。']) {
    const value = plan()
    value.shots[0].rows[0].visual = visual
    assert.ok(hard(render(value)).length > 0, visual)
  }
  const absentCharacter = plan()
  absentCharacter.shots[0].characters[0].character_id = 999
  assert.equal(rejected(absentCharacter), true)
  const unbound = plan()
  unbound.shots[0].characters[0].character_id = 2
  assert.equal(rejected(unbound, context({ characterIds: [1] })), true)
})

test('a visual character reference cannot contradict the declared shot participants or offscreen visibility', () => {
  const undeclared = plan()
  undeclared.shots[0].rows[0].visual = '@阿乙站在院门边。'
  assert.ok(hard(render(undeclared)).length > 0)
  const offscreen = plan()
  offscreen.shots[0].characters.push({ character_id: 2, visibility: 'offscreen' })
  offscreen.shots[0].rows[0].visual = '@阿乙站在院门边。'
  assert.ok(hard(render(offscreen)).length > 0)
  const gaze = plan()
  gaze.shots[0].rows[0].visual = '@阿甲追视阿乙，自己停在门边。'
  assert.deepEqual(hard(render(gaze)), [])
})

test('bound gaze or dialogue targets may stay outside the picture without becoming participants or header cast', () => {
  for (const visual of [
    '@阿甲目光直直投向床右侧的@阿乙。',
    '@阿甲正面近景，望向@阿乙。',
    '@阿甲看向坐在床沿的@阿乙。',
    '@阿甲对@阿乙低声询问。',
    '@阿甲询问门边的@阿乙。',
    '@阿甲 looks at @阿乙.',
  ]) {
    const value = plan()
    value.shots[0].characters.push({ character_id: 2, visibility: 'offscreen' })
    value.shots[0].rows[0].visual = visual
    const result = render(value)
    assert.deepEqual(hard(result), [], visual)
    assert.ok(result.prompt.includes(visual))
    assert.ok(!result.prompt.split('\n')[0].includes('@阿乙'), visual)
    assert.equal(result.participants.some(participant => participant.characterId === 2 && participant.visibility !== 'offscreen'), false)
  }
  const onlyTarget = plan()
  onlyTarget.shots[0].rows[0].visual = '目光直直投向床右侧的@阿乙。'
  const anchored = render(onlyTarget)
  assert.deepEqual(hard(anchored), [])
  assert.ok(anchored.prompt.split('\n')[1].includes('@院落，目光'), 'an offscreen target does not replace a real visual anchor')
  assert.ok(hard(render(onlyTarget, context({ characterIds: [1] }))).some(issue => issue.code === 'plan_reference'), 'a gaze cannot excuse an unbound reference')
})

test('gaze syntax never excuses actual target actions, clear faces or camera subjects missing from participants', () => {
  for (const visual of [
    '@阿甲看向@阿乙站在门口。',
    '@阿甲注视@阿乙抬手。',
    '@阿甲望向@阿乙的正脸，五官清晰。',
    '@阿甲看向@阿乙面部清晰入镜。',
    '@阿甲看向@阿乙正面近景。',
    '@阿甲 looks at @阿乙 raising one hand.',
    '镜头拍摄@阿甲和@阿乙。',
    '镜头推向@阿乙。',
  ]) {
    const value = plan()
    value.shots[0].rows[0].visual = visual
    assert.ok(hard(render(value)).some(issue => issue.code === 'plan_visual_participant'), visual)
  }
})

test('gaze moving from a static face or eyes does not introduce the target into the picture', () => {
  for (const visual of [
    '@阿甲急促喘息后视线从@阿乙脸上移开，追向矮柜方向，喉结短促滚动。',
    '@阿甲目光从@阿乙的脸上缓缓移开，自己收紧手指。',
    '@阿甲眼神从@阿乙眼睛上移开。',
    '@阿甲目光离开@阿乙的双眼。',
    '@阿甲视线移开@阿乙的正脸。',
    '@阿甲视线从阿乙脸上移开，追向矮柜方向。',
  ]) {
    const value = plan()
    value.shots[0].rows[0].visual = visual
    const result = render(value)
    assert.deepEqual(hard(result), [], visual)
    assert.ok(result.prompt.includes(visual), visual)
    assert.ok(!result.prompt.split('\n')[0].includes('@阿乙'), visual)
    assert.ok(!result.participants.some(participant => participant.characterId === 2), visual)
  }
})

test('gaze-from syntax cannot hide target actions, visible faces or camera framing', () => {
  for (const visual of [
    '@阿甲视线从@阿乙正眨眼的脸上移开。',
    '@阿甲目光离开@阿乙表情变化的正脸。',
    '@阿甲视线从@阿乙抬手的动作上移开。',
    '@阿甲视线离开@阿乙站在窗前的背影。',
    '@阿甲视线从@阿乙脸上移开，面部清晰可见。',
    '@阿甲眼神从@阿乙眼睛上移开，镜头给对方特写。',
    '@阿甲视线从特写中的@阿乙脸上移开。',
    '@阿甲目光离开@阿乙正脸特写。',
  ]) {
    const value = plan()
    value.shots[0].rows[0].visual = visual
    const result = render(value)
    assert.equal(result.prompt, '', visual)
    assert.ok(hard(result).some(issue => issue.code === 'plan_visual_participant'), visual)
  }
})

test('returning or resting gaze keeps a static direction or face outside pictured participants', () => {
  for (const visual of [
    '@阿甲视线从水杯转回@阿乙方向。',
    '@阿甲视线停在@阿乙脸上。',
    '@阿甲目光缓缓转回@阿乙的方向，自己收紧手指。',
    '@阿甲眼神停在@阿乙的双眼上。',
    '@阿甲视线从水杯转回阿乙方向。',
    '@阿甲视线停在阿乙脸上。',
  ]) {
    const value = plan()
    value.shots[0].rows[0].visual = visual
    const result = render(value)
    assert.deepEqual(hard(result), [], visual)
    assert.ok(result.prompt.includes(visual), visual)
    assert.ok(!result.prompt.split('\n')[0].includes('@阿乙'), visual)
    assert.ok(!result.participants.some(participant => participant.characterId === 2), visual)
  }
  for (const visual of ['视线从水杯转回@阿乙方向。', '视线停在@阿乙脸上。']) {
    const value = plan()
    value.shots[0].rows[0].visual = visual
    const result = render(value)
    assert.deepEqual(hard(result), [], visual)
    assert.ok(result.prompt.split('\n')[1].includes(`@院落，${visual}`), 'a gaze target does not become the visual anchor')
  }
})

test('returning or resting gaze cannot excuse target acting, facial changes or explicit framing', () => {
  for (const visual of [
    '@阿甲视线从水杯转回@阿乙正眨眼的方向。',
    '@阿甲视线停在@阿乙表情变化的脸上。',
    '@阿甲视线转回@阿乙抬手的方向。',
    '@阿甲视线停在@阿乙站在窗前的背影。',
    '@阿甲视线停在@阿乙脸上，后者正眨眼。',
    '@阿甲视线转回@阿乙方向，双手抬起。',
    '@阿甲视线停在@阿乙脸上，表情变化。',
    '@阿甲视线转回特写中的@阿乙方向。',
    '@阿甲视线停在@阿乙脸上，面部清晰可见。',
    '@阿甲视线停在@阿乙的正脸特写。',
    '@阿甲视线停在阿乙站在窗前。',
  ]) {
    const value = plan()
    value.shots[0].rows[0].visual = visual
    const result = render(value)
    assert.equal(result.prompt, '', visual)
    assert.ok(hard(result).some(issue => issue.code === 'plan_visual_participant'), visual)
  }
})

test('omitting @ does not hide a uniquely bound name with explicit in-frame acting or framing', () => {
  for (const visual of [
    '@阿甲正面中景，镜头固定，画面中阿乙背影站在窗前，双手放下。',
    '@阿甲正面近景，阿乙正面近景，五官清晰。',
    '@阿甲正面近景，阿乙抬手扶住窗框。',
    '@阿甲正面近景，镜头拍摄阿乙。',
    '@阿甲正面近景，阿乙的眼睛清晰可见。',
    '@阿甲看向阿乙的正脸，五官清晰。',
  ]) {
    const value = trustedDialoguePlan()
    value.shots[0].rows[0].visual = visual
    const result = render(value, trustedDialogueContext())
    assert.equal(result.prompt, '', visual)
    assert.ok(hard(result).some(issue => issue.code === 'plan_visual_participant'), visual)
    assert.ok(!hard(result).some(issue => issue.code === 'plan_speaker_visibility'), visual)
  }
})

test('unmarked pure gaze or dialogue targets and pictured people do not become live participants', () => {
  for (const visual of [
    '@阿甲目光直直投向床右侧的阿乙。',
    '@阿甲看向坐在床沿的阿乙。',
    '@阿甲对阿乙低声询问。',
    '@阿甲视线从阿乙的脸上移开，追向矮柜方向。',
    '@阿甲正面近景，照片中的阿乙背影站在窗前。',
    '@阿甲正面近景，画中人阿乙正面近景。',
    '@阿甲正面近景，阿乙的照片正面特写。',
    '@阿甲正面近景，阿乙在照片里抬手。',
    '@阿甲正面近景，阿乙的背影的照片挂在墙上。',
  ]) {
    const value = trustedDialoguePlan()
    value.shots[0].rows[0].visual = visual
    const result = render(value, trustedDialogueContext())
    assert.deepEqual(hard(result), [], visual)
    assert.ok(result.prompt.includes(visual), visual)
    assert.ok(!result.prompt.split('\n')[0].includes('@阿乙'), visual)
    assert.ok(!result.participants.some(participant => participant.characterId === 2), visual)
  }
})

test('plain-name participant checks use exact unambiguous names instead of substrings or aliases', () => {
  const value = plan()
  value.shots[0].characters.push({ character_id: 6, visibility: 'face_hidden' })
  value.shots[0].rows[0].visual = '@阿甲正面中景，画面中小阿乙背影站在窗前。'
  const withLongerName = context({ characters: [{ id: 1, name: '阿甲' }, { id: 2, name: '阿乙' }, { id: 6, name: '小阿乙' }], characterIds: [1, 2, 6] })
  assert.deepEqual(hard(render(value, withLongerName)), [])

  const alias = plan()
  alias.shots[0].rows[0].visual = '@阿甲正面中景，小阿乙抬手。'
  assert.deepEqual(hard(render(alias)), [], 'an unknown longer name is not the shorter official name')

  const ambiguous = plan()
  ambiguous.shots[0].rows[0].visual = '@阿甲正面中景，画面中阿乙背影站在窗前。'
  assert.deepEqual(hard(render(ambiguous, context({ characters: [{ id: 1, name: '阿甲' }, { id: 2, name: '阿乙' }, { id: 6, name: '阿乙' }], characterIds: [1, 2, 6] }))), [])
  assert.deepEqual(hard(render(ambiguous, context({ props: [{ id: 5, name: '阿乙' }] }))), [], 'cross-category names are not guessed')
})

test('a correctly declared visible participant may keep a plain formal name in visual prose', () => {
  const value = plan()
  value.shots[0].characters.push({ character_id: 2, visibility: 'face_hidden' })
  value.shots[0].rows[0].visual = '@阿甲正面中景，画面中阿乙背影站在窗前，双手放下。'
  const result = render(value)
  assert.deepEqual(hard(result), [])
  assert.ok(result.participants.some(participant => participant.characterId === 2 && participant.visibility === 'face_hidden'))
})

test('space is preserved verbatim and missing coordinates are never invented by the renderer', () => {
  const actual = '以既有院门为原点A0，X向东，Y向北，沿用当前人物站位。'
  const preserved = render(plan({ space: actual }))
  assert.deepEqual(hard(preserved), [])
  assert.ok(preserved.prompt.includes(actual))
  const source = '现有资料仅说明两人在门内，坐标尚未确定。'
  const value = plan({ space: source })
  value.shots[0].rows[0].visual = '@阿甲站在门内抬眼。'
  const result = render(value)
  assert.ok(hard(result).some(issue => issue.code === 'plan_space_origin'))
  assert.equal(result.prompt, '')
  assert.doesNotMatch(result.prompt, /A0|X\+|Y\+|X轴|Y轴/)
})

test('narration without a real character ID keeps its voice source explicit and does not invent a participant', () => {
  const value = plan()
  value.shots[0].rows[0].dialogue = [{ kind: 'narration', text: '院内安静。', voice }]
  const result = render(value)
  assert.deepEqual(hard(result), [])
  assert.match(result.prompt, /旁白.*院内安静/)
  assert.equal(result.participants.some(participant => participant.characterId !== 1), false)
})

test('speech needs complete explicit voice details instead of renderer-invented defaults', () => {
  for (const incomplete of [undefined, {}, { age: '中年' }, { ...voice, timbre: '' }]) {
    const value: any = plan()
    value.shots[0].rows[0].dialogue = [{ speaker_id: 1, kind: 'dialogue', text: '你好。', voice: incomplete }]
    assert.equal(rejected(value), true)
  }
})

test('per-row speech budgets reject overcapacity, impossible spoken seconds and do not speed dialogue up', () => {
  for (const dialogue of [
    { speaker_id: 1, kind: 'dialogue' as const, text: '好'.repeat(14), voice },
    { speaker_id: 1, kind: 'dialogue' as const, text: '你好。', voice, spoken_seconds: 4 },
    { speaker_id: 1, kind: 'dialogue' as const, text: '你好呀。', voice, spoken_seconds: 0.5 },
  ]) {
    const value = plan()
    value.shots[0].rows[0].dialogue = [dialogue]
    assert.equal(rejected(value), true)
  }
  const remainder = plan()
  remainder.shots[1].rows[1].dialogue = [{ speaker_id: 1, kind: 'dialogue', text: '好'.repeat(10), voice }]
  assert.equal(rejected(remainder, context({ duration: 8 })), true)
})

test('whole-group dialogue capacity includes performance margin even when each individual row fits', () => {
  const value = plan()
  value.shots.forEach(shot => shot.rows.forEach(row => { row.dialogue = [{ speaker_id: 1, kind: 'dialogue', text: '好'.repeat(11), voice }] }))
  assert.equal(rejected(value), true)
})

test('an English template does not turn unchanged Chinese dialogue into one word or bypass its speech capacity', () => {
  const value = plan()
  value.shots[0].rows[0].dialogue = [{ speaker_id: 1, kind: 'dialogue', text: '好'.repeat(14), voice }]
  assert.equal(rejected(value, context({ language: 'en' })), true)
})

test('schema rejects invalid shape, visibility and row cardinalities', () => {
  assert.equal(videoPromptPlanSchema.safeParse({}).success, false)
  assert.equal(videoPromptPlanSchema.safeParse({ ...plan(), shots: [] }).success, false)
  assert.equal(videoPromptPlanSchema.safeParse({ ...plan(), shots: [plan().shots[0]] }).success, false)
  const badVisibility: any = plan()
  badVisibility.shots[0].characters[0].visibility = 'cloned'
  assert.equal(videoPromptPlanSchema.safeParse(badVisibility).success, false)
  for (const count of [0, 3]) {
    const value = plan()
    value.shots[0].rows = Array.from({ length: count }, () => ({ visual: '@阿甲站在门内。' }))
    assert.equal(videoPromptPlanSchema.safeParse(value).success, false)
  }
})

test('shot order and total time-row cardinality cannot silently change the established storyboard', () => {
  const outOfOrder = plan()
  outOfOrder.shots.reverse()
  assert.equal(rejected(outOfOrder), true)
  const duplicate = plan()
  duplicate.shots[1].shot_number = 1
  assert.equal(rejected(duplicate), true)
  const tooFewRows = plan()
  tooFewRows.shots[1].rows.pop()
  assert.equal(rejected(tooFewRows), true)
  const tooManyRows = plan()
  tooManyRows.shots[0].rows.push({ visual: '@阿甲保持坐姿。' })
  assert.equal(rejected(tooManyRows), true)
})

const voiceReferenceContext = (overrides: Partial<Context> = {}): Context => context({
  characters: [{ id: 1, name: '阿甲', voiceReference: '#阿甲' }, { id: 2, name: '阿乙', voiceReference: '#阿乙' }],
  ...overrides,
})

test('available real voice references are automatically included for every repeated spoken turn without changing dialogue', () => {
  const value = plan()
  value.shots[0].rows[0].dialogue = [{ speaker_id: 1, kind: 'dialogue', text: '你好。', voice }]
  value.shots[1].rows[0].dialogue = [{ speaker_id: 1, kind: 'dialogue', text: '你好。', voice }]
  const result = render(value, voiceReferenceContext())
  assert.deepEqual(hard(result), [])
  const lines = result.prompt.split(/\r?\n/)
  assert.ok(!lines[0].includes('#'))
  assert.ok(lines[1].includes('#阿甲'))
  assert.ok(lines[2].includes('#阿甲'))
  assert.equal(result.prompt.match(/#阿甲/g)?.length, 2)
  assert.equal(result.prompt.match(/「你好。」/g)?.length, 2)
  assert.doesNotMatch(result.prompt, /「[^」]*#|「[^」]*@/)
  assert.ok(result.prompt.includes(voice.age) && result.prompt.includes(voice.register) && result.prompt.includes(voice.timbre))
})

test('an explicit voice token must match the same bound speaker current available token', () => {
  const explicit = (token: string, speakerId: number | undefined = 1, kind: 'dialogue' | 'offscreen' | 'narration' = 'dialogue') => {
    const value = plan()
    value.shots[0].rows[0].dialogue = [{ speaker_id: speakerId, kind, text: '你好。', voice, voice_reference: token }]
    return value
  }
  assert.deepEqual(hard(render(explicit('#阿甲'), voiceReferenceContext())), [])
  for (const token of ['#不存在', '#阿乙']) assert.equal(rejected(explicit(token), voiceReferenceContext()), true)
  for (const voiceReference of [undefined, null]) {
    const unavailable = voiceReferenceContext({ characters: [{ id: 1, name: '阿甲', voiceReference }, { id: 2, name: '阿乙', voiceReference: '#阿乙' }] })
    assert.equal(rejected(explicit('#阿甲'), unavailable), true)
  }
  const withoutSpeaker = explicit('#阿甲', 1, 'narration')
  delete withoutSpeaker.shots[0].rows[0].dialogue![0].speaker_id
  assert.equal(rejected(withoutSpeaker, voiceReferenceContext()), true)
  assert.equal(rejected(explicit('#阿乙', 2, 'offscreen'), voiceReferenceContext({ characterIds: [1] })), true)
})

test('offscreen and narrated real-character voice labels keep their source and token outside the on-screen header', () => {
  for (const kind of ['offscreen', 'narration'] as const) {
    const value = plan()
    value.shots[0].characters.push({ character_id: 2, visibility: 'offscreen' })
    value.shots[0].rows[0].dialogue = [{ speaker_id: 2, kind, text: '阿甲，等一下。', voice }]
    const result = render(value, voiceReferenceContext())
    assert.deepEqual(hard(result), [], kind)
    const [header, ...rows] = result.prompt.split(/\r?\n/)
    assert.ok(!header.includes('阿乙') && !header.includes('#'))
    const spoken = rows.find(row => row.includes('「阿甲，等一下。」')) || ''
    assert.ok(spoken.includes('阿乙') && spoken.includes('#阿乙'))
    assert.match(spoken, kind === 'offscreen' ? /画外|OS/ : /旁白/)
    assert.doesNotMatch(spoken, /「[^」]*#|「[^」]*@/)
  }
})

test('the absence of a real voice reference remains valid and never invents a token', () => {
  const value = plan()
  value.shots[0].rows[0].dialogue = [{ speaker_id: 1, kind: 'dialogue', text: '你好。', voice }]
  const result = render(value, context())
  assert.deepEqual(hard(result), [])
  assert.ok(!result.prompt.includes('#'))
})
