<template>
  <section class="project-style-settings">
    <div class="project-style-summary"><Palette :size="16" /><span>视觉风格</span><strong>{{ drama.style_snapshot?.name || current?.name || drama.style || '未选择' }}</strong><small v-if="drama.style_snapshot">版本 {{ drama.style_snapshot.version.slice(0,8) }}</small><button type="button" class="btn btn-ghost btn-sm" @click="editing = !editing">{{ editing ? '收起' : '更换' }}</button></div>
    <div v-if="editing" class="project-style-editor"><StylePicker v-model="selection" :styles="styles" /><p>风格应用于资产图、分镜美术和视频；原文、资产提取规则和 Skill 不受影响。项目保留选定版本，已提交任务继续使用各自的版本。</p><div><button type="button" class="btn btn-primary btn-sm" :disabled="busy || !selection || selection === drama.style" @click="save">保存选择</button><button v-if="drama.style_snapshot && current?.version !== drama.style_snapshot.version" type="button" class="btn btn-sm" :disabled="busy" @click="refreshVersion">更新为风格库当前版本</button><span v-if="notice" role="status">{{ notice }}</span></div></div>
  </section>
</template>
<script setup>
import { computed, ref, onMounted, watch } from 'vue'
import { Palette } from 'lucide-vue-next'
import { dramaAPI, stylePresetAPI } from '~/composables/useApi'
import StylePicker from './StylePicker.vue'
const props = defineProps({ drama: { type: Object, required: true } })
const emit = defineEmits(['updated'])
const styles = ref([]), selection = ref(props.drama.style || ''), editing = ref(false), busy = ref(false), notice = ref('')
const current = computed(() => styles.value.find(item => item.value === props.drama.style))
watch(() => props.drama.style, value => { selection.value = value || '' })
onMounted(async () => { try { styles.value = await stylePresetAPI.list() || [] } catch { notice.value = '风格库暂时未加载，请刷新页面后重试。' } })
async function save() { if (busy.value) return; busy.value = true; notice.value = ''; try { await dramaAPI.update(props.drama.id, { style: selection.value }); emit('updated'); notice.value = '已保存，新任务采用此风格。' } catch (error) { notice.value = error?.message || '风格保存失败' } finally { busy.value = false } }
async function refreshVersion() { if (busy.value) return; busy.value = true; notice.value = ''; try { await stylePresetAPI.refreshProject(props.drama.id); emit('updated'); notice.value = '项目风格版本已更新，历史任务保持原样。' } catch (error) { notice.value = error?.message || '版本更新失败' } finally { busy.value = false } }
</script>
<style scoped>
.project-style-settings{margin:14px 0;border:1px solid #e5e9f1;background:#fff;border-radius:12px;padding:10px 14px}.project-style-summary{display:flex;align-items:center;gap:10px;font-size:12px;color:#8a95a7}.project-style-summary strong{color:#344157;font-weight:600}.project-style-summary small{font-size:10px;color:#a2aaba}.project-style-summary .btn{margin-left:auto}.project-style-editor{display:flex;flex-direction:column;gap:10px;padding-top:12px;border-top:1px solid #edf0f5;margin-top:8px}.project-style-editor p{font-size:11px;line-height:1.7;color:#939daf;margin:0}.project-style-editor>div{display:flex;align-items:center;gap:10px}.project-style-editor>div span{font-size:11px;color:#7d8c9c}@media(max-width:700px){.project-style-summary small{display:none}.project-style-editor>div{flex-wrap:wrap}}
</style>
