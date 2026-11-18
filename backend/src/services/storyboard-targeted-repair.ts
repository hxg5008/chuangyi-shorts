import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ValidationIssue } from './storyboard-validation.js'

const proseFields = [
  'title', 'time', 'location', 'shot_type', 'angle', 'movement', 'description', 'result',
  'atmosphere', 'image_prompt', 'video_prompt', 'bgm_prompt', 'sound_effect',
] as const
type ProseField = typeof proseFields[number]
type RepairField = ProseField | 'time_row_counts' | 'voice_cues'
type Submission = Record<string, unknown>
type ParsedLine = { lineIndex: number; row: number; start: number; end: number; text: string; full: string }
const prose = z.string().min(1).refine(value => Boolean(value.trim()), 'Must contain meaningful text')
const counts = z.array(z.union([z.literal(1), z.literal(2)])).min(2).max(4)
const rowPattern = /^\s*(\d+(?:\.\d+)?)\s*[-–—~～至]\s*(\d+(?:\.\d+)?)\s*(?:秒|s|초)\s*[:：]\s*(.+)$/iu
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const object = (value: unknown): value is Submission => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const clone = <T>(value: T): T => structuredClone(value)

/** Version the exact raw submission, including typed asset tokens and locked prose. */
export function targetedRepairVersion(prior: Submission) {
  return createHash('sha256').update(JSON.stringify(prior)).digest('hex')
}

/**
 * Shot counts (2–4) that can be laid out on ceil(duration/3) time rows when each
 * shot takes 1–2 consecutive 3 s rows and lasts 2–6 s (the last row keeps the
 * actual remainder). Same arithmetic as the workflow's timing options.
 */
export function feasibleShotCounts(duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return []
  const rows = Math.ceil(duration / 3), feasible: number[] = []
  for (const shots of [2, 3, 4]) {
    for (let mask = 0; mask < 2 ** shots; mask++) {
      let row = 0
      const ok = Array.from({ length: shots }, (_, index) => 1 + (mask >> index & 1)).every(count => {
        const seconds = Math.min((row + count) * 3, duration) - row * 3; row += count; return seconds >= 2 && seconds <= 6
      })
      if (ok && row === rows) { feasible.push(shots); break }
    }
  }
  return feasible
}

const describedShotCount = (description: unknown) => typeof description === 'string'
  ? [...description.matchAll(/【\s*(?:镜头|shot|ショット|컷)\s*\d+\s*】/giu)].length : 0

export interface TargetedRepairPlan {
  baseVersion: string
  fields: RepairField[]
  scope: 'fields' | 'video_rows'
  schema: z.ZodType
  payload: {
    base_version: string
    scope: 'fields' | 'video_rows'
    fields: RepairField[]
    allowed_changes: string[]
    current_values: Submission
    locked_fields: string[]
    target_rows?: Array<{ row: number; text: string }>
    instruction: string
  }
  /** Internal stable indices; never choose replacement locations from model prose. */
  rowTargets?: number[]
  headerLine?: number
}

function fieldFor(issue: ValidationIssue): RepairField | null {
  const field = issue.field.split('.')[0]
  if (['voice_profile_conflict', 'voice_cue_schema'].includes(issue.code)
    && /^voice_cues\.[A-Za-z0-9_-]+\.(?:profile(?:\.(?:age|register|timbre))?|state|goal|volume|rate_cps|breath|tail|emotion)$/u.test(issue.field)) return 'voice_cues'
  if (['shot_time_mapping', 'shot_duration'].includes(issue.code)) return 'time_row_counts'
  if ([
    'prompt_header', 'time_row_reference', 'space_basis_missing', 'dialogue_preservation',
    'time_axis', 'prompt_length', 'storyboard_prompt_length',
  ].includes(issue.code)) return 'video_prompt'
  if (['skill_field_missing', 'storyboard_schema', 'response_schema', 'reference_quote_unclosed',
    'reference_token_required', 'reference_token_invalid', 'reference_unknown_id', 'reference_name_ambiguous'].includes(issue.code)
    && (proseFields.includes(field as ProseField) || field === 'time_row_counts')) return field as RepairField
  return null
}

function videoLines(prior: Submission) {
  if (typeof prior.video_prompt !== 'string' || !prior.video_prompt.trim()) return null
  const lines = prior.video_prompt.split(/\r\n|\n|\r/)
  const rows: ParsedLine[] = []
  for (const [lineIndex, line] of lines.entries()) {
    const match = line.match(rowPattern)
    if (match) rows.push({ lineIndex, row: rows.length + 1, start: Number(match[1]), end: Number(match[2]), text: match[3], full: line })
  }
  const duration = Number(prior.duration)
  if (!Number.isFinite(duration) || rows.length !== Math.ceil(duration / 3)
    || rows.some((row, index) => row.start !== index * 3 || row.end !== Math.min((index + 1) * 3, duration))) return null
  const headerLine = lines.findIndex(line => Boolean(line.trim()))
  if (headerLine < 0 || rows.some(row => row.lineIndex === headerLine)) return null
  return { lines, rows, headerLine }
}

function targetedRows(prior: Submission, issues: ValidationIssue[]) {
  const video = videoLines(prior)
  if (!video) return null
  const selected = new Set<number>()
  let header = false
  for (const issue of issues) {
    if (fieldFor(issue) !== 'video_prompt') continue
    if (issue.code === 'prompt_header') { header = true; continue }
    if (issue.code === 'space_basis_missing') { selected.add(1); continue }
    if (issue.code === 'time_row_reference') {
      const row = Number(issue.field.match(/^video_prompt\.rows\.(\d+)$/)?.[1])
      if (!Number.isInteger(row) || row < 1 || row > video.rows.length) return null
      selected.add(row); continue
    }
    if (issue.code === 'dialogue_preservation') {
      const child = Number(issue.message.match(/^子镜头(\d+)/u)?.[1])
      const mapping = prior.time_row_counts
      if (!Array.isArray(mapping) || mapping.some(count => count !== 1 && count !== 2)
        || mapping.reduce((sum, count) => sum + count, 0) !== video.rows.length
        || !Number.isSafeInteger(child) || child < 1 || child > mapping.length) return null
      const before = mapping.slice(0, child - 1).reduce((sum, count) => sum + count, 0)
      for (let row = before + 1; row <= before + mapping[child - 1]; row++) selected.add(row)
      continue
    }
    // Unclear positions, an invalid axis or length reductions need the whole
    // video field. Never infer a character offset from an error message.
    return null
  }
  return { ...video, rows: [...selected].sort((a, b) => a - b), header }
}

/** Choose a patch only when every hard error has an explicit local field. */
export function createTargetedRepair(input: {
  prior: unknown
  issues: readonly ValidationIssue[]
  mode: 'breakdown' | 'prompt'
  voiceCueSchema?: z.ZodType
}): TargetedRepairPlan | null {
  if (!object(input.prior)) return null
  const prior = input.prior
  if (input.mode === 'breakdown' && (!Number.isSafeInteger(prior.shot_number) || !own(prior, 'source_ids'))) return null
  const errors = input.issues.filter(issue => issue.severity === 'error')
  if (!errors.length) return null
  // A counts-only patch cannot fix a described shot count that no layout of the
  // planned duration can hold (e.g. 4 shots in 10 s leaves a 1 s shot). The
  // complete group repair may redesign the shots; the duration stays locked.
  if (input.mode === 'breakdown' && errors.some(issue => ['shot_duration', 'shot_time_mapping'].includes(issue.code))) {
    const shots = describedShotCount(prior.description)
    if (shots && !feasibleShotCounts(Number(prior.duration)).includes(shots)) return null
  }
  const fields = new Set<RepairField>()
  for (const issue of errors) {
    const field = fieldFor(issue)
    if (!field || input.mode === 'prompt' && field !== 'video_prompt' && field !== 'time_row_counts' && field !== 'voice_cues') return null
    fields.add(field)
  }
  if (fields.has('voice_cues') && (!input.voiceCueSchema || fields.size !== 1 || !voiceIdentity(prior.voice_cues))) return null
  const ordered = [...fields].sort() as RepairField[]
  // If the mapping also changes, a child-to-row mapping is not stable enough
  // to restrict a simultaneous video change to its former row indices.
  const rows = fields.has('video_prompt') && !fields.has('time_row_counts') ? targetedRows(prior, errors) : null
  const changes: Record<string, z.ZodType> = {}
  for (const field of ordered) {
    if (field === 'video_prompt' && rows) continue
    changes[field] = field === 'voice_cues' ? input.voiceCueSchema! : field === 'time_row_counts' ? counts : field === 'video_prompt' ? prose.max(3600) : prose
  }
  if (rows?.header) changes.video_prompt_header = prose.refine(value => !/[\r\n]/u.test(value) && !rowPattern.test(value), 'Replace only the independent header line')
  if (rows?.rows.length) {
    // Each exact requested row is a required object key. A model cannot repeat,
    // omit, reorder or invent a row by returning a loose array of operations.
    const selected: Record<string, z.ZodType> = {}
    for (const row of rows.rows) {
      const expected = videoLines(prior)!.rows[row - 1]
      selected[String(row)] = prose.refine(value => {
        const match = value.match(rowPattern)
        return !/[\r\n]/u.test(value) && Boolean(match) && Number(match![1]) === expected.start && Number(match![2]) === expected.end
      }, 'Keep this existing row interval and replace its complete text only')
    }
    changes.video_prompt_rows = z.object(selected).strict()
  }
  if (!Object.keys(changes).length) return null
  const baseVersion = targetedRepairVersion(prior)
  const scope = rows ? 'video_rows' as const : 'fields' as const
  const schema = z.object({ base_version: z.literal(baseVersion), changes: z.object(changes).strict() }).strict()
  const current_values = Object.fromEntries(ordered.map(field => [field, clone(prior[field])]))
  const payload: TargetedRepairPlan['payload'] = {
    base_version: baseVersion, scope, fields: ordered, allowed_changes: Object.keys(changes), current_values,
    locked_fields: Object.keys(prior).filter(field => !fields.has(field as RepairField)),
    ...(rows ? { target_rows: rows.rows.map(row => ({ row, text: videoLines(prior)!.rows[row - 1].full })) } : {}),
    instruction: '仅返回指定base_version与changes中的必需修改，不回传完整分镜。未列字段、镜头数量/顺序、时长、原文归属、素材绑定和末态全部锁定。保留原词、声音类型、全部适用skill内容，不以摘要或删词缩短。局部时间行按给定原行号返回完整一行，时间区间保持；其余行逐字保留。'
      + (fields.has('voice_cues') ? '本次只修已有voice_cues的profile及state/goal/volume/rate_cps/breath/tail/emotion；各项id、shot、speaker_id、kind、source_name、数量和顺序逐值锁定，不能增删或改换发声者。正文声音锚点和原词逐字保持。' : '')
      + '确有结构或资料冲突时走工作流conflict通道，不越权改锁定内容。修改后后台仍执行原有完整检查。',
  }
  return { baseVersion, fields: ordered, scope, schema, payload,
    ...(rows ? { rowTargets: rows.rows, ...(rows.header ? { headerLine: rows.headerLine } : {}) } : {}) }
}

export type TargetedRepairResult = { ok: true; value: Submission } | { ok: false; code: string; message: string }

/** Stable identity only: acoustic metadata may be incomplete before its repair. */
function voiceIdentity(value: unknown) {
  if (!Array.isArray(value)) return null
  const seen = new Set<string>(), result: unknown[] = []
  for (const cue of value) {
    if (!object(cue) || typeof cue.id !== 'string' || !cue.id || seen.has(cue.id)
      || !Number.isSafeInteger(cue.shot) || Number(cue.shot) < 1 || Number(cue.shot) > 4
      || !(cue.speaker_id === null || Number.isSafeInteger(cue.speaker_id) && Number(cue.speaker_id) > 0)
      || !['dialogue', 'offscreen', 'narration'].includes(String(cue.kind)) || typeof cue.source_name !== 'string') return null
    seen.add(cue.id)
    result.push({ id: cue.id, shot: cue.shot, speaker_id: cue.speaker_id, kind: cue.kind, source_name: cue.source_name })
  }
  return result
}

/** Merge only a strictly allowed patch into the exact still-current snapshot. */
export function applyTargetedRepair(prior: unknown, response: unknown, plan: TargetedRepairPlan): TargetedRepairResult {
  if (!object(prior) || targetedRepairVersion(prior) !== plan.baseVersion) return {
    ok: false, code: 'targeted_repair_version', message: '定向修改的原稿版本已变化，拒绝合并迟到结果；现有草稿保留。',
  }
  const checked = plan.schema.safeParse(response)
  if (!checked.success) return {
    ok: false, code: 'targeted_repair_schema', message: `定向修改必须只返回本次指定字段及原稿版本：${checked.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
  }
  const { changes } = checked.data as { changes: Submission }
  if (own(changes, 'voice_cues')) {
    const before = voiceIdentity(prior.voice_cues), after = voiceIdentity(changes.voice_cues)
    if (!before || !after || JSON.stringify(before) !== JSON.stringify(after)) return {
      ok: false, code: 'targeted_repair_voice_identity', message: '声音局部修正改变了发声者、声音类型、子镜、来源、数量或顺序，拒绝合并；原稿保留。',
    }
  }
  const value = clone(prior)
  for (const field of plan.fields) if (own(changes, field)) value[field] = clone(changes[field])
  if (own(changes, 'video_prompt_rows') || own(changes, 'video_prompt_header')) {
    if (typeof prior.video_prompt !== 'string') return { ok: false, code: 'targeted_repair_version', message: '定向时间行缺少稳定的原视频提示词，未合并修改。' }
    // Keep original line delimiters, blank lines and every unselected byte. The
    // program neither cuts spoken words nor renders or summarizes model prose.
    const parts = prior.video_prompt.split(/(\r\n|\n|\r)/)
    const lines = videoLines(prior)!
    if (own(changes, 'video_prompt_header')) parts[plan.headerLine! * 2] = changes.video_prompt_header as string
    if (object(changes.video_prompt_rows)) for (const row of plan.rowTargets || []) {
      parts[lines.rows[row - 1].lineIndex * 2] = changes.video_prompt_rows[String(row)] as string
    }
    value.video_prompt = parts.join('')
  }
  return { ok: true, value }
}
