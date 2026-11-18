import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('project creation dialog only asks for title and visual style', () => {
  const page = read('app/pages/index.vue')

  assert.match(page, /新建项目/)
  assert.match(page, /视觉风格/)
  assert.doesNotMatch(page, /total_episodes/)
  assert.doesNotMatch(page, /计划集数/)
  // 硬编码风格列表已移除，预设来自 API
  assert.doesNotMatch(page, /\['realistic', 'anime'/)
  assert.match(page, /stylePresetAPI/)
  assert.match(page, /stylePresetAPI\.list\(\)/)
  assert.match(page, /styleLabel\(d\.style\)/)
  assert.match(page, /stylePresets\.length \}\} 种视觉风格/)
})

test('useApi exposes style preset endpoints', () => {
  const useApi = read('app/composables/useApi.ts')

  assert.match(useApi, /stylePresetAPI/)
  assert.match(useApi, /\/style-presets/)
  assert.match(useApi, /\?all=1/)
})

test('administrator style page reuses retained style handlers and immutable existing style keys', () => {
  const panel = read('app/components/AdminSystemSettings.vue')
  const page = read('app/pages/admin/styles.vue')
  assert.match(page, /AdminSystemSettings section="styles"/)
  for (const handler of ['stylePresetAPI','startAddStyle','startEditStyle','toggleStyle','confirmDelStyle','loadStylePresets']) assert.ok(panel.includes(handler))
  assert.match(panel, /:disabled="!!styleEditId"/)
  assert.match(panel, /<ConfirmDialog/)
  assert.doesNotMatch(panel, /aiConfigAPI|cfgForm/)
})
