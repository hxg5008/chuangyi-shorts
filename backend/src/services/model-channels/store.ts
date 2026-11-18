import fs from 'node:fs'
import path from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { ServiceType } from '../ai.js'
import { db } from '../../db/index.js'
import { DATA_ROOT } from '../../utils/paths.js'
import { registerRuntimeSecrets } from '../../utils/secret-redaction.js'
import { protocolParameters } from './parameters.js'
import {
  BUILTIN_PROTOCOLS,
  builtinProtocol,
  validateJsonProtocol,
  assertPublicParameterTree,
  type ProtocolRecord
} from './protocols.js'

const now = () => new Date().toISOString()
const object = (v: unknown): Record<string, any> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {}
const parse = (v: string | null, fallback: any = {}) => {
  try {
    return JSON.parse(v || 'null') ?? fallback
  } catch {
    return fallback
  }
}
const number = (v: unknown, label: string) => {
  if (!Number.isSafeInteger(v) || Number(v) < 1) throw new Error(`${label}不正确`)
  return Number(v)
}
const text = (v: unknown, label: string, max = 200) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\x00-\x1f]/u.test(v))
    throw new Error(`${label}不能为空或超过${max}字符`)
  return v.trim()
}
export function channelUrl(value: unknown) {
  const raw = text(value, '渠道 URL', 2000),
    u = new URL(raw)
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash || u.search)
    throw new Error('渠道地址须为无登录信息和查询参数的 HTTP(S) 地址')
  return raw.replace(/\/+$/u, '')
}
const blockedHeaders = new Set([
  'host',
  'cookie',
  'set-cookie',
  'content-length',
  'content-type',
  'connection',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization'
])
function headersOf(raw: unknown) {
  const headers = object(raw)
  if (Object.keys(headers).length > 30) throw new Error('自定义请求头过多')
  for (const [k, v] of Object.entries(headers))
    if (
      !/^[A-Za-z][A-Za-z0-9-]{0,99}$/u.test(k) ||
      blockedHeaders.has(k.toLowerCase()) ||
      typeof v !== 'string' ||
      /[\r\n\x00]/u.test(v) ||
      v.length > 8192
    )
      throw new Error('自定义请求头不正确；Host、Cookie、内容格式与传输头由服务管理')
  return headers as Record<string, string>
}

function capabilitiesOf(raw: unknown) {
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw)))
    throw new Error('模型能力必须为 JSON 对象')
  const value = object(raw)
  assertPublicParameterTree(value)
  for (const key of [
    'reference_images',
    'reference_video',
    'reference_audio',
    'tools',
    'structured_output',
    'stream'
  ])
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error(`${key} 必须为布尔值`)
  for (const key of ['max_images', 'max_videos', 'max_audios', 'max_concurrency']) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 100))
      throw new Error(`${key} 必须为0–100的整数`)
  }
  for (const key of ['min_duration', 'max_duration']) {
    if (
      value[key] !== undefined &&
      (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > 3600)
    )
      throw new Error(`${key} 必须为1–3600的整数`)
  }
  if (
    value.min_duration !== undefined &&
    value.max_duration !== undefined &&
    value.min_duration > value.max_duration
  )
    throw new Error('最短时长不能大于最长时长')
  for (const key of ['resolutions', 'aspect_ratios', 'sizes', 'reasoning_efforts']) {
    if (
      value[key] !== undefined &&
      (!Array.isArray(value[key]) ||
        value[key].length > 60 ||
        value[key].some((x: unknown) => typeof x !== 'string' || !x || x.length > 80))
    )
      throw new Error(`${key} 必须为有限的字符串数组`)
  }
  if (
    value.durations !== undefined &&
    (!Array.isArray(value.durations) ||
      value.durations.length > 60 ||
      value.durations.some((x: unknown) => !Number.isSafeInteger(x) || Number(x) < 1 || Number(x) > 3600))
  )
    throw new Error('durations 必须为有效的整数秒数组')
  return value
}

export interface ChannelRow {
  id: number
  name: string
  base_url: string
  secret_blob: string
  enabled: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}
export interface Binding {
  id: number
  config_id: number
  channel_id: number
  name: string
  model: string
  type: string
  protocol_id: string
  capabilities: Record<string, any>
  defaults: Record<string, any>
  enabled: boolean
  access: 'all' | 'selected'
  allowed_user_ids: number[]
  priority: number
  is_default: boolean
  deleted_at: string | null
}
export interface ResolvedBinding {
  id: number
  serviceType: ServiceType
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  bindingId: number
  channelId: number
  channelName: string
  protocolId: string
  protocolVersion: number
  protocolDefinition?: any
  capabilities: Record<string, any>
  defaults: Record<string, any>
  headers: Record<string, string>
  authFields?: Record<string, string>
  parameters?: import('./protocols.js').ModelParameter[]
}

export class ModelChannelStore {
  private key: Buffer
  constructor(
    readonly sqlite: Database.Database,
    readonly dataRoot: string
  ) {
    fs.mkdirSync(dataRoot, { recursive: true })
    const file = path.join(dataRoot, 'model-channel-secret.key')
    try {
      fs.writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 })
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e
    }
    this.key = fs.readFileSync(file)
    if (this.key.length !== 32) throw new Error('模型渠道加密密钥格式错误，未覆盖原密钥')
    sqlite.exec(`CREATE TABLE IF NOT EXISTS platform_model_channels(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,base_url TEXT NOT NULL,secret_blob TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,deleted_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS platform_channel_models(id INTEGER PRIMARY KEY AUTOINCREMENT,channel_id INTEGER NOT NULL,config_id INTEGER NOT NULL UNIQUE,name TEXT NOT NULL,model TEXT NOT NULL,type TEXT NOT NULL,protocol_id TEXT NOT NULL,capabilities_json TEXT NOT NULL DEFAULT '{}',defaults_json TEXT NOT NULL DEFAULT '{}',enabled INTEGER NOT NULL DEFAULT 1,access_mode TEXT NOT NULL DEFAULT 'all',allowed_user_ids_json TEXT NOT NULL DEFAULT '[]',priority INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS platform_channel_models_channel ON platform_channel_models(channel_id);
      CREATE TABLE IF NOT EXISTS platform_model_protocols(id TEXT PRIMARY KEY,name TEXT NOT NULL,type TEXT NOT NULL,provider TEXT NOT NULL,custom INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,capabilities_json TEXT NOT NULL DEFAULT '{}',definition_json TEXT);`)
    if (!(sqlite.prepare('PRAGMA table_info(ai_service_configs)').all() as any[]).some(column => column.name === 'is_default'))
      sqlite.exec('ALTER TABLE ai_service_configs ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0')
    if (
      !(sqlite.prepare('PRAGMA table_info(platform_channel_models)').all() as any[]).some(
        (column) => column.name === 'deleted_at'
      )
    )
      sqlite.exec('ALTER TABLE platform_channel_models ADD COLUMN deleted_at TEXT')
    // Old channel deletions remain deleted when the binding tombstone column is introduced.
    sqlite.exec(
      'UPDATE platform_channel_models SET deleted_at=(SELECT c.deleted_at FROM platform_model_channels c WHERE c.id=platform_channel_models.channel_id),enabled=0 WHERE deleted_at IS NULL AND channel_id IN(SELECT id FROM platform_model_channels WHERE deleted_at IS NOT NULL)'
    )
    if (
      !(sqlite.prepare('PRAGMA table_info(platform_model_protocols)').all() as any[]).some(
        (column) => column.name === 'metadata_json'
      )
    )
      sqlite.exec("ALTER TABLE platform_model_protocols ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'")
    sqlite.exec(
      'CREATE TABLE IF NOT EXISTS platform_model_protocol_versions(protocol_id TEXT NOT NULL,version INTEGER NOT NULL,definition_json TEXT NOT NULL,metadata_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(protocol_id,version))'
    )
    const insert = sqlite.prepare(
      'INSERT OR IGNORE INTO platform_model_protocols(id,name,type,provider,custom,version,capabilities_json,definition_json) VALUES(?,?,?,?,?,?,?,?)'
    )
    for (const p of BUILTIN_PROTOCOLS)
      insert.run(p.id, p.name, p.type, p.provider, 0, p.version, JSON.stringify(p.capabilities), null)
    // v1 advertised a local eight-image guard. Upgrade only that built-in
    // default, leaving custom protocols and explicitly lower limits intact.
    const native = sqlite.prepare('SELECT * FROM platform_model_protocols WHERE id=?').get('video.jimeng-local') as any
    if (native && !native.custom && native.version < 2) {
      sqlite.transaction(() => {
        const caps = parse(native.capabilities_json, {})
        if (caps.max_images === 8) caps.max_images = 9
        sqlite.prepare('UPDATE platform_model_protocols SET version=2,capabilities_json=? WHERE id=?').run(JSON.stringify(caps), native.id)
        for (const row of sqlite.prepare('SELECT id,capabilities_json FROM platform_channel_models WHERE protocol_id=?').all(native.id) as any[]) {
          const saved = parse(row.capabilities_json, {})
          if (saved.max_images === 8) sqlite.prepare('UPDATE platform_channel_models SET capabilities_json=? WHERE id=?').run(JSON.stringify({ ...saved, max_images: 9 }), row.id)
        }
      })()
    }
    this.migrateLegacy()
  }
  private seal(secret: {
    apiKey: string
    headers: Record<string, string>
    authFields?: Record<string, string>
  }) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv),
      bytes = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()])
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      bytes.toString('base64url')
    ].join('.')
  }
  private unseal(value: string): {
    apiKey: string
    headers: Record<string, string>
    authFields?: Record<string, string>
  } {
    const [v, iv, tag, bytes] = value.split('.')
    if (v !== 'v1' || !iv || !tag || !bytes) throw new Error('渠道密钥数据损坏')
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    const secret = JSON.parse(
      Buffer.concat([decipher.update(Buffer.from(bytes, 'base64url')), decipher.final()]).toString('utf8')
    )
    secret.authFields ||= {}
    registerRuntimeSecrets([
      secret.apiKey,
      ...Object.values(secret.headers || {}),
      ...Object.values(secret.authFields)
    ])
    return secret
  }
  private protocolRow(r: any): ProtocolRecord {
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      provider: r.provider,
      custom: !!r.custom,
      version: r.version,
      capabilities: parse(r.capabilities_json),
      ...(r.definition_json ? { definition: parse(r.definition_json) } : {}),
      ...parse(r.metadata_json)
    }
  }
  protocols(): ProtocolRecord[] {
    return this.sqlite
      .prepare('SELECT * FROM platform_model_protocols ORDER BY custom,id')
      .all()
      .map((row: any) => this.protocolRow(row))
  }
  protocol(id: string) {
    const row = this.sqlite.prepare('SELECT * FROM platform_model_protocols WHERE id=?').get(id)
    return row ? this.protocolRow(row) : null
  }
  saveEngineProtocol(record: ProtocolRecord) {
    if (record.definition?.engine !== 'yingce-v2' || !record.id.startsWith('engine.'))
      throw new Error('需要经过运行时编译的v2协议')
    const old = this.protocol(record.id),
      definition = JSON.stringify(record.definition)
    if (
      old &&
      old.type !== record.type &&
      this.bindings().some((binding) => binding.protocol_id === record.id)
    )
      throw new Error('已绑定模型的provider不能改变能力类型')
    const { definition: _, version: __, ...metadata } = record
    const encoded = JSON.stringify(metadata)
    const previous = this.sqlite
      .prepare('SELECT definition_json,metadata_json FROM platform_model_protocols WHERE id=?')
      .get(record.id) as any
    if (old && previous?.definition_json === definition && previous?.metadata_json === encoded) return old
    const version = (old?.version || 0) + 1
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          'INSERT INTO platform_model_protocols(id,name,type,provider,custom,version,capabilities_json,definition_json,metadata_json)VALUES(?,?,?,?,1,?,?,?,?) ON CONFLICT(id)DO UPDATE SET name=excluded.name,type=excluded.type,provider=excluded.provider,version=excluded.version,capabilities_json=excluded.capabilities_json,definition_json=excluded.definition_json,metadata_json=excluded.metadata_json'
        )
        .run(
          record.id,
          record.name,
          record.type,
          'yingce',
          version,
          JSON.stringify(record.capabilities),
          definition,
          encoded
        )
      this.sqlite
        .prepare(
          'INSERT INTO platform_model_protocol_versions(protocol_id,version,definition_json,metadata_json,created_at)VALUES(?,?,?,?,?)'
        )
        .run(record.id, version, definition, encoded, now())
    })()
    return this.protocol(record.id)!
  }
  saveProtocol(input: any) {
    const id = text(input.id, '协议 ID', 100)
    if (!/^custom\.[A-Za-z0-9._-]+$/u.test(id)) throw new Error('自定义协议 ID 必须以 custom. 开头')
    const definition = validateJsonProtocol(input.definition)
    const old = this.protocol(id)
    if (old && !old.custom) throw new Error('内置协议不能覆盖')
    if (old && old.type !== definition.type && this.bindings().some((binding) => binding.protocol_id === id))
      throw new Error('已被模型引用的协议不能更换类型，请建立新协议')
    const version = (old?.version || 0) + 1
    this.sqlite
      .prepare(
        'INSERT INTO platform_model_protocols(id,name,type,provider,custom,version,capabilities_json,definition_json) VALUES(?,?,?,?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,version=excluded.version,capabilities_json=excluded.capabilities_json,definition_json=excluded.definition_json'
      )
      .run(
        id,
        text(input.name, '协议名称'),
        definition.type,
        'custom_json',
        version,
        JSON.stringify(capabilitiesOf(input.capabilities)),
        JSON.stringify(definition)
      )
    return this.protocol(id)!
  }
  private channel(id: number, includeDeleted = false) {
    return this.sqlite
      .prepare(
        `SELECT * FROM platform_model_channels WHERE id=?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`
      )
      .get(id) as ChannelRow | undefined
  }
  channelConnection(id: number) {
    const c = this.channel(id)
    if (!c) throw new Error('渠道不存在')
    return {
      id: c.id,
      name: c.name,
      baseUrl: c.base_url,
      enabled: !!c.enabled,
      ...this.unseal(c.secret_blob)
    }
  }
  listChannels() {
    this.migrateLegacy()
    return (
      this.sqlite
        .prepare('SELECT * FROM platform_model_channels WHERE deleted_at IS NULL ORDER BY id')
        .all() as ChannelRow[]
    ).map((c) => {
      const secret = this.unseal(c.secret_blob)
      return {
        id: c.id,
        name: c.name,
        base_url: c.base_url,
        enabled: !!c.enabled,
        has_key: !!secret.apiKey || !!secret.authFields?.apiKey,
        header_names: Object.keys(secret.headers),
        has_auth_fields: Object.keys(secret.authFields || {}).filter((name) => !!secret.authFields?.[name]),
        created_at: c.created_at,
        updated_at: c.updated_at,
        models: this.bindings(c.id)
      }
    })
  }
  saveChannel(input: any, id?: number) {
    const old = id ? this.channel(number(id, '渠道编号')) : undefined
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean')
      throw new Error('enabled 必须为布尔值')
    if (id && !old) throw new Error('渠道不存在')
    const previous = old ? this.unseal(old.secret_blob) : { apiKey: '', headers: {}, authFields: {} }
    const key =
      input.clear_api_key === true
        ? ''
        : typeof input.api_key === 'string' && input.api_key !== ''
          ? input.api_key
          : previous.apiKey
    if (typeof key !== 'string' || key.length > 8192 || /[\r\n\x00]/u.test(key))
      throw new Error('API Key 格式错误')
    const headers = input.headers === undefined ? previous.headers : headersOf(input.headers)
    const authFields: Record<string, string> = { ...previous.authFields }
    if (input.auth_fields !== undefined) {
      if (
        !input.auth_fields ||
        typeof input.auth_fields !== 'object' ||
        Array.isArray(input.auth_fields) ||
        Object.keys(input.auth_fields).length > 50
      )
        throw new Error('鉴权字段必须为有限JSON对象')
      for (const [field, value] of Object.entries(input.auth_fields)) {
        if (
          !/^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/u.test(field) ||
          ['__proto__', 'prototype', 'constructor'].includes(field) ||
          typeof value !== 'string' ||
          value.length > 8192 ||
          /[\r\n\x00]/u.test(value)
        )
          throw new Error('鉴权字段格式错误')
        if (value !== '') authFields[field] = value
      }
    }
    if (input.clear_auth_fields !== undefined) {
      if (
        !Array.isArray(input.clear_auth_fields) ||
        input.clear_auth_fields.some((key: unknown) => typeof key !== 'string')
      )
        throw new Error('清除鉴权字段必须为字符串数组')
      for (const field of input.clear_auth_fields) delete authFields[field]
    }
    const name = text(input.name ?? old?.name, '渠道名称'),
      url = channelUrl(input.base_url ?? old?.base_url),
      enabled = input.enabled === undefined ? (old?.enabled ?? 1) : input.enabled ? 1 : 0,
      at = now()
    if (old) {
      this.sqlite
        .prepare(
          'UPDATE platform_model_channels SET name=?,base_url=?,secret_blob=?,enabled=?,updated_at=? WHERE id=?'
        )
        .run(name, url, this.seal({ apiKey: key, headers, authFields }), enabled, at, id)
      this.sqlite
        .prepare(
          'UPDATE ai_service_configs SET base_url=?,api_key=?,updated_at=? WHERE id IN(SELECT config_id FROM platform_channel_models WHERE channel_id=?)'
        )
        .run(url, '', at, id)
    } else {
      id = Number(
        this.sqlite
          .prepare(
            'INSERT INTO platform_model_channels(name,base_url,secret_blob,enabled,created_at,updated_at)VALUES(?,?,?,?,?,?)'
          )
          .run(name, url, this.seal({ apiKey: key, headers, authFields }), enabled, at, at).lastInsertRowid
      )
    }
    return this.listChannels().find((c) => c.id === id)!
  }
  deleteChannel(id: number) {
    if (!this.channel(id)) throw new Error('渠道不存在')
    const at = now()
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare('UPDATE platform_model_channels SET enabled=0,deleted_at=?,updated_at=? WHERE id=?')
        .run(at, at, id)
      this.sqlite
        .prepare(
          'UPDATE platform_channel_models SET enabled=0,deleted_at=COALESCE(deleted_at,?),updated_at=? WHERE channel_id=?'
        )
        .run(at, at, id)
      this.sqlite
        .prepare(
          'UPDATE ai_service_configs SET is_active=0,updated_at=? WHERE id IN(SELECT config_id FROM platform_channel_models WHERE channel_id=?)'
        )
        .run(at, id)
    })()
  }
  private bindingRow(r: any): Binding {
    return {
      id: r.id,
      config_id: r.config_id,
      channel_id: r.channel_id,
      name: r.name,
      model: r.model,
      type: r.type,
      protocol_id: r.protocol_id,
      capabilities: parse(r.capabilities_json),
      defaults: parse(r.defaults_json),
      enabled: !!r.enabled,
      access: r.access_mode === 'selected' ? 'selected' : 'all',
      allowed_user_ids: parse(r.allowed_user_ids_json, []),
      priority: r.priority,
      is_default: r.is_default === 1,
      deleted_at: r.deleted_at || null
    }
  }
  bindings(channelId?: number): Binding[] {
    return this.sqlite
      .prepare(
        'SELECT m.*,c.is_default FROM platform_channel_models m LEFT JOIN ai_service_configs c ON c.id=m.config_id WHERE m.deleted_at IS NULL' +
          (channelId ? ' AND m.channel_id=?' : '') +
          ' ORDER BY c.is_default DESC,m.priority DESC,m.id'
      )
      .all(...(channelId ? [channelId] : []))
      .map((r) => this.bindingRow(r))
  }
  binding(id: number) {
    const row = this.sqlite
      .prepare('SELECT m.*,c.is_default FROM platform_channel_models m LEFT JOIN ai_service_configs c ON c.id=m.config_id WHERE m.id=? AND m.deleted_at IS NULL')
      .get(id)
    return row ? this.bindingRow(row) : null
  }
  bindingForConfig(id: number) {
    const row = this.sqlite.prepare('SELECT m.*,c.is_default FROM platform_channel_models m LEFT JOIN ai_service_configs c ON c.id=m.config_id WHERE m.config_id=?').get(id)
    return row ? this.bindingRow(row) : null
  }
  isAllowed(binding: Binding, actor?: { id: number; role: string } | null) {
    return (
      !actor ||
      actor.role === 'admin' ||
      binding.access === 'all' ||
      binding.allowed_user_ids.includes(actor.id)
    )
  }
  allowed(binding: Binding, actor?: { id: number; role: string } | null) {
    const c = this.channel(binding.channel_id)
    return (
      !!c?.enabled &&
      !binding.deleted_at &&
      binding.enabled &&
      this.isAllowed(binding, actor) &&
      this.protocol(binding.protocol_id)?.type === binding.type &&
      this.protocol(binding.protocol_id)?.executable !== false
    )
  }
  /** One explicit default per service type. Existing selections and priority
   * values remain untouched; permission filtering still precedes resolution. */
  setDefaultBinding(channelId: number, bindingId: number): Binding {
    return this.sqlite.transaction(() => {
      const binding = this.binding(bindingId)
      if (!binding || binding.channel_id !== channelId) throw new Error('模型不属于此渠道或已删除')
      const channel = this.channel(channelId)
      const protocol = this.protocol(binding.protocol_id)
      if (!channel?.enabled || !binding.enabled) throw new Error('请先启用渠道和模型，再设为默认')
      if (!protocol || protocol.type !== binding.type || protocol.executable === false) throw new Error('该模型协议当前不可用，不能设为默认')
      if (!['text', 'image', 'video'].includes(binding.type)) throw new Error('模型类型不支持设为默认')
      const at = now()
      this.sqlite.prepare('UPDATE ai_service_configs SET is_default=0,updated_at=? WHERE service_type=? AND is_default<>0').run(at, binding.type)
      const result = this.sqlite.prepare('UPDATE ai_service_configs SET is_default=1,updated_at=? WHERE id=? AND service_type=? AND is_active<>0').run(at, binding.config_id, binding.type)
      if (result.changes !== 1) throw new Error('模型配置已变化，请刷新后重试')
      return this.binding(bindingId)!
    }).immediate()
  }
  saveBinding(channelId: number, input: any, id?: number) {
    const channel = this.channel(channelId)
    if (!channel) throw new Error('渠道不存在')
    const old = id ? this.binding(id) : null
    if (id && (!old || old.channel_id !== channelId)) throw new Error('模型不属于此渠道')
    const protocol = this.protocol(input.protocol_id ?? old?.protocol_id)
    if (!protocol) throw new Error('请选择已安装的请求协议')
    if (protocol.executable === false) throw new Error(protocol.unavailable_reason || '该协议当前不可执行')
    const type = input.type ?? old?.type ?? protocol.type
    if (type !== protocol.type) throw new Error('模型类型与协议能力不一致')
    if (!['text', 'image', 'video'].includes(type)) throw new Error('当前工作台未提供此类型创作入口')
    const model = text(input.model ?? old?.model, '真实模型 ID'),
      name = text(input.name ?? old?.name ?? model, '显示名称')
    const capabilities = capabilitiesOf({
        ...protocol.capabilities,
        ...object(input.capabilities ?? old?.capabilities)
      }),
      defaults = object(input.defaults ?? old?.defaults)
    if (
      input.defaults !== undefined &&
      (!input.defaults || typeof input.defaults !== 'object' || Array.isArray(input.defaults))
    )
      throw new Error('默认参数必须为 JSON 对象')
    assertPublicParameterTree(defaults)
    if (JSON.stringify(capabilities).length > 32000 || JSON.stringify(defaults).length > 16000)
      throw new Error('模型参数配置过大')
    if (
      Object.keys(defaults).some((k) =>
        [
          'prompt',
          'model',
          'api_key',
          'base_url',
          'headers',
          'referenceImages',
          'referenceImageUrls'
        ].includes(k)
      )
    )
      throw new Error('默认参数不能覆盖创作提示词、真实模型、连接或素材')
    if (protocol.id === 'image.gpt-local' && model !== 'imagegen')
      throw new Error('官号图片中转当前真实型号为 imagegen，不冒充 API 型号')
    if (protocol.id === 'image.gpt-local' && Number(capabilities.max_concurrency) > 4)
      throw new Error('官号图片全局并发最多4')
    const access = input.access ?? old?.access ?? 'all'
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean')
      throw new Error('enabled 必须为布尔值')
    if (!['all', 'selected'].includes(access)) throw new Error('模型授权方式错误')
    const users = input.allowed_user_ids ?? old?.allowed_user_ids ?? []
    if (!Array.isArray(users) || users.length > 1000 || users.some((v) => !Number.isSafeInteger(v) || v < 1))
      throw new Error('授权用户编号错误')
    const priority = input.priority ?? old?.priority ?? 0
    if (!Number.isSafeInteger(priority) || Math.abs(priority) > 10000000) throw new Error('优先级错误')
    const enabled = input.enabled === undefined ? (old?.enabled ?? true) : !!input.enabled,
      at = now()
    let configId = old?.config_id
    this.sqlite.transaction(() => {
      if (configId) {
        this.sqlite
          .prepare(
            'UPDATE ai_service_configs SET service_type=?,provider=?,name=?,base_url=?,api_key=?,model=?,priority=?,is_active=?,updated_at=? WHERE id=?'
          )
          .run(
            type,
            protocol.provider,
            name,
            channel.base_url,
            '',
            JSON.stringify([model]),
            priority,
            enabled ? 1 : 0,
            at,
            configId
          )
        if (old && old.type !== type) this.sqlite.prepare('UPDATE ai_service_configs SET is_default=0 WHERE id=?').run(configId)
      } else {
        configId = Number(
          this.sqlite
            .prepare(
              'INSERT INTO ai_service_configs(service_type,provider,name,base_url,api_key,model,priority,is_active,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?,?,?)'
            )
            .run(
              type,
              protocol.provider,
              name,
              channel.base_url,
              '',
              JSON.stringify([model]),
              priority,
              enabled ? 1 : 0,
              at,
              at
            ).lastInsertRowid
        )
      }
      const values = [
        name,
        model,
        type,
        protocol.id,
        JSON.stringify(capabilities),
        JSON.stringify(defaults),
        enabled ? 1 : 0,
        access,
        JSON.stringify([...new Set(users)]),
        priority,
        at
      ]
      if (old)
        this.sqlite
          .prepare(
            'UPDATE platform_channel_models SET name=?,model=?,type=?,protocol_id=?,capabilities_json=?,defaults_json=?,enabled=?,access_mode=?,allowed_user_ids_json=?,priority=?,updated_at=? WHERE id=?'
          )
          .run(...values, old.id)
      else {
        id = Number(
          this.sqlite
            .prepare(
              'INSERT INTO platform_channel_models(channel_id,config_id,name,model,type,protocol_id,capabilities_json,defaults_json,enabled,access_mode,allowed_user_ids_json,priority,updated_at,created_at)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
            )
            .run(channelId, configId!, ...values, at).lastInsertRowid
        )
      }
    })()
    return this.binding(id!)!
  }
  deleteBinding(channelId: number, id: number) {
    const b = this.binding(id)
    if (!b || b.channel_id !== channelId) throw new Error('模型不属于此渠道')
    const at = now()
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare('UPDATE platform_channel_models SET enabled=0,deleted_at=?,updated_at=? WHERE id=?')
        .run(at, at, id)
      this.sqlite
        .prepare('UPDATE ai_service_configs SET is_active=0,updated_at=? WHERE id=?')
        .run(at, b.config_id)
    })()
  }
  resolve(configId: number, actor?: { id: number; role: string } | null): ResolvedBinding | null {
    this.migrateLegacy()
    const b = this.bindingForConfig(configId)
    if (!b) return null
    if (!this.allowed(b, actor)) return null
    const c = this.channelConnection(b.channel_id),
      protocol = this.protocol(b.protocol_id)!
    return {
      id: b.config_id,
      serviceType: b.type as ServiceType,
      provider: protocol.provider,
      baseUrl: c.baseUrl,
      apiKey: c.apiKey,
      model: b.model,
      bindingId: b.id,
      channelId: b.channel_id,
      channelName: c.name,
      protocolId: protocol.id,
      protocolVersion: protocol.version,
      ...(protocol.definition ? { protocolDefinition: protocol.definition } : {}),
      capabilities: b.capabilities,
      defaults: b.defaults,
      headers: c.headers,
      authFields: c.authFields,
      parameters: protocolParameters(protocol).map((parameter) =>
        parameter.key === 'reasoning_effort' && Array.isArray(b.capabilities.reasoning_efforts)
          ? { ...parameter, options: b.capabilities.reasoning_efforts }
          : parameter
      )
    }
  }
  publicModels(actor?: { id: number; role: string } | null, type?: string) {
    this.migrateLegacy()
    return this.bindings()
      .filter((b) => (!type || b.type === type) && this.allowed(b, actor))
      .map((b) => ({
        ...b,
        allowed_user_ids: undefined,
        access: undefined,
        display_name: b.name,
        channel_name: this.channel(b.channel_id)?.name,
        provider: this.protocol(b.protocol_id)!.provider,
        parameters: protocolParameters(this.protocol(b.protocol_id)!).map((parameter) =>
          parameter.key === 'reasoning_effort' && Array.isArray(b.capabilities.reasoning_efforts)
            ? { ...parameter, options: b.capabilities.reasoning_efforts }
            : parameter
        )
      }))
  }
  migrateLegacy() {
    this.sqlite
      .prepare(
        'UPDATE ai_service_configs SET is_active=0 WHERE is_active<>0 AND id IN(SELECT config_id FROM platform_channel_models WHERE deleted_at IS NOT NULL)'
      )
      .run()
    const rows = this.sqlite
      .prepare(
        'SELECT * FROM ai_service_configs WHERE id NOT IN(SELECT config_id FROM platform_channel_models) ORDER BY id'
      )
      .all() as any[]
    if (!rows.length) return
    this.sqlite.transaction(() => {
      for (const row of rows) {
        const protocol = builtinProtocol(row.service_type, row.provider || '') || 'legacy.unavailable'
        const values = parse(row.model, [])
        const models = [
          ...new Set((Array.isArray(values) ? values : []).filter((v: any) => typeof v === 'string'))
        ] as string[]
        if (!models.length) models.push('')
        let channelId: number | undefined
        for (const channel of this.sqlite
          .prepare('SELECT * FROM platform_model_channels WHERE deleted_at IS NULL')
          .all() as ChannelRow[]) {
          if (
            channel.base_url === (row.base_url || '') &&
            this.unseal(channel.secret_blob).apiKey === row.api_key
          ) {
            channelId = channel.id
            break
          }
        }
        const at = now()
        if (!channelId)
          channelId = Number(
            this.sqlite
              .prepare(
                'INSERT INTO platform_model_channels(name,base_url,secret_blob,enabled,created_at,updated_at)VALUES(?,?,?,?,?,?)'
              )
              .run(
                row.name || '已迁移渠道',
                row.base_url || '',
                this.seal({ apiKey: row.api_key || '', headers: {} }),
                1,
                at,
                at
              ).lastInsertRowid
          )
        models.forEach((model, index) => {
          let configId = row.id
          const display = index ? `${row.name} · ${model}` : row.name
          if (index)
            configId = Number(
              this.sqlite
                .prepare(
                  'INSERT INTO ai_service_configs(service_type,provider,name,base_url,api_key,model,priority,is_active,settings,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?,?,?,?)'
                )
                .run(
                  row.service_type,
                  row.provider,
                  display,
                  row.base_url || '',
                  '',
                  JSON.stringify([model]),
                  row.priority || 0,
                  row.is_active,
                  row.settings,
                  at,
                  at
                ).lastInsertRowid
            )
          else this.sqlite.prepare('UPDATE ai_service_configs SET api_key=? WHERE id=?').run('', configId)
          this.sqlite
            .prepare(
              'INSERT INTO platform_channel_models(channel_id,config_id,name,model,type,protocol_id,enabled,priority,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?,?,?)'
            )
            .run(
              channelId!,
              configId,
              display,
              model,
              row.service_type,
              protocol,
              row.is_active ? 1 : 0,
              row.priority || 0,
              at,
              at
            )
        })
      }
    })()
  }
  /** Legacy configuration routes keep their IDs; their credentials are immediately moved to the vault. */
  syncLegacy(id: number, input?: any) {
    this.migrateLegacy()
    const b = this.bindingForConfig(id)
    if (!b || b.deleted_at) return
    const row = this.sqlite.prepare('SELECT * FROM ai_service_configs WHERE id=?').get(id) as any
    if (!row) return
    if (row.service_type !== b.type) this.sqlite.prepare('UPDATE ai_service_configs SET is_default=0 WHERE id=?').run(id)
    let channelId = b.channel_id
    const connection = this.channelConnection(channelId)
    if (input && (input.base_url !== undefined || input.api_key)) {
      const url = input.base_url ?? connection.baseUrl,
        key = input.api_key || connection.apiKey
      if (url !== connection.baseUrl || key !== connection.apiKey)
        channelId = this.saveChannel({
          name: row.name,
          base_url: url,
          api_key: key,
          headers: connection.headers
        }).id
    }
    const models = parse(row.model, []),
      model = typeof models[0] === 'string' ? models[0] : b.model
    const previousProtocol = this.protocol(b.protocol_id)
    const protocol =
      previousProtocol &&
      previousProtocol.provider === row.provider &&
      previousProtocol.type === row.service_type
        ? b.protocol_id
        : builtinProtocol(row.service_type, row.provider) || b.protocol_id
    this.sqlite
      .prepare(
        'UPDATE platform_channel_models SET channel_id=?,name=?,model=?,type=?,protocol_id=?,enabled=?,priority=?,updated_at=? WHERE id=?'
      )
      .run(
        channelId,
        row.name,
        model,
        row.service_type,
        protocol,
        row.is_active ? 1 : 0,
        row.priority || 0,
        now(),
        b.id
      )
    this.sqlite.prepare('UPDATE ai_service_configs SET api_key=? WHERE id=?').run('', id)
  }
}

let singleton: ModelChannelStore | undefined
export function getModelChannelStore() {
  return (singleton ??= new ModelChannelStore(db.$client, DATA_ROOT))
}
