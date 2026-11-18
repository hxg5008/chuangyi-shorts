/**
 * 统一错误提示入口 — 把裸技术错误（Failed to fetch / API error 500: {...} /
 * 上游错误码 / ffmpeg 输出 / SDK 英文原文）映射为用户可读的友好文案。
 *
 * - mapError(err, { fallback? }): 返回友好文案（内联展示复用同一函数）
 * - toastError(err, { fallback?, duration? }): toast.error(mapError(...))，错误统一 5s
 * - 后端返回的短中文友好 message（如「镜头不存在」）原样透传
 * - 原始错误不展示，排障走 DevTools（useApi 已 console.error）
 */
import { toast } from 'vue-sonner'
import { i18n } from '~/composables/i18n'

const t = (key: string, params?: Record<string, unknown>) => i18n.global.t(key, params)

/** 内容审核特征（从 episode.vue 的 videoModerationHint 上移，全站复用） */
export const MODERATION_RE = /sensitive|moderation|真人|人脸|real[\s_-]?person|审核|内容.*(政策|违规|不合规|未通过|拒绝)|违反.*政策|content[\s_-]?policy|policy[\s_-]?(violation|rejected|refusal)|risk[\s_-]?control|violation|blocked|recusad[oa]|recusa|pol[ií]tica.{0,30}conte[uú]do|n[aã]o posso (ajudar|gerar|criar|atender)/i

const NETWORK_RE = /failed to fetch|network ?error|load failed|network request failed|fetch failed/i
const NONJSON_RE = /unexpected token|not valid json|failed to parse/i
const SERVER5XX_RE = /(^|\D)5\d{2}(\D|$)|internal server error|服务器内部错误/i
const AUTH_RE = /(^|\D)40[13](\D|$)|unauthorized|forbidden|invalid[\s_-]?api[\s_-]?key|authentication|鉴权/i
const RATELIMIT_RE = /(^|\D)429(\D|$)|rate[\s_-]?limit|too many requests|quota|额度不足|insufficient/i
const TIMEOUT_RE = /timeout|timed out|polling exceeded|超时/i
const GATEWAY_TIMEOUT_RE = /gateway[\s_-]*(?:time[\s_-]*out|timed[\s_-]*out)|网关.{0,6}超时/i
const HTTP504_RE = /\b(?:http(?:\/\d(?:\.\d)?)?|(?:provider[_ -]*)?(?:http[_ -]*)?status(?:[_ -]*code)?|api[_ -]*error)[\s:="'_-]*504\b|^[\s]*504(?:[\s]*$|[\s:—-]*gateway)|["'](?:status|statusCode|status_code|provider_http_status)["']\s*:\s*504\b/i
/** 技术特征：出现即判定不可直接透传给用户 */
const TECHY_RE = /[{}\[\]<>]|https?:\/\/|\b(error|errno|exception|code|stack|undefined|null)\b|[a-z]+_[a-z]+/i
const CJK_RE = /[一-鿿]/
const VIDEO_TASK_ERROR_KEYS: Record<string, string> = {
  reference_expired: 'errors.referenceExpired',
  reference_expiring: 'errors.referenceExpiring',
  reference_network: 'errors.referenceNetwork',
  reference_http: 'errors.referenceHttp',
  reference_not_image: 'errors.referenceNotImage',
  reference_missing_source: 'errors.referenceMissingSource',
  provider_task_failed: 'errors.videoProviderFailed',
  video_poll_access_failed: 'errors.videoPollAccessFailed',
  video_poll_not_found: 'errors.videoPollNotFound',
  video_poll_timeout: 'errors.videoPollTimeout',
}

function messageOf(err: unknown): string {
  if (err == null) return ''
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message || String(err)
  const anyErr = err as { message?: unknown; error_msg?: unknown; errorMsg?: unknown }
  return String(anyErr.message ?? anyErr.error_msg ?? anyErr.errorMsg ?? err)
}

/**
 * 错误 → 友好文案。分类按优先级短路：
 * 任务明确错误码／交付阶段 → 网关超时 → 网络 → 非JSON → 审核 → 鉴权 → 限频 → 5xx → 超时 → 兜底
 */
interface ErrorOptions {
  fallback?: string
  source?: 'task' | 'request'
  kind?: string
  errorCode?: string
  stage?: string
  hasResult?: boolean
  providerHttpStatus?: number
}

export function mapError(err: unknown, opts?: ErrorOptions): string {
  const msg = messageOf(err).trim()
  const status = opts?.providerHttpStatus ?? (err && typeof err === 'object' ? (err as { provider_http_status?: number }).provider_http_status : undefined)
  // A gateway's response is different from losing the browser's connection.
  // Do not infer HTTP 504 from a bare "Gateway Timeout" message.
  const gatewayKey = status === 504 || HTTP504_RE.test(msg) ? 'errors.upstreamGatewayTimeout'
    : GATEWAY_TIMEOUT_RE.test(msg) ? 'errors.modelGatewayTimeout' : null
  if (opts?.source === 'task') {
    // Only these exact video lifecycle codes establish preflight rejection,
    // confirmed provider failure, or an uncertain result after a blocked poll.
    const videoErrorKey = opts.kind !== 'image' && Object.prototype.hasOwnProperty.call(VIDEO_TASK_ERROR_KEYS, opts.errorCode || '') ? VIDEO_TASK_ERROR_KEYS[opts.errorCode || ''] : undefined
    if (videoErrorKey) return t(videoErrorKey)
    if (opts.errorCode === 'submission_unknown') return t('errors.submissionUnknown')
    if (/policy|moderation|content_rejected|generation_rejected/i.test(opts.errorCode || '')) return t('errors.moderation')
    if (opts.errorCode === 'generation_auth_failed') return t('errors.auth')
    if (opts.errorCode === 'generation_rate_limited') return t('errors.rateLimit')
    if (/^(image_delivery_failed|delivery_failed)$/.test(opts.errorCode || '')) return t(opts.kind === 'image' ? 'errors.imageDelivery' : opts.kind === 'video' ? 'errors.videoDelivery' : 'errors.resultDelivery')
    if (MODERATION_RE.test(msg)) return t('errors.moderation')
    const delivery =
      (opts.hasResult && (/downloading|saving|transferring/.test(opts.stage || '') || NETWORK_RE.test(msg) || TIMEOUT_RE.test(msg))) ||
      /下载.{0,12}(超时|失败)|download.{0,20}(timed? ?out|timeout|failed)/i.test(msg)
    if (delivery) return t(opts.kind === 'image' ? 'errors.imageDelivery' : opts.kind === 'video' ? 'errors.videoDelivery' : 'errors.resultDelivery')
    if (gatewayKey) return t(gatewayKey)
    if (opts.errorCode === 'generation_provider_error') return t('errors.taskProvider')
    if (opts.errorCode === 'generation_invalid_request') return t('errors.taskInvalidRequest')
    if (opts.errorCode === 'generation_invalid_response') return t('errors.taskInvalidResponse')
  }
  if (gatewayKey) return t(gatewayKey)
  if (!msg) return opts?.fallback ? t(opts.fallback) : t(opts?.source === 'task' ? 'errors.taskFailed' : 'errors.unknown')

  if (NETWORK_RE.test(msg)) return t(opts?.source === 'task' ? 'errors.taskNetwork' : 'errors.network')
  if (err instanceof SyntaxError || NONJSON_RE.test(msg)) return t('errors.server')
  if (MODERATION_RE.test(msg)) return t('errors.moderation')
  if (AUTH_RE.test(msg)) return t('errors.auth')
  if (RATELIMIT_RE.test(msg)) return t('errors.rateLimit')
  if (SERVER5XX_RE.test(msg)) return t('errors.unavailable')
  if (TIMEOUT_RE.test(msg)) return t(opts?.source === 'task' ? 'errors.taskTimeout' : 'errors.timeout')

  // 后端友好中文（短、含中文、无技术特征）直接透传
  if (msg.length <= 40 && CJK_RE.test(msg) && !TECHY_RE.test(msg)) return msg

  if (/^\d{3}$/.test(msg)) return t('errors.requestFailed', { status: msg })

  return opts?.fallback ? t(opts.fallback) : t(opts?.source === 'task' ? 'errors.taskFailed' : 'errors.unknown')
}

/** 统一错误 toast（默认 5s，比成功提示长） */
export function toastError(err: unknown, opts?: ErrorOptions & { duration?: number }): void {
  toast.error(mapError(err, opts), { duration: opts?.duration ?? 5000 })
}
