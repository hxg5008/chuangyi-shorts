import type Database from 'better-sqlite3'
import path from 'node:path'
import { STORAGE_ROOT } from '../utils/paths.js'
import { canonicalAssetImage, readAssetImage, statAssetImage } from './asset-image-files.js'
import { redactRuntimeSecrets as safeText } from '../utils/secret-redaction.js'

export type AssetImageType = 'character' | 'scene' | 'prop'
type Origin = 'generated' | 'uploaded' | 'legacy'
const tables = { character: 'characters', scene: 'scenes', prop: 'props' } as const
const taskColumns = { character: 'character_id', scene: 'scene_id', prop: 'prop_id' } as const
const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode })
const time = () => new Date().toISOString()
const positive = (value: number) => { if (!Number.isSafeInteger(value) || value < 1) throw fail('素材或图片版本编号不正确。'); return value }
function typeOf(value: string): AssetImageType {
  if (!Object.hasOwn(tables, value)) throw fail('图片历史仅支持角色、场景和道具。')
  return value as AssetImageType
}
function date(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}
const canonical = canonicalAssetImage
const identity = (value: unknown) => canonical(value) || (typeof value === 'string' ? value : '')
const currentImage = (asset: any) => typeof asset.image_url === 'string' && asset.image_url.trim() ? asset.image_url : asset.local_path
interface FileInfo { width: number; height: number; sha256: string; size: number; mtime: number }
interface VersionRow {
  id: number; asset_type: AssetImageType; asset_id: number; source_task_id: number | null
  path: string; created_at: string | null; recorded_at: string; width: number | null; height: number | null
  sha256: string | null; file_size: number | null; file_mtime: number | null
  source: Origin; prompt: string | null; references_json: string | null; deleted_at: string | null
}
export interface GeneratedAssetImageRecord {
  id: number; characterId?: number | null; sceneId?: number | null; propId?: number | null
  prompt?: string | null; params?: string | null; createdAt?: string | null; completedAt?: string | null
}
export interface AssetImageHistoryOptions { storageRoot?: string }

/** Historical files may be referenced by old videos/tasks. Deleting a version
 * removes that history entry only; it never unlinks shared/user-uploaded files. */
export class AssetImageHistoryService {
  readonly root: string
  constructor(readonly sqlite: Database.Database, options: AssetImageHistoryOptions = {}) {
    this.root = path.resolve(options.storageRoot || STORAGE_ROOT)
    sqlite.exec(`CREATE TABLE IF NOT EXISTS asset_image_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, asset_type TEXT NOT NULL, asset_id INTEGER NOT NULL,
      source_task_id INTEGER, path TEXT NOT NULL, created_at TEXT, recorded_at TEXT NOT NULL,
      width INTEGER, height INTEGER, sha256 TEXT, file_size INTEGER, file_mtime REAL,
      source TEXT NOT NULL, prompt TEXT, references_json TEXT, deleted_at TEXT,
      UNIQUE(asset_type,asset_id,path)
    );
       CREATE INDEX IF NOT EXISTS idx_asset_image_versions_asset ON asset_image_versions(asset_type,asset_id,id);`)
    // One paid task can legitimately return several pictures. The immutable
    // path identifies a version; task ID is provenance rather than uniqueness.
    const oldIndex = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_asset_image_versions_task'").get() as {sql:string}|undefined
    if (oldIndex?.sql && /CREATE\s+UNIQUE\s+INDEX/iu.test(oldIndex.sql)) sqlite.exec('DROP INDEX idx_asset_image_versions_task')
    sqlite.exec('CREATE INDEX IF NOT EXISTS idx_asset_image_versions_task ON asset_image_versions(asset_type,asset_id,source_task_id) WHERE source_task_id IS NOT NULL')
  }
  private asset(kind: string, id: number): any {
    const type = typeOf(kind); positive(id)
    const row = this.sqlite.prepare(`SELECT * FROM ${tables[type]} WHERE id=? AND deleted_at IS NULL`).get(id) as any
    if (!row) throw fail('素材不存在或已删除。', 404)
    return row
  }
  private async file(pathname: string, decode: boolean): Promise<{size:number;mtime:number} & Partial<FileInfo>> {
    if (!decode) return statAssetImage(pathname,this.root)
    const {dataUrl: _data, ...info} = await readAssetImage(pathname,this.root)
    return info
  }
  private referenceMetadata(raw?: string | null): string | null {
    let value: any; try { value = JSON.parse(raw || '{}') } catch { return null }
    const refs = Array.isArray(value.referenceImages) ? value.referenceImages : []
    const sources = Array.isArray(value.referenceImageSources) ? value.referenceImageSources : refs
    return JSON.stringify({count:refs.length,images:sources.slice(0,40).map((ref:unknown)=>canonical(ref)?'/'+canonical(ref):'[inline-image]'),sha256:Array.isArray(value.referenceImageHashes)?value.referenceImageHashes:[]})
  }
  private put(type: AssetImageType, id: number, imagePath: string, input: {
    source: Origin; sourceTaskId?: number | null; createdAt?: string | null; prompt?: string | null; params?: string | null; info?: Partial<FileInfo>
  }): VersionRow {
    const normalized = canonical(imagePath); if (!normalized) throw fail('图片必须是本项目的真实本地素材。')
    const info = input.info
    this.sqlite.prepare(`INSERT OR IGNORE INTO asset_image_versions
      (asset_type,asset_id,source_task_id,path,created_at,recorded_at,width,height,sha256,file_size,file_mtime,source,prompt,references_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(type,id,input.sourceTaskId ?? null,normalized,date(input.createdAt),time(),info?.width ?? null,info?.height ?? null,info?.sha256 ?? null,info?.size ?? null,info?.mtime ?? null,input.source,input.prompt == null ? null : safeText(input.prompt),this.referenceMetadata(input.params))
    let row = this.sqlite.prepare('SELECT * FROM asset_image_versions WHERE asset_type=? AND asset_id=? AND path=?').get(type,id,normalized) as VersionRow | undefined
    if (!row) throw fail('图片历史保存失败，请刷新后重试。',500)
    // Old records can gain genuine task/file metadata, but deletion tombstones
    // and already-known generation provenance are never overwritten.
    if (!row.deleted_at && (row.source === 'legacy' && input.source === 'generated' || !row.sha256 && info?.sha256)) {
      this.sqlite.prepare(`UPDATE asset_image_versions SET source_task_id=COALESCE(source_task_id,?),created_at=COALESCE(created_at,?),
        width=COALESCE(width,?),height=COALESCE(height,?),sha256=COALESCE(sha256,?),file_size=COALESCE(file_size,?),file_mtime=COALESCE(file_mtime,?),
        source=CASE WHEN source='legacy' AND ?='generated' THEN 'generated' ELSE source END,prompt=COALESCE(prompt,?),references_json=COALESCE(references_json,?) WHERE id=?`)
        .run(input.sourceTaskId ?? null,date(input.createdAt),info?.width ?? null,info?.height ?? null,info?.sha256 ?? null,info?.size ?? null,info?.mtime ?? null,input.source,input.prompt == null ? null : safeText(input.prompt),this.referenceMetadata(input.params),row.id)
      row = this.sqlite.prepare('SELECT * FROM asset_image_versions WHERE id=?').get(row.id) as VersionRow
    }
    return row
  }
  async backfill(kind: string, id: number) {
    const type = typeOf(kind), asset = this.asset(type,id)
    const tasks = this.sqlite.prepare(`SELECT * FROM sys_task WHERE type='image' AND status IN ('completed','failed') AND ${taskColumns[type]}=? ORDER BY id ASC`).all(id) as any[]
    for (const task of tasks) {
      for (const imagePath of this.taskPaths(task.local_path,task.params)) {
        const known = this.sqlite.prepare('SELECT id,deleted_at,sha256,source FROM asset_image_versions WHERE asset_type=? AND asset_id=? AND path=?').get(type,id,imagePath) as any
        if (known?.deleted_at || known?.sha256 && known.source === 'generated') continue
        let info: Partial<FileInfo> | undefined
        if (!known?.sha256) { try { info = await this.file(imagePath,true) } catch {} }
        if (task.status === 'failed' && !known && !info) continue
        this.put(type,id,imagePath,{source:'generated',sourceTaskId:task.id,createdAt:task.completed_at,prompt:task.prompt,params:task.params,info})
      }
    }
    const current = canonical(currentImage(asset))
    if (current && !this.sqlite.prepare('SELECT id FROM asset_image_versions WHERE asset_type=? AND asset_id=? AND path=?').get(type,id,current)) {
      let info: Partial<FileInfo> | undefined; try { info = await this.file(current,true) } catch {}
      // No generation time can be inferred from the asset update or file mtime.
      this.put(type,id,current,{source:'legacy',createdAt:null,info})
    }
  }
  private taskPaths(primary: string | null | undefined, raw: string | null | undefined) {
    let outputs: unknown[] = []
    try { const value = JSON.parse(raw || '{}'); if (Array.isArray(value.outputImages)) outputs = value.outputImages.map((row:any) => row?.local_path) } catch {}
    return [...new Set([primary,...outputs].map(canonical).filter((value):value is string=>!!value))]
  }
  async list(kind: string, id: number, limit = 200, beforeId?: number) {
    const type = typeOf(kind); await this.backfill(type,id)
    const asset = this.asset(type,id), current = canonical(currentImage(asset))
    const cap = Math.max(1,Math.min(500,Math.trunc(limit) || 200))
    const rows = this.sqlite.prepare(`SELECT * FROM asset_image_versions WHERE asset_type=? AND asset_id=? AND deleted_at IS NULL ${beforeId ? 'AND id<?' : ''} ORDER BY id DESC LIMIT ?`)
      .all(type,id,...(beforeId ? [positive(beforeId)] : []),cap + 1) as VersionRow[]
    const versions = []
    for (const row of rows.slice(0,cap)) {
      let missing = false, changed = false
      try { const file = await this.file(row.path,false); changed = row.file_size != null && (file.size !== row.file_size || file.mtime !== row.file_mtime) } catch { missing = true }
      versions.push({ id:row.id,image_url:'/' + row.path,created_at:row.created_at,width:row.width,height:row.height,is_current:row.path === current,source:row.source,missing,changed,task_id:row.source_task_id,has_prompt:Boolean(row.prompt) })
    }
    return { asset_type:type,asset_id:id,current_url:current ? '/' + current : currentImage(asset) || null,versions,has_more:rows.length > cap,next_before_id:rows.length > cap ? versions.at(-1)?.id || null : null,delete_file:false }
  }
  async detail(kind: string,id: number,versionId: number) {
    const type = typeOf(kind); await this.backfill(type,id)
    const row = this.version(type,id,versionId)
    return { id:row.id,prompt:row.prompt,reference_metadata:row.references_json ? JSON.parse(row.references_json) : null }
  }
  private version(type: AssetImageType,id: number,versionId: number): VersionRow {
    this.asset(type,id); positive(versionId)
    const row = this.sqlite.prepare('SELECT * FROM asset_image_versions WHERE id=? AND asset_type=? AND asset_id=? AND deleted_at IS NULL').get(versionId,type,id) as VersionRow | undefined
    if (!row) throw fail('历史图片不存在、已删除或不属于此素材。',404)
    return row
  }
  private updateCurrent(type: AssetImageType,id: number,pathname: string,onlyIfEmpty: boolean): boolean {
    const result = this.sqlite.prepare(`UPDATE ${tables[type]} SET image_url=?,local_path=?,updated_at=?${type === 'scene' ? ",status='completed'" : ''}
      WHERE id=? AND deleted_at IS NULL ${onlyIfEmpty ? "AND (image_url IS NULL OR trim(image_url)='') AND (local_path IS NULL OR trim(local_path)='')" : ''}`).run(pathname,pathname,time(),id)
    return result.changes > 0
  }
  async adopt(kind: string,id: number,versionId: number) {
    const type = typeOf(kind), expected = identity(currentImage(this.asset(type,id))); await this.backfill(type,id)
    const row = this.version(type,id,versionId)
    let actual: Partial<FileInfo>
    try { actual = await this.file(row.path,true) } catch { throw fail('历史图片文件缺失、不可读取或格式无效，不能采用。') }
    if (row.sha256 && row.sha256 !== actual.sha256) throw fail('历史图片已被外部替换，请重新上传；未采用不一致的文件。')
    if (!row.sha256) this.put(type,id,row.path,{source:row.source,sourceTaskId:row.source_task_id,createdAt:row.created_at,prompt:row.prompt,info:actual})
    this.sqlite.transaction(() => {
      this.version(type,id,versionId)
      const current = identity(currentImage(this.asset(type,id)))
      if (current !== expected && current !== row.path) throw fail('当前采用状态已变化，请刷新后重新选择；未覆盖较新的采用操作。',409)
      this.updateCurrent(type,id,row.path,false)
    })()
    return this.list(type,id)
  }
  async remove(kind: string,id: number,versionId: number) {
    const type = typeOf(kind); await this.backfill(type,id)
    this.sqlite.transaction(() => {
      const row = this.version(type,id,versionId), asset = this.asset(type,id)
      if (canonical(currentImage(asset)) === row.path) throw fail('当前采用的图片不能删除，请先采用另一张图片。',409)
      this.sqlite.prepare('UPDATE asset_image_versions SET deleted_at=? WHERE id=? AND deleted_at IS NULL').run(time(),row.id)
    })()
    return { ...await this.list(type,id),deleted:true,deleted_file:false }
  }
  async recordGenerated(record: GeneratedAssetImageRecord,localPath: string, options: {adopt?:boolean} = {}) {
    if (!record.characterId && !record.sceneId && !record.propId) return { versions:[],adopted:false }
    const imagePath = canonical(localPath); if (!imagePath) throw fail('生成图片路径不正确。')
    const task = Number.isSafeInteger(record.id) ? this.sqlite.prepare('SELECT * FROM sys_task WHERE id=? AND type=?').get(record.id,'image') as any : null
    const outputs = []
    for (const outputPath of this.taskPaths(imagePath,record.params)) outputs.push({path:outputPath,info:await this.file(outputPath,true)})
    const versions: Array<{asset_type:AssetImageType;asset_id:number;version_id:number;adopted:boolean}> = []
    for (const [type,assetId] of [['character',record.characterId],['scene',record.sceneId],['prop',record.propId]] as const) {
      if (!assetId) continue
      const asset = this.sqlite.prepare(`SELECT id FROM ${tables[type]} WHERE id=? AND deleted_at IS NULL`).get(assetId)
      if (!asset) continue
      try {
        await this.backfill(type,assetId)
        this.asset(type,assetId)
        for (const output of outputs) {
          const row = this.put(type,assetId,output.path,{source:'generated',sourceTaskId:record.id,createdAt:task?.completed_at || record.completedAt || time(),prompt:record.prompt,params:record.params,info:output.info})
          const adopted = this.sqlite.transaction(() => { this.asset(type,assetId); return options.adopt !== false && row.path === imagePath && !row.deleted_at && this.updateCurrent(type,assetId,imagePath,true) })()
          versions.push({asset_type:type,asset_id:assetId,version_id:row.id,adopted})
        }
      } catch (error: any) {
        // A paid image may finish after the user deleted its asset. Keep the
        // task result, but never recreate the asset or adopt into a tombstone.
        if (error.statusCode !== 404) throw error
      }
    }
    return { versions,adopted:versions.some(item=>item.adopted) }
  }
  async recordUploaded(kind: string,id: number,localPath: string,options: { createdAt?: string; adopt?: boolean; prompt?: string } = {}) {
    const type = typeOf(kind), imagePath = canonical(localPath)
    if (!imagePath) throw fail('上传图片路径不正确。')
    const expected = identity(currentImage(this.asset(type,id))); const info = await this.file(imagePath,true); await this.backfill(type,id)
    const row = this.put(type,id,imagePath,{source:'uploaded',createdAt:options.createdAt || time(),prompt:options.prompt,info})
    if (row.deleted_at) throw fail('此图片版本已从历史删除，请重新上传新图片。',409)
    if (options.adopt !== false) this.sqlite.transaction(()=>{
      const current = identity(currentImage(this.asset(type,id)))
      if (current !== expected && current !== imagePath) throw fail('当前采用状态已变化，上传图片已保留到历史，请刷新后手动采用。',409)
      this.updateCurrent(type,id,imagePath,false)
    })()
    return this.list(type,id)
  }
}
let service: AssetImageHistoryService | undefined
export async function getAssetImageHistoryService() {
  if (!service) service = new AssetImageHistoryService((await import('../db/index.js')).db.$client as any)
  return service
}
export async function recordGeneratedAssetImage(record: GeneratedAssetImageRecord,localPath: string,options?:{adopt?:boolean}) { return (await getAssetImageHistoryService()).recordGenerated(record,localPath,options) }
export async function recordUploadedAssetImage(type: AssetImageType,id: number,localPath: string,options?: {createdAt?:string;adopt?:boolean;prompt?:string}) { return (await getAssetImageHistoryService()).recordUploaded(type,id,localPath,options) }
