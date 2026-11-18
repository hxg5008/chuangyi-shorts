import { fetchProvider } from '../utils/http.js'
import { TaskQueue } from './task-queue.js'

export type EightApiReferenceCode = 'reference_expired' | 'reference_expiring' | 'reference_network' | 'reference_http'
  | 'reference_not_image' | 'reference_invalid' | 'reference_missing_source' | 'reference_lookup_failed' | 'reference_limit'
interface ReferenceFailure { code: EightApiReferenceCode; httpStatus?: number; host?: string; expiresAt?: string; causeCode?: string }

/** Safe to persist: no original signed URL or raw error cause is attached. */
export class EightApiReferenceError extends Error implements ReferenceFailure {
  readonly code: EightApiReferenceCode
  readonly index: number
  readonly httpStatus?: number
  readonly host?: string
  readonly expiresAt?: string
  readonly causeCode?: string
  readonly elapsedMs: number
  constructor(message: string, detail: ReferenceFailure & { index: number; elapsedMs: number }) {
    super(message)
    this.name = 'EightApiReferenceError'
    this.code = detail.code
    this.index = detail.index
    this.httpStatus = detail.httpStatus
    this.host = detail.host
    this.expiresAt = detail.expiresAt
    this.causeCode = detail.causeCode
    this.elapsedMs = detail.elapsedMs
  }
}
class ProbeFailure extends Error { constructor(readonly detail: ReferenceFailure) { super(detail.code) } }
export interface EightApiReferenceOptions {
  lookupSource: (localPath: string) => Promise<string | null> | string | null
  publicBaseUrl?: string
  fetch?: typeof fetch
  minValidityMs?: number
  timeoutMs?: number
  retryDelayMs?: number
}
const probes = new TaskQueue(2)
const clients = new WeakMap<typeof fetch, { success: Map<string, number>; inflight: Map<string, Promise<void>> }>()
const DEFAULT_MIN_VALIDITY_MS = 5 * 60_000
const SUCCESS_CACHE_MS = 60_000

function safeCauseCode(error: unknown): string | undefined {
  const seen = new Set<unknown>()
  let current = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object' && !seen.has(current); depth++) {
    seen.add(current)
    const value = current as { code?: unknown; name?: unknown; cause?: unknown }
    if (typeof value.code === 'string' && /^(?:UND_ERR_[A-Z_]+|E[A-Z0-9_]{2,40}|ABORT_ERR)$/.test(value.code)) return value.code
    if (value.name === 'TimeoutError') return 'TIMEOUT'
    if (value.name === 'AbortError') return 'ABORT_ERR'
    current = value.cause
  }
  return undefined
}

/** AWS v4 timestamps are UTC. Signature values never leave this function. */
function signatureExpiry(url: URL): number | undefined {
  const values = new Map([...url.searchParams].map(([name, value]) => [name.toLowerCase(), value]))
  const timestamp = values.get('x-amz-date')
  const seconds = values.get('x-amz-expires')
  if (timestamp === undefined && seconds === undefined) return undefined
  const match = timestamp?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/)
  if (!match || !seconds || !/^\d+$/.test(seconds)) throw new ProbeFailure({ code: 'reference_invalid', host: url.hostname })
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])))
  const valid = date.toISOString().replace(/[-:]/g, '').replace('.000', '') === timestamp
  const expires = date.getTime() + Number(seconds) * 1000
  if (!valid || !Number.isSafeInteger(expires) || !Number.isFinite(new Date(expires).getTime())) throw new ProbeFailure({ code: 'reference_invalid', host: url.hostname })
  return expires
}
function assertExpiry(url: URL, expires: number | undefined, minValidityMs: number) {
  if (expires === undefined) return
  const detail = { host: url.hostname, expiresAt: new Date(expires).toISOString() }
  if (expires <= Date.now()) throw new ProbeFailure({ code: 'reference_expired', ...detail })
  if (expires - Date.now() <= minValidityMs) throw new ProbeFailure({ code: 'reference_expiring', ...detail })
}
function humanMessage(index: number, detail: ReferenceFailure): string {
  const prefix = `第 ${index} 张参考图片`
  switch (detail.code) {
    case 'reference_expired': return `${prefix}的签名公网源地址已过期；本机图片仍可保留，请换成有效公网源地址后提交`
    case 'reference_expiring': return `${prefix}的签名公网源地址即将过期，剩余时间不足平台取图预算，请换成有效期更长的地址`
    case 'reference_network': return `${prefix}公网源地址无法连接或响应超时（GET预检已有限重试），尚未提交视频生成`
    case 'reference_http': return `${prefix}公网图片源返回 HTTP ${detail.httpStatus}，${detail.httpStatus === 403 ? '请求被拒绝，请检查权限或签名' : detail.httpStatus === 404 ? '图片不存在，请更新源地址' : detail.httpStatus === 429 ? '图片源请求限流，请稍后重试' : '图片源暂时异常或拒绝请求，请核对源地址'}`
    case 'reference_not_image': return `${prefix}公网源未返回图片内容类型，请提供有效图片直链`
    case 'reference_missing_source': return `${prefix}在本机没有可用公网源地址。C5需要公网图片，请配置 PUBLIC_BASE_URL 或使用有效 HTTPS 图片直链`
    case 'reference_lookup_failed': return `${prefix}本机图片源地址查询失败，请核对素材记录`
    case 'reference_limit': return '888API C5 最多支持 9 张参考图片'
    default: return `${prefix}需要有效的 HTTPS 公网图片直链，不能使用本地路径、私网地址或无效签名参数`
  }
}

async function probe(url: URL, fetcher: typeof fetch, options: EightApiReferenceOptions, expires: number | undefined, minValidityMs: number) {
  const state = clients.get(fetcher) || { success: new Map<string, number>(), inflight: new Map<string, Promise<void>>() }
  clients.set(fetcher, state)
  const key = url.toString()
  assertExpiry(url, expires, minValidityMs)
  if ((state.success.get(key) || 0) > Date.now()) return
  state.success.delete(key)
  const pending = state.inflight.get(key)
  if (pending) return pending
  const task = probes.run(async () => {
    const detail = { host: url.hostname, ...(expires !== undefined ? { expiresAt: new Date(expires).toISOString() } : {}) }
    for (let attempt = 0; attempt < 2; attempt++) {
      assertExpiry(url, expires, minValidityMs)
      let response: Response
      try {
        response = await fetcher(key, { method: 'GET', headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(options.timeoutMs ?? 30_000) })
      } catch (error) {
        if (attempt === 0) { await new Promise(resolve => setTimeout(resolve, options.retryDelayMs ?? 150)); continue }
        throw new ProbeFailure({ code: 'reference_network', ...detail, causeCode: safeCauseCode(error) })
      }
      const status = response.status
      const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
      let cancellationError: unknown
      try { await response.body?.cancel() }
      catch (error) { cancellationError = error }
      if (![200, 206].includes(status)) {
        if (attempt === 0 && (status === 429 || status >= 500 && status <= 599)) { await new Promise(resolve => setTimeout(resolve, options.retryDelayMs ?? 150)); continue }
        throw new ProbeFailure({ code: 'reference_http', ...detail, httpStatus: status })
      }
      if (!contentType || (!contentType.startsWith('image/') && contentType !== 'application/octet-stream')) throw new ProbeFailure({ code: 'reference_not_image', ...detail, httpStatus: status })
      if (cancellationError) {
        if (attempt === 0) { await new Promise(resolve => setTimeout(resolve, options.retryDelayMs ?? 150)); continue }
        throw new ProbeFailure({ code: 'reference_network', ...detail, httpStatus: status, causeCode: safeCauseCode(cancellationError) })
      }
      assertExpiry(url, expires, minValidityMs)
      state.success.set(key, Math.min(Date.now() + SUCCESS_CACHE_MS, expires !== undefined ? expires - minValidityMs : Infinity))
      if (state.success.size > 256) for (const cached of state.success.keys()) { state.success.delete(cached); if (state.success.size <= 128) break }
      return
    }
  }).finally(() => state.inflight.delete(key))
  state.inflight.set(key, task)
  return task
}

/** Preserve original positions/duplicates while merging only the safe GET preflight. */
export async function prepareEightApiPublicImages(refs: string[], options: EightApiReferenceOptions): Promise<string[]> {
  if (refs.length > 9) throw new EightApiReferenceError(humanMessage(1, { code: 'reference_limit' }), { code: 'reference_limit', index: 1, elapsedMs: 0 })
  const minValidityMs = options.minValidityMs != null && Number.isFinite(options.minValidityMs) ? Math.max(0, options.minValidityMs) : DEFAULT_MIN_VALIDITY_MS
  const fetcher = options.fetch || fetchProvider
  return Promise.all(refs.map(async (value, position) => {
    const index = position + 1
    const started = Date.now()
    let url: URL | undefined
    let expires: number | undefined
    try {
      const raw = String(value || '').trim()
      let candidate = raw
      if (/^\/?static\//.test(raw)) {
        const localPath = raw.replace(/^\//, '')
        if (localPath.split(/[\\/]/).some(part => part === '..')) throw new ProbeFailure({ code: 'reference_invalid' })
        const base = String(options.publicBaseUrl || '').trim().replace(/\/+$/, '')
        if (base) candidate = `${base}/${localPath}`
        else {
          try { candidate = await options.lookupSource(localPath) || '' }
          catch (error) { throw new ProbeFailure({ code: 'reference_lookup_failed', causeCode: safeCauseCode(error) }) }
        }
        if (!candidate) throw new ProbeFailure({ code: 'reference_missing_source' })
      }
      try { url = new URL(candidate) } catch { throw new ProbeFailure({ code: 'reference_invalid' }) }
      const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
      if (url.protocol !== 'https:' || url.username || url.password || /^(?:localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i.test(host)) throw new ProbeFailure({ code: 'reference_invalid', host: url.hostname })
      expires = signatureExpiry(url)
      await probe(url, fetcher, options, expires, minValidityMs)
      assertExpiry(url, expires, minValidityMs)
      return url.toString()
    } catch (error) {
      const detail: ReferenceFailure = error instanceof ProbeFailure ? error.detail : { code: 'reference_network', causeCode: safeCauseCode(error) }
      throw new EightApiReferenceError(humanMessage(index, detail), { ...detail, index,
        host: detail.host || url?.hostname, expiresAt: detail.expiresAt || (expires !== undefined ? new Date(expires).toISOString() : undefined), elapsedMs: Math.max(0, Date.now() - started) })
    }
  }))
}
