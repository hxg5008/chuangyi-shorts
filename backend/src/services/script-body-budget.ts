/**
 * Classify the written screenplay for duration arithmetic only. This module
 * never edits the original script or renumbers its nonempty source lines.
 * Unknown prose is deliberately kept; only explicit document metadata and
 * production-note structure are excluded.
 */
export interface ScriptBodyAnalysis {
  characters: number
  totalCharacters: number
  excludedCharacters: number
  bodyText: string
  includedSourceIds: number[]
  excludedSourceIds: number[]
  scope: 'script-body-v1'
}

const count = (value: string) => [...value].filter(character => /[\p{L}\p{N}]/u.test(character)).length
const episodeHeading = /^(?:第\s*[零〇一二三四五六七八九十百千万两0-9０-９]+\s*[集章回幕](?:$|[\s｜|:：.、—–-])|(?:EP(?:ISODE)?|CHAPTER)\s*\d+(?:\b|[\s｜|:：.、—–-]|$))/iu
const joinedEpisodeHeading = /^第\s*[零〇一二三四五六七八九十百千万两0-9０-９]+\s*[集章回幕][^，。！？；\r\n]*$/u
const sceneNumber = /^(?:S\d+(?:[-－]\d+)?|\d+[-－]\d+)(?=\s|[|｜:：])/iu
const scenePlace = /(?:内景|外景|内外景|INT\.?|EXT\.?|\bINT\.?\s*\/\s*EXT\.?\b|(?:^|[\s|｜·])(?:内|外)(?:$|[\s|｜·]))/iu
const metadataLabels = new Set([
  '人物', '出场人物', '登场人物', '角色', '人物名单', '角色名单', '角色列表', '演员表',
  '地点', '场景', '场景地点', '时间', '环境', '环境氛围', '氛围', '故事主线', '本集主线',
  '集数', '集名', '集标题', '本集标题', '标题', '剧名', '作者', '版本', '日期',
  '字数', '剧本字数', '总字数', '时长', '预计时长', '目标时长', '总时长', '画幅', '画面比例',
  'Characters', 'Cast', 'Location', 'Time', 'Atmosphere', 'Main Story', 'Title', 'Author', 'Version',
].map(value => value.toLowerCase()))
const noteLabels = /^(?:本集人物状态(?:与闭环)?|人物状态(?:与闭环)?|本集状态与闭环|本集闭环|状态与闭环|编剧备注|导演备注|制作备注|创作备注|创作说明|拍摄备注|制作说明|创作笔记|编剧说明|逻辑线|逻辑说明|本集总结|剧情总结|剧情梗概|剧情概述|内容概要|分集大纲|人物小传|角色小传|服化道说明|配音说明|创作要求|改编说明|校验说明|校验报告|审核意见|验收说明|Production Notes|Writer'?s? Notes|Summary)$/iu
const castingLabel = /^(?:首次人物建议|人物建议|造型建议|选角建议|首次角色建议)(?:\s*[（(][^）)]*[）)])?$/u
const bodyLabels = new Set(['正文', '剧本正文', '正文开始', '剧本开始', '剧情正文', '动作', '无台词动作', '旁白', '画外音', '画外声', '内心独白', '独白', '对白', '台词', 'OS', 'O.S.', 'VO', 'V.O.', 'Narration', 'Narrator', 'Action', 'Dialogue'].map(value => value.toLowerCase()))

function unwrap(raw: string) {
  let value = raw.trim().replace(/^\uFEFF/u, '')
  value = value.replace(/^#{1,6}(?:\s+|(?=第|S\d|\d+[-－]))/iu, '').trim()
  // Only wrapping emphasis is formatting. Bold prose is not a note section.
  while ((value.startsWith('**') && value.endsWith('**')) || (value.startsWith('__') && value.endsWith('__'))) {
    value = value.slice(2, -2).trim()
  }
  return value
}

function labelOf(line: string): { label: string; body: string; bracketed: boolean } | null {
  const bracket = line.match(/^(?:【([^】\r\n]{1,50})】|\[([^\]\r\n]{1,50})\])\s*[:：]?\s*(.*)$/u)
  if (bracket) return { label: (bracket[1] || bracket[2]).trim(), body: bracket[3], bracketed: true }
  const plain = line.match(/^(?:\*\*|__)?([^:：\r\n]{1,50})[:：](?:\*\*|__)?\s*(.*)$/u)
  return plain ? { label: plain[1].trim(), body: plain[2], bracketed: false } : null
}

function speakerLabel(label: string, knownNames: Set<string>, bracketed = false) {
  const bare = label.replace(/\s*[（(][^）)]*[）)]\s*$/u, '').trim()
  if (knownNames.has(bare)) return true
  // A compact leading name and colon is an explicit screenplay wrapper, not
  // an instruction to delete the utterance. Longer/ambiguous prose is kept.
  if (bracketed) return !metadataLabels.has(bare.toLowerCase()) && !noteLabels.test(bare) && !castingLabel.test(bare)
  // Without a cast list, only short name/role-shaped labels are explicit.
  // Narrative introductions such as “他的眼前只有一个念头：” remain body.
  if (/^(?:他的|她的|它的|他们的|她们的|我的|我们的|你的|你们的|此时|随后|这时|突然|于是|然而)/u.test(bare)
    || /(?:写着|出现|想到|心想|看见|听见|念头|结果|情况|一幕)$/u.test(bare)
    || /^(?:开场|收尾|闪回|回忆|画面|镜头|转场|场面|内容|故事)$/u.test(bare)) return false
  return /^[\p{Script=Han}·]{1,6}$/u.test(bare)
    || /^[\p{Script=Latin}][\p{Script=Latin}.'’-]{0,39}$/u.test(bare)
    || /^(?:[\p{L}][\p{L}.'’-]*\s+){1,4}[\p{L}][\p{L}.'’-]*$/u.test(bare)
}

function knownNamesFrom(label: string, body: string, names: Set<string>) {
  if (!/^(?:人物|出场人物|登场人物|角色|人物名单|角色名单|角色列表|characters|cast)$/iu.test(label)) return
  for (const item of body.split(/[、，,;；]/u)) {
    const name = item.replace(/[（(][^）)]*[）)]/gu, '').replace(/[。.]$/u, '').trim()
    if (name && name.length <= 60) names.add(name)
  }
}

export function analyzeScriptBody(script: string): ScriptBodyAnalysis {
  const units = script.split(/\r\n|\n|\r/).filter(line => Boolean(line.trim()))
  const includedSourceIds: number[] = [], excludedSourceIds: number[] = [], body: string[] = []
  const names = new Set<string>()
  let notesSection = false
  let metadataSection: string | null = null
  for (const [index, raw] of units.entries()) {
    const id = index + 1, value = unwrap(raw)
    const bullet = /^\s*(?:[-*+•·]|\d+[.)、])\s+/u.test(value)
    const line = bullet ? value.replace(/^\s*(?:[-*+•·]|\d+[.)、])\s+/u, '') : value
    const label = labelOf(line)
    const labelName = label?.label.toLowerCase()
    const bodyMarker = labelName !== undefined && bodyLabels.has(labelName)
    const explicitAction = /^[▲△]/u.test(line) || /^(?:动作|无台词动作|Action)\s*[:：]/iu.test(line)
    const sceneHeading = sceneNumber.test(line) && scenePlace.test(line)
      || /^(?:INT\.?|EXT\.?|INT\.?\s*\/\s*EXT\.?)\s+/iu.test(line)
    const isEpisode = episodeHeading.test(line) || joinedEpisodeHeading.test(line)
      || /^\s*#{1,6}\s*第\s*[零〇一二三四五六七八九十百千万两0-9０-９]+\s*[集章回幕]/u.test(raw)
    const bareLabel = line.replace(/[:：]\s*$/u, '').trim()
    const noteTitle = noteLabels.test(label?.label || bareLabel)
    const casting = castingLabel.test(label?.label || bareLabel)
    const metadata = labelName !== undefined && metadataLabels.has(labelName)
    const bodyOnlyTitle = bodyLabels.has(bareLabel.toLowerCase())
    const actualSpeech = !!label && !metadata && !noteTitle && !casting && speakerLabel(label.label, names, label.bracketed)

    if (sceneHeading || isEpisode) {
      notesSection = false; metadataSection = null; excludedSourceIds.push(id); continue
    }
    if (metadata) {
      knownNamesFrom(label!.label, label!.body, names)
      metadataSection = label!.body.trim() ? null : label!.label
      excludedSourceIds.push(id); continue
    }
    if (noteTitle || casting) {
      excludedSourceIds.push(id)
      notesSection = noteTitle
      metadataSection = null
      continue
    }
    if (/^(?:```|~~~)/u.test(line) || /^(?:[-*_]\s*){3,}$/u.test(line)) {
      excludedSourceIds.push(id); continue
    }
    if (metadataSection) {
      if (!bodyMarker && !bodyOnlyTitle && !explicitAction && !actualSpeech
        && (bullet || !/[。！？!?]/u.test(line) && line.length <= 160)) {
        knownNamesFrom(metadataSection, line, names)
        // A bare value occupies one metadata line. Only an explicit list may
        // continue; do not swallow following unpunctuated narrative forever.
        if (!bullet) metadataSection = null
        excludedSourceIds.push(id); continue
      }
      metadataSection = null
    }
    if (bodyMarker || bodyOnlyTitle || explicitAction || actualSpeech && !bullet) notesSection = false
    else if (notesSection && bullet) { excludedSourceIds.push(id); continue }
    else if (notesSection) notesSection = false

    if (bodyOnlyTitle) { notesSection = false; excludedSourceIds.push(id); continue }
    let content = line
    if (label && (bodyMarker || actualSpeech)) {
      const delivery = label.label.match(/([（(][^）)]*[）)])\s*$/u)?.[1] || ''
      content = delivery + label.body
    }
    content = content.replace(/^[▲△]\s*/u, '').trim()
    if (!content) { excludedSourceIds.push(id); continue }
    includedSourceIds.push(id); body.push(content)
  }
  const bodyText = body.join('\n'), characters = count(bodyText), totalCharacters = count(script)
  return { characters, totalCharacters, excludedCharacters: totalCharacters - characters, bodyText,
    includedSourceIds, excludedSourceIds, scope: 'script-body-v1' }
}
