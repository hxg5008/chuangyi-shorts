import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Agent } from '@mastra/core/agent'
import { createOpenAI } from '@ai-sdk/openai'

// Round 2, layer 1 (2026-11-06): format-only slips seen in the real test project must not cost repair
// requests, and a group that still has a real problem must learn every problem in one request.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-format-'))
process.env.SQLITE_PATH = path.join(directory, 'format.sqlite3')
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
// Keep the two-group budget valid without counting speaker/action labels.
const script = `${padding(5)}\n阿甲：回来，一起走。\n${padding(5)}\n阿乙：好。`
const profileA = { age: '三十岁成年男声', register: '中低音区', timbre: '低沉略带沙哑' }
const profileB = { age: '二十岁成年女声', register: '中高音区', timbre: '清亮稍带紧涩' }

function harness(responder: (payload: any, stage: string, f: any, calls: number) => unknown) {
  const drama = db.insert(schema.dramas).values({ ownerUserId:fixtureOwner.id, title: 'format', ...timestamps }).returning().get()
  const episode = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: 'E', scriptContent: script, ...timestamps }).returning().get()
  const a = db.insert(schema.characters).values({ dramaId: drama.id, name: '阿甲', ...timestamps }).returning().get()
  const b = db.insert(schema.characters).values({ dramaId: drama.id, name: '阿乙', ...timestamps }).returning().get()
  const scene = db.insert(schema.scenes).values({ dramaId: drama.id, location: '院落', time: '日', prompt: '院落', ...timestamps }).returning().get()
  const f = { drama, episode, a, b, scene }
  const requests: Array<{ stage: string; payload: any }> = []
  const errors: string[] = []
  const dependencies = { store, modelIdentity: { provider: 'openai', model: 'deepseek-v4.1-flash' }, batchSize: 1, modelLimits: { maxOutputTokens: 16_384 },
    recoveryDelayMs: 0, requestTimeoutMs: 60_000,
    readContext: async () => ({ episode: { id: episode.id, title: 'E' }, script, characters: [{ id: a.id, name: a.name }, { id: b.id, name: b.name }], scenes: [{ id: scene.id, location: scene.location }], props: [], existing_storyboards: [] }),
    loadInstructions: async () => ({ plan: 'P', expand: 'E', prompt: 'V' }),
    createAgent: (stage: string, instructions: string) => {
      const provider = createOpenAI({ apiKey: 'offline', baseURL: 'https://example.invalid/v1', fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        const message = body.messages.filter((entry: any) => entry.role === 'user').at(-1)
        const payload = JSON.parse(typeof message.content === 'string' ? message.content : message.content.map((part: any) => part.text || '').join(''))
        requests.push({ stage, payload })
        let value: any
        try { value = responder(payload, stage, f, requests.filter(r => r.payload.current_group?.number === payload.current_group?.number).length) }
        catch (error) { errors.push(error instanceof Error ? error.message : String(error)); throw error }
        const repair = payload.targeted_repair
        if (repair && value && !value.conflict) {
          const changes: Record<string, unknown> = {}
          for (const key of repair.allowed_changes) {
            if (key === 'video_prompt_rows') {
              const lines = String(value.video_prompt).split('\n').filter((line: string) => /^\s*\d+\s*-\s*\d+秒[:：]/u.test(line))
              changes[key] = Object.fromEntries((repair.target_rows || []).map((row: any) => [String(row.row), lines[row.row - 1]]))
            } else if (key === 'video_prompt_header') changes[key] = String(value.video_prompt).split('\n')[0]
            else if (Object.hasOwn(value, key)) changes[key] = value[key]
          }
          value = { base_version: repair.base_version, changes }
        }
        return sse(JSON.stringify({ output: value }))
      } })
      return new Agent({ id: `format-${++counter}`, name: 'format', instructions, model: provider.chat('offline'), tools: {}, maxRetries: 0 })
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
function group(f: any, number: number, options: { profile?: any; rowOneSpace?: boolean } = {}) {
  const c = (id: number) => `[[character:${id}]]`, s = `[[scene:${f.scene.id}]]`
  const speaker = number === 1 ? f.a.id : f.b.id, text = number === 1 ? '回来，一起走。' : '好。'
  const space = options.rowOneSpace === false ? '' : `${s}以门槛为原点A0，X轴向东，Y轴向北；`
  return { shot_number: number, title: `第${number}组`, time: '日', location: `${s}原有院落。`, shot_type: '中景', angle: '平视', movement: '固定',
    description: `【镜头1】${c(f.a.id)}站在原处，${c(f.b.id)}看向他，[[voice:v1]]：「${text}」【镜头2】${c(f.a.id)}与${c(f.b.id)}保持原位。`,
    result: `${c(f.a.id)}停在原处，结束第${number}组。`, atmosphere: '日光。', image_prompt: `${s}首镜。`,
    video_prompt: `出场人物：${c(f.a.id)}、${c(f.b.id)}；场景：${s}。无字幕、无背景音乐。\n0-3秒：${space}${c(f.a.id)}站在原处，${c(f.b.id)}看向他，[[voice:v1]]：「${text}」\n3-6秒：${c(f.a.id)}站在原处，${c(f.b.id)}看向他。\n6-9秒：${c(f.a.id)}与${c(f.b.id)}保持原位。\n9-10秒：${c(f.a.id)}与${c(f.b.id)}停住。`,
    bgm_prompt: '无背景音乐', sound_effect: '环境声。', duration: 10, scene_id: f.scene.id, character_ids: [f.a.id, f.b.id], prop_ids: [],
    source_ids: number === 1 ? [1, 2] : [3, 4], time_row_counts: [2, 2],
    voice_cues: [{ id: 'v1', shot: 1, speaker_id: speaker, kind: 'dialogue', source_name: '', profile: options.profile || (number === 1 ? profileA : profileB),
      state: '站在原处', goal: '回应对方', volume: '适中', rate_cps: 3, breath: '平稳', tail: '轻收', emotion: '克制' }] }
}

test('real slips (literal \\n line breaks, description without voice anchors, a doubled speaker label) pass without any repair request', async () => {
  const h = harness((payload, stage, f) => {
    if (stage === 'plan') return plan(f)
    const number = payload.current_group.number
    const value = group(f, number)
    if (number === 1) {
      // 第2集 g1 shape: description written as 「X说：「…」」 without anchors; plus a same-speaker label in the video.
      value.description = value.description.replace('[[voice:v1]]：', '阿甲说：')
      value.video_prompt = value.video_prompt.replace('看向他，[[voice:v1]]', `看向他，[[character:${f.a.id}]]说：[[voice:v1]]`)
    } else {
      // 第2集 g4 shape: every line break written as the two characters \ n.
      value.video_prompt = value.video_prompt.replaceAll('\n', '\\n')
    }
    return value
  })
  const result = await runSkillStoryboardWorkflow(h.start(), h.dependencies as any)
  assert.deepEqual(h.errors, [])
  assert.equal(result.status, 'done', JSON.stringify(result.issues))
  assert.deepEqual(h.requests.map(r => r.stage === 'plan' ? 'plan' : r.payload.current_group.number), ['plan', 1, 2], 'no repair request at all')
  const rows = db.select().from(schema.storyboards).all().filter((row: any) => row.episodeId === h.f.episode.id)
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.equal(/阿甲说[：:]\s*@?阿甲说/u.test(row.videoPrompt || '') || /阿甲说[：:]\s*@?阿甲说/u.test(row.description || ''), false, 'no doubled label')
    assert.ok((row.videoPrompt || '').split('\n').length >= 5, 'real line breaks')
  }
  const draft = store.get(result.draft_id!)!
  assert.ok((draft.groups[0].candidate as any).model_raw, 'the model\'s own output is kept for traceability')
})

test('real 第5集 g1 shape: a missing A0 in row 1 gets one small fix (no full rewrite) and the group passes', async () => {
  let groupOneCalls = 0
  const scopes: string[] = []
  const h = harness((payload, stage, f) => {
    if (stage === 'plan') return plan(f)
    const number = payload.current_group.number
    if (number === 2) return group(f, 2)
    groupOneCalls++
    if (groupOneCalls === 1) return group(f, 1, { rowOneSpace: false })
    scopes.push(payload.targeted_repair ? `rows:${JSON.stringify(payload.targeted_repair.target_rows?.map((r: any) => r.row))}` : 'full')
    const codes = (payload.directed_repair?.issues || []).map((issue: any) => issue.code)
    assert.ok(codes.includes('space_basis_missing'), `the repair names the missing A0: ${codes.join(',')}`)
    return group(f, 1)
  })
  const result = await runSkillStoryboardWorkflow(h.start(), h.dependencies as any)
  assert.deepEqual(h.errors, [])
  assert.equal(result.status, 'done', JSON.stringify(result.issues))
  assert.deepEqual(scopes, ['rows:[1]'], 'only time row 1 was patched')
})

test('a hidden content problem behind a voice-compile error is reported together with it', async () => {
  let groupTwoCalls = 0
  const h = harness((payload, stage, f) => {
    if (stage === 'plan') return plan(f)
    const number = payload.current_group.number
    if (number === 1) return group(f, 1)
    groupTwoCalls++
    if (groupTwoCalls === 1) {
      // Voice anchor pointing to a cue that does not exist (cannot be normalised) AND no A0 in row 1.
      const value = group(f, 2, { rowOneSpace: false })
      value.description = value.description.replace('[[voice:v1]]', '[[voice:v9]]')
      value.video_prompt = value.video_prompt.replace('[[voice:v1]]', '[[voice:v9]]')
      return value
    }
    const codes = (payload.directed_repair?.issues || []).map((issue: any) => issue.code)
    assert.ok(codes.some((code: string) => code.startsWith('voice_cue')), `voice problem reported: ${codes.join(',')}`)
    assert.ok(codes.includes('space_basis_missing'), `hidden A0 problem reported in the same request: ${codes.join(',')}`)
    return group(f, 2)
  })
  const result = await runSkillStoryboardWorkflow(h.start(), h.dependencies as any)
  assert.deepEqual(h.errors, [])
  assert.equal(result.status, 'done', JSON.stringify(result.issues))
  assert.equal(groupTwoCalls, 2)
})
