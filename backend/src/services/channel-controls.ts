import type { AIConfig } from './ai.js'

/** Validate declared transport capabilities without rewriting creative content. */
export function validateChannelControls(config: AIConfig, input: {
  referenceImages?: string[]; referenceImageUrls?: string[]; referenceVideoUrls?: string[]; referenceAudioUrls?: string[];
  duration?: number; resolution?: string; aspectRatio?: string; size?: string;
}) {
  if (!config.bindingId) return
  const caps = config.capabilities || {}
  for (const [field, count] of [
    ['reference_images', (input.referenceImages || input.referenceImageUrls || []).length],
    ['reference_video', (input.referenceVideoUrls || []).length],
    ['reference_audio', (input.referenceAudioUrls || []).length],
  ] as const) if (caps[field] === false && count) throw new Error(`所选模型不支持 ${field} 参考素材`)
  for (const [field, count] of [
    ['max_images', (input.referenceImages || input.referenceImageUrls || []).length],
    ['max_videos', (input.referenceVideoUrls || []).length],
    ['max_audios', (input.referenceAudioUrls || []).length],
  ] as const) {
    if (typeof caps[field] === 'number' && count > caps[field]) throw new Error(`参考素材超过所选模型的 ${field} 限制（${caps[field]}）`)
  }
  for (const [field, value] of [['resolutions', input.resolution], ['aspect_ratios', input.aspectRatio], ['sizes', input.size], ['durations', input.duration]] as const) {
    if (value != null && Array.isArray(caps[field]) && !caps[field].includes(value)) throw new Error(`所选模型不支持参数 ${field}=${value}`)
  }
  if (input.duration != null && ((caps.min_duration != null && input.duration < caps.min_duration) || (caps.max_duration != null && input.duration > caps.max_duration))) throw new Error('生成时长超出所选模型的能力范围')
}
