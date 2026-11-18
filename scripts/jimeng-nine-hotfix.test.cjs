'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process')
const patcher=path.join(__dirname,'jimeng-nine-hotfix','apply-fix.cjs')
const oldGuard="if (imgs > 8 || vids || auds || first || last || file || link || body.image_url) return '即梦本地通道支持文字和最多8张参考图片，暂不支持首尾帧、视频、音频和文件引用'"
function fixture(adapter='export const JIMENG_IMAGE_LIMIT = 9\n'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jimeng-nine-'))
 fs.mkdirSync(path.join(root,'backend/src/routes'),{recursive:true});fs.mkdirSync(path.join(root,'backend/src/services/adapters'),{recursive:true});fs.mkdirSync(path.join(root,'data'),{recursive:true})
 const source="import { Hono } from 'hono'\r\n// unrelated application logic stays untouched\r\n"+oldGuard+'\r\n'
 fs.writeFileSync(path.join(root,'backend/src/routes/tasks.ts'),source)
 fs.writeFileSync(path.join(root,'backend/src/services/adapters/jimeng-local-video.ts'),adapter)
 fs.writeFileSync(path.join(root,'data/private-sentinel.txt'),'user data must remain')
 return {root,source}
}
function apply(root){return spawnSync(process.execPath,[patcher,root],{encoding:'utf8',windowsHide:true})}
test('targeted patch keeps original source and data, backs up exact old bytes, and is idempotent',()=>{
 const {root,source}=fixture()
 try{
  const r=apply(root);assert.equal(r.status,0,r.stderr)
  const p=fs.readFileSync(path.join(root,'backend/src/routes/tasks.ts'),'utf8');assert.ok(!p.includes(oldGuard));assert.ok(p.includes('imgs > JIMENG_IMAGE_LIMIT'));assert.ok(p.includes('import { JIMENG_IMAGE_LIMIT }'));assert.ok(p.includes('// unrelated application logic stays untouched\r\n'))
  const backups=fs.readdirSync(path.join(root,'data/update-backups'));assert.equal(backups.length,1)
  assert.equal(fs.readFileSync(path.join(root,'data/update-backups',backups[0],'tasks.ts'),'utf8'),source)
  assert.equal(fs.readFileSync(path.join(root,'data/private-sentinel.txt'),'utf8'),'user data must remain')
  assert.equal(apply(root).status,0);assert.equal(fs.readdirSync(path.join(root,'data/update-backups')).length,1)
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})
test('unsupported adapter or changed source is refused without writes',()=>{
 for(const mode of ['adapter','source']){
  const {root,source}=fixture(mode==='adapter'?'export const JIMENG_IMAGE_LIMIT = 8\n':undefined)
  try{if(mode==='source')fs.writeFileSync(path.join(root,'backend/src/routes/tasks.ts'),source.replace('imgs > 8','imgs > 7'))
   const before=fs.readFileSync(path.join(root,'backend/src/routes/tasks.ts'));const r=apply(root);assert.notEqual(r.status,0);assert.deepEqual(fs.readFileSync(path.join(root,'backend/src/routes/tasks.ts')),before);assert.equal(fs.existsSync(path.join(root,'data/update-backups')),false)
  }finally{fs.rmSync(root,{recursive:true,force:true})}
 }
})
test('running recorded backend is refused without modifications',()=>{
 const {root,source}=fixture()
 try{fs.mkdirSync(path.join(root,'data/local-runtime'));fs.writeFileSync(path.join(root,'data/local-runtime/backend-process.json'),JSON.stringify({processId:process.pid}));const r=apply(root);assert.notEqual(r.status,0);assert.match(r.stderr,/still active/);assert.equal(fs.readFileSync(path.join(root,'backend/src/routes/tasks.ts'),'utf8'),source)}finally{fs.rmSync(root,{recursive:true,force:true})}
})
