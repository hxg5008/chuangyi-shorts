import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-source-journal-'))
const databasePath = path.join(root, 'journal.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.SQLITE_PATH = databasePath
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.ts')
const security = await import('../src/services/platform-security/index.ts')
security.initPlatformSecurity()
const owner = security.createUser('journal_owner', 'Synthetic-journal-password').user
const timestamp = '2026-11-07T01:00:00.000Z'
const project = db
  .insert(schema.dramas)
  .values({ title: 'Journal ownership', ownerUserId: owner.id, createdAt: timestamp, updatedAt: timestamp })
  .returning()
  .get()
const episode = db
  .insert(schema.episodes)
  .values({
    dramaId: project.id,
    episodeNumber: 1,
    title: 'Episode',
    createdAt: timestamp,
    updatedAt: timestamp
  })
  .returning()
  .get()
const activity = await import('../src/services/activity/store.ts')
const sql = db.$client
const insert = sql.prepare(
  'INSERT INTO sys_task(type,drama_id,status,stage,params,created_at,updated_at)VALUES(?,?,?,?,?,?,?)'
)
const historical: number[] = []
sql.transaction(() => {
  for (let index = 0; index < 1205; index++)
    historical.push(
      Number(
        insert.run('image', project.id, 'completed', 'completed', '{}', timestamp, timestamp).lastInsertRowid
      )
    )
})()
const previouslyLogged = activity.ensureActivitySource({
  kind: 'image',
  title: 'Pre-journal source',
  projectId: project.id,
  sourceType: 'media',
  sourceId: String(historical[0]),
  createdAt: timestamp
})
const { syncActivitySources, syncMediaActivity, activitySourceSyncDiagnostics } =
  await import('../src/services/activity/source-sync.ts')
const { ActivitySourceJournal } = await import('../src/services/activity/source-journal.ts')
const journal = new ActivitySourceJournal(sql)
const sourceCount = (type: string) =>
  Number(
    (sql.prepare('SELECT count(*) n FROM platform_activity_tasks WHERE source_type=?').get(type) as any).n
  )
const eventCount = () =>
  Number((sql.prepare('SELECT count(*) n FROM platform_activity_events').get() as any).n)
function drain() {
  for (let index = 0; index < 20; index++) {
    syncActivitySources(true)
    const state = activitySourceSyncDiagnostics()
    if (!state.dirty && !state.backfillPending) return
  }
  assert.fail('Source journal did not drain bounded backfill pages')
}

test('cold history uses bounded ID pages and resumes its cursor from another connection without timestamp assumptions', () => {
  syncActivitySources(true)
  assert.equal(sourceCount('media'), 500)
  assert.equal(activity.activityTask(previouslyLogged).status, 'completed')
  const cursor = (
    sql.prepare("SELECT cursor FROM platform_activity_source_backfill WHERE source_type='media'").get() as any
  ).cursor
  assert.equal(cursor, historical[499])
  const connection = new Database(databasePath)
  try {
    const schemaVersion = connection.pragma('schema_version', { simple: true })
    const restarted = new ActivitySourceJournal(connection)
    assert.equal(
      connection.pragma('schema_version', { simple: true }),
      schemaVersion,
      'Unchanged persisted triggers must not be rebuilt on restart'
    )
    assert.equal(
      (
        connection
          .prepare("SELECT cursor FROM platform_activity_source_backfill WHERE source_type='media'")
          .get() as any
      ).cursor,
      cursor
    )
    assert.equal(restarted.counts().dirty, 0)
  } finally {
    connection.close()
  }
  syncActivitySources(true)
  assert.equal(sourceCount('media'), 1000)
  syncActivitySources(true)
  assert.equal(sourceCount('media'), 1205)
  assert.equal(activitySourceSyncDiagnostics().backfillPending, 0)
  const log = activity.activitySource('media', String(historical.at(-1)))
  assert.equal(log.user_id, owner.id)
  assert.equal(log.project_id, project.id)
})

const active: number[] = []
test('1000 unchanged active tasks with large params incur zero further source reads, parses or activity events', () => {
  const params = JSON.stringify({
    progress: 0,
    protocolSnapshot: { manifest: { documentation: 'large-manifest-data-'.repeat(1700) } },
    referenceImages: ['data:image/png;base64,' + 'A'.repeat(5000)]
  })
  sql.transaction(() => {
    for (let index = 0; index < 1000; index++) {
      const id = Number(
        insert.run('image', project.id, 'processing', 'polling', params, timestamp, timestamp).lastInsertRowid
      )
      active.push(id)
      assert(syncMediaActivity(id))
    }
  })()
  assert.equal(journal.counts().dirty, 0)
  const before = activitySourceSyncDiagnostics(),
    events = eventCount()
  syncActivitySources(true)
  syncActivitySources(true)
  const after = activitySourceSyncDiagnostics()
  assert.equal(after.mediaReads, before.mediaReads)
  assert.equal(after.mediaParses, before.mediaParses)
  assert.equal(after.agentReads, before.agentReads)
  assert.equal(eventCount(), events)
  assert.equal(after.dirty, 0)
})

test('multiple same-millisecond params/status changes are observed, but equal values and timestamp-only updates stay clean', () => {
  const id = active[0],
    before = activitySourceSyncDiagnostics()
  sql.prepare('UPDATE sys_task SET params=?,updated_at=? WHERE id=?').run('{"progress":42}', timestamp, id)
  assert.equal(journal.counts().dirty, 1)
  syncActivitySources(true)
  let log = activity.activitySource('media', String(id))
  assert.equal(activity.activityTaskView(log).progress, 42)
  sql
    .prepare(
      "UPDATE sys_task SET status='failed',stage='failed',error_msg='same clock failure',updated_at=? WHERE id=?"
    )
    .run(timestamp, id)
  syncActivitySources(true)
  log = activity.activitySource('media', String(id))
  assert.equal(log.status, 'failed')
  assert.equal(log.error, 'same clock failure')
  assert.equal(activitySourceSyncDiagnostics().mediaReads, before.mediaReads + 2)
  const events = eventCount(),
    reads = activitySourceSyncDiagnostics().mediaReads
  sql.prepare('UPDATE sys_task SET params=params,updated_at=? WHERE id=?').run(timestamp, id)
  sql.prepare('UPDATE sys_task SET updated_at=? WHERE id=?').run('2026-11-07T01:00:00.001Z', id)
  assert.equal(journal.counts().dirty, 0)
  syncActivitySources(true)
  assert.equal(eventCount(), events)
  assert.equal(activitySourceSyncDiagnostics().mediaReads, reads)
})

test('late agent_jobs installation and more than 500 merges/jobs backfill without rereading unchanged active media', async () => {
  const { AgentJobStore } = await import('../src/services/agent-job-store.ts')
  new AgentJobStore(sql)
  const jobs = sql.prepare(
    'INSERT INTO agent_jobs(id,episode_id,status,scope,started_at,payload)VALUES(?,?,?,?,?,?)'
  )
  sql.transaction(() => {
    for (let index = 0; index < 620; index++) {
      const id = 'historical-job-' + index,
        payload = {
          id,
          episode_id: episode.id,
          drama_id: project.id,
          agent_type: 'storyboard_breaker',
          status: 'done',
          scope: 'history',
          phase: 'complete',
          started_at: timestamp,
          updated_at: timestamp,
          total: 1,
          completed: 1,
          failed: 0,
          attempt: 1,
          model_calls: 2,
          repair_calls: 0,
          issues: []
        }
      jobs.run(id, episode.id, 'done', 'history', timestamp, JSON.stringify(payload))
    }
    const merges = sql.prepare(
      "INSERT INTO video_merges(drama_id,title,provider,model,status,created_at,completed_at)VALUES(?,'Existing merge','synthetic','synthetic','completed',?,?)"
    )
    for (let index = 0; index < 610; index++) merges.run(project.id, timestamp, timestamp)
  })()
  const mediaReads = activitySourceSyncDiagnostics().mediaReads
  drain()
  assert.equal(sourceCount('agent_jobs'), 620)
  assert.equal(sourceCount('merge'), 610)
  assert.equal(activitySourceSyncDiagnostics().mediaReads, mediaReads)
  assert.equal(activity.activitySource('agent_jobs', 'historical-job-619').user_id, owner.id)
  const row = sql.prepare('SELECT payload FROM agent_jobs WHERE id=?').get('historical-job-0') as any
  const changed = JSON.parse(row.payload)
  changed.failed = 1
  changed.issues = [{ message: 'same timestamp issue' }]
  changed.model_calls = 3
  sql.prepare('UPDATE agent_jobs SET payload=? WHERE id=?').run(JSON.stringify(changed), 'historical-job-0')
  syncActivitySources(true)
  const result = activity.activityTaskView(activity.activitySource('agent_jobs', 'historical-job-0')).result
  assert.equal(result.failed, 1)
  assert.equal(result.model_calls, 3)
  assert.equal(result.issues[0].message, 'same timestamp issue')
})

test('revision acknowledgements cannot erase another connection change and source deletion keeps the already-stored log', () => {
  const id = Number(
    insert.run('video', project.id, 'processing', 'polling', '{}', timestamp, timestamp).lastInsertRowid
  )
  const seen = journal.revision('media', String(id))!
  const connection = new Database(databasePath)
  connection.pragma('busy_timeout=5000')
  try {
    connection
      .prepare('UPDATE sys_task SET params=?,updated_at=? WHERE id=?')
      .run('{"progress":77}', timestamp, id)
    assert.equal(journal.acknowledge(seen), false)
    assert(journal.revision('media', String(id))!.revision > seen.revision)
    syncActivitySources(true)
    const log = activity.activitySource('media', String(id)),
      events = eventCount()
    assert.equal(activity.activityTaskView(log).progress, 77)
    connection.prepare('DELETE FROM sys_task WHERE id=?').run(id)
    const deletion = journal.revision('media', String(id))!
    assert.equal(deletion.deleted, 1)
    const reads = activitySourceSyncDiagnostics().mediaReads
    syncActivitySources(true)
    assert.deepEqual(activity.activitySource('media', String(id)), log)
    assert.equal(eventCount(), events)
    assert.equal(activitySourceSyncDiagnostics().mediaReads, reads)
    const restarted = new ActivitySourceJournal(connection)
    assert.equal(restarted.counts().dirty, 0)
  } finally {
    connection.close()
  }
})

test('hard-deleted jobs and soft-deleted merges retain history, and repeated source revisions coalesce safely', () => {
  const job = activity.activitySource('agent_jobs', 'historical-job-1')
  const merge = sql.prepare('SELECT id FROM video_merges ORDER BY id LIMIT 1').get() as any
  const oldMerge = activity.activitySource('merge', String(merge.id)),
    events = eventCount()
  sql.prepare('DELETE FROM agent_jobs WHERE id=?').run('historical-job-1')
  sql.prepare('UPDATE video_merges SET deleted_at=? WHERE id=?').run(timestamp, merge.id)
  syncActivitySources(true)
  assert.deepEqual(activity.activitySource('agent_jobs', 'historical-job-1'), job)
  assert.deepEqual(activity.activitySource('merge', String(merge.id)), oldMerge)
  assert.equal(eventCount(), events)
  const id = active[1],
    first = journal.revision('media', String(id))
  assert.equal(first, null)
  for (let index = 0; index < 20; index++)
    sql.prepare('UPDATE sys_task SET params=? WHERE id=?').run(JSON.stringify({ progress: index }), id)
  const pending = journal
    .pending()
    .filter((row) => row.source_type === 'media' && row.source_id === String(id))
  assert.equal(pending.length, 1)
  assert(pending[0].revision >= 20)
  syncActivitySources(true)
  assert.equal(activity.activityTaskView(activity.activitySource('media', String(id))).progress, 19)
  assert.equal(journal.counts().dirty, 0)
})

test.after(async () => {
  sql.close()
  const relative = path.relative(os.tmpdir(), root)
  assert(
    relative &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      path.basename(root).startsWith('huobao-source-journal-')
  )
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
