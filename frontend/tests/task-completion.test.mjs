import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function loadModule(file, context = {}) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const exports = {}
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  runInNewContext(compiled, { exports, require(name) {
    assert.equal(name, '~/utils/platform-session')
    return { platformHeaders: () => ({}), platformSession: { revision: 0 }, expirePlatformSession() {} }
  }, ...context })
  return exports
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function agentHarness(post) {
  const events = []
  let dispose
  const { useAgent } = loadModule('../app/composables/useAgent.ts', {
    require(name) {
      if (name === 'vue') return {
        ref: value => ({ value }),
        onScopeDispose: callback => { dispose = callback },
      }
      if (name === 'vue-sonner') return { toast: {
        success: () => events.push('success'), warning: () => events.push('busy'),
      } }
      if (name === './useApi') return { api: { post } }
      if (name === './useToast') return { toastError: () => events.push('error') }
      if (name === './i18n') return { i18n: { global: { t: key => key } } }
      throw new Error(`Unexpected import: ${name}`)
    },
  })
  return { agent: useAgent(), events, dispose: () => dispose() }
}

test('API preserves absent task state as null, including uploaded responses', async () => {
  const { api, characterAPI } = loadModule('../app/composables/useApi.ts', {
    performance, console: { log() {}, debug() {} }, URLSearchParams, FormData,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ code: 200, data: null }) }),
  })
  assert.equal(await api.get('/settings/video-prompts-status'), null)
  assert.equal(await characterAPI.uploadVoice(1, new Blob(['test'])), null)
})

test('API retains unwrapped health responses and false/zero data', async () => {
  const responses = [{ status: 'ok' }, { code: 200, data: false }, { code: 200, data: 0 }]
  const { api } = loadModule('../app/composables/useApi.ts', {
    performance, console: { log() {}, debug() {} }, URLSearchParams,
    fetch: async () => ({ ok: true, status: 200, json: async () => responses.shift() }),
  })
  assert.equal((await api.get('/health')).status, 'ok')
  assert.equal(await api.get('/boolean'), false)
  assert.equal(await api.get('/count'), 0)
})

test('text generation waits for completion refresh, then releases its busy state', async () => {
  const request = deferred(), refresh = deferred()
  const { agent, events } = agentHarness(() => request.promise)
  const running = agent.run('script_rewriter', 'test', 1, 1, () => refresh.promise)
  assert.equal(agent.running.value, true)
  request.resolve({ type: 'done' })
  await Promise.resolve()
  assert.equal(agent.running.value, true)
  assert.equal(events.length, 0)
  refresh.resolve()
  await running
  assert.equal(agent.running.value, false)
  assert.equal(agent.runningType.value, null)
  assert.deepEqual(events, ['success'])
})

test('text request failures and refresh failures both release the busy state', async () => {
  for (const refreshFailure of [false, true]) {
    const { agent, events } = agentHarness(async () => {
      if (!refreshFailure) throw new Error('request failed')
      return { type: 'done' }
    })
    await agent.run('script_rewriter', 'test', 1, 1, async () => { throw new Error('refresh failed') })
    assert.equal(agent.running.value, false)
    assert.equal(agent.runningType.value, null)
    assert.deepEqual(events, ['error'])
  }
})

test('leaving the workbench clears text state and ignores late callbacks', async () => {
  const request = deferred()
  const { agent, events, dispose } = agentHarness(() => request.promise)
  let refreshed = false
  const running = agent.run('script_rewriter', 'test', 1, 1, () => { refreshed = true })
  dispose()
  assert.equal(agent.running.value, false)
  request.resolve({ type: 'done' })
  await running
  assert.equal(refreshed, false)
  assert.deepEqual(events, [])
})

test('repeated text clicks do not submit another request while one is running', async () => {
  const request = deferred()
  let submissions = 0
  const { agent, events } = agentHarness(() => { submissions++; return request.promise })
  const running = agent.run('script_rewriter', 'test', 1, 1)
  await agent.run('script_rewriter', 'test', 1, 1)
  assert.equal(submissions, 1)
  assert.deepEqual(events, ['busy'])
  request.resolve({ type: 'done' })
  await running
  assert.equal(agent.running.value, false)
})
