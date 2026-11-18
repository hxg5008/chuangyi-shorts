import {createHash,createHmac} from 'node:crypto'
import type {ProviderConnection} from './types.js'
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
const hmac=(key:string|Uint8Array,value:string)=>createHmac('sha256',key).update(value).digest()
function credential(connection:ProviderConnection,field='apiKey'){
 const exact=connection.authFields?.[field];if(exact!==undefined)return exact
 const folded=field.toLowerCase().replace(/_/gu,'')
 for(const [key,value] of Object.entries(connection.authFields||{}))if(key.toLowerCase().replace(/_/gu,'')===folded)return value
 if(['secret','secretkey'].includes(folded))return connection.authFields?.secretKey||connection.authFields?.secret_key||''
 return connection.apiKey||''
}
const query=(url:URL)=>[...url.searchParams.entries()].sort(([a,av],[b,bv])=>a.localeCompare(b)||av.localeCompare(bv)).map(([a,b])=>`${encodeURIComponent(a)}=${encodeURIComponent(b)}`).join('&')
/** Port of Yingce provider_protocol_auth.go's stdlib auth drivers. Signing occurs after serialization. */
export function applyProtocolAuth(url:URL,headers:Headers,body:Uint8Array|undefined,connection:ProviderConnection,auth:Record<string,string>={},now=new Date(),method='POST'){
 const type=(auth.type||'bearer').trim().toLowerCase(),value=credential(connection,auth.field)
 switch(type){
  case 'none':return
  case 'bearer':headers.set(auth.header||'Authorization',(auth.prefix||'Bearer ')+value);return
  case 'header':case 'api-key':case 'apikey':if(!auth.header)throw Error('插件header鉴权缺少header');headers.set(auth.header,(auth.prefix||'')+value);return
  case 'query':{const name=auth.query||auth.field;if(!name)throw Error('插件query鉴权缺少参数名');url.searchParams.set(name,(auth.prefix||'')+value);return}
  case 'basic':headers.set('Authorization','Basic '+Buffer.from(`${auth.username||value}:${credential(connection,auth.secretField||'secretKey')}`).toString('base64'));return
  case 'anthropic':headers.set(auth.header||'x-api-key',value);if(!headers.has('anthropic-version'))headers.set('anthropic-version','2023-06-01');return
  case 'google-api-key':case 'gemini':headers.set(auth.header||'x-goog-api-key',value);return
  case 'aws-sigv4':case 'volcengine-v4':{
   const secret=credential(connection,auth.secretField||'secretKey');if(!value||!secret)throw Error('签名鉴权需要Access Key和Secret Key')
   const aws=type==='aws-sigv4',service=auth.service||(aws?'bedrock':''),region=auth.region||(aws?new RegExp(`${service}[^.]*\\.([a-z0-9-]+)\\.`, 'u').exec(url.hostname)?.[1]:'cn-north-1')
   if(!service||!region)throw Error('签名鉴权缺少service或region')
   const stamp=now.toISOString().replace(/[-:]/gu,'').replace(/\.\d{3}/u,''),date=stamp.slice(0,8),payload=hash(body||new Uint8Array())
   headers.set(aws?'x-amz-date':'x-date',stamp);headers.set(aws?'x-amz-content-sha256':'x-content-sha256',payload)
   const values=new Map<string,string>([['host',url.host.toLowerCase()]])
   for(const [key,item] of headers.entries())if(!['authorization','user-agent','content-length','expect'].includes(key.toLowerCase())&&(aws||['content-type','content-md5'].includes(key.toLowerCase())||key.toLowerCase().startsWith('x-')))values.set(key.toLowerCase(),item.trim().replace(/\s+/gu,' '))
   const names=[...values.keys()].sort(),canonicalHeaders=names.map(name=>name+':'+values.get(name)+'\n').join(''),signed=names.join(';')
   const algorithm=aws?'AWS4-HMAC-SHA256':'HMAC-SHA256',terminal=aws?'aws4_request':'request',scope=`${date}/${region}/${service}/${terminal}`
   const canonical=[method,url.pathname||'/',query(url),canonicalHeaders,signed,payload].join('\n')
   const key1=hmac((aws?'AWS4':'')+secret,date),key2=hmac(key1,region),key3=hmac(key2,service),key4=hmac(key3,terminal)
   const signature=hmac(key4,[algorithm,stamp,scope,hash(canonical)].join('\n')).toString('hex')
   headers.set('Authorization',`${algorithm} Credential=${value}/${scope}, SignedHeaders=${signed}, Signature=${signature}`);return
  }
  case 'tc3':{
   const secret=credential(connection,auth.secretField||'secretKey');if(!value||!secret)throw Error('TC3鉴权需要SecretId和SecretKey')
   const service=auth.service||'hunyuan',date=now.toISOString().slice(0,10),timestamp=String(Math.floor(now.getTime()/1000)),contentType=headers.get('content-type')||'application/json'
   headers.set('Content-Type',contentType);headers.set('X-TC-Timestamp',timestamp);if(auth.region)headers.set('X-TC-Region',auth.region)
   const canonical=[method,url.pathname||'/',query(url),`content-type:${contentType.trim().toLowerCase()}\nhost:${url.host.toLowerCase()}\n`,'content-type;host',hash(body||new Uint8Array())].join('\n')
   const scope=`${date}/${service}/tc3_request`,signature=hmac(hmac(hmac(hmac('TC3'+secret,date),service),'tc3_request'),['TC3-HMAC-SHA256',timestamp,scope,hash(canonical)].join('\n')).toString('hex')
   headers.set('Authorization',`TC3-HMAC-SHA256 Credential=${value}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`);return
  }
  default:throw Error('未知鉴权驱动：'+type)
 }
}
