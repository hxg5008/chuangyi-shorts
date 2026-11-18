import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

// Every write in this file is confined to this disposable SQLite database.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-storyboard-session-'))
process.env.SQLITE_PATH = path.join(directory, 'session.sqlite3')
process.env.HUOBAO_DATA_DIR = directory
process.env.STORAGE_PATH = path.join(directory, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.ts')
const fixtureOwner=await (await import('./helpers/platform-fixture.ts')).platformFixtureOwner()
const { createStoryboardSession } = await import('../src/services/storyboard-session.ts')
const { storyboardTools } = await import('../src/agents/tools/storyboard-tools.ts')
const { buildAgentRequestContext } = await import('../src/agents/context.ts')
const timestamps = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }

after(async () => {
  ;(db as any).$client.close()
  await fs.rm(directory, { recursive: true, force: true })
})

function fixture(script = '动作：阿甲走过小道。\n表演：抬眼后起身。') {
  const drama = db.insert(schema.dramas).values({ ownerUserId:fixtureOwner.id, title: 'Disposable validation test', ...timestamps }).returning().get()
  const episode = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: 'Test', scriptContent: script, duration: 7, ...timestamps }).returning().get()
  const character = db.insert(schema.characters).values({ dramaId: drama.id, name: '阿甲', ...timestamps }).returning().get()
  const scene = db.insert(schema.scenes).values({ dramaId: drama.id, location: '院落', time: '日', prompt: 'test courtyard', ...timestamps }).returning().get()
  const prop = db.insert(schema.props).values({ dramaId: drama.id, name: '木杯', ...timestamps }).returning().get()
  const old = db.insert(schema.storyboards).values({ episodeId: episode.id, storyboardNumber: 1, title: 'Old draft',
    description: 'Old description', videoPrompt: 'Old prompt', duration: 12, sceneId: scene.id, ...timestamps }).returning().get()
  db.insert(schema.storyboardCharacters).values({ storyboardId: old.id, characterId: character.id }).run()
  db.insert(schema.storyboardProps).values({ storyboardId: old.id, propId: prop.id }).run()
  const candidate = (shot_number = 1) => ({
    shot_number, title: 'Validated candidate', duration: 9, scene_id: scene.id, character_ids: [character.id], prop_ids: [],
    description: '【镜头1】阿甲正面中景，站在院内抬眼。【镜头2】阿甲正面近景，点头后放下手。',
    video_prompt: [
      '出场人物：@阿甲；场景：@院落。无字幕、无背景音乐，保留对白和必要音效；同一现实空间每名人物唯一，不出现克隆人或复制人；不越轴，动作流畅，五官与眼神清晰。',
      '0-3秒：@院落以门槛为固定原点A0，X轴向东为正，Y轴向北为正。@阿甲站在A(X+1米，Y+1米)，正面中景，神情平静（情绪60%），抬眼望向院门，固定镜头保持3秒。',
      '3-6秒：切到@阿甲正面近景，神情笃定（情绪70%），轻眨后点头，左手随呼吸松开。',
      '6-9秒：@阿甲延续点头末态，左手放下，面向院门准备迈步，日光方向保持。',
    ].join('\n'),
  })
  const session = (mode: 'breakdown' | 'prompt' = 'breakdown', extra: Record<string, any> = {}) => createStoryboardSession({
    mode, episodeId: episode.id, dramaId: drama.id, ...(mode === 'prompt' ? { storyboardIds: [old.id] } : {}), ...extra,
  })
  const rows = () => db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episode.id)).all()
  const snapshot = () => ({ rows: rows(), links: db.select().from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, old.id)).all(),
    props: db.select().from(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, old.id)).all(),
    episode: db.select().from(schema.episodes).where(eq(schema.episodes.id, episode.id)).get() })
  const context = (value?: ReturnType<typeof createStoryboardSession>) => {
    const requestContext = buildAgentRequestContext({ dramaId: drama.id, episodeId: episode.id })
    if (value) requestContext.set('storyboardSession' as never, value as never)
    return { requestContext }
  }
  return { drama, episode, character, scene, prop, old, candidate, session, rows, snapshot, context }
}

function firstPassPlan(characterId: number) {
  return {
    space: '@院落以门槛为原点A0，X轴向东，Y轴向北，摄影机在南侧朝北，@阿甲站在A(X+1米，Y+1米)，面向院门，双手空持，晨光自东侧照入。',
    shots: [
      { shot_number: 1, characters: [{ character_id: characterId, visibility: 'face_visible' as const, emotion: { expression: '平静', intensity: 60 } }], rows: [{ visual: '@阿甲正面中景，35mm平视固定拍摄3秒，抬眼看院门后自然轻眨，右手随呼吸放松，保持原坐标与朝向。' }] },
      { shot_number: 2, characters: [{ character_id: characterId, visibility: 'face_visible' as const, emotion: { expression: '笃定', intensity: 70 } }], rows: [{ visual: '@阿甲正面近景，50mm固定拍摄3秒，点头回应院内既有动静，左手慢慢放下。' }, { visual: '@阿甲仍站在A(X+1米，Y+1米)，神情延续，轻眨后准备迈步，双手空持，镜头继续固定3秒，晨光方向不变。' }] },
    ],
  }
}

function sourcePlan(characterId: number, refs: Array<[number, number]> = [[1, 1]]): any {
  const value: any = firstPassPlan(characterId)
  const rows = value.shots.flatMap((shot: any) => shot.rows)
  refs.forEach(([source_line, fragment_index], index) => {
    rows[index].dialogue = [{ source_line, fragment_index, voice: { age: '中年', register: '低音区', timbre: '温润音色' },
      voice_reference: null, spoken_seconds: null }]
  })
  return value
}

test('source fragments supply exact dialogue and derive description from the same resolved visual plan', async () => {
  const text = '这里的东西一直都在原来的位置，我从来没有搬动。'
  const f = fixture(`阿甲：（低声）${text}`), before = f.snapshot(), session = f.session()
  const staged = session.stageSave([{ ...f.candidate(), description: '模型抄错的原词里里里',
    video_prompt: undefined, video_prompt_plan: sourcePlan(f.character.id, [[1, 1], [1, 2]]) }], { replaceExisting: true, isFinalBatch: true })
  assert.equal('error' in staged, false)
  const candidate = session.getReport().candidates[0]
  assert.ok(candidate.description?.includes('【镜头1】') && candidate.description.includes('【镜头2】'))
  assert.ok(candidate.description?.includes('情绪60%') && candidate.description.includes('情绪70%'))
  assert.ok(!candidate.description?.includes('模型抄错'))
  assert.ok(!candidate.description?.includes('温润音色'), 'derived descriptions do not duplicate voice production metadata')
  const { extractStoryboardDialogue } = await import('../src/services/storyboard-validation.ts')
  assert.equal(extractStoryboardDialogue(candidate.description!).join(''), text)
  assert.deepEqual(f.snapshot(), before)
  const result = await session.finish()
  assert.equal(result.issues.some(issue => issue.severity === 'error'), false)
  assert.equal(result.saved, 1)
  assert.equal(extractStoryboardDialogue(f.rows()[0].description!).join(''), text)
  assert.ok(!f.rows()[0].videoPrompt?.includes('source_line'))
})

test('legacy text plans with an empty description derive it without changing the original words', async () => {
  const f = fixture('阿甲：你好。'), session = f.session(), value: any = firstPassPlan(f.character.id)
  value.shots[0].rows[0].dialogue = [{ speaker_id: f.character.id, kind: 'dialogue', text: '你好。',
    voice: { age: '中年', register: '低音区', timbre: '温润音色' } }]
  session.stageSave([{ ...f.candidate(), description: '', video_prompt: undefined, video_prompt_plan: value }], { replaceExisting: true, isFinalBatch: true })
  assert.equal((await session.finish()).saved, 1)
  assert.ok(f.rows()[0].description?.includes('阿甲说：「你好。」'))
})

test('a trusted source dialogue can cover a reaction shot without putting its speaker in the camera frame', async () => {
  const text = '你看这张照片。'
  const f = fixture(`老年张晓茹：（压低声音）${text}`)
  const speaker = db.insert(schema.characters).values({ dramaId: f.drama.id, name: '老年张晓茹', ...timestamps }).returning().get()
  const session = f.session(), value = sourcePlan(f.character.id)
  value.shots[0].rows[0].visual = '@阿甲正面近景，固定镜头保持3秒，伸手轻碰原有照片，指尖停住，晨光方向不变。'
  const staged = session.stageSave([{ ...f.candidate(), character_ids: [f.character.id, speaker.id], video_prompt: undefined,
    video_prompt_plan: value }], { replaceExisting: true, isFinalBatch: true })
  assert.equal('error' in staged, false)
  const candidate = session.getReport().candidates[0]
  assert.ok(candidate.description?.includes(`画外音（同场对白）：老年张晓茹说：「${text}」`))
  assert.ok(candidate.video_prompt?.includes(`画外音（同场对白）：@老年张晓茹说：「${text}」`))
  assert.ok(!candidate.video_prompt?.split('\n')[0].includes('@老年张晓茹'), 'off-camera dialogue does not create an on-camera header participant')
  assert.ok(!candidate.video_prompt?.includes('老年张晓茹呈现'))
  assert.deepEqual(value.shots[0].characters.map((person: any) => person.character_id), [f.character.id])
  assert.equal((await session.finish()).saved, 1)
  const { extractStoryboardDialogue } = await import('../src/services/storyboard-validation.ts')
  assert.equal(extractStoryboardDialogue(f.rows()[0].description!).join(''), text)
})

test('source trust does not extend to a legacy entry in the same plan or to an explicit on-camera script instruction', async () => {
  for (const explicitOnCamera of [false, true]) {
    const f = fixture(`老年张晓茹：${explicitOnCamera ? '（画内音）' : ''}你好。`), before = f.snapshot()
    const speaker = db.insert(schema.characters).values({ dramaId: f.drama.id, name: '老年张晓茹', ...timestamps }).returning().get()
    const session = f.session(), value = sourcePlan(f.character.id)
    if (!explicitOnCamera) value.shots[1].rows[0].dialogue = [{ speaker_id: speaker.id, kind: 'dialogue', text: '另加的话。',
      voice: { age: '中年', register: '低音区', timbre: '温润音色' } }]
    session.stageSave([{ ...f.candidate(), character_ids: [f.character.id, speaker.id], video_prompt: undefined,
      video_prompt_plan: value }], { replaceExisting: true, isFinalBatch: true })
    assert.ok(session.getIssues().some(issue => issue.code === 'plan_speaker_visibility'))
    assert.equal((await session.finish()).saved, 0)
    assert.deepEqual(f.snapshot(), before)
  }
})

test('trusted source dialogue still rejects an unbound speaker or an undeclared speaker visibly acting in a reaction shot', async () => {
  for (const visibleAction of ['unbound', 'at_reference', 'plain_name']) {
    const f = fixture('老年张晓茹：你好。')
    const speaker = db.insert(schema.characters).values({ dramaId: f.drama.id, name: '老年张晓茹', ...timestamps }).returning().get()
    const session = f.session(), value = sourcePlan(f.character.id)
    if (visibleAction === 'at_reference') value.shots[0].rows[0].visual += '@老年张晓茹正面近景，抬手触碰照片。'
    if (visibleAction === 'plain_name') value.shots[0].rows[0].visual += '画面中老年张晓茹背影站在窗前，双手放下。'
    session.stageSave([{ ...f.candidate(), character_ids: visibleAction !== 'unbound' ? [f.character.id, speaker.id] : [f.character.id],
      video_prompt: undefined, video_prompt_plan: value }], { replaceExisting: true, isFinalBatch: true })
    assert.ok(session.getIssues().some(issue => visibleAction !== 'unbound' ? issue.code === 'plan_visual_participant' : issue.code === 'plan_speaker'))
    assert.equal((await session.finish()).saved, 0)
    assert.equal(f.rows()[0].id, f.old.id)
  }
})

test('typed session participants avoid gaze attribution errors while renderer still rejects missing actual actors and emotions', async () => {
  for (const variant of ['gaze_target', 'missing_actor', 'missing_emotion']) {
    const f = fixture('阿甲：你好。')
    const target = db.insert(schema.characters).values({ dramaId: f.drama.id, name: '阿乙', ...timestamps }).returning().get()
    const before = f.snapshot(), session = f.session(), value = sourcePlan(f.character.id)
    value.shots[0].rows[0].visual = '@阿甲正面中景，眼睛先瞟向阿乙方向又急急转回母亲脸上，喉头滚动，眼睑因紧张轻颤。'
    if (variant !== 'gaze_target') value.shots[0].rows[0].visual = '@阿甲保持原位，@阿乙正面近景，抬手靠近门框，眉心收紧。'
    if (variant === 'missing_emotion') value.shots[0].characters.push({ character_id: target.id, visibility: 'face_visible' })
    session.stageSave([{ ...f.candidate(), character_ids: [f.character.id, target.id], video_prompt: undefined,
      video_prompt_plan: value }], { replaceExisting: true, isFinalBatch: true })
    if (variant === 'gaze_target') {
      assert.equal(session.getIssues().some(issue => issue.severity === 'error'), false)
      assert.equal((await session.finish()).saved, 1)
      assert.ok(!f.rows()[0].videoPrompt?.split('\n')[0].includes('@阿乙'))
    } else {
      assert.ok(session.getIssues().some(issue => issue.code === (variant === 'missing_actor' ? 'plan_visual_participant' : 'plan_emotion')))
      assert.equal((await session.finish()).saved, 0)
      assert.deepEqual(f.snapshot(), before)
    }
  }
})

test('unknown source fragments cannot fall back to an older prompt or replace the existing draft', async () => {
  const f = fixture('阿甲：你好。'), before = f.snapshot(), session = f.session()
  const staged = session.stageSave([{ ...f.candidate(), video_prompt_plan: sourcePlan(f.character.id, [[1, 99]]) }],
    { replaceExisting: true, isFinalBatch: true })
  assert.ok(staged.issues.some(issue => issue.code === 'source_unknown_fragment'))
  assert.equal(session.getReport().candidates[0].video_prompt, '')
  assert.equal((await session.finish()).saved, 0)
  assert.deepEqual(f.snapshot(), before)
})

test('source-only whole-episode coverage rejects missing, repeated and reversed fragments across groups', async () => {
  for (const refs of [[[1, 1]], [[1, 1], [1, 1]], [[1, 2], [1, 1]]] as Array<Array<[number, number]>>) {
    const f = fixture('阿甲：这里的东西一直都在原来的位置，我从来没有搬动。'), before = f.snapshot(), session = f.session()
    for (const [index, ref] of refs.entries()) session.stageSave([{ ...f.candidate(index + 1), video_prompt: undefined,
      video_prompt_plan: sourcePlan(f.character.id, [ref]) }], { replaceExisting: index === 0, isFinalBatch: index === refs.length - 1 })
    const result = await session.finish()
    assert.equal(result.saved, 0)
    assert.ok(result.issues.some(issue => issue.code === 'source_coverage'))
    if (refs.length > 1 && refs[0][1] === refs[1][1]) assert.ok(result.issues.some(issue => issue.code === 'source_duplicate'))
    assert.deepEqual(f.snapshot(), before)
  }
})

test('mixed source and legacy plans still reject source fragment reuse across groups', async () => {
  const f = fixture('阿甲：你好。'), before = f.snapshot(), session = f.session(), legacy: any = firstPassPlan(f.character.id)
  legacy.shots[0].rows[0].dialogue = [{ speaker_id: f.character.id, kind: 'dialogue', text: '你好。',
    voice: { age: '中年', register: '低音区', timbre: '温润音色' } }]
  session.stageSave([{ ...f.candidate(1), video_prompt_plan: sourcePlan(f.character.id) }], { replaceExisting: true })
  session.stageSave([{ ...f.candidate(2), description: '', video_prompt_plan: legacy }])
  session.stageSave([{ ...f.candidate(3), video_prompt_plan: sourcePlan(f.character.id) }], { isFinalBatch: true })
  const result = await session.finish()
  assert.equal(result.saved, 0)
  assert.ok(result.issues.some(issue => issue.code === 'source_duplicate'))
  assert.deepEqual(f.snapshot(), before)
})

test('source prompt-only generation keeps the locked description and duration', async () => {
  const f = fixture('阿甲：你好。')
  const description = '【镜头1】阿甲正面中景，抬眼后说：「你好。」。【镜头2】阿甲正面近景，点头后放下手。'
  db.update(schema.storyboards).set({ description, duration: 9 }).where(eq(schema.storyboards.id, f.old.id)).run()
  const session = f.session('prompt')
  session.stageUpdate(f.old.id, { video_prompt_plan: sourcePlan(f.character.id) })
  assert.equal((await session.finish()).saved, 1)
  assert.equal(f.rows()[0].description, description)
  assert.equal(f.rows()[0].duration, 9)
  const before = f.snapshot(), mismatched = f.session('prompt'), fourRows = sourcePlan(f.character.id)
  fourRows.shots[0].rows.push({ visual: '@阿甲保持原坐标和朝向，轻眨后准备回应。' })
  mismatched.stageUpdate(f.old.id, { video_prompt_plan: fourRows })
  assert.ok(mismatched.getIssues().some(issue => issue.code === 'plan_time_rows'))
  assert.equal((await mismatched.finish()).saved, 0)
  assert.deepEqual(f.snapshot(), before)
})

test('explicit same-scene source continuation inherits only the prior origin and axis clauses', async () => {
  const f = fixture('阿甲：这里的东西一直都在原来的位置，我从来没有搬动。'), session = f.session()
  session.stageSave([{ ...f.candidate(1), video_prompt_plan: sourcePlan(f.character.id, [[1, 1]]) }], { replaceExisting: true })
  const next = sourcePlan(f.character.id, [[1, 2]])
  next.space = '承接上一组，X轴向东，Y轴向北，摄影机仍在南侧朝北，人物按当前镜头继续行动。'
  session.stageSave([{ ...f.candidate(2), video_prompt_plan: next }], { isFinalBatch: true })
  const effective = session.getReport().candidates[1].video_prompt_plan!.space
  assert.ok(effective.includes('门槛为原点A0'))
  assert.ok(effective.includes('X轴向东') && effective.includes('Y轴向北'))
  assert.ok(effective.endsWith(next.space))
  assert.ok(!effective.includes('@阿甲站在A('), 'continuation never copies old character coordinates')
  assert.equal((await session.finish()).saved, 2)
})

test('missing-origin source plans cannot inherit across scenes or without an explicit continuation request', async () => {
  for (const differentScene of [false, true]) {
    const f = fixture('阿甲：这里的东西一直都在原来的位置，我从来没有搬动。'), before = f.snapshot(), session = f.session()
    session.stageSave([{ ...f.candidate(1), video_prompt_plan: sourcePlan(f.character.id, [[1, 1]]) }], { replaceExisting: true })
    const next = sourcePlan(f.character.id, [[1, 2]])
    next.space = `${differentScene ? '继承上一组，' : ''}X轴向东，Y轴向北，摄影机在南侧。`
    const sceneId = differentScene ? db.insert(schema.scenes).values({ dramaId: f.drama.id, location: '别处', time: '日', prompt: 'other scene', ...timestamps }).returning().get().id : f.scene.id
    session.stageSave([{ ...f.candidate(2), scene_id: sceneId, video_prompt_plan: next }], { isFinalBatch: true })
    assert.ok(session.getIssues().some(issue => issue.code === 'plan_space_origin'))
    assert.equal(session.getReport().candidates[1].video_prompt_plan!.space, next.space)
    assert.equal((await session.finish()).saved, 0)
    assert.deepEqual(f.snapshot(), before)
  }
})

test('only source breakdown scalar row-count mistakes normalize duration within eight to fifteen seconds', async () => {
  const f = fixture('阿甲：你好。'), session = f.session(), fourRows = sourcePlan(f.character.id)
  fourRows.shots[0].rows.push({ visual: '@阿甲保持原坐标和朝向，轻眨后准备回应。' })
  session.stageSave([{ ...f.candidate(), duration: 9, video_prompt_plan: fourRows }], { replaceExisting: true, isFinalBatch: true })
  assert.equal(session.getReport().candidates[0].duration, 12)
  assert.ok(session.getReport().candidates[0].video_prompt?.includes('9-12秒'))
  assert.equal((await session.finish()).saved, 1)
  assert.equal(f.rows()[0].duration, 12)

  const remainder = fixture('阿甲：你好。'), remainderSession = remainder.session()
  remainderSession.stageSave([{ ...remainder.candidate(), duration: 8, video_prompt_plan: sourcePlan(remainder.character.id) }], { replaceExisting: true, isFinalBatch: true })
  assert.equal((await remainderSession.finish()).saved, 1)
  assert.equal(remainder.rows()[0].duration, 8, 'a matching row count retains the real remainder')

  const overflow = fixture('阿甲：你好。'), before = overflow.snapshot(), overflowSession = overflow.session(), sixRows = sourcePlan(overflow.character.id)
  sixRows.shots[0].rows.push({ visual: '@阿甲继续望向院门，保持原来坐标。' })
  sixRows.shots.push({ ...structuredClone(sixRows.shots[1]), shot_number: 3 })
  overflowSession.stageSave([{ ...overflow.candidate(), duration: 15, video_prompt_plan: sixRows }], { replaceExisting: true, isFinalBatch: true })
  assert.equal((await overflowSession.finish()).saved, 0)
  assert.equal(overflowSession.getReport().candidates[0].duration, 15)
  assert.deepEqual(overflow.snapshot(), before)
})

test('a repair replacement flag only upserts its candidates and never clears earlier staged groups', async () => {
  const f = fixture(), before = f.snapshot(), session = f.session()
  session.beginAttempt(0)
  session.stageSave([f.candidate(1), { ...f.candidate(2), video_prompt: 'invalid' }], { replaceExisting: true, isFinalBatch: true })
  const firstId = session.getReport().candidates[0].id
  assert.equal(session.shouldStopAttempt(), true)
  session.beginAttempt(1)
  session.stageSave([f.candidate(2)], { replaceExisting: true })
  assert.equal(session.shouldStopAttempt(), false)
  assert.equal(session.getReport().candidates.length, 2)
  assert.equal(session.getReport().candidates[0].id, firstId)
  assert.deepEqual(f.snapshot(), before)
  assert.equal((await session.finish()).saved, 2)

  const initial = fixture(), initialSession = initial.session()
  initialSession.beginAttempt(0)
  initialSession.stageSave([initial.candidate(1)], { replaceExisting: true })
  const rejected = initialSession.stageSave([initial.candidate(2)], { replaceExisting: true })
  assert.ok(rejected.issues.some(issue => issue.code === 'replace_repeated'))
  assert.equal(initialSession.getReport().candidates.length, 1)
})

test('a model attempt freezes later tool writes at its first rejection and unlocks only for the bounded repair', async () => {
  const f = fixture(), before = f.snapshot(), current = f.session()
  current.beginAttempt(0)
  current.stageSave([{ ...f.candidate(), video_prompt: 'invalid' }], { replaceExisting: true })
  assert.equal(current.shouldStopAttempt(), true)
  assert.equal(current.stageSave([f.candidate(2)], { isFinalBatch: true }).staged, false)
  const id = current.getReport().candidates[0].id
  assert.equal(current.stageUpdate(id, { video_prompt: f.candidate().video_prompt }).staged, false)
  assert.equal(current.getReport().candidates.length, 1)
  assert.equal((await current.finish()).saved, 0)
  assert.deepEqual(f.snapshot(), before)
  current.beginAttempt(1)
  assert.equal(current.shouldStopAttempt(), false)
  assert.ok(current.getIssues().some(issue => issue.severity === 'error'), 'repair still sees the original issues')
  current.stageUpdate(id, { video_prompt: f.candidate().video_prompt })
  current.stageSave([f.candidate(2)], { isFinalBatch: true })
  assert.equal(current.readyToCommit(), true)
  assert.equal((await current.finish()).saved, 2)
})

for (const method of ['update', 'save'] as const) {
  test(`the bounded repair can fix two rejected groups separately through ${method} without accepting the remaining bad group`, async () => {
    const f = fixture(), before = f.snapshot(), session = f.session()
    const invalidPlan = firstPassPlan(f.character.id)
    invalidPlan.space = 'missing spatial origin'
    session.beginAttempt(0)
    session.stageSave([1, 2].map(number => ({ ...f.candidate(number), video_prompt: undefined, video_prompt_plan: invalidPlan })),
      { replaceExisting: true, isFinalBatch: true })
    assert.equal(session.shouldStopAttempt(), true)
    assert.equal((await session.finish()).saved, 0)
    const [first, second] = session.getReport().candidates
    assert.ok(session.getIssues().some(issue => issue.storyboardId === first.id && issue.severity === 'error'))
    assert.ok(session.getIssues().some(issue => issue.storyboardId === second.id && issue.severity === 'error'))

    session.beginAttempt(1)
    const repair = (id: number, number: number) => method === 'update'
      ? session.stageUpdate(id, { video_prompt_plan: firstPassPlan(f.character.id) })
      : session.stageSave([{ ...f.candidate(number), video_prompt: undefined, video_prompt_plan: firstPassPlan(f.character.id) }])
    const repairedFirst = repair(first.id, 1)
    assert.equal(repairedFirst.staged, true)
    assert.equal('error' in repairedFirst, false, 'a valid repair must not be reported as a fresh tool-input failure')
    assert.equal(session.shouldStopAttempt(), false)
    assert.equal(session.getIssues().some(issue => issue.storyboardId === first.id && issue.severity === 'error'), false)
    assert.ok(session.getIssues().some(issue => issue.storyboardId === second.id && issue.severity === 'error'))
    assert.equal(session.readyToCommit(), false)
    assert.equal((await session.finish()).saved, 0, 'an untouched bad candidate still blocks the entire commit')
    assert.deepEqual(f.snapshot(), before)

    const repairedSecond = repair(second.id, 2)
    assert.equal('error' in repairedSecond, false)
    assert.equal(session.shouldStopAttempt(), false)
    assert.equal(session.readyToCommit(), true)
    assert.deepEqual(f.snapshot(), before, 'neither directed repair writes a partial draft')
    assert.equal((await session.finish()).saved, 2)
    assert.deepEqual(f.rows().map(row => row.storyboardNumber), [1, 2])
  })
}

test('a still-invalid candidate immediately stops the bounded repair and blocks later writes', async () => {
  const f = fixture(), before = f.snapshot(), session = f.session()
  session.beginAttempt(0)
  session.stageSave([1, 2].map(number => ({ ...f.candidate(number), video_prompt: 'invalid' })),
    { replaceExisting: true, isFinalBatch: true })
  const [first, second] = session.getReport().candidates
  session.beginAttempt(1)
  const rejected = session.stageUpdate(first.id, { video_prompt: 'still invalid' })
  assert.ok('error' in rejected)
  assert.equal(session.shouldStopAttempt(), true)
  assert.equal(session.stageUpdate(second.id, { video_prompt: f.candidate(2).video_prompt }).staged, false)
  assert.equal(session.stageSave([f.candidate(3)]).staged, false)
  assert.equal(session.getReport().candidates.find(row => row.id === second.id)?.video_prompt, 'invalid')
  assert.equal((await session.finish()).saved, 0)
  assert.deepEqual(f.snapshot(), before)
})

test('new schema or operation errors stop a bounded repair even while an untouched candidate remains invalid', async () => {
  for (const kind of ['schema', 'operation'] as const) {
    const f = fixture(), before = f.snapshot(), session = f.session()
    session.beginAttempt(0)
    session.stageSave([1, 2].map(number => ({ ...f.candidate(number), video_prompt: 'invalid' })),
      { replaceExisting: true, isFinalBatch: true })
    const [first, second] = session.getReport().candidates
    session.beginAttempt(1)
    session.stageUpdate(first.id, { video_prompt: f.candidate().video_prompt })
    assert.equal(session.shouldStopAttempt(), false)
    if (kind === 'schema') session.recordToolInputError('update_storyboard', 'video_prompt_plan.voice.age required', { video_prompt_plan: {} })
    else session.stageUpdate(-999, { video_prompt: f.candidate().video_prompt })
    assert.equal(session.shouldStopAttempt(), true)
    assert.ok(session.getIssues().some(issue => issue.code === (kind === 'schema' ? 'tool_input' : 'candidate_not_found')))
    assert.equal(session.stageUpdate(second.id, { video_prompt: f.candidate(2).video_prompt }).staged, false)
    assert.equal((await session.finish()).saved, 0)
    assert.deepEqual(f.snapshot(), before)
  }
})

test('fresh breakdown context omits old grouping while prompt context keeps only targets and direct neighbors', async () => {
  const f = fixture(), rows = [f.old]
  for (let number = 2; number <= 10; number++) rows.push(db.insert(schema.storyboards).values({ episodeId: f.episode.id, storyboardNumber: number, description: 'Old group', videoPrompt: `OLD-PROMPT-${number}-${'x'.repeat(1000)}`, duration: 9, ...timestamps }).returning().get())
  const fresh = await (storyboardTools.readStoryboardContext.execute as any)({}, f.context(f.session()))
  assert.deepEqual(fresh.existing_storyboards, [])
  assert.ok(!JSON.stringify(fresh).includes('OLD-PROMPT-'))
  const focused = f.session('prompt', { storyboardIds: [rows[4].id] })
  const payload = await (storyboardTools.readStoryboardContext.execute as any)({}, f.context(focused))
  assert.deepEqual(payload.existing_storyboards.map((row: any) => row.id), [rows[3].id, rows[4].id, rows[5].id])
})

test('first-pass tools assemble a complete prompt before the initial validation and commit only the rendered prose', async () => {
  const f = fixture(), before = f.snapshot(), session = f.session()
  const staged = await (storyboardTools.saveStoryboards.execute as any)({
    replace_existing: true, is_final_batch: true,
    storyboards: [{ ...f.candidate(), video_prompt: undefined, video_prompt_plan: firstPassPlan(f.character.id) }],
  }, f.context(session))
  assert.equal(staged.issues.some((issue: any) => issue.severity === 'error'), false)
  assert.deepEqual(f.snapshot(), before)
  const context = await (storyboardTools.readStoryboardContext.execute as any)({}, f.context(session))
  assert.equal(context.first_pass_generation.output, 'video_prompt_plan')
  assert.equal(context.first_pass_generation.duration_options.length, 8)
  assert.equal(context.existing_storyboards[0].video_prompt_plan.shots.length, 2)
  assert.ok(context.existing_storyboards[0].video_prompt.includes('情绪60%'))
  const result = await session.finish()
  assert.equal(result.saved, 1)
  const row = f.rows()[0]
  assert.ok(row.videoPrompt?.startsWith('出场人物：@阿甲'))
  assert.ok(row.videoPrompt?.includes('3-6秒：切到'))
  assert.ok(!row.videoPrompt?.includes('character_id'))
})

test('prompt-only plans inherit exact target duration, metadata is cleared when repairing with legacy prose', async () => {
  const f = fixture()
  db.update(schema.storyboards).set({ description: f.candidate().description, duration: 9 }).where(eq(schema.storyboards.id, f.old.id)).run()
  const session = f.session('prompt')
  const plan = firstPassPlan(f.character.id)
  plan.space = 'missing origin'
  const staged = session.stageUpdate(f.old.id, { video_prompt_plan: plan })
  assert.ok(staged.issues.some(issue => issue.code === 'plan_space_origin'))
  assert.equal((await session.finish()).saved, 0)
  const context = await (storyboardTools.readStoryboardContext.execute as any)({}, f.context(session))
  assert.equal(context.first_pass_generation.target_budgets[0].duration, 9)
  session.stageUpdate(f.old.id, { video_prompt: f.candidate().video_prompt })
  assert.equal(session.getReport().candidates[0].video_prompt_plan, undefined)
  assert.equal((await session.finish()).saved, 1)
})

test('a rejected tool input after a valid candidate blocks commit instead of silently using the earlier candidate', async () => {
  const f = fixture(), before = f.snapshot(), session = f.session()
  session.stageSave([f.candidate()], { replaceExisting: true, isFinalBatch: true })
  session.recordToolInputError('update_storyboard', 'video_prompt_plan.voice.age required', { video_prompt_plan: { space: 'incomplete' } })
  assert.equal((await session.finish()).saved, 0)
  assert.deepEqual(f.snapshot(), before)
  assert.ok(session.getReport().rejectedToolInput)
  session.stageUpdate(session.getReport().candidates[0].id, { video_prompt: f.candidate().video_prompt })
  assert.equal(session.getReport().rejectedToolInput, undefined)
  assert.equal((await session.finish()).saved, 1)
})

test('whole-episode coverage allows original long dialogue to span groups without treating visual directions as dialogue', async () => {
  const firstHalf = '我今天终于来到这里看到了从前的门窗和院墙', secondHalf = '现在我要沿着原来那条小路继续慢慢往前走'
  const f = fixture(`阿甲说：「${firstHalf}${secondHalf}。」`), session = f.session()
  const candidate = (number: number, text: string) => ({
    ...f.candidate(number),
    description: `【镜头1】阿甲正面中景，抬眼后说：「${text}」。【镜头2】阿甲正面近景点头。`,
    video_prompt: f.candidate(number).video_prompt.replace('固定镜头保持3秒。', `固定镜头保持3秒，阿甲说：「${text}」听感中年、低音区、温润音色，每秒4字。`),
  })
  // The group budgets are tested separately; this case isolates coverage across groups.
  session.stageSave([candidate(1, firstHalf), candidate(2, `${secondHalf}。`)], { replaceExisting: true, isFinalBatch: true })
  const result = await session.finish()
  assert.equal(result.issues.some(issue => issue.code === 'dialogue_coverage'), false)
  assert.equal(result.saved, 2)
})

test('first-pass session rendering preserves an uploaded voice token without making the model copy it', async () => {
  const f = fixture('阿甲说：「你好。」')
  db.update(schema.characters).set({ voiceAudioUrl: 'static/uploads/existing-voice.wav' }).where(eq(schema.characters.id, f.character.id)).run()
  db.update(schema.storyboards).set({ description: '【镜头1】阿甲正面中景，抬眼说：「你好。」【镜头2】阿甲正面近景，点头后放下手。', duration: 9 }).where(eq(schema.storyboards.id, f.old.id)).run()
  const session = f.session('prompt'), plan: any = firstPassPlan(f.character.id)
  plan.shots[0].rows[0].dialogue = [{ kind: 'dialogue', speaker_id: f.character.id, text: '你好。', voice: { age: '中年', register: '低音', timbre: '温润' } }]
  session.stageUpdate(f.old.id, { video_prompt_plan: plan })
  const result = await session.finish()
  assert.equal(result.saved, 1)
  assert.ok(f.rows()[0].videoPrompt?.includes('#阿甲'))
  const { resolveStoryboardVoiceReferences } = await import('../src/services/character-voice-references.ts')
  const resolved = await resolveStoryboardVoiceReferences(f.rows()[0].videoPrompt!, f.old.id, [])
  assert.deepEqual(resolved.audioUrls, ['static/uploads/existing-voice.wav'])
})

test('invalid replacement is staged and readable, leaves old rows and links untouched, then repairs atomically', async () => {
  const f = fixture()
  const before = f.snapshot()
  const session = f.session()
  const invalid = session.stageSave([{ ...f.candidate(), video_prompt: 'invalid candidate' }], { replaceExisting: true, isFinalBatch: true })
  assert.ok(invalid.issues.some(issue => issue.code === 'information_header'))
  assert.equal(session.hasCandidates(), true)
  assert.deepEqual(f.snapshot(), before)
  const stagedId = session.getReport().candidates[0].id
  assert.ok(stagedId < 0)
  const payload = await (storyboardTools.readStoryboardContext.execute as any)({}, f.context(session))
  assert.equal(payload.existing_storyboards.length, 1)
  assert.equal(payload.existing_storyboards[0].id, stagedId)
  assert.equal(payload.existing_storyboards[0].video_prompt, 'invalid candidate')
  assert.equal((await session.finish()).saved, 0)
  assert.deepEqual(f.snapshot(), before)
  session.stageUpdate(stagedId, { video_prompt: f.candidate().video_prompt })
  assert.equal(session.getIssues().some(issue => issue.severity === 'error'), false)
  const result = await session.finish()
  assert.equal(result.saved, 1)
  assert.equal(f.rows()[0].videoPrompt, f.candidate().video_prompt)
  assert.notEqual(f.rows()[0].id, f.old.id)
  assert.deepEqual(db.select().from(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, f.old.id)).all(), [])
  assert.equal((await session.finish()).saved, 1)
  assert.equal(f.rows().length, 1)
})

test('all batches must pass; repeated replacement is rejected and earlier candidate batches survive repair', async () => {
  const f = fixture()
  const before = f.snapshot()
  const session = f.session()
  session.stageSave([f.candidate(1)], { replaceExisting: true })
  const replacement = session.stageSave([f.candidate(2)], { replaceExisting: true })
  assert.ok(replacement.issues.some(issue => issue.code === 'replace_repeated'))
  assert.equal(session.getReport().candidates.length, 1)
  session.stageSave([{ ...f.candidate(2), duration: 7 }], { isFinalBatch: true })
  assert.equal((await session.finish()).saved, 0)
  assert.deepEqual(f.snapshot(), before)
  session.stageSave([f.candidate(2)])
  assert.equal((await session.finish()).saved, 2)
  assert.deepEqual(f.rows().map(row => row.storyboardNumber), [1, 2])
})

test('empty, missing first/final batch and skipped numbers cannot report a successful save', async () => {
  const f = fixture()
  const before = f.snapshot()
  const empty = await f.session().finish()
  assert.equal(empty.saved, 0)
  assert.ok(empty.issues.some(issue => issue.code === 'no_candidates'))
  const first = f.session()
  assert.ok(first.stageSave([f.candidate()]).issues.some(issue => issue.code === 'replace_required'))
  assert.equal(first.hasCandidates(), false)
  const final = f.session()
  final.stageSave([f.candidate()], { replaceExisting: true })
  assert.ok((await final.finish()).issues.some(issue => issue.code === 'final_batch_missing'))
  const gap = f.session()
  gap.stageSave([f.candidate(1), f.candidate(3)], { replaceExisting: true, isFinalBatch: true })
  assert.ok((await gap.finish()).issues.some(issue => issue.code === 'shot_sequence'))
  assert.deepEqual(f.snapshot(), before)
})

test('whole-episode explicit dialogue coverage prevents a partial first batch from replacing the old draft', async () => {
  const f = fixture('阿甲说：「先回家。」\n阿甲（低声）：随后再来。')
  const before = f.snapshot()
  const session = f.session()
  session.stageSave([f.candidate()], { replaceExisting: true, isFinalBatch: true })
  const result = await session.finish()
  assert.equal(result.saved, 0)
  assert.equal(result.issues.filter(issue => issue.code === 'dialogue_coverage').length, 2)
  assert.ok(result.issues.every(issue => !issue.message.includes('先回家')))
  assert.deepEqual(f.snapshot(), before)
})

test('screenplay dialogue after leading acting directions cannot omit the final Qin Cuihua line', async () => {
  const firstText = '什么？卫东不是我儿子？', finalText = '卫东确实不是你的孩子。'
  const f = fixture(`老年高大山：（猛地撑起身，声音发颤）${firstText}\n秦翠花：（攥紧衣角，垂着眼睛）${finalText}`)
  const grandfather = db.insert(schema.characters).values({ dramaId: f.drama.id, name: '老年高大山', ...timestamps }).returning().get()
  const qin = db.insert(schema.characters).values({ dramaId: f.drama.id, name: '秦翠花', ...timestamps }).returning().get()
  const before = f.snapshot(), session = f.session()
  const spokenCandidate = (number: number, character: { id: number; name: string }, text: string) => {
    const plan = firstPassPlan(character.id)
    plan.space = plan.space.replaceAll('阿甲', character.name)
    for (const shot of plan.shots) for (const row of shot.rows) row.visual = row.visual.replaceAll('阿甲', character.name)
    const dialoguePlan = {
      ...plan,
      shots: plan.shots.map((shot, index) => index ? shot : {
        ...shot, rows: [{ ...shot.rows[0], dialogue: [{ speaker_id: character.id, kind: 'dialogue' as const, text,
          voice: { age: '老年', register: '低中音域', timbre: '温润音色' } }] }],
      }),
    }
    return { ...f.candidate(number), character_ids: [character.id], video_prompt: undefined, video_prompt_plan: dialoguePlan,
      description: `【镜头1】${character.name}正面中景，抬眼后说：「${text}」。【镜头2】${character.name}正面近景，点头后放下手。` }
  }
  session.stageSave([spokenCandidate(1, grandfather, firstText)], { replaceExisting: true, isFinalBatch: true })
  const incomplete = await session.finish()
  assert.equal(incomplete.saved, 0)
  const coverage = incomplete.issues.filter(issue => issue.code === 'dialogue_coverage')
  assert.equal(coverage.length, 1, 'the first spoken line is covered, but the final stage-prefixed line is not')
  assert.ok(coverage[0].message.includes('第2条'))
  assert.ok(!coverage[0].message.includes(finalText), 'validation diagnostics must not disclose the dialogue')
  assert.deepEqual(f.snapshot(), before)

  session.stageSave([spokenCandidate(2, qin, finalText)], { isFinalBatch: true })
  const complete = await session.finish()
  assert.equal(complete.issues.some(issue => issue.severity === 'error'), false)
  assert.equal(complete.saved, 2)
})

test('prompt mode restricts targets and fields, requires every target, then changes only video_prompt', async () => {
  const f = fixture()
  const valid = f.candidate()
  db.update(schema.storyboards).set({ description: valid.description, duration: valid.duration }).where(eq(schema.storyboards.id, f.old.id)).run()
  const second = db.insert(schema.storyboards).values({ episodeId: f.episode.id, storyboardNumber: 2, description: valid.description,
    videoPrompt: 'Second old prompt', duration: 9, sceneId: f.scene.id, ...timestamps }).returning().get()
  db.insert(schema.storyboardCharacters).values({ storyboardId: second.id, characterId: f.character.id }).run()
  const session = f.session('prompt', { storyboardIds: [f.old.id, second.id] })
  assert.ok(session.stageSave([valid]).issues.some(issue => issue.code === 'prompt_only'))
  assert.ok(session.stageUpdate(987654321, { video_prompt: valid.video_prompt }).issues.some(issue => issue.code === 'target_not_allowed'))
  assert.ok(session.stageUpdate(f.old.id, { video_prompt: valid.video_prompt, duration: 12 }).issues.some(issue => issue.code === 'prompt_fields_only'))
  const before = f.snapshot()
  session.stageUpdate(f.old.id, { video_prompt: valid.video_prompt })
  assert.equal((await session.finish()).saved, 0)
  assert.ok(session.getIssues().some(issue => issue.code === 'target_not_updated' && issue.storyboardId === second.id))
  assert.deepEqual(f.snapshot(), before)
  session.stageUpdate(second.id, { video_prompt: valid.video_prompt })
  assert.equal((await session.finish()).saved, 2)
  const afterSave = f.snapshot()
  assert.equal(afterSave.rows[0].description, before.rows[0].description)
  assert.equal(afterSave.rows[0].duration, before.rows[0].duration)
  assert.equal(afterSave.rows[0].title, before.rows[0].title)
  assert.deepEqual(afterSave.links, before.links)
  assert.deepEqual(afterSave.props, before.props)
  assert.deepEqual(afterSave.episode, before.episode)
  assert.equal(afterSave.rows[0].videoPrompt, valid.video_prompt)
})

test('abort, cancel and a late callback during saving prevent every write and all future staging', async () => {
  const f = fixture()
  const before = f.snapshot()
  const controller = new AbortController()
  const aborted = f.session('breakdown', { signal: controller.signal })
  aborted.stageSave([f.candidate()], { replaceExisting: true, isFinalBatch: true })
  controller.abort()
  assert.equal((await aborted.finish()).saved, 0)
  assert.ok(aborted.getIssues().some(issue => issue.code === 'aborted'))
  let session: ReturnType<typeof createStoryboardSession>
  session = f.session('breakdown', { onPhase: async (phase: string) => { if (phase === 'saving') session.cancel('runner timed out') } })
  session.stageSave([f.candidate()], { replaceExisting: true, isFinalBatch: true })
  assert.equal((await session.finish()).saved, 0)
  assert.ok(session.stageUpdate(session.getReport().candidates[0].id, { video_prompt: f.candidate().video_prompt }).issues.some(issue => issue.code === 'aborted'))
  assert.deepEqual(f.snapshot(), before)
})

test('a transaction failure after deletion rolls back old rows, binding links and episode duration', async () => {
  const f = fixture()
  const before = f.snapshot()
  const session = f.session()
  session.stageSave([f.candidate(1), f.candidate(2)], { replaceExisting: true, isFinalBatch: true })
  const client = (db as any).$client
  client.exec(`CREATE TRIGGER storyboard_test_rollback BEFORE INSERT ON storyboards WHEN NEW.episode_id=${f.episode.id} AND NEW.storyboard_number=2 BEGIN SELECT RAISE(ABORT, 'intentional test rollback'); END`)
  try {
    const result = await session.finish()
    assert.equal(result.saved, 0)
    assert.ok(result.issues.some(issue => issue.code === 'commit_failed'))
    assert.deepEqual(f.snapshot(), before)
  } finally { client.exec('DROP TRIGGER storyboard_test_rollback') }
})

test('manual edits and script changes during generation are detected before atomic replacement', async () => {
  for (const editScript of [false, true]) {
    const f = fixture()
    const session = f.session()
    session.stageSave([f.candidate()], { replaceExisting: true, isFinalBatch: true })
    if (editScript) db.update(schema.episodes).set({ scriptContent: 'New manual screenplay.' }).where(eq(schema.episodes.id, f.episode.id)).run()
    else db.update(schema.storyboards).set({ title: 'New manual edit' }).where(eq(schema.storyboards.id, f.old.id)).run()
    const edited = f.snapshot()
    const result = await session.finish()
    assert.equal(result.saved, 0)
    assert.ok(result.issues.some(issue => issue.code === 'concurrent_edit'))
    assert.deepEqual(f.snapshot(), edited)
  }
})

test('Agent write tools require a scoped session and never bypass candidate validation', async () => {
  const f = fixture()
  const before = f.snapshot()
  const missing = await (storyboardTools.saveStoryboards.execute as any)({ replace_existing: true, is_final_batch: true, storyboards: [f.candidate()] }, f.context())
  assert.equal(missing.issues[0].code, 'session_required')
  const session = f.session()
  const result = await (storyboardTools.saveStoryboards.execute as any)({ replace_existing: true, is_final_batch: true, storyboards: [f.candidate()] }, f.context(session))
  assert.equal(result.staged, true)
  assert.equal(result.saved, 0)
  assert.deepEqual(f.snapshot(), before)
  assert.equal((await session.finish()).saved, 1)
})
