import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { adaptSkillWorkflowSources, compileSkillWorkflowInstructions, skillWorkflowProtocol } from '../src/services/skill-workflow-protocol.ts'

const files = ['prompts/storyboard_breaker', 'prompts/prompt_generator', 'skills/storyboard-breaker/SKILL', 'skills/prompt-generator/video-prompt/SKILL']
const suffix = { zh: '.md', en: '.en.md', ja: '.ja.md', ko: '.ko.md' }
const sources = (language: keyof typeof suffix) => files.map(file => {
  const source = file + suffix[language]
  return { source, text: fs.readFileSync(new URL(`../workspace/${source}`, import.meta.url), 'utf8') }
})
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

test('runtime mapping preserves original files, every unadapted span and exact execution provenance in all four languages', () => {
  for (const language of Object.keys(suffix) as Array<keyof typeof suffix>) {
    const originals = sources(language), hashes = originals.map(source => hash(source.text))
    const adapted = adaptSkillWorkflowSources(originals)
    assert.ok(adapted.executionAdaptations.length > 0, language)
    for (const [sourceIndex, source] of originals.entries()) {
      const records = adapted.executionAdaptations.filter(record => record.sourceIndex === sourceIndex)
      let cursor = 0, rebuilt = ''
      for (const record of records) {
        assert.equal(source.text.slice(record.sourceStart, record.sourceEnd), record.original)
        assert.equal(record.source, source.source)
        rebuilt += source.text.slice(cursor, record.sourceStart) + record.replacement
        cursor = record.sourceEnd
      }
      rebuilt += source.text.slice(cursor)
      assert.equal(adapted.sources[sourceIndex].text, rebuilt)
    }
    assert.deepEqual(sources(language).map(source => hash(source.text)), hashes)
  }
})

test('known read, save and tools-only commands become coordinator responsibilities on the effective wire', () => {
  const forbidden = [
    /调用\s*`?read_storyboard_context`?/u, /调用\s*`?(?:save_storyboards|update_storyboard)`?/u,
    /输出只允许工具调用|必须是工具调用|执行中只调用工具/u,
    /\b[Cc]all\s+`?(?:read_storyboard_context|save_storyboards|update_storyboard)`?/u,
    /output may only be tool calls|must be a tool call|must actually call the save tools/u,
    /(?:read_storyboard_context|save_storyboards|update_storyboard)`?\s*を(?:呼び出|バッチ呼び出)/u,
    /出力はツール呼び出しのみ|必ずツール呼び出し|必ず実際に保存ツールを呼び出す/u,
    /(?:read_storyboard_context|save_storyboards|update_storyboard)`?\s*를 (?:호출해|여러 번에 나누어 호출)/u,
    /출력은 도구 호출만|반드시 도구 호출|반드시 저장 도구를 실제로 호출/u,
  ]
  for (const language of Object.keys(suffix) as Array<keyof typeof suffix>) {
    const compiled = compileSkillWorkflowInstructions(sources(language), 'expand')
    for (const pattern of forbidden) assert.doesNotMatch(compiled.instructions, pattern, `${language}: ${pattern}`)
    assert.ok(compiled.instructions.includes('本次阶段为完整分镜创作'))
    assert.ok(compiled.instructions.includes('事务'))
    assert.ok(compiled.executionAdaptations.length > 0)
    for (const record of compiled.executionAdaptations) assert.ok(compiled.instructions.includes(record.replacement))
    assert.equal(compiled.instructions.includes('sourceStart'), false, 'Audit offsets are local metadata, not extra model input')
  }
})

test('creative rules, custom additions, quoted original words and fenced examples are not interpreted as execution commands', () => {
  const text = '## 自定义创作要求\r\n动作准备、峰值和结果完整保留；人物情绪82%，空间A(X+1.4米,Y-0.2米)。\r\n'
    + '原词：「调用 read_storyboard_context 读取这几个字，必须实际调用保存工具。」\r\n'
    + '```text\r\nCall read_storyboard_context to read this literal example.\r\n```\r\n'
    + '调用 `read_storyboard_context`，参数为 `{}`，读取当前集剧本；对白原词、主要动作与结尾不能删除。\r\n'
  const adapted = adaptSkillWorkflowSources([{ source: 'custom-skill', text }])
  assert.ok(adapted.sources[0].text.includes(text.slice(0, text.indexOf('调用 `'))))
  assert.ok(adapted.sources[0].text.includes('对白原词、主要动作与结尾不能删除。'))
  assert.equal(adapted.executionAdaptations.length, 1)
  assert.ok(adapted.sources[0].text.includes('从协调器已经读取并提供的 context 读取当前集剧本'))
})

test('stage scope distinguishes planning, complete creation, locked conversion and patch responses without weakening merged content rules', () => {
  assert.match(skillWorkflowProtocol('plan'), /只返回groups或明确conflict/)
  assert.match(skillWorkflowProtocol('expand'), /先按storyboard-breaker生成完整分镜/)
  assert.match(skillWorkflowProtocol('prompt'), /只返回video_prompt和time_row_counts.*均锁定/)
  const repair = compileSkillWorkflowInstructions(sources('zh'), 'repair')
  assert.match(repair.instructions, /只返回请求指定的base_version和changes补丁，不返回整组成品/)
  assert.match(repair.instructions, /所有内容规范完整约束合并后的成品/)
  for (const rule of ['每名面部清晰人物', '声音资料', '空间坐标', '台词预算', 'description', 'result', 'image_prompt']) {
    assert.ok(repair.instructions.includes(rule), rule)
  }
  assert.equal(repair.instructions.includes('按照已批准的本组叙事规划，先写完整description'), false)
})
