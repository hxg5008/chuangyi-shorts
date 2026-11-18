/**
 * AI 服务抽象层 — 从数据库配置中获取 provider 和 API key
 */
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'
import { joinProviderUrl } from './adapters/url.js'
import { EIGHT_API_DEFAULT_MODEL, EIGHT_API_VIDEO_MODELS } from './adapters/eight-api-video.js'
import { getModelChannelStore } from './model-channels/store.js'
import { currentActor, registerModelAccessGuard } from './platform-security/index.js'

export { EIGHT_API_DEFAULT_MODEL, EIGHT_API_VIDEO_MODELS }
export const EIGHT_API_BASE_URL = 'https://888api.xin'

/** 888API is a separate video provider; model names must match its supported task protocol. */
export function normalizeEightApiVideoModels(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0)) {
    return [EIGHT_API_DEFAULT_MODEL]
  }
  const values = typeof raw === 'string' ? [raw] : raw
  if (!Array.isArray(values) || values.some(model => typeof model !== 'string')) {
    throw new Error('888API model 必须是模型名称数组')
  }
  const models = [...new Set(values.map(model => model.trim()))]
  if (models.some(model => !(EIGHT_API_VIDEO_MODELS as readonly string[]).includes(model))) {
    throw new Error(`888API 视频仅支持：${EIGHT_API_VIDEO_MODELS.join(', ')}`)
  }
  return models
}

export type ServiceType = 'text' | 'image' | 'video'

export interface AIConfig {
  id?: number
  serviceType?: ServiceType
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  /** 采样温度，null 表示不设置（跟随服务商默认）。存于 ai_service_configs.settings JSON */
  temperature?: number | null
  bindingId?: number
  channelId?: number
  channelName?: string
  protocolId?: string
  protocolVersion?: number
  protocolDefinition?: any
  capabilities?: Record<string, any>
  defaults?: Record<string, any>
  headers?: Record<string, string>
  authFields?: Record<string,string>
  parameters?: import('./model-channels/protocols.js').ModelParameter[]
  generationRequest?:Record<string,any>
  executionRouteId?: string
  executionProjectRouteId?: number
}
export { validateModelParameters } from './model-channels/parameters.js'

/** 从 settings JSON 解析 temperature；非法值一律视为未设置 */
export function parseConfigTemperature(settingsRaw: string | null | undefined): number | null {
  if (!settingsRaw) return null
  try {
    const t = JSON.parse(settingsRaw)?.temperature
    return typeof t === 'number' && Number.isFinite(t) ? t : null
  } catch {
    return null
  }
}

export const officialProviders: Record<ServiceType, readonly string[]> = {
  text: ['openai', 'gemini', 'volcengine','openai-responses','anthropic'],
  image: ['openai', 'gemini', 'volcengine'],
  video: ['volcengine', 'minimax', 'aliyun', '888api', 'jimeng_local'],
}

export function isOfficialProvider(serviceType?: string | null, provider?: string | null): boolean {
  const providers = officialProviders[serviceType as ServiceType]
  return !!providers && providers.includes((provider || '').toLowerCase())
}

export function getTextProviderBaseUrl(config: AIConfig) {
  const provider = config.provider.toLowerCase()

  if (provider === 'openai'||provider==='openai-responses'||provider==='anthropic') {
    return joinProviderUrl(config.baseUrl, '/v1', '')
  }

  if (provider === 'gemini') {
    return joinProviderUrl(config.baseUrl, '/v1beta', '')
  }

  if (provider === 'volcengine') {
    return joinProviderUrl(config.baseUrl, '/api/v3', '')
  }

  return config.baseUrl
}

// Agent 多步循环会逐步重复解析同一配置，相同配置只打一次日志避免刷屏
const lastLoggedActiveConfigKey = new Map<string, string>()
const lastLoggedConfigByIdKey = new Map<number, string>()

export async function getActiveConfig(serviceType: ServiceType): Promise<AIConfig | null> {
  const store = getModelChannelStore()
  store.migrateLegacy()
  const rows = (await db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, serviceType))
  )
    .filter(r => r.isActive && (store.bindingForConfig(r.id)
      ? store.allowed(store.bindingForConfig(r.id)!, currentActor())
      : isOfficialProvider(serviceType, r.provider)))
    .sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault)
      || (b.priority || 0) - (a.priority || 0) || a.id - b.id) // 先授权过滤，再显式默认和原优先级

  const active = rows[0]
  if (!active) {
    logTaskWarn('AIConfig', 'active-config-missing', { serviceType })
    return null
  }
  const resolved = store.resolve(active.id, currentActor())
  if (resolved) return { ...resolved, temperature: parseConfigTemperature(active.settings) }

  const models = active.model ? JSON.parse(active.model) : []
  const logKey = `${active.id}:${models[0] || ''}`
  if (lastLoggedActiveConfigKey.get(serviceType) !== logKey) {
    lastLoggedActiveConfigKey.set(serviceType, logKey)
    logTaskProgress('AIConfig', 'active-config-selected', {
      serviceType,
      configId: active.id,
      provider: active.provider,
      model: models[0] || '',
      priority: active.priority,
    })
  }
  return {
    id: active.id,
    serviceType: active.serviceType as ServiceType,
    provider: active.provider || '',
    baseUrl: active.baseUrl || (active.provider?.toLowerCase() === '888api' ? EIGHT_API_BASE_URL : ''),
    apiKey: active.apiKey,
    model: models[0] || (active.provider?.toLowerCase() === '888api' ? EIGHT_API_DEFAULT_MODEL : ''),
    temperature: parseConfigTemperature(active.settings),
  }
}

export async function getTextConfig(): Promise<AIConfig> {
  const config = await getActiveConfig('text')
  if (!config) throw new Error('未配置文本模型，请先到「设置」页添加并启用 AI 服务')
  return config
}

/**
 * 取某服务类型当前启用且优先级最高的官方配置 ID（创建集时自动锁定用）
 */
export async function getActiveConfigId(serviceType: ServiceType): Promise<number | null> {
  return (await getActiveConfig(serviceType))?.id ?? null
}

export async function getConfigById(id: number): Promise<AIConfig | null> {
  const store = getModelChannelStore()
  store.migrateLegacy()
  const [row] = await db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, id))
  if (!row || !row.isActive) {
    logTaskWarn('AIConfig', 'config-by-id-missing', { configId: id })
    return null
  }
  const binding = store.bindingForConfig(id)
  if (binding) {
    const resolved = store.resolve(id, currentActor())
    if (!resolved) return null
    return { ...resolved, temperature: parseConfigTemperature(row.settings) }
  }
  if (!isOfficialProvider(row.serviceType as ServiceType, row.provider)) {
    logTaskWarn('AIConfig', 'config-by-id-unsupported-provider', {
      configId: id,
      serviceType: row.serviceType,
      provider: row.provider,
    })
    return null
  }
  const models = row.model ? JSON.parse(row.model) : []
  const logKey = `${row.provider}:${models[0] || ''}:${row.serviceType}`
  if (lastLoggedConfigByIdKey.get(id) !== logKey) {
    lastLoggedConfigByIdKey.set(id, logKey)
    logTaskProgress('AIConfig', 'config-by-id-selected', {
      configId: id,
      provider: row.provider,
      model: models[0] || '',
      serviceType: row.serviceType,
    })
  }
  return {
    id: row.id,
    serviceType: row.serviceType as ServiceType,
    provider: row.provider || '',
    baseUrl: row.baseUrl || (row.provider?.toLowerCase() === '888api' ? EIGHT_API_BASE_URL : ''),
    apiKey: row.apiKey,
    model: models[0] || (row.provider?.toLowerCase() === '888api' ? EIGHT_API_DEFAULT_MODEL : ''),
    temperature: parseConfigTemperature(row.settings),
  }
}

/** Stable model IDs are an authorization boundary; a caller cannot substitute an unregistered upstream SKU. */
export function assertConfiguredModel(config: AIConfig, requestedModel?: string | null) {
  if (config.bindingId && requestedModel && requestedModel !== config.model) {
    throw Object.assign(new Error('所选型号与渠道模型绑定不一致，请重新选择模型'), { status:403, statusCode:403 })
  }
  return requestedModel || config.model
}

/** A valid model ID may only be used for its published modality. */
export function assertConfigService(config: AIConfig, expected: ServiceType): void {
  if (config.serviceType !== expected) {
    throw Object.assign(new Error(`所选模型不支持${expected === 'text' ? '文本' : expected === 'image' ? '图片' : '视频'}任务，请重新选择模型`), { status:403, statusCode:403 })
  }
}

registerModelAccessGuard((id, actor) => {
  const store = getModelChannelStore()
  store.migrateLegacy()
  const binding = store.bindingForConfig(id)
  if (!binding || !store.allowed(binding, actor)) throw Object.assign(new Error('模型不存在、已停用或未获授权'), { status:403, statusCode:403 })
})
