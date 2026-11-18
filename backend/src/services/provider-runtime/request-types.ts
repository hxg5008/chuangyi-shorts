import type {GenerationRequest} from './types.js'

/** The existing task store represents checkbox flags as 0/1. Normalize only
 * typed protocol-envelope scalars; prompt, tools and provider payloads stay exact. */
export function normalizeGenerationTypes(input:GenerationRequest):GenerationRequest{
 const result=structuredClone(input),number=(value:any,key:string,integer:boolean)=>{
  if(value===undefined||value===null)return value
  const converted=typeof value==='string'&&/^-?\d+(?:\.\d+)?$/u.test(value.trim())?Number(value):value
  if(typeof converted!=='number'||!Number.isFinite(converted)||integer&&!Number.isSafeInteger(converted))throw new Error(`协议字段${key}必须是${integer?'整数':'数值'}，未提交模型请求`)
  return converted
 },boolean=(value:any,key:string)=>{
  if(value===undefined||value===null||typeof value==='boolean')return value
  if(value===0||value==='0'||value==='false')return false
  if(value===1||value==='1'||value==='true')return true
  throw new Error(`协议字段${key}必须是布尔值或0/1，未提交模型请求`)
 }
 for(const key of ['generateAudio','watermark'] as const)if(key in result)(result as any)[key]=boolean(result[key],key)
 for(const key of ['duration','imageCount'] as const)if(key in result)(result as any)[key]=number(result[key],key,true)
 for(const key of ['aspectRatio','resolution','quality','operation'] as const)if(result[key]!=null&&typeof result[key]!=='string'){
  if(typeof result[key]!=='number'||!Number.isFinite(result[key] as number))throw new Error(`协议字段${key}必须是字符串，未提交模型请求`)
  ;(result as any)[key]=String(result[key])
 }
 if(result.output){for(const key of ['generateAudio','watermark'])if(key in result.output)result.output[key]=boolean(result.output[key],'output.'+key);for(const key of ['count','duration','width','height'])if(key in result.output)result.output[key]=number(result.output[key],'output.'+key,true);if('fps'in result.output)result.output.fps=number(result.output.fps,'output.fps',false)}
 return result
}
