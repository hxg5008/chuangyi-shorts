import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
const require = createRequire(import.meta.url)
const { getActiveTaskSummary } = require('../../scripts/local-active-tasks.cjs')

test('stop guard detects active model and durable text jobs without mutating them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-stop-guard-')), file = path.join(root, 'test.sqlite3')
  const sqlite = new Database(file)
  try {
    sqlite.exec("CREATE TABLE sys_task(status TEXT); CREATE TABLE agent_jobs(status TEXT); INSERT INTO sys_task VALUES('processing'),('completed'); INSERT INTO agent_jobs VALUES('running'),('error')")
    assert.deepEqual(getActiveTaskSummary(file), { generation: 1, text: 1 })
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM agent_jobs WHERE status='running'").get().n, 1)
    sqlite.exec("UPDATE sys_task SET status='completed'; UPDATE agent_jobs SET status='done'")
    assert.deepEqual(getActiveTaskSummary(file), { generation: 0, text: 0 })
  } finally { sqlite.close(); fs.rmSync(root, { recursive: true, force: true }) }
})
