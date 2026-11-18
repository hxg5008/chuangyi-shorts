/** A shared service config must not share route credentials or a 500-row cache
 * across projects. All replies below are local synthetic observations. */
import test,{after} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
const folder=await fs.mkdtemp(path.join(os.tmpdir(),'cy-return-scope-'))
process.env.HUOBAO_DATA_DIR=folder;process.env.SQLITE_PATH=path.join(folder,'test.sqlite3');process.env.STORAGE_PATH=path.join(folder,'static')
process.env.WORKSPACE_PATH=path.join(folder,'workspace');process.env.MYSQL_AUTO_IMPORT='false';process.env.HUOBAO_PROXY_URL='direct';process.env.HUOBAO_JIMENG_AUTO_RETURN_MINUTES='0'
const {db,schema}=await import('../src/db/index.ts')
const {returnJimengVideos}=await import('../src/services/jimeng-return.ts')
const {eq}=await import('drizzle-orm')
const keys=['sk-cy-route-synthetic-a','sk-cy-route-synthetic-b']
const remoteIds=['jm_synthetic_old_project_a','jm_synthetic_old_project_b']
const requests:{method:string;url:string;owner:number}[]=[]
const server=http.createServer(async(req,res)=>{
  const owner=keys.findIndex(key=>req.headers.authorization==='Bearer '+key)
  requests.push({method:req.method!,url:req.url!,owner})
  res.setHeader('Content-Type','application/json')
  if(owner<0){res.statusCode=401;return res.end('{}')}
  if(req.method!=='GET'){res.statusCode=500;return res.end(JSON.stringify({error:'No generation or refresh is needed for a terminal result'}))}
  if(req.url==='/v1/videos?limit=500'){
    // Model an old task falling outside the server's most recent 500 rows.
    return res.end(JSON.stringify({data:Array.from({length:500},(_,index)=>({id:'jm_other_'+owner+'_'+index,status:'processing'})),total:501}))
  }
  if(req.url==='/v1/videos/'+remoteIds[owner])return res.end(JSON.stringify({id:remoteIds[owner],status:'failed',stage:'failed',error_code:'input_image_rejected',error:'参考图未通过审核 · project '+owner}))
  res.statusCode=404;res.end('{}')
})
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
const baseUrl='http://127.0.0.1:'+(server.address() as any).port
after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));db.$client.close();await fs.rm(folder,{recursive:true,force:true})})

test('same config and URL use separate scoped credentials; old task IDs beyond 500 still return terminal failures without replay',async()=>{
  const at=new Date().toISOString(),rows=remoteIds.map((taskId,index)=>db.insert(schema.sysTask).values({
    type:'video',provider:'jimeng_local',model:'jimeng-2.0-fast',configId:123,configBaseUrl:baseUrl,taskId,
    status:'completed',stage:'handed_off',prompt:'Synthetic exact original '+index,params:JSON.stringify({jimengHandoff:{accountId:'account-'+index,canvasId:String(100+index),submitId:'receipt-'+index}}),createdAt:at,updatedAt:at,
  }).returning().get())
  const outcome=await returnJimengVideos(rows.map(row=>row.id),{wait:true,resolveConfig:async row=>{
    const index=rows.findIndex(entry=>entry.id===row.id)
    return{id:123,provider:'jimeng_local',baseUrl,model:'jimeng-2.0-fast',apiKey:keys[index],executionRouteId:'rt_'+String(index+1).repeat(32)}
  }})
  assert.deepEqual(outcome.map(row=>row.outcome),['failed','failed'])
  for(const [index,row] of rows.entries()){
    const fresh=db.select().from(schema.sysTask).where(eq(schema.sysTask.id,row.id)).get()!
    assert.equal(fresh.status,'failed');assert.equal(fresh.errorCode,'generation_failed')
    assert.match(fresh.errorMsg!,new RegExp('project '+index))
    assert.equal(fresh.taskId,remoteIds[index]);assert.equal(fresh.prompt,row.prompt)
    assert.equal(requests.filter(request=>request.owner===index&&request.url==='/v1/videos?limit=500').length,1)
    assert.equal(requests.filter(request=>request.owner===index&&request.url==='/v1/videos/'+remoteIds[index]).length,1)
  }
  assert.equal(requests.length,4);assert.ok(requests.every(request=>request.method==='GET'))
})
