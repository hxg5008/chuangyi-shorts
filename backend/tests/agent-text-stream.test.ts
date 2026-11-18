import { assertSdkTestIsolation } from './helpers/isolate-agent-sdk.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import { runAgentText } from '../src/services/agent-text-stream.ts'

await assertSdkTestIsolation()

function streamResponse(chunks: any[]) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
}
const chunk = (delta: any, finish: string | null = null) => ({ id: 'offline-chunk', object: 'chat.completion.chunk', created: 0, model: 'offline', choices: [{ index: 0, delta, finish_reason: finish }] })
function agent(fetcher: typeof fetch, tools?: any) {
  const provider = createOpenAI({ apiKey: 'offline-only', baseURL: 'https://example.invalid/v1', fetch: fetcher })
  return new Agent({ id: 'text-stream-offline', name: 'Text streaming test', instructions: 'Use the local test tool if available, then say OK.', model: provider.chat('offline'), tools })
}

test('real SDK sends stream:true and full output is consumed before returning text', async () => {
  let calls = 0
  const runner = agent(async (_input, init) => {
    calls++
    const body = JSON.parse(String(init?.body))
    assert.equal(body.stream, true)
    return streamResponse([chunk({ role: 'assistant', content: 'O' }), chunk({ content: 'K' }), chunk({}, 'stop')])
  })
  const result = await runAgentText(runner, [{ role: 'user', content: 'local test' }])
  assert.equal(result.text, 'OK'); assert.equal(calls, 1)
})

test('short fixed groups explicitly request one complete native tool result without streaming or fallback', async () => {
  let calls = 0, executed = 0
  const tools = { submit: createTool({ id: 'submit', inputSchema: z.object({ value: z.string() }), execute: async () => { executed++; return { staged: true } } }) }
  const runner = agent(async (_input, init) => {
    calls++
    const body = JSON.parse(String(init?.body))
    assert.notEqual(body.stream, true)
    assert.equal(Object.hasOwn(body, 'textMode'), false)
    return Response.json({ id: 'offline-complete', object: 'chat.completion', created: 0, model: 'offline', choices: [{ index: 0,
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'complete-tool', type: 'function', function: { name: 'submit', arguments: JSON.stringify({ value: 'complete fields' }) } }] },
      finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 } })
  }, tools)
  await runAgentText(runner, [{ role: 'user', content: 'fixed short group' }], { textMode: 'complete', stopWhen: ({ steps }: any) => steps.length >= 1 })
  assert.equal(calls, 1)
  assert.equal(executed, 1)
})

test('explicit complete mode strips its internal selector and never retries a failed complete request as a stream', async () => {
  let complete = 0, streamed = 0
  const runner = { generate: async (_messages: any, options: any) => {
    complete++; assert.equal(options.textMode, undefined); assert.equal(options.maxRetries, 0)
    throw new Error('complete request failed')
  }, stream: async () => { streamed++; return {} } }
  await assert.rejects(runAgentText(runner, [], { textMode: 'complete' }), /complete request failed/)
  assert.equal(complete, 1); assert.equal(streamed, 0)
})

test('real streamed tool arguments execute once and the next streamed step completes normally', async () => {
  let calls = 0, executed = 0
  const tools = { read_context: createTool({ id: 'read_context', inputSchema: z.object({}), execute: async () => { executed++; return { ready: true } } }) }
  const runner = agent(async (_input, init) => {
    calls++
    assert.equal(JSON.parse(String(init?.body)).stream, true)
    return calls === 1
      ? streamResponse([chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'local-tool', type: 'function', function: { name: 'read_context', arguments: '{}' } }] }), chunk({}, 'tool_calls')])
      : streamResponse([chunk({ role: 'assistant', content: 'OK' }), chunk({}, 'stop')])
  }, tools)
  const result = await runAgentText(runner, [{ role: 'user', content: 'local tool test' }], { maxSteps: 3 })
  assert.equal(result.text, 'OK'); assert.equal(executed, 1); assert.equal(calls, 2)
})

test('HTTP gateway failures retained in stream full output are thrown without JSON fallback or retry', async () => {
  let calls = 0
  const runner = agent(async () => { calls++; return new Response('Gateway Timeout', { status: 504, statusText: 'Gateway Timeout', headers: { 'Content-Type': 'text/html' } }) })
  await assert.rejects(runAgentText(runner, [{ role: 'user', content: 'local failure test' }]), (error: any) => error.statusCode === 504 || /Gateway Timeout/.test(error.message))
  assert.equal(calls, 1)
})

test('SSE error events do not become a successful empty output or cause a second request', async () => {
  let calls = 0
  const runner = agent(async () => { calls++; return streamResponse([{ error: { message: 'offline upstream halted', type: 'server_error', code: 'upstream_error' } }]) })
  await assert.rejects(runAgentText(runner, [{ role: 'user', content: 'local event failure test' }]))
  assert.equal(calls, 1)
})

test('abort prevents late completion, and a failed stream never calls the compatibility generate method', async () => {
  let calls = 0, fallback = 0
  const controller = new AbortController()
  const runner = { stream: async () => { calls++; return { getFullOutput: async () => { controller.abort(new Error('cancelled')); return { text: 'late' } } } }, generate: async () => { fallback++; return {} } }
  await assert.rejects(runAgentText(runner, [], { abortSignal: controller.signal }), /cancelled/)
  assert.equal(calls, 1); assert.equal(fallback, 0)
})

test('plain structured full-output failures retain status metadata in their cause', async () => {
  const failure = { message: 'Gateway Timeout', statusCode: 504 }
  const runner = { stream: async () => ({ getFullOutput: async () => ({ error: failure }) }) }
  await assert.rejects(runAgentText(runner, []), (error: any) => error.cause === failure && error.cause.statusCode === 504)
})
