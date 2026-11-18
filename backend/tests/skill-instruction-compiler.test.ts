import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileSkillInstructions, type SkillInstructionSource } from '../src/services/skill-instruction-compiler.ts'

function assertTraceable(sources: readonly SkillInstructionSource[]) {
  const before = structuredClone(sources), result = compileSkillInstructions(sources)
  assert.deepEqual(sources, before)
  assert.equal(result.stats.inputCharacters, sources.reduce((total, source) => total + source.text.length, 0))
  assert.equal(result.stats.outputCharacters, result.instructions.length)
  assert.equal(result.stats.inputBlocks, result.provenance.length)
  for (const record of result.provenance) {
    const original = sources[record.sourceIndex]
    assert.equal(record.source, original.source)
    assert.equal(result.instructions.slice(record.compiledStart, record.compiledEnd), original.text.slice(record.sourceStart, record.sourceEnd))
    if (record.referenceStart !== undefined) {
      assert.match(result.instructions.slice(record.referenceStart, record.referenceEnd), /^〔适用共同规范 C/)
      assert.equal(record.shared, true)
    }
  }
  // Every original non-whitespace character, including Markdown syntax and
  // headings, belongs to a verbatim recoverable block. Only separators may vary.
  for (const [sourceIndex, source] of sources.entries()) {
    const records = result.provenance.filter(record => record.sourceIndex === sourceIndex)
    for (let index = 0; index < source.text.length; index++) if (!/\s/u.test(source.text[index])) {
      assert.ok(records.some(record => index >= record.sourceStart && index < record.sourceEnd), `${source.source} character ${index}`)
    }
  }
  return result
}

test('identical full paragraphs appear once while each original source, heading and logical position remains traceable', () => {
  const common = '逐字保留台词、说话者、声音类型和顺序；不能删除原词来满足格式。'
  const sources = [
    { source: 'skills/storyboard-breaker/SKILL.md', text: `# 分镜拆解\n\n## 分组规范\n\n仅在本段使用共同要求。\n\n${common}\n\n仅本任务的例外：不改变场景。` },
    { source: 'skills/prompt-generator/video-prompt/SKILL.md', text: `# 视频提示词\n\n## 锁定分镜\n\n先保留已有镜头。\n\n${common}\n\n然后只保存本条提示词。` },
  ]
  const result = assertTraceable(sources)
  assert.equal(result.instructions.split(common).length - 1, 1)
  const entries = result.provenance.filter(record => record.shared)
  assert.equal(entries.length, 2)
  assert.deepEqual(entries.map(record => record.headings), [['# 分镜拆解', '## 分组规范'], ['# 视频提示词', '## 锁定分镜']])
  assert.equal(entries[0].compiledStart, entries[1].compiledStart)
  const reference = entries[1].referenceStart!
  assert.ok(result.instructions.indexOf('先保留已有镜头。') < reference)
  assert.ok(reference < result.instructions.indexOf('然后只保存本条提示词。'))
  assert.match(result.instructions, /适用于其首次出现及全部引用位置所在的来源和章节/)
  assert.ok(result.instructions.includes(sources[0].source) && result.instructions.includes(sources[1].source))
  assert.equal(result.stats.sharedBlocks, 1)
  assert.equal(result.stats.duplicateBlocksRemoved, 1)
  assert.equal(result.stats.duplicateCharactersRemoved, common.length)
})

test('a repeated paragraph in different sections of one source keeps both scopes rather than merging headings', () => {
  const common = '每镜写清当前动作和末态。'
  const sources = [{ source: 'custom.md', text: `# 用户规范\n\n## 雨景\n\n${common}\n\n### 湿衣\n\n保持湿衣连续。\n\n## 室内\n\n${common}` }]
  const result = assertTraceable(sources)
  assert.equal(result.instructions.split(common).length - 1, 1)
  assert.deepEqual(result.provenance.filter(record => record.shared).map(record => record.headings), [['# 用户规范', '## 雨景'], ['# 用户规范', '## 室内']])
  assert.deepEqual(result.provenance.find(record => sources[0].text.slice(record.sourceStart, record.sourceEnd) === '保持湿衣连续。')?.headings,
    ['# 用户规范', '## 雨景', '### 湿衣'])
})

test('list items and loose-list continuations stay in one atomic block; a matching item alone is not removed', () => {
  const whole = '- 必须保留动作。\n  保留准备与结果。\n\n- 必须保留台词。\n  不能概括原词。'
  const sources = [
    { source: 'a.md', text: `# A\n\n${whole}\n\n后置说明。` },
    { source: 'b.md', text: `# B\n\n${whole}\n\n## 独有条目\n\n- 必须保留动作。` },
  ]
  const result = assertTraceable(sources)
  const lists = result.provenance.filter(record => sources[record.sourceIndex].text.slice(record.sourceStart, record.sourceEnd) === whole)
  assert.equal(lists.length, 2)
  assert.ok(lists.every(record => record.shared))
  const single = result.provenance.find(record => sources[record.sourceIndex].text.slice(record.sourceStart, record.sourceEnd) === '- 必须保留动作。')!
  assert.equal(single.shared, false)
})

test('fenced code is preserved whole, including blank lines and apparent Markdown headings inside it', () => {
  const code = '```text\r\n# 不是章节\r\n\r\n角色说：「原词」。\r\n```'
  const sources = [{ source: 'a.md', text: `# A\r\n\r\n${code}` }, { source: 'b.md', text: `# B\r\n\r\n${code}` }]
  const result = assertTraceable(sources)
  const records = result.provenance.filter(record => record.shared)
  assert.equal(records.length, 2)
  assert.equal(result.instructions.slice(records[0].compiledStart, records[0].compiledEnd), code)
  assert.deepEqual(records.map(record => record.headings), [['# A'], ['# B']])
  assert.equal(result.provenance.some(record => record.headings.includes('# 不是章节')), false)
})

test('tables, blockquotes and indented code are complete blocks rather than deduplicated individual lines', () => {
  const table = '| 字段 | 要求 |\n|---|---|\n| description | 完整动作 |'
  const quote = '> 必须保留原词。\n>\n> 不能把旁白改成对白。'
  const code = '    第一行 literal\n\n    # 仍是代码'
  const text = `${table}\n\n${quote}\n\n${code}`
  const sources = [{ source: 'a.md', text: `# A\n\n${text}` }, { source: 'b.md', text: `# B\n\n${text}` }]
  const result = assertTraceable(sources)
  for (const block of [table, quote, code]) {
    const records = result.provenance.filter(record => sources[record.sourceIndex].text.slice(record.sourceStart, record.sourceEnd) === block)
    assert.equal(records.length, 2, block)
    assert.ok(records.every(record => record.shared))
    assert.equal(result.instructions.slice(records[0].compiledStart - 2, records[0].compiledStart), '\n\n', 'The label must not turn an indented code block or list into a paragraph continuation')
  }
})

test('only byte-identical block text is shared; trailing spaces and CRLF are not normalized', () => {
  const sources = [
    { source: 'a.md', text: '# A\n\n原词保持。  \n下一行。\n\n独有甲。' },
    { source: 'b.md', text: '# B\r\n\r\n原词保持。  \r\n下一行。\r\n\r\n独有乙。' },
    { source: 'c.md', text: '# C\n\n原词保持。\n下一行。' },
  ]
  const result = assertTraceable(sources)
  assert.equal(result.stats.sharedBlocks, 0)
  assert.equal(result.instructions, sources.map(source => source.text).join('\n\n'))
})

test('uncertain Markdown containers fall back to the entire exact source without interpreting inner headings', () => {
  for (const text of [
    '# A\n\n```text\n# 引号未闭，内容仍在围栏内。',
    '# A\n\n<section>\n\n# HTML容器内的内容\n\n</section>',
    '标题\n====\n\n原文内容。',
    '---\nname: custom\n---\n\n# 自定义正文',
    '# A\n\n- 列表项\n\n  ```text\n  # 嵌套代码\n  ```',
    '# A\n\n:::warning\n\n条件内容\n\n:::',
    '# A\n\n[^voice]: 条件\n\n    仍归属于该注释。',
  ]) {
    const sources = [{ source: 'custom.md', text }]
    const result = assertTraceable(sources)
    assert.equal(result.instructions, text)
    assert.equal(result.stats.fallbackSources, 1, text)
    assert.equal(result.provenance.length, 1)
    assert.equal(result.provenance[0].kind, 'verbatim')
    assert.deepEqual(result.provenance[0].headings, [])
  }
})

test('a fallback source remains byte-for-byte recoverable beside successfully shared sources', () => {
  const common = '共享的完整原文要求。'
  const uncertain = '<section>\n\n# 容器内规范\n\n共享的完整原文要求。\n\n</section>'
  const sources = [{ source: 'a.md', text: common }, { source: 'b.md', text: common }, { source: 'raw.md', text: uncertain }]
  const result = assertTraceable(sources)
  const raw = result.provenance.find(record => record.sourceIndex === 2)!
  assert.equal(raw.kind, 'verbatim')
  assert.equal(raw.shared, false)
  assert.equal(result.instructions.slice(raw.compiledStart, raw.compiledEnd), uncertain)
  assert.equal(result.stats.fallbackSources, 1)
})

test('custom Unicode text, quoted placeholders and source metadata are never summarized or rewritten', () => {
  const custom = '😀 自定义：角色说：「保留@阿甲、#原词、[[character:999]]与email@example.test。」  '
  const sources = Object.freeze([
    Object.freeze({ source: '用户 自定义.md', text: `## 用户规则 ##\n\n${custom}` }),
    Object.freeze({ source: 'video.md', text: `# 视频\n\n${custom}` }),
  ])
  const result = assertTraceable(sources)
  assert.equal(result.instructions.split(custom).length - 1, 1)
  assert.ok(result.provenance.some(record => record.headings.includes('## 用户规则 ##')))
  assert.deepEqual(compileSkillInstructions(sources), result, 'The same inputs produce deterministic text, offsets and statistics')
})

test('compiler-generated markers cannot collide with literal marker text in a user paragraph', () => {
  const common = '原始标记〔共同规范 C1〕必须逐字保留。'
  const sources = [{ source: 'a.md', text: common }, { source: 'b.md', text: common }]
  const result = assertTraceable(sources)
  assert.equal(result.instructions.split(common).length - 1, 1)
  assert.match(result.instructions, /〔共同规范 C_1〕/)
  assert.match(result.instructions, /〔适用共同规范 C_1〕/)
})

test('empty inputs have no invented instructions or provenance', () => {
  const result = assertTraceable([{ source: 'empty', text: '' }, { source: 'blank', text: ' \r\n\t' }])
  assert.equal(result.instructions, '')
  assert.deepEqual(result.provenance, [])
  assert.equal(result.stats.sharedBlocks, 0)
  assert.equal(result.stats.outputBlocks, 0)
  assert.equal(result.stats.fallbackSources, 0)
})

test('long shared original prose is transmitted once with compact references rather than a full provenance dump', () => {
  const common = '每个实际子镜头都要完整表达适用的动作、表情、空间、声音与末态，不能用概括替代原文。'.repeat(45)
  const sources = [{ source: 'storyboard.md', text: `# 分镜\n\n${common}` }, { source: 'video.md', text: `# 视频\n\n${common}` }]
  const result = assertTraceable(sources)
  assert.equal(result.instructions.split(common).length - 1, 1)
  assert.ok(result.stats.outputCharacters < result.stats.inputCharacters)
  for (const internal of ['sourceStart', 'compiledStart', 'referenceStart', 'sourceIndex', 'blockIndex']) assert.equal(result.instructions.includes(internal), false)
})
