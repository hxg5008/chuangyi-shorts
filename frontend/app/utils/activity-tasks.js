export const activeTaskStatuses = new Set(['queued', 'pending', 'running', 'processing', 'generating', 'validating', 'repairing'])
export function activityTaskActive(task) { return activeTaskStatuses.has(task?.status) }
export function activityKindLabel(kind) { return ({ text: '文字', image: '图片', video: '视频', merge: '拼接' })[kind] || '任务' }
export function activityStatusLabel(task) {
  if (task?.stage === 'cancelled') return '已停止'
  if (task?.stage === 'ready_in_local_service') return '已出片 · 待取回'
  if (task?.stage === 'handed_off') return '已交即梦 · 待回传'
  return ({ queued: '排队中', pending: '排队中', running: '执行中', processing: '执行中', generating: '生成中', validating: '检查中', repairing: '修正中', completed: '已完成', failed: '失败', error: '失败', interrupted: '已中断', cancelled: '已停止', needs_revision: '待处理' })[task?.status] || task?.status || '状态待更新'
}
export function activityStageLabel(stage) {
  return ({ waiting_capacity: '等待全局任务槽', waiting_owner: '等待用户任务槽', waiting_paused: '派发已暂停', waiting_route: '等待项目画布', waiting_review: '原提交待核对', dispatching: '正在派发', cancelling: '已请求取消，等待上游确认', cancelled: '已停止', queued: '等待执行', waiting_model_slot: '等待模型任务槽', preparing: '准备请求', preparing_prompt: '准备提示词', submitting: '提交模型', submitted: '已提交', accepted: '已接收', running: '正在处理', generating: '正在生成', streaming: '接收公开输出', validating: '检查结果', repairing: '修正结果', polling: '查询原任务', downloading: '下载结果', saving: '保存结果', completed: '处理完成', failed: '本次任务失败', interrupted: '任务已中断', submission_unknown: '提交结果待核查', submission_checking: '提交结果核对中，不会重复提交', ready_in_local_service: '已出片，等待取回到分镜', handed_off: '已交即梦，出片后回传', upstream_status_pending: '等待上游状态' })[stage] || stage || '等待状态更新'
}
export function activityElapsed(task, now = Date.now()) {
  if (!task) return 0
  const created = Date.parse(task.created_at || task.createdAt || task.started_at || task.startedAt || '')
  if (activityTaskActive(task) && Number.isFinite(created)) return Math.max(0, (now - created) / 1000)
  const seconds = task.elapsed_seconds ?? task.elapsedSeconds
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) return seconds
  const end = Date.parse(task.finished_at || task.finishedAt || '')
  return Number.isFinite(created) && Number.isFinite(end) ? Math.max(0, (end - created) / 1000) : null
}
export function activitySeconds(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${Math.round(value)} 秒` : '未提供' }
export function activityProgress(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null }
export function activityToken(usage, keys) {
  for (const key of keys) { const value = usage?.[key]; if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value.toLocaleString() }
  return '未提供'
}
export function activityPublicEvents(events) { return (events || []).filter(event => !['analysis', 'reasoning', 'chain_of_thought', 'internal_thought'].includes(event.kind)) }
export function safeActivityValue(value) {
  const secret = /^(?:api_?key|authorization|proxy-authorization|cookie|set-cookie|access_?token|refresh_?token|id_?token|password|secret|data_base64|b64_json|pngBase64)$/iu
  const visit = (item, key = '') => {
    if (secret.test(key)) return '[已隐藏]'
    if (Array.isArray(item)) return item.map(value => visit(value))
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, visit(entry, name)]))
    if (typeof item === 'string') return item.replace(/data:(?:image|video|audio)\/[^;]+;base64,[A-Za-z0-9+/=]+/gu, '[媒体数据已隐藏]').replace(/\bBearer\s+[^\s"'<>,]+/giu, 'Bearer [已隐藏]').replace(/\bsk-[A-Za-z0-9_-]+/gu, '[密钥已隐藏]').replace(/([?&](?:signature|sig|token|api_key|X-Amz-Signature|X-Amz-Credential)=)[^&\s"'<>]+/giu, '$1[已隐藏]')
    return item
  }
  return visit(value)
}
export function formatActivityValue(value) {
  const safe = safeActivityValue(value)
  if (safe === undefined || safe === null || safe === '') return ''
  return typeof safe === 'string' ? safe : JSON.stringify(safe, null, 2)
}
export function activityPublicText(value) {
  if (typeof value === 'string') return safeActivityValue(value)
  if (!value) return ''
  if (typeof value.text === 'string') return safeActivityValue(value.text)
  if (Array.isArray(value.content)) return safeActivityValue(value.content.filter(part => part?.type === 'text').map(part => part.text || '').join(''))
  return value.tool_calls || value.toolCalls ? '' : formatActivityValue(value)
}
export function mergeActivityEvents(...groups) {
  const entries = new Map()
  for (const group of groups) for (const event of group || []) if (event?.id !== undefined) entries.set(String(event.id), event)
  return activityPublicEvents([...entries.values()].sort((a,b) => String(a.id).localeCompare(String(b.id),undefined,{numeric:true})))
}
export function activityRoundTools(round, events = []) {
  const output = round?.public_output ?? round?.output
  const calls = round?.tool_calls || output?.tool_calls || output?.toolCalls || (Array.isArray(output?.content) ? output.content.filter(part => part.type === 'tool-call') : [])
  const entries = new Map()
  for (const call of Array.isArray(calls) ? calls : []) entries.set(call.id || call.toolCallId || String(entries.size), call)
  for (const event of events) if (event.kind === 'tool_call' && (!round?.id || event.round_id === round.id)) {
    const call = event.payload
    if (call && typeof call === 'object') entries.set(call.id || call.toolCallId || String(entries.size), call)
  }
  return [...entries.values()]
}
