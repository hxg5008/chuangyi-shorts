import { applyProtocolAuth } from '../provider-runtime/auth.js'
import { boundedResponseBytes, inferMediaMime, mediaBytes } from '../provider-runtime/media.js'
import type { GenerationRequest, MediaReference, ProviderConnection } from '../provider-runtime/types.js'
import { withRequestLogContext } from '../request-logs/context.js'
import { fetchProvider } from '../../utils/http.js'
import { registerRuntimeSecrets } from '../../utils/secret-redaction.js'

const MAX_IMAGES = 30
const MAX_IMAGE_BYTES = 30 * 1024 * 1024
const UPLOAD_RESULT_LIMIT = 64 * 1024
const UPLOADED_PATH = /^\/creative\/api\/reference\/\d+-[a-f0-9]{64}-[a-f0-9]{48}\.(png|jpg|webp)$/u
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const FRAME_ROLES = new Set(['first', 'last', 'first_frame', 'last_frame', 'start_frame', 'end_frame', 'mask'])

function failure(message: string, status?: number): Error {
  return Object.assign(new Error(message + '；未提交视频生成请求。'), {
    code: 'reference_upload_failed',
    ...(status !== undefined ? { statusCode: status, providerHttpStatus: status } : {}),
    submissionUnknown: false,
    isRetryable: false,
  })
}

function imageSource(reference: MediaReference, index: number): string {
  const source = reference.dataUrl || reference.url
    || (reference.bodyBase64 ? `data:${reference.mimeType || 'application/octet-stream'};base64,${reference.bodyBase64}` : '')
  if (!source) throw failure(`第 ${index + 1} 张参考图缺少图片地址`)
  const inline = /^data:[^;,]+;base64,([A-Za-z0-9+/]*={0,2})$/u.exec(source)
  if (inline) {
    const padding = inline[1].endsWith('==') ? 2 : inline[1].endsWith('=') ? 1 : 0
    if (Math.floor(inline[1].length * 3 / 4) - padding > MAX_IMAGE_BYTES) {
      throw failure(`第 ${index + 1} 张参考图超过 30 MiB`)
    }
  }
  return source
}

function checkedUploadURL(base: URL, value: unknown, index: number): string {
  if (typeof value !== 'string') throw failure(`第 ${index + 1} 张参考图上传未返回有效地址`)
  let url: URL
  try { url = new URL(value) } catch { throw failure(`第 ${index + 1} 张参考图上传返回地址格式错误`) }
  if (url.origin !== base.origin || url.username || url.password || url.search || url.hash || !UPLOADED_PATH.test(url.pathname)) {
    throw failure(`第 ${index + 1} 张参考图上传返回地址未通过同源校验`)
  }
  return url.toString()
}

/** Upload numbered image references to 888's own host before the billable video request. */
export async function prepare888Fast720Images(request: GenerationRequest, connection: ProviderConnection): Promise<GenerationRequest> {
  const prepared = structuredClone(request)
  if ((prepared.videos?.length || 0) > 0 || (prepared.audios?.length || 0) > 0 || (prepared.inputs?.length || 0) > 0) {
    throw failure('此视频型号只支持编号参考图片，不支持其他媒体输入')
  }
  if (prepared.operation && !['text_to_video', 'reference_to_video'].includes(prepared.operation)) {
    throw failure('此视频型号不支持首尾帧或其他生成模式')
  }
  const images = prepared.images || []
  if (images.length > MAX_IMAGES) throw failure('此视频型号最多支持 30 张参考图')
  const sources = images.map((reference, index) => {
    const role = (reference.role || '').toLowerCase().replaceAll('-', '_')
    if (FRAME_ROLES.has(role) || (reference.kind && reference.kind !== 'image')) {
      throw failure(`第 ${index + 1} 张参考图不能作为首尾帧、遮罩或其他媒体使用`)
    }
    return imageSource(reference, index)
  })
  if (images.length === 0) return prepared

  let base: URL
  try { base = new URL(connection.baseUrl) } catch { throw failure('888API 渠道地址格式错误') }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw failure('888API 渠道地址格式错误')
  const endpoint = new URL('/creative/api/reference', base)
  registerRuntimeSecrets([connection.apiKey, ...Object.values(connection.authFields || {}), ...Object.values(connection.headers || {})])

  // Deliberately request-scoped: no upload URL or authorization is shared across users or calls.
  const uploaded = new Map<string, { url: string; mimeType: string }>()
  for (let index = 0; index < images.length; index++) {
    const source = sources[index]
    let receipt = uploaded.get(source)
    if (!receipt) {
      receipt = await withRequestLogContext({ phase: 'upload' }, async () => {
        let bytes: Buffer
        try {
          const reference = images[index].bodyBase64 && !images[index].dataUrl && !images[index].url
            ? { ...images[index], dataUrl: source } : images[index]
          bytes = (await mediaBytes(reference)).bytes
        } catch { throw failure(`第 ${index + 1} 张参考图读取失败，请检查图片权限、地址和文件状态`) }
        if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw failure(`第 ${index + 1} 张参考图为空或超过 30 MiB`)
        const mimeType = inferMediaMime(bytes)
        if (!IMAGE_MIMES.has(mimeType)) throw failure(`第 ${index + 1} 张参考图必须为 PNG、JPEG 或 WEBP 图片`)

        const body = new Uint8Array(bytes)
        const headers = new Headers(connection.headers)
        headers.set('Content-Type', mimeType)
        applyProtocolAuth(endpoint, headers, body, connection, { type: 'bearer', field: 'apiKey' }, undefined, 'POST')
        let response: Response
        try {
          response = await fetchProvider(endpoint, {
            method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(60_000),
          })
        } catch { throw failure(`第 ${index + 1} 张参考图上传连接失败或超时，请检查渠道连接`) }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          throw failure(`第 ${index + 1} 张参考图上传失败（HTTP ${response.status}）`, response.status)
        }
        let payload: unknown
        try { payload = JSON.parse(Buffer.from(await boundedResponseBytes(response, UPLOAD_RESULT_LIMIT)).toString('utf8')) }
        catch { throw failure(`第 ${index + 1} 张参考图上传响应格式错误`) }
        const value = payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as Record<string, unknown>).url : undefined
        return { url: checkedUploadURL(base, value, index), mimeType }
      })
      uploaded.set(source, receipt)
    }
    // Preserve every numbered slot, including duplicate references and its original order.
    prepared.images![index] = { ...images[index], url: receipt.url, mimeType: receipt.mimeType }
    delete prepared.images![index].dataUrl
    delete prepared.images![index].bodyBase64
  }
  return prepared
}
