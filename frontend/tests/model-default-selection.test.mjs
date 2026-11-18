import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfiguredSelection, compareConfiguredDefaults } from '../app/utils/model-parameters.js'

const configs = [
  { id: 11, model: ['high'], priority: 900, is_active: true, is_default: false },
  { id: 12, model: ['default'], priority: 1, is_active: true, is_default: true },
  { id: 13, model: ['disabled'], priority: 9999, is_active: false, is_default: true },
]

test('unspecified model follows enabled explicit default ahead of original priority', () => {
  assert.equal(resolveConfiguredSelection(configs).configId, 12)
  assert.deepEqual([...configs].filter(row => row.is_active).sort(compareConfiguredDefaults).map(row => row.id), [12, 11])
})
test('saved user selection and episode lock remain higher priority than a global default', () => {
  assert.equal(resolveConfiguredSelection(configs, '11/high', 12).configId, 11)
  assert.equal(resolveConfiguredSelection(configs, '', 11).configId, 11)
})
test('inaccessible or disabled selection falls back to provided authorized default list only', () => {
  assert.equal(resolveConfiguredSelection(configs, '13/disabled').configId, 12)
  assert.equal(resolveConfiguredSelection(configs.filter(row => row.id !== 12)).configId, 11)
})
test('no default keeps priority behavior with stable ID ties and never mutates source order', () => {
  const rows = [{ id: 3, model: ['b'], is_active: true, priority: 2 }, { id: 2, model: ['a'], is_active: true, priority: 2 }]
  assert.equal(resolveConfiguredSelection(rows).configId, 2)
  assert.deepEqual(rows.map(row => row.id), [3, 2])
})
