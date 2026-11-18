import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { renderToString } from '@vue/server-renderer'
import ts from 'typescript'
import * as vue from 'vue'
import * as imageState from '../app/utils/image-task-state.js'
import { createPollingScope } from '../app/utils/polling-scope.js'
import * as taskPresentation from '../app/utils/task-presentation.js'
import * as api888 from '../app/utils/api888-video.js'
import * as jimengLocal from '../app/utils/jimeng-local-video.js'
import * as jimengSelectedMentions from '../app/utils/jimeng-selected-mentions.js'
import * as quotedText from '../app/utils/quoted-text.js'
import * as modelParameters from '../app/utils/model-parameters.js'
import * as assetImageJobs from '../app/utils/asset-image-jobs.js'
import * as executionBinding from '../app/utils/execution-binding.js'
import * as episodeTitles from '../app/utils/episode-title.js'
import * as storyboardBudget from '../app/utils/storyboard-budget.js'

// Execute the actual workbench setup with Vue reactivity. All transport and timers are local fakes.
const filename = new URL('../app/views/drama/episode.vue', import.meta.url)
const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename: filename.pathname })
const setupScript = compileScript(descriptor, { id: 'episode-task-sync' })
const compiled = ts.transpileModule(setupScript.content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const agentCompiled = ts.transpileModule(readFileSync(new URL('../app/composables/useAgent.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const templateExports = {}
const template = compileTemplate({ source: descriptor.template.content, filename: filename.pathname, id: 'episode-task-sync', compilerOptions: { bindingMetadata: setupScript.bindings } })
assert.equal(template.errors.length, 0)
runInNewContext(ts.transpileModule(template.code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports: templateExports, require: name => { assert.equal(name, 'vue'); return vue },
})
const clone = value => structuredClone(value)
const settle = () => new Promise(resolve => setImmediate(resolve))

function fakeClock() {
  let now = 0
  let nextId = 0
  const pending = new Map()
  return {
    pending,
    setTimer(callback, delay) { const id = ++nextId; pending.set(id, { callback, at: now + delay }); return id },
    clearTimer(id) { pending.delete(id) },
    async advance(ms) {
      const target = now + ms
      while (true) {
        const next = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > target) break
        now = next[1].at
        pending.delete(next[0])
        next[1].callback()
        await settle()
      }
      now = target
      await settle()
    },
  }
}

function workbench(options = {}) {
  const clock = fakeClock()
  const windowEvents = new Map(), documentEvents = new Map()
  const browserDocument = { visibilityState: 'visible',
    addEventListener: (type, callback) => documentEvents.set(type, callback),
    removeEventListener: (type, callback) => { if (documentEvents.get(type) === callback) documentEvents.delete(type) },
  }
  const unmount = []
  const notices = []
  const translations = []
  const calls = []
  const navigation = [], confirmations = []
  let pageMetadata
  const state = {
    characters: [{ id: 7, name: '高大山', image_url: 'static/images/old.png', final_prompt: 'ready' }],
    scenes: [{ id: 10, location: '山间', final_prompt: 'ready' }, { id: 11, location: '河岸', final_prompt: 'ready' }],
    props: [],
    tasks: [{ id: 1, type: 'image', character_id: 7, status: 'completed', local_path: 'static/images/old.png' }],
    preparationJobs: [],
    extractStatus: { characters: null, scenes: null, props: null },
    videoPromptsStatus: null,
    jobs: [],
    storyboardDraft: null,
    storyboards: [],
    jobRequests: [],
    errorMappings: [],
    mappedErrors: {},
    failedSubmissions: new Set(),
    confirmLeave: options.confirmLeave ?? true,
  }
  let taskId = 100
  const generate = kind => async id => {
    calls.push(`generate:${kind}:${id}`)
    if (state.failedSubmissions.has(`${kind}:${id}`)) throw new Error('submission failed')
    const idForTask = ++taskId
    state.tasks.push({ id: idForTask, type: 'image', [`${kind}_id`]: id, status: 'processing' })
    return { image_generation_id: idForTask }
  }
  const endpoint = (name, read) => async () => { calls.push(name); return clone(read()) }
  const apis = {
    api: {
      post: async (path, body) => {
        if (!path.endsWith('/jobs')) return {}
        state.jobRequests.push({ path, body: clone(body) })
        const job = { id: 401 + state.jobs.length, scope: 'agent', agent_type: path.split('/')[2], episode_id: body.episode_id, storyboard_ids: body.storyboard_ids || [], status: 'running', phase: 'generating', issues: [] }
        state.jobs.unshift(job)
        return { job_id: job.id }
      },
      get: async path => {
        calls.push(path)
        if (path.includes('/execution-options?config_id=')) return {accounts:[],current:{id:91,state:'ready',permitted:true},pending:null}
        if (path === '/episodes/2/storyboard-draft?mode=breakdown') return clone(state.storyboardDraft)
        if (path.startsWith('/agent/jobs?')) return clone(state.jobs)
        const job = state.jobs.find(job => String(job.id) === path.split('/').at(-1))
        if (!job) throw new Error('job missing')
        return clone(job)
      },
    },
    dramaAPI: { get: endpoint('drama', () => ({ id: 1, title: '测试剧', episodes: [{ id: 2, episode_number: 1, script_content: '已保存剧本' }] })) },
    episodeAPI: {
      characters: endpoint('characters', () => state.characters),
      scenes: endpoint('scenes', () => state.scenes),
      props: endpoint('props', () => state.props),
      storyboards: endpoint('storyboards', () => state.storyboards),
      extractStatus: endpoint('extract-status', () => state.extractStatus),
      videoPromptsStatus: endpoint('video-prompts-status', () => state.videoPromptsStatus),
      update: async () => ({}),
    },
    characterAPI: { generateImage: generate('character') },
    sceneAPI: { generateImage: generate('scene') },
    propAPI: { generateImage: generate('prop') },
    taskAPI: { listByEpisode: endpoint('tasks', () => ({ tasks: state.tasks, merges: [] })) },
    mergeAPI: { status: async () => null, list: async () => [] },
    aiConfigAPI: {}, storyboardAPI: {}, uploadAPI: {},
    assetImageJobAPI: {list:endpoint('preparation-jobs',()=>({items:state.preparationJobs}))},
  }
  const agentExports = {}
  const toastMock = { toast: Object.fromEntries(['success', 'info', 'warning', 'error'].map(method => [method, (...args) => notices.push([method, ...args])])) }
  runInNewContext(agentCompiled, {
    exports: agentExports,
    setTimeout: clock.setTimer, clearTimeout: clock.clearTimer,
    require(name) {
      if (name === 'vue') return vue
      if (name === 'vue-sonner') return toastMock
      if (name === './useApi') return { api: apis.api }
      if (name === './useToast') return { toastError: (...args) => notices.push(['task-error', ...args]) }
      if (name === './i18n') return { i18n: { global: { t: key => key } } }
      throw new Error(`Unexpected agent dependency: ${name}`)
    },
  })
  const route = vue.reactive({ params: { id: '1', episodeNumber: '1', ...options.params }, query: { ...options.query } })
  const mockModules = {
    'vue-sonner': { toast: Object.fromEntries(['success', 'info', 'warning', 'error'].map(method => [method, (...args) => notices.push([method, ...args])])) },
    'vue-i18n': { useI18n: () => ({ t: (key, params) => { translations.push({ key, params }); return key } }) },
    'lucide-vue-next': { Loader2: () => vue.h('svg', { 'data-task-spinner': 'true' }) },
    '~/composables/useApi': apis,
    '~/composables/useTour': { startTour() {}, autoTour() {} },
    '~/composables/useAgent': agentExports,
    '~/utils/text-model-selection': { resolveTextModelSelection: (options,key) => { const option=options.find(row=>row.key===key)||options[0];return{model:option?.model,configId:option?.configId} } },
    '~/utils/image-task-state.js': imageState,
    '~/utils/polling-scope.js': { createPollingScope: () => createPollingScope(clock) },
    '~/utils/task-presentation.js': taskPresentation,
    '~/utils/api888-video.js': api888,
    '~/utils/jimeng-local-video.js': jimengLocal,
    '~/utils/jimeng-selected-mentions.js': jimengSelectedMentions,
    '~/components/JimengLocalVideoSettings.vue': {},
    '~/components/ProjectExecutionBinding.vue': {},
    '~/utils/execution-binding.js': executionBinding,
    '~/utils/episode-title.js': episodeTitles,
    '~/utils/quoted-text.js': quotedText,
    '~/utils/storyboard-budget.js': storyboardBudget,
    '~/composables/useToast': { toastError: (...args) => notices.push(['task-error', ...args]), mapError: (value, options) => {
      state.errorMappings.push({ value, options })
      return state.mappedErrors[String(value)] || String(value)
    }, MODERATION_RE: /moderation/ },
    '~/components/LocaleSwitcher.vue': {},
    '~/components/TaskCenterLauncher.vue': {},
    '~/components/PlatformAccountMenu.vue': {},
    '~/components/AssetImageLibrary.vue': {},
    '~/components/ModelParameterFields.vue': {},
    '~/utils/model-parameters.js': modelParameters,
    '~/utils/asset-image-jobs.js': assetImageJobs,
    '~/utils/platform-session': { userStorage: { getItem: () => null, setItem() {}, removeItem() {} } },
  }
  const exports = {}
  runInNewContext(compiled, {
    exports,
    require(name) {
      assert.ok(name in mockModules, `Unexpected external dependency: ${name}`)
      return mockModules[name]
    },
    ref: vue.ref, reactive: vue.reactive, computed: vue.computed, watch: vue.watch,
    thumbOf: value => value, thumbFallback() {}, posterOf: () => '',
    definePageMeta: meta => { pageMetadata = meta }, useRoute: () => route,
    navigateTo: async value => { navigation.push(clone(value)); if (options.navigationError) throw options.navigationError },
    onMounted() {}, onBeforeUnmount: callback => unmount.push(callback),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    performance: { getEntriesByType: () => [] },
    window: {
      confirm: message => { confirmations.push(message); return state.confirmLeave },
      addEventListener: (type, callback) => windowEvents.set(type, callback),
      removeEventListener: (type, callback) => { if (windowEvents.get(type) === callback) windowEvents.delete(type) },
    },
    document: browserDocument,
    console,
  })
  const scope = vue.effectScope()
  const vm = scope.run(() => exports.default.setup({}, { expose() {} }))
  return {
    vm, state, clock, notices, translations, calls, apis, route, navigation, confirmations, pageMetadata,
    async focus() { windowEvents.get('focus')?.(); await settle() },
    async visibility(value) { browserDocument.visibilityState = value; documentEvents.get('visibilitychange')?.(); await settle() },
    async render() {
      const app = vue.createSSRApp({ setup: () => vm, render: templateExports.render })
      Object.assign(app.config.globalProperties, { thumbOf: value => value, thumbFallback() {}, posterOf: () => '' })
      app.config.warnHandler = () => {}
      return renderToString(app)
    },
    dispose() { for (const callback of unmount) callback(); scope.stop() },
  }
}

test('episode header removes only the duplicate legacy task button and keeps the unified live-task and account entries', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  await h.vm.refresh()
  const html = await h.render(), header = html.slice(html.indexOf('<header'), html.indexOf('</header>'))
  assert.match(header, /studio-topbar/)
  assert.doesNotMatch(header, /task-drawer-trigger|episode.topbar.tasks/)
  assert.match(descriptor.template.content.slice(0, descriptor.template.content.indexOf('</header>')), /<TaskCenterLauncher :drama-id="dramaId"/)
  assert.match(descriptor.template.content.slice(0, descriptor.template.content.indexOf('</header>')), /<PlatformAccountMenu/)
  assert.equal(typeof h.vm.openTaskDrawer, 'function', 'existing task functionality is retained; only the duplicate entry is removed')
})

test('episode switcher lists real episodes in numeric order and navigates across gaps without a project-page detour', async t => {
  const h = workbench({ params: { episodeNumber: '7' } })
  t.after(() => h.dispose())
  h.apis.dramaAPI.get = async () => ({ id: 1, title: '测试剧', episodes: [
    { id: 212, episode_number: 12, title: '第十二集标题' },
    { id: 207, episodeNumber: 7, title: '第七集标题', content: 'saved', script_content: 'saved script' },
    { id: 202, episode_number: '2', title: '第二集标题' },
  ] })
  await h.vm.refresh()
  assert.equal(h.vm.epId.value, 207)
  assert.deepEqual([...h.vm.episodeChoices.value].map(row => row.number), [2, 7, 12])
  assert.equal(h.vm.previousEpisodeNumber.value, 2)
  assert.equal(h.vm.nextEpisodeNumber.value, 12)
  const html = await h.render(), header = html.slice(html.indexOf('<header'), html.indexOf('</header>'))
  assert.match(header, /aria-label="选择剧集"/)
  const optionLabels = [...header.matchAll(/<option[^>]*>(.*?)<\/option>/g)].map(match => match[1])
  assert.equal(optionLabels.length, 3)
  assert.match(optionLabels[0], /第二集标题/)
  assert.match(optionLabels[1], /第七集标题/)
  assert.match(optionLabels[2], /第十二集标题/)
  h.vm.goSubStep('prod:videos')
  assert.equal(await h.vm.switchEpisode(12), true)
  assert.equal(h.navigation.length, 1)
  assert.equal(h.navigation[0].path, '/drama/1/episode/12')
  assert.equal(h.navigation[0].query.workbench, 'prod:videos')
  assert.equal(h.state.jobRequests.length, 0)
})

test('episode switch preserves every explicitly selected workbench step and whitelists route input', async t => {
  for (const key of ['script:raw', 'script:rewrite', 'prod:assets', 'prod:videos', 'export:merge']) {
    const h = workbench({ query: { workbench: key, retainedFilter: 'keep' } })
    t.after(() => h.dispose())
    h.apis.dramaAPI.get = async () => ({ id: 1, title: '测试剧', episodes: [
      { id: 2, episode_number: 1, content: 'saved raw', script_content: 'saved script' },
      { id: 7, episode_number: 7, content: 'another raw' },
    ] })
    await h.vm.refresh()
    assert.equal(h.vm.activeSubStepKey.value, key)
    await h.vm.refresh()
    assert.equal(h.vm.activeSubStepKey.value, key, 'polling must not move the selected raw/script panel')
    assert.equal(await h.vm.switchEpisode(7), true)
    assert.equal(h.navigation[0].query.workbench, key)
    assert.equal(h.navigation[0].query.retainedFilter, 'keep')
  }
  for (const workbenchQuery of ['__proto__', 'constructor', 'not-a-step', ['prod:assets']]) {
    const h = workbench({ query: { workbench: workbenchQuery } })
    t.after(() => h.dispose())
    await h.vm.refresh()
    assert.equal(h.vm.panel.value, 'script')
    assert.equal(h.vm.activeSubStepKey.value, 'script:rewrite')
  }
})

test('episode switch cancellation keeps unsaved raw text and restores the native select value', async t => {
  const h = workbench({ confirmLeave: false })
  t.after(() => h.dispose())
  await h.vm.refresh()
  h.vm.drama.value.episodes.push({ id: 7, episode_number: 7 })
  h.vm.localRaw.value = 'unsaved current episode content'
  const event = { target: { value: '7' } }
  assert.equal(await h.vm.onEpisodeSelect(event), false)
  assert.equal(event.target.value, '1')
  assert.equal(h.navigation.length, 0)
  assert.equal(h.confirmations.length, 1)
  assert.equal(h.vm.localRaw.value, 'unsaved current episode content')
  h.state.confirmLeave = true
  assert.equal(await h.vm.onEpisodeSelect({ target: { value: '7' } }), true)
  assert.equal(h.navigation[0].path, '/drama/1/episode/7')
})

test('episode switch protects asset drafts and refuses navigation while an asset save is active', async t => {
  const h = workbench({ confirmLeave: false })
  t.after(() => h.dispose())
  await h.vm.refresh()
  h.vm.drama.value.episodes.push({ id: 7, episode_number: 7 })
  h.vm.openAssetDetail('character', h.vm.chars.value[0])
  h.vm.assetDetailDraft.value.appearance = 'unsaved appearance'
  assert.equal(await h.vm.switchEpisode(7), false)
  assert.equal(h.navigation.length, 0)
  assert.equal(h.confirmations.length, 1)
  h.state.confirmLeave = true
  h.vm.savingAssetDetail.value = true
  assert.equal(await h.vm.switchEpisode(7), false)
  assert.equal(h.confirmations.length, 1, 'saving blocks navigation before a discard prompt')
  assert.equal(h.navigation.length, 0)
  assert.ok(h.notices.some(([method, message]) => method === 'info' && /保存或上传/.test(message)))
})

test('episode switch also protects selected reference images and refuses leaving during reference upload', async t => {
  const h = workbench({ confirmLeave: false })
  t.after(() => h.dispose())
  await h.vm.refresh()
  h.vm.drama.value.episodes.push({ id: 7, episode_number: 7 })
  h.vm.assetImageLibrary.value = { hasUnsavedReferences: () => true, isUploading: () => false }
  assert.equal(await h.vm.switchEpisode(7), false)
  assert.equal(h.confirmations.length, 1)
  assert.equal(h.navigation.length, 0)
  h.state.confirmLeave = true
  h.vm.assetImageLibrary.value = { hasUnsavedReferences: () => false, isUploading: () => true }
  assert.equal(await h.vm.switchEpisode(7), false)
  assert.equal(h.confirmations.length, 1)
  assert.equal(h.navigation.length, 0)
  h.vm.assetImageLibrary.value = { hasUnsavedReferences: () => false, isUploading: () => false }
  h.vm.uploadingAssetKeys.value = ['character:7']
  assert.equal(await h.vm.switchEpisode(7), false, 'the existing upload-current-image flow also blocks switching')
  assert.equal(h.navigation.length, 0)
})

test('episode switch rejects absent, current and invalid episode numbers without submitting work', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  await h.vm.refresh()
  for (const value of [null, '', 'invalid', 0, 1, 7]) assert.equal(await h.vm.switchEpisode(value), false)
  assert.equal(h.navigation.length, 0)
  assert.equal(h.confirmations.length, 0)
  assert.equal(h.state.jobRequests.length, 0)
})

test('episode route keys remount each episode and route changes dispose all old polling and late reads', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  await h.vm.refresh()
  assert.equal(h.pageMetadata.key({ params: { id: '1', episodeNumber: '1' } }), '1:1')
  assert.equal(h.pageMetadata.key({ params: { id: '1', episodeNumber: '7' } }), '1:7')
  assert.equal(h.pageMetadata.key({ params: { id: '2', episodeNumber: '1' } }), '2:1')
  h.vm.polling.start('late-old-episode', async () => true, 1000)
  let finishRead
  h.apis.dramaAPI.get = () => new Promise(resolve => { finishRead = resolve })
  const refresh = h.vm.refresh()
  await settle()
  h.route.params.episodeNumber = '7'
  assert.equal(h.vm.polling.active, false)
  assert.equal(h.clock.pending.size, 0)
  finishRead({ id: 1, title: 'late old response', episodes: [{ id: 7, episode_number: 7 }] })
  await refresh
  assert.equal(h.vm.drama.value.title, '测试剧')
  assert.equal(h.vm.epId.value, 2)
})

test('episode refresh keeps the user-selected raw panel after the initial content-based step', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  await h.vm.refresh()
  assert.equal(h.vm.scriptStep.value, 1)
  h.vm.goSubStep('script:raw')
  await h.vm.refresh()
  assert.equal(h.vm.panel.value, 'script')
  assert.equal(h.vm.scriptStep.value, 0)
})

test('episode refresh preserves unsaved raw and rewritten drafts until the user explicitly leaves', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  await h.vm.refresh()
  h.vm.localRaw.value = 'my unsaved raw draft'
  h.vm.localScript.value = 'my unsaved rewritten draft'
  h.apis.dramaAPI.get = async () => ({ id: 1, title: '测试剧', episodes: [
    { id: 2, episode_number: 1, content: 'new server raw', script_content: 'new server script' },
  ] })
  await h.vm.refresh()
  assert.equal(h.vm.localRaw.value, 'my unsaved raw draft')
  assert.equal(h.vm.localScript.value, 'my unsaved rewritten draft')
  assert.equal(h.vm.rawContent.value, 'new server raw')
  assert.equal(h.vm.scriptContent.value, 'new server script')
  assert.equal(h.vm.hasUnsavedWorkbenchChanges(), true)
})

test('episode successful saves advance the raw and script baselines before later read-only refreshes', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  let content = 'saved raw', script = 'saved script'
  h.apis.dramaAPI.get = async () => ({ id: 1, title: '测试剧', episodes: [{ id: 2, episode_number: 1, content, script_content: script }] })
  h.apis.episodeAPI.update = async (id, body) => {
    assert.equal(id, 2)
    if (body.content !== undefined) content = body.content
    if (body.script_content !== undefined) script = body.script_content
  }
  await h.vm.refresh()
  h.vm.localRaw.value = 'saved updated raw'
  h.vm.localScript.value = 'saved updated script'
  await h.vm.saveRaw()
  await h.vm.saveScr()
  await h.vm.refresh()
  assert.equal(h.vm.localRaw.value, 'saved updated raw')
  assert.equal(h.vm.localScript.value, 'saved updated script')
  assert.equal(h.vm.rawContent.value, content)
  assert.equal(h.vm.scriptContent.value, script)
  assert.equal(h.vm.hasUnsavedWorkbenchChanges(), false)
})

test('episode save revisions reject an older refresh that returns after a successful raw or script save', async t => {
  for (const field of ['content', 'script_content']) {
    const h = workbench()
    t.after(() => h.dispose())
    const original = { id: 2, episode_number: 1, content: 'original raw', script_content: 'original script' }
    h.apis.dramaAPI.get = async () => ({ id: 1, title: '测试剧', episodes: [clone(original), { id: 7, episode_number: 7 }] })
    await h.vm.refresh()
    const draft = field === 'content' ? h.vm.localRaw : h.vm.localScript
    const savedBaseline = field === 'content' ? h.vm.rawContent : h.vm.scriptContent
    let finishRead, finishSave
    h.apis.dramaAPI.get = () => new Promise(resolve => { finishRead = resolve })
    h.apis.episodeAPI.update = (id, body) => {
      assert.equal(id, 2)
      assert.equal(body[field], 'newly saved editor text')
      return new Promise(resolve => { finishSave = resolve })
    }
    const staleRead = h.vm.refresh()
    await settle()
    draft.value = 'newly saved editor text'
    const save = field === 'content' ? h.vm.saveRaw() : h.vm.saveScr()
    await settle()
    assert.equal(h.vm.pendingEditorSaves.value, 1)
    assert.equal(await h.vm.switchEpisode(7), false, 'in-flight editor writes cannot be bypassed by the episode switcher')
    assert.equal(h.navigation.length, 0)
    finishSave({})
    assert.equal(await save, true)
    finishRead({ id: 1, title: 'late read', episodes: [clone(original), { id: 7, episode_number: 7 }] })
    await staleRead
    assert.equal(savedBaseline.value, 'newly saved editor text')
    assert.equal(draft.value, 'newly saved editor text')
    assert.equal(h.vm.pendingEditorSaves.value, 0)
    assert.equal(h.vm.hasUnsavedWorkbenchChanges(), false)
  }
})

test('episode refresh during a pending save preserves drafts while failed saves keep the old baseline', async t => {
  for (const field of ['content', 'script_content']) {
    const h = workbench({ confirmLeave: false })
    t.after(() => h.dispose())
    const original = { id: 2, episode_number: 1, content: 'original raw', script_content: 'original script' }
    h.apis.dramaAPI.get = async () => ({ id: 1, title: '测试剧', episodes: [clone(original), { id: 7, episode_number: 7 }] })
    await h.vm.refresh()
    const draft = field === 'content' ? h.vm.localRaw : h.vm.localScript
    const baseline = field === 'content' ? h.vm.rawContent : h.vm.scriptContent
    let rejectSave
    h.apis.episodeAPI.update = () => new Promise((resolve, reject) => { rejectSave = reject })
    draft.value = 'unsaved text must survive the failure'
    const save = field === 'content' ? h.vm.saveRaw(true) : h.vm.saveScr()
    await settle()
    await h.vm.refresh()
    assert.equal(draft.value, 'unsaved text must survive the failure')
    assert.equal(baseline.value, original[field])
    assert.equal(await h.vm.switchEpisode(7), false)
    assert.equal(h.confirmations.length, 0, 'pending saves block before discard confirmation')
    rejectSave(new Error('synthetic save failure'))
    assert.equal(await save, false)
    assert.equal(h.vm.pendingEditorSaves.value, 0)
    assert.equal(baseline.value, original[field])
    assert.equal(draft.value, 'unsaved text must survive the failure')
    assert.equal(h.vm.hasUnsavedWorkbenchChanges(), true)
    assert.equal(h.notices.some(([method]) => method === 'success'), false)
    assert.equal(await h.vm.switchEpisode(7), false)
    assert.equal(h.confirmations.length, 1)
    assert.equal(h.navigation.length, 0)
  }
})

test('episode editor writes serialize changed drafts, coalesce duplicate saves, and retain newer typing', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  h.apis.dramaAPI.get = async () => ({ id: 1, title: '测试剧', episodes: [{ id: 2, episode_number: 1, content: 'original', script_content: '' }] })
  await h.vm.refresh()
  const requests = []
  h.apis.episodeAPI.update = (id, body) => new Promise(resolve => requests.push({ id, body: clone(body), finish: resolve }))
  h.vm.localRaw.value = 'first draft'
  const first = h.vm.saveRaw()
  assert.equal(requests.length, 1, 'the first editor POST still starts synchronously before existing downstream callers')
  h.vm.localRaw.value = 'second draft'
  const second = h.vm.saveRaw()
  assert.equal(h.vm.saveRaw(), second)
  await settle()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].body.content, 'first draft')
  assert.equal(h.vm.pendingEditorSaves.value, 2)
  requests[0].finish({})
  assert.equal(await first, true)
  await settle()
  assert.equal(requests.length, 2)
  assert.equal(h.vm.rawContent.value, 'first draft')
  assert.equal(h.vm.localRaw.value, 'second draft')
  assert.equal(requests[1].body.content, 'second draft')
  h.vm.localRaw.value = 'third draft still being typed'
  requests[1].finish({})
  assert.equal(await second, true)
  assert.equal(h.vm.pendingEditorSaves.value, 0)
  assert.equal(h.vm.rawContent.value, 'second draft')
  assert.equal(h.vm.localRaw.value, 'third draft still being typed')
  assert.equal(h.vm.hasUnsavedWorkbenchChanges(), true)
})

test('actual Jimeng submission keeps natural @ text and one ordered name per asset; duration follows the shot, aspect ratio follows the project', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  h.state.scenes[0].image_url = 'static/images/old.png'
  h.state.characters[0].voice_audio_url = 'static/audio/voice.mp3'
  h.state.props.push({ id: 20, name: '茶杯', image_url: 'static/images/cup.png' })
  // The project was created as 9:16 (新建项目).
  h.apis.dramaAPI.get = async () => ({ id: 1, title: '测试剧', aspect_ratio: '9:16', episodes: [{ id: 2, episode_number: 1, script_content: '已保存剧本' }] })
  await h.vm.refresh()
  h.vm.videoConfigs.value = [{ id: 99, provider: 'jimeng_local', model: ['jimeng-2.0-fast'], is_active: true }]
  h.vm.episode.value.video_config_id = 99
  await vue.nextTick()
  const shot = { id: 11, duration: 12, scene_id: 10, character_ids: [7], prop_ids: [20], video_prompt: '🙂 @高大山站A(X+0.8米，Y0)，拿起@茶杯。场景：@山间。' }
  h.vm.sbs.value = [shot]
  h.vm.selectedSb.value = shot
  h.apis.episodeAPI.storyboards = async () => [clone(shot)]
  assert.equal(h.vm.jimengDraft.value.duration, 12, 'the panel shows the shot duration, not a fixed 15 s')
  assert.equal(h.vm.jimengDraft.value.aspectRatio, '9:16', 'the panel shows the project ratio')
  const requests = []
  h.apis.taskAPI.generate = async body => {
    requests.push(body)
    h.state.tasks.push({ id: 501, type: 'video', provider: 'jimeng_local', status: 'processing', storyboard_id: 11 })
    return { id: 501 }
  }
  await h.vm.genVid(shot)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].prompt, shot.video_prompt)
  assert.equal(requests[0].duration, 12, 'submitted duration equals the shot duration')
  assert.equal(requests[0].aspect_ratio, '9:16', 'submitted ratio equals the project ratio')
  assert.equal(requests[0].config_id, 99)
  assert.equal(requests[0].execution_project_route_id, 91)
  assert.deepEqual([...requests[0].reference_image_names], ['山间', '高大山', '茶杯'])
  assert.deepEqual([...requests[0].reference_image_urls], ['static/images/old.png', 'static/images/old.png', 'static/images/cup.png'])
  assert.equal(requests[0].generate_audio, undefined)
  assert.equal(requests[0].resolution, undefined)
  assert.equal(shot.duration, 12)
  assert.equal(h.vm.mentionOptions.value.some(option => option.kind === 'voice'), false)
  // A different shot in the same batch uses its own duration.
  const other = { ...shot, id: 12, duration: 9 }
  await h.vm.genVid(other)
  assert.equal(requests[1].duration, 9)
  assert.equal(requests[1].aspect_ratio, '9:16')
})

test('Jimeng editor and single or batch submission project only selected image references without damaging saved intent', async t => {
  const h = workbench(); t.after(() => h.dispose())
  h.state.characters = [
    { id: 7, name: '刀疤脸', image_url: 'static/knife-face.png' },
    { id: 8, name: '花衬衫甲', image_url: 'static/shirt.png' },
    { id: 9, name: '愣头青', image_url: 'static/young.png' },
    { id: 10, name: '无图人物' },
  ]
  h.state.scenes = [{ id: 20, location: '三八专列二号车厢', image_url: 'static/train.png' }]
  h.state.props = [{ id: 30, name: '弹簧刀', image_url: 'static/knife.png' }]
  await h.vm.refresh()
  h.vm.videoConfigs.value = [{ id: 99, provider: 'jimeng_local', model: ['jimeng-2.0-fast'], is_active: true }]
  h.vm.episode.value.video_config_id = 99
  await vue.nextTick()
  const raw = '@花衬衫甲追视@愣头青亮刀动作后错开眨眼，@刀疤脸握住@弹簧刀，@无图人物站在@三八专列二号车厢。'
  const expected = '花衬衫甲追视愣头青亮刀动作后错开眨眼，@刀疤脸握住@弹簧刀，无图人物站在@三八专列二号车厢。'
  const shot = { id: 11, duration: 12, scene_id: 20, character_ids: [7, 10], prop_ids: [30], video_prompt: raw }
  h.vm.sbs.value = [shot]; h.vm.selectedSb.value = shot
  assert.equal(h.vm.videoPromptForEditor(shot), expected)
  assert.deepEqual([...h.vm.mentionOptions.value.map(option => option.value)], ['刀疤脸', '三八专列二号车厢', '弹簧刀'])
  const writes = []
  h.apis.storyboardAPI.update = async (id, body) => { writes.push({ id, body }) }
  h.vm.commitVideoPromptEdit(shot, expected)
  assert.equal(writes.length, 0, 'blur without editing never saves a stripped prompt')
  assert.equal(shot.video_prompt, raw)
  shot.character_ids = [7, 8, 9]
  assert.equal(h.vm.videoPromptForEditor(shot), raw.replace('@无图人物', '无图人物'))
  shot.character_ids = [7, 10]
  const requests = []
  h.apis.taskAPI.generate = async body => { requests.push(body); return { id: 990 + requests.length } }
  await h.vm.genVid(shot)
  assert.equal(requests[0].prompt, expected)
  assert.deepEqual([...requests[0].reference_image_names], ['三八专列二号车厢', '刀疤脸', '弹簧刀'])
  assert.equal(shot.video_prompt, raw)
  const second = { ...shot, id: 12 }
  h.vm.sbs.value = [shot, second]
  h.vm.batchVideoConfirm.value = { open: true, targets: [second] }
  await h.vm.confirmBatchVideos(); await settle()
  assert.equal(requests[1].prompt, expected)
  assert.deepEqual([...requests[1].reference_image_names], [...requests[0].reference_image_names])
  assert.equal(second.video_prompt, raw)
  h.vm.videoConfigs.value = [{ id: 99, provider: 'openai', model: ['normal-video'], is_active: true }]
  await vue.nextTick()
  assert.equal(h.vm.videoPromptForEditor(shot), raw, 'other video providers keep their existing prompt unchanged')
})

test('selected bare asset names gain matching editor and single/batch markers without saving automatic changes', async t => {
  const h = workbench(); t.after(() => h.dispose())
  h.state.characters = [
    { id: 7, name: '刀疤脸', image_url: 'static/face.png' },
    { id: 8, name: '花衬衫甲', image_url: 'static/shirt.png' },
    { id: 9, name: '愣头青', image_url: 'static/young.png' },
  ]
  h.state.scenes = [{ id: 20, location: '三八专列二号车厢', image_url: 'static/train.png' }]
  await h.vm.refresh()
  h.vm.videoConfigs.value = [{ id: 99, provider: 'jimeng_local', model: ['jimeng-2.0-fast'], is_active: true }]
  h.vm.episode.value.video_config_id = 99
  await vue.nextTick()
  const raw = '花衬衫甲追视愣头青，刀疤脸在三八专列二号车厢回头，说：“愣头青别动。”'
  const expected = '花衬衫甲追视@愣头青，@刀疤脸在@三八专列二号车厢回头，说：“愣头青别动。”'
  const shot = { id: 11, duration: 12, scene_id: 20, character_ids: [7, 9], prop_ids: [], video_prompt: raw }
  h.vm.sbs.value = [shot]; h.vm.selectedSb.value = shot
  assert.equal(h.vm.videoPromptForEditor(shot), expected)
  let writes = 0; h.apis.storyboardAPI.update = async () => { writes++ }
  h.vm.commitVideoPromptEdit(shot, expected)
  assert.equal(writes, 0); assert.equal(shot.video_prompt, raw)
  shot.character_ids = []
  assert.equal(h.vm.videoPromptForEditor(shot), '花衬衫甲追视愣头青，刀疤脸在@三八专列二号车厢回头，说：“愣头青别动。”')
  shot.character_ids = [7, 9]
  assert.equal(h.vm.videoPromptForEditor(shot), expected)
  const requests = []; h.apis.taskAPI.generate = async body => { requests.push(body); return { id: 994 + requests.length } }
  await h.vm.genVid(shot)
  assert.equal(requests[0].prompt, expected)
  assert.deepEqual([...requests[0].reference_image_names], ['三八专列二号车厢', '刀疤脸', '愣头青'])
  const second = { ...shot, id: 12 }; h.vm.sbs.value = [shot, second]
  h.vm.batchVideoConfirm.value = { open: true, targets: [second] }
  await h.vm.confirmBatchVideos(); await settle()
  assert.equal(requests[1].prompt, expected)
  assert.equal(second.video_prompt, raw)
})

test('one Jimeng batch freezes one project route for every submitted shot', async t => {
  const h = workbench();t.after(() => h.dispose());await h.vm.refresh()
  h.vm.videoConfigs.value = [{ id: 99, provider: 'jimeng_local', model: ['jimeng-2.0-fast'], is_active: true }]
  h.vm.episode.value.video_config_id = 99;await vue.nextTick()
  const shots = [11,12,13].map(id => ({id,duration:9,character_ids:[7],video_prompt:'@高大山 在室内站立。'}))
  h.vm.sbs.value=shots;h.vm.batchVideoConfirm.value={open:true,targets:shots}
  const original=h.apis.api.get;let reads=0;const bodies=[]
  h.apis.api.get=async path=>path.includes('/execution-options?')?(reads++,{current:{id:reads===1?91:92,state:'ready',permitted:true},pending:null}):original(path)
  h.apis.taskAPI.generate=async body=>{bodies.push(body);return{id:600+bodies.length}}
  await h.vm.confirmBatchVideos();await settle()
  assert.equal(reads,1);assert.equal(bodies.length,3);assert.deepEqual(bodies.map(body=>body.execution_project_route_id),[91,91,91])
  assert.deepEqual(bodies.map(body=>body.prompt),shots.map(shot=>shot.video_prompt))
})

test('Jimeng batch refuses an unbound project before any video request', async t => {
  const h=workbench();t.after(()=>h.dispose());await h.vm.refresh()
  h.vm.videoConfigs.value=[{id:99,provider:'jimeng_local',model:['jimeng-2.0-fast'],is_active:true}];h.vm.episode.value.video_config_id=99;await vue.nextTick()
  h.vm.batchVideoConfirm.value={open:true,targets:[{id:11,duration:9,character_ids:[7],video_prompt:'原文'}]}
  h.apis.api.get=async()=>({current:null,pending:null});let submitted=0;h.apis.taskAPI.generate=async()=>{submitted++;return{id:800}}
  await h.vm.confirmBatchVideos();assert.equal(submitted,0);assert.equal(h.vm.batchVideoConfirm.value.open,true);assert.equal(h.vm.batchVideoSubmitting.value,false)
})

test('explicit legacy channel keeps unscoped single and batch generation with one lookup per operation', async t => {
  const h=workbench();t.after(()=>h.dispose());await h.vm.refresh()
  h.vm.videoConfigs.value=[{id:99,provider:'jimeng_local',model:['jimeng-2.0-fast'],is_active:true}];h.vm.episode.value.video_config_id=99;await vue.nextTick()
  const shots=[11,12,13].map(id=>({id,duration:9,character_ids:[7],video_prompt:'原来的视频提示词'}));h.vm.sbs.value=shots
  let reads=0;const bodies=[],original=h.apis.api.get;h.apis.api.get=async path=>path.includes('/execution-options?')?(reads++,{managed:false,selection_available:false}):original(path)
  h.apis.taskAPI.generate=async body=>{bodies.push(body);return{id:880+bodies.length}}
  await h.vm.genVid(shots[0]);assert.equal(reads,1);assert.equal(bodies.length,1);assert.equal(bodies[0].execution_project_route_id,undefined)
  h.vm.batchVideoConfirm.value={open:true,targets:shots.slice(1)};await h.vm.confirmBatchVideos();await settle()
  assert.equal(reads,2);assert.equal(bodies.length,3);assert.ok(bodies.every(body=>body.execution_project_route_id===undefined));assert.ok(bodies.every(body=>body.prompt==='原来的视频提示词'))
})

test('binding network failures do not silently fall back to unscoped Jimeng', async t => {
  const h=workbench();t.after(()=>h.dispose());await h.vm.refresh()
  h.vm.videoConfigs.value=[{id:99,provider:'jimeng_local',model:['jimeng-2.0-fast'],is_active:true}];h.vm.episode.value.video_config_id=99;await vue.nextTick()
  h.apis.api.get=async()=>{throw Error('HTTP 503')};let sent=0;h.apis.taskAPI.generate=async()=>{sent++;return{id:900}}
  await h.vm.genVid({id:11,duration:9,character_ids:[7],video_prompt:'原文'});assert.equal(sent,0)
})

test('same upstream image/video models from separate channels remain distinct and submit the selected config ID', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  await h.vm.refresh()
  h.vm.imageConfigs.value = [
    { id: 41, provider: 'openai', model: ['same-image-model'], is_active: true, priority: 10, display_name: '图片 A', channel_name: '渠道 A' },
    { id: 42, provider: 'openai', model: ['same-image-model'], is_active: true, priority: 0, display_name: '图片 B', channel_name: '渠道 B' },
  ]
  await vue.nextTick()
  assert.equal(h.vm.imageModelOptions.value.length, 2)
  assert.deepEqual([...h.vm.imageModelOptions.value.map(row => row.key)], ['41/same-image-model', '42/same-image-model'])
  assert.equal(h.vm.imageModelOptions.value[1].displayName, '图片 B')
  h.vm.imageModel.value = '42/same-image-model'
  const imageRequests = []
  h.apis.characterAPI.generateImage = async (...args) => { imageRequests.push(args); return { image_generation_id: 901 } }
  await h.vm.genCharImg(7)
  assert.equal(imageRequests[0][2], 'same-image-model')
  assert.equal(imageRequests[0][3], 42)
  h.vm.videoConfigs.value = [
    { id: 51, provider: 'openai', model: ['same-video-model'], is_active: true },
    { id: 52, provider: 'openai', model: ['same-video-model'], is_active: true },
  ]
  h.vm.videoModel.value = '52/same-video-model'
  assert.equal(h.vm.videoModelOptions.value.length, 2)
  assert.equal(h.vm.effectiveVideoSelection.value.configId, 52)
  assert.equal(h.vm.effectiveVideoSelection.value.model, 'same-video-model')
})

test('declared model parameters and locked image defaults reach image/text/video requests while dynamic capabilities preserve shot and project values', async t=>{
  const h=workbench();t.after(()=>h.dispose());await h.vm.refresh()
  h.vm.textConfigs.value=[{id:19,provider:'openai',model:['dynamic-text'],is_active:true,parameters:[{key:'reasoning_effort',type:'select',default:'high',options:['low','high']}]}]
  h.vm.imageConfigs.value=[{id:41,provider:'openai',model:['image-a'],is_active:true,priority:10},{id:42,provider:'openai',model:['image-b'],is_active:true,priority:0,parameters:[{key:'quality',type:'select',default:'high',options:['high','low']}]}]
  h.vm.episode.value.image_config_id=42
  await vue.nextTick()
  assert.equal(h.vm.effectiveImageModel.value.configId,42)
  const imageRequests=[];h.apis.characterAPI.generateImage=async(...args)=>{imageRequests.push(args);return{image_generation_id:901}}
  await h.vm.genCharImg(7)
  assert.equal(imageRequests[0][2],'image-b');assert.equal(imageRequests[0][3],42)
  assert.equal(imageRequests[0][6].quality,'high');assert.equal(imageRequests[0][7].reasoning_effort,'high')
  const extraction=[];h.apis.episodeAPI.extract=async(...args)=>{extraction.push(args);return{}}
  h.vm.doExtract('characters');await settle()
  assert.equal(extraction[0][3],19);assert.equal(extraction[0][4].reasoning_effort,'high')
  h.vm.videoConfigs.value=[{id:52,provider:'openai',model:['dynamic-video'],is_active:true,capabilities:{resolutions:['540p','1080p'],durations:[4,8,12],max_images:2},defaults:{resolution:'540p'},parameters:[{key:'fps',type:'select',default:24,options:[24,30]}]}]
  h.vm.episode.value.video_config_id=52;h.vm.episode.value.resolution='720p';h.vm.drama.value.aspect_ratio='9:16'
  await vue.nextTick()
  assert.deepEqual([...h.vm.resolutionOptions.value.map(row=>row.key)],['540p','1080p'])
  assert.equal(h.vm.episodeResolution.value,'540p');assert.equal(h.vm.refImageLimit.value,2)
  h.vm.videoModelParameters.value.fps=30
  const shot={id:211,duration:8,video_prompt:'完整原始视频提示词'};h.vm.sbs.value=[shot];h.vm.selectedSb.value=shot
  const videos=[];h.apis.taskAPI.generate=async body=>{videos.push(body);return{id:989}}
  await h.vm.genVid(shot)
  assert.equal(videos[0].model_parameters.fps,30)
  assert.equal(videos[0].resolution,'540p');assert.equal(videos[0].duration,8);assert.equal(videos[0].aspect_ratio,'9:16')
  assert.equal(shot.video_prompt,'完整原始视频提示词')
})

test('an image request retains the clicked model and parameter snapshot while its prompt is prepared', async t=>{
  const h=workbench();t.after(()=>h.dispose());h.state.characters[0].final_prompt='';await h.vm.refresh()
  h.vm.imageConfigs.value=[{id:41,provider:'openai',model:['first-image'],is_active:true,parameters:[{key:'quality',type:'string',default:'high'}]},{id:42,provider:'openai',model:['other-image'],is_active:true,parameters:[{key:'quality',type:'string',default:'low'}]}]
  await vue.nextTick()
  let ready
  h.apis.characterAPI.generatePrompt=async()=>{throw new Error('A separate long prompt POST must not be sent')}
  const requests=[];h.apis.characterAPI.generateImage=async(...args)=>{requests.push(args);return new Promise(resolve=>{ready=()=>{h.state.preparationJobs=[{id:'prepare-click',asset_kind:'character',asset_id:7,status:'preparing_prompt',active:true}];resolve({asset_job_id:'prepare-click',status:'preparing_prompt'})}})}
  const operation=h.vm.genCharImg(7);await settle()
  h.vm.imageModel.value='42/other-image';await vue.nextTick()
  h.vm.imageModelParameters.value.quality='low'
  ready();await operation
  assert.equal(requests[0][2],'first-image');assert.equal(requests[0][3],41)
  assert.equal(requests[0][6].quality,'high')
})

test('a batch submits eight short preparation requests, then reads one shared snapshot and never retries failed preparation',async t=>{
  const h=workbench();t.after(()=>h.dispose())
  h.state.characters=Array.from({length:8},(_,index)=>({id:index+10,name:'角色'+index,final_prompt:'',image_url:''}));h.state.tasks=[]
  await h.vm.refresh()
  const submissions=[]
  h.apis.characterAPI.generatePrompt=async()=>{throw new Error('Separate synchronous prompt requests are forbidden')}
  h.apis.characterAPI.generateImage=async id=>{submissions.push(id);h.state.preparationJobs.push({id:'prep-'+id,asset_kind:'character',asset_id:id,status:'preparing_prompt',active:true,created_at:new Date().toISOString()});return{asset_job_id:'prep-'+id,status:'preparing_prompt'}}
  await h.vm.batchCharImages()
  assert.equal(submissions.length,8);assert.equal(h.vm.pendingCharImageIds.value.length,8);assert.equal(h.vm.assetPreparationCount.value,8)
  Object.assign(h.state.preparationJobs[0],{status:'failed',active:false,error:'准备超时',error_code:'preparation_timeout'})
  Object.assign(h.state.preparationJobs[1],{status:'interrupted',active:false,error_code:'preparation_interrupted'})
  Object.assign(h.state.preparationJobs[2],{status:'completed',active:true,image_generation_id:701})
  h.state.tasks.push({id:701,type:'image',character_id:12,status:'processing',stage:'queued'})
  await h.vm.refresh()
  assert.equal(h.vm.pendingCharImageIds.value.length,6)
  assert.equal(h.vm.pendingImageTasks.value['character:12'].taskId,701)
  assert.equal(h.vm.assetPreparationErrors.value.length,2)
  assert.equal(submissions.length,8,'reading failed jobs cannot re-submit prompts or images')
  const restored=workbench();t.after(()=>restored.dispose());restored.state.characters=clone(h.state.characters);restored.state.tasks=clone(h.state.tasks);restored.state.preparationJobs=clone(h.state.preparationJobs)
  await restored.vm.refresh()
  assert.equal(restored.vm.pendingCharImageIds.value.length,6,'a refresh restores both preparations and handed-off active images')
  assert.equal(restored.vm.assetPreparationErrors.value.length,2)
  assert.equal(restored.calls.some(call=>call.startsWith('generate:')),false)
  let release,reads=0
  h.apis.assetImageJobAPI.list=async()=>{reads++;return new Promise(resolve=>{release=resolve})}
  const first=h.vm.loadGenTasks(),second=h.vm.loadGenTasks();await settle();assert.equal(reads,1,'concurrent UI refreshes share the in-flight episode preparation query')
  release({items:clone(h.state.preparationJobs)});await Promise.all([first,second])
})

test('actual Jimeng workbench shows the newest failure or manual delivery even when a previous video remains playable', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  const shot = { id: 11, duration: 12, video_url: 'static/videos/old.mp4', video_prompt: '完整提示词' }
  h.state.storyboards = [shot]
  h.state.tasks.push({ id: 501, type: 'video', provider: 'jimeng_local', status: 'failed', stage: 'failed', error_code: 'generation_failed', error_msg: '参考图可能包含低俗内容，请修改后重试。', storyboard_id: 11, updated_at: '2026-11-05T01:00:00Z' })
  await h.vm.refresh()
  const activeShot = h.vm.sbs.value[0]
  h.vm.selectedSb.value = activeShot
  h.vm.panel.value = 'production'; h.vm.prodTab.value = 'videos'
  assert.equal(h.vm.videoTaskState(activeShot), 'failed')
  assert.equal(h.vm.videoFailMessage(11), '参考图可能包含低俗内容，请修改后重试。')
  assert.equal(h.vm.canRecoverVideo(11), false)
  assert.match(await h.render(), /本次任务失败：参考图可能包含低俗内容/)
  Object.assign(h.state.tasks.find(task => task.id === 501), { status: 'completed', stage: 'ready_in_local_service', error_code: null, error_msg: null, updated_at: '2026-11-05T01:01:00Z' })
  await h.vm.refresh()
  assert.equal(h.vm.videoTaskState(h.vm.sbs.value[0]), 'done')
  assert.equal(h.vm.videoTaskStatusLabel(h.vm.sbs.value[0]), '已出片 · 待取回')
  assert.match(await h.render(), /新视频已在即梦生成，还没取回/)
  assert.equal(h.vm.sbs.value[0].video_url, shot.video_url)
})

test('an idle workbench replaces an old failed draft and its banner with a newer completed breakdown from another tab using GET only', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  const old = { id: 'old-capacity', episode_id: 2, scope: 'agent', agent_type: 'storyboard_breaker', status: 'needs_revision', phase: 'needs_revision',
    started_at: '2026-11-04T09:17:00Z', finished_at: '2026-11-04T09:18:00Z', draft_id: 'old-draft', issues: [{ code: 'constraint_conflict', severity: 'error', message: 'obsolete capacity shortage' }] }
  h.state.jobs = [old]
  h.state.storyboardDraft = { id: 'old-draft', mode: 'breakdown', status: 'needs_revision', groups: [], issues: old.issues }
  h.state.storyboards = [{ id: 1, title: 'Old version', duration: 103, video_prompt: 'old prompt' }]
  await h.vm.refresh()
  await h.vm.syncAgentJobs()
  assert.match(h.vm.agentValidationMessage.value, /obsolete capacity shortage/)
  h.vm.startAgentReconciliation()
  h.vm.startAgentReconciliation()
  assert.equal(h.clock.pending.size, 1, 'one journal observer, even if setup is requested twice')
  const latest = { ...old, id: 'completed-new', status: 'done', phase: 'done', draft_id: 'completed-draft',
    started_at: '2026-11-04T09:37:00Z', finished_at: '2026-11-04T09:50:00Z', issues: [] }
  h.state.jobs = [latest, old]
  h.state.storyboards = Array.from({ length: 10 }, (_, index) => ({ id: index + 20, title: `New ${index + 1}`, duration: index < 5 ? 11 : 10, video_prompt: 'complete prompt' }))
  h.state.storyboardDraft = { id: latest.draft_id, mode: 'breakdown', status: 'committed', readyCount: 10, needsRevisionCount: 0,
    groups: h.state.storyboards.map((row, index) => ({ number: index + 1, status: 'ready', candidate: row, issues: [] })), issues: [] }
  await h.clock.advance(5000)
  assert.equal(h.vm.agentResult.value.id, 'completed-new')
  assert.equal(h.vm.agentValidationMessage.value, '')
  assert.equal(h.vm.storyboardDraft.value.id, 'completed-draft')
  assert.equal(h.vm.storyboardDraft.value.status, 'committed')
  assert.equal(h.vm.sbs.value.length, 10)
  assert.equal(h.vm.sbs.value.reduce((sum, row) => sum + row.duration, 0), 105)
  assert.equal(h.vm.rn.value, false)
  assert.equal(h.state.jobRequests.length, 0)
  assert.deepEqual(h.notices, [])
  const requestCount = h.calls.length
  h.dispose()
  await h.focus()
  await h.visibility('visible')
  await h.clock.advance(10000)
  assert.equal(h.calls.length, requestCount)
  assert.equal(h.clock.pending.size, 0)
})

test('focus reconciliation preserves a genuinely pending breakdown when a later prompt-only task succeeds, then clears it only for the completed breakdown', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  const failed = { id: 'failed-breakdown', episode_id: 2, scope: 'agent', agent_type: 'storyboard_breaker', status: 'needs_revision', phase: 'needs_revision',
    started_at: '2026-11-04T10:00:00Z', draft_id: 'pending-breakdown', issues: [{ code: 'constraint_conflict', severity: 'error', message: 'real unresolved capacity problem' }] }
  h.state.jobs = [failed]
  h.state.storyboardDraft = { id: failed.draft_id, mode: 'breakdown', status: 'needs_revision', groups: [], issues: failed.issues }
  await h.vm.refresh()
  await h.vm.syncAgentJobs()
  h.vm.startAgentReconciliation()
  const promptDone = { ...failed, id: 'prompt-only-done', agent_type: 'prompt_generator', status: 'done', phase: 'done',
    started_at: '2026-11-04T10:10:00Z', draft_id: 'prompt-draft', issues: [] }
  h.state.jobs = [promptDone, failed]
  await h.focus()
  assert.equal(h.vm.agentResult.value.id, 'prompt-only-done')
  assert.match(h.vm.agentValidationMessage.value, /real unresolved capacity problem/)
  assert.equal(h.vm.storyboardDraft.value.id, 'pending-breakdown')
  const count = h.calls.length
  await h.visibility('hidden')
  assert.equal(h.calls.length, count)
  const breakdownDone = { ...failed, id: 'breakdown-now-done', status: 'done', phase: 'done', started_at: '2026-11-04T10:20:00Z', issues: [] }
  h.state.jobs = [breakdownDone, promptDone, failed]
  h.state.storyboardDraft = { id: breakdownDone.draft_id, mode: 'breakdown', status: 'committed', groups: [], issues: [] }
  await h.visibility('visible')
  assert.equal(h.vm.agentValidationMessage.value, '')
  assert.equal(h.state.jobRequests.length, 0)
  assert.deepEqual(h.notices, [])
  h.route.params.episodeNumber = '2'
  const before = h.calls.length
  await h.focus()
  await h.clock.advance(10000)
  assert.equal(h.calls.length, before, 'old route observers cannot refresh the new page')
})

test('workbench follows the returned image task ID despite an old image, then refreshes the last completed asset and its details', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  await h.vm.refresh()
  h.vm.openAssetDetail('character', h.vm.chars.value[0])
  await h.vm.genCharImg(7)
  assert.equal(h.vm.isPendingCharImage(7), true)
  assert.equal(h.vm.pendingImageTasks.value['character:7'].taskId, 101)
  assert.equal(h.vm.assetDetail.value.item.image_url, 'static/images/old.png')
  assert.equal(h.vm.taskDrawer.value, false)
  assert.equal(h.clock.pending.size, 1)

  h.state.tasks.find(task => task.id === 101).status = 'completed'
  h.state.characters[0].image_url = 'static/images/new.png'
  await h.clock.advance(4000)
  assert.equal(h.vm.isPendingCharImage(7), false)
  assert.equal(h.vm.chars.value[0].image_url, 'static/images/new.png')
  assert.equal(h.vm.assetDetail.value.item.image_url, 'static/images/new.png')
  assert.equal(h.vm.genTaskActiveCount.value, 0)
  assert.equal(h.clock.pending.size, 0)
  const lastTasksRead = h.calls.lastIndexOf('tasks')
  assert.ok(lastTasksRead < h.calls.lastIndexOf('characters'), 'terminal status is read before its final asset writeback')
})

test('a failed image task releases regeneration even when the old image is still present', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  await h.vm.refresh()
  await h.vm.genCharImg(7)
  assert.equal(h.vm.isPendingCharImage(7), true)
  Object.assign(h.state.tasks.find(task => task.id === 101), { status: 'failed', error_msg: 'fetch failed' })
  await h.clock.advance(4000)
  assert.equal(h.vm.isPendingCharImage(7), false)
  assert.equal(h.vm.chars.value[0].image_url, 'static/images/old.png')
  assert.ok(h.notices.some(([kind, message, options]) => kind === 'task-error' && message === 'fetch failed' && options.source === 'task'))
  assert.equal(h.clock.pending.size, 0)
})

test('old images never override the preparing, submitting, queued, generating, downloading or saving button state', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  h.state.characters[0].final_prompt = ''
  await h.vm.refresh()
  h.vm.openAssetDetail('character', h.vm.chars.value[0])
  let submitImage
  h.apis.characterAPI.generatePrompt = () => { throw new Error('Preparation must be handled by the server job') }
  h.apis.characterAPI.generateImage = () => new Promise(resolve => { submitImage = resolve })
  const generation = h.vm.genCharImg(7)
  await settle()
  assert.equal(h.vm.isPendingCharImage(7), true)
  assert.equal(h.vm.assetImageActionLabel('character', h.vm.chars.value[0]), 'episode.tasks.stage.submitting')
  h.state.preparationJobs=[{id:'prepare-7',asset_kind:'character',asset_id:7,status:'preparing_prompt',active:true,created_at:new Date().toISOString()}]
  submitImage({asset_job_id:'prepare-7',status:'preparing_prompt'})
  await generation
  assert.match(h.vm.assetImageActionLabel('character',h.vm.chars.value[0]),/^episode.tasks.stage.preparingPrompt · \d+ 秒$/)
  assert.match(h.vm.assetImageActionLabel('character',h.vm.chars.value[0],true),/^episode.tasks.stage.preparingPrompt · \d+ 秒$/)
  assert.equal(h.vm.genTaskRows.value.find(row=>row.id==null).stage,'preparing_prompt')
  h.state.tasks.push({ id: 101, type: 'image', character_id: 7, status: 'processing', stage: 'queued' })
  Object.assign(h.state.preparationJobs[0],{status:'completed',image_generation_id:101,active:true})
  await h.vm.refresh()
  for (const [stage, expected] of [['queued', 'queued'], ['polling', 'generating'], ['downloading', 'downloading'], ['saving', 'saving']]) {
    const task = h.state.tasks.find(task => task.id === 101)
    task.stage = stage
    if (stage === 'downloading') {
      task.result_url = 'https://example.test/new.png'
      task.params = JSON.stringify({ downloadProgress: { receivedBytes: 1024, totalBytes: 2048 } })
    }
    await h.vm.refresh()
    assert.equal(h.vm.assetImageActionLabel('character', h.vm.chars.value[0]), `episode.tasks.stage.${expected}`)
    const row = h.vm.genTaskRows.value.find(row => row.id === 101)
    assert.equal(h.vm.taskIsBusy(row), true)
    if (stage === 'downloading') {
      assert.equal(row.previewUrl, 'https://example.test/new.png')
      assert.equal(h.vm.taskStageLabel(row), 'episode.tasks.stage.downloadingImage')
      assert.equal(h.vm.taskDownloadLabel(row), 'episode.tasks.downloadBytesTotal')
    }
  }
  assert.equal(h.vm.assetDetail.value.item.image_url, 'static/images/old.png')
  h.vm.panel.value = 'production'
  h.vm.prodTab.value = 'assets'
  h.vm.taskDrawer.value = true
  const html = await h.render()
  const cardButton = html.match(/<button[^>]*character-gen-btn[^>]*>[\s\S]*?<\/button>/)?.[0]
  assert.ok(cardButton)
  assert.match(cardButton, /disabled/)
  assert.match(cardButton, /aria-busy="true"/)
  assert.match(cardButton, /data-task-spinner="true"/)
  assert.match(cardButton, /episode.tasks.stage.saving/)
  assert.match(html, /asset-detail-primary-actions[\s\S]*?<button class="btn" disabled aria-busy="true"><svg data-task-spinner="true"/)
  assert.match(html, /task-stage-line[\s\S]*?data-task-spinner="true"/)
})

test('unfinished remote images offer explicit preview without competing automatic image downloads', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  h.state.tasks.push({ id: 101, type: 'image', character_id: 7, status: 'processing', stage: 'downloading', result_url: 'https://example.test/large-result.png' })
  await h.vm.refresh()
  h.vm.taskDrawer.value = true
  const html = await h.render()
  assert.match(html, /task-preview-action/)
  assert.doesNotMatch(html, /<img[^>]*src="https:\/\/example\.test\/large-result\.png"/)
  const row = h.vm.genTaskRows.value.find(row => row.id === 101)
  assert.equal(row.hasLocalFile, false)
  assert.equal(h.vm.taskStageLabel(row), 'episode.tasks.stage.downloadingImage')
  h.vm.openImageViewer(row.previewUrl, row.targetLabel)
  assert.equal(h.vm.imageViewer.value.src, 'https://example.test/large-result.png')
})

test('provider-confirmed video failure cannot offer recovery, while blocked polling retains recovery of the original task', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  h.apis.episodeAPI.storyboards = async () => [{ id: 11, video_prompt: 'ready' }]
  h.state.tasks = [{ id: 501, type: 'video', storyboard_id: 11, status: 'failed', task_id: 'existing-platform-task', error_code: 'provider_task_failed', error_msg: '平台已确认失败' }]
  for (const code of ['provider_task_failed', 'generation_failed', 'generation_rejected']) {
    h.state.tasks[0].error_code = code
    await h.vm.refresh()
    assert.equal(h.vm.canRecoverVideo(11), false, code)
    assert.equal(h.vm.recoverableVideoCount.value, 0, code)
    assert.equal(h.vm.genTaskRows.value.find(row => row.id === 501).recoverable, false, code)
  }
  h.vm.panel.value = 'production'
  h.vm.prodTab.value = 'videos'
  h.vm.taskDrawer.value = true
  const html = await h.render()
  assert.doesNotMatch(html, /episode\.recovery\.restoreDownload|>episode\.recovery\.restore<\/button>/)
  for (const code of ['video_poll_access_failed', 'video_poll_not_found', 'video_poll_timeout', 'delivery_failed']) {
    h.state.tasks[0].error_code = code
    await h.vm.refresh()
    assert.equal(h.vm.canRecoverVideo(11), true, code)
    assert.equal(h.vm.recoverableVideoCount.value, 1, code)
    assert.equal(h.vm.genTaskRows.value.find(row => row.id === 501).recoverable, true, code)
  }
})

test('image recovery displays its own loading label and blocks duplicate clicks until the download finishes', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  h.state.tasks.push({ id: 101, type: 'image', character_id: 7, status: 'failed', stage: 'downloading', error_code: 'image_delivery_failed', error_msg: 'timeout', result_url: 'https://example.test/result.png' })
  await h.vm.refresh()
  let finishRecovery
  let recoveries = 0
  h.apis.taskAPI.recover = () => { recoveries++; return new Promise(resolve => { finishRecovery = resolve }) }
  let row = h.vm.genTaskRows.value.find(row => row.id === 101)
  assert.equal(h.vm.taskRestoreLabel(row), 'episode.recovery.restoreImage')
  const recovery = h.vm.recoverTask(101)
  await h.vm.recoverTask(101)
  assert.equal(recoveries, 1)
  assert.equal(h.vm.taskIsBusy(row), true)
  assert.equal(h.vm.taskRestoreLabel(row), 'episode.recovery.restoringImage')
  assert.equal(h.vm.assetImageActionLabel('character', h.vm.chars.value[0]), 'episode.tasks.stage.downloading')
  assert.equal(h.vm.genTaskRows.value.filter(row => row.id == null).length, 0)
  Object.assign(h.state.tasks.find(task => task.id === 101), { status: 'processing', stage: 'queued', error_msg: null, error_code: null })
  finishRecovery({ id: 101 })
  await recovery
  row = h.vm.genTaskRows.value.find(row => row.id === 101)
  assert.equal(h.vm.taskIsBusy(row), true)
  await h.vm.recoverTask(101)
  assert.equal(recoveries, 1)
  Object.assign(h.state.tasks.find(task => task.id === 101), { status: 'completed', stage: 'completed' })
  h.state.characters[0].image_url = 'static/images/recovered.png'
  await h.clock.advance(2500)
  assert.equal(h.vm.isPendingCharImage(7), false)
  assert.equal(h.vm.assetImageActionLabel('character', h.vm.chars.value[0]), 'episode.asset.regen')
})

test('a saved image with measured aspect mismatch stays completed and only shows a nonblocking drawer warning', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  h.state.tasks.push({ id: 101, type: 'image', scene_id: 10, status: 'completed', local_path: 'static/images/scene.png', params: JSON.stringify({ imageOutput: { width: 1312, height: 1199, expectedAspectRatio: '16:9', aspectRatioMatches: false } }) })
  h.state.scenes[0].image_url = 'static/images/scene.png'
  await h.vm.refresh()
  h.vm.panel.value = 'production'
  h.vm.prodTab.value = 'assets'
  h.vm.taskDrawer.value = true
  h.vm.openAssetDetail('scene', h.vm.scenes.value[0])
  const row = h.vm.genTaskRows.value.find(row => row.id === 101)
  assert.equal(h.vm.genTaskStateClass(row.status), 'done')
  assert.equal(h.vm.taskIsBusy(row), false)
  assert.equal(row.recoverable, false)
  const html = await h.render()
  assert.match(html, /task-output-warning[^>]*role="status"[^>]*>episode.tasks.aspectRatioWarning/)
  assert.match(html, /asset-cover wide scene-cover/)
  assert.match(html, /asset-detail-media-frame is-scene/)
  assert.equal(h.clock.pending.size, 0)
  assert.equal(h.calls.some(call => call.startsWith('generate:')), false)
  delete h.state.tasks.find(task => task.id === 101).params
  await h.vm.refresh()
  assert.doesNotMatch(await h.render(), /task-output-warning/)
})

test('888API fixed-15 channel preserves an existing 9-second shot, then submits explicit model/config and ordered image references after a manual timing edit', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  h.state.scenes[0].image_url = 'static/images/scene.png'
  h.state.characters[0].voice_audio_url = 'static/audio/voice.mp3'
  h.state.props.push({ id: 20, name: '茶杯', image_url: 'static/images/cup.png' })
  await h.vm.refresh()
  const fast = 'jimeng-video-seedance-2.0-fast-vip'
  h.vm.videoConfigs.value = [
    { id: 9, provider: 'volcengine', model: ['official-model'], is_active: true, priority: 100 },
    { id: 88, provider: '888api', model: [...api888.API888_VIDEO_MODELS], is_active: true, priority: 10 },
  ]
  h.vm.episode.value.video_config_id = 9
  h.vm.episode.value.resolution = '1080p'
  h.vm.videoModel.value = `888api/${fast}`
  const shot = { id: 11, duration: 9, scene_id: 10, character_ids: [7], prop_ids: [20], video_prompt: '@山间，@高大山端起@茶杯，0–9秒。' }
  h.vm.sbs.value = [shot]
  h.vm.selectedSb.value = shot
  h.apis.episodeAPI.storyboards = async () => [clone(shot)]
  const savedDurations = []
  h.apis.storyboardAPI.update = async (id, body) => { savedDurations.push(body.duration) }
  const requests = []
  h.apis.taskAPI.generate = async body => {
    requests.push(body)
    h.state.tasks.push({ id: 501, type: 'video', status: 'processing', storyboard_id: 11 })
    return { id: 501 }
  }
  assert.equal(h.vm.effectiveVideoSelection.value.configId, 88)
  assert.equal(h.vm.effectiveVideoModelLabel.value, fast)
  assert.deepEqual([...h.vm.resolutionOptions.value.map(option => option.key)], ['720p'])
  assert.equal(h.vm.episodeResolution.value, '720p')
  assert.equal(h.vm.refImageLimit.value, 12)
  assert.equal(h.vm.videoDurationRange.value.min, 15)
  assert.equal(h.vm.videoDurationRange.value.max, 15)
  assert.equal(shot.duration, 9)
  assert.equal(h.vm.mentionOptions.value.some(option => option.kind === 'voice'), false)
  await h.vm.genVid(shot)
  assert.equal(requests.length, 0)
  assert.equal(shot.duration, 9)
  assert.ok(h.notices.some(([method, message]) => method === 'warning' && message === 'episode.vid.api888FixedDuration'))
  h.vm.panel.value = 'production'
  h.vm.prodTab.value = 'videos'
  const html = await h.render()
  assert.match(html, /value="9" type="number" min="15" max="15" step="1"/)
  assert.match(html, /episode.vid.api888FixedDuration/)
  h.vm.onVideoDurationChange({ target: { value: '9' } })
  assert.equal(shot.duration, 9)
  assert.deepEqual(savedDurations, [])
  h.vm.onVideoDurationChange({ target: { value: '15' } })
  shot.video_prompt = '@山间，@高大山端起@茶杯，0–15秒。'
  await h.vm.genVid(shot)
  assert.deepEqual(savedDurations, [15])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].model, fast)
  assert.equal(requests[0].config_id, 88)
  assert.equal(requests[0].duration, 15)
  assert.equal(requests[0].resolution, '720p')
  assert.equal(requests[0].aspect_ratio, '16:9')
  assert.deepEqual([...requests[0].reference_image_urls], ['static/images/scene.png', 'static/images/old.png', 'static/images/cup.png'])
  assert.match(requests[0].prompt, /@image_file_1 山间/)
  assert.match(requests[0].prompt, /@image_file_2 高大山/)
  assert.match(requests[0].prompt, /@image_file_3 茶杯/)
  assert.equal('reference_audio_urls' in requests[0], false)
  assert.equal('reference_video_urls' in requests[0], false)
  assert.equal('generate_audio' in requests[0], false)
})

test('888API default label and request use the actual locked configuration; adaptive projects require an explicit request ratio', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  await h.vm.refresh()
  const fast = 'jimeng-video-seedance-2.0-fast-vip'
  h.vm.videoConfigs.value = [
    { id: 9, provider: 'volcengine', model: ['official-model'], is_active: true, priority: 100 },
    { id: 88, provider: '888api', model: [fast], is_active: true, priority: 10 },
  ]
  h.vm.episode.value.video_config_id = 88
  h.vm.videoModel.value = ''
  h.vm.drama.value.aspect_ratio = 'adaptive'
  const shot = { id: 11, duration: 15, video_prompt: '0–15秒，山间空镜。' }
  h.vm.sbs.value = [shot]
  h.vm.selectedSb.value = shot
  assert.equal(h.vm.videoModelOptions.value[0].model, 'official-model')
  assert.equal(h.vm.effectiveVideoModelLabel.value, fast)
  await h.render()
  assert.ok(h.translations.some(call => call.key === 'episode.model.defaultWith' && call.params.model === fast))
  const requests = []
  h.apis.taskAPI.generate = async body => { requests.push(body); return { id: 501 } }
  await h.vm.genVid(shot)
  assert.equal(requests.length, 0)
  assert.ok(h.notices.some(([method, message]) => method === 'warning' && message === 'episode.vid.api888ConcreteRatio'))
  h.vm.api888AspectRatio.value = '9:16'
  await h.vm.genVid(shot)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].config_id, 88)
  assert.equal(requests[0].model, fast)
  assert.equal(requests[0].aspect_ratio, '9:16')
})

test('888API rejects unsupported voice, reference overflow and models before submitting; official reference tokens stay unchanged', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  h.state.scenes[0].image_url = 'scene.png'
  await h.vm.refresh()
  const fast = 'jimeng-video-seedance-2.0-fast-vip'
  h.vm.videoConfigs.value = [{ id: 88, provider: '888api', model: [fast, 'unsupported-model'], is_active: true }]
  h.vm.videoModel.value = `888api/${fast}`
  const shot = { id: 11, duration: 15, scene_id: 10, character_ids: [7], video_prompt: '#高大山说话' }
  let submissions = 0
  const requests = []
  h.apis.taskAPI.generate = async body => { submissions++; requests.push(body); return { id: 501 } }
  await h.vm.genVid(shot)
  assert.equal(submissions, 0)
  assert.ok(h.notices.some(([method, message]) => method === 'warning' && message === 'episode.vid.api888ImageOnly'))
  h.vm.chars.value = Array.from({ length: 13 }, (_, index) => ({ id: index + 100, name: `角色${index}`, image_url: `char-${index}.png` }))
  shot.character_ids = h.vm.chars.value.map(item => item.id)
  shot.video_prompt = '@山间，众人站立。'
  await h.vm.genVid(shot)
  assert.equal(submissions, 0)
  assert.ok(h.notices.some(([method, message]) => method === 'warning' && message === 'episode.vid.api888TooManyImages'))
  h.vm.videoModel.value = '888api/unsupported-model'
  await h.vm.genVid(shot)
  assert.equal(submissions, 0)
  assert.ok(h.notices.some(([method, message]) => method === 'warning' && message === 'episode.vid.api888UnsupportedModel'))
  h.vm.videoConfigs.value = [{ id: 9, provider: 'volcengine', model: ['official-model'], is_active: true }]
  h.vm.videoModel.value = 'volcengine/official-model'
  assert.equal(h.vm.resolveVideoPromptRefs(shot), '@图片1山间，众人站立。')
  assert.equal(h.vm.videoDurationRange.value.min, 2)
  assert.equal(h.vm.videoDurationRange.value.max, 30)
  await h.vm.genVid(shot)
  assert.equal(submissions, 1)
  assert.equal(requests[0].generate_audio, true)
})

test('888API C5 default accepts a 9-second shot with @图 references, nine-image capability and unchanged local asset paths', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  h.state.scenes[0].image_url = 'static/images/scene.png'
  h.state.characters.push({ id: 8, name: '白秋', image_url: 'static/images/right.png' })
  await h.vm.refresh()
  h.vm.videoConfigs.value = [{ id: 88, provider: '888api', model: [...api888.API888_VIDEO_MODELS], is_active: true }]
  h.vm.videoModel.value = ''
  h.vm.episode.value.video_config_id = 88
  const shot = { id: 11, duration: 9, scene_id: 10, character_ids: [7, 8], video_prompt: '左侧@高大山望向右侧@白秋，保持@山间，0–9秒。' }
  h.vm.sbs.value = [shot]
  h.vm.selectedSb.value = shot
  h.apis.episodeAPI.storyboards = async () => [clone(shot)]
  const requests = []
  h.apis.taskAPI.generate = async body => { requests.push(body); return { id: 501 } }
  assert.equal(h.vm.effectiveVideoModelLabel.value, 'seedance2.0-933-c5-fast')
  assert.equal(h.vm.videoDurationRange.value.min, 4)
  assert.equal(h.vm.videoDurationRange.value.max, 15)
  assert.equal(h.vm.refImageLimit.value, 9)
  assert.match(h.vm.api888DurationNotice.value, /episode.vid.api888PublicReferences/)
  assert.ok(h.translations.some(call => call.key === 'episode.vid.api888Capabilities' && call.params.maxImages === 9))
  h.vm.panel.value = 'production'
  h.vm.prodTab.value = 'videos'
  assert.match(await h.render(), /value="9" type="number" min="4" max="15" step="1"/)
  await h.vm.genVid(shot)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].model, 'seedance2.0-933-c5-fast')
  assert.equal(requests[0].duration, 9)
  assert.equal(requests[0].config_id, 88)
  assert.equal(requests[0].resolution, '720p')
  assert.equal('generate_audio' in requests[0], false)
  assert.deepEqual([...requests[0].reference_image_urls], ['static/images/scene.png', 'static/images/old.png', 'static/images/right.png'])
  assert.match(requests[0].prompt, /左侧@图2 高大山望向右侧@图3 白秋/)
  assert.match(requests[0].prompt, /@图1 山间/)
  assert.doesNotMatch(requests[0].prompt, /@image_file_/)
  assert.equal(h.state.characters[0].image_url, 'static/images/old.png')
  assert.equal(shot.duration, 9)
})

test('batch scene submission failure clears only that scene, and the remaining generation finishes normally', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  h.state.failedSubmissions.add('scene:11')
  await h.vm.refresh()
  await h.vm.batchSceneImages()
  assert.equal(h.vm.isPendingSceneImage(10), true)
  assert.equal(h.vm.isPendingSceneImage(11), false)
  assert.equal(h.state.tasks.filter(task => task.type === 'image' && task.scene_id).length, 1)
  h.state.tasks.find(task => task.scene_id === 10).status = 'completed'
  h.state.scenes[0].image_url = 'static/images/scene.png'
  await h.clock.advance(4000)
  assert.equal(h.vm.isPendingSceneImage(10), false)
  assert.equal(h.vm.scenes.value[0].image_url, 'static/images/scene.png')
  assert.equal(h.clock.pending.size, 0)
})

test('text extraction terminal state and a missing video prompt job clear their actual running UI state', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  await h.vm.refresh()
  h.state.extractStatus.characters = { status: 'running' }
  h.state.videoPromptsStatus = { status: 'running', total: 2, completed: 0 }
  h.vm.extractingTargets.value = ['characters']
  h.vm.videoPromptBatch.value = { running: true, total: 2, completed: 0 }
  h.vm.pollExtractStatus('characters')
  h.vm.pollVideoPromptBatch()
  await h.clock.advance(2500)
  assert.equal(h.vm.isExtracting('characters'), true)
  assert.equal(h.vm.videoPromptBatch.value.running, true)
  h.state.extractStatus.characters = { status: 'done' }
  h.state.videoPromptsStatus = null
  await h.clock.advance(2500)
  assert.equal(h.vm.isExtracting('characters'), false)
  assert.equal(h.vm.videoPromptBatch.value.running, false)
  assert.equal(h.clock.pending.size, 0)
})

test('actual component unmount cancels generation and text timers and prevents further requests', async () => {
  const h = workbench()
  await h.vm.refresh()
  await h.vm.genCharImg(7)
  h.vm.extractingTargets.value = ['characters']
  h.vm.pollExtractStatus('characters')
  h.vm.videoPromptBatch.value = { running: true, total: 1, completed: 0 }
  h.vm.pollVideoPromptBatch()
  assert.equal(h.clock.pending.size, 3)
  h.dispose()
  assert.equal(h.clock.pending.size, 0)
  assert.equal(h.vm.polling.active, false)
  const callsBefore = h.calls.length
  await h.clock.advance(8000)
  assert.equal(h.calls.length, callsBefore)
})

test('text task error prioritizes the real gateway failure and its supplied phase while revision still prioritizes validation issues', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  h.state.mappedErrors['Gateway Timeout'] = 'errors.upstreamGatewayTimeout'
  const staleIssue = { code: 'emotion', message: '旧的校验问题', shot_number: 99 }
  const job = { status: 'error', error: 'Gateway Timeout', provider_http_status: 504, failure_phase: 'generating', issues: [staleIssue] }
  const message = h.vm.validationMessage(job)
  assert.equal(message, 'composables.agent.failed · composables.agent.failedDuring.generating · errors.upstreamGatewayTimeout')
  assert.equal(h.state.errorMappings.at(-1).options.providerHttpStatus, 504)
  assert.equal(h.state.errorMappings.at(-1).options.source, 'task')
  assert.doesNotMatch(message, /旧的校验问题|99/)
  h.state.mappedErrors['Gateway Timeout'] = 'errors.modelGatewayTimeout'
  assert.equal(h.vm.validationMessage({ ...job, provider_http_status: undefined, failure_phase: undefined }), 'composables.agent.failed · errors.modelGatewayTimeout')
  const plainError = h.vm.validationMessage({ ...job, error: '服务中断，部分结果尚未保存', provider_http_status: undefined, failure_phase: 'unknown' })
  assert.equal(plainError, 'composables.agent.failed · 服务中断，部分结果尚未保存', 'unrecognized errors retain their actual message without inventing a phase')
  const mappings = h.state.errorMappings.length
  assert.match(h.vm.validationMessage({ ...job, status: 'needs_revision' }), /旧的校验问题/)
  assert.equal(h.state.errorMappings.length, mappings, 'validation details are not replaced by a generic transport error')
})

test('single prompt regeneration follows its durable job and rejects a nonempty old prompt as proof of success', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  const shot = { id: 11, duration: 9, video_prompt: '旧的非空提示词', description: '【镜头1】旧描述', character_ids: [7] }
  h.apis.episodeAPI.storyboards = async () => [clone(shot)]
  await h.vm.refresh()
  const result = h.vm.genVideoPrompt(h.vm.sbs.value[0])
  await settle()
  assert.equal(h.state.jobRequests[0].path, '/agent/prompt_generator/jobs')
  assert.deepEqual([...h.state.jobRequests[0].body.storyboard_ids], [11])
  const task = h.state.jobRequests[0].body.message
  assert.match(task, /已提供的锁定分镜资料/)
  assert.match(task, /系统指令.*程序负责引用编译、校验与保存/)
  assert.doesNotMatch(task, /read_storyboard_context|update_storyboard|@角色名|@场景名|@道具名/)
  assert.equal(h.vm.videoPromptGeneratingIds.value.includes(11), true)
  assert.equal(h.vm.sbs.value[0].video_prompt, '旧的非空提示词')
  h.state.jobs[0].phase = 'validating'
  await h.clock.advance(1500)
  h.vm.panel.value = 'production'
  h.vm.prodTab.value = 'videos'
  assert.match(await h.render(), /composables.agent.phase.validating/)
  Object.assign(h.state.jobs[0], { status: 'needs_revision', phase: 'needs_revision', issues: [{ code: 'coordinates', message: '缺少坐标基准', storyboard_id: 11, shot_number: 1 }] })
  await h.clock.advance(1500)
  await result
  assert.equal(h.vm.videoPromptGeneratingIds.value.length, 0)
  assert.equal(h.vm.rn.value, false)
  assert.match(h.vm.agentValidationMessage.value, /缺少坐标基准/)
  assert.match(await h.render(), /role="alert"[^>]*>[^<]*缺少坐标基准/)
  assert.ok(h.notices.some(([kind, message]) => kind === 'warning' && /缺少坐标基准/.test(message)))
  assert.equal(h.notices.some(([kind]) => kind === 'success'), false)
  assert.equal(h.state.jobRequests.length, 1, 'validation failure must not trigger a fresh paid job')
})

test('a validated text job waits for a post-completion snapshot when an older refresh is already in flight', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  let prompt = '旧提示词'
  h.apis.episodeAPI.storyboards = async () => [{ id: 11, video_prompt: prompt }]
  await h.vm.refresh()
  let releaseOld, releaseFresh, reads = 0
  const oldGate = new Promise(done => { releaseOld = done })
  const freshGate = new Promise(done => { releaseFresh = done })
  h.apis.episodeAPI.storyboards = async () => {
    const snapshot = [{ id: 11, video_prompt: prompt }]
    if (++reads === 1) await oldGate
    else await freshGate
    return snapshot
  }
  const oldRefresh = h.vm.refresh()
  await settle()
  const generation = h.vm.genVideoPrompt(h.vm.sbs.value[0])
  await settle()
  prompt = '新提示词'
  Object.assign(h.state.jobs[0], { status: 'done', phase: 'done' })
  await h.clock.advance(1500)
  assert.equal(h.vm.rn.value, true)
  releaseOld()
  await settle()
  assert.equal(reads, 2)
  assert.equal(h.vm.rn.value, true)
  assert.equal(h.notices.some(([kind]) => kind === 'success'), false)
  releaseFresh()
  await Promise.all([oldRefresh, generation])
  assert.equal(h.vm.sbs.value[0].video_prompt, '新提示词')
  assert.equal(h.vm.rn.value, false)
  assert.ok(h.notices.some(([kind]) => kind === 'success'))
})

test('historical text failure has a short previous-task marker and timing title, while a new request has its own outcome', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  h.apis.episodeAPI.storyboards = async () => [{ id: 11, video_prompt: '旧提示词' }]
  const oldJob = { id: '6dc-old', episode_id: 2, scope: 'agent', agent_type: 'prompt_generator', storyboard_ids: [11], status: 'error', phase: 'error', error: '旧任务超时已结束', started_at: '2026-11-03T22:05:00+08:00', finished_at: '2026-11-03T22:15:00+08:00' }
  h.state.jobs = [clone(oldJob)]
  await h.vm.refresh()
  await h.vm.syncAgentJobs()
  h.vm.panel.value = 'production'
  h.vm.prodTab.value = 'videos'
  assert.equal(h.vm.agentValidationInfo.value.historical, true)
  const banner = (await h.render()).match(/<div[^>]*agent-validation-message[^>]*>[\s\S]*?<\/div>/)?.[0]
  assert.ok(banner)
  assert.match(banner, /title="composables\.agent\.startedAt · composables\.agent\.finishedAt"/)
  assert.match(banner, />composables\.agent\.previousTask · /)
  assert.doesNotMatch(banner.split('>')[1], /6dc-old|2026|22:05|22:15/)
  assert.ok(h.translations.some(item => item.key === 'composables.agent.startedAt' && item.params.time === new Date(oldJob.started_at).toLocaleString()))
  assert.ok(h.translations.some(item => item.key === 'composables.agent.finishedAt' && item.params.time === new Date(oldJob.finished_at).toLocaleString()))
  assert.equal(h.state.jobRequests.length, 0)
  h.vm.videoPromptBatch.value = { running: false, status: 'needs_revision', failed: 1, issues: [{ code: 'duration', message: '本次批量任务时长需修正' }] }
  assert.match(h.vm.agentValidationMessage.value, /本次批量任务时长需修正/)
  assert.equal(h.vm.agentValidationInfo.value.historical, false, 'a current batch outcome outranks an older agent failure')
  h.vm.videoPromptBatch.value = { running: false, status: null, failed: 0 }
  const generating = h.vm.genVideoPrompt(h.vm.sbs.value[0])
  await settle()
  assert.equal(h.vm.agentValidationMessage.value, '')
  assert.equal(h.vm.agentResultIsHistory.value, false)
  assert.doesNotMatch(await h.render(), /composables\.agent\.previousTask/)
  Object.assign(h.state.jobs[0], { status: 'error', phase: 'error', error: '本次请求失败', started_at: '2026-11-03T22:17:00+08:00', finished_at: '2026-11-03T22:18:00+08:00' })
  await h.clock.advance(1500)
  await generating
  assert.match(h.vm.agentValidationMessage.value, /本次请求失败/)
  assert.equal(h.vm.agentValidationInfo.value.historical, false)
  assert.doesNotMatch(await h.render(), /composables\.agent\.previousTask/)
})

test('late restored failure cannot reappear in the actual workbench while a new text job is generating', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  h.apis.episodeAPI.storyboards = async () => [{ id: 11, video_prompt: '旧提示词' }]
  await h.vm.refresh()
  let releaseHistory
  const history = new Promise(resolve => { releaseHistory = resolve })
  const readJob = h.apis.api.get
  h.apis.api.get = path => path.includes('?') ? history : readJob(path)
  const restoring = h.vm.syncAgentJobs()
  const generating = h.vm.genVideoPrompt(h.vm.sbs.value[0])
  await settle()
  releaseHistory([{ id: '6dc-old', episode_id: 2, scope: 'agent', agent_type: 'storyboard_breaker', status: 'error', phase: 'error', error: '旧6dc任务超时' }])
  await restoring
  assert.equal(h.vm.rn.value, true)
  assert.equal(h.vm.agentResult.value, null)
  assert.equal(h.vm.agentValidationMessage.value, '')
  assert.equal(h.vm.agentJobs.value.length, 1)
  h.vm.panel.value = 'production'
  h.vm.prodTab.value = 'videos'
  assert.doesNotMatch(await h.render(), /旧6dc任务超时|composables\.agent\.previousTask/)
  h.dispose()
  await generating
})

test('workbench restores only existing agent jobs with exact storyboard IDs, then refreshes assets after validated completion', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  let prompt = '旧提示词'
  h.apis.episodeAPI.storyboards = async () => [{ id: 11, video_prompt: prompt }]
  h.state.jobs = [
    { id: 401, episode_id: 2, scope: 'agent', agent_type: 'prompt_generator', storyboard_ids: [11], status: 'running', phase: 'repairing' },
    { id: 402, episode_id: 2, scope: 'video_prompt_batch', agent_type: 'prompt_generator', storyboard_ids: [12], status: 'running', phase: 'generating' },
  ]
  await h.vm.refresh()
  await h.vm.syncAgentJobs()
  await settle()
  assert.deepEqual([...h.vm.videoPromptGeneratingIds.value], [11])
  assert.equal(h.vm.videoPromptJob(11).phase, 'repairing')
  assert.equal(h.state.jobRequests.length, 0)
  prompt = '校验后的提示词'
  Object.assign(h.state.jobs[0], { status: 'done', phase: 'done' })
  await h.clock.advance(1500)
  assert.equal(h.vm.rn.value, false)
  assert.equal(h.vm.sbs.value[0].video_prompt, prompt)
  assert.equal(h.vm.selectedSb.value.video_prompt, prompt)
  assert.ok(h.notices.some(([kind]) => kind === 'success'))
  assert.equal(h.state.jobRequests.length, 0)
})

test('breakdown uses jobs and a failed validation does not launch missing-prompt backfill', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  await h.vm.refresh()
  const result = h.vm.doBreakdown()
  await settle()
  assert.equal(h.state.jobRequests[0].path, '/agent/storyboard_breaker/jobs')
  h.apis.episodeAPI.storyboards = async () => [{ id: 11, video_prompt: '' }]
  Object.assign(h.state.jobs[0], { status: 'needs_revision', phase: 'needs_revision', issues: [{ code: 'duration', message: '叙事段不能统一9秒' }] })
  await h.clock.advance(1500)
  await result
  assert.equal(h.vm.rn.value, false)
  assert.match(h.vm.agentValidationMessage.value, /叙事段不能统一9秒/)
  assert.equal(h.state.jobRequests.length, 1)
  assert.equal(h.notices.some(([kind]) => kind === 'success'), false)
})

test('batch prompt restoration renders validation phase and warns when a completed batch contains failed items', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  h.apis.episodeAPI.storyboards = async () => [{ id: 11, video_prompt: '旧提示词' }]
  await h.vm.refresh()
  h.state.videoPromptsStatus = { status: 'running', phase: 'validating', total: 1, completed: 0, failed: 0 }
  await h.vm.syncExtractStatus()
  h.vm.panel.value = 'production'
  h.vm.prodTab.value = 'videos'
  assert.match(await h.render(), /composables.agent.phase.validating 0\/1/)
  h.state.videoPromptsStatus = { status: 'done', phase: 'done', total: 1, completed: 1, failed: 1, issues: [{ code: 'emotion', message: '缺少逐人情绪百分比', shot_number: 1 }] }
  await h.clock.advance(2500)
  assert.equal(h.vm.videoPromptBatch.value.running, false)
  assert.match(h.vm.agentValidationMessage.value, /缺少逐人情绪百分比/)
  assert.ok(h.notices.some(([kind, message]) => kind === 'warning' && /缺少逐人情绪百分比/.test(message)))
  assert.equal(h.notices.some(([kind]) => kind === 'success'), false)
})

test('route changes and unmount stop observing text jobs without submitting a cancellation or leaking callbacks', async () => {
  for (const leave of ['route', 'unmount']) {
    const h = workbench()
    await h.vm.refresh()
    h.vm.sbs.value = [{ id: 11, video_prompt: '旧提示词' }]
    const result = h.vm.genVideoPrompt(h.vm.sbs.value[0])
    await settle()
    assert.equal(h.vm.rn.value, true)
    if (leave === 'route') h.route.params.episodeNumber = '2'
    else h.dispose()
    await result
    assert.equal(h.vm.rn.value, false)
    const reads = h.calls.length
    h.state.jobs[0].status = 'done'
    await h.clock.advance(5000)
    assert.equal(h.calls.length, reads)
    assert.equal(h.state.jobRequests.length, 1)
    assert.equal(h.notices.some(([kind]) => kind === 'success'), false)
    h.dispose()
  }
})

test('a prompt finishing during an older refresh waits for a fresh snapshot before clearing its busy state', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  await h.vm.refresh()
  h.vm.openAssetDetail('character', h.vm.chars.value[0])
  let releaseOldSnapshot
  let releaseFreshSnapshot
  const oldSnapshotGate = new Promise(resolve => { releaseOldSnapshot = resolve })
  const freshSnapshotGate = new Promise(resolve => { releaseFreshSnapshot = resolve })
  let reads = 0
  h.apis.episodeAPI.storyboards = async () => {
    if (++reads === 1) await oldSnapshotGate
    else if (reads === 2) await freshSnapshotGate
    return []
  }
  // This refresh has already captured the previous character prompt, but cannot apply it yet.
  const oldRefresh = h.vm.refresh()
  await settle()
  assert.equal(reads, 1)
  h.apis.characterAPI.generatePrompt = async () => {
    h.state.characters[0].final_prompt = '新生成的角色提示词'
    return { final_prompt: '新生成的角色提示词' }
  }
  const generation = h.vm.ensureAssetPrompt('character', 7, true)
  await settle()
  assert.equal(h.vm.isGeneratingPrompt('character', 7), true, 'POST completion alone must not clear the busy state')
  releaseOldSnapshot()
  await settle()
  assert.equal(reads, 2, 'prompt completion queues a new read after the stale refresh')
  assert.equal(h.vm.isGeneratingPrompt('character', 7), true, 'busy state remains until the new snapshot is applied')
  releaseFreshSnapshot()
  await Promise.all([oldRefresh, generation])
  assert.equal(h.vm.chars.value[0].final_prompt, '新生成的角色提示词')
  assert.equal(h.vm.assetDetail.value.item.final_prompt, '新生成的角色提示词')
  assert.equal(h.vm.assetFinalPrompt.value, '新生成的角色提示词')
  assert.equal(h.vm.isGeneratingPrompt('character', 7), false)
  assert.equal(h.clock.pending.size, 0)
})

function savedStoryboardDraft(extra = {}) {
  return { id: 'draft-1', mode: 'breakdown', status: 'needs_revision', total: 3, readyCount: 1, needsRevisionCount: 1,
    groups: [
      { number: 1, status: 'ready', attempts: 1, issues: [], candidate: { title: '完整首组', description: '第一组已保存的完整画面', video_prompt: '0-3秒：@高大山沿原路径行动。', result: '第一组末态：右手仍握原物。', duration: 9 } },
      { number: 2, status: 'needs_revision', attempts: 2, issues: [{ code: 'voice', message: '这一组需要补齐声音资料' }], candidate: { title: '待补次组', description: '第二组原始完整画面仍然保存', video_prompt: '0-3秒：@高大山听见原有声音。', result: '第二组末态与原文一致。', image_prompt: '首帧保留现有门窗位置。', sound_effect: '原有衣料摩擦声。', duration: 12 } },
      { number: 3, status: 'pending', attempts: 0, issues: [], candidate: null },
    ], ...extra }
}

test('saved server timing budget is visible and flags a rejected seventeen-group plan without generating', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  h.state.storyboardDraft = savedStoryboardDraft({
    budget: { characters: 1153, targetSeconds: 138.36, preferredGroups: 12, minimumGroups: 10, maximumGroups: 13 },
    plan: { groups: Array.from({ length: 17 }, (_, i) => ({ number: i + 1, duration: 8 })) }, groups: [],
    total: 0, readyCount: 0, needsRevisionCount: 0,
  })
  await h.vm.refresh()
  h.vm.panel.value = 'production'; h.vm.prodTab.value = 'videos'
  const html = await h.render()
  assert.match(html, /本次分镜规划预算/)
  assert.match(html, /1153 字/)
  assert.match(html, /138\.36 秒/)
  assert.match(html, /历史统计口径/)
  assert.match(html, /当前规划 17 组，超出允许范围 10～13 组/)
  assert.match(html, /is-outside-budget/)
  assert.equal(h.state.jobRequests.length, 0)
  assert.equal(h.vm.storyboardDraftTotal.value, 0, 'A rejected plan is still not counted as accepted generated groups')
  h.state.storyboardDraft = savedStoryboardDraft()
  await h.vm.loadStoryboardDraft()
  assert.doesNotMatch(await h.render(), /本次分镜规划预算/, 'Old drafts without a saved budget remain readable without guessed values')
})

test('saved body-only budget is labelled clearly while using backend counts', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  h.state.storyboardDraft = savedStoryboardDraft({
    budget: { characters: 999, targetSeconds: 119.88, preferredGroups: 10, minimumGroups: 8, maximumGroups: 11,
      scope: 'script-body-v1', totalCharacters: 1500, excludedCharacters: 501, excludedLineCount: 12 },
    plan: { groups: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, duration: 12 })) },
  })
  await h.vm.refresh()
  h.vm.panel.value = 'production'; h.vm.prodTab.value = 'videos'
  const html = await h.render()
  assert.match(html, /正文计字/)
  assert.match(html, /999 字/)
  assert.match(html, /已排除标题、人物表、场景表头和制作备注/)
  assert.match(html, /排除 501 字/)
  assert.doesNotMatch(html, /历史统计口径/)
  assert.equal(h.state.jobRequests.length, 0)
})

test('boundary repair summaries remain compact and show exact adjacent groups and failure without private snapshots', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  h.state.storyboardDraft = savedStoryboardDraft({ boundaryRepairs: [
    { id: 'pair-old', left: 1, right: 2, status: 'applied', createdAt: '2026-11-16T00:00:00Z', before: { raw: 'private-before-snapshot' } },
    { id: 'pair-new', left: 3, right: 4, status: 'failed', createdAt: '2026-11-16T01:00:00Z', error: '第3组末态与第4组原文的牵手状态仍冲突。' },
  ] })
  await h.vm.refresh()
  h.vm.panel.value = 'production'; h.vm.prodTab.value = 'videos'
  const html = await h.render()
  assert.match(html, /<details class="storyboard-boundary-repairs">/)
  assert.match(html, /相邻组修复记录/)
  assert.match(html, /最近 2 条/)
  assert.match(html, /第 3—4 组/)
  assert.match(html, /未修复/)
  assert.match(html, /牵手状态仍冲突/)
  assert.match(html, /第 1—2 组/)
  assert.match(html, /已修复/)
  assert.doesNotMatch(html, /private-before-snapshot/)
  assert.equal(h.state.jobRequests.length, 0)
})

test('restored partial storyboard draft is readable with every saved field while the live shots and videos stay intact', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  const live = { id: 11, duration: 9, description: '当前可用分镜', video_prompt: '当前可用提示词', video_url: 'static/videos/old.mp4' }
  h.state.storyboards = [clone(live)]
  h.state.storyboardDraft = savedStoryboardDraft()
  await h.vm.refresh()
  assert.equal(h.vm.canContinueStoryboardDraft.value, true)
  assert.equal(h.vm.storyboardDraftReady.value, 1)
  assert.equal(h.vm.storyboardDraftNeedsRevision.value, 1)
  assert.equal(h.vm.storyboardDraftTotal.value, 3)
  assert.equal(h.vm.selectedStoryboardDraftNumber.value, 2)
  assert.equal(h.vm.sbs.value[0].video_prompt, live.video_prompt)
  assert.equal(h.vm.sbs.value[0].video_url, live.video_url)
  h.vm.panel.value = 'production'; h.vm.prodTab.value = 'videos'; h.vm.showStoryboardDraft.value = true
  const html = await h.render()
  for (const text of ['第二组原始完整画面仍然保存', '第二组末态与原文一致。', '首帧保留现有门窗位置。', '原有衣料摩擦声。', '这一组需要补齐声音资料']) assert.ok(html.includes(text), text)
  assert.match(html, /episode\.sb\.draft\.continue/)
  assert.match(html, /episode\.sb\.draft\.saved/)
  assert.doesNotMatch(html, /episode\.sb\.draft\.applied/)
  assert.equal(h.state.jobRequests.length, 0, 'Reading a draft must never resubmit a generation request')

  h.state.storyboardDraft = savedStoryboardDraft({ status: 'interrupted' })
  await h.vm.loadStoryboardDraft()
  assert.equal(h.vm.canContinueStoryboardDraft.value, true)

  h.state.storyboardDraft = savedStoryboardDraft({ status: 'ready', readyCount: 3, needsRevisionCount: 0 })
  await h.vm.loadStoryboardDraft()
  assert.equal(h.vm.canContinueStoryboardDraft.value, false)
  const readyHtml = await h.render()
  assert.match(readyHtml, /episode\.sb\.draft\.status\.ready/)
  assert.doesNotMatch(readyHtml, /episode\.sb\.draft\.applied/)
  assert.equal(h.vm.sbs.value[0].video_prompt, live.video_prompt)
})

test('a planning conflict with no groups remains visible after another task replaces the last result', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  const conflict = '原文source_ids [1, 3] 的总时长与8—15秒限制冲突；请补足动作依据，勿删对白。'
  const reminder = '原文第2段为无对白动作，仍须完整保留。'
  const internalNote = '原文ID覆盖和容量可行不证明正文完整：主要动作、因果链、台词自然分句、人物表演及结尾结果仍须按skill审稿。'
  h.state.storyboardDraft = savedStoryboardDraft({ total: 0, readyCount: 0, needsRevisionCount: 0, groups: [],
    issues: [{ code: 'model_constraint_conflict', field: 'duration', severity: 'error', message: conflict },
      { code: 'source_note', field: 'source_ids.2', severity: 'warning', message: reminder },
      { code: 'semantic_review_required', field: 'groups', severity: 'warning', message: internalNote }],
  })
  await h.vm.refresh()
  h.vm.panel.value = 'production'; h.vm.prodTab.value = 'videos'
  assert.equal(h.vm.storyboardDraftGroups.value.length, 0)
  assert.equal(h.vm.showStoryboardDraft.value, false, 'Planning problems stay visible even when preview details are collapsed')
  const initial = await h.render()
  assert.ok(initial.includes(conflict))
  assert.ok(initial.includes(reminder))
  assert.ok(!initial.includes(internalNote), 'The fixed internal review note is hidden without hiding an actual conflict or source warning')
  assert.match(initial, /class="is-error" role="alert"/)
  assert.match(initial, /class="is-warning" role="status"/)
  assert.match(initial, /episode\.sb\.draft\.issueError/)
  assert.match(initial, /episode\.sb\.draft\.issueWarning/)
  h.vm.agentResult.value = { id: 'later-prompt-job', agent_type: 'prompt_generator', episode_id: 2, status: 'done', phase: 'done', issues: [] }
  assert.equal(h.vm.agentValidationMessage.value, '')
  const after = await h.render()
  assert.ok(after.includes(conflict), 'The saved draft explains its own conflict independently of the latest job banner')
  assert.ok(after.includes(reminder))
  assert.ok(!after.includes(internalNote))
  assert.equal(h.vm.canContinueStoryboardDraft.value, true)
  assert.equal(h.state.jobRequests.length, 0)
})

test('an invalid model plan stays in automatic planning instead of becoming an empty creative group count', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  await h.vm.refresh()
  const generation = h.vm.doBreakdown()
  await settle()
  const conflict = '规划总时长121秒，允许上限112.75秒。'
  h.state.storyboardDraft = savedStoryboardDraft({ status: 'needs_revision', total: 10, readyCount: 0, needsRevisionCount: 0,
    groups: [], plan: { groups: Array.from({ length: 10 }, (_, i) => ({ number: i + 1 })) },
    issues: [{ code: 'constraint_conflict', field: 'groups', severity: 'error', message: conflict }],
  })
  Object.assign(h.state.jobs[0], { status: 'running', phase: 'repairing', draft_id: 'draft-1', total: 0, completed: 0, failed: 0 })
  await h.clock.advance(2000)
  assert.equal(h.vm.storyboardDraftTotal.value, 0, 'Rejected plan groups are not accepted creative work')
  assert.equal(h.vm.storyboardDraftPlanningLabel.value, 'episode.sb.draft.replanning')
  assert.equal(h.vm.canContinueStoryboardDraft.value, false)
  assert.equal(h.vm.validationMessage(h.state.jobs[0]), '')
  h.vm.panel.value = 'production'; h.vm.prodTab.value = 'videos'; h.vm.showStoryboardDraft.value = true
  const replanning = await h.render()
  assert.match(replanning, /episode\.sb\.draft\.replanning/)
  assert.match(replanning, /episode\.sb\.draft\.issueAdjusting/)
  assert.ok(replanning.includes(conflict), 'The actual planning reason remains readable while the server fixes it')
  assert.doesNotMatch(replanning, /episode\.sb\.draft\.(?:progressRunning|noGroups|continue)/)
  assert.equal(h.notices.length, 0)
  assert.equal(h.state.jobRequests.length, 1)

  h.state.storyboardDraft = savedStoryboardDraft({ status: 'generating', readyCount: 0, needsRevisionCount: 0, issues: [],
    groups: savedStoryboardDraft().groups.map(group => ({ ...group, status: 'pending', candidate: null, issues: [] })) })
  Object.assign(h.state.jobs[0], { phase: 'generating', total: 3 })
  await h.clock.advance(2000)
  assert.equal(h.vm.storyboardDraftTotal.value, 3)
  const creative = await h.render()
  assert.match(creative, /episode\.sb\.draft\.progressRunning/)
  assert.doesNotMatch(creative, /episode\.sb\.draft\.replanning/)
  assert.equal(h.state.jobRequests.length, 1)

  h.state.storyboardDraft = savedStoryboardDraft({ status: 'committed', readyCount: 3, needsRevisionCount: 0,
    groups: savedStoryboardDraft().groups.map(group => ({ ...group, status: 'ready', issues: [] })) })
  Object.assign(h.state.jobs[0], { status: 'done', phase: 'done', completed: 3, failed: 0 })
  await h.clock.advance(2000)
  await generation
  assert.equal(h.vm.rn.value, false)
  assert.equal(h.state.jobRequests.length, 1)
  assert.equal(h.notices.some(([kind]) => kind === 'warning' || kind === 'task-error'), false)
})

test('draft progress updates during a durable job and explicit continue issues one job without resetting the saved preview', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  h.state.storyboards = [{ id: 11, duration: 9, video_prompt: '原版可用提示词' }]
  await h.vm.refresh()
  const generation = h.vm.doBreakdown()
  await settle()
  h.state.storyboardDraft = savedStoryboardDraft({ status: 'generating', needsRevisionCount: 0 })
  await h.clock.advance(2000)
  assert.equal(h.vm.storyboardDraft.value.id, 'draft-1')
  assert.equal(h.vm.storyboardDraftReady.value, 1)
  assert.equal(h.vm.rn.value, true)
  assert.equal(h.vm.sbs.value[0].video_prompt, '原版可用提示词')
  h.state.storyboardDraft = savedStoryboardDraft()
  Object.assign(h.state.jobs[0], { status: 'needs_revision', phase: 'needs_revision', draft_id: 'draft-1', issues: [{ code: 'voice', message: '第二组声音资料待补齐', shot_number: 2 }] })
  await h.clock.advance(2000)
  await generation
  assert.equal(h.vm.rn.value, false)
  assert.equal(h.vm.canContinueStoryboardDraft.value, true)
  assert.match(h.vm.agentValidationMessage.value, /composables\.agent\.draftSaved/)
  assert.ok(h.notices.some(([kind, message]) => kind === 'warning' && String(message).startsWith('composables.agent.draftSaved')))
  assert.equal(h.state.jobRequests.length, 1)
  assert.equal(h.clock.pending.size, 0)

  h.vm.selectedStoryboardDraftNumber.value = 1
  const continuation = h.vm.doBreakdown()
  await h.vm.doBreakdown()
  await settle()
  assert.equal(h.state.jobRequests.length, 2, 'Double-clicking continue cannot create a second active job')
  assert.equal(h.vm.storyboardDraftGroups.value[0].candidate.description, '第一组已保存的完整画面')
  assert.equal(h.vm.selectedStoryboardDraftNumber.value, 1, 'A resumed request preserves the reader selection')
  const continuationBody = h.state.jobRequests[1].body
  assert.equal('restart' in continuationBody || 'force' in continuationBody, false)
  h.state.storyboardDraft = savedStoryboardDraft({ status: 'committed', readyCount: 3, needsRevisionCount: 0, groups: savedStoryboardDraft().groups.map(group => ({ ...group, status: 'ready' })) })
  h.state.storyboards = [{ id: 21, duration: 12, video_prompt: '本次完整并应用的新提示词' }]
  Object.assign(h.state.jobs[0], { status: 'done', phase: 'done', draft_id: 'draft-1' })
  await h.clock.advance(2000)
  await continuation
  assert.equal(h.vm.rn.value, false)
  assert.equal(h.vm.canContinueStoryboardDraft.value, false)
  assert.equal(h.vm.storyboardDraft.value.status, 'committed')
  assert.equal(h.vm.sbs.value[0].id, 21)
  h.vm.panel.value = 'production'; h.vm.prodTab.value = 'videos'
  assert.match(await h.render(), /episode\.sb\.draft\.applied/)
  assert.equal(h.clock.pending.size, 0)
})

test('automatic recovery stays busy through later groups and finishes one durable request without a premature pause banner', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  h.state.storyboards = [{ id: 11, duration: 9, video_prompt: '原版可用提示词' }]
  await h.vm.refresh()
  const generation = h.vm.doBreakdown()
  await settle()
  const problem = '本组输出未完成，后台正在自动处理。'
  const retryDraft = savedStoryboardDraft({ status: 'needs_revision' })
  retryDraft.groups[1].status = 'error'
  retryDraft.groups[1].issues = [{ code: 'text_output_limit', severity: 'error', message: problem }]
  retryDraft.groups[1].error = problem
  h.state.storyboardDraft = retryDraft
  Object.assign(h.state.jobs[0], { status: 'running', phase: 'repairing', draft_id: 'draft-1', failed: 1,
    issues: [{ code: 'text_output_limit', severity: 'error', message: problem, shot_number: 2 }] })
  await h.clock.advance(2000)
  assert.equal(h.vm.rn.value, true)
  assert.equal(h.vm.agentPhase.value, 'repairing')
  assert.equal(h.vm.canContinueStoryboardDraft.value, false)
  assert.equal(h.vm.storyboardDraftDisplayStatus.value, 'generating')
  assert.equal(h.vm.validationMessage(h.state.jobs[0]), '', 'A recoverable running job is not a terminal failure')
  assert.equal(h.vm.storyboardDraftGroups.value[0].candidate.description, '第一组已保存的完整画面')
  h.vm.panel.value = 'production'; h.vm.prodTab.value = 'videos'; h.vm.showStoryboardDraft.value = true
  const recovering = await h.render()
  assert.match(recovering, /episode\.sb\.draft\.progressRunning/)
  assert.match(recovering, /episode\.sb\.draft\.groupStatus\.recovering/)
  assert.doesNotMatch(recovering, /episode\.sb\.draft\.continue/)
  assert.equal(recovering.split(problem).length - 1, 1, 'The readable draft retains one copy of its actual problem')
  assert.equal(h.notices.length, 0)

  h.state.storyboardDraft = savedStoryboardDraft({ status: 'generating', readyCount: 2, needsRevisionCount: 0,
    groups: savedStoryboardDraft().groups.map(group => group.number === 2 ? { ...group, status: 'ready', issues: [] } : group) })
  Object.assign(h.state.jobs[0], { status: 'running', phase: 'generating', completed: 2, failed: 0, issues: [] })
  await h.clock.advance(2000)
  assert.equal(h.vm.rn.value, true, 'Later groups keep the original loading state')
  assert.equal(h.vm.storyboardDraftReady.value, 2)
  assert.equal(h.state.jobRequests.length, 1, 'The frontend never resubmits recovery work')

  h.state.storyboardDraft = savedStoryboardDraft({ status: 'committed', readyCount: 3, needsRevisionCount: 0,
    groups: savedStoryboardDraft().groups.map(group => ({ ...group, status: 'ready', issues: [] })) })
  h.state.storyboards = [{ id: 21, duration: 12, video_prompt: '完成并应用的完整结果' }]
  Object.assign(h.state.jobs[0], { status: 'done', phase: 'done', completed: 3, failed: 0, issues: [] })
  await h.clock.advance(2000)
  await generation
  assert.equal(h.vm.rn.value, false)
  assert.equal(h.vm.canContinueStoryboardDraft.value, false)
  assert.equal(h.vm.sbs.value[0].video_prompt, '完成并应用的完整结果')
  assert.equal(h.state.jobRequests.length, 1)
  assert.equal(h.notices.filter(([kind]) => kind === 'success').length, 1)
  assert.equal(h.notices.some(([kind]) => kind === 'warning' || kind === 'task-error'), false)
  assert.equal(h.clock.pending.size, 0)
})

test('a terminal task toast and banner skip the fixed internal review note but retain the actual failure', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  await h.vm.refresh()
  const generation = h.vm.doBreakdown()
  await settle()
  const internalNote = '内部来源覆盖审稿提醒，不应显示给用户。'
  const failure = '必要素材资料缺失，请补齐场景。'
  Object.assign(h.state.jobs[0], { status: 'needs_revision', phase: 'needs_revision', draft_id: 'draft-1', failed: 1,
    issues: [
      { code: 'semantic_review_required', field: 'groups', severity: 'warning', message: internalNote },
      { code: 'line_dialogue_budget', field: 'video_prompt', severity: 'warning', message: '可人工核对口播速度，但这不是任务失败原因。' },
      { code: 'context_missing', field: 'scene', severity: 'error', message: failure },
    ] })
  await h.clock.advance(2000)
  await generation
  assert.match(h.vm.agentValidationMessage.value, new RegExp(failure))
  assert.equal(h.vm.agentValidationMessage.value.includes(internalNote), false)
  const notice = h.notices.find(([kind]) => kind === 'warning')
  assert.ok(notice)
  assert.ok(String(notice[1]).includes(failure))
  assert.equal(String(notice[1]).includes(internalNote), false)
})

test('out-of-order draft reads cannot replace a newer preview and a transient read failure retains it', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  h.state.storyboardDraft = savedStoryboardDraft()
  await h.vm.refresh()
  const originalGet = h.apis.api.get
  let releaseOld, reads = 0
  const old = new Promise(resolve => { releaseOld = resolve })
  h.apis.api.get = path => path.includes('/storyboard-draft') ? (++reads === 1 ? old : Promise.resolve(savedStoryboardDraft({ readyCount: 2 }))) : originalGet(path)
  const stale = h.vm.loadStoryboardDraft()
  await h.vm.loadStoryboardDraft()
  releaseOld(savedStoryboardDraft({ readyCount: 0 }))
  await stale
  assert.equal(h.vm.storyboardDraftReady.value, 2)
  h.apis.api.get = async () => { throw new Error('temporary draft read failure') }
  await h.vm.loadStoryboardDraft()
  assert.equal(h.vm.storyboardDraftReady.value, 2)
  assert.equal(h.notices.length, 0)
})

test('route changes and unmount discard late draft reads and stop draft polling without sending requests', async () => {
  for (const leave of ['route', 'unmount']) {
    const h = workbench()
    h.state.storyboardDraft = savedStoryboardDraft()
    await h.vm.refresh()
    let release
    const late = new Promise(resolve => { release = resolve })
    const originalGet = h.apis.api.get
    h.apis.api.get = path => path.includes('/storyboard-draft') ? late : originalGet(path)
    const read = h.vm.loadStoryboardDraft()
    if (leave === 'route') h.route.params.episodeNumber = '2'
    else h.dispose()
    release(savedStoryboardDraft({ id: 'late-other-view', readyCount: 3 }))
    await read
    assert.notEqual(h.vm.storyboardDraft.value?.id, 'late-other-view')
    assert.equal(h.state.jobRequests.length, 0)
    await h.clock.advance(4000)
    assert.equal(h.clock.pending.size, 0)
    h.dispose()
  }
})

test('draft previews hide uncompiled asset tokens, preserve quoted source words, and ignore an unrelated prompt draft', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  const draft = savedStoryboardDraft()
  draft.groups[1].candidate.video_prompt = '[[character:7]]沿原路径行动。'
  draft.groups[1].issues = [{ message: '未找到[[character:999]]，请补齐对应素材。' }]
  h.state.storyboardDraft = draft
  await h.vm.refresh()
  h.vm.panel.value = 'production'; h.vm.prodTab.value = 'videos'; h.vm.showStoryboardDraft.value = true
  const html = await h.render()
  assert.doesNotMatch(html, /\[\[character:/)
  assert.match(html, /episode\.sb\.draft\.unavailable/)
  assert.equal(h.vm.draftText('高大山说：「[[character:7]]是原文，不替换。」'), '高大山说：「[[character:7]]是原文，不替换。」')
  h.state.storyboardDraft = { ...draft, id: 'prompt-draft', mode: 'prompt' }
  await h.vm.loadStoryboardDraft()
  assert.equal(h.vm.storyboardDraft.value.id, 'draft-1')
  h.state.storyboardDraft = null
  await h.vm.loadStoryboardDraft()
  assert.equal(h.vm.storyboardDraft.value, null)
  assert.equal(h.vm.canContinueStoryboardDraft.value, false)
})

test('draft previews preserve all supported source quotes while apostrophes cannot hide uncompiled references', t => {
  const h = workbench()
  t.after(() => h.dispose())
  for (const [open, close] of [['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’'], ['"', '"'], ["'", "'"]]) {
    const source = `高大山说：${open}[[character:7]]是原文，不替换。${close}`
    assert.equal(h.vm.draftText(source), source, `Matched ${open}${close} protects the original source words`)
    assert.equal(h.vm.draftText(`${source} 画面出现[[prop:999]]。`), 'episode.sb.draft.unavailable', 'Uncompiled references outside a source quote remain hidden')
  }
  for (const prose of ["James' cup [[prop:999]]", "don't conceal [[character:7]]", "'tis a prop [[prop:999]]", "l'homme's view [[scene:10]]"]) {
    assert.equal(h.vm.draftText(prose), 'episode.sb.draft.unavailable')
  }
  const nested = '高大山说：「原词里保留『[[character:7]]』，不把它当素材。」'
  assert.equal(h.vm.draftText(nested), nested)
})

test('leaving a running breakdown disposes its draft and job observers without any cancellation or duplicate submission', async () => {
  for (const leave of ['route', 'unmount']) {
    const h = workbench()
    h.state.storyboardDraft = savedStoryboardDraft({ status: 'generating' })
    await h.vm.refresh()
    const generation = h.vm.doBreakdown()
    await settle()
    assert.equal(h.vm.rn.value, true)
    assert.ok(h.clock.pending.size >= 2, 'Both the durable job and the draft progress are being observed')
    if (leave === 'route') h.route.params.episodeNumber = '2'
    else h.dispose()
    await generation
    await settle()
    const reads = h.calls.length
    await h.clock.advance(6000)
    assert.equal(h.clock.pending.size, 0)
    assert.equal(h.calls.length, reads)
    assert.equal(h.state.jobRequests.length, 1)
    h.dispose()
  }
})

// Round 5 (2026-11-09, user-approved): Jimeng hand-off, 回传视频 buttons, 恢复视频 on 待核对 cards, force-new confirmation.
test('round 5: a handed-off Jimeng shot shows 已交即梦, offers 回传视频 (shot and episode) and keeps the old video playable', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  const shot = { id: 11, duration: 12, video_url: 'static/videos/old.mp4', video_prompt: '完整提示词' }
  h.state.storyboards = [shot]
  h.state.tasks.push({ id: 601, type: 'video', provider: 'jimeng_local', status: 'completed', stage: 'handed_off', storyboard_id: 11, updated_at: '2026-11-09T01:00:00Z',
    params: JSON.stringify({ jimengHandoff: { title: '1-01', nameStatus: 'completed', submitId: 's1', accountId: 'a', canvasId: '1' } }) })
  await h.vm.refresh()
  const activeShot = h.vm.sbs.value[0]
  h.vm.selectedSb.value = activeShot
  h.vm.panel.value = 'production'; h.vm.prodTab.value = 'videos'
  assert.equal(h.vm.videoTaskState(activeShot), 'handed_off')
  assert.equal(h.vm.videoTaskStatusLabel(activeShot), '已交即梦 · 待回传')
  assert.equal(h.vm.handedOffVideoCount.value, 1)
  assert.equal(h.vm.genTaskActiveCount.value, 0, 'a handed-off task is not counted as running')
  const html = await h.render()
  assert.match(html, /回传本集视频\(1\)/)
  assert.match(html, /回传视频/)
  assert.match(html, /新视频已交即梦，出片后可回传/)
  const returns = []
  h.apis.taskAPI.jimengReturn = async id => { returns.push(['task', id]); return { id, outcome: 'not_ready', message: '即梦还没有出片。' } }
  h.apis.episodeAPI.jimengReturn = async id => { returns.push(['episode', id]); return { results: [], total: 1, returning: 0, not_ready: 1, failed: 0, errors: 0 } }
  await h.vm.returnJimengVideo(activeShot)
  await h.vm.returnJimengEpisodeVideos()
  assert.deepEqual(returns, [['task', 601], ['episode', 2]])
  assert.ok(h.notices.some(([kind, text]) => kind === 'info' && /还没有出片/.test(text)))
  assert.ok(h.notices.some(([kind, text]) => kind === 'info' && /1 条还没出片/.test(text)))
})

test('round 5: batch video generation skips handed-off shots; a single regeneration asks first and sends force_new', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  h.state.storyboards = [{ id: 11, duration: 5, video_prompt: 'p1' }, { id: 12, duration: 5, video_prompt: 'p2' }]
  h.state.tasks.push({ id: 602, type: 'video', provider: 'jimeng_local', status: 'completed', stage: 'handed_off', storyboard_id: 11, updated_at: '2026-11-09T01:00:00Z' })
  await h.vm.refresh()
  h.vm.batchVideos()
  assert.deepEqual((h.vm.batchVideoConfirm.value.targets || []).map(sb => sb.id), [12], 'only the shot without a handed-off task')
})

test('round 5: a 待核对 card offers 恢复视频 first (query only), before 重新生成', async t => {
  const h = workbench()
  t.after(() => h.dispose())
  h.state.storyboards = [{ id: 11, duration: 5, video_prompt: 'p1' }]
  h.state.tasks.push({ id: 603, type: 'video', provider: 'jimeng_local', status: 'failed', stage: 'submission_unknown', error_code: 'submission_unknown',
    error_msg: '即梦提交结果待核对，原请求编号已保留。请恢复查询原任务，不要重复生成。', storyboard_id: 11, updated_at: '2026-11-09T01:00:00Z',
    params: JSON.stringify({ idempotencyKey: '7f3db819-8677-44ae-ac4b-ef44b62c1e6a' }) })
  await h.vm.refresh()
  h.vm.panel.value = 'production'; h.vm.prodTab.value = 'videos'
  assert.equal(h.vm.canRecoverVideo(11), true)
  const html = await h.render()
  const card = html.slice(html.indexOf('video-task-error'), html.indexOf('video-task-error') + 2000)
  const restore = card.indexOf('episode.recovery.restore'), regenerate = card.indexOf('episode.recovery.newGeneration')
  assert.ok(restore >= 0 && regenerate > restore, '恢复视频 appears before 重新生成 on the card')
})

test('manual asset redraw saves first and sends the literal prompt and explicit references with existing model parameters', async t => {
  const h = workbench(), requests = [], used = []
  t.after(() => h.dispose())
  await h.vm.refresh()
  h.vm.imageConfigs.value = [{ id: 91, provider: 'openai', model: ['test-image'], is_active: true }]
  h.vm.imageModel.value = '91/test-image'; h.vm.imageModelParameters.value = { quality: 'high' }
  h.vm.openAssetDetail('character', h.vm.chars.value[0])
  const literal = '  手工最终提示词\n不添加其他描述。  '
  h.vm.assetPromptDraft.value = literal; h.vm.assetPromptDirty.value = true
  h.vm.assetImageLibrary.value = { validateReferences: () => ['static/reference.png'], isUploading: () => false, hasUnsavedReferences: () => true, markReferencesUsed: values => used.push([...values]) }
  h.apis.characterAPI.update = async (id, body) => { requests.push(['save', id, clone(body)]); Object.assign(h.state.characters[0], body) }
  h.apis.characterAPI.generateImage = async (...args) => { requests.push(['generate', ...clone(args)]); h.state.tasks.push({ id: 902, type: 'image', character_id: 7, status: 'processing' }); return { image_generation_id: 902 } }
  await h.vm.redrawAssetImage()
  assert.equal(requests[0][0], 'save'); assert.equal(requests[0][2].final_prompt, literal)
  const sent = requests[1]
  assert.equal(sent[0], 'generate'); assert.equal(sent[1], 7); assert.equal(sent[2], 2); assert.equal(sent[3], 'test-image'); assert.equal(sent[4], 91)
  assert.deepEqual(sent[7], { quality: 'high' }); assert.equal(sent[9], false)
  assert.deepEqual(sent[10], { manual: true, prompt: literal, reference_images: ['static/reference.png'] })
  assert.deepEqual(used, [['static/reference.png']]); assert.equal(h.vm.isAssetImagePending('character', 7), true)
})

test('manual redraw does not generate when references are invalid or the preceding save fails', async t => {
  const h = workbench(); t.after(() => h.dispose()); await h.vm.refresh()
  h.vm.imageConfigs.value = [{ id: 91, provider: 'openai', model: ['test-image'], is_active: true }]
  h.vm.openAssetDetail('character', h.vm.chars.value[0])
  let saves = 0, generations = 0
  h.apis.characterAPI.update = async () => { saves++; throw Error('save failed') }
  h.apis.characterAPI.generateImage = async () => { generations++; return { image_generation_id: 900 } }
  h.vm.assetImageLibrary.value = { validateReferences: () => { throw Error('reference limit') }, isUploading: () => false }
  await h.vm.redrawAssetImage(); assert.equal(saves, 0); assert.equal(generations, 0)
  h.vm.assetImageLibrary.value = { validateReferences: () => [], isUploading: () => false }
  await h.vm.redrawAssetImage(); assert.equal(saves, 1); assert.equal(generations, 0)
  h.vm.assetPromptDraft.value = ' '; await h.vm.redrawAssetImage(); assert.equal(saves, 1)
})

test('late prompt generation cannot replace another asset editor and a save preserves newer manual edits', async t => {
  const h = workbench(); t.after(() => h.dispose()); await h.vm.refresh()
  let finishPrompt
  h.apis.characterAPI.generatePrompt = () => new Promise(resolve => { finishPrompt = resolve })
  h.vm.openAssetDetail('character', h.vm.chars.value[0])
  const generation = h.vm.genAssetFinalPrompt()
  h.vm.closeAssetDetail(); h.vm.openAssetDetail('scene', h.vm.scenes.value[0])
  finishPrompt({ final_prompt: 'late character prompt' }); await generation
  assert.equal(h.vm.assetDetail.value.type, 'scene'); assert.equal(h.vm.assetPromptDraft.value, 'ready')
  let finishSave
  h.apis.sceneAPI.update = () => new Promise(resolve => { finishSave = resolve })
  h.vm.assetPromptDraft.value = 'first'; h.vm.assetPromptDirty.value = true
  const saving = h.vm.saveAssetDetail()
  h.vm.onAssetPromptInput({ target: { value: 'newer manual text' } })
  finishSave({}); await saving
  assert.equal(h.vm.assetPromptDraft.value, 'newer manual text'); assert.equal(h.vm.assetPromptDirty.value, true)
})

test('manual redraw explicitly re-saves a retained prompt after the original appearance invalidation response', async t => {
  const h = workbench(), writes = []; t.after(() => h.dispose()); await h.vm.refresh()
  h.vm.openAssetDetail('character', h.vm.chars.value[0]); h.vm.assetDetailDraft.value.appearance = 'changed appearance'
  h.apis.characterAPI.update = async (_id, body) => { writes.push(clone(body)); return { final_prompt_cleared: writes.length === 1 } }
  assert.equal(await h.vm.saveAssetDetail({ forRedraw: true }), true)
  assert.equal(writes.length, 2); assert.deepEqual(writes[1], { final_prompt: 'ready' })
  assert.equal(h.vm.assetDetail.value.item.final_prompt, 'ready'); assert.equal(h.vm.assetPromptDraft.value, 'ready')
  h.apis.characterAPI.update = async () => ({ final_prompt_cleared: true })
  h.vm.assetDetailDraft.value.appearance = 'changed once more'
  assert.equal(await h.vm.saveAssetDetail(), true)
  assert.equal(h.vm.assetDetail.value.item.final_prompt, null); assert.equal(h.vm.assetPromptDraft.value, '')
})
