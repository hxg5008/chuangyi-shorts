import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { taskStageKey, taskDownloadProgress, imageOutputMismatch, taskErrorContext, formatBytes } from '../app/utils/task-presentation.js'

test('image stages distinguish local prompt preparation, submission, queue, model work and local delivery', () => {
  assert.equal(taskStageKey(null, { taskId: null, phase: 'preparing_prompt' }), 'episode.tasks.stage.preparingPrompt')
  assert.equal(taskStageKey(null, { taskId: null, phase: 'submitting' }), 'episode.tasks.stage.submitting')
  for (const [stage, key] of [['queued', 'queued'], ['submitting', 'submitting'], ['polling', 'generating'], ['downloading', 'downloadingImage'], ['saving', 'saving']]) {
    assert.equal(taskStageKey({ type: 'image', status: 'processing', stage }), `episode.tasks.stage.${key}`)
  }
  assert.equal(taskStageKey({ type: 'image', status: 'processing', result_url: 'https://example.test/result.png' }), 'episode.tasks.stage.downloadingImage')
  assert.equal(taskStageKey({ type: 'image', status: 'completed' }), 'episode.status.done')
})

test('download bytes are shown only from measured progress and never inferred from task stages', () => {
  assert.equal(taskDownloadProgress({ stage: 'polling', params: '{}' }), null)
  assert.equal(taskDownloadProgress({ params: 'null' }), null)
  assert.equal(taskDownloadProgress({ params: 'invalid' }), null)
  assert.deepEqual(taskDownloadProgress({ params: JSON.stringify({ downloadProgress: { receivedBytes: 1024, totalBytes: null } }) }), { receivedBytes: 1024, totalBytes: null, updatedAt: '' })
  assert.deepEqual(taskDownloadProgress({ params: { downloadProgress: { receivedBytes: 2048, totalBytes: 4096, updatedAt: '2026-11-03T01:00:00Z' } } }), { receivedBytes: 2048, totalBytes: 4096, updatedAt: '2026-11-03T01:00:00Z' })
  assert.equal(taskDownloadProgress({ params: { downloadProgress: { receivedBytes: 2048, totalBytes: 1024 } } }).totalBytes, null)
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(-10), '')
})

test('task errors retain source, kind, stage and result evidence for precise delivery messages', () => {
  assert.deepEqual(taskErrorContext({ type: 'image', stage: 'downloading', error_code: 'image_delivery_failed', result_url: 'https://example.test/result.png' }), {
    source: 'task', kind: 'image', stage: 'downloading', errorCode: 'image_delivery_failed', hasResult: true,
  })
})

test('aspect warnings require a completed image with an explicit measured 16:9 mismatch', () => {
  const imageOutput = { width: 1312, height: 1199, expectedAspectRatio: '16:9', aspectRatioMatches: false }
  const task = { type: 'image', status: 'completed', params: JSON.stringify({ imageOutput }) }
  assert.deepEqual(imageOutputMismatch(task), { width: 1312, height: 1199 })
  assert.equal(task.status, 'completed', 'a warning does not turn a saved result into a generation failure')
  assert.equal(imageOutputMismatch({ kind: 'image', status: 'completed', params: { imageOutput } }).width, 1312)
  for (const status of ['processing', 'pending', 'failed']) assert.equal(imageOutputMismatch({ ...task, status }), null)
  for (const type of ['video', 'merge']) assert.equal(imageOutputMismatch({ ...task, type }), null)
  for (const params of [undefined, '{}', 'invalid', 'null', { imageOutput: { ...imageOutput, aspectRatioMatches: true } }, { imageOutput: { ...imageOutput, aspectRatioMatches: 'false' } }, { imageOutput: { ...imageOutput, width: 0 } }, { imageOutput: { ...imageOutput, expectedAspectRatio: '1:1' } }]) {
    assert.equal(imageOutputMismatch({ ...task, params }), null)
  }
})

test('all supported languages provide the same stage, progress and image/video recovery labels', () => {
  const locales = ['zh', 'en', 'ja', 'ko'].map(locale => JSON.parse(readFileSync(new URL(`../app/locales/${locale}.json`, import.meta.url), 'utf8')))
  const keys = Object.keys(locales[0].episode.tasks.stage).sort()
  for (const messages of locales) {
    assert.deepEqual(Object.keys(messages.episode.tasks.stage).sort(), keys)
    for (const key of keys) assert.ok(messages.episode.tasks.stage[key])
    for (const key of ['updated', 'downloadBytes', 'downloadBytesTotal', 'aspectRatioWarning']) assert.ok(messages.episode.tasks[key])
    for (const key of ['restoreImage', 'restoringImage', 'restoringVideo']) assert.ok(messages.episode.recovery[key])
  }
})
