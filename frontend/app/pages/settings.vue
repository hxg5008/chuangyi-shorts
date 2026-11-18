<template><div aria-busy="true" /></template>
<script setup>
import { legacySettingsDestination } from '~/utils/admin-settings.js'
const route = useRoute()
await navigateTo(legacySettingsDestination(route.query, route.hash), { replace: true })
</script>
