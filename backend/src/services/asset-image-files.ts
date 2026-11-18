import path from 'node:path'
import fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { STORAGE_ROOT } from '../utils/paths.js'
import { normalizePrivateMediaPath } from './platform-security/media.js'

export const ASSET_REFERENCE_MAX_BYTES = 30 * 1024 * 1024
export const ASSET_REFERENCE_TOTAL_BYTES = 35 * 1024 * 1024
export const assetImageError = (message: string, status = 400) => Object.assign(new Error(message), { status, statusCode: status })
export function canonicalAssetImage(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\/?static\//u.test(value)) return null
  try { return normalizePrivateMediaPath(value) } catch { return null }
}
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file)
  return !!relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
}
async function checkedFile(value: string, storageRoot: string) {
  const root = path.resolve(storageRoot), canonical = canonicalAssetImage(value)
  if (!canonical) throw assetImageError('请上传参考图片，或显式选择当前图片作为参考。')
  const file = path.join(root, ...canonical.slice('static/'.length).split('/'))
  if (!inside(root, file)) throw assetImageError('图片路径不正确。')
  const fold = (x: string) => process.platform === 'win32' ? x.toLowerCase() : x
  const rootInfo = await fs.lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || fold(await fs.realpath(root)) !== fold(root)) throw assetImageError('图片目录不可用。')
  let cursor = root
  for (const part of path.relative(root, file).split(path.sep)) {
    cursor = path.join(cursor, part)
    const info = await fs.lstat(cursor)
    if (info.isSymbolicLink() || !inside(root, await fs.realpath(cursor))) throw assetImageError('图片路径不允许链接或目录跳转。')
  }
  return { file, canonical }
}
export async function statAssetImage(value: string, storageRoot = STORAGE_ROOT) {
  const checked = await checkedFile(value, storageRoot), stat = await fs.stat(checked.file)
  if (!stat.isFile() || stat.size <= 0 || stat.size > 64 * 1024 * 1024) throw assetImageError('图片文件缺失或大小无效。')
  return { ...checked, size: stat.size, mtime: stat.mtimeMs }
}
export async function decodeAssetImage(bytes: Buffer, maxBytes = ASSET_REFERENCE_MAX_BYTES) {
  if (!bytes.length || bytes.length > maxBytes) throw assetImageError('单张参考图不能超过30MB。')
  const image = sharp(bytes, { limitInputPixels: 64_000_000 }), metadata = await image.metadata()
  if (!['png', 'jpeg', 'webp'].includes(metadata.format || '') || !metadata.width || !metadata.height || (metadata.pages || 1) > 1) throw assetImageError('仅支持完整的PNG、JPG和WEBP静态图片。')
  await image.stats()
  const mime = metadata.format === 'jpeg' ? 'image/jpeg' : `image/${metadata.format}`
  return { size: bytes.length, width: metadata.width, height: metadata.height, sha256: createHash('sha256').update(bytes).digest('hex'), dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
}
export async function readAssetImage(value: string, storageRoot = STORAGE_ROOT, maxBytes = 64 * 1024 * 1024) {
  const checked = await statAssetImage(value, storageRoot)
  if (checked.size > maxBytes) throw assetImageError('单张参考图不能超过30MB。')
  const handle = await fs.open(checked.file, 'r')
  try {
    const before = await handle.stat(), bytes = await handle.readFile(), after = await handle.stat()
    if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw assetImageError('图片在读取期间发生变化，请重新选择。', 409)
    await checkedFile(value, storageRoot)
    return { ...await decodeAssetImage(bytes, maxBytes), mtime: after.mtimeMs, path: checked.canonical }
  } finally { await handle.close() }
}

const snapshotWrites = new Map<string, Promise<string>>()
/** Fully written, content-addressed project snapshots keep large image bytes
 * outside SQLite. A hard link is made only to our own completed temporary file,
 * never to the mutable upload/current image; publication is atomic. */
export async function freezeAssetReference(image: Awaited<ReturnType<typeof decodeAssetImage>>, projectId: number) {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) throw assetImageError('参考图项目编号不正确。')
  const extension = image.dataUrl.startsWith('data:image/jpeg;') ? 'jpg' : image.dataUrl.startsWith('data:image/webp;') ? 'webp' : 'png'
  const relative = `static/asset-reference-snapshots/project-${projectId}/${image.sha256}.${extension}`
  const key = `${projectId}:${image.sha256}`
  const existing = snapshotWrites.get(key); if (existing) return existing
  const operation = (async () => {
    const target = path.join(STORAGE_ROOT, relative.slice('static/'.length))
    const directory = path.dirname(target)
    const storageRoot = path.resolve(STORAGE_ROOT), storageInfo = await fs.lstat(storageRoot)
    const fold = (value:string) => process.platform === 'win32' ? value.toLowerCase() : value
    if (!storageInfo.isDirectory() || storageInfo.isSymbolicLink() || fold(await fs.realpath(storageRoot)) !== fold(storageRoot)) throw assetImageError('参考图目录不可用。')
    // Inspect existing parents before creating the next child. Recursive mkdir
    // would follow an existing junction and create a project folder outside the
    // storage root before a later lstat could reject it.
    let checkedDirectory = storageRoot
    for (const part of path.relative(storageRoot,directory).split(path.sep)) {
      checkedDirectory = path.join(checkedDirectory,part)
      let info
      try { info = await fs.lstat(checkedDirectory) }
      catch (error: any) {
        if (error.code !== 'ENOENT') throw error
        try { await fs.mkdir(checkedDirectory) } catch (createError: any) { if (createError.code !== 'EEXIST') throw createError }
        info = await fs.lstat(checkedDirectory)
      }
      if (!info.isDirectory() || info.isSymbolicLink() || !inside(storageRoot,await fs.realpath(checkedDirectory))) throw assetImageError('参考图目录不允许链接。')
    }
    const temporary = path.join(directory, image.sha256 + '.' + randomUUID() + '.part')
    try {
      // The directory has fixed server-generated components and must not be a link.
      let cursor = path.resolve(STORAGE_ROOT)
      const root = cursor, rootInfo = await fs.lstat(root)
      if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw assetImageError('参考图目录不可用。')
      for (const part of path.relative(root, directory).split(path.sep)) {
        cursor = path.join(cursor, part)
        const info = await fs.lstat(cursor)
        if (!info.isDirectory() || info.isSymbolicLink() || !inside(root, await fs.realpath(cursor))) throw assetImageError('参考图目录不允许链接。')
      }
      await fs.writeFile(temporary, Buffer.from(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1), 'base64'), { flag: 'wx', mode: 0o600 })
      try { await fs.link(temporary, target) } catch (error: any) { if (error.code !== 'EEXIST') throw error }
      const frozen = await readAssetImage(relative, undefined, ASSET_REFERENCE_MAX_BYTES)
      if (frozen.sha256 !== image.sha256) throw assetImageError('参考图快照已被修改，未提交生成。', 409)
      return relative
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  })()
  snapshotWrites.set(key, operation)
  try { return await operation } finally { if (snapshotWrites.get(key) === operation) snapshotWrites.delete(key) }
}
export async function resolveFrozenAssetReferences(references: unknown, hashes: unknown) {
  if (!Array.isArray(references) || !Array.isArray(hashes) || references.length !== hashes.length || references.length > 6) throw assetImageError('参考图快照信息不完整，未改成纯文生图。')
  const result: string[] = []; let total = 0
  for (let i = 0; i < references.length; i++) {
    const image = await readAssetImage(references[i], undefined, ASSET_REFERENCE_MAX_BYTES)
    if (typeof hashes[i] !== 'string' || image.sha256 !== hashes[i]) throw assetImageError('参考图快照已被外部修改，未提交生成。', 409)
    total += image.size
    if (total > ASSET_REFERENCE_TOTAL_BYTES) throw assetImageError('参考图快照总大小超过35MB。')
    result.push(image.dataUrl)
  }
  return result
}
