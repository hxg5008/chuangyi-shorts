import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { applyRelayStatus, LEGACY_POLL_IMAGE, UPDATED_POLL_IMAGE } from './apply-relay-status.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const record = (relative, bytes) => ({ path: relative, bytes: bytes.length, sha256: digest(bytes) })
const updater = fileURLToPath(new URL('./apply-relay-status.mjs', import.meta.url))
async function fixture(t, hub = false, newline = '\n') {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), '官号补丁 空格-'))
  const root = path.join(temporary, '统一 服务 示例')
  await fs.mkdir(root)
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), temporary)
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(temporary).startsWith('官号补丁 空格-'))
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const directory = hub ? path.join(root, 'engines', 'gpt') : root
  if (hub) { await fs.mkdir(path.join(root, 'engines')); await fs.mkdir(directory) }
  const prefix = '\uFEFF// Other module code, guards and slots must stay byte-identical.\nexport const untouched = { concurrency: 4, guard: true }\n'.replace(/\n/gu, newline)
  const bytes = Buffer.from(prefix + LEGACY_POLL_IMAGE.replace(/\n/gu, newline) + newline)
  const module = path.join(directory, 'images.mjs')
  await fs.writeFile(module, bytes)
  const unrelated = Buffer.from('export const unrelated = true\n')
  await fs.writeFile(path.join(root, 'server.mjs'), unrelated)
  await fs.mkdir(path.join(root, 'data'))
  const sentinels = new Map([
    ['data/accounts.json', Buffer.from('{"email":"synthetic@example.invalid"}')],
    ['data/client-key.txt', Buffer.from('synthetic-private-sentinel')],
    ['data/cookies.json', Buffer.from('{"cookie":"synthetic-cookie-sentinel"}')],
    ['data/tasks.sqlite3', Buffer.from([0, 1, 2, 3, 255])],
    ['网络设置.json', Buffer.from('{"ip":"192.168.0.50","port":5690}')]
  ])
  for (const [relative, value] of sentinels) await fs.writeFile(path.join(root, relative), value)
  const inner = { application: 'Synthetic GPT Relay', createdAt: 'unchanged', source: { accountDataIncluded: false }, files: [record('images.mjs', bytes), { path: 'other.mjs', bytes: 7, sha256: '1'.repeat(64), custom: 'unchanged' }] }
  const innerBytes = Buffer.from(JSON.stringify(inner, null, 2) + '\n')
  await fs.writeFile(path.join(directory, 'MANIFEST.json'), innerBytes)
  let outer
  if (hub) {
    outer = { application: 'Synthetic Local Hub', sources: { gpt: { manifestSha256: 'origin-proof-unchanged' } }, files: [record('engines/gpt/images.mjs', bytes), record('engines/gpt/MANIFEST.json', innerBytes), record('server.mjs', unrelated)] }
    await fs.writeFile(path.join(root, 'package-manifest.json'), JSON.stringify(outer, null, 2) + '\n')
  }
  async function unchangedData() { for (const [relative, value] of sentinels) assert.deepEqual(await fs.readFile(path.join(root, relative)), value, `${relative} must not be changed`) }
  return { root, directory, module, bytes, prefix, inner, innerBytes, outer, sentinels, unchangedData }
}

test('standalone relay patch supports Chinese paths, spaces, BOM/CRLF, exact backups and idempotence', async t => {
  const f = await fixture(t, false, '\r\n')
  const checked = await applyRelayStatus({ serviceRoot: f.root, checkOnly: true })
  assert.equal(checked.status, 'ready')
  assert.deepEqual(await fs.readFile(f.module), f.bytes)
  await assert.rejects(fs.stat(path.join(f.root, 'data', 'updates')), { code: 'ENOENT' })
  const result = await applyRelayStatus({ serviceRoot: f.root, serviceStopped: true })
  assert.equal(result.status, 'patched')
  const updated = await fs.readFile(f.module)
  assert(updated.subarray(0, Buffer.byteLength(f.prefix)).equals(Buffer.from(f.prefix)))
  assert.equal(updated.toString().slice(f.prefix.length), UPDATED_POLL_IMAGE.replace(/\n/gu, '\r\n') + '\r\n')
  const receipt = JSON.parse(await fs.readFile(path.join(result.backupDirectory, 'receipt.json'), 'utf8'))
  for (const item of receipt.files) {
    const backup = await fs.readFile(path.join(result.backupDirectory, item.backup))
    assert.equal(digest(backup), item.beforeSha256)
  }
  assert.deepEqual(await fs.readFile(path.join(result.backupDirectory, '0-images.mjs.original')), f.bytes)
  const manifest = JSON.parse(await fs.readFile(path.join(f.root, 'MANIFEST.json'), 'utf8'))
  assert.deepEqual(manifest.files[0], record('images.mjs', updated))
  assert.deepEqual(manifest.files[1], f.inner.files[1]); assert.equal(manifest.createdAt, 'unchanged')
  const beforeManifest = await fs.readFile(path.join(f.root, 'MANIFEST.json'))
  const beforeBackups = await fs.readdir(path.join(f.root, 'data', 'updates'))
  assert.equal((await applyRelayStatus({ serviceRoot: f.root, serviceStopped: true })).status, 'already-patched')
  assert.deepEqual(await fs.readFile(f.module), updated)
  assert.deepEqual(await fs.readFile(path.join(f.root, 'MANIFEST.json')), beforeManifest)
  assert.deepEqual(await fs.readdir(path.join(f.root, 'data', 'updates')), beforeBackups)
  await f.unchangedData()
})

test('unified service updates only the GPT module inventory and the corresponding child-manifest checksum', async t => {
  const f = await fixture(t, true)
  const result = await applyRelayStatus({ serviceRoot: f.root, serviceStopped: true })
  assert.equal(result.module, 'engines/gpt/images.mjs')
  const updated = await fs.readFile(f.module)
  const childBytes = await fs.readFile(path.join(f.directory, 'MANIFEST.json'))
  const outer = JSON.parse(await fs.readFile(path.join(f.root, 'package-manifest.json'), 'utf8'))
  assert.deepEqual(outer.files[0], record('engines/gpt/images.mjs', updated))
  assert.deepEqual(outer.files[1], record('engines/gpt/MANIFEST.json', childBytes))
  assert.deepEqual(outer.files[2], f.outer.files[2]); assert.deepEqual(outer.sources, f.outer.sources)
  await f.unchangedData()
})

test('unknown pollImage structure or mismatched inventory refuses all writes', async t => {
  const f = await fixture(t)
  const changed = Buffer.from(f.bytes.toString().replace("status: 'processing'", "status: 'custom-running'"))
  await fs.writeFile(f.module, changed)
  await assert.rejects(applyRelayStatus({ serviceRoot: f.root, serviceStopped: true }), /未知结构|已验证的旧版结构/u)
  assert.deepEqual(await fs.readFile(f.module), changed)
  assert.deepEqual(await fs.readFile(path.join(f.root, 'MANIFEST.json')), f.innerBytes)
  await assert.rejects(fs.stat(path.join(f.root, 'data', 'updates')), { code: 'ENOENT' })
  await fs.writeFile(f.module, f.bytes)
  const manifest = structuredClone(f.inner); manifest.files[0].sha256 = '0'.repeat(64)
  await fs.writeFile(path.join(f.root, 'MANIFEST.json'), JSON.stringify(manifest))
  await assert.rejects(applyRelayStatus({ serviceRoot: f.root, serviceStopped: true }), /发布清单不符/u)
  assert.deepEqual(await fs.readFile(f.module), f.bytes)
  await f.unchangedData()
})

test('writes require a manual stopped-service flag, and the CLI check handles a quoted Chinese service root', async t => {
  const f = await fixture(t)
  await assert.rejects(applyRelayStatus({ serviceRoot: f.root }), /手动停止/u)
  const { stdout } = await promisify(execFile)(process.execPath, [updater, '--service-root', f.root, '--check'], { windowsHide: true })
  assert.equal(JSON.parse(stdout).status, 'ready')
  assert.deepEqual(await fs.readFile(f.module), f.bytes)
  await f.unchangedData()
})

test('the inserted poll response exposes queue and valid timings without exposing the shared account', async () => {
  class Store { async save() { return 'a'.repeat(43) } }
  const poll = new Function('TASK_ID', 'invalid', 'ImageResultStore', UPDATED_POLL_IMAGE.replace('export ', '') + '; return pollImage')(/^[A-Za-z0-9_-]+$/u, message => Error(message), Store)
  const task = { status: 'pending', createdAt: '2026-11-07T10:00:00Z', startedAt: 'not-a-date', accountEmail: 'synthetic-private@example.invalid' }
  const options = { service: { getImageTask: async () => task }, resultStore: new Store(), publicBaseUrl: 'https://synthetic.invalid' }
  assert.deepEqual(await poll('task-one', options), { status: 'pending', stage: 'queued', createdAt: task.createdAt })
  task.status = 'running'; task.startedAt = '2026-11-07T10:01:00Z'
  assert.deepEqual(await poll('task-one', options), { status: 'processing', stage: 'generating', createdAt: task.createdAt, startedAt: task.startedAt })
  task.status = 'completed'; task.finishedAt = '2026-11-07T10:02:00Z'
  const result = await poll('task-one', options)
  assert.equal(result.status, 'completed'); assert.equal(result.finishedAt, task.finishedAt)
  assert(!JSON.stringify(result).includes('synthetic-private'))
})
