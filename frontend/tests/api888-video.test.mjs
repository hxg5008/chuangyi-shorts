import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { parse, compileScript } from '@vue/compiler-sfc'
import ts from 'typescript'
import * as vue from 'vue'
import * as api888 from '../app/utils/api888-video.js'
import * as jimengLocal from '../app/utils/jimeng-local-video.js'

test('888API defaults to the explicit C5 JSON channel while retaining the three VIP upload channels', () => {
  const [c5, fast, vip, mini] = api888.API888_VIDEO_MODELS
  assert.equal(api888.API888_VIDEO_PRESET.baseUrl, 'https://888api.xin')
  assert.equal(c5, 'seedance2.0-933-c5-fast')
  const jsonChannel = api888.api888VideoCapability('888api', c5)
  assert.equal(jsonChannel.fixedDuration, null)
  assert.equal(jsonChannel.minDuration, 4)
  assert.equal(jsonChannel.maxDuration, 15)
  assert.equal(jsonChannel.maxImages, 9)
  assert.equal(jsonChannel.publicReferences, true)
  assert.deepEqual(jsonChannel.resolutions, ['720p'])
  assert.equal(fast, 'jimeng-video-seedance-2.0-fast-vip')
  assert.equal(api888.api888VideoCapability('888api', fast).fixedDuration, 15)
  for (const model of [vip, mini]) {
    const capability = api888.api888VideoCapability('888api', model)
    assert.equal(capability.minDuration, 4)
    assert.equal(capability.maxDuration, 15)
    assert.deepEqual(capability.resolutions, ['720p'])
    assert.equal(capability.maxImages, 12)
  }
  assert.equal(api888.api888VideoCapability('888api', 'seedance2.0-fast-4img'), null)
  assert.equal(api888.api888VideoCapability('volcengine', fast), null)
})

test('reference numbering follows scene, characters and props, de-duplicates URLs and keeps names outside file tokens', () => {
  const refs = api888.collectVideoImageReferences({ location: '外屋', image_url: 'scene.png' }, [
    { name: '高大山', image_url: 'character.png' },
    { name: '高大山替身', image_url: 'character.png' },
  ], [{ name: '茶杯', image_url: 'prop.png' }])
  assert.deepEqual(refs.map(ref => ref.url), ['scene.png', 'character.png', 'prop.png'])
  const prompt = api888.api888ReferencePrompt('@外屋，@高大山替身端起@茶杯。 @图片2高大山 @图3', refs, 'jimeng-video-seedance-2.0-fast-vip')
  assert.match(prompt, /@image_file_1 外屋/)
  assert.match(prompt, /@image_file_2 高大山替身/)
  assert.match(prompt, /@image_file_3 茶杯/)
  assert.match(prompt, /@image_file_2 高大山/)
  assert.doesNotMatch(prompt, /@图片|@图\d|@image_file_\d[^\s]/)
})

test('validation stops unsupported timing, adaptive ratio, too many images and audio/video references without rewriting inputs', () => {
  const valid = { model: 'jimeng-video-seedance-2.0-fast-vip', duration: 15, aspectRatio: '16:9', imageCount: 12, prompt: '@高大山在外屋' }
  assert.equal(api888.validateApi888Video(valid), null)
  const oldShot = { ...valid, duration: 9 }
  assert.equal(api888.validateApi888Video(oldShot).key, 'episode.vid.api888FixedDuration')
  assert.equal(oldShot.duration, 9)
  assert.equal(api888.validateApi888Video({ ...valid, aspectRatio: 'adaptive' }).key, 'episode.vid.api888ConcreteRatio')
  assert.equal(api888.validateApi888Video({ ...valid, imageCount: 13 }).key, 'episode.vid.api888TooManyImages')
  for (const patch of [{ prompt: '#高大山说话' }, { prompt: '@音频1' }, { audioUrls: ['voice.mp3'] }, { videoUrls: ['ref.mp4'] }]) {
    assert.equal(api888.validateApi888Video({ ...valid, ...patch }).key, 'episode.vid.api888ImageOnly')
  }
  assert.equal(api888.validateApi888Video({ ...valid, model: 'jimeng-video-seedance-2.0-vip', duration: 4 }), null)
  assert.equal(api888.validateApi888Video({ ...valid, model: 'jimeng-video-seedance-2.0-mini', duration: 3 }).key, 'episode.vid.api888DurationRange')
  const c5 = { ...valid, model: 'seedance2.0-933-c5-fast', duration: 9, imageCount: 9 }
  assert.equal(api888.validateApi888Video(c5), null)
  assert.equal(api888.validateApi888Video({ ...c5, imageCount: 10 }).key, 'episode.vid.api888TooManyImages')
})

test('C5 @图 ordinals keep left/right names aligned with the same ordered reference images', () => {
  const refs = api888.collectVideoImageReferences({ location: '外屋', image_url: 'scene.png' }, [
    { name: '左侧人物', image_url: 'left.png' }, { name: '右侧人物', image_url: 'right.png' },
  ], [])
  const prompt = api888.api888ReferencePrompt('左侧的@左侧人物望向右侧的@右侧人物，保持@外屋。旧引用@image_file_2和@图片3。', refs, 'seedance2.0-933-c5-fast')
  assert.deepEqual(refs.map(ref => ref.url), ['scene.png', 'left.png', 'right.png'])
  assert.match(prompt, /左侧的@图2 左侧人物/)
  assert.match(prompt, /右侧的@图3 右侧人物/)
  assert.match(prompt, /@图1 外屋/)
  assert.doesNotMatch(prompt, /@image_file_|@图片/)
})

test('quoted source @ and # words survive all reference conversions and image-only validation', () => {
  const refs = api888.collectVideoImageReferences({ location: '外屋', image_url: 'scene.png' }, [{ name: '高大山', image_url: 'actor.png' }], [])
  for (const [open, close] of [['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’'], ['"', '"'], ["'", "'"]]) {
    const original = `${open}别改@高大山、@图片99、@图98、@image_file_97、#未知和@音频9。${close}`
    const source = `@高大山在@外屋。高大山说：${original}`
    const converted = api888.api888ReferencePrompt(source, refs)
    assert.ok(converted.includes(original), open)
    assert.match(converted, /@图2 高大山在@图1 外屋/)
    assert.equal(api888.validateApi888Video({ model: api888.API888_VIDEO_MODELS[0], duration: 8, aspectRatio: '9:16', imageCount: 2, prompt: source }), null)
  }
  const english = api888.api888ReferencePrompt("Don't alter @高大山. James' @外屋 stays. 'tis @高大山 in the '80s.", refs)
  assert.equal(english, "Don't alter @图2 高大山. James' @图1 外屋 stays. 'tis @图2 高大山 in the '80s.")
  const voiceOutside = api888.validateApi888Video({ model: api888.API888_VIDEO_MODELS[0], duration: 8, aspectRatio: '9:16', imageCount: 2, prompt: '高大山说：「#未知是原词。」引号外#高大山音色。' })
  assert.equal(voiceOutside.key, 'episode.vid.api888ImageOnly')
})

test('all locales explain channel limits without claiming every key can use every model', () => {
  for (const locale of ['zh', 'en', 'ja', 'ko']) {
    const messages = JSON.parse(readFileSync(new URL(`../app/locales/${locale}.json`, import.meta.url), 'utf8'))
    for (const key of ['api888FixedDuration', 'api888DurationRange', 'api888ConcreteRatio', 'api888ChooseRatio', 'api888TooManyImages', 'api888ImageOnly', 'api888UnsupportedModel', 'api888DurationUnit', 'api888Capabilities', 'api888PublicReferences']) assert.ok(messages.episode.vid[key], `${locale}: ${key}`)
    assert.match(messages.episode.vid.api888Capabilities, /\{maxImages\}/)
    assert.ok(messages.settings.cfg.api888ModelHint)
    if (locale === 'zh') assert.equal(messages.episode.vid.api888FixedDuration, '当前通道固定15秒，请先将分镜时长和提示词调整为15秒')
  }
})

test('retired AI settings keeps 888API available through central video-channel routing', () => {
  const legacy = readFileSync(new URL('../app/pages/settings.vue', import.meta.url), 'utf8')
  const channels = readFileSync(new URL('../app/pages/admin/channels.vue', import.meta.url), 'utf8')
  const protocols = readFileSync(new URL('../../backend/src/services/model-channels/protocols.ts', import.meta.url), 'utf8')
  assert.match(legacy, /legacySettingsDestination/)
  assert.doesNotMatch(legacy, /cfgForm|aiConfigAPI/)
  assert.match(channels, /modelForm\.protocol_id/)
  assert.match(protocols, /id: 'video\.888api'/)
  assert.match(protocols, /provider: '888api'/)
  assert.equal(api888.API888_VIDEO_PRESET.baseUrl, 'https://888api.xin')
  assert.equal(api888.API888_VIDEO_MODELS[0], 'seedance2.0-933-c5-fast')
  assert.equal(api888.api888VideoCapability('888api', api888.API888_VIDEO_MODELS[0]).publicReferences, true)
})
