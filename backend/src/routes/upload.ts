import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { success, badRequest } from '../utils/response.js'
import { saveUploadedFile, generateImageThumb } from '../utils/storage.js'
import { AUDIO_MAX_BYTES, AudioUploadError, saveAudioUpload } from '../utils/audio-upload.js'
import {registerPrivateMedia,currentActor} from '../services/platform-security/index.js'
import sharp from 'sharp'

const app = new Hono()
function register(c:any,path:string){if(currentActor())registerPrivateMedia(path,c.get('platformProjectId')??null)}

// POST /upload/image
app.post('/image', bodyLimit({maxSize:31*1024*1024,onError:c=>badRequest(c,'图片不能超过30MB')}), async (c) => {
  const body = await c.req.parseBody()
  const file = body['file']

  if (!file || !(file instanceof File)) {
    return badRequest(c, '文件必填')
  }

  const buffer = await file.arrayBuffer()
  if(buffer.byteLength>30*1024*1024)return badRequest(c,'图片不能超过30MB')
  let extension:string
  try{const image=sharp(Buffer.from(buffer),{limitInputPixels:40_000_000}),meta=await image.metadata();if(!['png','jpeg','webp'].includes(meta.format||'')||(meta.pages||1)>1)throw Error('format');await image.stats();extension=meta.format==='jpeg'?'jpg':meta.format!}catch{return badRequest(c,'仅支持完整的PNG、JPG和WEBP静态图片')}
  const path = await saveUploadedFile(buffer, 'uploads', 'image.'+extension)
  register(c,path)
  // 同步生成列表页缩略图，上传图与生图走同一套展示链路（失败不影响上传结果）
  await generateImageThumb(path)
  return success(c, { url: `/${path}`, path })
})

const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v'])
const VIDEO_MIME = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'])
const VIDEO_MAX = 50 * 1024 * 1024 // 50MB

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

async function saveMediaUpload(
  c: any,
  kind: 'video' | 'audio',
  allowedExt: Set<string>,
  allowedMime: Set<string>,
  maxBytes: number,
) {
  const body = await c.req.parseBody()
  const file = body['file']
  if (!file || !(file instanceof File)) {
    return badRequest(c, '文件必填')
  }
  const label = kind === 'video' ? '视频' : '音频'
  const ext = extOf(file.name)
  // MIME 可伪造，扩展名兜底；空 / octet-stream 视为未知类型，仅按扩展名校验
  const mimeKnown = file.type && file.type !== 'application/octet-stream'
  if (!allowedExt.has(ext) || (mimeKnown && !allowedMime.has(file.type))) {
    return badRequest(c, `仅支持 ${Array.from(allowedExt).join('/')} 格式的${label}文件`)
  }
  const buffer = await file.arrayBuffer()
  if (buffer.byteLength > maxBytes) {
    return badRequest(c, `${label}文件大小不能超过 ${Math.round(maxBytes / 1024 / 1024)}MB`)
  }
  const path = await saveUploadedFile(buffer, 'uploads', file.name)
  register(c,path)
  return success(c, { url: `/${path}`, path })
}

// POST /upload/video — 参考视频上传（Seedance 多模态参考用）
app.post('/video', async (c) => saveMediaUpload(c, 'video', VIDEO_EXT, VIDEO_MIME, VIDEO_MAX))

// POST /upload/audio — 参考音频上传（Seedance 多模态参考用）
app.post('/audio', bodyLimit({ maxSize: AUDIO_MAX_BYTES + 64 * 1024,
  onError: c => badRequest(c, '音频文件大小不能超过 20MB'),
}), async (c) => {
  try {
    const body = await c.req.parseBody()
    const result=await saveAudioUpload(body.file)
    register(c,result.path)
    return success(c,result)
  } catch (error) {
    if (error instanceof AudioUploadError) return badRequest(c, error.message)
    throw error
  }
})

export default app
