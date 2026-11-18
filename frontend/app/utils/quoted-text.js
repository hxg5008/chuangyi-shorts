/** Same source-word boundary rules as backend/src/utils/quoted-text.ts. */
export function splitQuotedText(value) {
  const pairs = { '「': '」', '『': '』', '“': '”', '‘': '’', '"': '"', "'": "'" }
  const word = (character = '') => /[\p{Script=Latin}\p{N}]/u.test(character)
  const segments = []
  let from = 0
  for (let index = 0; index < value.length; index++) {
    const open = value[index], close = pairs[open]
    if (!close || open === "'" && (word(value[index - 1])
      || !/[:：]\s*$/.test(value.slice(0, index)) && /^'(?:tis|twas|em|cause|cuz|\d{2,4}s)\b/i.test(value.slice(index)))) continue
    let depth = 1, end = index + 1
    for (; end < value.length; end++) {
      if (value[end] === '\\') { end++; continue }
      if (open !== close && value[end] === open) depth++
      if (value[end] !== close || (close === "'" || close === '’') && word(value[end - 1]) && word(value[end + 1])) continue
      if (!--depth) break
    }
    if (end === value.length && open === "'" && !/[:：]\s*$/.test(value.slice(0, index))) continue
    if (index > from) segments.push({ text: value.slice(from, index), quoted: false })
    const finish = Math.min(end + 1, value.length)
    segments.push({ text: value.slice(index, finish), quoted: true })
    from = finish; index = finish - 1
  }
  if (from < value.length) segments.push({ text: value.slice(from), quoted: false })
  return segments
}
