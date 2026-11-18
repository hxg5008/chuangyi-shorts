import { test } from 'node:test'
import assert from 'node:assert/strict'
import { missingOwnSpeech } from '../src/services/storyboard-source-gaps.ts'
import { assignmentSpeech } from '../src/services/storyboard-shared-lines.ts'
import { buildScriptUnitSpeechBudgets, splitScriptUnits } from '../src/services/skill-storyboard-contract.ts'

const characters = [{ id: 1, name: '秦翠花' }, { id: 2, name: '高大山' }]
const names = characters.map(character => character.name)
// Real 第1集 lines 30 and 33 (renumbered 1 and 2).
const script = '高大山：他才两岁。你再碰他一下试试。\n秦翠花：（笑脸一下收住）打晓军、护孩子？行。那今天就把晓茹娶进门，让孩子有人带。不娶，拿五百块；不给，我去你铁路单位找领导！'
const budgets = buildScriptUnitSpeechBudgets(splitScriptUnits(script), { characters })
const plan = [
  { number: 1, title: 'a', beat: 'narrative' as const, source_ids: [1], scene_id: 7, duration: 10 },
  { number: 2, title: 'b', beat: 'narrative' as const, source_ids: [2], scene_id: 7, duration: 15 },
]
const said = (description: string) => assignmentSpeech({ shot_number: 1, description }, names)
const one = said('【镜头1】@高大山说：「他才两岁。」【镜头2】@高大山说：「你再碰他一下试试。」')

test('real 第1集 g9: a changed word (娶→嫁) is reported for the group that owns the line', () => {
  const two = said('【镜头1】@秦翠花说：「打晓军、护孩子？行。」【镜头2】@秦翠花说：「那今天就把晓茹嫁进门，让孩子有人带。」【镜头3】@秦翠花说：「不娶，拿五百块；不给，我去你铁路单位找领导！」')
  const issues = missingOwnSpeech({ plan, budgets, groupNumber: 2, episodeSpeech: [one, two] })
  assert.equal(issues.length, 1)
  assert.equal(issues[0].shotNumber, 2)
  assert.match(issues[0].message, /「那今天就把晓茹娶进门，让孩子有人带。」/)
  assert.doesNotMatch(issues[0].message, /打晓军|不娶/, 'only the sentence that is really missing is named')
  assert.deepEqual(missingOwnSpeech({ plan, budgets, groupNumber: 1, episodeSpeech: [one, two] }), [])
})

test('real 第1集 g8: a missing second half is reported', () => {
  const partial = said('【镜头1】@高大山说：「他才两岁。」【镜头2】@高大山看着他。')
  const issues = missingOwnSpeech({ plan, budgets, groupNumber: 1, episodeSpeech: [partial] })
  assert.equal(issues.length, 1)
  assert.match(issues[0].message, /「你再碰他一下试试。」/)
})

test('no report when every sentence is spoken, also when one sentence spans two quotes or is said in the neighbouring group', () => {
  const split = said('【镜头1】@秦翠花说：「打晓军、护孩子？行。那今天就把晓茹娶进门，」【镜头2】@秦翠花说：「让孩子有人带。不娶，拿五百块；不给，我去你铁路单位找领导！」')
  assert.deepEqual(missingOwnSpeech({ plan, budgets, groupNumber: 2, episodeSpeech: [one, split] }), [])
  // Words moved to another group are not "missing"; order and ownership stay with the whole-episode review.
  const moved = said('【镜头1】@高大山说：「他才两岁。」')
  const neighbour = said('【镜头1】@高大山说：「你再碰他一下试试。」@秦翠花说：「打晓军、护孩子？行。那今天就把晓茹娶进门，让孩子有人带。不娶，拿五百块；不给，我去你铁路单位找领导！」')
  assert.deepEqual(missingOwnSpeech({ plan, budgets, groupNumber: 1, episodeSpeech: [moved, neighbour] }), [])
})

test('a line shared by two groups is not checked here (the speech assignment covers it)', () => {
  const sharedPlan = [
    { number: 1, title: 'a', beat: 'narrative' as const, source_ids: [1, 2], scene_id: 7, duration: 12 },
    { number: 2, title: 'b', beat: 'narrative' as const, source_ids: [2], scene_id: 7, duration: 12 },
  ]
  assert.deepEqual(missingOwnSpeech({ plan: sharedPlan, budgets, groupNumber: 1, episodeSpeech: [one] }), [])
})
