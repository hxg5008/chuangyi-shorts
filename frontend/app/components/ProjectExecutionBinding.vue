<template>
  <section class="project-execution" aria-label="即梦账号与画布">
    <header><div class="binding-heading"><span class="binding-symbol"><Network :size="16" /></span><div><strong>即梦账号与画布</strong><p v-if="current">{{ current.account_name || current.account_id }}<span> / </span>{{ current.canvas_name || current.canvas_id }}</p><p v-else>为这部作品选择账号和专用画布。</p></div></div><div class="binding-actions"><span v-if="current?.state === 'ready' && current.permitted !== false" class="binding-state"><i />当前画布</span><button type="button" class="btn btn-sm" :disabled="loading || saving" @click="load"><RefreshCw :size="12" :class="{'animate-spin':loading}" />刷新</button></div></header>
    <p v-if="current?.unavailable_reason" class="binding-warning" role="status">{{ current.unavailable_reason }}</p>
    <p v-if="error" class="binding-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="binding-notice" role="status">{{ notice }}</p>
    <div v-if="loading && !loaded" class="binding-empty"><Loader2 :size="15" class="animate-spin" />正在读取项目可用账号…</div>
    <p v-else-if="loaded && featureAllowed === false" class="binding-footnote">你尚未获准使用即梦视频，请联系管理员开启使用权限。已有任务和视频记录保留。</p>
    <p v-else-if="loaded && managed === false" class="binding-footnote">当前服务沿用原有账号和画布，生成方式保持不变。管理员可在一体平台设置中开启项目选择。</p>
    <p v-else-if="loaded && selectionAvailable === false" class="binding-footnote">{{ selectionNotice || '当前执行平台暂不支持选择账号和画布，已有绑定继续使用。请管理员更新一体平台后再切换。' }}</p>
    <template v-else-if="loaded">
      <div v-if="!accounts.length" class="binding-empty"><ShieldCheck :size="16" />暂时没有可选账号，请管理员分配即梦账号权限。</div>
      <div v-else class="binding-fields"><label>即梦账号<select class="input" v-model="accountId" :disabled="saving || loading || !!pending" @change="changeAccount"><option v-for="account in accounts" :key="account.id" :value="account.id" :disabled="!readyAccount(account)">{{ account.name || account.id }} · {{ accountState(account.state) }}</option></select></label><label>项目画布<select class="input" v-model="canvasChoice" :disabled="saving || loading || !!pending"><option v-if="pending?.mode === 'new'" value="new">＋ 新建专用画布</option><option value="" disabled>请选择可用画布</option><option v-for="canvas in selectedAccount?.canvases || []" :key="canvas.id" :value="canvas.id">{{ canvas.name || canvas.id }}{{ canvas.current ? ' · 当前' : canvas.history ? ' · 本项目历史' : canvas.history_unassigned ? ' · 已有画布' : '' }}</option></select></label><button type="button" class="btn btn-primary binding-submit" :disabled="!canSubmit" @click="requestBinding"><Loader2 v-if="saving" :size="13" class="animate-spin" /><Link2 v-else :size="13" />{{ saving ? '处理中…' : pending ? '继续核对画布' : unchanged ? '当前画布' : current ? '切换画布' : '使用此画布' }}</button></div>
      <p v-if="pending" class="binding-warning" role="status">上次画布操作尚未完成，继续核对原画布，不会重复新建。</p>
      <p v-if="selectedAccount && !pending && !selectedAccount.allow_create && !selectedAccount.canvases?.length" class="binding-footnote">此账号暂未给你分配可用画布，请管理员授权已有画布。</p>
      <div v-if="accounts.length" class="canvas-management"><button type="button" class="btn btn-sm" :disabled="!canCreate" @click="openNewCanvas"><Plus :size="13" />新建画布</button><button type="button" class="btn btn-sm" :disabled="!canRename" @click="openRenameCanvas"><Pencil :size="13" />改名</button><span>选好后点击“{{ current ? '切换画布' : '使用此画布' }}”，后续视频使用所选画布。</span></div>
      <p v-if="blocked" class="binding-warning" role="status">{{ blockingDescription }}</p>
      <p class="binding-footnote">本项目各集使用当前画布。切换只影响新任务，已提交的视频继续在原画布查询和下载。</p>
    </template>
    <Teleport to="body"><div v-if="confirmation" class="overlay binding-confirm-overlay" @click.self="closeConfirmation" @keydown.esc.stop.prevent="closeConfirmation"><section ref="confirmDialog" class="dialog binding-confirm" role="alertdialog" aria-modal="true" aria-labelledby="execution-confirm-title" tabindex="-1"><header><span class="binding-symbol"><ArrowRightLeft :size="22" /></span><button type="button" class="btn btn-icon" aria-label="关闭" :disabled="saving" @click="closeConfirmation"><X :size="17" /></button></header><h2 id="execution-confirm-title">{{ current ? '切换项目画布' : '选择项目画布' }}</h2><dl><div><dt>即梦账号</dt><dd>{{ confirmation.accountName }}</dd></div><div><dt>项目画布</dt><dd>{{ confirmation.canvasName }}</dd></div></dl><p>这个选择将用于本项目后续提交。已有任务、视频和历史记录仍保留原账号与画布。</p><p v-if="confirmation.historyUnassigned" class="existing-canvas-note">这张画布已有内容，使用后仍会保留。新任务会继续提交到这张画布，旧任务不会自动改为本项目任务。</p><p v-if="error" class="binding-error" role="alert">{{ error }}</p><footer><button type="button" class="btn" :disabled="saving" @click="closeConfirmation">取消</button><button type="button" class="btn btn-primary" :disabled="saving" @click="confirmBinding"><Loader2 v-if="saving" :size="13" class="animate-spin" />{{ saving ? '处理中…' : confirmation.mode === 'new' ? '新建并使用' : '确认使用' }}</button></footer></section></div></Teleport>
    <Teleport to="body"><div v-if="nameDialog" class="overlay binding-confirm-overlay" @click.self="closeNameDialog" @keydown.esc.stop.prevent="closeNameDialog"><section ref="nameDialogElement" class="dialog binding-confirm" role="dialog" aria-modal="true" aria-labelledby="canvas-name-title" tabindex="-1"><header><span class="binding-symbol"><Pencil v-if="nameDialog.kind === 'rename'" :size="22" /><Plus v-else :size="22" /></span><button type="button" class="btn btn-icon" aria-label="关闭" :disabled="saving" @click="closeNameDialog"><X :size="17" /></button></header><h2 id="canvas-name-title">{{ nameDialog.kind === 'rename' ? '修改画布名称' : '新建画布' }}</h2><p>{{ nameDialog.accountName }}</p><label class="canvas-name-field">画布名称<input class="input" v-model="canvasName" :disabled="saving" autocomplete="off" @keydown.enter.prevent="submitCanvasName" /><small>{{ Array.from(canvasName.trim()).length }} / 50 字</small></label><p>{{ nameDialog.kind === 'rename' ? '修改即梦中的画布名称，画布 ID、任务和视频不变。' : '创建后自动用于本项目，已有任务仍留在原画布。' }}</p><p v-if="nameError" class="binding-error" role="alert">{{ nameError }}</p><footer><button type="button" class="btn" :disabled="saving" @click="closeNameDialog">取消</button><button type="button" class="btn btn-primary" :disabled="saving || !validCanvasName" @click="submitCanvasName"><Loader2 v-if="saving" :size="13" class="animate-spin" />{{ saving ? '处理中…' : nameDialog.kind === 'rename' ? '保存名称' : '新建并使用' }}</button></footer></section></div></Teleport>
  </section>
</template>
<script setup>
import {computed,ref,watch,onBeforeUnmount,nextTick} from 'vue'
import {Network,RefreshCw,Loader2,ShieldCheck,Link2,ArrowRightLeft,X,Plus,Pencil} from 'lucide-vue-next'
import {api} from '~/composables/useApi'
import {platformSession} from '~/utils/platform-session'
const props=defineProps({projectId:{type:[Number,String],required:true},configId:{type:[Number,String],required:true},projectTitle:{type:String,default:''}})
const emit=defineEmits(['change'])
const accounts=ref([]),current=ref(null),pending=ref(null),loading=ref(false),loaded=ref(false),saving=ref(false),error=ref(''),notice=ref(''),accountId=ref(''),canvasChoice=ref(''),canSwitch=ref(true),blockingTasks=ref([]),confirmation=ref(null),confirmDialog=ref(null),managed=ref(null),selectionAvailable=ref(true),selectionNotice=ref('')
const featureAllowed=ref(true),nameDialog=ref(null),nameDialogElement=ref(null),canvasName=ref(''),nameError=ref('')
let alive=true,revision=0
const identity=()=>`${props.projectId}|${props.configId}|${platformSession.revision}`
const validIdentity=(value,turn)=>alive&&identity()===value&&revision===turn
const selectedAccount=computed(()=>accounts.value.find(item=>item.id===accountId.value))
const selectedCanvas=computed(()=>selectedAccount.value?.canvases?.find(item=>item.id===canvasChoice.value))
const readyAccount=account=>['ready','choose_canvas'].includes(account?.state)
const accountState=state=>({ready:'已就绪',choose_canvas:'已登录',login_required:'需重新登录',unchecked:'待检查'}[state]||'待检查')
const unchanged=computed(()=>!pending.value&&current.value?.state==='ready'&&current.value.account_id===accountId.value&&current.value.canvas_id===canvasChoice.value)
const blocked=computed(()=>!canSwitch.value&&!pending.value)
const blockingDescription=computed(()=>blockingTasks.value.length?`还有 ${blockingTasks.value.length} 条视频正在准备或提交，完成接单后再切换。`:'当前暂不能切换，请稍后刷新项目状态。')
const canManage=computed(()=>!!(loaded.value&&featureAllowed.value!==false&&managed.value!==false&&selectionAvailable.value&&!loading.value&&!saving.value&&selectedAccount.value&&readyAccount(selectedAccount.value)))
const canSubmit=computed(()=>!!(canManage.value&&!unchanged.value&&!blocked.value&&(!pending.value||pending.value.account_id===accountId.value)&&(pending.value||canvasChoice.value==='new'&&selectedAccount.value.allow_create||selectedCanvas.value)))
const canCreate=computed(()=>!!(canManage.value&&!pending.value&&!blocked.value&&selectedAccount.value.allow_create))
const canRename=computed(()=>!!(canManage.value&&!pending.value&&selectedCanvas.value?.can_rename))
const validCanvasName=computed(()=>{const name=canvasName.value.trim();return !!name&&Array.from(name).length<=50&&!/[\x00-\x1f\x7f]/u.test(name)})
function pickInitial(value){
  const source=value.pending||value.current
  const preferred=[source?.account_id,value.default_account_id,accounts.value.find(readyAccount)?.id,accounts.value[0]?.id].find(id=>accounts.value.some(item=>item.id===id))
  accountId.value=preferred||''
  const selected=accounts.value.find(item=>item.id===accountId.value)
  canvasChoice.value=value.pending?.mode==='new'?'new':source?.canvas_id&&(selected?.canvases||[]).some(item=>item.id===source.canvas_id)?source.canvas_id:selected?.canvases?.[0]?.id||''
}
function changeAccount(){const account=selectedAccount.value;canvasChoice.value=current.value?.account_id===accountId.value&&(account?.canvases||[]).some(item=>item.id===current.value.canvas_id)?current.value.canvas_id:account?.canvases?.[0]?.id||'';notice.value=''}
async function load(){
  const turn=++revision,key=identity();loading.value=true;error.value=''
  if(!Number.isSafeInteger(Number(props.projectId))||Number(props.projectId)<1||!Number.isSafeInteger(Number(props.configId))||Number(props.configId)<1){loading.value=false;loaded.value=false;return}
  try{const value=await api.get(`/dramas/${Number(props.projectId)}/execution-options?config_id=${Number(props.configId)}`);if(!validIdentity(key,turn))return;managed.value=value.managed!==false;featureAllowed.value=value.feature_allowed!==false;selectionAvailable.value=value.selection_available!==false;selectionNotice.value=value.notice||'';accounts.value=Array.isArray(value.accounts)?value.accounts:[];current.value=value.current||null;pending.value=value.pending||null;canSwitch.value=value.can_switch!==false;blockingTasks.value=value.blocking_tasks||[];loaded.value=true;pickInitial(value);emit('change',current.value)}catch(e){if(validIdentity(key,turn)){loaded.value=false;error.value=e.message||'无法读取项目绑定，请稍后刷新。';emit('change',null)}}finally{if(validIdentity(key,turn))loading.value=false}
}
function requestBinding(){
  if(!canSubmit.value)return
  const mode=pending.value?.mode||(canvasChoice.value==='new'?'new':'existing'),canvasId=pending.value?.canvas_id||canvasChoice.value
  confirmation.value={config_id:Number(props.configId),account_id:accountId.value,mode,...(mode==='existing'?{canvas_id:canvasId}:{}),expected_route_id:current.value?.id??null,historyUnassigned:mode==='existing'&&!!selectedCanvas.value?.history_unassigned,accountName:selectedAccount.value.name||accountId.value,canvasName:mode==='new'?'新建项目专用画布':selectedAccount.value.canvases?.find(item=>item.id===canvasId)?.name||canvasId,identity:identity()}
  error.value='';void nextTick(()=>confirmDialog.value?.focus?.({preventScroll:true}))
}
function closeConfirmation(){if(!saving.value)confirmation.value=null}
function openNewCanvas(){if(!canCreate.value)return;nameDialog.value={kind:'new',accountId:accountId.value,accountName:selectedAccount.value.name||accountId.value,expectedRouteId:current.value?.id??null,identity:identity()};canvasName.value=props.projectTitle||`项目${props.projectId}画布`;nameError.value='';void nextTick(()=>nameDialogElement.value?.focus?.({preventScroll:true}))}
function openRenameCanvas(){if(!canRename.value)return;nameDialog.value={kind:'rename',accountId:accountId.value,accountName:selectedAccount.value.name||accountId.value,canvasId:canvasChoice.value,previousName:selectedCanvas.value.name||'',identity:identity()};canvasName.value=selectedCanvas.value.name||'';nameError.value='';void nextTick(()=>nameDialogElement.value?.focus?.({preventScroll:true}))}
function closeNameDialog(){if(!saving.value){nameDialog.value=null;nameError.value=''}}
async function submitCanvasName(){
  const proposal=nameDialog.value;if(!proposal||saving.value||proposal.identity!==identity())return
  if(!validCanvasName.value){nameError.value='请输入 1–50 字的画布名称，不能包含换行或控制字符。';return}
  const name=canvasName.value.trim()
  if(proposal.kind==='new'){
    if(!canCreate.value)return
    confirmation.value={config_id:Number(props.configId),account_id:proposal.accountId,mode:'new',canvas_name:name,expected_route_id:proposal.expectedRouteId,accountName:proposal.accountName,canvasName:name,identity:proposal.identity}
    nameDialog.value=null;await confirmBinding();return
  }
  if(!canRename.value||accountId.value!==proposal.accountId||canvasChoice.value!==proposal.canvasId)return
  const key=identity(),turn=revision;saving.value=true;nameError.value='';error.value='';notice.value=''
  try{const value=await api.post(`/dramas/${Number(props.projectId)}/execution-canvas/rename`,{config_id:Number(props.configId),account_id:proposal.accountId,canvas_id:proposal.canvasId,name,expected_name:proposal.previousName});if(!validIdentity(key,turn))return;if(value?.renamed!==true||value.account_id!==proposal.accountId||value.canvas_id!==proposal.canvasId||value.name!==name)throw Error("改名结果与所选画布不一致，请刷新核对。");nameDialog.value=null;notice.value='画布名称已更新。';await load()}catch(e){if(validIdentity(key,turn))nameError.value=e.message||'改名未完成，请刷新后核对。'}finally{if(alive&&identity()===key)saving.value=false}
}
async function confirmBinding(){
  const proposal=confirmation.value;if(!proposal||saving.value||proposal.identity!==identity())return
  const key=identity(),turn=revision;saving.value=true;error.value='';notice.value=''
  try{const {accountName,canvasName,historyUnassigned,identity:discard,...body}=proposal;const value=await api.post(`/dramas/${Number(props.projectId)}/execution-route`,body);if(!validIdentity(key,turn))return;if(!value.current||value.current.state!=='ready')throw Error('项目绑定尚未确认完成，请保留原操作并刷新核对。');confirmation.value=null;notice.value='项目画布已选定，后续新任务使用此账号和画布。';await load()}catch(e){if(validIdentity(key,turn)){error.value=e.message||'绑定未完成，请刷新后核对。';confirmation.value=null;await loadAfterFailure(key)}}finally{if(alive&&identity()===key)saving.value=false}
}
async function loadAfterFailure(key){const message=error.value;await load();if(alive&&identity()===key)error.value=message}
watch(()=>[props.projectId,props.configId,platformSession.revision],()=>{revision++;confirmation.value=null;nameDialog.value=null;accounts.value=[];current.value=null;pending.value=null;managed.value=null;featureAllowed.value=true;selectionAvailable.value=true;selectionNotice.value='';loaded.value=false;saving.value=false;notice.value='';emit('change',null);void load()},{immediate:true})
onBeforeUnmount(()=>{alive=false;revision++;confirmation.value=null;nameDialog.value=null})
// The server checks ownership again; the picker never receives account cookies or project keys.
</script>
<style scoped>
.project-execution{border:1px solid var(--border);background:var(--bg-1);border-radius:13px;padding:16px 18px;margin:0 0 16px}.project-execution>header,.binding-heading,.binding-actions{display:flex;align-items:center;gap:10px}.project-execution>header{justify-content:space-between;gap:15px}.binding-symbol{display:grid;place-items:center;background:var(--accent-bg);color:var(--accent-text);border-radius:10px;width:35px;height:35px;flex-shrink:0}.binding-heading strong{font-size:12px}.binding-heading p{font-size:10px;color:var(--text-3);margin-top:5px;overflow-wrap:anywhere}.binding-heading p>span{margin:0 6px;color:var(--border)}.binding-heading small{margin-left:10px}.binding-state{display:inline-flex;align-items:center;gap:5px;font-size:10px;white-space:nowrap;color:var(--success)}.binding-state i{width:5px;height:5px;background:currentColor;border-radius:50%}.binding-fields{display:grid;grid-template-columns:minmax(150px,1fr) minmax(180px,1.25fr) auto;gap:12px;align-items:end;margin-top:15px}.binding-fields label{display:grid;gap:7px;font-size:10px;color:var(--text-2)}.binding-fields .input{width:100%;min-height:35px;font-size:11px}.binding-submit{min-height:35px;white-space:nowrap}.binding-empty{display:flex;align-items:center;gap:8px;color:var(--text-3);font-size:11px;padding:15px 0 3px}.binding-footnote{font-size:10px;line-height:1.7;color:var(--text-3);margin-top:11px}.binding-error,.binding-warning,.binding-notice{font-size:11px;line-height:1.8;margin-top:12px;padding:9px 11px;border-radius:8px;overflow-wrap:anywhere}.binding-error{background:var(--error-bg);color:var(--error)}.binding-warning{background:var(--accent-bg);color:var(--accent-text)}.binding-notice{background:var(--success-bg);color:var(--success)}.binding-confirm-overlay{z-index:170;padding:20px}.binding-confirm{padding:25px;width:460px;max-width:100%;max-height:calc(100dvh - 40px);overflow:auto;outline:none}.binding-confirm>header{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}.binding-confirm h2{font-size:19px}.binding-confirm dl{display:grid;gap:12px;background:var(--bg-0);border:1px solid var(--border);border-radius:10px;padding:15px;margin:18px 0}.binding-confirm dl>div{display:grid;grid-template-columns:70px 1fr;gap:10px;font-size:12px}.binding-confirm dt{color:var(--text-3)}.binding-confirm dd{margin:0;overflow-wrap:anywhere;color:var(--text-1)}.binding-confirm>p{font-size:11px;line-height:1.8;color:var(--text-2)}.binding-confirm footer{display:flex;justify-content:flex-end;gap:8px;margin-top:23px}@media(max-width:800px){.binding-fields{grid-template-columns:1fr 1fr}.binding-submit{grid-column:1/-1;justify-self:end}.project-execution{padding:14px}.binding-heading small{display:none}}@media(max-width:500px){.binding-fields{grid-template-columns:1fr}.project-execution>header{align-items:flex-start}.binding-actions{gap:6px}.binding-state{display:none}}
.canvas-management{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px}.canvas-management>span{font-size:10px;color:var(--text-3)}.canvas-name-field{display:grid;gap:8px;margin:20px 0 14px;font-size:12px}.canvas-name-field small{justify-self:end;color:var(--text-3);font-size:10px}
.existing-canvas-note{padding:10px 12px;background:var(--accent-bg);border-radius:8px;color:var(--accent-text)!important}
</style>
