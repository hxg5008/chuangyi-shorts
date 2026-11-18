<template>
  <section class="character-episodes" aria-label="角色出现集数" @click.stop>
    <div class="episode-usage-heading">
      <div class="episode-usage-label"><Clapperboard :size="14" /><strong>出现集数</strong><span v-if="loaded && !error">共 {{ episodes.length }} 集</span></div>
      <button type="button" class="episode-usage-refresh" :disabled="loading || !requestKey" aria-label="刷新角色出现集数" @click="load"><RefreshCw :size="12" :class="{ spinning: loading }" />刷新</button>
    </div>
    <p class="episode-usage-hint">按项目已关联剧集统计，点击集数在新页打开。</p>
    <div v-if="loading" class="episode-usage-status" role="status"><Loader2 :size="14" class="spinning" />正在读取关联剧集…</div>
    <div v-else-if="error" class="episode-usage-error" role="alert"><span>{{ error }}</span><button type="button" @click="load">重试</button></div>
    <div v-else-if="!requestKey" class="episode-usage-empty">保存角色后可查看已关联的剧集。</div>
    <div v-else-if="loaded && !episodes.length" class="episode-usage-empty">尚未关联剧集。<small>后续提取或关联到剧集后会显示在这里。</small></div>
    <ul v-else class="episode-usage-list" aria-label="已关联剧集列表">
      <li v-for="episode in episodes" :key="episode.id"><a :href="episodeHref(episode)" target="_blank" rel="noopener noreferrer" :title="episodeTitle(episode)" :aria-label="episodeTitle(episode)">第 {{ episode.episode_number }} 集<ExternalLink :size="10" /></a></li>
    </ul>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Clapperboard, ExternalLink, Loader2, RefreshCw } from 'lucide-vue-next'
import { api } from '~/composables/useApi'

const props = defineProps({ characterId: { type: [Number, String], required: true }, dramaId: { type: [Number, String], required: true } })
const episodes = ref([]), loading = ref(false), loaded = ref(false), error = ref('')
const validId = value => /^[1-9]\d*$/u.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null
const requestKey = computed(() => { const character = validId(props.characterId), drama = validId(props.dramaId); return character && drama ? `${drama}:${character}` : '' })
const inFlight = new Map()
let alive = true, sequence = 0

function validatedEpisodes(value, characterId, dramaId) {
  if (value?.character_id !== characterId || value?.drama_id !== dramaId || !Array.isArray(value.episodes) || !Number.isSafeInteger(value.total) || value.total < 0) throw new Error('关联剧集记录不一致，请刷新后重试。')
  const rows = new Map()
  for (const episode of value.episodes) {
    if (!validId(episode?.id) || !validId(episode?.episode_number) || typeof episode.title !== 'string') throw new Error('关联剧集记录不完整，请刷新后重试。')
    const previous = rows.get(episode.id)
    if (previous && (previous.episode_number !== episode.episode_number || previous.title !== episode.title)) throw new Error('关联剧集记录存在冲突，请刷新后重试。')
    rows.set(episode.id, { id: Number(episode.id), episode_number: Number(episode.episode_number), title: episode.title })
  }
  if (rows.size !== value.total) throw new Error('关联剧集数量暂不一致，请刷新后重试。')
  return [...rows.values()].sort((a,b) => a.episode_number - b.episode_number || a.id - b.id)
}

async function load() {
  const key = requestKey.value, turn = ++sequence
  const characterId = validId(props.characterId), dramaId = validId(props.dramaId)
  episodes.value = []; loaded.value = false; error.value = ''
  if (!alive || !key) { loading.value = false; return }
  loading.value = true
  const current = () => alive && sequence === turn && requestKey.value === key
  let operation = inFlight.get(key)
  if (!operation) {
    operation = api.get(`/characters/${characterId}/episodes`).finally(() => { if (inFlight.get(key) === operation) inFlight.delete(key) })
    inFlight.set(key, operation)
  }
  try {
    const value = await operation
    if (!current()) return
    episodes.value = validatedEpisodes(value, characterId, dramaId)
    loaded.value = true
  } catch (cause) {
    if (current()) error.value = cause?.message || '关联剧集暂时读取失败，请重试。'
  } finally { if (current()) loading.value = false }
}
function episodeHref(episode) { return `/drama/${validId(props.dramaId)}/episode/${episode.episode_number}` }
function episodeTitle(episode) { return `第 ${episode.episode_number} 集${episode.title ? ' · ' + episode.title : ''}（新页打开）` }
watch(requestKey, load, { immediate: true, flush: 'sync' })
onBeforeUnmount(() => { alive = false; sequence++; inFlight.clear() })
</script>

<style scoped>
.character-episodes{min-width:0;display:flex;flex-direction:column;gap:10px;border:1px solid var(--border,#e5e9f1);border-radius:12px;background:var(--bg-card,#fff);padding:13px 14px;margin-top:14px;cursor:default}
.episode-usage-heading,.episode-usage-label{display:flex;align-items:center;gap:7px;min-width:0}.episode-usage-heading{justify-content:space-between}.episode-usage-label>svg{color:#8995a7;flex-shrink:0}.episode-usage-label strong{font-size:12px;color:var(--text-1,#344157);font-weight:600;white-space:nowrap}.episode-usage-label>span{font-size:10px;color:#a0a9b8;background:#f4f6fa;border-radius:5px;padding:3px 6px;white-space:nowrap}
.episode-usage-refresh{display:flex;align-items:center;gap:4px;flex-shrink:0;font-size:10px;color:#8c98aa;background:transparent;border:0;border-radius:5px;padding:4px;cursor:pointer}.episode-usage-refresh:hover:not(:disabled){color:#ee7c2b;background:#fff4eb}.episode-usage-refresh:disabled{opacity:.5;cursor:default}.episode-usage-refresh:focus-visible,.episode-usage-list a:focus-visible,.episode-usage-error button:focus-visible{outline:2px solid #ff9b56;outline-offset:2px}
.episode-usage-hint{margin:0;color:#9aa5b5;font-size:10px;line-height:1.65}.episode-usage-list{display:flex;flex-wrap:wrap;align-content:flex-start;gap:7px;max-height:180px;overflow:auto;margin:0;padding:1px 2px 2px;list-style:none}.episode-usage-list a{display:flex;align-items:center;gap:5px;border:1px solid #e8ecf3;border-radius:7px;padding:7px 9px;color:#63748d;background:#f8fafd;text-decoration:none;font-size:11px;line-height:1.2;white-space:nowrap;transition:color .15s,border-color .15s,background .15s}.episode-usage-list a>svg{color:#aab4c4}.episode-usage-list a:hover{color:#e9792a;border-color:#ffd6b8;background:#fff6ee}.episode-usage-list a:hover>svg{color:#ee9c60}
.episode-usage-status{display:flex;align-items:center;gap:7px;padding:7px 0;color:#929fb1;font-size:11px}.episode-usage-empty{padding:7px 0;color:#8c98aa;font-size:11px;line-height:1.7}.episode-usage-empty small{display:block;font-size:10px;color:#adb5c1;margin-top:2px}.episode-usage-error{display:flex;gap:8px;align-items:flex-start;color:#bc7f57;font-size:11px;line-height:1.65}.episode-usage-error span{flex:1;min-width:0;overflow-wrap:anywhere}.episode-usage-error button{background:none;border:0;padding:0;color:#df803f;font-size:11px;cursor:pointer;flex-shrink:0}
.spinning{animation:character-episodes-spin 1s linear infinite}@keyframes character-episodes-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinning{animation:none}}@media(max-width:650px){.character-episodes{padding:12px;margin-top:12px}.episode-usage-list{max-height:160px}.episode-usage-list a{padding:7px 8px}}
</style>
