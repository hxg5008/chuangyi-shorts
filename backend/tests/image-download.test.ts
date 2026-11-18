import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { downloadFile } from '../src/utils/storage.ts'

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

async function serve(handler: http.RequestListener) {
  const server = http.createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`,
    close: () => new Promise<void>(resolve => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

test('image download saves the complete response and leaves only the final file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-download-'))
  const server = await serve((req, res) => {
    assert.equal(req.method, 'GET')
    res.writeHead(200, { 'Content-Type': 'image/png' }).end(image)
  })
  try {
    const relative = await downloadFile(`${server.url}/image.png?signature=test`, 'images', { root })
    assert.match(relative, /^static\/images\/[\w-]+\.png$/)
    const filename = path.basename(relative)
    assert.deepEqual(await fs.readFile(path.join(root, 'images', filename)), image)
    assert.deepEqual(await fs.readdir(path.join(root, 'images')), [filename])
  } finally {
    await server.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('image download retries a transient HTTP error without creating extra files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-http-retry-'))
  let requests = 0
  const server = await serve((_req, res) => {
    if (++requests === 1) { res.writeHead(503).end('temporary'); return }
    res.end(image)
  })
  try {
    const relative = await downloadFile(`${server.url}/image.png`, 'images', { root, retryDelayMs: 1 })
    assert.equal(requests, 2)
    assert.deepEqual(await fs.readFile(path.join(root, 'images', path.basename(relative))), image)
    assert.equal((await fs.readdir(path.join(root, 'images'))).length, 1)
  } finally {
    await server.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('image download does not retry a permanent HTTP failure or leave files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-http-permanent-'))
  let requests = 0
  const server = await serve((_req, res) => { requests++; res.writeHead(404).end('missing') })
  try {
    await assert.rejects(downloadFile(`${server.url}/image.png`, 'images', { root, retryDelayMs: 1 }), /Image download HTTP 404/)
    assert.equal(requests, 1)
    assert.deepEqual(await fs.readdir(path.join(root, 'images')), [])
  } finally {
    await server.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('image download times out stalled bodies, exhausts bounded retries and leaves no files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-body-timeout-'))
  let requests = 0
  const server = await serve((_req, res) => {
    requests++
    res.writeHead(200, { 'Content-Type': 'image/png' })
    res.write(image.subarray(0, 8))
  })
  try {
    await assert.rejects(downloadFile(`${server.url}/image.png`, 'images', { root, attempts: 2, timeoutMs: 60, retryDelayMs: 1 }),
      error => ['TimeoutError', 'AbortError'].includes((error as Error).name))
    assert.equal(requests, 2)
    assert.deepEqual(await fs.readdir(path.join(root, 'images')), [])
  } finally {
    await server.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('image download retries a dropped connection using GET only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-network-retry-'))
  let requests = 0
  const server = await serve((req, res) => {
    assert.equal(req.method, 'GET')
    if (++requests === 1) { req.socket.destroy(); return }
    res.end(image)
  })
  try {
    const relative = await downloadFile(`${server.url}/image.png`, 'images', { root, attempts: 2, retryDelayMs: 1 })
    assert.equal(requests, 2)
    assert.deepEqual(await fs.readFile(path.join(root, 'images', path.basename(relative))), image)
    assert.equal((await fs.readdir(path.join(root, 'images'))).length, 1)
  } finally {
    await server.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
