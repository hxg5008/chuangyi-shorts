import { splitQuotedText } from '../../utils/quoted-text.js'

/** Translate transport reference tokens only. Saved prompts and spoken text stay unchanged. */
export function normalize888Fast720References(prompt: string, imageCount: number): string {
  return splitQuotedText(prompt).map((segment) => {
    if (segment.quoted) return segment.text
    return segment.text.replace(/@(?:图片|图像|图|image)(\d+)/giu, (token, digits: string, offset: number, source: string) => {
      const index = Number(digits)
      if (!Number.isSafeInteger(index) || index < 1 || index > imageCount) {
        throw new Error(`${token} 超出本次实际参考图片范围（共 ${imageCount} 张），请检查分镜绑定。`)
      }
      // Keep an unambiguous boundary before a following asset name or action.
      const next = source[offset + token.length] || ''
      return `@image${index}${/[\p{L}\p{N}_]/u.test(next) ? ' ' : ''}`
    })
  }).join('')
}
