import {Hono} from 'hono'
import {setCookie,deleteCookie,getCookie} from 'hono/cookie'
import {getConnInfo} from '@hono/node-server/conninfo'
import {success} from '../utils/response.js'
import {userByName,checkPassword,publicUser,createSession,readSession,deleteSession,setUserPassword,removeInitialPasswordFile,audit as writeAudit,createUser,normalizeUsername,usernameIdentity,hashToken} from '../services/platform-security/store.js'
import {requireActor,denied} from '../services/platform-security/access.js'
import {secureCookie,assertRequestOrigin} from '../services/platform-security/middleware.js'

const app=new Hono(),attempts=new Map<string,{failures:number;reset:number}>(),registrations=new Map<string,{count:number;reset:number}>()
function audit(actorId:number,action:string,target:string){try{writeAudit(actorId,action,target)}catch{console.warn('账号操作审计记录暂时无法保存。')}}
function cookies(c:any,session:ReturnType<typeof createSession>){setCookie(c,'huobao_session',session.token,{path:'/',httpOnly:true,secure:secureCookie(c),sameSite:'Strict',maxAge:12*60*60})}
function failure(c:any,error:any){const status=error.name==='BodyLimitError'?413:[400,401,403,404,409,413,429].includes(error.status)?error.status:500;return c.json({code:status,message:status===500?'登录服务暂时不可用':status===413?'请求内容超过10MB，请减少本次提交内容':error.message},status)}
function peerAddress(c:any){let peer='local';try{peer=getConnInfo(c).remote.address||peer}catch{}return peer}
function throttleKey(c:any,name:string){return`${peerAddress(c)}|${hashToken(usernameIdentity(name))}`}
async function authBody(c:any){let body:any;try{body=await c.req.json()}catch(error:any){if(error.name==='BodyLimitError'||error.status===413)throw error;throw denied('请求正文必须为JSON对象',400)};if(!body||typeof body!=='object'||Array.isArray(body))throw denied('请求正文必须为JSON对象',400);return body}
app.get('/me',c=>{const actor=requireActor(),session=readSession(getCookie(c,'huobao_session'));if(!session)return c.json({code:401,message:'请先登录'},401);return success(c,{user:actor,csrfToken:session.csrfToken})})
app.post('/register',async c=>{
  try{
    assertRequestOrigin(c)
    const now=Date.now();for(const [key,value]of registrations)if(value.reset<now)registrations.delete(key)
    const key=peerAddress(c),entry=registrations.get(key)
    if(entry&&entry.count>=30)throw denied('注册操作过于频繁，请稍后再试',429)
    if(registrations.size>=1000&&!registrations.has(key))registrations.delete(registrations.keys().next().value!)
    registrations.set(key,{count:(entry?.count||0)+1,reset:entry?.reset||now+60_000})
    const body=await authBody(c)
    if(body.role!==undefined&&body.role!=='user'||body.enabled!==undefined&&body.enabled!==true)throw denied('自主注册只能创建已启用的普通用户',400)
    if(typeof body.password!=='string'||body.password.length===0)throw denied('密码不能为空',400)
    const {user}=createUser(body.username,body.password,body.display_name),session=createSession(user)
    cookies(c,session);audit(user.id,'register','self');return success(c,{user,csrfToken:session.csrfToken})
  }catch(error){return failure(c,error)}
})
app.post('/login',async c=>{
  try{
    assertRequestOrigin(c)
    const body=await authBody(c)
    let name:string;try{name=normalizeUsername(body.username)}catch{throw denied('用户名或密码不正确',401)}
    if(typeof body.password!=='string'||body.password.length===0)throw denied('用户名或密码不正确',401)
    const now=Date.now();for(const [id,value]of attempts)if(value.reset<now)attempts.delete(id)
    const key=throttleKey(c,name),entry=attempts.get(key)
    if(entry&&entry.failures>=8)throw denied('登录尝试过多，请15分钟后再试',429)
    const user=userByName(name)
    if(!user||!user.enabled||!checkPassword(body.password,user.password_hash)){
      if(attempts.size>=1000)attempts.delete(attempts.keys().next().value!)
      attempts.set(key,{failures:(entry?.failures||0)+1,reset:entry?.reset||now+15*60_000})
      throw denied('用户名或密码不正确',401)
    }
    attempts.delete(key);const actor=publicUser(user),session=createSession(actor);cookies(c,session);audit(actor.id,'login','self')
    return success(c,{user:actor,csrfToken:session.csrfToken})
  }catch(error){return failure(c,error)}
})
app.post('/logout',c=>{const actor=requireActor();deleteSession(getCookie(c,'huobao_session'));deleteCookie(c,'huobao_session',{path:'/'});audit(actor.id,'logout','self');return success(c,{loggedOut:true})})
app.post('/change-password',async c=>{
  try{
    const actor=requireActor(),body=await authBody(c),old=body.current_password??body.old_password,user=userByName(actor.username)
    if(!user||!checkPassword(old,user.password_hash))throw denied('当前密码不正确',400)
    if(typeof body.new_password!=='string')throw denied('请填写新密码',400)
    const {user:updated}=setUserPassword(actor.id,body.new_password),session=createSession(updated);cookies(c,session)
    if(actor.role==='admin'&&!removeInitialPasswordFile())audit(actor.id,'bootstrap-cleanup-warning','private-bootstrap-file')
    audit(actor.id,'password-change','self');return success(c,{user:updated,csrfToken:session.csrfToken})
  }catch(error){return failure(c,error)}
})
export default app
