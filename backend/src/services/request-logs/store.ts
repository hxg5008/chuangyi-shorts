import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { sanitizeActivity } from '../activity/sanitize.js'
import type { RequestLogContext } from './context.js'

export interface RequestLogFilter { from?: string; to?: string; user_id?: string; model?: string; channel_id?: string; kind?: string; phase?: string; status?: string; q?: string; limit?: string | number; offset?: string | number; include_internal?: string | boolean }
export interface RequestLogStart extends RequestLogContext { method: string; url: string; path: string; kind: 'text'|'image'|'video'|'unknown'; phase: 'generate'|'poll'|'upload'|'download'|'other' }
const now = () => new Date().toISOString()
const clean = (value: any) => sanitizeActivity(value, [], 262144)
const encode = (value: any) => JSON.stringify(clean(value))
const bounded=(value:any)=>{const content=encode(value),bytes=Buffer.byteLength(content);return bytes<=262144?{content,truncated:false}:{content:JSON.stringify({omitted:'脱敏正文超过日志存储上限',bytes}),truncated:true}}
const parse = (value: string | null) => { try { return value ? JSON.parse(value) : null } catch { return null } }
/** Metadata is a separate disclosure surface from request/response bodies. */
export function sanitizeRequestMetadata<T>(value:T,secrets:string[]=[]):T{
  const result=sanitizeActivity(value,secrets,262144)
  for(const key of ['taskId','roundId','parentId','upstreamTaskId','businessStatus','model'])if(typeof (value as any)?.[key]==='string'&&result[key]!== (value as any)[key])result[key]=null
  return result
}
const count = (value: unknown, fallback: number, max: number) => /^\d+$/u.test(String(value ?? '')) ? Math.min(max, Number(value)) : fallback
let installed: RequestLogStore | null = null
export const requestLogStore = () => installed
export const setRequestLogStore = (value: RequestLogStore | null) => { installed = value }

/** One row per actual outgoing HTTP attempt. Imported history is never fabricated. */
export class RequestLogStore {
  constructor(readonly sql: Database.Database) {
    sql.exec(`CREATE TABLE IF NOT EXISTS platform_request_logs (
      id TEXT PRIMARY KEY, task_id TEXT, round_id TEXT, parent_id TEXT, attempt_no INTEGER NOT NULL,
      user_id INTEGER, project_owner_id INTEGER, project_id INTEGER, episode_id INTEGER,
      config_id INTEGER, channel_id INTEGER, channel_name TEXT, model TEXT, kind TEXT NOT NULL, phase TEXT NOT NULL,
      method TEXT NOT NULL,url TEXT NOT NULL,path TEXT NOT NULL,status TEXT NOT NULL,
      http_status INTEGER,upstream_request_id TEXT,upstream_task_id TEXT,business_status TEXT,error TEXT,
      created_at TEXT NOT NULL,headers_at TEXT,first_byte_at TEXT,finished_at TEXT,duration_ms REAL,ttfb_ms REAL,headers_ms REAL,
      request_headers_json TEXT,request_body_json TEXT,response_headers_json TEXT,response_body_json TEXT,
      request_recorded INTEGER NOT NULL DEFAULT 0,response_recorded INTEGER NOT NULL DEFAULT 0,
      request_truncated INTEGER NOT NULL DEFAULT 0,response_truncated INTEGER NOT NULL DEFAULT 0,response_bytes INTEGER);
      CREATE INDEX IF NOT EXISTS idx_request_created ON platform_request_logs(created_at DESC,id);
      CREATE INDEX IF NOT EXISTS idx_request_user ON platform_request_logs(user_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_request_task ON platform_request_logs(task_id,created_at);
      CREATE INDEX IF NOT EXISTS idx_request_channel ON platform_request_logs(channel_id,created_at);
      CREATE INDEX IF NOT EXISTS idx_request_filters ON platform_request_logs(kind,phase,status,created_at);`)
  }
  private exists(name: string) { return !!this.sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) }
  private userNameColumn() {
    return (this.sql.prepare('PRAGMA table_info(platform_users)').all() as {name:string}[]).some(column=>column.name==='deleted_username')
      ? 'COALESCE(u.deleted_username,u.username)' : 'u.username'
  }
  markInterrupted(){this.sql.prepare("UPDATE platform_request_logs SET status='unknown',finished_at=?,error='服务重启，原连接观察已中断；上游结果未核实，请查看原任务。不会自动重新提交。' WHERE status='running'").run(now())}
  begin(input: RequestLogStart,secrets:string[]=[]) {
    input=sanitizeRequestMetadata(input,secrets)
    const id = randomUUID(), at = now()
    const attempt = input.taskId||input.roundId ? this.sql.prepare('SELECT coalesce(max(attempt_no),0)+1 AS n FROM platform_request_logs WHERE task_id IS ? AND round_id IS ? AND method=? AND path=?').get(input.taskId || null,input.roundId || null,input.method,input.path) as any : {n:1}
    this.sql.prepare(`INSERT INTO platform_request_logs (id,task_id,round_id,parent_id,attempt_no,user_id,project_owner_id,project_id,episode_id,config_id,channel_id,channel_name,model,kind,phase,method,url,path,status,created_at,upstream_task_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.taskId || null,input.roundId || null,input.parentId || null,attempt.n,
      input.actorUserId ?? null,input.projectOwnerId ?? null,input.projectId ?? null,input.episodeId ?? null,input.configId ?? null,input.channelId ?? null,input.channelName || null,input.model || null,input.kind,input.phase,input.method,input.url,input.path,'running',at,input.upstreamTaskId||null)
    return id
  }
  request(id: string, headers: unknown, body: unknown, recorded: boolean, truncated = false) {
    const value=bounded(body)
    this.sql.prepare('UPDATE platform_request_logs SET request_headers_json=?,request_body_json=?,request_recorded=?,request_truncated=? WHERE id=?').run(bounded(headers).content,value.content,Number(recorded),Number(truncated||value.truncated),id)
  }
  headers(id: string, status: number, headers: unknown, elapsed: number, upstream?: string | null,secrets:string[]=[]) {
    const metadata=sanitizeRequestMetadata({upstreamTaskId:upstream},secrets)
    this.sql.prepare('UPDATE platform_request_logs SET http_status=?,headers_at=?,headers_ms=?,response_headers_json=?,upstream_request_id=? WHERE id=?').run(status,now(),elapsed,encode(sanitizeActivity(headers,secrets)),metadata.upstreamTaskId || null,id)
  }
  firstByte(id: string, elapsed: number) { this.sql.prepare('UPDATE platform_request_logs SET first_byte_at=?,ttfb_ms=? WHERE id=? AND first_byte_at IS NULL').run(now(),elapsed,id) }
  finish(id: string, input: { status: string; elapsed: number; body?: unknown; recorded?: boolean; truncated?: boolean; bytes?: number; error?: string; upstreamTaskId?: string; businessStatus?: string },secrets:string[]=[]) {
    input=sanitizeRequestMetadata(input,secrets)
    const value=bounded(input.body??null)
    this.sql.prepare(`UPDATE platform_request_logs SET status=?,finished_at=?,duration_ms=?,response_body_json=?,response_recorded=?,response_truncated=?,response_bytes=?,error=?,upstream_task_id=COALESCE(?,upstream_task_id),business_status=? WHERE id=?`).run(
      input.status,now(),input.elapsed,value.content,Number(!!input.recorded),Number(!!input.truncated||value.truncated),input.bytes ?? null,input.error ? String(clean(input.error)).slice(0,2000) : null,input.upstreamTaskId || null,input.businessStatus || null,id)
  }
  metadata(id: string, patch: Partial<RequestLogContext>,secrets:string[]=[]) {
    patch=sanitizeRequestMetadata(patch,secrets)
    this.sql.prepare('UPDATE platform_request_logs SET config_id=COALESCE(config_id,?),channel_id=COALESCE(channel_id,?),channel_name=COALESCE(channel_name,?),model=COALESCE(?,model) WHERE id=?').run(patch.configId ?? null,patch.channelId ?? null,patch.channelName || null,patch.model || null,id)
  }
  private projection() {
    const users=this.exists('platform_users'),projects=this.exists('dramas'),episodes=this.exists('episodes')
    return { columns:`r.id,r.task_id,r.round_id,r.parent_id,r.attempt_no,r.user_id,r.project_owner_id,r.project_id,r.episode_id,r.config_id,r.channel_id,r.channel_name,r.model,r.kind,r.phase,r.method,r.url,r.path,r.status,r.http_status,r.upstream_request_id,r.upstream_task_id,r.business_status,r.error,r.created_at,r.headers_at,r.first_byte_at,r.finished_at,r.duration_ms,r.ttfb_ms,r.headers_ms,r.request_recorded,r.response_recorded,r.request_truncated,r.response_truncated,r.response_bytes,
      ${users?this.userNameColumn():'NULL'} AS user_name,${users?'u.display_name':'NULL'} AS user_display_name,${projects?'d.title':'NULL'} AS project_title,${episodes?'e.episode_number':'NULL'} AS episode_number`,
      joins:`${users?'LEFT JOIN platform_users u ON u.id=r.user_id':''} ${projects?'LEFT JOIN dramas d ON d.id=r.project_id':''} ${episodes?'LEFT JOIN episodes e ON e.id=r.episode_id':''}` }
  }
  private filter(input: RequestLogFilter) {
    const terms:string[]=[],args:any[]=[]
    for (const [key,column] of [['user_id','user_id'],['channel_id','channel_id']] as const) if (input[key] !== undefined && input[key] !== '') {
      if (!/^[1-9]\d*$/u.test(String(input[key]))) throw Object.assign(Error('筛选编号无效'),{status:400})
      terms.push(`r.${column}=?`);args.push(Number(input[key]))
    }
    for (const key of ['model','kind','phase','status'] as const) if(input[key] && input[key]!=='all'){terms.push(`r.${key}=?`);args.push(input[key])}
    for(const [key,op]of [['from','>='],['to','<=']] as const)if(input[key]){const date=new Date(input[key]!);if(!Number.isFinite(date.valueOf()))throw Object.assign(Error('时间范围无效'),{status:400});terms.push(`r.created_at${op}?`);args.push(date.toISOString())}
    if(input.q){const value=String(input.q).slice(0,300),needle='%'+value.replace(/[\\%_]/gu,'\\$&')+'%';const p=this.projection();const fields=['r.id','r.task_id','r.round_id','r.upstream_request_id','r.upstream_task_id','r.model','r.channel_name','r.path','r.error'];if(p.joins.includes('platform_users'))fields.push(this.userNameColumn(),'u.display_name');if(p.joins.includes('dramas'))fields.push('d.title');terms.push('('+fields.map(f=>`${f} LIKE ? ESCAPE '\\'`).join(' OR ')+')');args.push(...fields.map(()=>needle))}
    if(!input.phase && input.include_internal!==true && input.include_internal!=='true')terms.push("r.phase='generate'")
    return {where:terms.length?terms.join(' AND '):'1=1',args}
  }
  list(input: RequestLogFilter) {
    const {where,args}=this.filter(input),{columns,joins}=this.projection(),limit=count(input.limit,50,100),offset=count(input.offset,0,1_000_000)
    const items=(this.sql.prepare(`SELECT ${columns} FROM platform_request_logs r ${joins} WHERE ${where} ORDER BY r.created_at DESC,r.rowid DESC LIMIT ? OFFSET ?`).all(...args,limit,offset) as any[]).map(row=>this.view(row))
    const total=(this.sql.prepare(`SELECT count(*) n FROM platform_request_logs r ${joins} WHERE ${where}`).get(...args) as any).n
    const counts:any={running:0,succeeded:0,failed:0,cancelled:0,unknown:0}
    for(const row of this.sql.prepare(`SELECT r.status,count(*) n FROM platform_request_logs r ${joins} WHERE ${where} GROUP BY r.status`).all(...args) as any[])counts[row.status]=row.n
    return {items,total,counts,options:this.options(),limit,offset}
  }
  private view(row:any){return{...row,request_recorded:!!row.request_recorded,response_recorded:!!row.response_recorded,request_truncated:!!row.request_truncated,response_truncated:!!row.response_truncated}}
  options() {
    const users=this.exists('platform_users')?this.sql.prepare(`SELECT DISTINCT u.id,${this.userNameColumn()} AS username,u.display_name FROM platform_users u JOIN platform_request_logs r ON r.user_id=u.id ORDER BY u.id`).all():[]
    const models=(this.sql.prepare('SELECT DISTINCT model FROM platform_request_logs WHERE model IS NOT NULL ORDER BY model').all() as any[]).map(r=>r.model)
    const channels=this.sql.prepare('SELECT channel_id AS id,max(channel_name) AS name FROM platform_request_logs WHERE channel_id IS NOT NULL GROUP BY channel_id ORDER BY channel_id').all()
    return {users,models,channels,kinds:['text','image','video','unknown'],phases:['generate','poll','upload','download','other']}
  }
  detail(id: string) {
    const {columns,joins}=this.projection(),row=this.sql.prepare(`SELECT ${columns},r.request_headers_json,r.request_body_json,r.response_headers_json,r.response_body_json FROM platform_request_logs r ${joins} WHERE r.id=?`).get(id) as any
    if(!row)return null
    const {request_headers_json,request_body_json,response_headers_json,response_body_json,...request}=row
    const children=this.sql.prepare(`SELECT ${columns} FROM platform_request_logs r ${joins} WHERE r.parent_id=? ORDER BY r.created_at,r.rowid LIMIT 500`).all(id)
    return {request:this.view(request),request_headers:parse(request_headers_json),request_body:parse(request_body_json),response_headers:parse(response_headers_json),response_body:parse(response_body_json),children:(children as any[]).map(row=>this.view(row)),correlation:{task_id:row.task_id,round_id:row.round_id},disclosure:{credentials_redacted:true,media_bytes_omitted:true,hidden_reasoning_omitted:true,not_recorded_before_install:true}}
  }
  correlate(taskId?:string,phase?:string) {
    return taskId && phase!=='generate' ? (this.sql.prepare("SELECT id FROM platform_request_logs WHERE task_id=? AND phase='generate' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(taskId) as any)?.id : null
  }
}
