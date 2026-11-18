import { expirePlatformSession, platformHeaders, platformSession } from '~/utils/platform-session'
import { requestFilterParams } from '~/utils/request-logs.js'

const BASE = '/api/v1/admin/requests'
async function read(path: string, signal?: AbortSignal) {
  const revision = platformSession.revision
  const response = await fetch(path, { credentials: 'same-origin', headers: platformHeaders('GET', false), signal })
  let body: any
  try { body = await response.json() } catch { throw Error('请求日志返回格式不正确，请稍后重试。') }
  if (revision !== platformSession.revision) throw Error('登录身份已变化，已忽略旧请求。')
  if (!response.ok || body.code >= 400) {
    if (response.status === 401) expirePlatformSession()
    throw Object.assign(Error(body.message || `读取请求日志失败（HTTP ${response.status}）。`), { status:response.status })
  }
  return Object.prototype.hasOwnProperty.call(body, 'data') ? body.data : body
}
const logId = (value: string) => {
  if (!value || value.length > 200 || !/^[A-Za-z0-9_.:-]+$/.test(value)) throw Error('请求日志编号无效。')
  return encodeURIComponent(value)
}
export const requestLogAPI = {
  list: (filters: Record<string, any>, signal?: AbortSignal) => read(BASE + '?' + requestFilterParams(filters), signal),
  detail: (id: string, signal?: AbortSignal) => read(BASE + '/' + logId(id), signal),
  exportUrl: (filters: Record<string, any>) => {
    const params = requestFilterParams(filters)
    params.delete('limit'); params.delete('offset')
    return BASE + '/export?' + params
  },
  detailExportUrl: (id: string) => BASE + '/' + logId(id) + '/export',
}
export async function downloadRequestLog(url: string, fallbackName: string) {
  if (!url.startsWith(BASE + '/') || url.startsWith('//')) throw Error('下载地址无效。')
  const revision = platformSession.revision
  const response = await fetch(url, { credentials: 'same-origin', headers: platformHeaders('GET', false) })
  if (!response.ok) {
    let message = '日志导出失败，请稍后重试。'
    try { message = (await response.json()).message || message } catch {}
    if (response.status === 401) expirePlatformSession()
    throw Error(message)
  }
  if (revision !== platformSession.revision) throw Error('登录身份已变化，已取消下载。')
  const blob = await response.blob()
  if (revision !== platformSession.revision) throw Error('登录身份已变化，已取消下载。')
  const link = document.createElement('a'), objectUrl = URL.createObjectURL(blob)
  link.href = objectUrl; link.download = fallbackName; document.body.append(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
}
