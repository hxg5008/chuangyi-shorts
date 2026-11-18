/** 888API exact model protocols. Multipart reference fields are numbered from one.
 * https://888api.xin/docs#jimeng-video-seedance-2.0-vip
 * The fast-vip multipart contract follows its documented VIP-family material rules;
 * keep its support separate from the unrelated JSON and wool model protocols.
 */
import type { AIConfig, ProviderRequest, VideoGenerationRecord, VideoGenResponse, VideoPollResponse, VideoProviderAdapter } from './types'
import { joinProviderUrl } from './url'
import { splitQuotedText } from '../../utils/quoted-text.js'

export const EIGHT_API_C5_MODEL = 'seedance2.0-933-c5-fast'
export const EIGHT_API_DEFAULT_MODEL = EIGHT_API_C5_MODEL
export const EIGHT_API_FAST_VIP_MODEL = 'jimeng-video-seedance-2.0-fast-vip'
export const EIGHT_API_VIDEO_MODELS = [
  EIGHT_API_DEFAULT_MODEL,
  EIGHT_API_FAST_VIP_MODEL,
  'jimeng-video-seedance-2.0-vip',
  'jimeng-video-seedance-2.0-mini',
] as const
const RATIOS = new Set(['1:1', '4:3', '3:4', '16:9', '9:16', '21:9'])
// Local upload guard. The docs list 30 MB for some Seedance models, but do not
// publish a fast-vip-specific per-image limit; do not describe this as its verified server limit.
export const EIGHT_API_MAX_IMAGE_BYTES = 30 * 1024 * 1024

/** Shared with task preflight so invalid settings cannot enqueue a billable request. */
export function validateEightApiVideoSettings(
  model: string,
  duration?: number | null,
  aspectRatio?: string | null,
  resolution?: string | null,
): { duration: number; aspectRatio: string; resolution: string } {
  if (!(EIGHT_API_VIDEO_MODELS as readonly string[]).includes(model)) {
    throw new Error('888API 当前模型尚未接入，请选择已接入的 Seedance 型号')
  }
  const seconds = duration == null ? (model === EIGHT_API_FAST_VIP_MODEL ? 15 : 5) : Number(duration)
  if (model === EIGHT_API_FAST_VIP_MODEL && seconds !== 15) {
    throw new Error('888API fast-vip 固定生成 15 秒，请将分镜时长改为 15 秒后再提交')
  }
  if (!Number.isInteger(seconds) || seconds < 4 || seconds > 15) {
    throw new Error('888API 当前通道时长须为 4–15 的整数秒')
  }
  const ratio = aspectRatio == null || aspectRatio === '' ? '16:9' : String(aspectRatio).trim()
  if (!RATIOS.has(ratio)) throw new Error('888API 不支持当前画幅，请选择 16:9、9:16、1:1、4:3、3:4 或 21:9')
  const size = resolution == null || resolution === '' ? '720p' : String(resolution).trim().toLowerCase()
  if (size !== '720p') throw new Error('888API 当前接入的视频通道仅支持 720p，请先修改视频分辨率')
  return { duration: seconds, aspectRatio: ratio, resolution: '720p' }
}

/** Reject unsupported controls instead of persisting or silently dropping them. */
export function validateEightApiVideoControls(record: {
  generateAudio?: unknown
  seed?: unknown
  promptExtend?: unknown
  watermark?: unknown
}): void {
  const fields = [
    ['generateAudio', 'generate_audio'],
    ['seed', 'seed'],
    ['promptExtend', 'prompt_extend'],
    ['watermark', 'watermark'],
  ] as const
  const unsupported = fields.filter(([key]) => record[key] != null).map(([, name]) => name)
  if (unsupported.length) {
    throw new Error(`888API 当前接入未提供 ${unsupported.join('、')} 可控参数，请移除这些设置；不沿用其他型号的参数，声轨由平台默认策略决定`)
  }
}

function references(raw: string | null | undefined, label: string): string[] {
  if (raw == null || raw === '') return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error(`888API ${label}必须为 JSON 字符串数组`) }
  if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error(`888API ${label}中的每项必须为非空字符串`)
  }
  // Do not deduplicate: the prompt's numbered references depend on the exact original order.
  return parsed.map(value => value.trim())
}

function publicImage(value: string, index: number, protocol: 'json' | 'multipart' = 'json'): string {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && !url.username && !url.password) return value
  } catch { /* Never include the rejected URL or local path in diagnostics. */ }
  throw new Error(protocol === 'json'
    ? `888API 第 ${index} 张参考图须为 HTTPS 公网地址，当前 JSON 通道不支持本地路径或 data-URI`
    : `888API 第 ${index} 张参考图须为 HTTPS 地址或完整图片 data-URI`)
}

function imagePart(value: string, index: number): { value: string | Blob; filename?: string } {
  if (value.startsWith('data:')) {
    const encodedLength = value.length - value.indexOf(',') - 1
    if (encodedLength > Math.ceil(EIGHT_API_MAX_IMAGE_BYTES / 3) * 4) {
      throw new Error(`888API 本地上传的第 ${index} 张参考图不能超过 30MiB，请先压缩图片`)
    }
    const data = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/i)
    if (!data) throw new Error(`888API 第 ${index} 张参考图不是有效的 PNG、JPEG 或 WebP data-URI`)
    const bytes = Buffer.from(data[2], 'base64')
    if (bytes.length > EIGHT_API_MAX_IMAGE_BYTES) throw new Error(`888API 本地上传的第 ${index} 张参考图不能超过 30MiB，请先压缩图片`)
    if (!bytes.length || bytes.toString('base64').replace(/=+$/, '') !== data[2].replace(/=+$/, '')) {
      throw new Error(`888API 第 ${index} 张参考图的 base64 内容无效`)
    }
    const mime = data[1].toLowerCase()
    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg'
    return { value: new Blob([new Uint8Array(bytes)], { type: mime }), filename: `reference-${index}.${ext}` }
  }
  return { value: publicImage(value, index, 'multipart') }
}

function referencePrompt(prompt: string, count: number, protocol: 'json' | 'multipart' = 'multipart'): string {
  return splitQuotedText(prompt).map(segment => segment.quoted ? segment.text : segment.text.replace(/@(?:图片|图|image_file_)(\d+)/g, (token, digits: string, offset: number, source: string) => {
    const index = Number(digits)
    if (!Number.isSafeInteger(index) || index < 1 || index > count) {
      throw new Error('888API 提示词中的参考图序号超出本次实际图片数量，请检查素材绑定')
    }
    const following = source[offset + token.length]
    // Keep the human-readable name, but never join it to the transport's field token.
    const separator = following && /[\p{L}\p{N}_]/u.test(following) ? ' ' : ''
    return `${protocol === 'json' ? '@图' : '@image_file_'}${index}${separator}`
  })).join('')
}

function taskPayload(result: any): any {
  if (result?.data && typeof result.data === 'object' && !Array.isArray(result.data)
    && (result.data.id != null || result.data.task_id != null || result.data.status != null || result.data.task_status != null)) return result.data
  return result || {}
}

function taskId(result: any): string | undefined {
  const id = result.id ?? result.task_id
  if (typeof id === 'string' && id.trim()) return id.trim()
  if (typeof id === 'number' && Number.isSafeInteger(id) && id >= 0) return String(id)
  return undefined
}

function state(result: any): string { return String(result.status ?? result.task_status ?? '').toLowerCase() }
const COMPLETE = new Set(['completed', 'succeeded', 'success', 'done', 'finished'])
const FAILED = new Set(['failed', 'failure', 'error', 'cancelled', 'canceled', 'rejected'])
const PENDING = new Set(['queued', 'pending', 'submitted', 'created', 'waiting'])

function videoUrl(result: any): string | undefined {
  const candidates = [result.url, result.video_url, result.result_url, result.content_url, result.download_url,
    result.result?.url, result.result?.video_url, result.task_result?.videos?.[0]?.url]
  for (const value of candidates) {
    if (typeof value !== 'string' || !value.trim()) continue
    try {
      const parsed = new URL(value)
      if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) return value
    } catch { /* Completed tasks without an absolute URL use the authenticated content endpoint. */ }
  }
  return undefined
}

function resultDuration(result: any): number | undefined {
  const duration = Number(result.duration ?? result.seconds ?? result.result?.duration)
  return Number.isFinite(duration) && duration > 0 ? duration : undefined
}

function safeFailureText(value: string): string {
  return value.replace(/https?:\/\/[^\s<>"'`]+/gi, '[redacted-url]')
    .replace(/\bBearer\s+[^\s,"'<>]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\b(api[_-]?key|authorization|access[_-]?token|secret|x-amz-signature|x-amz-credential|x-amz-security-token)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[redacted]')
    .replace(/[\r\n]+/g, ' ').trim().slice(0, 400)
}

/** Read only failure fields, never stringify an entire task/prompt/media response. */
export function extractEightApiVideoFailure(result: unknown): { message: string; code?: string } {
  const messages: string[] = []
  const codes: string[] = []
  const seen = new Set<object>()
  let visited = 0
  const addCode = (value: unknown) => {
    const code = typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : ''
    if (/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(code) && !/^(?:0|ok|success|sk-|bearer|https?:)/i.test(code)) codes.push(code)
  }
  const visit = (value: unknown, depth: number, allowText = true) => {
    if (depth > 6 || visited++ > 60 || value == null || typeof value === 'boolean' || typeof value === 'number') return
    if (typeof value === 'string') {
      const text = value.trim()
      if (!text) return
      if (/^[{[]/.test(text)) {
        if (text.length <= 20_000) { try { visit(JSON.parse(text), depth + 1); return } catch { /* Do not display an unparsed JSON dump. */ } }
        return
      }
      if (allowText && !/^\d+$/.test(text)) messages.push(safeFailureText(text))
      return
    }
    if (typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) { for (const item of value.slice(0, 12)) visit(item, depth + 1, allowText); return }
    const entry = value as Record<string, unknown>
    addCode(entry.code)
    addCode(entry.error_code)
    for (const field of ['message', 'failure_reason', 'fail_reason', 'reason']) visit(entry[field], depth + 1)
    for (const field of ['error', 'cause', 'details', 'detail', 'data', 'result', 'task_result']) visit(entry[field], depth + 1)
  }
  visit(result, 0, false)
  const generic = /^(?:failed|failure|error|task failed|video generation failed|generation failed|upstream error|upstream failed|888API\s*视频生成失败|视频生成失败|任务失败|上游错误|\[redacted-url\])(?:[.!。！])?$/i
  const code = codes[0]
  const message = messages.find(message => message && !generic.test(message))
    || (code ? `888API 视频生成失败（${code}）` : messages.find(Boolean) || '888API 视频生成失败')
  return { message, ...(code ? { code } : {}) }
}

export class EightApiVideoAdapter implements VideoProviderAdapter {
  provider = '888api'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    validateEightApiVideoControls(record)
    const model = record.model || config.model || EIGHT_API_DEFAULT_MODEL
    const settings = validateEightApiVideoSettings(model, record.duration, record.aspectRatio, record.resolution)
    const prompt = String(record.prompt || '').trim()
    if (!prompt) throw new Error('888API 视频生成需要非空提示词')
    if (record.referenceMode && !['reference', 'omni_reference'].includes(record.referenceMode)) {
      throw new Error('888API 当前仅支持 omni_reference 参考图片模式')
    }
    const images = references(record.referenceImageUrls, '参考图片')
    const videos = references(record.referenceVideoUrls, '参考视频')
    const audios = references(record.referenceAudioUrls, '参考音频')
    const jsonProtocol = model === EIGHT_API_C5_MODEL
    if (jsonProtocol && images.length > 9) throw new Error('888API C5 通道参考图片不能超过 9 张')
    if (images.length + videos.length + audios.length > 12) throw new Error('888API 参考素材总数不能超过 12 个')
    if (videos.length || audios.length) throw new Error('888API 当前接入仅支持参考图片，暂不支持参考视频或音频')
    if (record.firstFrameUrl || record.lastFrameUrl || record.imageUrl || record.referenceFileUrl || record.referenceLinkUrl) {
      throw new Error('888API 当前接入仅支持参考图片列表，暂不支持首尾帧、文件或链接模式')
    }
    if (jsonProtocol) {
      return { url: joinProviderUrl(config.baseUrl, '/v1', '/videos'), method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: { model, prompt: referencePrompt(prompt, images.length, 'json'), duration: settings.duration,
          ratio: settings.aspectRatio, resolution: settings.resolution,
          images: images.map((value, index) => publicImage(value, index + 1)) } }
    }
    const parts = images.map((value, index) => imagePart(value, index + 1))
    const form = new FormData()
    form.append('model', model)
    form.append('functionMode', images.length ? 'omni_reference' : 'first_last_frames')
    form.append('prompt', referencePrompt(prompt, images.length))
    form.append('duration', String(settings.duration))
    form.append('ratio', settings.aspectRatio)
    form.append('resolution', settings.resolution)
    parts.forEach((part, index) => {
      if (typeof part.value === 'string') form.append(`image_file_${index + 1}`, part.value)
      else form.append(`image_file_${index + 1}`, part.value, part.filename)
    })
    return { url: joinProviderUrl(config.baseUrl, '/v1', '/videos'), method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` }, body: form }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const task = taskPayload(result)
    const id = taskId(task)
    const url = videoUrl(task)
    if ((!state(task) || COMPLETE.has(state(task))) && url) {
      return { isAsync: false, taskId: id, videoUrl: url, duration: resultDuration(task) }
    }
    // Keep the ID even when a terminal result still needs the authenticated content endpoint.
    if (id) return { isAsync: true, taskId: id }
    throw new Error('No task_id or usable video URL in 888API response')
  }

  buildPollRequest(config: AIConfig, id: string): ProviderRequest {
    return { url: joinProviderUrl(config.baseUrl, '/v1', `/videos/${encodeURIComponent(id)}`), method: 'GET',
      headers: { Authorization: `Bearer ${config.apiKey}` }, body: undefined }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const task = taskPayload(result)
    const status = state(task)
    if (COMPLETE.has(status)) {
      const url = videoUrl(task)
      return { status: 'completed', ...(url ? { videoUrl: url } : { needsContentDownload: true }), duration: resultDuration(task) }
    }
    if (FAILED.has(status)) {
      const diagnostics = extractEightApiVideoFailure(result)
      return { status: 'failed', error: diagnostics.message, diagnostics }
    }
    return { status: PENDING.has(status) ? 'pending' : 'processing' }
  }

  extractVideoUrl(result: any): string | null { return videoUrl(taskPayload(result)) || null }
}
