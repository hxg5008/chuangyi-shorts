import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { isReferencedTargetOnly } from '../src/services/reference-semantics.ts'
import { compileScheduledSegment } from '../src/services/scheduled-storyboard-segment.ts'
import { resolveSourceDialoguePlan } from '../src/services/source-dialogue-plan.ts'
import { renderVideoPromptPlan, type VideoPromptPlan } from '../src/services/video-prompt-plan.ts'
import { validateStoryboard } from '../src/services/storyboard-validation.ts'

// Both complete group-two snapshots and only their referenced canonical source
// were projected from the isolated read-only shadow DB. Runtime tests use no DB,
// model, credentials, media URLs or complete episode script.
const artifact = JSON.parse(await fs.readFile(new URL('./fixtures/storyboard-direction-pq1gpw.json', import.meta.url), 'utf8'))
function compileSnapshot(candidate: any) {
  const input: any = { title: candidate.title, scene_id: candidate.scene_id, prop_ids: structuredClone(candidate.prop_ids),
    atmosphere: candidate.atmosphere, space: candidate.video_prompt_plan.space }
  candidate.video_prompt_plan.shots.forEach((shot: any, index: number) => {
    const voices = shot.rows.flatMap((row: any) => (row.dialogue || []).map((speech: any) => speech.voice))
    voices.forEach((profile: any) => assert.deepEqual(profile, voices[0], 'reuse the unchanged real per-shot profile'))
    input[`shot_${index + 1}`] = { characters: structuredClone(shot.characters), visuals: shot.rows.map((row: any) => row.visual),
      ...(voices.length ? { voice: structuredClone(voices[0]) } : {}) }
  })
  return compileScheduledSegment(input, artifact.group, artifact.guide, artifact)
}
function renderResolved(plan: VideoPromptPlan, candidate: any, sourceSlots: Array<{ shotNumber: number; rowIndex: number; dialogueIndex: number }>) {
  const trustedSourceDialogueSlots = artifact.sourceAllowsOffscreenDialogue ? sourceSlots.filter(slot => {
    const shot = plan.shots.find(shot => shot.shot_number === slot.shotNumber)
    const speech = shot?.rows[slot.rowIndex]?.dialogue?.[slot.dialogueIndex]
    return speech?.kind === 'dialogue' && speech.speaker_id !== undefined && candidate.character_ids.includes(speech.speaker_id)
      && !shot!.characters.some(person => person.character_id === speech.speaker_id && person.visibility !== 'offscreen')
  }) : []
  return renderVideoPromptPlan(plan, { duration: candidate.duration, characters: artifact.characters, scenes: artifact.scenes, props: artifact.props,
    characterIds: candidate.character_ids, sceneId: candidate.scene_id, propIds: candidate.prop_ids, language: 'zh', trustedSourceDialogueSlots })
}

test('both complete pQ1GpW group-two snapshots compile, resolve, render and validate without adding their first-shot gaze target', () => {
  assert.equal(artifact.replays.length, 2)
  assert.deepEqual(artifact.guide.map((source: any) => source.source_line), [2])
  const before = JSON.stringify(artifact)
  for (const replay of artifact.replays) {
    const original = replay.candidate
    assert.equal(original.shot_number, 2)
    assert.deepEqual(original.video_prompt_plan.shots[0].characters.map((person: any) => person.character_id), [9])
    const compiled = compileSnapshot(original)
    assert.deepEqual(compiled.video_prompt_plan, original.video_prompt_plan)
    const resolved = resolveSourceDialoguePlan(compiled.video_prompt_plan, artifact.guide)
    assert.deepEqual(resolved.issues, [])
    assert.ok(resolved.plan)
    const rendered = renderResolved(resolved.plan, compiled, resolved.sourceSlots)
    assert.deepEqual(rendered.issues.filter(issue => issue.severity === 'error'), [], replay.snapshot)
    assert.ok(!rendered.participants.some(person => person.shotNumber === 1 && person.characterId === 8))
    assert.ok(rendered.participants.some(person => person.shotNumber === 2 && person.characterId === 8), 'the later genuinely pictured person stays declared')
    const issues = validateStoryboard({ shotNumber: compiled.shot_number, duration: compiled.duration!, description: original.description,
      videoPrompt: rendered.prompt, characters: artifact.characters, scenes: artifact.scenes, props: artifact.props,
      characterIds: compiled.character_ids, sceneId: compiled.scene_id, propIds: compiled.prop_ids, shotParticipants: rendered.participants })
    assert.deepEqual(issues.filter(issue => issue.severity === 'error'), [], replay.snapshot)
  }
  assert.equal(JSON.stringify(artifact), before)
})

test('the same complete plan still rejects actual target acting, body actions, visible faces and camera framing', () => {
  const candidate = artifact.replays[0].candidate
  const resolved = resolveSourceDialoguePlan(candidate.video_prompt_plan, artifact.guide)
  assert.ok(resolved.plan)
  const target = artifact.characters.find((person: any) => person.id === 8).name
  const observer = artifact.characters.find((person: any) => person.id === 9).name
  for (const visual of [
    `@${observer}正面近景，视线落到@${target}表情变化的脸上。`,
    `@${observer}正面近景，视线落到@${target}抬手的动作上。`,
    `@${observer}正面近景，视线落到@${target}的面部清晰入镜。`,
    `@${observer}正面近景，视线落到@${target}的正脸特写。`,
    `镜头移动到@${target}正面近景。`,
  ]) {
    const plan = structuredClone(resolved.plan)
    plan.shots[0].rows[0].visual = visual
    const rendered = renderResolved(plan, candidate, resolved.sourceSlots)
    assert.equal(rendered.prompt, '')
    assert.ok(rendered.issues.some(issue => issue.code === 'plan_visual_participant' && issue.severity === 'error'))
  }
})

test('explicit sensory leads share finite direction complements with marked and plain static targets', () => {
  const name = '老年高大山'
  for (const marker of ['@', '']) for (const lead of ['视线落到', '目光投向', '眼神停在', '抬眼望向', '垂眼扫过',
    '视线转回', '目光掠过', '目光移到', '视线移向', '眼神落在', '视线移回', '目光从水杯转到', '他瞪向', '他看了']) {
    const visual = `${lead}床右侧的${marker}${name}脸上，轻眨一下，眉心微松。`
    assert.equal(isReferencedTargetOnly(visual, visual.indexOf(marker + name), name.length, marker.length), true, `${lead}, marker ${marker.length}`)
  }
})

test('sensory direction grammar never exempts the target own acting, following actor or a visible camera subject', () => {
  const name = '老年高大山'
  for (const marker of ['@', '']) for (const lead of ['视线落到', '抬眼望向', '垂眼扫过']) {
    for (const suffix of ['正眨眼', '表情变化', '抬手', '的双眼正眨动', '的正脸清晰入镜', '的正脸特写', '，后者抬手']) {
      const visual = `${lead}床右侧的${marker}${name}${suffix}。`
      assert.equal(isReferencedTargetOnly(visual, visual.indexOf(marker + name), name.length, marker.length), false, `${lead}: ${suffix}`)
    }
    const framed = `${lead}特写中的${marker}${name}脸上。`
    assert.equal(isReferencedTargetOnly(framed, framed.indexOf(marker + name), name.length, marker.length), false)
  }
})

test('ordinary physical or camera movement cannot qualify as sensory direction grammar', () => {
  const name = '老年高大山'
  for (const marker of ['@', '']) for (const lead of ['他移动到', '他走向', '他跑到', '镜头移动到', '摄影机转到', '画面转到']) {
    const visual = `${lead}${marker}${name}身边。`
    assert.equal(isReferencedTargetOnly(visual, visual.indexOf(marker + name), name.length, marker.length), false, lead)
  }
})
