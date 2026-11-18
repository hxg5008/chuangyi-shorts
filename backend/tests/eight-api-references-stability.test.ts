import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as immediate } from 'node:timers/promises'
import { EightApiReferenceError, prepareEightApiPublicImages } from '../src/services/eight-api-references.ts'

const image = (status = 206, type = 'image/png') => new Response(new Uint8Array([0x89]), { status, headers: { 'content-type': type } })
const source = 'https://cdn.example.test/local-image.png'
const lookupSource = () => null
const amzTime = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
function signed(created: number, lifetime: number) {
  return `https://cdn.example.test/signed.png?X-Amz-Date=${amzTime(created)}&X-Amz-Expires=${lifetime}&X-Amz-Signature=local-fixture-signature`
}
async function captureFailure(operation: Promise<unknown>) {
  try { await operation; assert.fail('Expected a safe reference failure') }
  catch (error) { assert.ok(error instanceof EightApiReferenceError); return error }
}

test('known expired and near-expiry AWS references fail before any GET and expose safe expiry metadata', { concurrency: false }, async () => {
  const now = Date.now()
  for (const [reference, code] of [[signed(now - 3_600_000, 600), 'reference_expired'], [signed(now, 240), 'reference_expiring']] as const) {
    let calls = 0
    const error = await captureFailure(prepareEightApiPublicImages([reference], { lookupSource, fetch: async () => { calls++; return image() } }))
    assert.equal(error.code, code)
    assert.equal(error.index, 1)
    assert.equal(error.host, 'cdn.example.test')
    assert.ok(error.expiresAt && Number.isFinite(Date.parse(error.expiresAt)))
    assert.equal(calls, 0)
    assert.ok(!String(error).includes(reference))
    assert.ok(!JSON.stringify(error).includes('local-fixture-signature'))
  }
})

test('the requested minimum validity is checked on every call even after a successful lower-window cache entry', { concurrency: false }, async () => {
  const reference = signed(Date.now(), 120)
  let calls = 0
  const fetcher: typeof fetch = async () => { calls++; return image() }
  assert.deepEqual(await prepareEightApiPublicImages([reference], { lookupSource, fetch: fetcher, minValidityMs: 0 }), [reference])
  const failure = await captureFailure(prepareEightApiPublicImages([reference], { lookupSource, fetch: fetcher, minValidityMs: 300_000 }))
  assert.equal(failure.code, 'reference_expiring')
  assert.equal(calls, 1)
})

test('fresh signed URLs use GET Range without authentication and never a generation POST', { concurrency: false }, async () => {
  const reference = signed(Date.now(), 3600)
  let calls = 0
  const result = await prepareEightApiPublicImages([reference], { lookupSource, fetch: async (input, init) => {
    calls++
    assert.equal(String(input), reference)
    assert.equal(init?.method, 'GET')
    assert.equal(new Headers(init?.headers).get('range'), 'bytes=0-0')
    assert.equal(new Headers(init?.headers).get('authorization'), null)
    assert.equal(new Headers(init?.headers).get('cookie'), null)
    assert.ok(init?.signal instanceof AbortSignal)
    return image()
  } })
  assert.deepEqual(result, [reference])
  assert.equal(calls, 1)
})

test('duplicate and simultaneous same-URL probes merge in flight while retaining every numbered output position', { concurrency: false }, async () => {
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const fetcher: typeof fetch = async () => { calls++; await gate; return image() }
  const first = prepareEightApiPublicImages([source, source], { lookupSource, fetch: fetcher })
  const second = prepareEightApiPublicImages([source], { lookupSource, fetch: fetcher })
  await immediate()
  assert.equal(calls, 1)
  release()
  assert.deepEqual(await first, [source, source])
  assert.deepEqual(await second, [source])
})

test('resolved output order is independent of probe completion order and local lookup inputs remain intact', { concurrency: false }, async () => {
  const refs = ['/static/images/a.png', 'https://cdn.example.test/b.png', 'static/images/a.png']
  const original = [...refs]
  const calls: string[] = []
  const completed: string[] = []
  const result = await prepareEightApiPublicImages(refs, {
    lookupSource: path => { assert.equal(path, 'static/images/a.png'); return 'https://cdn.example.test/a.png' },
    fetch: async input => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/a.png')) await immediate()
      completed.push(url)
      return image()
    },
  })
  assert.deepEqual(result, ['https://cdn.example.test/a.png', 'https://cdn.example.test/b.png', 'https://cdn.example.test/a.png'])
  assert.deepEqual(refs, original)
  assert.equal(calls.length, 2)
  assert.equal(completed[0], 'https://cdn.example.test/b.png')
})

test('success cache is reused only for the same fetch function identity and expires within sixty seconds', { concurrency: false }, async () => {
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  try {
    let firstCalls = 0, secondCalls = 0
    const first: typeof fetch = async () => { firstCalls++; return image() }
    const second: typeof fetch = async () => { secondCalls++; return image() }
    await prepareEightApiPublicImages([source], { lookupSource, fetch: first })
    await prepareEightApiPublicImages([source], { lookupSource, fetch: first })
    await prepareEightApiPublicImages([source], { lookupSource, fetch: second })
    assert.equal(firstCalls, 1)
    assert.equal(secondCalls, 1)
    now += 61_000
    await prepareEightApiPublicImages([source], { lookupSource, fetch: first })
    assert.equal(firstCalls, 2)
  } finally { Date.now = originalNow }
})

test('a cached signed URL is never reused across expiry minus the minimum validity window', { concurrency: false }, async () => {
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  try {
    const reference = signed(now - 240_000, 600)
    let calls = 0
    const fetcher: typeof fetch = async () => { calls++; return image() }
    await prepareEightApiPublicImages([reference], { lookupSource, fetch: fetcher })
    now += 61_000
    const failure = await captureFailure(prepareEightApiPublicImages([reference], { lookupSource, fetch: fetcher }))
    assert.equal(failure.code, 'reference_expiring')
    assert.equal(calls, 1)
  } finally { Date.now = originalNow }
})

test('probe concurrency stays at two across calls and different injected fetch identities', { concurrency: false }, async () => {
  let active = 0, peak = 0, calls = 0
  const probe = async () => {
    calls++; active++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 2))
    active--
    return image()
  }
  const first: typeof fetch = () => probe()
  const second: typeof fetch = () => probe()
  await Promise.all([
    prepareEightApiPublicImages(['a', 'b', 'c'].map(name => `https://cdn.example.test/${name}.png`), { lookupSource, fetch: first }),
    prepareEightApiPublicImages(['d', 'e'].map(name => `https://cdn.example.test/${name}.png`), { lookupSource, fetch: second }),
  ])
  assert.equal(calls, 5)
  assert.equal(peak, 2)
  assert.equal(active, 0)
})

test('network failures retry at most once, then classify precisely without preserving a raw cause or URL', { concurrency: false }, async () => {
  let calls = 0
  const reference = 'https://cdn.example.test/a.png?signature=local-only'
  const original = Object.assign(new TypeError(`fetch failed ${reference} Bearer local-secret`), { code: 'UND_ERR_CONNECT_TIMEOUT' })
  const failure = await captureFailure(prepareEightApiPublicImages([reference], { lookupSource, retryDelayMs: 0, fetch: async () => { calls++; throw original } }))
  assert.equal(calls, 2)
  assert.equal(failure.code, 'reference_network')
  assert.equal(failure.index, 1)
  assert.equal(failure.causeCode, 'UND_ERR_CONNECT_TIMEOUT')
  assert.equal((failure as Error & { cause?: unknown }).cause, undefined)
  assert.equal(typeof failure.elapsedMs, 'number')
  const serialized = JSON.stringify(failure) + String(failure)
  for (const secret of [reference, 'local-only', 'local-secret']) assert.ok(!serialized.includes(secret))
})

test('temporary network and HTTP 429/5xx failures can succeed on the one allowed GET retry', { concurrency: false }, async () => {
  for (const status of [429, 500, 502, 503, 504]) {
    let calls = 0
    const result = await prepareEightApiPublicImages([source], { lookupSource, retryDelayMs: 0, fetch: async (_input, init) => {
      calls++
      assert.equal(init?.method, 'GET')
      return calls === 1 ? image(status) : image()
    } })
    assert.deepEqual(result, [source])
    assert.equal(calls, 2)
  }
  let calls = 0
  await prepareEightApiPublicImages([source], { lookupSource, retryDelayMs: 0, fetch: async () => {
    if (++calls === 1) throw new TypeError('local transient fetch failure')
    return image()
  } })
  assert.equal(calls, 2)
})

test('permanent HTTP errors do not retry and are not falsely labelled expired signatures', { concurrency: false }, async () => {
  for (const status of [400, 401, 403, 404, 410]) {
    let calls = 0
    const failure = await captureFailure(prepareEightApiPublicImages([source], { lookupSource, retryDelayMs: 0, fetch: async () => { calls++; return image(status) } }))
    assert.equal(failure.code, 'reference_http')
    assert.equal(failure.httpStatus, status)
    assert.equal(calls, 1)
  }
})

test('failed probes are not cached and an unsuccessful HTTP retry remains a structured HTTP failure', { concurrency: false }, async () => {
  let calls = 0
  const fetcher: typeof fetch = async () => { calls++; return calls === 1 ? image(403) : image() }
  await captureFailure(prepareEightApiPublicImages([source], { lookupSource, retryDelayMs: 0, fetch: fetcher }))
  assert.deepEqual(await prepareEightApiPublicImages([source], { lookupSource, retryDelayMs: 0, fetch: fetcher }), [source])
  assert.equal(calls, 2)
  let temporaryCalls = 0
  const failure = await captureFailure(prepareEightApiPublicImages([source], { lookupSource, retryDelayMs: 0, fetch: async () => { temporaryCalls++; return image(503) } }))
  assert.equal(temporaryCalls, 2)
  assert.equal(failure.code, 'reference_http')
  assert.equal(failure.httpStatus, 503)
})

test('HTML and missing content type are non-image errors and are not retried as network failures', { concurrency: false }, async () => {
  for (const type of ['text/html', 'application/json', undefined]) {
    let calls = 0
    const failure = await captureFailure(prepareEightApiPublicImages([source], { lookupSource, retryDelayMs: 0, fetch: async () => {
      calls++
      return new Response(new Uint8Array([0x89]), { status: 200, headers: type ? { 'content-type': type } : {} })
    } }))
    assert.equal(failure.code, 'reference_not_image')
    assert.equal(calls, 1)
  }
})

test('known permanent status and content type remain authoritative when cancelling a failed body', { concurrency: false }, async () => {
  for (const status of [403, 404, 200]) {
    let calls = 0
    const failure = await captureFailure(prepareEightApiPublicImages([source], { lookupSource, retryDelayMs: 0, fetch: async () => {
      calls++
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error('mock broken error body')) } }),
        { status, headers: { 'content-type': status === 200 ? 'text/html' : 'image/png' } })
    } }))
    assert.equal(failure.code, status === 200 ? 'reference_not_image' : 'reference_http')
    assert.equal(failure.httpStatus, status)
    assert.equal(calls, 1)
  }
})

test('a local timeout is bounded, retries only once and releases its semaphore slots', { concurrency: false }, async () => {
  let calls = 0
  const keepAlive = setTimeout(() => {}, 250)
  try {
    const failure = await captureFailure(prepareEightApiPublicImages([source], { lookupSource, timeoutMs: 10, retryDelayMs: 0,
      fetch: async (_input, init) => {
        calls++
        return new Promise<Response>((_resolve, reject) => {
          const onAbort = () => reject(init?.signal?.reason ?? new DOMException('Aborted', 'AbortError'))
          if (init?.signal?.aborted) onAbort()
          else init?.signal?.addEventListener('abort', onAbort, { once: true })
        })
      },
    }))
    assert.equal(failure.code, 'reference_network')
    assert.equal(calls, 2)
    assert.deepEqual(await prepareEightApiPublicImages([source], { lookupSource, fetch: async () => image() }), [source])
  } finally { clearTimeout(keepAlive) }
})
