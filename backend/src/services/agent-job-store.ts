import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { WorkflowRequestStat } from './skill-storyboard-workflow.js'

export type AgentJobStatus = 'running' | 'done' | 'needs_revision' | 'error'
export type AgentJobPhase = 'generating' | 'validating' | 'repairing' | 'done' | 'needs_revision' | 'error'
export interface JobIssue {
  code: string
  message: string
  severity?: 'error' | 'warning'
  storyboard_id?: number
  shot_number?: number
  field?: string
}
export interface AgentJob {
  id: string
  agent_type: string
  episode_id: number
  drama_id: number
  scope: 'agent' | 'video_prompt_batch'
  storyboard_ids: number[]
  status: AgentJobStatus
  phase: AgentJobPhase
  attempt: number
  total: number
  completed: number
  failed: number
  current_storyboard_id?: number
  draft_id?: string
  current_group?: number
  error?: string
  error_code?: string
  provider_http_status?: number
  provider_request_id?: string
  failure_phase?: AgentJobPhase
  elapsed_seconds?: number
  model_calls?: number
  repair_calls?: number
  auto_recovery_calls?: number
  request_stats?: WorkflowRequestStat[]
  issues: JobIssue[]
  started_at: string
  finished_at?: string
  updated_at: string
}
export type AgentJobSpec = Pick<AgentJob, 'agent_type' | 'episode_id' | 'drama_id' | 'scope' | 'storyboard_ids'> & { total?: number }
const safeText = (value: string) => value.replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]').replace(/(Bearer\s+)[^\s,"'<>]+/gi, '$1[redacted]')

/** Small durable journal. No prompts, model credentials, or signed media URLs are stored here. */
export class AgentJobStore {
  constructor(private readonly sqlite: Database.Database) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS agent_jobs (
      id TEXT PRIMARY KEY, episode_id INTEGER NOT NULL, status TEXT NOT NULL,
      scope TEXT NOT NULL, started_at TEXT NOT NULL, payload TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_agent_jobs_episode ON agent_jobs(episode_id, started_at)`)
  }
  get(id: string): AgentJob | null {
    const row = this.sqlite.prepare('SELECT payload FROM agent_jobs WHERE id=?').get(id) as { payload: string } | undefined
    return row ? JSON.parse(row.payload) : null
  }
  list(episodeId: number): AgentJob[] {
    return (this.sqlite.prepare('SELECT payload FROM agent_jobs WHERE episode_id=? ORDER BY started_at DESC,rowid DESC LIMIT 30').all(episodeId) as { payload: string }[]).map(row => JSON.parse(row.payload))
  }
  active(episodeId: number): AgentJob | null {
    const row = this.sqlite.prepare("SELECT payload FROM agent_jobs WHERE episode_id=? AND status='running' LIMIT 1").get(episodeId) as { payload: string } | undefined
    return row ? JSON.parse(row.payload) : null
  }
  start(spec: AgentJobSpec): { job: AgentJob; alreadyRunning: boolean } {
    return this.sqlite.transaction(() => {
      const active = this.active(spec.episode_id)
      if (active) {
        const same = active.scope === spec.scope && active.agent_type === spec.agent_type && active.drama_id === spec.drama_id
          && JSON.stringify([...active.storyboard_ids].sort((a, b) => a - b)) === JSON.stringify([...spec.storyboard_ids].sort((a, b) => a - b))
        if (!same) throw new Error('当前集已有分镜或提示词任务执行中，请等待完成后再操作')
        return { job: active, alreadyRunning: true }
      }
      const timestamp = new Date().toISOString()
      const job: AgentJob = { ...spec, id: randomUUID(), status: 'running', phase: 'generating', attempt: 0, total: spec.total ?? 1, completed: 0, failed: 0, issues: [], started_at: timestamp, updated_at: timestamp }
      this.sqlite.prepare('INSERT INTO agent_jobs(id,episode_id,status,scope,started_at,payload) VALUES(?,?,?,?,?,?)').run(job.id, job.episode_id, job.status, job.scope, timestamp, JSON.stringify(job))
      return { job, alreadyRunning: false }
    }).immediate()
  }
  update(id: string, patch: Partial<AgentJob>): AgentJob {
    const current = this.get(id)
    if (!current) throw new Error('任务不存在')
    // Terminal jobs are immutable; late completions cannot undo a timeout/restart failure.
    if (current.status !== 'running') return current
    const next = { ...current, ...patch, id: current.id, updated_at: new Date().toISOString() }
    if (next.error) next.error = safeText(next.error)
    next.issues = next.issues.map(issue => ({ ...issue, message: safeText(issue.message) }))
    if (next.status !== 'running') next.finished_at = next.updated_at
    this.sqlite.prepare('UPDATE agent_jobs SET status=?,payload=? WHERE id=?').run(next.status, JSON.stringify(next), id)
    return next
  }
  recoverInterrupted() {
    const rows = this.sqlite.prepare("SELECT id FROM agent_jobs WHERE status='running'").all() as { id: string }[]
    for (const row of rows) this.update(row.id, { status: 'error', phase: 'error', error: '服务已重启，上次任务已中断；未验收的暂存内容未写入，旧稿已保留。请核对后手动重试。' })
    return rows.length
  }
}
