<template><ProductionDashboard :drama-id="projectId" :initial-batch-id="batchId" @project="chooseProject" /></template>
<script setup>
import {computed} from 'vue'
import ProductionDashboard from '~/components/ProductionDashboard.vue'
const route=useRoute()
const projectId=computed(()=>/^\d+$/u.test(String(route.query.drama_id||''))?Number(route.query.drama_id):null)
const batchId=computed(()=>String(route.query.batch_id||''))
function chooseProject(id){navigateTo(id?'/production?drama_id='+Number(id):'/production')}
</script>
