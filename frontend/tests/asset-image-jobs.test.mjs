import {test} from 'node:test'
import assert from 'node:assert/strict'
import {trackAssetPreparation,reconcileAssetImageJobs,preparationError} from '../app/utils/asset-image-jobs.js'
import {reconcileImageTasks} from '../app/utils/image-task-state.js'

const job=(index,extra={})=>({id:'prepare-'+index,asset_kind:'character',asset_id:index,episode_id:2,status:'preparing_prompt',active:true,created_at:'2026-11-07T01:00:00Z',...extra})
test('seven independent preparations share one snapshot and hand off to the original image IDs without losing other cards',()=>{
  let pending={};for(let index=1;index<=7;index++)pending=trackAssetPreparation(pending,'character',index,'prepare-'+index)
  const jobs=Array.from({length:7},(_,i)=>job(i+1,i<3?{status:'completed',image_generation_id:100+i,active:true}:{}))
  const state=reconcileAssetImageJobs(pending,jobs)
  assert.equal(Object.keys(state.pending).length,7)
  assert.equal(state.pending['character:1'].taskId,100)
  assert.equal(state.pending['character:7'].phase,'preparing_prompt')
  assert.equal(state.failures.length,0)
})
test('timeout, failure and interruption release only the matching preparation and do not submit another request',()=>{
  let pending={};for(let index=1;index<=3;index++)pending=trackAssetPreparation(pending,'character',index,'prepare-'+index)
  const jobs=[job(1,{status:'failed',active:false,error_code:'preparation_timeout',error:'准备超时'}),job(2,{status:'interrupted',active:false,error_code:'preparation_interrupted'}),job(3)]
  const state=reconcileAssetImageJobs(pending,jobs)
  assert.deepEqual(Object.keys(state.pending),['character:3'])
  assert.equal(state.failures.length,2)
  assert.equal(preparationError(jobs[0]),'准备超时')
  assert.match(preparationError(jobs[1]),/已中断/)
})
test('a page reload restores server preparations and a handoff whose image task is not visible yet',()=>{
  const state=reconcileAssetImageJobs({},[job(1),job(2,{status:'completed',image_generation_id:102,active:true})],[])
  assert.equal(state.pending['character:1'].assetJobId,'prepare-1')
  assert.equal(state.pending['character:1'].startedAt,'2026-11-07T01:00:00Z')
  assert.equal(state.pending['character:2'].taskId,102)
  const done=reconcileImageTasks(state.pending,[{id:102,type:'image',character_id:2,status:'completed'}])
  assert.equal(done.pending['character:2'],undefined)
  assert.ok(done.pending['character:1'])
})
test('old completed history does not make a finished image look active again',()=>{
  const jobs=[job(1,{status:'completed',active:false,image_generation_id:101})]
  assert.equal(Object.keys(reconcileAssetImageJobs({},jobs,[]).pending).length,0)
  assert.equal(Object.keys(reconcileAssetImageJobs({},[job(1,{status:'completed',active:true,image_generation_id:101})],[{id:101,status:'completed'}]).pending).length,0)
})
test('a late failed snapshot from the preceding attempt cannot clear or label a new explicit attempt',()=>{
  const pending=trackAssetPreparation({},'character',1,'new-prepare')
  const state=reconcileAssetImageJobs(pending,[job(1,{status:'failed',active:false,error:'old failure'})])
  assert.equal(state.pending['character:1'].assetJobId,'new-prepare')
  assert.equal(state.failures.length,0)
  assert.equal(state.errors.length,0)
})
