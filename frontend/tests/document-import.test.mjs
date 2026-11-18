import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {parse,compileScript,compileTemplate} from '@vue/compiler-sfc'
import ts from 'typescript'
import * as vue from 'vue'
import {randomUUID} from 'node:crypto'

const file=new URL('../app/components/DocumentImportDialog.vue',import.meta.url)
const {descriptor}=parse(readFileSync(file,'utf8'))
const script=compileScript(descriptor,{id:'document-import-test'})
const compiled=ts.transpileModule(script.content,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const template=compileTemplate({source:descriptor.template.content,filename:file.pathname,id:'document-import-test',compilerOptions:{bindingMetadata:script.bindings}})
assert.deepEqual(template.errors,[])
const deferred=()=>{let resolve;return{promise:new Promise(yes=>resolve=yes),resolve:value=>resolve(value)}}
function harness(){
  const events=[],calls=[],unmount=[];let responder=async()=>({})
  const exports={}
  runInNewContext(compiled,{exports,require:name=>{
    if(name==='vue')return{...vue,onMounted(){},onBeforeUnmount:callback=>unmount.push(callback)}
    if(name==='~/composables/useApi')return{api:{post:async(path,body)=>{calls.push({path,body});return responder(path,body)},get:async()=>[]},aiConfigAPI:{list:async()=>[]}}
    if(name==='~/components/DocumentFileDrop.vue')return{}
    if(name==='~/utils/document-file.js')return{documentFileError:file=>!file||!/^.*\.(txt|md)$/i.test(file.name)?'Invalid file':file.size>6*1024*1024||file.size<=0?'Invalid size':''}
    throw new Error('Unexpected import '+name)
  },crypto:{randomUUID},Uint8Array,btoa:value=>Buffer.from(value,'binary').toString('base64'),console})
  const state=exports.default.setup({dramaId:7},{expose(){},emit:(...value)=>events.push(value)})
  return{state,calls,events,respond:callback=>responder=callback,dispose:()=>unmount.forEach(fn=>fn())}
}
test('later file selection wins over a slower earlier read, and clearing a pending read releases busy state',async()=>{
  const h=harness(),first=deferred(),second=deferred()
  const pick=(name,promise)=>h.state.pickFile({target:{files:[{name,size:4,arrayBuffer:()=>promise}]}})
  const one=pick('first.txt',first.promise),two=pick('second.md',second.promise)
  second.resolve(new TextEncoder().encode('乙').buffer);await two
  first.resolve(new TextEncoder().encode('甲').buffer);await one
  assert.equal(h.state.fileName.value,'second.md');assert.equal(Buffer.from(h.state.fileBytes.value,'base64').toString(),'乙')
  const wait=deferred(),three=pick('pending.txt',wait.promise);h.state.clearFile();assert.equal(h.state.busy.value,false)
  wait.resolve(new TextEncoder().encode('丙').buffer);await three;assert.equal(h.state.fileBytes.value,'')
})
test('manual split and merge preserve all characters and line endings; Unicode characters cannot be split in half',async()=>{
  const h=harness(),source='开场\r\n甲：你好🌷。\r\n结尾'
  h.state.sections.value=[{title:'第一集',content:source,episode_number:4,source_start:0,source_end:source.length,local_key:'a'}]
  h.state.editor.value={selectionStart:source.indexOf('🌷')+1};await h.state.splitAtCursor();assert.equal(h.state.sections.value.length,1);assert.match(h.state.error.value,/完整字符/)
  h.state.editor.value={selectionStart:source.indexOf('结尾')};await h.state.splitAtCursor();assert.equal(h.state.sections.value.length,2)
  assert.equal(h.state.sections.value.map(p=>p.content).join(''),source);assert.deepEqual(Array.from(h.state.sections.value,p=>p.episode_number),[4,5])
  h.state.mergeNext();assert.equal(h.state.sections.value.length,1);assert.equal(h.state.current.value.content,source)
})
test('preview ignores a late result after closing and never submits production models',async()=>{
  const h=harness(),reply=deferred();h.state.pasted.value='第一集\n完整正文';h.respond(()=>reply.promise)
  const pending=h.state.prepare();h.state.close();reply.resolve({id:'old',sections:[],model_defaults:{}});await pending
  assert.equal(h.state.preview.value,null);assert.equal(h.calls.length,1);assert.match(h.calls[0].path,/imports\/preview$/)
  assert.equal(h.events[0][0],'close')
})
test('commit uses explicit frozen preview id and selections, preserves full content and can safely retry an uncertain reply',async()=>{
  const h=harness(),content='甲'.repeat(10000)+'结尾'
  h.state.preview.value={id:'preview-7'};h.state.imageConfigId.value=5;h.state.videoConfigId.value=6
  h.state.sections.value=[{title:'完整剧本',content,episode_number:1,source_number:11,source_title:'第十一集',source_start:0,source_end:content.length,local_key:'only-ui'}]
  let attempt=0;h.respond(async()=>{if(!attempt++)throw new Error('network lost');return{created:1}})
  await h.state.commit();await h.state.commit()
  assert.equal(h.calls.length,2);assert.equal(JSON.stringify(h.calls[0]),JSON.stringify(h.calls[1]));assert.equal(h.calls[0].body.sections[0].content,content)
  assert.equal(h.calls[0].body.sections[0].local_key,undefined);assert.equal(h.calls[0].body.image_config_id,5);assert.equal(h.calls[0].path,'/dramas/7/imports/preview-7/commit')
  assert.equal(h.events[0][0],'imported')
})
