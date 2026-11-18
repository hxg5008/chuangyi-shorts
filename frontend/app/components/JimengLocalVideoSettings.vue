<template>
  <section class="jimeng-settings">
    <div class="jimeng-settings-head"><strong>即梦本地执行</strong><span>独立服务 · 异步出片</span></div>
    <div class="jimeng-settings-fields">
      <label>
        <span>执行时长（跟随分镜）</span>
        <select class="input" :value="modelValue.duration" @change="emit('update:duration', Number($event.target.value))">
          <option v-for="n in durationOptions" :key="n" :value="n">{{ n }} 秒</option>
        </select>
      </label>
      <label>
        <span>执行画幅（跟随项目）</span>
        <input class="input" :value="modelValue.aspectRatio" readonly :title="aspectLocked ? '新建项目时选择的画幅' : '项目画幅为自适应，按 16:9 提交'" />
      </label>
    </div>
    <p>时长取自这个分镜，修改即保存到分镜；画幅取自新建项目时的设置，每次生成自动带上，不用手动改。</p>
    <p>当前 {{ imageCount }} 张参考图 · 最多 9 张。沿用本平台提示词与项目风格，服务端负责原生 @ 引用。参数作为画布 Agent 的执行要求，实际结果以即梦返回为准。</p>
    <p>分辨率由即梦画布决定；未返回百分比时只显示状态。出片后自动取回到这个分镜（取回不会重新生成）；没取回的可点「取回到分镜」。</p>
    <p v-if="error" class="jimeng-settings-error" role="alert">{{ error }}</p>
  </section>
</template>
<script setup>
import { computed } from 'vue'
const props = defineProps({
  modelValue: { type: Object, required: true },
  imageCount: { type: Number, default: 0 },
  error: { type: String, default: '' },
  aspectLocked: { type: Boolean, default: true },
})
const emit = defineEmits(['update:duration'])
// 1–15 秒；分镜时长超出 15 秒时也显示出来，由下方校验提示，而不是悄悄截短
const durationOptions = computed(() => {
  const list = Array.from({ length: 15 }, (_, i) => i + 1)
  const current = Number(props.modelValue.duration)
  return Number.isInteger(current) && current > 15 ? [...list, current] : list
})
</script>
<style scoped>
.jimeng-settings{padding:14px;border:1px solid var(--border);border-radius:12px;background:var(--bg-2);margin-bottom:14px}.jimeng-settings-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px}.jimeng-settings-head span{font-size:10px;color:var(--text-3)}.jimeng-settings-fields{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0}.jimeng-settings-fields label{display:grid;gap:6px;font-size:11px;color:var(--text-2)}.jimeng-settings p{font-size:11px;line-height:1.65;color:var(--text-3);margin:6px 0 0}.jimeng-settings .jimeng-settings-error{color:var(--error,#d4493a)}
</style>
