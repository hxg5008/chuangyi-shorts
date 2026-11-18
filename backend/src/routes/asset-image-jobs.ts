import {Hono} from 'hono'
import {assetImagePreparationJob,listAssetImagePreparationJobs} from '../services/asset-image-preparation.js'
const app=new Hono()
const id=(value:string|undefined)=>{if(value===undefined)return undefined;if(!/^[1-9]\d*$/u.test(value)||!Number.isSafeInteger(Number(value)))throw Object.assign(Error('项目或剧集编号不正确'),{status:400});return Number(value)}
function failure(c:any,error:any){const status=[400,401,403,404].includes(error.status)?error.status:500;return c.json({code:status,message:status===500?'准备任务暂时不可用':error.message},status)}
app.get('/',c=>{try{return c.json({code:200,data:{items:listAssetImagePreparationJobs({episodeId:id(c.req.query('episode_id')),projectId:id(c.req.query('project_id'))})},message:'success'})}catch(error){return failure(c,error)}})
app.get('/:id',c=>{try{return c.json({code:200,data:assetImagePreparationJob(c.req.param('id')),message:'success'})}catch(error){return failure(c,error)}})
export default app
