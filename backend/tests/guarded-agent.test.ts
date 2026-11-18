import test from 'node:test'
import assert from 'node:assert/strict'
import { runGuardedAgent } from '../src/services/guarded-agent.ts'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

const issue = { code: 'missing_coordinates', message: '缺少空间基准', severity: 'error' as const }
function harness(results: any[]) {
  let finishes = 0, cancelled = false
  const states: string[] = [], messages: string[] = []
  const session: any = {
    getReport: () => ({ candidates: [{ storyboardId: -1 }], issues: [issue] }),
    getIssues: () => [],
    finish: async () => results[Math.min(finishes++, results.length - 1)],
    cancel: () => { cancelled = true },
  }
  const options = { agentType: 'storyboard_breaker' as const, message: '拆分', session, requestContext: new Map(), onState: (phase: string, attempt: number) => states.push(`${phase}:${attempt}`), generate: async (input: any) => { messages.push(input[0].content); return {} } }
  return { options, states, messages, cancelled: () => cancelled }
}

test('valid first result commits once without an extra model pass', async () => {
  const h = harness([{ saved: 2, issues: [] }])
  const result = await runGuardedAgent(h.options)
  assert.equal(result.status, 'done'); assert.equal(h.messages.length, 1)
  assert.ok(h.messages[0].includes('is_final_batch:true')); assert.ok(h.cancelled())
})

test('only one directed repair pass is allowed; remaining issues are not success', async () => {
  const h = harness([{ saved: 0, issues: [issue] }])
  const result = await runGuardedAgent(h.options)
  assert.equal(result.status, 'needs_revision'); assert.equal(h.messages.length, 2)
  assert.ok(h.messages[1].includes('missing_coordinates'))
  assert.ok(h.states.includes('repairing:1')); assert.equal(result.saved, 0)
})

test('a corrected candidate passes revalidation and returns warnings', async () => {
  const warning = { ...issue, severity: 'warning' }
  const h = harness([{ saved: 0, issues: [issue] }, { saved: 1, issues: [warning] }])
  const result = await runGuardedAgent(h.options)
  assert.equal(result.status, 'done'); assert.equal(result.attempt, 1); assert.equal(result.issues.length, 1)
})

test('empty/no-write output cannot count as completion', async () => {
  const h = harness([{ saved: 0, issues: [] }])
  const result = await runGuardedAgent(h.options)
  assert.equal(result.status, 'needs_revision'); assert.equal(h.messages.length, 2)
})

test('transport failure does not automatically resubmit and closes staging', async () => {
  const h = harness([{ saved: 1, issues: [] }]); let calls = 0
  h.options.generate = async () => { calls++; throw new Error('upstream disconnected') }
  await assert.rejects(runGuardedAgent(h.options), /disconnected/)
  assert.equal(calls, 1); assert.ok(h.cancelled())
})

test('database conflicts and commit failures do not spend a model repair pass', async () => {
  for (const code of ['concurrent_edit', 'commit_failed', 'aborted']) {
    const h = harness([{ saved: 0, issues: [{ ...issue, code }] }])
    const result = await runGuardedAgent(h.options)
    assert.equal(result.status, 'needs_revision'); assert.equal(h.messages.length, 1)
  }
})

test('the model tool loop stops immediately at a rejected candidate and also has a step ceiling', async () => {
  const h = harness([{ saved: 1, issues: [] }])
  h.options.generate = async (_messages: any, options?: any) => {
    assert.equal(options.stopWhen({ steps: [] }), false)
    assert.equal(options.stopWhen({ steps: Array(20) }), true)
    h.options.session.getIssues = () => [issue]
    assert.equal(options.stopWhen({ steps: [{}] }), true)
    return {}
  }
  await runGuardedAgent(h.options)
})

test('SDK input errors that occur before tool execution are recorded and stop the loop before a single directed repair', async () => {
  const h = harness([{ saved: 1, issues: [] }])
  let calls = 0, executed = 0
  let issues: any[] = []
  let rejected: any
  const tool = createTool({ id: 'update_storyboard', inputSchema: z.object({ video_prompt_plan: z.object({ space: z.string() }) }), execute: async () => { executed++; return {} } })
  h.options.session.getIssues = () => issues
  h.options.session.finish = async () => ({ saved: issues.length ? 0 : 1, issues })
  h.options.session.recordToolInputError = (name: string, message: string, input: any) => { rejected = { name, message, input }; issues = [{ ...issue, code: 'tool_input' }] }
  h.options.session.getReport = () => ({ issues, rejectedToolInput: rejected })
  h.options.generate = async (messages: any, options?: any) => {
    calls++
    if (calls === 1) {
      const input = { video_prompt_plan: {} }
      const result = await (tool.execute as any)(input)
      assert.equal(executed, 0)
      const step = { toolCalls: [{ toolName: 'update_storyboard', toolCallId: 'bad-plan', input }], toolResults: [{ toolName: 'update_storyboard', toolCallId: 'bad-plan', output: result }] }
      options.onStepFinish(step)
      assert.equal(options.stopWhen({ steps: [step] }), true)
      assert.equal(rejected.name, 'update_storyboard')
      assert.deepEqual(rejected.input, input)
    } else {
      assert.ok(messages[0].content.includes('rejectedToolInput'))
      issues = []
    }
    return {}
  }
  const result = await runGuardedAgent(h.options)
  assert.equal(result.status, 'done'); assert.equal(calls, 2)
})

test('deadline releases a stalled transport and closes staging before late responses', async () => {
  const h = harness([{ saved: 1, issues: [] }]); let calls = 0
  h.options.generate = async () => { calls++; return new Promise(resolve => setTimeout(() => resolve({}), 80)) }
  await assert.rejects(runGuardedAgent({ ...h.options, timeoutMs: 10 }), /超时/)
  assert.equal(calls, 1); assert.ok(h.cancelled())
})
