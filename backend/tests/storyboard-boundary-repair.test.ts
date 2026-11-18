import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boundaryVersion, isAdjacentBoundaryConflict, prepareBoundaryRepair, validateBoundaryRepairScope } from '../src/services/storyboard-boundary-repair.ts'

function candidate(number: number) {
  return { shot_number: number, title: '固定标题', time: '日', location: '院落', shot_type: '中景', angle: '平视', movement: '固定',
    description: '【镜头1】阿甲说：「回来。」两人沿院落走。\n【镜头2】阿乙说：「我在。」两人双手空垂。',
    video_prompt: '出场人物：@阿甲、@阿乙；场景：@院落。\n0-3秒：阿甲说：「回来。」沿院落走。\n3-6秒：沿院落走。\n6-9秒：阿乙说：「我在。」双手空垂。\n9-12秒：双手空垂。\n',
    result: '两人双手空垂。', duration: 12, time_row_counts: [2, 2], scene_id: 1, character_ids: [1, 2], prop_ids: [], source_ids: [number],
    image_prompt: '原首镜', atmosphere: '日光', bgm_prompt: '无背景音乐', sound_effect: '脚步声', voice_cues: [{ id: 'v1', speaker_id: 1 }] }
}
const names = ['阿甲', '阿乙']
const pair = () => {
  const previous = candidate(1), current = candidate(2), nextPrevious = structuredClone(previous), nextCurrent = structuredClone(current)
  nextPrevious.description = nextPrevious.description.replace('两人双手空垂', '两人仍牵着手')
  nextPrevious.video_prompt = nextPrevious.video_prompt.replaceAll('双手空垂', '仍牵着手')
  nextPrevious.result = '两人仍牵着手。'
  nextCurrent.description = nextCurrent.description.replace('两人沿院落走', '两人停步，阿乙松开阿甲的手')
  nextCurrent.video_prompt = nextCurrent.video_prompt.replace('沿院落走。', '停步，阿乙松开阿甲的手。')
  return { previous, current, nextPrevious, nextCurrent }
}

test('only explicit adjacent-state reports opt into boundary recovery', () => {
  assert.equal(isAdjacentBoundaryConflict({ field: 'previous_ending', conflict: '前组已松手，与原文冲突。' }), true)
  assert.equal(isAdjacentBoundaryConflict({ field: 'workflow', conflict: '上一组的牵手末态与当前原文矛盾。' }), true)
  for (const raw of [null, {}, { field: 'duration', conflict: '上一组末态冲突' }, { field: 'previous_ending', conflict: '台词容量不足' }, { field: 'workflow', conflict: '下一组有问题' }, { field: 'workflow', conflict: '内容错误' }]) assert.equal(isAdjacentBoundaryConflict(raw), false)
})
test('snapshot versions and edit ranges are detached and require consecutive exact group IDs', () => {
  const { previous, current } = pair(), prepared = prepareBoundaryRepair(previous, current, { previousNumber: 1, currentNumber: 2 })!
  assert.ok(prepared);assert.deepEqual(prepared.editable.previous.videoRows, [3, 4]);assert.deepEqual(prepared.editable.current, { descriptionShots: [1], videoRows: [1, 2], result: false })
  assert.equal(prepared.previousVersion, boundaryVersion(previous));prepared.previous.result = 'changed';assert.notEqual(prepared.previous.result, previous.result)
  assert.equal(prepareBoundaryRepair(previous, current, { previousNumber: 1, currentNumber: 3 }), null)
})
test('allows only previous final shot/result and current opening shot with exact spoken words', () => {
  const { previous, current, nextPrevious, nextCurrent } = pair()
  assert.deepEqual(validateBoundaryRepairScope(previous, nextPrevious, current, nextCurrent, names), [])
})
test('rejects changes to other shots, final state, plan fields, bindings, voices or metadata', () => {
  const p = pair()
  for (const mutate of [
    (v: any) => { v.description = v.description.replace('两人沿院落走', '两人冲进屋内') },
    (v: any) => { v.video_prompt = v.video_prompt.replace('3-6秒：沿院落走。', '3-6秒：走向门外。') },
    (v: any) => { v.duration = 15 }, (v: any) => { v.character_ids = [1] }, (v: any) => { v.source_ids = [3] },
    (v: any) => { v.voice_cues[0].speaker_id = 2 }, (v: any) => { v.image_prompt = '换首镜' },
  ]) { const n = structuredClone(p.nextPrevious);mutate(n);assert.ok(validateBoundaryRepairScope(p.previous, n, p.current, p.nextCurrent, names).length) }
  const changedEnding = { ...p.nextCurrent, result: '下一组未知结尾' }
  assert.ok(validateBoundaryRepairScope(p.previous, p.nextPrevious, p.current, changedEnding, names).length)
})
test('rejects dialogue edits and voice-anchor changes even in editable boundary rows', () => {
  const p = pair(), changed = structuredClone(p.nextPrevious)
  changed.description = changed.description.replace('我在。', '我不在。')
  assert.ok(validateBoundaryRepairScope(p.previous, changed, p.current, p.nextCurrent, names).some(e => /原词/.test(e.message)))
  const anchored = structuredClone(p.previous);anchored.description = anchored.description.replace('阿乙说：', '[[voice:v2]]：')
  const anchoredNext = structuredClone(anchored);anchoredNext.description = anchoredNext.description.replace('voice:v2', 'voice:v3')
  assert.ok(validateBoundaryRepairScope(anchored, anchoredNext, p.current, p.nextCurrent, names).length)
  const typed = structuredClone(p.previous);typed.description = typed.description.replaceAll('阿乙', '[[character:2]]')
  const typedNext = structuredClone(typed);typedNext.description = typedNext.description.replace('[[character:2]]说', '[[character:1]]说')
  assert.ok(validateBoundaryRepairScope(typed, typedNext, p.current, p.nextCurrent, names).some(e => /原词/.test(e.message)))
})
test('rejects changed timeline, headers, marker count or mapping', () => {
  const p = pair()
  for (const mutate of [(v: any) => { v.video_prompt = v.video_prompt.replace('9-12秒', '9-11秒') },
    (v: any) => { v.video_prompt = v.video_prompt.replace('@院落', '@屋内') },
    (v: any) => { v.description += '【镜头3】新镜头' },
    (v: any) => { v.time_row_counts = [1, 3] },
  ]) { const n = structuredClone(p.nextPrevious);mutate(n);assert.ok(validateBoundaryRepairScope(p.previous, n, p.current, p.nextCurrent, names).length) }
})
test('a current conflict envelope can be replaced with a complete candidate, but an invalid previous layout cannot', () => {
  const p = pair(), conflict = { conflict: '前组末态错误', field: 'previous_ending' }
  assert.equal(prepareBoundaryRepair(p.previous, conflict, { previousNumber: 1, currentNumber: 2 })?.current, null)
  assert.deepEqual(validateBoundaryRepairScope(p.previous, p.nextPrevious, conflict, p.nextCurrent, names), [])
  assert.ok(validateBoundaryRepairScope({ ...p.previous, time_row_counts: [] }, p.nextPrevious, conflict, p.nextCurrent, names).length)
  assert.ok(validateBoundaryRepairScope(p.previous, p.nextPrevious, conflict, { description: '只有摘要' }, names).length)
})
