<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
  <div ref="toastHost" class="toast-interactions" @click="dismissToastInteraction" @keydown="dismissToastInteraction">
    <Toaster position="top-right" :offset="24" :style="{top:toastTop+'px'}" :duration="3000" :theme="resolvedTheme" close-button :toast-options="{class:'app-clickable-toast'}" />
  </div>
  <MigrateOverlay />
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { Toaster, toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import MigrateOverlay from '~/components/MigrateOverlay.vue'
import { useDesktopBridge } from '~/composables/useDesktopBridge'
import { useMigrateState } from '~/composables/useMigrateState'
import { useTheme } from '~/composables/useTheme'
import { dismissToastInteraction } from '~/utils/toast-dismiss.js'
import { notificationTop } from '~/utils/toast-placement.js'

const { t } = useI18n()
const { resolvedTheme } = useTheme()
const toastHost=ref<HTMLElement|null>(null),toastTop=ref(72)
let toastObserver:MutationObserver|undefined,positionFrame=0
function placeToasts(){if(positionFrame)return;positionFrame=requestAnimationFrame(()=>{positionFrame=0;toastTop.value=notificationTop(document,window.innerHeight)})}
onMounted(()=>{placeToasts();toastObserver=new MutationObserver(placeToasts);if(toastHost.value)toastObserver.observe(toastHost.value,{childList:true,subtree:true});window.addEventListener('resize',placeToasts);window.addEventListener('scroll',placeToasts,true)})
onBeforeUnmount(()=>{toastObserver?.disconnect();cancelAnimationFrame(positionFrame);window.removeEventListener('resize',placeToasts);window.removeEventListener('scroll',placeToasts,true)})

// 响应式文档标题（nuxt.config.ts 的静态 title 仅作 SSR/兜底）
useHead(() => ({ title: t('app.title') }))

const bridge = useDesktopBridge()
const { state, begin, update, end } = useMigrateState()

onMounted(() => {
  if (!bridge) return
  bridge.onMigrateProgress((p) => {
    if (p.phase === 'done') {
      update(p)
      // 稍等遮罩展示「完成」，再刷新页面让所有数据源指向新目录
      setTimeout(() => { end(); location.reload() }, 800)
      return
    }
    if (p.phase === 'error') {
      end()
      return // 错误 toast 由触发方（设置页）提示
    }
    if (!state.active) begin()
    update(p)
  })

  // 启动静默检查更新（主进程 20s 后自检一次，这里稍后取结果提示一次）
  setTimeout(async () => {
    try {
      const s = await bridge.getUpdateState()
      if (s?.status === 'available') {
        toast.info(t('app.updateAvailable', { version: s.latestVersion }), { duration: 8000 })
      }
    } catch { /* 静默 */ }
  }, 25_000)
})
</script>

<style>
@import url('./assets/studio.css');
.toast-interactions{display:contents}
.app-clickable-toast[data-dismissible="true"]{cursor:pointer}

/* === 应用内引导（driver.js）主题覆写 — 跟随设计 token === */
.huobao-tour-popover {
  background: var(--surface-raised) !important;
  color: var(--text-1) !important;
  border: 1px solid var(--border) !important;
  border-radius: var(--radius-lg) !important;
  box-shadow: var(--shadow-elevated) !important;
  max-width: 340px;
}
.huobao-tour-popover .driver-popover-title {
  color: var(--text-0) !important;
  font: 700 14px/1.3 var(--font-body) !important;
  letter-spacing: -0.01em;
}
.huobao-tour-popover .driver-popover-description {
  color: var(--text-2) !important;
  font: 400 12.5px/1.65 var(--font-body) !important;
}
.huobao-tour-popover .driver-popover-progress-text {
  color: var(--text-3) !important;
  font-size: 10.5px !important;
}
.huobao-tour-popover .driver-popover-close-btn {
  color: var(--text-3) !important;
}
.huobao-tour-popover .driver-popover-navigation-btns {
  gap: 6px;
}
.huobao-tour-popover .driver-popover-navigation-btns button {
  background: var(--button-bg) !important;
  color: var(--button-text) !important;
  border: none !important;
  border-radius: var(--radius-pill) !important;
  padding: 5px 14px !important;
  font: 600 12px var(--font-body) !important;
  text-shadow: none !important;
  cursor: pointer;
}
.huobao-tour-popover .driver-popover-navigation-btns button.driver-popover-next-btn,
.huobao-tour-popover .driver-popover-navigation-btns button.driver-popover-done-btn {
  background: var(--accent-gradient) !important;
  color: var(--on-accent) !important;
}
.driver-overlay {
  background: var(--scrim) !important;
  backdrop-filter: blur(2px);
}
/* 高亮框描边用品牌橙 */
.driver-active-element .driver-popover-arrow svg path,
.driver-active-element .driver-popover-arrow svg polygon {
  fill: var(--accent) !important;
}
</style>
