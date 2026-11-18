import { compileSkillInstructions, type CompiledSkillInstructions, type SkillInstructionSource } from './skill-instruction-compiler.js'

export type SkillWorkflowStage = 'plan' | 'expand' | 'prompt' | 'repair'
export interface SkillExecutionAdaptation {
  source: string
  sourceIndex: number
  sourceStart: number
  sourceEnd: number
  original: string
  replacement: string
}
export interface WorkflowCompiledInstructions extends CompiledSkillInstructions {
  executionAdaptations: SkillExecutionAdaptation[]
}

// Only execution syntax is translated. Keeping these replacements small is
// intentional: asset facts, creative clauses and custom skill additions are not
// summarized, filtered by keywords or reinterpreted by a model.
const executionSyntax: Array<[RegExp, string]> = [
  [/调用\s*`?read_storyboard_context`?，参数为\s*`\{\}`；从返回的/gu, '从协调器已经读取并提供的 context 的'],
  [/调用\s*`?read_storyboard_context`?，参数为\s*`\{\}`，读取/gu, '从协调器已经读取并提供的 context 读取'],
  [/调用\s*`?read_storyboard_context`?\s*读取/gu, '从协调器已经读取并提供的 context 读取'],
  [/调用 read_characters \/ read_scenes \/ read_props 读取资产信息/gu, '图片任务的资产读取由协调器提供，本次视频任务不执行图片资产读取'],
  [/调用 save_character_final_prompt \/ save_scene_final_prompt \/ save_prop_final_prompt 逐个保存/gu, '图片任务的逐项保存由协调器负责，本次视频任务不执行图片保存'],
  [/\b[Cc]all\s+`?read_storyboard_context`?\s+to\s+read/gu, 'Read from the coordinator-provided context:'],
  [/`?read_storyboard_context`?\s*を呼び出して[、，]?/gu, '協調処理が提供済みの context から'],
  [/read_characters \/ read_scenes \/ read_props を呼び出してアセット情報を読み込む/gu, '画像タスクの資料は協調処理が提供し、本動画タスクでは画像資料の読み込みを実行しない'],
  [/save_character_final_prompt \/ save_scene_final_prompt \/ save_prop_final_prompt を呼び出して1件ずつ保存する/gu, '画像タスクの保存は協調処理が担当し、本動画タスクでは実行しない'],
  [/`?read_storyboard_context`?\s*를 호출해/gu, '워크플로가 이미 제공한 context 에서'],
  [/read_characters \/ read_scenes \/ read_props 를 호출해 자산 정보를 읽습니다/gu, '이미지 작업 자료는 워크플로가 제공하며 이 비디오 작업에서 이미지 자료 읽기를 수행하지 않습니다'],
  [/save_character_final_prompt \/ save_scene_final_prompt \/ save_prop_final_prompt 를 호출해 하나씩 저장합니다/gu, '이미지 작업 저장은 워크플로가 담당하며 이 비디오 작업에서는 수행하지 않습니다'],
  [/分批调用\s*`?save_storyboards`?\s*保存/gu, '由协调器分批暂存并最终提交'],
  [/完成检查后调用\s*`?save_storyboards`?/gu, '完成内容检查后由协调器分批暂存并最终提交'],
  [/指定分镜修改用\s*`?update_storyboard`?/gu, '指定分镜修改由协调器按目标ID局部提交'],
  [/检查通过后调用\s*`?update_storyboard`?/gu, '检查通过后由协调器按目标ID局部提交'],
  [/调用\s*`?update_storyboard`?\s*保存时参数/gu, '由协调器执行目标更新时，保存参数'],
  [/\bCall save_storyboards in batches to save/gu, 'The coordinator stages batches and finally commits'],
  [/\bCall read_characters \/ read_scenes \/ read_props to read the asset information/gu, 'The coordinator provides image-task asset input; this video task does not read image assets'],
  [/\bCall save_character_final_prompt \/ save_scene_final_prompt \/ save_prop_final_prompt to save each one individually/gu, 'The coordinator persists image-task prompts; this video task does not save image prompts'],
  [/\bcall `save_storyboards` to save them in one go/gu, 'the coordinator stages them and commits the complete scope'],
  [/\bcall `update_storyboard` to modify/gu, 'the coordinator updates'],
  [/\bCall `update_storyboard` to update/gu, 'The coordinator updates'],
  [/When saving via update_storyboard,/gu, 'When the coordinator persists the targeted update,'],
  [/`?save_storyboards`?\s*をバッチ呼び出しで/gu, '協調処理がバッチ単位で'],
  [/`save_storyboards`\s*を呼び出して一括保存する/gu, '協調処理が一括保存する'],
  [/`update_storyboard`\s*を呼び出して/gu, '協調処理が'],
  [/update_storyboard\s*を呼び出して保存する際/gu, '協調処理が対象更新を保存する際'],
  [/save_storyboards\s*를 여러 번에 나누어 호출해/gu, '워크플로가 여러 배치로'],
  [/`save_storyboards`\s*를 호출해 한 번에 저장합니다/gu, '워크플로가 전체 범위를 저장합니다'],
  [/`update_storyboard`\s*를 호출해/gu, '워크플로가'],
  [/update_storyboard\s*를 호출해 저장할 때/gu, '워크플로가 대상 변경을 저장할 때'],
  [/根据工具返回确认结果/gu, '由协调器根据持久化结果确认实际进度'],
  [/连续完成本次任务范围内的全部批次，不只保存部分就结束。/gu, '协调器负责连续完成本次任务范围内的全部批次，不把部分保存称为全部完成。'],
  [/全部段落保存完成前不要结束（不要只保存部分段落就停止）/gu, '协调器持续推进直到全部段落保存完成，不在部分段落后停止'],
  [/do not finish until all segments are saved \(do not stop after saving only part of them\)/gu, 'the coordinator continues until all segments are saved, without treating a partial save as completion'],
  [/全パラグラフの保存が完了する前に終了しない（一部のパラグラフだけ保存して止まらない）/gu, '協調処理は全パラグラフを保存するまで進行し、部分保存を完了扱いにしない'],
  [/모든 구간을 저장하기 전에 끝내지 마세요\(일부 구간만 저장하고 멈추지 마세요\)/gu, '워크플로가 모든 구간의 저장까지 진행하고 부분 저장을 완료로 처리하지 않습니다'],
  [/只传工具支持的字段/gu, '成品只包含本阶段JSON Schema支持的字段'],
  [/不要把 `storyboard_id`、`episode_id` 等未声明参数传给读取工具。/gu, '读取参数由协调器管理，不额外生成未声明的读取参数。'],
  // Factual references to the old read result are input references, not calls.
  [/`?read_storyboard_context`?/gu, 'workflow_context'],
]

const outputSyntax: Array<[RegExp, string]> = [
  [/思考留在模型内部，输出只允许工具调用/gu, '思考留在模型内部，只返回本阶段JSON'],
  [/每个输出步骤必须是工具调用（或完成后的简短结束语），禁止先输出大段文字再调用工具/gu, '每次只返回本阶段JSON，不附带解释或结束语'],
  [/若因内容过多需要分多批，直接在连续的工具调用中完成全部批次，中间不要插入文字/gu, '全部批次的连续推进由协调器负责；本次只返回请求范围的JSON，不插入额外文字'],
  [/执行中使用工具调用，不输出规划、分析或长篇解释；批次间不插入叙述。完成后简短确认，阻断或保存失败时说明具体问题和实际进度，不把部分保存称为全部完成。/gu, '执行与保存确认由协调器负责；模型只返回本阶段JSON，不输出规划、分析、解释或结束语。资料阻断通过JSON冲突通道报告，不把部分结果称为全部完成。'],
  [/单条、批量和缺失补全采用同一规范。执行中只调用工具，不输出规划或大段解释；完成后简短确认。/gu, '单条、批量和缺失补全采用同一规范。模型只返回本阶段JSON，不输出规划、解释或结束语；保存和完成确认由协调器负责。'],
  [/必须实际调用保存工具，不要只在回复中给出提示词/gu, '协调器负责实际保存；模型必须返回本阶段要求的JSON成品'],
  [/keep thinking internal to the model; output may only be tool calls/gu, 'keep thinking internal to the model; return only the current-stage JSON'],
  [/Every output step must be a tool call \(or a brief closing line after completion\); it is forbidden to output a large block of text first and then call tools/gu, 'Return only the current-stage JSON, without extra explanations or a closing line'],
  [/If multiple batches are needed due to volume, complete all batches in consecutive tool calls with no text inserted in between/gu, 'The coordinator advances and persists every batch; return only the requested scope as JSON without extra text'],
  [/You must actually call the save tools — do not merely present the prompts in your reply/gu, 'The coordinator performs actual persistence; the model returns the current-stage JSON'],
  [/思考はモデル内部に留め、出力はツール呼び出しのみ許可する/gu, '思考はモデル内部に留め、本段階のJSONのみを返す'],
  [/各出力ステップは必ずツール呼び出し（または完了後の短い終了挨拶）でなければならない。大きな文章を先に出力してからツールを呼び出すことは禁止/gu, '本段階のJSONのみを返し、説明文や終了挨拶を付けない'],
  [/内容が多く複数バッチに分ける必要がある場合は、連続したツール呼び出しですべてのバッチを完了させ、途中に文字を挟まない/gu, '全バッチの進行と保存は協調処理が行う。本要求範囲のJSONのみを返す'],
  [/必ず実際に保存ツールを呼び出すこと。返答にプロンプトを書くだけで終わらせない/gu, '実際の保存は協調処理が行い、モデルは本段階のJSONを返す'],
  [/사고는 모델 내부에 두고, 출력은 도구 호출만 허용됩니다/gu, '사고는 모델 내부에 두고 현재 단계의 JSON만 반환합니다'],
  [/각 출력 단계는 반드시 도구 호출\(또는 완료 후의 짧은 종료 문구\)이어야 하며, 긴 텍스트를 먼저 출력한 뒤 도구를 호출하는 것은 금지됩니다/gu, '현재 단계의 JSON만 반환하고 설명이나 종료 문구를 덧붙이지 않습니다'],
  [/내용이 많아 여러 번에 나눠야 할 경우, 연속된 도구 호출로 모든 배치를 완료하고 중간에 텍스트를 끼워 넣지 마세요/gu, '워크플로가 모든 배치를 진행하고 저장합니다. 요청 범위의 JSON만 반환합니다'],
  [/반드시 저장 도구를 실제로 호출하세요. 답변에 프롬프트만 적고 끝내지 마세요/gu, '워크플로가 실제 저장을 수행하고 모델은 현재 단계의 JSON을 반환합니다'],
]

function quotedRanges(text: string) {
  const closes: Record<string, string> = { '「': '」', '『': '』', '“': '”', '‘': '’', '"': '"' }
  const ranges: Array<{ start: number; end: number }> = []
  for (let start = 0; start < text.length; start++) {
    const close = closes[text[start]]
    if (!close) continue
    let end = start + 1
    for (; end < text.length; end++) {
      if (text[end] === '\\') { end++; continue }
      if (text[end] === close) break
    }
    if (end < text.length) { ranges.push({ start, end: end + 1 }); start = end }
  }
  return ranges
}

function replaceExecutionSyntax(text: string, pattern: RegExp, replacement: string) {
  const protectedRanges = quotedRanges(text)
  return text.replace(pattern, (...args: any[]) => {
    const match = args[0] as string, start = args.at(-2) as number
    return protectedRanges.some(range => start < range.end && start + match.length > range.start) ? match : replacement
  })
}

/** Runtime-only execution adaptation; originals remain intact for hashing and audit. */
export function adaptSkillWorkflowSources(sources: readonly SkillInstructionSource[]) {
  const executionAdaptations: SkillExecutionAdaptation[] = []
  const adapted = sources.map((source, sourceIndex) => {
    let text = '', fenced: { character: string; length: number } | undefined
    for (const match of source.text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/gu)) {
      if (!match[0]) continue
      const original = match[0].replace(/(?:\r\n|\r|\n)$/u, '')
      let replacement = original
      const fence = original.match(/^ {0,3}(`{3,}|~{3,})/u)
      if (fence) {
        if (!fenced) fenced = { character: fence[1][0], length: fence[1].length }
        else if (fence[1][0] === fenced.character && fence[1].length >= fenced.length) fenced = undefined
      } else if (!fenced) for (const [pattern, value] of [...outputSyntax, ...executionSyntax]) replacement = replaceExecutionSyntax(replacement, pattern, value)
      if (replacement !== original) executionAdaptations.push({ source: source.source, sourceIndex,
        sourceStart: match.index!, sourceEnd: match.index! + original.length, original, replacement })
      text += replacement + match[0].slice(original.length)
    }
    return { ...source, text }
  })
  return { sources: adapted, executionAdaptations }
}

export function skillWorkflowProtocol(stage: SkillWorkflowStage): string {
  const scope = stage === 'plan'
    ? '本次阶段为叙事规划：只返回groups或明确conflict，不生成完整分镜正文。后面的成品内容规则是规划可行性依据，成品创作由后续阶段完成。'
    : stage === 'expand'
      ? '本次阶段为完整分镜创作：先按storyboard-breaker生成完整分镜，再在同一结果中按video-prompt生成视频字段。视频规范的“只更新video_prompt”仅限定这一步的视频转换职责，不禁止本阶段生成其他完整分镜字段。'
      : stage === 'prompt'
        ? '本次阶段为锁定分镜的视频转换：只返回video_prompt和time_row_counts；原description、镜数、场景、时长、绑定及其他字段均锁定。'
        : '本次阶段为既有成品的定向返修：只返回请求指定的base_version和changes补丁，不返回整组成品。所有内容规范完整约束合并后的成品；未授权的正文、时长、绑定、镜头与末态保持锁定。协调器合并补丁后执行相同完整校验，再决定保存。'
  return `本次工作流唯一执行协议：模型不执行工具调用。原规范中的读取已由协调器完成，数据在context、source_units、asset_catalog、asset_facts或locked_storyboard中提供；工具名仅是原规范的职责来源，不是待调用函数。保存、replace_existing、目标更新、全批次推进、事务及实际进度确认由协调器负责。模型只返回当前阶段JSON，不输出解释、工具调用或结束语；缺资料或真冲突按本阶段允许的conflict结构返回。图片章节仅适用于图片任务，本次分镜与视频任务不执行图片读取或保存。逐条创作、原词、动作、空间、表演、声音、光线、时长与绑定要求仍完整适用，不摘要、不截断、不为通过检查删改内容。\n${scope}`
}

export function compileSkillWorkflowInstructions(sources: readonly SkillInstructionSource[], stage: SkillWorkflowStage): WorkflowCompiledInstructions {
  const adapted = adaptSkillWorkflowSources(sources)
  const protocol = { source: `workflow-execution-protocol:${stage}`, text: skillWorkflowProtocol(stage) }
  const compiled = compileSkillInstructions([protocol, ...adapted.sources])
  return { ...compiled, executionAdaptations: adapted.executionAdaptations }
}
