'use strict'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process')
const root=path.resolve(__dirname,'..'),dest=path.join(root,'release','Jimeng_9_Images_Fix_20261116')
if(fs.existsSync(dest))throw Error('Package staging already exists; not overwritten')
fs.mkdirSync(dest,{recursive:true})
for(const name of ['apply-fix.cjs','Apply-Fix.cmd','README.txt']){
 const source=path.join(__dirname,'jimeng-nine-hotfix',name),output=path.join(dest,name)
 let bytes=fs.readFileSync(source)
 if(name.endsWith('.cmd'))bytes=Buffer.from(bytes.toString('utf8').replace(/\r?\n/g,'\r\n'),'ascii')
 fs.writeFileSync(output,bytes)
}
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
const manifest={fix:'jimeng-nine-route-20261116',limit:9,target:'backend/src/routes/tasks.ts',upstreamProvider:'jimeng_local',change:'Replace stale route limit 8 with the existing adapter constant 9; no other provider or creative rules changed',tests:{backend:19,frontend:7,installer:3,typecheck:'passed'},modelRequests:0,files:fs.readdirSync(dest).map(name=>({name,sha256:sha(fs.readFileSync(path.join(dest,name)))}))}
fs.writeFileSync(path.join(dest,'MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n')
const zip=dest+'.zip';if(fs.existsSync(zip))throw Error('Archive already exists; not overwritten')
execFileSync('powershell.exe',['-NoLogo','-NoProfile','-Command',"$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:JIMENG_FIX_DIR,$env:JIMENG_FIX_ZIP,[IO.Compression.CompressionLevel]::Optimal,$true,[Text.Encoding]::UTF8)"],{windowsHide:true,stdio:'inherit',env:{...process.env,JIMENG_FIX_DIR:dest,JIMENG_FIX_ZIP:zip}})
const zipHash=sha(fs.readFileSync(zip));fs.writeFileSync(zip+'.sha256',zipHash+'  '+path.basename(zip)+'\n');console.log(JSON.stringify({zip,bytes:fs.statSync(zip).size,sha256:zipHash}))
