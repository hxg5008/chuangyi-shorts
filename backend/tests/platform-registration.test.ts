import {test,after} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import syncFs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {scryptSync} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {Hono} from 'hono'
import {bodyLimit} from 'hono/body-limit'

const directory=await fs.mkdtemp(path.join(os.tmpdir(),'huobao-registration-'))
process.env.HUOBAO_DATA_DIR=directory;process.env.SQLITE_PATH=path.join(directory,'fixture.sqlite3');process.env.STORAGE_PATH=path.join(directory,'static');process.env.MYSQL_AUTO_IMPORT='false'
const {db}=await import('../src/db/index.ts'),security=await import('../src/services/platform-security/index.ts')
security.initPlatformSecurity()
const auth=(await import('../src/routes/platform-auth.ts')).default,users=(await import('../src/routes/platform-users.ts')).default,dramas=(await import('../src/routes/dramas.ts')).default
const app=new Hono()
app.use('/api/*',bodyLimit({maxSize:10*1024*1024,onError:c=>c.json({code:413,message:'请求内容超过10MB'},413)}))
app.use('/api/*',security.platformSecurityMiddleware)
app.route('/api/v1/auth',auth);app.route('/api/v1/admin/users',users);app.route('/api/v1/dramas',dramas)
type Client={cookie:string;csrf:string;user:any}
async function request(method:string,url:string,body?:any,client?:Client,origin='http://studio.test'){
 const headers=new Headers({Origin:origin});if(body!==undefined)headers.set('Content-Type','application/json');if(client){headers.set('Cookie',client.cookie);headers.set('X-CSRF-Token',client.csrf)}
 return app.request('http://studio.test/api/v1'+url,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})})
}
async function session(response:Response):Promise<Client>{assert.equal(response.status,200);const value:any=await response.json();assert(response.headers.get('set-cookie')?.includes('HttpOnly'));assert(value.data.csrfToken);return{cookie:response.headers.get('set-cookie')!.split(';')[0],csrf:value.data.csrfToken,user:value.data.user}}
const login=async(username:string,password:string)=>session(await request('POST','/auth/login',{username,password}))
const initial=await fs.readFile(path.join(directory,'admin-initial-password.txt'),'utf8'),oldAdminPassword=/Initial password: ([^\r\n]+)/u.exec(initial)![1]
let admin=await login('admin',oldAdminPassword),first:Client,second:Client
const longName='相同长用户名'.repeat(20),nameA=longName+'A',nameB=longName+'B',longPassword='长密码🌙原样'.repeat(180)

test('public self registration accepts one-character credentials and automatically opens only an ordinary enabled session',async()=>{
 first=await session(await request('POST','/auth/register',{username:'  我  ',password:' ' }));assert.equal(first.user.username,'我');assert.equal(first.user.role,'user');assert.equal(first.user.enabled,true)
 const me:any=await(await request('GET','/auth/me',undefined,first)).json();assert.equal(me.data.user.id,first.user.id)
 assert.equal((await request('GET','/admin/users',undefined,first)).status,403)
 assert.equal((await login('我',' ')).user.id,first.user.id)
 assert.equal((await request('POST','/auth/login',{username:'我',password:''})).status,401,'password whitespace is preserved rather than trimmed')
})

test('registered users immediately create private projects and cannot see or mutate another registered user project',async()=>{
 second=await session(await request('POST','/auth/register',{username:'另一个用户',password:'密',role:'user',enabled:true}))
 const created:any=await(await request('POST','/dramas',{title:'First private project'},first)).json();assert.equal(created.data.owner_user_id,first.user.id)
 const list:any=await(await request('GET','/dramas',undefined,second)).json();assert(!list.data.items.some((row:any)=>row.id===created.data.id))
 for(const method of ['GET','PUT','DELETE'])assert.equal((await request(method,'/dramas/'+created.data.id,method==='PUT'?{title:'forged'}:undefined,second)).status,404)
})

test('no username or password business length limit remains and full long usernames have independent login throttle identities',async()=>{
 assert(nameA.length>60);assert(longPassword.length>256)
 const a=await session(await request('POST','/auth/register',{username:nameA,password:longPassword})),b=await session(await request('POST','/auth/register',{username:nameB,password:'x'}))
 assert.equal(a.user.username,nameA);assert.equal((await login(nameA,longPassword)).user.id,a.user.id);assert.equal((await login(nameB,'x')).user.id,b.user.id)
 for(let index=0;index<8;index++)assert.equal((await request('POST','/auth/login',{username:nameA,password:'wrong'})).status,401)
 assert.equal((await request('POST','/auth/login',{username:nameA,password:longPassword})).status,429)
 assert.equal((await login(nameB,'x')).user.id,b.user.id,'sharing the same first 60 characters does not share the rate key')
})

test('ASCII NOCASE uniqueness is preserved, Unicode names remain exact, and registration cannot overwrite or elevate an administrator',async()=>{
 const before=security.userByName('admin')!.password_hash
 assert.equal((await request('POST','/auth/register',{username:'new-admin-attempt',password:'x',role:'admin'})).status,400)
 assert.equal((await request('POST','/auth/register',{username:'new-disabled-attempt',password:'x',enabled:false})).status,400)
 assert.equal((await request('POST','/auth/register',{username:' ADMIN ',password:'overwrite-attempt'})).status,409)
 assert.equal(security.userByName('new-admin-attempt'),undefined);assert.equal(security.userByName('admin')!.password_hash,before);assert.equal(security.userByName('admin')!.role,'admin')
 const mixed=await session(await request('POST','/auth/register',{username:'MixedCase用户',password:'x'}));assert.equal((await login('mixedcase用户','x')).user.id,mixed.user.id)
 assert.equal((await request('POST','/auth/register',{username:'MIXEDCASE用户',password:'x'})).status,409)
 const upper=await session(await request('POST','/auth/register',{username:'Ä',password:'x'})),lower=await session(await request('POST','/auth/register',{username:'ä',password:'x'}));assert.notEqual(upper.user.id,lower.user.id,'SQLite NOCASE does not change into Unicode case folding')
})

test('same-origin checks, nonempty credentials, control rejection and the independent display-name rule remain effective',async()=>{
 assert.equal((await request('POST','/auth/register',{username:'cross-site',password:'x'},undefined,'https://other.invalid')).status,403)
 for(const username of ['', '   ','用\n户','用\u0000户','用\u202e户'])assert.equal((await request('POST','/auth/register',{username,password:'x'})).status,400)
 assert.equal((await request('POST','/auth/register',{username:'empty-password',password:''})).status,400)
 assert.equal((await request('POST','/auth/register',{username:'missing-password'})).status,400)
 assert.equal((await request('POST','/auth/register',{username:'display-name-rule',password:'x',display_name:'名'.repeat(81)})).status,400)
})

test('administrator password changes accept short and long Unicode passwords, revoke all old sessions and survive bootstrap-file cleanup errors',async()=>{
 const oldCookie=admin.cookie,another=await login('admin',oldAdminPassword),nativeUnlink=syncFs.unlinkSync,initialFile=path.join(directory,'admin-initial-password.txt')
 syncFs.unlinkSync=((target:any)=>{if(path.resolve(String(target))===initialFile)throw Object.assign(Error('fixture locked bootstrap'),{code:'EACCES'});return nativeUnlink(target)}) as typeof syncFs.unlinkSync
 try{admin=await session(await request('POST','/auth/change-password',{current_password:oldAdminPassword,new_password:'密'},admin))}finally{syncFs.unlinkSync=nativeUnlink}
 assert.equal(security.authenticateRequest(new Request('http://studio.test',{headers:{Cookie:oldCookie}})),null);assert.equal(security.authenticateRequest(new Request('http://studio.test',{headers:{Cookie:another.cookie}})),null)
 assert.equal((await request('GET','/auth/me',undefined,admin)).status,200);assert.equal((await login('admin','密')).user.role,'admin')
 const warning:any=db.$client.prepare("SELECT target FROM platform_audit WHERE action='bootstrap-cleanup-warning'").get();assert.equal(warning.target,'private-bootstrap-file')
 assert.equal((await request('POST','/auth/change-password',{current_password:'wrong',new_password:'x'},admin)).status,400)
 assert.equal((await request('POST','/auth/change-password',{current_password:'密',new_password:''},admin)).status,400)
 const shortCookie=admin.cookie;admin=await session(await request('POST','/auth/change-password',{current_password:'密',new_password:longPassword},admin));assert.equal(security.authenticateRequest(new Request('http://studio.test',{headers:{Cookie:shortCookie}})),null)
 assert.equal((await login('admin',longPassword)).user.role,'admin');await assert.rejects(fs.stat(initialFile))
})

test('existing scrypt accounts and administrator create/reset paths retain compatibility with unrestricted credential lengths',async()=>{
 const salt='0123456789abcdef0123456789abcdef',password='Existing-legacy-password',digest='scrypt:'+salt+':'+scryptSync(password,salt,64).toString('hex'),at=new Date().toISOString()
 db.$client.prepare("INSERT INTO platform_users(username,display_name,role,enabled,password_hash,created_at,updated_at)VALUES('legacy_account','Legacy','user',1,?,?,?)").run(digest,at,at)
 assert.equal((await login('legacy_account',password)).user.username,'legacy_account');assert.equal(security.userByName('legacy_account')!.password_hash,digest)
 const created:any=await(await request('POST','/admin/users',{username:'管理员添加长名'.repeat(40),password:'x'},admin)).json();assert(created.data.user.id)
 const reset:any=await(await request('POST','/admin/users/'+created.data.user.id+'/reset-password',{password:longPassword},admin)).json();assert.equal(reset.code,200);assert.equal((await login(created.data.user.username,longPassword)).user.id,created.data.user.id)
})

test('bootstrap administrator names also accept one character or a long Unicode name without changing any existing account',()=>{
 const backend=fileURLToPath(new URL('../',import.meta.url)),module=new URL('../src/services/platform-security/store.ts',import.meta.url).href,dbModule=new URL('../src/db/index.ts',import.meta.url).href
 for(const [index,name]of ['管','初始管理员'.repeat(35)].entries()){
  const data=path.join(directory,'bootstrap-'+index),code=`const store=await import(${JSON.stringify(module)});store.initPlatformSecurity();process.stdout.write(JSON.stringify(store.listUsers()));const {db}=await import(${JSON.stringify(dbModule)});db.$client.close()`
  const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:backend,encoding:'utf8',windowsHide:true,timeout:15000,env:{...process.env,HUOBAO_ADMIN_USERNAME:name,HUOBAO_DATA_DIR:data,SQLITE_PATH:path.join(data,'test.sqlite3'),STORAGE_PATH:path.join(data,'static'),MYSQL_AUTO_IMPORT:'false'}})
  assert.equal(result.status,0,result.stderr);const users=JSON.parse(result.stdout);assert.equal(users[0].username,name);assert.equal(users[0].role,'admin')
 }
 assert.equal(security.userByName('admin')!.role,'admin')
})

test('general HTTP size protection is retained and rapid public registration is rate limited without approval gates',async()=>{
 const before=(db.$client.prepare('SELECT count(*) n FROM platform_users').get() as any).n
 const huge=await request('POST','/auth/register',{username:'transport-size-only',password:'x'.repeat(10*1024*1024+1)});assert.equal(huge.status,413)
 assert.equal((db.$client.prepare('SELECT count(*) n FROM platform_users').get() as any).n,before)
 let throttled=false;for(let index=0;index<40;index++){const response=await request('POST','/auth/register',{username:'',password:'x'});if(response.status===429){throttled=true;break};assert.equal(response.status,400)}assert(throttled)
})

after(async()=>{db.$client.close();const target=path.resolve(directory),relative=path.relative(path.resolve(os.tmpdir()),target);assert(relative&&!path.isAbsolute(relative)&&!relative.startsWith('..')&&path.basename(target).startsWith('huobao-registration-'));await fs.rm(target,{recursive:true,force:true,maxRetries:3})})
