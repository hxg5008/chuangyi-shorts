import test,{after} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {createHash,randomBytes} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import sharp from 'sharp'
const root=await fs.mkdtemp(path.join(os.tmpdir(),'jimeng-snapshot-atomic-'))
process.env.HUOBAO_DATA_DIR=root;process.env.STORAGE_PATH=path.join(root,'static')
const {freezeJimengReferences,prepareJimengVideoRecord}=await import('../src/services/jimeng-local-media.ts')
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
const bytes=await sharp(randomBytes(1920*1080*4),{raw:{width:1920,height:1080,channels:4}}).png({compressionLevel:0}).toBuffer()
assert.ok(bytes.length>8_000_000&&bytes.length<10*1024*1024)
const sha=digest(bytes),cache=path.join(root,'jimeng-reference-snapshots'),file=path.join(cache,sha+'.image')
await fs.mkdir(path.join(root,'static/images'),{recursive:true});await fs.writeFile(path.join(root,'static/images/shared.png'),bytes)
const record={id:1,model:'jimeng-2.0-fast',prompt:'@人物 转身。',referenceImageUrls:JSON.stringify(['static/images/shared.png']),referenceImageNames:JSON.stringify(['人物']),duration:5,aspectRatio:'16:9'}
after(async()=>{await fs.rm(root,{recursive:true,force:true})})

test('nine simultaneous videos sharing one large real PNG all freeze complete identical original bytes',async()=>{
  const lists=await Promise.all(Array.from({length:9},()=>freezeJimengReferences(record)))
  assert.ok(lists.every(list=>list[0].sha256===sha))
  assert.equal(digest(await fs.readFile(file)),sha)
  assert.deepEqual((await fs.readdir(cache)).filter(name=>name.endsWith('.tmp')),[])
})
test('valid shared snapshots are reused unchanged, including repeated references within a single video',async()=>{
  const before=await fs.stat(file)
  const repeated={...record,prompt:'两个人物参考。',referenceImageUrls:JSON.stringify(['static/images/shared.png','static/images/shared.png']),referenceImageNames:JSON.stringify(['人物正面','人物背面'])}
  const snapshots=await freezeJimengReferences(repeated),prepared=await prepareJimengVideoRecord(repeated,snapshots)
  assert.equal(snapshots.length,2);assert.equal(snapshots[0].sha256,snapshots[1].sha256)
  assert.ok(prepared.jimengImages?.every(image=>Buffer.from(image.data_base64,'base64').equals(bytes)))
  const after=await fs.stat(file);assert.equal(after.mtimeMs,before.mtimeMs)
})
test('an interrupted old partial file repairs only from validated original bytes for its own SHA',async()=>{
  await fs.writeFile(file,bytes.subarray(0,64))
  const snapshots=await freezeJimengReferences(record),prepared=await prepareJimengVideoRecord(record,snapshots)
  assert.equal(digest(await fs.readFile(file)),sha)
  assert.ok(Buffer.from(prepared.jimengImages![0].data_base64,'base64').equals(bytes))
})
test('atomic publication also works across independent Node processes sharing the cache',async()=>{
  await fs.unlink(file)
  const child=fileURLToPath(new URL('./helpers/jimeng-snapshot-child.mjs',import.meta.url))
  const values=await Promise.all(Array.from({length:3},()=>promisify(execFile)(process.execPath,['--import','tsx',child],{cwd:path.resolve(fileURLToPath(new URL('..',import.meta.url))),env:{...process.env},windowsHide:true,timeout:30_000,maxBuffer:64_000})))
  for(const value of values){const result=JSON.parse(value.stdout.trim());assert.equal(result.sha256,sha);assert.equal(result.bytes,bytes.length)}
  assert.equal(digest(await fs.readFile(file)),sha)
  assert.deepEqual((await fs.readdir(cache)).filter(name=>name.endsWith('.tmp')),[])
})
test('Windows transient rename contention is retried within a bound, without deleting the shared final path',async()=>{
  await fs.writeFile(file,bytes.subarray(0,32))
  const originalRename=fs.rename;let attempts=0
  fs.rename=(async(from:any,to:any)=>{if(String(to)===file&&++attempts<3)throw Object.assign(new Error('synthetic transient Windows reader'),{code:'EPERM'});return originalRename(from,to)}) as typeof fs.rename
  try{await freezeJimengReferences(record);assert.equal(attempts,3);assert.equal(digest(await fs.readFile(file)),sha)}finally{fs.rename=originalRename}
})
test('changing source assets cannot change adopted snapshots; prepare still rejects a tampered historical snapshot',async()=>{
  const original=await freezeJimengReferences(record)
  const newer=await sharp({create:{width:16,height:16,channels:4,background:'#ff8800'}}).png().toBuffer()
  await fs.writeFile(path.join(root,'static/images/shared.png'),newer)
  const second=await freezeJimengReferences(record)
  assert.notEqual(second[0].sha256,original[0].sha256)
  assert.ok(Buffer.from((await prepareJimengVideoRecord(record,original)).jimengImages![0].data_base64,'base64').equals(bytes))
  await fs.writeFile(file,Buffer.from('partial'))
  await assert.rejects(prepareJimengVideoRecord(record,original),/内容发生变化/u)
  assert.equal((await fs.readFile(file)).toString(),'partial','recovery does not replace a historical reference from a changed source')
})
