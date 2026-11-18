/** Explicit contract with the independently deployed local Jimeng executor.
 * This adapter never calls Jimeng directly and never discovers account cookies. */
import { createHash } from 'node:crypto'
import { safeTaskError as safeText } from '../video-download.js'
import { splitQuotedText } from '../../utils/quoted-text.js'
import type { AIConfig, ProviderRequest, VideoGenerationRecord, VideoGenResponse, VideoPollResponse, VideoProviderAdapter } from './types.js'

export const JIMENG_LOCAL_MODEL = 'jimeng-2.0-fast'
export const JIMENG_LOCAL_BASE = ''
export const JIMENG_IMAGE_LIMIT = 9
export const JIMENG_PROMPT_BYTES = 100_000
export interface JimengImage { id: string; name: string; sha256: string; mime_type: string; data_base64: string }
export interface JimengBinding { token: string; reference_id: string }
export interface JimengPreparedRecord extends VideoGenerationRecord { jimengImages?: JimengImage[]; metadata?: { storyboard_id?: number; drama_id?: number; episode_number?: number; storyboard_number?: number } }
export const jimengError = (message: string, errorCode = 'invalid_parameter') => Object.assign(new Error(message), { statusCode: 400, errorCode })
export const promptHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

const JIMENG_UPSTREAM_FAILURES: Record<string,string> = {
  input_image_rejected: '参考图片未通过即梦审核，请修改参考图后手动重试。',
  input_text_rejected: '视频提示词未通过即梦审核，请检查提示词。',
  content_policy_violation: '即梦内容审核未通过，请检查提示词和参考素材。',
  upstream_busy: '即梦平台繁忙，本次视频任务已失败。',
  upstream_failed: '即梦平台已确认本次视频生成失败。',
}
export function isJimengTerminalFailure(code: unknown): boolean {
  return typeof code === 'string' && Object.hasOwn(JIMENG_UPSTREAM_FAILURES, code)
}

/** Only public, bounded failure text is carried back to the workbench. */
export function safeJimengFailureReason(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const clean = safeText(value.slice(0, 8000))
    .replace(/(?:^|\b)["']?(?:set-cookie|cookie)["']?\s*[:=][^\r\n]*/giu, '[登录信息已隐藏]')
    .replace(/(["']?(?:sessionid(?:_ss)?|sid_tt|sid_guard|uifid|passport_csrf_token|csrf_token|token|secret|key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;<>]+)/giu, '$1[已隐藏]')
    .replace(/https?:\/\/[^\s"'<>]+/giu, '[链接已隐藏]')
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!clean) return fallback
  let bounded = ''
  for (const char of clean) { if (bounded.length + char.length > 500) break; bounded += char }
  return bounded
}

export function normalizeJimengBaseUrl(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw jimengError('请填写完整的即梦本地服务 HTTP(S) 地址。', 'invalid_base_url') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/', '/v1', '/v1/', '/jimeng', '/jimeng/', '/jimeng/v1', '/jimeng/v1/'].includes(url.pathname)) throw jimengError('即梦本地服务地址只能填写服务根地址或 /v1，不能含登录信息或查询参数。', 'invalid_base_url')
  return url.origin + (url.pathname.startsWith('/jimeng') ? '/jimeng' : '')
}
export function jimengHeaders(config: AIConfig, json = false): Record<string,string> {
  if (config.provider !== 'jimeng_local') throw jimengError('即梦任务必须使用即梦本地服务配置。', 'provider_mismatch')
  if (typeof config.apiKey !== 'string' || !config.apiKey.trim() || /[\s\x00]/u.test(config.apiKey) || config.apiKey.length > 8192) throw jimengError('请填写即梦本地服务的访问 Key。', 'missing_key')
  return { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json', ...(json ? {'Content-Type':'application/json; charset=utf-8'} : {}) }
}
function list(raw: unknown, label: string): string[] {
  if (raw == null) return []
  let value = raw
  if (typeof raw === 'string') { try { value = JSON.parse(raw) } catch { throw jimengError(`${label}列表格式不正确。`, 'invalid_reference') } }
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item || /[\x00]/u.test(item))) throw jimengError(`${label}列表格式不正确。`, 'invalid_reference')
  return value
}
// Match the existing editor/forwarder grammar: longest bound asset name,
// followed by narration. Only an unbound explicit variant suffix is blocked.
const boundary = (suffix: string) => !/^[_·•｜|]/u.test(suffix)
const numberedSeparator = (suffix: string) => !/^[\p{L}\p{N}_·•｜|]/u.test(suffix)

/** Resolve explicit bound names, longest-first, without rewriting narration. */
export function buildJimengBindings(prompt: string, names: string[]): JimengBinding[] {
  const out = new Map<string,string>()
  // Dialogue is literal script content, not an instruction to bind a picture.
  // Preserve UTF-16 offsets for emoji while hiding only quoted spans from parsing.
  const bindingText = splitQuotedText(prompt).map(part => part.quoted ? ' '.repeat(part.text.length) : part.text).join('')
  for (const match of bindingText.matchAll(/[@＠]/gu)) {
    const index = match.index!
    if (index && /[A-Za-z0-9._%+-]/u.test(bindingText[index-1])) continue // e-mail, not an asset reference
    const after = bindingText.slice(index + 1)
    const numbered = /^(?:参考图|图片|图)(\d+)/u.exec(after)
    let chosen: number, text: string
    if (numbered) {
      chosen = Number(numbered[1]) - 1
      if (chosen < 0 || chosen >= names.length) throw jimengError(`@${numbered[0]}没有对应的参考图片。`, 'missing_reference')
      const suffix = after.slice(numbered[0].length), name = names[chosen]
      if (suffix.startsWith(name) && boundary(suffix.slice(name.length))) text = numbered[0] + name
      else if (numberedSeparator(suffix)) text = numbered[0]
      else throw jimengError(`@${numbered[0]}后面的名称与实际绑定图片不一致。`, 'reference_mismatch')
    } else {
      const candidates = names.map((name,i)=>({name,i})).filter(item=>after.startsWith(item.name) && boundary(after.slice(item.name.length)))
      const longest = Math.max(0, ...candidates.map(item=>item.name.length))
      const matches = candidates.filter(item=>item.name.length===longest)
      if (matches.length !== 1) throw jimengError(`@${after.split(/[@＠\s、,，;；:：。！？!?]/u)[0].slice(0,80)}${matches.length ? '存在同名图片，需使用明确的图片编号。' : '没有唯一对应的参考图，请检查名称和分镜绑定。'}`, matches.length ? 'ambiguous_reference' : 'missing_reference')
      chosen = matches[0].i; text = matches[0].name
    }
    const token = prompt[index] + text, reference = `image_${chosen+1}`
    if (out.has(token) && out.get(token) !== reference) throw jimengError('同一 @ 标记对应多张不同图片。', 'ambiguous_reference')
    out.set(token, reference)
  }
  return [...out].map(([token,reference_id])=>({token,reference_id}))
}

export function validateJimengVideoRecord(record: VideoGenerationRecord, fallbackModel = '') {
  if ((record.model ?? fallbackModel) !== JIMENG_LOCAL_MODEL) throw jimengError('即梦本地协议当前已适配 jimeng-2.0-fast。', 'unsupported_model')
  if (typeof record.prompt !== 'string' || !record.prompt.trim() || record.prompt.includes('\x00')) throw jimengError('即梦视频提示词不能为空或包含空字符。', 'empty_prompt')
  if ([...record.prompt].some(char=>char.length===1&&char.charCodeAt(0)>=0xd800&&char.charCodeAt(0)<=0xdfff)) throw jimengError('提示词包含不完整的Unicode字符，未替换或提交。','invalid_prompt')
  if (Buffer.byteLength(record.prompt,'utf8') > JIMENG_PROMPT_BYTES) throw jimengError('即梦本地提示词超过100KB保护上限，未截断或提交。', 'prompt_too_large')
  if (record.imageUrl || record.firstFrameUrl || record.lastFrameUrl || list(record.referenceVideoUrls,'参考视频').length || list(record.referenceAudioUrls,'参考音频').length || record.referenceFileUrl || record.referenceLinkUrl) throw jimengError('即梦本地协议当前接入文字与参考图片；首尾帧、视频和音频参考尚未适配。', 'unsupported_reference')
  if (record.resolution != null || record.generateAudio != null || record.seed != null || record.promptExtend != null || record.watermark != null ) throw jimengError('即梦原生画布未核实这些结构化参数，请只设置时长、画幅和参考图。', 'unsupported_parameter')
  const images = list(record.referenceImageUrls,'参考图片'), rawNames = list(record.referenceImageNames,'参考图片名称')
  if (images.length > JIMENG_IMAGE_LIMIT) throw jimengError(`即梦本地服务最多${JIMENG_IMAGE_LIMIT}张参考图，未截断。`, 'reference_count')
  if (rawNames.length && rawNames.length !== images.length) throw jimengError('参考图片与名称数量不一致。', 'invalid_reference')
  const names = images.map((_image,index)=>rawNames[index] || `参考图片${index+1}`)
  if (names.some(name=>[...name].length > 150 || /[\r\n@＠\x00-\x1f]/u.test(name))) throw jimengError('参考图片名称超过150字符或包含引用标记、控制字符。', 'invalid_reference')
  const mode = images.length ? 'reference' : 'text_to_video'
  if (record.referenceMode != null && record.referenceMode !== mode) throw jimengError('生成模式与实际参考图片不一致。', 'invalid_mode')
  const duration = record.duration ?? 15, ratio = record.aspectRatio ?? '16:9'
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 15) throw jimengError('即梦本地服务时长请选择1–15秒整数。', 'invalid_duration')
  if (!['16:9','9:16','1:1'].includes(ratio)) throw jimengError('即梦本地服务当前支持16:9、9:16、1:1画幅。', 'invalid_ratio')
  return { prompt: record.prompt, images, names, duration, aspectRatio: ratio, mode, bindings: buildJimengBindings(record.prompt,names) }
}
function taskId(value: unknown): string {
  if (typeof value !== 'string' || !/^jm_[A-Za-z0-9_-]{8,100}$/u.test(value)) throw jimengError('即梦本地服务未返回有效任务编号。', 'invalid_task_id')
  return value
}
export function buildJimengContentRequest(config: AIConfig, id: string): ProviderRequest {
  return {url:`${normalizeJimengBaseUrl(config.baseUrl)}/v1/videos/${encodeURIComponent(taskId(id))}/content`,method:'GET',headers:jimengHeaders(config),body:undefined}
}
export function buildJimengLookupRequest(config:AIConfig,key:string):ProviderRequest {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(key))throw jimengError('原任务没有有效的持久请求编号。','missing_idempotency_key')
  return {url:`${normalizeJimengBaseUrl(config.baseUrl)}/v1/videos/by-request/${key}`,method:'GET',headers:jimengHeaders(config),body:undefined}
}
export class JimengLocalVideoAdapter implements VideoProviderAdapter {
  provider = 'jimeng_local'
  buildGenerateRequest(config: AIConfig, record: JimengPreparedRecord): ProviderRequest {
    const normalized = validateJimengVideoRecord(record, config.model), images = record.jimengImages || []
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(record.idempotencyKey || '')) throw jimengError('本地即梦任务缺少持久保存的请求编号。', 'missing_idempotency_key')
    if (images.length !== normalized.images.length || images.some((image,i)=>image.id !== `image_${i+1}` || image.name !== normalized.names[i] || !/^[a-f0-9]{64}$/u.test(image.sha256) || createHash('sha256').update(Buffer.from(image.data_base64,'base64')).digest('hex') !== image.sha256)) throw jimengError('参考图未完成原始字节快照校验。', 'reference_mismatch')
    return {url:`${normalizeJimengBaseUrl(config.baseUrl)}/v1/videos`,method:'POST',headers:jimengHeaders(config,true),body:{client_request_id:record.idempotencyKey,model:JIMENG_LOCAL_MODEL,prompt:normalized.prompt,prompt_sha256:promptHash(normalized.prompt),duration:normalized.duration,aspect_ratio:normalized.aspectRatio,images,bindings:normalized.bindings,metadata:record.metadata || {},...(config.executionRouteId ? {route_id:config.executionRouteId} : {})}}
  }
  parseGenerateResponse(raw: any): VideoGenResponse { return {isAsync:true,taskId:taskId(raw?.id)} }
  buildPollRequest(config: AIConfig, id: string): ProviderRequest {return {url:`${normalizeJimengBaseUrl(config.baseUrl)}/v1/videos/${encodeURIComponent(taskId(id))}`,method:'GET',headers:jimengHeaders(config),body:undefined}}
  parsePollResponse(raw: any, expectedTaskId?: string): VideoPollResponse {
    const id=taskId(raw?.id)
    if (expectedTaskId && id !== taskId(expectedTaskId)) throw jimengError('即梦服务返回了其它任务，未替换原编号。','task_id_mismatch')
    if (!/^[a-f0-9]{64}$/u.test(raw?.prompt_sha256 || '') || !Number.isSafeInteger(raw?.reference_count) || raw.reference_count < 0 || raw.reference_count > JIMENG_IMAGE_LIMIT) throw jimengError('即梦任务缺少正文和参考图完整性回执。','invalid_response')
    const stages = new Set(['queued','preparing','uploading_references','submitting','submitted_to_jimeng','submission_unknown','generating','polling','downloading','completed','failed','waiting_account','waiting_canvas','result_unavailable','waiting_capacity','waiting_owner','waiting_paused','waiting_route','waiting_review','dispatching'])
    const aliases:Record<string,string>={uploading:'uploading_references',prepared:'preparing',awaiting_result:'generating',login_required:'waiting_account',query_interrupted:'upstream_status_pending',upstream_failed:'failed',preparation_failed:'failed',cancelled:'failed',delivery_failed:'failed'}
    const rawStage=aliases[raw.stage]||raw.stage
    const stage = stages.has(rawStage) ? rawStage : 'upstream_status_pending'
    if (raw.status === 'completed') {
      if (raw.delivery_mode !== 'local_manual' || raw.download_ready !== true) throw jimengError('即梦服务尚未返回可手动下载的原任务就绪回执。','invalid_response')
      return {status:'completed',stage:'ready_in_local_service',upstreamStatus:'ready_for_download',manualDelivery:true}
    }
    if (raw.status === 'failed') {
      if (isJimengTerminalFailure(raw.error_code)) {
        return {status:'failed',stage:'failed',upstreamStatus:raw.error_code,errorCode:'generation_failed',
          error:safeJimengFailureReason(raw.error,JIMENG_UPSTREAM_FAILURES[raw.error_code])}
      }
      const errors:Record<string,string>={delivery_failed:'即梦视频已提交，但下载未完成；可恢复原任务下载。',account_not_ready:'即梦原账号尚未就绪，请在即梦服务端登录并检查画布。',login_required:'即梦账号登录已失效，请重新登录原账号。',preparation_failed:'即梦提交前准备失败，请在服务端检查账号、画布和参考图。',cancelled:'本地排队任务已取消，未提交即梦。',submission_unknown:'即梦提交结果待核查，原任务已保留，未自动重新生成。'}
      const code=Object.hasOwn(errors,raw.error_code)?raw.error_code:'generation_failed'
      return {status:'failed',stage:'failed',upstreamStatus:stage,errorCode:code,error:errors[code]||'即梦上游任务未完成；请在本地服务核对原任务记录。'}
    }
    if (!['queued','processing'].includes(raw.status)) throw jimengError('即梦本地任务状态无效。','invalid_response')
    return {status:raw.status === 'queued' ? 'pending' : 'processing',stage:stage as VideoPollResponse['stage'],upstreamStatus:stage}
  }
  extractVideoUrl(_raw: any): string | null {return null}
}
