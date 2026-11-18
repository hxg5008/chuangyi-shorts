/** Explicit screenplay speech only; no model, database or translation is involved. */
export interface ScriptDialogue {
  speakerName?: string
  kind: 'dialogue' | 'offscreen' | 'narration'
  text: string
  /** Available only on request; ordinary dialogue does not prescribe camera framing. */
  presentationExplicit?: boolean
}

const SPEAKING_VERB = /^(?:说道|回答|问道|喊道|说|问|答|喊|says?|said|asks?|asked|言う|話す|語る|말한다|말했다|대답한다)\s*(?:[:：]\s*|(?=[「“"『‘']))/i
const VOICE_LABEL = /^(旁白|画外音|画外声|内心独白|独白|OS|O\.S\.|VO|V\.O\.|narrator|narration|voice[- ]?over|off[- ]?screen|ナレーション|내레이션)(?=\s*[:：（(])/i
const QUOTED_SPEECH = /((?:说道|回答|问道|喊道|说|问|答|喊|旁白|画外音|独白|言う|話す|語る|ナレーション|말한다|말했다|대답한다|내레이션|\bOS\b|\bV\.?O\.?\b|\bsays?\b|\bsaid\b|\basks?\b|\basked\b|\bnarrat(?:or|ion)\b|\bvoice[- ]?over\b))\s*[:：]?\s*[「“"『‘']([^」”"』’'\n]+)[」”"』’']/giu

function leadingDirections(value: string): { text: string; directions: string } {
  let text = value.trim()
  const directions: string[] = []
  while (text.startsWith('（') || text.startsWith('(')) {
    const closing: string[] = []
    let end = -1
    for (let index = 0; index < text.length; index++) {
      const character = text[index]
      if (character === '（') closing.push('）')
      else if (character === '(') closing.push(')')
      else if (character === '）' || character === ')') {
        if (closing.pop() !== character) break
        if (!closing.length) { end = index; break }
      }
    }
    if (end < 0) break
    directions.push(text.slice(1, end))
    text = text.slice(end + 1).trimStart()
  }
  return { text: text.trim(), directions: directions.join(' ') }
}

function speechKind(context: string, fallback: ScriptDialogue['kind'] = 'dialogue'): ScriptDialogue['kind'] {
  if (/旁白|内心独白|独白|narrat(?:or|ion)|ナレーション|내레이션/i.test(context)) return 'narration'
  if (/画外(?:音|声)?|off[- ]?screen|voice[- ]?over|(?:^|[^a-z])(?:OS|O\.S\.|VO|V\.O\.)(?:$|[^a-z])/i.test(context)) return 'offscreen'
  return fallback
}

function unquotedPresentationContext(context: string) {
  // Quoted words on a sign or in an acting note are not screenplay voice labels.
  return context.replace(/「[^」]*」|『[^』]*』|“[^”]*”|‘[^’]*’|"[^"\r\n]*"|'[^'\r\n]*'/gu, ' ')
}

function explicitSourcePresentation(context: string) {
  return /画内(?:音|声)?|已入镜|同场对白|旁白|内心独白|独白|画外(?:音|声)?|off[- ]?screen|voice[- ]?over|narrat(?:or|ion)|ナレーション|내레이션|(?:^|[^a-z])(?:OS|O\.S\.|VO|V\.O\.)(?:$|[^a-z])/iu.test(context)
}

function leadingQuotedDialogue(value: string): { text: string; rest: string } | null {
  const pairs: Record<string, string> = { '「': '」', '“': '”', '"': '"', '『': '』', '‘': '’', "'": "'" }
  const closing = pairs[value[0]]
  if (!closing) return null
  for (let index = 1; index < value.length; index++) {
    if (value[index] !== closing || value[index - 1] === '\\') continue
    // A straight apostrophe inside a word is not a closing quotation mark.
    if (closing === "'" && /\p{L}/u.test(value[index - 1]) && /\p{L}/u.test(value[index + 1] || '')) continue
    return { text: value.slice(1, index), rest: value.slice(index + 1) }
  }
  return null
}

/** Preserve original spoken words and order, removing only screenplay wrappers. */
export function extractScriptDialogue(script: string, characterNames: readonly string[], options: { includePresentation?: boolean } = {}): ScriptDialogue[] {
  const names = [...new Set(characterNames)].filter(Boolean).sort((a, b) => b.length - a.length)
  const result: ScriptDialogue[] = []
  const appendQuotedProse = (line: string) => {
    for (const match of line.matchAll(QUOTED_SPEECH)) {
      const before = line.slice(0, match.index).trimEnd()
      const speakerName = names.find(name => before.endsWith(name))
      const text = match[2]
      if (text.trim()) result.push({ ...(speakerName ? { speakerName } : {}), kind: speechKind(match[1]), text,
        ...(options.includePresentation ? { presentationExplicit: explicitSourcePresentation(match[1]) } : {}) })
    }
  }
  const append = (body: string, context: string, speakerName?: string, fallback: ScriptDialogue['kind'] = 'dialogue') => {
    const spoken = leadingDirections(body)
    // In prose, a leading quote explicitly ends the utterance; following actions
    // such as "陈默点头" are not dialogue. Unquoted speech keeps internal quotes.
    const quoted = leadingQuotedDialogue(spoken.text)
    const text = quoted ? quoted.text : spoken.text
    const presentationContext = options.includePresentation ? unquotedPresentationContext(`${context} ${spoken.directions}`) : `${context} ${spoken.directions}`
    if (text.trim()) result.push({ ...(speakerName ? { speakerName } : {}), kind: speechKind(presentationContext, fallback), text,
      ...(options.includePresentation ? { presentationExplicit: explicitSourcePresentation(presentationContext) } : {}) })
    if (quoted) appendQuotedProse(quoted.rest)
  }
  for (const raw of script.split(/\r\n|\n|\r/)) {
    const line = raw.trim()
    if (!line) continue
    // Screenplays may use a speaker tag as the delimiter itself, e.g.
    // 【旁白】原词 or [Julian Ashford] "Original words". Only known speakers
    // and explicit voice labels qualify; arbitrary visual/metadata tags do not.
    const bracket = line.match(/^(?:【([^】\r\n]{1,120})】|\[([^\]\r\n]{1,120})\])\s*[:：]?\s*(.*)$/u)
    if (bracket) {
      const tag = (bracket[1] || bracket[2]).trim(), body = bracket[3]
      const voice = `${tag}:`.match(VOICE_LABEL)
      if (voice) {
        const annotation = leadingDirections(tag.slice(voice[0].length))
        if (!annotation.text) {
          const speakerName = names.find(name => annotation.directions.trim() === name)
          append(body, `${voice[1]} ${annotation.directions}`, speakerName, 'narration')
          continue
        }
      }
      const speaker = names.find(name => tag.startsWith(name) && !leadingDirections(tag.slice(name.length)).text)
      if (speaker) {
        const annotation = leadingDirections(tag.slice(speaker.length))
        append(body, annotation.directions, speaker)
        continue
      }
    }
    let named = false
    for (const name of names) {
      if (!line.startsWith(name)) continue
      const annotation = leadingDirections(line.slice(name.length))
      const prefix = annotation.text.match(/^[:：]\s*/) || annotation.text.match(SPEAKING_VERB)
      if (!prefix) continue
      append(annotation.text.slice(prefix[0].length), annotation.directions, name)
      named = true
      break
    }
    if (named) continue
    const label = line.match(VOICE_LABEL)
    if (label) {
      const annotation = leadingDirections(line.slice(label[0].length))
      const colon = annotation.text.match(/^[:：]\s*/)
      if (colon) {
        const speakerName = names.find(name => annotation.directions.trim() === name)
        append(annotation.text.slice(colon[0].length), `${label[1]} ${annotation.directions}`, speakerName, 'narration')
        continue
      }
    }
    // Explicit speech in prose remains supported. An unknown heading with only
    // a colon is not sufficient evidence of dialogue.
    appendQuotedProse(line)
  }
  return result
}
