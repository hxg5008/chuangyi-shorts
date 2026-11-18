<template>
  <div class="asset-image-library" data-testid="asset-image-library">
    <section class="reference-section" aria-label="重绘参考图">
      <div class="library-heading">
        <div><strong>参考图</strong><span class="muted">可选<span v-if="references.length"> · 已选 {{ references.length }} 张</span></span></div>
        <div class="library-actions">
          <button v-if="currentUrl" type="button" class="btn btn-sm" :disabled="locked || !capability.supported" data-testid="asset-use-current-reference" @click="useCurrent">用当前图作参考</button>
          <button v-if="references.length" type="button" class="btn btn-ghost btn-sm" :disabled="locked" @click="clearReferences">清空</button>
        </div>
      </div>
      <div class="reference-grid">
        <div v-for="(reference, index) in references" :key="reference.url" class="reference-card">
          <button type="button" class="reference-image" @click="viewImage(reference.url, reference.name)"><img :src="assetMediaUrl(reference.url)" :alt="reference.name" /></button>
          <span :title="reference.name">{{ reference.name }}</span>
          <button type="button" class="reference-remove" :aria-label="`移除参考图 ${index + 1}`" :disabled="locked" @click="removeReference(index)"><X :size="12" /></button>
        </div>
        <label class="reference-add" :class="{ disabled: locked || !capability.supported }">
          <Loader2 v-if="uploading" :size="19" class="spinning" /><Plus v-else :size="19" />
          <span>{{ uploading ? '正在上传…' : '上传参考图' }}</span>
          <input type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" multiple :disabled="locked || !capability.supported" data-testid="asset-reference-input" @change="uploadReferences" />
        </label>
      </div>
      <p v-if="!capability.known" class="library-hint">先选择图片模型，即可添加参考图。</p>
      <p v-else-if="!capability.supported" class="library-error">所选图片接口不支持参考图。已有选择会保留，请移除后生成，或切换模型。</p>
      <p v-else class="library-hint">PNG、JPG、JPEG、WEBP，每张不超过 30 MB，总计不超过 35 MB；当前模型最多 {{ capability.max }} 张。</p>
      <p class="library-hint">参考图只用于这里的手动重绘，不会自动加入卡片或批量生成；当前图也需明确选择。</p>
      <p v-if="referenceError" class="library-error" role="alert">{{ referenceError }}</p>
    </section>

    <section class="history-section" aria-label="历史图片" data-testid="asset-image-history">
      <div class="library-heading">
        <div><strong>历史图片</strong><span class="muted">{{ versions.length }} 张<span v-if="hasMore">以上</span></span></div>
        <button type="button" class="btn btn-ghost btn-sm" :disabled="loading || !!action" @click="refreshHistory"><RefreshCw :size="12" :class="{ spinning: loading }" />{{ loading ? '读取中…' : '刷新历史' }}</button>
      </div>
      <p class="library-hint">新抽图保留在这里。已有当前图不会自动替换，采用后才用于后续生成。</p>
      <p v-if="historyError" class="library-error" role="alert">{{ historyError }}</p>
      <div v-if="versions.length" class="history-grid">
        <article v-for="version in versions" :key="version.id" class="history-card" :class="{ current: version.is_current }">
          <div class="history-image-frame">
            <button type="button" class="history-image" :disabled="version.missing" @click="viewImage(version.image_url, imageTitle)">
              <img v-if="!version.missing" :src="assetMediaUrl(version.image_url)" :alt="imageTitle" loading="lazy" @error="version.missing = true" />
              <span v-else class="missing-image">图片文件已不存在</span>
            </button>
            <span v-if="version.is_current" class="current-badge"><Check :size="10" />当前采用</span>
          </div>
          <div class="history-meta"><time>{{ assetImageDate(version.created_at) }}</time><small v-if="version.width && version.height">{{ version.width }} × {{ version.height }} 像素</small></div>
          <p v-if="version.changed" class="library-error" style="padding:0 8px">本地文件已变化，请重新上传后采用。</p>
          <div class="history-actions">
            <button type="button" class="btn btn-sm" :disabled="version.missing" @click="viewImage(version.image_url, imageTitle)">查看原图</button>
            <button type="button" class="btn btn-sm" :disabled="version.is_current || version.missing || version.changed || !!action || busy" @click="adopt(version)">{{ version.is_current ? '当前采用' : action === `adopt:${version.id}` ? '采用中…' : '采用此图' }}</button>
            <button v-if="!version.is_current" type="button" class="delete-history" :disabled="!!action || busy" @click="removeVersion(version)">{{ action === `remove:${version.id}` ? '删除中…' : '删除历史' }}</button>
          </div>
        </article>
      </div>
      <div v-else-if="!loading && !historyError" class="empty-history">暂无历史图片，生成或上传后会保留在这里。</div>
      <button v-if="hasMore" class="btn btn-sm history-more" type="button" :disabled="loading || !!action" @click="loadHistory(true)">加载更多历史</button>
    </section>

    <Teleport to="body">
      <div v-if="viewer" class="original-overlay" @click.self="closeViewer" @keydown.esc.stop.prevent="closeViewer">
        <section ref="viewerDialog" class="original-dialog" role="dialog" aria-modal="true" :aria-label="viewer.title + '原图'" tabindex="-1">
          <header><div><strong>{{ viewer.title }}</strong><span v-if="viewer.width && viewer.height">{{ viewer.width }} × {{ viewer.height }} 像素 · {{ fitImage ? '适应窗口' : '100% 原始像素' }}</span></div><div class="library-actions"><button type="button" class="btn btn-sm" @click="fitImage = !fitImage">{{ fitImage ? '100% 原始像素' : '适应窗口' }}</button><button type="button" class="btn btn-icon" aria-label="关闭原图" @click="closeViewer"><X :size="17" /></button></div></header>
          <div class="original-scroll" :class="{ fit: fitImage }"><img :src="viewer.url" :alt="viewer.title" @load="imageLoaded" /></div>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue'
import { Loader2, Plus, X, Check, RefreshCw } from 'lucide-vue-next'
import { assetImageAPI, uploadAPI } from '~/composables/useApi'
import { assetMediaUrl, assetImageDate, assetReferenceCapability, validateReferenceFiles, validateRedrawReferences } from '~/utils/asset-redraw.js'

const props = defineProps({ kind: { type: String, required: true }, asset: { type: Object, required: true }, config: { type: Object, default: null }, model: { type: String, default: '' }, busy: Boolean })
const emit = defineEmits(['current-change'])
const references = ref([]), referenceError = ref(''), uploading = ref(false), usedReferences = ref('[]')
const versions = ref([]), loading = ref(false), historyError = ref(''), action = ref(''), hasMore = ref(false), nextBeforeId = ref(null)
const viewer = ref(null), viewerDialog = ref(null), fitImage = ref(false)
const capability = computed(() => assetReferenceCapability(props.config, props.model))
const identity = computed(() => `${props.kind}:${props.asset?.id}`)
const currentUrl = computed(() => assetMediaUrl(props.asset?.image_url || props.asset?.imageUrl || props.asset?.local_path || props.asset?.localPath || ''))
const imageTitle = computed(() => props.asset?.name || props.asset?.location || '资产图片')
const locked = computed(() => props.busy || uploading.value || !!action.value)
let alive = true, session = 0, sequence = 0, returnFocus = null, refreshQueued = false
const current = (key, turn) => alive && identity.value === key && session === turn
function snapshotReferences() { return references.value.map(item => item.url) }
function hasUnsavedReferences() { return JSON.stringify(snapshotReferences()) !== usedReferences.value }
function isUploading() { return uploading.value }
function markReferencesUsed(snapshot) { if (JSON.stringify(snapshotReferences()) === JSON.stringify(snapshot)) usedReferences.value = JSON.stringify(snapshot) }
function validateReferences() {
  if (uploading.value) throw Error('参考图仍在上传，请等待完成后重绘。')
  if (referenceError.value) throw Error(referenceError.value)
  return validateRedrawReferences(references.value, capability.value)
}
function clearReferences() { references.value = []; referenceError.value = '' }
function removeReference(index) { references.value.splice(index, 1); referenceError.value = '' }
function useCurrent() {
  if (!currentUrl.value || locked.value) return
  if (references.value.some(item => assetMediaUrl(item.url) === currentUrl.value)) return
  try {
    validateRedrawReferences([...references.value, { url: currentUrl.value }], capability.value)
    references.value.push({ url: currentUrl.value, name: '当前采用图', bytes: 0 }); referenceError.value = ''
  } catch (cause) { referenceError.value = cause.message }
}
async function uploadReferences(event) {
  const files = [...(event.target.files || [])]; event.target.value = ''
  if (!files.length || locked.value) return
  try { validateReferenceFiles(files, references.value, capability.value) } catch (cause) { referenceError.value = cause.message; return }
  const key = identity.value, turn = session
  uploading.value = true; referenceError.value = ''
  try {
    for (const file of files) {
      const result = await uploadAPI.image(file)
      if (!current(key, turn)) return
      const url = result?.path || result?.url
      if (!url) throw Error('上传未返回图片地址，请重新上传。')
      references.value.push({ url, name: file.name, bytes: file.size })
    }
  } catch (cause) { if (current(key, turn)) referenceError.value = cause?.message || '参考图上传失败，请重试。' }
  finally { if (current(key, turn)) uploading.value = false }
}
function applyHistory(result, append = false) {
  if (result?.asset_type !== props.kind || Number(result?.asset_id) !== Number(props.asset?.id) || !Array.isArray(result.versions)) throw Error('图片历史与当前资产不一致，请刷新重试。')
  const rows = result.versions.map(row => ({ ...row, is_current: !!row.is_current }))
  if (append) {
    const seen = new Set(versions.value.map(row => row.id)); versions.value = [...versions.value, ...rows.filter(row => !seen.has(row.id))]
  } else versions.value = rows
  hasMore.value = !!result.has_more; nextBeforeId.value = result.next_before_id || null
  if (Object.hasOwn(result, 'current_url')) emit('current-change', { kind: props.kind, id: Number(props.asset.id), url: result.current_url })
}
async function loadHistory(append = false) {
  if (!alive || loading.value || !props.asset?.id) return
  const key = identity.value, turn = session, request = ++sequence
  loading.value = true; historyError.value = ''
  try {
    const result = await assetImageAPI.list(props.kind, Number(props.asset.id), 200, append ? nextBeforeId.value : undefined)
    if (current(key, turn) && sequence === request) applyHistory(result, append)
  } catch (cause) { if (current(key, turn) && sequence === request) historyError.value = cause?.message || '历史图片读取失败，请重试。' }
  finally {
    if (current(key, turn) && sequence === request) {
      loading.value = false
      if (refreshQueued) { refreshQueued = false; void loadHistory(false) }
    }
  }
}
function refreshHistory() { if (loading.value) { refreshQueued = true; return }; return loadHistory(false) }
async function mutateHistory(version, method) {
  if (action.value || props.busy || version.is_current || method === 'adopt' && (version.missing || version.changed)) return
  if (method === 'remove' && !window.confirm('删除这张历史图片记录？当前采用图和已有视频不会改变；可能被其他任务引用的本地文件会保留。')) return
  const key = identity.value, turn = session
  sequence++; loading.value = false; refreshQueued = false; action.value = `${method}:${version.id}`; historyError.value = ''
  try {
    const result = await assetImageAPI[method](props.kind, Number(props.asset.id), version.id)
    if (current(key, turn)) { sequence++; loading.value = false; applyHistory(result) }
  } catch (cause) {
    if (current(key, turn)) { const message = cause?.message || '历史图片操作失败，请重试。'; await refreshHistory(); if (current(key, turn)) historyError.value = message }
  } finally {
    if (current(key, turn)) {
      action.value = ''
      if (refreshQueued) { refreshQueued = false; void loadHistory(false) }
    }
  }
}
function adopt(version) { return mutateHistory(version, 'adopt') }
function removeVersion(version) { return mutateHistory(version, 'remove') }
async function viewImage(url, title) {
  returnFocus = typeof document === 'undefined' ? null : document.activeElement
  viewer.value = { url: assetMediaUrl(url), title, width: 0, height: 0 }; fitImage.value = false
  await nextTick(); viewerDialog.value?.focus?.({ preventScroll: true })
}
function imageLoaded(event) { if (viewer.value) { viewer.value.width = event.target.naturalWidth; viewer.value.height = event.target.naturalHeight } }
function openCurrentImage() { if (currentUrl.value) return viewImage(currentUrl.value, imageTitle.value) }
function closeViewer() { viewer.value = null; returnFocus?.focus?.({ preventScroll: true }); returnFocus = null }
watch(identity, () => {
  session++; sequence++; refreshQueued = false; references.value = []; usedReferences.value = '[]'; uploading.value = false; referenceError.value = ''
  versions.value = []; loading.value = false; action.value = ''; historyError.value = ''; hasMore.value = false; nextBeforeId.value = null; viewer.value = null
  void refreshHistory()
}, { immediate: true, flush: 'sync' })
watch(() => props.busy, (value, previous) => { if (previous && !value) void refreshHistory() })
watch(() => [props.config, props.model], () => { referenceError.value = '' })
onBeforeUnmount(() => { alive = false; session++; sequence++; viewer.value = null })
defineExpose({ snapshotReferences, hasUnsavedReferences, isUploading, markReferencesUsed, validateReferences, refreshHistory, openCurrentImage })
</script>

<style scoped>
.asset-image-library{min-width:0}.reference-section,.history-section{border-top:1px solid var(--surface-outline,var(--border));padding-top:17px;margin-top:18px}.library-heading,.library-heading>div,.library-actions{display:flex;align-items:center;gap:8px}.library-heading{justify-content:space-between;gap:12px;flex-wrap:wrap}.library-heading strong{font-size:12px;color:var(--text-1)}.muted,.library-hint{font-size:10px;color:var(--text-3)}.library-hint{line-height:1.75;margin:8px 0 0}.library-error{font-size:11px;line-height:1.7;color:var(--error,#bf4934);margin:9px 0;overflow-wrap:anywhere}.reference-grid{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}.reference-card{width:112px;position:relative;border:1px solid var(--border);border-radius:10px;background:var(--bg-1);overflow:hidden}.reference-image{display:block;width:100%;height:80px;border:0;background:var(--bg-2);padding:4px;cursor:zoom-in}.reference-image img{height:100%;width:100%;object-fit:contain}.reference-card>span{display:block;padding:6px 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-2);font-size:10px}.reference-remove{position:absolute;right:4px;top:4px;display:grid;place-items:center;width:21px;height:21px;border:1px solid var(--border);border-radius:50%;background:var(--bg-1);color:var(--text-2);cursor:pointer}.reference-add{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;width:112px;min-height:110px;border:1px dashed var(--border);border-radius:10px;color:var(--text-2);font-size:11px;cursor:pointer}.reference-add:hover{color:var(--accent);border-color:var(--accent)}.reference-add.disabled{opacity:.5;cursor:default}.reference-add input{display:none}.history-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:11px;margin-top:12px}.history-card{min-width:0;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--bg-1)}.history-card.current{border-color:var(--success,#35a77b)}.history-image-frame{position:relative;aspect-ratio:16/10;background:var(--bg-2)}.history-image{display:flex;align-items:center;justify-content:center;width:100%;height:100%;padding:0;border:0;background:transparent;cursor:zoom-in}.history-image img{width:100%;height:100%;object-fit:contain}.history-image:disabled{cursor:default}.missing-image{color:var(--text-3);font-size:11px}.current-badge{position:absolute;top:7px;left:7px;display:flex;align-items:center;gap:3px;padding:3px 6px;border-radius:5px;background:var(--success-bg,#e4f5ec);color:var(--tag-success-text,#21805b);font-size:10px;pointer-events:none}.history-meta{padding:8px;display:flex;justify-content:space-between;gap:5px;flex-wrap:wrap;color:var(--text-3);font-size:10px}.history-meta small{font-size:9px}.history-actions{display:flex;gap:5px;align-items:center;flex-wrap:wrap;padding:0 8px 9px}.history-actions .btn{font-size:9px;padding:4px 6px;min-height:25px}.delete-history{border:0;background:none;color:var(--error,#c65c4b);margin-left:auto;padding:4px 0;font-size:9px;cursor:pointer}.delete-history:disabled{opacity:.5;cursor:default}.empty-history{padding:20px 0;color:var(--text-3);font-size:11px}.history-more{margin-top:12px}.original-overlay{position:fixed;inset:0;z-index:20000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(20,25,36,.75);backdrop-filter:blur(4px)}.original-dialog{display:flex;flex-direction:column;width:calc(100vw - 48px);height:calc(100vh - 48px);min-height:0;border:1px solid var(--border);border-radius:14px;background:var(--bg-1,#fff);overflow:hidden;outline:none}.original-dialog header{display:flex;justify-content:space-between;align-items:center;gap:15px;padding:12px 16px;border-bottom:1px solid var(--border);flex-shrink:0}.original-dialog header>div:first-child{display:flex;flex-direction:column;gap:4px;min-width:0}.original-dialog strong{font-size:13px;color:var(--text-1)}.original-dialog header span{font-size:10px;color:var(--text-3)}.original-scroll{overflow:auto;min-height:0;flex:1;background:var(--bg-2,#f4f5f8)}.original-scroll img{display:block;width:auto;height:auto;max-width:none;max-height:none;margin:0}.original-scroll.fit{display:flex;align-items:center;justify-content:center;padding:12px}.original-scroll.fit img{width:auto;height:auto;max-width:100%;max-height:100%;object-fit:contain}.spinning{animation:asset-library-spin 1s linear infinite}@keyframes asset-library-spin{to{transform:rotate(360deg)}}@media(max-width:760px){.history-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.original-overlay{padding:10px}.original-dialog{width:calc(100vw - 20px);height:calc(100vh - 20px)}}@media(prefers-reduced-motion:reduce){.spinning{animation:none}}
</style>
