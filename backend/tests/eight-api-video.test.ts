import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EightApiVideoAdapter, EIGHT_API_DEFAULT_MODEL, EIGHT_API_C5_MODEL, EIGHT_API_FAST_VIP_MODEL, EIGHT_API_VIDEO_MODELS, EIGHT_API_MAX_IMAGE_BYTES, validateEightApiVideoSettings, validateEightApiVideoControls } from '../src/services/adapters/eight-api-video.ts'
import { getVideoAdapter } from '../src/services/adapters/registry.ts'
import type { VideoGenerationRecord } from '../src/services/adapters/types.ts'

const adapter = new EightApiVideoAdapter()
const config = { provider: '888api', baseUrl: 'https://888api.xin', apiKey: 'local-test-key', model: EIGHT_API_FAST_VIP_MODEL }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const dataUri = `data:image/png;base64,${png.toString('base64')}`
const record = (fields: Partial<VideoGenerationRecord> = {}): VideoGenerationRecord => ({ id: 1, prompt: 'local adapter test', ...fields })
const form = (fields: Partial<VideoGenerationRecord> = {}) => adapter.buildGenerateRequest(config, record(fields))

test('888api is registered independently and validates the exact supported model settings', () => {
  assert.ok(getVideoAdapter('888api') instanceof EightApiVideoAdapter)
  assert.equal(getVideoAdapter('888api').provider, '888api')
  assert.equal(EIGHT_API_DEFAULT_MODEL, 'seedance2.0-933-c5-fast')
  assert.deepEqual(validateEightApiVideoSettings(EIGHT_API_DEFAULT_MODEL), { duration: 5, aspectRatio: '16:9', resolution: '720p' })
  assert.deepEqual(validateEightApiVideoSettings(EIGHT_API_FAST_VIP_MODEL), { duration: 15, aspectRatio: '16:9', resolution: '720p' })
  for (const duration of [0, 9, 14, 15.5, NaN]) assert.throws(() => validateEightApiVideoSettings(EIGHT_API_FAST_VIP_MODEL, duration), /15 秒/)
  for (const model of EIGHT_API_VIDEO_MODELS.filter(model => model !== EIGHT_API_FAST_VIP_MODEL)) {
    assert.equal(validateEightApiVideoSettings(model).duration, 5)
    for (const duration of [4, 9, 15]) assert.equal(validateEightApiVideoSettings(model, duration).duration, duration)
    for (const duration of [0, 3, 16, 4.5, NaN]) assert.throws(() => validateEightApiVideoSettings(model, duration), /4–15/)
  }
  assert.throws(() => validateEightApiVideoSettings('seedance2.0-900-wool', 9), /尚未接入/)
  assert.throws(() => validateEightApiVideoSettings(EIGHT_API_DEFAULT_MODEL, 15, 'adaptive'), /画幅/)
  assert.throws(() => validateEightApiVideoSettings(EIGHT_API_DEFAULT_MODEL, 15, '16:9', '1080p'), /720p/)
  assert.deepEqual(validateEightApiVideoSettings(EIGHT_API_DEFAULT_MODEL, 15, '9:16', '720P'), { duration: 15, aspectRatio: '9:16', resolution: '720p' })
})

test('unsupported optional controls reject explicit false, true and zero rather than silently dropping them', () => {
  assert.doesNotThrow(() => validateEightApiVideoControls({}))
  assert.doesNotThrow(() => validateEightApiVideoControls({ generateAudio: null, seed: undefined, promptExtend: null, watermark: undefined }))
  const cases: Array<[Partial<VideoGenerationRecord>, string]> = [
    [{ generateAudio: false }, 'generate_audio'],
    [{ generateAudio: true }, 'generate_audio'],
    [{ seed: 0 }, 'seed'],
    [{ watermark: false }, 'watermark'],
    [{ promptExtend: false }, 'prompt_extend'],
  ]
  for (const [fields, name] of cases) {
    assert.throws(() => validateEightApiVideoControls(fields), error => {
      assert.ok(error instanceof Error)
      assert.ok(error.message.includes(name))
      assert.match(error.message, /未提供.*可控参数/)
      assert.match(error.message, /声轨由平台默认/)
      return true
    })
    for (const model of [EIGHT_API_C5_MODEL, EIGHT_API_FAST_VIP_MODEL]) {
      assert.throws(() => form({ model, ...fields }), new RegExp(name))
    }
  }
  assert.doesNotThrow(() => form({ model: EIGHT_API_C5_MODEL }))
})

test('multipart preserves mixed local-image and HTTPS order, exact field names and human-readable names', async () => {
  const request = form({ prompt: '保持@图片1角色甲外观，在@图2场景乙中转身，参考@image_file_3动作。',
    referenceImageUrls: JSON.stringify([dataUri, 'https://example.invalid/scene.png', dataUri]) })
  assert.equal(request.url, 'https://888api.xin/v1/videos')
  assert.equal(request.method, 'POST')
  assert.equal(request.headers.Authorization, 'Bearer local-test-key')
  assert.ok(Object.keys(request.headers).every(key => key.toLowerCase() !== 'content-type'))
  assert.ok(request.body instanceof FormData)
  const body: FormData = request.body
  assert.equal(body.get('model'), EIGHT_API_FAST_VIP_MODEL)
  assert.equal(body.get('functionMode'), 'omni_reference')
  assert.equal(body.get('duration'), '15')
  assert.equal(body.get('ratio'), '16:9')
  assert.equal(body.get('resolution'), '720p')
  assert.equal(body.get('prompt'), '保持@image_file_1 角色甲外观，在@image_file_2 场景乙中转身，参考@image_file_3 动作。')
  const first = body.get('image_file_1')
  const third = body.get('image_file_3')
  assert.ok(first instanceof Blob)
  assert.ok(third instanceof Blob)
  assert.equal(first.type, 'image/png')
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), png)
  assert.deepEqual(Buffer.from(await third.arrayBuffer()), png)
  assert.equal(body.get('image_file_2'), 'https://example.invalid/scene.png')
  assert.equal(body.get('image_file_0'), null)
  assert.equal(body.get('image_file_4'), null)
  assert.equal(body.get('file_paths'), null)
})

test('all-HTTPS and duplicate references still use numbered multipart fields without reordering', () => {
  const refs = ['https://example.invalid/first.png', 'https://example.invalid/first.png', 'https://example.invalid/last.png']
  const body = form({ referenceImageUrls: JSON.stringify(refs), prompt: '@图1和@图2，最后@图3。' }).body as FormData
  assert.deepEqual(refs.map((_, index) => body.get(`image_file_${index + 1}`)), refs)
  const max = form({ referenceImageUrls: JSON.stringify(Array(12).fill(dataUri)), prompt: '@图12。' }).body as FormData
  assert.ok(max.get('image_file_12') instanceof Blob)
  assert.equal(max.get('image_file_13'), null)
})

test('text-only generation uses first_last_frames and image reference generation uses omni_reference', () => {
  assert.equal(form().body.get('functionMode'), 'first_last_frames')
  assert.equal(form({ referenceImageUrls: JSON.stringify([dataUri]) }).body.get('functionMode'), 'omni_reference')
})

test('oversized local references are rejected before decoding a large Blob', () => {
  const oversized = 'data:image/png;base64,' + 'A'.repeat(Math.ceil(EIGHT_API_MAX_IMAGE_BYTES / 3) * 4 + 4)
  assert.throws(() => form({ referenceImageUrls: JSON.stringify([oversized]) }), /30MiB/)
})

test('unsupported or malformed references fail clearly instead of being dropped or reassigned', () => {
  assert.throws(() => form({ referenceImageUrls: JSON.stringify(Array(13).fill(dataUri)) }), /12/)
  assert.throws(() => form({ referenceVideoUrls: '["https://example.invalid/video.mp4"]' }), /不支持参考视频或音频/)
  assert.throws(() => form({ referenceAudioUrls: '["https://example.invalid/audio.mp3"]' }), /不支持参考视频或音频/)
  for (const fields of [{ firstFrameUrl: dataUri }, { lastFrameUrl: dataUri }, { imageUrl: dataUri },
    { referenceFileUrl: 'https://example.invalid/file' }, { referenceLinkUrl: 'https://example.invalid/link' }]) {
    assert.throws(() => form(fields), /暂不支持首尾帧/)
  }
  for (const raw of ['{bad', 'null', '{}', '[""]', '[1]', '[null]']) assert.throws(() => form({ referenceImageUrls: raw }), /参考图片/)
  for (const image of ['static/local.png', 'file:///local.png', 'http://example.invalid/a.png', 'https://user:pass@example.invalid/a.png',
    'data:image/png;base64,!!!!', 'data:image/png;base64,A', 'data:image/svg+xml;base64,PHN2Zz4=']) {
    assert.throws(() => form({ referenceImageUrls: JSON.stringify([image]) }), /参考图/)
  }
  for (const prompt of ['@图0。', '@图片2角色甲', '@image_file_9']) {
    assert.throws(() => form({ referenceImageUrls: JSON.stringify([dataUri]), prompt }), /参考图序号/)
  }
  assert.throws(() => form({ prompt: '@图1' }), /参考图序号/)
  assert.throws(() => form({ prompt: ' ' }), /非空提示词/)
  assert.throws(() => form({ referenceMode: 'first_last_frames' }), /omni_reference/)
})

test('model family and precise duration, ratio, resolution are sent without silent coercion', () => {
  for (const model of EIGHT_API_VIDEO_MODELS) {
    const duration = model === EIGHT_API_FAST_VIP_MODEL ? 15 : 9
    const request = form({ model, duration, aspectRatio: '21:9', resolution: '720P' })
    if (model === EIGHT_API_C5_MODEL) {
      assert.equal(request.body.model, model)
      assert.equal(request.body.duration, duration)
      assert.equal(request.body.ratio, '21:9')
      assert.equal(request.body.resolution, '720p')
    } else {
      assert.equal(request.body.get('model'), model)
      assert.equal(request.body.get('duration'), String(duration))
      assert.equal(request.body.get('ratio'), '21:9')
      assert.equal(request.body.get('resolution'), '720p')
    }
  }
  assert.throws(() => form({ duration: 9 }), /固定生成 15 秒/)
})

test('C5 uses the documented JSON images protocol, preserves order and normalizes numbered references', () => {
  const refs = ['https://example.invalid/person.png', 'https://example.invalid/scene.png', 'https://example.invalid/person.png']
  const request = form({ model: EIGHT_API_C5_MODEL, duration: 9, referenceImageUrls: JSON.stringify(refs),
    prompt: '保持@图片1角色甲，参考@image_file_2场景乙，以及@图3原始标记。' })
  assert.equal(request.headers['Content-Type'], 'application/json')
  assert.equal(request.headers.Authorization, 'Bearer local-test-key')
  assert.equal(request.body instanceof FormData, false)
  assert.deepEqual(request.body, { model: EIGHT_API_C5_MODEL,
    prompt: '保持@图1 角色甲，参考@图2 场景乙，以及@图3 原始标记。',
    duration: 9, ratio: '16:9', resolution: '720p', images: refs })
  assert.equal(request.body.functionMode, undefined)
  assert.equal(request.body.image_file_1, undefined)
  const fallback = adapter.buildGenerateRequest({ ...config, model: '' }, record())
  assert.equal(fallback.body.model, EIGHT_API_C5_MODEL)
  assert.equal(fallback.body.duration, 5)
})

test('C5 rejects inline or local images, unsupported inputs and more than nine references', () => {
  const c5 = (fields: Partial<VideoGenerationRecord> = {}) => form({ model: EIGHT_API_C5_MODEL, ...fields })
  const nine = c5({ referenceImageUrls: JSON.stringify(Array(9).fill('https://example.invalid/a.png')), prompt: '@图9。' })
  assert.equal(nine.body.images.length, 9)
  assert.throws(() => c5({ referenceImageUrls: JSON.stringify(Array(10).fill('https://example.invalid/a.png')) }), /9 张/)
  for (const value of [dataUri, 'static/local.png', 'http://example.invalid/a.png', 'file:///local.png']) {
    assert.throws(() => c5({ referenceImageUrls: JSON.stringify([value]) }), /HTTPS 公网地址/)
  }
  assert.throws(() => c5({ referenceAudioUrls: '["https://example.invalid/a.mp3"]' }), /不支持参考视频或音频/)
  assert.throws(() => c5({ referenceVideoUrls: '["https://example.invalid/a.mp4"]' }), /不支持参考视频或音频/)
  for (const fields of [{ firstFrameUrl: dataUri }, { lastFrameUrl: dataUri }, { imageUrl: dataUri },
    { referenceFileUrl: 'https://example.invalid/file' }, { referenceLinkUrl: 'https://example.invalid/link' }]) {
    assert.throws(() => c5(fields), /暂不支持首尾帧/)
  }
})

test('creation preserves IDs and does not treat queued URLs as a completed video', () => {
  assert.deepEqual(adapter.parseGenerateResponse({ task_id: 'created-id', status: 'pending' }), { isAsync: true, taskId: 'created-id' })
  assert.deepEqual(adapter.parseGenerateResponse({ data: { id: 'wrapped-id', status: 'queued' } }), { isAsync: true, taskId: 'wrapped-id' })
  assert.deepEqual(adapter.parseGenerateResponse({ id: 'queued-id', status: 'queued', url: 'https://example.invalid/content' }), { isAsync: true, taskId: 'queued-id' })
  assert.deepEqual(adapter.parseGenerateResponse({ id: 'content-id', status: 'completed' }), { isAsync: true, taskId: 'content-id' })
  assert.deepEqual(adapter.parseGenerateResponse({ id: 'failed-id', status: 'failed' }), { isAsync: true, taskId: 'failed-id' })
  const sync = adapter.parseGenerateResponse({ id: 'sync-id', status: 'completed', url: 'https://example.invalid/video.mp4', duration: 15 })
  assert.equal(sync.isAsync, false)
  assert.equal(sync.taskId, 'sync-id')
  assert.equal(sync.videoUrl, 'https://example.invalid/video.mp4')
  assert.equal(sync.duration, 15)
  assert.throws(() => adapter.parseGenerateResponse({ status: 'queued' }), /No task_id/)
  assert.throws(() => adapter.parseGenerateResponse({ id: Number.MAX_SAFE_INTEGER + 1, status: 'queued' }), /No task_id/)
})

test('polling endpoint encodes the ID once and does not repeat the v1 prefix', () => {
  const request = adapter.buildPollRequest({ ...config, baseUrl: 'https://888api.xin/v1/' }, 'task/a?x=1#suffix')
  assert.equal(request.method, 'GET')
  assert.equal(request.url, 'https://888api.xin/v1/videos/task%2Fa%3Fx%3D1%23suffix')
  assert.equal(request.headers.Authorization, 'Bearer local-test-key')
  assert.equal(request.body, undefined)
})

test('polling understands terminal and pending states, nested URLs and content fallback', () => {
  const url = 'https://example.invalid/video.mp4'
  for (const payload of [
    { status: 'completed', url, duration: 15 },
    { status: 'succeeded', result: { url }, seconds: '15' },
    { task_status: 'SUCCESS', task_result: { videos: [{ url }] } },
    { data: { status: 'completed', result_url: url } },
  ]) {
    const parsed = adapter.parsePollResponse(payload)
    assert.equal(parsed.status, 'completed')
    assert.equal(parsed.videoUrl, url)
    assert.equal(parsed.needsContentDownload, undefined)
    assert.equal(adapter.extractVideoUrl(payload), url)
  }
  assert.equal(adapter.parsePollResponse({ status: 'completed', url: 'javascript:invalid' }).needsContentDownload, true)
  assert.equal(adapter.parsePollResponse({ status: 'completed' }).needsContentDownload, true)
  assert.equal(adapter.parsePollResponse({ status: 'in_progress', url }).status, 'processing')
  assert.equal(adapter.parsePollResponse({ status: 'queued' }).status, 'pending')
  assert.equal(adapter.parsePollResponse({ task_status: 'SUBMITTED' }).status, 'pending')
  for (const status of ['failed', 'FAILURE', 'cancelled', 'canceled', 'rejected']) {
    const parsed = adapter.parsePollResponse({ status, error: { message: 'local rejection' }, url })
    assert.equal(parsed.status, 'failed')
    assert.equal(parsed.error, 'local rejection')
    assert.equal(parsed.videoUrl, undefined)
  }
})
