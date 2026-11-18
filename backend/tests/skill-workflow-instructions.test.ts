import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

// Real workspace copies and real instructions/context/factories, with disposable
// persistence and a fetch stub. The small creative replies test transport only;
// they are neither skill-semantic acceptance nor a model-speed benchmark.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-workflow-instructions-'))
process.env.SQLITE_PATH = path.join(directory, 'fixture.sqlite3')
process.env.HUOBAO_DATA_DIR = directory
process.env.STORAGE_PATH = path.join(directory, 'static')
process.env.WORKSPACE_PATH = path.join(directory, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.DOTENV_CONFIG_PATH = path.join(directory, 'absent.env')
process.env.AI_MAX_TOKENS = '16384'
const originalWorkspace = new URL('../workspace/', import.meta.url)
const originalPaths = ['prompts/storyboard_breaker.md', 'skills/storyboard-breaker/SKILL.md', 'skills/prompt-generator/video-prompt/SKILL.md']
const originals = await Promise.all(originalPaths.map(file => fs.readFile(new URL(file, originalWorkspace), 'utf8')))
await fs.cp(originalWorkspace, process.env.WORKSPACE_PATH, { recursive: true })
const custom = [
  '用户base独有原文：不能删掉这句；😀保留原标点。',
  '用户分镜独有原文：动作准备、峰值和结果完整保留。',
  '用户视频独有原文：角色说：「@原词、#原词和[[原词逐字保留。」',
]
for (const [index, file] of originalPaths.entries()) {
  await fs.appendFile(path.join(process.env.WORKSPACE_PATH, file), `\n\n## 本地测试自定义范围${index + 1}\n\n${custom[index]}\n`)
}
const { db, schema } = await import('../src/db/index.ts')
const fixtureOwner=await (await import('./helpers/platform-fixture.ts')).platformFixtureOwner()
const { createStoryboardSession } = await import('../src/services/storyboard-session.ts')
const { StoryboardDraftStore } = await import('../src/services/storyboard-draft-store.ts')
const { runSkillStoryboardWorkflow } = await import('../src/services/skill-storyboard-workflow.ts')
const { createSkillStoryboardAgent } = await import('../src/agents/index.ts')
const { buildAgentRequestContext } = await import('../src/agents/context.ts')
const { loadAgentSkills } = await import('../src/agents/skills.ts')
const { loadAgentPromptFile } = await import('../src/agents/prompts.ts')
const { getVoiceReferenceInstructions } = await import('../src/agents/voice-reference-instructions.ts')
const { compileSkillInstructions } = await import('../src/services/skill-instruction-compiler.ts')
const { adaptSkillWorkflowSources } = await import('../src/services/skill-workflow-protocol.ts')
const { compileStoryboardReferences, scriptTimingBudget } = await import('../src/services/skill-storyboard-contract.ts')
const store = new StoryboardDraftStore(db.$client)
const timestamps = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
const baseUrl = 'https://offline-workflow-instructions.example.test/v1'
const config = db.insert(schema.aiServiceConfigs).values({ serviceType: 'text', provider: 'openai', name: 'Offline original-instruction capture',
  baseUrl, apiKey: 'offline-placeholder', model: '["offline"]', ...timestamps }).returning().get()
const nativeFetch = globalThis.fetch, originalLog = console.log, originalError = console.error
console.log = () => {}; console.error = () => {}

after(async () => {
  globalThis.fetch = nativeFetch
  console.log = originalLog; console.error = originalError
  db.$client.close()
  for (const [index, file] of originalPaths.entries()) assert.equal(await fs.readFile(new URL(file, originalWorkspace), 'utf8'), originals[index])
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(directory).startsWith('huobao-workflow-instructions-'))
  await fs.rm(directory, { recursive: true, force: true })
})

function fixture() {
  const script = `动作：${'院门边原有晨光照进来，衣袖随着脚步自然轻摆。'.repeat(5)}\n阿甲：你回来了。\n动作：${'桌面木杯保持原位，脚步慢下来后停住，抬眼等待。'.repeat(3)}\n阿甲：我一直都在。`
  const timing = scriptTimingBudget(script)
  assert.ok(timing.minimumSeconds <= 20 && timing.maximumSeconds >= 20)
  const drama = db.insert(schema.dramas).values({ ownerUserId:fixtureOwner.id, title: 'Offline loaded-instructions', ...timestamps }).returning().get()
  const episode = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: 'Offline episode', scriptContent: script, ...timestamps }).returning().get()
  const character = db.insert(schema.characters).values({ dramaId: drama.id, name: '阿甲', description: '原有中年人物资料，保持原身份。', imageUrl: 'PRIVATE-IMAGE-MARKER', ...timestamps }).returning().get()
  const scene = db.insert(schema.scenes).values({ dramaId: drama.id, location: '院落', time: '日', prompt: '原有院落、门槛与木桌。', lighting: '原有东侧晨光。',
    finalPrompt: '已有参考图布局：门槛位于南侧，木桌位于东侧，出口不变。', imageUrl: 'PRIVATE-SCENE-MARKER', ...timestamps }).returning().get()
  const prop = db.insert(schema.props).values({ dramaId: drama.id, name: '木杯', description: '原有木杯，摆在原木桌上。', ...timestamps }).returning().get()
  const old = db.insert(schema.storyboards).values({ episodeId: episode.id, storyboardNumber: 1, title: 'Old live title', description: 'Old live description',
    videoPrompt: 'Old live prompt', result: 'Old live outcome', duration: 10, sceneId: scene.id, ...timestamps }).returning().get()
  const rows = () => db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episode.id)).all()
  const options = () => {
    const session = createStoryboardSession({ mode: 'breakdown', episodeId: episode.id, dramaId: drama.id, validationProfile: 'skill-content' })
    const requestContext = buildAgentRequestContext({ episodeId: episode.id, dramaId: drama.id, language: 'zh', textConfigId: config.id })
    requestContext.set('storyboardSession' as never, session as never)
    return { mode: 'breakdown' as const, episodeId: episode.id, dramaId: drama.id, session, requestContext,
      message: '按已加载原始skill完成分镜和视频提示词，逐字保留全部原文。' }
  }
  const assets = { characters: [{ id: character.id, name: character.name }], scenes: [{ id: scene.id, location: scene.location }], props: [{ id: prop.id, name: prop.name }] }
  return { drama, episode, character, scene, prop, old, rows, options, assets, script }
}
type Fixture = ReturnType<typeof fixture>
function plan(f: Fixture) {
  return { groups: [
    { number: 1, title: '走入院落', beat: 'narrative', source_ids: [1, 2], scene_id: f.scene.id, duration: 10 },
    { number: 2, title: '停步回应', beat: 'narrative', source_ids: [3, 4], scene_id: f.scene.id, duration: 10 },
  ] }
}
function creative(f: Fixture, number: number) {
  const c = `[[character:${f.character.id}]]`, s = `[[scene:${f.scene.id}]]`, p = `[[prop:${f.prop.id}]]`
  const speech = number === 1 ? '你回来了。' : '我一直都在。'
  return { shot_number: number, title: number === 1 ? '走入院落' : '停步回应', time: '日，原有晨光', location: `${s}的门槛、原木桌与院墙。`,
    shot_type: '中景＋近景', angle: '平视', movement: '固定后缓推',
    description: `【镜头1】${c}从门槛迈步停在原木桌边，${c}说：「${speech}」【镜头2】${c}放下${p}后自然呼吸，双手落在原有位置。`,
    result: `${c}站在原木桌边，${p}留在桌上，双手放下。`, atmosphere: '原有晨光自东侧照入，环境声连续。',
    image_prompt: `${s}首镜单帧，${c}站在门槛边，${p}留在木桌上，原有晨光清晰。`,
    video_prompt: `出场人物：${c}；场景：${s}；道具：${p}。无字幕、无背景音乐，保留对白和必要音效。\n` +
      `0-3秒：${s}以门槛为原点A0，X轴向东，Y轴向北，${c}迈步走向原木桌。\n` +
      `3-6秒：${c}停步吸气后，${c}说：「${speech}」原有日光照在面部。\n` +
      `6-9秒：切到${c}平视近景，手中${p}落回原木桌。\n9-10秒：${c}双手放下，${p}留在桌上，原有呼吸与晨光承接。`,
    bgm_prompt: '无背景音乐', sound_effect: '原有脚步、衣料与杯底轻触桌面的声音。', duration: 10, scene_id: f.scene.id,
    character_ids: [f.character.id], prop_ids: [f.prop.id], source_ids: number === 1 ? [1, 2] : [3, 4], time_row_counts: [2, 2] }
}

type CapturedCall = { stage: string; body: any; payload: any; system: string; expectedSystem: string; schema: Record<string, unknown> }
function nativeCapture(f: Fixture, conflict: boolean) {
  const calls: CapturedCall[] = []
  let pending: { stage: string; instructions: string; schema: Record<string, unknown> }
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), `${baseUrl}/chat/completions`)
    assert.equal(init?.method, 'POST')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.stream, true)
    assert.equal(Object.hasOwn(body, 'tools'), false)
    assert.equal(Object.hasOwn(body, 'tool_choice'), false)
    assert.deepEqual(body.messages.map((message: any) => message.role), ['system', 'user'])
    const system = body.messages[0].content, payload = JSON.parse(body.messages[1].content)
    assert.equal(system, pending.instructions, 'SDK and provider transport must preserve the real compiled instructions')
    assert.equal(body.response_format.type, 'json_schema')
    assert.equal(body.response_format.json_schema.strict, true)
    assert.deepEqual(body.response_format.json_schema.schema, pending.schema)
    calls.push({ stage: pending.stage, body, system, payload, expectedSystem: pending.instructions, schema: pending.schema })
    const groups = payload.current_groups || (payload.current_group ? [payload.current_group] : [])
    const output = pending.stage === 'plan' ? conflict ? { conflict: '离线原规范传输检查在规划阶段停止，不写分镜。', field: 'offline-probe', source_ids: [1] } : plan(f)
      : groups.length > 1 ? { storyboards: groups.map((group: any) => creative(f, group.number)) } : creative(f, groups[0].number)
    const text = JSON.stringify({ output }), encoder = new TextEncoder()
    const event = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ id: 'offline-real-instructions', object: 'chat.completion.chunk', created: 0, model: 'offline', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(event({ role: 'assistant', content: text.slice(0, 19) })))
      controller.enqueue(encoder.encode(event({ content: text.slice(19) })))
      controller.enqueue(encoder.encode(event({}, 'stop')))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    } }), { headers: { 'Content-Type': 'text/event-stream' } })
  }
  return { calls, dependencies: { store, voiceContract: false,
    createAgent: (stage: 'plan' | 'expand' | 'prompt', instructions: string, responseSchema: Record<string, unknown>) => {
      pending = { stage, instructions, schema: responseSchema }
      return createSkillStoryboardAgent(stage === 'prompt' ? 'prompt_generator' : 'storyboard_breaker', instructions, responseSchema)
    } } }
}

async function realSources(includeVideo: boolean) {
  const storyboard = await loadAgentSkills('storyboard_breaker', 'zh')
  const sources = [{ source: 'skills/storyboard-breaker/SKILL.md', text: storyboard }]
  if (includeVideo) {
    const base = await loadAgentPromptFile('storyboard_breaker', 'zh')
    sources.unshift({ source: 'prompts/storyboard_breaker.md', text: base!.instructions })
    sources.push({ source: 'skills/prompt-generator/video-prompt/SKILL.md', text: await loadAgentSkills('prompt_generator', 'zh', ['prompt-generator/video-prompt']) },
      { source: 'voice-reference-instructions:zh', text: getVoiceReferenceInstructions('storyboard_breaker', 'zh') })
  }
  return sources
}
function assertOriginalRulesOnWire(call: CapturedCall, sources: Awaited<ReturnType<typeof realSources>>) {
  const adapted = adaptSkillWorkflowSources(sources)
  const compiled = compileSkillInstructions(adapted.sources)
  for (const record of compiled.provenance) {
    const original = adapted.sources[record.sourceIndex].text.slice(record.sourceStart, record.sourceEnd)
    const at = call.system.indexOf(original)
    assert.ok(at >= 0, `${record.source}: ${record.headings.join(' > ')}: ${original.slice(0, 80)}`)
    assert.equal(call.system.slice(at, at + original.length), original)
  }
  const definitions = [...call.system.matchAll(/〔(共同规范 C_*\d+)〕/g)].map(match => match[1])
  const references = [...call.system.matchAll(/〔适用(共同规范 C_*\d+)〕/g)].map(match => match[1])
  for (const reference of references) assert.equal(definitions.filter(label => label === reference).length, 1)
  assert.equal(call.system.includes('compiledStart'), false)
  assert.equal(call.system.includes('sourceStart'), false)
  assert.doesNotMatch(call.system, /输出只允许工具调用|每个输出步骤必须是工具调用|执行中只调用工具|必须实际调用保存工具/)
  for (const record of adapted.executionAdaptations) {
    assert.equal(sources[record.sourceIndex].text.slice(record.sourceStart, record.sourceEnd), record.original)
    assert.ok(call.system.includes(record.replacement))
  }
  return { compiled, references }
}

test('default instructionsFor and context reach the actual native SDK once with every original planning rule; explicit conflict preserves old storyboards', async () => {
  const f = fixture(), before = f.rows(), options = f.options(), capture = nativeCapture(f, true)
  const result = await runSkillStoryboardWorkflow(options, capture.dependencies)
  assert.equal(result.status, 'needs_revision')
  assert.equal(result.saved, 0)
  assert.equal(capture.calls.length, 1, 'An explicit model conflict is one request, not a repair or fallback')
  const call = capture.calls[0]
  assert.equal(call.stage, 'plan')
  assertOriginalRulesOnWire(call, await realSources(false))
  assert.ok(call.system.includes(custom[1]))
  assert.equal(call.payload.source_units.map((unit: any) => unit.text).join('\n'), f.script)
  assert.equal(call.payload.script, undefined, 'The original script is sent exactly once as source_units')
  assert.equal(JSON.stringify(call.payload).includes('PRIVATE-IMAGE-MARKER'), false)
  assert.equal(JSON.stringify(call.payload).includes('PRIVATE-SCENE-MARKER'), false)
  assert.deepEqual(f.rows(), before)
})

test('real loaded expansion rules are smaller on the native wire, all shared references resolve, and every complete data field survives the protocol', async t => {
  const f = fixture(), options = f.options(), capture = nativeCapture(f, false)
  const result = await runSkillStoryboardWorkflow(options, { ...capture.dependencies, modelLimits: { maxOutputTokens: 32768 } })
  assert.equal(result.status, 'done', JSON.stringify(result.issues))
  assert.equal(result.saved, 2)
  const expanded = capture.calls.filter(call => call.stage === 'expand')
  assert.equal(expanded.length, 1)
  assert.deepEqual(expanded[0].payload.current_groups.map((group: any) => group.number), [1, 2], 'Only the offline packing-budget override permits this two-group protocol fixture')
  const sources = await realSources(true)
  const legacyCoreCharacters = sources.map(source => source.text).join('\n\n').length
  for (const call of expanded) {
    const traced = assertOriginalRulesOnWire(call, sources)
    assert.ok(traced.references.length > 0)
    assert.ok(call.system.length < legacyCoreCharacters, 'Even with transport and batch instructions, the actual SDK message is shorter than the original uncompiled rules alone')
    for (const paragraph of custom) assert.ok(call.system.includes(paragraph))
    for (const source of ['prompts/storyboard_breaker.md', 'skills/storyboard-breaker', 'skills/prompt-generator/video-prompt', 'voice-reference-instructions']) {
      assert.ok(call.system.split('\n').some(line => line.startsWith('〔规范来源 S') && line.includes(source)), `The actual source scope must survive compilation: ${source}`)
    }
    const completeSchemas: any[] = []
    const visit = (value: any) => {
      if (!value || typeof value !== 'object') return
      if (value.properties?.description && value.properties?.image_prompt && value.properties?.time_row_counts) completeSchemas.push(value)
      for (const child of Object.values(value)) visit(child)
    }
    visit(call.schema)
    assert.ok(completeSchemas.length > 0)
    for (const full of completeSchemas) for (const field of ['shot_number', 'title', 'time', 'location', 'shot_type', 'angle', 'movement', 'description', 'result', 'atmosphere', 'image_prompt',
      'video_prompt', 'bgm_prompt', 'sound_effect', 'duration', 'scene_id', 'character_ids', 'prop_ids', 'source_ids', 'time_row_counts']) assert.ok(full.required.includes(field), field)
    const scenes = call.payload.asset_facts?.scenes || call.payload.scenes
    assert.equal(scenes[0].reference_image_prompt, f.scene.finalPrompt, 'Default context still provides the complete scene layout facts')
  }
  const rows = f.rows().sort((a, b) => a.storyboardNumber - b.storyboardNumber)
  const columns = { title: 'title', time: 'time', location: 'location', shot_type: 'shotType', angle: 'angle', movement: 'movement', description: 'description', result: 'result', atmosphere: 'atmosphere',
    image_prompt: 'imagePrompt', video_prompt: 'videoPrompt', bgm_prompt: 'bgmPrompt', sound_effect: 'soundEffect', duration: 'duration', scene_id: 'sceneId' } as const
  for (const [index, row] of rows.entries()) {
    const original = compileStoryboardReferences(creative(f, index + 1), f.assets).candidate!
    for (const [field, column] of Object.entries(columns)) assert.equal((row as any)[column], (original as any)[field], field)
  }
  assert.equal(result.result.repairCalls, 0)
  assert.equal(result.result.requestStats.length, capture.calls.length)
  for (const [index, call] of capture.calls.entries()) assert.equal(result.result.requestStats[index].instructionCharacters, call.system.length)
  t.diagnostic(JSON.stringify({ originalRulesOnlyCharacters: legacyCoreCharacters,
    sdkInstructionCharactersIncludingAdapters: expanded.map(call => call.system.length), expansionRequests: expanded.length,
    note: 'Character counts measure actual instruction transport, not fake-response model speed or semantic quality.' }))
})
