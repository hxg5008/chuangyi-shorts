import test from 'node:test'
import assert from 'node:assert/strict'
import { packStoryboardRequests, buildPackedExpandContext, compactPreviousEnding,
  type PackingCheckpoint, type StoryboardPackingAssets } from '../src/services/storyboard-request-packing.ts'
import type { NarrativeGroup, ScriptUnit, ScriptUnitSpeechBudget } from '../src/services/skill-storyboard-contract.ts'

const group = (number: number, scene_id: number | null = 10, duration = 12): NarrativeGroup => ({ number,
  title: `完整节拍${number}`, beat: 'narrative', source_ids: [number], scene_id, duration })
const unit = (id: number, text = '阿甲将木杯放回原桌面。'): ScriptUnit => ({ id, text })
const budget = (source_id: number, spoken_characters = 10): ScriptUnitSpeechBudget => ({ source_id, spoken_characters,
  minimum_speech_seconds: spoken_characters / 4.5, utterances: [{ speaker: '阿甲', kind: 'dialogue', text: '完整原话绝不按固定字数切片。', characters: spoken_characters }] })
function packing(groups: NarrativeGroup[], checkpoints?: PackingCheckpoint[], modelLimits?: Parameters<typeof packStoryboardRequests>[0]['modelLimits']) {
  return { groups, checkpoints, modelLimits: modelLimits ?? { maxOutputTokens: 32_768 }, sourceUnits: groups.map(value => unit(value.number)), speechBudgets: groups.map(value => budget(value.number)) }
}
const numbers = (packs: ReturnType<typeof packStoryboardRequests>) => packs.map(pack => pack.groups.map(value => value.number))
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value) }
  return value
}

test('only adjacent fresh groups share a request, at most two, without changing creative fields', () => {
  const input = packing([group(1), group(2), group(3), group(4), group(5)])
  const before = structuredClone(input), result = packStoryboardRequests(frozen(input))
  assert.deepEqual(numbers(result), [[1, 2], [3, 4], [5]])
  assert.deepEqual(input, before)
  assert.ok(result.every(pack => pack.groups.length <= 2))
  assert.equal(result[0].estimatedOutputTokens, 25_024)
  assert.deepEqual(result[0].reasons, ['adjacent_same_scene'])
  assert.equal(Object.hasOwn(result[0].groups[0], 'shot_count'), false)
  assert.equal(Object.hasOwn(result[0].groups[0], 'time_row_counts'), false)
  result[0].groups[0].source_ids.push(99)
  assert.deepEqual(input.groups[0].source_ids, [1], 'returned arrays must not mutate the original plan')
})

test('ready groups split the sequence and failed, attempted or prior-candidate groups stay individual', () => {
  const cases: Array<{ checkpoint: PackingCheckpoint; expected: number[][] }> = [
    { checkpoint: { number: 2, status: 'ready' }, expected: [[1], [3, 4]] },
    { checkpoint: { number: 2, status: 'needs_revision', attempts: 1 }, expected: [[1], [2], [3, 4]] },
    { checkpoint: { number: 2, status: 'error' }, expected: [[1], [2], [3, 4]] },
    { checkpoint: { number: 2, status: 'generating' }, expected: [[1], [2], [3, 4]] },
    { checkpoint: { number: 2, status: 'pending', attempts: 1 }, expected: [[1], [2], [3, 4]] },
    { checkpoint: { number: 2, status: 'pending', candidate: { raw: { conflict: '历史失败' } } }, expected: [[1], [2], [3, 4]] },
    { checkpoint: { number: 2, status: 'pending', issues: [{ severity: 'error', code: 'old_error' }] }, expected: [[1], [2], [3, 4]] },
  ]
  for (const value of cases) assert.deepEqual(numbers(packStoryboardRequests(packing([1, 2, 3, 4].map(number => group(number)), [value.checkpoint]))), value.expected)
  assert.deepEqual(numbers(packStoryboardRequests(packing([group(1), group(3)]))), [[1], [3]], 'missing group numbers are boundaries too')
})

test('pairing never crosses scene changes or an unspecified scene', () => {
  assert.deepEqual(numbers(packStoryboardRequests(packing([group(1), group(2), group(3, 11), group(4, 11), group(5, null), group(6, null)]))), [[1, 2], [3, 4], [5], [6]])
  assert.deepEqual(numbers(packStoryboardRequests(packing([group(1), group(2, 11), group(3)]))), [[1], [2], [3]])
})

test('long duration, complete speech demand and unusually long source text conservatively prevent pairing without cutting content', () => {
  const longDuration = packing([group(1, 10, 15), group(2)])
  assert.deepEqual(numbers(packStoryboardRequests(longDuration)), [[1], [2]])
  const longSpeech = packing([group(1), group(2)])
  longSpeech.speechBudgets[0] = budget(1, 46)
  assert.ok(packStoryboardRequests(longSpeech)[0].reasons.includes('speech_over_45_characters'))
  assert.deepEqual(numbers(packStoryboardRequests(longSpeech)), [[1], [2]])
  const longSource = packing([group(1), group(2)])
  longSource.sourceUnits[0] = unit(1, '𠮎'.repeat(801))
  assert.ok(packStoryboardRequests(longSource)[0].reasons.includes('source_over_800_characters'))
  assert.equal([...longSource.sourceUnits[0].text].length, 801)
  const edge = packing([group(1), group(2)])
  edge.sourceUnits[0] = unit(1, '景'.repeat(800)); edge.speechBudgets[0] = budget(1, 45)
  assert.deepEqual(numbers(packStoryboardRequests(edge)), [[1, 2]], 'the documented thresholds are strict greater-than tests')
})

test('model output estimates limit batch size rather than rejecting a single group or imposing a shot layout', () => {
  const input = packing([group(1), group(2)], undefined, { maxOutputTokens: 14_000, estimatedOutputTokensPerGroup: 7_000, reservedOutputTokens: 1_000 })
  assert.deepEqual(numbers(packStoryboardRequests(input)), [[1], [2]])
  assert.ok(packStoryboardRequests(input)[0].reasons.includes('output_budget_single'))
  input.modelLimits!.maxOutputTokens = 15_000
  assert.deepEqual(numbers(packStoryboardRequests(input)), [[1, 2]])
  input.modelLimits!.maxOutputTokens = 1_000
  assert.deepEqual(numbers(packStoryboardRequests(input)), [[1], [2]], 'estimates must not turn into an invented content rejection')
  const invalid = packStoryboardRequests(packing([group(1), group(2)], undefined, { maxOutputTokens: NaN, estimatedOutputTokensPerGroup: Infinity, reservedOutputTokens: NaN }))
  assert.equal(invalid[0].estimatedOutputTokens, 13_024)
  const unknown = packing([group(1), group(2)]); unknown.speechBudgets = []
  assert.deepEqual(numbers(packStoryboardRequests(unknown)), [[1], [2]])
})

test('the default thinking-aware estimate keeps 16k requests single and only pairs within a larger supplied budget', () => {
  const { modelLimits: _limits, ...input } = packing([group(1), group(2)])
  const defaultPacks = packStoryboardRequests(input)
  assert.deepEqual(numbers(defaultPacks), [[1], [2]])
  assert.equal(defaultPacks[0].estimatedOutputTokens, 13_024)
  assert.ok(defaultPacks[0].reasons.includes('output_budget_single'))
  assert.deepEqual(numbers(packStoryboardRequests({ ...input, modelLimits: { maxOutputTokens: 16_384 } })), [[1], [2]])
  assert.deepEqual(numbers(packStoryboardRequests({ ...input, modelLimits: { maxOutputTokens: 25_023 } })), [[1], [2]])
  const largePacks = packStoryboardRequests({ ...input, modelLimits: { maxOutputTokens: 32_768 } })
  assert.deepEqual(numbers(largePacks), [[1, 2]])
  assert.equal(largePacks[0].estimatedOutputTokens, 25_024)
  assert.deepEqual(numbers(packStoryboardRequests({ ...input, modelLimits: { maxOutputTokens: 25_024 } })), [[1, 2]])
})

const assets: StoryboardPackingAssets = {
  characters: [
    { id: 1, name: '阿甲', has_voice: true, voice_reference: '#阿甲', styling: '阿甲原有衣着必须保留', image_url: 'IMAGE_LINK_1', details: { imageUrl: 'NESTED_IMAGE_LINK', hair: '原发型' } },
    { id: 2, name: '阿乙', has_voice: true, voice_reference: '#阿乙', styling: '阿乙原有妆造必须保留' },
    { id: 3, name: '阿丙', has_voice: false, voice_reference: null, styling: 'UNUSED_CHARACTER_HEAVY_FACT' },
  ],
  scenes: [
    { id: 10, location: '院落', time: '日', lighting: '朝东原有日光', reference_image_prompt: '门在北墙、木桌在东侧；参考图为四宫格并带标签。', image_url: 'SCENE_IMAGE_LINK' },
    { id: 11, location: '屋内', time: '夜', reference_image_prompt: 'UNUSED_SCENE_HEAVY_FACT', lighting: 'OLD_OTHER_SCENE_LIGHT' },
  ],
  props: [
    { id: 20, name: '木杯', description: '原有杯口纹样', reference_images: ['PROP_IMAGE_LINK'] },
    { id: 21, name: '全家福', description: '照片原有亲属位置必须保留' },
    { id: 22, name: '钥匙', description: 'UNUSED_PROP_HEAVY_FACT' },
  ],
}
const previous = {
  result: '阿乙把全家福放回原处后抬眼，末态原词完整保留。',
  description: '【镜头1】旧首镜完整事实。【镜头2】阿乙将全家福放回原处，停下后抬眼等待。',
  video_prompt: '出场人物：@阿乙；场景：@院落。\n0-3秒：首镜动作前半。\n3-6秒：首镜动作后半。\n6-9秒：切到@阿乙将@全家福放回原处。\n9-12秒：@阿乙停下，抬眼等待，保留完整末态。',
  time_row_counts: [2, 2], character_ids: [2], prop_ids: [21], scene_id: 10,
}
function expandInput() {
  return { plan: { groups: [group(1), group(2), group(3, 11)] }, groups: [group(1), group(2)],
    sourceUnits: [unit(1, '  阿甲将木杯放下，阿甲说：「完整原词含[[character:99]]及@称呼。」  '), unit(2, '阿甲再次查看木杯原有纹样。'), unit(3, '其他组原文不带入本组。')],
    speechBudgets: [budget(1), budget(2), budget(3)], assets, previous, episode: { id: 7 }, projectStyle: '保留原有光影材质' }
}

test('expand sends each current original unit once with a lightweight whole plan and text-free numeric speech budgets', () => {
  const input = expandInput(), before = structuredClone(input)
  ;(input.plan.groups[0] as any).shot_count = 2
  ;(input.plan.groups[0] as any).discarded_heavy_field = 'PLAN_HEAVY_MARKER'
  const output = buildPackedExpandContext(frozen(input))
  assert.deepEqual(output.source_units, input.sourceUnits.slice(0, 2))
  assert.deepEqual(output.approved_plan.groups[0], group(1))
  assert.equal(output.approved_plan.groups.length, 3)
  assert.equal(Object.hasOwn(output, 'script'), false)
  assert.equal(JSON.stringify(output).includes('PLAN_HEAVY_MARKER'), false)
  assert.equal(JSON.stringify(output).includes('其他组原文不带入本组'), false)
  assert.ok(output.source_speech_budgets.every(value => value.utterances.every(utterance => !Object.hasOwn(utterance, 'text'))))
  assert.deepEqual(output.source_speech_budgets[0].utterances[0], { utterance_index: 1, speaker: '阿甲', kind: 'dialogue', characters: 10 })
  assert.equal(output.source_units[0].text, input.sourceUnits[0].text, 'spacing, quotes, @ and source token text must remain byte-for-byte')
  output.source_units[0].text = 'caller changes clone'
  assert.equal(input.sourceUnits[0].text, before.sourceUnits[0].text)
})

test('compact catalogs retain every legal ID, formal name and voice token while rich facts stay current or boundary-related', () => {
  const input = expandInput(), output = buildPackedExpandContext(frozen(input))
  assert.deepEqual(output.asset_catalog.characters, [
    { id: 1, name: '阿甲', has_voice: true, voice_reference: '#阿甲' },
    { id: 2, name: '阿乙', has_voice: true, voice_reference: '#阿乙' },
    { id: 3, name: '阿丙', has_voice: false, voice_reference: null },
  ])
  assert.deepEqual(output.asset_catalog.scenes.map(value => value.id), [10, 11])
  assert.deepEqual(output.asset_catalog.props.map(value => value.id), [20, 21, 22])
  assert.deepEqual(output.asset_facts.characters.map(value => value.id), [1, 2])
  assert.deepEqual(output.asset_facts.props.map(value => value.id), [20, 21])
  assert.deepEqual(output.asset_facts.scenes.map(value => value.id), [10])
  assert.equal(output.asset_facts.scenes[0].reference_image_prompt, assets.scenes[0].reference_image_prompt)
  assert.equal(output.asset_facts.characters[0].styling, assets.characters[0].styling)
  assert.equal(output.asset_facts.characters[1].voice_reference, '#阿乙')
  assert.equal(output.fact_scope.characters, 'literal_and_previous')
  const serialized = JSON.stringify(output)
  for (const omitted of ['IMAGE_LINK', 'PROP_IMAGE_LINK', 'UNUSED_CHARACTER_HEAVY_FACT', 'UNUSED_PROP_HEAVY_FACT', 'UNUSED_SCENE_HEAVY_FACT', 'OLD_OTHER_SCENE_LIGHT']) assert.equal(serialized.includes(omitted), false, omitted)
  assert.deepEqual(output.asset_facts.characters[0].details, { hair: '原发型' })
})

test('uncertain pronouns or implicit source roles conservatively retain all actor and prop facts rather than guessing bindings', () => {
  const input = expandInput(); input.sourceUnits[0].text = '他看向母亲，把它放回原位。'
  const output = buildPackedExpandContext(input)
  assert.equal(output.fact_scope.characters, 'all_fallback'); assert.equal(output.fact_scope.props, 'all_fallback')
  assert.deepEqual(output.asset_facts.characters.map(value => value.id), [1, 2, 3])
  assert.deepEqual(output.asset_facts.props.map(value => value.id), [20, 21, 22])
  assert.ok(output.asset_facts.characters.some(value => value.styling === 'UNUSED_CHARACTER_HEAVY_FACT'))
  assert.equal(Object.hasOwn(output, 'character_ids'), false, 'context selection is never asset binding')
  assert.equal(Object.hasOwn(output.current_groups[0], 'character_ids'), false)
  input.sourceUnits[0].text = '阿甲看向母亲，木杯仍在原处。'
  assert.equal(buildPackedExpandContext(input).fact_scope.characters, 'all_fallback')
})

test('a source unit with no explicit prop or actor and duplicate formal names trigger full-fact fallback', () => {
  const input = expandInput(); input.sourceUnits[1].text = '动作停顿后，环境声保持。'
  const output = buildPackedExpandContext(input)
  assert.equal(output.fact_scope.characters, 'all_fallback'); assert.equal(output.fact_scope.props, 'all_fallback')
  const duplicate = buildPackedExpandContext({ ...expandInput(), assets: { ...assets, characters: [...assets.characters, { id: 4, name: '阿甲', styling: '同名角色事实' }] } })
  assert.deepEqual(duplicate.asset_catalog.characters.map(value => value.id), [1, 2, 3, 4])
  assert.equal(duplicate.fact_scope.characters, 'all_fallback')
  assert.ok(duplicate.asset_facts.characters.some(value => value.id === 4))
})

test('shared source IDs appear once in paired groups and missing or duplicated source records cannot be silently omitted', () => {
  const input = expandInput(); input.groups[1].source_ids = [1, 2]
  assert.deepEqual(buildPackedExpandContext(input).source_units.map(value => value.id), [1, 2])
  assert.throws(() => buildPackedExpandContext({ ...input, sourceUnits: [unit(1)] }), /缺少原文来源ID 2/)
  assert.throws(() => buildPackedExpandContext({ ...input, sourceUnits: [...input.sourceUnits, unit(1)] }), /来源ID 1重复/)
})

test('previous ending retains the complete last description shot and all video spatial and voice facts without truncation', () => {
  const input = structuredClone(previous), before = structuredClone(input)
  input.description += '完整末态'.repeat(500)
  const output = compactPreviousEnding(frozen(input))!
  assert.equal(output.result, previous.result)
  assert.equal(output.description_last_shot, input.description.slice(input.description.indexOf('【镜头2】')))
  assert.equal(output.video_context, previous.video_prompt)
  assert.equal(Object.hasOwn(output, 'video_last_shot'), false, 'do not duplicate a truncated video tail or lose earlier facts')
  assert.equal(output.description_boundary, 'last_marked_shot'); assert.equal(output.video_boundary, 'full_for_spatial_voice_continuity')
  assert.deepEqual(output.character_ids, [2]); assert.deepEqual(output.prop_ids, [21]); assert.equal(output.scene_id, 10)
  assert.ok(output.description_last_shot.length > 2000)
  assert.equal(input.video_prompt, before.video_prompt)
  const identified = compactPreviousEnding({ ...previous, id: 71, shot_number: 4 })!
  assert.equal(identified.id, 71); assert.equal(identified.shot_number, 4)
  assert.equal(Object.hasOwn(output, 'id'), false)
  assert.equal(Object.hasOwn(output, 'shot_number'), false, 'absent identity metadata must not be invented')
})

test('previous video always retains early axes and voice even when the final shot is silent or mapping is unavailable', () => {
  assert.equal(compactPreviousEnding(null), null)
  const video = previous.video_prompt.replace('首镜动作前半。', '@院落以门槛为A0，X向东，Y向北；@阿乙说：「原词」中年低音区、温润音色。')
  for (const mapping of [undefined, [1, 1], [2, 2, 1]]) {
    const output = compactPreviousEnding({ ...previous, video_prompt: video, time_row_counts: mapping })!
    assert.equal(output.video_context, video)
    assert.equal(output.video_boundary, 'full_for_spatial_voice_continuity')
    assert.ok(output.video_context.includes('A0，X向东，Y向北'))
    assert.ok(output.video_context.includes('中年低音区、温润音色'))
  }
  const unmarked = compactPreviousEnding({ ...previous, description: '自然正文没有明确子镜边界，不得截断。' })!
  assert.equal(unmarked.description_last_shot, '自然正文没有明确子镜边界，不得截断。')
  assert.equal(unmarked.description_boundary, 'full_fallback')
  assert.equal(unmarked.video_context, previous.video_prompt)
  const inconsistent = compactPreviousEnding({ ...previous, description: '【镜头1】开头。【镜头3】未知缺口，保守保留。' })!
  assert.equal(inconsistent.description_last_shot, '【镜头1】开头。【镜头3】未知缺口，保守保留。')
  assert.equal(inconsistent.description_boundary, 'full_fallback')
})
