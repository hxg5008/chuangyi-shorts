import { splitQuotedText } from './quoted-text.js'

export const API888_VIDEO_MODELS = [
  'seedance2.0-933-c5-fast',
  'jimeng-video-seedance-2.0-fast-vip',
  'jimeng-video-seedance-2.0-vip',
  'jimeng-video-seedance-2.0-mini',
]

export const API888_VIDEO_PRESET = {
  label: '888API · Seedance 2.0',
  baseUrl: 'https://888api.xin',
  models: API888_VIDEO_MODELS,
}

export function api888VideoCapability(provider, model) {
  if (provider !== '888api' || !API888_VIDEO_MODELS.includes(model)) return null
  const publicReferences = model === 'seedance2.0-933-c5-fast'
  const fixedDuration = model === 'jimeng-video-seedance-2.0-fast-vip' ? 15 : null
  return {
    minDuration: fixedDuration || 4,
    maxDuration: 15,
    fixedDuration,
    resolutions: ['720p'],
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    maxImages: publicReferences ? 9 : 12,
    publicReferences,
  }
}

/** One ordered source for both the multipart image list and prompt numbering. */
export function collectVideoImageReferences(scene, characters, props) {
  const refs = []
  const byUrl = new Map()
  function add(name, url) {
    if (!url) return
    let ref = byUrl.get(url)
    if (!ref) {
      ref = { url, names: [] }
      refs.push(ref)
      byUrl.set(url, ref)
    }
    if (name && !ref.names.includes(name)) ref.names.push(name)
  }
  add(scene?.location, scene?.image_url || scene?.imageUrl)
  for (const item of characters) add(item.name, item.image_url || item.imageUrl)
  for (const item of props) add(item.name, item.image_url || item.imageUrl)
  return refs
}

export function api888ReferencePrompt(prompt, refs, model = API888_VIDEO_MODELS[0]) {
  const prefix = model === 'seedance2.0-933-c5-fast' ? '@图' : '@image_file_'
  const indices = new Map()
  refs.forEach((ref, index) => ref.names.forEach(name => { if (!indices.has(name)) indices.set(name, index + 1) }))
  const names = [...indices.keys()].sort((a, b) => b.length - a.length)
  return splitQuotedText(String(prompt || '')).map(segment => segment.quoted ? segment.text : segment.text.replace(/@([^\s@#]+)/g, (token, raw) => {
    const numbered = raw.match(/^(?:图片|图|image_file_)(\d+)(.*)$/)
    if (numbered) return `${prefix}${numbered[1]}${numbered[2] ? ` ${numbered[2]}` : ''}`
    const name = names.find(name => raw.startsWith(name))
    return name ? `${prefix}${indices.get(name)} ${raw}` : token
  })).join('')
}

/** Validate without changing stored shot timing, prompt text or project aspect ratio. */
export function validateApi888Video({ model, duration, aspectRatio, imageCount, prompt, audioUrls = [], videoUrls = [] }) {
  const capability = api888VideoCapability('888api', model)
  if (!capability) return { key: 'episode.vid.api888UnsupportedModel' }
  if (capability.fixedDuration && duration !== capability.fixedDuration) return { key: 'episode.vid.api888FixedDuration' }
  if (!Number.isInteger(duration) || duration < capability.minDuration || duration > capability.maxDuration) return { key: 'episode.vid.api888DurationRange' }
  if (!capability.aspectRatios.includes(aspectRatio)) return { key: 'episode.vid.api888ConcreteRatio' }
  if (imageCount > capability.maxImages) return { key: 'episode.vid.api888TooManyImages', params: { n: capability.maxImages } }
  if (audioUrls.length || videoUrls.length || splitQuotedText(String(prompt || '')).some(segment => !segment.quoted && /#[^\s@#]+|@(?:音频|视频|audio|video)(?:_file_)?\d+/i.test(segment.text))) return { key: 'episode.vid.api888ImageOnly' }
  return null
}
