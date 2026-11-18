<template>
  <Teleport to="body"><div class="production-batch-overlay" @click.self="!busy&&$emit('close')"><section class="batch-dialog" role="dialog" aria-modal="true" tabindex="-1" aria-label="批量处理剧集" @keydown.esc.stop="!busy&&$emit('close')">
    <header><div><span class="eyebrow">BATCH PRODUCTION</span><h2>批量处理剧集</h2><p>可一次完成提取资产 → 出资产图 → 拆分镜。已有剧本优先，否则使用原始内容；不会自动改写剧本。</p></div><button class="btn btn-icon" :disabled="busy" @click="$emit('close')" aria-label="关闭批量处理"><X :size="18" /></button></header>
    <div class="batch-dialog-body">
      <div class="batch-selection-head"><label><input type="checkbox" :checked="allSelected" @change="selectAll($event.target.checked)" />全选本项目可处理剧集</label><span>已选 {{ selected.length }} / {{ eligible.length }} 集</span></div>
      <div class="batch-episodes"><label v-for="episode in episodes" :key="episode.id" :class="{unavailable:!episodeHasExtractionInput(episode)}"><input type="checkbox" :checked="selected.includes(Number(episode.id))" :disabled="!episodeHasExtractionInput(episode)||busy" @change="toggleEpisode(episode.id,$event.target.checked)" /><span><strong>第 {{ episode.episode_number || episode.episodeNumber }} 集 · {{ episode.title }}</strong><small>{{ extractionSourceLabel(episode) }}</small></span></label></div>
      <div class="batch-options"><fieldset><legend>提取资产</legend><label v-for="target in targetOptions" :key="target.key"><input v-model="targets" type="checkbox" :value="target.key" :disabled="busy" />{{ target.label }}</label></fieldset><label class="concurrency-field">同时提取集数<select v-model.number="concurrency" :disabled="busy" aria-label="批次并发"><option :value="1">1 集</option><option :value="2">2 集</option><option :value="4">4 集</option></select></label></div>
      <div class="batch-options"><fieldset><legend>后续步骤</legend><label><input v-model="targets" type="checkbox" value="images" :disabled="busy" />出资产图</label><label><input v-model="targets" type="checkbox" value="storyboard" :disabled="busy" />拆分镜</label></fieldset>
        <label v-if="targets.includes('images')" class="concurrency-field">同时出图张数<select v-model.number="imageConcurrency" :disabled="busy" aria-label="同时出图张数"><option :value="1">1 张</option><option :value="2">2 张</option><option :value="3">3 张</option><option :value="4">4 张</option></select></label>
        <label v-if="targets.includes('storyboard')" class="concurrency-field">同时拆分镜集数<select v-model.number="storyboardConcurrency" :disabled="busy" aria-label="同时拆分镜集数"><option :value="1">1 集</option><option :value="2">2 集</option></select></label></div>
      <div class="batch-model"><ModelSelect v-if="modelOptions.length" v-model="modelKey" label="文字模型（提取与拆分镜）" :options="modelOptions" :default-label="selection.model||'选择模型'" show-config /><p v-else class="batch-message">{{ loadingModels?'正在读取可用文字模型…':'暂无可用文字模型，请联系管理员配置。' }}</p><details v-if="selection.config"><summary>本批次模型参数</summary><ModelParameterFields :config="selection.config" v-model="parameters" /></details>
        <template v-if="targets.includes('images')"><ModelSelect v-if="imageModelOptions.length" v-model="imageModelKey" label="图片模型" :options="imageModelOptions" :default-label="imageSelection.model||'各集原定图片模型'" show-config /><p v-else class="batch-message">{{ loadingModels?'正在读取可用图片模型…':'暂无可用图片模型；出图将使用各集原定的图片模型。' }}</p></template></div>
      <p class="batch-summary">本次选择 {{ selected.length }} 集，共 {{ selected.length*targets.length }} 个步骤，每集按 {{ orderLabel }} 的顺序处理。{{ targets.some(isExtraction)?'相同输入且有成功保存回执的提取步骤可复用。':'' }}</p>
      <p class="batch-note">{{ noteText }}</p><p v-if="error" class="batch-error" role="alert">{{ error }}</p>
    </div><footer><span>{{ busy?'正在创建批次…':orderLabel }}</span><div><button class="btn" :disabled="busy" @click="$emit('close')">取消</button><button class="btn btn-primary" :disabled="busy||!selected.length||!targets.length||!selection.configId" @click="submit"><Loader2 v-if="busy" :size="14" class="animate-spin" />确认开始</button></div></footer>
  </section></div></Teleport>
</template>
<script setup>
import {computed,onMounted,ref,watch} from 'vue'
import {X,Loader2} from 'lucide-vue-next'
import {aiConfigAPI,productionAPI} from '~/composables/useApi'
import ModelSelect from './ModelSelect.vue'
import ModelParameterFields from './ModelParameterFields.vue'
import {resolveConfiguredSelection,initialModelParameters} from '~/utils/model-parameters.js'
import {episodeHasExtractionInput,extractionSourceLabel} from '~/utils/production-presentation.js'
const props=defineProps({dramaId:{type:[Number,String],required:true},episodes:{type:Array,default:()=>[]},initialSelection:{type:Array,default:()=>[]}}),emit=defineEmits(['close','created'])
const targetOptions=[{key:'characters',label:'角色'},{key:'scenes',label:'场景'},{key:'props',label:'道具'}]
const stepOrder=[...targetOptions,{key:'images',label:'出图'},{key:'storyboard',label:'拆分镜'}]
const isExtraction=key=>targetOptions.some(target=>target.key===key)
const eligible=computed(()=>props.episodes.filter(episodeHasExtractionInput)),selected=ref(props.initialSelection.map(Number).filter(id=>eligible.value.some(episode=>Number(episode.id)===id)))
const allSelected=computed(()=>eligible.value.length>0&&eligible.value.every(episode=>selected.value.includes(Number(episode.id))))
const targets=ref(['characters','scenes','props']),concurrency=ref(1),imageConcurrency=ref(3),storyboardConcurrency=ref(1),models=ref([]),imageModels=ref([]),modelKey=ref(''),imageModelKey=ref(''),parameters=ref({}),loadingModels=ref(true),busy=ref(false),error=ref('')
const options=list=>list.filter(config=>config.is_active).flatMap(config=>(Array.isArray(config.model)?config.model:[config.model]).filter(Boolean).map(model=>({key:config.id+'/'+model,model,displayName:config.display_name||model,configName:config.channel_name||config.name,configId:config.id,provider:config.provider})))
const modelOptions=computed(()=>options(models.value)),imageModelOptions=computed(()=>options(imageModels.value))
const selection=computed(()=>resolveConfiguredSelection(models.value,modelKey.value))
/** No explicit choice keeps each episode's own locked image model (same as the episode page). */
const imageSelection=computed(()=>imageModelKey.value?resolveConfiguredSelection(imageModels.value,imageModelKey.value):{config:null,model:'',configId:null})
const orderLabel=computed(()=>stepOrder.filter(step=>targets.value.includes(step.key)).map(step=>step.label).join(' → ')||'请选择步骤')
const noteText=computed(()=>{
  const parts=[]
  if(targets.value.some(isExtraction))parts.push('提取会调用所选文字模型')
  if(targets.value.includes('images'))parts.push(`只给还没有图片的角色、场景、道具出图，已有的不重出；同时最多 ${imageConcurrency.value} 张，中转站临时报错会自动等一会儿再试`)
  if(targets.value.includes('storyboard'))parts.push('拆分镜用的是剧集页同一套流程，没跑完会自动续跑；已有分镜的剧集不会重拆')
  return (parts.length?parts.join('；')+'。':'')+'不生成视频；切换页面后任务继续。'
})
watch(()=>selection.value.configId,()=>{parameters.value=initialModelParameters(selection.value.config)})
function selectAll(checked){if(busy.value)return;selected.value=checked?eligible.value.map(episode=>Number(episode.id)):[]}
function toggleEpisode(id,checked){if(busy.value)return;id=Number(id);selected.value=checked?[...new Set([...selected.value,id])]:selected.value.filter(value=>value!==id)}
async function loadModels(){loadingModels.value=true;try{const [text,image]=await Promise.all([aiConfigAPI.list('text'),aiConfigAPI.list('image').catch(()=>[])]);models.value=text||[];imageModels.value=image||[]}catch(failure){error.value=failure.message}finally{loadingModels.value=false}}
async function submit(){if(busy.value)return;error.value='';if(!selected.value.length||!targets.value.length||!selection.value.configId){error.value='请选择剧集、步骤和文字模型。';return}
  const chosen=stepOrder.filter(step=>targets.value.includes(step.key)).map(step=>step.key)
  const snapshot={drama_id:Number(props.dramaId),episode_ids:[...selected.value],targets:chosen,concurrency:concurrency.value,config_id:selection.value.configId,model:selection.value.model,model_parameters:JSON.parse(JSON.stringify(parameters.value)),skip_completed:true,
    ...(chosen.includes('images')?{image_concurrency:imageConcurrency.value,...(imageSelection.value.configId?{image_config_id:imageSelection.value.configId,image_model:imageSelection.value.model}:{})}:{}),
    ...(chosen.includes('storyboard')?{storyboard_concurrency:storyboardConcurrency.value}:{})}
  busy.value=true;try{const batch=await productionAPI.createBatch(snapshot);emit('created',batch)}catch(failure){error.value=failure.message||'创建失败，请查看错误后再决定是否重试。'}finally{busy.value=false}}
onMounted(loadModels)
</script>
<style scoped>
.production-batch-overlay{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;background:var(--scrim);backdrop-filter:blur(6px);padding:22px}.batch-dialog{width:680px;max-width:100%;max-height:calc(100dvh - 44px);display:flex;flex-direction:column;background:var(--bg-1);border:1px solid var(--border);border-radius:18px;box-shadow:var(--shadow-elevated);overflow:hidden}.batch-dialog header,.batch-dialog footer{display:flex;justify-content:space-between;gap:16px;padding:22px 25px;flex-shrink:0}.batch-dialog header{border-bottom:1px solid var(--border)}.eyebrow{font-size:9px;letter-spacing:.13em;color:var(--accent-text);font-weight:700}.batch-dialog h2{font-size:21px;margin-top:7px}.batch-dialog header p{font-size:11px;color:var(--text-3);line-height:1.8;margin-top:8px}.batch-dialog-body{padding:22px 25px;overflow:auto;overscroll-behavior:contain}.batch-selection-head{display:flex;justify-content:space-between;gap:12px;font-size:11px;margin-bottom:12px}.batch-selection-head>span{color:var(--text-3)}.batch-selection-head label,.batch-options label{display:flex;gap:7px;align-items:center}.batch-episodes{border:1px solid var(--border);border-radius:10px;max-height:220px;overflow:auto}.batch-episodes>label{display:flex;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid var(--border);cursor:pointer}.batch-episodes>label:last-child{border:0}.batch-episodes>label.unavailable{opacity:.5;cursor:default}.batch-episodes span{display:grid;gap:5px;min-width:0}.batch-episodes strong{font-size:11px;font-weight:600;overflow-wrap:anywhere}.batch-episodes small{font-size:10px;color:var(--text-3)}input[type=checkbox]{accent-color:var(--accent)}.batch-options{display:flex;justify-content:space-between;gap:20px;margin-top:22px}.batch-options fieldset{border:0;display:flex;align-items:center;gap:20px}.batch-options legend{font-size:11px;font-weight:600;margin-bottom:12px}.batch-options label{font-size:11px}.concurrency-field{flex-direction:column;align-items:flex-start!important;gap:9px!important}.concurrency-field select{background:var(--bg-1);color:var(--text-1);border:1px solid var(--border);padding:7px 20px 7px 10px;border-radius:7px;font-size:11px}.batch-model{margin-top:24px}.batch-model details{margin-top:17px}.batch-model summary{font-size:10px;color:var(--text-3);cursor:pointer;margin-bottom:15px}.batch-message,.batch-note,.batch-summary{font-size:11px;line-height:1.9;color:var(--text-3)}.batch-summary{padding:13px;border-radius:9px;background:var(--accent-bg);color:var(--text-2);margin-top:22px}.batch-note{margin-top:10px}.batch-error{font-size:11px;color:var(--error);margin-top:14px;white-space:pre-wrap}.batch-dialog footer{border-top:1px solid var(--border);align-items:center}.batch-dialog footer>span{font-size:10px;color:var(--text-3)}.batch-dialog footer>div{display:flex;gap:8px}@media(max-width:600px){.production-batch-overlay{padding:8px}.batch-dialog{max-height:calc(100dvh - 16px)}.batch-dialog header,.batch-dialog-body,.batch-dialog footer{padding:17px}.batch-options{flex-wrap:wrap}.batch-dialog footer{flex-wrap:wrap}.batch-selection-head{flex-wrap:wrap}}
</style>
