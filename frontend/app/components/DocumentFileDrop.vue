<template>
  <Teleport to="body"><div v-if="active && enabled" class="document-drop-shade" aria-live="polite"><div class="document-drop-target"><Upload :size="34" /><strong>{{ title }}</strong><span>TXT / Markdown · 单个文件不超过 6 MB</span><small>先预览并确认，不会自动导入或生成。</small></div></div></Teleport>
</template>
<script setup>
import {ref,onMounted,onBeforeUnmount,watch} from 'vue'
import {Upload} from 'lucide-vue-next'
import {isFileDrag,droppedDocument} from '~/utils/document-file.js'
const props=defineProps({enabled:{type:Boolean,default:true},ignoreDialogs:{type:Boolean,default:true},title:{type:String,default:'松开文件，导入小说／剧本'}})
const emit=defineEmits(['file','error']),active=ref(false)
let depth=0
const available=()=>props.enabled&&(!props.ignoreDialogs||!document.querySelector('[aria-modal="true"],.overlay'))
function reset(){depth=0;active.value=false}
function enter(event){if(!isFileDrag(event)||!available())return;event.preventDefault();depth++;active.value=true}
function over(event){if(!isFileDrag(event))return;event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect=available()?'copy':'none';if(available())active.value=true}
function leave(){depth=Math.max(0,depth-1);if(!depth)active.value=false}
function drop(event){if(!isFileDrag(event))return;event.preventDefault();const accept=available();reset();if(!accept)return;try{emit('file',droppedDocument(event))}catch(error){emit('error',error.message)}}
const listeners={dragenter:enter,dragover:over,dragleave:leave,drop,dragend:reset,blur:reset}
onMounted(()=>{for(const [event,fn]of Object.entries(listeners))window.addEventListener(event,fn)})
onBeforeUnmount(()=>{for(const [event,fn]of Object.entries(listeners))window.removeEventListener(event,fn);reset()})
watch(()=>props.enabled,reset)
</script>
<style scoped>
.document-drop-shade{position:fixed;inset:12px;z-index:900;pointer-events:none;background:rgba(245,247,250,.9);backdrop-filter:blur(5px);border:2px dashed var(--accent,#ff7a20);border-radius:18px;display:grid;place-items:center}.document-drop-target{display:grid;justify-items:center;gap:15px;text-align:center;color:var(--text-1,#252932);padding:25px}.document-drop-target svg{color:var(--accent,#ff7a20)}.document-drop-target strong{font-size:22px}.document-drop-target span{font-size:13px;color:var(--text-2,#687283)}.document-drop-target small{font-size:12px;color:var(--text-3,#8791a0)}
</style>
