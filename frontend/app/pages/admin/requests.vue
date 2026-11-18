<template>
  <PlatformAdminShell title="请求日志" description="查看全用户的模型调用与结果交付。每次实际请求独立记录，业务任务仍在任务中心。">
    <template #actions><button class="btn" @click="refresh" :disabled="loading"><RefreshCw :size="13" :class="{ 'animate-spin': loading }" />刷新列表</button><button class="btn" @click="exportRows" :disabled="exporting"><Download :size="13" />{{ exporting ? '正在导出…' : '导出当前筛选' }}</button></template>
    <section class="request-log-card card">
      <header class="request-filter-bar">
        <div class="request-filter-top"><label class="request-search"><Search :size="14" /><input v-model="filters.q" placeholder="搜索用户、项目、模型、地址或请求号" aria-label="搜索请求日志" @input="searchChanged" @keydown.enter.prevent="applyFilters" /></label><div class="request-live"><span v-if="refreshingLabel">{{ refreshingLabel }}</span><label><input type="checkbox" v-model="autoRefresh" />自动刷新</label></div></div>
        <div class="request-filters">
          <label class="date-filter"><span>北京时间</span><input v-model="dateFrom" type="datetime-local" aria-label="开始时间" @change="changeDates" /><span>至</span><input v-model="dateTo" type="datetime-local" aria-label="结束时间" @change="changeDates" /></label>
          <select v-model="filters.user_id" aria-label="筛选用户" @change="applyFilters"><option value="">全部用户</option><option v-for="user in options.users" :key="user.id" :value="String(user.id)">{{ user.display_name || user.displayName || user.username || `用户 #${user.id}` }}</option><option v-if="filters.user_id && !options.users.some(user => String(user.id) === filters.user_id)" :value="filters.user_id">用户 #{{ filters.user_id }}</option></select>
          <select v-model="filters.model" aria-label="筛选模型" @change="applyFilters"><option value="">全部模型</option><option v-for="model in options.models" :key="modelValue(model)" :value="modelValue(model)">{{ modelValue(model) }}</option><option v-if="filters.model && !options.models.some(model => modelValue(model) === filters.model)" :value="filters.model">{{ filters.model }}</option></select>
          <select v-model="filters.channel_id" aria-label="筛选渠道" @change="applyFilters"><option value="">全部渠道</option><option v-for="channel in options.channels" :key="channel.id" :value="String(channel.id)">{{ channel.name || `渠道 #${channel.id}` }}</option><option v-if="filters.channel_id && !options.channels.some(channel => String(channel.id) === filters.channel_id)" :value="filters.channel_id">渠道 #{{ filters.channel_id }}</option></select>
          <select v-model="filters.kind" aria-label="筛选能力" @change="applyFilters"><option v-for="item in REQUEST_KINDS" :key="item.value" :value="item.value">{{ item.label }}</option></select>
          <select v-model="filters.phase" aria-label="筛选阶段" @change="applyFilters"><option v-for="item in REQUEST_PHASES" :key="item.value" :value="item.value">{{ item.label }}</option></select>
          <select v-model="filters.status" aria-label="筛选结果" @change="applyFilters"><option v-for="item in REQUEST_STATUSES" :key="item.value" :value="item.value">{{ item.label }}</option></select>
        </div>
        <div class="request-filter-bottom"><div class="request-counts"><span>{{ total }} 条记录</span><span class="running">进行中 {{ counts.running || 0 }}</span><span class="succeeded">成功 {{ counts.succeeded || 0 }}</span><span class="failed">失败 {{ counts.failed || 0 }}</span><span v-if="counts.unknown" class="running">待核实 {{ counts.unknown }}</span></div><div class="request-filter-toggles"><button @click="resetFilters">清除筛选</button></div></div>
        <p v-if="error" class="request-list-error" role="alert">{{ error }}</p>
      </header>
      <div v-if="loading && !rows.length" class="request-empty"><Loader2 :size="25" class="animate-spin" /><p>正在读取请求日志…</p></div>
      <div v-else class="request-table-scroll" :aria-busy="loading">
        <table class="request-table"><thead><tr><th>时间</th><th>结果</th><th>能力</th><th>模型 / 渠道</th><th>发起用户</th><th>项目 / 集数</th><th>阶段</th><th>耗时</th><th>错误摘要</th><th>操作</th></tr></thead><tbody>
          <tr v-for="row in rows" :key="row.id" @click="openDetail(row.id)">
            <td><button class="request-time" @click.stop="openDetail(row.id)" :title="formatRequestTime(row.created_at, true)">{{ formatRequestTime(row.created_at) }}</button><small class="request-id" :title="String(row.id)">#{{ String(row.id).slice(0, 12) }}</small></td>
            <td><span :class="['request-status',row.status]"><i />{{ requestStatusLabel(row.status, row) }}</span><small v-if="row.http_status != null">HTTP {{ row.http_status }}</small><small v-else-if="row.method === 'INTERNAL'">未发送模型请求</small></td>
            <td><span :class="['kind-label', row.kind]">{{ requestKindLabel(row.kind) }}</span></td>
            <td class="request-model"><strong :title="row.model || ''">{{ row.model || '模型未记录' }}</strong><small :title="row.channel_name || ''">{{ row.channel_name || (row.channel_id ? `渠道 #${row.channel_id}` : '渠道未记录') }}</small></td>
            <td><strong class="cell-ellipsis" :title="userName(row)">{{ userName(row) }}</strong><small v-if="row.user_name" :title="row.user_name">@{{ row.user_name }}</small></td>
            <td><strong class="cell-ellipsis" :title="row.project_title || ''">{{ row.project_title || (row.project_id ? `项目 #${row.project_id}` : '项目未记录') }}</strong><small v-if="row.episode_number">第 {{ row.episode_number }} 集</small></td>
            <td>{{ requestPhaseLabel(row.phase) }}<small v-if="row.attempt_no">第 {{ row.attempt_no }} 次尝试</small></td>
            <td class="duration-cell">{{ duration(row) }}</td>
            <td><span :class="['error-summary', { failed: row.error }]" :title="row.error || ''">{{ row.error || '—' }}</span></td>
            <td><button class="request-detail-button" @click.stop="openDetail(row.id)">详情<ChevronRight :size="12" /></button></td>
          </tr>
        </tbody></table>
        <div v-if="!rows.length" class="request-empty"><FileSearch :size="28" /><p>{{ error ? '暂时无法读取记录' : '没有符合筛选的请求记录' }}</p><span v-if="!error">仅展示启用后实际采集的请求；旧任务可到任务中心查看。</span></div>
      </div>
      <footer class="request-pagination"><span v-if="total">第 {{ filters.offset + 1 }}—{{ Math.min(filters.offset + rows.length, total) }} 条，共 {{ total }} 条</span><span v-else>共 0 条</span><div><label>每页<select v-model.number="filters.limit" aria-label="每页记录数" @change="applyFilters"><option :value="20">20</option><option :value="50">50</option><option :value="100">100</option></select></label><button class="btn btn-sm" :disabled="loading || filters.offset <= 0" @click="changePage(-1)">上一页</button><button class="btn btn-sm" :disabled="loading || filters.offset + rows.length >= total" @click="changePage(1)">下一页</button></div></footer>
    </section>
    <p class="request-log-note">仅展示启用后实际采集的请求，旧任务可到 <NuxtLink to="/tasks">任务中心</NuxtLink> 查看。请求成功只表示该次调用成功；视频生成、状态查询和下载分别记录。未知用量与历史缺失字段显示为未记录，详情不会自动重新生成。</p>
    <RequestLogDetail v-if="selectedId" :id="selectedId" @close="closeDetail" @select="openDetail" />
  </PlatformAdminShell>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { RefreshCw, Download, Search, Loader2, FileSearch, ChevronRight } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import PlatformAdminShell from '~/components/PlatformAdminShell.vue'
import RequestLogDetail from '~/components/RequestLogDetail.vue'
import { requestLogAPI, downloadRequestLog } from '~/composables/useRequestLogs'
import { REQUEST_PHASES, REQUEST_KINDS, REQUEST_STATUSES, normalizeRequestFilters, requestFilterParams, requestFilterQuery, fromBeijingInput, toBeijingInput, createLatestRequestRunner, formatRequestTime, formatRequestSeconds, requestStatusLabel, requestKindLabel, requestPhaseLabel } from '~/utils/request-logs.js'

const route = useRoute(), router = useRouter()
const filters = reactive(normalizeRequestFilters(route.query)), rows = ref([]), total = ref(0), counts = ref({}), options = reactive({users:[],models:[],channels:[]})
const dateFrom = ref(toBeijingInput(filters.from)), dateTo = ref(toBeijingInput(filters.to)), loading = ref(false), exporting = ref(false), error = ref(''), autoRefresh = ref(true), lastRefreshed = ref(null), clock = ref(Date.now())
const selectedId = ref(typeof route.query.request_id === 'string' ? route.query.request_id : '')
const runner = createLatestRequestRunner()
let mounted = false, searchTimer, refreshTimer, clockTimer
const refreshingLabel = computed(() => loading.value ? '正在刷新…' : lastRefreshed.value ? `更新于 ${formatRequestTime(lastRefreshed.value).split(' ')[1]}` : '')
const modelValue = item => typeof item === 'string' ? item : item?.model || item?.name || ''
const userName = row => row.user_display_name || row.user_name || (row.user_id != null ? `用户 #${row.user_id}` : '未记录')
function duration(row) {
  if (row.duration_ms != null) return formatRequestSeconds(row.duration_ms)
  const start = Date.parse(row.created_at)
  return row.status === 'running' && Number.isFinite(start) ? '已过 ' + formatRequestSeconds(Math.max(0,clock.value-start)) : '未记录'
}
async function persistQuery() {
  const query = requestFilterQuery(filters)
  if (selectedId.value) query.request_id = selectedId.value
  await router.replace({ path:route.path, query })
}
async function load(clear = false) {
  if (!mounted) return
  try { requestFilterParams(filters) } catch (cause) { rejectFilter(cause); return }
  loading.value = true; error.value = ''
  if (clear) rows.value = []
  const result = await runner.run(signal => requestLogAPI.list({...filters},signal))
  if (!result.current) return
  loading.value = false
  if (result.error) {
    error.value = result.error.message || '请求日志读取失败，请重试。'
    if ([401,403].includes(result.error.status)) { rows.value=[];total.value=0;counts.value={};options.users=[];options.models=[];options.channels=[] }
    return
  }
  if (!Array.isArray(result.value?.items) || !Number.isFinite(Number(result.value?.total))) { error.value = '请求日志返回格式不正确。'; return }
  rows.value = result.value.items; total.value = Number(result.value.total); counts.value = result.value.counts || {}
  for (const key of ['users','models','channels']) if (Array.isArray(result.value.options?.[key])) options[key] = result.value.options[key]
  lastRefreshed.value = new Date().toISOString()
}
function rejectFilter(cause) { runner.cancel();loading.value=false;rows.value=[];total.value=0;counts.value={};lastRefreshed.value=null;error.value=cause.message || '筛选条件不正确。' }
async function applyFilters() { clearTimeout(searchTimer); filters.offset = 0; try { await persistQuery(); await load(true) } catch (cause) { rejectFilter(cause) } }
function searchChanged() { clearTimeout(searchTimer); searchTimer = setTimeout(applyFilters,350) }
async function changeDates() { try { filters.from = fromBeijingInput(dateFrom.value); filters.to = fromBeijingInput(dateTo.value); await applyFilters() } catch (cause) { rejectFilter(cause) } }
async function resetFilters() { Object.assign(filters,normalizeRequestFilters({})); dateFrom.value='';dateTo.value='';await applyFilters() }
async function changePage(direction) { filters.offset = Math.max(0,filters.offset+direction*filters.limit);await persistQuery();await load(true) }
function refresh() { return load(false) }
async function exportRows() { if (exporting.value) return;exporting.value=true;try{await downloadRequestLog(requestLogAPI.exportUrl(filters),'request-logs.csv')}catch(cause){toast.error(cause.message)}finally{exporting.value=false} }
function openDetail(id) { selectedId.value=String(id);void persistQuery() }
function closeDetail() { selectedId.value='';void persistQuery() }
watch(() => route.query, query => {
  if (!mounted) return
  clearTimeout(searchTimer)
  const next = normalizeRequestFilters(query)
  let changed
  try { changed = String(requestFilterParams(next)) !== String(requestFilterParams(filters)) }
  catch (cause) { rejectFilter(cause); return }
  selectedId.value = typeof query.request_id === 'string' ? query.request_id : ''
  if (changed) { Object.assign(filters,next);dateFrom.value=toBeijingInput(next.from);dateTo.value=toBeijingInput(next.to);void load(true) }
})
onMounted(() => { mounted=true;void load();refreshTimer=setInterval(()=>{if(autoRefresh.value&&!loading.value&&document.visibilityState==='visible')void load()},5000);clockTimer=setInterval(()=>{clock.value=Date.now()},1000) })
onBeforeUnmount(() => { mounted=false;runner.cancel();clearTimeout(searchTimer);clearInterval(refreshTimer);clearInterval(clockTimer) })
</script>

<style scoped>
.request-status.unknown{color:var(--warning,#ad7b23)}
.request-log-card{border-radius:14px;overflow:hidden}.request-filter-bar{padding:19px 20px 14px;border-bottom:1px solid var(--border)}.request-filter-top{display:flex;justify-content:space-between;gap:18px;align-items:center;margin-bottom:15px}.request-search{display:flex;align-items:center;gap:9px;min-width:250px;width:min(470px,100%);border:1px solid var(--border);border-radius:9px;background:var(--bg-0);padding:10px 12px;color:var(--text-3)}.request-search input{border:0;outline:0;background:transparent;width:100%;font-size:11px;color:var(--text-1)}.request-live{display:flex;align-items:center;gap:13px;color:var(--text-3);font-size:10px}.request-live label,.request-filter-toggles label{display:flex;align-items:center;gap:6px;white-space:nowrap}.request-filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.request-filters select,.date-filter,.request-pagination select{height:34px;border:1px solid var(--border);border-radius:8px;background:var(--bg-0);font-size:10px;color:var(--text-2);padding:0 9px}.request-filters select{min-width:103px;max-width:180px}.date-filter{display:flex;align-items:center;gap:7px;padding:0 9px}.date-filter>span{font-size:9px;color:var(--text-3)}.date-filter input{width:143px;font-size:10px;border:0;outline:0;color:var(--text-2);background:transparent;min-width:0}.request-filter-bottom{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-top:15px;font-size:10px}.request-counts,.request-filter-toggles{display:flex;gap:15px;align-items:center;color:var(--text-3)}.request-counts .running{color:var(--accent-text)}.request-counts .succeeded{color:var(--success)}.request-counts .failed{color:var(--error)}.request-filter-toggles button{border:0;background:none;color:var(--text-3);font-size:10px;cursor:pointer}.request-list-error{font-size:11px;line-height:1.75;margin-top:12px;padding:10px 12px;background:var(--error-bg);color:var(--error);border-radius:8px}.request-table-scroll{overflow:auto;max-height:calc(100dvh - 360px);min-height:240px}.request-table{width:100%;min-width:1160px;border-collapse:collapse;font-size:11px;table-layout:fixed}.request-table th{position:sticky;top:0;z-index:1;padding:12px 13px;text-align:left;background:var(--bg-0);color:var(--text-3);font-size:10px;font-weight:500;white-space:nowrap;border-bottom:1px solid var(--border)}.request-table th:nth-child(1){width:124px}.request-table th:nth-child(2){width:100px}.request-table th:nth-child(3){width:58px}.request-table th:nth-child(4){width:166px}.request-table th:nth-child(5){width:120px}.request-table th:nth-child(6){width:150px}.request-table th:nth-child(7){width:86px}.request-table th:nth-child(8){width:92px}.request-table th:nth-child(9){width:auto;min-width:140px}.request-table th:nth-child(10){width:60px}.request-table td{padding:12px 13px;border-bottom:1px solid var(--border);vertical-align:middle;color:var(--text-2)}.request-table tbody tr{cursor:pointer}.request-table tbody tr:hover{background:var(--bg-hover)}.request-table tbody tr:last-child td{border-bottom:0}.request-table small{display:block;color:var(--text-3);font-size:9px;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.request-time{border:0;padding:0;background:none;color:var(--text-1);font:inherit;font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer}.request-time:hover{color:var(--accent-text)}.request-id{font-family:var(--font-mono,monospace)}.request-status{font-size:10px;display:flex;align-items:center;gap:5px;white-space:nowrap}.request-status i{width:5px;height:5px;border-radius:50%;background:currentColor}.request-status.running{color:var(--accent-text)}.request-status.succeeded{color:var(--success)}.request-status.failed{color:var(--error)}.kind-label{font-size:10px;color:var(--text-3)}.kind-label.text{color:#6073a0}.kind-label.image{color:#8e6bb3}.kind-label.video{color:#3d8c82}.request-model strong,.cell-ellipsis{display:block;font-size:11px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.duration-cell{font-variant-numeric:tabular-nums;white-space:nowrap;font-size:10px}.error-summary{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-3);max-width:100%}.error-summary.failed{color:var(--error)}.request-detail-button{border:0;padding:0;background:none;display:flex;align-items:center;gap:2px;font-size:10px;color:var(--text-3);cursor:pointer}.request-detail-button:hover{color:var(--accent-text)}.request-empty{padding:65px 20px;text-align:center;color:var(--text-3)}.request-empty svg{margin:auto}.request-empty p{font-size:12px;margin-top:12px}.request-empty span{font-size:10px;display:block;margin-top:9px}.request-pagination{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 18px;border-top:1px solid var(--border);font-size:10px;color:var(--text-3)}.request-pagination>div{display:flex;gap:7px;align-items:center}.request-pagination label{display:flex;gap:7px;align-items:center}.request-pagination select{height:29px;font-size:10px}.request-log-note{font-size:10px;color:var(--text-3);line-height:1.8;margin:12px 2px 0}@media(max-width:750px){.request-filter-bar{padding:14px 12px}.request-filter-top{align-items:flex-start;flex-direction:column;gap:11px}.request-search{width:100%;min-width:0}.request-filters select{flex:1;min-width:105px;max-width:none}.date-filter{width:100%;justify-content:space-between}.date-filter input{width:38%}.request-filter-bottom{gap:10px}.request-counts{gap:9px}.request-pagination{padding:12px;flex-wrap:wrap}.request-table-scroll{max-height:62vh}.request-pagination .btn{font-size:10px}}
</style>
