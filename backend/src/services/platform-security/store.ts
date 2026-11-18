import fs from 'node:fs'
import path from 'node:path'
import {createHash,randomBytes,scryptSync,timingSafeEqual} from 'node:crypto'
import type Database from 'better-sqlite3'
import {db} from '../../db/index.js'
import {DATA_ROOT} from '../../utils/paths.js'

export interface Actor {id:number;username:string;displayName:string;role:'admin'|'user';enabled:boolean}
interface UserRow {id:number;username:string;display_name:string;role:'admin'|'user';enabled:number;password_hash:string;created_at:string;deleted_at?:string|null;deleted_username?:string|null}
const sql:Database.Database=db.$client
const stamp=()=>new Date().toISOString()
export const hashToken=(value:string)=>createHash('sha256').update(value).digest('hex')
export const publicUser=(r:UserRow):Actor=>({id:r.id,username:r.username,displayName:r.display_name||r.username,role:r.role,enabled:r.enabled===1})
const initialFile=path.join(DATA_ROOT,'admin-initial-password.txt')
let initialized=false
export function normalizeUsername(value:unknown){
  if(typeof value!=='string')throw Object.assign(Error('请填写用户名'),{status:400})
  const username=value.trim()
  if(!username||/[\p{Cc}\p{Cf}]/u.test(username))throw Object.assign(Error('用户名不能为空，且不能包含控制字符'),{status:400})
  return username
}
/** SQLite NOCASE folds ASCII only; do not silently change existing Unicode identity semantics. */
export const usernameIdentity=(value:string)=>value.replace(/[A-Z]/gu,letter=>letter.toLowerCase())
export function initPlatformSecurity(){
  if(initialized)return
  sql.exec(`CREATE TABLE IF NOT EXISTS platform_users(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT NOT NULL UNIQUE COLLATE NOCASE,display_name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','user')),enabled INTEGER NOT NULL DEFAULT 1,password_hash TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS platform_sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL,csrf_token TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_platform_sessions_user ON platform_sessions(user_id);
    CREATE TABLE IF NOT EXISTS platform_resources(path TEXT PRIMARY KEY,user_id INTEGER NOT NULL,project_id INTEGER,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS platform_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id INTEGER,action TEXT NOT NULL,target TEXT,created_at TEXT NOT NULL);`)
  const userColumns=sql.prepare('PRAGMA table_info(platform_users)').all() as {name:string}[]
  if(!userColumns.some(c=>c.name==='deleted_at'))sql.exec('ALTER TABLE platform_users ADD COLUMN deleted_at TEXT')
  if(!userColumns.some(c=>c.name==='deleted_username'))sql.exec('ALTER TABLE platform_users ADD COLUMN deleted_username TEXT')
  sql.exec('CREATE INDEX IF NOT EXISTS idx_platform_users_deleted ON platform_users(deleted_at,id)')
  const columns=sql.prepare('PRAGMA table_info(dramas)').all() as {name:string}[]
  if(!columns.some(c=>c.name==='owner_user_id'))sql.exec('ALTER TABLE dramas ADD COLUMN owner_user_id INTEGER')
  sql.exec('CREATE INDEX IF NOT EXISTS idx_dramas_owner ON dramas(owner_user_id,deleted_at)')
  sql.transaction(()=>{
  let admin=sql.prepare("SELECT * FROM platform_users WHERE role='admin' AND deleted_at IS NULL ORDER BY enabled DESC,id LIMIT 1").get() as UserRow|undefined
  if(!admin){
    const password=randomBytes(18).toString('base64url'),username=normalizeUsername(process.env.HUOBAO_ADMIN_USERNAME||'admin')
    fs.mkdirSync(DATA_ROOT,{recursive:true})
    // Only this private bootstrap creates an administrator. Public registration always creates ordinary users.
    try{fs.writeFileSync(initialFile,`Username: ${username}\nInitial password: ${password}\nChange this password after first login. This file is private; do not share it.\n`,{mode:0o600,flag:'wx'})}catch{throw Error('Administrator bootstrap file already exists while no administrator is stored; resolve the private bootstrap file locally before retrying')}
    const at=stamp()
    try{sql.prepare("INSERT INTO platform_users(username,display_name,role,enabled,password_hash,created_at,updated_at) VALUES(?,?,'admin',1,?,?,?)").run(username,'管理员',passwordHash(password),at,at)}catch(error){throw Error('Unable to initialize administrator; inspect the private bootstrap file before retrying')}
    admin=sql.prepare("SELECT * FROM platform_users WHERE role='admin' AND deleted_at IS NULL ORDER BY enabled DESC,id LIMIT 1").get() as UserRow
  }
  sql.prepare('UPDATE dramas SET owner_user_id=? WHERE owner_user_id IS NULL').run(admin.id)
  }).immediate()
  initialized=true
}
export function passwordHash(password:string){
  if(typeof password!=='string'||password.length===0)throw Object.assign(Error('密码不能为空'),{status:400})
  const salt=randomBytes(16).toString('hex')
  return `scrypt:${salt}:${scryptSync(password,salt,64).toString('hex')}`
}
export function checkPassword(password:unknown,stored:string){
  if(typeof password!=='string'||password.length===0)return false
  const [kind,salt,hex]=stored.split(':');if(kind!=='scrypt'||!/^[a-f0-9]{128}$/.test(hex||''))return false
  const actual=scryptSync(password,salt,64),expected=Buffer.from(hex,'hex')
  return timingSafeEqual(actual,expected)
}
export function userById(id:number){initPlatformSecurity();return sql.prepare('SELECT * FROM platform_users WHERE id=? AND deleted_at IS NULL').get(id) as UserRow|undefined}
export function userByName(username:string){initPlatformSecurity();return sql.prepare('SELECT * FROM platform_users WHERE username=? COLLATE NOCASE AND deleted_at IS NULL').get(username) as UserRow|undefined}
export function listUsers(){initPlatformSecurity();return (sql.prepare('SELECT * FROM platform_users WHERE deleted_at IS NULL ORDER BY id').all() as UserRow[]).map(publicUser)}
export function createUser(username:string,password?:string,displayName?:string){
  initPlatformSecurity();username=normalizeUsername(username)
  const generated=password===undefined,secret=generated?randomBytes(15).toString('base64url'):password!,at=stamp()
  if(typeof displayName!=='string'&&displayName!==undefined||displayName&&displayName.length>80)throw Object.assign(Error('显示名称不正确'),{status:400})
  const digest=passwordHash(secret)
  try{const result=sql.prepare("INSERT INTO platform_users(username,display_name,role,enabled,password_hash,created_at,updated_at) VALUES(?,?,'user',1,?,?,?)").run(username,displayName||username,digest,at,at);return{user:publicUser(userById(Number(result.lastInsertRowid))!),...(generated?{temporary_password:secret}:{})}}catch(error:any){if(String(error.code).includes('CONSTRAINT'))throw Object.assign(Error('用户名已存在'),{status:409});throw error}
}
export function updateUser(id:number,patch:{enabled?:boolean;display_name?:string}){
  const user=userById(id);if(!user)throw Object.assign(Error('用户不存在'),{status:404})
  if(patch.enabled!==undefined&&typeof patch.enabled!=='boolean')throw Object.assign(Error('enabled必须为布尔值'),{status:400})
  if(patch.display_name!==undefined&&(typeof patch.display_name!=='string'||!patch.display_name.trim()||patch.display_name.length>80))throw Object.assign(Error('显示名称不正确'),{status:400})
  if(user.role==='admin'&&patch.enabled===false){const other=sql.prepare("SELECT COUNT(*) n FROM platform_users WHERE role='admin' AND enabled=1 AND deleted_at IS NULL AND id!=?").get(id) as {n:number};if(!other.n)throw Object.assign(Error('不能停用最后一个管理员'),{status:400})}
  sql.prepare('UPDATE platform_users SET enabled=?,display_name=?,updated_at=? WHERE id=?').run(patch.enabled===undefined?user.enabled:Number(patch.enabled),patch.display_name??user.display_name,stamp(),id)
  if(patch.enabled===false)revokeSessions(id)
  return publicUser(userById(id)!)
}
export function setUserPassword(id:number,password?:string){const user=userById(id);if(!user)throw Object.assign(Error('用户不存在'),{status:404});const generated=password===undefined,secret=password??randomBytes(15).toString('base64url');sql.prepare('UPDATE platform_users SET password_hash=?,updated_at=? WHERE id=?').run(passwordHash(secret),stamp(),id);revokeSessions(id);return{user:publicUser(userById(id)!),...(generated?{temporary_password:secret}:{})}}
export function revokeSessions(id:number){sql.prepare('DELETE FROM platform_sessions WHERE user_id=?').run(id)}
export function createSession(user:Actor){
  const current=userById(user.id)
  if(!current?.enabled)throw Object.assign(Error('账号不存在或已停用'),{status:401})
  const token=randomBytes(32).toString('base64url'),csrfToken=randomBytes(24).toString('base64url'),expiresAt=Date.now()+12*60*60_000
  sql.prepare('DELETE FROM platform_sessions WHERE expires_at<?').run(Date.now())
  sql.prepare('INSERT INTO platform_sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)').run(hashToken(token),user.id,csrfToken,expiresAt,stamp())
  return{token,csrfToken,expiresAt}
}
export function readSession(token:string|undefined){initPlatformSecurity();if(!token||!/^[A-Za-z0-9_-]{43}$/.test(token))return null;const row=sql.prepare('SELECT s.csrf_token,s.expires_at,u.* FROM platform_sessions s JOIN platform_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.enabled=1 AND u.deleted_at IS NULL').get(hashToken(token),Date.now()) as (UserRow&{csrf_token:string;expires_at:number})|undefined;return row?{user:publicUser(row),csrfToken:row.csrf_token,expiresAt:row.expires_at}:null}
export function deleteSession(token:string|undefined){if(token)sql.prepare('DELETE FROM platform_sessions WHERE token_hash=?').run(hashToken(token))}
export function authenticateRequest(request:Request):Actor|null{
  const cookies=(request.headers.get('cookie')||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith('huobao_session='))
  if(cookies.length!==1)return null
  return readSession(cookies[0].slice('huobao_session='.length))?.user||null
}
export function removeInitialPasswordFile(){try{fs.unlinkSync(initialFile);return true}catch(error:any){return error.code==='ENOENT'}}
export function audit(actorId:number|null,action:string,target:string){sql.prepare('INSERT INTO platform_audit(actor_id,action,target,created_at) VALUES(?,?,?,?)').run(actorId,action,target,stamp())}
export {sql}
