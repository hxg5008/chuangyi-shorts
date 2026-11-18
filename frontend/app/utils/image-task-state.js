export const isTaskActive = task => ['pending', 'queued', 'processing', 'running'].includes(task?.status)
export const isTaskTerminal = task => ['completed', 'failed', 'cancelled'].includes(task?.status)
export const imageTaskKey = (kind, assetId) => `${kind}:${assetId}`

export function imageTaskAsset(task) {
  if (task?.type !== 'image') return null
  for (const kind of ['character', 'scene', 'prop']) {
    const assetId = Number(task[`${kind}_id`] ?? task[`${kind}Id`])
    if (assetId) return { kind, assetId }
  }
  return null
}

export function beginImageTask(pending, kind, assetId, phase = 'submitting', recoveryTaskId = null) {
  const startedAt = new Date().toISOString()
  return { ...pending, [imageTaskKey(kind, assetId)]: { kind, assetId, taskId: null, phase, startedAt, ...(recoveryTaskId ? { recoveryTaskId } : {}) } }
}

export function setImageTaskPhase(pending, kind, assetId, phase) {
  const key = imageTaskKey(kind, assetId)
  if (!pending[key]) return pending
  return { ...pending, [key]: { ...pending[key], phase } }
}

export function trackImageTask(pending, kind, assetId, taskId) {
  if (!Number(taskId)) throw new Error('Image generation did not return a task ID')
  const key = imageTaskKey(kind, assetId)
  return { ...pending, [key]: { ...pending[key], kind, assetId, taskId: Number(taskId), phase: 'queued' } }
}

export function clearImageTask(pending, kind, assetId) {
  const next = { ...pending }
  delete next[imageTaskKey(kind, assetId)]
  return next
}

export function pendingImageIds(pending, kind) {
  return Object.values(pending).filter(item => item.kind === kind).map(item => item.assetId)
}

/** Follow the submitted task, never an old image URL or another generation for that asset. */
export function reconcileImageTasks(pending, tasks) {
  const next = {}
  const settled = []
  const byId = new Map(tasks.map(task => [Number(task.id), task]))
  const latest = new Map()
  for (const task of tasks) {
    const asset = imageTaskAsset(task)
    if (!asset) continue
    const key = imageTaskKey(asset.kind, asset.assetId)
    if (!latest.has(key) || Number(task.id) > Number(latest.get(key).id)) latest.set(key, task)
  }
  for (const [key, item] of Object.entries(pending)) {
    const task = item.taskId == null ? null : byId.get(item.taskId)
    // An HTTP submission or a not-yet-visible task must survive older database snapshots.
    if (!task || !isTaskTerminal(task)) next[key] = item
    else settled.push({ ...item, task })
  }
  // Restore running generations on page entry, including tasks submitted elsewhere.
  for (const [key, task] of latest) {
    if (!next[key] && isTaskActive(task)) next[key] = { ...imageTaskAsset(task), taskId: Number(task.id) }
  }
  return { pending: next, settled }
}
