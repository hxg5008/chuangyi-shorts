import { reactive } from 'vue'

export interface PlatformUser { id: number; username: string; displayName?: string; role: 'admin' | 'user'; enabled?: boolean }
export const platformSession = reactive({ user: null as PlatformUser | null, csrfToken: '', loaded: false, loading: false, revision: 0 })
let pending: Promise<PlatformUser | null> | null = null

export function applyPlatformSession(value: any) {
  const user = value?.user || (typeof value?.id === 'number' ? value : null)
  const changed = platformSession.user?.id !== user?.id
  platformSession.user = user
  platformSession.csrfToken = typeof value?.csrfToken === 'string' ? value.csrfToken : typeof value?.csrf_token === 'string' ? value.csrf_token : ''
  platformSession.loaded = true
  if (changed) {
    platformSession.revision++
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('platform-identity-changed'))
  }
  return platformSession.user
}

export function projectRequestId() {
  if (typeof window === 'undefined') return null
  const match = /^\/drama\/(\d+)(?:\/|$)/u.exec(window.location.pathname)
  return match ? match[1] : null
}

export function platformHeaders(method = 'GET', json = false): Record<string, string> {
  const headers: Record<string, string> = json ? { 'Content-Type': 'application/json' } : {}
  if (!['GET', 'HEAD'].includes(method.toUpperCase()) && platformSession.csrfToken) headers['X-CSRF-Token'] = platformSession.csrfToken
  const project = projectRequestId()
  if (project) headers['X-Project-ID'] = project
  return headers
}

async function authRequest(path: string, body?: any) {
  const response = await fetch('/api/v1/auth' + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: platformHeaders(body === undefined ? 'GET' : 'POST', body !== undefined), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const value = await response.json().catch(() => ({}))
  if (!response.ok || value.code >= 400) throw Object.assign(new Error(value.message || value.error?.message || '账号请求失败，请稍后重试。'), { status: response.status })
  return Object.hasOwn(value, 'data') ? value.data : value
}

export function loadPlatformSession(force = false): Promise<PlatformUser | null> {
  if (pending) return pending
  if (platformSession.loaded && !force) return Promise.resolve(platformSession.user)
  platformSession.loading = true
  pending = authRequest('/me').then(applyPlatformSession).catch(error => {
    if (error.status === 401) return applyPlatformSession(null)
    throw error
  }).finally(() => { pending = null; platformSession.loading = false })
  return pending
}

export async function loginPlatform(username: string, password: string) {
  return applyPlatformSession(await authRequest('/login', { username, password }))
}

export async function registerPlatform(username: string, password: string, displayName?: string) {
  return applyPlatformSession(await authRequest('/register', { username: username.trim(), password, ...(displayName ? { display_name: displayName } : {}) }))
}

export async function logoutPlatform() {
  await authRequest('/logout', {})
  applyPlatformSession(null)
}

export async function changePlatformPassword(currentPassword: string, newPassword: string) {
  const value = await authRequest('/change-password', { current_password: currentPassword, new_password: newPassword })
  if (value?.user) applyPlatformSession(value)
  else if (value?.csrfToken) platformSession.csrfToken = value.csrfToken
  else await loadPlatformSession(true)
}

export function expirePlatformSession() {
  applyPlatformSession(null)
  if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
    const next = window.location.pathname + window.location.search
    window.location.assign('/login?next=' + encodeURIComponent(next))
  }
}

export function safeNextPath(value: unknown) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\\\x00-\x1f]/u.test(value) && !/^\/(?:login|register)(?:[/?#]|$)/u.test(value) ? value : '/'
}

/** Project preferences are scoped by the authenticated user; legacy shared keys are never read. */
export const userStorage = {
  getItem(key: string) { try { return localStorage.getItem(`huobao:user:${platformSession.user?.id ?? 'guest'}:${key}`) } catch { return null } },
  setItem(key: string, value: string) { try { localStorage.setItem(`huobao:user:${platformSession.user?.id ?? 'guest'}:${key}`, value) } catch {} },
  removeItem(key: string) { try { localStorage.removeItem(`huobao:user:${platformSession.user?.id ?? 'guest'}:${key}`) } catch {} },
}
