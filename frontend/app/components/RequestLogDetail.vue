<template>
  <Teleport to="body">
    <div class="request-detail-overlay" @click.self="close" @keydown.esc.stop.prevent="close">
      <section ref="panel" class="request-detail" role="dialog" aria-modal="true" aria-labelledby="request-detail-title" tabindex="-1">
        <header class="request-detail-header">
          <div class="detail-title"><span class="detail-icon"><Activity :size="19" /></span><div><h2 id="request-detail-title">请求日志详情</h2><p>{{ requestKindLabel(request?.kind) }}<template v-if="request?.model"> · {{ request.model }}</template> · {{ formatRequestTime(request?.created_at, true) }}</p></div></div>
          <div class="detail-header-actions"><button class="btn btn-sm" :disabled="loading" @click="refreshDetails"><RefreshCw :size="13" :class="{ 'animate-spin': loading }" />{{ loading ? '刷新中…' : '刷新详情' }}</button><button class="btn btn-sm" :disabled="loading || exporting || !detail" @click="exportDetail"><Download :size="13" />导出详情</button><button class="btn btn-icon" aria-label="关闭请求详情" @click="close"><X :size="19" /></button></div>
        </header>
        <div v-if="loading && !detail" class="detail-empty"><Loader2 :size="24" class="animate-spin" /><p>正在读取请求详情…</p></div>
        <div v-else-if="error && !detail" class="detail-empty"><AlertCircle :size="24" /><p role="alert">{{ error }}</p><button class="btn" @click="refreshDetails">重试读取</button></div>
        <div v-else-if="detail" ref="scrollPane" class="request-detail-scroll">
          <p v-if="error" class="detail-refresh-note warning" role="alert">{{ error }} 当前保留上次读取的内容，可点击刷新详情重试。</p>
          <p v-else-if="autoPaused" class="detail-refresh-note">自动刷新已达到本次等待上限。请求状态未因此改为失败，可点击刷新详情继续查看。</p>
          <p v-else-if="request.status === 'running'" class="detail-refresh-note">请求进行中，每 2.5 秒刷新一次已记录的详情。</p>
          <section class="detail-overview">
            <div class="section-title"><h3>请求概览</h3><span :class="['request-status', request.status]"><i />{{ requestStatusLabel(request.status, request) }}</span></div>
            <div class="detail-grid">
              <div><span>发起用户</span><strong>{{ userName }}</strong><small v-if="request.user_name">@{{ request.user_name }}</small></div>
              <div><span>项目 / 集数</span><strong>{{ request.project_title || (request.project_id ? `项目 #${request.project_id}` : '未记录') }}</strong><small v-if="request.episode_number">第 {{ request.episode_number }} 集</small></div>
              <div><span>模型 / 渠道</span><strong>{{ request.model || '未记录' }}</strong><small>{{ request.channel_name || '渠道未记录' }}</small></div>
              <div><span>请求阶段</span><strong>{{ requestPhaseLabel(request.phase) }}</strong><small>{{ requestKindLabel(request.kind) }}</small></div>
              <div><span>请求耗时</span><strong>{{ formatRequestSeconds(request.duration_ms) }}</strong><small>响应头等待：{{ formatRequestSeconds(request.headers_ms) }}</small><small>首块读取（客户端观测）：{{ formatRequestSeconds(request.ttfb_ms) }}</small></div>
              <div><span>HTTP 状态</span><strong>{{ request.http_status ?? '未记录' }}</strong><small v-if="request.business_status != null">上游业务状态：{{ request.business_status }}</small><small>HTTP 成功不代表视频已经生成</small></div>
            </div>
            <div v-if="tokenUsage" class="detail-token-usage" aria-label="上游 Token 用量"><span>上游 Token 用量<small>仅显示已记录的 usage</small></span><div><span>输入</span><strong>{{ tokenUsage.input ?? '未提供' }}</strong></div><div><span>输出</span><strong>{{ tokenUsage.output ?? '未提供' }}</strong></div><div><span>总计</span><strong>{{ tokenUsage.total ?? '未提供' }}</strong></div></div>
            <div class="detail-identifiers">
              <div v-for="entry in identifiers" :key="entry.label"><span>{{ entry.label }}</span><div><code>{{ entry.value || '未记录' }}</code><button v-if="entry.value" class="copy-icon" :aria-label="`复制${entry.label}`" @click="copy(String(entry.value))"><Copy :size="12" /></button></div></div>
            </div>
            <div class="detail-endpoint"><span>{{ request.method === 'INTERNAL' ? '本地检查位置（未发送模型请求）' : '实际请求地址' }}</span><code>{{ request.method || '—' }} {{ request.url || request.path || '未记录' }}</code></div>
            <p v-if="request.error" class="detail-error">{{ request.error }}</p>
            <div class="detail-related"><NuxtLink v-if="taskLink" :to="taskLink" class="btn btn-sm" @click="close"><ExternalLink :size="12" />查看原任务</NuxtLink><NuxtLink v-if="channelLink" :to="channelLink" class="btn btn-sm" @click="close"><Settings2 :size="12" />查看模型渠道</NuxtLink></div>
          </section>

          <section class="detail-payload">
            <div class="section-title"><h3>请求与响应</h3><span class="detail-disclosure">凭证已脱敏 · 媒体字节不写入日志</span></div>
            <nav class="payload-tabs" aria-label="请求详情内容"><button v-for="item in tabs" :key="item.id" :class="{ active: tab === item.id }" @click="tab = item.id">{{ item.name }}</button></nav>
            <template v-if="tab === 'request' || tab === 'response'">
              <div class="payload-toolbar"><span>{{ tab === 'request' ? '最终出站请求的日志副本' : '上游返回内容的日志副本' }}</span><button class="copy-text" :disabled="!bodyText" @click="copy(bodyText)"><Copy :size="12" />复制正文</button></div>
              <p v-if="bodyTruncated" class="payload-note warning">本条正文过长，日志仅保留部分内容。真实发送的请求和上游响应未因此修改。</p>
              <p v-if="!bodyRecorded" class="payload-note">这条记录没有保存{{ tab === 'request' ? '请求' : '响应' }}正文，不代表实际请求为空。</p>
              <pre v-if="bodyText" ref="bodyPane" class="payload-body">{{ bodyText }}</pre>
              <div v-else class="payload-unavailable">{{ bodyRecorded ? '已记录，本条正文为空。' : '正文未记录' }}</div>
              <details v-if="headersText" class="payload-headers"><summary>{{ tab === 'request' ? '请求头' : '响应头' }}（脱敏）</summary><pre>{{ headersText }}</pre></details>
            </template>
            <template v-else>
              <p class="payload-note">以下为已记录的关联调用。查询、上传和下载不是重新生成；缺少历史信息时不补猜。</p>
              <div class="process-meta"><div><span>发起时间</span><strong>{{ formatRequestTime(request.created_at, true) }}</strong></div><div><span>收到响应头</span><strong>{{ formatRequestTime(request.headers_at, true) }}</strong></div><div><span>结束时间</span><strong>{{ formatRequestTime(request.finished_at, true) }}</strong></div></div>
              <div v-if="children.length" class="child-requests"><button v-for="child in children" :key="child.id" @click="$emit('select', String(child.id))"><span :class="['child-dot', child.status]" /><span><strong>{{ requestPhaseLabel(child.phase) }} · {{ child.method || '—' }} {{ child.path || child.url || '地址未记录' }}</strong><small>{{ requestStatusLabel(child.status, child) }} · {{ formatRequestTime(child.created_at) }} · {{ formatRequestSeconds(child.duration_ms) }}<template v-if="child.attempt_no"> · 第 {{ child.attempt_no }} 次尝试</template></small></span><ChevronRight :size="14" /></button></div>
              <p v-if="children.length >= 500" class="payload-note">此处最多展示 500 条关联请求，不能据此判断已展示全部。<NuxtLink v-if="relatedListLink" :to="relatedListLink" @click="close">回列表按业务任务号筛选</NuxtLink><span v-else>可回列表缩小时间范围查询。</span></p>
              <p v-else class="payload-unavailable">暂无已关联的子请求记录。</p>
            </template>
          </section>
        </div>
        <footer class="request-detail-footer"><span>只查看已记录的信息，不会自动重发模型请求。</span><button class="btn btn-sm" @click="close">关闭</button></footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { Activity, X, Download, Loader2, AlertCircle, Copy, ExternalLink, Settings2, ChevronRight, RefreshCw } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { requestLogAPI, downloadRequestLog } from '~/composables/useRequestLogs'
import { createLatestRequestRunner, requestBodyText, requestTokenUsage, requestTaskLink, requestChannelLink, requestKindLabel, requestPhaseLabel, requestStatusLabel, formatRequestTime, formatRequestSeconds } from '~/utils/request-logs.js'

const props = defineProps({ id: { type: String, required: true } })
const emit = defineEmits(['close', 'select'])
const panel = ref(null), scrollPane = ref(null), bodyPane = ref(null), detail = ref(null), loading = ref(false), error = ref(''), exporting = ref(false), tab = ref('request'), autoPaused = ref(false)
const runner = createLatestRequestRunner(), tabs = [{ id:'request',name:'请求正文' },{ id:'response',name:'响应正文' },{ id:'process',name:'关联过程' }]
const AUTO_POLL_DELAY = 2500, AUTO_POLL_MAX = 240, AUTO_POLL_WINDOW = 10 * 60_000
let alive = true, closed = false, denied = false, pollTimer = null, pollCount = 0, pollDeadline = 0, viewRevision = 0
const returnFocus = typeof document !== 'undefined' ? document.activeElement : null
const request = computed(() => detail.value?.request || null)
const children = computed(() => Array.isArray(detail.value?.children) ? detail.value.children : [])
const tokenUsage = computed(() => requestTokenUsage(detail.value?.response_body))
const userName = computed(() => request.value?.user_display_name || request.value?.user_name || (request.value?.user_id != null ? `用户 #${request.value.user_id}` : '发起人未记录'))
const taskLink = computed(() => requestTaskLink(request.value)), channelLink = computed(() => requestChannelLink(request.value))
const relatedListLink = computed(() => request.value?.task_id ? '/admin/requests?' + new URLSearchParams({q:String(request.value.task_id),phase:'all'}) : '')
const identifiers = computed(() => [{label:'日志 ID',value:request.value?.id},{label:'业务任务 ID',value:request.value?.task_id},{label:'模型轮次 ID',value:request.value?.round_id},{label:'尝试次数',value:request.value?.attempt_no},{label:'上游请求 ID',value:request.value?.upstream_request_id},{label:'上游任务 ID',value:request.value?.upstream_task_id}])
const bodyText = computed(() => requestBodyText(tab.value === 'request' ? detail.value?.request_body : detail.value?.response_body))
const headersText = computed(() => requestBodyText(tab.value === 'request' ? detail.value?.request_headers : detail.value?.response_headers))
const bodyRecorded = computed(() => (tab.value === 'request' ? request.value?.request_recorded : request.value?.response_recorded) === true || (tab.value === 'request' ? detail.value?.request_body : detail.value?.response_body) != null)
const bodyTruncated = computed(() => tab.value === 'request' ? request.value?.request_truncated : request.value?.response_truncated)
function stopPolling() { if (pollTimer !== null) clearTimeout(pollTimer); pollTimer = null }
function resetPollBudget() { pollCount = 0; pollDeadline = Date.now() + AUTO_POLL_WINDOW; autoPaused.value = false }
function schedulePoll() {
  stopPolling()
  if (!alive || closed || denied || request.value?.status !== 'running') return
  if (pollCount >= AUTO_POLL_MAX || Date.now() >= pollDeadline) { autoPaused.value = true; return }
  const id = props.id
  pollTimer = setTimeout(() => {
    pollTimer = null
    if (!alive || closed || denied || id !== props.id) return
    if (pollCount >= AUTO_POLL_MAX || Date.now() >= pollDeadline) { autoPaused.value = true; return }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { schedulePoll(); return }
    void load({ automatic:true })
  }, AUTO_POLL_DELAY)
}
async function load({ reset = false, automatic = false } = {}) {
  if (!alive || closed || loading.value && !reset) return
  stopPolling()
  if (reset) { runner.cancel(); detail.value = null; denied = false; resetPollBudget() }
  if (automatic) pollCount++
  const id = props.id, revision = viewRevision; loading.value = true; error.value = ''
  const result = await runner.run(signal => requestLogAPI.detail(id, signal))
  if (!result.current || !alive || closed || id !== props.id || revision !== viewRevision) return
  loading.value = false
  if (result.error) {
    error.value = result.error.message || '读取请求详情失败。'
    if ([401,403,404].includes(result.error.status)) { denied = true; detail.value = null; stopPolling() }
    else schedulePoll()
    return
  }
  if (String(result.value?.request?.id) !== id) { error.value = '返回的请求记录不匹配，请重新读取。'; return }
  const scrollTop = scrollPane.value?.scrollTop ?? 0, bodyScrollTop = bodyPane.value?.scrollTop ?? 0
  detail.value = result.value
  await nextTick()
  if (!alive || closed || id !== props.id || revision !== viewRevision) return
  if (scrollPane.value) scrollPane.value.scrollTop = scrollTop
  if (bodyPane.value) bodyPane.value.scrollTop = bodyScrollTop
  schedulePoll()
}
function refreshDetails() { if (loading.value || !alive || closed) return; denied = false; resetPollBudget(); return load() }
async function copy(text) { try { await navigator.clipboard.writeText(text); toast.success('已复制') } catch { toast.error('复制失败，请手动选择内容复制。') } }
async function exportDetail() { if (exporting.value) return; exporting.value = true; try { await downloadRequestLog(requestLogAPI.detailExportUrl(props.id), `request-${props.id}.json`) } catch (cause) { toast.error(cause.message) } finally { exporting.value = false } }
function close() { closed = true; stopPolling(); runner.cancel(); emit('close') }
watch(() => props.id, async () => { const revision = ++viewRevision; closed = false; stopPolling(); runner.cancel(); loading.value = false; detail.value = null; denied = false; resetPollBudget(); tab.value = 'request'; await nextTick(); if (!alive || closed || revision !== viewRevision) return; panel.value?.focus?.({ preventScroll:true }); void load({reset:true}) }, { immediate:true })
onBeforeUnmount(() => { alive = false; closed = true; stopPolling(); runner.cancel(); if (returnFocus?.isConnected) returnFocus.focus?.({ preventScroll:true }) })
</script>

<style scoped>
.detail-refresh-note{margin:0;font-size:10px;line-height:1.7;color:var(--text-3);padding:9px 12px;background:var(--bg-0);border:1px solid var(--border);border-radius:8px}.detail-refresh-note.warning{color:var(--error);background:var(--error-bg)}
.detail-token-usage{display:flex;align-items:center;gap:25px;padding:14px 19px;border-bottom:1px solid var(--border);font-size:10px;color:var(--text-3);flex-wrap:wrap}.detail-token-usage>span{margin-right:auto;color:var(--text-2)}.detail-token-usage small{display:block;font-size:9px;color:var(--text-3);margin-top:5px}.detail-token-usage>div{display:flex;align-items:baseline;gap:8px}.detail-token-usage strong{font-size:12px;color:var(--text-1);font-weight:600;font-variant-numeric:tabular-nums}
.request-status.unknown,.child-dot.unknown{color:var(--warning,#ad7b23)}
.request-detail-overlay{position:fixed;inset:0;z-index:1800;background:rgba(24,31,45,.32);display:flex;justify-content:flex-end;backdrop-filter:blur(2px)}.request-detail{width:min(1050px,100vw);height:100dvh;display:flex;flex-direction:column;background:var(--bg-1,#fff);box-shadow:-12px 0 50px #17213324;outline:none}.request-detail-header{padding:22px 26px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--border)}.detail-title{display:flex;gap:11px;align-items:center;min-width:0}.detail-icon{width:38px;height:38px;display:grid;place-items:center;border-radius:11px;background:var(--accent-bg);color:var(--accent-text);flex-shrink:0}.detail-title h2{font-size:17px;margin:0}.detail-title p{font-size:10px;color:var(--text-3);margin-top:6px;overflow-wrap:anywhere}.detail-header-actions{display:flex;align-items:center;gap:8px}.request-detail-scroll{overflow:auto;min-height:0;flex:1;padding:24px 26px;display:flex;flex-direction:column;gap:21px}.detail-overview,.detail-payload{border:1px solid var(--border);border-radius:13px;overflow:hidden;flex-shrink:0}.section-title{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px 19px;background:var(--bg-0);border-bottom:1px solid var(--border)}.section-title h3{font-size:12px;margin:0}.request-status{display:inline-flex;align-items:center;gap:5px;color:var(--text-3);font-size:10px;white-space:nowrap}.request-status i,.child-dot{height:5px;width:5px;border-radius:50%;background:currentColor}.request-status.succeeded,.child-dot.succeeded{color:var(--success)}.request-status.failed,.child-dot.failed{color:var(--error)}.request-status.running,.child-dot.running{color:var(--accent-text)}.detail-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));padding:0 19px}.detail-grid>div{display:flex;flex-direction:column;gap:7px;padding:16px 10px 16px 0;border-bottom:1px solid var(--border);min-width:0}.detail-grid span,.detail-identifiers>div>span,.detail-endpoint>span,.process-meta span{font-size:10px;color:var(--text-3)}.detail-grid strong{font-size:12px;font-weight:600;overflow-wrap:anywhere}.detail-grid small{font-size:10px;color:var(--text-3);overflow-wrap:anywhere}.detail-identifiers{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));padding:15px 19px;gap:18px}.detail-identifiers>div{min-width:0;display:flex;flex-direction:column;gap:7px}.detail-identifiers>div>div{display:flex;align-items:center;gap:5px;min-width:0}.detail-identifiers code{font:10px/1.6 var(--font-mono,monospace);overflow-wrap:anywhere;color:var(--text-1)}.copy-icon{border:0;background:var(--bg-2);padding:4px;border-radius:4px;color:var(--text-3);cursor:pointer;flex-shrink:0}.detail-endpoint{padding:0 19px 17px;display:flex;flex-direction:column;gap:8px}.detail-endpoint code{font:11px/1.6 var(--font-mono,monospace);overflow-wrap:anywhere}.detail-error{margin:0 19px 16px;border-radius:8px;padding:11px 13px;background:var(--error-bg);color:var(--error);font-size:11px;line-height:1.75;overflow-wrap:anywhere}.detail-related{display:flex;gap:8px;padding:0 19px 17px}.detail-disclosure{font-size:9px;color:var(--text-3)}.payload-tabs{padding:0 19px;display:flex;gap:24px;border-bottom:1px solid var(--border)}.payload-tabs button{padding:14px 0 12px;background:none;border:0;border-bottom:2px solid transparent;font-size:11px;color:var(--text-3);cursor:pointer}.payload-tabs button.active{color:var(--accent-text);border-bottom-color:var(--accent)}.payload-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 19px;font-size:10px;color:var(--text-3)}.copy-text{display:flex;align-items:center;gap:5px;border:0;background:none;color:var(--text-2);font-size:10px;cursor:pointer}.copy-text:disabled{opacity:.4;cursor:default}.payload-body,.payload-headers pre{margin:0 19px 18px;padding:15px;border:1px solid var(--border);border-radius:9px;background:var(--bg-0);font:11px/1.85 var(--font-mono,monospace);color:var(--text-1);white-space:pre-wrap;word-break:break-word;overflow:auto;max-height:46vh;tab-size:2}.payload-note{margin:0 19px 13px;font-size:10px;line-height:1.8;color:var(--text-3)}.payload-note.warning{padding:9px 12px;border-radius:7px;background:var(--accent-bg);color:var(--accent-text)}.payload-unavailable{padding:35px 19px;color:var(--text-3);font-size:11px;text-align:center}.payload-headers{margin:0 19px 17px;font-size:10px;color:var(--text-3)}.payload-headers summary{cursor:pointer;margin-bottom:10px}.payload-headers pre{margin:0;max-height:180px}.process-meta{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;padding:0 19px 17px}.process-meta>div{display:grid;gap:8px}.process-meta strong{font-size:10px;font-weight:500}.child-requests{padding:0 19px 17px;display:grid;gap:7px}.child-requests button{display:flex;gap:10px;align-items:center;text-align:left;width:100%;border:1px solid var(--border);background:var(--bg-0);border-radius:8px;padding:12px;color:var(--text-2);cursor:pointer}.child-requests button>span:nth-child(2){flex:1;min-width:0;display:grid;gap:5px}.child-requests strong{font-size:10px;font-weight:500;overflow-wrap:anywhere}.child-requests small{font-size:9px;color:var(--text-3)}.request-detail-footer{padding:13px 26px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:10px;color:var(--text-3)}.detail-empty{padding:80px 24px;text-align:center;color:var(--text-3);flex:1}.detail-empty svg{margin:auto}.detail-empty p{font-size:12px;margin:13px 0 20px}@media(max-width:650px){.request-detail-header{padding:17px 15px}.request-detail-scroll{padding:16px 12px}.detail-grid,.detail-identifiers{grid-template-columns:repeat(2,minmax(0,1fr))}.detail-disclosure{display:none}.detail-title p{font-size:9px}.detail-header-actions .btn-sm{font-size:0;gap:0}.detail-header-actions .btn-sm svg{font-size:12px}.request-detail-footer{padding:12px 15px}.process-meta{grid-template-columns:1fr}}
</style>
