import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EightApiReferenceError, prepareEightApiPublicImages } from '../src/services/eight-api-references.ts'

function imageResponse(status = 206, contentType = 'image/png') {
  return new Response(new Uint8Array([0x89]), { status, headers: { 'Content-Type': contentType } })
}

test('local references look up the exact original localPath without rewriting input assets', async () => {
  const assets = Object.freeze({ 'static/images/original.png': 'https://cdn.example.test/original.png' })
  const refs = Object.freeze(['/static/images/original.png'])
  const lookups: string[] = []
  const fetched: string[] = []
  const result = await prepareEightApiPublicImages(refs as unknown as string[], {
    lookupSource: localPath => { lookups.push(localPath); return assets[localPath as keyof typeof assets] || null },
    fetch: async input => { fetched.push(String(input)); return imageResponse() },
  })
  assert.deepEqual(lookups, ['static/images/original.png'])
  assert.deepEqual(result, ['https://cdn.example.test/original.png'])
  assert.deepEqual(fetched, result)
  assert.deepEqual(refs, ['/static/images/original.png'])
  assert.equal(assets['static/images/original.png'], 'https://cdn.example.test/original.png')
})

test('duplicate references and mixed sources preserve their exact numbered positions', async () => {
  const lookups: string[] = []
  const refs = ['/static/images/repeated.png', 'https://cdn.example.test/direct.png', 'static/images/repeated.png']
  const result = await prepareEightApiPublicImages(refs, {
    lookupSource: async localPath => {
      lookups.push(localPath)
      await new Promise(resolve => setTimeout(resolve, 1))
      return 'https://cdn.example.test/repeated.png'
    },
    fetch: async () => imageResponse(),
  })
  assert.deepEqual(result, ['https://cdn.example.test/repeated.png', 'https://cdn.example.test/direct.png', 'https://cdn.example.test/repeated.png'])
  assert.deepEqual(lookups, ['static/images/repeated.png', 'static/images/repeated.png'])
  assert.deepEqual(refs, ['/static/images/repeated.png', 'https://cdn.example.test/direct.png', 'static/images/repeated.png'])
})

test('signed HTTPS references are probed using GET Range without provider authentication', async () => {
  const reference = 'https://cdn.example.test/image.png?method=GET&signature=mock-only'
  let calls = 0
  const result = await prepareEightApiPublicImages([reference], {
    lookupSource: () => { assert.fail('HTTPS references must not consult local assets') },
    fetch: async (input, init) => {
      calls++
      assert.equal(String(input), reference)
      assert.equal(init?.method, 'GET')
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('range'), 'bytes=0-0')
      assert.equal(headers.get('authorization'), null)
      assert.equal(headers.get('cookie'), null)
      assert.ok(init?.signal instanceof AbortSignal)
      return imageResponse(200, 'image/png; charset=binary')
    },
  })
  assert.deepEqual(result, [reference])
  assert.equal(calls, 1)
})

test('a successful explicit PUBLIC_BASE_URL is preferred over historical signed image URLs', async () => {
  let lookups = 0
  const fetched: string[] = []
  const result = await prepareEightApiPublicImages(['static/images/local.png'], {
    publicBaseUrl: 'https://media.example.test/workspace///',
    lookupSource: () => { lookups++; return 'https://old.example.test/expired.png' },
    fetch: async input => { fetched.push(String(input)); return imageResponse() },
  })
  assert.deepEqual(result, ['https://media.example.test/workspace/static/images/local.png'])
  assert.deepEqual(fetched, result)
  assert.equal(lookups, 0)
})

test('probe cancels a full response body when the server ignores the Range header', async () => {
  let cancelled = 0
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([0x89])) },
    cancel() { cancelled++ },
  })
  const result = await prepareEightApiPublicImages(['https://cdn.example.test/full.png'], {
    lookupSource: () => null,
    fetch: async () => new Response(stream, { status: 200, headers: { 'Content-Type': 'image/png' } }),
  })
  assert.equal(result.length, 1)
  assert.equal(cancelled, 1)
})

test('HTTP failures and non-image responses cannot become paid reference inputs', async () => {
  for (const response of [
    imageResponse(403), imageResponse(404), imageResponse(500), imageResponse(200, 'text/html'),
    imageResponse(200, 'application/json'), new Response(new Uint8Array([0x89]), { status: 200 }),
  ]) {
    await assert.rejects(prepareEightApiPublicImages(['static/images/a.png'], {
      lookupSource: () => 'https://cdn.example.test/expired.png', fetch: async () => response,
    }), error => error instanceof EightApiReferenceError && ['reference_http', 'reference_not_image'].includes(error.code))
  }
})

test('network, lookup and response stream errors reject instead of silently dropping a reference', async () => {
  await assert.rejects(prepareEightApiPublicImages(['https://cdn.example.test/a.png'], {
    lookupSource: () => null,
    fetch: async () => { throw new TypeError('mock network unavailable') },
  }), /无法连接/)
  let requests = 0
  await assert.rejects(prepareEightApiPublicImages(['static/images/a.png'], {
    lookupSource: () => { throw new Error('mock source read failed') },
    fetch: async () => { requests++; return imageResponse() },
  }))
  assert.equal(requests, 0)
  const failed = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('mock image stream failed')) } })
  await assert.rejects(prepareEightApiPublicImages(['https://cdn.example.test/a.png'], {
    lookupSource: () => null,
    fetch: async () => new Response(failed, { status: 200, headers: { 'Content-Type': 'image/png' } }),
  }))
})

test('inline data, local paths, private endpoints and embedded credentials are rejected before any fetch', async () => {
  const invalid = [
    'data:image/png;base64,iVBORw0KGgo=', 'file:///images/a.png', 'D:\\images\\a.png',
    'http://cdn.example.test/a.png', 'https://user:pass@cdn.example.test/a.png',
    'https://localhost/a.png', 'https://127.0.0.1/a.png', 'https://0.0.0.0/a.png',
    'https://10.1.2.3/a.png', 'https://192.168.1.3/a.png', 'https://172.16.0.1/a.png',
    'https://169.254.1.1/a.png', 'https://[::1]/a.png', 'https://[fc00::1]/a.png', 'https://[fe80::1]/a.png',
    'static/../private.png', 'static/images/../../private.png',
  ]
  let fetched = 0
  for (const input of invalid) {
    await assert.rejects(prepareEightApiPublicImages([input], {
      lookupSource: () => null,
      fetch: async () => { fetched++; return imageResponse() },
    }))
  }
  assert.equal(fetched, 0)
})

test('missing source mapping and excess reference count fail before transport while empty input is valid', async () => {
  let fetched = 0
  let lookups = 0
  const options = {
    lookupSource: () => { lookups++; return null },
    fetch: (async () => { fetched++; return imageResponse() }) as typeof fetch,
  }
  await assert.rejects(prepareEightApiPublicImages(['static/images/missing.png'], options), /没有可用公网源地址/)
  assert.equal(lookups, 1)
  await assert.rejects(prepareEightApiPublicImages(Array(10).fill('https://cdn.example.test/a.png'), options), /9 张/)
  assert.equal(lookups, 1)
  assert.equal(fetched, 0)
  assert.deepEqual(await prepareEightApiPublicImages([], options), [])
})
