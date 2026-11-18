import type { ValidationIssue } from './storyboard-validation.js'
import { extractScriptDialogue } from './script-dialogue.js'
import type { StoryboardCandidate } from './storyboard-session.js'

export type SkillCandidate = StoryboardCandidate & { source_ids?: number[]; time_row_counts?: number[] }
type Assets = { characters: Array<{ id: number; name: string }>; scenes: Array<{ id: number; location: string }>; props: Array<{ id: number; name: string }> }
const count = (text: string) => [...text].filter(char => /[\p{L}\p{N}]/u.test(char)).length
export interface SkillSpokenTurn { speakerName?: string; kind: 'dialogue' | 'offscreen' | 'narration'; text: string; start: number; end: number }
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const voiceWords = '旁白|画外音|画外声|内心独白|独白|OS|O\\.S\\.|VO|V\\.O\\.|\\bnarrator\\b|\\bnarration\\b|\\bvoice[- ]?over\\b|\\boff[- ]?screen(?:\\s+voice)?\\b|ナレーション|내레이션|보이스오버'
const speechWords = `说道|说完|回答|问道|喊道|说|问|答|喊|言う|話す|語る|말한다|말했다|대답한다|\\bsays?\\b|\\bsaid\\b|\\basks?\\b|\\basked\\b|${voiceWords}`
const markerSuffix = new RegExp(`(${speechWords})(?:\\s*[（(]([^）)]{0,100})[）)])?\\s*[:：]?\\s*$`, 'iu')
const voiceMarker = new RegExp(`(${voiceWords})(?:\\s*[（(]([^）)]{0,100})[）)])?\\s*[:：]\\s*`, 'giu')
const voiceSuffix = new RegExp(`(${voiceWords})(?:\\s*[（(]([^）)]{0,100})[）)])?\\s*[:：]\\s*$`, 'iu')
const kindOf = (value: string): SkillSpokenTurn['kind'] => /同场对白/.test(value) ? 'dialogue'
  : /旁白|内心独白|独白|narrat(?:or|ion)|ナレーション|내레이션/i.test(value) ? 'narration'
    : /画外|voice[- ]?over|off[- ]?screen|보이스오버|(?:^|[^a-z])(?:OS|O\.S\.|VO|V\.O\.)(?:$|[^a-z])/i.test(value) ? 'offscreen' : 'dialogue'
const voiceContradiction = (a: Pick<SkillSpokenTurn, 'speakerName' | 'kind'>, b: Pick<SkillSpokenTurn, 'speakerName' | 'kind'>) =>
  a.kind !== b.kind || Boolean(a.speakerName && b.speakerName && a.speakerName !== b.speakerName)

function quoteSpans(text: string) {
  const pairs: Record<string, string> = { '「': '」', '『': '』', '“': '”', '‘': '’', '"': '"', "'": "'" }
  const spans: Array<{ start: number; end: number; text: string }> = []
  for (let index = 0; index < text.length; index++) {
    const open = text[index], close = pairs[open]
    if (!close || open === "'" && /\p{L}/u.test(text[index - 1] || '')) continue
    let depth = 1, end = index + 1
    for (; end < text.length; end++) {
      if (text[end] === '\\') { end++; continue }
      if (open !== close && text[end] === open) depth++
      if (text[end] === close) {
        if ((close === "'" || close === '’') && /\p{L}/u.test(text[end - 1] || '') && /\p{L}/u.test(text[end + 1] || '')) continue
        if (!--depth) break
      }
    }
    if (end < text.length) { spans.push({ start: index, end: end + 1, text: text.slice(index + 1, end) }); index = end }
  }
  return spans
}

function speakerBefore(prefix: string, names: string[]) {
  if (!names.length) return null
  const name = [...new Set(names)].filter(Boolean).sort((a, b) => b.length - a.length).map(escapeRegex).join('|')
  const match = prefix.match(new RegExp(`[@#]?(${name})(?:\\s*[（(]([^）)]{0,100})[）)])?\\s*(?:は|が|은|는|이|가)?\\s*(?:(?:轻声|低声|高声|大声|小声|温声|沉声|厉声|颤声|缓缓|慢慢|继续|接着|又|开口|压低声音|提高音量)(?:地)?)?\\s*(?:的|の|['’]s)?\\s*$`, 'iu'))
  return match ? { name: match[1], annotation: match[2] || '', index: match.index! } : null
}

function voiceSentence(prefix: string) {
  // These periods belong to explicit voice labels, not to a previous sentence.
  const boundaries = prefix.replace(/\b(?:O\.S\.|V\.O\.)/gi, value => value.replace(/\./g, '\u0000'))
  let from = 0
  for (const match of boundaries.matchAll(/[。！？!?；;\r\n.]/g)) {
    // Numeric voice details such as 3.3字/秒 do not start a new sentence.
    if (match[0] === '.' && /\d/u.test(boundaries[match.index! - 1] || '') && /\d/u.test(boundaries[match.index! + 1] || '')) continue
    from = match.index! + match[0].length
  }
  const quotes = quoteSpans(prefix)
  for (const quote of quotes) from = Math.max(from, quote.end)
  for (const marker of prefix.matchAll(marks)) if (!quotes.some(quote => marker.index! >= quote.start && marker.index! < quote.end)) from = Math.max(from, marker.index! + marker[0].length)
  return prefix.slice(from).trimStart().replace(/^[（(]\s*/, '')
}

function sentenceVoiceCue(prefix: string) {
  const sentence = voiceSentence(prefix)
  const cue = sentence.match(/^(?:画外(?:音|声)?|旁白|内心独白|独白|O\.S\.|V\.O\.|OS\b|VO\b|narrator\b|narration\b|voice[- ]?over\b|off[- ]?screen\b(?:\s+voice)?|ナレーション|내레이션|보이스오버)/iu)
  if (!cue) return ''
  const qualifier = sentence.slice(cue[0].length).replace(/^[,，:：)）]\s*/, '').trimStart()
  // An ambient breathing clause is not a qualifier on the later speaker.
  if (/^(?:传来|响起|响着|仍有|只有|呼吸|breathing\b|breaths?\b)/iu.test(qualifier)) return ''
  return cue[0]
}

function explicitPresentation(annotation: string): 'dialogue' | 'offscreen' | '' {
  // A current explicit in-frame declaration takes precedence over an earlier cue.
  if (/画内(?:音|声)?|已入镜/u.test(annotation)) return 'dialogue'
  return /画外(?:音|声)?|未入镜|不入镜|(?:^|[^a-z])(?:OS|O\.S\.)(?:$|[^a-z])/iu.test(annotation) ? 'offscreen' : ''
}

function sameSpeakerPresentation(prefix: string, speakerName: string) {
  // Carry only an explicit annotation on this exact formal @name in the same
  // unquoted sentence. Location/ambient descriptions such as 门外传来 are not cues.
  const sentence = voiceSentence(prefix)
  const annotations = sentence.matchAll(new RegExp(`@${escapeRegex(speakerName)}\\s*(?:的声音\\s*)?[（(]([^）)]{0,100})[）)]`, 'gu'))
  let presentation: ReturnType<typeof explicitPresentation> = ''
  for (const annotation of annotations) presentation = explicitPresentation(annotation[1]) || presentation
  return presentation
}

function presentationBeforeSpeaker(prefix: string) {
  // Read an explicit voice/framing label immediately before the current named
  // speaker, not a location such as 院中/门外 or another person's earlier sound.
  const sentence = voiceSentence(prefix)
  return sentence.match(/((?:画外(?:音|声)?|画内(?:音|声)?|已入镜|未入镜|不入镜|O\.S\.|\bOS\b)(?:\s*[（(][^）)]{0,100}[）)])?)\s*$/iu)?.[1] || ''
}

function attributedMarker(prefix: string, names: string[]) {
  const marker = prefix.match(markerSuffix)
  if (!marker) return null
  const before = prefix.slice(0, marker.index)
  const speaker = speakerBefore(before, names)
  const annotation = marker[2] || ''
  const annotatedSpeaker = names.find(name => annotation.trim().replace(/^[@#]/, '') === name)
  const wrapper = speaker ? before.slice(0, speaker.index).match(voiceSuffix) : null
  let kind = kindOf(`${marker[1]} ${annotation} ${speaker?.annotation || ''} ${wrapper?.[1] || ''} ${wrapper?.[2] || ''} ${sentenceVoiceCue(prefix)}`)
  const presentation = explicitPresentation(`${annotation} ${speaker?.annotation || ''} ${speaker ? presentationBeforeSpeaker(before.slice(0, speaker.index)) : ''}`)
    || (speaker ? sameSpeakerPresentation(prefix, speaker.name) : '')
  if (kind !== 'narration' && presentation) kind = presentation
  return { speakerName: speaker?.name || annotatedSpeaker, kind, start: speaker?.index ?? marker.index!, continuation: /(?:继续|接着|续句|接上句)\s*$/.test(before) }
}

interface SpeechDifference { expectedIndex: number; expectedOffset: number; actualIndex: number; actualOffset: number; reason: 'missing' | 'extra' | 'identity' | 'text' }
type SpokenText = Pick<SkillSpokenTurn, 'speakerName' | 'kind' | 'text'> & { presentationExplicit?: boolean }
interface AttributionReview { expectedIndex: number; actualIndex: number }
function sourceVoiceContradiction(source: SpokenText, actual: SpokenText) {
  if (source.kind === 'dialogue' && source.presentationExplicit === false && (actual.kind === 'dialogue' || actual.kind === 'offscreen')) {
    return Boolean(source.speakerName && actual.speakerName && source.speakerName !== actual.speakerName)
  }
  return voiceContradiction(source, actual)
}
function speechDifference(expected: readonly SpokenText[], actual: readonly SpokenText[], reviews?: AttributionReview[],
  contradicts: (source: SpokenText, actual: SpokenText) => boolean = voiceContradiction): SpeechDifference | null {
  let expectedIndex = 0, expectedOffset = 0
  for (const [actualIndex, turn] of actual.entries()) {
    let actualOffset = 0
    while (actualOffset < turn.text.length) {
      const source = expected[expectedIndex]
      if (!source) return { expectedIndex, expectedOffset, actualIndex, actualOffset, reason: 'extra' }
      if (contradicts(source, turn)) return { expectedIndex, expectedOffset, actualIndex, actualOffset, reason: 'identity' }
      if ((!source.speakerName || !turn.speakerName) && (source.kind === 'dialogue' || source.speakerName || turn.speakerName)
        && reviews && !reviews.some(review => review.expectedIndex === expectedIndex && review.actualIndex === actualIndex)) reviews.push({ expectedIndex, actualIndex })
      const length = Math.min(source.text.length - expectedOffset, turn.text.length - actualOffset)
      for (let index = 0; index < length; index++) if (source.text[expectedOffset + index] !== turn.text[actualOffset + index]) return { expectedIndex, expectedOffset: expectedOffset + index, actualIndex, actualOffset: actualOffset + index, reason: 'text' }
      expectedOffset += length; actualOffset += length
      if (expectedOffset === source.text.length) { expectedIndex++; expectedOffset = 0 }
    }
  }
  return expectedIndex < expected.length ? { expectedIndex, expectedOffset, actualIndex: actual.length, actualOffset: 0, reason: 'missing' } : null
}

const speechTurnsDiagnostic = (values: readonly SpokenText[]) => values.length ? values.map((turn, index) =>
  `${index + 1}{speakerName=${turn.speakerName === undefined ? '未明确' : JSON.stringify(turn.speakerName)}，kind=${turn.kind}，原词=${JSON.stringify(turn.text)}}`).join('；') : '无（未识别到明确发声标记）'
const attributionDiagnostic = (expected: readonly SpokenText[], actual: readonly SpokenText[], reviews: AttributionReview[]) =>
  `发声归属未完全明确，无法机械确认是否同一说话者（${reviews.map(review => `预期发声段${review.expectedIndex + 1}/实际发声段${review.actualIndex + 1}`).join('、')}）；未明确姓名保持未知，不据此推断姓名或认定已经匹配，请人工复核。预期发声=[${speechTurnsDiagnostic(expected)}]；实际发声=[${speechTurnsDiagnostic(actual)}]`

function speechDiagnostic(expected: SkillSpokenTurn[], actual: SkillSpokenTurn[], difference: SpeechDifference) {
  const reasons = { missing: '实际发声提前结束，预期原词尚未完整出现', extra: '实际出现额外或重复发声', identity: '说话者或声音类型不同', text: '原词字符不同（可能改词、漏词、重复或逆序）' }
  const position = (turns: SkillSpokenTurn[], index: number, offset: number) => {
    const turn = turns[index]
    if (!turn) return '已结束'
    // Difference offsets are UTF-16 indices; report a readable Unicode character
    // position even when the first differing character is a supplementary one.
    const before = offset > 0 && /[\uDC00-\uDFFF]/u.test(turn.text[offset] || '') && /[\uD800-\uDBFF]/u.test(turn.text[offset - 1]) ? offset - 1 : offset
    return `发声段${index + 1}原词第${[...turn.text.slice(0, before)].length + 1}字符`
  }
  return `首个差异${difference.reason}：${reasons[difference.reason]}；description ${position(expected, difference.expectedIndex, difference.expectedOffset)}，video_prompt ${position(actual, difference.actualIndex, difference.actualOffset)}；description预期发声=[${speechTurnsDiagnostic(expected)}]；video_prompt实际发声=[${speechTurnsDiagnostic(actual)}]`
}

/** Explicit speech only. A quote on a sign is never converted into a new spoken line. */
export function skillSpokenTurns(text: string, names: string[] = [], expected: readonly SkillSpokenTurn[] = []): SkillSpokenTurn[] {
  const quotes = quoteSpans(text)
  const quoteMarkers = quotes.map(quote => ({ quote, marker: attributedMarker(text.slice(0, quote.start), names) }))
  const voiceMarkers = [...text.matchAll(voiceMarker)].filter(marker => !quotes.some(quote => marker.index! >= quote.start && marker.index! < quote.end))
  const events: Array<SkillSpokenTurn | { quote: typeof quotes[number] }> = []
  const rawVoiceRanges: Array<{ start: number; end: number }> = []
  for (const marker of voiceMarkers) {
    const start = marker.index! + marker[0].length
    if (quotes.some(quote => quote.start === start)) continue
    const lineEnd = text.indexOf('\n', start)
    const shotEnd = text.indexOf('【', start)
    const nextMarker = Math.min(text.length,
      ...voiceMarkers.filter(next => next.index! >= start).map(next => next.index!),
      ...quoteMarkers.filter(next => next.marker && next.marker.start >= start).map(next => next.marker!.start))
    const end = Math.min(lineEnd < 0 ? text.length : lineEnd, shotEnd < 0 ? text.length : shotEnd, nextMarker)
    const body = text.slice(start, end).trim()
    if (!body) continue
    const speaker = speakerBefore(text.slice(0, marker.index), names)
    const annotation = marker[2] || ''
    events.push({ speakerName: speaker?.name || names.find(name => annotation.trim().replace(/^[@#]/, '') === name), kind: kindOf(`${marker[1]} ${annotation}`), text: body, start, end })
    rawVoiceRanges.push({ start, end })
  }
  quotes.forEach(quote => { if (!rawVoiceRanges.some(range => quote.start >= range.start && quote.end <= range.end)) events.push({ quote }) })
  events.sort((a, b) => ('quote' in a ? a.quote.start : a.start) - ('quote' in b ? b.quote.start : b.start))
  const result: SkillSpokenTurn[] = []
  const explicitStarts = new Set<number>()
  for (const event of events) {
    if (!('quote' in event)) { result.push(event); explicitStarts.add(event.start); continue }
    const { quote } = event
    const prefix = text.slice(0, quote.start)
    const boundary = [...prefix.matchAll(marks)].filter(match => !quotes.some(other => match.index! >= other.start && match.index! < other.end)).at(-1)
    const childStart = boundary ? boundary.index! + boundary[0].length : 0
    // A previously spoken line may be quoted while describing its delivery.
    // This is a reference only with an explicit suffix and a real earlier utterance
    // in the same child; an ordinary repeated spoken line remains another turn.
    if (quote.text.trim() && /^\s*(?:时(?:候)?|这(?:句(?:话)?|段话|番话|几个字|几个词|几个音节))/u.test(text.slice(quote.end))
      && result.some(turn => explicitStarts.has(turn.start) && turn.start >= childStart && turn.text.includes(quote.text))) continue
    const marker = attributedMarker(prefix, names)
    const difference = expected.length ? speechDifference(expected, result) : null
    const pending = difference?.reason === 'missing' ? expected[difference.expectedIndex] : undefined
    const previous = result.at(-1)
    if (marker) {
      const continuing = !marker.speakerName && marker.continuation && pending && previous && !voiceContradiction(previous, pending)
        && pending.text.slice(difference!.expectedOffset).startsWith(quote.text)
      result.push({ speakerName: marker.speakerName, kind: continuing && marker.kind === 'dialogue' ? previous.kind : marker.kind, text: quote.text, start: quote.start, end: quote.end })
      explicitStarts.add(quote.start)
    } else if (pending && previous && !voiceContradiction(previous, pending)
      && pending.text.slice(difference!.expectedOffset).startsWith(quote.text)
      && !/(?:写着|写有|刻着|刻有|印着|印有|标着|标有|标注|题字|字样|文字|牌匾|标牌|标签|字幕)[^。；;\n]{0,16}$/u.test(prefix)) {
      result.push({ speakerName: undefined, kind: previous.kind, text: quote.text, start: quote.start, end: quote.end })
    }
  }
  return result
}
const marks = /【\s*(?:镜头|shot|ショット|컷)\s*(\d+)\s*】/giu
export function skillDescriptionShots(text: string) {
  const matches = [...text.matchAll(marks)]
  return matches.map((match, index) => ({ number: Number(match[1]), text: text.slice(match.index! + match[0].length, matches[index + 1]?.index ?? text.length) }))
}
export function skillTimeRows(text: string) {
  return text.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*(\d+(?:\.\d+)?)\s*[-–—~～至]\s*(\d+(?:\.\d+)?)\s*(?:秒|s|초)\s*[:：]\s*(.+)$/iu)
    return match ? [{ start: Number(match[1]), end: Number(match[2]), text: match[3] }] : []
  })
}

function referenceOutsideQuotes(text: string, names: string[]) {
  const ignored = [...quoteSpans(text), ...[...text.matchAll(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[A-Za-z]{2,}/gu)]
    .map(match => ({ start: match.index!, end: match.index! + match[0].length }))]
  const orderedNames = [...new Set(names)].filter(Boolean).sort((a, b) => b.length - a.length)
  for (let index = text.indexOf('@'); index >= 0; index = text.indexOf('@', index + 1)) {
    if (!ignored.some(range => index >= range.start && index < range.end)
      && orderedNames.some(name => text.startsWith(name, index + 1))) return true
  }
  return false
}

/** Check explicit data and text fidelity. Never infer a cast, split a shot, or rewrite prose. */
export function validateSkillStoryboard(candidate: SkillCandidate, assets: Assets, options: {
  mode?: 'breakdown' | 'prompt'; expected?: { number: number; duration: number; scene_id: number | null; source_ids: number[] }
} = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const issue = (code: string, message: string, field: string, severity: 'error' | 'warning' = 'error') => issues.push({ code, message, field, severity, shotNumber: candidate.shot_number })
  const required = options.mode === 'prompt' ? ['description', 'video_prompt', 'atmosphere'] : [
    'title', 'time', 'location', 'shot_type', 'angle', 'movement', 'description', 'result', 'atmosphere', 'image_prompt', 'video_prompt', 'bgm_prompt', 'sound_effect',
  ]
  for (const field of required) if (typeof (candidate as any)[field] !== 'string' || !(candidate as any)[field].trim()) issue('skill_field_missing', `缺少skill成品字段 ${field}；草稿保留，请补齐该字段。`, field)
  const duration = candidate.duration ?? NaN
  if (!Number.isFinite(duration) || duration < 8 || duration > 15) issue('duration_range', '本组时长必须为8—15秒。', 'duration')
  const description = candidate.description || '', prompt = candidate.video_prompt || ''
  if ([...prompt].length > 3600) issue('prompt_length', '视频提示词超过3600字符；请删重复修饰，保留原词、动作过程及必需信息。', 'video_prompt')
  const shots = skillDescriptionShots(description), rows = skillTimeRows(prompt)
  const characterNames = assets.characters.map(character => character.name)
  const rowSpeech = new Map<typeof rows[number], SkillSpokenTurn[]>()
  const header = prompt.split(/\r?\n/).find(line => Boolean(line.trim())) || ''
  if (!/(?:出场人物|Characters|Cast|登場人物|등장인물)\s*[:：]/iu.test(header)
    || !/(?:场景|Scene|シーン|장면)\s*[:：]/iu.test(header)
    || /^\s*\d+\s*[-–—~～至]/u.test(header)) issue('prompt_header', '视频提示词首行须包含独立的出场人物和场景信息头。', 'video_prompt.header')
  const boundNames = [
    ...assets.characters.filter(character => candidate.character_ids?.includes(character.id)).map(character => character.name),
    ...assets.scenes.filter(scene => scene.id === candidate.scene_id).map(scene => scene.location),
    ...assets.props.filter(prop => candidate.prop_ids?.includes(prop.id)).map(prop => prop.name),
  ]
  if (!boundNames.length) issue('reference_assets_missing', '本组没有可用的已绑定素材引用，请确认是否为无需参考图的纯环境镜头。', 'video_prompt', 'warning')
  else for (const [index, row] of rows.entries()) if (!referenceOutsideQuotes(row.text, boundNames)) issue('time_row_reference', `第${index + 1}时间行缺少已绑定素材的正式@引用；台词引号和电子邮箱内的@不作为画面锚点。`, `video_prompt.rows.${index + 1}`)
  if (shots.length < 2 || shots.length > 4 || shots.some((shot, index) => shot.number !== index + 1)) issue('shot_order', 'description须有按顺序排列的2—4个【镜头N】，程序不会增删镜头。', 'description')
  const mapping = candidate.time_row_counts || []
  if (mapping.length !== shots.length || mapping.some(length => length !== 1 && length !== 2) || mapping.reduce((a, b) => a + b, 0) !== rows.length) issue('shot_time_mapping', `time_row_counts须逐镜对应description，每镜1—2行且覆盖全部时间行；当前counts=${JSON.stringify(mapping)}，共${mapping.length}项、合计${mapping.reduce((a, b) => a + b, 0)}行；description有${shots.length}个子镜头，video_prompt有${rows.length}个时间行。只修本组映射，不改镜头数量。`, 'time_row_counts')
  if (rows.length !== Math.ceil(duration / 3) || rows.some((row, index) => row.start !== index * 3 || row.end !== Math.min((index + 1) * 3, duration))) issue('time_axis', '时间行须从0起连续按3秒分段，最后保留实际余量，合计等于本组时长。', 'video_prompt')
  let offset = 0
  for (const [index, shot] of shots.entries()) {
    const mapped = rows.slice(offset, offset + (mapping[index] || 0)); offset += mapping[index] || 0
    const seconds = mapped.reduce((sum, row) => sum + row.end - row.start, 0)
    if (mapping.length === shots.length && (seconds < 2 || seconds > 6)) issue('shot_duration', `子镜头${shot.number}实际分配${seconds}秒，skill要求2—6秒；请调整本组时间分配。`, 'time_row_counts')
    const expectedSpeech = skillSpokenTurns(shot.text, characterNames)
    const actualSpeech = skillSpokenTurns(mapped.map(row => row.text).join('\n'), characterNames, expectedSpeech)
    const reviews: AttributionReview[] = []
    const difference = speechDifference(expectedSpeech, actualSpeech, reviews)
    if (difference) issue('dialogue_preservation', `子镜头${shot.number}的description与视频提示词台词原词、说话者、声音类型、顺序或次数不一致；对应时间行${mapped.length ? `${rows.indexOf(mapped[0]) + 1}—${rows.indexOf(mapped.at(-1)!) + 1}` : '为空'}。${speechDiagnostic(expectedSpeech, actualSpeech, difference)}。`, 'video_prompt')
    if (reviews.length) issue('attribution_review', `子镜头${shot.number}：${attributionDiagnostic(expectedSpeech, actualSpeech, reviews)}。`, 'video_prompt', 'warning')
    let textOffset = 0
    for (const row of mapped) {
      rowSpeech.set(row, actualSpeech.filter(turn => turn.start >= textOffset && turn.start < textOffset + row.text.length))
      textOffset += row.text.length + 1
    }
  }
  const speech = shots.flatMap(shot => skillSpokenTurns(shot.text, characterNames))
  const minimum = count(speech.map(turn => turn.text).join('')) / 4.5 + (speech.length ? 2 : 0)
  if (minimum > duration + 0.001) issue('dialogue_budget', `原文发声至少需要${minimum.toFixed(1)}秒，超过本组${duration}秒；请在分镜规划中调整，不能删词或提速。`, 'duration')
  for (const [index, row] of rows.entries()) {
    const characters = count((rowSpeech.get(row) || skillSpokenTurns(row.text, characterNames)).map(turn => turn.text).join(''))
    const seconds = row.end - row.start, capacity = seconds * 4.5
    if (characters > capacity + 0.001) issue('line_dialogue_budget', `第${index + 1}时间行（${row.start}—${row.end}秒，实际${seconds}秒）原词共${characters}字；按4.5字/秒估算容量${Number(capacity.toFixed(3))}字，超出${Number((characters - capacity).toFixed(3))}字，请复核实际口播衔接。skill的4.5字/秒＋2秒硬预算按整组检查，此逐行估算只提醒，不据此删词或强制返修。`, 'video_prompt', 'warning')
  }
  if (rows.length && (!/A\s*0/i.test(rows[0].text) || !/X/i.test(rows[0].text) || !/Y/i.test(rows[0].text))) issue('space_basis_missing', '首行缺少skill要求的A0与X/Y空间基准；不能只放在内部计划中。', 'video_prompt')
  if (candidate.scene_id != null && !assets.scenes.some(scene => scene.id === candidate.scene_id)) issue('scene_binding', '场景ID不属于当前可用素材。', 'scene_id')
  if (candidate.character_ids?.some(id => !assets.characters.some(character => character.id === id))) issue('character_binding', '角色ID不属于当前可用素材。', 'character_ids')
  if (candidate.prop_ids?.some(id => !assets.props.some(prop => prop.id === id))) issue('prop_binding', '道具ID不属于当前可用素材。', 'prop_ids')
  if (options.expected) {
    const expected = options.expected
    if (candidate.shot_number !== expected.number || duration !== expected.duration || candidate.scene_id !== expected.scene_id || JSON.stringify(candidate.source_ids) !== JSON.stringify(expected.source_ids)) issue('plan_changed', '本组编号、场景、时长或原文覆盖与本次叙事规划不一致；需明确修正该组规划，不能在提示词转换中暗改。', 'plan')
  }
  return issues
}

export function validateSkillDialogueCoverage(candidates: SkillCandidate[], script: string, names: string[]): ValidationIssue[] {
  const expected = script.split(/\r\n|\n|\r/).filter(line => Boolean(line.trim()))
    .flatMap((line, index) => extractScriptDialogue(line, names, { includePresentation: true }).map(turn => ({ ...turn, sourceId: index + 1 })))
  const ordered = [...candidates].sort((a, b) => a.shot_number - b.shot_number)
  const actual = ordered.flatMap(candidate => skillDescriptionShots(candidate.description || '')
    .flatMap(shot => skillSpokenTurns(shot.text, names)).map(turn => ({ ...turn, shotNumber: candidate.shot_number })))
  const reviews: AttributionReview[] = []
  const difference = speechDifference(expected, actual, reviews, sourceVoiceContradiction)
  const warnings: ValidationIssue[] = reviews.map(review => ({ code: 'attribution_review', severity: 'warning',
    field: `source_ids.${expected[review.expectedIndex].sourceId}`, shotNumber: actual[review.actualIndex].shotNumber,
    message: `剧本原文单元${expected[review.expectedIndex].sourceId}与第${actual[review.actualIndex].shotNumber}组：${attributionDiagnostic([expected[review.expectedIndex]], [actual[review.actualIndex]], [{ expectedIndex: 0, actualIndex: 0 }])}。` }))
  if (!difference) return warnings
  const source = expected[difference.expectedIndex], turn = actual[difference.actualIndex]
  const owners = source ? ordered.filter(candidate => candidate.source_ids?.includes(source.sourceId)) : []
  const remaining = source?.text.slice(difference.expectedOffset)
  const actualOwner = turn && ordered.find(candidate => candidate.shot_number === turn.shotNumber)
  // A later group may already have started its own correct line while an earlier
  // source still has an uncovered tail. Repair the source owner, not that later
  // group. Matching words with a wrong speaker remain an identity error.
  const skippedTail = source && turn && difference.expectedOffset > 0 && remaining
    && !remaining.startsWith(turn.text) && !turn.text.startsWith(remaining)
    && owners.some(candidate => candidate.shot_number < turn.shotNumber)
  const laterOriginal = source && turn && difference.actualOffset === 0
    && expected.slice(difference.expectedIndex + 1).some(later => !sourceVoiceContradiction(later, turn)
      && (later.text.startsWith(turn.text) || turn.text.startsWith(later.text))
      && (difference.expectedOffset === 0 || skippedTail && actualOwner?.source_ids?.includes(later.sourceId)))
  // An utterance whose opening words were spoken correctly and whose next actual
  // turn belongs to the following original line lost only its remaining words.
  // Name those words; this is not a different speaker or voice type. Only the
  // group that owns the next line may legitimately start it; any other group
  // speaking it is still an attribution error.
  const truncated = Boolean(source && turn && difference.reason === 'identity' && difference.expectedOffset > 0
    && difference.actualOffset === 0 && remaining && expected.slice(difference.expectedIndex + 1, difference.expectedIndex + 2)
    .some(next => !sourceVoiceContradiction(next, turn) && (next.text.startsWith(turn.text) || turn.text.startsWith(next.text))
      && Boolean(actualOwner?.source_ids?.includes(next.sourceId))))
  const missing = difference.reason === 'missing' || Boolean(laterOriginal) || truncated
  const owner = turn && owners.find(candidate => candidate.shot_number === turn.shotNumber)
    || (missing ? (turn ? owners.filter(candidate => candidate.shot_number < turn.shotNumber).at(-1) || owners[0] : owners.at(-1)) : undefined)
  const shotNumber = missing ? owner?.shot_number ?? turn?.shotNumber ?? ordered.at(-1)?.shot_number : turn?.shotNumber ?? ordered.at(-1)?.shot_number
  const speaker = source?.speakerName ? `${source.speakerName}` : '原文'
  const detail = difference.reason === 'extra' ? '出现原文之外或重复的发声内容'
    : truncated ? `原文发声未在应有位置完整覆盖：${speaker}的这句原文只写了前半部分，缺少后半句「${remaining}」（原词逐字补在已写部分之后，同一子镜头或相邻时间行内承接）`
      : difference.reason === 'identity' && !missing ? '说话者或声音类型与原文不一致'
        : missing ? '原文发声未在应有位置完整覆盖' : '原文发声发生改词、遗漏、重复或逆序'
  return [{ code: 'dialogue_coverage', field: source ? `source_ids.${source.sourceId}` : 'description', severity: 'error',
    ...(shotNumber !== undefined ? { shotNumber } : {}),
    message: `${source ? `剧本原文单元${source.sourceId}：` : ''}${detail}；${shotNumber !== undefined ? `请补齐第${shotNumber}组，其他已完成组可继续保留` : '请先生成覆盖该原文的分镜草稿'}。` }, ...warnings]
}
