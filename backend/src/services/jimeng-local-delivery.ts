/**
 * Round 3 (2026-11-08, user-approved item 9): automatic delivery of finished Jimeng videos back to their storyboard.
 *
 * The local Jimeng service only marks a finished generation as "ready for download" (it never pushes a file).
 * When a task reaches that state, this module asks the SAME service, with the same task ID and key:
 *   1. POST /v1/downloads {ids:[task]}   — the service saves the original video in its own results folder
 *      (no new generation is ever submitted; an already saved file is skipped by the service);
 *   2. GET  /v1/videos/:task             — until has_local_file / video_url is reported;
 *   3. GET  /v1/videos/:task/content     — the video bytes, saved by the normal video delivery path, which also
 *      writes storyboards.video_url unless a newer video task exists for that storyboard.
 * Any failure leaves the task completed with a clear note; the user can still download manually or press restore.
 */
import { createHash } from 'node:crypto'
import { fetchProvider } from '../utils/http.js'
import { buildJimengContentRequest, normalizeJimengBaseUrl, jimengHeaders } from './adapters/jimeng-local-video.js'
import type { AIConfig, ProviderRequest } from './adapters/types.js'

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export interface JimengFetchDependencies {
  fetch?: typeof fetchProvider
  sleep?: (ms: number) => Promise<unknown>
  /** Total time to wait for the service to save the file locally. */
  waitMs?: number
  pollMs?: number
}

async function call(dependencies: JimengFetchDependencies, url: string, init: RequestInit) {
  const response = await (dependencies.fetch || fetchProvider)(url, { ...init, signal: AbortSignal.timeout(30_000) })
  const text = await response.text()
  if (Buffer.byteLength(text) > 2_000_000) throw new Error('即梦服务响应超过保护上限。')
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = null }
  return { status: response.status, ok: response.ok, body }
}

/**
 * Ask the local service to save the finished video and return the authenticated content request when the file is
 * available. Throws a readable error otherwise. Never submits a generation.
 */
export async function requestJimengLocalFile(config: AIConfig, taskId: string, dependencies: JimengFetchDependencies = {}) {
  const base = normalizeJimengBaseUrl(config.baseUrl)
  const job = await call(dependencies, `${base}/v1/videos/${encodeURIComponent(taskId)}`, { method: 'GET', headers: jimengHeaders(config) })
  if (!job.ok) throw Object.assign(new Error(`即梦服务查询原任务失败（HTTP ${job.status}）。`), { httpStatus: job.status })
  if (!job.body?.has_local_file) {
    const queued = await call(dependencies, `${base}/v1/downloads`, { method: 'POST', headers: jimengHeaders(config, true), body: JSON.stringify({ ids: [taskId] }) })
    if (!queued.ok) throw Object.assign(new Error(`即梦服务未接受下载请求（HTTP ${queued.status}）。`), { httpStatus: queued.status })
    const skipped = Array.isArray(queued.body?.skipped) ? queued.body.skipped.find((row: any) => row?.id === taskId) : null
    if (skipped && !/已保存/u.test(String(skipped.reason || ''))) throw new Error(`即梦服务暂不能下载原视频：${String(skipped.reason || '').slice(0, 120)}`)
    const deadline = Date.now() + (dependencies.waitMs ?? 10 * 60_000)
    for (let check = 0; ; check++) {
      // The service often saves a small file at once; check right away, then every few seconds.
      if (check) await (dependencies.sleep || pause)(dependencies.pollMs ?? 5_000)
      const current = await call(dependencies, `${base}/v1/videos/${encodeURIComponent(taskId)}`, { method: 'GET', headers: jimengHeaders(config) })
      if (current.ok && current.body?.has_local_file) break
      if (current.ok && current.body?.download_status === 'failed') throw new Error(`即梦服务下载原视频未完成：${String(current.body.download_error || '').slice(0, 160)}`)
      if (Date.now() > deadline) throw new Error('即梦服务保存原视频超时；可稍后点恢复，或在服务端手动下载。')
    }
  }
  return buildJimengContentRequest(config, taskId)
}

/** Round 5: the canvas library's own id for one accepted job (same formula as the service's canvas_library.py). */
export function jimengCanvasVideoId(accountId: string, canvasId: string, submitId: string) {
  return 'cv_' + createHash('sha256').update(`${accountId}\0${canvasId}\0${submitId}`, 'utf8').digest('hex').slice(0, 32)
}
export const isJimengCanvasVideoId = (value: unknown): value is string => typeof value === 'string' && /^cv_[a-f0-9]{32}$/u.test(value)
export function buildJimengCanvasContentRequest(config: AIConfig, canvasVideoId: string): ProviderRequest {
  if (!isJimengCanvasVideoId(canvasVideoId)) throw new Error('画布成片编号不正确。')
  return { url: `${normalizeJimengBaseUrl(config.baseUrl)}/v1/canvas-library/${canvasVideoId}/content`, method: 'GET', headers: jimengHeaders(config), body: undefined }
}

/**
 * Round 5: the same as requestJimengLocalFile, for a finished video the service only knows from its canvas library
 * (the service's job poller has not reported it yet). Saves it on the service, then returns the content request.
 */
export async function requestJimengCanvasFile(config: AIConfig, canvasVideoId: string, dependencies: JimengFetchDependencies = {}) {
  if (!isJimengCanvasVideoId(canvasVideoId)) throw new Error('画布成片编号不正确。')
  const base = normalizeJimengBaseUrl(config.baseUrl), detail = `${base}/v1/canvas-library/${canvasVideoId}`
  const item = await call(dependencies, detail, { method: 'GET', headers: jimengHeaders(config) })
  if (!item.ok) throw Object.assign(new Error(`即梦服务查询画布成片失败（HTTP ${item.status}）。`), { httpStatus: item.status })
  if (!item.body?.has_local_file) {
    if (item.body?.download_ready !== true) throw new Error('即梦画布中的这条成片尚未就绪。')
    const queued = await call(dependencies, `${base}/v1/downloads`, { method: 'POST', headers: jimengHeaders(config, true), body: JSON.stringify({ ids: [canvasVideoId] }) })
    if (!queued.ok) throw Object.assign(new Error(`即梦服务未接受下载请求（HTTP ${queued.status}）。`), { httpStatus: queued.status })
    const skipped = Array.isArray(queued.body?.skipped) ? queued.body.skipped.find((row: any) => row?.id === canvasVideoId) : null
    if (skipped && !/已保存|已在本地下载队列/u.test(String(skipped.reason || ''))) throw new Error(`即梦服务暂不能下载原视频：${String(skipped.reason || '').slice(0, 120)}`)
    const deadline = Date.now() + (dependencies.waitMs ?? 10 * 60_000)
    for (let check = 0; ; check++) {
      if (check) await (dependencies.sleep || pause)(dependencies.pollMs ?? 5_000)
      const current = await call(dependencies, detail, { method: 'GET', headers: jimengHeaders(config) })
      if (current.ok && current.body?.has_local_file) break
      if (current.ok && current.body?.download_status === 'failed') throw new Error(`即梦服务下载原视频未完成：${String(current.body.download_error || '').slice(0, 160)}`)
      if (Date.now() > deadline) throw new Error('即梦服务保存原视频超时；可稍后再点回传。')
    }
  }
  return buildJimengCanvasContentRequest(config, canvasVideoId)
}
