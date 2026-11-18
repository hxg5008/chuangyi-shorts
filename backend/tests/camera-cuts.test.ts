import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cameraCuts, hasLeadingCameraCut } from '../src/services/camera-cuts.ts'

test('explicit positive shot boundaries are recognized across supported languages', () => {
  for (const text of ['切到@阿甲近景。', '镜头切回@阿甲。', 'Cut to @Actor.', 'The camera cuts back to Actor.', 'カットを切り替え、@太郎を映す。', '近景に戻る。', '컷 전환, @민수.', '근경으로 전환, @민수.']) {
    assert.equal(cameraCuts(text).length, 1, text)
    assert.equal(hasLeadingCameraCut(text), true, text)
  }
})

test('negated camera instructions are not new boundaries and negation does not leak across clauses', () => {
  for (const text of ['不切回门口。', '不要再切至门口。', '不能切到门口。', 'Do not cut back to the door.', "Don't cut to the door.", 'Never cut back.', 'カットを切り替えない。', 'カットバックはしない。', '近景に戻りません。', '컷 전환하지 않는다.', '근경으로 전환하지 말고 고정한다.', '컷 전환 금지.']) {
    assert.equal(cameraCuts(text).length, 0, text)
    assert.equal(hasLeadingCameraCut(text), false, text)
  }
  assert.equal(cameraCuts('不越轴，切到@阿甲近景，不切回门口。').length, 1)
  assert.equal(cameraCuts('Do not cross the axis; cut to Actor. Do not cut back.').length, 1)
  assert.equal(cameraCuts('不但切到@阿甲，随后切回@阿乙。').length, 2)
})

test('quoted dialogue and explicit topic metaphors do not create camera cuts', () => {
  for (const text of ['阿甲说：「切回门口。」', '他说：“切到门口。”', "Actor says: 'Cut back to the door.'", 'Actor says: "Cut to the door."', '话锋切至旧事。', '话题切换至往事。', 'The topic switch to old memories.', '話題を切り替え、話を続ける。', '화제로 전환.']) {
    assert.equal(cameraCuts(text).length, 0, text)
    assert.equal(hasLeadingCameraCut(text), false, text)
  }
  assert.equal(cameraCuts("Actor's left arm lowers; cut to his mother's face.").length, 1, 'possessive apostrophes are not dialogue quotes')
})

test('adjacent synonymous commands at the beginning name one boundary; cuts after actual content stay separate', () => {
  for (const text of ['切到，切换至@阿甲近景。', 'Cut to, switch to Actor.', 'カットを切り替え、カットバック、@太郎。', '컷 전환, 컷 백, @민수.']) assert.equal(cameraCuts(text).length, 1, text)
  for (const text of ['切到@阿甲近景，随后切回@阿乙中景。', 'Cut to Actor; switch to Other.', 'カットを切り替え、@太郎を映す。カットバック。', '컷 전환, @민수. 컷 백, 다른 사람.', '切到，「门开了」，切回门口。']) assert.equal(cameraCuts(text).length, 2, text)
})

test('negation, quotation and metaphor exclusions can coexist without suppressing a genuine second cut', () => {
  const text = '切到，切换至@阿甲近景，不切回门口；话锋切至旧事，他说：「不要切到门口。」随后切回@阿乙中景。'
  const cuts = cameraCuts(text)
  assert.equal(cuts.length, 2)
  assert.equal(text.slice(cuts[1].index, cuts[1].end), '切回')
  assert.equal(hasLeadingCameraCut(text), true)
})
