import type {
  AIConfig,
  ImageGenerationRecord,
  VideoGenerationRecord,
  ProviderRequest,
  ImageProviderAdapter,
  ImageGenResponse,
  ImagePollResponse,
  VideoProviderAdapter,
  VideoGenResponse,
  VideoPollResponse
} from './types.js'
import { validateJsonProtocol, type JsonProtocol, type JsonOperation } from '../model-channels/protocols.js'

const object = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {}
function get(value: any, field?: string) {
  if (!field) return undefined
  let v = value
  for (const key of field.split('.')) {
    if (!v || typeof v !== 'object' || !Object.hasOwn(v, key)) return undefined
    v = v[key]
  }
  return v
}
function list(raw: unknown) {
  if (raw == null) return []
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
    throw new Error('参考素材必须是完整的字符串数组')
  return value
}
function template(value: any, variables: Record<string, any>): any {
  if (Array.isArray(value)) return value.map((v) => template(v, variables))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .map(([k, v]) => [k, template(v, variables)])
        .filter(([, v]) => v !== undefined)
    )
  if (typeof value !== 'string') return value
  const whole = /^\{\{([^{}]+)\}\}$/u.exec(value)
  if (whole) return get(variables, whole[1])
  return value.replace(/\{\{([^{}]+)\}\}/gu, (_match, key) => {
    const v = get(variables, key)
    if (v == null) return ''
    if (typeof v === 'object') throw new Error('数组和对象变量必须独占字段值')
    return String(v)
  })
}
function validateReferenceMapping(
  operation: JsonOperation,
  record: ImageGenerationRecord | VideoGenerationRecord
) {
  const source = JSON.stringify(operation.body || {})
  const mapped = (names: string[]) => names.some((name) => source.includes(`{{${name}}}`))
  const r = record as any
  const checks: [boolean, string[], string][] = [
    [
      list(r.referenceImages ?? r.referenceImageUrls).length > 0,
      ['referenceImages', 'referenceImageUrls'],
      '参考图片'
    ],
    [list(r.referenceVideoUrls).length > 0, ['referenceVideoUrls'], '参考视频'],
    [list(r.referenceAudioUrls).length > 0, ['referenceAudioUrls'], '参考音频'],
    [!!r.imageUrl, ['imageUrl'], '输入图片'],
    [!!r.firstFrameUrl, ['firstFrameUrl'], '首帧图片'],
    [!!r.lastFrameUrl, ['lastFrameUrl'], '尾帧图片']
  ]
  for (const [provided, names, label] of checks)
    if (provided && !mapped(names))
      throw new Error(`此 JSON 协议未映射${label}，请配置素材传参或移除该素材；未提交生成请求`)
  if (r.referenceFileUrl || r.referenceLinkUrl)
    throw new Error('此 JSON 协议未接入文件或链接素材上传，请使用已适配的专用协议')
}
function request(
  config: AIConfig,
  operation: JsonOperation,
  record: ImageGenerationRecord | VideoGenerationRecord,
  taskId?: string
): ProviderRequest {
  const r = record as any
  const refs = list(r.referenceImages ?? r.referenceImageUrls)
  const variables = {
    ...r,
    model: r.model || config.model,
    prompt: r.prompt || '',
    taskId,
    referenceImages: refs,
    referenceImageUrls: refs,
    referenceVideoUrls: list(r.referenceVideoUrls),
    referenceAudioUrls: list(r.referenceAudioUrls),
    parameters: config.defaults || {}
  }
  const pathVariables = {
    ...variables,
    model: encodeURIComponent(variables.model || ''),
    taskId: taskId === undefined ? undefined : encodeURIComponent(taskId)
  }
  const suffix = template(operation.path, pathVariables)
  const base = new URL(config.baseUrl),
    target = new URL(base.origin + base.pathname.replace(/\/+$/u, '') + suffix)
  const prefix = base.pathname.replace(/\/+$/u, '')
  if (
    target.origin !== base.origin ||
    target.username ||
    target.password ||
    !target.pathname.startsWith(prefix + '/')
  )
    throw new Error('协议请求不能离开原渠道地址')
  return {
    url: target.href,
    method: operation.method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      Accept: 'application/json',
      ...(operation.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      ...(config.headers || {})
    },
    body: operation.method === 'POST' ? template(operation.body || {}, variables) : undefined
  }
}
function result(raw: any, p: JsonProtocol) {
  const statusValue = get(raw, p.response.status),
    status = typeof statusValue === 'string' || typeof statusValue === 'number' ? String(statusValue) : ''
  const url = get(raw, p.response.result_url),
    base64 = get(raw, p.response.base64),
    id = get(raw, p.response.task_id),
    error = get(raw, p.response.error)
  const rawProgress = get(raw, p.response.progress),
    numericProgress = typeof rawProgress === 'string' ? Number(rawProgress.replace(/%$/u, '')) : rawProgress
  const stage = get(raw, p.response.stage)
  const success = p.response.succeeded || ['completed', 'succeeded', 'success', 'done'],
    failed = p.response.failed || ['failed', 'error', 'cancelled', 'canceled'],
    queued = p.response.queued || ['queued', 'pending', 'waiting']
  const state = failed.includes(status)
    ? 'failed'
    : success.includes(status) || (!status && (typeof url === 'string' || typeof base64 === 'string'))
      ? 'completed'
      : queued.includes(status)
        ? 'pending'
        : 'processing'
  if (
    id != null &&
    ((typeof id !== 'string' && typeof id !== 'number') ||
      String(id).length > 300 ||
      /[\r\n\x00]/u.test(String(id)))
  )
    throw new Error('上游任务编号不正确')
  if (url != null && (typeof url !== 'string' || !/^https?:\/\//u.test(url)))
    throw new Error('上游结果不是 HTTP(S) 图片／视频地址')
  return {
    status: state as ImagePollResponse['status'],
    taskId: id == null ? undefined : String(id),
    url: typeof url === 'string' ? url : undefined,
    base64: typeof base64 === 'string' ? base64 : undefined,
    mime: typeof get(raw, p.response.mime_type) === 'string' ? get(raw, p.response.mime_type) : 'image/png',
    error: typeof error === 'string' ? error.slice(0, 1000) : undefined,
    progress:
      typeof numericProgress === 'number' &&
      Number.isFinite(numericProgress) &&
      numericProgress >= 0 &&
      numericProgress <= 100
        ? numericProgress
        : undefined,
    stage: typeof stage === 'string' && stage.length <= 120 ? stage : undefined
  }
}
export class DeclarativeImageAdapter implements ImageProviderAdapter {
  provider = 'custom_json'
  private p: JsonProtocol
  constructor(definition: unknown) {
    this.p = validateJsonProtocol(definition)
    if (this.p.type !== 'image') throw new Error('不是图片协议')
  }
  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord) {
    validateReferenceMapping(this.p.create, record)
    return request(config, this.p.create, record)
  }
  parseGenerateResponse(raw: any): ImageGenResponse {
    const r = result(raw, this.p)
    if (r.status === 'failed') throw new Error(r.error || '上游图片任务失败')
    if (r.status === 'completed') return { isAsync: false, imageUrl: r.url }
    if (!this.p.poll || !r.taskId) throw new Error('异步协议没有返回可查询的原任务号')
    return { isAsync: true, taskId: r.taskId }
  }
  buildPollRequest(config: AIConfig, id: string) {
    if (!this.p.poll) throw new Error('此协议没有查询操作')
    return request(config, this.p.poll, { id: 0, model: config.model }, id)
  }
  parsePollResponse(raw: any): ImagePollResponse {
    const r = result(raw, this.p)
    return { status: r.status, imageUrl: r.url, error: r.error, progress: r.progress, stage: r.stage }
  }
  extractImageUrl(raw: any) {
    return result(raw, this.p).url || null
  }
  extractImageBase64(raw: any) {
    const r = result(raw, this.p)
    return r.base64 ? { data: r.base64, mimeType: r.mime } : null
  }
}
export class DeclarativeVideoAdapter implements VideoProviderAdapter {
  provider = 'custom_json'
  private p: JsonProtocol
  constructor(definition: unknown) {
    this.p = validateJsonProtocol(definition)
    if (this.p.type !== 'video') throw new Error('不是视频协议')
  }
  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord) {
    validateReferenceMapping(this.p.create, record)
    return request(config, this.p.create, record)
  }
  parseGenerateResponse(raw: any): VideoGenResponse {
    const r = result(raw, this.p)
    if (r.status === 'failed') throw new Error(r.error || '上游视频任务失败')
    if (r.status === 'completed') {
      if (!r.url) throw new Error('成功视频没有真实结果地址')
      return { isAsync: false, videoUrl: r.url }
    }
    if (!this.p.poll || !r.taskId) throw new Error('异步协议没有返回可查询的原任务号')
    return { isAsync: true, taskId: r.taskId }
  }
  buildPollRequest(config: AIConfig, id: string) {
    if (!this.p.poll) throw new Error('此协议没有查询操作')
    return request(config, this.p.poll, { id: 0, model: config.model }, id)
  }
  parsePollResponse(raw: any): VideoPollResponse {
    const r = result(raw, this.p)
    return { status: r.status, videoUrl: r.url, error: r.error, progress: r.progress, stage: r.stage as any }
  }
  extractVideoUrl(raw: any) {
    return result(raw, this.p).url || null
  }
}
