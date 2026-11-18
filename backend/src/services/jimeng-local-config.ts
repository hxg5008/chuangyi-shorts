import { JIMENG_LOCAL_MODEL, jimengHeaders, normalizeJimengBaseUrl, jimengError } from './adapters/jimeng-local-video.js'
import { fetchProvider } from '../utils/http.js'
import type { AIConfig } from './adapters/types.js'

export function normalizeJimengModels(raw: unknown): string[] {
  const models = raw == null || raw === '' || Array.isArray(raw) && raw.length === 0 ? [JIMENG_LOCAL_MODEL] : typeof raw === 'string' ? [raw] : raw
  if (!Array.isArray(models) || models.some(model => model !== JIMENG_LOCAL_MODEL)) throw jimengError('即梦本地通道目前仅适配 jimeng-2.0-fast。')
  return [JIMENG_LOCAL_MODEL]
}

/** Read-only identity check; a mixed unified directory is accepted only for its explicit Jimeng entry. */
export function parseJimengCatalog(payload: any) {
  if (payload?.object !== 'list' || !Array.isArray(payload?.data)) throw jimengError('地址没有返回有效的模型目录。')
  const matches = payload.data.filter((model: any) => model?.id === JIMENG_LOCAL_MODEL)
  if (matches.length !== 1) throw jimengError('模型目录缺少唯一的 jimeng-2.0-fast。')
  const entry = matches[0]
  const standalone = payload.service === 'jimeng-local-service' && typeof payload.version === 'string' && entry.owned_by === 'local-adapter'
  const unified = entry.protocol === 'jimeng-local-video-v1' && entry.service === 'jimeng-local-service' && entry.modality === 'video' && entry.delivery_mode === 'local_manual'
  if (!standalone && !unified) throw jimengError('此型号未声明即梦本地视频协议，请检查服务版本和地址。')
  return [{ id: JIMENG_LOCAL_MODEL, name: '即梦 · 2.0 fast', supported: true, capability: 'video', protocol: 'jimeng-local-video-v1' }]
}

async function readJson(config: AIConfig, route: string) {
  const response = await fetchProvider(`${normalizeJimengBaseUrl(config.baseUrl)}/v1${route}`, {
    method: 'GET', headers: jimengHeaders(config), signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) { await response.body?.cancel(); throw jimengError(`即梦本地服务连接失败（HTTP ${response.status}），请检查 URL、Key 和服务状态。`) }
  const body = await response.text()
  if (Buffer.byteLength(body) > 1_000_000) throw jimengError('服务目录响应超过保护上限。')
  try { return JSON.parse(body) } catch { throw jimengError('服务没有返回 JSON，请检查 URL 和服务端口。') }
}

export async function readJimengModels(config: AIConfig) { return parseJimengCatalog(await readJson(config, '/models')) }
export async function probeJimengService(config: AIConfig) {
  const models = await readJimengModels(config)
  const state = await readJson(config, '/status')
  if (state?.service !== 'jimeng-local-service' || !Number.isInteger(state.active) || !Number.isInteger(state.queued)) throw jimengError('目录可读，但视频任务状态端点不是即梦本地协议。')
  return { ok: true, reachable: true, status: 200, available_models: models.map(model => model.id), selected_model_available: true,
    message: 'URL、Key 与即梦视频查询协议检查通过；账号及画布请在本地服务管理页检查。本次没有提交生成。', response_preview: '' }
}
