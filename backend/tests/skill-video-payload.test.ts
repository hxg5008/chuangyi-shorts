import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { splitQuotedText } from '../src/utils/quoted-text.ts'
import { EightApiVideoAdapter, EIGHT_API_C5_MODEL, EIGHT_API_FAST_VIP_MODEL } from '../src/services/adapters/eight-api-video.ts'
import * as frontend from '../../frontend/app/utils/api888-video.js'
import { splitQuotedText as frontendSegments } from '../../frontend/app/utils/quoted-text.js'

// Every writable path is disposable, and every outbound fetch below is intercepted.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-skill-video-payload-'))
process.env.SQLITE_PATH = path.join(directory, 'payload.sqlite3')
process.env.HUOBAO_DATA_DIR = directory
process.env.STORAGE_PATH = path.join(directory, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.PUBLIC_BASE_URL = ''
const { db, schema } = await import('../src/db/index.ts')
const { createStoryboardSession } = await import('../src/services/storyboard-session.ts')
const { resolveVoiceMentions, resolveStoryboardVoiceReferences } = await import('../src/services/character-voice-references.ts')
const { default: tasks } = await import('../src/routes/tasks.ts')
const timestamps = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
const baseUrl = 'https://offline-seedance.example.test'
const imageUrls = ['https://offline-assets.example.test/scene.png', 'https://offline-assets.example.test/actor.png', 'https://offline-assets.example.test/prop.png']
const nativeFetch = globalThis.fetch
const originalLog = console.log, originalError = console.error
console.log = () => {}
console.error = () => {}
const calls: Array<{ method: string; url: string }> = []
const submitted: any[] = []
globalThis.fetch = (async (input, init) => {
  const url = String(input), method = init?.method || 'GET'
  calls.push({ method, url })
  if (method === 'GET' && imageUrls.includes(url)) {
    assert.equal(new Headers(init?.headers).get('authorization'), null)
    return new Response(new Uint8Array([0x89]), { status: 206, headers: { 'Content-Type': 'image/png' } })
  }
  assert.equal(method, 'POST', 'This test never polls or downloads a real video')
  assert.equal(url, `${baseUrl}/v1/videos`)
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer offline-placeholder')
  submitted.push(JSON.parse(String(init?.body)))
  return Response.json({ error: { message: 'offline capture complete; no video generated' } }, { status: 400 })
}) as typeof fetch
after(async () => {
  globalThis.fetch = nativeFetch
  console.log = originalLog; console.error = originalError
  db.$client.close()
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(directory).startsWith('huobao-skill-video-payload-'))
  await fs.rm(directory, { recursive: true, force: true })
})
const config = db.insert(schema.aiServiceConfigs).values({ serviceType: 'video', provider: '888api', name: 'offline C5',
  baseUrl, apiKey: 'offline-placeholder', model: JSON.stringify([EIGHT_API_C5_MODEL]), ...timestamps }).returning().get()
const style = 'Preserved offline visual style'
db.insert(schema.stylePresets).values({ name: 'Offline style', value: 'offline-payload', prompt: style, ...timestamps }).run()

test('quote boundaries match in both builds without swallowing contractions, possessives or leading apostrophes', () => {
  const prose = [
    "Don't rewrite @阿甲. James' @院落 remains visible.", "'tis @阿甲 in the '80s near @院落.",
    '阿甲说：「原词@图99和#未知，内层「@阿甲」也保留。」随后@院落。',
    '阿甲说：「未闭合@图99和#未知', "阿甲说：'Don\\'t change @图99 or #未知.'随后@阿甲。",
  ]
  for (const value of prose) {
    assert.deepEqual(frontendSegments(value), splitQuotedText(value))
    assert.equal(splitQuotedText(value).map(segment => segment.text).join(''), value)
  }
  assert.deepEqual(splitQuotedText(prose[0]), [{ text: prose[0], quoted: false }])
  assert.deepEqual(splitQuotedText(prose[1]), [{ text: prose[1], quoted: false }])
})

test('reference markers inside all six quotation styles remain original words through frontend and both adapters', () => {
  const refs = [{ url: imageUrls[0], names: ['院落'] }, { url: imageUrls[1], names: ['阿甲'] }]
  const original = '@阿甲 @图片99 @图98 @image_file_97 #未知 @音频9'
  const adapter = new EightApiVideoAdapter()
  for (const [open, close] of [['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’'], ['"', '"'], ["'", "'"]]) {
    const quoted = `${open}${original}${close}`
    for (const model of [EIGHT_API_C5_MODEL, EIGHT_API_FAST_VIP_MODEL]) {
      const source = `@阿甲在@院落，阿甲说：${quoted}`
      const converted = frontend.api888ReferencePrompt(source, refs, model)
      assert.ok(converted.includes(quoted))
      assert.equal(frontend.validateApi888Video({ model, duration: model === EIGHT_API_FAST_VIP_MODEL ? 15 : 8, aspectRatio: '9:16', imageCount: 2, prompt: source }), null)
      const request = adapter.buildGenerateRequest({ provider: '888api', baseUrl, apiKey: 'offline-placeholder', model }, {
        id: 1, prompt: converted, duration: model === EIGHT_API_FAST_VIP_MODEL ? 15 : 8,
        referenceImageUrls: JSON.stringify(refs.map(ref => ref.url)),
      })
      const finalPrompt = request.body instanceof FormData ? String(request.body.get('prompt')) : request.body.prompt
      assert.ok(finalPrompt.includes(quoted))
      assert.match(finalPrompt, model === EIGHT_API_C5_MODEL ? /@图2 阿甲在@图1 院落/ : /@image_file_2 阿甲在@image_file_1 院落/)
    }
  }
  assert.throws(() => adapter.buildGenerateRequest({ provider: '888api', baseUrl, apiKey: 'offline-placeholder', model: EIGHT_API_C5_MODEL }, {
    id: 1, prompt: '引号外仍校验@图99。', referenceImageUrls: JSON.stringify([imageUrls[0]]),
  }), /参考图序号/)
  assert.equal(frontend.validateApi888Video({ model: EIGHT_API_C5_MODEL, duration: 8, aspectRatio: '9:16', imageCount: 2,
    prompt: '阿甲说：「原词#未知。」引号外#阿甲音色。' })?.key, 'episode.vid.api888ImageOnly')
})

test('voice references are resolved outside quotes while quoted hashes do not trigger lookups or alter original words', async () => {
  const original = '阿甲说：「#阿甲音色、#未知和@图99都只是原词。」'
  assert.deepEqual(await resolveStoryboardVoiceReferences(original, undefined, []), { prompt: original, audioUrls: [], hasVoiceReferences: false })
  const resolved = resolveVoiceMentions(`#阿甲低声开口。${original}`, [{ name: '阿甲', voiceAudioUrl: 'https://offline-assets.example.test/voice.wav' }])
  assert.equal(resolved.prompt, `阿甲（音色参考音频1）低声开口。${original}`)
  assert.deepEqual(resolved.audioUrls, ['https://offline-assets.example.test/voice.wav'])
  assert.throws(() => resolveVoiceMentions(`${original}引号外#未知。`, []), /音色引用.*无效/)
  await assert.rejects(resolveStoryboardVoiceReferences(`${original}引号外#阿甲。`, undefined, []), /必须指定当前分镜/)
})

test('skill-content persistence through actual task generation keeps long prose, quoted originals, image order and exact 8/10/13 second JSON parameters', async () => {
  const speech = '别改@阿甲、@图99和#未知。'
  for (const [duration, mapping] of [[8, [1, 2]], [10, [2, 2]], [13, [2, 1, 2]]] as const) {
    const drama = db.insert(schema.dramas).values({ title: `Offline ${duration}s`, style: 'offline-payload', ...timestamps }).returning().get()
    const script = `动作：${'静'.repeat(Math.round(duration / 0.12) - 20)}\n阿甲：${speech}`
    const episode = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: 'Offline payload', scriptContent: script,
      videoConfigId: config.id, resolution: '480p', ...timestamps }).returning().get()
    const character = db.insert(schema.characters).values({ dramaId: drama.id, name: '阿甲', imageUrl: imageUrls[1], ...timestamps }).returning().get()
    const scene = db.insert(schema.scenes).values({ dramaId: drama.id, location: '院落', time: '日', prompt: '既有院落', imageUrl: imageUrls[0], ...timestamps }).returning().get()
    const prop = db.insert(schema.props).values({ dramaId: drama.id, name: '木牌', imageUrl: imageUrls[2], ...timestamps }).returning().get()
    const longDetails = '既有坐标与持物状态持续承接，原有光线方向连续，动作准备过程和结果仍按原文保留。'.repeat(13)
    const videoPrompt = [
      '出场人物：@阿甲；场景：@院落；道具：@木牌。无字幕、无背景音乐，保留对白和必要音效。',
      ...Array.from({ length: Math.ceil(duration / 3) }, (_, index) => `${index * 3}-${Math.min((index + 1) * 3, duration)}秒：` +
        (index === 0 ? `门槛为A0，X向东，Y向北。@阿甲站在@院落，阿甲说：「${speech}」` : '@木牌仍在原有位置，@阿甲自然呼吸。') + longDetails +
        (index === Math.ceil(duration / 3) - 1 ? '末行尾端保真标记。' : '')),
    ].join('\n')
    assert.ok(videoPrompt.length > 1500 && videoPrompt.length < 3600)
    const candidate = { shot_number: 1, title: '原始标题', time: '日', location: '@院落', shot_type: '中景与近景', angle: '平视', movement: '固定',
      description: mapping.map((_, index) => `【镜头${index + 1}】@阿甲承接原有行动。${index === 0 ? `阿甲说：「${speech}」` : '@木牌保持原态。'}`).join(''),
      result: '@阿甲与@木牌保留原有末态。', atmosphere: '既有晨光保持原方向。', image_prompt: '@院落内@阿甲与@木牌保留原始首帧。',
      video_prompt: videoPrompt, bgm_prompt: '无背景音乐', sound_effect: '原有环境声', duration, scene_id: scene.id,
      character_ids: [character.id], prop_ids: [prop.id], source_ids: [1, 2], time_row_counts: [...mapping] }
    const session = createStoryboardSession({ mode: 'breakdown', episodeId: episode.id, dramaId: drama.id, validationProfile: 'skill-content' })
    const staged = session.stageSave([candidate], { replaceExisting: true, isFinalBatch: true })
    assert.equal('error' in staged, false, JSON.stringify(staged.issues))
    const committed = await session.finish()
    assert.equal(committed.saved, 1, JSON.stringify(committed.issues))
    const stored = db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episode.id)).get()!
    assert.equal(stored.videoPrompt, videoPrompt, 'Persistence must never render an old slot plan over natural prose')
    const refs = frontend.collectVideoImageReferences(scene, [character], [prop])
    assert.deepEqual(refs.map(ref => ref.url), imageUrls)
    const transportPrompt = frontend.api888ReferencePrompt(stored.videoPrompt, refs, EIGHT_API_C5_MODEL)
    const before = submitted.length
    const response = await tasks.request('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      type: 'video', storyboard_id: stored.id, drama_id: drama.id, config_id: config.id, model: EIGHT_API_C5_MODEL,
      prompt: transportPrompt, duration: stored.duration, aspect_ratio: '9:16', resolution: '720p', reference_image_urls: refs.map(ref => ref.url),
    }) })
    const data = await response.json() as any
    assert.equal(response.status, 201, JSON.stringify(data))
    const id = data.data.id, deadline = Date.now() + 5000
    let task = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()!
    while (task.status !== 'failed' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5))
      task = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()!
    }
    assert.equal(task.status, 'failed', 'The deterministic mock stop must drain the background job')
    assert.equal(submitted.length, before + 1)
    assert.deepEqual(submitted[before], { model: EIGHT_API_C5_MODEL, prompt: `${style}，\n${transportPrompt}`,
      duration, ratio: '9:16', resolution: '720p', images: imageUrls })
    assert.equal(task.prompt, `${style}，\n${transportPrompt}`)
    assert.ok(task.prompt!.includes(`「${speech}」`))
    assert.ok(task.prompt!.endsWith('末行尾端保真标记。'))
    const params = JSON.parse(task.params!)
    assert.equal(params.duration, duration)
    assert.deepEqual(params.referenceImageUrls, imageUrls)
    assert.equal(params.generateAudio, undefined)
    assert.equal(params.audioControl, 'provider_default')
    assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, stored.id)).get()!.videoPrompt, videoPrompt)
  }
  assert.equal(calls.filter(call => call.method === 'POST').length, 3)
})
