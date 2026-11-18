import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EightApiVideoAdapter, extractEightApiVideoFailure } from '../src/services/adapters/eight-api-video.ts'

const adapter = new EightApiVideoAdapter()
const forbidden = ['sk-local-fixture-secret-1234567890123456', 'header-token-fixture-abc', 'https://cdn.example.test/private.png', 'local-signature-fixture']
function safe(value: unknown) {
  const serialized = JSON.stringify(value)
  for (const secret of forbidden) assert.ok(!serialized.includes(secret), 'Failure diagnostics must redact secret values')
}

test('nested upstream causes preserve the meaningful provider failure message and code', () => {
  const raw = { status: 'failed', error: { cause: { code: 'REFERENCE_FETCH_FAILED', message: 'Reference image could not be fetched' } } }
  const failure = extractEightApiVideoFailure(raw)
  assert.equal(failure.code, 'REFERENCE_FETCH_FAILED')
  assert.match(failure.message, /Reference image could not be fetched/)
  const parsed = adapter.parsePollResponse(raw)
  assert.equal(parsed.status, 'failed')
  assert.match(parsed.error || '', /Reference image could not be fetched/)
  assert.equal(parsed.diagnostics?.code, 'REFERENCE_FETCH_FAILED')
  assert.equal(parsed.diagnostics?.message, failure.message)
})

test('code-only failures display a safe actionable code instead of losing it behind a generic message', () => {
  const failure = extractEightApiVideoFailure({ error: { code: 'INPUT_MEDIA_INVALID' } })
  assert.equal(failure.code, 'INPUT_MEDIA_INVALID')
  assert.ok(failure.message.includes('INPUT_MEDIA_INVALID'))
  const parsed = adapter.parsePollResponse({ status: 'failed', error: { code: 'INPUT_MEDIA_INVALID' } })
  assert.ok(parsed.error?.includes('INPUT_MEDIA_INVALID'))
  assert.equal(parsed.diagnostics?.code, 'INPUT_MEDIA_INVALID')
})

test('documented failure fields and task result wrappers are inspected without serializing the entire response', () => {
  const cases = [
    { status: 'failed', failure_reason: 'Reference source returned 403' },
    { status: 'failed', fail_reason: 'Unsupported reference image type' },
    { status: 'failed', task_result: { error: { message: 'Input asset unavailable' } } },
    { status: 'failed', result: { error: { message: 'Upstream generation refused' } } },
    { status: 'failed', error: { details: { message: 'Reference duration invalid' } } },
  ]
  const expected = ['Reference source returned 403', 'Unsupported reference image type', 'Input asset unavailable', 'Upstream generation refused', 'Reference duration invalid']
  cases.forEach((raw, index) => {
    const failure = extractEightApiVideoFailure(raw)
    assert.ok(failure.message.includes(expected[index]))
    assert.ok(adapter.parsePollResponse(raw).error?.includes(expected[index]))
  })
})

test('JSON-string error payloads are parsed while ordinary string errors remain readable', () => {
  const raw = { status: 'failed', error: JSON.stringify({ code: 'UPSTREAM_BAD_MEDIA', message: 'Bad reference media' }) }
  const failure = extractEightApiVideoFailure(raw)
  assert.equal(failure.code, 'UPSTREAM_BAD_MEDIA')
  assert.equal(failure.message.includes('Bad reference media'), true)
  assert.ok(!failure.message.startsWith('{'))
  assert.match(adapter.parsePollResponse({ status: 'failed', error: 'Gateway Timeout' }).error || '', /Gateway Timeout/)
})

test('false diagnostic fields are ignored rather than stringifying secrets from unrelated raw object fields', () => {
  const raw = { status: 'failed', error: { message: false, code: false, details: false }, failure_reason: false,
    raw_debug: { apiKey: forbidden[0], url: `${forbidden[2]}?signature=${forbidden[3]}`, headers: { Authorization: `Bearer ${forbidden[1]}` } } }
  const failure = extractEightApiVideoFailure(raw)
  assert.equal(typeof failure.message, 'string')
  assert.ok(failure.message.trim().length > 0)
  assert.equal(failure.code, undefined)
  assert.ok(!failure.message.includes('raw_debug'))
  assert.ok(!failure.message.includes('false'))
  safe(failure)
  safe(adapter.parsePollResponse(raw))
})

test('direct and nested provider failure messages redact bearer tokens, keys and signed URLs before UI return', () => {
  const message = `Gateway Timeout: Bearer ${forbidden[1]}; key ${forbidden[0]}; URL ${forbidden[2]}?X-Amz-Signature=${forbidden[3]}`
  for (const raw of [
    { status: 'failed', error: message },
    { status: 'failed', error: { message } },
    { status: 'failed', error: { cause: { message } } },
    { data: { id: 'local-fixture-task', status: 'failed', error: { message } } },
  ]) {
    const parsed = adapter.parsePollResponse(raw)
    assert.equal(parsed.status, 'failed')
    assert.match(parsed.error || '', /Gateway Timeout/)
    safe(parsed)
    safe(extractEightApiVideoFailure(raw))
  }
})

test('malformed strings, primitives and circular failure details never expose raw objects or loop indefinitely', () => {
  const circular: any = { status: 'failed', error: { code: 'CIRCULAR_FAILURE' } }
  circular.error.cause = circular.error
  for (const raw of [null, undefined, false, 0, { error: '{malformed' }, circular]) {
    const failure = extractEightApiVideoFailure(raw)
    assert.equal(typeof failure.message, 'string')
    assert.ok(failure.message.length > 0)
    safe(failure)
  }
  assert.equal(extractEightApiVideoFailure(circular).code, 'CIRCULAR_FAILURE')
})

test('every failed terminal status receives safe diagnostics while a successful result remains completed', () => {
  for (const status of ['failed', 'failure', 'error', 'cancelled', 'canceled', 'rejected']) {
    const parsed = adapter.parsePollResponse({ status, error: { code: 'PROVIDER_DECLINED' } })
    assert.equal(parsed.status, 'failed')
    assert.equal(parsed.diagnostics?.code, 'PROVIDER_DECLINED')
    assert.ok(parsed.error?.includes('PROVIDER_DECLINED'))
  }
  const success = adapter.parsePollResponse({ status: 'completed', url: 'https://example.invalid/local-video.mp4' })
  assert.equal(success.status, 'completed')
  assert.equal(success.diagnostics, undefined)
})
