import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export type StoryboardDraftMode = 'breakdown' | 'prompt'
export type StoryboardDraftStatus = 'generating' | 'needs_revision' | 'ready' | 'committed' | 'interrupted'
export type DraftGroupStatus = 'pending' | 'generating' | 'ready' | 'needs_revision' | 'error'
export interface DraftGroup {
  number: number
  status: DraftGroupStatus
  candidate: unknown | null
  issues: unknown[]
  attempts: number
  error?: string
}
export interface BoundaryRepairRecord {
  id: string
  left: number
  right: number
  status: 'running' | 'applied' | 'failed'
  createdAt: string
  finishedAt?: string
  reason: string
  beforeHashes: { left: string; right: string }
  before: [DraftGroup, DraftGroup]
  /** A following ready group retained verbatim but reopened for boundary review. */
  dependentBefore?: DraftGroup
  error?: string
}
export interface StoryboardDraft {
  id: string
  episodeId: number
  dramaId: number
  mode: StoryboardDraftMode
  scope: number[]
  fingerprint: string
  status: StoryboardDraftStatus
  plan: unknown | null
  groups: DraftGroup[]
  /** Bounded audit of atomic repairs within this unpublished draft. */
  boundaryRepairs?: BoundaryRepairRecord[]
  createdAt: string
  updatedAt: string
}
export type StoryboardDraftSpec = Pick<StoryboardDraft, 'episodeId' | 'dramaId' | 'mode' | 'scope' | 'fingerprint'>
interface DraftRow { payload: string; lease_token: string | null }
const draftStatuses = new Set<StoryboardDraftStatus>(['generating', 'needs_revision', 'ready', 'committed', 'interrupted'])
const groupStatuses = new Set<DraftGroupStatus>(['pending', 'generating', 'ready', 'needs_revision', 'error'])
const credentialKey = /^(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password)$/i
const safeText = (value: string) => value.replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
  .replace(/\bBearer\s+[^\s,"'<>]+/gi, 'Bearer [redacted]')
  .replace(/([?&](?:api[_-]?key|access[_-]?token|token|key)=)[^&#\s]*/gi, '$1[redacted]')
  .replace(/\b(api[_-]?key|authorization|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[redacted]')

/** Detach snapshots and omit credentials; ordinary candidate prose remains intact. */
function snapshot<T>(value: T): T {
  const serialized = JSON.stringify(value, (key, entry) => credentialKey.test(key) ? undefined : typeof entry === 'string' ? safeText(entry) : entry)
  if (serialized === undefined) throw new Error('草稿内容必须可保存为JSON')
  return JSON.parse(serialized)
}
function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name}必须为正整数`)
}
function normalizedScope(scope: number[]) {
  if (!Array.isArray(scope)) throw new Error('草稿范围必须为数组')
  scope.forEach(value => positiveInteger(value, '分镜ID'))
  return [...new Set(scope)].sort((a, b) => a - b)
}
function validateMode(mode: StoryboardDraftMode) {
  if (mode !== 'breakdown' && mode !== 'prompt') throw new Error('草稿类型无效')
}
function normalizedGroup(group: DraftGroup): DraftGroup {
  positiveInteger(group.number, '组号')
  if (!groupStatuses.has(group.status) || !Array.isArray(group.issues) || !Number.isSafeInteger(group.attempts) || group.attempts < 0
    || group.candidate === undefined || group.error !== undefined && typeof group.error !== 'string') throw new Error('草稿分组状态无效')
  return snapshot({ number: group.number, status: group.status, candidate: group.candidate, issues: group.issues,
    attempts: group.attempts, ...(group.error !== undefined ? { error: group.error } : {}) })
}
function groupHash(group: DraftGroup): string {
  return createHash('sha256').update(JSON.stringify(normalizedGroup(group))).digest('hex')
}

/** Durable creative drafts only. This store never changes the published storyboards. */
export class StoryboardDraftStore {
  constructor(private readonly sqlite: Database.Database) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS storyboard_drafts (
      id TEXT PRIMARY KEY, episode_id INTEGER NOT NULL, drama_id INTEGER NOT NULL,
      mode TEXT NOT NULL, scope_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      lease_token TEXT, payload TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_storyboard_drafts_episode ON storyboard_drafts(episode_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_storyboard_drafts_identity ON storyboard_drafts(episode_id, drama_id, mode, scope_key, created_at)`)
  }

  private row(id: string): DraftRow {
    const row = this.sqlite.prepare('SELECT payload,lease_token FROM storyboard_drafts WHERE id=?').get(id) as DraftRow | undefined
    if (!row) throw new Error('草稿不存在')
    return row
  }
  private assertLease(row: DraftRow, leaseToken?: string) {
    if (row.lease_token ? row.lease_token !== leaseToken : leaseToken !== undefined) throw new Error('草稿租约无效或已过期，未保存迟到内容')
  }
  private write(draft: StoryboardDraft) {
    this.sqlite.prepare('UPDATE storyboard_drafts SET status=?,updated_at=?,payload=? WHERE id=?')
      .run(draft.status, draft.updatedAt, JSON.stringify(draft), draft.id)
  }
  private mutate(id: string, leaseToken: string | undefined, update: (draft: StoryboardDraft) => void): StoryboardDraft {
    return this.sqlite.transaction(() => {
      const row = this.row(id)
      this.assertLease(row, leaseToken)
      const draft: StoryboardDraft = JSON.parse(row.payload)
      if (draft.status === 'committed') throw new Error('已提交的草稿不能修改，请创建新版本')
      update(draft)
      draft.updatedAt = new Date().toISOString()
      this.write(draft)
      return draft
    }).immediate()
  }

  get(id: string): StoryboardDraft | null {
    const row = this.sqlite.prepare('SELECT payload FROM storyboard_drafts WHERE id=?').get(id) as Pick<DraftRow, 'payload'> | undefined
    return row ? JSON.parse(row.payload) : null
  }
  latest(episodeId: number, mode?: StoryboardDraftMode, scope?: number[]): StoryboardDraft | null {
    positiveInteger(episodeId, '集ID')
    const clauses = ['episode_id=?'], values: Array<string | number> = [episodeId]
    if (mode !== undefined) { validateMode(mode); clauses.push('mode=?'); values.push(mode) }
    if (scope !== undefined) { clauses.push('scope_key=?'); values.push(JSON.stringify(normalizedScope(scope))) }
    const row = this.sqlite.prepare(`SELECT payload FROM storyboard_drafts WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC,rowid DESC LIMIT 1`)
      .get(...values) as Pick<DraftRow, 'payload'> | undefined
    return row ? JSON.parse(row.payload) : null
  }

  startOrResume(spec: StoryboardDraftSpec): { draft: StoryboardDraft; resumed: boolean; leaseToken: string } {
    positiveInteger(spec.episodeId, '集ID'); positiveInteger(spec.dramaId, '剧ID'); validateMode(spec.mode)
    if (typeof spec.fingerprint !== 'string' || !spec.fingerprint.trim()) throw new Error('草稿指纹不能为空')
    const scope = normalizedScope(spec.scope), scopeKey = JSON.stringify(scope)
    return this.sqlite.transaction(() => {
      const identity = [spec.episodeId, spec.dramaId, spec.mode, scopeKey]
      const busy = this.sqlite.prepare('SELECT id FROM storyboard_drafts WHERE episode_id=? AND drama_id=? AND mode=? AND scope_key=? AND lease_token IS NOT NULL LIMIT 1').get(...identity)
      if (busy) throw new Error('当前草稿正在处理中，请等待任务结束后再继续')
      // Only the newest matching scope is eligible. A historical fingerprint
      // must never silently revive an older version after a newer draft exists.
      const row = this.sqlite.prepare('SELECT payload FROM storyboard_drafts WHERE episode_id=? AND drama_id=? AND mode=? AND scope_key=? ORDER BY created_at DESC,rowid DESC LIMIT 1')
        .get(...identity) as Pick<DraftRow, 'payload'> | undefined
      const previous: StoryboardDraft | undefined = row ? JSON.parse(row.payload) : undefined
      const resumed = Boolean(previous && previous.fingerprint === spec.fingerprint && previous.status !== 'committed')
      const timestamp = new Date().toISOString(), leaseToken = randomUUID()
      const draft: StoryboardDraft = resumed ? { ...previous!, status: 'generating', updatedAt: timestamp }
        : { id: randomUUID(), episodeId: spec.episodeId, dramaId: spec.dramaId, mode: spec.mode, scope,
          fingerprint: spec.fingerprint, status: 'generating', plan: null, groups: [], createdAt: timestamp, updatedAt: timestamp }
      if (resumed) {
        this.write(draft)
        this.sqlite.prepare('UPDATE storyboard_drafts SET lease_token=? WHERE id=?').run(leaseToken, draft.id)
      } else {
        this.sqlite.prepare('INSERT INTO storyboard_drafts(id,episode_id,drama_id,mode,scope_key,fingerprint,status,created_at,updated_at,lease_token,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(draft.id, draft.episodeId, draft.dramaId, draft.mode, scopeKey, draft.fingerprint, draft.status, timestamp, timestamp, leaseToken, JSON.stringify(draft))
      }
      return { draft, resumed, leaseToken }
    }).immediate()
  }

  savePlan(id: string, plan: unknown, leaseToken?: string): StoryboardDraft {
    return this.mutate(id, leaseToken, draft => { draft.plan = snapshot(plan) })
  }
  saveGroup(id: string, group: DraftGroup, leaseToken?: string): StoryboardDraft {
    positiveInteger(group.number, '组号')
    if (!groupStatuses.has(group.status) || !Array.isArray(group.issues) || !Number.isSafeInteger(group.attempts) || group.attempts < 0
      || group.candidate === undefined || group.error !== undefined && typeof group.error !== 'string') throw new Error('草稿分组状态无效')
    return this.mutate(id, leaseToken, draft => {
      const next = snapshot({ number: group.number, status: group.status, candidate: group.candidate, issues: group.issues,
        attempts: group.attempts, ...(group.error !== undefined ? { error: group.error } : {}) })
      if (!Object.hasOwn(next, 'candidate')) throw new Error('草稿候选必须可保存为JSON')
      const index = draft.groups.findIndex(entry => entry.number === group.number)
      if (index < 0) draft.groups.push(next)
      else draft.groups[index] = next
      draft.groups.sort((a, b) => a.number - b.number)
    })
  }
  /** Snapshot both adjacent groups without changing either; a late result must match both snapshots. */
  beginBoundaryRepair(id: string, leftNumber: number, rightNumber: number, expectedLeft: DraftGroup, expectedRight: DraftGroup,
    reason: string, leaseToken?: string): StoryboardDraft {
    positiveInteger(leftNumber, '前组号'); positiveInteger(rightNumber, '后组号')
    if (rightNumber !== leftNumber + 1) throw new Error('衔接修复只能处理相邻两组')
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 4000) throw new Error('衔接修复必须有明确且有限的冲突说明')
    return this.mutate(id, leaseToken, draft => {
      if (draft.mode !== 'breakdown') throw new Error('仅本轮分镜拆解草稿可以联合修复衔接')
      const left = draft.groups.find(group => group.number === leftNumber), right = draft.groups.find(group => group.number === rightNumber)
      if (!left || !right || expectedLeft.number !== leftNumber || expectedRight.number !== rightNumber) throw new Error('相邻草稿不存在或组号不一致')
      if (left.status !== 'ready' || left.candidate === null) throw new Error('前组尚未通过检查，不能开始末态联合修复')
      if (groupHash(left) !== groupHash(expectedLeft) || groupHash(right) !== groupHash(expectedRight)) throw new Error('相邻草稿版本已变化，未开始衔接修复')
      const records = draft.boundaryRepairs || []
      if (records.some(record => record.status === 'running' && [record.left, record.right].some(number => number === leftNumber || number === rightNumber)))
        throw new Error('相邻草稿已有进行中的衔接修复')
      if (records.filter(record => record.left === leftNumber && record.right === rightNumber).length >= 2)
        throw new Error('这两组已达到衔接修复上限，请查看冲突记录')
      if (records.length >= 64) throw new Error('本草稿衔接修复记录已到上限，原稿与审计记录保留')
      const before: [DraftGroup, DraftGroup] = [normalizedGroup(left), normalizedGroup(right)]
      draft.boundaryRepairs = [...records, snapshot({ id: randomUUID(), left: leftNumber, right: rightNumber, status: 'running' as const,
        createdAt: new Date().toISOString(), reason: reason.trim(), beforeHashes: { left: groupHash(left), right: groupHash(right) }, before })]
    })
  }
  /** Replace the two validated groups in one SQLite transaction; no half-applied boundary is exposed. */
  completeBoundaryRepair(id: string, repairId: string, leftGroup: DraftGroup, rightGroup: DraftGroup, leaseToken?: string,
    dependentNext?: { expected: DraftGroup; issue: unknown }): StoryboardDraft {
    const nextLeft = normalizedGroup(leftGroup), nextRight = normalizedGroup(rightGroup)
    const expectedDependent = dependentNext ? normalizedGroup(dependentNext.expected) : undefined
    const dependentIssue = dependentNext ? snapshot(dependentNext.issue) : undefined
    if ([nextLeft, nextRight].some(group => group.status !== 'ready' || group.candidate === null
      || group.issues.some(issue => Boolean(issue && typeof issue === 'object' && (issue as any).severity === 'error'))))
      throw new Error('两组必须共同通过检查后才能保存衔接修复')
    return this.mutate(id, leaseToken, draft => {
      const record = draft.boundaryRepairs?.find(item => item.id === repairId)
      if (!record || record.status !== 'running') throw new Error('衔接修复记录不存在或已经结束')
      if (nextLeft.number !== record.left || nextRight.number !== record.right) throw new Error('衔接修复返回的组号不一致')
      const left = draft.groups.find(group => group.number === record.left), right = draft.groups.find(group => group.number === record.right)
      if (!left || !right || groupHash(left) !== record.beforeHashes.left || groupHash(right) !== record.beforeHashes.right)
        throw new Error('相邻草稿版本已变化，拒绝合并迟到的衔接修复')
      let reopened: DraftGroup | undefined
      if (expectedDependent) {
        const actual = draft.groups.find(group => group.number === expectedDependent.number)
        if (expectedDependent.number !== record.right + 1 || expectedDependent.status !== 'ready' || !actual || actual.status !== 'ready'
          || groupHash(actual) !== groupHash(expectedDependent)) throw new Error('后续草稿版本或状态已变化，未合并两组衔接修复')
        record.dependentBefore = normalizedGroup(actual)
        reopened = { ...actual, status: 'needs_revision', issues: [
          ...actual.issues.filter(issue => !issue || typeof issue !== 'object' || (issue as any).severity !== 'error'), dependentIssue,
        ] }
      }
      draft.groups = draft.groups.map(group => group.number === record.left ? nextLeft : group.number === record.right ? nextRight
        : reopened && group.number === reopened.number ? reopened : group)
      record.status = 'applied'; record.finishedAt = new Date().toISOString()
    })
  }
  /** Record why repair failed while preserving both original/current group contents. */
  failBoundaryRepair(id: string, repairId: string, error: string, leaseToken?: string): StoryboardDraft {
    if (typeof error !== 'string' || !error.trim()) throw new Error('衔接修复失败原因不能为空')
    return this.mutate(id, leaseToken, draft => {
      const record = draft.boundaryRepairs?.find(item => item.id === repairId)
      if (!record || record.status !== 'running') throw new Error('衔接修复记录不存在或已经结束')
      record.status = 'failed'; record.finishedAt = new Date().toISOString(); record.error = safeText(error.slice(0, 4000))
    })
  }
  /** Replace the complete group list after the narrative plan changed (groups no longer in the plan are removed). */
  replaceGroups(id: string, groups: DraftGroup[], leaseToken?: string): StoryboardDraft {
    if (!Array.isArray(groups) || new Set(groups.map(group => group.number)).size !== groups.length) throw new Error('草稿分组状态无效')
    for (const group of groups) {
      positiveInteger(group.number, '组号')
      if (!groupStatuses.has(group.status) || !Array.isArray(group.issues) || !Number.isSafeInteger(group.attempts) || group.attempts < 0
        || group.candidate === undefined || group.error !== undefined && typeof group.error !== 'string') throw new Error('草稿分组状态无效')
    }
    return this.mutate(id, leaseToken, draft => {
      draft.groups = groups.map(group => {
        const next = snapshot({ number: group.number, status: group.status, candidate: group.candidate, issues: group.issues,
          attempts: group.attempts, ...(group.error !== undefined ? { error: group.error } : {}) })
        if (!Object.hasOwn(next, 'candidate')) throw new Error('草稿候选必须可保存为JSON')
        return next
      }).sort((a, b) => a.number - b.number)
    })
  }
  setStatus(id: string, status: StoryboardDraftStatus, leaseToken?: string): StoryboardDraft {
    if (!draftStatuses.has(status)) throw new Error('草稿状态无效')
    return this.mutate(id, leaseToken, draft => {
      if (status === 'committed' && draft.boundaryRepairs?.some(record => record.status === 'running')) throw new Error('衔接修复尚未结束，不能提交草稿')
      draft.status = status
    })
  }
  release(id: string, leaseToken: string): StoryboardDraft {
    return this.sqlite.transaction(() => {
      const row = this.row(id)
      if (row.lease_token !== null) {
        this.assertLease(row, leaseToken)
        this.sqlite.prepare('UPDATE storyboard_drafts SET lease_token=NULL WHERE id=?').run(id)
      }
      return JSON.parse(row.payload) as StoryboardDraft
    }).immediate()
  }

  /** Call once during service startup, never while another service instance owns these drafts. */
  recoverInterrupted(): number {
    return this.sqlite.transaction(() => {
      const rows = this.sqlite.prepare("SELECT payload FROM storyboard_drafts WHERE status='generating' OR lease_token IS NOT NULL").all() as Pick<DraftRow, 'payload'>[]
      for (const row of rows) {
        const draft: StoryboardDraft = JSON.parse(row.payload)
        if (draft.status === 'generating') {
          draft.status = 'interrupted'
          draft.groups = draft.groups.map(group => group.status === 'generating' ? { ...group, status: 'pending' } : group)
        }
        for (const repair of draft.boundaryRepairs || []) if (repair.status === 'running') {
          repair.status = 'failed'; repair.finishedAt = new Date().toISOString(); repair.error = '服务中断，未合并衔接修复；原稿保留'
        }
        draft.updatedAt = new Date().toISOString()
        this.write(draft)
        this.sqlite.prepare('UPDATE storyboard_drafts SET lease_token=NULL WHERE id=?').run(draft.id)
      }
      return rows.length
    }).immediate()
  }
}
