import { currentActivity } from './context.js'
import { activityEvent, startActivityRound, endActivityRound, appendActivityRoundText, setActivityRoundTools } from './store.js'
import { sanitizeActivity } from './sanitize.js'
import { registerRuntimeSecrets } from '../../utils/secret-redaction.js'
import { withRequestLogContext } from '../request-logs/context.js'

/** The provider receives the identical options. Only public stream parts are observed. */
export function observeLanguageModel<T extends object>(model: T, metadata: { model?: string; provider?: string; configId?: number; channelId?: number; channelName?: string }, secrets: string[] = []): T {
  registerRuntimeSecrets(secrets)
  const safely = (fn: () => void) => { try { fn() } catch {} }
  const inputCopy = (options: any) => sanitizeActivity({ prompt: options.prompt, tools: options.tools, toolChoice: options.toolChoice,
    responseFormat: options.responseFormat, maxOutputTokens: options.maxOutputTokens, providerOptions: options.providerOptions }, secrets, Number.MAX_SAFE_INTEGER)
  return new Proxy(model, { get(target: any, key) {
    const original = Reflect.get(target, key, target)
    if (key !== 'doGenerate' && key !== 'doStream') return typeof original === 'function' ? original.bind(target) : original
    if (typeof original !== 'function') return original
    return async (options: any) => {
      const taskId = currentActivity()?.taskId
      let roundId: string | undefined
      if (taskId) safely(() => { roundId = startActivityRound(taskId, { ...metadata, ...(currentActivity()?.assetPreparationJobId ? { stage: 'preparing_prompt' } : {}) }, inputCopy(options)) })
      if (!taskId || !roundId) return withRequestLogContext({kind:'text',model:metadata.model,configId:metadata.configId,channelId:metadata.channelId,channelName:metadata.channelName||metadata.provider},()=>original.call(target, options))
      const finish = (output: any, usage?: any, error?: string) => safely(() => endActivityRound(roundId!, taskId, sanitizeActivity(output, secrets, Number.MAX_SAFE_INTEGER), usage, error ? sanitizeActivity(error, secrets) : undefined))
      try {
        const result = await withRequestLogContext({taskId,roundId,kind:'text',model:metadata.model,configId:metadata.configId,channelId:metadata.channelId,channelName:metadata.channelName||metadata.provider},()=>original.call(target, options))
        if (key === 'doGenerate') {
          const content = Array.isArray(result.content) ? result.content : []
          safely(() => appendActivityRoundText(roundId!, content.filter((part: any) => part.type === 'text').map((part: any) => part.text || '').join('')))
          safely(() => setActivityRoundTools(roundId!, content.filter((part: any) => part.type === 'tool-call').map((part: any) => ({ id: part.toolCallId, name: part.toolName, arguments: part.input ?? part.args }))))
          finish({ content: result.content, finishReason: result.finishReason }, result.usage,
            result.finishReason?.unified === 'error' || result.finishReason === 'error' ? '模型返回失败终态。' : undefined)
          return result
        }
        if (!result?.stream?.pipeThrough) { finish(null, null, '模型未提供可观察流。'); return result }
        let text = '', usage: any, failed: string | undefined, finished = false, buffered = '', lastFlush = 0, toolsChanged = false
        let flushTimer: ReturnType<typeof setTimeout> | undefined
        const calls = new Map<string, any>()
        const flush = () => {
          if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined }
          if (toolsChanged) { toolsChanged = false; safely(() => setActivityRoundTools(roundId!, [...calls.values()])) }
          if (!buffered) return
          const delta = buffered; buffered = ''; lastFlush = Date.now()
          safely(() => { const clean = sanitizeActivity(delta, secrets, Number.MAX_SAFE_INTEGER); appendActivityRoundText(roundId!, clean); activityEvent(taskId, 'public_delta', '收到模型公开输出。', { text: clean }, roundId) })
        }
        const scheduleFlush = () => { if (!flushTimer) { flushTimer = setTimeout(flush, 250); flushTimer.unref?.() } }
        const end = () => { if (finished) return; finished = true; flush(); finish({ text, tool_calls: [...calls.values()] }, usage, failed) }
        const reader = result.stream.getReader()
        const observeChunk = (chunk: any) => {
            if (chunk.type === 'text-delta') {
              const delta = String(chunk.delta ?? chunk.textDelta ?? '')
              text += delta
              buffered += delta
              if (buffered.length >= 160 || Date.now() - lastFlush >= 250) flush()
              else scheduleFlush()
            } else if (chunk.type === 'tool-input-start') { calls.set(chunk.id, { id: chunk.id, name: chunk.toolName, arguments: '' }); safely(() => { setActivityRoundTools(roundId!, [...calls.values()]); activityEvent(taskId, 'tool_input_start', '模型开始填写业务工具参数。', { id: chunk.id, name: chunk.toolName }, roundId) }) }
            else if (chunk.type === 'tool-input-delta') { const call = calls.get(chunk.id); if (call) { call.arguments += String(chunk.delta ?? chunk.inputTextDelta ?? ''); toolsChanged = true; scheduleFlush() } }
            else if (chunk.type === 'tool-call') {
              const id = chunk.toolCallId || chunk.id, call = { id, name: chunk.toolName, arguments: chunk.input ?? chunk.args }
              calls.set(id, call); safely(() => { setActivityRoundTools(roundId!, [...calls.values()]); activityEvent(taskId, 'tool_call', '模型提出业务工具调用。', sanitizeActivity(call, secrets, Number.MAX_SAFE_INTEGER), roundId) })
            } else if (chunk.type === 'finish') { usage = chunk.usage; if (chunk.finishReason?.unified === 'error' || chunk.finishReason === 'error') failed = '模型返回失败终态。' }
            else if (chunk.type === 'error') { failed = String(chunk.error?.message || chunk.error || '模型流异常'); end() }
        }
        const stream = new ReadableStream({
          async pull(controller) {
            try {
              const next = await reader.read()
              if (next.done) { end(); controller.close(); return }
              observeChunk(next.value)
              controller.enqueue(next.value)
            } catch (error: any) { failed = String(error?.message || error); end(); controller.error(error) }
          },
          async cancel(reason) { failed = '模型流观察已结束。'; end(); await reader.cancel(reason) },
        })
        return { ...result, stream }
      } catch (error: any) { finish(null, null, String(error?.message || error)); throw error }
    }
  } })
}
