/** Native tool envelopes for upstream provider manifests whose create surface predates agent. */
export const NATIVE_AGENT_IDS=new Set(['a6api-chat','antigravity-chat','aws-bedrock-converse','aws-bedrock-invoke-model','azure-openai','cohere-chat-v2','dashscope-qwen-native','minimax-text-native','ollama-chat','vertex-gemini'])
const asText=(content:any):string=>typeof content==='string'?content:Array.isArray(content)?content.filter(x=>x.type==='text'||x.text!==undefined).map(x=>x.text||'').join(''):content==null?'':JSON.stringify(content)
const parseArguments=(value:any)=>{if(typeof value!=='string')return value||{};try{return JSON.parse(value)}catch{throw Error('模型工具参数必须是完整JSON，未执行工具')}}
const toolChoice=(value:any)=>typeof value==='object'?value.function?.name||value.name:value
const toolsOf=(raw:any)=>(raw.chatCompletion?.tools||[]).filter((tool:any)=>tool.type==='function').map((tool:any)=>tool.function)
function inlineMedia(source:any){const match=typeof source==='string'&&/^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(source);if(!match)throw Error('原生文件协议需要实际文件字节，未将文件静默降为纯文字');return{mimeType:match[1],base64:match[2]}}
function converseContent(content:any){
 if(content==null)return[];if(typeof content==='string')return content?[{text:content}]:[];if(!Array.isArray(content))throw Error('Converse消息内容格式不受支持')
 return content.map(part=>{if(part.type==='text')return{text:part.text};if(part.type==='image_url'){const data=inlineMedia(part.image_url?.url),format=data.mimeType.split('/')[1];if(!['png','jpeg','gif','webp'].includes(format))throw Error('Converse图像格式不受支持');return{image:{format,source:{bytes:data.base64}}}};if(part.type==='file'){const data=inlineMedia(part.file?.file_data),formats:Record<string,string>={'application/pdf':'pdf','text/plain':'txt','text/csv':'csv','text/html':'html','text/markdown':'md','application/msword':'doc','application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx','application/vnd.ms-excel':'xls','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx'},format=formats[data.mimeType];if(!format)throw Error('Converse文档格式不受支持');return{document:{format,name:String(part.file.filename||'reference-document').replace(/[^A-Za-z0-9()[\] -]/gu,' ').slice(0,100)||'reference-document',source:{bytes:data.base64}}}};throw Error(`Converse不支持内容块${part.type}，未丢弃素材`)} )
}
function converseMessages(messages:any[]){
 const system=messages.filter(x=>['system','developer'].includes(x.role)).flatMap(x=>{const content=converseContent(x.content);if(content.some(part=>!('text'in part)))throw Error('Converse系统消息仅支持文本');return content}),result:any[]=[]
 for(const message of messages){if(['system','developer'].includes(message.role))continue;let content:any[]=[]
  if(message.role==='tool')content=[{toolResult:{toolUseId:message.tool_call_id,content:[{text:asText(message.content)}]}}]
  else{content.push(...converseContent(message.content));for(const call of message.tool_calls||[])content.push({toolUse:{toolUseId:call.id,name:call.function?.name,input:parseArguments(call.function?.arguments)}})}
  if(!content.length)continue;const role=message.role==='assistant'?'assistant':'user';if(result.at(-1)?.role===role)result.at(-1).content.push(...content);else result.push({role,content})
 }
 return{system,messages:result}
}
export function nativeAgentBody(id:string,model:string,raw:any){
 const chat=structuredClone(raw.chatCompletion||{}),messages=chat.messages||[],functions=toolsOf(raw),options=raw.providerOptions?.[id]||{},choice=toolChoice(chat.tool_choice)
 const protectedChat={model,messages,tools:chat.tools,tool_choice:chat.tool_choice,response_format:chat.response_format,stream:false}
 if(['a6api-chat','antigravity-chat','azure-openai','minimax-text-native'].includes(id))return{...chat,...options,...protectedChat}
 if(id==='cohere-chat-v2')return{...chat,...options,...protectedChat,...(chat.tool_choice?{tool_choice:choice==='required'?'REQUIRED':choice==='none'?'NONE':'AUTO'}:{})}
 if(id==='dashscope-qwen-native'){
  if(messages.some((message:any)=>Array.isArray(message.content)&&message.content.some((part:any)=>part.type!=='text')))throw Error('Qwen原生文本端点不支持此文件块；请选择多模态端点，未丢弃文件')
  const {model:_model,messages:_messages,stream:_stream,...parameters}=chat
  return{...Object.fromEntries(Object.entries(options).filter(([key])=>key!=='parameters')),model,input:{messages},parameters:{...parameters,...options.parameters,tools:chat.tools,tool_choice:chat.tool_choice,response_format:chat.response_format,result_format:'message',incremental_output:false}}
 }
 if(id==='ollama-chat'){
  const {temperature,top_p,max_tokens,stop,seed,response_format,...rest}=chat
  const nativeMessages=messages.map((message:any)=>{const images:string[]=[],parts=typeof message.content==='string'?[{type:'text',text:message.content}]:message.content||[];for(const part of parts){if(part.type==='image_url'){const data=inlineMedia(part.image_url?.url);if(!data.mimeType.startsWith('image/'))throw Error('Ollama图片块类型不正确');images.push(data.base64)}else if(part.type!=='text')throw Error('Ollama此文件块不受支持，未将文件丢弃')};return{...message,content:parts.filter((part:any)=>part.type==='text').map((part:any)=>part.text).join(''),...(images.length?{images}:{}),...(message.tool_calls?{tool_calls:message.tool_calls.map((call:any)=>({...call,function:{...call.function,arguments:parseArguments(call.function?.arguments)}}))}:{})}})
  return{...rest,...options,model,messages:nativeMessages,tools:chat.tools,stream:false,options:{...options.options,...(temperature!==undefined?{temperature}:{}),...(top_p!==undefined?{top_p}:{}),...(max_tokens!==undefined?{num_predict:max_tokens}:{}),...(stop!==undefined?{stop}:{}),...(seed!==undefined?{seed}:{})},...(response_format?{format:response_format.json_schema?.schema||'json'}:{})}
 }
 if(id==='vertex-gemini'){
  const gemini=structuredClone(raw.gemini||{});if(!Array.isArray(gemini.contents))throw Error('Vertex Gemini需要完整gemini消息封装（system/tools/schema）')
  return{...gemini,...options,systemInstruction:gemini.systemInstruction,contents:gemini.contents,tools:gemini.tools,toolConfig:gemini.toolConfig,...(gemini.generationConfig?{generationConfig:{...gemini.generationConfig,...options.generationConfig,...(gemini.generationConfig.responseSchema?{responseSchema:gemini.generationConfig.responseSchema}:{}),...(gemini.generationConfig.responseMimeType?{responseMimeType:gemini.generationConfig.responseMimeType}:{})}}:{})}
 }
 if(id==='aws-bedrock-invoke-model'&&/anthropic|claude/iu.test(model)){
  const body=structuredClone(raw.claude||{});if(!Array.isArray(body.messages))throw Error('Bedrock Claude需要完整Anthropic工具消息封装')
  delete body.model;delete body.stream;return{...options,anthropic_version:'bedrock-2023-05-31',...body,max_tokens:body.max_tokens||chat.max_tokens||4096}
 }
 if(id==='aws-bedrock-converse'||id==='aws-bedrock-invoke-model'&&/amazon\.nova/iu.test(model)){
  const converted=converseMessages(messages),inferenceConfig={...(chat.max_tokens?{maxTokens:chat.max_tokens}:{}),...(chat.temperature!==undefined?{temperature:chat.temperature}:{}),...(chat.top_p!==undefined?{topP:chat.top_p}:{}),...(chat.stop?{stopSequences:Array.isArray(chat.stop)?chat.stop:[chat.stop]}:{}),...options.inferenceConfig}
  const toolConfig=functions.length&&choice!=='none'?{tools:functions.map((tool:any)=>({toolSpec:{name:tool.name,description:tool.description||'',inputSchema:{json:tool.parameters||{type:'object'}}}})),toolChoice:choice==='required'?{any:{}}:choice&&choice!=='auto'?{tool:{name:choice}}:{auto:{}}}:undefined
  const schema=chat.response_format?.json_schema
  // Converse supports JSON-schema outputConfig while retaining the same schema.
  return{...options,...(id==='aws-bedrock-invoke-model'?{schemaVersion:'messages-v1'}:{}),...converted,inferenceConfig,...(toolConfig?{toolConfig}:{}),...(schema?{outputConfig:{textFormat:{type:'json_schema',structure:{jsonSchema:{name:schema.name||'response',schema:JSON.stringify(schema.schema),description:schema.description||''}}}}}:{})}
 }
 if(id==='aws-bedrock-invoke-model')throw Error('此Bedrock Invoke型号尚未声明原生工具消息协议；请选择Converse或Anthropic/Nova型号，未丢弃工具自动降级')
 throw Error('此provider未声明Agent协议')
}
function standardCalls(value:any[]):any[]{return(value||[]).map((call:any,index:number)=>({id:call.id||call.toolUseId||`call_native_${index}`,name:call.function?.name||call.name,arguments:typeof call.function?.arguments==='string'?call.function.arguments:typeof call.arguments==='string'?call.arguments:JSON.stringify(call.function?.arguments??call.arguments??call.input??{}),...(call.thoughtSignature?{thoughtSignature:call.thoughtSignature}:{})})).filter(x=>x.name)}
export function nativeAgentResult(id:string,payload:any){
 if(id==='aws-bedrock-converse'||id==='aws-bedrock-invoke-model'){
  const content=payload.output?.message?.content||payload.content||[]
  return{text:content.filter((part:any)=>part.text!==undefined).map((part:any)=>part.text).join(''),toolCalls:standardCalls(content.filter((part:any)=>part.toolUse||part.type==='tool_use').map((part:any)=>part.toolUse||part)),usage:payload.usage}
 }
 if(id==='vertex-gemini'){
  const parts=payload.candidates?.[0]?.content?.parts||[]
  return{text:parts.filter((part:any)=>!part.thought&&part.text!==undefined).map((part:any)=>part.text).join(''),toolCalls:standardCalls(parts.filter((part:any)=>part.functionCall).map((part:any,index:number)=>({id:part.functionCall.id||`call_gemini_${index}`,name:part.functionCall.name,arguments:JSON.stringify(part.functionCall.args||{}),thoughtSignature:part.thoughtSignature}))),usage:payload.usageMetadata}
 }
 const message=payload.choices?.[0]?.message||payload.output?.choices?.[0]?.message||payload.message||{}
 return{text:asText(message.content||payload.output?.text||payload.text||''),toolCalls:standardCalls(message.tool_calls),usage:payload.usage||payload.usageMetadata}
}
export function nativeUsage(payload:any){
 const raw=payload?.usage||payload?.usageMetadata||payload?.usage_metadata||{},numeric=(value:any)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:undefined
 const inputTokens=numeric(raw.inputTokens??raw.input_tokens??raw.prompt_tokens??raw.promptTokenCount??raw.tokens?.input_tokens??payload?.prompt_eval_count),outputTokens=numeric(raw.outputTokens??raw.output_tokens??raw.completion_tokens??raw.candidatesTokenCount??raw.tokens?.output_tokens??payload?.eval_count),totalTokens=numeric(raw.totalTokens??raw.total_tokens??raw.totalTokenCount)
 return{inputTokens,outputTokens,totalTokens,raw}
}
/** Aggregate public SSE frames only when a provider actually sends SSE despite stream=false. */
export function aggregateAgentSSE(raw:any){
 const envelope=raw?.__providerResponse;if(!envelope?.bodyBase64)return raw
 const text=Buffer.from(envelope.bodyBase64,'base64').toString('utf8');if(!/^\s*(?:event:|data:)/u.test(text))return raw
 const frames:any[]=[];for(const line of text.split(/\r?\n/u)){if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(!data||data==='[DONE]')continue;try{frames.push(JSON.parse(data))}catch{throw Error('模型SSE帧不是有效JSON，未自动重发')}}
 if(!frames.length)throw Error('模型SSE未返回可解析内容')
 if(frames.some(frame=>frame.choices)){
  let content='';const calls=new Map<number,any>();let usage:any
  for(const frame of frames){if(frame.error)throw Error(String(frame.error.message||frame.error));usage=frame.usage||usage;const choice=frame.choices?.[0],delta=choice?.delta||choice?.message||{};if(typeof delta.content==='string')content+=delta.content;for(const call of delta.tool_calls||[]){const index=call.index??0,previous=calls.get(index)||{id:'',type:'function',function:{name:'',arguments:''}};if(call.id)previous.id=call.id;if(call.function?.name)previous.function.name+=call.function.name;if(call.function?.arguments)previous.function.arguments+=call.function.arguments;calls.set(index,previous)}}
  return{choices:[{message:{role:'assistant',content,tool_calls:[...calls.values()]}}],usage}
 }
 if(frames.some(frame=>frame.type==='content_block_start'||frame.type==='content_block_delta')){
  const blocks=new Map<number,any>();for(const frame of frames){if(frame.type==='content_block_start')blocks.set(frame.index,{...frame.content_block,_partial:''});if(frame.type==='content_block_delta'){const block=blocks.get(frame.index);if(!block)continue;if(frame.delta?.text)block.text=(block.text||'')+frame.delta.text;if(frame.delta?.partial_json)block._partial+=frame.delta.partial_json}}
  return{content:[...blocks.values()].map(({_partial,...block})=>({...block,...(_partial?{input:parseArguments(_partial)}:{})}))}
 }
 if(frames.some(frame=>frame.candidates)){const parts=frames.flatMap(frame=>frame.candidates?.[0]?.content?.parts||[]).filter(part=>!part.thought);return{candidates:[{content:{parts}}],usageMetadata:frames.at(-1)?.usageMetadata}}
 return frames.at(-1)
}
