import { test } from 'node:test'
import assert from 'node:assert/strict'
import { productionNoteIds, groupContentSeconds, rhythmFacts } from '../src/services/storyboard-rhythm.ts'
import { scriptTimingBudget, splitScriptUnits, validateNarrativePlan } from '../src/services/skill-storyboard-contract.ts'
import { STYLING_COLOR_EXTRACTION_NOTE, VOICE_CARD_EXTRACTION_NOTE } from '../src/services/character-voice-card.ts'

// Round 3 (2026-11-08):
//  S5  the writer's production notes in the new scripts ("首次人物建议（C）：…", "**本集人物状态与闭环**" with its
//      bullet list) stay in the script and in source_ids, but are not counted as performed time
//  10  the character extraction asks for concrete, distinguishable clothing colours (wording only; skill untouched)
const script = [
  '#### 1-01 学生宿舍302 夜 内',
  '首次人物建议（C）：林轩，二十岁，瘦高，常穿洗旧的灰色卫衣。',
  '▲林轩推门进屋，把书包甩在床上。',
  '林轩：今天的账，明天一起算。',
  '**本集人物状态与闭环**',
  '- 林轩：被室友误会，决定当面说清。',
  '- 可见结果：桌上的饭卡不见了。',
  '#### 1-02 走廊 夜 内',
  '- 走廊尽头的灯一闪一闪。',
  '林轩：谁在那儿？',
].join('\n')
const units = splitScriptUnits(script)

test('S5: casting suggestions and the bold notes section with its bullets are notes; scene lines and later dashes are not', () => {
  const notes = productionNoteIds(units)
  assert.deepEqual([...notes].sort((a, b) => a - b), [2, 5, 6, 7])
  assert.equal(notes.has(9), false, 'a dash line after a new scene heading is performed text')
  assert.equal(notes.has(3), false)
  assert.equal(productionNoteIds(splitScriptUnits('林轩：走。\n▲他推门出去。')).size, 0, 'an ordinary script has no notes')
})

test('S5: metadata and notes do not count as performed time or screenplay body budget', () => {
  const notes = productionNoteIds(units)
  const source = (id: number) => ({ text: units.find(unit => unit.id === id)?.text, spoken: id === 4 ? 9 : id === 10 ? 4 : 0, unperformed: notes.has(id) })
  const withNotes = groupContentSeconds([1, 2, 3, 4, 5, 6, 7], source)!
  const without = groupContentSeconds([1, 3, 4], source)!
  assert.ok(Math.abs(withNotes - without) < 1e-9, 'adding the note lines adds no seconds')
  assert.equal(rhythmFacts({ duration: 10, source_ids: [2, 4] }, source).opening, 'dialogue_after_heading', 'a note before the first line is not an action to perform first')

  // 2026-11-16: budget only the actual action/dialogue body. Original source
  // lines remain untouched, including their speaker labels and production notes.
  for (const [text, body] of [
    [script, '林轩推门进屋，把书包甩在床上。今天的账，明天一起算。走廊尽头的灯一闪一闪。谁在那儿？'],
    ['林轩：走。\n▲他推门出去，回头看了一眼。', '走。他推门出去，回头看了一眼。'],
  ]) {
    const count = [...body].filter(character => /[\p{L}\p{N}]/u.test(character)).length
    assert.deepEqual(scriptTimingBudget(text), { characters: count, charactersPerMinute: 500, targetSeconds: count / 500 * 60, minimumSeconds: count / 500 * 60 * 0.8, maximumSeconds: count / 500 * 60 * 1.2 })
  }
})

test('a plan total less than 1 s over the ±20% upper bound passes; a full second over and anything under the lower bound still fail', () => {
  // 431 characters (old script 第4集): target 51.72 s, bounds 41.38–62.06 s. The model's real minimum was 62.45 s.
  const text = `动作：${'甲'.repeat(431)}`
  const units = splitScriptUnits(text)
  const budget = scriptTimingBudget(text)
  assert.ok(Math.abs(budget.maximumSeconds - 431 / 500 * 60 * 1.2) < 1e-9)
  const plan = (durations: number[]) => ({ groups: durations.map((duration, index) => ({ number: index + 1, title: `${index + 1}`, beat: 'narrative', source_ids: [1], scene_id: null, duration })) })
  const total = (planValue: any) => validateNarrativePlan(planValue, units, { characters: [], scenes: [], props: [] }, text)
    .filter(issue => issue.severity === 'error' && issue.field === 'groups' && issue.code === 'constraint_conflict')
  assert.deepEqual(total(plan([12, 12, 12, 13, 13])), [], '62 s is inside the bounds')
  assert.deepEqual(total(plan([12.5, 12.5, 12.5, 12.5, 12.5])), [], '62.5 s: 0.44 s over, accepted')
  assert.deepEqual(total(plan([13, 13, 13, 12, 12])), [], '63 s: 0.94 s over, accepted')
  assert.equal(total(plan([13, 13, 13, 13, 12])).length, 1, '64 s: 1.94 s over, still a conflict')
  assert.equal(total(plan([10, 10, 10, 11])).length, 1, '41 s is under the lower bound, still a conflict')
})

test('10: the colour rule asks for concrete, distinguishable colours, keeps existing looks and changes nothing else', () => {
  for (const phrase of ['具体颜色', '不要只写', '一眼区分', '保持原有妆造', 'styling可以留空', '剧本写明的服装和颜色照写'])
    assert.ok(STYLING_COLOR_EXTRACTION_NOTE.includes(phrase), phrase)
  assert.equal(/声线|voice|分镜|video_prompt|时长/u.test(STYLING_COLOR_EXTRACTION_NOTE), false, 'about clothing only, not voice or storyboard rules')
  assert.ok(VOICE_CARD_EXTRACTION_NOTE.length > 0)
})
