import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { renderToString } from '@vue/server-renderer'
import ts from 'typescript'
import * as vue from 'vue'
import * as helpers from '../app/utils/request-logs.js'

const js = source => ts.transpileModule(source, { compilerOptions:{ module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022 } }).outputText
const deferred = () => { let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject} }
const flush = async () => { await new Promise(resolve=>setImmediate(resolve));await vue.nextTick() }
const result = items => ({items,total:120,counts:{running:1,succeeded:2,failed:3},options:{users:[{id:7,username:'user-seven'}],models:['model-seven'],channels:[{id:8,name:'channel-eight'}]}})

function component(relative,{api={},props={},routeQuery={},now}={}) {
  const file=new URL('../app/'+relative,import.meta.url),{descriptor}=parse(readFileSync(file,'utf8'),{filename:file.pathname})
  const script=compileScript(descriptor,{id:'request-logs-test'}),template=compileTemplate({source:descriptor.template.content,filename:file.pathname,id:'request-logs-test',compilerOptions:{bindingMetadata:script.bindings}})
  assert.deepEqual(template.errors,[])
  const route=vue.reactive({path:'/admin/requests',query:routeQuery}),mounts=[],unmounts=[],timers=[],replaces=[],emits=[],toasts=[],module={},icons=new Proxy({},{get:()=>({render:()=>vue.h('i')})})
  const clock={value:now??Date.now()},Clock=now===undefined?Date:class extends Date {static now(){return clock.value}}
  const timer=(fn,delay,repeat)=>{const entry={fn,delay,repeat,active:true};timers.push(entry);return timers.length}
  const clear=id=>{if(timers[id-1])timers[id-1].active=false}
  const router={async replace(value){replaces.push(value);route.query=value.query}}
  const fakeVue={...vue,onMounted:fn=>mounts.push(fn),onBeforeUnmount:fn=>unmounts.push(fn)}
  runInNewContext(js(script.content),{
    exports:module,require(name){
      if(name==='vue')return fakeVue
      if(name==='lucide-vue-next')return icons
      if(name==='vue-sonner')return{toast:{success:x=>toasts.push(x),error:x=>toasts.push(x)}}
      if(name==='~/utils/request-logs.js')return helpers
      if(name==='~/composables/useRequestLogs')return{requestLogAPI:{list:api.list|| (async()=>result([])),detail:api.detail|| (async id=>({request:{id}})),exportUrl:()=>'/api/v1/admin/requests/export',detailExportUrl:id=>'/api/v1/admin/requests/'+id+'/export'},downloadRequestLog:api.download|| (async()=>{})}
      if(name==='~/components/PlatformAdminShell.vue')return{default:{setup:(_,ctx)=>()=>vue.h('main',ctx.slots.default?.())}}
      if(name==='~/components/RequestLogDetail.vue')return{default:{render:()=>null}}
      throw Error('Unexpected request UI dependency: '+name)
    },useRoute:()=>route,useRouter:()=>router,AbortController,URLSearchParams,Date:Clock,console,
    document:{visibilityState:'visible',activeElement:{isConnected:true,focus(){}}},navigator:{clipboard:{writeText:async value=>toasts.push(value)}},
    setInterval:(fn,delay)=>timer(fn,delay,true),clearInterval:clear,setTimeout:(fn,delay)=>timer(fn,delay,false),clearTimeout:clear,
  })
  const scope=vue.effectScope(),reactiveProps=vue.reactive(props),state=scope.run(()=>module.default.setup(reactiveProps,{expose(){},emit:(...args)=>emits.push(args)}))
  const templateModule={};runInNewContext(js(template.code),{exports:templateModule,require:()=>vue})
  return{state,props:reactiveProps,route,replaces,emits,toasts,timers,clock,activeTimers:()=>timers.filter(t=>t.active),runTimer(delay){const t=timers.find(t=>t.active&&(delay===undefined||t.delay===delay));assert.ok(t,'expected active timer');if(!t.repeat)t.active=false;return t.fn()},async mount(){for(const fn of mounts)await fn();await flush()},async render(){const app=vue.createSSRApp({setup:()=>state,render:templateModule.render});app.component('NuxtLink',{props:['to'],setup:(props,ctx)=>()=>vue.h('a',{href:props.to},ctx.slots.default?.())});app.config.warnHandler=()=>{};const context={},html=await renderToString(app,context);return html+Object.values(context.teleports||{}).join('')},dispose(){for(const fn of unmounts)fn();scope.stop()}}
}

test('request filters encode all actual server conditions and ignore unrecognized transport fields',()=>{
  const filters=helpers.normalizeRequestFilters({user_id:'7',channel_id:'8',model:'gpt/model & one',kind:'image',phase:'all',status:'failed',q:'用户名 / request #1',limit:100,offset:200,api_key:'must-not-enter-url'})
  const params=helpers.requestFilterParams(filters)
  assert.equal(params.get('user_id'),'7');assert.equal(params.get('channel_id'),'8');assert.equal(params.get('phase'),'all');assert.equal(params.get('limit'),'100');assert.equal(params.get('offset'),'200')
  assert.equal(params.get('q'),'用户名 / request #1');assert.equal(params.get('model'),'gpt/model & one');assert.equal(params.has('api_key'),false)
  assert.equal(helpers.normalizeRequestFilters({}).phase,'generate')
  assert.equal(helpers.normalizeRequestFilters({user_id:['7','8'],limit:-1,offset:-2,phase:'invented'}).user_id,'')
  assert.equal(helpers.normalizeRequestFilters({limit:999}).limit,50)
})

test('date filters consistently interpret Beijing time and reject invalid or reversed intervals',()=>{
  assert.equal(helpers.fromBeijingInput('2026-11-09T23:30'),'2026-11-09T15:30:00.000Z')
  assert.equal(helpers.toBeijingInput('2026-11-09T15:30:00Z'),'2026-11-09T23:30')
  assert.equal(helpers.formatRequestTime('2026-11-09T15:30:00Z',true),'2026/11/09 23:30:00')
  assert.throws(()=>helpers.fromBeijingInput('2026-02-31T12:00'))
  assert.throws(()=>helpers.requestFilterParams({from:'2026-11-10T00:00:00Z',to:'2026-11-09T00:00:00Z'}),/开始时间/)
})

test('unknown timings and internal checks are not labeled as real generated results',()=>{
  assert.equal(helpers.formatRequestSeconds(null),'未记录');assert.equal(helpers.formatRequestSeconds(0),'0 秒');assert.equal(helpers.formatRequestSeconds(323),'0.323 秒')
  assert.equal(helpers.requestStatusLabel('succeeded'),'请求成功')
  assert.equal(helpers.requestStatusLabel('failed',{method:'INTERNAL'}),'检查未通过')
  assert.equal(helpers.requestStatusLabel('unknown'),'结果待核实')
  assert.equal(helpers.normalizeRequestFilters({status:'unknown'}).status,'unknown')
  assert.equal(helpers.requestStatusLabel('invented'),'状态未记录')
})

test('payload text and related links preserve exact readable content without inventing missing identifiers',()=>{
  const value={messages:[{role:'system',content:'规则\n保留'}],image:[{name:'1.png'},{name:'2.png'}]}
  const before=JSON.stringify(value)
  assert.equal(helpers.requestBodyText(value),JSON.stringify(value,null,2));assert.equal(JSON.stringify(value),before)
  assert.equal(helpers.requestBodyText(' a\n b '),' a\n b ');assert.equal(helpers.requestBodyText(null),'')
  assert.equal(helpers.requestTaskLink({}), '');assert.equal(helpers.requestChannelLink({}), '')
  const link=helpers.requestTaskLink({task_id:'task/a & b',round_id:'round-3',project_id:9})
  assert.equal(new URL(link,'http://fixture').searchParams.get('task_id'),'task/a & b')
  assert.match(helpers.requestChannelLink({channel_id:8,config_id:10}),/channel_id=8&config_id=10/)
})

test('token display accepts actual OpenAI and Responses usage including real zero without changing the body',()=>{
  const body={usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20}},before=JSON.stringify(body)
  assert.deepEqual(helpers.requestTokenUsage(body),{input:12,output:8,total:20})
  assert.equal(JSON.stringify(body),before)
  assert.deepEqual(helpers.requestTokenUsage({response:{usage:{input_tokens:0,output_tokens:3,total_tokens:3}}}),{input:0,output:3,total:3})
  assert.deepEqual(helpers.requestTokenUsage('{"usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}'),{input:2,output:1,total:3})
})

test('streamed usage takes the latest recorded fields instead of adding repeated frame snapshots',()=>{
  const body={event_stream:[{usage:{prompt_tokens:50,completion_tokens:4,total_tokens:54}},{response:{usage:{input_tokens:50,output_tokens:7,total_tokens:57}}},'[DONE]']}
  assert.deepEqual(helpers.requestTokenUsage(body),{input:50,output:7,total:57})
  assert.deepEqual(helpers.requestTokenUsage({event_stream:[{message:{usage:{input_tokens:10}}},{usage:{output_tokens:2}}]}),{input:10,output:2,total:null})
})

test('missing and malformed token usage stays unreported rather than guessed or coerced',()=>{
  for(const body of [null,'not JSON',{prompt_tokens:5},{usage:{input_tokens:-1,output_tokens:'3',total_tokens:NaN}},{usage:{input_tokens:1.5,output_tokens:Infinity,total_tokens:Number.MAX_SAFE_INTEGER+1}}])assert.equal(helpers.requestTokenUsage(body),null)
  assert.deepEqual(helpers.requestTokenUsage({usage:{completion_tokens:4}}),{input:null,output:4,total:null})
})

test('a later partial or malformed usage does not retain a now-stale stream total',()=>{
  assert.deepEqual(helpers.requestTokenUsage({event_stream:[{usage:{prompt_tokens:10,completion_tokens:1,total_tokens:11}},{usage:{completion_tokens:5}}]}),{input:10,output:5,total:null})
  assert.deepEqual(helpers.requestTokenUsage({event_stream:[{usage:{input_tokens:10,output_tokens:5,total_tokens:15}},{usage:{input_tokens:-1,total_tokens:-1}}]}),{input:null,output:5,total:null})
})

test('superseded and cancelled requests cannot deliver stale data or stale errors',async()=>{
  const runner=helpers.createLatestRequestRunner(),first=deferred(),second=deferred()
  let firstSignal
  const a=runner.run(signal=>{firstSignal=signal;return first.promise}),b=runner.run(()=>second.promise)
  assert.equal(firstSignal.aborted,true)
  second.resolve('new');assert.deepEqual(await b,{current:true,value:'new'})
  first.reject(Error('old failure'));assert.equal((await a).current,false)
  const pending=deferred(),last=runner.run(()=>pending.promise);runner.cancel();pending.resolve('after unmount');assert.equal((await last).current,false)
})

test('admin list sends filtering and pagination to backend rather than filtering the current page',async()=>{
  const calls=[],h=component('pages/admin/requests.vue',{api:{list:async filters=>{calls.push({...filters});return result([{id:'row-one',kind:'image',status:'succeeded',model:'model-seven',duration_ms:500}])}}})
  await h.mount();assert.equal(calls[0].phase,'generate')
  Object.assign(h.state.filters,{q:'full historical search',user_id:'7',channel_id:'8',model:'model-seven',kind:'image',status:'failed',phase:'all'})
  await h.state.applyFilters();await flush()
  assert.equal(calls.at(-1).q,'full historical search');assert.equal(calls.at(-1).user_id,'7');assert.equal(calls.at(-1).channel_id,'8');assert.equal(calls.at(-1).phase,'all')
  assert.equal(h.state.rows.value[0].id,'row-one','client does not discard a server-owned result by re-filtering this page')
  await h.state.changePage(1);assert.equal(calls.at(-1).offset,50)
  assert.equal(h.replaces.at(-1).query.offset,'50')
  h.dispose()
})

test('changing a list filter during an outstanding read ignores the old result and preserves the newest total',async()=>{
  const reads=[],h=component('pages/admin/requests.vue',{api:{list:(filters,signal)=>{const d=deferred();reads.push({filters,signal,...d});return d.promise}}})
  const mounting=h.mount();await flush();h.state.filters.q='new';const changing=h.state.applyFilters();await flush()
  assert.equal(reads.length,2);assert.equal(reads[0].signal.aborted,true)
  reads[1].resolve({...result([{id:'new'}]),total:1});await changing
  reads[0].resolve({...result([{id:'old'}]),total:999});await mounting;await flush()
  assert.equal(h.state.rows.value[0].id,'new');assert.equal(h.state.total.value,1);assert.equal(h.state.loading.value,false)
  h.dispose()
})

test('a permission failure clears an administrator list already shown in the browser',async()=>{
  let forbidden=false
  const h=component('pages/admin/requests.vue',{api:{list:async()=>{if(forbidden)throw Object.assign(Error('administrator only'),{status:403});return result([{id:'visible-before-revocation'}])}}})
  await h.mount();assert.equal(h.state.rows.value.length,1)
  forbidden=true;await h.state.refresh()
  assert.equal(h.state.rows.value.length,0);assert.equal(h.state.total.value,0);assert.equal(h.state.options.users.length,0);assert.match(h.state.error.value,/administrator only/)
  h.dispose()
})

test('invalid date filters cancel the old query and do not show an old page under the new conditions',async()=>{
  const pending=deferred(),h=component('pages/admin/requests.vue',{api:{list:()=>pending.promise}})
  const mounting=h.mount();await flush()
  h.state.filters.from='2026-11-10T00:00:00Z';h.state.filters.to='2026-11-09T00:00:00Z'
  await h.state.applyFilters();pending.resolve(result([{id:'stale-result'}]));await mounting;await flush()
  assert.equal(h.state.rows.value.length,0);assert.equal(h.state.loading.value,false);assert.match(h.state.error.value,/开始时间/)
  h.dispose()
})

test('drawer requests latest id and never replaces a new selection with a late previous response',async()=>{
  const reads=[],h=component('components/RequestLogDetail.vue',{props:{id:'one'},api:{detail:(id,signal)=>{const d=deferred();reads.push({id,signal,...d});return d.promise}}})
  await flush();h.props.id='two';await flush();assert.equal(reads.length,2)
  reads[1].resolve({request:{id:'two',status:'succeeded'},request_body:{prompt:'new'}});await flush()
  reads[0].resolve({request:{id:'one'},request_body:{prompt:'old'}});await flush()
  assert.equal(h.state.detail.value.request.id,'two');assert.equal(h.state.bodyText.value,'{\n  "prompt": "new"\n}')
  h.dispose()
})

test('drawer clearly labels absent/truncated payloads, exact ids, HTTP status and escaped response text',async()=>{
  const h=component('components/RequestLogDetail.vue',{props:{id:'log-1'},api:{detail:async()=>({request:{id:'log-1',task_id:'task-1',round_id:'round-1',status:'succeeded',kind:'image',phase:'generate',http_status:200,request_recorded:false,response_recorded:true,response_truncated:true},request_body:null,response_body:'<script>never execute</script>'})}})
  await flush();let html=await h.render()
  assert.match(html,/正文未记录/);assert.match(html,/业务任务 ID/);assert.match(html,/模型轮次 ID/);assert.match(html,/HTTP 成功不代表视频已经生成/);assert.match(html,/首块读取（客户端观测）/);assert.match(html,/响应头等待/)
  h.state.tab.value='response';html=await h.render();assert.match(html,/日志仅保留部分内容/);assert.match(html,/&lt;script&gt;never execute&lt;\/script&gt;/)
  assert.doesNotMatch(html,/<script>never execute<\/script>/)
  h.dispose()
})

test('drawer does not silently accept a response for a different log or automatically issue generation',async()=>{
  let reads=0
  const h=component('components/RequestLogDetail.vue',{props:{id:'expected'},api:{detail:async()=>{reads++;return{request:{id:'wrong'}}}}})
  await flush();assert.match(h.state.error.value,/不匹配/);assert.equal(h.state.detail.value,null);assert.equal(reads,1)
  h.dispose()
})

test('drawer renders upstream usage only when present and leaves missing token fields unreported',async()=>{
  const h=component('components/RequestLogDetail.vue',{props:{id:'tokens'},api:{detail:async()=>({request:{id:'tokens',status:'succeeded'},response_body:{usage:{output_tokens:4}}})}})
  await flush();const html=await h.render()
  assert.match(html,/上游 Token 用量/);assert.match(html,/仅显示已记录的 usage/);assert.match(html,/未提供/)
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.tokenUsage.value)),{input:null,output:4,total:null})
  h.dispose()
})

test('running detail polls without overlap, preserves the active tab and scroll, then stops at terminal status',async()=>{
  const pending=deferred();let calls=0
  const h=component('components/RequestLogDetail.vue',{props:{id:'live'},api:{detail:async()=>{calls++;return calls===1?{request:{id:'live',status:'running'},response_body:{phase:'first'}}:pending.promise}}})
  await flush();assert.equal(h.activeTimers().length,1);assert.equal(h.activeTimers()[0].delay,2500)
  h.state.tab.value='response';h.state.scrollPane.value={scrollTop:88};h.state.bodyPane.value={scrollTop:33}
  h.runTimer(2500);await flush();assert.equal(calls,2)
  h.state.refreshDetails();await flush();assert.equal(calls,2,'manual refresh cannot overlap in-flight poll')
  h.state.scrollPane.value.scrollTop=91;h.state.bodyPane.value.scrollTop=72
  pending.resolve({request:{id:'live',status:'succeeded'},response_body:{phase:'done'}});await flush()
  assert.equal(h.state.tab.value,'response');assert.equal(h.state.scrollPane.value.scrollTop,91);assert.equal(h.state.bodyPane.value.scrollTop,72)
  assert.equal(h.state.detail.value.request.status,'succeeded');assert.equal(h.activeTimers().length,0)
  h.dispose()
})

test('manual detail refresh updates terminal records and keeps previous content on a temporary read failure',async()=>{
  let calls=0
  const h=component('components/RequestLogDetail.vue',{props:{id:'manual'},api:{detail:async()=>{calls++;if(calls===3)throw Error('temporary read failure');return{request:{id:'manual',status:'succeeded'},request_body:{version:calls}}}}})
  await flush();h.state.tab.value='process';await h.state.refreshDetails();await flush()
  assert.equal(h.state.detail.value.request_body.version,2);assert.equal(h.state.tab.value,'process');assert.equal(h.activeTimers().length,0)
  await h.state.refreshDetails();await flush()
  assert.equal(h.state.detail.value.request_body.version,2);assert.match(h.state.error.value,/temporary read failure/)
  assert.match(await h.render(),/当前保留上次读取的内容/)
  h.dispose()
})

test('permission loss while polling clears the detail and stops further automatic reads',async()=>{
  let calls=0
  const h=component('components/RequestLogDetail.vue',{props:{id:'permission'},api:{detail:async()=>{calls++;if(calls>1)throw Object.assign(Error('administrator only'),{status:403});return{request:{id:'permission',status:'running'},request_body:{private:'fixture'}}}}})
  await flush();h.runTimer(2500);await flush()
  assert.equal(h.state.detail.value,null);assert.equal(h.activeTimers().length,0);assert.equal(calls,2)
  assert.match(h.state.error.value,/administrator only/)
  h.dispose()
})

test('automatic detail observation has a bounded window and manual refresh can explicitly resume it',async()=>{
  let calls=0
  const h=component('components/RequestLogDetail.vue',{props:{id:'bounded'},now:1000,api:{detail:async()=>{calls++;return{request:{id:'bounded',status:'running'}}}}})
  await flush();assert.equal(calls,1)
  h.clock.value=1000+10*60_000+1;h.runTimer(2500);await flush()
  assert.equal(calls,1);assert.equal(h.state.autoPaused.value,true);assert.equal(h.activeTimers().length,0)
  assert.match(await h.render(),/等待上限/)
  await h.state.refreshDetails();await flush()
  assert.equal(calls,2);assert.equal(h.state.autoPaused.value,false);assert.equal(h.activeTimers().length,1)
  h.dispose()
})

test('closing a live detail cancels polling and ignores its pending result',async()=>{
  const pending=deferred();let calls=0
  const h=component('components/RequestLogDetail.vue',{props:{id:'closing'},api:{detail:async()=>{calls++;return calls===1?{request:{id:'closing',status:'running'},response_body:'old'}:pending.promise}}})
  await flush();h.runTimer(2500);await flush();h.state.close()
  pending.resolve({request:{id:'closing',status:'succeeded'},response_body:'late'});await flush()
  assert.equal(h.state.detail.value.response_body,'old');assert.equal(h.activeTimers().length,0)
  assert.deepEqual(Array.from(h.emits,x=>Array.from(x)),[['close']])
  h.dispose()
})

test('a capped child-request list visibly discloses 500-item limit and links to task-filtered history',async()=>{
  const children=Array.from({length:500},(_,i)=>({id:'child-'+i,status:'succeeded',phase:'poll',method:'GET',path:'/jobs/x'}))
  const h=component('components/RequestLogDetail.vue',{props:{id:'parent'},api:{detail:async()=>({request:{id:'parent',status:'succeeded',task_id:'task / one'},children})}})
  await flush();h.state.tab.value='process';const html=await h.render()
  assert.match(html,/最多展示 500 条关联请求/);assert.match(html,/回列表按业务任务号筛选/)
  const link=new URL(h.state.relatedListLink.value,'http://fixture');assert.equal(link.searchParams.get('q'),'task / one');assert.equal(link.searchParams.get('phase'),'all')
  h.dispose()
})

function apiHarness(fetcher) {
  const session={revision:1},requests=[],downloads=[];let expired=0
  const module={}
  runInNewContext(js(readFileSync(new URL('../app/composables/useRequestLogs.ts',import.meta.url),'utf8')),{exports:module,require(name){
    if(name==='~/utils/platform-session')return{platformSession:session,platformHeaders:()=>({}),expirePlatformSession(){expired++}}
    if(name==='~/utils/request-logs.js')return helpers
    throw Error('Unexpected API helper import '+name)
  },fetch:async(url,options)=>{requests.push({url,options});return fetcher(url,options)},URL:{createObjectURL(){downloads.push('blob');return'blob:fixture'},revokeObjectURL(){}},document:{createElement(){return{click(){downloads.push('click')},remove(){}}},body:{append(){}}},setTimeout(){},Error,encodeURIComponent})
  return{api:module.requestLogAPI,download:module.downloadRequestLog,session,requests,downloads,get expired(){return expired}}
}

test('request log API uses authenticated server filtering and passes AbortSignal',async()=>{
  const h=apiHarness(async()=>({ok:true,status:200,json:async()=>({code:200,data:{items:[],total:0}})})),controller=new AbortController()
  await h.api.list({q:'name & id',phase:'all',status:'failed'},controller.signal)
  const request=h.requests[0],url=new URL(request.url,'http://fixture')
  assert.equal(url.pathname,'/api/v1/admin/requests');assert.equal(url.searchParams.get('q'),'name & id');assert.equal(url.searchParams.get('status'),'failed')
  assert.equal(request.options.credentials,'same-origin');assert.equal(request.options.signal,controller.signal)
  const exportParams=new URL(h.api.exportUrl({q:'all matching',limit:20,offset:80}),'http://fixture').searchParams
  assert.equal(exportParams.get('q'),'all matching');assert.equal(exportParams.has('limit'),false);assert.equal(exportParams.has('offset'),false)
  assert.throws(()=>h.api.detail('../users'),/编号无效/)
})

test('permission errors remain errors and a reply from a previous login is ignored',async()=>{
  const forbidden=apiHarness(async()=>({ok:false,status:403,json:async()=>({code:403,message:'administrator only'})}))
  await assert.rejects(forbidden.api.list({}),/administrator only/);assert.equal(forbidden.expired,0)
  const pending=deferred(),stale=apiHarness(async()=>({ok:true,status:200,json:()=>pending.promise}))
  const request=stale.api.detail('log-one');await flush();stale.session.revision++;pending.resolve({code:200,data:{request:{id:'log-one'}}})
  await assert.rejects(request,/登录身份已变化/)
  const expired=apiHarness(async()=>({ok:false,status:401,json:async()=>({code:401,message:'login again'})}))
  await assert.rejects(expired.api.list({}),/login again/);assert.equal(expired.expired,1)
})

test('export does not save a response after the authenticated identity changes during download',async()=>{
  const body=deferred(),h=apiHarness(async()=>({ok:true,status:200,blob:()=>body.promise}))
  const operation=h.download(h.api.exportUrl({phase:'generate'}),'logs.csv');await flush();h.session.revision++;body.resolve(new Blob(['fixture']))
  await assert.rejects(operation,/登录身份已变化/);assert.deepEqual(h.downloads,[])
  await assert.rejects(h.download('https://other.invalid/logs','logs.csv'),/下载地址无效/)
})
