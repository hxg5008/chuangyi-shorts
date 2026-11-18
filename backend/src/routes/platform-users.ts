import {Hono} from 'hono'
import {success,created} from '../utils/response.js'
import {requireAdmin,denied} from '../services/platform-security/access.js'
import {listUsers,createUser,updateUser,setUserPassword,audit} from '../services/platform-security/store.js'
import {deleteUser} from '../services/platform-security/user-deletion.js'

const app=new Hono()
const positive=(raw:string)=>{const id=Number(raw);if(!Number.isSafeInteger(id)||id<=0)throw denied('用户编号不正确',400);return id}
function failure(c:any,error:any){const status=[400,401,403,404,409].includes(error.status)?error.status:500;return c.json({code:status,message:status===500?'用户管理暂时不可用':error.message,...(error.errorCode?{error_code:error.errorCode}:{}),...(Array.isArray(error.activeTasks)?{active_task_count:error.activeTaskCount,active_tasks:error.activeTasks.slice(0,20)}:{})},status)}
app.get('/',c=>{requireAdmin();return success(c,listUsers())})
app.post('/',async c=>{try{const actor=requireAdmin(),body=await c.req.json();if(body.role&&body.role!=='user')throw denied('此入口只创建普通用户',400);const result=createUser(body.username,body.password,body.display_name);audit(actor.id,'user-create',String(result.user.id));return created(c,result)}catch(error){return failure(c,error)}})
app.put('/:id',async c=>{try{const actor=requireAdmin(),id=positive(c.req.param('id')),body=await c.req.json();if(Object.keys(body).some(k=>!['enabled','display_name'].includes(k)))throw denied('只能修改显示名称和启用状态',400);const user=updateUser(id,body);audit(actor.id,'user-update',String(id));return success(c,user)}catch(error){return failure(c,error)}})
app.post('/:id/reset-password',async c=>{try{const actor=requireAdmin(),id=positive(c.req.param('id')),body=await c.req.json();const result=setUserPassword(id,body.password);audit(actor.id,'user-password-reset',String(id));return success(c,result)}catch(error){return failure(c,error)}})
app.delete('/:id',c=>{try{const actor=requireAdmin();return success(c,deleteUser(positive(c.req.param('id')),actor.id))}catch(error){return failure(c,error)}})
export default app
