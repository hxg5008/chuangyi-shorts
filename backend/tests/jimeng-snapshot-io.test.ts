/** Filesystem failure/compatibility checks. Only disposable local images; no service or model. */
import test, { after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import sharp from 'sharp'

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'jimeng-snapshot-io-'))
process.env.HUOBAO_DATA_DIR = temporary
process.env.STORAGE_PATH = path.join(temporary, 'static')
const { freezeJimengReferences, prepareJimengVideoRecord } = await import('../src/services/jimeng-local-media.ts')
const cache = path.join(temporary, 'jimeng-reference-snapshots')
const original = { link: fs.link, rename: fs.rename, unlink: fs.unlink }
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const error = (code: string) => Object.assign(new Error('synthetic ' + code), { code })
async function fixture(color: string) {
  const bytes = await sharp({ create: { width: 20, height: 14, channels: 3, background: color } }).png().toBuffer()
  const hash = digest(bytes)
  return { bytes, hash, file: path.join(cache, hash + '.image'), record: { id: 1, model: 'jimeng-2.0-fast', prompt: 'local I/O verification',
    referenceImageUrls: JSON.stringify(['data:image/png;base64,' + bytes.toString('base64')]), referenceImageNames: JSON.stringify(['reference']) } }
}
afterEach(() => { fs.link = original.link; fs.rename = original.rename; fs.unlink = original.unlink })
after(async () => {
  const base = path.resolve(os.tmpdir()) + path.sep, target = path.resolve(temporary)
  assert.ok(target.startsWith(base) && path.basename(target).startsWith('jimeng-snapshot-io-'))
  await fs.rm(target, { recursive: true, force: true })
})

test('a filesystem without hard links publishes complete bytes through rename', async () => {
  const item = await fixture('#113355')
  fs.link = async () => { throw error('ENOTSUP') }
  const snapshots = await freezeJimengReferences(item.record)
  const prepared = await prepareJimengVideoRecord(item.record, snapshots)
  assert.equal(prepared.jimengImages![0].data_base64, item.bytes.toString('base64'))
  assert.equal(digest(await fs.readFile(item.file)), item.hash)
})

test('an interrupted partial snapshot is repaired from the current verified original bytes', async () => {
  const item = await fixture('#224466')
  await fs.mkdir(cache, { recursive: true })
  await fs.writeFile(item.file, 'partial')
  const snapshots = await freezeJimengReferences(item.record)
  assert.equal(snapshots[0].sha256, item.hash)
  assert.equal(digest(await fs.readFile(item.file)), item.hash)
  assert.equal((await prepareJimengVideoRecord(item.record, snapshots)).jimengImages![0].data_base64, item.bytes.toString('base64'))
})

test('a snapshot symlink is rejected without modifying its outside target', async t => {
  const item = await fixture('#335577'), outside = path.join(temporary, 'outside-target.image')
  await fs.writeFile(outside, 'do not modify')
  try { await fs.symlink(outside, item.file) }
  catch (failure: any) { if (failure.code === 'EPERM' || failure.code === 'EACCES') { t.skip('Symbolic link creation is unavailable for this Windows user'); return } throw failure }
  await assert.rejects(freezeJimengReferences(item.record), (failure: any) => failure.errorCode === 'reference_mismatch')
  assert.equal(await fs.readFile(outside, 'utf8'), 'do not modify')
  assert.equal((await fs.lstat(item.file)).isSymbolicLink(), true)
})

test('publication failure cleans only its own temporary file and preserves unrelated files', async () => {
  const item = await fixture('#446688'), foreign = path.join(cache, 'foreign.tmp')
  await fs.writeFile(foreign, 'keep')
  fs.link = async () => { throw error('EIO') }
  await assert.rejects(freezeJimengReferences(item.record), /synthetic EIO/u)
  assert.equal(await fs.readFile(foreign, 'utf8'), 'keep')
  assert.deepEqual((await fs.readdir(cache)).filter(name => name.startsWith(item.hash) && name.endsWith('.tmp')), [])
  await assert.rejects(fs.stat(item.file), (failure: any) => failure.code === 'ENOENT')
})

test('temporary cleanup failure cannot turn an already published correct snapshot into a failed request', async () => {
  const item = await fixture('#557799'), attempted: string[] = []
  fs.unlink = async target => {
    const value = String(target)
    if (path.basename(value).startsWith(item.hash) && value.endsWith('.tmp')) { attempted.push(value); throw error('EBUSY') }
    return original.unlink(target)
  }
  const snapshots = await freezeJimengReferences(item.record)
  assert.equal(digest(await fs.readFile(item.file)), item.hash)
  assert.equal((await prepareJimengVideoRecord(item.record, snapshots)).jimengImages![0].data_base64, item.bytes.toString('base64'))
  assert.equal(attempted.length, 1)
  fs.unlink = original.unlink
  for (const target of attempted) await fs.unlink(target)
})

test('temporary Windows rename sharing violations are retried, but a permanent busy file fails within a bounded wait', async () => {
  const item = await fixture('#6688aa')
  fs.link = async () => { throw error('ENOTSUP') }
  let calls = 0
  fs.rename = async (from, to) => { if (++calls <= 2) throw error('EPERM'); return original.rename(from, to) }
  await freezeJimengReferences(item.record)
  assert.ok(calls > 1)
  assert.equal(digest(await fs.readFile(item.file)), item.hash)
  const busy = await fixture('#7799bb')
  await fs.writeFile(busy.file, 'original partial')
  calls = 0
  fs.rename = async () => { calls++; throw error('EBUSY') }
  await assert.rejects(freezeJimengReferences(busy.record), (failure: any) => failure.errorCode === 'snapshot_write_busy')
  assert.ok(calls > 1 && calls <= 8)
  assert.equal(await fs.readFile(busy.file, 'utf8'), 'original partial')
  assert.deepEqual((await fs.readdir(cache)).filter(name => name.startsWith(busy.hash) && name.endsWith('.tmp')), [])
})
