import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { AgentJobStore } from '../src/services/agent-job-store.ts'

const spec = { agent_type: 'prompt_generator', scope: 'agent' as const, episode_id: 1, drama_id: 1, storyboard_ids: [5] }

test('repeated starts attach to the same job and conflicting scopes cannot overwrite it', () => {
  const sqlite = new Database(':memory:')
  try {
    const store = new AgentJobStore(sqlite)
    const first = store.start(spec), second = store.start(spec)
    assert.equal(second.job.id, first.job.id); assert.equal(second.alreadyRunning, true)
    assert.throws(() => store.start({ ...spec, storyboard_ids: [6] }), /执行中/)
    assert.throws(() => store.start({ ...spec, agent_type: 'storyboard_breaker' }), /执行中/)
    assert.equal(store.list(1).length, 1)
  } finally { sqlite.close() }
})

test('progress is durable and a restarted service marks interrupted jobs without resubmission', () => {
  const sqlite = new Database(':memory:')
  try {
    const store = new AgentJobStore(sqlite), { job } = store.start(spec)
    store.update(job.id, { phase: 'repairing', attempt: 1 })
    const restarted = new AgentJobStore(sqlite)
    assert.equal(restarted.get(job.id)?.phase, 'repairing')
    assert.equal(restarted.recoverInterrupted(), 1)
    assert.equal(restarted.get(job.id)?.status, 'error'); assert.equal(restarted.active(1), null)
    assert.match(restarted.get(job.id)?.error || '', /旧稿已保留/)
    assert.equal(restarted.recoverInterrupted(), 0)
  } finally { sqlite.close() }
})

test('terminal states cannot be overwritten by late completions and credentials are redacted', () => {
  const sqlite = new Database(':memory:')
  try {
    const store = new AgentJobStore(sqlite), { job } = store.start(spec)
    store.update(job.id, { status: 'needs_revision', phase: 'needs_revision', issues: [{ code: 'test', message: 'sk-testSecret Bearer otherSecret' }] })
    store.update(job.id, { status: 'done', phase: 'done', issues: [] })
    const current = store.get(job.id)!
    assert.equal(current.status, 'needs_revision'); assert.ok(current.finished_at)
    assert.ok(!JSON.stringify(current).includes('testSecret')); assert.ok(!JSON.stringify(current).includes('otherSecret'))
    assert.equal(store.start(spec).alreadyRunning, false)
  } finally { sqlite.close() }
})
