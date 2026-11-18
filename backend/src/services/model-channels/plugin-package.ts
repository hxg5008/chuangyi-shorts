import { inflateRawSync, crc32 } from 'node:zlib'
import { createHash } from 'node:crypto'

/** Read a data-only ZIP package without extracting or executing any bundled file. */
export function parsePluginPackage(bytes: Buffer, filename = 'manifest.json') {
  if (bytes.length > 32 * 1024 * 1024) throw new Error('插件包超过32MB')
  let raw: Buffer
  if (filename.toLowerCase().endsWith('.json')) raw = bytes
  else {
    if (!filename.toLowerCase().endsWith('.yingce-plugin') && !filename.toLowerCase().endsWith('.zip'))
      throw new Error('请选择 manifest.json 或 .yingce-plugin ZIP包')
    let end = -1
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
      if (bytes.readUInt32LE(i) === 0x06054b50) {
        end = i
        break
      }
    if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0)
      throw new Error('ZIP目录损坏或不支持分卷ZIP')
    const count = bytes.readUInt16LE(end + 10),
      size = bytes.readUInt32LE(end + 12),
      offset = bytes.readUInt32LE(end + 16)
    if (count > 2000 || count === 65535 || offset + size > end) throw new Error('ZIP目录或条目数量不正确')
    const names = new Set<string>()
    let cursor = offset,
      total = 0,
      manifest: Buffer | undefined
    for (let index = 0; index < count; index++) {
      if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50)
        throw new Error('ZIP条目损坏')
      const flags = bytes.readUInt16LE(cursor + 8),
        method = bytes.readUInt16LE(cursor + 10),
        compressed = bytes.readUInt32LE(cursor + 20),
        expanded = bytes.readUInt32LE(cursor + 24),
        nameLen = bytes.readUInt16LE(cursor + 28),
        extraLen = bytes.readUInt16LE(cursor + 30),
        commentLen = bytes.readUInt16LE(cursor + 32),
        local = bytes.readUInt32LE(cursor + 42)
      if (cursor + 46 + nameLen + extraLen + commentLen > bytes.length) throw new Error('ZIP条目长度错误')
      const name = bytes.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8')
      if (
        !name ||
        name.includes('\\') ||
        name.startsWith('/') ||
        /^[A-Za-z]:/u.test(name) ||
        name.split('/').some((part) => part === '..') ||
        names.has(name) ||
        /[\x00-\x1f]/u.test(name)
      )
        throw new Error('ZIP含危险、重复或越界文件路径')
      names.add(name)
      total += expanded
      if (flags & 1 || ![0, 8].includes(method) || expanded > 32 * 1024 * 1024 || total > 128 * 1024 * 1024)
        throw new Error('ZIP含加密、异常压缩或过大文件')
      const unixMode = bytes.readUInt32LE(cursor + 38) >>> 16
      if ((unixMode & 0xf000) === 0xa000) throw new Error('ZIP不能包含符号链接')
      if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50)
        throw new Error('ZIP本地目录错误')
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
      if (start + compressed > offset) throw new Error('ZIP文件数据越界')
      if (name === 'manifest.json') {
        if (expanded > 4 * 1024 * 1024) throw new Error('manifest.json超过4MB')
        const data = bytes.subarray(start, start + compressed)
        manifest =
          method === 0 ? Buffer.from(data) : inflateRawSync(data, { maxOutputLength: 4 * 1024 * 1024 })
        if (manifest.length !== expanded) throw new Error('manifest.json解压长度不符')
        if (crc32(manifest) !== bytes.readUInt32LE(cursor + 16))
          throw new Error('manifest.json的ZIP校验和不一致')
      }
      cursor += 46 + nameLen + extraLen + commentLen
    }
    if (!manifest) throw new Error('ZIP根目录缺少 manifest.json')
    raw = manifest
  }
  if (raw.length > 4 * 1024 * 1024) throw new Error('manifest.json超过4MB')
  let manifest: any
  try {
    manifest = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/u, ''))
  } catch {
    throw new Error('manifest.json不是有效JSON')
  }
  if (
    !manifest ||
    manifest.apiVersion !== 'yingce.plugin/v2' ||
    typeof manifest.id !== 'string' ||
    !manifest.id ||
    !Array.isArray(manifest.contributes?.providers) ||
    !manifest.contributes.providers.length
  )
    throw new Error('需要包含provider贡献的 yingce.plugin/v2 清单')
  if (manifest.contributes.providers.length > 200) throw new Error('插件provider数量超过200')
  const ids = new Set<string>()
  for (const provider of manifest.contributes.providers) {
    if (
      typeof provider.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(provider.id) ||
      ids.has(provider.id)
    )
      throw new Error('provider ID不正确或重复')
    ids.add(provider.id)
  }
  return { manifest, sha256: createHash('sha256').update(bytes).digest('hex') }
}
