/** Build an overlay from the already verified full source stage, preserving user data. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const release = path.join(root, 'release'), name = 'chuangyi-platform-v4.3.11-cumulative-update-20261111'
const full = JSON.parse(fs.readFileSync(path.join(release, 'chuangyi-source-20261111-platform-v4.3.11.json'), 'utf8'))
const stage = path.resolve(full.staging), expected = path.resolve(root, 'data/local-runtime')
if (!stage.startsWith(expected + path.sep) || !fs.existsSync(path.join(stage, 'SOURCE-MANIFEST.json'))) throw new Error('Full source stage is not valid')
const target = path.join(root, 'data/local-runtime', `update-package-${new Date().toISOString().replace(/[:.]/gu, '-')}`)
fs.mkdirSync(target, { recursive: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const rows = []
function copy(relative) {
  const source = path.join(stage, relative), destination = path.join(target, relative), stat = fs.lstatSync(source)
  if (stat.isSymbolicLink()) throw new Error('Update packages cannot include links')
  if (stat.isDirectory()) { fs.mkdirSync(destination, { recursive: true }); for (const child of fs.readdirSync(source)) copy(path.posix.join(relative, child)); return }
  if (/(?:^|\/)(?:data|node_modules|workspace)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|(?:^|\/)network\.json$/u.test(relative)) throw new Error('Update would overwrite user data or configuration: ' + relative)
  fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination)
  const bytes = fs.readFileSync(destination); rows.push({ path: relative, bytes: bytes.length, sha256: sha(bytes) })
}
for (const directory of ['backend/src','backend/resources','backend/provider-engine','backend/tests','backend/scripts','frontend/app','frontend/tests','frontend/.output/public','scripts','docs','integrations','docker']) copy(directory)
for (const file of ['backend/package.json','backend/package-lock.json','backend/tsconfig.json','backend/.npmrc','frontend/package.json','frontend/package-lock.json','frontend/nuxt.config.ts','frontend/tsconfig.json','package.json','Dockerfile','LICENSE','README.md','启动创一剧坊.cmd','停止创一剧坊.cmd','首次部署.cmd','部署必读.txt','本版更新说明.txt','更新到完整补齐版.txt']) copy(file)
const manifest = { package: name, release: '20261111-platform-v4.3.11-production', createdAt: new Date().toISOString(), fullSourceSha256: full.sha256,
  features: { executionAccountGrants: true, userCanvasSelection: true, routeVersions: true, batchRouteSnapshot: true, userDeletion: true, modelTypeDefaults: true, centeredModelEditor: true, searchableProtocols: true, episodeSwitcher: true, manualAssetImageReferences: true, assetImageHistory: true, unifiedAdminSettings: true, requestDiagnostics: true },
  preserves: ['data/','backend/.env','network.json','backend/workspace/','node_modules/'], requiresDependencyInstall: false,
  // Old 11-07 files that this version no longer ships; delete them by hand after overlaying (the overlay never deletes).
  obsoleteFiles: ['启动火宝.cmd','停止火宝.cmd','README.zh-CN.md','README.en.md','README.ja.md','README.ko.md','donate.png','drama.png'],
  files: rows.sort((a,b) => a.path.localeCompare(b.path)) }
fs.writeFileSync(path.join(target, 'UPDATE-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n')
const archive = path.join(release, name + '.zip')
if (fs.existsSync(archive)) throw new Error('An existing update archive will not be overwritten')
execFileSync('powershell.exe', ['-NoLogo','-NoProfile','-Command', "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:HUOBAO_UPDATE_STAGE,$env:HUOBAO_UPDATE_ZIP,[IO.Compression.CompressionLevel]::Optimal,$false,[Text.Encoding]::UTF8)"],
  { windowsHide: true, stdio: 'inherit', env: { ...process.env, HUOBAO_UPDATE_STAGE: target, HUOBAO_UPDATE_ZIP: archive } })
const digest = sha(fs.readFileSync(archive)), receipt = { archive, staging: target, archiveBytes: fs.statSync(archive).size, sha256: digest, files: rows.length + 1, createdAt: new Date().toISOString() }
fs.writeFileSync(archive + '.sha256', `${digest}  ${path.basename(archive)}\n`)
fs.writeFileSync(path.join(release, name + '.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify(receipt))
