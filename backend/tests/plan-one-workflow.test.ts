import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Agent } from '@mastra/core/agent'
import { createOpenAI } from '@ai-sdk/openai'

// Workflow regressions for the 2026-11-05 storyboard failures (方案一):
//  A  infeasible shot count → complete group repair that may redesign shots
//  E  every failing group gets an automatic finishing attempt
//  衔接 a group only inherits a VALIDATED previous ending; a repaired group sees the next group's opening
//  D  a shared original line is split at existing punctuation and each group is told its own part
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-plan-one-'))
process.env.SQLITE_PATH = path.join(directory, 'plan-one.sqlite3')
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
const { scriptTimingBudget } = await import('../src/services/skill-storyboard-contract.ts')
const store = new StoryboardDraftStore(db.$client)
const timestamps = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
const skills = { plan: 'Original narrative skill.', expand: 'Original storyboard and video-prompt skills.', prompt: 'Original video-prompt skill.' }

after(async () => {
  db.$client.close()
  assert.ok(path.basename(directory).startsWith('huobao-plan-one-'))
  await fs.rm(directory, { recursive: true, force: true })
})

type Call = { stage: 'plan' | 'expand' | 'prompt'; payload: any; execution?: any }
const sse = (content: string) => {
  const encoder = new TextEncoder(), chunk = (delta: object, finish: string | null = null) => ({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'offline', choices: [{ index: 0, delta, finish_reason: finish }] })
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ role: 'assistant', content }))}\n\n`))
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ...chunk({}, 'stop'), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`))
    controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close()
  } }), { headers: { 'Content-Type': 'text/event-stream' } })
}
let counter = 0
function harness(script: string, responder: (call: Call, f: any) => unknown) {
  const drama = db.insert(schema.dramas).values({ ownerUserId:fixtureOwner.id, title: 'plan-one', ...timestamps }).returning().get()
  const episode = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: 'E', scriptContent: script, ...timestamps }).returning().get()
  const a = db.insert(schema.characters).values({ dramaId: drama.id, name: '阿甲', ...timestamps }).returning().get()
  const b = db.insert(schema.characters).values({ dramaId: drama.id, name: '阿乙', ...timestamps }).returning().get()
  const scene = db.insert(schema.scenes).values({ dramaId: drama.id, location: '院落', time: '日', prompt: '院落', ...timestamps }).returning().get()
  const f = { drama, episode, a, b, scene }
  const calls: Call[] = []
  // Assertions inside the mock model would otherwise surface only as provider
  // errors that automatic recovery retries; collect them and fail the test.
  const responderErrors: string[] = []
  const context = () => ({ episode: { id: episode.id, title: 'E' }, script,
    characters: [{ id: a.id, name: a.name }, { id: b.id, name: b.name }], scenes: [{ id: scene.id, location: scene.location }], props: [], existing_storyboards: [] })
  const dependencies = { store, modelIdentity: { provider: 'openai', model: 'deepseek-v4.1-flash' } as unknown, batchSize: 1 as 1, modelLimits: { maxOutputTokens: 16_384 },
    recoveryDelayMs: 0, voiceContract: false, readContext: async () => context(), loadInstructions: async () => skills,
    requestTimeoutMs: 60_000,
    // Production defaults: automatic recovery and targeted (field/row) repairs are both on.
    createAgent: (stage: Call['stage'], instructions: string, _schema: Record<string, unknown>, execution?: any) => {
      const provider = createOpenAI({ apiKey: 'offline', baseURL: 'https://example.invalid/v1', fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        const message = body.messages.filter((entry: any) => entry.role === 'user').at(-1)
        const raw = typeof message.content === 'string' ? message.content : message.content.map((part: any) => part.text || '').join('')
        const call = { stage, payload: JSON.parse(raw), execution }; calls.push(call)
        if (process.env.PLAN_ONE_TRACE) console.error(`[trace] ${stage} g=${call.payload.current_group?.number ?? '-'} repair=${call.payload.directed_repair ? 'yes' : 'no'} targeted=${call.payload.targeted_repair ? call.payload.targeted_repair.fields : 'no'} prevState=${call.payload.previous_group_state ?? '-'} prevEnding=${call.payload.previous_ending ? 'yes' : 'null'} next=${call.payload.next_opening ? 'yes' : 'no'} issues=${JSON.stringify((call.payload.directed_repair?.issues || []).map((issue: any) => issue.code))}`)
        let value: any
        try { value = responder(call, f) } catch (error) { responderErrors.push(error instanceof Error ? error.message : String(error)); throw error }
        // A targeted patch request is answered with the patch shape for the fields it allows,
        // taken from the complete group the responder produced (same as the existing suite).
        const repair = call.payload.targeted_repair
        if (repair && value && typeof value === 'object' && !value.conflict && !value.base_version) {
          value = { base_version: repair.base_version, changes: Object.fromEntries(repair.allowed_changes.filter((key: string) => Object.hasOwn(value, key)).map((key: string) => [key, value[key]])) }
        }
        return sse(typeof value === 'string' ? value : JSON.stringify({ output: value }))
      } })
      return new Agent({ id: `plan-one-${++counter}`, name: 'plan-one', instructions, model: provider.chat('offline'), tools: {}, maxRetries: 0 })
    },
  }
  const start = () => {
    const session = createStoryboardSession({ mode: 'breakdown', episodeId: episode.id, dramaId: drama.id, validationProfile: 'skill-content' })
    const requestContext = buildAgentRequestContext({ episodeId: episode.id, dramaId: drama.id, language: 'zh' })
    requestContext.set('storyboardSession' as never, session as never)
    return { episodeId: episode.id, dramaId: drama.id, mode: 'breakdown' as const, session, requestContext, message: '按原skill完整生成。' }
  }
  return { f, calls, dependencies, start, responderErrors }
}
const header = (f: any) => `出场人物：[[character:${f.a.id}]]、[[character:${f.b.id}]]；场景：[[scene:${f.scene.id}]]。无字幕、无背景音乐，保留对白和必要音效；同一现实空间人物唯一，不越轴。`
/** A complete, valid group with `shots` described shots on `rows` 3 s rows (counts sum to rows). */
function group(f: any, number: number, duration: number, sources: number[], speech: Array<[string, string]>, counts: number[]) {
  const c = (id: number) => `[[character:${id}]]`, s = `[[scene:${f.scene.id}]]`
  const speaker = (name: string) => name === '阿甲' ? f.a.id : f.b.id
  const shots = counts.map((_, index) => `【镜头${index + 1}】${c(f.a.id)}站在原处，${c(f.b.id)}看向他。${index === 0
    ? speech.map(([name, text]) => `${c(speaker(name))}说：「${text}」`).join('') : '两人保持原位。'}`).join('')
  const rows = Math.ceil(duration / 3), lines: string[] = []
  for (let row = 0; row < rows; row++) {
    const start = row * 3, end = Math.min(start + 3, duration)
    const said = row === 0 ? speech.map(([name, text]) => `${c(speaker(name))}说：「${text}」`).join('') : ''
    lines.push(`${start}-${end}秒：${row === 0 ? `${s}以门槛为原点A0，X轴向东，Y轴向北；` : ''}${c(f.a.id)}站在原处，${c(f.b.id)}看向他。${said}`)
  }
  return { shot_number: number, title: `第${number}组`, time: '日', location: `${s}原有院落。`, shot_type: '中景', angle: '平视', movement: '固定',
    description: shots, result: `${c(f.a.id)}停在原处，${c(f.b.id)}看着他，结束第${number}组。`, atmosphere: '日光。',
    image_prompt: `${s}首镜。`, video_prompt: `${header(f)}\n${lines.join('\n')}`, bgm_prompt: '无背景音乐', sound_effect: '环境声。',
    duration, scene_id: f.scene.id, character_ids: [f.a.id, f.b.id], prop_ids: [], source_ids: sources, time_row_counts: counts }
}
const padding = (n: number) => `动作：${'院中晨光照进来，衣袖随着脚步自然轻摆。'.repeat(n)}`

test('A: four shots in a ten-second group escalate to a complete repair that may redesign the shots, and the group then passes', async () => {
  // Keep a legal two-group budget so this test reaches the shot-layout repair.
  const script = `${padding(5)}\n阿甲：回来。\n${padding(5)}\n阿乙：好。`
  const budget = scriptTimingBudget(script)
  const total = 20
  assert.ok(budget.minimumSeconds <= total && budget.maximumSeconds >= total, JSON.stringify(budget))
  let firstOfGroupOne = true
  const h = harness(script, (call, f) => {
    if (call.stage === 'plan') return { groups: [
      { number: 1, title: '一', beat: 'narrative', source_ids: [1, 2], scene_id: f.scene.id, duration: 10 },
      { number: 2, title: '二', beat: 'narrative', source_ids: [3, 4], scene_id: f.scene.id, duration: 10 },
    ] }
    const number = call.payload.current_group.number
    if (number === 2) return group(f, 2, 10, [3, 4], [['阿乙', '好。']], [2, 2])
    if (firstOfGroupOne) { firstOfGroupOne = false; return group(f, 1, 10, [1, 2], [['阿甲', '回来。']], [1, 1, 1, 1]) }
    // Second request for group 1 must be a complete repair, not a counts-only patch.
    assert.equal(Object.hasOwn(call.payload, 'targeted_repair'), false, 'no counts-only patch for an infeasible shot count')
    assert.ok(call.payload.directed_repair, 'a complete repair request')
    assert.match(call.payload.directed_repair.instruction, /2—4个子镜头|子镜头数/)
    return group(f, 1, 10, [1, 2], [['阿甲', '回来。']], [2, 2])
  })
  const result = await runSkillStoryboardWorkflow(h.start(), h.dependencies as any)
  assert.deepEqual(h.responderErrors, [], 'no assertion inside the mock model failed')
  assert.equal(result.status, 'done', JSON.stringify(result.issues))
  assert.deepEqual(h.calls.map(call => call.stage === 'plan' ? 'plan' : call.payload.current_group.number), ['plan', 1, 1, 2])
})

test('衔接: a group never inherits the ending of a previous group that failed validation, and is told the ending is not final', async () => {
  const script = `${padding(5)}\n阿甲：回来。\n${padding(5)}\n阿乙：好。`
  let groupOneAttempts = 0
  const h = harness(script, (call, f) => {
    if (call.stage === 'plan') return { groups: [
      { number: 1, title: '一', beat: 'narrative', source_ids: [1, 2], scene_id: f.scene.id, duration: 10 },
      { number: 2, title: '二', beat: 'narrative', source_ids: [3, 4], scene_id: f.scene.id, duration: 10 },
    ] }
    const number = call.payload.current_group.number
    if (number === 1) {
      groupOneAttempts++
      // First two attempts keep an unresolvable reference (fails validation, still compiles a preview).
      return groupOneAttempts <= 2 ? { ...group(f, 1, 10, [1, 2], [['阿甲', '回来。']], [2, 2]), result: '[[character:999]]末态待定。' }
        : group(f, 1, 10, [1, 2], [['阿甲', '回来。']], [2, 2])
    }
    if (!call.payload.directed_repair) {
      // Group 2 first pass happens while group 1 is still failing.
      assert.equal(call.payload.previous_ending, null, 'a failing previous group must not hand over its unvalidated ending')
      assert.equal(call.payload.previous_group_state, 'needs_revision')
      assert.match(String(call.payload.previous_ending_note || ''), /原文/)
    }
    return group(f, 2, 10, [3, 4], [['阿乙', '好。']], [2, 2])
  })
  const result = await runSkillStoryboardWorkflow(h.start(), h.dependencies as any)
  assert.deepEqual(h.responderErrors, [], 'no assertion inside the mock model failed')
  assert.equal(result.status, 'done', JSON.stringify(result.issues))
})

test('衔接: repairing a group after the following group is ready sends that group\'s opening so both ends connect', async () => {
  const script = `${padding(5)}\n阿甲：回来。\n${padding(5)}\n阿乙：好。`
  let groupOneAttempts = 0
  const h = harness(script, (call, f) => {
    if (call.stage === 'plan') return { groups: [
      { number: 1, title: '一', beat: 'narrative', source_ids: [1, 2], scene_id: f.scene.id, duration: 10 },
      { number: 2, title: '二', beat: 'narrative', source_ids: [3, 4], scene_id: f.scene.id, duration: 10 },
    ] }
    const number = call.payload.current_group.number
    if (number === 2) return group(f, 2, 10, [3, 4], [['阿乙', '好。']], [2, 2])
    groupOneAttempts++
    if (groupOneAttempts <= 2) return { ...group(f, 1, 10, [1, 2], [['阿甲', '回来。']], [2, 2]), result: '[[character:999]]末态待定。' }
    // Finishing repair after group 2 became ready: it must see group 2's opening.
    assert.ok(call.payload.next_opening, 'the following ready group opening is provided')
    assert.equal(call.payload.next_opening.shot_number, 2)
    assert.match(call.payload.next_opening.description_first_shot, /【镜头1】/)
    return group(f, 1, 10, [1, 2], [['阿甲', '回来。']], [2, 2])
  })
  const result = await runSkillStoryboardWorkflow(h.start(), h.dependencies as any)
  assert.deepEqual(h.responderErrors, [], 'no assertion inside the mock model failed')
  assert.equal(result.status, 'done', JSON.stringify(result.issues))
})

test('E: when two groups fail, automatic finishing reaches both instead of spending every pass on the first', async () => {
  // Real 第1集 shape: group 1 keeps failing in finishing and would use every pass;
  // group 3's only problem (a missing second half, found by the whole-episode review)
  // must still receive its own finishing request.
  const script = `${padding(5)}\n阿甲：回来。\n${padding(5)}\n阿乙：好。\n${padding(5)}\n阿甲：走吧。快点。`
  const total = 30
  const budget = scriptTimingBudget(script)
  assert.ok(budget.minimumSeconds <= total && budget.maximumSeconds >= total, JSON.stringify(budget))
  const attempts = new Map<number, number>()
  const h = harness(script, (call, f) => {
    if (call.stage === 'plan') return { groups: [
      { number: 1, title: '一', beat: 'narrative', source_ids: [1, 2], scene_id: f.scene.id, duration: 10 },
      { number: 2, title: '二', beat: 'narrative', source_ids: [3, 4], scene_id: f.scene.id, duration: 10 },
      { number: 3, title: '三', beat: 'narrative', source_ids: [5, 6], scene_id: f.scene.id, duration: 10 },
    ] }
    const number = call.payload.current_group.number
    attempts.set(number, (attempts.get(number) || 0) + 1)
    if (number === 1) return { ...group(f, 1, 10, [1, 2], [['阿甲', '回来。']], [2, 2]), result: '[[character:999]]末态仍待定。' }
    if (number === 2) return group(f, 2, 10, [3, 4], [['阿乙', '好。']], [2, 2])
    // Group 3 first omits 「快点。」; it passes its own checks and is only caught by the episode review.
    return attempts.get(3) === 1 ? group(f, 3, 10, [5, 6], [['阿甲', '走吧。']], [2, 2]) : group(f, 3, 10, [5, 6], [['阿甲', '走吧。快点。']], [2, 2])
  })
  const result = await runSkillStoryboardWorkflow(h.start(), h.dependencies as any)
  assert.deepEqual(h.responderErrors, [], 'no assertion inside the mock model failed')
  assert.equal(result.status, 'needs_revision', 'group 1 can never pass in this fixture')
  assert.ok((attempts.get(3) || 0) >= 2, `group 3 received a finishing request (attempts=${JSON.stringify([...attempts])})`)
  const draft = store.get(result.draft_id!)!
  assert.equal(draft.groups.find(entry => entry.number === 3)!.status, 'ready', 'group 3 was repaired even though group 1 stayed broken')
})

// Line 2 (33 spoken characters) is shared by groups 1 and 2 (10 s each, capacity 36).
// Group 1 also speaks line 1 (12) and group 2 also speaks line 3 (19): the whole
// line fits in neither group (45 / 52), so it must be split after 「。」 (18 + 15).
const sharedLine = '我今天一定要把这件事情从头到尾讲清楚。你别急着走，坐下来听我说完再决定。'
const sharedHead = '我今天一定要把这件事情从头到尾讲清楚。', sharedTail = '你别急着走，坐下来听我说完再决定。'
const sharedOpening = '你今天想说什么就直接讲吧。', sharedClosing = '好吧那我先坐下来慢慢听你把话讲完别着急。'
const sharedScript = () => `阿乙：${sharedOpening}\n阿甲：${sharedLine}\n阿乙：${sharedClosing}\n${padding(7)}`
const sharedPlan = (f: any) => ({ groups: [
  { number: 1, title: '一', beat: 'narrative', source_ids: [1, 2], scene_id: f.scene.id, duration: 10 },
  { number: 2, title: '二', beat: 'narrative', source_ids: [2, 3, 4], scene_id: f.scene.id, duration: 10 },
] })

test('D: a line shared by two groups is split at existing punctuation and each group is told only its own words', async () => {
  const script = sharedScript()
  const budget = scriptTimingBudget(script)
  assert.ok(budget.minimumSeconds <= 20 && budget.maximumSeconds >= 20, JSON.stringify(budget))
  const h = harness(script, (call, f) => {
    if (call.stage === 'plan') return sharedPlan(f)
    const number = call.payload.current_group.number
    const assignment = call.payload.current_group.speech_assignment
    assert.ok(assignment && Array.isArray(assignment.lines), 'the group is told which original words it speaks')
    const line = assignment.lines.find((entry: any) => entry.source_id === 2)
    assert.equal(line.this_group_speaks.map((piece: any) => piece.text).join(''), number === 1 ? sharedHead : sharedTail)
    assert.equal(line.other_groups.map((piece: any) => piece.text).join(''), number === 1 ? sharedTail : sharedHead, 'and which words the neighbouring group says')
    return number === 1 ? group(f, 1, 10, [1, 2], [['阿乙', sharedOpening], ['阿甲', sharedHead]], [2, 2])
      : group(f, 2, 10, [2, 3, 4], [['阿甲', sharedTail], ['阿乙', sharedClosing]], [2, 2])
  })
  const result = await runSkillStoryboardWorkflow(h.start(), h.dependencies as any)
  assert.deepEqual(h.responderErrors, [], 'no assertion inside the mock model failed')
  assert.equal(result.status, 'done', JSON.stringify(result.issues))
})

test('D: a group that speaks the whole shared line instead of its assigned part is rejected and repaired', async () => {
  let firstAttempt = true
  const h = harness(sharedScript(), (call, f) => {
    if (call.stage === 'plan') return sharedPlan(f)
    const number = call.payload.current_group.number
    if (number === 2) return group(f, 2, 10, [2, 3, 4], [['阿甲', sharedTail], ['阿乙', sharedClosing]], [2, 2])
    if (firstAttempt) { firstAttempt = false; return group(f, 1, 10, [1, 2], [['阿乙', sharedOpening], ['阿甲', sharedLine]], [2, 2]) }
    assert.ok(call.payload.directed_repair.issues.some((issue: any) => issue.code === 'speech_assignment'), 'the repair names the assignment error')
    return group(f, 1, 10, [1, 2], [['阿乙', sharedOpening], ['阿甲', sharedHead]], [2, 2])
  })
  const result = await runSkillStoryboardWorkflow(h.start(), h.dependencies as any)
  assert.deepEqual(h.responderErrors, [], 'no assertion inside the mock model failed')
  assert.equal(result.status, 'done', JSON.stringify(result.issues))
})

test('D (resume, real 第4集 shape): a finished group that contradicts the split is sent back with the words it is missing', async () => {
  // A draft made before split points existed: group 2 finished while it still
  // assumed group 1 says the whole shared line, and group 1 reported a duration
  // conflict. On resume group 2 must say the tail, so it cannot stay finished.
  let phase: 'old' | 'new' = 'old', groupTwoRequests = 0
  const h = harness(sharedScript(), (call, f) => {
    if (phase === 'old') {
      if (call.stage === 'plan') return sharedPlan(f)
      return call.payload.current_group.number === 1
        ? { conflict: '本组10秒装不下两句对白共45字。', field: 'duration', source_ids: [1, 2] }
        : group(f, 2, 10, [2, 3, 4], [['阿乙', sharedClosing]], [2, 2])
    }
    assert.notEqual(call.stage, 'plan', 'the saved plan is valid and is kept')
    const number = call.payload.current_group.number
    if (number === 2) {
      groupTwoRequests++
      assert.ok(call.payload.directed_repair?.issues.some((issue: any) => issue.code === 'speech_assignment' && issue.message.includes(sharedTail)), 'group 2 is told the words it is missing')
    }
    return number === 1 ? group(f, 1, 10, [1, 2], [['阿乙', sharedOpening], ['阿甲', sharedHead]], [2, 2])
      : group(f, 2, 10, [2, 3, 4], [['阿甲', sharedTail], ['阿乙', sharedClosing]], [2, 2])
  })
  const old = await runSkillStoryboardWorkflow(h.start(), { ...h.dependencies, automaticRecovery: false } as any)
  assert.equal(old.status, 'needs_revision')
  // Recreate exactly what the old program stored: group 2 finished without the tail.
  const two = store.get(old.draft_id!)!.groups.find(entry => entry.number === 2)!
  assert.ok((two.candidate as any)?.data, 'group 2 has a complete storyboard')
  store.saveGroup(old.draft_id!, { ...two, status: 'ready', issues: [] })
  assert.deepEqual(store.get(old.draft_id!)!.groups.map(entry => entry.status), ['needs_revision', 'ready'])
  phase = 'new'
  const result = await runSkillStoryboardWorkflow(h.start(), h.dependencies as any)
  assert.deepEqual(h.responderErrors, [], 'no assertion inside the mock model failed')
  assert.equal(result.draft_id, old.draft_id, 'the same draft was resumed, not restarted')
  assert.equal(result.status, 'done', JSON.stringify(result.issues))
  assert.ok(groupTwoRequests >= 1)
})

test('D fallback: a duration conflict regroups once; unchanged finished groups are kept and only changed groups are generated', async () => {
  // Group 2 (10 s) reports it cannot hold its lines; the new plan splits it and keeps groups 1 and 3.
  const lineThree = '我已经在这里等了你整整一个下午了你知道吗。', lineFour = '我知道我回来晚了这件事情是我不对。'
  // Both three- and four-group plans must fit the same skill count budget.
  // The retained outer groups use 12 s so each total also fits that budget.
  const script = `${padding(9)}\n阿甲：回来。\n阿乙：${lineThree}\n阿甲：${lineFour}\n${padding(9)}\n阿乙：好。`
  const budget = scriptTimingBudget(script)
  assert.ok(budget.minimumSeconds <= 34 && budget.maximumSeconds >= 44, JSON.stringify(budget))
  const before = (f: any) => ({ groups: [
    { number: 1, title: '一', beat: 'narrative', source_ids: [1, 2], scene_id: f.scene.id, duration: 12 },
    { number: 2, title: '二', beat: 'narrative', source_ids: [3, 4], scene_id: f.scene.id, duration: 10 },
    { number: 3, title: '三', beat: 'narrative', source_ids: [5, 6], scene_id: f.scene.id, duration: 12 },
  ] })
  const after = (f: any) => ({ groups: [
    { number: 1, title: '一', beat: 'narrative', source_ids: [1, 2], scene_id: f.scene.id, duration: 12 },
    { number: 2, title: '二上', beat: 'narrative', source_ids: [3], scene_id: f.scene.id, duration: 10 },
    { number: 3, title: '二下', beat: 'narrative', source_ids: [4], scene_id: f.scene.id, duration: 10 },
    { number: 4, title: '三', beat: 'narrative', source_ids: [5, 6], scene_id: f.scene.id, duration: 12 },
  ] })
  let plans = 0
  const generated: number[] = []
  const h = harness(script, (call, f) => {
    if (call.stage === 'plan') {
      plans++
      if (plans === 1) return before(f)
      assert.ok(call.payload.directed_repair.issues.some((issue: any) => issue.code === 'model_constraint_conflict' && issue.field === 'duration'), 'the regroup request carries the conflict')
      return after(f)
    }
    const number = call.payload.current_group.number
    generated.push(plans === 1 ? number : 100 + number)
    if (plans === 1) {
      if (number === 1) return group(f, 1, 12, [1, 2], [['阿甲', '回来。']], [2, 2])
      if (number === 2) return { conflict: '本组10秒装不下两句对白。', field: 'duration', source_ids: [3, 4] }
      return group(f, 3, 12, [5, 6], [['阿乙', '好。']], [2, 2])
    }
    if (number === 2) return group(f, 2, 10, [3], [['阿乙', lineThree]], [2, 2])
    if (number === 3) return group(f, 3, 10, [4], [['阿甲', lineFour]], [2, 2])
    throw new Error(`group ${number} was finished and unchanged; it must not be generated again`)
  })
  const result = await runSkillStoryboardWorkflow(h.start(), h.dependencies as any)
  assert.deepEqual(h.responderErrors, [], 'no assertion inside the mock model failed')
  assert.equal(result.status, 'done', JSON.stringify(result.issues))
  assert.equal(plans, 2, 'exactly one regroup')
  assert.deepEqual(generated, [1, 2, 3, 102, 103], 'only the two changed groups were generated after regrouping')
  const draft = store.get(result.draft_id!)!
  assert.deepEqual(draft.groups.map(entry => entry.number), [1, 2, 3, 4])
  assert.equal((draft.groups[3].candidate as any).data.shot_number, 4, 'the kept last group was renumbered without regeneration')
})
