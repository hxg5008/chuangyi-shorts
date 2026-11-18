import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import type { StoryboardCandidate, StoryboardSessionOptions } from '../src/services/storyboard-session.ts'

// Import the database only after every writable path points into this disposable directory.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-skill-session-'))
process.env.SQLITE_PATH = path.join(directory, 'skill-session.sqlite3')
process.env.HUOBAO_DATA_DIR = directory
process.env.STORAGE_PATH = path.join(directory, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.ts')
const { createStoryboardSession } = await import('../src/services/storyboard-session.ts')
const { splitScriptUnits, scriptTimingBudget } = await import('../src/services/skill-storyboard-contract.ts')
const timestamps = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
const speeches = ['请把木杯留在这里。', '我回来拿。']
const screenplay = [
  `动作：阿甲沿原有门槛走入，湿袖贴在腕边，观察院内积水。${'雨'.repeat(45)}`,
  `阿甲：${speeches[0]}`,
  `动作：阿甲松开左手，在原有石阶边停住，回头看着木杯。${'风'.repeat(45)}`,
  `阿甲：${speeches[1]}`,
].join('\n')

after(async () => {
  db.$client.close()
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(directory).startsWith('huobao-skill-session-'))
  await fs.rm(directory, { recursive: true, force: true })
})

function fixture(script = screenplay) {
  const drama = db.insert(schema.dramas).values({ title: 'Isolated skill session', ...timestamps }).returning().get()
  const episode = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: 'Skill profile', scriptContent: script, duration: 7, ...timestamps }).returning().get()
  const character = db.insert(schema.characters).values({ dramaId: drama.id, name: '阿甲', ...timestamps }).returning().get()
  const scene = db.insert(schema.scenes).values({ dramaId: drama.id, location: '院落', time: '雨后白天', prompt: '现有院落', ...timestamps }).returning().get()
  const prop = db.insert(schema.props).values({ dramaId: drama.id, name: '木杯', ...timestamps }).returning().get()
  const candidate = (number: number, speech = speeches[number - 1] || ''): StoryboardCandidate => ({
    shot_number: number, title: `第${number}组原始标题`, time: '雨后白天，承接原场景时刻', location: '@院落的原门槛与石阶',
    shot_type: '背面中景／物件特写', angle: '平视后俯视', movement: '固定；缓慢靠近原木杯',
    description: `【镜头1】@阿甲背身停在门槛，左手湿袖轻落${speech ? `，阿甲低声说：「${speech}」` : ''}。` +
      '【镜头2】原木杯留在石阶边，画面不切回人物，话锋切至门外的动静，保留雨后光线。',
    result: '@阿甲左手松开，@木杯仍在原石阶边，下一组承接这一末态。',
    atmosphere: '原有阴天散射光，雨声逐渐减弱；保留原作者的这句气氛文本。',
    image_prompt: '@院落门槛边，@阿甲背影和原石阶上的@木杯同框；原始图片提示词。',
    video_prompt: [
      '出场人物：@阿甲；场景：@院落；道具：@木杯。无背景音乐，保留必要声音。',
      `0-3秒：A0为原门槛，X向东、Y向北。@阿甲背身停住，左手湿袖轻落${speech ? `，阿甲低声说：「${speech}」` : ''}。`,
      '3-6秒：@木杯 留在原石阶边，画面不切回人物，缓慢靠近杯沿。',
      '6-9秒：@木杯 延续同一物件特写，话锋切至门外的动静，原有雨后光线不变。',
    ].join('\n'),
    bgm_prompt: '无背景音乐；这段原始要求不应被覆盖。', sound_effect: '原有雨滴、袖口摩擦及杯底轻响；保留原稿文字。',
    duration: 9, scene_id: scene.id, character_ids: [character.id], prop_ids: [prop.id],
    source_ids: number === 1 ? [1, 2] : [3, 4], time_row_counts: [1, 2],
  })
  const old = [1, 2].map(number => {
    const value = candidate(number)
    const row = db.insert(schema.storyboards).values({ episodeId: episode.id, storyboardNumber: number,
      title: value.title, time: value.time, location: value.location, shotType: value.shot_type, angle: value.angle, movement: value.movement,
      description: value.description, result: value.result, atmosphere: value.atmosphere, imagePrompt: value.image_prompt,
      videoPrompt: `${value.video_prompt}\n原稿末尾备注`, bgmPrompt: value.bgm_prompt, soundEffect: value.sound_effect,
      sceneId: scene.id, duration: 9, composedImage: 'local-original-image', referenceImages: '["local-reference"]',
      videoUrl: 'local-original-video', status: 'completed', ...timestamps }).returning().get()
    db.insert(schema.storyboardCharacters).values({ storyboardId: row.id, characterId: character.id }).run()
    db.insert(schema.storyboardProps).values({ storyboardId: row.id, propId: prop.id }).run()
    return row
  })
  const rows = () => db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episode.id)).all().sort((a, b) => a.storyboardNumber - b.storyboardNumber)
  const snapshot = () => {
    const storyboards = rows(), ids = storyboards.map(row => row.id)
    return { storyboards, characters: db.select().from(schema.storyboardCharacters).where(inArray(schema.storyboardCharacters.storyboardId, ids)).all(),
      props: db.select().from(schema.storyboardProps).where(inArray(schema.storyboardProps.storyboardId, ids)).all(),
      episode: db.select().from(schema.episodes).where(eq(schema.episodes.id, episode.id)).get() }
  }
  const session = (options: Partial<StoryboardSessionOptions> = {}) => createStoryboardSession({ mode: 'breakdown',
    episodeId: episode.id, dramaId: drama.id, validationProfile: 'skill-content', ...options })
  return { drama, episode, character, scene, prop, old, candidate, rows, snapshot, session }
}
const stageAll = (f: ReturnType<typeof fixture>, candidates = [f.candidate(1), f.candidate(2)], session = f.session()) => {
  const result = session.stageSave(candidates, { replaceExisting: true, isFinalBatch: true })
  return { session, result }
}
const databaseSnapshot = () => Object.fromEntries((db.$client.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
  .map(({ name }) => [name, db.$client.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all()]))

test('complete-candidate review leaves every database table and the original staged session unchanged, then normal commit still works', async () => {
  const f = fixture(), phases: string[] = []; let commits = 0
  db.update(schema.characters).set({ voiceAudioUrl: 'local-voice-fixture.wav' }).where(eq(schema.characters.id, f.character.id)).run()
  const candidates = [f.candidate(1), f.candidate(2)]
  candidates[0].video_prompt += '\n音色参考：#阿甲。'
  const inputs = structuredClone(candidates), session = f.session({ onPhase: phase => { phases.push(phase) } })
  session.setCommitHook(() => { commits++ })
  session.beginAttempt(0)
  assert.equal('error' in session.stageSave([candidates[0]], { replaceExisting: true }), false)
  const beforeDatabase = databaseSnapshot(), beforeSession = session.getReport(), fingerprint = session.getContextFingerprint()
  const issues = session.reviewCompleteCandidates(candidates)
  assert.deepEqual(issues.filter(issue => issue.severity === 'error'), [])
  assert.deepEqual(databaseSnapshot(), beforeDatabase, 'Review cannot write rows, episode metadata, asset links or any other table')
  assert.deepEqual(session.getReport(), beforeSession, 'Existing staged candidates and their temporary IDs remain exactly intact')
  assert.equal(session.getContextFingerprint(), fingerprint)
  assert.deepEqual(candidates, inputs)
  assert.equal(session.savedCount, 0)
  assert.equal(session.shouldStopAttempt(), false)
  assert.deepEqual(phases, [])
  assert.equal(commits, 0)
  const staged = session.stageSave([candidates[1]], { isFinalBatch: true })
  assert.equal('error' in staged, false, JSON.stringify(staged.issues))
  const finished = await session.finish()
  assert.equal(finished.saved, 2)
  assert.deepEqual(finished.issues.filter(issue => issue.severity === 'error'), [])
  assert.deepEqual(phases, ['validating', 'saving'])
  assert.equal(commits, 1)
  assert.deepEqual(f.rows().map(row => row.videoPrompt), candidates.map(candidate => candidate.video_prompt))
})

test('complete review reports missing source, changed words, missing fields and invalid bindings without polluting old drafts or prior session errors', () => {
  for (const variant of ['source', 'missing_words', 'changed_words', 'field', 'scene', 'character', 'voice_binding', 'voice_missing']) {
    const f = fixture(), candidates = [f.candidate(1), f.candidate(2)], session = f.session()
    let expected = '', field: string | undefined
    if (variant === 'source') { candidates[1].source_ids = [4]; expected = 'source_coverage' }
    if (variant === 'missing_words') { candidates[0] = f.candidate(1, ''); expected = 'dialogue_coverage' }
    if (variant === 'changed_words') { candidates[0] = f.candidate(1, speeches[0].replace('这里', '那里')); expected = 'dialogue_coverage' }
    if (variant === 'field') { delete candidates[0].result; expected = 'skill_field_missing'; field = 'result' }
    if (variant === 'scene') { candidates[0].scene_id = 999999; expected = 'scene_binding'; field = 'scene_id' }
    if (variant === 'character') { candidates[0].character_ids = [999999]; expected = 'character_binding'; field = 'character_ids' }
    if (variant === 'voice_binding') {
      db.insert(schema.characters).values({ dramaId: f.drama.id, name: '阿乙', voiceAudioUrl: 'local-unbound-voice.wav', ...timestamps }).run()
      candidates[0].video_prompt += '\n音色参考：#阿乙。'
      expected = 'voice_reference'; field = 'video_prompt'
    }
    if (variant === 'voice_missing') { candidates[0].video_prompt += '\n音色参考：#阿甲。'; expected = 'voice_reference'; field = 'video_prompt' }
    session.recordToolInputError('previous_input', '此前已有待补齐信息', { original: '保留原session诊断' })
    const beforeDatabase = databaseSnapshot(), beforeSession = session.getReport(), inputs = structuredClone(candidates)
    const issues = session.reviewCompleteCandidates(candidates)
    assert.ok(issues.some(issue => issue.severity === 'error' && issue.code === expected && (field === undefined || issue.field === field)), variant)
    if (variant === 'voice_binding') assert.ok(issues.some(issue => issue.code === 'voice_reference' && issue.message.includes('未绑定')))
    if (variant === 'voice_missing') assert.ok(issues.some(issue => issue.code === 'voice_reference' && issue.message.includes('尚未上传')))
    assert.deepEqual(databaseSnapshot(), beforeDatabase, variant)
    assert.deepEqual(session.getReport(), beforeSession, 'Review must neither clear the old error nor replace it with its own result')
    assert.deepEqual(candidates, inputs)
    assert.equal(session.savedCount, 0)
  }
})

test('prompt review validates the complete target set read-only and does not prevent a later video-prompt-only commit', async () => {
  const f = fixture(), session = f.session({ mode: 'prompt', storyboardIds: [f.old[0].id] })
  const beforeDatabase = databaseSnapshot(), beforeRows = f.rows(), beforeSession = session.getReport(), candidate = f.candidate(1)
  const missing = session.reviewCompleteCandidates([])
  assert.ok(missing.some(issue => issue.code === 'target_not_updated' && issue.storyboardId === f.old[0].id))
  assert.deepEqual(session.reviewCompleteCandidates([candidate]).filter(issue => issue.severity === 'error'), [])
  assert.deepEqual(databaseSnapshot(), beforeDatabase)
  assert.deepEqual(session.getReport(), beforeSession)
  const staged = session.stageUpdate(f.old[0].id, { video_prompt: candidate.video_prompt, time_row_counts: candidate.time_row_counts })
  assert.equal('error' in staged, false)
  assert.equal((await session.finish()).saved, 1)
  const after = f.rows(), targetBefore = beforeRows.find(row => row.id === f.old[0].id)!
  const { videoPrompt: _beforePrompt, updatedAt: _beforeTime, ...unchangedBefore } = targetBefore
  const { videoPrompt: _afterPrompt, updatedAt: _afterTime, ...unchangedAfter } = after[0]
  assert.equal(after[0].videoPrompt, candidate.video_prompt)
  assert.deepEqual(unchangedAfter, unchangedBefore)
  assert.deepEqual(after[1], beforeRows.find(row => row.id === f.old[1].id))
})

test('skill-content commits every original skill field and explicit binding without legacy prose inference or shot rewriting', async () => {
  const f = fixture(), before = f.snapshot(), candidates = [f.candidate(1), f.candidate(2)], original = structuredClone(candidates)
  const budget = scriptTimingBudget(screenplay)
  assert.ok(18 >= budget.minimumSeconds && 18 <= budget.maximumSeconds, 'Action-only padding makes the complete 18-second fixture fit the declared 500-character budget')
  assert.deepEqual(splitScriptUnits(screenplay).map(unit => unit.id), [1, 2, 3, 4])
  const { session, result } = stageAll(f, candidates)
  assert.equal('error' in result, false)
  assert.deepEqual(f.snapshot(), before, 'Staging never replaces the old draft')
  assert.deepEqual(candidates, original)
  assert.deepEqual(session.getReport().candidates.map(({ id: _id, storyboardId: _storyboardId, shotNumber: _shotNumber, ...candidate }) => candidate), original)
  const finished = await session.finish()
  assert.equal(finished.saved, 2)
  assert.deepEqual(finished.issues.filter(issue => issue.severity === 'error'), [])
  const stored = f.rows()
  const fields = { title: 'title', time: 'time', location: 'location', shot_type: 'shotType', angle: 'angle', movement: 'movement',
    description: 'description', result: 'result', atmosphere: 'atmosphere', image_prompt: 'imagePrompt', video_prompt: 'videoPrompt',
    bgm_prompt: 'bgmPrompt', sound_effect: 'soundEffect', duration: 'duration', scene_id: 'sceneId' } as const
  for (const [index, row] of stored.entries()) {
    for (const [source, destination] of Object.entries(fields)) assert.equal((row as any)[destination], (original[index] as any)[source], source)
    assert.equal((row.description!.match(/【镜头\d+】/g) || []).length, 2)
    assert.equal(row.videoPrompt!.includes('情绪'), false, 'The session does not manufacture legacy emotion fields or voice templates')
    assert.deepEqual(db.select().from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, row.id)).all(), [{ storyboardId: row.id, characterId: f.character.id }])
    assert.deepEqual(db.select().from(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, row.id)).all(), [{ storyboardId: row.id, propId: f.prop.id }])
    assert.equal(Object.hasOwn(row, 'time_row_counts'), false)
    assert.equal(Object.hasOwn(row, 'source_ids'), false)
  }
})

test('pure action source units can commit without manufacturing dialogue to satisfy complete coverage', async () => {
  const f = fixture(`动作：${'静'.repeat(148)}`)
  const candidates = [f.candidate(1, ''), f.candidate(2, '')].map(candidate => ({ ...candidate, source_ids: [1] }))
  const { session, result } = stageAll(f, candidates)
  assert.equal('error' in result, false)
  const finished = await session.finish()
  assert.equal(finished.saved, 2)
  assert.equal(finished.issues.some(issue => issue.code === 'dialogue_coverage'), false)
  assert.ok(f.rows().every(row => !row.description?.includes('说：') && !row.videoPrompt?.includes('「')))
})

test('prompt mode persists only video_prompt while its time-row mapping remains internal and all other fields stay unchanged', async () => {
  const f = fixture(), before = f.snapshot(), session = f.session({ mode: 'prompt', storyboardIds: [f.old[0].id] })
  const replacement = f.candidate(1).video_prompt!
  const staged = session.stageUpdate(f.old[0].id, { video_prompt: replacement, time_row_counts: [1, 2] })
  assert.equal('error' in staged, false)
  assert.deepEqual(f.snapshot(), before)
  assert.deepEqual(session.getReport().candidates[0].time_row_counts, [1, 2])
  const finished = await session.finish()
  assert.equal(finished.saved, 1)
  const after = f.snapshot()
  assert.equal(after.storyboards[0].videoPrompt, replacement)
  assert.notEqual(after.storyboards[0].updatedAt, before.storyboards[0].updatedAt)
  const { videoPrompt: _beforePrompt, updatedAt: _beforeUpdated, ...beforeRow } = before.storyboards[0]
  const { videoPrompt: _afterPrompt, updatedAt: _afterUpdated, ...afterRow } = after.storyboards[0]
  assert.deepEqual(afterRow, beforeRow)
  assert.deepEqual(after.storyboards[1], before.storyboards[1])
  assert.deepEqual(after.characters, before.characters)
  assert.deepEqual(after.props, before.props)
  assert.deepEqual(after.episode, before.episode)
  for (const fields of [{ result: 'overwritten' }, { duration: 12 }, { source_ids: [1] }]) {
    const guarded = f.session({ mode: 'prompt', storyboardIds: [f.old[0].id] }), current = f.snapshot()
    const rejected = guarded.stageUpdate(f.old[0].id, { video_prompt: replacement, ...fields })
    assert.ok(rejected.issues.some(issue => issue.code === 'prompt_fields_only'))
    assert.equal((await guarded.finish()).saved, 0)
    assert.deepEqual(f.snapshot(), current)
  }
})

test('missing original skill fields are concrete errors and never replaced with inferred defaults', async () => {
  for (const field of ['time', 'location', 'result', 'image_prompt', 'bgm_prompt', 'sound_effect'] as const) {
    const f = fixture(), before = f.snapshot(), candidate = f.candidate(1)
    delete candidate[field]
    const { session, result } = stageAll(f, [candidate, f.candidate(2)])
    assert.ok(result.issues.some(issue => issue.code === 'skill_field_missing' && issue.field === field && issue.severity === 'error'))
    const finished = await session.finish()
    assert.equal(finished.saved, 0)
    assert.deepEqual(f.snapshot(), before)
    assert.equal(session.getReport().candidates[0][field], undefined)
  }
})

test('source coverage includes action units even when all exact original dialogue is already present', async () => {
  const f = fixture(), before = f.snapshot(), second = { ...f.candidate(2), source_ids: [4] }
  const { session } = stageAll(f, [f.candidate(1), second])
  const result = await session.finish()
  assert.equal(result.saved, 0)
  assert.ok(result.issues.some(issue => issue.code === 'source_coverage' && issue.field === 'source_ids' && issue.severity === 'error' && issue.message.includes('第3段')))
  assert.equal(result.issues.some(issue => issue.code === 'dialogue_coverage'), false)
  assert.deepEqual(f.snapshot(), before)
})

test('changed punctuation, omitted, repeated or reordered original dialogue blocks whole-episode commit', async () => {
  for (const variant of ['punctuation', 'missing', 'duplicate', 'order']) {
    const f = fixture(), before = f.snapshot()
    const values = variant === 'punctuation' ? [speeches[0].replace('。', '！'), speeches[1]]
      : variant === 'missing' ? ['', speeches[1]] : variant === 'duplicate' ? [speeches[0], speeches[0]] : [speeches[1], speeches[0]]
    const { session, result: staged } = stageAll(f, [f.candidate(1, values[0]), f.candidate(2, values[1])])
    assert.equal('error' in staged, false, 'Each local description/prompt agrees; only the authoritative script reveals the coverage error')
    const result = await session.finish()
    assert.equal(result.saved, 0)
    assert.ok(result.issues.some(issue => issue.code === 'dialogue_coverage' && issue.severity === 'error'), variant)
    assert.deepEqual(f.snapshot(), before)
  }
})

test('the screenplay body 500-character target is a hard plus-or-minus twenty-percent constraint (upper bound: under 1 s tolerance, round 3)', async () => {
  // Candidates total 18 s. 125 chars: bounds 12–18 s. 124: max 17.86 s, 0.14 s over -> accepted since round 3 (user-approved
  // <1 s tolerance). 119: max 17.14 s, 0.86 s over -> accepted. 118: max 16.99 s, 1.01 s over -> still a conflict.
  // 150: inside. 188: lower bound 18.05 s, under it -> still a conflict (the lower bound has no tolerance).
  for (const [characters, allowed] of [[125, true], [124, true], [119, true], [118, false], [150, true], [188, false]] as const) {
    const f = fixture(`动作：${'静'.repeat(characters)}`), before = f.snapshot()
    const candidates = [f.candidate(1, ''), f.candidate(2, '')].map(candidate => ({ ...candidate, source_ids: [1] }))
    const { session, result: staged } = stageAll(f, candidates)
    assert.equal('error' in staged, false)
    const result = await session.finish()
    assert.equal(result.saved, allowed ? 2 : 0)
    if (!allowed) {
      assert.ok(result.issues.some(issue => issue.code === 'duration_total_conflict' && issue.field === 'duration' && issue.severity === 'error' && issue.message.includes('总时长18秒')))
      assert.deepEqual(f.snapshot(), before)
    } else assert.equal(result.issues.some(issue => issue.code === 'duration_total_conflict'), false)
  }
})

test('concurrent storyboard or screenplay edits during final save are preserved instead of overwritten', async () => {
  for (const target of ['storyboard', 'script']) {
    const f = fixture()
    let edited: ReturnType<typeof f.snapshot> | undefined
    const session = f.session({ onPhase: phase => {
      if (phase !== 'saving') return
      if (target === 'storyboard') db.update(schema.storyboards).set({ description: '用户在保存前手工改过的分镜正文。' }).where(eq(schema.storyboards.id, f.old[0].id)).run()
      else db.update(schema.episodes).set({ scriptContent: `${screenplay}\n动作：用户手工添加结尾。` }).where(eq(schema.episodes.id, f.episode.id)).run()
      edited = f.snapshot()
    } })
    const staged = session.stageSave([f.candidate(1), f.candidate(2)], { replaceExisting: true, isFinalBatch: true })
    assert.equal('error' in staged, false)
    const result = await session.finish()
    assert.equal(result.saved, 0)
    assert.ok(result.issues.some(issue => issue.code === 'concurrent_edit' && issue.severity === 'error'))
    assert.ok(edited)
    assert.deepEqual(f.snapshot(), edited)
  }
})
