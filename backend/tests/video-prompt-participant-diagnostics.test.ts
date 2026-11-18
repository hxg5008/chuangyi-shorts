import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { resolveSourceDialoguePlan } from '../src/services/source-dialogue-plan.ts'
import { renderVideoPromptPlan, type VideoPromptPlan } from '../src/services/video-prompt-plan.ts'

// Credential-free projection: complete rejected group-seven candidates plus the
// referenced canonical source line, derived once from the isolated read-only DB.
// The runtime tests read only this fixture, never a DB, key, URL or model.
const artifact = JSON.parse(await fs.readFile(new URL('./fixtures/video-prompt-participant-quzo1f.json', import.meta.url), 'utf8'))
const hard = (result: ReturnType<typeof renderVideoPromptPlan>) => result.issues.filter(issue => issue.severity === 'error')

function renderSnapshot(candidate: any, repair = false) {
  const resolved = resolveSourceDialoguePlan(candidate.video_prompt_plan, artifact.guide)
  assert.deepEqual(resolved.issues, [])
  assert.ok(resolved.plan)
  const plan = structuredClone(resolved.plan)
  if (repair) {
    const existing = plan.shots.flatMap(shot => shot.characters).find(character => character.character_id === 8)
    assert.equal(existing?.visibility, 'face_visible')
    assert.ok(existing?.emotion?.expression && Number.isFinite(existing.emotion.intensity))
    // Reuse the artifact's real declared face/emotion facts; change no prose,
    // canonical source, speech, timing or binding to make the gate pass.
    plan.shots[0].characters.push(structuredClone(existing!))
  }
  const trustedSourceDialogueSlots = artifact.sourceAllowsOffscreenDialogue ? resolved.sourceSlots.filter(slot => {
    const shot = plan.shots.find(shot => shot.shot_number === slot.shotNumber)
    const speech = shot?.rows[slot.rowIndex]?.dialogue?.[slot.dialogueIndex]
    return speech?.kind === 'dialogue' && speech.speaker_id !== undefined
      && candidate.character_ids.includes(speech.speaker_id)
      && artifact.characters.some((character: any) => character.id === speech.speaker_id)
      && !shot!.characters.some(character => character.character_id === speech.speaker_id && character.visibility !== 'offscreen')
  }) : []
  return renderVideoPromptPlan(plan, {
    duration: candidate.duration, characters: artifact.characters, scenes: artifact.scenes, props: artifact.props,
    characterIds: candidate.character_ids, sceneId: candidate.scene_id, propIds: candidate.prop_ids,
    language: 'zh', trustedSourceDialogueSlots,
  })
}

function assertActorEightDiagnostic(issue: ReturnType<typeof hard>[number], field: string) {
  assert.equal(issue.code, 'plan_visual_participant')
  assert.equal(issue.field, field)
  assert.equal(issue.shotNumber, 1)
  assert.ok(issue.message.includes('@老年高大山'))
  assert.ok(issue.message.includes('ID 8'))
  assert.ok(issue.message.includes('子镜头 1'))
  assert.ok(issue.message.includes('video_prompt_plan.shots.0.characters'))
  assert.ok(!issue.message.includes('ID 9'))
}

test('both complete qUzo1f snapshots still hard-fail with one precise missing-ID8 diagnostic', () => {
  assert.equal(artifact.replays.length, 2)
  assert.deepEqual(artifact.guide.map((entry: any) => entry.source_line), [7])
  for (const replay of artifact.replays) {
    assert.deepEqual(replay.candidate.video_prompt_plan.shots[0].characters.map((character: any) => character.character_id), [9])
    const result = renderSnapshot(replay.candidate)
    assert.equal(result.prompt, '', replay.snapshot)
    const issues = hard(result)
    assert.equal(issues.length, 1, replay.snapshot)
    assertActorEightDiagnostic(issues[0], 'video_prompt_plan.shots.0.rows.0.visual')
  }
})

test('adding only the genuinely pictured ID8 face declaration repairs either test snapshot without changing source content', () => {
  const before = JSON.stringify(artifact)
  for (const replay of artifact.replays) {
    const result = renderSnapshot(replay.candidate, true)
    assert.deepEqual(hard(result), [], replay.snapshot)
    assert.ok(result.prompt.length > 0)
    assert.ok(result.participants.some(character => character.shotNumber === 1 && character.characterId === 8 && character.visibility === 'face_visible'))
  }
  assert.equal(JSON.stringify(artifact), before)
})

const localContext = {
  duration: 9, characters: [{ id: 8, name: '老年高大山' }, { id: 9, name: '老年张晓茹' }],
  scenes: [{ id: 4, location: '卧室' }], props: [], characterIds: [8, 9], sceneId: 4, propIds: [], language: 'zh',
}
function localPlan(visuals: [string, string]): VideoPromptPlan {
  const characters = [{ character_id: 9, visibility: 'face_visible' as const, emotion: { expression: '平静', intensity: 60 } }]
  return {
    space: '以门槛为原点A0，X轴向东，Y轴向北。',
    shots: [{ shot_number: 1, characters, rows: visuals.map(visual => ({ visual })) },
      { shot_number: 2, characters, rows: [{ visual: '@老年张晓茹放下手，固定机位。' }] }],
  }
}

test('marked and plain duplicate mentions of the same missing actor produce one issue within one row', () => {
  const result = renderVideoPromptPlan(localPlan([
    '@老年张晓茹正面近景，@老年高大山正面近景，老年高大山抬手后@老年高大山点头。',
    '@老年张晓茹保持站姿。',
  ]), localContext)
  const issues = hard(result)
  assert.equal(issues.length, 1)
  assertActorEightDiagnostic(issues[0], 'video_prompt_plan.shots.0.rows.0.visual')
})

test('the same missing actor on different rows retains a separate precise diagnostic for each row', () => {
  const result = renderVideoPromptPlan(localPlan([
    '@老年张晓茹正面近景，@老年高大山正面近景。',
    '@老年张晓茹保持站姿，老年高大山抬手。',
  ]), localContext)
  const issues = hard(result)
  assert.equal(issues.length, 2)
  issues.forEach((issue, index) => assertActorEightDiagnostic(issue, `video_prompt_plan.shots.0.rows.${index}.visual`))
})

test('an actual gaze target stays outside participant diagnostics, cast and pictured metadata', () => {
  const result = renderVideoPromptPlan(localPlan([
    '@老年张晓茹正面近景，目光投向床侧的@老年高大山。',
    '@老年张晓茹视线停在老年高大山脸上。',
  ]), localContext)
  assert.deepEqual(hard(result), [])
  assert.ok(!result.prompt.split('\n')[0].includes('@老年高大山'))
  assert.ok(!result.participants.some(character => character.characterId === 8))
})
