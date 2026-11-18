'use strict'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net')
const sha=b=>crypto.createHash('sha256').update(b).digest('hex')
const SOURCES=['frontend/app/views/drama/episode.vue','frontend/app/utils/jimeng-selected-mentions.js','backend/src/routes/tasks.ts','backend/src/services/adapters/jimeng-local-video.ts']
const PUBLIC='frontend/.output/public'
function inside(root,target){const r=path.relative(root,target);return r&&!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r)}
function checked(root,rel){const target=path.resolve(root,rel);if(!inside(root,target))throw Error('Path outside workbench: '+rel);let p=target;while(!fs.existsSync(p))p=path.dirname(p);const real=fs.realpathSync(p);if(real!==root&&!inside(root,real))throw Error('Path redirects outside workbench: '+rel);return target}
function files(root,dir){const out=[];if(!fs.existsSync(dir))return out;for(const name of fs.readdirSync(dir)){const file=path.join(dir,name),s=fs.lstatSync(file);if(s.isSymbolicLink())throw Error('Symbolic links are not allowed in generated files');if(s.isDirectory())out.push(...files(root,file));else if(s.isFile())out.push({path:path.relative(root,file).split(path.sep).join('/'),sha256:sha(fs.readFileSync(file)),bytes:s.size});else throw Error('Unsupported file: '+file)}return out.sort((a,b)=>a.path.localeCompare(b.path))}
function validRelative(rel){return SOURCES.includes(rel)||rel.startsWith(PUBLIC+'/')&&!rel.split('/').some(x=>!x||x==='.'||x==='..')}
async function listening(port,host='127.0.0.1'){return new Promise(resolve=>{const socket=net.connect({port,host});const done=v=>{socket.destroy();resolve(v)};socket.once('connect',()=>done(true));socket.once('error',()=>done(false));socket.setTimeout(1800,()=>done(false))})}
async function verifyStopped(root){const record=checked(root,'data/local-runtime/backend-process.json');if(fs.existsSync(record)){const r=JSON.parse(fs.readFileSync(record,'utf8').replace(/^\uFEFF/u,''));if(Number.isSafeInteger(r.processId)&&r.processId>0){let live=true;try{process.kill(r.processId,0)}catch(e){if(e.code==='ESRCH')live=false;else throw Error('Cannot verify backend process; stop workbench before updating')}if(live)throw Error('The recorded backend is still running. Stop Firebo before applying.')}}const config=checked(root,'network.json');if(fs.existsSync(config)){const n=JSON.parse(fs.readFileSync(config,'utf8').replace(/^\uFEFF/u,''));const port=Number(n.port);if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid network.json port');const hosts=['127.0.0.1'];if(n.host&&n.host!=='0.0.0.0'&&n.host!=='::'&&n.host!=='localhost')hosts.push(n.host);for(const host of hosts)if(await listening(port,host))throw Error('Workbench port is still listening; stop it before applying.')}}
async function applyPatch(workbench,pkg,options={}){
 const root=fs.realpathSync(path.resolve(workbench)),packageRoot=fs.realpathSync(path.resolve(pkg)),m=JSON.parse(fs.readFileSync(path.join(packageRoot,'FIX-MANIFEST.json'),'utf8'))
 if(m.fix!=='jimeng-selected-references-20261116'||m.version!==1||!Array.isArray(m.files))throw Error('Invalid fix manifest')
 if(fs.readFileSync(checked(root,'backend/src/utils/platform-release.ts'),'utf8')!==m.expectedReleaseText)throw Error('This fix requires the verified v4.3.11 source. No files changed.')
  for(const dependency of m.requiredFiles||[]){if(dependency.path!=='backend/src/utils/quoted-text.ts'||!fs.existsSync(checked(root,dependency.path))||sha(fs.readFileSync(checked(root,dependency.path)))!==dependency.sha256)throw Error('Required existing dependency differs; no files changed: '+dependency.path)}
 const sourceRows=m.files.filter(f=>SOURCES.includes(f.path));if(sourceRows.length!==4||new Set(sourceRows.map(f=>f.path)).size!==4||!m.files.some(f=>f.path===PUBLIC+'/index.html'))throw Error('Incomplete fix payload')
 for(const f of m.files){if(!validRelative(f.path))throw Error('Unexpected payload path: '+f.path);const file=checked(packageRoot,'payload/'+f.path);if(!fs.existsSync(file)||fs.statSync(file).size!==f.bytes||sha(fs.readFileSync(file))!==f.sha256)throw Error('Payload hash failed: '+f.path)}
 for(const row of sourceRows){const t=checked(root,row.path),current=fs.existsSync(t)?sha(fs.readFileSync(t)):null;if(current!==row.sha256&&!row.acceptedBefore.includes(current))throw Error('Source differs; no files changed: '+row.path)}
 const currentPublic=files(root,checked(root,PUBLIC)),expectedPublic=m.files.filter(f=>f.path.startsWith(PUBLIC+'/'))
 const samePublic=currentPublic.length===expectedPublic.length&&currentPublic.every((f,i)=>f.path===expectedPublic[i].path&&f.sha256===expectedPublic[i].sha256)
 const sameSources=sourceRows.every(f=>fs.existsSync(checked(root,f.path))&&sha(fs.readFileSync(checked(root,f.path)))===f.sha256)
 if(samePublic&&sameSources)return {ok:true,alreadyApplied:true,fix:m.fix}
 await (options.verifyStopped||verifyStopped)(root)
 const stamp=new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(3).toString('hex'),backup=checked(root,'data/update-backups/jimeng-selected-'+stamp),stage=path.join(backup,'staging'),old=path.join(backup,'before')
 fs.mkdirSync(stage,{recursive:true});fs.mkdirSync(old,{recursive:true})
 for(const f of m.files){const dest=checked(stage,f.path);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(checked(packageRoot,'payload/'+f.path),dest)}
 const moved=[],installed=[]
 try{
  for(const rel of [...SOURCES,PUBLIC]){const target=checked(root,rel),previous=checked(old,rel),replacement=checked(stage,rel);fs.mkdirSync(path.dirname(target),{recursive:true});if(fs.existsSync(target)){fs.mkdirSync(path.dirname(previous),{recursive:true});fs.renameSync(target,previous);moved.push(rel)}options.beforeInstall?.(rel);fs.renameSync(replacement,target);installed.push(rel)}
  for(const f of m.files)if(sha(fs.readFileSync(checked(root,f.path)))!==f.sha256)throw Error('Installed hash failed: '+f.path)
  const receipt={ok:true,fix:m.fix,backup,appliedAt:new Date().toISOString(),changed:[...SOURCES,PUBLIC],modelRequests:0};fs.writeFileSync(path.join(backup,'APPLIED.json'),JSON.stringify(receipt,null,2)+'\n');return receipt
 }catch(error){
  const discarded=path.join(backup,'incomplete-new');fs.mkdirSync(discarded,{recursive:true})
  for(const rel of installed.reverse()){const target=checked(root,rel),dest=checked(discarded,rel);if(fs.existsSync(target)){fs.mkdirSync(path.dirname(dest),{recursive:true});fs.renameSync(target,dest)}}
  for(const rel of moved.reverse()){const source=checked(old,rel),dest=checked(root,rel);if(fs.existsSync(source)){fs.mkdirSync(path.dirname(dest),{recursive:true});fs.renameSync(source,dest)}}
  fs.writeFileSync(path.join(backup,'ROLLED-BACK.json'),JSON.stringify({error:error.message,restored:true},null,2));throw Error(error.message+'; original files restored. Backup: '+backup)
 }
}
module.exports={applyPatch,verifyStopped,SOURCES,PUBLIC,files,sha}
if(require.main===module){const root=process.argv[2]?.trim().replace(/^"(.*)"$/u,'$1');if(!root){console.error('Pass the workbench root directory.');process.exitCode=1}else applyPatch(root,__dirname).then(r=>{console.log(JSON.stringify(r,null,2));console.log('Update ready. Start Firebo normally and refresh browser with Ctrl+F5.')}).catch(e=>{console.error(e.message);console.error('No service was started.');process.exitCode=1})}
