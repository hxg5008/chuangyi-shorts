import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { createProviderHttp, fetchImageProvider, fetchTextProvider } from '../src/utils/http.ts'

async function serve(handler: http.RequestListener) {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

test('provider requests respect the configured header budget', async () => {
  const server = await serve((_req, res) => {
    setTimeout(() => res.end('ready'), 1_700).unref()
  })
  const short = createProviderHttp({ headersTimeoutMs: 30 })
  const patient = createProviderHttp({ headersTimeoutMs: 4_000 })
  try {
    await assert.rejects(
      short.fetch(server.url),
      (error) => (error as any).cause?.code === 'UND_ERR_HEADERS_TIMEOUT'
    )
    assert.equal(await (await patient.fetch(server.url)).text(), 'ready')
  } finally {
    await short.destroy()
    await patient.destroy()
    await server.close()
  }
})

test('provider connections time out a stalled TLS handshake', async () => {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const client = createProviderHttp({ connectTimeoutMs: 100 })
  try {
    const url = `https://127.0.0.1:${(server.address() as net.AddressInfo).port}`
    await assert.rejects(
      client.fetch(url),
      (error) => (error as any).cause?.code === 'UND_ERR_CONNECT_TIMEOUT'
    )
  } finally {
    await client.destroy()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('provider fetch accepts native multipart forms and preserves response headers', async () => {
  let received = ''
  let contentType = ''
  const server = await serve(async (req, res) => {
    contentType = req.headers['content-type'] || ''
    for await (const chunk of req) received += chunk.toString()
    res.setHeader('X-Task-Id', 'local-task')
    res.setHeader('Content-Type', 'application/json')
    res.end('{"ok":true}')
  })
  const client = createProviderHttp()
  try {
    const form = new FormData()
    form.append('prompt', 'test prompt')
    form.append('image', new Blob(['test image'], { type: 'image/png' }), 'test.png')
    const response = await client.fetch(server.url, { method: 'POST', body: form })
    assert.deepEqual(await response.json(), { ok: true })
    assert.equal(response.headers.get('X-Task-Id'), 'local-task')
    assert.match(contentType, /^multipart\/form-data; boundary=/)
    assert.match(received, /test prompt/)
    assert.match(received, /test image/)
  } finally {
    await client.destroy()
    await server.close()
  }
})

test('provider fetch does not replay a POST when its connection is interrupted', async () => {
  let submissions = 0
  const server = await serve((req) => {
    submissions++
    req.socket.destroy()
  })
  const client = createProviderHttp()
  try {
    await assert.rejects(client.fetch(server.url, { method: 'POST', body: 'billable request' }))
    assert.equal(submissions, 1)
  } finally {
    await client.destroy()
    await server.close()
  }
})

test('image provider transport does not impose a hidden four-socket synchronous generation queue', async () => {
  const waiting: http.ServerResponse[] = []
  const submitted: string[] = []
  const server = await serve(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk.toString()
    submitted.push(body)
    waiting.push(res)
  })
  const bodies = Array.from({ length: 7 }, (_, index) =>
    JSON.stringify({ model: 'synthetic-model', prompt: `中文🌙请求${index}` })
  )
  const jobs = bodies.map((body) =>
    fetchImageProvider(server.url, { method: 'POST', body, signal: AbortSignal.timeout(10_000) }).then(
      (response) => response.text()
    )
  )
  try {
    const deadline = Date.now() + 8_000
    while (waiting.length < bodies.length && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(waiting.length, 7, 'All submissions must arrive before the provider returns any response')
    assert.deepEqual([...submitted].sort(), [...bodies].sort())
    for (const response of waiting) response.end('done')
    assert.deepEqual(await Promise.all(jobs), Array(7).fill('done'))
  } finally {
    await server.close()
    await Promise.allSettled(jobs)
  }
})

test('provider fetch obeys an earlier caller cancellation deadline', async () => {
  const server = await serve(() => {})
  const client = createProviderHttp({ headersTimeoutMs: 10_000 })
  try {
    await assert.rejects(
      client.fetch(server.url, { signal: AbortSignal.timeout(30) }),
      (error) => (error as Error).name === 'TimeoutError'
    )
  } finally {
    await client.destroy()
    await server.close()
  }
})

test('independent text preparation jobs do not wait behind an implicit four-socket transport cap', async () => {
  const waiting: http.ServerResponse[] = [], received: string[] = []
  const server = await serve(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk.toString()
    received.push(body); waiting.push(res)
  })
  const requests = Array.from({ length: 9 }, (_, i) => JSON.stringify({ model: 'local-text', prompt: `独立资产提示词 ${i} 🌙` }))
  const jobs = requests.map(body => fetchTextProvider(server.url, { method: 'POST', body, signal: AbortSignal.timeout(10000) }).then(response => response.text()))
  try {
    const deadline = Date.now() + 8000
    while (waiting.length < requests.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(waiting.length, 9, 'Every text preparation must reach the upstream before any response is released')
    assert.deepEqual([...received].sort(), [...requests].sort())
    for (const response of waiting) response.end('complete')
    assert.deepEqual(await Promise.all(jobs), Array(9).fill('complete'))
  } finally { await server.close(); await Promise.allSettled(jobs) }
})

test('configured proxy routes remote providers while local API addresses bypass the proxy', async () => {
  const origin = await serve((_req, res) => res.end('provider reached'))
  const port = Number(new URL(origin.url).port)
  const sockets = new Set<net.Socket>()
  let tunnels = 0
  const proxy = http.createServer()
  proxy.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  proxy.on('connect', (_req, downstream, head) => {
    tunnels++
    const upstream = net.createConnection({ host: '127.0.0.1', port })
    sockets.add(upstream)
    upstream.on('close', () => sockets.delete(upstream))
    upstream.on('error', () => downstream.destroy())
    downstream.on('error', () => upstream.destroy())
    upstream.on('connect', () => {
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      downstream.pipe(upstream).pipe(downstream)
    })
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const client = createProviderHttp({
    proxyUrl: `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`
  })
  try {
    assert.equal(await (await client.fetch(`http://provider.test:${port}/models`)).text(), 'provider reached')
    assert.equal(tunnels, 1)
    assert.equal(await (await client.fetch(origin.url)).text(), 'provider reached')
    assert.equal(tunnels, 1, 'loopback HTTP requests must stay local')
  } finally {
    await client.destroy()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
    await origin.close()
  }
})
