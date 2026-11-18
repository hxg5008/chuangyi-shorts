// Round 5 (2026-11-09, user-approved): hand-off helpers and the rebrand (火宝/Huobao → 创一剧坊/Chuangyi on the visible UI).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { jimengAttemptState, jimengHandedOff, jimengHandoffTitle, jimengReturnNote, jimengManualVideoReady } from '../app/utils/jimeng-local-video.js'
import { activityStatusLabel, activityStageLabel, activityTaskActive } from '../app/utils/activity-tasks.js'

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app')
const read = file => readFileSync(path.join(app, file), 'utf8')

test('handed-off Jimeng tasks are a state of their own: not running, not failed, not a finished video', () => {
  const task = { provider: 'jimeng_local', status: 'completed', stage: 'handed_off', params: JSON.stringify({ jimengHandoff: { title: '2-07' }, jimengReturn: { result: 'not_ready', checkedAt: '2026-11-09T01:00:00Z' } }) }
  assert.equal(jimengHandedOff(task), true)
  assert.equal(jimengAttemptState(task), 'handed_off')
  assert.equal(jimengManualVideoReady(task), false)
  assert.equal(jimengHandoffTitle(task), '2-07')
  assert.match(jimengReturnNote(task), /还没出片/)
  assert.equal(jimengHandedOff({ ...task, provider: '888api' }), false)
  assert.equal(jimengHandedOff({ ...task, status: 'processing' }), false)
  assert.equal(activityTaskActive(task), false, 'the AI 实况 count does not include it')
  assert.equal(activityStatusLabel(task), '已交即梦 · 待回传')
  assert.match(activityStageLabel('handed_off'), /已交即梦/)
  assert.match(activityStageLabel('submission_checking'), /不会重复提交/)
  const failed = { ...task, params: JSON.stringify({ jimengReturn: { lastError: '即梦服务保存原视频超时' } }) }
  assert.match(jimengReturnNote(failed), /上次回传未完成：即梦服务保存原视频超时/)
})

test('the visible brand is 创一剧坊 / Chuangyi Shorts everywhere in the UI', () => {
  const layout = read('layouts/default.vue')
  assert.match(layout, /<span class="brand-name">创一剧坊<\/span>/)
  assert.match(layout, /<span class="brand-sub">Chuangyi Shorts<\/span>/)
  assert.doesNotMatch(layout, /github\.com\/chatfire-AI|<Github /, 'the original author\'s GitHub link is removed')
  const nuxt = readFileSync(path.join(app, '..', 'nuxt.config.ts'), 'utf8')
  assert.match(nuxt, /title: '创一剧坊'/)
  assert.match(nuxt, /favicon\.svg/)
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const messages = JSON.parse(read(`locales/${lang}.json`))
    assert.match(messages.app.title, lang === 'zh' ? /^创一剧坊$/ : /Chuangyi/)
    assert.equal(messages.settings.ai.quickTitle, undefined, `${lang}: the removed quick-config texts are gone`)
    assert.equal(messages.tour.settings.quick, undefined)
  }
  const svg = read('public/favicon.svg')
  assert.match(svg, /创一剧坊 Chuangyi/)
  assert.match(svg, /#FF943D/)
})

test('no 火宝 / Huobao brand words are left in visible UI text (internal storage keys and CSS class names are kept on purpose)', () => {
  const offenders = []
  const visit = dir => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name)
      if (statSync(file).isDirectory()) { visit(file); continue }
      if (!/\.(vue|ts|js|json|html)$/u.test(name)) continue
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/火宝|Huobao Shorts|Huobao Drama|Huobao API|Huobao Quick|화바오|휘바오/gu)) offenders.push(`${path.relative(app, file)}: ${match[0]}`)
    }
  }
  visit(app)
  assert.deepEqual(offenders, [])
})

test('settings no longer offer the original author\'s quick config or in-app update', () => {
  const settings = read('pages/settings.vue')
  assert.doesNotMatch(settings, /quick-card|huobaoQuickConfigs|applyHuobaoQuickConfig|firemux/)
  assert.doesNotMatch(settings, /tab === 'about'|serverUpdateAPI|checkUpdate/)
  assert.doesNotMatch(settings, /id: 'about'/)
})
