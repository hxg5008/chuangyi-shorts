import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { legacySettingsDestination } from '../app/utils/admin-settings.js'
const protocols = readFileSync(new URL('../../backend/src/services/model-channels/protocols.ts', import.meta.url), 'utf8')
const adapter = readFileSync(new URL('../../backend/src/services/adapters/volcengine-video.ts', import.meta.url), 'utf8')
const channels = readFileSync(new URL('../app/pages/admin/channels.vue', import.meta.url), 'utf8')

test('central channel routing retains direct Seedance generation after retiring the old settings editor', () => {
  assert.match(protocols, /id: 'video\.volcengine'/)
  assert.match(protocols, /provider: 'volcengine'/)
  assert.match(adapter, /doubao-seedance-2-0/)
  assert.doesNotMatch(adapter, /doubao-seedance-1-5-pro-251215/)
  assert.equal(legacySettingsDestination({ tab: 'ai' }), '/admin/channels')
})

test('video channel URL and protocol are selected on the same central channel form', () => {
  assert.match(channels, /channelForm\.base_url/)
  assert.match(channels, /modelForm\.protocol_id/)
  assert.match(channels, /modelForm\.type/)
  assert.doesNotMatch(channels, /huobaoQuickConfigs|applyHuobaoQuickConfig|api\.firemux/)
})

test('retired settings contains no paid author gateway shortcut', () => {
  const page = readFileSync(new URL('../app/pages/settings.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(page, /huobaoQuickConfigs|applyHuobaoQuickConfig|api\.firemux/)
})
