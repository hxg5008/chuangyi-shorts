/** Local, lossless document ingestion. It does not call an Agent or change any creative rule. */
import { createHash, randomUUID } from 'node:crypto'
import { db } from '../db/index.js'
import { assertProjectAccess, requireActor, type Actor } from './platform-security/index.js'

export type ImportKind = 'novel' | 'script'
export const IMPORT_MAX_BYTES = 6 * 1024 * 1024
export const IMPORT_MAX_SECTIONS = 1000
export const IMPORT_MAX_SECTION_CHARS = 200_000
export interface ImportSection {
  title: string; content: string; episode_number: number
  source_number: number | null; source_title: string; source_start: number; source_end: number
}
export interface ImportSourceInput { kind: ImportKind; filename?: string; text?: string; file_base64?: string; encoding?: string }
type ImportRow = { id: string; drama_id: number; owner_user_id: number; kind: ImportKind; filename: string; encoding: string; source_sha256: string; raw_bytes: Buffer; raw_text: string; sections_json: string; committed_hash: string | null; receipt_json: string | null; created_at: string; committed_at: string | null }
const sql = db.$client
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status })
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

export function initDocumentImports() {
  sql.exec(`CREATE TABLE IF NOT EXISTS platform_document_imports (
    id TEXT PRIMARY KEY, drama_id INTEGER NOT NULL, owner_user_id INTEGER NOT NULL,
    kind TEXT NOT NULL, filename TEXT NOT NULL, encoding TEXT NOT NULL, source_sha256 TEXT NOT NULL,
    raw_bytes BLOB NOT NULL, raw_text TEXT NOT NULL, sections_json TEXT NOT NULL,
    committed_hash TEXT, receipt_json TEXT, created_at TEXT NOT NULL, committed_at TEXT
  ); CREATE INDEX IF NOT EXISTS idx_document_import_project ON platform_document_imports(drama_id,created_at);
  CREATE TABLE IF NOT EXISTS platform_document_import_episodes (
    import_id TEXT NOT NULL, ordinal INTEGER NOT NULL, episode_id INTEGER NOT NULL,
    source_number INTEGER, source_title TEXT NOT NULL, source_start INTEGER NOT NULL, source_end INTEGER NOT NULL,
    target_number INTEGER NOT NULL, PRIMARY KEY(import_id,ordinal)
  );`)
}

/** Chinese counters are for labels only; no source numbering is silently rewritten. */
export function importHeadingNumber(value: string): number | null {
  if (/^\d+$/u.test(value)) { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? n : null }
  const digits: Record<string, number> = { 零:0, 〇:0, 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 }
  const units: Record<string, number> = { 十:10, 百:100, 千:1000, 万:10000 }
  if (![...value].every(char => char in digits || char in units)) return null
  if (![...value].some(char => char in units)) { const n = Number([...value].map(char => digits[char]).join('')); return n > 0 ? n : null }
  let total = 0, section = 0, digit = 0
  for (const char of value) {
    if (char in digits) digit = digits[char]
    else if (char === '万') { total += (section + digit || 1) * 10000; section = 0; digit = 0 }
    else { section += (digit || 1) * units[char]; digit = 0 }
  }
  const n = total + section + digit
  return n > 0 ? n : null
}

export function decodeImportBytes(bytes: Uint8Array, requested = 'auto'): { text: string; encoding: string } {
  if (!bytes.length || bytes.length > IMPORT_MAX_BYTES) throw fail('文件不能为空，最大支持 6 MB；请分卷导入。')
  const supported = ['auto', 'utf-8', 'utf-16le', 'utf-16be', 'gb18030']
  if (!supported.includes(requested.toLowerCase())) throw fail('请选择 UTF-8、UTF-16 或 GB18030 编码。')
  let encoding = requested.toLowerCase(), offset = 0
  if (encoding === 'auto') {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; offset = 2 }
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; offset = 2 }
    else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) { encoding = 'utf-8'; offset = 3 }
    else { try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); encoding = 'utf-8' } catch { encoding = 'gb18030' } }
  }
  let text: string
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset)) } catch { throw fail('无法按所选编码读取文本，请另选编码或导出为 UTF-8 TXT。') }
  if (!text.trim() || text.includes('\0')) throw fail('文件没有可用文本，或包含二进制空字符。请使用 TXT／MD 文件。')
  return { text, encoding }
}

/** Split only at chapter/episode headings, preserving all characters and all line endings. */
export function splitImportText(text: string, kind: ImportKind, startNumber = 1): ImportSection[] {
  if (!['novel', 'script'].includes(kind)) throw fail('请选择小说原文或已完成剧本。')
  const headings: Array<{ offset: number; title: string; number: number | null }> = []
  const counter = '[零〇一二两三四五六七八九十百千万0-9]+'
  const chinese = new RegExp('^\\s*(?:#{1,6}\\s*)?(?:\\*\\*)?第\\s*(' + counter + ')\\s*(' + (kind === 'novel' ? '章|回' : '集|话|話') + ')(.*)$', 'u')
  const english = kind === 'novel' ? /^\s*(?:#{1,6}\s*)?chapter\s+(\d+)\b(.*)$/iu : /^\s*(?:#{1,6}\s*)?(?:episode\s+|ep\.?\s*)(\d+)\b(.*)$/iu
  for (const line of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/gu)) {
    if (!line[0]) continue
    const clean = line[0].replace(/[\r\n]+$/u, '').replace(/^\uFEFF/u, '')
    const match = chinese.exec(clean) || english.exec(clean)
    if (match) headings.push({ offset: line.index!, title: clean.trim().replace(/^#{1,6}\s*/u, '').replace(/^\*\*|\*\*$/gu, ''), number: importHeadingNumber(match[1]) })
  }
  if (headings.length > IMPORT_MAX_SECTIONS) throw fail(`识别出 ${headings.length} 段，本次最多导入 ${IMPORT_MAX_SECTIONS} 段，请分卷处理。`)
  if (!headings.length) return [{ title: kind === 'novel' ? '未分章原文' : '未分集剧本', content: text, episode_number: startNumber, source_number: null, source_title: '', source_start: 0, source_end: text.length }]
  return headings.map((heading, i) => {
    const start = i === 0 ? 0 : heading.offset, end = headings[i + 1]?.offset ?? text.length
    return { title: heading.title, content: text.slice(start, end), episode_number: startNumber + i, source_number: heading.number, source_title: heading.title, source_start: start, source_end: end }
  })
}

export function importWarnings(sections: ImportSection[]) {
  const warnings: string[] = []
  if (sections.length === 1 && sections[0]?.source_number == null) warnings.push('没有识别到章节／集标题，已完整保留为一段；可在预览中手动拆分。')
  const seen = new Set<number>()
  for (const section of sections) {
    if (section.content.length > IMPORT_MAX_SECTION_CHARS) warnings.push(`“${section.title}”超过 ${IMPORT_MAX_SECTION_CHARS.toLocaleString()} 字符，请手动拆分后导入；原文未截断。`)
    if (section.source_number !== null && seen.has(section.source_number)) warnings.push(`原文序号 ${section.source_number} 重复，请核对目标集号。`)
    if (section.source_number !== null) seen.add(section.source_number)
  }
  return warnings
}

function ownedRow(projectId: number, id: string, actor: Actor) {
  assertProjectAccess(projectId, actor); initDocumentImports()
  const row = sql.prepare('SELECT * FROM platform_document_imports WHERE id=? AND drama_id=?').get(id, projectId) as ImportRow | undefined
  if (!row) throw fail('导入记录不存在或无权访问。', 404)
  return row
}
const nextEpisode = (projectId: number) => Number((sql.prepare('SELECT coalesce(max(episode_number),0)+1 n FROM episodes WHERE drama_id=? AND deleted_at IS NULL').get(projectId) as any).n)
const publicPreview = (row: ImportRow) => ({ id: row.id, kind: row.kind, filename: row.filename, encoding: row.encoding, source_sha256: row.source_sha256, source_characters: row.raw_text.length, source_bytes: row.raw_bytes.length, sections: JSON.parse(row.sections_json) as ImportSection[], committed: !!row.committed_at, receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null, created_at: row.created_at })
const previousImports = (projectId: number, sourceSha: string, kind: ImportKind) => sql.prepare('SELECT id,filename,committed_at FROM platform_document_imports WHERE drama_id=? AND source_sha256=? AND kind=? AND committed_at IS NOT NULL ORDER BY committed_at DESC LIMIT 10').all(projectId, sourceSha, kind)

export function previewDocumentImport(projectId: number, input: ImportSourceInput, actor = requireActor()) {
  assertProjectAccess(projectId, actor); initDocumentImports()
  if (!['novel', 'script'].includes(input.kind)) throw fail('请选择小说原文或已完成剧本。')
  if ((typeof input.text === 'string') === (typeof input.file_base64 === 'string')) throw fail('请上传一个文件，或粘贴文本，二者选一。')
  const filename = String(input.filename || '粘贴文本.txt').replace(/[\x00-\x1f\x7f]/gu, '').slice(0, 240)
  if (!/\.(?:txt|md)$/iu.test(filename)) throw fail('当前支持 TXT、MD 文件。')
  if (input.encoding !== undefined && typeof input.encoding !== 'string') throw fail('文件编码参数无效。')
  if (typeof input.file_base64 === 'string' && (!/^[A-Za-z0-9+/]*={0,2}$/u.test(input.file_base64) || input.file_base64.length % 4 !== 0 || input.file_base64.length > Math.ceil(IMPORT_MAX_BYTES / 3) * 4)) throw fail('文件编码无效或超过 6 MB。')
  const bytes = typeof input.text === 'string' ? Buffer.from(input.text, 'utf8') : Buffer.from(input.file_base64!, 'base64')
  if (typeof input.file_base64 === 'string' && bytes.toString('base64') !== input.file_base64) throw fail('文件编码不完整，请重新选择文件。')
  const decoded = decodeImportBytes(bytes, typeof input.text === 'string' ? 'utf-8' : input.encoding || 'auto')
  const sourceSha = hash(bytes)
  const same = sql.prepare('SELECT * FROM platform_document_imports WHERE drama_id=? AND owner_user_id=? AND source_sha256=? AND filename=? AND kind=? AND encoding=? AND committed_at IS NULL ORDER BY created_at DESC LIMIT 1').get(projectId, actor.id, sourceSha, filename, input.kind, decoded.encoding) as ImportRow | undefined
  if (same) { const value = publicPreview(same); return { ...value, warnings: importWarnings(value.sections), previous_imports: previousImports(projectId, sourceSha, input.kind), next_episode_number: nextEpisode(projectId) } }
  const sections = splitImportText(decoded.text, input.kind, nextEpisode(projectId)), id = randomUUID(), now = new Date().toISOString()
  sql.prepare('INSERT INTO platform_document_imports(id,drama_id,owner_user_id,kind,filename,encoding,source_sha256,raw_bytes,raw_text,sections_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, projectId, actor.id, input.kind, filename, decoded.encoding, sourceSha, bytes, decoded.text, JSON.stringify(sections), now)
  const result = publicPreview(ownedRow(projectId, id, actor))
  return { ...result, warnings: importWarnings(sections), previous_imports: previousImports(projectId, sourceSha, input.kind), next_episode_number: nextEpisode(projectId) }
}

export interface CommitDocumentInput { sections: ImportSection[]; image_config_id?: number | null; video_config_id?: number | null; resolution?: string; allow_duplicate_source?: boolean }
export function commitDocumentImport(projectId: number, id: string, input: CommitDocumentInput, actor = requireActor()) {
  const row = ownedRow(projectId, id, actor)
  if (input.resolution !== undefined && (typeof input.resolution !== 'string' || !/^[A-Za-z0-9_.-]{1,40}$/u.test(input.resolution))) throw fail('分辨率参数无效。')
  for (const value of [input.image_config_id, input.video_config_id]) if (value != null && (!Number.isSafeInteger(value) || value <= 0)) throw fail('模型配置编号无效。')
  if (!Array.isArray(input.sections) || !input.sections.length || input.sections.length > IMPORT_MAX_SECTIONS) throw fail('请保留 1～1000 个分段。')
  let totalBytes = 0
  const targetNumbers = new Set<number>()
  const sections = input.sections.map((section, i) => {
    if (!section || typeof section.title !== 'string' || !section.title.trim() || section.title.length > 200) throw fail(`第 ${i + 1} 段需要 1～200 字符的标题。`)
    if (typeof section.content !== 'string' || !section.content.trim() || section.content.includes('\0')) throw fail(`第 ${i + 1} 段正文为空或含空字符。`)
    if (section.content.length > IMPORT_MAX_SECTION_CHARS) throw fail(`第 ${i + 1} 段超过 200,000 字符，请先手动拆分；正文没有截断。`)
    if (!Number.isSafeInteger(section.episode_number) || section.episode_number <= 0 || section.episode_number > 1_000_000 || targetNumbers.has(section.episode_number)) throw fail(`第 ${i + 1} 段集号无效或重复。`)
    targetNumbers.add(section.episode_number); totalBytes += Buffer.byteLength(section.content, 'utf8')
    const start = Number.isSafeInteger(section.source_start) && section.source_start >= 0 && section.source_start <= row.raw_text.length ? section.source_start : 0
    const end = Number.isSafeInteger(section.source_end) && section.source_end >= start && section.source_end <= row.raw_text.length ? section.source_end : row.raw_text.length
    return { title: section.title.trim(), content: section.content, episode_number: section.episode_number, source_number: Number.isSafeInteger(section.source_number) && Number(section.source_number) > 0 ? Number(section.source_number) : null,
      source_title: String(section.source_title || '').slice(0, 240), source_start: start, source_end: end }
  })
  if (totalBytes > IMPORT_MAX_BYTES) throw fail('编辑后的正文总量超过 6 MB，请分卷导入。')
  const normalized = { sections, image_config_id: input.image_config_id || null, video_config_id: input.video_config_id || null, resolution: input.resolution || '720p', allow_duplicate_source: input.allow_duplicate_source === true }
  const commitHash = hash(JSON.stringify(normalized))
  return sql.transaction(() => {
    assertProjectAccess(projectId, actor)
    const latest = ownedRow(projectId, id, actor)
    if (latest.committed_at) {
      if (latest.committed_hash !== commitHash) throw fail('这份预览已经导入，内容已变化。请重新预览后再导入。', 409)
      return { ...JSON.parse(latest.receipt_json!), replayed: true }
    }
    if (!normalized.allow_duplicate_source && previousImports(projectId, row.source_sha256, row.kind).length) throw fail('这份原文已经导入过。请查看导入记录；确需重复新建剧集时，勾选重复导入确认。', 409)
    const existing = sql.prepare('SELECT episode_number FROM episodes WHERE drama_id=? AND deleted_at IS NULL').all(projectId) as Array<{ episode_number: number }>
    const conflict = existing.find(ep => targetNumbers.has(ep.episode_number))
    if (conflict) throw fail(`第 ${conflict.episode_number} 集已存在。没有写入任何剧集，请修改目标集号。`, 409)
    const now = new Date().toISOString(), created = []
    const insert = sql.prepare('INSERT INTO episodes(drama_id,episode_number,title,content,script_content,image_config_id,video_config_id,resolution,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    const link = sql.prepare('INSERT INTO platform_document_import_episodes(import_id,ordinal,episode_id,source_number,source_title,source_start,source_end,target_number) VALUES(?,?,?,?,?,?,?,?)')
    for (const [i, section] of sections.entries()) {
      const result = insert.run(projectId, section.episode_number, section.title, section.content, row.kind === 'script' ? section.content : null, normalized.image_config_id, normalized.video_config_id, normalized.resolution, 'draft', now, now)
      const episodeId = Number(result.lastInsertRowid)
      link.run(id, i + 1, episodeId, section.source_number, section.source_title, section.source_start, section.source_end, section.episode_number)
      created.push({ id: episodeId, episode_number: section.episode_number, title: section.title, source_number: section.source_number })
    }
    sql.prepare('UPDATE dramas SET total_episodes=(SELECT count(*) FROM episodes WHERE drama_id=? AND deleted_at IS NULL),updated_at=? WHERE id=?').run(projectId, now, projectId)
    const receipt = { import_id: id, kind: row.kind, created: created.length, episodes: created, source_sha256: row.source_sha256, models_submitted: 0, replayed: false }
    sql.prepare('UPDATE platform_document_imports SET committed_hash=?,receipt_json=?,committed_at=?,sections_json=? WHERE id=?').run(commitHash, JSON.stringify(receipt), now, JSON.stringify(sections), id)
    return receipt
  }).immediate()
}

export function listDocumentImports(projectId: number, actor = requireActor()) {
  assertProjectAccess(projectId, actor); initDocumentImports()
  return sql.prepare('SELECT id,kind,filename,encoding,source_sha256,length(raw_bytes) source_bytes,length(raw_text) source_characters,created_at,committed_at FROM platform_document_imports WHERE drama_id=? ORDER BY created_at DESC LIMIT 50').all(projectId)
}
export function getDocumentImportSource(projectId: number, id: string, actor = requireActor()) { const row = ownedRow(projectId, id, actor); return { filename: row.filename, bytes: row.raw_bytes, sha256: row.source_sha256 } }
