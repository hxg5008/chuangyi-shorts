import test from 'node:test'
import assert from 'node:assert/strict'
import { collectJimengReferences, jimengLocalVideoPayload, jimengLocalDefaultDraft, jimengShotDraft, jimengAttemptState, jimengAttemptError, jimengManualVideoReady, mergeJimengTaskSnapshots } from '../app/utils/jimeng-local-video.js'

test('execution parameters follow the shot duration and the project aspect ratio', () => {
  assert.deepEqual(jimengShotDraft({ duration: 12 }, '9:16'), { duration: 12, aspectRatio: '9:16' })
  assert.deepEqual(jimengShotDraft({ duration: 9.6 }, '1:1'), { duration: 10, aspectRatio: '1:1' })
  assert.deepEqual(jimengShotDraft({ duration: 10 }, 'adaptive'), { duration: 10, aspectRatio: '16:9' })
  assert.equal(jimengShotDraft(null, '16:9').duration, 15, 'no shot selected keeps the old default')
  // An out-of-range shot is not silently cut: the payload check reports it.
  assert.throws(() => jimengLocalVideoPayload(jimengShotDraft({ duration: 18 }, '16:9'), [], '提示词'), /1–15/)
})

test('Chinese names, shared image bytes, order and original narration survive submission', () => {
  const refs = collectJimengReferences({ location: '周启卧室', image_url: 'static/场景.png' }, [{ name: '母亲', image_url: 'static/人物.png' }, { name: '周启', image_url: 'static/人物.png' }], [{ name: '药瓶', image_url: 'static/药瓶.png' }])
  const prompt = '🙂 @母亲站A(X+0.8米，Y0)，@周启接过@药瓶。\n场景：@周启卧室。'
  const payload = jimengLocalVideoPayload({ duration: 12, aspectRatio: '9:16' }, refs, prompt)
  assert.deepEqual(payload.reference_image_names, ['周启卧室', '母亲', '周启', '药瓶'])
  assert.deepEqual(payload.reference_image_urls, ['static/场景.png', 'static/人物.png', 'static/人物.png', 'static/药瓶.png'])
  assert.equal(payload.prompt, prompt)
  assert.equal(payload.duration, 12)
  assert.equal(payload.generate_audio, undefined)
  assert.equal(payload.resolution, undefined)
})

test('reject unsupported requests without silently clipping images or shot timing', () => {
  const draft = jimengLocalDefaultDraft('adaptive')
  assert.equal(draft.aspectRatio, '16:9')
  const refs = Array.from({ length: 10 }, (_, i) => ({ name: `图${i}`, url: `static/${i}.png` }))
  assert.throws(() => jimengLocalVideoPayload(draft, refs, '提示词'), /不会自动截掉/)
  assert.throws(() => jimengLocalVideoPayload({ ...draft, duration: 16 }, [], '提示词'), /1–15/)
  assert.throws(() => jimengLocalVideoPayload({ ...draft, duration: 1.5 }, [], '提示词'), /整数/)
  assert.throws(() => jimengLocalVideoPayload(draft, [], '提示词', 'other-model'), /对应型号/)
})

test('nine bound images keep every name, URL and the ninth mention', () => {
  const refs = Array.from({ length: 9 }, (_, i) => ({ name: `素材${i + 1}`, url: `static/ref-${i + 1}.png` }))
  const prompt = '场景@素材1。人物@素材8使用@素材9。🙂'
  const result = jimengLocalVideoPayload(jimengLocalDefaultDraft(), refs, prompt)
  assert.deepEqual(result.reference_image_urls, refs.map(ref => ref.url))
  assert.deepEqual(result.reference_image_names, refs.map(ref => ref.name))
  assert.equal(result.prompt, prompt)
})

test('scene time is metadata, not part of the natural @ name; overlapping names stay intact', () => {
  const refs = collectJimengReferences({ location: '周启卧室', time: '夜晚', image_url: 'static/scene.png' }, [{ name: '母亲', image_url: 'static/a.png' }, { name: '母亲朋友', image_url: 'static/b.png' }])
  const prompt = '场景@周启卧室。@母亲从桌边拿起空杯，@母亲朋友看着她。🙂'
  const payload = jimengLocalVideoPayload(jimengLocalDefaultDraft(), refs, prompt)
  assert.deepEqual(payload.reference_image_names, ['周启卧室', '母亲', '母亲朋友'])
  assert.equal(payload.prompt, prompt)
  assert.equal(payload.prompt.includes('夜晚'), false)
})

test('latest Jimeng status remains independent of old playable media', () => {
  const base = { provider: 'jimeng_local', id: 20, storyboard_id: 1 }
  assert.equal(jimengAttemptState({ ...base, status: 'processing', local_path: 'old.mp4' }), 'pending')
  const failed = { ...base, status: 'failed', error_msg: '参考图可能包含低俗内容，请修改后重试', result_url: 'old.mp4' }
  assert.equal(jimengAttemptState(failed), 'failed')
  assert.equal(jimengAttemptError(failed), failed.error_msg)
  assert.equal(jimengManualVideoReady({ ...base, status: 'completed', stage: 'ready_in_local_service' }), true)
  assert.equal(jimengManualVideoReady({ ...base, provider: '888api', status: 'completed', stage: 'ready_in_local_service' }), false)
})

test('out-of-order polling cannot revive a failed Jimeng task, recovery newer than terminal can', () => {
  const terminal = { id: 1, provider: 'jimeng_local', status: 'failed', updated_at: '2026-11-05T05:20:00Z' }
  const stale = { ...terminal, status: 'processing', updated_at: '2026-11-05T05:19:59Z' }
  assert.deepEqual(mergeJimengTaskSnapshots([terminal], [stale]), [terminal])
  const recovering = { ...terminal, status: 'processing', updated_at: '2026-11-05T05:21:00Z' }
  assert.deepEqual(mergeJimengTaskSnapshots([terminal], [recovering]), [recovering])
  const other = { id: 2, provider: '888api', status: 'processing' }
  assert.deepEqual(mergeJimengTaskSnapshots([terminal], [other]), [other])
  assert.deepEqual(mergeJimengTaskSnapshots([recovering], [other]), [recovering, other])
})
