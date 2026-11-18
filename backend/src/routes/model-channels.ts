import { Hono } from 'hono'
import { success, created, badRequest } from '../utils/response.js'
import { getModelChannelStore } from '../services/model-channels/store.js'
import { currentActor, requireAdmin, requireActor } from '../services/platform-security/index.js'
import { fetchProvider } from '../utils/http.js'
import { joinProviderUrl } from '../services/adapters/url.js'
import { redactRuntimeSecrets } from '../utils/secret-redaction.js'
import {
  initializeProviderCatalog,
  importProviderManifest
} from '../services/model-channels/plugin-catalog.js'
import { parsePluginPackage } from '../services/model-channels/plugin-package.js'

const protocolProjection = (protocol: any) =>
  protocol.definition?.engine === 'yingce-v2' ? { ...protocol, definition: undefined } : protocol

const admin = new Hono()
const publicModels = new Hono()
admin.use('*', async (c, next) => {
  try {
    requireAdmin()
  } catch (error: any) {
    const status = error.status === 401 ? 401 : 403
    return c.json({ code: status, message: error.message }, status)
  }
  await next()
})
const id = (value: string) => {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('编号不正确')
  return n
}
function safeError(error: unknown) {
  return error instanceof Error
    ? redactRuntimeSecrets(error.message)
        .replace(/\b(?:sk-|sess-)[A-Za-z0-9_-]+/gu, '[密钥已隐藏]')
        .replace(/Bearer\s+[^\s"',<>]+/giu, 'Bearer [已隐藏]')
        .slice(0, 600)
    : '渠道操作失败'
}
async function execute(c: any, operation: () => any | Promise<any>, isCreate = false) {
  try {
    const value = await operation()
    return isCreate ? created(c, value) : success(c, value)
  } catch (error) {
    return badRequest(c, safeError(error))
  }
}

admin.get('/channels', (c) =>
  execute(c, () => {
    const store = getModelChannelStore()
    return { channels: store.listChannels(), protocols: store.protocols().map(protocolProjection) }
  })
)
admin.post('/channels', (c) =>
  execute(c, async () => getModelChannelStore().saveChannel(await c.req.json()), true)
)
admin.get('/channels/:id', (c) =>
  execute(c, () => {
    const result = getModelChannelStore()
      .listChannels()
      .find((row) => row.id === id(c.req.param('id')))
    if (!result) throw Error('渠道不存在')
    return result
  })
)
admin.put('/channels/:id', (c) =>
  execute(c, async () => getModelChannelStore().saveChannel(await c.req.json(), id(c.req.param('id'))))
)
admin.delete('/channels/:id', (c) =>
  execute(c, () => {
    getModelChannelStore().deleteChannel(id(c.req.param('id')))
    return { deleted: true, history_retained: true }
  })
)
admin.get('/protocols', (c) =>
  execute(c, async () => {
    await initializeProviderCatalog()
    return getModelChannelStore().protocols().map(protocolProjection)
  })
)
admin.post('/protocols/import', (c) =>
  execute(
    c,
    async () => {
      const form = await c.req.formData(),
        file = form.get('file')
      if (!(file instanceof File)) throw new Error('请选择要导入的插件文件')
      const { manifest } = parsePluginPackage(Buffer.from(await file.arrayBuffer()), file.name)
      const result = await importProviderManifest(manifest, { preview: form.get('preview') === 'true' })
      return { ...result, providers: result.providers.map(protocolProjection) }
    },
    true
  )
)
admin.get('/protocols/:id/export', (c) =>
  execute(c, () => {
    const protocol = getModelChannelStore().protocol(c.req.param('id'))
    if (!protocol) throw new Error('协议不存在')
    return protocol.definition?.manifest || protocol.definition
  })
)
admin.post('/protocols', (c) =>
  execute(c, async () => getModelChannelStore().saveProtocol(await c.req.json()), true)
)
admin.get('/channels/:id/models', (c) =>
  execute(c, () => getModelChannelStore().bindings(id(c.req.param('id'))))
)
admin.post('/channels/:id/models', (c) =>
  execute(c, async () => getModelChannelStore().saveBinding(id(c.req.param('id')), await c.req.json()), true)
)
admin.put('/channels/:channelId/models/:modelId', (c) =>
  execute(c, async () =>
    getModelChannelStore().saveBinding(
      id(c.req.param('channelId')),
      await c.req.json(),
      id(c.req.param('modelId'))
    )
  )
)
admin.post('/channels/:channelId/models/:modelId/default', (c) =>
  execute(c, () => getModelChannelStore().setDefaultBinding(id(c.req.param('channelId')), id(c.req.param('modelId'))))
)
admin.delete('/channels/:channelId/models/:modelId', (c) =>
  execute(c, () => {
    getModelChannelStore().deleteBinding(id(c.req.param('channelId')), id(c.req.param('modelId')))
    return { deleted: true, history_retained: true }
  })
)

async function directory(channelId: number, format = 'openai') {
  const channel = getModelChannelStore().channelConnection(channelId)
  const gemini = format === 'gemini'
  const url = joinProviderUrl(channel.baseUrl, gemini ? '/v1beta' : '/v1', '/models')
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(gemini ? { 'x-goog-api-key': channel.apiKey } : { Authorization: `Bearer ${channel.apiKey}` }),
    ...channel.headers
  }
  const response = await fetchProvider(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(20000),
    redirect: 'error'
  })
  if (!response.ok) {
    await response.body?.cancel()
    return {
      ok: false,
      status: response.status,
      message: `模型目录请求返回 HTTP ${response.status}，请检查渠道地址和凭据`,
      models: [],
      inference_submitted: false
    }
  }
  const reader = response.body?.getReader()
  if (!reader) throw Error('服务未返回模型目录')
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const r = await reader.read()
      if (r.done) break
      size += r.value.length
      if (size > 2_000_000) throw Error('模型目录超过2MB保护上限')
      chunks.push(r.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  let payload: any
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Error('目录响应不是 JSON，请检查地址与协议格式')
  }
  const list = gemini ? payload.models : payload.data
  if (!Array.isArray(list)) throw Error('此服务没有返回所选格式的模型目录，不能据此自动判断请求协议')
  const seen = new Set<string>(),
    models: any[] = []
  for (const entry of list.slice(0, 2000)) {
    const value = entry?.id ?? entry?.name
    if (typeof value !== 'string') continue
    const model = value.replace(/^models\//u, '')
    if (
      !model ||
      model.length > 200 ||
      /[\x00-\x1f]/u.test(model) ||
      model === channel.apiKey ||
      redactRuntimeSecrets(model) !== model ||
      seen.has(model)
    )
      continue
    seen.add(model)
    models.push({
      id: model,
      name: model,
      ...(['text', 'image', 'video'].includes(entry.modality) ? { type: entry.modality } : {}),
      ...(Array.isArray(entry.supported_reasoning_efforts) &&
      entry.supported_reasoning_efforts.every(
        (value: unknown) => typeof value === 'string' && value.length < 80
      )
        ? {
            capabilities: { reasoning_efforts: entry.supported_reasoning_efforts },
            default_reasoning_effort: entry.default_reasoning_effort
          }
        : {}),
      ...(payload.service === 'chuangyi-local-hub' &&
      entry.protocol === 'jimeng-local-video-v1' &&
      model === 'jimeng-2.0-fast'
        ? { protocol_id: 'video.jimeng-local' }
        : {})
    })
  }
  return {
    ok: true,
    status: response.status,
    message: '目录与鉴权读取成功；未提交生成。请选择匹配的协议并另行验收实际生成。',
    models,
    fetched: true,
    inference_submitted: false,
    warning: '获取型号仅发现名称，不会自动确定全部请求协议或模型权限。'
  }
}
admin.post('/channels/:id/catalog', (c) =>
  execute(c, async () => {
    const body = await c.req.json().catch(() => ({}))
    return directory(id(c.req.param('id')), body.format)
  })
)
admin.post('/channels/:id/test', (c) =>
  execute(c, async () => {
    const body = await c.req.json().catch(() => ({}))
    return directory(id(c.req.param('id')), body.format)
  })
)

publicModels.get('/', (c) =>
  execute(c, () => {
    requireActor()
    return getModelChannelStore().publicModels(currentActor(), c.req.query('type'))
  })
)
export { admin as modelChannelAdminRoutes, publicModels as modelCatalogRoutes }
export default admin
