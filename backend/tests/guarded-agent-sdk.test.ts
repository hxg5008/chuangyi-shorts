import { assertSdkTestIsolation } from './helpers/isolate-agent-sdk.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import { runAgentText } from '../src/services/agent-text-stream.ts'
import { runGuardedAgent } from '../src/services/guarded-agent.ts'

await assertSdkTestIsolation()

const issue = { field: 'video_prompt', code: 'test_content_error', message: 'correct this candidate', severity: 'error' }
function response(toolName: string, args: unknown, id: number) {
  const data = [{ id: `offline-${id}`, object: 'chat.completion.chunk', created: 0, model: 'offline', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call-${id}`, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }, { id: `offline-${id}`, object: 'chat.completion.chunk', created: 0, model: 'offline', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]
  return new Response(data.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
}
function session() {
  let stopped = false, ready = false, issues: any[] = []
  return {
    beginAttempt() { stopped = false }, shouldStopAttempt: () => stopped, readyToCommit: () => ready,
    getIssues: () => issues, getReport: () => ({ candidates: [], issues }),
    finish: async () => ({ saved: ready ? 1 : 0, issues }), cancel() {}, recordToolInputError() { stopped = true },
    bad() { issues = [issue]; stopped = true; return { error: 'correct candidate', issues } },
    good() { issues = []; ready = true; return { staged: true } },
  }
}

test('real Mastra stops after the first invalid step, then permits repair to read old issues before fixing them', async () => {
  const current = session(); let requests = 0, bad = 0, good = 0, reads = 0
  const provider = createOpenAI({ apiKey: 'offline-only', baseURL: 'https://example.invalid/v1', fetch: async () => {
    requests++
    if (requests === 1) return response('update_storyboard', { action: 'bad' }, requests)
    if (requests === 2) return response('read_context', {}, requests)
    if (requests === 3) return response('update_storyboard', { action: 'good' }, requests)
    throw new Error('Unexpected extra model request')
  } })
  const agent = new Agent({ id: 'guarded-native-test', name: 'Guarded native test', instructions: 'Use local test tools only.', model: provider.chat('offline'), tools: {
    update_storyboard: createTool({ id: 'update_storyboard', inputSchema: z.object({ action: z.enum(['bad', 'good']) }), execute: async ({ action }) => action === 'bad' ? (bad++, current.bad()) : (good++, current.good()) }),
    read_context: createTool({ id: 'read_context', inputSchema: z.object({}), execute: async () => { reads++; return current.getReport() } }),
  } })
  const result = await runGuardedAgent({ agentType: 'prompt_generator', message: 'offline native loop test', session: current as any, requestContext: new Map(), generate: (messages, options) => {
    assert.equal(Object.hasOwn(options, 'maxSteps'), false, 'Mastra must not override custom stopWhen')
    return runAgentText(agent, messages, options)
  } })
  assert.equal(result.status, 'done'); assert.equal(result.attempt, 1)
  assert.equal(requests, 3); assert.equal(bad, 1); assert.equal(good, 1); assert.equal(reads, 1)
})

test('a fully valid native tool result ends generation immediately without a confirmation model request', async () => {
  const current = session(); let requests = 0
  const provider = createOpenAI({ apiKey: 'offline-only', baseURL: 'https://example.invalid/v1', fetch: async () => { requests++; return response('update_storyboard', {}, requests) } })
  const agent = new Agent({ id: 'guarded-native-ready', name: 'Guarded native ready', instructions: 'Use the local tool.', model: provider.chat('offline'), tools: {
    update_storyboard: createTool({ id: 'update_storyboard', inputSchema: z.object({}), execute: async () => current.good() }),
  } })
  const result = await runGuardedAgent({ agentType: 'prompt_generator', message: 'offline first pass', session: current as any, requestContext: new Map(), generate: (messages, options) => runAgentText(agent, messages, options) })
  assert.equal(result.status, 'done'); assert.equal(result.attempt, 0); assert.equal(requests, 1)
})

test('native mandatory-schema rejection stops that attempt before execute or another model POST, then one valid repair can save', async () => {
  const current = session(); let requests = 0, executed = 0, recorded = 0, attempt = -1
  const perAttempt = [0, 0]
  current.recordToolInputError = () => { recorded++; current.bad() }
  const provider = createOpenAI({ apiKey: 'offline-only', baseURL: 'https://example.invalid/v1', fetch: async () => {
    requests++; perAttempt[attempt]++
    if (requests === 1) return response('update_storyboard', {}, requests)
    if (requests === 2) return response('update_storyboard', { action: 'good' }, requests)
    throw new Error('Schema rejection must not cause an extra model request')
  } })
  const agent = new Agent({ id: 'guarded-native-schema-repair', name: 'Guarded schema repair', instructions: 'Use the local mock tool.',
    model: provider.chat('offline'), maxRetries: 0, tools: {
      update_storyboard: createTool({ id: 'update_storyboard', inputSchema: z.object({ action: z.literal('good') }), execute: async () => { executed++; return current.good() } }),
    } })
  const result = await runGuardedAgent({ agentType: 'prompt_generator', message: 'offline schema fixture', session: current as any, requestContext: new Map(),
    onState: (_phase, value) => { attempt = value }, generate: (messages, options) => runAgentText(agent, messages, options),
  })
  assert.equal(result.status, 'done'); assert.equal(result.attempt, 1)
  assert.deepEqual(perAttempt, [1, 1]); assert.equal(requests, 2); assert.equal(executed, 1); assert.equal(recorded, 1)
})

test('native mandatory-schema rejection in both allowed attempts sends exactly two POSTs and never executes or silently asks a third time', async () => {
  const current = session(); let requests = 0, executed = 0, recorded = 0, attempt = -1
  const perAttempt = [0, 0]
  current.recordToolInputError = () => { recorded++; current.bad() }
  const provider = createOpenAI({ apiKey: 'offline-only', baseURL: 'https://example.invalid/v1', fetch: async () => {
    requests++; perAttempt[attempt]++
    if (requests > 2) throw new Error('A third schema-repair POST is forbidden')
    return response('update_storyboard', {}, requests)
  } })
  const agent = new Agent({ id: 'guarded-native-schema-twice', name: 'Guarded schema twice', instructions: 'Use the local mock tool.',
    model: provider.chat('offline'), maxRetries: 0, tools: {
      update_storyboard: createTool({ id: 'update_storyboard', inputSchema: z.object({ action: z.literal('good') }), execute: async () => { executed++; return current.good() } }),
    } })
  const result = await runGuardedAgent({ agentType: 'prompt_generator', message: 'offline invalid schema fixture', session: current as any, requestContext: new Map(),
    onState: (_phase, value) => { attempt = value }, generate: (messages, options) => runAgentText(agent, messages, options),
  })
  assert.equal(result.status, 'needs_revision'); assert.equal(result.attempt, 1)
  assert.deepEqual(perAttempt, [1, 1]); assert.equal(requests, 2); assert.equal(executed, 0); assert.equal(recorded, 2)
})
