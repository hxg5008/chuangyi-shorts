/**
 * Round 5 (2026-11-09, user-approved): 回传视频 for Jimeng tasks that were handed off to Jimeng (accepted + card named).
 *
 * Jimeng renders asynchronously, often for more than a day. The platform therefore stops waiting once the job is accepted
 * (stage `handed_off`) and brings the finished video back later:
 *   - by hand: per shot (POST /tasks/:id/jimeng-return) or per episode (POST /episodes/:id/jimeng-return);
 *   - automatically: every few minutes for all handed-off tasks (default 10 min; HUOBAO_JIMENG_AUTO_RETURN_MINUTES=0 turns it off).
 *
 * Only reads and the service's own "save the finished file" endpoint are used; a generation is NEVER submitted.
 *   1. GET /v1/videos (light list) → the service's job: completed → existing delivery (/v1/downloads + /v1/videos/:id/content);
 *      failed → the task is marked failed with the service's reason.
 *   2. still processing → the service's canvas library entry for the same receipt (cv_ id). It reflects what the user sees on
 *      the canvas after "刷新画布"; a finished entry is saved and fetched (/v1/downloads [cv] + /v1/canvas-library/:cv/content).
 *   3. nothing finished → the task stays handed off; nothing changes.
 * Deliveries run one at a time in the background; the task shows "downloading" meanwhile. A failed delivery puts the task
 * back to handed off. A shot that already has a newer video task keeps its newer video (the shared delivery checks this).
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { fetchProvider } from '../utils/http.js'
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'
import { normalizeJimengBaseUrl, jimengHeaders, isJimengTerminalFailure, safeJimengFailureReason } from './adapters/jimeng-local-video.js'
import { jimengCanvasVideoId } from './jimeng-local-delivery.js'
import { deliverJimengCanvasVideo, deliverJimengVideo } from './jimeng-local-task.js'
import { safeTaskError } from './video-download.js'
import { syncMediaActivity } from './activity/source-sync.js'
import type { AIConfig } from './adapters/types.js'
import { createHash } from 'node:crypto'

type SysTaskRow = typeof schema.sysTask.$inferSelect
export type JimengReturnOutcome = 'returned' | 'returning' | 'not_ready' | 'failed' | 'busy' | 'unavailable' | 'error'
export interface JimengReturnResult { id: number; outcome: JimengReturnOutcome; message: string }
export interface JimengReturnDependencies {
  /** The task's original service config (generation.ts recoveryConfig); injected to avoid an import cycle. */
  resolveConfig: (row: SysTaskRow) => Promise<AIConfig>
  /** Canvas refresh: skip when the last one is newer than this (manual 60 s, automatic = the sweep interval). */
  refreshMaxAgeMs?: number
  /** How long to wait for a started canvas refresh to finish (manual: 25 s so a click stays well inside proxy timeouts). */
  refreshWaitMs?: number
  pollMs?: number
  sleep?: (ms: number) => Promise<unknown>
  /** true: wait for the deliveries and report their final outcome (tests, automatic sweep). Default: background. */
  wait?: boolean
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const params = (row: SysTaskRow) => { try { return JSON.parse(row.params || '{}') || {} } catch { return {} } }
const sync = (id: number) => { try { syncMediaActivity(id) } catch {} }
export const isHandedOffJimengTask = (row: Pick<SysTaskRow, 'provider' | 'type' | 'status' | 'stage'> | undefined | null) =>
  !!row && row.provider === 'jimeng_local' && row.type === 'video' && row.status === 'completed' && row.stage === 'handed_off'

async function call(url: string, init: RequestInit, timeoutMs = 30_000) {
  const response = await fetchProvider(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  if (Buffer.byteLength(text) > 8_000_000) throw new Error('即梦服务响应超过保护上限。')
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = null }
  return { status: response.status, ok: response.ok, body }
}

/** One light list read per service (the new service answers it from a small projection, without reference images). */
async function readJobs(config: AIConfig) {
  const base = normalizeJimengBaseUrl(config.baseUrl)
  const listed = await call(`${base}/v1/videos?limit=500`, { method: 'GET', headers: jimengHeaders(config) })
  if (!listed.ok) throw Object.assign(new Error(`即梦服务任务列表读取失败（HTTP ${listed.status}）。`), { httpStatus: listed.status })
  const jobs = new Map<string, any>()
  for (const job of Array.isArray(listed.body?.data) ? listed.body.data : []) if (typeof job?.id === 'string') jobs.set(job.id, job)
  return jobs
}

/** Refresh one canvas (read-only on Jimeng) when its cache is older than maxAgeMs; wait for it within waitMs. */
async function readCanvas(config: AIConfig, accountId: string, canvasId: string, deps: JimengReturnDependencies) {
  const base = normalizeJimengBaseUrl(config.baseUrl)
  const query = `${base}/v1/canvas-library?${new URLSearchParams({ account_id: accountId, canvas_id: canvasId })}`
  const read = async () => {
    const listed = await call(query, { method: 'GET', headers: jimengHeaders(config) })
    if (!listed.ok) throw Object.assign(new Error(`即梦画布成片读取失败（HTTP ${listed.status}）。`), { httpStatus: listed.status })
    return listed.body || {}
  }
  let library = await read()
  const age = Date.now() - Number(library.last_refreshed || 0) * 1000
  if (!library.refreshing && age > (deps.refreshMaxAgeMs ?? 60_000)) {
    const started = await call(`${base}/v1/canvas-library/refresh`, { method: 'POST', headers: jimengHeaders(config, true), body: JSON.stringify({ account_id: accountId, canvas_id: canvasId }) })
    // 409: another refresh or account operation is running; use the cache.
    if (!started.ok && started.status !== 409) throw Object.assign(new Error(`即梦画布刷新未开始（HTTP ${started.status}）。`), { httpStatus: started.status })
    library = await read()
  }
  const deadline = Date.now() + (deps.refreshWaitMs ?? 25_000)
  while (library.refreshing && Date.now() < deadline) {
    await (deps.sleep || pause)(deps.pollMs ?? 3_000)
    library = await read()
  }
  const items = new Map<string, any>()
  for (const item of Array.isArray(library.data) ? library.data : []) if (typeof item?.id === 'string') items.set(item.id, item)
  return { items, refreshing: !!library.refreshing }
}

function noteCheck(row: SysTaskRow, result: string) {
  const value = { ...params(row), jimengReturn: { ...(params(row).jimengReturn || {}), result, checkedAt: now() } }
  db.update(schema.sysTask).set({ params: JSON.stringify(value) })
    .where(and(eq(schema.sysTask.id, row.id), eq(schema.sysTask.status, 'completed'), eq(schema.sysTask.stage, 'handed_off'))).run()
}
function markFailed(row: SysTaskRow, reason: string, code: string) {
  db.update(schema.sysTask).set({ status: 'failed', stage: 'failed', errorCode: code, errorMsg: reason, updatedAt: now() })
    .where(and(eq(schema.sysTask.id, row.id), eq(schema.sysTask.status, 'completed'), eq(schema.sysTask.stage, 'handed_off'))).run()
  sync(row.id)
}
/** Claim a handed-off task for delivery; false when another 回传 already took it. */
function claim(row: SysTaskRow, canvasVideoId?: string) {
  const value = { ...params(row), jimengCanvasVideoId: canvasVideoId ?? null, jimengReturn: { ...(params(row).jimengReturn || {}), startedAt: now(), via: canvasVideoId ? 'canvas' : 'job' } }
  const result = db.update(schema.sysTask).set({ status: 'processing', stage: 'downloading', errorCode: null, errorMsg: null, params: JSON.stringify(value), updatedAt: now() })
    .where(and(eq(schema.sysTask.id, row.id), eq(schema.sysTask.status, 'completed'), eq(schema.sysTask.stage, 'handed_off'))).run() as { changes?: number }
  if (result.changes) sync(row.id)
  return !!result.changes
}
/** A failed delivery leaves the task handed off (it can be returned again); never a new generation. */
function restoreHandoff(id: number, error: unknown) {
  const current = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()
  const message = safeJimengFailureReason(error instanceof Error ? error.message : String(error || ''), '回传未完成，可稍后再试。')
  if (!current) return message
  const value = { ...params(current), jimengReturn: { ...(params(current).jimengReturn || {}), checkedAt: now(), lastError: message } }
  db.update(schema.sysTask).set({ status: 'completed', stage: 'handed_off', errorCode: null, errorMsg: null, resultUrl: null, params: JSON.stringify(value), updatedAt: now() })
    .where(eq(schema.sysTask.id, id)).run()
  sync(id)
  return message
}

let chain: Promise<unknown> = Promise.resolve()
async function runDelivery(id: number, deliver: () => Promise<boolean>): Promise<JimengReturnResult> {
  try {
    if (!await deliver()) throw new Error('视频保存模块未就绪。')
    const fresh = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()
    if (fresh?.status === 'completed' && fresh.stage === 'completed') {
      logTaskProgress('VideoTask', 'jimeng-returned', { id })
      sync(id)
      return { id, outcome: 'returned', message: '已回传到分镜。' }
    }
    // The shared delivery marks a download problem as failed; keep the job returnable instead.
    return { id, outcome: 'error', message: restoreHandoff(id, fresh?.errorMsg || '视频保存未完成。') }
  } catch (error) {
    logTaskWarn('VideoTask', 'jimeng-return', { id, error: safeTaskError(error) })
    return { id, outcome: 'error', message: restoreHandoff(id, error) }
  }
}
/** Deliveries run one at a time so the local service is never asked for many large files at once. */
function queueDelivery(id: number, deliver: () => Promise<boolean>) {
  const job = chain.then(() => runDelivery(id, deliver))
  chain = job.catch(() => {})
  return job
}

/**
 * Return the given handed-off tasks. Tasks that are not handed off are skipped with a message (nothing to return).
 * Calls are grouped per service config: one job list read and at most one refresh per canvas.
 */
export async function returnJimengVideos(ids: number[], deps: JimengReturnDependencies): Promise<JimengReturnResult[]> {
  const unique = [...new Set(ids.filter(id => Number.isSafeInteger(id) && id > 0))]
  if (!unique.length) return []
  const rows = db.select().from(schema.sysTask).where(inArray(schema.sysTask.id, unique)).all()
  const results: JimengReturnResult[] = []
  const deliveries: Promise<JimengReturnResult>[] = []
  const start = (row: SysTaskRow, deliver: () => Promise<boolean>, canvasVideoId?: string) => {
    if (!claim(row, canvasVideoId)) { results.push({ id: row.id, outcome: 'busy', message: '正在回传，请稍候。' }); return }
    const job = queueDelivery(row.id, deliver)
    if (deps.wait) deliveries.push(job)
    else results.push({ id: row.id, outcome: 'returning', message: '已出片，正在回传到分镜。' })
  }
  const groups = new Map<string, { config: AIConfig; rows: SysTaskRow[] }>()
  for (const row of rows) {
    if (!isHandedOffJimengTask(row)) {
      results.push({ id: row.id, outcome: row.status === 'processing' && row.stage === 'downloading' ? 'busy' : 'unavailable',
        message: row.status === 'processing' && row.stage === 'downloading' ? '正在回传，请稍候。' : '这条任务不是"已交即梦"状态，无需回传。' })
      continue
    }
    let config: AIConfig
    try { config = await deps.resolveConfig(row) }
    catch (error) { results.push({ id: row.id, outcome: 'error', message: safeTaskError(error) }); continue }
    const key = `${config.id ?? ''}|${config.baseUrl}|${config.executionRouteId ?? 'legacy'}|${createHash('sha256').update(config.apiKey).digest('hex')}`
    if (!groups.has(key)) groups.set(key, { config, rows: [] })
    groups.get(key)!.rows.push(row)
  }
  for (const { config, rows: group } of groups.values()) {
    let jobs: Map<string, any>
    try { jobs = await readJobs(config) }
    catch (error) { for (const row of group) results.push({ id: row.id, outcome: 'error', message: safeTaskError(error) }); continue }
    const waiting: { row: SysTaskRow; cv: string; accountId: string; canvasId: string }[] = []
    for (const row of group) {
      let job = row.taskId ? jobs.get(row.taskId) : undefined
      // The light list is bounded. An old task falling outside that page still
      // has an exact immutable ID; query it rather than losing a failure/result.
      if (!job && row.taskId && /^jm_[A-Za-z0-9_-]{8,100}$/u.test(row.taskId)) {
        try {
          const single = await call(`${normalizeJimengBaseUrl(config.baseUrl)}/v1/videos/${encodeURIComponent(row.taskId)}`, { method: 'GET', headers: jimengHeaders(config) })
          if (single.ok) {
            if (single.body?.id !== row.taskId) throw new Error('即梦回传查询返回了其他任务，未替换原编号。')
            job = single.body
          } else if (single.status !== 404) throw new Error(`原即梦任务查询失败（HTTP ${single.status}），未重新生成。`)
        } catch (error) { results.push({ id: row.id, outcome: 'error', message: safeTaskError(error) }); continue }
      }
      if (job?.status === 'completed' && job.download_ready === true) { start(row, () => deliverJimengVideo(row.id, config, row.taskId!)); continue }
      if (job?.status === 'failed') {
        const reason = safeJimengFailureReason(job.error, isJimengTerminalFailure(job.error_code) ? '即梦已确认本次视频生成失败。' : '即梦任务未完成；请在服务端核对原任务。')
        markFailed(row, reason, isJimengTerminalFailure(job.error_code) ? 'generation_failed' : 'jimeng_return_failed')
        results.push({ id: row.id, outcome: 'failed', message: reason })
        continue
      }
      const handoff = params(row).jimengHandoff || {}
      const accountId = handoff.accountId || job?.account_id, canvasId = handoff.canvasId || job?.canvas_id, submitId = handoff.submitId || job?.upstream_task_id
      if (typeof accountId !== 'string' || !accountId || typeof canvasId !== 'string' || !/^\d{1,30}$/u.test(canvasId) || typeof submitId !== 'string' || !submitId) {
        noteCheck(row, 'not_ready')
        results.push({ id: row.id, outcome: 'not_ready', message: '即梦还没有出片。' })
        continue
      }
      waiting.push({ row, cv: jimengCanvasVideoId(accountId, canvasId, submitId), accountId, canvasId })
    }
    const canvases = new Map<string, Promise<Awaited<ReturnType<typeof readCanvas>> | Error>>()
    for (const item of waiting) {
      const key = `${item.accountId}\0${item.canvasId}`
      if (!canvases.has(key)) canvases.set(key, readCanvas(config, item.accountId, item.canvasId, deps).catch(error => error as Error))
      const library = await canvases.get(key)!
      if (library instanceof Error) {
        noteCheck(item.row, 'canvas_unavailable')
        results.push({ id: item.row.id, outcome: 'not_ready', message: `暂时读不到即梦画布：${safeTaskError(library)}` })
        continue
      }
      const entry = library.items.get(item.cv)
      if (entry?.download_ready === true) { start(item.row, () => deliverJimengCanvasVideo(item.row.id, config, item.cv), item.cv); continue }
      if (entry?.status === 'failed') {
        const reason = safeJimengFailureReason(entry.error, '即梦画布显示这条视频生成失败。')
        markFailed(item.row, reason, isJimengTerminalFailure(entry.error_code) ? 'generation_failed' : 'jimeng_return_failed')
        results.push({ id: item.row.id, outcome: 'failed', message: reason })
        continue
      }
      noteCheck(item.row, 'not_ready')
      results.push({ id: item.row.id, outcome: 'not_ready', message: library.refreshing ? '即梦画布还在刷新，暂未看到成片；稍后再点回传。' : '即梦还没有出片。' })
    }
  }
  if (deps.wait) results.push(...await Promise.all(deliveries))
  return results.sort((a, b) => a.id - b.id)
}

/** The newest video task of each shot in one episode, kept only when it is handed off. */
export function handedOffTasksOfEpisode(episodeId: number) {
  const shots = db.select({ id: schema.storyboards.id }).from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt))).all().map(row => row.id)
  if (!shots.length) return [] as number[]
  const tasks = db.select().from(schema.sysTask).where(and(eq(schema.sysTask.type, 'video'), inArray(schema.sysTask.storyboardId, shots)))
    .orderBy(desc(schema.sysTask.id)).all()
  const newest = new Map<number, SysTaskRow>()
  for (const task of tasks) if (task.storyboardId && !newest.has(task.storyboardId)) newest.set(task.storyboardId, task)
  return [...newest.values()].filter(isHandedOffJimengTask).map(task => task.id)
}

/** All handed-off tasks that are still the newest video task of their shot (tasks without a shot are included). */
export function handedOffTasksToSweep() {
  const rows = db.select().from(schema.sysTask).where(and(eq(schema.sysTask.provider, 'jimeng_local'), eq(schema.sysTask.type, 'video'),
    eq(schema.sysTask.status, 'completed'), eq(schema.sysTask.stage, 'handed_off'))).orderBy(desc(schema.sysTask.id)).all()
  const ids: number[] = []
  for (const row of rows) {
    if (row.storyboardId) {
      const latest = db.select({ id: schema.sysTask.id }).from(schema.sysTask).where(and(eq(schema.sysTask.type, 'video'), eq(schema.sysTask.storyboardId, row.storyboardId)))
        .orderBy(desc(schema.sysTask.id)).limit(1).get()
      if (latest && latest.id !== row.id) continue
    }
    ids.push(row.id)
  }
  return ids
}

/** Automatic 回传: every interval, all handed-off tasks, no canvas refresh more often than the interval. */
let timer: ReturnType<typeof setInterval> | null = null
let sweeping = false
export function autoReturnMinutes() {
  const raw = process.env.HUOBAO_JIMENG_AUTO_RETURN_MINUTES
  const value = raw === undefined || raw === '' ? 10 : Number(raw)
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 24 * 60) : 10
}
export async function sweepHandedOffJimengVideos(deps: JimengReturnDependencies) {
  if (sweeping) return []
  sweeping = true
  try {
    const ids = handedOffTasksToSweep()
    return ids.length ? await returnJimengVideos(ids, { ...deps, wait: true }) : []
  } finally { sweeping = false }
}
export function startJimengAutoReturn(deps: JimengReturnDependencies) {
  const minutes = autoReturnMinutes()
  if (timer || !minutes) return
  const interval = minutes * 60_000
  timer = setInterval(() => {
    void sweepHandedOffJimengVideos({ refreshWaitMs: 180_000, ...deps, refreshMaxAgeMs: interval })
      .catch(error => logTaskWarn('VideoTask', 'jimeng-auto-return', { error: safeTaskError(error) }))
  }, interval)
  timer.unref?.()
}
export function stopJimengAutoReturn() { if (timer) clearInterval(timer); timer = null }
