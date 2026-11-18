import {test,after} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'
import {Hono} from 'hono'

// All persistence paths are isolated before the first business import.
const root=await fs.mkdtemp(path.join(os.tmpdir(),'huobao-user-deletion-'))
Object.assign(process.env,{HUOBAO_DATA_DIR:root,SQLITE_PATH:path.join(root,'test.sqlite3'),STORAGE_PATH:path.join(root,'static'),WORKSPACE_PATH:path.join(root,'workspace'),MYSQL_AUTO_IMPORT:'false',HUOBAO_PROXY_URL:'direct',PUBLIC_BASE_URL:'http://workbench.test'})
const {db,schema}=await import('../src/db/index.ts')
const security=await import('../src/services/platform-security/index.ts')
const {RequestLogStore}=await import('../src/services/request-logs/store.ts')
security.initPlatformSecurity()
const auth=(await import('../src/routes/platform-auth.ts')).default
const users=(await import('../src/routes/platform-users.ts')).default
const sql=db.$client,at=new Date().toISOString()
const app=new Hono()
app.use('/api/*',security.platformSecurityMiddleware)
app.route('/api/v1/auth',auth)
app.route('/api/v1/admin/users',users)
app.get('/api/v1/dramas/:id',c=>c.json({code:200,data:{id:c.req.param('id')}}))
app.post('/api/v1/tasks',c=>c.json({code:201},201))
app.use('/static/*',security.privateMediaMiddleware)
app.get('/static/*',()=>new Response('private image'))
interface Client{cookie:string;csrf:string;user:security.Actor}
async function call(method:string,url:string,client?:Client,body?:unknown){
 const headers=new Headers({Origin:'http://workbench.test'})
 if(client){headers.set('Cookie',client.cookie);headers.set('X-CSRF-Token',client.csrf)}
 if(body!==undefined)headers.set('Content-Type','application/json')
 return app.request('http://workbench.test'+url,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})})
}
async function login(username:string,password:string):Promise<Client>{const response=await call('POST','/api/v1/auth/login',undefined,{username,password});assert.equal(response.status,200);const result:any=await response.json();return{cookie:response.headers.get('set-cookie')!.split(';')[0],csrf:result.data.csrfToken,user:result.data.user}}
const bootstrap=await fs.readFile(path.join(root,'admin-initial-password.txt'),'utf8')
const admin=await login('admin',/Initial password: ([^\r\n]+)/u.exec(bootstrap)![1])
const create=(name:string)=>security.createUser(name,'fixture-password').user
const project=(user:security.Actor,title='Preserved project')=>db.insert(schema.dramas).values({title,ownerUserId:user.id,createdAt:at,updatedAt:at}).returning().get()
const episode=(dramaId:number)=>db.insert(schema.episodes).values({dramaId,episodeNumber:1,title:'Fixture episode',createdAt:at,updatedAt:at}).returning().get()

test('migration adds tombstone metadata without rebuilding users or changing existing IDs',()=>{
 const columns=sql.prepare('PRAGMA table_info(platform_users)').all() as any[]
 assert(columns.some(row=>row.name==='deleted_at'));assert(columns.some(row=>row.name==='deleted_username'))
 assert.equal(security.userById(admin.user.id)?.username,'admin')
 security.initPlatformSecurity();assert.equal(security.userById(admin.user.id)?.username,'admin')
})

let removed:security.Actor,removedProject:number,signed:string,privatePath:string
test('administrator deletes a user, revokes sessions and retains ownership, media and history',async()=>{
 removed=create('HistoricalCreator');const client=await login('HistoricalCreator','fixture-password');removedProject=project(removed).id
 privatePath='static/uploads/deletion-fixture.png';await fs.mkdir(path.join(root,'static','uploads'),{recursive:true});await fs.writeFile(path.join(root,'static','uploads','deletion-fixture.png'),'fixture image')
 security.runAsActor(removed,()=>security.registerPrivateMedia(privatePath,removedProject))
 signed=security.runAsActor(removed,()=>security.signedProviderMediaUrl(privatePath))
 const logs=new RequestLogStore(sql)
 const log=logs.begin({actorUserId:removed.id,projectOwnerId:removed.id,projectId:removedProject,kind:'text',phase:'generate',method:'POST',path:'/v1/chat/completions',url:'https://fixture.invalid/v1/chat/completions',model:'fixture-model'})
 logs.finish(log,{status:'succeeded',elapsed:100,body:{text:'preserved'},recorded:true})
 const response=await call('DELETE','/api/v1/admin/users/'+removed.id,admin)
 assert.equal(response.status,200);const body:any=await response.json();assert.equal(body.data.deleted,true);assert.equal(body.data.projects_preserved,true);assert.equal(body.data.username_reusable,true)
 const row=sql.prepare('SELECT * FROM platform_users WHERE id=?').get(removed.id) as any
 assert.equal(row.deleted_username,'HistoricalCreator');assert(row.deleted_at);assert.equal(row.enabled,0);assert.equal(row.password_hash,'');assert.notEqual(row.username,'HistoricalCreator')
 assert.equal((sql.prepare('SELECT owner_user_id FROM dramas WHERE id=?').get(removedProject) as any).owner_user_id,removed.id)
 assert.equal((sql.prepare('SELECT count(*) n FROM platform_sessions WHERE user_id=?').get(removed.id) as any).n,0)
 assert.equal(await fs.readFile(path.join(root,'static','uploads','deletion-fixture.png'),'utf8'),'fixture image')
 assert.equal(logs.detail(log)?.request.user_name,'HistoricalCreator')
 assert.equal(logs.list({q:'HistoricalCreator'}).total,1)
 assert(logs.options().users.some((row:any)=>row.id===removed.id&&row.username==='HistoricalCreator'))
 assert(!security.listUsers().some(row=>row.id===removed.id));assert.equal(security.userById(removed.id),undefined)
 assert.equal((await call('GET','/api/v1/dramas/'+removedProject,client)).status,401)
 assert.equal((await call('GET','/'+privatePath,client)).status,401)
 assert.equal((await app.request(signed)).status,401)
 assert.equal((await call('POST','/api/v1/auth/login',undefined,{username:row.username,password:'fixture-password'})).status,401)
 assert.equal((await call('POST','/api/v1/auth/login',undefined,{username:'HistoricalCreator',password:'fixture-password'})).status,401)
 assert.equal((await call('POST','/api/v1/tasks',client,{drama_id:removedProject})).status,401)
 assert.equal((await call('GET','/api/v1/dramas/'+removedProject,admin)).status,200)
 assert.equal((await call('GET','/'+privatePath,admin)).status,200)
 assert.equal((sql.prepare("SELECT count(*) n FROM platform_audit WHERE action='user-delete' AND target=?").get(String(removed.id)) as any).n,1)
 assert.equal((await call('DELETE','/api/v1/admin/users/'+removed.id,admin)).status,200)
 assert.equal((sql.prepare("SELECT count(*) n FROM platform_audit WHERE action='user-delete' AND target=?").get(String(removed.id)) as any).n,1)
})

test('same-name registration gets a new identity and never inherits old projects or private media',async()=>{
 const response=await call('POST','/api/v1/auth/register',undefined,{username:'HistoricalCreator',password:'new-fixture-password'})
 assert.equal(response.status,200);const body:any=await response.json();assert.notEqual(body.data.user.id,removed.id)
 const client=await login('HistoricalCreator','new-fixture-password')
 assert.equal((await call('GET','/api/v1/dramas/'+removedProject,client)).status,404)
 assert.equal((await call('GET','/'+privatePath,client)).status,404)
 assert.throws(()=>security.createSession(removed),/不存在|停用/u)
 assert.throws(()=>security.runAsActor(removed,()=>security.requireActor()),/请先登录/u)
 // Even an accidentally re-enabled tombstone is never authenticatable.
 sql.prepare('UPDATE platform_users SET enabled=1 WHERE id=?').run(removed.id)
 assert.equal(security.userById(removed.id),undefined)
 assert.throws(()=>security.runAsActor(removed,()=>security.requireActor()),/请先登录/u)
 sql.prepare('UPDATE platform_users SET enabled=0 WHERE id=?').run(removed.id)
})

test('self-deletion, ordinary users, absent users and malformed identifiers cannot remove an account',async()=>{
 const user=create('AccessTest'),client=await login(user.username,'fixture-password')
 const self=await call('DELETE','/api/v1/admin/users/'+admin.user.id,admin);assert.equal(self.status,409);assert.equal((await self.json() as any).error_code,'cannot_delete_self')
 assert.equal((await call('DELETE','/api/v1/admin/users/'+user.id,client)).status,403)
 assert.equal((await call('DELETE','/api/v1/admin/users/999999',admin)).status,404)
 assert.equal((await call('DELETE','/api/v1/admin/users/not-a-user',admin)).status,400)
 assert(security.userById(admin.user.id));assert(security.userById(user.id))
})

test('enabled and disabled secondary administrators can be removed without touching the current administrator',async()=>{
 for(const enabled of [0,1]){const user=create('SecondaryAdmin'+enabled);sql.prepare("UPDATE platform_users SET role='admin',enabled=? WHERE id=?").run(enabled,user.id)
  assert.equal((await call('DELETE','/api/v1/admin/users/'+user.id,admin)).status,200)
 }
 assert.equal(security.userById(admin.user.id)?.enabled,1)
})

test('model grants are removed atomically, selected-only empty lists remain private, and history user IDs do not change',async()=>{
 sql.exec("CREATE TABLE platform_channel_models(id INTEGER PRIMARY KEY,allowed_user_ids_json TEXT NOT NULL,access_mode TEXT NOT NULL,updated_at TEXT)")
 const user=create('GrantedUser'),other=create('AnotherGrantedUser');sql.prepare("INSERT INTO platform_channel_models VALUES(1,?,'selected',?)").run(JSON.stringify([user.id]),at);sql.prepare("INSERT INTO platform_channel_models VALUES(2,?,'selected',?)").run(JSON.stringify([user.id,other.id]),at)
 assert.equal((await call('DELETE','/api/v1/admin/users/'+user.id,admin)).status,200)
 const grants=sql.prepare('SELECT * FROM platform_channel_models ORDER BY id').all() as any[]
 assert.equal(grants[0].allowed_user_ids_json,'[]');assert.equal(grants[0].access_mode,'selected');assert.deepEqual(JSON.parse(grants[1].allowed_user_ids_json),[other.id])
 const replacement=create('GrantedUser');assert.notEqual(replacement.id,user.id);assert(!grants.some(row=>JSON.parse(row.allowed_user_ids_json).includes(replacement.id)))
})

test('active image and video tasks block deletion with locatable 409 diagnostics and no state changes',async()=>{
 const user=create('BusyUser'),p=project(user),e=episode(p.id)
 const person=db.insert(schema.characters).values({dramaId:p.id,name:'Fixture person',createdAt:at,updatedAt:at}).returning().get()
 const task=db.insert(schema.sysTask).values({type:'image',characterId:person.id,status:'processing',stage:'generating',createdAt:at,updatedAt:at}).returning().get()
 const response=await call('DELETE','/api/v1/admin/users/'+user.id,admin);assert.equal(response.status,409)
 const body:any=await response.json();assert.equal(body.error_code,'user_has_active_tasks');assert.equal(body.active_task_count,1);assert.equal(body.active_tasks[0].id,task.id);assert.equal(body.active_tasks[0].project_id,p.id);assert.equal(body.active_tasks[0].stage,'generating')
 assert(security.userById(user.id));assert.equal((sql.prepare('SELECT status FROM sys_task WHERE id=?').get(task.id) as any).status,'processing')
 sql.prepare("UPDATE sys_task SET status='completed' WHERE id=?").run(task.id)
 assert.equal((await call('DELETE','/api/v1/admin/users/'+user.id,admin)).status,200)
 assert(sql.prepare('SELECT id FROM episodes WHERE id=?').get(e.id))
})

test('active text, asset preparation, merge and batch queues block; finished and paused-only queues do not',async()=>{
 sql.exec(`CREATE TABLE IF NOT EXISTS agent_jobs(id TEXT PRIMARY KEY,episode_id INTEGER,status TEXT,scope TEXT,started_at TEXT,payload TEXT);
 CREATE TABLE IF NOT EXISTS platform_asset_image_jobs(id TEXT PRIMARY KEY,project_id INTEGER,episode_id INTEGER,user_id INTEGER,status TEXT,image_generation_id INTEGER);
 CREATE TABLE IF NOT EXISTS platform_production_batches(id TEXT PRIMARY KEY,drama_id INTEGER,user_id INTEGER,status TEXT);
 CREATE TABLE IF NOT EXISTS platform_production_steps(id TEXT PRIMARY KEY,batch_id TEXT,status TEXT);
 CREATE TABLE IF NOT EXISTS platform_activity_tasks(id TEXT PRIMARY KEY,project_id INTEGER,episode_id INTEGER,user_id INTEGER,kind TEXT,source_type TEXT,status TEXT,stage TEXT,title TEXT,created_at TEXT,updated_at TEXT);`)
 const user=create('BusyTextUser'),p=project(user),e=episode(p.id)
 sql.prepare("INSERT INTO agent_jobs(id,episode_id,status,scope,started_at,payload) VALUES('agent',?,'running','test',?,'{}')").run(e.id,at)
 sql.prepare("INSERT INTO platform_asset_image_jobs VALUES('preparing',?,?,?,'preparing_prompt',NULL)").run(p.id,e.id,user.id)
 sql.prepare("INSERT INTO platform_production_batches VALUES('batch',?,?,'running')").run(p.id,user.id)
 sql.exec("INSERT INTO platform_production_steps VALUES('step','batch','queued')")
 sql.prepare("INSERT INTO platform_activity_tasks(id,project_id,episode_id,user_id,kind,source_type,status,stage,title,created_at,updated_at) VALUES('extract',?,?,?,'text',NULL,'running','extracting','Extract',?,?)").run(p.id,e.id,user.id,at,at)
 const merge=db.insert(schema.videoMerges).values({dramaId:p.id,episodeId:e.id,provider:'fixture',model:'fixture',status:'pending',createdAt:at}).returning().get()
 assert.deepEqual(new Set(security.activeTasksForUser(user.id).map(row=>row.kind)),new Set(['text','asset_preparation','batch','merge','text_activity']))
 assert.equal((await call('DELETE','/api/v1/admin/users/'+user.id,admin)).status,409)
 sql.exec("UPDATE agent_jobs SET status='done';UPDATE platform_asset_image_jobs SET status='completed';UPDATE platform_production_batches SET status='paused';UPDATE platform_activity_tasks SET status='completed'")
 sql.prepare("UPDATE video_merges SET status='completed' WHERE id=?").run(merge.id)
 assert.deepEqual(security.activeTasksForUser(user.id),[])
 assert.equal((await call('DELETE','/api/v1/admin/users/'+user.id,admin)).status,200)
 assert.equal((sql.prepare("SELECT status FROM platform_production_steps WHERE id='step'").get() as any).status,'queued')
})

test('unrelated users and deleted-project orphans do not permanently block account removal',async()=>{
 const user=create('OrphanOwner'),p=project(user),other=create('BusyOther'),op=project(other)
 sql.prepare('UPDATE dramas SET deleted_at=? WHERE id=?').run(at,p.id)
 db.insert(schema.sysTask).values([{type:'video',dramaId:p.id,status:'processing',createdAt:at,updatedAt:at},{type:'image',dramaId:op.id,status:'pending',createdAt:at,updatedAt:at}]).run()
 sql.prepare("INSERT INTO platform_activity_tasks(id,project_id,episode_id,user_id,kind,source_type,status,stage,title,created_at,updated_at) VALUES('orphan',?,NULL,?,'text',NULL,'running','extracting','Orphan',?,?)").run(p.id,user.id,at,at)
 assert.deepEqual(security.activeTasksForUser(user.id),[])
 assert.equal((await call('DELETE','/api/v1/admin/users/'+user.id,admin)).status,200)
 assert.equal((await call('DELETE','/api/v1/admin/users/'+other.id,admin)).status,409)
})

test('restart assigns ownerless legacy projects to an active administrator, never a deleted earliest administrator',async()=>{
 const childRoot=path.join(root,'restart'),childDb=path.join(childRoot,'test.sqlite3');await fs.mkdir(childRoot,{recursive:true})
 const {default:Database}=await import('better-sqlite3'),{initSqliteSchema}=await import('../src/db/sqlite-schema.ts')
 const childSql=new Database(childDb);initSqliteSchema(childSql)
 childSql.exec(`CREATE TABLE platform_users(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT NOT NULL UNIQUE COLLATE NOCASE,display_name TEXT NOT NULL,role TEXT NOT NULL,enabled INTEGER NOT NULL,password_hash TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,deleted_username TEXT)`)
 const insert=childSql.prepare('INSERT INTO platform_users VALUES(?,?,?,?,?,?,?,?,?,?)')
 insert.run(1,'removed-admin','Removed','admin',0,'fixture',at,at,at,'old-admin');insert.run(2,'live-admin','Live','admin',1,'fixture',at,at,null,null)
 childSql.prepare('INSERT INTO dramas(title,created_at,updated_at) VALUES(?,?,?)').run('Ownerless fixture',at,at);childSql.close()
 const moduleUrl=pathToFileURL(path.resolve('src/services/platform-security/store.ts')).href
 const code=`const m=await import(${JSON.stringify(moduleUrl)});m.initPlatformSecurity();console.log(JSON.stringify(m.sql.prepare("SELECT owner_user_id FROM dramas WHERE title='Ownerless fixture'").get()));m.sql.close()`
 const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:process.cwd(),env:{...process.env,HUOBAO_DATA_DIR:childRoot,SQLITE_PATH:childDb,STORAGE_PATH:path.join(childRoot,'static'),WORKSPACE_PATH:path.join(childRoot,'workspace')},encoding:'utf8',timeout:30000})
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/"owner_user_id":2/u)
})

after(async()=>{sql.close();const target=path.resolve(root),relative=path.relative(os.tmpdir(),target);assert(relative&&!path.isAbsolute(relative)&&!relative.startsWith('..')&&path.basename(target).startsWith('huobao-user-deletion-'));await fs.rm(target,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
