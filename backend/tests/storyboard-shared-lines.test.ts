import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assignSharedLineSpeech, sharedLineSplitConflict, sharedSpokenSourceIds, validateSpeechAssignment } from '../src/services/storyboard-shared-lines.ts'
import { analyzeNarrativeSpeechCapacity, buildScriptUnitSpeechBudgets, splitScriptUnits, validateNarrativePlan } from '../src/services/skill-storyboard-contract.ts'

// Real 第4集 lines 6–13 and the group shapes of the plan that failed on 2026-11-05
// (groups 2–5 there; renumbered 1–4 here).
const script = [
  '高大山：你家一分不出，还想先拿走晓曼留给晓茹的五百？陈明远，这婚你是跟晓茹结，还是跟钱结？',
  '陈明远：（硬挤出笑）姐夫，我是借。等小卖部挣了钱，连本带利还。',
  '高大山：先别叫姐夫。她还没跟你领证。你说借，拿什么还？',
  '陈明远：我家就那两间临街房……',
  '张晓茹：（盯着陈明远）那就把房典给姐夫。你不是说开了店就能挣钱吗？一年还上，房还是你家的。',
  '▲陈明远看看张晓茹，又看高大山。高大山从衣兜里取出钱，却没有递过去。',
  '高大山：五百，我借。房子典一年，你们照住；期限、赎房条件，找街道写进契里。你妈敢带着房契来，今晚就拿钱。',
  '陈明远：行，我这就回去跟我妈说，让她把房契带过来，今晚当着街道的人把契写清楚，谁也别反悔。',
].join('\n')
const characters = [{ id: 1, name: '高大山' }, { id: 2, name: '陈明远' }, { id: 3, name: '张晓茹' }]
const assets = { characters, scenes: [{ id: 7, location: '大杂院中门' }], props: [] }
const units = splitScriptUnits(script)
const budgets = buildScriptUnitSpeechBudgets(units, { characters })
const plan = [
  { number: 1, title: '推车质问', beat: 'narrative' as const, source_ids: [1, 2], scene_id: 7, duration: 13 },
  { number: 2, title: '拿什么还', beat: 'narrative' as const, source_ids: [2, 3, 4, 5], scene_id: 7, duration: 14 },
  { number: 3, title: '取钱定契', beat: 'narrative' as const, source_ids: [5, 6, 7], scene_id: 7, duration: 10 },
  { number: 4, title: '回去拿契', beat: 'narrative' as const, source_ids: [7, 8], scene_id: 7, duration: 13 },
]
const splitMessage = /原有标点处切分/
const splitIssues = (groups: typeof plan, scriptText = script) => validateNarrativePlan({ groups }, splitScriptUnits(scriptText), assets, scriptText)
  .filter(issue => issue.severity === 'error' && splitMessage.test(issue.message))

test('shared lines are split only at existing punctuation and every word is assigned exactly once, in order', () => {
  assert.deepEqual(sharedSpokenSourceIds(plan, budgets), [2, 5, 7])
  const result = assignSharedLineSpeech(plan, budgets)
  assert.ok(result, 'the real plan is feasible with punctuation cuts')
  const all = result!.groups.flatMap(group => group.pieces)
  for (const id of result!.shared_source_ids) {
    const original = budgets[id - 1].utterances.map(utterance => utterance.text).join('')
    assert.equal(all.filter(piece => piece.source_id === id).map(piece => piece.text).join(''), original, `line ${id} is reproduced character for character`)
    for (const piece of all.filter(entry => entry.source_id === id && entry.part === 'head')) {
      assert.match(piece.text, /[。！？；，、,:：…]$/u, 'a head piece always ends at an existing punctuation mark')
    }
  }
  // Same split as computed from the real 第4集 data.
  assert.deepEqual(result!.groups.map(group => group.pieces.map(piece => `${piece.source_id}:${piece.text}`)), [
    ['2:姐夫，我是借。等小卖部挣了钱，'],
    ['2:连本带利还。', '5:那就把房典给姐夫。你不是说开了店就能挣钱吗？'],
    ['5:一年还上，房还是你家的。', '7:五百，我借。房子典一年，你们照住；期限、赎房条件，找街道写进契里。'],
    ['7:你妈敢带着房契来，今晚就拿钱。'],
  ])
  for (const group of result!.groups) assert.ok(group.spoken_characters <= group.capacity_characters, `group ${group.group_number} fits`)
  assert.deepEqual(splitIssues(plan), [], 'a feasible punctuation split is not a plan conflict')
})

test('a plan whose capacity only works by cutting a shared line mid-word is a planning conflict', () => {
  // 40 spoken characters; the only punctuation inside is after the first word.
  const line = `好，${'我会把这件事情原原本本地说给你听'.repeat(2)}还有六个字没讲。`
  const text = `阿甲：${line}\n动作：${'院中晨光照进来，衣袖随着脚步自然轻摆。'.repeat(5)}`
  const names = [{ id: 1, name: '阿甲' }]
  const lineUnits = splitScriptUnits(text), lineBudgets = buildScriptUnitSpeechBudgets(lineUnits, { characters: names })
  const groups = [
    { number: 1, title: 'a', beat: 'narrative' as const, source_ids: [1], scene_id: 7, duration: 8 },
    { number: 2, title: 'b', beat: 'narrative' as const, source_ids: [1, 2], scene_id: 7, duration: 8 },
  ]
  assert.equal(lineBudgets[0].spoken_characters, 40)
  assert.equal(analyzeNarrativeSpeechCapacity(groups, lineBudgets).feasible, true, 'total capacity alone would accept it (27 + 27)')
  assert.equal(assignSharedLineSpeech(groups, lineBudgets), null)
  assert.equal(sharedLineSplitConflict(groups, lineBudgets), true)
  const issues = validateNarrativePlan({ groups }, lineUnits, { ...assets, characters: names }, text).filter(issue => issue.severity === 'error' && splitMessage.test(issue.message))
  assert.equal(issues.length, 1)
  assert.equal(issues[0].code, 'constraint_conflict')
})

test('a shared line without any punctuation inside keeps the original behaviour (no program split, no new conflict)', () => {
  const text = `阿甲：${'话'.repeat(80)}。\n动作：${'静'.repeat(100)}。`
  const names = [{ id: 1, name: '阿甲' }]
  const lineUnits = splitScriptUnits(text), lineBudgets = buildScriptUnitSpeechBudgets(lineUnits, { characters: names })
  const groups = [
    { number: 1, title: 'a', beat: 'narrative' as const, source_ids: [1], scene_id: 7, duration: 12 },
    { number: 2, title: 'b', beat: 'narrative' as const, source_ids: [1, 2], scene_id: 7, duration: 12 },
  ]
  assert.equal(assignSharedLineSpeech(groups, lineBudgets), null, 'no assignment is sent; the model divides it as before')
  assert.equal(sharedLineSplitConflict(groups, lineBudgets), false)
})

test('a plan without shared spoken lines is unaffected', () => {
  const separate = [
    { number: 1, title: 'a', beat: 'narrative' as const, source_ids: [1, 2], scene_id: 7, duration: 15 },
    { number: 2, title: 'b', beat: 'narrative' as const, source_ids: [3, 4, 5], scene_id: 7, duration: 15 },
    { number: 3, title: 'c', beat: 'narrative' as const, source_ids: [6, 7, 8], scene_id: 7, duration: 15 },
  ]
  assert.deepEqual(sharedSpokenSourceIds(separate, budgets), [])
  assert.equal(assignSharedLineSpeech(separate, budgets), null)
  assert.equal(sharedLineSplitConflict(separate, budgets), false)
  assert.deepEqual(splitIssues(separate), [])
})

test('speaking another group\'s part of a shared line, or skipping your own, is an assignment error', () => {
  const result = assignSharedLineSpeech(plan, budgets)!
  const names = characters.map(character => character.name)
  const mine = result.groups.find(group => group.group_number === 1)!.pieces.find(piece => piece.source_id === 2)!
  const whole = budgets[1].utterances[0].text
  const own = { shot_number: 1, description: `【镜头1】陈明远说：「${mine.text}」【镜头2】无声。` }
  assert.deepEqual(validateSpeechAssignment(own, result, 1, names), [])
  const greedy = { shot_number: 1, description: `【镜头1】陈明远说：「${whole}」【镜头2】无声。` }
  assert.ok(validateSpeechAssignment(greedy, result, 1, names).some(issue => issue.code === 'speech_assignment' && issue.message.includes('由第2组接着说')))
  const silent = { shot_number: 1, description: '【镜头1】陈明远看着他。【镜头2】无声。' }
  assert.ok(validateSpeechAssignment(silent, result, 1, names).some(issue => issue.code === 'speech_assignment' && issue.message.includes(mine.text)))
})
