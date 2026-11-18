import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import ts from 'typescript'
import * as vue from 'vue'
import { renderToString } from '@vue/server-renderer'

const file = new URL('../app/components/StylePicker.vue', import.meta.url)
const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file.pathname })
const script = compileScript(descriptor, { id: 'style-detail-test' })
const compile = text => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const template = compileTemplate({ source: descriptor.template.content, filename: file.pathname, id: 'style-detail-test', compilerOptions: { bindingMetadata: script.bindings } })
assert.deepEqual(template.errors, [])
const templateExports = {}
runInNewContext(compile(template.code), { exports: templateExports, require: name => { assert.equal(name, 'vue'); return vue } })
const longTemplate = '  真实质感与手绘动画融合。\r\n' + 'Chinese and English details，保持原文。\n'.repeat(900) + '\n{content}\n尾部约束：禁止改变服装。<literal-tag>\r\n  '
const rows = [
  { value: 'style-a', name: '乡村振兴', source: 'yingce', category: 'live', description: '青山绿水与新农村。', template: longTemplate, prompt: 'short summary only', stages: ['asset_image', 'storyboard', 'video'], tags: ['乡村', '返乡'] },
  { value: 'style-b', name: '云雀样式', source: 'xyq', category: '2d', description: '另一个风格', template: 'B-prefix\n{content}\nB-suffix  ', prompt: 'unused summary', stages: ['asset_image'], tags: ['手绘'] },
  { value: 'legacy', name: '旧自定义', source: 'custom', category: 'other', prompt: '  untouched legacy text\r\n末尾  ', stages: ['asset_image', 'video'] },
]
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function harness({ clipboard = async () => {}, available = true, modelValue = 'style-a' } = {}) {
  const events = [], copied = [], hooks = [], exports = {}, focus = { returned: 0, selected: 0, focused: 0 }
  const props = vue.reactive({ modelValue, styles: rows.map(row => ({ ...row })), placeholder: '选择风格' })
  const icons = new Proxy({}, { get: (_target, name) => ({ name: String(name), render: () => null }) })
  runInNewContext(compile(script.content), {
    exports,
    require(name) {
      if (name === 'vue') return { ...vue, onBeforeUnmount: callback => hooks.push(callback) }
      if (name === 'lucide-vue-next') return icons
      throw new Error('Unexpected import: ' + name)
    },
    document: { activeElement: { focus() { focus.returned++ } } },
    navigator: available ? { clipboard: { async writeText(text) { copied.push(text); return clipboard(text) } } } : {},
    window: { isSecureContext: true },
    console,
  })
  const state = exports.default.setup(props, { expose() {}, emit: (...event) => events.push(event) })
  state.promptArea.value = { focus() { focus.focused++ }, select() { focus.selected++ } }
  return { state, props, events, copied, focus, dispose() { for (const callback of hooks) callback() } }
}
async function promptNode(h) {
  let tree
  const host = { render() { tree = templateExports.render(this, [], h.props, vue.proxyRefs(h.state), {}, {}); return tree } }
  await renderToString(vue.h(host), {})
  let textarea
  const walk = node => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'textarea') textarea = node
    if (Array.isArray(node.children)) for (const child of node.children) walk(child)
  }
  walk(tree)
  return textarea
}

test('opening a selected card exposes the entire original template in a readonly field, including a long bilingual suffix', async () => {
  const h = harness()
  h.state.openBrowser()
  assert.equal(h.state.previewPrompt.value, longTemplate)
  assert.ok(h.state.previewPrompt.value.length > 20000)
  const textarea = await promptNode(h)
  assert.ok(textarea, 'the detail panel must contain a real text field')
  assert.equal(textarea.props.value, longTemplate)
  assert.ok(Object.hasOwn(textarea.props, 'readonly')); assert.notEqual(textarea.props.readonly, false)
  assert.equal(h.events.length, 0)
  h.dispose()
})

test('selecting another card changes only its preview; cancellation leaves the adopted model value untouched', async () => {
  const h = harness()
  h.state.openBrowser(); h.state.selectPreview('style-b')
  assert.equal(h.state.preview.value.name, '云雀样式')
  assert.equal(h.state.previewPrompt.value, rows[1].template)
  assert.equal(h.props.modelValue, 'style-a'); assert.equal(h.events.length, 0)
  h.state.close(); await vue.nextTick()
  assert.equal(h.state.open.value, false); assert.equal(h.events.length, 0)
  h.state.openBrowser()
  assert.equal(h.state.pending.value, 'style-a')
  h.dispose()
})

test('copy sends the complete template, with whitespace and literal markup preserved, without adopting the preview', async () => {
  const h = harness()
  h.state.openBrowser(); await h.state.copyPrompt()
  assert.deepEqual(h.copied, [longTemplate])
  assert.equal(h.state.copyState.value, 'copied')
  assert.equal(h.events.length, 0); assert.equal(h.props.modelValue, 'style-a')
  h.dispose()
})

test('legacy styles show their full prompt rather than an empty template or translated summary', async () => {
  const h = harness({ modelValue: 'legacy' })
  h.state.openBrowser(); assert.equal(h.state.previewPrompt.value, rows[2].prompt)
  await h.state.copyPrompt(); assert.deepEqual(h.copied, [rows[2].prompt])
  h.dispose()
})

test('unavailable or rejected clipboard access selects the readonly text for manual copying and never throws away the preview', async () => {
  for (const available of [false, true]) {
    const h = harness({ available, clipboard: async () => { throw new Error('clipboard denied') } })
    h.state.openBrowser(); await h.state.copyPrompt()
    assert.equal(h.state.copyState.value, 'manual')
    assert.equal(h.focus.focused, 1); assert.equal(h.focus.selected, 1)
    assert.equal(h.state.previewPrompt.value, longTemplate); assert.equal(h.events.length, 0)
    h.dispose()
  }
})

test('an old clipboard completion cannot mark a newly selected card as copied or select its text on failure', async () => {
  for (const reject of [false, true]) {
    const reply = deferred(), h = harness({ clipboard: () => reply.promise })
    h.state.openBrowser(); const operation = h.state.copyPrompt()
    h.state.selectPreview('style-b')
    if (reject) reply.reject(new Error('old copy denied')); else reply.resolve()
    await operation
    assert.equal(h.state.pending.value, 'style-b'); assert.equal(h.state.copyState.value, '')
    assert.equal(h.focus.selected, 0); assert.equal(h.events.length, 0)
    h.dispose()
  }
})

test('closing while a copy is pending ignores its late completion and copying while closed does nothing', async () => {
  const reply = deferred(), h = harness({ clipboard: () => reply.promise })
  h.state.openBrowser(); const operation = h.state.copyPrompt(); h.state.close(); reply.resolve(); await operation
  assert.equal(h.state.copyState.value, ''); assert.equal(h.state.open.value, false)
  await h.state.copyPrompt(); assert.equal(h.copied.length, 1); assert.equal(h.events.length, 0)
  h.dispose()
})

test('only an explicit valid adoption emits a model change; invalid cards and copying with no selection do not', async () => {
  const h = harness({ modelValue: '' })
  h.state.openBrowser(); assert.equal(h.state.previewPrompt.value, '')
  await h.state.copyPrompt(); h.state.selectPreview('missing'); h.state.apply('missing')
  assert.equal(h.copied.length, 0); assert.equal(h.events.length, 0)
  h.state.selectPreview('style-b'); h.state.apply('style-b')
  assert.deepEqual(h.events, [['update:modelValue', 'style-b']]); assert.equal(h.state.open.value, false)
  assert.equal(h.props.modelValue, '', 'the component must not mutate its input prop')
  h.dispose()
})
