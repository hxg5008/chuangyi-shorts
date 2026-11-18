/**
 * Provider Adapter 注册表
 * 根据 provider 名称返回对应的 Adapter 实例
 */
import { OpenAIImageAdapter } from './openai-image'
import { GeminiImageAdapter } from './gemini-image'
import { VolcEngineImageAdapter } from './volcengine-image'
import { VolcEngineVideoAdapter } from './volcengine-video'
import { MiniMaxVideoAdapter } from './minimax-video'
import { AliyunWanVideoAdapter } from './aliyun-wan-video'
import { JimengLocalVideoAdapter } from './jimeng-local-video'
import { EightApiVideoAdapter } from './eight-api-video'
import type { ImageProviderAdapter, VideoProviderAdapter } from './types'
import type { AIConfig } from './types'
import { DeclarativeImageAdapter, DeclarativeVideoAdapter } from './declarative-json.js'
import { ProtocolEngineImageAdapter,ProtocolEngineVideoAdapter } from './protocol-engine-adapter.js'

// 图片 Adapter 注册表
export const imageAdapters: Record<string, ImageProviderAdapter> = {
  openai: new OpenAIImageAdapter(),
  gemini: new GeminiImageAdapter(),
  volcengine: new VolcEngineImageAdapter(),
}

// 视频 Adapter 注册表
export const videoAdapters: Record<string, VideoProviderAdapter> = {
  volcengine: new VolcEngineVideoAdapter(),
  minimax: new MiniMaxVideoAdapter(),
  aliyun: new AliyunWanVideoAdapter(),
  '888api': new EightApiVideoAdapter(),
  jimeng_local: new JimengLocalVideoAdapter(),
}

/**
 * 获取图片 Adapter
 * @param provider 厂商名称
 * @returns 对应的 Adapter
 */
export function getImageAdapter(provider: string): ImageProviderAdapter {
  const adapter = imageAdapters[provider.toLowerCase()]
  if (!adapter) throw new Error(`Unsupported image provider: ${provider}`)
  return adapter
}

/**
 * 获取视频 Adapter
 * @param provider 厂商名称
 * @returns 对应的 Adapter
 */
export function getVideoAdapter(provider: string): VideoProviderAdapter {
  const adapter = videoAdapters[provider.toLowerCase()]
  if (!adapter) throw new Error(`Unsupported video provider: ${provider}`)
  return adapter
}

function channelHeaders<T extends ImageProviderAdapter|VideoProviderAdapter>(adapter:T,config:AIConfig,imageDefaults=false):T {
  const wrapped=Object.create(adapter)
  for(const name of ['buildGenerateRequest','buildPollRequest'] as const){
    wrapped[name]=(...args:any[])=>{
      const req=(adapter[name] as any).apply(adapter,args)
      req.headers={...req.headers}
      for(const [key,value] of Object.entries(config.headers||{})){
        for(const existing of Object.keys(req.headers))if(existing.toLowerCase()===key.toLowerCase())delete req.headers[existing]
        req.headers[key]=value
      }
      if(imageDefaults&&name==='buildGenerateRequest'&&adapter.provider!=='custom_json'&&config.defaults){
        for(const key of ['quality','output_format','output_compression','background','complexity']){
          if(config.defaults[key]===undefined)continue
          if(req.body instanceof FormData){if(!req.body.has(key))req.body.set(key,String(config.defaults[key]))}
          else if(req.body&&typeof req.body==='object'&&req.body[key]===undefined)req.body[key]=config.defaults[key]
        }
      }
      return req
    }
  }
  return wrapped
}
export function getConfiguredImageAdapter(config:AIConfig):ImageProviderAdapter {
  if(config.provider==='yingce')return new ProtocolEngineImageAdapter(config)
  const adapter=config.protocolDefinition?new DeclarativeImageAdapter(config.protocolDefinition):getImageAdapter(config.provider)
  return channelHeaders(adapter,config,true)
}
export function getConfiguredVideoAdapter(config:AIConfig):VideoProviderAdapter {
  if(config.provider==='yingce')return new ProtocolEngineVideoAdapter(config)
  const adapter=config.protocolDefinition?new DeclarativeVideoAdapter(config.protocolDefinition):getVideoAdapter(config.provider)
  return channelHeaders(adapter,config)
}
