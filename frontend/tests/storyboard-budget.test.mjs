import { test } from 'node:test'
import assert from 'node:assert/strict'
import { storyboardBudgetSummary, formatStoryboardBudgetNumber, storyboardBoundaryRepairSummary } from '../app/utils/storyboard-budget.js'

const budget = { characters: 1153, targetSeconds: 138.36, preferredGroups: 12, minimumGroups: 10, maximumGroups: 13 }
const plan = count => ({ groups: Array.from({ length: count }, () => ({ duration: 8 })) })

test('old drafts without saved server budget do not invent timing from current text', () => {
  assert.equal(storyboardBudgetSummary({ plan: plan(17), script: '文字'.repeat(1153) }), null)
  assert.equal(storyboardBudgetSummary(null), null)
})

test('saved budget shows actual rejected plan count, even before groups are expanded', () => {
  const summary = storyboardBudgetSummary({ budget, plan: plan(17), groups: [] })
  assert.deepEqual(summary, { ...budget, actualGroups: 17, totalSeconds: 136, groupCountOutsideBudget: true })
})

test('body-only budget exposes only saved public count fields without re-counting source text', () => {
  const summary = storyboardBudgetSummary({
    budget: { ...budget, scope: 'script-body-v1', totalCharacters: 1500, excludedCharacters: 347, excludedLineCount: 8, bodyText: 'not-for-ui' },
    script: '不得用这个文本重算', plan: plan(12),
  })
  assert.equal(summary.scope, 'script-body-v1')
  assert.equal(summary.characters, 1153)
  assert.equal(summary.totalCharacters, 1500)
  assert.equal(summary.excludedCharacters, 347)
  assert.equal(summary.excludedLineCount, 8)
  assert.equal(Object.hasOwn(summary, 'bodyText'), false)
  assert.equal(Object.hasOwn(storyboardBudgetSummary({ budget, plan: plan(12) }), 'scope'), false, 'historical budgets must not be labelled body-only')
})

test('invalid optional body statistics are omitted without inventing counts', () => {
  const summary = storyboardBudgetSummary({ budget: { ...budget, scope: 'script-body-v1', totalCharacters: 1000, excludedCharacters: -1, excludedLineCount: 1.5 }, plan: plan(12) })
  assert.equal(summary.scope, 'script-body-v1')
  for (const field of ['totalCharacters', 'excludedCharacters', 'excludedLineCount']) assert.equal(Object.hasOwn(summary, field), false)
})

test('valid plan count is within server range and decimals remain readable', () => {
  const summary = storyboardBudgetSummary({ budget, plan: { groups: Array.from({ length: 12 }, () => ({ duration: 11.5 })) } })
  assert.equal(summary.actualGroups, 12)
  assert.equal(summary.totalSeconds, 138)
  assert.equal(summary.groupCountOutsideBudget, false)
  assert.equal(formatStoryboardBudgetNumber(summary.targetSeconds), '138.36')
  assert.equal(formatStoryboardBudgetNumber(summary.totalSeconds), '138')
})

test('empty planning and incomplete durations never appear as zero second finished plan', () => {
  assert.equal(storyboardBudgetSummary({ budget, plan: { groups: [] } }).groupCountOutsideBudget, false)
  assert.equal(storyboardBudgetSummary({ budget, groups: [{ number: 1, candidate: null }] }).totalSeconds, null)
})

test('invalid server budget hides display; internal stored plan envelope is supported', () => {
  for (const invalid of [{ maximumGroups: 9 }, { targetSeconds: NaN }, { minimumGroups: 0 }, { characters: '1153' }]) {
    assert.equal(storyboardBudgetSummary({ budget: { ...budget, ...invalid }, plan: plan(12) }), null)
  }
  assert.equal(storyboardBudgetSummary({ plan: { budget, data: plan(17) } }).actualGroups, 17)
  assert.equal(formatStoryboardBudgetNumber(null), '—')
})

test('boundary history keeps only five newest valid public summaries and strips draft snapshots', () => {
  const entries = Array.from({ length: 7 }, (_, index) => ({ id: String(index), left: index + 1, right: index + 2, status: 'applied', createdAt: `2026-11-${String(index + 1).padStart(2, '0')}T00:00:00Z`, reason: 'details', before: { raw: 'private-snapshot' } }))
  const result = storyboardBoundaryRepairSummary({ boundaryRepairs: [...entries, { left: 0, right: 1, status: 'running' }, { left: 1, right: 3, status: 'failed' }] })
  assert.equal(result.length, 5)
  assert.deepEqual(result.map(item => item.key), ['6', '5', '4', '3', '2'])
  assert.equal(result[0].label, '已修复')
  assert.ok(!JSON.stringify(result).includes('private-snapshot'))
  assert.ok(result.every(item => item.error === ''))
})

test('boundary history reports failed reason and never claims an unrelated state is repaired', () => {
  const result = storyboardBoundaryRepairSummary({ boundaryRepairs: [
    { left: 2, right: 3, status: 'failed', error: '第2组末态与第3组原文仍有冲突。' },
    { left: 3, right: 4, status: 'running' },
    { left: 4, right: 5, status: 'unknown' },
  ] })
  assert.equal(result.length, 2)
  assert.equal(result[0].label, '修复中')
  assert.equal(result[1].label, '未修复')
  assert.equal(result[1].error, '第2组末态与第3组原文仍有冲突。')
  assert.deepEqual(storyboardBoundaryRepairSummary(null), [])
})
