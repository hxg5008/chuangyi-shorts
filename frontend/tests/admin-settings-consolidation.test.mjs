import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import ts from 'typescript'
import * as vue from 'vue'
import { legacySettingsDestination } from '../app/utils/admin-settings.js'

const read = name => readFileSync(new URL('../app/' + name, import.meta.url), 'utf8')
const compile = name => {
  const { descriptor, errors } = parse(read(name), { filename: name })
  assert.deepEqual(errors, [])
  const template = compileTemplate({ source: descriptor.template.content, filename: name, id: name })
  assert.deepEqual(template.errors, [])
  const script = compileScript(descriptor, { id: name })
  return ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
}
const settingsScript = compile('components/AdminSystemSettings.vue')
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await vue.nextTick() }

function settings(section, options = {}) {
  const calls = [], notices = [], mount = [], unmount = [], intervals = new Map(), exports = {}, props = vue.reactive({ section })
  let timer = 0
  const services = {
    settingsAPI: { contentLanguage: async () => { calls.push(['language-read']); return { language: options.language || 'zh' } }, setContentLanguage: async language => { calls.push(['language-write', language]) } },
    promptAPI: { list: async () => { calls.push(['agents']); return [] }, get: async (type, language) => { calls.push(['prompt', type, language]); return { system_prompt: '原始规则\n保持原文', is_default: false } }, update: async (...args) => { calls.push(['prompt-write', ...args]) } },
    skillsAPI: { list: async language => { calls.push(['skills', language]); return [] } },
    stylePresetAPI: { list: async all => { calls.push(['styles', all]); return [] } },
    storageAPI: { info: async () => { calls.push(['storage']); return { mode: 'server', usage: { total: 1 }, usageStale: false } } },
  }
  runInNewContext(settingsScript, {
    ...vue, exports, console, URLSearchParams,
    onMounted: fn => mount.push(fn), onBeforeUnmount: fn => unmount.push(fn),
    setTimeout: () => 0, clearTimeout() {},
    setInterval: fn => { intervals.set(++timer, fn); return timer }, clearInterval: id => intervals.delete(id),
    require(name) {
      if (name === 'lucide-vue-next' || name.startsWith('~/components/')) return {}
      if (name === 'vue-sonner') return { toast: Object.fromEntries(['success', 'warning', 'error'].map(kind => [kind, text => notices.push([kind, text])])) }
      if (name === 'vue-i18n') return { useI18n: () => ({ t: key => key, locale: vue.ref('zh') }) }
      if (name === '~/composables/useApi') return services
      if (name === '~/composables/useToast') return { toastError: error => notices.push(['error', error?.message]) }
      if (name === '~/composables/useDesktopBridge') return { useDesktopBridge: () => null }
      if (name === '~/composables/useMigrateState') return { useMigrateState: () => ({ begin() {}, update() {}, end() {} }) }
      throw Error('Unexpected settings dependency: ' + name)
    },
  })
  const scope = vue.effectScope(), vm = scope.run(() => exports.default.setup(props, { expose() {} }))
  return { vm, services, calls, notices, intervals, props, async mount() { for (const fn of mount) await fn() }, dispose() { for (const fn of unmount) fn(); scope.stop() } }
}

test('legacy settings bookmarks map only to fixed administrator pages', () => {
  for (const [tab, target] of Object.entries({ ai: 'channels', general: 'preferences', styles: 'styles', agents: 'workflow', storage: 'storage' })) {
    assert.equal(legacySettingsDestination({ tab }), '/admin/' + target)
    assert.equal(legacySettingsDestination({}, '#tab=' + tab), '/admin/' + target)
    assert.equal(legacySettingsDestination({ section: tab }), '/admin/' + target)
  }
  assert.equal(legacySettingsDestination({ tab: 'https://invalid.example', next: 'https://invalid.example' }), '/admin/channels')
  assert.equal(legacySettingsDestination({ tab: ['styles', 'agents'] }), '/admin/channels')
})

test('legacy settings route only redirects and cannot load or modify old model configuration', () => {
  const page = read('pages/settings.vue')
  assert.match(page, /legacySettingsDestination\(route\.query, route\.hash\)/)
  assert.doesNotMatch(page, /aiConfigAPI|cfgForm|model|onMounted|\.create\(|\.update\(/)
  assert.doesNotMatch(read('layouts/default.vue'), /to="\/settings"/)
})

test('admin sidebar separates creation settings and real request logs from personal task center', () => {
  const shell = read('components/PlatformAdminShell.vue')
  for (const path of ['/admin/styles', '/admin/workflow', '/admin/preferences', '/admin/storage', '/admin/requests']) assert.ok(shell.includes(path))
  assert.doesNotMatch(shell, /to: '\/tasks'|to: '\/settings'|原有系统设置/)
  assert.match(read('layouts/default.vue'), /to="\/tasks"/)
})

test('each new administrator page mounts exactly its own shared settings section', () => {
  for (const [page, section] of Object.entries({ styles: 'styles', workflow: 'agents', preferences: 'general', storage: 'storage' })) {
    const text = read('pages/admin/' + page + '.vue')
    const { descriptor, errors } = parse(text)
    assert.deepEqual(errors, [])
    assert.match(descriptor.template.content, new RegExp('<AdminSystemSettings section="' + section + '"'))
  }
})

test('style page loads only the style directory and never touches model or prompt settings', async t => {
  const h = settings('styles'); t.after(h.dispose); await h.mount()
  assert.deepEqual(h.calls, [['styles', true]])
  assert.deepEqual(h.notices, [])
})

test('explicit style create and edit preserve existing payload rules and never rewrite the style key', async t => {
  const h = settings('styles'); t.after(h.dispose); await h.mount()
  const writes = []
  h.services.stylePresetAPI.create = async body => writes.push(['create', JSON.parse(JSON.stringify(body))])
  h.services.stylePresetAPI.update = async (id, body) => writes.push(['update', id, JSON.parse(JSON.stringify(body))])
  h.vm.startAddStyle()
  Object.assign(h.vm.styleForm, { name: '测试风格', value: 'style-test', prompt: '原始风格正文', template: '保留原样：{content}', description: '说明' })
  await h.vm.saveStyle()
  assert.equal(writes[0][1].prompt, '原始风格正文'); assert.equal(writes[0][1].template, '保留原样：{content}')
  h.vm.startEditStyle({ id: 7, name: '旧风格', value: 'fixed-key', prompt: '旧正文', template: '{content}', sort_order: 1 })
  h.vm.styleForm.value = 'attempt-to-change-key'
  h.vm.styleForm.prompt = '管理员明确更新'
  await h.vm.saveStyle()
  assert.equal(writes[1][0], 'update'); assert.equal(writes[1][1], 7)
  assert.equal(writes[1][2].prompt, '管理员明确更新'); assert.equal('value' in writes[1][2], false)
})

test('global preferences preserve the saved AI language without fetching all other settings', async t => {
  const h = settings('general', { language: 'ja' }); t.after(h.dispose); await h.mount()
  assert.equal(h.vm.contentLanguage.value, 'ja')
  assert.deepEqual(h.calls, [['language-read']])
  await h.vm.setContentLanguage('ja'); assert.equal(h.calls.length, 1)
  await h.vm.setContentLanguage('bad'); assert.equal(h.calls.length, 1)
})

test('explicit AI language save is serialized and failure preserves the saved value', async t => {
  const h = settings('general'); t.after(h.dispose); await h.mount()
  const wait = deferred()
  h.services.settingsAPI.setContentLanguage = language => { h.calls.push(['language-write', language]); return wait.promise }
  const saving = h.vm.setContentLanguage('en')
  await h.vm.setContentLanguage('ko')
  assert.equal(h.vm.languageSaving.value, true)
  assert.deepEqual(h.calls.filter(x => x[0] === 'language-write'), [['language-write', 'en']])
  wait.resolve(); await saving; assert.equal(h.vm.contentLanguage.value, 'en')
  h.services.settingsAPI.setContentLanguage = async () => { throw Error('save failed') }
  await h.vm.setContentLanguage('ja')
  assert.equal(h.vm.contentLanguage.value, 'en'); assert.equal(h.vm.languageSaving.value, false)
})

test('workflow waits for saved AI language before loading that language of prompts and Skills', async t => {
  const h = settings('agents', { language: 'en' }); t.after(h.dispose); await h.mount()
  assert.deepEqual(h.calls, [['language-read'], ['agents'], ['skills', 'en'], ['prompt', 'script_rewriter', 'en']])
  assert.equal(h.vm.agentForm.system_prompt, '原始规则\n保持原文')
  assert.deepEqual(h.notices, [])
})

test('workflow retains original prompt update payload and explicit language', async t => {
  const h = settings('agents', { language: 'ko' }); t.after(h.dispose); await h.mount()
  h.vm.agentForm.system_prompt = '  用户明确修改的原文\n不替换规则。  '
  await h.vm.saveAgentCfg('script_rewriter')
  const write = h.calls.find(x => x[0] === 'prompt-write')
  assert.equal(write[1], 'script_rewriter'); assert.equal(write[2].system_prompt, '  用户明确修改的原文\n不替换规则。  '); assert.equal(write[3], 'ko')
})

test('late prompt response cannot overwrite a newly selected Agent', async t => {
  const h = settings('agents'); t.after(h.dispose); await h.mount()
  const wait = deferred(); h.services.promptAPI.get = type => type === 'script_rewriter' ? wait.promise : Promise.resolve({ system_prompt: 'new agent' })
  const old = h.vm.loadAgentPrompt('script_rewriter')
  await h.vm.selectAgent('extractor'); wait.resolve({ system_prompt: 'late old agent' }); await old
  assert.equal(h.vm.agentForm.system_prompt, 'new agent')
})

test('storage page only loads storage and does not offer server-side desktop migration', async t => {
  const h = settings('storage'); t.after(h.dispose); await h.mount()
  assert.deepEqual(h.calls, [['storage']]); assert.equal(h.vm.isDesktopMode.value, false)
  await h.vm.pickTarget(); assert.equal(h.vm.migrateDialog.value, false)
})

test('unmount before a stale storage response cannot start an orphan polling interval', async () => {
  const h = settings('storage'), wait = deferred()
  h.services.storageAPI.info = () => wait.promise
  const pending = h.mount(); h.dispose(); wait.resolve({ mode: 'server', usageStale: true })
  await pending; assert.equal(h.intervals.size, 0)
})

test('storage refresh callbacks never overlap and stop when usage is fresh', async t => {
  const h = settings('storage'); t.after(h.dispose)
  h.services.storageAPI.info = async () => ({ mode: 'server', usageStale: true })
  await h.mount(); assert.equal(h.intervals.size, 1)
  let reads = 0; const wait = deferred()
  h.services.storageAPI.info = () => { reads++; return wait.promise }
  const callback = [...h.intervals.values()][0], first = callback(); await callback(); assert.equal(reads, 1)
  wait.resolve({ mode: 'server', usage: { total: 1 }, usageStale: false }); await first
  assert.equal(h.intervals.size, 0)
})

test('personal locale switching only changes UI preferences for every role', () => {
  const code = compile('components/LocaleSwitcher.vue'), exports = {}, changes = []
  runInNewContext(code, { ...vue, exports, require(name) {
    if (name === 'vue') return vue
    if (name === 'lucide-vue-next') return {}
    if (name === 'vue-i18n') return { useI18n: () => ({ t: key => key, locale: vue.ref('zh') }) }
    if (name === '~/composables/i18n') return { UI_LOCALES: [{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }], setUiLocale: value => changes.push(value) }
    throw Error('UI language unexpectedly depends on global service: ' + name)
  } })
  const vm = exports.default.setup({}, { expose() {} }); vm.open.value = true; vm.select('en')
  assert.deepEqual(changes, ['en']); assert.equal(vm.open.value, false)
  assert.doesNotMatch(read('composables/useUnifiedLanguage.ts'), /settingsAPI|setContentLanguage|location\.reload|LanguageSwitchDialog/)
})

test('all global settings pages remain behind the existing administrator route guard', async () => {
  const source = ts.transpileModule(read('middleware/platform-auth.global.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}, redirects = []
  runInNewContext(source, { exports, defineNuxtRouteMiddleware: fn => fn, navigateTo: route => redirects.push(route), require: () => ({ loadPlatformSession: async () => ({ role: 'user' }), safeNextPath: () => '/' }) })
  for (const route of ['/settings', '/admin/styles', '/admin/workflow', '/admin/preferences', '/admin/storage']) await exports.default({ path: route, query: {}, fullPath: route })
  assert.deepEqual(redirects, ['/', '/', '/', '/', '/'])
})
