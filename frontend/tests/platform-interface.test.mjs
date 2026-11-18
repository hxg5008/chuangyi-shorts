import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'
import * as vue from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { renderToString } from '@vue/server-renderer'
import * as presentation from '../app/utils/activity-tasks.js'
import * as imageState from '../app/utils/image-task-state.js'
import * as productionPresentation from '../app/utils/production-presentation.js'
import * as assetImageJobs from '../app/utils/asset-image-jobs.js'
import {createPollingScope} from '../app/utils/polling-scope.js'

const source = path => readFileSync(new URL(`../app/${path}`, import.meta.url), 'utf8')
const js = value => ts.transpileModule(value, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const settle = () => new Promise(resolve => setImmediate(resolve))
const icon = { render: () => vue.h('svg') }
const icons = new Proxy({}, { get: () => icon })
function moduleFrom(path, modules, globals = {}) {
  const exports = {}
  runInNewContext(js(source(path)), { exports, require: name => { assert.ok(name in modules, `Unexpected module: ${name}`); return modules[name] }, ...globals })
  return exports
}
function component(path, modules, props = {}, globals = {}) {
  const { descriptor } = parse(source(path), { filename: path })
  const compiled = compileScript(descriptor, { id: path })
  const mounts = [], unmounts = [], warnings = [], emissions = []
  const scope = vue.effectScope()
  const vueModule = { ...vue, onMounted: fn => mounts.push(fn), onBeforeUnmount: fn => unmounts.push(fn) }
  const exports = {}, template = compileTemplate({ source: descriptor.template.content, filename: path, id: path, compilerOptions: { bindingMetadata: compiled.bindings } })
  assert.deepEqual(template.errors, [])
  runInNewContext(js(compiled.content), {
    exports, require(name) { if (name === 'vue') return vueModule; if (name === 'lucide-vue-next') return icons; if (['~/components/ProjectStyleSettings.vue','~/components/DocumentImportDialog.vue','~/components/AssetImageLibrary.vue','~/components/ModelProtocolPicker.vue','~/components/DocumentFileDrop.vue'].includes(name)) return { default: { render: () => null } };  if (name === 'vue-sonner') return { toast: new Proxy({}, { get: (_, key) => message => warnings.push([key, message]) }) }; assert.ok(name in modules, `Unexpected component dependency: ${name}`); return modules[name] },
    definePageMeta() {}, useRoute: () => ({ path: '/admin/channels', params: { id: '1' }, query: {} }),
    ref: vue.ref,computed: vue.computed,reactive: vue.reactive,watch: vue.watch,onMounted: fn=>mounts.push(fn),onBeforeUnmount: fn=>unmounts.push(fn),
    window: { addEventListener() {}, removeEventListener() {}, confirm: () => true }, document: { visibilityState: 'visible' },
    setInterval() { return 1 }, clearInterval() {}, setTimeout() { return 2 }, clearTimeout() {}, Date, console,
    ...globals,
  })
  const vm = scope.run(() => exports.default.setup(props, { expose() {}, emit: (...args) => emissions.push(args) }))
  const templateExports = {}
  runInNewContext(js(template.code), { exports: templateExports, require: () => vue })
  return { vm, warnings, mounts, emissions, async render(includeTeleports=false) {
    const app = vue.createSSRApp({ setup: () => vm, render: templateExports.render })
    app.component('NuxtLink', { props: ['to'], setup: (p, { slots }) => () => vue.h('a', { href: p.to }, slots.default?.()) })
    app.config.warnHandler = () => {}
    const context={},html=await renderToString(app,context)
    return includeTeleports?html+Object.values(context.teleports||{}).join(''):html
  }, dispose() { unmounts.forEach(fn => fn()); scope.stop() } }
}

function sessionHarness() {
  const storage = new Map(), redirects = [], events = [], requests = []
  let response = { code: 200, data: { user: { id: 2, username: 'creator', role: 'user' }, csrfToken: 'csrf-current' } }
  const session = moduleFrom('utils/platform-session.ts', { vue }, {
    fetch: async (url, opts) => { requests.push({ url, opts }); return { ok: true, status: 200, json: async () => response } },
    window: { location: { pathname: '/drama/8/episode/1', search: '', assign: value => redirects.push(value) }, dispatchEvent: value => events.push(value.type) },
    CustomEvent: class { constructor(type) { this.type = type } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  })
  return { ...session, storage, requests, events, redirects, respond: value => { response = value } }
}

test('account menu shows one full role badge and a clear account link without repeating the username', async t => {
  for (const role of ['admin', 'user']) {
    const h = component('components/PlatformAccountMenu.vue', {
      '~/utils/platform-session': { platformSession: { user: { id: 2, username: 'hidden-user-name', displayName: 'hidden-display-name', role } }, logoutPlatform: async () => {} },
      '~/composables/useToast': { toastError: () => {} },
    })
    t.after(() => h.dispose())
    const html = await h.render(), label = role === 'admin' ? '管理员' : '用户'
    assert.match(html, new RegExp(`account-role-badge[^>]*>${label}</span>`))
    assert.equal((html.match(new RegExp(label, 'g')) || []).length, 1)
    assert.match(html, /href="\/account"/)
    assert.match(html, />我的账户<\/span>/)
    assert.match(html, /aria-label="退出登录"/)
    assert.doesNotMatch(html, /hidden-user-name|hidden-display-name|account-avatar|account-label|我的账号/)
  }
})

test('compact account menu preserves logout and releases its pending state after completion or failure', async t => {
  const redirects = [], failures = []
  let complete, rejectLogout = false
  const h = component('components/PlatformAccountMenu.vue', {
    '~/utils/platform-session': { platformSession: { user: { id: 1, username: 'admin', role: 'admin' } }, logoutPlatform: async () => { if (rejectLogout) throw new Error('logout unavailable'); await new Promise(resolve => { complete = resolve }) } },
    '~/composables/useToast': { toastError: error => failures.push(error.message) },
  }, {}, { navigateTo: async (...args) => redirects.push(args) })
  t.after(() => h.dispose())
  const pending = h.vm.signOut()
  assert.equal(h.vm.busy.value, true)
  assert.match(await h.render(), /class="account-exit" disabled/)
  complete(); await pending
  assert.equal(redirects[0][0], '/login')
  assert.equal(redirects[0][1].replace, true)
  assert.equal(h.vm.busy.value, false)
  rejectLogout = true; await h.vm.signOut()
  assert.deepEqual(failures, ['logout unavailable'])
  assert.equal(h.vm.busy.value, false)
  assert.equal(redirects.length, 1)
})

test('session uses independent user cache namespaces and adds CSRF/project headers without storing credentials', async () => {
  const h = sessionHarness()
  await h.loginPlatform('creator', 'temporary-secret')
  assert.equal(h.platformSession.user.id, 2)
  assert.equal(h.requests[0].opts.credentials, 'same-origin')
  assert.equal(JSON.parse(h.requests[0].opts.body).password, 'temporary-secret')
  assert.equal(h.platformHeaders('POST')['X-CSRF-Token'], 'csrf-current')
  assert.equal(h.platformHeaders('GET')['X-CSRF-Token'], undefined)
  assert.equal(h.platformHeaders('POST')['X-Project-ID'], '8')
  h.userStorage.setItem('model', '22/gpt-model')
  h.applyPlatformSession({ user: { id: 3, username: 'second', role: 'user' }, csrfToken: 'second-csrf' })
  assert.equal(h.userStorage.getItem('model'), null)
  h.userStorage.setItem('model', '31/gpt-model')
  h.applyPlatformSession({ user: { id: 2, username: 'creator', role: 'user' }, csrfToken: 'csrf-current' })
  assert.equal(h.userStorage.getItem('model'), '22/gpt-model')
  assert.equal([...h.storage.keys()].length, 2)
  assert.doesNotMatch(JSON.stringify([...h.storage]), /temporary-secret|csrf-current/)
  assert.equal(h.safeNextPath('//evil.example'), '/')
  assert.equal(h.safeNextPath('/\\evil.example'), '/')
  assert.equal(h.safeNextPath('https://evil.example'), '/')
  assert.equal(h.safeNextPath('/drama/8'), '/drama/8')
  await h.logoutPlatform()
  assert.equal(h.platformSession.user, null)
  assert.equal(h.platformSession.csrfToken, '')
  assert.equal(h.userStorage.getItem('model'), null)
})

test('API sends authenticated mutations/uploads and discards late responses from the prior identity', async () => {
  const h = sessionHarness(); await h.loginPlatform('creator', 'temporary-secret')
  const requests = [], logs = []
  let answer = { code: 200, data: { ok: true } }, resolveLate
  const api = moduleFrom('composables/useApi.ts', { '~/utils/platform-session': h }, {
    fetch: async (url, opts) => { requests.push({ url, opts }); if (url.endsWith('/late')) return new Promise(resolve => { resolveLate = resolve }); return { ok: true, status: 200, json: async () => answer } },
    console: { debug: (...args) => logs.push(args), log: (...args) => logs.push(args) }, performance: { now: () => 0 }, FormData,
  })
  await api.channelAPI.create({ name: 'Private', base_url: 'http://service', api_key: 'private-api-secret' })
  assert.equal(requests[0].opts.headers['X-CSRF-Token'], 'csrf-current')
  assert.equal(requests[0].opts.headers['X-Project-ID'], '8')
  assert.doesNotMatch(JSON.stringify(logs), /private-api-secret/)
  await api.uploadAPI.image(new Blob(['image'], { type: 'image/png' }))
  assert.equal(requests[1].opts.credentials, 'same-origin')
  assert.equal(requests[1].opts.headers['X-CSRF-Token'], 'csrf-current')
  assert.equal(requests[1].opts.headers['Content-Type'], undefined)
  const late = api.api.get('/late')
  await settle()
  h.applyPlatformSession({ user: { id: 3, username: 'second', role: 'user' }, csrfToken: 'next' })
  resolveLate({ ok: true, status: 200, json: async () => ({ code: 200, data: { private: 'old-user-data' } }) })
  await assert.rejects(late, /登录身份已变化/)
  answer = { code: 401, message: 'Login required' }
  await assert.rejects(api.api.get('/dramas'), /Login required/)
  assert.equal(h.platformSession.user, null)
  assert.match(h.redirects[0], /^\/login\?next=/)
})

test('task presentation preserves actual timings/progress and does not fabricate token counts or reveal secrets', () => {
  assert.equal(presentation.activityElapsed({ status: 'queued', created_at: '2026-11-07T01:00:00Z' }, Date.parse('2026-11-07T01:01:01Z')), 61)
  assert.equal(presentation.activityElapsed({ status: 'completed', elapsed_seconds: 53 }), 53)
  assert.equal(presentation.activityElapsed({ status: 'completed', elapsed_seconds: null }), null)
  assert.equal(presentation.activityProgress(null), null)
  assert.equal(presentation.activityProgress('50'), null)
  assert.equal(presentation.activityProgress(102), null)
  assert.equal(presentation.activityProgress(50), 50)
  assert.equal(presentation.activityToken({}, ['input_tokens']), '未提供')
  assert.equal(presentation.activityToken({ input_tokens: 0 }, ['input_tokens']), '0')
  const safe = presentation.formatActivityValue({ api_key: 'private-secret', Authorization: 'Bearer hidden', nested: { cookie: 'cookie-value', image: 'data:image/png;base64,AAAA', text: 'Bearer another-secret' } })
  assert.doesNotMatch(safe, /private-secret|cookie-value|AAAA|another-secret/)
  assert.deepEqual(presentation.activityPublicEvents([{ kind: 'analysis' }, { kind: 'reasoning' }, { kind: 'public_output' }]), [{ kind: 'public_output' }])
})

test('model capability form changes only verified transport capabilities and rejects invalid bounds', t => {
  const props = vue.reactive({ modelValue: '{"max_images":4,"unknown_field":"preserved"}', type: 'video' })
  const h = component('components/ModelCapabilityFields.vue', {}, props)
  t.after(() => h.dispose())
  h.vm.set('durations', { target: { value: '5, 10, 10, 15' } }, 'numbers')
  let payload = JSON.parse(h.emissions.at(-1)[1])
  assert.deepEqual(payload.durations, [5, 10, 15])
  assert.equal(payload.unknown_field, 'preserved')
  props.modelValue = JSON.stringify(payload)
  h.vm.set('max_images', { target: { value: '' } }, 'number')
  payload = JSON.parse(h.emissions.at(-1)[1])
  assert.equal('max_images' in payload, false)
  const before = h.emissions.length
  h.vm.set('max_images', { target: { value: '-1' } }, 'number')
  assert.equal(h.emissions.length, before)
  assert.match(h.vm.error.value, /非负整数/)
})

test('actual task center loads text/image/video records, public rounds, guarded requests and server-provided progress', async t => {
  const requests = [], session = { user: { id: 2, role: 'user' } }
  const tasks = [{ id: 'text:1', kind: 'text', title: '提取角色', status: 'running', stage: 'streaming', model: 'gpt-model', elapsed_seconds: 33, progress: null }, { id: 'image:2', kind: 'image', title: '角色图片', status: 'completed', elapsed_seconds: 70 }, { id: 'video:3', kind: 'video', title: '分镜视频', status: 'running', progress: 49, elapsed_seconds: 100 }]
  const h = component('components/TaskCenter.vue', {
    '~/utils/platform-session': { platformSession: session }, '~/utils/activity-tasks.js': presentation,
    '~/composables/useApi': { activityAPI: { list: async query => { requests.push(['list', query]); return { items: tasks, total: 3, counts: { active: 2, completed: 1 } } }, detail: async id => { requests.push(['detail', id]); return { task: tasks.find(task => task.id === id), rounds: id === 'text:1' ? [{ number: 1, public_output: '这是模型的公开回复', input: { user: '提取本集角色' }, tool_calls: [{ name: 'save_characters', arguments: { name: '主角' } }], usage: {} }] : [], events: [{ id: 1, kind: 'submitted', message: '已提交请求' }, { id: 2, kind: 'analysis', message: 'must-not-appear' }], request: { user: '提取本集角色' }, result: id==='image:2'?{output_images:[{local_path:'static/images/one.png'},{local_path:'static/images/two.png'}]}:{api_key:'must-not-leak'} } }, eventsUrl: () => '/api/v1/activity/events' } },
  }, { dramaId: 8, embedded: true, closable: false })
  t.after(() => h.dispose())
  await h.vm.loadList()
  assert.equal(requests[0][1].drama_id, 8)
  assert.equal(h.vm.items.value.length, 3)
  assert.equal(h.vm.actualProgress.value, null)
  assert.equal(h.vm.outputText.value, '这是模型的公开回复')
  assert.equal(h.vm.events.value.length, 1)
  assert.equal(h.vm.toolCalls.value[0].name, 'save_characters')
  let html = await h.render()
  assert.match(html, /这是模型的公开回复/)
  assert.doesNotMatch(html, /must-not-appear|must-not-leak/)
  h.vm.activeTab.value = 'result'
  html = await h.render()
  assert.match(html, /未提供/)
  assert.doesNotMatch(html, /must-not-leak/)
  await h.vm.select('video:3')
  assert.equal(h.vm.actualProgress.value, 49)
  assert.match(await h.render(), /49%/)
  assert.equal(requests.filter(row => row[0] === 'detail').length, 2, 'details are loaded only when selected')
  await h.vm.select('image:2');h.vm.activeTab.value='result'
  const imageHtml=await h.render()
  assert.match(imageHtml,/static\/images\/one.png/);assert.match(imageHtml,/static\/images\/two.png/)
  assert.equal(requests.some(row => row[0] === 'generate'), false)
})

test('actual channel editor preserves vault keys, configures separate bindings and uses read-only connection/catalog calls', async t => {
  const calls = [], channels = [{ id: 7, name: 'Local GPT', base_url: 'http://192.168.1.10:6000', has_key: true, enabled: true, models: [] }]
  const api = { list: async () => ({ channels, protocols: [{ id: 'image.openai', type: 'image', name: 'Images',auth_fields:[{name:'client_secret',label:'客户端密钥',secret:true}] }] }), protocols: async () => [], update: async (id, body) => { calls.push(['update', id, body]); return { id } }, create: async body => { calls.push(['create', body]); return { id: 7 } }, createModel: async (id, body) => calls.push(['model', id, body]), catalog: async id => { calls.push(['catalog', id]); return { models: [{ id: 'image-upstream', type: 'image' }] } }, test: async id => { calls.push(['test', id]); return { ok: true, message: 'No inference submitted', inference_submitted: false } },importPlugin:async(file,preview)=>{calls.push(['plugin',file,preview]);return{plugin_id:'ui-plugin',name:'UI Plugin',providers:[],imported:!preview}} }
  const adminShell = { setup: (_, { slots }) => () => vue.h('main', slots.default?.()) }
  const h = component('pages/admin/channels.vue', { '~/components/PlatformAdminShell.vue': { default: adminShell }, '~/components/ModelCapabilityFields.vue': {}, '~/composables/useApi': { channelAPI: api, platformUserAPI: { list: async () => [{ id: 2, username: 'creator' }] } } })
  t.after(() => h.dispose())
  await h.vm.load()
  h.vm.editModel(null, { type: 'text' })
  assert.match(await h.render(), /只发送所选协议声明并适配的文字参数/)
  assert.match(await h.render(), /思考强度、温度与输出上限是否可调/)
  h.vm.modelForm.type = 'image'
  assert.match(await h.render(), /角色和场景的流程专用尺寸/)
  h.vm.modelForm.type = 'video'
  assert.match(await h.render(), /按所选协议的参数定义与映射发送视频参数/)
  assert.match(await h.render(), /分镜时长、项目画幅及请求显式值优先/)
  h.vm.protocols.value.push({ id: 'custom.ui-video', type: 'video', provider: 'custom_json', custom: true, name: 'UI custom JSON' })
  h.vm.modelForm.protocol_id = 'custom.ui-video'
  assert.match(await h.render(), /\{\{parameters\.xxx\}\}/, 'custom parameter example must render literally rather than evaluate as Vue code')
  assert.match(await h.render(), /保存其他字段不会自动生效/)
  h.vm.modelOpen.value = false
  h.vm.editChannel(channels[0])
  assert.equal(h.vm.channelForm.api_key, '')
  await h.vm.saveChannel()
  const update = calls.find(row => row[0] === 'update')[2]
  assert.equal('api_key' in update, false, 'a blank edit never erases a stored key')
  assert.equal('headers' in update, false, 'sensitive custom headers remain in the vault')
  h.vm.editChannel(channels[0]);h.vm.authProtocolId.value='image.openai';h.vm.authValues.client_secret='ui-private-secret';await h.vm.saveChannel()
  assert.equal(calls.filter(row=>row[0]==='update').at(-1)[2].auth_fields.client_secret,'ui-private-secret')
  assert.equal(Object.keys(h.vm.authValues).length,0,'closing the editor clears typed authentication values')
  h.vm.pluginFile.value={name:'provider.yingce-plugin'};await h.vm.importPlugin(true)
  assert.equal(h.vm.pluginPreview.value.imported,false)
  await h.vm.importPlugin(false)
  assert.deepEqual(calls.filter(row=>row[0]==='plugin').map(row=>row[2]),[true,false])
  h.vm.editModel(null, { type: 'image', model: 'image-upstream', name: '官方图片' })
  Object.assign(h.vm.modelForm, { protocol_id: 'image.openai', access: 'selected', allowed_user_ids: [2], capabilitiesText: '{"max_images":4}', defaultsText: '{"quality":"high"}' })
  await h.vm.saveModel()
  const binding = calls.find(row => row[0] === 'model')[2]
  assert.equal(binding.model, 'image-upstream')
  assert.equal(binding.protocol_id, 'image.openai')
  assert.deepEqual([...binding.allowed_user_ids], [2])
  assert.equal(binding.capabilities.max_images, 4)
  assert.equal(binding.defaults.quality, 'high')
  await h.vm.probe(); await h.vm.fetchCatalog()
  assert.deepEqual(calls.filter(row => ['test', 'catalog'].includes(row[0])).map(row => row[0]), ['test', 'catalog'])
  assert.equal(h.vm.catalog.value[0].id, 'image-upstream')
  assert.equal(h.vm.probeResult.value.inference_submitted, false)
})

test('actual user administrator creates credentials only in memory and disables without deleting project data', async t => {
  const calls = [], users = [{ id: 1, username: 'admin', role: 'admin', enabled: true }, { id: 2, username: 'creator', role: 'user', enabled: true }]
  const h = component('pages/admin/users.vue', { '~/components/PlatformAdminShell.vue': {}, '~/utils/platform-session': { platformSession: { user: users[0] } }, '~/composables/useApi': { platformUserAPI: { list: async () => users, create: async body => { calls.push(['create', body]); return { user: { username: body.username }, temporary_password: 'generated-once' } }, update: async (id, body) => calls.push(['update', id, body]), resetPassword: async id => { calls.push(['reset', id]); return { temporary_password: 'reset-once' } } } } })
  t.after(() => h.dispose())
  await h.vm.load()
  Object.assign(h.vm.form, { username: 'new_creator', display_name: '同事', password: '' })
  await h.vm.create()
  assert.equal(h.vm.credential.value.password, 'generated-once')
  assert.equal(h.vm.form.password, '')
  await h.vm.toggle(users[1])
  assert.equal(calls.find(row => row[0] === 'update')[1], 2)
  assert.equal(calls.find(row => row[0] === 'update')[2].enabled, false)
  await h.vm.reset(users[1])
  assert.equal(h.vm.credential.value.password, 'reset-once')
  assert.equal(calls.some(row => row[0] === 'delete'), false)
})

test('task SSE resumes from its cursor, falls back to read-only polling and releases every connection on unmount', async t => {
  const sources = [], timers = new Map(), intervals = new Map(), requests = []
  let next = 1
  class LocalEventSource { constructor(url) { this.url = url; this.closed = false; sources.push(this) } close() { this.closed = true } }
  const h = component('components/TaskCenter.vue', {
    '~/utils/platform-session': { platformSession: { user: { id: 2, role: 'user' } } }, '~/utils/activity-tasks.js': presentation,
    '~/composables/useApi': { activityAPI: { list: async query => { requests.push(query); return { items: [], total: 0, counts: {} } }, detail: async () => ({}), eventsUrl: query => '/api/v1/activity/events?after=' + query.after } },
  }, { dramaId: 8 }, { EventSource: LocalEventSource, setTimeout: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id }, clearTimeout: id => timers.delete(id), setInterval: (fn, ms) => { const id = next++; intervals.set(id, { fn, ms }); return id }, clearInterval: id => intervals.delete(id) })
  t.after(() => h.dispose())
  h.vm.connect()
  sources[0].onopen()
  assert.equal(h.vm.connection.value, 'live')
  sources[0].onmessage({ lastEventId: 'cursor-71', data: '{"task_id":"text:1","id":"cursor-71","kind":"public_output"}' })
  const debounce = [...timers.values()].find(timer => timer.ms === 650)
  debounce.fn(); await settle()
  assert.equal(requests.length, 1)
  sources[0].onerror()
  assert.equal(sources[0].closed, true)
  assert.equal(h.vm.connection.value, 'polling')
  const polling = [...intervals.values()].find(timer => timer.ms === 5000)
  assert.ok(polling)
  polling.fn(); await settle()
  assert.equal(requests.length, 2)
  const reconnect = [...timers.values()].find(timer => timer.ms === 15000)
  reconnect.fn()
  assert.match(sources[1].url, /cursor-71/)
  h.dispose()
  assert.equal(sources[1].closed, true)
  assert.equal(intervals.size, 0)
  polling.fn(); await settle()
  assert.equal(requests.length, 2, 'stale callbacks cannot generate or read after disposal')
})

test('global route guard redirects unauthenticated users and blocks ordinary users from settings and admin routes', async () => {
  let user = null
  const redirects = []
  const guard = moduleFrom('middleware/platform-auth.global.ts', { '~/utils/platform-session': { loadPlatformSession: async () => user, safeNextPath: value => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/' } }, { defineNuxtRouteMiddleware: fn => fn, navigateTo: value => { redirects.push(value); return value } }).default
  await guard({path:'/register',fullPath:'/register',query:{}})
  assert.equal(redirects.length,0,'self-registration is public while admin remains protected')
  await guard({ path: '/drama/8', fullPath: '/drama/8' })
  assert.match(redirects.pop(), /^\/login\?next=/)
  user = { id: 2, role: 'user' }
  await guard({ path: '/settings', fullPath: '/settings' })
  assert.equal(redirects.pop(), '/')
  await guard({ path: '/admin/channels', fullPath: '/admin/channels' })
  assert.equal(redirects.pop(), '/')
  await guard({ path: '/drama/8', fullPath: '/drama/8' })
  assert.equal(redirects.length, 0)
  user = { id: 1, role: 'admin' }
  await guard({ path: '/admin/channels', fullPath: '/admin/channels' })
  assert.equal(redirects.length, 0)
})

test('registration session helper preserves short/long passwords verbatim and establishes the returned ordinary-user session', async()=>{
  const h=sessionHarness(),username='长'.repeat(100),password='  '+('密'.repeat(400))+'  '
  h.respond({code:200,data:{user:{id:77,username,role:'user'},csrfToken:'registered-csrf'}})
  await h.registerPlatform('  '+username+'  ',password)
  assert.equal(h.requests.at(-1).url,'/api/v1/auth/register')
  const body=JSON.parse(h.requests.at(-1).opts.body)
  assert.equal(body.username,username);assert.equal(body.password,password)
  assert.equal(h.platformSession.user.role,'user');assert.equal(h.platformSession.csrfToken,'registered-csrf')
  h.respond({code:200,data:{user:{id:78,username:'甲',role:'user'},csrfToken:'short-csrf'}})
  await h.registerPlatform('甲','1')
  assert.equal(JSON.parse(h.requests.at(-1).opts.body).password,'1')
  assert.equal(h.safeNextPath('/register?next=/admin'),'/')
})

test('actual registration form accepts one-character and long names/passwords, checks repetition and never renders server bootstrap hints',async t=>{
  const calls=[],navigations=[],session={registerPlatform:async(...args)=>calls.push(args),safeNextPath:value=>value||'/'}
  const h=component('pages/register.vue',{'~/utils/platform-session':session,'~/assets/brand-logo.png':{default:'brand.png'}},{},{navigateTo:async target=>navigations.push(target)})
  t.after(()=>h.dispose())
  const html=await h.render()
  assert.doesNotMatch(html,/minlength=|maxlength=|admin-initial-password|data\/|管理员分配/)
  h.vm.username.value='甲';h.vm.password.value='1';h.vm.confirm.value='1';await h.vm.submit()
  assert.deepEqual(calls[0],['甲','1']);assert.equal(navigations[0],'/');assert.equal(h.vm.password.value,'')
  const username='长用户'.repeat(80),password='  '+('p'.repeat(400))+'  '
  h.vm.username.value=' '+username+' ';h.vm.password.value=password;h.vm.confirm.value=password;await h.vm.submit()
  assert.deepEqual(calls[1],[username,password])
  h.vm.username.value='乙';h.vm.password.value='x';h.vm.confirm.value='y';await h.vm.submit()
  assert.equal(calls.length,2);assert.match(h.vm.error.value,/不一致/)
  h.vm.username.value='  ';h.vm.password.value='z';h.vm.confirm.value='z';await h.vm.submit()
  assert.equal(calls.length,2);assert.match(h.vm.error.value,/请输入用户名和密码/)
})

test('login recheck reports a healthy unauthenticated service as status and the page exposes registration without bootstrap file paths',async t=>{
  const calls=[],h=component('pages/login.vue',{'~/utils/platform-session':{loadPlatformSession:async()=>null,loginPlatform:async(...args)=>calls.push(args),safeNextPath:value=>value||'/'},'~/assets/brand-logo.png':{default:'brand.png'}},{},{navigateTo:async()=>{}})
  t.after(()=>h.dispose());await h.vm.recheck()
  assert.equal(h.vm.error.value,'');assert.match(h.vm.status.value,/服务已连接/)
  const html=await h.render();assert.match(html,/role="status"/);assert.match(html,/立即注册/)
  assert.doesNotMatch(html,/admin-initial-password|服务器.*初始密码|管理员分配|账号由管理员开通|minlength=|maxlength=/)
  const password='  '+('l'.repeat(400))+'  ';h.vm.username.value='长'.repeat(90);h.vm.password.value=password;await h.vm.submit()
  assert.equal(calls[0][1],password)
})

test('administrator account form changes to a one-character password and never enforces username/password lengths',async t=>{
  const calls=[],username='管理员长名'.repeat(60),h=component('pages/account.vue',{'~/utils/platform-session':{platformSession:{user:{id:1,username,role:'admin'}},changePlatformPassword:async(...args)=>calls.push(args)}})
  t.after(()=>h.dispose())
  assert.doesNotMatch(await h.render(),/minlength=|maxlength=|至少 10/)
  h.vm.current.value='original';h.vm.password.value='1';h.vm.confirm.value='1';await h.vm.save()
  assert.deepEqual(calls[0],['original','1'])
  assert.equal(h.vm.current.value,'');assert.equal(h.vm.password.value,'')
  h.vm.current.value='1';h.vm.password.value=' ';h.vm.confirm.value=' ';await h.vm.save()
  assert.deepEqual(calls[1],['1',' '],'a password is not trimmed by the client')
})

test('administrator create-user form sends long usernames with no optional display-name truncation and preserves short passwords',async t=>{
  const calls=[],username='新用户名'.repeat(80),h=component('pages/admin/users.vue',{'~/components/PlatformAdminShell.vue':{},'~/utils/platform-session':{platformSession:{user:{id:1,role:'admin'}}},'~/composables/useApi':{platformUserAPI:{list:async()=>[],create:async body=>{calls.push(body);return{user:{username:body.username}}}}}})
  t.after(()=>h.dispose());Object.assign(h.vm.form,{username,display_name:'',password:'x'});await h.vm.create()
  assert.equal(calls[0].username,username);assert.equal(calls[0].password,'x');assert.equal('display_name'in calls[0],false)
  assert.doesNotMatch(source('pages/admin/users.vue'),/minlength="\d+"|用户名<input[^>]*maxlength=/)
})

test('successful channel/model deletion removes list entries and a later reload cannot restore them as merely disabled rows',async t=>{
  let rows=[{id:7,name:'Delete channel',enabled:true,models:[{id:8,name:'Delete model',model:'example',type:'image',enabled:true}]}]
  const calls=[],h=component('pages/admin/channels.vue',{'~/components/PlatformAdminShell.vue':{},'~/components/ModelCapabilityFields.vue':{},'~/composables/useApi':{platformUserAPI:{list:async()=>[]},channelAPI:{list:async()=>({channels:structuredClone(rows),protocols:[]}),removeModel:async(channelId,modelId)=>{calls.push(['model',channelId,modelId]);rows=rows.map(row=>({...row,models:row.models.filter(model=>model.id!==modelId)}))},remove:async id=>{calls.push(['channel',id]);rows=rows.filter(row=>row.id!==id)}}}})
  t.after(()=>h.dispose());await h.vm.load();await h.vm.removeModel(h.vm.selectedModels.value[0])
  assert.equal(h.vm.selectedModels.value.length,0);await h.vm.load();assert.equal(h.vm.selectedModels.value.length,0)
  await h.vm.removeChannel();assert.equal(h.vm.channels.value.length,0);await h.vm.load();assert.equal(h.vm.channels.value.length,0)
  assert.deepEqual(calls,[['model',7,8],['channel',7]])
})

test('task center follows newest live round, pins manual selection, merges public deltas/tools and exports the complete server record', async t=>{
  let roundCount=2
  const calls=[],rounds=[{id:'round-1',number:1,status:'completed',public_text:'第一轮公开回复',public_output:{tool_calls:[{id:'tool-1',name:'save_assets',arguments:{count:3}}]}},{id:'round-2',number:2,status:'running',public_text:'第二轮实时文字',usage:{}}]
  const h=component('components/TaskCenter.vue',{'~/utils/platform-session':{platformSession:{user:{id:2,role:'user'}}},'~/utils/activity-tasks.js':presentation,'~/composables/useApi':{activityAPI:{list:async()=>({items:[{id:'live',kind:'text',status:'running'}],total:1,counts:{active:1}}),detail:async()=>({task:{id:'live',kind:'text',status:'running'},rounds:rounds.slice(0,roundCount),events:[{id:500,round_id:'round-2',kind:'submitted',message:'已提交'}],events_page:{total:501,has_more:true},usage:{input_tokens:8}}),events:async(id,query)=>{calls.push(['events',id,query]);return{items:[{id:1,kind:'started',message:'开始'}]}},export:async id=>{calls.push(['export',id]);return new Blob(['complete 1201 events'])},eventsUrl:()=>'/events'}}},{},{URL:{createObjectURL:blob=>{calls.push(['blob',blob]);return'blob:test'},revokeObjectURL(){}},document:{visibilityState:'visible',createElement:()=>({click:()=>calls.push(['download'])})}})
  t.after(()=>h.dispose())
  await h.vm.loadList()
  assert.equal(h.vm.roundIndex.value,1)
  assert.equal(h.vm.outputText.value,'第二轮实时文字')
  assert.equal(h.vm.usage.value.input_tokens,8,'empty round usage falls back to real task aggregate')
  h.vm.selectRound(0)
  assert.equal(h.vm.toolCalls.value[0].name,'save_assets')
  rounds.push({id:'round-3',number:3,status:'running',public_text:''});roundCount=3
  await h.vm.loadDetail()
  assert.equal(h.vm.roundIndex.value,0,'refresh cannot replace a manually chosen historical round')
  h.vm.followLatest.value=true;await vue.nextTick()
  assert.equal(h.vm.roundIndex.value,2)
  h.vm.liveEvents.value=[{id:501,kind:'public_delta',round_id:'round-3',payload:{text:'增量A'}},{id:502,kind:'public_delta',round_id:'round-3',payload:{text:'增量B'}},{id:503,kind:'tool_call',round_id:'round-3',payload:{id:'tool-3',name:'save_script',arguments:{}}}]
  assert.equal(h.vm.outputText.value,'增量A增量B')
  assert.equal(h.vm.toolCalls.value[0].name,'save_script')
  await h.vm.loadEarlier()
  assert.equal(h.vm.events.value[0].id,1)
  await h.vm.downloadDetail()
  assert.deepEqual(calls.find(row=>row[0]==='export'),['export','live'])
  assert.equal(await calls.find(row=>row[0]==='blob')[1].text(),'complete 1201 events')
})

test('independent model playground requires an explicit send and submits uploaded references and declared parameters to the actual API client', async t=>{
  const calls=[],configs=[{id:11,service_type:'text',provider:'openai',is_active:true,model:['mock-text'],parameters:[{key:'temperature',type:'number',default:0.4}]},{id:12,service_type:'image',provider:'openai',is_active:true,model:['mock-image'],parameters:[{key:'quality',type:'select',options:['high','low'],default:'high'}]}]
  const parameters=await import('../app/utils/model-parameters.js')
  const h=component('pages/admin/playground.vue',{'~/components/PlatformAdminShell.vue':{},'~/components/ModelParameterFields.vue':{},'~/components/TaskCenter.vue':{},'~/utils/model-parameters.js':parameters,'~/composables/useApi':{aiConfigAPI:{list:async()=>configs},uploadAPI:{image:async file=>{calls.push(['upload',file.name]);return{path:'static/uploads/reference.png'}}},modelTestAPI:{create:async body=>{calls.push(['send',body]);return{id:'test-1',activity_task_id:'test-1',status:'running'}},get:async()=>({id:'test-1',status:'completed',result:{local_path:'static/images/result.png',output_images:[{local_path:'static/images/result.png'},{local_path:'static/images/result-two.png'}]},elapsed_seconds:9})}}})
  t.after(()=>h.dispose())
  await h.vm.loadModels();await vue.nextTick()
  assert.equal(calls.length,0,'loading models never submits a generated test')
  h.vm.kind.value='image';await vue.nextTick();h.vm.prompt.value='原封不动的测试提示词'
  await h.vm.uploadFiles({target:{files:[{name:'reference.png',type:'image/png'}],value:'reference.png'}})
  await h.vm.send()
  const body=calls.find(row=>row[0]==='send')[1]
  assert.equal(body.config_id,12)
  assert.equal(body.kind,'image')
  assert.equal(body.prompt,'原封不动的测试提示词')
  assert.equal(body.parameters.quality,'high')
  assert.deepEqual([...body.reference_images],['static/uploads/reference.png'])
  assert.equal(h.vm.selectedRecord.value.status,'completed')
  assert.equal(h.vm.resultUrl.value,'/static/images/result.png')
  assert.equal(h.vm.outputMedia.value.length,2)
  h.vm.selectedOutputIndex.value=1
  assert.equal(h.vm.resultUrl.value,'/static/images/result-two.png')
})

test('project material creation submits the authorized selected image and text bindings with their own parameters', async t=>{
  const calls=[],parameters=await import('../app/utils/model-parameters.js')
  const imageApi={generateImage:async(...args)=>{calls.push(args);return{image_generation_id:50}}}
  const h=component('views/drama/detail.vue',{'vue-i18n':{useI18n:()=>({t:key=>key,locale:vue.ref('zh')})},'~/composables/useToast':{toastError:failure=>{throw failure}},'~/composables/useApi':{dramaAPI:{},episodeAPI:{},characterAPI:imageApi,sceneAPI:imageApi,propAPI:imageApi,uploadAPI:{},aiConfigAPI:{},taskAPI:{list:async()=>[]},assetImageJobAPI:{list:async()=>({items:[]})}},'~/components/BaseSelect.vue':{},'~/components/ModelSelect.vue':{},'~/components/ModelParameterFields.vue':{},'~/components/TaskCenterLauncher.vue':{},'~/components/ProductionBatchDialog.vue':{},'~/utils/production-presentation.js':productionPresentation,'~/utils/model-parameters.js':parameters,'~/utils/image-task-state.js':imageState,'~/utils/asset-image-jobs.js':assetImageJobs,'~/utils/polling-scope.js':{createPollingScope}})
  t.after(()=>h.dispose())
  h.vm.drama.value={id:1,episodes:[{id:2,image_config_id:41}],characters:[],scenes:[],props:[]}
  h.vm.assetImageConfigs.value=[{id:41,provider:'openai',model:['image-a'],is_active:true},{id:42,provider:'openai',model:['image-b'],is_active:true,parameters:[{key:'quality',type:'select',default:'high'}]}]
  h.vm.assetTextConfigs.value=[{id:19,provider:'openai',model:['text-a'],is_active:true,parameters:[{key:'temperature',type:'number',default:0.3}]}]
  h.vm.assetImageModel.value='42/image-b';await vue.nextTick()
  await h.vm.generateMaterial({id:9,name:'主角',kind:'角色',kindKey:'character'})
  assert.equal(calls[0][2],'image-b');assert.equal(calls[0][3],42)
  assert.equal(calls[0][4],'text-a');assert.equal(calls[0][5],19)
  assert.equal(calls[0][6].quality,'high');assert.equal(calls[0][7].temperature,0.3)
})

test('project material preparation restores from one project snapshot, releases interruption and coalesces overlapping reads',async t=>{
  const parameters=await import('../app/utils/model-parameters.js'),notices=[]
  let jobs=[{id:'project-prepare',asset_kind:'character',asset_id:9,status:'preparing_prompt',active:true,created_at:new Date().toISOString()}],reads=0,release
  const jobApi={list:async()=>{reads++;return{items:structuredClone(jobs)}}}
  const h=component('views/drama/detail.vue',{'vue-i18n':{useI18n:()=>({t:key=>key,locale:vue.ref('zh')})},'~/composables/useToast':{toastError:message=>notices.push(message)},'~/composables/useApi':{dramaAPI:{},episodeAPI:{},characterAPI:{},sceneAPI:{},propAPI:{},uploadAPI:{},aiConfigAPI:{},taskAPI:{list:async()=>[]},assetImageJobAPI:jobApi},'~/components/BaseSelect.vue':{},'~/components/ModelSelect.vue':{},'~/components/ModelParameterFields.vue':{},'~/components/TaskCenterLauncher.vue':{},'~/components/ProductionBatchDialog.vue':{},'~/utils/production-presentation.js':productionPresentation,'~/utils/model-parameters.js':parameters,'~/utils/image-task-state.js':imageState,'~/utils/asset-image-jobs.js':assetImageJobs,'~/utils/polling-scope.js':{createPollingScope}})
  t.after(()=>h.dispose());h.vm.drama.value={id:1,episodes:[{id:2}],characters:[{id:9,name:'主角'}],scenes:[],props:[]}
  await h.vm.syncMaterialJobs()
  assert.equal(h.vm.isPending({id:9,kindKey:'character'}),true)
  assert.match(h.vm.materialPendingLabel({id:9,kindKey:'character'}),/准备提示词.*秒/)
  jobs[0]={...jobs[0],status:'interrupted',active:false,error_code:'preparation_interrupted',error:'后台重启，未重发'}
  await h.vm.syncMaterialJobs()
  assert.equal(h.vm.isPending({id:9,kindKey:'character'}),false);assert.equal(h.vm.materialJobErrors.value.length,1)
  assert.equal(notices.at(-1),'后台重启，未重发')
  const before=reads;jobApi.list=async()=>{reads++;return new Promise(resolve=>{release=resolve})}
  const first=h.vm.syncMaterialJobs(),second=h.vm.syncMaterialJobs();await settle();assert.equal(reads,before+1)
  release({items:[]});await Promise.all([first,second])
})

test('project dialogs lock the actual project scroller across nested image previews and restore position, focus and overflow only when the last dialog closes', async t => {
  const parameters=await import('../app/utils/model-parameters.js'),focused=[]
  const scroller=()=>vue.markRaw({style:{overflow:'auto'},scrollTop:2400,scrollLeft:0})
  const project=scroller(),body=scroller(),documentElement=scroller()
  const opener={focus:()=>focused.push('opener')}
  const doc={activeElement:opener,body,documentElement,querySelector:selector=>({focus:()=>focused.push(selector)})}
  const h=component('views/drama/detail.vue',{'vue-i18n':{useI18n:()=>({t:key=>key,locale:vue.ref('zh')})},'~/composables/useToast':{toastError:()=>{}},'~/composables/useApi':{dramaAPI:{},episodeAPI:{},characterAPI:{},sceneAPI:{},propAPI:{},uploadAPI:{},aiConfigAPI:{},taskAPI:{list:async()=>[]},assetImageJobAPI:{list:async()=>({items:[]})}},'~/components/BaseSelect.vue':{},'~/components/ModelSelect.vue':{},'~/components/ModelParameterFields.vue':{},'~/components/TaskCenterLauncher.vue':{},'~/components/ProductionBatchDialog.vue':{},'~/utils/production-presentation.js':productionPresentation,'~/utils/model-parameters.js':parameters,'~/utils/image-task-state.js':imageState,'~/utils/asset-image-jobs.js':assetImageJobs,'~/utils/polling-scope.js':{createPollingScope}}, {}, {document:doc,nextTick:vue.nextTick})
  t.after(()=>h.dispose());h.vm.pageRoot.value=project
  const prop={id:19,kindKey:'prop',kind:'道具',name:'预览测试',image_url:'/synthetic.png'}
  h.vm.openEdit(prop);await vue.nextTick();await settle()
  assert.equal(h.vm.viewportDialog.value,'.mat-detail-dialog');assert.equal(project.style.overflow,'hidden');assert.equal(body.style.overflow,'hidden')
  h.vm.openAssetViewer(prop);await vue.nextTick();await settle()
  assert.equal(h.vm.viewportDialog.value,'.viewer-dialog');assert.equal(focused.at(-1),'.viewer-dialog')
  h.vm.closeAssetViewer();await vue.nextTick();await settle()
  assert.equal(h.vm.viewportDialog.value,'.mat-detail-dialog');assert.equal(project.style.overflow,'hidden','closing a nested preview must not unlock its editor background')
  project.scrollTop=1800
  h.vm.closeEdit();await vue.nextTick();await settle()
  assert.equal(project.style.overflow,'auto');assert.equal(project.scrollTop,2400);assert.equal(focused.at(-1),'opener')
  h.vm.openAssetViewer(prop);await vue.nextTick();await settle()
  assert.equal(h.vm.viewportDialog.value,'.viewer-dialog');assert.equal(project.style.overflow,'hidden','a standalone image preview must also acquire the scroll lock')
  h.vm.closeAssetViewer();await vue.nextTick();await settle();assert.equal(project.style.overflow,'auto')
  h.vm.assetModelParametersOpen.value=true;await vue.nextTick();await settle()
  assert.equal(project.style.overflow,'hidden')
  h.dispose();assert.equal(project.style.overflow,'auto');assert.equal(body.style.overflow,'auto')
})

test('dynamic parameter widgets keep typed values, normalize supported aliases and never expose reserved transport bindings', async t=>{
  const parameters=await import('../app/utils/model-parameters.js'),config={parameters:[{key:'secret_rename',binding:'headers.authorization',type:'string'},{key:'fps',type:'integer',label:'帧率',min:1,max:60,default:24},{key:'files',type:'string[]',label:'文件列表'},{key:'aspectRatio',type:'string',label:'比例',options:['16:9','9:16']},{key:'watermark',type:'boolean',label:'水印'}],defaults:{aspect_ratio:'9:16',unsupported:7}}
  const initial=parameters.initialModelParameters(config)
  assert.equal(initial.aspectRatio,'9:16');assert.equal(initial.unsupported,undefined);assert.equal(initial.fps,24)
  assert.equal(parameters.parameterDefinitions(config).some(field=>field.key==='secret_rename'),false)
  const h=component('components/ModelParameterFields.vue',{'~/utils/model-parameters.js':parameters},{config,modelValue:initial,omit:[]});t.after(()=>h.dispose())
  assert.match(await h.render(),/textarea/)
  h.vm.setJson({key:'files',label:'文件列表'},'["one","two"]')
  assert.deepEqual([...h.emissions.at(-1)[1].files],['one','two'])
  const before=h.emissions.length;h.vm.set({key:'fps',label:'帧率',min:1,max:60},120)
  assert.equal(h.emissions.length,before);assert.match(h.vm.error.value,/超出允许范围/)
})

test('task cancellation is capability-gated, explicitly confirmed and remains running until upstream confirms the terminal state', async t=>{
  const requests=[];let allow=false,stage='generating',available=true,sourceType='media'
  const task=()=>({id:'cancel-log',kind:'video',status:stage==='cancelled'?'failed':'running',stage,source_ref:{type:sourceType,id:'82'},result:{cancel_available:available}})
  const h=component('components/TaskCenter.vue',{'~/utils/platform-session':{platformSession:{user:{id:2,role:'user'}}},'~/utils/activity-tasks.js':presentation,'~/composables/useApi':{taskAPI:{cancel:async id=>{requests.push(id);stage='cancelling';return{requested:true}}},activityAPI:{list:async()=>({items:[task()],total:1,counts:{active:1}}),detail:async()=>({task:task(),rounds:[],events:[]}),eventsUrl:()=>'/events'}}},{},{window:{confirm:()=>allow}})
  t.after(()=>h.dispose())
  await h.vm.loadList()
  assert.equal(h.vm.canRequestCancel.value,true)
  assert.match(await h.render(),/请求取消/)
  await h.vm.requestCancel();assert.equal(requests.length,0,'declining confirmation must not request cancellation')
  allow=true;await h.vm.requestCancel()
  assert.deepEqual(requests,['82']);assert.equal(h.vm.selectedTask.value.status,'running')
  assert.equal(h.vm.selectedTask.value.stage,'cancelling')
  assert.match(await h.render(),/已请求取消，等待上游确认/)
  await h.vm.requestCancel();assert.equal(requests.length,1,'pending cancellation is not repeatedly submitted')
  stage='cancelled';available=false;await h.vm.loadDetail()
  assert.equal(h.vm.canRequestCancel.value,false);assert.match(await h.render(),/已停止/)
  stage='generating';available=true;sourceType='model-test';await h.vm.loadDetail()
  assert.equal(h.vm.canRequestCancel.value,false,'an unsupported source never gets an invented cancellation endpoint')
})

test('model playground explains whole-response protocols and does not apply that notice to real streaming models', async t=>{
  const parameters=await import('../app/utils/model-parameters.js'),shell={setup:(_, {slots})=>()=>vue.h('main',slots.default?.())}
  const h=component('pages/admin/playground.vue',{'~/components/PlatformAdminShell.vue':{default:shell},'~/components/ModelParameterFields.vue':{},'~/components/TaskCenter.vue':{},'~/utils/model-parameters.js':parameters,'~/composables/useApi':{aiConfigAPI:{list:async()=>[{id:11,service_type:'text',provider:'yingce',is_active:true,model:['whole-response'],capabilities:{streaming_mode:'final_response'}}]},modelTestAPI:{},uploadAPI:{}}})
  t.after(()=>h.dispose());await h.vm.loadModels();await vue.nextTick()
  assert.match(await h.render(),/当前所选协议按整轮返回；完成后显示公开内容/)
  h.vm.models.value[0].capabilities.streaming_mode='stream'
  assert.doesNotMatch(await h.render(),/当前所选协议按整轮返回/)
})

test('replayed notifications from older tasks cannot starve the currently running task public output', async t=>{
  const timers=[],reads=[]
  const h=component('components/TaskCenter.vue',{'~/utils/platform-session':{platformSession:{user:{id:2,role:'user'}}},'~/utils/activity-tasks.js':presentation,'~/composables/useApi':{activityAPI:{list:async()=>({items:[],total:0,counts:{}}),detail:async id=>{reads.push(id);return{task:{id,kind:'text',status:'running'},rounds:[{public_text:'新任务公开输出已经到达',status:'running'}],events:[]}},eventsUrl:()=>'/events'}}},{},{setTimeout:(callback,delay)=>{timers.push({callback,delay});return timers.length}})
  t.after(()=>h.dispose())
  h.vm.selectedId.value='current-live'
  h.vm.detail.value={task:{id:'current-live',kind:'text',status:'running'},rounds:[{public_text:'',status:'running'}],events:[]}
  h.vm.scheduleRefresh({task_id:'older-history',kind:'public_delta',id:700})
  timers.find(timer=>timer.delay===650).callback();await settle()
  assert.deepEqual(reads,['current-live'])
  assert.equal(h.vm.outputText.value,'新任务公开输出已经到达')
})

test('batch extraction keeps the original script-or-content input priority, selects only available episodes and submits one immutable explicitly confirmed model snapshot',async t=>{
  const parameters=await import('../app/utils/model-parameters.js'),requests=[];let complete
  const h=component('components/ProductionBatchDialog.vue',{'~/composables/useApi':{aiConfigAPI:{list:async()=>[{id:71,model:['text-test'],provider:'openai',is_active:true,parameters:[{key:'temperature',type:'number',default:0.4}]}]},productionAPI:{createBatch:async body=>{requests.push(body);return new Promise(resolve=>{complete=resolve})}}},'./ModelSelect.vue':{},'./ModelParameterFields.vue':{},'~/utils/model-parameters.js':parameters,'~/utils/production-presentation.js':productionPresentation},{dramaId:3,episodes:[{id:1,episode_number:1,script_content:'剧本'},{id:2,episode_number:2,content:'原始剧本'},{id:4,episode_number:4,content:'  '}],initialSelection:[1,2,4]})
  t.after(()=>h.dispose());await h.vm.loadModels();await vue.nextTick()
  assert.deepEqual([...h.vm.selected.value],[1,2]);assert.equal(h.vm.eligible.value.length,2)
  assert.match(await h.render(true),/使用原始内容/)
  assert.equal(requests.length,0,'Opening the dialog never submits extraction')
  h.vm.targets.value=['props','characters'];h.vm.concurrency.value=4
  const first=h.vm.submit();await h.vm.submit()
  assert.equal(requests.length,1);assert.equal(h.vm.busy.value,true)
  h.vm.parameters.value.temperature=0.9
  assert.deepEqual([...requests[0].targets],['characters','props']);assert.deepEqual([...requests[0].episode_ids],[1,2])
  assert.equal(requests[0].concurrency,4);assert.equal(requests[0].config_id,71);assert.equal(requests[0].model_parameters.temperature,0.4)
  assert.equal(requests[0].skip_completed,true);assert.equal(requests[0].script_content,undefined)
  complete({id:'batch-saved'});await first
  assert.equal(h.vm.busy.value,false);assert.equal(h.emissions.at(-1)[0],'created')
})

// Round 4 (2026-11-08): the same dialog also runs 出资产图 and 拆分镜, each with its own concurrency, in one batch.
test('batch dialog round 4: images and storyboard are sent in pipeline order with their own settings; no image choice keeps each episode model',async t=>{
  const parameters=await import('../app/utils/model-parameters.js'),requests=[]
  const h=component('components/ProductionBatchDialog.vue',{'~/composables/useApi':{aiConfigAPI:{list:async type=>type==='image'?[{id:6,model:['img-a'],provider:'openai',is_active:true}]:[{id:71,model:['text-test'],provider:'openai',is_active:true,parameters:[]}]},productionAPI:{createBatch:async body=>{requests.push(body);return {id:'batch-r4'}}}},'./ModelSelect.vue':{},'./ModelParameterFields.vue':{},'~/utils/model-parameters.js':parameters,'~/utils/production-presentation.js':productionPresentation},{dramaId:5,episodes:[{id:1,episode_number:1,script_content:'剧本'},{id:2,episode_number:2,script_content:'剧本'}],initialSelection:[1,2]})
  t.after(()=>h.dispose());await h.vm.loadModels();await vue.nextTick()
  assert.equal(h.vm.imageModelOptions.value.length,1)
  // Selected in a different order than the pipeline; the request lists them in pipeline order.
  h.vm.targets.value=['storyboard','images','characters'];h.vm.imageConcurrency.value=2;h.vm.storyboardConcurrency.value=2
  assert.equal(h.vm.orderLabel.value,'角色 → 出图 → 拆分镜')
  assert.match(h.vm.noteText.value,/只给还没有图片的/);assert.match(h.vm.noteText.value,/已有分镜的剧集不会重拆/)
  await h.vm.submit()
  assert.deepEqual([...requests[0].targets],['characters','images','storyboard'])
  assert.equal(requests[0].image_concurrency,2);assert.equal(requests[0].storyboard_concurrency,2)
  assert.equal(requests[0].image_config_id,undefined,'no image model chosen: each episode keeps its own image model')
  // An explicit image model is sent with the batch.
  h.vm.imageModelKey.value='6/img-a';await h.vm.submit()
  assert.equal(requests[1].image_config_id,6);assert.equal(requests[1].image_model,'img-a')
  // Extraction only: no image or storyboard settings are sent at all.
  h.vm.targets.value=['props'];await h.vm.submit()
  assert.equal(requests[2].image_concurrency,undefined);assert.equal(requests[2].storyboard_concurrency,undefined)
})

test('production dashboard reads true counts, pauses/resumes only the selected batch and never retries review-needed work implicitly',async t=>{
  let confirmation=false;const writes=[],reads=[]
  const batch={id:'batch-one',drama_id:3,concurrency:2,status:'running',counts:{total:3,queued:1,running:1,completed:0,failed:1,needs_review:1},steps:[]}
  const task={id:'activity-one',project_id:3,status:'failed',title:'提取角色',model:'text-test',elapsed_seconds:12,exception:{label:'提交待核对',summary:'等待核对原任务',submission_uncertain:true},links:{activity:{task_id:'activity-one',round_id:'round-one'},asset:{kind:'character',id:7},settings:{channel_id:6,config_id:71}}}
  const api={dashboard:async query=>{reads.push(query);return{projects:[{id:3,title:'项目'}],summary:{episodes_total:2,episodes_unrecorded:1,counts:{queued:1,running:1,completed:0,failed:1,interrupted:0}},episodes:[],exceptions:[task],tasks:{total:1}}},batches:async()=>({batches:[batch]}),batch:async()=>structuredClone(batch),task:async()=>({task}),pause:async id=>{writes.push(['pause',id]);batch.status='paused';return structuredClone(batch)},resume:async id=>{writes.push(['resume',id]);batch.status='running';return structuredClone(batch)},retry:async(...args)=>{writes.push(['retry',...args]);return structuredClone(batch)}}
  const h=component('components/ProductionDashboard.vue',{'~/composables/useApi':{productionAPI:api},'~/utils/platform-session':{platformSession:{user:{id:1,role:'admin'}}},'~/utils/production-presentation.js':productionPresentation},{dramaId:3,initialBatchId:'batch-one'},{window:{confirm:()=>confirmation}})
  t.after(()=>h.dispose());await h.vm.load();assert.equal(writes.length,0)
  assert.equal(h.vm.summary.value.counts.completed,0)
  await h.vm.batchAction('pause');await h.vm.batchAction('resume')
  assert.deepEqual(writes,[['pause','batch-one'],['resume','batch-one']])
  await h.vm.batchAction('retry');assert.equal(writes.length,2)
  confirmation=true;await h.vm.batchAction('retry');assert.deepEqual(writes.at(-1),['retry','batch-one'])
  await h.vm.selectTask('activity-one')
  assert.equal(h.vm.logHref.value,'/tasks?task_id=activity-one&drama_id=3&round_id=round-one')
  assert.equal(h.vm.assetHref.value,'/drama/3?tab=assets&asset_kind=character&asset_id=7')
  assert.equal(h.vm.settingsHref.value,'/admin/channels?channel_id=6&config_id=71')
  assert.match(await h.render(),/提交结果待核对/)
  h.vm.exceptionsOnly.value=true;await vue.nextTick();await settle();assert.equal(reads.at(-1).exceptions_only,1)
})

test('task deep link opens its original task and pins the requested real round across refresh without choosing the first list row',async t=>{
  const reads=[]
  const h=component('components/TaskCenter.vue',{'~/utils/platform-session':{platformSession:{user:{id:2,role:'user'}}},'~/utils/activity-tasks.js':presentation,'~/composables/useApi':{activityAPI:{list:async()=>({items:[{id:'newer-task',kind:'text',status:'completed'}],total:1,counts:{completed:1}}),detail:async id=>{reads.push(id);return{task:{id,kind:'text',status:'completed'},rounds:[{id:'original-round',number:1,public_text:'第一轮真实内容'},{id:'latest-round',number:2,public_text:'第二轮真实内容'}],events:[]}},eventsUrl:()=>'/events'}}},{initialTaskId:'original-task',initialRoundId:'original-round',initialTab:'process'})
  t.after(()=>h.dispose());h.mounts.forEach(fn=>fn());await settle();await vue.nextTick()
  assert.equal(h.vm.selectedId.value,'original-task');assert.equal(h.vm.roundIndex.value,0);assert.equal(h.vm.followLatest.value,false);assert.equal(h.vm.activeTab.value,'process')
  assert.equal(h.vm.outputText.value,'第一轮真实内容');assert.ok(reads.every(id=>id==='original-task'))
  await h.vm.loadDetail();assert.equal(h.vm.roundIndex.value,0)
  h.vm.selectRound(1);await h.vm.loadDetail();assert.equal(h.vm.roundIndex.value,1,'manual round choice remains authoritative')
})

test('changing the dashboard project during an existing read discards the old snapshot and schedules a single read of the new scope',async t=>{
  const props=vue.reactive({dramaId:3,initialBatchId:''}),reads=[];let release
  const api={dashboard:async query=>{reads.push(query.project_id);if(reads.length===1)return new Promise(resolve=>{release=resolve});return{selected_project_id:query.project_id,projects:[],episodes:[],summary:{counts:{}}}},batches:async()=>({batches:[]})}
  const h=component('components/ProductionDashboard.vue',{'~/composables/useApi':{productionAPI:api},'~/utils/platform-session':{platformSession:{user:{id:2,role:'user'}}},'~/utils/production-presentation.js':productionPresentation},props)
  t.after(()=>h.dispose());const first=h.vm.load();await settle();props.dramaId=4;await vue.nextTick()
  release({selected_project_id:3,episodes:[{id:1,title:'old private snapshot'}],summary:{counts:{}}});await first;await settle();await vue.nextTick()
  assert.deepEqual(reads,[3,4]);assert.equal(h.vm.dashboard.value.selected_project_id,4);assert.equal(h.vm.dashboard.value.episodes.length,0);assert.equal(h.vm.loading.value,false)
})

test('asset deep link opens the authorized matching asset once and later refreshes cannot reopen a dialog the user closed',async t=>{
  const parameters=await import('../app/utils/model-parameters.js'),scrolled=[]
  const h=component('views/drama/detail.vue',{'vue-i18n':{useI18n:()=>({t:key=>key,locale:vue.ref('zh')})},'~/composables/useToast':{toastError:failure=>{throw failure}},'~/composables/useApi':{dramaAPI:{get:async()=>({id:1,episodes:[],characters:[{id:7,name:'关联角色'}],scenes:[],props:[]})},episodeAPI:{},characterAPI:{},sceneAPI:{},propAPI:{},uploadAPI:{},aiConfigAPI:{},taskAPI:{},assetImageJobAPI:{}},'~/components/BaseSelect.vue':{},'~/components/ModelSelect.vue':{},'~/components/ModelParameterFields.vue':{},'~/components/TaskCenterLauncher.vue':{},'~/components/ProductionBatchDialog.vue':{},'~/utils/production-presentation.js':productionPresentation,'~/utils/model-parameters.js':parameters,'~/utils/image-task-state.js':imageState,'~/utils/asset-image-jobs.js':assetImageJobs,'~/utils/polling-scope.js':{createPollingScope}},{},{nextTick:vue.nextTick,useRoute:()=>({params:{id:'1'},query:{tab:'assets',asset_kind:'character',asset_id:'7'}}),document:{querySelector:()=>null,activeElement:null}})
  t.after(()=>h.dispose());h.vm.pageRoot.value={style:{overflow:'auto'},scrollTop:0,scrollLeft:0,querySelector:selector=>({scrollIntoView:()=>scrolled.push(selector)})}
  await h.vm.load();await settle();assert.equal(h.vm.activeTab.value,'assets');assert.equal(h.vm.assetTab.value,'character');assert.equal(h.vm.editTarget.value.id,7);assert.equal(scrolled.length,1)
  h.vm.closeEdit();await vue.nextTick();await h.vm.load();assert.equal(h.vm.editDialog.value,false);assert.equal(scrolled.length,1)
})

test('dashboard logical step selection follows its latest real attempt, clears when filtered out, and an explicitly opened historical task stays pinned',async t=>{
  let taskId='old-attempt',present=true
  const api={dashboard:async()=>({projects:[],summary:{counts:{}},episodes:present?[{id:1,project_id:3,episode_number:1,steps:[{key:'extract_scenes',label:'提取场景',status:taskId==='old-attempt'?'failed':'completed',latest_task_id:taskId}]}]:[]}),batches:async()=>({batches:[]}),task:async id=>({task:{id,project_id:3,episode_id:1,status:id==='old-attempt'?'failed':'completed',links:{activity:{task_id:id}}}})}
  const h=component('components/ProductionDashboard.vue',{'~/composables/useApi':{productionAPI:api},'~/utils/platform-session':{platformSession:{user:{id:2,role:'user'}}},'~/utils/production-presentation.js':productionPresentation},{dramaId:3,initialBatchId:''})
  t.after(()=>h.dispose());await h.vm.load();const episode=h.vm.dashboard.value.episodes[0];h.vm.selectStep(episode,episode.steps[0]);await settle();assert.equal(h.vm.task.value.id,'old-attempt')
  taskId='new-attempt';await h.vm.load();assert.equal(h.vm.task.value.id,'new-attempt');assert.equal(h.vm.selectedStep.value.status,'completed')
  present=false;await h.vm.load();assert.equal(h.vm.task.value,null);assert.equal(h.vm.selectedStep.value,null)
  h.vm.inspectTask('old-attempt');await settle();await h.vm.load();assert.equal(h.vm.task.value.id,'old-attempt','explicit original-task inspection must not be silently replaced by a new attempt')
})

test('administrator channel deep link selects only the stated real channel and its real config row; invalid combinations never fall back to another model',async t=>{
  const route=vue.reactive({query:{channel_id:'7',config_id:'72'}}),scrolls=[]
  const h=component('pages/admin/channels.vue',{'~/components/PlatformAdminShell.vue':{},'~/components/ModelCapabilityFields.vue':{},'~/composables/useApi':{channelAPI:{list:async()=>({channels:[{id:6,name:'A',models:[{id:11,config_id:71,type:'text',model:'a'}]},{id:7,name:'B',models:[{id:12,config_id:72,type:'text',model:'b'}]}],protocols:[]})},platformUserAPI:{list:async()=>[]}}},{},{useRoute:()=>route,document:{querySelector:selector=>({scrollIntoView:()=>scrolls.push(selector)})}})
  t.after(()=>h.dispose());await h.vm.load();assert.equal(h.vm.selectedId.value,7);assert.equal(h.vm.linkedConfigId.value,72);assert.equal(scrolls[0],'[data-config-id="72"]')
  route.query.channel_id='6';await vue.nextTick();await settle();assert.equal(h.vm.selectedId.value,null);assert.match(h.vm.routeError.value,/不存在/)
  await h.vm.load();assert.equal(h.vm.selectedId.value,null,'reload cannot replace an invalid requested model with the first channel')
  route.query.config_id='71';await vue.nextTick();await settle();assert.equal(h.vm.selectedId.value,6);assert.equal(h.vm.linkedConfigId.value,71)
  h.vm.selectChannel(7);await h.vm.load();assert.equal(h.vm.selectedId.value,7,'subsequent deliberate manual selection remains valid')
})
