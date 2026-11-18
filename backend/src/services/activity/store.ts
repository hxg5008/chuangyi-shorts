import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { db } from '../../db/index.js'
import { sanitizeActivity, activityUsage } from './sanitize.js'

const sql = db.$client
const timestamp = () => new Date().toISOString()
export type ActivityStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted'
export interface ActivitySpec { kind: 'text' | 'image' | 'video'; title: string; projectId?: number; episodeId?: number; userId?: number; model?: string; channel?: string; sourceType?: string; sourceId?: string; createdAt?: string; request?: any }
const parse = (value: any, fallback: any = null) => { try { return value ? JSON.parse(value) : fallback } catch { return fallback } }
// Keep complete text/tool snapshots; credentials, hidden reasoning and binary
// media remain intentionally omitted. The HTTP request itself is never altered.
const encode = (value: any) => JSON.stringify(sanitizeActivity(value, [], Number.MAX_SAFE_INTEGER))

export function initActivityStore() {
  sql.exec(`CREATE TABLE IF NOT EXISTS platform_activity_tasks (
    id TEXT PRIMARY KEY,user_id INTEGER,project_id INTEGER,episode_id INTEGER,kind TEXT NOT NULL,title TEXT NOT NULL,
    source_type TEXT,source_id TEXT,status TEXT NOT NULL,stage TEXT,model TEXT,channel TEXT,request_json TEXT,output_json TEXT,
    usage_json TEXT,result_json TEXT,error TEXT,created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,updated_at TEXT NOT NULL,
    source_fingerprint TEXT,UNIQUE(source_type,source_id));
    CREATE INDEX IF NOT EXISTS idx_activity_owner ON platform_activity_tasks(user_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_activity_project ON platform_activity_tasks(project_id,created_at);
    CREATE TABLE IF NOT EXISTS platform_activity_rounds (
    id TEXT PRIMARY KEY,task_id TEXT NOT NULL,number INTEGER NOT NULL,model TEXT,provider TEXT,status TEXT NOT NULL,
    input_json TEXT,output_json TEXT,usage_json TEXT,error TEXT,created_at TEXT NOT NULL,finished_at TEXT);
    CREATE INDEX IF NOT EXISTS idx_activity_round_task ON platform_activity_rounds(task_id,number);
    CREATE TABLE IF NOT EXISTS platform_activity_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,round_id TEXT,kind TEXT NOT NULL,message TEXT NOT NULL,
    payload_json TEXT,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_activity_event_task ON platform_activity_events(task_id,id);`)
  const add = (table: string, name: string, declaration: string) => {
    if (!(sql.prepare(`PRAGMA table_info(${table})`).all() as any[]).some(row => row.name === name)) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`)
  }
  add('platform_activity_rounds', 'public_text', "TEXT NOT NULL DEFAULT ''")
  add('platform_activity_rounds', 'tool_calls_json', "TEXT NOT NULL DEFAULT '[]'")
  add('platform_activity_rounds', 'wire_request_json', 'TEXT')
  add('platform_activity_tasks', 'queue_ms', 'INTEGER NOT NULL DEFAULT 0')
  add('platform_activity_tasks', 'queue_entered_at', 'TEXT')
  add('platform_activity_tasks', 'timing_known', 'INTEGER NOT NULL DEFAULT 0')
  // Historical rows have no reliable stage boundary. Preserve that unknown
  // instead of treating their last streaming update as the stage start.
  add('platform_activity_tasks', 'stage_started_at', 'TEXT')
}
initActivityStore()

export function activityProjectOwner(projectId?: number): number | null {
  if (!projectId) return null
  try { return (sql.prepare('SELECT owner_user_id AS id FROM dramas WHERE id=?').get(projectId) as any)?.id ?? null } catch { return null }
}
export function activityProjectForEpisode(episodeId?: number): number | undefined {
  return episodeId ? (sql.prepare('SELECT drama_id AS id FROM episodes WHERE id=?').get(episodeId) as any)?.id : undefined
}
export function activityEvent(taskId: string, kind: string, message: string, payload?: any, roundId?: string) {
  const res = sql.prepare('INSERT INTO platform_activity_events(task_id,round_id,kind,message,payload_json,created_at) VALUES(?,?,?,?,?,?)')
    .run(taskId, roundId || null, kind, message, encode(payload ?? null), timestamp())
  return Number(res.lastInsertRowid)
}
export function createActivityTask(spec: ActivitySpec) {
  const now = spec.createdAt || timestamp(), id = randomUUID()
  const projectId = spec.projectId || activityProjectForEpisode(spec.episodeId)
  sql.prepare(`INSERT INTO platform_activity_tasks(id,user_id,project_id,episode_id,kind,title,source_type,source_id,status,stage,model,channel,request_json,created_at,started_at,updated_at,stage_started_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, spec.userId ?? activityProjectOwner(projectId), projectId || null, spec.episodeId || null,
    spec.kind, spec.title, spec.sourceType || null, spec.sourceId || null, 'running', 'preparing', spec.model || null, spec.channel || null, encode(spec.request ?? null), now, now, now, now)
  activityEvent(id, 'started', '任务已开始。')
  if (!spec.createdAt || Math.abs(Date.now() - Date.parse(spec.createdAt)) < 2000) sql.prepare('UPDATE platform_activity_tasks SET timing_known=1 WHERE id=?').run(id)
  return id
}
export function activityTask(id: string): any { return sql.prepare('SELECT * FROM platform_activity_tasks WHERE id=?').get(id) || null }
export function activitySource(sourceType: string, sourceId: string): any { return sql.prepare('SELECT * FROM platform_activity_tasks WHERE source_type=? AND source_id=?').get(sourceType, sourceId) || null }
export function ensureActivitySource(spec: ActivitySpec & { sourceType: string; sourceId: string }) {
  return activitySource(spec.sourceType, spec.sourceId)?.id || createActivityTask(spec)
}
/** Internal correlation for the administrator's explicit model test. */
export function bindActivitySource(taskId: string, sourceType: string, sourceId: string) {
  const row = activityTask(taskId)
  if (!row || row.source_type && (row.source_type !== sourceType || row.source_id !== sourceId)) throw new Error('任务日志关联不正确')
  sql.prepare('UPDATE platform_activity_tasks SET source_type=?,source_id=? WHERE id=?').run(sourceType, sourceId, taskId)
}
export function updateActivityTask(id: string, values: { status?: ActivityStatus; stage?: string; model?: string; channel?: string; request?: any; output?: any; usage?: any; result?: any; error?: string | null; finishedAt?: string | null; fingerprint?: string }) {
  const fields: Record<string, any> = { updated_at: timestamp() }
  const old = activityTask(id)
  if (values.stage !== undefined && values.stage !== old?.stage) fields.stage_started_at = fields.updated_at
  if (old?.timing_known && values.status) {
    if (values.status === 'queued' && old.status !== 'queued') fields.queue_entered_at = fields.updated_at
    if (values.status !== 'queued' && old.queue_entered_at) {
      fields.queue_ms = Math.max(0, old.queue_ms || 0) + Math.max(0, Date.parse(fields.updated_at) - Date.parse(old.queue_entered_at))
      fields.queue_entered_at = null
    }
  }
  for (const key of ['status', 'stage', 'model', 'channel', 'error'] as const) if (values[key] !== undefined) fields[key] = typeof values[key] === 'string' ? sanitizeActivity(values[key]) : values[key]
  for (const key of ['request', 'output', 'usage', 'result'] as const) if (values[key] !== undefined) fields[key + '_json'] = encode(key === 'usage' && values[key] != null ? activityUsage(values[key]) : values[key])
  if (values.finishedAt !== undefined) fields.finished_at = values.finishedAt
  else if (values.status && ['completed', 'failed', 'interrupted'].includes(values.status)) fields.finished_at = timestamp()
  if (values.fingerprint !== undefined) fields.source_fingerprint = values.fingerprint
  sql.prepare(`UPDATE platform_activity_tasks SET ${Object.keys(fields).map(k => `${k}=?`).join(',')} WHERE id=?`).run(...Object.values(fields), id)
}
export function startActivityRound(taskId: string, metadata: { model?: string; provider?: string; stage?: string }, input: any) {
  const id = randomUUID(), number = Number((sql.prepare('SELECT coalesce(max(number),0)+1 AS n FROM platform_activity_rounds WHERE task_id=?').get(taskId) as any).n)
  sql.prepare('INSERT INTO platform_activity_rounds(id,task_id,number,model,provider,status,input_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, taskId, number, metadata.model || null, metadata.provider || null, 'running', encode(input), timestamp())
  updateActivityTask(taskId, { status: 'running', stage: metadata.stage || 'generating', model: metadata.model, channel: metadata.provider })
  activityEvent(taskId, 'model_submitted', `第 ${number} 轮模型请求已提交。`, metadata, id)
  return id
}
export function endActivityRound(id: string, taskId: string, output: any, usage?: any, error?: string) {
  const normalized = activityUsage(usage)
  sql.prepare('UPDATE platform_activity_rounds SET status=?,output_json=?,usage_json=?,error=?,finished_at=? WHERE id=?')
    .run(error ? 'failed' : 'completed', encode(output), encode(normalized), error ? sanitizeActivity(error) : null, timestamp(), id)
  activityEvent(taskId, error ? 'model_failed' : 'model_completed', error ? '本轮模型请求失败。' : '本轮模型请求结束。', error ? { error } : { usage: normalized }, id)
}
export function appendActivityRoundText(id: string, text: string) {
  const clean = sanitizeActivity(text, [], Number.MAX_SAFE_INTEGER)
  sql.prepare('UPDATE platform_activity_rounds SET public_text=public_text||? WHERE id=?').run(clean, id)
}
export function setActivityRoundTools(id: string, calls: any[]) {
  sql.prepare('UPDATE platform_activity_rounds SET tool_calls_json=? WHERE id=?').run(encode(calls), id)
}
export function recordActivityWire(taskId: string, summary: unknown) {
  const round = sql.prepare("SELECT id FROM platform_activity_rounds WHERE task_id=? AND status='running' ORDER BY number DESC LIMIT 1").get(taskId) as any
  let snapshot: any = summary
  if (snapshot && typeof snapshot === 'object' && typeof snapshot.body === 'string') {
    try { snapshot = { ...snapshot, body: JSON.parse(snapshot.body) } } catch {}
  }
  if (round) sql.prepare('UPDATE platform_activity_rounds SET wire_request_json=? WHERE id=?').run(encode(snapshot), round.id)
}
export function activityRounds(taskId: string) {
  return (sql.prepare('SELECT * FROM platform_activity_rounds WHERE task_id=? ORDER BY number').all(taskId) as any[]).map(r => ({
    id: r.id, number: r.number, model: r.model, provider: r.provider, status: r.status, input: parse(r.input_json),
    public_output: parse(r.output_json), usage: parse(r.usage_json), error: r.error, created_at: r.created_at, finished_at: r.finished_at,
    public_text: r.public_text || '', tool_calls: parse(r.tool_calls_json, parse(r.output_json)?.tool_calls || []),
    wire_request: parse(r.wire_request_json),
    elapsed_seconds: Math.max(0, (Date.parse(r.finished_at || timestamp()) - Date.parse(r.created_at)) / 1000),
  }))
}
export function activityEvents(taskId: string, after = 0, limit = 500) {
  return (sql.prepare('SELECT * FROM platform_activity_events WHERE task_id=? AND id>? ORDER BY id LIMIT ?').all(taskId, after, limit) as any[])
    .map(e => ({ id: e.id, task_id: e.task_id, round_id: e.round_id, kind: e.kind, message: e.message, payload: parse(e.payload_json), created_at: e.created_at }))
}
export function activityEventPage(taskId: string, before = 0, limit = 500) {
  const total = (sql.prepare('SELECT count(*) n FROM platform_activity_events WHERE task_id=?').get(taskId) as any).n
  const rows = (before
    ? sql.prepare('SELECT * FROM platform_activity_events WHERE task_id=? AND id<? ORDER BY id DESC LIMIT ?').all(taskId, before, limit)
    : sql.prepare('SELECT * FROM platform_activity_events WHERE task_id=? ORDER BY id DESC LIMIT ?').all(taskId, limit)) as any[]
  rows.reverse()
  const first = rows[0]?.id || 0
  const hasMore = !!first && !!sql.prepare('SELECT 1 FROM platform_activity_events WHERE task_id=? AND id<? LIMIT 1').get(taskId, first)
  return { items: rows.map(e => ({ id: e.id, task_id: e.task_id, round_id: e.round_id, kind: e.kind, message: e.message, payload: parse(e.payload_json), created_at: e.created_at })), total, has_more: hasMore, next_before: hasMore ? first : null }
}
export function activityTaskView(row: any) {
  const end = row.finished_at || timestamp(), result = parse(row.result_json), elapsed = Math.max(0, (Date.parse(end) - Date.parse(row.created_at)) / 1000)
  const queueSeconds = typeof result?.queue_seconds === 'number' ? result.queue_seconds : row.timing_known
    ? Math.max(0, Number(row.queue_ms || 0) / 1000 + (row.queue_entered_at ? (Date.parse(end) - Date.parse(row.queue_entered_at)) / 1000 : 0)) : null
  return { id: row.id, kind: row.kind, title: row.title, status: row.status, stage: row.stage, drama_id: row.project_id, project_id: row.project_id,
    episode_id: row.episode_id, model: row.model, channel: row.channel, created_at: row.created_at, started_at: row.started_at,
    finished_at: row.finished_at, elapsed_seconds: Math.round(elapsed), queue_seconds: queueSeconds == null ? null : Math.round(queueSeconds),
    stage_started_at: row.stage_started_at || null,
    stage_elapsed_seconds: row.stage_started_at ? Math.max(0, Math.round((Date.parse(end) - Date.parse(row.stage_started_at)) / 1000)) : null,
    last_observed_at: row.updated_at || null,
    run_seconds: queueSeconds == null ? null : Math.round(Math.max(0, elapsed - queueSeconds)),
    progress: typeof result?.progress === 'number' && result.progress >= 0 && result.progress <= 100 ? result.progress : null,
    source_ref: row.source_type ? { type: row.source_type, id: row.source_id } : null, error: row.error, result, usage: parse(row.usage_json),
  }
}
export const activityDatabase: Database.Database = sql
export const parseActivityJSON = parse
