export const REFERENCE_FILE_BYTES = 30 * 1024 * 1024
export const REFERENCE_TOTAL_BYTES = 35 * 1024 * 1024

/** Mirror the backend's conservative adapter limits; never drop extra inputs. */
export function assetReferenceCapability(config, model = '') {
  const caps = config?.capabilities || {}
  const actualModel = String(model || config?.selected_model || '')
  const provider = config?.provider || ''
  let max = actualModel === 'imagegen' || (config?.protocol_id || config?.protocolId) === 'image.codex-official' ? 5 : 6
  for (const key of ['max_images', 'max_reference_images', 'maxReferenceImages']) {
    const value = caps[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) max = Math.min(max, Math.floor(value))
  }
  const googleInteraction = provider === 'gemini' && /generativelanguage\.googleapis\.com/i.test(config?.base_url || config?.baseUrl || '') && /gemini-3.*image/i.test(actualModel)
  const supported = !!config && max > 0 && provider !== 'volcengine' && !googleInteraction
    && !['reference_images', 'supports_reference_images', 'image_input'].some(key => caps[key] === false)
  return { known: !!config, supported, max: supported ? max : 0 }
}

export function assetMediaUrl(value) {
  if (typeof value !== 'string' || !value) return ''
  return /^https?:\/\//i.test(value) || value.startsWith('/') ? value : '/' + value
}

export function assetImageDate(value) {
  if (!value) return '时间未知'
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return '时间未知'
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function validateReferenceFiles(files, existing, capability) {
  if (!capability.supported) throw Error(capability.known ? '所选图片接口不支持参考图，请切换模型。' : '请先选择图片模型。')
  if (files.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > REFERENCE_FILE_BYTES)) {
    throw Error('参考图仅支持 PNG、JPG、JPEG、WEBP，每张不超过 30 MB。')
  }
  if (existing.length + files.length > capability.max) throw Error(`当前模型最多支持 ${capability.max} 张参考图，请减少后重试。`)
  const bytes = [...existing.map(item => item.bytes || 0), ...files.map(file => file.size)].reduce((sum, value) => sum + value, 0)
  if (bytes > REFERENCE_TOTAL_BYTES) throw Error('参考图总大小不超过 35 MB，请减少后重试。')
}

export function validateRedrawReferences(references, capability) {
  if (references.length && !capability.supported) throw Error(capability.known ? '所选图片接口不支持参考图，请移除参考图或切换模型。' : '请先选择图片模型。')
  if (references.length > capability.max) throw Error(`参考图超过当前模型 ${capability.max} 张的上限，不会自动截断。`)
  return references.map(reference => reference.url)
}
