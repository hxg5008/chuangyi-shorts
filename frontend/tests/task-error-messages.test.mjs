import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../app/composables/useToast.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function loadMessages(locale) {
  const messages = JSON.parse(readFileSync(new URL(`../app/locales/${locale}.json`, import.meta.url), 'utf8'))
  const exports = {}
  runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === 'vue-sonner') return { toast: { error() {} } }
      if (name === '~/composables/i18n') return {
        i18n: { global: { t: key => key.split('.').reduce((value, part) => value?.[part], messages) } },
      }
      throw new Error(`Unexpected import: ${name}`)
    },
  })
  return { mapError: exports.mapError, messages }
}

for (const locale of ['zh', 'en', 'ja', 'ko']) {
  test(`${locale}: task network failures distinguish provider/result transfer from local API connectivity`, () => {
    const { mapError, messages } = loadMessages(locale)
    for (const key of ['submissionUnknown', 'moderation', 'imageDelivery', 'videoDelivery', 'resultDelivery', 'taskTimeout', 'taskFailed', 'taskProvider', 'taskInvalidRequest', 'taskInvalidResponse']) assert.equal(typeof messages.errors[key], 'string', `${locale}: ${key}`)
    assert.ok(messages.errors.taskNetwork)
    assert.notEqual(messages.errors.taskNetwork, messages.errors.network)
    for (const message of ['fetch failed', 'Failed to fetch', 'NetworkError']) {
      assert.equal(mapError(message), messages.errors.network)
      assert.equal(mapError(message, { source: 'task' }), messages.errors.taskNetwork)
    }
    assert.equal(mapError('Unauthorized', { source: 'task' }), messages.errors.auth)
  })

  test(`${locale}: known task context separates unknown submission, policy refusal and download timeout`, () => {
    const { mapError, messages } = loadMessages(locale)
    assert.equal(mapError('fetch failed', { source: 'task', errorCode: 'submission_unknown' }), messages.errors.submissionUnknown)
    assert.equal(mapError('unknown', { source: 'task', errorCode: 'generation_rejected' }), messages.errors.moderation)
    for (const message of ['图片违反我们的内容政策', 'upstream_policy_refusal_text', 'Pedido recusado pela política de conteúdo', 'Não posso ajudar com esta imagem']) {
      assert.equal(mapError(message, { source: 'task' }), messages.errors.moderation)
    }
    assert.equal(mapError('timeout', { source: 'task', kind: 'image', errorCode: 'image_delivery_failed', stage: 'downloading', hasResult: true }), messages.errors.imageDelivery)
    assert.equal(mapError('download URL blocked', { source: 'task', kind: 'image', errorCode: 'image_delivery_failed', hasResult: true }), messages.errors.imageDelivery)
    assert.equal(mapError('fetch failed', { source: 'task', kind: 'video', hasResult: true }), messages.errors.videoDelivery)
    assert.equal(mapError('图片下载超时', { source: 'task', kind: 'image' }), messages.errors.imageDelivery)
    assert.equal(mapError('timeout', { source: 'task', kind: 'image', hasResult: false }), messages.errors.taskTimeout)
    assert.equal(mapError('unrecognized failure', { source: 'task' }), messages.errors.taskFailed)
    assert.notEqual(messages.errors.taskTimeout, messages.errors.timeout)
    for (const [errorCode, key] of [['generation_auth_failed', 'auth'], ['generation_rate_limited', 'rateLimit'], ['generation_invalid_request', 'taskInvalidRequest'], ['generation_invalid_response', 'taskInvalidResponse'], ['generation_provider_error', 'taskProvider']]) {
      assert.equal(mapError('unknown', { source: 'task', errorCode }), messages.errors[key])
    }
    assert.equal(mapError('Failed to fetch'), messages.errors.network)
  })

  test(`${locale}: task and request gateway timeouts retain reliable status without becoming a local network failure`, () => {
    const { mapError, messages } = loadMessages(locale)
    for (const options of [undefined, { source: 'request' }, { source: 'task' }]) {
      for (const message of ['504', '504 Gateway Timeout', 'HTTP 504: Gateway Timeout', 'Request failed with status code 504', 'provider_http_status=504; fetch failed']) {
        assert.equal(mapError(message, options), messages.errors.upstreamGatewayTimeout, message)
      }
      for (const message of ['Gateway Timeout', 'GatewayTimeout', 'gateway_timeout', '模型通道网关超时']) {
        assert.equal(mapError(message, options), messages.errors.modelGatewayTimeout, message)
        assert.equal(mapError(message, options).includes('504'), false, 'a bare gateway timeout cannot prove HTTP 504')
      }
      assert.equal(mapError('Gateway Timeout', { ...options, providerHttpStatus: 504 }), messages.errors.upstreamGatewayTimeout)
      assert.equal(mapError({ message: 'Gateway Timeout', provider_http_status: 504 }, options), messages.errors.upstreamGatewayTimeout)
      assert.equal(mapError('HTTP 502: Bad Gateway', options), messages.errors.unavailable)
      assert.equal(mapError('Failed to fetch', options), options?.source === 'task' ? messages.errors.taskNetwork : messages.errors.network)
      assert.equal(mapError('request timed out', options), options?.source === 'task' ? messages.errors.taskTimeout : messages.errors.timeout)
    }
    assert.equal(mapError('HTTP 504 Gateway Timeout', { source: 'task', errorCode: 'generation_provider_error' }), messages.errors.upstreamGatewayTimeout)
    assert.equal(mapError('HTTP 504 Gateway Timeout', { source: 'task', kind: 'image', errorCode: 'image_delivery_failed' }), messages.errors.imageDelivery)
    for (const key of ['generating', 'validating', 'repairing']) assert.ok(messages.composables.agent.failedDuring[key])
  })

  test(`${locale}: exact video lifecycle codes distinguish unsubmitted references, confirmed failure and uncertain polling results`, () => {
    const { mapError, messages } = loadMessages(locale)
    const expected = [
      ['reference_expired', 'referenceExpired'], ['reference_expiring', 'referenceExpiring'],
      ['reference_network', 'referenceNetwork'], ['reference_http', 'referenceHttp'],
      ['reference_not_image', 'referenceNotImage'], ['reference_missing_source', 'referenceMissingSource'],
      ['provider_task_failed', 'videoProviderFailed'], ['video_poll_access_failed', 'videoPollAccessFailed'],
      ['video_poll_not_found', 'videoPollNotFound'], ['video_poll_timeout', 'videoPollTimeout'],
    ]
    for (const [errorCode, key] of expected) {
      assert.equal(typeof messages.errors[key], 'string', `${locale}: ${key}`)
      // Explicit lifecycle evidence outranks generic network/HTTP/policy words.
      for (const message of ['unrecognized failure', 'fetch failed', 'HTTP 403 access blocked', 'HTTP 504 timeout', '']) {
        assert.equal(mapError(message, { source: 'task', kind: 'video', errorCode }), messages.errors[key], `${errorCode}: ${message}`)
      }
      assert.equal(mapError('unknown', { source: 'task', errorCode }), messages.errors[key], 'the specific code remains usable when media kind is absent')
      assert.notEqual(messages.errors[key], messages.errors.taskFailed)
    }
    for (const key of ['videoPollAccessFailed', 'videoPollNotFound', 'videoPollTimeout']) assert.notEqual(messages.errors[key], messages.errors.videoProviderFailed)
  })

  test(`${locale}: generic generation failures, image delivery and browser network errors retain their original meaning`, () => {
    const { mapError, messages } = loadMessages(locale)
    for (const kind of ['image', 'video']) {
      assert.equal(mapError('unrecognized failure', { source: 'task', kind, errorCode: 'generation_failed' }), messages.errors.taskFailed)
      assert.equal(mapError('fetch failed', { source: 'task', kind, errorCode: 'generation_failed' }), messages.errors.taskNetwork)
    }
    for (const errorCode of ['provider_task_failed', 'video_poll_access_failed', 'video_poll_not_found', 'video_poll_timeout', 'reference_network']) {
      assert.equal(mapError('unrecognized failure', { source: 'task', kind: 'image', errorCode }), messages.errors.taskFailed)
    }
    for (const errorCode of ['reference_network', 'provider_task_failed', 'video_poll_timeout']) assert.equal(mapError('Failed to fetch', { source: 'request', kind: 'video', errorCode }), messages.errors.network)
    assert.equal(mapError('timeout', { source: 'task', kind: 'image', errorCode: 'image_delivery_failed' }), messages.errors.imageDelivery)
    assert.equal(mapError('timeout', { source: 'task', kind: 'video', hasResult: true }), messages.errors.videoDelivery)
    for (const errorCode of ['reference_unknown', 'constructor', 'toString']) assert.equal(mapError('unrecognized failure', { source: 'task', kind: 'video', errorCode }), messages.errors.taskFailed)
  })
}

test('Chinese lifecycle messages preserve local images, clarify non-submission and separate platform failure from blocked polling', () => {
  const { messages } = loadMessages('zh')
  assert.match(messages.errors.referenceExpired, /公网源已过期/)
  assert.match(messages.errors.referenceExpired, /本地图片仍保留/)
  assert.match(messages.errors.referenceExpired, /稳定图片存储/)
  assert.match(messages.errors.referenceNetwork, /尚未提交/)
  assert.match(messages.errors.videoProviderFailed, /平台已确认.*失败/)
  assert.doesNotMatch(messages.errors.videoProviderFailed, /未知|待核对|尚未确认/)
  for (const key of ['videoPollAccessFailed', 'videoPollNotFound', 'videoPollTimeout']) {
    assert.match(messages.errors[key], /结果待核对/)
    assert.match(messages.errors[key], /保留任务ID/)
    assert.doesNotMatch(messages.errors[key], /生成失败|平台已确认.*失败/)
  }
})
