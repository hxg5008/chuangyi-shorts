export interface SkillInstructionSource { source: string; text: string }
export interface SkillInstructionProvenance {
  source: string
  sourceIndex: number
  blockIndex: number
  headings: string[]
  sourceStart: number
  sourceEnd: number
  compiledStart: number
  compiledEnd: number
  referenceStart?: number
  referenceEnd?: number
  shared: boolean
  kind: 'content' | 'heading' | 'verbatim'
}
export interface CompiledSkillInstructions {
  instructions: string
  stats: {
    inputCharacters: number
    outputCharacters: number
    inputBlocks: number
    outputBlocks: number
    sharedBlocks: number
    duplicateBlocksRemoved: number
    duplicateCharactersRemoved: number
    fallbackSources: number
  }
  provenance: SkillInstructionProvenance[]
}

interface Line { start: number; end: number; text: string }
interface Block { start: number; end: number; text: string; headings: string[]; kind: SkillInstructionProvenance['kind'] }
const heading = (text: string) => text.match(/^ {0,3}(#{1,6})(?:[ \t]+|$)/)
const list = (text: string) => /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/.test(text)
const fence = (text: string) => text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
const indented = (text: string) => /^(?: {4}|\t)/.test(text)
const quoted = (text: string) => /^ {0,3}>/.test(text)
const divider = (text: string) => /^ {0,3}(?:-\s*){3,}$|^ {0,3}(?:\*\s*){3,}$|^ {0,3}(?:_\s*){3,}$/.test(text)

function linesOf(text: string): Line[] {
  const lines: Line[] = []
  for (const match of text.matchAll(/[^\r\n]+(?:\r\n|\r|\n|$)|(?:\r\n|\r|\n)/g)) {
    const body = match[0].replace(/(?:\r\n|\r|\n)$/, '')
    lines.push({ start: match.index!, end: match.index! + body.length, text: body })
  }
  return lines
}

/** Deliberately conservative Markdown boundaries. Uncertain containers stay verbatim. */
function blocksOf(text: string): { blocks: Block[]; fallback: boolean } {
  const lines = linesOf(text), blocks: Block[] = []
  let headings: Array<{ level: number; text: string }> = []
  const whole = () => ({ blocks: text.trim() ? [{ start: 0, end: text.length, text, headings: [], kind: 'verbatim' as const }] : [], fallback: Boolean(text.trim()) })
  const add = (from: number, to: number, kind: Block['kind']) => blocks.push({
    start: lines[from].start, end: lines[to].end, text: text.slice(lines[from].start, lines[to].end),
    headings: headings.map(value => value.text), kind,
  })
  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    if (!line.text.trim()) { index++; continue }
    // Raw HTML, Setext headings and frontmatter can carry scope across blank lines.
    // Do not reinterpret them as independent paragraphs or discard their framing.
    if (/^ {0,3}(?:<!--|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s|>|\/))/.test(line.text)
      || /^ {0,3}(?:::|\[\^[^\]]+\]:)/.test(line.text)
      || /^ {0,3}(?:=+|-+)[ \t]*$/.test(line.text) && index > 0 && Boolean(lines[index - 1].text.trim())
      || index === 0 && line.text.trim() === '---') return whole()
    const title = heading(line.text)
    if (title) {
      const level = title[1].length
      headings = headings.filter(value => value.level < level)
      headings.push({ level, text: line.text })
      add(index, index, 'heading'); index++; continue
    }
    const opening = fence(line.text)
    if (opening) {
      if (opening[1][0] === '`' && opening[2].includes('`')) return whole()
      const close = new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}[ \\t]*$`)
      let last = index + 1
      while (last < lines.length && !close.test(lines[last].text)) last++
      if (last === lines.length) return whole()
      add(index, last, 'content'); index = last + 1; continue
    }
    if (divider(line.text)) { add(index, index, 'verbatim'); index++; continue }
    if (list(line.text) || quoted(line.text) || indented(line.text)) {
      const isList = list(line.text), isQuote = quoted(line.text)
      let last = index
      for (let next = index + 1; next < lines.length; next++) {
        const value = lines[next].text
        if (!value.trim()) {
          let following = next + 1
          while (following < lines.length && !lines[following].text.trim()) following++
          if (following === lines.length) break
          if (isList && /^\s/.test(lines[following].text) && fence(lines[following].text.trimStart())) return whole()
          const continuation = isList ? list(lines[following].text) || indented(lines[following].text)
            : isQuote ? quoted(lines[following].text) : indented(lines[following].text)
          if (!continuation) break
          continue
        }
        // Nested fences/containers are valid Markdown, but this small compiler
        // cannot safely delimit every nested dialect. Keep the entire source.
        if (fence(value.trimStart()) || /^\s*<\/?[A-Za-z!]/.test(value)) return whole()
        if (heading(value) || divider(value)) break
        if (isList ? list(value) || indented(value) : isQuote ? quoted(value) : indented(value)) last = next
        else if (next === last + 1 && (isList || isQuote)) last = next // lazy continuation
        else break
      }
      add(index, last, 'content'); index = last + 1; continue
    }
    let last = index
    while (last + 1 < lines.length && lines[last + 1].text.trim()
      && !heading(lines[last + 1].text) && !fence(lines[last + 1].text)
      && !list(lines[last + 1].text) && !quoted(lines[last + 1].text) && !indented(lines[last + 1].text)) {
      if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(lines[last + 1].text)
        || /^ {0,3}(?:<!--|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s|>|\/))/.test(lines[last + 1].text)) return whole()
      last++
    }
    add(index, last, 'content'); index = last + 1
  }
  return { blocks, fallback: false }
}

/**
 * Compile exact complete blocks once, never summarize, truncate or change a skill.
 * Headings and logical source order remain intact; later occurrences refer to the
 * first block from their original scope. Provenance is local metadata, not prompt text.
 * All offsets/counts use JavaScript UTF-16 string indices and half-open ranges.
 */
export function compileSkillInstructions(sources: readonly SkillInstructionSource[]): CompiledSkillInstructions {
  const parsed = sources.map(value => blocksOf(value.text))
  const occurrences = new Map<string, number>()
  for (const source of parsed) for (const block of source.blocks) if (block.kind === 'content') occurrences.set(block.text, (occurrences.get(block.text) || 0) + 1)
  const hasShared = [...occurrences.values()].some(value => value > 1)
  let tag = '共同规范 C'
  while (sources.some(source => source.text.includes(`〔${tag}`))) tag += '_'
  const parts: string[] = [], provenance: SkillInstructionProvenance[] = []
  let length = 0, sharedBlocks = 0, outputBlocks = 0, duplicateBlocksRemoved = 0, duplicateCharactersRemoved = 0
  const append = (value: string) => { parts.push(value); length += value.length }
  const first = new Map<string, { start: number; end: number; label: string }>()
  const finish = (): CompiledSkillInstructions => {
    const instructions = parts.join('')
    return { instructions, stats: {
      inputCharacters: sources.reduce((total, source) => total + source.text.length, 0), outputCharacters: instructions.length,
      inputBlocks: parsed.reduce((total, source) => total + source.blocks.length, 0), outputBlocks,
      sharedBlocks, duplicateBlocksRemoved, duplicateCharactersRemoved,
      fallbackSources: parsed.filter(source => source.fallback).length,
    }, provenance }
  }
  if (!hasShared) {
    for (const [sourceIndex, source] of sources.entries()) {
      if (!parsed[sourceIndex].blocks.length) continue
      if (length) append('\n\n')
      const start = length; append(source.text)
      for (const [blockIndex, block] of parsed[sourceIndex].blocks.entries()) {
        provenance.push({ source: source.source, sourceIndex, blockIndex, headings: [...block.headings],
          sourceStart: block.start, sourceEnd: block.end, compiledStart: start + block.start, compiledEnd: start + block.end,
          shared: false, kind: block.kind })
        outputBlocks++
      }
    }
    return finish()
  }
  append('编译说明：各来源的原有章节与逻辑顺序保持不变。共同规范原文只出现一次，适用于其首次出现及全部引用位置所在的来源和章节；引用不替代或降低原文要求。')
  for (const [sourceIndex, source] of sources.entries()) {
    const blocks = parsed[sourceIndex].blocks
    if (!blocks.length) continue
    if (length) append('\n\n')
    append(`〔规范来源 S${sourceIndex + 1}：${JSON.stringify(source.source)}〕\n\n`)
    for (const [blockIndex, block] of blocks.entries()) {
      if (blockIndex) append('\n\n')
      const shared = block.kind === 'content' && occurrences.get(block.text)! > 1
      const existing = shared ? first.get(block.text) : undefined
      let compiledStart: number, compiledEnd: number, referenceStart: number | undefined, referenceEnd: number | undefined
      if (existing) {
        referenceStart = length
        append(`〔适用${existing.label}〕`)
        referenceEnd = length
        compiledStart = existing.start; compiledEnd = existing.end
        duplicateBlocksRemoved++; duplicateCharactersRemoved += block.text.length
      } else {
        const label = shared ? `${tag}${++sharedBlocks}` : ''
        if (shared) append(`〔${label}〕\n\n`)
        compiledStart = length; append(block.text); compiledEnd = length; outputBlocks++
        if (shared) first.set(block.text, { start: compiledStart, end: compiledEnd, label })
      }
      provenance.push({ source: source.source, sourceIndex, blockIndex, headings: [...block.headings],
        sourceStart: block.start, sourceEnd: block.end, compiledStart, compiledEnd,
        ...(referenceStart !== undefined ? { referenceStart, referenceEnd } : {}), shared, kind: block.kind })
    }
  }
  return finish()
}
