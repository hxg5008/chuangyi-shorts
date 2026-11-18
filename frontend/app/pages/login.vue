<template>
  <main class="login-page">
    <div class="login-decoration" aria-hidden="true"><span></span><span></span><span></span></div>
    <section class="login-card">
      <div class="login-brand"><img :src="brandLogo" alt="" /><span>创作工作台</span></div>
      <div class="login-intro"><p class="login-eyebrow">YOUR CREATIVE WORKSPACE</p><h1>登录，继续你的创作</h1><p>独立账号 · 私有项目 · 每一次生成都有记录</p></div>
      <form @submit.prevent="submit">
        <label>用户名<input v-model.trim="username" class="input" autocomplete="username" placeholder="输入你的用户名" required :disabled="busy" /></label>
        <label>密码<div class="password-field"><input v-model="password" class="input" :type="showPassword ? 'text' : 'password'" autocomplete="current-password" placeholder="输入密码" required :disabled="busy" /><button type="button" @click="showPassword = !showPassword" :aria-label="showPassword ? '隐藏密码' : '显示密码'"><EyeOff v-if="showPassword" :size="17" /><Eye v-else :size="17" /></button></div></label>
        <p v-if="status" class="login-status" role="status"><CircleCheck :size="15" />{{ status }}</p><p v-if="error" class="login-error" role="alert"><CircleAlert :size="15" />{{ error }}</p>
        <button class="btn btn-primary login-submit" :disabled="busy"><Loader2 v-if="busy" :size="16" class="animate-spin" />{{ busy ? '正在登录…' : '进入工作台' }}<ArrowRight v-if="!busy" :size="16" /></button>
      </form>
      <p class="auth-switch">还没有账号？<NuxtLink :to="{path:'/register',query:route.query.next?{next:safeNextPath(route.query.next)}:{}}">立即注册</NuxtLink></p>
      <button class="login-retry" type="button" @click="recheck" :disabled="busy">重新检查连接</button>
    </section>
    <p class="login-bottom">让灵感成为作品。</p>
  </main>
</template>
<script setup>
import { ref } from 'vue'
import { ArrowRight, Eye, EyeOff, Loader2, CircleAlert, CircleCheck } from 'lucide-vue-next'
import { loginPlatform, loadPlatformSession, safeNextPath } from '~/utils/platform-session'
import brandLogo from '~/assets/brand-logo.png'
definePageMeta({ layout: false })
const route = useRoute(), username = ref(''), password = ref(''), showPassword = ref(false), busy = ref(false)
const status = ref('')
const error = ref(route.query.connection ? '暂时连接不上服务，请确认后台已启动后重新检查。' : '')
async function submit() { if (busy.value) return; if (!username.value.trim() || password.value === '') { error.value = '请输入用户名和密码。'; return } busy.value = true; error.value = ''; status.value = ''; try { await loginPlatform(username.value, password.value); password.value = ''; await navigateTo(safeNextPath(route.query.next), { replace: true }) } catch (e) { error.value = e.message || '登录失败，请检查账号与密码。' } finally { busy.value = false } }
async function recheck() { busy.value = true; error.value = ''; status.value = ''; try { const user = await loadPlatformSession(true); if (user) await navigateTo(safeNextPath(route.query.next), { replace: true }); else status.value = '服务已连接，请使用你的账号登录。' } catch { error.value = '服务暂时无法连接，请检查后台或网络。' } finally { busy.value = false } }
</script>
<style scoped>
.login-page{height:100dvh;min-height:640px;overflow:auto;display:flex;align-items:center;justify-content:center;flex-direction:column;position:relative;background:var(--bg-base);padding:35px 20px}.login-decoration{position:absolute;inset:0;overflow:hidden;pointer-events:none}.login-decoration span{position:absolute;border-radius:50%;filter:blur(80px);opacity:.35;background:var(--accent-glow)}.login-decoration span:nth-child(1){width:460px;height:460px;left:10%;top:-240px}.login-decoration span:nth-child(2){width:400px;height:400px;right:4%;bottom:-240px}.login-decoration span:nth-child(3){width:140px;height:140px;left:22%;bottom:14%;opacity:.12}.login-card{position:relative;z-index:1;width:min(100%,440px);padding:38px;background:var(--bg-1);border:1px solid var(--border);border-radius:24px;box-shadow:0 16px 60px rgba(28,34,46,.055)}.login-brand{display:flex;align-items:center;gap:9px;font-size:13px;font-weight:650;color:var(--text-2)}.login-brand img{width:29px;height:29px;object-fit:contain}.login-intro{margin:34px 0 29px}.login-eyebrow{font-size:9px;font-weight:700;letter-spacing:.16em;color:var(--accent-text);margin-bottom:12px}.login-intro h1{font-size:25px;letter-spacing:-.035em;margin-bottom:10px;color:var(--text-0)}.login-intro>p:last-child{font-size:12px;color:var(--text-3);line-height:1.6}form{display:grid;gap:19px}label{display:grid;gap:9px;font-size:12px;font-weight:600;color:var(--text-1)}.input{height:43px;border-radius:11px;font-size:13px}.password-field{position:relative}.password-field input{padding-right:40px}.password-field button{position:absolute;right:8px;top:7px;height:29px;width:29px;display:grid;place-items:center;background:none;border:0;color:var(--text-3);cursor:pointer}.login-submit{width:100%;height:44px;margin-top:3px;justify-content:center;gap:9px;border-radius:12px}.login-status{font-size:12px;line-height:1.6;color:var(--success);display:flex;align-items:flex-start;gap:7px;background:var(--success-bg);border-radius:9px;padding:10px}.login-status svg{flex-shrink:0;margin-top:2px}.login-error{font-size:12px;line-height:1.6;color:var(--error);display:flex;gap:7px;align-items:flex-start;background:var(--error-bg);border-radius:9px;padding:10px}.login-error svg{flex-shrink:0;margin-top:2px}.login-footer{display:flex;gap:8px;border-top:1px solid var(--border);padding-top:21px;margin-top:27px;color:var(--text-3)}.login-footer svg{flex-shrink:0;margin-top:1px}.login-footer p{font-size:10px;line-height:1.8;overflow-wrap:anywhere}.login-footer strong{font-weight:500}.auth-switch{display:flex;justify-content:center;gap:7px;margin-top:21px;font-size:12px;color:var(--text-3)}.auth-switch a{color:var(--accent-text);font-weight:600;text-decoration:none}.auth-switch a:hover{text-decoration:underline}.login-retry{display:block;margin:18px auto 0;background:none;border:0;color:var(--text-3);font-size:11px;cursor:pointer}.login-retry:hover{color:var(--accent-text)}.login-bottom{margin-top:22px;font-size:11px;color:var(--text-3);letter-spacing:.12em}@media(max-width:480px){.login-card{padding:29px 24px}.login-intro h1{font-size:23px}}
</style>
