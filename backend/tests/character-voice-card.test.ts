import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Agent } from '@mastra/core/agent'
import { createOpenAI } from '@ai-sdk/openai'

// Voice cards (声线卡), 2026-11-06: one fixed voice per character, identical in every episode.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-voice-card-'))
process.env.SQLITE_PATH = path.join(directory, 'voice-card.sqlite3')
process.env.HUOBAO_DATA_DIR = directory
process.env.STORAGE_PATH = path.join(directory, 'static')
process.env.WORKSPACE_PATH = path.join(directory, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.ts')
const fixtureOwner=await (await import('./helpers/platform-fixture.ts')).platformFixtureOwner()
const { createStoryboardSession } = await import('../src/services/storyboard-session.ts')
const { StoryboardDraftStore } = await import('../src/services/storyboard-draft-store.ts')
const { runSkillStoryboardWorkflow } = await import('../src/services/skill-storyboard-workflow.ts')
const { buildAgentRequestContext } = await import('../src/agents/context.ts')
const card = await import('../src/services/character-voice-card.ts')
const { extractTools } = await import('../src/agents/tools/extract-tools.ts')
const store = new StoryboardDraftStore(db.$client)
const { eq } = await import('drizzle-orm')
const eqId = (id: number) => eq(schema.characters.id, id)
const timestamps = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
after(async () => { db.$client.close(); await fs.rm(directory, { recursive: true, force: true }) })

const fixedA = { age: '三十岁上下北方汉子', register: '中低音区', timbre: '粗粝沉实' }

test('the card keeps the skill\'s 15–30 character fixed voice and plain guidance; malformed cards are rejected, not stored', () => {
  assert.equal(card.fixedVoiceText(fixedA), '三十岁上下北方汉子、中低音区、粗粝沉实')
  const ok = card.serializeVoiceCard({ fixed: fixedA, guidance: '平时语速稳、音量不高；冲突时不喊叫，只放慢语速、加重咬字。' })
  assert.ok(ok.value && !ok.error)
  assert.deepEqual(card.parseVoiceCard(ok.value)!.fixed, fixedA)
  assert.ok(card.serializeVoiceCard({ fixed: { age: '男', register: '低', timbre: '沉' } }).error, 'shorter than 15 characters')
  assert.ok(card.serializeVoiceCard({ fixed: { ...fixedA, timbre: '粗粝沉实粗粝沉实粗粝沉实粗粝沉实' } }).error, 'longer than 30 characters')
  assert.ok(card.serializeVoiceCard({ fixed: fixedA, guidance: '他说：「走」' }).error, 'no quoted speech in guidance')
  assert.equal(card.parseVoiceCard('not json'), null)
  assert.deepEqual(card.serializeVoiceCard(null), { value: null })
})

test('extraction writes a card only for characters without one and never overwrites an existing card', async () => {
  const drama = db.insert(schema.dramas).values({ ownerUserId:fixtureOwner.id, title: 'cards', ...timestamps }).returning().get()
  const episode = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: 'E', scriptContent: '高大山：走。', ...timestamps }).returning().get()
  const kept = JSON.stringify({ fixed: { age: '三十岁上下汉子', register: '低沉中音域', timbre: '厚实带沙' }, guidance: '用户手改', linked_character_id: null })
  db.insert(schema.characters).values({ dramaId: drama.id, name: '高大山', voiceCard: kept, ...timestamps }).run()
  const requestContext = buildAgentRequestContext({ episodeId: episode.id, dramaId: drama.id, language: 'zh' })
  const result: any = await (extractTools.saveDedupCharacters as any).execute({ characters: [
    { name: '高大山', voice_card: { fixed: fixedA, guidance: '模型新写' } },
    { name: '老年高大山', voice_card: { fixed: { age: '六十余岁病中老人', register: '低沉沙哑中低音', timbre: '粗粝沉实' }, guidance: '气息短', linked_character_name: '高大山' } },
    { name: '秦翠花', voice_card: { fixed: { age: '五', register: '高', timbre: '尖' } } },
  ] }, { requestContext })
  const rows = db.select().from(schema.characters).all().filter((row: any) => row.dramaId === drama.id)
  const young = rows.find((row: any) => row.name === '高大山')!, old = rows.find((row: any) => row.name === '老年高大山')!
  assert.equal(young.voiceCard, kept, 'an existing card (user edit) is never overwritten by extraction')
  assert.equal(card.parseVoiceCard(old.voiceCard)!.linked_character_id, young.id, 'the aged version links to the young character')
  assert.equal(rows.find((row: any) => row.name === '秦翠花')!.voiceCard, null, 'a malformed card is not stored')
  assert.equal(result.voice_cards, 1)
  assert.equal(result.voice_card_rejected.length, 1)
})

// Workflow: two separate episodes of one project, generated independently, use the card's fixed voice verbatim.
const sse = (content: string) => {
  const encoder = new TextEncoder(), chunk = (delta: object, finish: string | null = null) => ({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'offline', choices: [{ index: 0, delta, finish_reason: finish }] })
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ role: 'assistant', content }))}\n\n`))
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ...chunk({}, 'stop'), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`))
    controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close()
  } }), { headers: { 'Content-Type': 'text/event-stream' } })
}
let counter = 0
const padding = (n: number) => `动作：${'院中晨光照进来，衣袖随着脚步自然轻摆。'.repeat(n)}`

test('two episodes generated separately use the same fixed voice from the card; a model re-wording is unified, delivery stays per line', async () => {
  const drama = db.insert(schema.dramas).values({ ownerUserId:fixtureOwner.id, title: 'series', ...timestamps }).returning().get()
  const hero = db.insert(schema.characters).values({ dramaId: drama.id, name: '阿甲', voiceCard: card.serializeVoiceCard({ fixed: fixedA, guidance: '平时语速稳；冲突时放慢、加重咬字。' }).value, ...timestamps }).returning().get()
  const scene = db.insert(schema.scenes).values({ dramaId: drama.id, location: '院落', time: '日', prompt: '院落', ...timestamps }).returning().get()
  const committed: string[] = []
  for (const [index, wording] of [fixedA, { age: '三十来岁男人', register: '低音区', timbre: '沙哑浑厚有力' }].entries()) {
    const script = `${padding(4)}\n阿甲：回来，一起走。`
    const episode = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: index + 1, title: `E${index + 1}`, scriptContent: script, ...timestamps }).returning().get()
    const seen: any[] = []
    const dependencies = { store, modelIdentity: { provider: 'openai', model: 'deepseek-v4.1-flash' }, batchSize: 1, modelLimits: { maxOutputTokens: 16_384 }, recoveryDelayMs: 0, requestTimeoutMs: 60_000,
      readContext: async () => ({ episode: { id: episode.id, title: 'E' }, script,
        characters: [{ id: hero.id, name: hero.name, voice_card: card.parseVoiceCard(hero.voiceCard) }], scenes: [{ id: scene.id, location: scene.location }], props: [], existing_storyboards: [] }),
      loadInstructions: async () => ({ plan: 'P', expand: 'E', prompt: 'V' }),
      createAgent: (stage: string, instructions: string) => {
        const provider = createOpenAI({ apiKey: 'offline', baseURL: 'https://example.invalid/v1', fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body))
          const message = body.messages.filter((entry: any) => entry.role === 'user').at(-1)
          const payload = JSON.parse(typeof message.content === 'string' ? message.content : message.content.map((part: any) => part.text || '').join(''))
          seen.push({ stage, payload, instructions })
          if (stage === 'plan') return sse(JSON.stringify({ output: { groups: [{ number: 1, title: '一', beat: 'narrative', source_ids: [1, 2], scene_id: scene.id, duration: 10 }] } }))
          const c = `[[character:${hero.id}]]`, s = `[[scene:${scene.id}]]`
          return sse(JSON.stringify({ output: { shot_number: 1, title: '一', time: '日', location: `${s}院落。`, shot_type: '中景', angle: '平视', movement: '固定',
            description: `【镜头1】${c}站在原处，[[voice:v1]]：「回来，一起走。」【镜头2】${c}保持原位。`, result: `${c}停在原处。`, atmosphere: '日光。', image_prompt: `${s}首镜。`,
            video_prompt: `出场人物：${c}；场景：${s}。无字幕、无背景音乐。\n0-3秒：${s}以门槛为原点A0，X轴向东，Y轴向北；${c}站在原处，[[voice:v1]]：「回来，一起走。」\n3-6秒：${c}站在原处。\n6-9秒：${c}保持原位。\n9-10秒：${c}停住。`,
            bgm_prompt: '无背景音乐', sound_effect: '环境声。', duration: 10, scene_id: scene.id, character_ids: [hero.id], prop_ids: [], source_ids: [1, 2], time_row_counts: [2, 2],
            voice_cues: [{ id: 'v1', shot: 1, speaker_id: hero.id, kind: 'dialogue', source_name: '', profile: wording, state: '站在原处', goal: '叫对方回来', volume: '适中', rate_cps: 3, breath: '平稳', tail: '轻收', emotion: index ? '急切' : '平静' }] } }))
        } })
        return new Agent({ id: `card-${++counter}`, name: 'card', instructions, model: provider.chat('offline'), tools: {}, maxRetries: 0 })
      } }
    const session = createStoryboardSession({ mode: 'breakdown', episodeId: episode.id, dramaId: drama.id, validationProfile: 'skill-content' })
    const requestContext = buildAgentRequestContext({ episodeId: episode.id, dramaId: drama.id, language: 'zh' })
    requestContext.set('storyboardSession' as never, session as never)
    const result = await runSkillStoryboardWorkflow({ episodeId: episode.id, dramaId: drama.id, mode: 'breakdown', session, requestContext, message: '按原skill完整生成。' } as any, dependencies as any)
    assert.equal(result.status, 'done', JSON.stringify(result.issues))
    const expand = seen.find(call => call.stage === 'expand')
    assert.deepEqual(expand.payload.voice_profiles[`character:${hero.id}`], fixedA, 'the card seeds the fixed voice before any group exists')
    assert.equal(expand.payload.voice_cards[0].fixed_voice, card.fixedVoiceText(fixedA))
    assert.ok(expand.instructions.includes('声线卡'), 'the model is told to copy the fixed voice verbatim')
    committed.push(db.select().from(schema.storyboards).all().find((row: any) => row.episodeId === episode.id)!.videoPrompt!)
  }
  for (const prompt of committed) assert.ok(prompt.includes(card.fixedVoiceText(fixedA)), 'both episodes carry the identical fixed voice')
  assert.equal(committed[1].includes('沙哑浑厚有力'), false, 'the re-worded voice never reaches the committed prompt')
  assert.ok(committed[0].includes('情绪平静') && committed[1].includes('情绪急切'), 'emotion still differs per line')
})

test('a project without voice cards sends exactly the same context as before (drafts stay resumable)', async () => {
  const facts = card.voiceCardFacts([{ id: 1, name: '阿甲' }, { id: 2, name: '阿乙', voice_card: null }])
  assert.deepEqual(facts, [])
  assert.deepEqual(card.voiceCardProfiles([{ id: 1 }, { id: 2, voiceCard: '' }]), {})
})

test('filling cards writes only voice cards: no new characters, no other field changed, existing cards kept', async () => {
  const drama = db.insert(schema.dramas).values({ ownerUserId:fixtureOwner.id, title: 'fill', ...timestamps }).returning().get()
  const episode = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: 'E', scriptContent: '阿甲：走。', ...timestamps }).returning().get()
  const other = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 2, title: 'F', scriptContent: '阿丙：嗯。', ...timestamps }).returning().get()
  const a = db.insert(schema.characters).values({ dramaId: drama.id, name: '阿甲', appearance: '原样貌', styling: '原妆造', ...timestamps }).returning().get()
  const keep = JSON.stringify({ fixed: fixedA, guidance: '已有', linked_character_id: null, origin: 'manual' })
  const b = db.insert(schema.characters).values({ dramaId: drama.id, name: '阿乙', voiceCard: keep, ...timestamps }).returning().get()
  const c = db.insert(schema.characters).values({ dramaId: drama.id, name: '阿丙', ...timestamps }).returning().get()
  for (const id of [a.id, b.id]) db.insert(schema.episodeCharacters).values({ episodeId: episode.id, characterId: id, createdAt: timestamps.createdAt }).run()
  db.insert(schema.episodeCharacters).values({ episodeId: other.id, characterId: c.id, createdAt: timestamps.createdAt }).run()
  const before = db.select().from(schema.characters).all().filter((row: any) => row.dramaId === drama.id).length
  const requestContext = buildAgentRequestContext({ episodeId: episode.id, dramaId: drama.id, language: 'zh' })
  const result: any = await (extractTools.saveVoiceCards as any).execute({ cards: [
    { character_id: a.id, fixed: fixedA, guidance: '平时语速稳。' },
    { character_id: b.id, fixed: { age: '二十岁上下年轻女子', register: '中高音区', timbre: '清亮' } },
    { character_id: c.id, fixed: fixedA },
  ] }, { requestContext })
  const rows = db.select().from(schema.characters).all().filter((row: any) => row.dramaId === drama.id)
  assert.equal(rows.length, before, 'no character created')
  const savedA = rows.find((row: any) => row.id === a.id)!
  assert.equal(savedA.appearance, '原样貌'); assert.equal(savedA.styling, '原妆造'); assert.equal(savedA.name, '阿甲')
  assert.deepEqual(card.parseVoiceCard(savedA.voiceCard)!.fixed, fixedA)
  assert.equal(rows.find((row: any) => row.id === b.id)!.voiceCard, keep, 'an existing card is kept')
  assert.equal(rows.find((row: any) => row.id === c.id)!.voiceCard, null, 'a character of another episode is not touched')
  assert.equal(result.voice_cards, 1)
})

test('age variants: the aged card links to the young person and shares its core timbre; a manual card is never changed', async () => {
  const { alignVoiceCardVariants } = await import('../src/services/character-voice-card-align.ts')
  const drama = db.insert(schema.dramas).values({ ownerUserId:fixtureOwner.id, title: 'align', ...timestamps }).returning().get()
  const youngCard = { fixed: fixedA, guidance: '稳', linked_character_id: null as number | null, origin: 'auto' }
  const young = db.insert(schema.characters).values({ dramaId: drama.id, name: '高大山', voiceCard: JSON.stringify(youngCard), ...timestamps }).returning().get()
  // Real copy-run shape: the aged card has its own timbre, and the young card points at the aged one.
  const old = db.insert(schema.characters).values({ dramaId: drama.id, name: '老年高大山', voiceCard: JSON.stringify({ fixed: { age: '七十岁上下病重老者', register: '低沉沙哑低音区', timbre: '气声粗涩带痰音' }, guidance: '气息短', linked_character_id: young.id, origin: 'auto' }), ...timestamps }).returning().get()
  db.update(schema.characters).set({ voiceCard: JSON.stringify({ ...youngCard, linked_character_id: old.id }) }).where(eqId(young.id)).run()
  const manual = db.insert(schema.characters).values({ dramaId: drama.id, name: '张晓茹', voiceCard: JSON.stringify({ fixed: { age: '二十出头北方年轻女性', register: '中音区偏细', timbre: '清冷微哑' }, guidance: '', linked_character_id: null, origin: 'auto' }), ...timestamps }).returning().get()
  const manualOld = JSON.stringify({ fixed: { age: '六十多岁老年女性', register: '中低音区', timbre: '平缓清冷略干' }, guidance: '用户手改', linked_character_id: null, origin: 'manual' })
  db.insert(schema.characters).values({ dramaId: drama.id, name: '老年张晓茹', voiceCard: manualOld, ...timestamps }).run()
  const changes = await alignVoiceCardVariants(drama.id)
  const rows = db.select().from(schema.characters).all().filter((row: any) => row.dramaId === drama.id)
  const oldCard = card.parseVoiceCard(rows.find((row: any) => row.id === old.id)!.voiceCard)!
  assert.equal(oldCard.fixed.timbre, fixedA.timbre, 'the aged version shares the young core timbre')
  assert.equal(oldCard.fixed.age, '七十岁上下病重老者', 'age feel stays its own')
  assert.equal(oldCard.linked_character_id, young.id)
  assert.equal(card.parseVoiceCard(rows.find((row: any) => row.id === young.id)!.voiceCard)!.linked_character_id, null, 'the young person is the reference')
  const manualRow = rows.find((row: any) => row.name === '老年张晓茹')!
  const manualCard = card.parseVoiceCard(manualRow.voiceCard)!
  assert.equal(manualCard.fixed.timbre, '平缓清冷略干', 'a manual card keeps its wording')
  assert.equal(manualCard.linked_character_id, manual.id, 'but is linked so the model knows it is the same person')
  assert.ok(changes.length >= 2)
})
