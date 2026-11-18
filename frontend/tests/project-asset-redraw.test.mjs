import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import ts from 'typescript'
import * as vue from 'vue'
import * as modelParameters from '../app/utils/model-parameters.js'
import * as imageTasks from '../app/utils/image-task-state.js'
import * as imageJobs from '../app/utils/asset-image-jobs.js'

const file = new URL('../app/views/drama/detail.vue', import.meta.url)
const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file.pathname })
const script = compileScript(descriptor, { id: 'project-redraw-test' })
const compiled = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const template = compileTemplate({ source: descriptor.template.content, filename: file.pathname, id: 'project-redraw-test', compilerOptions: { bindingMetadata: script.bindings } })
assert.deepEqual(template.errors, [])
const copy = value => structuredClone(value)
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }

function project() {
  const state = { drama: { id: 1, title: '测试项目', episodes: [{ id: 2, episode_number: 1, image_config_id: 9 }], characters: [{ id: 7, name: '角色', role: '主角', appearance: '样貌', styling: '日常服装', description: '人物设定', final_prompt: 'stored prompt', image_url: 'static/current.png' }], scenes: [{ id: 7, location: '房间', prompt: '原场景', lighting: '白天', image_url: 'static/scene.png' }], props: [{ id: 3, name: '道具', type: '日常', description: '原道具' }] }, tasks: [] }
  const calls = [], notices = [], unmount = [], module = {}
  const service = kind => ({
    update: async (id, body) => { calls.push(['save', kind, id, copy(body)]); const item = state.drama[kind === 'character' ? 'characters' : kind === 'scene' ? 'scenes' : 'props'].find(row => row.id === id); Object.assign(item, body) },
    generateImage: async (...args) => { calls.push(['generate', kind, ...copy(args)]); state.tasks.push({ id: 901, type: 'image', [`${kind}_id`]: args[0], status: 'processing' }); return { image_generation_id: 901 } },
  })
  const apis = { dramaAPI: { get: async () => copy(state.drama) }, episodeAPI: {}, characterAPI: service('character'), sceneAPI: service('scene'), propAPI: service('prop'), uploadAPI: {}, aiConfigAPI: {}, assetImageJobAPI: { list: async () => ({ items: [] }) }, taskAPI: { list: async () => copy(state.tasks) } }
  const element = () => ({ style: { overflow: '' }, scrollTop: 42, scrollLeft: 0 })
  const environment = {
    ...vue, exports: module, useRoute: () => ({ params: { id: '1' }, query: {} }), navigateTo() {},
    onBeforeUnmount: fn => unmount.push(fn), onMounted() {},
    document: { activeElement: { focus() {} }, documentElement: element(), body: element(), querySelector: () => ({ focus() {} }) },
    require(name) {
      if (name === 'vue-sonner') return { toast: Object.fromEntries(['success', 'error', 'warning', 'info'].map(key => [key, (...args) => notices.push([key, ...args])])) }
      if (name === 'vue-i18n') return { useI18n: () => ({ t: key => key, locale: vue.ref('zh') }) }
      if (name === '~/composables/useApi') return apis
      if (name === '~/composables/useToast') return { toastError: error => notices.push(['error', error?.message]) }
      if (name === '~/utils/model-parameters.js') return modelParameters
      if (name === '~/utils/image-task-state.js') return imageTasks
      if (name === '~/utils/asset-image-jobs.js') return imageJobs
      if (name === '~/utils/production-presentation.js') return { episodeHasExtractionInput: () => true }
      if (name === '~/utils/polling-scope.js') return { createPollingScope: () => ({ active: true, start() {}, dispose() { this.active = false } }) }
      if (name.startsWith('~/components/') && name.endsWith('.vue')) return {}
      throw Error('Unexpected project import ' + name)
    }, console,
  }
  runInNewContext(compiled, environment)
  const scope = vue.effectScope(), vm = scope.run(() => module.default.setup({}, { expose() {} }))
  vm.drama.value = copy(state.drama)
  vm.assetImageConfigs.value = [{ id: 9, provider: 'openai', model: ['image-a'], is_active: true }]
  vm.assetImageModel.value = '9/image-a'
  return { state, calls, notices, apis, vm, dispose() { for (const hook of unmount) hook(); scope.stop() } }
}

test('project material editor submits saved raw prompt and optional explicit references through the selected image channel', async t => {
  const h = project(); t.after(() => h.dispose()); await vue.nextTick()
  h.vm.openEdit(h.vm.materials.value.find(row => row.kindKey === 'character'))
  const literal = '  手动提示词\n保留完整内容。  ', used = []
  h.vm.editDraft.finalPrompt = literal; h.vm.assetImageParameters.value = { quality: 'high' }
  h.vm.projectAssetImageLibrary.value = { validateReferences: () => ['static/custom.png'], isUploading: () => false, hasUnsavedReferences: () => true, markReferencesUsed: refs => used.push([...refs]) }
  await h.vm.redrawMaterial()
  assert.equal(h.calls[0][0], 'save'); assert.equal(h.calls[0][3].finalPrompt, literal)
  const sent = h.calls.find(row => row[0] === 'generate')
  assert.equal(sent[1], 'character'); assert.equal(sent[2], 7); assert.equal(sent[3], 2); assert.equal(sent[4], 'image-a'); assert.equal(sent[5], 9)
  assert.deepEqual(sent[8], { quality: 'high' }); assert.equal(sent[10], false)
  assert.deepEqual(sent[11], { manual: true, prompt: literal, reference_images: ['static/custom.png'] })
  assert.deepEqual(used, [['static/custom.png']]); assert.equal(h.vm.editDialog.value, true)
})

test('project redraw does not reuse the current image implicitly and rejects invalid references before save or generation', async t => {
  const h = project(); t.after(() => h.dispose()); await vue.nextTick()
  h.vm.openEdit(h.vm.materials.value.find(row => row.kindKey === 'scene'))
  h.vm.editDraft.finalPrompt = 'new scene prompt'
  h.vm.projectAssetImageLibrary.value = { validateReferences: () => { throw Error('invalid references') }, isUploading: () => false }
  await h.vm.redrawMaterial(); assert.equal(h.calls.length, 0)
  h.vm.projectAssetImageLibrary.value = { validateReferences: () => [], isUploading: () => false, markReferencesUsed() {} }
  await h.vm.redrawMaterial()
  const sent = h.calls.find(row => row[0] === 'generate')
  assert.equal(sent[1], 'scene'); assert.deepEqual(sent[11].reference_images, [])
})

test('project save failure prevents manual redraw and keeps the dialog and drafts available', async t => {
  const h = project(); t.after(() => h.dispose()); await vue.nextTick()
  h.vm.openEdit(h.vm.materials.value.find(row => row.kindKey === 'prop'))
  h.vm.editDraft.finalPrompt = 'prop prompt'; h.apis.propAPI.update = async () => { throw Error('save unavailable') }
  h.vm.projectAssetImageLibrary.value = { validateReferences: () => [], isUploading: () => false }
  await h.vm.redrawMaterial()
  assert.ok(h.calls.every(row => row[0] !== 'generate')); assert.equal(h.vm.editDialog.value, true); assert.equal(h.vm.editDraft.finalPrompt, 'prop prompt')
})

test('project manual submission freezes image model and parameters while preceding save is pending', async t => {
  const h = project(); t.after(() => h.dispose()); await vue.nextTick()
  h.vm.openEdit(h.vm.materials.value.find(row => row.kindKey === 'character'))
  h.vm.assetImageParameters.value = { quality: 'high' }; h.vm.editDraft.finalPrompt = 'frozen prompt'
  h.vm.projectAssetImageLibrary.value = { validateReferences: () => [], isUploading: () => false, markReferencesUsed() {} }
  const wait = deferred(); h.apis.characterAPI.update = () => wait.promise
  const action = h.vm.redrawMaterial()
  h.vm.assetImageConfigs.value = [{ id: 10, provider: 'openai', model: ['image-b'], is_active: true }]; h.vm.assetImageModel.value = '10/image-b'; h.vm.assetImageParameters.value = { quality: 'low' }
  wait.resolve({}); await action
  const sent = h.calls.find(row => row[0] === 'generate')
  assert.equal(sent[4], 'image-a'); assert.equal(sent[5], 9); assert.deepEqual(sent[8], { quality: 'high' })
})

test('adoption updates only the exact asset kind even when character and scene IDs collide', async t => {
  const h = project(); t.after(() => h.dispose())
  h.vm.openEdit(h.vm.materials.value.find(row => row.kindKey === 'scene'))
  h.vm.applyMaterialCurrentImage({ kind: 'scene', id: 7, url: 'static/new-scene.png' })
  assert.equal(h.vm.drama.value.characters[0].image_url, 'static/current.png')
  assert.equal(h.vm.drama.value.scenes[0].image_url, 'static/new-scene.png'); assert.equal(h.vm.editTarget.value.image_url, 'static/new-scene.png')
  assert.equal(h.vm.materialRedrawLabel(h.vm.editTarget.value), 'episode.asset.regenScene')
  assert.equal(h.vm.materialRedrawLabel(h.vm.materials.value.find(row => row.kindKey === 'character')), 'episode.asset.regenPortrait')
  assert.equal(h.vm.materialRedrawLabel(h.vm.materials.value.find(row => row.kindKey === 'prop')), 'episode.asset.genProp')
})

test('late project prompt response cannot replace a different editor or newer manual prompt', async t => {
  const h = project(); t.after(() => h.dispose())
  const wait = deferred(); h.apis.characterAPI.generatePrompt = () => wait.promise
  const character = h.vm.materials.value.find(row => row.kindKey === 'character')
  h.vm.openEdit(character)
  const generation = h.vm.generateFinalPrompt(character)
  h.vm.closeEdit(); h.vm.openEdit(h.vm.materials.value.find(row => row.kindKey === 'prop')); h.vm.editDraft.finalPrompt = 'new prop draft'
  wait.resolve({ final_prompt: 'late character prompt' }); await generation
  assert.equal(h.vm.editTarget.value.kindKey, 'prop'); assert.equal(h.vm.editDraft.finalPrompt, 'new prop draft')
})

test('project manual redraw persists a retained prompt after appearance invalidation before generating', async t => {
  const h = project(); t.after(() => h.dispose()); await vue.nextTick()
  h.vm.openEdit(h.vm.materials.value.find(row => row.kindKey === 'character'))
  h.vm.editDraft.appearance = 'new appearance'
  h.vm.projectAssetImageLibrary.value = { validateReferences: () => [], isUploading: () => false, markReferencesUsed() {} }
  const writes = []
  h.apis.characterAPI.update = async (_id, body) => { writes.push(copy(body)); return { final_prompt_cleared: writes.length === 1 } }
  await h.vm.redrawMaterial()
  assert.equal(writes.length, 2); assert.deepEqual(writes[1], { final_prompt: 'stored prompt' })
  assert.equal(h.vm.editTarget.value.final_prompt, 'stored prompt'); assert.equal(h.vm.editDraft.finalPrompt, 'stored prompt')
  assert.equal(h.calls.find(row => row[0] === 'generate')[11].prompt, 'stored prompt')
})
