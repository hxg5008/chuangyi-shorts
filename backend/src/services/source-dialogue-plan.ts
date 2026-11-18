import { z } from 'zod'
import { videoPromptPlanSchema, type VideoPromptPlan } from './video-prompt-plan.js'
import type { buildDialogueTimingGuide } from './first-pass-instructions.js'
import type { ValidationIssue } from './storyboard-validation.js'

// Reuse the resolved protocol's exact voice, line and optional-null rules. The
// source form is an alternative tool input, never a provider-facing protocol.
const resolvedShot = videoPromptPlanSchema.shape.shots.element
const resolvedRow = resolvedShot.shape.rows.element
const legacyDialogue = resolvedRow.shape.dialogue.unwrap().in.unwrap().element
const sourceDialogue = z.object({
  source_line: z.number().int().positive(),
  fragment_index: z.number().int().positive(),
  voice: legacyDialogue.shape.voice,
  spoken_seconds: legacyDialogue.shape.spoken_seconds,
  voice_reference: legacyDialogue.shape.voice_reference,
}).strict()
const inputRow = resolvedRow.extend({
  dialogue: z.array(z.union([sourceDialogue, legacyDialogue])).max(12)
    .nullable().transform(value => value ?? undefined).optional(),
}).strict()
const inputShot = resolvedShot.extend({ rows: z.array(inputRow).min(1).max(2) }).strict()

export const videoPromptPlanInputSchema = videoPromptPlanSchema.extend({
  shots: z.array(inputShot).min(2).max(4),
}).strip()
export type VideoPromptPlanInput = z.output<typeof videoPromptPlanInputSchema>
export interface SourceDialogueRef { source_line: number; fragment_index: number }
/** Exact resolved positions of genuine source entries, never accepted from tool input. */
export interface SourceDialogueSlot extends SourceDialogueRef { shotNumber: number; rowIndex: number; dialogueIndex: number }
export interface SourceDialoguePlanResult {
  plan: VideoPromptPlan | null
  hasSourceEntries: boolean
  hasLegacyDialogue: boolean
  sourceRefs: SourceDialogueRef[]
  sourceSlots: SourceDialogueSlot[]
  issues: ValidationIssue[]
}

/** Resolve only trusted guide identities and verbatim fragments; never infer a speaker or rewrite speech. */
export function resolveSourceDialoguePlan(input: unknown, guide: ReturnType<typeof buildDialogueTimingGuide>): SourceDialoguePlanResult {
  const result: SourceDialoguePlanResult = { plan: null, hasSourceEntries: false, hasLegacyDialogue: false, sourceRefs: [], sourceSlots: [], issues: [] }
  const issue = (field: string, code: string, message: string) => result.issues.push({ field, code, message, severity: 'error' })
  const parsed = videoPromptPlanInputSchema.safeParse(input)
  if (!parsed.success) {
    for (const error of parsed.error.issues) issue(`video_prompt_plan.${error.path.join('.')}`, 'source_plan_schema', `视频计划输入字段不完整或类型无效：${error.path.join('.')} (${error.message})`)
    return result
  }
  const sources = new Map(guide.map(line => [line.source_line, line]))
  let previous: SourceDialogueRef | undefined
  const shots = parsed.data.shots.map((shot, shotIndex) => ({ ...shot,
    rows: shot.rows.map((row, rowIndex) => ({ ...row,
      dialogue: row.dialogue?.map((speech, speechIndex) => {
        if (!('source_line' in speech)) { result.hasLegacyDialogue = true; return speech }
        result.hasSourceEntries = true
        const ref = { source_line: speech.source_line, fragment_index: speech.fragment_index }
        result.sourceRefs.push(ref)
        const field = `video_prompt_plan.shots.${shotIndex}.rows.${rowIndex}.dialogue.${speechIndex}`
        if (previous && (ref.source_line < previous.source_line
          || ref.source_line === previous.source_line && ref.fragment_index <= previous.fragment_index)) {
          issue(field, 'source_order', '同一计划的原文片段不能重复或逆序；请按source_line和fragment_index的原始顺序安排，不自动重排。')
        }
        previous = ref
        const source = sources.get(ref.source_line)
        if (!source) { issue(field, 'source_unknown_line', `source_line ${ref.source_line} 不在可信对白索引中。`); return undefined }
        const text = source.fragments[ref.fragment_index - 1]
        if (typeof text !== 'string' || !text.trim()) { issue(field, 'source_unknown_fragment', `source_line ${ref.source_line} 没有fragment_index ${ref.fragment_index}。`); return undefined }
        result.sourceSlots.push({ ...ref, shotNumber: shot.shot_number, rowIndex, dialogueIndex: speechIndex })
        return {
          ...(source.character_id !== undefined ? { speaker_id: source.character_id } : {}),
          kind: source.kind, text, voice: speech.voice,
          ...(speech.spoken_seconds !== undefined ? { spoken_seconds: speech.spoken_seconds } : {}),
          ...(speech.voice_reference !== undefined ? { voice_reference: speech.voice_reference } : {}),
        }
      }).filter((speech): speech is NonNullable<typeof speech> => speech !== undefined),
    })),
  }))
  if (result.issues.length) return result
  const resolved = videoPromptPlanSchema.safeParse({ ...parsed.data, shots })
  if (!resolved.success) {
    for (const error of resolved.error.issues) issue(`video_prompt_plan.${error.path.join('.')}`, 'source_resolved_schema', `可信原文片段无法组成有效的严格视频计划：${error.path.join('.')} (${error.message})`)
    return result
  }
  result.plan = resolved.data
  return result
}
