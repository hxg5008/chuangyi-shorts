import { splitQuotedText } from './quoted-text.js'

const variantSuffix = /^[_·•｜|\-]/u
const emailPrefix = /[A-Za-z0-9._%+-]/u
const latinWord = /[A-Za-z0-9_]/u
const tokenStop = /[\s@＠#、，,；;：:。！？!?()（）【】]/u
const asciiEmail = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?/gu

/** Project saved reference intent onto this shot's actual image selection.
 * Selected known image names receive one marker, unselected ones are plain text.
 * Unknown names and explicit variants stay visible for strict server validation.
 * Quoted dialogue, voice markers and email addresses are untouched.
 */
export function jimengMentionProjection(value, knownNames = [], selectedNames = []) {
  const raw = String(value || '')
  const counts = new Map()
  for (const value of knownNames) {
    const name = String(value || '')
    if (name) counts.set(name, (counts.get(name) || 0) + 1)
  }
  const selected = new Set(selectedNames.filter(Boolean).map(String))
  const names = [...counts.keys()].sort((a, b) => b.length - a.length)
  const hidden = [], added = [], markerChanges = []
  let output = '', offset = 0
  for (const segment of splitQuotedText(raw)) {
    if (segment.quoted) { output += segment.text; offset += segment.text.length; continue }
    const text = segment.text
    const emails = [...text.matchAll(asciiEmail)].map(m => ({ start: m.index, end: m.index + m[0].length }))
    const matchesName = (index, marked) => {
      const name = names.find(name => text.startsWith(name, index))
      if (!name || variantSuffix.test(text.slice(index + name.length))) return null
      if (latinWord.test(name[0]) && !marked && index && latinWord.test(text[index - 1])) return null
      if (latinWord.test(name.at(-1)) && latinWord.test(text[index + name.length] || '')) return null
      return name
    }
    for (let index = 0; index < text.length;) {
      const email = emails.find(range => index >= range.start && index < range.end)
      if (email) { output += text.slice(index, email.end); index = email.end; continue }
      const char = text[index]
      if (char === '#') {
        let end = index + 1
        while (end < text.length && !tokenStop.test(text[end])) end++
        output += text.slice(index, end); index = end; continue
      }
      const marked = char === '@' || char === '＠'
      let nameStart = index
      if (marked) while (nameStart < text.length && (text[nameStart] === '@' || text[nameStart] === '＠')) nameStart++
      const originalMarker = text.slice(index, nameStart)
      const name = matchesName(nameStart, marked)
      if (name) {
        if (counts.get(name) > 1) {
          output += text.slice(index, nameStart + name.length)
        } else {
          const displayedMarker = selected.has(name) ? '@' : ''
          if (originalMarker !== displayedMarker) {
            const change = { rawOffset: offset + index, displayOffset: output.length, originalMarker, displayedMarker, name }
            markerChanges.push(change)
            if (!displayedMarker) hidden.push({ ...change, marker: originalMarker })
            else if (!originalMarker) added.push({ ...change, marker: displayedMarker })
          }
          output += displayedMarker
          output += name
        }
        index = nameStart + name.length
      } else if (marked && !(index && emailPrefix.test(text[index - 1]))) {
        // Preserve the entire unknown reference token; do not inject a selected
        // short name inside an unregistered explicit variant or unknown token.
        let end = nameStart
        while (end < text.length && !tokenStop.test(text[end])) end++
        output += text.slice(index, end); index = end
      } else { output += char; index++ }
    }
    offset += segment.text.length
  }
  return { raw, text: output, hidden, added, markerChanges }
}

export function projectJimengSelectedMentions(value, knownNames, selectedNames) {
  return jimengMentionProjection(value, knownNames, selectedNames).text
}

/** Keep invisible reference markers outside a deliberate text edit, allowing a
 * later image re-selection to restore them. Never write projection-only changes
 * back to the saved prompt on blur.
 */
export function mergeJimengProjectedEdit(raw, edited, knownNames, selectedNames) {
  const projection = jimengMentionProjection(raw, knownNames, selectedNames)
  const next = String(edited || '')
  if (next === projection.text) return projection.raw
  let prefix = 0, suffix = 0
  while (prefix < next.length && prefix < projection.text.length && next[prefix] === projection.text[prefix]) prefix++
  while (suffix < next.length - prefix && suffix < projection.text.length - prefix &&
    next[next.length - suffix - 1] === projection.text[projection.text.length - suffix - 1]) suffix++
  const markers = projection.markerChanges.map(item => ({ ...item, width: item.displayedMarker.length + item.name.length })).flatMap(item => {
    if (item.displayOffset + item.width <= prefix) return [{ ...item, at: item.displayOffset }]
    if (item.displayOffset >= projection.text.length - suffix) return [{ ...item, at: item.displayOffset + next.length - projection.text.length }]
    return []
  }).sort((a, b) => b.at - a.at)
  let result = next
  for (const item of markers) result = result.slice(0, item.at) + item.originalMarker + result.slice(item.at + item.displayedMarker.length)
  return result
}
