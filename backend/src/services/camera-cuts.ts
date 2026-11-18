export interface CameraCut { index: number; end: number; text: string }

const CUT = /切到|切回|切至|切换至|(?:カットを?\s*)?切り替(?:わ(?:る|り)|え)|カットバック|(?:ショット|画面|近景|全景|ミディアム).{0,8}に戻(?:る|り)|(?:으?로)\s*전환|되돌아온다|컷(?:을)?\s*(?:전환|백)|\bcut(?:s)?\s+(?:to|back)\b|\bswitch\s+to\b/gi
const NEGATIVE_PREFIX = /(?:不(?:要|再|应|得|可|必|会)?|不能|不允许|不需要|禁止|无需|避免|勿)(?:再|再次|重新|直接|继续)?\s*$|\b(?:do\s+not|don['’]t|does\s+not|doesn['’]t|did\s+not|didn['’]t|not|never|without|avoid(?:ing)?)\s+(?:ever\s+|again\s+)?$|(?:^|\s)안\s*$/i
const NEGATIVE_SUFFIX = /^\s*(?:(?:は|を)?(?:しない|しません|せず|しなく)|ない|なく|ず|ません|ぬ|하지\s*(?:않|말|못|마)|(?:은|는)?\s*금지)/i
const METAPHOR_PREFIX = /(?:话锋|话题|谈话内容|叙述话题)(?:突然|忽然|随即|又|已|再次)?\s*$|\b(?:topic|conversation|discussion|subject)\s*$|話題(?:を|が|に)?\s*$|화제(?:를|가)?\s*$/i
const SEPARATORS = /^[\s，,、:：／/—–-]*$/

function withoutQuotedText(text: string): string {
  const pairs: Record<string, string> = { '「': '」', '『': '』', '“': '”', '‘': '’', '"': '"', "'": "'" }
  const word = (character = '') => /[\p{L}\p{N}]/u.test(character)
  const ranges: Array<[number, number]> = []
  for (let index = 0; index < text.length; index++) {
    const open = text[index], close = pairs[open]
    if (!close || open === "'" && word(text[index - 1])) continue
    let end = index + 1
    for (; end < text.length; end++) {
      if (text[end] === '\\') { end++; continue }
      if (text[end] === close && !(close === "'" && word(text[end + 1]))) break
    }
    if (end < text.length) { ranges.push([index, end + 1]); index = end }
  }
  let masked = '', from = 0
  for (const [start, end] of ranges) {
    masked += text.slice(from, start) + ' '.repeat(end - start)
    from = end
  }
  return masked + text.slice(from)
}

function leadingPrefix(prefix: string): boolean {
  return SEPARATORS.test(prefix)
    || /^(?:镜头|画面|(?:the\s+)?camera|カメラ(?:を)?|근경|중경|전경|클로즈업|미디엄(?:\s*샷)?|화면)[\s，,、:：]*$/i.test(prefix.trim())
}

/** Recognize explicit positive camera boundaries without changing any prompt text. */
export function cameraCuts(text: string): CameraCut[] {
  const masked = withoutQuotedText(text)
  const result: CameraCut[] = []
  let leadingEnd: number | undefined
  for (const match of masked.matchAll(CUT)) {
    const index = match.index!, end = index + match[0].length
    const before = masked.slice(Math.max(0, index - 45), index)
    const after = masked.slice(end, end + 18)
    if (NEGATIVE_PREFIX.test(before) || NEGATIVE_SUFFIX.test(after) || METAPHOR_PREFIX.test(before)) continue
    // "切到，切换至A" names one boundary. Once any actual picture/action text
    // appears between commands, the next cut remains a separate hard-checkable cut.
    if (leadingEnd !== undefined && result.length === 1 && SEPARATORS.test(text.slice(leadingEnd, index))) {
      result[0].end = end
      result[0].text = text.slice(result[0].index, end)
      leadingEnd = end
      continue
    }
    if (!result.length && leadingPrefix(text.slice(0, index))) leadingEnd = end
    else leadingEnd = undefined
    result.push({ index, end, text: text.slice(index, end) })
  }
  return result
}

export function hasLeadingCameraCut(text: string): boolean {
  const first = cameraCuts(text)[0]
  return !!first && leadingPrefix(text.slice(0, first.index))
}
