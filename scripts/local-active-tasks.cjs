const path = require('node:path')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const localRequire = createRequire(path.resolve(__dirname, '../backend/package.json'))

function getActiveTaskSummary(databasePath) {
  if (!fs.existsSync(databasePath)) return { generation: 0, text: 0 }
  const Database = localRequire('better-sqlite3')
  const sqlite = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    const hasTable = name => Boolean(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name))
    return {
      generation: hasTable('sys_task') ? sqlite.prepare("SELECT count(*) AS n FROM sys_task WHERE status IN ('processing','pending')").get().n : 0,
      text: (hasTable('agent_jobs') ? sqlite.prepare("SELECT count(*) AS n FROM agent_jobs WHERE status='running'").get().n : 0)
        + (hasTable('platform_activity_tasks') ? sqlite.prepare("SELECT count(*) AS n FROM platform_activity_tasks WHERE kind='text' AND source_type IS NULL AND status IN ('running','queued')").get().n : 0),
    }
  } finally { sqlite.close() }
}
module.exports = { getActiveTaskSummary }
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(getActiveTaskSummary(process.argv[2] || path.resolve(__dirname, '../data/huobao.sqlite3')))) }
  catch (error) { process.stderr.write('Unable to check active local tasks.'); process.exitCode = 1 }
}
