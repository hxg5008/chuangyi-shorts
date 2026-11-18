/** Deterministic checks for an Agent's candidate, before any production write.
 * These checks establish structure, not the truth of acting, continuity or story semantics.
 */
import { cameraCuts } from './camera-cuts.js'
import { isReferencedTargetOnly } from './reference-semantics.js'
export interface ValidationIssue {
  storyboardId?: number
  shotNumber?: number
  field: string
  code: string
  message: string
  severity: 'error' | 'warning'
}

export interface StoryboardValidationInput {
  storyboardId?: number
  shotNumber?: number
  duration: number
  description: string
  videoPrompt: string
  characters?: Array<{ id: number; name: string }>
  scenes?: Array<{ id: number; location: string }>
  props?: Array<{ id: number; name: string }>
  characterIds?: number[]
  sceneId?: number | null
  propIds?: number[]
  shotParticipants?: Array<{ shotNumber: number; characterId: number; visibility: 'face_visible' | 'face_hidden' | 'offscreen' | 'uncertain' }>
}

interface DescriptionShot { number: number; text: string }
interface TimeRow { start: number; end: number; text: string }

const SHOT_MARKER = /[【\[]\s*(?:镜头|shot|ショット|カット|컷|샷)\s*(\d+)\s*[】\]]/gi
const TIME_ROW = /^\s*(?:\[|【)?\s*(\d+(?:\.\d+)?)\s*(?:秒|초|s(?:ec(?:onds?)?)?)?\s*[-—–~～〜至]\s*(\d+(?:\.\d+)?)\s*(?:秒|초|s(?:ec(?:onds?)?)?)?\s*(?:\]|】)?\s*[:：]\s*(.+)$/i
// A framing word elsewhere in a sentence is not evidence that this person's face
// is visible. Prefer an explicit face, facial action, or their own frontal/profile shot.
const FACE_DETAIL = /(?:五官|面部|脸部|正脸|侧脸|眉眼|眼神).{0,5}(?:清晰|可辨|可见|特写)|(?:面部|脸部|正脸|侧脸)特写|眨眼|轻眨|(?:眼睛|双眼|眼眸)(?:(?:正(?:在)?|轻轻|缓缓)\s*)?眨动|眼睑|瞳孔|眉心|眉头|嘴角|嘴唇|下颌|神情|表情|\bface\s+(?:is\s+)?(?:visible|clear)|facial\s+(?:expression|close[- ]?up)|\bblinks?\b/i
const FACE_FRAME = /(?:正面|侧面|侧脸).{0,8}(?:中景|近景|特写|清晰入镜|入镜)|(?:中景|近景|特写).{0,8}(?:正面|侧面|侧脸)|(?:frontal|front|profile).{0,12}(?:close[- ]?up|medium\s+shot)/i
const FACE_HIDDEN = /背影|背面|背对镜头|面部不可见|(?:五官|面部|脸部|神情).{0,4}(?:不可辨|无法辨|看不清|不可见)|看不到(?:脸|面部)|(?:脸|面部).{0,4}(?:被遮|遮住)|仅(?:拍|见|有|露出|拍到|看到).{0,5}(?:手|脚)|(?:手|脚|足)部特写|back\s+view|from\s+behind|silhouette|(?:hand|foot)[- ]?only|(?:hand|foot)\s+close[- ]?up|face\s+(?:is\s+)?(?:hidden|not\s+visible)/i
const OFFSCREEN_START = /^\s*(?:[（(]\s*(?:OS|V\.?O\.?)\s*[）)]|(?:仅|只)?(?:在|为|作为|以)?\s*(?:画外(?:音|发声|声)?|旁白|OS\b|V\.?O\.?\b|off[- ]?screen|voice[- ]?over)|的声音.{0,8}(?:画外|off[- ]?screen))/i
const OFFSCREEN_PREFIX = /(?:画外(?:音|声)?(?:的)?|旁白|\bOS|\bV\.?O\.?|off[- ]?screen|voice[- ]?over)\s*[:：]?\s*@?\s*$/i
const SPEECH = /(?:说|问|答|喊|旁白|画外音|独白|言う|話す|語る|ナレーション|独白|말한다|말했다|대답한다|내레이션|독백|보이스오버|\bOS\b|\bV\.?O\.?\b|\bsays?\b|\basks?\b|\bnarrat(?:ion|or)\b|\bvoice[- ]?over\b)\s*[:：]?\s*[「“"]([^」”"\n]+)[」”"]/giu
const NARRATION = /(?:旁白|画外音|独白|ナレーション|独白|내레이션|독백|보이스오버|\bnarration\b|\bvoice[- ]?over\b)\s*[:：]\s*([^。\n【\[]+)/gi
const AGE = /(?:\d{1,3}|[零〇一二两三四五六七八九十百]{1,6})\s*(?:[多余来几]?[岁歳]|세)|(?<![第\d零〇一二两三四五六七八九十百])(?:[1-9]\d|[一二三四五六七八九]?十)代(?!目)|(?:\d{1,3}|[零〇一二两三四五六七八九十百]{1,6})\s*出头(?!\s*(?:米|厘米|毫米|公里|步|秒|分|度))|青年|少年|中年|老年|壮年|幼年|幼童|儿童|幼儿|婴儿|童声|年轻|成年|稚嫩|若い|成人|子供|중년|청년|노년|어린|성인|\byoung\b|middle[- ]aged|\belderly\b|\badult\b|\bchild\b|\bteen(?:age)?\b|years?[- ]old/i
const REGISTER = /音域|低音|中音|高音|低中|中高|低沉|偏低|偏高|음역|저음|중음|고음|\bbaritone\b|\btenor\b|\balto\b|\bbass\b|\bsoprano\b|\bpitch\b|\bregister\b/i
const TIMBRE = /音色|嗓音|声线|沙哑|清亮|浑厚|温润|磁性|清脆|粗粝|声質|かすれ|柔らかい声|澄んだ声|음색|목소리|허스키|맑은|따뜻한|\btimbre\b|\braspy\b|\bhusky\b|\bwarm\b|\bclear\b|\bbreathy\b/i
const SPEECH_RATE = /每秒\s*\d+(?:\.\d+)?\s*字|毎秒\s*\d+(?:\.\d+)?\s*(?:字|文字)|1\s*秒(?:あたり|当たり)\s*\d+(?:\.\d+)?\s*(?:字|文字)|초당\s*\d+(?:\.\d+)?\s*(?:자|글자|단어)|\d+(?:\.\d+)?\s*(?:字|文字|자|글자)\s*[/／]\s*(?:秒|초|s)|\d+(?:\.\d+)?\s*(?:characters?|words?)\s*(?:per\s+second|\/s)|(?:characters?|words?)\s*per\s*second\s*[:：]?\s*\d/i

function hasVoiceAge(text: string, characterNames: readonly string[]): boolean {
  // Spoken words cannot stand in for the speaker's voice profile. When the
  // renderer provides an explicit age field, check that field rather than a
  // nearby visual fact or another part of the voice description.
  const facts = text.replace(/[「“"][^」”"\n]*[」”"]/g, '')
  const labels = [...facts.matchAll(/(?:听感年龄|年龄听感|年龄感|年龄|\bage(?:\s+impression)?\b|声の年齢感|年齢感|목소리\s*나이감)\s*[:：]?\s*([^，,。；;\n]*)/gi)]
  const valid = (value: string) => {
    const age = value.trim().replace(/^(?:听感|年龄)(?:为|是)?\s*/, '')
    return !/^(?:未知|未填(?:写)?|未提供|未标注|不详|无法判断|无法确定|待定|待填)/.test(age) && AGE.test(age)
  }
  if (labels.length) return labels.some(match => valid(match[1]))
  const names = [...new Set(characterNames)].filter(Boolean).sort((a, b) => b.length - a.length)
  const identifiers = names.map(name => /^[\p{Script=Latin}\d_ ]+$/u.test(name)
    ? `(?<![\\p{Script=Latin}\\d_])${escapeRegex(name)}(?![\\p{Script=Latin}\\d_])` : escapeRegex(name))
  return AGE.test(identifiers.length ? facts.replace(new RegExp(identifiers.join('|'), 'gu'), '') : facts)
}

function descriptionShots(text: string): DescriptionShot[] {
  const markers = [...text.matchAll(SHOT_MARKER)]
  return markers.map((match, index) => ({
    number: Number(match[1]),
    text: text.slice(match.index! + match[0].length, markers[index + 1]?.index ?? text.length).trim(),
  }))
}

function speeches(text: string, includeContinuationQuotes = false): string[] {
  const quoted = [...text.matchAll(includeContinuationQuotes ? /[「“"]([^」”"\n]+)[」”"]/g : SPEECH)]
    .map(match => ({ index: match.index!, text: match[1] }))
  // Narration may be written without quotation marks; do not count it twice.
  for (const match of text.matchAll(NARRATION)) {
    const value = match[1].trim()
    if (value && !/^[「“"]/.test(value)) quoted.push({ index: match.index!, text: value })
  }
  return quoted.sort((a, b) => a.index - b.index).map(part => part.text)
}

/** Dialogue fragments only, in description/shot order; visual prose is excluded. */
export function extractStoryboardDialogue(description: string): string[] {
  const text = String(description ?? '')
  const shots = descriptionShots(text)
  return shots.length ? shots.flatMap(shot => speeches(shot.text)) : speeches(text)
}

const compactDialogue = (text: string) => text.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '')
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function dialoguePreserved(expected: string[], actual: string[]): boolean {
  const source = expected.map(compactDialogue).filter(Boolean)
  const parts = actual.map(compactDialogue).filter(Boolean)
  let turn = 0
  let continuation = ''
  for (const part of parts) {
    continuation += part
    if (turn >= source.length || !source[turn].startsWith(continuation)) return false
    if (continuation === source[turn]) { turn++; continuation = '' }
  }
  return turn === source.length && !continuation
}

function namedSpeakers(text: string, names: string[]): string[] {
  return names.filter(name => new RegExp(`${escapeRegex(name)}\\s*(?:[（(][^）)]{1,30}[）)])?\\s*(?:は|が|이|가)?\\s*(?:说|问|答|喊|说道|回答|言う|話す|語る|말한다|말했다|대답한다|says?|asks?)\\s*[:：]?\\s*[「“"]`, 'iu').test(text))
}

function speakerContexts(text: string, name: string, names: string[]): string {
  const contexts: string[] = []
  let from = 0
  while (from < text.length) {
    const index = text.indexOf(name, from)
    if (index < 0) break
    let end = text.length
    for (const other of names.filter(value => value !== name)) {
      const next = text.indexOf(other, index + name.length)
      if (next >= 0) end = Math.min(end, next)
    }
    // A preceding description is usable only if it does not belong to a different
    // speaker in the same clause. Do not let one person's voice satisfy another's.
    const prefix = text.slice(0, index)
    const boundary = Math.max(prefix.lastIndexOf('。'), prefix.lastIndexOf('；'), prefix.lastIndexOf(';'), prefix.lastIndexOf('\n')) + 1
    const clausePrefix = text.slice(boundary, index)
    const start = names.some(other => other !== name && clausePrefix.includes(other)) ? index : boundary
    contexts.push(text.slice(start, end))
    from = index + name.length
  }
  return contexts.join('\n')
}

type Visibility = 'face_visible' | 'face_hidden' | 'offscreen' | 'uncertain'
interface CharacterContext { own: string; prefix: string; target: boolean; emotion: string }

function characterContexts(raw: string, name: string, allNames: string[]): CharacterContext[] {
  // Dialogue is checked separately. Mentioning a face in a spoken line is not a shot.
  const text = raw.replace(/[「“"][^」”"\n]*[」”"]/g, value => ' '.repeat(value.length))
  const alternatives = [...new Set(allNames)].filter(Boolean).sort((a, b) => b.length - a.length).map(escapeRegex)
  if (!alternatives.length) return []
  const mentions = [...text.matchAll(new RegExp(alternatives.join('|'), 'g'))].filter(match => {
    if (!/^[\p{Script=Latin}\d_ ]+$/u.test(match[0])) return true
    return !/[\p{Script=Latin}\d_]/u.test(text[match.index! - 1] || '') && !/[\p{Script=Latin}\d_]/u.test(text[match.index! + match[0].length] || '')
  })
  const boundary = (before: string) => Math.max(...['。', '！', '？', '!', '?', '；', ';', '\n'].map(mark => before.lastIndexOf(mark))) + 1
  const hasPerson = (value: string) => allNames.some(person => value.includes(person))
  const starts = mentions.map(match => {
    const index = match.index!
    const before = text.slice(0, index)
    let start = boundary(before)
    if (hasPerson(text.slice(start, index))) {
      // A preposed camera/face clause can belong to the upcoming person, but a
      // gaze or dialogue target cannot inherit the previous person's close-up.
      const soft = Math.max(before.lastIndexOf('，'), before.lastIndexOf(',')) + 1
      const tail = text.slice(soft, index)
      start = (FACE_FRAME.test(tail) || /[%％].{0,6}的\s*@?\s*$/.test(tail)) && !hasPerson(tail) ? soft : index
    }
    return start
  })
  return mentions.flatMap((match, index) => {
    if (match[0] !== name) return []
    const position = match.index!
    const end = mentions[index + 1] ? Math.min(mentions[index + 1].index!, starts[index + 1]) : text.length
    const ownText = text.slice(position + name.length, end)
    const firstBoundary = ownText.search(/[。！？!?；;\n]/)
    const prefix = text.slice(starts[index], position)
    const marked = text[position - 1] === '@'
    const target = isReferencedTargetOnly(text, marked ? position - 1 : position, name.length, marked ? 1 : 0)
    let emotionPrefix = prefix
    // An immediately preceding, unnamed emotion sentence is attributable only
    // when it names no other person. Never borrow another person's percentage.
    if (!hasPerson(prefix) && prefix.length <= 50 && starts[index] > 0) {
      const previousEnd = starts[index] - 1
      const previous = text.slice(boundary(text.slice(0, previousEnd)), previousEnd)
      if (previous.length <= 80 && /[%％]/.test(previous) && !hasPerson(previous)) emotionPrefix = previous + prefix
    }
    return [{ own: firstBoundary < 0 ? ownText : ownText.slice(0, firstBoundary), prefix, target, emotion: emotionPrefix + name + ownText }]
  })
}

function textualVisibility(contexts: CharacterContext[]): { visibility: Visibility; conflict: boolean } {
  let face = false, hidden = false, offscreen = false
  for (const context of contexts) {
    const concealed = FACE_HIDDEN.test(context.own) || FACE_HIDDEN.test(context.prefix)
    const voiceOnly = OFFSCREEN_START.test(context.own) || OFFSCREEN_PREFIX.test(context.prefix)
    // Remove negative face statements before checking positive detail words.
    const visibleOwn = context.own.replace(new RegExp(FACE_HIDDEN.source, 'gi'), '')
      .replace(/(?:看向|望向|注视|望着|盯着|追视|看着|告诉|询问)[^，,。；;\n]{0,5}?(?:他|她|对方|那人|其)[^，,。；;\n]{0,8}?(?:面部|脸部|五官|眉眼|眼神|嘴角|嘴唇|下颌|神情|表情)/g, '')
    const visible = !context.target && (FACE_DETAIL.test(visibleOwn) || FACE_FRAME.test(visibleOwn) || FACE_FRAME.test(context.prefix))
    face ||= visible
    hidden ||= concealed
    offscreen ||= voiceOnly
  }
  const conflict = face && (hidden || offscreen)
  return { visibility: conflict ? 'uncertain' : face ? 'face_visible' : hidden ? 'face_hidden' : offscreen ? 'offscreen' : 'uncertain', conflict }
}

export function validateStoryboard(input: StoryboardValidationInput): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const issue = (field: string, code: string, message: string, severity: 'error' | 'warning' = 'error') => {
    issues.push({ storyboardId: input.storyboardId, shotNumber: input.shotNumber, field, code, message, severity })
  }
  const description = String(input.description ?? '').trim()
  const prompt = String(input.videoPrompt ?? '').trim()
  const duration = Number(input.duration)
  if (!Number.isFinite(duration) || duration < 8 || duration > 15) {
    issue('duration', 'duration_range', '分镜时长必须在 8–15 秒内 / Duration must be between 8 and 15 seconds.')
  }
  const shots = descriptionShots(description)
  if (shots.length < 2 || shots.length > 4) {
    issue('description', 'shot_count', 'description 必须包含 2–4 个【镜头N】或 [Shot N] 子镜头。')
  }
  if (shots.some((shot, index) => shot.number !== index + 1 || !shot.text)) {
    issue('description', 'shot_order', 'description 子镜头须从 1 连续编号，每个镜头必须有内容 / Shot numbers must be consecutive from 1.')
  }
  const dialogue = shots.flatMap(shot => speeches(shot.text))
  if (dialogue.length && Number.isFinite(duration)) {
    const text = dialogue.join('')
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) {
      const count = [...text].filter(char => /[\p{L}\p{N}]/u.test(char)).length
      const required = count / 4.5 + 2
      if (required > duration + 0.001) issue('duration', 'dialogue_budget', `台词约 ${count} 字，至少需 ${required.toFixed(1)} 秒（4.5 字/秒＋2 秒表演余量），请拆分而非提速。`)
    } else {
      issue('duration', 'dialogue_budget_language_review', '非中文台词的字数与口播预算需按实际语言复核；未套用中文 4.5 字/秒作硬拒绝。', 'warning')
    }
  }
  if (!prompt) {
    issue('video_prompt', 'prompt_empty', 'video_prompt 不能为空 / The video prompt must not be empty.')
    return issues
  }
  if ([...prompt].length > 3600) issue('video_prompt', 'prompt_length', 'video_prompt 不得超过 3600 字符 / Maximum 3600 characters.')

  const lines = prompt.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const header = lines[0] || ''
  if (!/(?:出场人物|人物|登場人物|出演者|등장\s*인물|출연\s*인물|characters?|cast|on[- ]screen)\s*[:：]/i.test(header)
    || !/(?:场景|シーン|場面|장면|scene|location)\s*[:：]/i.test(header)
    || !/[。.!！]$/.test(header)) {
    issue('video_prompt', 'information_header', '首行须为独立人物／场景信息头，并以句号结束 / Begin with a characters and scene header.')
  }
  const globalRules = [
    /无字幕|字幕(?:なし|無し)|자막\s*(?:없음|금지)|no\s+subtitles?/i,
    /无背景音乐|(?:BGM|背景音楽)(?:なし|無し)|배경\s*음악\s*(?:없음|금지)|no\s+(?:background\s+music|bgm)/i,
    /(?:不出现|无|禁止).{0,12}(?:克隆|复制人)|(?:クローン|複製人間)(?:なし|無し|禁止)|복제\s*인간\s*(?:금지|없음)|no\s+(?:clones?|duplicat(?:ed|e)\s+(?:people|characters?))/i,
    /不越轴|軸を越えない|축을\s*넘지\s*않(?:는다|음)|(?:do\s+not|don['’]t|never)\s+cross\s+(?:the\s+)?(?:axis|180)|same\s+side\s+of\s+(?:the\s+)?axis/i,
  ]
  if (globalRules.some(rule => !rule.test(header))) {
    issue('video_prompt', 'global_constraints', '信息头末尾须包含无字幕、无背景音乐、人物不克隆与不越轴约束 / Add the required global constraints to the header.')
  }

  const rows: TimeRow[] = []
  for (const [index, line] of lines.slice(1).entries()) {
    const match = line.match(TIME_ROW)
    if (!match) {
      issue('video_prompt', 'time_row_format', `信息头后第 ${index + 1} 行须为“0-3秒：自然段”或“0-3s: paragraph”格式，不另加说明。`)
      continue
    }
    rows.push({ start: Number(match[1]), end: Number(match[2]), text: match[3] })
  }
  if (Number.isFinite(duration) && duration > 0) {
    const expectedCount = Math.ceil(duration / 3)
    if (rows.length !== expectedCount) issue('video_prompt', 'time_row_count', `应有 ${expectedCount} 个连续时间行，最后一行保留实际余量 / Expected ${expectedCount} time rows.`)
    if (rows.some((row, index) => Math.abs(row.start - index * 3) > 0.001
      || Math.abs(row.end - Math.min((index + 1) * 3, duration)) > 0.001 || row.end <= row.start)) {
      issue('video_prompt', 'time_axis', '时间轴必须从 0 开始、每 3 秒连续分段且末段精确结束于 duration，无重叠或空缺。')
    }
  }
  if (rows.length && (!/A\s*0/i.test(rows[0].text) || !/X/i.test(rows[0].text) || !/Y/i.test(rows[0].text))) {
    issue('video_prompt', 'spatial_origin', '首个时间行必须明确固定原点 A0 与 X、Y 空间轴 / Establish A0, X and Y in the first time row.')
  }

  const characters = (input.characters || []).filter(value => input.characterIds == null || input.characterIds.includes(value.id))
  const scenes = (input.scenes || []).filter(value => value.id === input.sceneId)
  const props = (input.props || []).filter(value => input.propIds == null || input.propIds.includes(value.id))
  const names = [...new Set([...characters.map(value => value.name), ...scenes.map(value => value.location), ...props.map(value => value.name)].filter(Boolean))].sort((a, b) => b.length - a.length)
  const knownNames = [...new Set([...(input.characters || []).map(value => value.name), ...(input.scenes || []).map(value => value.location), ...(input.props || []).map(value => value.name)].filter(Boolean))].sort((a, b) => b.length - a.length)
  const boundReference = (rest: string) => {
    // An unbound longer name must not accidentally match a bound name's prefix.
    const known = knownNames.find(name => rest.startsWith(name))
    return known && names.includes(known) ? known : undefined
  }
  for (const [index, row] of rows.entries()) {
    let valid = 0
    for (const match of row.text.matchAll(/@/g)) {
      const rest = row.text.slice(match.index! + 1)
      const name = boundReference(rest)
      if (name) valid++
      else issue('video_prompt', 'unknown_reference', `第 ${index + 1} 时间行含未绑定或不准确的 @资产名；仅使用当前分镜绑定的正式名称。`)
    }
    if (!valid && names.length) issue('video_prompt', 'missing_reference', `第 ${index + 1} 时间行至少需要一个有效的已绑定 @素材引用。`)
  }
  // The header must not introduce an asset that the time rows themselves never validate.
  for (const match of header.matchAll(/@/g)) {
    if (!boundReference(header.slice(match.index! + 1))) issue('video_prompt', 'unknown_reference', '信息头含未绑定或不准确的 @资产名称。')
  }
  if (!names.length) issue('video_prompt', 'references_unavailable', '当前没有可用的绑定素材；纯环境可保留地点描述，需要参考素材时须补齐资产。', 'warning')

  const groups: TimeRow[][] = []
  for (const [index, row] of rows.entries()) {
    const cuts = cameraCuts(row.text)
    if (cuts.length > 1) issue('video_prompt', 'multiple_cuts_in_row', `第 ${index + 1} 时间行出现多次切镜，无法保持一个子镜头对应 1–2 行。`)
    if (index === 0 || cuts.length) groups.push([])
    groups.at(-1)!.push(row)
  }
  const mappingValid = groups.length === shots.length && groups.every(group => group.length >= 1 && group.length <= 2)
  if (shots.length && rows.length && !mappingValid) issue('video_prompt', 'shot_time_mapping', `须按 description 的 ${shots.length} 个子镜头顺序映射，每镜 1–2 行；换镜行用“切到／切回”或“cut to／cut back”明确边界。`)

  if (mappingValid) for (const [index, shot] of shots.entries()) {
    const body = groups[index].map(row => row.text).join('\n')
    for (const character of characters) {
      const planned = input.shotParticipants?.filter(person => person.shotNumber === shot.number && person.characterId === character.id).map(person => person.visibility) || []
      // Renderer metadata is authoritative about who this shot actually shows.
      // Text-only legacy/manual inputs still receive the conservative inference.
      if (input.shotParticipants !== undefined && !planned.length) continue
      const characterNames = (input.characters || []).map(value => value.name)
      const descriptionContexts = characterContexts(shot.text, character.name, characterNames)
      const promptContexts = characterContexts(body, character.name, characterNames)
      const evidence = textualVisibility([...descriptionContexts, ...promptContexts])
      if (!descriptionContexts.length && !promptContexts.length && !planned.length) continue
      let visibility = planned[0] || evidence.visibility
      const planConflict = new Set(planned).size > 1 || planned.some(value =>
        value === 'face_visible' && ['face_hidden', 'offscreen'].includes(evidence.visibility)
        || ['face_hidden', 'offscreen'].includes(value) && evidence.visibility === 'face_visible')
      if (evidence.conflict || planConflict) {
        visibility = planned.includes('face_visible') ? 'face_visible' : 'uncertain'
        issue('video_prompt', 'face_visibility_review', `子镜头 ${shot.number} 的 ${character.name} 面部可见性资料矛盾，需复核；已明确声明面部可见时仍须提供其神情与情绪百分比。`, 'warning')
      }
      if (visibility === 'face_hidden' || visibility === 'offscreen') continue
      const percentages = promptContexts.flatMap(context => [...context.emotion.matchAll(/(\d+(?:\.\d+)?)\s*[%％]/g)].map(match => Number(match[1])))
      const severity = visibility === 'face_visible' ? 'error' : 'warning'
      if (!percentages.length) issue('video_prompt', 'emotion_percentage', `子镜头 ${shot.number} 的 ${character.name} 缺少逐人神情及情绪百分比；面部可见性不确定时仅提示复核。`, severity)
      else if (percentages.some(value => value < 0 || value > 100)) issue('video_prompt', 'emotion_percentage_range', `子镜头 ${shot.number} 的 ${character.name} 情绪百分比必须在 0–100% 内。`, severity)
    }
    const expectedSpeech = speeches(shot.text)
    const actualSpeech = speeches(body, expectedSpeech.length > 0)
    if (expectedSpeech.length || actualSpeech.length) {
      // Concatenating quoted continuation parts permits a long utterance to span
      // consecutive time rows, but not missing words, extra dialogue or reversed turns.
      if (!dialoguePreserved(expectedSpeech, actualSpeech)) {
        issue('video_prompt', 'dialogue_preservation', `子镜头 ${shot.number} 的台词／旁白未按原词与轮次完整保留；可跨连续时间行拆句，不得删词、改词或逆序。`)
      }
    }
    if (expectedSpeech.length) {
      if (!hasVoiceAge(body, (input.characters || []).map(character => character.name)) || !REGISTER.test(body) || !TIMBRE.test(body)) issue('video_prompt', 'voice_description', `发声子镜头 ${shot.number} 缺少听感年龄、音域或核心音色资料 / Include age impression, vocal register and timbre.`)
      if (!SPEECH_RATE.test(body)) issue('video_prompt', 'speech_rate', `发声子镜头 ${shot.number} 必须明确约每秒 x 字的口播速度 / Specify characters or words per second.`)
      const speakers = namedSpeakers(shot.text, (input.characters || []).map(value => value.name))
      for (const speaker of speakers) {
        const context = speakerContexts(body, speaker, speakers)
        if (!hasVoiceAge(context, (input.characters || []).map(character => character.name)) || !REGISTER.test(context) || !TIMBRE.test(context)) issue('video_prompt', 'speaker_voice_description', `发声子镜头 ${shot.number} 的 ${speaker} 缺少独立声音年龄、音域或音色资料，不能借用另一人物的描述。`)
        if (!SPEECH_RATE.test(context)) issue('video_prompt', 'speaker_speech_rate', `发声子镜头 ${shot.number} 的 ${speaker} 缺少独立口播速度。`)
      }
      if (!speakers.length) issue('video_prompt', 'speaker_attribution_review', `子镜头 ${shot.number} 的发声者无法可靠按正式人物名识别，请复核逐人声音资料和旁白／画外声归属。`, 'warning')
    }
  }
  issue('video_prompt', 'semantic_review_required', '自动校验仅覆盖可确定的结构；剧情忠实、逐人表演、台词声源、镜头语义与跨组空间承接仍需复核。', 'warning')
  return issues
}
