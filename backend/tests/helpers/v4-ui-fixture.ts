/** Offline browser validation only. Never starts against production data. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const root = process.env.CY_UI_FIXTURE_DIR
if (!root || !path.basename(root).startsWith('cc-v4-ui-') || !path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('A private cc-v4-ui-* temporary directory is required')
fs.mkdirSync(root,{recursive:true})
process.env.HUOBAO_DATA_DIR=root;process.env.SQLITE_PATH=path.join(root,'test.sqlite3');process.env.STORAGE_PATH=path.join(root,'static');process.env.WORKSPACE_PATH=path.join(root,'workspace');process.env.MYSQL_AUTO_IMPORT='false';process.env.HUOBAO_PROXY_URL='direct'
const {db,schema}=await import('../../src/db/index.ts')
const security=await import('../../src/services/platform-security/index.ts')
security.initPlatformSecurity()
if(!db.$client.prepare('SELECT id FROM platform_users WHERE username=?').get('ui-operator')){
  const user=security.createUser('ui-operator','local-ui-test').user
  db.$client.prepare("UPDATE platform_users SET role='admin' WHERE id=?").run(user.id)
  const at=new Date().toISOString()
  const drama=db.insert(schema.dramas).values({title:'界面验收 · 完整导入与风格',ownerUserId:user.id,style:'3d',createdAt:at,updatedAt:at}).returning().get()
  for(let i=0;i<30;i++)db.insert(schema.props).values({dramaId:drama.id,name:`测试道具${i+1}`,description:'仅用于长页面弹窗检查。',createdAt:at,updatedAt:at}).run()
}
await import('../../src/index.ts')
