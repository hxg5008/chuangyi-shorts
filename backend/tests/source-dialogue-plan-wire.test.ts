import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import { buildDialogueTimingGuide } from '../src/services/first-pass-instructions.ts'
import { resolveSourceDialoguePlan, videoPromptPlanInputSchema } from '../src/services/source-dialogue-plan.ts'
import { videoPromptPlanSchema } from '../src/services/video-prompt-plan.ts'

const guide = buildDialogueTimingGuide([{ speakerName: 'A', kind: 'dialogue', text: 'Original words.' }], [{ id: 1, name: 'A' }])
function fixture(): any {
  return { space: 'A0 is the threshold, X east and Y north.', shots: [
    { shot_number: 1, characters: [{ character_id: 1, visibility: 'face_hidden', emotion: null }], rows: [{ visual: '@A turns.', dialogue: [
      { source_line: 1, fragment_index: 1, voice: { age: 'adult', register: 'low', timbre: 'warm', delivery: null }, spoken_seconds: null, voice_reference: '' },
    ] }] },
    { shot_number: 2, characters: [{ character_id: 1, visibility: 'face_hidden' }], rows: [{ visual: '@A waits.', dialogue: null }, { visual: '@A lowers a hand.' }] },
  ] }
}
let sequence = 0
async function wire(raw: unknown) {
  const originalFetch = globalThis.fetch, originalNodeEnv = process.env.NODE_ENV
  globalThis.fetch = async () => { throw new Error('Unexpected external fetch blocked') }
  process.env.NODE_ENV = 'test'
  let requests = 0, executions = 0
  const resolutions: ReturnType<typeof resolveSourceDialoguePlan>[] = []
  try {
    const provider = createOpenAI({ apiKey: 'offline-only', baseURL: 'https://example.invalid/v1', fetch: async (_input, init) => {
      requests++; assert.equal(requests, 1, 'A single-step wire fixture must never request a real continuation')
      const body = JSON.parse(String(init?.body))
      assert.equal(body.stream, true)
      assert.ok(body.tools?.[0]?.function?.parameters)
      const base = { id: 'offline-source', object: 'chat.completion.chunk', created: 0, model: 'offline' }
      const data = [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'source-local', type: 'function', function: {
        name: 'save_source_plan', arguments: JSON.stringify({ plan: raw }),
      } }] }, finish_reason: null }] }, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]
      return new Response(data.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    } })
    const tool = createTool({ id: 'save_source_plan', description: 'Local source-plan protocol test; no production tool or database.',
      inputSchema: z.object({ plan: videoPromptPlanInputSchema }), execute: async ({ plan }) => {
        executions++; const result = resolveSourceDialoguePlan(plan, guide); resolutions.push(result)
        return { accepted: result.plan !== null }
      },
    })
    const agent = new Agent({ id: `offline-source-${++sequence}`, name: 'Offline source plan', instructions: 'Use the local fixture tool only.',
      model: provider.chat('offline'), maxRetries: 0, tools: { save_source_plan: tool } })
    const output = await agent.stream('offline source fixture', { stopWhen: ({ steps }: any) => steps.length >= 1 })
    const full = await output.getFullOutput()
    if (full.error) throw full.error
    return { requests, executions, resolutions, steps: full.steps.length }
  } finally {
    globalThis.fetch = originalFetch
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
  }
}

test('native Mastra OpenAI SSE source union accepts nullable optionals without unsupported transforms and resolves original words', { concurrency: false }, async () => {
  const result = await wire(fixture())
  assert.equal(result.requests, 1); assert.equal(result.executions, 1); assert.equal(result.steps, 1)
  const resolved = result.resolutions[0]
  assert.deepEqual(resolved.issues, [])
  assert.ok(resolved.plan && videoPromptPlanSchema.safeParse(resolved.plan).success)
  assert.equal(resolved.hasSourceEntries, true)
  assert.equal(resolved.hasLegacyDialogue, false)
  assert.deepEqual(resolved.sourceRefs, [{ source_line: 1, fragment_index: 1 }])
  const speech = resolved.plan!.shots[0].rows[0].dialogue![0]
  assert.equal(speech.text, 'Original words.')
  assert.equal(speech.speaker_id, 1)
  assert.equal(speech.spoken_seconds, undefined)
  assert.equal(speech.voice_reference, undefined)
  assert.equal(speech.voice.delivery, undefined)
  assert.equal(Object.hasOwn(speech, 'source_line'), false)
})

test('native source and legacy union branches can coexist while the resolved schema remains legacy-only', { concurrency: false }, async () => {
  const input = fixture()
  input.shots[1].rows[0].dialogue = [{ kind: 'narration', text: 'Unchanged legacy text.', voice: { age: 'adult', register: 'low', timbre: 'warm' }, speaker_id: null }]
  const result = await wire(input)
  assert.equal(result.executions, 1)
  const resolved = result.resolutions[0]
  assert.deepEqual(resolved.issues, [])
  assert.equal(resolved.hasSourceEntries, true)
  assert.equal(resolved.hasLegacyDialogue, true)
  assert.equal(resolved.plan!.shots[1].rows[0].dialogue![0].text, 'Unchanged legacy text.')
})

test('native tool schema rejects a source entry that also supplies forged text before execute', { concurrency: false }, async () => {
  const input = fixture()
  input.shots[0].rows[0].dialogue[0].text = 'forged words'
  const result = await wire(input)
  assert.equal(result.requests, 1)
  assert.equal(result.executions, 0)
  assert.deepEqual(result.resolutions, [])
})
