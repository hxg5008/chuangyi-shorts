<template>
  <section class="protocol-picker" aria-label="请求协议选择">
    <div class="protocol-picker-head"><strong>请求协议</strong><span>选择与上游接口匹配的协议，模型名称保持原样。</span></div>
    <div class="protocol-picker-body">
      <div class="protocol-picker-list">
        <label class="protocol-search"><Search :size="13" /><input v-model="search" type="search" aria-label="搜索请求协议" placeholder="搜索协议名称、供应商或 ID" /></label>
        <div class="protocol-options" role="listbox" aria-label="可选请求协议">
          <button v-for="protocol in visible" :key="protocol.id" type="button" role="option" :aria-selected="protocol.id === modelValue" :disabled="protocol.executable === false" :class="['protocol-option',{selected:protocol.id === modelValue}]" @click="choose(protocol)">
            <span><strong>{{ protocol.name || protocol.id }}</strong><small>{{ protocol.id }}</small><small>{{ originLabel(protocol) }}<template v-if="protocol.plugin_version"> · v{{ protocol.plugin_version }}</template></small></span><span v-if="protocol.executable === false" class="protocol-unavailable">暂不可用</span><Check v-else-if="protocol.id === modelValue" :size="14" />
          </button>
          <p v-if="!visible.length" class="protocol-empty">没有匹配的{{ kindLabel }}协议。</p>
        </div>
      </div>
      <aside class="protocol-detail" aria-live="polite">
        <template v-if="selected">
          <div class="protocol-detail-title"><strong>{{ selected.name || selected.id }}</strong><span :class="['protocol-state',{unavailable:selected.executable === false}]">{{ selected.executable === false ? '暂不可执行' : '已选择' }}</span></div>
          <code>{{ selected.id }}</code>
          <p>{{ selected.description || '此协议负责请求编码、素材传参与响应解析。' }}</p>
          <dl><div><dt>模型类型</dt><dd>{{ kindLabel }}</dd></div><div><dt>协议来源</dt><dd>{{ originLabel(selected) }}</dd></div><div><dt>供应商标识</dt><dd>{{ selected.provider || '未提供' }}</dd></div><div v-if="selected.provider_id"><dt>Provider ID</dt><dd>{{ selected.provider_id }}</dd></div><div v-if="selected.plugin_id"><dt>插件 ID</dt><dd>{{ selected.plugin_id }}</dd></div><div v-if="selected.plugin_version"><dt>插件版本</dt><dd>{{ selected.plugin_version }}</dd></div></dl>
          <div v-if="declaredCapabilities.length" class="protocol-parameters"><span>已声明能力</span><div><small v-for="item in declaredCapabilities" :key="item.key">{{ item.label }}：{{ item.value }}</small></div></div>
          <div v-if="parameterLabels.length" class="protocol-parameters"><span>可配置参数</span><div><small v-for="label in parameterLabels" :key="label">{{ label }}</small></div></div>
          <p v-if="selected.executable === false" class="protocol-warning">{{ selected.unavailable_reason || '此协议当前不能执行，请选择可用协议后保存。' }}已有配置不会被自动替换。</p>
        </template>
        <div v-else class="protocol-detail-empty"><Network :size="26" /><strong>选择一个协议</strong><p>左侧选择后，可在这里查看用途和已声明参数。</p></div>
      </aside>
    </div>
  </section>
</template>

<script setup>
import {computed,ref,watch} from 'vue'
import {Search,Check,Network} from 'lucide-vue-next'
const props=defineProps({modelValue:{type:String,default:''},options:{type:Array,default:()=>[]},kind:{type:String,default:'text'}})
const emit=defineEmits(['update:modelValue','change'])
const search=ref('')
const kindLabel=computed(()=>({text:'文字',image:'图片',video:'视频'})[props.kind]||'模型')
const visible=computed(()=>{const needle=search.value.trim().toLowerCase();return props.options.filter(item=>!needle||[item.name,item.id,item.provider,item.provider_id,item.plugin_id,item.source,item.description].filter(Boolean).join(' ').toLowerCase().includes(needle))})
const selected=computed(()=>props.options.find(item=>item.id===props.modelValue)||null)
const parameterLabels=computed(()=>Array.isArray(selected.value?.parameters)?selected.value.parameters.map(item=>item.label||item.key).filter(Boolean):[])
const capabilityLabels={tools:'工具调用',structured_output:'结构化输出',stream:'增量流式',reference_images:'参考图片',reference_video:'参考视频',reference_audio:'参考音频',max_images:'参考图片上限',max_concurrency:'并发上限'}
const declaredCapabilities=computed(()=>{const values=selected.value?.capabilities||{};return Object.entries(capabilityLabels).filter(([key])=>Object.hasOwn(values,key)&&values[key]!==undefined&&values[key]!==null).map(([key,label])=>({key,label,value:typeof values[key]==='boolean'?(values[key]?'支持':'不支持'):String(values[key])}))})
function originLabel(protocol){const source=protocol.source;if(source==='builtin')return '内置协议';if(source==='imported')return '导入协议';return source||(!protocol.custom?'内置协议':'自定义协议')}
function choose(protocol){if(protocol.executable===false)return;emit('update:modelValue',protocol.id);emit('change',protocol.id)}
watch(()=>props.kind,()=>{search.value=''})
</script>

<style scoped>
.protocol-picker{border:1px solid var(--border);border-radius:12px;overflow:hidden;min-width:0}.protocol-picker-head{padding:13px 15px;background:var(--bg-0);border-bottom:1px solid var(--border);display:flex;gap:12px;align-items:center;flex-wrap:wrap}.protocol-picker-head strong{font-size:12px}.protocol-picker-head>span{font-size:10px;color:var(--text-3);font-weight:400}.protocol-picker-body{display:grid;grid-template-columns:minmax(235px,.95fr) minmax(0,1.2fr);min-height:255px}.protocol-picker-list{padding:12px;border-right:1px solid var(--border);min-width:0}.protocol-search{display:flex!important;align-items:center;gap:8px;border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:var(--text-3)}.protocol-search input{width:100%;min-width:0;border:0;outline:0;background:none;color:var(--text-1);font-size:11px}.protocol-options{max-height:235px;overflow:auto;margin-top:9px;display:grid;gap:5px}.protocol-option{display:flex;width:100%;align-items:center;justify-content:space-between;gap:10px;padding:10px;text-align:left;border:1px solid transparent;border-radius:8px;background:none;color:var(--text-2);cursor:pointer}.protocol-option:hover:not(:disabled){background:var(--bg-hover)}.protocol-option.selected{background:var(--accent-bg);border-color:var(--accent-glow);color:var(--accent-text)}.protocol-option>span:first-child{min-width:0;display:grid;gap:4px}.protocol-option strong{font-size:11px;overflow-wrap:anywhere}.protocol-option small{font-size:9px;font-family:var(--font-mono);overflow-wrap:anywhere;color:var(--text-3)}.protocol-option:disabled{opacity:.6;cursor:not-allowed}.protocol-unavailable{font-size:9px;white-space:nowrap;color:var(--text-3)}.protocol-detail{padding:17px 19px;min-width:0;background:var(--bg-0)}.protocol-detail-title{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.protocol-detail-title strong{font-size:13px;line-height:1.5}.protocol-state{white-space:nowrap;font-size:9px;color:var(--success);background:var(--success-bg);padding:3px 6px;border-radius:5px}.protocol-state.unavailable{color:var(--text-3);background:var(--bg-2)}.protocol-detail>code{display:block;font-size:9px;color:var(--text-3);overflow-wrap:anywhere;margin-top:8px}.protocol-detail p{font-size:11px;line-height:1.8;color:var(--text-2);margin:12px 0}.protocol-detail dl{display:grid;gap:9px;font-size:10px;margin:14px 0}.protocol-detail dl>div{display:grid;grid-template-columns:80px 1fr;gap:10px}.protocol-detail dt{color:var(--text-3)}.protocol-detail dd{margin:0;overflow-wrap:anywhere}.protocol-parameters>span{font-size:10px;color:var(--text-3)}.protocol-parameters>div{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px}.protocol-parameters small{font-size:9px;padding:4px 6px;border:1px solid var(--border);border-radius:5px;color:var(--text-2)}.protocol-detail .protocol-warning{color:var(--warning);font-size:10px}.protocol-empty{font-size:11px;color:var(--text-3);padding:20px 8px}.protocol-detail-empty{display:grid;justify-items:center;align-content:center;height:100%;color:var(--text-3);gap:10px;text-align:center}.protocol-detail-empty strong{font-size:12px}.protocol-detail-empty p{font-size:10px;margin:0}@media(max-width:720px){.protocol-picker-body{grid-template-columns:1fr}.protocol-picker-list{border-right:0;border-bottom:1px solid var(--border)}.protocol-options{max-height:180px}.protocol-detail{padding:14px}.protocol-picker-head{align-items:flex-start;gap:5px;flex-direction:column}}
</style>
