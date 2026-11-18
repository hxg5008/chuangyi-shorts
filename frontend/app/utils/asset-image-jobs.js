import { imageTaskKey,trackImageTask,isTaskActive } from './image-task-state.js'

const terminalPreparation = new Set(['failed','interrupted'])
export function trackAssetPreparation(pending,kind,assetId,jobId,metadata={}) {
  if(!jobId)throw new Error('图片准备任务未返回任务编号')
  const key=imageTaskKey(kind,assetId)
  return{...pending,[key]:{...pending[key],kind,assetId,taskId:null,assetJobId:String(jobId),phase:'preparing_prompt',startedAt:metadata.created_at||pending[key]?.startedAt||new Date().toISOString(),activityTaskId:metadata.activity_task_id||null}}
}
export function latestAssetImageJobs(jobs) {
  const sorted=[...(jobs||[])].sort((a,b)=>(Date.parse(b.created_at||'')||0)-(Date.parse(a.created_at||'')||0))
  const latest=new Map()
  for(const job of sorted){const key=imageTaskKey(job.asset_kind,job.asset_id);if(!latest.has(key)||job.active===true&&latest.get(key).active!==true)latest.set(key,job)}
  return[...latest.values()]
}
export function reconcileAssetImageJobs(pending,jobs,tasks=[]) {
  let next={...pending}
  const failures=[],byId=new Map((jobs||[]).map(job=>[String(job.id),job])),byTask=new Map((tasks||[]).map(task=>[Number(task.id),task]))
  for(const[key,item]of Object.entries(next)){
    if(!item.assetJobId)continue
    const job=byId.get(String(item.assetJobId))
    if(!job)continue
    if(terminalPreparation.has(job.status)){delete next[key];failures.push(job);continue}
    if(Number(job.image_generation_id)){next=trackImageTask(next,item.kind,item.assetId,job.image_generation_id);continue}
    next[key]={...item,phase:'preparing_prompt',startedAt:job.created_at||item.startedAt,activityTaskId:job.activity_task_id||item.activityTaskId}
  }
  const latest=latestAssetImageJobs(jobs)
  for(const job of latest){
    const key=imageTaskKey(job.asset_kind,job.asset_id)
    if(next[key])continue
    if(job.status==='preparing_prompt')next=trackAssetPreparation(next,job.asset_kind,Number(job.asset_id),job.id,job)
    else if(Number(job.image_generation_id)&&job.active===true){
      const task=byTask.get(Number(job.image_generation_id))
      if(task&&!isTaskActive(task))continue
      next=trackImageTask(next,job.asset_kind,Number(job.asset_id),job.image_generation_id)
    }
  }
  return{pending:next,failures,errors:latest.filter(job=>terminalPreparation.has(job.status)&&(!next[imageTaskKey(job.asset_kind,job.asset_id)]||String(next[imageTaskKey(job.asset_kind,job.asset_id)].assetJobId)===String(job.id)))}
}
export function preparationError(job) {
  if(job?.error_code==='preparation_timeout')return job.error||'提示词准备超时，未自动重新提交。'
  if(job?.status==='interrupted'||job?.error_code==='preparation_interrupted')return job.error||'提示词准备已中断，未自动重新提交。'
  return job?.error||'提示词准备失败，未自动重新提交。'
}
