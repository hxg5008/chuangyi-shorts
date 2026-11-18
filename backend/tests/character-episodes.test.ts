import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chuangyi-character-episodes-'))
process.env.HUOBAO_DATA_DIR = root; process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.STORAGE_PATH = path.join(root, 'static'); process.env.WORKSPACE_PATH = path.join(root, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'; process.env.HUOBAO_PROXY_URL = 'direct'
const { db, schema } = await import('../src/db/index.ts')
const security = await import('../src/services/platform-security/index.ts')
const { characterEpisodeUsage } = await import('../src/services/character-episodes.ts')
const { httpErrorHandler } = await import('../src/middleware/logger.ts')
const characters = (await import('../src/routes/characters.ts')).default
security.initPlatformSecurity()
const admin = security.listUsers().find(user => user.role === 'admin')!
const owner = security.createUser('usage-owner', 'test-password').user
const foreign = security.createUser('usage-foreign', 'test-password').user
const at = '2026-11-09T00:00:00.000Z', stamp = { createdAt: at, updatedAt: at }
const project = (title: string, ownerId = owner.id, deletedAt?: string) => db.insert(schema.dramas).values({ title, ownerUserId: ownerId, ...stamp, deletedAt }).returning().get()
const a = project('角色关联项目'), b = project('其他用户项目', foreign.id), otherOwn = project('同一用户的另一个项目')
const role = (dramaId: number, name = '苏清寒', deletedAt?: string) => db.insert(schema.characters).values({ dramaId, name, ...stamp, deletedAt }).returning().get()
const char = role(a.id), sameName = role(a.id), foreignChar = role(b.id), emptyChar = role(a.id, '未关联角色')
const episode = (number: number, dramaId = a.id, deletedAt?: string) => db.insert(schema.episodes).values({ dramaId, episodeNumber: number, title: `第${number}集标题`, ...stamp, deletedAt }).returning().get()
const ep10 = episode(10), ep2 = episode(2), ep1 = episode(1), ep7 = episode(7), inactiveOnly = episode(9), deleted = episode(5, a.id, at)
const otherOwnerEp = episode(20, b.id), otherOwnEp = episode(30, otherOwn.id)
const attach = (episodeId: number, characterId = char.id) => db.insert(schema.episodeCharacters).values({ episodeId, characterId, createdAt: at }).run()
const bind = (episodeId: number, characterId = char.id, deletedAt?: string) => {
  const storyboard = db.insert(schema.storyboards).values({ episodeId, storyboardNumber: 1, ...stamp, deletedAt }).returning().get()
  db.insert(schema.storyboardCharacters).values({ storyboardId: storyboard.id, characterId }).run()
  return storyboard
}
attach(ep10.id); attach(ep10.id); attach(ep2.id); attach(ep1.id); attach(deleted.id)
bind(ep2.id); bind(ep7.id); bind(ep7.id); bind(inactiveOnly.id, char.id, at); bind(deleted.id)
// Corrupt historical links must not cross a project's boundary, even if the
// caller owns both projects. Same-name assets do not merge into this identity.
attach(otherOwnerEp.id); bind(otherOwnerEp.id); attach(otherOwnEp.id); bind(otherOwnEp.id)
attach(inactiveOnly.id, sameName.id); attach(999999)
attach(otherOwnerEp.id, foreignChar.id)

const app = new Hono(); app.onError(httpErrorHandler)
app.use('/api/*', security.platformSecurityMiddleware)
app.route('/api/v1/characters', characters)
const bare = new Hono(); bare.onError(httpErrorHandler); bare.route('/characters', characters)
const origin = 'http://127.0.0.1'
const ownerSession = security.createSession(owner), foreignSession = security.createSession(foreign), adminSession = security.createSession(admin)
const get = (id: number | string, session?: typeof ownerSession) => app.request(`${origin}/api/v1/characters/${id}/episodes`, {
  headers: { Origin: origin, ...(session ? { Cookie: `huobao_session=${session.token}` } : {}) },
})
after(async () => {
  db.$client.close()
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith('chuangyi-character-episodes-')) throw new Error('Unsafe test cleanup')
  await fs.rm(root, { recursive: true, force: true })
})

test('saved episode and active storyboard links are deduplicated, sorted by episode number and attributed to their actual sources', async () => {
  const response = await get(char.id, ownerSession)
  assert.equal(response.status, 200)
  const { data } = await response.json() as any
  assert.equal(data.character_id, char.id); assert.equal(data.drama_id, a.id); assert.equal(data.total, 4)
  assert.deepEqual(data.episodes, [
    { id: ep1.id, episode_number: 1, title: ep1.title, sources: ['episode_link'] },
    { id: ep2.id, episode_number: 2, title: ep2.title, sources: ['episode_link', 'storyboard_binding'] },
    { id: ep7.id, episode_number: 7, title: ep7.title, sources: ['storyboard_binding'] },
    { id: ep10.id, episode_number: 10, title: ep10.title, sources: ['episode_link'] },
  ])
})

test('a same-name asset is counted separately and an empty association stays an honest empty list', async () => {
  const same = await security.runAsActor(owner, () => characterEpisodeUsage(sameName.id))
  assert.deepEqual(same.episodes.map(episode => episode.id), [inactiveOnly.id])
  const response = await get(emptyChar.id, ownerSession)
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json() as any).data, { character_id: emptyChar.id, drama_id: a.id, total: 0, episodes: [] })
})

test('authenticated HTTP and direct service checks deny another owner while an administrator can inspect a valid owned project', async () => {
  assert.equal((await get(char.id)).status, 401)
  assert.equal((await get(char.id, foreignSession)).status, 404)
  assert.equal((await get(foreignChar.id, ownerSession)).status, 404)
  const response = await get(foreignChar.id, adminSession)
  assert.equal(response.status, 200)
  assert.equal((await response.json() as any).data.drama_id, b.id)
  assert.throws(() => characterEpisodeUsage(char.id, foreign), (error: any) => error.status === 404)
  assert.throws(() => characterEpisodeUsage(char.id), (error: any) => error.status === 401)
})

test('the route enforces access itself even when mounted without the global resource middleware', async () => {
  const denied = await security.runAsActor(foreign, () => bare.request(`/characters/${char.id}/episodes`))
  assert.equal(denied.status, 404)
  const accepted = await security.runAsActor(owner, () => bare.request(`/characters/${char.id}/episodes`))
  assert.equal(accepted.status, 200)
})

test('soft-deleted character/project and disabled identities do not expose associated episodes', async () => {
  const removed = role(a.id, '已删除角色', at)
  assert.equal((await get(removed.id, ownerSession)).status, 404)
  const removedProject = project('已删除项目', owner.id, at), orphan = role(removedProject.id)
  assert.equal((await get(orphan.id, adminSession)).status, 404)
  const disabled = security.createUser('usage-disabled', 'test-password').user
  db.$client.prepare('UPDATE platform_users SET enabled=0 WHERE id=?').run(disabled.id)
  assert.throws(() => characterEpisodeUsage(char.id, { ...disabled, role: 'admin' }), (error: any) => error.status === 401)
})

test('invalid identifiers are rejected rather than accepting numeric coercion aliases', async () => {
  for (const value of ['0', '-1', '1e0', '0x1', '+1', 'Infinity', '9007199254740992']) {
    assert.equal((await security.runAsActor(owner, () => bare.request(`/characters/${value}/episodes`))).status, 400, value)
  }
  for (const value of [0, -1, NaN, Infinity, 1.2]) assert.throws(() => characterEpisodeUsage(value, owner), (error: any) => error.status === 400)
})

test('listing usage changes no database rows, starts no task and never marks an unlinked episode as present', async () => {
  const changes = () => (db.$client.prepare('SELECT total_changes() n').get() as any).n
  const before = changes(), tasks = (db.$client.prepare('SELECT count(*) n FROM sys_task').get() as any).n
  for (let n = 0; n < 3; n++) assert.equal((await get(char.id, ownerSession)).status, 200)
  assert.equal(changes(), before)
  assert.equal((db.$client.prepare('SELECT count(*) n FROM sys_task').get() as any).n, tasks)
})
