/** Diagnostic copies only. This never mutates a provider request or a business result. */
import { redactRuntimeSecrets } from '../../utils/secret-redaction.js'
export function sanitizeActivity(value: unknown, secrets: string[] = [], maxString = 300_000): any {
  const cleanText = (input: string) => {
    let text = redactRuntimeSecrets(input)
    for (const secret of secrets) if (secret && secret.length > 3) text = text.split(secret).join('[凭据已隐藏]').split(encodeURIComponent(secret)).join('[凭据已隐藏]')
    text = text.replace(/\b(?:sk-|sess-)[A-Za-z0-9_-]{8,}/gu, '[凭据已隐藏]')
      .replace(/\bBearer\s+[^\s"'<>,;}]+/giu, 'Bearer [凭据已隐藏]')
      .replace(/([?&](?:key|api_key|token|access_token|signature|sig|credential|secret|auth)=)[^&#\s"']+/giu, '$1[已隐藏]')
      .replace(/data:(?:image|audio|video)\/[^;\s]+;base64,[A-Za-z0-9+/=]+/gu, '[媒体字节已省略]')
    return text.length > maxString ? text.slice(0, maxString) + '\n[日志副本超长，已明确截断；原请求未改动]' : text
  }
  const visit = (item: any, depth: number): any => {
    if (item == null || typeof item === 'boolean' || typeof item === 'number') return item
    if (typeof item === 'string') return cleanText(item)
    if (depth > 16) return '[日志结构过深]'
    if (Array.isArray(item)) return item.slice(0, 2000).map(entry => visit(entry, depth + 1)).filter(entry => entry !== undefined)
    if (typeof item !== 'object') return undefined
    if (typeof item.type === 'string' && /^(?:reasoning|hidden.thought|chain.of.thought)/iu.test(item.type)) return undefined
    const result: Record<string, any> = {}
    for (const [key, entry] of Object.entries(item)) {
      if (/authorization|cookie|password|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|credential|secretAccessKey|(^|_)signature$|^(?:headers|authFields|auth_fields|authValues|auth_values)$|^(?:key|token|secret)$/iu.test(key)) result[key] = '[凭据已隐藏]'
      else if (/base64|b64_json|inlineData|audioHex|^bytes$|^buffer$/iu.test(key)) result[key] = '[媒体字节已省略]'
      else if (!/reasoning(?:Text|Delta|Content)?$|chain.of.thought|hidden.thought/iu.test(key)) result[key] = visit(entry, depth + 1)
    }
    return result
  }
  return visit(value, 0)
}

export function publicActivityRequest(input: any): any {
  if (!input || typeof input !== 'object') return input
  if (Array.isArray(input)) return input.filter(message => !['system', 'developer'].includes(message?.role)).map(publicActivityRequest)
  const result: Record<string, any> = {}
  for (const [key, value] of Object.entries(input)) {
    if (/^(?:system|instructions|developerInstructions|tools|outputSchema|schema|systemSnapshot|skillSnapshot|protocolSnapshot|protocolDefinition|providerRequestSnapshot|native_request|baseUrl|base_url|headers)$/iu.test(key)) continue
    result[key] = publicActivityRequest(value)
  }
  return result
}

export function activityUsage(value: any) {
  const number = (x: any) => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null
  const input = number(value?.inputTokens?.total ?? value?.inputTokens ?? value?.promptTokens ?? value?.prompt_tokens)
  const output = number(value?.outputTokens?.total ?? value?.outputTokens ?? value?.completionTokens ?? value?.completion_tokens)
  const total = number(value?.totalTokens ?? value?.total_tokens) ?? (input !== null && output !== null ? input + output : null)
  return { inputTokens: input, outputTokens: output, totalTokens: total }
}
