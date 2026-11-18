import type Database from 'better-sqlite3'

export type ActivitySourceType = 'media' | 'agent_jobs' | 'merge'
export interface SourceRevision {
  source_type: ActivitySourceType
  source_id: string
  revision: number
  deleted: number
}
const sources = [
  {
    type: 'media' as const,
    table: 'sys_task',
    columns: [
      'type',
      'status',
      'stage',
      'params',
      'task_id',
      'result_url',
      'local_path',
      'error_msg',
      'error_code',
      'completed_at',
      'model',
      'provider',
      'prompt',
      'config_id',
      'drama_id',
      'storyboard_id',
      'character_id',
      'scene_id',
      'prop_id',
      'created_at'
    ]
  },
  {
    type: 'agent_jobs' as const,
    table: 'agent_jobs',
    columns: ['status', 'payload', 'episode_id', 'scope', 'started_at']
  },
  {
    type: 'merge' as const,
    table: 'video_merges',
    columns: [
      'status',
      'params',
      'stage',
      'task_id',
      'merged_url',
      'local_path',
      'result_url',
      'error_msg',
      'title',
      'model',
      'provider',
      'drama_id',
      'episode_id',
      'created_at',
      'completed_at',
      'deleted_at'
    ]
  }
]

/** Durable change notifications contain IDs/revisions only, never creative payloads. */
export class ActivitySourceJournal {
  private schemaVersion = -1
  private available = new Set<ActivitySourceType>()
  constructor(readonly database: Database.Database) {
    database.exec(`CREATE TABLE IF NOT EXISTS platform_activity_source_revisions(
      source_type TEXT NOT NULL,source_id TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(source_type,source_id));
      CREATE TABLE IF NOT EXISTS platform_activity_source_dirty(
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,source_type TEXT NOT NULL,source_id TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,UNIQUE(source_type,source_id));
      CREATE TABLE IF NOT EXISTS platform_activity_source_backfill(source_type TEXT PRIMARY KEY,cursor INTEGER NOT NULL DEFAULT 0,complete INTEGER NOT NULL DEFAULT 0);`)
    this.refresh()
  }
  refresh() {
    if (Number(this.database.pragma('schema_version', { simple: true })) === this.schemaVersion) return
    this.database.transaction(() => {
      this.available.clear()
      for (const source of sources) {
        if (
          !this.database
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
            .get(source.table)
        )
          continue
        this.available.add(source.type)
        const columns = (this.database.prepare(`PRAGMA table_info(${source.table})`).all() as any[]).map(
          (column) => column.name
        )
        const tracked = source.columns.filter((column) => columns.includes(column))
        if (!columns.includes('id') || !tracked.length) continue
        this.database
          .prepare('INSERT OR IGNORE INTO platform_activity_source_backfill(source_type)VALUES(?)')
          .run(source.type)
        for (const event of ['INSERT', 'UPDATE', 'DELETE'] as const) {
          const name = `platform_activity_${source.type}_${event.toLowerCase()}_v1`,
            alias = event === 'DELETE' ? 'OLD' : 'NEW',
            deleted = event === 'DELETE' ? 1 : 0
          const body = `INSERT INTO platform_activity_source_revisions(source_type,source_id,revision,deleted)
            VALUES('${source.type}',cast(${alias}.id AS TEXT),1,${deleted})
            ON CONFLICT(source_type,source_id) DO UPDATE SET revision=revision+1,deleted=excluded.deleted;
            INSERT INTO platform_activity_source_dirty(source_type,source_id,revision,deleted)
            SELECT source_type,source_id,revision,deleted FROM platform_activity_source_revisions WHERE source_type='${source.type}' AND source_id=cast(${alias}.id AS TEXT)
            ON CONFLICT(source_type,source_id) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted;`
          const update = event === 'UPDATE' ? ` OF ${tracked.join(',')}` : ''
          const condition =
            event === 'UPDATE'
              ? ` WHEN ${tracked.map((column) => `NEW.${column} IS NOT OLD.${column}`).join(' OR ')}`
              : ''
          const trigger = `CREATE TRIGGER ${name} AFTER ${event}${update} ON ${source.table}${condition} BEGIN ${body} END`
          const old = this.database
            .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?")
            .get(name) as any
          if (old?.sql !== trigger) {
            this.database.exec(`DROP TRIGGER IF EXISTS ${name}`)
            this.database.exec(trigger)
          }
        }
      }
    })()
    this.schemaVersion = Number(this.database.pragma('schema_version', { simple: true }))
  }
  hasSource(type: ActivitySourceType) {
    return this.available.has(type)
  }
  /** One bounded ID-only pass establishes a revision baseline, including missing historical logs. */
  backfill(limit = 500) {
    this.refresh()
    let visited = 0
    const seed = this.database.prepare(
      'INSERT OR IGNORE INTO platform_activity_source_revisions(source_type,source_id,revision,deleted)VALUES(?,?,1,0)'
    )
    const known = this.database.prepare(
      'SELECT 1 FROM platform_activity_source_revisions r JOIN platform_activity_tasks a ON a.source_type=r.source_type AND a.source_id=r.source_id WHERE r.source_type=? AND r.source_id=?'
    )
    const queue = this.database
      .prepare(`INSERT INTO platform_activity_source_dirty(source_type,source_id,revision,deleted)
      SELECT source_type,source_id,revision,deleted FROM platform_activity_source_revisions WHERE source_type=? AND source_id=?
      ON CONFLICT(source_type,source_id) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted`)
    this.database.transaction(() => {
      for (const source of sources) {
        if (!this.available.has(source.type) || visited >= limit) continue
        const state = this.database
          .prepare('SELECT cursor,complete FROM platform_activity_source_backfill WHERE source_type=?')
          .get(source.type) as any
        if (state.complete) continue
        const rows = this.database
          .prepare(
            `SELECT rowid AS journal_rowid,cast(id AS TEXT) AS source_id FROM ${source.table} WHERE rowid>? ORDER BY rowid LIMIT ?`
          )
          .all(state.cursor, limit - visited) as any[]
        for (const row of rows) {
          if (!known.get(source.type, row.source_id)) {
            seed.run(source.type, row.source_id)
            queue.run(source.type, row.source_id)
          }
        }
        const complete = rows.length < limit - visited
        if (rows.length)
          this.database
            .prepare('UPDATE platform_activity_source_backfill SET cursor=?,complete=? WHERE source_type=?')
            .run(rows.at(-1).journal_rowid, complete ? 1 : 0, source.type)
        else
          this.database
            .prepare('UPDATE platform_activity_source_backfill SET complete=1 WHERE source_type=?')
            .run(source.type)
        visited += rows.length
      }
    })()
    return visited
  }
  pending(limit = 500): SourceRevision[] {
    return this.database
      .prepare(
        'SELECT source_type,source_id,revision,deleted FROM platform_activity_source_dirty ORDER BY sequence LIMIT ?'
      )
      .all(limit) as SourceRevision[]
  }
  revision(type: ActivitySourceType, id: string): SourceRevision | null {
    return (
      (this.database
        .prepare(
          'SELECT source_type,source_id,revision,deleted FROM platform_activity_source_dirty WHERE source_type=? AND source_id=?'
        )
        .get(type, id) as SourceRevision) || null
    )
  }
  acknowledge(seen: SourceRevision) {
    return (
      this.database
        .prepare(
          'DELETE FROM platform_activity_source_dirty WHERE source_type=? AND source_id=? AND revision=?'
        )
        .run(seen.source_type, seen.source_id, seen.revision).changes === 1
    )
  }
  counts() {
    return {
      dirty: Number(
        (this.database.prepare('SELECT count(*) AS count FROM platform_activity_source_dirty').get() as any)
          .count
      ),
      backfillPending: Number(
        (
          this.database
            .prepare('SELECT count(*) AS count FROM platform_activity_source_backfill WHERE complete=0')
            .get() as any
        ).count
      )
    }
  }
}
