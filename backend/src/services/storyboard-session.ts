import { and, eq, isNull } from 'drizzle-orm'
import { db, getInsertId, schema, type DB } from '../db/index.js'
import { now } from '../utils/response.js'
import { resolveVoiceMentions } from './character-voice-references.js'
import { extractStoryboardDialogue, validateStoryboard, type ValidationIssue } from './storyboard-validation.js'
import { renderVideoPromptPlan, type VideoPromptPlan } from './video-prompt-plan.js'
import { buildDialogueTimingGuide, generationTimeBudget } from './first-pass-instructions.js'
import { extractScriptDialogue } from './script-dialogue.js'
import { resolveSourceDialoguePlan, type SourceDialoguePlanResult, type VideoPromptPlanInput } from './source-dialogue-plan.js'
import { validateSkillStoryboard, validateSkillDialogueCoverage } from './skill-storyboard-validation.js'
import { splitScriptUnits, scriptTimingBudget, TOTAL_DURATION_TOLERANCE_SECONDS } from './skill-storyboard-contract.js'

export type { ValidationIssue } from './storyboard-validation.js'

export interface StoryboardCandidate {
  shot_number: number
  title?: string
  shot_type?: string
  angle?: string
  movement?: string
  location?: string
  time?: string
  description?: string
  result?: string
  atmosphere?: string
  image_prompt?: string
  video_prompt?: string
  video_prompt_plan?: VideoPromptPlanInput
  bgm_prompt?: string
  sound_effect?: string
  duration?: number
  scene_id?: number | null
  character_ids?: number[]
  prop_ids?: number[]
  source_ids?: number[]
  time_row_counts?: number[]
}

export interface StoryboardSessionOptions {
  mode: 'breakdown' | 'prompt'
  episodeId: number
  dramaId: number
  storyboardIds?: number[]
  signal?: AbortSignal
  language?: string
  onPhase?: (phase: 'validating' | 'saving') => void | Promise<void>
  validationProfile?: 'legacy' | 'skill-content'
}

type Executor = Pick<DB, 'select' | 'insert' | 'update' | 'delete'>
type StoredCandidate = StoryboardCandidate & { id: number }
type Existing = ReturnType<typeof readExisting>[number]

function readExisting(executor: Executor, episodeId: number) {
  return executor.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).all()
    .filter(row => !row.deletedAt).sort((a, b) => a.storyboardNumber - b.storyboardNumber || a.id - b.id)
    .map(row => ({
      row,
      characterIds: executor.select().from(schema.storyboardCharacters)
        .where(eq(schema.storyboardCharacters.storyboardId, row.id)).all().map(link => link.characterId).sort((a, b) => a - b),
      propIds: executor.select().from(schema.storyboardProps)
        .where(eq(schema.storyboardProps.storyboardId, row.id)).all().map(link => link.propId).sort((a, b) => a - b),
    }))
}

function asCandidate(value: Existing): StoredCandidate {
  const { row, characterIds, propIds } = value
  return {
    id: row.id, shot_number: row.storyboardNumber, title: row.title || '', shot_type: row.shotType || '',
    angle: row.angle || '', movement: row.movement || '', location: row.location || '', time: row.time || '',
    description: row.description || '', result: row.result || '', atmosphere: row.atmosphere || '',
    image_prompt: row.imagePrompt || '', video_prompt: row.videoPrompt || '', bgm_prompt: row.bgmPrompt || '',
    sound_effect: row.soundEffect || '', duration: row.duration || 0, scene_id: row.sceneId,
    character_ids: [...characterIds], prop_ids: [...propIds],
  }
}

function clone<T>(value: T): T { return structuredClone(value) }
const compactText = (value: string) => value.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '')

export class StoryboardSession {
  private readonly original: Existing[]
  private readonly originalFingerprint: string
  private readonly originalScript: string
  private readonly candidates = new Map<number, StoredCandidate>()
  private readonly planIssues = new Map<number, ValidationIssue[]>()
  private readonly planParticipants = new Map<number, Array<{ shotNumber: number; characterId: number; visibility: 'face_visible' | 'face_hidden' | 'offscreen' | 'uncertain' }>>()
  private readonly sourceDialogue = new Map<number, Pick<SourceDialoguePlanResult, 'hasSourceEntries' | 'hasLegacyDialogue' | 'sourceRefs'>>()
  private issues: ValidationIssue[] = []
  private operationIssues: ValidationIssue[] = []
  private rejectedToolInput?: { tool: string; message: string; input: unknown }
  private attemptControlled = false
  private attemptStopped = false
  private currentAttempt = -1
  private replaceRequested = false
  private finalBatchDeclared = false
  private finishing = false
  private finished = false
  private nextTemporaryId = -1
  private saved = 0
  private cancelled = false
  private cancellationReason = '任务已中止，候选稿不会保存'
  private commitHook?: () => void

  constructor(private readonly options: StoryboardSessionOptions) {
    if (!Number.isSafeInteger(options.episodeId) || !Number.isSafeInteger(options.dramaId)) throw new Error('Storyboard session requires episodeId/dramaId')
    const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, options.episodeId)).get()
    if (!episode || episode.dramaId !== options.dramaId || episode.deletedAt) throw new Error('Episode not found in the current project')
    this.originalScript = episode.scriptContent || episode.content || ''
    this.original = readExisting(db, options.episodeId)
    this.originalFingerprint = JSON.stringify(this.original)
  }

  get mode() { return this.options.mode }
  get savedCount() { return this.saved }
  getContextFingerprint() { return JSON.stringify({ script: this.originalScript, storyboards: this.originalFingerprint }) }
  getOriginalCandidate(id: number) { const original = this.original.find(value => value.row.id === id); return original ? clone(asCandidate(original)) : null }
  setCommitHook(hook: () => void) { this.commitHook = hook }
  /** Re-evaluate a complete durable draft without committing or mutating this session. */
  reviewCompleteCandidates(candidates: StoryboardCandidate[]): ValidationIssue[] {
    const review = new StoryboardSession({ ...this.options, onPhase: undefined })
    try {
      for (const [index, candidate] of candidates.entries()) {
        if (this.mode === 'prompt') {
          const id = this.options.storyboardIds?.[index]
          if (id === undefined) return [this.issue('target_missing', '完整草稿缺少对应的目标分镜ID')]
          review.stageUpdate(id, { video_prompt: candidate.video_prompt, time_row_counts: candidate.time_row_counts })
        } else review.stageSave([candidate], { replaceExisting: index === 0, isFinalBatch: index === candidates.length - 1 })
      }
      return review.validateComplete()
    } finally { review.cancel('完整草稿本地重验结束') }
  }
  hasCandidates(): boolean { return this.candidates.size > 0 }
  getIssues(): ValidationIssue[] { return clone(this.issues) }
  getReport() {
    return { mode: this.mode, candidates: [...this.candidates.values()].map(row => ({ ...clone(row), storyboardId: row.id, shotNumber: row.shot_number })), issues: this.getIssues(), rejectedToolInput: clone(this.rejectedToolInput) }
  }

  beginAttempt(attempt: number) {
    if (this.available()) throw new Error('候选会话已结束，不能继续模型生成')
    if (![0, 1].includes(attempt) || attempt <= this.currentAttempt) throw new Error('无效或重复的模型修正轮次')
    this.currentAttempt = attempt
    this.attemptControlled = true
    this.attemptStopped = false
  }

  shouldStopAttempt() { return this.attemptControlled && this.attemptStopped }
  readyToCommit() {
    return !this.available() && !this.shouldStopAttempt() && this.candidates.size > 0
      && !this.validateComplete().some(issue => issue.severity === 'error')
  }

  getRepairReport() {
    const report = this.getReport()
    const errors = report.issues.filter(issue => issue.severity === 'error')
    const affected = new Set(errors.map(issue => issue.storyboardId).filter(id => id !== undefined))
    return { ...report, issues: errors,
      candidates: report.candidates.map(row => {
        if (!affected.has(row.id)) return { storyboardId: row.id, shotNumber: row.shot_number, duration: row.duration, valid: true }
        const copy = { ...row }
        if (copy.video_prompt_plan) delete copy.video_prompt
        return copy
      }),
    }
  }

  recordToolInputError(tool: string, message: string, input: unknown) {
    if (this.available() || this.shouldStopAttempt()) return
    this.rejectedToolInput = { tool, message: message.slice(0, 2000), input: clone(input) }
    this.operationIssues = [this.issue('tool_input', `保存工具输入不完整或格式有误：${message.slice(0, 2000)}`, 'video_prompt_plan')]
    this.issues = [...this.validateCandidates(), ...this.operationIssues]
    if (this.attemptControlled) this.attemptStopped = true
  }

  cancel(reason?: string): void {
    this.cancelled = true
    if (reason) this.cancellationReason = reason
  }

  private issue(code: string, message: string, field = 'session', candidate?: StoredCandidate): ValidationIssue {
    return { code, message, field, severity: 'error', ...(candidate ? { storyboardId: candidate.id, shotNumber: candidate.shot_number } : {}) }
  }

  private available() {
    if (this.cancelled || this.options.signal?.aborted) return this.issue('aborted', this.cancellationReason)
    if (this.finished || this.finishing) return this.issue('session_closed', '当前候选会话已结束或正在提交')
    return null
  }

  private failure(issues: ValidationIssue[]) {
    this.operationIssues = issues
    this.issues = [...this.validateCandidates(), ...issues]
    if (this.attemptControlled) this.attemptStopped = true
    return { error: 'Storyboard candidate validation failed; correct the listed issues and call the tool again', issues: this.getIssues(), staged: false }
  }

  assertScope(episodeId: number, dramaId: number): boolean {
    if (episodeId === this.options.episodeId && dramaId === this.options.dramaId) return true
    this.failure([this.issue('session_scope', '候选会话不能跨集或跨项目使用')])
    return false
  }

  stageSave(storyboards: StoryboardCandidate[], options: { replaceExisting?: boolean; isFinalBatch?: boolean } = {}) {
    const unavailable = this.available()
    if (unavailable) return this.failure([unavailable])
    if (this.shouldStopAttempt()) return { error: '本轮已因候选错误停止，后续暂存未执行；等待唯一一次定向修正', staged: false, issues: this.getIssues() }
    if (this.mode !== 'breakdown') return this.failure([this.issue('prompt_only', '提示词任务只能调用 update_storyboard 更新指定分镜的 video_prompt')])
    if (!storyboards.length || storyboards.length > 8) return this.failure([this.issue('batch_size', '每批必须包含1至8个分镜候选', 'storyboards')])
    if (!this.replaceRequested && options.replaceExisting !== true) return this.failure([this.issue('replace_required', '拆分首批必须明确 replace_existing:true；旧稿在整集通过校验前不会删除', 'replace_existing')])
    if (this.replaceRequested && options.replaceExisting === true && this.currentAttempt !== 1) return this.failure([this.issue('replace_repeated', '首批已声明替换，后续批次或返修请省略 replace_existing', 'replace_existing')])
    const numbers = storyboards.map(row => row.shot_number)
    if (numbers.some(number => !Number.isSafeInteger(number) || number < 1) || new Set(numbers).size !== numbers.length) {
      return this.failure([this.issue('shot_numbers', '本批 shot_number 必须为不重复的正整数', 'shot_number')])
    }
    this.replaceRequested = true
    const writtenIds: number[] = []
    for (const row of storyboards) {
      const existing = [...this.candidates.values()].find(candidate => candidate.shot_number === row.shot_number)
      const id = existing?.id ?? this.nextTemporaryId--
      this.candidates.set(id, this.assemblePlan({ ...clone(row), id }))
      writtenIds.push(id)
    }
    if (options.isFinalBatch === true) this.finalBatchDeclared = true
    this.operationIssues = []
    this.rejectedToolInput = undefined
    this.issues = this.validateCandidates()
    return this.stageResult(writtenIds)
  }

  stageUpdate(storyboardId: number, fields: Partial<StoryboardCandidate>) {
    const unavailable = this.available()
    if (unavailable) return this.failure([unavailable])
    if (this.shouldStopAttempt()) return { error: '本轮已因候选错误停止，后续暂存未执行；等待唯一一次定向修正', staged: false, issues: this.getIssues() }
    let candidate = this.candidates.get(storyboardId)
    if (this.mode === 'prompt') {
      if (!this.options.storyboardIds?.includes(storyboardId)) return this.failure([this.issue('target_not_allowed', '仅允许更新本次指定的 storyboard_id', 'storyboard_id')])
      const forbidden = Object.keys(fields).filter(key => key !== 'video_prompt' && key !== 'video_prompt_plan' && !(key === 'time_row_counts' && this.options.validationProfile === 'skill-content'))
      if (forbidden.length || !Object.hasOwn(fields, 'video_prompt') && !Object.hasOwn(fields, 'video_prompt_plan')) return this.failure([this.issue('prompt_fields_only', '提示词任务只允许传 storyboard_id 与 video_prompt_plan（或原格式 video_prompt），实际仅保存 video_prompt', 'video_prompt')])
      const original = this.original.find(value => value.row.id === storyboardId)
      if (!original) return this.failure([this.issue('target_missing', '指定分镜不属于当前集或已删除', 'storyboard_id')])
      candidate = candidate || asCandidate(original)
    } else if (!candidate) {
      return this.failure([this.issue('candidate_not_found', '拆分返修只能更新 read_storyboard_context 返回的候选临时ID；也可按 shot_number 重新 save_storyboards', 'storyboard_id')])
    }
    const updated = { ...candidate!, ...clone(fields), id: storyboardId }
    // A directed legacy-text repair must not inherit metadata from a discarded plan.
    if (Object.hasOwn(fields, 'video_prompt') && !Object.hasOwn(fields, 'video_prompt_plan')) delete updated.video_prompt_plan
    this.candidates.set(storyboardId, this.assemblePlan(updated))
    this.operationIssues = []
    this.rejectedToolInput = undefined
    this.issues = this.validateCandidates()
    return this.stageResult([storyboardId])
  }

  private stageResult(writtenIds: number[]) {
    const issues = this.getIssues()
    const written = new Set(writtenIds)
    // A bounded repair may fix several previously rejected candidates in separate
    // calls. Untouched candidates still block commit, but must not reject a valid
    // repair of this call's candidates or become a false tool-input failure.
    const rejected = issues.some(issue => issue.severity === 'error'
      && (!this.attemptControlled || issue.storyboardId == null || written.has(issue.storyboardId)))
    if (this.attemptControlled && rejected) this.attemptStopped = true
    return {
      staged: true, count: writtenIds.length, saved: 0, issues, candidates: [...this.candidates.values()].map(row => ({ storyboardId: row.id, shotNumber: row.shot_number })),
      ...(rejected ? { error: '候选稿尚未通过校验，请按 issues 定向修正；真实分镜尚未修改' } : {}),
      message: this.mode === 'breakdown'
        ? '候选稿已暂存，尚未落库。继续保存其余批次；最后一批必须 is_final_batch:true。返修用候选临时ID或相同shot_number，后续省略replace_existing。'
        : '提示词候选已暂存，全部目标校验通过后统一保存。',
    }
  }

  overlayContext<T extends { existing_storyboards: Array<Record<string, any>> }>(payload: T): T {
    // Fresh breakdowns must not inherit the old timing/grouping or repeatedly send
    // the whole previous episode's video prompts back to the model.
    const ordered = [...payload.existing_storyboards].sort((a, b) => a.shot_number - b.shot_number)
    const needed = new Set<number>()
    for (const [index, row] of ordered.entries()) if (this.options.storyboardIds?.includes(row.id)) {
      for (const neighbor of ordered.slice(Math.max(0, index - 1), index + 2)) needed.add(neighbor.id)
    }
    const originals = this.mode === 'breakdown' ? [] : ordered.filter(row => needed.has(row.id))
    const rows = new Map(originals.map(row => [row.id as number, row]))
    for (const candidate of this.candidates.values()) rows.set(candidate.id, { ...clone(candidate), candidate: true })
    return { ...payload, existing_storyboards: [...rows.values()].sort((a, b) => a.shot_number - b.shot_number),
      storyboard_validation: { ...this.getRepairReport(), stagedOnly: true, isFinalBatchDeclared: this.finalBatchDeclared },
      first_pass_generation: {
        output: 'video_prompt_plan', mode: this.mode, target_storyboard_ids: this.options.storyboardIds || [],
        target_budgets: this.mode === 'prompt' ? this.original.filter(value => this.options.storyboardIds?.includes(value.row.id)).map(value => ({ storyboard_id: value.row.id, ...generationTimeBudget(value.row.duration || 0) })) : [],
        duration_options: this.mode === 'breakdown' ? Array.from({ length: 8 }, (_, index) => generationTimeBudget(index + 8)) : [],
        scope: 'Plan actual shot participants before prose. face_visible needs emotion; hidden/offscreen must not invent visible expressions. Speech/acting capacity is planned before writing. Only exceptional content errors need repair.',
      } }
  }

  private assemblePlan(candidate: StoredCandidate): StoredCandidate {
    this.planIssues.delete(candidate.id)
    this.planParticipants.delete(candidate.id)
    this.sourceDialogue.delete(candidate.id)
    if (!candidate.video_prompt_plan) return candidate
    const assets = this.assets()
    const guide = buildDialogueTimingGuide(extractScriptDialogue(this.originalScript, assets.characters.map(character => character.name)), assets.characters)
    const resolved = resolveSourceDialoguePlan(candidate.video_prompt_plan, guide)
    this.sourceDialogue.set(candidate.id, { hasSourceEntries: resolved.hasSourceEntries, hasLegacyDialogue: resolved.hasLegacyDialogue, sourceRefs: resolved.sourceRefs })
    if (!resolved.plan) {
      this.planIssues.set(candidate.id, resolved.issues.map(issue => ({ ...issue, storyboardId: candidate.id, shotNumber: candidate.shot_number })))
      return { ...candidate, video_prompt: '' }
    }
    if (this.mode === 'breakdown' && resolved.hasSourceEntries && !/A\s*0/i.test(resolved.plan.space)
      && /承接上一组|继承上一组/.test(resolved.plan.space) && candidate.scene_id != null) {
      const previous = [...this.candidates.values()].find(row => row.shot_number === candidate.shot_number - 1 && row.scene_id === candidate.scene_id)
      const basis = previous?.video_prompt_plan?.space && this.inheritableSpaceBasis(previous.video_prompt_plan.space)
      if (basis) {
        const space = `${basis}${resolved.plan.space}`
        resolved.plan = { ...resolved.plan, space }
        candidate = { ...candidate, video_prompt_plan: { ...candidate.video_prompt_plan, space } }
      }
    }
    // Source dialogue identity and the camera's view are independent: a reaction
    // shot can carry the same speaker's synchronous dialogue from off camera.
    // Grant this only to exact source slots, never legacy/model-authored speech.
    // Explicit screenplay instructions to keep speech on screen win conservatively.
    const trustedSourceDialogueSlots = /画内(?:音|声|对白)?/u.test(this.originalScript) ? [] : resolved.sourceSlots.filter(slot => {
      const shot = resolved.plan!.shots.find(value => value.shot_number === slot.shotNumber)
      const speech = shot?.rows[slot.rowIndex]?.dialogue?.[slot.dialogueIndex]
      return speech?.kind === 'dialogue' && speech.speaker_id !== undefined
        && (candidate.character_ids || []).includes(speech.speaker_id)
        && assets.characters.some(character => character.id === speech.speaker_id)
        && !shot!.characters.some(character => character.character_id === speech.speaker_id && character.visibility !== 'offscreen')
    })
    const description = this.mode === 'breakdown' && (resolved.hasSourceEntries || !candidate.description?.trim())
      ? this.describePlan(resolved.plan, assets.characters, trustedSourceDialogueSlots) : candidate.description
    const rows = resolved.plan.shots.reduce((count, shot) => count + shot.rows.length, 0)
    const rowDuration = rows * 3
    const duration = this.mode === 'breakdown' && resolved.hasSourceEntries
      && Number.isFinite(candidate.duration) && candidate.duration! >= 8 && candidate.duration! <= 15
      && Math.ceil(candidate.duration! / 3) !== rows && rowDuration >= 8 && rowDuration <= 15
      ? rowDuration : candidate.duration
    const result = renderVideoPromptPlan(resolved.plan, {
      duration: duration ?? NaN,
      characters: assets.characters.map(character => ({ id: character.id, name: character.name, voiceReference: character.voiceAudioUrl?.trim() ? `#${character.name}` : undefined })),
      scenes: assets.scenes, props: assets.props,
      characterIds: candidate.character_ids || [], sceneId: candidate.scene_id, propIds: candidate.prop_ids || [], language: this.options.language,
      trustedSourceDialogueSlots,
    })
    this.planIssues.set(candidate.id, [...resolved.issues, ...result.issues].map(issue => ({ ...issue, storyboardId: candidate.id, shotNumber: candidate.shot_number })))
    this.planParticipants.set(candidate.id, result.participants)
    return { ...candidate, duration, description, video_prompt: result.prompt }
  }

  private inheritableSpaceBasis(space: string): string | null {
    const clauses = space.match(/[^，,。；;！？!?\n]+[，,。；;！？!?\n]?/gu) || []
    const hasOrigin = (value: string) => /A\s*0/i.test(value) && /原点|origin|基准|锚点/i.test(value)
    const hasAxis = (value: string, axis: 'X' | 'Y') => new RegExp(`\\b${axis}\\s*(?:轴|向|方向|的正方向|[- ]?axis|points?\\b|positive\\b)`, 'i').test(value)
    const selected = clauses.filter(value => hasOrigin(value) || hasAxis(value, 'X') || hasAxis(value, 'Y'))
    // Copy only the stated origin and axis clauses, never a previous character's
    // numeric position, posture or belongings. Ambiguous clauses are left alone.
    if (!selected.some(hasOrigin) || !selected.some(value => hasAxis(value, 'X')) || !selected.some(value => hasAxis(value, 'Y'))
      || selected.some(value => /A\s*[（(]\s*X|\b[XY]\s*[+-]\s*\d|站在|坐在|蹲在|持物|握着|面向|视线/u.test(value))) return null
    return selected.join('').trim().replace(/[，,；;]$/, '。')
  }

  private describePlan(plan: VideoPromptPlan, characters: Array<{ id: number; name: string }>,
    trustedSourceDialogueSlots: ReadonlyArray<{ shotNumber: number; rowIndex: number; dialogueIndex: number }> = []): string {
    const offCameraDialogue = new Set(trustedSourceDialogueSlots.map(slot => `${slot.shotNumber}:${slot.rowIndex}:${slot.dialogueIndex}`))
    const sentence = (value: string) => /[。.!！?？]$/.test(value.trim()) ? value.trim() : `${value.trim()}。`
    const quote = (value: string) => {
      for (const [open, close] of [['「', '」'], ['“', '”'], ['"', '"']]) if (!value.includes(open) && !value.includes(close)) return `${open}${value}${close}`
      return `「${value}」`
    }
    return plan.shots.map((shot, index) => {
      const pieces: string[] = index === 0 ? [sentence(plan.space)] : []
      for (const [rowIndex, row] of shot.rows.entries()) {
        pieces.push(sentence(row.visual))
        if (rowIndex === 0) for (const participant of shot.characters) {
          const name = characters.find(character => character.id === participant.character_id)?.name
          if (name && participant.visibility === 'face_visible' && participant.emotion) {
            pieces.push(`@${name}呈现${participant.emotion.expression}的神情（情绪${participant.emotion.intensity}%）。`)
          }
        }
        for (const [dialogueIndex, speech] of (row.dialogue || []).entries()) {
          const name = characters.find(character => character.id === speech.speaker_id)?.name
          const label = speech.kind === 'dialogue' ? offCameraDialogue.has(`${shot.shot_number}:${rowIndex}:${dialogueIndex}`)
            ? `画外音（同场对白）：${name}说` : name ? `${name}说` : '画内对白'
            : speech.kind === 'offscreen' ? `${name ? `${name}的` : ''}画外音` : `${name ? `${name}的` : ''}旁白`
          pieces.push(`${label}：${quote(speech.text)}`)
        }
      }
      return `【镜头${shot.shot_number}】${pieces.join(' ')}`
    }).join('\n')
  }

  private assets(executor: Executor = db) {
    const active = <T extends { deletedAt: string | null }>(rows: T[]) => rows.filter(row => !row.deletedAt)
    return {
      characters: active(executor.select().from(schema.characters).where(eq(schema.characters.dramaId, this.options.dramaId)).all()),
      scenes: active(executor.select().from(schema.scenes).where(eq(schema.scenes.dramaId, this.options.dramaId)).all()),
      props: active(executor.select().from(schema.props).where(eq(schema.props.dramaId, this.options.dramaId)).all()),
    }
  }

  private validateCandidates(executor: Executor = db): ValidationIssue[] {
    const assets = this.assets(executor)
    const issues: ValidationIssue[] = []
    for (const candidate of this.candidates.values()) {
      const identity = { storyboardId: candidate.id, shotNumber: candidate.shot_number }
      issues.push(...(this.planIssues.get(candidate.id) || []))
      if (this.options.validationProfile === 'skill-content') issues.push(...validateSkillStoryboard(candidate, assets, { mode: this.mode }).map(issue => ({ ...issue, ...identity })))
      else issues.push(...validateStoryboard({ ...identity, duration: candidate.duration ?? NaN, description: candidate.description || '',
        videoPrompt: candidate.video_prompt || '', characters: assets.characters, scenes: assets.scenes, props: assets.props,
        characterIds: candidate.character_ids || [], sceneId: candidate.scene_id, propIds: candidate.prop_ids || [],
        shotParticipants: this.planParticipants.get(candidate.id) }))
      if (candidate.scene_id != null && !assets.scenes.some(row => row.id === candidate.scene_id)) issues.push(this.issue('scene_binding', 'scene_id 不属于当前项目的有效场景', 'scene_id', candidate))
      if ((candidate.character_ids || []).some(id => !assets.characters.some(row => row.id === id))) issues.push(this.issue('character_binding', 'character_ids 含无效或跨项目角色', 'character_ids', candidate))
      if ((candidate.prop_ids || []).some(id => !assets.props.some(row => row.id === id))) issues.push(this.issue('prop_binding', 'prop_ids 含无效或跨项目道具', 'prop_ids', candidate))
      if (candidate.video_prompt?.includes('#')) {
        try { resolveVoiceMentions(candidate.video_prompt, assets.characters.map(row => ({ ...row, bound: (candidate.character_ids || []).includes(row.id) }))) }
        catch (error) { issues.push(this.issue('voice_reference', error instanceof Error ? error.message : '音色引用无效', 'video_prompt', candidate)) }
      }
    }
    return issues
  }

  private validateComplete(executor: Executor = db): ValidationIssue[] {
    const issues = [...this.validateCandidates(executor), ...this.operationIssues]
    if (!this.candidates.size) issues.push(this.issue('no_candidates', '本次没有暂存任何合格候选，旧稿保持不变'))
    if (this.mode === 'prompt') {
      if (!this.options.storyboardIds?.length) issues.push(this.issue('no_targets', '提示词任务没有指定目标分镜'))
      for (const id of this.options.storyboardIds || []) if (!this.candidates.has(id)) issues.push({ ...this.issue('target_not_updated', '该目标没有收到本次新的 video_prompt 候选', 'video_prompt'), storyboardId: id })
    } else {
      if (!this.replaceRequested) issues.push(this.issue('replace_required', '整集拆分没有首批 replace_existing:true 声明', 'replace_existing'))
      if (!this.finalBatchDeclared) issues.push(this.issue('final_batch_missing', '未声明最后一批；确认整集已覆盖后用 save_storyboards 的 is_final_batch:true 提交末批', 'is_final_batch'))
      const candidates = [...this.candidates.values()].sort((a, b) => a.shot_number - b.shot_number)
      if (candidates.some((row, index) => row.shot_number !== index + 1)) issues.push(this.issue('shot_sequence', '整集候选的 shot_number 必须从1连续递增，不能缺批次或跳号', 'shot_number'))
      const episode = executor.select().from(schema.episodes).where(eq(schema.episodes.id, this.options.episodeId)).get()
      const script = episode?.scriptContent || episode?.content || ''
      if (this.options.validationProfile === 'skill-content') {
        issues.push(...validateSkillDialogueCoverage(candidates, script, this.assets(executor).characters.map(row => row.name)))
        const units = splitScriptUnits(script), covered = new Set(candidates.flatMap(candidate => candidate.source_ids || []))
        for (const unit of units) if (!covered.has(unit.id)) issues.push(this.issue('source_coverage', `原文第${unit.id}段未被任何分镜组覆盖（包括动作与无台词段）。`, 'source_ids'))
        const budget = scriptTimingBudget(script), seconds = candidates.reduce((sum, candidate) => sum + (candidate.duration || 0), 0)
        // Same <1 s upper tolerance as the narrative plan check (round 3, user-approved).
        if (budget.characters && (seconds < budget.minimumSeconds || seconds > budget.maximumSeconds + TOTAL_DURATION_TOLERANCE_SECONDS - 1e-8)) issues.push(this.issue('duration_total_conflict', `总时长${seconds}秒不在skill字数估算范围${budget.minimumSeconds.toFixed(1)}—${budget.maximumSeconds.toFixed(1)}秒；保留草稿并明确解决约束冲突，不自动降级。`, 'duration'))
        return issues
      }
      const dialogue = extractScriptDialogue(script, this.assets(executor).characters.map(row => row.name))
        .map(line => compactText(line.text)).filter(Boolean)
      const sourceCandidates = candidates.map(candidate => ({ candidate, metadata: this.sourceDialogue.get(candidate.id) }))
      if (sourceCandidates.some(({ metadata }) => metadata?.hasSourceEntries)) {
        const seen = new Set<string>()
        const actual: Array<{ source_line: number; fragment_index: number }> = []
        for (const { candidate, metadata } of sourceCandidates) for (const ref of metadata?.sourceRefs || []) {
          const key = `${ref.source_line}:${ref.fragment_index}`
          if (seen.has(key)) issues.push(this.issue('source_duplicate', `原文片段${key}被重复使用；每个来源片段只能安排一次。`, 'video_prompt_plan', candidate))
          seen.add(key)
          actual.push(ref)
        }
        const hasLegacyDialogue = sourceCandidates.some(({ candidate, metadata }) => metadata
          ? metadata.hasLegacyDialogue : extractStoryboardDialogue(candidate.description || '').length > 0)
        if (!hasLegacyDialogue) {
          const assets = this.assets(executor)
          const guide = buildDialogueTimingGuide(extractScriptDialogue(this.originalScript, assets.characters.map(character => character.name)), assets.characters)
          const expected = guide.flatMap(line => line.fragments.map((_, index) => ({ source_line: line.source_line, fragment_index: index + 1 })))
          if (JSON.stringify(actual) !== JSON.stringify(expected)) issues.push(this.issue('source_coverage', '原文编号片段必须按原顺序完整且仅覆盖一次；请补齐遗漏片段或修正逆序，不能重复使用。', 'video_prompt_plan'))
        }
      }
      // Join only spoken fragments, so a long original line may legitimately span
      // shots/groups without camera directions interrupting the coverage match.
      const description = compactText(candidates.flatMap(row => extractStoryboardDialogue(row.description || '')).join(''))
      let cursor = 0
      for (let index = 0; index < dialogue.length; index++) {
        const position = description.indexOf(dialogue[index], cursor)
        if (position < 0) issues.push(this.issue('dialogue_coverage', `剧本第${index + 1}条可识别对白未按原词顺序完整覆盖；请核对漏段、删词或改词（不在错误中展开剧情）`, 'description'))
        else cursor = position + dialogue[index].length
      }
      if (!dialogue.length) issues.push({ ...this.issue('coverage_semantic_review', '未识别到可机械核对的对白，剧情、动作与收尾是否完整仍需人工复核；已检查末批声明和连续编号', 'description'), severity: 'warning' })
      const targetSeconds = compactText(script).length / 500 * 60
      const actualSeconds = candidates.reduce((sum, row) => sum + (row.duration || 0), 0)
      if (targetSeconds > 0 && Math.abs(actualSeconds - targetSeconds) / targetSeconds > 0.2) issues.push({ ...this.issue('duration_total_review', '总时长偏离字数估算目标超过20%，请复核叙事完整性；该估算不替代逐段台词容量判断', 'duration'), severity: 'warning' })
    }
    return issues
  }

  async finish(): Promise<{ saved: number; issues: ValidationIssue[] }> {
    if (this.finished) return { saved: this.saved, issues: this.getIssues() }
    const unavailable = this.available()
    if (unavailable) { this.failure([unavailable]); return { saved: 0, issues: this.getIssues() } }
    this.finishing = true
    try {
      await this.options.onPhase?.('validating')
      this.issues = this.validateComplete()
      if (this.cancelled || this.options.signal?.aborted) this.issues.push(this.issue('aborted', this.cancellationReason))
      if (this.issues.some(issue => issue.severity === 'error')) return { saved: 0, issues: this.getIssues() }
      await this.options.onPhase?.('saving')
      if (this.cancelled || this.options.signal?.aborted) { this.issues.push(this.issue('aborted', this.cancellationReason)); return { saved: 0, issues: this.getIssues() } }
      const saved = db.transaction(tx => {
        if (this.cancelled || this.options.signal?.aborted) throw new Error('storyboard_session_aborted')
        const current = readExisting(tx, this.options.episodeId)
        const episode = tx.select().from(schema.episodes).where(eq(schema.episodes.id, this.options.episodeId)).get()
        if (JSON.stringify(current) !== this.originalFingerprint || !episode || episode.deletedAt
          || (episode.scriptContent || episode.content || '') !== this.originalScript) throw new Error('storyboard_session_conflict')
        const finalIssues = this.validateComplete(tx)
        if (finalIssues.some(issue => issue.severity === 'error')) { this.issues = finalIssues; return 0 }
        const timestamp = now()
        if (this.mode === 'breakdown') {
          const allExisting = tx.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, this.options.episodeId)).all()
          for (const row of allExisting) {
            tx.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, row.id)).run()
            tx.delete(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, row.id)).run()
          }
          tx.delete(schema.storyboards).where(eq(schema.storyboards.episodeId, this.options.episodeId)).run()
        }
        for (const candidate of [...this.candidates.values()].sort((a, b) => a.shot_number - b.shot_number)) {
          if (this.cancelled || this.options.signal?.aborted) throw new Error('storyboard_session_aborted')
          if (this.mode === 'prompt') {
            tx.update(schema.storyboards).set({ videoPrompt: candidate.video_prompt, updatedAt: timestamp })
              .where(and(eq(schema.storyboards.id, candidate.id), eq(schema.storyboards.episodeId, this.options.episodeId), isNull(schema.storyboards.deletedAt))).run()
            continue
          }
          const result = tx.insert(schema.storyboards).values({ episodeId: this.options.episodeId, storyboardNumber: candidate.shot_number,
            title: candidate.title, shotType: candidate.shot_type, angle: candidate.angle, movement: candidate.movement,
            location: candidate.location, time: candidate.time, description: candidate.description, result: candidate.result,
            atmosphere: candidate.atmosphere, imagePrompt: candidate.image_prompt, videoPrompt: candidate.video_prompt,
            bgmPrompt: candidate.bgm_prompt, soundEffect: candidate.sound_effect, sceneId: candidate.scene_id,
            duration: candidate.duration, createdAt: timestamp, updatedAt: timestamp }).run()
          const id = getInsertId(result)
          for (const characterId of new Set(candidate.character_ids || [])) tx.insert(schema.storyboardCharacters).values({ storyboardId: id, characterId }).run()
          for (const propId of new Set(candidate.prop_ids || [])) tx.insert(schema.storyboardProps).values({ storyboardId: id, propId }).run()
          this.linkAssets(tx, candidate, timestamp)
        }
        if (this.mode === 'breakdown') {
          const total = [...this.candidates.values()].reduce((sum, row) => sum + (row.duration || 0), 0)
          tx.update(schema.episodes).set({ duration: Math.ceil(total / 60), updatedAt: timestamp }).where(eq(schema.episodes.id, this.options.episodeId)).run()
        }
        this.commitHook?.()
        return this.candidates.size
      })
      this.saved = saved
      this.finished = saved > 0
      return { saved, issues: this.getIssues() }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      this.issues.push(this.issue(message === 'storyboard_session_aborted' ? 'aborted' : message === 'storyboard_session_conflict' ? 'concurrent_edit' : 'commit_failed',
        message === 'storyboard_session_aborted' ? '任务已中止，旧稿保持不变' : message === 'storyboard_session_conflict' ? '分镜在生成期间被其他操作修改，已阻止覆盖；请重新读取后重试' : '候选稿事务提交失败，已回滚，旧稿保持不变'))
      return { saved: 0, issues: this.getIssues() }
    } finally { this.finishing = false }
  }

  private linkAssets(executor: Executor, candidate: StoredCandidate, timestamp: string) {
    if (candidate.scene_id != null && !executor.select().from(schema.episodeScenes).where(and(eq(schema.episodeScenes.episodeId, this.options.episodeId), eq(schema.episodeScenes.sceneId, candidate.scene_id))).get()) {
      executor.insert(schema.episodeScenes).values({ episodeId: this.options.episodeId, sceneId: candidate.scene_id, createdAt: timestamp }).run()
    }
    for (const characterId of new Set(candidate.character_ids || [])) if (!executor.select().from(schema.episodeCharacters).where(and(eq(schema.episodeCharacters.episodeId, this.options.episodeId), eq(schema.episodeCharacters.characterId, characterId))).get()) {
      executor.insert(schema.episodeCharacters).values({ episodeId: this.options.episodeId, characterId, createdAt: timestamp }).run()
    }
    for (const propId of new Set(candidate.prop_ids || [])) if (!executor.select().from(schema.episodeProps).where(and(eq(schema.episodeProps.episodeId, this.options.episodeId), eq(schema.episodeProps.propId, propId))).get()) {
      executor.insert(schema.episodeProps).values({ episodeId: this.options.episodeId, propId, createdAt: timestamp }).run()
    }
  }
}

export function createStoryboardSession(options: StoryboardSessionOptions): StoryboardSession { return new StoryboardSession(options) }
