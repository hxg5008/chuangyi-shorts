import type { StoryboardSession } from './storyboard-session.js'

export type GuardedPhase = 'generating' | 'validating' | 'repairing'
export interface GuardedRunOptions {
  agentType: 'storyboard_breaker' | 'prompt_generator'
  message: string
  session: StoryboardSession
  requestContext: any
  generate: (messages: any[], options: any) => Promise<any>
  signal?: AbortSignal
  onState?: (phase: GuardedPhase, attempt: number) => void
  timeoutMs?: number
}

// A generation may call tools several times, but only one additional repair pass is allowed.
// Transport failures never trigger a fresh model request automatically.
export async function runGuardedAgent(options: GuardedRunOptions) {
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const timeout = setTimeout(() => controller.abort(new Error('本次提示词处理超时，旧稿已保留，请检查任务详情后重试')), options.timeoutMs ?? 10 * 60_000)
  timeout.unref?.()
  options.requestContext.set('storyboardSession', options.session)
  const original = `${options.message}\n\n按系统中的首轮生成方式先规划逐镜适用人物和台词容量，再用 video_prompt_plan 一次写完整。全部结果先暂存，合格后统一提交；旧稿在此之前保持不变。${options.agentType === 'storyboard_breaker' ? '首批 replace_existing:true，末批 is_final_batch:true。' : '只处理指定分镜，实际仅保存 video_prompt。'}`
  let lastResult: any
  const observedToolErrors = new Set<string>()
  function captureToolErrors(step: any) {
    for (const entry of step?.toolResults || []) {
      const payload = entry?.payload || entry
      const tool = payload?.toolName || entry?.toolName || ''
      if (!['savestoryboards', 'updatestoryboard'].includes(String(tool).replace(/_/g, '').toLowerCase())) continue
      let result = payload?.result ?? payload?.output ?? entry?.result ?? entry?.output
      // stopWhen receives AI SDK content envelopes; onStepFinish receives Mastra
      // payload.result. Unwrap both here, before the next model request is chosen.
      for (let depth = 0; depth < 2 && result && typeof result === 'object'
        && ['json', 'text'].includes(result.type) && Object.hasOwn(result, 'value'); depth++) result = result.value
      if (typeof result === 'string') { try { result = JSON.parse(result) } catch { /* plain error text */ } }
      const failed = payload?.isError || entry?.isError || result?.error || result?.name === 'ValidationError'
      if (!failed) continue
      // Candidate errors are already recorded by stageSave/stageUpdate.
      if (Array.isArray(result?.issues) && (typeof options.session.shouldStopAttempt === 'function'
        ? options.session.shouldStopAttempt() : options.session.getIssues().some(issue => issue.severity === 'error'))) continue
      const callId = payload?.toolCallId || entry?.toolCallId
      const call = (step?.toolCalls || []).find((item: any) => callId
        ? (item?.payload?.toolCallId || item?.toolCallId) === callId
        : (item?.payload?.toolName || item?.toolName) === tool)
      const input = payload?.args ?? payload?.input ?? call?.payload?.args ?? call?.payload?.input ?? call?.args ?? call?.input
      const rawMessage = typeof result?.error === 'string' ? result.error : result?.message || (typeof result === 'string' ? result : JSON.stringify(result)) || '保存工具参数未通过结构校验'
      // SDK validation errors append a dump of the attempted tool arguments.
      // Keep field errors; do not repeat the whole screenplay/plan in repair text.
      const message = String(rawMessage).split(/\n\s*Provided arguments:/i)[0].trim()
      const identity = callId || `${tool}:${message}:${JSON.stringify(input)}`
      if (observedToolErrors.has(identity)) continue
      observedToolErrors.add(identity)
      options.session.recordToolInputError(tool, String(message), input)
    }
  }
  try {
    for (let attempt = 0; attempt <= 1; attempt++) {
      observedToolErrors.clear()
      signal.throwIfAborted()
      options.session.beginAttempt?.(attempt)
      options.onState?.(attempt ? 'repairing' : 'generating', attempt)
      const report = attempt ? (options.session.getRepairReport?.() || options.session.getReport()) : null
      const message = attempt
        ? `这是本任务唯一一次定向修正。原任务：${original}\n当前问题：${JSON.stringify(report?.issues)}\n请先 read_storyboard_context 读取暂存稿与原词容量表；若上次工具输入被拒绝，参考 rejectedToolInput：${JSON.stringify(report?.rejectedToolInput)}。只修正列出的分镜和问题；已有正确分镜保留。不要重新清空整集，不改写台词或用提速掩盖时长冲突。新分镜的负数 id 是本次暂存 id，可用 update_storyboard 修正。多组待修时可以连续修完，本次写入已合格不会因其他组的旧错误锁死。整组台词装不下15秒时，应重分组：用save_storyboards按相同shot_number覆盖该组及受影响后续组并追加新组，保持编号连续；保留此前正确组，后续省略replace_existing。尚未生成的后半集也必须继续补齐，最后声明is_final_batch:true，不能只修首批就结束。无法消解的问题简短报告，不冒充通过。`
        : original
      // Race the call as well as forwarding the signal: a stalled transport must release the job.
      let onAbort: (() => void) | undefined
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason ?? new Error('任务已中止'))
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })
      try {
        const maxSteps = options.agentType === 'storyboard_breaker' ? 20 : 8
        lastResult = await Promise.race([
          options.generate([{ role: 'user', content: message }], {
            // Mastra 1.17 replaces custom stopWhen when maxSteps is also supplied.
            // Keep both the step ceiling and rejection condition in this one callback.
            // Stop the tool loop at its first rejected candidate. Otherwise the model
            // could repeatedly repair within one generate() call before our retry cap.
            stopWhen: ({ steps }: { steps: unknown[] }) => {
              captureToolErrors(steps.at(-1))
              const rejected = typeof options.session.shouldStopAttempt === 'function'
                ? options.session.shouldStopAttempt() : options.session.getIssues().some(issue => issue.severity === 'error')
              return steps.length >= maxSteps || rejected || options.session.readyToCommit?.() === true
            },
            onStepFinish: captureToolErrors,
            requestContext: options.requestContext,
            abortSignal: signal,
          }),
          aborted,
        ])
      } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort)
      }
      signal.throwIfAborted()
      options.onState?.('validating', attempt)
      const result = await options.session.finish()
      if (!result.issues.some(issue => issue.severity === 'error') && result.saved > 0) {
        return { status: 'done' as const, saved: result.saved, issues: result.issues, result: lastResult, attempt }
      }
      const nonRepairable = new Set(['concurrent_edit', 'commit_failed', 'aborted', 'session_closed', 'session_scope'])
      if (result.issues.some(issue => issue.severity === 'error' && nonRepairable.has(issue.code))) {
        return { status: 'needs_revision' as const, saved: 0, issues: result.issues, result: lastResult, attempt }
      }
      // Empty/unchanged output is a failure too; the session reports it rather than accepting old text.
      if (attempt === 1) return { status: 'needs_revision' as const, saved: 0, issues: result.issues, result: lastResult, attempt }
    }
    throw new Error('提示词处理没有产生有效结果')
  } finally {
    clearTimeout(timeout)
    options.session.cancel('本次处理已结束')
    // Also blocks tools from a late response after the race has ended.
    controller.abort(new Error('本次处理已结束'))
  }
}
