import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import { videoPromptPlanSchema, type VideoPromptPlan } from '../src/services/video-prompt-plan.ts'

function nullablePlan(): any {
  return {
    space: 'A0 is the threshold; X points east and Y points north.',
    shots: [
      { shot_number: 1, characters: [{ character_id: 1, visibility: 'face_hidden', emotion: null }],
        rows: [{ visual: '@A is seen from behind.', dialogue: null }] },
      { shot_number: 2, characters: [{ character_id: 1, visibility: 'face_hidden', emotion: null }], rows: [
        { visual: '@A lowers the left hand.', dialogue: [{ speaker_id: null, kind: 'narration', text: 'A quiet morning.',
          voice: { age: 'adult', register: 'low', timbre: 'warm', delivery: null }, voice_reference: null, spoken_seconds: null }] },
        { visual: '@A waits near the door.', dialogue: null },
      ] },
    ],
  }
}

function streamResponse(args: unknown, number: number) {
  const base = { id: `offline-wire-${number}`, object: 'chat.completion.chunk', created: 0, model: 'offline' }
  const chunks = number === 1 ? [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-local-plan', type: 'function',
      function: { name: 'save_storyboards', arguments: JSON.stringify({ video_prompt_plan: args }) } }] }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ] : [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] }]
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  })
}

/** Both shapes are emitted by the installed native SDK at different loop stages. */
function resultOf(entry: any, unwrapSdkValue: boolean): any {
  const payload = entry?.payload || entry
  let result = payload?.result ?? payload?.output ?? entry?.result ?? entry?.output
  if (unwrapSdkValue && result && ['json', 'text'].includes(result.type) && Object.hasOwn(result, 'value')) result = result.value
  if (typeof result === 'string') { try { return JSON.parse(result) } catch { return result } }
  return result
}

let sequence = 0
async function nativeWire(args: unknown, stopMode: 'first-step' | 'late-callback' | 'unwrap-stop' = 'first-step') {
  const originalFetch = globalThis.fetch
  const originalNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'test'
  // The provider uses its explicit mock. Any unexpected fallback transport is forbidden.
  globalThis.fetch = async () => { throw new Error('Unexpected external fetch blocked in wire test') }
  const parsedPlans: VideoPromptPlan[] = []
  const events: Array<{ event: string; errors?: boolean; outputWrapped?: boolean }> = []
  const schemas: unknown[] = []
  let requests = 0, stopCalls = 0, callbacks = 0, observedError = false
  try {
    const provider = createOpenAI({ apiKey: 'offline-only', baseURL: 'https://example.invalid/v1', fetch: async (_input, init) => {
      requests++
      assert.ok(requests <= 3, 'Mock loop must remain bounded')
      events.push({ event: `post-${requests}` })
      const body = JSON.parse(String(init?.body))
      assert.equal(body.stream, true)
      schemas.push(body.tools?.[0]?.function?.parameters)
      return streamResponse(args, requests)
    } })
    const tool = createTool({ id: 'save_storyboards', description: 'Offline plan schema validation only; no database tool.',
      inputSchema: z.object({ video_prompt_plan: videoPromptPlanSchema }),
      execute: async input => { parsedPlans.push(input.video_prompt_plan); return { staged: true } },
    })
    const agent = new Agent({ id: `offline-plan-wire-${++sequence}`, name: 'Offline plan wire', instructions: 'Use only the local fixture tool.',
      model: provider.chat('offline'), maxRetries: 0, tools: { save_storyboards: tool },
    })
    const output = await agent.stream('offline fixture', {
      stopWhen: ({ steps }: any) => {
        stopCalls++
        const entries = steps.at(-1)?.toolResults || []
        const errors = entries.some((entry: any) => Boolean(resultOf(entry, stopMode === 'unwrap-stop')?.error))
        const outputWrapped = entries.some((entry: any) => entry?.output?.type === 'json' && Object.hasOwn(entry.output, 'value'))
        events.push({ event: 'stopWhen', errors, outputWrapped })
        if (stopMode === 'unwrap-stop') observedError ||= errors
        return stopMode === 'first-step' || observedError || steps.length >= 3
      },
      onStepFinish: (step: any) => {
        callbacks++
        const errors = (step.toolResults || []).some((entry: any) => Boolean(resultOf(entry, false)?.error))
        events.push({ event: 'onStepFinish', errors })
        observedError ||= errors
      },
    })
    const full = await output.getFullOutput()
    if (full.error) throw full.error
    return { requests, stopCalls, callbacks, parsedPlans, schemas, events, steps: full.steps.length }
  } finally {
    globalThis.fetch = originalFetch
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
  }
}

test('optional null values normalize to undefined without weakening mandatory plan fields', { concurrency: false }, () => {
  const parsed = videoPromptPlanSchema.parse(nullablePlan())
  assert.equal(parsed.shots[0].characters[0].emotion, undefined)
  assert.equal(parsed.shots[0].rows[0].dialogue, undefined)
  const speech = parsed.shots[1].rows[0].dialogue![0]
  assert.equal(speech.speaker_id, undefined)
  assert.equal(speech.spoken_seconds, undefined)
  assert.equal(speech.voice_reference, undefined)
  assert.equal(speech.voice.delivery, undefined)
  const emptyToken = nullablePlan()
  emptyToken.shots[1].rows[0].dialogue[0].voice_reference = ''
  assert.equal(videoPromptPlanSchema.parse(emptyToken).shots[1].rows[0].dialogue![0].voice_reference, undefined)
})

test('native Mastra OpenAI SSE tool wire accepts nullable optional fields and executes with transformed values in one model step', { concurrency: false }, async () => {
  const result = await nativeWire(nullablePlan())
  assert.equal(result.requests, 1)
  assert.equal(result.parsedPlans.length, 1)
  assert.equal(result.steps, 1)
  assert.equal(result.callbacks, 1)
  assert.ok(result.schemas[0] && typeof result.schemas[0] === 'object')
  assert.ok(JSON.stringify(result.schemas[0]).includes('null'), 'Nullable input fields must be representable in the actual provider tool schema')
  const parsed = result.parsedPlans[0]
  assert.equal(parsed.shots[0].rows[0].dialogue, undefined)
  assert.equal(parsed.shots[0].characters[0].emotion, undefined)
  assert.equal(parsed.shots[1].rows[0].dialogue![0].voice_reference, undefined)
  assert.equal(parsed.shots[1].rows[0].dialogue![0].speaker_id, undefined)
  assert.equal(parsed.shots[1].rows[0].dialogue![0].spoken_seconds, undefined)
})

test('native Mastra tool wire accepts an empty optional voice_reference without unsupported-transform errors', { concurrency: false }, async () => {
  const raw = nullablePlan()
  raw.shots[1].rows[0].dialogue[0].voice_reference = ''
  const result = await nativeWire(raw)
  assert.equal(result.requests, 1)
  assert.equal(result.parsedPlans.length, 1)
  assert.equal(result.parsedPlans[0].shots[1].rows[0].dialogue![0].voice_reference, undefined)
})

test('mandatory fields still reject null, empty strings and invalid character IDs', { concurrency: false }, () => {
  const cases = [
    (value: any) => { value.space = null },
    (value: any) => { value.space = '' },
    (value: any) => { value.shots = null },
    (value: any) => { value.shots[0].rows[0].visual = null },
    (value: any) => { value.shots[0].characters[0].character_id = null },
    (value: any) => { value.shots[1].rows[0].dialogue[0].text = null },
    (value: any) => { value.shots[1].rows[0].dialogue[0].voice.age = null },
  ]
  for (const mutate of cases) {
    const value = nullablePlan()
    mutate(value)
    assert.equal(videoPromptPlanSchema.safeParse(value).success, false)
  }
})

test('SDK validation failure reaches stopWhen before onStepFinish in a wrapped JSON output and late-only observation sends one extra request', { concurrency: false }, async () => {
  const invalid = nullablePlan()
  invalid.space = null
  const result = await nativeWire(invalid, 'late-callback')
  assert.equal(result.parsedPlans.length, 0, 'A mandatory-invalid plan must never reach tool execute')
  assert.equal(result.requests, 2)
  const stop = result.events.findIndex(event => event.event === 'stopWhen')
  const callback = result.events.findIndex(event => event.event === 'onStepFinish')
  const nextPost = result.events.findIndex(event => event.event === 'post-2')
  assert.ok(stop >= 0 && callback > stop && nextPost > callback)
  assert.equal(result.events[stop].outputWrapped, true)
  assert.equal(result.events[stop].errors, false)
  assert.equal(result.events[callback].errors, true)
})

test('unwrapping the actual SDK output.value inside stopWhen recognizes a validation failure before another model POST', { concurrency: false }, async () => {
  const invalid = nullablePlan()
  invalid.space = null
  const result = await nativeWire(invalid, 'unwrap-stop')
  assert.equal(result.parsedPlans.length, 0)
  assert.equal(result.requests, 1)
  assert.equal(result.steps, 1)
  assert.ok(result.events.some(event => event.event === 'stopWhen' && event.errors === true && event.outputWrapped === true))
})
