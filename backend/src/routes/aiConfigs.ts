import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, notFound, created, badRequest, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { joinProviderUrl } from '../services/adapters/url.js'
import { EIGHT_API_BASE_URL, EIGHT_API_DEFAULT_MODEL, EIGHT_API_VIDEO_MODELS, isOfficialProvider, normalizeEightApiVideoModels, parseConfigTemperature } from '../services/ai.js'
import { redactUrl, logTaskError, logTaskProgress, logTaskSuccess } from '../utils/task-logger.js'
import { fetchProvider } from '../utils/http.js'
import { normalizeJimengModels, probeJimengService, readJimengModels } from '../services/jimeng-local-config.js'
import { jimengHeaders, normalizeJimengBaseUrl } from '../services/adapters/jimeng-local-video.js'
import { getModelChannelStore } from '../services/model-channels/store.js'
import { currentActor, requireAdmin } from '../services/platform-security/index.js'
import { registerRuntimeSecrets, redactRuntimeSecrets } from '../utils/secret-redaction.js'

const app = new Hono()

/** 归一化 temperature 入参：null=未设置；合法值 0~2；非法抛错 */
function normalizeTemperature(v: any): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 2) throw new Error('invalid temperature')
  return n
}

/** 把 settings JSON 中的 temperature 透出为顶层字段，便于前端直接读写 */
function withParsedFields(r: any) {
  const store=getModelChannelStore(),binding=store.bindingForConfig(r.id),actor=currentActor()
  const resolved=binding?store.resolve(r.id,actor):null
  const common={id:r.id,service_type:r.serviceType,provider:resolved?.provider||r.provider,name:binding?.name||r.name,
    model:binding?[binding.model]:r.model?JSON.parse(r.model):[],is_active:binding?store.allowed(binding,actor):!!r.isActive,
    is_default:!!r.isDefault,priority:r.priority,temperature:parseConfigTemperature(r.settings),
    api_key:'',has_api_key:!!resolved?.apiKey,binding_id:binding?.id,channel_id:binding?.channel_id,
    display_name:binding?.name||r.name,channel_name:resolved?.channelName,
    protocol_id:resolved?.protocolId,protocol_version:resolved?.protocolVersion,capabilities:resolved?.capabilities||{},defaults:resolved?.defaults||{},parameters:resolved?.parameters||[]}
  if(actor?.role==='user')return {...common,base_url:''}
  return {
    ...toSnakeCase(r),
    ...common,base_url:resolved?.baseUrl||r.baseUrl||'',
  }
}

function adminWrite(){if(currentActor())requireAdmin()}
function prepareStoredProbe(body:any){
  delete body._channelHeaders
  if((body.id||body.config_id)&&!body.api_key){
    const resolved=getModelChannelStore().resolve(Number(body.id||body.config_id),currentActor())
    if(!resolved)throw new Error('原模型配置不可用')
    if(body.service_type && body.service_type!==resolved.serviceType)throw new Error('测试类型与已保存模型类型不一致')
    if(body.provider && body.provider!==resolved.provider)throw new Error('测试协议与已保存模型不一致')
    if(body.base_url && body.base_url.replace(/\/+$/u,'')!==resolved.baseUrl.replace(/\/+$/u,''))throw new Error('修改连接地址后请先保存，避免把原渠道凭据发往其他地址')
    body.api_key=resolved.apiKey
    if(!body.base_url)body.base_url=resolved.baseUrl
    body._channelHeaders=resolved.headers
  }
  registerRuntimeSecrets([body.api_key,...Object.values(body._channelHeaders||{})])
}

function bearerHeaders(apiKey?: string, withJson = false) {
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  if (withJson) headers['Content-Type'] = 'application/json'
  return headers
}

function geminiHeaders(apiKey?: string, withJson = false) {
  const headers: Record<string, string> = {}
  if (apiKey) {
    headers['x-goog-api-key'] = apiKey
  }
  if (withJson) headers['Content-Type'] = 'application/json'
  return headers
}

/** A provider may echo credentials in an error response; never return them in probe diagnostics. */
function safeProbeText(value: unknown, apiKey?: string): string {
  let text = String(value ?? '')
  if (apiKey) {
    text = text.split(apiKey).join('[redacted]')
    text = text.split(encodeURIComponent(apiKey)).join('[redacted]')
  }
  return redactRuntimeSecrets(text.replace(/\bBearer\s+[^\s"'<>,]+/gi, 'Bearer [redacted]'))
}

function buildProbe(serviceType: string, provider: string, baseUrl: string, model?: string, apiKey?: string) {
  const p = provider.toLowerCase()
  const m = model || ''

  if (p === 'gemini') {
    return {
      method: 'GET',
      url: joinProviderUrl(baseUrl, '/v1beta', '/models'),
      headers: geminiHeaders(apiKey),
      body: undefined,
    }
  }

  if (p === 'openai' || p === '888api') {
    return {
      method: 'GET',
      url: joinProviderUrl(baseUrl, '/v1', '/models'),
      headers: bearerHeaders(apiKey),
      body: undefined,
    }
  }

  if (p === 'volcengine') {
    return {
      method: 'GET',
      url: joinProviderUrl(baseUrl, '/api/v3', '/models'),
      headers: bearerHeaders(apiKey),
      body: undefined,
    }
  }

  // A provider without a declared read-only directory cannot be verified by a connection check.
  // Never probe it by submitting even an empty generation request.
  return null
}

// GET /ai-configs?service_type=text
app.get('/', async (c) => {
  const store=getModelChannelStore();store.migrateLegacy()
  const serviceType = c.req.query('service_type')
  let rows = await db.select().from(schema.aiServiceConfigs)
  if (serviceType) rows = rows.filter(r => r.serviceType === serviceType)
  rows=rows.filter(row=>!store.bindingForConfig(row.id)?.deleted_at)
  if(currentActor()?.role==='user')rows=rows.filter(r=>{const binding=store.bindingForConfig(r.id);return !!binding&&store.allowed(binding,currentActor())})

  const parsed = rows.map(withParsedFields).sort((a, b) => Number(!!b.is_default) - Number(!!a.is_default)
    || (b.priority || 0) - (a.priority || 0) || a.id - b.id)
  return success(c, parsed)
})

// POST /ai-configs
app.post('/', async (c) => {
  adminWrite()
  const body = await c.req.json()
  const ts = now()

  // 验证必填字段
  if (!body.service_type || !body.provider) {
    return badRequest(c, '需要 service_type 与 provider')
  }
  if (!isOfficialProvider(body.service_type, body.provider)) {
    return badRequest(c, '不支持的 service_type/provider')
  }

  const isEightApi = body.provider.toLowerCase() === '888api'
  const isJimeng = body.provider.toLowerCase() === 'jimeng_local'
  let models = body.model || []
  if (isEightApi) {
    try { models = normalizeEightApiVideoModels(body.model) }
    catch (error: any) { return badRequest(c, error.message) }
  }
  if (isJimeng) {
    try { models = normalizeJimengModels(body.model); body.base_url = normalizeJimengBaseUrl(body.base_url); jimengHeaders({ provider:'jimeng_local', baseUrl:body.base_url, apiKey:body.api_key, model:models[0] }) }
    catch (error:any) { return badRequest(c,error.message) }
  }

  let temperature: number | null = null
  if ('temperature' in body) {
    try {
      temperature = normalizeTemperature(body.temperature)
    } catch {
      return badRequest(c, 'temperature 须为 0 到 2 之间的数字')
    }
  }

  const res = await db.insert(schema.aiServiceConfigs).values({
    serviceType: body.service_type,
    provider: isEightApi ? '888api' : isJimeng ? 'jimeng_local' : body.provider,
    name: body.name || `${body.provider}-${body.service_type}`,
    baseUrl: body.base_url || (isEightApi ? EIGHT_API_BASE_URL : ''),
    apiKey: body.api_key || '',
    model: JSON.stringify(models),
    priority: body.priority || 0,
    isActive: true,
    settings: temperature !== null ? JSON.stringify({ temperature }) : null,
    createdAt: ts,
    updatedAt: ts,
  })

  const [row] = await db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, getInsertId(res)))
  getModelChannelStore().syncLegacy(row.id)
  return created(c, withParsedFields(row))
})

// POST /ai-configs/test
app.post('/test', async (c) => {
  adminWrite()
  const body = await c.req.json()
  try{prepareStoredProbe(body)}catch(error:any){return badRequest(c,error.message)}
  if (!body.service_type || !body.provider || !body.base_url) {
    return badRequest(c, '需要 service_type、provider 与 base_url')
  }
  if (!isOfficialProvider(body.service_type, body.provider)) {
    return badRequest(c, '不支持的 service_type/provider')
  }

  if (body.provider.toLowerCase() === 'jimeng_local') {
    try {
      const model = normalizeJimengModels(body.model)[0]
      return success(c, await probeJimengService({ provider:'jimeng_local',baseUrl:body.base_url,apiKey:body.api_key,model }))
    } catch (error:any) { return success(c,{ok:false,reachable:false,message:safeProbeText(error.message,body.api_key),response_preview:''}) }
  }

  const isEightApi = body.provider.toLowerCase() === '888api'
  let models: string[] = []
  if (isEightApi) {
    try { models = normalizeEightApiVideoModels(body.model) }
    catch (error: any) { return badRequest(c, error.message) }
  }
  const model = isEightApi ? models[0] : (Array.isArray(body.model) ? body.model[0] : body.model)
  const probe = buildProbe(body.service_type, body.provider, body.base_url, model, body.api_key)
  if(!probe)return success(c,{ok:false,reachable:false,verified:false,inference_submitted:false,method:null,message:'此协议未声明无生成请求的检查入口，连接未验证。请保存后使用明确的模型测试发送操作验证。',response_preview:''})
  probe.headers={...probe.headers,...body._channelHeaders}
  const probeUrl = safeProbeText(redactUrl(probe.url), body.api_key)

  logTaskProgress('AIConfig', 'probe-start', {
    serviceType: body.service_type,
    provider: body.provider,
    method: probe.method,
    url: probeUrl,
  })

  try {
    const request = isEightApi ? fetchProvider : fetch
    const resp = await request(probe.url, {
      method: probe.method,
      headers: probe.headers,
      body: probe.body ? JSON.stringify(probe.body) : undefined,
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    })
    const text = await resp.text()
    const reachable = [200, 204, 400, 401, 403].includes(resp.status)
    const payload = {
      ok: resp.ok,
      reachable,
      inference_submitted: false,
      status: resp.status,
      status_text: safeProbeText(resp.statusText, body.api_key),
      method: probe.method,
      url: probeUrl,
      message: reachable
        ? (resp.ok ? '只读目录可访问；这不代表所选模型的生成权限、额度或效果已验证' : '端点已响应，请根据状态码判断认证或路径是否正确；未提交生成任务')
        : '端点未按预期响应，请检查 Base URL 和代理前缀',
      response_preview: safeProbeText(text, body.api_key).slice(0, 240),
    }
    if (isEightApi && resp.ok) {
      let response: any
      try { response = JSON.parse(text) } catch {}
      const validModelList = Array.isArray(response?.data)
        && response.data.every((entry: any) => typeof entry?.id === 'string')
      if (!validModelList) {
        payload.ok = false
        payload.message = '端点已响应，但未返回有效模型列表，请检查 Base URL'
        payload.response_preview = ''
      } else {
        const accessible = new Set<string>(response.data.map((entry: any) => entry.id))
        const selected = model || EIGHT_API_DEFAULT_MODEL
        const selectedAvailable = accessible.has(selected)
        const availableModels = EIGHT_API_VIDEO_MODELS.filter(value => accessible.has(value))
        Object.assign(payload, {
          selected_model: selected,
          selected_model_available: selectedAvailable,
          available_models: availableModels,
          unavailable_models: models.filter(value => !accessible.has(value)),
        })
        payload.ok = selectedAvailable
        payload.message = selectedAvailable
          ? `认证与模型列表正常，默认模型 ${selected} 可用`
          : `认证与模型列表正常，但当前令牌未开放默认模型 ${selected}`
        payload.response_preview = JSON.stringify({ models: availableModels })
      }
    }
    if (reachable) {
      logTaskSuccess('AIConfig', 'probe-done', {
        provider: body.provider,
        status: resp.status,
        url: probeUrl,
      })
    } else {
      logTaskError('AIConfig', 'probe-unexpected', {
        provider: body.provider,
        status: resp.status,
        url: probeUrl,
      })
    }
    return success(c, payload)
  } catch (error: any) {
    logTaskError('AIConfig', 'probe-failed', {
      provider: body.provider,
      url: probeUrl,
      error: safeProbeText(error.message, body.api_key),
    })
    return success(c, {
      ok: false,
      reachable: false,
      method: probe.method,
      url: probeUrl,
      message: safeProbeText(error.message, body.api_key) || '请求失败',
      response_preview: '',
    })
  }
})

// Read-only discovery for the explicitly supported local Jimeng contract.
app.post('/models', async c => {
  adminWrite()
  const body = await c.req.json()
  try{prepareStoredProbe(body)}catch(error:any){return badRequest(c,error.message)}
  if (body.service_type !== 'video' || body.provider !== 'jimeng_local') return badRequest(c,'此目录入口仅适用于即梦本地视频服务。')
  try {
    const models = await readJimengModels({provider:'jimeng_local',baseUrl:body.base_url,apiKey:body.api_key,model:''})
    return success(c,{models,source:'remote',fetched:true,warning:'这是本地已适配型号，不代表平台账号额度或付费生成验收。'})
  } catch (error:any) { return badRequest(c,safeProbeText(error.message,body.api_key)) }
})

// GET /ai-configs/:id
app.get('/:id', async (c) => {
  const store=getModelChannelStore();store.migrateLegacy()
  const id = Number(c.req.param('id'))
  const [row] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  if (!row) return notFound(c)
  if(store.bindingForConfig(id)?.deleted_at)return notFound(c)
  if(currentActor()?.role==='user'){const binding=store.bindingForConfig(id);if(!binding||!store.allowed(binding,currentActor()))return notFound(c)}
  return success(c, withParsedFields(row))
})

// PUT /ai-configs/:id
app.put('/:id', async (c) => {
  adminWrite()
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  getModelChannelStore().migrateLegacy()
  if(body.api_key==='')delete body.api_key
  const [existing] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  if (!existing) return notFound(c)
  if(getModelChannelStore().bindingForConfig(id)?.deleted_at)return notFound(c)

  const serviceType = 'service_type' in body ? body.service_type : existing.serviceType
  const provider = 'provider' in body ? body.provider : existing.provider
  if (!isOfficialProvider(serviceType, provider)) {
    return badRequest(c, '不支持的 service_type/provider')
  }

  const updates: Record<string, any> = { updatedAt: now() }

  if (provider.toLowerCase() === 'jimeng_local') {
    try {
      const modelInput = 'model' in body ? body.model : existing.provider === 'jimeng_local' ? JSON.parse(existing.model || '[]') : undefined
      updates.model = JSON.stringify(normalizeJimengModels(modelInput))
      updates.baseUrl = normalizeJimengBaseUrl('base_url' in body ? body.base_url : existing.baseUrl || '')
      updates.provider = 'jimeng_local'
      jimengHeaders({provider:'jimeng_local',baseUrl:updates.baseUrl,apiKey:'api_key' in body ? body.api_key : existing.apiKey,model:''})
    } catch (error:any) { return badRequest(c,error.message) }
  }

  if (provider.toLowerCase() === '888api') {
    let modelInput = body.model
    if (!('model' in body) && existing.provider?.toLowerCase() === '888api') {
      try { modelInput = existing.model ? JSON.parse(existing.model) : undefined } catch {}
    }
    try { updates.model = JSON.stringify(normalizeEightApiVideoModels(modelInput)) }
    catch (error: any) { return badRequest(c, error.message) }
    updates.baseUrl = body.base_url || (existing.provider?.toLowerCase() === '888api' ? existing.baseUrl : '') || EIGHT_API_BASE_URL
  }

  if ('service_type' in body) updates.serviceType = body.service_type
  if ('provider' in body) updates.provider = body.provider
  if ('name' in body) updates.name = body.name
  if ('base_url' in body && !['888api','jimeng_local'].includes(provider.toLowerCase())) updates.baseUrl = body.base_url
  if ('api_key' in body) updates.apiKey = body.api_key
  if ('model' in body && !['888api','jimeng_local'].includes(provider.toLowerCase())) updates.model = JSON.stringify(body.model)
  if ('priority' in body) updates.priority = body.priority
  if ('is_active' in body) updates.isActive = body.is_active
  if ('temperature' in body) {
    let temperature: number | null
    try {
      temperature = normalizeTemperature(body.temperature)
    } catch {
      return badRequest(c, 'temperature 须为 0 到 2 之间的数字')
    }
    // 与已有 settings 合并，清空的 temperature 从 JSON 中移除
    let settings: Record<string, any> = {}
    try { settings = existing.settings ? JSON.parse(existing.settings) : {} } catch { settings = {} }
    if (temperature === null) delete settings.temperature
    else settings.temperature = temperature
    updates.settings = Object.keys(settings).length ? JSON.stringify(settings) : null
  }

  await db.update(schema.aiServiceConfigs).set(updates).where(eq(schema.aiServiceConfigs.id, id))
  getModelChannelStore().syncLegacy(id,body)
  return success(c)
})

// DELETE /ai-configs/:id
app.delete('/:id', async (c) => {
  adminWrite()
  const id = Number(c.req.param('id'))
  const binding=getModelChannelStore().bindingForConfig(id)
  if(binding?.deleted_at)return notFound(c)
  if(binding)getModelChannelStore().deleteBinding(binding.channel_id,binding.id)
  else await db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  return success(c)
})

// GET /ai-providers
export const aiProviders = new Hono()
aiProviders.get('/', async (c) => {
  const rows = await db.select().from(schema.aiServiceProviders)
  const parsed = rows.map(r => ({
    ...toSnakeCase(r),
    preset_models: r.presetModels ? JSON.parse(r.presetModels) : [],
  }))
  return success(c, parsed)
})

export default app
