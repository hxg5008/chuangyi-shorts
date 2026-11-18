/**
 * 图片生成 Provider Adapter 接口
 */
export interface ImageProviderAdapter {
  /** 厂商标识 */
  provider: string

  /**
   * 构建图片生成请求
   * @param config AI 配置 { baseUrl, apiKey, model }
   * @param record 图片生成记录
   */
  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest | Promise<ProviderRequest>

  /**
   * 解析生成响应，判断是同步还是异步
   */
  parseGenerateResponse(result: any): ImageGenResponse | Promise<ImageGenResponse>

  /**
   * 构建轮询请求
   * @param config AI 配置
   * @param taskId 任务 ID
   */
  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest | Promise<ProviderRequest>

  /**
   * 解析轮询响应
   */
  parsePollResponse(result: any): ImagePollResponse | Promise<ImagePollResponse>

  /**
   * 从响应中提取图片 URL（用于直接下载）
   * 返回 null 表示图片数据是 base64 格式，需要用 extractImageBase64 处理
   */
  extractImageUrl(result: any): string | null

  /**
   * 从响应中提取 base64 图片数据
   * 仅用于 Gemini 等只返回 base64 的厂商
   */
  extractImageBase64(result: any): { data: string; mimeType: string } | null
}

/**
 * 视频生成 Provider Adapter 接口
 */
export interface VideoProviderAdapter {
  provider: string

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest | Promise<ProviderRequest>

  parseGenerateResponse(result: any): VideoGenResponse | Promise<VideoGenResponse>

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest | Promise<ProviderRequest>

  parsePollResponse(result: any): VideoPollResponse | Promise<VideoPollResponse>

  extractVideoUrl(result: any): string | null
}

// ============ 通用类型 ============

export interface ProviderRequest {
  url: string
  method: string
  headers: Record<string, string>
  /**
   * 普通请求为可 JSON 序列化的对象（generation.ts 统一 JSON.stringify）；
   * multipart 上传（如 OpenAI /v1/images/edits）直接返回 FormData，
   * 此时 headers 不要设置 Content-Type，边界由 fetch 自动生成。
   */
  body: any
  isBodySerialized?:boolean
  request?:unknown
  wireSummary?:unknown
}

export interface AIConfig {
  id?: number
  serviceType?: 'text' | 'image' | 'video'
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  bindingId?: number
  channelId?: number
  channelName?: string
  protocolId?: string
  protocolVersion?: number
  protocolDefinition?: unknown
  capabilities?: Record<string, any>
  defaults?: Record<string, any>
  headers?: Record<string, string>
  authFields?:Record<string,string>
  parameters?:import('../model-channels/protocols.js').ModelParameter[]
  generationRequest?:Record<string,any>
  executionRouteId?: string
  executionProjectRouteId?: number
}

export interface ImageGenerationRecord {
  id: number
  model?: string | null
  prompt?: string | null
  size?: string | null
  frameType?: string | null
  referenceImages?: string | null
  modelParameters?:Record<string,any>
  flowSizeLocked?:boolean
  // ... 其他字段
}

export interface VideoGenerationRecord {
  id: number
  model?: string | null
  prompt?: string | null
  referenceMode?: string | null
  imageUrl?: string | null
  firstFrameUrl?: string | null
  lastFrameUrl?: string | null
  referenceImageUrls?: string | null
  referenceImageNames?: string | null
  idempotencyKey?: string | null
  referenceVideoUrls?: string | null
  referenceAudioUrls?: string | null
  referenceFileUrl?: string | null
  referenceLinkUrl?: string | null
  generateAudio?: number | boolean | null
  duration?: number | null
  aspectRatio?: string | null
  resolution?: string | null
  seed?: number | null
  promptExtend?: number | boolean | null
  watermark?: number | boolean | null
  modelParameters?:Record<string,any>
  // ... 其他字段
}

export interface ImageGenResponse {
  isAsync: boolean
  taskId?: string
  /** 同步模式下直接返回的图片 URL */
  imageUrl?: string
  imageUrls?:string[]
}

export interface ImagePollResponse {
  status: 'pending' | 'processing' | 'completed' | 'failed'
  imageUrl?: string
  imageUrls?:string[]
  progress?:number
  stage?:string
  cancelled?:boolean
  error?: string
}

export interface VideoGenResponse {
  isAsync: boolean
  taskId?: string
  videoUrl?: string
  videoUrls?:string[]
  duration?: number
}

export interface VideoPollResponse {
  status: 'pending' | 'processing' | 'completed' | 'failed'
  stage?: 'transferring' | 'upstream_status_pending' | 'queued' | 'preparing' | 'uploading_references' | 'submitting' | 'submitted_to_jimeng' | 'submission_unknown' | 'generating' | 'polling' | 'downloading' | 'completed' | 'ready_in_local_service' | 'failed' | 'waiting_account' | 'waiting_canvas' | 'result_unavailable' | 'waiting_capacity' | 'waiting_owner' | 'waiting_paused' | 'waiting_route' | 'waiting_review' | 'dispatching'
  manualDelivery?: boolean
  upstreamStatus?: string
  errorCode?: string
  videoUrl?: string
  videoUrls?:string[]
  progress?:number
  cancelled?:boolean
  /** Completed video must be downloaded from the original provider's authenticated content endpoint. */
  needsContentDownload?: boolean
  duration?: number
  error?: string
  diagnostics?: { code?: string; message: string }
}
