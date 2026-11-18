import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { Agent } from '@mastra/core/agent'
import { createOpenAI } from '@ai-sdk/openai'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-skill-workflow-'))
process.env.SQLITE_PATH = path.join(directory, 'workflow.sqlite3')
process.env.HUOBAO_DATA_DIR = directory
process.env.STORAGE_PATH = path.join(directory, 'static')
process.env.WORKSPACE_PATH = path.join(directory, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.ts')
const fixtureOwner=await (await import('./helpers/platform-fixture.ts')).platformFixtureOwner()
const { createStoryboardSession } = await import('../src/services/storyboard-session.ts')
const { StoryboardDraftStore } = await import('../src/services/storyboard-draft-store.ts')
const { runSkillStoryboardWorkflow, publicStoryboardDraft } = await import('../src/services/skill-storyboard-workflow.ts')
const { buildAgentRequestContext } = await import('../src/agents/context.ts')
const { compileStoryboardReferences, scriptTimingBudget } = await import('../src/services/skill-storyboard-contract.ts')
const store = new StoryboardDraftStore(db.$client)
const timestamps = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
const originalSkills = { plan: 'Original narrative skill: keep the complete script and all silent actions.', expand: 'Original storyboard and video-prompt skills: write full natural prose.', prompt: 'Original video-prompt skill: retain the locked description and original words.' }

after(async () => {
  db.$client.close()
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
  assert.ok(path.basename(directory).startsWith('huobao-skill-workflow-'))
  await fs.rm(directory, { recursive: true, force: true })
})

function fixture(scriptOverride?: string) {
  const script = scriptOverride ?? `动作：${'院门边原有晨光照进来，衣袖随着脚步自然轻摆。'.repeat(5)}\n阿甲：你回来了。\n动作：${'桌面木杯保持原位，脚步慢下来后停住，抬眼等待。'.repeat(3)}\n阿甲：我一直都在。`
  const budget = scriptTimingBudget(script)
  if (!scriptOverride) assert.ok(budget.minimumSeconds <= 20 && budget.maximumSeconds >= 20)
  const drama = db.insert(schema.dramas).values({ ownerUserId:fixtureOwner.id, title: 'Disposable skill workflow', ...timestamps }).returning().get()
  const episode = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: 'Offline', scriptContent: script, duration: 99, ...timestamps }).returning().get()
  const character = db.insert(schema.characters).values({ dramaId: drama.id, name: '阿甲', ...timestamps }).returning().get()
  const scene = db.insert(schema.scenes).values({ dramaId: drama.id, location: '院落', time: '日', prompt: '现有日光院落', ...timestamps }).returning().get()
  const prop = db.insert(schema.props).values({ dramaId: drama.id, name: '木杯', ...timestamps }).returning().get()
  const old = db.insert(schema.storyboards).values({ episodeId: episode.id, storyboardNumber: 1, title: 'Old live title', description: 'Old live description', videoPrompt: 'Old live prompt', imagePrompt: 'Old live first frame', result: 'Old live outcome', duration: 10, sceneId: scene.id, ...timestamps }).returning().get()
  db.insert(schema.storyboardCharacters).values({ storyboardId: old.id, characterId: character.id }).run()
  db.insert(schema.storyboardProps).values({ storyboardId: old.id, propId: prop.id }).run()
  const assets = { characters: [{ id: character.id, name: character.name }], scenes: [{ id: scene.id, location: scene.location }], props: [{ id: prop.id, name: prop.name }] }
  const rows = () => db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episode.id)).all()
  const snapshot = () => ({ rows: rows(), episode: db.select().from(schema.episodes).where(eq(schema.episodes.id, episode.id)).get(),
    characters: db.select().from(schema.storyboardCharacters).all().filter(link => rows().some(row => row.id === link.storyboardId)),
    props: db.select().from(schema.storyboardProps).all().filter(link => rows().some(row => row.id === link.storyboardId)) })
  const context = () => ({ episode: { id: episode.id, title: 'Offline episode' },
    script: db.select().from(schema.episodes).where(eq(schema.episodes.id, episode.id)).get()!.scriptContent,
    ...assets, characters: assets.characters.map(value => ({ ...value, image_url: 'private-image-marker', reference_images: 'private-reference-marker' })),
    existing_storyboards: rows().map(row => ({ id: row.id, shot_number: row.storyboardNumber, description: row.description, video_prompt: row.videoPrompt, result: row.result })),
    // An old read tool may expose these; the new workflow must not forward them.
    dialogue_timing_guide: [{ source_line: 1, fragments: ['legacy-thirteen-character-marker'] }], dialogue_group_schedule: [{ duration: 9, rows: ['legacy-fixed-slot-marker'] }],
  })
  const start = (mode: 'breakdown' | 'prompt' = 'breakdown', signal?: AbortSignal, onPhase?: (phase: 'validating' | 'saving') => void, targetIds = [old.id]) => {
    const session = createStoryboardSession({ mode, episodeId: episode.id, dramaId: drama.id, ...(mode === 'prompt' ? { storyboardIds: targetIds } : {}), validationProfile: 'skill-content', signal, onPhase })
    const requestContext = buildAgentRequestContext({ episodeId: episode.id, dramaId: drama.id, language: 'zh' })
    requestContext.set('storyboardSession' as never, session as never)
    return { episodeId: episode.id, dramaId: drama.id, mode, ...(mode === 'prompt' ? { storyboardIds: targetIds } : {}), session, requestContext, message: '按原skill完整生成。', signal }
  }
  return { drama, episode, character, scene, prop, old, assets, rows, snapshot, context, start }
}
type Fixture = ReturnType<typeof fixture>
function plan(f: Fixture) {
  return { groups: [
    { number: 1, title: '归来与看见', beat: 'narrative', source_ids: [1, 2], scene_id: f.scene.id, duration: 10 },
    { number: 2, title: '停步与回应', beat: 'narrative', source_ids: [3, 4], scene_id: f.scene.id, duration: 10 },
  ] }
}
function creative(f: Fixture, number: number): any {
  const c = `[[character:${f.character.id}]]`, s = `[[scene:${f.scene.id}]]`, p = `[[prop:${f.prop.id}]]`
  const speech = number === 1 ? '你回来了。' : '我一直都在。'
  return { shot_number: number, title: number === 1 ? '归来与看见' : '停步与回应', time: '日，既有晨光', location: `${s}的原门槛、院墙与木桌形成单一现实空间。`,
    shot_type: '中景＋近景', angle: '平视', movement: '固定后轻推',
    description: `【镜头1】${c}从门槛向原木桌迈步，衣袖随步伐轻摆，落步后${c}说：「${speech}」【镜头2】${c}抬眼等待，左手松开${p}，杯底落回原桌面，末态与既有日光承接。`,
    result: `${c}停在木桌旁，双手放下，${p}留在桌面，等待原有回应。`, atmosphere: '晨光自东侧照入，既有环境声连续。',
    image_prompt: `${s}内首镜单帧，${c}站在门槛边，${p}位于原木桌上，保持既有晨光。`,
    video_prompt: `出场人物：${c}；场景：${s}；道具：${p}。无字幕、无背景音乐，保留对白和必要音效；同一现实空间人物唯一，不出现克隆人，不越轴。\n0-3秒：${s}以门槛为原点A0，X轴向东，Y轴向北；${c}从门槛迈步，站位承接，晨光照在衣袖。\n3-6秒：${c}落步后轻眨，${c}说：「${speech}」气息稳定，听感中年，低音区，音色温润，约每秒2字，原环境声连续。\n6-9秒：切到${c}平视近景，抬眼等待，左手松开${p}，杯底轻触原桌面。\n9-10秒：${c}双手放下，${p}稳定在桌面，目光落在原有回应方向，晨光方向保持。`,
    bgm_prompt: '无背景音乐', sound_effect: '脚步、衣料和杯底轻触桌面的原有声响。', duration: 10, scene_id: f.scene.id,
    character_ids: [], prop_ids: [], source_ids: number === 1 ? [1, 2] : [3, 4], time_row_counts: [2, 2] }
}

let agentCounter = 0
const sseChunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: 'offline-skill-chunk', object: 'chat.completion.chunk', created: 0, model: 'offline',
  choices: [{ index: 0, delta, finish_reason: finish }],
})
function sseResponse(chunks: unknown[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
    controller.enqueue(encoder.encode('data: [DONE]\n\n'))
    controller.close()
  } }), { headers: { 'Content-Type': 'text/event-stream' } })
}
function interruptedSseResponse(content: string): Response {
  const encoder = new TextEncoder()
  let pulled = false
  return new Response(new ReadableStream({ pull(controller) {
    if (!pulled) {
      pulled = true
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(sseChunk({ role: 'assistant', content }))}\n\n`))
    } else controller.error(Object.assign(new Error('offline SSE connection reset before finish'), { code: 'ECONNRESET' }))
  } }), { headers: { 'Content-Type': 'text/event-stream' } })
}
type Call = { stage: 'plan' | 'expand' | 'prompt'; payload: any; body: any; schema: any; instructions: string; signal?: AbortSignal | null; execution?: any }
function nativeMock(f: Fixture, responder?: (call: Call, count: number) => unknown | Promise<unknown>, skills = originalSkills) {
  const calls: Call[] = []
  let reads = 0
  const dependencies = { store, modelIdentity: 'offline-model-v1' as unknown, batchSize: 1 as 1 | 2 | undefined, modelLimits: { maxOutputTokens: 32_768 },
    automaticRecovery: false as boolean | undefined, recoveryDelayMs: 0, targetedRepairs: false as boolean | undefined, voiceContract: false as boolean | undefined,
    readContext: async () => { reads++; return f.context() }, loadInstructions: async () => skills,
    createAgent: (stage: Call['stage'], instructions: string, responseSchema: Record<string, unknown>, execution?: any) => {
      assert.equal(responseSchema.type, 'object')
      assert.ok(instructions.startsWith(skills[stage]), 'the complete original skill remains the byte-identical instructions prefix')
      for (const legacy of ['13字', '固定9秒', '固定slot', 'fragment_index', 'dialogue_group_schedule', 'shot_1']) assert.equal(instructions.includes(legacy), false, legacy)
      const envelope = responseSchema as any
      assert.deepEqual(envelope.required, ['output'])
      assert.equal(envelope.additionalProperties, false)
      const variants = envelope.properties.output.anyOf
      assert.equal(variants.length, 2)
      const stageSchema = variants.find((branch: any) => branch.properties?.base_version
        || branch.properties?.[stage === 'plan' ? 'groups' : stage === 'expand' ? 'description' : 'video_prompt'] || stage === 'expand' && (branch.properties?.storyboards || branch.properties?.left))
      const conflictSchema = variants.find((branch: any) => branch.properties?.conflict)
      assert.ok(stageSchema && conflictSchema)
      assert.deepEqual([...conflictSchema.required].sort(), ['conflict', 'field', 'source_ids'])
      const closed = (value: any) => {
        if (!value || typeof value !== 'object') return
        if (value.type === 'object' || value.properties) {
          assert.equal(value.additionalProperties, false)
          assert.deepEqual([...(value.required || [])].sort(), Object.keys(value.properties || {}).sort())
        }
        Object.values(value).forEach(closed)
      }
      closed(envelope)
      if (stage === 'plan') {
        assert.equal(Object.hasOwn(stageSchema.properties.groups.items.properties, 'shot_count'), false)
        assert.equal(stageSchema.properties.groups.items.required.includes('shot_count'), false)
      }
      if (stageSchema.properties.base_version) {
        assert.deepEqual([...stageSchema.required].sort(), ['base_version', 'changes'])
        assert.ok(stageSchema.properties.changes.properties)
        assert.equal(Object.hasOwn(stageSchema.properties, 'description'), false)
        assert.equal(Object.hasOwn(stageSchema.properties, 'video_prompt'), false)
      } else if (stage === 'expand') {
        const fullSchema = stageSchema.properties.left || (stageSchema.properties.storyboards ? stageSchema.properties.storyboards.items.anyOf.find((branch: any) => branch.properties?.description) : stageSchema)
        if (stageSchema.properties.storyboards) {
          assert.equal(stageSchema.properties.storyboards.minItems, 2)
          assert.equal(stageSchema.properties.storyboards.maxItems, 2)
          const rowConflict = stageSchema.properties.storyboards.items.anyOf.find((branch: any) => branch.properties?.conflict)
          assert.deepEqual([...rowConflict.required].sort(), ['conflict', 'field', 'shot_number', 'source_ids'])
        }
        const required = fullSchema.required as string[]
        for (const field of ['shot_number', 'title', 'time', 'location', 'shot_type', 'angle', 'movement', 'description', 'result', 'atmosphere', 'image_prompt', 'video_prompt', 'bgm_prompt', 'sound_effect', 'duration', 'scene_id', 'character_ids', 'prop_ids', 'source_ids', 'time_row_counts']) assert.ok(required.includes(field), field)
        assert.equal(Object.hasOwn(fullSchema.properties, 'shot_1'), false)
      }
      const provider = createOpenAI({ apiKey: 'offline-fixture', baseURL: 'https://example.invalid/v1', fetch: async (url, init) => {
        assert.ok(String(url).startsWith('https://example.invalid/v1/'))
        assert.equal(init?.method, 'POST')
        const body = JSON.parse(String(init?.body))
        assert.equal(body.stream, true, 'the real SDK must request streaming, including strict-schema creative stages')
        for (const key of ['tools', 'tool_choice', 'textMode']) assert.equal(Object.hasOwn(body, key), false, key)
        assert.equal(body.messages.some((message: any) => ['assistant', 'tool'].includes(message.role)), false)
        const message = body.messages.filter((entry: any) => entry.role === 'user').at(-1)
        const raw = typeof message.content === 'string' ? message.content : message.content.map((part: any) => part.text || '').join('')
        for (const marker of ['legacy-thirteen-character-marker', 'legacy-fixed-slot-marker', 'private-image-marker', 'private-reference-marker', 'fragment_index', 'dialogue_group_schedule']) assert.equal(raw.includes(marker), false, marker)
        const call = { stage, payload: JSON.parse(raw), body, schema: responseSchema, instructions, signal: init?.signal, execution }; calls.push(call)
        const value = responder ? await responder(call, calls.length) : stage === 'plan' ? plan(f) : stage === 'prompt'
          ? { video_prompt: creative(f, 1).video_prompt, time_row_counts: [2, 2] } : call.payload.current_groups.length > 1
            ? { storyboards: call.payload.current_groups.map((group: any) => creative(f, group.number)) } : creative(f, call.payload.current_group.number)
        if (value instanceof Response) return value
        const content = typeof value === 'string' ? value : JSON.stringify({ output: value })
        const chunks = [sseChunk({ role: 'assistant', content: '' })]
        for (let offset = 0; offset < content.length; offset += 173) chunks.push(sseChunk({ content: content.slice(offset, offset + 173) }))
        chunks.push({ ...sseChunk({}, 'stop'), usage: { prompt_tokens: 30, completion_tokens: 50, total_tokens: 80 } } as any)
        return sseResponse(chunks)
      } })
      return new Agent({ id: `offline-skill-${++agentCounter}`, name: 'Offline full skill workflow', instructions, model: provider.chat('offline'), tools: {}, maxRetries: 0 })
    },
  }
  return { dependencies, calls, reads: () => reads }
}

function automatic(mock: ReturnType<typeof nativeMock>, identity: unknown = { provider: 'openai', model: 'deepseek-v4.1-flash' }) {
  delete mock.dependencies.automaticRecovery
  mock.dependencies.modelIdentity = identity
  mock.dependencies.modelLimits.maxOutputTokens = 16_384
  return mock
}
function targeted(mock: ReturnType<typeof nativeMock>) {
  automatic(mock)
  delete mock.dependencies.targetedRepairs
  return mock
}
function noBodyResponse(reason: 'length' | 'stop') {
  return sseResponse([
    sseChunk({ role: 'assistant', content: '' }),
    { ...sseChunk({}, reason), usage: { prompt_tokens: 30, completion_tokens: 16_384, total_tokens: 16_414, completion_tokens_details: { reasoning_tokens: 16_384 } } },
  ])
}

function holdingAtBoundary(value: any) {
  return { ...value,
    description: value.description.replace('左手松开', '左手继续握住').replace('杯底落回原桌面', '杯底仍离开桌面'),
    video_prompt: value.video_prompt.replace('左手松开', '左手继续握住').replace('杯底轻触原桌面', '杯底仍离开桌面')
      .replace('双手放下', '左手继续握杯').replace('稳定在桌面', '稳定握在左手中'),
    result: value.result.replace('双手放下', '左手继续握杯').replace('留在桌面', '仍在左手中'),
  }
}

test('adjacent draft conflict repairs the previous ending and current opening together without touching live data early', async () => {
  const f = fixture(), before = f.snapshot()
  let pairCalls = 0
  const mock = automatic(nativeMock(f, call => {
    assert.deepEqual(f.snapshot(), before, 'pair evaluation must not publish either half')
    if (call.stage === 'plan') return plan(f)
    if (call.payload.boundary_repair) {
      pairCalls++
      assert.equal(call.payload.boundary_repair.left_number, 1)
      assert.equal(call.payload.boundary_repair.right_number, 2)
      assert.equal(call.payload.boundary_repair.before.right, null)
      assert.ok(call.payload.boundary_repair.instruction.includes('原文事实优先'))
      return { left: holdingAtBoundary(creative(f, 1)), right: creative(f, 2), continuity: { resolved: true, summary: '前组保留握杯，后组按原文放回。' } }
    }
    return call.payload.current_group.number === 1 ? creative(f, 1)
      : { conflict: '上一组末态写成双手空垂，与本组需要松开木杯的原文状态矛盾。', field: 'previous_ending', source_ids: [3, 4] }
  }))
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues))
  assert.equal(pairCalls, 1)
  const draft = store.get(result.draft_id!)!
  assert.equal(draft.boundaryRepairs?.length, 1)
  assert.equal(draft.boundaryRepairs?.[0].status, 'applied')
  assert.ok(JSON.stringify(draft.boundaryRepairs?.[0].before[0]).includes('双手放下'))
  assert.ok(f.rows()[0].result?.includes('左手继续握杯'))
  assert.equal((publicStoryboardDraft(draft) as any).boundaryRepairs[0].before, undefined)
  assert.equal((publicStoryboardDraft(draft) as any).budget.characters, scriptTimingBudget(f.context().script!).characters)
})

test('out-of-scope adjacent repair is bounded and leaves both original drafts plus published content intact', async () => {
  const f = fixture(), before = f.snapshot()
  let pairCalls = 0
  const mock = automatic(nativeMock(f, call => {
    if (call.stage === 'plan') return plan(f)
    if (call.payload.boundary_repair) {
      pairCalls++
      return { left: { ...holdingAtBoundary(creative(f, 1)), title: '越权改了其他字段' }, right: creative(f, 2), continuity: { resolved: true, summary: '声称已修正，但越权改变标题。' } }
    }
    return call.payload.current_group.number === 1 ? creative(f, 1)
      : { conflict: '上一组末态与当前持物状态冲突。', field: 'previous_ending', source_ids: [3, 4] }
  }))
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'needs_revision')
  assert.equal(pairCalls, 2)
  assert.deepEqual(f.snapshot(), before)
  const draft = store.get(result.draft_id!)!
  assert.equal(draft.groups[0].status, 'ready')
  assert.ok(JSON.stringify(draft.groups[0].candidate).includes('双手放下'))
  assert.deepEqual(draft.boundaryRepairs?.map(row => row.status), ['failed', 'failed'])
  assert.ok(draft.groups[1].issues.some((issue: any) => issue.code === 'boundary_continuity'))
  const repeat = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(repeat.status, 'needs_revision')
  assert.equal(pairCalls, 2, 'manual resume must not bypass durable boundary attempt cap')
})

test('cancelling a joint boundary repair never publishes one repaired half', async () => {
  const f = fixture(), before = f.snapshot(), controller = new AbortController()
  const mock = automatic(nativeMock(f, call => {
    if (call.stage === 'plan') return plan(f)
    if (call.payload.boundary_repair) {
      controller.abort(new Error('Cancel while joint repair is running'))
      return { left: holdingAtBoundary(creative(f, 1)), right: creative(f, 2), continuity: { resolved: true, summary: '不得保存迟到结果' } }
    }
    return call.payload.current_group.number === 1 ? creative(f, 1)
      : { conflict: '上一组末态与本组持物状态矛盾。', field: 'previous_ending', source_ids: [3, 4] }
  }))
  const result = await runSkillStoryboardWorkflow(f.start('breakdown', controller.signal), mock.dependencies)
  assert.equal(result.status, 'needs_revision')
  const draft = store.get(result.draft_id!)!
  assert.equal(draft.status, 'interrupted')
  assert.deepEqual(f.snapshot(), before)
  assert.ok(JSON.stringify(draft.groups[0].candidate).includes('双手放下'))
  assert.equal(draft.boundaryRepairs?.[0].status, 'failed')
})

test('resuming a complete-looking draft still executes its saved boundary dependency review', async () => {
  const f = fixture(), before = f.snapshot()
  const first = automatic(nativeMock(f, call => call.stage === 'plan' ? plan(f) : call.payload.current_group.number === 1 ? creative(f, 1)
    : { conflict: '原文资料待补。', field: 'description', source_ids: [3, 4] }))
  const pending = await runSkillStoryboardWorkflow(f.start(), first.dependencies)
  assert.equal(pending.status, 'needs_revision')
  const checkpoint = store.get(pending.draft_id!)!
  store.saveGroup(checkpoint.id, { ...checkpoint.groups[1], candidate: { raw: creative(f, 2), data: compileStoryboardReferences(creative(f, 2), f.assets).candidate,
    preview: compileStoryboardReferences(creative(f, 2), f.assets).candidate }, status: 'needs_revision',
    issues: [{ code: 'boundary_dependency_review', field: 'previous_ending', severity: 'error', message: '前组新末态需要实际重新复核。' }] })
  let secondRequests = 0
  const next = automatic(nativeMock(f, call => {
    assert.equal(call.stage, 'expand')
    assert.equal(call.payload.current_group.number, 2)
    secondRequests++
    assert.ok(call.payload.directed_repair.issues.some((issue: any) => issue.code === 'boundary_dependency_review'))
    return creative(f, 2)
  }))
  const completed = await runSkillStoryboardWorkflow(f.start(), next.dependencies)
  assert.equal(completed.status, 'done', JSON.stringify(completed.issues))
  assert.equal(secondRequests, 1, 'must not silently promote the complete-looking group to ready')
  assert.equal(f.rows().length, 2)
  assert.notDeepEqual(f.snapshot(), before)
})

test('default batching creates both same-scene groups in one native SSE response with complete prose and per-group durable progress', async () => {
  const f = fixture(), before = f.snapshot(), progress: any[] = []
  const mock = nativeMock(f)
  delete (mock.dependencies as { batchSize?: 1 | 2 }).batchSize
  const result = await runSkillStoryboardWorkflow({ ...f.start(), onProgress: value => {
    progress.push({ ...value, groups: store.get(value.draft_id)!.groups.map(group => ({ number: group.number, status: group.status })) })
    assert.deepEqual(f.snapshot(), before, 'Each saved creative checkpoint precedes the whole-episode transaction')
  } }, mock.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues))
  assert.equal(result.saved, 2)
  assert.deepEqual(mock.calls.map(call => call.stage), ['plan', 'expand'])
  assert.equal(result.result.modelCalls, 2); assert.equal(result.result.repairCalls, 0)
  const batch = mock.calls[1]
  assert.deepEqual(batch.payload.current_groups.map((group: any) => group.number), [1, 2])
  assert.equal(Object.hasOwn(batch.payload, 'current_group'), false)
  assert.equal(Object.hasOwn(batch.payload, 'script'), false)
  assert.deepEqual(batch.payload.source_units.map((unit: any) => unit.id), [1, 2, 3, 4])
  assert.ok(batch.payload.asset_catalog && batch.payload.asset_facts)
  const noSpeechText = (value: any) => {
    if (!value || typeof value !== 'object') return
    assert.equal(Object.hasOwn(value, 'text'), false, 'Numeric speech budgets do not duplicate source text')
    Object.values(value).forEach(noSpeechText)
  }
  noSpeechText(batch.payload.source_speech_budgets)
  assert.ok(progress.some(value => value.completed === 1 && value.groups[0].status === 'ready' && value.groups[1].status === 'generating'))
  assert.ok(progress.some(value => value.completed === 2 && value.groups.every((group: any) => group.status === 'ready')))
  const draft = store.get(result.draft_id!)!
  assert.equal(draft.status, 'committed')
  assert.deepEqual(draft.groups.map(group => group.attempts), [1, 1])
  for (const [index, row] of f.rows().entries()) {
    const full = compileStoryboardReferences(creative(f, index + 1), f.assets).candidate!
    assert.equal(row.description, full.description)
    assert.equal(row.videoPrompt, full.video_prompt)
    assert.equal(row.result, full.result)
    assert.equal(row.imagePrompt, full.image_prompt)
  }
})

test('a batch saves its good second group before repairing only its invalid first group with the single-row schema', async () => {
  const f = fixture(), before = f.snapshot(), bad = { ...creative(f, 1), result: '[[prop:999]]仍保留初轮完整末态。' }
  let readySecond: any
  const mock = nativeMock(f, call => {
    assert.deepEqual(f.snapshot(), before)
    if (call.stage === 'plan') return plan(f)
    if (call.payload.current_groups.length === 2) return { storyboards: [bad, creative(f, 2)] }
    assert.equal(call.payload.current_group.number, 1)
    assert.deepEqual(call.payload.directed_repair.rejected_submission, bad)
    assert.ok(call.payload.directed_repair.issues.some((issue: any) => issue.code === 'reference_unknown_id'))
    const groups = store.latest(f.episode.id)!.groups
    assert.equal(groups[0].status, 'generating')
    assert.equal(groups[1].status, 'ready', 'Every batch row is durably saved before any repair starts')
    readySecond = structuredClone(groups[1])
    assert.ok(call.schema.properties.output.anyOf.some((branch: any) => branch.properties?.description))
    assert.equal(call.schema.properties.output.anyOf.some((branch: any) => branch.properties?.storyboards), false)
    return creative(f, 1)
  })
  mock.dependencies.batchSize = 2
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues))
  assert.equal(result.saved, 2)
  assert.equal(result.result.modelCalls, 3); assert.equal(result.result.repairCalls, 1)
  assert.deepEqual(mock.calls.map(call => call.stage === 'plan' ? 'plan' : call.payload.current_groups.map((group: any) => group.number)), ['plan', [1, 2], [1]])
  assert.deepEqual(store.get(result.draft_id!)!.groups[1], readySecond)
  assert.deepEqual(store.get(result.draft_id!)!.groups.map(group => group.attempts), [2, 1])
})

test('a group-specific batch conflict keeps the other complete group without automatic repair or live changes', async () => {
  const f = fixture(), before = f.snapshot(), conflict = { shot_number: 1, conflict: '本组原文动作缺少依据，请明确该组末态。', field: 'result', source_ids: [1, 2] }
  const mock = nativeMock(f, call => call.stage === 'plan' ? plan(f) : { storyboards: [conflict, creative(f, 2)] })
  mock.dependencies.batchSize = 2
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'needs_revision'); assert.equal(result.saved, 0)
  assert.equal(mock.calls.length, 2); assert.equal(result.result.repairCalls, 0)
  const draft = store.get(result.draft_id!)!
  assert.deepEqual(draft.groups.map(group => group.status), ['needs_revision', 'ready'])
  assert.ok(draft.groups[0].issues.some((issue: any) => issue.code === 'model_constraint_conflict' && issue.message === conflict.conflict))
  assert.deepEqual((draft.groups[1].candidate as any).raw, creative(f, 2))
  assert.deepEqual(f.snapshot(), before)
  const ready = structuredClone(draft.groups[1])
  const continuation = nativeMock(f, call => {
    assert.equal(call.stage, 'expand', 'An explicit retry reuses the old draft fingerprint and approved plan')
    assert.deepEqual(call.payload.current_groups.map((group: any) => group.number), [1])
    return creative(f, 1)
  })
  continuation.dependencies.batchSize = 2
  const createNative = continuation.dependencies.createAgent
  continuation.dependencies.createAgent = (stage, instructions, responseSchema) => createNative(stage, `${instructions}\nCOMPILED_TRANSPORT_V2`, responseSchema)
  const resumed = await runSkillStoryboardWorkflow(f.start(), continuation.dependencies)
  assert.equal(resumed.status, 'done', JSON.stringify(resumed.issues))
  assert.equal(resumed.draft_id, result.draft_id)
  assert.equal(continuation.calls.length, 1)
  assert.ok(continuation.calls[0].instructions.endsWith('COMPILED_TRANSPORT_V2'))
  assert.equal(store.get(resumed.draft_id!)!.fingerprint, draft.fingerprint, 'Compiled transport changes do not invalidate unchanged raw skills, source, model and live context')
  assert.deepEqual(store.get(resumed.draft_id!)!.groups[1], ready)
})

test('missing or duplicate batch rows repair only their explicit group and never choose an ambiguous result as ready', async () => {
  for (const variant of ['missing', 'duplicate']) {
    const f = fixture(), before = f.snapshot()
    const invalid = variant === 'missing' ? { storyboards: [creative(f, 1)] }
      : { storyboards: [creative(f, 1), { ...creative(f, 1), result: 'DUPLICATE_CANNOT_BE_CHOSEN' }, creative(f, 2)] }
    const badNumber = variant === 'missing' ? 2 : 1, goodNumber = badNumber === 1 ? 2 : 1
    let good: any
    const mock = nativeMock(f, call => {
      assert.deepEqual(f.snapshot(), before)
      if (call.stage === 'plan') return plan(f)
      if (call.payload.current_groups.length === 2) return invalid
      assert.equal(call.payload.current_group.number, badNumber)
      const draft = store.latest(f.episode.id)!, failed = draft.groups.find(group => group.number === badNumber)!
      assert.equal(failed.status, 'generating')
      assert.ok(failed.issues.some((issue: any) => issue.code === (variant === 'missing' ? 'batch_group_missing' : 'batch_group_duplicate')))
      assert.deepEqual((failed.candidate as any).batch_raw, invalid)
      good = structuredClone(draft.groups.find(group => group.number === goodNumber))
      assert.equal(good.status, 'ready')
      assert.equal(JSON.stringify(publicStoryboardDraft(draft)).includes('batch_raw'), false)
      return creative(f, badNumber)
    })
    mock.dependencies.batchSize = 2
    const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
    assert.equal(result.status, 'done', JSON.stringify(result.issues))
    assert.equal(result.saved, 2); assert.equal(result.result.repairCalls, 1); assert.equal(mock.calls.length, 3)
    assert.deepEqual(store.get(result.draft_id!)!.groups.find(group => group.number === goodNumber), good)
  }
})

test('an invalid batch structure gets one bounded single-group repair per target without resending the whole batch', async () => {
  const f = fixture(), before = f.snapshot(), invalid = { storyboards: 'missing structured rows' }
  const mock = nativeMock(f, call => {
    assert.deepEqual(f.snapshot(), before)
    if (call.stage === 'plan') return plan(f)
    if (call.payload.current_groups.length > 1) return invalid
    assert.ok(call.payload.directed_repair.issues.some((issue: any) => issue.code === 'batch_group_missing'))
    return creative(f, call.payload.current_group.number)
  })
  mock.dependencies.batchSize = 2
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues)); assert.equal(result.saved, 2)
  assert.equal(result.result.repairCalls, 2)
  assert.deepEqual(mock.calls.map(call => call.stage === 'plan' ? 'plan' : call.payload.current_groups.map((group: any) => group.number)), ['plan', [1, 2], [1], [2]])
  assert.deepEqual(store.get(result.draft_id!)!.groups.map(group => group.attempts), [2, 2])
})

test('an out-of-scope batch row stays only in the private diagnostic response and cannot add a target or live storyboard', async () => {
  const f = fixture(), foreign = fixture(), foreignBefore = foreign.snapshot()
  const extra = { ...creative(f, 1), shot_number: 99, title: 'PRIVATE_UNREQUESTED_BATCH_ROW' }
  const batch = { storyboards: [creative(f, 1), creative(f, 2), extra] }
  const mock = nativeMock(f, call => call.stage === 'plan' ? plan(f) : batch)
  mock.dependencies.batchSize = 2
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues)); assert.equal(result.saved, 2)
  assert.equal(mock.calls.length, 2); assert.equal(result.result.repairCalls, 0)
  const draft = store.get(result.draft_id!)!
  assert.deepEqual(draft.groups.map(group => group.number), [1, 2])
  assert.deepEqual(f.rows().map(row => row.storyboardNumber), [1, 2])
  assert.deepEqual((draft.groups[0].candidate as any).batch_raw, batch)
  assert.ok(draft.groups.every(group => group.issues.some((issue: any) => issue.code === 'batch_extra_group_ignored' && issue.severity === 'warning')))
  assert.equal(JSON.stringify(publicStoryboardDraft(draft)).includes('PRIVATE_UNREQUESTED_BATCH_ROW'), false)
  assert.deepEqual(foreign.snapshot(), foreignBefore)
})

test('a batch gateway failure or interrupted SSE stream stops without fallback, group repair or live writes', async () => {
  for (const variant of ['gateway', 'disconnected']) {
    const f = fixture(), before = f.snapshot()
    const mock = nativeMock(f, call => {
      if (call.stage === 'plan') return plan(f)
      assert.deepEqual(call.payload.current_groups.map((group: any) => group.number), [1, 2])
      return variant === 'gateway' ? new Response(JSON.stringify({ error: { message: 'Offline batch gateway timeout', type: 'server_error' } }), { status: 504, headers: { 'Content-Type': 'application/json' } })
        : interruptedSseResponse('{"output":{"storyboards":[{"title":"PARTIAL_BATCH_MUST_NOT_BE_SAVED"')
    })
    mock.dependencies.batchSize = 2
    const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
    assert.equal(result.status, 'needs_revision'); assert.equal(result.saved, 0)
    assert.equal(mock.calls.length, 2); assert.equal(result.result.repairCalls, 0)
    const draft = store.get(result.draft_id!)!
    assert.deepEqual(draft.groups.map(group => group.status), ['error', 'error'])
    assert.equal(JSON.stringify(draft).includes('PARTIAL_BATCH_MUST_NOT_BE_SAVED'), false)
    assert.deepEqual(f.snapshot(), before)
  }
})

test('a native batch output limit or empty response is an upstream error without content repair or automatic resubmission', async () => {
  for (const reason of ['length', 'stop']) {
    const f = fixture(), before = f.snapshot()
    const mock = nativeMock(f, call => call.stage === 'plan' ? plan(f) : sseResponse([
      sseChunk({ role: 'assistant', content: '' }),
      { ...sseChunk({}, reason), usage: { prompt_tokens: 30, completion_tokens: 16_384, total_tokens: 16_414, completion_tokens_details: { reasoning_tokens: 16_384 } } },
    ]))
    mock.dependencies.batchSize = 2
    const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
    assert.equal(result.status, 'needs_revision'); assert.equal(result.saved, 0)
    assert.equal(mock.calls.length, 2); assert.equal(result.result.repairCalls, 0)
    assert.deepEqual(store.get(result.draft_id!)!.groups.map(group => group.status), ['error', 'error'])
    assert.ok(result.issues.some(issue => issue.severity === 'error' && issue.field === 'provider'))
    assert.deepEqual(f.snapshot(), before)
  }
})

test('a sixteen-thousand-token model safely uses single groups even with default batching enabled', async () => {
  const f = fixture(), mock = nativeMock(f)
  delete (mock.dependencies as { batchSize?: 1 | 2 }).batchSize
  mock.dependencies.modelLimits.maxOutputTokens = 16_384
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues)); assert.equal(result.saved, 2)
  assert.equal(mock.calls.length, 3)
  assert.deepEqual(mock.calls.filter(call => call.stage === 'expand').map(call => call.payload.current_groups.length), [1, 1])
})

test('native outline plus one full creative call per non-nine-second group preserves fields and commits once at the end', async () => {
  const f = fixture(), before = f.snapshot(); let commits = 0
  const options = f.start('breakdown', undefined, phase => { if (phase === 'saving') { commits++; assert.deepEqual(f.snapshot(), before) } })
  const mock = nativeMock(f, call => { assert.deepEqual(f.snapshot(), before); return call.stage === 'plan' ? plan(f) : creative(f, call.payload.current_group.number) })
  const result = await runSkillStoryboardWorkflow(options, mock.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues)); assert.equal(result.saved, 2)
  assert.equal(result.result.modelCalls, 3); assert.equal(result.result.repairCalls, 0)
  assert.deepEqual(mock.calls.map(call => call.stage), ['plan', 'expand', 'expand'])
  assert.equal(mock.reads(), 1); assert.equal(commits, 1)
  assert.deepEqual(f.rows().map(row => row.duration), [10, 10])
  assert.deepEqual(mock.calls.slice(1).map(call => call.payload.current_group.duration), [10, 10])
  assert.deepEqual(mock.calls[0].payload.source_units.map((unit: any) => unit.id), [1, 2, 3, 4])
  assert.ok(mock.calls[2].payload.previous_ending.result.includes('@木杯'))
  for (const [index, row] of f.rows().entries()) {
    const expected = compileStoryboardReferences(creative(f, index + 1), f.assets).candidate!
    for (const [key, column] of [['title', 'title'], ['time', 'time'], ['location', 'location'], ['shot_type', 'shotType'], ['angle', 'angle'], ['movement', 'movement'], ['description', 'description'], ['result', 'result'], ['atmosphere', 'atmosphere'], ['image_prompt', 'imagePrompt'], ['video_prompt', 'videoPrompt'], ['bgm_prompt', 'bgmPrompt'], ['sound_effect', 'soundEffect']] as const) assert.equal((row as any)[column], (expected as any)[key], key)
    assert.ok(!row.videoPrompt?.includes('[['))
  }
  assert.equal(store.get(result.draft_id!)!.status, 'committed')
})

test('a twelve-second narrative outline leaves three-shot design to the creator and later prompt conversion cannot change it', async () => {
  const clauses = ['先把杯子轻放回原处。', '再沿着门槛慢慢走回来。', '最后站在桌边等我回应。']
  const original = clauses.join('')
  assert.equal([...original].filter(character => /[\p{L}\p{N}]/u.test(character)).length, 29)
  const f = fixture(`动作：${'晨光照入原有院墙，人物衣袖随步伐轻摆。'.repeat(4)}\n阿甲：${original}`)
  const budget = scriptTimingBudget(f.context().script!)
  assert.ok(budget.minimumSeconds <= 12 && budget.maximumSeconds >= 12)
  const c = `[[character:${f.character.id}]]`, s = `[[scene:${f.scene.id}]]`, p = `[[prop:${f.prop.id}]]`
  const full = { ...creative(f, 1), duration: 12, source_ids: [1, 2], time_row_counts: [1, 2, 1],
    description: `【镜头1】${c}从门槛向原木桌迈步，衣袖随步伐轻摆，晨光落在院墙，尚未开口。【镜头2】${c}在桌边停下，气息平稳，${c}说：「${clauses[0]}${clauses[1]}」【镜头3】${c}抬眼等待，${c}说：「${clauses[2]}」${p}始终留在原桌面。`,
    video_prompt: `出场人物：${c}；场景：${s}；道具：${p}。无字幕、无背景音乐，保留对白和必要音效；同一现实空间人物唯一，不出现克隆人，不越轴。\n0-3秒：${s}以门槛为原点A0，X轴向东，Y轴向北；${c}从门槛迈步，衣袖随步伐轻摆，院墙保持既有晨光，此时无对白。\n3-6秒：切到${c}在桌边停下的平视中景，${c}说：「${clauses[0]}」气息稳定，听感中年，低音区，音色温润，约每秒3字。\n6-9秒：同一机位承接，${c}说：「${clauses[1]}」气息平稳，听感中年，低音区，音色温润，约每秒3.4字。\n9-12秒：切到${c}抬眼等待的近景，${c}说：「${clauses[2]}」气息稳定，听感中年，低音区，音色温润，约每秒3.4字；${p}留在原桌面。` }
  const mock = nativeMock(f, call => {
    if (call.stage === 'plan') return { groups: [{ number: 1, title: full.title, beat: 'narrative', source_ids: [1, 2], scene_id: f.scene.id, duration: 12 }] }
    assert.equal(Object.hasOwn(call.payload.current_group, 'shot_count'), false)
    assert.ok(call.payload.timing_options.valid_time_row_counts.some((counts: number[]) => JSON.stringify(counts) === '[1,2,1]'))
    return full
  })
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues)); assert.equal(result.saved, 1)
  assert.deepEqual(mock.calls.map(call => call.stage), ['plan', 'expand'])
  assert.equal(result.result.repairCalls, 0)
  const live = f.rows()[0], expected = compileStoryboardReferences(full, f.assets).candidate!
  assert.equal(live.description, expected.description)
  assert.equal(live.description?.match(/【镜头\d】/gu)?.length, 3)
  assert.equal(live.videoPrompt, expected.video_prompt)
  assert.deepEqual((store.get(result.draft_id!)!.groups[0].candidate as any).data.time_row_counts, [1, 2, 1])
  const beforePrompt = f.snapshot()
  const prompt = nativeMock(f, call => {
    assert.equal(call.stage, 'prompt')
    return { video_prompt: full.video_prompt, time_row_counts: [2, 2] }
  })
  const invalidConversion = await runSkillStoryboardWorkflow(f.start('prompt', undefined, undefined, [live.id]), prompt.dependencies)
  assert.equal(invalidConversion.status, 'needs_revision'); assert.equal(invalidConversion.saved, 0)
  assert.deepEqual(prompt.calls.map(call => call.stage), ['prompt', 'prompt'])
  assert.ok(invalidConversion.issues.some(issue => issue.code === 'shot_time_mapping' && issue.message.includes('3个子镜头')))
  assert.deepEqual(f.snapshot(), beforePrompt, 'conversion cannot rewrite the approved three-shot description or any live field')
})

test('twice-invalid group retains readable drafts and later ready groups, then an explicit retry repairs only the failed group', async () => {
  const f = fixture(), before = f.snapshot()
  const first = nativeMock(f, call => call.stage === 'plan' ? plan(f) : call.payload.current_group.number === 1
    ? { ...creative(f, 1), result: '[[character:999]]仍保留完整末态正文。' } : creative(f, 2))
  const failed = await runSkillStoryboardWorkflow(f.start(), first.dependencies)
  assert.equal(failed.status, 'needs_revision'); assert.equal(failed.saved, 0)
  assert.deepEqual(first.calls.map(call => call.stage === 'plan' ? 'plan' : call.payload.current_group.number), ['plan', 1, 1, 2])
  assert.deepEqual(f.snapshot(), before)
  const draft = store.get(failed.draft_id!)!
  assert.deepEqual(draft.groups.map(group => group.status), ['needs_revision', 'ready'], JSON.stringify(draft.groups.map(group => ({ number: group.number, issues: group.issues }))))
  const readable = publicStoryboardDraft(draft)!
  assert.ok(readable.groups[0].candidate, 'an invalid reference must not hide the rest of the creative draft')
  assert.ok(JSON.stringify(readable.groups[0].candidate).includes('完整末态正文'))
  assert.equal(JSON.stringify(readable).includes('"raw"'), false)
  const second = nativeMock(f, call => { assert.equal(call.stage, 'expand', 'resume must not call the planner again'); assert.equal(call.payload.current_group.number, 1); return creative(f, 1) })
  const resumed = await runSkillStoryboardWorkflow(f.start(), second.dependencies)
  assert.equal(resumed.draft_id, failed.draft_id)
  assert.equal(resumed.status, 'done'); assert.equal(resumed.saved, 2)
  assert.equal(second.calls.length, 1)
  assert.deepEqual(store.get(resumed.draft_id!)!.groups.map(group => group.status), ['ready', 'ready'])
})

test('a repair conflict retains the complete rejected draft and manual resume repairs that original while skipping ready groups', async () => {
  const f = fixture(), before = f.snapshot()
  const firstBad = { ...creative(f, 1), result: `[[character:${f.character.id}]]保留初轮完整末态正文，[[prop:999]]的引用尚待处理。` }
  const firstPreview = compileStoryboardReferences(firstBad, f.assets).preview!
  const conflict = { conflict: '本组保留原词后仍需明确末态道具，请核对该素材。', field: 'result', source_ids: [1, 2] }
  const first = nativeMock(f, call => {
    assert.deepEqual(f.snapshot(), before, 'neither the bad draft nor the conflict may modify live data')
    if (call.stage === 'plan') return plan(f)
    if (call.payload.current_group.number === 2) return creative(f, 2)
    if (!call.payload.directed_repair) return firstBad
    assert.deepEqual(call.payload.directed_repair.rejected_submission, firstBad)
    assert.ok(call.payload.directed_repair.issues.some((issue: any) => issue.code === 'reference_unknown_id'))
    return conflict
  })
  const failed = await runSkillStoryboardWorkflow(f.start(), first.dependencies)
  assert.equal(failed.status, 'needs_revision'); assert.equal(failed.saved, 0)
  assert.deepEqual(first.calls.map(call => call.stage === 'plan' ? 'plan' : call.payload.current_group.number), ['plan', 1, 1, 2])
  assert.equal(failed.result.modelCalls, 4); assert.equal(failed.result.repairCalls, 1)
  const draft = store.get(failed.draft_id!)!
  assert.deepEqual(draft.groups.map(group => group.status), ['needs_revision', 'ready'])
  const retained = draft.groups[0].candidate as any
  assert.deepEqual(retained.raw, conflict)
  assert.deepEqual(retained.previous_raw, firstBad)
  assert.equal(retained.data, null, 'a retained preview must never become a submit-ready candidate')
  assert.deepEqual(retained.preview, firstPreview)
  const readable = publicStoryboardDraft(draft)!
  assert.equal((readable.groups[0].candidate as any).description, firstPreview.description)
  assert.equal((readable.groups[0].candidate as any).video_prompt, firstPreview.video_prompt)
  assert.ok((readable.groups[0].candidate as any).result.includes('保留初轮完整末态正文'))
  assert.ok(readable.groups[0].issues.some((issue: any) => issue.code === 'model_constraint_conflict' && issue.message === conflict.conflict))
  assert.equal(JSON.stringify(readable).includes('"previous_raw"'), false)
  assert.deepEqual(f.snapshot(), before)
  const readyGroup = structuredClone(draft.groups[1])
  const second = nativeMock(f, call => {
    assert.equal(call.stage, 'expand', 'manual resume reuses the approved plan')
    assert.equal(call.payload.current_group.number, 1, 'the other ready group must not be regenerated')
    assert.deepEqual(call.payload.directed_repair.rejected_submission, firstBad, 'repair receives the full rejected prose rather than the last conflict envelope')
    assert.ok(call.payload.directed_repair.issues.some((issue: any) => issue.code === 'model_constraint_conflict' && issue.message === conflict.conflict))
    return creative(f, 1)
  })
  const resumed = await runSkillStoryboardWorkflow(f.start(), second.dependencies)
  assert.equal(resumed.draft_id, failed.draft_id)
  assert.equal(resumed.status, 'done', JSON.stringify(resumed.issues)); assert.equal(resumed.saved, 2)
  assert.equal(second.calls.length, 1)
  assert.deepEqual(store.get(resumed.draft_id!)!.groups[1], readyGroup)
})

test('resume locally rechecks a complete historical dialogue checkpoint and only requests the unfinished group', async () => {
  const f = fixture(), before = f.snapshot()
  const first = nativeMock(f, call => call.stage === 'plan' ? plan(f) : call.payload.current_group.number === 1 ? creative(f, 1)
    : { conflict: '第二组尚未完成，需要继续创作。', field: 'description', source_ids: [3, 4] })
  const initial = await runSkillStoryboardWorkflow(f.start(), first.dependencies)
  assert.equal(initial.status, 'needs_revision'); assert.equal(initial.saved, 0)
  const checkpoint = store.get(initial.draft_id!)!, historical = checkpoint.groups[0]
  assert.equal(historical.status, 'ready')
  assert.ok((historical.candidate as any).data)
  store.saveGroup(checkpoint.id, { ...historical, status: 'needs_revision', issues: [
    { code: 'dialogue_preservation', field: 'video_prompt', severity: 'error', shotNumber: 1, message: '旧解析器未识别自然说话标记，待新版重查。' },
    { code: 'line_dialogue_budget', field: 'video_prompt', severity: 'error', shotNumber: 1, message: '旧额外逐行语速门禁，待新版重查。' },
  ] })
  assert.equal(store.get(checkpoint.id)!.fingerprint, checkpoint.fingerprint)
  const second = nativeMock(f, call => {
    assert.equal(call.stage, 'expand', 'the saved plan must be reused')
    assert.equal(call.payload.current_group.number, 2, 'the complete first group must be rechecked locally rather than rewritten')
    const rechecked = store.get(checkpoint.id)!.groups[0]
    assert.equal(rechecked.status, 'ready')
    assert.equal(rechecked.attempts, historical.attempts)
    assert.deepEqual(rechecked.candidate, historical.candidate)
    assert.equal(rechecked.issues.some((issue: any) => issue.severity === 'error'), false)
    assert.deepEqual(f.snapshot(), before)
    return creative(f, 2)
  })
  const resumed = await runSkillStoryboardWorkflow(f.start(), second.dependencies)
  assert.equal(resumed.draft_id, checkpoint.id)
  assert.equal(resumed.status, 'done', JSON.stringify(resumed.issues)); assert.equal(resumed.saved, 2)
  assert.equal(second.calls.length, 1); assert.equal(resumed.result.repairCalls, 0)
  const final = store.get(checkpoint.id)!
  assert.equal(final.fingerprint, checkpoint.fingerprint)
  assert.equal(final.groups[0].attempts, historical.attempts)
  assert.deepEqual(final.groups[0].candidate, historical.candidate)
  assert.equal(f.rows()[0].description, (historical.candidate as any).data.description)
})

test('a seeded global dialogue-coverage checkpoint still requires directed model repair even when local prose validates', async () => {
  const f = fixture(), before = f.snapshot()
  const first = nativeMock(f, call => call.stage === 'plan' ? plan(f) : call.payload.current_group.number === 1 ? creative(f, 1)
    : { conflict: '第二组尚未完成，需要继续创作。', field: 'description', source_ids: [3, 4] })
  const initial = await runSkillStoryboardWorkflow(f.start(), first.dependencies)
  assert.equal(initial.status, 'needs_revision')
  const checkpoint = store.get(initial.draft_id!)!, historical = checkpoint.groups[0]
  const globalIssue = { code: 'dialogue_coverage', field: 'source_ids.2', severity: 'error' as const, shotNumber: 1, message: '整集原文对白覆盖必须定向修正，不能用单组检查清除。' }
  store.saveGroup(checkpoint.id, { ...historical, status: 'needs_revision', issues: [globalIssue,
    { code: 'dialogue_preservation', field: 'video_prompt', severity: 'error', shotNumber: 1, message: '同时存在旧局部误判也不能忽略整集问题。' },
  ] })
  const second = nativeMock(f, call => {
    assert.equal(call.stage, 'expand')
    assert.deepEqual(f.snapshot(), before)
    if (call.payload.current_group.number === 1) {
      assert.deepEqual(call.payload.directed_repair.rejected_submission, (historical.candidate as any).raw)
      assert.ok(call.payload.directed_repair.issues.some((issue: any) => issue.code === 'dialogue_coverage' && issue.message === globalIssue.message))
    }
    return creative(f, call.payload.current_group.number)
  })
  const resumed = await runSkillStoryboardWorkflow(f.start(), second.dependencies)
  assert.equal(resumed.draft_id, checkpoint.id)
  assert.equal(resumed.status, 'done', JSON.stringify(resumed.issues)); assert.equal(resumed.saved, 2)
  assert.deepEqual(second.calls.map(call => call.payload.current_group.number), [1, 2], 'a global issue must not be skipped or cause replanning')
  assert.equal(store.get(checkpoint.id)!.groups[0].attempts, historical.attempts + 1)
})

test('source, user skill or live edits create a new version instead of reusing successful groups from another fingerprint', async () => {
  for (const changed of ['source', 'skill', 'live']) {
    const f = fixture()
    const makeFailure = (skills = originalSkills) => nativeMock(f, call => call.stage === 'plan' ? plan(f) : call.payload.current_group.number === 1 ? { ...creative(f, 1), image_prompt: '' } : creative(f, 2), skills)
    const first = makeFailure(), failed = await runSkillStoryboardWorkflow(f.start(), first.dependencies)
    assert.equal(failed.status, 'needs_revision')
    let skills = originalSkills
    if (changed === 'source') db.update(schema.episodes).set({ scriptContent: f.context().script + '原状态延续。' }).where(eq(schema.episodes.id, f.episode.id)).run()
    if (changed === 'skill') skills = { ...originalSkills, expand: originalSkills.expand + ' User changed this instruction.' }
    if (changed === 'live') db.update(schema.storyboards).set({ title: 'User edited live title' }).where(eq(schema.storyboards.id, f.old.id)).run()
    const second = makeFailure(skills), revised = await runSkillStoryboardWorkflow(f.start(), second.dependencies)
    assert.notEqual(revised.draft_id, failed.draft_id, changed)
    assert.equal(second.calls.filter(call => call.stage === 'plan').length, 1, changed)
    assert.ok(second.calls.some(call => call.stage === 'expand' && call.payload.current_group.number === 2), changed)
    assert.equal(store.get(failed.draft_id!)!.groups[1].status, 'ready', 'historical drafts are preserved')
  }
})

test('a complete checkpoint with correct original words and bindings can clear an obsolete global rejection without any model request', async () => {
  const f = fixture(), before = f.snapshot()
  const first = nativeMock(f, call => {
    if (call.stage === 'plan') return plan(f)
    const value = creative(f, call.payload.current_group.number)
    if (value.shot_number === 1) {
      value.description = value.description.replaceAll('你回来了。', '你终于回来了。')
      value.video_prompt = value.video_prompt.replaceAll('你回来了。', '你终于回来了。')
    }
    return value
  })
  const failed = await runSkillStoryboardWorkflow(f.start(), first.dependencies)
  assert.equal(failed.status, 'needs_revision'); assert.equal(failed.saved, 0)
  const draft = store.get(failed.draft_id!)!
  assert.ok(draft.groups.every(group => (group.candidate as any).data), 'full content exists for every group before whole-checkpoint review')
  const originalGroup = draft.groups[0], raw = creative(f, 1), compiled = compileStoryboardReferences(raw, f.assets)
  assert.ok(originalGroup.issues.some((issue: any) => issue.code === 'dialogue_coverage'))
  store.saveGroup(draft.id, { ...originalGroup, status: 'needs_revision', candidate: { raw, data: compiled.candidate, preview: compiled.preview } })
  const corrected = store.get(draft.id)!
  assert.equal(corrected.fingerprint, draft.fingerprint)
  assert.deepEqual(f.snapshot(), before)
  const second = nativeMock(f, () => { throw new Error('a fully valid checkpoint must not call a model') })
  const options = f.start()
  const review = options.session.reviewCompleteCandidates.bind(options.session)
  let reviews = 0
  options.session.reviewCompleteCandidates = candidates => {
    reviews++
    const report = structuredClone(options.session.getReport())
    const issues = review(candidates)
    assert.deepEqual(options.session.getReport(), report, 'review must not stage candidates in the original session')
    assert.deepEqual(f.snapshot(), before, 'whole-checkpoint review must not write live data')
    return issues
  }
  const resumed = await runSkillStoryboardWorkflow(options, second.dependencies)
  assert.equal(resumed.draft_id, draft.id)
  assert.equal(resumed.status, 'done', JSON.stringify(resumed.issues)); assert.equal(resumed.saved, 2)
  assert.equal(reviews, 1); assert.equal(second.calls.length, 0)
  assert.equal(resumed.result.modelCalls, 0); assert.equal(resumed.result.repairCalls, 0)
  const committed = store.get(draft.id)!
  assert.equal(committed.status, 'committed')
  assert.deepEqual(committed.groups.map(group => group.attempts), corrected.groups.map(group => group.attempts))
  assert.deepEqual(committed.groups.map(group => group.candidate), corrected.groups.map(group => group.candidate))
  assert.equal(f.rows()[0].description, compiled.candidate!.description)
  assert.equal(f.rows()[0].videoPrompt, compiled.candidate!.video_prompt)
})

test('a true original-dialogue mismatch survives whole-checkpoint review and repairs only its actual group', async () => {
  const f = fixture(), before = f.snapshot()
  const first = nativeMock(f, call => {
    if (call.stage === 'plan') return plan(f)
    const value = creative(f, call.payload.current_group.number)
    if (value.shot_number === 1) {
      value.description = value.description.replaceAll('你回来了。', '你终于回来了。')
      value.video_prompt = value.video_prompt.replaceAll('你回来了。', '你终于回来了。')
    }
    return value
  })
  const failed = await runSkillStoryboardWorkflow(f.start(), first.dependencies)
  assert.equal(failed.status, 'needs_revision'); assert.equal(failed.saved, 0)
  assert.equal(first.calls.length, 3, 'global comparison does not secretly launch another model call')
  assert.ok(failed.issues.some(issue => issue.code === 'dialogue_coverage' && issue.shotNumber === 1))
  const checkpoint = store.get(failed.draft_id!)!
  assert.deepEqual(checkpoint.groups.map(group => group.status), ['needs_revision', 'ready'])
  assert.ok(checkpoint.groups.every(group => (group.candidate as any).data), 'both descriptions and prompts are locally valid complete prose')
  const readyGroup = structuredClone(checkpoint.groups[1])
  assert.deepEqual(f.snapshot(), before)
  const second = nativeMock(f, call => { assert.equal(call.stage, 'expand'); assert.equal(call.payload.current_group.number, 1); return creative(f, 1) })
  const resumed = await runSkillStoryboardWorkflow(f.start(), second.dependencies)
  assert.equal(resumed.status, 'done', JSON.stringify(resumed.issues))
  assert.equal(resumed.draft_id, failed.draft_id)
  assert.equal(second.calls.length, 1)
  assert.deepEqual(store.get(resumed.draft_id!)!.groups[1], readyGroup)
})

test('a conflicting plan gets one focused repair but never unfolds creative groups or changes live data', async () => {
  const f = fixture(), before = f.snapshot()
  const mock = nativeMock(f, call => { assert.equal(call.stage, 'plan'); const value = plan(f); value.groups.forEach(group => { group.duration = 15 }); return value })
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'needs_revision'); assert.equal(result.saved, 0)
  assert.equal(mock.calls.length, 2)
  assert.ok(result.issues.some(issue => issue.code === 'constraint_conflict' && issue.severity === 'error'))
  assert.deepEqual(f.snapshot(), before)
  assert.deepEqual(store.get(result.draft_id!)!.groups, [])
})

test('an explicit planning conflict is a legal one-call report with no invented plan, schema noise or automatic repair', async () => {
  const f = fixture(), before = f.snapshot()
  const conflict = { conflict: '原文动作与指定时长无法同时保留，需先明确约束。', field: 'duration', source_ids: [1, 2, 3, 4] }
  const mock = nativeMock(f, call => { assert.equal(call.stage, 'plan'); return conflict })
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'needs_revision'); assert.equal(result.saved, 0)
  assert.equal(mock.calls.length, 1); assert.equal(result.result.modelCalls, 1); assert.equal(result.result.repairCalls, 0)
  assert.ok(result.issues.some(issue => issue.code === 'model_constraint_conflict' && issue.message === conflict.conflict))
  assert.equal(result.issues.some(issue => issue.code === 'narrative_plan_schema'), false, 'a conflict is not an incomplete groups response')
  const draft = store.get(result.draft_id!)!
  assert.equal(draft.status, 'needs_revision'); assert.deepEqual(draft.groups, [])
  assert.equal((publicStoryboardDraft(draft)!.plan as any).conflict, conflict.conflict)
  assert.deepEqual(f.snapshot(), before)
})

test('an explicit expansion conflict gets one call for that group and retains its explanation without fabricating prose', async () => {
  const f = fixture(), before = f.snapshot()
  const conflict = { conflict: '本组原词与锁定镜头无法同时容纳，需要人工明确节奏。', field: 'description', source_ids: [1, 2] }
  const mock = nativeMock(f, call => call.stage === 'plan' ? plan(f) : call.payload.current_group.number === 1 ? conflict : creative(f, 2))
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'needs_revision'); assert.equal(result.saved, 0)
  assert.deepEqual(mock.calls.map(call => call.stage === 'plan' ? 'plan' : call.payload.current_group.number), ['plan', 1, 2])
  assert.equal(result.result.repairCalls, 0)
  const readable = publicStoryboardDraft(store.get(result.draft_id!)!)!
  assert.deepEqual(readable.groups.map(group => group.status), ['needs_revision', 'ready'])
  assert.equal(readable.groups[0].candidate, null, 'conflict transport does not synthesize a complete storyboard')
  assert.ok((readable.groups[0].issues as any[]).some(issue => issue.code === 'model_constraint_conflict' && issue.message === conflict.conflict))
  assert.deepEqual(f.snapshot(), before)
})

test('provider failure is recorded once without streaming fallback, content repair or resubmitting the same request', async () => {
  const f = fixture(), before = f.snapshot()
  const mock = nativeMock(f, call => call.stage === 'plan' ? plan(f) : Response.json({ error: { message: 'Offline Gateway Timeout', type: 'server_error' } }, { status: 504 }))
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'needs_revision'); assert.equal(result.saved, 0)
  assert.deepEqual(mock.calls.map(call => call.stage), ['plan', 'expand'])
  assert.equal(result.result.repairCalls, 0)
  assert.ok(result.issues.some(issue => issue.code === 'upstream_http_504'))
  assert.deepEqual(f.snapshot(), before)
})

for (const failure of ['connection-reset', 'error-event'] as const) test(`SSE ${failure} rejects even complete JSON and retains the previous draft without fallback or another repair`, async () => {
  const f = fixture(), before = f.snapshot()
  const firstBad = { ...creative(f, 2), result: `[[character:${f.character.id}]]保留STREAM_FIRST_BAD正文，引用[[prop:999]]尚待处理。` }
  const firstPreview = compileStoryboardReferences(firstBad, f.assets).preview!
  const mock = nativeMock(f, call => {
    if (call.stage === 'plan') return plan(f)
    if (call.payload.current_group.number === 1) return creative(f, 1)
    if (!call.payload.directed_repair) return firstBad
    const completeButUnfinished = JSON.stringify({ output: { ...creative(f, 2), result: 'UNFINISHED_STREAM_MUST_NOT_REPLACE_THE_DRAFT' } })
    if (failure === 'connection-reset') return interruptedSseResponse(completeButUnfinished)
    return sseResponse([sseChunk({ role: 'assistant', content: completeButUnfinished }),
      { error: { message: 'offline stream halted before finish', type: 'server_error', code: 'offline_stream_error' } }])
  })
  const failed = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(failed.status, 'needs_revision'); assert.equal(failed.saved, 0)
  assert.deepEqual(mock.calls.map(call => call.stage === 'plan' ? 'plan' : call.payload.current_group.number), ['plan', 1, 2, 2])
  assert.equal(failed.result.modelCalls, 4); assert.equal(failed.result.repairCalls, 1)
  assert.ok(failed.issues.some(issue => issue.field === 'provider' && issue.severity === 'error'))
  const draft = store.get(failed.draft_id!)!
  assert.deepEqual(draft.groups.map(group => group.status), ['ready', 'error'])
  const retained = draft.groups[1].candidate as any
  assert.deepEqual(retained.raw, firstBad)
  assert.deepEqual(retained.preview, firstPreview)
  assert.equal(retained.data, null)
  assert.ok((publicStoryboardDraft(draft)!.groups[1].candidate as any).result.includes('STREAM_FIRST_BAD'))
  assert.equal(JSON.stringify(draft).includes('UNFINISHED_STREAM_MUST_NOT_REPLACE_THE_DRAFT'), false)
  assert.deepEqual(f.snapshot(), before)
})

test('a late SSE body after its request deadline cannot replace checkpoints or submit complete live data', async () => {
  const f = fixture(), before = f.snapshot(), encoder = new TextEncoder()
  let lateBody: Promise<void> | undefined
  const mock = nativeMock(f, call => {
    if (call.stage === 'plan') return plan(f)
    if (call.payload.current_group.number === 1) {
      dependencies.requestTimeoutMs = 100
      return creative(f, 1)
    }
    const content = JSON.stringify({ output: { ...creative(f, 2), result: 'LATE_SSE_BODY_MUST_NOT_BE_SAVED' } })
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(sseChunk({ role: 'assistant', content: content.slice(0, 47) }))}\n\n`))
      lateBody = new Promise(resolve => setTimeout(() => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(sseChunk({ content: content.slice(47) }))}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(sseChunk({}, 'stop'))}\n\ndata: [DONE]\n\n`))
          controller.close()
        } catch { /* A native consumer may cancel the test stream on abort. */ }
        resolve()
      }, 250))
    } }), { headers: { 'Content-Type': 'text/event-stream' } })
  })
  const dependencies = { ...mock.dependencies, timeoutMs: 10_000, requestTimeoutMs: 5_000 }
  const failed = await runSkillStoryboardWorkflow(f.start(), dependencies)
  assert.equal(failed.status, 'needs_revision'); assert.equal(failed.saved, 0)
  assert.equal(mock.calls.length, 3); assert.equal(failed.result.repairCalls, 0)
  const saved = store.get(failed.draft_id!)!
  assert.deepEqual(saved.groups.map(group => group.status), ['ready', 'error'])
  assert.deepEqual(f.snapshot(), before)
  await lateBody
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(store.get(failed.draft_id!)!, saved)
  assert.equal(JSON.stringify(saved).includes('LATE_SSE_BODY_MUST_NOT_BE_SAVED'), false)
  assert.equal(mock.calls.length, 3)
  assert.deepEqual(f.snapshot(), before)
})

test('abort closes the workflow before an ignored late provider response can stage or write live data', async () => {
  const f = fixture(), before = f.snapshot(), controller = new AbortController()
  let late: Promise<unknown> | undefined
  const mock = nativeMock(f, call => {
    if (call.stage === 'plan') return plan(f)
    late = new Promise(resolve => setTimeout(() => resolve(creative(f, call.payload.current_group.number)), 60))
    controller.abort(new Error('offline user cancelled'))
    return late
  })
  const result = await runSkillStoryboardWorkflow(f.start('breakdown', controller.signal), mock.dependencies)
  assert.equal(result.status, 'needs_revision'); assert.equal(result.saved, 0)
  await late
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(mock.calls.length, 2)
  assert.deepEqual(f.snapshot(), before)
  assert.equal(store.get(result.draft_id!)!.status, 'interrupted')
})

test('an individual request timeout preserves prior ready groups and rejects a late response without automatic resubmission', async () => {
  const f = fixture(), before = f.snapshot(), outer = new AbortController()
  let late: Promise<unknown> | undefined
  const mock = nativeMock(f, call => {
    if (call.stage === 'plan') return plan(f)
    if (call.payload.current_group.number === 1) {
      dependencies.requestTimeoutMs = 500
      return creative(f, 1)
    }
    late = new Promise(resolve => setTimeout(() => resolve({ ...creative(f, 2), result: 'LATE_REQUEST_SHOULD_NOT_BE_SAVED' }), 1000))
    return late
  })
  const dependencies = { ...mock.dependencies, timeoutMs: 10_000, requestTimeoutMs: 5_000 }
  const result = await runSkillStoryboardWorkflow(f.start('breakdown', outer.signal), dependencies)
  assert.equal(result.status, 'needs_revision'); assert.equal(result.saved, 0)
  assert.equal(result.result.modelCalls, 3); assert.equal(result.result.repairCalls, 0)
  assert.deepEqual(mock.calls.map(call => call.stage === 'plan' ? 'plan' : call.payload.current_group.number), ['plan', 1, 2])
  assert.equal(outer.signal.aborted, false, 'a request deadline does not abort the caller signal')
  assert.equal(mock.calls[2].signal?.aborted, true)
  const preserved = store.get(result.draft_id!)!
  assert.deepEqual(preserved.groups.map(group => group.status), ['ready', 'error'])
  assert.deepEqual(f.snapshot(), before)
  await late
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(store.get(result.draft_id!)!, preserved, 'the response cannot overwrite either checkpoint after its request deadline')
  assert.equal(JSON.stringify(preserved).includes('LATE_REQUEST_SHOULD_NOT_BE_SAVED'), false)
  assert.equal(mock.calls.length, 3)
  assert.deepEqual(f.snapshot(), before)
})

test('a repair that outlives the workflow deadline keeps the first bad response and preview beside earlier ready groups', async () => {
  const f = fixture(), before = f.snapshot()
  const firstBad = { ...creative(f, 2), result: `[[character:${f.character.id}]]保留FIRST_BAD_RESPONSE末态，指向[[character:999]]。` }
  let late: Promise<unknown> | undefined, whileRepairing: any
  const mock = nativeMock(f, call => {
    if (call.stage === 'plan') return plan(f)
    if (call.payload.current_group.number === 1) return creative(f, 1)
    if (!call.payload.directed_repair) return firstBad
    whileRepairing = store.latest(f.episode.id)!.groups.find(group => group.number === 2)
    late = new Promise(resolve => setTimeout(() => resolve({ ...creative(f, 2), result: 'LATE_REPAIR_SHOULD_NOT_BE_SAVED' }), 2000))
    return late
  })
  const result = await runSkillStoryboardWorkflow(f.start(), { ...mock.dependencies, timeoutMs: 1500, requestTimeoutMs: 5000 })
  assert.equal(result.status, 'needs_revision'); assert.equal(result.saved, 0)
  assert.deepEqual(mock.calls.map(call => call.stage === 'plan' ? 'plan' : call.payload.current_group.number), ['plan', 1, 2, 2])
  assert.equal(result.result.repairCalls, 1)
  assert.equal(whileRepairing.status, 'generating')
  assert.deepEqual(whileRepairing.candidate.raw, firstBad)
  assert.ok(whileRepairing.candidate.preview.result.includes('@阿甲保留FIRST_BAD_RESPONSE'))
  assert.ok(whileRepairing.issues.some((issue: any) => issue.code === 'reference_unknown_id'))
  const saved = store.get(result.draft_id!)!
  assert.equal(saved.status, 'interrupted')
  assert.equal(saved.groups[0].status, 'ready')
  const second = saved.groups.find(group => group.number === 2)!
  assert.deepEqual((second.candidate as any).raw, firstBad)
  assert.deepEqual((second.candidate as any).preview, whileRepairing.candidate.preview)
  assert.ok((second.issues as any[]).some(issue => issue.code === 'reference_unknown_id'))
  assert.deepEqual(f.snapshot(), before)
  await late
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(store.get(result.draft_id!)!, saved)
  assert.equal(JSON.stringify(saved).includes('LATE_REPAIR_SHOULD_NOT_BE_SAVED'), false)
  assert.equal(mock.calls.length, 4)
  assert.deepEqual(f.snapshot(), before)
})

test('failure to commit the durable draft status rolls back the entire live episode transaction', async () => {
  const f = fixture(), before = f.snapshot(), mock = nativeMock(f)
  const originalSetStatus = store.setStatus.bind(store)
  store.setStatus = ((id: string, status: any, lease?: string) => {
    if (status === 'committed') throw new Error('offline draft commit fault')
    return originalSetStatus(id, status, lease)
  }) as typeof store.setStatus
  try {
    const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
    assert.equal(result.status, 'needs_revision'); assert.equal(result.saved, 0)
    assert.ok(result.issues.some(issue => issue.code === 'commit_failed'))
    assert.equal(mock.calls.length, 3)
    assert.deepEqual(f.snapshot(), before)
    assert.notEqual(store.get(result.draft_id!)!.status, 'committed')
  } finally { store.setStatus = originalSetStatus }
})

test('prompt mode compiles only the requested video prompt and retains every locked storyboard field and binding', async () => {
  const f = fixture(), full = compileStoryboardReferences(creative(f, 1), f.assets).candidate!
  db.update(schema.storyboards).set({ title: full.title, time: full.time, location: full.location, shotType: full.shot_type, angle: full.angle, movement: full.movement,
    storyboardNumber: 2, description: full.description, result: full.result, atmosphere: full.atmosphere, imagePrompt: full.image_prompt, bgmPrompt: full.bgm_prompt, soundEffect: full.sound_effect, videoPrompt: 'Old video prompt', duration: 10 }).where(eq(schema.storyboards.id, f.old.id)).run()
  const previous = db.insert(schema.storyboards).values({ episodeId: f.episode.id, storyboardNumber: 1, title: 'Previous live shot', description: '前镜末态：杯子已在桌面。', videoPrompt: 'Previous prompt', result: 'Previous ending marker', duration: 10, ...timestamps }).returning().get()
  const next = db.insert(schema.storyboards).values({ episodeId: f.episode.id, storyboardNumber: 3, title: 'Next live shot', description: '后镜初态：人物仍在门边。', videoPrompt: 'Next prompt', result: 'Next ending marker', duration: 10, ...timestamps }).returning().get()
  const before = f.snapshot(), mock = nativeMock(f)
  const result = await runSkillStoryboardWorkflow(f.start('prompt'), mock.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues)); assert.equal(result.saved, 1)
  assert.deepEqual(mock.calls.map(call => call.stage), ['prompt'])
  assert.equal(mock.calls[0].payload.previous_ending.id, previous.id)
  assert.equal(mock.calls[0].payload.adjacent_next.id, next.id)
  const after = f.snapshot()
  const omitPrompt = ({ videoPrompt: _prompt, updatedAt: _updated, ...row }: any) => row
  assert.deepEqual(after.rows.map(omitPrompt), before.rows.map(omitPrompt))
  assert.equal(after.rows[0].videoPrompt, full.video_prompt)
  assert.deepEqual(after.characters, before.characters); assert.deepEqual(after.props, before.props)
  assert.deepEqual(after.episode, before.episode)
})

test('reversing two prompt targets creates a new version and never reuses a ready group for the wrong target', async () => {
  const f = fixture(), firstFull = compileStoryboardReferences(creative(f, 1), f.assets).candidate!, secondFull = compileStoryboardReferences(creative(f, 2), f.assets).candidate!
  const fields = (full: typeof firstFull) => ({ title: full.title, time: full.time, location: full.location, shotType: full.shot_type, angle: full.angle, movement: full.movement,
    storyboardNumber: full.shot_number, description: full.description, result: full.result, atmosphere: full.atmosphere, imagePrompt: full.image_prompt,
    bgmPrompt: full.bgm_prompt, soundEffect: full.sound_effect, duration: full.duration, sceneId: full.scene_id })
  db.update(schema.storyboards).set({ ...fields(firstFull), videoPrompt: 'Original target A video' }).where(eq(schema.storyboards.id, f.old.id)).run()
  const other = db.insert(schema.storyboards).values({ ...fields(secondFull), episodeId: f.episode.id, videoPrompt: 'Original target B video', ...timestamps }).returning().get()
  db.insert(schema.storyboardCharacters).values({ storyboardId: other.id, characterId: f.character.id }).run()
  db.insert(schema.storyboardProps).values({ storyboardId: other.id, propId: f.prop.id }).run()
  const before = f.snapshot()
  const first = nativeMock(f, call => {
    assert.equal(call.stage, 'prompt')
    return call.payload.locked_storyboard.id === f.old.id ? { video_prompt: creative(f, 1).video_prompt, time_row_counts: [2, 2] }
      : { conflict: '目标B尚未完成，请稍后继续。', field: 'video_prompt', source_ids: [] }
  })
  const failed = await runSkillStoryboardWorkflow(f.start('prompt', undefined, undefined, [f.old.id, other.id]), first.dependencies)
  assert.equal(failed.status, 'needs_revision'); assert.equal(failed.saved, 0)
  assert.deepEqual(first.calls.map(call => call.payload.locked_storyboard.id), [f.old.id, other.id])
  const oldDraft = store.get(failed.draft_id!)!
  assert.deepEqual(oldDraft.groups.map(group => group.status), ['ready', 'needs_revision'])
  assert.deepEqual(f.snapshot(), before)
  const second = nativeMock(f, call => {
    assert.equal(call.stage, 'prompt')
    return { video_prompt: creative(f, call.payload.locked_storyboard.id === f.old.id ? 1 : 2).video_prompt, time_row_counts: [2, 2] }
  })
  const reversed = await runSkillStoryboardWorkflow(f.start('prompt', undefined, undefined, [other.id, f.old.id]), second.dependencies)
  assert.notEqual(reversed.draft_id, failed.draft_id, 'scope-set equality must not reuse positional group-to-target mapping')
  assert.equal(reversed.status, 'done', JSON.stringify(reversed.issues)); assert.equal(reversed.saved, 2)
  assert.deepEqual(second.calls.map(call => call.payload.locked_storyboard.id), [other.id, f.old.id])
  assert.notEqual(store.get(reversed.draft_id!)!.fingerprint, oldDraft.fingerprint)
  assert.deepEqual(store.get(failed.draft_id!)!, oldDraft, 'the earlier version is retained rather than rebound to reversed IDs')
  const after = f.snapshot()
  assert.equal(after.rows.find(row => row.id === f.old.id)!.videoPrompt, firstFull.video_prompt)
  assert.equal(after.rows.find(row => row.id === other.id)!.videoPrompt, secondFull.video_prompt)
  const omitPrompt = ({ videoPrompt: _prompt, updatedAt: _updated, ...row }: any) => row
  assert.deepEqual(after.rows.map(omitPrompt), before.rows.map(omitPrompt))
  assert.deepEqual(after.characters, before.characters); assert.deepEqual(after.props, before.props)
  assert.deepEqual(after.episode, before.episode)
})

test('automatic completion is the production default with direct DeepSeek planning and bounded low-thinking creative requests', async () => {
  const f = fixture(), before = f.snapshot(); let commits = 0
  const options = f.start('breakdown', undefined, phase => { if (phase === 'saving') { commits++; assert.deepEqual(f.snapshot(), before) } })
  const mock = automatic(nativeMock(f))
  const result = await runSkillStoryboardWorkflow(options, mock.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues)); assert.equal(result.saved, 2)
  assert.deepEqual(mock.calls.map(call => call.stage === 'plan' ? 'plan' : call.payload.current_group.number), ['plan', 1, 2])
  for (const call of mock.calls) {
    assert.equal(call.execution?.thinking, call.stage === 'plan' ? 'disabled' : 'low')
    assert.equal(call.execution?.maxOutputTokens, call.stage === 'plan' ? 16_384 : 32_768)
    assert.equal(call.execution?.profile, call.stage === 'plan' ? 'direct' : 'standard')
  }
  assert.equal(commits, 1)
  assert.equal(store.get(result.draft_id!)!.status, 'committed')
  for (const [index, row] of f.rows().entries()) {
    const full = compileStoryboardReferences(creative(f, index + 1), f.assets).candidate!
    assert.equal(row.description, full.description); assert.equal(row.videoPrompt, full.video_prompt)
    assert.equal(row.result, full.result); assert.equal(row.imagePrompt, full.image_prompt)
  }
})

test('one click recovers a native length, empty, malformed or interrupted response and finishes later groups without transport fallback', async () => {
  for (const variant of ['length', 'empty', 'malformed', 'disconnected', 'gateway']) {
    const f = fixture(), before = f.snapshot(); let firstGroupCalls = 0
    const mock = automatic(nativeMock(f, call => {
      assert.deepEqual(f.snapshot(), before)
      if (call.stage === 'plan') return plan(f)
      const number = call.payload.current_group.number
      if (number === 1 && ++firstGroupCalls === 1) {
        if (variant === 'length' || variant === 'empty') return noBodyResponse(variant === 'length' ? 'length' : 'stop')
        if (variant === 'malformed') return '{"output":'
        if (variant === 'disconnected') return interruptedSseResponse('{"output":{"title":"UNFINISHED_STREAM_IS_NOT_A_DRAFT"')
        return new Response(JSON.stringify({ error: { message: 'Transient offline gateway', type: 'server_error' } }), { status: 504, headers: { 'Content-Type': 'application/json' } })
      }
      return creative(f, number)
    }))
    const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
    assert.equal(result.status, 'done', `${variant}: ${JSON.stringify(result.issues)}`); assert.equal(result.saved, 2)
    assert.deepEqual(mock.calls.map(call => call.stage === 'plan' ? 'plan' : call.payload.current_group.number), ['plan', 1, 1, 2], variant)
    assert.ok(mock.calls.every(call => call.body.stream === true), variant)
    const retry = mock.calls[2]
    assert.deepEqual(retry.payload.current_groups, mock.calls[1].payload.current_groups)
    assert.deepEqual(retry.payload.source_units, mock.calls[1].payload.source_units)
    if (variant !== 'malformed') {
      assert.equal(retry.execution?.thinking, 'disabled', variant)
      assert.equal(retry.execution?.profile, 'recovery', variant)
    }
    if (variant === 'length' || variant === 'empty') assert.equal(retry.execution?.maxOutputTokens, 32_768, variant)
    if (variant === 'length') {
      const measured = result.result.requestStats.filter(stat => stat.groups.includes(1))
      assert.equal(measured.length, 2)
      assert.equal(measured[0].finishReason, 'length')
      assert.equal(measured[0].outputCharacters, 0)
      assert.equal(measured[0].reasoningTokens, 16_384)
      assert.equal(measured[1].finishReason, 'stop')
      assert.ok(measured[1].outputCharacters! > 0)
    }
    assert.equal(JSON.stringify(store.get(result.draft_id!)).includes('UNFINISHED_STREAM_IS_NOT_A_DRAFT'), false)
    assert.equal(store.get(result.draft_id!)!.status, 'committed')
  }
})

test('automatic recovery enlarges a non-DeepSeek output budget without falsely claiming its official thinking was disabled', async () => {
  const f = fixture(); let attempts = 0
  const mock = automatic(nativeMock(f, call => call.stage === 'plan' ? plan(f)
    : call.payload.current_group.number === 1 && ++attempts === 1 ? noBodyResponse('length') : creative(f, call.payload.current_group.number)),
  { provider: 'openai', model: 'gpt-6.1-sol', baseURL: 'https://api.openai.com/v1' })
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues))
  assert.notEqual(mock.calls[1].execution?.thinking, 'disabled')
  assert.notEqual(mock.calls[2].execution?.thinking, 'disabled')
  assert.equal(mock.calls[2].execution?.profile, 'recovery')
  assert.equal(mock.calls[2].execution?.maxOutputTokens, 32_768)
})

test('an exhausted local group does not block a later group and automatic finishing repairs only that incomplete group', async () => {
  const f = fixture(), before = f.snapshot(); let firstAttempts = 0, readySecond: any
  const mock = automatic(nativeMock(f, call => {
    assert.deepEqual(f.snapshot(), before)
    if (call.stage === 'plan') return plan(f)
    if (call.payload.current_group.number === 2) return creative(f, 2)
    firstAttempts++
    if (firstAttempts < 3) return { ...creative(f, 1), result: '[[prop:999]]保留全部初稿末态，但此引用需要修复。' }
    const groups = store.latest(f.episode.id)!.groups
    assert.equal(groups[1].status, 'ready', 'later groups finish before the failed group enters automatic finishing')
    readySecond = structuredClone(groups[1])
    assert.ok(call.payload.directed_repair.issues.some((issue: any) => issue.code === 'reference_unknown_id'))
    assert.equal(call.execution?.thinking, 'low', 'content finishing retains thought for shot-to-time mapping')
    assert.equal(call.execution?.maxOutputTokens, 32_768)
    return creative(f, 1)
  }))
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues)); assert.equal(result.saved, 2)
  assert.deepEqual(mock.calls.map(call => call.stage === 'plan' ? 'plan' : call.payload.current_group.number), ['plan', 1, 1, 2, 1])
  assert.deepEqual(store.get(result.draft_id!)!.groups[1], readySecond)
  assert.deepEqual(store.get(result.draft_id!)!.groups.map(group => group.attempts), [3, 1])
})

test('automatic completion repairs a whole-episode dialogue mismatch before the only live transaction', async () => {
  const f = fixture(), before = f.snapshot(); let firstAttempts = 0, commits = 0, finishCalls = 0, reviews = 0
  const options = f.start('breakdown', undefined, phase => { if (phase === 'saving') { commits++; assert.deepEqual(f.snapshot(), before) } })
  const finish = options.session.finish.bind(options.session)
  options.session.finish = async () => { finishCalls++; return finish() }
  const review = options.session.reviewCompleteCandidates.bind(options.session)
  options.session.reviewCompleteCandidates = candidates => { reviews++; assert.deepEqual(f.snapshot(), before); return review(candidates) }
  const mock = automatic(nativeMock(f, call => {
    assert.deepEqual(f.snapshot(), before)
    if (call.stage === 'plan') return plan(f)
    const number = call.payload.current_group.number, value = creative(f, number)
    if (number === 1 && ++firstAttempts === 1) {
      value.description = value.description.replaceAll('你回来了。', '你终于回来了。')
      value.video_prompt = value.video_prompt.replaceAll('你回来了。', '你终于回来了。')
    } else if (number === 1) {
      assert.ok(call.payload.directed_repair.issues.some((issue: any) => issue.code === 'dialogue_coverage'))
      assert.equal(store.latest(f.episode.id)!.groups[1].status, 'ready')
    }
    return value
  }))
  const result = await runSkillStoryboardWorkflow(options, mock.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues)); assert.equal(result.saved, 2)
  assert.deepEqual(mock.calls.map(call => call.stage === 'plan' ? 'plan' : call.payload.current_group.number), ['plan', 1, 2, 1])
  assert.ok(reviews >= 2); assert.equal(finishCalls, 1); assert.equal(commits, 1)
  assert.ok(f.rows()[0].videoPrompt!.includes('你回来了。'))
  assert.equal(f.rows()[0].videoPrompt!.includes('你终于回来了。'), false)
})

test('a whole-review shot number selects only that group and source IDs are used only when no shot number is available', async () => {
  for (const numbered of [true, false]) {
    const f = fixture(); let reviews = 0
    const options = f.start(), review = options.session.reviewCompleteCandidates.bind(options.session)
    options.session.reviewCompleteCandidates = candidates => {
      const issues = review(candidates)
      return ++reviews === 1 ? [...issues,
        { code: 'dialogue_coverage', field: 'source_ids.3', ...(numbered ? { shotNumber: 1 } : {}), severity: 'error', message: 'The first source boundary needs correction.' },
        { code: 'dialogue_coverage', field: 'source_ids.4', ...(numbered ? { shotNumber: 1 } : {}), severity: 'error', message: 'The second source boundary also needs correction.' },
      ] : issues
    }
    const mock = automatic(nativeMock(f, call => {
      if (call.stage === 'plan') return plan(f)
      if (call.payload.directed_repair) {
        assert.ok(call.payload.directed_repair.issues.some((issue: any) => issue.message === 'The first source boundary needs correction.'))
        assert.ok(call.payload.directed_repair.issues.some((issue: any) => issue.message === 'The second source boundary also needs correction.'))
      }
      return creative(f, call.payload.current_group.number)
    }))
    const result = await runSkillStoryboardWorkflow(options, mock.dependencies)
    assert.equal(result.status, 'done', JSON.stringify(result.issues))
    assert.deepEqual(mock.calls.map(call => call.stage === 'plan' ? 'plan' : call.payload.current_group.number), ['plan', 1, 2, numbered ? 1 : 2])
    assert.deepEqual(store.get(result.draft_id!)!.groups.map(group => group.attempts), numbered ? [2, 1] : [1, 2])
  }
})

test('automatic local retries are bounded to four real requests per group and preserve later ready prose', async () => {
  const f = fixture(), before = f.snapshot()
  const mock = automatic(nativeMock(f, call => call.stage === 'plan' ? plan(f)
    : call.payload.current_group.number === 1 ? noBodyResponse('length') : creative(f, 2)))
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'needs_revision'); assert.equal(result.saved, 0)
  const groups = mock.calls.filter(call => call.stage === 'expand').map(call => call.payload.current_group.number)
  assert.equal(groups.filter(number => number === 1).length, 4)
  assert.equal(groups.filter(number => number === 2).length, 1)
  assert.ok(groups.indexOf(2) < groups.lastIndexOf(1), 'a local output limit must not stop or starve later groups')
  const draft = store.get(result.draft_id!)!
  assert.equal(draft.groups[1].status, 'ready'); assert.equal(draft.groups[1].attempts, 1)
  assert.ok((draft.groups[1].candidate as any).data.video_prompt.includes('我一直都在。'))
  assert.deepEqual(f.snapshot(), before)
})

test('an explicit conflict and an authentication failure are not repeatedly rewritten by automatic completion', async () => {
  for (const variant of ['conflict', 'authentication']) {
    const f = fixture(), before = f.snapshot()
    const mock = automatic(nativeMock(f, call => {
      if (call.stage === 'plan') return plan(f)
      if (call.payload.current_group.number === 2) return creative(f, 2)
      return variant === 'conflict' ? { conflict: 'Current source cannot satisfy this fixed constraint without inventing facts.', field: 'description', source_ids: [1, 2] }
        : new Response(JSON.stringify({ error: { message: 'Invalid offline credentials', type: 'authentication_error' } }), { status: 401, headers: { 'Content-Type': 'application/json' } })
    }))
    const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
    assert.equal(result.status, 'needs_revision'); assert.equal(result.saved, 0)
    const groups = mock.calls.filter(call => call.stage === 'expand').map(call => call.payload.current_group.number)
    assert.deepEqual(groups, variant === 'conflict' ? [1, 2] : [1], variant)
    assert.deepEqual(f.snapshot(), before)
  }
})

test('three consecutive failed provider asks trip the circuit after their bounded stream recovery rather than probing every group', async () => {
  const script = Array.from({ length: 4 }, (_, index) => `动作：${'院门边原有晨光照进来，衣袖随着脚步自然轻摆。'.repeat(4)}\n阿甲：${index === 0 ? '你回来了。' : '我一直都在。'}`).join('\n')
  const f = fixture(script), before = f.snapshot()
  const fourGroupPlan = { groups: Array.from({ length: 4 }, (_, index) => ({ number: index + 1, title: `Complete source group ${index + 1}`, beat: 'narrative', source_ids: [index * 2 + 1, index * 2 + 2], scene_id: f.scene.id, duration: 10 })) }
  const mock = automatic(nativeMock(f, call => call.stage === 'plan' ? fourGroupPlan
    : new Response(JSON.stringify({ error: { message: 'Offline provider temporarily unavailable', type: 'server_error' } }), { status: 503, headers: { 'Content-Type': 'application/json' } })))
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'needs_revision'); assert.equal(result.saved, 0)
  assert.deepEqual(mock.calls.filter(call => call.stage === 'expand').map(call => call.payload.current_group.number), [1, 1, 2, 2, 3, 3])
  assert.equal(store.get(result.draft_id!)!.groups[3].status, 'pending')
  assert.deepEqual(f.snapshot(), before)
})

test('user cancellation during an automatic failure never starts a recovery or another group', async () => {
  const f = fixture(), before = f.snapshot(), controller = new AbortController()
  const mock = automatic(nativeMock(f, call => {
    if (call.stage === 'plan') return plan(f)
    controller.abort(new Error('offline user cancelled automatic completion'))
    return noBodyResponse('length')
  }))
  const result = await runSkillStoryboardWorkflow(f.start('breakdown', controller.signal), mock.dependencies)
  assert.equal(result.status, 'needs_revision'); assert.equal(result.saved, 0)
  assert.deepEqual(mock.calls.map(call => call.stage === 'plan' ? 'plan' : call.payload.current_group.number), ['plan', 1])
  assert.equal(store.get(result.draft_id!)!.status, 'interrupted')
  assert.deepEqual(f.snapshot(), before)
})

test('an overlong narrative plan is automatically replanned beyond the former two-call stop and commits its complete prose once', async () => {
  const f = fixture(), before = f.snapshot(), draftIds = new Set<string>()
  let planningCalls = 0, commits = 0, originalUnits: unknown
  const options = f.start('breakdown', undefined, phase => {
    if (phase === 'saving') { commits++; assert.deepEqual(f.snapshot(), before) }
  })
  const mock = automatic(nativeMock(f, call => {
    assert.deepEqual(f.snapshot(), before)
    if (call.stage !== 'plan') return creative(f, call.payload.current_group.number)
    planningCalls++
    if (planningCalls === 1) {
      originalUnits = structuredClone(call.payload.source_units)
      assert.equal(call.execution?.thinking, 'disabled')
      assert.equal(call.execution?.maxOutputTokens, 16_384)
      assert.equal(Object.hasOwn(call.payload, 'directed_repair'), false)
    } else {
      assert.equal(call.execution?.thinking, 'low', 'the invalid model allocation gets a different, thoughtful repair policy')
      assert.equal(call.execution?.maxOutputTokens, 32_768)
      assert.deepEqual(call.payload.source_units, originalUnits, 'replanning must keep every original word and silent action')
      assert.equal(call.payload.directed_repair.rejected_plan.groups.reduce((sum: number, group: any) => sum + group.duration, 0), 30)
      assert.equal(call.payload.directed_repair.rejected_plan.groups.length, 3, 'three narrative groups already have a 30-second functional floor; recovery must reconsider grouping')
      assert.ok(call.payload.directed_repair.issues.some((issue: any) => issue.code === 'constraint_conflict'))
      const constraints = call.payload.planning_constraints, timing = scriptTimingBudget(f.context().script || '')
      assert.equal(constraints.timing.target_seconds, timing.targetSeconds)
      assert.equal(constraints.timing.minimum_seconds, timing.minimumSeconds)
      assert.equal(constraints.timing.maximum_seconds, timing.maximumSeconds)
      assert.equal(constraints.current.total_seconds, 30)
      // The fixture has enough actual body text for two groups. Its longer
      // first action now needs the full 10 s; the short final line still gets 8 s.
      assert.equal(constraints.current.minimum_seconds_without_regrouping, 28)
      assert.equal(constraints.current.requires_regrouping, true)
      assert.equal(constraints.current.recommended_integer_reduction_seconds, Math.ceil(30 - timing.maximumSeconds))
      assert.deepEqual(constraints.groups.map((group: any) => group.beat_minimum_seconds), [10, 10, 8])
    }
    return planningCalls < 3 ? { groups: [
      { ...plan(f).groups[0], source_ids: [1] },
      { ...plan(f).groups[1], source_ids: [2, 3] },
      { ...plan(f).groups[1], number: 3, title: '原词收尾', source_ids: [4] },
    ] } : plan(f)
  }))
  const result = await runSkillStoryboardWorkflow({ ...options, onProgress: progress => { draftIds.add(progress.draft_id) } }, mock.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues)); assert.equal(result.saved, 2)
  assert.deepEqual(mock.calls.map(call => call.stage === 'plan' ? 'plan' : call.payload.current_group.number), ['plan', 'plan', 'plan', 1, 2])
  assert.equal(planningCalls, 3); assert.equal(commits, 1)
  assert.deepEqual([...draftIds], [result.draft_id])
  assert.equal(store.get(result.draft_id!)!.status, 'committed')
  assert.equal(store.get(result.draft_id!)!.plan && (store.get(result.draft_id!)!.plan as any).data.groups.reduce((sum: number, group: any) => sum + group.duration, 0), 20)
  for (const [index, row] of f.rows().entries()) {
    const expected = compileStoryboardReferences(creative(f, index + 1), f.assets).candidate!
    assert.equal(row.description, expected.description); assert.equal(row.videoPrompt, expected.video_prompt)
    assert.equal(row.result, expected.result); assert.equal(row.imagePrompt, expected.image_prompt)
  }
})

test('a shared speech-capacity deficit is automatically repaired by source reassignment without deleting or accelerating dialogue', async () => {
  const firstClause = '我今天已经走过院门看见木桌仍在原地等你回来，'
  const secondClause = '你现在先把门口木杯拿回来放在原桌面不要着急。'
  const script = `动作：${'院门边原有晨光照进来，衣袖随着脚步自然轻摆。'.repeat(4)}\n阿甲：${firstClause}${secondClause}\n动作：${'桌面木杯保持原位，脚步慢下来后停住，抬眼等待。'.repeat(3)}\n阿甲：我一直都在。`
  const f = fixture(script), before = f.snapshot()
  let planningCalls = 0, originalUnits: any[] = []
  const accepted = plan(f)
  accepted.groups[1].source_ids = [2, 3, 4]
  const dividedCreative = (number: number) => {
    const value = creative(f, number), c = `[[character:${f.character.id}]]`
    const original = number === 1 ? '你回来了。' : '我一直都在。'
    const full = number === 1 ? firstClause : `${secondClause}我一直都在。`
    const lead = number === 1 ? '我今天已经走过院门' : '你现在先把门口木杯拿回来'
    const tail = full.slice(lead.length)
    value.description = value.description.replaceAll(original, full)
    value.video_prompt = value.video_prompt.replace('晨光照在衣袖。', `晨光照在衣袖，${c}说：「${lead}」声音保持同一中年温润低音区，约每秒4.5字。`)
      .replaceAll(original, tail).replace('约每秒2字', '约每秒4.5字')
    value.source_ids = accepted.groups[number - 1].source_ids
    return value
  }
  const fixtureReview = f.start()
  const fixtureIssues = fixtureReview.session.reviewCompleteCandidates([1, 2].map(number => compileStoryboardReferences(dividedCreative(number), f.assets).candidate!))
  fixtureReview.session.cancel('Offline capacity fixture checked without a model request')
  assert.deepEqual(fixtureIssues.filter(issue => issue.severity === 'error'), [], 'the proposed reassignment and natural speech split is actually valid')
  const mock = automatic(nativeMock(f, call => {
    assert.deepEqual(f.snapshot(), before)
    if (call.stage !== 'plan') return dividedCreative(call.payload.current_group.number)
    planningCalls++
    if (planningCalls === 1) { originalUnits = structuredClone(call.payload.source_units); return plan(f) }
    assert.equal(call.execution?.thinking, 'low'); assert.equal(call.execution?.maxOutputTokens, 32_768)
    assert.deepEqual(call.payload.source_units, originalUnits)
    const capacity = call.payload.directed_repair.issues.find((issue: any) => issue.capacity)?.capacity
    assert.ok(capacity, 'the model receives the actual shared-capacity defect, not an unscoped schema warning')
    assert.equal(capacity.demand_characters, 42)
    assert.equal(capacity.capacity_characters, 36)
    assert.equal(capacity.deficit_characters, 6)
    assert.deepEqual(capacity.source_ids, [2]); assert.deepEqual(capacity.group_numbers, [1])
    const constraints = call.payload.planning_constraints
    assert.deepEqual(constraints.capacity_conflicts, [capacity])
    assert.equal(constraints.groups[0].exclusive_spoken_characters, 42)
    assert.equal(constraints.groups[0].minimum_seconds_for_exclusive_speech, 42 / 4.5 + 2)
    return accepted
  }))
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues)); assert.equal(result.saved, 2)
  assert.equal(planningCalls, 2)
  assert.deepEqual(mock.calls.map(call => call.stage === 'plan' ? 'plan' : call.payload.current_group.number), ['plan', 'plan', 1, 2])
  assert.deepEqual((store.get(result.draft_id!)!.plan as any).data, accepted)
  for (const [index, row] of f.rows().entries()) {
    const expected = compileStoryboardReferences(dividedCreative(index + 1), f.assets).candidate!
    assert.equal(row.description, expected.description)
    assert.equal(row.videoPrompt, expected.video_prompt, 'the original natural clauses remain intact across their valid time rows')
  }
  assert.equal(store.get(result.draft_id!)!.status, 'committed')
})

test('planning transport recovery and allocation repair share the four-actual-request limit and still finish at the boundary', async () => {
  const f = fixture(), before = f.snapshot(); let planningCalls = 0
  const mock = automatic(nativeMock(f, call => {
    assert.deepEqual(f.snapshot(), before)
    if (call.stage !== 'plan') return creative(f, call.payload.current_group.number)
    planningCalls++
    if (planningCalls === 1) return noBodyResponse('length')
    const value = plan(f)
    if (planningCalls < 4) value.groups.forEach(group => { group.duration = 15 })
    return value
  }))
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues)); assert.equal(result.saved, 2)
  const planning = mock.calls.filter(call => call.stage === 'plan')
  assert.equal(planning.length, 4)
  assert.deepEqual(planning.map(call => call.execution?.thinking), ['disabled', 'disabled', 'low', 'low'])
  assert.deepEqual(planning.map(call => call.execution?.maxOutputTokens), [16_384, 32_768, 32_768, 32_768])
  assert.equal(result.result.requestStats.filter(stat => stat.stage === 'plan').length, 4)
  assert.deepEqual(mock.calls.filter(call => call.stage !== 'plan').map(call => call.payload.current_group.number), [1, 2])
})

test('persistent invalid planning ends after four actual requests without fabricating a shorter plan or changing live data', async () => {
  const f = fixture(), before = f.snapshot(), draftIds = new Set<string>()
  const mock = automatic(nativeMock(f, call => {
    assert.equal(call.stage, 'plan', 'invalid planning must never unfold creative groups')
    const value = plan(f); value.groups.forEach(group => { group.duration = 15 }); return value
  }))
  const result = await runSkillStoryboardWorkflow({ ...f.start(), onProgress: value => { draftIds.add(value.draft_id) } }, mock.dependencies)
  assert.equal(result.status, 'needs_revision'); assert.equal(result.saved, 0)
  assert.equal(mock.calls.length, 4); assert.equal(result.result.requestStats.length, 4)
  assert.deepEqual([...draftIds], [result.draft_id])
  assert.deepEqual(mock.calls.map(call => call.execution?.thinking), ['disabled', 'low', 'low', 'low'])
  const draft = store.get(result.draft_id!)!
  assert.deepEqual(draft.groups, [])
  assert.equal((draft.plan as any).data.groups.reduce((sum: number, group: any) => sum + group.duration, 0), 30)
  assert.ok((draft.plan as any).issues.some((issue: any) => issue.code === 'constraint_conflict' && issue.severity === 'error'))
  assert.deepEqual(f.snapshot(), before)
})

test('resuming a saved invalid plan starts with low-thinking repair and reuses its draft before completing the episode', async () => {
  const f = fixture(), before = f.snapshot()
  const first = nativeMock(f, call => {
    assert.equal(call.stage, 'plan')
    const value = plan(f); value.groups.forEach(group => { group.duration = 15 }); return value
  })
  first.dependencies.modelIdentity = { provider: 'openai', model: 'deepseek-v4.1-flash' }
  const initial = await runSkillStoryboardWorkflow(f.start(), first.dependencies)
  assert.equal(initial.status, 'needs_revision'); assert.equal(first.calls.length, 2)
  assert.deepEqual(store.get(initial.draft_id!)!.groups, [])
  assert.deepEqual(f.snapshot(), before)
  const resumed = automatic(nativeMock(f, call => {
    assert.deepEqual(f.snapshot(), before)
    if (call.stage !== 'plan') return creative(f, call.payload.current_group.number)
    assert.equal(call.execution?.thinking, 'low', 'saved invalid planning must not repeat the failed direct strategy')
    assert.equal(call.execution?.maxOutputTokens, 32_768)
    assert.equal(call.execution?.profile, 'recovery')
    assert.equal(call.payload.planning_constraints.current.total_seconds, 30)
    assert.deepEqual(call.payload.directed_repair.rejected_plan, (store.get(initial.draft_id!)!.plan as any).data)
    return plan(f)
  }))
  const result = await runSkillStoryboardWorkflow(f.start(), resumed.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues)); assert.equal(result.saved, 2)
  assert.equal(result.draft_id, initial.draft_id)
  assert.deepEqual(resumed.calls.map(call => call.stage === 'plan' ? 'plan' : call.payload.current_group.number), ['plan', 1, 2])
  assert.equal(store.get(result.draft_id!)!.status, 'committed')
})

test('missing original input and cancellation during planning never trigger automatic plan repair', async () => {
  const missing = fixture(), missingBefore = missing.snapshot(), missingMock = automatic(nativeMock(missing))
  missingMock.dependencies.readContext = async () => ({ ...missing.context(), script: '' })
  const noInput = await runSkillStoryboardWorkflow(missing.start(), missingMock.dependencies)
  assert.equal(noInput.status, 'needs_revision'); assert.equal(missingMock.calls.length, 0)
  assert.ok(noInput.issues.some(issue => issue.code === 'context_missing'))
  assert.deepEqual(missing.snapshot(), missingBefore)

  const f = fixture(), before = f.snapshot(), controller = new AbortController()
  const mock = automatic(nativeMock(f, call => {
    assert.equal(call.stage, 'plan')
    controller.abort(new Error('offline user cancelled planning'))
    const value = plan(f); value.groups.forEach(group => { group.duration = 15 }); return value
  }))
  const result = await runSkillStoryboardWorkflow(f.start('breakdown', controller.signal), mock.dependencies)
  assert.equal(result.status, 'needs_revision'); assert.equal(result.saved, 0); assert.equal(mock.calls.length, 1)
  assert.equal(store.get(result.draft_id!)!.status, 'interrupted')
  assert.deepEqual(f.snapshot(), before)
})

test('targeted mapping repair returns only counts while every other raw field and the successful group remain unchanged', async () => {
  const f = fixture(), before = f.snapshot(), pristine = creative(f, 1)
  let first = true, commits = 0
  const mock = targeted(nativeMock(f, call => {
    assert.deepEqual(f.snapshot(), before, 'Patches must remain candidates until the complete episode passes')
    if (call.stage === 'plan') return plan(f)
    if (call.payload.targeted_repair) {
      const repair = call.payload.targeted_repair
      assert.deepEqual(repair.fields, ['time_row_counts'])
      assert.deepEqual(repair.allowed_changes, ['time_row_counts'])
      assert.ok(repair.locked_fields.includes('description'))
      assert.ok(repair.locked_fields.includes('result'))
      assert.equal(call.payload.locked_context.description, pristine.description)
      assert.equal(call.payload.locked_context.video_prompt, pristine.video_prompt)
      assert.equal(call.payload.locked_context.result, pristine.result)
      assert.equal(Object.hasOwn(call.payload.locked_context, 'time_row_counts'), false)
      assert.equal(Object.hasOwn(call.payload.directed_repair, 'rejected_submission'), false, 'Do not request another complete group')
      return { base_version: repair.base_version, changes: { time_row_counts: [2, 2] } }
    }
    const row = creative(f, call.payload.current_group.number)
    if (row.shot_number === 1 && first) { first = false; row.time_row_counts = [1, 2] }
    return row
  }))
  const result = await runSkillStoryboardWorkflow(f.start('breakdown', undefined, phase => { if (phase === 'saving') commits++ }), mock.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues)); assert.equal(result.saved, 2)
  assert.equal(commits, 1)
  const expands = mock.calls.filter(call => call.stage === 'expand')
  const patchStats = result.result.requestStats.filter(stat => stat.repairScope === 'fields')
  assert.equal(patchStats.length, 1)
  assert.deepEqual(patchStats[0].repairFields, ['time_row_counts'])
  assert.equal(result.result.modelCalls, 4, 'The patch shares the normal call accounting rather than hiding another request')
  assert.deepEqual(expands.map(call => call.payload.current_group.number), [1, 1, 2])
  assert.equal(expands.filter(call => call.payload.targeted_repair).length, 1)
  const draft = store.get(result.draft_id!)!
  assert.deepEqual((draft.groups[0].candidate as any).raw, pristine)
  assert.deepEqual((draft.groups[1].candidate as any).raw, creative(f, 2))
  assert.equal(f.rows()[0].description, compileStoryboardReferences(pristine, f.assets).candidate!.description)
})

test('targeted video-row repair preserves the complete header and every unselected row byte for byte', async () => {
  const f = fixture(), pristine = creative(f, 1), lines = pristine.video_prompt.split('\n')
  const broken = structuredClone(pristine)
  broken.video_prompt = lines.map((line: string, index: number) => index === 3
    ? line.replaceAll(`[[character:${f.character.id}]]`, '阿甲').replaceAll(`[[prop:${f.prop.id}]]`, '木杯') : line).join('\n')
  let first = true
  const mock = targeted(nativeMock(f, call => {
    if (call.stage === 'plan') return plan(f)
    const repair = call.payload.targeted_repair
    if (repair) {
      assert.equal(repair.scope, 'video_rows')
      assert.deepEqual(repair.fields, ['video_prompt'])
      assert.deepEqual(repair.target_rows.map((row: any) => row.row), [3])
      assert.deepEqual(repair.allowed_changes, ['video_prompt_rows'])
      assert.equal(call.payload.locked_context.description, pristine.description)
      assert.equal(call.payload.locked_context.atmosphere, pristine.atmosphere)
      assert.equal(call.payload.locked_context.result, pristine.result)
      return { base_version: repair.base_version, changes: { video_prompt_rows: { '3': lines[3] } } }
    }
    if (call.payload.current_group.number === 1 && first) { first = false; return broken }
    return creative(f, call.payload.current_group.number)
  }))
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues))
  assert.deepEqual((store.get(result.draft_id!)!.groups[0].candidate as any).raw, pristine)
  assert.equal(mock.calls.filter(call => call.payload.current_group?.number === 2).length, 1)
})

test('forbidden fields and stale patch versions cannot overwrite the original candidate and fall back to full-group repair', async () => {
  for (const variant of ['forbidden-field', 'stale-version']) {
    const f = fixture(), before = f.snapshot(), broken = { ...creative(f, 1), time_row_counts: [1, 2] }
    let first = true, rejected = false
    const mock = targeted(nativeMock(f, call => {
      assert.deepEqual(f.snapshot(), before)
      if (call.stage === 'plan') return plan(f)
      const repair = call.payload.targeted_repair
      if (repair) {
        rejected = true
        return variant === 'stale-version'
          ? { base_version: 'obsolete-snapshot', changes: { time_row_counts: [2, 2] } }
          : { base_version: repair.base_version, changes: { time_row_counts: [2, 2], result: 'FORBIDDEN_ENDING_OVERWRITE' } }
      }
      const number = call.payload.current_group.number
      if (number === 1 && first) { first = false; return broken }
      if (number === 1 && rejected) {
        const draft = store.latest(f.episode.id, 'breakdown')!
        assert.deepEqual((draft.groups[0].candidate as any).raw, broken, 'Rejected patches cannot replace the saved prose')
      }
      return creative(f, number)
    }))
    const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
    assert.equal(result.status, 'done', `${variant}: ${JSON.stringify(result.issues)}`)
    assert.equal(mock.calls.filter(call => call.payload.targeted_repair).length, 1)
    assert.equal(mock.calls.filter(call => call.payload.current_group?.number === 1 && !call.payload.targeted_repair).length, 2)
    assert.equal((store.get(result.draft_id!)!.groups[0].candidate as any).raw.result, creative(f, 1).result)
    assert.equal(f.rows().some(row => row.result === 'FORBIDDEN_ENDING_OVERWRITE'), false)
  }
})

test('global original-dialogue loss and structural plan errors escalate to complete-group repair instead of a field patch', async () => {
  for (const variant of ['source-coverage', 'plan-change']) {
    const f = fixture(), original = creative(f, 1)
    let first = true
    const mock = targeted(nativeMock(f, call => {
      assert.equal(Object.hasOwn(call.payload, 'targeted_repair'), false)
      if (call.stage === 'plan') return plan(f)
      const number = call.payload.current_group.number
      if (number !== 1 || !first) return creative(f, number)
      first = false
      if (variant === 'plan-change') return { ...original, source_ids: [1, 2, 3] }
      return { ...original,
        description: original.description.replace(`[[character:${f.character.id}]]说：「你回来了。」`, '他停住，没有说话。'),
        video_prompt: original.video_prompt.replace(`[[character:${f.character.id}]]说：「你回来了。」`, '他停住，没有说话。') }
    }))
    const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
    assert.equal(result.status, 'done', `${variant}: ${JSON.stringify(result.issues)}`)
    const repair = mock.calls.find(call => call.payload.directed_repair && call.stage === 'expand')!
    assert.ok(repair)
    assert.ok(repair.payload.directed_repair.issues.some((issue: any) => issue.code === (variant === 'plan-change' ? 'plan_changed' : 'dialogue_coverage')))
    assert.equal(mock.calls.filter(call => call.payload.current_group?.number === 2).length, 1)
  }
})

test('an invalid raw duration cannot enter counts-only repair when schema failure hides the plan mismatch', async () => {
  const f = fixture()
  let first = true
  const mock = targeted(nativeMock(f, call => {
    assert.equal(Object.hasOwn(call.payload, 'targeted_repair'), false, 'Plan identity must be checked before choosing a patch even without compiled data')
    if (call.stage === 'plan') return plan(f)
    const number = call.payload.current_group.number
    if (number === 1 && first) { first = false; return { ...creative(f, 1), duration: 9 } }
    return creative(f, number)
  }))
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues))
  assert.equal(mock.calls.filter(call => call.payload.current_group?.number === 1).length, 2)
  assert.deepEqual(f.rows().map(row => row.duration), [10, 10])
})

test('a targeted prose change cannot silently expand bound assets through newly compiled reference tokens', async () => {
  const f = fixture(), added = db.insert(schema.props).values({ dramaId: f.drama.id, name: '另一只木杯', ...timestamps }).returning().get()
  f.assets.props.push({ id: added.id, name: added.name })
  const pristine = creative(f, 1), lines = pristine.video_prompt.split('\n')
  const broken = structuredClone(pristine)
  broken.video_prompt = lines.map((line: string, index: number) => index === 3
    ? line.replaceAll(`[[character:${f.character.id}]]`, '阿甲').replaceAll(`[[prop:${f.prop.id}]]`, '木杯') : line).join('\n')
  let first = true
  const mock = targeted(nativeMock(f, call => {
    if (call.stage === 'plan') return plan(f)
    if (call.payload.targeted_repair) return {
      base_version: call.payload.targeted_repair.base_version,
      changes: { video_prompt_rows: { '3': `${lines[3]}旁边新增[[prop:${added.id}]]。` } },
    }
    if (call.payload.current_group.number === 1 && first) { first = false; return broken }
    return creative(f, call.payload.current_group.number)
  }))
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues))
  assert.equal(mock.calls.filter(call => call.payload.targeted_repair).length, 1)
  assert.equal(mock.calls.filter(call => call.payload.current_group?.number === 1 && !call.payload.targeted_repair).length, 2)
  assert.deepEqual((store.get(result.draft_id!)!.groups[0].candidate as any).raw, pristine)
  assert.deepEqual(db.select().from(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, f.rows()[0].id)).all().map(row => row.propId), [f.prop.id])
})

test('an invalid patch is bounded together with complete repairs and cannot commit partial or unauthorized content', async () => {
  const f = fixture(), before = f.snapshot(), broken = { ...creative(f, 1), time_row_counts: [1, 2] }
  const mock = targeted(nativeMock(f, call => {
    assert.deepEqual(f.snapshot(), before)
    if (call.stage === 'plan') return plan(f)
    if (call.payload.targeted_repair) return { base_version: call.payload.targeted_repair.base_version, changes: { time_row_counts: [1, 2] } }
    return call.payload.current_group.number === 1 ? broken : creative(f, 2)
  }))
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'needs_revision'); assert.equal(result.saved, 0)
  assert.equal(mock.calls.filter(call => call.payload.current_group?.number === 1).length, 4)
  assert.equal(mock.calls.filter(call => call.payload.targeted_repair).length, 1)
  assert.equal(mock.calls.filter(call => call.payload.current_group?.number === 2).length, 1)
  assert.deepEqual((store.get(result.draft_id!)!.groups[0].candidate as any).raw, broken)
  assert.deepEqual(f.snapshot(), before)
})

test('a successful targeted candidate is reused on resume while only an unfinished neighboring group is requested', async () => {
  const f = fixture(), before = f.snapshot()
  let first = true
  const firstRun = targeted(nativeMock(f, call => {
    if (call.stage === 'plan') return plan(f)
    if (call.payload.targeted_repair) return { base_version: call.payload.targeted_repair.base_version, changes: { time_row_counts: [2, 2] } }
    if (call.payload.current_group.number === 2) return { conflict: '原有邻组资料暂不可用。', field: 'video_prompt', source_ids: [3, 4] }
    if (first) { first = false; return { ...creative(f, 1), time_row_counts: [1, 2] } }
    return creative(f, 1)
  }))
  const pending = await runSkillStoryboardWorkflow(f.start(), firstRun.dependencies)
  assert.equal(pending.status, 'needs_revision'); assert.equal(pending.saved, 0)
  const ready = structuredClone(store.get(pending.draft_id!)!.groups[0])
  assert.equal(ready.status, 'ready')
  assert.deepEqual(f.snapshot(), before)
  const secondRun = targeted(nativeMock(f, call => {
    assert.equal(call.stage, 'expand'); assert.equal(call.payload.current_group.number, 2)
    assert.equal(Object.hasOwn(call.payload, 'targeted_repair'), false)
    return creative(f, 2)
  }))
  const result = await runSkillStoryboardWorkflow(f.start(), secondRun.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues))
  assert.equal(result.draft_id, pending.draft_id); assert.equal(result.result.modelCalls, 1)
  assert.deepEqual(store.get(result.draft_id!)!.groups[0].candidate, ready.candidate)
  assert.equal(store.get(result.draft_id!)!.groups[0].attempts, ready.attempts)
})

test('prompt-only targeted mapping repair preserves every locked field, binding and episode value', async () => {
  const f = fixture(), full = compileStoryboardReferences(creative(f, 1), f.assets).candidate!
  db.update(schema.storyboards).set({ title: full.title, time: full.time, location: full.location, shotType: full.shot_type, angle: full.angle, movement: full.movement,
    description: full.description, result: full.result, atmosphere: full.atmosphere, imagePrompt: full.image_prompt, bgmPrompt: full.bgm_prompt, soundEffect: full.sound_effect,
    videoPrompt: 'Original locked video', duration: 10 }).where(eq(schema.storyboards.id, f.old.id)).run()
  const before = f.snapshot()
  let first = true
  const mock = targeted(nativeMock(f, call => {
    assert.equal(call.stage, 'prompt')
    if (call.payload.targeted_repair) {
      assert.deepEqual(call.payload.targeted_repair.fields, ['time_row_counts'])
      return { base_version: call.payload.targeted_repair.base_version, changes: { time_row_counts: [2, 2] } }
    }
    assert.equal(first, true); first = false
    return { video_prompt: creative(f, 1).video_prompt, time_row_counts: [1, 2] }
  }))
  const result = await runSkillStoryboardWorkflow(f.start('prompt'), mock.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues)); assert.equal(result.saved, 1)
  assert.equal(mock.calls.length, 2)
  const after = f.snapshot(), omitPrompt = ({ videoPrompt: _prompt, updatedAt: _updated, ...row }: any) => row
  assert.deepEqual(after.rows.map(omitPrompt), before.rows.map(omitPrompt))
  assert.deepEqual(after.characters, before.characters); assert.deepEqual(after.props, before.props)
  assert.deepEqual(after.episode, before.episode)
})

test('cancellation during targeted repair prevents later group requests and leaves live work untouched', async () => {
  const f = fixture(), before = f.snapshot(), controller = new AbortController()
  const mock = targeted(nativeMock(f, call => {
    if (call.stage === 'plan') return plan(f)
    if (call.payload.targeted_repair) {
      controller.abort(new Error('User cancelled while a field repair was in flight'))
      return { base_version: call.payload.targeted_repair.base_version, changes: { time_row_counts: [2, 2] } }
    }
    return { ...creative(f, 1), time_row_counts: [1, 2] }
  }))
  const result = await runSkillStoryboardWorkflow(f.start('breakdown', controller.signal), mock.dependencies)
  assert.equal(result.status, 'needs_revision'); assert.equal(result.saved, 0)
  assert.equal(mock.calls.filter(call => call.payload.targeted_repair).length, 1)
  assert.equal(mock.calls.some(call => call.payload.current_group?.number === 2), false)
  assert.equal(store.get(result.draft_id!)!.status, 'interrupted')
  assert.deepEqual(f.snapshot(), before)
})

test('concurrent user edits during a targeted repair are preserved by the unchanged final transaction guard', async () => {
  const f = fixture(), before = f.snapshot()
  const mock = targeted(nativeMock(f, call => {
    if (call.stage === 'plan') return plan(f)
    if (call.payload.targeted_repair) {
      db.update(schema.storyboards).set({ title: 'User edited while patch was in flight' }).where(eq(schema.storyboards.id, f.old.id)).run()
      return { base_version: call.payload.targeted_repair.base_version, changes: { time_row_counts: [2, 2] } }
    }
    return call.payload.current_group.number === 1 ? { ...creative(f, 1), time_row_counts: [1, 2] } : creative(f, 2)
  }))
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'needs_revision'); assert.equal(result.saved, 0)
  assert.equal(f.rows().length, before.rows.length)
  assert.equal(f.rows()[0].title, 'User edited while patch was in flight')
  assert.deepEqual(f.snapshot().characters, before.characters); assert.deepEqual(f.snapshot().props, before.props)
  assert.equal(store.get(result.draft_id!)!.status, 'needs_revision')
})

test('a current draft version change during patch generation preserves the newer candidate and forbids stale complete-group fallback', async () => {
  const f = fixture(), before = f.snapshot(), revised = { ...creative(f, 1), title: '另一份新稿' }
  const compiledRevision = compileStoryboardReferences(revised, f.assets).candidate!
  const mock = targeted(nativeMock(f, call => {
    if (call.stage === 'plan') return plan(f)
    if (call.payload.targeted_repair) {
      const draft = store.latest(f.episode.id, 'breakdown')!
      const current = draft.groups.find(group => group.number === 1)!
      const lease = db.$client.prepare('SELECT lease_token FROM storyboard_drafts WHERE id=?').get(draft.id) as { lease_token: string }
      assert.ok(lease.lease_token)
      // Simulate a newer save by the current owner while this response is in flight.
      store.saveGroup(draft.id, { ...current, candidate: { raw: revised, data: compiledRevision, preview: compiledRevision } }, lease.lease_token)
      return { base_version: call.payload.targeted_repair.base_version, changes: { time_row_counts: [2, 2] } }
    }
    return call.payload.current_group.number === 1 ? { ...creative(f, 1), time_row_counts: [1, 2] } : creative(f, 2)
  }))
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'needs_revision'); assert.equal(result.saved, 0)
  const draft = store.get(result.draft_id!)!, current = draft.groups.find(group => group.number === 1)!
  assert.deepEqual((current.candidate as any).raw, revised)
  assert.deepEqual((current.candidate as any).data, compiledRevision)
  assert.ok(current.issues.some((issue: any) => issue.code === 'targeted_repair_version'))
  assert.equal(mock.calls.filter(call => call.payload.current_group?.number === 1).length, 2)
  assert.equal(mock.calls.filter(call => call.payload.current_group?.number === 2).length, 1)
  assert.equal(draft.groups[1].status, 'ready')
  assert.deepEqual(f.snapshot(), before)
})

test('a result repair with an already ready following group uses complete repair with preserve_ending and never patches that outcome alone', async () => {
  const f = fixture(), before = f.snapshot()
  const initial = targeted(nativeMock(f, call => call.stage === 'plan' ? plan(f) : call.payload.current_group.number === 1
    ? { conflict: '第一组末态待补齐。', field: 'result', source_ids: [1, 2] } : creative(f, 2)))
  const pending = await runSkillStoryboardWorkflow(f.start(), initial.dependencies)
  assert.equal(pending.status, 'needs_revision'); assert.equal(pending.saved, 0)
  const draft = store.get(pending.draft_id!)!, first = draft.groups[0], following = structuredClone(draft.groups[1])
  assert.equal(following.status, 'ready')
  const raw = { ...creative(f, 1), result: '' }
  const data = { ...compileStoryboardReferences(creative(f, 1), f.assets).candidate!, result: '' }
  store.saveGroup(draft.id, { ...first, status: 'needs_revision', candidate: { raw, data, preview: data }, issues: [
    { code: 'skill_field_missing', field: 'result', shotNumber: 1, severity: 'error', message: '缺少skill成品字段 result；草稿保留，请补齐该字段。' },
  ] })
  const resumed = targeted(nativeMock(f, call => {
    assert.equal(call.stage, 'expand'); assert.equal(call.payload.current_group.number, 1)
    assert.equal(Object.hasOwn(call.payload, 'targeted_repair'), false)
    assert.equal(Object.hasOwn(call.payload.directed_repair, 'preserve_ending'), true)
    assert.equal(call.payload.directed_repair.preserve_ending, raw.result)
    assert.match(call.payload.directed_repair.instruction, /保留已供后组承接的末态/)
    return creative(f, 1)
  }))
  const result = await runSkillStoryboardWorkflow(f.start(), resumed.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues)); assert.equal(result.saved, 2)
  assert.equal(result.draft_id, pending.draft_id); assert.equal(resumed.calls.length, 1)
  assert.deepEqual(store.get(result.draft_id!)!.groups[1].candidate, following.candidate)
  assert.equal(store.get(result.draft_id!)!.groups[1].attempts, following.attempts)
  assert.notDeepEqual(f.snapshot(), before, 'Only the final accepted episode transaction writes live work')
})

test('missing ancillary prose is repaired by its field alone and a binding projection never leaks into requests or saved content', async () => {
  for (const field of ['image_prompt', 'sound_effect'] as const) {
    const f = fixture(), before = f.snapshot(), full = creative(f, 1)
    const replacement = field === 'image_prompt'
      ? `${full.image_prompt}画面保留原有窗格光斑与木杯边缘的自然细节。`
      : `${full.sound_effect}最后一声衣料摩擦自然衰减。`
    const expected = { ...full, [field]: replacement }, missing = structuredClone(full)
    delete missing[field]
    let first = true
    const mock = targeted(nativeMock(f, call => {
      assert.deepEqual(f.snapshot(), before)
      assert.equal(JSON.stringify(call.payload).includes('绑定快照占位'), false, 'Read-only binding projections cannot be model input')
      if (call.stage === 'plan') return plan(f)
      if (call.payload.targeted_repair) {
        const repair = call.payload.targeted_repair
        assert.deepEqual(repair.fields, [field])
        assert.deepEqual(repair.allowed_changes, [field])
        assert.equal(repair.scope, 'fields')
        assert.equal(call.payload.locked_context.description, full.description)
        assert.equal(call.payload.locked_context.video_prompt, full.video_prompt)
        assert.equal(call.payload.locked_context.result, full.result)
        assert.equal((store.latest(f.episode.id, 'breakdown')!.groups[0].candidate as any).data, null)
        return { base_version: repair.base_version, changes: { [field]: replacement } }
      }
      if (call.payload.current_group.number === 1) {
        assert.equal(first, true, 'Missing metadata should need one field patch rather than another complete-group response')
        first = false
        return missing
      }
      return creative(f, 2)
    }))
    const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
    assert.equal(result.status, 'done', `${field}: ${JSON.stringify(result.issues)}`); assert.equal(result.saved, 2)
    const draft = store.get(result.draft_id!)!
    assert.deepEqual((draft.groups[0].candidate as any).raw, expected)
    assert.equal(mock.calls.filter(call => call.payload.targeted_repair).length, 1)
    assert.equal(mock.calls.filter(call => call.payload.current_group?.number === 2).length, 1)
    assert.equal(JSON.stringify(draft).includes('绑定快照占位'), false)
    assert.equal(JSON.stringify(result.candidateReport).includes('绑定快照占位'), false)
    const compiled = compileStoryboardReferences(expected, f.assets).candidate!, row = f.rows()[0]
    assert.equal(field === 'image_prompt' ? row.imagePrompt : row.soundEffect, compiled[field])
    assert.deepEqual(db.select().from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, row.id)).all().map(link => link.characterId), [f.character.id])
    assert.deepEqual(db.select().from(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, row.id)).all().map(link => link.propId), [f.prop.id])
  }
})

function voiceCreative(f: Fixture, number: number): any {
  const value = creative(f, number), c = `[[character:${f.character.id}]]`
  const speech = number === 1 ? '你回来了。' : '我一直都在。'
  value.description = value.description.replace(`${c}说：「${speech}」`, `[[voice:v1]]：「${speech}」`)
  value.video_prompt = value.video_prompt.replace(`${c}说：「${speech}」`, `[[voice:v1]]：「${speech}」`)
    .replace('气息稳定，听感中年，低音区，音色温润，约每秒2字，原环境声连续。', '原环境声连续。')
  value.voice_cues = [{
    id: 'v1', shot: 1, speaker_id: f.character.id, kind: 'dialogue', source_name: '',
    profile: { age: '三十岁成年男声', register: '中低音区', timbre: '温润略带沙哑' },
    state: '站在原桌旁气息平稳', goal: number === 1 ? '确认对方归来' : '平静回应', volume: '适中', rate_cps: 2,
    breath: '平稳', tail: '轻收', emotion: '克制温和',
  }]
  return value
}
function voices(mock: ReturnType<typeof nativeMock>) {
  delete mock.dependencies.voiceContract
  return mock
}

test('first-pass voice cues materialize complete per-speaker acoustic details and explicit identities into the final prose', async () => {
  const f = fixture(), before = f.snapshot()
  const mock = voices(nativeMock(f, call => {
    assert.deepEqual(f.snapshot(), before)
    if (call.stage === 'plan') return plan(f)
    const full = call.schema.properties.output.anyOf.find((branch: any) => branch.properties?.description)
    assert.ok(full.required.includes('voice_cues'), 'The first-pass wire contract requires the voice information')
    return voiceCreative(f, call.payload.current_group.number)
  }))
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues)); assert.equal(result.saved, 2)
  assert.equal(mock.calls.length, 3, 'Voice materialization does not need another model review request')
  const draft = store.get(result.draft_id!)!
  for (const [index, row] of f.rows().entries()) {
    assert.match(row.description!, /阿甲说：「/)
    assert.equal(row.description!.includes('[[voice:'), false)
    assert.equal(row.videoPrompt!.includes('[[voice:'), false)
    for (const detail of ['三十岁成年男声', '中低音区', '温润略带沙哑', '站在原桌旁气息平稳', '音量适中', '每秒2字', '气息平稳', '尾音轻收', '克制温和']) assert.ok(row.videoPrompt!.includes(detail), detail)
    assert.ok(row.videoPrompt!.includes(index === 0 ? '确认对方归来' : '平静回应'))
    assert.ok((draft.groups[index].candidate as any).raw.voice_cues)
    assert.equal(Object.hasOwn((draft.groups[index].candidate as any).data, 'voice_cues'), false, 'Transport metadata is not a substitute for final natural prose')
    assert.equal(row.duration, 10); assert.equal(row.result, compileStoryboardReferences(creative(f, index + 1), f.assets).candidate!.result)
  }
  assert.equal(result.issues.some(issue => issue.code === 'attribution_review'), false)
})

test('missing first-pass voice contracts, misplaced anchors and wrong explicit actors never commit a falsely complete result', async () => {
  for (const variant of ['missing', 'anchor', 'actor', 'kind'] as const) {
    const f = fixture(), before = f.snapshot()
    if (variant === 'actor') {
      const other = db.insert(schema.characters).values({ dramaId: f.drama.id, name: '阿乙', ...timestamps }).returning().get()
      f.assets.characters.push({ id: other.id, name: other.name })
    }
    if (variant === 'kind') db.update(schema.episodes).set({ scriptContent: f.context().script!.replace('阿甲：你回来了。', '阿甲（画内）：你回来了。') }).where(eq(schema.episodes.id, f.episode.id)).run()
    const stable = f.snapshot()
    const mock = voices(nativeMock(f, call => {
      if (call.stage === 'plan') return plan(f)
      const value = voiceCreative(f, call.payload.current_group.number)
      if (call.payload.current_group.number !== 1) return value
      if (variant === 'missing') delete value.voice_cues
      if (variant === 'anchor') value.video_prompt = value.video_prompt.replace('[[voice:v1]]：', '[[voice:v1]]额外动作：')
      if (variant === 'actor') value.voice_cues[0].speaker_id = f.assets.characters[1].id
      if (variant === 'kind') value.voice_cues[0].kind = 'offscreen'
      return value
    }))
    const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
    assert.equal(result.status, 'needs_revision', variant); assert.equal(result.saved, 0, variant)
    assert.deepEqual(f.snapshot(), stable, `${variant}: no content should be committed`)
    assert.ok(result.issues.some(issue => issue.severity === 'error'), variant)
    if (variant === 'missing') assert.ok(result.issues.some(issue => issue.code === 'voice_cue_contract'), JSON.stringify(result.issues))
    if (variant === 'anchor') assert.ok(result.issues.some(issue => issue.code.startsWith('voice_anchor')), JSON.stringify(result.issues))
    if (variant === 'actor' || variant === 'kind') assert.ok(result.issues.some(issue => issue.code === 'dialogue_coverage'), JSON.stringify(result.issues))
    assert.equal(before.rows[0].title, f.rows()[0].title)
  }
})

test('an already established character voice cannot silently drift in a later group: a re-worded fixed voice is unified to the established one', async () => {
  // User decision 2026-11-06: small wording differences of the SAME speaker's fixed voice inside one episode are
  // unified to the established wording (the per-line delivery stays the model's), instead of failing the group.
  const f = fixture(), before = f.snapshot()
  const mock = voices(nativeMock(f, call => {
    if (call.stage === 'plan') return plan(f)
    const value = voiceCreative(f, call.payload.current_group.number)
    if (call.payload.current_group.number === 2) { value.voice_cues[0].profile.timbre = '明亮清脆的音色'; value.voice_cues[0].emotion = '轻松' }
    return value
  }))
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues)); assert.equal(result.saved, 2)
  assert.equal(mock.calls.filter(call => call.payload.current_group?.number === 2).length, 1, 'no repair request for a wording-only difference')
  const rows = f.rows()
  for (const row of rows) assert.ok(row.videoPrompt!.includes('三十岁成年男声、中低音区、温润略带沙哑'), 'every group carries the established fixed voice')
  assert.equal(rows.some(row => row.videoPrompt!.includes('明亮清脆的音色')), false, 'the drifted wording never reaches the committed prompt')
  assert.ok(rows[1].videoPrompt!.includes('情绪轻松'), 'the per-line delivery of the later group is kept')
  const draft = store.get(result.draft_id!)!
  assert.ok(((draft.groups[1].candidate as any).format_fixes || []).some((note: string) => note.includes('统一为已定的')), 'the unification is recorded')
  assert.notDeepEqual(f.snapshot(), before)
})

test('legacy ready checkpoints remain reusable without a new voice request or rewriting their accepted prose', async () => {
  const f = fixture()
  const first = nativeMock(f, call => call.stage === 'plan' ? plan(f) : call.payload.current_group.number === 1 ? creative(f, 1)
    : { conflict: 'Original second group is awaiting its existing draft.', field: 'description', source_ids: [3, 4] })
  const pending = await runSkillStoryboardWorkflow(f.start(), first.dependencies)
  assert.equal(pending.status, 'needs_revision')
  const draft = store.get(pending.draft_id!)!, data = compileStoryboardReferences(creative(f, 2), f.assets).candidate!
  store.saveGroup(draft.id, { number: 2, status: 'ready', candidate: { raw: creative(f, 2), data, preview: data }, issues: [], attempts: 1 })
  const candidates = structuredClone(store.get(draft.id)!.groups.map(group => group.candidate))
  const resumed = voices(nativeMock(f, () => { throw new Error('Ready legacy prose needs no new model request') }))
  const result = await runSkillStoryboardWorkflow(f.start(), resumed.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues)); assert.equal(result.saved, 2)
  assert.equal(result.draft_id, draft.id); assert.equal(resumed.calls.length, 0)
  assert.deepEqual(store.get(draft.id)!.groups.map(group => group.candidate), candidates)
})

test('silent action groups use an empty voice contract and do not acquire fabricated voices', async () => {
  const f = fixture()
  db.update(schema.episodes).set({ scriptContent: f.context().script!.replace('阿甲：你回来了。', '动作：阿甲看向门槛上的原光斑。').replace('阿甲：我一直都在。', '动作：阿甲站在原桌旁，安静等候。') }).where(eq(schema.episodes.id, f.episode.id)).run()
  const mock = voices(nativeMock(f, call => {
    if (call.stage === 'plan') return plan(f)
    const number = call.payload.current_group.number, value = creative(f, number)
    const speech = number === 1 ? '你回来了。' : '我一直都在。'
    value.description = value.description.replace(`[[character:${f.character.id}]]说：「${speech}」`, '停住并安静看向门口')
    value.video_prompt = value.video_prompt.replace(`[[character:${f.character.id}]]说：「${speech}」气息稳定，听感中年，低音区，音色温润，约每秒2字，`, '保持安静，')
    value.voice_cues = []
    return value
  }))
  const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
  assert.equal(result.status, 'done', JSON.stringify(result.issues)); assert.equal(result.saved, 2)
  assert.equal(mock.calls.length, 3)
  for (const row of f.rows()) {
    assert.equal(row.videoPrompt!.includes('发声目标'), false)
    assert.equal(row.videoPrompt!.includes('每秒'), false)
    assert.equal(row.videoPrompt!.includes('[[voice:'), false)
    assert.equal(row.videoPrompt!.includes('你回来了。'), false)
    assert.equal(row.videoPrompt!.includes('我一直都在。'), false)
  }
})

test('incomplete acoustic metadata is repaired alone while cue identities and all creative prose remain locked', async () => {
  for (const variant of ['complete', 'wrong-identity'] as const) {
    const f = fixture(), before = f.snapshot(), full = voiceCreative(f, 1), missing = structuredClone(full)
    delete missing.voice_cues[0].profile.age
    let first = true, patchRejected = false
    const mock = voices(targeted(nativeMock(f, call => {
      assert.deepEqual(f.snapshot(), before)
      if (call.stage === 'plan') return plan(f)
      if (call.payload.targeted_repair) {
        const repair = call.payload.targeted_repair
        assert.deepEqual(repair.fields, ['voice_cues'])
        assert.deepEqual(repair.allowed_changes, ['voice_cues'])
        assert.deepEqual(repair.current_values.voice_cues, missing.voice_cues)
        for (const field of Object.keys(missing).filter(key => key !== 'voice_cues')) assert.deepEqual(call.payload.locked_context[field], missing[field], field)
        assert.match(repair.instruction, /id、shot、speaker_id、kind、source_name、数量和顺序逐值锁定/)
        assert.equal((store.latest(f.episode.id, 'breakdown')!.groups[0].candidate as any).data, null)
        const cues = structuredClone(full.voice_cues)
        if (variant === 'wrong-identity') cues[0].id = 'differentCue'
        return { base_version: repair.base_version, changes: { voice_cues: cues } }
      }
      if (call.payload.current_group.number === 1 && first) {
        first = false
        return missing
      }
      if (call.payload.current_group.number === 1) {
        assert.equal(variant, 'wrong-identity', 'A complete acoustic patch should not regenerate the whole group')
        const retained = store.latest(f.episode.id, 'breakdown')!.groups[0]
        assert.deepEqual((retained.candidate as any).raw, missing, 'Rejected identity changes cannot pollute the original raw submission')
        assert.ok(call.payload.directed_repair.issues.some((issue: any) => issue.code === 'targeted_repair_voice_identity'))
        patchRejected = true
      }
      return voiceCreative(f, call.payload.current_group.number)
    })))
    const result = await runSkillStoryboardWorkflow(f.start(), mock.dependencies)
    assert.equal(result.status, 'done', `${variant}: ${JSON.stringify(result.issues)}`); assert.equal(result.saved, 2)
    const saved = (store.get(result.draft_id!)!.groups[0].candidate as any).raw
    assert.deepEqual(saved, full)
    assert.deepEqual(saved.voice_cues.map(({ id, shot, speaker_id, kind, source_name }: any) => ({ id, shot, speaker_id, kind, source_name })),
      missing.voice_cues.map(({ id, shot, speaker_id, kind, source_name }: any) => ({ id, shot, speaker_id, kind, source_name })))
    for (const field of Object.keys(missing).filter(key => key !== 'voice_cues')) assert.deepEqual(saved[field], missing[field], field)
    assert.equal(mock.calls.filter(call => call.payload.targeted_repair).length, 1)
    assert.equal(mock.calls.filter(call => call.payload.current_group?.number === 2).length, 1)
    assert.equal(mock.calls.filter(call => call.payload.current_group?.number === 1).length, variant === 'complete' ? 2 : 3)
    assert.equal(patchRejected, variant === 'wrong-identity')
    const row = f.rows()[0]
    assert.ok(row.videoPrompt!.includes('三十岁成年男声'))
    assert.ok(row.videoPrompt!.includes('每秒2字'))
    assert.equal(row.videoPrompt!.includes('[[voice:'), false)
  }
})
