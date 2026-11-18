/** One cumulative delivery with two data/configuration-free program overlays. */
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),workspace=path.dirname(root)
const output=path.resolve(process.argv[2]||path.join(root,'release/cumulative-bundle'))
const staging=path.join(output,'Chuangyi_完整累计更新_4.3.3_20261110')
if(fs.existsSync(staging))throw new Error('Delivery stage already exists; nothing overwritten')
fs.mkdirSync(staging,{recursive:true})
const update=JSON.parse(fs.readFileSync(path.join(root,'release/chuangyi-platform-v4.3.3-cumulative-update-20261110.json'),'utf8'))
const platformDir=fs.readFileSync(path.join(workspace,'deployments/execution-v12-release-path.txt'),'utf8').trim()
const platformZip=path.join(platformDir,'Chuangyi_Execution_Platform_1.2.0_Windows_x64.zip')
const sha=value=>createHash('sha256').update(value).digest('hex')
if(sha(fs.readFileSync(platformZip))!=='e538eba2aadabdfb23c78978e3beadb58ee93ace9ed35da08e6e529f2f255567')throw new Error('Execution platform archive differs from verified release')
const firebo=path.join(staging,'01_创一剧坊累计更新'),executor=path.join(staging,'02_一体执行平台累计更新')
fs.cpSync(update.staging,firebo,{recursive:true,dereference:false})
const unpacked=path.join(output,'verified-platform-original')
execFileSync('powershell.exe',['-NoLogo','-NoProfile','-Command',"$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:CY_BUNDLE_SOURCE,$env:CY_BUNDLE_UNPACK)"],
 {windowsHide:true,stdio:'inherit',env:{...process.env,CY_BUNDLE_SOURCE:platformZip,CY_BUNDLE_UNPACK:unpacked}})
let platformSource=unpacked
if(!fs.existsSync(path.join(platformSource,'local.mjs'))){const folders=fs.readdirSync(unpacked,{withFileTypes:true}).filter(e=>e.isDirectory());if(folders.length!==1)throw new Error('Unexpected platform archive layout');platformSource=path.join(unpacked,folders[0].name)}
fs.mkdirSync(executor,{recursive:true})
for(const entry of fs.readdirSync(platformSource)){
 if(['data','网络设置.json','network.json','.env'].includes(entry))continue
 fs.cpSync(path.join(platformSource,entry),path.join(executor,entry),{recursive:true,dereference:false})
}
function files(directory,prefix=''){
 return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
  const relative=path.posix.join(prefix,entry.name),absolute=path.join(directory,entry.name)
  if(fs.lstatSync(absolute).isSymbolicLink())throw new Error('Delivery cannot include links: '+relative)
  return entry.isDirectory()?files(absolute,relative):[{path:relative,bytes:fs.statSync(absolute).size,sha256:sha(fs.readFileSync(absolute))}]
 }).sort((a,b)=>a.path.localeCompare(b.path))
}
const fireboFiles=files(firebo),platformFiles=files(executor)
if(fireboFiles.some(f=>/^(?:data|backend\/workspace|node_modules)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|(?:^|\/)network\.json$/u.test(f.path)))throw new Error('Firebo overlay contains private configuration')
if(platformFiles.some(f=>/^data(?:\/|$)|^(?:网络设置|network)\.json$|^\.env$/u.test(f.path)))throw new Error('Platform overlay contains private configuration')
const referencePath=path.join(firebo,'backend/src/services/jimeng-local-media.ts')
if(sha(fs.readFileSync(referencePath))!=='65a7208e615553d494f5d06f65a93f04028322a6fe2c910775356084001e08c3')throw new Error('Atomic reference fix absent')
if(!fs.readFileSync(path.join(firebo,'backend/src/utils/platform-release.ts'),'utf8').includes('20261110-platform-v4.3.3-production'))throw new Error('Cumulative release identifier absent')
fs.writeFileSync(path.join(executor,'UPDATE-MANIFEST.json'),JSON.stringify({version:'1.2.0',sourceArchiveSha256:sha(fs.readFileSync(platformZip)),preserves:['data/','网络设置.json','network.json','.env'],files:platformFiles},null,2)+'\n')
const instructions=fs.readFileSync(path.join(root,'docs/2026-11-10_v4.3.3累计更新说明.md'),'utf8')
fs.writeFileSync(path.join(staging,'先看这里_累计更新说明.txt'),'\uFEFF'+instructions)
fs.copyFileSync(path.join(root,'docs/2026-11-09_v4接入交付记录.md'),path.join(staging,'开发交付记录.md'))
const delivery={release:'20261110-platform-v4.3.3-production',executionVersion:'1.2.0',includesCharacterEpisodes:true,includesStylePromptDetails:true,includesSnapshotHotfix:true,includesEpisodeSwitcher:true,includesManualAssetImageReferences:true,includesAssetImageHistory:true,includesUnifiedAdminSettings:true,includesRequestDiagnostics:true,separateHotfixRequired:false,
  preserves:['Firebo data/workspace/.env/network.json','Execution data/网络设置.json'],firebo:{files:fireboFiles.length,overlay:fireboFiles},execution:{files:platformFiles.length,overlay:platformFiles},modelRequests:0}
fs.writeFileSync(path.join(staging,'DELIVERY-MANIFEST.json'),JSON.stringify(delivery,null,2)+'\n')
const archive=path.join(output,'Chuangyi_Complete_Update_4.3.3_20261110.zip')
execFileSync('powershell.exe',['-NoLogo','-NoProfile','-Command',"$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:CY_BUNDLE_STAGE,$env:CY_BUNDLE_ZIP,[IO.Compression.CompressionLevel]::Optimal,$true,[Text.Encoding]::UTF8)"],
 {windowsHide:true,stdio:'inherit',env:{...process.env,CY_BUNDLE_STAGE:staging,CY_BUNDLE_ZIP:archive}})
const receipt={archive,archiveBytes:fs.statSync(archive).size,sha256:sha(fs.readFileSync(archive)),staging,fireboFiles:fireboFiles.length,platformFiles:platformFiles.length,
  omittedExecutionNetworkConfiguration:!fs.existsSync(path.join(executor,'网络设置.json')),includesSnapshotHotfix:true}
fs.writeFileSync(path.join(output,'BUILD.json'),JSON.stringify(receipt,null,2)+'\n');fs.writeFileSync(archive+'.sha256',receipt.sha256+'  '+path.basename(archive)+'\n')
console.log(JSON.stringify(receipt,null,2))
