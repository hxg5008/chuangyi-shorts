/**
 * 资产提取任务 — 异步执行，按「集 × 类型」粒度跟踪
 * 角色 / 场景 / 道具 可分别单独提取，同一集的不同类型可并行
 * 任务状态为进程内内存态：后端重启后运行中的任务状态丢失（Agent 调用本身已被中断）
 */
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { runAgentText } from './agent-text-stream.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { STYLING_COLOR_EXTRACTION_NOTE, VOICE_CARD_EXTRACTION_NOTE } from './character-voice-card.js'
import { alignVoiceCardVariants } from './character-voice-card-align.js'
import { currentActivity } from './activity/context.js'

export type ExtractTarget = 'characters' | 'scenes' | 'props'
export const EXTRACT_TARGETS: ExtractTarget[] = ['characters', 'scenes', 'props']

export interface ExtractTask {
  status: 'running' | 'done' | 'error'
  started_at: string
  finished_at?: string
  error?: string
}

/** Observation only: callers must not alter the Agent, its input or its saved output. */
export interface ExtractionLifecycleEvent {
  phase: 'started' | 'step' | 'done' | 'error'
  startedAt: string
  finishedAt?: string
  activityTaskId?: string
  step?: any
  result?: any
  error?: string
  providerHttpStatus?: number
}

/** Read existing transport evidence without rewriting the original exception or response. */
function extractionHttpStatus(error: any): number | undefined {
  const seen = new Set<any>()
  for (let value = error, depth = 0; value && depth < 6 && !seen.has(value); value = value.cause, depth++) {
    seen.add(value)
    const status = value.statusCode ?? value.status ?? value.response?.status
    if (Number.isInteger(status) && status >= 400 && status <= 599) return status
  }
}

const tasks = new Map<string, ExtractTask>()
const keyOf = (episodeId: number, target: string) => `${episodeId}:${target}`

/** 每类资产的提取指令：限定只提取该类型，并要求与已有数据去重合并 */
const EXTRACT_MESSAGES: Record<ExtractTarget, string> = {
  characters: `请从本集剧本中提取所有角色信息（外貌需融合性格、含妆造），先用 read_existing_characters 读取项目已有角色，同名或近名（带括号定位/别名，如「林小雨（主角）」与「林小雨」）直接复用已有、不要重复创建，再用 save_dedup_characters 保存。本次只提取角色，不要提取场景和道具。\n${VOICE_CARD_EXTRACTION_NOTE}read_existing_characters 中 has_voice_card 为 true 的角色已有声线卡，不要再写。\n${STYLING_COLOR_EXTRACTION_NOTE}`,
  scenes: '请从本集剧本中提取所有场景信息（地点、时间、光影等），先用 read_existing_scenes 读取已有场景去重，再用 save_dedup_scenes 保存。本次只提取场景，不要提取角色和道具。',
  props: '请从本集剧本中提取关键道具——必须同时满足：① 直接推动剧情（出现/交接/损坏/发现会引发情节转折，如凶器、信物、关键文件、定情礼物、证据）；② 值得单独生成白底单品图（分镜会给它特写或反复出现）。判定三问任一答"否"即放弃：删掉它剧情依然成立吗？它只是随手使用的日常物品（手机、筷子、水杯）吗？它是场景陈设（桌椅、灯具）吗？宁可少提不要多提，一集通常 0-3 个，超过 3 个只保留最重要的 3 个，没有就一个都不提取（save_dedup_props 传空数组）。description 只记录物品外貌。先用 read_existing_props 读取已有道具去重，再用 save_dedup_props 保存。本次只提取道具，不要提取角色和场景。',
}

/** 启动异步提取任务（立即返回）；同集同类型已在运行时返回 false；可指定文本模型覆盖 */
export function startExtraction(episodeId: number, dramaId: number, target: ExtractTarget, opts: { model?: string; configId?: number; onLifecycle?: (event: ExtractionLifecycleEvent) => void } = {}): boolean {
  const key = keyOf(episodeId, target)
  if (tasks.get(key)?.status === 'running') return false

  const task: ExtractTask = { status: 'running', started_at: new Date().toISOString() }
  tasks.set(key, task)
  const activityTaskId = currentActivity()?.taskId
  const notify = (event: Omit<ExtractionLifecycleEvent, 'startedAt' | 'activityTaskId'>) => {
    try { opts.onLifecycle?.({ ...event, startedAt: task.started_at, activityTaskId }) }
    catch { logTaskError('Extract', 'lifecycle-observer', { episodeId, target, error: '外部进度观察未完成，原提取流程继续。' }) }
  }
  notify({ phase: 'started' })

  logTaskStart('Extract', target, { episodeId, dramaId, model: opts.model || undefined, configId: opts.configId || undefined })
  ;(async () => {
    const agent = mastra.getAgent('extractor')
    if (!agent) throw new Error('提取 Agent 不可用')
    const requestContext = buildAgentRequestContext({
      episodeId,
      dramaId,
      modelOverride: opts.model || undefined,
      textConfigId: opts.configId || undefined,
    })
    return runAgentText(agent, [{ role: 'user', content: EXTRACT_MESSAGES[target] }], {
      maxSteps: 20,
      requestContext,
      // 逐步打印 Agent 进展：调用了哪些工具、输出了什么
      onStepFinish: (step: any) => {
        const tools = (step?.toolCalls || [])
          .map((t: any) => t?.toolName || t?.payload?.toolName)
          .filter(Boolean)
        logTaskProgress('Extract', `${target}-step`, {
          episodeId,
          tools: tools.length ? tools.join(',') : undefined,
          text: (step?.text || '').slice(0, 200) || undefined,
        })
        notify({ phase: 'step', step })
      },
    })
  })()
    // 角色提取写入声线卡后，统一同一人的不同年龄版本（只改自动生成的卡）；失败不影响提取结果。
    .then(async (result: any) => {
      if (target === 'characters') await alignVoiceCardVariants(dramaId).catch((err: any) => logTaskError('VoiceCard', 'align-variants', { dramaId, error: err?.message }))
      return result
    })
    .then((result: any) => {
      task.status = 'done'
      task.finished_at = new Date().toISOString()
      const toolNames = (result?.toolCalls || []).map((t: any) => t?.toolName).filter(Boolean)
      logTaskSuccess('Extract', target, {
        episodeId,
        steps: result?.steps?.length,
        toolCalls: toolNames.join(',') || undefined,
        reply: (result?.text || '').slice(0, 300) || undefined,
      })
      notify({ phase: 'done', finishedAt: task.finished_at, result })
    })
    .catch((err: any) => {
      task.status = 'error'
      task.finished_at = new Date().toISOString()
      task.error = err?.message || '提取失败'
      logTaskError('Extract', target, { episodeId, error: err?.message })
      notify({ phase: 'error', finishedAt: task.finished_at, error: task.error, providerHttpStatus: extractionHttpStatus(err) })
    })
  return true
}

/** 查询某集三类资产的提取任务状态（未启动过的类型为 null） */
export function getExtractionStatus(episodeId: number): Record<ExtractTarget, ExtractTask | null> {
  const result = {} as Record<ExtractTarget, ExtractTask | null>
  for (const target of EXTRACT_TARGETS) result[target] = tasks.get(keyOf(episodeId, target)) || null
  return result
}

/**
 * 为本集已有、但还没有声线卡的角色补写声线卡（不改外貌、妆造等其他字段；已有卡的角色不动）。
 * 同步执行，返回本次新写的数量。
 */
export async function fillMissingVoiceCards(episodeId: number, dramaId: number, opts: { model?: string; configId?: number } = {}) {
  const agent = mastra.getAgent('extractor')
  if (!agent) throw new Error('提取 Agent 不可用')
  const requestContext = buildAgentRequestContext({ episodeId, dramaId, modelOverride: opts.model || undefined, textConfigId: opts.configId || undefined })
  logTaskStart('Extract', 'voice-cards', { episodeId, dramaId })
  const result = await runAgentText(agent, [{ role: 'user', content: `只为本集角色补写声线卡：先用 read_script_for_extraction 读取剧本，再用 read_existing_characters 读取项目角色；只处理 current_episode_characters 中 has_voice_card 为 false 且在本集有台词或画外声音的角色，用 save_voice_cards 保存（character_id 用 read_existing_characters 返回的 id）。不要调用 save_dedup_characters，不要新增、改名或修改任何角色的其他信息，不要提取场景和道具。\n${VOICE_CARD_EXTRACTION_NOTE}` }], { maxSteps: 8, requestContext })
  const written = (result?.toolResults || result?.steps?.flatMap((step: any) => step?.toolResults || []) || [])
    .map((entry: any) => entry?.result ?? entry?.payload?.result).filter((value: any) => value && typeof value.voice_cards === 'number')
    .reduce((sum: number, value: any) => sum + value.voice_cards, 0)
  await alignVoiceCardVariants(dramaId)
  logTaskSuccess('Extract', 'voice-cards', { episodeId, written })
  return written
}
