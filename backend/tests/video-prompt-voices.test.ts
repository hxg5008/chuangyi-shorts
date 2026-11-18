import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-prompt-voices-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.WORKSPACE_PATH = path.join(root, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'
await fs.cp(new URL('../workspace/', import.meta.url), process.env.WORKSPACE_PATH, { recursive: true })
const { db, schema } = await import('../src/db/index.ts')
const { storyboardTools } = await import('../src/agents/tools/storyboard-tools.ts')
const { buildAgentRequestContext } = await import('../src/agents/context.ts')
const { agentRegistry, createStoryboardSegmentAgent } = await import('../src/agents/index.ts')
const { resolveStoryboardVoiceReferences } = await import('../src/services/character-voice-references.ts')
const { createStoryboardSession } = await import('../src/services/storyboard-session.ts')
const ts = '2026-01-01T00:00:00.000Z'
const timestamps = { createdAt: ts, updatedAt: ts }
const drama = db.insert(schema.dramas).values({ title: 'Prompt voices', ...timestamps }).returning().get()
const ep = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: 'Test', scriptContent: '林小雨说：「早上好。」陈默点头。', ...timestamps }).returning().get()
const createCharacter = (name: string, voice = true) => {
  const c = db.insert(schema.characters).values({ name, dramaId: drama.id, voiceAudioUrl: voice ? `static/uploads/private-${name}.wav` : null, ...timestamps }).returning().get()
  db.insert(schema.episodeCharacters).values({ episodeId: ep.id, characterId: c.id, createdAt: ts }).run()
  return c
}
const speaker = createCharacter('林小雨')
const silent = createCharacter('陈默')
const noVoice = createCharacter('小白', false)
const unbound = createCharacter('未出场')
const deleted = createCharacter('已删除')
db.update(schema.characters).set({ deletedAt: ts }).where(eq(schema.characters.id, deleted.id)).run()
const sb = db.insert(schema.storyboards).values({ episodeId: ep.id, storyboardNumber: 1,
  description: '【镜头1】林小雨正面中景，说：「早上好。」【镜头2】陈默正面近景，点头。', atmosphere: '晨光', duration: 9, videoPrompt: '原提示词', ...timestamps }).returning().get()
for (const c of [speaker, silent, noVoice]) db.insert(schema.storyboardCharacters).values({ storyboardId: sb.id, characterId: c.id }).run()
const requestContext = buildAgentRequestContext({ dramaId: drama.id, episodeId: ep.id })
const call = (name: keyof typeof storyboardTools, input: any, session?: ReturnType<typeof createStoryboardSession>) => {
  const rc = buildAgentRequestContext({ dramaId: drama.id, episodeId: ep.id })
  if (session) rc.set('storyboardSession' as never, session as never)
  return (storyboardTools[name].execute as any)(input, { requestContext: rc })
}
const row = () => db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id)).get()!
const promptSession = () => createStoryboardSession({ mode: 'prompt', dramaId: drama.id, episodeId: ep.id, storyboardIds: [sb.id] })
const headerRules = '无字幕、无背景音乐，保留对白和必要音效；同一现实空间每名人物唯一，不出现克隆人或复制人；不越轴，动作流畅，五官与眼神清晰。'
const voicedPrompt = () => `出场人物：@林小雨、@陈默；场景：室内。${headerRules}\n0-3秒：以桌边为原点A0，X轴向东为正，Y轴向北为正。@林小雨站在A(X+1米，Y+1米)，正面中景，平静（情绪60%），轻眨后抬头。#林小雨使用年轻女性中音、温润音色，约每秒2字，林小雨说：「早上好。」\n3-6秒：切到@陈默正面近景，平静（情绪65%），追视林小雨后点头，固定镜头保持。\n6-9秒：@陈默延续点头末态，左手放松，日光方向保持。`

test('prompt context exposes exact voice tokens and scopes each shot to bound, live characters', async () => {
  const context = await call('readStoryboardContext', {})
  assert.equal(context.characters.find((c: any) => c.id === speaker.id).voice_reference, '#林小雨')
  assert.equal(context.characters.find((c: any) => c.id === noVoice.id).has_voice, false)
  assert.equal(context.characters.find((c: any) => c.id === noVoice.id).voice_reference, null)
  assert.equal(context.characters.some((c: any) => c.id === deleted.id), false)
  assert.equal(context.characters.some((c: any) => c.id === unbound.id), true)
  const voices = context.existing_storyboards[0].available_voice_references
  assert.deepEqual(voices, [
    { character_id: speaker.id, name: speaker.name, voice_reference: '#林小雨' },
    { character_id: silent.id, name: silent.name, voice_reference: '#陈默' },
  ])
  assert.doesNotMatch(JSON.stringify(context), /static\/uploads|private-/)
})

test('single, batch and initial-breakdown agents get voice rules in every content language', async () => {
  for (const language of ['zh', 'en', 'ja', 'ko'] as const) {
    const rc = buildAgentRequestContext({ dramaId: drama.id, episodeId: ep.id, language })
    for (const type of ['prompt_generator', 'storyboard_breaker']) {
      const instructions = String(await agentRegistry[type].getInstructions({ requestContext: rc }))
      assert.match(instructions, /available_voice_references/)
      assert.match(instructions, /voice_reference/)
      assert.match(instructions, /#(?:林小雨|Alex|太郎|민수)/)
      if (language !== 'zh') assert.match(instructions, /copy the complete voice_reference value exactly/)
    }
  }
  const extractor = String(await agentRegistry.extractor.getInstructions({ requestContext }))
  assert.doesNotMatch(extractor, /available_voice_references/)
})

test('scheduled segment instructions load both filmmaking skills without the obsolete plan-copying tool protocol', async () => {
  const rc = buildAgentRequestContext({ dramaId: drama.id, episodeId: ep.id, language: 'zh' })
  const agent = createStoryboardSegmentAgent({}, '当前协议：只调用submitStoryboardSegment填写固定创作字段。')
  const instructions = String(await agent.getInstructions({ requestContext: rc }))
  assert.match(instructions, /## Skill: storyboard-breaker/)
  assert.match(instructions, /## Skill: prompt-generator\/video-prompt/)
  assert.match(instructions, /submitStoryboardSegment/)
  assert.doesNotMatch(instructions, /首轮生成方式（与已加载 skill 配合执行）/)
  assert.doesNotMatch(instructions, /source_line|fragment_index/)
})

test('custom and missing prompt templates retain the runtime voice rules', async () => {
  const file = path.join(process.env.WORKSPACE_PATH!, 'prompts/prompt_generator.md')
  const original = await fs.readFile(file, 'utf8')
  try {
    await fs.writeFile(file, '---\nname: Custom\nmodel: ""\n---\nCustom prompt sentinel.')
    const custom = String(await agentRegistry.prompt_generator.getInstructions({ requestContext }))
    assert.match(custom, /Custom prompt sentinel/)
    assert.match(custom, /available_voice_references/)
    await fs.rm(file)
    const fallback = String(await agentRegistry.prompt_generator.getInstructions({ requestContext }))
    assert.match(fallback, /available_voice_references/)
  } finally { await fs.writeFile(file, original) }
})

test('native instructions scope the first-pass plan to storyboard jobs without changing image-prompt sessions', async () => {
  for (const agent of [agentRegistry.storyboard_breaker, agentRegistry.prompt_generator]) {
    const rc = buildAgentRequestContext({ dramaId: drama.id, episodeId: ep.id })
    const normal = String(await agent.getInstructions({ requestContext: rc }))
    assert.doesNotMatch(normal, /本次保存工具的内部输入协议为 video_prompt_plan/)
    rc.set('storyboardSession' as never, {} as never)
    const guarded = String(await agent.getInstructions({ requestContext: rc }))
    assert.match(guarded, /本次保存工具的内部输入协议为 video_prompt_plan/)
    assert.match(guarded, /available_voice_references/)
    assert.match(guarded, /face_visible/)
    if (agent === agentRegistry.prompt_generator) {
      assert.match(guarded, /## Skill: prompt-generator\/video-prompt/)
      assert.doesNotMatch(guarded, /## Skill: prompt-generator\/(?:character-prompt|scene-prompt|prop-prompt)/)
    }
  }
})

test('a generated voice binding saves editable tokens and resolves to the corresponding video audio', async () => {
  const prompt = voicedPrompt()
  const session = promptSession()
  const before = row().videoPrompt
  const staged = await call('updateStoryboard', { storyboard_id: sb.id, video_prompt: prompt }, session)
  assert.equal(staged.staged, true)
  assert.equal(row().videoPrompt, before)
  assert.equal((await session.finish()).saved, 1)
  assert.equal(row().videoPrompt, prompt)
  assert.equal(row().description, sb.description)
  assert.equal(row().atmosphere, sb.atmosphere)
  assert.equal(row().duration, sb.duration)
  const resolved = await resolveStoryboardVoiceReferences(row().videoPrompt!, sb.id, [])
  assert.deepEqual(resolved.audioUrls, [speaker.voiceAudioUrl])
  assert.equal(resolved.prompt, prompt.replace('#林小雨', '林小雨（音色参考音频1）'))
  assert.doesNotMatch(resolved.prompt, /#林小雨/)
})

test('invented, unbound, removed and missing voice references cannot replace a saved prompt', async () => {
  const before = row().videoPrompt
  for (const name of ['虚构角色', unbound.name, noVoice.name, deleted.name]) {
    const session = promptSession()
    const result = await call('updateStoryboard', { storyboard_id: sb.id, video_prompt: voicedPrompt().replace('#林小雨', `#${name}`) }, session)
    assert.ok(result.issues.some((issue: any) => issue.code === 'voice_reference' && /音色/.test(issue.message)))
    assert.equal((await session.finish()).saved, 0)
    assert.equal(row().videoPrompt, before)
  }
  db.update(schema.characters).set({ voiceAudioUrl: null }).where(eq(schema.characters.id, speaker.id)).run()
  try {
    const context = await call('readStoryboardContext', {})
    assert.equal(context.existing_storyboards[0].available_voice_references.some((v: any) => v.character_id === speaker.id), false)
    const session = promptSession()
    const result = await call('updateStoryboard', { storyboard_id: sb.id, video_prompt: voicedPrompt() }, session)
    assert.ok(result.issues.some((issue: any) => issue.code === 'voice_reference' && /尚未上传/.test(issue.message)))
    assert.equal((await session.finish()).saved, 0)
    assert.equal(row().videoPrompt, before)
  } finally { db.update(schema.characters).set({ voiceAudioUrl: speaker.voiceAudioUrl }).where(eq(schema.characters.id, speaker.id)).run() }
})

test('initial breakdown validates voices before replacement and persists valid bindings', async () => {
  const before = row().videoPrompt
  const invalid = createStoryboardSession({ mode: 'breakdown', dramaId: drama.id, episodeId: ep.id })
  const rejected = await call('saveStoryboards', { replace_existing: true, is_final_batch: true, storyboards: [
    { shot_number: 1, character_ids: [speaker.id], video_prompt: '#虚构角色' },
  ] }, invalid)
  assert.ok(rejected.issues.some((issue: any) => issue.code === 'voice_reference'))
  assert.equal((await invalid.finish()).saved, 0)
  assert.equal(row().videoPrompt, before)
  const valid = createStoryboardSession({ mode: 'breakdown', dramaId: drama.id, episodeId: ep.id })
  const silentPrompt = `出场人物：@小白；场景：室内。${headerRules}\n0-3秒：以门槛为原点A0，X轴向东为正，Y轴向北为正。@小白正面中景站在A(X+1米，Y+1米)，平静（情绪60%），缓慢迈步。\n3-6秒：切到@小白正面近景，平静（情绪65%），轻眨后停步。\n6-9秒：@小白延续停步末态，左手自然放松。`
  await call('saveStoryboards', { replace_existing: true, is_final_batch: true, storyboards: [
    { shot_number: 1, duration: 9, character_ids: [speaker.id, silent.id], description: sb.description!, video_prompt: voicedPrompt() },
    { shot_number: 2, duration: 9, character_ids: [noVoice.id], description: '【镜头1】小白正面中景，走路。【镜头2】小白正面近景，停步。', video_prompt: silentPrompt },
  ] }, valid)
  const saved = await valid.finish()
  assert.equal(saved.saved, 2, JSON.stringify(saved.issues))
  const shots = db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, ep.id)).all()
  const first = shots.find(s => s.storyboardNumber === 1)!
  assert.deepEqual((await resolveStoryboardVoiceReferences(first.videoPrompt!, first.id, [])).audioUrls, [speaker.voiceAudioUrl])
  assert.equal(shots.find(s => s.storyboardNumber === 2)!.videoPrompt, silentPrompt)
})

test.after(async () => { db.$client.close(); await fs.rm(root, { recursive: true, force: true }) })
