import type { ServiceType } from '../ai.js'

export interface JsonOperation {
  method: 'GET' | 'POST'
  path: string
  body?: unknown
}
export interface JsonProtocol {
  type: 'image' | 'video'
  create: JsonOperation
  poll?: JsonOperation
  response: {
    task_id?: string
    status?: string
    result_url?: string
    base64?: string
    mime_type?: string
    error?: string
    progress?: string
    stage?: string
    succeeded?: string[]
    failed?: string[]
    queued?: string[]
  }
}
export interface ProtocolRecord {
  id: string
  name: string
  type: ServiceType | 'audio'
  provider: string
  custom: boolean
  version: number
  capabilities: Record<string, unknown>
  definition?: any
  provider_id?: string
  plugin_id?: string
  plugin_version?: string
  parameters?: ModelParameter[]
  auth_fields?: AuthField[]
  executable?: boolean
  unavailable_reason?: string
  source?: string
}

export interface ModelParameter {
  key: string
  name?: string
  type: string
  label: string
  description?: string
  options?: unknown[]
  min?: number
  max?: number
  default?: unknown
  required?: boolean
  binding?: string
  [key: string]: unknown
}
export interface AuthField {
  name: string
  type: string
  label: string
  required?: boolean
  secret: boolean
}

export const BUILTIN_PROTOCOLS: ProtocolRecord[] = [
  {
    id: 'text.openai-responses',
    name: 'OpenAI Responses',
    type: 'text',
    provider: 'openai-responses',
    custom: false,
    version: 1,
    capabilities: { tools: true, structured_output: true, stream: true }
  },
  {
    id: 'text.anthropic',
    name: 'Anthropic Messages',
    type: 'text',
    provider: 'anthropic',
    custom: false,
    version: 1,
    capabilities: { tools: true, structured_output: true, stream: true }
  },
  {
    id: 'text.openai-chat',
    name: 'OpenAI Chat Completions',
    type: 'text',
    provider: 'openai',
    custom: false,
    version: 1,
    capabilities: { tools: true, structured_output: true, stream: true }
  },
  {
    id: 'text.gemini',
    name: 'Gemini GenerateContent',
    type: 'text',
    provider: 'gemini',
    custom: false,
    version: 1,
    capabilities: { tools: true, structured_output: true, stream: true }
  },
  {
    id: 'text.volcengine-chat',
    name: '火山 Chat Completions',
    type: 'text',
    provider: 'volcengine',
    custom: false,
    version: 1,
    capabilities: { tools: true, structured_output: true, stream: true }
  },
  {
    id: 'image.openai',
    name: 'OpenAI Images／异步兼容',
    type: 'image',
    provider: 'openai',
    custom: false,
    version: 1,
    capabilities: { reference_images: true }
  },
  {
    id: 'image.gemini',
    name: 'Gemini 图片',
    type: 'image',
    provider: 'gemini',
    custom: false,
    version: 1,
    capabilities: { reference_images: true }
  },
  {
    id: 'image.volcengine',
    name: '火山图片',
    type: 'image',
    provider: 'volcengine',
    custom: false,
    version: 1,
    capabilities: { reference_images: true }
  },
  {
    id: 'image.gpt-local',
    name: '官号 GPT 本地图片中转',
    type: 'image',
    provider: 'openai',
    custom: false,
    version: 1,
    capabilities: { reference_images: true, max_images: 5, dispatch: 'official_gpt', max_concurrency: 4 }
  },
  {
    id: 'video.volcengine',
    name: '火山 Seedance 视频',
    type: 'video',
    provider: 'volcengine',
    custom: false,
    version: 1,
    capabilities: { reference_images: true, reference_video: true, reference_audio: true }
  },
  {
    id: 'video.minimax',
    name: 'MiniMax H3 视频',
    type: 'video',
    provider: 'minimax',
    custom: false,
    version: 1,
    capabilities: { reference_images: true, reference_video: true, reference_audio: true }
  },
  {
    id: 'video.aliyun',
    name: '阿里云 Wan 视频',
    type: 'video',
    provider: 'aliyun',
    custom: false,
    version: 1,
    capabilities: { reference_images: true, reference_video: true, reference_audio: true }
  },
  {
    id: 'video.888api',
    name: '888API 已适配视频',
    type: 'video',
    provider: '888api',
    custom: false,
    version: 1,
    capabilities: { reference_images: true }
  },
  {
    id: 'video.jimeng-local',
    name: '即梦本地视频',
    type: 'video',
    provider: 'jimeng_local',
    custom: false,
    version: 2,
    capabilities: {
      reference_images: true,
      max_images: 9,
      min_duration: 1,
      max_duration: 15,
      aspect_ratios: ['16:9', '9:16', '1:1'],
      delivery: 'local_manual'
    }
  }
]

const PATH = /^(?:[A-Za-z_][A-Za-z0-9_-]*|\d+)(?:\.(?:[A-Za-z_][A-Za-z0-9_-]*|\d+))*$/u
/** Definitions and defaults are public routing metadata; credentials belong only in the encrypted connection. */
export function assertPublicParameterTree(value: unknown, depth = 0): void {
  if (depth > 12) throw new Error('参数配置嵌套过深')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) {
    if (value.length > 500) throw new Error('参数数组过长')
    for (const item of value) assertPublicParameterTree(item, depth + 1)
    return
  }
  if (!value || typeof value !== 'object') throw new Error('参数配置必须为有效 JSON')
  for (const [key, item] of Object.entries(value)) {
    if (
      ['__proto__', 'prototype', 'constructor'].includes(key) ||
      /^(?:api[-_]?key|(?:access|refresh|auth|bearer)[-_]?token|authorization|cookie|password|secret|client[-_]?secret|credentials?|token)$/iu.test(
        key
      )
    )
      throw new Error('凭据只能保存在渠道的加密 Key 或请求头中，不能写入协议或默认参数')
    assertPublicParameterTree(item, depth + 1)
  }
}
export function validateJsonProtocol(raw: unknown): JsonProtocol {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('协议定义必须是 JSON 对象')
  const p = raw as Record<string, any>
  if (
    !['image', 'video'].includes(p.type) ||
    Object.keys(p).some((k) => !['type', 'create', 'poll', 'response'].includes(k))
  )
    throw new Error(
      '自定义 JSON 协议只接入图片／视频的创建、查询及响应映射；不支持的上传、脚本和鉴权需专用适配器'
    )
  const operation = (v: any, label: string) => {
    if (
      !v ||
      typeof v !== 'object' ||
      Array.isArray(v) ||
      !['GET', 'POST'].includes(v.method) ||
      typeof v.path !== 'string' ||
      !v.path.startsWith('/') ||
      v.path.startsWith('//') ||
      /[\\\r\n#?]/u.test(v.path) ||
      v.path.includes('..') ||
      /%(?:2e|2f|5c)/iu.test(v.path) ||
      v.path.length > 500 ||
      Object.keys(v).some((k) => !['method', 'path', 'body'].includes(k))
    )
      throw new Error(`${label}需要 GET/POST 和安全的服务内相对路径`)
    for (const match of v.path.matchAll(/\{\{([^{}]+)\}\}/gu))
      if (!['model', 'taskId'].includes(match[1]))
        throw new Error('请求路径只能引用 model 或 taskId，其他变量请放在 JSON 请求体中')
    if (v.method === 'GET' && v.body !== undefined) throw new Error('GET 操作不能带请求体')
    if (v.body !== undefined) assertPublicParameterTree(v.body)
  }
  operation(p.create, '创建操作')
  if (p.poll) operation(p.poll, '查询操作')
  if (!p.response || typeof p.response !== 'object' || Array.isArray(p.response))
    throw new Error('需要响应字段映射')
  for (const [k, v] of Object.entries(p.response)) {
    if (['succeeded', 'failed', 'queued'].includes(k)) {
      if (!Array.isArray(v) || v.length > 30 || v.some((x) => typeof x !== 'string' || !x || x.length > 80))
        throw new Error('状态映射必须是有限字符串数组')
    } else if (
      !['task_id', 'status', 'result_url', 'base64', 'mime_type', 'error', 'progress', 'stage'].includes(k) ||
      typeof v !== 'string' ||
      !PATH.test(v) ||
      v.split('.').some((x) => ['__proto__', 'prototype', 'constructor'].includes(x))
    )
      throw new Error('响应映射使用点分隔字段路径，不执行脚本或任意表达式')
  }
  if (!p.response.result_url && !p.response.base64) throw new Error('协议必须声明真实结果 URL 或 Base64 字段')
  if (p.poll && (!p.response.task_id || !p.response.status))
    throw new Error('异步协议必须声明任务号及状态字段')
  const encoded = JSON.stringify(p)
  if (encoded.length > 64000) throw new Error('协议定义超过64KB')
  const variables = encoded.matchAll(/\{\{([^{}]+)\}\}/gu)
  for (const match of variables)
    if (
      !/^(?:model|prompt|taskId|size|duration|aspectRatio|resolution|seed|generateAudio|referenceImages|referenceImageUrls|referenceVideoUrls|referenceAudioUrls|firstFrameUrl|lastFrameUrl|imageUrl|parameters(?:\.[A-Za-z_][A-Za-z0-9_]*)?)$/u.test(
        match[1]
      )
    )
      throw new Error(`协议含未登记变量：${match[1]}`)
  return structuredClone(p) as JsonProtocol
}

export function builtinProtocol(type: string, provider: string): string {
  return (
    BUILTIN_PROTOCOLS.find((p) => p.type === type && p.provider === provider && p.id !== 'image.gpt-local')
      ?.id || ''
  )
}
