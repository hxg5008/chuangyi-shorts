<template><button type="button" :class="['btn','task-center-launcher',{active:active>0}]" @click="open=true"><Activity :size="13" /><span>AI 实况</span><b v-if="active">{{ active }}</b></button><Teleport to="body"><div v-if="open" class="activity-modal-overlay" @click.self="open=false"><div class="activity-modal" role="dialog" aria-modal="true" aria-label="AI 创作实况"><TaskCenter :drama-id="dramaId" embedded closable @close="open=false" @counts="setCounts" /></div></div></Teleport></template>
<script setup>
import { onBeforeUnmount,onMounted,ref } from 'vue'
import { Activity } from 'lucide-vue-next'
import { activityAPI } from '~/composables/useApi'
import { platformSession } from '~/utils/platform-session'
import TaskCenter from './TaskCenter.vue'
const props=defineProps({dramaId:{type:[Number,String],default:null}}),open=ref(false),active=ref(0)
let alive=true,timer=null
const userId=platformSession.user?.id
function setCounts(counts){active.value=Number(counts.active||0)+Number(counts.queued||0)}
async function refresh(){if(!alive||open.value||document.visibilityState==='hidden')return;try{const value=await activityAPI.list({drama_id:props.dramaId,limit:1});if(alive&&platformSession.user?.id===userId)setCounts(value.counts||{})}catch{}}
function escape(event){if(event.key==='Escape')open.value=false}
onMounted(()=>{refresh();timer=setInterval(refresh,8000);window.addEventListener('keydown',escape)})
onBeforeUnmount(()=>{alive=false;clearInterval(timer);window.removeEventListener('keydown',escape)})
</script>
<style scoped>
.task-center-launcher{gap:6px;position:relative}.task-center-launcher b{height:15px;min-width:15px;padding:0 4px;border-radius:5px;background:var(--accent);color:white;font-size:9px;display:grid;place-items:center}.task-center-launcher.active{background:var(--accent-bg);color:var(--accent-text)}.task-center-launcher.active>svg{animation:signalWave 1.6s ease-in-out infinite}.activity-modal-overlay{position:fixed;inset:0;z-index:1300;background:var(--scrim);backdrop-filter:blur(5px);display:flex;align-items:center;justify-content:center;padding:30px}.activity-modal{width:min(1380px,100%);height:min(880px,100%);background:var(--bg-1);border-radius:19px;border:1px solid var(--border);box-shadow:var(--shadow-elevated);overflow:hidden}@keyframes signalWave{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.55;transform:scale(1.12)}}@media(max-width:750px){.activity-modal-overlay{padding:7px}.activity-modal{height:100%;border-radius:13px}}@media(prefers-reduced-motion:reduce){.task-center-launcher.active>svg{animation:none}}
</style>
