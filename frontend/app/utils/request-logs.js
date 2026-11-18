export const REQUEST_PHASES = [
  { value: 'generate', label: '模型调用' }, { value: 'all', label: '全部阶段' },
  { value: 'poll', label: '状态查询' }, { value: 'upload', label: '素材上传' },
  { value: 'download', label: '结果下载' }, { value: 'other', label: '其他调用' },
]
export const REQUEST_KINDS = [
  { value: '', label: '全部能力' }, { value: 'text', label: '文本' },
  { value: 'image', label: '图片' }, { value: 'video', label: '视频' }, { value: 'unknown', label: '未知' },
]
export const REQUEST_STATUSES = [
  { value: '', label: '全部结果' }, { value: 'running', label: '进行中' },
  { value: 'succeeded', label: '请求成功' }, { value: 'failed', label: '请求失败' },
  { value: 'unknown', label: '结果待核实' },
  { value: 'cancelled', label: '已取消' },
]
const scalar = value => typeof value === 'string' ? value : ''
const oneOf = (value, choices, fallback = '') => choices.some(item => item.value === value) ? value : fallback
const positive = value => /^\d+$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? String(Number(value)) : ''

export function normalizeRequestFilters(input = {}) {
  const limit = Number(input.limit)
  const offset = Number(input.offset)
  return {
    q: scalar(input.q).trim().slice(0, 300), user_id: positive(input.user_id), channel_id: positive(input.channel_id),
    model: scalar(input.model).trim().slice(0, 200), kind: oneOf(scalar(input.kind), REQUEST_KINDS),
    phase: oneOf(scalar(input.phase), REQUEST_PHASES, 'generate'), status: oneOf(scalar(input.status), REQUEST_STATUSES),
    from: validIso(input.from), to: validIso(input.to),
    limit: [20, 50, 100].includes(limit) ? limit : 50,
    offset: Number.isSafeInteger(offset) && offset >= 0 ? Math.min(offset, 1_000_000) : 0,
  }
}
function validIso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value)) return ''
  const date = new Date(value)
  return Number.isFinite(date.valueOf()) ? date.toISOString() : ''
}
export function requestFilterParams(filters) {
  const f = normalizeRequestFilters(filters)
  if (f.from && f.to && f.from > f.to) throw Error('开始时间不能晚于结束时间。')
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(f)) {
    if (value !== '' && value !== false) params.set(key, String(value))
  }
  return params
}
export function requestFilterQuery(filters) {
  return Object.fromEntries(requestFilterParams(filters))
}
export function toBeijingInput(value) {
  if (!value) return ''
  const time = new Date(value).valueOf()
  if (!Number.isFinite(time)) return ''
  return new Date(time + 8 * 3600_000).toISOString().slice(0, 16)
}
export function fromBeijingInput(value) {
  if (!value) return ''
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value)) throw Error('请选择有效的日期和时间。')
  const result = validIso(value + ':00+08:00')
  if (!result || toBeijingInput(result) !== value) throw Error('请选择有效的日期和时间。')
  return result
}
export function formatRequestTime(value, full = false) {
  if (!value) return '未记录'
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) return '未记录'
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const get = type => parts.find(part => part.type === type)?.value || ''
  return `${full ? get('year') + '/' : ''}${get('month')}/${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
}
export function formatRequestSeconds(milliseconds) {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) return '未记录'
  return `${Number((milliseconds / 1000).toFixed(milliseconds < 1000 ? 3 : 2))} 秒`
}
export function requestStatusLabel(value, item) {
  if (item?.method === 'INTERNAL') return ({running:'检查中',succeeded:'检查通过',failed:'检查未通过',unknown:'检查结果待核实',cancelled:'已取消'})[value] || '状态未记录'
  return REQUEST_STATUSES.find(item => item.value === value)?.label || '状态未记录'
}
export function requestKindLabel(value) { return REQUEST_KINDS.find(item => item.value === value && value)?.label || '未知' }
export function requestPhaseLabel(value) { return REQUEST_PHASES.find(item => item.value === value && value !== 'all')?.label || '未记录' }
export function requestBodyText(value) {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}
/** Use only upstream usage fields. Stream frames update snapshots, never add
 * repeated token totals together; an omitted total remains unreported. */
export function requestTokenUsage(body) {
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { return null } }
  if (!body || typeof body !== 'object') return null
  const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
  const result = { input: null, output: null, total: null }
  const absorb = frame => {
    if (!frame || typeof frame !== 'object') return
    const usage = frame.usage || frame.response?.usage || frame.message?.usage
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return
    const input = count(usage.input_tokens) ?? count(usage.prompt_tokens)
    const output = count(usage.output_tokens) ?? count(usage.completion_tokens)
    const total = count(usage.total_tokens)
    const hasInput = Object.hasOwn(usage, 'input_tokens') || Object.hasOwn(usage, 'prompt_tokens')
    const hasOutput = Object.hasOwn(usage, 'output_tokens') || Object.hasOwn(usage, 'completion_tokens')
    const changed = hasInput && result.input !== input || hasOutput && result.output !== output
    if (hasInput) result.input = input
    if (hasOutput) result.output = output
    if (Object.hasOwn(usage, 'total_tokens')) result.total = total
    else if (changed) result.total = null
  }
  if (Array.isArray(body.event_stream)) for (const frame of body.event_stream) absorb(frame)
  else absorb(body)
  return Object.values(result).some(value => value !== null) ? result : null
}
export function requestTaskLink(item) {
  if (!item?.task_id) return ''
  const query = new URLSearchParams({ task_id: String(item.task_id), tab: 'request' })
  if (item.round_id) query.set('round_id', String(item.round_id))
  if (item.project_id) query.set('drama_id', String(item.project_id))
  return '/tasks?' + query
}
export function requestChannelLink(item) {
  if (!item?.channel_id) return ''
  const query = new URLSearchParams({ channel_id: String(item.channel_id) })
  if (item.config_id) query.set('config_id', String(item.config_id))
  return '/admin/channels?' + query
}

/** Abort superseded requests and refuse stale results even if fetch ignores abort. */
export function createLatestRequestRunner() {
  let revision = 0, controller
  return {
    async run(load) {
      const own = ++revision
      controller?.abort()
      controller = new AbortController()
      try {
        const value = await load(controller.signal)
        return { current: own === revision, value }
      } catch (error) {
        return { current: own === revision && error?.name !== 'AbortError', error }
      }
    },
    cancel() { revision++; controller?.abort(); controller = undefined },
  }
}
