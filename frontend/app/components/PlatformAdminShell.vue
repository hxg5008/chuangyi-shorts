<template>
  <div class="admin-shell"><aside class="admin-sidebar"><div class="admin-sidebar-heading"><ShieldCheck :size="18" /><div><strong>管理后台</strong><span>工作空间与模型服务</span></div></div><nav aria-label="管理后台功能"><section v-for="group in groups" :key="group.title" class="admin-nav-group"><span class="admin-nav-label">{{ group.title }}</span><NuxtLink v-for="item in group.items" :key="item.to" :to="item.to" :class="{on: route.path === item.to}"><component :is="item.icon" :size="16" />{{ item.label }}<ChevronRight :size="13" /></NuxtLink></section></nav><div class="admin-sidebar-note"><LockKeyhole :size="15" /><p>模型密钥由服务器保管。创作者仅使用已授权模型。</p></div></aside><main class="admin-main"><header class="admin-page-heading"><div><p>ADMINISTRATION</p><h1>{{ title }}</h1><span>{{ description }}</span></div><div class="admin-heading-actions"><slot name="actions" /></div></header><slot /></main></div>
</template>
<script setup>
import { ShieldCheck, LockKeyhole, ChevronRight, Network, Users, Activity, SlidersHorizontal, FlaskConical, Palette, Bot, HardDrive } from 'lucide-vue-next'
defineProps({ title: String, description: String })
const route = useRoute()
const groups = [
  { title: '模型与服务', items: [
    { to: '/admin/channels', label: '模型渠道', icon: Network },
    { to: '/admin/playground', label: '模型试用', icon: FlaskConical },
    { to: '/admin/execution', label: '一体平台', icon: Network },
  ] },
  { title: '创作配置', items: [
    { to: '/admin/styles', label: '风格库', icon: Palette },
    { to: '/admin/workflow', label: 'Agent 与 Skill', icon: Bot },
    { to: '/admin/preferences', label: '创作默认设置', icon: SlidersHorizontal },
  ] },
  { title: '用户与运行', items: [
    { to: '/admin/users', label: '用户与权限', icon: Users },
    { to: '/admin/requests', label: '请求日志', icon: Activity },
    { to: '/admin/storage', label: '存储管理', icon: HardDrive },
  ] },
]
</script>
<style scoped>
.admin-shell{display:grid;grid-template-columns:205px minmax(0,1fr);height:100%;min-height:0}.admin-sidebar{padding:27px 14px;border-right:1px solid var(--border);background:var(--bg-1);display:flex;flex-direction:column;gap:25px}.admin-sidebar-heading{display:flex;align-items:center;gap:10px;padding:0 11px;color:var(--accent-text)}.admin-sidebar-heading div{display:grid;gap:5px}.admin-sidebar-heading strong{font-size:13px;color:var(--text-0)}.admin-sidebar-heading span{font-size:10px;color:var(--text-3)}nav{display:grid;gap:6px}nav a{display:flex;align-items:center;gap:10px;color:var(--text-2);font-size:12px;text-decoration:none;padding:12px;border-radius:11px}nav a>svg:last-child{margin-left:auto;opacity:0}nav a:hover{background:var(--bg-hover);color:var(--text-0)}nav a.on{background:var(--accent-bg);color:var(--accent-text);font-weight:650}nav a.on>svg:last-child{opacity:1}.admin-sidebar-note{margin-top:auto;border-top:1px solid var(--border);padding:20px 10px 0;display:flex;gap:8px;color:var(--text-3)}.admin-sidebar-note svg{flex-shrink:0}.admin-sidebar-note p{font-size:10px;line-height:1.8}.admin-main{padding:30px 32px 40px;overflow:auto;min-width:0}.admin-page-heading{display:flex;align-items:flex-end;gap:20px;justify-content:space-between;margin-bottom:26px}.admin-page-heading>div>p{font-size:9px;letter-spacing:.16em;color:var(--accent-text);font-weight:700;margin-bottom:9px}.admin-page-heading h1{font-size:26px;letter-spacing:-.025em;margin-bottom:9px}.admin-page-heading span{font-size:12px;color:var(--text-3);line-height:1.7}.admin-heading-actions{display:flex;gap:8px;flex-wrap:wrap}@media(max-width:1050px){.admin-main{padding:25px 20px}.admin-shell{grid-template-columns:180px minmax(0,1fr)}}@media(max-width:750px){.admin-shell{display:block;overflow:auto}.admin-sidebar{border-right:0;border-bottom:1px solid var(--border);padding:14px;gap:12px}.admin-sidebar-heading,.admin-sidebar-note{display:none}nav{display:flex;overflow:auto}nav a{white-space:nowrap;padding:9px}nav a>svg:last-child{display:none}.admin-main{overflow:visible;padding:23px 16px}.admin-page-heading{align-items:flex-start;flex-direction:column;gap:14px}}
.admin-nav-group{display:grid;gap:4px}.admin-nav-label{font-size:10px;color:var(--text-3);padding:7px 12px 3px;letter-spacing:.06em}.admin-shell nav{gap:13px}.admin-sidebar{overflow-y:auto}.admin-sidebar-note{padding-top:14px}@media(max-width:750px){.admin-nav-group{display:flex;flex-shrink:0}.admin-nav-label{display:none}.admin-shell nav{gap:5px}}
</style>
