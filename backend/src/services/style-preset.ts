/** Versioned aesthetic composition. Source extraction and creative Skills are not modified here. */
import { createHash } from 'node:crypto'
import catalogData from '../../resources/style-catalog.json' with { type: 'json' }
import { db } from '../db/index.js'
import { buildSceneImagePrompt } from './scene-image-contract.js'
import { currentActivity } from './activity/context.js'

export type StyleStage = 'asset_image' | 'storyboard' | 'video'
export interface StyleSnapshot {
  value: string; name: string; source: string; category: string; version: string
  template: string; prompt: string; stages: StyleStage[]; captured_at: string
  legacy_prefix?: boolean
}
export interface StyleAsset { kind: 'character' | 'scene' | 'prop'; id: number }
/** Undefined is a legacy receipt without provenance; null explicitly means no style. */
export function conflictingStyleSnapshots(left: StyleSnapshot | null | undefined, right: StyleSnapshot | null | undefined) {
  if (left === undefined || right === undefined) return false
  if (left === null || right === null) return left !== right
  return left.value !== right.value || left.version !== right.version
}
const sql = db.$client
const stages: StyleStage[] = ['asset_image', 'storyboard', 'video']
let ready = false
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const parse = (value: unknown, fallback: any = {}) => { try { return JSON.parse(String(value)) } catch { return fallback } }
const catalog = catalogData as { styles: any[] }
function metaVersion(value: any) { return hash(JSON.stringify([value.template, value.category, value.source, value.stages, value.legacy_prefix === true])).slice(0, 16) }
function legacyContent(prompt: string, snapshot: StyleSnapshot) {
  const prefix = snapshot.prompt
  return prefix && (prompt.startsWith(`${prefix}, `) || prompt.startsWith(`${prefix}，\n`)) ? prompt.slice(prefix.length + 2) : prompt
}
function captureExistingPrompts(dramaId: number, snapshot: StyleSnapshot) {
  const insert = sql.prepare('INSERT OR IGNORE INTO platform_asset_prompt_styles(kind,asset_id,raw_prompt,styled_prompt,snapshot_json) VALUES(?,?,?,?,?)')
  for (const [kind, table] of [['character', 'characters'], ['scene', 'scenes'], ['prop', 'props']]) {
    for (const row of sql.prepare(`SELECT id,final_prompt FROM ${table} WHERE drama_id=? AND final_prompt IS NOT NULL AND final_prompt<>''`).all(dramaId) as any[]) {
      insert.run(kind, row.id, legacyContent(row.final_prompt, snapshot), row.final_prompt, JSON.stringify(snapshot))
    }
  }
}

/** Additive, idempotent local migration. Imported rows are seeded once, never overwrite administrator edits. */
export function initStyleCatalog() {
  if (ready) return
  sql.exec(`CREATE TABLE IF NOT EXISTS platform_style_metadata(value TEXT PRIMARY KEY, metadata_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS platform_project_styles(drama_id INTEGER PRIMARY KEY, style_value TEXT NOT NULL, snapshot_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS platform_style_task_snapshots(task_id TEXT PRIMARY KEY, snapshot_json TEXT);
    CREATE TABLE IF NOT EXISTS platform_asset_prompt_styles(kind TEXT NOT NULL, asset_id INTEGER NOT NULL, raw_prompt TEXT NOT NULL, styled_prompt TEXT NOT NULL, snapshot_json TEXT, PRIMARY KEY(kind,asset_id));`)
  const seeded = sql.prepare('SELECT value FROM platform_style_metadata WHERE value=?')
  const existingPreset = sql.prepare('SELECT prompt FROM style_presets WHERE value=?')
  const insert = sql.prepare('INSERT OR IGNORE INTO style_presets(name,value,prompt,description,sort_order,is_active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)')
  const meta = sql.prepare('INSERT INTO platform_style_metadata(value,metadata_json) VALUES(?,?)')
  const at = new Date().toISOString()
  sql.transaction(() => { for (const row of catalog.styles) {
    if (seeded.get(row.value)) continue
    const existing = existingPreset.get(row.value) as { prompt: string } | undefined
    insert.run(row.name, row.value, row.prompt, row.description, row.sort_order, at, at)
    const data = existing
      ? { source: 'custom', category: 'other', template: `${existing.prompt}, {content}`, legacy_prefix: true, cover: '', tags: [], hot: false, palette: row.palette, stages }
      : { source: row.source, category: row.category, template: row.template, cover: row.cover, tags: row.tags, hot: row.hot || false, palette: row.palette, stages }
    meta.run(row.value, JSON.stringify({ ...data, version: metaVersion(data) }))
  } })()
  ready = true
}

export function styleMetadata(value: string, prompt = '') {
  initStyleCatalog()
  const row = sql.prepare('SELECT metadata_json FROM platform_style_metadata WHERE value=?').get(value) as any
  const originals: Record<string,string> = { '3d': '3d', anime: '2d', ghibli: '2d', watercolor: 'art', comic: '2d', guofeng: '2d', webtoon: '2d', noir: '2d' }
  return row ? parse(row.metadata_json) : { source: originals[value] ? 'original' : 'custom', category: originals[value] || 'other', template: prompt ? `${prompt}, {content}` : '{content}', legacy_prefix: true, stages, version: hash(prompt).slice(0, 16), cover: '', tags: [] }
}
export function saveStyleMetadata(value: string, body: Record<string, any>, prompt: string) {
  initStyleCatalog()
  const old = styleMetadata(value, prompt)
  const preset = sql.prepare('SELECT prompt FROM style_presets WHERE value=?').get(value) as { prompt: string } | undefined
  const legacyTemplate = preset ? `${preset.prompt}, {content}` : null
  // Old clients updating the context field must not silently discard an imported suffix.
  const template = body.template === undefined
    ? (body.prompt !== undefined && (!preset || old.template === legacyTemplate) ? `${prompt}, {content}` : old.template)
    : String(body.template)
  if ((template.match(/\{content\}/gu) || []).length !== 1 || template.length > 100_000) throw new Error('风格模板必须且只能包含一个 {content}，长度不得超过 100000 字符。')
  const category = body.category ?? old.category
  if (!['live', '2d', '3d', 'art', 'other'].includes(category)) throw new Error('风格分类无效。')
  const enabledStages = body.stages ?? old.stages ?? stages
  if (!Array.isArray(enabledStages) || enabledStages.some(item => !stages.includes(item))) throw new Error('风格适用步骤无效。')
  const data = { ...old, category, template, legacy_prefix: body.template === undefined && old.legacy_prefix === true, stages: [...new Set(enabledStages)], source: old.source === 'original' ? 'custom' : old.source,
    ...(body.cover !== undefined ? { cover: /^\/style-covers\/[a-zA-Z0-9._-]+$/u.test(String(body.cover)) ? body.cover : '' } : {}) }
  data.version = metaVersion(data)
  sql.prepare('INSERT INTO platform_style_metadata(value,metadata_json) VALUES(?,?) ON CONFLICT(value) DO UPDATE SET metadata_json=excluded.metadata_json').run(value, JSON.stringify(data))
  return data
}

/** Project selection is frozen independently of later edits, disable or deletion of the catalog row. */
export function getDramaStyleSnapshot(dramaId: number | null | undefined, refresh = false): StyleSnapshot | null {
  if (!dramaId) return null
  initStyleCatalog()
  const internal = currentActivity()
  if (!refresh && internal?.projectId === dramaId && Object.hasOwn(internal, 'styleSnapshot')) return internal.styleSnapshot || null
  const drama = sql.prepare('SELECT style FROM dramas WHERE id=? AND deleted_at IS NULL').get(dramaId) as any
  if (!drama?.style) return null
  const saved = sql.prepare('SELECT style_value,snapshot_json FROM platform_project_styles WHERE drama_id=?').get(dramaId) as any
  if (!refresh && saved?.style_value === drama.style) return parse(saved.snapshot_json, null)
  const preset = sql.prepare('SELECT value,name,prompt,is_active FROM style_presets WHERE value=?').get(drama.style) as any
  if (!preset?.is_active) return null
  const meta = styleMetadata(preset.value, preset.prompt)
  const snapshot: StyleSnapshot = { value: preset.value, name: preset.name, source: meta.source, category: meta.category, version: meta.version,
    template: meta.template, prompt: preset.prompt, legacy_prefix: meta.legacy_prefix === true, stages: meta.stages || stages, captured_at: new Date().toISOString() }
  sql.prepare('INSERT INTO platform_project_styles(drama_id,style_value,snapshot_json) VALUES(?,?,?) ON CONFLICT(drama_id) DO UPDATE SET style_value=excluded.style_value,snapshot_json=excluded.snapshot_json').run(dramaId, preset.value, JSON.stringify(snapshot))
  if (!saved) captureExistingPrompts(dramaId, snapshot)
  return snapshot
}

export function composeStylePrompt(content: string, snapshot: StyleSnapshot | null, stage: StyleStage): string {
  if (!snapshot || !snapshot.stages.includes(stage)) return content
  // Before full templates existed, video submissions used a Chinese comma + newline;
  // image submissions used an English comma. Preserve those original wire payloads.
  if (stage === 'video' && snapshot.legacy_prefix && snapshot.template === `${snapshot.prompt}, {content}`) {
    const prefix = `${snapshot.prompt}，\n`
    return content.startsWith(prefix) ? content : prefix + legacyContent(content, snapshot)
  }
  const [before, after] = snapshot.template.split('{content}')
  // Complete templates and the old prefix-composed cache are recognized only at exact boundaries.
  if ((!before || content.startsWith(before)) && (!after || content.endsWith(after))) return content
  return before + legacyContent(content, snapshot) + after
}

/** Shared actual submission hook; the returned snapshot belongs in sys_task.params. */
export async function composeProjectStyle(dramaId: number | null | undefined, prompt: string, stage: StyleStage, asset?: StyleAsset) {
  const snapshot = getDramaStyleSnapshot(dramaId)
  const sceneContract = asset?.kind === 'scene' ? buildSceneImagePrompt('') : ''
  const withoutContract = (text: string) => sceneContract && text.trimEnd().endsWith(sceneContract) ? text.trimEnd().slice(0, -sceneContract.length).trimEnd() : text
  let raw = asset?.kind === 'scene' ? withoutContract(prompt).trim() : prompt
  if (asset && dramaId) {
    const saved = sql.prepare('SELECT raw_prompt,styled_prompt,snapshot_json FROM platform_asset_prompt_styles WHERE kind=? AND asset_id=?').get(asset.kind, asset.id) as any
    const styledPrompt = saved ? asset.kind === 'scene' ? withoutContract(saved.styled_prompt).trim() : saved.styled_prompt : ''
    if (saved && (raw === styledPrompt || raw.startsWith(styledPrompt + '\n\n'))) raw = withoutContract(saved.raw_prompt) + raw.slice(styledPrompt.length)
  }
  return { prompt: composeStylePrompt(raw, snapshot, stage), snapshot }
}

/** Called solely at the existing prompt-tool style injection point, leaving its Schema and instructions intact. */
export async function composeAssetStylePrompt(dramaId: number, kind: StyleAsset['kind'], assetId: number, prompt: string) {
  const snapshot = getDramaStyleSnapshot(dramaId), styled = composeStylePrompt(prompt, snapshot, 'asset_image')
  sql.prepare('INSERT INTO platform_asset_prompt_styles(kind,asset_id,raw_prompt,styled_prompt,snapshot_json) VALUES(?,?,?,?,?) ON CONFLICT(kind,asset_id) DO UPDATE SET raw_prompt=excluded.raw_prompt,styled_prompt=excluded.styled_prompt,snapshot_json=excluded.snapshot_json')
    .run(kind, assetId, prompt, styled, snapshot ? JSON.stringify(snapshot) : null)
  return styled
}

export function styleContext(snapshot: StyleSnapshot | null): string {
  if (!snapshot || !snapshot.stages.includes('storyboard')) return ''
  if (snapshot.template === `${snapshot.prompt}, {content}`) return snapshot.prompt
  return snapshot.template.split('{content}').map(part => part.trim()).filter(Boolean).join('\n')
}
export function recordStyleTaskSnapshot(taskId: string, snapshot: StyleSnapshot | null) {
  initStyleCatalog()
  sql.prepare('INSERT OR IGNORE INTO platform_style_task_snapshots(task_id,snapshot_json) VALUES(?,?)').run(taskId, snapshot ? JSON.stringify(snapshot) : null)
}
export function recordedStyleTaskSnapshot(taskId: string): StyleSnapshot | null | undefined {
  initStyleCatalog()
  const row = sql.prepare('SELECT snapshot_json FROM platform_style_task_snapshots WHERE task_id=?').get(taskId) as { snapshot_json: string | null } | undefined
  return row ? row.snapshot_json ? parse(row.snapshot_json, null) : null : undefined
}

/** Existing storyboard loader gets aesthetic context, never a literal content placeholder or source-extraction rule. */
export async function getDramaStylePrompt(dramaId: number | null | undefined, stage: StyleStage = 'storyboard'): Promise<string> {
  const snapshot = getDramaStyleSnapshot(dramaId)
  if (!snapshot || !snapshot.stages.includes(stage)) return ''
  return stage === 'storyboard' ? styleContext(snapshot) : snapshot.prompt
}
