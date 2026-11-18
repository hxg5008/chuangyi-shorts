import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  beginImageTask, clearImageTask, imageTaskAsset, pendingImageIds,
  reconcileImageTasks, trackImageTask,
} from '../app/utils/image-task-state.js'

const image = (id, assetId, status, extra = {}) => ({ id, type: 'image', character_id: assetId, status, ...extra })

test('submitting a regeneration survives an old completed image and older snapshots', () => {
  const submitting = beginImageTask({}, 'character', 7)
  const old = image(11, 7, 'completed', { result_url: '/static/images/old.png' })
  const beforeResponse = reconcileImageTasks(submitting, [old])
  assert.deepEqual(pendingImageIds(beforeResponse.pending, 'character'), [7])
  assert.equal(beforeResponse.pending['character:7'].taskId, null)
  assert.deepEqual(beforeResponse.settled, [])

  const tracked = trackImageTask(beforeResponse.pending, 'character', 7, 12)
  const stale = reconcileImageTasks(tracked, [old])
  assert.equal(stale.pending['character:7'].taskId, 12)
  assert.deepEqual(stale.settled, [])
})

test('only the exact new generation can complete or fail a tracked image', () => {
  const tracked = trackImageTask({}, 'character', 7, 12)
  const processing = reconcileImageTasks(tracked, [image(11, 7, 'completed'), image(12, 7, 'processing')])
  assert.deepEqual(pendingImageIds(processing.pending, 'character'), [7])
  assert.deepEqual(processing.settled, [])

  for (const status of ['completed', 'failed', 'cancelled']) {
    const terminal = reconcileImageTasks(processing.pending, [image(11, 7, 'processing'), image(12, 7, status)])
    assert.deepEqual(terminal.pending, {})
    assert.equal(terminal.settled.length, 1)
    assert.equal(terminal.settled[0].task.id, 12)
    assert.equal(terminal.settled[0].task.status, status)
    assert.deepEqual(reconcileImageTasks(terminal.pending, [image(12, 7, status)]).settled, [])
  }
})

test('partial batch submission and generation failures release each asset independently', () => {
  let pending = {}
  for (const id of [1, 2, 3, 4]) pending = beginImageTask(pending, 'character', id)
  pending = trackImageTask(pending, 'character', 1, 21)
  pending = trackImageTask(pending, 'character', 2, 22)
  pending = trackImageTask(pending, 'character', 3, 23)
  pending = clearImageTask(pending, 'character', 4) // HTTP submission failed before a task was returned.

  const result = reconcileImageTasks(pending, [
    image(21, 1, 'completed'), image(22, 2, 'failed'), image(23, 3, 'processing'),
  ])
  assert.deepEqual(pendingImageIds(result.pending, 'character'), [3])
  assert.deepEqual(result.settled.map(item => [item.assetId, item.task.status]), [[1, 'completed'], [2, 'failed']])
  assert.deepEqual(pendingImageIds(clearImageTask(result.pending, 'character', 3), 'character'), [])
})

test('page entry restores latest running tasks with snake_case or camelCase asset fields', () => {
  const rows = [
    image(1, 7, 'processing'), image(2, 7, 'completed'), // A historical active row must not override a newer result.
    image(3, 8, 'queued'),
    { id: 4, type: 'image', sceneId: 9, status: 'processing' },
    { id: 5, type: 'image', prop_id: 10, status: 'pending' },
    { id: 6, type: 'video', character_id: 11, status: 'processing' },
  ]
  const { pending } = reconcileImageTasks({}, rows)
  assert.deepEqual(pendingImageIds(pending, 'character'), [8])
  assert.deepEqual(pendingImageIds(pending, 'scene'), [9])
  assert.deepEqual(pendingImageIds(pending, 'prop'), [10])
  assert.deepEqual(imageTaskAsset({ type: 'image', characterId: '8' }), { kind: 'character', assetId: 8 })
  assert.equal(imageTaskAsset({ type: 'video', scene_id: 9 }), null)
})

test('a missing submission task ID is rejected instead of using an old image as success', () => {
  assert.throws(() => trackImageTask({}, 'character', 7, undefined), /task ID/)
  assert.throws(() => trackImageTask({}, 'character', 7, 0), /task ID/)
})
