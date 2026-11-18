<template>
  <div class="account-menu">
    <NuxtLink to="/account" class="account-identity" title="我的账户 / 修改密码" aria-label="我的账户与修改密码">
      <span class="account-role-badge">{{ roleLabel }}</span>
      <span class="account-entry-label">我的账户</span>
    </NuxtLink>
    <button type="button" class="account-exit" :disabled="busy" @click="signOut" title="退出登录" aria-label="退出登录"><LogOut :size="14" /></button>
  </div>
</template>
<script setup>
import { computed, ref } from 'vue'
import { LogOut } from 'lucide-vue-next'
import { platformSession, logoutPlatform } from '~/utils/platform-session'
import { toastError } from '~/composables/useToast'
const user = computed(() => platformSession.user)
const roleLabel = computed(() => user.value?.role === 'admin' ? '管理员' : '用户')
const busy = ref(false)
async function signOut() { busy.value = true; try { await logoutPlatform(); await navigateTo('/login', { replace: true }) } catch (error) { toastError(error) } finally { busy.value = false } }
</script>
<style scoped>
.account-menu{display:flex;align-items:center;gap:3px;margin-left:8px;padding-left:10px;border-left:1px solid var(--border);flex-shrink:0}.account-identity{display:flex;align-items:center;gap:7px;color:var(--text-1);text-decoration:none;font-size:12px;padding:3px 5px;border-radius:20px;white-space:nowrap}.account-identity:hover{background:var(--bg-hover)}.account-role-badge{display:inline-flex;align-items:center;justify-content:center;min-height:25px;padding:0 8px;background:var(--accent-bg);color:var(--accent-text);font-size:11px;font-weight:700;border-radius:9px;white-space:nowrap}.account-entry-label{font-size:11px;font-weight:600;color:var(--text-2);white-space:nowrap}.account-exit{display:grid;place-items:center;width:26px;height:28px;border:0;border-radius:8px;color:var(--text-3);background:transparent;cursor:pointer}.account-exit:hover{color:var(--error);background:var(--error-bg)}.account-identity:focus-visible,.account-exit:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
