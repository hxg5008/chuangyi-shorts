import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDialogueTimingGuide } from '../src/services/first-pass-instructions.ts'
import { videoPromptPlanSchema } from '../src/services/video-prompt-plan.ts'
import { resolveSourceDialoguePlan, videoPromptPlanInputSchema } from '../src/services/source-dialogue-plan.ts'

const voice = { age: '中年', register: '低音', timbre: '温润' }
const guide = buildDialogueTimingGuide([
  { speakerName: '阿甲', kind: 'dialogue', text: '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黄。' },
  { speakerName: '阿乙', kind: 'offscreen', text: '别停。' },
  { kind: 'narration', text: '院里安静。' },
  { speakerName: '未绑定发声者', kind: 'offscreen', text: '我在外面。' },
], [{ id: 1, name: '阿甲' }, { id: 2, name: '阿乙' }])
const ref = (source_line = 1, fragment_index = 1) => ({ source_line, fragment_index, voice: { ...voice } })
const plan = (): any => ({
  space: 'A0为门槛，X向东，Y向北。', shots: [
    { shot_number: 1, characters: [{ character_id: 1, visibility: 'face_hidden' }], rows: [{ visual: '@阿甲背影。', dialogue: [ref(1, 1)] }] },
    { shot_number: 2, characters: [{ character_id: 1, visibility: 'face_hidden' }], rows: [
      { visual: '@阿甲放下左手。', dialogue: [ref(1, 2)] }, { visual: '@阿甲准备迈步。', dialogue: [ref(2, 1)] },
    ] },
  ],
})
const dialogues = (value: NonNullable<ReturnType<typeof resolveSourceDialoguePlan>['plan']>) => value.shots.flatMap(shot => shot.rows.flatMap(row => row.dialogue || []))

test('tool-only top-level notes are discarded and cannot change the resolved speech or provider plan', () => {
  const input = { ...plan(), shots_note: 'temporary planning annotation' }
  const result = resolveSourceDialoguePlan(input, guide)
  assert.deepEqual(result.issues, [])
  assert.ok(result.plan)
  assert.equal(Object.hasOwn(result.plan!, 'shots_note'), false)
  assert.equal(dialogues(result.plan!)[0].text, guide[0].fragments[0])
})

test('source input resolves exact guide fragments, kind and character identity into a strict provider-independent plan', () => {
  const input = plan()
  assert.equal(videoPromptPlanInputSchema.safeParse(input).success, true)
  assert.equal(videoPromptPlanSchema.safeParse(input).success, false)
  const result = resolveSourceDialoguePlan(input, guide)
  assert.deepEqual(result.issues, [])
  assert.ok(result.plan)
  assert.equal(result.hasSourceEntries, true)
  assert.equal(result.hasLegacyDialogue, false)
  assert.deepEqual(result.sourceRefs, [{ source_line: 1, fragment_index: 1 }, { source_line: 1, fragment_index: 2 }, { source_line: 2, fragment_index: 1 }])
  assert.deepEqual(result.sourceSlots, [
    { source_line: 1, fragment_index: 1, shotNumber: 1, rowIndex: 0, dialogueIndex: 0 },
    { source_line: 1, fragment_index: 2, shotNumber: 2, rowIndex: 0, dialogueIndex: 0 },
    { source_line: 2, fragment_index: 1, shotNumber: 2, rowIndex: 1, dialogueIndex: 0 },
  ])
  const speech = dialogues(result.plan!)
  assert.equal(speech[0].text, guide[0].fragments[0])
  assert.equal(speech[1].text, guide[0].fragments[1])
  assert.equal(speech[0].speaker_id, 1)
  assert.equal(speech[0].kind, 'dialogue')
  assert.equal(speech[2].speaker_id, 2)
  assert.equal(speech[2].kind, 'offscreen')
  speech.forEach(entry => { assert.equal(Object.hasOwn(entry, 'source_line'), false); assert.equal(Object.hasOwn(entry, 'fragment_index'), false) })
  assert.equal(videoPromptPlanSchema.safeParse(result.plan).success, true)
})

test('narration and an unidentified offscreen source never acquire a guessed speaker ID', () => {
  const input = plan()
  input.shots[0].rows[0].dialogue = [ref(3, 1)]
  input.shots[1].rows[0].dialogue = [ref(4, 1)]
  input.shots[1].rows[1].dialogue = undefined
  const result = resolveSourceDialoguePlan(input, guide)
  assert.deepEqual(result.issues, [])
  assert.deepEqual(dialogues(result.plan!).map(({ kind, speaker_id, text }) => ({ kind, speaker_id, text })), [
    { kind: 'narration', speaker_id: undefined, text: '院里安静。' },
    { kind: 'offscreen', speaker_id: undefined, text: '我在外面。' },
  ])
})

test('source entries cannot smuggle text, kind or speaker_id and must provide complete explicit voice information', () => {
  for (const extra of [{ text: '改写台词' }, { kind: 'narration' }, { speaker_id: 2 }]) {
    const input = plan()
    Object.assign(input.shots[0].rows[0].dialogue[0], extra)
    assert.equal(videoPromptPlanInputSchema.safeParse(input).success, false)
    assert.equal(resolveSourceDialoguePlan(input, guide).plan, null)
  }
  for (const invalid of [undefined, {}, { age: '中年' }]) {
    const input = plan()
    input.shots[0].rows[0].dialogue[0].voice = invalid
    assert.equal(resolveSourceDialoguePlan(input, guide).plan, null)
  }
})

test('unknown source lines and fragment indices are hard failures without legacy fallback or fabricated speech', () => {
  for (const entry of [ref(99, 1), ref(1, 99)]) {
    const input = plan()
    input.shots[0].rows[0].dialogue = [entry]
    const result = resolveSourceDialoguePlan(input, guide)
    assert.equal(result.plan, null)
    assert.ok(result.issues.some(issue => issue.severity === 'error'))
    assert.equal(result.hasSourceEntries, true)
  }
  for (const invalid of [0, -1, 1.5, null]) {
    const input = plan()
    input.shots[0].rows[0].dialogue[0].source_line = invalid
    assert.equal(videoPromptPlanInputSchema.safeParse(input).success, false)
  }
})

test('source fragment duplicates and inversions fail instead of being silently sorted', () => {
  for (const entries of [[ref(1, 1), ref(1, 1)], [ref(1, 2), ref(1, 1)], [ref(2, 1), ref(1, 2)]]) {
    const input = plan()
    input.shots[0].rows[0].dialogue = [entries[0]]
    input.shots[1].rows[0].dialogue = [entries[1]]
    input.shots[1].rows[1].dialogue = undefined
    const result = resolveSourceDialoguePlan(input, guide)
    assert.equal(result.plan, null)
    assert.ok(result.issues.some(issue => issue.code === 'source_order'))
    assert.deepEqual(result.sourceRefs, entries.map(({ source_line, fragment_index }) => ({ source_line, fragment_index })))
  }
})

test('a partial plan may use only one later source fragment without falsely requiring whole-episode coverage', () => {
  const input = plan()
  input.shots[0].rows[0].dialogue = [ref(1, 2)]
  input.shots[1].rows.forEach((row: any) => { row.dialogue = undefined })
  const result = resolveSourceDialoguePlan(input, guide)
  assert.deepEqual(result.issues, [])
  assert.ok(result.plan)
  assert.deepEqual(result.sourceRefs, [{ source_line: 1, fragment_index: 2 }])
})

test('legacy text protocol remains verbatim and mixed plans explicitly report both protocols', () => {
  const input = plan()
  const legacy = { kind: 'narration', text: 'Keep (every) original word，原词不翻译。', voice: { ...voice } }
  input.shots[1].rows[0].dialogue = [legacy]
  const result = resolveSourceDialoguePlan(input, guide)
  assert.deepEqual(result.issues, [])
  assert.equal(result.hasSourceEntries, true)
  assert.equal(result.hasLegacyDialogue, true)
  assert.equal(dialogues(result.plan!)[1].text, legacy.text)
  const allLegacy = plan()
  allLegacy.shots.forEach((shot: any) => shot.rows.forEach((row: any) => { row.dialogue = [legacy] }))
  const old = resolveSourceDialoguePlan(allLegacy, guide)
  assert.deepEqual(old.issues, [])
  assert.equal(old.hasSourceEntries, false)
  assert.equal(old.hasLegacyDialogue, true)
  assert.deepEqual(old.sourceRefs, [])
  assert.deepEqual(old.sourceSlots, [])
  assert.deepEqual(result.sourceSlots, [
    { source_line: 1, fragment_index: 1, shotNumber: 1, rowIndex: 0, dialogueIndex: 0 },
    { source_line: 2, fragment_index: 1, shotNumber: 2, rowIndex: 1, dialogueIndex: 0 },
  ], 'only genuine source entries receive server-owned slot identities in a mixed plan')
})

test('optional nulls and empty voice tokens normalize in the new union without changing immutable source data', () => {
  const input = plan()
  input.shots[0].characters[0].emotion = null
  Object.assign(input.shots[0].rows[0].dialogue[0], { voice: { ...voice, delivery: null }, spoken_seconds: null, voice_reference: '' })
  input.shots[1].rows[1].dialogue = null
  const original = JSON.stringify(input), originalGuide = JSON.stringify(guide)
  const result = resolveSourceDialoguePlan(input, guide)
  assert.deepEqual(result.issues, [])
  assert.equal(result.plan!.shots[0].characters[0].emotion, undefined)
  assert.equal(dialogues(result.plan!)[0].spoken_seconds, undefined)
  assert.equal(dialogues(result.plan!)[0].voice_reference, undefined)
  assert.equal(dialogues(result.plan!)[0].voice.delivery, undefined)
  assert.equal(JSON.stringify(input), original)
  assert.equal(JSON.stringify(guide), originalGuide)
})

test('required visual and plan structure stay strict when source input is enabled', () => {
  for (const mutate of [
    (input: any) => { input.space = null },
    (input: any) => { input.shots = [] },
    (input: any) => { input.shots[0].rows[0].visual = null },
    (input: any) => { input.shots[0].rows.push({ visual: 'extra' }, { visual: 'extra' }) },
  ]) {
    const input = plan(); mutate(input)
    assert.equal(videoPromptPlanInputSchema.safeParse(input).success, false)
  }
})
