import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { createI18n } from 'vue-i18n'

const app = new URL('../app/', import.meta.url)
const source = readFileSync(new URL('composables/i18n.ts', app), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText

function load(previous = 'en', storageUnavailable = false) {
  const values = new Map([['huobao:locale', previous]]), exports = {}, calls = []
  const context = { exports, console, localStorage: {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => { if (storageUnavailable) throw Error('storage blocked'); values.set(key, value); calls.push([key, value]) },
  }, require(name) {
    if (name === 'vue-i18n') return { createI18n }
    if (/^\.\.\/locales\/(zh|en|ja|ko)\.json$/.test(name)) return JSON.parse(readFileSync(new URL('composables/' + name, app), 'utf8'))
    throw Error('UI language must not import a backend/global setting: ' + name)
  } }
  runInNewContext(compiled, context)
  return { values, api: exports, calls }
}

test('old English, Japanese and Korean browser preferences start in Chinese and are replaced', () => {
  for (const old of ['en', 'ja', 'ko']) {
    const h = load(old)
    assert.equal(h.api.i18n.global.locale.value, 'zh')
    assert.equal(h.values.get('huobao:locale'), 'zh')
    assert.equal(h.api.i18n.global.t('layout.nav.projects'), '项目')
  }
})

test('compatibility setters cannot restore an old non-Chinese UI preference', () => {
  const h = load('en')
  h.api.setUiLocale('ja')
  assert.equal(h.api.i18n.global.locale.value, 'zh')
  assert.equal(h.values.get('huobao:locale'), 'zh')
  h.api.persistLocale('ko')
  assert.equal(h.values.get('huobao:locale'), 'zh')
})

test('blocked localStorage does not prevent the Chinese interface from loading', () => {
  const h = load('en', true)
  assert.equal(h.api.readStoredLocale(), 'zh')
  assert.equal(h.api.i18n.global.locale.value, 'zh')
  assert.doesNotThrow(() => h.api.setUiLocale('en'))
  assert.equal(h.api.i18n.global.locale.value, 'zh')
})

test('both application headers remove the language control and its explicit import', () => {
  for (const name of ['layouts/default.vue', 'views/drama/episode.vue']) {
    const text = readFileSync(new URL(name, app), 'utf8')
    assert.doesNotMatch(text, /<LocaleSwitcher\b|import\s+LocaleSwitcher\b/)
  }
})

test('fixed UI language does not import or call the global AI content language service', () => {
  assert.doesNotMatch(source, /settingsAPI|setContentLanguage|fetch\(|\.post\(|\.put\(/)
  const panel = readFileSync(new URL('components/AdminSystemSettings.vue', app), 'utf8')
  assert.match(panel, /await settingsAPI\.setContentLanguage\(lang\)/)
  assert.match(panel, /const editLang = computed\(\(\) => contentLanguage\.value\)/)
})

test('translation resources remain packaged for compatibility without enabling UI switching', () => {
  const h = load('ko')
  assert.deepEqual([...h.api.UI_LOCALES].map(item => item.value), ['zh', 'en', 'ja', 'ko'])
  for (const name of ['zh', 'en', 'ja', 'ko']) assert.ok(JSON.parse(readFileSync(new URL('locales/' + name + '.json', app), 'utf8')))
  assert.equal(h.api.i18n.global.locale.value, 'zh')
})
