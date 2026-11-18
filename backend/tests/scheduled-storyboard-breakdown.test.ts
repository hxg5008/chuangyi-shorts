import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { Agent } from '@mastra/core/agent'
import { createOpenAI } from '@ai-sdk/openai'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-scheduled-breakdown-'))
process.env.SQLITE_PATH = path.join(directory, 'isolated.sqlite3')
process.env.HUOBAO_DATA_DIR = directory
process.env.STORAGE_PATH = path.join(directory, 'static')
process.env.WORKSPACE_PATH = path.join(directory, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'
await fs.cp(new URL('../workspace/', import.meta.url), process.env.WORKSPACE_PATH, { recursive: true })
const { db, schema } = await import('../src/db/index.ts')
const fixtureOwner=await (await import('./helpers/platform-fixture.ts')).platformFixtureOwner()
const { createStoryboardSession } = await import('../src/services/storyboard-session.ts')
const { storyboardTools } = await import('../src/agents/tools/storyboard-tools.ts')
const { buildAgentRequestContext } = await import('../src/agents/context.ts')
const { buildDialogueTimingGuide, buildDialogueGroupSchedule } = await import('../src/services/first-pass-instructions.ts')
const { extractScriptDialogue } = await import('../src/services/script-dialogue.ts')
const { getScheduledShotLayout } = await import('../src/services/scheduled-storyboard-segment.ts')
const { runScheduledStoryboardBreakdown } = await import('../src/services/scheduled-storyboard-breakdown.ts')
const { createTextProviderFetch } = await import('../src/services/text-provider-http.ts')
const timestamps = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
after(async () => { db.$client.close(); await fs.rm(directory, { recursive: true, force: true }) })

function fixture(script = `动作：阿甲在院内抬头。\n阿甲：（轻声）${'好'.repeat(20)}。\n动作：他放下手。\n阿甲：${'好'.repeat(47)}。\n阿甲：回来吧。\n动作：他站在院门边，等待回应。`, onPhase?: (phase: 'validating' | 'saving') => void) {
  const drama = db.insert(schema.dramas).values({ ownerUserId:fixtureOwner.id, title: 'Offline scheduled test', ...timestamps }).returning().get()
  const episode = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: 'Local', scriptContent: script, ...timestamps }).returning().get()
  const character = db.insert(schema.characters).values({ dramaId: drama.id, name: '阿甲', referenceImages: 'unused-private-image-marker', ...timestamps }).returning().get()
  const scene = db.insert(schema.scenes).values({ dramaId: drama.id, location: '院落', time: '日', prompt: '现有晨光院落', ...timestamps }).returning().get()
  const old = db.insert(schema.storyboards).values({ episodeId: episode.id, storyboardNumber: 1, description: 'Old draft', videoPrompt: 'Old prompt', duration: 9, ...timestamps }).returning().get()
  const requestContext = buildAgentRequestContext({ episodeId: episode.id, dramaId: drama.id })
  const session = createStoryboardSession({ mode: 'breakdown', episodeId: episode.id, dramaId: drama.id, onPhase })
  const guide = buildDialogueTimingGuide(extractScriptDialogue(script, [character.name]), [character])
  const schedule = buildDialogueGroupSchedule(guide)
  const rows = () => db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episode.id)).all()
  return { drama, episode, character, scene, old, requestContext, session, guide, schedule, rows }
}
function creative(f: ReturnType<typeof fixture>, group: ReturnType<typeof buildDialogueGroupSchedule>[number]): any {
  const value: any = { title: '院内回应', scene_id: f.scene.id, prop_ids: [], atmosphere: '现有晨光照入院内。',
    space: '@院落以门槛为固定原点A0，X轴向东为正，Y轴向北为正，@阿甲站在A(X+1米，Y+1米)，摄影机在南侧朝北。' }
  let offset = 0
  getScheduledShotLayout(group.rows.length).forEach((length, index) => {
    const source = group.rows.slice(offset, offset + length).some(Boolean)
    value[`shot_${index + 1}`] = { characters: [{ character_id: f.character.id, visibility: 'face_visible', emotion: { expression: '平静', intensity: 60 } }],
      visuals: Array.from({ length }, () => '@阿甲正面中景，固定镜头保持3秒，轻眨后缓缓放下左手，朝向和站位保持，现有晨光自东侧照入。'),
      ...(source ? { voice: { age: '中年', register: '低音区', timbre: '温润音色', delivery: '呼吸平稳，清楚回应，尾音自然落下' } } : {}) }
    offset += length
  })
  return value
}
function response(args: unknown, sequence: number, textOnly = false, wire: { toolName?: string; argumentsText?: string } = {}, stream = false) {
  const base = { id: `offline-scheduled-${sequence}`, object: 'chat.completion.chunk', created: 0, model: 'offline' }
  const delta = textOnly ? { role: 'assistant', content: 'I did not submit.' } : { role: 'assistant', tool_calls: [{ index: 0, id: `local-${sequence}`, type: 'function', function: { name: wire.toolName || 'submitStoryboardSegment', arguments: wire.argumentsText ?? JSON.stringify(args) } }] }
  if (!stream) {
    const message = textOnly ? delta : { ...delta, content: null, tool_calls: delta.tool_calls!.map(({ index: _index, ...call }) => call) }
    return new Response(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: textOnly ? 'stop' : 'tool_calls' }],
      usage: { prompt_tokens: 30, completion_tokens: 24, total_tokens: 54 } }), { headers: { 'content-type': 'application/json' } })
  }
  const chunks = [{ ...base, choices: [{ index: 0, delta, finish_reason: null }] }, { ...base, choices: [{ index: 0, delta: {}, finish_reason: textOnly ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 30, completion_tokens: 24, total_tokens: 54 } }]
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
}
let agentId = 0
function mocked(f: ReturnType<typeof fixture>, change?: (input: any, payload: any, count: number) => any,
  wire?: (payload: any, count: number) => { toolName?: string; argumentsText?: string }) {
  let requests = 0, reads = 0
  const payloads: any[] = [], bodies: any[] = [], protocols: string[] = []
  const dependencies = {
    outputMode: 'tool' as const,
    textMode: undefined as 'complete' | 'stream' | undefined,
    readContext: async (requestContext: any) => { reads++; return (storyboardTools.readStoryboardContext.execute as any)({}, { requestContext }) },
    createAgent: (tools: Record<string, any>, instructions: string) => {
      protocols.push(instructions)
      const provider = createOpenAI({ apiKey: 'offline-only', baseURL: 'https://example.invalid/v1', fetch: async (_url, init) => {
        requests++
        assert.ok(requests <= f.schedule.length + 2, 'No hidden generation or retry loop is allowed')
        const body = JSON.parse(String(init?.body)); bodies.push(body)
        if (dependencies.textMode === 'stream') assert.equal(body.stream, true)
        else assert.notEqual(body.stream, true, 'Scheduled production calls use native complete JSON, not SSE')
        assert.equal(Object.hasOwn(body, 'textMode'), false, 'Internal mode selection must never enter the provider request')
        assert.equal(body.tool_choice.function.name, 'submitStoryboardSegment')
        assert.equal(body.messages.some((message: any) => ['assistant', 'tool'].includes(message.role)), false, 'Each request starts without previous HTTP tool history')
        const user = body.messages.filter((message: any) => message.role === 'user').at(-1)
        const text = typeof user.content === 'string' ? user.content : user.content.map((part: any) => part.text || '').join('')
        assert.ok(!text.includes('unused-private-image-marker'))
        const payload = JSON.parse(text); payloads.push(payload)
        const group = f.schedule[payload.current_group.number - 1]
        const input = change ? change(creative(f, group), payload, requests) : creative(f, group)
        if (requests > 1) assert.equal(f.rows()[0].id, f.old.id, 'Previous groups stay staged until the complete episode commits')
        return response(input, requests, input === null, wire?.(payload, requests), body.stream === true)
      } })
      return new Agent({ id: `scheduled-offline-${++agentId}`, name: 'Scheduled offline native', instructions, model: provider.chat('offline'), tools, maxRetries: 0 })
    },
  }
  return { dependencies, payloads, bodies, protocols, requests: () => requests, reads: () => reads }
}
const options = (f: ReturnType<typeof fixture>) => ({ episodeId: f.episode.id, dramaId: f.drama.id, requestContext: f.requestContext, session: f.session, message: '根据原剧本逐组完整拍摄。' })

async function withNativeJsonMock(f: ReturnType<typeof fixture>, run: (mock: {
  dependencies: { readContext: (requestContext: any) => Promise<any>; createAgent: (tools: Record<string, any>, instructions: string, responseSchema?: Record<string, unknown>) => Agent };
  bodies: any[]; payloads: any[]; requests: () => number; finishes: () => number;
}) => Promise<void>, change?: (input: any, payload: any, count: number) => unknown) {
  const originalFetch = globalThis.fetch, originalFinish = f.session.finish.bind(f.session), before = f.rows()
  const bodies: any[] = [], payloads: any[] = []
  let requests = 0, finishes = 0
  f.session.finish = async () => { finishes++; return originalFinish() }
  globalThis.fetch = (async (_url, init) => {
    requests++
    assert.ok(requests <= f.schedule.length + 1, 'The entire job has only one repair request')
    const body = JSON.parse(String(init?.body)); bodies.push(body)
    assert.equal(body.response_format?.type, 'json_schema')
    assert.equal(body.response_format.json_schema.name, 'storyboard_segment')
    assert.equal(body.response_format.json_schema.strict, true)
    const responseSchema = body.response_format.json_schema.schema
    const assertClosedObjects = (value: any) => {
      if (!value || typeof value !== 'object') return
      if (!Array.isArray(value) && (value.type === 'object' || value.properties)) {
        assert.equal(value.additionalProperties, false, 'Every wire object rejects unknown fields')
        assert.deepEqual([...(value.required || [])].sort(), Object.keys(value.properties || {}).sort(), 'Every wire property is required')
      }
      Object.values(value).forEach(assertClosedObjects)
    }
    assert.equal(responseSchema.type, 'object')
    assertClosedObjects(responseSchema)
    for (const key of ['tools', 'tool_choice', 'textMode', 'outputMode']) assert.equal(Object.hasOwn(body, key), false, key)
    assert.notEqual(body.stream, true)
    assert.equal(body.messages.some((message: any) => ['assistant', 'tool'].includes(message.role)), false)
    const user = body.messages.filter((message: any) => message.role === 'user').at(-1)
    const text = typeof user.content === 'string' ? user.content : user.content.map((part: any) => part.text || '').join('')
    assert.equal(text.includes('unused-private-image-marker'), false)
    const payload = JSON.parse(text); payloads.push(payload)
    assert.deepEqual(f.rows(), before, 'All earlier groups remain staged until the whole episode commits')
    const group = f.schedule[payload.current_group.number - 1], layout = getScheduledShotLayout(group.rows.length)
    assert.equal(Object.keys(responseSchema.properties).filter(key => /^shot_\d+$/.test(key)).length, layout.length)
    layout.forEach((length, index) => {
      const visuals = responseSchema.properties[`shot_${index + 1}`].properties.visuals
      assert.equal(visuals.minItems, length)
      assert.equal(visuals.maxItems, length, 'Each wire shot has its exact scheduled visual row count')
    })
    const input = creative(f, group)
    input.voice = input.shot_1.voice ?? input.shot_2.voice ?? null
    const output = change ? change(input, payload, requests) : input
    return new Response(JSON.stringify({ id: `offline-json-${requests}`, object: 'chat.completion', created: 0, model: 'offline',
      choices: [{ index: 0, message: { role: 'assistant', content: typeof output === 'string' ? output : JSON.stringify(output) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 30, completion_tokens: 24, total_tokens: 54 },
    }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const dependencies = {
    // Omit outputMode: these tests exercise the production default, not an opt-in test branch.
    readContext: async (requestContext: any) => (storyboardTools.readStoryboardContext.execute as any)({}, { requestContext }),
    createAgent: (tools: Record<string, any>, instructions: string, responseSchema?: Record<string, unknown>) => {
      assert.deepEqual(Object.keys(tools), [], 'The default JSON driver supplies no native tools')
      assert.ok(responseSchema, 'The default JSON driver supplies its current group response schema')
      const provider = createOpenAI({ apiKey: 'offline-only', baseURL: 'https://example.invalid/v1',
        fetch: createTextProviderFetch({ provider: 'openai', baseURL: 'https://example.invalid/v1',
          jsonSchemaOutput: { name: 'storyboard_segment', schema: responseSchema } }),
      })
      return new Agent({ id: `scheduled-json-offline-${++agentId}`, name: 'Scheduled JSON offline native', instructions, model: provider.chat('offline'), tools, maxRetries: 0 })
    },
  }
  try { await run({ dependencies, bodies, payloads, requests: () => requests, finishes: () => finishes }) }
  finally { globalThis.fetch = originalFetch; f.session.finish = originalFinish }
}

test('default JSON mode uses native SDK strict schema requests once per group and commits the whole episode once', async () => {
  const phases: string[] = [], f = fixture(undefined, phase => phases.push(phase))
  await withNativeJsonMock(f, async mock => {
    const result = await runScheduledStoryboardBreakdown(options(f), mock.dependencies)
    assert.equal(result?.status, 'done')
    assert.equal(result.saved, f.schedule.length)
    assert.equal(result.attempt, 0)
    assert.equal(mock.requests(), f.schedule.length)
    assert.equal(mock.finishes(), 1)
    assert.equal(phases.filter(phase => phase === 'saving').length, 1)
    assert.deepEqual(mock.payloads.map(payload => payload.current_group.number), f.schedule.map(group => group.source_group))
    assert.ok(mock.payloads.every(payload => payload.script === f.episode.scriptContent))
    assert.ok(mock.payloads[1].previous_ending.description.includes('【镜头'))
    assert.deepEqual(f.rows().map(row => row.duration), f.schedule.map(group => group.duration))
    assert.ok(!f.rows().some(row => row.id === f.old.id))
    assert.ok(result.result.steps.every(step => step.modelSteps === 1 && step.submissions === 1 && step.staged && step.finishReason === 'stop'))
  })
})

test('default JSON parsing or schema rejection receives only one directed current-group repair', async () => {
  for (const failure of ['invalid_json', 'schema']) {
    const f = fixture()
    await withNativeJsonMock(f, async mock => {
      const result = await runScheduledStoryboardBreakdown(options(f), mock.dependencies)
      assert.equal(result?.status, 'done')
      assert.equal(result.attempt, 1)
      assert.equal(mock.requests(), f.schedule.length + 1)
      assert.equal(mock.finishes(), 1)
      assert.deepEqual(mock.payloads.slice(0, 3).map(payload => payload.current_group.number), [1, 1, 2])
      assert.ok(mock.payloads[1].directed_repair.issues.length)
      if (failure === 'schema') assert.deepEqual(mock.payloads[1].directed_repair.rejected_submission.shot_1.visuals, [])
      assert.equal(result.result.steps[0].submissions, 0)
      assert.equal(result.result.steps[0].staged, false)
      assert.equal(result.result.steps[1].submissions, 1)
      assert.equal(f.rows().length, f.schedule.length)
      assert.equal(JSON.stringify(result.result).includes('private-json-response-marker'), false)
    }, (input, _payload, count) => {
      if (count === 1 && failure === 'invalid_json') return '{"title": private-json-response-marker}'
      if (count === 1) input.shot_1.visuals = []
      return input
    })
  }
})

test('a second JSON error in a later group cannot obtain another repair or replace any of the old draft', async () => {
  const f = fixture(), before = f.rows()
  await withNativeJsonMock(f, async mock => {
    const result = await runScheduledStoryboardBreakdown(options(f), mock.dependencies)
    assert.equal(result?.status, 'needs_revision')
    assert.equal(result.saved, 0)
    assert.equal(result.attempt, 1)
    assert.equal(mock.requests(), 3)
    assert.equal(mock.finishes(), 0)
    assert.deepEqual(mock.payloads.map(payload => payload.current_group.number), [1, 1, 2])
    assert.equal(result.result.steps[1].staged, true, 'A successful earlier group still never commits by itself')
    assert.equal(result.result.steps[2].submissions, 0)
    assert.ok(result.issues.some(issue => issue.severity === 'error'))
    assert.deepEqual(f.rows(), before)
  }, (input, payload, count) => {
    if (count === 1) return '{"title": unquoted}'
    if (payload.current_group.number === 2) input.shot_1.visuals = []
    return input
  })
})

test('native complete-JSON scheduled runner reads once, submits once per group and commits the complete episode atomically', async () => {
  const f = fixture(), mock = mocked(f), states: string[] = []
  const result = await runScheduledStoryboardBreakdown({ ...options(f), onState: (phase, attempt) => states.push(`${phase}:${attempt}`) }, mock.dependencies)
  assert.equal(result?.status, 'done'); assert.equal(result.saved, f.schedule.length); assert.equal(result.attempt, 0)
  assert.equal(mock.reads(), 1); assert.equal(mock.requests(), f.schedule.length)
  assert.ok(mock.bodies.every(body => body.stream !== true))
  assert.deepEqual(f.rows().map(row => row.duration), f.schedule.map(group => group.duration))
  assert.ok(f.rows().some(row => row.duration === 15), 'A long original line keeps its capacity-safe duration')
  assert.equal(result.result.steps.length, f.schedule.length)
  assert.ok(result.result.steps.every(step => step.modelSteps === 1 && step.submissions === 1 && step.staged))
  assert.ok(result.result.steps.every(step => step.finishReason === 'tool-calls' && step.outputTokens === 24))
  assert.ok(!JSON.stringify(result.result).includes('好好好'), 'Safe step summaries never contain raw prompts or arguments')
  assert.ok(mock.payloads[0].current_script_slice.includes('动作：阿甲在院内抬头'))
  assert.ok(mock.payloads.at(-1).current_script_slice.includes('等待回应'))
  assert.ok(mock.payloads[1].previous_ending.description.includes('【镜头'))
  assert.ok(mock.protocols[0].includes('优先按示意只在顶层填写一次完整voice'))
  assert.ok(mock.protocols[0].includes('shot_1的voice可省略并复用顶层完整voice'))
  assert.ok(mock.protocols[0].includes('shot_2的voice可省略并复用顶层完整voice'))
  assert.ok(mock.protocols[0].includes('每镜visuals允许1–2行'))
  assert.ok(!mock.protocols[0].includes('每镜visuals数量、台词原词'))
  assert.ok(mock.protocols[1].includes('无原文槽的镜头不加声音'))
  assert.ok(mock.protocols[1].includes('"shot_1":') && mock.protocols[1].includes('"shot_2":') && mock.protocols[1].includes('"shot_3":'))
  assert.ok(mock.protocols.every(value => value.includes('一次提交必须同时包含下面全部shot_i键') && value.includes('第2项是同一机位、焦段、景别和主要运镜的延续')))
  assert.ok(mock.protocols.every(value => value.includes('visuals严禁复写台词或引用原句')))
  assert.ok(mock.protocols.every(value => value.includes('不要返回rows、dialogue或rows[].dialogue')))
  assert.deepEqual(mock.payloads[0].current_group.allowed_shot_layouts, [[1, 2], [2, 1]])
  assert.equal(mock.payloads[0].current_group.total_rows, 3)
  assert.equal(mock.payloads[0].current_group.shot_layout_is_suggestion, true)
  assert.ok(states.includes('validating:0'))
})

test('native SDK schema failure gets one directed current-group repair and then continues later groups', async () => {
  const f = fixture(), mock = mocked(f, (input, _payload, count) => { if (count === 1) input.shot_1.visuals = []; return input })
  const result = await runScheduledStoryboardBreakdown(options(f), mock.dependencies)
  assert.equal(result?.status, 'done'); assert.equal(result.attempt, 1)
  assert.equal(mock.requests(), f.schedule.length + 1)
  assert.deepEqual(mock.payloads.slice(0, 3).map(payload => payload.current_group.number), [1, 1, 2])
  assert.ok(mock.payloads[1].directed_repair.issues.length)
  assert.deepEqual(mock.payloads[1].directed_repair.rejected_submission.shot_1.visuals, [])
  assert.equal(result.result.steps[0].submissions, 0, 'SDK rejection never executes a submission')
  assert.equal(f.rows().length, f.schedule.length)
})

test('native missing-voice schema rejection preserves the actual submission locally and in the only directed repair', async () => {
  const f = fixture('阿甲：你好。')
  let originalInput: any
  const mock = mocked(f, (input, payload, count) => {
    if (count === 1) {
      delete input.shot_1.voice
      originalInput = structuredClone(input)
    } else {
      assert.deepEqual(payload.directed_repair.rejected_submission, originalInput)
      assert.deepEqual(f.session.getReport().rejectedToolInput?.input, originalInput)
      assert.ok(f.session.getIssues().some(issue => issue.message.includes('shot_1.voice')))
    }
    return input
  })
  const result = await runScheduledStoryboardBreakdown(options(f), mock.dependencies)
  assert.equal(result?.status, 'done')
  assert.equal(result.attempt, 1)
  assert.equal(mock.requests(), 2)
  assert.equal(result.result.steps[0].submissions, 0, 'the rejected voice structure never reaches execute')
  assert.ok(result.result.steps[0].errorMessages.some(message => message.includes('shot_1.voice')), 'a successful repair must not erase the original schema diagnostic')
  assert.ok(result.result.steps[0].errorMessages.every(message => !message.includes('Provided arguments:') && !message.includes(originalInput.space)), 'step diagnostics never contain raw submitted fields')
  assert.equal(result.result.steps[1].submissions, 1)
  assert.equal(f.rows().length, 1)
})

test('native scheduled submission binds a uniquely referenced prop without another model request', async () => {
  const f = fixture('阿甲：你好。')
  const prop = db.insert(schema.props).values({ dramaId: f.drama.id, name: '全家福', ...timestamps }).returning().get()
  const mock = mocked(f, input => {
    input.prop_ids = []
    input.shot_1.visuals[0] += '@全家福挂在现有墙上，玻璃反射原有晨光。'
    return input
  })
  const result = await runScheduledStoryboardBreakdown(options(f), mock.dependencies)
  assert.equal(result?.status, 'done')
  assert.equal(result.attempt, 0)
  assert.equal(mock.requests(), 1)
  const links = db.select().from(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, f.rows()[0].id)).all()
  assert.deepEqual(links.map(link => link.propId), [prop.id])
  assert.ok(f.rows()[0].videoPrompt?.includes('@全家福'))
})

test('a real complete input with only shared top-level voice and a referenced family photo compiles and commits in one request', async () => {
  const f = fixture(`阿甲：${'好'.repeat(20)}。`)
  const prop = db.insert(schema.props).values({ dramaId: f.drama.id, name: '全家福', ...timestamps }).returning().get()
  const mock = mocked(f, input => {
    input.voice = input.shot_1.voice
    delete input.shot_1.voice
    delete input.shot_2.voice
    input.prop_ids = []
    input.shot_1.visuals[0] += '@全家福挂在现有墙上，玻璃反射原有晨光。'
    return input
  })
  const result = await runScheduledStoryboardBreakdown(options(f), mock.dependencies)
  assert.equal(result?.status, 'done')
  assert.equal(result.attempt, 0)
  assert.equal(mock.requests(), 1)
  const spoken = result.candidateReport.candidates[0].video_prompt_plan!.shots.flatMap(shot => shot.rows).flatMap(row => row.dialogue || [])
  assert.equal(spoken.length, 2)
  assert.ok(spoken.every(speech => speech.voice.age === '中年' && speech.voice.delivery === '呼吸平稳，清楚回应，尾音自然落下'))
  const links = db.select().from(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, f.rows()[0].id)).all()
  assert.deepEqual(links.map(link => link.propId), [prop.id])
  assert.equal(f.rows().length, 1)
})

test('legal two-one and two-one-two row allocations preserve source and duration without consuming a repair', async () => {
  for (const count of [20, 47]) {
    const f = fixture(`阿甲：${'好'.repeat(count)}。`)
    const mock = mocked(f, input => {
      input.voice = input.shot_1.voice
      for (const key of ['shot_1', 'shot_2', 'shot_3']) if (input[key]) delete input[key].voice
      if (count === 20) input.shot_1.visuals.push(input.shot_2.visuals.shift())
      else input.shot_3.visuals.unshift(input.shot_2.visuals.pop())
      return input
    })
    const result = await runScheduledStoryboardBreakdown(options(f), mock.dependencies)
    assert.equal(result?.status, 'done')
    assert.equal(result.attempt, 0)
    assert.equal(mock.requests(), 1)
    const plan = result.candidateReport.candidates[0].video_prompt_plan!
    assert.deepEqual(plan.shots.map(shot => shot.rows.length), count === 20 ? [2, 1] : [2, 1, 2])
    assert.equal(f.rows()[0].duration, f.schedule[0].duration)
    assert.equal(plan.shots.flatMap(shot => shot.rows).flatMap(row => row.dialogue || []).length, f.guide[0].fragments.length)
  }
})

test('an explicit secondary hand-only figure gains only a hidden-face participant and requires no repair', async () => {
  const f = fixture('阿甲：你好。')
  const secondary = db.insert(schema.characters).values({ dramaId: f.drama.id, name: '老年高大山', ...timestamps }).returning().get()
  const mock = mocked(f, input => {
    input.shot_1.visuals[0] = '@阿甲正面近景，固定镜头保持3秒，画面边缘保留@老年高大山撑床的手作次要落点，现有晨光方向不变。'
    return input
  })
  const result = await runScheduledStoryboardBreakdown(options(f), mock.dependencies)
  assert.equal(result?.status, 'done')
  assert.equal(result.attempt, 0)
  assert.equal(mock.requests(), 1)
  const candidate = result.candidateReport.candidates[0]
  const participant = candidate.video_prompt_plan!.shots[0].characters.find(character => character.character_id === secondary.id)
  assert.equal(participant?.visibility, 'face_hidden')
  assert.equal(participant?.emotion, undefined)
  assert.ok(candidate.character_ids?.includes(secondary.id))
  assert.ok(!f.rows()[0].videoPrompt?.includes('老年高大山呈现'))
})

test('native complete JSON accepts a source speaker over an existing actor reaction shot without spending the repair', async () => {
  for (const explicitlyOffscreen of [false, true]) {
  const text = '你看这张照片。', f = fixture(`阿甲：（低语）${text}`)
  const reactionActor = db.insert(schema.characters).values({ dramaId: f.drama.id, name: '老年高大山', ...timestamps }).returning().get()
  const mock = mocked(f, input => {
    input.space = input.space.replaceAll('@阿甲', '@老年高大山')
    for (const key of ['shot_1', 'shot_2']) {
      input[key].characters = [{ character_id: reactionActor.id, visibility: 'face_visible', emotion: { expression: '错愕僵住', intensity: 93 } }]
      if (explicitlyOffscreen) input[key].characters.push({ character_id: f.character.id, visibility: 'offscreen' })
      input[key].visuals = input[key].visuals.map(() => '@老年高大山正面近景，固定镜头保持3秒，伸手轻碰原有照片，指尖停住，晨光方向不变。')
    }
    input.shot_1.visuals[0] += '他急促喘息后视线从@阿甲脸上移开，追向矮柜方向。'
    return input
  })
  const result = await runScheduledStoryboardBreakdown(options(f), mock.dependencies)
  assert.equal(result?.status, 'done')
  assert.equal(result.attempt, 0)
  assert.equal(mock.requests(), 1)
  const saved = f.rows()[0]
  assert.ok(saved.videoPrompt?.includes(`画外音（同场对白）：@阿甲说：「${text}」`))
  assert.ok(saved.description?.includes(`画外音（同场对白）：阿甲说：「${text}」`))
  assert.ok(!saved.videoPrompt?.split('\n')[0].includes('@阿甲'))
  const sourceSlot = result.candidateReport.candidates[0].video_prompt_plan!.shots[0].rows[0].dialogue![0]
  assert.deepEqual({ source_line: sourceSlot.source_line, fragment_index: sourceSlot.fragment_index }, { source_line: 1, fragment_index: 1 })
  assert.equal(Object.hasOwn(sourceSlot, 'kind'), false, 'the input stays canonical instead of changing its source kind')
  }
})

test('a declared positive cut in the continuation visual becomes its real third shot without changing fixed source or time slots', async () => {
  const f = fixture(`阿甲：${'好'.repeat(20)}。`), mock = mocked(f, input => {
    input.shot_2.visuals[1] = '切到50mm中景，@阿甲保持原坐标，缓缓放下左手，原有晨光方向不变。'
    return input
  })
  const result = await runScheduledStoryboardBreakdown(options(f), mock.dependencies)
  assert.equal(result?.status, 'done')
  assert.equal(result.attempt, 0)
  assert.equal(mock.requests(), 1)
  const saved = f.rows()[0]
  assert.equal(saved.duration, f.schedule[0].duration)
  assert.equal(saved.description?.match(/【镜头\d+】/g)?.length, 3)
  assert.ok(saved.videoPrompt?.includes('6-9秒：切到50mm中景'))
  assert.ok(!result.issues.some(issue => issue.code === 'shot_time_mapping'))
})

test('exact copied source-seven quotes and explicit word-reaction quotes normalize without duplicating canonical speech', async () => {
  const text = '不只骗你。刚才那片药，也不是止疼的。'
  const f = fixture(`阿甲：${text}`), fragments = f.guide[0].fragments
  assert.deepEqual(fragments, ['不只骗你。刚才那片药，也不是止', '疼的。'])
  const mock = mocked(f, input => {
    input.shot_1.visuals[0] = `@阿甲正面近景，抬眼后用冷静语气说：「${fragments[0]}」，左手保持原位，现有晨光方向不变。`
    input.shot_2.visuals[0] = `@阿甲听见“药”字时眉心收紧，轻声说：「${fragments[1]}」，随后缓缓放下左手。`
    return input
  })
  const result = await runScheduledStoryboardBreakdown(options(f), mock.dependencies)
  assert.equal(result?.status, 'done')
  assert.equal(result.attempt, 0)
  assert.equal(mock.requests(), 1)
  const saved = f.rows()[0]
  for (const fragment of fragments) {
    assert.equal(saved.description!.split(fragment).length - 1, 1)
    assert.equal(saved.videoPrompt!.split(fragment).length - 1, 1)
  }
  assert.ok(saved.videoPrompt?.includes('听见药字时'))
  assert.ok(!saved.videoPrompt?.includes('听见“药”字时'))
  assert.ok(!result.issues.some(issue => issue.code === 'dialogue_preservation'))
})

test('invented quoted dialogue in a visual is never swallowed or accepted as an extra canonical source', async () => {
  const f = fixture('阿甲：你好。'), before = f.rows(), mock = mocked(f, input => {
    input.shot_1.visuals[0] += '阿甲说：「别怕。」'
    return input
  })
  const result = await runScheduledStoryboardBreakdown(options(f), mock.dependencies)
  assert.equal(result?.status, 'needs_revision')
  assert.equal(result.saved, 0)
  assert.equal(mock.requests(), 2)
  assert.ok(JSON.stringify(result.candidateReport.rejectedToolInput?.input).includes('别怕'))
  assert.deepEqual(f.rows(), before)
})

test('a content failure repairs only that group while retaining earlier candidates and continuing the rest', async () => {
  const f = fixture(), mock = mocked(f, (input, payload, count) => {
    if (payload.current_group.number === 2 && count === 2) delete input.shot_1.characters[0].emotion
    return input
  })
  const result = await runScheduledStoryboardBreakdown(options(f), mock.dependencies)
  assert.equal(result?.status, 'done'); assert.equal(result.attempt, 1)
  assert.deepEqual(mock.payloads.map(payload => payload.current_group.number), [1, 2, 2, 3])
  assert.ok(mock.payloads[2].directed_repair.rejected_submission.shot_1)
  assert.equal(result.result.steps[1].staged, false)
  assert.equal(f.rows().length, 3)
})

test('a later new error after the only repair stops without partial commit or another model call', async () => {
  const f = fixture(), before = f.rows(), mock = mocked(f, (input, payload, count) => {
    if (count === 1) input.shot_1.visuals = []
    if (payload.current_group.number === 2) delete input.shot_1.characters[0].emotion
    return input
  })
  const result = await runScheduledStoryboardBreakdown(options(f), mock.dependencies)
  assert.equal(result?.status, 'needs_revision'); assert.equal(result.saved, 0); assert.equal(result.attempt, 1)
  assert.equal(mock.requests(), 3)
  assert.ok(result.issues.some(issue => issue.code === 'plan_emotion'))
  assert.deepEqual(f.rows(), before)
})

test('ignoring the forced submit cannot become success and spends at most one directed repair', async () => {
  const f = fixture(), before = f.rows(), mock = mocked(f, () => null)
  const result = await runScheduledStoryboardBreakdown(options(f), mock.dependencies)
  assert.equal(result?.status, 'needs_revision'); assert.equal(result.saved, 0)
  assert.equal(mock.requests(), 2); assert.equal(f.session.hasCandidates(), false)
  assert.deepEqual(f.rows(), before)
})

test('native unknown tool names produce safe specific diagnostics without aliases or extra repair attempts', async () => {
  const f = fixture('阿甲：你好。'), before = f.rows(), mock = mocked(f, input => {
    input.title = 'private-raw-argument-marker'
    return input
  }, () => ({ toolName: 'submit_storyboard_segment' }))
  mock.dependencies.textMode = 'stream'
  const result = await runScheduledStoryboardBreakdown(options(f), mock.dependencies)
  assert.equal(result?.status, 'needs_revision')
  assert.equal(mock.requests(), 2)
  assert.deepEqual(f.rows(), before)
  assert.ok(result.result.steps.every(step => step.submissions === 0 && step.callCount === 1))
  assert.ok(result.result.steps.every(step => step.toolNames.includes('submit_storyboard_segment')))
  assert.ok(result.result.steps.every(step => step.toolErrorNames.includes('ToolNotFoundError')))
  assert.ok(result.result.steps.every(step => step.eventTypes.includes('tool-error')))
  assert.ok(result.issues.some(issue => issue.message.includes('未注册工具 submit_storyboard_segment')))
  assert.ok(!JSON.stringify(result.result).includes('private-raw-argument-marker'))
  assert.ok(!JSON.stringify(result.result).includes('原点A0'), 'diagnostics must not dump submitted prose')
})

test('native malformed JSON is recognized from bounded input events even when FullOutput drops every parsed tool call', async () => {
  const f = fixture('阿甲：你好。'), before = f.rows(), raw = '{"title":"private-json-marker","shot_1":'
  const mock = mocked(f, undefined, () => ({ argumentsText: raw }))
  mock.dependencies.textMode = 'stream'
  const result = await runScheduledStoryboardBreakdown(options(f), mock.dependencies)
  assert.equal(result?.status, 'needs_revision')
  assert.equal(mock.requests(), 2)
  assert.deepEqual(f.rows(), before)
  for (const step of result.result.steps) {
    assert.equal(step.submissions, 0)
    assert.equal(step.fullFinishReason, 'tool-calls')
    assert.equal(step.callCount, 1)
    assert.equal(step.parsedCallCount, 0)
    assert.ok(step.toolNames.includes('submitStoryboardSegment'))
    assert.ok(step.eventTypes.includes('tool-call-input-streaming-start'))
    assert.ok(step.eventTypes.includes('tool-call-delta'))
    assert.ok(step.toolInputs.some(input => input.inputChars === raw.length && input.inputState === 'invalid_json' && !input.callSeen && !input.ended))
  }
  assert.ok(result.issues.some(issue => issue.message.includes('JSON')))
  assert.ok(!JSON.stringify(result.result).includes('private-json-marker'))
  assert.ok(!JSON.stringify(result.result).includes('argumentsText'))
})

test('empty or any non-Chinese dialogue returns null without beginning or cancelling the fallback session', async () => {
  for (const script of ['动作：阿甲走过院门。', '阿甲：Hello.', '阿甲：你好。\n阿甲：Hello.']) {
    const f = fixture(script), mock = mocked(f)
    let began = 0, cancelled = 0
    const originalBegin = f.session.beginAttempt.bind(f.session), originalCancel = f.session.cancel.bind(f.session)
    f.session.beginAttempt = attempt => { began++; return originalBegin(attempt) }
    f.session.cancel = reason => { cancelled++; return originalCancel(reason) }
    const result = await runScheduledStoryboardBreakdown(options(f), mock.dependencies)
    assert.equal(result, null); assert.equal(mock.requests(), 0); assert.equal(mock.reads(), 1)
    assert.equal(began, 0); assert.equal(cancelled, 0)
  }
})

test('explicit Chinese dialogue with an empty schedule is a validation failure, never a compatibility fallback', async () => {
  const f = fixture('阿甲：你好。'), before = f.rows(), mock = mocked(f)
  const readContext = mock.dependencies.readContext
  mock.dependencies.readContext = async requestContext => ({ ...await readContext(requestContext), dialogue_group_schedule: [] })
  const result = await runScheduledStoryboardBreakdown(options(f), mock.dependencies)
  assert.equal(result?.status, 'needs_revision')
  assert.equal(result.saved, 0)
  assert.ok(result.issues.some(issue => issue.code === 'scheduled_source_coverage'))
  assert.equal(mock.requests(), 0)
  assert.equal(f.session.hasCandidates(), false)
  assert.deepEqual(f.rows(), before)
})

test('deadline closes the current submit tool before a late response can stage or commit', async () => {
  const f = fixture('阿甲：你好。'), before = f.rows()
  let late: Promise<unknown> | undefined
  await assert.rejects(runScheduledStoryboardBreakdown(options(f), {
    outputMode: 'tool',
    timeoutMs: 15,
    textMode: 'stream',
    readContext: requestContext => (storyboardTools.readStoryboardContext.execute as any)({}, { requestContext }),
    createAgent: tools => ({ stream: async () => ({ getFullOutput: () => {
      late = new Promise(resolve => setTimeout(async () => resolve(await tools.submitStoryboardSegment.execute(creative(f, f.schedule[0]))), 40))
      return late.then(() => ({ steps: [] }))
    } }) }),
  }), /超时/)
  await late
  assert.equal(f.session.hasCandidates(), false)
  assert.deepEqual(f.rows(), before)
})

test('a complete-mode transport failure is thrown after one call without a stream fallback or repair request', async () => {
  const f = fixture('阿甲：你好。'), before = f.rows()
  let completeCalls = 0, streamCalls = 0
  await assert.rejects(runScheduledStoryboardBreakdown(options(f), {
    readContext: requestContext => (storyboardTools.readStoryboardContext.execute as any)({}, { requestContext }),
    createAgent: () => ({
      generate: async () => { completeCalls++; throw new Error('offline complete transport failure') },
      stream: async () => { streamCalls++; throw new Error('stream fallback must never run') },
    }),
  }), /offline complete transport failure/)
  assert.equal(completeCalls, 1)
  assert.equal(streamCalls, 0)
  assert.deepEqual(f.rows(), before)
})

test('an abort during the final saving phase cancels synchronously before the episode transaction writes', async () => {
  const controller = new AbortController()
  const f = fixture('阿甲：你好。', phase => { if (phase === 'saving') controller.abort(new Error('offline abort at commit')) })
  const before = f.rows(), mock = mocked(f)
  await assert.rejects(runScheduledStoryboardBreakdown({ ...options(f), signal: controller.signal }, mock.dependencies), /offline abort at commit/)
  assert.deepEqual(f.rows(), before)
  assert.equal(mock.requests(), 1)
})
