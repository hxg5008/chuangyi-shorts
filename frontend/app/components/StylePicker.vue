<template>
  <button type="button" class="style-picker-trigger" @click="openBrowser">
    <span v-if="selected?.cover" class="style-picker-thumb" :style="background(selected)"></span>
    <span class="style-picker-label"><strong>{{ selected?.name || placeholder }}</strong><small v-if="selected">{{ sourceLabel(selected.source) }} · {{ categoryLabel(selected.category) }}</small></span>
    <ChevronDown :size="15" />
  </button>
  <Teleport to="body">
    <div v-if="open" class="style-browser-overlay" @click.self="close" @keydown.esc.stop.prevent="close">
      <section ref="dialog" class="style-browser" role="dialog" aria-modal="true" aria-label="选择视觉风格" tabindex="-1">
        <header><div><h2>视觉风格</h2><p>点击卡片查看完整风格提示词，确认后采用。</p></div><button type="button" class="style-icon" aria-label="关闭风格库" @click="close"><X :size="19" /></button></header>
        <div class="style-browser-search"><Search :size="16" /><input v-model="query" placeholder="搜索名称、标签或风格特点" aria-label="搜索风格" /><span>{{ filtered.length }} 款</span></div>
        <div class="style-browser-body">
          <aside><button v-for="item in sources" :key="item.value" type="button" :class="{ active: source === item.value }" @click="source = item.value">{{ item.label }}<small>{{ sourceCount(item.value) }}</small></button></aside>
          <main><nav><button v-for="item in categories" :key="item.value" type="button" :class="{ active: category === item.value }" @click="category = item.value">{{ item.label }}</button></nav>
            <div class="style-browser-grid">
              <button v-for="item in filtered" :key="item.value" type="button" class="style-browser-card" :class="{ selected: pending === item.value }" @click="selectPreview(item.value)" @dblclick="apply(item.value)" :title="item.description || item.name" :aria-pressed="pending === item.value">
                <span class="style-cover" :style="background(item)"><span v-if="!item.cover" class="style-cover-title">{{ item.name }}</span><span v-if="pending === item.value" class="style-cover-check"><Check :size="13" /></span><span class="style-cover-source">{{ sourceLabel(item.source) }}</span></span>
                <strong>{{ item.name }}</strong><small>{{ (item.tags || []).join(' · ') || categoryLabel(item.category) }}</small>
              </button>
              <p v-if="!filtered.length" class="style-browser-empty">没有匹配的风格，试试其他关键词或分类。</p>
            </div>
          </main>
          <section class="style-detail" aria-label="风格详情">
            <template v-if="preview">
              <div class="style-detail-title"><span>风格库详情</span><h3>{{ preview.name }}</h3><div class="style-detail-tags"><span>{{ sourceLabel(preview.source) }}</span><span>{{ categoryLabel(preview.category) }}</span><span v-for="stage in preview.stages || []" :key="stage">{{ stageLabel(stage) }}</span><span v-if="preview.version">库版本 {{ preview.version.slice(0,8) }}</span></div></div>
              <p v-if="preview.description" class="style-detail-description">{{ preview.description }}</p>
              <div class="style-prompt-heading"><strong>完整风格提示词</strong><button type="button" class="style-prompt-copy" :disabled="!previewPrompt || copyState === 'copying'" @click="copyPrompt"><Check v-if="copyState === 'copied'" :size="13" /><Copy v-else :size="13" />{{ copyState === 'copied' ? '已复制' : copyState === 'copying' ? '复制中…' : '复制全文' }}</button></div>
              <textarea ref="promptArea" class="style-prompt-text" :value="previewPrompt" readonly spellcheck="false" aria-label="完整风格提示词" :placeholder="'这款风格暂未提供提示词。'" />
              <div class="style-prompt-meta"><span>{{ Array.from(previewPrompt).length.toLocaleString() }} 字符 · 原文</span><span v-if="previewPrompt.includes('{content}')">含内容插入位置</span></div>
              <p v-if="previewPrompt.includes('{content}')" class="style-prompt-hint">{content} 会替换为本次生成的内容，前后风格描述一并保留。</p>
              <p v-if="copyState === 'manual'" class="style-copy-feedback" role="status">浏览器未能自动复制。可在提示词框中全选，按 Ctrl＋C 复制。</p>
              <p v-else-if="copyState === 'copied'" class="style-copy-feedback success" role="status">完整提示词已复制。</p>
            </template>
            <div v-else class="style-detail-empty"><Palette :size="28" /><strong>查看风格详情</strong><p>点击左侧任意风格，查看它的完整提示词。</p></div>
          </section>
        </div>
        <footer><div><strong>{{ preview?.name || '请选择风格' }}</strong><p>{{ preview?.description || '中文和英文风格均按原文使用，不自动切换模型。' }}</p></div><button type="button" class="btn" @click="close">取消</button><button type="button" class="btn btn-primary" :disabled="!pending" @click="apply(pending)">采用风格</button></footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup>
import { Check, ChevronDown, Copy, Palette, Search, X } from 'lucide-vue-next'
import { nextTick, onBeforeUnmount, ref, computed, watch } from 'vue'
const props = defineProps({ modelValue: { type: String, default: '' }, styles: { type: Array, default: () => [] }, placeholder: { type: String, default: '选择视觉风格' } })
const emit = defineEmits(['update:modelValue'])
const open = ref(false), dialog = ref(null), pending = ref(''), query = ref(''), source = ref('all'), category = ref('all')
const promptArea = ref(null), copyState = ref('')
const sources = [{ value: 'all', label: '全部来源' }, { value: 'xyq', label: '小云雀' }, { value: 'yingce', label: '影策' }, { value: 'original', label: '原有风格' }, { value: 'custom', label: '自定义' }]
const categories = [{ value: 'all', label: '全部' }, { value: 'live', label: '真人' }, { value: '2d', label: '2D 漫剧' }, { value: '3d', label: '3D 动画' }, { value: 'art', label: '艺术风格' }, { value: 'other', label: '其他' }]
const sourceLabel = value => sources.find(item => item.value === value)?.label || '原有风格'
const categoryLabel = value => categories.find(item => item.value === value)?.label || '其他'
const selected = computed(() => props.styles.find(item => item.value === props.modelValue))
const preview = computed(() => props.styles.find(item => item.value === pending.value))
const previewPrompt = computed(() => typeof preview.value?.template === 'string' && preview.value.template.length ? preview.value.template : typeof preview.value?.prompt === 'string' ? preview.value.prompt : '')
const stageLabel = value => ({ asset_image: '资产图', storyboard: '分镜', video: '视频' })[value] || value
const sourceCount = value => props.styles.filter(item => value === 'all' || (item.source || 'original') === value).length
const filtered = computed(() => props.styles.filter(item => (source.value === 'all' || (item.source || 'original') === source.value) && (category.value === 'all' || (item.category || 'other') === category.value) && (!query.value.trim() || [item.name, item.description, ...(item.tags || [])].join(' ').toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase()))))
function background(item) {
  const palette = item?.palette || ['#252735', '#646b88', '#d4a776']
  const cover = /^\/style-covers\/[a-zA-Z0-9._-]+$/.test(item?.cover || '') ? item.cover : ''
  return { background: cover ? `center / cover no-repeat url("${cover}")` : `radial-gradient(ellipse at 80% 15%, ${palette[2]}, transparent 70%), linear-gradient(150deg, ${palette[0]}, ${palette[1]})` }
}
let previousFocus, copySequence = 0
watch(previewPrompt, () => resetCopy(), { flush: 'sync' })
function resetCopy() { copySequence++; copyState.value = '' }
function selectPreview(value) { if (!props.styles.some(item => item.value === value)) return; pending.value = value; resetCopy() }
function close() { open.value = false; resetCopy(); nextTick(() => previousFocus?.focus?.()) }
function openBrowser() { previousFocus = document.activeElement; pending.value = props.modelValue; resetCopy(); open.value = true; nextTick(() => dialog.value?.focus()) }
async function copyPrompt() {
  const text = previewPrompt.value, value = pending.value
  if (!open.value || !text || copyState.value === 'copying') return
  const sequence = ++copySequence
  copyState.value = 'copying'
  const current = () => open.value && sequence === copySequence && pending.value === value && previewPrompt.value === text
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
    await navigator.clipboard.writeText(text)
    if (current()) copyState.value = 'copied'
  } catch {
    if (!current()) return
    promptArea.value?.focus?.(); promptArea.value?.select?.()
    copyState.value = 'manual'
  }
}
function apply(value) { if (!props.styles.some(item => item.value === value)) return; emit('update:modelValue', value); close() }
onBeforeUnmount(() => { open.value = false; resetCopy() })
</script>

<style scoped>
.style-picker-trigger{display:flex;align-items:center;gap:10px;width:100%;min-height:46px;border:1px solid var(--border,#e0e4ed);border-radius:12px;padding:8px 12px;background:var(--surface,#fff);text-align:left;cursor:pointer}.style-picker-thumb{width:46px;height:30px;border-radius:6px;flex-shrink:0}.style-picker-label{display:flex;flex:1;flex-direction:column;gap:3px;font-size:13px;min-width:0}.style-picker-label strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.style-picker-label small{color:#8992a5;font-size:10px;font-weight:400}.style-browser-overlay{position:fixed;inset:0;background:#18203480;backdrop-filter:blur(5px);z-index:2000;display:flex;align-items:center;justify-content:center;padding:24px}.style-browser{display:flex;flex-direction:column;background:#fff;color:#1e2534;width:min(100%,1000px);max-height:min(800px,90dvh);border-radius:22px;box-shadow:0 30px 100px #14203844;overflow:hidden;outline:none}.style-browser header{display:flex;justify-content:space-between;padding:23px 26px 16px;gap:20px}.style-browser h2{margin:0;font-size:23px;letter-spacing:-.5px}.style-browser header p{margin:7px 0 0;font-size:12px;color:#8b94a7}.style-icon{display:grid;place-items:center;align-self:flex-start;border:0;background:#f3f5f8;color:#8490a2;padding:8px;border-radius:50%;cursor:pointer}.style-browser-search{margin:0 26px 17px;display:flex;align-items:center;gap:10px;border:1px solid #e4e7ef;background:#f8f9fc;border-radius:11px;padding:11px 14px;color:#8993a5}.style-browser-search input{flex:1;min-width:0;border:0;outline:none;background:transparent;font-size:13px;color:#1e2534}.style-browser-search span{font-size:11px;white-space:nowrap}.style-browser-body{display:flex;min-height:240px;overflow:hidden;border-top:1px solid #edf0f5}.style-browser aside{padding:16px 12px;width:142px;background:#fafbfc;flex-shrink:0;overflow:auto}.style-browser aside button{display:flex;align-items:center;justify-content:space-between;width:100%;border:0;border-radius:9px;padding:12px 10px;background:transparent;text-align:left;cursor:pointer;font-size:12px;color:#6b778a;margin-bottom:4px}.style-browser aside button.active{color:#ef711a;background:#fff0e6;font-weight:700}.style-browser aside small{font-size:10px;opacity:.75}.style-browser main{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden}.style-browser nav{display:flex;gap:6px;padding:14px 18px;overflow:auto;flex-shrink:0}.style-browser nav button{border:1px solid #e8ebf1;border-radius:18px;padding:7px 12px;white-space:nowrap;background:#fff;color:#7c8799;font-size:11px;cursor:pointer}.style-browser nav button.active{background:#202633;color:#fff;border-color:#202633}.style-browser-grid{padding:0 18px 20px;overflow:auto;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:13px;align-content:start}.style-browser-card{display:flex;flex-direction:column;gap:5px;min-width:0;padding:5px;border:1px solid transparent;border-radius:12px;text-align:left;background:#fff;color:#273045;cursor:pointer;transition:background .15s,border-color .15s}.style-browser-card:hover{background:#f7f8fb}.style-browser-card.selected{border-color:#ff8b38;background:#fff7f1}.style-cover{aspect-ratio:1.6;display:flex;align-items:center;justify-content:center;position:relative;width:100%;border-radius:8px;overflow:hidden}.style-cover-title{color:#fff;font-size:18px;font-weight:700;text-align:center;padding:12px;text-shadow:0 2px 12px #0006}.style-cover-check{position:absolute;right:6px;top:6px;background:#ff842d;color:#fff;border:2px solid #fff;border-radius:50%;width:21px;height:21px;display:grid;place-items:center}.style-cover-source{position:absolute;bottom:5px;left:5px;padding:3px 5px;border-radius:4px;background:#15203199;color:#fff;font-size:9px}.style-browser-card>strong{font-size:12px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:100%;padding:0 2px}.style-browser-card>small{font-size:10px;color:#97a0b0;padding:0 2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}.style-browser footer{display:flex;align-items:center;gap:10px;flex-shrink:0;border-top:1px solid #edf0f5;padding:16px 26px}.style-browser footer>div{flex:1;min-width:0}.style-browser footer strong{font-size:13px}.style-browser footer p{font-size:11px;color:#8f99ab;margin:5px 20px 0 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.style-browser-empty{grid-column:1/-1;text-align:center;padding:60px 10px;color:#97a0b0;font-size:13px}@media(max-width:750px){.style-browser-overlay{padding:12px}.style-browser-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.style-browser aside{width:105px;padding:12px 6px}.style-browser header,.style-browser footer{padding:17px}.style-browser-search{margin:0 17px 13px}.style-browser header p{font-size:10px}.style-browser nav{padding:12px}.style-browser-grid{padding:0 12px 12px}.style-browser footer p{display:none}.style-browser footer .btn{font-size:11px;padding:9px 12px}}
.style-browser{width:min(100%,1220px);height:min(800px,90dvh)}
.style-browser-body{flex:1;min-height:0}
.style-browser main{min-height:0}
.style-browser-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
.style-detail{display:flex;flex-direction:column;gap:12px;flex:0 0 330px;min-width:0;min-height:0;overflow:auto;border-left:1px solid #edf0f5;background:#fafbfe;padding:21px 20px 16px}
.style-detail-title>span{font-size:10px;color:#9aa4b5;letter-spacing:.08em}
.style-detail h3{font-size:21px;line-height:1.35;margin:7px 0 12px;overflow-wrap:anywhere}
.style-detail-tags{display:flex;gap:5px;flex-wrap:wrap}
.style-detail-tags span{font-size:10px;color:#768399;background:#edf0f6;padding:4px 7px;border-radius:5px}
.style-detail-tags span:first-child{background:#fff0e6;color:#ed7b2c}
.style-detail-description{font-size:12px;line-height:1.75;color:#79869b;margin:0;white-space:pre-wrap;overflow-wrap:anywhere;max-height:90px;overflow:auto;flex-shrink:0}
.style-prompt-heading{display:flex;align-items:center;gap:8px;justify-content:space-between;margin-top:5px;flex-shrink:0}
.style-prompt-heading strong{font-size:12px;color:#39465c}
.style-prompt-copy{display:flex;align-items:center;gap:5px;border:1px solid #e5e9f1;border-radius:7px;background:#fff;color:#6d7e96;padding:6px 8px;font-size:10px;cursor:pointer;white-space:nowrap}
.style-prompt-copy:hover:not(:disabled){color:#f27d28;border-color:#ffcfae;background:#fff8f3}
.style-prompt-copy:disabled{opacity:.55;cursor:default}
.style-prompt-text{display:block;box-sizing:border-box;width:100%;flex:1 1 220px;min-height:160px;max-height:none;resize:none;overflow:auto;border:1px solid #e4e8f0;background:#fff;border-radius:11px;padding:13px;color:#3e4b60;font:12px/1.85 ui-monospace,SFMono-Regular,Consolas,'Microsoft YaHei',monospace;white-space:pre-wrap;overflow-wrap:anywhere;outline:none}
.style-prompt-text:focus{border-color:#ffb174;box-shadow:0 0 0 3px #ff9b4d12}
.style-prompt-meta{display:flex;justify-content:space-between;gap:8px;color:#9aa4b5;font-size:10px;flex-shrink:0}
.style-prompt-hint,.style-copy-feedback{font-size:10px;line-height:1.65;color:#9aa4b5;margin:0;flex-shrink:0}
.style-copy-feedback{color:#c27a30}.style-copy-feedback.success{color:#31977c}
.style-detail-empty{display:flex;flex:1;align-items:center;justify-content:center;text-align:center;flex-direction:column;gap:14px;color:#a0aaba;padding:30px 8px}
.style-detail-empty strong{font-size:14px;font-weight:500}.style-detail-empty p{font-size:12px;line-height:1.7;margin:0}
@media(max-width:1080px){.style-detail{flex-basis:295px;padding:18px 16px}.style-browser-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.style-browser aside{width:120px}}
@media(max-width:800px){.style-browser-overlay{padding:12px}.style-browser{height:94dvh;max-height:94dvh;border-radius:17px}.style-browser-body{display:grid;grid-template-columns:100px minmax(0,1fr);grid-template-rows:minmax(0,1fr) minmax(0,.9fr)}.style-browser aside{width:100%;box-sizing:border-box;grid-column:1;grid-row:1}.style-browser main{grid-column:2;grid-row:1}.style-detail{grid-column:1/-1;grid-row:2;flex-basis:auto;border-left:0;border-top:1px solid #edf0f5;padding:12px 16px;gap:8px}.style-detail-title{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.style-detail-title>span{display:none}.style-detail h3{font-size:16px;margin:0}.style-detail-description{max-height:44px;font-size:11px}.style-prompt-heading{margin-top:0}.style-prompt-text{min-height:75px;flex-basis:95px;font-size:11px;padding:9px 11px}.style-prompt-hint{display:none}.style-browser header,.style-browser footer{padding:13px 16px}.style-browser-search{margin:0 16px 12px}.style-browser header p{font-size:10px}}
@media(max-height:600px) and (min-width:801px){.style-browser-overlay{padding:12px}.style-browser{height:95dvh;max-height:95dvh}.style-browser header{padding:14px 20px 10px}.style-browser-search{margin-bottom:10px;padding:8px 12px}.style-browser footer{padding:11px 20px}.style-detail{padding:12px;gap:8px}.style-detail-description{max-height:45px}.style-detail h3{font-size:17px;margin:4px 0 7px}.style-prompt-text{min-height:95px}.style-prompt-hint{display:none}}
</style>
