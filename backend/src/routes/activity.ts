import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { currentActor, requireActor, assertProjectAccess, authenticateRequest } from '../services/platform-security/index.js'
import { activityDatabase as sql, activityTask, activityTaskView, activityRounds, activityEvents, activityEventPage, parseActivityJSON } from '../services/activity/store.js'
import { syncActivitySources } from '../services/activity/source-sync.js'
import { publicActivityRequest } from '../services/activity/sanitize.js'
import { success } from '../utils/response.js'

const app = new Hono()
const integer = (value: any, fallback: number, maximum: number) => /^\d+$/u.test(String(value ?? '')) ? Math.min(maximum, Number(value)) : fallback
function scope(actor: any) { return actor.role === 'admin' ? { clause: '1=1', args: [] as any[] } : { clause: 't.project_id IN (SELECT id FROM dramas WHERE owner_user_id=? AND deleted_at IS NULL)', args: [actor.id] } }
function allowed(task: any, actor: any) { if (!task) return false; if (actor.role === 'admin') return true; if (!task.project_id) return false; try { assertProjectAccess(task.project_id, actor); return true } catch { return false } }

app.get('/tasks', c => {
  const actor = requireActor(); syncActivitySources()
  const where = scope(actor), clauses = [where.clause], args = [...where.args]
  const projectId = integer(c.req.query('drama_id'), 0, Number.MAX_SAFE_INTEGER)
  if (projectId) { assertProjectAccess(projectId, actor); clauses.push('t.project_id=?'); args.push(projectId) }
  const kind = c.req.query('kind'), status = c.req.query('status')
  if (['text', 'image', 'video'].includes(kind || '')) { clauses.push('t.kind=?'); args.push(kind) }
  const countFilter = clauses.join(' AND '), countArgs = [...args]
  if (status === 'failed') clauses.push("t.status IN ('failed','interrupted')")
  else if (['queued', 'running', 'completed', 'interrupted'].includes(status || '')) { clauses.push('t.status=?'); args.push(status) }
  const filter = clauses.join(' AND '), limit = integer(c.req.query('limit'), 50, 100), offset = integer(c.req.query('offset'), 0, 1_000_000)
  const rows = sql.prepare(`SELECT t.* FROM platform_activity_tasks t WHERE ${filter} ORDER BY t.created_at DESC,t.rowid DESC LIMIT ? OFFSET ?`).all(...args, limit, offset)
  const total = (sql.prepare(`SELECT count(*) AS n FROM platform_activity_tasks t WHERE ${filter}`).get(...args) as any).n
  const counts = { active: 0, queued: 0, completed: 0, failed: 0 }
  for (const row of sql.prepare(`SELECT t.status,count(*) AS n FROM platform_activity_tasks t WHERE ${countFilter} GROUP BY t.status`).all(...countArgs) as any[]) {
    if (row.status === 'running') counts.active += row.n
    if (row.status === 'queued') counts.queued += row.n
    if (row.status === 'completed') counts.completed += row.n
    if (row.status === 'failed' || row.status === 'interrupted') counts.failed += row.n
  }
  return success(c, { items: rows.map(activityTaskView), total, counts })
})
app.get('/tasks/:id', c => {
  const actor = requireActor(); syncActivitySources()
  const row = activityTask(c.req.param('id'))
  if (!allowed(row, actor)) return c.json({ code: 404, message: '任务不存在或无权访问。' }, 404)
  const rounds = activityRounds(row.id).map(r => ({ ...r, input: actor.role === 'admin' ? r.input : publicActivityRequest(r.input), wire_request: actor.role === 'admin' ? r.wire_request : null }))
  const page = activityEventPage(row.id)
  return success(c, { task: activityTaskView(row), rounds, events: page.items, events_page: { total: page.total, has_more: page.has_more, next_before: page.next_before },
    request: actor.role === 'admin' ? parseActivityJSON(row.request_json) : publicActivityRequest(parseActivityJSON(row.request_json)),
    output: parseActivityJSON(row.output_json), usage: parseActivityJSON(row.usage_json), result: parseActivityJSON(row.result_json) })
})
app.get('/tasks/:id/events', c => {
  const actor = requireActor(), row = activityTask(c.req.param('id'))
  if (!allowed(row, actor)) return c.json({ code: 404, message: '任务不存在或无权访问。' }, 404)
  return success(c, activityEventPage(row.id, integer(c.req.query('before'), 0, Number.MAX_SAFE_INTEGER), integer(c.req.query('limit'), 500, 1000)))
})
app.get('/tasks/:id/export', c => {
  const actor = requireActor(); syncActivitySources()
  const row = activityTask(c.req.param('id'))
  if (!allowed(row, actor)) return c.json({ code: 404, message: '任务不存在或无权访问。' }, 404)
  const cutoff = Number((sql.prepare('SELECT coalesce(max(id),0) AS n FROM platform_activity_events WHERE task_id=?').get(row.id) as any).n)
  const rounds = activityRounds(row.id).map(r => ({ ...r, input: actor.role === 'admin' ? r.input : publicActivityRequest(r.input), wire_request: actor.role === 'admin' ? r.wire_request : null }))
  const prefix = JSON.stringify({ exported_at: new Date().toISOString(), recorded_through_event_id: cutoff,
    disclosure: { credentials_redacted: true, hidden_reasoning_omitted: true, media_bytes_omitted: true, request_snapshot: 'SDK / provider parameters, not a network packet capture' },
    task: activityTaskView(row), rounds,
    request: actor.role === 'admin' ? parseActivityJSON(row.request_json) : publicActivityRequest(parseActivityJSON(row.request_json)),
    output: parseActivityJSON(row.output_json), usage: parseActivityJSON(row.usage_json), result: parseActivityJSON(row.result_json) })
  const encoder = new TextEncoder()
  let after = 0, first = true, begun = false, done = false
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (done) return
    if (!begun) { begun = true; controller.enqueue(encoder.encode(prefix.slice(0, -1) + ',"events":[')); return }
    const events = activityEvents(row.id, after, 500).filter(event => event.id <= cutoff)
    if (!events.length) { done = true; controller.enqueue(encoder.encode(']}')); controller.close(); return }
    controller.enqueue(encoder.encode((first ? '' : ',') + events.map(event => JSON.stringify(event)).join(',')))
    first = false; after = events.at(-1)!.id
  }, cancel() { done = true } })
  return new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="activity-${row.id}.json"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } })
})
app.get('/events', c => {
  const actor = requireActor(), projectId = integer(c.req.query('drama_id'), 0, Number.MAX_SAFE_INTEGER), taskId = c.req.query('task_id')
  if (projectId) assertProjectAccess(projectId, actor)
  if (taskId && !allowed(activityTask(taskId), actor)) return c.json({ code: 404, message: '任务不存在或无权访问。' }, 404)
  const suppliedCursor = c.req.query('after') || c.req.header('last-event-id')
  let after = integer(suppliedCursor, 0, Number.MAX_SAFE_INTEGER)
  if (!suppliedCursor) {
    syncActivitySources()
    const where = scope(actor), clauses = [where.clause], args = [...where.args]
    if (projectId) { clauses.push('t.project_id=?'); args.push(projectId) }
    if (taskId) { clauses.push('t.id=?'); args.push(taskId) }
    after = Number((sql.prepare(`SELECT coalesce(max(e.id),0) AS n FROM platform_activity_events e JOIN platform_activity_tasks t ON t.id=e.task_id WHERE ${clauses.join(' AND ')}`).get(...args) as any).n)
  }
  return streamSSE(c, async stream => {
    let closed = false, heartbeat = 0
    stream.onAbort(() => { closed = true })
    // Tail a new subscription; durable history is available through the detail,
    // paging and export routes. A snapshot barrier closes the HTTP-list/SSE gap.
    if (!suppliedCursor) await stream.writeSSE({ id: String(after), data: JSON.stringify({ id: after, kind: 'sync', message: '实时订阅已连接，请刷新当前任务快照。' }) })
    while (!closed) {
      const fresh = authenticateRequest(c.req.raw)
      if (!fresh || fresh.id !== actor.id) break
      if (projectId) { try { assertProjectAccess(projectId, fresh) } catch { break } }
      syncActivitySources()
      const where = scope(fresh), clauses = [where.clause, 'e.id>?'], args = [...where.args, after]
      if (projectId) { clauses.push('t.project_id=?'); args.push(projectId) }
      if (taskId) { clauses.push('t.id=?'); args.push(taskId) }
      const events = sql.prepare(`SELECT e.* FROM platform_activity_events e JOIN platform_activity_tasks t ON t.id=e.task_id WHERE ${clauses.join(' AND ')} ORDER BY e.id LIMIT 100`).all(...args) as any[]
      for (const event of events) { after = event.id; await stream.writeSSE({ id: String(event.id), data: JSON.stringify({ id: event.id, task_id: event.task_id, round_id: event.round_id,
        kind: event.kind, message: event.message, payload: parseActivityJSON(event.payload_json), created_at: event.created_at }) }) }
      if (++heartbeat % 15 === 0) await stream.write(': keepalive\n\n')
      await stream.sleep(1000)
    }
  })
})
export default app
