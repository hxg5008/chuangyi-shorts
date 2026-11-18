import { platformHeaders, platformSession, expirePlatformSession } from '~/utils/platform-session'

const BASE = '/api/v1'

async function req<T = any>(method: string, path: string, body?: any): Promise<T> {
  const revision = platformSession.revision
  const opts: RequestInit = { method, credentials: 'same-origin', headers: platformHeaders(method, true) }
  if (body) opts.body = JSON.stringify(body)

  const start = performance.now()
  console.debug(`[API] ${method} ${path}`)

  try {
    const resp = await fetch(`${BASE}${path}`, opts)
    const json = await resp.json()
    if (revision !== platformSession.revision) throw new Error('登录身份已变化，已忽略旧请求的结果。')
    const ms = Math.round(performance.now() - start)

    if (!resp.ok || (json.code && json.code >= 400)) {
      if (resp.status === 401 || json.code === 401) expirePlatformSession()
      console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', json.message || '')
      throw new Error(json.message || `${resp.status}`)
    }

    console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#66bb6a', 'color:#66bb6a;font-weight:bold', 'color:#888')
    return Object.prototype.hasOwnProperty.call(json, 'data') ? json.data : json
  } catch (err: any) {
    if (!err.message?.match(/^\d{3}$/)) {
      const ms = Math.round(performance.now() - start)
      console.log(`%c[API] %c${method} ${path} %cERROR %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', err.message)
    }
    throw err
  }
}

export const api = {
  get: <T = any>(p: string) => req<T>('GET', p),
  post: <T = any>(p: string, b?: any) => req<T>('POST', p, b),
  put: <T = any>(p: string, b?: any) => req<T>('PUT', p, b),
  del: <T = any>(p: string) => req<T>('DELETE', p),
}

export const dramaAPI = {
  list: () => api.get<{ items: any[] }>('/dramas'),
  get: (id: number) => api.get(`/dramas/${id}`),
  create: (data: any) => api.post('/dramas', data),
  update: (id: number, data: any) => api.put(`/dramas/${id}`, data),
  del: (id: number) => api.del(`/dramas/${id}`),
}

export const episodeAPI = {
  create: (data: any) => api.post('/episodes', data),
  update: (id: number, data: any) => api.put(`/episodes/${id}`, data),
  del: (id: number) => api.del(`/episodes/${id}`),
  characters: (id: number) => api.get(`/episodes/${id}/characters`),
  scenes: (id: number) => api.get(`/episodes/${id}/scenes`),
  props: (id: number) => api.get(`/episodes/${id}/props`),
  storyboards: (id: number) => api.get(`/episodes/${id}/storyboards`),
  pipelineStatus: (id: number) => api.get(`/episodes/${id}/pipeline-status`),
  extract: (id: number, target: string, model?: string, configId?: number, modelParameters?: Record<string, unknown>) => api.post(`/episodes/${id}/extract`, { target, model: model || undefined, config_id: configId || undefined, model_parameters: modelParameters }),
  extractStatus: (id: number) => api.get(`/episodes/${id}/extract-status`),
  generateVideoPrompts: (id: number, model?: string, configId?: number, storyboardIds?: number[], modelParameters?: Record<string, unknown>) => api.post(`/episodes/${id}/generate-video-prompts`, { model: model || undefined, config_id: configId || undefined, storyboard_ids: storyboardIds?.length ? storyboardIds : undefined, model_parameters: modelParameters }),
  videoPromptsStatus: (id: number) => api.get(`/episodes/${id}/video-prompts-status`),
  /** Round 5: 回传本集视频 (only queries the Jimeng service; never a new generation). */
  jimengReturn: (id: number) => api.post<{ results: Array<{ id: number; outcome: string; message: string }>; total: number; returning: number; not_ready: number; failed: number; errors: number }>(`/episodes/${id}/jimeng-return`, {}),
}

export const storyboardAPI = {
  create: (data: any) => api.post('/storyboards', data),
  update: (id: number, data: any) => api.put(`/storyboards/${id}`, data),
  del: (id: number) => api.del(`/storyboards/${id}`),
}

export type AssetImageKind = 'character' | 'scene' | 'prop'
export interface AssetRedrawOptions { manual: true; prompt: string; reference_images: string[] }
export interface AssetImageVersion {
  id: number; image_url: string; created_at: string | null; width: number | null; height: number | null;
  is_current: boolean; source: 'generated'|'uploaded'|'legacy'; missing: boolean; changed: boolean; task_id: number|null; has_prompt: boolean;
}
export interface AssetImageHistory {
  asset_type: AssetImageKind; asset_id: number; current_url: string|null; versions: AssetImageVersion[];
  has_more: boolean; next_before_id: number|null; delete_file: false;
}
export const assetImageAPI = {
  list: (type: AssetImageKind, id: number, limit = 200, beforeId?: number) => api.get<AssetImageHistory>(`/asset-images/${type}/${id}?limit=${limit}${beforeId ? '&before_id=' + beforeId : ''}`),
  detail: (type: AssetImageKind, id: number, versionId: number) => api.get(`/asset-images/${type}/${id}/${versionId}`),
  adopt: (type: AssetImageKind, id: number, versionId: number) => api.post<AssetImageHistory>(`/asset-images/${type}/${id}/${versionId}/adopt`, {}),
  remove: (type: AssetImageKind, id: number, versionId: number) => api.del<AssetImageHistory>(`/asset-images/${type}/${id}/${versionId}`),
}

export const characterAPI = {
  uploadVoice: (id: number, file: File) => uploadReq<CharacterVoice>(`/characters/${id}/voice`, file),
  removeVoice: (id: number) => api.del<CharacterVoice>(`/characters/${id}/voice`),
  create: (data: any) => api.post('/characters', data),
  update: (id: number, data: any) => api.put(`/characters/${id}`, data),
  del: (id: number) => api.del(`/characters/${id}`),
  generatePrompt: (id: number, episodeId: number, force = false, textModel?: string, textConfigId?: number, textModelParameters?: Record<string, unknown>) => api.post(`/characters/${id}/generate-prompt`, { episode_id: episodeId, force, text_model: textModel || undefined, text_config_id: textConfigId || undefined, text_model_parameters: textModelParameters }),
  generateImage: (id: number, episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number, modelParameters?: Record<string, unknown>, textModelParameters?: Record<string, unknown>, asyncPrepare = true, redrawOptions?: AssetRedrawOptions) => api.post(`/characters/${id}/generate-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined, model_parameters: modelParameters, text_model: textModel || undefined, text_config_id: textConfigId || undefined, text_model_parameters: textModelParameters, async_prepare: asyncPrepare || undefined, ...(redrawOptions ? { manual: redrawOptions.manual, prompt: redrawOptions.prompt, reference_images: redrawOptions.reference_images } : {}) }),
  batchImages: (ids: number[], episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number, modelParameters?: Record<string, unknown>, textModelParameters?: Record<string, unknown>) => api.post('/characters/batch-generate-images', { character_ids: ids, episode_id: episodeId, model: model || undefined, config_id: configId || undefined, model_parameters: modelParameters, text_model: textModel || undefined, text_config_id: textConfigId || undefined, text_model_parameters: textModelParameters }),
  fillVoiceCards: (episodeId: number, textModel?: string, textConfigId?: number, textModelParameters?: Record<string, unknown>) => api.post<{ written: number }>('/characters/voice-cards/fill', { episode_id: episodeId, text_model: textModel || undefined, text_config_id: textConfigId || undefined, text_model_parameters: textModelParameters }),
}

export interface CharacterVoice {
  voice_audio_url: string | null
  voice_audio_name: string | null
}

export const sceneAPI = {
  create: (data: any) => api.post('/scenes', data),
  update: (id: number, data: any) => api.put(`/scenes/${id}`, data),
  del: (id: number) => api.del(`/scenes/${id}`),
  generatePrompt: (id: number, episodeId: number, force = false, textModel?: string, textConfigId?: number, textModelParameters?: Record<string, unknown>) => api.post(`/scenes/${id}/generate-prompt`, { episode_id: episodeId, force, text_model: textModel || undefined, text_config_id: textConfigId || undefined, text_model_parameters: textModelParameters }),
  generateImage: (id: number, episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number, modelParameters?: Record<string, unknown>, textModelParameters?: Record<string, unknown>, asyncPrepare = true, redrawOptions?: AssetRedrawOptions) => api.post(`/scenes/${id}/generate-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined, model_parameters: modelParameters, text_model: textModel || undefined, text_config_id: textConfigId || undefined, text_model_parameters: textModelParameters, async_prepare: asyncPrepare || undefined, ...(redrawOptions ? { manual: redrawOptions.manual, prompt: redrawOptions.prompt, reference_images: redrawOptions.reference_images } : {}) }),
}

export const propAPI = {
  create: (data: any) => api.post('/props', data),
  update: (id: number, data: any) => api.put(`/props/${id}`, data),
  del: (id: number) => api.del(`/props/${id}`),
  generatePrompt: (id: number, episodeId: number, force = false, textModel?: string, textConfigId?: number, textModelParameters?: Record<string, unknown>) => api.post(`/props/${id}/generate-prompt`, { episode_id: episodeId, force, text_model: textModel || undefined, text_config_id: textConfigId || undefined, text_model_parameters: textModelParameters }),
  generateImage: (id: number, episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number, modelParameters?: Record<string, unknown>, textModelParameters?: Record<string, unknown>, asyncPrepare = true, redrawOptions?: AssetRedrawOptions) => api.post(`/props/${id}/generate-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined, model_parameters: modelParameters, text_model: textModel || undefined, text_config_id: textConfigId || undefined, text_model_parameters: textModelParameters, async_prepare: asyncPrepare || undefined, ...(redrawOptions ? { manual: redrawOptions.manual, prompt: redrawOptions.prompt, reference_images: redrawOptions.reference_images } : {}) }),
}

// 统一生成任务（图片/视频）：POST 带 type 字段，列表按 type 过滤
export const assetImageJobAPI = {
  list: (params: Record<string, unknown> = {}) => api.get('/asset-image-jobs' + activityQuery(params)),
  get: (id: string) => api.get('/asset-image-jobs/' + encodeURIComponent(id)),
}

export const taskAPI = {
  generate: (d: any) => api.post('/tasks', d),
  cancel: (id: number | string) => api.post(`/tasks/${id}/cancel`, {}),
  recover: (id: number) => api.post(`/tasks/${id}/recover`),
  /** Round 5: 回传视频 for one handed-off Jimeng task (only queries; never a new generation). */
  jimengReturn: (id: number) => api.post<{ id: number; outcome: string; message: string }>(`/tasks/${id}/jimeng-return`, {}),
  diagnostics: (id: number) => api.get(`/tasks/${id}/diagnostics`),
  get: (id: number) => api.get(`/tasks/${id}`),
  del: (id: number) => api.del(`/tasks/${id}`),
  list: (params?: { type?: 'image' | 'video'; drama_id?: number; storyboard_id?: number }) => {
    const query = new URLSearchParams()
    if (params?.type) query.set('type', params.type)
    if (params?.drama_id) query.set('drama_id', String(params.drama_id))
    if (params?.storyboard_id) query.set('storyboard_id', String(params.storyboard_id))
    return api.get(`/tasks${query.size ? `?${query.toString()}` : ''}`)
  },
  // 按集聚合生成任务（sys_task + video_merges）
  listByEpisode: (episodeId: number) => api.get<{ tasks: any[]; merges: any[] }>(`/episodes/${episodeId}/generation-tasks`),
}

async function uploadReq<T = any>(path: string, file: File): Promise<T> {
  const fd = new FormData()
  fd.append('file', file)
  console.log(`%c[API] %cPOST %c${path} %c${file.name}`, 'color:#888', 'color:#4fc3f7;font-weight:bold', 'color:#ccc', 'color:#888')
  const revision = platformSession.revision
  const resp = await fetch(`${BASE}${path}`, { method: 'POST', credentials: 'same-origin', headers: platformHeaders('POST'), body: fd })
  const json = await resp.json()
  if (revision !== platformSession.revision) throw new Error('登录身份已变化，已忽略旧上传结果。')
  if (!resp.ok || (json.code && json.code >= 400)) {
    if (resp.status === 401 || json.code === 401) expirePlatformSession()
    console.log(`%c[API] %cPOST ${path} %c${resp.status}`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold')
    throw new Error(json.message || `${resp.status}`)
  }
  return Object.prototype.hasOwnProperty.call(json, 'data') ? json.data : json
}

export const uploadAPI = {
  image: (f: File) => uploadReq<{ url: string; path: string }>('/upload/image', f),
  video: (f: File) => uploadReq<{ url: string; path: string }>('/upload/video', f),
  audio: (f: File) => uploadReq<{ url: string; path: string }>('/upload/audio', f),
}
export const mergeAPI = {
  merge: (epId: number, storyboardIds?: number[]) => api.post(`/merge/episodes/${epId}/merge`, storyboardIds?.length ? { storyboard_ids: storyboardIds } : {}),
  status: (epId: number) => api.get(`/merge/episodes/${epId}/merge`),
  list: (epId: number) => api.get<any[]>(`/merge/episodes/${epId}/merges`),
}
export const aiConfigAPI = {
  list: (t?: string) => api.get(`/ai-configs${t ? `?service_type=${t}` : ''}`),
  create: (d: any) => api.post('/ai-configs', d),
  update: (id: number, d: any) => api.put(`/ai-configs/${id}`, d),
  del: (id: number) => api.del(`/ai-configs/${id}`),
  test: (d: any) => api.post('/ai-configs/test', d),
  models: (d: any) => api.post('/ai-configs/models', d),
}

export const platformUserAPI = {
  list: () => api.get<any[]>('/admin/users'),
  create: (body: any) => api.post('/admin/users', body),
  update: (id: number, body: any) => api.put(`/admin/users/${id}`, body),
  resetPassword: (id: number, body: any = {}) => api.post(`/admin/users/${id}/reset-password`, body),
  remove: (id: number) => api.del<{ deleted: boolean; user_id: number; projects_preserved: boolean; history_preserved: boolean }>(`/admin/users/${id}`),
}

export const channelAPI = {
  list: () => api.get('/admin/channels'),
  protocols: () => api.get<any[]>('/admin/protocols'),
  create: (body: any) => api.post('/admin/channels', body),
  update: (id: number, body: any) => api.put(`/admin/channels/${id}`, body),
  remove: (id: number) => api.del(`/admin/channels/${id}`),
  catalog: (id: number) => api.post(`/admin/channels/${id}/catalog`, {}),
  test: (id: number) => api.post(`/admin/channels/${id}/test`, {}),
  models: (id: number) => api.get<any[]>(`/admin/channels/${id}/models`),
  createModel: (id: number, body: any) => api.post(`/admin/channels/${id}/models`, body),
  updateModel: (id: number, modelId: number, body: any) => api.put(`/admin/channels/${id}/models/${modelId}`, body),
  removeModel: (id: number, modelId: number) => api.del(`/admin/channels/${id}/models/${modelId}`),
  setDefault: (id: number, modelId: number) => api.post(`/admin/channels/${id}/models/${modelId}/default`, {}),
  createProtocol: (body: any) => api.post('/admin/protocols', body),
  importPlugin: (file: File, preview = true) => { const body = new FormData(); body.append('file', file); body.append('preview', String(preview)); return uploadBody('/admin/protocols/import', body) },
}

async function uploadBody(path: string, body: FormData) {
  const response = await fetch(BASE + path, { method: 'POST', credentials: 'same-origin', headers: platformHeaders('POST'), body })
  const value = await response.json()
  if (!response.ok || value.code >= 400) { if (response.status === 401) expirePlatformSession(); throw new Error(value.message || '上传失败') }
  return Object.hasOwn(value, 'data') ? value.data : value
}

export const modelTestAPI = {
  create: (body: any) => api.post('/admin/model-tests', body),
  get: (id: string) => api.get('/admin/model-tests/' + encodeURIComponent(id)),
}

function activityQuery(params: Record<string, unknown> = {}) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
  return query.size ? '?' + query.toString() : ''
}
export const activityAPI = {
  list: (params: Record<string, unknown> = {}) => api.get('/activity/tasks' + activityQuery(params)),
  detail: (id: string) => api.get('/activity/tasks/' + encodeURIComponent(id)),
  events: (id: string, params: Record<string, unknown> = {}) => api.get('/activity/tasks/' + encodeURIComponent(id) + '/events' + activityQuery(params)),
  eventsUrl: (params: Record<string, unknown> = {}) => BASE + '/activity/events' + activityQuery(params),
  export: async (id: string) => {
    const response = await fetch(BASE + '/activity/tasks/' + encodeURIComponent(id) + '/export', { credentials: 'same-origin', headers: platformHeaders('GET') })
    if (!response.ok) { if (response.status === 401) expirePlatformSession(); const error = await response.json().catch(() => ({})); throw new Error(error.message || '导出失败') }
    return response.blob()
  },
}

export const productionAPI = {
  dashboard: (params: Record<string, unknown> = {}) => api.get('/production-dashboard' + activityQuery(params)),
  task: (id: string) => api.get('/production-dashboard/tasks/' + encodeURIComponent(id)),
  batches: (dramaId?: number | null) => api.get('/production-batches' + activityQuery({ drama_id: dramaId })),
  createBatch: (data: any) => api.post('/production-batches', data),
  batch: (id: string) => api.get('/production-batches/' + encodeURIComponent(id)),
  pause: (id: string) => api.post('/production-batches/' + encodeURIComponent(id) + '/pause', {}),
  resume: (id: string) => api.post('/production-batches/' + encodeURIComponent(id) + '/resume', {}),
  retry: (id: string, stepIds?: string[]) => api.post('/production-batches/' + encodeURIComponent(id) + '/retry', stepIds ? { step_ids: stepIds } : {}),
}

// lang 缺省/为 zh 时读写基础版（不带 query，保持原请求形态）
const langQ = (lang?: string) => (lang && lang !== 'zh' ? `?lang=${lang}` : '')

export const promptAPI = {
  list: () => api.get('/prompts'),
  get: (type: string, lang?: string) => api.get(`/prompts/${type}${langQ(lang)}`),
  update: (type: string, d: any, lang?: string) => api.put(`/prompts/${type}${langQ(lang)}`, d),
  reset: (type: string, lang?: string) => api.post(`/prompts/${type}/reset${langQ(lang)}`),
}

export const skillsAPI = {
  list: (lang?: string) => api.get(`/skills${langQ(lang)}`),
  get: (id: string, lang?: string) => api.get(`/skills/${id}${langQ(lang)}`),
  create: (data: { id: string; name: string; description?: string }) => api.post('/skills', data),
  update: (id: string, content: string, lang?: string) => api.put(`/skills/${id}${langQ(lang)}`, { content }),
  del: (id: string) => api.del(`/skills/${id}`),
}

export const stylePresetAPI = {
  list: (all = false) => api.get(`/style-presets${all ? '?all=1' : ''}`),
  create: (d: any) => api.post('/style-presets', d),
  update: (id: number, d: any) => api.put(`/style-presets/${id}`, d),
  del: (id: number) => api.del(`/style-presets/${id}`),
  refreshProject: (id: number) => api.post(`/dramas/${id}/style/refresh`, {}),
}

export const storageAPI = {
  info: () => api.get('/storage'),
}

export const settingsAPI = {
  contentLanguage: () => api.get<{ language: string }>('/settings/content-language'),
  setContentLanguage: (language: string) => api.put('/settings/content-language', { language }),
}

// 服务器/Docker 部署的版本检查与更新（桌面版走 useDesktopBridge，不用此 API）
export const serverUpdateAPI = {
  state: () => api.get('/server-update/state'),
  check: () => api.post('/server-update/check'),
  apply: () => api.post('/server-update/apply'),
}
