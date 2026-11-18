import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export const LEGACY_POLL_IMAGE = `export async function pollImage(taskId, { service, resultStore, publicBaseUrl }) {
  if (!TASK_ID.test(taskId || '')) throw invalid('图片任务编号无效。')
  if (!service || typeof service.getImageTask !== 'function' || !(resultStore instanceof ImageResultStore)) throw invalid('本机图片服务尚未就绪。', 503)
  const task = await service.getImageTask(taskId)
  if (task.unknown === true) return { status: 'failed', error: { message: task.error || '原图片任务结果待核对，未自动重做。' } }
  if (task.status === 'failed') return { status: 'failed', error: { message: task.error || '图片任务失败。' } }
  if (task.status !== 'completed') return { status: 'processing' }
  const token = await resultStore.save(taskId, task.pngBase64)
  let url
  try { url = new URL(\`/v1/images/result/\${token}.png\`, publicBaseUrl) }
  catch { throw invalid('本机图片结果地址未配置。', 500) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw invalid('本机图片结果地址不正确。', 500)
  return { status: 'completed', image_url: url.href }
}`
const timing = "  // Scheduling facts only: do not reveal the shared account identity.\n  const timing = Object.fromEntries(['createdAt', 'startedAt', 'finishedAt'].filter(key => typeof task[key] === 'string' && Number.isFinite(Date.parse(task[key]))).map(key => [key, task[key]]))"
export const UPDATED_POLL_IMAGE = LEGACY_POLL_IMAGE
  .replace('  const task = await service.getImageTask(taskId)', '  const task = await service.getImageTask(taskId)\n' + timing)
  .replace("  if (task.status !== 'completed') return { status: 'processing' }", "  if (task.status === 'pending') return { status: 'pending', stage: 'queued', ...timing }\n  if (task.status !== 'completed') return { status: 'processing', stage: 'generating', ...timing }")
  .replace("  return { status: 'completed', image_url: url.href }", "  return { status: 'completed', image_url: url.href, ...timing }")

function patchModule(bytes) {
  const text = bytes.toString('utf8')
  if (!Buffer.from(text).equals(bytes)) throw Error('images.mjs 不是完整 UTF-8，拒绝修改。')
  const header = 'export async function pollImage(taskId, { service, resultStore, publicBaseUrl }) {'
  const index = text.indexOf(header)
  if (index < 0 || text.indexOf(header, index + header.length) !== -1) throw Error('无法唯一识别 pollImage，拒绝修改未知结构。')
  const tail = text.slice(index), normalized = tail.replace(/\r\n/gu, '\n').replace(/\n$/u, '')
  if (normalized === UPDATED_POLL_IMAGE) return null
  if (normalized !== LEGACY_POLL_IMAGE) throw Error('pollImage 与已验证的旧版结构不同，拒绝覆盖；没有写入任何程序文件。')
  const newline = tail.includes('\r\n') ? '\r\n' : '\n'
  if (newline === '\r\n' && /(?<!\r)\n/u.test(tail)) throw Error('pollImage 混用换行符，拒绝自动修改。')
  // The entire prefix is copied byte for byte. Only the three known insertion sites change.
  return Buffer.from(text.slice(0, index) + UPDATED_POLL_IMAGE.replace(/\n/gu, newline) + (tail.endsWith('\n') ? newline : ''), 'utf8')
}
function inside(root, candidate) {
  const relative = path.relative(root, candidate)
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw Error('更新路径越出指定的服务目录。')
  return relative
}
async function checkPath(root, candidate, missing = false) {
  const relative = inside(root, candidate)
  let current = root
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    let stat
    try { stat = await fs.lstat(current) } catch (error) { if (missing && error.code === 'ENOENT') return; throw error }
    if (stat.isSymbolicLink()) throw Error('更新目标不能经过符号链接或目录联接。')
  }
}
async function optionalFile(root, file) {
  await checkPath(root, file, true)
  try { const stat = await fs.lstat(file); if (!stat.isFile()) throw Error('目标不是普通文件：' + path.relative(root, file)); return stat }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
const relativeName = (directory, file) => path.relative(directory, file).split(path.sep).join('/')
function rowMatches(row, relative) { return typeof row?.path === 'string' && row.path.replace(/\\/gu, '/') === relative }
function checkInventory(row, bytes) { if (!Number.isSafeInteger(row.bytes) || row.bytes !== bytes.length || typeof row.sha256 !== 'string' || row.sha256.toLowerCase() !== sha(bytes)) throw Error('现有文件与发布清单不符，拒绝覆盖未知修改。') }
async function stageFile(file, bytes, mode) {
  const temp = file + '.gpt-status-' + randomUUID() + '.tmp'
  const handle = await fs.open(temp, 'wx', mode)
  try { try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() } }
  catch (error) { await fs.unlink(temp).catch(() => {}); throw error }
  return temp
}

export async function applyRelayStatus({ serviceRoot, serviceStopped = false, checkOnly = false }) {
  if (typeof serviceRoot !== 'string' || !serviceRoot.trim()) throw Error('必须手动指定 --service-root 服务程序目录。')
  const root = await fs.realpath(path.resolve(serviceRoot)), candidates = [path.join(root, 'images.mjs'), path.join(root, 'engines', 'gpt', 'images.mjs')]
  const found = []
  for (const file of candidates) { const stat = await optionalFile(root, file); if (stat) found.push({ file, stat }) }
  if (found.length !== 1) throw Error(found.length ? '同时发现两套 images.mjs，请指定准确的独立服务目录。' : '没有找到 images.mjs 或 engines/gpt/images.mjs。')
  const target = found[0], original = await fs.readFile(target.file)
  if (original.length > 1024 * 1024) throw Error('images.mjs 超过已验证的大小范围，拒绝修改。')
  const patched = patchModule(original), moduleRelative = relativeName(root, target.file)
  if (!patched) return { status: 'already-patched', module: moduleRelative, changed: false }
  const plans = [{ file: target.file, original, updated: patched, mode: target.stat.mode }]
  const directories = [...new Set([path.dirname(target.file), root])]
  const manifests = []
  for (const directory of directories) for (const name of ['MANIFEST.json', 'package-manifest.json']) {
    const file = path.join(directory, name), stat = await optionalFile(root, file)
    if (!stat) continue
    if (stat.size > 64 * 1024 * 1024) throw Error('发布清单过大，拒绝修改。')
    const bytes = await fs.readFile(file), text = bytes.toString('utf8')
    let value
    try { value = JSON.parse(text.replace(/^\uFEFF/u, '')) } catch { throw Error('发布清单不是有效 JSON，拒绝修改。') }
    if (!Array.isArray(value.files)) throw Error('发布清单缺少受支持的 files 数组，拒绝修改。')
    manifests.push({ file, directory, stat, original: bytes, text, value })
  }
  // Descendant inventories first; a parent may also hash the changed child inventory.
  manifests.sort((a, b) => b.directory.length - a.directory.length)
  for (const manifest of manifests) {
    const matches = manifest.value.files.filter(row => rowMatches(row, relativeName(manifest.directory, target.file)))
    if (matches.length !== 1) throw Error('发布清单没有唯一对应的图片模块项目，拒绝修改。')
    checkInventory(matches[0], original)
    matches[0].bytes = patched.length; matches[0].sha256 = sha(patched)
    for (const previous of plans.slice(1)) {
      const rows = manifest.value.files.filter(row => rowMatches(row, relativeName(manifest.directory, previous.file)))
      if (rows.length > 1) throw Error('发布清单含重复项目，拒绝修改。')
      if (rows.length) { checkInventory(rows[0], previous.original); rows[0].bytes = previous.updated.length; rows[0].sha256 = sha(previous.updated) }
    }
    if (manifest.value.files.some(row => rowMatches(row, path.basename(manifest.file)))) throw Error('清单包含自身校验项，属于未知结构，拒绝修改。')
    const eol = manifest.text.includes('\r\n') ? '\r\n' : '\n', bom = manifest.text.startsWith('\uFEFF') ? '\uFEFF' : ''
    const updated = Buffer.from(bom + (JSON.stringify(manifest.value, null, 2) + '\n').replace(/\n/gu, eol))
    plans.push({ file: manifest.file, original: manifest.original, updated, mode: manifest.stat.mode })
  }
  if (checkOnly) return { status: 'ready', module: moduleRelative, manifests: plans.slice(1).map(plan => relativeName(root, plan.file)), changed: false }
  if (!serviceStopped) throw Error('请先手动停止统一服务，再附加 --service-stopped 执行；本补丁不会停止或启动服务。')
  const updates = path.join(root, 'data', 'updates'), backup = path.join(updates, 'gpt-image-status-' + new Date().toISOString().replace(/[:.]/gu, '-') + '-' + randomUUID().slice(0, 8))
  for (const directory of [path.join(root, 'data'), updates, backup]) { await checkPath(root, directory, true); try { await fs.mkdir(directory) } catch (error) { if (error.code !== 'EEXIST') throw error }; await checkPath(root, directory) }
  const receipt = { patch: 'gpt-image-status-v1', createdAt: new Date().toISOString(), module: moduleRelative, files: [] }
  for (const [index, plan] of plans.entries()) {
    const filename = `${index}-${path.basename(plan.file)}.original`
    await fs.writeFile(path.join(backup, filename), plan.original, { flag: 'wx', mode: 0o600 })
    receipt.files.push({ path: relativeName(root, plan.file), backup: filename, beforeSha256: sha(plan.original), afterSha256: sha(plan.updated) })
  }
  await fs.writeFile(path.join(backup, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  const staged = [], committed = []
  try {
    for (const plan of plans) {
      if (!(await fs.readFile(plan.file)).equals(plan.original)) throw Error('文件在检查后发生变化，停止更新。')
      staged.push({ ...plan, temp: await stageFile(plan.file, plan.updated, plan.mode) })
    }
    for (const plan of staged) { await fs.rename(plan.temp, plan.file); committed.push(plan) }
  } catch (error) {
    let rollbackFailed = false
    for (const plan of committed.reverse()) {
      try { const temp = await stageFile(plan.file, plan.original, plan.mode); await fs.rename(temp, plan.file) } catch { rollbackFailed = true }
    }
    throw Error(`${error.message} ${rollbackFailed ? '部分回退失败，请保留停止状态并从备份恢复。' : '已保留或回退原程序文件。'} 备份：${backup}`)
  } finally { for (const plan of staged) await fs.unlink(plan.temp).catch(() => {}) }
  return { status: 'patched', module: moduleRelative, changed: true, manifests: plans.slice(1).map(plan => relativeName(root, plan.file)), backupDirectory: backup }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), index = args.indexOf('--service-root')
    if (args.some((arg, position) => !['--service-root', '--service-stopped', '--check'].includes(arg) && position !== index + 1)) throw Error('不支持的参数。')
    const result = await applyRelayStatus({ serviceRoot: index >= 0 ? args[index + 1] : '', serviceStopped: args.includes('--service-stopped'), checkOnly: args.includes('--check') })
    console.log(JSON.stringify(result, null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
