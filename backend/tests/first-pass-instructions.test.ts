import test from 'node:test'
import assert from 'node:assert/strict'
import { generationTimeBudget } from '../src/services/first-pass-instructions.ts'

test('first-pass budgets distinguish duration from three-second formatting and reserve acting time', () => {
  const eight = generationTimeBudget(8), nine = generationTimeBudget(9), fifteen = generationTimeBudget(15)
  assert.deepEqual(eight.rows.map(row => [row.start, row.end]), [[0, 3], [3, 6], [6, 8]])
  assert.equal(eight.dialogue_character_budget, 27)
  assert.equal(nine.dialogue_character_budget, 31)
  assert.equal(fifteen.dialogue_character_budget, 58)
  assert.equal(fifteen.rows.length, 5)
  assert.equal(eight.rows[2].chinese_spoken_character_capacity, 9)
  assert.equal(eight.rows.reduce((sum, row) => sum + row.seconds, 0), 8)
})

test('invalid and missing durations do not receive a guessed default budget', () => {
  for (const duration of [NaN, Infinity, 0, 7, 16]) {
    const budget = generationTimeBudget(duration)
    assert.equal(budget.valid, false); assert.deepEqual(budget.rows, [])
  }
})
