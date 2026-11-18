<template>
  <section class="card feature-access" aria-label="即梦功能使用权限">
    <header><div><h2>谁可以使用即梦</h2><p>获准用户可以在自己的项目里选择画布、新建画布和改名。</p></div><button type="button" class="btn btn-sm" :disabled="busy" @click="load"><RefreshCw :size="12" :class="{'animate-spin':loading}" />刷新</button></header>
    <p v-if="error" class="feature-note problem" role="alert">{{ error }}</p>
    <p v-if="notice" class="feature-note success" role="status">{{ notice }}</p>
    <div v-if="loading && !loaded" class="feature-loading"><Loader2 :size="14" class="animate-spin" />正在读取使用权限…</div>
    <template v-else-if="loaded">
      <label class="scope-field">使用范围<select class="input" v-model="access" :disabled="busy"><option v-if="access === 'legacy'" value="legacy" disabled>沿用当前账号授权</option><option value="all">全部用户</option><option value="selected">指定用户</option></select></label>
      <p v-if="access === 'legacy'" class="feature-note">目前沿用原有账号授权。选择使用范围并保存后，以这里的功能权限为准。</p>
      <div v-if="access === 'selected'" class="feature-users"><label v-for="user in users" :key="user.id"><input type="checkbox" v-model="userIds" :value="Number(user.id)" :disabled="busy" /><span>{{ user.display_name || user.displayName || user.username }}</span><small>@{{ user.username }}{{ user.role === 'admin' ? ' · 管理员' : '' }}{{ user.enabled === false ? ' · 已停用' : '' }}</small></label><p v-if="!users.length">暂无用户。</p></div>
      <footer><p>关闭权限会阻止新的即梦操作；已有任务与作品保留。获准用户可自行选择可用账号和空闲画布。</p><button type="button" class="btn btn-primary" :disabled="busy || access === 'legacy'" @click="save"><Loader2 v-if="saving" :size="13" class="animate-spin" />{{ saving ? '正在保存…' : '保存使用权限' }}</button></footer>
    </template>
  </section>
</template>
<script setup>
import {computed,ref,watch,onBeforeUnmount} from 'vue'
import {RefreshCw,Loader2} from 'lucide-vue-next'
import {api} from '~/composables/useApi'
import {platformSession} from '~/utils/platform-session'
const props=defineProps({configId:{type:[Number,String],required:true},refreshToken:{type:Number,default:0}})
const access=ref('legacy'),userIds=ref([]),users=ref([]),loading=ref(false),saving=ref(false),loaded=ref(false),error=ref(''),notice=ref('')
const busy=computed(()=>loading.value||saving.value)
let alive=true,revision=0
const identity=()=>`${props.configId}|${platformSession.revision}`
const valid=(key,turn)=>alive&&key===identity()&&turn===revision
async function load(){
  const turn=++revision,key=identity();loading.value=true;error.value='';notice.value=''
  if(!Number.isSafeInteger(Number(props.configId))||Number(props.configId)<1){loading.value=false;loaded.value=false;return}
  try{const value=await api.get(`/admin/execution/services/${Number(props.configId)}/user-access`);if(!valid(key,turn))return;access.value=['all','selected','legacy'].includes(value.access)?value.access:'legacy';userIds.value=Array.isArray(value.user_ids)?[...value.user_ids]:[];users.value=Array.isArray(value.users)?value.users:[];loaded.value=true}catch(e){if(valid(key,turn)){loaded.value=false;error.value=e.message||'读取即梦使用权限失败。'}}finally{if(valid(key,turn))loading.value=false}
}
async function save(){
  if(busy.value||!loaded.value||!['all','selected'].includes(access.value))return
  const turn=revision,key=identity(),body={access:access.value,user_ids:access.value==='selected'?[...new Set(userIds.value.map(Number))]:[]};saving.value=true;error.value='';notice.value=''
  try{await api.put(`/admin/execution/services/${Number(props.configId)}/user-access`,body);if(valid(key,turn))notice.value='即梦使用权限已保存。'}catch(e){if(valid(key,turn))error.value=e.message||'使用权限未保存，请重试。'}finally{if(valid(key,turn))saving.value=false}
}
watch(()=>[props.configId,props.refreshToken,platformSession.revision],()=>{revision++;loaded.value=false;saving.value=false;users.value=[];userIds.value=[];access.value='legacy';void load()},{immediate:true})
onBeforeUnmount(()=>{alive=false;revision++})
</script>
<style scoped>
.feature-access{padding:24px;margin-bottom:20px}.feature-access header{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:20px}.feature-access h2{font-size:17px;margin:0 0 7px}.feature-access p{font-size:11px;line-height:1.8;color:var(--text-3);margin:0}.scope-field{display:grid;gap:8px;max-width:400px;font-size:12px;color:var(--text-2)}.scope-field select{height:39px;font-size:12px}.feature-users{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;padding:15px;border:1px solid var(--border);border-radius:10px;margin-top:15px;max-height:230px;overflow:auto}.feature-users label{display:flex;align-items:center;gap:7px;font-size:12px;min-width:0}.feature-users input{accent-color:var(--accent)}.feature-users small{color:var(--text-3);font-size:10px;overflow-wrap:anywhere}.feature-access footer{display:flex;justify-content:space-between;align-items:center;gap:18px;border-top:1px solid var(--border);padding-top:17px;margin-top:20px}.feature-access footer p{max-width:70%}.feature-note{padding:10px 13px;border-radius:9px;background:var(--bg-0);margin:12px 0!important}.feature-note.problem{background:var(--error-bg);color:var(--error)}.feature-note.success{background:var(--success-bg);color:var(--success)}.feature-loading{display:flex;align-items:center;gap:8px;color:var(--text-3);font-size:12px}@media(max-width:700px){.feature-access{padding:18px}.feature-access footer{align-items:flex-start;flex-direction:column}.feature-access footer p{max-width:none}.feature-users{grid-template-columns:1fr}}
</style>
