import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'

// Round 3 (2026-11-08) asset fixes, all user-approved:
//  8a  a later episode's extraction keeps an existing character / scene / prop as it is and only fills empty fields
//  A7  a new character's styling is never filled with its plot description
//  A4  editing the look (appearance/styling, scene place/time/description/lighting, prop name/appearance) clears the
//      stale saved image prompt unless a new prompt is supplied; saving the same text again changes nothing
//  A5  deleted characters / scenes / props no longer appear in the project views
//  A6  deleting a character or prop also removes its storyboard bindings
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-round3-assets-'))
process.env.SQLITE_PATH = path.join(directory, 'assets.sqlite3')
process.env.HUOBAO_DATA_DIR = directory
process.env.STORAGE_PATH = path.join(directory, 'static')
process.env.WORKSPACE_PATH = path.join(directory, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.ts')
const fixtureOwner = await (await import('./helpers/platform-fixture.ts')).platformFixtureOwner()
const { extractTools } = await import('../src/agents/tools/extract-tools.ts')
const { buildAgentRequestContext } = await import('../src/agents/context.ts')
const app = new Hono()
app.route('/characters', (await import('../src/routes/characters.ts')).default)
app.route('/scenes', (await import('../src/routes/scenes.ts')).default)
app.route('/props', (await import('../src/routes/props.ts')).default)
app.route('/dramas', (await import('../src/routes/dramas.ts')).default)
const timestamps = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
after(async () => { db.$client.close(); await fs.rm(directory, { recursive: true, force: true }) })

const project = (title: string) => {
  const drama = db.insert(schema.dramas).values({ ownerUserId: fixtureOwner.id, title, ...timestamps }).returning().get()
  const episode = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 2, title: '第二集', scriptContent: '阿甲：走。', ...timestamps }).returning().get()
  return { drama, episode, requestContext: buildAgentRequestContext({ episodeId: episode.id, dramaId: drama.id, language: 'zh' }) }
}
const character = (id: number) => db.select().from(schema.characters).where(eq(schema.characters.id, id)).get()!
const scene = (id: number) => db.select().from(schema.scenes).where(eq(schema.scenes.id, id)).get()!
const prop = (id: number) => db.select().from(schema.props).where(eq(schema.props.id, id)).get()!
const put = async (url: string, body: unknown) => (await (await app.request(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()).data

test('8a/A7: a later extraction keeps an existing character as it is, fills only empty fields, and never uses the plot as styling', async () => {
  const { drama, requestContext } = project('extract-characters')
  const kept = db.insert(schema.characters).values({ dramaId: drama.id, name: '阿甲', role: '主角', description: '原简介', appearance: '原外貌', styling: '枣红色棉袄', finalPrompt: '原出图提示词', ...timestamps }).returning().get()
  const empty = db.insert(schema.characters).values({ dramaId: drama.id, name: '阿乙', role: '配角', appearance: '', styling: '', finalPrompt: '过时提示词', ...timestamps }).returning().get()
  const result: any = await (extractTools.saveDedupCharacters as any).execute({ characters: [
    { name: '阿甲（主角）', role: '路人', description: '新简介', appearance: '新外貌', styling: '藏青色干部装' },
    { name: '阿乙', appearance: '补上的外貌', styling: '灰绿色工装' },
    { name: '阿丙', role: '被提及', description: '阿甲早年离家的哥哥，本集只在对白中被提到。' },
  ] }, { requestContext })
  assert.equal(result.merged, 2); assert.equal(result.created, 1)
  const a = character(kept.id)
  assert.deepEqual([a.role, a.description, a.appearance, a.styling, a.finalPrompt], ['主角', '原简介', '原外貌', '枣红色棉袄', '原出图提示词'], 'existing look and prompt kept')
  assert.equal(a.updatedAt, timestamps.updatedAt, 'an unchanged character is not rewritten at all')
  const b = character(empty.id)
  assert.deepEqual([b.role, b.appearance, b.styling, b.finalPrompt], ['配角', '补上的外貌', '灰绿色工装', null], 'empty look filled; the stale prompt is cleared')
  const c = db.select().from(schema.characters).all().find(row => row.dramaId === drama.id && row.name === '阿丙')!
  assert.equal(c.description, '阿甲早年离家的哥哥，本集只在对白中被提到。')
  assert.equal(c.styling, '', 'the plot description is not copied into styling')
})

test('8a: an existing scene keeps its description and an existing prop its appearance; only empty fields are filled', async () => {
  const { drama, requestContext } = project('extract-scenes-props')
  const yard = db.insert(schema.scenes).values({ dramaId: drama.id, location: '院落', time: '日', prompt: '原院落描述', lighting: '', finalPrompt: '院落旧提示词', ...timestamps }).returning().get()
  const hall = db.insert(schema.scenes).values({ dramaId: drama.id, location: '堂屋', time: '夜', prompt: '原堂屋描述', lighting: '油灯', finalPrompt: '堂屋提示词', ...timestamps }).returning().get()
  await (extractTools.saveDedupScenes as any).execute({ scenes: [
    { location: '院落', time: '日', prompt: '新院落描述', lighting: '晨光斜照' },
    { location: '堂屋', time: '夜', description: '新堂屋描述', lighting: '烛光' },
  ] }, { requestContext })
  assert.deepEqual([scene(yard.id).prompt, scene(yard.id).lighting, scene(yard.id).finalPrompt], ['原院落描述', '晨光斜照', null], 'description kept, empty lighting filled')
  assert.deepEqual([scene(hall.id).prompt, scene(hall.id).lighting, scene(hall.id).finalPrompt], ['原堂屋描述', '油灯', '堂屋提示词'], 'a complete scene is not changed')
  const jade = db.insert(schema.props).values({ dramaId: drama.id, name: '玉佩', type: '', description: '青白玉圆佩', finalPrompt: '玉佩提示词', ...timestamps }).returning().get()
  await (extractTools.saveDedupProps as any).execute({ props: [{ name: '玉佩', type: '信物', description: '碧绿方形玉牌' }] }, { requestContext })
  assert.deepEqual([prop(jade.id).type, prop(jade.id).description, prop(jade.id).finalPrompt], ['信物', '青白玉圆佩', '玉佩提示词'], 'appearance kept; filling only the type keeps the prompt')
})

test('A4: a changed look clears the stale image prompt; the same text saved again or a new prompt is kept', async () => {
  const { drama } = project('put-look')
  const row = db.insert(schema.characters).values({ dramaId: drama.id, name: '阿甲', appearance: '原外貌', styling: '原妆造', finalPrompt: '原提示词', ...timestamps }).returning().get()
  // The detail panel sends every field, including the unchanged prompt.
  assert.equal((await put(`/characters/${row.id}`, { name: '阿甲', appearance: '原外貌', styling: '原妆造', final_prompt: '原提示词' })).final_prompt_cleared, false)
  assert.equal(character(row.id).finalPrompt, '原提示词')
  assert.equal((await put(`/characters/${row.id}`, { name: '阿甲（改名）' })).final_prompt_cleared, false, 'a name is not part of the drawn look')
  assert.equal(character(row.id).finalPrompt, '原提示词')
  assert.equal((await put(`/characters/${row.id}`, { appearance: '原外貌', styling: '新妆造', final_prompt: '原提示词' })).final_prompt_cleared, true, 'new look with the old prompt')
  assert.equal(character(row.id).finalPrompt, null)
  db.update(schema.characters).set({ finalPrompt: '原提示词' }).where(eq(schema.characters.id, row.id)).run()
  assert.equal((await put(`/characters/${row.id}`, { appearance: '新外貌' })).final_prompt_cleared, true)
  assert.equal(character(row.id).finalPrompt, null)
  assert.equal((await put(`/characters/${row.id}`, { styling: '第三版妆造', final_prompt: '手写新提示词' })).final_prompt_cleared, false)
  assert.equal(character(row.id).finalPrompt, '手写新提示词', 'a supplied new prompt wins')
  assert.equal((await put(`/characters/${row.id}`, { final_prompt: '只改提示词' })).final_prompt_cleared, false)
  assert.equal(character(row.id).finalPrompt, '只改提示词')

  const place = db.insert(schema.scenes).values({ dramaId: drama.id, location: '院落', time: '日', prompt: '院落', lighting: '晨光', finalPrompt: '四视图提示词', ...timestamps }).returning().get()
  assert.equal((await put(`/scenes/${place.id}`, { location: '院落', time: '日', description: '院落', lighting: '晨光', final_prompt: '四视图提示词' })).final_prompt_cleared, false)
  assert.equal(scene(place.id).finalPrompt, '四视图提示词')
  assert.equal((await put(`/scenes/${place.id}`, { lighting: '夜色' })).final_prompt_cleared, true)
  assert.equal(scene(place.id).finalPrompt, null)

  const item = db.insert(schema.props).values({ dramaId: drama.id, name: '玉佩', type: '信物', description: '青白玉圆佩', finalPrompt: '白底单品提示词', ...timestamps }).returning().get()
  assert.equal((await put(`/props/${item.id}`, { type: '饰品' })).final_prompt_cleared, false)
  assert.equal(prop(item.id).finalPrompt, '白底单品提示词')
  assert.equal((await put(`/props/${item.id}`, { description: '碧绿方形玉牌' })).final_prompt_cleared, true)
  assert.equal(prop(item.id).finalPrompt, null)
})

test('A5/A6: deleted assets leave the project views, and deleting a character or prop removes its storyboard bindings', async () => {
  const { drama, episode } = project('delete-bindings')
  const keep = db.insert(schema.characters).values({ dramaId: drama.id, name: '阿甲', ...timestamps }).returning().get()
  const gone = db.insert(schema.characters).values({ dramaId: drama.id, name: '阿乙', ...timestamps }).returning().get()
  const keepProp = db.insert(schema.props).values({ dramaId: drama.id, name: '玉佩', ...timestamps }).returning().get()
  const goneProp = db.insert(schema.props).values({ dramaId: drama.id, name: '木匣', ...timestamps }).returning().get()
  const goneScene = db.insert(schema.scenes).values({ dramaId: drama.id, location: '旧屋', time: '日', prompt: '旧屋', deletedAt: '2026-01-02T00:00:00.000Z', ...timestamps }).returning().get()
  db.insert(schema.scenes).values({ dramaId: drama.id, location: '院落', time: '日', prompt: '院落', ...timestamps }).run()
  const board = db.insert(schema.storyboards).values({ episodeId: episode.id, storyboardNumber: 1, ...timestamps } as any).returning().get()
  for (const characterId of [keep.id, gone.id]) db.insert(schema.storyboardCharacters).values({ storyboardId: board.id, characterId } as any).run()
  for (const propId of [keepProp.id, goneProp.id]) db.insert(schema.storyboardProps).values({ storyboardId: board.id, propId } as any).run()

  assert.equal((await app.request(`/characters/${gone.id}`, { method: 'DELETE' })).status, 200)
  assert.equal((await app.request(`/props/${goneProp.id}`, { method: 'DELETE' })).status, 200)
  assert.ok(character(gone.id).deletedAt, 'still a soft delete: the row is kept')
  assert.deepEqual(db.select().from(schema.storyboardCharacters).all().filter(row => row.storyboardId === board.id).map(row => row.characterId), [keep.id])
  assert.deepEqual(db.select().from(schema.storyboardProps).all().filter(row => row.storyboardId === board.id).map(row => row.propId), [keepProp.id])

  const detail = (await (await app.request(`/dramas/${drama.id}`)).json()).data
  assert.deepEqual(detail.characters.map((row: any) => row.name), ['阿甲'])
  assert.deepEqual(detail.props.map((row: any) => row.name), ['玉佩'])
  assert.deepEqual(detail.scenes.map((row: any) => row.location), ['院落'])
  const listed = (await (await app.request('/dramas?page_size=100')).json()).data.items.find((row: any) => row.id === drama.id)
  assert.deepEqual(listed.characters.map((row: any) => row.name), ['阿甲'])
  assert.equal(listed.scenes.some((row: any) => row.id === goneScene.id), false)
})
