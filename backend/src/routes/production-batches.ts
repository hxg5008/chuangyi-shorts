import { Hono } from 'hono'
import { createProductionBatch, getProductionBatch, listProductionBatches, pauseProductionBatch, resumeProductionBatch, retryProductionBatch, type ProductionBatchManager } from '../services/production-batches.js'
import { requireActor } from '../services/platform-security/access.js'
import { redactRuntimeSecrets } from '../utils/secret-redaction.js'
export function createProductionBatchRoutes(manager?:ProductionBatchManager){
const create=manager?manager.create.bind(manager):createProductionBatch,get=manager?manager.get.bind(manager):getProductionBatch,list=manager?manager.list.bind(manager):listProductionBatches,
  pause=manager?manager.pause.bind(manager):pauseProductionBatch,resume=manager?manager.resume.bind(manager):resumeProductionBatch,retry=manager?manager.retry.bind(manager):retryProductionBatch
const app=new Hono()
app.use('*',async(c,next)=>{requireActor();return next()})
app.onError((error,c)=>{const status=[400,401,403,404,409].includes((error as any).status)?(error as any).status:500;return c.json({code:status,message:status===500?'批次操作暂未完成，请查看运行记录':redactRuntimeSecrets(error.message)},status)})
app.get('/',c=>{const value=c.req.query('drama_id'),dramaId=value===undefined?undefined:Number(value);if(value!==undefined&&(!Number.isSafeInteger(dramaId)||dramaId!<=0))return c.json({code:400,message:'drama_id 必须为正整数'},400);return c.json({code:200,data:{batches:list({dramaId,limit:Number(c.req.query('limit'))||50})},message:'success'})})
app.post('/',async c=>{let body:any;try{body=await c.req.json()}catch{return c.json({code:400,message:'请提交有效JSON'},400)}const data=await create(body);return c.json({code:202,data,message:'批量资产提取已接收'},202)})
app.get('/:id',c=>c.json({code:200,data:get(c.req.param('id')),message:'success'}))
app.post('/:id/pause',c=>c.json({code:200,data:pause(c.req.param('id')),message:'已暂停新派发；正在执行的步骤会继续完成'}))
app.post('/:id/resume',c=>c.json({code:200,data:resume(c.req.param('id')),message:'已继续未派发步骤；待核对任务不会重新提交'}))
app.post('/:id/retry',async c=>{let body:any={};try{const text=await c.req.text();if(text.trim())body=JSON.parse(text)}catch{return c.json({code:400,message:'请提交有效JSON'},400)}if(!body||typeof body!=='object'||Array.isArray(body))return c.json({code:400,message:'请提交重试参数对象'},400);return c.json({code:200,data:await retry(c.req.param('id'),body.step_ids),message:'已接收确定失败或过期步骤的手动重试'})})
return app
}
export default createProductionBatchRoutes()
