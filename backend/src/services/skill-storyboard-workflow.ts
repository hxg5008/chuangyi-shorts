import { createHash } from 'node:crypto'
import { z } from 'zod'
import { createSkillStoryboardAgent, type SkillStoryboardExecutionOptions } from '../agents/index.js'
import { loadAgentSkills } from '../agents/skills.js'
import { loadAgentPromptFile } from '../agents/prompts.js'
import { buildLanguageDirective } from '../agents/language.js'
import { getVoiceReferenceInstructions } from '../agents/voice-reference-instructions.js'
import { storyboardTools } from '../agents/tools/storyboard-tools.js'
import { runAgentText } from './agent-text-stream.js'
import { extractTextProviderFailure } from './text-provider-http.js'
import {
  buildCompleteStoryboardSchema, buildNarrativePlanSchema, buildScriptUnitSpeechBudgets, compileStoryboardReferences, splitScriptUnits,
  scriptTimingBudget, storyboardGroupBudget, validateNarrativePlan, validateStoryboardAssets, type NarrativePlan, type NarrativeGroup, type StoryboardContractAssets
} from './skill-storyboard-contract.js'
import { skillDescriptionShots, validateSkillStoryboard, type SkillCandidate } from './skill-storyboard-validation.js'
import type { StoryboardSession, ValidationIssue } from './storyboard-session.js'
import type { StoryboardDraftStore, StoryboardDraft, DraftGroup } from './storyboard-draft-store.js'
import type { CompiledSkillInstructions } from './skill-instruction-compiler.js'
import { compileSkillWorkflowInstructions } from './skill-workflow-protocol.js'
import { buildPackedExpandContext, packStoryboardRequests, type StoryboardModelLimits } from './storyboard-request-packing.js'
import { logTaskProgress } from '../utils/task-logger.js'
import { buildStoryboardPlanningConstraints } from './storyboard-plan-guidance.js'
import { applyTargetedRepair, createTargetedRepair, feasibleShotCounts, type TargetedRepairPlan } from './storyboard-targeted-repair.js'
import { buildVoiceCueSchema, compileStoryboardVoices, type VoiceProfiles } from './storyboard-voice-cues.js'
import {
  assignmentSpeech, chooseSharedLineSpeech, sharedSpokenSourceIds, speechAssignmentPayload, validateSpeechAssignment,
  type SharedLineAssignment,
} from './storyboard-shared-lines.js'
import { planEntries, reconcileDraftGroups } from './storyboard-plan-reconcile.js'
import { missingOwnSpeech } from './storyboard-source-gaps.js'
import { normalizeSubmission, normalizePlanSubmission, normalizeRepairPatch } from './storyboard-format-normalize.js'
import { EXPAND_RHYTHM_NOTE, PLAN_RHYTHM_NOTE, productionNoteIds, rhythmFacts } from './storyboard-rhythm.js'
import { VOICE_CARD_NOTE, voiceCardFacts, voiceCardProfiles } from './character-voice-card.js'
import { boundaryVersion, isAdjacentBoundaryConflict, isCompleteBoundaryCandidate, prepareBoundaryRepair, validateBoundaryRepairScope } from './storyboard-boundary-repair.js'
import { analyzeScriptBody } from './script-body-budget.js'

type Phase = 'generating' | 'validating' | 'repairing'
export interface WorkflowRequestStat {
  stage: string; groups: number[]; inputCharacters: number; instructionCharacters: number
  elapsedMs: number; streamCompleted: boolean; outputCharacters?: number; requestTimeoutMs: number
  finishReason?: string
  profile?: string; thinkingPolicy?: string; maxOutputTokens?: number; recoveryAttempt?: number; errorCode?: string
  repairScope?: 'fields' | 'video_rows' | 'group'; repairFields?: string[]
  inputTokens?: number; outputTokens?: number; reasoningTokens?: number
}
type Instructions = {
  plan: string; expand: string; prompt: string; modelHint?: string
  compiled?: Partial<Record<'plan' | 'expand' | 'prompt' | 'repair', CompiledSkillInstructions>>
}
export interface SkillWorkflowOptions {
  episodeId: number; dramaId: number; mode: 'breakdown' | 'prompt'; storyboardIds?: number[]
  requestContext: any; session: StoryboardSession; message: string; signal?: AbortSignal
  onState?: (phase: Phase, attempt: number) => void
  onProgress?: (progress: { draft_id: string; total: number; completed: number; failed: number; current_group?: number }) => void
}
export interface SkillWorkflowDependencies {
  store: StoryboardDraftStore
  readContext?: (context: any) => Promise<any>
  createAgent?: (stage: 'plan' | 'expand' | 'prompt', instructions: string, responseSchema: Record<string, unknown>, execution?: SkillStoryboardExecutionOptions) => any | Promise<any>
  loadInstructions?: () => Promise<Instructions>
  timeoutMs?: number
  requestTimeoutMs?: number
  modelIdentity?: unknown
  loadModelIdentity?: () => Promise<unknown>
  loadProjectStyle?: () => Promise<string>
  batchSize?: 1 | 2
  modelLimits?: StoryboardModelLimits
  /** Dependency override for isolated legacy/transport tests; production recovers automatically. */
  automaticRecovery?: boolean
  /** Isolated comparison fixtures may retain the legacy full-group repair path. */
  targetedRepairs?: boolean
  /** Legacy fixtures may compare the previous free-prose transport explicitly. */
  voiceContract?: boolean
  recoveryDelayMs?: number
}
const transport = `执行适配：读取、批次推进、保存及技能内的检查由本次工作流协调。你只输出当前阶段要求的完整JSON对象，不调用读写工具，不输出JSON外的解释。JSON是传输封装，成品正文必须完整遵守上方skill，不能因封装省略任何适用内容。不得以通过程序检查为由删除剧情、缩短必需表演或放宽skill硬要求。`
const responseEnvelope = `传输最外层只有output键：正常时output为本阶段完整成品或规划；确实缺资料或skill规则无法同时满足时，output为{conflict:具体冲突说明,field:冲突字段,source_ids:相关原文ID数组}。这是一条合法的报告通道，不能为填满成品而编造事实、删减原文或偷偷降低规则。`
const packingNotes = `输入说明：source_units是本次范围内逐字保留的原文，source_speech_budgets仅补充口播数字，不另抄原文；asset_catalog列出全部合法ID、正式名与可用音色，asset_facts保留本次必要的完整资料。资料范围筛选不等于资产绑定，请按实际内容选择合法ID。previous_ending中的result、description_last_shot及video_context是上一组已生成的末态与空间/声线承接资料，不能把整段动作重新演一遍。`
const batchNotes = `本次按current_groups顺序创作相邻的两组。每组先设计完整description，再写与它逐镜对应的完整video_prompt，其他成品字段全部保留；同批第二组承接本次第一组的新末态，不把外部previous_ending重复当第二组初态。output为{storyboards:[本批各组完整成品]}，按shot_number对应给定组，不能合并两组、额外加组或省略任一组。某一组确有冲突时，该项可为{shot_number,conflict,field,source_ids}，仍提交另一组完整结果。`
const references = `正文素材引用使用唯一的内部token：[[character:角色ID]]、[[scene:场景ID]]、[[prop:道具ID]]。只选给定素材表的ID，不手写@名字；程序会无损转换为正式@名称并同步绑定。画内对白显式写作[[character:说话者ID]]说：「原词」，语气及动作在该说话标记之前，不能只用“他/她……说”省略归属。没有has_voice:true及实际voice_reference的角色绝不添加#音色标签，仍用角色token标明说话者并写声音描述；有可用音色才复制其voice_reference。台词引号内的原文逐字保留，不插入或解释token，不改自然称呼。任何对白、旁白或画外音的原词包含@、#或[[标记时，用匹配引号包住该段原词，保留引号内每个字和标点，避免把原词解释为引用。没有对应素材的普通物品用原名称，不强造素材。`
const complete = `按照已批准的本组叙事规划，先写完整description，再从相同事实写完整video_prompt；同时完整填写time、location、shot_type、angle、movement、result、atmosphere、image_prompt、bgm_prompt、sound_effect等成品字段。所有适用的坐标、人物状态、动作链、逐人表情强度、声音、光线与承接必须写入最终自然语言正文。不能只交概括或内部清单。image_prompt是首镜单帧，bgm_prompt为无背景音乐，无额外音效可明确写无额外音效。不设凑字数下限；video_prompt上限3600字符，先删重复修饰而非原词、过程或必需资料。
时长与场景来自模型按叙事节拍提出的本组规划；子镜头数由你在本轮完整description中按动作和发声实际设计为2—4个，不能被大纲预设镜数限制。先写好这套完整子镜头，再写video_prompt，提示词转换时不能增删或重排description里的镜头。按自然分句分配台词，不按固定字数切句，不截断词语；一句长句的自然分句在同一子镜的连续时间行内承接，不能只为填满镜头数在句中切镜。视频时间行以3秒递进，最后用实际余量；time_row_counts由你按实际子镜头选择，每镜1或2行，总和等于ceil(duration/3)，对应子镜头实际时长仍须2—6秒。该数组只是镜头与时间行的明确对应，不是正文模板。切镜仅发生在你已经设计的子镜头边界，正文里不新增第二套镜头。
原文ID用于核对覆盖范围：source_ids与本组规划相同，不能只保对白而遗漏动作或收尾；相邻组使用本次新稿末态承接。若previous_group_state不是ready，必须从原文及已批准规划确定承接，确实无法确定时走conflict通道，不臆造上一组已完成的动作。skill中的保存前检查在本轮生成内完成，不追加独立审稿请求。`

async function instructionsFor(options: SkillWorkflowOptions): Promise<Instructions> {
  const language = options.requestContext.get('language') || 'zh'
  const [storyboard, video, base] = await Promise.all([
    loadAgentSkills('storyboard_breaker', language), loadAgentSkills('prompt_generator', language, ['prompt-generator/video-prompt']),
    loadAgentPromptFile(options.mode === 'breakdown' ? 'storyboard_breaker' : 'prompt_generator', language),
  ])
  if (!video || options.mode === 'breakdown' && !storyboard) throw new Error('缺少所需的 storyboard-breaker 或 video-prompt SKILL.md；请恢复技能文件后重试，未请求模型。')
  const languageText = buildLanguageDirective(language)
  const voice = getVoiceReferenceInstructions(options.mode === 'breakdown' ? 'storyboard_breaker' : 'prompt_generator', language)
  const sceneFacts = 'scenes中的reference_image_prompt是现有场景参考图的描述资料，仅取其中已经确定的空间布局、门窗出口、陈设及光源事实；四宫格、多视图、文字标签、无人等图片呈现要求不带入视频。空间初态应以这些已有事实为准。'
  const common = [base?.instructions, storyboard, video, voice, languageText, sceneFacts].filter(Boolean).join('\n\n')
  const raw: Instructions = {
    modelHint: base?.model || '',
    plan: [storyboard, languageText, sceneFacts, transport, '本次只规划整集叙事节拍、各组原文范围、场景与时长，不预先锁定子镜数量或时间行布局，不写成品正文。依完整原文的因果链、换场、过渡、叙事与爆点分组，覆盖所有source_ids（包括无台词动作），不要每句对白一组。时长同时满足8—15秒、功能节奏、台词容量及总量±20%。source_speech_budgets已给出原句及可识别口播字数，单位最低口播时间只算字数/4.5，另给每个有声组留2秒表演余量；这些是输入事实，不是固定分组或切句方案。无法同时满足时明确保留冲突，不删剧情。只输出groups。'].join('\n\n'),
    expand: [common, transport, references, complete].join('\n\n'),
    prompt: [base?.instructions, video, voice, languageText, sceneFacts, transport, references,
      '本次只为指定的锁定分镜生成完整video_prompt及time_row_counts。不修改description、时长、镜头、场景或绑定。逐镜补齐skill适用内容，原词逐字保留，不能加镜头或用省略来规避冲突。'].filter(Boolean).join('\n\n'),
  }
  const source = (name: string, text?: string) => ({ source: name, text: text || '' })
  const baseSource = source(`prompts/${options.mode === 'breakdown' ? 'storyboard_breaker' : 'prompt_generator'}.md`, base?.instructions)
  const storyboardSource = source('skills/storyboard-breaker (including loaded children)', storyboard)
  const videoSource = source('skills/prompt-generator/video-prompt (including loaded children)', video)
  const voiceSource = source('voice-reference-instructions', voice)
  const languageSource = source('content-language', languageText)
  const sceneSource = source('existing-scene-facts', sceneFacts)
  const transportSource = source('workflow-transport', transport)
  const referenceSource = source('typed-asset-references', references)
  const planPrefix = [storyboard, languageText, sceneFacts, transport].join('\n\n')
  const promptPrefix = [base?.instructions, video, voice, languageText, sceneFacts, transport, references].filter(Boolean).join('\n\n')
  raw.compiled = {
    plan: compileSkillWorkflowInstructions([storyboardSource, languageSource, sceneSource, transportSource,
      source('narrative-plan-stage', raw.plan.slice(planPrefix.length + 2))], 'plan'),
    expand: compileSkillWorkflowInstructions([baseSource, storyboardSource, videoSource, voiceSource, languageSource, sceneSource,
      transportSource, referenceSource, source('complete-storyboard-stage', complete)], 'expand'),
    prompt: compileSkillWorkflowInstructions([baseSource, videoSource, voiceSource, languageSource, sceneSource, transportSource,
      referenceSource, source('locked-video-prompt-stage', raw.prompt.slice(promptPrefix.length + 2))], 'prompt'),
    repair: compileSkillWorkflowInstructions([baseSource, ...(options.mode === 'breakdown' ? [storyboardSource] : []), videoSource,
      voiceSource, languageSource, sceneSource, transportSource, referenceSource,
      source('targeted-repair-stage', '本次返修响应只包含base_version和changes；以请求指定的补丁schema和可改字段为准。只修具体错误，保持其他原词、叙事、镜头、时长、绑定、空间、声线、光线和末态；不能把正文换成摘要或说明。完整成品字段与内容规范在协调器合并补丁后仍逐项检查。')], 'repair'),
  }
  return raw
}
function wireSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input', target: 'draft-7' }) as Record<string, any>
  const close = (value: any): any => {
    if (Array.isArray(value)) return value.map(close)
    if (!value || typeof value !== 'object') return value
    const result = Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$schema').map(([key, child]) => [key, close(child)])) as Record<string, any>
    if (result.type === 'object' || result.properties) { result.additionalProperties = false; result.required = Object.keys(result.properties || {}) }
    return result
  }
  return close(json)
}
const errorIssue = (code: string, message: string, field = 'workflow', shotNumber?: number): ValidationIssue => ({ code, message, field, severity: 'error', ...(shotNumber ? { shotNumber } : {}) })
const stored = (group?: DraftGroup): { raw?: unknown; data?: SkillCandidate | null; preview?: unknown; previous_raw?: unknown } => group?.candidate && typeof group.candidate === 'object' ? group.candidate as any : {}
const assetFacts = (rows: any[]) => rows.map(({ image_url: _image, reference_images: _references, ...facts }) => facts)
function timingChoices(duration: number, lockedShotCount?: number) {
  const choices: number[][] = []
  for (const shotCount of lockedShotCount ? [lockedShotCount] : [2, 3, 4]) {
    for (let mask = 0; mask < 2 ** shotCount; mask++) {
      const counts = Array.from({ length: shotCount }, (_, index) => 1 + (mask >> index & 1))
      let row = 0
      if (counts.every(count => { const seconds = Math.min((row + count) * 3, duration) - row * 3; row += count; return seconds >= 2 && seconds <= 6 }) && row === Math.ceil(duration / 3)) choices.push(counts)
    }
  }
  return choices
}
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort: () => void
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason || new Error('任务已中止')); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort() })
  try { return await Promise.race([work, cancelled]) } finally { signal.removeEventListener('abort', abort!) }
}

function workflowFailure(error: unknown) {
  const failure = extractTextProviderFailure(error)
  const code = (error as any)?.code
  return { ...failure, code: code === 'TEXT_RESPONSE_JSON' ? 'response_json'
    : code === 'TEXT_RECOVERY_LIMIT' ? 'recovery_limit' : failure.code }
}
/**
 * Round 3 R1 (2026-11-08, user-approved "按你建议来"): a relay answering that it has no account/channel for the model
 * right now ("Model … is not supported by any configured account in this group", HTTP 404/503 from a pooled relay) is
 * a temporary pool state, not a configuration error: in the verification runs 9 of 19 clicks stopped on exactly one
 * such answer and the same model answered normally seconds later. It is retried like other transient failures; three
 * in a row still open the circuit. Key, permission and balance errors stay fatal.
 */
function relayPoolUnavailable(failure: { message: string; statusCode?: number }) {
  return /not supported by any configured account|no available (?:account|channel)s?|无可用(?:账号|账户|渠道)|当前分组(?:下)?无可用/iu.test(failure.message)
}
function fatalProviderFailure(failure: ReturnType<typeof workflowFailure>) {
  if (relayPoolUnavailable(failure)) return false
  return Boolean(failure.statusCode && [400, 401, 402, 403, 404, 422].includes(failure.statusCode))
    || /insufficient[_ ](?:quota|credit)|余额不足|额度余额|账户余额|无效.*(?:密钥|key)/iu.test(failure.message)
}
function transientProviderFailure(failure: ReturnType<typeof workflowFailure>) {
  return failure.code === 'network_error' || failure.statusCode === 408 || failure.statusCode === 409
    || failure.statusCode === 429 || Boolean(failure.statusCode && failure.statusCode >= 500)
    || /当前文本请求已到等待上限/u.test(failure.message) || relayPoolUnavailable(failure)
}
async function recoveryPause(ms: number, signal: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await bounded(new Promise<void>(resolve => { timer = setTimeout(resolve, ms) }), signal) }
  finally { if (timer) clearTimeout(timer) }
}

/** Keep one durable task alive through bounded request recovery and targeted group repairs. */
export async function runSkillStoryboardWorkflow(options: SkillWorkflowOptions, dependencies: SkillWorkflowDependencies) {
  const controller = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  // Round 3: 90 minutes for the whole run (was 60). Slower text models already used 44 of the 60 minutes; with the
  // budget-based request wait a full episode needs more room. Drafts are kept either way and can be continued.
  const timer = setTimeout(() => controller.abort(new Error('本次生成已到时间上限，逐组草稿已保存，可继续生成')), dependencies.timeoutMs ?? 90 * 60_000); timer.unref?.()
  let draftId: string | undefined, leaseToken: string | undefined, modelCalls = 0, repairCalls = 0
  const requestStats: WorkflowRequestStat[] = []
  const store = dependencies.store
  const cancel = () => options.session.cancel('生成已中止，现行版保持不变，草稿可恢复')
  signal.addEventListener('abort', cancel, { once: true })
  const progress = (current?: number) => {
    const draft = draftId ? store.get(draftId) : null
    if (draft) options.onProgress?.({
      draft_id: draft.id, total: draft.groups.length, completed: draft.groups.filter(group => group.status === 'ready').length,
      failed: draft.groups.filter(group => ['needs_revision', 'error'].includes(group.status)).length, ...(current ? { current_group: current } : {})
    })
  }
  const result = (status: 'done' | 'needs_revision', saved: number, issues: ValidationIssue[]) => ({
    status, saved, issues, attempt: repairCalls ? 1 : 0,
    draft_id: draftId, result: { modelCalls, repairCalls, requestStats, autoRecoveryCalls: requestStats.filter(stat => stat.profile === 'recovery').length }, candidateReport: options.session.getReport()
  })
  try {
    const context = await bounded(Promise.resolve(dependencies.readContext ? dependencies.readContext(options.requestContext)
      : (storyboardTools.readStoryboardContext.execute as any)({}, { requestContext: options.requestContext })), signal)
    if (context?.error || !context?.script?.trim()) return result('needs_revision', 0, [errorIssue('context_missing', '当前集缺少可用剧本或上下文。')])
    const assets: StoryboardContractAssets = { characters: context.characters || [], scenes: context.scenes || [], props: context.props || [] }
    const inputIssues = validateStoryboardAssets(assets)
    const timing = scriptTimingBudget(context.script)
    if (options.mode === 'breakdown' && timing.maximumSeconds < 8) inputIssues.push(errorIssue('constraint_conflict', `剧本正文估算上限${timing.maximumSeconds.toFixed(2)}秒，小于skill最小单组8秒；需先明确正文/时长规则冲突。`, 'duration'))
    if (inputIssues.some(issue => issue.severity === 'error')) return result('needs_revision', 0, inputIssues)
    const texts = await bounded(dependencies.loadInstructions ? dependencies.loadInstructions() : instructionsFor(options), signal)
    const projectStyle = dependencies.loadProjectStyle ? await bounded(dependencies.loadProjectStyle(), signal) : context.project_style || ''
    const facts = {
      episode: context.episode, script: context.script, project_style: projectStyle,
      characters: assetFacts(assets.characters), scenes: assetFacts(assets.scenes), props: assetFacts(assets.props)
    }
    const modelIdentity = dependencies.loadModelIdentity ? await bounded(dependencies.loadModelIdentity(), signal) : dependencies.modelIdentity ?? { config: options.requestContext.get('textConfigId'), model: options.requestContext.get('modelOverride') }
    // Packing and exact deduplication do not change the source contract. Keep
    // existing same-context drafts resumable rather than regenerating ready prose.
    const { compiled: _compiled, ...identityTexts } = texts
    const fingerprint = createHash('sha256').update(JSON.stringify({
      version: 'skill-content-v1', task: options.message, facts, texts: identityTexts,
      original: options.session.getContextFingerprint(), model: modelIdentity, language: options.requestContext.get('language'),
      ...(options.mode === 'prompt' ? { orderedTargets: options.storyboardIds || [] } : {})
    })).digest('hex')
    const started = store.startOrResume({ episodeId: options.episodeId, dramaId: options.dramaId, mode: options.mode, scope: options.storyboardIds || [], fingerprint })
    draftId = started.draft.id; leaseToken = started.leaseToken; progress()
    const automaticRecovery = dependencies.automaticRecovery !== false
    const voiceContract = dependencies.voiceContract !== false
    let voiceProfiles: VoiceProfiles = {}
    // Fixed voices start from the characters' voice cards (the same in every
    // episode), then come from finished (ready) groups for voices without a
    // card. Rebuilt whenever a finished group is sent back, so discarded prose
    // never constrains others.
    const cardProfiles = voiceCardProfiles(context.characters || [])
    const cardFacts = voiceCardFacts(context.characters || [])
    const rebuildVoiceProfiles = () => {
      voiceProfiles = structuredClone(cardProfiles)
      for (const entry of store.get(draftId!)!.groups.filter(entry => entry.status === 'ready')) {
        const retained = stored(entry).raw
        const compiled = compileStoryboardVoices(retained, { assets, profiles: voiceProfiles, language: options.requestContext.get('language') || 'zh' })
        if (!compiled.issues.length) voiceProfiles = compiled.profiles
      }
    }
    rebuildVoiceProfiles()
    const createAgent = dependencies.createAgent || ((stage, instructions, schema, execution) => createSkillStoryboardAgent(stage === 'prompt' ? 'prompt_generator' : 'storyboard_breaker', instructions, schema, execution))
    const configuredBudget = Number(process.env.AI_MAX_TOKENS || 16_384)
    const baseOutputBudget = Number.isInteger(configuredBudget) && configuredBudget >= 1024 && configuredBudget <= 65_536 ? configuredBudget : 16_384
    const selectedModel = options.requestContext.get('modelOverride') || texts.modelHint
      || (typeof modelIdentity === 'string' ? modelIdentity : (modelIdentity as any)?.model) || ''
    const deepSeek = /deepseek/iu.test(String(selectedModel))
    const requestCounts = new Map<number, number>()
    const requestFailures = new Map<number, unknown[]>()
    let planningRequests = 0, consecutiveProviderFailures = 0, providerCircuitOpen = false
    const executionFor = (stage: string, recovery: boolean, transportRecovery: boolean, qualityRepair: boolean): SkillStoryboardExecutionOptions => ({
      profile: recovery ? 'recovery' : deepSeek && stage === 'plan' ? 'direct' : 'standard',
      ...(deepSeek ? { thinking: transportRecovery || stage === 'plan' && !qualityRepair ? 'disabled' as const : 'low' as const } : {}),
      maxOutputTokens: recovery ? Math.min(65_536, Math.max(32_768, baseOutputBudget * 2))
        : deepSeek && stage !== 'plan' ? Math.min(65_536, Math.max(32_768, baseOutputBudget)) : baseOutputBudget,
    })
    const ask = async (stage: 'plan' | 'expand' | 'prompt', schema: z.ZodType, payload: unknown, forceRecovery = false, qualityRepair = false, targeted?: TargetedRepairPlan) => {
      const content = JSON.stringify(payload), body = payload as any
      const requestInstructions = [targeted ? texts.compiled?.repair?.instructions || texts[stage] : texts.compiled?.[stage]?.instructions || texts[stage], responseEnvelope,
        stage === 'plan' ? `原文只在source_units中提供一次；source_speech_budgets仅为对应原文的口播算数，不是另一份台词。优先让整集总时长接近timing_budget.targetSeconds，同时遵守planning_constraints.timing中预计组数的±20%整数范围；总时长合格不能代替组数合格。不主动贴上界，规则冲突时明确报告，不删原文或缩掉必要表演。按真实转折区分爆点与普通叙事。\n${PLAN_RHYTHM_NOTE}` : `${packingNotes}${stage === 'expand' && !targeted ? `\n\n${EXPAND_RHYTHM_NOTE}` : ''}`,
        body.boundary_repair ? body.boundary_repair.instruction : body.current_groups?.length > 1 ? batchNotes : '', targeted?.payload.instruction || '',
        voiceContract && stage !== 'plan' ? '本阶段采用完整声音资料合同。完整创作或视频转换返回voice_cues，每个实际发声子镜头的每名发声者各一项，包含固定profile(age年龄感、register音域、timbre核心音色，组合15—30字符)和state当前身体状态、goal发声目的、volume音量、rate_cps正数语速、breath气息、tail尾音、emotion情绪。复用voice_profiles中同人的固定声线，未见资料时依据已知年龄和人设保守设计；这只是文本声音设计，不能声称已绑定真实音色。正常完整分镜的description和video_prompt使用同一cue的[[voice:v1]]：「逐字原词」明确发声位置，cue.shot对应真实子镜号；锚点替代原来的角色说/她说等发声标签，不在原词内插标记，不省略旁白和画外声音。video每cue首处由后台把完整声音资料写进自然正文，同镜后续原词仍明确归属；因此raw正文不重复写另一套声线，不用同上代替资料。声音展开后video_prompt仍须不超过3600字符，保留全部视觉动作与原词。没有实际发声则voice_cues为空数组，视觉文字不变成台词。局部补丁保持原voice_cues和锚点，除非本次schema明确授权修改；本次补丁没有voice_cues字段时不要额外回传。' : ''].filter(Boolean).join('\n\n')
      const scopedInstructions = voiceContract && stage !== 'plan'
        ? `${requestInstructions}\n声音字段值只写具体内容，不重复字段标签；state只描述发声当下的身体与呼吸状态，不在声音段重演已写动作，也不提前宣布后续动作或结果。锚点前不要再写角色名或“X说：”，锚点本身就会生成说话人标签。${cardFacts.length ? `\n${VOICE_CARD_NOTE}` : ''}`
        : requestInstructions
      const groupNumbers: number[] = (body.current_groups || (body.current_group ? [body.current_group] : [])).map((group: any) => group.number as number)
      // A boundary repair has its own durable two-attempt limit. Do not turn
      // one repair into multiple transport submissions or consume plan slots.
      const maxTries = automaticRecovery && !body.boundary_repair ? 2 : 1
      for (let recoveryAttempt = 0; recoveryAttempt < maxTries; recoveryAttempt++) {
        signal.throwIfAborted()
        if (automaticRecovery && (providerCircuitOpen || !body.boundary_repair && (groupNumbers.some(number => (requestCounts.get(number) || 0) >= 4) || !groupNumbers.length && planningRequests >= 4))) {
          throw Object.assign(new Error('自动处理已达到本次有界恢复上限，现有完整草稿已保留。'), { code: 'TEXT_RECOVERY_LIMIT' })
        }
        for (const number of groupNumbers) requestCounts.set(number, (requestCounts.get(number) || 0) + 1)
        if (!groupNumbers.length) planningRequests++
        const recovery = forceRecovery || recoveryAttempt > 0
        const execution = automaticRecovery ? executionFor(stage, recovery, recoveryAttempt > 0, qualityRepair) : undefined
        signal.throwIfAborted(); modelCalls++
        const startedAt = performance.now()
        // Round 3 (2026-11-08): the wait follows the request's own output budget. A flat 5 minutes cut off slower
        // models while they were still thinking (16 of 18 cut requests had produced no visible text yet; successful
        // long requests began writing at 2–5 minutes). About 22 s per 1,000 budget tokens, 6–10 minutes.
        const outputBudget = execution?.maxOutputTokens || baseOutputBudget
        const requestTimeoutMs = dependencies.requestTimeoutMs ?? Math.min(10 * 60_000, Math.max(6 * 60_000, Math.round(outputBudget * 22)))
          * Math.max(1, Math.min(2, groupNumbers.length))
        const stat: WorkflowRequestStat = {
          stage, groups: groupNumbers, profile: execution?.profile || 'standard', thinkingPolicy: execution?.thinking || 'configured',
          maxOutputTokens: execution?.maxOutputTokens || baseOutputBudget, recoveryAttempt,
          ...(targeted ? { repairScope: targeted.scope, repairFields: targeted.fields } : body.directed_repair ? { repairScope: 'group' as const } : {}),
          inputCharacters: content.length, instructionCharacters: scopedInstructions.length, elapsedMs: 0, streamCompleted: false, requestTimeoutMs
        }
        requestStats.push(stat)
        const requestController = new AbortController()
        const requestSignal = AbortSignal.any([signal, requestController.signal])
        const requestTimer = setTimeout(() => requestController.abort(new Error('当前文本请求已到等待上限，已保留此前草稿。')), requestTimeoutMs)
        requestTimer.unref?.()
        let partialText = ''
        try {
          const schemaWithConflict = z.object({ output: z.union([schema, z.object({ conflict: z.string().min(1), field: z.string().min(1), source_ids: z.array(z.number().int().positive()) }).strict()]) }).strict()
          const agent = await bounded(Promise.resolve(createAgent(stage, scopedInstructions, wireSchema(schemaWithConflict), execution)), requestSignal)
          const full = await bounded(runAgentText(agent, [{ role: 'user', content }], {
            textMode: 'stream', requestContext: options.requestContext, abortSignal: requestSignal, stopWhen: ({ steps }: { steps: unknown[] }) => steps.length >= 1,
          }), requestSignal)
          signal.throwIfAborted()
          stat.streamCompleted = true
          partialText = typeof full?.text === 'string' ? full.text : ''
          stat.outputCharacters = partialText.length
          const usage = full?.totalUsage || full?.usage
          const tokens = (...values: unknown[]) => values.find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0)
          stat.inputTokens = tokens(usage?.inputTokens, usage?.promptTokens)
          stat.outputTokens = tokens(usage?.outputTokens, usage?.completionTokens)
          stat.reasoningTokens = tokens(usage?.reasoningTokens, usage?.outputTokenDetails?.reasoningTokens)
          stat.finishReason = typeof full?.finishReason === 'string' ? full.finishReason : undefined
          if (stat.finishReason === 'length') throw Object.assign(new Error('文本模型达到单次输出上限，未返回完整成品；已保留此前草稿。'), { code: 'TEXT_OUTPUT_LIMIT' })
          if (!partialText.trim()) throw Object.assign(new Error('文本模型已结束但未返回正文；已保留此前草稿。'), { code: 'TEXT_EMPTY_RESPONSE' })
          let parsed: any
          try {
            const jsonText = partialText.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu, '$1')
            parsed = JSON.parse(jsonText)
          } catch {
            if (automaticRecovery) throw Object.assign(new Error('文本模型未返回完整JSON，完整响应已保留用于本次自动恢复。'), { code: 'TEXT_RESPONSE_JSON' })
            return { raw: { incomplete_response: partialText }, issues: [errorIssue('response_json', '模型未返回完整JSON；该响应已存为草稿，不自动切换模式重发。')], conflict: false }
          }
          const raw = parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'output') ? parsed.output : parsed
          const conflict = raw && typeof raw === 'object' && typeof raw.conflict === 'string' && raw.conflict.trim()
          consecutiveProviderFailures = 0
          return { raw, issues: conflict ? [errorIssue('model_constraint_conflict', raw.conflict, typeof raw.field === 'string' ? raw.field : 'workflow')] : [] as ValidationIssue[], conflict: Boolean(conflict) }
        } catch (error) {
          if (signal.aborted) throw error
          const failure = workflowFailure(error)
          stat.errorCode = failure.code
          for (const number of groupNumbers) requestFailures.set(number, [...(requestFailures.get(number) || []), { request: stat, partial_response: partialText }])
          const recoverable = ['text_output_limit', 'text_empty_response', 'response_json'].includes(failure.code) || transientProviderFailure(failure)
          if (automaticRecovery && recoveryAttempt + 1 < maxTries && recoverable && !fatalProviderFailure(failure)
            && !groupNumbers.some(number => (requestCounts.get(number) || 0) >= 4)) {
            options.onState?.('repairing', recoveryAttempt + 1)
            logTaskProgress('StoryboardWorkflow', 'automatic-recovery', { stage, groups: groupNumbers, reason: failure.code, nextProfile: 'recovery' })
            // An empty relay pool needs a few seconds to free an account (R1).
            await recoveryPause(dependencies.recoveryDelayMs ?? (relayPoolUnavailable(failure) ? 8000 : transientProviderFailure(failure) ? 1500 : 100), signal)
            continue
          }
          if (fatalProviderFailure(failure)) providerCircuitOpen = true
          else if (transientProviderFailure(failure) && ++consecutiveProviderFailures >= 3) providerCircuitOpen = true
          throw error
        } finally {
          clearTimeout(requestTimer)
          stat.elapsedMs = Math.round(performance.now() - startedAt)
          logTaskProgress('StoryboardWorkflow', 'request-finished', { ...stat })
        }
      }
      throw new Error('文本请求未完成')
    }
    let plan: NarrativePlan
    const units = splitScriptUnits(context.script)
    const speechBudgets = buildScriptUnitSpeechBudgets(units, assets)
    const bodyAnalysis = analyzeScriptBody(context.script)
    const productionNotes = new Set([...productionNoteIds(units), ...bodyAnalysis.excludedSourceIds])
    const groupBudget = storyboardGroupBudget(context.script)
    const budgetSummary = { characters: timing.characters, targetSeconds: timing.targetSeconds,
      preferredGroups: groupBudget.preferredGroupCount, minimumGroups: groupBudget.minimumGroups,
      maximumGroups: groupBudget.maximumGroups, scope: bodyAnalysis.scope, totalCharacters: bodyAnalysis.totalCharacters,
      excludedCharacters: bodyAnalysis.excludedCharacters, excludedLineCount: bodyAnalysis.excludedSourceIds.length }
    if (options.mode === 'breakdown') {
      const savedPlan = store.get(draftId)!.plan as any
      store.savePlan(draftId, { ...savedPlan, budget: budgetSummary }, leaseToken)
      // Verification run (2026-11-08): a plan whose numbers were written as text ("1", "13") is read as numbers. Such a
      // plan never passed the checks before, so no group can exist under a saved one.
      const savedNormalized = savedPlan?.data ? normalizePlanSubmission(savedPlan.data) : null
      let current = savedNormalized ? savedNormalized.raw : savedPlan?.data
      let issues = current ? validateNarrativePlan(current, units, assets, context.script) : [errorIssue('plan_pending', '需要整集叙事规划。')]
      if (savedNormalized?.notes.length) {
        logTaskProgress('StoryboardWorkflow', 'plan-format-normalized', { notes: savedNormalized.notes, saved: true })
        store.savePlan(draftId, { data: current, issues, budget: budgetSummary }, leaseToken)
      }
      for (let attempt = 0; issues.some(issue => issue.severity === 'error') && attempt < (automaticRecovery ? 4 : 2); attempt++) {
        if (automaticRecovery && planningRequests >= 4) break
        const repairingPlan = attempt > 0 || Boolean(current)
        options.onState?.(repairingPlan ? 'repairing' : 'generating', repairingPlan ? 1 : 0)
        if (repairingPlan) repairCalls++
        const { script: _script, ...planFacts } = facts
        const qualityRepair = automaticRecovery && Boolean(current)
        const response = await ask('plan', buildNarrativePlanSchema(assets, units), {
          ...planFacts, source_units: units,
          source_speech_budgets: speechBudgets.map(({ utterances, ...budget }) => ({ ...budget, utterances: utterances.map(({ text: _text, ...utterance }, index) => ({ ...utterance, utterance_index: index + 1 })) })), timing_budget: scriptTimingBudget(context.script),
          planning_constraints: buildStoryboardPlanningConstraints({ plan: current, script: context.script, speechBudgets, issues }),
          script_body_budget: { ...budgetSummary, body_source_ids: bodyAnalysis.includedSourceIds, metadata_source_ids: bodyAnalysis.excludedSourceIds,
            note: '预算只计剧本正文。标题、人物表、场景表头、制作备注和集末总结仅作参考，不另拍成动作或朗读；原文和source_ids完整保留。' },
          task: options.message, ...(current ? { directed_repair: { rejected_plan: current, issues,
            instruction: '自动修正整份叙事规划后继续生成，不交给用户手动修正。原文、动作因果、全部对白和收尾必须保留。参考planning_constraints的真实总时长边界、建议整秒区间和口播必要下限；整数区间只是便于选值，不是新增硬规则。可以重审组数、相邻原文归属、真实节拍和时长；若当前分组的最低必要时长已超过总上限，必须调整分组结构，不能只反复压缩秒数。单组最多15秒，过长原文可以按自然分句跨相邻组共享source_id，不切断词语、不加速或删词；共享来源按capacity_conflicts整体调整，不能重复计算为每组都要完整说一遍。不为通过检查虚改节拍分类。返回完整groups，不只返回修改说明。'
          } } : {})
        }, qualityRepair, qualityRepair)
        const planned = response.conflict ? { raw: response.raw, notes: [] as string[] } : normalizePlanSubmission(response.raw)
        if (planned.notes.length) logTaskProgress('StoryboardWorkflow', 'plan-format-normalized', { notes: planned.notes })
        current = planned.raw; issues = response.conflict ? response.issues : [...response.issues, ...validateNarrativePlan(current, units, assets, context.script)]
        store.savePlan(draftId, { data: current, issues, budget: budgetSummary }, leaseToken)
        if (response.conflict) break
      }
      if (issues.some(issue => issue.severity === 'error')) { store.setStatus(draftId, 'needs_revision', leaseToken); return result('needs_revision', 0, issues) }
      plan = current
      // A saved plan replaced above (for example one that a newer validation
      // rule rejects) must not leave finished groups of the old plan marked
      // ready: keep only groups whose own lines, duration and scene are unchanged.
      if (savedPlan?.data && store.get(draftId)!.groups.length && planEntries(savedPlan.data) !== planEntries(plan)) {
        store.replaceGroups(draftId, reconcileDraftGroups(savedPlan.data, plan.groups, store.get(draftId)!.groups).groups, leaseToken)
      }
    } else {
      plan = {
        groups: (options.storyboardIds || []).map((id, index) => {
          const original = options.session.getOriginalCandidate(id)
          if (!original) throw new Error('指定分镜已不存在')
          return {
            number: index + 1, title: original.title || `分镜${original.shot_number}`, beat: 'narrative' as const, source_ids: [], scene_id: original.scene_id ?? null,
            duration: original.duration!
          }
        })
      }
      store.savePlan(draftId, { data: plan, issues: [] }, leaseToken)
    }
    for (const group of plan.groups) if (!store.get(draftId)!.groups.some(entry => entry.number === group.number)) store.saveGroup(draftId, { number: group.number, status: 'pending', candidate: null, issues: [], attempts: 0 }, leaseToken)
    progress()
    // A plan may let one original line continue across adjacent groups. Decide,
    // at existing punctuation, which original words each group speaks.
    const speakerNames = assets.characters.map(character => character.name)
    let sharedSpeech: SharedLineAssignment | null = null
    /**
     * Prefer the split that agrees with the most finished groups. A finished
     * group that contradicts the chosen split (for example one finished while
     * every group still assumed it had to say the whole shared line) cannot be
     * part of a complete episode, so it is sent back with the exact reason.
     */
    const applySharedSpeech = () => {
      sharedSpeech = null
      if (options.mode !== 'breakdown' || !sharedSpokenSourceIds(plan.groups, speechBudgets).length) return
      const finished = store.get(draftId!)!.groups.filter(group => group.status === 'ready' && stored(group).data)
      const chosen = chooseSharedLineSpeech(plan.groups, speechBudgets,
        finished.map(group => ({ number: group.number, said: assignmentSpeech(stored(group).data!, speakerNames) })))
      sharedSpeech = chosen.assignment
      if (!chosen.assignment || !chosen.contradicted.length) return
      for (const group of finished.filter(entry => chosen.contradicted.includes(entry.number))) {
        store.saveGroup(draftId!, { ...group, status: 'needs_revision', issues: [...(group.issues as ValidationIssue[]).filter(issue => issue.severity !== 'error'),
          ...validateSpeechAssignment(stored(group).data!, chosen.assignment, group.number, speakerNames)] }, leaseToken)
      }
      rebuildVoiceProfiles(); progress()
    }
    applySharedSpeech()
    const assignmentIssues = (group: NarrativeGroup, candidate: SkillCandidate | null) => {
      const assignment = sharedSpeech
      return assignment && candidate ? validateSpeechAssignment(candidate, assignment, group.number, speakerNames) : []
    }
    const checkpoint = store.get(draftId)!
    if (checkpoint.groups.length === plan.groups.length && checkpoint.groups.every(group => stored(group).data)
      && !checkpoint.groups.some(group => (group.issues as ValidationIssue[]).some(issue => ['boundary_dependency_review', 'boundary_continuity'].includes(issue.code)))) {
      const groupReviews = checkpoint.groups.map(group => [...validateSkillStoryboard(stored(group).data!, assets, {
        mode: options.mode,
        ...(options.mode === 'breakdown' ? { expected: plan.groups.find(entry => entry.number === group.number)! } : {})
      }), ...assignmentIssues(plan.groups.find(entry => entry.number === group.number)!, stored(group).data!)])
      const completeReview = groupReviews.flat().some(issue => issue.severity === 'error') ? groupReviews.flat()
        : options.session.reviewCompleteCandidates(checkpoint.groups.map(group => stored(group).data!))
      if (!completeReview.some(issue => issue.severity === 'error')) {
        for (const group of checkpoint.groups) store.saveGroup(draftId, {
          ...group, status: 'ready',
          issues: groupReviews[checkpoint.groups.indexOf(group)]
        }, leaseToken)
        progress()
      }
    }
    type ModelResponse = { raw: any; issues: ValidationIssue[]; conflict: boolean; batchRaw?: unknown }
    const legacyPromptSchema = z.object({ video_prompt: z.string().min(1).max(3600), time_row_counts: z.array(z.union([z.literal(1), z.literal(2)])).min(2).max(4) }).strict()
    const promptSchema = voiceContract ? legacyPromptSchema.safeExtend({ voice_cues: buildVoiceCueSchema(assets) }) : legacyPromptSchema
    const legacyFullSchema = buildCompleteStoryboardSchema(assets)
    const fullSchema = voiceContract ? legacyFullSchema.safeExtend({ voice_cues: buildVoiceCueSchema(assets) }) : legacyFullSchema
    const originalFor = (group: NarrativeGroup) => options.mode === 'prompt' ? options.session.getOriginalCandidate(options.storyboardIds![group.number - 1]) : null
    const compileTransportReferences = (raw: unknown) => {
      const voices = compileStoryboardVoices(raw, { assets, profiles: voiceProfiles, language: options.requestContext.get('language') || 'zh' })
      const compiled = compileStoryboardReferences(voices.submission, assets)
      return { ...compiled, issues: [...voices.issues, ...compiled.issues] }
    }
    const evaluateResponse = (group: NarrativeGroup, response: ModelResponse, attempts: number): { entry: DraftGroup; profiles?: VoiceProfiles } => {
      const retained = stored(store.get(draftId!)!.groups.find(entry => entry.number === group.number))
      let issues = [...response.issues], data: SkillCandidate | null = null, preview: unknown = null
      const original = originalFor(group)
      if (response.conflict) {
        return { entry: {
          number: group.number, status: 'needs_revision', candidate: {
            raw: response.raw, data: null,
            preview: retained.data || retained.preview || null, previous_raw: retained.previous_raw ?? retained.raw,
            ...(response.batchRaw !== undefined ? { batch_raw: response.batchRaw } : {})
          }, issues, attempts
        } }
      }
      // Format-only slips with exactly one correct reading are fixed before any
      // check (see storyboard-format-normalize.ts); quoted original words,
      // speakers, order and times are never changed. The model's own output is
      // kept as model_raw for traceability.
      const modelOutput = response.raw
      // Plan facts are passed only for whole-episode breakdown groups; a locked prompt conversion keeps its own fields.
      const plannedFacts = options.mode === 'breakdown' ? {
        number: group.number, source_ids: group.source_ids, duration: group.duration, scene_id: group.scene_id,
        source_lines: group.source_ids.map(id => units.find(unit => unit.id === id)?.text).filter((text): text is string => typeof text === 'string'),
      } : undefined
      const normalized = response.conflict ? { raw: response.raw, notes: [] as string[] }
        : normalizeSubmission(response.raw, { established: voiceProfiles, characters: assets.characters, plan: plannedFacts })
      if (normalized.notes.length) {
        logTaskProgress('StoryboardWorkflow', 'format-normalized', { group: group.number, notes: normalized.notes })
        response = { ...response, raw: normalized.raw }
      }
      const modelRaw = normalized.notes.length ? { model_raw: modelOutput, format_fixes: normalized.notes } : {}
      const voices = compileStoryboardVoices(response.raw, { assets, profiles: voiceProfiles, language: options.requestContext.get('language') || 'zh' })
      issues.push(...voices.issues.map(issue => ({ ...issue, shotNumber: group.number })))
      if (voiceContract && (!response.raw || typeof response.raw !== 'object' || !Object.hasOwn(response.raw, 'voice_cues'))) issues.push(errorIssue('voice_cue_contract', '本组缺少逐发声子镜的完整声音资料；请补齐voice_cues及明确发声锚点，不能仅保留台词。', 'voice_cues', group.number))
      const rendered = voices.submission
      if (rendered && options.mode === 'prompt') {
        const checked = legacyPromptSchema.safeParse(rendered)
        if (!checked.success) issues.push(...checked.error.issues.map(issue => errorIssue('response_schema', `${issue.path.join('.')}: ${issue.message}`, issue.path.join('.'), group.number)))
        if (checked.success) {
          const placeholders = { ...original!, ...checked.data, source_ids: [1] } as any
          delete placeholders.id; delete placeholders.video_prompt_plan
          for (const key of ['title', 'time', 'location', 'shot_type', 'angle', 'movement', 'description', 'result', 'atmosphere', 'image_prompt', 'bgm_prompt', 'sound_effect']) placeholders[key] = '锁定字段'
          const compiled = compileStoryboardReferences(placeholders, assets)
          issues.push(...compiled.issues)
          data = compiled.candidate ? { ...original!, video_prompt: compiled.candidate.video_prompt, time_row_counts: checked.data.time_row_counts } : null
          preview = { ...original!, video_prompt: compiled.preview?.video_prompt || checked.data.video_prompt, time_row_counts: checked.data.time_row_counts }
          if (compiled.candidate && (compiled.candidate.character_ids.some(id => !original!.character_ids?.includes(id)) || compiled.candidate.prop_ids.some(id => !original!.prop_ids?.includes(id)) || compiled.candidate.scene_id !== original!.scene_id)) issues.push(errorIssue('prompt_binding_locked', '提示词引用超出本组已锁定资产，不能在转换时修改绑定。', 'video_prompt', group.number))
        }
      } else if (rendered) {
        const compiled = compileStoryboardReferences(rendered, assets)
        data = compiled.candidate; preview = compiled.preview; issues.push(...compiled.issues)
      }
      if (data) issues.push(...validateSkillStoryboard(data, assets, { mode: options.mode, ...(options.mode === 'breakdown' ? { expected: group } : {}) }))
      if (data) issues.push(...assignmentIssues(group, data))
      // When the voice data could not be compiled, the content checks above did
      // not run. Run them on a voice-free projection (anchors read as plain
      // labels) so one request learns every problem at once, instead of a
      // voice-only patch that is bound to fail on a hidden second error.
      if (!data && !rendered && options.mode === 'breakdown' && response.raw && typeof response.raw === 'object' && Array.isArray((response.raw as any).voice_cues)) {
        const projection = structuredClone(response.raw) as Record<string, any>
        for (const field of ['description', 'video_prompt']) if (typeof projection[field] === 'string') projection[field] = projection[field].replace(/\[\[voice:[^\]\r\n]+\]\]/gu, '说')
        delete projection.voice_cues
        const compiled = compileStoryboardReferences(projection, assets)
        if (compiled.candidate) {
          const hidden = validateSkillStoryboard(compiled.candidate, assets, { mode: options.mode, expected: group })
            .filter(issue => issue.severity === 'error' && !['dialogue_preservation', 'attribution_review'].includes(issue.code))
          issues.push(...hidden.filter(issue => !issues.some(known => known.code === issue.code && known.field === issue.field)))
        }
      }
      const ready = Boolean(data) && !issues.some(issue => issue.severity === 'error')
      return { entry: {
        number: group.number, status: ready ? 'ready' : 'needs_revision', candidate: {
          raw: response.raw, data, preview: preview || retained.preview || retained.data || response.raw, ...modelRaw,
          ...(requestFailures.has(group.number) ? { request_failures: requestFailures.get(group.number) } : {}),
          ...(response.batchRaw !== undefined ? { batch_raw: response.batchRaw } : {})
        }, issues, attempts
      }, ...(ready ? { profiles: voices.profiles } : {}) }
    }
    const persistResponse = (group: NarrativeGroup, response: ModelResponse, attempts: number) => {
      const evaluated = evaluateResponse(group, response, attempts)
      store.saveGroup(draftId!, evaluated.entry, leaseToken)
      if (evaluated.profiles) voiceProfiles = evaluated.profiles
      progress(group.number)
      return evaluated.entry.status === 'ready'
    }
    const packedPayload = (groups: NarrativeGroup[]) => {
      const first = groups[0], last = groups[groups.length - 1], original = originalFor(first)
      const previousGroup = store.get(draftId!)!.groups.find(entry => entry.number === first.number - 1)
      // Only a validated (ready) previous group is a fact to continue from. A
      // candidate that failed validation may still change; never present it as
      // the established ending.
      const previousReady = Boolean(previousGroup && previousGroup.status === 'ready')
      const previous = original
        ? context.existing_storyboards?.find((entry: any) => entry.shot_number === original.shot_number - 1)
        : previousReady ? stored(previousGroup).data : null
      const payload = buildPackedExpandContext({
        plan, groups, sourceUnits: units, speechBudgets, assets: assets as any,
        previous, episode: context.episode, projectStyle
      })
      const timing = (group: NarrativeGroup) => ({
        group_number: group.number,
        valid_time_row_counts: timingChoices(group.duration, original ? skillDescriptionShots(original.description || '').length : undefined)
      })
      // When the following group is already ready, this group's ending must lead
      // into that group's established opening.
      const followingGroup = original ? undefined : store.get(draftId!)!.groups.find(entry => entry.number === last.number + 1)
      const followingData = followingGroup?.status === 'ready' ? stored(followingGroup).data : null
      const nextOpening = followingData ? {
        shot_number: followingData.shot_number,
        description_first_shot: (skillDescriptionShots(followingData.description || '')[0]
          ? `【镜头1】${skillDescriptionShots(followingData.description || '')[0].text}` : followingData.description || '').trim(),
        video_first_row: (followingData.video_prompt || '').split(/\r?\n/).find(line => /^\s*0\s*[-–—~～至]/u.test(line)) || '',
      } : null
      const currentGroups = payload.current_groups.map(row => {
        const assignment = sharedSpeech ? speechAssignmentPayload(sharedSpeech, row.number) : null
        const share = assignment ? assignment.group_speech_characters : undefined
        const rhythm = options.mode === 'breakdown' && !original
          ? rhythmFacts(row, id => ({ text: units.find(unit => unit.id === id)?.text, spoken: speechBudgets.find(budget => budget.source_id === id)?.spoken_characters, unperformed: productionNotes.has(id) }), share)
          : null
        return { ...row, ...(assignment ? { speech_assignment: assignment } : {}), ...(rhythm ? { rhythm } : {}) }
      })
      return {
        ...payload, current_groups: currentGroups, task: options.message, ...(voiceContract ? { voice_profiles: voiceProfiles } : {}),
        ...(voiceContract && cardFacts.length ? { voice_cards: cardFacts } : {}),
        ...(options.mode === 'breakdown' && groups.some(group => group.source_ids.some(id => productionNotes.has(id)))
          ? { production_note_source_ids: groups.flatMap(group => group.source_ids).filter(id => productionNotes.has(id)),
            production_note_rule: 'production_note_source_ids中的原文是标题、人物表、场景表头或制作参考备注（人物建议、本集人物状态与闭环等），不是台词也不是要表演的动作：照常保留在本组source_ids里，仅参考事实，不作为独立镜头、不写进对白或旁白、不占正文预算；人物外形以已有素材资料为准。' } : {}),
        ...(groups.length === 1 ? { current_group: currentGroups[0], timing_options: timing(first) } : { timing_options: groups.map(timing) }),
        ...(previousGroup ? { previous_group_state: previousGroup.status } : {}),
        ...(previousGroup && !previousReady && !original ? { previous_ending_note: '上一组尚未通过检查，它的末态还不是定稿：不要沿用它的未定稿内容；按原文与已批准规划确定本组初态，原文无法确定时走conflict通道，不臆造上一组已完成的动作。' } : {}),
        ...(nextOpening ? { next_opening: nextOpening, next_opening_note: '下一组已经定稿。本组结尾的人物位置、持物、视线和动作状态必须能直接承接下一组开头，不改动下一组；确实无法衔接时走conflict通道说明。' } : {}),
        ...(original ? { locked_storyboard: original, adjacent_next: context.existing_storyboards?.find((entry: any) => entry.shot_number === original.shot_number + 1) } : {})
      }
    }
    const noAutomaticGroups = new Set<number>(), lockedGroups = new Set<number>(), attemptedTargetedRepair = new Set<number>()
    const attemptedBoundaries = new Set<number>()
    /** Correct only unpublished draft boundaries. The original pair stays
     * visible until both replacement candidates have passed every check. */
    const repairAdjacentBoundary = async (rightNumber: number): Promise<boolean> => {
      if (options.mode !== 'breakdown' || !automaticRecovery || providerCircuitOpen || attemptedBoundaries.has(rightNumber)
        || waitingForPrevious.has(rightNumber)) return false
      const draft = store.get(draftId!)!
      const right = draft.groups.find(row => row.number === rightNumber)
      const left = draft.groups.find(row => row.number === rightNumber - 1)
      const leftPlan = plan.groups.find(row => row.number === rightNumber - 1)
      const rightPlan = plan.groups.find(row => row.number === rightNumber)
      if (draft.status === 'committed' || !left || left.status !== 'ready' || !right || right.status === 'ready' || !leftPlan || !rightPlan) return false
      const rightStored = stored(right), conflict = rightStored.raw
      if (!isAdjacentBoundaryConflict(conflict)) return false
      const leftStored = stored(left)
      const previousRaw = leftStored.raw
      const currentRaw = [rightStored.previous_raw, rightStored.raw].find(isCompleteBoundaryCandidate) || null
      const hasOnlyRenderedCurrent = !currentRaw && [rightStored.data, rightStored.preview].some(isCompleteBoundaryCandidate)
      const scope = prepareBoundaryRepair(previousRaw, currentRaw, { previousNumber: left.number, currentNumber: right.number })
      attemptedBoundaries.add(rightNumber)
      const label = `第${left.number}组末态与第${right.number}组原文衔接冲突`
      const retainFailure = (message: string) => {
        const latest = store.get(draftId!)!.groups.find(row => row.number === rightNumber)!
        store.saveGroup(draftId!, { ...latest, issues: [...(latest.issues as ValidationIssue[]).filter(issue => issue.code !== 'boundary_continuity'),
          errorIssue('boundary_continuity', `${label}：${message}；原草稿保留，请查看衔接修复记录。`, 'previous_ending', rightNumber)] }, leaseToken)
        progress(rightNumber)
        return false
      }
      // A rendered snapshot is not interchangeable with its typed/voice raw
      // form. Do not silently widen the repair to the whole existing group.
      if (hasOnlyRenderedCurrent) return retainFailure('后组只保留编译后的预览，缺少可靠原始草稿，未扩大修改范围')
      if (!scope) return retainFailure('前组缺少可可靠定位的完整末镜，未扩大修改范围')
      let repairFeedback: ValidationIssue[] = []
      for (let attempt = 0; attempt < 2; attempt++) {
        signal.throwIfAborted()
        if (providerCircuitOpen) break
        let repairId: string | undefined
        try {
          // Fresh full-group CAS snapshots include status, attempts and issues.
          const live = store.get(draftId!)!
          const beforeLeft = live.groups.find(row => row.number === left.number)!
          const beforeRight = live.groups.find(row => row.number === right.number)!
          if (boundaryVersion(beforeLeft) !== boundaryVersion(left) || boundaryVersion(beforeRight) !== boundaryVersion(right)) {
            return retainFailure('修复期间草稿版本已变化，未覆盖较新的内容')
          }
          const started = store.beginBoundaryRepair(draftId!, left.number, right.number, beforeLeft, beforeRight,
            String((conflict as any).conflict).slice(0, 4000), leaseToken)
          repairId = started.boundaryRepairs!.at(-1)!.id
          options.onState?.('repairing', attempt + 1)
          logTaskProgress('StoryboardWorkflow', 'boundary-repair-started', { left: left.number, right: right.number, repairId, attempt: attempt + 1 })
          repairCalls++
          const pairSchema = z.object({ left: fullSchema, right: fullSchema,
            continuity: z.object({ resolved: z.literal(true), summary: z.string().min(1).max(2000) }).strict() }).strict()
          const payload = packedPayload([leftPlan, rightPlan])
          const response = await ask('expand', pairSchema, {
            ...payload,
            boundary_repair: {
              repair_id: repairId, left_number: left.number, right_number: right.number,
              before_versions: { left: scope.previousVersion, right: scope.currentVersion },
              before: { left: scope.previous, right: scope.current }, editable: scope.editable,
              conflict, previous_failed_checks: repairFeedback,
              instruction: '本次只修相邻草稿的衔接，不是重写全剧，也不是修改正式分镜。返回{left:前组完整原稿加必要末镜修正,right:后组完整原稿加必要首镜修正,continuity:{resolved:true,summary:具体如何消除矛盾}}。原文事实优先，前组生成错误不能推翻原文；不得为掩盖矛盾新增牵手、交接等原文没有的事件。前组只允许改description最后一个子镜头、video_prompt对应最后子镜的时间行正文和result，其余逐字保持。后组已有完整before时只允许改首镜及对应最前时间行，result与其他内容逐字保持；后组before为空时按原规划完整创作后组。时长、原文归属、场景、素材绑定、台词原词、发声者、声音类型、音色、时间前缀与镜头数量/顺序保持。两组都必须满足原Skill。检查前组末态到后组初态连续，并遵守已给的外侧前组末态/后组开头；若无法在这个范围内正确修复，返回conflict及field:boundary_continuity，不扩大范围。'
            }
          }, true, true)
          if (response.conflict) throw new Error(response.issues.map(issue => issue.message).join('；') || '模型未能在相邻镜头范围内消除冲突')
          const pair = pairSchema.safeParse(response.raw)
          if (!pair.success) throw new Error(`相邻修复返回格式不完整：${pair.error.issues.map(issue => issue.path.join('.')).join('、')}`)
          const scopeIssues = validateBoundaryRepairScope(scope.previous, pair.data.left, scope.current, pair.data.right, speakerNames)
          if (scope.current && ['description', 'video_prompt', 'result'].every(field =>
            (scope.previous as any)[field] === (pair.data.left as any)[field]
            && (scope.current as any)[field] === (pair.data.right as any)[field])) {
            scopeIssues.push(errorIssue('boundary_repair_unchanged', '返回内容未修改任何冲突位置，不能仅凭resolved声明认定衔接已修复。', 'previous_ending', rightNumber))
          }
          const evaluatedLeft = evaluateResponse(leftPlan, { raw: pair.data.left, issues: [], conflict: false }, beforeLeft.attempts + 1)
          const evaluatedRight = evaluateResponse(rightPlan, { raw: pair.data.right, issues: [], conflict: false }, beforeRight.attempts + 1)
          const leftCandidate = stored(evaluatedLeft.entry), rightCandidate = stored(evaluatedRight.entry)
          scopeIssues.push(...validateBoundaryRepairScope(scope.previous, leftCandidate.raw, scope.current, rightCandidate.raw, speakerNames))
          const sameBindings = (oldValue: any, newValue: any) => ['scene_id', 'character_ids', 'prop_ids'].every(field => {
            const sorted = (value: unknown) => Array.isArray(value) ? [...value].sort((a, b) => Number(a) - Number(b)) : value
            return JSON.stringify(sorted(oldValue?.[field])) === JSON.stringify(sorted(newValue?.[field]))
          })
          if (!sameBindings(leftStored.data, leftCandidate.data)
            || scope.current && !sameBindings(compileTransportReferences(scope.current).candidate, rightCandidate.data)) {
            scopeIssues.push(errorIssue('boundary_repair_scope', '相邻修复不能改变已有素材绑定。', 'boundary_continuity', rightNumber))
          }
          repairFeedback = [...scopeIssues, ...(evaluatedLeft.entry.issues as ValidationIssue[]), ...(evaluatedRight.entry.issues as ValidationIssue[])]
            .filter(issue => issue.severity === 'error')
          if (repairFeedback.length || evaluatedLeft.entry.status !== 'ready' || evaluatedRight.entry.status !== 'ready') {
            throw new Error(repairFeedback.map(issue => issue.message).join('；').slice(0, 3500) || '相邻两组未共同通过完整检查')
          }
          // Hashes are checked by the store as well. Neither candidate was
          // written during evaluation, so a failed check leaves both intact.
          const next = !scope.current ? live.groups.find(row => row.number === rightNumber + 1 && row.status === 'ready') : undefined
          store.completeBoundaryRepair(draftId!, repairId, evaluatedLeft.entry, evaluatedRight.entry, leaseToken,
            next ? { expected: next, issue: errorIssue('boundary_dependency_review', `第${rightNumber}组已按原文修复；第${next.number}组需要重新核对与其新末态的衔接，原稿保留。`, 'previous_ending', next.number) } : undefined)
          if (next) {
            noAutomaticGroups.delete(next.number); lockedGroups.delete(next.number)
          }
          noAutomaticGroups.delete(rightNumber); waitingForPrevious.delete(rightNumber)
          rebuildVoiceProfiles()
          logTaskProgress('StoryboardWorkflow', 'boundary-repair-applied', { left: left.number, right: right.number, repairId,
            summary: pair.data.continuity.summary })
          progress(rightNumber)
          return true
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (repairId) store.failBoundaryRepair(draftId!, repairId, message, leaseToken)
          logTaskProgress('StoryboardWorkflow', 'boundary-repair-failed', { left: left.number, right: right.number, repairId, reason: message })
          if (signal.aborted) throw error
          if (!repairId || providerCircuitOpen || !repairFeedback.length) return retainFailure(message)
        }
      }
      return retainFailure('已达到本次相邻修复上限，仍未共同通过检查')
    }
    const repairPendingBoundaries = async () => {
      if (!automaticRecovery || options.mode !== 'breakdown') return
      for (const group of plan.groups) {
        if (providerCircuitOpen) break
        await repairAdjacentBoundary(group.number)
      }
    }
    /**
     * Round 3 (2026-11-08): a group that reported a conflict while its previous group was not yet ready — the
     * workflow itself told it to report one instead of guessing (previous_ending_note) — gets one more turn once
     * that previous group is ready, now with the validated ending. Other conflicts stay final as before.
     */
    const waitingForPrevious = new Set<number>()
    /** The refusal names the missing previous ending (the case the note above invites), not a duration or other conflict. */
    const refusedForPrevious = (raw: any, number: number) => {
      if (!raw || typeof raw.conflict !== 'string' || raw.field === 'duration') return false
      const previous = store.get(draftId!)!.groups.find(entry => entry.number === number - 1)
      if (!previous || previous.status === 'ready') return false
      return raw.field === 'previous_ending' || /previous_(?:ending|group_state)|上一组|前一组/u.test(raw.conflict)
    }
    const releaseWaitingGroups = () => {
      const current = store.get(draftId!)!
      for (const number of [...waitingForPrevious]) {
        if (current.groups.find(entry => entry.number === number - 1)?.status !== 'ready') continue
        waitingForPrevious.delete(number)
        noAutomaticGroups.delete(number)
        logTaskProgress('StoryboardWorkflow', 'retry-after-previous-ready', { group: number })
      }
    }
    const generateGroup = async (group: NarrativeGroup, attemptBudget = 2, forceRecovery = false, fromBatch = false) => {
      if (providerCircuitOpen) return
      signal.throwIfAborted()
      const previousGroup = store.get(draftId!)!.groups.find(entry => entry.number === group.number)!
      if (previousGroup.status === 'ready' || noAutomaticGroups.has(group.number) || lockedGroups.has(group.number)) return
      const original = originalFor(group), previousCandidate = stored(previousGroup)
      let prior = previousCandidate.previous_raw ?? previousCandidate.raw, issues = previousGroup.issues as ValidationIssue[]
      let data: SkillCandidate | null = previousCandidate.data || null, preview: unknown = previousCandidate.preview || previousCandidate.data || null
      if (original) {
        const fixedCodes = new Set(['duration_range', 'shot_order', 'dialogue_budget', 'scene_binding', 'character_binding', 'prop_binding'])
        const fixed = validateSkillStoryboard(original, assets, { mode: 'prompt' }).filter(issue => fixedCodes.has(issue.code)
          || issue.code === 'skill_field_missing' && ['description', 'atmosphere'].includes(issue.field))
        if (fixed.length) {
          store.saveGroup(draftId!, { ...previousGroup, status: 'needs_revision', issues: fixed }, leaseToken)
          lockedGroups.add(group.number); progress(group.number); return
        }
      }
      const oldErrors = issues.filter(issue => issue.severity === 'error')
      if (previousCandidate.data && oldErrors.length && oldErrors.every(issue => ['dialogue_preservation', 'line_dialogue_budget'].includes(issue.code))) {
        const rechecked = [...validateSkillStoryboard(previousCandidate.data, assets, { mode: options.mode, ...(options.mode === 'breakdown' ? { expected: group } : {}) }),
          ...assignmentIssues(group, previousCandidate.data)]
        if (!rechecked.some(issue => issue.severity === 'error')) {
          store.saveGroup(draftId!, { ...previousGroup, status: 'ready', issues: rechecked }, leaseToken); progress(group.number); return
        }
      }
      // A stored storyboard made before the shared-line split was known (or that
      // ignored it) is told exactly which original words it keeps.
      if (data && options.mode === 'breakdown') {
        const split = assignmentIssues(group, data).filter(issue => !issues.some(old => old.code === issue.code && old.message === issue.message))
        if (split.length) issues = [...issues, ...split]
      }
      // A duration conflict may have counted whole shared lines; state the
      // group's real share so the repair works from the same numbers.
      const assignment = sharedSpeech
      const share = assignment && options.mode === 'breakdown' ? speechAssignmentPayload(assignment, group.number) : null
      if (share && !data && !issues.some(issue => issue.code === 'speech_assignment')
        && issues.some(issue => issue.severity === 'error' && issue.code === 'model_constraint_conflict' && issue.field === 'duration')) {
        issues = [...issues, errorIssue('speech_assignment', `本组与相邻组共享的原文已在原有标点处分好：本组只说current_group.speech_assignment中this_group_speaks的原词，本组发声共${share.group_speech_characters}字，按4.5字/秒＋2秒表演余量本组可容纳${share.group_speech_capacity}字。请按此完整生成本组；若仍无法容纳，再走conflict通道说明。`, 'duration', group.number)]
      }
      for (let attempt = 0; attempt < attemptBudget; attempt++) {
        signal.throwIfAborted()
        if (automaticRecovery && (requestCounts.get(group.number) || 0) >= 4) return
        const repairing = attempt > 0 || Boolean(prior) || forceRecovery
        if (attempt || forceRecovery || fromBatch) repairCalls++
        options.onState?.(repairing ? 'repairing' : 'generating', repairing ? 1 : 0)
        const latestGroup = store.get(draftId!)!.groups.find(entry => entry.number === group.number)!
        store.saveGroup(draftId!, { ...latestGroup, status: 'generating', attempts: previousGroup.attempts + attempt + 1 }, leaseToken); progress(group.number)
        try {
          const following = store.get(draftId!)!.groups.find(entry => entry.number === group.number + 1)
          let targeted = repairing && dependencies.targetedRepairs !== false && !attemptedTargetedRepair.has(group.number)
            ? createTargetedRepair({ prior, issues, mode: options.mode, ...(voiceContract ? { voiceCueSchema: buildVoiceCueSchema(assets) } : {}) }) : null
          // A schema error can hide an earlier plan mismatch. A small mapping
          // patch must never lock an already changed duration/source/scene.
          if (targeted && options.mode === 'breakdown' && (!prior || typeof prior !== 'object'
            || (prior as any).shot_number !== group.number || (prior as any).duration !== group.duration
            || (prior as any).scene_id !== group.scene_id || JSON.stringify((prior as any).source_ids) !== JSON.stringify(group.source_ids))) targeted = null
          if (targeted?.fields.includes('result') && following?.status === 'ready') targeted = null
          // Typed references can change effective bindings even when the raw ID
          // arrays stay unchanged. Prose patches require a compiled snapshot.
          let bindingSnapshot = original || data || (targeted?.fields.some(field => field !== 'time_row_counts')
            ? compileTransportReferences(prior).preview : null)
          if (!bindingSnapshot && targeted && prior && typeof prior === 'object') {
            // Missing ancillary prose has no old references to preserve. Fill
            // only empty selected metadata in a read-only binding projection;
            // this placeholder is never sent, merged, staged or saved as prose.
            const metadata = new Set(['title', 'time', 'location', 'shot_type', 'angle', 'movement', 'atmosphere', 'image_prompt', 'bgm_prompt', 'sound_effect'])
            const projection = structuredClone(prior) as Record<string, unknown>
            for (const field of targeted.fields) if (metadata.has(field) && (typeof projection[field] !== 'string' || !(projection[field] as string).trim())) projection[field] = '绑定快照占位'
            const checkedProjection = compileTransportReferences(projection)
            bindingSnapshot = checkedProjection.candidate || checkedProjection.preview
          }
          if (targeted?.fields.some(field => field !== 'time_row_counts' && field !== 'voice_cues') && !bindingSnapshot) targeted = null
          if (targeted) attemptedTargetedRepair.add(group.number)
          const lockedContext = targeted && prior && typeof prior === 'object'
            ? Object.fromEntries(Object.entries(prior).filter(([field]) => !targeted!.fields.includes(field as any))) : undefined
          let response = await ask(options.mode === 'prompt' ? 'prompt' : 'expand', targeted?.schema || (options.mode === 'prompt' ? promptSchema : fullSchema), {
            ...packedPayload([group]),
            ...(targeted ? { targeted_repair: targeted.payload, locked_context: lockedContext, directed_repair: {
              issues, instruction: targeted.payload.instruction,
            } } : repairing ? { directed_repair: {
              rejected_submission: prior, issues,
              ...(following?.status === 'ready' && prior && typeof prior === 'object' ? { preserve_ending: (prior as any).result } : {}),
              ...(options.mode === 'breakdown' ? { allowed_shot_counts: feasibleShotCounts(group.duration) } : {}),
              instruction: options.mode === 'prompt'
                ? '只修当前组video_prompt，保留锁定description的全部镜头、事实和原词，不改时长或绑定。返回完整video_prompt和对应映射。'
                : `只修当前组具体错误，保留全部剧情与原词；description可按实际发声和动作重新安排2—4个子镜头，再让video_prompt逐镜对应，不改变本组时长和场景。本组${group.duration}秒按每镜2—6秒、每镜1—2个时间行，只能设计${feasibleShotCounts(group.duration).join('或')}个子镜头；原有子镜头数不可行时调整子镜头数，不改时长。有preserve_ending时保留已供后组承接的末态；确需改变时报告conflict，不悄悄改动已完成后组。返回完整本组。`
            } } : {}),
          }, forceRecovery || latestGroup.status === 'error', false, targeted || undefined)
          if (targeted && !response.conflict) {
            const currentCandidate = stored(store.get(draftId!)!.groups.find(entry => entry.number === group.number)!)
            const currentRaw = currentCandidate.previous_raw ?? currentCandidate.raw
            // Numbers written as text inside the patch are read as numbers before the strict patch check.
            const patch = normalizeRepairPatch(response.raw)
            if (patch.notes.length) logTaskProgress('StoryboardWorkflow', 'format-normalized', { group: group.number, notes: patch.notes, patch: true })
            const merged = applyTargetedRepair(currentRaw, patch.raw, targeted)
            let patchIssue: ValidationIssue | undefined
            if (!merged.ok) patchIssue = errorIssue(merged.code, merged.message, 'targeted_repair', group.number)
            else if (options.mode === 'breakdown' && targeted.fields.some(field => field !== 'time_row_counts')) {
              const compiled = compileTransportReferences(merged.value)
              const next = compiled.candidate || compiled.preview
              const sortedIds = (ids: unknown) => Array.isArray(ids) ? [...ids].sort((a, b) => Number(a) - Number(b)) : ids
              if (next && bindingSnapshot && ['scene_id', 'character_ids', 'prop_ids'].some(field =>
                JSON.stringify(sortedIds((next as any)[field])) !== JSON.stringify(sortedIds((bindingSnapshot as any)[field])))) {
                patchIssue = errorIssue('targeted_repair_binding_locked', '局部修改改变了原稿素材绑定，已拒绝合并；改由完整本组修正处理。', 'targeted_repair', group.number)
              }
            }
            if (patchIssue || !merged.ok) {
              const current = store.get(draftId!)!.groups.find(entry => entry.number === group.number)!
              issues = [...issues, patchIssue!]
              store.saveGroup(draftId!, { ...current, status: 'needs_revision', issues }, leaseToken); progress(group.number)
              if (!merged.ok && merged.code === 'targeted_repair_version') {
                lockedGroups.add(group.number)
                return
              }
              continue
            }
            response = { ...response, raw: options.mode === 'prompt'
              ? Object.fromEntries(['video_prompt', 'time_row_counts', 'voice_cues'].filter(field => Object.hasOwn(merged.value, field)).map(field => [field, merged.value[field]]))
              : merged.value }
          }
          const ready = persistResponse(group, response, previousGroup.attempts + attempt + 1)
          const saved = store.get(draftId!)!.groups.find(entry => entry.number === group.number)!, savedCandidate = stored(saved)
          prior = savedCandidate.raw; issues = saved.issues as ValidationIssue[]; data = savedCandidate.data || null; preview = savedCandidate.preview || null
          if (response.conflict) {
            noAutomaticGroups.add(group.number)
            if (!original && refusedForPrevious(response.raw, group.number)) waitingForPrevious.add(group.number)
          }
          if (response.conflict || ready) return
        } catch (error) {
          if (signal.aborted) throw error
          const failure = workflowFailure(error)
          store.saveGroup(draftId!, { number: group.number, status: 'error', candidate: {
            raw: prior, data, preview, ...(requestFailures.has(group.number) ? { request_failures: requestFailures.get(group.number) } : {})
          }, issues: [errorIssue(failure.code, failure.message, 'provider', group.number)], attempts: previousGroup.attempts + attempt + 1, error: failure.message }, leaseToken)
          progress(group.number)
          return
        }
      }
    }
    const packs = options.mode === 'breakdown' && dependencies.batchSize !== 1
      ? packStoryboardRequests({
        groups: plan.groups, checkpoints: store.get(draftId)!.groups, sourceUnits: units, speechBudgets,
        modelLimits: { maxOutputTokens: Number(process.env.AI_MAX_TOKENS || 16_384), ...dependencies.modelLimits }
      })
      : plan.groups.map(group => ({ groups: [group] }))
    let transportFailed = false
    for (const pack of packs) {
      signal.throwIfAborted()
      const batchRepair = new Set<number>(), noAutomaticRepair = new Set<number>()
      if (pack.groups.length > 1) {
        const before = new Map(pack.groups.map(group => [group.number, store.get(draftId!)!.groups.find(entry => entry.number === group.number)!]))
        for (const group of pack.groups) store.saveGroup(draftId, { ...before.get(group.number)!, status: 'generating', attempts: before.get(group.number)!.attempts + 1 }, leaseToken)
        options.onState?.('generating', 0); progress(pack.groups[0].number)
        try {
          const rowConflict = z.object({ shot_number: z.number().int().positive(), conflict: z.string().min(1), field: z.string().min(1), source_ids: z.array(z.number().int().positive()) }).strict()
          const batchSchema = z.object({ storyboards: z.array(z.union([fullSchema, rowConflict])).length(pack.groups.length) }).strict()
          const response = await ask('expand', batchSchema, packedPayload(pack.groups))
          // A row that names its group as group_number (never also as a different shot_number) is that group; a
          // number written as text ("3") is read as that number (verification run, 2026-11-08).
          const digitsOf = (value: unknown) => Number.isSafeInteger(value) ? value as number
            : typeof value === 'string' && /^\s*[1-9]\d*\s*$/u.test(value) ? Number(value) : undefined
          const rows = (Array.isArray(response.raw?.storyboards) ? response.raw.storyboards : []).map((row: any) => {
            if (!row || typeof row !== 'object') return row
            const number = row.shot_number === undefined ? digitsOf(row.group_number) : digitsOf(row.shot_number)
            return number !== undefined && number !== row.shot_number ? { ...row, shot_number: number } : row
          })
          const requested = new Set(pack.groups.map(group => group.number))
          const extras = rows.filter((row: any) => !requested.has(row?.shot_number))
          for (const group of pack.groups) {
            const matches = rows.filter((row: any) => row?.shot_number === group.number)
            const local: ModelResponse = response.conflict ? { ...response, issues: response.issues.map(issue => ({ ...issue, shotNumber: group.number })) }
              : matches.length === 1 ? { raw: matches[0], conflict: typeof matches[0]?.conflict === 'string' && Boolean(matches[0].conflict.trim()), issues: [] }
                : {
                  raw: matches[0] || { shot_number: group.number, missing_from_batch: true }, conflict: false,
                  issues: [errorIssue(matches.length ? 'batch_group_duplicate' : 'batch_group_missing', matches.length ? '本批同一组出现多份结果，不能擅自选取；请只修此组。' : '本批未返回此组完整结果；已返回的其他组保留。', 'storyboards', group.number)]
                }
            if (local.conflict && !local.issues.length) local.issues.push(errorIssue('model_constraint_conflict', local.raw.conflict, local.raw.field || 'workflow', group.number))
            if (response.issues.length || matches.length !== 1 || extras.length) local.batchRaw = response.raw
            if (extras.length) local.issues.push({ code: 'batch_extra_group_ignored', field: 'storyboards', severity: 'warning', shotNumber: group.number, message: '本批含未请求的分组，已隔离；只处理本次明确请求的组。' })
            if (!response.conflict && response.issues.length) local.issues.push(...response.issues)
            const ready = persistResponse(group, local, before.get(group.number)!.attempts + 1)
            if (local.conflict) {
              noAutomaticRepair.add(group.number)
              if (refusedForPrevious(local.raw, group.number)) waitingForPrevious.add(group.number)
            }
            else if (!ready) batchRepair.add(group.number)
          }
        } catch (error) {
          if (signal.aborted) throw error
          const failure = workflowFailure(error)
          for (const group of pack.groups) {
            const current = store.get(draftId)!.groups.find(entry => entry.number === group.number)!
            store.saveGroup(draftId, { ...current, status: 'error', issues: [errorIssue(failure.code, failure.message, 'provider', group.number)], error: failure.message }, leaseToken)
          }
          transportFailed = !automaticRecovery || providerCircuitOpen; progress(pack.groups[0].number)
          if (automaticRecovery) for (const group of pack.groups) batchRepair.add(group.number)
        }
      }
      if (transportFailed || providerCircuitOpen) break
      for (const group of pack.groups) {
        if (providerCircuitOpen || transportFailed) break
        if (noAutomaticRepair.has(group.number)) { noAutomaticGroups.add(group.number); continue }
        await generateGroup(group, batchRepair.has(group.number) ? 1 : 2, false, batchRepair.has(group.number))
        if (!automaticRecovery && store.get(draftId!)!.groups.find(entry => entry.number === group.number)!.status === 'error') transportFailed = true
      }
      if (transportFailed || providerCircuitOpen) break
    }
    /**
     * D fallback: a group that reports its approved duration cannot hold its
     * original content (a duration conflict) cannot be fixed inside that group.
     * Ask the narrative planner to regroup once (an invalid new plan gets its
     * validation feedback, within the shared four planning requests), then
     * generate only the groups whose planned content changed. Groups whose own
     * lines, duration and scene are unchanged keep their finished storyboards.
     * A dialogue_budget error is not a trigger: a valid plan already fits every
     * group's assigned words, so the group's own repair fixes it.
     */
    let regrouped = false
    const regroupForCapacity = async () => {
      if (options.mode !== 'breakdown' || !automaticRecovery || regrouped || providerCircuitOpen || planningRequests >= 4) return false
      const draft = store.get(draftId!)!
      const capacityIssues = draft.groups.filter(group => group.status !== 'ready').flatMap(group => (group.issues as ValidationIssue[])
        .filter(issue => issue.severity === 'error' && issue.code === 'model_constraint_conflict' && issue.field === 'duration')
        .map(issue => ({ ...issue, shotNumber: group.number })))
      if (!capacityIssues.length) return false
      regrouped = true
      const { script: _script, ...planFacts } = facts
      const before = plan
      const keepPlan = (planIssues: ValidationIssue[]) => {
        // Keep the approved plan and every group as they are; record why regrouping failed.
        const currentPlan = store.get(draftId!)!.plan as any
        store.savePlan(draftId!, { ...currentPlan, issues: [...(currentPlan?.issues || []), ...planIssues] }, leaseToken)
        return false
      }
      options.onState?.('repairing', 1)
      logTaskProgress('StoryboardWorkflow', 'regroup-for-capacity', { groups: [...new Set(capacityIssues.map(issue => issue.shotNumber))] })
      let response: ModelResponse = { raw: before, issues: [], conflict: false }
      let rejected: unknown = before, issues: ValidationIssue[] = capacityIssues
      while (planningRequests < 4) {
        repairCalls++
        try {
          response = await ask('plan', buildNarrativePlanSchema(assets, units), {
            ...planFacts, source_units: units,
            source_speech_budgets: speechBudgets.map(({ utterances, ...budget }) => ({ ...budget, utterances: utterances.map(({ text: _text, ...utterance }, index) => ({ ...utterance, utterance_index: index + 1 })) })), timing_budget: scriptTimingBudget(context.script),
            planning_constraints: buildStoryboardPlanningConstraints({ plan: rejected, script: context.script, speechBudgets, issues }),
            script_body_budget: { ...budgetSummary, body_source_ids: bodyAnalysis.includedSourceIds, metadata_source_ids: bodyAnalysis.excludedSourceIds },
            task: options.message, directed_repair: { rejected_plan: rejected, issues,
              instruction: rejected === before
                ? '分镜生成时，issues中的组报告已批准时长装不下本组原文内容。请只调整这些组及必要的相邻组：重新分配相邻原文归属、拆分或调整时长，其余组的原文归属、时长和场景尽量保持不变，以便保留已完成的分镜。原文、动作因果、全部对白和收尾必须保留；单组最多15秒；过长原文可以按原有标点跨相邻组共享source_id，不切断词语、不加速或删词。返回完整groups，不只返回修改说明。'
                : '上一份重新分组的规划未通过检查。按issues修正整份规划，仍只调整装不下的组及必要的相邻组，其余组的原文归属、时长和场景尽量保持不变。原文、动作因果、全部对白和收尾必须保留；单组最多15秒，不切断词语、不加速或删词。返回完整groups，不只返回修改说明。' },
          }, true, true)
        } catch (error) {
          if (signal.aborted) throw error
          const failure = workflowFailure(error)
          return keepPlan([errorIssue(failure.code, failure.message, 'plan')])
        }
        if (response.conflict) { issues = response.issues; break }
        const planned = normalizePlanSubmission(response.raw)
        if (planned.notes.length) { logTaskProgress('StoryboardWorkflow', 'plan-format-normalized', { notes: planned.notes, regroup: true }); response = { ...response, raw: planned.raw } }
        rejected = response.raw
        issues = [...response.issues, ...validateNarrativePlan(response.raw, units, assets, context.script)]
        if (!issues.some(issue => issue.severity === 'error')) break
      }
      if (issues.some(issue => issue.severity === 'error')) return keepPlan(issues.filter(issue => issue.severity === 'error'))
      plan = response.raw as NarrativePlan
      const reconciled = reconcileDraftGroups(before, plan.groups, store.get(draftId!)!.groups)
      store.savePlan(draftId!, { data: plan, issues, budget: budgetSummary }, leaseToken)
      store.replaceGroups(draftId!, reconciled.groups, leaseToken)
      // Request counts, automatic-repair blocks and one-time patch markers belong
      // to group numbers; carry them only for kept groups (renumbered if moved).
      const carry = <T>(entries: Map<number, T>) => {
        const old = new Map(entries); entries.clear()
        for (const [from, to] of reconciled.moved) if (old.has(from)) entries.set(to, old.get(from)!)
      }
      const carrySet = (entries: Set<number>) => {
        const old = new Set(entries); entries.clear()
        for (const [from, to] of reconciled.moved) if (old.has(from)) entries.add(to)
      }
      carry(requestCounts); carry(requestFailures); carrySet(noAutomaticGroups); carrySet(lockedGroups); carrySet(attemptedTargetedRepair); carrySet(waitingForPrevious)
      // A reporting group that the new plan kept unchanged gets one more try.
      const reporters = new Set(capacityIssues.map(issue => issue.shotNumber))
      for (const [from, to] of reconciled.moved) if (reporters.has(from)) noAutomaticGroups.delete(to)
      rebuildVoiceProfiles()
      applySharedSpeech()
      progress()
      for (const group of plan.groups) {
        if (providerCircuitOpen) break
        await generateGroup(group, 2)
      }
      return true
    }
    if (!transportFailed) await regroupForCapacity()
    if (!transportFailed) await repairPendingBoundaries()
    /**
     * While at least one group is still failing, the whole-episode review cannot
     * run, so a ready group's own missing words stay hidden until every other
     * group passes. Report only words that are certainly missing (see
     * missingOwnSpeech) and send that group back for repair (E).
     */
    const markReadySourceGaps = (current: StoryboardDraft) => {
      if (options.mode !== 'breakdown') return
      const speechOf = (group: DraftGroup) => {
        const candidate = stored(group), value = candidate.data || candidate.preview
        return value && typeof value === 'object' && typeof (value as any).description === 'string' ? assignmentSpeech(value as SkillCandidate, speakerNames) : ''
      }
      const episodeSpeech = current.groups.map(speechOf).filter(Boolean)
      let marked = false
      for (const group of current.groups) {
        if (group.status !== 'ready' || !stored(group).data) continue
        const local = missingOwnSpeech({ plan: plan.groups, budgets: speechBudgets, groupNumber: group.number, episodeSpeech })
        if (!local.length) continue
        store.saveGroup(draftId!, { ...group, status: 'needs_revision', issues: [...(group.issues as ValidationIssue[]).filter(row => row.severity !== 'error'), ...local] }, leaseToken)
        marked = true
      }
      if (marked) { rebuildVoiceProfiles(); progress() }
    }
    const reviewAndMark = () => {
      const current = store.get(draftId!)!
      if (current.groups.some(group => group.status !== 'ready')) {
        // Some group is still failing. Its own repair continues, but other ready
        // groups may hide an error only the whole-episode review finds (e.g. a
        // missing second half of a line). Review the ready groups' own source
        // lines now so every failing group gets its finishing turn (E).
        markReadySourceGaps(current)
        return [] as ValidationIssue[]
      }
      const review = options.session.reviewCompleteCandidates(current.groups.map(group => stored(group).data!))
      const errorsByGroup = new Map<number, ValidationIssue[]>()
      for (const issue of review.filter(issue => issue.severity === 'error')) {
        const matches = issue.shotNumber !== undefined
          ? current.groups.filter(group => stored(group).data?.shot_number === issue.shotNumber)
          : issue.field.startsWith('source_ids.')
            ? current.groups.filter(group => plan.groups.find(row => row.number === group.number)?.source_ids.includes(Number(issue.field.slice('source_ids.'.length)))) : []
        for (const group of matches) {
          errorsByGroup.set(group.number, [...(errorsByGroup.get(group.number) || []), issue])
        }
      }
      for (const [number, errors] of errorsByGroup) {
        const latest = store.get(draftId!)!.groups.find(row => row.number === number)!
        store.saveGroup(draftId!, { ...latest, status: 'needs_revision', issues: [...(latest.issues as ValidationIssue[]).filter(row => row.severity !== 'error'), ...errors] }, leaseToken)
      }
      if (errorsByGroup.size) progress()
      return review
    }
    if (automaticRecovery && !providerCircuitOpen) {
      // Every failing group gets a finishing turn in each pass (E). A group whose
      // own request budget is spent no longer blocks the others. Groups are taken
      // one at a time in order so that a group waiting for its previous group
      // (round 3) is reconsidered right after that group passes.
      for (let pass = 0; pass < 2; pass++) {
        signal.throwIfAborted()
        // A duration conflict first reported while finishing still gets its one regroup.
        if (!regrouped) await regroupForCapacity()
        await repairPendingBoundaries()
        releaseWaitingGroups()
        const review = reviewAndMark()
        const eligible = (group: DraftGroup) => group.status !== 'ready' && !noAutomaticGroups.has(group.number)
          && !lockedGroups.has(group.number) && (requestCounts.get(group.number) || 0) < 4
        if (!store.get(draftId)!.groups.some(eligible)) break
        const handled = new Set<number>()
        for (;;) {
          if (providerCircuitOpen) break
          releaseWaitingGroups()
          const next = store.get(draftId)!.groups.filter(group => eligible(group) && !handled.has(group.number)).sort((a, b) => a.number - b.number)[0]
          if (!next) break
          handled.add(next.number)
          const planned = plan.groups.find(row => row.number === next.number)!
          await generateGroup(planned, 1, true)
          await repairPendingBoundaries()
        }
        if (review.some(issue => issue.severity === 'error' && issue.shotNumber === undefined && !issue.field.startsWith('source_ids.'))) break
      }
      const review = reviewAndMark()
      if (review.some(issue => issue.severity === 'error')) {
        const currentPlan = store.get(draftId)!.plan as any
        store.savePlan(draftId, { ...currentPlan, issues: [...validateNarrativePlan(plan, units, assets, context.script), ...review.filter(issue => issue.severity === 'error')] }, leaseToken)
        if (store.get(draftId)!.groups.every(group => group.status === 'ready')) {
          store.setStatus(draftId, 'needs_revision', leaseToken); progress(); return result('needs_revision', 0, review)
        }
      }
    }
    const finalDraft = store.get(draftId)!
    const issues = finalDraft.groups.flatMap(group => group.issues as ValidationIssue[])
    if (finalDraft.groups.some(group => group.status !== 'ready')) { store.setStatus(draftId, 'needs_revision', leaseToken); return result('needs_revision', 0, issues) }
    signal.throwIfAborted(); options.onState?.('validating', repairCalls ? 1 : 0)
    if (automaticRecovery) {
      const currentPlan = store.get(draftId)!.plan as any
      store.savePlan(draftId, { ...currentPlan, issues: options.mode === 'breakdown' ? validateNarrativePlan(plan, units, assets, context.script) : [] }, leaseToken)
    }
    store.setStatus(draftId, 'ready', leaseToken)
    for (const [index, group] of finalDraft.groups.entries()) {
      const data = stored(group).data!
      if (options.mode === 'prompt') options.session.stageUpdate(options.storyboardIds![index], { video_prompt: data.video_prompt, time_row_counts: data.time_row_counts })
      else options.session.stageSave([data], { replaceExisting: index === 0, isFinalBatch: index === finalDraft.groups.length - 1 })
    }
    options.session.setCommitHook(() => store.setStatus(draftId!, 'committed', leaseToken))
    const finished = await bounded(options.session.finish(), signal)
    signal.throwIfAborted()
    const done = finished.saved > 0 && !finished.issues.some(issue => issue.severity === 'error')
    if (!done) {
      for (const issue of finished.issues.filter(issue => issue.severity === 'error')) {
        const matched = issue.shotNumber !== undefined ? finalDraft.groups.filter(group => issue.shotNumber === stored(group).data?.shot_number)
          : finalDraft.groups.filter(group => issue.field.startsWith('source_ids.') && plan.groups.find(planGroup => planGroup.number === group.number)?.source_ids.includes(Number(issue.field.slice('source_ids.'.length))))
        for (const group of matched) store.saveGroup(draftId, { ...group, status: 'needs_revision', issues: [...group.issues, issue] }, leaseToken)
      }
      const currentPlan = store.get(draftId)!.plan as any
      store.savePlan(draftId, { ...currentPlan, issues: [...(currentPlan?.issues || []), ...finished.issues.filter(issue => issue.severity === 'error')] }, leaseToken)
      store.setStatus(draftId, 'needs_revision', leaseToken); progress()
    }
    return result(done ? 'done' : 'needs_revision', finished.saved, [...issues, ...finished.issues])
  } catch (error) {
    if (!draftId) throw error
    const failure = extractTextProviderFailure(error)
    const interrupted = store.get(draftId)!
    const interruptionIssue = errorIssue(failure.code, failure.message)
    for (const group of interrupted.groups.filter(group => group.status === 'generating')) {
      store.saveGroup(draftId, { ...group, status: group.candidate ? 'needs_revision' : 'pending', issues: [...group.issues, interruptionIssue] }, leaseToken)
    }
    const currentPlan = interrupted.plan as any
    store.savePlan(draftId, { ...currentPlan, issues: [...(currentPlan?.issues || []), interruptionIssue] }, leaseToken)
    store.setStatus(draftId, signal.aborted ? 'interrupted' : 'needs_revision', leaseToken)
    return result('needs_revision', 0, [errorIssue(failure.code, failure.message)])
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', cancel)
    options.session.cancel('本次生成已结束，草稿已持久保存')
    if (draftId && leaseToken) store.release(draftId, leaseToken)
    controller.abort(new Error('本次生成已结束'))
  }
}

export function publicStoryboardDraft(draft: StoryboardDraft | null) {
  if (!draft) return null
  const plan = draft.plan as any
  return {
    id: draft.id, status: draft.status, mode: draft.mode, plan: plan?.data || null, issues: plan?.issues || [],
    budget: plan?.budget || null,
    boundaryRepairs: (draft.boundaryRepairs || []).map(({ before: _before, dependentBefore: _dependent, ...record }) => record),
    total: draft.groups.length, readyCount: draft.groups.filter(group => group.status === 'ready').length,
    needsRevisionCount: draft.groups.filter(group => ['needs_revision', 'error'].includes(group.status)).length,
    groups: draft.groups.map(group => ({ ...group, candidate: stored(group).data || stored(group).preview || null })),
    createdAt: draft.createdAt, updatedAt: draft.updatedAt,
  }
}
