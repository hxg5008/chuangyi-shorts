/** Trusted project routing for the separately deployed execution platform.
 * No prompt/Skill changes. Master credentials stay in the channel store; project
 * credentials are encrypted here and never returned to browser clients. */
import fs from 'node:fs'
import path from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { DATA_ROOT } from '../utils/paths.js'
import { fetchProvider } from '../utils/http.js'
import { registerRuntimeSecrets } from '../utils/secret-redaction.js'
import { assertProjectAccess, currentActor, requireAdmin, requireActor, actorForProject, listUsers } from './platform-security/index.js'
import { getConfigById } from './ai.js'
import { normalizeJimengBaseUrl } from './adapters/jimeng-local-video.js'
import type { AIConfig } from './adapters/types.js'
import { ensureExecutionRoutingSchema } from './execution-routing-schema.js'
import { logTaskWarn } from '../utils/task-logger.js'

type RouteRow = { id: number; drama_id: number; owner_id: number; server_origin: string; account_id: string; canvas_id: string | null; remote_route_id: string | null; key_blob: string | null; canvas_request_id: string; state: string; updated_at: string; version: number; is_current: number; remote_project_id: string | null; selection_mode: string; requested_canvas_name: string | null; adopt_legacy: number }
type AccountPolicy = { account_id: string; enabled: boolean; access: 'all' | 'selected'; user_ids: number[]; allow_create: boolean; canvas_grants: { canvas_id: string; user_ids: number[] }[] }
type SafeAccount = { id: string; name: string; state: string; projects: { id: string; name: string }[] }
const sql = db.$client
const pending = new Map<string, Promise<AIConfig>>()
const managementPending = new Set<string>()
const canvasQueues = new Map<string, Promise<unknown>>()
/** Native account management is serialized; this lane covers only canvas
 * creation, never video submission, rendering, polling or downloads. */
async function createProjectCanvas(config: AIConfig, accountId: string, body: unknown) {
  const lane = `${origin(config)}|${accountId}`
  const previous = canvasQueues.get(lane) || Promise.resolve()
  const next = previous.catch(() => {}).then(() => call(config, `/hub/jimeng/accounts/${encodeURIComponent(accountId)}/canvases`, body))
  canvasQueues.set(lane, next)
  try { return await next } finally { if (canvasQueues.get(lane) === next) canvasQueues.delete(lane) }
}
const stamp = () => new Date().toISOString()
const issue = (message: string, status = 400) => Object.assign(new Error(message), { status })
let initialized = false, encryptionKey: Buffer, namespace = ''
function init() {
  if (initialized) return
  ensureExecutionRoutingSchema(sql)
  sql.prepare('INSERT OR IGNORE INTO platform_execution_identity VALUES(1,?)').run(randomUUID())
  namespace = (sql.prepare('SELECT value FROM platform_execution_identity WHERE id=1').get() as any).value
  fs.mkdirSync(DATA_ROOT, { recursive: true })
  const file = path.join(DATA_ROOT, 'execution-routing-key.bin')
  if (!fs.existsSync(file) && sql.prepare('SELECT 1 FROM platform_jimeng_project_routes WHERE key_blob IS NOT NULL LIMIT 1').get()) throw issue('项目访问凭据的加密文件缺失，请从同一数据备份恢复；未生成替代密钥。', 409)
  try { fs.writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 }) } catch (error: any) { if (error.code !== 'EEXIST') throw error }
  encryptionKey = fs.readFileSync(file)
  if (encryptionKey.length !== 32) throw issue('执行平台项目密钥文件损坏，未覆盖原文件。', 500)
  initialized = true
}
function seal(value: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
  const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), bytes].map(part => part.toString('base64url')).join('.')
}
function unseal(value: string) {
  const parts = value.split('.').map(part => Buffer.from(part, 'base64url'))
  if (parts.length !== 3 || parts[0].length !== 12 || parts[1].length !== 16) throw issue('项目访问密钥数据损坏，请管理员检查备份。', 500)
  const cipher = createDecipheriv('aes-256-gcm', encryptionKey, parts[0]); cipher.setAuthTag(parts[1])
  const key = Buffer.concat([cipher.update(parts[2]), cipher.final()]).toString('utf8')
  registerRuntimeSecrets([key]); return key
}
function origin(config: AIConfig) { return new URL(normalizeJimengBaseUrl(config.baseUrl)).origin }
async function call(config: AIConfig, suffix: string, body?: unknown) {
  registerRuntimeSecrets([config.apiKey])
  const response = await fetchProvider(origin(config) + suffix, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(suffix.endsWith('/rename') ? 180_000 : suffix.includes('/canvases') ? 100_000 : 30_000) })
  const text = await response.text()
  if (Buffer.byteLength(text) > 2_000_000) throw issue('执行平台响应超过保护上限。', 502)
  let data: any; try { data = JSON.parse(text) } catch { throw issue('执行平台返回的内容不是 JSON，请检查服务地址。', 502) }
  if(!response.ok&&data?.error?.code==='canvas_has_unsettled_legacy_tasks')throw Object.assign(issue('原画布还有旧任务正在准备或提交，请完成后再选择；也可以改用其他画布。',409),{code:'canvas_has_unsettled_legacy_tasks'})
  if (!response.ok) throw issue(`执行平台操作未完成（HTTP ${response.status}）。原任务和项目绑定保留，请在执行平台核对后继续。`, response.status === 401 || response.status === 403 ? 403 : 502)
  return data
}
async function configFor(id: number) {
  const config = await getConfigById(id)
  if (!config || config.provider !== 'jimeng_local') throw issue('请选择已启用的即梦本地协议视频模型。')
  return config
}
async function checkCapabilities(config: AIConfig) {
  const health = await call(config, '/health')
  if (!health.capabilities?.project_routes || !health.capabilities?.scoped_canvas_library || !health.capabilities?.scoped_downloads || !health.capabilities?.canvas_create_idempotent)
    throw issue('当前执行平台尚不支持完整项目隔离与成片回传，请先更新到本次配套的一体平台版本。', 409)
  return health
}
async function userRoutingCapabilities(config: AIConfig) {
  const health = await checkCapabilities(config)
  if (!health.capabilities?.canvas_assignment_status) throw issue('此执行平台还不支持用户选画布，请更新配套平台后重试；原项目与任务保留。',409)
  return health
}
async function canvasAvailability(config: AIConfig, accountId: string) {
  const value = await call(config, `/hub/jimeng/accounts/${encodeURIComponent(accountId)}/canvases`)
  if (value.account_id !== accountId || !Array.isArray(value.canvases)) throw issue('执行平台未返回可核对的画布归属，请刷新账号。',502)
  return value.canvases.filter((canvas:any) => typeof canvas?.id === 'string' && /^\d{1,30}$/u.test(canvas.id) && ['available','route_bound','legacy_history'].includes(canvas.availability)).map((canvas:any) => ({ id:canvas.id,name:String(canvas.name || canvas.id).slice(0,200),availability:canvas.availability,...(typeof canvas.route_id === 'string'?{route_id:canvas.route_id}:{}) })) as {id:string;name:string;availability:string;route_id?:string}[]
}
async function accountsFor(config: AIConfig): Promise<SafeAccount[]> {
  await checkCapabilities(config)
  const result = await call(config, '/hub/jimeng/accounts')
  return (Array.isArray(result.accounts) ? result.accounts : Array.isArray(result) ? result : []).filter((a: any) => typeof a?.id === 'string').map((account: any) => ({ id: account.id, name: String(account.name || account.profile?.display_name || account.id), state: String(account.state || 'unchecked'),
    projects: Array.isArray(account.projects) ? account.projects.filter((p: any) => /^\d{1,30}$/u.test(String(p?.id))).map((p: any) => ({ id: String(p.id), name: String(p.name || p.id) })) : [] }))
}
export async function executionServiceAccounts(configId: number) {
  requireAdmin(); return { accounts: await accountsFor(await configFor(configId)) }
}
export function executionServiceSettings(configId: number) {
  requireAdmin(); init(); return sql.prepare('SELECT config_id,account_id,enabled,updated_at FROM platform_execution_services WHERE config_id=?').get(configId) || null
}
export async function saveExecutionService(configId: number, input: any) {
  requireAdmin(); init()
  if (Object.keys(input || {}).some(key => !['account_id', 'enabled'].includes(key)) || typeof input?.account_id !== 'string' || !/^[A-Za-z0-9_-]{1,150}$/u.test(input.account_id) || typeof input.enabled !== 'boolean') throw issue('执行平台连接设置格式错误。')
  if (input.enabled) {
    const { accounts } = await executionServiceAccounts(configId)
    const account = accounts.find((entry: any) => entry.id === input.account_id)
    if (!account || !['ready', 'choose_canvas'].includes(account.state)) throw issue('请先在执行平台检查并登录这个账号。', 409)
  }
  sql.prepare('INSERT INTO platform_execution_services VALUES(?,?,?,?) ON CONFLICT(config_id) DO UPDATE SET account_id=excluded.account_id,enabled=excluded.enabled,updated_at=excluded.updated_at')
    .run(configId, input.account_id, input.enabled ? 1 : 0, stamp())
  return executionServiceSettings(configId)
}
function policiesFor(config: AIConfig): AccountPolicy[] {
  return (sql.prepare('SELECT * FROM platform_execution_account_policies WHERE server_origin=?').all(origin(config)) as any[]).map(row => ({ account_id: row.account_id, enabled: !!row.enabled, access: row.access, user_ids: JSON.parse(row.user_ids_json), allow_create: !!row.allow_create, canvas_grants: JSON.parse(row.canvas_grants_json) }))
}
function policyFor(config: AIConfig, accountId: string, drama?: any): AccountPolicy | undefined {
  const feature=featurePolicy(config)
  if(feature)return{account_id:accountId,enabled:true,access:feature.access,user_ids:feature.user_ids,allow_create:true,canvas_grants:[]}
  const policies = policiesFor(config)
  if (policies.length) return policies.find(policy => policy.account_id === accountId)
  const setting = sql.prepare('SELECT account_id FROM platform_execution_services WHERE config_id=?').get(config.id!) as any
  // Existing projects retain their original account when the old global default
  // changes. Explicit per-user policies replace this compatibility fallback.
  const owned = drama && sql.prepare('SELECT 1 FROM platform_jimeng_project_routes WHERE drama_id=? AND owner_id=? AND server_origin=? AND account_id=?').get(drama.id, drama.ownerUserId, origin(config), accountId)
  return setting?.account_id === accountId || owned ? { account_id: accountId, enabled: true, access: 'all', user_ids: [], allow_create: true, canvas_grants: [] } : undefined
}
function permits(policy: AccountPolicy | undefined, ownerId: number) { return !!policy?.enabled && (policy.access === 'all' || policy.user_ids.includes(ownerId)) }
function featurePolicy(config: AIConfig): {access:'all'|'selected';user_ids:number[]}|null {
  const row = sql.prepare("SELECT access,user_ids_json FROM platform_execution_user_access WHERE server_origin='*'").get() as any
  return row ? { access:row.access, user_ids:JSON.parse(row.user_ids_json) } : null
}
function featurePermitted(config: AIConfig, ownerId: number) {
  const policy=featurePolicy(config)
  return !policy || policy.access==='all' || policy.user_ids.includes(ownerId)
}
function assertFeature(config: AIConfig, ownerId: number) {
  if(!featurePermitted(config,ownerId))throw issue('此用户尚未获准使用即梦视频，请管理员开启即梦功能权限。',403)
}
export async function executionUserAccess(configId:number) {
  requireAdmin();init();const config=await configFor(configId),policy=featurePolicy(config)
  return {access:policy?.access||'legacy',user_ids:policy?.user_ids||[],users:listUsers().map((user:any)=>({id:user.id,username:user.username,display_name:user.displayName||user.display_name||user.username,role:user.role,enabled:user.isActive??user.enabled??true}))}
}
export async function saveExecutionUserAccess(configId:number,input:any) {
  requireAdmin();init();const config=await configFor(configId),users=new Set(listUsers().map(user=>user.id))
  if(!input||Object.keys(input).some(key=>!['access','user_ids'].includes(key))||!['all','selected'].includes(input.access)||!Array.isArray(input.user_ids)||input.user_ids.length>10000||input.user_ids.some((id:any)=>!Number.isSafeInteger(id)||!users.has(id)))throw issue('请提交有效的即梦功能使用权限。')
  sql.prepare('INSERT INTO platform_execution_user_access VALUES(?,?,?,?) ON CONFLICT(server_origin) DO UPDATE SET access=excluded.access,user_ids_json=excluded.user_ids_json,updated_at=excluded.updated_at').run('*',input.access,JSON.stringify([...new Set(input.user_ids)]),stamp())
  return {...await executionUserAccess(configId),saved:true}
}
function canvasName(value:unknown) {
  if(typeof value!=='string'||!value.trim()||[...value.trim()].length>50||/[\x00-\x1f\x7f]/u.test(value)||[...value].some(char=>char.length===1&&char.charCodeAt(0)>=0xd800&&char.charCodeAt(0)<=0xdfff))throw issue('画布名称需为1–50个字符，不能包含控制字符。')
  return value.trim()
}
function assertAccountPermission(config: AIConfig, accountId: string, drama: any) {
  assertFeature(config,drama.ownerUserId!)
  const policy = policyFor(config, accountId, drama)
  if (!permits(policy, drama.ownerUserId!)) throw issue('该项目用户尚未获准使用此即梦账号，请管理员分配账号权限。', 403)
  return policy!
}
export async function executionAccountPolicies(configId: number) {
  requireAdmin(); init(); const config = await configFor(configId), accounts = await accountsFor(config), stored = policiesFor(config)
  return { policies: stored.length ? stored.filter(policy => policy.account_id !== '__deny_all__') : accounts.map(account => policyFor(config, account.id)).filter(Boolean), accounts, legacy_defaults: !stored.length }
}
export async function saveExecutionAccountPolicies(configId: number, input: any) {
  requireAdmin(); init(); const config = await configFor(configId)
  if (!input || Object.keys(input).some(key => key !== 'policies') || !Array.isArray(input.policies) || input.policies.length > 100) throw issue('请提交有效的账号授权列表。')
  const accounts = await accountsFor(config), accountMap = new Map(accounts.map(account => [account.id, account])), users = new Set(listUsers().map(user => user.id)), seen = new Set<string>()
  const userIds = (value: any) => { if (!Array.isArray(value) || value.length > 10000 || value.some((id: any) => !Number.isSafeInteger(id) || !users.has(id))) throw issue('账号授权包含无效用户。'); return [...new Set<number>(value)] }
  const policies: AccountPolicy[] = input.policies.map((entry: any) => {
    if (!entry || Object.keys(entry).some(key => !['account_id','enabled','access','user_ids','allow_create','canvas_grants'].includes(key)) || !accountMap.has(entry.account_id) || seen.has(entry.account_id) || !['all','selected'].includes(entry.access) || typeof entry.enabled !== 'boolean' || typeof entry.allow_create !== 'boolean' || !Array.isArray(entry.canvas_grants)) throw issue('账号授权格式错误或账号重复。')
    seen.add(entry.account_id)
    const canvases = new Set(accountMap.get(entry.account_id)!.projects.map(canvas => canvas.id)), granted = new Set<string>()
    const grants = entry.canvas_grants.map((grant: any) => { if (!grant || Object.keys(grant).some(key => !['canvas_id','user_ids'].includes(key)) || !canvases.has(grant.canvas_id) || granted.has(grant.canvas_id)) throw issue('已有画布授权包含无效或重复画布。'); granted.add(grant.canvas_id); return { canvas_id: grant.canvas_id, user_ids: userIds(grant.user_ids) } })
    return { account_id: entry.account_id, enabled: entry.enabled, access: entry.access, user_ids: userIds(entry.user_ids), allow_create: entry.allow_create, canvas_grants: grants }
  })
  // An explicit empty list means deny all, rather than falling back to a legacy
  // default; retain a disabled sentinel to distinguish these two states.
  sql.transaction(() => {
    sql.prepare('DELETE FROM platform_execution_account_policies WHERE server_origin=?').run(origin(config))
    const insert = sql.prepare('INSERT INTO platform_execution_account_policies VALUES(?,?,?,?,?,?,?,?)')
    for (const policy of policies) insert.run(origin(config), policy.account_id, Number(policy.enabled), policy.access, JSON.stringify(policy.user_ids), Number(policy.allow_create), JSON.stringify(policy.canvas_grants), stamp())
    if (!policies.length) insert.run(origin(config), '__deny_all__', 0, 'selected', '[]', 0, '[]', stamp())
  }).immediate()
  return { policies, saved: true, legacy_defaults: false }
}
function project(id: number) {
  if (currentActor()) assertProjectAccess(id)
  else actorForProject(id)
  const row = db.select().from(schema.dramas).where(eq(schema.dramas.id, id)).get()
  if (!row || row.deletedAt) throw issue('项目不存在。', 404)
  return row
}
const rowFor = (dramaId: number, server: string) => sql.prepare('SELECT * FROM platform_jimeng_project_routes WHERE drama_id=? AND server_origin=? AND is_current=1').get(dramaId, server) as RouteRow | undefined
const pendingFor = (dramaId: number, server: string) => sql.prepare("SELECT * FROM platform_jimeng_project_routes WHERE drama_id=? AND server_origin=? AND state='preparing' ORDER BY version DESC LIMIT 1").get(dramaId, server) as RouteRow | undefined
const remoteProject = (row: RouteRow) => row.remote_project_id || `project:${row.drama_id}`
function remoteRouteProblem(row: RouteRow, remote: any, ownerId: number): string | null {
  if (!remote || !/^rt_[a-f0-9]{32}$/u.test(remote.id || '') || row.remote_route_id && remote.id !== row.remote_route_id || remote.owner_id !== `cy-${namespace}:user:${ownerId}` || remote.project_id !== remoteProject(row) || remote.account_id !== row.account_id || row.canvas_id && remote.canvas_id !== row.canvas_id)
    return '原项目绑定不存在或归属不一致，请重新选择项目账号与画布。'
  if (remote.deleted_at != null) return '原项目画布绑定已删除，请重新选择账号并建立新的项目绑定；旧任务仍可查询和下载。'
  if (remote.enabled !== true) return '原项目画布绑定已停用，请启用原绑定或选择新的项目画布。'
  return null
}
async function remoteRoutes(config: AIConfig, knownHealth?: any): Promise<any[]> {
  const health = knownHealth || await checkCapabilities(config)
  const suffix = health.capabilities?.route_soft_delete ? '?include_deleted=true' : ''
  const value = await call(config, '/hub/jimeng/routes' + suffix)
  if (!Array.isArray(value.routes)) throw issue('执行平台未返回可核对的项目绑定列表。', 502)
  return value.routes
}
async function checkedRouted(config: AIConfig, row: RouteRow, ownerId: number) {
  if (!row.remote_route_id) return routed(config,row)
  const remote = await call(config, `/hub/jimeng/routes/${row.remote_route_id}`)
  const problem = remoteRouteProblem(row,remote,ownerId)
  if (problem) throw issue(problem,409)
  return routed(config,row)
}
function routed(config: AIConfig, row: RouteRow) {
  if (row.state !== 'ready' || !row.remote_route_id || !row.key_blob) throw issue('项目执行绑定尚未就绪，请管理员检查该项目画布。', 409)
  return { ...config, apiKey: unseal(row.key_blob), executionRouteId: row.remote_route_id, executionProjectRouteId: row.id } as AIConfig
}
function enabledSetting(config: AIConfig) {
  const setting = sql.prepare('SELECT * FROM platform_execution_services WHERE config_id=?').get(config.id) as any
  if (!setting?.enabled) throw issue('当前视频服务尚未启用项目画布绑定。', 409)
  return setting
}
function createRouteRow(config: AIConfig, drama: any, accountId: string, mode: string, canvasId?: string, name?:string, adoptLegacy=false) {
  return sql.transaction(() => {
    const version = Number((sql.prepare('SELECT COALESCE(MAX(version),0)+1 value FROM platform_jimeng_project_routes WHERE drama_id=? AND server_origin=?').get(drama.id, origin(config)) as any).value)
    const result = sql.prepare("INSERT INTO platform_jimeng_project_routes(drama_id,owner_id,server_origin,account_id,canvas_id,canvas_request_id,state,updated_at,version,is_current,selection_mode) VALUES(?,?,?,?,?,?,'preparing',?,?,0,?)")
      .run(drama.id, drama.ownerUserId, origin(config), accountId, canvasId || null, randomUUID(), stamp(), version, mode)
    const id = Number(result.lastInsertRowid), remote = version === 1 ? `project:${drama.id}` : `project:${drama.id}:binding:${id}`
    sql.prepare('UPDATE platform_jimeng_project_routes SET remote_project_id=?,requested_canvas_name=?,adopt_legacy=? WHERE id=?').run(remote, name||null, Number(adoptLegacy), id)
    return sql.prepare('SELECT * FROM platform_jimeng_project_routes WHERE id=?').get(id) as RouteRow
  }).immediate()
}
function activate(row: RouteRow, expectedId: number | null) {
  sql.transaction(() => {
    const current = rowFor(row.drama_id, row.server_origin)
    if ((current?.id ?? null) !== expectedId && current?.id !== row.id) throw issue('项目绑定已在另一个页面更新，请刷新后再选择。', 409)
    sql.prepare('UPDATE platform_jimeng_project_routes SET is_current=0 WHERE drama_id=? AND server_origin=?').run(row.drama_id, row.server_origin)
    sql.prepare('UPDATE platform_jimeng_project_routes SET is_current=1,updated_at=? WHERE id=?').run(stamp(), row.id)
  }).immediate()
}
function releaseConflictingReservation(config:AIConfig,row:RouteRow,remotes:any[]) {
  if(row.selection_mode!=='existing'||!row.canvas_id)return false
  const foreign=remotes.some(remote=>/^rt_[a-f0-9]{32}$/u.test(remote.id||'')&&remote.account_id===row.account_id&&remote.canvas_id===row.canvas_id&&(remote.owner_id!==`cy-${namespace}:user:${row.owner_id}`||remote.project_id!==remoteProject(row)))
  if(!foreign)return false
  return releaseUncreatedReservation(row,'reservation-conflict')
}
function releaseUncreatedReservation(row:RouteRow,reason:string) {
  if(row.selection_mode!=='existing')return false
  return sql.transaction(()=>{
    const current=sql.prepare('SELECT * FROM platform_jimeng_project_routes WHERE id=?').get(row.id) as RouteRow|undefined
    if(!current||current.state!=='preparing'||current.is_current||current.remote_route_id||current.key_blob)return false
    const referenced=sql.prepare("SELECT 1 FROM sys_task WHERE CASE WHEN json_valid(params) THEN json_extract(params,'$.jimengProjectRoute.id') END=? LIMIT 1").get(row.id)
    if(referenced)return false
    sql.prepare('DELETE FROM platform_jimeng_project_routes WHERE id=?').run(row.id)
    logTaskWarn('ExecutionCanvas',reason,{projectId:row.drama_id,reservationId:row.id,canvasId:row.canvas_id})
    return true
  }).immediate()
}
async function completeRoute(config: AIConfig, drama: any, row: RouteRow, expectedId: number | null): Promise<AIConfig> {
  const owner = `cy-${namespace}:user:${drama.ownerUserId}`, projectKey = remoteProject(row)
  const listed = await remoteRoutes(config)
  let remote = listed.find((entry: any) => entry.owner_id === owner && entry.project_id === projectKey)
  if (remote && remote.account_id !== row.account_id) throw issue('执行平台已存在不同账号的项目绑定，未自动替换。', 409)
  if (remote?.deleted_at != null) throw issue('原项目画布绑定已删除，未重新创建或恢复原绑定；请选择新的项目绑定。',409)
  if (remote && remote.enabled !== true) throw issue('原项目画布绑定已停用，未自动启用或替换。',409)
  if (!remote) {
    let canvas = row.canvas_id
    if (!canvas) {
      const created = await createProjectCanvas(config, row.account_id, { name: row.requested_canvas_name||`CY-P${drama.id}-V${row.version}`, select: false, client_request_id: row.canvas_request_id })
      if (typeof created.id !== 'string' || !/^\d{1,30}$/u.test(created.id) || created.account_id !== row.account_id || created.selected !== false) throw issue('执行平台没有返回可确认的项目画布；保留创建凭据，未重新创建。', 502)
      canvas = created.id
      sql.prepare('UPDATE platform_jimeng_project_routes SET canvas_id=?,updated_at=? WHERE id=?').run(canvas, stamp(), row.id)
    }
    const value = { name: Array.from(`${drama.title} · V${row.version}`).slice(0, 80).join(''), owner_id: owner, project_id: projectKey, account_id: row.account_id, canvas_id: canvas, ...(row.adopt_legacy?{adopt_legacy:true}:{}) }
    try { remote = await call(config, '/hub/jimeng/routes', value) }
    catch (error:any) {
      if(error?.code==='canvas_has_unsettled_legacy_tasks'){releaseUncreatedReservation(row,'legacy-submit-pending');throw error}
      // Reconcile only the identity we persisted. This read never submits video.
      const fresh = await remoteRoutes(config)
      remote = fresh.find((entry: any) => entry.owner_id === owner && entry.project_id === projectKey && entry.account_id === row.account_id && entry.canvas_id === canvas)
      if (!remote) {
        if(releaseConflictingReservation(config,row,fresh))throw issue('该画布已由其他项目使用，请刷新并选择其他画布；原项目和任务未改变。',409)
        throw error
      }
    }
  }
  const problem = remoteRouteProblem(row,remote,drama.ownerUserId!)
  if (problem) throw issue(problem,409)
  if(project(drama.id).ownerUserId!==drama.ownerUserId)throw issue('项目归属已变化，未申请新的访问凭据。',409)
  assertAccountPermission(config,row.account_id,drama)
  const minted = await call(config, `/hub/jimeng/routes/${remote.id}/key`, {})
  if (minted.route_id !== remote.id || typeof minted.key !== 'string' || !minted.key.startsWith('sk-cy-route-')) throw issue('未收到项目专属访问凭据。', 502)
  registerRuntimeSecrets([minted.key])
  sql.transaction(() => {
    const currentProject = project(drama.id)
    if (currentProject.ownerUserId !== drama.ownerUserId) throw issue('项目归属已变化，未启用新的执行绑定。',409)
    assertAccountPermission(config, row.account_id, drama)
    sql.prepare("UPDATE platform_jimeng_project_routes SET canvas_id=?,remote_route_id=?,key_blob=?,state='ready',updated_at=? WHERE id=?")
      .run(remote.canvas_id, remote.id, seal(minted.key), stamp(), row.id)
    activate(row, expectedId)
  }).immediate()
  return routed(config, sql.prepare('SELECT * FROM platform_jimeng_project_routes WHERE id=?').get(row.id) as RouteRow)
}
async function provision(config: AIConfig, dramaId: number, manualCanvas?: string): Promise<AIConfig> {
  init(); const drama = project(dramaId), setting = enabledSetting(config), existing = rowFor(dramaId, origin(config))
  if (existing && existing.owner_id !== drama.ownerUserId) throw issue('项目归属已变化，请管理员核对原账号和画布，未自动换号。', 409)
  if (existing?.state === 'ready') return checkedRouted(config, existing, drama.ownerUserId!)
  await checkCapabilities(config)
  const row = pendingFor(dramaId, origin(config)) || createRouteRow(config, drama, setting.account_id, manualCanvas ? 'existing' : 'new', manualCanvas)
  assertAccountPermission(config, row.account_id, drama)
  const value = await completeRoute(config, drama, row, existing?.id ?? null)
  return value
}
export async function resolveJimengProjectConfig(config: AIConfig, dramaId?: number, selectedRouteId?: number): Promise<AIConfig> {
  init()
  // Untouched legacy installations keep their original path. Once an admin
  // configures global feature access, every Jimeng channel must enforce it.
  if(featurePolicy(config)){
    const target=dramaId?project(dramaId):null,actor=currentActor()
    if(target)assertFeature(config,target.ownerUserId!)
    else if(actor)assertFeature(config,requireActor().id)
    else throw issue('缺少即梦使用权限上下文。',403)
  }
  const setting = config.id && sql.prepare('SELECT * FROM platform_execution_services WHERE config_id=?').get(config.id) as any
  if (!setting) { if (selectedRouteId !== undefined||featurePolicy(config)) throw issue('此即梦视频服务尚未连接项目画布，请管理员保存服务连接。',409); return config } // Untouched legacy installations remain usable.
  if (!setting.enabled) throw issue('本视频服务的项目派发已暂停。', 409)
  if (!dramaId) throw issue('项目隔离通道需要从具体项目提交视频，模型试用请使用项目中的分镜。')
  const drama = project(dramaId), existing = rowFor(dramaId, origin(config))
  if (selectedRouteId !== undefined) {
    if (!Number.isSafeInteger(selectedRouteId) || selectedRouteId < 1) throw issue('选择的项目绑定编号无效。')
    const selected = sql.prepare('SELECT * FROM platform_jimeng_project_routes WHERE id=?').get(selectedRouteId) as RouteRow | undefined
    if (!selected || selected.drama_id !== dramaId || selected.owner_id !== drama.ownerUserId || selected.server_origin !== origin(config)) throw issue('所选执行绑定不属于当前项目。', 403)
    assertAccountPermission(config, selected.account_id, drama)
    return checkedRouted(config, selected, drama.ownerUserId!)
  }
  if (existing && existing.owner_id !== drama.ownerUserId) throw issue('项目归属已变化，未自动换号。', 409)
  const key = `${origin(config)}|${dramaId}`
  if (!pending.has(key) && existing?.state === 'ready') { assertAccountPermission(config, existing.account_id, drama); return checkedRouted(config, existing, drama.ownerUserId!) }
  if (!pending.has(key)) {
    if(featurePolicy(config)&&!existing)throw issue('请先在项目中选择已有画布或新建画布，再生成视频。',409)
    pending.set(key, provision(config, dramaId).finally(() => pending.delete(key)))
  }
  const resolved = await pending.get(key)!
  // Share only the durable route, never another caller's chosen model or its
  // request parameters, when two configurations use the same execution host.
  const row = sql.prepare('SELECT * FROM platform_jimeng_project_routes WHERE id=?').get(resolved.executionProjectRouteId!) as RouteRow | undefined
  if (!row || row.drama_id !== dramaId || row.owner_id !== drama.ownerUserId || row.server_origin !== origin(config)) throw issue('项目绑定返回了不一致的路由。',409)
  assertAccountPermission(config, row.account_id, drama)
  return routed(config,row)
}
export function restoreJimengProjectConfig(config: AIConfig, snapshot: any, dramaId?: number) {
  init()
  if (!snapshot) return config
  if (!Number.isSafeInteger(snapshot.id) || !dramaId) throw issue('原任务项目绑定记录无效，未切换到默认画布。', 409)
  const row = sql.prepare('SELECT * FROM platform_jimeng_project_routes WHERE id=?').get(snapshot.id) as RouteRow | undefined
  const drama = project(dramaId)
  if (!row || row.drama_id !== dramaId || row.owner_id !== drama.ownerUserId || row.server_origin !== origin(config) || row.remote_route_id !== snapshot.routeId) throw issue('原任务执行绑定与项目不一致，未改用其他画布。', 409)
  return routed(config, row)
}
export function projectExecutionStatus(dramaId: number) {
  init(); project(dramaId)
  const rows = sql.prepare('SELECT id,state,version,is_current,updated_at FROM platform_jimeng_project_routes WHERE drama_id=? ORDER BY version DESC').all(dramaId)
  return { routes: rows, automatic: true, notice: '项目可选择获准账号和专属画布；未选择时沿用默认绑定。旧任务始终使用提交时的版本。' }
}
function publicRoute(row: RouteRow | undefined) {
  return row ? { id: row.id, version: row.version, account_id: row.account_id, canvas_id: row.canvas_id, state: row.state, mode: row.selection_mode, requested_canvas_name:row.requested_canvas_name, updated_at: row.updated_at } : null
}
function unsubmittedTasks(dramaId: number) {
  return (sql.prepare(`SELECT t.id,t.status,t.stage,t.params FROM sys_task t LEFT JOIN storyboards s ON s.id=t.storyboard_id LEFT JOIN episodes e ON e.id=s.episode_id
    WHERE t.type='video' AND t.provider='jimeng_local' AND t.status IN('pending','processing') AND COALESCE(t.task_id,'')='' AND COALESCE(t.drama_id,e.drama_id)=?`).all(dramaId) as any[]).filter(task=>{
      try{const snapshot=JSON.parse(task.params||'{}').jimengProjectRoute;return !snapshot||!Number.isSafeInteger(snapshot.id)||!sql.prepare('SELECT id FROM platform_jimeng_project_routes WHERE id=? AND drama_id=? AND remote_route_id=?').get(snapshot.id,dramaId,snapshot.routeId)}catch{return true}
    }).map(({params,...task})=>task)
}
function canvasAllowed(config: AIConfig, drama: any, accountId: string, canvasId: string, policy: AccountPolicy, remotes: any[]) {
  const rows = sql.prepare('SELECT * FROM platform_jimeng_project_routes WHERE server_origin=? AND account_id=? AND canvas_id=?').all(origin(config), accountId, canvasId) as RouteRow[]
  if (rows.some(row => row.drama_id !== drama.id || row.owner_id !== drama.ownerUserId)) return false
  const own = rows.some(row => row.drama_id === drama.id && row.owner_id === drama.ownerUserId)
  const owner = `cy-${namespace}:user:${drama.ownerUserId}`
  if (remotes.some(remote => remote.account_id === accountId && remote.canvas_id === canvasId && (remote.deleted_at != null || remote.enabled !== true))) return false
  if (remotes.some(remote => remote.account_id === accountId && remote.canvas_id === canvasId && (!rows.some(row => row.remote_route_id === remote.id || row.state==='preparing'&&remote.project_id===remoteProject(row)) || remote.owner_id !== owner))) return false
  return own || !!featurePolicy(config) || policy.canvas_grants.some(grant => grant.canvas_id === canvasId && grant.user_ids.includes(drama.ownerUserId!))
}
export async function projectExecutionOptions(configId: number, dramaId: number) {
  requireActor(); init(); const drama = project(dramaId), config = await configFor(configId)
  if(!featurePermitted(config,drama.ownerUserId!))return {managed:true,selection_available:true,feature_allowed:false,accounts:[],current:null,pending:null,can_switch:false,blocking_tasks:[],notice:'尚未获得即梦视频使用权限，请联系管理员。'}
  const setting = sql.prepare('SELECT * FROM platform_execution_services WHERE config_id=?').get(configId) as any
  if (!setting) return {managed:false,selection_available:false,legacy:true,accounts:[],current:null,pending:null,can_switch:false,blocking_tasks:[],notice:'当前服务沿用原账号与画布，项目选择由管理员开启。'}
  enabledSetting(config)
  const health = await checkCapabilities(config)
  const existing = rowFor(dramaId,origin(config))
  if (existing && existing.owner_id !== drama.ownerUserId) throw issue('项目归属已变化，请管理员核对原账号和画布。',409)
  if(featurePolicy(config)&&!health.capabilities?.safe_legacy_adoption)return{managed:true,selection_available:false,feature_allowed:true,requires_upgrade:true,accounts:[],current:existing?{...publicRoute(existing),permitted:true}:null,pending:null,can_switch:false,blocking_tasks:[],notice:'请将一体执行平台更新到1.4.1或更新版本后管理画布；已有任务仍按原画布查询。'}
  if (!health.capabilities?.canvas_assignment_status) {
    const ready = existing?.state === 'ready'
    const unavailable = ready ? remoteRouteProblem(existing,await call(config,`/hub/jimeng/routes/${existing.remote_route_id}`),drama.ownerUserId!) : null
    return {managed:ready,selection_available:false,...(ready?{}:{legacy_autobind:true}),requires_upgrade:true,accounts:[],
      current:existing?{...publicRoute(existing),account_name:existing.account_id,canvas_name:existing.canvas_id,permitted:!unavailable&&permits(policyFor(config,existing.account_id,drama),drama.ownerUserId!),...(unavailable?{unavailable_reason:unavailable}:{})}:null,
      pending:null,can_switch:false,blocking_tasks:[],notice:'当前平台可继续使用原项目绑定；选择账号或画布需升级一体平台。'}
  }
  const [accounts, listed] = await Promise.all([accountsFor(config), remoteRoutes(config,health)])
  const current = rowFor(dramaId, origin(config)), waiting = pendingFor(dramaId, origin(config)), blocking = unsubmittedTasks(dramaId)
  const safe = await Promise.all(accounts.filter(account => permits(policyFor(config, account.id, drama), drama.ownerUserId!)).map(async account => {
    const policy = policyFor(config, account.id, drama)!
    const owned = sql.prepare('SELECT * FROM platform_jimeng_project_routes WHERE drama_id=? AND owner_id=? AND server_origin=? AND account_id=?').all(dramaId, drama.ownerUserId, origin(config), account.id) as RouteRow[]
    const available = await canvasAvailability(config, account.id)
    const ownRemote=(canvas:any)=>owned.some(row=>row.canvas_id===canvas.id&&(row.remote_route_id===canvas.route_id||row.state==='preparing'&&listed.some(remote=>remote.id===canvas.route_id&&remote.owner_id===`cy-${namespace}:user:${drama.ownerUserId}`&&remote.project_id===remoteProject(row))))
    const canvases = available.filter(canvas => (canvas.availability === 'available' || canvas.availability==='legacy_history'&&!!featurePolicy(config)&&health.capabilities?.safe_legacy_adoption || canvas.availability === 'route_bound' && ownRemote(canvas)) && canvasAllowed(config, drama, account.id, canvas.id, policy, listed)).map(canvas => ({ id:canvas.id,name:canvas.name, current: current?.account_id === account.id && current.canvas_id === canvas.id, history: owned.some(row => row.canvas_id === canvas.id),history_unassigned:canvas.availability==='legacy_history' }))
    return { id: account.id, name: account.name, state: account.state, allow_create: policy.allow_create, canvases:canvases.map(canvas=>({...canvas,can_rename:!!health.capabilities?.canvas_rename&&owned.some(row=>row.canvas_id===canvas.id&&row.state==='ready')})) }
  }))
  const decorate = (row: RouteRow | undefined) => {
    if (!row) return null
    const unavailable = row.state === 'ready' ? remoteRouteProblem(row,listed.find(remote=>remote.id===row.remote_route_id),drama.ownerUserId!) : null
    return { ...publicRoute(row), account_name: accounts.find(a => a.id === row.account_id)?.name || row.account_id, canvas_name: accounts.find(a => a.id === row.account_id)?.projects.find(c => c.id === row.canvas_id)?.name || row.canvas_id, permitted: !unavailable&&permits(policyFor(config, row.account_id, drama), drama.ownerUserId!),...(unavailable?{unavailable_reason:unavailable}:{}) }
  }
  const defaultId = (sql.prepare('SELECT account_id FROM platform_execution_services WHERE config_id=?').get(configId) as any)?.account_id
  return { managed:true,selection_available:true,feature_allowed:true,accounts: safe, default_account_id: safe.some(account => account.id === defaultId) ? defaultId : null, current: decorate(current), pending: decorate(waiting), can_switch: !blocking.length && !pending.has(`${origin(config)}|${dramaId}`) && !managementPending.has(`${origin(config)}|${dramaId}`), blocking_tasks: blocking }
}
export async function selectProjectExecution(configId: number, dramaId: number, input: any) {
  requireActor(); init(); const drama = project(dramaId), config = await configFor(configId)
  enabledSetting(config)
  if (!input || Object.keys(input).some(key => !['account_id','mode','canvas_id','expected_route_id','canvas_name'].includes(key)) || typeof input.account_id !== 'string' || !['new','existing'].includes(input.mode) || !Object.hasOwn(input,'expected_route_id') || input.expected_route_id !== null && (!Number.isSafeInteger(input.expected_route_id) || input.expected_route_id < 1) || input.mode === 'existing' && (!/^\d{1,30}$/u.test(input.canvas_id || '') || input.canvas_name!==undefined) || input.mode === 'new' && input.canvas_id !== undefined) throw issue('项目账号与画布选择格式错误。')
  const requestedName=input.canvas_name===undefined?undefined:canvasName(input.canvas_name)
  const key = `${origin(config)}|${dramaId}`
  if (pending.has(key)||managementPending.has(key)) throw issue('项目画布正在处理，请等待当前操作完成。', 409)
  const operation = (async () => {
    const current = rowFor(dramaId, origin(config))
    if ((current?.id ?? null) !== input.expected_route_id) throw issue('项目绑定已发生变化，请刷新后再选择。', 409)
    const active = unsubmittedTasks(dramaId)
    if (active.length) throw Object.assign(issue('本项目还有尚未接单的视频任务，请等待提交结束后再切换。',409), { activeTasks: active })
    const health=await userRoutingCapabilities(config)
    if(requestedName!==undefined&&!health.capabilities?.user_canvas_management)throw issue('请先更新一体执行平台，当前版本尚不支持在项目中填写画布名称。',409)
    const policy = assertAccountPermission(config, input.account_id, drama), accounts = await accountsFor(config)
    const account = accounts.find(entry => entry.id === input.account_id)
    if (!account || !['ready','choose_canvas'].includes(account.state)) throw issue('所选即梦账号尚未就绪，请检查账号。', 409)
    if (input.mode === 'new' && !policy.allow_create) throw issue('此账号未开放新建画布权限。',403)
    const existing = input.mode === 'existing' ? sql.prepare("SELECT * FROM platform_jimeng_project_routes WHERE drama_id=? AND owner_id=? AND server_origin=? AND account_id=? AND canvas_id=? AND state='ready' ORDER BY version DESC LIMIT 1").get(dramaId, drama.ownerUserId, origin(config), account.id, input.canvas_id) as RouteRow | undefined : undefined
    const waiting=pendingFor(dramaId,origin(config))
    let adoptLegacy=false
    if (input.mode === 'existing') {
      const [remotes,available] = await Promise.all([remoteRoutes(config),canvasAvailability(config,account.id)])
      const selected = available.find(canvas => canvas.id === input.canvas_id)
      const known=existing||(waiting?.account_id===account.id&&waiting.canvas_id===input.canvas_id&&waiting.selection_mode==='existing'?waiting:undefined)
      const ownsRemote=known&&remotes.some(remote=>remote.id===selected?.route_id&&remote.account_id===account.id&&remote.canvas_id===input.canvas_id&&remote.owner_id===`cy-${namespace}:user:${drama.ownerUserId}`&&remote.project_id===remoteProject(known))
      if (!selected || selected.availability === 'legacy_history' && !featurePolicy(config) || selected.availability === 'route_bound' && !ownsRemote || !canvasAllowed(config, drama, account.id, input.canvas_id, policy, remotes)) throw issue('该画布未授权给本项目，或已由其他项目使用。',403)
      adoptLegacy=selected.availability==='legacy_history'||!!known?.adopt_legacy||!!featurePolicy(config)&&!existing
      if(adoptLegacy&&(!health.capabilities?.legacy_canvas_adoption||!health.capabilities?.safe_legacy_adoption))throw issue('请先更新一体平台，当前版本尚不支持安全使用旧画布。',409)
    }
    let target = existing || waiting
    if (target && target.state !== 'ready' && (target.account_id !== account.id || target.selection_mode !== input.mode || input.mode === 'existing' && target.canvas_id !== input.canvas_id)) throw issue('此前绑定创建结果仍待核对，请先继续原账号与画布的操作。',409)
    if(target&&target.state!=='ready'&&requestedName!==undefined&&target.requested_canvas_name!==requestedName)throw issue('上次创建尚未核实，请先继续原名称的创建结果，不能更换名称重复创建。',409)
    if (!target) target = createRouteRow(config, drama, account.id, input.mode, input.canvas_id,requestedName,adoptLegacy)
    else if(target.state!=='ready'&&adoptLegacy&&!target.adopt_legacy){sql.prepare('UPDATE platform_jimeng_project_routes SET adopt_legacy=1 WHERE id=?').run(target.id);target={...target,adopt_legacy:1}}
    if (target.state === 'ready') {
      const remote = await call(config, `/hub/jimeng/routes/${target.remote_route_id}`)
      const problem = remoteRouteProblem(target,remote,drama.ownerUserId!)
      if (problem) throw issue(problem,409)
    } else await completeRoute(config, drama, target, current?.id ?? null)
    // Recheck after network work; no other request may replace a binding that
    // has changed while this page was choosing a canvas.
    if (project(dramaId).ownerUserId !== drama.ownerUserId) throw issue('项目归属已变化，请刷新后再选择。',409)
    assertAccountPermission(config, target.account_id, drama)
    activate(target, current?.id ?? null)
    return routed(config, sql.prepare('SELECT * FROM platform_jimeng_project_routes WHERE id=?').get(target.id) as RouteRow)
  })().finally(() => pending.delete(key))
  pending.set(key, operation)
  const result = await operation
  const row = sql.prepare('SELECT * FROM platform_jimeng_project_routes WHERE id=?').get(result.executionProjectRouteId!) as RouteRow
  return { current: publicRoute(row), notice: '项目绑定已保存；新的提交使用此画布，旧任务仍从原账号和画布查询。' }
}

/** Existing history is adopted only after an administrator selects the owner project. */
export async function adminAdoptProjectCanvas(configId:number,dramaId:number,input:any) {
  requireAdmin();init()
  if(!input||Object.keys(input).some(key=>!['account_id','canvas_id','confirmed'].includes(key))||input.confirmed!==true||typeof input.account_id!=='string'||!/^\d{1,30}$/u.test(input.canvas_id||''))throw issue('请明确确认原画布与目标项目。')
  const config=await configFor(configId),drama=project(dramaId),key=`${origin(config)}|${dramaId}`
  enabledSetting(config)
  if(pending.has(key)||managementPending.has(key))throw issue('本项目画布操作正在处理，请等待完成。',409)
  const operation=(async()=>{
    const health=await userRoutingHealth(config)
    if(!health.capabilities?.legacy_canvas_adoption)throw issue('请先更新一体平台，当前版本尚不支持确认旧画布归属。',409)
    assertAccountPermission(config,input.account_id,drama)
    if(unsubmittedTasks(dramaId).length)throw issue('本项目仍有尚未固定画布的任务，请等待准备完成后再接入旧画布。',409)
    const current=rowFor(dramaId,origin(config)),existing=sql.prepare("SELECT * FROM platform_jimeng_project_routes WHERE drama_id=? AND owner_id=? AND server_origin=? AND account_id=? AND canvas_id=? AND state='ready' ORDER BY version DESC LIMIT 1").get(dramaId,drama.ownerUserId,origin(config),input.account_id,input.canvas_id) as RouteRow|undefined
    if(existing){await checkedRouted(config,existing,drama.ownerUserId!);activate(existing,current?.id??null);return existing}
    const [available,remotes]=await Promise.all([canvasAvailability(config,input.account_id),remoteRoutes(config,health)])
    const canvas=available.find(item=>item.id===input.canvas_id)
    const waiting=pendingFor(dramaId,origin(config))
    if(waiting&&(waiting.account_id!==input.account_id||waiting.canvas_id!==input.canvas_id||!waiting.adopt_legacy))throw issue('此前画布创建结果尚未核实，请先处理原操作。',409)
    const local=sql.prepare('SELECT id FROM platform_jimeng_project_routes WHERE server_origin=? AND account_id=? AND canvas_id=? AND id<>?').get(origin(config),input.account_id,input.canvas_id,waiting?.id||0)
    const samePending=(item:any)=>waiting&&item.owner_id===`cy-${namespace}:user:${drama.ownerUserId}`&&item.project_id===remoteProject(waiting)&&item.account_id===input.account_id&&item.canvas_id===input.canvas_id
    const unrelated=remotes.some(item=>item.account_id===input.account_id&&item.canvas_id===input.canvas_id&&!samePending(item))
    if(!canvas||local||unrelated||!['available','legacy_history'].includes(canvas.availability)&&!(canvas.availability==='route_bound'&&remotes.some(samePending)))throw issue('该画布不存在或已有项目归属；不能通过接入操作改给其他项目。',409)
    const target=waiting||createRouteRow(config,drama,input.account_id,'existing',input.canvas_id,undefined,true)
    await completeRoute(config,drama,target,current?.id??null)
    return sql.prepare('SELECT * FROM platform_jimeng_project_routes WHERE id=?').get(target.id) as RouteRow
  })()
  const routedOperation=operation.then(row=>routed(config,row))
  pending.set(key,routedOperation)
  try{const result=await routedOperation;return{current:publicRoute(sql.prepare('SELECT * FROM platform_jimeng_project_routes WHERE id=?').get(result.executionProjectRouteId!) as RouteRow),notice:'旧画布已接入当前项目；以后提交使用此画布，旧任务记录保持原归属。'}}finally{pending.delete(key)}
}

async function userRoutingHealth(config:AIConfig){const health=await checkCapabilities(config);if(!health.capabilities?.canvas_assignment_status)throw issue('请先更新支持用户画布管理的一体平台。',409);return health}

export async function renameProjectCanvas(configId:number,dramaId:number,input:any) {
  requireActor();init()
  if(!input||Object.keys(input).some(key=>!['account_id','canvas_id','name','expected_name'].includes(key))||typeof input.account_id!=='string'||!/^\d{1,30}$/u.test(input.canvas_id||''))throw issue('画布改名参数不正确。')
  const name=canvasName(input.name)
  if(input.expected_name!==undefined&&typeof input.expected_name!=='string')throw issue('原画布名称不正确。')
  const config=await configFor(configId),drama=project(dramaId),key=`${origin(config)}|${dramaId}`
  enabledSetting(config);assertAccountPermission(config,input.account_id,drama)
  if(pending.has(key)||managementPending.has(key))throw issue('本项目画布操作正在处理，请等待完成。',409)
  managementPending.add(key)
  const operation=(async()=>{
    const options=await projectExecutionOptions(configId,dramaId)
    const account=options.accounts.find(item=>item.id===input.account_id),canvas=account?.canvases?.find(item=>item.id===input.canvas_id)
    if(!canvas?.can_rename)throw issue('此画布未授权当前项目管理，或平台尚不支持改名。',403)
    if(input.expected_name!==undefined&&canvas.name!==input.expected_name&&canvas.name!==name)throw issue('画布名称已变化，请刷新后再改名。',409)
    const lane=`${origin(config)}|${input.account_id}`,before=canvasQueues.get(lane)||Promise.resolve()
    const work=before.catch(()=>{}).then(async()=>{
      const latest=project(dramaId)
      if(latest.ownerUserId!==drama.ownerUserId)throw issue('项目归属已变化，请刷新后再操作画布。',409)
      assertAccountPermission(config,input.account_id,latest)
      const owned=sql.prepare("SELECT * FROM platform_jimeng_project_routes WHERE drama_id=? AND owner_id=? AND server_origin=? AND account_id=? AND canvas_id=? AND state='ready' ORDER BY version DESC LIMIT 1").get(dramaId,drama.ownerUserId,origin(config),input.account_id,input.canvas_id) as RouteRow|undefined
      if(!owned)throw issue('画布归属已变化，未执行改名。',409)
      await checkedRouted(config,owned,drama.ownerUserId!)
      return call(config,`/hub/jimeng/accounts/${encodeURIComponent(input.account_id)}/canvases/${input.canvas_id}/rename`,{name,expected_name:canvas.name===name?name:input.expected_name??canvas.name})
    })
    canvasQueues.set(lane,work)
    let result:any;try{result=await work}finally{if(canvasQueues.get(lane)===work)canvasQueues.delete(lane)}
    if(result?.id!==input.canvas_id||result?.account_id!==input.account_id||result?.name!==name||typeof result?.renamed!=='boolean'||result?.generation_submitted!==false)throw issue('远端改名结果尚未确认，请刷新画布后核对，不会自动重试。',502)
    return{renamed:true,account_id:input.account_id,canvas_id:input.canvas_id,name,...(result.renamed?{}:{unchanged:true})}
  })()
  // This lane protects changes within one project; it never occupies a video-generation slot.
  try{return await operation}finally{managementPending.delete(key)}
}
export async function adminProvisionProject(configId: number, dramaId: number, canvasId?: string) {
  requireAdmin()
  if (canvasId !== undefined && !/^\d{1,30}$/u.test(canvasId)) throw issue('画布编号格式错误。')
  const config = await configFor(configId), key = `${origin(config)}|${dramaId}`
  init(); const existing = rowFor(dramaId, origin(config))
  if (existing?.state === 'ready') {
    const drama = project(dramaId)
    if (existing.owner_id !== drama.ownerUserId || canvasId && canvasId !== existing.canvas_id) throw issue('项目已固定其他账号或画布，不能通过核对替换。', 409)
    const remote = await call(config, `/hub/jimeng/routes/${existing.remote_route_id}`)
    const problem = remoteRouteProblem(existing,remote,drama.ownerUserId!)
    if (problem) throw issue(problem,409)
    try { await call(routed(config, existing), '/v1/status') }
    catch { throw issue('原项目专属凭据已失效或暂时无法验证。请先检查服务；若确已轮换，可点击“重新授权项目”，不会重新生成视频。', 409) }
    return projectExecutionStatus(dramaId)
  }
  if (pending.has(key)) throw issue('该项目画布正在创建，请等待本次结果。', 409)
  const task = provision(config, dramaId, canvasId).finally(() => pending.delete(key)); pending.set(key, task)
  await task; return projectExecutionStatus(dramaId)
}
export async function adminReauthorizeProject(configId: number, dramaId: number) {
  requireAdmin(); init(); const config = await configFor(configId), drama = project(dramaId)
  const key = `${origin(config)}|${dramaId}`
  if (pending.has(key)) throw issue('该项目正在建立绑定或重新授权，请等待本次结果。', 409)
  const task = (async () => {
    const row = rowFor(dramaId, origin(config))
    if (!row?.remote_route_id || row.owner_id !== drama.ownerUserId) throw issue('没有可重新授权的原项目路由。', 409)
    const remote = await call(config, `/hub/jimeng/routes/${row.remote_route_id}`)
    const problem = remoteRouteProblem(row,remote,drama.ownerUserId!)
    if (problem) throw issue(problem,409)
    const minted = await call(config, `/hub/jimeng/routes/${remote.id}/key`, {})
    if (minted.route_id !== remote.id || typeof minted.key !== 'string' || !minted.key.startsWith('sk-cy-route-')) throw issue('未收到新的项目访问凭据。', 502)
    registerRuntimeSecrets([minted.key])
    sql.prepare("UPDATE platform_jimeng_project_routes SET key_blob=?,state='ready',updated_at=? WHERE id=?").run(seal(minted.key), stamp(), row.id)
    return routed(config, rowFor(dramaId, origin(config))!)
  })().finally(() => pending.delete(key))
  pending.set(key, task); await task
  return projectExecutionStatus(dramaId)
}
