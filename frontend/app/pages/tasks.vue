<template><div class="tasks-page"><TaskCenter :drama-id="projectId" :initial-task-id="taskId" :initial-round-id="roundId" :initial-tab="initialTab" /></div></template>
<script setup>
import { computed } from 'vue'
import TaskCenter from '~/components/TaskCenter.vue'
const route=useRoute()
const projectId=computed(()=>/^\d+$/u.test(String(route.query.drama_id||''))?Number(route.query.drama_id):null)
const taskId=computed(()=>/^[A-Za-z0-9_-]{1,200}$/u.test(String(route.query.task_id||''))?String(route.query.task_id):'')
const roundId=computed(()=>/^[A-Za-z0-9_-]{1,200}$/u.test(String(route.query.round_id||''))?String(route.query.round_id):'')
const initialTab=computed(()=>['output','request','process','result'].includes(route.query.tab)?String(route.query.tab):'output')
</script>
<style scoped>.tasks-page{height:100%;min-height:0;padding:20px 24px}.tasks-page>.task-center{border:1px solid var(--border);border-radius:17px;box-shadow:var(--shadow-xs)}@media(max-width:750px){.tasks-page{padding:9px}.tasks-page>.task-center{border-radius:12px}}</style>
