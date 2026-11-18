import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {parse,compileScript,compileTemplate} from '@vue/compiler-sfc'
import ts from 'typescript'
import * as vue from 'vue'

const source=readFileSync(new URL('../app/pages/admin/channels.vue',import.meta.url),'utf8')
const parseComponent=(text,name)=>{const parsed=parse(text,{filename:name});assert.deepEqual(parsed.errors,[]);const compiled=compileScript(parsed.descriptor,{id:name});assert.deepEqual(compileTemplate({source:parsed.descriptor.template.content,filename:name,id:name,compilerOptions:{bindingMetadata:compiled.bindings}}).errors,[]);return ts.transpileModule(compiled.content,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText}
const code=parseComponent(source,'admin/channels.vue')
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes});return{promise,resolve}}
const clone=value=>JSON.parse(JSON.stringify(value))
const initial=()=>[
 {id:1,name:'First',enabled:true,models:[{id:11,type:'text',model:'text-a',protocol_id:'text.chat',enabled:true,priority:90,is_default:true},{id:12,type:'image',model:'image-a',protocol_id:'image.openai',enabled:true,priority:5,is_default:true}]},
 {id:2,name:'Second',enabled:true,models:[{id:21,type:'text',model:'text-b',protocol_id:'text.chat',enabled:true,priority:2,is_default:false},{id:22,type:'video',model:'video-a',protocol_id:'video.native',enabled:true,priority:1,is_default:false}]},
]
const protocolRows=[{id:'text.chat',type:'text',name:'Chat',executable:true},{id:'image.openai',type:'image',name:'Images',executable:true},{id:'video.native',type:'video',name:'Native',executable:true},{id:'video.disabled',type:'video',name:'Soon',executable:false}]
function harness(){
 const calls=[],notices=[],unmount=[],exports={};let rows=initial()
 const api={list:async()=>({channels:clone(rows),protocols:clone(protocolRows)}),setDefault:async(channelId,modelId)=>{calls.push(['default',channelId,modelId]);const model=rows.find(c=>c.id===channelId).models.find(m=>m.id===modelId);for(const c of rows)for(const m of c.models)if(m.type===model.type)m.is_default=m.id===modelId;return clone(model)},updateModel:async(channelId,id,body)=>{calls.push(['update',channelId,id,clone(body)]);return{}},createModel:async(channelId,body)=>{calls.push(['create',channelId,clone(body)]);return{}}}
 runInNewContext(code,{exports,console,useRoute:()=>({query:{}}),window:{addEventListener(){},removeEventListener(){},confirm:()=>true},require(name){
  if(name==='vue')return{...vue,onMounted(){},onBeforeUnmount:fn=>unmount.push(fn)}
  if(name==='lucide-vue-next'||name.startsWith('~/components/'))return{}
  if(name==='vue-sonner')return{toast:{success:x=>notices.push(['success',x]),error:x=>notices.push(['error',x])}}
  if(name==='~/composables/useApi')return{channelAPI:api,platformUserAPI:{list:async()=>[{id:1,username:'admin'}]}}
  throw Error('Unexpected dependency '+name)
 }})
 const scope=vue.effectScope(),vm=scope.run(()=>exports.default.setup({}, {expose(){}}))
 return{vm,api,calls,notices,getRows:()=>rows,setRows:x=>{rows=x},dispose(){for(const fn of unmount)fn();scope.stop()}}
}
test('three independent default summaries use explicit flags and leave priority unchanged',async t=>{
 const h=harness();t.after(h.dispose);await h.vm.load()
 assert.deepEqual(Array.from(h.vm.defaultModels.value,x=>[x.type,x.model?.id||null]),[['text',11],['image',12],['video',null]])
 h.vm.selectedId.value=2;await h.vm.setDefaultModel(h.vm.selectedModels.value[0])
 assert.deepEqual(h.calls,[['default',2,21]])
 assert.equal(h.vm.defaultModels.value[0].model.id,21);assert.equal(h.vm.defaultModels.value[1].model.id,12)
 assert.deepEqual(h.getRows().map(c=>c.models.map(m=>m.priority)),[[90,5],[2,1]])
 assert.match(h.notices.at(-1)[1],/已有选择保持不变/)
})
test('default action does not send duplicate, already-default, disabled or unavailable requests',async t=>{
 const h=harness();t.after(h.dispose);await h.vm.load();await h.vm.setDefaultModel(h.vm.selectedModels.value[0]);assert.equal(h.calls.length,0)
 for(const patch of [{enabled:false},{protocol_id:'missing'},{protocol_id:'video.disabled'}]){const m={...h.vm.selectedModels.value[1],is_default:false,...patch};await h.vm.setDefaultModel(m)}
 h.vm.selected.value.enabled=false;await h.vm.setDefaultModel({...h.vm.selectedModels.value[1],is_default:false});assert.equal(h.calls.length,0)
 h.vm.selected.value.enabled=true;h.vm.selectedId.value=2;const gate=deferred();let sent=0
 h.api.setDefault=async()=>{sent++;return gate.promise};const m=h.vm.selectedModels.value[0],pending=h.vm.setDefaultModel(m);await h.vm.setDefaultModel(m);assert.equal(sent,1);gate.resolve({id:21,is_default:true});await pending
})
test('failed or mismatched default receipt never displays success or flips a local flag',async t=>{
 const h=harness();t.after(h.dispose);await h.vm.load();h.vm.selectedId.value=2
 h.api.setDefault=async()=>{throw Error('账户权限更新中')};await h.vm.setDefaultModel(h.vm.selectedModels.value[0]);assert.equal(h.vm.defaultModels.value[0].model.id,11);assert.equal(h.notices[0][0],'error')
 h.api.setDefault=async()=>({id:99,is_default:true});await h.vm.setDefaultModel(h.vm.selectedModels.value[0]);assert.match(h.notices.at(-1)[1],/结果不匹配/);assert.equal(h.vm.workingModel.value,null)
})
test('default request binds original channel when selection changes and ignores unmounted response',async t=>{
 const h=harness();await h.vm.load();h.vm.selectedId.value=2;const gate=deferred();h.api.setDefault=async(id,model)=>{h.calls.push([id,model]);return gate.promise};const pending=h.vm.setDefaultModel(h.vm.selectedModels.value[0]);h.vm.selectedId.value=1;h.dispose();gate.resolve({id:21,is_default:true});await pending;assert.deepEqual(h.calls,[[2,21]]);assert.equal(h.notices.length,0)
})
test('model editor is centered and keeps all model fields and explicit default explanation',()=>{
 assert.match(source,/class="overlay channel-drawer-overlay model-dialog-overlay"/)
 assert.match(source,/\.model-dialog-overlay\{align-items:center;justify-content:center/)
 assert.match(source,/height:min\(900px,calc\(100dvh - 48px\)\)/)
 assert.match(source,/ModelProtocolPicker v-model="modelForm.protocol_id" :options="modelProtocols"/)
 assert.doesNotMatch(source,/<select aria-label="请求协议"/)
 for(const field of ['name','model','type','priority','enabled','access','allowed_user_ids','capabilitiesText','defaultsText'])assert.ok(source.includes('modelForm.'+field))
 assert.match(source,/默认模型与默认参数是两回事/);assert.match(source,/用户须已获该模型授权/)
})
test('editing and saving preserves original protocol, capability values, defaults and access',async t=>{
 const h=harness();t.after(h.dispose);await h.vm.load()
 h.vm.editModel({id:11,name:'Text',model:'text-a',type:'text',protocol_id:'text.chat',priority:90,enabled:true,access:'selected',allowed_user_ids:[8],capabilities:{tools:true},defaults:{temperature:0.4}})
 assert.equal(h.vm.modelForm.protocol_id,'text.chat');await h.vm.saveModel()
 assert.deepEqual(h.calls[0],['update',1,11,{name:'Text',model:'text-a',type:'text',protocol_id:'text.chat',priority:90,enabled:true,access:'selected',allowed_user_ids:[8],capabilities:{tools:true},defaults:{temperature:0.4}}])
})
test('model saving rejects missing, wrong-type and disabled protocol before sending request',async t=>{
 const h=harness();t.after(h.dispose);await h.vm.load();h.vm.editModel(null,{type:'video',model:'video-a',name:'Video'})
 for(const id of ['','text.chat','video.disabled']){h.vm.modelForm.protocol_id=id;await h.vm.saveModel();assert.ok(h.vm.modelError.value);assert.equal(h.vm.modelOpen.value,true)}
 assert.equal(h.calls.length,0);h.vm.modelForm.protocol_id='video.native';await h.vm.saveModel();assert.equal(h.calls[0][0],'create')
})
test('model editor cannot close or duplicate-submit while save is pending',async t=>{
 const h=harness();t.after(h.dispose);await h.vm.load();h.vm.editModel(null,{type:'video',protocol_id:'video.native',model:'v',name:'V'});const gate=deferred();let count=0;h.api.createModel=async()=>{count++;return gate.promise};const pending=h.vm.saveModel();h.vm.closeModel();await h.vm.saveModel();assert.equal(h.vm.modelOpen.value,true);assert.equal(count,1);gate.resolve({});await pending;assert.equal(h.vm.modelOpen.value,false)
})
test('default API wrapper uses an explicit admin default endpoint without changing binding fields',()=>{
 const apiSource=readFileSync(new URL('../app/composables/useApi.ts',import.meta.url),'utf8');assert.match(apiSource,/setDefault: \(id: number, modelId: number\) => api\.post\(`\/admin\/channels\/\$\{id\}\/models\/\$\{modelId\}\/default`, \{\}\)/)
})

const pickerSource=readFileSync(new URL('../app/components/ModelProtocolPicker.vue',import.meta.url),'utf8')
const pickerCode=parseComponent(pickerSource,'ModelProtocolPicker.vue')
test('protocol picker searches name, provider and original ID and only emits executable selection',async()=>{
 const exports={},emits=[],props=vue.reactive({modelValue:'image.openai',kind:'image',options:[{id:'image.openai',name:'OpenAI Images',provider:'openai',description:'同步图片',parameters:[{key:'quality',label:'质量'}],capabilities:{reference_images:true,stream:false},source:'builtin'},{id:'image.async',name:'异步图片',provider:'relay',executable:true,provider_id:'upstream-images',plugin_id:'image-plugin',plugin_version:'2.1',source:'imported'},{id:'image.soon',name:'尚未实现',executable:false}]})
 runInNewContext(pickerCode,{exports,require(name){if(name==='vue')return vue;if(name==='lucide-vue-next')return{};throw Error(name)}})
 const scope=vue.effectScope(),vm=scope.run(()=>exports.default.setup(props,{expose(){},emit:(...args)=>emits.push(args)}))
 try{vm.search.value='OPENAI';assert.equal(vm.visible.value.length,1);assert.equal(vm.visible.value[0].id,'image.openai');assert.equal(vm.parameterLabels.value[0],'质量');assert.deepEqual(Array.from(vm.declaredCapabilities.value,item=>[item.key,item.value]),[['stream','不支持'],['reference_images','支持']]);assert.equal(vm.originLabel(props.options[0]),'内置协议');assert.equal(vm.originLabel(props.options[1]),'导入协议');vm.search.value='image-plugin';assert.equal(vm.visible.value[0].id,'image.async');vm.search.value='async';assert.equal(vm.visible.value[0].id,'image.async');vm.choose(props.options[2]);assert.equal(emits.length,0);vm.choose(props.options[1]);assert.deepEqual(emits,[['update:modelValue','image.async'],['change','image.async']]);props.modelValue='image.async';assert.equal(vm.declaredCapabilities.value.length,0,'missing capability flags must not become false');props.kind='video';await vue.nextTick();assert.equal(vm.search.value,'');assert.match(pickerSource,/:disabled="protocol.executable === false"/);assert.match(pickerSource,/已有配置不会被自动替换/);for(const metadata of ['plugin_id','plugin_version','provider_id'])assert.ok(pickerSource.includes('selected.'+metadata))}finally{scope.stop()}
})
