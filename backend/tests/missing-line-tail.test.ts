import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateSkillDialogueCoverage, type SkillCandidate } from '../src/services/skill-storyboard-validation.ts'

// Regression from the real 第1集 group 8 failure: the source line was
// 「他才两岁。你再碰他一下试试。」 but only 「他才两岁。」 was written, and the next
// line belongs to another speaker. The diagnosis must say which original words
// are missing instead of blaming the speaker identity.
const names = ['高大山', '张晓军', '秦翠花']
const script = '秦翠花：大山，晓军跟孩子闹着玩呢！\n高大山：（盯着张晓军）他才两岁。你再碰他一下试试。\n张晓军：（捂住手腕）妈，他来真的！'
const group = (description: string): SkillCandidate => ({ shot_number: 8, source_ids: [1, 2, 3], description })

test('an omitted second half of a line is reported as missing original words, not as a speaker mismatch', () => {
  const issues = validateSkillDialogueCoverage([group('【镜头1】秦翠花说：「大山，晓军跟孩子闹着玩呢！」【镜头2】高大山说：「他才两岁。」张晓军说：「妈，他来真的！」')], script, names)
  const errors = issues.filter(issue => issue.severity === 'error')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, 'dialogue_coverage')
  assert.equal(errors[0].shotNumber, 8)
  assert.equal(errors[0].field, 'source_ids.2')
  assert.doesNotMatch(errors[0].message, /说话者或声音类型/)
  assert.match(errors[0].message, /你再碰他一下试试。/)
  assert.match(errors[0].message, /高大山/)
})

test('a genuinely wrong speaker for the same words is still reported as a speaker mismatch', () => {
  const issues = validateSkillDialogueCoverage([group('【镜头1】秦翠花说：「大山，晓军跟孩子闹着玩呢！」【镜头2】张晓军说：「他才两岁。你再碰他一下试试。」张晓军说：「妈，他来真的！」')], script, names)
  const errors = issues.filter(issue => issue.severity === 'error')
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /说话者或声音类型与原文不一致/)
})

test('a complete line with no omission produces no coverage error', () => {
  const issues = validateSkillDialogueCoverage([group('【镜头1】秦翠花说：「大山，晓军跟孩子闹着玩呢！」【镜头2】高大山说：「他才两岁。你再碰他一下试试。」张晓军说：「妈，他来真的！」')], script, names)
  assert.deepEqual(issues.filter(issue => issue.severity === 'error'), [])
})
