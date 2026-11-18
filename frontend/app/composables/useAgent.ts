import { toast } from 'vue-sonner'
import { onScopeDispose, ref, watch } from 'vue'
import { api } from './useApi'
import { toastError } from './useToast'
import { i18n } from './i18n'

export interface AgentIssue {
  code: string
  message: string
  field?: string
  severity?: 'warning' | 'error'
  storyboard_id?: number
  shot_number?: number
}

/** Internal review guidance is not a task result or an actionable warning. */
export function visibleAgentIssues(issues?: readonly AgentIssue[]) {
  return (issues || []).filter(issue => !(issue.code === 'semantic_review_required' && issue.severity === 'warning' && issue.field === 'groups'))
}

export function primaryAgentIssue(issues?: readonly AgentIssue[]) {
  const visible = visibleAgentIssues(issues)
  return visible.find(issue => issue.severity !== 'warning') || visible[0]
}

export interface AgentJob {
  id: number | string
  agent_type: string
  episode_id: number
  scope?: string
  storyboard_ids?: number[]
  status: 'running' | 'done' | 'needs_revision' | 'error'
  phase: string
  attempt?: number
  error?: string
  started_at?: string
  finished_at?: string
  updated_at?: string
  draft_id?: string
  issues?: AgentIssue[]
}

interface JobOptions {
  modelParameters?: Record<string, unknown>
  storyboardIds?: number[]
  onSettled?: (job: AgentJob) => void | Promise<void>
  onDone?: (job: AgentJob) => void | Promise<void>
  successMessage?: string
  /** Read-only observers refresh results without replaying notifications or follow-up generation. */
  silent?: boolean
}

/** Leaving a page stops observation, while the server keeps its durable job running. */
export function useAgent({ getIdentity }: { getIdentity?: () => string } = {}) {
  const running = ref(false)
  const runningType = ref<string | null>(null)
  const phase = ref<string | null>(null)
  const activeJobs = ref<AgentJob[]>([])
  const journalJobs = ref<AgentJob[]>([])
  const lastResult = ref<AgentJob | null>(null)
  const lastResultIsHistory = ref(false)
  let disposed = false
  let epoch = 0
  let requestVersion = 0
  let episodeContext: number | null = null
  let pendingId = 0
  let chatType: string | null = null
  let newestObserved: AgentJob | null = null
  let reconciledTerminal = ''
  const waits = new Map<string, { timer?: ReturnType<typeof setTimeout>; resolve: (job?: AgentJob) => void; promise: Promise<AgentJob | undefined> }>()

  const identity = () => ({ epoch, key: getIdentity?.(), episodeId: episodeContext })
  const isCurrent = (token: ReturnType<typeof identity>) => !disposed && token.epoch === epoch && token.key === getIdentity?.() && token.episodeId === episodeContext
  const startTime = (job?: AgentJob | null) => Date.parse(job?.started_at || '')
  // A completed job can receive a corrected durable draft without changing its
  // original finish time. Observe that revision once, without replaying done.
  const resultKey = (job: AgentJob) => `${job.id}:${job.status}:${job.finished_at || ''}:${job.updated_at || ''}:${job.draft_id || ''}:${job.phase}`
  function olderThan(candidate: AgentJob, current?: AgentJob | null) {
    const candidateTime = startTime(candidate), currentTime = startTime(current)
    return Number.isFinite(currentTime) && (!Number.isFinite(candidateTime) || candidateTime < currentTime)
  }
  function behind(candidate: AgentJob, current?: AgentJob | null) {
    if (olderThan(candidate, current)) return true
    if (current && String(candidate.id) === String(current.id)) {
      if (current.status !== 'running' && candidate.status !== current.status) return true
      const candidateUpdate = Date.parse(candidate.updated_at || ''), currentUpdate = Date.parse(current.updated_at || '')
      if (Number.isFinite(candidateUpdate) && Number.isFinite(currentUpdate) && candidateUpdate < currentUpdate) return true
    }
    return false
  }
  function observe(job: AgentJob) {
    if (!newestObserved || !behind(job, newestObserved)) newestObserved = job
  }
  function superseded(job: AgentJob) {
    return !!newestObserved && String(newestObserved.id) !== String(job.id)
      && Number.isFinite(startTime(job)) && startTime(newestObserved) > startTime(job)
  }
  function selectEpisode(episodeId: number) {
    if (episodeContext !== null && episodeContext !== episodeId) stop()
    episodeContext = episodeId
  }
  function syncRunning() {
    running.value = !!chatType || activeJobs.value.length > 0
    runningType.value = chatType || activeJobs.value[0]?.agent_type || null
    phase.value = activeJobs.value[0]?.phase || null
  }
  function put(job: AgentJob) {
    if (lastResultIsHistory.value) { lastResult.value = null; lastResultIsHistory.value = false }
    activeJobs.value = [...activeJobs.value.filter(item => String(item.id) !== String(job.id)), job]
    syncRunning()
  }
  function remove(id: number | string) {
    activeJobs.value = activeJobs.value.filter(item => String(item.id) !== String(id))
    syncRunning()
  }
  function stop() {
    epoch++
    requestVersion++
    episodeContext = null
    for (const wait of waits.values()) {
      if (wait.timer != null) clearTimeout(wait.timer)
      wait.resolve()
    }
    waits.clear()
    activeJobs.value = []
    journalJobs.value = []
    lastResult.value = null
    lastResultIsHistory.value = false
    newestObserved = null
    reconciledTerminal = ''
    chatType = null
    syncRunning()
  }
  onScopeDispose(() => { disposed = true; stop() })
  if (getIdentity) watch(getIdentity, stop, { flush: 'sync' })

  async function complete(job: AgentJob, options: JobOptions, token: ReturnType<typeof identity>) {
    if (!isCurrent(token) || superseded(job)) return
    // A saved prompt from an earlier attempt never proves that this job succeeded.
    await options.onSettled?.(job)
    if (!isCurrent(token) || superseded(job)) return
    lastResult.value = job
    lastResultIsHistory.value = false
    if (job.status === 'done') {
      await options.onDone?.(job)
      if (isCurrent(token) && !superseded(job) && !options.silent) toast.success(options.successMessage || i18n.global.t('composables.agent.done'))
    } else if (job.status === 'needs_revision') {
      const issue = primaryAgentIssue(job.issues)?.message || job.error
      if (!options.silent) toast.warning(`${i18n.global.t(job.draft_id ? 'composables.agent.draftSaved' : 'composables.agent.needsRevision')}${issue ? `：${issue}` : ''}`)
    } else {
      if (!options.silent) toastError(job.error || primaryAgentIssue(job.issues)?.message || i18n.global.t('composables.agent.failed'), { source: 'task', fallback: 'composables.agent.failed' })
    }
  }

  function wait(jobId: number | string, options: JobOptions = {}, initial?: AgentJob): Promise<AgentJob | undefined> {
    if (disposed) return Promise.resolve(undefined)
    if (initial) selectEpisode(initial.episode_id)
    const key = String(jobId)
    const existing = waits.get(key)
    if (existing) return existing.promise
    const token = identity()
    let resolve!: (job?: AgentJob) => void
    const promise = new Promise<AgentJob | undefined>(done => { resolve = done })
    const entry = { timer: undefined as ReturnType<typeof setTimeout> | undefined, resolve, promise }
    waits.set(key, entry)
    if (initial) put(initial)
    const current = () => isCurrent(token) && waits.get(key) === entry
    async function poll() {
      entry.timer = undefined
      if (!current()) return
      let job: AgentJob
      try {
        job = await api.get<AgentJob>(`/agent/jobs/${jobId}`)
      } catch {
        // A transport error is not the outcome of the durable server job.
        if (current()) entry.timer = setTimeout(poll, 2000)
        return
      }
      if (!current()) return
      if (!job || String(job.id) !== key || token.episodeId !== null && Number(job.episode_id) !== token.episodeId) {
        // Never apply a response from another job/episode to this page.
        entry.timer = setTimeout(poll, 2000)
        return
      }
      observe(job)
      if (job.status !== 'running' && superseded(job)) {
        waits.delete(key)
        remove(jobId)
        resolve(job)
        void reconcile(job.episode_id, options)
        return
      }
      put(job)
      if (job.status === 'running') {
        entry.timer = setTimeout(poll, 1500)
        return
      }
      try { await complete(job, options, token) }
      catch (error) { if (current()) toastError(error) }
      finally {
        if (current()) {
          waits.delete(key)
          remove(jobId)
          resolve(job)
          if (superseded(job)) void reconcile(job.episode_id, options)
        }
      }
    }
    void poll()
    return promise
  }

  async function runJob(type: string, message: string, dramaId: number, episodeId: number, options: JobOptions = {}, model?: string, configId?: number) {
    if (disposed) return
    selectEpisode(episodeId)
    requestVersion++
    const token = identity()
    const temporaryId = `submitting:${++pendingId}`
    put({ id: temporaryId, agent_type: type, episode_id: episodeId, scope: 'agent', storyboard_ids: options.storyboardIds || [], status: 'running', phase: 'generating' })
    lastResult.value = null
    lastResultIsHistory.value = false
    try {
      const result = await api.post<{ job_id: number }>(`/agent/${type}/jobs`, {
        message, drama_id: dramaId, episode_id: episodeId,
        model: model || undefined, config_id: configId || undefined, model_parameters: options.modelParameters,
        ...(options.storyboardIds?.length ? { storyboard_ids: options.storyboardIds } : {}),
      })
      if (!isCurrent(token)) return
      if (!result?.job_id) throw new Error(i18n.global.t('composables.agent.failed'))
      remove(temporaryId)
      return await wait(result.job_id, options, { id: result.job_id, agent_type: type, episode_id: episodeId, scope: 'agent', storyboard_ids: options.storyboardIds || [], status: 'running', phase: 'generating' })
    } catch (error) {
      if (isCurrent(token)) toastError(error)
    } finally {
      if (isCurrent(token)) remove(temporaryId)
    }
  }

  async function resume(episodeId: number, options: JobOptions = {}, observing = false) {
    if (disposed || !episodeId) return []
    selectEpisode(episodeId)
    const token = identity()
    const version = ++requestVersion
    try {
      const jobs = await api.get<AgentJob[]>(`/agent/jobs?episode_id=${episodeId}`)
      if (!isCurrent(token) || version !== requestVersion) return []
      const ownJobs = (Array.isArray(jobs) ? jobs : []).filter(job => job.scope === 'agent' && Number(job.episode_id) === Number(episodeId))
      const latest = ownJobs[0]
      const staleSnapshot = !!latest && behind(latest, newestObserved)
      if (!staleSnapshot && (!observing || latest)) journalJobs.value = ownJobs
      if (latest) observe(latest)
      // Polling the already selected job is authoritative. A list snapshot must
      // not replace it with a historical terminal result while it is active.
      if (running.value) return ownJobs
      if (staleSnapshot || observing && !latest || latest && behind(latest, lastResult.value)) return ownJobs
      const sameCurrentResult = lastResult.value && latest && String(lastResult.value.id) === String(latest.id) && !lastResultIsHistory.value
      const currentRunningJobs = ownJobs.filter(job => job.status === 'running' && !superseded(job))
      lastResult.value = currentRunningJobs.length ? null : latest || null
      lastResultIsHistory.value = !!lastResult.value && !sameCurrentResult
      const waitOptions = observing ? { ...options, silent: true, onDone: undefined } : options
      for (const job of currentRunningJobs) void wait(job.id, waitOptions, job)
      if (observing && latest && latest.status !== 'running' && resultKey(latest) !== reconciledTerminal) {
        await options.onSettled?.(latest)
        if (isCurrent(token) && version === requestVersion) reconciledTerminal = resultKey(latest)
      }
      return ownJobs
    } catch (error) {
      if (!observing && isCurrent(token) && version === requestVersion) toastError(error)
      return []
    }
  }

  /** Reconcile changes made by another tab or a backend worker using GET only. */
  function reconcile(episodeId: number, options: JobOptions = {}) {
    return resume(episodeId, { ...options, silent: true, onDone: undefined }, true)
  }

  async function run(type: string, msg: string, dramaId: number, episodeId: number, onDone?: () => void | Promise<void>, model?: string, configId?: number, options: JobOptions = {}) {
    if (disposed) return
    selectEpisode(episodeId)
    if (running.value) { toast.warning(i18n.global.t('composables.agent.busy')); return }
    if (type === 'storyboard_breaker') return runJob(type, msg, dramaId, episodeId, { ...options, onDone }, model, configId)
    requestVersion++
    const token = identity()
    lastResult.value = null
    lastResultIsHistory.value = false
    chatType = type
    syncRunning()
    try {
      await api.post(`/agent/${type}/chat`, {
        message: msg, drama_id: dramaId, episode_id: episodeId,
        model: model || undefined, config_id: configId || undefined, model_parameters: options.modelParameters,
      })
      if (!isCurrent(token)) return
      await onDone?.()
      if (isCurrent(token)) toast.success(i18n.global.t('composables.agent.done'))
    } catch (error) {
      if (isCurrent(token)) toastError(error)
    } finally {
      if (isCurrent(token)) { chatType = null; syncRunning() }
    }
  }

  return { running, runningType, phase, activeJobs, journalJobs, lastResult, lastResultIsHistory, run, runJob, wait, resume, reconcile, stop }
}
