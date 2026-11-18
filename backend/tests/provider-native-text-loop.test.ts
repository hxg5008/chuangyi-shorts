import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-native-text-'))
process.env.HUOBAO_DATA_DIR = root
process.env.SQLITE_PATH = path.join(root, 'text.sqlite3')
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.HUOBAO_PROXY_URL = 'direct'
const { db } = await import('../src/db/index.ts')
const { configuredTextModel } = await import('../src/services/model-channels/text-model.ts')
const { shutdownProviderEngine } = await import('../src/services/provider-runtime/index.ts')
const system = '保持这个系统指令原样：测试工具循环，不能省略工具Schema。'
const requests: any[] = []
let family = 'chat',
  round = 0
const server = http.createServer(async (req, res) => {
  let text = ''
  for await (const chunk of req) text += chunk.toString()
  const body = JSON.parse(text)
  requests.push({ path: req.url, body })
  round++
  res.setHeader('Content-Type', 'application/json')
  if (family === 'invalid-json') {
    res.end('invalid provider JSON')
    return
  }
  if (family === 'chat-stream') {
    res.setHeader('Content-Type', 'text/event-stream')
    const frame = (value: any) => res.write('data: ' + JSON.stringify(value) + '\n\n')
    frame({
      id: 'stream-test',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'synthetic',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call-test',
                type: 'function',
                function: { name: 'echo', arguments: '{"value":"原' }
              }
            ]
          },
          finish_reason: null
        }
      ]
    })
    frame({
      id: 'stream-test',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'synthetic',
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '样中文🌙"}' } }] },
          finish_reason: null
        }
      ]
    })
    frame({
      id: 'stream-test',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'synthetic',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
    })
    res.end('data: [DONE]\n\n')
    return
  }
  if (family === 'responses')
    res.end(
      JSON.stringify({
        id: 'response-' + round,
        object: 'response',
        created_at: 1,
        status: 'completed',
        model: 'synthetic',
        output:
          round === 1
            ? [
                {
                  type: 'function_call',
                  id: 'fc-test',
                  call_id: 'call-test',
                  name: 'echo',
                  arguments: '{"value":"原样中文🌙"}',
                  status: 'completed'
                }
              ]
            : [
                {
                  type: 'message',
                  id: 'message-test',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: '工具执行完成', annotations: [] }]
                }
              ],
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 }
      })
    )
  else if (family === 'gemini')
    res.end(
      JSON.stringify({
        candidates: [
          {
            index: 0,
            content: {
              role: 'model',
              parts:
                round === 1
                  ? [{ functionCall: { id: 'call-test', name: 'echo', args: { value: '原样中文🌙' } } }]
                  : [{ text: '工具执行完成' }]
            },
            finishReason: 'STOP'
          }
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 }
      })
    )
  else if (family === 'anthropic')
    res.end(
      JSON.stringify({
        id: 'message-' + round,
        type: 'message',
        role: 'assistant',
        model: 'synthetic',
        content:
          round === 1
            ? [{ type: 'tool_use', id: 'call-test', name: 'echo', input: { value: '原样中文🌙' } }]
            : [{ type: 'text', text: '工具执行完成' }],
        stop_reason: round === 1 ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 3 }
      })
    )
  else
    res.end(
      JSON.stringify({
        id: 'chat-' + round,
        object: 'chat.completion',
        created: 1,
        model: 'synthetic',
        choices: [
          {
            index: 0,
            message:
              round === 1
                ? {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call-test',
                        type: 'function',
                        function: { name: 'echo', arguments: '{"value":"原样中文🌙"}' }
                      }
                    ]
                  }
                : { role: 'assistant', content: '工具执行完成' },
            finish_reason: round === 1 ? 'tool_calls' : 'stop'
          }
        ],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
      })
    )
})
test('known Yingce Chat codecs preserve Chinese streaming tool-argument fragments and never retry invalid JSON', async () => {
  const definition = {
    engine: 'yingce-v2',
    providerId: 'deepseek-chat',
    manifest: JSON.parse(
      await fs.readFile(
        new URL('../src/services/model-channels/bundled/deepseek-chat.json', import.meta.url),
        'utf8'
      )
    )
  }
  const model = configuredTextModel(
    {
      serviceType: 'text',
      provider: 'yingce',
      baseUrl: base,
      apiKey: 'synthetic-key',
      model: 'synthetic',
      protocolDefinition: definition
    },
    'synthetic',
    { disableThinking: false }
  )
  family = 'chat-stream'
  round = 0
  requests.length = 0
  const streamed = await model.doStream({
    prompt: [
      { role: 'system', content: system },
      { role: 'user', content: [{ type: 'text', text: 'stream' }] }
    ],
    tools: [
      {
        type: 'function',
        name: 'echo',
        description: 'Return value',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }
      }
    ]
  })
  const parts: any[] = []
  for await (const part of streamed.stream) parts.push(part)
  const call = parts.find((part) => part.type === 'tool-call')
  assert.equal(call.toolCallId, 'call-test')
  assert.deepEqual(JSON.parse(call.input), { value: '原样中文🌙' })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].body.stream, true)
  assert(JSON.stringify(requests[0].body).includes(system))
  family = 'invalid-json'
  requests.length = 0
  await assert.rejects(
    model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'do not retry' }] }] })
  )
  assert.equal(requests.length, 1, 'Parsing failure must not replay a billable request or switch protocols')
})
test('native SDK codecs honor imported engine routing and retain the workflow JSON schema', async () => {
  const manifest = JSON.parse(
    await fs.readFile(
      new URL('../src/services/model-channels/bundled/openai-responses.json', import.meta.url),
      'utf8'
    )
  )
  manifest.contributes.providers[0].agent.path = '/v1/custom-responses'
  const schema = {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false
  }
  family = 'responses'
  round = 0
  requests.length = 0
  const model = configuredTextModel(
    {
      serviceType: 'text',
      provider: 'yingce',
      baseUrl: base,
      apiKey: 'synthetic-key',
      model: 'synthetic',
      parameters: [{ key: 'response_format', type: 'object', label: 'Response format' }],
      protocolDefinition: { engine: 'yingce-v2', providerId: 'openai-response', manifest }
    },
    'synthetic',
    { jsonSchemaOutput: { name: 'facts', schema }, disableThinking: false },
    { response_format: { type: 'text' } }
  )
  await model.doGenerate({
    prompt: [
      { role: 'system', content: system },
      { role: 'user', content: [{ type: 'text', text: 'schema' }] }
    ]
  })
  assert.equal(requests[0].path, '/v1/custom-responses')
  assert.deepEqual(requests[0].body.text.format.schema, schema)
  assert(JSON.stringify(requests[0].body).includes(system))
  round = 0
  requests.length = 0
  const standalone = configuredTextModel(
    {
      serviceType: 'text',
      provider: 'yingce',
      baseUrl: base,
      apiKey: 'synthetic-key',
      model: 'synthetic',
      parameters: [{ key: 'response_format', type: 'object', label: 'Response format' }],
      protocolDefinition: { engine: 'yingce-v2', providerId: 'openai-response', manifest }
    },
    'synthetic',
    { disableThinking: false },
    { response_format: { type: 'json_schema', json_schema: { name: 'trial', schema } } }
  )
  await standalone.doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'trial schema' }] }]
  })
  assert.deepEqual(requests[0].body.text.format.schema, schema)
  assert.equal(requests[0].body.text.format.name, 'trial')
  const chatManifest = JSON.parse(
    await fs.readFile(
      new URL('../src/services/model-channels/bundled/deepseek-chat.json', import.meta.url),
      'utf8'
    )
  )
  family = 'chat'
  round = 0
  requests.length = 0
  const chatModel = configuredTextModel(
    {
      serviceType: 'text',
      provider: 'yingce',
      baseUrl: base,
      apiKey: 'synthetic-key',
      model: 'synthetic',
      protocolDefinition: { engine: 'yingce-v2', providerId: 'deepseek-chat', manifest: chatManifest }
    },
    'synthetic',
    { jsonSchemaOutput: { name: 'facts', schema }, disableThinking: false }
  )
  await chatModel.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'schema' }] }] })
  assert.deepEqual(requests[0].body.response_format.json_schema.schema, schema)
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as any).port}`
for (const provider of ['openai', 'openai-responses', 'anthropic', 'gemini', 'yingce'])
  test(`${provider} completes an actual Mastra tool loop without losing system, tool schema or tool result`, async () => {
    family =
      provider === 'openai-responses'
        ? 'responses'
        : provider === 'anthropic'
          ? 'anthropic'
          : provider === 'gemini'
            ? 'gemini'
            : 'chat'
    round = 0
    requests.length = 0
    let protocolDefinition: any
    if (provider === 'yingce')
      protocolDefinition = {
        engine: 'yingce-v2',
        providerId: 'deepseek-chat',
        manifest: JSON.parse(
          await fs.readFile(
            new URL('../src/services/model-channels/bundled/deepseek-chat.json', import.meta.url),
            'utf8'
          )
        )
      }
    const model = configuredTextModel(
      {
        serviceType: 'text',
        provider,
        baseUrl: base,
        apiKey: 'synthetic-key',
        model: 'synthetic',
        protocolDefinition
      },
      'synthetic',
      { disableThinking: false },
      provider === 'gemini' ? { temperature: 0.25, max_tokens: 512 } : undefined
    )
    let toolCalls = 0
    const agent = new Agent({
      id: 'synthetic-tool-loop',
      name: 'Synthetic tool loop',
      instructions: system,
      model,
      tools: {
        echo: createTool({
          id: 'echo',
          description: 'Return the provided value',
          inputSchema: z.object({ value: z.string() }),
          execute: async (input: any) => {
            toolCalls++
            assert.equal(input.value, '原样中文🌙')
            return { value: input.value }
          }
        })
      }
    })
    const result = await agent.generate('请调用echo工具，然后回复工具执行完成。', { maxSteps: 3 })
    assert.match(result.text, /工具执行完成/)
    assert.equal(toolCalls, 1)
    assert.equal(requests.length, 2)
    const first = JSON.stringify(requests[0].body),
      second = JSON.stringify(requests[1].body)
    assert(first.includes(system))
    assert(first.includes('Return the provided value'))
    assert(first.includes('"required":["value"]'))
    if (provider === 'gemini') {
      assert(second.includes('functionResponse'))
      assert(second.includes('"name":"echo"'))
    } else assert(second.includes('call-test'))
    assert(second.includes('原样中文🌙'))
    assert.equal(
      requests[0].path,
      provider === 'openai-responses'
        ? '/v1/responses'
        : provider === 'anthropic'
          ? '/v1/messages'
          : provider === 'gemini'
            ? '/v1beta/models/synthetic:generateContent'
            : '/v1/chat/completions'
    )
    if (provider === 'gemini') {
      assert.equal(requests[0].body.generationConfig.temperature, 0.25)
      assert.equal(requests[0].body.generationConfig.maxOutputTokens, 512)
      assert.equal(requests[0].body.temperature, undefined)
    }
  })
test.after(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  shutdownProviderEngine()
  db.$client.close()
  assert(path.basename(root).startsWith('huobao-native-text-'))
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
