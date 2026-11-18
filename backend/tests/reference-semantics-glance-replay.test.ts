import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { isReferencedTargetOnly } from '../src/services/reference-semantics.ts'
import { resolveSourceDialoguePlan } from '../src/services/source-dialogue-plan.ts'
import { renderVideoPromptPlan } from '../src/services/video-prompt-plan.ts'
import { validateStoryboard, type StoryboardValidationInput } from '../src/services/storyboard-validation.ts'

// Only the second real shadow snapshot reached group fourteen. This fixture
// retains its complete candidate and trusted referenced guide line; no script,
// credentials, media URLs, production database or network is read by the tests.
const artifact = JSON.parse(await fs.readFile(new URL('./fixtures/storyboard-glance-zg0duw.json', import.meta.url), 'utf8'))
function replayCandidate(candidate: any) {
  const resolved = resolveSourceDialoguePlan(candidate.video_prompt_plan, artifact.guide)
  assert.deepEqual(resolved.issues, [])
  assert.ok(resolved.plan)
  const trustedSourceDialogueSlots = artifact.sourceAllowsOffscreenDialogue ? resolved.sourceSlots.filter(slot => {
    const shot = resolved.plan!.shots.find(shot => shot.shot_number === slot.shotNumber)
    const speech = shot?.rows[slot.rowIndex]?.dialogue?.[slot.dialogueIndex]
    return speech?.kind === 'dialogue' && speech.speaker_id !== undefined
      && candidate.character_ids.includes(speech.speaker_id)
      && !shot!.characters.some(character => character.character_id === speech.speaker_id && character.visibility !== 'offscreen')
  }) : []
  const rendered = renderVideoPromptPlan(resolved.plan, {
    duration: candidate.duration, characters: artifact.characters, scenes: artifact.scenes, props: artifact.props,
    characterIds: candidate.character_ids, sceneId: candidate.scene_id, propIds: candidate.prop_ids,
    language: 'zh', trustedSourceDialogueSlots,
  })
  const validation: StoryboardValidationInput = {
    shotNumber: candidate.shot_number, duration: candidate.duration, description: candidate.description, videoPrompt: rendered.prompt,
    characters: artifact.characters, scenes: artifact.scenes, props: artifact.props,
    characterIds: candidate.character_ids, sceneId: candidate.scene_id, propIds: candidate.prop_ids,
    shotParticipants: rendered.participants,
  }
  return { rendered, validation }
}

test('the complete zg0DUw group-fourteen snapshot resolves, renders and validates without picturing its plain-name gaze target', () => {
  assert.equal(artifact.replays.length, 1)
  assert.equal(artifact.replays[0].snapshot, 'rejected-candidate-2')
  assert.deepEqual(artifact.guide.map((source: any) => source.source_line), [14])
  const before = JSON.stringify(artifact)
  const father = artifact.characters.find((character: any) => character.id === 10)
  assert.ok(father)
  for (const replay of artifact.replays) {
    const candidate = replay.candidate
    assert.equal(candidate.shot_number, 14)
    assert.ok(candidate.video_prompt_plan.shots.every((shot: any) => !shot.characters.some((person: any) => person.character_id === 10)))
    const { rendered, validation } = replayCandidate(candidate)
    assert.deepEqual(rendered.issues.filter(issue => issue.severity === 'error'), [], replay.snapshot)
    assert.deepEqual(validateStoryboard(validation).filter(issue => issue.severity === 'error'), [], replay.snapshot)
    assert.ok(!rendered.participants.some(person => person.characterId === 10))
    assert.ok(!rendered.prompt.split('\n')[0].includes(`@${father.name}`))
  }
  assert.equal(JSON.stringify(artifact), before)
})

test('removing a genuinely visible observer emotion percentage in the same complete snapshot still hard-fails', () => {
  for (const replay of artifact.replays) {
    const candidate = replay.candidate
    const firstShot = candidate.video_prompt_plan.shots[0]
    const observer = firstShot.characters.find((person: any) => person.visibility === 'face_visible')
    const name = artifact.characters.find((character: any) => character.id === observer.character_id).name
    const { validation } = replayCandidate(candidate)
    const lines = validation.videoPrompt.split('\n')
    for (let row = 1; row <= firstShot.rows.length; row++) lines[row] = lines[row].replace(/\d+(?:\.\d+)?\s*[%％]/g, '')
    const issues = validateStoryboard({ ...validation, videoPrompt: lines.join('\n') })
    assert.ok(issues.some(issue => issue.code === 'emotion_percentage' && issue.severity === 'error' && issue.message.includes(name)))
  }
})

test('ordinary glance and sweep gaze roots accept static qualified targets with marked or plain names', () => {
  const name = '高大山'
  for (const marker of ['@', '']) for (const verb of ['瞟向', '扫向', '扫过', '瞄向']) {
    const visual = `他的眼睛先${verb}床右侧的${marker}${name}方向，喉头短促滚动。`
    assert.equal(isReferencedTargetOnly(visual, visual.indexOf(marker + name), name.length, marker.length), true, `${verb}, marker ${marker.length}`)
  }
  const actual = '眼睛先瞟向高大山方向又急急转回母亲脸上，喉头滚动。'
  assert.equal(isReferencedTargetOnly(actual, actual.indexOf(name), name.length, 0), true)
})

test('glance roots cannot exempt a target own acting, explicitly named following actor or pictured face', () => {
  const name = '高大山'
  for (const marker of ['@', '']) for (const verb of ['瞟向', '扫向', '扫过', '瞄向']) {
    for (const suffix of ['正眨眼', '表情变化', '抬手回应', '的双眼正眨动', '的面部清晰可见', '的正脸特写',
      '，后者正眨眼', '，后者表情变化', '，后者抬手', '，对方抬手']) {
      const visual = `他的眼睛先${verb}床右侧的${marker}${name}${suffix}。`
      assert.equal(isReferencedTargetOnly(visual, visual.indexOf(marker + name), name.length, marker.length), false, `${verb}: ${suffix}`)
    }
  }
})

test('a camera sweeping over someone is pictured framing rather than a person gaze exemption', () => {
  const name = '高大山'
  for (const marker of ['@', '']) for (const camera of ['镜头', '摄影机']) {
    const visual = `${camera}扫过${marker}${name}。`
    assert.equal(isReferencedTargetOnly(visual, visual.indexOf(marker + name), name.length, marker.length), false, camera)
  }
})
