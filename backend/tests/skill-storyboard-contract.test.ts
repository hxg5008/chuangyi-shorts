import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import {
  splitScriptUnits, scriptTimingTarget, scriptTimingBudget, storyboardGroupBudget, validateStoryboardAssets,
  buildScriptUnitSpeechBudgets, analyzeNarrativeSpeechCapacity,
  buildNarrativePlanSchema, buildCompleteStoryboardSchema, compileStoryboardReferences, validateNarrativePlan,
  type CompleteStoryboard, type StoryboardContractAssets,
} from '../src/services/skill-storyboard-contract.ts'

const assets: StoryboardContractAssets = {
  characters: [{ id: 1, name: '阿甲' }, { id: 2, name: '阿乙' }],
  scenes: [{ id: 10, location: '院落' }, { id: 11, location: '屋内' }], props: [{ id: 20, name: '木杯' }],
}
const complete = (overrides: Partial<CompleteStoryboard> = {}): CompleteStoryboard => ({
  shot_number: 1, title: '院中归来', time: '日，既有日光', location: '[[scene:10]]的门槛与院墙',
  shot_type: '中景＋近景', angle: '平视', movement: '固定后缓推',
  description: '【镜头1】[[character:1]]沿门槛走入院落，停下后将[[prop:20]]放回原桌面。【镜头2】[[character:2]]抬眼回应。',
  result: '[[character:1]]双手放下，[[prop:20]]留在桌上，等待原有回应。',
  atmosphere: '既有晨光从东侧照入，院内原有声响连续。',
  image_prompt: '[[scene:10]]内，[[character:1]]站在门槛边，[[prop:20]]位于原有桌面。',
  video_prompt: '出场人物：[[character:1]]、[[character:2]]；场景：[[scene:10]]。\n0-3秒：[[character:1]]沿门槛走入。\n3-6秒：继续同一动作后放下[[prop:20]]。\n6-9秒：切到[[character:2]]抬眼。\n9-12秒：回应后落到原有末态。',
  bgm_prompt: '无背景音乐', sound_effect: '脚步、杯底轻触桌面及原有环境声。',
  duration: 12, scene_id: 10, character_ids: [], prop_ids: [], source_ids: [1, 2, 3], time_row_counts: [2, 2], ...overrides,
})
const screenplay = () => `动作：${'雨'.repeat(70)}。\n阿甲：你好。\n动作：${'静'.repeat(24)}。`
const narrative = (source_ids = [1, 2, 3]) => ({ groups: [{ number: 1, title: '归来与回应', beat: 'narrative' as const, source_ids, scene_id: 10, duration: 12 }] })
const hard = (values: ReturnType<typeof validateNarrativePlan>) => values.filter(value => value.severity === 'error')

test('script units retain every nonempty action and dialogue line without sentence or character slicing', () => {
  const long = '很长但仍是一整段原词，'.repeat(30)
  const script = `  开场：雨停。  \r\n\r\n阿甲：（低声）「${long}」\n无台词动作：将木杯放回桌面。\n收尾：院门缓缓合上。`
  const units = splitScriptUnits(script)
  assert.equal(units.length, 4)
  assert.deepEqual(units.map(unit => unit.id), [1, 2, 3, 4])
  assert.equal(units[0].text, '  开场：雨停。  ')
  assert.equal(units[1].text, `阿甲：（低声）「${long}」`)
  assert.equal(units[2].text, '无台词动作：将木杯放回桌面。')
  assert.equal(units[3].text, '收尾：院门缓缓合上。')
  assert.deepEqual(splitScriptUnits(' \n\t'), [])
})

test('the timing target uses Unicode letters and numbers, explicitly exposing the 500-character budget', () => {
  const script = '文'.repeat(960) + '𠮷，！ \n'
  assert.equal(scriptTimingTarget(script), 115.32)
  assert.deepEqual(scriptTimingBudget(script), { characters: 961, charactersPerMinute: 500, targetSeconds: 115.32, minimumSeconds: 92.256, maximumSeconds: 138.384 })
})

test('group count is anchored to the unrounded estimate and independently rejects seventeen short groups', () => {
  const script = '景'.repeat(1153), units = splitScriptUnits(script)
  const budget = storyboardGroupBudget(script)
  assert.equal(budget.preferredGroupCount, 12)
  assert.equal(budget.minimumGroups, 10)
  assert.equal(budget.maximumGroups, 13)
  assert.equal(budget.integerFallback, false)
  const plan = (count: number, duration: number) => ({ groups: Array.from({ length: count }, (_, index) => ({
    number: index + 1, title: '同场景连续叙事', beat: duration > 10 ? 'narrative' as const : 'transition' as const,
    source_ids: [1], scene_id: 10, duration,
  })) })
  for (const count of [10, 11, 12, 13]) {
    assert.deepEqual(hard(validateNarrativePlan(plan(count, 12), units, assets, script)), [], String(count))
  }
  const rejected = hard(validateNarrativePlan(plan(17, 8), units, assets, script))
  assert.equal(rejected.length, 1, '136 total seconds pass; only the excessive group count fails')
  assert.equal(rejected[0].code, 'narrative_group_count')
  for (const detail of ['1153字', '138.36秒', '建议12组', '10–13组', '当前17组']) assert.ok(rejected[0].message.includes(detail), detail)
})

test('group-count integer boundaries remain inclusive without rounding the tolerance outward', () => {
  const script = '景'.repeat(1000), units = splitScriptUnits(script), budget = storyboardGroupBudget(script)
  assert.deepEqual([budget.minimumGroups, budget.maximumGroups, budget.preferredGroupCount], [8, 12, 10])
  const plan = (count: number) => ({ groups: Array.from({ length: count }, (_, index) => ({
    number: index + 1, title: '边界测试', beat: 'narrative' as const, source_ids: [1], scene_id: 10, duration: 12,
  })) })
  for (const count of [8, 12]) assert.equal(hard(validateNarrativePlan(plan(count), units, assets, script)).some(i => i.code === 'narrative_group_count'), false)
  for (const count of [7, 13]) assert.equal(hard(validateNarrativePlan(plan(count), units, assets, script)).some(i => i.code === 'narrative_group_count'), true)
})

test('short scripts only fall back to nearest positive group count when their interval has no integer', () => {
  for (const [characters, expected, fallback] of [[67, 1, true], [100, 1, false], [150, 2, true], [200, 2, false]] as const) {
    const budget = storyboardGroupBudget('景'.repeat(characters))
    assert.equal(budget.minimumGroups, expected, String(characters))
    assert.equal(budget.maximumGroups, expected, String(characters))
    assert.equal(budget.integerFallback, fallback, String(characters))
  }
  assert.equal(storyboardGroupBudget('').minimumGroups, 1, 'separate missing-script validation still blocks an empty input')
})

test('catalog validation rejects invalid catalog data while duplicate formal names remain scoped warnings', () => {
  assert.deepEqual(validateStoryboardAssets(assets), [])
  const ambiguous = { ...assets, characters: [...assets.characters, { id: 1, name: '另名' }, { id: 3, name: '阿甲' }], props: [{ id: 20, name: '院落' }, { id: 21, name: '' }] }
  const codes = validateStoryboardAssets(ambiguous).map(value => value.code)
  assert.ok(codes.includes('asset_id_ambiguous'))
  assert.ok(codes.includes('asset_name_ambiguous'))
  assert.ok(codes.includes('asset_name_missing'))
  assert.ok(validateStoryboardAssets(ambiguous).filter(value => value.code === 'asset_name_ambiguous').every(value => value.severity === 'warning'))
  assert.deepEqual(validateStoryboardAssets({ characters: [{ id: 1, name: '甲' }], scenes: [{ id: 1, location: '院' }], props: [{ id: 1, name: '杯' }] }), [], 'kind-scoped IDs may coincide')
})

test('same-location day and night catalogs may select one exact scene ID without blocking compilation', () => {
  const catalog = { ...assets, scenes: [{ id: 10, location: '院落', time: '日' }, { id: 11, location: '院落', time: '夜' }] }
  const warnings = validateStoryboardAssets(catalog)
  assert.ok(warnings.length > 0 && warnings.every(value => value.severity === 'warning'))
  assert.ok(warnings.some(value => value.message.includes('ID 10') && value.message.includes('ID 11') && value.message.includes('日') && value.message.includes('夜')))
  for (const scene_id of [10, 11]) {
    const input = complete({ scene_id })
    for (const key of ['location', 'description', 'result', 'image_prompt', 'video_prompt'] as const) input[key] = input[key].replaceAll('[[scene:10]]', `[[scene:${scene_id}]]`)
    const result = compileStoryboardReferences(input, catalog)
    assert.ok(result.candidate, `${scene_id}`)
    assert.equal(result.candidate.scene_id, scene_id)
    assert.ok(result.issues.every(value => value.severity === 'warning'))
  }
})

test('only distinct used asset identities with the same compiled name cause a hard reference collision', () => {
  const catalog = { ...assets, characters: [...assets.characters, { id: 3, name: '阿甲' }] }
  const unused = compileStoryboardReferences(complete(), catalog)
  assert.ok(unused.candidate)
  assert.ok(unused.issues.some(value => value.code === 'asset_name_ambiguous' && value.severity === 'warning'))
  const selected = compileStoryboardReferences(complete({ character_ids: [3] }), catalog)
  assert.equal(selected.candidate, null)
  assert.ok(selected.issues.some(value => value.code === 'reference_name_ambiguous' && value.severity === 'error' && value.message.includes('character:1') && value.message.includes('character:3')))
  const repeated = compileStoryboardReferences(complete({ character_ids: [1, 1], result: '[[character:1]]抬眼，[[character:1]]把木杯放下。' }), catalog)
  assert.ok(repeated.candidate)
  assert.equal(repeated.candidate.character_ids.filter(id => id === 1).length, 1)
  assert.equal(repeated.issues.some(value => value.code === 'reference_name_ambiguous'), false)
  const crossKind = compileStoryboardReferences(complete(), { ...assets, props: [{ id: 20, name: '阿甲' }] })
  assert.equal(crossKind.candidate, null)
  assert.ok(crossKind.issues.some(value => value.code === 'reference_name_ambiguous' && value.message.includes('prop:20')))
})

test('narrative planning uses asset and source ID enums without preselecting creative shot counts', () => {
  const script = screenplay(), units = splitScriptUnits(script), schema = buildNarrativePlanSchema(assets, units)
  assert.equal(schema.safeParse(narrative()).success, true)
  for (const mutate of [(value: any) => { value.groups[0].source_ids = [99] }, (value: any) => { value.groups[0].scene_id = 99 },
    (value: any) => { value.groups[0].beat = 'unknown' }, (value: any) => { value.groups[0].duration = 7 }]) {
    const value = narrative(); mutate(value); assert.equal(schema.safeParse(value).success, false)
  }
  const wire = z.toJSONSchema(schema, { io: 'input', target: 'draft-7' })
  assert.equal(wire.type, 'object')
  const issues = validateNarrativePlan(narrative(), units, assets, script)
  assert.deepEqual(hard(issues), [])
  assert.ok(issues.some(value => value.code === 'semantic_review_required' && value.severity === 'warning'))
})

test('every original unit including silent actions must be covered in order, not merely dialogue lines', () => {
  const script = screenplay(), units = splitScriptUnits(script)
  assert.ok(hard(validateNarrativePlan(narrative([2]), units, assets, script)).some(value => value.code === 'source_coverage' && value.message.includes('1, 3')))
  assert.ok(hard(validateNarrativePlan(narrative([2, 1, 3]), units, assets, script)).some(value => value.code === 'source_order'))
  assert.ok(hard(validateNarrativePlan(narrative([1, 1, 2, 3]), units, assets, script)).some(value => value.code === 'source_duplicate'))
  assert.ok(hard(validateNarrativePlan(narrative(), units, assets, script + '新增动作。')).some(value => value.code === 'source_units_conflict'))
})

test('a long original utterance may span adjacent naturally planned groups without program-written fragments', () => {
  const script = `阿甲：${'话'.repeat(80)}。\n动作：${'静'.repeat(100)}。`, units = splitScriptUnits(script)
  const plan = { groups: [
    { number: 1, title: '说明前半', beat: 'narrative', source_ids: [1], scene_id: 10, duration: 12 },
    { number: 2, title: '说明与回应', beat: 'narrative', source_ids: [1, 2], scene_id: 10, duration: 12 },
  ] }
  const before = JSON.stringify({ script, units, plan })
  assert.deepEqual(hard(validateNarrativePlan(plan, units, assets, script)), [])
  assert.equal(JSON.stringify({ script, units, plan }), before)
  const reversed = structuredClone(plan); reversed.groups[1].source_ids = [2, 1]
  assert.ok(hard(validateNarrativePlan(reversed, units, assets, script)).some(value => value.code === 'source_order'))
})

test('source speech budgets expose complete original utterances, speaker and kind without cutting or grouping', () => {
  const original = '这是一句完整的原话不要切开词语。'
  const units = splitScriptUnits(`动作：门缓缓合上。\n阿甲：（压低声音）${original}\n阿乙（画外音）：我在外面。\n旁白：雨停了。`)
  const before = JSON.stringify({ units, assets }), budgets = buildScriptUnitSpeechBudgets(units, assets)
  assert.deepEqual(budgets.map(unit => unit.spoken_characters), [0, 15, 4, 3])
  assert.deepEqual(budgets[0].utterances, [])
  assert.deepEqual(budgets[1].utterances, [{ speaker: '阿甲', kind: 'dialogue', text: original, characters: 15 }])
  assert.equal(budgets[1].minimum_speech_seconds, 15 / 4.5, 'the group performance margin is not added separately to each unit')
  assert.deepEqual(budgets[2].utterances, [{ speaker: '阿乙', kind: 'offscreen', text: '我在外面。', characters: 4 }])
  assert.deepEqual(budgets[3].utterances, [{ speaker: null, kind: 'narration', text: '雨停了。', characters: 3 }])
  assert.equal(JSON.stringify({ units, assets }), before)
})

test('an overlong complete source sentence reports its exact group capacity and residual deficit', () => {
  const script = `阿甲：${'话'.repeat(60)}。`, units = splitScriptUnits(script), budgets = buildScriptUnitSpeechBudgets(units, assets)
  const group = { ...narrative([1]).groups[0], duration: 15 }
  const analysis = analyzeNarrativeSpeechCapacity([group], budgets)
  assert.equal(analysis.feasible, false)
  assert.equal(analysis.total_demand_characters, 60)
  assert.equal(analysis.assigned_characters, 58)
  assert.deepEqual(analysis.conflicts, [{ source_ids: [1], group_numbers: [1], demand_characters: 60, capacity_characters: 58, deficit_characters: 2,
    units: [{ source_id: 1, spoken_characters: 60, group_numbers: [1] }], groups: [{ number: 1, duration: 15, capacity_characters: 58 }] }])
  const feedback = validateNarrativePlan({ groups: [group] }, units, assets, script).filter(value => value.capacity)
  assert.equal(feedback.length, 1)
  assert.equal(feedback[0].code, 'constraint_conflict'); assert.equal(feedback[0].severity, 'error')
  assert.deepEqual(feedback[0].capacity, analysis.conflicts[0])
  for (const detail of ['集合[1]', '组[1]', '60字', '58字', '缺2字']) assert.ok(feedback[0].message.includes(detail), detail)
  assert.equal(budgets[0].utterances.length, 1)
})

test('shared group overload is diagnosed as a source set rather than falsely accusing individually fitting units', () => {
  const script = `阿甲：${'甲'.repeat(30)}。\n阿乙：${'乙'.repeat(30)}。`, units = splitScriptUnits(script)
  const budgets = buildScriptUnitSpeechBudgets(units, assets), group = { ...narrative([1, 2]).groups[0], duration: 10 }
  const analysis = analyzeNarrativeSpeechCapacity([group], budgets)
  assert.ok(budgets.every(unit => unit.spoken_characters <= 36))
  assert.equal(analysis.conflicts.length, 1)
  const conflict = analysis.conflicts[0]
  assert.deepEqual(conflict.source_ids, [1, 2]); assert.deepEqual(conflict.group_numbers, [1])
  assert.equal(conflict.demand_characters, 60); assert.equal(conflict.capacity_characters, 36); assert.equal(conflict.deficit_characters, 24)
  assert.deepEqual(conflict.units.map(unit => unit.spoken_characters), [30, 30])
  const feedback = validateNarrativePlan({ groups: [group] }, units, assets, script).filter(value => value.capacity)
  assert.equal(feedback.length, 1)
  assert.ok(feedback[0].message.includes('共享容量缺口'))
  assert.ok(feedback[0].message.includes('不表示每条原句分别超限'))
})

test('residual reports separate independent bottlenecks and leave feasible cross-group allocation untouched', () => {
  const units = splitScriptUnits(`阿甲：${'甲'.repeat(60)}。\n阿乙：${'乙'.repeat(60)}。`), budgets = buildScriptUnitSpeechBudgets(units, assets)
  const groups = [{ ...narrative([1]).groups[0], duration: 10 }, { ...narrative([2]).groups[0], number: 2, duration: 10 }]
  const before = JSON.stringify({ budgets, groups }), failed = analyzeNarrativeSpeechCapacity(groups, budgets)
  assert.deepEqual(failed.conflicts.map(conflict => ({ ids: conflict.source_ids, groups: conflict.group_numbers, deficit: conflict.deficit_characters })), [
    { ids: [1], groups: [1], deficit: 24 }, { ids: [2], groups: [2], deficit: 24 },
  ])
  const spoken = buildScriptUnitSpeechBudgets(splitScriptUnits(`阿甲：${'话'.repeat(80)}。`), assets)
  const possible = analyzeNarrativeSpeechCapacity([{ ...groups[0], duration: 12, source_ids: [1] }, { ...groups[1], duration: 12, source_ids: [1] }], spoken)
  assert.deepEqual(possible, { feasible: true, total_demand_characters: 80, assigned_characters: 80, conflicts: [] })
  assert.equal(JSON.stringify({ budgets, groups }), before)
})

test('beat, total-duration and original-speech capacity conflicts remain explicit hard constraints', () => {
  const script = screenplay(), units = splitScriptUnits(script)
  for (const beat of ['transition', 'climax']) {
    const plan: any = narrative(); plan.groups[0].beat = beat; plan.groups[0].duration = 11
    assert.ok(hard(validateNarrativePlan(plan, units, assets, script)).some(value => value.code === 'constraint_conflict'))
  }
  const long = `阿甲：${'话'.repeat(80)}。\n动作：${'静'.repeat(40)}。`, longUnits = splitScriptUnits(long)
  const shortPlan = { groups: [{ ...narrative().groups[0], duration: 15, source_ids: [1, 2] }] }
  assert.ok(hard(validateNarrativePlan(shortPlan, longUnits, assets, long)).some(value => value.code === 'constraint_conflict' && value.message.includes('4.5')))
  const tiny = '阿甲：你好。'
  assert.ok(hard(validateNarrativePlan({ groups: [{ ...narrative().groups[0], source_ids: [1], duration: 10 }] }, splitScriptUnits(tiny), assets, tiny)).some(value => value.code === 'constraint_conflict' && value.message.includes('500')))
})

test('new narrative plans omit shot counts and historical hints cannot constrain the later complete description', () => {
  const schema = buildNarrativePlanSchema(assets, splitScriptUnits(screenplay()))
  const wire = z.toJSONSchema(schema, { io: 'input', target: 'draft-7' }) as any
  const group = wire.properties.groups.items
  assert.equal(Object.hasOwn(group.properties, 'shot_count'), false)
  assert.equal(group.required.includes('shot_count'), false)
  for (const shot_count of [2, 4, 99]) {
    const historical = { groups: [{ ...narrative().groups[0], shot_count }] }
    const parsed = schema.parse(historical)
    assert.equal(Object.hasOwn(parsed.groups[0], 'shot_count'), false)
    assert.deepEqual(parsed, narrative())
  }
  for (const [duration, shot_count] of [[8, 4], [10, 4], [12, 2], [13, 3]] as const) {
    const script = '景'.repeat(Math.round(duration / 0.12)), units = splitScriptUnits(script)
    const plan = { groups: [{ number: 1, title: '原有叙事节拍', beat: duration === 8 ? 'transition' : 'narrative', source_ids: [1], scene_id: 10, duration, shot_count }] }
    const before = structuredClone(plan), errors = hard(validateNarrativePlan(plan, units, assets, script))
    assert.deepEqual(errors, [], `${duration}s historical hint ${shot_count} must not lock later creative choices`)
    assert.deepEqual(plan, before, 'planning does not mutate creative facts or assign a layout')
    assert.equal(Object.hasOwn(plan.groups[0], 'time_row_counts'), false)
  }
})

test('complete natural-language output requires every skill field instead of accepting an old reduced record', () => {
  const schema = buildCompleteStoryboardSchema(assets)
  assert.equal(schema.safeParse(complete()).success, true)
  assert.equal(schema.safeParse({ shot_number: 1, title: '少字段', description: '只写描述', video_prompt: '只写提示词', duration: 9, scene_id: 10, character_ids: [1], prop_ids: [] }).success, false)
  for (const field of ['result', 'image_prompt', 'sound_effect', 'time', 'location', 'time_row_counts']) {
    const input: any = complete(); delete input[field]; assert.equal(schema.safeParse(input).success, false, field)
  }
})

test('time-row counts are model-selected metadata whose sum matches duration without a fixed layout', () => {
  const schema = buildCompleteStoryboardSchema(assets)
  for (const time_row_counts of [[2, 2], [1, 2, 1], [2, 1, 1], [1, 1, 1, 1]]) assert.equal(schema.safeParse(complete({ time_row_counts })).success, true)
  for (const time_row_counts of [[1, 2], [3, 1], [1, 1, 1, 1, 1]]) assert.equal(schema.safeParse(complete({ time_row_counts })).success, false)
})

test('typed references compile directly to formal names and union bindings without altering shot prose or timing', () => {
  const input = complete({ character_ids: [2], prop_ids: [], source_ids: [1, 2, 3] }), before = structuredClone(input)
  const result = compileStoryboardReferences(input, assets)
  assert.deepEqual(result.issues, [])
  assert.ok(result.candidate)
  assert.deepEqual(result.candidate.character_ids, [2, 1])
  assert.deepEqual(result.candidate.prop_ids, [20])
  assert.equal(result.candidate.scene_id, 10)
  assert.equal(result.candidate.description, input.description.replaceAll('[[character:1]]', '@阿甲').replaceAll('[[character:2]]', '@阿乙').replaceAll('[[prop:20]]', '@木杯'))
  for (const field of ['duration', 'shot_number', 'source_ids', 'time_row_counts'] as const) assert.deepEqual(result.candidate[field], input[field])
  assert.deepEqual(input, before)
})

test('quoted original dialogue is untouched even when it contains unknown tokens, @signs or natural names', () => {
  for (const [open, close] of [['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’'], ['"', '"'], ["'", "'"]]) {
    const original = `${open}原词[[character:999]] @自然称呼 [[scene:999]]${close}`
    const input = complete({ description: `【镜头1】[[character:1]]听见${original}后抬眼。【镜头2】[[character:2]]回应。` })
    const result = compileStoryboardReferences(input, assets)
    assert.deepEqual(result.issues, [], open)
    assert.ok(result.candidate!.description.includes(original), open)
    assert.deepEqual(result.candidate!.character_ids, [1, 2])
  }
  const apostrophe = compileStoryboardReferences(complete({ result: "[[character:1]] doesn't change the original words." }), assets)
  assert.deepEqual(apostrophe.issues, [])
  assert.equal(apostrophe.candidate!.result, "@阿甲 doesn't change the original words.")
})

test('unknown IDs, malformed tokens and direct free @references give precise errors instead of being inferred', () => {
  const unknown = compileStoryboardReferences(complete({ result: '[[character:99]]抬眼。' }), assets)
  assert.equal(unknown.candidate, null)
  assert.ok(unknown.issues.some(value => value.field === 'result' && value.code === 'reference_unknown_id' && value.message.includes('character:99')))
  for (const result of ['@阿甲坐在桌边。', '[[character:0]]', '[[character:abc]]', '[[character:1]', '[[char:1]]']) {
    const compiled = compileStoryboardReferences(complete({ result }), assets)
    assert.equal(compiled.candidate, null, result)
    assert.ok(compiled.issues.some(value => value.field === 'result' && value.severity === 'error'), result)
  }
  const selected = compileStoryboardReferences(complete({ character_ids: [99] }), assets)
  assert.ok(selected.issues.some(value => value.field === 'character_ids.0' && value.code === 'reference_unknown_id' && value.message.includes('99')))
})

test('an invalid reference still yields a full compiled preview without making the draft submittable', () => {
  const literal = '「原词[[character:999]] @原称呼」'
  const input = complete({ result: `[[character:1]]听见${literal}后转向[[character:99]]，把[[prop:20]]放回桌面。` })
  const before = structuredClone(input), result = compileStoryboardReferences(input, assets)
  assert.equal(result.candidate, null, 'an available preview is never approval to submit')
  assert.ok(result.issues.some(value => value.code === 'reference_unknown_id' && value.severity === 'error'))
  assert.ok(result.preview)
  assert.equal(result.preview.result, `@阿甲听见${literal}后转向[[character:99]]，把@木杯放回桌面。`)
  assert.equal(result.preview.description, compileStoryboardReferences(complete(), assets).candidate!.description)
  assert.deepEqual(result.preview.time_row_counts, input.time_row_counts)
  assert.deepEqual(input, before)
  const broken = compileStoryboardReferences({ shot_number: 1 }, assets)
  assert.equal(broken.candidate, null)
  assert.equal(broken.preview, null, 'structurally invalid data requires the caller explicit raw-field draft fallback')
  const valid = compileStoryboardReferences(complete(), assets)
  assert.ok(valid.candidate && valid.preview)
  assert.notEqual(valid.candidate, valid.preview, 'presentation code cannot mutate the submittable object through its preview')
})

test('scene tokens may neither introduce multiple scenes nor change a planned scene, including null', () => {
  for (const input of [complete({ result: '[[scene:10]]与[[scene:11]]都出现。' }), complete({ result: '[[scene:11]]', scene_id: 10 }), complete({ scene_id: null })]) {
    const before = structuredClone(input), result = compileStoryboardReferences(input, assets)
    assert.equal(result.candidate, null)
    assert.ok(result.issues.some(value => value.code === 'reference_scene_conflict'))
    assert.deepEqual(input, before)
  }
})

test('large prose is preserved and an oversized video prompt is rejected without truncation', () => {
  const description = '完整动作与结果。'.repeat(900)
  const result = compileStoryboardReferences(complete({ description }), assets)
  assert.equal(result.candidate!.description, description)
  const input = complete({ video_prompt: '画'.repeat(3601) }), before = structuredClone(input)
  assert.equal(compileStoryboardReferences(input, assets).candidate, null)
  assert.deepEqual(input, before)
  const longNameAssets = { ...assets, characters: [{ id: 1, name: '甲'.repeat(120) }, assets.characters[1]] }
  const compactTokens = complete({ video_prompt: '[[character:1]]'.repeat(40) })
  assert.ok(compactTokens.video_prompt.length < 3600)
  const expanded = compileStoryboardReferences(compactTokens, longNameAssets)
  assert.equal(expanded.candidate, null)
  assert.ok(expanded.issues.some(value => value.field === 'video_prompt' && value.code === 'storyboard_prompt_length'))
})
