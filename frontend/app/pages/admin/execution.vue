<template>
  <PlatformAdminShell title="一体平台连接" description="管理员配置服务和使用权限；用户在自己的项目里选择账号和画布。">
    <p v-if="error" class="notice problem" role="alert">{{ error }}</p>
    <section class="card connection-card">
      <header><div class="symbol"><Network :size="22" /></div><div><h2>即梦服务连接</h2><p>账号登录和维护在一体执行平台完成，这里只选择已配置的即梦服务。</p></div><button class="btn btn-sm" :disabled="busy" @click="load">刷新</button></header>
      <div v-if="!models.length" class="empty">还没有即梦本地协议模型。<NuxtLink to="/admin/channels">前往模型渠道添加</NuxtLink></div>
      <template v-else>
        <div class="fields"><label>视频服务模型<select v-model="selectedId" :disabled="busy" @change="loadSetting"><option v-for="model in models" :key="model.config_id" :value="model.config_id">{{ model.channelName }} · {{ model.name }}</option></select></label><button class="btn" :disabled="busy||!selectedId" @click="checkAccounts"><RefreshCw :size="13" :class="{'animate-spin':busy}" />{{ busy?'检查中…':'检查连接' }}</button></div>
        <div class="service-status"><span :class="['dot',{ready:readyAccounts.length>0||savedConnection}]" />{{ message || (savedConnection?'此服务已启用。用户可在项目里选择账号和画布。':'检查连接后保存，即可供获准用户使用。') }}</div>
        <footer><p>检查连接只读取状态，不生成视频。账号未就绪时，请到一体执行平台登录并检查。</p><button class="btn btn-primary" :disabled="busy||!selectedId||!readyAccountId" @click="save">保存连接</button></footer>
      </template>
    </section>
    <ExecutionFeatureAccess v-if="selectedId" :config-id="selectedId" :refresh-token="accountsRevision" />
    <aside class="notice"><strong>用户直接管理自己的画布</strong><p>开启即梦权限后，用户可以在视频制作页选择空闲的已有画布，也可以新建和改名。已由其他项目使用的画布保持隔离；切换画布不会改变已经提交的任务。</p></aside>
  </PlatformAdminShell>
</template>
<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { Network, RefreshCw } from 'lucide-vue-next'
import PlatformAdminShell from '~/components/PlatformAdminShell.vue'
import ExecutionFeatureAccess from '~/components/ExecutionFeatureAccess.vue'
import { api, channelAPI } from '~/composables/useApi'
const models=ref([]),selectedId=ref(''),accountId=ref(''),accounts=ref([]),savedConnection=ref(false),busy=ref(false),error=ref(''),message=ref(''),accountsRevision=ref(0)
let alive=true,revision=0
const readyAccounts=computed(()=>accounts.value.filter(account=>['ready','choose_canvas'].includes(account.state)))
const readyAccountId=computed(()=>readyAccounts.value.find(account=>account.id===accountId.value)?.id||readyAccounts.value[0]?.id||'')
onBeforeUnmount(()=>{alive=false;revision++})
async function action(fn){if(busy.value)return;busy.value=true;error.value='';try{await fn()}catch(e){if(alive)error.value=e.message}finally{if(alive)busy.value=false}}
async function loadSetting(){const seq=++revision;accounts.value=[];accountId.value='';savedConnection.value=false;message.value='';if(!selectedId.value)return;try{const value=await api.get(`/admin/execution/services/${selectedId.value}`);if(alive&&seq===revision){accountId.value=value?.account_id||'';savedConnection.value=!!value?.enabled}}catch(e){if(alive&&seq===revision)error.value=e.message}}
async function load(){await action(async()=>{const channels=await channelAPI.list();if(!alive)return;models.value=(channels.channels||[]).flatMap(channel=>(channel.models||[]).filter(model=>model.protocol_id==='video.jimeng-local').map(model=>({...model,channelName:channel.name})));if(!models.value.some(model=>model.config_id===selectedId.value))selectedId.value=models.value[0]?.config_id||'';await loadSetting()})}
async function checkAccounts(){await action(async()=>{const seq=revision,value=await api.get(`/admin/execution/services/${selectedId.value}/accounts`);if(!alive||seq!==revision)return;accounts.value=value.accounts||[];accountsRevision.value++;message.value=readyAccounts.value.length?`连接正常，${readyAccounts.value.length} 个账号已就绪。`:'服务已连接，暂无已就绪账号。请在一体执行平台登录并检查账号。'})}
async function save(){const service=selectedId.value,selected=readyAccountId.value;if(!service||!selected)return;await action(async()=>{const seq=revision;await api.put(`/admin/execution/services/${service}`,{account_id:selected,enabled:true});if(alive&&seq===revision){savedConnection.value=true;message.value='连接已保存。获准用户可在自己的项目里选择账号和画布。'}})}
onMounted(load)
</script>
<style scoped>
.connection-card{margin-bottom:20px;padding:24px}.connection-card header{display:flex;align-items:center;gap:14px;margin-bottom:22px}.connection-card header>div:nth-child(2){flex:1}h2{font-size:17px;margin:0 0 6px}.connection-card p,.notice p{color:var(--text-3);font-size:12px;line-height:1.7;margin:0}.symbol{color:var(--accent);background:var(--accent-bg);border-radius:14px;padding:12px}.fields{display:grid;grid-template-columns:minmax(220px,1fr) auto;gap:18px;align-items:end}label{display:grid;gap:9px;font-size:12px;font-weight:600}select{border:1px solid var(--border);border-radius:10px;padding:11px;background:var(--bg-card);color:var(--text-1);width:100%;font-size:13px}.service-status{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--text-2);margin-top:18px;line-height:1.7}.dot{width:7px;height:7px;border-radius:50%;background:#b8bdc6;flex-shrink:0}.dot.ready{background:#31a67c}footer{display:flex;gap:16px;align-items:center;justify-content:space-between;border-top:1px solid var(--border);margin-top:20px;padding-top:18px}footer p{max-width:75%}.notice{padding:18px 22px;border-radius:14px;border:1px solid var(--border);background:var(--bg-card);font-size:13px;line-height:1.8}.problem{color:var(--error,#c44);background:var(--error-bg,#fff3f1);margin-bottom:16px}.empty{color:var(--text-3);font-size:12px;padding:12px 0}@media(max-width:650px){.fields{grid-template-columns:1fr}.fields>.btn{justify-self:start}.connection-card{padding:18px}.connection-card header{align-items:flex-start}footer{align-items:flex-start;flex-direction:column}footer p{max-width:none}}
</style>
