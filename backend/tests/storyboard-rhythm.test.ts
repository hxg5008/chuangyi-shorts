import { test } from 'node:test'
import assert from 'node:assert/strict'
import { actionLetters, allowedBeatMinimum, groupContentSeconds, isUnperformedLine, rhythmFacts, EXPAND_RHYTHM_NOTE, PLAN_RHYTHM_NOTE } from '../src/services/storyboard-rhythm.ts'
import { buildScriptUnitSpeechBudgets, splitScriptUnits, validateNarrativePlan } from '../src/services/skill-storyboard-contract.ts'

// Real 第5集 lines (test project), renumbered.
const script = [
  '**5-03 张家屋内 中午 内**',
  '出场人物：高大山、张晓茹、陈明远、陈婆子、秦翠花',
  '▲高大山走到桌前，把另备的五百元放下。',
  '高大山：（按住钱）这五百，是我借给明远开店的。',
  '▲秦翠花一把抓起钱，又看向张晓茹。',
  '秦翠花：你们这是唱的哪一出？',
].join('\n')
const characters = [{ id: 1, name: '高大山' }, { id: 2, name: '秦翠花' }]
const units = splitScriptUnits(script)
const budgets = buildScriptUnitSpeechBudgets(units, { characters })
const source = (id: number) => ({ text: units.find(unit => unit.id === id)?.text, spoken: budgets.find(budget => budget.source_id === id)?.spoken_characters })

test('scene headings, cast lists and bold notes are not performed; ▲ lines are action', () => {
  assert.equal(isUnperformedLine('**5-03 张家屋内 中午 内**'), true)
  assert.equal(isUnperformedLine('出场人物：高大山、张晓茹'), true)
  assert.equal(isUnperformedLine('**逻辑线：**典契签成、两对新人领证后'), true)
  assert.equal(isUnperformedLine('▲高大山走到桌前，把另备的五百元放下。'), false)
  assert.equal(actionLetters('▲【特写】高大山走到桌前。', 0), 7)
  assert.equal(actionLetters('高大山：（按住钱）这五百。', 4), 0, 'a spoken line is not counted as action')
})

test('content seconds = dialogue at 4.5 chars/s + one 2 s margin + action at 500 chars/min; unknown lines give no tolerance', () => {
  const seconds = groupContentSeconds([1, 2, 3, 4], source)!
  const speech = budgets[3].spoken_characters
  const action = actionLetters(units[2].text, 0)
  assert.ok(Math.abs(seconds - (speech / 4.5 + 2 + action / (500 / 60))) < 1e-9)
  assert.equal(groupContentSeconds([1, 99], source), null)
})

test('a light group may be at most 2 s below its beat minimum, never below 8 s; a heavy group keeps the full minimum', () => {
  assert.equal(allowedBeatMinimum('narrative', 6), 8)
  assert.equal(allowedBeatMinimum('climax', 6), 10)
  assert.equal(allowedBeatMinimum('climax', 11), 10)
  assert.equal(allowedBeatMinimum('climax', 12), 12)
  assert.equal(allowedBeatMinimum('transition', 3), 8)
  assert.equal(allowedBeatMinimum('narrative', null), 10, 'no tolerance without known content')
})

test('the plan validator applies the tolerance only to light groups', () => {
  const assets = { characters, scenes: [{ id: 7, location: '张家屋内' }], props: [] }
  const light = { groups: [{ number: 1, title: 'a', beat: 'climax' as const, source_ids: [1, 2, 3, 4, 5, 6], scene_id: 7, duration: 10 }] }
  const lightIssues = validateNarrativePlan(light, units, assets, script).filter(issue => issue.severity === 'error' && issue.field === 'groups.0.duration')
  assert.deepEqual(lightIssues, [], '10 s is accepted for a light climax group')
  const tooShort = { groups: [{ ...light.groups[0], duration: 9 }] }
  assert.ok(validateNarrativePlan(tooShort, units, assets, script).some(issue => issue.field === 'groups.0.duration' && issue.message.includes('放宽2秒')))
})

test('rhythm facts name the opening shape and the spare time; the notes keep the rules and only explain time use', () => {
  const facts = rhythmFacts({ duration: 12, source_ids: [1, 2, 3, 4] }, source)
  assert.equal(facts.opening, 'action_then_dialogue')
  assert.ok(facts.action_characters_before_first_line > 0)
  assert.equal(facts.speech_characters, budgets[3].spoken_characters)
  assert.ok(Math.abs(facts.spare_seconds - Math.round((12 - (facts.speech_characters / 4.5 + 2)) * 10) / 10) < 1e-9)
  assert.equal(rhythmFacts({ duration: 10, source_ids: [4] }, source).opening, 'dialogue')
  assert.equal(rhythmFacts({ duration: 10, source_ids: [1, 2, 4] }, source).opening, 'dialogue_after_heading')
  for (const rule of ['4.5字/秒', '8—15秒']) assert.ok(PLAN_RHYTHM_NOTE.includes(rule), rule)
  for (const phrase of ['2秒表演余量只用于核对', '边做边说', '不占播放时间', '不把整个时间行空着开场']) assert.ok(EXPAND_RHYTHM_NOTE.includes(phrase), phrase)
})
