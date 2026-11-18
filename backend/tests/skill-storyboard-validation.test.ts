import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  skillDescriptionShots, skillSpokenTurns, skillTimeRows,
  validateSkillDialogueCoverage, validateSkillStoryboard, type SkillCandidate,
} from '../src/services/skill-storyboard-validation.ts'

const assets = {
  characters: [{ id: 1, name: '阿甲' }, { id: 2, name: '阿乙' }],
  scenes: [{ id: 10, location: '院落' }], props: [{ id: 20, name: '木牌' }],
}
const names = assets.characters.map(character => character.name)
const header = '出场人物：@阿甲；场景：@院落。无字幕、无背景音乐，保留对白和必要音效。'
const space = '门槛为A0，X轴向东，Y轴向北，摄影机位于南侧朝北，'

function complete(duration = 8, mapping = [1, 2], overrides: Partial<SkillCandidate> = {}): SkillCandidate {
  const description = mapping.map((_, index) => `【镜头${index + 1}】@阿甲承接原有动作后停在门槛边。`).join('')
  const rows = Array.from({ length: Math.ceil(duration / 3) }, (_, index) =>
    `${index * 3}-${Math.min((index + 1) * 3, duration)}秒：${index === 0 ? space : ''}@阿甲在原有晨光中自然呼吸，保持原有末态。`)
  return {
    shot_number: 1, title: '院中承接', time: '日', location: '@院落的原有门槛边',
    shot_type: '中景与近景', angle: '平视', movement: '固定', description,
    result: '@阿甲站在原有位置，双手自然放下，准备原有下一行动。',
    atmosphere: '既有晨光从东侧照入，原有环境声连续。',
    image_prompt: '@院落内，@阿甲站在门槛边，原有晨光照亮既有衣物。',
    video_prompt: [header, ...rows].join('\n'), bgm_prompt: '无背景音乐', sound_effect: '原有衣料摩擦与脚步声。',
    duration, scene_id: 10, character_ids: [1], prop_ids: [], source_ids: [1], time_row_counts: [...mapping], ...overrides,
  }
}
const hard = (candidate: SkillCandidate, options: Parameters<typeof validateSkillStoryboard>[2] = {}) =>
  validateSkillStoryboard(candidate, assets, options).filter(issue => issue.severity === 'error')
const codes = (candidate: SkillCandidate) => hard(candidate).map(issue => issue.code)
const prompt = (rowTexts: string[], duration = 8) => [header, ...rowTexts.map((text, index) =>
  `${index * 3}-${Math.min((index + 1) * 3, duration)}秒：${index === 0 ? space : ''}@院落内，${text}`)].join('\n')
const described = (text: string, number = 1, source_ids = [1]) => complete(8, [2, 1], {
  shot_number: number, source_ids,
  description: `【镜头1】@阿甲听见原有动静后停下。${text}【镜头2】@阿甲保持承接状态。`,
})
const spoken = (text: string) => skillSpokenTurns(text, names).map(({ speakerName, kind, text }) => ({ speakerName, kind, text }))

test('complete skill output retains every field and does not mutate valid candidates or catalogs', () => {
  const candidate = complete(), before = structuredClone({ candidate, assets })
  assert.deepEqual(hard(candidate), [])
  assert.deepEqual({ candidate, assets }, before)
  for (const field of ['title', 'time', 'location', 'shot_type', 'angle', 'movement', 'description', 'result', 'atmosphere', 'image_prompt', 'video_prompt', 'bgm_prompt', 'sound_effect']) {
    const incomplete: any = complete(); delete incomplete[field]
    const snapshot = structuredClone(incomplete)
    assert.ok(hard(incomplete).some(issue => issue.code === 'skill_field_missing' && issue.field === field), field)
    assert.deepEqual(incomplete, snapshot)
    incomplete[field] = '  '
    assert.ok(hard(incomplete).some(issue => issue.code === 'skill_field_missing' && issue.field === field), field)
  }
})

test('8, 10 and 13 second groups keep real remainder rows and model-chosen 2–6 second child allocations', () => {
  for (const [duration, mapping] of [[8, [1, 2]], [8, [2, 1]], [10, [2, 2]], [13, [2, 1, 2]]] as const) {
    const candidate = complete(duration, [...mapping]), snapshot = structuredClone(candidate)
    assert.deepEqual(hard(candidate), [], `${duration}s ${mapping}`)
    const rows = skillTimeRows(candidate.video_prompt!)
    assert.equal(rows.at(-1)!.end, duration)
    assert.equal(rows.at(-1)!.end - rows.at(-1)!.start, duration % 3 || 3)
    assert.deepEqual(candidate, snapshot)
  }
  for (const [duration, mapping] of [[10, [1, 2, 1]], [13, [2, 2, 1]]] as const) {
    assert.ok(codes(complete(duration, [...mapping])).includes('shot_duration'), `${duration}s ${mapping}`)
  }
})

test('malformed mappings, gaps, shortened time axes and out-of-range durations are explicit errors', () => {
  assert.ok(codes(complete(8, [3])).includes('shot_time_mapping'))
  assert.ok(codes(complete(8, [1, 1])).includes('shot_time_mapping'))
  assert.ok(codes(complete(8, [1, 2], { video_prompt: complete().video_prompt!.replace('3-6秒', '4-6秒') })).includes('time_axis'))
  for (const duration of [7, 16, NaN]) assert.ok(codes(complete(8, [1, 2], { duration })).includes('duration_range'))
})

test('A0, X and Y must be in the first time row rather than only in metadata or later rows', () => {
  for (const token of ['A0', 'X', 'Y']) {
    const candidate = complete(), previous = candidate.video_prompt!
    candidate.video_prompt = previous.replace(token, '基准')
    ;(candidate as any).plan = space
    assert.ok(codes(candidate).includes('space_basis_missing'), token)
    candidate.video_prompt += `\n${space}`
    assert.ok(codes(candidate).includes('space_basis_missing'), `metadata ${token}`)
  }
})

test('the first independent header accepts four content languages and reports missing or malformed labels precisely', () => {
  for (const first of ['出场人物：@阿甲；场景：@院落。', 'Characters: @阿甲; Scene: @院落.', 'Cast: @阿甲; Scene: @院落.', '登場人物：@阿甲；シーン：@院落。', '등장인물: @阿甲; 장면: @院落.']) {
    const candidate = complete()
    candidate.video_prompt = candidate.video_prompt!.replace(header, first)
    assert.deepEqual(hard(candidate), [], first)
  }
  for (const first of ['', '出场人物：@阿甲。', '场景：@院落。', '出场角色：@阿甲；地点：@院落。']) {
    const candidate = complete()
    candidate.video_prompt = candidate.video_prompt!.replace(header, first)
    assert.ok(hard(candidate).some(issue => issue.code === 'prompt_header' && issue.field === 'video_prompt.header'), first)
  }
  const inline = complete()
  inline.video_prompt = inline.video_prompt!.split('\n').slice(1).join('\n').replace('0-3秒：', `0-3秒：${header}`)
  assert.ok(codes(inline).includes('prompt_header'))
})

test('every time row needs a bound formal reference outside visual or spoken quotes and email addresses', () => {
  for (const text of ['原有晨光照入，未引入素材。', '牌匾写着「@阿甲」。', '阿甲说：「联系@阿甲。」', '联系邮箱为someone@阿甲.example.com。', '@未绑定角色自然呼吸。']) {
    const candidate = complete()
    const lines = candidate.video_prompt!.split('\n')
    lines[2] = `3-6秒：${text}`
    candidate.video_prompt = lines.join('\n')
    assert.ok(hard(candidate).some(issue => issue.code === 'time_row_reference' && issue.field === 'video_prompt.rows.2'), text)
  }
  for (const text of ['@阿甲自然呼吸。', '@院落的原有晨光照入。', '@木牌边缘保留原状。']) {
    const candidate = complete(8, [1, 2], { prop_ids: [20] })
    const lines = candidate.video_prompt!.split('\n'); lines[2] = `3-6秒：${text}`; candidate.video_prompt = lines.join('\n')
    assert.deepEqual(hard(candidate), [], text)
  }
  const noBindings = complete(8, [1, 2], { scene_id: null, character_ids: [], prop_ids: [], description: '【镜头1】原有晨光照在空院中。【镜头2】原有门槛维持既定状态。' })
  noBindings.video_prompt = prompt(['原有晨光照入。', '固定拍摄空院。', '原有门槛未变。']).replaceAll('@院落内，', '')
  assert.deepEqual(hard(noBindings), [])
  assert.ok(validateSkillStoryboard(noBindings, assets).some(issue => issue.code === 'reference_assets_missing' && issue.severity === 'warning'))
})

test('free prose mentioning cuts or gaze targets never changes shot count or creates face requirements', () => {
  const candidate = complete(8, [1, 2], {
    description: '【镜头1】纯手部特写，@阿甲指尖停在@木牌边缘，未拍到任何面部；文字写明切回原定手势。【镜头2】@阿甲视线朝向画外@阿乙，镜头只拍其背影与手部。',
    character_ids: [1, 2], prop_ids: [20],
  })
  const snapshot = structuredClone(candidate)
  assert.deepEqual(hard(candidate), [])
  assert.equal(skillDescriptionShots(candidate.description!).length, 2)
  assert.deepEqual(candidate, snapshot)
})

test('locked narrative choices fail explicitly without being rewritten, and prompt mode requires only its applicable fields', () => {
  const candidate = complete(), snapshot = structuredClone(candidate)
  const expected = { number: 1, duration: 8, scene_id: 10, source_ids: [1] }
  assert.deepEqual(hard(candidate, { expected }), [])
  for (const changed of [{ ...expected, number: 2 }, { ...expected, duration: 10 }, { ...expected, scene_id: null }, { ...expected, source_ids: [2] }]) {
    assert.ok(hard(candidate, { expected: changed }).some(issue => issue.code === 'plan_changed'))
  }
  assert.deepEqual(candidate, snapshot)
  const promptOnly: any = complete()
  for (const field of ['title', 'time', 'location', 'shot_type', 'angle', 'movement', 'result', 'image_prompt', 'bgm_prompt', 'sound_effect']) delete promptOnly[field]
  assert.deepEqual(hard(promptOnly, { mode: 'prompt' }), [])
})

test('one 12-second narrative group can be designed with two or three complete children before video mapping follows its description', () => {
  const expected = { number: 1, duration: 12, scene_id: 10, source_ids: [1, 2, 3] }
  const reply = '这件事，我们两个人必须共同承担。'
  const common = { source_ids: [1, 2, 3], character_ids: [1, 2] }
  const two = complete(12, [2, 2], {
    ...common,
    description: `【镜头1】@阿甲走近门槛后停下，准备开口，阿甲说：「回来了吗？」随后闭口等待。` +
      `【镜头2】@阿乙抬眼回应，阿乙说：「${reply}」说完呼气，双手落在原有位置。`,
    video_prompt: prompt(['@阿甲走近门槛停下，准备后，阿甲说：「回来了吗？」', '@阿甲闭口等待，视线落在@阿乙身上。',
      '@阿乙抬眼开口，阿乙说：「这件事，」', '@阿乙承接气息，阿乙说：「我们两个人必须共同承担。」说完双手落在原有位置。'], 12),
  })
  const three = complete(12, [1, 1, 2], {
    ...common,
    description: `【镜头1】@阿甲走近门槛后停下，准备开口。` +
      `【镜头2】@阿甲看向@阿乙，阿甲说：「回来了吗？」随后闭口等待。` +
      `【镜头3】@阿乙抬眼回应，阿乙说：「${reply}」说完呼气，双手落在原有位置。`,
    video_prompt: prompt(['@阿甲走近门槛停下，吸气准备开口。', '@阿甲看向@阿乙，阿甲说：「回来了吗？」随后闭口等待。',
      '@阿乙抬眼开口，阿乙说：「这件事，」', '@阿乙承接气息，阿乙说：「我们两个人必须共同承担。」说完双手落在原有位置。'], 12),
  })
  const snapshot = structuredClone({ two, three, expected })
  assert.equal(skillDescriptionShots(two.description!).length, 2)
  assert.equal(skillDescriptionShots(three.description!).length, 3)
  assert.deepEqual(hard(two, { expected }), [])
  assert.deepEqual(hard(three, { expected }), [])
  for (const [candidate, incompatible] of [[two, three.time_row_counts], [three, two.time_row_counts]] as const) {
    const changed = { ...candidate, time_row_counts: [...incompatible!] }
    assert.ok(hard(changed, { expected }).some(issue => issue.code === 'shot_time_mapping'), 'The video mapping cannot add or merge description children')
    assert.equal(hard(changed, { expected }).some(issue => issue.code === 'plan_changed'), false, 'Child count belongs to the complete description, not the group outline')
  }
  assert.deepEqual({ two, three, expected }, snapshot)
})

test('a natural long sentence is preserved exactly across two rows without a fixed character cut', () => {
  const full = '这件事，我们两个人必须共同承担。'
  const candidate = complete(8, [2, 1], {
    description: `【镜头1】@阿甲准备开口，阿甲说：「${full}」【镜头2】@阿甲回应后自然呼吸。`,
    video_prompt: prompt(['@阿甲准备后，阿甲说：「这件事，」', '@阿甲承接气息，阿甲说：「我们两个人必须共同承担。」', '@阿甲落到原有末态。']),
  })
  assert.deepEqual(hard(candidate), [])
  assert.deepEqual(validateSkillDialogueCoverage([candidate], `阿甲：${full}`, names), [])
})

test('exact quoted continuations within a child preserve original words without borrowing visual quotes', () => {
  const full = '这件事，我们两个人必须共同承担。'
  const candidate = complete(8, [2, 1], {
    description: `【镜头1】阿甲说：「${full}」【镜头2】@阿甲停下后呼吸。`,
    video_prompt: prompt(['@阿甲开口，阿甲说：「这件事，」', '@阿甲接着吐出余句：「我们两个人必须共同承担。」', '@阿甲呼吸。']),
  })
  assert.deepEqual(hard(candidate), [])
  candidate.video_prompt = prompt(['@阿甲开口，阿甲说：「这件事，」', '@木牌上写着「我们两个人必须共同承担。」', '@阿甲呼吸。'])
  assert.ok(codes(candidate).includes('dialogue_preservation'))
})

test('changed, dropped, duplicated or reordered words fail preservation without modifying saved prose', () => {
  const full = '这件事，我们两个人必须共同承担。'
  for (const changed of ['这件事，我们两个人必须共同完成。', '这件事，我们必须共同承担。', full + full, '我们两个人必须共同承担。这件事，']) {
    const candidate = complete(8, [2, 1], {
      description: `【镜头1】阿甲说：「${full}」【镜头2】@阿甲呼吸。`,
      video_prompt: prompt([`@阿甲开口，阿甲说：「${changed}」`, '@阿甲呼吸。', '@阿甲落到原有末态。']),
    })
    const snapshot = structuredClone(candidate)
    assert.ok(codes(candidate).includes('dialogue_preservation'), changed)
    assert.deepEqual(candidate, snapshot)
  }
})

test('same words with a changed speaker, generic continuation by another speaker or voice type fail', () => {
  for (const text of ['阿乙说：「回来。」', '阿乙继续说：「回来。」', '阿甲的画外音：「回来。」', '旁白（阿甲）：「回来。」']) {
    const candidate = complete(8, [2, 1], {
      description: '【镜头1】阿甲说：「回来。」【镜头2】@阿甲呼吸。',
      video_prompt: prompt([`@阿甲抬头。${text}`, '@阿甲呼吸。', '@阿甲落到原有末态。']),
    })
    assert.ok(codes(candidate).includes('dialogue_preservation'), text)
  }
  const changedContinuation = complete(8, [2, 1], {
    description: '【镜头1】阿甲说：「回来，我们一起走。」【镜头2】@阿甲呼吸。',
    video_prompt: prompt(['阿甲说：「回来，」', '阿乙继续说：「我们一起走。」', '@阿甲停下。']),
  })
  assert.ok(codes(changedContinuation).includes('dialogue_preservation'))
})

test('dialogue diagnostics identify an unspecified description speaker without guessing one from nearby visual prose', () => {
  const candidate = complete(8, [2, 1], {
    description: '【镜头1】@阿甲抬眼，以压低语气谨慎地说：「回来。」【镜头2】@阿甲继续呼吸。',
    video_prompt: prompt(['@阿甲抬眼，阿甲说：「回来。」', '@阿甲继续呼吸。', '@阿甲落到原有末态。']),
  })
  const snapshot = structuredClone(candidate)
  const allIssues = validateSkillStoryboard(candidate, assets)
  assert.deepEqual(allIssues.filter(issue => issue.severity === 'error'), [])
  const issue = allIssues.find(issue => issue.code === 'attribution_review')!
  assert.equal(issue.shotNumber, 1)
  assert.equal(issue.field, 'video_prompt')
  assert.equal(issue.severity, 'warning')
  assert.match(issue.message, /子镜头1.*无法机械确认是否同一说话者/)
  assert.match(issue.message, /未明确姓名保持未知.*不据此推断姓名或认定已经匹配/)
  assert.ok(issue.message.includes('预期发声=[1{speakerName=未明确，kind=dialogue，原词="回来。"}]'))
  assert.ok(issue.message.includes('实际发声=[1{speakerName="阿甲"，kind=dialogue，原词="回来。"}]'))
  assert.equal(skillSpokenTurns(skillDescriptionShots(candidate.description!)[0].text, names)[0].speakerName, undefined)
  assert.deepEqual(candidate, snapshot, 'Diagnostics neither infer an attribution nor rewrite the source')
})

test('unknown attribution never supplies a speaker from expected dialogue and exact natural continuations remain readable', () => {
  const original = '回来，我们一起走。', expected = skillSpokenTurns(`阿甲说：「${original}」`, names)
  const actual = skillSpokenTurns('阿甲抬眼，用低沉沙哑的声音缓缓地说：「回来，」\n承接气息：「我们一起走。」', names, expected)
  assert.deepEqual(actual.map(turn => turn.speakerName), [undefined, undefined])
  assert.equal(actual.map(turn => turn.text).join(''), original)
  const candidate = complete(8, [2, 1], {
    description: `【镜头1】阿甲说：「${original}」【镜头2】@阿甲停下。`,
    video_prompt: prompt(['@阿甲抬眼，用低沉沙哑的声音缓缓地说：「回来，」', '@阿甲承接气息：「我们一起走。」', '@阿甲停下。']),
  })
  assert.deepEqual(hard(candidate), [])
  assert.equal(validateSkillStoryboard(candidate, assets).find(issue => issue.code === 'attribution_review')?.severity, 'warning')
  candidate.video_prompt = candidate.video_prompt!.replace('我们一起走。', '我们一起回去。')
  assert.ok(codes(candidate).includes('dialogue_preservation'), 'Unknown attribution cannot hide modified original words')
})

test('global unknown attribution warns with source and group locations while explicit wrong actors and kinds still fail', () => {
  const candidate = described('@阿甲抬眼，以低沉沙哑的声音缓缓地说：「回来。」', 3, [1])
  const before = structuredClone(candidate)
  const warnings = validateSkillDialogueCoverage([candidate], '阿甲：回来。', names)
  assert.ok(warnings.length > 0)
  assert.ok(warnings.every(issue => issue.severity === 'warning' && issue.code === 'attribution_review'))
  assert.equal(warnings[0].shotNumber, 3)
  assert.equal(warnings[0].field, 'source_ids.1')
  assert.match(warnings[0].message, /speakerName=未明确/)
  assert.deepEqual(candidate, before)
  for (const text of ['阿乙说：「回来。」', '旁白：回来。', '@阿甲抬眼，以低沉沙哑的声音缓缓地说：「回去。」', '她说：「回来。」她说：「回来。」']) {
    const issues = validateSkillDialogueCoverage([described(text, 3, [1])], '阿甲：回来。', names)
    assert.ok(issues.some(issue => issue.code === 'dialogue_coverage' && issue.severity === 'error'), text)
  }
  const kindMismatch = complete(8, [2, 1], {
    description: '【镜头1】旁白：「回来。」【镜头2】@阿甲呼吸。',
    video_prompt: prompt(['@阿甲抬眼，用低沉沙哑的声音缓缓地说：「回来。」', '@阿甲呼吸。', '@阿甲停下。']),
  })
  assert.ok(codes(kindMismatch).includes('dialogue_preservation'), 'An unknown speaker does not erase a definite voice-kind contradiction')
})

test('说完 followed by quoted speech retains a final clause without inventing another utterance from delivery actions', () => {
  assert.deepEqual(spoken('阿甲说完：「往后别说是我逼你嫁。」'), [
    { speakerName: '阿甲', kind: 'dialogue', text: '往后别说是我逼你嫁。' },
  ])
  assert.deepEqual(spoken('阿甲说：「回来。」说完喉结轻动，木牌上写着「回家」。'), [
    { speakerName: '阿甲', kind: 'dialogue', text: '回来。' },
  ])
  assert.deepEqual(spoken('阿甲说完喉结轻动，木牌上写着「回家」。'), [])

  const realNames = ['高大山', '张晓茹']
  const original = '你自己选。你要真跟明远登记，这五百我替陈家当彩礼交给你妈；你要留下听你妈的，往后别说是我逼你嫁。'
  const group7 = complete(12, [2, 1, 1], {
    shot_number: 7, source_ids: [1],
    description: '【镜头1】高大山说：「你自己选。你要真跟明远登记，」随即右手掌仍按着钱朝她方向轻轻一带，继续说：「这五百我替陈家当彩礼交给你妈；」'
      + '【镜头2】高大山侧脸朝她，语速约每秒4.3字说：「你要留下听你妈的，」张晓茹抬眼从钱上移到他脸上。'
      + '【镜头3】高大山目光压住她，语速约每秒4.3字说完：「往后别说是我逼你嫁。」说完唇线抿平、喉结轻动（情绪88%）。张晓茹没有回答。',
  })
  const group8 = described('张晓茹说：「你真会帮我挡住我妈？」', 8, [2])
  const before = structuredClone([group7, group8])
  const turns = skillDescriptionShots(group7.description!).flatMap(shot => skillSpokenTurns(shot.text, realNames))
  assert.equal(turns.map(turn => turn.text).join(''), original)
  assert.equal(turns.at(-1)!.speakerName, undefined, 'Rich visual prose does not provide an unambiguous speaker marker')
  assert.deepEqual(validateSkillDialogueCoverage([group7, group8], `高大山：${original}\n张晓茹：你真会帮我挡住我妈？`, realNames)
    .filter(issue => issue.severity === 'error'), [])
  assert.deepEqual([group7, group8], before, 'Coverage parses the saved wording without rewriting it')
})

test('说完 keeps explicit wrong actors and voice kinds strict while an unclear speaker stays unknown', () => {
  const expected = skillSpokenTurns('阿甲说：「回来。」', names)
  assert.deepEqual(skillSpokenTurns('阿乙站在门边。有人说完：「回来。」', names, expected)
    .map(({ speakerName, kind, text }) => ({ speakerName, kind, text })), [
    { speakerName: undefined, kind: 'dialogue', text: '回来。' },
  ])
  const unclear = validateSkillDialogueCoverage([described('阿乙站在门边。有人说完：「回来。」')], '阿甲：回来。', names)
  assert.ok(unclear.some(issue => issue.code === 'attribution_review' && issue.severity === 'warning'))
  for (const text of ['阿乙说完：「回来。」', '阿甲（画外音）说完：「回来。」']) {
    const candidate = complete(8, [2, 1], {
      description: '【镜头1】阿甲说：「回来。」【镜头2】@阿甲呼吸。',
      video_prompt: prompt([text, '@阿甲呼吸。', '@阿甲落到原有末态。']),
    })
    assert.ok(codes(candidate).includes('dialogue_preservation'), text)
  }
})

test('a delivery quote is excluded only when it explicitly refers to an earlier utterance in the same child', () => {
  const full = '看你快不行了，我就跟你说句实话。'
  for (const suffix of ['时眼皮平稳一抬。', '这几个字时眼皮平稳一抬。', '这句话时眼皮平稳一抬。']) {
    const text = `阿甲说：「${full}」她说“快不行了”${suffix}`
    assert.deepEqual(spoken(text), [{ speakerName: '阿甲', kind: 'dialogue', text: full }], suffix)
  }
  assert.equal(spoken(`阿甲说：「${full}」她说“快不行了”。`).length, 2, 'Without a delivery-reference suffix another explicit speech marker still counts')
  assert.equal(spoken(`阿甲说：「${full}」她说“你骗了我”时眼皮抬起。`).length, 2, 'Unseen words cannot be classified as a reference to an earlier line')
  assert.equal(spoken(`【镜头1】阿甲说：「${full}」【镜头2】她说“快不行了”时抬眼。`).length, 2, 'A previous child cannot suppress speech in the next child')
  const duplicate = described(`阿甲说：「${full}」阿甲说：「${full}」`)
  assert.ok(validateSkillDialogueCoverage([duplicate], `阿甲：${full}`, names).some(issue => issue.code === 'dialogue_coverage' && issue.severity === 'error'), 'A real second complete utterance remains a hard duplicate')
})

test('real stream groups 3 and 4 retain all original dialogue while voice-delivery wording and metanarrative quotes only require attribution review', () => {
  const realAssets = { ...assets, characters: [{ id: 8, name: '老年高大山' }, { id: 9, name: '老年张晓茹' }] }
  const realNames = realAssets.characters.map(character => character.name)
  const realHeader = '出场人物：@老年高大山、@老年张晓茹；场景：@院落。'
  const realPrompt = (texts: string[], duration: number) => prompt(texts, duration).replace(header, realHeader)
  const woman = '看你快不行了，我就跟你说句实话。高卫东是我和陈明远的儿子。'
  const man = '美兰和卫国呢？他们为什么连我的手术费都不肯出？'
  const group3 = complete(14, [1, 2, 2], {
    shot_number: 3, source_ids: [1, 2], character_ids: [8, 9],
    description: '【镜头1】@老年高大山伸手去够全家福，指尖停在高卫东脸上。' +
      `【镜头2】@老年张晓茹俯下身，右手撑在床沿、指节抵住粗布被褥，压低声音说：「${woman}」她说“快不行了”时眼皮平稳一抬，嘴角始终平直。` +
      `【镜头3】@老年高大山说：「${man}」说到“手术费”时胸口猛地起伏。`,
    video_prompt: realPrompt(['@老年高大山伸手按住全家福。',
      '@老年张晓茹俯下身，六旬清冷平稳的中低音女声压低音量、语速约每秒4.5字地说：「看你快不行了，」',
      '@老年张晓茹说：「我就跟你说句实话。」停顿半拍后，@老年张晓茹说：「高卫东是我和陈明远的儿子。」',
      '@老年高大山盯着她，七十余岁低沉沙哑的苍老男声气息不稳，语速约每秒4.2字地说：「美兰和卫国呢？」',
      '@老年高大山说：「他们为什么连我的手术费都不肯出？」'], 14),
  })
  const group4Words = ['你亲生的那两个，也是我故意养废的。', '我天天告诉他们，你只疼卫东。', '他们能不恨你吗？']
  const group4 = complete(12, [1, 1, 1, 1], {
    shot_number: 4, source_ids: [3], character_ids: [8, 9],
    description: group4Words.map((text, index) => `【镜头${index + 1}】@老年张晓茹说：「${text}」`).join('') + '【镜头4】@老年高大山松手，全家福滑落，手肘一软跌回被褥。',
    video_prompt: realPrompt([
      '@老年张晓茹抬眼看向他，六旬清冷平稳的中低音女声以约每秒5字的语速平声说：「你亲生的那两个，也是我故意养废的。」',
      `@老年张晓茹说：「${group4Words[1]}」`, `@老年张晓茹说：「${group4Words[2]}」`,
      '@老年高大山松手，全家福滑落，手肘一软跌回被褥。'], 12),
  })
  const snapshot = structuredClone([group3, group4])
  for (const candidate of [group3, group4]) {
    const issues = validateSkillStoryboard(candidate, realAssets)
    assert.deepEqual(issues.filter(issue => issue.severity === 'error'), [])
    assert.ok(issues.some(issue => issue.code === 'attribution_review' && issue.severity === 'warning'))
  }
  const source = `老年张晓茹：${woman}\n老年高大山：${man}\n老年张晓茹：${group4Words.join('')}`
  const coverage = validateSkillDialogueCoverage([group3, group4], source, realNames)
  assert.deepEqual(coverage.filter(issue => issue.severity === 'error'), [])
  assert.ok(coverage.some(issue => issue.code === 'attribution_review' && issue.shotNumber === 3))
  assert.deepEqual([group3, group4], snapshot)
  const explicitWrong = structuredClone(group4)
  explicitWrong.video_prompt = explicitWrong.video_prompt!.replace('六旬清冷平稳的中低音女声以约每秒5字的语速平声说', '@老年高大山说')
  assert.ok(validateSkillStoryboard(explicitWrong, realAssets).some(issue => issue.code === 'dialogue_preservation' && issue.severity === 'error'))
})

test('first-difference diagnostics retain both exact speech sequences and locate text, missing and extra characters', () => {
  for (const { expected, actual, reason, expectedPosition, actualPosition } of [
    { expected: '回来。一起走。', actual: '回去。一起走。', reason: 'text', expectedPosition: '发声段1原词第2字符', actualPosition: '发声段1原词第2字符' },
    { expected: '回来。一起走。', actual: '回来。', reason: 'missing', expectedPosition: '发声段1原词第4字符', actualPosition: '已结束' },
    { expected: '回来。', actual: '回来。回来。', reason: 'extra', expectedPosition: '已结束', actualPosition: '发声段1原词第4字符' },
    { expected: '😀。', actual: '😃。', reason: 'text', expectedPosition: '发声段1原词第1字符', actualPosition: '发声段1原词第1字符' },
  ]) {
    const candidate = complete(8, [2, 1], {
      description: `【镜头1】阿甲说：「${expected}」【镜头2】@阿甲呼吸。`,
      video_prompt: prompt([`阿甲说：「${actual}」`, '@阿甲呼吸。', '@阿甲停下。']),
    })
    const issue = hard(candidate).find(issue => issue.code === 'dialogue_preservation')!
    assert.ok(issue.message.includes(`首个差异${reason}：`), reason)
    assert.ok(issue.message.includes(`description ${expectedPosition}，video_prompt ${actualPosition}`), reason)
    assert.ok(issue.message.includes(`description预期发声=[1{speakerName="阿甲"，kind=dialogue，原词=${JSON.stringify(expected)}}]`), reason)
    assert.ok(issue.message.includes(`video_prompt实际发声=[1{speakerName="阿甲"，kind=dialogue，原词=${JSON.stringify(actual)}}]`), reason)
  }
  const changedKind = complete(8, [2, 1], {
    description: '【镜头1】旁白（阿甲）：「回来。」【镜头2】@阿甲呼吸。',
    video_prompt: prompt(['阿甲说：「回来。」', '@阿甲呼吸。', '@阿甲停下。']),
  })
  const issue = hard(changedKind).find(issue => issue.code === 'dialogue_preservation')!
  assert.ok(issue.message.includes('kind=narration'))
  assert.ok(issue.message.includes('kind=dialogue'))
  assert.ok(issue.message.includes('首个差异identity：'))
})

test('mapping diagnostics expose actual counts and totals while preserving the original hard rule', () => {
  const candidate = complete(8, [1, 1]), snapshot = structuredClone(candidate)
  const issue = hard(candidate).find(issue => issue.code === 'shot_time_mapping')!
  assert.equal(issue.field, 'time_row_counts')
  assert.match(issue.message, /当前counts=\[1,1\]，共2项、合计2行/)
  assert.match(issue.message, /description有2个子镜头，video_prompt有3个时间行/)
  assert.deepEqual(candidate, snapshot)
})

test('explicit offscreen attribution remains distinct from a visual presence and from narration', () => {
  for (const text of ['@阿甲（画外音）说：「回来。」', '画外音（阿甲）：「回来。」', '画外音：阿甲说：「回来。」']) {
    assert.deepEqual(spoken(text), [{ speakerName: '阿甲', kind: 'offscreen', text: '回来。' }], text)
    assert.deepEqual(validateSkillDialogueCoverage([described(text)], '阿甲（画外音）：回来。', names), [], text)
  }
  const wrong = validateSkillDialogueCoverage([described('阿甲说：「回来。」')], '阿甲（画外音）：回来。', names)
  assert.equal(wrong[0]?.shotNumber, 1)
  assert.match(wrong[0]?.message || '', /说话者|声音类型/)
})

test('a current utterance beginning with an explicit offscreen qualifier retains its kind through age, delivery and voice descriptions', () => {
  for (const text of [
    '画外四岁的@高美兰哭喊着说：「爸爸！舅舅要把弟弟喂狗！」',
    '老人留在床上。画外四岁的@高美兰以稚嫩尖细、带哭腔的声音哭喊着说：「爸爸！舅舅要把弟弟喂狗！」',
    '【镜头2】画外四岁的@高美兰哭喊着说：「爸爸！舅舅要把弟弟喂狗！」',
    'Offscreen, four-year-old @Mia sobs in a thin trembling voice and says: "Daddy!"',
    'O.S. four-year-old @Mia sobs in a thin trembling voice and says: "Daddy!"',
    '(V.O.) four-year-old @Mia sobs in a thin trembling voice and says: "Daddy!"',
    '画外の四歳の@ミアが泣きながら言う：「お父さん！」',
    '보이스오버 네 살의 @Mia가 울먹이며 말한다: "아빠!"',
  ]) {
    const turns = skillSpokenTurns(text, ['高美兰', 'Mia', 'ミア'])
    assert.equal(turns.length, 1, text)
    assert.equal(turns[0].kind, 'offscreen', text)
    assert.equal(turns[0].speakerName, undefined, 'The cue establishes only voice kind, never an inferred actor')
  }
})

test('earlier or ambient offscreen sounds cannot change a later explicit in-scene utterance', () => {
  for (const text of [
    '画外传来呼吸声。@阿甲低声说：「回来。」',
    '画外传来呼吸声，@阿甲说：「回来。」',
    'Offscreen breathing is heard. @阿甲 says: "回来。"',
    'Offscreen breathing is heard, @阿甲 says: "回来。"',
    '【镜头1】画外传来呼吸声。【镜头2】@阿甲说：「回来。」',
    '画外童声说：「爸爸！」@阿甲说：「回来。」',
  ]) {
    const turns = skillSpokenTurns(text, names)
    assert.equal(turns.at(-1)?.kind, 'dialogue', text)
    assert.equal(turns.at(-1)?.speakerName, '阿甲', text)
  }
  assert.equal(skillSpokenTurns('阿甲说：「画外只是原词。」', names)[0].kind, 'dialogue')
})

test('real stream group 5 preserves the complete child cry as offscreen in local and source-16 global checks', () => {
  const realAssets = { characters: [{ id: 8, name: '老年高大山' }, { id: 9, name: '老年张晓茹' }, { id: 11, name: '高美兰' }],
    scenes: [{ id: 4, location: '高家卧室' }], props: [{ id: 4, name: '全家福' }] }
  const cry = '爸爸！舅舅要把弟弟喂狗！'
  const utterance = `画外四岁的@高美兰哭喊着说：「${cry}」`
  const candidate = complete(13, [1, 1, 1, 2], {
    shot_number: 5, scene_id: 4, character_ids: [8, 9, 11], prop_ids: [4], source_ids: [14, 15, 16],
    description: '【镜头1】@老年高大山看向床边。' +
      '【镜头2】@老年张晓茹站在床边。' +
      '【镜头3】@老年高大山抬起手，气息骤然停止。' +
      `【镜头4】@老年高大山手臂落到褥子外侧，@老年张晓茹俯视他。${utterance}稚嫩尖细、带哭腔的童声由远而近，画面中始终只有两位老人。`,
    video_prompt: prompt(['@老年高大山看向床边。', '@老年张晓茹站在床边。', '@老年高大山抬起手，气息骤然停止。',
      '@老年高大山手臂慢慢下垂，@老年张晓茹俯视他。',
      `@老年高大山右手落到褥子外侧，@老年张晓茹站定。${utterance}稚嫩尖细、带哭腔的童声，语速急促、字字相连，声浪由远及近、尾音未落延续进下一段；画面中始终只有两位老人。`], 13)
      .replace(header, '出场人物：@老年高大山、@老年张晓茹；场景：@高家卧室。').replaceAll('@院落', '@高家卧室'),
  })
  const script = [...Array.from({ length: 15 }, () => '动作：床边原有状态连续。'), `高美兰（画外音，哭喊）：${cry}`].join('\n')
  const before = structuredClone(candidate), realNames = realAssets.characters.map(character => character.name)
  assert.deepEqual(validateSkillStoryboard(candidate, realAssets).filter(issue => issue.severity === 'error'), [])
  const coverage = validateSkillDialogueCoverage([candidate], script, realNames)
  assert.deepEqual(coverage.filter(issue => issue.severity === 'error'), [])
  assert.ok(coverage.some(issue => issue.code === 'attribution_review' && issue.field === 'source_ids.16' && issue.shotNumber === 5))
  assert.deepEqual(candidate, before)
  const wrongKind = structuredClone(candidate)
  wrongKind.description = wrongKind.description!.replace(utterance, `@高美兰说：「${cry}」`)
  wrongKind.video_prompt = wrongKind.video_prompt!.replace(utterance, `@高美兰说：「${cry}」`)
  assert.ok(validateSkillDialogueCoverage([wrongKind], script, realNames).some(issue => issue.code === 'dialogue_coverage' && issue.severity === 'error'), 'A genuinely changed in-scene voice remains a hard type contradiction')
})

test('an explicit same-speaker offscreen annotation survives age, voice details and a repeated formal speaking name in the same sentence', () => {
  const cry = '爸爸！舅舅要把弟弟喂狗！'
  const realNames = ['老年高大山', '老年张晓茹', '高美兰']
  const utterance = `门外传来@高美兰（画外，人在门外，未入镜）四岁女童清亮偏细的童声，奔跑中气息急促、哭腔发颤，音量由远而近、语速约每秒3.3字，@高美兰说：「${cry}」`
  assert.deepEqual(skillSpokenTurns(utterance, realNames).map(({ speakerName, kind, text }) => ({ speakerName, kind, text })), [
    { speakerName: '高美兰', kind: 'offscreen', text: cry },
  ])
  const candidate = described(utterance, 5, [15, 16])
  const script = [...Array.from({ length: 15 }, () => '动作：原有床边状态连续。'), `高美兰（画外音，哭喊）：${cry}`].join('\n')
  const snapshot = structuredClone(candidate)
  assert.deepEqual(validateSkillDialogueCoverage([candidate], script, realNames), [])
  assert.deepEqual(candidate, snapshot, 'speaker, source words, framing and original prose remain untouched')
  assert.equal(skillSpokenTurns('门外传来@阿甲（未入镜）的中年低音声线，@阿甲说：「回来。」', names)[0].kind, 'offscreen')
})

test('same-speaker presentation cannot leak from a previous sentence, another speaker, ambient sound or quoted dialogue', () => {
  for (const text of [
    '@阿甲（画外，未入镜）的声音保持原状。@阿甲说：「回来。」',
    '@阿甲（画外，未入镜）的声音保持原状；@阿甲说：「回来。」',
    '【镜头1】@阿甲（画外，未入镜）的声音保持原状。【镜头2】@阿甲说：「回来。」',
    '@阿乙（画外，未入镜）的声线低沉，@阿甲说：「回来。」',
    '@阿甲乙（画外，未入镜）的声线低沉，@阿甲说：「回来。」',
    '门外传来急促脚步与哭声，@阿甲说：「回来。」',
    '@阿乙说：「@阿甲（画外，未入镜）是原词。」随后@阿甲说：「回来。」',
    '@阿甲（口中原词为「画外，未入镜」）停顿后，@阿甲说：「回来。」',
  ]) {
    const last = skillSpokenTurns(text, names).at(-1)!
    assert.equal(last.speakerName, '阿甲', text)
    assert.equal(last.kind, 'dialogue', text)
    assert.equal(last.text, '回来。', text)
  }
})

test('a current explicit in-frame declaration overrides an earlier same-person offscreen cue and still fails an offscreen source', () => {
  for (const text of [
    '@阿甲（画外，未入镜）的声音保持原有低音区，@阿甲（画内）说：「回来。」',
    '@阿甲（画外）的声音保持原有低音区，@阿甲说（画内）：「回来。」',
    '@阿甲（画外）的声音保持原有低音区，@阿甲（已入镜）说：「回来。」',
  ]) {
    assert.equal(skillSpokenTurns(text, names)[0].kind, 'dialogue', text)
    assert.ok(validateSkillDialogueCoverage([described(text)], '阿甲（画外音）：回来。', names)
      .some(issue => issue.code === 'dialogue_coverage' && issue.severity === 'error'), text)
  }
})

test('a real same-sentence named voice OS qualifier survives delivery details and the repeated speaking name', () => {
  const words = '转脸就不认婚事！'
  const realNames = ['秦翠花', '苏娜英']
  for (const annotation of ['OS', 'O.S.', '画外', 'os']) {
    const utterance = `院中方向画外传来@秦翠花的声音（${annotation}），语速约每秒4字：@秦翠花说：「${words}」`
    assert.deepEqual(skillSpokenTurns(utterance, realNames).map(({ speakerName, kind, text }) => ({ speakerName, kind, text })), [
      { speakerName: '秦翠花', kind: 'offscreen', text: words },
    ])
    const candidate = complete(10, [1, 1, 2], {
      description: `【镜头1】@秦翠花停在院内原处。【镜头2】@苏娜英停在门内，@秦翠花（画外/OS）说：「${words}」【镜头3】@秦翠花仍保持原有站位。`,
      video_prompt: prompt(['@秦翠花停在院内原处。', `@苏娜英停在门内。${utterance}`, '@秦翠花保持原有站位。', '@秦翠花仍在原处。'], 10),
      character_ids: [1, 2],
    })
    for (const key of Object.keys(candidate) as Array<keyof SkillCandidate>) {
      if (typeof candidate[key] === 'string') (candidate as any)[key] = (candidate[key] as string).replaceAll('阿甲', '秦翠花')
    }
    const realAssets = { ...assets, characters: [{ id: 1, name: '秦翠花' }, { id: 2, name: '苏娜英' }] }
    const before = structuredClone(candidate)
    assert.deepEqual(validateSkillStoryboard(candidate, realAssets).filter(issue => issue.severity === 'error'), [], annotation)
    assert.deepEqual(validateSkillDialogueCoverage([candidate], `秦翠花（画外音）：${words}`, realNames), [], annotation)
    assert.deepEqual(candidate, before, 'Only attribution interpretation changes; the original prose and words remain untouched')
  }
})

test('a named voice annotation does not borrow OS from another actor, sentence, ambient sound, visual quote or unrelated abbreviation', () => {
  for (const text of [
    '@阿甲的声音（OS）保持低沉。@阿甲说：「回来。」',
    '@阿甲的声音（O.S.）保持低沉；@阿甲说：「回来。」',
    '【镜头1】@阿甲的声音（OS）保持低沉。【镜头2】@阿甲说：「回来。」',
    '@阿乙的声音（OS）保持低沉，@阿甲说：「回来。」',
    '@阿甲乙的声音（OS）保持低沉，@阿甲说：「回来。」',
    '门外传来@阿甲的声音，@阿甲说：「回来。」',
    '画外传来树叶与脚步声，@阿甲说：「回来。」',
    '@阿乙说：「@阿甲的声音（OS）只是原词。」随后@阿甲说：「回来。」',
    '@阿甲的声音（原词「OS」）没有改变，@阿甲说：「回来。」',
    '@阿甲的声音（BOSS）保持低沉，@阿甲说：「回来。」',
    '@阿甲的声音（V.O.）保持低沉，@阿甲说：「回来。」',
  ]) {
    const turn = skillSpokenTurns(text, names).at(-1)!
    assert.equal(turn.speakerName, '阿甲', text)
    assert.equal(turn.kind, 'dialogue', text)
    assert.equal(turn.text, '回来。', text)
  }
  const unknown = skillSpokenTurns('院中方向传来某人的声音（OS），有人说：「回来。」', names,
    [{ speakerName: '阿甲', kind: 'offscreen', text: '回来。', start: 0, end: 3 }]).at(-1)!
  assert.equal(unknown.speakerName, undefined, 'Expected source dialogue must not manufacture the actor')
})

test('a current explicit in-frame declaration still overrides the same named voice OS annotation', () => {
  for (const text of [
    '@阿甲的声音（OS）保持低沉，@阿甲（画内）说：「回来。」',
    '@阿甲的声音（O.S.）保持低沉，@阿甲说（已入镜）：「回来。」',
    '@阿甲的声音（OS）仍在，@阿甲的声音（画内）变清晰，@阿甲说：「回来。」',
  ]) {
    assert.equal(skillSpokenTurns(text, names)[0].kind, 'dialogue', text)
    assert.ok(validateSkillDialogueCoverage([described(text)], '阿甲（画外音）：回来。', names)
      .some(issue => issue.code === 'dialogue_coverage' && issue.severity === 'error'), text)
  }
  const narration = skillSpokenTurns('@阿甲的声音（OS）保持低沉，旁白（阿甲）：「回来。」', names)
  assert.equal(narration.at(-1)?.kind, 'narration', 'An explicit current narrator is not converted into actor offscreen dialogue')
})

test('an explicit offscreen OS label immediately before the current actor survives a preceding location phrase', () => {
  const words = '转脸就不认婚事！'
  const actual = `院中方向传来秦翠花的骂声，秦翠花本人不入镜，只闻其声，苏娜英始终闭唇不接口型。院中画外（OS）秦翠花说：「${words}」`
  assert.deepEqual(skillSpokenTurns(actual, ['秦翠花', '苏娜英']).map(({ speakerName, kind, text }) => ({ speakerName, kind, text })), [
    { speakerName: '秦翠花', kind: 'offscreen', text: words },
  ])
  for (const utterance of [
    '院中画外（OS）@阿甲说：「回来。」',
    '院中画外（O.S.）阿甲说：「回来。」',
    '院中OS @阿甲说：「回来。」',
    '院中O.S. 阿甲说：「回来。」',
  ]) {
    assert.equal(skillSpokenTurns(utterance, names)[0].kind, 'offscreen', utterance)
    const candidate = complete(8, [2, 1], {
      description: `【镜头1】@阿甲保持原有站位。${utterance}【镜头2】@阿甲仍在原处。`,
      video_prompt: prompt(['@阿甲保持原有站位。@阿甲说（画外/OS）：「回来。」', '@阿甲保持原有站位。', '@阿甲仍在原处。']),
    })
    assert.deepEqual(hard(candidate), [], utterance)
    assert.deepEqual(validateSkillDialogueCoverage([candidate], '阿甲（画外音）：回来。', names), [], utterance)
  }
})

test('an immediately preceding voice label cannot be supplied by another actor, location, prior sentence or quoted content', () => {
  for (const utterance of [
    '门外@阿甲说：「回来。」',
    '院中传来脚步和呼吸，@阿甲说：「回来。」',
    '院中画外（OS）。@阿甲说：「回来。」',
    '【镜头1】院中画外（OS）【镜头2】@阿甲说：「回来。」',
    '院中画外（OS）@阿乙的声音保持低沉，@阿甲说：「回来。」',
    '@阿乙说：「院中画外（OS）」@阿甲说：「回来。」',
    '牌子写着「院中画外（OS）」@阿甲说：「回来。」',
  ]) {
    const turn = skillSpokenTurns(utterance, names).at(-1)!
    assert.equal(turn.speakerName, '阿甲', utterance)
    assert.equal(turn.kind, 'dialogue', utterance)
  }
  const unknown = skillSpokenTurns('院中画外（OS）某人说：「回来。」', names,
    [{ speakerName: '阿甲', kind: 'offscreen', text: '回来。', start: 0, end: 3 }]).at(-1)!
  assert.equal(unknown.speakerName, undefined, 'Explicit presentation does not manufacture the current actor from expected source words')
})

test('a current explicit in-frame label remains stronger than a preceding OS label or earlier same-person offscreen annotation', () => {
  for (const utterance of [
    '院中画外（OS）@阿甲（画内）说：「回来。」',
    '院中画外（OS）@阿甲说（已入镜）：「回来。」',
    '@阿甲的声音（OS）仍在，院中画内@阿甲说：「回来。」',
    '院中画内@阿甲说（OS）：「回来。」',
  ]) {
    assert.equal(skillSpokenTurns(utterance, names)[0].kind, 'dialogue', utterance)
    assert.ok(validateSkillDialogueCoverage([described(utterance)], '阿甲（画外音）：回来。', names)
      .some(issue => issue.code === 'dialogue_coverage' && issue.severity === 'error'), utterance)
  }
})

test('an unframed original character utterance may alternate between in-scene and offscreen reaction shots without changing speaker or words', () => {
  const script = '秦翠花：（指着高大山）他把晓茹关屋里耍流氓！转脸就不认婚事！还跟隔壁苏娜英不清不楚！'
  const candidate = complete(10, [1, 1, 2], {
    description: '【镜头1】秦翠花说：「他把晓茹关屋里耍流氓！」' +
      '【镜头2】苏娜英闭唇不接口型。院中画外（OS）秦翠花说：「转脸就不认婚事！」' +
      '【镜头3】秦翠花说：「还跟隔壁苏娜英不清不楚！」',
  })
  const snapshot = structuredClone(candidate)
  assert.deepEqual(validateSkillDialogueCoverage([candidate], script, ['秦翠花', '苏娜英', '高大山']), [])
  assert.deepEqual(candidate, snapshot)
})

test('source presentation flexibility never allows explicit framing contradictions, narration, changed actors or changed words', () => {
  for (const [source, actual] of [
    ['阿甲（画内）：回来。', '@阿甲（画外）说：「回来。」'],
    ['阿甲：（画内，低声）回来。', '@阿甲（OS）说：「回来。」'],
    ['阿甲（画外音）：回来。', '@阿甲说：「回来。」'],
    ['旁白：回来。', '@阿甲说：「回来。」'],
    ['阿甲：回来。', '旁白：「回来。」'],
    ['阿甲：回来。', '@阿乙（画外）说：「回来。」'],
    ['阿甲：回来。', '@阿甲（画外）说：「回去。」'],
    ['阿甲：照着念“OS”。', '@阿甲（画外）说：「照着念。」'],
  ]) {
    assert.ok(validateSkillDialogueCoverage([described(actual)], source, names)
      .some(issue => issue.code === 'dialogue_coverage' && issue.severity === 'error'), `${source} / ${actual}`)
  }
  const localMismatch = complete(8, [2, 1], {
    description: '【镜头1】@阿甲说：「回来。」【镜头2】@阿甲保持原有位置。',
    video_prompt: prompt(['@阿甲（画外）说：「回来。」', '@阿甲保持原有位置。', '@阿甲仍在原处。']),
  })
  assert.ok(codes(localMismatch).includes('dialogue_preservation'), 'Description/video comparison stays strict even when the source did not prescribe framing')
})

test('unquoted narration preserves final punctuation and ends at the next explicit utterance', () => {
  assert.deepEqual(spoken('旁白：雨停了。'), [{ speakerName: undefined, kind: 'narration', text: '雨停了。' }])
  assert.deepEqual(spoken('旁白：雨停了。阿甲说：「回来。」'), [
    { speakerName: undefined, kind: 'narration', text: '雨停了。' },
    { speakerName: '阿甲', kind: 'dialogue', text: '回来。' },
  ])
  const candidate = complete(8, [2, 1], {
    description: '【镜头1】@阿甲停在门槛边。旁白：雨停了。天亮了。【镜头2】@阿甲抬眼。',
    video_prompt: prompt(['@阿甲停在门槛边。旁白：雨停了。天亮了。', '@阿甲呼吸。', '@阿甲抬眼。']),
  })
  assert.deepEqual(hard(candidate), [])
  assert.deepEqual(validateSkillDialogueCoverage([candidate], '动作：停下。\n旁白：雨停了。天亮了。\n动作：抬眼。', names), [])
  candidate.description = candidate.description!.replace('天亮了。', '天亮了')
  assert.ok(validateSkillDialogueCoverage([candidate], '旁白：雨停了。天亮了。', names).length)
})

test('visual quotes, nested quoted words and apostrophes are not flattened into fictional spoken lines', () => {
  const visual = '牌匾写着「欢迎来到山间小屋请先擦干鞋底」，@阿甲伸手触碰既有边缘。'
  assert.deepEqual(spoken(visual), [])
  const candidate = complete(8, [1, 2], {
    description: `【镜头1】${visual}【镜头2】@阿甲收回手。`,
    video_prompt: prompt([`@阿甲看见${visual}`, '@阿甲收回手。', '@阿甲自然呼吸。']),
  })
  assert.deepEqual(hard(candidate), [])
  assert.deepEqual(validateSkillDialogueCoverage([candidate], `动作：${visual}\n动作：收回手。`, names), [])
  assert.deepEqual(spoken('阿甲说：「门上写着「回家」，我们到了。」'), [{ speakerName: '阿甲', kind: 'dialogue', text: '门上写着「回家」，我们到了。' }])
  assert.deepEqual(spoken("阿甲说：'Don't go.'"), [{ speakerName: '阿甲', kind: 'dialogue', text: "Don't go." }])
})

test('whole-group dialogue budget remains hard while per-row estimates warn for continuations and short remainder rows', () => {
  const long = '话'.repeat(28)
  const overTotal = complete(8, [2, 1], {
    description: `【镜头1】阿甲说：「${long}」【镜头2】@阿甲停下。`,
    video_prompt: prompt([`阿甲说：「${long.slice(0, 14)}」`, `阿甲说：「${long.slice(14)}」`, '@阿甲停下。']),
  })
  assert.ok(codes(overTotal).includes('dialogue_budget'))
  assert.equal(validateSkillStoryboard(overTotal, assets).find(issue => issue.code === 'dialogue_budget')!.severity, 'error')
  const overTotalWarnings = validateSkillStoryboard(overTotal, assets).filter(issue => issue.code === 'line_dialogue_budget')
  assert.ok(overTotalWarnings.length > 0)
  assert.ok(overTotalWarnings.every(issue => issue.severity === 'warning'))
  assert.ok(!codes(overTotal).includes('line_dialogue_budget'))
  const inRemainder = complete(8, [1, 2], {
    description: `【镜头1】@阿甲停下。【镜头2】阿甲说：「${'字'.repeat(10)}」`,
    video_prompt: prompt(['@阿甲停下。', '@阿甲准备开口。', `阿甲说：「${'字'.repeat(10)}」`]),
  })
  assert.equal(validateSkillStoryboard(inRemainder, assets).find(issue => issue.code === 'line_dialogue_budget')!.severity, 'warning')
  assert.ok(!codes(inRemainder).includes('line_dialogue_budget'))
  assert.ok(!codes(inRemainder).includes('dialogue_budget'))
  const continued = complete(8, [2, 1], {
    description: `【镜头1】阿甲说：「好，${'字'.repeat(14)}」【镜头2】@阿甲停下。`,
    video_prompt: prompt(['阿甲说：「好，」', `@阿甲接着吐出余句：「${'字'.repeat(14)}」`, '@阿甲停下。']),
  })
  assert.ok(!codes(continued).includes('dialogue_preservation'))
  assert.equal(validateSkillStoryboard(continued, assets).find(issue => issue.code === 'line_dialogue_budget')!.severity, 'warning')
  assert.ok(!codes(continued).includes('line_dialogue_budget'))
})

test('a 12-second two-child group preserves a 16-plus-13-character utterance across its last two rows with only a row estimate warning', () => {
  const first = '事情到了这一步我们两个人必须承担，', second = '等天亮以后再一起给孩子解释。'
  const full = first + second
  const candidate = complete(12, [2, 2], {
    description: `【镜头1】@阿甲在门槛边站稳，抬眼看向原有位置，准备开口。` +
      `【镜头2】@阿甲吸气后，阿甲说：「${full}」说完双手自然放下，留在原位等待。`,
    video_prompt: prompt(['@阿甲站稳后抬眼看向原有位置。', '@阿甲承接呼吸，准备开口。',
      `@阿甲吸气后，阿甲说：「${first}」`, `@阿甲承接同一口气，阿甲说：「${second}」说完双手自然放下，留在原位等待。`], 12),
  })
  const snapshot = structuredClone(candidate), issues = validateSkillStoryboard(candidate, assets)
  assert.deepEqual(issues.filter(issue => issue.severity === 'error'), [])
  const rowWarnings = issues.filter(issue => issue.code === 'line_dialogue_budget')
  assert.equal(rowWarnings.length, 1)
  assert.equal(rowWarnings[0].severity, 'warning')
  assert.match(rowWarnings[0].message, /第3时间行.*原词共16字.*估算容量13\.5字，超出2\.5字/)
  assert.equal(issues.some(issue => issue.code === 'dialogue_budget'), false, '29/4.5 + 2 seconds fits the full 12-second group')
  assert.deepEqual(validateSkillDialogueCoverage([candidate], `阿甲：${full}`, names), [])
  assert.deepEqual(candidate, snapshot, 'The warning must not delete words or change their row allocation')
})

test('row-budget diagnostics report actual letters, row seconds and numerical capacity including the final remainder', () => {
  for (const [duration, mapping, wordCount, rowIndex, seconds, capacity, overflow] of [
    [8, [1, 2], 14, 0, 3, 13.5, 0.5], [8, [1, 2], 10, 2, 2, 9, 1], [13, [2, 1, 2], 5, 4, 1, 4.5, 0.5],
  ] as const) {
    const rowCount = Math.ceil(duration / 3), words = '字'.repeat(wordCount)
    const child = rowIndex === 0 ? 1 : mapping.length
    const candidate = complete(duration, [...mapping], {
      description: mapping.map((_, index) => `【镜头${index + 1}】${index + 1 === child ? `阿甲说：「${words}」` : '@阿甲呼吸。'}`).join(''),
      video_prompt: prompt(Array.from({ length: rowCount }, (_, index) => index === rowIndex ? `阿甲说：「${words}」` : '@阿甲呼吸。'), duration),
    })
    const snapshot = structuredClone(candidate)
    const issue = validateSkillStoryboard(candidate, assets).find(issue => issue.code === 'line_dialogue_budget')!
    assert.equal(issue.field, 'video_prompt')
    assert.equal(issue.severity, 'warning')
    assert.ok(issue.message.includes(`第${rowIndex + 1}时间行（${rowIndex * 3}—${Math.min((rowIndex + 1) * 3, duration)}秒，实际${seconds}秒）原词共${wordCount}字`))
    assert.ok(issue.message.includes(`按4.5字/秒估算容量${capacity}字，超出${overflow}字`))
    assert.ok(!codes(candidate).includes('dialogue_preservation'))
    assert.deepEqual(candidate, snapshot)
  }
})

test('global coverage accepts a source utterance naturally spanning adjacent groups and preserves all input', () => {
  const candidates = [described('阿甲说：「我们两个人必须共同承担。」', 2, [1, 2]), described('阿甲说：「这件事，」', 1, [1])]
  const script = '阿甲：这件事，我们两个人必须共同承担。\n动作：原有呼吸连续。'
  const snapshot = structuredClone({ candidates, script, names })
  assert.deepEqual(validateSkillDialogueCoverage(candidates, script, names), [])
  assert.deepEqual({ candidates, script, names }, snapshot)
})

test('global changed words, speaker, type or extra speech locate the actual bad group rather than all ready groups', () => {
  const script = '动作：既有停步。\n阿甲：回来。\n阿乙：好。'
  for (const text of ['阿乙说：「回来。」', '阿甲说：「回去。」', '阿甲的画外音：「回来。」']) {
    const candidates = [described(text, 7, [1, 2]), described('阿乙说：「好。」', 8, [3])]
    const source = text === '阿甲的画外音：「回来。」' ? script.replace('阿甲：', '阿甲（画内）：') : script
    const issues = validateSkillDialogueCoverage(candidates, source, names)
    assert.equal(issues.length, 1, text)
    assert.equal(issues[0].shotNumber, 7, text)
    assert.equal(issues[0].field, 'source_ids.2', text)
    assert.equal(issues[0].severity, 'error')
  }
  const duplicate = validateSkillDialogueCoverage([
    described('阿甲说：「回来。」', 7, [1, 2]), described('阿乙说：「好。」阿乙说：「好。」', 8, [3]),
  ], script, names)
  assert.equal(duplicate[0]?.shotNumber, 8)
  assert.equal(duplicate[0]?.field, 'description')
})

test('global missing middle speech points to its source-owning group instead of blaming a correct later turn', () => {
  const script = '\n动作：既有停步。\n\n阿甲：先回来。\n阿乙：好。\n阿甲：一起走。'
  const candidates = [described('', 4, [1, 2]), described('阿乙说：「好。」', 5, [3]), described('阿甲说：「一起走。」', 6, [4])]
  const snapshot = structuredClone(candidates)
  const issues = validateSkillDialogueCoverage(candidates, script, names)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].shotNumber, 4)
  assert.equal(issues[0].field, 'source_ids.2')
  assert.deepEqual(candidates, snapshot)
})

test('global missing tail uses the last owning group and source IDs follow nonempty script lines', () => {
  const script = '\n动作：停步。\n\n阿甲：先回来。\n阿乙：我们一起走。\n动作：收尾。'
  const candidates = [described('阿甲说：「先回来。」', 4, [1, 2]), described('阿乙说：「我们」', 5, [3]), described('', 6, [3, 4])]
  const issues = validateSkillDialogueCoverage(candidates, script, names)
  assert.equal(issues[0]?.shotNumber, 6)
  assert.equal(issues[0]?.field, 'source_ids.3')
  const noOwners = validateSkillDialogueCoverage([described('阿甲说：「先回来。」', 4, [1, 2]), described('', 6, [4])], script, names)
  assert.equal(noOwners[0]?.shotNumber, 6)
})

test('pure action units need no invented dialogue and extra speech is still reported', () => {
  const script = '动作：阿甲停在门槛边。\n木牌上写着「回家」。'
  assert.deepEqual(validateSkillDialogueCoverage([described('', 3, [1, 2])], script, names), [])
  const extra = validateSkillDialogueCoverage([described('阿甲说：「回家。」', 3, [1, 2])], script, names)
  assert.equal(extra[0]?.shotNumber, 3)
  assert.equal(extra[0]?.field, 'description')
  assert.equal(extra[0]?.severity, 'error')
})
