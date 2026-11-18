import { Agent, EnvHttpProxyAgent, type Dispatcher } from 'undici'

interface ProviderHttpOptions {
  connectTimeoutMs?: number
  headersTimeoutMs?: number
  bodyTimeoutMs?: number
  connections?: number
  proxyUrl?: string | null
  kind?: 'text'|'image'|'video'|'unknown'
}
export interface ProviderHttpObservation { input: RequestInfo|URL; init?: RequestInit; kind?: 'text'|'image'|'video'|'unknown' }
let requestObserver: ((input:ProviderHttpObservation,next:()=>Promise<Response>)=>Promise<Response>) | undefined
export function setProviderHttpObserver(observer:typeof requestObserver){requestObserver=observer}
export function observeProviderFetch(input:ProviderHttpObservation,next:()=>Promise<Response>){return requestObserver?requestObserver(input,next):next()}

function envMilliseconds(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= 1_000 && value <= 1_800_000 ? Math.round(value) : fallback
}

/** Explicit transport budgets for long image/video requests; caller signals still bound total time. */
export function createProviderHttp(options: ProviderHttpOptions = {}) {
  const connectTimeout = options.connectTimeoutMs ?? envMilliseconds('HUOBAO_CONNECT_TIMEOUT_MS', 45_000)
  const headersTimeout = options.headersTimeoutMs ?? envMilliseconds('HUOBAO_RESPONSE_TIMEOUT_MS', 600_000)
  const bodyTimeout = options.bodyTimeoutMs ?? headersTimeout

  const agentOptions = {
    connect: { timeout: connectTimeout },
    headersTimeout,
    bodyTimeout,
    connections: options.connections ?? 4,
    pipelining: 1,
  }
  const configuredProxy = options.proxyUrl === undefined ? process.env.HUOBAO_PROXY_URL : options.proxyUrl
  const direct = configuredProxy === null || configuredProxy?.toLowerCase() === 'direct'
  if (configuredProxy && !direct && !['http:', 'https:'].includes(new URL(configuredProxy).protocol)) {
    throw new Error('HUOBAO_PROXY_URL must be an HTTP(S) proxy or direct')
  }
  const transport = direct ? new Agent(agentOptions) : new EnvHttpProxyAgent({
    ...agentOptions,
    requestTls: { timeout: connectTimeout },
    proxyTls: { timeout: connectTimeout },
    httpProxy: configuredProxy || undefined,
    httpsProxy: configuredProxy || undefined,
    noProxy: ['localhost', '127.0.0.1', '::1', '[::1]', process.env.NO_PROXY || process.env.no_proxy || ''].filter(Boolean).join(','),
  })
  const dispatcher = {
    dispatch(request: Agent.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
      // Applying these at dispatch also covers fetch implementations supplying their own defaults.
      return transport.dispatch({ ...request, headersTimeout, bodyTimeout }, handler)
    },
  }

  const fetchRequest: typeof globalThis.fetch = (input, init) => observeProviderFetch({input,init,kind:options.kind},()=>globalThis.fetch(input, {
    ...init,
    dispatcher,
  } as RequestInit))

  return { fetch: fetchRequest, close: () => transport.close(), destroy: () => transport.destroy() }
}

const providerHttp = createProviderHttp()
// Image submissions can be synchronous. A socket cap must not become an invisible generation queue.
// The locked Undici Pool treats zero as an unbounded pool; media downloads keep their own limiter.
const imageProviderHttp = createProviderHttp({ connections: 0, kind:'image' })
// Text preparation can have many independent asset jobs. Do not hold unrelated
// jobs behind a hidden per-origin four-socket cap; upstream services retain
// their own explicit shared-account scheduling and limits.
const textProviderHttp = createProviderHttp({ connections: 0, kind:'text' })

// Keep the native fetch/FormData/Response implementations together. Do not replace global fetch,
// change TLS verification, or retry billable POST requests.
export const fetchProvider: typeof globalThis.fetch = providerHttp.fetch
export const fetchImageProvider: typeof globalThis.fetch = imageProviderHttp.fetch
export const fetchTextProvider: typeof globalThis.fetch = textProviderHttp.fetch
