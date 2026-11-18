'use strict'
// Targeted source edit only. No credentials, network generation, or task writes.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const root = path.resolve((process.argv[2] || path.join(__dirname, '..', '..')).trim().replace(/^"(.*)"$/u, '$1'))
const target = path.join(root, 'backend', 'src', 'routes', 'tasks.ts')
const adapter = path.join(root, 'backend', 'src', 'services', 'adapters', 'jimeng-local-video.ts')
const sha = text => crypto.createHash('sha256').update(text).digest('hex')
const before = "if (imgs > 8 || vids || auds || first || last || file || link || body.image_url) return '即梦本地通道支持文字和最多8张参考图片，暂不支持首尾帧、视频、音频和文件引用'"
const after = 'if (imgs > JIMENG_IMAGE_LIMIT || vids || auds || first || last || file || link || body.image_url) return `即梦本地通道支持文字和最多${JIMENG_IMAGE_LIMIT}张参考图片，暂不支持首尾帧、视频、音频和文件引用`'
async function main() {
  if (!fs.existsSync(target) || !fs.existsSync(adapter)) throw Error('Not a supported workbench source directory. No files changed.')
  const adapterText = fs.readFileSync(adapter, 'utf8')
  if (!/export\s+const\s+JIMENG_IMAGE_LIMIT\s*=\s*9\b/u.test(adapterText)) throw Error('The video adapter is not the verified nine-image version. No files changed; send the version to support.')
  const recordFile = path.join(root, 'data', 'local-runtime', 'backend-process.json')
  let record
  if (fs.existsSync(recordFile)) {
    record = JSON.parse(fs.readFileSync(recordFile, 'utf8').replace(/^\uFEFF/u, ''))
    if (Number.isSafeInteger(record.processId) && record.processId > 0) {
      let alive = true
      try { process.kill(record.processId, 0) } catch (e) { if (e.code === 'ESRCH') alive = false; else throw Error('Cannot verify backend process state. Stop the workbench before applying.') }
      if (alive) throw Error('A recorded backend process is still active. Stop the workbench, then apply this fix. No files changed.')
    }
  }
  const networkFile = path.join(root, 'network.json')
  if (fs.existsSync(networkFile)) {
    const network = JSON.parse(fs.readFileSync(networkFile, 'utf8').replace(/^\uFEFF/u, ''))
    const port = Number(network.port)
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      let live = false
      try { const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(1800) }); live = r.ok; await r.body?.cancel() } catch {}
      if (live) throw Error('A service is still listening on the configured port. Stop it before applying. No files changed.')
    }
  }
  const original = fs.readFileSync(target, 'utf8')
  if (original.includes(after) && /import\s*\{[^}]*JIMENG_IMAGE_LIMIT[^}]*\}\s*from\s*['"]\.\.\/services\/adapters\/jimeng-local-video\.js['"]/u.test(original)) {
    console.log('Already fixed: POST /tasks uses the nine-image adapter limit. Restart after any previous update.'); return
  }
  if (original.split(before).length !== 2) throw Error('Expected old eight-image guard was not found exactly once. This source differs; no files changed.')
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  let patched = original.replace(before, after)
  if (!/import\s*\{[^}]*JIMENG_IMAGE_LIMIT[^}]*\}\s*from\s*['"]\.\.\/services\/adapters\/jimeng-local-video\.js['"]/u.test(patched)) {
    patched = "import { JIMENG_IMAGE_LIMIT } from '../services/adapters/jimeng-local-video.js'" + newline + patched
  }
  if (patched.includes(before) || !patched.includes(after)) throw Error('Patch validation failed. No files changed.')
  const backupRoot = path.resolve(root, 'data', 'update-backups', 'jimeng-nine-' + new Date().toISOString().replace(/[:.]/gu, '-'))
  if (!backupRoot.startsWith(path.resolve(root, 'data', 'update-backups') + path.sep)) throw Error('Invalid backup path')
  fs.mkdirSync(backupRoot, { recursive: true })
  fs.copyFileSync(target, path.join(backupRoot, 'tasks.ts'))
  const receipt = { fix:'jimeng-nine-route-20261116', target:'backend/src/routes/tasks.ts', beforeSha256:sha(original), afterSha256:sha(patched), changes:'Use adapter JIMENG_IMAGE_LIMIT=9 in POST /tasks; preserve all other source logic.', modelRequests:0 }
  fs.writeFileSync(path.join(backupRoot, 'RECEIPT.json'), JSON.stringify(receipt,null,2)+'\n')
  fs.writeFileSync(target, patched, 'utf8')
  if (sha(fs.readFileSync(target,'utf8')) !== receipt.afterSha256) throw Error('Written file verification failed; original backup is retained at '+backupRoot)
  console.log(JSON.stringify({ok:true,...receipt,backup:backupRoot},null,2))
  console.log('Fix applied. Start the workbench normally. Existing data, accounts, keys, tasks, Skill and prompts were not changed.')
}
main().catch(error=>{console.error(error.message);console.error('No service was started automatically.');process.exitCode=1})
