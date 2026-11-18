import { setTaskLogObserver } from '../../utils/task-logger.js'
import { currentActivity } from './context.js'
import { activityEvent, activityTask, parseActivityJSON, updateActivityTask } from './store.js'
import { syncMediaActivity } from './source-sync.js'
import { sanitizeActivity } from './sanitize.js'

export function installActivityLogger() {
  setTaskLogObserver(event => {
    let taskId = currentActivity()?.taskId
    const id = Number(event.meta?.id || (event.payload as any)?.id)
    if (id && ['ImageTask', 'VideoTask', 'SysTask'].includes(event.scope)) taskId = syncMediaActivity(id) || taskId
    if (!taskId) return
    if (event.payload && ['ImageTask', 'VideoTask'].includes(event.scope) && /request payload/iu.test(event.action)) {
      const previous = parseActivityJSON(activityTask(taskId)?.request_json, {})
      updateActivityTask(taskId, { request: { ...previous, native_request: sanitizeActivity(event.payload, [], Number.MAX_SAFE_INTEGER) } })
    }
    // Full model input lives in admin-only round snapshots. Generic provider log
    // payloads can contain serialized system instructions and must not be copied
    // into public timeline events, even when nested inside a string.
    const payload: Record<string, unknown> = event.payload ? { summary: '请求／响应已记录；完整模型请求请查看管理员轮次快照。' } : {}
    for (const [key, value] of Object.entries(event.meta || {})) {
      if (['id', 'jobId', 'episodeId', 'provider', 'model', 'stage', 'status', 'attempt', 'elapsedSeconds', 'statusCode', 'requestId', 'error'].includes(key)) payload[key] = value
    }
    activityEvent(taskId, event.level === 'ERROR' ? 'error' : event.payload ? 'request_summary' : 'process', `${event.scope} · ${event.action}`,
      sanitizeActivity(payload, [], 6000))
  })
}
