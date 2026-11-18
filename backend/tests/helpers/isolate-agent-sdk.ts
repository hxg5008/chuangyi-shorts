/** Must be the first import of SDK tests, before importing application code. */
import { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const prefix = 'chuangyi-agent-sdk-isolated-'
export const isolatedSdkRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
process.env.HUOBAO_DATA_DIR = isolatedSdkRoot
process.env.SQLITE_PATH = path.join(isolatedSdkRoot, 'test.sqlite3')
process.env.STORAGE_PATH = path.join(isolatedSdkRoot, 'static')
process.env.WORKSPACE_PATH = path.join(isolatedSdkRoot, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.HUOBAO_PROXY_URL = 'direct'
// A developer's real .env must not replace this fixture's connection settings.
process.env.DOTENV_CONFIG_PATH = path.join(isolatedSdkRoot, 'empty.env')
fs.writeFileSync(process.env.DOTENV_CONFIG_PATH, '')

const folded = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
/** Check resolved application anchors and the actual SQLite file before any
 * test may generate an activity. A bad import order fails closed. */
export async function assertSdkTestIsolation() {
  const { DATA_ROOT, STORAGE_ROOT } = await import('../../src/utils/paths.js')
  const { db } = await import('../../src/db/index.js')
  assert.equal(folded(DATA_ROOT), folded(isolatedSdkRoot), 'SDK fixture loaded a non-isolated DATA_ROOT')
  assert.equal(folded(STORAGE_ROOT), folded(path.join(isolatedSdkRoot, 'static')))
  assert.equal(folded(process.env.WORKSPACE_PATH!), folded(path.join(isolatedSdkRoot, 'workspace')))
  const main = (db.$client.prepare('PRAGMA database_list').all() as { name: string; file: string }[]).find(row => row.name === 'main')
  assert.ok(main?.file, 'SDK fixture must use a real isolated SQLite file')
  assert.equal(folded(main.file), folded(path.join(isolatedSdkRoot, 'test.sqlite3')), 'SDK fixture connected to a non-isolated SQLite database')
}

after(async () => {
  const actual = fs.realpathSync(isolatedSdkRoot), temporary = fs.realpathSync(os.tmpdir())
  const relative = path.relative(temporary, actual)
  assert.ok(relative && !path.isAbsolute(relative) && !relative.startsWith('..') && path.basename(actual).startsWith(prefix), 'Refusing unsafe SDK fixture cleanup')
  const { db } = await import('../../src/db/index.js')
  const main = (db.$client.open ? db.$client.prepare('PRAGMA database_list').all() : []) as { name: string; file: string }[]
  if (main.some(row => row.name === 'main' && folded(row.file) === folded(path.join(isolatedSdkRoot, 'test.sqlite3')))) db.$client.close()
  await fs.promises.rm(actual, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})
