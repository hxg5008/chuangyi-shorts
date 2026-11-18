/**
 * Rhythm arithmetic shared by narrative planning, plan validation and group
 * generation (round 2, 2026-11-06, user-approved small adjustments):
 *
 * - The skill's 2-second performance margin is a capacity check only. It is
 *   never an on-screen pause at the start or end of a group.
 * - A group whose own content (dialogue at 4.5 chars/s + 2 s, action at the
 *   skill's 500 chars/min) is shorter than its beat minimum may be up to 2 s
 *   shorter than that minimum (narrative >= 8 s, climax >= 10 s). Every group
 *   stays 8–15 s. Unknown content never gets the tolerance.
 *
 * Nothing here changes original words, splits lines or removes action.
 */
export const BEAT_LIMITS = { transition: [8, 10], narrative: [10, 15], climax: [12, 15] } as const
export type Beat = keyof typeof BEAT_LIMITS
export const BEAT_TOLERANCE_SECONDS = 2
const ACTION_LETTERS_PER_SECOND = 500 / 60
const letters = (text: string) => [...text].filter(character => /[\p{L}\p{N}]/u.test(character)).length

/** Scene headings, cast lists and bold notes ("**逻辑线：**") are not performed. */
export function isUnperformedLine(text: string) {
  return /^\s*\**\s*\d+\s*[-－]\s*\d+\s.*(?:内|外)\s*\**\s*$/u.test(text)
    || /^\s*\**\s*出场人物\s*[:：]/u.test(text)
    || /^\s*\*\*[^*\n]{1,16}[:：]\s*\*\*/u.test(text)
}

/**
 * Round 3 (2026-11-08): writer's production notes inside a script, which are not performed on screen:
 * - a casting/look suggestion line: "首次人物建议（C）：…" (also "人物建议", "造型建议", "选角建议");
 * - a bold-only section title that is not a scene heading, e.g. "**本集人物状态与闭环**", and the bullet lines
 *   ("- 林轩：…", "- 可见结果：…") directly under it, until the next heading or non-bullet line;
 * - a bold label note "**逻辑线：**…" / "**本集人物状态：**…" (already unperformed above).
 * Markdown headings (#, ##, ...) and scene headings ("#### 1-01 学生宿舍302 夜 内", "**1-01 …内**") end a notes section.
 * The lines stay in the script, in source_ids and in coverage; they only stop counting as performed action time.
 */
export function productionNoteIds(units: ReadonlyArray<{ id: number; text: string }>) {
  const ids = new Set<number>()
  let section = false
  for (const unit of units) {
    const line = unit.text.trim()
    if (/^#{1,6}\s/u.test(line) || /^\s*\**\s*\d+\s*[-－]\s*\d+\s/u.test(line)) { section = false; continue }
    if (/^\**\s*(?:首次人物建议|人物建议|造型建议|选角建议)\s*(?:[（(][^）)]*[）)])?\s*[:：]/u.test(line)) { ids.add(unit.id); section = false; continue }
    if (/^\*\*[^*\n]{1,24}\*\*$/u.test(line) && !/^\*\*\s*\d+\s*[-－]\s*\d+/u.test(line)) { ids.add(unit.id); section = true; continue }
    if (/^\s*\*\*[^*\n]{1,16}[:：]\s*\*\*/u.test(line)) { ids.add(unit.id); section = false; continue }
    if (section && /^[-•·*]\s+\S/u.test(line)) { ids.add(unit.id); continue }
    section = false
  }
  return ids
}

/** Letters of on-screen action in one source line; spoken lines count 0 (their directions run with the speech). */
export function actionLetters(text: string, spokenCharacters: number) {
  if (spokenCharacters > 0 || isUnperformedLine(text)) return 0
  return letters(text.replace(/【[^】]*】/gu, '').replace(/^\s*(?:▲|动作\s*[:：])/u, ''))
}

/** `unperformed` marks a production note found with productionNoteIds (needs the surrounding lines). */
export interface RhythmSource { text: string | undefined; spoken: number | undefined; unperformed?: boolean }

/**
 * Seconds the group's own content needs: dialogue at the skill budget (4.5 chars/s
 * + 2 s once per speaking group) plus action at 500 chars/min. Null when any
 * source line is unknown, so no tolerance is granted on missing information.
 */
export function groupContentSeconds(sourceIds: readonly number[], source: (id: number) => RhythmSource) {
  let speech = 0, action = 0
  for (const id of new Set(sourceIds)) {
    const line = source(id)
    if (line.text === undefined || line.spoken === undefined) return null
    speech += line.spoken
    action += line.unperformed ? 0 : actionLetters(line.text, line.spoken)
  }
  return (speech ? speech / 4.5 + 2 : 0) + action / ACTION_LETTERS_PER_SECOND
}

/** The smallest duration a beat accepts for this group. */
export function allowedBeatMinimum(beat: Beat, contentSeconds: number | null) {
  const minimum = BEAT_LIMITS[beat][0]
  if (contentSeconds === null || contentSeconds >= minimum - 1e-8) return minimum
  return Math.max(8, minimum - BEAT_TOLERANCE_SECONDS)
}

/** Facts sent with every group generation request; arithmetic only, never a template. */
export function rhythmFacts(group: { duration: number; source_ids: readonly number[] }, source: (id: number) => RhythmSource, ownSpeechCharacters?: number) {
  const ids = [...new Set(group.source_ids)]
  const speech = ownSpeechCharacters ?? ids.reduce((sum, id) => sum + (source(id).spoken || 0), 0)
  const budget = speech ? speech / 4.5 + 2 : 0
  const firstSpeech = ids.findIndex(id => (source(id).spoken || 0) > 0)
  const before = (firstSpeech < 0 ? ids : ids.slice(0, firstSpeech)).map(id => source(id))
  const opening = firstSpeech === 0 ? 'dialogue'
    : firstSpeech < 0 ? 'no_dialogue'
      : before.every(line => line.text !== undefined && (line.unperformed || isUnperformedLine(line.text))) ? 'dialogue_after_heading' : 'action_then_dialogue'
  const round = (value: number) => Math.round(value * 10) / 10
  return {
    speech_characters: speech,
    speech_budget_seconds: round(budget),
    spare_seconds: round(Math.max(0, group.duration - budget)),
    opening,
    action_characters_before_first_line: firstSpeech <= 0 ? 0 : before.reduce((sum, line) => sum + (line.unperformed ? 0 : actionLetters(line.text || '', line.spoken || 0)), 0),
  }
}

/** Added to the narrative-plan request (not part of the draft fingerprint). */
export const PLAN_RHYTHM_NOTE = '时长安排：每组时长贴合本组原文的实际需要（台词按4.5字/秒加一次2秒表演余量，动作按原文篇幅），不为凑节拍下限或接近总时长目标而拉长单组；台词和动作都少的组可以比该节拍下限短2秒（叙事段不少于8秒、爆点段不少于10秒），每组仍为8—15秒。整集总时长须落在timing_budget范围内。爆点只用于真实的转折、揭示或情绪爆发。'

/** Added to every complete group generation request (not part of the draft fingerprint). */
export const EXPAND_RHYTHM_NOTE = [
  '节奏安排（不改skill规则、不增删任何原文，只说明时间怎么用）：',
  '1. 2秒表演余量只用于核对整组台词容量，不需要在开头、结尾或台词之间空出成段的无声时间。',
  '2. 第一句台词之前只有很短的动作时（current_group.rhythm.opening为action_then_dialogue且action_characters_before_first_line较少），把这个动作和第一句台词写在同一个时间行里，边做边说；只有原文明确要求先看见、先完成某个动作才能开口时，才把第一句台词放到后面的时间行。开口前的自然准备（吸气、抬眼）与台词同一行。',
  '3. 首行的空间基准（A0、X/Y轴、站位、机位）是写给画面的设定，不占播放时间，和第一个动作或第一句台词写在同一行。',
  '4. current_group.rhythm.spare_seconds是本组时长超出台词所需的秒数，用于原文已有的动作、反应和情绪停顿，分散安排在台词之间；没有原文依据时，不把整个时间行空着开场，也不整行定格收尾。末态照常写进最后一个时间行，可与最后的台词或反应同一行。',
].join('\n')
