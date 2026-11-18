import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {parse,compileScript,compileTemplate} from '@vue/compiler-sfc'
import ts from 'typescript'
import * as vue from 'vue'

const source=readFileSync(new URL('../app/pages/admin/users.vue',import.meta.url),'utf8')
const parsed=parse(source,{filename:'admin/users.vue'})
assert.deepEqual(parsed.errors,[])
assert.deepEqual(compileTemplate({source:parsed.descriptor.template.content,filename:'admin/users.vue',id:'users'}).errors,[])
const code=ts.transpileModule(compileScript(parsed.descriptor,{id:'users'}).content,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}
const sampleUsers=()=>[{id:1,username:'admin',displayName:'管理员',role:'admin',enabled:true},{id:2,username:'creator',displayName:'创作者',role:'user',enabled:true},{id:3,username:'disabled',role:'user',enabled:false}]
function harness(){
  const notices=[],calls=[],mount=[],unmount=[],exports={},session=vue.reactive({user:{id:1,role:'admin'},revision:1})
  let rows=sampleUsers()
  const api={list:async()=>{calls.push(['list']);return rows.map(r=>({...r}))},remove:async id=>{calls.push(['remove',id]);rows=rows.filter(r=>r.id!==id);return{deleted:true,user_id:id,projects_preserved:true,history_preserved:true}},create:async()=>{throw Error('unexpected create')},update:async()=>{throw Error('unexpected update')},resetPassword:async()=>{throw Error('unexpected reset')}}
  runInNewContext(code,{exports,console,require(name){
    if(name==='vue')return{...vue,onMounted:fn=>mount.push(fn),onBeforeUnmount:fn=>unmount.push(fn)}
    if(name==='lucide-vue-next'||name==='~/components/PlatformAdminShell.vue')return{}
    if(name==='vue-sonner')return{toast:{success:x=>notices.push(['success',x]),error:x=>notices.push(['error',x])}}
    if(name==='~/composables/useApi')return{platformUserAPI:api}
    if(name==='~/utils/platform-session')return{platformSession:session}
    throw Error('Unexpected dependency '+name)
  }})
  const scope=vue.effectScope(),vm=scope.run(()=>exports.default.setup({}, {expose(){}}))
  return{vm,api,calls,notices,session,setRows:value=>{rows=value},mount:async()=>{for(const fn of mount)await fn()},dispose:()=>{for(const fn of unmount)fn();scope.stop()}}
}

test('delete controls explain preservation and do not offer deleting the current account',async t=>{
  const h=harness();t.after(h.dispose);await h.mount()
  assert.equal(h.vm.canDeleteUser(h.vm.users.value[0]),false)
  assert.equal(h.vm.canDeleteUser(h.vm.users.value[1]),true)
  assert.equal(h.vm.canDeleteUser(h.vm.users.value[2]),true)
  assert.match(source,/v-if="!isSelf\(user\)"/)
  assert.match(source,/role="alertdialog"/)
  assert.match(source,/项目、素材、任务及历史记录保留/)
})
test('opening and cancelling deletion do not send a delete request',async t=>{
  const h=harness();t.after(h.dispose);await h.mount()
  h.vm.requestDeleteUser(h.vm.users.value[1]);assert.equal(h.vm.deleteTarget.value.id,2)
  h.vm.closeDeleteUser();assert.equal(h.vm.deleteTarget.value,null)
  assert.equal(h.calls.filter(c=>c[0]==='remove').length,0)
})
test('confirmed deletion removes the exact user and refreshes the live list',async t=>{
  const h=harness();t.after(h.dispose);await h.mount()
  h.vm.requestDeleteUser(h.vm.users.value[1]);await h.vm.confirmDeleteUser()
  assert.deepEqual(h.calls.filter(c=>c[0]==='remove'),[['remove',2]])
  assert.deepEqual(h.vm.users.value.map(r=>r.id),[1,3]);assert.equal(h.vm.deleteTarget.value,null)
  assert.match(h.notices[0][1],/项目和历史记录已保留/)
})
test('duplicate confirmation and cancelling while pending do not duplicate or hide deletion',async t=>{
  const h=harness();t.after(h.dispose);await h.mount();const gate=deferred();let attempts=0
  h.api.remove=async id=>{attempts++;await gate.promise;h.setRows(sampleUsers().filter(r=>r.id!==id));return{deleted:true,user_id:id}}
  h.vm.requestDeleteUser(h.vm.users.value[1]);const pending=h.vm.confirmDeleteUser()
  await h.vm.confirmDeleteUser();h.vm.closeDeleteUser();assert.equal(attempts,1);assert.equal(h.vm.deleteTarget.value.id,2)
  gate.resolve();await pending;assert.equal(h.vm.deleteTarget.value,null)
})
test('an active-task rejection keeps the user and actionable error in the confirmation',async t=>{
  const h=harness();t.after(h.dispose);await h.mount()
  h.api.remove=async()=>{throw Error('该账号还有运行或排队中的任务，请先完成或停止任务。')}
  h.vm.requestDeleteUser(h.vm.users.value[1]);await h.vm.confirmDeleteUser()
  assert.equal(h.vm.users.value.some(r=>r.id===2),true);assert.equal(h.vm.deleteTarget.value.id,2)
  assert.match(h.vm.deleteError.value,/运行或排队/);assert.equal(h.vm.working.value,null)
})
test('a wrong deletion receipt does not optimistically remove another user',async t=>{
  const h=harness();t.after(h.dispose);await h.mount();h.api.remove=async()=>({deleted:true,user_id:3})
  h.vm.requestDeleteUser(h.vm.users.value[1]);await h.vm.confirmDeleteUser()
  assert.deepEqual(h.vm.users.value.map(r=>r.id),[1,2,3]);assert.match(h.vm.deleteError.value,/删除结果不匹配/)
})
test('an older in-flight user list cannot resurrect a successfully deleted account',async t=>{
  const h=harness();t.after(h.dispose);await h.mount();h.vm.requestDeleteUser(h.vm.users.value[1])
  const old=deferred();let reads=0;h.api.list=async()=>++reads===1?old.promise:sampleUsers().filter(r=>r.id!==2)
  const staleRead=h.vm.load();await h.vm.confirmDeleteUser();old.resolve(sampleUsers());await staleRead
  assert.deepEqual(h.vm.users.value.map(r=>r.id),[1,3])
})
test('self and last enabled administrator checks are revalidated before a delete call',async t=>{
  const h=harness();t.after(h.dispose);await h.mount();h.vm.requestDeleteUser(h.vm.users.value[0]);assert.equal(h.vm.deleteTarget.value,null)
  h.session.user.id=99;h.vm.requestDeleteUser(h.vm.users.value[0]);assert.equal(h.vm.deleteTarget.value,null)
  h.vm.users.value.push({id:4,username:'second-admin',role:'admin',enabled:true});h.vm.requestDeleteUser(h.vm.users.value[0]);assert.equal(h.vm.deleteTarget.value.id,1)
  h.vm.users.value=h.vm.users.value.filter(r=>r.id!==4);await h.vm.confirmDeleteUser();assert.equal(h.calls.filter(c=>c[0]==='remove').length,0);assert.match(h.vm.deleteError.value,/账号状态已变化/)
})
test('a deletion result cannot update another login identity or an unmounted page',async t=>{
  const h=harness();await h.mount();const gate=deferred();h.api.remove=async()=>gate.promise
  h.vm.requestDeleteUser(h.vm.users.value[1]);const pending=h.vm.confirmDeleteUser();h.session.revision++;h.dispose()
  gate.resolve({deleted:true,user_id:2});await pending;assert.equal(h.notices.length,0);assert.equal(h.vm.deleteTarget.value,null)
})
test('user deletion uses only the dedicated DELETE route',()=>{
  const api=readFileSync(new URL('../app/composables/useApi.ts',import.meta.url),'utf8')
  assert.match(api,/remove:\s*\(id: number\)\s*=>\s*api\.del<[^\n]+>\(`\/admin\/users\/\$\{id\}`\)/)
})
