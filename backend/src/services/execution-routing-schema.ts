import type Database from 'better-sqlite3'

/** Keep route IDs and encrypted keys stable while allowing immutable revisions. */
export function ensureExecutionRoutingSchema(sql: Database.Database) {
  sql.exec(`CREATE TABLE IF NOT EXISTS platform_execution_identity(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS platform_execution_services(config_id INTEGER PRIMARY KEY,account_id TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL);`)
  const existing = sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='platform_jimeng_project_routes'").get()
  const columns = existing ? sql.prepare('PRAGMA table_info(platform_jimeng_project_routes)').all() as { name: string }[] : []
  const create = (name: string) => sql.exec(`CREATE TABLE ${name}(id INTEGER PRIMARY KEY AUTOINCREMENT,drama_id INTEGER NOT NULL,owner_id INTEGER NOT NULL,
    server_origin TEXT NOT NULL,account_id TEXT NOT NULL,canvas_id TEXT,remote_route_id TEXT,key_blob TEXT,canvas_request_id TEXT NOT NULL,
    state TEXT NOT NULL,updated_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,is_current INTEGER NOT NULL DEFAULT 0,
    remote_project_id TEXT,selection_mode TEXT NOT NULL DEFAULT 'new',UNIQUE(drama_id,server_origin,version));`)
  if (!existing) create('platform_jimeng_project_routes')
  else if (!columns.some(column => column.name === 'version')) {
    sql.transaction(() => {
      // This release stores task references in JSON, not SQL foreign keys.
      // Refuse an unknown external schema instead of triggering ON DELETE
      // actions while rebuilding the legacy table.
      const tables = sql.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]
      const references = tables.some(table => table.name !== 'platform_jimeng_project_routes' && (sql.prepare(`PRAGMA foreign_key_list("${table.name.replaceAll('"','""')}")`).all() as {table:string}[]).some(key => key.table === 'platform_jimeng_project_routes'))
      if (references) throw Error('项目绑定表存在外部外键，未自动重建或更改数据；请管理员检查扩展表后再迁移。')
      const sequence = sql.prepare("SELECT seq FROM sqlite_sequence WHERE name='platform_jimeng_project_routes'").get() as {seq:number}|undefined
      create('platform_jimeng_project_routes_upgrade')
      sql.exec(`INSERT INTO platform_jimeng_project_routes_upgrade(id,drama_id,owner_id,server_origin,account_id,canvas_id,remote_route_id,key_blob,canvas_request_id,state,updated_at,version,is_current,remote_project_id,selection_mode)
        SELECT id,drama_id,owner_id,server_origin,account_id,canvas_id,remote_route_id,key_blob,canvas_request_id,state,updated_at,1,1,'project:'||drama_id,CASE WHEN canvas_id IS NULL THEN 'new' ELSE 'existing' END FROM platform_jimeng_project_routes;
        DROP TABLE platform_jimeng_project_routes;
        ALTER TABLE platform_jimeng_project_routes_upgrade RENAME TO platform_jimeng_project_routes;`)
      if (sequence) sql.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='platform_jimeng_project_routes'").run(sequence.seq)
    }).immediate()
  }
  sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_current_route ON platform_jimeng_project_routes(drama_id,server_origin) WHERE is_current=1;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_pending_route ON platform_jimeng_project_routes(drama_id,server_origin) WHERE state='preparing' AND is_current=0;
    CREATE TABLE IF NOT EXISTS platform_execution_account_policies(server_origin TEXT NOT NULL,account_id TEXT NOT NULL,enabled INTEGER NOT NULL,
      access TEXT NOT NULL CHECK(access IN('all','selected')),user_ids_json TEXT NOT NULL,allow_create INTEGER NOT NULL,canvas_grants_json TEXT NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(server_origin,account_id));`)
  const currentColumns = sql.prepare('PRAGMA table_info(platform_jimeng_project_routes)').all() as { name: string }[]
  if (!currentColumns.some(column => column.name === 'requested_canvas_name')) sql.exec('ALTER TABLE platform_jimeng_project_routes ADD COLUMN requested_canvas_name TEXT')
  if (!currentColumns.some(column => column.name === 'adopt_legacy')) sql.exec('ALTER TABLE platform_jimeng_project_routes ADD COLUMN adopt_legacy INTEGER NOT NULL DEFAULT 0')
  sql.exec(`CREATE TABLE IF NOT EXISTS platform_execution_user_access(server_origin TEXT PRIMARY KEY,
    access TEXT NOT NULL CHECK(access IN('all','selected')),user_ids_json TEXT NOT NULL,updated_at TEXT NOT NULL);`)
}
