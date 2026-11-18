/** Observed upstream facts only. Never synthesize a progress percentage. */
export function providerProgress(raw: any, parsed: any = {}) {
  const roots = [parsed, raw, raw?.data, raw?.task, raw?.data?.task, raw?.metadata].filter(Boolean)
  let progress: number | null = null
  for (const root of roots) {
    const value = root.progress ?? root.percentage ?? root.percent
    const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?%$/u.test(value.trim()) ? Number(value.trim().slice(0, -1)) : NaN
    if (Number.isFinite(number) && number >= 0 && number <= 100) { progress = number; break }
  }
  const status = parsed.status || raw?.status || raw?.data?.status
  const queued = ['pending', 'queued', 'waiting'].includes(String(status).toLowerCase())
  const stage = queued ? 'upstream_queued' : typeof parsed.stage === 'string' ? parsed.stage.slice(0, 100)
    : typeof raw?.stage === 'string' ? raw.stage.slice(0, 100) : 'polling'
  const timestamp = (value: any) => {
    if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return Date.parse(value)
    if (typeof value === 'number' && value >= 1_000_000_000_000 && value < 10_000_000_000_000) return value
    return null
  }
  const created = timestamp(raw?.createdAt ?? raw?.created_at ?? raw?.task?.createdAt)
  const started = timestamp(raw?.startedAt ?? raw?.started_at ?? raw?.task?.startedAt)
  const finished = timestamp(raw?.finishedAt ?? raw?.finished_at ?? raw?.task?.finishedAt)
  const queueSeconds = typeof raw?.queue_seconds === 'number' && raw.queue_seconds >= 0 ? raw.queue_seconds
    : created !== null && started !== null && started >= created ? (started - created) / 1000 : null
  return { upstreamStatus: status, stage, progress,
    queue_ahead: typeof parsed.queueAhead === 'number' && parsed.queueAhead >= 0 ? parsed.queueAhead : null,
    queue_seconds: queueSeconds,
    upstream_started_at: started === null ? null : new Date(started).toISOString(),
    upstream_finished_at: finished === null ? null : new Date(finished).toISOString() }
}
