import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {parse,compileScript,compileTemplate} from '@vue/compiler-sfc'
import ts from 'typescript'
import * as vue from 'vue'
import {captureExecutionBinding} from '../app/utils/execution-binding.js'
const settle=()=>new Promise(resolve=>setImmediate(resolve))
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
const sample=()=>({accounts:[{id:'one',name:'Account one',state:'ready',allow_create:true,canvases:[{id:'100',name:'Current canvas',current:true},{id:'200',name:'Explicit canvas'}]},{id:'two',name:'Account two',state:'ready',allow_create:false,canvases:[{id:'300',name:'Granted canvas'}]}],current:{id:10,version:1,account_id:'one',canvas_id:'100',state:'ready',permitted:true},pending:null,can_switch:true})
const sources={}
function harness(name,{value=sample(),props:input={projectId:1,configId:4}}={}){
 const source=sources[name]??=readFileSync(new URL('../app/components/'+name+'.vue',import.meta.url),'utf8'),parsed=parse(source,{filename:name+'.vue'});assert.deepEqual(parsed.errors,[])
 const compiled=compileScript(parsed.descriptor,{id:name}),template=compileTemplate({source:parsed.descriptor.template.content,filename:name+'.vue',id:name,compilerOptions:{bindingMetadata:compiled.bindings}});assert.deepEqual(template.errors,[])
 const code=ts.transpileModule(compiled.content,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
 const calls=[],emits=[],exports={},unmount=[],session=vue.reactive({revision:1}),props=vue.reactive(input)
 const api={get:async path=>{calls.push(['get',path]);return JSON.parse(JSON.stringify(value))},post:async(path,body)=>{calls.push(['post',path,JSON.parse(JSON.stringify(body))]);return{current:{...value.current,id:11,state:'ready'},notice:'Saved'}},put:async(path,body)=>{calls.push(['put',path,JSON.parse(JSON.stringify(body))]);return{}}}
 runInNewContext(code,{exports,console,require(id){if(id==='vue')return{...vue,onBeforeUnmount:fn=>unmount.push(fn)};if(id==='lucide-vue-next')return{};if(id==='~/composables/useApi')return{api,platformUserAPI:{list:async()=>[{id:1,username:'admin',role:'admin'},{id:2,username:'a',role:'user'},{id:3,username:'b',role:'user'}]}};if(id==='~/utils/platform-session')return{platformSession:session};throw Error(id)}})
 const scope=vue.effectScope(),vm=scope.run(()=>exports.default.setup(props,{expose(){},emit:(...args)=>emits.push(args)}))
 return{vm,api,calls,emits,session,props,source,dispose(){unmount.forEach(fn=>fn());scope.stop()}}
}
test('project picker only uses server-authorized accounts and defaults to current canvas',async t=>{const h=harness('ProjectExecutionBinding');t.after(h.dispose);await settle();assert.deepEqual(h.vm.accounts.value.map(x=>x.id),['one','two']);assert.equal(h.vm.accountId.value,'one');assert.equal(h.vm.canvasChoice.value,'100');assert.equal(h.vm.unchanged.value,true);assert.equal(h.vm.canSubmit.value,false);assert.equal(h.calls.filter(x=>x[0]==='post').length,0)})
test('selection confirmation is immutable and sends original expected route id once',async t=>{const h=harness('ProjectExecutionBinding');t.after(h.dispose);await settle();h.vm.accountId.value='two';h.vm.changeAccount();h.vm.requestBinding();assert.equal(h.vm.confirmation.value.canvas_id,'300');h.vm.accountId.value='one';const gate=deferred();h.api.post=async(path,body)=>{h.calls.push(['post',path,JSON.parse(JSON.stringify(body))]);return gate.promise};const pending=h.vm.confirmBinding();await h.vm.confirmBinding();assert.equal(h.calls.filter(x=>x[0]==='post').length,1);assert.deepEqual(h.calls.at(-1),['post','/dramas/1/execution-route',{config_id:4,account_id:'two',mode:'existing',canvas_id:'300',expected_route_id:10}]);gate.resolve({current:{id:11,state:'ready'}});await pending})
test('pending new-canvas binding resumes exact choice rather than creating a different one',async t=>{const value=sample();value.pending={id:12,account_id:'one',mode:'new',state:'preparing'};value.can_switch=false;const h=harness('ProjectExecutionBinding',{value});t.after(h.dispose);await settle();assert.equal(h.vm.canvasChoice.value,'new');assert.ok(h.vm.canSubmit.value);h.vm.requestBinding();assert.equal(h.vm.confirmation.value.mode,'new');assert.equal(h.vm.confirmation.value.expected_route_id,10);assert.equal(h.vm.confirmation.value.account_id,'one')})
test('local active work prevents switching and no permissions do not infer an account',async t=>{const value=sample();value.can_switch=false;value.blocking_tasks=[{id:9}];const h=harness('ProjectExecutionBinding',{value});t.after(h.dispose);await settle();h.vm.canvasChoice.value='new';assert.equal(h.vm.canSubmit.value,false);assert.match(h.vm.blockingDescription.value,/1/);h.vm.requestBinding();assert.equal(h.vm.confirmation.value,null);const empty=harness('ProjectExecutionBinding',{value:{accounts:[],current:null,pending:null,can_switch:true}});t.after(empty.dispose);await settle();assert.equal(empty.vm.accountId.value,'');assert.equal(empty.vm.canSubmit.value,false)})
test('older project response and identity change do not expose previous choices',async t=>{const h=harness('ProjectExecutionBinding');t.after(h.dispose);await settle();const old=deferred();h.api.get=()=>old.promise;const pending=h.vm.load();h.props.projectId=2;h.api.get=async()=>({...sample(),accounts:[],current:null});await settle();old.resolve(sample());await pending;assert.equal(h.vm.current.value,null);assert.equal(h.vm.accounts.value.length,0);h.vm.confirmation.value={identity:'2|4|1'};h.session.revision++;await settle();assert.equal(h.vm.confirmation.value,null)})
test('failed or uncertain binding refreshes original pending state and never reports success',async t=>{const h=harness('ProjectExecutionBinding');t.after(h.dispose);await settle();h.vm.canvasChoice.value='new';h.vm.requestBinding();h.api.post=async()=>{throw Error('Creation uncertain')};await h.vm.confirmBinding();assert.equal(h.vm.notice.value,'');assert.match(h.vm.error.value,/uncertain/);assert.equal(h.vm.saving.value,false)})
test('policy editor loads user IDs and writes selected account/canvas grants without secrets',async t=>{const value={accounts:[{id:'one',name:'One',state:'ready',projects:[{id:'200',name:'Allowed'}]}],policies:[{account_id:'one',enabled:true,access:'selected',user_ids:[2],allow_create:true,canvas_grants:[]}],legacy_defaults:false};const h=harness('ExecutionAccountPolicies',{value,props:{configId:4,refreshToken:0}});t.after(h.dispose);await settle();assert.equal(h.vm.creatorUsers.value.length,3);h.vm.addCanvasGrant('one');Object.assign(h.vm.drafts.one.canvas_grants[0],{canvas_id:'200',user_ids:[3]});await h.vm.save();assert.deepEqual(h.calls.at(-1),['put','/admin/execution/services/4/account-policies',{policies:[{account_id:'one',enabled:true,access:'selected',user_ids:[2],allow_create:true,canvas_grants:[{canvas_id:'200',user_ids:[3]}]}]}]);assert.match(h.vm.notice.value,/已保存/);assert.doesNotMatch(JSON.stringify(h.calls),/cookie|api_key|key_blob/)})
test('account and canvas permissions include administrator owners and preserve removable disabled users',async t=>{const value={accounts:[{id:'one',projects:[{id:'200'}]}],policies:[{account_id:'one',enabled:true,access:'selected',user_ids:[1,4],allow_create:true,canvas_grants:[{canvas_id:'200',user_ids:[1,4]}]}]};const h=harness('ExecutionAccountPolicies',{value,props:{configId:4}});t.after(h.dispose);await settle();h.vm.users.value.push({id:4,username:'disabled',role:'user',enabled:false});assert.deepEqual(h.vm.creatorUsers.value.map(user=>user.id),[1,2,3,4]);assert.equal(h.vm.creatorUsers.value[0].role,'admin');h.vm.drafts.one.user_ids=[1];h.vm.drafts.one.canvas_grants[0].user_ids=[1];await h.vm.save();const saved=h.calls.at(-1)[2].policies[0];assert.deepEqual(saved.user_ids,[1]);assert.deepEqual(saved.canvas_grants[0].user_ids,[1]);assert.match(h.source,/管理员/);assert.match(h.source,/已停用/)})
test('policy form rejects blank or duplicate canvas entries and keeps empty selected grants restricted',async t=>{const value={accounts:[{id:'one',projects:[{id:'200'}]}],policies:[],legacy_defaults:false};const h=harness('ExecutionAccountPolicies',{value,props:{configId:4}});t.after(h.dispose);await settle();assert.equal(h.vm.drafts.one.enabled,false);h.vm.addCanvasGrant('one');await h.vm.save();assert.match(h.vm.error.value,/选择已有画布/);assert.equal(h.calls.filter(x=>x[0]==='put').length,0);h.vm.drafts.one.canvas_grants=[];await h.vm.save();assert.equal(h.calls.at(-1)[2].policies[0].access,'selected');assert.deepEqual(h.calls.at(-1)[2].policies[0].user_ids,[])})
test('policy save prevents duplicates and ignores identity-switched completion',async t=>{const h=harness('ExecutionAccountPolicies',{value:{accounts:[],policies:[]},props:{configId:4}});t.after(h.dispose);await settle();const gate=deferred();let sent=0;h.api.put=()=>{sent++;return gate.promise};const pending=h.vm.save();await h.vm.save();assert.equal(sent,1);h.session.revision++;await settle();gate.resolve({});await pending;assert.equal(h.vm.notice.value,'')})
test('capturing a batch binding reads once and preserves its original id after external changes',async()=>{let reads=0;const value=sample(),api={get:async()=>{reads++;return value}};const frozen=await captureExecutionBinding(api,1,4);value.current.id=99;assert.deepEqual(frozen,{id:10,configId:4});assert.equal(reads,1)})
test('unbound pending or unauthorized project cannot send a new generation',async()=>{for(const change of [{current:null},{pending:{id:2}},{current:{id:10,state:'ready',permitted:false}}])await assert.rejects(captureExecutionBinding({get:async()=>({...sample(),...change})},1,4));let read=false;await assert.rejects(captureExecutionBinding({get:async()=>{read=true}},1,null));assert.equal(read,false)})
test('deleted project binding shows its specific reason and never submits through old route',async t=>{const value={...sample(),current:{...sample().current,permitted:false,unavailable_reason:'原项目画布绑定已删除，请选择新画布。'}};await assert.rejects(captureExecutionBinding({get:async()=>value},1,4),/绑定已删除/);const h=harness('ProjectExecutionBinding',{value});t.after(h.dispose);await settle();assert.equal(h.vm.current.value.permitted,false);assert.match(h.source,/current\.permitted !== false/);assert.match(h.source,/current\?\.unavailable_reason/)})
test('only explicit unmanaged result retains legacy generation; errors never become legacy',async()=>{assert.equal(await captureExecutionBinding({get:async()=>({managed:false})},1,4),null);for(const value of [{},{managed:true,current:null},{managed:null},{selection_available:false}])await assert.rejects(captureExecutionBinding({get:async()=>value},1,4));await assert.rejects(captureExecutionBinding({get:async()=>{throw Error('Network failure')}},1,4),/Network failure/)})
test('existing 1.2 binding can generate while selector clearly requires an upgrade',async t=>{const value={...sample(),managed:true,selection_available:false,requires_upgrade:true,accounts:[],notice:'请升级一体平台'};assert.deepEqual(await captureExecutionBinding({get:async()=>value},1,4),{id:10,configId:4});const h=harness('ProjectExecutionBinding',{value});t.after(h.dispose);await settle();assert.equal(h.vm.selectionAvailable.value,false);assert.equal(h.vm.current.value.id,10);assert.equal(h.vm.canSubmit.value,false);assert.match(h.vm.selectionNotice.value,/升级/);const legacy=harness('ProjectExecutionBinding',{value:{managed:false,selection_available:false,accounts:[]}});t.after(legacy.dispose);await settle();assert.equal(legacy.vm.managed.value,false);assert.equal(legacy.vm.error.value,'');assert.equal(legacy.vm.canSubmit.value,false)})
test('episode wires one shared picker and freezes binding metadata for single and batch paths',()=>{const source=readFileSync(new URL('../app/views/drama/episode.vue',import.meta.url),'utf8');assert.match(source,/<ProjectExecutionBinding v-if="isJimengVideo/);assert.match(source,/const binding = wasJimeng \? await captureExecutionBinding/);assert.match(source,/executionBinding: binding/);assert.match(source,/execution_project_route_id: executionBinding.id/);assert.match(source,/prompt: resolveVideoPromptRefs\(sb\)/);assert.match(readFileSync(new URL('../app/pages/admin/execution.vue',import.meta.url),'utf8'),/<ExecutionFeatureAccess/)})

test('feature denial disables both selection and self-service actions',async t=>{
 const h=harness('ProjectExecutionBinding',{value:{...sample(),feature_allowed:false}});t.after(h.dispose);await settle()
 h.vm.canvasChoice.value='200';assert.equal(h.vm.canSubmit.value,false);assert.equal(h.vm.canCreate.value,false)
 h.vm.openNewCanvas();assert.equal(h.vm.nameDialog.value,null);assert.equal(h.calls.filter(x=>x[0]==='post').length,0)
})
test('new canvas keeps Unicode name and original expected route while duplicate clicks submit once',async t=>{
 const h=harness('ProjectExecutionBinding',{props:{projectId:1,configId:4,projectTitle:'第一部作品'}});t.after(h.dispose);await settle()
 h.vm.openNewCanvas();assert.equal(h.vm.canvasName.value,'第一部作品');h.vm.closeNameDialog();assert.equal(h.calls.filter(x=>x[0]==='post').length,0)
 h.vm.openNewCanvas();h.vm.canvasName.value='夜景🌙 · 第一集';const gate=deferred();h.api.post=async(path,body)=>{h.calls.push(['post',path,JSON.parse(JSON.stringify(body))]);return gate.promise}
 const pending=h.vm.submitCanvasName();await h.vm.submitCanvasName()
 assert.deepEqual(h.calls.filter(x=>x[0]==='post'),[['post','/dramas/1/execution-route',{config_id:4,account_id:'one',mode:'new',canvas_name:'夜景🌙 · 第一集',expected_route_id:10}]])
 gate.resolve({current:{id:11,state:'ready'}});await pending
})
test('name validation counts Unicode characters, rejects overlong and control text without truncation',async t=>{
 const h=harness('ProjectExecutionBinding');t.after(h.dispose);await settle();h.vm.openNewCanvas();h.vm.canvasName.value='🌙'.repeat(50);assert.equal(h.vm.validCanvasName.value,true)
 h.vm.canvasName.value='字'.repeat(51);await h.vm.submitCanvasName();assert.equal(h.vm.canvasName.value.length,51);assert.match(h.vm.nameError.value,/50/)
 h.vm.canvasName.value='第一\n第二';assert.equal(h.vm.validCanvasName.value,false);await h.vm.submitCanvasName();assert.equal(h.calls.filter(x=>x[0]==='post').length,0)
})
test('rename requires explicit permission and validates identity in its receipt',async t=>{
 const value=sample();value.accounts[0].canvases[0].can_rename=true
 const h=harness('ProjectExecutionBinding',{value});t.after(h.dispose);await settle();assert.equal(h.vm.canRename.value,true)
 h.vm.openRenameCanvas();h.vm.canvasName.value='旧画布新名称'
 h.api.post=async(path,body)=>{h.calls.push(['post',path,body]);return{renamed:true,account_id:'one',canvas_id:'WRONG',name:body.name}}
 await h.vm.submitCanvasName();assert.match(h.vm.nameError.value,/不一致/);assert.equal(h.vm.notice.value,'');assert.ok(h.vm.nameDialog.value)
 h.api.post=async(path,body)=>{h.calls.push(['post',path,body]);return{renamed:true,account_id:'one',canvas_id:'100',name:body.name}}
 await h.vm.submitCanvasName();assert.equal(h.vm.nameDialog.value,null);assert.match(h.vm.notice.value,/已更新/)
 assert.deepEqual(JSON.parse(JSON.stringify(h.calls.filter(x=>x[0]==='post').at(-1))),['post','/dramas/1/execution-canvas/rename',{config_id:4,account_id:'one',canvas_id:'100',name:'旧画布新名称',expected_name:'Current canvas'}])
 h.vm.canvasChoice.value='200';assert.equal(h.vm.canRename.value,false)
})
test('project/session switch closes a pending name dialog and ignores stale rename completion',async t=>{
 const value=sample();value.accounts[0].canvases[0].can_rename=true
 const h=harness('ProjectExecutionBinding',{value});t.after(h.dispose);await settle();h.vm.openRenameCanvas();h.vm.canvasName.value='新名称'
 const gate=deferred();h.api.post=()=>gate.promise;const request=h.vm.submitCanvasName();h.session.revision++;await settle();assert.equal(h.vm.nameDialog.value,null)
 gate.resolve({renamed:true,account_id:'one',canvas_id:'100',name:'新名称'});await request;assert.equal(h.vm.notice.value,'')
})
test('feature access form preserves legacy until explicit choice and saves selected users once',async t=>{
 const value={access:'legacy',user_ids:[],users:[{id:1,username:'admin',role:'admin',enabled:true},{id:2,username:'editor',role:'user',enabled:true}]}
 const h=harness('ExecutionFeatureAccess',{value,props:{configId:4}});t.after(h.dispose);await settle();await h.vm.save();assert.equal(h.calls.filter(x=>x[0]==='put').length,0)
 h.vm.access.value='selected';h.vm.userIds.value=[2];const gate=deferred();h.api.put=async(path,body)=>{h.calls.push(['put',path,body]);return gate.promise};const request=h.vm.save();await h.vm.save();assert.equal(h.calls.filter(x=>x[0]==='put').length,1)
 assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1))),['put','/admin/execution/services/4/user-access',{access:'selected',user_ids:[2]}]);gate.resolve({});await request;assert.match(h.vm.notice.value,/已保存/)
})
test('unassigned historical canvas is selected by user without an admin adoption request',async t=>{
 const value=sample();value.accounts[0].canvases.push({id:'500',name:'旧剧本画布',history_unassigned:true})
 const h=harness('ProjectExecutionBinding',{value});t.after(h.dispose);await settle();h.vm.canvasChoice.value='500';h.vm.requestBinding()
 assert.equal(h.vm.confirmation.value.historyUnassigned,true);assert.match(h.source,/这张画布已有内容/)
 await h.vm.confirmBinding();assert.deepEqual(h.calls.filter(call=>call[0]==='post'),[['post','/dramas/1/execution-route',{config_id:4,account_id:'one',mode:'existing',canvas_id:'500',expected_route_id:10}]])
})
test('admin connection page has only service connection and global feature access controls',()=>{
 const source=readFileSync(new URL('../app/pages/admin/execution.vue',import.meta.url),'utf8'),parsed=parse(source,{filename:'execution.vue'})
 assert.deepEqual(parsed.errors,[]);const script=compileScript(parsed.descriptor,{id:'minimal-admin-execution'})
 assert.deepEqual(compileTemplate({source:parsed.descriptor.template.content,filename:'execution.vue',id:'minimal-admin-execution',compilerOptions:{bindingMetadata:script.bindings}}).errors,[])
 assert.match(source,/<ExecutionFeatureAccess/)
 assert.doesNotMatch(source,/ExecutionAccountPolicies|adopt-canvas|provision|reauthorize|项目绑定检查|接入已有历史画布|新项目默认账号/)
 assert.match(source,/readyAccounts\.value\[0\]\?\.id/)
 assert.match(source,/enabled:true/)
})
