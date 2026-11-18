import { createTool } from '@mastra/core/tools'
import { createStoryboardSegmentAgent } from '../agents/index.js'
import { storyboardTools } from '../agents/tools/storyboard-tools.js'
import { runAgentText } from './agent-text-stream.js'
import { buildScheduledSegmentResponseSchema, buildScheduledSegmentSchema, compileScheduledSegment, getScheduledShotLayout, type ScheduledDialogueGroup, type ScheduledSegmentAssets } from './scheduled-storyboard-segment.js'
import type { buildDialogueTimingGuide } from './first-pass-instructions.js'
import type { StoryboardSession, ValidationIssue } from './storyboard-session.js'

type Phase = 'generating' | 'validating' | 'repairing'
type Guide = ReturnType<typeof buildDialogueTimingGuide>
export interface ScheduledStoryboardOptions {
  episodeId: number
  dramaId: number
  requestContext: any
  session: StoryboardSession
  message: string
  signal?: AbortSignal
  onState?: (phase: Phase, attempt: number) => void
}
/** Explicit offline seams; production uses the real read tool and Agent factory. */
export interface ScheduledStoryboardDependencies {
  readContext?: (requestContext: any) => Promise<any>
  createAgent?: (tools: Record<string, any>, instructions: string, responseSchema?: Record<string, unknown>) => any | Promise<any>
  timeoutMs?: number
  textMode?: 'complete' | 'stream'
  outputMode?: 'json' | 'tool'
}

const protocol = `本次只创作一个已经排好时间与原文槽位的分镜组。只调用 submitStoryboardSegment 一次，直接完整填写当前工具支持的创作字段，不自检、不追加说明、不调用其他工具。
完整剧本决定人物、动作、场景、原有主要过程与结果；当前原文前的动作与换场应在本组表现，连续组承接上一组末态。同一原句的后续分组继续未完成动作，不重演已完成动作；最后一组保留剧本收尾。不能因为固定槽位遗漏原剧情或虚构新动作。
组时长、shot字段数量、全组visuals总行数、台词原词、说话者、类型和口播时间均由服务器固定。每镜visuals允许1–2行，按本组列出的合法布局分配，全组总行数和原文槽位顺序不得改变。只返回工具要求的创作字段，不重抄description/video_prompt，不把台词写进visuals。每个visual对应固定3秒，先写完整拍摄主体、景别/机位与单一运镜，再写动作触发、过程、回应、微动作、坐标/朝向/持物承接及实际光源与必要音效。
visuals严禁复写台词或引用原句；可以按事实写口型、发声准备和嘴部动作，但不要附上引号原文，也不要另加对白。原文只由服务器在固定槽位填回一次。
每镜characters只填写该镜真实人物及可见性；明确面部可见者填写适用神情与强度，背影、遮脸、画外不虚构可见表情。神情强度只在characters.emotion.intensity填写，visuals不重复写情绪百分比，服务器会合成。绑定的视线对象不代表实际入镜。本组原文只有一个来源说话者，优先在顶层voice一次写完整年龄听感、音域、核心音色和气息语气身体状态；有声镜头可省略自己的voice，服务器会复用实际提供的顶层资料。某镜需要独立气息身体状态时，可用完整shot_i.voice覆盖，四项仍需齐全。无声镜头不加声音，不编造音色绑定，固定声音描述按skill保持精简。space建立或明确继承同一场景的A0与X/Y基准，不自造新实体，不跨场景。最终整组正文须在3600字符以内，每个visual以约150–250汉字完整写清当前3秒动作与摄影重点，避免逐行重抄整段静态坐标、情绪及声音模板，不删剧情或原词凑字数。`

function failure(code: string, message: string, group?: number): ValidationIssue {
  return { code, field: 'segment', severity: 'error', message, ...(group ? { shotNumber: group } : {}) }
}
function resultValue(entry: any): any {
  const payload = entry?.payload || entry
  let value = payload?.result ?? payload?.output ?? entry?.result ?? entry?.output
  for (let depth = 0; depth < 2 && value && typeof value === 'object' && ['json', 'text'].includes(value.type)
    && Object.hasOwn(value, 'value'); depth++) value = value.value
  if (typeof value === 'string') { try { value = JSON.parse(value) } catch { /* plain diagnostic */ } }
  return value
}
function submissionInput(call: any): unknown {
  const payload = call?.payload || call
  for (let value of [payload?.args, payload?.input, call?.args, call?.input,
    payload?.function?.arguments, call?.function?.arguments, payload?.arguments, call?.arguments,
    payload?.result?.input, call?.result?.input]) {
    if (value === undefined) continue
    for (let depth = 0; depth < 2 && value && typeof value === 'object' && ['json', 'text'].includes(value.type)
      && Object.hasOwn(value, 'value'); depth++) value = value.value
    if (typeof value === 'string') { try { return JSON.parse(value) } catch { return value } }
    return value
  }
  return undefined
}
function groupProtocol(group: ScheduledDialogueGroup, jsonOutput = false): string {
  const allocations = jsonOutput ? [getScheduledShotLayout(group.rows.length)]
    : group.rows.length === 3 ? [[1, 2], [2, 1]] : group.rows.length === 4 ? [[2, 2]] : [[2, 2, 1], [2, 1, 2], [1, 2, 2]]
  const shape: Record<string, unknown> = {
    title: '<string：本组标题>', scene_id: '<number：现有场景ID，或null>', prop_ids: ['<number：现有道具ID；无道具填空数组>'],
    atmosphere: '<string：剧本已有环境与光线>', space: '<string：有事实依据的A0、X/Y及本组初态>',
    voice: { age: '<string：本组同一说话者的听感年龄>', register: '<string：音域>', timbre: '<string：核心音色>', delivery: '<string：本组气息语气与身体状态>' },
  }
  const fields = getScheduledShotLayout(group.rows.length).map((count, index) => {
    const shot = `shot_${index + 1}`
    shape[shot] = {
      characters: [{ character_id: '<number：现有角色ID>', visibility: '<face_visible|face_hidden|offscreen|uncertain>',
        emotion: { expression: '<string：仅面部清晰时写实际神情>', intensity: '<number：0–100，仅面部清晰时填写>' } }],
      visuals: Array.from({ length: count }, (_, row) => row === 0
        ? '<string：本镜起始3秒的完整画面与动作>' : '<string：同一镜头接续3秒，延续机位、焦段、景别、运镜与动作，不另切镜>'),
    }
    return `${shot}：characters填本镜实际人物，visuals建议${count}项，允许1–2项且必须与其他镜头合计精确${group.rows.length}项。${shot}的voice可省略并复用顶层完整voice；是否有声按最终时间行分到的原文槽确定，无原文槽的镜头不加声音。如需覆盖，${shot}.voice必须为完整对象{age,register,timbre,delivery}，不接受半份资料。`
  })
  const instructions = `${protocol}\n本组submitStoryboardSegment的完整字段形状示意如下：尖括号只说明类型，不是默认剧情事实，必须换成来自当前剧本的真实创作内容。一次提交必须同时包含下面全部shot_i键，不是只填shot_1，也不是多个镜头二选一。visuals展示的是建议布局，合法布局为${JSON.stringify(allocations)}；每镜1–2行，全组必须精确${group.rows.length}行，不能增删时间或原文槽。优先按示意只在顶层填写一次完整voice，各shot可以省略voice；原有完整逐镜voice也兼容，但没有顶层资料时每个实际有声镜都必须提供完整voice。\n${JSON.stringify(shape, null, 2)}\n本组具体字段要求（以工具schema为准）：\n${fields.join('\n')}\n一个shot内visuals的第2项是同一机位、焦段、景别和主要运镜的延续，不再写“切到/切回”，不另换镜头；不要把每个时间行都当一个新镜头。不要返回rows、dialogue或rows[].dialogue，不在visuals中重抄台词。`
  return jsonOutput ? instructions
    .replace('只调用 submitStoryboardSegment 一次，直接完整填写当前工具支持的创作字段，不自检、不追加说明、不调用其他工具。', '只返回一个完整的 JSON 对象，直接完整填写下面列出的创作字段。不要调用工具、不要Markdown代码围栏、不要额外文字，所有字符串使用合法JSON双引号。')
    .replace('本组submitStoryboardSegment的完整字段形状', '本组JSON对象的完整字段形状')
    .replace('以工具schema为准', '以本组JSON字段规范为准')
    + '\n本次响应JSON Schema已固定每镜visuals行数，必须精确按上方示意分配，不能返回空数组或改分配。所有required字段完整返回，可选对象按schema用null表示未填写。本组有原文发声时，顶层voice必须填写完整age/register/timbre/delivery对象，不能为null；各shot_i.voice可用null复用顶层资料，或填写该镜完整覆盖资料。面部可见的每个人物必须有神情及强度，不能以null代替必需事实。每镜先确定拍摄主体，在characters列出主体及其他实际可见人物或身体局部，再围绕这份人物表写visuals；不可一面写人物站姿、面部或手部动作一面漏掉其人物记录。已知人物发声的镜头不能用空characters，纯环境或反应镜头可将未入镜说话者注明offscreen，不虚构可见表情；纯视线/对话目标无需假装入镜。'
    : instructions
}

function completionFacts(full: any, steps: any[]) {
  const last = steps.at(-1)
  const reasons = new Set(['stop', 'length', 'content-filter', 'tool-calls', 'tool_calls', 'error', 'other', 'unknown', 'max-steps', 'max_tokens'])
  const finishReason = [full?.finishReason, last?.finishReason].find(value => typeof value === 'string' && reasons.has(value)) || 'unknown'
  const usages = [full?.usage, full?.totalUsage, last?.usage]
  for (const usage of usages) for (const value of [usage?.outputTokens, usage?.outputTokens?.total, usage?.completionTokens, usage?.outputTokenCount]) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return { finishReason, outputTokens: value }
  }
  return { finishReason, outputTokens: null }
}
function safeIdentifier(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(value)
    && !/^(?:sk-|Bearer)/i.test(value) ? value : null
}
function toolObservations() {
  const types = new Set<string>(), names = new Set<string>(), errorNames = new Set<string>(), resultTypes = new Set<string>()
  const inputs = new Map<string, { toolName: string | null; inputChars: number; started: boolean; ended: boolean; callSeen: boolean; oversized: boolean; text: string }>()
  const errorMetadata = (error: any) => {
    for (let depth = 0; depth < 5 && error && typeof error === 'object'; depth++, error = error.cause) {
      const name = safeIdentifier(error.name)
      if (name && errorNames.size < 64) errorNames.add(name)
    }
  }
  const observe = (chunk: any) => {
    const type = safeIdentifier(chunk?.type)
    if (type && types.size < 64) types.add(type)
    if (!type?.includes('tool')) return
    const payload = chunk?.payload || chunk
    const name = safeIdentifier(payload?.toolName ?? payload?.name ?? chunk?.toolName ?? chunk?.name)
    if (name && names.size < 64) names.add(name)
    const key = payload?.toolCallId ?? payload?.id ?? name ?? 'unnamed'
    if (!inputs.has(key) && inputs.size < 64) inputs.set(key, { toolName: name, inputChars: 0, started: false, ended: false, callSeen: false, oversized: false, text: '' })
    const input = inputs.get(key)
    if (input) {
      if (name) input.toolName = name
      if (type === 'tool-call-input-streaming-start' || type === 'tool-input-start') input.started = true
      if (type === 'tool-call-input-streaming-end' || type === 'tool-input-end') input.ended = true
      if (type === 'tool-call' || type === 'tool-input-available') input.callSeen = true
      const delta = payload?.argsTextDelta ?? payload?.inputTextDelta
      if ((type === 'tool-call-delta' || type === 'tool-input-delta') && typeof delta === 'string') {
        input.inputChars += delta.length
        if (input.inputChars <= 200_000) input.text += delta
        else { input.oversized = true; input.text = '' }
      }
    }
    if (type.includes('error')) errorMetadata(payload?.error ?? chunk?.error)
    if (type === 'tool-result' || type === 'tool-output-available' || type === 'tool-error') {
      resultTypes.add(type)
      const output = payload?.result ?? payload?.output
      const outputType = safeIdentifier(output?.type)
      if (outputType) resultTypes.add(outputType)
      errorMetadata(output?.error)
      const resultName = safeIdentifier(output?.name)
      if (output?.error && resultName) errorNames.add(resultName)
    }
  }
  return { observe, facts: (full: any, steps: any[], calls: any[], results: any[]) => {
    calls.forEach(call => observe({ ...call, type: call?.type || 'tool-call' }))
    results.forEach(result => observe({ ...result, type: result?.type || 'tool-result' }))
    const stepEventTypes = steps.map(step => [...new Set((Array.isArray(step.content) ? step.content : []).map((entry: any) => safeIdentifier(entry?.type)).filter(Boolean))] as string[])
    for (const step of steps) for (const entry of Array.isArray(step.content) ? step.content : []) {
      if (String(entry?.type || '').includes('tool')) observe(entry)
    }
    const toolInputs = [...inputs.values()].map(input => {
      let inputState: 'unavailable' | 'valid_json' | 'invalid_json' | 'oversized' = 'unavailable'
      if (input.oversized) inputState = 'oversized'
      else if (input.inputChars) { try { JSON.parse(input.text); inputState = 'valid_json' } catch { inputState = 'invalid_json' } }
      input.text = '' // Raw deltas are transient and never enter the returned diagnostics.
      return { toolName: input.toolName, inputChars: input.inputChars, started: input.started, ended: input.ended, callSeen: input.callSeen, inputState }
    })
    return { toolNames: [...names], callCount: Math.max(calls.length, inputs.size), parsedCallCount: calls.length,
      toolResultTypes: [...resultTypes], toolErrorNames: [...errorNames], eventTypes: [...types], stepEventTypes,
      fullFinishReason: safeIdentifier(full?.finishReason), toolInputs }
  } }
}
function unexecutedToolMessage(facts: ReturnType<ReturnType<typeof toolObservations>['facts']>): string {
  const unknown = facts.toolNames.find(name => name !== 'submitStoryboardSegment')
  if (unknown) return `模型调用了未注册工具 ${unknown}，当前只允许 submitStoryboardSegment；没有执行分镜提交`
  if (facts.toolInputs.some(input => input.inputState === 'invalid_json')) return '工具参数不是可解析的完整JSON，SDK未形成可执行的提交；请按固定字段形状重新提交'
  if (facts.toolInputs.some(input => input.inputState === 'oversized')) return '工具参数流超过本地诊断长度上限，未形成可执行提交'
  if (facts.toolErrorNames.length) return `工具调用未执行，SDK错误类型：${facts.toolErrorNames.join('、')}`
  if (facts.toolInputs.some(input => input.started && !input.ended && !input.callSeen)) return '已收到工具参数流，但未收到完整工具调用；当前组没有执行提交'
  if (facts.callCount) return '已收到工具调用但没有执行当前组提交，请核对工具输入与SDK事件诊断'
  return '模型没有发出当前组要求的工具提交'
}
function safeToolMessage(value: any): string {
  const raw = typeof value?.error === 'string' ? value.error : value?.message || '当前组未满足固定提交结构'
  return String(raw).split(/\n\s*Provided arguments:/i)[0]
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]')
    .replace(/\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]+/gi, '[REDACTED]').slice(0, 1500)
}
async function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort: (() => void) | undefined
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new Error('分镜任务已中止'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  try { return await Promise.race([work, cancelled]) }
  finally { if (abort) signal.removeEventListener('abort', abort) }
}

function scriptSlices(script: string, guide: Guide) {
  const slices = new Map<number, string>()
  let cursor = 0, previousEnd = 0
  for (const [index, line] of guide.entries()) {
    const text = line.fragments.join('')
    const position = script.indexOf(text, cursor)
    if (position < 0) continue
    cursor = position + text.length
    const newline = script.indexOf('\n', cursor)
    const end = index === guide.length - 1 || newline < 0 ? script.length : newline + 1
    if (end > previousEnd) slices.set(line.source_line, script.slice(previousEnd, end))
    previousEnd = Math.max(previousEnd, end)
  }
  return slices
}
function assetFacts(rows: any[]) {
  return rows.map(({ image_url: _image, reference_images: _references, ...facts }) => facts)
}

/** One bounded creative submission per canonical group; the episode commits only once. */
export async function runScheduledStoryboardBreakdown(options: ScheduledStoryboardOptions, dependencies: ScheduledStoryboardDependencies = {}) {
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const timeoutMs = Math.min(10 * 60_000, Math.max(1, dependencies.timeoutMs ?? 10 * 60_000))
  const timer = setTimeout(() => controller.abort(new Error('本次分镜处理超时，旧稿已保留')), timeoutMs)
  timer.unref?.()
  let fallback = false, attempt = 0
  let cancelOnAbort: (() => void) | undefined
  const summaries: Array<{ group: number; duration: number; attempt: number; modelSteps: number; submissions: number; staged: boolean; issueCodes: string[]; errorMessages: string[]; finishReason: string; outputTokens: number | null } & ReturnType<ReturnType<typeof toolObservations>['facts']>> = []
  const report = (status: 'done' | 'needs_revision', saved: number, issues: ValidationIssue[]) => ({
    status, saved, issues, attempt, result: { steps: summaries }, candidateReport: options.session.getReport(),
  })
  try {
    options.requestContext.set('storyboardSession', options.session)
    const context = await withAbort(Promise.resolve(dependencies.readContext
      ? dependencies.readContext(options.requestContext)
      : (storyboardTools.readStoryboardContext.execute as any)({}, { requestContext: options.requestContext })), signal)
    if (context?.error) return report('needs_revision', 0, [failure('scheduled_context', '当前集上下文读取失败，旧稿保持不变')])
    if (!Array.isArray(context?.dialogue_timing_guide) || !Array.isArray(context?.dialogue_group_schedule)) {
      return report('needs_revision', 0, [failure('scheduled_context', '当前集缺少可信对白容量表，未提交模型请求')])
    }
    const guide: Guide = context.dialogue_timing_guide
    const schedule: ScheduledDialogueGroup[] = context.dialogue_group_schedule
    if (!guide.length || guide.some(line => line.minimum_speech_seconds === undefined)) {
      fallback = true
      return null
    }
    if (!options.session.assertScope(options.episodeId, options.dramaId) || options.session.mode !== 'breakdown') {
      return report('needs_revision', 0, [failure('session_scope', '固定分组仅用于当前集的拆解会话')])
    }
    const assets: ScheduledSegmentAssets = { characters: context.characters || [], scenes: context.scenes || [], props: context.props || [] }
    const expected = guide.flatMap(line => line.fragments.map((_, index) => `${line.source_line}:${index + 1}`))
    const actual = schedule.flatMap(group => group.rows.filter(Boolean).map(ref => `${ref!.source_line}:${ref!.fragment_index}`))
    if (JSON.stringify(actual) !== JSON.stringify(expected) || schedule.some((group, index) => group.source_group !== index + 1
      || ![3, 4, 5].includes(group.rows.length) || group.duration !== group.rows.length * 3)) {
      return report('needs_revision', 0, [failure('scheduled_source_coverage', '固定分组未按顺序完整覆盖原文片段，未提交模型请求')])
    }
    const slices = scriptSlices(context.script || '', guide)
    const facts = { episode: context.episode, script: context.script, characters: assetFacts(assets.characters), scenes: assetFacts(assets.scenes), props: assetFacts(assets.props) }
    const jsonOutput = dependencies.outputMode !== 'tool'
    const factory = dependencies.createAgent || ((tools, instructions, responseSchema) => createStoryboardSegmentAgent(tools, instructions, jsonOutput, responseSchema))
    // Cancel synchronously on abort, including during finish()'s asynchronous
    // phase hooks, before any transaction continuation can commit the draft.
    cancelOnAbort = () => options.session.cancel('本次固定分组处理已中止')
    signal.addEventListener('abort', cancelOnAbort, { once: true })
    signal.throwIfAborted()
    options.session.beginAttempt(0)
    for (const [index, group] of schedule.entries()) {
      let repairingCurrent = false, repairInput: unknown
      for (;;) {
        signal.throwIfAborted()
        options.onState?.(repairingCurrent ? 'repairing' : 'generating', attempt)
        let submissions = 0, staged: any, active = true, submittedInput: unknown
        const observed = toolObservations()
        const schema = buildScheduledSegmentSchema(group, assets)
        const submit = async (input: unknown) => {
            if (!active || signal.aborted) return { error: '当前组提交已关闭，未暂存任何迟到内容' }
            submissions++
            if (submissions !== 1) {
              options.session.recordToolInputError('submitStoryboardSegment', '一个分组只能提交一次创作结果', { source_group: group.source_group })
              return { error: '一个分组只能提交一次创作结果', issues: options.session.getIssues() }
            }
            submittedInput = input
            try {
              const candidate = compileScheduledSegment(input, group, guide, assets)
              signal.throwIfAborted()
              staged = options.session.stageSave([candidate], { replaceExisting: index === 0, isFinalBatch: index === schedule.length - 1 })
              return staged
            } catch (error) {
              options.session.recordToolInputError('submitStoryboardSegment', safeToolMessage(error), input)
              return { error: '当前组创作字段无法组成合格分镜', issues: options.session.getIssues() }
            }
          }
        const tool = createTool({ id: 'submitStoryboardSegment', description: 'Submit only the creative fields for this one fixed storyboard group.', inputSchema: schema,
          execute: input => submit(input),
        })
        const previous = options.session.getReport().candidates.find(candidate => candidate.shot_number === group.source_group - 1)
        const previousDescription = previous?.description || ''
        const lastMarker = [...previousDescription.matchAll(/【镜头\d+】/g)].at(-1)?.index ?? 0
        const continuation = index > 0 && schedule[index - 1].source_line === group.source_line
        const currentSlots = group.rows.map(ref => {
          if (!ref) return null
          const source = guide.find(line => line.source_line === ref.source_line)!
          return { ...ref, speaker: source.speaker, kind: source.kind, text: source.fragments[ref.fragment_index - 1] }
        })
        const message = { task: options.message, ...facts,
          current_group: { number: group.source_group, total: schedule.length, duration: group.duration, total_rows: group.rows.length,
            shot_layout: getScheduledShotLayout(group.rows.length), shot_layout_is_suggestion: !jsonOutput,
            allowed_shot_layouts: jsonOutput ? [getScheduledShotLayout(group.rows.length)] : group.rows.length === 3 ? [[1, 2], [2, 1]] : group.rows.length === 4 ? [[2, 2]] : [[2, 2, 1], [2, 1, 2], [1, 2, 2]], slots: currentSlots, continuation },
          ...(!continuation && slices.has(group.source_line) ? { current_script_slice: slices.get(group.source_line) } : {}),
          previous_ending: previous ? { scene_id: previous.scene_id, space: previous.video_prompt_plan?.space, description: previousDescription.slice(lastMarker) } : null,
          ...(repairingCurrent ? { directed_repair: { issues: options.session.getIssues().filter(issue => issue.severity === 'error'), rejected_submission: repairInput,
            instruction: '本任务只允许这一次定向修正。按issue逐项修改当前组被拒的创作字段，保留固定来源、时长、行数及原剧情。plan_visual_participant指出的正式人物已在画面中：将该人物加入对应shot_i.characters，并按该镜实际面部可见性填写visibility及适用神情强度，画面边缘的肩头、手或眼睛同样属于实际参与者。纯视线或声音目标可保留画外；不能通过遗漏原有动作/人物来回避错误。请返回完成这些具体修改后的完整当前组JSON。' } } : {}),
        }
        const agent = await withAbort(Promise.resolve(factory(jsonOutput ? {} : { submitStoryboardSegment: tool }, groupProtocol(group, jsonOutput),
          jsonOutput ? buildScheduledSegmentResponseSchema(group, assets, guide) : undefined)), signal)
        let full: any
        try {
          full = await withAbort(runAgentText(agent, [{ role: 'user', content: JSON.stringify(message) }], {
            textMode: dependencies.textMode ?? 'complete',
            requestContext: options.requestContext, abortSignal: signal,
            ...(!jsonOutput ? { toolChoice: { type: 'tool', toolName: 'submitStoryboardSegment' } } : {}),
            stopWhen: ({ steps }: { steps: unknown[] }) => steps.length >= 1,
            onChunk: observed.observe,
          }), signal)
          if (jsonOutput) {
            // The provider constrains JSON syntax; the same local schema and
            // session still validate content before a single atomic commit.
            try {
              const parsed: unknown = JSON.parse(typeof full?.text === 'string' ? full.text : '')
              const checked = schema.safeParse(parsed)
              submittedInput = parsed
              if (!checked.success) {
                const message = checked.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('\n')
                options.session.recordToolInputError('scheduledJsonSegment', safeToolMessage({ message }), parsed)
              } else await submit(checked.data)
            } catch (error) {
              if (signal.aborted) throw error
              options.session.recordToolInputError('scheduledJsonSegment', '模型未返回可解析的完整JSON对象，当前组未保存', { source_group: group.source_group })
            }
          }
        } finally { active = false }
        signal.throwIfAborted()
        options.onState?.('validating', attempt)
        const steps: any[] = full?.steps || []
        const stepCalls = steps.flatMap(step => step.toolCalls || [])
        const calls: any[] = stepCalls.length ? stepCalls : full?.toolCalls || []
        const stepResults = steps.flatMap(step => step.toolResults || [])
        const toolResults: any[] = stepResults.length ? stepResults : full?.toolResults || []
        const observedFacts = observed.facts(full, steps, calls, toolResults)
        // SDK input validation can reject before execute(). Retain the actual
        // attempted structure for the directed repair instead of just a group ID.
        if (submittedInput === undefined) for (const entry of [...calls, ...toolResults]) {
          submittedInput = submissionInput(entry)
          if (submittedInput !== undefined) break
        }
        const rejectedInput = submittedInput === undefined ? { source_group: group.source_group } : submittedInput
        if (calls.length > 1 && !options.session.shouldStopAttempt()) options.session.recordToolInputError('submitStoryboardSegment', '单组响应包含多个提交，未接受重复提交', rejectedInput)
        for (const entry of toolResults) {
          const value = resultValue(entry)
          if ((value?.error || value?.name === 'ValidationError' || entry?.isError || entry?.payload?.isError) && !options.session.shouldStopAttempt()) {
            options.session.recordToolInputError('submitStoryboardSegment', safeToolMessage(value), rejectedInput)
          }
        }
        if (!submissions && !options.session.shouldStopAttempt()) options.session.recordToolInputError(jsonOutput ? 'scheduledJsonSegment' : 'submitStoryboardSegment', jsonOutput ? '当前JSON响应未形成有效分组提交' : unexecutedToolMessage(observedFacts), rejectedInput)
        const failed = !staged?.staged || Boolean(staged?.error) || options.session.shouldStopAttempt()
        const currentErrors = options.session.getIssues().filter(issue => issue.severity === 'error')
        summaries.push({ group: group.source_group, duration: group.duration, attempt, modelSteps: steps.length, submissions, staged: !failed, ...completionFacts(full, steps), ...observedFacts,
          issueCodes: [...new Set(currentErrors.map(issue => issue.code))],
          errorMessages: [...new Set(currentErrors.map(issue => safeToolMessage({ message: issue.message })))] })
        if (!failed) break
        if (attempt === 1) return report('needs_revision', 0, options.session.getIssues())
        repairInput = submittedInput
        attempt = 1
        options.session.beginAttempt(1)
        repairingCurrent = true
      }
    }
    signal.throwIfAborted()
    options.onState?.('validating', attempt)
    const finished = await withAbort(options.session.finish(), signal)
    signal.throwIfAborted()
    return report(finished.saved > 0 && !finished.issues.some(issue => issue.severity === 'error') ? 'done' : 'needs_revision', finished.saved, finished.issues)
  } finally {
    clearTimeout(timer)
    if (cancelOnAbort) signal.removeEventListener('abort', cancelOnAbort)
    if (!fallback) options.session.cancel('本次固定分组处理已结束')
    controller.abort(new Error('本次固定分组处理已结束'))
  }
}
