import { Hono } from 'hono'
import { requireAdmin } from '../services/platform-security/access.js'
import { requestLogStore } from '../services/request-logs/store.js'
import { success } from '../utils/response.js'
const app=new Hono()
app.use('*',async(c,next)=>{try{requireAdmin()}catch(error:any){return c.json({code:error.status||403,message:error.message},error.status||403)}c.header('Cache-Control','private, no-store');await next()})
app.onError((error:any,c)=>c.json({code:error.status||500,message:error.status?error.message:'请求日志暂时不可用'},error.status||500))
const store=()=>{const value=requestLogStore();if(!value)throw Object.assign(Error('请求日志尚未启用'),{status:503});return value}
function row(c:any){const id=c.req.param('id');if(!/^[a-f0-9-]{36}$/iu.test(id))throw Object.assign(Error('日志编号无效'),{status:400});const value=store().detail(id);if(!value)throw Object.assign(Error('请求日志不存在'),{status:404});return value}
const safeCSV=(value:unknown)=>{const raw=String(value??'');return '"'+(/^(?:[\t\r\n]|[\u0000-\u0020]*[=+@-])/u.test(raw)?"'"+raw:raw).replaceAll('"','""')+'"'}
app.get('/',c=>success(c,store().list(c.req.query())))
app.get('/export',c=>{
  const fields=['created_at','status','kind','user_name','user_display_name','project_title','episode_number','model','channel_name','phase','method','path','http_status','duration_ms','error','id','task_id','round_id','upstream_request_id','upstream_task_id']
  const values:any[]=[];let offset=0
  while(values.length<10000){const page=store().list({...c.req.query(),limit:100,offset});if(page.total>10000)throw Object.assign(Error('当前筛选超过10000条，请缩小时间或用户范围后导出'),{status:413});values.push(...page.items);offset+=page.items.length;if(offset>=page.total||!page.items.length)break}
  const csv='\uFEFF'+[fields.map(safeCSV).join(','),...values.slice(0,10000).map(row=>fields.map(key=>safeCSV((row as any)[key])).join(','))].join('\r\n')
  return new Response(csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="request-logs.csv"','Cache-Control':'private, no-store','X-Export-Limit':'10000','X-Content-Type-Options':'nosniff'}})
})
app.get('/:id/export',c=>new Response(JSON.stringify(row(c),null,2),{headers:{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="request-log.json"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}}))
app.get('/:id',c=>success(c,row(c)))
export default app
