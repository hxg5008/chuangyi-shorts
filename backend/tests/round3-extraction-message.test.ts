import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Round 3 item 10: the character extraction request carries the clothing colour rule; scene and prop requests do not.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-round3-extract-message-'))
process.env.HUOBAO_DATA_DIR = temporary
process.env.SQLITE_PATH = path.join(temporary, 'test.sqlite3')
process.env.STORAGE_PATH = path.join(temporary, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.HUOBAO_PROXY_URL = 'direct'
const { db, schema } = await import('../src/db/index.ts')
const security = await import('../src/services/platform-security/index.ts')
security.initPlatformSecurity()
const owner = security.createUser('round3-extract-owner', 'synthetic-password').user
const at = new Date().toISOString()
const project = db.insert(schema.dramas).values({ title: 'Round 3 extraction', ownerUserId: owner.id, createdAt: at, updatedAt: at }).returning().get()
const episode = db.insert(schema.episodes).values({ dramaId: project.id, episodeNumber: 1, title: 'First', content: 'synthetic script', createdAt: at, updatedAt: at }).returning().get()
const { mastra } = await import('../src/mastra/index.ts')
const { startExtraction, getExtractionStatus } = await import('../src/services/extraction.ts')
const { STYLING_COLOR_EXTRACTION_NOTE, VOICE_CARD_EXTRACTION_NOTE } = await import('../src/services/character-voice-card.ts')
const original = mastra.getAgent
const captured: Record<string, string> = {}
let target = ''
;(mastra as any).getAgent = () => ({ id: 'extractor', stream: async (messages: any[]) => {
  captured[target] = messages.map(message => typeof message.content === 'string' ? message.content : '').join('\n')
  return { getFullOutput: async () => ({ text: 'ok', toolCalls: [], toolResults: [], steps: [] }) }
} })
after(() => { (mastra as any).getAgent = original; db.$client.close(); fs.rmSync(temporary, { recursive: true, force: true }) })

async function run(kind: 'characters' | 'scenes' | 'props') {
  target = kind
  assert.equal(security.runAsActor(owner, () => startExtraction(episode.id, project.id, kind)), true)
  for (let attempt = 0; attempt < 200; attempt++) {
    const current = getExtractionStatus(episode.id)[kind]
    if (current && current.status !== 'running') return current
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('extraction did not settle')
}

test('the character extraction message ends with the colour rule; the voice-card rule and the scene/prop messages are unchanged', async () => {
  assert.equal((await run('characters')).status, 'done')
  assert.ok(captured.characters.includes(VOICE_CARD_EXTRACTION_NOTE), 'voice-card rule still there')
  assert.ok(captured.characters.endsWith(STYLING_COLOR_EXTRACTION_NOTE), 'colour rule appended at the end')
  assert.ok(captured.characters.indexOf('save_dedup_characters') < captured.characters.indexOf(STYLING_COLOR_EXTRACTION_NOTE))
  assert.equal((await run('scenes')).status, 'done')
  assert.equal((await run('props')).status, 'done')
  assert.equal(captured.scenes.includes('妆造颜色'), false)
  assert.equal(captured.props.includes('妆造颜色'), false)
})
