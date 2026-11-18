import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDialogueTimingGuide, buildDialogueGroupSchedule, firstPassInstructions } from '../src/services/first-pass-instructions.ts'
import { extractScriptDialogue } from '../src/services/script-dialogue.ts'

test('the real screenplay format exposes exact short timing fragments before prose generation', () => {
  const text = '打晓军、护孩子？行。那今天就把晓茹娶进门，让孩子有人带。不娶，拿五百块；不给，我去你铁路单位找领导！'
  const lines = extractScriptDialogue(`秦翠花：（笑脸一下收住）${text}`, ['秦翠花'])
  const guide = buildDialogueTimingGuide(lines, [{ id: 7, name: '秦翠花' }])[0]
  assert.equal(guide.character_id, 7)
  assert.equal(guide.fragments.join(''), text)
  assert.ok(guide.minimum_group_seconds! > 9)
  for (const fragment of guide.fragments) assert.ok([...fragment].filter(value => /[\p{L}\p{N}]/u.test(value)).length <= 13)
})

test('a long original line explicitly requires more than one group without dropping or repeating words', () => {
  const text = '这段原词需要按照真实时长分组安排。'.repeat(6)
  const guide = buildDialogueTimingGuide([{ speakerName: '甲', kind: 'dialogue', text }], [])[0]
  assert.equal(guide.requires_multiple_groups, true)
  assert.ok(guide.minimum_group_seconds! > 15)
  assert.equal(guide.fragments.join(''), text)
  assert.equal(guide.character_id, undefined)
})

test('timing guidance does not force Chinese arithmetic onto other spoken languages', () => {
  const text = 'I will keep every original spoken word exactly as written.'
  const guide = buildDialogueTimingGuide([{ kind: 'narration', text }], [])[0]
  assert.equal(guide.minimum_group_seconds, undefined)
  assert.deepEqual(guide.fragments, [text])
})

test('the group schedule covers every original fragment once with a safe total and per-row speech budget', () => {
  const guide = buildDialogueTimingGuide([{ kind: 'dialogue', text: '原文台词必须完整按顺序保留而且不提速。'.repeat(9) },
    { kind: 'offscreen', text: '爸爸快来！' }], [])
  const groups = buildDialogueGroupSchedule(guide)
  assert.deepEqual(groups.flatMap(group => group.rows.filter(Boolean)), guide.flatMap(line => line.fragments.map((_, index) => ({ source_line: line.source_line, fragment_index: index + 1 }))))
  for (const group of groups) {
    assert.ok([9, 12, 15].includes(group.duration))
    assert.equal(group.rows.length * 3, group.duration)
    assert.ok(group.chinese_characters / 4.5 + 2 <= group.duration)
  }
})

test('first-pass instructions resolve timing priorities and explain exact row counts before writing', () => {
  const text = firstPassInstructions('storyboard_breaker')
  assert.ok(text.includes('dialogue_timing_guide'))
  assert.ok(text.includes('9秒只能共3行'))
  assert.ok(text.includes('500字/分钟只是规划预估'))
  assert.ok(text.includes('3秒内中文台词最多13字'))
})
