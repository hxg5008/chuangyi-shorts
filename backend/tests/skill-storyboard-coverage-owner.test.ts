import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateSkillDialogueCoverage, type SkillCandidate } from '../src/services/skill-storyboard-validation.ts'

const names = ['阿甲', '阿乙']
const original = '阿甲：开头，尾句。\n阿乙：下一句。'
const candidate = (shot_number: number, source_ids: number[], text: string): SkillCandidate => ({
  shot_number, source_ids, description: `【镜头1】${text}`,
})
const errors = (rows: SkillCandidate[], script = original) => validateSkillDialogueCoverage(rows, script, names)
  .filter(issue => issue.severity === 'error')

test('a missing source tail belongs to its earlier owner when the next group correctly starts its own source', () => {
  const rows = [candidate(7, [1], '阿甲说：「开头，」'), candidate(8, [2], '阿乙说：「下一句。」')]
  const before = structuredClone(rows)
  const [issue] = errors(rows)
  assert.equal(issue.field, 'source_ids.1')
  assert.equal(issue.shotNumber, 7)
  assert.match(issue.message, /原文发声未在应有位置完整覆盖/)
  assert.deepEqual(rows, before)
})

test('matching tail words spoken by a wrong actor are still attributed to the actual offending group', () => {
  const rows = [candidate(7, [1], '阿甲说：「开头，」'), candidate(8, [1, 2], '阿乙说：「尾句。」阿乙说：「下一句。」')]
  const [issue] = errors(rows)
  assert.equal(issue.shotNumber, 8)
  assert.match(issue.message, /说话者或声音类型与原文不一致/)
})

test('a later matching line cannot excuse an unrelated group or convert an insertion into a missing tail', () => {
  const unrelated = [candidate(7, [1], '阿甲说：「开头，」'), candidate(8, [1], '阿乙说：「下一句。」')]
  assert.equal(errors(unrelated)[0].shotNumber, 8)
  assert.match(errors(unrelated)[0].message, /说话者或声音类型与原文不一致/)
  const insertion = [candidate(7, [1], '阿甲说：「开头，」'), candidate(8, [2], '阿乙说：「额外。」阿乙说：「下一句。」')]
  assert.equal(errors(insertion).length, 1)
  assert.equal(errors(insertion)[0].shotNumber, 8)
})

test('a fully preserved tail including 说完 passes and a repeated extra line still fails', () => {
  const rows = [candidate(7, [1], '阿甲说：「开头，」阿甲说完：「尾句。」'), candidate(8, [2], '阿乙说：「下一句。」')]
  assert.deepEqual(errors(rows), [])
  rows[1].description += '阿乙说：「下一句。」'
  assert.match(errors(rows)[0].message, /出现原文之外或重复的发声内容/)
})
