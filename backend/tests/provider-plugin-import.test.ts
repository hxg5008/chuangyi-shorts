import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deflateRawSync, crc32 } from 'node:zlib'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-plugin-import-'))
process.env.HUOBAO_DATA_DIR = root
process.env.SQLITE_PATH = path.join(root, 'plugins.sqlite3')
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db } = await import('../src/db/index.ts')
const { getModelChannelStore } = await import('../src/services/model-channels/store.ts')
const { parsePluginPackage } = await import('../src/services/model-channels/plugin-package.ts')
const { importProviderManifest } = await import('../src/services/model-channels/plugin-catalog.ts')
const { validateModelParameters, normalizeProviderParameters } =
  await import('../src/services/model-channels/parameters.ts')
const { shutdownProviderEngine } = await import('../src/services/provider-runtime/index.ts')
const source = JSON.parse(
  await fs.readFile(
    new URL('../src/services/model-channels/bundled/openai-chat-completions.json', import.meta.url),
    'utf8'
  )
)
function zip(body: Buffer, name = 'manifest.json') {
  const filename = Buffer.from(name),
    compressed = deflateRawSync(body),
    local = Buffer.alloc(30),
    central = Buffer.alloc(46),
    end = Buffer.alloc(22)
  local.writeUInt32LE(0x04034b50)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(crc32(body), 14)
  local.writeUInt32LE(compressed.length, 18)
  local.writeUInt32LE(body.length, 22)
  local.writeUInt16LE(filename.length, 26)
  central.writeUInt32LE(0x02014b50)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(crc32(body), 16)
  central.writeUInt32LE(compressed.length, 20)
  central.writeUInt32LE(body.length, 24)
  central.writeUInt16LE(filename.length, 28)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + filename.length, 12)
  end.writeUInt32LE(local.length + filename.length + compressed.length, 16)
  return Buffer.concat([local, filename, compressed, central, filename, end])
}
test('Yingce ZIP import previews every provider and imports stable versioned snapshots without executing model requests', async () => {
  const manifest = {
    ...source,
    id: 'synthetic-multi-provider',
    contributes: {
      providers: [
        source.contributes.providers[0],
        { ...source.contributes.providers[0], id: 'synthetic-chat-two', label: 'Second synthetic text' }
      ]
    }
  }
  const parsed = parsePluginPackage(zip(Buffer.from(JSON.stringify(manifest))), 'synthetic.yingce-plugin')
  assert.equal(parsed.manifest.id, 'synthetic-multi-provider')
  const store = getModelChannelStore(),
    before = store.protocols().length
  const preview = await importProviderManifest(parsed.manifest, { preview: true, store })
  assert.equal(preview.providers.length, 2)
  assert.equal(preview.imported, false)
  assert(preview.providers.every((provider) => provider.executable))
  assert.equal(store.protocols().length, before)
  const imported = await importProviderManifest(parsed.manifest, { store })
  assert.equal(imported.imported, true)
  assert.equal(store.protocols().length, before + 2)
  const protocol = store.protocol('engine.synthetic-chat-two')!,
    snapshot = structuredClone(protocol.definition)
  await importProviderManifest(parsed.manifest, { store })
  assert.equal(store.protocol(protocol.id)?.version, protocol.version)
  const changed = structuredClone(manifest)
  changed.version = '9.9.9'
  changed.contributes.providers[1].create.path = '/v2/chat/completions'
  await importProviderManifest(changed, { store })
  assert.equal(store.protocol(protocol.id)?.version, protocol.version + 1)
  assert.equal(
    snapshot.manifest.contributes.providers[1].create.path,
    source.contributes.providers[0].create.path
  )
  assert.equal(
    (
      db.$client
        .prepare('SELECT COUNT(*) count FROM platform_model_protocol_versions WHERE protocol_id=?')
        .get(protocol.id) as any
    ).count,
    2
  )
})
test('ZIP traversal, corrupted integrity, encrypted entries and unreasonable decompression declarations are rejected', () => {
  const body = Buffer.from(JSON.stringify(source)),
    valid = zip(body)
  assert.throws(() => parsePluginPackage(zip(body, '../manifest.json'), 'invalid.yingce-plugin'), /危险/)
  const checksum = Buffer.from(valid),
    end = checksum.length - 22,
    offset = checksum.readUInt32LE(end + 16)
  checksum.writeUInt32LE(0, offset + 16)
  assert.throws(() => parsePluginPackage(checksum, 'invalid.yingce-plugin'), /校验和/)
  const encrypted = Buffer.from(valid)
  encrypted.writeUInt16LE(1, offset + 8)
  assert.throws(() => parsePluginPackage(encrypted, 'invalid.yingce-plugin'), /加密/)
  const bomb = Buffer.from(valid)
  bomb.writeUInt32LE(100 * 1024 * 1024, offset + 24)
  assert.throws(() => parsePluginPackage(bomb, 'invalid.yingce-plugin'), /过大/)
})
test('dynamic channel auth is encrypted, blanks retain secrets and explicit clearing does not erase other fields', () => {
  const store = getModelChannelStore(),
    channel = store.saveChannel({
      name: 'Signed synthetic channel',
      base_url: 'https://signed.invalid',
      auth_fields: {
        accessKeyId: 'synthetic-access',
        secretAccessKey: 'synthetic-secret',
        region: 'synthetic-region'
      }
    })
  assert.deepEqual(channel.has_auth_fields.sort(), ['accessKeyId', 'region', 'secretAccessKey'].sort())
  assert(!JSON.stringify(channel).includes('synthetic-secret'))
  assert(
    !JSON.stringify(db.$client.prepare('SELECT * FROM platform_model_channels').all()).includes(
      'synthetic-secret'
    )
  )
  store.saveChannel({ auth_fields: { secretAccessKey: '' } }, channel.id)
  assert.equal(store.channelConnection(channel.id).authFields?.secretAccessKey, 'synthetic-secret')
  store.saveChannel({ clear_auth_fields: ['secretAccessKey'] }, channel.id)
  assert.equal(store.channelConnection(channel.id).authFields?.secretAccessKey, undefined)
  assert.equal(store.channelConnection(channel.id).authFields?.accessKeyId, 'synthetic-access')
})
test('dynamic parameters keep false and zero but reject unknown, nested reserved overrides and unsafe binding controls', () => {
  const config = {
    parameters: [
      { key: 'switch', type: 'boolean', label: 'Switch' },
      { key: 'level', type: 'number', label: 'Level', min: 0, max: 2 },
      { key: 'providerOptions', type: 'object', label: 'Options' }
    ],
    defaults: { switch: true, level: 1 }
  }
  assert.deepEqual(validateModelParameters(config, { switch: false, level: 0 }), { switch: false, level: 0 })
  assert.throws(() => validateModelParameters(config, { unknown: 1 }), /未声明参数/)
  assert.throws(
    () => validateModelParameters(config, { providerOptions: { provider: { model: 'hidden-sku' } } }),
    /保留字段/
  )
  assert.throws(() => validateModelParameters(config, { level: 3 }), /超出范围/)
  assert.deepEqual(
    normalizeProviderParameters({
      parameters: [
        { name: 'innocent', binding: 'model', type: 'string' },
        { name: 'temperature', type: 'number' }
      ]
    }).map((parameter) => parameter.key),
    ['temperature']
  )
})
test.after(async () => {
  shutdownProviderEngine()
  db.$client.close()
  assert(path.basename(root).startsWith('huobao-plugin-import-'))
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
