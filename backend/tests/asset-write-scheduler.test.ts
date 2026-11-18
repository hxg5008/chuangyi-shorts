import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { RequestContext } from '@mastra/core/request-context'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-asset-writes-'))
process.env.HUOBAO_DATA_DIR = root
process.env.SQLITE_PATH = path.join(root, 'writes.sqlite3')
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.ts')
const security = await import('../src/services/platform-security/index.ts')
security.initPlatformSecurity()
const { extractTools } = await import('../src/agents/tools/extract-tools.ts')
const { withActivityContext, currentActivity } = await import('../src/services/activity/context.ts')
const { AssetWriteScheduler } = await import('../src/services/asset-write-scheduler.ts')
const owner = security.createUser('asset_write_owner', 'Synthetic-write-password').user
const at = new Date().toISOString()
function project(title: string, actor = owner) {
  const drama = db
    .insert(schema.dramas)
    .values({ title, ownerUserId: actor.id, createdAt: at, updatedAt: at })
    .returning()
    .get()
  const episodes = [1, 2].map((number) =>
    db
      .insert(schema.episodes)
      .values({
        dramaId: drama.id,
        episodeNumber: number,
        title: 'Episode ' + number,
        createdAt: at,
        updatedAt: at
      })
      .returning()
      .get()
  )
  return { drama, episodes }
}
function options(dramaId: number, episodeId: number, actor = owner) {
  const rc = new RequestContext()
  rc.set('dramaId', dramaId)
  rc.set('episodeId', episodeId)
  rc.set('actorId', actor.id)
  return { requestContext: rc }
}
const count = (table: string, dramaId: number) =>
  Number((db.$client.prepare(`SELECT count(*) n FROM ${table} WHERE drama_id=?`).get(dramaId) as any).n)
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function promptly<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('Unrelated work was blocked behind another asset lane')), 1000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

test('the unmodified original SELECT/INSERT tools reproduce the concurrent cross-episode dedup race', async () => {
  const fixture = project('Original race reproduction')
  const pairs: [any, any, string][] = [
    [
      extractTools.saveDedupCharacters,
      { characters: [{ name: '同一个角色', appearance: '保持原提取规则' }] },
      'characters'
    ],
    [
      extractTools.saveDedupScenes,
      { scenes: [{ location: '同一个场景', time: '夜', prompt: '保持原场景规则' }] },
      'scenes'
    ],
    [extractTools.saveDedupProps, { props: [{ name: '同一个道具', description: '保持原道具规则' }] }, 'props']
  ]
  for (const [tool, input, table] of pairs) {
    await Promise.all(
      fixture.episodes.map((episode) => tool.execute(input, options(fixture.drama.id, episode.id)))
    )
    assert.equal(
      count(table, fixture.drama.id),
      2,
      `Original ${table} race must be reproduced before adding a scheduler`
    )
  }
})

test('secured original extraction tools merge concurrent same-project assets and link the single result to both episodes without changing schemas', async () => {
  const fixture = project('Serialized actual original tools'),
    guarded = security.secureAgentTools(extractTools)
  const pairs: [any, any, any, string, string, string][] = [
    [
      extractTools.saveDedupCharacters,
      guarded.saveDedupCharacters,
      { characters: [{ name: '同一个角色', appearance: '原人物规则' }] },
      'characters',
      'episode_characters',
      'character_id'
    ],
    [
      extractTools.saveDedupScenes,
      guarded.saveDedupScenes,
      { scenes: [{ location: '同一个场景', time: '夜', prompt: '原场景规则' }] },
      'scenes',
      'episode_scenes',
      'scene_id'
    ],
    [
      extractTools.saveDedupProps,
      guarded.saveDedupProps,
      { props: [{ name: '同一个道具', description: '原道具规则' }] },
      'props',
      'episode_props',
      'prop_id'
    ]
  ]
  for (const [original, tool, input, table, links, idField] of pairs) {
    assert.equal(tool.inputSchema, original.inputSchema)
    assert.equal(tool.outputSchema, original.outputSchema)
    assert.equal(Object.getPrototypeOf(tool), Object.getPrototypeOf(original))
    const results: any[] = await Promise.all(
      fixture.episodes.map((episode) =>
        security.runAsActor(owner, () => tool.execute(input, options(fixture.drama.id, episode.id)))
      )
    )
    assert.equal(count(table, fixture.drama.id), 1)
    assert.equal(
      results.reduce((sum, result) => sum + result.created, 0),
      1
    )
    const related = db.$client
      .prepare(
        `SELECT episode_id,${idField} AS asset_id FROM ${links} WHERE episode_id IN(?,?) ORDER BY episode_id`
      )
      .all(...fixture.episodes.map((episode) => episode.id)) as any[]
    assert.deepEqual(
      related.map((link) => link.episode_id),
      fixture.episodes.map((episode) => episode.id)
    )
    assert.equal(new Set(related.map((link) => link.asset_id)).size, 1)
  }
})

test('characters share a FIFO lane with voice/final prompts while different projects, categories and reads proceed in parallel with their own actor/activity', async () => {
  const other = security.createUser('asset_write_other', 'Synthetic-other-password').user
  const first = project('FIFO owner A'),
    second = project('Parallel owner B', other),
    gate = deferred(),
    entered = deferred(),
    calls: any[] = []
  const originalSchema = { original: true }
  const execute = async (input: any) => {
    calls.push({ tag: input.tag, actor: security.currentActor()?.id, activity: currentActivity()?.taskId })
    if (input.tag === 'held') {
      entered.resolve()
      await gate.promise
    }
    return input.tag
  }
  const tools = security.secureAgentTools({
    char: { id: 'save_dedup_characters', inputSchema: originalSchema, execute },
    voice: { id: 'save_voice_cards', inputSchema: originalSchema, execute },
    prompt: { id: 'save_character_final_prompt', inputSchema: originalSchema, execute },
    scene: { id: 'save_dedup_scenes', inputSchema: originalSchema, execute },
    read: { id: 'read_existing_characters', inputSchema: originalSchema, execute }
  })
  const invoke = (tool: any, tag: string, fixture: any, actor = owner) =>
    security.runAsActor(actor, () =>
      withActivityContext({ taskId: tag }, () =>
        tool.execute({ tag }, options(fixture.drama.id, fixture.episodes[0].id, actor))
      )
    )
  const held = invoke(tools.char, 'held', first)
  await entered.promise
  const queued = invoke(tools.char, 'queued', first),
    voice = invoke(tools.voice, 'voice', first),
    prompt = invoke(tools.prompt, 'prompt', first)
  try {
    await promptly(
      Promise.all([
        invoke(tools.scene, 'scene', first),
        invoke(tools.read, 'read', first),
        invoke(tools.char, 'other', second, other)
      ])
    )
    assert(!calls.some((call) => ['queued', 'voice', 'prompt'].includes(call.tag)))
    assert.equal(calls.find((call) => call.tag === 'other').actor, other.id)
  } finally {
    gate.resolve()
    await Promise.all([held, queued, voice, prompt])
  }
  assert.deepEqual(
    calls.filter((call) => ['held', 'queued', 'voice', 'prompt'].includes(call.tag)).map((call) => call.tag),
    ['held', 'queued', 'voice', 'prompt']
  )
  for (const call of calls) {
    assert.equal(call.activity, call.tag)
    assert.equal(call.actor, call.tag === 'other' ? other.id : owner.id)
  }
  assert.equal(tools.char.inputSchema, originalSchema)
})

test('a waiting original write can be cancelled by activity or tool signal and never executes; following work remains runnable', async () => {
  const fixture = project('Abort waiting writers'),
    gate = deferred(),
    entered = deferred()
  const hold = security.secureAgentTools({
    hold: {
      id: 'save_dedup_characters',
      execute: async () => {
        entered.resolve()
        await gate.promise
      }
    }
  }).hold
  const guarded = security.secureAgentTools(extractTools)
  const held = security.runAsActor(owner, () =>
    hold.execute({}, options(fixture.drama.id, fixture.episodes[0].id))
  )
  await entered.promise
  const activityAbort = new AbortController(),
    toolAbort = new AbortController()
  const cancelled = security.runAsActor(owner, () =>
    withActivityContext(
      { abortSignal: activityAbort.signal },
      () =>
        guarded.saveDedupCharacters.execute(
          { characters: [{ name: 'Activity cancellation must not write' }] },
          options(fixture.drama.id, fixture.episodes[1].id)
        ) as Promise<any>
    )
  )
  const cancelledTool = security.runAsActor(
    owner,
    () =>
      guarded.saveDedupCharacters.execute({ characters: [{ name: 'Tool cancellation must not write' }] }, {
        ...options(fixture.drama.id, fixture.episodes[1].id),
        abortSignal: toolAbort.signal
      } as any) as Promise<any>
  )
  const activityRejected = assert.rejects(cancelled, (error) => (error as Error).name === 'AbortError'),
    toolRejected = assert.rejects(cancelledTool, (error) => (error as Error).name === 'AbortError')
  activityAbort.abort()
  toolAbort.abort()
  await promptly(Promise.all([activityRejected, toolRejected]))
  assert.equal(count('characters', fixture.drama.id), 0)
  const after = security.runAsActor(owner, () =>
    guarded.saveDedupCharacters.execute(
      { characters: [{ name: 'After cancellation' }] },
      options(fixture.drama.id, fixture.episodes[0].id)
    )
  )
  gate.resolve()
  await Promise.all([held, after])
  assert.equal(count('characters', fixture.drama.id), 1)
})

test('failed short writes release their lane and a queued actual original tool can still save', async () => {
  const fixture = project('Failure releases writes'),
    gate = deferred(),
    entered = deferred()
  const failing = security.secureAgentTools({
    hold: {
      id: 'save_dedup_props',
      execute: async () => {
        entered.resolve()
        await gate.promise
        throw Error('synthetic write failure')
      }
    }
  }).hold
  const guarded = security.secureAgentTools(extractTools)
  const first = security.runAsActor(owner, () =>
    failing.execute({}, options(fixture.drama.id, fixture.episodes[0].id))
  )
  await entered.promise
  const next = security.runAsActor(owner, () =>
    guarded.saveDedupProps.execute(
      { props: [{ name: 'After failed writer' }] },
      options(fixture.drama.id, fixture.episodes[1].id)
    )
  )
  const outcomes = Promise.allSettled([first, next])
  gate.resolve()
  const results = await outcomes
  assert.equal(results[0].status, 'rejected')
  assert.equal(results[1].status, 'fulfilled')
  assert.equal(count('props', fixture.drama.id), 1)
})

test('queued execution rechecks project ownership and a disabled actor before touching original tool data', async () => {
  const fixture = project('Permissions changed while queued'),
    gate = deferred(),
    entered = deferred()
  const holding = security.secureAgentTools({
    hold: {
      id: 'save_dedup_scenes',
      execute: async () => {
        entered.resolve()
        await gate.promise
      }
    }
  }).hold
  const guarded = security.secureAgentTools(extractTools)
  const first = security.runAsActor(owner, () =>
    holding.execute({}, options(fixture.drama.id, fixture.episodes[0].id))
  )
  await entered.promise
  const waiting = security.runAsActor(owner, () =>
    guarded.saveDedupScenes.execute(
      { scenes: [{ location: 'Must not save after transfer', time: '夜' }] },
      options(fixture.drama.id, fixture.episodes[1].id)
    )
  )
  const rejected = assert.rejects(waiting, /项目不存在|无访问权限/)
  const other = security.createUser('asset_write_new_owner', 'Synthetic-new-owner-password').user
  db.$client.prepare('UPDATE dramas SET owner_user_id=? WHERE id=?').run(other.id, fixture.drama.id)
  gate.resolve()
  await Promise.all([first, rejected])
  assert.equal(count('scenes', fixture.drama.id), 0)
  const actor = security.createUser('asset_write_disabled', 'Synthetic-disabled-password').user
  const disabledFixture = project('Disabled while waiting', actor),
    disabledGate = deferred(),
    disabledEntered = deferred()
  const hold = security.secureAgentTools({
    hold: {
      id: 'save_dedup_props',
      execute: async () => {
        disabledEntered.resolve()
        await disabledGate.promise
      }
    }
  }).hold
  const held = security.runAsActor(actor, () =>
    hold.execute({}, options(disabledFixture.drama.id, disabledFixture.episodes[0].id, actor))
  )
  await disabledEntered.promise
  const queued = security.runAsActor(actor, () =>
    guarded.saveDedupProps.execute(
      { props: [{ name: 'Disabled must not save' }] },
      options(disabledFixture.drama.id, disabledFixture.episodes[1].id, actor)
    )
  )
  const denied = assert.rejects(queued, /用户已停用|请先登录/)
  security.updateUser(actor.id, { enabled: false })
  disabledGate.resolve()
  await Promise.all([held, denied])
  assert.equal(count('props', disabledFixture.drama.id), 0)
})

test('the scheduler itself is FIFO and does not keep a rejected writer as an occupied lane', async () => {
  const scheduler = new AssetWriteScheduler(),
    order: number[] = []
  const result = await Promise.allSettled([
    scheduler.run(1, 'characters', async () => {
      order.push(1)
      throw Error('failure')
    }),
    scheduler.run(1, 'characters', () => {
      order.push(2)
      return 'after'
    }),
    scheduler.run(1, 'characters', () => {
      order.push(3)
      return 'last'
    })
  ])
  assert.deepEqual(order, [1, 2, 3])
  assert.equal(result[0].status, 'rejected')
  assert.deepEqual(result[1], { status: 'fulfilled', value: 'after' })
})

test.after(async () => {
  db.$client.close()
  const relative = path.relative(os.tmpdir(), root)
  assert(
    relative &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      path.basename(root).startsWith('huobao-asset-writes-')
  )
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
