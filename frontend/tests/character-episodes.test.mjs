import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {parse,compileScript,compileTemplate} from '@vue/compiler-sfc'
import {renderToString} from '@vue/server-renderer'
import ts from 'typescript'
import * as vue from 'vue'

const file=new URL('../app/components/CharacterEpisodes.vue',import.meta.url)
const {descriptor}=parse(readFileSync(file,'utf8'),{filename:file.pathname})
const script=compileScript(descriptor,{id:'character-episodes-test'})
const js=value=>ts.transpileModule(value,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const template=compileTemplate({source:descriptor.template.content,filename:file.pathname,id:'character-episodes-test',compilerOptions:{bindingMetadata:script.bindings}})
assert.deepEqual(template.errors,[])
const rendered={}
runInNewContext(js(template.code),{exports:rendered,require(name){assert.equal(name,'vue');return vue}})
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}
const answer=(character=7,drama=3,episodes=[])=>({character_id:character,drama_id:drama,total:new Set(episodes.map(row=>row.id)).size,episodes})
const row=(id,number,title='测试集')=>({id,episode_number:number,title,sources:['episode_link']})
const flush=async()=>{await new Promise(resolve=>setImmediate(resolve));await vue.nextTick()}
function harness({characterId=7,dramaId=3,respond=async()=>answer(Number(characterId),Number(dramaId))}={}){
  const props=vue.reactive({characterId,dramaId}),calls=[],hooks=[],exports={},events=[]
  let responder=respond
  const icons=new Proxy({},{get:(_target,name)=>({name:String(name),render:()=>null})})
  runInNewContext(js(script.content),{exports,require(name){
    if(name==='vue')return{...vue,onBeforeUnmount:callback=>hooks.push(callback)}
    if(name==='lucide-vue-next')return icons
    if(name==='~/composables/useApi')return{api:{get:async path=>{calls.push({method:'GET',path});return responder(path)}}}
    throw new Error('Unexpected import '+name)
  },console})
  const scope=vue.effectScope(),state=scope.run(()=>exports.default.setup(props,{expose(){},emit:(...value)=>events.push(value)}))
  return{props,state,calls,events,respond:fn=>responder=fn,dispose(){for(const callback of hooks)callback();scope.stop()}}
}
async function render(h){
  let tree
  const html=await renderToString(vue.h({render(){tree=rendered.render(this,[],h.props,vue.proxyRefs(h.state),{},{});return tree}}),{})
  const anchors=[]
  const walk=node=>{if(!node||typeof node!=='object')return;if(node.type==='a')anchors.push(node);if(Array.isArray(node.children))node.children.forEach(walk)}
  walk(tree);return{html,anchors}
}

test('loads exact character usage once and renders safe new-tab links using episode numbers rather than database ids',async()=>{
  const wait=deferred(),h=harness({respond:()=>wait.promise})
  assert.equal(h.state.loading.value,true);assert.deepEqual(h.calls,[{method:'GET',path:'/characters/7/episodes'}])
  wait.resolve(answer(7,3,[row(812,12,'重逢'),row(304,2,'归来'),{...row(304,2,'归来'),sources:['storyboard_binding']}]))
  await flush()
  assert.equal(h.state.loading.value,false);assert.equal(h.state.loaded.value,true)
  assert.deepEqual(Array.from(h.state.episodes.value,ep=>ep.episode_number),[2,12])
  const view=await render(h)
  assert.match(view.html,/出现集数/);assert.match(view.html,/共 2 集/)
  assert.deepEqual(view.anchors.map(a=>a.props.href),['/drama/3/episode/2','/drama/3/episode/12'])
  for(const anchor of view.anchors){assert.equal(anchor.props.target,'_blank');assert.equal(anchor.props.rel,'noopener noreferrer');assert.match(anchor.props['aria-label'],/新页打开/)}
  assert.equal(h.events.length,0);assert.equal(h.props.characterId,7);h.dispose()
})

test('rapid role changes ignore late responses and an A-B-A switch shares an already running read',async()=>{
  const a=deferred(),b=deferred(),h=harness({respond:path=>path.includes('/7/')?a.promise:b.promise})
  h.props.characterId=8;assert.equal(h.calls.length,2);assert.equal(h.state.episodes.value.length,0)
  h.props.characterId=7;assert.equal(h.calls.length,2,'A still has the same in-flight GET')
  b.resolve(answer(8,3,[row(80,8)]));await flush();assert.equal(h.state.episodes.value.length,0)
  a.resolve(answer(7,3,[row(70,7)]));await flush()
  assert.deepEqual(Array.from(h.state.episodes.value,ep=>ep.id),[70]);assert.equal(h.state.error.value,'');h.dispose()
})

test('manual refresh is single-flight and performs no polling or model mutations',async()=>{
  const first=deferred(),second=deferred();let reads=0
  const h=harness({respond:()=>++reads===1?first.promise:second.promise})
  const duplicate=h.state.load();assert.equal(h.calls.length,1)
  first.resolve(answer(7,3,[row(10,1)]));await duplicate;await flush()
  assert.equal(h.state.episodes.value.length,1)
  const refresh=h.state.load(),again=h.state.load();assert.equal(h.calls.length,2)
  second.resolve(answer(7,3,[row(10,1),row(20,4)]));await Promise.all([refresh,again]);await flush()
  assert.equal(h.state.episodes.value.length,2);assert.ok(h.calls.every(call=>call.method==='GET'));assert.equal(h.events.length,0);h.dispose()
})

test('read failure is visible and an explicit retry can recover without claiming zero appearances',async()=>{
  const h=harness({respond:async()=>{throw new Error('网络读取失败')}});await flush()
  assert.equal(h.state.loading.value,false);assert.equal(h.state.loaded.value,false);assert.equal(h.state.error.value,'网络读取失败')
  let view=await render(h);assert.match(view.html,/role="alert"/);assert.match(view.html,/重试/);assert.doesNotMatch(view.html,/共 0 集/)
  h.respond(async()=>answer(7,3,[row(4,4)]));await h.state.load();await flush()
  assert.equal(h.state.error.value,'');assert.equal(h.state.episodes.value.length,1);h.dispose()
})

test('empty usage honestly means no recorded association, with no inference from role names or script text',async()=>{
  const h=harness();await flush();const view=await render(h)
  assert.match(view.html,/尚未关联剧集/);assert.match(view.html,/按项目已关联剧集统计/);assert.match(view.html,/共 0 集/)
  assert.doesNotMatch(view.html,/从未出现|该角色未出场|没有出场/);assert.equal(view.anchors.length,0);assert.equal(h.calls.length,1);h.dispose()
})

test('invalid unsaved ids never issue a request and switching a valid character to invalid ids clears stale links',async()=>{
  for(const characterId of [0,-1,'1e2','../7','',null]){const h=harness({characterId});await flush();assert.equal(h.calls.length,0);assert.equal(h.state.loading.value,false);const view=await render(h);assert.match(view.html,/保存角色后/);h.dispose()}
  const h=harness({respond:async()=>answer(7,3,[row(9,9)])});await flush();assert.equal(h.state.episodes.value.length,1)
  h.props.dramaId=0;await flush();assert.equal(h.state.episodes.value.length,0);assert.equal(h.calls.length,1);h.dispose()
})

test('unmounting or closing the material dialog ignores a pending result and further calls',async()=>{
  const reply=deferred(),h=harness({respond:()=>reply.promise});h.dispose()
  reply.resolve(answer(7,3,[row(99,99)]));await flush();assert.equal(h.state.episodes.value.length,0);assert.equal(h.state.loaded.value,false)
  await h.state.load();assert.equal(h.calls.length,1)
})

test('mismatched identity, invalid records and inconsistent totals never render foreign or partial episode data',async()=>{
  const cases=[answer(8,3,[row(6,6)]),answer(7,9,[row(6,6)]),{...answer(7,3,[row(6,6)]),total:2},answer(7,3,[row(6,0)]),answer(7,3,[{id:6,episode_number:6,title:null}])]
  for(const value of cases){const h=harness({respond:async()=>value});await flush();assert.ok(h.state.error.value);assert.equal(h.state.loaded.value,false);assert.equal((await render(h)).anchors.length,0);h.dispose()}
})

test('hundreds of recorded episodes remain accessible and the compact list scrolls instead of truncating the data',async()=>{
  const episodes=Array.from({length:150},(_,i)=>row(1000+i,i+1,'集 '+(i+1)))
  const h=harness({respond:async()=>answer(7,3,episodes)});await flush();const view=await render(h)
  assert.equal(h.state.episodes.value.length,150);assert.equal(view.anchors.length,150);assert.match(view.html,/共 150 集/)
  assert.equal(view.anchors.at(-1).props.href,'/drama/3/episode/150');assert.match(descriptor.styles[0].content,/max-height:180px/);assert.match(descriptor.styles[0].content,/overflow:auto/);h.dispose()
})
