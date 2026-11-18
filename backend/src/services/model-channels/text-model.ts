import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import type { AIConfig } from '../ai.js'
import { getConfigById, assertConfigService } from '../ai.js'
import { joinProviderUrl } from '../adapters/url.js'
import { createTextProviderFetch } from '../text-provider-http.js'
import { observeLanguageModel } from '../activity/model-observer.js'
import { currentActivity } from '../activity/context.js'
import { recordActivityWire } from '../activity/store.js'
import { validateModelParameters } from './parameters.js'
import { createEngineTextModel } from './text-model-engine.js'
import { buildAgent, sendProviderRequest } from '../provider-runtime/index.js'
import { providerStreamingMode, modelResponseFormat } from './parameters.js'

export function configuredTextModel(
  config: AIConfig,
  modelName: string,
  options: any = {},
  rawParameters?: unknown
): LanguageModelV3 {
  const parameters = validateModelParameters(config, rawParameters),
    pid = config.protocolDefinition?.providerId
  let provider = config.provider.toLowerCase()
  if (provider === 'yingce') {
    if (pid === 'openai-response') provider = 'openai-responses'
    else if (pid === 'claude-api') provider = 'anthropic'
    else if (pid === 'gemini-generate-content') provider = 'gemini'
    else if (pid === 'chat-completion') provider = 'openai'
    else
      return observeLanguageModel(
        createEngineTextModel(config, modelName, parameters, options),
        { model: modelName, provider: config.channelName || 'yingce',configId:config.id,channelId:config.channelId,channelName:config.channelName },
        [config.apiKey, ...Object.values(config.headers || {}), ...Object.values(config.authFields || {})]
      ) as LanguageModelV3
  }
  const baseURL =
    provider === 'gemini'
      ? joinProviderUrl(config.baseUrl, '/v1beta', '')
      : provider === 'volcengine'
        ? joinProviderUrl(config.baseUrl, '/api/v3', '')
        : joinProviderUrl(config.baseUrl, '/v1', '')
  const baseFetch = createTextProviderFetch({
    ...options,
    provider,
    baseURL,
    model: modelName,
    temperature: parameters.temperature ?? options.temperature,
    disableThinking: parameters.reasoning_effort !== undefined ? false : options.disableThinking,
    maxTokens: parameters.max_tokens ?? parameters.maxOutputTokens ?? options.maxTokens,
    onWireRequest: (wire: unknown) => {
      const taskId = currentActivity()?.taskId
      if (taskId) recordActivityWire(taskId, wire)
    }
  } as any)
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
    for (const [name, value] of Object.entries(config.headers || {})) headers.set(name, value)
    if (typeof init?.body === 'string' && Object.keys(parameters).length) {
      const body = JSON.parse(init.body)
      const values = { ...parameters, ...(parameters.providerOptions?.[pid || provider] || {}) }
      delete values.providerOptions
      delete values.response_format
      if (provider === 'gemini') {
        const aliases: Record<string, string> = {
          max_tokens: 'maxOutputTokens',
          top_p: 'topP',
          top_k: 'topK',
          stop_sequences: 'stopSequences',
          thinking_config: 'thinkingConfig'
        }
        body.generationConfig = { ...body.generationConfig }
        for (const [key, value] of Object.entries(values)) body.generationConfig[aliases[key] || key] = value
      } else {
        for (const [key, value] of Object.entries(values)) {
          if (key === 'reasoning_effort' && provider === 'openai-responses')
            body.reasoning = { ...body.reasoning, effort: value }
          else
            body[key === 'max_tokens' && provider === 'openai-responses' ? 'max_output_tokens' : key] = value
        }
      }
      init = { ...init, body: JSON.stringify(body) }
    }
    if (config.provider === 'yingce') {
      if (typeof init?.body !== 'string') throw new Error('SDK未提供完整文字请求体')
      const body = JSON.parse(init.body),
        key =
          provider === 'openai-responses'
            ? 'responses'
            : provider === 'anthropic'
              ? 'claude'
              : provider === 'gemini'
                ? 'gemini'
                : 'chatCompletion'
      const built = await buildAgent({
        providerDefinition: config.protocolDefinition,
        connection: {
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          authFields: config.authFields,
          headers: config.headers
        },
        request: {
          model: modelName,
          [key]: body,
          providerOptions: { [pid]: parameters, ...parameters.providerOptions }
        },
        model: modelName
      })
      const taskId = currentActivity()?.taskId
      if (taskId) recordActivityWire(taskId, built.wireSummary)
      return sendProviderRequest(built, init.signal || undefined, 'text')
    }
    return baseFetch(input, { ...init, headers })
  }
  const apiKey = config.authFields?.apiKey || config.apiKey
  const model =
    provider === 'gemini'
      ? createGoogleGenerativeAI({ baseURL, apiKey, fetch: fetchImpl })(modelName)
      : provider === 'anthropic'
        ? createAnthropic({ baseURL, apiKey, fetch: fetchImpl })(modelName)
        : provider === 'openai-responses'
          ? createOpenAI({ baseURL, apiKey, fetch: fetchImpl }).responses(modelName)
          : createOpenAI({ baseURL, apiKey, fetch: fetchImpl }).chat(modelName)
  const wrapped: LanguageModelV3 = {
    ...model,
    specificationVersion: 'v3',
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: (call: any) =>
      model.doGenerate({
        ...call,
        ...(parameters.temperature !== undefined ? { temperature: parameters.temperature } : {}),
        ...(parameters.max_tokens !== undefined ? { maxOutputTokens: parameters.max_tokens } : {}),
        ...(modelResponseFormat(call.responseFormat, options, parameters.response_format)
          ? { responseFormat: modelResponseFormat(call.responseFormat, options, parameters.response_format) }
          : {})
      }),
    doStream: (call: any) =>
      model.doStream({
        ...call,
        ...(parameters.temperature !== undefined ? { temperature: parameters.temperature } : {}),
        ...(parameters.max_tokens !== undefined ? { maxOutputTokens: parameters.max_tokens } : {}),
        ...(modelResponseFormat(call.responseFormat, options, parameters.response_format)
          ? { responseFormat: modelResponseFormat(call.responseFormat, options, parameters.response_format) }
          : {})
      })
  }
  const providerDefinition = config.protocolDefinition?.manifest?.contributes?.providers?.find(
    (item: any) => item.id === pid
  )
  if (config.provider === 'yingce' && providerStreamingMode(providerDefinition) === 'final_response')
    wrapped.doStream = async (call: any) => {
      const result = await wrapped.doGenerate(call)
      return {
        stream: new ReadableStream<any>({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: result.warnings })
            let index = 0
            for (const part of result.content) {
              if (part.type === 'text') {
                const id = `text-${index++}`
                controller.enqueue({ type: 'text-start', id })
                controller.enqueue({ type: 'text-delta', id, delta: part.text })
                controller.enqueue({ type: 'text-end', id })
              } else if (part.type === 'tool-call') controller.enqueue(part)
            }
            controller.enqueue({ type: 'finish', usage: result.usage, finishReason: result.finishReason })
            controller.close()
          }
        })
      }
    }
  return observeLanguageModel(wrapped, { model: modelName, provider: config.channelName || provider,configId:config.id,channelId:config.channelId,channelName:config.channelName }, [
    apiKey,
    ...Object.values(config.headers || {}),
    ...Object.values(config.authFields || {})
  ]) as LanguageModelV3
}
export async function createModelTestTextModel(configId: number, parameters?: unknown) {
  const config = await getConfigById(configId)
  if (!config) throw new Error('模型已停用或未获授权')
  assertConfigService(config, 'text')
  return configuredTextModel(config, config.model, { disableThinking: false }, parameters)
}
