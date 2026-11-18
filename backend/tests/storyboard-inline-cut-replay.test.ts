import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { compileScheduledSegment } from '../src/services/scheduled-storyboard-segment.ts'
import { resolveSourceDialoguePlan } from '../src/services/source-dialogue-plan.ts'
import { renderVideoPromptPlan } from '../src/services/video-prompt-plan.ts'
import { cameraCuts } from '../src/services/camera-cuts.ts'
import { validateStoryboard } from '../src/services/storyboard-validation.ts'

// Complete group-seven projections from the two isolated shadow snapshots;
// their referenced guide line was derived once from that shadow DB read-only.
// Runtime tests read no database, complete script, credential, URL or API.
const artifact = JSON.parse(await fs.readFile(new URL('./fixtures/storyboard-inline-cut-sy5rl6.json', import.meta.url), 'utf8'))
function creativeInput(candidate: any) {
  const input: any = { title: candidate.title, scene_id: candidate.scene_id, prop_ids: structuredClone(candidate.prop_ids),
    atmosphere: candidate.atmosphere, space: candidate.video_prompt_plan.space }
  candidate.video_prompt_plan.shots.forEach((shot: any, index: number) => {
    const voices = shot.rows.flatMap((row: any) => (row.dialogue || []).map((speech: any) => speech.voice))
    voices.forEach((profile: any) => assert.deepEqual(profile, voices[0], 'retain the real per-shot voice profile'))
    input[`shot_${index + 1}`] = { characters: structuredClone(shot.characters), visuals: shot.rows.map((row: any) => row.visual),
      ...(voices.length ? { voice: structuredClone(voices[0]) } : {}) }
  })
  return input
}

test('both complete SY5RL6 snapshots become three exact three-second shots without changing any source, voice or visual', () => {
  assert.equal(artifact.replays.length, 2)
  assert.deepEqual(artifact.guide.map((source: any) => source.source_line), [7])
  const before = JSON.stringify(artifact)
  for (const replay of artifact.replays) {
    const original = replay.candidate
    assert.deepEqual(original.video_prompt_plan.shots.map((shot: any) => shot.rows.length), [1, 2])
    const originalRows = original.video_prompt_plan.shots.flatMap((shot: any) => shot.rows)
    const compiled = compileScheduledSegment(creativeInput(original), artifact.group, artifact.guide, artifact)
    const plan = compiled.video_prompt_plan!
    assert.equal(compiled.shot_number, 7)
    assert.equal(compiled.duration, 9)
    assert.equal(plan.space, original.video_prompt_plan.space)
    assert.deepEqual(plan.shots.map(shot => shot.shot_number), [1, 2, 3])
    assert.deepEqual(plan.shots.map(shot => shot.rows.length), [1, 1, 1])
    assert.deepEqual(plan.shots.flatMap(shot => shot.rows), originalRows, 'visuals, canonical slots, spoken timing and voice profiles are untouched')
    assert.ok(original.character_ids.every((id: number) => compiled.character_ids!.includes(id)), 'copied gaze declarations never remove outer bindings')
    const resolved = resolveSourceDialoguePlan(plan, artifact.guide)
    assert.deepEqual(resolved.issues, [])
    assert.ok(resolved.plan)
    const trustedSourceDialogueSlots = artifact.sourceAllowsOffscreenDialogue ? resolved.sourceSlots.filter(slot => {
      const shot = resolved.plan!.shots.find(shot => shot.shot_number === slot.shotNumber)
      const speech = shot?.rows[slot.rowIndex]?.dialogue?.[slot.dialogueIndex]
      return speech?.kind === 'dialogue' && speech.speaker_id !== undefined && compiled.character_ids!.includes(speech.speaker_id)
        && !shot!.characters.some(person => person.character_id === speech.speaker_id && person.visibility !== 'offscreen')
    }) : []
    const rendered = renderVideoPromptPlan(resolved.plan, { duration: compiled.duration!, characters: artifact.characters,
      scenes: artifact.scenes, props: artifact.props, characterIds: compiled.character_ids!, sceneId: compiled.scene_id,
      propIds: compiled.prop_ids!, language: 'zh', trustedSourceDialogueSlots })
    assert.deepEqual(rendered.issues.filter(issue => issue.severity === 'error'), [], replay.snapshot)
    assert.ok(rendered.issues.some(issue => issue.code === 'camera_continuity_review' && issue.severity === 'warning'), 'the conflicting continuity prefix stays visible for editorial review')
    const rows = rendered.prompt.split('\n').slice(1)
    assert.deepEqual(rows.map(row => row.match(/^(\d+)-(\d+)秒/)?.slice(1).map(Number)), [[0, 3], [3, 6], [6, 9]])
    assert.deepEqual(rows.map(row => cameraCuts(row).length), [0, 1, 1], 'an existing inline cut receives no extra renderer prefix')
    originalRows.forEach((row: any, index: number) => assert.ok(rows[index].includes(row.visual), 'each original creative row is preserved verbatim'))

    // This structural replay description uses only the already resolved trusted
    // speech identity and words; it invents no source kind, speaker or dialogue.
    const description = resolved.plan.shots.map(shot => `【镜头${shot.shot_number}】` + shot.rows.map(row => row.visual
      + (row.dialogue || []).map(speech => {
        const speaker = artifact.characters.find((person: any) => person.id === speech.speaker_id)?.name || ''
        const label = speech.kind === 'dialogue' ? `${speaker}说` : speech.kind === 'offscreen' ? `${speaker}画外音` : '旁白'
        return `${label}：「${speech.text}」`
      }).join('')).join('')).join('')
    const issues = validateStoryboard({ shotNumber: compiled.shot_number, duration: compiled.duration!, description, videoPrompt: rendered.prompt,
      characters: artifact.characters, scenes: artifact.scenes, props: artifact.props, characterIds: compiled.character_ids,
      sceneId: compiled.scene_id, propIds: compiled.prop_ids, shotParticipants: rendered.participants })
    assert.deepEqual(issues.filter(issue => issue.severity === 'error'), [], replay.snapshot)
  }
  assert.equal(JSON.stringify(artifact), before)
})
