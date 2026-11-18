import { fetchTextProvider } from '../utils/http.js'

export interface TextProviderRequestMetadata {
  origin: string
  path: string
  model?: string
  stream: boolean
  status?: number
  elapsedMs: number
  requestId?: string
  errorCode?: string
}

export interface TextProviderHttpOptions {
  provider: string
  baseURL: string
  model?: string
  disableThinking?: boolean
  thinkingPolicy?: 'default' | 'disabled' | 'low'
  thinkingOffPatch?: Record<string, unknown>
  temperature?: number | null
  maxTokens?: number
  jsonObjectOutput?: boolean
  jsonSchemaOutput?: { name: string; schema: Record<string, unknown> }
  onRequest?: (metadata: TextProviderRequestMetadata) => void | Promise<void>
  /** Read-only, credential-redacted by the observer; runs after existing patches. */
  onWireRequest?: (request: { url: string; method: string; headers: Record<string, string>; body: unknown }) => void | Promise<void>
}

export interface TextProviderFailure {
  message: string
  code: 'upstream_http_504' | 'upstream_http_error' | 'network_error' | 'aborted' | 'text_provider_error' | 'text_output_limit' | 'text_empty_response'
  statusCode?: number
  requestId?: string
  causeCode?: string
}

const requestIdHeaders = ['x-request-id', 'request-id', 'x-oneapi-request-id', 'x-amzn-requestid', 'x-correlation-id', 'cf-ray', 'trace-id']
const networkCodes = /^(?:UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET|DESTROYED|CLOSED)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE)$/

function safeRequestId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || /^(?:sk-|bearer|api[_-]?key)/i.test(value)) return undefined
  return value
}

function requestId(headers: unknown): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined
  for (const name of requestIdHeaders) {
    let value: unknown
    if (headers instanceof Headers) value = headers.get(name)
    else {
      const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name)
      value = entry?.[1]
    }
    const id = safeRequestId(value)
    if (id) return id
  }
  return undefined
}

function safeMessage(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '文本服务请求失败'
  const gateway = value.match(/gateway\s*timeout/i)
  if (gateway) return gateway[0]
  // Error messages are allowed, raw request/response dumps are not.
  if (/requestBody|responseBody|request[_ ]?headers|response[_ ]?headers/i.test(value)) return '文本服务请求失败（原始请求或响应内容已隐藏）'
  return value
    .replace(/https?:\/\/[^\s<>"'`]+/gi, '[redacted-url]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\bBearer\s+[^\s,"'<>]+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|authorization|access[_-]?token|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[redacted]')
    .replace(/[\r\n]+/g, ' ').trim().slice(0, 400)
}

/** Preserve useful SDK status/cause data without persisting request bodies or credentials. */
export function extractTextProviderFailure(error: unknown): TextProviderFailure {
  const chain: Record<string, any>[] = []
  const seen = new Set<unknown>()
  let current = error
  while (current && typeof current === 'object' && chain.length < 6 && !seen.has(current)) {
    seen.add(current)
    chain.push(current as Record<string, any>)
    current = (current as Record<string, unknown>).cause
  }
  let statusCode: number | undefined
  let statusMessage: unknown
  let id: string | undefined
  let causeCode: string | undefined
  let aborted = false
  let network = false
  for (const item of chain) {
    const rawStatus = item.statusCode ?? item.status ?? item.response?.status
    const numericStatus = typeof rawStatus === 'number' ? rawStatus : typeof rawStatus === 'string' && /^\d{3}$/.test(rawStatus) ? Number(rawStatus) : NaN
    if (statusCode === undefined && Number.isInteger(numericStatus) && numericStatus >= 100 && numericStatus <= 599) {
      statusCode = numericStatus
      statusMessage = item.message
    }
    id ||= safeRequestId(item.requestId ?? item.request_id) || requestId(item.responseHeaders) || requestId(item.response?.headers)
    const code = typeof item.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(item.code) ? item.code : undefined
    if (!causeCode && code && (networkCodes.test(code) || code === 'ABORT_ERR' || code === 'UND_ERR_ABORTED')) causeCode = code
    aborted ||= item.name === 'AbortError' || item.name === 'TimeoutError' || code === 'ABORT_ERR' || code === 'UND_ERR_ABORTED'
      || typeof item.message === 'string' && /本次(?:提示词|分镜)处理超时|任务已中止|本次(?:固定分组)?处理已(?:结束|中止)|\boperation (?:was |has been )?aborted\b/i.test(item.message)
    network ||= Boolean(code && networkCodes.test(code)) || typeof item.message === 'string' && /\bfetch failed\b|\bnetwork (?:error|request failed)\b|\bsocket hang up\b/i.test(item.message)
  }
  const gatewayMessage = chain.find(item => typeof item.message === 'string' && /gateway\s*timeout/i.test(item.message))?.message
  const message = safeMessage(gatewayMessage ?? statusMessage ?? chain.find(item => typeof item.message === 'string' && item.message.trim())?.message ?? (typeof error === 'string' ? error : undefined))
  const code: TextProviderFailure['code'] = statusCode === 504 ? 'upstream_http_504'
    : statusCode !== undefined && (statusCode < 200 || statusCode >= 300) ? 'upstream_http_error'
      : aborted ? 'aborted' : network ? 'network_error'
        : chain.some(item => item.code === 'TEXT_OUTPUT_LIMIT') ? 'text_output_limit'
          : chain.some(item => item.code === 'TEXT_EMPTY_RESPONSE') ? 'text_empty_response' : 'text_provider_error'
  return { message, code, ...(statusCode !== undefined ? { statusCode } : {}), ...(id ? { requestId: id } : {}), ...(causeCode ? { causeCode } : {}) }
}

function officialHost(baseURL: string): string {
  try { return new URL(baseURL).hostname.toLowerCase() } catch { return '' }
}

function safeModel(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,160}$/.test(value) && !/https?:|^sk-/i.test(value) ? value : undefined
}

function safeEndpoint(input: RequestInfo | URL, fallback: string, init?: RequestInit) {
  try {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    let pathname = url.pathname.replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    // If a nonstandard provider embeds credentials in its path, do not log them.
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
    const authorization = headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    const secrets = [authorization, headers.get('x-api-key'), headers.get('api-key'), ...['key', 'api_key', 'token', 'access_token'].map(name => url.searchParams.get(name))]
    for (const secret of secrets) if (secret && secret.length >= 4) pathname = pathname.split(secret).join('[redacted]').split(encodeURIComponent(secret)).join('[redacted]')
    return { origin: url.origin, path: pathname }
  } catch {
    try { return { origin: new URL(fallback).origin, path: '[invalid-path]' } } catch { return { origin: '[invalid-origin]', path: '[invalid-path]' } }
  }
}

/** All text SDK branches, including official endpoints with no patches, use one transport. */
export function createTextProviderFetch(options: TextProviderHttpOptions): typeof fetch {
  const provider = options.provider.toLowerCase()
  const host = officialHost(options.baseURL)
  const officialText = host === 'api.openai.com' || host === 'generativelanguage.googleapis.com'
  const officialOpenAI = host === 'api.openai.com'
  const thinkingPatch = options.thinkingOffPatch || { thinking: { type: 'disabled' }, enable_thinking: false, reasoning_effort: 'none' }
  const notify = (metadata: TextProviderRequestMetadata) => {
    try {
      const output = options.onRequest?.(metadata)
      if (output && typeof output.then === 'function') void output.catch(() => {})
    } catch { /* Diagnostics must not change model request behavior. */ }
  }
  return async (input, init) => {
    let request = init
    let body: Record<string, any> | undefined
    if (typeof init?.body === 'string') {
      try {
        const parsed = JSON.parse(init.body)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          body = parsed as Record<string, any>
          const gemini = provider === 'gemini' && Array.isArray(body.contents)
          const compatible = Array.isArray(body.messages)
          if (compatible && options.jsonSchemaOutput) {
            body.response_format = { type: 'json_schema', json_schema: { ...options.jsonSchemaOutput, strict: true } }
          } else if (options.jsonObjectOutput === true && compatible) body.response_format = { type: 'json_object' }
          const targetHost = officialHost(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
          const deepSeekLow = options.thinkingPolicy === 'low' && !officialText
            && targetHost !== 'api.openai.com' && targetHost !== 'generativelanguage.googleapis.com'
            && provider !== 'gemini' && compatible
            && /^(?:deepseek\/)?deepseek(?:$|[-_:])/iu.test(String(body.model || options.model || ''))
          if (deepSeekLow) {
            // DeepSeek Chat Completions uses these controls together. Do not mix
            // in relay/Qwen/Responses switches that could disable the same call.
            body.thinking = { type: 'enabled' }
            body.reasoning_effort = 'low'
            for (const key of ['enable_thinking', 'thinking_budget', 'reasoning_budget']) delete body[key]
          } else if (!officialText && options.disableThinking !== false) {
            if (gemini) {
              const target = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
              const gemini3 = /gemini-3/i.test(target) || /gemini-3/i.test(String(body.model || ''))
              body.generationConfig = { ...(body.generationConfig || {}), thinkingConfig: gemini3 ? { thinkingLevel: 'low' } : { thinkingBudget: 0, includeThoughts: false } }
            } else if (compatible) Object.assign(body, thinkingPatch)
          }
          if (options.temperature != null) {
            if (gemini) body.generationConfig = { ...(body.generationConfig || {}), temperature: options.temperature }
            else if (compatible) body.temperature = options.temperature
          }
          if (!officialOpenAI) {
            if (gemini) body.generationConfig = { ...(body.generationConfig || {}), maxOutputTokens: options.maxTokens ?? 16384 }
            else if (compatible) body.max_tokens = options.maxTokens ?? 16384
          }
          request = { ...init, body: JSON.stringify(body) }
        }
      } catch { /* Non-JSON requests are passed through without consuming their body. */ }
    }
    const endpoint = safeEndpoint(input, options.baseURL, request)
    const metadata = { ...endpoint, model: safeModel(body?.model) || safeModel(options.model),
      stream: body?.stream === true || provider === 'gemini' && /:streamGenerateContent$/i.test(endpoint.path) }
    const started = performance.now()
    try {
      try {
        const observed = options.onWireRequest?.({ url: input instanceof Request ? input.url : String(input), method: request?.method || (input instanceof Request ? input.method : 'POST'),
          headers: Object.fromEntries(new Headers(request?.headers || (input instanceof Request ? input.headers : undefined))), body: request?.body })
        if (observed instanceof Promise) void observed.catch(() => {})
      } catch { /* Observability never alters the provider request or retries it. */ }
      const response = await fetchTextProvider(input, request)
      notify({ ...metadata, status: response.status, elapsedMs: Math.round(performance.now() - started), ...(requestId(response.headers) ? { requestId: requestId(response.headers) } : {}) })
      // Leave non-2xx responses and streaming bodies untouched for the SDK handler.
      return response
    } catch (error) {
      const failure = extractTextProviderFailure(error)
      notify({ ...metadata, elapsedMs: Math.round(performance.now() - started), errorCode: failure.code, ...(failure.statusCode ? { status: failure.statusCode } : {}), ...(failure.requestId ? { requestId: failure.requestId } : {}) })
      throw error
    }
  }
}
