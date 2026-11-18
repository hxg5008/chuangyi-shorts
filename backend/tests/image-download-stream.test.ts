import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { downloadFile } from '../src/utils/storage.ts'
import type { ImageDownloadProgress } from '../src/utils/image-download.ts'

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const changedImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64')
const split = 24

async function fixture(handler: http.RequestListener) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-stream-'))
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'GET', 'download retries must never submit a generation POST')
    handler(req, res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/image.png`
  return {
    root, url,
    async read(relative: string) { return fs.readFile(path.join(root, 'images', path.basename(relative))) },
    async files() { return fs.readdir(path.join(root, 'images')) },
    async close() {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

function interrupt(res: http.ServerResponse, headers: Record<string, string | number> = {}) {
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': image.length, ...headers })
  res.write(image.subarray(0, split))
  setTimeout(() => res.destroy(), 40).unref()
}

test('interrupted image GET resumes using exact byte range and strong ETag, with awaited progress', async () => {
  let requests = 0
  const progress: ImageDownloadProgress[] = []
  const f = await fixture((req, res) => {
    assert.ok(req.headers['accept-encoding']?.split(',').every(encoding => encoding.trim() === 'identity'))
    if (++requests === 1) { interrupt(res, { ETag: '"version-a"' }); return }
    assert.equal(req.headers.range, `bytes=${split}-`)
    assert.equal(req.headers['if-range'], '"version-a"')
    res.writeHead(206, { ETag: '"version-a"', 'Content-Type': 'image/png',
      'Content-Range': `bytes ${split}-${image.length - 1}/${image.length}`, 'Content-Length': image.length - split })
    res.end(image.subarray(split))
  })
  try {
    const relative = await downloadFile(f.url, 'images', { root: f.root, attempts: 2, retryDelayMs: 1,
      async onProgress(value) { await new Promise(resolve => setTimeout(resolve, 1)); progress.push(value) } })
    assert.deepEqual(await f.read(relative), image)
    assert.equal(requests, 2)
    assert.ok(progress.some(p => p.attempt === 1 && p.receivedBytes === split && p.totalBytes === image.length))
    assert.equal(progress.find(p => p.attempt === 2)!.receivedBytes, split)
    assert.deepEqual(progress.at(-1), { receivedBytes: image.length, totalBytes: image.length, attempt: 2 })
    assert.deepEqual(await f.files(), [path.basename(relative)])
  } finally { await f.close() }
})

test('a server ignoring Range and returning 200 overwrites the partial instead of appending', async () => {
  let requests = 0
  const f = await fixture((req, res) => {
    if (++requests === 1) { interrupt(res, { ETag: '"version-a"' }); return }
    assert.equal(req.headers.range, `bytes=${split}-`)
    res.writeHead(200, { ETag: '"version-b"', 'Content-Type': 'image/png', 'Content-Length': changedImage.length }).end(changedImage)
  })
  try {
    const relative = await downloadFile(f.url, 'images', { root: f.root, retryDelayMs: 1 })
    assert.equal(requests, 2)
    assert.deepEqual(await f.read(relative), changedImage)
    assert.equal((await f.files()).length, 1)
  } finally { await f.close() }
})

for (const invalid of ['validator', 'start', 'total', 'missing-validator'] as const) {
  test(`unsafe 206 (${invalid}) is discarded and followed by a clean full GET`, async () => {
    let requests = 0
    const f = await fixture((req, res) => {
      if (++requests === 1) { interrupt(res, { ETag: '"version-a"' }); return }
      if (requests === 2) {
        assert.equal(req.headers.range, `bytes=${split}-`)
        const headers: Record<string, string | number> = {
          'Content-Type': 'image/png', 'Content-Length': image.length - split,
          'Content-Range': `bytes ${invalid === 'start' ? split + 1 : split}-${image.length - 1}/${image.length + (invalid === 'total' ? 1 : 0)}`,
        }
        if (invalid !== 'missing-validator') headers.ETag = invalid === 'validator' ? '"version-b"' : '"version-a"'
        res.writeHead(206, headers).end(changedImage.subarray(split))
        return
      }
      assert.equal(req.headers.range, undefined)
      res.writeHead(200, { 'Content-Type': 'image/png' }).end(changedImage)
    })
    try {
      const relative = await downloadFile(f.url, 'images', { root: f.root, attempts: 3, retryDelayMs: 1 })
      assert.equal(requests, 3)
      assert.deepEqual(await f.read(relative), changedImage)
    } finally { await f.close() }
  })
}

test('Last-Modified is used with If-Range when there is no strong ETag', async () => {
  const modified = 'Mon, 02 Nov 2026 08:00:00 GMT'
  let requests = 0
  const f = await fixture((req, res) => {
    if (++requests === 1) { interrupt(res, { ETag: 'W/"weak"', 'Last-Modified': modified }); return }
    assert.equal(req.headers.range, `bytes=${split}-`)
    assert.equal(req.headers['if-range'], modified)
    res.writeHead(206, { 'Last-Modified': modified, 'Content-Type': 'image/png',
      'Content-Range': `bytes ${split}-${image.length - 1}/${image.length}` }).end(image.subarray(split))
  })
  try {
    const relative = await downloadFile(f.url, 'images', { root: f.root, retryDelayMs: 1 })
    assert.deepEqual(await f.read(relative), image)
    assert.equal(requests, 2)
  } finally { await f.close() }
})

test('a partial with only a weak ETag is never resumed', async () => {
  let requests = 0
  const f = await fixture((req, res) => {
    if (++requests === 1) { interrupt(res, { ETag: 'W/"weak"' }); return }
    assert.equal(req.headers.range, undefined)
    res.end(image)
  })
  try {
    const relative = await downloadFile(f.url, 'images', { root: f.root, retryDelayMs: 1 })
    assert.deepEqual(await f.read(relative), image)
  } finally { await f.close() }
})

test('stable download keys resume a crash leftover only when URL and stored validator match', async () => {
  let requests = 0
  const f = await fixture((req, res) => {
    requests++
    assert.equal(req.headers.range, `bytes=${split}-`)
    assert.equal(req.headers['if-range'], '"crash-version"')
    res.writeHead(206, { ETag: '"crash-version"', 'Content-Type': 'image/png',
      'Content-Range': `bytes ${split}-${image.length - 1}/${image.length}` }).end(image.subarray(split))
  })
  try {
    const key = 'task-for-local-test'
    const filename = createHash('sha256').update(key).digest('hex').slice(0, 32) + '.png'
    await fs.mkdir(path.join(f.root, 'images'))
    const partial = path.join(f.root, 'images', filename + '.part')
    await fs.writeFile(partial, image.subarray(0, split))
    await fs.writeFile(partial + '.json', JSON.stringify({ version: 1, url: f.url, responseUrl: f.url,
      validator: { header: 'etag', value: '"crash-version"' }, totalBytes: image.length, contentType: 'image/png' }))
    const relative = await downloadFile(f.url, 'images', { root: f.root, downloadKey: key })
    assert.equal(requests, 1)
    assert.equal(path.basename(relative), filename)
    assert.deepEqual(await f.read(relative), image)
    assert.deepEqual(await f.files(), [filename])
  } finally { await f.close() }
})

test('an exhausted network attempt keeps a safe keyed partial for a later recovery call', async () => {
  let requests = 0
  const f = await fixture((req, res) => {
    if (++requests === 1) { interrupt(res, { ETag: '"recover-version"' }); return }
    assert.equal(req.headers.range, `bytes=${split}-`)
    assert.equal(req.headers['if-range'], '"recover-version"')
    res.writeHead(206, { ETag: '"recover-version"', 'Content-Type': 'image/png',
      'Content-Range': `bytes ${split}-${image.length - 1}/${image.length}` }).end(image.subarray(split))
  })
  try {
    const options = { root: f.root, downloadKey: 'recover-after-failure', attempts: 1 }
    await assert.rejects(downloadFile(f.url, 'images', options), error => error instanceof TypeError)
    const files = await f.files()
    assert.equal(files.length, 2)
    assert.ok(files.some(name => name.endsWith('.part')))
    assert.ok(files.some(name => name.endsWith('.part.json')))
    const relative = await downloadFile(f.url, 'images', options)
    assert.equal(requests, 2)
    assert.deepEqual(await f.read(relative), image)
    assert.deepEqual(await f.files(), [path.basename(relative)])
  } finally { await f.close() }
})

test('a keyed timeout without a validator is still cleaned instead of leaving an unsafe partial', async () => {
  const f = await fixture((_req, res) => { res.writeHead(200); res.write(image.subarray(0, split)) })
  try {
    await assert.rejects(downloadFile(f.url, 'images', { root: f.root, downloadKey: 'no-validator', attempts: 1, idleTimeoutMs: 40 }),
      error => (error as Error).name === 'TimeoutError')
    assert.deepEqual(await f.files(), [])
  } finally { await f.close() }
})

test('a stale crash partial for a different signed URL is discarded before making a request', async () => {
  const f = await fixture((req, res) => { assert.equal(req.headers.range, undefined); res.end(changedImage) })
  try {
    const key = 'same-task-new-url'
    const filename = createHash('sha256').update(key).digest('hex').slice(0, 32) + '.png'
    await fs.mkdir(path.join(f.root, 'images'))
    const partial = path.join(f.root, 'images', filename + '.part')
    await fs.writeFile(partial, image.subarray(0, split))
    await fs.writeFile(partial + '.json', JSON.stringify({ version: 1, url: f.url + '?old-signature', responseUrl: f.url,
      validator: { header: 'etag', value: '"old-version"' }, totalBytes: image.length, contentType: 'image/png' }))
    const relative = await downloadFile(f.url, 'images', { root: f.root, downloadKey: key })
    assert.deepEqual(await f.read(relative), changedImage)
  } finally { await f.close() }
})

for (const declared of [true, false]) {
  test(`image size limit applies to ${declared ? 'Content-Length' : 'chunked streamed bytes'} and cleans all temporary files`, async () => {
    let requests = 0
    const f = await fixture((_req, res) => {
      requests++
      res.writeHead(200, declared ? { 'Content-Length': image.length } : { 'Transfer-Encoding': 'chunked' })
      res.end(image)
    })
    try {
      await assert.rejects(downloadFile(f.url, 'images', { root: f.root, maxBytes: 16 }), /size limit/)
      assert.equal(requests, 1)
      assert.deepEqual(await f.files(), [])
    } finally { await f.close() }
  })
}

for (const body of [Buffer.from('{"error":"not an image"}'), image.subarray(0, 24)]) {
  test(`image validation rejects ${body[0] === 123 ? 'JSON posing as image/png' : 'a truncated PNG header'} without publishing a final file`, async () => {
    const f = await fixture((_req, res) => { res.writeHead(200, { 'Content-Type': 'image/png' }).end(body) })
    try {
      await assert.rejects(downloadFile(f.url, 'images', { root: f.root }), /not a complete supported raster image/)
      assert.deepEqual(await f.files(), [])
    } finally { await f.close() }
  })
}

test('idle timeout aborts a stalled stream and removes partial data and metadata', async () => {
  const f = await fixture((_req, res) => { res.writeHead(200, { ETag: '"stalled"' }); res.write(image.subarray(0, split)) })
  try {
    await assert.rejects(downloadFile(f.url, 'images', { root: f.root, attempts: 1, idleTimeoutMs: 40, timeoutMs: 1_000 }),
      error => (error as Error).name === 'TimeoutError' && /no progress/.test((error as Error).message))
    assert.deepEqual(await f.files(), [])
  } finally { await f.close() }
})

test('total budget aborts even a stream that keeps making progress', async () => {
  const f = await fixture((_req, res) => {
    res.writeHead(200, { ETag: '"slow"' })
    let offset = 0
    const timer = setInterval(() => { if (offset < image.length) res.write(image.subarray(offset, ++offset)) }, 10)
    res.on('close', () => clearInterval(timer))
  })
  try {
    const started = Date.now()
    await assert.rejects(downloadFile(f.url, 'images', { root: f.root, totalTimeoutMs: 65, timeoutMs: 1_000, idleTimeoutMs: 1_000, retryDelayMs: 1 }),
      error => (error as Error).name === 'TimeoutError')
    assert.ok(Date.now() - started < 800)
    assert.deepEqual(await f.files(), [])
  } finally { await f.close() }
})

test('downloads share a global concurrency limit of two', async () => {
  let active = 0
  let maximum = 0
  const f = await fixture((_req, res) => {
    active++
    maximum = Math.max(maximum, active)
    res.on('finish', () => active--)
    setTimeout(() => res.end(image), 30).unref()
  })
  try {
    const results = await Promise.all(Array.from({ length: 6 }, () => downloadFile(f.url, 'images', { root: f.root })))
    assert.equal(maximum, 2)
    assert.equal(new Set(results).size, 6)
    assert.equal((await f.files()).length, 6)
  } finally { await f.close() }
})

test('a rejected asynchronous progress callback fails without retrying or leaving files', async () => {
  let requests = 0
  const f = await fixture((_req, res) => { requests++; res.end(image) })
  try {
    await assert.rejects(downloadFile(f.url, 'images', { root: f.root, async onProgress(p) {
      if (p.receivedBytes) throw new Error('test persistence failed')
    } }), /progress callback failed/)
    assert.equal(requests, 1)
    assert.deepEqual(await f.files(), [])
  } finally { await f.close() }
})
