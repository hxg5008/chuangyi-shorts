/** Consume the selected provider response inside the server; the UI polls its durable job. */
import { observeAgentOperation, currentActivity } from './activity/context.js'
import { activityEvent } from './activity/store.js'
import { sanitizeActivity } from './activity/sanitize.js'
export async function runAgentText(agent: any, messages: any[], options: any = {}): Promise<any> {
  return observeAgentOperation(agent, messages, options, () => runAgentTextObserved(agent, messages, options))
}
async function runAgentTextObserved(agent: any, messages: any[], options: any = {}): Promise<any> {
  options.abortSignal?.throwIfAborted()
  const { textMode, ...settings } = options
  const runOptions = { ...settings, maxRetries: 0, onStepFinish: (step: any) => {
    const taskId = currentActivity()?.taskId
    if (taskId) { try { activityEvent(taskId, 'tool_step', '本轮业务工具与结果已返回。', sanitizeActivity({ toolCalls: step?.toolCalls, toolResults: step?.toolResults, finishReason: step?.finishReason })) } catch {} }
    return options.onStepFinish?.(step)
  } }
  let result: any
  if (textMode === 'complete') {
    if (typeof agent.generate !== 'function') throw new Error('文本模型不支持完整结果请求，旧稿未提交')
    // Fixed, short storyboard groups need one complete tool-arguments object.
    // This is an explicit transport choice, never a retry of a failed stream.
    result = await agent.generate(messages, runOptions)
  } else if (typeof agent.stream === 'function') {
    const output = await agent.stream(messages, runOptions)
    if (!output || typeof output.getFullOutput !== 'function') throw new Error('文本模型流未提供完整结果，旧稿未提交')
    result = await output.getFullOutput()
  } else {
    // Compatibility with legacy/local test agents; never retry a failed stream as JSON.
    result = await agent.generate(messages, runOptions)
  }
  options.abortSignal?.throwIfAborted()
  // Mastra.stream returns errors in FullOutput instead of always rejecting.
  if (result?.error) throw result.error instanceof Error ? result.error : new Error(typeof result.error === 'string' ? result.error : result.error.message || '文本模型流异常结束', { cause: result.error })
  if (result?.finishReason === 'error') throw new Error('文本模型流异常结束，未收到完整结果')
  return result
}
