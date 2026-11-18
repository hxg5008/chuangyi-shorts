import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { compileProvider } from '../provider-runtime/index.js'
import { getModelChannelStore, type ModelChannelStore } from './store.js'
import { normalizeProviderParameters, providerStreamingMode } from './parameters.js'
import { parsePluginPackage } from './plugin-package.js'
import type { ProtocolRecord } from './protocols.js'

export async function importProviderManifest(
  manifest: any,
  options: { store?: ModelChannelStore; source?: string; preview?: boolean } = {}
) {
  const store = options.store || getModelChannelStore(),
    providers: ProtocolRecord[] = [],
    warnings: string[] = []
  for (const provider of manifest.contributes.providers) {
    const definition = { engine: 'yingce-v2', manifest, providerId: provider.id }
    let compiled: any
    try {
      compiled = await compileProvider({ manifest, providerId: provider.id })
    } catch (error: any) {
      compiled = { executable: false, reason: error.message }
    }
    const capabilities = provider.capabilities || [],
      type = capabilities.find((value: string) => ['text', 'image', 'video', 'audio'].includes(value))
    if (!type) {
      warnings.push(`${provider.id} 没有工作台支持的能力类型`)
      continue
    }
    const unavailable =
      type === 'audio'
        ? '当前工作台未提供音频生成入口'
        : compiled.executable === false
          ? compiled.reason || compiled.unavailableReason || '协议运行时不能执行此provider'
          : ''
    const authFields = (manifest.configuration?.fields || [])
      .filter((field: any) => typeof field.name === 'string')
      .map((field: any) => ({
        ...field,
        label: field.label || field.name,
        secret: field.type === 'secret' || /key|secret|token|password/iu.test(field.name)
      }))
    const record: ProtocolRecord = {
      id: `engine.${provider.id}`,
      name: provider.label || manifest.name || provider.id,
      type,
      provider: 'yingce',
      custom: true,
      version: 1,
      capabilities: {
        reference_images:
          provider.parameters?.some(
            (parameter: any) => parameter.name === 'images' && parameter.mapping !== 'unsupported'
          ) || false,
        reference_video:
          provider.parameters?.some(
            (parameter: any) => parameter.name === 'videos' && parameter.mapping !== 'unsupported'
          ) || false,
        reference_audio:
          provider.parameters?.some(
            (parameter: any) => parameter.name === 'audios' && parameter.mapping !== 'unsupported'
          ) || false,
        ...(type === 'text'
          ? {
              tools: !!compiled.agentAvailable,
              stream: providerStreamingMode(provider) === 'incremental',
              streaming_mode: providerStreamingMode(provider)
            }
          : {})
      },
      definition,
      provider_id: provider.id,
      plugin_id: manifest.id,
      plugin_version: String(manifest.version || '1'),
      parameters: normalizeProviderParameters(provider),
      auth_fields: authFields,
      executable: !unavailable,
      unavailable_reason: unavailable || undefined,
      source: options.source || 'imported'
    }
    providers.push(record)
  }
  if (!options.preview) {
    const saved = store.sqlite.transaction(() =>
      providers.map((record) => store.saveEngineProtocol(record))
    )()
    providers.splice(0, providers.length, ...saved)
  }
  return {
    plugin_id: manifest.id,
    name: manifest.name || manifest.id,
    version: manifest.version,
    providers,
    imported: !options.preview,
    warnings
  }
}
let initialization: Promise<void> | undefined
export function initializeProviderCatalog(store = getModelChannelStore()) {
  return (initialization ??= (async () => {
    const directory = fileURLToPath(new URL('./bundled/', import.meta.url))
    for (const name of (await fs.readdir(directory)).filter((name) => name.endsWith('.json')).sort()) {
      const bytes = await fs.readFile(path.join(directory, name)),
        manifest = JSON.parse(bytes.toString('utf8'))
      if (!Array.isArray(manifest.contributes?.providers) || !manifest.contributes.providers.length) continue
      parsePluginPackage(bytes, 'manifest.json')
      await importProviderManifest(manifest, { store, source: 'bundled-yingce-v2' })
    }
  })())
}
