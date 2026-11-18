import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPollingScope } from '../app/utils/polling-scope.js'

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

function fakeTimers() {
  let nextId = 0
  const pending = new Map()
  return {
    pending,
    setTimer(callback, delay) { const id = ++nextId; pending.set(id, { callback, delay }); return id },
    clearTimer(id) { pending.delete(id) },
    async next() {
      const [id, timer] = pending.entries().next().value ?? []
      assert.ok(timer, 'a poll should still be scheduled')
      pending.delete(id)
      timer.callback()
      await flush()
    },
  }
}

test('polling continues beyond former attempt limits and refreshes once on the last terminal task', async () => {
  const clock = fakeTimers()
  const scope = createPollingScope(clock)
  let polls = 0
  let terminalRefreshes = 0
  scope.start('images', async () => {
    polls++
    if (polls < 45) return true
    await Promise.resolve() // The final asset refresh must finish even when no active tasks remain.
    terminalRefreshes++
    return false
  }, 2500)
  for (let i = 0; i < 45; i++) await clock.next()
  assert.equal(polls, 45)
  assert.equal(terminalRefreshes, 1)
  assert.equal(clock.pending.size, 0)
})

test('the same key never overlaps or adds timers while its request is in flight', async () => {
  const clock = fakeTimers()
  const scope = createPollingScope(clock)
  let release
  let calls = 0
  const request = new Promise(resolve => { release = resolve })
  scope.start('tasks', async () => { calls++; await request; return true })
  scope.start('tasks', () => { throw new Error('duplicate callback must not run') })
  assert.equal(clock.pending.size, 1)
  await clock.next()
  assert.equal(calls, 1)
  assert.equal(clock.pending.size, 0)
  scope.start('tasks', () => { calls += 100 })
  assert.equal(clock.pending.size, 0)
  release()
  await flush()
  assert.equal(calls, 1)
  assert.equal(clock.pending.size, 1)
  scope.dispose()
})

test('temporary request failures are retried rather than silently ending the busy indicator', async () => {
  const clock = fakeTimers()
  const scope = createPollingScope(clock)
  let attempts = 0
  scope.start('tasks', async () => {
    if (++attempts < 3) throw new Error('temporary network failure')
    return false
  })
  for (let i = 0; i < 3; i++) await clock.next()
  assert.equal(attempts, 3)
  assert.equal(clock.pending.size, 0)
})

test('stop clears its timer, and dispose clears all polls and delayed callbacks', async () => {
  const clock = fakeTimers()
  const scope = createPollingScope(clock)
  let callbacks = 0
  scope.start('tasks', () => { callbacks++; return true })
  scope.start('extract', () => { callbacks++; return true })
  scope.later(() => { callbacks++ }, 900)
  assert.equal(clock.pending.size, 3)
  scope.stop('tasks')
  assert.equal(clock.pending.size, 2)
  scope.dispose()
  assert.equal(scope.active, false)
  assert.equal(clock.pending.size, 0)
  scope.start('after-unmount', () => { callbacks++ }, 1, true)
  scope.later(() => { callbacks++ }, 1)
  await flush()
  assert.equal(callbacks, 0)
})

test('disposing during a request prevents its completion from rearming a timer', async () => {
  const clock = fakeTimers()
  const scope = createPollingScope(clock)
  let release
  const request = new Promise(resolve => { release = resolve })
  let callbacks = 0
  scope.start('tasks', async () => { callbacks++; await request; return true }, 2500, true)
  assert.equal(callbacks, 1)
  scope.dispose()
  release()
  await flush()
  assert.equal(clock.pending.size, 0)
  assert.equal(callbacks, 1)
})

test('stopping an in-flight key allows a replacement without reviving the old job', async () => {
  const clock = fakeTimers()
  const scope = createPollingScope(clock)
  let release
  const request = new Promise(resolve => { release = resolve })
  scope.start('tasks', async () => { await request; return true }, 2500, true)
  scope.stop('tasks')
  let replacementCalls = 0
  scope.start('tasks', () => { replacementCalls++; return false })
  release()
  await flush()
  assert.equal(clock.pending.size, 1)
  await clock.next()
  assert.equal(replacementCalls, 1)
  assert.equal(clock.pending.size, 0)
})
