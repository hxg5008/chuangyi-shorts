import {
  buildCreate,
  buildPoll,
  parseCreate,
  parsePoll,
  executeResult,
  compileProvider
} from '../provider-runtime/index.js'
import type {
  GenerationRequest,
  ProviderDefinition,
  MediaReference,
  ProviderConnection
} from '../provider-runtime/types.js'
import type {
  AIConfig,
  ImageGenerationRecord,
  VideoGenerationRecord,
  ImageProviderAdapter,
  VideoProviderAdapter
} from './types.js'
import { validateModelParameters } from '../model-channels/parameters.js'
import { normalize888Fast720References } from './888-fast720-reference.js'

const list = (value: unknown): string[] => {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  return Array.isArray(parsed) ? parsed : []
}
const media = (url: string, index: number, role: string): MediaReference => ({
  id: `${role}-${index}`,
  order: index,
  role,
  kind: role.includes('audio') ? 'audio' : role.includes('video') ? 'video' : 'image',
  ...(url.startsWith('data:') ? { dataUrl: url } : { url })
})
function connection(config: AIConfig): ProviderConnection {
  return {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    authFields: config.authFields,
    headers: config.headers
  }
}
function hostBoolean(value: unknown, name: string): boolean {
  if (typeof value === 'boolean') return value
  if (value === 0 || value === 1) return value === 1
  throw new Error(`${name} 必须为布尔值或旧任务的0/1`)
}
export function engineGenerationRequest(config: AIConfig, record: Record<string, any>): GenerationRequest {
  if (record.providerRequestSnapshot) return record.providerRequestSnapshot
  const definition = config.protocolDefinition as ProviderDefinition,
    pid = definition.providerId!
  const parameters = validateModelParameters(config, record.modelParameters)
  const values: Record<string, any> = { ...parameters }
  for (const [key, value] of Object.entries(record))
    if (value !== undefined && value !== null)
      values[key] = ['generateAudio', 'watermark', 'promptExtend'].includes(key)
        ? hostBoolean(value, key)
        : value
  const explicit = (key: string) => record[key] !== undefined && record[key] !== null
  const sizeFields = new Set([
    'size',
    'aspectRatio',
    'aspect_ratio',
    'width',
    'height',
    'imageResolution',
    'resolution'
  ])
  const effective: Record<string, any> = { ...parameters }
  for (const parameter of config.parameters || []) {
    const root = parameter.binding?.split('.')[0] || parameter.key
    if (record.flowSizeLocked && (sizeFields.has(parameter.key) || sizeFields.has(root)))
      delete effective[parameter.key]
    else if (explicit(root) && root !== 'size') effective[parameter.key] = values[root]
  }
  const images = list(record.referenceImages ?? record.referenceImageUrls).map((url, index) =>
    media(url, index, 'reference_image')
  )
  if (record.imageUrl)
    images.unshift(media(record.imageUrl, 0, config.serviceType === 'image' ? 'edit_source' : 'first_frame'))
  if (record.firstFrameUrl) images.unshift(media(record.firstFrameUrl, 0, 'first_frame'))
  if (record.lastFrameUrl) images.push(media(record.lastFrameUrl, images.length, 'last_frame'))
  const options = { ...effective, ...(effective.providerOptions?.[pid] || {}) }
  delete options.providerOptions
  const aspectRatio = record.flowSizeLocked
    ? record.size
    : config.serviceType === 'image'
      ? (parameters.aspectRatio ??
        parameters.aspect_ratio ??
        parameters.size ??
        record.aspectRatio ??
        record.size)
      : (values.aspectRatio ?? values.aspect_ratio)
  const request: GenerationRequest = {
    capability: config.serviceType,
    model: record.model || config.model,
    prompt: record.prompt || '',
    images,
    videos: list(record.referenceVideoUrls).map((url, index) => media(url, index, 'reference_video')),
    audios: list(record.referenceAudioUrls).map((url, index) => media(url, index, 'reference_audio')),
    duration: values.duration,
    aspectRatio,
    resolution: values.resolution,
    quality: values.quality,
    imageCount: values.imageCount ?? values.count ?? 1,
    ...(values.generateAudio !== undefined ? { generateAudio: !!values.generateAudio } : {}),
    ...(values.watermark !== undefined ? { watermark: !!values.watermark } : {}),
    operation: values.operation,
    output: {
      ...effective.output,
      ...record.output,
      ...(values.width !== undefined ? { width: values.width } : {}),
      ...(values.height !== undefined ? { height: values.height } : {}),
      ...(values.fps !== undefined ? { fps: values.fps } : {}),
      ...(values.format !== undefined ? { format: values.format } : {})
    },
    providerOptions: { [pid]: options },
    imageParameters: effective,
    extra: { ...effective, ...(record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {}) }
  }
  for (const parameter of config.parameters || []) {
    const value = effective[parameter.key]
    if (value === undefined || !parameter.binding) continue
    const parts = parameter.binding.split('.')
    if (
      record.flowSizeLocked &&
      (sizeFields.has(parts[0]) || (parts[0] === 'output' && sizeFields.has(parts[1])))
    )
      continue
    if (parts.length === 1 && explicit(parts[0]) && parts[0] !== 'size') continue
    if (parts.some((part) => ['__proto__', 'prototype', 'constructor'].includes(part)))
      throw new Error('参数绑定路径不安全')
    let object: any = request
    for (const part of parts.slice(0, -1)) object = object[part] ??= {}
    object[parts.at(-1)!] = value
  }
  for (const key of [
    'duration',
    'aspectRatio',
    'resolution',
    'quality',
    'generateAudio',
    'watermark'
  ] as const)
    if (explicit(key)) {
      ;(request as any)[key] = values[key]
      request.output = { ...request.output, [key]: values[key] }
    }
  if (record.flowSizeLocked && record.size) {
    request.aspectRatio = record.size
    const pixels = /^(\d+)x(\d+)$/u.exec(record.size)
    request.output = {
      ...request.output,
      aspectRatio: record.size,
      ...(pixels ? { width: Number(pixels[1]), height: Number(pixels[2]) } : {})
    }
  }
  if (pid === '888-seedance-fast720-local') {
    request.prompt = normalize888Fast720References(request.prompt || '', request.images?.length || 0)
  }
  return request
}
const state = (value: string) =>
  value === 'succeeded'
    ? 'completed'
    : value === 'failed' || value === 'cancelled'
      ? 'failed'
      : value === 'pending'
        ? 'pending'
        : 'processing'
const mediaUrl = (item: any, baseUrl?: string) => {
  const value =
    item?.url ||
    item?.dataUrl ||
    (item?.bodyBase64
      ? `data:${item.mimeType || 'application/octet-stream'};base64,${item.bodyBase64}`
      : undefined)
  if (typeof value !== 'string' || !value) return undefined
  if (value.startsWith('data:')) return value
  const url = new URL(value, baseUrl?.replace(/\/+$/u, '') + '/')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('上游媒体地址不安全')
  return url.toString()
}
const defined = (value: string | undefined): value is string => typeof value === 'string' && !!value
class EngineBase {
  provider = 'yingce'
  constructor(readonly config: AIConfig) {}
  protected request(config: AIConfig, record: Record<string, any>) {
    return {
      providerDefinition: config.protocolDefinition as ProviderDefinition,
      connection: connection(config),
      request: engineGenerationRequest(config, record)
    }
  }
  async buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord | VideoGenerationRecord) {
    const request = await buildCreate(this.request(config, record))
    return { ...request, body: request.body }
  }
  async buildPollRequest(config: AIConfig, taskId: string) {
    const request = await buildPoll({
      ...this.request(config, config.generationRequest || { model: config.model }),
      taskId,
      model: config.generationRequest?.model || config.model
    })
    return { ...request, body: request.body }
  }
  protected async parsed(raw: any, poll = false) {
    const input = {
      providerDefinition: this.config.protocolDefinition as ProviderDefinition,
      raw,
      model: this.config.generationRequest?.model || this.config.model,
      request: engineGenerationRequest(
        this.config,
        this.config.generationRequest || { model: this.config.model }
      ),
      taskId: this.config.generationRequest?.taskId
    }
    let result = await (poll ? parsePoll(input) : parseCreate(input))
    const usable = [...(result.result?.images || []), ...(result.result?.videos || [])].some(
      (item) => !!mediaUrl(item, this.config.baseUrl)
    )
    if (
      result.status === 'succeeded' &&
      !usable &&
      result.taskId &&
      (await compileProvider(this.config.protocolDefinition as ProviderDefinition)).resultAvailable
    ) {
      const resolved: any = await executeResult({
        ...this.request(this.config, this.config.generationRequest || { model: this.config.model }),
        taskId: result.taskId
      })
      if (resolved?.result) result = { ...result, ...resolved }
      else if (resolved?.images || resolved?.videos) result = { ...result, result: resolved }
    }
    return result
  }
}
export class ProtocolEngineImageAdapter extends EngineBase implements ImageProviderAdapter {
  async parseGenerateResponse(raw: any) {
    const result = await this.parsed(raw)
    if (state(result.status) === 'failed')
      throw new Error(result.error || result.message || '上游图片生成失败')
    const imageUrls = (result.result?.images || [])
      .map((item) => mediaUrl(item, this.config.baseUrl))
      .filter(defined)
    return {
      isAsync: result.status !== 'succeeded',
      taskId: result.taskId,
      imageUrl: imageUrls[0],
      imageUrls
    }
  }
  async parsePollResponse(raw: any) {
    const result = await this.parsed(raw, true)
    const imageUrls = (result.result?.images || [])
      .map((item) => mediaUrl(item, this.config.baseUrl))
      .filter(defined)
    return {
      status: state(result.status) as any,
      cancelled: result.status === 'cancelled',
      stage: result.stage,
      imageUrl: imageUrls[0],
      imageUrls,
      error: result.error || result.message,
      progress: result.progress,
      queueAhead: result.queueAhead
    }
  }
  extractImageUrl() {
    return null
  }
  extractImageBase64() {
    return null
  }
}
export class ProtocolEngineVideoAdapter extends EngineBase implements VideoProviderAdapter {
  async parseGenerateResponse(raw: any) {
    const result = await this.parsed(raw)
    if (state(result.status) === 'failed')
      throw new Error(result.error || result.message || '上游视频生成失败')
    const videoUrls = (result.result?.videos || [])
      .map((item) => mediaUrl(item, this.config.baseUrl))
      .filter(defined)
    return {
      isAsync: result.status !== 'succeeded',
      taskId: result.taskId,
      videoUrl: videoUrls[0],
      videoUrls
    }
  }
  async parsePollResponse(raw: any) {
    const result = await this.parsed(raw, true)
    const videoUrls = (result.result?.videos || [])
      .map((item) => mediaUrl(item, this.config.baseUrl))
      .filter(defined)
    return {
      status: state(result.status) as any,
      cancelled: result.status === 'cancelled',
      stage: result.stage as any,
      videoUrl: videoUrls[0],
      videoUrls,
      error: result.error || result.message,
      progress: result.progress,
      queueAhead: result.queueAhead
    }
  }
  extractVideoUrl() {
    return null
  }
}
