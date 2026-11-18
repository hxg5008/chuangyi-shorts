/** Build two data-free program overlays into one release. No service starts. */
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),workspace=path.dirname(root)
const output=path.resolve(process.argv[2]||path.join(root,'release/complete-v4.3.4'))
const stage=path.join(output,'Chuangyi_Complete_Update_4.3.4_20261110')
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/u,''))
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const within=(parent,child)=>{const p=path.relative(parent,child);return p&&!p.startsWith('..')&&!path.isAbsolute(p)}
if(!within(root,output)&&!within(path.join(workspace,'deployments'),output))throw Error('Output must stay in release or deployments')
if(fs.existsSync(stage))throw Error('Existing delivery is never overwritten')
const firebo=read(path.join(root,'release/chuangyi-platform-v4.3.4-cumulative-update-20261110.json'))
const platformDir=fs.readFileSync(path.join(workspace,'deployments/execution-v13-release-path.txt'),'utf8').replace(/^\uFEFF/u,'').trim()
const platform=read(path.join(platformDir,'build.json')).programUpdate
if(sha(fs.readFileSync(firebo.archive))!==firebo.sha256||sha(fs.readFileSync(platform.zip))!==platform.sha256)throw Error('Source archive digest differs')
fs.mkdirSync(stage,{recursive:true})
const fireboTarget=path.join(stage,'01_创一剧坊_覆盖程序'),executionTarget=path.join(stage,'02_一体执行平台_覆盖程序')
fs.cpSync(firebo.staging,fireboTarget,{recursive:true,dereference:false})
execFileSync('powershell.exe',['-NoProfile','-Command',"Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:CY_ARCHIVE,$env:CY_DEST)"],{windowsHide:true,env:{...process.env,CY_ARCHIVE:platform.zip,CY_DEST:executionTarget}})
function inventory(dir,prefix=''){
 return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{const rel=prefix?prefix+'/'+e.name:e.name,file=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('Links are not allowed');if(e.isDirectory())return inventory(file,rel);if(/(^|\/)(?:data|node_modules|runtime)(\/|$)|(^|\/)(?:network|网络设置)\.json$|(^|\/)\.env$/u.test(rel))throw Error('Private or runtime directory in overlay');const bytes=fs.readFileSync(file);return[{path:rel,bytes:bytes.length,sha256:sha(bytes)}]})
}
const manifest={firebo:'20261110-platform-v4.3.4-production',execution:'1.3.0',createdAt:new Date().toISOString(),preserves:['both data directories','network configuration','custom workspace','runtime and node_modules'],fireboFiles:inventory(fireboTarget),executionFiles:inventory(executionTarget)}
fs.writeFileSync(path.join(stage,'DELIVERY-MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n')
fs.copyFileSync(path.join(root,'docs/2026-11-10_v4.3.4即梦账号与画布.md'),path.join(stage,'先看这里_两端更新说明.md'))
fs.copyFileSync(path.join(root,'docs/2026-11-10_v4.3.4即梦用户画布交付.md'),path.join(stage,'开发交付记录.md'))
const archive=path.join(output,'Chuangyi_Complete_Update_4.3.4_20261110.zip')
if(fs.existsSync(archive))throw Error('Existing archive is never overwritten')
execFileSync('powershell.exe',['-NoProfile','-Command',"Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:CY_STAGE,$env:CY_ARCHIVE,[IO.Compression.CompressionLevel]::Optimal,$true,[Text.Encoding]::UTF8)"],{windowsHide:true,env:{...process.env,CY_STAGE:stage,CY_ARCHIVE:archive}})
const result={archive,staging:stage,bytes:fs.statSync(archive).size,sha256:sha(fs.readFileSync(archive)),fireboFiles:manifest.fireboFiles.length,executionFiles:manifest.executionFiles.length,userDataIncluded:false}
fs.writeFileSync(path.join(output,'BUILD.json'),JSON.stringify(result,null,2)+'\n');fs.writeFileSync(archive+'.sha256',result.sha256+'  '+path.basename(archive)+'\n');console.log(JSON.stringify(result))
