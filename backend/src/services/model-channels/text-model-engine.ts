import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart
} from '@ai-sdk/provider'
import { createOpenAI } from '@ai-sdk/openai'
import {
  buildAgent,
  parseAgent,
  sendProviderRequest,
  decodeProviderResponse
} from '../provider-runtime/index.js'
import type { AIConfig } from '../ai.js'
import type { ProviderDefinition } from '../provider-runtime/types.js'
import { currentActivity } from '../activity/context.js'
import { recordActivityWire } from '../activity/store.js'
import { usesIncrementalChatCodec, modelResponseFormat } from './parameters.js'

const output = (value: any) => value?.value ?? value?.text ?? value
function chatMessages(prompt: any[]) {
  const messages: any[] = []
  for (const message of prompt) {
    if (message.role === 'system') {
      messages.push({ role: 'system', content: message.content })
      continue
    }
    const content: any[] = [],
      calls: any[] = []
    for (const part of message.content || []) {
      if (part.type === 'text') content.push({ type: 'text', text: part.text })
      else if (part.type === 'file') {
        const data =
          part.data instanceof URL
            ? part.data.toString()
            : typeof part.data === 'string'
              ? part.data
              : `data:${part.mediaType};base64,${Buffer.from(part.data).toString('base64')}`
        content.push(
          part.mediaType?.startsWith('image/')
            ? { type: 'image_url', image_url: { url: data } }
            : { type: 'file', file: { file_data: data, filename: part.filename } }
        )
      } else if (part.type === 'tool-call')
        calls.push({
          id: part.toolCallId,
          type: 'function',
          function: {
            name: part.toolName,
            arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input)
          },
          thoughtSignature:
            part.providerOptions?.yingce?.thoughtSignature || part.providerMetadata?.yingce?.thoughtSignature
        })
      else if (part.type === 'tool-result')
        messages.push({
          role: 'tool',
          tool_call_id: part.toolCallId,
          name: part.toolName,
          content:
            typeof output(part.output) === 'string'
              ? output(part.output)
              : JSON.stringify(output(part.output))
        })
    }
    if (content.length || calls.length)
      messages.push({
        role: message.role,
        content: content.length === 1 && content[0].type === 'text' ? content[0].text : content,
        ...(calls.length ? { tool_calls: calls } : {})
      })
  }
  return messages
}
function nativeEnvelopes(chat: any, options: LanguageModelV3CallOptions) {
  const systems = chat.messages
    .filter((message: any) => message.role === 'system')
    .map((message: any) =>
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
    )
  const claudeMessages: any[] = [],
    contents: any[] = []
  for (const message of chat.messages) {
    if (message.role === 'system') continue
    if (message.role === 'tool') {
      let value: any = message.content
      try {
        value = JSON.parse(value)
      } catch {}
      claudeMessages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }]
      })
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: message.tool_call_id,
              name: message.name,
              response: typeof value === 'object' && value !== null ? value : { result: value }
            }
          }
        ]
      })
      continue
    }
    const parts: any[] = [],
      claudeParts: any[] = []
    for (const part of typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content || []) {
      if (part.type === 'text') {
        parts.push({ text: part.text })
        claudeParts.push(part)
      } else if (part.type === 'image_url') {
        const url = part.image_url.url,
          inline = /^data:([^;,]+);base64,(.*)$/su.exec(url)
        if (inline) {
          parts.push({ inlineData: { mimeType: inline[1], data: inline[2] } })
          claudeParts.push({
            type: 'image',
            source: { type: 'base64', media_type: inline[1], data: inline[2] }
          })
        } else {
          parts.push({ fileData: { mimeType: 'image/jpeg', fileUri: url } })
          claudeParts.push({ type: 'image', source: { type: 'url', url } })
        }
      } else throw new Error('该原生文字协议未声明此文件内容块格式，未丢弃文件或提交请求')
    }
    for (const call of message.tool_calls || []) {
      let args: any
      try {
        args = JSON.parse(call.function.arguments)
      } catch {
        throw new Error('工具调用参数不是有效JSON')
      }
      parts.push({
        functionCall: { id: call.id, name: call.function.name, args },
        ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {})
      })
      claudeParts.push({ type: 'tool_use', id: call.id, name: call.function.name, input: args })
    }
    claudeMessages.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: claudeParts })
    contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts })
  }
  const declarations = (chat.tools || []).map((tool: any) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters
  }))
  const gemini: any = {
    contents,
    systemInstruction: systems.length ? { parts: systems.map((text: string) => ({ text })) } : undefined,
    generationConfig: {
      maxOutputTokens: chat.max_tokens,
      ...(chat.temperature !== undefined ? { temperature: chat.temperature } : {}),
      ...(chat.top_p !== undefined ? { topP: chat.top_p } : {}),
      ...(chat.response_format
        ? {
            responseMimeType: 'application/json',
            ...(chat.response_format.json_schema?.schema
              ? { responseSchema: chat.response_format.json_schema.schema }
              : {})
          }
        : {})
    },
    ...(declarations.length ? { tools: [{ functionDeclarations: declarations }] } : {})
  }
  if (chat.tool_choice)
    gemini.toolConfig = {
      functionCallingConfig: {
        mode: chat.tool_choice === 'none' ? 'NONE' : chat.tool_choice === 'auto' ? 'AUTO' : 'ANY',
        ...(typeof chat.tool_choice === 'object'
          ? { allowedFunctionNames: [chat.tool_choice.function.name] }
          : {})
      }
    }
  const claude: any = {
    model: chat.model,
    system: systems.join('\n\n'),
    messages: claudeMessages,
    max_tokens: chat.max_tokens,
    ...(chat.temperature !== undefined ? { temperature: chat.temperature } : {}),
    ...(chat.top_p !== undefined ? { top_p: chat.top_p } : {}),
    ...(declarations.length
      ? {
          tools: declarations.map((tool: any) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters
          }))
        }
      : {}),
    stream: false
  }
  if (chat.tool_choice)
    claude.tool_choice =
      typeof chat.tool_choice === 'object'
        ? { type: 'tool', name: chat.tool_choice.function.name }
        : { type: chat.tool_choice === 'required' ? 'any' : chat.tool_choice }
  return { gemini, claude }
}
export function createEngineTextModel(
  config: AIConfig,
  model: string,
  parameters: Record<string, any>,
  execution: any = {}
): LanguageModelV3 {
  const definition = config.protocolDefinition as any,
    provider = definition?.manifest?.contributes?.providers?.find(
      (provider: any) => provider.id === definition.providerId
    )
  const chatCodec = usesIncrementalChatCodec(provider)
  if (chatCodec) {
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('文字SDK没有提供完整JSON请求，未提交模型')
      const body = JSON.parse(init.body),
        providerId = definition.providerId
      const chatCompletion = {
        ...parameters,
        ...body,
        ...(parameters.temperature !== undefined ? { temperature: parameters.temperature } : {}),
        ...(parameters.top_p !== undefined ? { top_p: parameters.top_p } : {}),
        ...(parameters.max_tokens !== undefined ? { max_tokens: parameters.max_tokens } : {})
      }
      delete (chatCompletion as Record<string, any>).providerOptions
      const built = await buildAgent({
        providerDefinition: definition,
        connection: {
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          authFields: config.authFields,
          headers: config.headers
        },
        model,
        request: {
          model,
          chatCompletion,
          providerOptions: { [providerId]: parameters, ...parameters.providerOptions }
        }
      })
      const taskId = currentActivity()?.taskId
      if (taskId) recordActivityWire(taskId, built.wireSummary)
      return sendProviderRequest(built, init.signal || undefined, 'text')
    }
    const sdk = createOpenAI({
      baseURL: config.baseUrl.replace(/\/+$/u, '') + '/v1',
      apiKey: config.apiKey,
      fetch: fetchImpl
    }).chat(model)
    const apply = (call: LanguageModelV3CallOptions): LanguageModelV3CallOptions => ({
      ...call,
      ...(execution.temperature !== undefined && execution.temperature !== null
        ? { temperature: execution.temperature }
        : {}),
      ...(execution.maxTokens !== undefined ? { maxOutputTokens: execution.maxTokens } : {}),
      ...(modelResponseFormat(call.responseFormat, execution, parameters.response_format)
        ? { responseFormat: modelResponseFormat(call.responseFormat, execution, parameters.response_format) }
        : {})
    })
    return {
      specificationVersion: 'v3',
      provider: sdk.provider,
      modelId: sdk.modelId,
      supportedUrls: sdk.supportedUrls,
      doGenerate: (call) => sdk.doGenerate(apply(call)),
      doStream: (call) => sdk.doStream(apply(call))
    }
  }
  const run = async (options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> => {
    const messages = chatMessages(options.prompt),
      tools = (options.tools || []).map((tool: any) => {
        if (tool.type !== 'function') throw new Error('此协议不支持平台内置provider工具，请改用函数工具')
        return {
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
            strict: tool.strict
          }
        }
      })
    const format = modelResponseFormat(options.responseFormat, execution, parameters.response_format)
    const schema = format?.type === 'json' ? format.schema : undefined
    const response_format = schema
      ? {
          type: 'json_schema',
          json_schema: {
            name: format.name || 'result',
            schema,
            strict: true
          }
        }
      : format?.type === 'json'
        ? { type: 'json_object' }
        : undefined
    const chatCompletion = {
      ...parameters,
      model,
      messages,
      tools: tools.length ? tools : undefined,
      tool_choice:
        options.toolChoice?.type === 'tool'
          ? { type: 'function', function: { name: options.toolChoice.toolName } }
          : options.toolChoice?.type,
      max_tokens: parameters.max_tokens ?? options.maxOutputTokens ?? execution.maxTokens ?? 16384,
      temperature: parameters.temperature ?? options.temperature,
      top_p: parameters.top_p ?? options.topP,
      response_format,
      stream: false
    }
    delete (chatCompletion as Record<string, any>).providerOptions
    const providerId = config.protocolDefinition?.providerId || ''
    const envelopes =
      providerId === 'vertex-gemini' ||
      (providerId === 'aws-bedrock-invoke-model' && /anthropic|claude/iu.test(model))
        ? nativeEnvelopes(chatCompletion, options)
        : {}
    const request = {
      chatCompletion,
      responses: { ...chatCompletion, input: messages },
      ...envelopes,
      model,
      providerOptions: { [providerId]: parameters, ...parameters.providerOptions },
      parameters
    }
    const built = await buildAgent({
      providerDefinition: config.protocolDefinition as ProviderDefinition,
      connection: {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        authFields: config.authFields,
        headers: config.headers
      },
      request,
      model
    })
    const taskId = currentActivity()?.taskId
    if (taskId) recordActivityWire(taskId, built.wireSummary)
    const response = await sendProviderRequest(built, options.abortSignal, 'text'),
      raw = await decodeProviderResponse(response)
    const result = await parseAgent({
      providerDefinition: config.protocolDefinition as ProviderDefinition,
      raw
    })
    const content: any[] = []
    if (result.text) content.push({ type: 'text', text: result.text })
    for (const call of result.toolCalls || [])
      content.push({
        type: 'tool-call',
        toolCallId: call.id,
        toolName: call.name,
        input: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
        ...(call.thoughtSignature
          ? { providerMetadata: { yingce: { thoughtSignature: call.thoughtSignature } } }
          : {})
      })
    const usage: any = result.usage || raw?.usage || raw?.usage_metadata || raw?.usageMetadata || {}
    const input =
      usage.inputTokens?.total ??
      usage.inputTokens ??
      usage.prompt_tokens ??
      usage.input_tokens ??
      usage.promptTokenCount
    const generated =
      usage.outputTokens?.total ??
      usage.outputTokens ??
      usage.completion_tokens ??
      usage.output_tokens ??
      usage.candidatesTokenCount
    return {
      content,
      finishReason: {
        unified: result.toolCalls?.length ? 'tool-calls' : 'stop',
        raw: raw?.choices?.[0]?.finish_reason || raw?.stop_reason || 'stop'
      },
      usage: {
        inputTokens: {
          total: typeof input === 'number' ? input : undefined,
          noCache: undefined,
          cacheRead: usage.cacheReadTokens,
          cacheWrite: undefined
        },
        outputTokens: {
          total: typeof generated === 'number' ? generated : undefined,
          text: undefined,
          reasoning: undefined
        },
        raw: usage
      },
      warnings: []
    }
  }
  return {
    specificationVersion: 'v3',
    provider: 'yingce',
    modelId: model,
    supportedUrls: { 'image/*': [/^https?:/u, /^data:/u] },
    doGenerate: run,
    async doStream(options) {
      const result = await run(options)
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] })
            let index = 0
            for (const part of result.content) {
              if (part.type === 'text') {
                const id = `text-${index++}`
                controller.enqueue({ type: 'text-start', id })
                controller.enqueue({ type: 'text-delta', id, delta: part.text })
                controller.enqueue({ type: 'text-end', id })
              } else if (part.type === 'tool-call') controller.enqueue(part)
            }
            controller.enqueue({ type: 'finish', finishReason: result.finishReason, usage: result.usage })
            controller.close()
          }
        })
      }
    }
  }
}
