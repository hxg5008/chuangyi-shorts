import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { StoryboardDraftStore, type DraftGroup } from '../src/services/storyboard-draft-store.ts'

const group = (number: number, status: DraftGroup['status'] = 'ready', version = 'old'): DraftGroup => ({
  number, status, candidate: { raw: { result: `${number}-${version}`, description: '原词保持。' }, data: { result: `${number}-${version}` } },
  issues: status === 'ready' ? [] : [{ severity: 'error', code: 'boundary_conflict' }], attempts: 1,
})
function fixture(run: (context: { store: StoryboardDraftStore; id: string; lease: string; left: DraftGroup; right: DraftGroup }) => void, mode: 'breakdown' | 'prompt' = 'breakdown') {
  const db = new Database(':memory:')
  try {
    const store = new StoryboardDraftStore(db), start = store.startOrResume({ episodeId: 1, dramaId: 1, mode, scope: [], fingerprint: 'unchanged-script' })
    const left = group(1), right = group(2, 'needs_revision')
    store.saveGroup(start.draft.id, left, start.leaseToken); store.saveGroup(start.draft.id, right, start.leaseToken)
    store.saveGroup(start.draft.id, group(3), start.leaseToken)
    run({ store, id: start.draft.id, lease: start.leaseToken, left, right })
  } finally { db.close() }
}

test('boundary begin preserves both groups and stores a detached audit; completion replaces both together', () => fixture(({store,id,lease,left,right}) => {
  const started = store.beginBoundaryRepair(id, 1, 2, left, right, '前组末态与松手动作冲突', lease)
  const record = started.boundaryRepairs!.at(-1)!
  assert.deepEqual(started.groups, [left, right, group(3)])
  assert.deepEqual(record.before, [left, right]); assert.equal(record.status, 'running')
  assert.equal(record.beforeHashes.left.length, 64)
  ;(left.candidate as any).raw.result = 'external mutation'
  assert.equal((store.get(id)!.boundaryRepairs![0].before[0].candidate as any).raw.result, '1-old')
  const nextLeft = group(1, 'ready', 'fixed'), nextRight = group(2, 'ready', 'fixed')
  const completed = store.completeBoundaryRepair(id, record.id, nextLeft, nextRight, lease)
  assert.deepEqual(completed.groups, [nextLeft, nextRight, group(3)])
  assert.equal(completed.boundaryRepairs![0].status, 'applied')
  assert.ok(completed.boundaryRepairs![0].finishedAt)
  assert.equal((completed.boundaryRepairs![0].before[0].candidate as any).raw.result, '1-old')
  assert.throws(() => store.completeBoundaryRepair(id, record.id, nextLeft, nextRight, lease), /已经结束/)
}))

test('stale group snapshots refuse start and stale completion never replaces either group', () => fixture(({store,id,lease,left,right}) => {
  assert.throws(() => store.beginBoundaryRepair(id,1,2,group(1,'ready','stale'),right,'冲突',lease), /版本已变化/)
  const started=store.beginBoundaryRepair(id,1,2,left,right,'冲突',lease), record=started.boundaryRepairs![0]
  const intervening=group(2,'ready','intervening'); store.saveGroup(id,intervening,lease)
  assert.throws(() => store.completeBoundaryRepair(id,record.id,group(1,'ready','fixed'),group(2,'ready','fixed'),lease), /版本已变化/)
  assert.deepEqual(store.get(id)!.groups,[left,intervening,group(3)])
  store.failBoundaryRepair(id,record.id,'版本已变化',lease)
  assert.deepEqual(store.get(id)!.groups,[left,intervening,group(3)])
}))

test('failed boundary repair only marks audit failed and can try once more; third attempt is bounded', () => fixture(({store,id,lease,left,right}) => {
  for(let attempt=0;attempt<2;attempt++){
    const draft=store.beginBoundaryRepair(id,1,2,left,right,'冲突',lease),record=draft.boundaryRepairs!.at(-1)!
    assert.throws(()=>store.beginBoundaryRepair(id,1,2,left,right,'冲突',lease),/进行中/)
    store.failBoundaryRepair(id,record.id,'模型未返回可用修复 Bearer mock-secret',lease)
    assert.deepEqual(store.get(id)!.groups,[left,right,group(3)])
    assert.match(store.get(id)!.boundaryRepairs!.at(-1)!.error!,/\[redacted\]/)
  }
  assert.throws(()=>store.beginBoundaryRepair(id,1,2,left,right,'冲突',lease),/上限/)
  assert.equal(store.get(id)!.boundaryRepairs!.length,2)
}))

test('adjacency, existence, mode, and both successful candidates are required', () => {
  fixture(({store,id,lease,left,right})=>{
    assert.throws(()=>store.beginBoundaryRepair(id,1,3,left,group(3),'冲突',lease),/相邻/)
    assert.throws(()=>store.beginBoundaryRepair(id,3,4,group(3),group(4),'冲突',lease),/不存在/)
    const draft=store.beginBoundaryRepair(id,1,2,left,right,'冲突',lease),record=draft.boundaryRepairs![0]
    assert.throws(()=>store.completeBoundaryRepair(id,record.id,group(1),group(2,'needs_revision'),lease),/共同通过/)
    assert.throws(()=>store.completeBoundaryRepair(id,record.id,group(2),group(3),lease),/组号不一致/)
    const errorReady=group(2);errorReady.issues=[{severity:'error',code:'still-invalid'}]
    assert.throws(()=>store.completeBoundaryRepair(id,record.id,group(1),errorReady,lease),/共同通过/)
    assert.deepEqual(store.get(id)!.groups,[left,right,group(3)])
  })
  fixture(({store,id,lease,left,right})=>assert.throws(()=>store.beginBoundaryRepair(id,1,2,left,right,'冲突',lease),/拆解草稿/),'prompt')
})

test('lease and committed draft prevent repair writes', () => fixture(({store,id,lease,left,right})=>{
  assert.throws(()=>store.beginBoundaryRepair(id,1,2,left,right,'冲突','wrong'),/租约/)
  const draft=store.beginBoundaryRepair(id,1,2,left,right,'冲突',lease),record=draft.boundaryRepairs![0]
  assert.throws(()=>store.completeBoundaryRepair(id,record.id,group(1),group(2),'wrong'),/租约/)
  assert.throws(()=>store.failBoundaryRepair(id,record.id,'失败','wrong'),/租约/)
  assert.throws(()=>store.setStatus(id,'committed',lease),/尚未结束/)
  store.failBoundaryRepair(id,record.id,'不修改',lease);store.setStatus(id,'committed',lease)
  assert.throws(()=>store.beginBoundaryRepair(id,1,2,left,right,'冲突',lease),/已提交/)
}))

test('startup interruption closes in-flight repair without changing the original groups', () => fixture(({store,id,lease,left,right})=>{
  store.beginBoundaryRepair(id,1,2,left,right,'冲突',lease)
  assert.equal(store.recoverInterrupted(),1)
  const current=store.get(id)!
  assert.equal(current.status,'interrupted');assert.deepEqual(current.groups,[left,right,group(3)])
  assert.equal(current.boundaryRepairs![0].status,'failed')
  assert.match(current.boundaryRepairs![0].error!,/原稿保留/)
}))

test('audit reaches the full-draft cap without truncating retained before snapshots', () => fixture(({store,id,lease})=>{
  for(let number=1;number<=66;number++)store.saveGroup(id,group(number),lease)
  for(let pair=0;pair<32;pair++)for(let attempt=0;attempt<2;attempt++){
    const left=pair*2+1,right=left+1
    const begun=store.beginBoundaryRepair(id,left,right,group(left),group(right),'明确相邻状态冲突',lease)
    store.failBoundaryRepair(id,begun.boundaryRepairs!.at(-1)!.id,'保留审计',lease)
  }
  const before=store.get(id)!
  assert.equal(before.boundaryRepairs!.length,64)
  assert.deepEqual(before.boundaryRepairs![0].before,[group(1),group(2)])
  assert.throws(()=>store.beginBoundaryRepair(id,65,66,group(65),group(66),'新冲突',lease),/上限/)
  assert.deepEqual(store.get(id)!.boundaryRepairs,before.boundaryRepairs)
}))

test('completion atomically reopens the following ready group without changing its candidate and audits its before state', () => fixture(({store,id,lease,left,right})=>{
  const following=group(3)
  following.issues=[{severity:'warning',code:'keep-warning'}, {severity:'error',code:'stale-error'}]
  store.saveGroup(id,following,lease)
  const begun=store.beginBoundaryRepair(id,1,2,left,right,'当前组新末态需要后续复核',lease),record=begun.boundaryRepairs![0]
  const reviewIssue={severity:'error',code:'boundary_review',message:'第2组末态已修复，请核对第3组首镜'}
  const completed=store.completeBoundaryRepair(id,record.id,group(1,'ready','fixed'),group(2,'ready','fixed'),lease,{expected:following,issue:reviewIssue})
  const reopened=completed.groups.find(item=>item.number===3)!
  assert.equal(reopened.status,'needs_revision')
  assert.deepEqual(reopened.candidate,following.candidate)
  assert.equal(reopened.attempts,following.attempts)
  assert.deepEqual(reopened.issues,[{severity:'warning',code:'keep-warning'},reviewIssue])
  assert.deepEqual(completed.boundaryRepairs![0].dependentBefore,following)
  assert.equal(completed.boundaryRepairs![0].status,'applied')
}))

test('a stale or nonadjacent dependent group rejects the complete boundary transaction', () => fixture(({store,id,lease,left,right})=>{
  const begun=store.beginBoundaryRepair(id,1,2,left,right,'当前组新末态需要后续复核',lease),record=begun.boundaryRepairs![0]
  const changed=group(3,'ready','changed');store.saveGroup(id,changed,lease)
  const issue={severity:'error',code:'boundary_review'}
  assert.throws(()=>store.completeBoundaryRepair(id,record.id,group(1,'ready','fixed'),group(2,'ready','fixed'),lease,{expected:group(3),issue}),/后续草稿版本或状态/)
  assert.deepEqual(store.get(id)!.groups,[left,right,changed])
  assert.equal(store.get(id)!.boundaryRepairs![0].status,'running')
  assert.equal(store.get(id)!.boundaryRepairs![0].dependentBefore,undefined)
  assert.throws(()=>store.completeBoundaryRepair(id,record.id,group(1,'ready','fixed'),group(2,'ready','fixed'),lease,{expected:group(4),issue}),/后续草稿版本或状态/)
  const notReady=group(3,'needs_revision');store.saveGroup(id,notReady,lease)
  assert.throws(()=>store.completeBoundaryRepair(id,record.id,group(1,'ready','fixed'),group(2,'ready','fixed'),lease,{expected:notReady,issue}),/后续草稿版本或状态/)
  assert.deepEqual(store.get(id)!.groups,[left,right,notReady])
}))
