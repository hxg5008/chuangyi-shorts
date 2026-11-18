import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import { buildDialogueGroupSchedule, buildDialogueTimingGuide } from '../src/services/first-pass-instructions.ts'
import { buildScheduledSegmentResponseSchema, buildScheduledSegmentSchema, collectScheduledReferenceBindings, compileScheduledSegment, getScheduledShotLayout, normalizeScheduledVisual } from '../src/services/scheduled-storyboard-segment.ts'
import { resolveSourceDialoguePlan } from '../src/services/source-dialogue-plan.ts'
import { renderVideoPromptPlan } from '../src/services/video-prompt-plan.ts'
import { validateStoryboard } from '../src/services/storyboard-validation.ts'

const assets = { characters: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }], scenes: [{ id: 10, location: 'Yard' }], props: [{ id: 20, name: 'Letter' }] }
const voice = { age: 'adult', register: 'low', timbre: 'warm', delivery: 'steady breath and clear intent' }
function scheduled(count = 20, kind: 'dialogue' | 'offscreen' | 'narration' = 'dialogue') {
  const guide = buildDialogueTimingGuide([{ speakerName: kind === 'narration' ? undefined : 'B', kind, text: '好'.repeat(count) + '。' }], assets.characters)
  return { guide, group: buildDialogueGroupSchedule(guide)[0] }
}
function fixture(group = scheduled().group): any {
  const data: any = { title: 'Local segment', scene_id: 10, prop_ids: [20], atmosphere: 'Existing daylight.', space: 'A0 is the threshold, X east, Y north.' }
  let offset = 0
  getScheduledShotLayout(group.rows.length).forEach((count, index) => {
    const source = group.rows.slice(offset, offset + count).some(Boolean)
    data[`shot_${index + 1}`] = { characters: [{ character_id: 1, visibility: 'face_hidden', emotion: null }],
      visuals: Array.from({ length: count }, () => '@A waits by the door.'), ...(source ? { voice: { ...voice } } : {}) }
    offset += count
  })
  return data
}

type JsonSchema = Record<string, any>
function walkJsonSchema(value: unknown, visit: (schema: JsonSchema, path: string) => void, path = '$'): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  visit(value as JsonSchema, path)
  for (const [key, child] of Object.entries(value)) {
    if (Array.isArray(child)) child.forEach((item, index) => walkJsonSchema(item, visit, `${path}.${key}[${index}]`))
    else walkJsonSchema(child, visit, `${path}.${key}`)
  }
}
function allowsNull(schema: JsonSchema): boolean {
  return schema.type === 'null' || Array.isArray(schema.type) && schema.type.includes('null')
    || Object.hasOwn(schema, 'const') && schema.const === null || Array.isArray(schema.enum) && schema.enum.includes(null)
    || ['anyOf', 'oneOf'].some(key => Array.isArray(schema[key]) && schema[key].some((branch: JsonSchema) => allowsNull(branch)))
}
function objectSchema(schema: JsonSchema): JsonSchema {
  if (schema.type === 'object' || schema.properties) return schema
  for (const key of ['anyOf', 'oneOf', 'allOf']) for (const branch of schema[key] || []) {
    if (branch.type === 'object' || branch.properties) return branch
  }
  throw new Error('Expected an object branch in local JSON schema fixture')
}

test('response schema recursively closes objects and requires exactly every declared property', () => {
  const schema = buildScheduledSegmentResponseSchema(scheduled().group, assets)
  let objects = 0
  walkJsonSchema(schema, (node, path) => {
    assert.equal(Object.hasOwn(node, '$schema'), false, `${path}: draft marker removed`)
    if (node.type !== 'object' && !node.properties) return
    objects++
    assert.equal(node.additionalProperties, false, path)
    assert.deepEqual([...(node.required || [])].sort(), Object.keys(node.properties || {}).sort(), path)
  })
  assert.ok(objects >= 7, 'root, voices, shots, character and emotion objects are all traversed')
  assert.equal(schema.type, 'object')
  assert.equal(allowsNull(schema), false)
})

test('response source voice is non-null while shot overrides remain nullable and visible emotion facts stay non-null', () => {
  const root = objectSchema(buildScheduledSegmentResponseSchema(scheduled().group, assets))
  const shot = objectSchema(root.properties.shot_1)
  const character = objectSchema(shot.properties.characters.items)
  for (const [voiceSchema, nullable] of [[root.properties.voice, false], [shot.properties.voice, true]] as const) {
    assert.equal(allowsNull(voiceSchema), nullable)
    const voiceObject = objectSchema(voiceSchema)
    for (const field of ['age', 'register', 'timbre', 'delivery']) {
      assert.equal(allowsNull(voiceObject.properties[field]), false, field)
      assert.equal(voiceObject.properties[field].minLength, 1, field)
    }
  }
  assert.equal(allowsNull(character.properties.emotion), false)
  const emotion = objectSchema(character.properties.emotion)
  assert.equal(allowsNull(emotion.properties.expression), false)
  assert.equal(allowsNull(emotion.properties.intensity), false)
  assert.equal(allowsNull(root.properties.scene_id), true, 'original nullable values stay nullable')
  for (const field of ['title', 'atmosphere', 'space', 'prop_ids', 'shot_1', 'shot_2']) assert.equal(allowsNull(root.properties[field]), false, field)
})

test('every canonical speech source requires complete non-null top-level wire voice while local per-shot-only input stays compatible', () => {
  for (const kind of ['dialogue', 'offscreen', 'narration'] as const) {
    const { group, guide } = scheduled(1, kind)
    const root = objectSchema(buildScheduledSegmentResponseSchema(group, assets, guide))
    const wireVoice = z.fromJSONSchema(root.properties.voice)
    assert.equal(root.properties.voice.type, 'object', kind)
    assert.equal(allowsNull(root.properties.voice), false, kind)
    assert.deepEqual([...root.properties.voice.required].sort(), ['age', 'delivery', 'register', 'timbre'])
    assert.equal(wireVoice.safeParse(null).success, false, kind)
    assert.equal(wireVoice.safeParse(voice).success, true, kind)
    for (const missing of ['age', 'register', 'timbre', 'delivery']) {
      const incomplete: any = { ...voice }; delete incomplete[missing]
      assert.equal(wireVoice.safeParse(incomplete).success, false, `${kind}: ${missing}`)
    }
    assert.equal(allowsNull(root.properties.shot_1.properties.voice), true, 'per-shot overrides may still be null')
    assert.equal(allowsNull(root.properties.shot_2.properties.voice), true, 'silent overrides may still be null')
    const local = fixture(group)
    assert.equal(Object.hasOwn(local, 'voice'), false)
    assert.equal(buildScheduledSegmentSchema(group, assets).safeParse(local).success, true, 'top voice is not required by local Zod')
    local.voice = null
    assert.equal(buildScheduledSegmentSchema(group, assets).safeParse(local).success, true, 'local null top voice retains per-shot compatibility')
    const candidate = compileScheduledSegment(local, group, guide, assets)
    assert.deepEqual(candidate.video_prompt_plan!.shots.flatMap(shot => shot.rows.flatMap(row => row.dialogue || [])).map(entry => entry.voice), [voice])
  }
})

test('an all-silent canonical group permits null top-level wire voice without inventing local speech', () => {
  const { group: original } = scheduled(1)
  const group = { ...original, rows: original.rows.map(() => null) }
  const root = objectSchema(buildScheduledSegmentResponseSchema(group, assets, []))
  const wireVoice = z.fromJSONSchema(root.properties.voice)
  assert.equal(allowsNull(root.properties.voice), true)
  assert.equal(wireVoice.safeParse(null).success, true)
  assert.equal(wireVoice.safeParse(voice).success, true)
  const local = fixture(group)
  local.voice = null
  assert.equal(buildScheduledSegmentSchema(group, assets).safeParse(local).success, true)
  const candidate = compileScheduledSegment(local, group, [], assets)
  assert.ok(candidate.video_prompt_plan!.shots.every(shot => shot.rows.every(row => row.dialogue === undefined)))
})

test('response schema fixes three, four and five rows to recommended per-shot visual lengths', () => {
  for (const [count, expected] of [[20, [1, 2]], [40, [2, 2]], [55, [2, 2, 1]]] as const) {
    const { group } = scheduled(count)
    assert.equal(group.rows.length, expected.reduce((sum, number) => sum + number, 0))
    const root = objectSchema(buildScheduledSegmentResponseSchema(group, assets))
    assert.deepEqual(Object.keys(root.properties).filter(key => /^shot_\d+$/.test(key)), expected.map((_length, index) => `shot_${index + 1}`))
    expected.forEach((length, index) => {
      const visuals = objectSchema(root.properties[`shot_${index + 1}`]).properties.visuals
      assert.equal(visuals.type, 'array')
      assert.equal(visuals.minItems, length)
      assert.equal(visuals.maxItems, length)
      assert.equal(visuals.items.type, 'string')
      assert.equal(visuals.items.minLength, 1)
      assert.equal(visuals.items.maxLength, 3600)
    })
  }
})

test('response schema retains asset enums and numeric and text ranges without duplicate null branches', () => {
  const schema = buildScheduledSegmentResponseSchema(scheduled().group, assets)
  const root = objectSchema(schema), shot = objectSchema(root.properties.shot_1)
  const character = objectSchema(shot.properties.characters.items)
  assert.deepEqual(character.properties.character_id.enum, [1, 2])
  assert.deepEqual(shot.properties.characters.items.anyOf.flatMap((branch: JsonSchema) => branch.properties.visibility.enum), ['face_visible', 'face_hidden', 'offscreen', 'uncertain'])
  const intensity = objectSchema(character.properties.emotion).properties.intensity
  assert.equal(intensity.type, 'number')
  assert.equal(intensity.minimum, 0)
  assert.equal(intensity.maximum, 100)
  assert.equal(root.properties.title.minLength, 1)
  assert.equal(root.properties.title.maxLength, 3600)
  walkJsonSchema(schema, (node, path) => {
    for (const key of ['anyOf', 'oneOf']) if (Array.isArray(node[key])) {
      assert.ok(node[key].filter((branch: JsonSchema) => allowsNull(branch)).length <= 1, `${path}.${key}: one null-accepting branch at most`)
    }
    if (Array.isArray(node.type)) assert.equal(new Set(node.type).size, node.type.length, `${path}.type`)
    if (Array.isArray(node.enum)) assert.equal(node.enum.filter((entry: unknown) => entry === null).length <= 1, true, `${path}.enum`)
  })
})

test('strict response-schema export leaves local optional fields, flexible layouts and source compilation unchanged', () => {
  for (const [count, lengths] of [[20, [2, 1]], [55, [2, 1, 2]]] as const) {
    const { group, guide } = scheduled(count), localSchema = buildScheduledSegmentSchema(group, assets)
    const before = JSON.stringify({ group, assets, schema: z.toJSONSchema(localSchema, { io: 'input', target: 'draft-7', unrepresentable: 'any' }) })
    const response = buildScheduledSegmentResponseSchema(group, assets)
    const input = fixture(group), flat = getScheduledShotLayout(group.rows.length).flatMap((_length, index) => input[`shot_${index + 1}`].visuals)
    input.voice = { ...voice }; let offset = 0
    lengths.forEach((length, index) => {
      input[`shot_${index + 1}`].visuals = flat.slice(offset, offset + length); offset += length
      delete input[`shot_${index + 1}`].voice
      input[`shot_${index + 1}`].characters.forEach((character: any) => { delete character.emotion })
    })
    assert.equal(localSchema.safeParse(input).success, true)
    const candidate = compileScheduledSegment(input, group, guide, assets)
    assert.deepEqual(candidate.video_prompt_plan!.shots.map(shot => shot.rows.length), [...lengths])
    assert.equal(response.additionalProperties, false)
    assert.equal(JSON.stringify({ group, assets, schema: z.toJSONSchema(localSchema, { io: 'input', target: 'draft-7', unrepresentable: 'any' }) }), before)
  }
})

test('only wire shots with a trusted known source speaker require a character declaration, including an offscreen one', () => {
  for (const kind of ['dialogue', 'offscreen'] as const) {
    const { group, guide } = scheduled(1, kind)
    const root = objectSchema(buildScheduledSegmentResponseSchema(group, assets, guide))
    assert.equal(root.properties.shot_1.properties.characters.minItems, 1)
    assert.equal(root.properties.shot_2.properties.characters.minItems, 0, 'silent shot remains free to show an environment')
    const noGuide = objectSchema(buildScheduledSegmentResponseSchema(group, assets))
    assert.equal(noGuide.properties.shot_1.properties.characters.minItems, 0, 'no identity may be invented without the trusted guide')
    const localInput = fixture(group)
    localInput.shot_1.characters = []; localInput.shot_2.characters = []
    assert.equal(buildScheduledSegmentSchema(group, assets).safeParse(localInput).success, true, 'local schema compatibility is unchanged')
  }
  const anonymous = scheduled(1, 'narration')
  const root = objectSchema(buildScheduledSegmentResponseSchema(anonymous.group, assets, anonymous.guide))
  assert.equal(root.properties.shot_1.properties.characters.minItems, 0)
  assert.equal(root.properties.shot_2.properties.characters.minItems, 0)
})

test('wire character branches require a real visible emotion or null for every non-visible state', () => {
  const { group, guide } = scheduled(1)
  const root = objectSchema(buildScheduledSegmentResponseSchema(group, assets, guide))
  for (const key of ['shot_1', 'shot_2']) {
    const branches = root.properties[key].properties.characters.items.anyOf
    assert.equal(branches.length, 2)
    const visible = branches.find((branch: JsonSchema) => branch.properties.visibility.enum.includes('face_visible'))
    const other = branches.find((branch: JsonSchema) => branch.properties.visibility.enum.includes('offscreen'))
    assert.deepEqual(visible.properties.visibility.enum, ['face_visible'])
    assert.equal(visible.properties.emotion.type, 'object')
    assert.equal(allowsNull(visible.properties.emotion), false)
    assert.deepEqual(visible.properties.emotion.required.sort(), ['expression', 'intensity'])
    assert.deepEqual(other.properties.visibility.enum, ['face_hidden', 'offscreen', 'uncertain'])
    assert.deepEqual(other.properties.emotion, { type: 'null' })
    for (const branch of branches) {
      assert.deepEqual(branch.properties.character_id.enum, [1, 2])
      assert.equal(branch.additionalProperties, false)
      assert.deepEqual([...branch.required].sort(), Object.keys(branch.properties).sort())
    }
  }
})

test('shot layout is deterministic and accepts only canonical three, four or five rows', () => {
  assert.deepEqual(getScheduledShotLayout(3), [1, 2])
  assert.deepEqual(getScheduledShotLayout(4), [2, 2])
  assert.deepEqual(getScheduledShotLayout(5), [2, 2, 1])
  for (const count of [0, 1, 2, 6, 3.5, NaN]) assert.throws(() => getScheduledShotLayout(count))
})

test('each schedule exposes an actual ZodObject with fixed shot keys, one or two rows per shot and a fixed total', () => {
  for (const count of [20, 40, 55]) {
    const { group } = scheduled(count)
    const schema = buildScheduledSegmentSchema(group, assets)
    assert.ok(schema.shape.title && schema.shape.shot_1 && schema.shape.shot_2)
    const layout = getScheduledShotLayout(group.rows.length)
    const input = fixture(group)
    assert.equal(schema.safeParse(input).success, true)
    layout.forEach((_length, index) => {
      const missing = structuredClone(input); missing[`shot_${index + 1}`].visuals.pop()
      assert.equal(schema.safeParse(missing).success, false)
      const extra = structuredClone(input); extra[`shot_${index + 1}`].visuals.push('extra visual')
      assert.equal(schema.safeParse(extra).success, false)
    })
  }
})

test('three and five canonical rows allow every safe redistribution without changing the slot sequence', () => {
  for (const [count, layouts] of [[20, [[1, 2], [2, 1]]], [55, [[2, 2, 1], [2, 1, 2], [1, 2, 2]]]] as const) {
    const { group, guide } = scheduled(count)
    for (const layout of layouts) {
      const input = fixture(group), flat = getScheduledShotLayout(group.rows.length).flatMap((_n, index) => input[`shot_${index + 1}`].visuals)
      let offset = 0
      layout.forEach((length, index) => { input[`shot_${index + 1}`].visuals = flat.slice(offset, offset + length); offset += length })
      const result = compileScheduledSegment(input, group, guide, assets)
      assert.deepEqual(result.video_prompt_plan!.shots.map(shot => shot.rows.length), [...layout])
      assert.deepEqual(result.video_prompt_plan!.shots.flatMap(shot => shot.rows.flatMap(row => row.dialogue || []))
        .map((entry: any) => ({ source_line: entry.source_line, fragment_index: entry.fragment_index })), group.rows.filter(Boolean))
    }
  }
})

test('voice requirements follow actual row offsets and wrong total or overlong per-shot rows remain invalid', () => {
  const { group, guide } = scheduled(20)
  const schema = buildScheduledSegmentSchema(group, assets)
  const input = fixture(group); delete input.shot_2.voice
  assert.equal(schema.safeParse(input).success, false, 'In 1+2, the second shot owns the second source slot')
  input.shot_1.visuals.push(input.shot_2.visuals.shift())
  assert.equal(schema.safeParse(input).success, true, 'In 2+1, all source slots now belong to the first shot')
  const result = compileScheduledSegment(input, group, guide, assets)
  assert.equal(result.video_prompt_plan!.shots[1].rows[0].dialogue, undefined)
  input.shot_1.visuals.push('excess row')
  assert.equal(schema.safeParse(input).success, false)
  input.shot_1.visuals = ['one row']; input.shot_2.visuals = ['one row']
  assert.equal(schema.safeParse(input).success, false)
})

test('extra numbered shot fields are rejected before notes are stripped from the parse output', () => {
  const { group } = scheduled(20)
  const schema = buildScheduledSegmentSchema(group, assets)
  for (const key of ['shot_3', 'shot_4', 'shot_99']) {
    const input = fixture(group); input[key] = { characters: [], visuals: ['additional creative shot'] }
    assert.equal(schema.safeParse(input).success, false, key)
  }
  const input = { ...fixture(group), shots_note: 'unconsumed note' }
  const parsed = schema.parse(input)
  assert.equal(Object.hasOwn(parsed, 'shots_note'), false)
  assert.equal(input.shots_note, 'unconsumed note')
})

test('compile preserves canonical group, duration and source slots and derives bindings without copying original speech', () => {
  const { group, guide } = scheduled(20, 'offscreen')
  group.source_group = 7
  const input = fixture(group)
  const original = JSON.stringify({ input, group, guide })
  const result = compileScheduledSegment(input, group, guide, assets)
  assert.equal(result.shot_number, 7)
  assert.equal(result.duration, group.duration)
  assert.equal(result.description, undefined)
  assert.deepEqual(result.character_ids, [1, 2])
  assert.deepEqual(result.prop_ids, [20])
  assert.equal(result.scene_id, 10)
  const rows = result.video_prompt_plan!.shots.flatMap(shot => shot.rows)
  rows.forEach((row, index) => {
    const ref = group.rows[index]
    if (!ref) assert.equal(row.dialogue, undefined)
    else {
      assert.deepEqual(row.dialogue, [{ ...ref, voice }])
      assert.equal(Object.hasOwn(row.dialogue![0], 'text'), false)
      assert.equal(Object.hasOwn(row.dialogue![0], 'speaker_id'), false)
      assert.equal(Object.hasOwn(row.dialogue![0], 'kind'), false)
    }
  })
  const resolved = resolveSourceDialoguePlan(result.video_prompt_plan, guide)
  assert.deepEqual(resolved.issues, [])
  assert.equal(resolved.plan!.shots[0].rows[0].dialogue![0].text, guide[0].fragments[0])
  assert.equal(resolved.plan!.shots[0].rows[0].dialogue![0].kind, 'offscreen')
  assert.equal(JSON.stringify({ input, group, guide }), original)
})

test('top-level unconsumed canonical claims and notes are discarded and cannot change the schedule', () => {
  const { group, guide } = scheduled()
  const input = { ...fixture(group), duration: 1, shot_number: 999, rowCount: 999, source_line: 999, fragment_index: 999, text: 'forged original', note: 'unconsumed comment' }
  const parsed = buildScheduledSegmentSchema(group, assets).parse(input)
  for (const key of ['duration', 'shot_number', 'rowCount', 'source_line', 'fragment_index', 'text', 'note']) assert.equal(Object.hasOwn(parsed, key), false)
  const result = compileScheduledSegment(input, group, guide, assets)
  assert.equal(result.duration, group.duration)
  assert.equal(result.shot_number, group.source_group)
  assert.ok(!JSON.stringify(result).includes('forged original'))
})

test('scene, prop and participant IDs must exist, while nullable scene and empty prop sets are valid', () => {
  const { group, guide } = scheduled()
  const schema = buildScheduledSegmentSchema(group, assets)
  for (const mutate of [
    (input: any) => { input.scene_id = 999 },
    (input: any) => { input.prop_ids = [999] },
    (input: any) => { input.shot_1.characters[0].character_id = 999 },
  ]) { const input = fixture(group); mutate(input); assert.equal(schema.safeParse(input).success, false) }
  const input = fixture(group); input.scene_id = null; input.prop_ids = []
  assert.equal(compileScheduledSegment(input, group, guide, assets).scene_id, null)
})

test('voice with nonempty delivery is mandatory exactly for shots containing canonical source slots', () => {
  const { group } = scheduled(1)
  const schema = buildScheduledSegmentSchema(group, assets)
  const input = fixture(group)
  assert.equal(input.shot_2.voice, undefined)
  assert.equal(schema.safeParse(input).success, true)
  for (const invalid of [undefined, null, { ...voice, delivery: '' }, { ...voice, age: null }]) {
    const value = structuredClone(input); value.shot_1.voice = invalid
    assert.equal(schema.safeParse(value).success, false)
  }
})

test('a complete group-level voice fills missing voiced shots and each complete per-shot profile takes precedence', () => {
  const { group, guide } = scheduled(40)
  const input = fixture(group)
  input.voice = { ...voice, delivery: 'group voice delivery' }
  delete input.shot_1.voice; delete input.shot_2.voice
  const before = JSON.stringify(input)
  const shared = compileScheduledSegment(input, group, guide, assets)
  const entries = shared.video_prompt_plan!.shots.flatMap(shot => shot.rows.flatMap(row => row.dialogue || []))
  assert.equal(entries.length, 4)
  entries.forEach(entry => assert.deepEqual(entry.voice, input.voice))
  assert.equal(JSON.stringify(input), before)
  input.shot_2.voice = { ...voice, delivery: 'shot-specific breath', register: 'higher register' }
  const overridden = compileScheduledSegment(input, group, guide, assets)
  assert.deepEqual(overridden.video_prompt_plan!.shots[0].rows[0].dialogue![0].voice, input.voice)
  assert.deepEqual(overridden.video_prompt_plan!.shots[1].rows[0].dialogue![0].voice, input.shot_2.voice)
})

test('null optional voice profiles are omitted while actual voiced slots still require a complete supplied profile', () => {
  const { group, guide } = scheduled(40)
  const input = fixture(group)
  input.voice = null
  const result = compileScheduledSegment(input, group, guide, assets)
  result.video_prompt_plan!.shots.flatMap(shot => shot.rows.flatMap(row => row.dialogue || []))
    .forEach(entry => assert.deepEqual(entry.voice, voice))
  input.voice = { ...voice }
  input.shot_1.voice = null; input.shot_2.voice = null
  assert.doesNotThrow(() => compileScheduledSegment(input, group, guide, assets))
  input.voice = null
  assert.equal(buildScheduledSegmentSchema(group, assets).safeParse(input).success, false)
})

test('exact echoed time labels are removed before cut rendering while conflicting ranges still fail', () => {
  const { group, guide } = scheduled(20), input = fixture(group)
  input.shot_1.visuals[0] = '0-3秒：50mm近景，@A保持原位。'
  input.shot_2.visuals[0] = '3-6秒：切到35mm中景，@A轻轻放下左手。'
  input.shot_2.visuals[1] = '6-9秒：同一机位继续固定，@A保持原位。'
  const candidate = compileScheduledSegment(input, group, guide, assets)
  assert.deepEqual(candidate.video_prompt_plan!.shots.map(shot => shot.rows.map(row => row.visual)), [
    ['50mm近景，@A保持原位。'], ['切到35mm中景，@A轻轻放下左手。', '同一机位继续固定，@A保持原位。'],
  ])
  input.shot_2.visuals[0] = '0-3秒：切到35mm中景，@A轻轻放下左手。'
  assert.throws(() => compileScheduledSegment(input, group, guide, assets), /time label conflicts/i)
})

test('a group-level profile does not create speech in silent slots or permit an incomplete per-shot override', () => {
  const { group, guide } = scheduled(1)
  const input = fixture(group)
  input.voice = { ...voice }; delete input.shot_1.voice
  const result = compileScheduledSegment(input, group, guide, assets)
  assert.ok(result.video_prompt_plan!.shots[0].rows[0].dialogue?.length)
  result.video_prompt_plan!.shots[1].rows.forEach(row => assert.equal(row.dialogue, undefined))
  input.shot_1.voice = { age: 'adult' }
  assert.equal(buildScheduledSegmentSchema(group, assets).safeParse(input).success, false)
})

test('mixed canonical source identities reject shared fallback, while complete independent shot profiles remain compatible', () => {
  const guide = buildDialogueTimingGuide([
    { speakerName: 'B', kind: 'offscreen', text: '好。' }, { speakerName: 'A', kind: 'dialogue', text: '等等。' },
  ], assets.characters)
  const group = { source_group: 1, source_line: 1, duration: 9, chinese_characters: 3,
    rows: [{ source_line: 1, fragment_index: 1 }, { source_line: 2, fragment_index: 1 }, null] }
  const input = fixture(group)
  assert.doesNotThrow(() => compileScheduledSegment(input, group, guide, assets))
  input.voice = { ...voice }; delete input.shot_2.voice
  assert.throws(() => compileScheduledSegment(input, group, guide, assets), /mixed canonical sources or speakers/)
})

test('invalid canonical references and source speakers fail before any creative input is parsed', () => {
  const { group, guide } = scheduled()
  for (const ref of [{ source_line: 99, fragment_index: 1 }, { source_line: 1, fragment_index: 99 }, { source_line: 0, fragment_index: 1 }]) {
    const invalid = { ...group, rows: [ref, ...group.rows.slice(1)] }
    assert.throws(() => compileScheduledSegment(null, invalid, guide, assets), /source|reference/i)
  }
  const invalidSpeaker = structuredClone(guide); invalidSpeaker[0].character_id = 999
  assert.throws(() => compileScheduledSegment(fixture(group), group, invalidSpeaker, assets), /speaker/i)
})

test('all declared participants including offscreen roles and canonical source speakers enter the binding union', () => {
  const { group, guide } = scheduled(1, 'narration')
  const input = fixture(group)
  input.shot_2.characters = [{ character_id: 2, visibility: 'offscreen' }]
  const result = compileScheduledSegment(input, group, guide, assets)
  assert.deepEqual(result.character_ids, [1, 2])
})

test('exact formal props in space and visual prose are added to bindings without changing their source text', () => {
  const localAssets = { ...assets, props: [{ id: 20, name: '全家福' }, { id: 21, name: '信封' }] }
  const { group, guide } = scheduled()
  const input = fixture(group); input.prop_ids = []
  input.space += '@全家福挂在墙上，玻璃反光保持。'
  input.shot_1.visuals[0] += '@信封放在桌上。'
  const before = JSON.stringify(input)
  const result = compileScheduledSegment(input, group, guide, localAssets)
  assert.deepEqual(result.prop_ids, [20, 21])
  assert.equal(result.video_prompt_plan!.space, input.space)
  assert.equal(result.video_prompt_plan!.shots[0].rows[0].visual, input.shot_1.visuals[0])
  assert.equal(JSON.stringify(input), before)
  for (const text of ['@全家福上的玻璃', '@信封的边角', '@信封位于桌上', '@全家福，保持原位。']) {
    assert.equal(collectScheduledReferenceBindings([text], { characterIds: [], propIds: [], sceneId: null }, localAssets).propIds.length, 1)
  }
})

test('aliases, unknown names and noun extensions cannot accidentally bind a shorter prop name', () => {
  const localAssets = { ...assets, props: [{ id: 20, name: '全家福' }, { id: 21, name: '信封' }] }
  const result = collectScheduledReferenceBindings(['@信封袋放在桌上', '@全家福照片挂在墙上', '@陌生道具。', '@Letter。'], {
    characterIds: [], propIds: [], sceneId: null,
  }, localAssets)
  assert.deepEqual(result.propIds, [])
})

test('same-name multiple IDs or cross-category assets remain ambiguous and are not guessed', () => {
  const current = { characterIds: [], propIds: [], sceneId: null }
  const duplicate = { ...assets, props: [{ id: 20, name: '全家福' }, { id: 21, name: '全家福' }] }
  assert.deepEqual(collectScheduledReferenceBindings(['@全家福挂在墙上。'], current, duplicate).propIds, [])
  const crossCategory = { ...assets, characters: [...assets.characters, { id: 3, name: '全家福' }], props: [{ id: 20, name: '全家福' }] }
  const cross = collectScheduledReferenceBindings(['@全家福挂在墙上。'], current, crossCategory)
  assert.deepEqual(cross.propIds, []); assert.deepEqual(cross.characterIds, [])
})

test('unique formal gaze targets bind before face-location or direction suffixes without accepting name extensions', () => {
  const current = { characterIds: [], propIds: [], sceneId: null }
  const local = { ...assets, characters: [{ id: 1, name: '老年高大山' }, { id: 2, name: 'Adam' }], props: [] }
  for (const text of ['视线从@老年高大山脸上缓缓移开，转向水杯。', '视线从水杯转回@老年高大山方向，保持原位。',
    '视线停在@老年高大山脸上。', '看向@Adam方向。']) {
    assert.equal(collectScheduledReferenceBindings([text], current, local).characterIds.length, 1, text)
  }
  for (const text of ['@Adams方向。', '@Adamson脸上。', '@老年高大山方向盘。', '@老年高大山脸上海报。']) {
    assert.deepEqual(collectScheduledReferenceBindings([text], current, local).characterIds, [], text)
  }
  const longer = { ...local, characters: [...local.characters, { id: 3, name: '老年高大山方向盘' }] }
  assert.deepEqual(collectScheduledReferenceBindings(['@老年高大山方向盘。'], current, longer).characterIds, [3])
  const duplicate = { ...local, characters: [...local.characters, { id: 3, name: '老年高大山' }] }
  assert.deepEqual(collectScheduledReferenceBindings(['@老年高大山脸上。'], current, duplicate).characterIds, [])
  const cross = { ...local, props: [{ id: 30, name: '老年高大山' }] }
  const ambiguous = collectScheduledReferenceBindings(['@老年高大山方向。'], current, cross)
  assert.deepEqual(ambiguous.characterIds, []); assert.deepEqual(ambiguous.propIds, [])
})

test('face-location and returning gaze references add only outer IDs and preserve every visual and participant', () => {
  const { group, guide } = scheduled(1, 'narration'), input = fixture(group)
  const local = { ...assets, characters: [{ id: 1, name: '老年张晓茹' }, { id: 2, name: '老年高大山' }] }
  input.shot_1.visuals = ['@老年张晓茹背影保持，视线从@老年高大山脸上缓缓移开，转向床头水杯方向。']
  input.shot_2.visuals = ['@老年张晓茹背影保持，视线从水杯转回@老年高大山方向，右手握着已有药瓶。',
    '@老年张晓茹背影保持，视线停在@老年高大山脸上，右手握瓶姿态保持。']
  const original = JSON.stringify(input), candidate = compileScheduledSegment(input, group, guide, local)
  assert.deepEqual(candidate.character_ids, [1, 2])
  assert.deepEqual(candidate.video_prompt_plan!.shots.map(shot => shot.characters.map(person => person.character_id)), [[1], [1]])
  const resolved = resolveSourceDialoguePlan(candidate.video_prompt_plan, guide)
  const rendered = renderVideoPromptPlan(resolved.plan!, { ...local, duration: group.duration, characterIds: candidate.character_ids!, sceneId: candidate.scene_id, propIds: candidate.prop_ids!, language: 'zh' })
  assert.deepEqual(rendered.issues.filter(issue => issue.severity === 'error'), [])
  assert.ok(!rendered.prompt.split('\n')[0].includes('@老年高大山'))
  assert.equal(JSON.stringify(input), original)
})

test('complete staging-position words bind only unique formal character names, including Latin names', () => {
  const current = { characterIds: [], propIds: [], sceneId: null }
  const local = { characters: [{ id: 14, name: '秦翠花' }, { id: 15, name: 'Adam' }], scenes: [], props: [] }
  for (const phrase of ['站在方桌旁', '站着，保持原位', '站于方桌旁', '坐在方桌旁', '坐着，保持原位', '坐于方桌旁',
    '仰卧在床上', '半躺在床上', '蹲在床侧', '蹲着，保持原位', '蹲于床侧', '倚在门边', '倚着门框', '倚于门边',
    '靠在门边', '靠着床头', '躺在床上', '躺着，保持原位', '平躺在床上', '侧卧在床上',
    '立于门口', '立在门口', '站立于门口', '站立在门口', '位于门边', '跟在另一人身后', '随在另一人身后']) {
    for (const character of local.characters) {
      const result = collectScheduledReferenceBindings([`@${character.name}${phrase}。`], current, local)
      assert.deepEqual(result.characterIds, [character.id], `${character.name}: ${phrase}`)
      assert.deepEqual(result.propIds, [])
      assert.equal(result.sceneId, null)
    }
  }
})

test('staging words cannot bind shorter name substrings, noun extensions or ambiguous formal names', () => {
  const current = { characterIds: [], propIds: [], sceneId: null }
  const local = { characters: [{ id: 14, name: '秦翠花' }, { id: 15, name: 'Adam' }], scenes: [], props: [] }
  for (const text of ['@Adamson坐在方桌旁。', '@秦翠花姑娘坐在方桌旁。', '@秦翠花坐垫放在床上。', '@秦翠花站台放在门口。', '@秦翠花站立架放在门口。']) {
    assert.deepEqual(collectScheduledReferenceBindings([text], current, local).characterIds, [], text)
  }
  const longer = { ...local, characters: [...local.characters, { id: 16, name: '秦翠花姑娘' }] }
  assert.deepEqual(collectScheduledReferenceBindings(['@秦翠花姑娘坐在方桌旁。'], current, longer).characterIds, [16])
  const duplicate = { ...local, characters: [...local.characters, { id: 16, name: '秦翠花' }] }
  assert.deepEqual(collectScheduledReferenceBindings(['@秦翠花坐在方桌旁。'], current, duplicate).characterIds, [])
  const cross = { ...local, props: [{ id: 20, name: '秦翠花' }] }
  const result = collectScheduledReferenceBindings(['@秦翠花坐在方桌旁。'], current, cross)
  assert.deepEqual(result.characterIds, []); assert.deepEqual(result.propIds, [])
})

test('the complete J10qbk group-eleven candidate gains only its space-only ID14 binding and renders without hard errors', async () => {
  const artifact = JSON.parse(await fs.readFile(new URL('./fixtures/scheduled-position-j10qbk.json', import.meta.url), 'utf8'))
  const { candidate, group, guide } = artifact
  assert.equal(group.source_group, 11)
  assert.deepEqual(guide.map((source: any) => source.source_line), [11])
  assert.ok(candidate.video_prompt_plan.space.includes('@秦翠花坐在方桌'))
  assert.ok(!candidate.character_ids.includes(14))
  assert.ok(candidate.video_prompt_plan.shots.every((shot: any) => !shot.characters.some((person: any) => person.character_id === 14)))
  assert.ok(candidate.video_prompt_plan.shots.every((shot: any) => shot.rows.every((row: any) => !row.visual.includes('@秦翠花'))))
  const before = JSON.stringify(artifact)
  const input: any = { title: candidate.title, scene_id: candidate.scene_id, prop_ids: structuredClone(candidate.prop_ids),
    atmosphere: candidate.atmosphere, space: candidate.video_prompt_plan.space }
  candidate.video_prompt_plan.shots.forEach((shot: any, index: number) => {
    const voices = shot.rows.flatMap((row: any) => (row.dialogue || []).map((speech: any) => speech.voice))
    voices.forEach((profile: any) => assert.deepEqual(profile, voices[0], 'project only an unchanged real per-shot voice'))
    input[`shot_${index + 1}`] = { characters: structuredClone(shot.characters), visuals: shot.rows.map((row: any) => row.visual),
      ...(voices.length ? { voice: structuredClone(voices[0]) } : {}) }
  })
  const compiled = compileScheduledSegment(input, group, guide, artifact)
  assert.deepEqual([...compiled.character_ids!].sort((a, b) => a - b), [...candidate.character_ids, 14].sort((a: number, b: number) => a - b))
  assert.deepEqual(compiled.video_prompt_plan, candidate.video_prompt_plan, 'space, creative prose, declarations, source slots and voice facts stay unchanged')
  const resolved = resolveSourceDialoguePlan(compiled.video_prompt_plan, guide)
  assert.deepEqual(resolved.issues, [])
  assert.ok(resolved.plan)
  const trustedSourceDialogueSlots = artifact.sourceAllowsOffscreenDialogue ? resolved.sourceSlots.filter(slot => {
    const shot = resolved.plan!.shots.find(shot => shot.shot_number === slot.shotNumber)
    const speech = shot?.rows[slot.rowIndex]?.dialogue?.[slot.dialogueIndex]
    return speech?.kind === 'dialogue' && speech.speaker_id !== undefined && compiled.character_ids!.includes(speech.speaker_id)
      && !shot!.characters.some(character => character.character_id === speech.speaker_id && character.visibility !== 'offscreen')
  }) : []
  const rendered = renderVideoPromptPlan(resolved.plan, { ...artifact, duration: compiled.duration!, characterIds: compiled.character_ids!,
    sceneId: compiled.scene_id, propIds: compiled.prop_ids!, language: 'zh', trustedSourceDialogueSlots })
  assert.deepEqual(rendered.issues.filter(issue => issue.severity === 'error'), [])
  assert.ok(!rendered.prompt.split('\n')[0].includes('@秦翠花'))
  assert.ok(!rendered.participants.some(person => person.characterId === 14))
  assert.equal(JSON.stringify(artifact), before)
})

test('a null scene is inferred only from one unique exact scene and an existing scene is never overwritten', () => {
  const localAssets = { ...assets, scenes: [{ id: 10, location: 'Yard' }, { id: 11, location: '卧室' }] }
  assert.equal(collectScheduledReferenceBindings(['@卧室的门槛'], { characterIds: [], propIds: [], sceneId: null }, localAssets).sceneId, 11)
  assert.equal(collectScheduledReferenceBindings(['@卧室的门槛'], { characterIds: [], propIds: [], sceneId: 10 }, localAssets).sceneId, 10)
  assert.equal(collectScheduledReferenceBindings(['@卧室，@Yard。'], { characterIds: [], propIds: [], sceneId: null }, localAssets).sceneId, null)
  const { group, guide } = scheduled()
  const input = fixture(group); input.scene_id = 999
  assert.throws(() => compileScheduledSegment(input, group, guide, localAssets))
})

test('character references add only outer bindings: gaze targets stay out of shot participants and visible actions still hit the renderer gate', () => {
  const { group, guide } = scheduled(1, 'narration')
  const input = fixture(group)
  input.shot_1.visuals[0] = '@A看向床边的@B。'
  const candidate = compileScheduledSegment(input, group, guide, assets)
  assert.deepEqual(candidate.character_ids, [1, 2])
  assert.deepEqual(candidate.video_prompt_plan!.shots[0].characters.map(value => value.character_id), [1])
  const resolved = resolveSourceDialoguePlan(candidate.video_prompt_plan, guide)
  const rendered = renderVideoPromptPlan(resolved.plan!, { ...assets, duration: group.duration, characterIds: candidate.character_ids!, sceneId: candidate.scene_id, propIds: candidate.prop_ids!, language: 'zh' })
  assert.deepEqual(rendered.issues.filter(issue => issue.severity === 'error'), [])
  assert.ok(!rendered.prompt.split('\n')[0].includes('@B'))
  input.shot_1.visuals[0] = '@B正在抬手，正脸清晰。'
  const visible = compileScheduledSegment(input, group, guide, assets)
  const visibleResolved = resolveSourceDialoguePlan(visible.video_prompt_plan, guide)
  const blocked = renderVideoPromptPlan(visibleResolved.plan!, { ...assets, duration: group.duration, characterIds: visible.character_ids!, sceneId: visible.scene_id, propIds: visible.prop_ids!, language: 'zh' })
  assert.ok(blocked.issues.some(issue => issue.code === 'plan_visual_participant' && issue.severity === 'error'))
})

test('explicit secondary hand-only mentions add a hidden participant and outer ID without inventing face or voice', () => {
  const { group, guide } = scheduled(1, 'narration')
  const input = fixture(group)
  input.shot_2.visuals = ['85mm手部特写，@A背影保持，画面边缘保留@B撑床的手作次要落点。', '@A背影保持，画面只露@B的左手，面部不可见。']
  const original = JSON.stringify(input)
  const result = compileScheduledSegment(input, group, guide, assets)
  const person = result.video_prompt_plan!.shots[1].characters.find(value => value.character_id === 2)
  assert.deepEqual(person, { character_id: 2, visibility: 'face_hidden' })
  assert.ok(result.character_ids!.includes(2))
  assert.equal(result.video_prompt_plan!.shots[0].characters.some(value => value.character_id === 2), false)
  assert.deepEqual(result.video_prompt_plan!.shots[1].rows.map(row => row.visual), input.shot_2.visuals)
  const resolved = resolveSourceDialoguePlan(result.video_prompt_plan, guide)
  const rendered = renderVideoPromptPlan(resolved.plan!, { ...assets, duration: group.duration, characterIds: result.character_ids!, sceneId: result.scene_id, propIds: result.prop_ids!, language: 'zh' })
  assert.deepEqual(rendered.issues.filter(issue => issue.severity === 'error'), [])
  assert.equal(JSON.stringify(input), original)
})

test('a hidden mention cannot mask a face or ambiguous action in another row, and gaze targets are not added as participants', () => {
  const { group, guide } = scheduled(1, 'offscreen')
  for (const later of ['@B正脸清晰，眼睛含泪。', '@B在门口抬手。', '@B只露出手，随后@B转头望向镜头。']) {
    const input = fixture(group)
    input.shot_2.visuals = ['@A背影保持，画面边缘保留@B撑床的手作次要落点。', later]
    const result = compileScheduledSegment(input, group, guide, assets)
    assert.equal(result.video_prompt_plan!.shots[1].characters.some(value => value.character_id === 2), false)
    const resolved = resolveSourceDialoguePlan(result.video_prompt_plan, guide)
    const rendered = renderVideoPromptPlan(resolved.plan!, { ...assets, duration: group.duration, characterIds: result.character_ids!, sceneId: result.scene_id, propIds: result.prop_ids!, language: 'zh' })
    assert.ok(rendered.issues.some(issue => issue.code === 'plan_visual_participant' && issue.severity === 'error'))
  }
  const gaze = fixture(group)
  gaze.shot_2.visuals = ['@A看向@B的背影。', '@A继续听着，保持原位。']
  const result = compileScheduledSegment(gaze, group, guide, assets)
  assert.equal(result.video_prompt_plan!.shots[1].characters.some(value => value.character_id === 2), false)
})

test('explicit positive cuts in later fixed slots become actual shots without changing any visual, voice or canonical source', () => {
  const { group, guide } = scheduled(40, 'narration')
  const input = fixture(group)
  input.shot_1.visuals[1] = '切到85mm特写，@A保持手部动作。'
  input.shot_2.visuals[1] = '切到50mm中景，@A放下左手。'
  const expectedVisuals = [...input.shot_1.visuals, ...input.shot_2.visuals]
  const before = JSON.stringify(input)
  const result = compileScheduledSegment(input, group, guide, assets)
  const shots = result.video_prompt_plan!.shots
  assert.deepEqual(shots.map(shot => shot.shot_number), [1, 2, 3, 4])
  assert.deepEqual(shots.map(shot => shot.rows.length), [1, 1, 1, 1])
  assert.deepEqual(shots.flatMap(shot => shot.rows.map(row => row.visual)), expectedVisuals)
  assert.deepEqual(shots.flatMap(shot => shot.rows.flatMap(row => row.dialogue || [])), group.rows.filter(Boolean).map(ref => ({ ...ref!, voice })))
  assert.deepEqual(shots[0].characters, shots[1].characters)
  assert.deepEqual(shots[2].characters, shots[3].characters)
  assert.equal(result.duration, group.duration)
  assert.equal(JSON.stringify(input), before)
})

test('a single inline cut splits its later slot and prunes only copied pure gaze visibility without changing source or time', () => {
  const { group, guide } = scheduled(1, 'narration'), input = fixture(group)
  input.shot_2.characters = [
    { character_id: 1, visibility: 'face_visible', emotion: { expression: '平静', intensity: 60 } },
    { character_id: 2, visibility: 'face_visible', emotion: { expression: '笃定', intensity: 65 } },
  ]
  input.shot_2.visuals = ['@A看向床侧的@B，眼睑轻颤。', '同一机位同焦段继续推近3秒，切回@B，目光落到@A方向。']
  const original = JSON.stringify(input)
  const candidate = compileScheduledSegment(input, group, guide, assets)
  assert.equal(candidate.duration, group.duration)
  assert.deepEqual(candidate.video_prompt_plan!.shots.map(shot => shot.shot_number), [1, 2, 3])
  assert.deepEqual(candidate.video_prompt_plan!.shots.map(shot => shot.rows.length), [1, 1, 1])
  assert.deepEqual(candidate.video_prompt_plan!.shots.flatMap(shot => shot.rows.map(row => row.visual)), [...input.shot_1.visuals, ...input.shot_2.visuals])
  assert.deepEqual(candidate.video_prompt_plan!.shots.map(shot => shot.characters.map(person => person.character_id)), [[1], [1], [2]])
  assert.deepEqual(candidate.character_ids, [1, 2])
  const speech = candidate.video_prompt_plan!.shots.flatMap(shot => shot.rows.flatMap(row => row.dialogue || []))
  assert.deepEqual(speech.map(({ source_line, fragment_index }) => ({ source_line, fragment_index })), group.rows.filter(Boolean))
  const resolved = resolveSourceDialoguePlan(candidate.video_prompt_plan, guide)
  const rendered = renderVideoPromptPlan(resolved.plan!, { ...assets, duration: group.duration, characterIds: candidate.character_ids!, sceneId: candidate.scene_id, propIds: candidate.prop_ids!, language: 'zh' })
  assert.deepEqual(rendered.issues.filter(issue => issue.severity === 'error'), [])
  assert.ok(rendered.issues.some(issue => issue.code === 'camera_continuity_review' && issue.severity === 'warning'))
  assert.equal(JSON.stringify(input), original)
})

test('split visibility is retained when a copied person has no mention or also performs a definite action', () => {
  const { group, guide } = scheduled(1, 'narration'), input = fixture(group)
  input.shot_2.characters = [{ character_id: 1, visibility: 'face_hidden' }, { character_id: 2, visibility: 'uncertain' }]
  input.shot_2.visuals = ['@A背影保持，镜头固定。', '画面轻推，切回@B，目光落到@A方向；随后@A抬手回应。']
  const candidate = compileScheduledSegment(input, group, guide, assets)
  assert.deepEqual(candidate.video_prompt_plan!.shots.slice(1).map(shot => shot.characters.map(person => person.character_id)), [[1, 2], [1, 2]])
})

test('multiple real cuts in a single slot hard-fail while quoted or negative cuts do not split a continuation', () => {
  const { group, guide } = scheduled(1, 'narration'), input = fixture(group)
  input.shot_2.visuals[1] = '@A维持原位，切回@B的手，随后切到@A背影。'
  assert.throws(() => compileScheduledSegment(input, group, guide, assets), /multiple positive camera cuts/)
  for (const visual of ['@A背影保持，文字牌写有“切回”，镜头仍固定。', '@A背影保持，不要切回，不切到近景。']) {
    input.shot_2.visuals[1] = visual
    const candidate = compileScheduledSegment(input, group, guide, assets)
    assert.deepEqual(candidate.video_prompt_plan!.shots.map(shot => shot.rows.length), [1, 2])
    assert.equal(candidate.video_prompt_plan!.shots[1].rows[1].visual, visual)
  }
})

test('negative cut wording does not split and an already-leading cut on a first row is not duplicated', () => {
  const { group, guide } = scheduled(20, 'narration')
  const input = fixture(group)
  input.shot_1.visuals[0] = '切到35mm背面中景，@A站在门边。'
  input.shot_2.visuals[0] = '切到85mm手部特写，@A松开左手。'
  input.shot_2.visuals[1] = '不切到其他机位，@A继续放下左手。'
  const result = compileScheduledSegment(input, group, guide, assets)
  assert.deepEqual(result.video_prompt_plan!.shots.map(shot => shot.rows.length), [1, 2])
  const resolved = resolveSourceDialoguePlan(result.video_prompt_plan, guide)
  const rendered = renderVideoPromptPlan(resolved.plan!, { ...assets, duration: group.duration, characterIds: result.character_ids!, sceneId: result.scene_id, propIds: result.prop_ids!, language: 'zh' })
  assert.deepEqual(rendered.issues.filter(issue => issue.severity === 'error'), [])
  assert.ok(!rendered.prompt.includes('切到，切到'))
  assert.ok(rendered.prompt.includes('不切到其他机位'))
})

test('more than four actual shots are rejected rather than silently deleting explicit cuts or scheduled rows', () => {
  const { group, guide } = scheduled(55)
  const input = fixture(group)
  input.shot_1.visuals[1] = '切到85mm特写，@A抬手。'
  input.shot_2.visuals[1] = '切到50mm中景，@A站稳。'
  const before = JSON.stringify(input)
  assert.throws(() => compileScheduledSegment(input, group, guide, assets), /2–4/)
  assert.equal(JSON.stringify(input), before)
})

test('canonical source-seven speech echoes are removed only from visuals and each fragment renders once with valid source dialogue', () => {
  const firstFragment = '不只骗你。刚才那片药，也不是止'
  const secondFragment = '疼的。'
  const originalLine = firstFragment + secondFragment
  const { group, guide } = scheduled(20, 'offscreen')
  guide[0].source_line = 7; guide[0].fragments = [firstFragment, secondFragment]
  group.source_line = 7; group.rows = [{ source_line: 7, fragment_index: 1 }, { source_line: 7, fragment_index: 2 }, null]
  const input = fixture(group)
  input.shot_1.visuals[0] = `@A背影保持，听见“药”字时手指收紧。他压低声音说：“${firstFragment}”。`
  input.shot_2.visuals[0] = `@A背影转向院门，声音发颤：“${originalLine}”。`
  input.shot_2.visuals[1] = '@A背影停在门内，手指渐松。'
  const before = JSON.stringify({ input, group, guide })
  const candidate = compileScheduledSegment(input, group, guide, assets)
  const visuals = candidate.video_prompt_plan!.shots.flatMap(shot => shot.rows.map(row => row.visual)).join('')
  assert.ok(!visuals.includes(firstFragment) && !visuals.includes(secondFragment))
  assert.ok(visuals.includes('听见药字时手指收紧'))
  assert.ok(visuals.includes('压低声音说') && visuals.includes('声音发颤'))
  const resolved = resolveSourceDialoguePlan(candidate.video_prompt_plan, guide)
  assert.deepEqual(resolved.issues, [])
  const rendered = renderVideoPromptPlan(resolved.plan!, { ...assets, duration: group.duration, characterIds: candidate.character_ids!, sceneId: candidate.scene_id, propIds: candidate.prop_ids!, language: 'zh' })
  assert.deepEqual(rendered.issues.filter(issue => issue.severity === 'error'), [])
  assert.equal(rendered.prompt.split(firstFragment).length - 1, 1)
  assert.equal(rendered.prompt.split(secondFragment).length - 1, 1)
  const description = resolved.plan!.shots.map(shot => `【镜头${shot.shot_number}】` + shot.rows.map(row => row.visual
    + (row.dialogue || []).map(speech => `B画外音：「${speech.text}」`).join('')).join('')).join('')
  const validated = validateStoryboard({ ...assets, duration: group.duration, description, videoPrompt: rendered.prompt,
    characterIds: candidate.character_ids!, sceneId: candidate.scene_id, propIds: candidate.prop_ids!, shotParticipants: rendered.participants })
  assert.deepEqual(validated.filter(issue => issue.severity === 'error'), [])
  assert.equal(JSON.stringify({ input, group, guide }), before)
})

test('metalinguistic short-word quotes lose only wrappers, while invented speech remains a hard failure and other quotes remain untouched', () => {
  const canonical = ['原文台词。']
  assert.equal(normalizeScheduledVisual('@A听见“药”字时收紧左手。', canonical), '@A听见药字时收紧左手。')
  assert.equal(normalizeScheduledVisual('@A想到「药」这个词的时候低头。', canonical), '@A想到药这个词的时候低头。')
  assert.equal(normalizeScheduledVisual('@A看着墙上的“别怕”二字。', canonical), '@A看着墙上的“别怕”二字。')
  assert.throws(() => normalizeScheduledVisual('@A说：“药”。', canonical), /non-source spoken dialogue/)
  const { group, guide } = scheduled()
  const input = fixture(group); input.shot_1.visuals[0] = '@A低声说：「别怕。」'
  const before = JSON.stringify(input)
  assert.throws(() => compileScheduledSegment(input, group, guide, assets), /non-source spoken dialogue/)
  assert.equal(JSON.stringify(input), before)
})

test('removing an exact source quote removes its own connecting colon without turning following visual prose into narration', () => {
  assert.equal(normalizeScheduledVisual('旁白：「原文台词。」像风一样散去，@A停在门边。', ['原文台词。']), '旁白像风一样散去，@A停在门边。')
  assert.equal(normalizeScheduledVisual('@A低声说：“原文台词。”，继而松开手。', ['原文台词。']), '@A低声说，继而松开手。')
})

test('native Mastra OpenAI SSE can export and execute the single-submit schema without DB or transform errors', { concurrency: false }, async () => {
  const { group, guide } = scheduled()
  const input = { ...fixture(group), duration: 1, text: 'ignored canonical claim' }
  input.shot_2.visuals[1] = '切到50mm中景，@A放下左手。'
  input.voice = { ...voice }; delete input.shot_1.voice; delete input.shot_2.voice
  const originalFetch = globalThis.fetch, oldEnv = process.env.NODE_ENV
  globalThis.fetch = async () => { throw new Error('Unexpected external fetch blocked') }
  process.env.NODE_ENV = 'test'
  let requests = 0, executions = 0
  let candidate: ReturnType<typeof compileScheduledSegment> | undefined
  try {
    const provider = createOpenAI({ apiKey: 'offline-only', baseURL: 'https://example.invalid/v1', fetch: async (_url, init) => {
      requests++; assert.equal(requests, 1)
      const body = JSON.parse(String(init?.body)); assert.equal(body.stream, true)
      assert.ok(body.tools?.[0]?.function?.parameters?.properties?.shot_1)
      const base = { id: 'offline-scheduled', object: 'chat.completion.chunk', created: 0, model: 'offline' }
      const chunks = [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'scheduled-local', type: 'function', function: { name: 'submit_segment', arguments: JSON.stringify(input) } }] }, finish_reason: null }] }, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    } })
    const agent = new Agent({ id: 'offline-scheduled-segment', name: 'Offline scheduled segment', instructions: 'Use only the local fixture tool.', model: provider.chat('offline'), maxRetries: 0, tools: {
      submit_segment: createTool({ id: 'submit_segment', description: 'Local single-submit compile only; no production tool.', inputSchema: buildScheduledSegmentSchema(group, assets), execute: async value => {
        executions++; candidate = compileScheduledSegment(value, group, guide, assets); return { accepted: true }
      } }),
    } })
    const output = await agent.stream('offline fixture', { stopWhen: ({ steps }: any) => steps.length >= 1 })
    const full = await output.getFullOutput(); if (full.error) throw full.error
    assert.equal(requests, 1); assert.equal(executions, 1)
    assert.equal(candidate?.duration, group.duration)
    assert.deepEqual(candidate?.video_prompt_plan?.shots.map(shot => shot.rows.length), [1, 1, 1])
    assert.equal(candidate?.video_prompt_plan?.shots[2].rows[0].visual, input.shot_2.visuals[1])
    assert.deepEqual(candidate?.video_prompt_plan?.shots[0].rows[0].dialogue?.[0].voice, voice)
    assert.ok(!JSON.stringify(candidate).includes('ignored canonical claim'))
  } finally {
    globalThis.fetch = originalFetch
    if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv
  }
})

test('native Mastra enforces the shared-or-per-shot voice refinement before execute when all profiles are missing', { concurrency: false }, async () => {
  const { group } = scheduled()
  const input = fixture(group); delete input.shot_1.voice; delete input.shot_2.voice
  const originalFetch = globalThis.fetch, oldEnv = process.env.NODE_ENV
  globalThis.fetch = async () => { throw new Error('Unexpected external fetch blocked') }
  process.env.NODE_ENV = 'test'
  let requests = 0, executions = 0
  try {
    const provider = createOpenAI({ apiKey: 'offline-only', baseURL: 'https://example.invalid/v1', fetch: async () => {
      requests++; assert.equal(requests, 1)
      const base = { id: 'offline-missing-voice', object: 'chat.completion.chunk', created: 0, model: 'offline' }
      const chunks = [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'missing-voice', type: 'function', function: { name: 'submit_segment', arguments: JSON.stringify(input) } }] }, finish_reason: null }] }, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    } })
    const agent = new Agent({ id: 'offline-voice-refinement', name: 'Offline voice refinement', instructions: 'Local fixture tool only.', model: provider.chat('offline'), maxRetries: 0,
      tools: { submit_segment: createTool({ id: 'submit_segment', inputSchema: buildScheduledSegmentSchema(group, assets), execute: async () => { executions++; return { accepted: true } } }) } })
    const output = await agent.stream('offline fixture', { stopWhen: ({ steps }: any) => steps.length >= 1 })
    const full = await output.getFullOutput(); if (full.error) throw full.error
    assert.equal(requests, 1); assert.equal(executions, 0)
  } finally {
    globalThis.fetch = originalFetch
    if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv
  }
})

test('native Mastra accepts 2+1 and 2+1+2 slot layouts in one call without a repair request', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch, oldEnv = process.env.NODE_ENV
  globalThis.fetch = async () => { throw new Error('Unexpected external fetch blocked') }; process.env.NODE_ENV = 'test'
  try {
    for (const [count, lengths] of [[20, [2, 1]], [55, [2, 1, 2]]] as const) {
      const { group, guide } = scheduled(count)
      const input = fixture(group), flat = getScheduledShotLayout(group.rows.length).flatMap((_n, index) => input[`shot_${index + 1}`].visuals)
      input.voice = { ...voice }; let offset = 0
      lengths.forEach((length, index) => { input[`shot_${index + 1}`].visuals = flat.slice(offset, offset + length); delete input[`shot_${index + 1}`].voice; offset += length })
      let requests = 0, executions = 0, result: ReturnType<typeof compileScheduledSegment> | undefined
      const provider = createOpenAI({ apiKey: 'offline-only', baseURL: 'https://example.invalid/v1', fetch: async () => {
        requests++; assert.equal(requests, 1)
        const base = { id: `offline-flex-${count}`, object: 'chat.completion.chunk', created: 0, model: 'offline' }
        const chunks = [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'flex-local', type: 'function', function: { name: 'submit_segment', arguments: JSON.stringify(input) } }] }, finish_reason: null }] }, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]
        return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      } })
      const agent = new Agent({ id: `offline-flex-${count}`, name: 'Offline flexible layout', instructions: 'Local fixture tool only.', model: provider.chat('offline'), maxRetries: 0,
        tools: { submit_segment: createTool({ id: 'submit_segment', inputSchema: buildScheduledSegmentSchema(group, assets), execute: async value => { executions++; result = compileScheduledSegment(value, group, guide, assets); return { accepted: true } } }) } })
      const output = await agent.stream('offline fixture', { stopWhen: ({ steps }: any) => steps.length >= 1 })
      const full = await output.getFullOutput(); if (full.error) throw full.error
      assert.equal(requests, 1); assert.equal(executions, 1)
      assert.deepEqual(result!.video_prompt_plan!.shots.map(shot => shot.rows.length), [...lengths])
    }
  } finally { globalThis.fetch = originalFetch; if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv }
})
