import type { ModelParameter, ProtocolRecord } from './protocols.js'
import { assertPublicParameterTree } from './protocols.js'

const forbidden = new Set([
  'model',
  'prompt',
  'messages',
  'instructions',
  'system',
  'systemInstruction',
  'tools',
  'tool_choice',
  'headers',
  'apiKey',
  'api_key',
  'base_url',
  'baseUrl',
  'body',
  'extra_body',
  'stream'
])
const builtin: Record<string, ModelParameter[]> = {
  text: [
    { key: 'temperature', label: '采样温度', type: 'number', min: 0, max: 2 },
    { key: 'top_p', label: 'Top P', type: 'number', min: 0, max: 1 },
    { key: 'max_tokens', label: '最大输出 Token', type: 'integer', min: 1, max: 1048576 },
    {
      key: 'reasoning_effort',
      label: '思考强度',
      type: 'string',
      description: '以所选上游型号实际支持的取值为准；可在模型能力 reasoning_efforts 中声明选项'
    }
  ],
  image: [
    { key: 'size', label: '图片尺寸', type: 'string', binding: 'size' },
    { key: 'quality', label: '图片质量', type: 'string', binding: 'quality' },
    { key: 'output_format', label: '输出格式', type: 'string', options: ['png', 'jpeg', 'webp'] },
    { key: 'output_compression', label: '输出压缩质量', type: 'integer', min: 0, max: 100 },
    { key: 'background', label: '背景', type: 'string', options: ['auto', 'opaque', 'transparent'] },
    { key: 'complexity', label: '复杂度', type: 'string' }
  ],
  video: [
    { key: 'duration', label: '视频时长（秒）', type: 'integer', min: 1, max: 3600 },
    { key: 'aspectRatio', label: '画幅比例', type: 'string' },
    { key: 'resolution', label: '分辨率', type: 'string' },
    { key: 'generateAudio', label: '生成声音', type: 'boolean' },
    { key: 'watermark', label: '水印', type: 'boolean' },
    { key: 'seed', label: '随机种子', type: 'integer' },
    { key: 'promptExtend', label: '提示词扩展', type: 'boolean' }
  ]
}
export function fixesNonStreaming(value: any): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    Object.entries(value).some(
      ([key, item]) => (key === 'stream' && item === false) || fixesNonStreaming(item)
    )
  )
}
export function usesIncrementalChatCodec(provider: any): boolean {
  return (
    provider?.agentResponse?.toolCallsPath === 'choices.0.message.tool_calls' &&
    JSON.stringify(provider?.agent?.body || {}).includes('request.extra.agent.chatCompletion') &&
    !fixesNonStreaming(provider?.agent?.body)
  )
}
export function providerStreamingMode(provider: any): 'incremental' | 'final_response' {
  return !fixesNonStreaming(provider?.agent?.body) &&
    (['chat-completion', 'openai-response', 'claude-api', 'gemini-generate-content'].includes(provider?.id) ||
      usesIncrementalChatCodec(provider))
    ? 'incremental'
    : 'final_response'
}
export function modelResponseFormat(callFormat: any, execution: any, parameter: any): any {
  if (execution?.jsonSchemaOutput)
    return { type: 'json', schema: execution.jsonSchemaOutput.schema, name: execution.jsonSchemaOutput.name }
  if (execution?.jsonObjectOutput) return { type: 'json' }
  if (callFormat?.type === 'json') return callFormat
  if (!parameter) return callFormat
  if (parameter.type === 'text') return { type: 'text' }
  if (parameter.type === 'json_object') return { type: 'json' }
  if (parameter.type === 'json_schema') {
    const definition = parameter.json_schema || parameter
    if (!definition.schema || typeof definition.schema !== 'object')
      throw new Error('response_format缺少JSON schema')
    return { type: 'json', schema: definition.schema, name: definition.name || 'result' }
  }
  throw new Error('所选response_format不受此文字协议支持')
}
export function protocolParameters(
  protocol: Pick<ProtocolRecord, 'parameters' | 'type' | 'id'>
): ModelParameter[] {
  const parameters = protocol.parameters ?? builtin[protocol.type] ?? []
  return ['text.gemini', 'text.anthropic'].includes(protocol.id)
    ? parameters.filter((parameter) => parameter.key !== 'reasoning_effort')
    : parameters
}
export function normalizeProviderParameters(provider: any): ModelParameter[] {
  const map = new Map<string, ModelParameter>()
  const references = new Set<string>()
  const inspect = (value: any) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{\{([^{}]+)\}\}/gu)) references.add(match[1])
    } else if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) {
        if (key === '$ref' && typeof item === 'string') references.add(item)
        inspect(item)
      }
  }
  inspect(provider.create)
  const consumed = (name: string) =>
    [...references].some(
      (reference) =>
        reference === `request.${name}` ||
        reference.startsWith(`request.${name}.`) ||
        reference === `request.extra.${name}` ||
        reference.startsWith(`request.extra.${name}.`) ||
        reference === `request.output.${name}` ||
        reference === `request.providerOptions.${provider.id}.${name}` ||
        reference.startsWith(`request.providerOptions.${provider.id}.${name}.`) ||
        reference === `request.providerOptions.${provider.id}` ||
        reference === 'request.extra'
    )
  const replaced = new Set(
    (provider.imageParameters || [])
      .map((parameter: any) => parameter.binding)
      .filter((binding: any) => typeof binding === 'string' && !binding.includes('.'))
  )
  for (const p of [...(provider.parameters || []), ...(provider.imageParameters || [])]) {
    if ((provider.parameters || []).includes(p) && replaced.has(p.name)) continue
    if (provider.create && !(provider.capabilities || []).includes('text') && !p.binding && !consumed(p.name))
      continue
    if (
      !p ||
      typeof p.name !== 'string' ||
      forbidden.has(p.name) ||
      forbidden.has(String(p.binding || '').split('.')[0]) ||
      (['images', 'videos', 'audios', 'providerOptions', 'imageCount'].includes(p.name) &&
        p.type === 'media[]')
    )
      continue
    if (p.enabled === false || p.mapping === 'unsupported' || p.type === 'message[]' || p.type === 'media[]')
      continue
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,159}$/u.test(p.name)) continue
    map.set(p.name, {
      ...p,
      key: p.name,
      label: p.label || p.name,
      options: p.values || p.options,
      type: p.type || 'string'
    })
  }
  return [...map.values()]
}
export function validateModelParameters(
  config: {
    parameters?: ModelParameter[]
    defaults?: Record<string, any>
    serviceType?: string
    protocolId?: string
  },
  raw?: unknown
): Record<string, any> {
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw)))
    throw new Error('模型参数必须为 JSON 对象')
  const input = (raw || {}) as Record<string, any>
  assertPublicParameterTree(input)
  const check = (value: any) => {
    if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) {
        if (forbidden.has(key)) throw new Error(`模型参数不能覆盖保留字段 ${key}`)
        if (key !== 'response_format') check(item)
      }
  }
  check(input)
  const definitions = config.parameters ?? builtin[config.serviceType || ''] ?? []
  const aliases: Record<string, string> = {
    aspect_ratio: 'aspectRatio',
    generate_audio: 'generateAudio',
    prompt_extend: 'promptExtend'
  }
  const known = new Map(definitions.map((p) => [p.key, p]))
  const merged: Record<string, any> = {}
  for (const [key, value] of Object.entries(config.defaults || {})) {
    const actual = known.has(key) ? key : aliases[key] || key
    if (known.has(actual)) merged[actual] = value
  }
  for (const [key, value] of Object.entries(input)) {
    if (forbidden.has(key) || !known.has(key)) throw new Error(`所选协议未声明参数 ${key}`)
    merged[key] = value
  }
  for (const [key, value] of Object.entries(merged)) {
    const p = known.get(key)!
    if (value === undefined || value === null) {
      delete merged[key]
      continue
    }
    if (
      (p.type === 'boolean' && typeof value !== 'boolean') ||
      (['integer', 'number'].includes(p.type) &&
        (typeof value !== 'number' ||
          !Number.isFinite(value) ||
          (p.type === 'integer' && !Number.isSafeInteger(value)))) ||
      (['string', 'select'].includes(p.type) && typeof value !== 'string')
    )
      throw new Error(`模型参数 ${key} 类型不正确`)
    if (
      Array.isArray(p.options) &&
      p.options.length &&
      !p.options.some(
        (option) => (typeof option === 'object' && option !== null ? (option as any).value : option) === value
      )
    )
      throw new Error(`模型参数 ${key} 不在允许选项中`)
    if (
      typeof value === 'number' &&
      ((p.min !== undefined && value < p.min) || (p.max !== undefined && value > p.max))
    )
      throw new Error(`模型参数 ${key} 超出范围`)
    if (typeof value === 'string' && value.length > 16000) throw new Error(`模型参数 ${key} 过长`)
  }
  if (JSON.stringify(merged).length > 64000) throw new Error('模型参数超过64KB')
  return merged
}
