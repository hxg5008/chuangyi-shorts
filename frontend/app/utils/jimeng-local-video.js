/** Contract for the independently deployed Jimeng executor, including the unified hub. */
export const JIMENG_LOCAL_PROVIDER = 'jimeng_local'
export const JIMENG_LOCAL_MODEL = 'jimeng-2.0-fast'
export const JIMENG_LOCAL_IMAGE_LIMIT = 9
export const JIMENG_LOCAL_PRESET = {
  label: '即梦 · 本地服务',
  baseUrl: '',
  models: [JIMENG_LOCAL_MODEL],
}

export function jimengLocalDefaultDraft(aspectRatio = '16:9') {
  return { duration: 15, aspectRatio: ['16:9', '9:16', '1:1'].includes(aspectRatio) ? aspectRatio : '16:9' }
}

/**
 * The execution parameters of one shot follow the project, not a panel default:
 * duration = the storyboard's own duration (rounded, 1–15 s; an out-of-range
 * value is passed on unchanged so the normal check reports it instead of
 * silently cutting the shot), aspect ratio = the project's ratio from 新建项目
 * (16:9 / 9:16 / 1:1; "adaptive" or empty falls back to 16:9, as before).
 */
export function jimengShotDraft(storyboard, projectAspectRatio) {
  const raw = Number(storyboard?.duration)
  const duration = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 15
  return { duration, aspectRatio: jimengLocalDefaultDraft(projectAspectRatio).aspectRatio }
}

/** Keep one name per bound asset. Shared image bytes do not erase a different asset name. */
export function collectJimengReferences(scene, characters = [], props = []) {
  const refs = []
  const add = (name, item) => {
    const url = item?.image_url || item?.imageUrl
    if (url) refs.push({ name: name || `参考图片${refs.length + 1}`, url })
  }
  add(scene?.location, scene)
  for (const item of characters) add(item?.name, item)
  for (const item of props) add(item?.name, item)
  return refs
}

/** The final editor text is forwarded intact; native @ conversion is performed by the service. */
export function jimengLocalVideoPayload(draft, references, prompt, model = JIMENG_LOCAL_MODEL) {
  if (model !== JIMENG_LOCAL_MODEL) throw new Error('即梦本地服务目前适配 jimeng-2.0-fast，请选择对应型号。')
  const duration = Number(draft.duration)
  if (!Number.isInteger(duration) || duration < 1 || duration > 15) throw new Error('即梦执行时长请选择 1–15 秒整数。')
  if (!['16:9', '9:16', '1:1'].includes(draft.aspectRatio)) throw new Error('即梦执行画幅请选择 16:9、9:16 或 1:1。')
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('请先填写完整的视频提示词。')
  if (references.length > JIMENG_LOCAL_IMAGE_LIMIT) throw new Error(`当前绑定 ${references.length} 张图片，超过即梦本地服务 ${JIMENG_LOCAL_IMAGE_LIMIT} 张保护上限；请调整绑定，不会自动截掉图片。`)
  if (references.some(ref => !ref?.url || !ref?.name)) throw new Error('参考图与名称不完整，请检查分镜素材绑定。')
  return {
    duration,
    aspect_ratio: draft.aspectRatio,
    reference_mode: references.length ? 'reference' : 'text_to_video',
    reference_image_urls: references.map(ref => ref.url),
    reference_image_names: references.map(ref => ref.name),
    prompt,
  }
}

export function isJimengTask(task) { return task?.provider === JIMENG_LOCAL_PROVIDER }
export function jimengManualVideoReady(task) {
  return isJimengTask(task) && task.status === 'completed' && task.stage === 'ready_in_local_service'
}
/** Round 5: Jimeng accepted the job and named its card; the video comes back later through 回传. */
export function jimengHandedOff(task) {
  return isJimengTask(task) && task.status === 'completed' && task.stage === 'handed_off'
}
export function jimengAttemptState(task) {
  if (!isJimengTask(task)) return ''
  if (task.status === 'failed' || task.status === 'cancelled') return 'failed'
  if (jimengManualVideoReady(task)) return 'done'
  if (jimengHandedOff(task)) return 'handed_off'
  if (['pending', 'queued', 'processing'].includes(task.status)) return 'pending'
  return ''
}
/** Round 5: the card title Jimeng shows (for example 1-01), when the service reported it. */
export function jimengHandoffTitle(task) {
  if (!jimengHandedOff(task)) return ''
  try {
    const params = typeof task.params === 'string' ? JSON.parse(task.params || '{}') : task.params || {}
    return typeof params?.jimengHandoff?.title === 'string' ? params.jimengHandoff.title : ''
  } catch { return '' }
}
/** Round 5: the outcome of the last 回传 check, for a short hint (not ready yet / last error). */
export function jimengReturnNote(task) {
  if (!jimengHandedOff(task)) return ''
  try {
    const params = typeof task.params === 'string' ? JSON.parse(task.params || '{}') : task.params || {}
    const last = params?.jimengReturn || {}
    if (last.lastError) return `上次回传未完成：${last.lastError}`
    if (last.result === 'canvas_unavailable') return '上次核对时暂时读不到即梦画布。'
    if (last.result === 'not_ready' && last.checkedAt) return `上次核对（${new Date(last.checkedAt).toLocaleString()}）还没出片。`
    return ''
  } catch { return '' }
}
export function jimengAttemptError(task) {
  return jimengAttemptState(task) === 'failed' ? task.error_msg || task.errorMsg || '即梦任务失败，请查看服务端原任务详情。' : ''
}

/** A delayed polling response must not overwrite an already observed terminal result. */
export function mergeJimengTaskSnapshots(previous, incoming) {
  const oldById = new Map(previous.filter(isJimengTask).map(task => [task.id, task]))
  const nextIds = new Set(incoming.map(task => task.id))
  const rows = incoming.map(task => {
    const old = oldById.get(task.id)
    if (!old || !isJimengTask(task)) return task
    const oldTime = Date.parse(old.updated_at || old.updatedAt || '')
    const newTime = Date.parse(task.updated_at || task.updatedAt || '')
    if (Number.isFinite(oldTime) && Number.isFinite(newTime) && newTime < oldTime) return old
    if (['completed', 'failed', 'cancelled'].includes(old.status) && !['completed', 'failed', 'cancelled'].includes(task.status)
      && (!Number.isFinite(newTime) || !Number.isFinite(oldTime) || newTime <= oldTime)) return old
    return task
  })
  // A list request started before POST /tasks may finish after the new task was recorded.
  // Keep that active receipt while the next list catches up, instead of flashing to an old result.
  return [...previous.filter(task => isJimengTask(task) && !nextIds.has(task.id) && ['pending', 'queued', 'processing'].includes(task.status)), ...rows]
}
