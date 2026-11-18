'use strict'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process')
const root=path.resolve(__dirname,'..'),baseline=path.join(root,'data/local-runtime/source-package-2026-11-11T07-36-50-504Z/chuangyi-source-20261111-platform-v4.3.11'),dest=path.join(root,'release/Jimeng_Selected_References_Fix_20261116_R2')
if(fs.existsSync(dest))throw Error('Existing package is not overwritten')
const {SOURCES,PUBLIC,files,sha}=require('./jimeng-selected-hotfix/apply-fix.cjs')
const r1=JSON.parse(fs.readFileSync(path.join(root,'release/Jimeng_Selected_References_Fix_20261116/FIX-MANIFEST.json'),'utf8'))
const dependency='backend/src/utils/quoted-text.ts',dependencyHash=sha(fs.readFileSync(path.join(root,dependency)))
if(dependencyHash!==sha(fs.readFileSync(path.join(baseline,dependency))))throw Error('Quoted text dependency differs from baseline; explicit merge required')
fs.mkdirSync(dest,{recursive:true});const rows=[]
function copy(rel,acceptedBefore){const src=path.join(root,rel),out=path.join(dest,'payload',rel);fs.mkdirSync(path.dirname(out),{recursive:true});const bytes=fs.readFileSync(src);fs.writeFileSync(out,bytes);rows.push({path:rel,bytes:bytes.length,sha256:sha(bytes),...(acceptedBefore?{acceptedBefore}: {})})}
const before="if (imgs > 8 || vids || auds || first || last || file || link || body.image_url) return '即梦本地通道支持文字和最多8张参考图片，暂不支持首尾帧、视频、音频和文件引用'"
const after='if (imgs > JIMENG_IMAGE_LIMIT || vids || auds || first || last || file || link || body.image_url) return `即梦本地通道支持文字和最多${JIMENG_IMAGE_LIMIT}张参考图片，暂不支持首尾帧、视频、音频和文件引用`'
for(const rel of SOURCES){const b=path.join(baseline,rel),accepted=fs.existsSync(b)?[sha(fs.readFileSync(b))]:[null];if(rel==='backend/src/routes/tasks.ts'){const old=fs.readFileSync(b,'utf8'),newline=old.includes('\r\n')?'\r\n':'\n';accepted.push(sha(Buffer.from("import { JIMENG_IMAGE_LIMIT } from '../services/adapters/jimeng-local-video.js'"+newline+old.replace(before,after))))}const prior=r1.files.find(f=>f.path===rel);if(prior)accepted.push(prior.sha256);accepted.push(sha(fs.readFileSync(path.join(root,rel))));copy(rel,[...new Set(accepted)])}
for(const row of files(root,path.join(root,PUBLIC)))copy(row.path)
rows.sort((a,b)=>a.path.localeCompare(b.path));const manifest={version:1,revision:2,fix:'jimeng-selected-references-20261116',expectedReleaseText:fs.readFileSync(path.join(baseline,'backend/src/utils/platform-release.ts'),'utf8'),createdAt:new Date().toISOString(),files:rows,requiredFiles:[{path:dependency,sha256:dependencyHash}],preserves:['data','accounts','cookies','keys','Skill','prompts','network.json','other source files'],tests:{frontend:88,backend:20,paidModelRequests:0}}
fs.writeFileSync(path.join(dest,'FIX-MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n')
for(const name of ['apply-fix.cjs','Apply-Fix.cmd','README.txt']){let b=fs.readFileSync(path.join(__dirname,'jimeng-selected-hotfix',name));if(name.endsWith('.cmd'))b=Buffer.from(b.toString('utf8').replace(/\r?\n/g,'\r\n'),'ascii');fs.writeFileSync(path.join(dest,name),b)}
const zip=dest+'.zip';if(fs.existsSync(zip))throw Error('Archive already exists')
execFileSync('powershell.exe',['-NoLogo','-NoProfile','-Command',"$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:FIX_DIR,$env:FIX_ZIP,[IO.Compression.CompressionLevel]::Optimal,$true,[Text.Encoding]::UTF8)"],{windowsHide:true,stdio:'inherit',env:{...process.env,FIX_DIR:dest,FIX_ZIP:zip}})
const hash=sha(fs.readFileSync(zip));fs.writeFileSync(zip+'.sha256',hash+'  '+path.basename(zip)+'\n');console.log(JSON.stringify({zip,bytes:fs.statSync(zip).size,sha256:hash,files:rows.length,stage:dest}))
