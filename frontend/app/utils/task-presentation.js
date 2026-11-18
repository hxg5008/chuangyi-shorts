export function taskParams(value) {
  if (value && typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

export function taskHasResult(task) {
  return !!(task?.hasResult || task?.result_url || task?.resultUrl || task?.local_path || task?.localPath)
}

/** A stage is a server/local state, never an estimate of model generation progress. */
export function taskStageKey(task, local) {
  const stage = local?.taskId == null && local?.phase ? local.phase : task?.stage
  const kind = task?.kind || task?.type || (local ? 'image' : '')
  if (stage === 'preparing_prompt') return 'episode.tasks.stage.preparingPrompt'
  if (stage === 'submitting') return 'episode.tasks.stage.submitting'
  if (stage === 'queued' || stage === 'pending') return 'episode.tasks.stage.queued'
  if (stage === 'submission_unknown' || task?.errorCode === 'submission_unknown' || task?.error_code === 'submission_unknown') return 'episode.tasks.stage.submissionUnknown'
  if (stage === 'saving') return 'episode.tasks.stage.saving'
  if (stage === 'transferring') return 'episode.tasks.stage.transferring'
  if (stage === 'downloading' || (taskHasResult(task) && task?.status !== 'completed' && task?.status !== 'failed')) {
    return kind === 'image' ? 'episode.tasks.stage.downloadingImage' : kind === 'video' ? 'episode.tasks.stage.downloadingVideo' : 'episode.tasks.stage.downloading'
  }
  if (task?.status === 'completed') return 'episode.status.done'
  if (task?.status === 'failed' || task?.status === 'cancelled') return 'episode.status.failed'
  if (!task && local?.taskId) return 'episode.tasks.stage.queued'
  return 'episode.tasks.stage.generating'
}

export function taskDownloadProgress(task) {
  const progress = taskParams(task?.params).downloadProgress
  if (!progress || !Number.isFinite(progress.receivedBytes) || progress.receivedBytes < 0) return null
  const receivedBytes = progress.receivedBytes
  const totalBytes = Number.isFinite(progress.totalBytes) && progress.totalBytes > 0 && receivedBytes <= progress.totalBytes ? progress.totalBytes : null
  return { receivedBytes, totalBytes, updatedAt: progress.updatedAt || '' }
}

/** Only new, completed image tasks with an explicit server measurement can show this warning. */
export function imageOutputMismatch(task) {
  if ((task?.kind || task?.type) !== 'image' || task?.status !== 'completed') return null
  const output = taskParams(task.params).imageOutput
  if (!output || output.expectedAspectRatio !== '16:9' || output.aspectRatioMatches !== false) return null
  if (!Number.isInteger(output.width) || output.width <= 0 || !Number.isInteger(output.height) || output.height <= 0) return null
  return { width: output.width, height: output.height }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.floor(bytes)} B`
  const unit = bytes >= 1024 * 1024 ? 'MB' : 'KB'
  return `${(bytes / (unit === 'MB' ? 1024 * 1024 : 1024)).toFixed(1)} ${unit}`
}

export function taskErrorContext(task) {
  return { source: 'task', kind: task?.kind || task?.type, errorCode: task?.errorCode || task?.error_code || '', stage: task?.stage || '', hasResult: taskHasResult(task) }
}
