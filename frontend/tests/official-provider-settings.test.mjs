import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { legacySettingsDestination } from '../app/utils/admin-settings.js'
const read = name => readFileSync(new URL('../app/' + name, import.meta.url), 'utf8')
const legacy = read('pages/settings.vue'), channels = read('pages/admin/channels.vue'), panel = read('components/AdminSystemSettings.vue')

test('retired AI settings forwards to the central channel editor without creating new configs', () => {
  assert.equal(legacySettingsDestination({ tab: 'ai' }), '/admin/channels')
  assert.doesNotMatch(legacy, /aiConfigAPI|cfgForm|providerPresets/)
  assert.doesNotMatch(panel, /aiConfigAPI|cfgForm|providerPresets/)
})

test('central model management accepts model IDs from the selected channel catalog instead of legacy defaults', () => {
  assert.match(channels, /channelAPI\.catalog/)
  assert.match(channels, /model:modelForm\.model/)
  assert.match(channels, /protocol_id:modelForm\.protocol_id/)
  assert.match(channels, /useCatalogModel/)
})

test('model testing remains in the administrator playground for all three capabilities', () => {
  const page = read('pages/admin/playground.vue')
  for (const kind of ['text', 'image', 'video']) assert.ok(page.includes(kind))
  assert.match(page, /modelTestAPI/)
  assert.match(page, /selectedConfig/)
})

test('legacy configuration read and binding APIs remain available for existing project IDs', () => {
  const api = read('composables/useApi.ts')
  assert.match(api, /export const aiConfigAPI/)
  assert.match(api, /\/ai-configs/)
  assert.match(api, /export const channelAPI/)
  assert.match(api, /\/admin\/channels/)
})

test('retired settings does not restore author gateway quick configuration', () => {
  for (const source of [legacy, panel, channels]) assert.doesNotMatch(source, /huobaoQuickConfigs|applyHuobaoQuickConfig|api\.firemux\.com/)
})
