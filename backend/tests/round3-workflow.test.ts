import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Agent } from '@mastra/core/agent'
import { createOpenAI } from '@ai-sdk/openai'

// Round 3 (2026-11-08) workflow behaviour, from the real 23:13 run of another text model:
//  S2  a group that refused only because its previous group was unfinished is retried once that group is ready
//  S1  missing shot_number/source_ids and renamed voice-cue keys no longer cost a repair request
//  S3  the request wait follows the output budget (6–10 minutes) instead of a flat 5 minutes
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-round3-'))
process.env.SQLITE_PATH = path.join(directory, 'round3.sqlite3')
process.env.HUOBAO_DATA_DIR = directory
process.env.STORAGE_PATH = path.join(directory, 'static')
process.env.WORKSPACE_PATH = path.join(directory, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.ts')
const fixtureOwner = await (await import('./helpers/platform-fixture.ts')).platformFixtureOwner()
const { createStoryboardSession } = await import('../src/services/storyboard-session.ts')
const { StoryboardDraftStore } = await import('../src/services/storyboard-draft-store.ts')
const { runSkillStoryboardWorkflow } = await import('../src/services/skill-storyboard-workflow.ts')
const { buildAgentRequestContext } = await import('../src/agents/context.ts')
const store = new StoryboardDraftStore(db.$client)
const timestamps = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
after(async () => { db.$client.close(); await fs.rm(directory, { recursive: true, force: true }) })

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
// Two 10-second groups require enough body text after screenplay labels are excluded.
const script = `${padding(5)}\n阿甲：回来，一起走。\n${padding(5)}\n阿乙：好。`
const profileA = { age: '三十岁成年男声', register: '中低音区', timbre: '低沉略带沙哑' }
const profileB = { age: '二十岁成年女声', register: '中高音区', timbre: '清亮稍带紧涩' }

function harness(responder: (payload: any, stage: string, f: any) => unknown, extra: Record<string, unknown> = {}) {
  const drama = db.insert(schema.dramas).values({ ownerUserId: fixtureOwner.id, title: 'round3', ...timestamps }).returning().get()
  const episode = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: 'E', scriptContent: script, ...timestamps }).returning().get()
  const a = db.insert(schema.characters).values({ dramaId: drama.id, name: '阿甲', ...timestamps }).returning().get()
  const b = db.insert(schema.characters).values({ dramaId: drama.id, name: '阿乙', ...timestamps }).returning().get()
  const scene = db.insert(schema.scenes).values({ dramaId: drama.id, location: '院落', time: '日', prompt: '院落', ...timestamps }).returning().get()
  const f = { drama, episode, a, b, scene }
  const requests: Array<{ stage: string; payload: any }> = []
  const errors: string[] = []
  const dependencies = { store, modelIdentity: { provider: 'openai', model: 'gemini-4-argon' }, batchSize: 1, modelLimits: { maxOutputTokens: 16_384 },
    recoveryDelayMs: 0, requestTimeoutMs: 60_000, ...extra,
    readContext: async () => ({ episode: { id: episode.id, title: 'E' }, script, characters: [{ id: a.id, name: a.name }, { id: b.id, name: b.name }], scenes: [{ id: scene.id, location: scene.location }], props: [], existing_storyboards: [] }),
    loadInstructions: async () => ({ plan: 'P', expand: 'E', prompt: 'V' }),
    createAgent: (stage: string, instructions: string) => {
      const provider = createOpenAI({ apiKey: 'offline', baseURL: 'https://example.invalid/v1', fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        const message = body.messages.filter((entry: any) => entry.role === 'user').at(-1)
        const payload = JSON.parse(typeof message.content === 'string' ? message.content : message.content.map((part: any) => part.text || '').join(''))
        requests.push({ stage, payload })
        let value: any
        try { value = responder(payload, stage, f) } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); throw error }
        const repair = payload.targeted_repair
        if (repair && value && !value.conflict && !value.base_version) value = { base_version: repair.base_version, changes: Object.fromEntries(repair.allowed_changes.filter((key: string) => Object.hasOwn(value, key)).map((key: string) => [key, value[key]])) }
        return sse(JSON.stringify({ output: value }))
      } })
      return new Agent({ id: `round3-${++counter}`, name: 'round3', instructions, model: provider.chat('offline'), tools: {}, maxRetries: 0 })
    },
  }
  const start = () => {
    const session = createStoryboardSession({ mode: 'breakdown', episodeId: episode.id, dramaId: drama.id, validationProfile: 'skill-content' })
    const requestContext = buildAgentRequestContext({ episodeId: episode.id, dramaId: drama.id, language: 'zh' })
    requestContext.set('storyboardSession' as never, session as never)
    return { episodeId: episode.id, dramaId: drama.id, mode: 'breakdown' as const, session, requestContext, message: '按原skill完整生成。' }
  }
  return { f, requests, errors, dependencies, start }
}
const plan = (f: any) => ({ groups: [
  { number: 1, title: '一', beat: 'narrative', source_ids: [1, 2], scene_id: f.scene.id, duration: 10 },
  { number: 2, title: '二', beat: 'narrative', source_ids: [3, 4], scene_id: f.scene.id, duration: 10 },
] })
function group(f: any, number: number) {
  const c = (id: number) => `[[character:${id}]]`, s = `[[scene:${f.scene.id}]]`
  const speaker = number === 1 ? f.a.id : f.b.id, text = number === 1 ? '回来，一起走。' : '好。'
  return { shot_number: number, title: `第${number}组`, time: '日', location: `${s}原有院落。`, shot_type: '中景', angle: '平视', movement: '固定',
    description: `【镜头1】${c(f.a.id)}站在原处，${c(f.b.id)}看向他，[[voice:v1]]：「${text}」【镜头2】${c(f.a.id)}与${c(f.b.id)}保持原位。`,
    result: `${c(f.a.id)}停在原处，结束第${number}组。`, atmosphere: '日光。', image_prompt: `${s}首镜。`,
    video_prompt: `出场人物：${c(f.a.id)}、${c(f.b.id)}；场景：${s}。无字幕、无背景音乐。\n0-3秒：${s}以门槛为原点A0，X轴向东，Y轴向北；${c(f.a.id)}站在原处，${c(f.b.id)}看向他，[[voice:v1]]：「${text}」\n3-6秒：${c(f.a.id)}站在原处，${c(f.b.id)}看向他。\n6-9秒：${c(f.a.id)}与${c(f.b.id)}保持原位。\n9-10秒：${c(f.a.id)}与${c(f.b.id)}停住。`,
    bgm_prompt: '无背景音乐', sound_effect: '环境声。', duration: 10, scene_id: f.scene.id, character_ids: [f.a.id, f.b.id], prop_ids: [],
    source_ids: number === 1 ? [1, 2] : [3, 4], time_row_counts: [2, 2],
    voice_cues: [{ id: 'v1', shot: 1, speaker_id: speaker, kind: 'dialogue', source_name: '', profile: number === 1 ? profileA : profileB,
      state: '站在原处', goal: '回应对方', volume: '适中', rate_cps: 3, breath: '平稳', tail: '轻收', emotion: '克制' }] }
}

// Group 1: its first answer and its one-field patch keep an unknown asset reference, so it is still unfinished when
// group 2 is first asked; its finishing turn (third request) is correct.
const slowFirstGroup = (f: any, calls: number) => calls <= 2 ? { ...group(f, 1), result: '[[character:999]]末态待定。' } : group(f, 1)
const sequence = (h: { requests: Array<{ stage: string; payload: any }> }) => h.requests.map(r => r.stage === 'plan' ? 'plan' : r.payload.current_group.number)

test('S2: a group that refused because the previous group was unfinished is retried once that group is ready, in the same run', async () => {
  let groupOneCalls = 0, groupTwoCalls = 0
  const h = harness((payload, stage, f) => {
    if (stage === 'plan') return plan(f)
    if (payload.current_group.number === 1) return slowFirstGroup(f, ++groupOneCalls)
    groupTwoCalls++
    if (payload.previous_group_state !== 'ready') {
      assert.equal(payload.previous_ending, null)
      return { conflict: 'previous_group_state为needs_revision且previous_ending为null，无法确定上一组末态。', field: 'previous_ending', source_ids: [3, 4] }
    }
    assert.ok(payload.previous_ending, 'the retry carries the validated previous ending')
    assert.equal(payload.previous_ending_note, undefined)
    return group(f, 2)
  })
  const result = await runSkillStoryboardWorkflow(h.start(), h.dependencies as any)
  assert.deepEqual(h.errors, [])
  assert.equal(result.status, 'done', JSON.stringify(result.issues))
  assert.equal(groupTwoCalls, 2, 'one refusal, one retry after group 1 was ready')
  assert.deepEqual(sequence(h), ['plan', 1, 1, 2, 1, 2], 'the retry comes right after group 1 passes')
})

test('S2: unrelated conflicts stay final; a ready previous boundary receives one bounded joint repair', async () => {
  // A conflict about the group's own content while group 1 is unfinished: not retried, even after group 1 passes.
  let groupOneCalls = 0, groupTwoCalls = 0
  const own = harness((payload, stage, f) => {
    if (stage === 'plan') return plan(f)
    if (payload.current_group.number === 1) return slowFirstGroup(f, ++groupOneCalls)
    groupTwoCalls++
    return { conflict: '本组原文动作缺少依据，请明确该组末态。', field: 'result', source_ids: [3, 4] }
  })
  const first = await runSkillStoryboardWorkflow(own.start(), own.dependencies as any)
  assert.equal(first.status, 'needs_revision')
  assert.equal(groupOneCalls, 3, 'group 1 itself still finished')
  assert.equal(groupTwoCalls, 1, 'no automatic retry of a real conflict')
  // A known boundary conflict now enters the explicit joint repair instead of
  // falsely claiming that the prior ready group must be correct.
  let calls = 0, boundaryCalls = 0
  const ready = harness((payload, stage, f) => {
    if (stage === 'plan') return plan(f)
    if (payload.boundary_repair) {
      boundaryCalls++
      return { conflict: '原文不足以在限定范围确定正确持物状态。', field: 'boundary_continuity', source_ids: [3, 4] }
    }
    if (payload.current_group.number === 1) return group(f, 1)
    calls++
    return { conflict: '上一组末态与本组原文矛盾，无法承接。', field: 'previous_ending', source_ids: [3, 4] }
  })
  const second = await runSkillStoryboardWorkflow(ready.start(), ready.dependencies as any)
  assert.equal(second.status, 'needs_revision')
  assert.equal(calls, 1)
  assert.equal(boundaryCalls, 1)
})

test('S1: an answer with group_number, no source_ids and character_id in its voice cue passes without a repair request', async () => {
  const h = harness((payload, stage, f) => {
    if (stage === 'plan') return plan(f)
    const value: any = group(f, payload.current_group.number)
    value.group_number = value.shot_number; delete value.shot_number; delete value.source_ids
    const { speaker_id, kind: _k, source_name: _n, ...cue } = value.voice_cues[0]
    value.voice_cues = [{ ...cue, character_id: speaker_id }]
    return value
  })
  const result = await runSkillStoryboardWorkflow(h.start(), h.dependencies as any)
  assert.deepEqual(h.errors, [])
  assert.equal(result.status, 'done', JSON.stringify(result.issues))
  assert.deepEqual(sequence(h), ['plan', 1, 2], 'no repair request at all')
})

test('S3: without an explicit override the request wait follows the output budget (6 min standard, 10 min recovery)', async () => {
  const h = harness((payload, stage, f) => stage === 'plan' ? plan(f) : group(f, payload.current_group.number), { requestTimeoutMs: undefined })
  delete (h.dependencies as any).requestTimeoutMs
  const result = await runSkillStoryboardWorkflow(h.start(), h.dependencies as any)
  assert.equal(result.status, 'done', JSON.stringify(result.issues))
  const waits = (result.result.requestStats as any[]).map(stat => [stat.maxOutputTokens, stat.requestTimeoutMs])
  for (const [budget, wait] of waits) assert.equal(wait, Math.min(600_000, Math.max(360_000, budget * 22)), JSON.stringify(waits))
  assert.ok(waits.every(([, wait]) => wait >= 360_000), 'never below 6 minutes')
})

// R1 (2026-11-08): the relay's "no account in this group" 404 is a temporary pool state, seen in 9 of 19 real clicks.
const relay404 = () => new Response(JSON.stringify({ error: { message: 'Model "gemini-4-argon" is not supported by any configured account in this group', type: 'invalid_request_error' } }),
  { status: 404, headers: { 'Content-Type': 'application/json' } })
function rawHarness(responder: (payload: any, stage: string, f: any, call: number) => unknown) {
  let call = 0
  const h = harness(() => undefined)
  h.dependencies.createAgent = (stage: string, instructions: string) => {
    const provider = createOpenAI({ apiKey: 'offline', baseURL: 'https://example.invalid/v1', fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      const message = body.messages.filter((entry: any) => entry.role === 'user').at(-1)
      const payload = JSON.parse(typeof message.content === 'string' ? message.content : message.content.map((part: any) => part.text || '').join(''))
      h.requests.push({ stage, payload })
      const value = responder(payload, stage, h.f, ++call)
      return value instanceof Response ? value : sse(JSON.stringify({ output: value }))
    } })
    return new Agent({ id: `round3-raw-${++counter}`, name: 'round3', instructions, model: provider.chat('offline'), tools: {}, maxRetries: 0 })
  }
  return h
}

test('R1: one relay "not supported by any configured account" answer is retried, and the episode still finishes', async () => {
  let refused = 0
  const h = rawHarness((payload, stage, f) => {
    if (stage === 'plan') return plan(f)
    if (payload.current_group.number === 2 && refused++ === 0) return relay404()
    return group(f, payload.current_group.number)
  })
  const result = await runSkillStoryboardWorkflow(h.start(), h.dependencies as any)
  assert.equal(result.status, 'done', JSON.stringify(result.issues))
  assert.equal(refused, 2, 'answered once with the 404, then normally')
  assert.deepEqual(sequence(h), ['plan', 1, 2, 2])
})

test('R1: the relay 404 every time still stops after three in a row; a real key error still stops at once', async () => {
  const always = rawHarness((payload, stage, f) => stage === 'plan' ? plan(f) : relay404())
  const stuck = await runSkillStoryboardWorkflow(always.start(), always.dependencies as any)
  assert.equal(stuck.status, 'needs_revision')
  // Same bound as other transient failures: three failed asks (each with its one stream retry), then the circuit opens.
  assert.deepEqual(sequence(always), ['plan', 1, 1, 2, 2, 1, 1])
  const key = rawHarness((payload, stage, f) => stage === 'plan' ? plan(f)
    : new Response(JSON.stringify({ error: { message: 'Invalid API key provided', type: 'authentication_error' } }), { status: 401, headers: { 'Content-Type': 'application/json' } }))
  const denied = await runSkillStoryboardWorkflow(key.start(), key.dependencies as any)
  assert.equal(denied.status, 'needs_revision')
  assert.deepEqual(sequence(key), ['plan', 1], 'a key error is never retried')
})
