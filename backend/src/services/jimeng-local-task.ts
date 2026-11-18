/** A local executor receipt is durable. Recovery queries this receipt; it never resubmits generation. */
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../utils/response.js'
import { fetchProvider } from '../utils/http.js'
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'
import { safeTaskError } from './video-download.js'
import { JimengLocalVideoAdapter, buildJimengLookupRequest, promptHash, safeJimengFailureReason } from './adapters/jimeng-local-video.js'
import { prepareJimengVideoRecord } from './jimeng-local-media.js'
import { requestJimengCanvasFile, requestJimengLocalFile } from './jimeng-local-delivery.js'
import type { AIConfig, ProviderRequest, VideoGenerationRecord } from './adapters/types.js'

/**
 * Round 3 (item 9): saving the delivered file lives in generation.ts (shared video delivery and storyboard
 * write-back); it registers itself here to avoid an import cycle. Without a registered handler the task keeps the
 * previous behaviour (completed, manual download in the local service).
 */
type VideoDelivery = (taskId: number, contentUrl: string) => Promise<void>
let deliverVideo: VideoDelivery | null = null
export function setJimengVideoDelivery(handler: VideoDelivery | null) { deliverVideo = handler }

/** Fetch the finished video from the local service and save it to the storyboard; never resubmits generation. */
export async function deliverJimengVideo(id: number, config: AIConfig, taskId: string) {
  if (!deliverVideo) return false
  const content = await requestJimengLocalFile(config, taskId)
  await deliverVideo(id, content.url)
  return true
}

/** Round 5: the same, from the service's canvas library copy of the accepted job (cv_ id). Never resubmits. */
export async function deliverJimengCanvasVideo(id: number, config: AIConfig, canvasVideoId: string) {
  if (!deliverVideo) return false
  const content = await requestJimengCanvasFile(config, canvasVideoId)
  await deliverVideo(id, content.url)
  return true
}

/**
 * Round 5 (2026-11-09, user-approved) timings. Tests shorten them; production uses these defaults.
 * - submitTimeoutMs: a busy service can take longer than 30 s to answer the POST; a lost answer is looked up, never resent.
 * - lookupDelaysMs: after a lost or late submit answer, look the original request up now and after 1, 3 and 10 minutes.
 * - namingGraceMs: accepted but the card name is still not settled → hand off anyway after this long.
 * - queuedPollMs: the service still holds the job in its own queue (not sent to Jimeng yet) → poll less often.
 */
export const jimengTimings = {
  submitTimeoutMs: 120_000,
  lookupDelaysMs: [0, 60_000, 120_000, 420_000],
  namingGraceMs: 30 * 60_000,
  queuedPollMs: 60_000,
  pollMs: 15_000,
}
export function setJimengTimings(patch: Partial<typeof jimengTimings>) { Object.assign(jimengTimings, patch) }

export const jimengRecord = (row: typeof schema.sysTask.$inferSelect): VideoGenerationRecord => {
  const p = JSON.parse(row.params || '{}')
  return { ...p, id:row.id, model:row.model, prompt:row.prompt,
    referenceImageUrls:JSON.stringify(p.referenceImageUrls || []), referenceImageNames:JSON.stringify(p.referenceImageNames || []) }
}
const adapter = new JimengLocalVideoAdapter()
const pause = (ms:number) => new Promise(resolve => setTimeout(resolve,ms))
async function update(id:number, patch: Partial<typeof schema.sysTask.$inferInsert>) {
  await db.update(schema.sysTask).set({...patch,updatedAt:now()}).where(eq(schema.sysTask.id,id))
}
async function request(req:ProviderRequest, timeoutMs = 30_000) {
  const response = await fetchProvider(req.url,{method:req.method,headers:req.headers,
    ...(req.body === undefined ? {} : {body:JSON.stringify(req.body)}),signal:AbortSignal.timeout(timeoutMs)})
  if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`即梦本地服务请求失败（HTTP ${response.status}）。`),{httpStatus:response.status}) }
  const text = await response.text()
  if (Buffer.byteLength(text)>2_000_000) throw Error('即梦任务查询响应超过保护上限。')
  return JSON.parse(text)
}
async function fail(id:number,error:unknown,code:string) {
  await update(id,{status:'failed',stage:code === 'submission_unknown' ? 'submission_unknown' : 'failed',errorCode:code,
    errorMsg:safeJimengFailureReason(error instanceof Error ? error.message : error,'即梦本地任务未完成，请核对原任务。')})
}
const UNKNOWN_SUBMISSION = '即梦提交结果待核对，原请求编号已保留。请恢复查询原任务，不要重复生成。'
const KEY_REFUSED = '即梦服务拒绝了访问 Key，暂时无法核对原任务；请检查即梦服务配置后点「恢复视频」。原请求编号已保留，不要重复生成。'

/**
 * Round 5: look the original request up by its persisted UUID; never resend. A record that does not exist yet may still
 * appear (the service can store it after the platform stopped waiting), so the lookup is repeated on the given schedule.
 * Returns the message to show when nothing was found.
 */
async function lookUpReceipt(id:number, config:AIConfig, key:string, persist:(raw:any)=>Promise<void>, delays:number[]) {
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) {
      await update(id,{stage:'submission_checking',errorCode:null,errorMsg:null})
      await pause(delays[attempt])
      const row = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id,id)).get()
      if (!row || row.status !== 'processing') return { found: false, stopped: true, message: '' }
    }
    let raw:any
    try { raw = await request(buildJimengLookupRequest(config,key)) }
    catch (error:any) {
      // A refused key will not start working by waiting; anything else (404 not stored yet, 5xx, timeout) may.
      if ([401,403].includes(error?.httpStatus)) return { found: false, stopped: false, message: KEY_REFUSED }
      continue
    }
    // A receipt that answers for different content is an integrity failure, not a missing record.
    await persist(raw)
    return { found: true, stopped: false, message: '' }
  }
  return { found: false, stopped: false, message: UNKNOWN_SUBMISSION }
}

const NAMING_SETTLED = new Set(['completed','failed','not_requested'])
const text = (value:unknown, max = 200) => typeof value === 'string' && value.trim() ? value.trim().slice(0,max) : null
/**
 * Round 5: Jimeng accepted the job (receipt saved) and its canvas card is named → the platform's part is done.
 * Jimeng renders asynchronously (often more than a day); the video is brought back later by 回传 (manual or automatic).
 * A submission that needs manual review (unknown/ambiguous) is never handed off.
 */
export function jimengHandoffInfo(raw:any, params:any) {
  const submitId = text(raw?.upstream_task_id)
  if (raw?.status !== 'processing' || !submitId || raw.unknown === true || raw.submission_review === true || raw.error_code === 'ambiguous_submission') return null
  const naming = typeof raw.name_status === 'string' && raw.name_status ? raw.name_status : 'not_requested'
  const seen = Date.parse(params?.jimengAcceptedSeenAt || '')
  const graceOver = Number.isFinite(seen) && Date.now() - seen >= jimengTimings.namingGraceMs
  if (!NAMING_SETTLED.has(naming) && !graceOver) return null
  return { at: now(), submitId, accountId: text(raw.account_id), canvasId: text(raw.canvas_id), title: text(raw.title,100), nameStatus: naming }
}

export async function runJimengTask(id:number, config:AIConfig, recover=false) {
  let row = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id,id)).get()
  if (!row || row.provider !== 'jimeng_local' || row.type !== 'video' || row.status === 'completed') return
  const params = JSON.parse(row.params || '{}'), record = jimengRecord(row)
  let taskId = row.taskId || ''
  const persistReceipt = async (raw:any) => {
    const receipt = adapter.parseGenerateResponse(raw).taskId!
    // The full receipt must match our final prompt and frozen ordered references.
    adapter.parsePollResponse(raw,receipt)
    if (raw.prompt_sha256 !== promptHash(record.prompt!) || raw.reference_count !== params.referenceImageUrls.length) throw Error('即梦返回的正文或参考图回执与本轮任务不一致。')
    taskId=receipt
    await update(id,{taskId,status:'processing',stage:'polling',errorCode:null,errorMsg:null})
  }
  try {
    if (!taskId) {
      if (recover || params.submissionStartedAt) {
        // Even a 404 is not permission to POST again: the old server may have lost data.
        // A submission from the last 15 minutes may still be stored late, so keep the remaining lookup schedule.
        const started = Date.parse(params.submissionStartedAt || '')
        const recent = Number.isFinite(started) && Date.now() - started < 15 * 60_000
        const outcome = await lookUpReceipt(id,config,params.idempotencyKey,persistReceipt,recent ? jimengTimings.lookupDelaysMs : [0])
        if (outcome.stopped) return
        if (!outcome.found) { await fail(id,outcome.message,'submission_unknown');return }
      } else {
        // New tasks freeze page numbering at creation; legacy tasks retain their ID-only metadata.
        const prepared = await prepareJimengVideoRecord(record,params.jimengSnapshots,params.jimengMetadata || {storyboard_id:row.storyboardId ?? undefined,drama_id:row.dramaId ?? undefined})
        const req = adapter.buildGenerateRequest(config,prepared)
        params.submissionStartedAt=now()
        await update(id,{params:JSON.stringify(params),stage:'submitting'})
        logTaskProgress('VideoTask','jimeng-submit',{id,model:record.model,referenceCount:prepared.jimengImages?.length || 0})
        try { await persistReceipt(await request(req,jimengTimings.submitTimeoutMs)) }
        catch (error:any) {
          if ([400,401,403,409,413,422].includes(error.httpStatus)) throw error
          // A response may be lost after persistence. Query the same UUID now and after 1, 3 and 10 minutes; never resend.
          const outcome = await lookUpReceipt(id,config,params.idempotencyKey,persistReceipt,jimengTimings.lookupDelaysMs)
          if (outcome.stopped) return
          if (!outcome.found) { await fail(id,outcome.message,'submission_unknown');return }
        }
      }
    }
  } catch (error:any) {
    await fail(id,error, recover || params.submissionStartedAt && ![400,401,403,409,413,422].includes(error.httpStatus) ? 'submission_unknown' : 'jimeng_submission_failed')
    return
  }

  // Local service owns the long-running upstream work; there is deliberately no 50-minute generation timeout here.
  let errors=0
  for (;;) {
    row = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id,id)).get()
    if (!row || row.status !== 'processing') return
    let queued = false
    try {
      const raw = await request(adapter.buildPollRequest(config,taskId)), result=adapter.parsePollResponse(raw,taskId)
      if (raw.prompt_sha256 !== promptHash(record.prompt!) || raw.reference_count !== params.referenceImageUrls.length) throw Object.assign(new Error('即梦原任务完整性回执不一致，未替换原任务。'),{errorCode:'receipt_mismatch'})
      errors=0
      if (result.status === 'completed' && result.manualDelivery) {
        // Round 3 (item 9): fetch the original video from the local service and save it to the storyboard.
        // If that fails, keep the previous behaviour: completed, downloadable by hand in the local service.
        params.manualDelivery=true
        await update(id,{status:'completed',stage:'ready_in_local_service',params:JSON.stringify(params),errorCode:null,errorMsg:null,completedAt:now()})
        if (deliverVideo) {
          try {
            await update(id,{status:'processing',stage:'downloading'})
            await deliverJimengVideo(id,config,taskId)
          } catch (error) {
            logTaskWarn('VideoTask','jimeng-auto-delivery',{id,taskId,error:safeTaskError(error)})
            await update(id,{status:'completed',stage:'ready_in_local_service',errorCode:'auto_delivery_failed',
              errorMsg:safeJimengFailureReason(error instanceof Error ? error.message : String(error),'自动取回视频未完成；可点恢复重试，或在服务端手动下载。'),completedAt:now()})
          }
        }
        return
      }
      if (result.status === 'failed') { await fail(id,result.error,result.errorCode || 'generation_failed');return }
      // Round 5: accepted and named → hand off; the video comes back later through 回传.
      const handoff = jimengHandoffInfo(raw,params)
      if (handoff) {
        params.jimengHandoff = handoff
        await update(id,{status:'completed',stage:'handed_off',params:JSON.stringify(params),errorCode:null,errorMsg:null,completedAt:now()})
        logTaskProgress('VideoTask','jimeng-handed-off',{id,taskId,nameStatus:handoff.nameStatus})
        return
      }
      if (text(raw.upstream_task_id) && !params.jimengAcceptedSeenAt) {
        params.jimengAcceptedSeenAt = now()
        await update(id,{params:JSON.stringify(params)})
      }
      queued = raw.status === 'queued'
      await update(id,{stage:result.stage || 'polling',errorCode:null,errorMsg:null})
    } catch (error:any) {
      errors++
      if (['invalid_task_id','task_id_mismatch','invalid_response','receipt_mismatch'].includes(error.errorCode)) { await fail(id,error,'query_integrity_failed');return }
      if ([401,403].includes(error.httpStatus)) { await fail(id,error,'video_poll_access_failed');return }
      await update(id,{stage:'upstream_status_pending',errorCode:null,errorMsg:null})
      logTaskWarn('VideoTask','jimeng-query-pending',{id,taskId,error:safeTaskError(error)})
    }
    // A job still waiting in the service's own queue is checked less often (it is not with Jimeng yet).
    await pause(queued ? jimengTimings.queuedPollMs : Math.min(60_000,jimengTimings.pollMs*Math.max(1,errors)))
  }
}
