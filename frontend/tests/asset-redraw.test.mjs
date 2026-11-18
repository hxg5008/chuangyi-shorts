import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { renderToString } from '@vue/server-renderer'
import ts from 'typescript'
import * as vue from 'vue'
import * as helpers from '../app/utils/asset-redraw.js'

const source = new URL('../app/components/AssetImageLibrary.vue', import.meta.url)
const { descriptor } = parse(readFileSync(source, 'utf8'), { filename: source.pathname })
const script = compileScript(descriptor, { id: 'asset-library-test' })
const js = value => ts.transpileModule(value, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const template = compileTemplate({ source: descriptor.template.content, filename: source.pathname, id: 'asset-library-test', compilerOptions: { bindingMetadata: script.bindings } })
assert.deepEqual(template.errors, [])
const rendered = {}
runInNewContext(js(template.code), { exports: rendered, require(name) { assert.equal(name, 'vue'); return vue } })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await vue.nextTick() }
const history = (id = 7, versions = [], kind = 'character', extra = {}) => ({ asset_type: kind, asset_id: id, current_url: versions.find(row => row.is_current)?.image_url || null, versions, has_more: false, next_before_id: null, ...extra })
const version = (id, current = false) => ({ id, image_url: `static/history/${id}.png`, created_at: '2026-11-09T12:13:00Z', width: 1672, height: 941, is_current: current, missing: false })

function harness({ answer = async (_kind, id) => history(id), upload = async file => ({ path: 'static/upload/' + file.name }), mutate, confirm = true } = {}) {
  const props = vue.reactive({ kind: 'character', asset: { id: 7, name: '测试角色', image_url: 'static/current.png' }, config: { provider: 'openai', capabilities: {} }, model: 'test-image', busy: false })
  const calls = [], events = [], hooks = [], module = {}, focused = []
  let respond = answer, exposed
  const api = {
    list: async (...args) => { calls.push(['list', ...args]); return respond(...args) },
    adopt: async (...args) => { calls.push(['adopt', ...args]); return mutate ? mutate(...args) : history(args[1], [version(args[2], true)]) },
    remove: async (...args) => { calls.push(['remove', ...args]); return mutate ? mutate(...args) : history(args[1], [version(1, true)]) },
  }
  const icons = new Proxy({}, { get: (_target, name) => ({ name: String(name), render: () => null }) })
  runInNewContext(js(script.content), {
    exports: module,
    require(name) {
      if (name === 'vue') return { ...vue, onBeforeUnmount: callback => hooks.push(callback) }
      if (name === 'lucide-vue-next') return icons
      if (name === '~/composables/useApi') return { assetImageAPI: api, uploadAPI: { image: async file => { calls.push(['upload', file.name]); return upload(file) } } }
      if (name === '~/utils/asset-redraw.js') return helpers
      throw Error('Unexpected import ' + name)
    },
    window: { confirm: () => confirm }, document: { activeElement: { focus: () => focused.push('return') } }, console,
  })
  const scope = vue.effectScope(), state = scope.run(() => module.default.setup(props, { expose: value => { exposed = value }, emit: (...args) => events.push(args) }))
  return { props, state, exposed, calls, events, focused, respond: value => { respond = value }, dispose() { for (const hook of hooks) hook(); scope.stop() } }
}

async function render(h) {
  return renderToString(vue.h({ render() { return rendered.render(this, [], h.props, vue.proxyRefs(h.state), {}, {}) } }), {})
}

test('capability limits match the backend and unsupported adapters explicitly reject references', () => {
  assert.equal(helpers.assetReferenceCapability({ provider: 'openai' }, 'ordinary').max, 6)
  assert.equal(helpers.assetReferenceCapability({ provider: 'openai' }, 'imagegen').max, 5)
  assert.equal(helpers.assetReferenceCapability({ provider: 'yingce', protocol_id: 'image.codex-official' }).max, 5)
  assert.equal(helpers.assetReferenceCapability({ provider: 'yingce', capabilities: { max_images: 3, max_reference_images: 2, maxReferenceImages: 8 } }).max, 2)
  for (const config of [{ provider: 'volcengine' }, { provider: 'gemini', base_url: 'https://generativelanguage.googleapis.com', selected_model: 'gemini-3-pro-image-preview' }, { capabilities: { image_input: false } }, { capabilities: { max_images: 0 } }]) {
    const capability = helpers.assetReferenceCapability(config)
    assert.equal(capability.supported, false)
    assert.throws(() => helpers.validateRedrawReferences([{ url: 'static/reference.png' }], capability), /不支持参考图/)
    assert.deepEqual(helpers.validateRedrawReferences([], capability), [])
  }
})

test('file validation rejects unsupported formats, per-file, total-byte and model-count excess without truncation', () => {
  const cap = { known: true, supported: true, max: 2 }, image = { type: 'image/png', size: 30 * 1024 * 1024 }
  assert.doesNotThrow(() => helpers.validateReferenceFiles([image], [], cap))
  assert.throws(() => helpers.validateReferenceFiles([{ ...image, type: 'image/gif' }], [], cap), /PNG/)
  assert.throws(() => helpers.validateReferenceFiles([{ ...image, size: image.size + 1 }], [], cap), /30 MB/)
  assert.throws(() => helpers.validateReferenceFiles([image], [{ bytes: 6 * 1024 * 1024 }], cap), /35 MB/)
  assert.throws(() => helpers.validateReferenceFiles([image], [{}, {}], cap), /最多支持 2 张/)
  const refs = [{ url: 'one' }, { url: 'two' }, { url: 'three' }]
  assert.throws(() => helpers.validateRedrawReferences(refs, cap), /不会自动截断/)
  assert.equal(refs.length, 3)
})

test('history lists actual versions, current adoption, full generation date and dimensions without generating', async () => {
  const h = harness({ answer: async () => history(7, [version(3), version(2, true), version(1)]) })
  await flush()
  assert.equal(h.state.versions.value.length, 3)
  const html = await render(h)
  assert.match(html, /当前采用/); assert.match(html, /2026\/11\/09/); assert.match(html, /1672 × 941/)
  assert.equal((html.match(/删除历史/g) || []).length, 2)
  assert.ok(h.calls.every(call => call[0] === 'list'))
  assert.deepEqual(Array.from(h.exposed.snapshotReferences()), [], 'current picture is never added implicitly')
  h.dispose()
})

test('late A and B reads cannot overwrite the latest asset history or reference choices', async () => {
  const a = deferred(), b = deferred(), latest = deferred(); let reads = 0
  const h = harness({ answer: () => [a, b, latest][reads++].promise })
  h.props.asset = { id: 8, name: 'B' }; h.props.asset = { id: 7, name: 'A' }
  latest.resolve(history(7, [version(30, true)])); await flush()
  b.resolve(history(8, [version(20, true)])); a.resolve(history(7, [version(10, true)])); await flush()
  assert.deepEqual(Array.from(h.state.versions.value, row => row.id), [30])
  assert.equal(h.events.length, 1); assert.equal(h.events[0][1].id, 7)
  h.dispose()
})

test('current picture is explicitly selectable, deduplicated, and a used snapshot marks only unchanged choices', async () => {
  const h = harness(); await flush()
  h.state.useCurrent(); h.state.useCurrent()
  assert.deepEqual(Array.from(h.exposed.snapshotReferences()), ['/static/current.png'])
  assert.equal(h.exposed.hasUnsavedReferences(), true)
  h.exposed.markReferencesUsed(['/static/other.png']); assert.equal(h.exposed.hasUnsavedReferences(), true)
  h.exposed.markReferencesUsed(['/static/current.png']); assert.equal(h.exposed.hasUnsavedReferences(), false)
  h.props.config = { provider: 'openai', capabilities: { max_images: 0 } }; await flush()
  assert.throws(() => h.exposed.validateReferences(), /不支持参考图/)
  assert.equal(h.state.references.value.length, 1, 'changing model does not silently discard selected input')
  h.dispose()
})

test('upload validates before transport and late upload completion cannot attach a file to another asset', async () => {
  const pending = deferred(), h = harness({ upload: () => pending.promise }); await flush()
  const event = files => ({ target: { files, value: 'selected' } })
  await h.state.uploadReferences(event([{ name: 'bad.gif', type: 'image/gif', size: 1 }]))
  assert.equal(h.calls.filter(call => call[0] === 'upload').length, 0)
  const operation = h.state.uploadReferences(event([{ name: 'good.png', type: 'image/png', size: 100 }]))
  assert.equal(h.exposed.isUploading(), true)
  h.props.asset = { id: 9, name: 'New' }; assert.equal(h.exposed.isUploading(), false)
  pending.resolve({ path: 'static/upload/good.png' }); await operation; await flush()
  assert.equal(h.state.references.value.length, 0); assert.equal(h.exposed.isUploading(), false)
  h.dispose()
})

test('adopt and delete operate on the exact asset/version and current versions cannot be deleted', async () => {
  const h = harness({ answer: async () => history(7, [version(2), version(1, true)]) }); await flush()
  await h.state.removeVersion(h.state.versions.value[1]); assert.equal(h.calls.filter(call => call[0] === 'remove').length, 0)
  await h.state.adopt(h.state.versions.value[0]); assert.deepEqual(h.calls.find(call => call[0] === 'adopt'), ['adopt', 'character', 7, 2])
  assert.equal(h.state.versions.value[0].is_current, true)
  await h.state.removeVersion(h.state.versions.value[0]); assert.equal(h.calls.filter(call => call[0] === 'remove').length, 0)
  assert.equal(h.events.at(-1)[1].url, 'static/history/2.png')
  h.dispose()
})

test('cancelled deletion never calls the server and an old mutation cannot update a newly opened asset', async () => {
  const no = harness({ confirm: false }); await flush(); await no.state.removeVersion(version(8)); assert.ok(no.calls.every(call => call[0] === 'list')); no.dispose()
  const wait = deferred(), h = harness({ mutate: () => wait.promise }); await flush()
  const operation = h.state.adopt(version(8)); h.props.kind = 'scene'; h.props.asset = { id: 11, location: '新场景' }; await flush()
  const eventsBefore = h.events.length
  wait.resolve(history(7, [version(8, true)])); await operation; await flush()
  assert.equal(h.events.length, eventsBefore); assert.equal(h.state.action.value, '')
  assert.equal(h.props.asset.id, 11); h.dispose()
})

test('a read started during adoption cannot overwrite the confirmed current version when it returns late', async () => {
  const mutation = deferred(), stale = deferred(); let reads = 0
  const h = harness({ answer: () => ++reads === 1 ? Promise.resolve(history(7, [version(1, true)])) : stale.promise, mutate: () => mutation.promise })
  await flush()
  const operation = h.state.adopt(version(2)), reading = h.state.loadHistory()
  mutation.resolve(history(7, [version(2, true), version(1)])); await operation
  stale.resolve(history(7, [version(1, true)])); await reading
  assert.deepEqual(Array.from(h.state.versions.value, row => row.id), [2, 1])
  assert.equal(h.events.at(-1)[1].url, 'static/history/2.png'); h.dispose()
})

test('load-more retains existing rows, deduplicates versions and sends the returned cursor', async () => {
  let count = 0
  const h = harness({ answer: async () => ++count === 1 ? history(7, [version(4, true), version(3)], 'character', { has_more: true, next_before_id: 3 }) : history(7, [version(3), version(2), version(1)], 'character', { current_url: 'static/history/4.png' }) })
  await flush(); await h.state.loadHistory(true)
  assert.deepEqual(Array.from(h.state.versions.value, row => row.id), [4, 3, 2, 1])
  assert.deepEqual(h.calls[1], ['list', 'character', 7, 200, 3]); assert.equal(h.state.hasMore.value, false); h.dispose()
})

test('failed history reads stay visible and busy completion refreshes the history without any generation call', async () => {
  const h = harness({ answer: async () => { throw Error('网络暂不可用') } }); await flush()
  assert.equal(h.state.historyError.value, '网络暂不可用')
  h.respond(async () => history(7, [version(1, true)]))
  h.props.busy = true; await flush(); h.props.busy = false; await flush()
  assert.equal(h.state.historyError.value, ''); assert.equal(h.state.versions.value.length, 1)
  assert.ok(h.calls.every(call => call[0] === 'list')); h.dispose()
})

test('generation completing during an older history read queues a fresh read instead of losing the new result', async () => {
  const older = deferred(); let reads = 0
  const h = harness({ answer: () => ++reads === 1 ? older.promise : Promise.resolve(history(7, [version(2), version(1, true)])) })
  h.props.busy = true; await flush(); h.props.busy = false; await flush()
  assert.equal(h.calls.length, 1)
  older.resolve(history(7, [version(1, true)])); await flush(); await flush()
  assert.equal(h.calls.length, 2); assert.deepEqual(Array.from(h.state.versions.value, row => row.id), [2, 1])
  h.dispose()
})

test('original viewer opens the real image URL at 100 percent pixels and can switch to fit without changing source', async () => {
  const h = harness(); await flush()
  await h.exposed.openCurrentImage()
  assert.equal(h.state.viewer.value.url, '/static/current.png'); assert.equal(h.state.fitImage.value, false)
  h.state.imageLoaded({ target: { naturalWidth: 2300, naturalHeight: 1400 } })
  assert.equal(h.state.viewer.value.width, 2300); assert.equal(h.state.viewer.value.height, 1400)
  assert.match(descriptor.styles[0].content, /\.original-scroll img\{[^}]*max-width:none;max-height:none/)
  h.state.fitImage.value = true; assert.equal(h.state.viewer.value.url, '/static/current.png')
  h.state.closeViewer(); assert.equal(h.state.viewer.value, null); assert.deepEqual(h.focused, ['return']); h.dispose()
})
