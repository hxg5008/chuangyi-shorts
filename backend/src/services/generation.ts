/**
 * 统一生成任务服务 — 图片/视频生成共用 sys_task 表与同一条生命周期：
 * 创建(processing) → 适配器构建请求 → 同步完成或异步轮询 → 下载落盘 → 回写业务表
 */
import { db, getInsertId, schema } from '../db/index.js'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { getAbsolutePath } from '../utils/storage.js'
import { downloadVideo, safeTaskError } from './video-download.js'
import { prepareReferenceAudio, resolveReferenceAudioUrls } from './reference-audio.js'
import { getActiveConfig, getConfigById, assertConfiguredModel, assertConfigService, validateModelParameters } from './ai.js'
import { now } from '../utils/response.js'
import { downloadFile, fetchImageAsCompressedDataUrl, generateImageThumb, readImageAsCompressedDataUrl, readImageAsDataUrl, saveBase64Image } from '../utils/storage.js'
import { extractVideoPoster } from '../utils/video-poster.js'
import { getImageAdapter, getVideoAdapter, getConfiguredImageAdapter, getConfiguredVideoAdapter } from './adapters/registry'
import type { AIConfig } from './adapters/types'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn, redactUrl } from '../utils/task-logger.js'
import { fetchProvider, fetchImageProvider } from '../utils/http.js'
import { signedProviderMediaUrl, registerPrivateMedia, currentActor, actorForProject, resourceProject } from './platform-security/index.js'
import { syncMediaActivity } from './activity/source-sync.js'
import { currentActivity } from './activity/context.js'
import { providerProgress } from './provider-progress.js'
import { decodeProviderResponse, compileProvider, cancelProvider } from './provider-runtime/index.js'
import { registerRuntimeSecrets } from '../utils/secret-redaction.js'
import { validateChannelControls } from './channel-controls.js'
import { buildSceneImagePrompt, SCENE_IMAGE_LAYOUT, SCENE_IMAGE_SIZE, sceneImageOutput } from './scene-image-contract.js'
import { EIGHT_API_C5_MODEL, validateEightApiVideoControls, validateEightApiVideoSettings } from './adapters/eight-api-video.js'
import { EightApiReferenceError, prepareEightApiPublicImages } from './eight-api-references.js'
import { randomUUID } from 'node:crypto'
import { freezeJimengReferences } from './jimeng-local-media.js'
import { buildJimengContentRequest, jimengHeaders, validateJimengVideoRecord } from './adapters/jimeng-local-video.js'
import type { JimengPreparedRecord } from './adapters/jimeng-local-video.js'
import { deliverJimengVideo, runJimengTask, setJimengVideoDelivery } from './jimeng-local-task.js'
import { buildJimengCanvasContentRequest, isJimengCanvasVideoId } from './jimeng-local-delivery.js'
import { handedOffTasksOfEpisode, isHandedOffJimengTask, returnJimengVideos, startJimengAutoReturn } from './jimeng-return.js'
import { resolveJimengProjectConfig, restoreJimengProjectConfig } from './execution-projects.js'
import { composeProjectStyle, getDramaStyleSnapshot } from './style-preset.js'
import { recordGeneratedAssetImage } from './asset-image-history.js'
import { resolveFrozenAssetReferences } from './asset-image-files.js'
import { withRequestLogContext, type RequestLogContext } from './request-logs/context.js'

type TaskType = 'image' | 'video'

const activeTasks = new Set<number>()
const videoSubmissions = new Set<number>()
const cancellingTasks = new Set<number>()
const manualImageSubmissions = new Set<string>()
export function isTaskActive(id: number): boolean { return activeTasks.has(id) }
function runBackground(id: number, job: () => Promise<void>) {
  if (activeTasks.has(id)) return
  activeTasks.add(id)
  void job().catch(error => failTask(id, safeTaskError(error))).finally(() => { activeTasks.delete(id); try { syncMediaActivity(id) } catch {} })
}

const taskLabel = (type: TaskType) => (type === 'image' ? 'ImageTask' : 'VideoTask')
function assertPreparationTarget(fields: { characterId?: number | null; sceneId?: number | null; propId?: number | null }, force = false) {
  if (!force && !currentActivity()?.assetPreparationJobId) return
  currentActivity()?.abortSignal?.throwIfAborted()
  for (const [table, id] of [['characters', fields.characterId], ['scenes', fields.sceneId], ['props', fields.propId]] as const) {
    if (!id) continue
    const asset = db.$client.prepare(`SELECT deleted_at FROM ${table} WHERE id=?`).get(id) as { deleted_at: string | null } | undefined
    if (!asset || asset.deleted_at) throw new Error('素材已删除，已停止图片准备；未提交新的出图请求')
  }
}

// 轮询节奏：图片 5s×120（上限 10 分钟）；视频 10s×300
const POLL_PROFILES: Record<TaskType, { attempts: number; intervalMs: number; maxDurationMs: number | null }> = {
  image: { attempts: 120, intervalMs: 5000, maxDurationMs: 600_000 },
  video: { attempts: 300, intervalMs: 10_000, maxDurationMs: 50 * 60_000 },
}

interface GenerateImageParams {
  storyboardId?: number
  dramaId?: number
  sceneId?: number
  characterId?: number
  propId?: number
  prompt: string
  model?: string
  size?: string
  referenceImages?: string[]
  frameType?: string
  configId?: number
  modelParameters?: Record<string, unknown>
  activityTaskId?: string
  /** Explicit manual redraw uses the editor's exact prompt and frozen references. */
  manualAssetImage?: boolean
  referenceImageHashes?: string[]
  referenceImageSources?: string[]
}

interface GenerateVideoParams {
  storyboardId?: number
  dramaId?: number
  prompt: string
  model?: string
  referenceMode?: string
  imageUrl?: string
  firstFrameUrl?: string
  lastFrameUrl?: string
  referenceImageUrls?: string[]
  referenceImageNames?: string[]
  referenceVideoUrls?: string[]
  referenceAudioUrls?: string[]
  referenceFileUrl?: string
  referenceLinkUrl?: string
  generateAudio?: boolean
  duration?: number
  aspectRatio?: string
  resolution?: string
  seed?: number
  promptExtend?: boolean
  watermark?: boolean
  configId?: number
  forceNew?: boolean
  modelParameters?: Record<string, unknown>
  activityTaskId?: string
  styleSnapshot?: unknown
  /** Local project binding chosen before a single/batch submission. */
  executionProjectRouteId?: number
}

function manualImageKey(fields: {characterId?:number|null;sceneId?:number|null;propId?:number|null}) {
  return fields.characterId ? {key:`character:${fields.characterId}`,kind:'character',field:'character_id',id:fields.characterId}
    : fields.sceneId ? {key:`scene:${fields.sceneId}`,kind:'scene',field:'scene_id',id:fields.sceneId}
    : fields.propId ? {key:`prop:${fields.propId}`,kind:'prop',field:'prop_id',id:fields.propId} : null
}
function assertManualImageAvailable(fields: {characterId?:number|null;sceneId?:number|null;propId?:number|null}) {
  const asset = manualImageKey(fields)
  if (!asset) throw new Error('手动重绘必须关联角色、场景或道具。')
  if (db.$client.prepare(`SELECT id FROM sys_task WHERE type='image' AND ${asset.field}=? AND status IN ('processing','pending') LIMIT 1`).get(asset.id)) throw Object.assign(new Error('该素材已有图片任务运行中，请等待完成；未重复提交。'),{status:409})
  if (db.$client.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='platform_asset_image_jobs'").get()) {
    const preparing = db.$client.prepare("SELECT id FROM platform_asset_image_jobs WHERE asset_kind=? AND asset_id=? AND status='preparing_prompt'").get(asset.kind,asset.id) as {id:string}|undefined
    if (preparing && preparing.id !== currentActivity()?.assetPreparationJobId) throw Object.assign(new Error('该素材正在准备图片任务，请等待原任务完成；未重复提交。'),{status:409})
  }
  return asset
}
export async function generateImage(params: GenerateImageParams): Promise<number> {
  const manualAsset = params.manualAssetImage === true ? manualImageKey(params) : null
  if (params.manualAssetImage === true) {
    if (!manualAsset) throw new Error('手动重绘必须关联素材。')
    if (manualImageSubmissions.has(manualAsset.key)) throw Object.assign(new Error('该素材正在提交重绘，请勿重复点击。'),{status:409})
    assertManualImageAvailable(params)
    manualImageSubmissions.add(manualAsset.key)
  }
  try {
  currentActivity()?.abortSignal?.throwIfAborted()
  // An explicit binding is also the caller's authorization and billing choice.
  let config = params.configId
    ? await getConfigById(params.configId)
    : await getActiveConfig('image')
  if (!config) throw new Error('未配置图片模型，请先到「设置」页添加并启用 AI 服务')
  assertConfigService(config, 'image')
  params.modelParameters = validateModelParameters(config, params.modelParameters ?? currentActivity()?.modelParameters)
  config = { ...config, defaults: { ...config.defaults, ...params.modelParameters } }
  params.size ??= typeof params.modelParameters.size === 'string' ? params.modelParameters.size : undefined
  params.model = assertConfiguredModel(config, params.model)
  registerRuntimeSecrets([config.apiKey, ...Object.values(config.headers || {})])
  validateChannelControls(config, params)

  // A scene reference asset is a labelled four-view board. Storyboard frames remain single images.
  const isSceneReference = !!params.sceneId && !params.storyboardId && !params.frameType && !params.characterId && !params.propId
  const asset = params.characterId ? { kind: 'character' as const, id: params.characterId } : params.sceneId ? { kind: 'scene' as const, id: params.sceneId } : params.propId ? { kind: 'prop' as const, id: params.propId } : undefined
  const projectId = params.dramaId ?? (asset ? resourceProject(asset.kind, asset.id) : params.storyboardId ? resourceProject('storyboard', params.storyboardId) : null)
  const styled = params.manualAssetImage === true
    ? { prompt: params.prompt, snapshot: currentActivity()?.styleSnapshot ?? (projectId ? getDramaStyleSnapshot(projectId) : null) }
    : await composeProjectStyle(projectId, params.prompt, 'asset_image', asset)
  if (manualAsset) {
    // The explicit editor text is a user-confirmed final prompt. Persist it
    // only inside the protected manual submission, never change normal PUT's
    // appearance/styling invalidation rule, and avoid re-writing identical text.
    const table = ({character:'characters',scene:'scenes',prop:'props'} as const)[manualAsset.kind as 'character'|'scene'|'prop']
    assertPreparationTarget(params,true)
    db.$client.prepare(`UPDATE ${table} SET final_prompt=?,updated_at=? WHERE id=? AND deleted_at IS NULL AND (final_prompt IS NULL OR final_prompt<>?)`).run(params.prompt,now(),manualAsset.id,params.prompt)
  }
  const id = await createTask('image', config, {
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    propId: params.propId,
    prompt: isSceneReference && !params.manualAssetImage ? buildSceneImagePrompt(styled.prompt) : styled.prompt,
    model: params.model || config.model,
  }, {
    size: isSceneReference ? SCENE_IMAGE_SIZE : params.size || config.defaults?.size || '1920x1080',
    ...(isSceneReference ? { sceneImageLayout: SCENE_IMAGE_LAYOUT } : {}),
    frameType: params.frameType,
    referenceImages: params.referenceImages,
    ...(params.manualAssetImage ? { manualAssetImage: true, strictReferenceImages: true, referenceImageHashes: params.referenceImageHashes, referenceImageSources: params.referenceImageSources } : {}),
    modelParameters: params.modelParameters,
    activityTaskId: params.activityTaskId,
    styleSnapshot: styled.snapshot,
  })

  logTaskStart('ImageTask', 'enqueue', {
    id,
    provider: config.provider,
    storyboardId: params.storyboardId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    frameType: params.frameType,
    model: params.model || config.model,
  })
  logTaskPayload('ImageTask', 'enqueue params', {
    id,
    config: { provider: config.provider, model: config.model, baseUrl: config.baseUrl },
    params,
  })
  return id
  } finally { if (manualAsset) manualImageSubmissions.delete(manualAsset.key) }
}

export async function generateVideo(params: GenerateVideoParams): Promise<number> {
  const storyboardId = params.storyboardId
  if (storyboardId && videoSubmissions.has(storyboardId)) throw new Error('该分镜正在提交任务，请勿重复点击')
  if (storyboardId) videoSubmissions.add(storyboardId)
  try {
    if (storyboardId) {
      const [latest] = await db.select().from(schema.sysTask).where(and(eq(schema.sysTask.type, 'video'), eq(schema.sysTask.storyboardId, storyboardId)))
        .orderBy(desc(schema.sysTask.id)).limit(1)
      if (latest?.status === 'processing') throw new Error('该分镜已有运行中的任务，请等待结果')
      if (latest?.status === 'failed' && params.forceNew !== true) throw new Error('请先恢复原任务；重新生成需确认可能再次计费')
      // Round 5: the shot's video is already with Jimeng (accepted, card named); it comes back through 回传.
      if (isHandedOffJimengTask(latest) && params.forceNew !== true) throw new Error('该分镜的视频已交即梦生成，出片后可回传；重新生成会再次计费，请确认后再提交')
    }
    // Do not silently substitute another channel when a chosen binding is unavailable.
    let config = params.configId
      ? await getConfigById(params.configId)
      : await getActiveConfig('video')
    if (!config) throw new Error('未配置视频模型，请先到「设置」页添加并启用 AI 服务')
    assertConfigService(config, 'video')
    params.modelParameters = validateModelParameters(config, params.modelParameters ?? currentActivity()?.modelParameters)
    config = { ...config, defaults: { ...config.defaults, ...params.modelParameters } }
    params.model = assertConfiguredModel(config, params.model)
    registerRuntimeSecrets([config.apiKey, ...Object.values(config.headers || {})])
    params.duration ??= params.modelParameters.duration ?? config.defaults?.duration
    params.aspectRatio ??= params.modelParameters.aspectRatio ?? config.defaults?.aspect_ratio
    params.resolution ??= params.modelParameters.resolution ?? config.defaults?.resolution
    params.generateAudio ??= typeof params.modelParameters.generateAudio === 'boolean' ? params.modelParameters.generateAudio : undefined
    params.promptExtend ??= typeof params.modelParameters.promptExtend === 'boolean' ? params.modelParameters.promptExtend : undefined
    params.watermark ??= typeof params.modelParameters.watermark === 'boolean' ? params.modelParameters.watermark : undefined
    params.seed ??= typeof params.modelParameters.seed === 'number' ? params.modelParameters.seed : undefined
    validateChannelControls(config, params)

    if (config.provider === 'jimeng_local') {
      const projectId = params.storyboardId ? resourceProject('storyboard', params.storyboardId) : params.dramaId
      if (params.dramaId && projectId && params.dramaId !== projectId) throw new Error('分镜与项目不一致，未提交即梦任务。')
      params.dramaId = projectId || params.dramaId
      const record = { ...params, id:0, model:params.model || config.model,
        referenceMode:params.referenceImageUrls?.length ? 'reference' : 'text_to_video',
        referenceVideoUrls:JSON.stringify(params.referenceVideoUrls || []),referenceAudioUrls:JSON.stringify(params.referenceAudioUrls || []),
        referenceImageUrls:JSON.stringify(params.referenceImageUrls || []),referenceImageNames:JSON.stringify(params.referenceImageNames || []) }
      const request = validateJimengVideoRecord(record)
      config = await resolveJimengProjectConfig(config, params.dramaId, params.executionProjectRouteId)
      // Resolve the durable route before async image preparation. A later user
      // canvas switch must not redirect this already-started submission.
      const snapshots = await freezeJimengReferences(record)
      const jimengMetadata: NonNullable<JimengPreparedRecord['metadata']> = { storyboard_id: params.storyboardId, drama_id: params.dramaId }
      if (params.storyboardId) {
        const storyboard = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, params.storyboardId)).get()
        const episode = storyboard && db.select().from(schema.episodes).where(eq(schema.episodes.id, storyboard.episodeId)).get()
        if (storyboard && episode) {
          // Match GET /episodes/:episode_id/storyboards and the full, unfiltered page list.
          // The stored ordering number and database ID are not the displayed shot number.
          const siblings = db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, storyboard.episodeId))
            .orderBy(schema.storyboards.storyboardNumber).all()
          const index = siblings.findIndex(item => item.id === storyboard.id)
          if (index >= 0) {
            jimengMetadata.episode_number = episode.episodeNumber
            jimengMetadata.storyboard_number = index + 1
          }
        }
      }
      return await createTask('video',config,{storyboardId:params.storyboardId,dramaId:params.dramaId,prompt:params.prompt,model:record.model},{
        referenceMode:request.mode,referenceImageUrls:params.referenceImageUrls || [],referenceImageNames:request.names,
        duration:request.duration,aspectRatio:request.aspectRatio,idempotencyKey:randomUUID(),jimengSnapshots:snapshots,
        jimengMetadata,
        ...(config.executionProjectRouteId ? { jimengProjectRoute: { id: config.executionProjectRouteId, routeId: config.executionRouteId } } : {}),
        styleSnapshot: params.styleSnapshot,
        modelParameters: params.modelParameters, activityTaskId: params.activityTaskId,
      })
    }

    if (config.provider === '888api') {
      validateEightApiVideoControls(params)
      if (params.referenceVideoUrls?.length || params.referenceAudioUrls?.length || params.referenceFileUrl || params.referenceLinkUrl
        || params.imageUrl || params.firstFrameUrl || params.lastFrameUrl) {
        throw new Error('当前 888API 通道仅接入文字和多张参考图片，请移除参考音视频、音色、首尾帧和文件引用')
      }
      const settings = validateEightApiVideoSettings(params.model || config.model, params.duration, params.aspectRatio, params.resolution)
      params.duration = settings.duration
      params.aspectRatio = settings.aspectRatio
      params.resolution = settings.resolution
    }
    if (config.provider !== 'yingce') params.referenceAudioUrls = await prepareReferenceAudio(params.referenceAudioUrls, config.provider)

    const id = await createTask('video', config, {
      storyboardId: params.storyboardId,
      dramaId: params.dramaId,
      prompt: params.prompt,
      model: params.model || config.model,
    }, {
      referenceMode: params.referenceMode || 'reference',
      imageUrl: params.imageUrl,
      firstFrameUrl: params.firstFrameUrl,
      lastFrameUrl: params.lastFrameUrl,
      referenceImageUrls: params.referenceImageUrls,
      referenceVideoUrls: params.referenceVideoUrls,
      referenceAudioUrls: params.referenceAudioUrls,
      referenceFileUrl: params.referenceFileUrl,
      referenceLinkUrl: params.referenceLinkUrl,
      ...(config.provider === '888api' ? { audioControl: 'provider_default' } : {
        generateAudio: params.generateAudio === false ? 0 : 1,
        seed: params.seed,
        promptExtend: params.promptExtend,
        watermark: params.watermark,
      }),
      duration: params.duration,
      aspectRatio: params.aspectRatio,
      // 统一存为项目内部格式，各适配器再转换为官方大小写与枚举。
      resolution: ['custom_json', 'yingce'].includes(config.provider) ? params.resolution : normalizeStoredVideoResolution(params.resolution),
      modelParameters: params.modelParameters,
      activityTaskId: params.activityTaskId,
      styleSnapshot: params.styleSnapshot,
    })

    logTaskStart('VideoTask', 'enqueue', {
      id,
      provider: config.provider,
      storyboardId: params.storyboardId,
      dramaId: params.dramaId,
      referenceMode: params.referenceMode || 'reference',
      duration: params.duration || 5,
    })
    logTaskPayload('VideoTask', 'enqueue params', {
      id,
      config: { provider: config.provider, model: config.model, baseUrl: config.baseUrl },
      params,
    })
    return id
  } finally {
    if (storyboardId) videoSubmissions.delete(storyboardId)
  }
}

async function createTask(
  type: TaskType,
  config: AIConfig,
  fields: {
    storyboardId?: number
    dramaId?: number
    sceneId?: number
    characterId?: number
    propId?: number
    prompt: string
    model?: string | null
  },
  params: Record<string, unknown>,
): Promise<number> {
  currentActivity()?.abortSignal?.throwIfAborted()
  const preparation = currentActivity()
  if (type === 'image' && params.manualAssetImage === true) {
    assertPreparationTarget(fields, true)
    assertManualImageAvailable(fields)
  }
  if (type === 'image' && preparation?.assetPreparationJobId) {
    assertPreparationTarget(fields)
    params.assetPreparationJobId = preparation.assetPreparationJobId
    params.activityTaskId ??= preparation.taskId
  }
  const ts = now()
  // Freeze initiating identity before this job leaves the HTTP request.
  if (!params.requestLogIdentity && (currentActor() || preparation?.userId)) {
    let projectId=fields.dramaId||preparation?.projectId||null,projectOwnerId:number|null=null
    try {
      projectId ||= fields.storyboardId?resourceProject('storyboard',fields.storyboardId):fields.characterId?resourceProject('character',fields.characterId):fields.sceneId?resourceProject('scene',fields.sceneId):fields.propId?resourceProject('prop',fields.propId):null
      if(projectId)projectOwnerId=(db.$client.prepare('SELECT owner_user_id FROM dramas WHERE id=?').get(projectId) as any)?.owner_user_id??null
    }catch{}
    params.requestLogIdentity={actorUserId:currentActor()?.id??preparation?.userId??null,projectId,projectOwnerId,episodeId:preparation?.episodeId??null}
  }
  if (config.provider === 'yingce' && !params.idempotencyKey) params.idempotencyKey = randomUUID()
  const protocolSnapshot = config.protocolId ? { protocolId: config.protocolId, protocolDefinition: config.protocolDefinition,
    bindingId: config.bindingId, channelId: config.channelId, capabilities: config.capabilities, defaults: config.defaults } : undefined
  const res = await db.insert(schema.sysTask).values({
    type,
    ...fields,
    provider: config.provider,
    configId: config.id,
    configBaseUrl: config.baseUrl,
    stage: type === 'image' ? 'queued' : 'submitting',
    params: JSON.stringify({ ...params, ...(protocolSnapshot ? { protocolSnapshot } : {}) }),
    status: 'processing',
    createdAt: ts,
    updatedAt: ts,
  })

  const id = getInsertId(res)
  try { syncMediaActivity(id) } catch {}
  runBackground(id, () => processTask(id, config))
  return id
}

function parseTaskParams(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {}
  try {
    return JSON.parse(raw) || {}
  } catch {
    return {}
  }
}

function mediaRequestContext(record:SysTaskRecord,config?:AIConfig):RequestLogContext {
  const params=parseTaskParams(record.params),saved=params.requestLogIdentity||{}
  let taskId:string|undefined,projectId=saved.projectId||record.dramaId||null,projectOwnerId=saved.projectOwnerId??null
  try{
    taskId=(db.$client.prepare("SELECT id FROM platform_activity_tasks WHERE source_type='media' AND source_id=?").get(String(record.id)) as any)?.id
    projectId ||= resourceProject('task',record.id)
    if(projectId&&projectOwnerId==null)projectOwnerId=(db.$client.prepare('SELECT owner_user_id FROM dramas WHERE id=?').get(projectId) as any)?.owner_user_id??null
  }catch{}
  return{taskId,actorUserId:saved.actorUserId??null,projectId,projectOwnerId,episodeId:saved.episodeId??null,configId:record.configId??config?.id,channelId:config?.channelId??params.protocolSnapshot?.channelId,channelName:config?.channelName,model:record.model,kind:record.type==='image'?'image':'video',upstreamTaskId:record.taskId}
}
async function processTask(id:number,config:AIConfig){
  const record=db.select().from(schema.sysTask).where(eq(schema.sysTask.id,id)).get()
  if(!record)return
  return withRequestLogContext({...mediaRequestContext(record,config),phase:'generate'},()=>processTaskInternal(id,config))
}
async function processTaskInternal(id: number, config: AIConfig) {
  let awaitingSubmissionResult = false
  try {
    const [record] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
    if (!record) return
    const type = record.type as TaskType
    if (type === 'video' && config.provider === 'jimeng_local') { await runJimengTask(id,config);return }
    const label = taskLabel(type)
    const params = parseTaskParams(record.params)
    const providerParams={...params};delete providerParams.requestLogIdentity
    config.generationRequest = { ...providerParams, id: record.id, model: record.model, prompt: record.prompt,
      flowSizeLocked: !!(record.characterId || record.sceneId || record.propId || params.frameType) }
    logTaskProgress(label, 'build-request', {
      id,
      provider: config.provider,
      storyboardId: record.storyboardId,
      sceneId: record.sceneId,
      characterId: record.characterId,
    })

    let url: string, method: string, headers: Record<string, string>, body: unknown, builtRequest: any
    const adapter = type === 'image' ? getConfiguredImageAdapter(config) : getConfiguredVideoAdapter(config)

    if (type === 'image') {
      const resolvedReferenceImages = params.manualAssetImage === true
        ? await resolveFrozenAssetReferences(params.referenceImages,params.referenceImageHashes)
        : config.provider === 'yingce' ? params.referenceImages || [] : await normalizeReferenceImages(params.referenceImages, params.strictReferenceImages === true || config.provider === 'custom_json')
      builtRequest = await (adapter as ReturnType<typeof getConfiguredImageAdapter>).buildGenerateRequest(config, {
        id: record.id,
        model: record.model,
        prompt: record.prompt,
        size: params.size,
        frameType: params.frameType,
        flowSizeLocked: !!(record.characterId || record.sceneId || record.propId || params.frameType),
        referenceImages: resolvedReferenceImages.length ? JSON.stringify(resolvedReferenceImages) : null,
        modelParameters: params.modelParameters,
      })
    } else {
      const resolvedImageUrl = config.provider === 'yingce' ? params.imageUrl : await normalizeVideoReferenceUrl(params.imageUrl)
      const resolvedFirstFrameUrl = config.provider === 'yingce' ? params.firstFrameUrl : await normalizeVideoReferenceUrl(params.firstFrameUrl)
      const resolvedLastFrameUrl = config.provider === 'yingce' ? params.lastFrameUrl : await normalizeVideoReferenceUrl(params.lastFrameUrl)
      const resolvedReferenceImageUrls = config.provider === 'yingce' ? params.referenceImageUrls || [] : config.provider === '888api' && record.model === EIGHT_API_C5_MODEL
        ? await prepareEightApiPublicImages(params.referenceImageUrls || [], {
          publicBaseUrl: process.env.PUBLIC_BASE_URL,
          lookupSource: localPath => db.select({ resultUrl: schema.sysTask.resultUrl }).from(schema.sysTask).where(and(
            eq(schema.sysTask.type, 'image'), eq(schema.sysTask.status, 'completed'), eq(schema.sysTask.localPath, localPath),
          )).orderBy(desc(schema.sysTask.id)).get()?.resultUrl || null,
        })
        : await normalizeVideoReferenceUrls(params.referenceImageUrls, ['888api', 'custom_json', 'yingce'].includes(config.provider))
      // 视频使用公网地址；短音色按厂商能力使用 data URL 或公网地址。
      const resolvedReferenceVideoUrls = config.provider === 'yingce' ? params.referenceVideoUrls || [] : resolvePublicMediaUrls(params.referenceVideoUrls, 'video')
      const resolvedReferenceAudioUrls = config.provider === 'yingce' ? params.referenceAudioUrls || [] : await resolveReferenceAudioUrls(params.referenceAudioUrls, config.provider)
      const resolvedReferenceFileUrl = config.provider === 'yingce' ? params.referenceFileUrl : resolvePublicMediaUrl(params.referenceFileUrl, 'file')
      builtRequest = await (adapter as ReturnType<typeof getConfiguredVideoAdapter>).buildGenerateRequest(config, {
        id: record.id,
        model: record.model,
        prompt: record.prompt,
        referenceMode: params.referenceMode,
        imageUrl: resolvedImageUrl,
        firstFrameUrl: resolvedFirstFrameUrl,
        lastFrameUrl: resolvedLastFrameUrl,
        referenceImageUrls: resolvedReferenceImageUrls.length ? JSON.stringify(config.provider === 'yingce' ? resolvedReferenceImageUrls : resolvedReferenceImageUrls.map((url: string) => signedProviderMediaUrl(url))) : null,
        referenceVideoUrls: resolvedReferenceVideoUrls.length ? JSON.stringify(resolvedReferenceVideoUrls) : null,
        referenceAudioUrls: resolvedReferenceAudioUrls.length ? JSON.stringify(resolvedReferenceAudioUrls) : null,
        referenceFileUrl: resolvedReferenceFileUrl,
        referenceLinkUrl: params.referenceLinkUrl,
        generateAudio: params.generateAudio,
        duration: params.duration,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        seed: params.seed,
        promptExtend: params.promptExtend,
        watermark: params.watermark,
        modelParameters: params.modelParameters,
      })
    }
    ;({ url, method, headers, body } = builtRequest)
    if (builtRequest.request) {
      params.providerRequestSnapshot = builtRequest.request
      config.generationRequest = { ...providerParams,providerRequestSnapshot:builtRequest.request, id: record.id, model: record.model, prompt: record.prompt }
      await mergeTaskDiagnostics(id, { providerRequestSnapshot: builtRequest.request })
      record.params = JSON.stringify(params)
    }

    logTaskProgress(label, 'request', {
      id,
      provider: config.provider,
      method,
      url: redactUrl(url),
      model: record.model,
    })

    const isMultipart = body instanceof FormData
    logTaskPayload(label, 'request payload', {
      id, method, url, headers,
      // multipart 表单（如 OpenAI /v1/images/edits）无法 JSON 化，记录字段摘要
      body: builtRequest.wireSummary ?? (isMultipart ? `[multipart/form-data: ${[...(body as FormData).keys()].join(', ')}]` : body),
    })

    awaitingSubmissionResult = true
    assertPreparationTarget(record)
    await db.update(schema.sysTask).set({ stage: 'submitting', updatedAt: now() }).where(eq(schema.sysTask.id, id))
    const requestFetch = type === 'image' ? fetchImageProvider : fetchProvider
    const resp = await requestFetch(url, {
      method,
      headers,
      body: isMultipart || typeof body === 'string' || body instanceof Uint8Array ? body as any : JSON.stringify(body),
      signal: AbortSignal.timeout(600_000),
      ...(config.provider === 'yingce' ? { redirect: 'error' as const } : {}),
    })

    // Firemux 在响应头提供内部任务编号；即使 JSON 响应体中断也能查询原任务。
    const gatewayTaskId = resp.headers.get('X-Firemux-Task-Id') || resp.headers.get('X-Huobao-Task-Id')
    if (type === 'video' && gatewayTaskId) {
      await markPolling(id, gatewayTaskId)
      record.taskId = gatewayTaskId
    }

    if (!resp.ok) {
      const responseText = await resp.text()
      if (type === 'image') throw imageProviderError(resp.status, responseText)
      throw new Error(`API error ${resp.status}: ${responseText}`)
    }
    const result = config.provider === 'yingce' ? await decodeProviderResponse(resp) : await resp.json() as any
    awaitingSubmissionResult = false
    logTaskPayload(label, 'response payload', { id, provider: config.provider, result })

    if (type === 'image') {
      const imageAdapter = adapter as ReturnType<typeof getConfiguredImageAdapter>
      const { isAsync, taskId, imageUrl, imageUrls } = await imageAdapter.parseGenerateResponse(result)

      if (!isAsync && imageUrl) {
        logTaskProgress(label, 'sync-complete', { id, imageUrl: redactUrl(imageUrl) })
        if (imageUrls && imageUrls.length > 1) await handleMultipleOutputs(record, imageUrls, 'image')
        else await handleImageComplete(record, imageUrl)
        return
      }

      if (!isAsync && !imageUrl) {
        // 同步模式但无 URL（Gemini 等返回 base64）
        const b64 = await imageAdapter.extractImageBase64(result)
        if (b64) {
          logTaskProgress(label, 'sync-base64-complete', { id, mimeType: b64.mimeType })
          await handleImageCompleteBase64(record, b64.data, b64.mimeType)
          return
        }
        throw new Error('No image URL or base64 data in response')
      }

      await markPolling(id, taskId)
      await pollTask(record, config, taskId!)
      return
    }

    const { isAsync, taskId, videoUrl, videoUrls, duration } = await (adapter as ReturnType<typeof getConfiguredVideoAdapter>).parseGenerateResponse(result)
    if (taskId) {
      await markPolling(id, taskId)
      record.taskId = taskId
    }

    if (!isAsync && videoUrl) {
      logTaskProgress(label, 'sync-complete', { id, videoUrl: redactUrl(videoUrl) })
      if (videoUrls && videoUrls.length > 1) await handleMultipleOutputs(record, videoUrls, 'video', duration ?? params.duration)
      else await handleVideoComplete(record, videoUrl, duration ?? params.duration)
      return
    }

    await markPolling(id, taskId)
    await pollTask(record, config, taskId!)
  } catch (err: any) {
    const [current] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
    if (err instanceof EightApiReferenceError) {
      await mergeTaskDiagnostics(id, { referenceFailure: { code: err.code, index: err.index, httpStatus: err.httpStatus, host: err.host,
        expiresAt: err.expiresAt, causeCode: err.causeCode, elapsedMs: err.elapsedMs, beforeSubmission: true } })
      await failTask(id, err.message, err.code)
      return
    }
    if (current?.type === 'image' && err instanceof ImageProviderError) {
      await failTask(id, err.message, err.code)
      return
    }
    const uncertain = !current?.taskId && !current?.resultUrl && (awaitingSubmissionResult || current?.type === 'video')
      && (err instanceof TypeError || err instanceof SyntaxError || /timeout|abort|terminated|No task_id|API error 5/i.test(err.message))
    const detail = taskErrorDetail(err)
    const invalidImageResponse = current?.type === 'image' && /No image URL|No image URL or base64|Unsupported image provider/i.test(err.message)
    const message = current?.type === 'image' && uncertain
      ? `图片生成请求返回异常，结果待确认；请先核对模型平台记录：${detail}`
      : invalidImageResponse ? '模型平台返回的数据缺少可用图片结果，请核对平台任务记录' : detail
    await failTask(id, message, uncertain ? 'submission_unknown' : invalidImageResponse ? 'generation_invalid_response'
      : current?.type === 'image' ? 'generation_failed' : undefined)
  }
}

class ImageProviderError extends Error {
  constructor(public readonly code: string, message: string) { super(message) }
}

function imageProviderError(status: number, responseText: string): ImageProviderError {
  // 仅分类原始错误，面向用户的诊断不回显可能含凭据、提示词或签名地址的响应体。
  let evidence = responseText
  try {
    const body = JSON.parse(responseText)
    evidence = [body.error?.code, body.error?.type, body.error?.message,
      typeof body.error === 'string' ? body.error : undefined, body.message]
      .filter(value => typeof value === 'string').join(' ')
  } catch { /* 部分网关直接返回错误文本。 */ }
  if ([400, 403, 422].includes(status) && /policy|refusal|moderation|content_filter|safety|违反.*政策|审核|内容.*违规/i.test(evidence)) {
    return new ImageProviderError('generation_rejected', `模型平台拒绝了图片生成请求（HTTP ${status}），请调整描述或参考素材`)
  }
  if (status === 401 || status === 403) return new ImageProviderError('generation_auth_failed', `模型平台鉴权失败（HTTP ${status}），请检查服务配置和权限`)
  if (status === 429) return new ImageProviderError('generation_rate_limited', '模型平台请求频率或额度受限（HTTP 429），请稍后再试或检查额度')
  if (status >= 500) return new ImageProviderError('generation_provider_error', `模型平台暂时不可用（HTTP ${status}），请先核对平台任务记录`)
  return new ImageProviderError('generation_invalid_request', `模型平台未接受图片生成请求（HTTP ${status}），请检查模型、尺寸和参考素材`)
}

/** 保留可操作的网络原因码，同时不暴露上游地址或凭据。 */
function taskErrorDetail(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined
  const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : ''
  return `${safeTaskError(error)}${/^[A-Z0-9_]{1,80}$/.test(code) ? ` (${code})` : ''}`
}

async function markPolling(id: number, taskId: string | undefined) {
  await db.update(schema.sysTask)
    .set({ taskId, stage: 'polling', status: 'processing', updatedAt: now() })
    .where(eq(schema.sysTask.id, id))
  logTaskProgress('SysTask', 'poll-start', { id, taskId })
}

async function failTask(id: number, message: string, code?: string) {
  message = safeTaskError(message)
  logTaskError('SysTask', 'failed', { id, error: message })
  await db.update(schema.sysTask)
    .set({ status: 'failed', errorMsg: safeTaskError(message), ...(code ? { errorCode: code } : {}), updatedAt: now() })
    .where(eq(schema.sysTask.id, id))
}

/** Merge only already-sanitized diagnostic fields; never replace live task parameters. */
async function mergeTaskDiagnostics(id: number, patch: Record<string, unknown>) {
  await db.update(schema.sysTask).set({ params: sql`json_patch(CASE WHEN json_valid(${schema.sysTask.params}) THEN ${schema.sysTask.params} ELSE '{}' END, ${JSON.stringify(patch)})` })
    .where(eq(schema.sysTask.id, id))
}

type SysTaskRecord = typeof schema.sysTask.$inferSelect

async function pollTask(record:SysTaskRecord,config:AIConfig,taskId:string){return withRequestLogContext({...mediaRequestContext(record,config),phase:'poll',upstreamTaskId:taskId},()=>pollTaskInternal(record,config,taskId))}
async function pollTaskInternal(record: SysTaskRecord, config: AIConfig, taskId: string) {
  const type = record.type as TaskType
  const label = taskLabel(type)
  const profile = POLL_PROFILES[type]
  const snapshot = parseTaskParams(record.params).protocolSnapshot
  const originalConfig = { ...config, ...snapshot, model: record.model || config.model,
    generationRequest: { ...parseTaskParams(record.params), id: record.id, model: record.model, prompt: record.prompt, taskId } }
  const adapter = type === 'image' ? getConfiguredImageAdapter(originalConfig) : getConfiguredVideoAdapter(originalConfig)
  const startedAt = Date.now()

  for (let i = 0; i < profile.attempts; i++) {
    if (db.select({ status: schema.sysTask.status }).from(schema.sysTask).where(eq(schema.sysTask.id, record.id)).get()?.status === 'cancelled') return
    if (profile.maxDurationMs && Date.now() - startedAt >= profile.maxDurationMs) {
      await failTask(record.id, type === 'image' ? 'Timeout: Polling exceeded 10 minutes' : '查询原视频任务超过50分钟，已停止自动查询；保留原任务ID，请核对平台后恢复查询', type === 'image' ? 'generation_poll_timeout' : 'video_poll_timeout')
      return
    }
    await new Promise(r => setTimeout(r, profile.intervalMs))
    try {
      const { url, method, headers, body } = await adapter.buildPollRequest(originalConfig, taskId)
      logTaskProgress(label, 'poll-request', {
        id: record.id,
        taskId,
        provider: config.provider,
        method,
        url: redactUrl(url),
        attempt: i + 1,
      })
      const remainingMs = profile.maxDurationMs
        ? Math.max(1_000, profile.maxDurationMs - (Date.now() - startedAt))
        : 600_000
      const requestFetch = type === 'image' ? fetchImageProvider : fetchProvider
      const resp = await requestFetch(url, {
        method,
        headers,
        ...(body !== undefined && method.toUpperCase() !== 'GET' ? { body: typeof body === 'string' || body instanceof FormData || body instanceof Uint8Array ? body as any : JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(type === 'video' ? Math.min(remainingMs, 30_000) : remainingMs),
      })
      if (!resp.ok) {
        if (type === 'video') {
          await mergeTaskDiagnostics(record.id, { lastPoll: { httpStatus: resp.status, checkedAt: now(), upstreamStatus: 'query_unavailable' } })
          if ([400, 401, 403, 404].includes(resp.status)) {
            await resp.body?.cancel()
            await failTask(record.id, `无法查询原视频任务（HTTP ${resp.status}），生成结果待核对；请保留任务ID检查平台记录后恢复查询，不要重复生成`, resp.status === 404 ? 'video_poll_not_found' : 'video_poll_access_failed')
            return
          }
        }
        if (type === 'image' && [400, 401, 403, 404].includes(resp.status)) {
          const error = imageProviderError(resp.status, await resp.text())
          await failTask(record.id, error.message, error.code)
          return
        }
        await resp.body?.cancel()
        continue
      }
      const result = config.provider === 'yingce' ? await decodeProviderResponse(resp) : await resp.json() as any
      if (db.select({ status: schema.sysTask.status }).from(schema.sysTask).where(eq(schema.sysTask.id, record.id)).get()?.status === 'cancelled') return

      // 图片/视频 PollResponse 结构不同，这里统一按 any 取值后按 type 分支
      const pollResp: any = await adapter.parsePollResponse(result)
      const observed = providerProgress(result, pollResp)
      await mergeTaskDiagnostics(record.id, { lastPoll: { httpStatus: resp.status, checkedAt: now(), ...observed } })
      if (['pending', 'processing'].includes(pollResp.status)) await db.update(schema.sysTask).set({ stage: observed.stage as any, updatedAt: now() }).where(eq(schema.sysTask.id, record.id))
      try { syncMediaActivity(record.id) } catch {}
      if (type === 'video' && pollResp.stage === 'transferring') {
        await db.update(schema.sysTask).set({ stage: 'transferring', updatedAt: now() }).where(eq(schema.sysTask.id, record.id))
      }

      if (pollResp.status === 'completed') {
        if (type === 'image') {
          if (pollResp.imageUrl) {
            logTaskSuccess(label, 'poll-complete', { id: record.id, taskId, imageUrl: redactUrl(pollResp.imageUrl) })
            if (pollResp.imageUrls?.length > 1) await handleMultipleOutputs(record, pollResp.imageUrls, 'image')
            else await handleImageComplete(record, pollResp.imageUrl)
            return
          }
          if (typeof (adapter as ReturnType<typeof getImageAdapter>).extractImageBase64 === 'function') {
            // Gemini 可能返回 base64
            const b64 = await (adapter as ReturnType<typeof getImageAdapter>).extractImageBase64(result)
            if (b64) {
              logTaskSuccess(label, 'poll-base64-complete', { id: record.id, taskId, mimeType: b64.mimeType })
              await handleImageCompleteBase64(record, b64.data, b64.mimeType)
              return
            }
          }
        } else if (pollResp.videoUrl || (record.provider === '888api' && pollResp.needsContentDownload)) {
          const videoUrl = pollResp.videoUrl || `${(await adapter.buildPollRequest(originalConfig, taskId)).url}/content`
          logTaskSuccess(label, 'poll-complete', { id: record.id, taskId, videoUrl: redactUrl(videoUrl) })
          if (pollResp.videoUrls?.length > 1) await handleMultipleOutputs(record, pollResp.videoUrls, 'video', pollResp.duration ?? parseTaskParams(record.params).duration)
          else await handleVideoComplete(record, videoUrl, pollResp.duration ?? parseTaskParams(record.params).duration)
          return
        }
      }
      if (pollResp.status === 'failed') {
        if (pollResp.cancelled === true) {
          await db.update(schema.sysTask).set({ status: 'cancelled', stage: 'cancelled', errorCode: 'user_cancelled', errorMsg: '上游已确认原任务取消；未重新生成。', updatedAt: now() }).where(eq(schema.sysTask.id, record.id))
          return
        }
        if (type === 'video') await mergeTaskDiagnostics(record.id, { providerFailure: {
          provider: record.provider, taskId, upstreamStatus: 'failed', checkedAt: now(),
          code: pollResp.diagnostics?.code, message: safeTaskError(pollResp.error || '上游未提供具体原因'),
        } })
        // 上游明确失败（如内容审核拦截）属终态：立即落库，不重试不等待超时
        const deliveryFailed = /video_transfer_failed/.test(pollResp.error || '')
        if (deliveryFailed) await db.update(schema.sysTask).set({ stage: 'transferring' }).where(eq(schema.sysTask.id, record.id))
        const rejected = type === 'image' && /policy|refusal|moderation|content_filter|safety|违反.*政策|审核|内容.*违规/i.test(pollResp.error || '')
        await failTask(record.id, rejected ? '模型平台拒绝了图片生成请求，请调整描述或参考素材' : pollResp.error || 'Generation failed',
          rejected ? 'generation_rejected' : deliveryFailed ? 'delivery_failed' : type === 'video' ? 'provider_task_failed' : 'generation_failed')
        return
      }
    } catch (err: any) {
      const exhausted = i === profile.attempts - 1
        || (profile.maxDurationMs != null && Date.now() - startedAt >= profile.maxDurationMs)
      if (exhausted) {
        await failTask(record.id, type === 'image' ? `查询模型平台任务结果超时：${taskErrorDetail(err)}`
          : '查询原视频任务超时，生成结果待核对；保留原任务ID，请核对平台后恢复查询，不要重复生成',
          type === 'image' ? 'generation_poll_timeout' : 'video_poll_timeout')
        return
      }
      logTaskWarn(label, 'poll-retry', { id: record.id, taskId, attempt: i + 1, error: err.message })
    }
  }
  await failTask(record.id, type === 'image' ? 'Timeout: polling attempts exhausted'
    : '查询原视频任务超时，生成结果待核对；保留原任务ID，请核对平台后恢复查询，不要重复生成',
    type === 'image' ? 'generation_poll_timeout' : 'video_poll_timeout')
}

type OutputReceipt = { index: number; local_path?: string; result_url?: string | null; error?: string }
function registerTaskMedia(record: SysTaskRecord, file: string | null | undefined) {
  if (!file) return
  if (!currentActor() && !db.$client.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='platform_users'").get()) return
  try {
    const project = resourceProject('task', record.id), actor = currentActor() || (project ? actorForProject(project) : null)
    if (actor) registerPrivateMedia(file, project, actor)
  } catch (error) { logTaskWarn(taskLabel(record.type as TaskType), 'media-owner-registration', { id: record.id, error: safeTaskError(error) }) }
}
function saveInlineVideo(record: SysTaskRecord, value: string, outputIndex = 1): string {
  const inline = /^data:(video\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(value)
  if (!inline) throw new Error('上游视频结果不是可识别的二进制视频')
  const bytes = Buffer.from(inline[2], 'base64')
  if (!bytes.length || bytes.length > 128 * 1024 * 1024 || bytes.toString('base64') !== inline[2]) throw new Error('上游视频二进制结果无效或超过128MB')
  const isWebm = inline[1] === 'video/webm'
  const header = isWebm ? bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) : bytes.subarray(4, 8).toString('ascii') === 'ftyp'
  if (!header) throw new Error('上游返回的视频内容不是有效容器，未把错误响应保存为视频')
  const localPath = `static/videos/task-${record.id}${outputIndex > 1 ? '-' + outputIndex : ''}.${isWebm ? 'webm' : 'mp4'}`
  const target = getAbsolutePath(localPath), temporary = target + '.part'
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(temporary, bytes); fs.renameSync(temporary, target)
  return localPath
}
async function handleMultipleOutputs(record: SysTaskRecord, urls: string[], kind: TaskType, duration?: number | null) {
  if (!urls.length || urls.length > 100 || urls.some(value => typeof value !== 'string' || !value)) throw new Error('上游多结果列表无效或超过100项；未静默截断')
  const field = kind === 'image' ? 'outputImages' : 'outputVideos', old = parseTaskParams(record.params)[field] || []
  const receipts: OutputReceipt[] = urls.map((value, index) => ({ index: index + 1,
    result_url: value.startsWith('data:') ? null : value,
    ...(old[index]?.local_path && fs.existsSync(getAbsolutePath(old[index].local_path)) ? { local_path: old[index].local_path } : {}) }))
  const persist = () => {
    const fresh = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, record.id)).get()!
    db.update(schema.sysTask).set({ params: JSON.stringify({ ...parseTaskParams(fresh.params), [field]: receipts }), updatedAt: now() }).where(eq(schema.sysTask.id, record.id)).run()
  }
  await db.update(schema.sysTask).set({ status: 'processing', stage: 'downloading', resultUrl: receipts[0].result_url, updatedAt: now() }).where(eq(schema.sysTask.id, record.id))
  persist()
  await Promise.allSettled(urls.map(async (value, index) => {
    try {
      if (!receipts[index].local_path) {
        const inline = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(value)
        receipts[index].local_path = kind === 'image'
          ? inline ? await saveBase64Image(inline[2], inline[1], 'images') : await downloadFile(value, 'images', { downloadKey: `${record.id}-output-${index + 1}` })
          : value.startsWith('data:') ? saveInlineVideo(record, value, index + 1) : await downloadVideo(value, record.id, { outputKey: index ? `${record.id}-${index + 1}` : String(record.id), headers: await videoContentHeaders(record, value) })
      }
      persist()
      registerTaskMedia(record, receipts[index].local_path)
      if (kind === 'image') registerTaskMedia(record, await generateImageThumb(receipts[index].local_path!))
    } catch (error) { receipts[index].error = safeTaskError(error); persist() }
  }))
  const failed = receipts.filter(receipt => !receipt.local_path || receipt.error)
  if (failed.length) {
    await failTask(record.id, `模型已返回${urls.length}个结果，其中${failed.length}个下载保存失败。已有结果已保留，可恢复原结果；不会重新生成。`, kind === 'image' ? 'image_delivery_failed' : 'delivery_failed')
    return
  }
  const primary = receipts[0].local_path!
  if (kind === 'image') await completeImageTask(record, primary)
  else {
    const latest = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, record.id)).get()!
    await handleVideoComplete({ ...latest, localPath: primary }, receipts[0].result_url || primary, duration)
  }
}

async function handleImageComplete(record:SysTaskRecord,imageUrl:string){return withRequestLogContext({...mediaRequestContext(record),phase:'download'},()=>handleImageCompleteInternal(record,imageUrl))}
async function handleImageCompleteInternal(record: SysTaskRecord, imageUrl: string) {
  const inline = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(imageUrl)
  if (inline) { await handleImageCompleteBase64(record, inline[2], inline[1]); return }
  // 先保存上游结果，交付失败时仅补下载，绝不重新提交付费生成请求。
  await db.update(schema.sysTask)
    .set({ resultUrl: imageUrl, stage: 'downloading', status: 'processing', errorCode: null, errorMsg: null, updatedAt: now() })
    .where(eq(schema.sysTask.id, record.id))
  try {
    const latest = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, record.id)).get()
    const params = parseTaskParams(latest?.params ?? record.params)
    let lastProgressWrite = 0
    let progress: { receivedBytes: number; totalBytes: number | null; attempt: number; updatedAt: string } | undefined
    const onProgress = (value: { receivedBytes: number; totalBytes: number | null; attempt: number }) => {
      progress = { ...value, updatedAt: now() }
      if (Date.now() - lastProgressWrite < 1_000) return
      lastProgressWrite = Date.now()
      db.update(schema.sysTask).set({ params: JSON.stringify({ ...params, downloadProgress: progress }),
        stage: 'downloading', updatedAt: progress.updatedAt }).where(eq(schema.sysTask.id, record.id)).run()
    }
    const localPath = record.localPath && fs.existsSync(getAbsolutePath(record.localPath))
      ? record.localPath : await downloadFile(imageUrl, 'images', { downloadKey: String(record.id), onProgress })
    await db.update(schema.sysTask).set({ localPath, stage: 'saving', updatedAt: now(),
      ...(progress ? { params: JSON.stringify({ ...params, downloadProgress: progress }) } : {}) }).where(eq(schema.sysTask.id, record.id))
    // 列表页缩略图失败不影响主流程。
    registerTaskMedia(record, localPath)
    registerTaskMedia(record, await generateImageThumb(localPath))
    await completeImageTask(record, localPath)
    logTaskSuccess('ImageTask', 'downloaded', { id: record.id, provider: record.provider, localPath })
  } catch (error) {
    await failTask(record.id, `图片已生成，但下载保存失败；可恢复原结果：${taskErrorDetail(error)}`, 'image_delivery_failed')
  }
}

async function handleImageCompleteBase64(record: SysTaskRecord, base64Data: string, mimeType: string) {
  const localPath = await saveBase64Image(base64Data, mimeType, 'images')
  registerTaskMedia(record, localPath)
  registerTaskMedia(record, await generateImageThumb(localPath))

  await completeImageTask(record, localPath)
  logTaskSuccess('ImageTask', 'saved-base64', { id: record.id, provider: record.provider, mimeType, localPath })
}

// 图片资产回写与任务完成原子提交，避免显示成功却未关联到业务资产。
async function completeImageTask(record: SysTaskRecord, localPath: string) {
  // Read fresh params so recording image dimensions never discards measured download progress.
  const latest = db.select({ params: schema.sysTask.params }).from(schema.sysTask).where(eq(schema.sysTask.id, record.id)).get()
  const params = parseTaskParams(latest?.params ?? record.params)
  // Record the old adopted image before replacing a pointer. Deleted assets
  // are skipped and deleted history tombstones are never resurrected.
  const history = await recordGeneratedAssetImage({ ...record, params: JSON.stringify(params) }, localPath, { adopt: false })
  if (params.sceneImageLayout === SCENE_IMAGE_LAYOUT) {
    try {
      const metadata = await sharp(getAbsolutePath(localPath)).metadata()
      if (metadata.width && metadata.height) {
        params.imageOutput = sceneImageOutput(metadata.width, metadata.height)
        if (!params.imageOutput.aspectRatioMatches) {
          logTaskWarn('ImageTask', 'scene-aspect-ratio-mismatch', { id: record.id, ...params.imageOutput })
        }
      }
    } catch (error) {
      logTaskWarn('ImageTask', 'image-dimensions-unavailable', { id: record.id, error: taskErrorDetail(error) })
    }
  }
  db.transaction(tx => {
    const adoptable = (kind: string, target: number) => history.versions.some(version => version.asset_type === kind && version.asset_id === target)
      && !!db.$client.prepare('SELECT 1 FROM asset_image_versions WHERE asset_type=? AND asset_id=? AND path=? AND deleted_at IS NULL').get(kind, target, localPath.replace(/^\//u, ''))
    const emptyCurrent = (table: 'characters'|'scenes'|'props', target: number) => {
      const row = db.$client.prepare(`SELECT image_url,local_path,deleted_at FROM ${table} WHERE id=?`).get(target) as {image_url:string|null;local_path:string|null;deleted_at:string|null}|undefined
      return !!row && !row.deleted_at && (!params.manualAssetImage || !(row.image_url?.trim() || row.local_path?.trim()))
    }
    const frameType = (value: unknown) => value === 'first_frame' || value === 'last_frame' ? value : 'composed'
    const hasNewerImage = (field: 'storyboardId' | 'characterId' | 'sceneId' | 'propId', target: number) => {
      const newer = tx.select({ params: schema.sysTask.params }).from(schema.sysTask).where(and(
        eq(schema.sysTask.type, 'image'), eq(schema.sysTask[field], target), gt(schema.sysTask.id, record.id),
      )).all()
      return newer.some(task => field !== 'storyboardId'
        || frameType(parseTaskParams(task.params).frameType) === frameType(params.frameType))
    }
    if (record.storyboardId && !hasNewerImage('storyboardId', record.storyboardId)) {
      const sbUpdate: Record<string, any> = { updatedAt: now() }
      if (params.frameType === 'first_frame') sbUpdate.firstFrameImage = localPath
      else if (params.frameType === 'last_frame') sbUpdate.lastFrameImage = localPath
      else sbUpdate.composedImage = localPath
      tx.update(schema.storyboards).set(sbUpdate).where(eq(schema.storyboards.id, record.storyboardId)).run()
    }
    if (record.characterId && adoptable('character',record.characterId) && emptyCurrent('characters',record.characterId) && !hasNewerImage('characterId', record.characterId)) {
      tx.update(schema.characters).set({ imageUrl: localPath, updatedAt: now() }).where(eq(schema.characters.id, record.characterId)).run()
    }
    if (record.sceneId && adoptable('scene',record.sceneId) && emptyCurrent('scenes',record.sceneId) && !hasNewerImage('sceneId', record.sceneId)) {
      tx.update(schema.scenes).set({ imageUrl: localPath, status: 'completed', updatedAt: now() }).where(eq(schema.scenes.id, record.sceneId)).run()
    }
    if (record.propId && adoptable('prop',record.propId) && emptyCurrent('props',record.propId) && !hasNewerImage('propId', record.propId)) {
      tx.update(schema.props).set({ imageUrl: localPath, updatedAt: now() }).where(eq(schema.props.id, record.propId)).run()
    }
    tx.update(schema.sysTask).set({ localPath, params: JSON.stringify(params), status: 'completed', stage: 'completed', errorCode: null,
      errorMsg: null, completedAt: now(), updatedAt: now() }).where(eq(schema.sysTask.id, record.id)).run()
  })
}

/** Restore a saved result or query the original asynchronous task; never create a new image. */
export async function recoverImageTask(id: number): Promise<void> {
  // 读取与获取进程锁保持同步，避免删除刚完成后使用旧快照继续入队。
  const record = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()
  if (!record || record.type !== 'image') throw new Error('图片任务不存在')
  if (activeTasks.has(id) || record.status === 'completed') return
  const outputs: OutputReceipt[] = parseTaskParams(record.params).outputImages || []
  const multiple = outputs.length > 1 && outputs.every(output => output.result_url || output.local_path && fs.existsSync(getAbsolutePath(output.local_path)))
  if (!multiple && !record.resultUrl && !record.taskId) throw new Error('未保存图片结果地址或上游任务编号，请先核对模型平台记录，勿重复生成')
  if (['generation_failed', 'provider_task_failed'].includes(record.errorCode || '')) throw new Error('上游已确认图片生成失败，无法恢复原任务')
  activeTasks.add(id)
  try {
    const config = record.resultUrl || multiple ? null : await recoveryConfig(record)
    await db.update(schema.sysTask).set({ status: 'processing', stage: record.resultUrl || multiple ? 'downloading' : 'polling', errorMsg: null,
      errorCode: null, updatedAt: now() }).where(eq(schema.sysTask.id, id))
    void (multiple ? handleMultipleOutputs(record, outputs.map(output => output.result_url || output.local_path!), 'image') : record.resultUrl ? handleImageComplete(record, record.resultUrl) : pollTask(record, config!, record.taskId!))
      .catch(error => failTask(id, taskErrorDetail(error), record.resultUrl ? 'image_delivery_failed' : 'image_recovery_failed'))
      .finally(() => { activeTasks.delete(id); try { syncMediaActivity(id) } catch {} })
  } catch (error) {
    activeTasks.delete(id)
    throw error
  }
}

async function handleVideoComplete(record:SysTaskRecord,videoUrl:string,duration:number|null|undefined):Promise<void>{return withRequestLogContext({...mediaRequestContext(record),phase:'download'},()=>handleVideoCompleteInternal(record,videoUrl,duration))}
async function handleVideoCompleteInternal(record: SysTaskRecord, videoUrl: string, duration: number | null | undefined):Promise<void> {
  const inline = /^data:(video\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(videoUrl)
  if (inline) {
    const localPath = saveInlineVideo(record, videoUrl)
    await db.update(schema.sysTask).set({ localPath, resultUrl: localPath, updatedAt: now() }).where(eq(schema.sysTask.id, record.id))
    return handleVideoComplete({ ...record, localPath }, localPath, duration)
  }
  // 先落库地址与实际时长；后续下载失败仍可恢复，且不重新提交生成。
  const latest = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, record.id)).get()
  const params = { ...parseTaskParams(latest?.params ?? record.params), resultDuration: duration }
  await db.update(schema.sysTask).set({ resultUrl: videoUrl, params: JSON.stringify(params),
    stage: 'downloading', status: 'processing', errorCode: null, errorMsg: null, updatedAt: now() })
    .where(eq(schema.sysTask.id, record.id))
  try {
    const localPath = record.localPath && fs.existsSync(getAbsolutePath(record.localPath))
      ? record.localPath : await downloadVideo(videoUrl, record.id, { headers: await videoContentHeaders(record, videoUrl) })
    await db.update(schema.sysTask).set({ localPath, stage: 'saving', updatedAt: now() }).where(eq(schema.sysTask.id, record.id))
    registerTaskMedia(record, localPath)
    registerTaskMedia(record, await extractVideoPoster(localPath))
    // 完成状态与业务回写原子提交；恢复旧任务不能覆盖用户后来生成的视频。
    db.transaction(tx => {
      const newer = record.storyboardId ? tx.select({ id: schema.sysTask.id }).from(schema.sysTask)
        .where(and(eq(schema.sysTask.storyboardId, record.storyboardId), eq(schema.sysTask.type, 'video'), gt(schema.sysTask.id, record.id))).get() : null
      if (record.storyboardId && !newer) tx.update(schema.storyboards)
        .set({ videoUrl: localPath, duration: duration || undefined, updatedAt: now() })
        .where(eq(schema.storyboards.id, record.storyboardId)).run()
      tx.update(schema.sysTask).set({ localPath, status: 'completed', stage: 'completed', errorCode: null,
        errorMsg: null, completedAt: now(), updatedAt: now() }).where(eq(schema.sysTask.id, record.id)).run()
    })
  } catch (error) {
    await failTask(record.id, safeTaskError(error), 'delivery_failed')
  }
}

// Round 3 (item 9): a finished Jimeng task saves its video through the same delivery path (and storyboard write-back).
setJimengVideoDelivery(async (id, contentUrl) => {
  const record = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()
  if (!record) return
  await handleVideoComplete(record, contentUrl, parseTaskParams(record.params).resultDuration)
})

/** Only the original service's exact task content endpoint may receive its credential. */
async function videoContentHeaders(record: SysTaskRecord, videoUrl: string): Promise<Record<string, string> | undefined> {
  // Round 3 (item 9): the local Jimeng service's own content endpoint for this exact task gets that service's key.
  // Round 5: so does the canvas library content endpoint of this task's own accepted job (回传 via the canvas).
  if (record.provider === 'jimeng_local' && record.taskId && record.configBaseUrl) {
    const config = await recoveryConfig(record)
    const canvasVideoId = parseTaskParams(record.params).jimengCanvasVideoId
    const allowed = [buildJimengContentRequest(config, record.taskId).url, ...(isJimengCanvasVideoId(canvasVideoId) ? [buildJimengCanvasContentRequest(config, canvasVideoId).url] : [])].map(url => new URL(url))
    const target = new URL(videoUrl)
    if (!target.username && !target.password && allowed.some(expected => target.origin === expected.origin && target.pathname === expected.pathname)) return jimengHeaders(config)
    return undefined
  }
  if (record.provider !== '888api' || !record.taskId || !record.configBaseUrl) return undefined
  const target = new URL(videoUrl)
  const original = new URL(record.configBaseUrl)
  if (target.origin !== original.origin) return undefined
  const config = await recoveryConfig(record)
  const query = new URL((await getVideoAdapter('888api').buildPollRequest(config, record.taskId)).url)
  if (target.origin !== query.origin || target.pathname !== `${query.pathname}/content` || target.username || target.password) return undefined
  return { Authorization: `Bearer ${config.apiKey}` }
}

async function recoveryConfig(record: SysTaskRecord): Promise<AIConfig> {
  if (record.configId) {
    const stored = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, record.configId)).get()
    const config = await getConfigById(record.configId)
    if (stored && config && stored.baseUrl === record.configBaseUrl && config.provider === record.provider && config.baseUrl === record.configBaseUrl) {
      assertConfigService(config, record.type as TaskType)
      return config.provider === 'jimeng_local' ? restoreJimengProjectConfig(config, parseTaskParams(record.params).jimengProjectRoute, record.dramaId || (record.storyboardId ? resourceProject('storyboard', record.storyboardId) || undefined : undefined)) : config
    }
    throw new Error('原视频服务配置已删除、停用或地址变更，请恢复原配置')
  }
  // 旧任务只在同厂商唯一配置时恢复，绝不任意换服务商查询。
  const rows = (await db.select().from(schema.aiServiceConfigs)).filter(c => c.isActive && c.serviceType === 'video' && c.provider === record.provider)
  if (rows.length === 1) {
    const config = await getConfigById(rows[0].id)
    if (config) return config
  }
  throw new Error('历史任务无法确定原服务配置，请先核对配置')
}

/** Cancel only a saved upstream task through its declared protocol operation. */
export async function cancelGenerationTask(id: number) {
  const record = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()
  if (!record) throw new Error('生成任务不存在')
  if (record.status !== 'processing') throw new Error('任务已结束，无需重复取消')
  if (!record.taskId || ['downloading', 'saving'].includes(record.stage || '')) throw new Error('当前阶段不能取消上游任务；已生成结果会继续保存')
  const config = await recoveryConfig(record), params = parseTaskParams(record.params), snapshot = params.protocolSnapshot
  if (params.cancelRequestedAt) return
  if (cancellingTasks.has(id)) throw new Error('取消请求正在提交，请等待原任务状态更新')
  cancellingTasks.add(id)
  try {
  const original = { ...config, ...snapshot, model: record.model || config.model }
  if (original.provider !== 'yingce' || !original.protocolDefinition) throw new Error('此通道未声明可验证的取消接口，未猜测或发送取消请求')
  const info = await compileProvider(original.protocolDefinition)
  if (!info.cancelAvailable) throw new Error('所选协议没有可执行的取消接口')
  const outcome: any = await cancelProvider({ providerDefinition: original.protocolDefinition,
    connection: { baseUrl: original.baseUrl, apiKey: original.apiKey, authFields: original.authFields, headers: original.headers },
    request: params.providerRequestSnapshot || { capability: record.type as TaskType, model: original.model, prompt: record.prompt || '' }, taskId: record.taskId, model: original.model })
  await mergeTaskDiagnostics(id, { cancelRequestedAt: now() })
  await db.update(schema.sysTask).set(outcome.confirmed === true
    ? { status: 'cancelled', stage: 'cancelled', errorCode: 'user_cancelled', errorMsg: '上游已确认原任务取消；不会重新生成。', updatedAt: now() }
    : { stage: 'cancelling', updatedAt: now() }).where(eq(schema.sysTask.id, id))
  try { syncMediaActivity(id) } catch {}
  } finally { cancellingTasks.delete(id) }
}

export async function recoverVideoTask(id: number): Promise<void> {
  const [record] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
  if (!record || record.type !== 'video') throw new Error('视频任务不存在')
  if (activeTasks.has(id)) return
  // Round 3 (item 9): a Jimeng video that finished in the local service but was never saved here (manual delivery
  // before this change, or an automatic fetch that failed) is fetched now. Never resubmits generation.
  if (record.status === 'completed' && record.provider === 'jimeng_local' && record.stage === 'ready_in_local_service' && record.taskId
    && !(record.localPath && fs.existsSync(getAbsolutePath(record.localPath)))) {
    activeTasks.add(id)
    try {
      const config = await recoveryConfig(record)
      await db.update(schema.sysTask).set({ status: 'processing', stage: 'downloading', errorCode: null, errorMsg: null, updatedAt: now() }).where(eq(schema.sysTask.id, id))
      void deliverJimengVideo(id, config, record.taskId)
        .catch(async error => {
          await db.update(schema.sysTask).set({ status: 'completed', stage: 'ready_in_local_service', errorCode: 'auto_delivery_failed',
            errorMsg: safeTaskError(error), updatedAt: now() }).where(eq(schema.sysTask.id, id))
        })
        .finally(() => { activeTasks.delete(id); try { syncMediaActivity(id) } catch {} })
      return
    } catch (error) { activeTasks.delete(id); throw error }
  }
  if (record.status === 'completed') return
  const savedOutputs: OutputReceipt[] = parseTaskParams(record.params).outputVideos || []
  const multiple = savedOutputs.length > 1 && savedOutputs.every(output => output.result_url || output.local_path && fs.existsSync(getAbsolutePath(output.local_path)))
  if (record.provider === 'jimeng_local') {
    if (['generation_failed','provider_task_failed'].includes(record.errorCode || '')) throw new Error('即梦已确认生成失败，不能恢复生成；重新生成需手动确认。')
    activeTasks.add(id)
    try {
      const config = await recoveryConfig(record)
      await db.update(schema.sysTask).set({status:'processing',stage:'polling',errorCode:null,errorMsg:null,updatedAt:now()}).where(eq(schema.sysTask.id,id))
      void withRequestLogContext({...mediaRequestContext(record,config),phase:'poll'},()=>runJimengTask(id,config,true)).catch(error => failTask(id,safeTaskError(error),'recovery_failed')).finally(() => activeTasks.delete(id))
      return
    } catch (error) { activeTasks.delete(id);throw error }
  }
  if (!multiple && !record.resultUrl && !record.taskId) throw new Error('未保存上游任务编号，请先核对上游记录，勿重复生成')
  if (['generation_failed', 'provider_task_failed'].includes(record.errorCode || '')) throw new Error('上游已确认生成失败，无法恢复原任务')
  // 在任何异步配置读取前获取锁，重复点击不会启动多个下载。
  activeTasks.add(id)
  try {
    const config = !multiple && record.taskId && !record.resultUrl ? await recoveryConfig(record) : null
    await db.update(schema.sysTask).set({ status: 'processing', errorMsg: null, errorCode: null,
      stage: record.resultUrl ? 'downloading' : record.stage === 'transferring' || record.errorCode === 'delivery_failed' ? 'transferring' : 'polling', updatedAt: now() }).where(eq(schema.sysTask.id, id))
    void (async () => {
      if (multiple) { await handleMultipleOutputs(record, savedOutputs.map(output => output.result_url || output.local_path!), 'video', parseTaskParams(record.params).resultDuration); return }
      if (record.resultUrl) {
        await handleVideoComplete(record, record.resultUrl, parseTaskParams(record.params).resultDuration)
        const [fresh] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
        if (fresh?.status !== 'failed' || !record.taskId) return
        // 签名链接可能过期：重新查询原任务拿新地址。
      }
      const originalConfig = config ?? await recoveryConfig(record)
      // Firemux 的交付恢复是独立接口；只在其明确返回交付失败时调用。
      if (record.provider === 'minimax' && (record.errorCode === 'delivery_failed' || record.stage === 'transferring') && !record.resultUrl) {
        const req = await getVideoAdapter('minimax').buildPollRequest(originalConfig, record.taskId!)
        const resp = await fetchProvider(`${req.url}/recover`, { method: 'POST', headers: req.headers, signal: AbortSignal.timeout(30_000) })
        if (!resp.ok) throw new Error(`Video delivery recovery HTTP ${resp.status}`)
      }
      await markPolling(id, record.taskId!)
      await pollTask(record, originalConfig, record.taskId!)
    })().catch(error => failTask(id, safeTaskError(error), 'recovery_failed')).finally(() => activeTasks.delete(id))
  } catch (error) {
    activeTasks.delete(id)
    throw error
  }
}

export async function resumeInterruptedTasks() {
  const tasks = await db.select().from(schema.sysTask).where(eq(schema.sysTask.status, 'processing')).orderBy(desc(schema.sysTask.id))
  for (const task of tasks) {
    if (task.type === 'image' && (task.resultUrl || task.taskId)) {
      try { await recoverImageTask(task.id) } catch (error) { await failTask(task.id, taskErrorDetail(error), 'image_delivery_failed') }
    } else if (task.type === 'image' && task.stage === 'queued') {
      await failTask(task.id, '服务重启，排队中的图片尚未提交模型平台，请重新发起任务', 'queue_interrupted')
    } else if (task.type === 'video' && (task.taskId || task.resultUrl || task.provider === 'jimeng_local')) {
      try { await recoverVideoTask(task.id) } catch (error) { await failTask(task.id, safeTaskError(error), 'recovery_failed') }
    } else {
      await failTask(task.id, '服务中断，提交结果待确认，请先核对模型平台记录，勿重复生成', 'submission_unknown')
    }
  }
}

// ─── Round 5: 回传视频 (Jimeng tasks handed off to Jimeng) ─────────────────
const jimengReturnDependencies = { resolveConfig: (row: SysTaskRecord) => recoveryConfig(row) }
/** Manual 回传 for some tasks; deliveries continue in the background and never submit a generation. */
export function returnJimengTasks(ids: number[], options: { wait?: boolean } = {}) {
  return returnJimengVideos(ids, { ...jimengReturnDependencies, ...options })
}
/** Manual 回传 for one episode: the newest video task of each shot, when it is handed off. */
export function returnJimengEpisode(episodeId: number, options: { wait?: boolean } = {}) {
  return returnJimengTasks(handedOffTasksOfEpisode(episodeId), options)
}
/** Automatic 回传 (default every 10 minutes; HUOBAO_JIMENG_AUTO_RETURN_MINUTES=0 turns it off). */
export function startJimengAutoReturnSweep() { startJimengAutoReturn(jimengReturnDependencies) }

// ─── 参考素材归一化 ───────────────────────────────────────────────

async function normalizeReferenceImages(refs: string[] | null | undefined, strict = false): Promise<string[]> {
  if (!Array.isArray(refs) || !refs.length) return []

  const deduped = strict ? refs.map(value => String(value || '').trim()) : Array.from(
    new Set(
      refs
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  )

  const normalized = await Promise.all(deduped.map(async (value) => {
    if (value.startsWith('data:image/')) return value
    if (value.startsWith('static/') || value.startsWith('/static/')) {
      const localPath = value.startsWith('/static/') ? value.slice(1) : value
      try {
        return await readImageAsCompressedDataUrl(localPath, {
          maxWidth: 768,
          maxHeight: 768,
          quality: 68,
        })
      } catch (err) {
        if (strict) throw new Error(`参考图片读取失败：${taskErrorDetail(err)}`)
        logTaskWarn('ImageTask', 'reference-read-failed', { path: localPath, error: (err as Error).message })
        return null
      }
    }
    // 远程 URL：下载压缩为 data URL，保证 multipart 上传（OpenAI edits）/ inline_data（Gemini）都可用
    if (/^https?:\/\//.test(value)) {
      try {
        return await fetchImageAsCompressedDataUrl(value, {
          maxWidth: 768,
          maxHeight: 768,
          quality: 68,
        })
      } catch (err) {
        if (strict) throw new Error(`参考图片获取失败：${taskErrorDetail(err)}`)
        logTaskWarn('ImageTask', 'reference-fetch-failed', { url: value, error: (err as Error).message })
        return null
      }
    }
    if (strict && !value) throw new Error('参考图片不能为空')
    return value
  }))

  const available = normalized.filter((item): item is string => !!item)
  return strict ? available : available.slice(0, 6)
}

async function normalizeVideoReferenceUrl(value: string | null | undefined, strict = false): Promise<string | null> {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.startsWith('data:image/')) return raw
  if (raw.startsWith('static/') || raw.startsWith('/static/')) {
    const localPath = raw.startsWith('/static/') ? raw.slice(1) : raw
    try {
      if (strict && !path.resolve(getAbsolutePath(localPath)).startsWith(path.resolve(getAbsolutePath('static/')) + path.sep)) {
        throw new Error('参考图片路径必须位于本机素材目录内')
      }
      // 视频参考图直接编码原文件，保留原始尺寸、格式、透明通道和画质。
      return readImageAsDataUrl(localPath)
    } catch (err) {
      if (strict) throw new Error(`参考图片读取失败，请重新上传或选择有效图片：${safeTaskError(err)}`)
      logTaskWarn('VideoTask', 'reference-read-failed', { path: localPath, error: (err as Error).message })
      return null
    }
  }
  return raw
}

async function normalizeVideoReferenceUrls(refs: string[] | null | undefined, strict = false): Promise<string[]> {
  if (!Array.isArray(refs) || !refs.length) return []
  const values = refs.map(item => String(item || '').trim())
  if (strict && values.some(item => !item)) throw new Error('888API 参考图片不能为空，请检查素材列表')
  // Numbered multipart references must keep every original position, including duplicates.
  const ordered = strict ? values : Array.from(new Set(values.filter(Boolean)))
  const normalized = await Promise.all(
    ordered.map(item => normalizeVideoReferenceUrl(item, strict)),
  )
  return normalized.filter((item): item is string => !!item)
}

/**
 * 将参考视频/音频解析为 Seedance API 可访问的 URL。
 * http(s)/dataURL 直通；本地 static 路径需要 PUBLIC_BASE_URL 拼成公网地址，
 * 未配置时抛出可操作的中文错误（落入 catch 写入 error_msg 供前端展示）。
 */
function resolvePublicMediaUrl(value: string | null | undefined, kind: 'video' | 'audio' | 'file'): string | null {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:')) return signedProviderMediaUrl(raw)
  if (raw.startsWith('static/') || raw.startsWith('/static/')) {
    const base = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '')
    if (!base) {
      const label = kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '文件'
      throw new Error(
        `参考${label}为本地路径 ${raw}，但后端未配置 PUBLIC_BASE_URL，上游视频生成 API 无法访问内网地址。` +
        `请在 backend/.env 配置 PUBLIC_BASE_URL（如 https://your-domain.com）后重试，或改用公网 URL。`,
      )
    }
    const p = raw.startsWith('/') ? raw : `/${raw}`
    return signedProviderMediaUrl(`${base}${p}`)
  }
  return raw
}

function resolvePublicMediaUrls(refs: string[] | null | undefined, kind: 'video' | 'audio'): string[] {
  if (!Array.isArray(refs) || !refs.length) return []
  const items = Array.from(new Set(refs.map((item) => String(item || '').trim()).filter(Boolean)))
  return items.map((item) => resolvePublicMediaUrl(item, kind)).filter((item): item is string => !!item)
}

function normalizeStoredVideoResolution(resolution: string | null | undefined): string | undefined {
  const value = String(resolution || '').trim().toLowerCase()
  if (value === '480p' || value === '720p' || value === '1080p') return value
  if (value === '2k') return '2K'
  return undefined
}
