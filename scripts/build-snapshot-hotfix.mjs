/** Build a data-free, hash-guarded single-file source hotfix. */
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const output=path.resolve(process.argv[2]||path.join(root,'release','snapshot-hotfix-'+new Date().toISOString().replace(/[:.]/gu,'-')))
if(fs.existsSync(output))throw new Error('Output already exists; no package overwritten')
const staging=path.join(output,'Jimeng_Snapshot_Atomic_Fix'),templates=path.join(root,'scripts/snapshot-hotfix')
fs.mkdirSync(staging,{recursive:true})
const relative='backend/src/services/jimeng-local-media.ts',sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const source=fs.readFileSync(path.join(root,relative)),manifest={fix:'jimeng-reference-snapshot-atomic-20261109',target:relative,
  acceptedOriginalSha256:['0b9908f1839ee5e8e9c16b29a182a8148c43ba43f0973ead2a175a8949dc60de','c17c91f6173d7bca48837a34c8474788105791b1851c09d7c53a78e922bb42f3'],patchedSha256:sha(source),
  appliesTo:['20261107 platform with verified original file','Claude v3.5 with verified original file','Chuangyi v4 with verified original file'],
  preserves:['data','accounts','cookies','api keys','tasks','adopted references','Skill and prompts'],modelRequests:0}
function copy(relative){const dest=path.join(staging,relative);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(root,relative),dest)}
copy(relative)
for(const file of ['Apply-Fix.ps1','README.txt'])fs.writeFileSync(path.join(staging,file),'\uFEFF'+fs.readFileSync(path.join(templates,file),'utf8').replace(/^\uFEFF/u,''))
fs.writeFileSync(path.join(staging,'Apply-Fix.cmd'),fs.readFileSync(path.join(templates,'Apply-Fix.cmd'),'utf8').replace(/\r?\n/gu,'\r\n'),'ascii')
fs.writeFileSync(path.join(staging,'FIX-MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n')
for(const file of ['backend/tests/jimeng-snapshot-atomic.test.ts','backend/tests/jimeng-snapshot-io.test.ts','backend/tests/helpers/jimeng-snapshot-child.mjs'])copy(file)
const archive=path.join(output,'Chuangyi_Jimeng_Snapshot_Fix_20261109_R2.zip')
execFileSync('powershell.exe',['-NoLogo','-NoProfile','-Command',"$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:CY_FIX_STAGE,$env:CY_FIX_ZIP,[IO.Compression.CompressionLevel]::Optimal,$false,[Text.Encoding]::UTF8)"],
  {windowsHide:true,stdio:'inherit',env:{...process.env,CY_FIX_STAGE:staging,CY_FIX_ZIP:archive}})
const receipt={...manifest,archive,staging,archiveBytes:fs.statSync(archive).size,sha256:sha(fs.readFileSync(archive))}
fs.writeFileSync(path.join(output,'BUILD.json'),JSON.stringify(receipt,null,2)+'\n');fs.writeFileSync(archive+'.sha256',receipt.sha256+'  '+path.basename(archive)+'\n')
console.log(JSON.stringify(receipt,null,2))
