<template>
  <fieldset class="capability-fields" v-if="type !== 'text'">
    <legend>已核实的模型能力</legend>
    <p>留空表示协议未声明；请按服务文档填写。</p>
    <div class="capability-numbers">
      <label>参考图片上限<input type="number" min="0" class="input" :value="valueOf('max_images')" @change="set('max_images', $event, 'number')" placeholder="未声明" /></label>
      <label v-if="type==='video'">参考视频上限<input type="number" min="0" class="input" :value="valueOf('max_videos')" @change="set('max_videos', $event, 'number')" placeholder="未声明" /></label>
      <label v-if="type==='video'">参考音频上限<input type="number" min="0" class="input" :value="valueOf('max_audios')" @change="set('max_audios', $event, 'number')" placeholder="未声明" /></label>
    </div>
    <label v-if="type==='video'">可选时长（秒）<input class="input" :value="valueOf('durations')" @change="set('durations', $event, 'numbers')" placeholder="例如 5, 10, 15；未声明则留空" /></label>
    <label v-if="type==='video'">分辨率<input class="input" :value="valueOf('resolutions')" @change="set('resolutions', $event, 'list')" placeholder="例如 720p, 1080p" /></label>
    <label>画面比例<input class="input" :value="valueOf('aspect_ratios')" @change="set('aspect_ratios', $event, 'list')" placeholder="例如 16:9, 9:16, 1:1" /></label>
    <span v-if="error" class="capability-error" role="alert">{{ error }}</span>
  </fieldset>
</template>
<script setup>
import { ref } from 'vue'
const props = defineProps({ modelValue: { type: String, default: '{}' }, type: { type: String, default: 'text' } })
const emit = defineEmits(['update:modelValue'])
const error = ref('')
function valueOf(key) { try { const value = JSON.parse(props.modelValue || '{}')[key]; return Array.isArray(value) ? value.join(', ') : value ?? '' } catch { return '' } }
function set(key, event, mode) {
  try {
    const object = JSON.parse(props.modelValue || '{}')
    if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error('请先将高级能力配置修正为 JSON 对象。')
    const raw = event.target.value.trim()
    if (!raw) delete object[key]
    else if (mode === 'number') {
      const number = Number(raw)
      if (!Number.isInteger(number) || number < 0) throw new Error('素材上限需填写非负整数。')
      object[key] = number
    } else {
      const list = raw.split(/[,，]/u).map(item => item.trim()).filter(Boolean)
      if (mode === 'numbers') {
        const numbers = list.map(Number)
        if (numbers.some(item => !Number.isFinite(item) || item <= 0)) throw new Error('时长请填写正数，以逗号分隔。')
        object[key] = [...new Set(numbers)]
      } else object[key] = [...new Set(list)]
    }
    emit('update:modelValue', JSON.stringify(object, null, 2))
    error.value = ''
  } catch (failure) { error.value = failure.message || '能力配置不是有效 JSON。' }
}
</script>
<style scoped>
.capability-fields{display:grid;gap:14px;padding:15px;border:1px solid var(--border);border-radius:10px}.capability-fields legend{padding:0 5px;font-size:11px;font-weight:600}.capability-fields>p{font-size:10px;color:var(--text-3);line-height:1.7}.capability-fields label{display:grid;gap:7px;font-size:10px;font-weight:500;color:var(--text-2)}.capability-fields .input{font-size:11px;height:34px;min-width:0}.capability-numbers{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.capability-numbers:has(>label:only-child){grid-template-columns:1fr}.capability-error{color:var(--error);font-size:10px;line-height:1.7}
</style>
