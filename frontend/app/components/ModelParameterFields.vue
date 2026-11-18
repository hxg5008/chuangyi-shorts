<template>
  <div class="model-parameter-fields">
    <p v-if="!fields.length" class="model-parameter-empty">此协议没有声明额外可调参数，沿用服务和创作流程的默认设置。</p>
    <label v-for="field in fields" :key="field.key" class="parameter-field"><span>{{ field.label }}<b v-if="field.required">*</b><code>{{ field.key }}</code></span>
      <select v-if="options(field).length" class="input" :value="encoded(value(field))" :aria-label="field.label" @change="set(field,decode($event.target.value))"><option v-if="!field.required" value="">跟随默认</option><option v-for="option in options(field)" :key="encoded(option.value)" :value="encoded(option.value)">{{ option.label }}</option></select>
      <label v-else-if="isBoolean(field)" class="parameter-boolean"><input type="checkbox" :checked="value(field)===true" @change="set(field,$event.target.checked)" />{{ value(field)===''?'跟随默认':value(field)===true?'已开启':'已关闭' }}</label>
      <input v-else-if="isNumber(field)" class="input" type="number" :value="value(field)" :min="field.min" :max="field.max" :step="/int/iu.test(field.type||'')?1:field.step||'any'" :aria-label="field.label" @change="set(field,$event.target.value===''?undefined:Number($event.target.value))" :placeholder="field.default===undefined?'跟随默认':String(field.default)" />
      <textarea v-else-if="/json|object|array/iu.test(field.type||'') || (field.type||'').includes('[]')" class="input parameter-json" :value="typeof value(field)==='object'?JSON.stringify(value(field),null,2):value(field)" rows="4" :aria-label="field.label" @change="setJson(field,$event.target.value)"></textarea>
      <input v-else class="input" :value="value(field)" :aria-label="field.label" @change="set(field,$event.target.value)" :placeholder="field.default===undefined?'跟随默认':String(field.default)" />
      <small v-if="field.description">{{ field.description }}</small>
    </label><p v-if="error" class="parameter-error" role="alert">{{ error }}</p>
  </div>
</template>
<script setup>
import { computed,ref } from 'vue'
import { parameterDefinitions,parameterOptions } from '~/utils/model-parameters.js'
const props=defineProps({config:{type:Object,default:null},modelValue:{type:Object,default:()=>({})},omit:{type:Array,default:()=>[]}}),emit=defineEmits(['update:modelValue'])
const fields=computed(()=>parameterDefinitions(props.config,props.omit)),error=ref('')
const options=parameterOptions,isBoolean=field=>/bool|switch/iu.test(field.type||''),isNumber=field=>/number|integer|float|int|slider/iu.test(field.type||'')
const value=field=>props.modelValue[field.key]??field.default??''
const encoded=value=>value===undefined||value===''?'':JSON.stringify(value),decode=value=>{try{return JSON.parse(value)}catch{return value}}
function set(field,value){if(typeof value==='number'&&(!Number.isFinite(value)||field.min!=null&&value<field.min||field.max!=null&&value>field.max)){error.value=`${field.label} 超出允许范围。`;return}const output={...props.modelValue};if(value===undefined||value==='')delete output[field.key];else output[field.key]=value;error.value='';emit('update:modelValue',output)}
function setJson(field,text){try{set(field,text.trim()?JSON.parse(text):undefined)}catch{error.value=`${field.label} 不是有效 JSON。`}}
</script>
<style scoped>.model-parameter-fields{display:grid;gap:17px}.parameter-field{display:grid;gap:8px;font-size:12px;color:var(--text-1)}.parameter-field>span{display:flex;gap:5px;align-items:center;font-weight:600}.parameter-field code{margin-left:auto;font-size:9px;font-weight:400;color:var(--text-3)}.parameter-field b{color:var(--error)}.parameter-field small,.model-parameter-empty{font-size:10px;line-height:1.8;color:var(--text-3)}.parameter-field .input{width:100%;font-size:12px;min-height:36px}.parameter-boolean{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text-2)}.parameter-boolean input{accent-color:var(--accent)}.parameter-json{height:auto;resize:vertical;font-family:var(--font-mono)}.parameter-error{font-size:11px;color:var(--error);line-height:1.8}</style>
