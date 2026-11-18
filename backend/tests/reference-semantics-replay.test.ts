import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { isReferencedTargetOnly } from '../src/services/reference-semantics.ts'
import { validateStoryboard, type StoryboardValidationInput } from '../src/services/storyboard-validation.ts'

// A credential-free projection of both rejected fourth-group candidates from
// the real shadow run. Replaying this never reads a runtime database or model.
const artifact = JSON.parse(await fs.readFile(new URL('./fixtures/storyboard-gaze-jw9j3k.json', import.meta.url), 'utf8'))
function validationInput(candidate: any): StoryboardValidationInput {
  return {
    shotNumber: candidate.shot_number, duration: candidate.duration,
    description: candidate.description, videoPrompt: candidate.video_prompt,
    characters: artifact.characters, scenes: artifact.scenes, props: artifact.props,
    characterIds: candidate.character_ids, sceneId: candidate.scene_id, propIds: candidate.prop_ids,
    shotParticipants: candidate.video_prompt_plan.shots.flatMap((shot: any) => shot.characters.map((person: any) => ({
      shotNumber: shot.shot_number, characterId: person.character_id, visibility: person.visibility,
    }))),
  }
}

test('both complete Jw9J3K candidate snapshots pass without assigning observer expressions to a qualified gaze target', () => {
  assert.equal(artifact.replays.length, 2)
  for (const replay of artifact.replays) {
    const candidate = replay.candidate
    assert.deepEqual(candidate.video_prompt_plan.shots[0].characters.map((person: any) => person.character_id), [8])
    const visual = candidate.video_prompt_plan.shots[0].rows[0].visual
    const position = visual.indexOf('@老年张晓茹')
    assert.ok(position >= 0)
    assert.equal(isReferencedTargetOnly(visual, position, '老年张晓茹'.length), true, replay.snapshot)
    const issues = validateStoryboard(validationInput(candidate))
    assert.deepEqual(issues.filter(issue => issue.severity === 'error'), [], replay.snapshot)
  }
})

test('a planned visible observer in the same full artifact still requires its own emotion percentage', () => {
  for (const replay of artifact.replays) {
    const input = validationInput(replay.candidate)
    const lines = input.videoPrompt.split('\n')
    lines[1] = lines[1].replace(/\d+(?:\.\d+)?\s*[%％]/g, '')
    const issues = validateStoryboard({ ...input, videoPrompt: lines.join('\n') })
    assert.ok(issues.some(issue => issue.code === 'emotion_percentage' && issue.severity === 'error' && issue.message.includes('老年高大山')), replay.snapshot)
  }
})

test('the shared matcher keeps marker offsets consistent and does not exempt the target own visible acting', () => {
  for (const marker of ['@', '']) {
    const name = '老年张晓茹'
    const pure = `他先追视床侧的${marker}${name}，眼睑一颤，眉心拧紧。`
    assert.equal(isReferencedTargetOnly(pure, pure.indexOf(marker + name), name.length, marker.length), true)
    for (const action of ['正眨眼', '表情变化', '的双眼正眨动', '的眼睑一颤', '正面近景，抬手回应']) {
      const visible = `他先追视床侧的${marker}${name}${action}。`
      assert.equal(isReferencedTargetOnly(visible, visible.indexOf(marker + name), name.length, marker.length), false, action)
    }
  }
})

test('the JrEOIj steady stare direction remains a single static target with either reference marker style', () => {
  const name = '老年张晓茹'
  for (const marker of ['@', '']) for (const verb of ['盯向', '盯住']) {
    const visual = `浑浊双眼死死${verb}床右侧的${marker}${name}，眼睑因用力而绷紧。`
    assert.equal(isReferencedTargetOnly(visual, visual.indexOf(marker + name), name.length, marker.length), true, `${verb}, marker length ${marker.length}`)
  }
})

test('stare roots never authorize a target own acting, visible face or explicit camera framing', () => {
  const name = '老年张晓茹'
  for (const marker of ['@', '']) for (const verb of ['盯向', '盯住']) {
    for (const suffix of ['正眨眼', '表情变化', '抬手回应', '站在窗前', '的双眼正眨动', '的眼睑一颤', '的面部清晰可见', '的正脸特写', '正面近景']) {
      const visual = `浑浊双眼死死${verb}床右侧的${marker}${name}${suffix}。`
      assert.equal(isReferencedTargetOnly(visual, visual.indexOf(marker + name), name.length, marker.length), false, `${verb}, ${suffix}, marker length ${marker.length}`)
    }
    for (const qualifier of ['特写中的', '镜头里的', '清晰入镜的']) {
      const visual = `浑浊双眼死死${verb}${qualifier}${marker}${name}。`
      assert.equal(isReferencedTargetOnly(visual, visual.indexOf(marker + name), name.length, marker.length), false, qualifier)
    }
  }
})
