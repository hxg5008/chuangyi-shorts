import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const name = 'chuangyi-source-20261111-platform-v4.3.11'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const staging = path.join(root, 'data', 'local-runtime', `source-package-${stamp}`, name)
const outputDir = path.join(root, 'release')
fs.mkdirSync(staging, { recursive: true })
fs.mkdirSync(outputDir, { recursive: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const exclusions = new Set(['node_modules', '.git', '.nuxt', '.DS_Store', 'Thumbs.db'])
function copy(relative) {
  const source = path.join(root, relative)
  if (!fs.existsSync(source)) throw new Error(`Missing required source: ${relative}`)
  const target = path.join(staging, relative)
  const stat = fs.lstatSync(source)
  if (stat.isSymbolicLink()) throw new Error(`Unexpected symbolic link in source: ${relative}`)
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true })
    for (const file of fs.readdirSync(source)) if (!exclusions.has(file) && !file.endsWith('.log')) copy(path.join(relative, file))
  } else {
    if (path.basename(relative) === '.env' || /\.sqlite3(?:-wal|-shm)?$/u.test(relative)) throw new Error(`Private runtime file cannot enter source package: ${relative}`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
    if (/\.sh$/u.test(relative)) fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n'))
  }
}
for (const directory of [
  'backend/src', 'backend/resources', 'backend/scripts', 'backend/tests', 'backend/provider-engine', 'backend/workspace/skills', 'backend/workspace/prompts',
  'frontend/app', 'frontend/tests', 'frontend/.output/public',
  'desktop/src', 'desktop/scripts', 'desktop/tests', 'desktop/assets', 'desktop/diagnostics',
  'scripts', 'docs', 'docker', 'integrations',
]) copy(directory)
for (const file of [
  'package.json', 'network.example.json', '本版更新说明.txt', '更新到完整补齐版.txt', '.env.example', '.gitignore', '.dockerignore', 'Dockerfile', 'docker-compose.yml', 'docker-compose.source.yml',
  'LICENSE', 'README.md',
  '启动创一剧坊.cmd', '停止创一剧坊.cmd', '首次部署.cmd', '部署必读.txt',
  'backend/package.json', 'backend/package-lock.json', 'backend/tsconfig.json', 'backend/.npmrc', 'backend/.env.example', 'backend/.gitignore',
  'frontend/package.json', 'frontend/package-lock.json', 'frontend/nuxt.config.ts', 'frontend/tsconfig.json', 'frontend/.gitignore',
  'desktop/package.json', 'desktop/package-lock.json', 'desktop/electron-builder.yml', 'configs/config.example.yaml',
]) copy(file)

// Source packages ship the example, never the machine's active settings.
fs.copyFileSync(path.join(staging, 'network.example.json'), path.join(staging, 'network.json'))

// Keep the exact dependency versions and integrity while removing the optional
// desktop registry pin, so another machine can use the public registry.
const desktopLock = path.join(staging, 'desktop/package-lock.json')
const lock = JSON.parse(fs.readFileSync(desktopLock, 'utf8'))
for (const dependency of Object.values(lock.packages || {})) delete dependency.resolved
fs.writeFileSync(desktopLock, JSON.stringify(lock, null, 2) + '\n')
const readme = path.join(staging, 'README.md')

function list(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relative = path.posix.join(prefix, entry.name)
    return entry.isDirectory() ? list(path.join(directory, entry.name), relative) : [relative]
  }).sort()
}
const files = list(staging)
const manifest = {
  package: name, createdAt: new Date().toISOString(), testedWindowsNode: process.version,
  scope: 'v4.3.11 cumulative: simplified Jimeng global feature permission, user selection of unassigned existing canvases and safe legacy adoption; no separate account/canvas grants. Compatible with execution platform 1.4.1. Creative rules, Skill and prompts unchanged.',
  features: { executionAccountGrants: true, userCanvasSelection: true, routeVersions: true, batchRouteSnapshot: true, userDeletion: true, modelTypeDefaults: true, centeredModelEditor: true, searchableProtocols: true, episodeSwitcher: true, manualAssetImageReferences: true, assetImageHistory: true, unifiedAdminSettings: true, requestDiagnostics: true },
  integration: { provider: 'jimeng_local', model: 'jimeng-2.0-fast', protocol: 'jimeng-local-video-v1', delivery: 'handed_off then return (job file or canvas library); never resubmits', skillAndPromptFilesUnchanged: true },
  excluded: ['data/', 'all node_modules/', '.nuxt/', 'old dist/', 'real .env', 'configs/config.yaml', 'runtime logs', 'backups'],
  packagingAdjustments: ['desktop lock resolved URLs removed; versions/integrity retained', 'shell entrypoints use LF', 'README has custom deployment notice'],
  files: files.map(relative => { const bytes = fs.readFileSync(path.join(staging, relative)); return { path: relative, bytes: bytes.length, sha256: sha(bytes) } }),
}
fs.writeFileSync(path.join(staging, 'SOURCE-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n')
const zip = path.join(outputDir, `${name}.zip`)
if (fs.existsSync(zip)) throw new Error(`Archive already exists; no package was overwritten: ${zip}`)
const command = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:HUOBAO_PACKAGE_STAGE,$env:HUOBAO_PACKAGE_ZIP,[IO.Compression.CompressionLevel]::Optimal,$true,[Text.Encoding]::UTF8)"
execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], {
  windowsHide: true, stdio: 'inherit', env: { ...process.env, HUOBAO_PACKAGE_STAGE: staging, HUOBAO_PACKAGE_ZIP: zip },
})
const checksum = sha(fs.readFileSync(zip))
fs.writeFileSync(zip + '.sha256', `${checksum}  ${path.basename(zip)}\n`)
const receipt = { archive: zip, archiveBytes: fs.statSync(zip).size, sha256: checksum, files: files.length + 1, staging, createdAt: new Date().toISOString() }
fs.writeFileSync(path.join(outputDir, `${name}.json`), JSON.stringify(receipt, null, 2))
console.log(JSON.stringify(receipt))
