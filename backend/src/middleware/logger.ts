import type { Context, ErrorHandler, MiddlewareHandler } from 'hono'
import { redactRuntimeSecrets } from '../utils/secret-redaction.js'

const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
}

function statusColor(status: number): string {
  if (status >= 500) return colors.red
  if (status >= 400) return colors.yellow
  if (status >= 300) return colors.cyan
  return colors.green
}

function formatTime(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

const REDACTED = '[redacted]'
const requestSecrets = new WeakMap<Request, string[]>()
const credentialKeys = new Set([
  'key', 'apikey', 'auth', 'authorization', 'proxyauthorization', 'password', 'passwd', 'pwd',
  'secret', 'secretkey', 'clientsecret', 'accesskey', 'privatekey', 'credential', 'credentials',
  'cookie', 'setcookie', 'signature', 'sig', 'sessionid',
  'authfields', 'authvalues', 'secretaccesskey', 'accesskeyid', 'sessiontoken',
])

function isCredentialKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return credentialKeys.has(normalized) || normalized.includes('apikey')
    || normalized.includes('authorization') || normalized.includes('password')
    || normalized.endsWith('token') || normalized.endsWith('tokens') || normalized.endsWith('secret')
    || /密钥|密码|令牌/.test(key)
}

function parsedContainer(text: string): object | null {
  if (!/^[\s]*[\[{]/.test(text)) return null
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' ? value : null
  } catch { return null }
}

function collectSecrets(value: unknown, result: Set<string>, sensitive = false): void {
  if (typeof value === 'string') {
    if (sensitive && value) {
      result.add(value)
      const token = value.match(/^(?:Bearer|Basic)\s+(.+)$/i)?.[1]
      if (token) result.add(token)
    }
    const nested = parsedContainer(value)
    if (nested) collectSecrets(nested, result, sensitive)
  } else if (Array.isArray(value)) {
    for (const item of value) collectSecrets(item, result, sensitive)
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) collectSecrets(item, result, sensitive || isCredentialKey(key))
  }
}

function redactText(value: unknown, secrets: readonly string[] = []): string {
  let text = String(value ?? '')
  for (const secret of secrets) {
    text = text.split(secret).join(REDACTED)
    try { text = text.split(encodeURIComponent(secret)).join(REDACTED) } catch {}
  }
  return redactRuntimeSecrets(text)
    .replace(/\bsk-[a-z0-9_-]+/gi, REDACTED)
    .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>,;}&]+/gi, REDACTED)
    .replace(/(https?:\/\/)[^\s/@"'<>]+:[^\s/@"'<>]+@/gi, `$1${REDACTED}@`)
    .replace(/((?:["']?)(?:[\w.-]*(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|token|password|passwd|client[_-]?secret|secret|credential|private[_-]?key|signature))["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&\]]+)/gi, `$1${REDACTED}`)
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') {
    const nested = parsedContainer(value)
    return redactText(nested ? JSON.stringify(redactValue(nested, secrets)) : value, secrets)
  }
  if (Array.isArray(value)) return value.map(item => redactValue(item, secrets))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, isCredentialKey(key) ? REDACTED : redactValue(item, secrets),
    ]))
  }
  return value
}

function redactBody(text: string, contentType: string, knownSecrets: readonly string[] = []): { text: string; secrets: string[] } {
  let value: unknown
  try { value = JSON.parse(text) }
  catch {
    // Do not log malformed JSON or unstructured bodies: their credential boundaries are unknown.
    const secrets = new Set<string>(knownSecrets)
    if (contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      for (const [key, value] of new URLSearchParams(text)) collectSecrets({ [key]: value }, secrets)
    }
    return { text: '[non-JSON request body omitted]', secrets: [...secrets].sort((a, b) => b.length - a.length) }
  }
  const secrets = new Set<string>(knownSecrets)
  collectSecrets(value, secrets)
  const orderedSecrets = [...secrets].sort((a, b) => b.length - a.length)
  return { text: JSON.stringify(redactValue(value, orderedSecrets)), secrets: orderedSecrets }
}

/**
 * 全局日志中间件 — 凭据脱敏后打印请求方法/路径/状态/耗时/请求体
 */
export const requestLogger: MiddlewareHandler = async (c, next) => {
  const method = c.req.method
  const rawPath = c.req.path
  const start = performance.now()
  const headerSecrets = new Set<string>()
  for (const [key, value] of c.req.raw.headers) {
    if (isCredentialKey(key)) collectSecrets(value, headerSecrets, true)
  }
  requestSecrets.set(c.req.raw, [...headerSecrets].sort((a, b) => b.length - a.length))

  // 打印请求
  const time = formatTime()
  let bodyInfo = ''
  // 上传文件不克隆/读取请求体：避免记录音频内容，也让路由的大小限制先执行。
  const isFileUpload = c.req.header('content-type')?.toLowerCase().startsWith('multipart/form-data')
  if (!isFileUpload && ['POST', 'PUT', 'PATCH'].includes(method)) {
    try {
      const clone = c.req.raw.clone()
      const text = await clone.text()
      if (text) {
        const safe = redactBody(text, c.req.header('content-type') || '', requestSecrets.get(c.req.raw))
        requestSecrets.set(c.req.raw, safe.secrets)
        // Always redact the complete body before truncation, including secrets declared after byte 500.
        const truncated = safe.text.length > 500 ? safe.text.slice(0, 500) + '...' : safe.text
        bodyInfo = `\n  ${colors.dim}body: ${truncated}${colors.reset}`
      }
    } catch {}
  }

  const path = redactText(rawPath, requestSecrets.get(c.req.raw))
  console.log(`${colors.dim}${time}${colors.reset} ${colors.cyan}${method}${colors.reset} ${path}${bodyInfo}`)

  await next()

  const ms = (performance.now() - start).toFixed(0)
  const status = c.res.status
  const sc = statusColor(status)
  console.log(`${colors.dim}${time}${colors.reset} ${colors.cyan}${method}${colors.reset} ${path} ${sc}${status}${colors.reset} ${colors.dim}${ms}ms${colors.reset}`)
}

function handleHttpError(err: any, c: Context) {
  const status = err.status || 500
  const secrets = requestSecrets.get(c.req.raw)
  console.error(`${colors.red}[ERROR]${colors.reset} ${c.req.method} ${redactText(c.req.path, secrets)}`)
  console.error(redactText(err.stack || err.message || err, secrets))
  return c.json({ code: status, message: redactText(err.message || 'Internal Server Error', secrets) }, status)
}

/** Register with app.onError: Hono handles route errors before middleware try/catch. */
export const httpErrorHandler: ErrorHandler = (err, c) => handleHttpError(err, c)

/** Compatibility middleware for errors thrown outside Hono's route dispatch. */
export const errorHandler: MiddlewareHandler = async (c, next) => {
  try { await next() }
  catch (err: any) { return handleHttpError(err, c) }
}
