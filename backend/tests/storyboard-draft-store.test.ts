import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { StoryboardDraftStore, type DraftGroup, type StoryboardDraftSpec } from '../src/services/storyboard-draft-store.ts'

const spec: StoryboardDraftSpec = { episodeId: 1, dramaId: 1, mode: 'breakdown', scope: [], fingerprint: 'script-assets-schedule-v1' }
const group = (number: number, status: DraftGroup['status'] = 'ready'): DraftGroup => ({ number, status,
  candidate: { description: `第${number}组原始画面与对白。`, video_prompt: '保留中文、引号“原词”和完整空间叙述。' }, issues: [], attempts: 1 })
function inMemory(run: (store: StoryboardDraftStore, sqlite: Database.Database) => void) {
  const sqlite = new Database(':memory:')
  try { run(new StoryboardDraftStore(sqlite), sqlite) } finally { sqlite.close() }
}
async function temporaryFile(run: (filename: string) => void) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-draft-store-'))
  try { run(path.join(directory, 'drafts.sqlite3')) }
  finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(directory).startsWith('huobao-draft-store-'))
    await fs.rm(directory, { recursive: true, force: true })
  }
}

test('a resumed draft retains its full plan and ready groups, normalizes scope and returns detached snapshots', () => {
  inMemory(store => {
    const first = store.startOrResume({ ...spec, scope: [7, 3, 7] })
    const plan = { slots: [{ number: 1, dialogue: '原文不能丢失。' }], source: '全剧本' }
    store.savePlan(first.draft.id, plan, first.leaseToken)
    store.saveGroup(first.draft.id, group(2), first.leaseToken)
    store.saveGroup(first.draft.id, group(1), first.leaseToken)
    store.setStatus(first.draft.id, 'needs_revision', first.leaseToken)
    assert.throws(() => store.startOrResume({ ...spec, scope: [3, 7] }), /处理中/)
    store.release(first.draft.id, first.leaseToken)
    const resumed = store.startOrResume({ ...spec, scope: [3, 7] })
    assert.equal(first.resumed, false)
    assert.equal(resumed.resumed, true)
    assert.equal(resumed.draft.id, first.draft.id)
    assert.notEqual(resumed.leaseToken, first.leaseToken)
    assert.deepEqual(resumed.draft.scope, [3, 7])
    assert.equal(resumed.draft.status, 'generating')
    assert.deepEqual(resumed.draft.plan, plan)
    assert.deepEqual(resumed.draft.groups, [group(1), group(2)])
    resumed.draft.groups[0].issues.push('mutated outside store')
    plan.slots[0].dialogue = 'mutated caller object'
    assert.deepEqual(store.get(first.draft.id)?.groups, [group(1), group(2)])
    assert.deepEqual(store.latest(1, 'breakdown', [7, 3])?.scope, [3, 7])
    assert.equal((store.get(first.draft.id)?.plan as any).slots[0].dialogue, '原文不能丢失。')
    assert.equal(store.get('missing'), null)
    assert.equal(store.latest(99), null)
  })
})

test('reopening a real temporary SQLite file preserves progress and explicit startup recovery never regenerates anything', async () => {
  await temporaryFile(filename => {
    let sqlite = new Database(filename)
    const firstStore = new StoryboardDraftStore(sqlite), first = firstStore.startOrResume(spec)
    const failed = { ...group(2, 'error'), attempts: 2, issues: [{ code: 'plan', message: '请保留失败原文。' }], error: '校验失败：原词“回来吧”未按顺序覆盖。' }
    const inFlight = { ...group(3, 'generating'), attempts: 1, error: '已有诊断原文' }
    firstStore.savePlan(first.draft.id, { total: 3 }, first.leaseToken)
    for (const value of [group(1), failed, inFlight]) firstStore.saveGroup(first.draft.id, value, first.leaseToken)
    sqlite.close()
    sqlite = new Database(filename)
    try {
      const restarted = new StoryboardDraftStore(sqlite)
      assert.equal(restarted.get(first.draft.id)?.status, 'generating', 'Constructing a second store never steals or recovers an active lease')
      assert.throws(() => restarted.startOrResume(spec), /处理中/)
      assert.equal(restarted.recoverInterrupted(), 1)
      const recovered = restarted.get(first.draft.id)!
      assert.equal(recovered.status, 'interrupted')
      assert.deepEqual(recovered.plan, { total: 3 })
      assert.deepEqual(recovered.groups, [group(1), failed, { ...inFlight, status: 'pending' }])
      assert.equal(restarted.recoverInterrupted(), 0)
      const resumed = restarted.startOrResume(spec)
      assert.equal(resumed.draft.id, first.draft.id)
      assert.equal(resumed.resumed, true)
      assert.deepEqual(resumed.draft.groups[0], group(1))
      assert.throws(() => restarted.saveGroup(first.draft.id, group(1, 'error'), first.leaseToken), /租约/)
      restarted.release(resumed.draft.id, resumed.leaseToken)
    } finally { sqlite.close() }
  })
})

test('fingerprint, mode, scope and drama identity prevent accidental reuse of historical versions', () => {
  inMemory(store => {
    const old = store.startOrResume(spec)
    store.saveGroup(old.draft.id, group(1), old.leaseToken)
    store.release(old.draft.id, old.leaseToken)
    const changed = store.startOrResume({ ...spec, fingerprint: 'script-assets-schedule-v2' })
    assert.equal(changed.resumed, false)
    assert.notEqual(changed.draft.id, old.draft.id)
    assert.deepEqual(changed.draft.groups, [])
    store.release(changed.draft.id, changed.leaseToken)
    const reverted = store.startOrResume(spec)
    assert.equal(reverted.resumed, false, 'Matching an older fingerprint does not revive that old version after a newer draft exists')
    assert.notEqual(reverted.draft.id, old.draft.id)
    assert.deepEqual(store.get(old.draft.id)?.groups, [group(1)])
    store.release(reverted.draft.id, reverted.leaseToken)
    const prompt = store.startOrResume({ ...spec, mode: 'prompt', scope: [5] })
    const otherScope = store.startOrResume({ ...spec, mode: 'prompt', scope: [6] })
    const otherDrama = store.startOrResume({ ...spec, dramaId: 2 })
    assert.ok([prompt, otherScope, otherDrama].every(entry => !entry.resumed))
    assert.equal(store.latest(1, 'prompt', [5])?.id, prompt.draft.id)
    assert.equal(store.latest(1, 'breakdown', [])?.id, otherDrama.draft.id)
    assert.equal(store.latest(1)?.id, otherDrama.draft.id)
    assert.equal(store.latest(1, 'prompt', [])?.id, undefined)
  })
})

test('separate SQLite connections cannot steal leases or write late results after another run resumes', async () => {
  await temporaryFile(filename => {
    const sqliteA = new Database(filename), sqliteB = new Database(filename)
    try {
      const a = new StoryboardDraftStore(sqliteA), b = new StoryboardDraftStore(sqliteB), first = a.startOrResume(spec)
      assert.throws(() => b.startOrResume(spec), /处理中/)
      assert.throws(() => b.startOrResume({ ...spec, fingerprint: 'new-version' }), /处理中/)
      assert.throws(() => b.savePlan(first.draft.id, {}), /租约/)
      assert.throws(() => b.saveGroup(first.draft.id, group(1), 'wrong'), /租约/)
      assert.throws(() => b.setStatus(first.draft.id, 'ready', 'wrong'), /租约/)
      assert.throws(() => b.release(first.draft.id, 'wrong'), /租约/)
      assert.deepEqual(a.get(first.draft.id)?.groups, [])
      a.release(first.draft.id, first.leaseToken)
      const next = b.startOrResume(spec)
      assert.throws(() => a.saveGroup(first.draft.id, group(1), first.leaseToken), /租约/)
      assert.throws(() => a.savePlan(first.draft.id, {}, first.leaseToken), /租约/)
      assert.throws(() => a.setStatus(first.draft.id, 'ready', first.leaseToken), /租约/)
      assert.throws(() => a.release(first.draft.id, first.leaseToken), /租约/)
      b.saveGroup(next.draft.id, group(1), next.leaseToken)
      b.release(next.draft.id, next.leaseToken)
      assert.throws(() => a.saveGroup(first.draft.id, group(1, 'error'), first.leaseToken), /租约/)
      assert.deepEqual(a.get(next.draft.id)?.groups, [group(1)])
    } finally { sqliteB.close(); sqliteA.close() }
  })
})

test('serialization and outer transaction failures roll back complete snapshots without touching existing storyboards', () => {
  inMemory((store, sqlite) => {
    sqlite.exec("CREATE TABLE storyboards (id INTEGER PRIMARY KEY, description TEXT); INSERT INTO storyboards VALUES(1,'existing production-like draft')")
    const first = store.startOrResume(spec)
    store.savePlan(first.draft.id, { original: true }, first.leaseToken)
    store.saveGroup(first.draft.id, group(1), first.leaseToken)
    const before = store.get(first.draft.id), circular: any = {}; circular.self = circular
    assert.throws(() => store.savePlan(first.draft.id, circular, first.leaseToken), /circular/i)
    assert.throws(() => store.saveGroup(first.draft.id, { ...group(2), candidate: circular }, first.leaseToken), /circular/i)
    assert.throws(() => sqlite.transaction(() => {
      store.savePlan(first.draft.id, { shouldRollback: true }, first.leaseToken)
      store.saveGroup(first.draft.id, group(2), first.leaseToken)
      throw new Error('rollback whole operation')
    })(), /rollback whole operation/)
    assert.deepEqual(store.get(first.draft.id), before)
    assert.deepEqual(sqlite.prepare('SELECT * FROM storyboards').all(), [{ id: 1, description: 'existing production-like draft' }])
    assert.throws(() => store.saveGroup(first.draft.id, { ...group(2), number: 0 }, first.leaseToken), /正整数/)
    assert.throws(() => store.saveGroup(first.draft.id, { ...group(2), attempts: -1 }, first.leaseToken), /状态无效/)
    assert.throws(() => store.saveGroup(first.draft.id, { ...group(2), candidate: undefined }, first.leaseToken), /状态无效/)
    assert.throws(() => store.saveGroup(first.draft.id, { ...group(2), candidate: () => 'not JSON' }, first.leaseToken), /JSON/)
    assert.deepEqual(store.get(first.draft.id), before)
  })
})

test('ready drafts retain ready progress during recovery and committed versions cannot be overwritten or reused', () => {
  inMemory(store => {
    const first = store.startOrResume(spec)
    store.saveGroup(first.draft.id, group(1), first.leaseToken)
    store.setStatus(first.draft.id, 'ready', first.leaseToken)
    assert.equal(store.recoverInterrupted(), 1, 'A leftover lease is also cleared when the candidate was already ready')
    assert.equal(store.get(first.draft.id)?.status, 'ready')
    assert.deepEqual(store.get(first.draft.id)?.groups, [group(1)])
    store.setStatus(first.draft.id, 'committed')
    assert.throws(() => store.savePlan(first.draft.id, {}), /已提交/)
    assert.throws(() => store.saveGroup(first.draft.id, group(1, 'error')), /已提交/)
    assert.throws(() => store.setStatus(first.draft.id, 'generating'), /已提交/)
    const fresh = store.startOrResume(spec)
    assert.equal(fresh.resumed, false)
    assert.notEqual(fresh.draft.id, first.draft.id)
    assert.equal(store.get(first.draft.id)?.status, 'committed')
    assert.deepEqual(store.get(first.draft.id)?.groups, [group(1)])
  })
})

test('credential fields and obvious tokens are omitted while failed creative prose and diagnostics remain available', () => {
  inMemory((store, sqlite) => {
    const first = store.startOrResume(spec)
    store.savePlan(first.draft.id, { notes: '正常计划原词', apiKey: 'private-plan-key', nested: { authorization: 'private-auth-key', keep: '保留说明' } }, first.leaseToken)
    store.saveGroup(first.draft.id, { ...group(1, 'needs_revision'),
      candidate: { description: '这份失败分镜原文应完整保留。', api_key: 'private-candidate-key', nested: { accessToken: 'private-access-token' } },
      error: 'HTTP失败 sk-privateToken Bearer privateBearer apiKey=privateLabel https://example.invalid/a?api_key=privateQuery&x=1',
      issues: [{ code: 'plan', message: '失败原词：请再等我一下。', password: 'private-password' }],
    }, first.leaseToken)
    const draft = store.get(first.draft.id)!
    assert.equal((draft.groups[0].candidate as any).description, '这份失败分镜原文应完整保留。')
    assert.deepEqual(draft.groups[0].issues, [{ code: 'plan', message: '失败原词：请再等我一下。' }])
    assert.deepEqual(draft.plan, { notes: '正常计划原词', nested: { keep: '保留说明' } })
    const raw = (sqlite.prepare('SELECT payload FROM storyboard_drafts WHERE id=?').get(first.draft.id) as { payload: string }).payload
    for (const value of ['private-plan-key', 'private-auth-key', 'private-candidate-key', 'private-access-token', 'private-password', 'sk-privateToken', 'privateBearer', 'privateQuery', 'privateLabel']) assert.equal(raw.includes(value), false)
    assert.match(draft.groups[0].error!, /\[redacted\]/)
    assert.equal(raw.includes(first.leaseToken), false, 'Leases are separate from public draft snapshots')
  })
})
