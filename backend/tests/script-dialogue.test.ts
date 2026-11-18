import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractScriptDialogue } from '../src/services/script-dialogue.ts'

const names = Object.freeze(['老年高大山', '秦翠花', '高卫东', '阿甲', '阿乙', 'Alex', '太郎', '민수'])
type Expected = { speakerName?: string; kind: 'dialogue' | 'offscreen' | 'narration'; text: string }
function expectLines(input: string, expected: Expected[], speakers: readonly string[] = names) {
  const normalize = (rows: Expected[]) => rows.map(row => ({ speakerName: row.speakerName, kind: row.kind, text: row.text }))
  assert.deepEqual(normalize(extractScriptDialogue(input, speakers)), normalize(expected))
}

test('known speaker colon lines remove leading stage directions and retain the original dialogue exactly', () => {
  expectLines('老年高大山：（猛地撑起身，声音发颤）什么？卫东不是我儿子？', [
    { speakerName: '老年高大山', kind: 'dialogue', text: '什么？卫东不是我儿子？' },
  ])
  expectLines('秦翠花：（垂下目光）我不知道。', [
    { speakerName: '秦翠花', kind: 'dialogue', text: '我不知道。' },
  ])
})

test('consecutive Chinese and ASCII leading stage groups are stripped with whitespace between them', () => {
  expectLines('  秦翠花： （沉默片刻） (攥紧衣角) （抬头） 我真的不知道。  ', [
    { speakerName: '秦翠花', kind: 'dialogue', text: '我真的不知道。' },
  ])
  expectLines('高卫东: (停下脚步)(回头) 先别走！', [
    { speakerName: '高卫东', kind: 'dialogue', text: '先别走！' },
  ])
})

test('speaker offscreen labels are retained as offscreen identity while leading acting remains excluded', () => {
  expectLines('阿甲（画外音）：（压低声音）等一下。\n阿乙(OS): (稍作停顿) 我在门外。', [
    { speakerName: '阿甲', kind: 'offscreen', text: '等一下。' },
    { speakerName: '阿乙', kind: 'offscreen', text: '我在门外。' },
  ])
})

test('narration and quoted narration remain separate from on-screen dialogue', () => {
  expectLines('旁白：夜已经深了。\n旁白：「屋里安静下来。」', [
    { kind: 'narration', text: '夜已经深了。' },
    { kind: 'narration', text: '屋里安静下来。' },
  ])
})

test('legacy named speech and quote styles are parsed without changing punctuation or words', () => {
  expectLines('阿甲说：「你好，明天见。」\n阿乙说：“别忘了！”\n秦翠花："我知道。"', [
    { speakerName: '阿甲', kind: 'dialogue', text: '你好，明天见。' },
    { speakerName: '阿乙', kind: 'dialogue', text: '别忘了！' },
    { speakerName: '秦翠花', kind: 'dialogue', text: '我知道。' },
  ])
})

test('quoted speech ends before following action prose while subsequent explicit speech is retained', () => {
  expectLines('阿甲说：「早上好。」阿乙点头。', [
    { speakerName: '阿甲', kind: 'dialogue', text: '早上好。' },
  ])
  expectLines('阿甲说：「早上好。」阿乙点头后说：“你好。”', [
    { speakerName: '阿甲', kind: 'dialogue', text: '早上好。' },
    { kind: 'dialogue', text: '你好。' },
  ])
  expectLines('阿甲说：「早上好。」阿乙说：“你好。”', [
    { speakerName: '阿甲', kind: 'dialogue', text: '早上好。' },
    { speakerName: '阿乙', kind: 'dialogue', text: '你好。' },
  ])
  expectLines('阿甲：你说的是“卫东”吗？我还没有说完。', [
    { speakerName: '阿甲', kind: 'dialogue', text: '你说的是“卫东”吗？我还没有说完。' },
  ])
})

test('a quoted spoken line after leading stage directions is unwrapped but not rewritten', () => {
  expectLines('秦翠花：（轻轻摇头）「你说的，我都记得。」', [
    { speakerName: '秦翠花', kind: 'dialogue', text: '你说的，我都记得。' },
  ])
})

test('stage-only known-speaker lines and bare scene directions produce no invented dialogue', () => {
  expectLines('秦翠花：（转身）（沉默）\n高卫东: (攥拳) （低头）\n（阿甲推门进来）\n【镜头1】阿乙看向门外。', [])
})

test('unknown action labels, headings and unregistered names cannot masquerade as dialogue', () => {
  expectLines('动作：阿甲走过小道。\n表演：抬眼后起身。\n场景：门上写着“院落”。\n人物：阿甲、阿乙。\n陌生人：你好。\n【开场】\n时间：夜晚。', [])
})

test('parentheses inside actual spoken text are preserved rather than treated as stage directions', () => {
  expectLines('阿甲：我（真的）不知道。\n阿乙：「（别出声）这几个字要照着念。」', [
    { speakerName: '阿甲', kind: 'dialogue', text: '我（真的）不知道。' },
    { speakerName: '阿乙', kind: 'dialogue', text: '（别出声）这几个字要照着念。' },
  ])
})

test('dialogue order, repeated occurrences and original languages are preserved', () => {
  expectLines('阿甲：好。\n阿甲：好。\nAlex: I’m here, don’t move.\n太郎：こんにちは。\n민수：괜찮아요.', [
    { speakerName: '阿甲', kind: 'dialogue', text: '好。' },
    { speakerName: '阿甲', kind: 'dialogue', text: '好。' },
    { speakerName: 'Alex', kind: 'dialogue', text: 'I’m here, don’t move.' },
    { speakerName: '太郎', kind: 'dialogue', text: 'こんにちは。' },
    { speakerName: '민수', kind: 'dialogue', text: '괜찮아요.' },
  ])
})

test('formal names are exact, including shared prefixes and regex punctuation', () => {
  expectLines('秦翠花：（点头）我明白。\nA+B: (nods) Yes.', [
    { speakerName: '秦翠花', kind: 'dialogue', text: '我明白。' },
    { speakerName: 'A+B', kind: 'dialogue', text: 'Yes.' },
  ], ['秦', '秦翠花', 'A+B'])
  expectLines('秦某：我明白。', [], ['秦', '秦翠花'])
})

test('presentation explicitness is opt-in and comes only from screenplay wrappers or leading annotations', () => {
  const plain = '秦翠花：（指着高大山）他把晓茹关屋里耍流氓！转脸就不认婚事！'
  const expected = { speakerName: '秦翠花', kind: 'dialogue', text: '他把晓茹关屋里耍流氓！转脸就不认婚事！' }
  assert.deepEqual(extractScriptDialogue(plain, names), [expected], 'Default callers keep their existing object shape')
  assert.deepEqual(extractScriptDialogue(plain, names, { includePresentation: true }), [{ ...expected, presentationExplicit: false }])
  for (const [source, kind] of [
    ['阿甲（画内）：回来。', 'dialogue'], ['阿甲：（画内，低声）回来。', 'dialogue'],
    ['阿甲（画外音）：回来。', 'offscreen'], ['阿甲(OS)：回来。', 'offscreen'], ['旁白：回来。', 'narration'],
  ] as const) {
    const turn = extractScriptDialogue(source, names, { includePresentation: true })[0]
    assert.equal(turn.kind, kind, source)
    assert.equal(turn.presentationExplicit, true, source)
  }
})

test('quoted OS words do not become source presentation constraints', () => {
  for (const source of ['阿甲：请把“OS”两个字照着念。', '阿甲：（指着写有“OS”的木牌）回来。']) {
    const turn = extractScriptDialogue(source, names, { includePresentation: true })[0]
    assert.equal(turn.kind, 'dialogue', source)
    assert.equal(turn.presentationExplicit, false, source)
  }
})

test('bracket narrator and registered English or Chinese speakers need no colon and preserve bilingual order', () => {
  expectLines([
    '【旁白】On our chartered flight, the cabin wall tore open.',
    '【旁白】机舱壁撕裂开来。',
    '【Julian Ashford】"Clo has low blood sugar. She\'ll fall barefoot."',
    '【Julian Ashford】"Clo 有低血糖。光着脚，她会摔的。"',
    '【急救员】"Ms. Winters, you\'re still bleeding."',
    '【Wren Winters】"No."',
  ].join('\r\n'), [
    { kind: 'narration', text: 'On our chartered flight, the cabin wall tore open.' },
    { kind: 'narration', text: '机舱壁撕裂开来。' },
    { speakerName: 'Julian Ashford', kind: 'dialogue', text: "Clo has low blood sugar. She'll fall barefoot." },
    { speakerName: 'Julian Ashford', kind: 'dialogue', text: 'Clo 有低血糖。光着脚，她会摔的。' },
    { speakerName: '急救员', kind: 'dialogue', text: "Ms. Winters, you're still bleeding." },
    { speakerName: 'Wren Winters', kind: 'dialogue', text: 'No.' },
  ], ['Julian Ashford', 'Wren Winters', '急救员'])
})

test('ASCII bracket voice and speaker tags reuse stage directions and optional presentation metadata', () => {
  expectLines('[Narration] The room fell quiet.\r[Alex]: (quietly) "I am here."\r【阿甲（画外音）】（低声）回来。', [
    { kind: 'narration', text: 'The room fell quiet.' },
    { speakerName: 'Alex', kind: 'dialogue', text: 'I am here.' },
    { speakerName: '阿甲', kind: 'offscreen', text: '回来。' },
  ])
  const offscreen = extractScriptDialogue('【阿甲（画外音）】（低声）回来。', names, { includePresentation: true })
  assert.deepEqual(offscreen, [{ speakerName: '阿甲', kind: 'offscreen', text: '回来。', presentationExplicit: true }])
  const narration = extractScriptDialogue('【旁白（Alex）】The room fell quiet.', names, { includePresentation: true })
  assert.deepEqual(narration, [{ speakerName: 'Alex', kind: 'narration', text: 'The room fell quiet.', presentationExplicit: true }])
})

test('bracket metadata, visual tags, unknown speakers and empty acting tags do not invent speech', () => {
  expectLines(['【人物】阿甲、阿乙', '【地点】院落', '【时间】夜', '【镜头1】阿甲抬头。',
    '【高光】灯亮起。', '[Unknown] "Hello."', '【陌生人】你好。', '【阿甲】（沉默）（转身）',
    '【旁白】', '[Narration extra] Not a registered voice tag.', '【阿甲的回忆】门外下雨。'].join('\n'), [])
})

test('bracket speech preserves quoted parentheses and excludes following action prose', () => {
  expectLines('【阿甲】「（别出声）这句话要照着念。」阿乙点头。\n【阿乙】：我（真的）不知道。', [
    { speakerName: '阿甲', kind: 'dialogue', text: '（别出声）这句话要照着念。' },
    { speakerName: '阿乙', kind: 'dialogue', text: '我（真的）不知道。' },
  ])
})
