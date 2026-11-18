import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeScriptBody } from '../src/services/script-body-budget.ts'
import { buildScriptUnitSpeechBudgets, scriptTimingBudget, splitScriptUnits, storyboardGroupBudget } from '../src/services/skill-storyboard-contract.ts'

const count = (value: string) => [...value].filter(character => /[\p{L}\p{N}]/u.test(character)).length

test('adding headings, cast and production summary never changes the body duration or group budget', () => {
  const body = `▲${'雨水沿着原有屋檐缓缓落下。'.repeat(15)}\n林轩：我回来了。\n旁白：他把门轻轻关上。`
  const decorated = ['第07集｜回来', '【人物】林轩', '【地点】旧屋', '【时间】夜', '正文',
    '#### 7-01 旧屋 夜 内', body, '**本集人物状态与闭环**', '- 林轩：回到旧屋，线索仍未揭开。',
    '- 可见结果：门已经关上。'].join('\n')
  assert.deepEqual(scriptTimingBudget(decorated), scriptTimingBudget(body))
  assert.deepEqual(storyboardGroupBudget(decorated), storyboardGroupBudget(body))
  const units = splitScriptUnits(decorated), before = JSON.stringify(units)
  const budgets = buildScriptUnitSpeechBudgets(units, { characters: [{ id: 1, name: '林轩' }] })
  const analysis = analyzeScriptBody(decorated)
  for (const id of analysis.excludedSourceIds) assert.equal(budgets[id - 1].spoken_characters, 0)
  assert.equal(JSON.stringify(units), before, 'original script and stable source IDs must remain unchanged')
  assert.ok(budgets.some(row => row.utterances.some(line => line.text === '我回来了。')))
  assert.ok(budgets.some(row => row.utterances.some(line => line.text === '他把门轻轻关上。')))
})

test('only body action and spoken words count while explicit screenplay metadata and summaries remain excluded', () => {
  const lines = [
    '### 第1集｜吹来的真车', '【人物】林轩、王大富、系统', '【地点】学生宿舍302', '【时间】夜',
    '【环境氛围】安静、反转', '【故事主线】系统绑定并发放实物', '正文',
    '#### 1-01 学生宿舍302 夜 内', '出场人物：林轩、王大富。',
    '首次人物建议（C）：林轩，21岁，旧T恤。',
    '▲林轩把帆布包放到床尾。', '林轩：（低声）上周你还找我借饭钱。',
    '系统（仅林轩听见）：实物已发放。',
    '**本集人物状态与闭环**', '- 林轩：系统绑定。', '- 可见结果：车灯亮起。',
  ]
  const value = analyzeScriptBody(lines.join('\n'))
  assert.equal(value.bodyText, '林轩把帆布包放到床尾。\n（低声）上周你还找我借饭钱。\n（仅林轩听见）实物已发放。')
  assert.equal(value.characters, count(value.bodyText))
  assert.deepEqual(value.includedSourceIds, [11, 12, 13])
  assert.equal(value.excludedSourceIds.length, 13)
  assert.equal(value.totalCharacters, count(lines.join('\n')))
  assert.equal(value.excludedCharacters, value.totalCharacters - value.characters)
  assert.equal(value.scope, 'script-body-v1')
})

test('recognized scene headings in both formats and episode-only input have no body budget', () => {
  const input = ['第01集', '第01集吹来的真车', '### 第2集 离开', '###第3集归来', 'Episode 01 - Leave', 'CHAPTER 2: The door', '## S01 | 内景 · 宿舍 | 夜晚', '1-02 走廊 夜 内', '**1-03 学校门口 日 外**', 'INT. CABIN - DAY', '正文'].join('\n')
  assert.equal(analyzeScriptBody(input).characters, 0)
  assert.deepEqual(analyzeScriptBody(input).includedSourceIds, [])
})

test('ordinary bold prose and unmarked paragraphs stay in the body', () => {
  const value = analyzeScriptBody('**他转过身，望向门外。**\n雨水顺着门檐滴落。\n- 她走下台阶。')
  assert.equal(value.bodyText, '他转过身，望向门外。\n雨水顺着门檐滴落。\n她走下台阶。')
  assert.deepEqual(value.includedSourceIds, [1, 2, 3])
})

test('note bullets stop at clear body/action/scene markers, without swallowing later scenes', () => {
  const input = ['编剧备注', '- 林轩：此处先交代人物背景。', '▲林轩推门出去。', '林轩：谁在那儿？',
    '本集总结：', '- 线索仍待回收。', '## S02 | 外景 · 院落 | 日', '- 风吹动树叶。', '旁白：一切才刚刚开始。'].join('\n')
  const value = analyzeScriptBody(input)
  assert.equal(value.bodyText, '林轩推门出去。\n谁在那儿？\n风吹动树叶。\n一切才刚刚开始。')
  assert.deepEqual(value.includedSourceIds, [3, 4, 8, 9])
})

test('metadata-like words inside dialogue or action do not remove body text', () => {
  const value = analyzeScriptBody('林轩：系统说时间不够了，备注里还有地点。\n【旁白】他的故事主线从这一刻改变。\n△屏幕上写着“编剧备注：停止”。')
  assert.equal(value.bodyText, '系统说时间不够了，备注里还有地点。\n他的故事主线从这一刻改变。\n屏幕上写着“编剧备注：停止”。')
})

test('delivery directions survive whether placed before or after the dialogue colon', () => {
  const value = analyzeScriptBody('林轩（低声）：我回来了。\n王大富：（转头）你去哪了？\n【系统（仅林轩听见）】实物已发放。')
  assert.equal(value.bodyText, '（低声）我回来了。\n（转头）你去哪了？\n（仅林轩听见）实物已发放。')
})

test('CRLF, supplementary Unicode and empty lines keep stable nonempty source IDs', () => {
  const value = analyzeScriptBody('\uFEFF第01集\r\n\r\n【旁白】𠮷走来。\r\n  \r\n△她回头。')
  assert.equal(value.characters, count('𠮷走来。她回头。'))
  assert.deepEqual(value.includedSourceIds, [2, 3])
  assert.deepEqual(value.excludedSourceIds, [1])
})

test('bilingual body is preserved without deciding which language should be spoken', () => {
  const input = '【人物】Wren Winters、Julian Ashford\n【旁白】The cabin wall tore open.\n【旁白】机舱壁撕裂开来。\nJulian Ashford: (quietly) Where are you?\n【Wren Winters】不是。'
  const value = analyzeScriptBody(input)
  assert.equal(value.bodyText, 'The cabin wall tore open.\n机舱壁撕裂开来。\n(quietly) Where are you?\n不是。')
  assert.equal(value.characters, count(value.bodyText))
  assert.deepEqual(value.includedSourceIds, [2, 3, 4, 5])
  assert.equal(analyzeScriptBody('Wren: No.').bodyText, 'No.')
})

test('unknown prose is conservatively retained after notes and labels', () => {
  const value = analyzeScriptBody('制作备注：此处不用出画。\n- 雨声由后期处理。\n门外的脚步越来越近。\n灯一下灭了。')
  assert.equal(value.bodyText, '门外的脚步越来越近。\n灯一下灭了。')
})

test('narrative colon introductions are body, not invented speaker names', () => {
  const input = '他的眼前只有一个念头：逃。\n画面：门正在缓缓打开。\n收尾：她走向远处。\n门上写着：禁止入内。'
  assert.equal(analyzeScriptBody(input).bodyText, input)
})

test('multiline bracket metadata is excluded until actual body resumes', () => {
  const value = analyzeScriptBody('【人物】\n林轩、王大富\n【地点】\n- 学生宿舍302\n【正文】林轩看向王大富。\n林轩：走。')
  assert.equal(value.bodyText, '林轩看向王大富。\n走。')
  assert.deepEqual(value.includedSourceIds, [5, 6])
  assert.deepEqual(value.excludedSourceIds, [1, 2, 3, 4])
})

test('a narrative sentence mentioning an episode is not mistaken for its title', () => {
  const text = '第一集结束之后，他又回到了门前。'
  assert.equal(analyzeScriptBody(text).bodyText, text)
})

test('a metadata bare value does not absorb later unpunctuated narrative', () => {
  const value = analyzeScriptBody('【地点】\n学生宿舍302\n林轩走到了窗边')
  assert.equal(value.bodyText, '林轩走到了窗边')
})
